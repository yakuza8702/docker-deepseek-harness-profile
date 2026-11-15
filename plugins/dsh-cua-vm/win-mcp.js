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
 * Layout:
 *
 *   harness (this process) ──ssh──▶ guest: cua@:22 (sshd)
 *                                     └─▶ \\.\pipe\dsh-cua (interactive session)
 *                                           └─▶ dsh-cua-server (pywinauto)
 *
 * SSH lands in Session 0, where there IS no desktop, so the SSH side does not
 * drive the UI itself: the OEM first-boot script starts `dsh-cua-server` as an
 * INTERACTIVE logon task and the SSH shell proxies stdio to that named pipe.
 * (See docker/windows-oem/cua-firstboot.ps1 — the task is the reason pywinauto
 * can see windows at all.)
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
export const DEFAULT_SERVER_NAME = 'cua_win'

/** The kill switch, read at call time so a test can flip it. */
export function windowsMcpEnabled() {
  return String(process.env.DSH_CUA_VM_WIN_MCP ?? '1') !== '0'
}

/** The guest command that speaks MCP: the pipe proxy the OEM script installs. */
export function guestMcpCommand() {
  return String(process.env.DSH_CUA_WIN_MCP_COMMAND || 'python -m dsh_cua.server --stdio --pipe \\\\.\\pipe\\dsh-cua')
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
    '-o', 'ServerAliveInterval=15',
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
export function createDshCuaClient({ name, sshPort, host = '127.0.0.1', keyPath, user = 'cua', timeoutMs = 60000, log = () => {} }) {
  let child = null
  let buffer = ''
  let nextId = 1
  const pending = new Map()
  const state = { connected: false, serverInfo: null, tools: [], lastError: '' }

  const failAll = (error) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  const write = (message) => {
    if (child === null || child.stdin.destroyed) throw new Error('the Windows MCP bridge is not connected')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (child === null) {
      reject(new Error('the Windows MCP bridge is not connected'))
      return
    }
    const id = nextId
    nextId += 1
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`the guest did not answer ${method} within ${timeoutMs} ms`))
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
    child.on('exit', (code) => {
      const wasConnected = state.connected
      state.connected = false
      failAll(new Error(`the guest MCP session ended (exit ${code})`))
      if (wasConnected) log(`mcp-win: session for ${name} closed (exit ${code})`)
      child = null
    })
  }

  return {
    name,
    state,
    /** Start the SSH child and complete the MCP handshake. */
    async connect() {
      if (!windowsMcpEnabled()) throw new Error('the Windows MCP bridge is disabled (DSH_CUA_VM_WIN_MCP=0)')
      if (existsSync('/usr/bin/ssh') === false) throw new Error('ssh is not in this image, so the Windows MCP bridge cannot start')
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
      log(`mcp-win: ${name} connected (${state.tools.length} tool(s) from ${state.serverInfo?.name ?? 'dsh-cua'})`)
      return { serverInfo: state.serverInfo, tools: state.tools }
    },
    listTools() {
      return state.tools
    },
    async callTool(toolName, args = {}) {
      const result = await request('tools/call', { name: toolName, arguments: args })
      return result
    },
    close() {
      try { child?.kill('SIGTERM') } catch {}
      child = null
      state.connected = false
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
