import net, { createConnection } from 'node:net'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  createDshCuaClient,
  windowsMcpEnabled,
  TOOL_PREFIX,
  REVEAL_TOOL_NAME,
  DOCTOR_TOOL_NAME,
  windowsToolName,
  windowsGuestToolName,
  sshArgv,
  mcpError
} from './win-mcp.js'

export const name = 'cua-vm'
export const inject = ['tools', 'systemPrompt', 'webServer']

/**
 * The VM store lives outside the workspace; the socket lives in /tmp, which is
 * the only other path `workspace-write` grants. Nothing here opens /dev/kvm —
 * the supervisor does that, before any session exists.
 */
export const Config = z.object({
  socketPath: z.string().min(1).default('/tmp/cua-vm/supervisor.sock').description(
    'Unix socket of the cua-vm-supervisor started by the container entrypoint.'
  ),
  workspaceRoot: z.string().min(1).default('/workspace').description(
    'The only host tree the VM tools may read or write. Paths outside it are refused by the supervisor.'
  ),
  defaultTier: z.string().min(1).default('slim').description('Image tier used by vm_ensure when the model does not name one.'),
  defaultCpu: z.number().step(1).min(1).max(16).default(2),
  defaultMemory: z.number().step(1).min(1).max(64).default(4),
  maxOutputChars: z.number().step(1).min(512).max(200000).default(8000)
})

/**
 * The SOCKET default: how long one supervisor request may stay unanswered. It
 * is deliberately far above every tool envelope below — it is the transport's
 * own backstop, NOT the tool's budget, and treating it as the budget is exactly
 * the bug `TOOL_TIMEOUTS` exists to prevent.
 */
const TOOL_TIMEOUT_MS = 1_800_000

/* ==================================================================== *
 * THE TOOL-LEVEL TIMEOUT ENVELOPE (tool-timeout lane)
 * ==================================================================== *
 *
 * THE PRODUCTION INCIDENT THIS FIXES. A `cua_vm_shutdown` tool call hung for
 * ever: the supervisor op was sitting in a synchronous `qemu-img convert` for
 * minutes, the harness had no per-tool deadline for it, the socket default
 * above is THIRTY MINUTES, and the chat abort could not unwind the call either
 * — the user had to force-restart the harness. Whatever the supervisor does,
 * the TOOL layer must settle and SAY what happened.
 *
 * TWO LAYERS, BECAUSE ONE IS NOT ENOUGH.
 *   * `timeoutMs` on the registered definition is the DECLARED budget the
 *     harness timeout guard (`@deepseek-ai/dsh-tool-call-timeout-policy`) reads.
 *     That guard is COOPERATIVE: it arms a deadline, aborts `exec.signal`, and
 *     then awaits the body ("without racing or abandoning the tool promise").
 *     A body blocked in `await request(...)` on a dead supervisor never observes
 *     the signal, so the declared number alone cannot free a hung chat.
 *   * So each body is ALSO raced against its own deadline here
 *     (`boundedExecute`) and RETURNS a structured `tool-timeout` failure. That
 *     race is the one that actually settles the call.
 *
 * The race fires `TIMEOUT_LEAD_MS` before the declared budget on purpose: the
 * guard arms its timer at dispatch entry, this one arms a few microseconds
 * later inside the body, so equal budgets would let the guard's generic
 * `tool call timed out after Nms` replace the message below. The lead keeps the
 * specific, actionable sentence (and `code: tool-timeout`) in front of the
 * model, which is the whole point of the failure.
 *
 * HOW EACH NUMBER WAS CHOSEN — one line of evidence each:
 *   * status / doctor / gc / disk / port — ONE supervisor socket round trip and
 *     no guest work (`status` may add one `vmWindowsStatus` per installing
 *     Windows row), so 30 s is already far above the healthy latency.
 *   * start / suspend / shutdown / destroy — a lifecycle op, 60 s. These are the
 *     ones that wedge in QEMU/QMP or in `qemu-img`; failing fast and saying "the
 *     supervisor op may still be running" is the intended behaviour.
 *   * put / get — a file copy over the 9p share / scp; 120 s for a large
 *     artifact, still bounded.
 *   * gui — a screenshot or one input event; 120 s covers `launch`/`open`
 *     booting an application inside the guest.
 *   * exec — its budget is the CALLER'S `timeout` argument (default 300 s, max
 *     3600 s), so the live deadline is resolved per call (`PER_CALL_TIMEOUTS`)
 *     and the number here is only the ceiling the harness guard may arm.
 *   * create / ensure — the supervisor's own allowances, verified by reading it:
 *     `createLinuxNow` awaits `cua sb create` with `timeoutMs: 1500000` and then
 *     provisions the guest (REA up to 3_900_000 ms, Android up to 3_300_000 ms),
 *     and `ensure` may rebuild the computer exactly the same way. A Linux create
 *     is therefore SYNCHRONOUS for minutes: 60 s here would fail every real
 *     first create, so Linux create/ensure get 30 min. A WINDOWS create answers
 *     while the install keeps running in the background (`state: installing`),
 *     so its per-call envelope is 60 s — see `PER_CALL_TIMEOUTS`.
 *   * android — `provisionAndroidGuest` runs a ~7 GB SDK download with a
 *     3_300_000 ms allowance; the envelope is that allowance plus a minute.
 *   * windows_desktop / windows_mcp_doctor — the two ungated helpers. They are
 *     not `cua_vm_*`, but they are registered here and the doctor awaits a
 *     supervisor probe (which is the same hang class), so they take the same
 *     rule: reveal is pure memory (30 s), the doctor may trigger an attach
 *     (60 s, just over the bridge's own 45 s handshake).
 *
 * The dynamically bridged guest tools (`mcp__windows__*`) are NOT in this map:
 * they are registered per attach and already declare
 * `timeoutMs: WIN_MCP_ATTACH_TIMEOUT_MS` where they are built.
 */
const TOOL_TIMEOUTS = Object.freeze({
  // the two ungated helpers (not `cua_vm_*`, same rule)
  windows_desktop: 30_000,
  windows_mcp_doctor: 60_000,
  // one supervisor round trip, no guest work
  cua_vm_status: 30_000,
  cua_vm_doctor: 30_000,
  cua_vm_gc: 30_000,
  cua_vm_disk: 30_000,
  cua_vm_port: 30_000,
  // lifecycle ops: the ones that can wedge in QEMU/QMP/qemu-img
  cua_vm_start: 60_000,
  cua_vm_suspend: 60_000,
  cua_vm_shutdown: 60_000,
  cua_vm_destroy: 60_000,
  // file transfer
  cua_vm_put: 120_000,
  cua_vm_get: 120_000,
  // desktop driving
  cua_vm_gui: 120_000,
  // caller-budgeted: the CEILING only (the live deadline is per call)
  cua_vm_exec: 3_660_000,
  // legitimately multi-minute supervisor ops (evidence in the comment above)
  cua_vm_create: 1_800_000,
  cua_vm_ensure: 1_800_000,
  cua_vm_android: 3_360_000
})

/**
 * How much earlier than the declared budget the body-level race expires, so the
 * specific `tool-timeout` sentence wins over the harness guard's generic
 * `tool call timed out after Nms`. 250 ms is ~50× the gap between "dispatcher
 * arms its timer" and "body arms its timer", and it is not a behaviour change:
 * the envelope is still the declared number, rounded down by a quarter second.
 */
const TIMEOUT_LEAD_MS = 250

/** `cua_vm_exec` stops the command in the GUEST at `timeout` s; the supervisor
 * allows 30 s on top of it. The envelope gives the same budget plus a minute, so
 * a legal long exec is never cut by the tool layer. */
const EXEC_ENVELOPE_GRACE_MS = 60_000

/**
 * The two tools whose legitimate duration is an ARGUMENT, not a constant. Each
 * resolver returns the live deadline; the registered `TOOL_TIMEOUTS` entry stays
 * the ceiling the harness guard may arm, and `boundedExecute` takes the smaller
 * of the two.
 */
const PER_CALL_TIMEOUTS = Object.freeze({
  // default 300 s, max 3600 s — the same clamp the tool schema declares.
  cua_vm_exec: (args) => (Math.min(3600, Math.max(1, Number(args?.timeout) || 300)) * 1000) + EXEC_ENVELOPE_GRACE_MS,
  // A Windows create RETURNS while the install proceeds in the background; a
  // Linux create is synchronous in the supervisor and keeps the 30 min ceiling.
  cua_vm_create: (args) => (args?.kind === 'windows' ? 60_000 : TOOL_TIMEOUTS.cua_vm_create)
})

/** `seconds` as a short human number: `60000` → `60`, `360000` → `360`. */
function timeoutLabel(timeoutMs) {
  return Number.isInteger(timeoutMs / 1000) ? String(timeoutMs / 1000) : `${timeoutMs / 1000}`
}

/**
 * The structured failure every envelope returns. It is thrown, so the harness
 * records the call as `isError` with this message, and `.code` carries the
 * machine-routable class the way `mcpError` does elsewhere in this plugin. The
 * `code:` line is repeated in the text because the harness error payload does
 * not hand `code` to the model.
 */
function toolTimeoutError(toolName, timeoutMs) {
  const message = `${toolName} timed out after ${timeoutLabel(timeoutMs)}s; the supervisor op may still be running — check the panel/registry before retrying\ncode: tool-timeout`
  const error = new Error(message)
  error.name = 'ToolTimeoutError'
  error.code = 'tool-timeout'
  error.toolName = toolName
  error.timeoutMs = timeoutMs
  return error
}

/**
 * Wrap ONE tool body in its envelope. Never races the body away silently: the
 * losing body keeps running to quiescence (Promise.race subscribes to both, so a
 * late rejection is not an unhandled one), which is what lets the supervisor
 * finish its `qemu-img` work; the CALL is what settles.
 */
function boundedExecute(toolName, declaredMs, resolveMs, execute) {
  return async function boundedToolExecute(args, exec) {
    const envelopeMs = resolveMs === undefined ? declaredMs : Math.min(declaredMs, resolveMs(args))
    let timer
    const expiry = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(toolTimeoutError(toolName, envelopeMs)), Math.max(1, envelopeMs - TIMEOUT_LEAD_MS))
      timer.unref?.()
    })
    try {
      // start the body on a microtask so a synchronous throw settles as a
      // rejection of the race instead of escaping before it is armed
      return await Promise.race([Promise.resolve().then(() => execute(args, exec)), expiry])
    } finally {
      clearTimeout(timer)
    }
  }
}

/** One request per connection: write a JSON line, read a JSON line. */
function request(socketPath, payload, timeoutMs = TOOL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    let buffer = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error(`cua-vm supervisor did not answer within ${timeoutMs} ms`)), timeoutMs)
    timer.unref?.()

    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.includes('\n')) {
        try {
          const answer = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
          if (answer.ok) finish(resolve, answer)
          else finish(reject, new Error(answer.error || 'cua-vm supervisor refused the request'))
        } catch (error) {
          finish(reject, error)
        }
      }
    })
    socket.on('error', (error) => finish(reject, error))
    socket.on('close', () => {
      if (!settled) finish(reject, new Error('cua-vm supervisor closed the connection without an answer'))
    })
  })
}

function clamp(text, limit) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n… [truncated ${value.length - limit} chars]`
}

const textOutput = (description) => ({
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      text: { type: 'string', description }
    },
    required: ['text']
  },
  render: (_args, value) => [{ type: 'text', text: value.text }]
})

/* ==================================================================== *
 * WP-5 — THE WINDOWS dsh-cua BRIDGE IS PROCESS STATE, NOT PLUGIN STATE
 * ==================================================================== *
 *
 * THE BUG THIS REPLACES
 * ---------------------
 * The bridge used to be `const WIN_MCP = {...}` INSIDE apply(), i.e. one copy
 * per mounted plugin, while the tools it registered live on the HOST-GLOBAL
 * `ctx.tools.register`. Its only teardown was a 5 s heartbeat inside the same
 * apply(). Two consequences, both visible to the model:
 *
 *   1. a VM deleted from the panel still left ~19 `mcp__windows__*` schemas in
 *      EVERY session's tool list until the next beat — dead names that cost
 *      context and answer "connection refused";
 *   2. the heartbeat is per-apply, so a session created from a different ctx
 *      (or a reloaded plugin) could not take the names down at all, and a
 *      second attach raced itself into two SSH sessions.
 *
 * The fix is four layers, and every one of them is in THIS file's process, not
 * in the plugin instance:
 *
 *   (1) WIN_MCP, module level, so every apply() and every session shares one
 *       view of "is the bridge up, and which names does it own".
 *   (2) Registration/disposal by HAND (`registrations: Map<name, dispose>`),
 *       not by `ctx.effect`'s return value: an effect unwinds with ITS ctx, and
 *       the names are global. teardown() can therefore be called from the state
 *       poll, from the client's own exit, from a plugin dispose, or from a
 *       per-agent pre-step self-heal, and always removes exactly the names it
 *       registered.
 *   (3) A PER-AGENT DUAL GATE: `restrict({deny})` hides the names from an agent
 *       that has not passed the grant+reveal gate, and `tools.guard` vetoes the
 *       call at dispatch time with a structured refusal — so a name that is
 *       still visible (a race, a cached step admission) is REFUSED, never run.
 *   (4) A reveal (`windows_desktop`) and a doctor (`windows_mcp_doctor`) that
 *       can PROVE the leak surface: `windows_mcp_doctor` reports every global
 *       schema under TOOL_PREFIX, and offline that list MUST be empty.
 *
 * COST CONTROL still applies: the guest's schema is ~3-8k tokens, so nothing is
 * attached unless a Windows computer is bound to a session AND online, and the
 * revealed tools stay hidden (restricted) until the model asks for the desktop.
 */
const WIN_MCP = {
  /** The computer whose guest MCP server is attached ('' when none). */
  name: '',
  /** The live SSH+MCP client (null when none). */
  client: null,
  /** True only while a handshake has completed AND the poll agrees. */
  online: false,
  /** The in-flight attach promise, so two beats never open two SSH sessions. */
  inflight: null,
  /**
   * THE ATTACH GENERATION (J20-4). Bumped by every `teardown()`, and read by
   * the attach that is currently in flight: an attach that crosses a teardown
   * (`await client.connect()` is 45 s wide) MUST NOT register a single name
   * afterwards. The bump is name-independent, so a delete that arrives while
   * the target is still unnamed (WIN_MCP.name === '') is covered too.
   */
  generation: 0,
  /** publicName -> the exact disposer ctx.tools.register() handed back. */
  registrations: new Map(),
  /** agent -> whether that agent has revealed the desktop. Memory only. */
  reveals: new WeakMap(),
  /** Every live agent whose tool view this registry gates. */
  agents: new Set(),
  /** The last structured failure, as `code: message`. */
  lastError: '',
  /** Why the bridge is in its current state, in words a human can read. */
  reason: 'not attempted'
}

/**
 * The bookkeeping the literal above cannot express, kept separate so the
 * contract object stays readable. Everything here is memory-only as well: no
 * grant, no reveal and no binding is ever written to disk or to the profile.
 */
const WIN_MCP_AUX = {
  /** The plugin ctx that owns the global tool registry (set by apply()). */
  ctx: undefined,
  /** The supervisor socket call (set by apply()). */
  supervisorCall: undefined,
  /** agent -> { handle, key } — the ONE active restriction per agent. */
  gates: new Map(),
  /** agent -> the inject fiber that installed that agent's guard. */
  fibers: new Map(),
  /** sessionId -> grant boolean. */
  grants: new Map(),
  /**
   * THE GRANT A NEW SESSION STARTS WITH: ON (and the off switch is unchanged).
   *
   * RATIONALE. This grant is a per-session, IN-MEMORY SAFETY DEFAULT, not a
   * security boundary: what actually guards the desktop is everything behind it
   * — the same-origin page API, the SSH-only guest bridge, the per-agent
   * `restrict` + `guard` veto, and the target binding that says a session may
   * only drive the computer it bound. The grant only decides whether a fresh
   * session must make one extra manual round trip before it may click.
   *
   * Shipping it OFF meant EVERY first-boot test failed on a step nobody had
   * taken yet: the bridge attached, the tools stayed hidden, and the session
   * looked broken until a human found the panel switch. Auto-on removes that
   * manual step and nothing else.
   *
   * Denying is still explicit and still works exactly as it did: the panel
   * toggle or `POST /dsh-cua-vm/cua-grant {"grant":false}` (optionally with a
   * `sessionId`) flips this off, `grant-off` stays a real refusal code, and a
   * restart forgets all of it because nothing here is persisted.
   */
  grantDefault: true,
  /** sessionIds that have revealed the desktop (for the doctor). */
  revealedSessions: new Set(),
  /** sessionId -> { name, at }: the computer a session asked for. */
  targets: new Map(),
  /** The target record the attached client was opened against. */
  target: null,
  /** [{ name, description, parameters }] of the attached guest tools. */
  tools: [],
  /** When the isOnline() answer was last refreshed. */
  onlineCheckedAt: 0,
  /**
   * THE LAST LIVENESS PROBE'S ANSWER — DIAGNOSTIC DETAIL, NEVER A VERDICT.
   * `{ at, online, state, name }`. This is what the doctor reports as
   * `probeAgeMs` / `probe.*`; it may NEVER put `online: true` over the plugin's
   * own state. The bug it exists for: the supervisor probe kept answering with
   * the last handshake it had seen, so during the shutdown window a doctor that
   * merged probe facts over the (fresher) registry/stream said `online: true /
   * state: ready / 19 tools` for seconds after the computer was gone.
   */
  probe: { at: 0, online: null, state: '', name: '' },
  /**
   * What the SUPERVISOR said about the bound computer on the last probe.
   *
   * `isOnline` cannot mean "we are already attached": the initial handshake
   * happens exactly once, BEFORE WIN_MCP.online is set, so answering from
   * `WIN_MCP.online` made the first connect fail with its own vm-offline. The
   * bridge asks "is the computer reachable", and the state probe is who knows.
   */
  targetOnline: false,
  /** Do not re-dial SSH before this instant (a failed attach is not a loop). */
  retryAt: 0,
  /** When a bind last triggered a probe, so a Linux exec cannot become a poll. */
  lastBindSyncAt: 0,
  /** A coalescing handle for the tools/change reapply. */
  gateTimer: null,
  /** The last gate installation failure (restrict/guard), for the doctor. */
  gateError: '',
  /**
   * THE IN-FLIGHT ATTACH TICKET (J20-4): `{ generation, name, dead, at }`.
   * Held by name-independent module state so `teardown()` can kill an attach
   * whose target has not been adopted yet (`WIN_MCP.name` is still '').
   */
  inflightTicket: null,
  /**
   * Every Windows computer the supervisor's registry has shown us, refreshed by
   * the same 30 s `vmList` that keeps the REA cache warm. It exists for ONE
   * honest relaxation: "exactly one Windows computer exists and this session
   * never bound anything" may use the bridge, and says so in the doctor.
   */
  windowsRegistryNames: [],
  /** sessionIds that were let through by the 'implicit-single-target' rule. */
  implicitTargets: new Set()
}

/**
 * THE STATE STREAM (J20-3). One long-lived unix-socket subscription, the same
 * socket and framing the ops channel uses:
 *
 *   → {"op":"subscribe","events":["vm-state","vm-removed"]}
 *   ← {"event":"ready","events":[…]}
 *   ← {"event":"vm-state","name":"…","state":"…"}
 *   ← {"event":"vm-removed","name":"…"}
 *
 * A supervisor without the op answers `unknown op` (or closes without a
 * `ready`), and this client then stops asking and leaves the 10 s poll to do
 * the job — exactly the behaviour before this change. The poll keeps running
 * either way.
 */
const WIN_MCP_STREAM = {
  /** The live subscription socket, or null. */
  socket: null,
  /** The partially received line. */
  buffer: '',
  /** The pending reconnect timer (unref'd), or null. */
  retryTimer: null,
  /** Current backoff; 0 while the stream is live. */
  retryMs: 0,
  /** Consecutive attempts that never reached `ready`. */
  attempts: 0,
  /** True between `ready` and the socket closing. */
  live: false,
  /** null = unknown, true = the supervisor speaks subscribe, false = it does not. */
  supported: null,
  /** Set by the plugin dispose, so the retry chain stops for good. */
  closed: false,
  /** The coalescing timer for a state-event burst, or null. */
  syncTimer: null,
  /** The socket path, remembered for the reconnect. */
  socketPath: '',
  /** When `ready` last arrived / when an event last arrived. */
  readyAt: 0,
  lastEventAt: 0,
  /** The last event, as `event:name:state` — the doctor prints it. */
  lastEvent: '',
  /**
   * THE NEWEST STATES THIS PLUGIN HAS SEEN (`[{ name, state, at }]`, newest
   * last, capped at 8): the supervisor's own `vm-state` events, plus one
   * `ready` when an attach completed. The doctor prefers these over any probe
   * answer: an event is first-hand news, a probe is a round trip that can still
   * be answering from the handshake it saw a moment ago.
   */
  stateLog: [],
  /** How many state events this plugin consumed (proves the stream works). */
  events: 0,
  /** Why the stream is not live, in words the doctor can print. */
  error: ''
}

/** The state poll: 10 s, so a delete/shutdown cannot outlive a turn boundary. */
const WIN_MCP_DEFAULT_POLL_MS = 10_000
/** The isOnline() cache `callTool` re-checks against (win-mcp asks per call). */
const WIN_MCP_ONLINE_TTL_MS = 10_000
/** The guest handshake budget — kept at 45 s, as the design requires. */
const WIN_MCP_ATTACH_TIMEOUT_MS = 45_000
/** After a failed attach, wait this long before dialling again. */
const WIN_MCP_RETRY_MS = 30_000
/** What the SSH channel is configured with, reported by the doctor. */
const WIN_MCP_KEEPALIVE = Object.freeze({ interval: 10, countMax: 2 })

/**
 * PROBE AGE, NOT PROBE TRUTH. Past this, a cached probe answer is reported as
 * `stale` while the bridge is not online — the shutdown window is seconds wide,
 * so "the handshake answered five seconds ago" is not evidence about now.
 */
const WIN_MCP_PROBE_STALE_MS = 5000

/**
 * THE STATES THAT MEAN "no SSH session can be taken right now". A `vm-state`
 * event carrying one of these is a not-online verdict the doctor must not
 * argue with (the guest's own row says so, and the handshake is about to die).
 */
const WIN_MCP_NOT_ONLINE_STATES = new Set([
  'powering-off', 'powered-off', 'shutting-down', 'shutdown', 'stopping',
  'stopped', 'suspended', 'paused', 'installing', 'creating', 'deleting',
  'absent', 'removed', 'error'
])

/** `DSH_CUA_MCP_STATE_POLL_MS`, read at call time so a test can shrink it. */
function windowsMcpPollMs() {
  const raw = Number(process.env.DSH_CUA_MCP_STATE_POLL_MS ?? '')
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : WIN_MCP_DEFAULT_POLL_MS
}

/** Hand the module-level registry its host ctx and its socket call. */
function bindWindowsMcpHost(ctx, supervisorCall) {
  WIN_MCP_AUX.ctx = ctx
  WIN_MCP_AUX.supervisorCall = supervisorCall
}

/** The session id an agent belongs to; '' when the agent is not addressable. */
function sessionKeyOf(agent) {
  const id = agent?.id ?? agent?.session?.id ?? agent?.sessionId
  return id === undefined || id === null ? '' : String(id)
}

/** The Computer Use grant of one agent's session (default ON, see WIN_MCP_AUX). */
function grantFor(agent) {
  const key = sessionKeyOf(agent)
  if (WIN_MCP_AUX.grants.has(key)) return WIN_MCP_AUX.grants.get(key) === true
  return WIN_MCP_AUX.grantDefault === true
}

/** Whether this agent has asked for the desktop (the reveal gate). */
function revealedFor(agent) {
  if (agent === undefined || agent === null) return false
  return WIN_MCP.reveals.get(agent) === true
}

/**
 * CROSS-SESSION TARGETING (J20-5).
 *
 * One process, one attached Windows computer, MANY sessions. The attach itself
 * is a global resource (one SSH session, one set of guest tools), so it is
 * resolved from the most recent binding — but the TOOLS may only be used by the
 * session that bound THAT computer. Without this, session B (which never named
 * a computer) clicked on session A's Windows desktop, because the guard only
 * asked "is the grant on for you" and never "is that machine yours".
 *
 * The rule, in order:
 *   1. the executing agent's session has a binding → it must be the attached
 *      name, else `not-the-target`;
 *   2. the session has NO binding → denied, with the same code (the honest
 *      behaviour the README claims), EXCEPT the one explicit relaxation below;
 *   3. `implicit-single-target`: when exactly ONE Windows computer is known to
 *      the bridge and this session never bound anything, it may use it, and the
 *      doctor says so. A second computer withdraws the allowance.
 */
function boundTargetOf(agent) {
  const key = sessionKeyOf(agent)
  if (key === '') return null
  const row = WIN_MCP_AUX.targets.get(key)
  return row === undefined || row === null ? null : row
}

/**
 * How many Windows computers EXIST — the supervisor's registry is the truth,
 * and the attached one always counts (a row that answered a state probe exists,
 * whatever a 30 s-old snapshot says). Only when the registry has never been
 * read (or an older supervisor answers no registry at all) do the session
 * bindings stand in for it, because then they are the only evidence there is.
 */
function knownWindowsComputers() {
  const names = new Set(WIN_MCP_AUX.windowsRegistryNames)
  if (WIN_MCP.name !== '') names.add(WIN_MCP.name)
  if (names.size === 0) {
    for (const row of WIN_MCP_AUX.targets.values()) if (row?.name) names.add(String(row.name))
  }
  return [...names]
}

/**
 * Does the executing agent's session own the attached computer?
 * Answers `{ ok: true, via }` or `{ ok: false, code, text }` — never throws, so
 * both the restrict() gate and the dispatch guard can call it.
 */
function targetMatchFor(agent) {
  const attached = WIN_MCP.name
  if (attached === '') {
    return { ok: false, code: 'not-the-target', bound: null, attached: '', text: 'no Windows computer is attached to this bridge right now' }
  }
  const row = boundTargetOf(agent)
  if (row !== null) {
    if (row.name === attached) return { ok: true, via: 'binding', bound: row.name, attached }
    return {
      ok: false,
      code: 'not-the-target',
      bound: row.name,
      attached,
      text: `this session is bound to ${row.name}; the Windows bridge is attached to ${attached}; bind this session first`
    }
  }
  const key = sessionKeyOf(agent)
  const known = knownWindowsComputers()
  if (known.length === 1 && known[0] === attached) {
    // The declared relaxation, recorded rather than silent: one computer, and
    // this session never said otherwise, so there is nothing to get wrong.
    if (key !== '') WIN_MCP_AUX.implicitTargets.add(key)
    return { ok: true, via: 'implicit-single-target', bound: null, attached }
  }
  return {
    ok: false,
    code: 'not-the-target',
    bound: null,
    attached,
    text: `this session is bound to nothing; the Windows bridge is attached to ${attached}; bind this session first (cua_vm_exec, cua_vm_gui or cua_vm_ensure on ${attached} binds it)`
  }
}

/**
 * Flip the grant, in memory, for one session or (no session id) for the whole
 * process and every session that has not overridden it.
 */
function setWindowsGrant(sessionId, granted) {
  const value = granted === true
  if (sessionId === undefined || sessionId === null || sessionId === '') {
    WIN_MCP_AUX.grantDefault = value
    WIN_MCP_AUX.grants.clear()
  } else {
    WIN_MCP_AUX.grants.set(String(sessionId), value)
  }
  reapplyWindowsGates('grant')
  return windowsGrantSnapshot()
}

/** What the grant route answers, so a UI and the model read the same facts. */
function windowsGrantSnapshot() {
  return {
    default: WIN_MCP_AUX.grantDefault === true ? 'on' : 'off',
    on: [...WIN_MCP_AUX.grants.entries()].filter(([, value]) => value === true).map(([key]) => key),
    off: [...WIN_MCP_AUX.grants.entries()].filter(([, value]) => value !== true).map(([key]) => key),
    sessions: WIN_MCP.agents.size,
    online: WIN_MCP.online === true,
    revealed: [...WIN_MCP_AUX.revealedSessions]
  }
}

/**
 * The names an agent must NOT see: every name this bridge owns, unless the
 * bridge is online AND that agent has the grant, the reveal AND owns the
 * attached computer. The target check is what makes a second session's tool
 * list honest: its names are hidden exactly like they were offline.
 */
function gateDenyList(agent) {
  const names = [...WIN_MCP.registrations.keys()]
  if (names.length === 0) return []
  const open = WIN_MCP.online === true
    && grantFor(agent) === true
    && revealedFor(agent) === true
    && targetMatchFor(agent).ok === true
  return open ? [] : names
}

/**
 * Apply (or lift) ONE agent's restriction, reusing the handle when the deny set
 * did not change. `restrict()` itself emits `tools/change`, so an unchanged key
 * MUST short-circuit or the listener re-enters for ever.
 */
function applyAgentGate(agent, reason = '') {
  if (agent === undefined || agent === null) return
  let tools
  try {
    tools = agent.ctx?.get?.('tools')
  } catch {
    tools = undefined
  }
  if (tools === undefined || tools === null) return
  const deny = gateDenyList(agent)
  const key = deny.join(',')
  const record = WIN_MCP_AUX.gates.get(agent) ?? { handle: null, key: null }
  if (record.key === key) {
    WIN_MCP_AUX.gates.set(agent, record)
    return
  }
  if (record.handle !== null) {
    try { record.handle() } catch { /* the layer may already be gone */ }
    record.handle = null
  }
  record.key = key
  if (deny.length > 0) {
    try {
      const handle = tools.restrict({ deny })
      record.handle = typeof handle === 'function' ? handle : null
    } catch (error) {
      // A name that was disposed between the snapshot and the call is not an
      // unknown tool any more: forget the key so the next beat retries cleanly.
      record.key = null
      WIN_MCP_AUX.gateError = `${reason || 'gate'}: ${error?.message ?? error}`
    }
  }
  WIN_MCP_AUX.gates.set(agent, record)
}

/** Re-gate every agent this registry knows (state transition, reveal, attach). */
function reapplyWindowsGates(reason = '') {
  for (const agent of [...WIN_MCP.agents]) {
    try { applyAgentGate(agent, reason) } catch (error) {
      WIN_MCP_AUX.gateError = `${reason || 'gate'}: ${error?.message ?? error}`
    }
  }
}

/** Coalesce a storm of tools/change emissions (19 registers) into one pass. */
function scheduleWindowsGates(reason = '') {
  if (WIN_MCP_AUX.gateTimer !== null) return
  WIN_MCP_AUX.gateTimer = setImmediate(() => {
    WIN_MCP_AUX.gateTimer = null
    reapplyWindowsGates(reason)
  })
  WIN_MCP_AUX.gateTimer.unref?.()
}

/** Install the per-agent guard once; the restriction is applied by the gate. */
function installWindowsAgent(agent) {
  if (agent === undefined || agent === null) return
  if (WIN_MCP.agents.has(agent)) return
  WIN_MCP.agents.add(agent)
  try {
    const fiber = agent.ctx.inject(['tools'], (scoped) => {
      // The guard reads LIVE module state at dispatch time, so an agent whose
      // gate was applied before the attach still vetoes the call afterwards.
      scoped.tools.guard((execution) => windowsGuardDecision(execution))
    })
    WIN_MCP_AUX.fibers.set(agent, fiber)
  } catch (error) {
    WIN_MCP_AUX.gateError = `guard install: ${error?.message ?? error}`
  }
  applyAgentGate(agent, 'agent-created')
}

/** Drop every trace of one agent: the guard fiber, the restriction, the reveal. */
function disposeWindowsAgent(agent) {
  if (agent === undefined || agent === null) return
  WIN_MCP.agents.delete(agent)
  const key = sessionKeyOf(agent)
  if (key !== '') {
    WIN_MCP_AUX.grants.delete(key)
    WIN_MCP_AUX.targets.delete(key)
    WIN_MCP_AUX.revealedSessions.delete(key)
  }
  const record = WIN_MCP_AUX.gates.get(agent)
  WIN_MCP_AUX.gates.delete(agent)
  if (record?.handle) {
    try { record.handle() } catch { /* already lifted */ }
  }
  const fiber = WIN_MCP_AUX.fibers.get(agent)
  WIN_MCP_AUX.fibers.delete(agent)
  if (fiber !== undefined) {
    try { void Promise.resolve(fiber.dispose()).catch(() => {}) } catch { /* already disposed */ }
  }
}

/**
 * THE DISPATCH VETO.
 *
 * A hidden tool that is still called (a step admission captured before the
 * attach, a name that survived a race) must be REFUSED with a reason the model
 * can branch on, and never run. The structured identity (`info.code`) is what
 * the D-plugin part reads back; the same code is also written into the reason
 * as a `code:` line so it survives into the tool output text the model sees.
 */
function windowsGuardDecision(execution) {
  const toolName = typeof execution?.name === 'string' ? execution.name : ''
  if (toolName.startsWith(TOOL_PREFIX) === false) return undefined
  if (WIN_MCP.online !== true) {
    return {
      reason: [
        `refused: the Windows computer is not online, so ${toolName} cannot run`,
        'code: vm-offline',
        `why: ${WIN_MCP.reason || 'the bridge is down'}${WIN_MCP.lastError ? ` (${WIN_MCP.lastError})` : ''}`,
        'next: start the computer (cua_vm_start) and call windows_desktop again, or use cua_vm_gui for a screenshot loop'
      ].join('\n'),
      info: { name: toolName, code: 'vm-offline', reason: WIN_MCP.reason }
    }
  }
  const agent = execution?.agent
  // THE TARGET CHECK RUNS EVEN WHEN `execution.agent` IS MISSING. An execution
  // whose session cannot be named has no binding, so it has no right to the
  // attached computer's desktop: the refusal is the same `not-the-target` the
  // mismatch produces, with the reason spelled out.
  const match = targetMatchFor(agent)
  if (match.ok !== true) {
    return {
      reason: [
        `refused: ${toolName} drives the Windows computer ${match.attached || 'attached to this bridge'}, and this session may not use it`,
        `code: ${match.code}`,
        `why: ${match.text}`,
        'next: run cua_vm_exec, cua_vm_gui or cua_vm_ensure on the computer this session means (that binds it), then call windows_desktop again'
      ].join('\n'),
      info: { name: toolName, code: match.code, bound: match.bound ?? null, attached: match.attached ?? '' }
    }
  }
  if (agent !== undefined && agent !== null) {
    if (grantFor(agent) !== true) {
      return {
        reason: [
          `refused: the Computer Use grant is OFF for this session (turned off explicitly), so ${toolName} did not run`,
          'code: grant-off',
          'next: the user turns it back on (Personal VM panel → Computer Use, or POST /dsh-cua-vm/cua-grant { "grant": true }); the grant is ON by default, memory-only and per session'
        ].join('\n'),
        info: { name: toolName, code: 'grant-off' }
      }
    }
    if (revealedFor(agent) !== true) {
      return {
        reason: [
          `refused: ${toolName} is hidden until this session reveals the desktop`,
          'code: reveal-required',
          'next: call windows_desktop (no arguments) first; it lists the tools it just unhid'
        ].join('\n'),
        info: { name: toolName, code: 'reveal-required' }
      }
    }
  }
  return undefined
}

/** Every global tool name on the host registry — the leak surface the doctor checks. */
function globalSchemaNames() {
  const ctx = WIN_MCP_AUX.ctx
  if (ctx === undefined) return []
  try {
    const schemas = ctx.tools.schemas()
    return (Array.isArray(schemas) ? schemas : []).map((schema) => String(schema?.name ?? '')).filter((name) => name !== '')
  } catch {
    return []
  }
}

/**
 * TAKE THE BRIDGE DOWN. Every entry point funnels through here, and it is
 * idempotent: the map is emptied BEFORE the disposers run, so a disposer that
 * re-enters cannot see a half-torn registry.
 *
 * J20-4: it also BUMPs the attach generation and kills the ticket of an attach
 * that is currently in flight. `WIN_MCP.name` is '' for that attach (it is set
 * only after `connect()` answers), so a name comparison alone could not catch
 * it — the generation is name-independent on purpose.
 */
function teardown(reason) {
  const why = String(reason ?? 'unspecified')
  const hadState = WIN_MCP.name !== '' || WIN_MCP.client !== null || WIN_MCP.online === true || WIN_MCP.registrations.size > 0
  // Invalidate any attach that is between `connect()` and registration FIRST,
  // so nothing it does after this line can put a name back on the registry.
  WIN_MCP.generation += 1
  if (WIN_MCP_AUX.inflightTicket !== null) WIN_MCP_AUX.inflightTicket.dead = true
  const client = WIN_MCP.client
  WIN_MCP.client = null
  WIN_MCP.online = false
  WIN_MCP.name = ''
  WIN_MCP_AUX.target = null
  WIN_MCP_AUX.tools = []
  const disposers = [...WIN_MCP.registrations.values()]
  WIN_MCP.registrations.clear()
  for (const dispose of disposers) {
    try { dispose() } catch { /* the tool registry may already be gone */ }
  }
  try { client?.close() } catch { /* the child may already be dead */ }
  WIN_MCP_AUX.targetOnline = false
  WIN_MCP.reason = why
  if (hadState) console.log(`[cua-vm] windows MCP torn down (${why})`)
  reapplyWindowsGates(`teardown:${why}`)
}

/** One supervisor probe of a bound computer; tolerates a pre-WP5 supervisor. */
async function resolveOneWindowsTarget(name) {
  const call = WIN_MCP_AUX.supervisorCall
  if (typeof call !== 'function') return { ok: false, reason: 'no supervisor call is bound' }
  let state
  try {
    state = await call({ op: 'vmWindowsMcpState', name })
  } catch (error) {
    const text = String(error?.message ?? error)
    if (/unknown op/iu.test(text) === false) return { ok: false, reason: `supervisor-unavailable: ${text}` }
    // LEGACY FALLBACK: a supervisor older than this plugin has no state op. The
    // old attach op still honors an explicit name, so the SAME target rule holds
    // — and a row that answers with a different computer is refused, never
    // adopted ("never the first ready row").
    try {
      const answer = await call({ op: 'vmWindowsMcp', name })
      if (answer?.available !== true) return { ok: false, reason: `not-online: ${answer?.reason ?? 'the supervisor offered no endpoint'}` }
      const actual = String(answer.name ?? name)
      if (actual !== name) return { ok: false, reason: `not-the-target (the supervisor offered ${actual} instead of ${name})` }
      return {
        ok: true,
        target: { name, host: '127.0.0.1', sshPort: Number(answer.sshPort ?? 0), keyPath: answer.keyPath, user: answer.user ?? 'cua', state: String(answer.state ?? 'ready') }
      }
    } catch (fallbackError) {
      return { ok: false, reason: `not-online: ${fallbackError?.message ?? fallbackError}` }
    }
  }
  const answer = state ?? {}
  const actual = String(answer.name ?? name)
  if (actual !== name) return { ok: false, reason: `not-the-target (the supervisor reported ${actual} instead of ${name})` }
  const kind = String(answer.kind ?? 'windows')
  if (kind !== 'windows') return { ok: false, reason: `not-the-target (${name} is a ${kind} computer, and only a Windows one speaks dsh-cua)` }
  const rowState = String(answer.state ?? 'unknown')
  // An explicit refusal keeps its own words: "no ready Windows computer" is a
  // better reason than "state unknown".
  if (answer.available === false && answer.reason !== undefined) {
    return { ok: false, reason: `not-online: ${answer.reason}` }
  }
  // `available` and `online` are both accepted: the op is new supervisor-side,
  // and a state answer that only carries `state: "ready"` still means online.
  const online = answer.online === true || answer.available === true || rowState === 'ready'
  if (online !== true) return { ok: false, reason: `vm-state:${rowState} (not online)` }
  let sshPort = Number(answer.sshPort ?? 0)
  let keyPath = answer.keyPath
  let user = answer.user ?? 'cua'
  if (!(sshPort > 0)) {
    // The state op may answer facts only; the endpoint details still come from
    // the attach op, for the SAME name.
    try {
      const detail = await call({ op: 'vmWindowsMcp', name })
      if (detail?.available === true && String(detail.name ?? name) === name) {
        sshPort = Number(detail.sshPort ?? 0)
        keyPath = detail.keyPath ?? keyPath
        user = detail.user ?? user
      }
    } catch { /* the host is online but the details op failed: not attachable */ }
  }
  if (!(sshPort > 0)) return { ok: false, reason: `not-online (no SSH port for ${name})` }
  return { ok: true, target: { name, host: String(answer.host ?? '127.0.0.1'), sshPort, keyPath, user: String(user), state: rowState } }
}

/**
 * WHICH COMPUTER. Not the first ready row: the name a SESSION recorded when it
 * created, ensured, started, executed on or drove that computer. The most
 * recent binding wins, and a binding that no longer resolves is skipped rather
 * than adopted — a mismatch is `not-the-target`, never an attach.
 */
async function resolveWindowsTarget() {
  const rows = [...WIN_MCP_AUX.targets.entries()].sort((left, right) => right[1].at - left[1].at)
  const names = []
  for (const [, row] of rows) {
    if (row.name === '' || names.includes(row.name)) continue
    names.push(row.name)
    if (names.length >= 4) break
  }
  if (names.length === 0) {
    WIN_MCP.reason = 'not-the-target (no computer is bound to a session yet: cua_vm_create/cua_vm_ensure, or cua_vm_exec/cua_vm_gui on a Windows computer, binds it)'
    return null
  }
  let first = ''
  for (const name of names) {
    const resolved = await resolveOneWindowsTarget(name)
    if (resolved.ok === true) {
      WIN_MCP_AUX.targetOnline = true
      // DETAIL, NOT A VERDICT: recorded with its own timestamp so the doctor can
      // age it, and never read as "the bridge is up".
      WIN_MCP_AUX.probe = {
        at: Date.now(),
        online: true,
        state: String(resolved.target.state ?? ''),
        name: String(resolved.target.name ?? name)
      }
      return resolved.target
    }
    if (first === '') first = resolved.reason
  }
  WIN_MCP_AUX.targetOnline = false
  WIN_MCP_AUX.probe = {
    at: Date.now(),
    online: false,
    state: winStateFromProbeReason(first),
    name: names[0] ?? ''
  }
  WIN_MCP.reason = first === '' ? 'not-the-target' : first
  return null
}

/**
 * THE ROW STATE A REFUSAL IMPLIES, for the probe record only. `resolveOne…`
 * folds the state into a sentence ("vm-state:powered-off (not online)"); the
 * doctor wants the bare state next to its own verdict, not a second sentence.
 */
function winStateFromProbeReason(reason) {
  const text = String(reason ?? '')
  const stated = /vm-state:([^\s()]+)/u.exec(text)
  if (stated !== null) return stated[1]
  if (/^not-online:/u.test(text)) return 'not-online'
  return ''
}

/**
 * ATTACH — one SSH handshake, then register every guest tool under its public
 * `mcp__windows__*` name. Registration is by hand (NOT `ctx.effect`) so the
 * disposer is ours to call from any teardown entry point.
 */
async function attachWindowsMcp(target) {
  if (WIN_MCP.inflight !== null) return WIN_MCP.inflight
  const ctx = WIN_MCP_AUX.ctx
  if (ctx === undefined) return undefined
  let ownTicket = null
  WIN_MCP.inflight = (async () => {
    if (WIN_MCP_AUX.retryAt > Date.now()) return
    teardown('switching computers')
    // THE TICKET (J20-4). `teardown()` above has just bumped the generation, so
    // this attach owns exactly the generation it was born in. Anything that
    // tears the bridge down while `connect()` is waiting kills the ticket, and
    // every write below re-checks it — no name is registered after that point.
    const generation = WIN_MCP.generation
    const ticket = { generation, name: String(target.name ?? ''), dead: false, at: Date.now() }
    WIN_MCP_AUX.inflightTicket = ticket
    ownTicket = ticket
    const isDead = () => ticket.dead === true || WIN_MCP.generation !== generation
    // Abandon ship without leaving a name, a client or an `online` behind.
    const abort = (why) => {
      ticket.dead = true
      try { client?.close() } catch { /* never opened */ }
      if (WIN_MCP.client === client) WIN_MCP.client = null
      if (WIN_MCP.name === target.name) WIN_MCP.name = ''
      WIN_MCP.online = false
      WIN_MCP.reason = `${why} (attach aborted)`
      console.log(`[cua-vm] windows MCP attach to ${target.name} aborted: ${why}`)
    }
    // The resolution that got us here IS the online verdict the client asks for.
    WIN_MCP_AUX.targetOnline = true
    let client = null
    try {
      if (!(Number(target.sshPort) > 0)) throw mcpError('no-ssh-port', `the supervisor offered no SSH port for ${target.name}`)
      client = createDshCuaClient({
        name: target.name,
        host: target.host ?? '127.0.0.1',
        sshPort: target.sshPort,
        keyPath: target.keyPath,
        user: target.user ?? 'cua',
        timeoutMs: WIN_MCP_ATTACH_TIMEOUT_MS,
        // The client re-checks this before EVERY call; a stale session must fail
        // with vm-offline instead of hanging on a half-open socket.
        isOnline: () => windowsMcpIsOnline(),
        // A dead child is an immediate teardown, not a 5 s wait for the beat.
        onClosed: (code) => {
          if (WIN_MCP.client !== client) return
          WIN_MCP.lastError = `the guest MCP session ended (exit ${code})`
          teardown(`client-closed:${code}`)
        }
      })
      if (isDead()) { abort('the bridge was torn down while the handshake was in flight'); return }
      const session = await client.connect()
      // THE RACE J20-4 NAMES: a row deleted, or a shutdown observed, during the
      // 45 s handshake has already called teardown(); registering now would put
      // 19 dead schemas back on every session's tool list until the next beat.
      if (isDead()) { abort('the bridge was torn down during the handshake'); return }
      WIN_MCP.client = client
      WIN_MCP.name = target.name
      WIN_MCP.online = true
      WIN_MCP.lastError = ''
      WIN_MCP_AUX.onlineCheckedAt = Date.now()
      WIN_MCP_AUX.target = { ...target }
      // A CONFIRMED ATTACH IS STATE, TOO: it dates the newest positive fact for
      // this computer, so a `powered-off` event from BEFORE the restart can
      // never demote a bridge that is attached right now (the verdict prefers
      // the newest entry for the attached name).
      recordVmState(target.name, 'ready')
      const failed = []
      WIN_MCP_AUX.tools = session.tools.map((tool) => ({
        name: windowsToolName(tool.name),
        description: String(tool.description ?? tool.name),
        parameters: tool.inputSchema ?? { type: 'object', additionalProperties: true, properties: {} }
      }))
      for (const tool of session.tools) {
        // Re-checked BEFORE EACH register: `ctx.tools.register` may grow an
        // await later, and a teardown that lands between two registrations must
        // cost zero names, not "the rest of them".
        if (isDead()) { abort('the bridge was torn down during registration'); return }
        const publicName = windowsToolName(tool.name)
        const definition = {
          name: publicName,
          description: `${tool.description ?? tool.name} (dsh-cua, Windows computer ${target.name})`,
          parameters: tool.inputSchema ?? { type: 'object', additionalProperties: true, properties: {} },
          // The design's budget: a pywinauto round trip is fast, and the SSH
          // keepalive (10s × 2) decides a dead link long before this.
          timeoutMs: WIN_MCP_ATTACH_TIMEOUT_MS,
          output: textOutput('The guest tool result as JSON, or a `code:` line when it failed.'),
          async execute(args = {}) {
            try {
              const result = await client.callTool(windowsGuestToolName(tool.name), args ?? {})
              return { text: JSON.stringify(result) }
            } catch (error) {
              // D PLUGIN PART: the structured code reaches the MODEL as text, so
              // it can branch instead of guessing at an SSH message.
              const code = error?.code ?? 'tool-failed'
              return { text: `${error?.message ?? error}\ncode: ${code}` }
            }
          }
        }
        try {
          const dispose = ctx.tools.register(definition)
          WIN_MCP.registrations.set(publicName, dispose)
        } catch (error) {
          // ONE bad guest tool must not cost the other eighteen: the name is
          // recorded as a registration failure, and the bridge stays up.
          failed.push(`${publicName}: ${error?.message ?? error}`)
        }
      }
      if (failed.length > 0) WIN_MCP.lastError = `registration failed for ${failed.length} tool(s): ${failed[0]}`
      WIN_MCP.reason = `attached (${WIN_MCP.registrations.size} tool(s))`
      WIN_MCP_AUX.retryAt = 0
      console.log(`[cua-vm] windows MCP attached to ${target.name} (${session.tools.length} tool(s))`)
      reapplyWindowsGates('attach')
    } catch (error) {
      try { client?.close() } catch { /* never opened */ }
      WIN_MCP.online = false
      WIN_MCP.lastError = `${error?.code ?? 'attach-failed'}: ${error?.message ?? error}`
      WIN_MCP.reason = `attach failed: ${WIN_MCP.lastError}`
      WIN_MCP_AUX.retryAt = Date.now() + WIN_MCP_RETRY_MS
      console.log(`[cua-vm] windows MCP NOT attached: ${WIN_MCP.lastError}`)
      teardown(WIN_MCP.reason)
    }
  })().finally(() => {
    WIN_MCP.inflight = null
    // Only clear OUR ticket: a newer attach (or a teardown that already killed
    // it) must keep whatever it put there.
    if (WIN_MCP_AUX.inflightTicket === ownTicket) WIN_MCP_AUX.inflightTicket = null
  })
  return WIN_MCP.inflight
}

/**
 * LET A LATE RELAY IN — THE POLL IS THE WATCH THAT NEVER GIVES UP.
 *
 * The lane is decided on every attach (`resolveGuestMcpTransport`), and the
 * Windows logon task that starts the interactive relay can come up MINUTES
 * after the boot that made sshd reachable. The client covers the common case
 * with its own 15 s watch (`startUpgradeWatch` in win-mcp.js), which is the
 * FAST path — but a relay that starts at attach+16 s is missed by it forever,
 * and that is exactly the observed defect: relay listening on 47999 while the
 * session sat on `session-0-direct` with RELAY_DOWN, blind for its whole life.
 *
 * So the bridge owns the SLOW path too: every poll tick that still sees the
 * blind lane asks the client to reconsider. Nothing here re-implements the
 * decision or opens a second SSH session — `maybeUpgradeTransport()` is the
 * client's own method, and its verified contract is:
 *
 *   • it throttles itself to one probe per RELAY_UPGRADE_INTERVAL_MS (60 s)
 *     and returns `{ upgraded, reason }` without throwing;
 *   • it never acts during a `tools/call` (in-flight check, re-checked after
 *     the await), so a poll nudge cannot cut a call the model is waiting on;
 *   • on success it tears its own child down, `onClosed` tells this plugin,
 *     and the next poll re-attaches THROUGH the relay — the registrations stay
 *     owned by `attachWindowsMcp`, never by the client.
 *
 * Net effect: a relay that starts later is picked up within one poll interval
 * plus one throttle window (≤60 s of it listening), instead of a single 15 s
 * window that has already closed. `DSH_CUA_VM_WIN_MCP_UPGRADE=0` is honoured
 * here too, so the escape hatch that silences the client's watch silences this
 * as well. Returns whether a nudge was issued (for the call sites' readability),
 * and never throws: this runs from the health timer.
 */
function nudgeRelayUpgrade(reason = 'poll') {
  if (WIN_MCP.client?.state?.transport !== 'session-0-direct') return false
  if (String(process.env.DSH_CUA_VM_WIN_MCP_UPGRADE ?? '1') === '0') return false
  try {
    // The contract above says it never rejects; the extra `.catch` is
    // belt-and-braces so a health timer can never take the harness down over a
    // transport it was only trying to improve.
    void Promise.resolve(WIN_MCP.client?.maybeUpgradeTransport?.()).catch(() => {})
  } catch (error) {
    WIN_MCP.lastError = `relay upgrade nudge (${reason}): ${error?.message ?? error}`
    return false
  }
  return true
}

/**
 * THE STATE PATH. Since J20-3 this is the BELT, not the only brace: the
 * supervisor's `subscribe` stream (see `handleVmEvent`) delivers a transition
 * inside a turn, and this poll still runs behind it — a slower cadence on a
 * supervisor that speaks the stream, the old 10 s answer on one that does not.
 *
 * Every tick resolves the bound computer and either confirms the attach, tears
 * it down (the row is gone: `vm-removed`; the row is not ready: `vm-state:*`)
 * or dials SSH on the transition into online. Nothing here guesses a target.
 *
 * Every tick that leaves the bridge CONNECTED on the blind lane also nudges the
 * client's relay upgrade (`nudgeRelayUpgrade` above): the attach is re-validated
 * here for the life of the session, so this is the one loop that can heal a
 * relay which started after the client's 15 s watch closed.
 */
async function syncWindowsMcp(reason = 'poll') {
  if (windowsMcpEnabled() !== true) {
    teardown(`disabled (DSH_CUA_VM_WIN_MCP=0) via ${reason}`)
    return
  }
  if (typeof WIN_MCP_AUX.supervisorCall !== 'function') return
  const target = await resolveWindowsTarget()
  if (target === null) {
    teardown(WIN_MCP.reason || 'not-the-target')
    return
  }
  if (WIN_MCP.online === true && WIN_MCP.name === target.name && WIN_MCP.client?.state?.connected === true) {
    WIN_MCP.reason = `attached (${WIN_MCP.registrations.size} tool(s))`
    // THE HEAL. The assign is already live and valid; the only outstanding
    // question is whether it is blind and no longer has to be.
    nudgeRelayUpgrade(reason)
    return
  }
  await attachWindowsMcp(target)
  // A fresh attach can land blind too (the probe said RELAY_DOWN and the relay
  // answered a moment later). The same nudge covers it until the next tick.
  nudgeRelayUpgrade(reason)
}

/**
 * The `isOnline` the guest client asks before every call (10 s cache).
 *
 * It answers "is the bound computer reachable", which is TRUE during the very
 * first handshake — the supervisor's state probe said so one moment ago. The
 * 10 s cache means a dead link costs at most one refresh before the call is
 * refused with vm-offline instead of hanging on a half-open socket.
 */
function windowsMcpIsOnline() {
  if (WIN_MCP.online !== true && WIN_MCP_AUX.targetOnline !== true) return false
  const now = Date.now()
  if (now - WIN_MCP_AUX.onlineCheckedAt > WIN_MCP_ONLINE_TTL_MS) {
    WIN_MCP_AUX.onlineCheckedAt = now
    void syncWindowsMcp('online check').catch(() => {})
  }
  return true
}

/* ------------------------------------------------------------------ *
 * J20-3 — CONSUMING THE SUPERVISOR'S STATE BUS
 *
 * The supervisor has answered `{"op":"subscribe"}` with a newline-delimited
 * event stream since WP-4 (one line per REAL transition, a `ready` line first,
 * a 25 s ping to reap dead clients). This plugin never consumed it, so a
 * shutdown took up to one 10 s poll interval to reach `teardown()` — the README
 * claims a single idempotent teardown behind that bus, and this is the client
 * half of the claim.
 *
 * The stream is a plain unix-socket connection on the SAME socket as the ops
 * channel, and every event rides the SAME two functions the poll uses
 * (`forgetSessionTarget` / `teardown` + `syncWindowsMcp`). Nothing here can
 * invent a target: an event only ever acts on the attached name, an in-flight
 * attach ticket, or a name some session already bound.
 *
 * A supervisor that does not speak `subscribe` answers `unknown op` (or closes
 * without `ready`); the client then backs off and leaves the 10 s poll alone,
 * which is exactly the pre-J20-3 behaviour. The poll keeps running either way.
 * ------------------------------------------------------------------ */
const WIN_MCP_STREAM_BACKOFF_MS = Object.freeze([1000, 2000, 5000, 10_000, 30_000, 60_000])
/** Coalesce a boot's burst of transitions into one state probe. */
const WIN_MCP_STREAM_SYNC_MS = 50

/** Open (or re-open) the one subscription. Safe to call twice. */
function streamOpen(socketPath) {
  if (WIN_MCP_STREAM.closed === true) return
  if (WIN_MCP_STREAM.socket !== null) return
  WIN_MCP_STREAM.socketPath = socketPath
  let socket
  try {
    socket = net.connect(socketPath)
  } catch (error) {
    streamScheduleRetry(`state stream: ${error?.message ?? error}`)
    return
  }
  WIN_MCP_STREAM.socket = socket
  let settled = false
  const finish = (why) => {
    if (settled === true) return
    settled = true
    if (WIN_MCP_STREAM.socket === socket) WIN_MCP_STREAM.socket = null
    WIN_MCP_STREAM.live = false
    try { socket.destroy() } catch { /* already gone */ }
    if (WIN_MCP_STREAM.closed !== true) streamScheduleRetry(why)
  }
  socket.setEncoding('utf8')
  socket.on('connect', () => {
    try {
      // `vm-removed` rides the state stream supervisor-side, but asking for it
      // by name is the contract the supervisor documents.
      socket.write(`${JSON.stringify({ op: 'subscribe', events: ['vm-state', 'vm-removed'] })}\n`)
    } catch (error) {
      finish(`state stream: ${error?.message ?? error}`)
    }
  })
  socket.on('data', (chunk) => {
    WIN_MCP_STREAM.buffer += chunk
    if (WIN_MCP_STREAM.buffer.length > 1024 * 1024) {
      WIN_MCP_STREAM.buffer = ''
      finish('state stream: 1 MiB without a newline')
      return
    }
    let at = WIN_MCP_STREAM.buffer.indexOf('\n')
    while (at >= 0) {
      const line = WIN_MCP_STREAM.buffer.slice(0, at)
      WIN_MCP_STREAM.buffer = WIN_MCP_STREAM.buffer.slice(at + 1)
      if (line.trim() !== '') {
        let event = null
        try { event = JSON.parse(line) } catch { event = null }
        if (event !== null) handleStreamLine(event, finish)
      }
      at = WIN_MCP_STREAM.buffer.indexOf('\n')
    }
  })
  socket.on('error', (error) => finish(`state stream: ${error?.message ?? error}`))
  socket.on('close', () => finish(WIN_MCP_STREAM.live === true
    ? 'state stream: the supervisor closed the subscription'
    : 'state stream: no ready line (the supervisor may be older than the subscribe op)'))
}

/** One backoff step; unref'd, so a dead supervisor cannot hold the process. */
function streamScheduleRetry(why) {
  WIN_MCP_STREAM.live = false
  if (why !== '') WIN_MCP_STREAM.error = String(why)
  if (WIN_MCP_STREAM.closed === true || WIN_MCP_STREAM.retryTimer !== null) return
  const index = Math.min(WIN_MCP_STREAM.attempts, WIN_MCP_STREAM_BACKOFF_MS.length - 1)
  const wait = WIN_MCP_STREAM_BACKOFF_MS[index]
  WIN_MCP_STREAM.attempts += 1
  WIN_MCP_STREAM.retryMs = wait
  const timer = setTimeout(() => {
    WIN_MCP_STREAM.retryTimer = null
    streamOpen(WIN_MCP_STREAM.socketPath)
  }, wait)
  timer.unref?.()
  WIN_MCP_STREAM.retryTimer = timer
}

/** Start consuming the bus (idempotent), and stop for good on plugin dispose. */
function startWindowsStateStream(socketPath) {
  WIN_MCP_STREAM.closed = false
  streamOpen(socketPath)
}

function stopWindowsStateStream() {
  WIN_MCP_STREAM.closed = true
  if (WIN_MCP_STREAM.retryTimer !== null) {
    clearTimeout(WIN_MCP_STREAM.retryTimer)
    WIN_MCP_STREAM.retryTimer = null
  }
  if (WIN_MCP_STREAM.syncTimer !== null) {
    clearTimeout(WIN_MCP_STREAM.syncTimer)
    WIN_MCP_STREAM.syncTimer = null
  }
  const socket = WIN_MCP_STREAM.socket
  WIN_MCP_STREAM.socket = null
  WIN_MCP_STREAM.live = false
  if (socket !== null) {
    try { socket.destroy() } catch { /* already gone */ }
  }
}

/** A state transition this bridge cares about → ONE coalesced state probe. */
function scheduleStreamSync() {
  if (WIN_MCP_STREAM.syncTimer !== null) return
  const timer = setTimeout(() => {
    WIN_MCP_STREAM.syncTimer = null
    void syncWindowsMcp('stream').catch(() => {})
  }, WIN_MCP_STREAM_SYNC_MS)
  timer.unref?.()
  WIN_MCP_STREAM.syncTimer = timer
}

/** One parsed line from the subscription. */
function handleStreamLine(event, finish) {
  if (event?.event === 'ready') {
    WIN_MCP_STREAM.live = true
    WIN_MCP_STREAM.supported = true
    WIN_MCP_STREAM.attempts = 0
    WIN_MCP_STREAM.retryMs = 0
    WIN_MCP_STREAM.readyAt = Date.now()
    WIN_MCP_STREAM.error = ''
    return
  }
  if (typeof event?.event !== 'string') {
    // An ANSWER, not an event: a supervisor without the op answers `ok: false`.
    if (event?.ok === false) {
      WIN_MCP_STREAM.supported = false
      finish(`state stream unsupported: ${String(event.error ?? 'refused')} (the 10 s poll carries the state)`)
    }
    return
  }
  if (event.event === 'ping') return
  WIN_MCP_STREAM.events += 1
  WIN_MCP_STREAM.lastEventAt = Date.now()
  WIN_MCP_STREAM.lastEvent = `${event.event}:${String(event.name ?? '')}:${String(event.state ?? '')}`
  handleVmEvent(event)
}

/**
 * KEEP THE NEWEST FEW `vm-state` PAYLOADS. Bounded on purpose: a store with a
 * hundred computers must not grow a log, and the verdict only ever asks about
 * the names this session bound (at most four).
 */
function recordVmState(name, state) {
  const row = { name: String(name ?? ''), state: String(state ?? ''), at: Date.now() }
  if (row.name === '') return
  WIN_MCP_STREAM.stateLog.push(row)
  if (WIN_MCP_STREAM.stateLog.length > 8) WIN_MCP_STREAM.stateLog.splice(0, WIN_MCP_STREAM.stateLog.length - 8)
}

/** The newest stream event about ONE of `names`, or null when the bus is quiet. */
function newestVmStateFor(names) {
  for (let index = WIN_MCP_STREAM.stateLog.length - 1; index >= 0; index -= 1) {
    const row = WIN_MCP_STREAM.stateLog[index]
    if (row && names.has(String(row.name)) === true) return row
  }
  return null
}

/**
 * THE BUS → THE SAME TWO PATHS THE POLL USES.
 *
 * `vm-removed`  : the row is gone → forget the bindings and tear down (the
 *                 in-flight ticket dies too; see `forgetSessionTarget`);
 * `vm-state`    : not online → tear down NOW; online → let the poll's one state
 *                 probe attach, so the "which computer" rule is never duplicated.
 */
function handleVmEvent(event) {
  const what = String(event?.event ?? '')
  const name = String(event?.name ?? '')
  if (name === '') return
  if (what === 'vm-removed') {
    forgetSessionTarget(name)
    return
  }
  if (what !== 'vm-state') return
  const state = String(event?.state ?? '')
  // THE FRESHEST WORD ON THIS COMPUTER, KEPT EVEN AFTER A TEARDOWN CLEARS THE
  // TARGET: the doctor's verdict reads this log, so a proxy answer that still
  // remembers the handshake cannot outlive the power-off the bus just reported.
  recordVmState(name, state)
  const online = state === 'ready'
  const attached = WIN_MCP.name === name
  const inflight = WIN_MCP_AUX.inflightTicket !== null && String(WIN_MCP_AUX.inflightTicket.name ?? '') === name
  if (online !== true && (attached === true || inflight === true)) {
    teardown(`vm-state:${state} (stream:${name})`)
    return
  }
  const relevant = attached === true
    || inflight === true
    || [...WIN_MCP_AUX.targets.values()].some((row) => row?.name === name)
  if (relevant !== true) return
  scheduleStreamSync()
}

/**
 * PER-AGENT SELF-HEAL at the step boundary: if the SSH session died between
 * beats, take the names away NOW instead of letting the model discover it. The
 * step itself is never swallowed — next() runs on every path.
 */
function selfHealWindowsMcp(agent) {
  try {
    if (WIN_MCP.online !== true) {
      applyAgentGate(agent, 'pre-step offline')
      // ONE probe per poll interval, not one per step: a Linux-only workspace
      // must not pay a supervisor round trip for every step it takes.
      if (WIN_MCP_AUX.targets.size > 0 && Date.now() - WIN_MCP_AUX.onlineCheckedAt > windowsMcpPollMs()) {
        WIN_MCP_AUX.onlineCheckedAt = Date.now()
        void syncWindowsMcp('pre-step').catch(() => {})
      }
      return
    }
    if (WIN_MCP.client?.state?.connected !== true) {
      teardown(`pre-step: the SSH session is gone${WIN_MCP.lastError ? ` (${WIN_MCP.lastError})` : ''}`)
      return
    }
    applyAgentGate(agent, 'pre-step')
    if (WIN_MCP_AUX.onlineCheckedAt === 0 || Date.now() - WIN_MCP_AUX.onlineCheckedAt > windowsMcpPollMs()) {
      WIN_MCP_AUX.onlineCheckedAt = Date.now()
      void syncWindowsMcp('pre-step').catch(() => {})
    }
  } catch (error) {
    WIN_MCP_AUX.gateError = `pre-step: ${error?.message ?? error}`
  }
}

/**
 * BIND THE COMPUTER A SESSION ASKED FOR. Called by cua_vm_create/ensure and by
 * cua_vm_exec/cua_vm_gui/cua_vm_start, i.e. only on the model's own explicit
 * statement of which computer it means.
 */
function rememberSessionTarget(exec, name) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) return
  const key = sessionKeyOf(agent)
  if (key === '') return
  if (name === undefined || name === null || String(name) === '') return
  const bound = String(name)
  WIN_MCP_AUX.targets.set(key, { name: bound, at: Date.now() })
  applyAgentGate(agent, 'bound target')
  // Bound, but do not turn every exec into a probe: one bind-triggered sync per
  // 5 s is enough to pick a new computer up, and the 10 s poll covers the rest.
  const now = Date.now()
  if ((WIN_MCP.name !== bound || WIN_MCP.online !== true) && now - WIN_MCP_AUX.lastBindSyncAt > 5000) {
    WIN_MCP_AUX.lastBindSyncAt = now
    void syncWindowsMcp('bound target').catch(() => {})
  }
}

/**
 * Forget a computer that was deleted, and take its tools away at once.
 *
 * J20-4: `WIN_MCP.name` is '' for an attach that is still in flight, so testing
 * the name alone MISSED the delete that lands mid-handshake. The delete route
 * skipped teardown, the attach finished 20 s later, and 19 schemas of a computer
 * that no longer exists reappeared until the next poll beat. The in-flight
 * ticket carries the name for exactly that window.
 */
function forgetSessionTarget(name) {
  const gone = String(name ?? '')
  if (gone === '') return
  for (const [key, row] of [...WIN_MCP_AUX.targets.entries()]) {
    if (row.name !== gone) continue
    WIN_MCP_AUX.targets.delete(key)
    WIN_MCP_AUX.revealedSessions.delete(key)
  }
  const inflightName = WIN_MCP_AUX.inflightTicket === null ? '' : String(WIN_MCP_AUX.inflightTicket.name ?? '')
  if (WIN_MCP.name === gone || inflightName === gone) teardown(`vm-removed:${gone}`)
}

/** The reveal: unhide the bridged tools for one agent, then re-gate. */
function revealWindowsTools(agent) {
  const tools = Array.isArray(WIN_MCP_AUX.tools) ? WIN_MCP_AUX.tools : []
  if (agent !== undefined && agent !== null) {
    WIN_MCP.reveals.set(agent, true)
    const key = sessionKeyOf(agent)
    if (key !== '') WIN_MCP_AUX.revealedSessions.add(key)
  }
  const online = WIN_MCP.online === true
  const granted = agent === undefined || agent === null ? WIN_MCP_AUX.grantDefault === true : grantFor(agent)
  // J20-5: revealing is not a way around the target rule. A session that bound
  // ANOTHER computer gets a structured `not-the-target` here, at the first call
  // it makes, instead of 19 visible names that refuse one by one.
  const match = targetMatchFor(agent)
  const revealed = online && granted && match.ok === true
  reapplyWindowsGates('reveal')
  const code = revealed
    ? ''
    : online !== true
      ? 'vm-offline'
      : granted !== true
        ? 'grant-off'
        : (match.code ?? 'not-the-target')
  return {
    revealed,
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    online,
    granted,
    target: WIN_MCP.name === '' ? null : WIN_MCP.name,
    bound: boundTargetOf(agent)?.name ?? null,
    code,
    note: revealed
      ? `${tools.length} dsh-cua tool(s) are now visible for this session.`
      : online !== true
        ? `The Windows computer is not online yet (${WIN_MCP.reason}); start it and call windows_desktop again.`
        : granted !== true
          ? 'The Computer Use grant is OFF for this session (turned off explicitly), so the tools stay hidden: the user turns it back on in the Personal VM panel (or POST /dsh-cua-vm/cua-grant with {"grant":true}); it is ON by default.'
          : `${match.text}. The tools went back to hidden for this session.`
  }
}

/**
 * ONE LINE for the doctor's text: the lane this process actually took.
 *
 * It is built from the client's own `doctorFacts()` — the SAME object spread
 * into the JSON — so the sentence and the fields can never disagree. It dials
 * nothing: "never attached" is a fact, not a reason to open an SSH session.
 */
function windowsTransportLine(facts) {
  if (facts.transport === 'interactive-relay') {
    const relay = facts.relayOk === true ? 'up' : facts.relayOk === false ? 'down' : 'unknown'
    return `windows mcp transport: interactive-relay (port ${facts.relayPort}, relay ${relay})`
  }
  if (facts.transport === 'session-0-direct') {
    // A fallback attach records a SENTENCE ("session-0 fallback (…)"); the line
    // needs only the part that says WHY, not a second copy of the label.
    const recorded = String(facts.transportReason ?? '').trim()
      .replace(/^session-0 fallback\s*[:\-]?\s*/i, '')
      .replace(/^\(/, '')
      .replace(/\)$/, '')
    const detail = recorded !== '' ? recorded : (facts.relayStatus || 'interactive relay not running')
    return `windows mcp transport: session-0 fallback: ${detail}`
  }
  return 'windows mcp transport: not attached yet (no lane decided in this process)'
}

/**
 * THE DOCTOR. It answers two questions. Are any `mcp__windows__*` schemas still
 * on the global registry while the bridge is down? Offline, `leaks` MUST be
 * empty — anything else is `status: "leaking"`, the state that used to persist
 * for minutes after a delete. And is the bridge online RIGHT NOW? That verdict
 * is built FIRST from this plugin's own state (the stream's newest `vm-state`,
 * `WIN_MCP.online`, the registration map); a live probe is aged, reported as
 * `probeAgeMs` / `probe.*`, and may only add detail — never overrule a
 * not-online verdict, which is how `online: true / state: ready / 19 tools`
 * outlived a power-off by seconds.
 */
async function windowsMcpDoctor(execAgent) {
  try {
    if (windowsMcpEnabled() === true && typeof WIN_MCP_AUX.supervisorCall === 'function') {
      // A fast probe, not a handshake: the doctor must answer in one socket
      // round trip, and only the transition into online dials SSH.
      const target = await resolveWindowsTarget()
      if (target === null) {
        if (WIN_MCP.online === true) teardown(WIN_MCP.reason || 'not-the-target')
      } else if (WIN_MCP.online !== true || WIN_MCP.name !== target.name) {
        void syncWindowsMcp('doctor').catch(() => {})
      }
    }
  } catch (error) {
    WIN_MCP.lastError = `doctor probe failed: ${error?.message ?? error}`
  }
  const names = globalSchemaNames()
  const leaks = names.filter((name) => name.startsWith(TOOL_PREFIX))
  const guestTools = Array.isArray(WIN_MCP_AUX.tools) ? WIN_MCP_AUX.tools : []
  const registered = [...WIN_MCP.registrations.keys()]
  // The names the GUEST offered, in their public `mcp__windows__*` form (the
  // map is stored at attach; nothing is re-derived from a live client here).
  const expected = guestTools.map((tool) => tool.name)
  const target = WIN_MCP_AUX.target
  // J20-5: WHY THIS SESSION CAN (OR CANNOT) USE THE DESKTOP. `viewer` is the
  // executing session's binding, not a global fact, and the mismatch codes are
  // the same strings the dispatch guard returns.
  const viewer = (() => {
    const key = sessionKeyOf(execAgent)
    const match = targetMatchFor(execAgent)
    return {
      session: key === '' ? null : key,
      bound: boundTargetOf(execAgent)?.name ?? null,
      attached: WIN_MCP.name === '' ? null : WIN_MCP.name,
      match: match.ok === true,
      via: match.via ?? null,
      code: match.ok === true ? null : match.code,
      reason: match.ok === true ? '' : match.text
    }
  })()
  // ---- THE VERDICT COMES FIRST (THE STALE-PROBE FIX) ----
  // One question: is the bridge online RIGHT NOW? The sources are ordered, and
  // a live probe is NOT one of them:
  //   1. the supervisor's own `vm-state` event — first-hand, newest;
  //   2. the plugin's own state (`WIN_MCP.online`, the registration map);
  //   3. the cached probe answer — DIAGNOSTIC DETAIL, aged and marked stale.
  // The order IS the fix. The probe used to be merged over this answer, and a
  // supervisor still answering from the handshake it watched kept
  // `online: true / state: ready / 19 tools` alive for seconds after the
  // power-off. A not-online event may therefore never be overridden.
  const verdictNames = WIN_MCP.name !== ''
    // Attached: only the ATTACHED computer's state can change this verdict —
    // another bound computer powering off is not this bridge going away.
    ? new Set([String(WIN_MCP.name)])
    // Not attached: every name this session bound (and any attach in flight).
    : new Set([
        ...WIN_MCP_AUX.targets.values().map((row) => (row?.name === undefined ? '' : String(row.name))),
        WIN_MCP_AUX.inflightTicket === null ? '' : String(WIN_MCP_AUX.inflightTicket.name ?? '')
      ].filter((name) => name !== ''))
  const streamState = newestVmStateFor(verdictNames)
  const streamSaysOffline = streamState !== null
    && WIN_MCP_NOT_ONLINE_STATES.has(String(streamState.state).toLowerCase())
  const probeFacts = WIN_MCP_AUX.probe
  const probeAt = Number(probeFacts.at) > 0 ? Number(probeFacts.at) : 0
  const probeAgeMs = probeAt > 0 ? Math.max(0, Date.now() - probeAt) : null
  const online = streamSaysOffline !== true && WIN_MCP.online === true
  const onlineSource = streamSaysOffline === true
    ? `stream:${String(streamState.state)}`
    : WIN_MCP.online === true
      ? (WIN_MCP_AUX.probe.online === true ? 'plugin+probe' : 'plugin')
      : 'offline'
  // PAST 5 s A NOT-ONLINE VERDICT MAKES THE PROBE FACTS STALE: "the handshake
  // answered five seconds ago" is not evidence about a computer that is going
  // down, and `overridden` states plainly that the plugin's own answer won.
  const probeStale = online !== true && probeAgeMs !== null && probeAgeMs > WIN_MCP_PROBE_STALE_MS
  const probeOverridden = online !== true && probeFacts.online === true
  const offlineState = streamState !== null && String(streamState.state).toLowerCase() !== 'ready'
    ? String(streamState.state)
    : (probeFacts.online === false && String(probeFacts.state ?? '') !== '' ? String(probeFacts.state) : 'unknown')
  const state = online !== true
    ? offlineState
    : (streamState !== null && String(streamState.state) !== '' ? String(streamState.state) : (target?.state ?? 'unknown'))
  // THE LANE THIS PROCESS ACTUALLY TOOK — AND NEVER A SECOND SSH SESSION FOR IT.
  // `doctorFacts()` is the client's own synchronous, side-effect-free answer;
  // the doctor reports the transport that really ran instead of dialling the
  // guest to ask (a probe here would race the attach and cost a session).
  // No client means no lane was ever decided, so the keys are simply absent.
  const transportFacts = WIN_MCP.client?.doctorFacts?.() ?? null
  const transportText = transportFacts === null ? null : windowsTransportLine(transportFacts)
  // ONE LINE FOR THE HUMAN READING THE DOCTOR (and cheap enough to always send):
  // the two desktop lanes are not interchangeable, and a noVNC screenshot is a
  // stream, not the guest framebuffer — the MCP tools are the element-level lane.
  const guiNote = 'desktop automation uses the MCP windows tools; cua_vm_gui screenshots are the noVNC stream, not a framebuffer'
  return {
    status: online !== true && leaks.length > 0 ? 'leaking' : 'ok',
    enabled: windowsMcpEnabled() === true,
    target: WIN_MCP.name === '' ? null : WIN_MCP.name,
    // THE TRANSPORT FACTS, from the zero-SSH client method — transport /
    // relayPort / relayOk / relayStatus / transportCommand / transportReason.
    // Spread FIRST, before the verdict: a client fact may add detail, never
    // suppress `online`/`state`/`onlineSource` (see the verdict block above).
    // Absent when no client exists — the doctor never dials to fill them in.
    ...(transportFacts ?? {}),
    // THE VERDICT, from the plugin's own state (see the block above) — a probe
    // may never raise it back to true during a power-off.
    online,
    state,
    // WHICH SOURCE DECIDED IT: `stream:<state>`, `plugin`, `plugin+probe`, or
    // `offline`. Absent from this list on purpose: a bare `probe`, because a
    // probe cannot be the only thing keeping a dead bridge "online".
    onlineSource,
    // The cached probe answer, as DETAIL. `ageMs` ages it, `stale` says it is
    // too old to trust while the verdict is not online, and `overridden` says
    // the plugin's own state beat a probe that still claimed the handshake.
    probeAgeMs,
    probe: {
      at: probeAt > 0 ? probeAt : null,
      ageMs: probeAgeMs,
      online: probeFacts.online,
      state: String(probeFacts.state ?? ''),
      name: String(probeFacts.name ?? ''),
      stale: probeStale,
      overridden: probeOverridden
    },
    registered,
    expected,
    // The leak surface as the HOST registry sees it (the global view), which is
    // what another session's tool list is built from.
    schemas: names,
    leaks,
    grants: {
      default: WIN_MCP_AUX.grantDefault === true ? 'on' : 'off',
      on: [...WIN_MCP_AUX.grants.entries()].filter(([, value]) => value === true).map(([key]) => key)
    },
    revealed: [...WIN_MCP_AUX.revealedSessions],
    lastError: WIN_MCP.lastError,
    reason: WIN_MCP.reason,
    keepalive: { interval: WIN_MCP_KEEPALIVE.interval, countMax: WIN_MCP_KEEPALIVE.countMax },
    gate: 'restrict+guard',
    keepaliveMs: windowsMcpPollMs(),
    bound: [...WIN_MCP_AUX.targets.entries()].map(([session, row]) => ({ session, name: row.name, at: row.at })),
    agents: WIN_MCP.agents.size,
    pending: WIN_MCP.inflight !== null,
    // J20-4: what an in-flight attach is currently aiming at, and the generation
    // it was born in — `pending` plus `attach.pendingName` is the window in which
    // a delete must kill the ticket instead of the (still '') name.
    attach: {
      generation: WIN_MCP.generation,
      pendingName: WIN_MCP_AUX.inflightTicket === null ? null : String(WIN_MCP_AUX.inflightTicket.name ?? ''),
      pendingDead: WIN_MCP_AUX.inflightTicket === null ? null : WIN_MCP_AUX.inflightTicket.dead === true
    },
    // J20-5: the executing session's view, and the ONE declared relaxation.
    viewer,
    implicitTarget: {
      active: WIN_MCP_AUX.implicitTargets.size > 0,
      reason: 'implicit-single-target',
      computers: knownWindowsComputers(),
      sessions: [...WIN_MCP_AUX.implicitTargets]
    },
    // J20-3: the supervisor's state bus, as this plugin consumes it.
    stream: {
      live: WIN_MCP_STREAM.live === true,
      supported: WIN_MCP_STREAM.supported,
      events: WIN_MCP_STREAM.events,
      lastEvent: WIN_MCP_STREAM.lastEvent,
      lastEventAt: WIN_MCP_STREAM.lastEventAt,
      readyAt: WIN_MCP_STREAM.readyAt,
      retryMs: WIN_MCP_STREAM.retryMs,
      error: WIN_MCP_STREAM.error,
      // The newest states the supervisor ANNOUNCED (verdict source #1), so
      // "why did it say offline?" is answerable from the payload alone.
      lastState: WIN_MCP_STREAM.stateLog.length === 0
        ? ''
        : `${WIN_MCP_STREAM.stateLog[WIN_MCP_STREAM.stateLog.length - 1].name}:${WIN_MCP_STREAM.stateLog[WIN_MCP_STREAM.stateLog.length - 1].state}`,
      stateEvents: WIN_MCP_STREAM.stateLog.length
    },
    ssh: WIN_MCP.client?.sshArgv?.() ?? (target !== null && Number(target.sshPort) > 0
      ? sshArgv({ host: target.host ?? '127.0.0.1', port: target.sshPort, user: target.user, keyPath: target.keyPath })
      : null),
    // The same facts as the ONE human-readable line the doctor's text carries.
    transportText,
    // The GUI-vs-MCP line, one sentence, Windows only by construction (this
    // doctor IS the Windows bridge's): the two lanes are not interchangeable.
    guiNote,
    gateError: WIN_MCP_AUX.gateError
  }
}

/**
 * The prompt the model always reads. Kept as lines so the REA paragraph can be
 * appended as one more sentence-pair, not rewrapped by hand.
 */
const CUA_PROMPT_LINES = [
  'This workspace has a personal Linux computer (a QEMU VM) driven by `cua_vm_*`; the user manages theirs in Plugins → Personal VM.',
  'Treat it as your own machine: install what the task needs there (apt, npm, pip, SDKs), build and test there, copy the artifact back with `cua_vm_get`, never install project toolchains into the harness image.',
  'Its `/workspace` is this same directory over 9p (files appear on both sides); if the share is missing, `cua_vm_put`/`cua_vm_get` still copy.',
  'Build inside the VM, not over the share, for thousand-file builds: copy the source to /tmp/build (or /home/cua/build), build, copy the artifact back — 9p carries source and results, not object files.',
  'Drive the desktop with `cua_vm_gui`: screenshot, click, type, hotkeys, drag, scroll, `zoom` to crop.',
  'COORDINATES: x/y is a pixel in the screenshot you just took, origin top-left; `cua_vm_gui` maps it to the display, so click the pixel you see — never rescale, never offset — the desktop is 1200x750.',
  'Choose deliberately: the shell for anything a command can do (gradle, adb, blender -b, apt, tests), the desktop for visual work or when the user says show me, click or test the UI.',
  'Before clicking, take the position from `a11y` (element bounds) or `windows`, then screenshot to confirm; without vision, trust the a11y bounds over guessed pixels.',
  'Before creating a computer, ask with `ask_user_question` for name, vCPU/RAM and image unless the user said so — never invent a spec silently — and say Debian and Arch need a built Cua disk, not a substitute image.',
  'For Android, Blender, WebGL or 3D work create it with `gpu: true` unless told otherwise (say so if the image or host cannot); an Android app is `cua_vm_create` with gpu, cpu 4, memory 8, diskGb 40, then `cua_vm_android` once (SDK + AVD), `cua-emulator` (`-no-window` for adb tests), `adb devices` before the APK, `cua_vm_exec` → `ls -l /dev/kvm` for nested KVM.',
  'On a GPU computer Xorg runs on virgl and reports OpenGL 4.3 (Mesa under-reports 4.2; the session lifts it); if an app refuses, check `cua_vm_gui geometry` or `glxinfo -B`, and use `LIBGL_ALWAYS_SOFTWARE=1` (llvmpipe, slower) only as a genuine, stated fallback.',
  'SPACE: the screenshot and the click share ONE space, and the tool measures it — every desktop result prints `screenshot WxH · display WxH · scale N`. When scale is 1 (a 1200x750 desktop) image pixels are display pixels; when it is not, the result says `image px = 0.9375 × display px; cua maps it — do not rescale`, and that is literal: click the pixel you see, never multiply it.',
  'SHUTDOWN vs SUSPEND: `cua_vm_shutdown` is a real ACPI powerdown, then a checkpoint, then the sandbox is removed (`state: powered-off`); `cua_vm_start` cold-boots from that checkpoint — do NOT expect `sb resume` to work on a powered-off computer, that is the trap the split exists for. `cua_vm_suspend` keeps the sandbox and resumes instantly. Neither happens on its own: the computer runs until the user asks.',
  'WINDOWS (`kind: "windows"`, direct QEMU + OVMF/TPM2): exec/put/get work over the guest OpenSSH server like the Linux computer (Session 0, cmd.exe, `C:\\` paths); the desktop is `cua_vm_gui` over QMP and the LIVE VIEW at /vm/port/<name>/ (noVNC), where a human can drive the same screen. Its GPU is a virtio-gpu with NO Windows 3D driver: Direct3D falls back to WARP (CPU), so do not promise hardware acceleration; there is no mouse-cursor overlay on this path (the real pointer is in the frame). QMP typing is ASCII-only, there is no RFB clipboard (the guest runs no clipboard agent, so `cua_vm_gui` has no `clipboard` action on Windows — use the panel Clipboard section, which drives a task in the user session), no accessibility tree and no window list — for element-level work use the dsh-cua tools when the guest advertises them. It cannot take `rea: true` or `android: true`; the generated password is per computer (Reveal), and SSH keys are per computer too.',
  'If a tool reports no VM, call `cua_vm_ensure` once, then `cua_vm_exec`.',
  'For reverse-engineering work — a feature to reimplement, a suspicious binary, an APK, an Electron app, a model file — create the computer with `rea: true` (and let the disk be at least 40 GB); REA is not installed on a computer created without it, and installing it by hand inside a 20 GB disk is the wrong fix.'
]

const CUA_PROMPT_BASE = CUA_PROMPT_LINES.join(' ')

/**
 * REA awareness, appended only when `reaCache` knows a computer has the kit.
 * Six sentences: where it is, how to call it, the analysis verbs, the coverage
 * the JSON actually proves, how to report evidence, and where the engine lives.
 */
function reaParagraph(names) {
  const where = names.length === 1 ? `the computer ${names[0]}` : `the computers ${names.join(', ')}`
  return [
    `REA (\`rea\`, Reverse Engineer Anything) is installed in ${where} and is the right tool for "how does this app work, show me the evidence".`,
    'Run it through `cua_vm_exec`, never from the harness shell: `rea --help`, then `rea doctor --json` and `rea doctor --provider ghidra --json` before trusting an analysis.',
    'Analysis verbs: `rea analyze ghidra` for a native binary, `rea search --kind procedures` to find a symbol, `rea analyze-javascript-application` for a JS or Electron tree, `rea inspect-managed-artifact` and `rea inspect-managed-members` for .NET, `rea inspect-android-package`, `rea search-android-classes`, `rea inspect-android-method` and `rea trace-android-references` for an APK, `rea inspect-analysis-view` to page through whatever was already analyzed.',
    'Coverage comes from the JSON, not from a hunch: `analyze ghidra`, `search --kind procedures`, `analyze-javascript-application`, `inspect-managed-artifact`, `inspect-managed-members`, `inspect-android-package`, `search-android-classes`, `inspect-android-method`, `trace-android-references`, `inspect-analysis-view` — each one answers what it ran on and what it could not see.',
    'Read the JSON, not the banner: state only what the evidence supports, name the unknowns explicitly, and when an output is large write it to a file and page it with `rea inspect-analysis-view` instead of pasting it.',
    'Static JavaScript and .NET need no native engine, so only native work needs Ghidra — the provider here — and a provider error is usually a missing or relative `GHIDRA_INSTALL_DIR` path; build and test the reimplementation in the same computer, then copy the artifact back with `cua_vm_get`.'
  ].join(' ')
}

export function apply(ctx, config = {}) {
  const socketPath = config.socketPath ?? '/tmp/cua-vm/supervisor.sock'
  const workspaceRoot = config.workspaceRoot ?? '/workspace'
  const defaultTier = config.defaultTier ?? 'slim'
  const defaultCpu = config.defaultCpu ?? 2
  const defaultMemory = config.defaultMemory ?? 4
  const maxOutputChars = config.maxOutputChars ?? 8000

  const call = (payload) => request(socketPath, payload)

  /**
   * REA AWARENESS IS GATED, NOT FREE.
   *
   * A paragraph telling the model to reach for Ghidra is worth its tokens on a
   * reverse-engineering turn and is noise on every other one — worse, it would
   * point at a `rea` binary the computer does not have. So the paragraph is
   * appended only while a computer in this registry carries `rea: true`, and
   * the answer comes from a cache filled out of band: the prompt path reads
   * `reaCache.vms` synchronously and never touches the socket. A refresh that
   * runs anyway (30 s TTL, on /cua/state, after create/start/delete) is a
   * single `vmList`, so a non-REA workspace pays zero prompt-path cost.
   */
  const REA_CACHE_TTL_MS = 30_000
  const reaCache = { at: 0, vms: [] }

  /**
   * The registry is `{ name: meta }`; a computer opts in with `rea: true`.
   *
   * J20-5: the same 30 s snapshot is also the ONLY cheap answer to "how many
   * Windows computers exist at all", which the implicit-single-target rule
   * needs. It is memory-only and refreshed off the prompt path, like the rest.
   */
  function rememberRea(registry) {
    const rows = Object.entries(registry ?? {})
    reaCache.vms = rows.filter(([, vm]) => vm?.rea === true).map(([name]) => name).sort()
    WIN_MCP_AUX.windowsRegistryNames = rows
      .filter(([, vm]) => String(vm?.kind ?? '') === 'windows')
      .map(([name]) => name)
      .sort()
    reaCache.at = Date.now()
  }

  async function refreshReaCache() {
    try {
      rememberRea((await call({ op: 'vmList' })).registry)
    } catch {
      // A supervisor that is not up yet must not make every assembly retry:
      // back the same 30 s window off, and keep the names already known.
      reaCache.at = Date.now()
    }
  }

  /**
   * WP-5: THE BRIDGE IS MODULE STATE (see the block above `apply`).
   *
   * This call only BINDS the host to that registry — it no longer owns a copy of
   * the bridge. The old code did, and that is why a delete left dead
   * `cua_win__*` names in every session: the disposers belonged to ONE ctx and
   * nothing outside that apply() could reach them.
   *
   * The state has TWO sources now, and neither owns a copy of the rules:
   * the supervisor's `subscribe` stream (a transition arrives in milliseconds,
   * see `WIN_MCP_STREAM`) and the 10 s `vmWindowsMcpState` poll behind it for a
   * supervisor that does not speak the op. Both end in the same
   * `resolveWindowsTarget` / `teardown` paths, so a tick never guesses a target
   * and never opens SSH twice (WIN_MCP.inflight).
   */
  bindWindowsMcpHost(ctx, call)

  /**
   * The Personal VM page's own API. It speaks the same socket as the tools, so
   * the page and the model can never disagree about a computer's state.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/cua',
    handler: async (req, res) => {
      const action = new URL(req.url ?? '/cua', 'http://localhost').pathname.replace(/^\/cua\/?/u, '')
      const send = (status, payload) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
      }
      const body = async () => {
        if (req.method !== 'POST') return {}
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const raw = Buffer.concat(chunks).toString('utf8')
        return raw === '' ? {} : JSON.parse(raw)
      }
      try {
        switch (action) {
          case 'state': {
            const [config, list] = await Promise.all([call({ op: 'configGet' }), call({ op: 'vmList' })])
            // The page polls this every few seconds while a machine starts, so
            // it is also the cheapest place to keep the REA cache warm.
            rememberRea(list.registry)
            return send(200, {
              ok: true,
              config: config.config,
              usedBytes: config.usedBytes,
              vms: list.registry,
              // The panel hides the Windows kind when the backend is off, so the
              // option never becomes a button that answers "disabled".
              windows: list.windows ?? { ok: false, reason: 'the supervisor is older than this plugin' }
            })
          }
          case 'config': return send(200, { ok: true, ...(await call({ op: 'configSet', config: await body() })) })
          case 'create': {
            const answer = await call({ op: 'vmCreate', ...(await body()) })
            // A computer created with `rea: true` is provisioned by the time
            // this answers, so the awareness paragraph can appear at once
            // instead of up to 30 s later.
            void refreshReaCache()
            return send(200, { ok: true, ...answer })
          }
          case 'start': {
            const answer = await call({ op: 'vmStart', ...(await body()) })
            void refreshReaCache()
            return send(200, { ok: true, ...answer })
          }
          case 'shutdown': {
            const answer = await call({ op: 'vmShutdown', ...(await body()) })
            return send(200, { ok: true, ...answer })
          }
          // F1: THE PANEL'S SUSPEND BUTTON HAD NO ROUTE. `shutdown` powers off
          // and `stop` is the legacy alias, but nothing answered `suspend`, so
          // the switch fell through to `default` and the button got a 404 with
          // "unknown action: suspend" — a plugin-dispatch gap, not a supervisor
          // one. The op name is the SAME one `cua_vm_suspend` sends ('suspend',
          // Linux `sb suspend` / Windows QMP stop), so the two entry points
          // cannot drift. `stop` keeps its legacy meaning and
          // DSH_CUA_VM_LEGACY_STOP still aliases it to suspend at the
          // supervisor, unchanged.
          case 'suspend': return send(200, { ok: true, ...(await call({ op: 'suspend', ...(await body()) })) })
          case 'gc': return send(200, { ok: true, ...(await call({ op: 'vmGc', ...(await body()) })) })
          case 'doctor': return send(200, { ok: true, ...(await call({ op: 'vmDoctor' })) })
          case 'space': return send(200, { ok: true, ...(await call({ op: 'vmSpace', ...(await body()) })) })
          case 'windowsStatus': return send(200, { ok: true, ...(await call({ op: 'vmWindowsStatus', ...(await body()) })) })
          // The generated Windows password, on demand only: the row carries a
          // `credentials: true` flag, the secret stays in the 0600 file.
          case 'windowsPassword': return send(200, { ok: true, ...(await call({ op: 'vmWindowsPassword', ...(await body()) })) })
          // U2: THE CLIPBOARD, THROUGH THE GUEST'S INTERACTIVE SESSION. The
          // supervisor drives the two on-demand tasks (cua-clip-set /
          // cua-clip-get) over the SSH channel it already has; the /cua switch
          // only forwards, so the panel and the model cannot drift. A computer
          // that is not ready answers `available: false` with the reason, which
          // is what the panel renders as the DISABLED section.
          case 'windowsClipboardSet': return send(200, { ok: true, ...(await call({ op: 'vmWindowsClipboardSet', ...(await body()) })) })
          case 'windowsClipboardGet': return send(200, { ok: true, ...(await call({ op: 'vmWindowsClipboardGet', ...(await body()) })) })
          // U4: the measured C: free space (throttled 60 s at the supervisor).
          case 'windowsFreeSpace': return send(200, { ok: true, ...(await call({ op: 'vmWindowsFreeSpace', ...(await body()) })) })
          case 'stop': return send(200, { ok: true, ...(await call({ op: 'stop', ...(await body()) })) })
          case 'delete': {
            const request = await body()
            const answer = await call({ op: 'vmDelete', ...request })
            // Deleting the last REA computer has to take the paragraph with it.
            void refreshReaCache()
            // WP-5: A DELETE FROM THE PANEL IS THE REPORTED LEAK. The guest MCP
            // tools must go NOW, not on the next 10 s tick — and the binding of
            // the session that created the computer goes with it.
            forgetSessionTarget(request.name)
            return send(200, { ok: true, ...answer })
          }
          case 'exec': return send(200, { ok: true, ...(await call({ op: 'exec', ...(await body()) })) })
          case 'metrics': return send(200, { ok: true, ...(await call({ op: 'vmMetrics', ...(await body()) })) })
          case 'view': return send(200, { ok: true, ...(await call({ op: 'view', ...(await body()) })) })
          case 'screenshot': return send(200, { ok: true, ...(await call({ op: 'screenshot', ...(await body()) })) })
          case 'input': return send(200, { ok: true, ...(await call({ op: 'input', ...(await body()) })) })
          case 'gui': return send(200, { ok: true, ...(await call({ op: 'gui', ...(await body()) })) })
          case 'pointer': return send(200, { ok: true, ...(await call({ op: 'pointer', ...(await body()) })) })
          default: return send(404, { ok: false, error: `unknown action: ${action}` })
        }
      } catch (error) {
        return send(503, { ok: false, error: String(error?.message ?? error) })
      }
    }
  }), 'cua-vm: page api')

  /**
   * THE COMPUTER USE GRANT — the switch the per-agent gate reads.
   *
   * It lives in MEMORY, per session, and it starts ON (see
   * `WIN_MCP_AUX.grantDefault` for why: it is a per-session in-memory safety
   * default, not a security boundary, and the off default cost every first-boot
   * test a manual step). ON is the default, not the only answer — the panel (or
   * a curl from the user's own shell) turns it OFF here, and `grant-off` stays a
   * real refusal. A mutating route is same-origin only, so no other page can
   * flip it either way.
   *
   *   GET  /dsh-cua-vm/cua-grant            -> { ok, default:'on'|'off', on, off, … }
   *   POST /dsh-cua-vm/cua-grant {"grant":true,"sessionId":"…"}
   *   POST /dsh-cua-vm/cua-grant {"grant":false,"sessionId":"…"}   (deny)
   *
   * `sessionId` is optional: without it the DEFAULT flips (every session that
   * has not overridden it). Nothing here is persisted, and a restart forgets it.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-cua-vm',
    handler: async (req, res) => {
      const send = (status, payload) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
      }
      const action = new URL(req.url ?? '/dsh-cua-vm', 'http://localhost').pathname.replace(/^\/dsh-cua-vm\/?/u, '')
      if (action !== 'cua-grant') return send(404, { ok: false, error: `unknown action: ${action}` })
      if (req.method !== 'POST') return send(200, { ok: true, ...windowsGrantSnapshot() })
      // CSRF: a mutating route must be same-origin. A request without an Origin
      // (curl, the user's own shell) is allowed; a cross-origin page is not.
      const origin = String(req.headers.origin ?? '')
      const host = String(req.headers.host ?? '')
      if (origin !== '' && host !== '') {
        let originHost = ''
        try { originHost = new URL(origin).host } catch { originHost = '' }
        if (originHost !== '' && originHost !== host) return send(403, { ok: false, error: 'cross-origin grant change refused' })
      }
      let body = {}
      try {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const raw = Buffer.concat(chunks).toString('utf8')
        body = raw === '' ? {} : JSON.parse(raw)
      } catch {
        return send(400, { ok: false, error: 'the grant body is not JSON' })
      }
      const sessionId = body.sessionId === undefined || body.sessionId === null ? '' : String(body.sessionId).slice(0, 128)
      return send(200, { ok: true, granted: body.grant === true, ...setWindowsGrant(sessionId, body.grant === true) })
    }
  }), 'cua-vm: computer use grant')


  ctx.systemPrompt.section({
    name: 'tool:cua_vm',
    order: 120,
    // Synchronous by construction: the cache may be up to 30 s old, and a
    // prompt must never wait on a socket. A stale read schedules the refresh
    // and answers from what it already knows.
    text: () => {
      if (Date.now() - reaCache.at > REA_CACHE_TTL_MS) void refreshReaCache()
      return reaCache.vms.length === 0 ? CUA_PROMPT_BASE : CUA_PROMPT_BASE + ' ' + reaParagraph(reaCache.vms)
    }
  })

  // Keep the cache warm even for a session that never opens the page: one
  // vmList every 30 s, unref'd so it can never hold the process open, and
  // cleared with the plugin. The initial fill is the same call.
  ctx.effect(() => {
    void refreshReaCache()
    const timer = setInterval(() => { void refreshReaCache() }, REA_CACHE_TTL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'cua-vm: rea awareness cache')

  /**
   * THE STATE POLL (10 s, `DSH_CUA_MCP_STATE_POLL_MS`).
   *
   * It is deliberately NOT the REA beat: a shutdown/delete must take the guest's
   * tools away inside a turn, not after 30 s, and the poll is one small socket
   * request per bound computer while it is idle. SSH is dialled only on the
   * transition into online (attachWindowsMcp checks inflight and retryAt).
   */
  ctx.effect(() => {
    void syncWindowsMcp('startup').catch(() => {})
    // J20-3: the push half. One long-lived subscription; if the supervisor does
    // not speak `subscribe` this silently degrades to the poll below.
    startWindowsStateStream(socketPath)
    const timer = setInterval(() => { void syncWindowsMcp('poll').catch(() => {}) }, windowsMcpPollMs())
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      clearInterval(timer)
      stopWindowsStateStream()
      // Teardown entry point #3: the plugin going away must not leave the
      // host-global names behind — the next mount would collide on them.
      teardown('plugin disposed')
      for (const agent of [...WIN_MCP.agents]) disposeWindowsAgent(agent)
    }
  }, 'cua-vm: windows mcp (state poll + state stream)')

  /**
   * THE PER-AGENT GATE (layer 3). `agent/created` installs the guard fiber and
   * the first restriction; `agent/pre-step` self-heals an offline bridge and
   * MUST always continue the step; `tools/change` re-applies after an attach or
   * a disposal; `agent/disposed` drops the grant, the reveal and the binding.
   */
  ctx.on('agent/created', ({ agent }) => { installWindowsAgent(agent) })
  ctx.on('agent/disposed', ({ agent }) => { disposeWindowsAgent(agent) })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      selfHealWindowsMcp(agent)
    } catch (error) {
      WIN_MCP_AUX.gateError = `pre-step: ${error?.message ?? error}`
    }
    // NEVER swallow the step: the bridge failing is not a reason to stall a turn.
    return next()
  })
  ctx.on('tools/change', () => { scheduleWindowsGates('tools/change') })

  /**
   * EVERY static registration in this file goes through here, so a tool cannot
   * be added without an envelope: the name must exist in `TOOL_TIMEOUTS`, and the
   * definition must declare that same number. The `timeoutMs` handed to
   * `ctx.tools.register` is the declared budget the harness timeout guard reads;
   * the body is additionally raced here (`boundedExecute`) because that guard is
   * cooperative and cannot free a supervisor call that never answers.
   */
  const registerCuaTool = (definition) => {
    // `hasOwn`, not a truthiness read: a tool named `constructor` must fail here
    // instead of picking a function off Object.prototype.
    if (!Object.hasOwn(TOOL_TIMEOUTS, definition.name)) {
      throw new Error(`cua-vm: ${definition.name} has no TOOL_TIMEOUTS entry — every tool registration must declare its timeout envelope`)
    }
    const declared = TOOL_TIMEOUTS[definition.name]
    if (definition.timeoutMs !== declared) {
      throw new Error(`cua-vm: ${definition.name} declares timeoutMs=${definition.timeoutMs}, TOOL_TIMEOUTS says ${declared}`)
    }
    return ctx.tools.register({
      ...definition,
      execute: boundedExecute(definition.name, declared, Object.hasOwn(PER_CALL_TIMEOUTS, definition.name) ? PER_CALL_TIMEOUTS[definition.name] : undefined, definition.execute)
    })
  }

  /**
   * The two tools that are NEVER gated (they do not start with TOOL_PREFIX):
   *   * `windows_desktop` reveals the bridged tools for the calling session;
   *   * `windows_mcp_doctor` reports the leak surface and the keepalive.
   */
  ctx.effect(() => registerCuaTool({
    name: REVEAL_TOOL_NAME,
    timeoutMs: TOOL_TIMEOUTS.windows_desktop,
    description: 'Reveal the Windows desktop: unhides this session\u2019s dsh-cua tools (element-level click/type/find over SSH) and returns their names, descriptions and parameters. No arguments.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput('Whether the tools are now visible, and their schemas.'),
    async execute(_args = {}, exec) {
      return { text: JSON.stringify(revealWindowsTools(exec?.agent)) }
    }
  }), 'cua-vm: windows desktop reveal')

  ctx.effect(() => registerCuaTool({
    name: DOCTOR_TOOL_NAME,
    timeoutMs: TOOL_TIMEOUTS.windows_mcp_doctor,
    description: 'Diagnose the Windows dsh-cua bridge: target, online state, this session\u2019s binding and target match, the in-flight attach generation, the state stream, registered names, global schemas, LEAKS (mcp__windows__* visible while offline), grants, revealed sessions, keepalive and the last error.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput('One JSON object: status, target, online, registered, schemas, leaks, grants, keepalive, gate.'),
    async execute(_args = {}, exec) {
      return { text: JSON.stringify(await windowsMcpDoctor(exec?.agent)) }
    }
  }), 'cua-vm: windows mcp doctor')


  registerCuaTool({
    name: 'cua_vm_status',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_status,
    description: 'VM for this workspace: state, spec, last command.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput('Human-readable VM status.'),
    async execute() {
      const status = await call({ op: 'status' })
      const vms = status.registry || {}
      const entries = Object.entries(vms)
      if (entries.length === 0) return { text: 'No VM has been created yet. Use cua_vm_ensure to create one.' }
      // A WINDOWS COMPUTER'S INSTALL IS POLLABLE FROM HERE TOO (B3): the row
      // alone says "installing"; `vmWindowsStatus` answers the same sentence the
      // panel shows (elapsed, the serial tail, the readiness signals) in ONE
      // small call, so an agent can watch an install without reading the log.
      const live = {}
      for (const [name, vm] of entries) {
        if (vm?.kind !== 'windows' || vm?.state !== 'installing') continue
        try {
          live[name] = await call({ op: 'vmWindowsStatus', name, tail: 5 })
        } catch {
          // A status poll may fail while the supervisor restarts; the row is
          // still worth printing.
        }
      }
      const lines = entries.map(([name, vm]) => {
        const info = live[name] ?? null
        return [
          `${name} (${vm.state || 'unknown'})`,
          `workspace=${vm.workspace}`,
          vm.kind === 'windows' ? null : `tier=${vm.tier}`,
          `cpu=${vm.cpu}`,
          `memory=${vm.memory}GB`,
          vm.diskGb > 0 ? `disk=${vm.diskGb}GB` : null,
          vm.kind === 'windows' ? `windows=${vm.windowsVersion || 'ISO'}` : null,
          vm.lastUsed ? `lastUsed=${vm.lastUsed}` : null,
          vm.rea === true ? 'rea=yes' : null,
          vm.lastCommand ? `lastCommand=${vm.lastCommand}` : null,
          vm.kind === 'windows' && info?.installDetail ? `install: ${info.installDetail}` : null,
          vm.kind === 'windows' && Array.isArray(info?.serialTail) && info.serialTail.length > 0
            ? `serial (last ${info.serialTail.length}): ${info.serialTail.join(' | ')}`
            : null,
          vm.kind === 'windows' && info?.operationalNote ? info.operationalNote : null
        ].filter(Boolean).join(' · ')
      })
      return { text: lines.join('\n') }
    }
  })

  registerCuaTool({
    name: 'cua_vm_ensure',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_ensure,
    description: 'Create or resume the workspace VM. Idempotent; the first call downloads the image.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        workspace: { type: 'string', description: 'Workspace path (default: root).' },
        tier: { type: 'string', enum: ['slim', 'full'], description: 'slim (default) or full.' },
        cpu: { type: 'integer', minimum: 1, maximum: 16 },
        memory: { type: 'integer', minimum: 1, maximum: 64, description: 'Guest memory in GB.' },
        waitForDesktop: { type: 'boolean', description: 'Wait for the desktop, not just the daemon.' },
        // The whole spec travels, not just tier/cpu/memory: a computer born
        // from "the first cua_vm_exec" used to record no image and no gpu, and
        // a rebuild then brought it back without them.
        image: { type: 'string', description: 'Image reference for a NEW computer (default "linux").' },
        gpu: { type: 'boolean', description: 'virgl GPU. Omit to take the host default (virgl when DSH_CUA_VM_GPU enables it); false forces llvmpipe.' },
        diskGb: { type: 'number', description: 'Disk size in GB for a new computer (Android and REA: 40).' },
        android: { type: 'boolean', description: 'Install the Android SDK + AVD on a new computer.' },
        rea: { type: 'boolean', description: 'Install the REA kit on a new computer (needs a 40 GB disk).' }
      }
    },
    output: textOutput('Creation result and the VM name to use in later calls.'),
    async execute(args = {}, exec) {
      const result = await call({
        op: 'ensure',
        workspace: args.workspace ?? workspaceRoot,
        tier: args.tier ?? defaultTier,
        cpu: args.cpu ?? defaultCpu,
        memory: args.memory ?? defaultMemory,
        waitDesktop: args.waitForDesktop === true,
        image: args.image,
        gpu: args.gpu,
        diskGb: args.diskGb,
        android: args.android === true,
        rea: args.rea === true
      })
      // WP-5: the computer this SESSION asked for. The bridge only ever attaches
      // to a name a session recorded, never to "the first ready row".
      rememberSessionTarget(exec, result.name)
      const gpuNote = result.gpu === true ? ' with a GPU (virgl)' : ''
      return { text: `${result.created ? 'Created' : 'Resumed'} ${result.name} (tier=${result.tier}, state=${result.state}${gpuNote}). Use this name with cua_vm_exec.` }
    }
  })

  registerCuaTool({
    name: 'cua_vm_create',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_create,
    description: 'New computer: name, kind, vCPU, RAM, image, gpu, diskGb, android, rea (Windows: windowsVersion/windowsIso). Ask the user for the spec first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Computer name: lowercase letters, digits and dashes.' },
        kind: { type: 'string', enum: ['linux', 'windows'], description: 'linux (default, the Cua guest) or windows (direct QEMU with OVMF/TPM2; exec/put/get work over SSH, the desktop is QMP plus a noVNC live view).' },
        cpu: { type: 'number', description: 'vCPUs (default 2; Windows floors at 2).' },
        memory: { type: 'number', description: 'RAM in GB (default 4; Windows floors at 6).' },
        image: { type: 'string', description: 'Image reference. Default "linux" (Ubuntu 24.04 slim Cua disk). Linux only.' },
        gpu: { type: 'boolean', description: 'virgl GPU for 3D/Android/Blender (Windows: GPU=Y + the render node).' },
        diskGb: { type: 'number', description: 'Disk size in GB. Omitted: 20 for Linux, 64 for Windows. Below a Windows floor (64 GB disk / 6 GB RAM / 2 vCPU) the computer is still created and the result carries a warning.' },
        android: { type: 'boolean', description: 'Install the Android SDK + AVD after creating (Linux only).' },
        rea: { type: 'boolean', description: 'Install the REA reverse-engineering kit (Node 22, rea-agents, JDK 21, Ghidra 12.1.4, JADX). Needs a 40 GB disk; it is raised to 40 when this is true. Linux only.' },
        windowsVersion: { type: 'string', enum: ['11', '11l', '11e', '10', '10l', '10e', '7u', 'xp', '2025', '2022', '2019', '2016', '2012', 'core11', 'tiny11', 'tiny10'], description: 'Windows version code (dockur/windows vocabulary): 11=Win 11 Pro, 11l=Win 11 LTSC, 11e=Win 11 Enterprise, 10=Win 10 Pro, 10l=Win 10 LTSC, 10e=Win 10 Enterprise, 7u=Win 7 Ultimate (SeaBIOS, experimental), xp=listed but refused (legacy-installer-unsupported: no Autounattend path), 2025/2022/2019/2016/2012=Server, core11/tiny11/tiny10=Tiny11/Tiny10 community media. Every code has an ordered ISO source chain (mido/ESD/mirrors) with sha256+size verification; aliases (11ltsc, ltsc11, ltsc10, win11, …) still work and canonicalise. Windows only.' },
        windowsIso: { type: 'string', description: 'Windows ISO instead of a version: an http(s) URL (downloaded once into $STORE/iso/) or a file path inside the VM store or the workspace (attached directly as a QEMU drive). Windows only; mutually exclusive with windowsVersion.' },
        windowsImageIndex: { type: 'integer', description: 'Windows only, optional: the /IMAGE/INDEX the answer file installs (1-based, as listed in the ISO sources/install.wim). Omit to use the version default: the pinned 11l media names its edition explicitly (/IMAGE/NAME), Server 2025 installs image 2 (Standard Evaluation, Desktop Experience), any windowsIso installs image 1. Needed only for an unusual ISO where those are wrong.' },
        windowsImageName: { type: 'string', description: 'Windows only, optional: the exact /IMAGE/NAME to install, e.g. "Windows 11 IoT Enterprise LTSC 2024 Evaluation". Wins over windowsImageIndex. Use it when the ISO carries several editions and the name is known exactly — a name that does not match the media fails the install.' }
      }
    },
    output: textOutput('The computer, its renderer, disk, Android and REA status.'),
    async execute(input, exec) {
      if (input.kind === 'windows') {
        // Refused HERE as well as in the supervisor: a tool that sends a
        // combination the backend will reject costs a round trip and reads like
        // a backend bug instead of a spec mistake.
        if (input.rea === true) throw new Error('REA is not available for Windows computers: the kit is a Linux guest layer. Create the Windows computer without it, or use a Linux computer.')
        if (input.android === true) throw new Error('Android is not available for Windows computers: the SDK and the AVD run in a Linux guest.')
        const answer = await call({ op: 'vmWindowsCreate', ...input })
        rememberSessionTarget(exec, answer.name)
        const parts = [`${answer.name} is ${answer.state} (Windows).`]
        if (answer.console) parts.push(`Live view: ${answer.console} (noVNC over QEMU VNC, never published raw).`)
        parts.push(answer.passwordHint)
        // The floors are DEFAULTS now: a below-floor request is created and the
        // warnings come from the supervisor, so the sentence describes what
        // actually happened instead of a silent raise.
        for (const warning of answer.warnings ?? []) parts.push(`WARNING: ${warning.message}`)
        parts.push('Once it is ready, `cua_vm_exec` runs commands over SSH in cmd.exe, `cua_vm_put`/`cua_vm_get` copy files over scp, and `cua_vm_gui` drives the screen over QMP — `cua_vm_disk`, Android and REA are the Linux-only ones.')
        if (answer.detail) parts.push(answer.detail)
        return { text: parts.join(' ') }
      }
      const answer = await call({ op: 'vmCreate', ...input })
      rememberSessionTarget(exec, answer.name)
      const parts = [`${answer.name} is ${answer.state}${input.gpu === true ? ' with a GPU (virgl)' : ''}.`]
      // A SPARSE DISK BIGGER THAN THE QUOTA IS CREATED, NOT REFUSED: the
      // supervisor sends `disk-over-policy` here (Linux and Windows alike), so
      // the sentence says what will actually go wrong instead of a refusal.
      for (const warning of answer.warnings ?? []) parts.push(`WARNING: ${warning.message}`)
      if (answer.renderer) parts.push(`Renderer: ${answer.renderer}.`)
      if (answer.disk && answer.disk.ok === false) parts.push(`Disk: ${answer.disk.error}`)
      else if (answer.disk && answer.disk.changed) parts.push(`Disk grown to ${answer.disk.sizeGb} GB (guest: ${answer.disk.guest || 'unknown'}).`)
      if (input.android === true) parts.push(answer.android ? 'Android SDK provisioned; boot it with `cua-emulator`.' : 'Android provisioning did not finish — see the output below.')
      // `rea` is true only when the guest's own marker was written after a
      // passing `rea doctor`; undefined/false means the kit is not there, and
      // Start re-runs the idempotent script.
      if (input.rea === true) parts.push(answer.rea ? 'REA is ready. Verify with `cua_vm_exec` → `rea doctor --provider ghidra --json`.' : 'REA provisioning did not finish — see the output below, then `cua_vm_start` once to retry (it is idempotent).')
      // The supervisor's own floor; the panel raises the field too, but the
      // tool is reachable without the panel.
      if (answer.diskGbRaised !== undefined) parts.push(`Disk was raised to ${answer.diskGbRaised} GB: the REA kit does not fit below 40 GB.`)
      // The paragraph must follow the create, not the next 30 s tick.
      if (input.rea === true) void refreshReaCache()
      if (answer.output) parts.push(`\n${answer.output}`)
      return { text: parts.join(' ') }
    }
  })

  registerCuaTool({
    name: 'cua_vm_gui',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_gui,
    description: 'Drive the VM desktop. x/y are pixels in the last screenshot and the tool maps them: click what you see. Start with `screenshot` or `geometry`; `zoom` a window for small controls.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'name'],
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'geometry', 'click', 'dclick', 'move', 'drag', 'type', 'key', 'hotkey', 'scroll', 'windows', 'a11y', 'clipboard', 'launch', 'open', 'zoom', 'unzoom'],
          description: 'What to do on the VM desktop.'
        },
        name: { type: 'string', description: 'Computer name from cua_vm_status / cua_vm_ensure.' },
        x: { type: 'number', description: 'X pixel for click/dclick/move/drag start.' },
        y: { type: 'number', description: 'Y pixel for click/dclick/move/drag start.' },
        x2: { type: 'number', description: 'X pixel for the drag end.' },
        y2: { type: 'number', description: 'Y pixel for the drag end.' },
        text: { type: 'string', description: 'Text to type.' },
        key: { type: 'string', description: 'Key name (enter, escape, tab, f5) or hotkey combination (ctrl+c, ctrl+shift+s).' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction.' },
        amount: { type: 'number', description: 'Scroll steps (default 3).' },
        app: { type: 'string', description: 'Application name for launch.' },
        window: { type: 'string', description: 'Window title for zoom (substring, from geometry/windows).' },
        path: { type: 'string', description: 'File or URL for open.' },
        save: { type: 'string', description: 'Guest path for the PNG (default /home/cua/shots/…).' },
        region: {
          type: 'object',
          description: 'Read-only crop; prefer `zoom` before clicking.',
          properties: {
            x: { type: 'number' }, y: { type: 'number' },
            width: { type: 'number' }, height: { type: 'number' },
            scale: { type: 'number', description: 'Magnification, 1-4 (default 1).' }
          }
        },
        relative: { type: 'boolean', description: 'Fractions 0-1 instead of pixels.' },
        smooth: { type: 'boolean', description: 'Animate the pointer (default true).' },
        steps: { type: 'number', description: 'Animation steps 1-8 (default 6).' },
        durationMs: { type: 'number', description: 'Unused.' }
      }
    },
    output: textOutput('What happened, or the screenshot path.'),
    async execute(input, exec) {
      const target = input.name
      const answer = await call({ op: 'gui', ...input, name: target })
      // Driving the desktop is an explicit statement of the target, so it binds.
      rememberSessionTarget(exec, target)
      return { text: answer.output || `${input.action} done` }
    }
  })

  registerCuaTool({
    name: 'cua_vm_disk',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_disk,
    description: 'Grow the disk online (QMP block_resize + growpart). No reboot; cannot shrink.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'sizeGb'],
      properties: {
        name: { type: 'string', description: 'Computer name from cua_vm_status.' },
        sizeGb: { type: 'number', description: 'New total disk size in GB (must be larger than the current one).' }
      }
    },
    output: textOutput('The new size and the guest filesystem after the grow.'),
    async execute({ name, sizeGb }) {
      const answer = await call({ op: 'vmDisk', name, sizeGb })
      if (answer.available === false) return { text: answer.message }
      if (answer.changed === false) return { text: `${name} is already ${answer.sizeGb} GB; nothing to do.` }
      return { text: `${name} disk is now ${answer.sizeGb} GB. Guest: ${answer.guest || 'unknown'}` }
    }
  })

  registerCuaTool({
    name: 'cua_vm_android',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_android,
    description: 'Install Google Android SDK + AVD inside the VM (~7 GB, needs 12 GB free). Boot with `cua-emulator`.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Computer name (must have a GPU-aware image and enough disk).' },
        api: { type: 'integer', description: 'Android API level (default 35).' },
        variant: { type: 'string', description: 'System image variant: google_apis (default, includes Google APIs), google_apis_playstore, or default.' },
        arch: { type: 'string', description: 'System image ABI (default x86_64; x86_64 needs KVM).' },
        avd: { type: 'string', description: 'AVD name (default cua).' }
      }
    },
    output: textOutput('Installed, plus the provisioning log tail.'),
    async execute(input) {
      const answer = await call({ op: 'vmAndroid', ...input })
      return { text: `Android SDK ready on ${input.name}. Start it with: cua-emulator\n${answer.output || ''}` }
    }
  })

  registerCuaTool({
    name: 'cua_vm_exec',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_exec,
    description: 'Run a shell command in the computer: bash in the Linux guest, cmd.exe over SSH on a Windows one.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'VM name from cua_vm_ensure / cua_vm_status.' },
        cmd: { type: 'string', description: 'Shell command to run inside the guest.' },
        cwd: { type: 'string', description: 'Guest working directory (absolute path inside the VM).' },
        timeout: { type: 'integer', minimum: 1, maximum: 3600, description: 'Seconds before the command is stopped. Default 300.' }
      },
      required: ['name', 'cmd']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exit: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          ms: { type: 'integer' }
        },
        required: ['exit', 'stdout', 'stderr', 'ms']
      },
      render: (_args, value) => [{
        type: 'text',
        text: `exit=${value.exit} (${value.ms} ms)\n${value.stdout}${value.stderr ? `\n[stderr]\n${value.stderr}` : ''}`
      }]
    },
    async execute(args = {}, exec) {
      const result = await call({ op: 'exec', name: args.name, cmd: args.cmd, cwd: args.cwd, timeout: args.timeout ?? 300 })
      // An exec names its computer explicitly, so it binds the bridge to it:
      // this is how a session that did not create the Windows computer still
      // gets its dsh-cua tools, WITHOUT falling back to "first ready row".
      if (result.available !== false) rememberSessionTarget(exec, args.name)
      if (result.available === false) {
        // A Windows computer has no guest agent. The schema still has to answer,
        // so the refusal travels in stderr with exit 126 — the shape a shell
        // command that cannot run uses.
        return { exit: result.exit ?? 126, stdout: '', stderr: result.stderr ?? 'not available for Windows computers', ms: 0 }
      }
      return {
        exit: result.exit,
        stdout: clamp(result.stdout, maxOutputChars),
        stderr: clamp(result.stderr, maxOutputChars / 2),
        ms: result.ms ?? 0
      }
    }
  })

  registerCuaTool({
    name: 'cua_vm_put',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_put,
    description: 'Copy a workspace path into the VM.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        local: { type: 'string', description: 'Path inside the workspace (absolute or relative to the workspace root).' },
        guest: { type: 'string', description: 'Absolute destination path inside the VM.' }
      },
      required: ['name', 'local', 'guest']
    },
    output: textOutput('Copy result.'),
    async execute(args = {}) {
      const result = await call({ op: 'put', name: args.name, local: args.local, guest: args.guest })
      if (result.available === false) return { text: result.message }
      return { text: `Copied ${result.local} → ${args.name}:${result.guest}` }
    }
  })

  registerCuaTool({
    name: 'cua_vm_get',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_get,
    description: 'Copy an artifact out of the VM into the workspace.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        guest: { type: 'string', description: 'Absolute source path inside the VM.' },
        local: { type: 'string', description: 'Destination inside the workspace (absolute or relative to the workspace root).' }
      },
      required: ['name', 'guest', 'local']
    },
    output: textOutput('Copy result with byte count.'),
    async execute(args = {}) {
      const result = await call({ op: 'get', name: args.name, guest: args.guest, local: args.local })
      if (result.available === false) return { text: result.message }
      return { text: `Copied ${args.name}:${result.guest} → ${result.local} (${result.bytes} bytes)` }
    }
  })

  registerCuaTool({
    name: 'cua_vm_port',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_port,
    description: 'Expose a guest port as /vm/port/<name>/.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        guestPort: { type: 'integer', minimum: 1, maximum: 65535 },
        localPort: { type: 'integer', minimum: 1, maximum: 65535 }
      },
      required: ['name', 'guestPort']
    },
    output: textOutput('The proxy path and the loopback port that reaches the guest port.'),
    async execute(args = {}) {
      const result = await call({ op: 'port', name: args.name, guestPort: args.guestPort, localPort: args.localPort })
      // The supervisor answers {url, localPort, guestPort, backend} — and used
      // to be read as `result.target`, which is undefined: every call printed
      // "reachable at undefined". Print BOTH: the url is what the user can open,
      // the loopback port is what a curl from the harness shell can reach.
      const via = result.backend === 'relay' ? ' (relayed from the container)' : ''
      return { text: `Guest port ${result.guestPort ?? args.guestPort} on ${result.name ?? args.name} is reachable at ${result.url}${via} — from the harness shell: http://127.0.0.1:${result.localPort}/` }
    }
  })

  /**
   * START is its own tool because a powered-off computer does NOT resume.
   *
   * `cua sb resume` only works while cua still knows the sandbox; a shutdown
   * removes it on purpose (that is what makes the powerdown real), so the
   * natural-looking call fails for ever. `cua_vm_start` cold-boots from the
   * checkpoint — the model does not need to know why, only that this is the
   * button.
   */
  registerCuaTool({
    name: 'cua_vm_start',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_start,
    description: 'Start a computer: resumes a suspended one, cold-boots a powered-off one from its checkpoint. Not for a Windows install in progress.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Computer name from cua_vm_status.' }
      }
    },
    output: textOutput('Start result, the boot source, and the provisioning outcome.'),
    async execute(args = {}, exec) {
      const answer = await call({ op: 'vmStart', name: args.name })
      // A start is the transition into online: bind now and poll once, instead
      // of waiting up to a full interval for the tools to appear.
      rememberSessionTarget(exec, args.name)
      void syncWindowsMcp('started').catch(() => {})
      const parts = [`${answer.name} is ${answer.state}.`]
      if (answer.coldBoot === true) parts.push(answer.detail || 'cold-booted from its checkpoint.')
      if (answer.bootedFrom === 'image') parts.push('No checkpoint was available, so it booted the base image: the previous disk is gone.')
      if (answer.provisioned === false) parts.push(`Guest provisioning did not finish:\n${(answer.output || '').slice(-1200)}`)
      if (answer.rea === false) parts.push('REA did not finish provisioning; call cua_vm_start again (it is idempotent).')
      if (answer.detail && answer.coldBoot !== true) parts.push(answer.detail)
      if (answer.console) parts.push(`Console: ${answer.console}`)
      return { text: parts.join(' ') }
    }
  })

  /**
   * SHUTDOWN is a real power-off: ACPI `system_powerdown`, wait for the process
   * to exit (or `query-status` to say shutdown), flatten the disk into a
   * checkpoint, remove the sandbox, and record `powered-off` + `restoreFrom`.
   * The alternative (`cua_vm_suspend`) keeps the sandbox and resumes instantly;
   * the difference matters because a suspended computer still holds its RAM and
   * its QEMU process.
   */
  registerCuaTool({
    name: 'cua_vm_shutdown',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_shutdown,
    description: 'Power the computer off: ACPI powerdown, checkpoint, sandbox removed, state powered-off. Start cold-boots it. Only when the user asks.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Computer name from cua_vm_status.' }
      },
      required: ['name']
    },
    output: textOutput('The method used, the checkpoint, and any warning.'),
    async execute(args = {}) {
      const answer = await call({ op: 'vmShutdown', name: args.name })
      const parts = [`${answer.name} is ${answer.state} (${answer.method}).`]
      if (answer.fallback === 'acpi-unsupported') parts.push(answer.detail)
      else {
        // THE ANSWER LEAVES BEFORE THE CONVERT (WINDOWS_STOP_BUDGET_MS in the
        // supervisor): `checkpoint: 'deferred'` means the disk is being captured
        // in the background, so the sentence must not read like a path that was
        // written — and must say the badge already shows powered-off, which is
        // the whole point of answering first.
        if (answer.checkpoint === 'deferred') parts.push('Checkpoint: deferred — runs in the background; the panel badge shows powered-off immediately.')
        else if (answer.checkpoint) parts.push(`Checkpoint: ${answer.checkpoint}.`)
        if (answer.restoreFrom?.kind === 'image') parts.push('No checkpoint was written, so Start boots the base image.')
        if (answer.mayBeTorn) parts.push('The guest did not power down in time, so the image is marked mayBeTorn: the disk was captured after a forced quit.')
        if (Array.isArray(answer.notes) && answer.notes.length > 0) parts.push(`Notes: ${answer.notes.join('; ')}`)
      }
      parts.push('`cua_vm_start` boots it again; `cua_vm_resume` will NOT (a powered-off computer has no sandbox to resume).')
      return { text: parts.join(' ') }
    }
  })

  /** Garbage collection, so a store does not fill with dead 6 GB files. */
  registerCuaTool({
    name: 'cua_vm_gc',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_gc,
    description: 'Clean the VM store: orphan checkpoints (newest kept), restore temps, screenshots older than the retention, stale viewer rows, dead port rows.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dryRun: { type: 'boolean', description: 'Report what would go, delete nothing.' }
      }
    },
    output: textOutput('What was (or would be) removed, and the bytes freed.'),
    async execute(args = {}) {
      const answer = await call({ op: 'vmGc', dryRun: args.dryRun === true })
      const lines = []
      const list = (label, rows) => {
        if (!Array.isArray(rows) || rows.length === 0) return
        lines.push(`${label} (${rows.length}):`)
        for (const row of rows.slice(0, 12)) lines.push(`- ${row.file ?? row.name} — ${row.reason}`)
      }
      list('checkpoints', answer.checkpoints)
      list('screenshots', answer.shots)
      list('viewer rows', answer.views)
      list('port rows', answer.ports)
      if (Array.isArray(answer.orphans) && answer.orphans.length > 0) {
        lines.push(`orphaned rows (${answer.orphans.length}):`)
        for (const row of answer.orphans) lines.push(`- ${row.name}: ${row.sandbox}, ${row.action}`)
      }
      if (Array.isArray(answer.sandboxes) && answer.sandboxes.length > 0) {
        lines.push(`sandboxes cua lists with no row (${answer.sandboxes.length}) — not touched, they may belong to another install:`)
        for (const row of answer.sandboxes.slice(0, 8)) lines.push(`- ${row.name} (${row.status})`)
      }
      if (lines.length === 0) lines.push('Nothing to clean: no orphan checkpoint, no expired screenshot, no stale row.')
      lines.push(`${answer.dryRun === true ? 'Would free' : 'Freed'} ${(answer.bytesFreed / 1024 ** 2).toFixed(1)} MB; store now ${(answer.usedBytes / 1024 ** 3).toFixed(1)} GB.`)
      if (Array.isArray(answer.errors) && answer.errors.length > 0) lines.push(`Errors: ${answer.errors.slice(0, 5).join('; ')}`)
      return { text: lines.join('\n') }
    }
  })

  /** Host capabilities, from the one process that can actually see them. */
  registerCuaTool({
    name: 'cua_vm_doctor',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_doctor,
    description: 'Diagnose the host: /dev/kvm, render node, QEMU virgl support, Docker engine reachability, store accounting, policy.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput('Host capabilities, the Windows version codes this host can install, and the store policy, one line per fact.'),
    async execute() {
      const answer = await call({ op: 'vmDoctor' })
      const caps = answer.hostCaps ?? {}
      const windows = answer.windows ?? {}
      const store = answer.store ?? {}
      // THE VERSION LIST IS THE SUPERVISOR'S, NOT A GUESS. `vmDoctor` already
      // carries `windows.versions` (16 canonical codes), so the doctor prints it
      // and returns it structured: the model used to choose from a stale
      // 6-code `enum` in the tool schema and could not tell an alias from an
      // unsupported version.
      const versions = Array.isArray(windows.versions) ? windows.versions.map((code) => String(code)) : []
      return {
        text: [
          // The device and its ACCESS are two facts: "present but DENIED" is
          // the group/gid bug (uid 1000 is not in the device's group), and it
          // used to read as "NOT usable" with no way to tell it from a missing
          // node. Never collapse them.
          `kvm: ${caps.kvm}${caps.kvmUsable ? '' : (caps.kvmState === 'denied' ? ` (mounted but NOT openable by this uid — ${caps.kvmMode ?? '?'} owner ${caps.kvmOwner ?? '?'}, groups ${Array.isArray(caps.kvmGroups) && caps.kvmGroups.length > 0 ? caps.kvmGroups.join(',') : 'none'}: add KVM_GID to group_add, see the README)` : ' (NOT usable — the computer cannot start)')}`,
          `render node: ${caps.renderNode}`,
          `system qemu: ${caps.systemQemu}`,
          `virtio-gpu-gl-pci: ${caps.virtioGpuGl ? 'yes' : 'no'} (DSH_CUA_VM_GPU=${caps.gpuMode}; default gpu=${caps.gpuDefault})`,
          `desktop: ${caps.desktop}${caps.resolutionAllowed ? '' : ' (refused: above cua\'s capture budget — set DSH_CUA_VM_RESOLUTION_ALLOW_SCALE=1 to accept a scaled capture)'}`,
          `workspace share: ${caps.share}`,
          `docker engine: ${caps.docker}`,
          `windows: ${windows.enabled
            ? `enabled (direct qemu: ${windows.hostCaps?.qemu ? 'present' : 'MISSING'}, OVMF ${windows.hostCaps?.ovmfCode ? 'present' : 'MISSING'}, swtpm ${windows.hostCaps?.swtpm ? 'present' : 'MISSING'}, KVM ${windows.hostCaps?.kvm ? (windows.hostCaps?.kvmUsable ? 'present' : 'present but NOT openable by this uid (gid/group_add)') : 'MISSING'})`
            : `disabled (${windows.reason})`}`,
          `windows versions: ${versions.length > 0 ? `${versions.length} code(s): ${versions.join(', ')}` : 'unknown (the supervisor is older than this plugin)'}`,
          `store: ${(store.usedBytes / 1024 ** 3).toFixed(1)} GB of ${(store.quotaBytes / 1024 ** 3).toFixed(0)} GB`,
          `policy: shutdownTimeoutSec=${answer.shutdownTimeoutSec} checkpointPolicy=${answer.checkpointPolicy} computers=${answer.vms}`
        ].join('\n'),
        // The structured half: `text` is what the model reads, this is what a
        // caller (or a test) can branch on without parsing prose.
        windows: {
          enabled: windows.enabled === true,
          versions,
          isoSources: windows.isoSources ?? null
        }
      }
    }
  })

  registerCuaTool({
    name: 'cua_vm_suspend',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_suspend,
    description: 'Pause the computer and keep its disk (resume is instant). Linux: cua sb suspend. Windows: QMP stop. For a real power-off use cua_vm_shutdown.',
    parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } }, required: ['name'] },
    output: textOutput('Suspend result.'),
    async execute(args = {}) {
      const result = await call({ op: 'suspend', name: args.name })
      if (result.kind === 'windows') return { text: `${result.name} is suspended (the VM is paused with QMP stop; Start continues it).` }
      return { text: `${result.name} suspended; its disk stays in the VM store.` }
    }
  })

  registerCuaTool({
    name: 'cua_vm_destroy',
    timeoutMs: TOOL_TIMEOUTS.cua_vm_destroy,
    description: 'Delete the VM and everything it left in the store. Only when the user asks. `force: true` kills the QEMU/swtpm/websockify processes FIRST and then removes what is left — use it when a normal delete reported failures.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        force: { type: 'boolean', description: 'Force delete: kill the VM process (QEMU/swtpm/websockify) and remove its disks even if the normal delete reported failures — the row, disks, ports and registry row all go. Ask for confirmation first: it is destructive.' }
      },
      required: ['name']
    },
    output: textOutput('Destroy result, the items that survived, and the kill log when force was used.'),
    async execute(args = {}) {
      const result = await call({ op: 'destroy', name: args.name, force: args.force === true })
      // Teardown entry point: a deleted computer must lose its names HERE, not
      // on the next poll — this is the delete that used to leak for minutes.
      forgetSessionTarget(args.name)
      const killed = (result.force?.killed ?? []).map((item) => `- ${item.status === 'removed' ? 'KILLED' : 'STILL RUNNING'} ${item.target}: ${item.detail}`).join('\n')
      if (result.complete === false) {
        // A PARTIAL manifest is not a deletion, and a KEPT item is the usual
        // case: a disk whose QEMU is still running is deliberately left alone,
        // so the row stays (orphaned) and cua_vm_gc reclaims it once the process
        // is gone. Print both lists: what failed and what was kept on purpose.
        const failed = (result.failed ?? []).map((item) => `- FAILED ${item.target}: ${item.detail}`).join('\n')
        const kept = (result.kept ?? []).map((item) => `- KEPT ${item.target}: ${item.reason}`).join('\n')
        const offer = result.canForce === true && args.force !== true
          ? '\nCall cua_vm_destroy again with force: true to kill the process and remove what is left.'
          : ''
        return { text: `${result.name} was NOT fully deleted. ${result.detail ?? ''}\n${[kept, failed, killed].filter(Boolean).join('\n')}${offer}` }
      }
      return { text: `${result.name} destroyed (${result.items?.length ?? 0} store item(s) removed)${killed ? `.\n${killed}` : ''}. The next ensure starts from the base image.` }
    }
  })
}
