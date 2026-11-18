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
 * the health check is `py -3 …mcp-relay.py --ping <port>` (relayProbe()), which
 * does the RELAY_PING/RELAY_OK handshake in ~1-2 s of stdlib python instead of a
 * ~4.6 s cold powershell.exe start (that cold start raced the probe budget right
 * after boot and pinned a LIVE relay to the blind lane — see relayProbeCommand).
 * `python -m dsh_cua.server --stdio` is kept ONLY as the degraded fallback,
 * recorded with SESSION0_FALLBACK_REASON so nothing pretends it can drive the
 * desktop, and a fallback attach now UPGRADES itself onto the relay the moment
 * the logon task makes the relay answer (see maybeUpgradeTransport).
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
 * The probe's WALL budget: connect + run, not the ping itself.
 *
 * The old 8 s was sized for a PowerShell probe whose cold start alone was
 * ~4.6 s on a tiny10 guest, so right after boot the budget was already half
 * spent before the socket was opened — one slow CLR start and the probe
 * answered RELAY_DOWN for a relay that was alive, which pinned the attach to
 * the blind session-0 lane. The `--ping` mode is ~1-2 s and the SSH setup
 * ~1 s, so 12 s covers a cold ssh plus a cold `py`. A genuinely dead relay
 * still costs only 12 s, because the probe early-settles the instant an answer
 * lands (see relayProbe) — only a silent guest ever spends the whole window.
 */
export const RELAY_PROBE_TIMEOUT_MS = 12000

/**
 * The one-shot probe, as a single remote command.
 *
 * WHY IT IS `--ping` AND NOT A POWERSHELL ONE-LINER
 * ------------------------------------------------
 * This used to be a PowerShell TcpClient script: connect, write the 10 literal
 * bytes `RELAY_PING`, read 8 back, print the verdict. It was CORRECT and it was
 * too SLOW — powershell.exe has to start a CLR before the first socket call,
 * ~4.6 s cold on a tiny10 guest. Right after boot that cold start raced the then
 * 8 s probe budget and answered "no answer within 8000 ms" for a relay that was
 * perfectly alive, so the attach fell back to the blind session-0 lane.
 * `cua-mcp-relay.py --ping [port]` performs the SAME handshake in the
 * interpreter that is already resolved: stdlib sockets, no child spawned, no
 * session lock, no desktop access, ~1-2 s. It prints exactly one line —
 * RELAY_OK, or RELAY_DOWN — and exits 0/1.
 *
 * `py` (the launcher) and not `python`: on the live guest python.exe is not on
 * the non-interactive PATH while the launcher resolves. That was proven live,
 * and it is why RELAY_COMMAND says `py -3` too.
 *
 * The ANSWER is parsed, never the exit status: a probe that cannot start prints
 * nothing at all, and `--ping` exits 1 for DOWN, so both collapse to RELAY_DOWN.
 * Parsing stays tolerant — relayProbe matches /RELAY_(OK|BAD|DOWN)/ over the
 * accumulated stdout, so a CRLF tail or surrounding whitespace cannot turn a
 * healthy relay into a blind attach.
 */
export function relayProbeCommand(port = relayPort()) {
  return `py -3 ${RELAY_SCRIPT} --ping ${port}`
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
    timeoutMs = RELAY_PROBE_TIMEOUT_MS,
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
 * DEFECT 2 — A LATE RELAY MUST BE ABLE TO TAKE OVER A LIVE SESSION-0 ATTACH.
 *
 * The lane is decided at attach, and the relay is registered by an onlogon task
 * that can come up AFTER the SSH attach that found it down. Nothing re-decided
 * afterwards: the client stayed on the blind lane until the guest went away, so
 * a computer whose relay was two seconds late stayed unusable for the whole
 * session. The fix is an upgrade, not a re-decision: while the CURRENT attach is
 * `session-0-direct`, probe again; the moment the probe answers RELAY_OK, tear
 * this child down and let the plugin's sync path re-attach (the probe answer is
 * cached, so the re-attach lands on the relay lane).
 *
 * BOUNDED ON PURPOSE. One attempt per RELAY_UPGRADE_INTERVAL_MS, so a relay that
 * flaps (task restarts, logon race) costs at most one 1-2 s probe and one
 * reconnect per minute, never a reconnect storm.
 */
export const RELAY_UPGRADE_INTERVAL_MS = 60_000

/**
 * How often the upgrade is CONSIDERED (the throttle above decides whether it is
 * attempted). 15 s means a relay that starts is picked up within a poll or two,
 * which is the same order as the plugin's own state poll.
 */
export const RELAY_UPGRADE_WATCH_MS = 15_000

/** The one log line the upgrade writes; tests and the doctor match on it. */
export const RELAY_UPGRADE_LOG = 'upgrading mcp transport to the interactive relay'

/**
 * The upgrade decision, pure so it can be asserted without an SSH child:
 * only a LIVE session-0 attach, never while a request is in flight (closing the
 * child underneath `tools/call` would fail the call the model is waiting on),
 * and never more than once per RELAY_UPGRADE_INTERVAL_MS.
 */
export function shouldUpgradeToRelay({
  transport = null,
  relayOk = null,
  lastUpgradeAttemptAt = 0,
  now = Date.now(),
  intervalMs = RELAY_UPGRADE_INTERVAL_MS,
  inFlight = 0
} = {}) {
  if (transport !== 'session-0-direct') return false
  if (relayOk === true) return false
  if (Number(inFlight) > 0) return false
  if (Number.isFinite(now) !== true) return false
  const last = Number.isFinite(lastUpgradeAttemptAt) ? lastUpgradeAttemptAt : 0
  return (now - last) >= intervalMs
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
    reason: '',
    /**
     * DEFECT 2: when the last upgrade attempt was made. 0 means "never", and the
     * throttle compares against RELAY_UPGRADE_INTERVAL_MS so a flapping relay
     * cannot turn a blind session into a reconnect loop.
     */
    lastUpgradeAttemptAt: 0
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
      stopUpgradeWatch()
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

  /* ------------------------------------------------------------------ *
   * THE UPGRADE (defect 2): a late relay takes over a live session-0 attach
   * ------------------------------------------------------------------ */

  let upgradeTimer = null

  const stopUpgradeWatch = () => {
    if (upgradeTimer === null) return
    clearInterval(upgradeTimer)
    upgradeTimer = null
  }

  /** Kill this child and stop watching; `close()` and an upgrade both use it. */
  const shutdown = () => {
    stopUpgradeWatch()
    try { child?.kill('SIGTERM') } catch { /* already dead */ }
    child = null
    state.connected = false
    state.online = false
  }

  /**
   * Consider (and, at most once per RELAY_UPGRADE_INTERVAL_MS, perform) the move
   * from `session-0-direct` to `interactive-relay`.
   *
   * The upgrade is a TEARDOWN, not a second connect(): this client kills its own
   * SSH child, `onClosed` tells the plugin, and the plugin's next sync re-probes
   * — and now gets RELAY_OK, so it attaches through the relay. Reconnecting here
   * would leave the plugin holding a client it never registered tools for.
   *
   * Never throws: it runs from a timer, and a health check must not take the
   * process down.
   */
  async function maybeUpgradeTransport(now = Date.now()) {
    if (state.connected !== true || child === null) return { upgraded: false, reason: 'not-connected' }
    const decision = shouldUpgradeToRelay({
      transport: state.transport,
      relayOk: state.relayOk,
      lastUpgradeAttemptAt: state.lastUpgradeAttemptAt,
      now,
      inFlight: pending.size
    })
    if (decision !== true) {
      return {
        upgraded: false,
        reason: state.transport !== 'session-0-direct'
          ? `lane is ${state.transport ?? 'unknown'}`
          : (state.relayOk === true ? 'relay already known up' : (pending.size > 0 ? 'a request is in flight' : 'throttled'))
      }
    }
    state.lastUpgradeAttemptAt = now
    try {
      // force: the cached answer may be the DOWN that put us on this lane, and
      // it may be seconds old — a relay that started since then must be seen.
      const probe = await relayProbe({
        host, port: sshPort, user, keyPath, log, force: true, timeoutMs: RELAY_PROBE_TIMEOUT_MS
      })
      if (probe.ok !== true) {
        state.relayOk = false
        return { upgraded: false, reason: `relay still ${probe.status}` }
      }
      state.relayOk = true
      // Re-checked AFTER the await: a tool call may have started while the probe
      // ran, and closing the child underneath it would fail the call the model
      // is waiting on.
      if (state.connected !== true || child === null) return { upgraded: false, reason: 'gone during the probe' }
      if (pending.size > 0) return { upgraded: false, reason: 'a request is in flight' }
      log(`mcp-win: ${name}: ${RELAY_UPGRADE_LOG} (port ${probe.port})`)
      shutdown()
      return { upgraded: true, reason: RELAY_UPGRADE_LOG }
    } catch (error) {
      log(`mcp-win: relay upgrade failed: ${error?.message ?? error}`)
      return { upgraded: false, reason: `upgrade failed: ${error?.message ?? error}` }
    }
  }

  /**
   * Watch ONLY on the blind lane. A relay attach has nothing to upgrade to, and
   * DSH_CUA_VM_WIN_MCP_UPGRADE=0 turns the watch off (tests, or a user who would
   * rather keep one session than chase a relay).
   */
  const startUpgradeWatch = () => {
    stopUpgradeWatch()
    if (state.transport !== 'session-0-direct') return
    if (String(process.env.DSH_CUA_VM_WIN_MCP_UPGRADE ?? '1') === '0') return
    // The `.catch` is belt-and-braces: maybeUpgradeTransport() already swallows
    // its own failures, and an unhandled rejection from a health timer would take
    // the harness down over a transport it was only trying to improve.
    upgradeTimer = setInterval(() => { void maybeUpgradeTransport().catch(() => {}) }, RELAY_UPGRADE_WATCH_MS)
    // Unref'd: a bridge must never be the reason the harness stays alive.
    upgradeTimer.unref?.()
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
      // DEFECT 2: on the blind lane, start watching for the relay that the
      // onlogon task may still be bringing up. Without this the fallback was
      // final for the life of the session, which is how a two-second-late relay
      // made a perfectly usable desktop permanently blind.
      startUpgradeWatch()
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
    /**
     * DEFECT 2, THE CALL SITE: `syncWindowsMcp()` in index.js re-validates the
     * attach on every poll and is where an upgrading bridge BELONGS (it owns the
     * registrations this client must not touch). It can call this and ignore the
     * answer — everything is throttled and guarded here:
     *
     *     void WIN_MCP.client?.maybeUpgradeTransport?.()
     *
     * Until it does, `connect()` starts an unref'd watch on the blind lane only,
     * so the upgrade happens WITHOUT a plugin change. Returns
     * `{ upgraded, reason }` and never throws.
     */
    maybeUpgradeTransport(now = Date.now()) {
      return maybeUpgradeTransport(now)
    },
    close() {
      shutdown()
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
