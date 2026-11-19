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
 * the health check is a RELAY_PING/RELAY_OK HANDSHAKE that depends on nothing
 * but a TCP port and a python interpreter (relayProbe()), carried as a base64
 * program so no shell metacharacter can break it on its way through
 * ssh → cmd.exe → python. It used to be `py -3 …mcp-relay.py --ping <port>`,
 * which was still a dependency on the guest PAYLOAD's CLI surface: a guest whose
 * staged `mcp-relay.py` predates `--ping` prints a usage line on stderr, nothing
 * on stdout, exits 2 — and that was read as RELAY_DOWN while a healthy relay was
 * running, which pinned every attach to the blind session-0 lane (P0, measured).
 * A probe that cannot see a working relay is no longer allowed to answer only
 * "down": relayProbe() classifies RELAY_SKEW (the relay SCRIPT answered and the
 * harness could not read it — a usage line, an unknown option, a cannot-find
 * that names mcp-relay.py) apart from RELAY_DOWN, and repairRelay() can rebuild
 * the launcher + task from the harness instead of waiting for a re-provision.
 * An INTERPRETER-MISSING failure (`'py' is not recognized…`, `command not
 * found`) is RELAY_DOWN, never SKEW: the payload never ran, so nothing about it
 * was answered — see classifyRelayProbeAnswer().
 * `python -m dsh_cua.server --stdio` is kept ONLY as the degraded fallback,
 * recorded with SESSION0_FALLBACK_REASON (RELAY_SKEW gets SESSION0_SKEW_REASON)
 * so nothing pretends it can drive the desktop, and a fallback attach now
 * UPGRADES itself onto the relay the moment the logon task makes the relay
 * answer (see maybeUpgradeTransport).
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
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

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
 * WHAT THE THREE RECEIPTS MEAN — FROZEN STRINGS (WP-4.4, SOL Appendix C).
 *
 * The plugin publishes upstream's tool descriptions VERBATIM (index.js appends
 * only `" (dsh-cua, Windows computer <name>)"`), so the model reads a contract
 * nobody verifies: `open_application` returns when `os.startfile` was accepted,
 * `send_keys` has no `effect_verified`, and `capture_window` has no redirect
 * path at all (an empty `save_path` is a DOCUMENTED DEFAULT, not a silent
 * relocation). Three defects, one class: the receipt is fine, the description
 * implied more than the receipt proves. Nothing upstream changes — the plugin
 * appends the honest sentence and the same text is returned by
 * `windows_desktop`'s `tools[]`, so the registry and the reveal cannot
 * disagree.
 *
 * FROZEN: byte-identical to Appendix C. Keyed by GUEST tool name; every other
 * tool gets `''` and its description stays exactly
 * `<guest description> (dsh-cua, Windows computer <name>)` — that is how the
 * scope of this change is proved (P5: 3 notes, 16 byte-identical controls).
 */
export const WINDOWS_TOOL_CONTRACT = Object.freeze({
  tool_open_application: 'Contract: returns when Windows ACCEPTED the launch, not when a window appeared — poll tool_list_windows and dedupe by pid before retrying, or a retry starts a second instance.',
  tool_send_keys: 'Contract: success means the keys were injected into the FOREGROUND window, not that the app acted on them (this receipt has no effect_verified) — confirm with tool_capture_window or a tool_list_windows read-back before assuming it worked.',
  tool_capture_window: 'Contract: an EMPTY save_path writes under %TEMP%\\win32_mcp_shots (that is the default, not a redirect); a non-empty save_path that cannot be written FAILS with PermissionError and does not fall back — use C:\\cua-work\\... inside the guest.'
})

/**
 * The note for ONE guest tool: `''` for the other sixteen (WP-4.4/C5).
 *
 * Accepts either the bare guest name (`tool_send_keys`) or the harness name
 * (`mcp__windows__tool_send_keys`), because index.js has both in scope and a
 * caller that has to remember which one this wants is how a note silently
 * stops being appended.
 */
export function windowsToolContract(guestName) {
  const bare = windowsGuestToolName(guestName)
  const note = WINDOWS_TOOL_CONTRACT[bare]
  return typeof note === 'string' ? note : ''
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

/**
 * The SAME record for the other failure: the RELAY SCRIPT answered (a usage
 * line, an unknown option, a cannot-find that names mcp-relay.py) and the
 * harness probe could not read the answer.
 *
 * It is a SECOND constant, not a reworded first one, because the two sentences
 * are different diagnoses with different next actions: RELAY_DOWN means "start
 * the relay" (or install the interpreter — DEFECT 3: a guest with no `py` is
 * DOWN, not skew), RELAY_SKEW means "the relay is probably running — fix the
 * probe or the payload". Keeping SESSION0_FALLBACK_REASON byte-identical
 * matters: needles, tests and every log line written since J22-14 match on it.
 */
export const SESSION0_SKEW_REASON = 'session-0 fallback (the guest relay answered, but the harness probe could not read it: payload mismatch; desktop automation will be blind)'

/** What the relay answers on the health probe. */
export const RELAY_OK = 'RELAY_OK'
export const RELAY_BAD = 'RELAY_BAD'
export const RELAY_DOWN = 'RELAY_DOWN'

/**
 * THE THIRD ANSWER, AND THE ONE THAT WAS MISSING (P0).
 *
 * `RELAY_SKEW` is not something a relay ever prints — it is the harness's own
 * verdict about a probe that produced NO token while the RELAY SCRIPT
 * demonstrably answered (a usage line / unknown option / cannot-find naming
 * `mcp-relay.py`). Without it the only possible answers were OK and DOWN, so
 * "the guest script does not know --ping" and "the relay is dead" were the same
 * value, and the first one is the state that made every attach blind while the
 * relay was healthy. DEFECT 3 narrowed it: a carrier failure that never reached
 * the payload (an interpreter that does not exist) is DOWN, not SKEW.
 */
export const RELAY_SKEW = 'RELAY_SKEW'

/**
 * DEFECT 3 (JURY-CO1): WHAT "THE GUEST ANSWERED" IS ALLOWED TO MEAN — AND THE
 * RANKING A CONSUMER MUST USE WHEN IT COLLAPSES SEVERAL ANSWERS INTO ONE.
 *
 * `RELAY_SKEW` used to accept ANY recognizable noise as proof that the carrier
 * ran, so cmd.exe's `'py' is not recognized as an internal or external command`
 * — a guest with NO python at all — was diagnosed as "the relay answered, the
 * harness probe could not read it", i.e. a payload/relay mismatch on a guest
 * where the relay could not even be STARTED. Worse, SKEW outranks measurement
 * downstream, so that carrier failure outranked a repair that had MEASURED
 * `session=0` / `hash=''` and hid the real cause behind a probe-skew fix.
 *
 * ONE OWNER, TWO FACTS:
 *
 *   RELAY_SKEW  the relay SCRIPT answered with something the probe could not
 *               read — a usage line, an unknown/invalid option, or a
 *               cannot-find that NAMES the relay script (`mcp-relay.py`). The
 *               carrier ran and the payload or the probe is wrong.
 *   RELAY_DOWN  nothing was measured. Silence, a carrier that never exited, and
 *               an INTERPRETER-MISSING failure (`is not recognized`, `not
 *               found`, `command not found`, `cannot find the path`) whose text
 *               names no relay script. This is NOT "the guest answered": the
 *               interpreter the probe needed never ran, so there is no payload
 *               evidence either. A bare exit code 2 with no relay-script
 *               reference is DOWN for the same reason.
 *
 * SKEW OUTRANKS DOWN. `relayAnswerRank()` / `relayAnswerOutranks()` are exported
 * so index.js (or any other consumer) ranks probe answers the same way the probe
 * itself does — SKEW (relay answered, unreadable) > DOWN (no answer) — instead
 * of re-deriving the order from strings. index.js's blind ladder already puts
 * the SKEW token above a plain DOWN/BAD token; these helpers exist so a future
 * consumer cannot disagree with it, and so the RANK lives next to the
 * classification that earns it. ORDERING NOTE: a repair record that MEASURED
 * the guest (session=0, hash='') is a STRONGER evidence class than either token
 * and is ranked ahead of both by that ladder — it is not a probe answer, so this
 * map deliberately does not order it.
 *
 * `RELAY_BAD` ranks with DOWN: the relay answered, but nothing about its payload
 * identity was measured (it is a refusal, not a payload mismatch) — it still
 * sets `payload.skew` (the relay DID answer), it just is not stronger evidence
 * than "nothing answered" for choosing a lane.
 */
export const RELAY_ANSWER_RANK = Object.freeze({
  [RELAY_OK]: 0,
  [RELAY_BAD]: 1,
  [RELAY_DOWN]: 1,
  [RELAY_SKEW]: 2
})

/** The rank of one probe status; an unknown/empty status ranks 0 (no evidence). */
export function relayAnswerRank(status) {
  return RELAY_ANSWER_RANK[String(status ?? '')] ?? 0
}

/** `true` when `left` carries stronger evidence than `right` (SKEW > DOWN). */
export function relayAnswerOutranks(left, right) {
  return relayAnswerRank(left) > relayAnswerRank(right)
}

/**
 * The relay SCRIPT by name. SKEW requires the guest's text to point at the
 * payload: only then did the relay (or its argparse) answer. A message about the
 * interpreter, the shell or the path names none of these and is not payload
 * evidence. `cua-mcp-relay` is the staged source name; `mcp-relay` the guest
 * copy and the VBS launcher.
 */
const RELAY_SCRIPT_REFERENCE_RE = /mcp-relay|cua-mcp-relay/iu

/** "The payload answered, the probe could not read it": usage/option noise. */
const RELAY_UNREADABLE_RE = /usage|invalid argument|unknown option|unrecognized argument|no such option|not recognized|cannot find/iu

/**
 * "The interpreter the probe needed was never there": cmd.exe, PowerShell and
 * POSIX shells all say one of these. Matched against the SAME text, but only
 * after the relay-script test failed, so a payload that names itself in a
 * cannot-find stays SKEW.
 */
const INTERPRETER_MISSING_RE = /is not recognized as an internal or external command|command not found|is not recognized|was not found|not found|no such file or directory|cannot find the (?:path|file)|cannot find the file/iu

/**
 * WAS THIS A RELAY-SCRIPT ANSWER THE PROBE COULD NOT READ (SKEW), OR AN
 * UNMEASURED FAILURE (DOWN)? Pure: one capture in, one status out. The probe
 * calls it per candidate and `answered` in `probeOneCandidate` is derived from
 * it, so the SKEW flag can no longer be set by a message about the interpreter.
 *
 * `stdout` is included because a stale payload may print its usage line there
 * (cmd.exe's own errors go to stderr, which is the reproduced carrier path).
 */
export function classifyRelayProbeAnswer({ stderr = '', stdout = '', exitCode = null } = {}) {
  const text = `${stderr ?? ''}\n${stdout ?? ''}`
  if (RELAY_SCRIPT_REFERENCE_RE.test(text) === true
    && (RELAY_UNREADABLE_RE.test(text) === true || exitCode === 2)) {
    return RELAY_SKEW
  }
  return RELAY_DOWN
}

/**
 * `true` when the guest's text is an interpreter/shell failure (`'py' is not
 * recognized…`, `python: command not found`, `The system cannot find the path
 * specified.`). Exported so a doctor can SAY "this guest has no interpreter"
 * instead of leaving the DOWN token to be read as "the relay is stopped".
 */
export function relayInterpreterMissing({ stderr = '', stdout = '' } = {}) {
  return INTERPRETER_MISSING_RE.test(`${stderr ?? ''}\n${stdout ?? ''}`)
}

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

/* ------------------------------------------------------------------ *
 * DEFECT 4 — THE PAYLOAD'S IDENTITY HAS TO BE ABLE TO SAY ITS FACTS
 * ------------------------------------------------------------------ */

/**
 * WHERE THE RELAY SCRIPT THIS BUILD SHIPS CAN BE READ FROM, harness side.
 *
 * `plugins/dsh-cua-vm/win-mcp.js` → `<repo>/docker/cua-mcp-relay.py` is the
 * checkout layout (the script sits BESIDE `docker/windows-oem/`); the image
 * payload layout copies it INTO that directory. Both are probed, in that order,
 * and the first readable file wins — the same two layouts
 * `resolveOemPayloadSourceFile()` accepts in docker/cua-vm-windows-qemu.mjs, kept
 * as relative URLs so the resolution is independent of `process.cwd()`.
 */
export const RELAY_EXPECTED_HASH_SOURCES = Object.freeze([
  '../../docker/cua-mcp-relay.py',
  '../../docker/windows-oem/cua-mcp-relay.py'
])

/** Read-once cache: `{ loaded, hash, source }`. The hash is a lower-case hex SHA-256. */
let relayExpectedHashState = { loaded: false, hash: null, source: null }

/** The absolute path of the shipped relay script, or null when this build has none. */
export function relayExpectedHashSource() {
  for (const relative of RELAY_EXPECTED_HASH_SOURCES) {
    try {
      const url = new URL(relative, import.meta.url)
      const candidate = decodeURIComponent(url.pathname)
      if (existsSync(candidate) === true) return candidate
    } catch {}
  }
  return null
}

/** SHA-256 of one file, lower-case hex; null when the file cannot be read. */
function sha256OfFile(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').toLowerCase()
  } catch {
    return null
  }
}

/**
 * DEFECT 4(a): THE HASH OF THE RELAY SCRIPT **THIS BUILD** SHIPS.
 *
 * `windowsPayloadFacts()` in index.js has always READ `payload.expectedRelayHash`
 * and NEITHER doctor producer ever wrote it, so the field was structurally null
 * and "the guest runs a different relay than the harness ships" could not be
 * said. This produces it from the bytes on the harness side — the same file the
 * OEM payload stages onto the guest — as a lower-case hex SHA-256, the exact
 * format the guest's `Get-FileHash … .Hash.ToLowerInvariant()` writes into
 * Appendix B's `hash=`.
 *
 * `null` MEANS **UNKNOWN**, NOT "no payload": this build may be an installed
 * plugin bundle that carries no `docker/` tree, and an installed bundle without
 * the source cannot claim a hash. Compare it against `payload.relayHash` only
 * when BOTH are non-null; `null` is "cannot tell", never "mismatch".
 *
 * Read ONCE, at first use (`relayExpectedHashState`), so a probe/doctor never
 * pays for a file read twice. An explicit `sourcePath` bypasses the cache and is
 * read as given — that is the seam a test (or a caller with a relocated payload)
 * uses. Call `resetExpectedRelayHashCache()` after replacing the file.
 */
export function expectedRelayHash(sourcePath = null) {
  if (sourcePath !== null && sourcePath !== undefined && sourcePath !== '') {
    return sha256OfFile(String(sourcePath))
  }
  if (relayExpectedHashState.loaded === true) return relayExpectedHashState.hash
  const source = relayExpectedHashSource()
  relayExpectedHashState = {
    loaded: true,
    // A build without the source has an UNKNOWN identity (`null`), never "" —
    // "" is the guest-side fact "there is no relay script on this guest".
    hash: source === null ? null : sha256OfFile(source),
    source
  }
  return relayExpectedHashState.hash
}

/** Which file the cached hash came from, or null (diagnostics + tests). */
export function expectedRelayHashSourcePath() {
  expectedRelayHash()
  return relayExpectedHashState.source
}

/** Forget the read-once hash (a test, or a caller that replaced the payload). */
export function resetExpectedRelayHashCache() {
  relayExpectedHashState = { loaded: false, hash: null, source: null }
}

/**
 * DEFECT 4(c): WHAT `payload.skew` MEANS, IN THE WORDS THE DOCS MUST QUOTE.
 *
 * The flag used to be documented as "the two payloads differ", which is a claim
 * nothing measured: it is derived from the PROBE token and the guest repair
 * record, never from a hash comparison. The honest sentence is this constant —
 * writer G's README text should quote it verbatim:
 *
 *   payload.skew = true   the guest relay ANSWERED and the harness probe could
 *                         not read the answer (payload/interpreter mismatch):
 *                         relayStatus RELAY_SKEW (a usage line / unknown option
 *                         / cannot-find naming mcp-relay) or RELAY_BAD, or the
 *                         last guest repair record says reason=probe-skew.
 *   payload.skew = false  no such evidence — which is NOT "the hashes match".
 *
 * A missing interpreter is NOT skew (it is RELAY_DOWN with
 * `interpreterMissing: true`), and a missing/old script is `measured` with an
 * empty or different `relayHash`.
 */
export const PAYLOAD_SKEW_SEMANTICS = 'payload.skew is true only when the guest relay ANSWERED and the harness probe could not read the answer (payload/interpreter mismatch): relayStatus RELAY_SKEW or RELAY_BAD, or the guest repair record says reason=probe-skew. It is not a hash comparison: a differing relayHash is reported as relayHash vs expectedRelayHash, and a missing interpreter is RELAY_DOWN (interpreterMissing), never skew.'

/**
 * DEFECT 5: THE DOCTOR FIELD SET, AND WHICH NAMES ARE CANONICAL.
 *
 * `relayDoctorFacts()` and the client's `doctorFacts()` must agree field for
 * field, so BOTH carry the canonical `transportCommand` / `transportReason`
 * (the names index.js spreads into windowsMcpDoctor and the ones the docs must
 * nominate) AND the legacy aliases `command` / `reason` (what relayDoctorFacts
 * used to emit and what earlier consumers read). The aliases are byte-identical
 * to their canonical partner, never a second value.
 *
 * THE PAYLOAD SET IS `windowsMcpDoctor()`'S, NOT THE CLIENT'S RAW ONE. The
 * doctor normalizes the payload before it reaches a report, so the documented
 * set carries two fields the client payload does not have to:
 *
 *   * `relayPresent` — `true` (a hash was read) / `false` (MEASURED, no script)
 *     / `null` (not measured). A measured empty `hash=` is normalized on the
 *     WIRE to `relayHash: null` + `relayPresent: false`, never `relayHash: ''`
 *     — `''` exists only inside the client/repair record;
 *   * `portMismatch` — `true` only when BOTH the guest-measured port and the
 *     harness port are known and they differ (an unknown pair is not a
 *     mismatch).
 *
 * `interpreterMissing` is emitted by the transport facts and reaches the doctor
 * by the `...transportFacts` SPREAD, so it is present whenever a client exists
 * and ABSENT (not `false`) when none does — read absence as "unknown", never as
 * "an interpreter was found". Writer G's README text should quote this
 * constant's set.
 *
 * WP-4.3 / WP-4.5 — THE TWO NEW CLIENT FIELDS, ADDED TO THIS ONE LIST SO THE
 * HELPER/CLIENT CONTRACT CANNOT DRIFT:
 *
 *   * `lastFailureKind` — on the FACTS (`doctorFacts()` only; the module-level
 *     `relayDoctorFacts()` has no session, so it cannot know). One of
 *     `'ssh-closed' | 'auth' | 'handshake' | 'unknown'` or `null`, beside the
 *     byte-identical `lastError` text: `ssh-closed` is the boot race (retry),
 *     `auth` is a key/account problem (retrying changes nothing), `handshake`
 *     means the session existed and the MCP exchange did not complete.
 *   * `desktop` — on the DOCTOR (`windowsMcpDoctor()`), the guest's own
 *     measurement read by `desktopFacts()`: `{ measured, at, stale, source,
 *     schema, user, session, python, dshCuaVersion, pywin32Version, win32ui,
 *     uiaLane, uiaLaneOk, elementLaneOk, scaleFix, workDir, workDirWritable,
 *     profileRootWritable, error }`. `measured !== true` means EVERY field is
 *     unknown — never `false` (a `false` is a measurement).
 */
export const DOCTOR_FACTS_FIELDS = 'canonical: transport, relayPort, relayOk, relayStatus, transportCommand, transportReason, interpreter, probeMode, relayDetail, repair, payload (all top-level); interpreterMissing rides along in the transport facts and passes through via the doctor spread when a client exists (absent, not false, when none does); aliases kept for existing consumers: command (= transportCommand), reason (= transportReason). payload as windows_mcp_doctor emits it: { measured, relayHash, expectedRelayHash, skew, port, portMeasured, relayPresent, portMismatch }; relayPresent is true (hash read) / false (measured, no script) / null (not measured), and a MEASURED empty hash= is normalized on the wire to relayHash: null + relayPresent: false, never relayHash: ""; portMismatch is true only when both the guest-measured port and the harness port are known and differ; skew is the relay-answered-but-unreadable evidence flag, not a hash comparison. Client-only facts (WP-4.3/4.5): lastFailureKind on the client facts — ssh-closed | auth | handshake | unknown | null, beside the byte-identical lastError text (ssh-closed is the boot race, auth is a key/account problem, handshake means the session existed and the MCP exchange did not complete); desktop on windowsMcpDoctor — the guest-measured desktop facts { measured, at, stale, source, schema, user, session, python, dshCuaVersion, pywin32Version, win32ui, uiaLane, uiaLaneOk, elementLaneOk, scaleFix, workDir, workDirWritable, profileRootWritable, error }, where measured !== true means every field is unknown and never false.'

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
 * The SAME relay client command, built from the interpreter the PROBE actually
 * reached (§4.2): `relayConnectCommand('python')` → `python <script> --connect`.
 *
 * An empty/unknown interpreter falls back to RELAY_COMMAND byte-for-byte, so the
 * default attach is unchanged and no needle or log line moves. That is the whole
 * point: the interpreter is an UPGRADE of the decision, never a rewrite of it.
 */
export function relayConnectCommand(interpreter = null) {
  const head = String(interpreter ?? '').trim()
  return head === '' ? RELAY_COMMAND : `${head} ${RELAY_SCRIPT} --connect`
}

/**
 * The probe's WALL budget: connect + run, not the ping itself.
 *
 * The old 8 s was sized for a PowerShell probe whose cold start alone was
 * ~4.6 s on a tiny10 guest, so right after boot the budget was already half
 * spent before the socket was opened — one slow CLR start and the probe
 * answered RELAY_DOWN for a relay that was alive, which pinned the attach to
 * the blind session-0 lane. The handshake is ~1-2 s and the SSH setup ~1 s, so
 * 12 s covers a cold ssh plus a cold `py`. A genuinely dead relay still costs
 * only 12 s, because the probe early-settles the instant an answer lands (see
 * relayProbe) — only a silent guest ever spends the whole window.
 *
 * ONE budget for ALL candidates: the deadline is computed once and each
 * candidate gets what is left, so three carries can never triple the wall.
 */
export const RELAY_PROBE_TIMEOUT_MS = 12000

/**
 * THE PROBE PROGRAM (Appendix A). Plain stdlib python, no import of the relay,
 * no dependency on the guest payload's CLI surface:
 *
 *   connect 127.0.0.1:<port> (1.5 s) → 2 s read timeout → send `RELAY_PING`
 *   → ACCUMULATE EXACTLY 8 BYTES → print RELAY_OK / RELAY_BAD / RELAY_DOWN
 *   → exit 0 always.
 *
 * The accumulate loop is not decoration. RELAY_OK is eight bytes ON THE WIRE,
 * not eight bytes in one syscall: a legal short read made the firstboot probe
 * answer "down" against a healthy relay, which then started a SECOND listener
 * and lost the bind with WinError 10048 (cua-firstboot.ps1:132-160). A probe
 * that reports a healthy relay as down is the defect this whole file is about,
 * so the same lesson is applied here.
 */
export function relayProbeProgram(port = relayPort()) {
  const target = Number.isInteger(Number(port)) ? Number(port) : RELAY_PORT_DEFAULT
  return String.raw`import socket as _s
_t = 'RELAY_DOWN'
try:
    _c = _s.create_connection(('127.0.0.1', ${target}), 1.5)
    _c.settimeout(2.0)
    _c.sendall(b'RELAY_PING')
    _b = b''
    while len(_b) < 8:
        _p = _c.recv(8 - len(_b))
        if not _p:
            break
        _b += _p
    _c.close()
    if _b == b'RELAY_OK':
        _t = 'RELAY_OK'
    elif _b.startswith(b'RELAY_BA'):
        _t = 'RELAY_BAD'
except Exception:
    _t = 'RELAY_DOWN'
print(_t)
`
}

/**
 * THE ORDERED CANDIDATES (P0's fix), each with the interpreter that must be used
 * for the session command if IT answers (§4.2).
 *
 *   1. `py -3 -c "<base64 program>"`     the launcher on PATH — measured working
 *   2. `python -c "<base64 program>"`    the interpreter the OLD guests resolve
 *   3. `py -3 <RELAY_SCRIPT> --ping <port>`   LEGACY, last resort
 *
 * WHY BASE64. The measured one-liner is a `-c` program full of quotes,
 * parentheses and `'`; the carrier has to survive `ssh → cmd.exe → python`, and
 * cmd.exe is where quoting breaks (a `"` split, a `%` expanded, a `^` eaten).
 * Base64 is alphanumeric plus `+/=`, so the payload crosses every one of those
 * parsers untouched — and the decoded program is exactly the program above.
 *
 * WHY `--ping` IS LAST. It is a mode of a script that is STAGED AT MACHINE
 * CREATE and never refreshed: on the measured guest it printed a usage line on
 * stderr and exited 2. It stays as the last resort because a fresh payload does
 * implement it, so it is a real third chance — never the first question.
 */
export function relayProbeCandidates(port = relayPort()) {
  const encoded = Buffer.from(relayProbeProgram(port), 'utf8').toString('base64')
  // The base64 alphabet is A-Z a-z 0-9 + / =, so the PROGRAM cannot smuggle a
  // `"`, `%`, `^`, `&` or `|` into the command line: the only quotes are the two
  // this line adds around `-c`.
  const carrier = `exec(__import__('base64').b64decode('${encoded}').decode())`
  return [
    { id: 'py3-handshake', mode: 'handshake', interpreter: 'py -3', command: `py -3 -c "${carrier}"` },
    { id: 'python-handshake', mode: 'handshake', interpreter: 'python', command: `python -c "${carrier}"` },
    { id: 'legacy-ping', mode: 'legacy', interpreter: 'py -3', command: legacyPingCommand(port) }
  ]
}

/**
 * THE THIRD CARRIER, NAMED. It is the same command this file has always used as
 * the probe — a mode of the guest payload — and that is exactly why it is LAST
 * now: the payload is staged at machine-create, so a guest can predate the mode
 * (P0). Keeping the builder means the legacy path stays a real, tested chance
 * instead of a string nobody can point at.
 */
function legacyPingCommand(port = relayPort()) {
  return `py -3 ${RELAY_SCRIPT} --ping ${port}`
}

/** The candidate commands, in order. `[0]` is what relayProbeCommand returns. */
export function relayProbeCommands(port = relayPort()) {
  return relayProbeCandidates(port).map((candidate) => candidate.command)
}

/**
 * THE FIRST CANDIDATE, KEPT AS A NAMED EXPORT.
 *
 * Existing callers, needles and tests know this name, and the first candidate is
 * the one that answers on every guest measured so far — so the name keeps
 * meaning "the probe command", it just no longer means "the relay's --ping".
 * The full ordered list is relayProbeCommands().
 */
export function relayProbeCommand(port = relayPort()) {
  return relayProbeCandidates(port)[0].command
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
 * WP-4.2: WAS THIS CAPTURE A CONNECTION-LEVEL FAILURE, OR DID SSH ACTUALLY RUN?
 *
 * The distinction the boot wait (WP-2.2) is built on: `exit 255` is ssh's own
 * "I never got a session" code, and the three messages below are the transport
 * saying the same thing in words (`sshd` not up yet, the banner not read, the
 * socket reset). Anything else — including exit 1 from a remote `type` that
 * found no file — means the SSH SESSION worked and the answer is the guest's.
 *
 * ONE OWNER, shared by `runSshCapture` (as the `connectionLevel` field) and
 * `classifySshFailureKind` (the `ssh-closed` failure kind), so the capture flag
 * and the doctor's vocabulary can never disagree. The pattern is the SOL's
 * WP-2.2 regex verbatim: `/Connection (closed|refused|reset)|
 * kex_exchange_identification|Connection timed out/iu`.
 *
 * PURE DATA (WP-4.2): adding the field changes no caller's behaviour. The boot
 * wait that CONSUMES it lives in the supervisor; this file only reports it.
 */
const SSH_CONNECTION_FAILURE_RE = /Connection (closed|refused|reset)|kex_exchange_identification|Connection timed out/iu

export function sshConnectionLevel({ exitCode = null, stderr = '' } = {}) {
  if (Number(exitCode) === 255) return true
  return SSH_CONNECTION_FAILURE_RE.test(String(stderr ?? ''))
}

/**
 * WP-4.3: WHAT KIND OF FAILURE WAS IT — without touching the sentence that
 * already reported it.
 *
 * `state.lastError` is a TEXT (the last stderr line, ≤400 chars) and every
 * consumer of it has to regex it to decide what to do next. This is the same
 * evidence, classified ONCE, into the four kinds the boot/attach race needs
 * (`SOL §4.7`, WP-5.1's `attaching` sentence and the doctor's `lastFailureKind`):
 *
 *   ssh-closed  the transport never had a session: exit 255, the connection
 *               messages, or a write that hit a dead pipe (EPIPE/ECONNRESET).
 *               "Retry" is the right next move — the guest is booting.
 *   auth        the transport worked and the KEY was refused (`Permission
 *               denied (publickey)`, too many authentication failures). Retrying
 *               changes nothing; the key or the account is wrong.
 *   handshake   a session existed and the MCP exchange did not complete
 *               (`initialize`, a protocol/JSON-RPC complaint). The guest is up;
 *               the server behind the lane is the problem.
 *   unknown     anything else — an exit code with no message, a spawn error.
 *               Honest: "something failed and this file cannot name it".
 *
 * The LAST ERROR TEXT IS NOT REWRITTEN (WP-4.3): the classification is an
 * additive field beside it, so a byte-identical `lastError` stays true.
 */
const SSH_AUTH_FAILURE_RE = /permission denied|publickey|authentication failed|too many authentication failures|no supported authentication|host key verification failed/iu
const SSH_HANDSHAKE_FAILURE_RE = /handshake|initialize|protocol version|json-?rpc|not an mcp|unexpected token|invalid response/iu
const SSH_LINK_DEAD_RE = /EPIPE|ECONNRESET|ECONNREFUSED|socket hang up|broken pipe/iu

export function classifySshFailureKind({ text = '', exitCode = null } = {}) {
  const body = String(text ?? '')
  if (sshConnectionLevel({ exitCode, stderr: body }) === true) return 'ssh-closed'
  if (SSH_LINK_DEAD_RE.test(body) === true) return 'ssh-closed'
  if (SSH_AUTH_FAILURE_RE.test(body) === true) return 'auth'
  if (SSH_HANDSHAKE_FAILURE_RE.test(body) === true) return 'handshake'
  return 'unknown'
}

/**
 * ONE ssh child, bounded, with the drain-safe settle every probe in this file
 * needs. Returns `{ stdout, stderr, exitCode, detail, timedOut, ms,
 * connectionLevel }` and never rejects: a spawn that throws, an 'error' event, a
 * timeout and a clean exit are all just a capture with empty output.
 *
 * 'exit' means the PROCESS is gone, not that its pipes are drained: stdout data
 * already written can still be sitting in the stream when 'exit' fires. Settling
 * there raced the drain and recorded a HEALTHY relay as RELAY_DOWN — which then
 * pinned the attach to the blind session-0 lane for the whole cache TTL. 'close'
 * fires only after every stdio stream is closed, so it is the drain-safe event
 * and the one that decides. The short backstop below only exists so a spawn stub
 * that never emits 'close' cannot hold the probe to its full timeout; a real
 * child always reaches 'close' first.
 */
export function runSshCapture({ argv, spawnImpl, timeoutMs, now, onStdout }) {
  return new Promise((resolve) => {
    const startedAt = now()
    const budget = Math.max(1, Math.round(Number(timeoutMs)))
    let settled = false
    let stdout = ''
    let stderr = ''
    let timer = null
    let graceTimer = null
    let child = null
    let exited = false
    let exitCode = null
    let timedOut = false
    const finish = (detail) => {
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
      resolve({ stdout, stderr, exitCode, detail, timedOut, ms: Math.max(0, now() - startedAt), connectionLevel: sshConnectionLevel({ exitCode, stderr }) })
    }
    try {
      child = spawnImpl('/usr/bin/ssh', argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish(`spawn failed: ${error?.message ?? error}`)
      return
    }
    // NOT unref'd: this timer IS the probe's only bound. An unref'd timer lets
    // the event loop drain before it fires, which turns "no answer" into a
    // promise that never settles — the exact hang a health check must not have.
    timer = setTimeout(() => {
      timedOut = true
      finish(`no answer within ${budget} ms`)
    }, budget)
    child?.stdout?.setEncoding?.('utf8')
    child?.stdout?.on?.('data', (chunk) => {
      stdout += chunk
      // Answer early when it is on the wire: a relay that prints and then idles
      // must not hold the attach for the whole timeout.
      if (typeof onStdout === 'function' && onStdout(stdout) === true) finish('')
    })
    child?.stderr?.setEncoding?.('utf8')
    child?.stderr?.on?.('data', (chunk) => { stderr += chunk })
    child?.on?.('error', (error) => finish(`ssh: ${error?.message ?? error}`))
    child?.on?.('exit', (code) => {
      exited = true
      exitCode = code ?? null
      if (settled) return
      graceTimer = setTimeout(() => finish(''), RELAY_CLOSE_GRACE_MS)
      graceTimer.unref?.()
    })
    child?.on?.('close', (code) => {
      exited = true
      if (code !== undefined && code !== null) exitCode = code
      finish('')
    })
  })
}

/** The token line, exactly as the probe program prints it. */
const RELAY_TOKEN_RE = /RELAY_(OK|BAD|DOWN)/u

/**
 * One candidate, inside whatever budget is left. `status` is null when the
 * candidate produced no token; `answered` says whether the guest replied at all.
 */
/**
 * One candidate, inside whatever budget is left. `status` is null when the
 * candidate produced no token; `answered` says whether the RELAY SCRIPT replied
 * with something the probe could not read (RELAY_SKEW) — never merely "the
 * carrier printed a message": an interpreter-missing failure is RELAY_DOWN
 * (DEFECT 3), and `interpreterMissing` keeps that finer fact for the doctor.
 * Both facts come from the exported single-owner classifiers above.
 */
async function probeOneCandidate({ candidate, argv, spawnImpl, timeoutMs, now }) {
  const capture = await runSshCapture({
    argv,
    spawnImpl,
    timeoutMs,
    now,
    onStdout: (text) => RELAY_TOKEN_RE.test(text)
  })
  const seen = RELAY_TOKEN_RE.exec(capture.stdout)
  const status = seen === null ? null : `RELAY_${seen[1]}`
  const text = String(capture.stderr || capture.stdout || capture.detail || '').trim()
  const classification = classifyRelayProbeAnswer({
    stderr: capture.stderr,
    stdout: capture.stdout,
    exitCode: capture.exitCode
  })
  return {
    status,
    detail: (status === RELAY_OK ? '' : text).slice(0, 240),
    exitCode: capture.exitCode,
    answered: classification === RELAY_SKEW,
    classification,
    interpreterMissing: relayInterpreterMissing({ stderr: capture.stderr, stdout: capture.stdout }),
    timedOut: capture.timedOut,
    ms: capture.ms,
    candidate
  }
}

/**
 * Ask the guest whether the interactive relay is alive: `{ ok, status, port, ms,
 * detail, cached, probeMode, interpreter, relayDetail, exitCode }`. Never throws
 * — a probe that cannot even spawn SSH is a DOWN answer, because the caller's
 * next move is the same either way.
 *
 * ITERATES THE CANDIDATES INSIDE ONE BUDGET. The first candidate that produces a
 * token decides; if none does, the guest's own reactions decide the
 * CLASSIFICATION through the exported `classifyRelayProbeAnswer()`: the relay
 * SCRIPT answering with something unreadable (usage line / unknown option /
 * cannot-find that NAMES `mcp-relay`) is RELAY_SKEW; silence AND an
 * interpreter-missing failure (`'py' is not recognized`, `command not found`)
 * are RELAY_DOWN, because neither is proof that the payload ran (DEFECT 3).
 * `probeMode` ('handshake' | 'legacy') and `interpreter` name the carrier that
 * answered, so the session command can be built from the SAME interpreter the
 * probe proved exists (§4.2) instead of assuming `py`.
 *
 * THE BUDGET IS THE CALLER'S (DEFECT 9). `timeoutMs` is honoured EXACTLY — no
 * `Math.max(1000, …)` floor. The floor silently raised a 50 ms budget to 1 s,
 * so a caller measuring probe latency measured the harness's opinion instead of
 * the guest's answer. Only an ABSENT (undefined) budget falls back to
 * RELAY_PROBE_TIMEOUT_MS; the measured wall can never exceed what was asked for
 * (see runSshCapture's single timer).
 *
 * `options` may also be a plain function: `relayProbe(({remoteCommand}) => argv)`
 * lets a caller supply the SSH argv factory (tests, alternate transports).
 * `spawnImpl` is the seam every probe and every SSH child goes through (defect
 * 11): without it a test could only prove the lane logic, never the spawn.
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

  // ONE deadline for every candidate: a third carrier may not buy a third budget.
  // DEFECT 9: THE CALLER'S BUDGET IS THE BUDGET. The old `Math.max(1000, …)`
  // floor raised a sub-second `timeoutMs` to a full second, so "measure the
  // probe's latency" measured the floor instead of the guest. The default still
  // applies when the caller omits the option (undefined/null) and for a value
  // that is not a finite number; anything else is honoured as written, clamped
  // only to 1 ms so the deadline arithmetic stays sane.
  const requested = timeoutMs === undefined || timeoutMs === null
    ? RELAY_PROBE_TIMEOUT_MS
    : Math.round(Number(timeoutMs))
  const budget = Number.isFinite(requested) ? Math.max(1, requested) : RELAY_PROBE_TIMEOUT_MS
  const deadline = startedAt + budget
  const candidates = relayProbeCandidates(port)
  let answeredAny = false
  let last = null

  for (const candidate of candidates) {
    const remaining = deadline - now()
    if (remaining <= 0) break
    const argv = typeof sshArgsFactory === 'function'
      ? sshArgsFactory({ host, port: sshPort, user, keyPath, remoteCommand: candidate.command })
      : sshArgv({ host, port: sshPort, user, keyPath, remoteCommand: candidate.command })
    const attempt = await probeOneCandidate({ candidate, argv, spawnImpl, timeoutMs: remaining, now })
    last = attempt
    if (attempt.status !== null) {
      // First token wins — including RELAY_DOWN from the handshake program,
      // which is the RELAY'S answer (it ran, the port refused) and therefore
      // trustworthy: asking a second interpreter would only cost the budget.
      const answer = {
        ok: attempt.status === RELAY_OK,
        status: attempt.status,
        port,
        ms: Math.max(0, now() - startedAt),
        detail: attempt.detail,
        cached: false,
        probeMode: candidate.mode,
        interpreter: candidate.interpreter,
        relayDetail: attempt.detail,
        exitCode: attempt.exitCode,
        // DEFECT 3: the finer fact behind a DOWN token — the carrier could not
        // even find an interpreter. Never set on an OK answer.
        interpreterMissing: attempt.interpreterMissing === true,
        candidate: candidate.id
      }
      relayProbeCache.key = key
      relayProbeCache.at = now()
      relayProbeCache.answer = answer
      if (answer.ok !== true) log(`mcp-win: relay probe 127.0.0.1:${port} → ${answer.status} [${answer.probeMode}]${answer.detail === '' ? '' : ` (${answer.detail})`}`)
      return answer
    }
    if (attempt.answered === true) answeredAny = true
  }

  const status = answeredAny === true ? RELAY_SKEW : RELAY_DOWN
  const detail = String(last?.detail ?? `no answer within ${timeoutMs} ms`).slice(0, 240)
  const answer = {
    ok: false,
    status,
    port,
    ms: Math.max(0, now() - startedAt),
    detail,
    cached: false,
    probeMode: last?.candidate?.mode ?? 'none',
    // NO token means NO interpreter was proven: §4.2 carries "the interpreter
    // that ANSWERED", so guessing `py -3` from the carrier we happened to try
    // last would be exactly the split this field exists to close.
    interpreter: null,
    relayDetail: detail,
    exitCode: last?.exitCode ?? null,
    // DEFECT 3: "no python on this guest" is a fact the doctor can report; it is
    // still RELAY_DOWN, because the payload never ran.
    interpreterMissing: last?.interpreterMissing === true,
    candidate: last?.candidate?.id ?? null
  }
  relayProbeCache.key = key
  relayProbeCache.at = now()
  relayProbeCache.answer = answer
  log(`mcp-win: relay probe 127.0.0.1:${port} → ${answer.status} after ${candidates.length} carrier(s)${detail === '' ? '' : ` (${detail})`}`)
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
 *
 * INVARIANT (JURY2-CO1 defect 1): `relayOk === true` on a `session-0-direct`
 * lane means "this lane already knows the relay answers AND its teardown is
 * happening NOW", which is why it refuses. `maybeUpgradeTransport()` therefore
 * publishes that pair ONLY in the same synchronous block as `shutdown()`, and
 * every non-success return restores the pre-probe pair and the throttle stamp
 * — so a probe that could not tear the child down never tells this guard the
 * lane is up, and the next poll can retry. The `inFlight` branch is what bounds
 * that retry's cost: it is evaluated BEFORE any probe, so a retry costs an ssh
 * child only when the client is idle.
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
 *   RELAY_SKEW                     → the legacy direct command + SESSION0_SKEW_REASON
 *   RELAY_DOWN / RELAY_BAD         → the legacy direct command, with the reason
 *                                    SESSION0_FALLBACK_REASON on the record
 *   DSH_CUA_WIN_MCP_COMMAND set    → that command verbatim (no fallback rewrite;
 *                                    only the reason explains what was bypassed)
 *
 * THE COMMAND IS BUILT FROM THE INTERPRETER THAT ANSWERED (§4.2). The probe does
 * not merely say "the relay is up": it says WHICH carrier reached it. Reusing
 * that interpreter closes the `py` vs `python` split — a guest where only
 * `python` resolves would otherwise get a lane decision ("relay") attached to a
 * command (`py -3 … --connect`) that cannot start.
 *
 * Every attach calls this, so the decision follows the guest instead of a
 * decision made once at boot — the relay task may start minutes after logon.
 */
export async function resolveGuestMcpTransport(options = {}) {
  const normalized = typeof options === 'function' ? { sshArgsFactory: options } : (options ?? {})
  const { log = () => {} } = normalized
  const probe = await relayProbe({ ...normalized, log })
  const override = winMcpCommandOverride()
  const interpreter = probe?.interpreter ?? null
  const wanted = override ?? (probe.ok === true ? relayConnectCommand(interpreter) : LEGACY_DIRECT_COMMAND)
  // The LANE is a property of the command that will actually run, not of the
  // probe: an override naming the relay still runs through the relay.
  const relayLane = /mcp-relay\.py/iu.test(wanted)
  const facts = {
    command: wanted,
    transport: relayLane ? 'interactive-relay' : 'session-0-direct',
    relayPort: probe.port,
    relayOk: probe.ok === true,
    relayStatus: probe.status,
    // WHICH CARRIER ANSWERED, and the interpreter it proved exists. Both travel
    // to the doctor and to the next attach; neither is a guess.
    probeMode: probe.probeMode ?? null,
    interpreter,
    relayDetail: probe.relayDetail ?? probe.detail ?? '',
    // DEFECT 3: the carrier never found an interpreter (still RELAY_DOWN, but a
    // different next action than "start the relay"). Additive to the facts.
    interpreterMissing: probe.interpreterMissing === true,
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
    // TWO SENTENCES, TWO DIAGNOSES. RELAY_SKEW says the relay probably IS up and
    // the harness could not read it; RELAY_DOWN says it is not up. Same lane,
    // different next action, so the record must not be the same string.
    if (probe.status === RELAY_SKEW) facts.reason = SESSION0_SKEW_REASON
    else facts.reason = SESSION0_FALLBACK_REASON
    log(`mcp-win: ${facts.reason}`)
  }
  return facts
}

/**
 * DEFECT 4(c): IS THIS A "THE RELAY ANSWERED, WE COULD NOT READ IT" PAYLOAD?
 *
 * The single owner of `payload.skew` (docs quote PAYLOAD_SKEW_SEMANTICS). Three
 * pieces of evidence qualify, and NO hash comparison does:
 *
 *   * `RELAY_SKEW` — the relay script printed a usage line / unknown option /
 *     cannot-find that NAMES `mcp-relay.py` (classifyRelayProbeAnswer), so the
 *     payload ran and the probe could not read it;
 *   * `RELAY_BAD`  — the relay answered the handshake with something that is not
 *     `RELAY_OK`: it is alive and its answer is unreadable as success;
 *   * the guest repair record's own sentence `probe-skew` (Appendix B), which
 *     the repair writes exactly when its handshake returned `RELAY_BAD`.
 *
 * NOT skew: a missing interpreter (RELAY_DOWN + `interpreterMissing`), silence,
 * a missing script (`measured` + `relayHash: ''`), or two DIFFERENT hashes —
 * that last one is reported by comparing `expectedRelayHash` with `relayHash`.
 */
export function relayEvidenceSkew(relayStatus, record = null) {
  if (relayStatus === RELAY_SKEW) return true
  if (relayStatus === RELAY_BAD) return true
  return record?.reason === 'probe-skew'
}

/**
 * The doctor's facts, freshly probed (cached ≤10 s, never spawns a second SSH
 * session for a call that just made one). The plugin's windowsMcpDoctor() lives
 * in index.js and is expected to spread this into its payload; keeping it here
 * means the transport truth has ONE owner.
 *
 * BOTH DOCTORS CARRY THE SAME SHAPE. `probeMode`, `relayDetail`, `repair` and
 * `payload` are added here as well as in the client's doctorFacts(): a
 * module-level helper and a client that disagree is how a blind bridge keeps
 * reporting `ok` (P2).
 */
export async function relayDoctorFacts(options = {}) {
  const normalized = typeof options === 'function' ? { sshArgsFactory: options } : (options ?? {})
  const facts = await resolveGuestMcpTransport({ ...normalized, log: normalized.log ?? (() => {}) })
  const record = relayRepairRecord(normalized)
  /**
   * DEFECT 5: BOTH SETS OF NAMES, ONE VALUE EACH.
   *
   * The CANONICAL names are `transportCommand` / `transportReason` — the pair
   * index.js spreads into windowsMcpDoctor and the pair its docs must nominate
   * for a client fact. `command` / `reason` are kept as ALIASES because this
   * helper emitted them first and existing consumers (and README tables) read
   * them; they are byte-identical to the canonical field, never a second value,
   * so the two doctors cannot drift field for field. See
   * DOCTOR_FACTS_FIELDS for the exported description.
   */
  const transportCommand = facts.command
  const transportReason = facts.reason
  return {
    transport: facts.transport,
    relayPort: facts.relayPort,
    relayOk: facts.relayOk,
    relayStatus: facts.relayStatus,
    // CANONICAL (what index.js emits and what the docs must name).
    transportCommand,
    transportReason,
    // ALIASES (what this helper used to emit; kept so nothing breaks).
    command: transportCommand,
    reason: transportReason,
    interpreter: facts.interpreter ?? null,
    probeMode: facts.probeMode ?? null,
    relayDetail: facts.relayDetail ?? '',
    // DEFECT 3: the finer fact behind a DOWN token (no interpreter on the
    // guest). Additive; consumers that ignore it lose nothing.
    interpreterMissing: facts.interpreterMissing === true,
    repair: record,
    payload: {
      // DEFECT 1: `measured` rides along so a consumer of the payload ALONE can
      // tell "the guest has no relay script" (`measured:true, relayHash:''`)
      // from "nothing was measured" (`measured:false, relayHash:null`).
      measured: record?.measured === true,
      relayHash: record?.measured === true ? (record?.hash ?? null) : null,
      // DEFECT 4(a): THE HARNESS-SIDE IDENTITY, FINALLY PRODUCED. index.js has
      // always read `payload.expectedRelayHash`; nothing wrote it, so it was
      // structurally null. `null` = THIS BUILD CANNOT SAY (no payload source on
      // the harness) — "unknown", not "no relay" and not "different".
      expectedRelayHash: expectedRelayHash(),
      // DEFECT 4(b): the guest's own measurement travels with the payload too,
      // so a consumer can compare it with `relayPort` without digging in repair.
      port: record?.port ?? null,
      portMeasured: record?.portMeasured === true,
      // DEFECT 4(c): THE HONEST FLAG (see PAYLOAD_SKEW_SEMANTICS). True ONLY
      // when the relay ANSWERED and the probe could not read it: the SKEW token,
      // a RELAY_BAD answer, or a guest repair record that says probe-skew. A
      // missing interpreter is NOT skew (it is RELAY_DOWN + interpreterMissing),
      // and a differing hash is reported as relayHash vs expectedRelayHash.
      skew: relayEvidenceSkew(facts.relayStatus, record)
    }
  }
}

/* ------------------------------------------------------------------ *
 * THE DESKTOP FACTS (WP-4.1): what the guest measured about ITSELF
 * ------------------------------------------------------------------ */

/**
 * WHERE THE RELAY PUBLISHES, and how we read it (WP-4.1, SOL §4.3).
 *
 * The relay's `--serve` entry measures the DESKTOP SESSION's own interpreter
 * (does `win32ui` import? does the desktop token own a writable directory?) and
 * writes one JSON object (Appendix B). This side never assumes any of it: it
 * READS the file, and `measured:false` is a first-class answer — a guest
 * provisioned before this change has no file at all, and saying "unknown" is
 * the only honest report for it (risk R10).
 *
 * ONE ssh, two candidate paths, exactly as the SOL freezes it: the work
 * directory the desktop token can write, then `%TEMP%` for a guest whose
 * work-dir ACL did not take. `||` is cmd.exe's "run the second only when the
 * first failed", which is why this is one bounded read and not two.
 */
export const DESKTOP_FACTS_PATH = 'C:\\cua-work\\cua-desktop-facts.json'
export const DESKTOP_FACTS_FALLBACK_PATH = 'C:\\Users\\cua\\AppData\\Local\\Temp\\cua-desktop-facts.json'
export const DESKTOP_FACTS_COMMAND = `type "${DESKTOP_FACTS_PATH}" || type "${DESKTOP_FACTS_FALLBACK_PATH}"`

/** The read's own wall: 8 s (SOL §4.3). A doctor read must never outlive the doctor. */
export const DESKTOP_FACTS_TIMEOUT_MS = 8000

/**
 * 60 s TTL (SOL §4.3): the facts are republished on every relay start, not on
 * every call, so a fresh read every doctor would be an SSH child per poll for a
 * number that cannot have changed. `stale:true` says the FILE is older than
 * this — the relay has not republished — which is a different fact from "we
 * cached it".
 */
export const DESKTOP_FACTS_TTL_MS = 60000

/**
 * A FAILURE IS NOT CACHED FOR THE FULL TTL — the probe cache's lesson, applied.
 *
 * `relayProbeCache` is 10 s precisely because a cached "down" that outlived boot
 * pinned every attach to the blind lane. The same trap exists here: the first
 * doctor call during boot legitimately finds no facts file, the relay publishes
 * one a few seconds later, and a 60 s failure cache would make the doctor report
 * `measured:false` for a minute after the guest became honest — and would defeat
 * WP-5.9's promise that the FIRST `windows_desktop` after an attach carries the
 * facts. So an unmeasured answer is remembered only long enough that a burst of
 * calls shares one child (C3's "two calls inside the TTL → one spawn" holds for
 * a failure too), never long enough to outlive a boot.
 */
export const DESKTOP_FACTS_FAILURE_TTL_MS = 5000

/** The schema this side understands; a newer one is still read, field by field. */
export const DESKTOP_FACTS_SCHEMA = 1

/**
 * THE CACHE KEY — AND WHY THE NAME IS PART OF IT (JURY-CO1 defect 3).
 *
 * `user@host:port` alone is NOT a computer identity: the supervisor hands out
 * the lowest free SSH port and FREES it on destroy, so a destroyed guest and
 * the guest that replaces it routinely share a port. A key of the SSH triple
 * therefore let a NEW computer inherit the OLD one's measured facts for a full
 * TTL — `measured:true, win32ui:false` for a guest that has no facts file at
 * all, which is the exact class of lie this release exists to delete.
 *
 * The harness's own name for the computer IS an identity: `index.js` passes
 * `target.name` to both the client and this reader, and the supervisor never
 * has two rows of the same name. So the key is the triple PLUS `#name` when the
 * caller knows it — and `forgetDesktopFacts()` closes the remaining hole (the
 * same name re-created on the same port) at teardown, where the destroy
 * actually happens.
 */
function desktopFactsKey({ user = 'cua', host = '127.0.0.1', port, name = '' } = {}) {
  const identity = String(name ?? '')
  return `${user}@${host}:${port}${identity === '' ? '' : `#${identity}`}`
}

/** One entry per computer — two computers must never inherit each other's facts. */
const desktopFactsCache = new Map()

/**
 * ONE READ IN FLIGHT PER COMPUTER (JURY-CO1 defect 2). The attach path fires
 * `refreshDesktopFacts()` and `scheduleDesktopFacts()` in the SAME tick, and the
 * entry is only written after `runSshCapture` resolves — so without this latch
 * the second caller saw an empty cache and spent a second ssh child. The latch
 * is the read's own promise: concurrent callers await it and get the same
 * answer, and it is removed the moment it settles (the TTL cache, not the
 * latch, is what makes the NEXT call cheap).
 */
const desktopFactsInFlight = new Map()

/**
 * A GENERATION PER KEY, so a read that was in flight across a teardown cannot
 * repopulate the cache with the dead computer's answer. `forgetDesktopFacts()`
 * bumps it; a read only writes the entry if the generation it started in is
 * still current.
 */
const desktopFactsEpoch = new Map()

function desktopFactsEpochOf(key) {
  return desktopFactsEpoch.get(key) ?? 0
}

/** Drop EVERY cached answer and every latch (tests; a full reset). */
export function resetDesktopFactsCache() {
  desktopFactsCache.clear()
  desktopFactsInFlight.clear()
  desktopFactsEpoch.clear()
}

/**
 * FORGET ONE COMPUTER (JURY-CO1 defect 3). Called by the client's `close()` —
 * which `index.js`'s `teardown()` calls on destroy — so the invariant "a
 * destroyed computer's facts never serve a new computer" holds even when the
 * replacement reuses the SAME name and the SAME port.
 *
 * It also bumps the key's generation, so a read that is still in flight for the
 * old guest cannot write its answer back after the teardown. Returns the key it
 * dropped (a log/test convenience, not a contract).
 */
export function forgetDesktopFacts(options = {}) {
  const { host = '127.0.0.1', port, user = 'cua', name = '' } = options ?? {}
  const key = desktopFactsKey({ user, host, port, name })
  desktopFactsCache.delete(key)
  desktopFactsInFlight.delete(key)
  desktopFactsEpoch.set(key, desktopFactsEpochOf(key) + 1)
  return key
}

/** A boolean fact, or `null` when the guest did not measure it. Never a guess. */
function factBool(value) {
  return value === true ? true : (value === false ? false : null)
}

/** A string fact, or `null`. Empty strings read as unknown. */
function factString(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/** A numeric fact, or `null`. */
function factNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * IS THE FACTS FILE OLDER THAN THE TTL? — the FILE's age, never the cache's.
 *
 * `stale` used to be computed once, inside `normalizeDesktopFacts`, and then
 * returned verbatim on every cache hit: a file that was 59 s old when it was
 * read still reported `stale:false` at 118 s (JURY-CO1 defect 5). The verdict
 * belongs to the moment of the ANSWER, so it is derived here and re-derived on
 * every cache hit / shared read from the stored `at` and the caller's clock.
 */
function desktopFactsStale(at, nowMs, ttlMs) {
  const measuredAt = at === null || at === undefined ? Number.NaN : Date.parse(String(at))
  if (Number.isFinite(measuredAt) === false) return false
  return Math.max(0, Number(nowMs) - measuredAt) > Math.max(0, Number(ttlMs))
}

/**
 * THE ANSWER A CALLER GETS: `stale` re-derived at read time, and `cached`
 * saying whether this call spent an ssh child of its own (a TTL hit and a
 * shared in-flight read both answer `true` — neither one spawned).
 */
function desktopFactsAnswer(facts, { nowMs, ttlMs, cached }) {
  const answer = facts.measured === true
    ? { ...facts, stale: desktopFactsStale(facts.at, nowMs, ttlMs) }
    : facts
  return { ...answer, cached: cached === true }
}

/**
 * THE LAST COMPLETE JSON OBJECT in a capture. The guest path is cmd.exe, and
 * cmd.exe prints its own `The system cannot find the file specified.` noise
 * around whatever `type` produced, so `JSON.parse(stdout)` would fail on a file
 * that is perfectly good. Scanning backwards from the final `}` and trying each
 * `{` keeps a leading banner harmless without a lenient parser (no trailing
 * commas, no comments — the relay writes `json.dumps`).
 */
function parseLastJsonObject(text) {
  const source = String(text ?? '')
  const end = source.lastIndexOf('}')
  if (end === -1) return null
  for (let start = source.lastIndexOf('{', end); start !== -1; start = source.lastIndexOf('{', start - 1)) {
    try {
      const parsed = JSON.parse(source.slice(start, end + 1))
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) === false) return parsed
    } catch {
      // Not this one: an earlier `{` may be the real object.
    }
    if (start === 0) break
  }
  return null
}

/**
 * Appendix B → the shape this file hands to the doctor. THE CONSUMER CONTRACT
 * (§Appendix B, frozen): unknown keys are KEPT, missing keys read as `null`,
 * and `measured !== true` means **every field is unknown** — never "false". A
 * `false` here is a measurement; a `null` is the absence of one, and conflating
 * them is how "the lane is dead" gets reported on a guest nobody measured.
 */
function normalizeDesktopFacts(parsed, { error = '', now = () => Date.now(), ttlMs = DESKTOP_FACTS_TTL_MS } = {}) {
  const unknown = {
    schema: null,
    user: null,
    session: null,
    python: null,
    dshCuaVersion: null,
    pywin32Version: null,
    win32ui: null,
    uiaLane: null,
    uiaLaneOk: null,
    elementLaneOk: null,
    scaleFix: null,
    workDir: null,
    workDirWritable: null,
    profileRootWritable: null,
    // WP-4.2: false unless the CAPTURE that produced this answer was a
    // connection-level failure (desktopFacts() overwrites it from the capture).
    connectionLevel: false
  }
  if (parsed === null || parsed === undefined) {
    return {
      measured: false,
      at: null,
      stale: false,
      source: 'none',
      cached: false,
      ...unknown,
      error: error === '' ? 'no desktop facts file was readable in the guest' : error
    }
  }
  const measured = parsed.measured === true
  if (measured !== true) {
    return {
      // Unknown keys are kept (§Appendix B), but nothing measured is claimed.
      ...parsed,
      measured: false,
      at: null,
      stale: false,
      source: factString(parsed.source) ?? 'none',
      cached: false,
      ...unknown,
      error: factString(parsed.error) ?? (error === '' ? 'the guest wrote desktop facts but reported measured:false' : error)
    }
  }
  const win32ui = factBool(parsed.win32ui)
  const uiaLane = factBool(parsed.uiaLane)
  // THE ONE DERIVED FACT the model branches on (SOL §4.3/§4.5): the focus-free
  // element lane needs BOTH imports, because `_wrapper_for()` reaches
  // `pywinauto.controls.uiawrapper`, which imports `win32ui` unguarded.
  const elementLaneOk = win32ui === false || uiaLane === false
    ? false
    : (win32ui === true && uiaLane === true ? true : null)
  const at = factString(parsed.at)
  return {
    ...parsed,
    measured: true,
    at,
    // The FILE is old, not the cache — and it is re-derived on every cache hit
    // (desktopFactsAnswer), never frozen into the entry.
    stale: desktopFactsStale(at, now(), ttlMs),
    source: factString(parsed.source) ?? 'unknown',
    cached: false,
    schema: factNumber(parsed.schema) ?? DESKTOP_FACTS_SCHEMA,
    user: factString(parsed.user),
    session: factNumber(parsed.session),
    python: factString(parsed.python),
    dshCuaVersion: factString(parsed.dshCuaVersion),
    pywin32Version: factString(parsed.pywin32Version),
    win32ui,
    uiaLane,
    uiaLaneOk: uiaLane,
    elementLaneOk,
    scaleFix: factString(parsed.scaleFix),
    workDir: factString(parsed.workDir),
    workDirWritable: factBool(parsed.workDirWritable),
    profileRootWritable: factBool(parsed.profileRootWritable),
    error: String(parsed.error ?? '')
  }
}

/**
 * READ THE DESKTOP SESSION'S OWN FACTS (WP-4.1). One bounded SSH read, cached
 * for `ttlMs` (60 s), keyed `user@host:port`. **Never throws** — a rejected
 * promise is the exact bug class this repo keeps fixing, and the doctor that
 * awaits this must be able to say `measured:false` instead of going down.
 *
 * Returns `{ measured, at, stale, source, cached, schema, user, session,
 * python, dshCuaVersion, pywin32Version, win32ui, uiaLane, uiaLaneOk,
 * elementLaneOk, scaleFix, workDir, workDirWritable, profileRootWritable,
 * error }` — plus every unknown key the guest wrote (§Appendix B).
 *
 * `measured:false` + `error` is the answer for: no file (a pre-change guest),
 * an SSH that never answered, a timeout, a file that is not JSON. The caller
 * must treat every other field as UNKNOWN then, never as `false`.
 *
 * `options` accepts the same seams as every other read in this file:
 * `spawnImpl` (so a test can answer without an ssh binary), `now` (the TTL and
 * the `stale` verdict), `force` (bypass the cache AND the latch), `name` (the
 * computer's identity — part of the cache key, so a reused SSH port is never
 * mistaken for the same machine) and `sshArgsFactory` (an alternate transport).
 *
 * ONE READ IN FLIGHT PER COMPUTER: a second caller inside the same tick awaits
 * the first caller's promise instead of spending a second ssh child, and gets
 * `cached:true` (neither caller's answer is stale — one child measured it).
 * `forgetDesktopFacts()` is the teardown half: the client calls it from
 * `close()`, so a destroyed computer's facts can never serve its replacement.
 */
export async function desktopFacts(options = {}) {
  const normalized = typeof options === 'function' ? { sshArgsFactory: options } : (options ?? {})
  const {
    host = '127.0.0.1',
    port: sshPort,
    user = 'cua',
    // The computer's own name, when the caller knows it (index.js always does).
    // Part of the cache key: a reused SSH port must not be a computer identity
    // (see desktopFactsKey).
    name = '',
    keyPath,
    timeoutMs = DESKTOP_FACTS_TIMEOUT_MS,
    ttlMs = DESKTOP_FACTS_TTL_MS,
    force = false,
    sshArgsFactory,
    spawnImpl = spawn,
    now = () => Date.now(),
    log = () => {}
  } = normalized
  const key = desktopFactsKey({ user, host, port: sshPort, name })
  try {
    // A TTL HIT. `stale` is re-derived from the stored `at` against THIS call's
    // clock (defect 5): the entry is a cached MEASUREMENT, not a cached verdict.
    const cached = desktopFactsCache.get(key)
    if (force !== true && cached !== undefined && (now() - cached.at) < cached.ttl) {
      return desktopFactsAnswer(cached.facts, { nowMs: now(), ttlMs, cached: true })
    }
    // A READ ALREADY IN FLIGHT FOR THIS COMPUTER (defect 2): share its child
    // instead of spending a second one. `force` is the caller saying "read now".
    const shared = force === true ? undefined : desktopFactsInFlight.get(key)
    if (shared !== undefined) {
      return desktopFactsAnswer(await shared, { nowMs: now(), ttlMs, cached: true })
    }
    // The generation this read belongs to: a teardown bumps it, and the entry is
    // then NOT written — the dead computer's answer must not come back.
    const epoch = desktopFactsEpochOf(key)
    const run = (async () => {
      try {
        const argv = typeof sshArgsFactory === 'function'
          ? sshArgsFactory({ remoteCommand: DESKTOP_FACTS_COMMAND })
          : sshArgv({ host, port: sshPort, user, keyPath, remoteCommand: DESKTOP_FACTS_COMMAND })
        const capture = await runSshCapture({ argv, spawnImpl, timeoutMs, now })
        const parsed = parseLastJsonObject(capture.stdout)
        const failure = parsed === null
          ? String(capture.stderr || capture.stdout || capture.detail || '').trim().slice(0, 240)
          : ''
        const facts = normalizeDesktopFacts(parsed, { error: failure, now, ttlMs })
        // WP-4.2's flag, carried on the answer so a caller can tell "the guest has
        // no facts file" from "the transport never got a session" — both are
        // `measured:false`, and only one of them is worth retrying.
        facts.connectionLevel = capture.connectionLevel === true
        // A MEASUREMENT is cached for the caller's TTL; a FAILURE only for the
        // short failure window (see DESKTOP_FACTS_FAILURE_TTL_MS).
        const entryTtl = facts.measured === true
          ? Math.max(0, Number(ttlMs))
          : Math.min(DESKTOP_FACTS_FAILURE_TTL_MS, Math.max(0, Number(ttlMs)))
        if (desktopFactsEpochOf(key) === epoch) desktopFactsCache.set(key, { at: now(), ttl: entryTtl, facts })
        if (facts.measured === true) {
          log(`mcp-win: desktop facts measured (${facts.source}${facts.elementLaneOk === false ? ', element lane DEAD' : ''})`)
        } else {
          log(`mcp-win: desktop facts unreadable (${facts.source}): ${facts.error}`)
        }
        return facts
      } catch (error) {
        // Belt and braces: nothing above is supposed to throw, and a doctor read
        // that CAN throw is a doctor that takes the panel down with it.
        return normalizeDesktopFacts(null, { error: `desktop facts: ${error?.message ?? error}`, now, ttlMs })
      }
    })()
    if (force !== true) desktopFactsInFlight.set(key, run)
    try {
      return await run
    } finally {
      if (desktopFactsInFlight.get(key) === run) desktopFactsInFlight.delete(key)
    }
  } catch (error) {
    // A shared read that rejected, or an argv builder that threw before the
    // latch existed: still an answer, still never a rejection.
    return normalizeDesktopFacts(null, { error: `desktop facts: ${error?.message ?? error}`, now, ttlMs })
  }
}

/* ------------------------------------------------------------------ *
 * THE REPAIR (P1): a guest-side fix the harness can execute itself
 * ------------------------------------------------------------------ */

/**
 * ONE ATTEMPT PER MINUTE, THREE STRIKES AND IT GOES QUIET FOR FIVE.
 *
 * The upgrade watch already probes on the blind lane once a minute; without this
 * throttle every one of those would become an ssh child that rewrites a launcher
 * and re-creates a scheduled task. A guest that cannot be repaired must not be
 * hammered: after three consecutive failures the interval becomes five minutes,
 * and a single success resets it.
 */
export const RELAY_REPAIR_INTERVAL_MS = 60_000

/** The repair's own wall. It waits ≤8 s for a handshake; 25 s covers ssh + PowerShell cold. */
export const RELAY_REPAIR_TIMEOUT_MS = 25_000

/** What three failures buy: five minutes of silence. */
export const RELAY_REPAIR_BACKOFF_MS = 300_000

/** Consecutive failures that switch the interval to RELAY_REPAIR_BACKOFF_MS. */
export const RELAY_REPAIR_FAILURES_BEFORE_BACKOFF = 3

/** `DSH_CUA_VM_WIN_MCP_REPAIR=0` turns repair off without turning the bridge off. */
export const RELAY_REPAIR_DISABLED_ENV = 'DSH_CUA_VM_WIN_MCP_REPAIR'

/**
 * The marker a repair child is RECOGNISABLE by: probes carry `-c "exec(…)"`, the
 * relay lane carries `--connect`, and a repair is the only child that carries a
 * base64 PowerShell `-EncodedCommand`. Tests count repairs through spawnImpl by
 * matching this, so it is exported instead of being a literal in a comment.
 */
export const RELAY_REPAIR_COMMAND_MARKER = '-EncodedCommand'

/** The frozen record prefix (Appendix B); tests match on it. */
export const RELAY_REPAIR_RECORD_PREFIX = 'CUA_RELAY'

/** The onlogon task the guest payload registers (and the one the repair re-creates). */
export const RELAY_TASK_NAME = 'cua-mcp-host'

/** The launcher `/tr` names — a path with no spaces, which is why /tr needs no quotes. */
export const RELAY_VBS_LAUNCHER = 'C:\\ProgramData\\cua\\mcp-relay-host.vbs'

/** The §4.6 closed set a record's `reason` may name. */
export const RELAY_BLIND_REASONS = Object.freeze([
  'probe-skew',
  'relay-missing',
  'relay-stopped',
  'no-interactive-session',
  'lane-unknown',
  'repair-disabled'
])

/** The repair kill switch, read at call time so a test can flip it. */
export function relayRepairEnabled() {
  return String(process.env[RELAY_REPAIR_DISABLED_ENV] ?? '1') !== '0'
}

/** One repair state per SSH target AND relay port; never shared across computers. */
const relayRepairStates = new Map()

function relayRepairKey({ host = '127.0.0.1', port, user = 'cua', keyPath } = {}) {
  return `${user}@${host}:${port}|${keyPath ?? ''}|${relayPort()}`
}

/** The (created-on-demand) throttle/backoff record for one target. */
function relayRepairState(key) {
  let state = relayRepairStates.get(key)
  if (state === undefined) {
    state = {
      attempts: 0,
      failures: 0,
      lastAt: 0,
      backoffMs: RELAY_REPAIR_INTERVAL_MS,
      lastRecord: null,
      inFlight: null
    }
    relayRepairStates.set(key, state)
  }
  return state
}

/**
 * The LAST repair record for a target, for the doctors. Synchronous and
 * side-effect free: a doctor must not queue an SSH child by asking what happened
 * to the previous one.
 */
export function relayRepairRecord(options = {}) {
  const normalized = typeof options === 'function' ? {} : (options ?? {})
  return relayRepairStates.get(relayRepairKey(normalized))?.lastRecord ?? null
}

/** Forget every throttle/backoff (tests, and a caller that knows the guest was rebuilt). */
export function resetRelayRepairState() {
  relayRepairStates.clear()
}

/* ------------------------------------------------------------------ *
 * MEASURED vs NOT MEASURED (DEFECT 1) — the marker index.js gates on
 * ------------------------------------------------------------------ */

/**
 * WHY A RECORD CARRIES NO MEASUREMENT. `no-record` is the honest description of
 * a repair whose SSH child died, timed out, or answered with PowerShell noise:
 * the guest was never read, so session/hash/probe are UNKNOWN. The others are
 * paths that never reached the guest at all.
 */
export const RELAY_REPAIR_UNMEASURED = Object.freeze({
  NO_RECORD: 'no-record',
  REPAIR_DISABLED: 'repair-disabled',
  BRIDGE_DISABLED: 'bridge-disabled',
  THROTTLED: 'throttled',
  EXCEPTION: 'exception'
})

/**
 * THE MEASUREMENT MARKER, PRESENT ON EVERY RECORD repairRelay() RETURNS.
 *
 * Before this, a record-less attempt and the REPAIR=0 kill-switch record carried
 * the base defaults `session: 0 / hash: '' / probe: 'RELAY_DOWN'` — values that
 * are indistinguishable from measurement, so index.js's classifyBlindReason read
 * "a repair measured that no console exists" and "the guest has no relay" on
 * paths where nothing was measured at all (J7: expected `relay-stopped`, got
 * `no-interactive-session`).
 *
 * The contract now:
 *   * `measured: true`  — a `CUA_RELAY` line came back and parsed; every field
 *                         below is what the guest said (empty ⇒ guest did not
 *                         emit it, see the per-field `*Measured` flags).
 *   * `measured: false` — NOTHING was measured; `session`, `hash`, `probe`,
 *                         `running`, `task` are `null` and `unmeasured` names why.
 *
 * Consumers MUST gate on the marker before interpreting a value:
 *   `session === 0` means "no console session" ONLY when
 *   `sessionMeasured === true`.
 */
export function relayRepairMeasured(record) {
  return record?.measured === true
}

/**
 * The measurement truth of one record, normalized for a doctor/classifier.
 * `session === 0` and `session === null` are kept apart on purpose; a consumer
 * that has to answer "is there a console session?" asks `sessionMeasured` first.
 */
export function relayRepairMeasurement(record) {
  const measured = relayRepairMeasured(record)
  const held = (value) => (measured && typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null)
  const text = (value) => (measured && typeof value === 'string' ? value : null)
  return {
    measured,
    unmeasured: measured ? '' : String(record?.unmeasured ?? RELAY_REPAIR_UNMEASURED.NO_RECORD),
    ok: record?.ok === true,
    session: held(record?.session),
    sessionMeasured: measured && record?.sessionMeasured === true && held(record?.session) !== null,
    running: held(record?.running),
    runningMeasured: measured && record?.runningMeasured === true && held(record?.running) !== null,
    task: held(record?.task),
    taskMeasured: measured && record?.taskMeasured === true && held(record?.task) !== null,
    hash: text(record?.hash),
    hashMeasured: measured && record?.hashMeasured === true && text(record?.hash) !== null,
    probe: text(record?.probe),
    probeMeasured: measured && record?.probeMeasured === true && text(record?.probe) !== null,
    // DEFECT 4(b): the GUEST-measured answer port, with its own flag. The
    // harness port the attempt targeted is `targetPort` and is never reported
    // here as a measurement.
    port: measured && typeof record?.port === 'number' && Number.isFinite(record.port) ? Math.floor(record.port) : null,
    portMeasured: measured && record?.portMeasured === true
      && typeof record?.port === 'number' && Number.isFinite(record.port),
    targetPort: typeof record?.targetPort === 'number' && Number.isFinite(record.targetPort)
      ? Math.floor(record.targetPort)
      : null
  }
}

/**
 * THE REPAIR PROGRAM (one self-contained SSH command, §4.4).
 *
 * It is generated HERE, not read from the guest, because the whole point is that
 * it must work on a guest whose payload is stale — a script that depends on a
 * guest file cannot repair a guest file. It does exactly five things, in this
 * order, and nothing that is not evidence:
 *
 *   1. handshake first  — the port is the only truth (a live relay is never
 *                          restarted, so the WinError 10048 race cannot happen);
 *   2. session          — the console session id for the account. LOCALE-FREE: the
 *                          row is found by the ACCOUNT token and the id is the
 *                          numeric column after it, never the English word
 *                          "Active"; an unparseable row is the EMPTY field (not
 *                          measured) and never `0`, because `0` is the measurement
 *                          that means "no console session exists";
 *   3. task             — `schtasks /query /xml`, bound iff InteractiveToken +
 *                          the account + the launcher; re-created with
 *                          `/ru <user> /it /rl LIMITED` when missing or mis-bound
 *                          (`/it` WITHOUT `/ru` binds to the caller — SYSTEM —
 *                          and is refused: the reproduced P1 half);
 *   4. launcher         — regenerated when absent OR when it names a different
 *                          port, WITH `--serve --port <port>` written in. That is
 *                          what closes the DSH_CUA_MCP_RELAY_PORT split: the
 *                          interactive session has no such env var, so a launcher
 *                          that says bare `--serve` listens on 47999 no matter
 *                          what the harness probes (direction E);
 *   5. wait             — ≤8 s for the handshake after a `/run`, one record line.
 *
 * `-EncodedCommand` takes UTF-16LE base64, so the carrier is alphanumeric and the
 * script cannot be mangled by cmd.exe quoting on the way in.
 */
export function relayRepairScriptSource({ port, user } = {}) {
  const relayPortValue = Number.isInteger(Number(port)) ? Number(port) : RELAY_PORT_DEFAULT
  const principal = String(user ?? 'cua').replace(/'/gu, "''")
  return String.raw`$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$port = ${relayPortValue}
$user = '${principal}'
$relay = 'C:\ProgramData\cua\mcp-relay.py'
$vbs = 'C:\ProgramData\cua\mcp-relay-host.vbs'
$task = 'cua-mcp-host'
$ok = 0
$taskOk = 0
# $running and $session stay $null until something MEASURED them: an empty
# Appendix-B field is "not measured", never a fabricated 0. 0 is a real
# measurement ("the task is stopped", "no console session") and index.js's
# classification depends on that difference.
$running = $null
$session = $null
$sessionKnown = $false
$probe = 'RELAY_DOWN'
$hash = ''
$reason = ''

function Get-RelayToken([int]$p) {
  $client = $null
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $pending = $client.BeginConnect('127.0.0.1', $p, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(1500)) { return 'RELAY_DOWN' }
    $client.EndConnect($pending)
    $stream = $client.GetStream()
    $bytes = [System.Text.Encoding]::ASCII.GetBytes('RELAY_PING')
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    # RELAY_OK is eight bytes ON THE WIRE, not eight bytes in one Read. A legal
    # short read must never turn a healthy relay into "down" - that false
    # negative starts a SECOND listener and loses the bind with WinError 10048.
    $answer = New-Object byte[] 8
    $read = 0
    while ($read -lt 8) {
      $left = 2000 - [int]$clock.ElapsedMilliseconds
      if ($left -le 0) { break }
      $client.ReceiveTimeout = $left
      $got = $stream.Read($answer, $read, 8 - $read)
      if ($got -le 0) { break }
      $read += $got
    }
    if ($read -eq 8) {
      $text = [System.Text.Encoding]::ASCII.GetString($answer)
      if ($text -ceq 'RELAY_OK') { return 'RELAY_OK' }
      if ($text.StartsWith('RELAY_BA')) { return 'RELAY_BAD' }
    }
    return 'RELAY_DOWN'
  } catch {
    return 'RELAY_DOWN'
  } finally {
    if ($client) { $client.Close() }
  }
}

# DEFECT 4(b): THE PORT IS A GUEST MEASUREMENT, NOT THE HARNESS'S NUMBER ECHOED.
# The record used to write the harness port ($port) into port=, so index.js's
# portMismatch compared the harness with itself and could never be true. These
# two helpers answer "where does THIS guest's relay actually listen?" from the
# guest's own process/socket table. Old builds without the ScheduledTasks/
# NetTCPIP modules answer EMPTY (not measured), never a fabricated 0 - an empty
# field is the frozen grammar's "unknown", and a 0 would be a claim.
function Test-PortListening([int]$p) {
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $pending = $client.BeginConnect('127.0.0.1', $p, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(300)) { return $false }
    $client.EndConnect($pending)
    return $true
  } catch {
    return $false
  } finally {
    if ($client) { $client.Close() }
  }
}

# LISTENING PORTS OWNED BY A PYTHON PROCESS. Get-Process by name is the only
# process test that does not read a localized field; the socket table is joined
# on the pid. Bounded on purpose (8 candidates, sorted) so a busy guest cannot
# turn a repair into a port scan.
function Get-PythonListenPorts {
  $ports = New-Object System.Collections.Generic.List[int]
  try {
    $pids = @(Get-Process -Name python, pythonw -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    if ($pids.Count -gt 0) {
      $rows = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess })
      foreach ($row in $rows) {
        $lp = [int]$row.LocalPort
        if ($lp -gt 0 -and -not $ports.Contains($lp)) { $ports.Add($lp) }
      }
    }
  } catch { }
  return @($ports | Sort-Object | Select-Object -First 8)
}

# LOCALE-INDEPENDENT CONSOLE SESSION. The old matcher required the English word
# "Active" in the row, so on a translated Windows (Aktiv/Actif/Attivo/…), or on
# any build that pads the state column differently, a LIVE console read as
# session 0 — which the harness turns into 'no-interactive-session', a diagnosis
# that is wrong AND unfixable by re-probing. Here the row is selected by the
# ACCOUNT as a whole token, and the id is the numeric column that follows it.
# An unparseable row returns $null: NOT MEASURED, distinct from the measured 0.
function Get-ConsoleSession([string]$name) {
  $text = ''
  # qwinsta.exe is the classic name and exists on every supported Windows; the
  # 'query session' alias goes through cmd because PowerShell would read it as
  # ONE command name containing a space.
  try { $text = (& qwinsta.exe 2>$null | Out-String) } catch { $text = '' }
  if (-not $text) {
    try { $text = (& cmd /c 'query session' 2>$null | Out-String) } catch { $text = '' }
  }
  if (-not $text) { return $null }
  $who = [regex]::Escape($name)
  foreach ($line in [regex]::Split($text, '\r?\n')) {
    if (-not $line) { continue }
    # The account must be its own token: a session named cua-backup is not cua.
    if ($line -notmatch ('(?i)(?:^|[^A-Za-z0-9_.-])' + $who + '(?:[^A-Za-z0-9_.-]|$)')) { continue }
    # SESSIONNAME  USERNAME  ID  STATE  — the ID is the first numeric field after
    # the account, and > marks the current session; neither is localized.
    $column = [regex]::Match($line, ('(?i)^\s*>?\s*\S+\s+' + $who + '\s+(\d{1,6})(?:\s|$)'))
    if ($column.Success) { return [int]$column.Groups[1].Value }
    # Tolerant fallback (a guest whose column order differs): the ACCOUNT must
    # still be a real column of its own (index >= 1 — a session NAMED cua is not
    # the user cua) and the id is the first numeric column after it.
    $fields = [regex]::Split($line.Trim(), '\s+')
    for ($i = 1; $i -lt $fields.Count; $i++) {
      if ($fields[$i] -ne $name) { continue }
      for ($j = $i + 1; $j -lt $fields.Count; $j++) {
        if ($fields[$j] -match '^\d{1,6}$') { return [int]$fields[$j] }
      }
    }
  }
  return $null
}

# LOCALE-INDEPENDENT TASK STATE. schtasks /fo list /v prints a TRANSLATED
# "Status: Running" heading and value, so matching Status:\s*Running read a
# RUNNING task as stopped on every non-English Windows. TaskState is an enum
# (Ready / Running / Disabled / …) whose name does not follow the UI language.
# A guest without the ScheduledTasks module answers $null = NOT MEASURED.
function Test-TaskRunning([string]$name) {
  try {
    $state = [string](Get-ScheduledTask -TaskName $name -ErrorAction Stop).State
    if ($state) { return ($state -match '(?i)^\s*running\s*$') }
  } catch { }
  return $null
}

function Get-TaskXml([string]$name) {
  try { return (& schtasks /query /tn $name /xml 2>$null | Out-String) } catch { return '' }
}

function Test-TaskBound([string]$xml, [string]$who) {
  if (-not $xml) { return $false }
  if ($xml -notmatch '<Task ') { return $false }
  if ($xml -notmatch '(?i)<LogonType>\s*InteractiveToken\s*</LogonType>') { return $false }
  if (-not $xml.ToLowerInvariant().Contains($who.ToLowerInvariant())) { return $false }
  if ($xml -notmatch '(?i)mcp-relay-host\.vbs') { return $false }
  return $true
}

function Find-Pythonw([string]$name) {
  $found = ''
  try { $found = (Get-Command pythonw.exe -ErrorAction Stop).Source } catch { $found = '' }
  if ($found) { return $found }
  $patterns = @(
    'C:\Program Files\Python*\pythonw.exe',
    'C:\Program Files (x86)\Python*\pythonw.exe',
    ('C:\Users\' + $name + '\AppData\Local\Programs\Python\Python*\pythonw.exe')
  )
  foreach ($pattern in $patterns) {
    $hit = @(Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1)
    if ($hit.Count -gt 0) { return $hit[0].FullName }
  }
  return 'pythonw.exe'
}

$probe = Get-RelayToken $port
$session = Get-ConsoleSession $user
if ($null -ne $session) { $sessionKnown = $true }
if (Test-Path -LiteralPath $relay) { $hash = (Get-FileHash -LiteralPath $relay -Algorithm SHA256).Hash.ToLowerInvariant() }
$xml = Get-TaskXml $task
$bound = Test-TaskBound $xml $user
if ($bound) { $taskOk = 1 }

# THE LAUNCHER MUST NAME THE PORT THE HARNESS PROBES. The firstboot launcher says
# bare --serve and lets the GUEST env decide; an interactive session has no
# DSH_CUA_MCP_RELAY_PORT, so it always binds 47999. Regenerate when absent or
# when it names another port - that is the port-divergence fix (direction E).
$launcherOk = $false
if (Test-Path -LiteralPath $vbs) {
  $content = Get-Content -LiteralPath $vbs -Raw
  if ($content -and $content.Contains('--port ' + $port + '"')) { $launcherOk = $true }
}
if (-not $launcherOk) {
  $pythonw = Find-Pythonw $user
  $runLine = 'shell.Run """' + $pythonw + '"" ""' + $relay + '"" --serve --port ' + $port + '", 0, False'
  Set-Content -LiteralPath $vbs -Encoding ASCII -Value @(
    "' cua-mcp-host: start the interactive-session MCP relay, hidden, no console.",
    "' Written by repairRelay() in plugins/dsh-cua-vm/win-mcp.js.",
    "' The PORT lives here on purpose: the relay must listen where the harness",
    "' probes, and an interactive session has no DSH_CUA_MCP_RELAY_PORT.",
    'Set shell = CreateObject("WScript.Shell")',
    $runLine
  )
}

if (-not $bound) {
  # /ru IS THE FIX. /it without /ru binds the task to the CALLER (SYSTEM) and
  # Windows refuses it (reproduced, exit 1); the same create with /ru <user>
  # succeeds from Session 0. The quoting goes through a .cmd file for the reason
  # cua-firstboot.ps1:877-892 documents: Windows PowerShell 5.1 hands a variable
  # containing spaces to a native program UNQUOTED.
  $tr = 'wscript.exe //B //NoLogo ' + $vbs
  $line = 'schtasks /create /tn "' + $task + '" /sc onlogon /ru "' + $user + '" /it /rl LIMITED /f /tr "' + $tr + '"'
  $cmdFile = Join-Path $env:TEMP 'cua-mcp-relay-repair.cmd'
  Set-Content -LiteralPath $cmdFile -Encoding ASCII -Value $line
  & cmd /c $cmdFile | Out-Null
  Remove-Item -LiteralPath $cmdFile -Force
  $xml = Get-TaskXml $task
  $bound = Test-TaskBound $xml $user
  $taskOk = 0
  if ($bound) { $taskOk = 1 }
}

# START ONLY IF THE PORT IS NOT ANSWERING. A /run against a live relay races it
# for the bind and the loser dies with WinError 10048 while the task still reads
# "started" - so the probe decides, never the /run.
if ($probe -ne 'RELAY_OK' -and $taskOk -eq 1) {
  & schtasks /run /tn $task | Out-Null
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  while ($clock.ElapsedMilliseconds -lt 8000) {
    Start-Sleep -Milliseconds 500
    $probe = Get-RelayToken $port
    if ($probe -eq 'RELAY_OK') { break }
  }
}

if ($probe -eq 'RELAY_OK') { $ok = 1 }
# THE HANDSHAKE IS THE GROUND TRUTH for "is the relay up"; the task state is only
# a second witness. $ok wins, then the un-localized enum, then EMPTY (unknown).
$state = Test-TaskRunning $task
if ($null -ne $state) {
  if ($state -eq $true) { $running = 1 } else { $running = 0 }
}
if ($ok -eq 1) { $running = 1 }

# DEFECT 4(b): WHICH PORT DID THE RELAY ACTUALLY ANSWER ON? Three witnesses, in
# decreasing strength, and the field stays EMPTY when none of them measured:
#   1. the harness port, when the handshake above just succeeded there;
#   2. the port the GUEST launcher names, if a relay answers there (a launcher
#      written by an older repair is exactly the divergence this catches);
#   3. any loopback port a python process is LISTENING on that answers the
#      RELAY_PING handshake - the interactive session's own socket, whatever the
#      harness happened to probe.
# The scan is capped (4 candidates / 4 s) so it cannot outlast the repair wall.
$answerPort = ''
if ($probe -eq 'RELAY_OK') { $answerPort = $port }
if (-not $answerPort -and (Test-Path -LiteralPath $vbs)) {
  $launcherText = Get-Content -LiteralPath $vbs -Raw
  if ($launcherText) {
    $declared = [regex]::Match([string]$launcherText, '--port\s+(\d{1,5})')
    if ($declared.Success) {
      $candidatePort = [int]$declared.Groups[1].Value
      if ($candidatePort -gt 0 -and $candidatePort -lt 65536 -and (Get-RelayToken $candidatePort) -eq 'RELAY_OK') { $answerPort = $candidatePort }
    }
  }
}
if (-not $answerPort) {
  $scanClock = [System.Diagnostics.Stopwatch]::StartNew()
  $scanned = 0
  foreach ($candidatePort in (Get-PythonListenPorts)) {
    if ($scanned -ge 4) { break }
    if ($scanClock.ElapsedMilliseconds -gt 4000) { break }
    $scanned += 1
    if (-not (Test-PortListening $candidatePort)) { continue }
    if ((Get-RelayToken $candidatePort) -eq 'RELAY_OK') { $answerPort = $candidatePort; break }
  }
}

if ($ok -ne 1) {
  # no-interactive-session is a MEASUREMENT ("the console has no session for
  # this account"), so it may only be claimed when $sessionKnown. An unparseable
  # row falls through to the facts that were measured instead of downgrading.
  if ($sessionKnown -eq $true -and $session -eq 0) { $reason = 'no-interactive-session' }
  elseif (-not $hash) { $reason = 'relay-missing' }
  elseif ($probe -eq 'RELAY_BAD') { $reason = 'probe-skew' }
  elseif ($taskOk -ne 1) { $reason = 'lane-unknown' }
  else { $reason = 'relay-stopped' }
}

# FROZEN GRAMMAR (Appendix B): the field NAMES and their order never change; an
# unmeasured value is simply EMPTY after running= / session=, which
# parseRelayRepairRecord() reads as null (not 0).
# port= is the GUEST's measurement (empty = not measured, see DEFECT 4(b)); the
# harness port this attempt was aimed at is NOT repeated here, so a consumer can
# finally compare the two and mean it.
Write-Output ('CUA_RELAY ok=' + $ok + ' port=' + $answerPort + ' task=' + $taskOk + ' running=' + $running + ' session=' + $session + ' probe=' + $probe + ' hash=' + $hash + ' mode=handshake reason=' + $reason)
if ($ok -eq 1) { exit 0 }
exit 1
`
}

/**
 * Parse one Appendix B record line. Tolerates a missing TAIL field and a missing
 * digest; never treats a missing `ok` as success (an empty/unreadable attempt is
 * a failure, always). Returns null when there is no record at all.
 *
 * A PARSED LINE WAS MEASURED — that is what `measured: true` below says. The
 * per-field `*Measured` flags keep the finer truth: a translated Windows (or an
 * old guest) may emit `session=` / `running=` EMPTY, and empty is "not measured",
 * which is a different fact from a measured `0`.
 *
 * DEFECT 4(b): `port` IS THE GUEST'S PORT NOW, NOT THE HARNESS'S. It used to be
 * backfilled with `relayPort()` when the line omitted it, which made
 * index.js's `portMismatch` structurally false — both sides of the comparison
 * were the harness's own number. An empty `port=` therefore parses to `null`
 * with `portMeasured: false` ("the guest could not say"), never to the harness
 * port; the harness port is the ATTEMPT's fact and travels as `targetPort` on
 * the repair record instead.
 */
export function parseRelayRepairRecord(stdout) {
  const text = String(stdout ?? '')
  const match = /CUA_RELAY[ \t]+([^\r\n]*)/u.exec(text)
  if (match === null) return null
  const fields = {}
  for (const token of match[1].trim().split(/\s+/u)) {
    const index = token.indexOf('=')
    if (index <= 0) continue
    fields[token.slice(0, index)] = token.slice(index + 1)
  }
  if (typeof fields.ok !== 'string' || fields.ok === '') return null
  const has = (value) => typeof value === 'string' && value.trim() !== ''
  const int = (value) => {
    if (!has(value)) return null
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  const port = int(fields.port)
  const task = int(fields.task)
  const running = int(fields.running)
  const session = int(fields.session)
  const probe = has(fields.probe) ? fields.probe : null
  const hash = typeof fields.hash === 'string' ? fields.hash : null
  return {
    measured: true,
    ok: fields.ok === '1',
    // GUEST-MEASURED. Empty ⇒ null + portMeasured:false; the harness port is
    // never substituted here (DEFECT 4(b)), so `portMismatch` can finally be
    // true and mean "the relay answers somewhere else".
    port,
    portMeasured: port !== null,
    task,
    running,
    session,
    probe,
    hash,
    taskMeasured: task !== null,
    runningMeasured: running !== null,
    sessionMeasured: session !== null,
    probeMeasured: probe !== null,
    hashMeasured: hash !== null,
    mode: typeof fields.mode === 'string' && fields.mode !== '' ? fields.mode : 'handshake',
    reason: typeof fields.reason === 'string' ? fields.reason : '',
    fields
  }
}

/**
 * REPAIR THE RELAY LANE FROM THE HARNESS (P1): one self-contained base64
 * PowerShell SSH command (§4.4), throttled, single-flight, never throwing.
 *
 * Returns the Appendix B record plus the attempt's own facts:
 *   { ok, measured, unmeasured, port, task, running, session, probe, hash,
 *     taskMeasured, runningMeasured, sessionMeasured, probeMeasured,
 *     hashMeasured, mode, reason, skipped, throttled, disabled, parsed,
 *     attempts, failures, backoffMs, at, ms, exitCode, detail }
 *
 * `measured` IS ALWAYS PRESENT (DEFECT 1). On `measured: false` the guest-side
 * fields are `null` — `session: null` is "not measured", `session: 0` is "a
 * repair measured that the console has no session". A classifier that conflates
 * them sends the operator to the wrong fix, which is exactly what J7 caught.
 *
 * RULES THAT ARE NOT NEGOTIABLE:
 *   * it NEVER throws — a timer or a sync path calls it, and a repair that can
 *     take the process down is worse than a blind lane;
 *   * it NEVER runs twice at once — a concurrent caller gets the same promise;
 *   * it is THROTTLED — 60 s, 300 s after three consecutive failures;
 *   * `DSH_CUA_VM_WIN_MCP_REPAIR=0` spawns NOTHING;
 *   * a success drops the probe cache, because the cached DOWN is the reason
 *     the next attach would still pick the blind lane.
 */
export async function repairRelay(options = {}) {
  const normalized = typeof options === 'function' ? { sshArgsFactory: options } : (options ?? {})
  const {
    host = '127.0.0.1',
    port: sshPort,
    user = 'cua',
    keyPath,
    force = false,
    timeoutMs = RELAY_REPAIR_TIMEOUT_MS,
    sshArgsFactory,
    spawnImpl = spawn,
    now = () => Date.now(),
    log = () => {}
  } = normalized

  const port = relayPort()
  const key = relayRepairKey({ host, port: sshPort, user, keyPath })
  const state = relayRepairState(key)
  const base = {
    ok: false,
    /**
     * DEFECT 1: THE MARKER. Every record below carries it, on every path.
     * `false` here because the base IS the no-measurement record: the fields a
     * classifier reads (`session`, `hash`, `probe`, `running`, `task`) are null,
     * not the old fabricated 0 / '' / 'RELAY_DOWN'.
     */
    measured: false,
    unmeasured: RELAY_REPAIR_UNMEASURED.NO_RECORD,
    skipped: false,
    throttled: false,
    disabled: false,
    parsed: false,
    /**
     * DEFECT 4(b): `port` IS THE GUEST-MEASURED ANSWER PORT — null until a
     * record proves one, and (on an unmeasured path) never the harness's own
     * number, which is what made index.js's `portMismatch` structurally false.
     * The harness port this attempt was aimed at is `targetPort`, a fact of the
     * ATTEMPT and clearly labelled as one.
     */
    port: null,
    portMeasured: false,
    targetPort: port,
    task: null,
    running: null,
    session: null,
    probe: null,
    hash: null,
    taskMeasured: false,
    runningMeasured: false,
    sessionMeasured: false,
    probeMeasured: false,
    hashMeasured: false,
    mode: 'handshake',
    reason: '',
    attempts: state.attempts,
    failures: state.failures,
    backoffMs: state.backoffMs,
    // `at` is this attempt's start; `lastAt` is the same instant under the name
    // the plugin's doctor reads (WP-3.2 names it) — one record, both readers.
    at: 0,
    lastAt: 0,
    ms: 0,
    exitCode: null,
    detail: ''
  }

  // The bridge's own kill switch wins too: a disabled bridge must not reach out.
  // NOT MEASURED either — and `unmeasured` says WHICH switch fired, so a report
  // cannot blame the guest switch for a disabled bridge.
  //
  // `reason` STAYS EMPTY. It is the Appendix B field the GUEST writes, so a
  // harness-side skip must not borrow that vocabulary: index.js's classifier
  // reads `reason` as a measured sentence, and a borrowed 'repair-disabled'
  // there preempts the probe evidence and turns J7's `relay-stopped` into
  // `repair-disabled`. The switch state is carried by `disabled` + `unmeasured`.
  if (windowsMcpEnabled() !== true || relayRepairEnabled() !== true) {
    const bridgeOff = windowsMcpEnabled() !== true
    return {
      ...base,
      skipped: true,
      disabled: true,
      measured: false,
      unmeasured: bridgeOff
        ? RELAY_REPAIR_UNMEASURED.BRIDGE_DISABLED
        : RELAY_REPAIR_UNMEASURED.REPAIR_DISABLED,
      reason: '',
      at: now(),
      lastAt: now(),
      detail: bridgeOff ? 'DSH_CUA_VM_WIN_MCP=0' : `${RELAY_REPAIR_DISABLED_ENV}=0`
    }
  }

  // Single flight: the second caller awaits the FIRST attempt, it does not queue
  // a second one. This is what keeps "one repair per throttle window" true even
  // when the doctor, the poll and the upgrade watch all ask at once.
  if (state.inFlight !== null) return state.inFlight

  const interval = state.failures >= RELAY_REPAIR_FAILURES_BEFORE_BACKOFF
    ? RELAY_REPAIR_BACKOFF_MS
    : RELAY_REPAIR_INTERVAL_MS
  if (force !== true && state.lastAt > 0 && (now() - state.lastAt) < interval) {
    // The throttle returns the LAST RECORD with its measurement truth intact; a
    // throttle before any attempt is itself unmeasured, and says so.
    return {
      ...(state.lastRecord ?? base),
      skipped: true,
      throttled: true,
      ...(state.lastRecord === null ? { unmeasured: RELAY_REPAIR_UNMEASURED.THROTTLED } : {}),
      detail: `throttled (${interval} ms)`,
      attempts: state.attempts,
      failures: state.failures,
      backoffMs: state.backoffMs
    }
  }

  state.attempts += 1
  state.lastAt = now()

  const attempt = (async () => {
    try {
      const script = relayRepairScriptSource({ port, user })
      // -EncodedCommand takes UTF-16LE base64: the carrier stays alphanumeric,
      // so cmd.exe cannot re-parse a quote inside the program.
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      const remoteCommand = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass ${RELAY_REPAIR_COMMAND_MARKER} ${encoded}`
      const argv = typeof sshArgsFactory === 'function'
        ? sshArgsFactory({ host, port: sshPort, user, keyPath, remoteCommand })
        : sshArgv({ host, port: sshPort, user, keyPath, remoteCommand })
      const capture = await runSshCapture({ argv, spawnImpl, timeoutMs, now })
      const parsed = parseRelayRepairRecord(capture.stdout)
      const failures = parsed?.ok === true ? 0 : state.failures + 1
      const backoffMs = failures >= RELAY_REPAIR_FAILURES_BEFORE_BACKOFF
        ? RELAY_REPAIR_BACKOFF_MS
        : RELAY_REPAIR_INTERVAL_MS
      const record = {
        ...base,
        ok: parsed?.ok === true,
        parsed: parsed !== null,
        // DEFECT 1: ONE FLAT RECORD, AND ITS MEASUREMENT TRUTH. A parsed line was
        // MEASURED (its values may still be individually empty — see the
        // `*Measured` flags); no line means the guest was never read, so the
        // fields stay null and `unmeasured` says why. `fields` (the raw key map)
        // stays out — the doctor payload carries facts, not parser internals.
        ...(parsed === null ? {} : {
          measured: parsed.measured === true,
          unmeasured: '',
          port: parsed.port,
          portMeasured: parsed.portMeasured === true,
          task: parsed.task,
          running: parsed.running,
          session: parsed.session,
          probe: parsed.probe,
          hash: parsed.hash,
          taskMeasured: parsed.taskMeasured === true,
          runningMeasured: parsed.runningMeasured === true,
          sessionMeasured: parsed.sessionMeasured === true,
          probeMeasured: parsed.probeMeasured === true,
          hashMeasured: parsed.hashMeasured === true,
          mode: parsed.mode,
          reason: parsed.reason
        }),
        exitCode: capture.exitCode,
        at: state.lastAt,
        lastAt: state.lastAt,
        ms: capture.ms,
        attempts: state.attempts,
        failures,
        backoffMs,
        detail: parsed === null
          ? String(capture.stderr || capture.stdout || capture.detail || '').trim().slice(0, 400)
          : ''
      }
      state.failures = failures
      state.backoffMs = backoffMs
      state.lastRecord = record
      if (record.ok === true) {
        // THE CACHE IS THE LANE. The DOWN that put this client here is still in
        // the 10 s probe cache; without this the next attach would re-use it and
        // choose the blind lane for a relay that now answers.
        resetRelayProbeCache()
        log(`mcp-win: relay repair ok (port ${port}, probe ${record.probe}, task ${record.task}, session ${record.session})`)
      } else {
        log(`mcp-win: relay repair failed (${record.reason === '' ? 'no CUA_RELAY record' : record.reason})${record.detail === '' ? '' : `: ${record.detail.slice(0, 120)}`}`)
      }
      return record
    } catch (error) {
      // Belt and braces: nothing in the block above is supposed to throw, and a
      // repair must still be a RECORD rather than a rejection if it does.
      const failures = state.failures + 1
      const backoffMs = failures >= RELAY_REPAIR_FAILURES_BEFORE_BACKOFF
        ? RELAY_REPAIR_BACKOFF_MS
        : RELAY_REPAIR_INTERVAL_MS
      const record = {
        ...base,
        // NOTHING WAS MEASURED: the attempt threw before it could read a line.
        measured: false,
        unmeasured: RELAY_REPAIR_UNMEASURED.EXCEPTION,
        at: state.lastAt,
        lastAt: state.lastAt,
        attempts: state.attempts,
        failures,
        backoffMs,
        detail: `repair failed: ${error?.message ?? error}`.slice(0, 400)
      }
      state.failures = failures
      state.backoffMs = backoffMs
      state.lastRecord = record
      log(`mcp-win: relay repair failed: ${error?.message ?? error}`)
      return record
    }
  })()

  state.inFlight = attempt
  try {
    return await attempt
  } finally {
    state.inFlight = null
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
 *
 * `spawnImpl` (default `spawn`) is DEFECT 11'S MISSING SEAM: every SSH child this
 * client creates — the attach AND every probe AND every repair — goes through it,
 * so a test can drive three fake guests (relay answers / usage-on-stderr /
 * silence) through the REAL lane decision instead of re-implementing it.
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
  spawnImpl = spawn,
  log = () => {}
}) {
  let child = null
  let buffer = ''
  let nextId = 1
  const pending = new Map()
  /**
   * `transport` is the LANE this client's SSH child runs on, `relayOk` the last
   * probe answer, `reason` the sentence a fallback wrote down. All of them are
   * part of the doctor payload — a bridge that is connected but blind must say so
   * — and `probeMode`/`interpreter` say WHICH carrier answered and which
   * interpreter the session command was therefore built from.
   */
  const state = {
    connected: false,
    online: false,
    serverInfo: null,
    tools: [],
    lastError: '',
    /**
     * WP-4.3: the KIND of the last failure, beside its text — `'ssh-closed' |
     * 'auth' | 'handshake' | 'unknown'`, `''` when nothing failed since the last
     * successful call. Additive: `lastError` keeps its exact text and no caller
     * that ignored this field changes behaviour. The FIRST classification wins
     * (a later message is usually a consequence), and a successful JSON-RPC
     * answer clears it.
     */
    lastFailureKind: '',
    /** WP-4.1/5.9: the last desktop-facts read, or null until one ran. */
    desktop: null,
    transport: null,
    relayPort: relayPort(),
    relayOk: null,
    relayStatus: null,
    probeMode: null,
    interpreter: null,
    /** DEFECT 3: a probe that never found an interpreter (RELAY_DOWN). */
    interpreterMissing: false,
    relayDetail: '',
    reason: '',
    /** The last repair record (Appendix B + attempt facts), null until one ran. */
    repair: null,
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
   * THE LANE FACTS A PROBE MAY MUTATE — AND THE SNAPSHOT/RESTORE PAIR THE UPGRADE
   * NEEDS (JURY2-CO1 defect 1: the stuck upgrade window).
   *
   * `maybeUpgradeTransport()` used to publish the up pair (`relayOk`,
   * `relayStatus`, `probeMode`, `interpreter`, `relayDetail`) the moment the
   * forced probe answered RELAY_OK, and only THEN check `pending.size` before
   * tearing the child down. A `tools/call` that started during the probe
   * therefore aborted the teardown while LEAVING the up pair behind, and the
   * state became a one-way trap:
   *
   *   * `shouldUpgradeToRelay()` refuses while `relayOk === true` (the pure
   *     guard that keeps the upgrade from repeating every poll), so no later
   *     attempt was ever made — "relay already known up" forever;
   *   * the doctor read the coherent up pair on a `session-0-direct` lane and
   *     reported `ok` + `laneUpgrading` ("completes within one poll cycle"),
   *     which was then false for the life of the session;
   *   * the desktop stayed blind while the report said it was fine.
   *
   * THE INVARIANT: the up pair is published by the SUCCESSFUL path ONLY, in the
   * same synchronous block as `shutdown()`. An aborted attempt restores this
   * snapshot, so the guest facts the lane decision was made from are exactly
   * what they were before the probe, and the attempt gives its throttle window
   * back (a deferred teardown must be retryable on the next poll, once the
   * request drains).
   */
  const LANE_FACT_KEYS = Object.freeze(['relayOk', 'relayStatus', 'probeMode', 'interpreter', 'interpreterMissing', 'relayDetail'])
  const snapshotLaneFacts = () => Object.fromEntries(LANE_FACT_KEYS.map((key) => [key, state[key]]))
  const restoreLaneFacts = (snapshot) => { for (const key of LANE_FACT_KEYS) state[key] = snapshot[key] }

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
    else {
      // WP-4.3: THE NEXT SUCCESSFUL CALL CLEARS THE KIND. An answer on the wire
      // is the proof that the transport is healthy again; keeping the old kind
      // would make the doctor report a failure that has already healed.
      state.lastFailureKind = ''
      entry.resolve(message.result)
    }
  }

  /**
   * Record a failure KIND once (WP-4.3). The first classification wins: ssh
   * prints its cause first and then a cascade, and the cascade is not the
   * diagnosis. Never rewrites `state.lastError`.
   */
  const recordFailureKind = (text, exitCode = null) => {
    if (state.lastFailureKind !== '') return
    const body = String(text ?? '')
    if (body === '' && (exitCode === null || exitCode === 0)) return
    state.lastFailureKind = classifySshFailureKind({ text: body, exitCode })
  }

  /**
   * The same, for a stderr LINE: only a CONFIDENT kind is recorded from a
   * message. The lane can print benign text (a relay line, a warning) and that
   * must not become the diagnosis — the exit handler is where an unclassifiable
   * failure becomes `'unknown'`, and it still wins over nothing.
   */
  const recordFailureKindIfKnown = (text) => {
    if (state.lastFailureKind !== '') return
    const kind = classifySshFailureKind({ text })
    if (kind !== 'unknown') state.lastFailureKind = kind
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
      // WP-4.3: the KIND beside the text. The first CONFIDENT classification
      // wins — ssh's first line is the cause, the rest are consequences — and
      // the text above stays byte-identical (C4 asserts it literally).
      recordFailureKindIfKnown(state.lastError)
      log(`mcp-win: ${state.lastError}`)
    })
    // A dead/suspended link makes the next write fail with EPIPE. Without a
    // listener that is an UNCAUGHT 'error' event, i.e. the whole harness
    // process exits — the exact failure the fast keepalive would now trigger
    // more often. Record it and let the pending requests fail on exit/timeout.
    child.stdin.on('error', (error) => {
      state.lastError = `stdin: ${error?.message ?? error}`.slice(-400)
      recordFailureKindIfKnown(state.lastError)
      log(`mcp-win: ${state.lastError}`)
    })
    child.on('exit', (code) => {
      const wasConnected = state.connected
      // WP-4.3: a session that ended non-zero with NO stderr still has a kind —
      // ssh's own 255 is the boot race this whole change is about. The exit is
      // the LAST chance to classify, so it only fills an empty slot.
      if (code !== 0 && code !== null) recordFailureKind(state.lastError, code)
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
   * REPAIR IN THE MIDDLE (P1). When the forced probe is still not OK and this
   * attach is on the blind lane, re-probing the same dead guest every minute IS
   * the P1 defect: nothing could fix a payload/lane mismatch, so a blind lane
   * stayed blind forever. One repairRelay() (throttled and single-flight inside)
   * and one forced re-probe are the whole delta; everything else is the existing
   * upgrade. The re-checks after EACH await are the existing in-flight pattern:
   * a `tools/call` that started during the repair must not have its child closed
   * underneath it.
   *
   * INVARIANT (JURY2-CO1 defect 1) — NOTHING IS PUBLISHED BY A DEFERRED ATTEMPT.
   * The up pair (`relayOk`/`relayStatus`/`probeMode`/`interpreter`/
   * `interpreterMissing`/`relayDetail`, the `LANE_FACT_KEYS` snapshot) is
   * committed in the SAME synchronous block as `shutdown()`, and every
   * non-success return (`abort()`) restores the pre-probe snapshot AND the
   * throttle stamp. Consequences, which are the contract:
   *
   *   * a probe that answered RELAY_OK but could not tear the child down leaves
   *     `relayOk` exactly as it was — never `true` on a lane that did not move;
   *   * the deferral is therefore TEMPORARY: the pure guard refuses without
   *     probing while `pending.size > 0`, and the first poll after the request
   *     drains re-probes and completes the move (`upgraded: true`);
   *   * the doctor can only read the up pair together with the teardown, so
   *     "ok + laneUpgrading" is a sub-poll window, never a permanent lie.
   *
   * Publishing the pair before the in-flight check made the window a one-way
   * trap: the guard then read `relayOk === true` as "already up", the lane never
   * moved, and the doctor reported `ok` + `laneUpgrading` on a blind session for
   * its whole life.
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
    const lastAttemptBefore = state.lastUpgradeAttemptAt
    state.lastUpgradeAttemptAt = now
    // THE ABORT RULE (JURY2-CO1 defect 1): a non-upgraded return publishes
    // NOTHING and gives the throttle window back. Restoring the lane facts keeps
    // `relayOk` honest (a probe that never led to a teardown must not tell the
    // doctor, or `shouldUpgradeToRelay()`, that the lane is up), and restoring
    // the attempt stamp is what makes the NEXT poll able to retry: the request
    // that deferred this teardown is by definition transient, and the pure guard
    // still refuses — without even probing — while `pending.size > 0`.
    const laneBefore = snapshotLaneFacts()
    const abort = (reason, extra = {}) => {
      restoreLaneFacts(laneBefore)
      state.lastUpgradeAttemptAt = lastAttemptBefore
      return { upgraded: false, reason, ...extra }
    }
    // Set only on the successful path, so the catch below can tell "a failure
    // before the teardown" (roll back, retryable) from a throw after it (the up
    // pair is already true of a child that is going away — keep it).
    let committed = false
    try {
      // One forced probe, used twice: before the repair and after it. `force`
      // because the cached answer may be the DOWN that put us on this lane, and
      // it may be seconds old — a relay that started since then must be seen.
      const forcedProbe = () => relayProbe({
        host, port: sshPort, user, keyPath, log, spawnImpl, force: true, timeoutMs: RELAY_PROBE_TIMEOUT_MS
      })
      let probe = await forcedProbe()
      if (probe.ok !== true && state.transport === 'session-0-direct') {
        // The probe could not read the relay. Before writing this guest off for
        // another minute, try to FIX it (one attempt; the throttle lives inside).
        if (state.connected !== true || child === null) return abort('gone during the repair')
        if (pending.size > 0) return abort('a request is in flight')
        const repair = await repairRelay({ host, port: sshPort, user, keyPath, spawnImpl, log })
        state.repair = repair
        // Re-checked AFTER the await — twice, because there are two awaits now.
        if (state.connected !== true || child === null) return abort('gone during the repair', { repair })
        if (pending.size > 0) return abort('a request is in flight', { repair })
        probe = await forcedProbe()
      }
      if (probe.ok !== true) {
        // A MEASURED failure may publish its DOWN facts: that is a downgrade
        // backed by this attempt's own probe, not an unbacked "up".
        state.relayOk = false
        state.relayStatus = probe.status
        state.probeMode = probe.probeMode ?? state.probeMode
        state.interpreterMissing = probe.interpreterMissing === true
        state.relayDetail = probe.relayDetail ?? state.relayDetail
        return { upgraded: false, reason: `relay still ${probe.status}`, repair: state.repair ?? null }
      }
      // Re-checked AFTER the await, BEFORE anything is published: a tool call
      // may have started while the probe ran, and closing the child underneath
      // it would fail the call the model is waiting on. The teardown is merely
      // DEFERRED — the up pair is not committed, so the next poll re-probes and
      // completes the move once the request has drained.
      if (state.connected !== true || child === null) return abort('gone during the probe')
      if (pending.size > 0) return abort('a request is in flight')
      // THE GOOD PATH — THE ONLY PLACE THE UP PAIR IS PUBLISHED. It is committed
      // in the same synchronous block as the teardown that makes it true, so the
      // doctor can never read "upgrading" on a lane that will not move: either
      // the child is being replaced (a real, sub-poll window) or `relayOk` is
      // still the pre-probe value.
      state.relayOk = true
      state.relayStatus = probe.status
      state.probeMode = probe.probeMode ?? state.probeMode
      state.interpreter = probe.interpreter ?? state.interpreter
      state.interpreterMissing = false
      state.relayDetail = probe.relayDetail ?? ''
      log(`mcp-win: ${name}: ${RELAY_UPGRADE_LOG} (port ${probe.port}, probe ${probe.probeMode ?? 'handshake'})`)
      committed = true
      shutdown()
      return { upgraded: true, reason: RELAY_UPGRADE_LOG, repair: state.repair ?? null }
    } catch (error) {
      log(`mcp-win: relay upgrade failed: ${error?.message ?? error}`)
      // A throw before the commit is the same kind of abort as an in-flight
      // deferral: publish nothing, and leave the next poll free to retry.
      if (committed !== true) return abort(`upgrade failed: ${error?.message ?? error}`)
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

  /**
   * WP-4.1/5.9: ONE bounded read of the guest's own desktop facts, remembered on
   * the client so `windows_desktop` can answer from the cache WITHOUT blocking.
   *
   * The module-level `desktopFacts()` owns the SSH child, the 8 s cap and the
   * 60 s TTL; this only supplies the target the client was created with and
   * keeps the last answer. It cannot throw — `desktopFacts()` never rejects, and
   * the belt-and-braces catch keeps a future edit from making the reveal path
   * fail on a read that is, by definition, optional.
   */
  const refreshDesktopFacts = async (options = {}) => {
    try {
      // `name` is part of the cache key (desktopFactsKey): this client's computer,
      // not merely the SSH port the supervisor happened to hand it.
      const facts = await desktopFacts({ name, host, port: sshPort, user, keyPath, spawnImpl, log, ...(options ?? {}) })
      state.desktop = facts
      return facts
    } catch (error) {
      const facts = normalizeDesktopFacts(null, { error: `desktop facts: ${error?.message ?? error}` })
      state.desktop = facts
      return facts
    }
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
      // the blind lane for its whole life. `spawnImpl` rides along so a test can
      // answer the probe without an ssh binary and a real guest.
      const facts = await resolveGuestMcpTransport({ host, port: sshPort, user, keyPath, log, spawnImpl })
      decided = facts
      state.transport = facts.transport
      state.relayPort = facts.relayPort
      state.relayOk = facts.relayOk
      state.relayStatus = facts.relayStatus
      state.probeMode = facts.probeMode ?? null
      state.interpreter = facts.interpreter ?? null
      // DEFECT 3: "the guest has no interpreter" (RELAY_DOWN, not skew) travels
      // with the rest of the lane facts so the doctor can name it.
      state.interpreterMissing = facts.interpreterMissing === true
      state.relayDetail = facts.relayDetail ?? ''
      if (facts.reason !== '') {
        state.lastError = facts.reason
        state.reason = facts.reason
        log(`mcp-win: ${name}: ${facts.reason}`)
      }
      log(`mcp-win: ${name} lane=${facts.transport} relay=${facts.relayStatus} probe=${facts.probeMode ?? 'none'}${facts.interpreter === null ? '' : ` interpreter=${facts.interpreter}`}`)
      const argv = sshArgv({ host, port: sshPort, user, keyPath, remoteCommand: facts.command })
      child = spawnImpl('/usr/bin/ssh', argv, { stdio: ['pipe', 'pipe', 'pipe'] })
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
     *
     * THIS IS THE OTHER HALF OF THE DOCTOR CONTRACT. relayDoctorFacts() (the
     * module-level helper) and this method must return the SAME SHAPE:
     * `probeMode`, `relayDetail`, `interpreterMissing`, `repair` and
     * `payload { measured, relayHash, expectedRelayHash, port, portMeasured,
     * skew }` included. A client that knows more than the helper — or less — is
     * how a blind bridge reported `ok` (P2). Field names are canonical here
     * (`transportCommand` / `transportReason`); the helper emits those AND the
     * aliases `command` / `reason` — see DOCTOR_FACTS_FIELDS.
     *
     * `payload.skew` is the fact that the guest relay ANSWERED and the harness
     * could not read it — see PAYLOAD_SKEW_SEMANTICS; it is evidence from the
     * probe token and the repair record, never a hash comparison
     * (`expectedRelayHash` vs `relayHash` is that comparison).
     */
    doctorFacts() {
      const probe = relayProbeCache.answer
      const record = state.repair ?? relayRepairRecord({ host, port: sshPort, user, keyPath })
      const relayStatus = state.relayStatus ?? decided?.relayStatus ?? probe?.status ?? null
      const probeMode = state.probeMode ?? decided?.probeMode ?? probe?.probeMode ?? null
      return {
        transport: state.transport ?? (probe === null ? null : (probe.ok === true ? 'interactive-relay' : 'session-0-direct')),
        relayPort: state.relayPort ?? relayPort(),
        relayOk: state.relayOk ?? probe?.ok ?? null,
        relayStatus,
        // CANONICAL (see relayDoctorFacts(): `command` / `reason` are the
        // aliases there, and this side has never emitted them).
        transportCommand: decided?.command ?? null,
        transportReason: state.reason,
        interpreter: state.interpreter ?? decided?.interpreter ?? null,
        // DEFECT 3: the same additive fact relayDoctorFacts() carries.
        interpreterMissing: (state.interpreterMissing ?? decided?.interpreterMissing ?? probe?.interpreterMissing) === true,
        probeMode,
        relayDetail: state.relayDetail ?? decided?.relayDetail ?? probe?.relayDetail ?? '',
        // WP-4.3/4.5: THE KIND OF THE LAST FAILURE, beside the text. `null`
        // means "nothing failed since the last successful call" — an empty
        // string would read as a kind nobody defined.
        lastFailureKind: state.lastFailureKind === '' ? null : state.lastFailureKind,
        repair: record,
        payload: {
          // DEFECT 1: the same marker `relayDoctorFacts()` carries — the two
          // doctors must agree field for field (P2), including this one.
          measured: record?.measured === true,
          relayHash: record?.measured === true ? (record?.hash ?? null) : null,
          // DEFECT 4(a)/(b): the SAME identity fields as the helper — the
          // harness-side expected hash, and the guest-measured port with its
          // measurement flag (so `portMismatch` can be computed from payload
          // alone, without reaching into `repair`).
          expectedRelayHash: expectedRelayHash(),
          port: record?.port ?? null,
          portMeasured: record?.portMeasured === true,
          // DEFECT 4(c): the honest flag — the relay ANSWERED, unreadable.
          skew: relayEvidenceSkew(relayStatus, record)
        }
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
    /**
     * WP-4.1/5.6/5.9: THE GUEST'S OWN DESKTOP FACTS, from the cache.
     *
     * Synchronous and never blocking: `windows_desktop` returns this or `null`
     * and must not wait for an SSH read while the model is watching a reveal.
     * `null` means "nothing measured yet in this process" — the reveal path
     * kicks `refreshDesktopFacts()` in the background instead (WP-5.9).
     */
    desktopFactsCached() {
      const facts = state.desktop
      if (facts === null || facts === undefined) return null
      // JURY-CO1 defect 5, at the synchronous reader too: a copy taken minutes
      // ago must not keep claiming `stale:false` about a file that has aged past
      // the TTL. The verdict is re-derived from the file's own `at`.
      return facts.measured === true
        ? { ...facts, stale: desktopFactsStale(facts.at, Date.now(), DESKTOP_FACTS_TTL_MS) }
        : facts
    },
    /**
     * WP-4.1: refresh them — one bounded SSH read, TTL-guarded (60 s), never
     * throws. This is the method WP-5.9 calls after a successful attach so the
     * first `windows_desktop` after a start already carries the facts.
     */
    refreshDesktopFacts(options = {}) {
      return refreshDesktopFacts(options)
    },
    /**
     * The same read under the name index.js's doctor helper uses (WP-5.6:
     * "a new client method delegating to `desktopFacts()`"). Two names, ONE
     * implementation — an alias, never a second code path.
     */
    desktopFacts(options = {}) {
      return refreshDesktopFacts(options)
    },
    /**
     * REPAIR, FROM THE CLIENT (P1). `syncWindowsMcp()` calls this when the bridge
     * is connected but blind; `windows_mcp_doctor({repair:true})` calls it with
     * `{force:true}` for one attempt on demand. Everything that makes a repair
     * safe — throttle, backoff, single-flight, the env kill switch, "never
     * throws" — lives in the module-level repairRelay(), NOT here: the plugin
     * must never re-implement it (WP-3.5).
     *
     * It does NOT touch `state.relayOk`: a repair that succeeded is evidence for
     * the NEXT forced probe, and claiming the relay is up before that probe would
     * make maybeUpgradeTransport() skip the upgrade it exists to perform.
     */
    async repairRelay(options = {}) {
      const record = await repairRelay({ host, port: sshPort, user, keyPath, spawnImpl, log, ...(options ?? {}) })
      state.repair = record
      return record
    },
    /**
     * TEARDOWN, AND THE FACTS DIE WITH THE COMPUTER (JURY-CO1 defect 3).
     *
     * `index.js`'s `teardown()` calls this on destroy/unbind, and the supervisor
     * frees the SSH port with the row — so the guest that replaces this one can
     * land on the SAME port. Dropping this computer's cache entry here (and
     * bumping its generation, so a read still in flight cannot write it back)
     * is what makes "a destroyed computer's facts never serve a new computer"
     * true even when the replacement reuses the same name and port.
     */
    close() {
      try { forgetDesktopFacts({ name, host, port: sshPort, user }) } catch { /* never measured */ }
      state.desktop = null
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
