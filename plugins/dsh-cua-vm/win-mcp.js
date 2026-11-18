/**
 * cua-vm-windows-mcp — the dsh-cua MCP server of a Windows computer, over SSH.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Windows guest has no cua sandbox agent, so the only channel into it is SSH.
 * Inside the guest, `dsh-cua` (pywinauto) is the thing that can actually find
 * elements and verify that an action landed — a screenshot loop cannot: each
 * round trip is a PNG the model has to look at, while `find_elements` and
 * `type_text` return a few hundred bytes of structured JSON with a receipt.
 *
 * Layout (WHAT ACTUALLY RUNS TODAY):
 *
 *   harness (this process) ──ssh──▶ guest: cua@:22 (sshd, Session 0)
 *                                     ├─▶ RELAY lane (preferred)
 *                                     │     `py -3 C:\ProgramData\cua\mcp-relay.py --connect`
 *                                     │       └─ 127.0.0.1:<relayPort> ──▶ interactive session (dsh-cua)
 *                                     └─▶ direct lane (fallback)
 *                                           `python -m dsh_cua.server --stdio`
 *                                             one server per SSH session (pywinauto)
 *
 * WHY THE RELAY, IN ONE PARAGRAPH
 * -------------------------------
 * sshd on Windows runs in SESSION 0, which owns no interactive desktop: UIA
 * enumerates zero windows and SendInput goes nowhere. That was measured, not
 * assumed — `list_windows` answered 0 while notepad.exe sat in the "Services"
 * session. The relay is a small python listener inside the INTERACTIVE session
 * (started at logon, `C:\ProgramData\cua\mcp-relay.py`) that accepts a TCP
 * connection on 127.0.0.1 and bridges it byte-for-byte to the MCP server's
 * stdio. So the SSH child now runs the relay's `--connect` client, and the
 * guest's pywinauto server is finally in a session that has a desktop.
 * `RELAY_PING` / `RELAY_OK` (relayProbe()) is the one-shot health check, and
 * `python -m dsh_cua.server --stdio` is kept ONLY as the degraded fallback,
 * recorded with SESSION0_FALLBACK_REASON so nothing pretends it can drive the
 * desktop.
 *
 * U3: THERE IS NO NAMED PIPE. The earlier diagram showed
 * `\\.\pipe\dsh-cua (interactive session)` with an interactive
 * `dsh-cua-server` behind it, but upstream `dsh_cua.server main()` takes no
 * `--pipe` argument: the firstboot task was registering a listener that no
 * program ever created. The command below no longer passes it, because a flag
 * that does not exist is a lie in two places at once.
 *
 * The consequence is documented instead of papered over: with a stdio-only
 * upstream, ONE shared session-2 server cannot be reached from Session 0, so
 * each SSH attach starts its OWN stdio server inside the guest (19 tools, and
 * it works). That is the FALLBACK lane; the relay lane reaches a server that is
 * already running in the interactive session. Session-2-only features — the
 * clipboard — therefore do NOT ride this channel: `cua-firstboot.ps1` registers
 * two on-demand `/it` tasks for them (see docker/cua-vm-windows-qemu.mjs →
 * clipboardSet/clipboardGet), which is the only way to reach the interactive
 * session. A pipe server upstream would let one long-lived server be shared; it
 * does not exist yet, and this file will use it when it does.
 *
 * TWO USES, ONE IMPLEMENTATION
 * ----------------------------
 *   * library: `createDshCuaClient()` speaks MCP JSON-RPC over the SSH child's
 *     stdio. The plugin uses it to register the guest's tools on `ctx.tools`
 *     LAZILY — only while a Windows computer is the active kind — and to unregister
 *     them on close/delete. That is the "dynamic stdio MCP registration" the
 *     design asks for, without touching the user's profile: nothing is persisted.
 *   * CLI (`node … --stdio`): a plain MCP stdio server that forwards to the same
 *     SSH command, for anyone who prefers a `dsh-mcp-client` row instead. It
 *     costs one config line and the same ~3-8k tokens.
 *
 * KILL SWITCH: DSH_CUA_VM_WIN_MCP=0 disables both paths.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export const MCP_PROTOCOL_VERSION = '2024-11-05'

/** The MCP server name a Windows computer registers under. */
export const DEFAULT_SERVER_NAME = 'windows'

/**
 * NAMING (WP-3): the harness sees `mcp__<server>__<tool>`. Before this the
 * plugin invented `cua_win__tool_click_at`, which is not an MCP name at all and
 * made a Windows tool indistinguishable from a plugin tool of the same shape.
 * Everything the model touches now goes through windowsToolName().
 */
export const TOOL_PREFIX = 'mcp__windows__'

/** Reveal the desktop: a screenshot plus the live noVNC hand-off URL. */
export const REVEAL_TOOL_NAME = 'windows_desktop'

/** Diagnostics: reachability, SSH argv, guest handshake, last error. */
export const DOCTOR_TOOL_NAME = 'windows_mcp_doctor'

/** `tool_click_at` → `mcp__windows__tool_click_at` (sanitised, never doubled). */
export function windowsToolName(tool) {
  const bare = String(tool)
  const stripped = bare.startsWith(TOOL_PREFIX) ? bare.slice(TOOL_PREFIX.length) : bare
  return `${TOOL_PREFIX}${stripped.replace(/[^A-Za-z0-9_]/gu, '_')}`
}

/** The reverse mapping: what the guest's own MCP server answers to. */
export function windowsGuestToolName(tool) {
  const bare = String(tool)
  return bare.startsWith(TOOL_PREFIX) ? bare.slice(TOOL_PREFIX.length) : bare
}

/**
 * Keepalive options for every SSH attach.
 *
 * ServerAliveInterval=15 alone is too slow for a suspended QEMU guest: the
 * socket can sit half-open for the kernel's TCP timeout (minutes), and every
 * tool call in that window hangs instead of failing. 10s × 2 unanswered probes
 * drops a dead or suspended link within ~20s, so the upper layer can unregister
 * the tools and say "the computer is not online" instead of waiting.
 * ForwardAgent/ForwardX11/PermitLocalCommand are off because this channel only
 * ever carries one stdio MCP server — no agent socket, no X11, no local escape.
 */
export const SSH_KEEPALIVE = Object.freeze([
  '-o', 'ServerAliveInterval=10',
  '-o', 'ServerAliveCountMax=2',
  '-o', 'TCPKeepAlive=yes',
  '-o', 'ForwardAgent=no',
  '-o', 'ForwardX11=no',
  '-o', 'PermitLocalCommand=no'
])

/** An Error that carries a stable machine-readable `.code`. */
export function mcpError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** The kill switch, read at call time so a test can flip it. */
export function windowsMcpEnabled() {
  return String(process.env.DSH_CUA_VM_WIN_MCP ?? '1') !== '0'
}

/* ------------------------------------------------------------------ *
 * LANES: the interactive relay, and the session-0 fallback
 * ------------------------------------------------------------------ */

/** Default TCP port of the interactive relay (env DSH_CUA_MCP_RELAY_PORT). */
export const RELAY_PORT_DEFAULT = 47999

/** Where the interactive-session relay script lives inside the guest. */
export const RELAY_SCRIPT = 'C:\\ProgramData\\cua\\mcp-relay.py'

/**
 * The relay client command, VERBATIM. It says `py` (the launcher on PATH) and
 * not `python`: on the live guest `python.exe` is not on the non-interactive
 * PATH while the launcher resolves — that was tested, not guessed.
 */
export const RELAY_COMMAND = 'py -3 C:\\ProgramData\\cua\\mcp-relay.py --connect'

/**
 * The degraded lane: a stdio server inside Session 0. It answers MCP fine, it
 * just cannot see or touch the desktop (UIA finds no windows there).
 */
export const LEGACY_DIRECT_COMMAND = 'python -m dsh_cua.server --stdio'

/** Exactly what a fallback attach records, so the doctor and the log agree. */
export const SESSION0_FALLBACK_REASON = 'session-0 fallback (interactive relay not running; desktop automation will be blind)'

/** What the relay answers on the health probe. */
export const RELAY_OK = 'RELAY_OK'
export const RELAY_BAD = 'RELAY_BAD'
export const RELAY_DOWN = 'RELAY_DOWN'

/** How long a probe answer is reused before the next attach re-probes. */
export const RELAY_PROBE_TTL_MS = 10000

/**
 * Backstop used only if an ssh child emits 'exit' and then never 'close' (a
 * spawn stub, or a transport that does not close its pipes). A real child emits
 * 'close' as soon as the drain completes, so this never decides a real probe;
 * it just keeps such a stub from holding the probe to its full timeout.
 */
const RELAY_CLOSE_GRACE_MS = 500

/**
 * The relay's TCP port: env DSH_CUA_MCP_RELAY_PORT, else 47999. Unparseable or
 * out-of-range values fall back instead of building a broken PowerShell line.
 */
export function relayPort() {
  const raw = process.env.DSH_CUA_MCP_RELAY_PORT
  if (raw === undefined || String(raw).trim() === '') return RELAY_PORT_DEFAULT
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : RELAY_PORT_DEFAULT
}

/** The env override, VERBATIM (no trim, no re-quoting), or null when unset. */
function winMcpCommandOverride() {
  const raw = process.env.DSH_CUA_WIN_MCP_COMMAND
  if (typeof raw !== 'string' || raw === '') return null
  return String(raw)
}

/**
 * The guest command that SHOULD speak MCP: the interactive relay.
 *
 * `DSH_CUA_WIN_MCP_COMMAND` still wins and is used exactly as written (a caller
 * that names its own command gets it, byte for byte). Note the asymmetry with
 * sshArgv(): that builder's default is the LEGACY command, because it is
 * synchronous and cannot probe — both real transports (createDshCuaClient and
 * the CLI) probe first and pass the decided command in.
 */
export function guestMcpCommand() {
  return winMcpCommandOverride() ?? RELAY_COMMAND
}

/**
 * The one-shot probe, as a single remote command.
 *
 * It is deliberately ONE powershell round trip: connect, send the 10 literal
 * bytes `RELAY_PING`, read EIGHT back, print RELAY_OK / RELAY_BAD, and print
 * RELAY_DOWN on any exception (no relay, refused, timeout). The exit status is
 * always 0, so the ANSWER — not ssh's exit code — is what is parsed.
 *
 * TWO THINGS HERE ARE LOAD-BEARING, because both produced a false RELAY_BAD
 * (→ the blind session-0 lane) in the field:
 *
 *   1. THE READ LOOPS. One `Read()` may legally return a SHORT read: TCP splits
 *      `RELAY_OK` into two segments and the single read returns 3 bytes, which
 *      then compares unequal against an 8-byte answer. Both ends are on
 *      127.0.0.1, so this is rare — rare enough to be misread as a dead relay.
 *      The loop accumulates until 8 bytes or the peer closes.
 *   2. THE ANSWER IS TRIMMED. The verdict is a line of text on the wire, and a
 *      CRLF tail (`RELAY_OK\r\n`) must not turn a healthy relay into RELAY_BAD;
 *      whitespace/CRLF is stripped before the exact compare.
 */
export function relayProbeCommand(port = relayPort()) {
  return 'powershell -NoProfile -Command "'
    + '$c=New-Object Net.Sockets.TcpClient;'
    + `try{$c.Connect('127.0.0.1',${port});$s=$c.GetStream();`
    + "$b=[Text.Encoding]::ASCII.GetBytes('RELAY_PING');$s.Write($b,0,$b.Length);"
    // Loop, do not assume: Read() can return a short count (down to 1 byte).
    + '$r=New-Object byte[] 8;$n=0;'
    + 'while($n -lt 8){$k=$s.Read($r,$n,8-$n);if($k -le 0){break};$n+=$k};'
    + '$c.Close();$a=[Text.Encoding]::ASCII.GetString($r,0,$n);$a=$a.Trim();'
    + "if($a -ceq 'RELAY_OK'){Write-Output RELAY_OK}"
    + 'else{Write-Output RELAY_BAD}}catch{Write-Output RELAY_DOWN}"'
}

/**
 * The probe cache. Keyed by the whole SSH target AND the port, because two
 * computers must never inherit each other's answer — and short-lived (10 s) so
 * an attach re-probes: the relay task may start after the guest boots, and a
 * cached "down" that outlived boot would pin the session to the blind lane.
 */
const relayProbeCache = { key: '', at: 0, answer: null }

/** Drop the cached answer (a test, or a caller that just (re)started the relay). */
export function resetRelayProbeCache() {
  relayProbeCache.key = ''
  relayProbeCache.at = 0
  relayProbeCache.answer = null
}

/**
 * Ask the guest whether the interactive relay is alive: `{ ok, status, port, ms,
 * detail, cached }`. Never throws — a probe that cannot even spawn SSH is a
 * DOWN answer, because the caller's next move is the same either way.
 *
 * `options` may also be a plain function: `relayProbe(({remoteCommand}) => argv)`
 * lets a caller supply the SSH argv factory (tests, alternate transports).
 */
export async function relayProbe(options = {}) {
  const normalized = typeof options === 'function' ? { sshArgsFactory: options } : (options ?? {})
  const {
    host = '127.0.0.1',
    port: sshPort,
    user = 'cua',
    keyPath,
    timeoutMs = 8000,
    ttlMs = RELAY_PROBE_TTL_MS,
    force = false,
    sshArgsFactory,
    spawnImpl = spawn,
    now = () => Date.now(),
    log = () => {}
  } = normalized

  const port = relayPort()
  const key = `${user}@${host}:${sshPort}|${keyPath ?? ''}|${port}`
  const startedAt = now()
  if (force !== true && relayProbeCache.answer !== null && relayProbeCache.key === key
    && (startedAt - relayProbeCache.at) < ttlMs) {
    return { ...relayProbeCache.answer, cached: true }
  }

  const remoteCommand = relayProbeCommand(port)
  const argv = typeof sshArgsFactory === 'function'
    ? sshArgsFactory({ host, port: sshPort, user, keyPath, remoteCommand })
    : sshArgv({ host, port: sshPort, user, keyPath, remoteCommand })

  const answer = await new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timer = null
    let graceTimer = null
    let child = null
    let exited = false
    const settle = (fallback, detail) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      // The answer is in: nothing else will be read from this child. Kill it so
      // an early answer (or a timeout) cannot leave an ssh process behind. On
      // the natural-exit path this is a no-op.
      if (exited !== true) {
        try { child?.kill('SIGTERM') } catch {}
      }
      const seen = /RELAY_(OK|BAD|DOWN)/u.exec(stdout)
      const status = seen === null ? fallback : `RELAY_${seen[1]}`
      resolve({
        ok: status === RELAY_OK,
        status,
        port,
        ms: Math.max(0, now() - startedAt),
        detail: (detail === '' ? String(stderr || stdout).trim() : detail).slice(0, 240),
        cached: false
      })
    }
    try {
      child = spawnImpl('/usr/bin/ssh', argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      settle(RELAY_DOWN, `spawn failed: ${error?.message ?? error}`)
      return
    }
    // NOT unref'd: this timer IS the probe's only bound. An unref'd timer lets
    // the event loop drain before it fires, which turns "no answer" into a
    // promise that never settles — the exact hang a health check must not have.
    timer = setTimeout(() => {
      settle(RELAY_DOWN, `no answer within ${timeoutMs} ms`)
    }, timeoutMs)
    child?.stdout?.setEncoding?.('utf8')
    child?.stdout?.on?.('data', (chunk) => {
      stdout += chunk
      // Answer early when it is on the wire: a relay that prints and then idles
      // must not hold the attach for the whole timeout.
      if (/RELAY_(OK|BAD|DOWN)/u.test(stdout)) settle(RELAY_DOWN, '')
    })
    child?.stderr?.setEncoding?.('utf8')
    child?.stderr?.on?.('data', (chunk) => { stderr += chunk })
    child?.on?.('error', (error) => settle(RELAY_DOWN, `ssh: ${error?.message ?? error}`))
    // 'exit' means the PROCESS is gone, not that its pipes are drained: stdout
    // data already written can still be sitting in the stream when 'exit' fires.
    // Settling there raced the drain and recorded a HEALTHY relay as RELAY_DOWN
    // — which then pins the attach to the blind session-0 lane for the whole
    // cache TTL. 'close' fires only after every stdio stream is closed, so it is
    // the drain-safe event and the one that decides. The short backstop below
    // only exists so a spawn stub that never emits 'close' cannot hold the probe
    // to its full timeout; a real child always reaches 'close' first.
    child?.on?.('exit', () => {
      exited = true
      if (settled) return
      graceTimer = setTimeout(() => settle(RELAY_DOWN, ''), RELAY_CLOSE_GRACE_MS)
      graceTimer.unref?.()
    })
    child?.on?.('close', () => { exited = true; settle(RELAY_DOWN, '') })
  })

  relayProbeCache.key = key
  relayProbeCache.at = now()
  relayProbeCache.answer = answer
  if (answer.ok !== true) log(`mcp-win: relay probe 127.0.0.1:${port} → ${answer.status}${answer.detail === '' ? '' : ` (${answer.detail})`}`)
  return answer
}

/**
 * DECIDE THE LANE for one attach: probe, then pick the command.
 *
 *   relay answers RELAY_OK         → the relay command  (transport: interactive-relay)
 *   RELAY_DOWN / RELAY_BAD         → the legacy direct command, with the reason
 *                                    SESSION0_FALLBACK_REASON on the record
 *   DSH_CUA_WIN_MCP_COMMAND set    → that command verbatim (no fallback rewrite;
 *                                    only the reason explains what was bypassed)
 *
 * Every attach calls this, so the decision follows the guest instead of a
 * decision made once at boot — the relay task may start minutes after logon.
 */
export async function resolveGuestMcpTransport(options = {}) {
  const normalized = typeof options === 'function' ? { sshArgsFactory: options } : (options ?? {})
  const { log = () => {} } = normalized
  const probe = await relayProbe({ ...normalized, log })
  const override = winMcpCommandOverride()
  const wanted = override ?? (probe.ok === true ? guestMcpCommand() : LEGACY_DIRECT_COMMAND)
  // The LANE is a property of the command that will actually run, not of the
  // probe: an override naming the relay still runs through the relay.
  const relayLane = /mcp-relay\.py/iu.test(wanted)
  const facts = {
    command: wanted,
    transport: relayLane ? 'interactive-relay' : 'session-0-direct',
    relayPort: probe.port,
    relayOk: probe.ok === true,
    relayStatus: probe.status,
    reason: '',
    detail: probe.detail,
    override: override !== null
  }
  if (override !== null) {
    if (relayLane === true && probe.ok !== true) {
      facts.reason = `DSH_CUA_WIN_MCP_COMMAND is honoured verbatim, but the relay probe answered ${probe.status}`
    } else if (relayLane !== true && probe.ok === true) {
      facts.reason = 'DSH_CUA_WIN_MCP_COMMAND is set, so the interactive relay lane is bypassed on purpose'
    }
    return facts
  }
  if (probe.ok !== true) {
    facts.reason = SESSION0_FALLBACK_REASON
    log(`mcp-win: ${SESSION0_FALLBACK_REASON}`)
  }
  return facts
}

/**
 * The doctor's four facts, freshly probed (cached ≤10 s, never spawns a second
 * SSH session for a call that just made one). The plugin's windowsMcpDoctor()
 * lives in index.js and is expected to spread this into its payload; keeping it
 * here means the transport truth has ONE owner.
 */
export async function relayDoctorFacts(options = {}) {
  const normalized = typeof options === 'function' ? { sshArgsFactory: options } : (options ?? {})
  const facts = await resolveGuestMcpTransport({ ...normalized, log: normalized.log ?? (() => {}) })
  return {
    transport: facts.transport,
    relayPort: facts.relayPort,
    relayOk: facts.relayOk,
    relayStatus: facts.relayStatus,
    command: facts.command,
    reason: facts.reason
  }
}

/**
 * The SSH argv. `-T` (no pty): MCP is a byte stream, not a terminal — a pty
 * would translate line endings and mangle JSON.
 *
 * `remoteCommand` UNDEFINED means LEGACY_DIRECT_COMMAND, not the relay: this
 * builder is synchronous and cannot probe. Both real callers probe first
 * (resolveGuestMcpTransport) and pass the decided command in, so the default is
 * only what a bare caller — one that never asked about the lane — would get: a
 * session that always starts, on the lane that always starts.
 */
export function sshArgv({ host = '127.0.0.1', port, user = 'cua', keyPath, remoteCommand } = {}) {
  const command = remoteCommand === undefined || remoteCommand === null || remoteCommand === ''
    ? LEGACY_DIRECT_COMMAND
    : String(remoteCommand)
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    ...SSH_KEEPALIVE,
    '-p', String(port),
    `${user}@${host}`,
    command
  ]
  if (keyPath !== undefined && keyPath !== null && keyPath !== '') args.unshift('-i', keyPath)
  return args
}

/**
 * A JSON-RPC-over-stdio MCP client.
 *
 * Deliberately small: initialize / tools/list / tools/call, one request in
 * flight at a time (MCP servers answer in order anyway), a per-request timeout,
 * and a `closed` state that the plugin can observe to unregister tools.
 */
export function createDshCuaClient({
  name,
  sshPort,
  host = '127.0.0.1',
  keyPath,
  user = 'cua',
  timeoutMs = 60000,
  isOnline,
  onClosed,
  log = () => {}
}) {
  let child = null
  let buffer = ''
  let nextId = 1
  const pending = new Map()
  /**
   * `transport` is the LANE this client's SSH child runs on, `relayOk` the last
   * probe answer, `reason` the sentence a fallback wrote down. All four are part
   * of the doctor payload — a bridge that is connected but blind must say so.
   */
  const state = {
    connected: false,
    online: false,
    serverInfo: null,
    tools: [],
    lastError: '',
    transport: null,
    relayPort: relayPort(),
    relayOk: null,
    reason: ''
  }
  /** The lane decision of the last attach (null until connect() ran). */
  let decided = null

  /**
   * Ask the upper layer whether the computer is reachable AT ALL before opening
   * a pipe. A suspended/stopped guest has no sshd: spawning anyway buys a
   * ConnectTimeout and a "connection refused" that reads like a credentials
   * problem. `undefined` input (no probe supplied) means "don't judge".
   */
  const assertOnline = async () => {
    const online = await isOnline?.()
    if (online === false) {
      throw mcpError('vm-offline', 'the Windows computer is not online; start it or pick another target')
    }
    return online !== false
  }

  const failAll = (error) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  const write = (message) => {
    if (child === null || child.stdin.destroyed || child.stdin.writable === false) {
      throw mcpError('not-connected', 'the Windows MCP bridge is not connected')
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (child === null) {
      reject(mcpError('not-connected', 'the Windows MCP bridge is not connected'))
      return
    }
    const id = nextId
    nextId += 1
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(mcpError('timeout', `the guest did not answer ${method} within ${timeoutMs} ms`))
    }, timeoutMs)
    timer.unref?.()
    pending.set(id, { resolve, reject, timer, method })
    try {
      write({ jsonrpc: '2.0', id, method, params })
    } catch (error) {
      pending.delete(id)
      clearTimeout(timer)
      reject(error)
    }
  })

  function onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.id === undefined) return // a notification (logMessage, progress…)
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message || `MCP error ${message.error.code}`))
    else entry.resolve(message.result)
  }

  function attach(process_) {
    child = process_
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line !== '') onLine(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      state.lastError = String(chunk).trim().slice(-400)
      log(`mcp-win: ${state.lastError}`)
    })
    // A dead/suspended link makes the next write fail with EPIPE. Without a
    // listener that is an UNCAUGHT 'error' event, i.e. the whole harness
    // process exits — the exact failure the fast keepalive would now trigger
    // more often. Record it and let the pending requests fail on exit/timeout.
    child.stdin.on('error', (error) => {
      state.lastError = `stdin: ${error?.message ?? error}`.slice(-400)
      log(`mcp-win: ${state.lastError}`)
    })
    child.on('exit', (code) => {
      const wasConnected = state.connected
      state.connected = false
      state.online = false
      failAll(mcpError('session-ended', `the guest MCP session ended (exit ${code})`))
      if (wasConnected) log(`mcp-win: session for ${name} closed (exit ${code})`)
      child = null
      // Immediate upper-layer teardown: dispose the registered tools now rather
      // than leaving 19 dead entries until the next list/refresh.
      try {
        onClosed?.(code ?? null)
      } catch (error) {
        log(`mcp-win: onClosed handler failed: ${error?.message ?? error}`)
      }
    })
  }

  return {
    name,
    state,
    /** Start the SSH child and complete the MCP handshake. */
    async connect() {
      if (!windowsMcpEnabled()) throw new Error('the Windows MCP bridge is disabled (DSH_CUA_VM_WIN_MCP=0)')
      await assertOnline()
      if (existsSync('/usr/bin/ssh') === false) throw mcpError('ssh-missing', 'ssh is not in this image, so the Windows MCP bridge cannot start')
      // PROBE FIRST, EVERY ATTACH. The relay task is registered at logon and may
      // come up minutes after the boot that made sshd reachable, so a decision
      // cached from the previous attach (or from boot) would pin this session to
      // the blind lane for its whole life.
      const facts = await resolveGuestMcpTransport({ host, port: sshPort, user, keyPath, log })
      decided = facts
      state.transport = facts.transport
      state.relayPort = facts.relayPort
      state.relayOk = facts.relayOk
      if (facts.reason !== '') {
        state.lastError = facts.reason
        state.reason = facts.reason
        log(`mcp-win: ${name}: ${facts.reason}`)
      }
      log(`mcp-win: ${name} lane=${facts.transport} relay=${facts.relayStatus}`)
      const argv = sshArgv({ host, port: sshPort, user, keyPath, remoteCommand: facts.command })
      child = spawn('/usr/bin/ssh', argv, { stdio: ['pipe', 'pipe', 'pipe'] })
      attach(child)
      const init = await request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'dsh-cua-vm', version: '1.0.0' }
      })
      state.serverInfo = init?.serverInfo ?? null
      write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
      const listed = await request('tools/list', {})
      state.tools = Array.isArray(listed?.tools) ? listed.tools : []
      state.connected = true
      state.online = true
      log(`mcp-win: ${name} connected (${state.tools.length} tool(s) from ${state.serverInfo?.name ?? 'dsh-cua'})`)
      return { serverInfo: state.serverInfo, tools: state.tools }
    },
    listTools() {
      return state.tools
    },
    /** The guest's tools under the public `mcp__windows__*` names. */
    publicTools() {
      return state.tools.map((tool) => ({ ...tool, name: windowsToolName(tool.name) }))
    },
    /**
     * The ssh argv this client would use — for the doctor tool. Before the first
     * attach there is no decision yet, so the builder's default applies; after
     * it, the argv shows the command that ACTUALLY ran.
     */
    sshArgv() {
      return sshArgv({ host, port: sshPort, user, keyPath, remoteCommand: decided?.command })
    },
    /**
     * The transport facts, for windowsMcpDoctor(). Synchronous and side-effect
     * free: the doctor has its own probe budget and must not open a second SSH
     * session. `transport: null` means "never attached in this process".
     */
    doctorFacts() {
      const probe = relayProbeCache.answer
      return {
        transport: state.transport ?? (probe === null ? null : (probe.ok === true ? 'interactive-relay' : 'session-0-direct')),
        relayPort: state.relayPort ?? relayPort(),
        relayOk: state.relayOk ?? probe?.ok ?? null,
        relayStatus: decided?.relayStatus ?? probe?.status ?? null,
        transportCommand: decided?.command ?? null,
        transportReason: state.reason
      }
    },
    async callTool(toolName, args = {}) {
      await assertOnline()
      const result = await request('tools/call', { name: windowsGuestToolName(toolName), arguments: args })
      return result
    },
    close() {
      try { child?.kill('SIGTERM') } catch {}
      child = null
      state.connected = false
      state.online = false
    }
  }
}

/* ------------------------------------------------------------------ *
 * CLI: a plain MCP stdio server (for a dsh-mcp-client row)
 * ------------------------------------------------------------------ */

/**
 * `node cua-vm-windows-mcp.mjs --stdio --port <sshPort> [--key <path>]`
 *
 * Pipes this process's stdio to the SSH child, which is all a stdio MCP server
 * needs to be. The supervisor's relay publishes the same server at
 * /vm/port/<name>/ for a human, but a MODEL talks to it this way.
 *
 * The lane decision is the SAME one the plugin makes (probe → relay, else the
 * direct fallback with a reason on stderr): a CLI row that silently ran the
 * session-0 server would look identical to a working one and behave blind.
 */
async function main(argv) {
  const args = { port: 0, key: '', host: '127.0.0.1', user: 'cua' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--port') args.port = Number(argv[++index])
    else if (flag === '--key') args.key = String(argv[++index])
    else if (flag === '--host') args.host = String(argv[++index])
    else if (flag === '--user') args.user = String(argv[++index])
  }
  if (!args.port) {
    process.stderr.write('usage: cua-vm-windows-mcp.mjs --stdio --port <sshPort> [--key <path>] [--host 127.0.0.1]\n')
    process.exit(2)
  }
  if (!windowsMcpEnabled()) {
    process.stderr.write('the Windows MCP bridge is disabled (DSH_CUA_VM_WIN_MCP=0)\n')
    process.exit(3)
  }
  const facts = await resolveGuestMcpTransport({
    host: args.host,
    port: args.port,
    user: args.user,
    keyPath: args.key,
    log: (line) => process.stderr.write(`${line}\n`)
  })
  process.stderr.write(`mcp-win: lane=${facts.transport} relay=${facts.relayStatus}${facts.reason === '' ? '' : ` — ${facts.reason}`}\n`)
  const ssh = spawn('/usr/bin/ssh', sshArgv({
    host: args.host, port: args.port, user: args.user, keyPath: args.key, remoteCommand: facts.command
  }), {
    stdio: ['pipe', 'pipe', 'inherit']
  })
  process.stdin.pipe(ssh.stdin)
  ssh.stdout.pipe(process.stdout)
  ssh.on('exit', (code) => process.exit(code ?? 0))
  process.on('SIGTERM', () => { try { ssh.kill('SIGTERM') } catch {} })
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  void main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`mcp-win: ${error?.message ?? error}\n`)
    process.exit(1)
  })
}

/** A random namespace so two computers never fight over tool names. */
export function serverNameFor(name) {
  return `cua_win_${String(name).replace(/[^a-z0-9]/gu, '').slice(0, 8)}_${randomBytes(2).toString('hex')}`
}
