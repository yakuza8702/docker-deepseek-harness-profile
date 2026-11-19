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
 *
 * THE LANE IS A CONTRACT, NOT A DETAIL (WP-5.1, SOL §4.3/§4.6/§4.10)
 * ------------------------------------------------------------------
 * The reported P0 defect was invisible to the fixture: it could only say
 * "attached", never WHICH lane the attach took, so a blind bridge looked exactly
 * like a healthy one. The fake client therefore carries the same lane surface as
 * the real one —
 *
 *   state.transport    'interactive-relay' | 'session-0-direct' | null (never decided)
 *   state.relayOk      boolean | null          (§4.3: stays a boolean)
 *   state.relayStatus  RELAY_OK | RELAY_BAD | RELAY_DOWN | RELAY_SKEW | null
 *   state.relayPort    the port the attach probed
 *   state.probeMode    'handshake' | 'legacy-ping' | null
 *   state.repair       the last parsed `CUA_RELAY` record, or null
 *   state.payload      { relayHash, skew } — identity of the guest payload
 *
 * — plus the two methods the plugin drives (`doctorFacts()`,
 * `maybeUpgradeTransport()`) and the repair verb (`repairRelay()`),
 * with the module knobs `setLane()` / `setRepairResult()` and the counters
 * `repairCalls` / `probeCalls` / `spawnCalls`.
 *
 * DEFAULT LANE IS `interactive-relay`. That is deliberate: the checks that
 * predate the lane (an online bridge reports `ok`, 19 tools, no leaks) keep
 * their meaning only while the fake bridge is HEALTHY. A test that wants the
 * blind case calls `setLane('session-0-direct')` — which is the reported bug,
 * on demand.
 *
 * THE RECORD GRAMMAR IS FROZEN (SOL Appendix B). `parseCuaRelayRecord()` is the
 * fixture's parser for it, so the tests assert the grammar the guest prints —
 * `CUA_RELAY ok=1 port=… task=1 running=1 session=2 probe=RELAY_OK hash=… —
 * instead of a private JS shape that no guest ever emits. A missing `ok` is
 * NEVER success, exactly as the contract says.
 */
export * from '../../plugins/dsh-cua-vm/win-mcp.js'

import * as realWinMcp from '../../plugins/dsh-cua-vm/win-mcp.js'
import { sshArgv as realSshArgv } from '../../plugins/dsh-cua-vm/win-mcp.js'

/* ------------------------------------------------------------------ *
 * THE TOKENS AND LINES, read from the REAL module when it has them.
 *
 * `??` (not a literal) on purpose: WP-2 lands `RELAY_SKEW` and
 * `SESSION0_SKEW_REASON` in the module under test. Until it does, the fixture
 * still speaks the frozen contract's spelling, so the gate's blind checks run
 * against the contract rather than against a missing export.
 * ------------------------------------------------------------------ */
const TOKEN_OK = realWinMcp.RELAY_OK ?? 'RELAY_OK'
const TOKEN_BAD = realWinMcp.RELAY_BAD ?? 'RELAY_BAD'
const TOKEN_DOWN = realWinMcp.RELAY_DOWN ?? 'RELAY_DOWN'
const TOKEN_SKEW = realWinMcp.RELAY_SKEW ?? 'RELAY_SKEW'
const RELAY_SCRIPT = 'C:\\ProgramData\\cua\\mcp-relay.py'
const PORT_DEFAULT = realWinMcp.RELAY_PORT_DEFAULT ?? 47999
/** §2.3: the DOWN sentence is byte-identical; SKEW gets its own. */
const FALLBACK_REASON_DOWN = realWinMcp.SESSION0_FALLBACK_REASON
  ?? 'session-0 fallback (interactive relay not running; desktop automation will be blind)'
const FALLBACK_REASON_SKEW = realWinMcp.SESSION0_SKEW_REASON
  ?? 'session-0 fallback (the guest relay answered, but the harness probe could not read it: payload mismatch; desktop automation will be blind)'
/**
 * §4.4 — WHICH REPAIRS WERE MEASURED, frozen in the module under test.
 *
 * A `CUA_RELAY` line is a MEASUREMENT: it says the attempt ran and what it saw
 * (`session=`, `hash=`, `probe=`). An attempt that never ran — disabled,
 * throttled, no record, the bridge itself down — measured NOTHING, and the
 * fields it "would" have carried are unknown, not zero. Treating a missing
 * session as `0` is how a blind bridge would be reported as "no interactive
 * session" when nobody ever asked.
 */
const UNMEASURED = realWinMcp.RELAY_REPAIR_UNMEASURED ?? {
  NO_RECORD: 'no-record',
  REPAIR_DISABLED: 'repair-disabled',
  BRIDGE_DISABLED: 'bridge-disabled',
  THROTTLED: 'throttled',
  EXCEPTION: 'exception'
}

/** §4.6 — the closed set. A `blind` verdict may only carry one of these. */
export const BLIND_REASONS = [
  'probe-skew',
  'relay-missing',
  'relay-stopped',
  'no-interactive-session',
  'lane-unknown',
  'repair-disabled'
]
/** The two lanes the contract allows a live attach to take (§4.10). */
export const LANES = ['interactive-relay', 'session-0-direct']
/** A stand-in for the SHA-256 of `C:\ProgramData\cua\mcp-relay.py` (64 hex). */
export const FIXTURE_RELAY_HASH = '3f2a1c'.repeat(10) + 'beef'

/** The 19 tools a dsh-cua server inside the guest publishes. */
export const GUEST_TOOLS = [
  { name: 'tool_click_at', description: 'Click the pixel at x,y', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'tool_double_click_at', description: 'Double-click at x,y', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'tool_move_to', description: 'Move the pointer to x,y', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'tool_drag', description: 'Drag from one pixel to another', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } }, required: ['x', 'y', 'x2', 'y2'] } },
  { name: 'tool_type_text', description: 'Type text into the focused control', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'tool_send_keys', description: 'Press a key or hotkey', inputSchema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] } },
  { name: 'tool_scroll', description: 'Scroll at x,y', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, amount: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'tool_capture_window', description: 'Capture the desktop', inputSchema: { type: 'object', properties: {} } },
  { name: 'find_elements', description: 'Find elements by name or control type', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'tool_invoke', description: 'Invoke an element', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
  { name: 'tool_get_text', description: 'Read an element text', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
  { name: 'tool_set_value', description: 'Set an element value', inputSchema: { type: 'object', properties: { target: { type: 'string' }, value: { type: 'string' } }, required: ['target', 'value'] } },
  { name: 'tool_list_windows', description: 'List top-level windows', inputSchema: { type: 'object', properties: {} } },
  { name: 'tool_activate_window', description: 'Bring a window to the front', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
  { name: 'tool_close_window', description: 'Close a window', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
  { name: 'tool_open_application', description: 'Launch an application', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'tool_wait_for', description: 'Wait for an element to appear', inputSchema: { type: 'object', properties: { query: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['query'] } },
  { name: 'tool_read_clipboard', description: 'Read the guest clipboard', inputSchema: { type: 'object', properties: {} } },
  { name: 'tool_write_clipboard', description: 'Write the guest clipboard', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }
]

/** Every client this process created, so a test can leak or close one. */
export const SESSIONS = []

/* ------------------------------------------------------------------ *
 * APPENDIX B — THE FROZEN REPAIR RECORD
 *
 * One line, space-separated key=value, `CUA_RELAY` first:
 *
 *   CUA_RELAY ok=1 port=47999 task=1 running=1 session=2 probe=RELAY_OK \
 *             hash=<sha256> mode=handshake reason=
 *
 * The parser tolerates a missing TAIL field but NEVER treats a missing `ok` as
 * success — a record whose `ok` is absent, malformed or not `1` is a failure.
 * ------------------------------------------------------------------ */
export function parseCuaRelayRecord(line) {
  const text = String(line ?? '').trim()
  if (text === '' || !text.startsWith('CUA_RELAY')) return null
  // ONE GRAMMAR, ONE PARSER: when the module under test ships the real parser,
  // the fixture uses it — a fixture-private reading of Appendix B could agree
  // with the tests and disagree with the guest.
  if (typeof realWinMcp.parseRelayRepairRecord === 'function') {
    const parsed = realWinMcp.parseRelayRepairRecord(text)
    return parsed === null ? null : { ...parsed, raw: text }
  }
  const fields = {}
  for (const part of text.split(/\s+/u).slice(1)) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    fields[part.slice(0, at)] = part.slice(at + 1)
  }
  // THE ONE RULE THAT MATTERS: only `ok=1` is success.
  const ok = fields.ok === '1'
  const number = (value) => (value === undefined || value === '' || !/^-?\d+$/u.test(value) ? null : Number(value))
  return {
    ok,
    port: number(fields.port),
    task: number(fields.task),
    running: number(fields.running),
    session: number(fields.session),
    probe: fields.probe ?? '',
    hash: fields.hash ?? '',
    mode: fields.mode ?? '',
    reason: fields.reason ?? '',
    raw: text
  }
}

/**
 * THE ATTEMPT THAT NEVER RAN. `measured:false` + the reason it did not, and
 * every guest field NULL — never `0`, never `''`, never a default. `session: 0`
 * means "there is no console session"; `session: null` means "nobody looked".
 */
function unmeasuredRecord(reason = UNMEASURED.NO_RECORD, extra = {}) {
  return {
    measured: false,
    unmeasured: reason,
    ok: false,
    port: extra.port ?? null,
    task: null,
    running: null,
    session: null,
    probe: null,
    hash: null,
    mode: '',
    reason: '',
    raw: '',
    ...extra
  }
}

/**
 * A record shaped like the frozen grammar, for `setRepairResult({ ok: true })`.
 *
 * THREE FORMS, ONE RULE:
 *   * a `CUA_RELAY …` string IS a measurement (the production parser marks it so);
 *   * an OBJECT models a repair that RAN and therefore defaults to
 *     `measured: true` — that is what the existing checks mean, and hiding it
 *     would silently turn every repair assertion into a no-op;
 *   * `{ measured: false }` (or `unmeasured: 'throttled'`) models an attempt
 *     that did NOT run, and nulls the guest fields.
 */
function normaliseRecord(record) {
  if (record === null || record === undefined) return unmeasuredRecord(UNMEASURED.NO_RECORD)
  if (typeof record === 'string') return parseCuaRelayRecord(record)
  const unmeasured = record.measured === false || typeof record.unmeasured === 'string'
  if (unmeasured) {
    return unmeasuredRecord(record.unmeasured ?? UNMEASURED.NO_RECORD, {
      ...(record.port === undefined ? {} : { port: record.port }),
      ...(record.throttled === true ? { throttled: true } : {}),
      ...(record.disabled === true ? { disabled: true } : {})
    })
  }
  const ok = record.ok === true || record.ok === 1 || record.ok === '1'
  return {
    measured: true,
    unmeasured: '',
    ok,
    port: record.port ?? null,
    task: record.task ?? (ok ? 1 : 0),
    running: record.running ?? (ok ? 1 : 0),
    session: record.session ?? (ok ? 2 : 0),
    probe: record.probe ?? (ok ? TOKEN_OK : TOKEN_DOWN),
    hash: record.hash ?? FIXTURE_RELAY_HASH,
    mode: record.mode ?? 'handshake',
    reason: record.reason ?? (ok ? '' : 'relay-stopped'),
    raw: record.raw ?? ''
  }
}

/* ------------------------------------------------------------------ *
 * THE LANE KNOBS (module scope, because the PLUGIN creates the client)
 *
 * The gate suite never calls `createDshCuaClient` itself — `index.js` does — so
 * a per-client option could not reach the fixture. The lane, the repair result
 * and the throttle window are therefore module state, read at attach time.
 * ------------------------------------------------------------------ */
const DEFAULT_LANE = {
  lane: 'interactive-relay',
  relayOk: true,
  relayStatus: TOKEN_OK,
  probeMode: 'handshake',
  relayDetail: '',
  reason: '',
  interpreter: 'py -3',
  port: null
}

let LANE = { ...DEFAULT_LANE }
/** What the NEXT `repairRelay()` answers; `null` = a failed attempt. */
let REPAIR_RESULT = null
/** The real client throttles at `RELAY_REPAIR_INTERVAL_MS` (60 s). */
let REPAIR_THROTTLE_MS = 60_000
/** A moved clock, so one throttle window is testable without a 60 s sleep. */
let CLOCK_SKEW_MS = 0

/** The transport seam and the twin counters (§4.2/§4.3/§4.4, WP-2.4). */
export const counters = {
  repairCalls: 0,
  probeCalls: 0,
  connects: 0,
  spawnCalls: 0
}

export function resetCounters() {
  for (const key of Object.keys(counters)) counters[key] = 0
}

/**
 * `setLane('session-0-direct')` is THE REPORTED BUG ON DEMAND.
 *
 * `detail` overrides the derived facts — e.g. `{ relayStatus: RELAY_SKEW,
 * probeMode: 'handshake', reason: SESSION0_SKEW_REASON }` for the payload-skew
 * case, or `{ relayStatus: null, relayOk: null, probeMode: null }` for a lane
 * that was never decided (§4.10 `lane-unknown`).
 */
export function setLane(lane, detail = {}) {
  if (lane !== null && !LANES.includes(lane)) throw new Error(`fake-win-mcp: unknown lane "${lane}" (expected ${LANES.join('|')}|null)`)
  const derived = lane === 'interactive-relay'
    ? { relayOk: true, relayStatus: TOKEN_OK, probeMode: 'handshake', reason: '' }
    : lane === 'session-0-direct'
      ? { relayOk: false, relayStatus: TOKEN_DOWN, probeMode: 'handshake', reason: FALLBACK_REASON_DOWN }
      : { relayOk: null, relayStatus: null, probeMode: null, reason: '' }
  LANE = { ...DEFAULT_LANE, ...derived, lane, ...detail }
  if (detail.port === undefined) LANE.port = null
  // §4.3: the SENTENCE follows the classification — a relay that ANSWERED is not
  // "not running". Deriving it here keeps one rule for both callers.
  if (lane === 'session-0-direct' && detail.reason === undefined) {
    LANE.reason = LANE.relayStatus === TOKEN_SKEW ? FALLBACK_REASON_SKEW : FALLBACK_REASON_DOWN
  }
  return LANE
}

/** Restore the default lane and every knob — the suite's "between checks" reset. */
export function resetLane() {
  LANE = { ...DEFAULT_LANE }
  REPAIR_RESULT = null
  REPAIR_THROTTLE_MS = 60_000
  CLOCK_SKEW_MS = 0
  resetCounters()
  return LANE
}

/** What the next repair attempt answers: `{ ok: true }`, or a frozen-grammar line. */
export function setRepairResult(record) {
  REPAIR_RESULT = record
  return normaliseRecord(record)
}

/** The throttle window the fake enforces (real client: `RELAY_REPAIR_INTERVAL_MS`). */
export function setRepairThrottleMs(ms) {
  REPAIR_THROTTLE_MS = Math.max(0, Number(ms) || 0)
  return REPAIR_THROTTLE_MS
}

/** Move the fake clock forward so the NEXT window is already open. */
export function advanceRepairWindow(ms = REPAIR_THROTTLE_MS || 60_000) {
  CLOCK_SKEW_MS += Math.max(0, Number(ms) || 0)
  return CLOCK_SKEW_MS
}

/** The lane the fixture is currently configured to report (for a suite's own log). */
export function currentLane() {
  return { ...LANE }
}

/* ------------------------------------------------------------------ *
 * APPENDIX B — THE DESKTOP SESSION'S OWN FACTS (WP-6.1)
 *
 * The relay (`--serve`, WP-3.3) writes ONE JSON object from inside the desktop
 * session; `desktopFacts()` (WP-4.1) reads it over SSH and hands the doctor a
 * shape it can publish. The fixture replaces ONLY the transport, so the client
 * surface the plugin drives has to exist here too:
 *
 *   client.desktopFacts()          async — the read (one SSH in the real client)
 *   client.refreshDesktopFacts()   async — the same read under its other name
 *   client.desktopFactsCached()    sync  — what `windows_desktop` may return
 *   state.desktop                  the last answer, or null
 *
 * THE DEFAULT IS A HEALTHY DESKTOP (`measured:true`, `elementLaneOk:true`,
 * `workDirWritable:true`, `scaleFix:'applied'`), because the checks that
 * predate this contract are about the LANE, not about a dead element lane: a
 * fixture that defaulted to `measured:false` would turn every unrelated
 * assertion into a false warning. A test that wants the dead lane calls
 * `setDesktopFacts({ win32ui:false, elementLaneOk:false })` — the reported D1,
 * on demand.
 *
 * THE UNMEASURED CASE IS A FIRST-CLASS ANSWER (§Appendix B): `measured !== true`
 * means EVERY field is unknown, never `false`. `setDesktopFacts(null)` models a
 * guest provisioned before the facts file existed, and the fake nulls the
 * measured fields exactly as the real normaliser does.
 * ------------------------------------------------------------------ */
export const DESKTOP_FACTS_DEFAULT = Object.freeze({
  schema: 1,
  measured: true,
  at: '2026-11-19T15:04:05Z',
  user: 'cua',
  session: 2,
  python: 'C:\\Program Files\\Python312\\python.exe',
  dshCuaVersion: '0.4.1',
  pywin32Version: '306',
  win32ui: true,
  uiaLane: true,
  uiaLaneOk: true,
  elementLaneOk: true,
  scaleFix: 'applied',
  workDir: 'C:\\cua-work',
  workDirWritable: true,
  profileRootWritable: false,
  source: 'cua-work',
  error: ''
})

/** The measured fields that are UNKNOWN whenever `measured !== true`. */
const DESKTOP_FACT_FIELDS = [
  'schema', 'user', 'session', 'python', 'dshCuaVersion', 'pywin32Version',
  'win32ui', 'uiaLane', 'uiaLaneOk', 'elementLaneOk', 'scaleFix',
  'workDir', 'workDirWritable', 'profileRootWritable'
]

let DESKTOP_FACTS = { ...DESKTOP_FACTS_DEFAULT }

/** How many reads/refreshes the plugin really performed (C3's spawn counter). */
export const desktopFactCalls = { reads: 0, refreshes: 0 }

/**
 * `setDesktopFacts({ win32ui:false })` — the reported D1, on demand.
 * `setDesktopFacts(null)` — a guest with NO facts file (`measured:false`).
 * An explicit `{ measured:false }` is honoured as-is: the unknown fields are
 * nulled, never defaulted to `false`.
 */
export function setDesktopFacts(value) {
  if (value === null) {
    DESKTOP_FACTS = null
  } else {
    const merged = { ...DESKTOP_FACTS_DEFAULT, ...value }
    if (merged.measured !== true) {
      for (const field of DESKTOP_FACT_FIELDS) merged[field] = null
      merged.measured = false
    }
    DESKTOP_FACTS = merged
  }
  desktopFactCalls.reads = 0
  desktopFactCalls.refreshes = 0
  // A LIVE CLIENT MAY HAVE CACHED THE OLD ANSWER: `windows_desktop` returns
  // `desktopFactsCached()` without blocking (WP-5.9), so a knob that only changed
  // the next READ would be invisible to the path under test. Push the new answer
  // into every client this process created — one source of truth, both paths.
  for (const session of SESSIONS) {
    try { session.state.desktop = DESKTOP_FACTS === null ? desktopFactsAnswer() : { ...DESKTOP_FACTS, cached: false } } catch { /* a closed session is still a session */ }
  }
  return DESKTOP_FACTS
}

/** The default healthy desktop, and the counters back to zero. */
export function resetDesktopFacts() {
  return setDesktopFacts({ ...DESKTOP_FACTS_DEFAULT })
}

/** The one answer both `desktopFacts()` and `refreshDesktopFacts()` return. */
function desktopFactsAnswer() {
  if (DESKTOP_FACTS === null) {
    const unknown = {}
    for (const field of DESKTOP_FACT_FIELDS) unknown[field] = null
    return {
      measured: false,
      at: null,
      stale: false,
      source: 'none',
      cached: false,
      ...unknown,
      error: 'fake-win-mcp: the guest has no desktop facts file'
    }
  }
  return { ...DESKTOP_FACTS, stale: DESKTOP_FACTS.stale === true, cached: false }
}

/**
 * WP-4.1's MODULE-LEVEL READER, SHADOWED ON PURPOSE (WP-6.1).
 *
 * `index.js` resolves the reader through the MODULE namespace
 * (`winMcpApi.desktopFacts`) and calls it with the target's ssh options — that
 * is the production seam, and it is the right one: the doctor must work before a
 * client exists. A fixture that only defined the CLIENT method would therefore
 * be invisible to the exact path under test, and the checks would read whatever
 * `ssh` answered on the build host (nothing) instead of the contract.
 *
 * An EXPLICIT local export wins over `export *` from the real module, so this
 * one line is what makes the desktop facts testable without a guest. It answers
 * the same knob as the client methods, and it counts reads the same way.
 */
export async function desktopFacts() {
  desktopFactCalls.reads += 1
  return desktopFactsAnswer()
}

/* ------------------------------------------------------------------ *
 * THE SPAWN SEAM (§WP-2.4)
 *
 * The real client accepts `spawnImpl` so a unit test can feed it fake ssh
 * children. The fake client honours the same option: when it is supplied, ONE
 * child is created per probe, the child's stdout is read for a `RELAY_*` token,
 * and that token wins over the knob. Without it the probe is answered from the
 * knob (deterministic, no child, no timer).
 * ------------------------------------------------------------------ */
function probeArgv(options, port) {
  return [...realSshArgv({
    host: options.host ?? '127.0.0.1',
    port: options.sshPort ?? 22,
    user: options.user ?? 'cua',
    keyPath: options.keyPath
  }), `py -3 -c <base64 handshake program> --port ${port}`]
}

/** Read at most `ms` of a child's stdout, then give up (the fake never hangs). */
function readChild(child, ms = 750) {
  return new Promise((resolve) => {
    let text = ''
    let settled = false
    const done = () => { if (!settled) { settled = true; resolve(text) } }
    try {
      child?.stdout?.setEncoding?.('utf8')
      child?.stdout?.on?.('data', (chunk) => { text += String(chunk) })
      child?.stdout?.on?.('end', done)
      child?.on?.('close', done)
      child?.on?.('exit', done)
      child?.on?.('error', done)
    } catch { /* a stub that is not an EventEmitter: fall through to the timer */ }
    setTimeout(done, ms).unref?.()
  })
}

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
    lastError: '',
    // WP-4.3/WP-5.1: the KIND beside the text — `ssh-closed | auth | handshake |
    // unknown`, `null` when nothing failed. Additive: `lastError` keeps its text.
    lastFailureKind: null,
    // WP-4.1/5.9: the last desktop-facts read, or null until one ran.
    desktop: null,
    // THE LANE SURFACE (SOL §4.3/§4.10) — null until an attach decided it.
    transport: null,
    relayOk: null,
    relayStatus: null,
    relayPort: realWinMcp.relayPort?.() ?? PORT_DEFAULT,
    probeMode: null,
    relayDetail: '',
    interpreter: null,
    transportCommand: null,
    transportReason: '',
    // The real client's state says `reason`, not `transportReason`; both are kept
    // so a test can read either without inventing a field the guest never had.
    reason: '',
    lastUpgradeAttemptAt: 0,
    repair: null,
    payload: null
  }
  /** The lane this client last recorded (kept after `close()` so a test can read it). */
  let lastRepairAt = 0
  let repaired = 0
  /** §2.5 in-flight guard: two poll beats must never repair twice. */
  let repairInFlight = null

  /** Apply the configured lane to this client — the attach's verdict. */
  const decideLane = () => {
    const lane = LANE
    const port = lane.port ?? state.relayPort
    state.relayPort = port
    state.transport = lane.lane
    state.relayOk = lane.relayOk
    state.relayStatus = lane.relayStatus
    state.probeMode = lane.probeMode
    state.relayDetail = lane.relayDetail ?? ''
    state.interpreter = lane.interpreter ?? null
    state.transportReason = lane.lane === 'interactive-relay'
      ? ''
      : (lane.reason || (lane.lane === 'session-0-direct' ? FALLBACK_REASON_DOWN : ''))
    state.reason = state.transportReason
    state.transportCommand = lane.lane === 'interactive-relay'
      ? `${lane.interpreter ?? 'py -3'} ${RELAY_SCRIPT} --connect`
      : (lane.lane === null ? null : `python -m dsh_cua.server --stdio`)
    state.payload = { relayHash: FIXTURE_RELAY_HASH, skew: lane.relayStatus === TOKEN_SKEW }
  }

  /** One probe, through `options.spawnImpl` when the test supplied the seam. */
  const probe = async () => {
    counters.probeCalls += 1
    if (typeof options.spawnImpl !== 'function') return null
    counters.spawnCalls += 1
    const child = options.spawnImpl(probeArgv(options, state.relayPort), { stdio: ['pipe', 'pipe', 'pipe'] })
    const text = await readChild(child)
    const token = [TOKEN_OK, TOKEN_BAD, TOKEN_DOWN, TOKEN_SKEW].find((candidate) => text.includes(candidate)) ?? null
    if (token === TOKEN_OK) {
      state.transport = 'interactive-relay'
      state.relayOk = true
      state.relayStatus = TOKEN_OK
      state.transportReason = ''
    } else if (token !== null) {
      state.transport = 'session-0-direct'
      state.relayOk = false
      state.relayStatus = token
      state.transportReason = token === TOKEN_SKEW ? FALLBACK_REASON_SKEW : FALLBACK_REASON_DOWN
    }
    return token
  }

  const session = {
    name: options.name,
    state,
    calls: [],
    options,
    spawnImpl: options.spawnImpl,
    async connect() {
      // HELD FOR THE INTERLEAVING CASE, before anything observes the guest.
      if (CONNECT_GATE !== null) await CONNECT_GATE.promise
      const online = await options.isOnline?.()
      if (online === false) {
        const error = new Error('the Windows computer is not online; start it or pick another target')
        error.code = 'vm-offline'
        throw error
      }
      counters.connects += 1
      // THE ATTACH PROBES THE LANE FIRST — that is the whole P0 lesson: a lane is
      // decided by a handshake, never assumed.
      const token = await probe()
      if (token === null) decideLane()
      state.connected = true
      state.online = true
      state.tools = GUEST_TOOLS
      return { serverInfo: state.serverInfo, tools: GUEST_TOOLS, transport: state.transport, relayOk: state.relayOk }
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
    /**
     * THE ZERO-SSH FACTS (WP-2.7): synchronous, side-effect free, and the SAME
     * shape for the module-level helper. Before an attach there is no lane and
     * the answer is null — never a guess.
     */
    doctorFacts() {
      return {
        transport: state.transport,
        relayOk: state.relayOk,
        relayStatus: state.relayStatus,
        transportCommand: state.transportCommand,
        transportReason: state.transportReason,
        relayPort: state.relayPort,
        probeMode: state.probeMode,
        relayDetail: state.relayDetail,
        interpreter: state.interpreter,
        // WP-4.3/4.5: the two additive facts the real `doctorFacts()` carries.
        lastFailureKind: state.lastFailureKind,
        repair: state.repair,
        payload: state.payload
      }
    },
    /**
     * WP-4.1/5.6/5.9 — THE GUEST'S OWN DESKTOP FACTS.
     *
     * The real client has THREE names for one read (`desktopFacts`,
     * `refreshDesktopFacts`, the synchronous `desktopFactsCached`), because
     * `index.js` may call any of them depending on the path: the doctor awaits
     * one, the post-attach nudge fires one, and `windows_desktop` returns the
     * cache without blocking. The fixture answers all three from the same knob,
     * so the plugin cannot pass here by calling a method the real client lacks.
     */
    async desktopFacts() {
      desktopFactCalls.reads += 1
      return desktopFactsAnswer()
    },
    async refreshDesktopFacts() {
      desktopFactCalls.refreshes += 1
      const facts = desktopFactsAnswer()
      state.desktop = facts
      return facts
    },
    desktopFactsCached() {
      return state.desktop ?? null
    },
    /**
     * THE REPAIR VERB (§4.4): throttled, never throws, returns the parsed record.
     * `force` bypasses the window (the doctor's `{ repair: true }` argument).
     * The kill switch is the documented one, and it SPENDS NO CHILD.
     */
    async repairRelay({ force = false } = {}) {
      // §2.5: ONE attempt in flight, ever. The second caller waits for the first.
      if (repairInFlight !== null) return repairInFlight
      if (process.env.DSH_CUA_VM_WIN_MCP_REPAIR === '0') {
        // NO CHILD, NO MEASUREMENT: the kill switch answers "not asked".
        return unmeasuredRecord(UNMEASURED.REPAIR_DISABLED, { disabled: true, port: state.relayPort })
      }
      const now = Date.now() + CLOCK_SKEW_MS
      if (!force && state.repair !== null && now - lastRepairAt < REPAIR_THROTTLE_MS) {
        // THROTTLED IS NOT A RESULT: it re-states nothing about the guest.
        return unmeasuredRecord(UNMEASURED.THROTTLED, { throttled: true, port: state.relayPort })
      }
      repairInFlight = (async () => {
        lastRepairAt = now
        repaired += 1
        counters.repairCalls += 1
        const record = normaliseRecord(REPAIR_RESULT)
        state.repair = record
        if (record?.ok === true) {
          // An `ok=1` record IS the lane healing (§4.4 + Appendix B).
          LANE = {
            ...LANE,
            lane: 'interactive-relay',
            relayOk: true,
            relayStatus: TOKEN_OK,
            probeMode: 'handshake',
            relayDetail: '',
            reason: '',
            port: record.port ?? state.relayPort
          }
          state.transport = 'interactive-relay'
          state.relayOk = true
          state.relayStatus = TOKEN_OK
          state.relayPort = record.port ?? state.relayPort
          state.probeMode = 'handshake'
          state.transportReason = ''
          state.transportCommand = `${LANE.interpreter ?? 'py -3'} ${RELAY_SCRIPT} --connect`
        }
        return state.repair
      })()
      try {
        return await repairInFlight
      } finally {
        repairInFlight = null
      }
    },
    /**
     * §2.6 — the upgrade path: blind lane ⇒ one repair, one forced re-probe, then
     * upgrade. Re-checks the lane after EVERY await, exactly like the real one.
     */
    async maybeUpgradeTransport() {
      if (state.connected !== true) return { upgraded: false, reason: 'not-connected' }
      if (state.transport === 'interactive-relay') return { upgraded: false, reason: 'already-relay' }
      await probe()
      if (state.connected !== true) return { upgraded: false, reason: 'closed' }
      if (state.transport === 'interactive-relay') return { upgraded: true, reason: 'reprobe' }
      const record = await this.repairRelay({})
      await probe()
      if (state.connected !== true) return { upgraded: false, reason: 'closed' }
      if (record?.ok === true && state.transport === 'interactive-relay') {
        return { upgraded: true, reason: 'repair', repair: record }
      }
      return { upgraded: false, reason: record?.reason || state.transportReason || 'relay-stopped', repair: record }
    },
    /** How many repairs this client really performed (the per-window counter). */
    repairs() { return repaired },
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
