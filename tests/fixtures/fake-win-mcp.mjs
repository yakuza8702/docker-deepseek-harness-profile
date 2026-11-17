/**
 * fake-win-mcp.mjs — the REAL win-mcp.js with only the SSH client replaced.
 *
 * WHY A FIXTURE AND NOT A HAND-WRITTEN MODULE
 * -------------------------------------------
 * `tests/windows-mcp-gate.mjs` has to drive the REAL gate in
 * `plugins/dsh-cua-vm/index.js`: the registration loop, the disposers, the
 * `restrict({deny})` layer, the `tools.guard` veto and the pre-step self-heal.
 * Stubbing win-mcp wholesale would let the test pass against a plugin that no
 * longer matches the module it ships with — so everything except the transport
 * is re-exported from the source of truth:
 *
 *   * `windowsToolName`, `windowsGuestToolName`, `TOOL_PREFIX`, the keepalive and
 *     the error helper are the REAL ones (the naming assertions are about the
 *     shipped code);
 *   * only `createDshCuaClient` is replaced, because that is the piece that
 *     would spawn `ssh` and a Python MCP server inside a Windows guest.
 *
 * NINETEEN TOOLS, because that is the number the bridge is budgeted for and the
 * number every gate check counts. They are shaped like the real dsh-cua server's
 * tools (`tool_*` element actions + `find_elements`), not like invented names.
 *
 * A SESSION CAN BE "LEAKED". `state.connected = false` without `close()` is the
 * reported failure mode: the SSH child is gone, `onClosed` never fired, and the
 * 19 global schemas are still registered. That is what the pre-step self-heal is
 * asserted against.
 */

export * from '../../plugins/dsh-cua-vm/win-mcp.js'

import { sshArgv as realSshArgv } from '../../plugins/dsh-cua-vm/win-mcp.js'

/** The 19 tools a dsh-cua server inside the guest publishes. */
export const GUEST_TOOLS = [
  { name: 'tool_click_at', description: 'Click the pixel at x,y', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'tool_double_click_at', description: 'Double-click at x,y', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'tool_move_to', description: 'Move the pointer to x,y', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'tool_drag', description: 'Drag from one pixel to another', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } }, required: ['x', 'y', 'x2', 'y2'] } },
  { name: 'tool_type_text', description: 'Type text into the focused control', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'tool_press_keys', description: 'Press a key or hotkey', inputSchema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] } },
  { name: 'tool_scroll', description: 'Scroll at x,y', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, amount: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'tool_screenshot', description: 'Capture the desktop', inputSchema: { type: 'object', properties: {} } },
  { name: 'find_elements', description: 'Find elements by name or control type', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'tool_invoke', description: 'Invoke an element', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
  { name: 'tool_get_text', description: 'Read an element text', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
  { name: 'tool_set_value', description: 'Set an element value', inputSchema: { type: 'object', properties: { target: { type: 'string' }, value: { type: 'string' } }, required: ['target', 'value'] } },
  { name: 'tool_list_windows', description: 'List top-level windows', inputSchema: { type: 'object', properties: {} } },
  { name: 'tool_activate_window', description: 'Bring a window to the front', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
  { name: 'tool_close_window', description: 'Close a window', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
  { name: 'tool_launch_app', description: 'Launch an application', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'tool_wait_for', description: 'Wait for an element to appear', inputSchema: { type: 'object', properties: { query: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['query'] } },
  { name: 'tool_read_clipboard', description: 'Read the guest clipboard', inputSchema: { type: 'object', properties: {} } },
  { name: 'tool_write_clipboard', description: 'Write the guest clipboard', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }
]

/** Every client this process created, so a test can leak or close one. */
export const SESSIONS = []

/**
 * J20-4: A HAND-SHAKE THAT CAN BE HELD OPEN.
 *
 * The interleaving defect is a DELETE that lands during `connect()`. Reproducing
 * it needs the handshake to be slow on purpose, so `holdConnect()` parks the next
 * connects on a promise and `release()` lets them through — the test then has a
 * real in-flight attach window to delete inside of.
 */
let CONNECT_GATE = null

export function holdConnect() {
  let release = null
  const promise = new Promise((resolve) => { release = resolve })
  CONNECT_GATE = { promise, release }
  return {
    release() {
      const gate = CONNECT_GATE
      CONNECT_GATE = null
      try { gate?.release() } catch {}
    }
  }
}

/** Whether a hold is active (so a test can prove the window really existed). */
export function connectHeld() {
  return CONNECT_GATE !== null
}

export function createDshCuaClient(options = {}) {
  const state = {
    connected: false,
    online: false,
    serverInfo: { name: 'dsh-cua', version: 'fake' },
    tools: [],
    lastError: ''
  }
  const session = {
    name: options.name,
    state,
    calls: [],
    options,
    async connect() {
      // HELD FOR THE INTERLEAVING CASE, before anything observes the guest.
      if (CONNECT_GATE !== null) await CONNECT_GATE.promise
      const online = await options.isOnline?.()
      if (online === false) {
        const error = new Error('the Windows computer is not online; start it or pick another target')
        error.code = 'vm-offline'
        throw error
      }
      state.connected = true
      state.online = true
      state.tools = GUEST_TOOLS
      return { serverInfo: state.serverInfo, tools: GUEST_TOOLS }
    },
    listTools() { return GUEST_TOOLS },
    publicTools() { return GUEST_TOOLS.map((tool) => ({ ...tool, name: `mcp__windows__${tool.name}` })) },
    sshArgv() {
      return realSshArgv({ host: options.host ?? '127.0.0.1', port: options.sshPort, user: options.user ?? 'cua', keyPath: options.keyPath })
    },
    async callTool(name, args = {}) {
      if (state.connected !== true) {
        const error = new Error('the Windows MCP bridge is not connected')
        error.code = 'not-connected'
        throw error
      }
      session.calls.push({ name, args })
      return { ok: true, tool: name, echoed: args }
    },
    close() {
      state.connected = false
      state.online = false
    }
  }
  SESSIONS.push(session)
  return session
}

/**
 * THE REPORTED LEAK, ON DEMAND: the SSH session is gone but nothing told the
 * plugin, so the global schemas stay registered. `close()` is NOT called — that
 * is what `onClosed`/teardown would have done.
 */
export function leakSession(session) {
  session.state.connected = false
  session.state.online = false
}
