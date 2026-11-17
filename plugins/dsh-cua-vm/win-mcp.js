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
 *                                     └─▶ `python -m dsh_cua.server --stdio`
 *                                           one server per SSH session (pywinauto)
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
 * it works). Session-2-only features — the clipboard — therefore do NOT ride
 * this channel: `cua-firstboot.ps1` registers two on-demand `/it` tasks for
 * them (see docker/cua-vm-windows-qemu.mjs → clipboardSet/clipboardGet), which
 * is the only way to reach the interactive session. A pipe server upstream
 * would let one long-lived server be shared; it does not exist yet, and this
 * file will use it when it does.
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

/**
 * The guest command that speaks MCP over the SSH channel: a plain stdio server.
 *
 * U3: NO `--pipe`. `dsh_cua.server main()` has no such option (the flag was
 * accepted only as a stray argv token and ignored), so naming a pipe here
 * promised a shared listener that nothing ever created. The server is started
 * PER SSH SESSION and speaks JSON-RPC on that session's stdio.
 */
export function guestMcpCommand() {
  return String(process.env.DSH_CUA_WIN_MCP_COMMAND || 'python -m dsh_cua.server --stdio')
}

/**
 * The SSH argv. `-T` (no pty): MCP is a byte stream, not a terminal — a pty
 * would translate line endings and mangle JSON.
 */
export function sshArgv({ host = '127.0.0.1', port, user = 'cua', keyPath, remoteCommand = guestMcpCommand() }) {
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    ...SSH_KEEPALIVE,
    '-p', String(port),
    `${user}@${host}`,
    remoteCommand
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
  const state = { connected: false, online: false, serverInfo: null, tools: [], lastError: '' }

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
      const argv = sshArgv({ host, port: sshPort, user, keyPath })
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
    /** The ssh argv this client would use — for the doctor tool. */
    sshArgv() {
      return sshArgv({ host, port: sshPort, user, keyPath })
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
 */
function main(argv) {
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
  const ssh = spawn('/usr/bin/ssh', sshArgv({ host: args.host, port: args.port, user: args.user, keyPath: args.key }), {
    stdio: ['pipe', 'pipe', 'inherit']
  })
  process.stdin.pipe(ssh.stdin)
  ssh.stdout.pipe(process.stdout)
  ssh.on('exit', (code) => process.exit(code ?? 0))
  process.on('SIGTERM', () => { try { ssh.kill('SIGTERM') } catch {} })
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2))
}

/** A random namespace so two computers never fight over tool names. */
export function serverNameFor(name) {
  return `cua_win_${String(name).replace(/[^a-z0-9]/gu, '').slice(0, 8)}_${randomBytes(2).toString('hex')}`
}
