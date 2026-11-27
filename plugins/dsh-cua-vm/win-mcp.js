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
 * THE FOURTH ANSWER — THE ONE THE HOST HALF OF R1 WAS MISSING (C1/C2, §11).
 *
 * `RELAY_OK` is an ACCEPT-LOOP answer and nothing more (frozen sentence C1): the
 * relay answered the cheap `RELAY_PING` handshake inside 2 s. It says NOTHING
 * about the MCP child behind it, which is why the measured 7-minute outage was
 * reported as healthy — the child was wedged and the accept loop was fine.
 *
 * This token is the other half: the FUNCTIONAL probe (`RELAY_FN` + a real
 * `initialize`/`tools/list` round trip) ran and the child did NOT answer. It is
 * the STRONGEST evidence class in `RELAY_ANSWER_RANK` (rank 3: the child was
 * measured and failed — stronger than "the harness could not read an answer"),
 * and at the same time the WEAKEST claim about usability, because the caller may
 * not call tools yet. Those two facts are not in tension, they are the point:
 *
 *   rank 3   → a consumer collapsing several answers keeps THIS one (it knows
 *              more than SKEW/DOWN do);
 *   relayOk  → stays `false` for it (`relayAnswerRelayOk()`), so
 *              `shouldUpgradeToRelay()` and the 10 s upgrade watch keep meaning
 *              "the lane can be used", never "the child is dead but the port is
 *              open". A token that made `relayOk` true would let a wedged child
 *              pass the one gate that exists to catch it.
 *
 * NOT the same value as `RELAY_DOWN`: DOWN is a TRANSPORT fact ("nothing
 * answered on that port"), this is a CHILD fact ("the relay answered and its
 * child did not"). They have different next actions — restart the relay vs.
 * restart the computer / repair the child — so they cannot share a string.
 */
export const RELAY_UNRESPONSIVE = 'RELAY_UNRESPONSIVE'

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
  [RELAY_SKEW]: 2,
  // C2: THE CHILD WAS MEASURED AND FAILED. Ranked above SKEW because "the child
  // did not answer an initialize/tools/list round trip" is a measurement, while
  // SKEW is "the harness could not read what the relay said". Rank orders
  // EVIDENCE, never usability — `relayOk` for this token is still false.
  [RELAY_UNRESPONSIVE]: 3
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
 * MAY THE CALLER USE THE LANE? — the ONE predicate for `relayOk`, shared by the
 * functional probe and every consumer that carries its answer forward.
 *
 * `RELAY_OK` is the only status that makes it true. Every other token is false
 * — including the rank-3 `RELAY_UNRESPONSIVE`, whose whole contract is "strong
 * evidence, useless lane": the relay IS listening (so it is not DOWN) and the
 * child is NOT answering (so it must not pass the gate that decides whether a
 * `tools/call` can be sent). Keeping this a function rather than an inline
 * `status === RELAY_OK` is what stops the rank-3 token from being "stronger, so
 * surely it counts as up" in a future edit.
 */
export function relayAnswerRelayOk(status) {
  return String(status ?? '') === RELAY_OK
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
export const PAYLOAD_SKEW_SEMANTICS = 'payload.skew is true only when the guest relay ANSWERED and the harness probe could not read the answer (payload/interpreter mismatch): relayStatus RELAY_SKEW or RELAY_BAD, the guest repair record says reason=probe-skew, or the functional probe answered `probe-unsupported` (TCP accepted, RELAY_FN sent, zero bytes back — a relay that predates the token). It is not a hash comparison: a differing relayHash is reported as relayHash vs expectedRelayHash, and a missing interpreter is RELAY_DOWN (interpreterMissing), never skew.'

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
export const DOCTOR_FACTS_FIELDS = 'canonical: transport, relayPort, relayOk, relayStatus, transportCommand, transportReason, interpreter, probeMode, relayDetail, repair, payload (all top-level); interpreterMissing rides along in the transport facts and passes through via the doctor spread when a client exists (absent, not false, when none does); aliases kept for existing consumers: command (= transportCommand), reason (= transportReason). payload as windows_mcp_doctor emits it: { measured, relayHash, expectedRelayHash, skew, port, portMeasured, relayPresent, portMismatch, expectedGuardHash, guardHash, guardPresent, task, stale } - relayPresent/guardPresent/task are three-valued (true measured present / false MEASURED absent / null nothing measured) and are emitted by BOTH producers through one owner (payloadPresence), because index.js keys the comparability of the relay pair on relayPresent and its guardPresent last resort on task; stale is the C6 answer payloadStale() returns (true differ / false agree / null no comparable pair), never a comparison of two possibly-null fields; relayPresent is true (hash read) / false (measured, no script) / null (not measured), and a MEASURED empty hash= is normalized on the wire to relayHash: null + relayPresent: false, never relayHash: ""; portMismatch is true only when both the guest-measured port and the harness port are known and differ; skew is the relay-answered-but-unreadable evidence flag, not a hash comparison. Client-only facts (WP-4.3/4.5): lastFailureKind on the client facts — ssh-closed | auth | handshake | unknown | null, beside the byte-identical lastError text (ssh-closed is the boot race, auth is a key/account problem, handshake means the session existed and the MCP exchange did not complete); desktop on windowsMcpDoctor — the guest-measured desktop facts { measured, at, stale, source, schema, user, session, python, dshCuaVersion, pywin32Version, win32ui, uiaLane, uiaLaneOk, elementLaneOk, scaleFix, workDir, workDirWritable, profileRootWritable, error }, where measured !== true means every field is unknown and never false; relayFunctional is CLIENT-ONLY like desktop and lastFailureKind — the last functional-probe answer { status, relayOk, measured, reason, budgetMs, elapsedMs, initializeMs, toolsListMs, tools, evidence { lastSuccessfulCallAgeMs, outstandingRequestAgeMs, childRestarts, lastWedgeAt, childPid, wedgeDeadlineMs }, evidenceAt, exitCode, mode: functional }, null until one ran (nothing measured is not a healthy child), relayOk false for RELAY_UNRESPONSIVE because rank-3 evidence is not a usable lane, and status RELAY_DOWN when the transport never delivered a token.'

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

/**
 * The token line, exactly as the probe programs print it.
 *
 * C2: THE SET IS FOUR NOW. `RELAY_UNRESPONSIVE` is the functional probe's
 * child-dead answer (see RELAY_UNRESPONSIVE), and it is read by the SAME
 * classifier as the cheap handshake's three — one owner for "a line that is a
 * token", so the functional probe cannot invent a second, disagreeing parser.
 *
 * The alternation ORDER is irrelevant for correctness (`RELAY_OK` and
 * `RELAY_UNRESPONSIVE` diverge at byte 6) and the cheap program can only ever
 * print OK/BAD/DOWN: a guest that printed the functional token at the cheap
 * probe would be classified as having answered, and `relayOk` would still be
 * false because only `RELAY_OK` sets it (relayAnswerRelayOk).
 */
const RELAY_TOKEN_RE = /RELAY_(OK|BAD|DOWN|UNRESPONSIVE)/u

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

/* ------------------------------------------------------------------ *
 * THE FUNCTIONAL PROBE (C1/C2/C3, §11) — R1's OTHER HALF
 * ------------------------------------------------------------------ */

/**
 * HOW LONG THE CHILD MAY TAKE to answer `initialize` + `tools/list`, in the
 * probe's own words (C2). This is the budget the ANSWER reports, not the SSH
 * budget: a child that has not answered two frames in 5 s is not slow, it is
 * wedged, and the relay's own watchdog kills it at 20 s.
 */
export const RELAY_FN_BUDGET_MS = 5000

/**
 * The probe program's WHOLE wall (C2 step 6). It is larger than the child budget
 * because it also carries the evidence read and two TCP connects; the SSH child
 * is killed at RELAY_FUNCTIONAL_PROBE_TIMEOUT_MS, which is larger again, so the
 * program's own bound is always the one that fires first and a slow guest
 * produces a TOKEN rather than a truncated capture.
 */
export const RELAY_FN_TOTAL_MS = 12000

/** The session's own read deadline inside the program (C2 step 4). */
export const RELAY_FN_SESSION_BUDGET_MS = 9000

/** How long the relay's outer SSH child may live. */
export const RELAY_FUNCTIONAL_PROBE_TIMEOUT_MS = 20000

/**
 * THE REASON SET, CLOSED (C3). A value outside it is a protocol violation, so
 * the host normalizes to `'no-evidence'` rather than forwarding a word the
 * doctor's sentence was never written for.
 */
export const RELAY_FN_REASONS = Object.freeze(['', 'child-silent', 'child-eof', 'session-busy', 'no-evidence', 'probe-unsupported'])

/**
 * THE FUNCTIONAL PROBE PROGRAM (C2, §11). A REAL SESSION, not a flag.
 *
 * WHY A PROGRAM AND NOT `--ping --functional`. §11 freezes this: a new CLI mode
 * is a dependency on the guest PAYLOAD, which is staged at machine-create and
 * never refreshed — the exact stale-payload failure the cheap probe was fixed
 * for (§27/Appendix A). A base64 program needs nothing from the guest but a
 * python interpreter, and it keeps `usage()` byte-identical.
 *
 * What it does, in order (C2):
 *   1. socket 1: send `RELAY_FN`, read ONE line (<= 8 KiB, <= 3 s) and parse it
 *      as the relay's live counters. No line / garbage ⇒ `RELAY_UNRESPONSIVE` +
 *      `{"measured":false,"reason":"no-evidence"}`, exit 3.
 *   2. `busy === true` ⇒ `RELAY_OK` + `{"measured":false,"reason":"session-busy"}`,
 *      exit 4. The relay is fine; NOBODY MEASURED the child, and the answer says
 *      so instead of borrowing the relay's health.
 *   3. socket 2: the three frames `connect()` sends — `initialize` (id 900001),
 *      `notifications/initialized`, `tools/list` (id 900002) — so the probe
 *      exercises the real session path and not a bespoke ping.
 *   4. read until both ids answered or 9 s; time each answer.
 *   5. print exactly two lines: the token (`RELAY_OK` iff BOTH answered AND
 *      `tools >= 1`; otherwise `RELAY_UNRESPONSIVE` with `child-silent` /
 *      `child-eof`) and the JSON answer.
 *   6. the whole program is bounded by RELAY_FN_TOTAL_MS.
 *
 * `tools >= 1` is not decoration (research Q2, upstream #332): a `tools/list`
 * that advertises nothing is not proof of a working child.
 */
export function relayFunctionalProbeProgram(port = relayPort()) {
  const target = Number.isInteger(Number(port)) ? Number(port) : RELAY_PORT_DEFAULT
  const version = MCP_PROTOCOL_VERSION
  return String.raw`import json as _j
import socket as _s
import sys as _y
import time as _t

_T0 = _t.time()
_WALL = ${RELAY_FN_TOTAL_MS / 1000}
_SESSION = ${RELAY_FN_SESSION_BUDGET_MS / 1000}
_PORT = ${target}
_VERSION = '${version}'


def _left():
    return max(0.05, _WALL - (_t.time() - _T0))


_ev = None
# THE THREE FLAGS ARE INITIALISED OUTSIDE THE try (C3): an exception inside the
# read must not erase the fact that the socket WAS connected and the token WAS
# sent - that pair plus zero bytes IS the diagnosis (see the branch below).
_connected = False
_sent = False
_bytes = 0
try:
    _c = _s.create_connection(('127.0.0.1', _PORT), min(3.0, _left()))
    _connected = True
    _c.settimeout(min(3.0, _left()))
    _c.sendall(b'RELAY_FN')
    _sent = True
    _b = b''
    while len(_b) < 8192:
        _p = _c.recv(8192 - len(_b))
        if not _p:
            break
        _b += _p
        _bytes = len(_b)
        if b'\n' in _b:
            break
    _c.close()
    _ev = _j.loads(_b.split(b'\n', 1)[0].decode('utf-8', 'replace'))
    if not isinstance(_ev, dict):
        _ev = None
except Exception:
    _ev = None

if _ev is None:
    print('RELAY_UNRESPONSIVE')
    # THREE WORLDS, THREE REASONS (C3). TCP never accepted -> the lane is down
    # (no-evidence, unchanged). TCP accepted, RELAY_FN sent, ZERO bytes back ->
    # the relay predates the token: probe-unsupported. Bytes came back but were
    # not the JSON line -> no-evidence (unchanged).
    print(_j.dumps({'measured': False, 'reason': ('probe-unsupported' if (_connected and _sent and _bytes == 0) else 'no-evidence'), 'mode': 'functional', 'at': None}))
    _y.exit(3)

_A = dict(_ev)
_A['mode'] = 'functional'

if _ev.get('busy') is True:
    _A['status'] = 'RELAY_OK'
    _A['measured'] = False
    _A['reason'] = 'session-busy'
    _A['elapsedMs'] = int((_t.time() - _T0) * 1000)
    print('RELAY_OK')
    print(_j.dumps(_A))
    _y.exit(4)

_INIT = _j.dumps({'jsonrpc': '2.0', 'id': 900001, 'method': 'initialize',
                  'params': {'protocolVersion': _VERSION, 'capabilities': {'tools': {}},
                             'clientInfo': {'name': 'dsh-cua-vm', 'version': '1.0.0'}}}) + '\n'
_NOTE = _j.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized', 'params': {}}) + '\n'
_LIST = _j.dumps({'jsonrpc': '2.0', 'id': 900002, 'method': 'tools/list', 'params': {}}) + '\n'

_a_init = False
_a_list = False
_eof = False
_init_ms = None
_list_ms = None
_tools = None
_buf = b''
_started = _t.time()
try:
    _c = _s.create_connection(('127.0.0.1', _PORT), min(3.0, _left()))
    _c.settimeout(min(2.0, _left()))
    _c.sendall(_INIT.encode())
    _c.sendall(_NOTE.encode())
    _c.sendall(_LIST.encode())
    _deadline = min(_T0 + _WALL, _started + _SESSION)
    while _t.time() < _deadline and not (_a_init and _a_list):
        try:
            _p = _c.recv(65536)
        except _s.timeout:
            continue
        except Exception:
            _eof = True
            break
        if not _p:
            _eof = True
            break
        _buf += _p
        while b'\n' in _buf:
            _line, _buf = _buf.split(b'\n', 1)
            try:
                _m = _j.loads(_line.decode('utf-8', 'replace'))
            except Exception:
                continue
            if not isinstance(_m, dict):
                continue
            if _m.get('id') == 900001:
                _a_init = True
                _init_ms = int((_t.time() - _started) * 1000)
            elif _m.get('id') == 900002:
                _a_list = True
                _list_ms = int((_t.time() - _started) * 1000)
                _r = _m.get('result')
                _tl = _r.get('tools') if isinstance(_r, dict) else None
                _tools = len(_tl) if isinstance(_tl, list) else 0
    _c.close()
except Exception:
    _eof = True

_ok = bool(_a_init and _a_list and isinstance(_tools, int) and _tools >= 1)
_A['status'] = 'RELAY_OK' if _ok else 'RELAY_UNRESPONSIVE'
_A['measured'] = _ok
_A['reason'] = '' if _ok else ('child-eof' if _eof else 'child-silent')
_A['budgetMs'] = ${RELAY_FN_BUDGET_MS}
_A['elapsedMs'] = int((_t.time() - _T0) * 1000)
_A['initializeMs'] = _init_ms
_A['toolsListMs'] = _list_ms
_A['tools'] = _tools if isinstance(_tools, int) else None
_A['evidenceAt'] = _ev.get('at')
print(_A['status'])
print(_j.dumps(_A))
_y.exit(0 if _ok else 3)
`
}

/**
 * THE ONE COMMAND (C2/B-3): `py -3 -c "<base64 program>"`.
 *
 * Same carrier rationale as `relayProbeCandidates` — base64 is A-Z a-z 0-9 + / =
 * so `"`, `%`, `^`, `&` and `|` cannot be mangled by `ssh → cmd.exe → python`.
 * No candidate list: every candidate the cheap probe proves also proves an
 * interpreter, so the functional probe starts from that interpreter and there is
 * nothing to fall back to (a second candidate would double a 20 s budget).
 */
export function relayFunctionalProbeCommand(port = relayPort(), interpreter = null) {
  const encoded = Buffer.from(relayFunctionalProbeProgram(port), 'utf8').toString('base64')
  const carrier = `exec(__import__('base64').b64decode('${encoded}').decode())`
  const head = String(interpreter ?? '').trim()
  return `${head === '' ? 'py -3' : head} -c "${carrier}"`
}

/** A non-negative integer, or `null`. Never `0` for "the guest did not say". */
function evidenceInt(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
  return null
}

/** An ISO-8601 string, or `null`. */
function evidenceIso(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * C3's evidence object, TYPED. The relay's `RELAY_FN` line and the facts file's
 * `relay` object share these names, so this is the one normalizer for both.
 *
 * HONESTY RULE: an absent key is `null`, never `0`. A relay that predates a
 * counter must not look like "a fresh child with no restarts and no outstanding
 * request" — that is the same defect class as `measured:false` being read as
 * `measured:false` ⇒ "all facts false".
 */
export function normalizeRelayEvidence(parsed) {
  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  // A line that carries NONE of the six counters is not an evidence line (it is
  // the answer half only). Reporting six `null`s would say "measured, all
  // unknown"; `null` says "nothing to read", which is what happened.
  const EVIDENCE_KEYS = ['lastSuccessfulCallAgeMs', 'outstandingRequestAgeMs', 'childRestarts', 'lastWedgeAt', 'childPid', 'wedgeDeadlineMs']
  if (EVIDENCE_KEYS.some((key) => Object.hasOwn(parsed, key)) !== true) return null
  const evidence = {
    lastSuccessfulCallAgeMs: evidenceInt(parsed.lastSuccessfulCallAgeMs),
    outstandingRequestAgeMs: evidenceInt(parsed.outstandingRequestAgeMs),
    childRestarts: evidenceInt(parsed.childRestarts),
    lastWedgeAt: evidenceIso(parsed.lastWedgeAt),
    childPid: evidenceInt(parsed.childPid),
    wedgeDeadlineMs: evidenceInt(parsed.wedgeDeadlineMs)
  }
  if (parsed.busy !== undefined) evidence.busy = parsed.busy === true
  if (parsed.attached !== undefined) evidence.attached = parsed.attached === true
  if (parsed.mode !== undefined) evidence.mode = parsed.mode
  if (parsed.at !== undefined) evidence.at = evidenceIso(parsed.at)
  return evidence
}

/** A C3 `reason`, or `''` when the guest said something outside the closed set. */
function relayFunctionalReason(value) {
  const text = typeof value === 'string' ? value : ''
  return RELAY_FN_REASONS.includes(text) ? text : ''
}

/**
 * THE FUNCTIONAL PROBE, HOST SIDE (C2/B-4) — ask the guest, in ONE ssh child,
 * whether the relay's MCP child answers a real session. Never throws.
 *
 * WHY NO `onStdout` SEAM. `runSshCapture`'s early-settle callback fires on the
 * FIRST token — which here is line 1 of 2, so settling there would truncate the
 * JSON evidence line and turn a measured child into `no-evidence`. The capture is
 * therefore allowed to run to close/EOF: the program's own 12 s wall is the
 * bound, and the outer SSH child is killed at 20 s.
 *
 * `measured` is the honest marker (C3): `true` only when the answer itself says
 * so. `status` is the token; `relayOk` is `relayAnswerRelayOk(status)` — so
 * `RELAY_UNRESPONSIVE` can never be read as a usable lane, even though it is the
 * strongest evidence in the ranking.
 */
export async function relayFunctionalProbe(options = {}) {
  const normalized = typeof options === 'function' ? { sshArgsFactory: options } : (options ?? {})
  const {
    host = '127.0.0.1',
    port: sshPort,
    user = 'cua',
    keyPath,
    timeoutMs = RELAY_FUNCTIONAL_PROBE_TIMEOUT_MS,
    interpreter = null,
    sshArgsFactory,
    spawnImpl = spawn,
    now = () => Date.now(),
    log = () => {}
  } = normalized
  const port = relayPort()
  const startedAt = now()
  const requested = timeoutMs === undefined || timeoutMs === null
    ? RELAY_FUNCTIONAL_PROBE_TIMEOUT_MS
    : Math.round(Number(timeoutMs))
  const budget = Number.isFinite(requested) ? Math.max(1, requested) : RELAY_FUNCTIONAL_PROBE_TIMEOUT_MS
  const command = relayFunctionalProbeCommand(port, interpreter)
  const answer = {
    mode: 'functional',
    port,
    status: RELAY_DOWN,
    relayOk: false,
    measured: false,
    reason: '',
    budgetMs: RELAY_FN_BUDGET_MS,
    elapsedMs: 0,
    initializeMs: null,
    toolsListMs: null,
    tools: null,
    evidence: null,
    evidenceAt: null,
    exitCode: null,
    detail: '',
    connectionLevel: false,
    cached: false
  }
  let capture = null
  try {
    const argv = typeof sshArgsFactory === 'function'
      ? sshArgsFactory({ host, port: sshPort, user, keyPath, remoteCommand: command })
      : sshArgv({ host, port: sshPort, user, keyPath, remoteCommand: command })
    capture = await runSshCapture({ argv, spawnImpl, timeoutMs: budget, now })
  } catch (error) {
    // Belt and braces: runSshCapture never rejects, and a probe must still be an
    // ANSWER if a future edit makes it throw.
    answer.detail = `functional probe failed: ${error?.message ?? error}`.slice(0, 240)
    answer.elapsedMs = Math.max(0, now() - startedAt)
    log(`mcp-win: relay functional probe 127.0.0.1:${port} → ${answer.status} (${answer.detail})`)
    return answer
  }
  answer.elapsedMs = Math.max(0, now() - startedAt)
  answer.exitCode = capture.exitCode ?? null
  answer.detail = String(capture.stderr || capture.detail || '').trim().slice(0, 240)
  answer.connectionLevel = capture.connectionLevel === true

  const seen = RELAY_TOKEN_RE.exec(capture.stdout)
  const tokenStatus = seen === null ? null : `RELAY_${seen[1]}`
  const parsed = parseLastJsonObject(capture.stdout)

  // NO TOKEN AT ALL. The transport never delivered the program's first line (a
  // spawn failure, ssh's own 255, an interpreter that does not exist), so this is
  // a TRANSPORT answer: RELAY_DOWN, and the reason is NOT a child reason — the
  // child was never asked (C2: DOWN vs UNRESPONSIVE are different diagnoses).
  if (tokenStatus === null) {
    answer.status = RELAY_DOWN
    answer.relayOk = false
    answer.measured = false
    answer.reason = ''
    log(`mcp-win: relay functional probe 127.0.0.1:${port} → ${answer.status} (no token; ${capture.detail || 'no detail'})`)
    return answer
  }

  answer.status = tokenStatus
  answer.relayOk = relayAnswerRelayOk(tokenStatus)
  answer.measured = parsed !== null && parsed.measured === true
  answer.reason = relayFunctionalReason(parsed?.reason)
  // A token WITHOUT a measured answer must still explain itself: `RELAY_OK` with
  // no JSON is "the program's answer line was lost", not health.
  if (answer.measured !== true && answer.reason === '') answer.reason = 'no-evidence'
  if (answer.measured === true) answer.reason = ''
  answer.initializeMs = evidenceInt(parsed?.initializeMs)
  answer.toolsListMs = evidenceInt(parsed?.toolsListMs)
  answer.tools = evidenceInt(parsed?.tools)
  answer.evidence = normalizeRelayEvidence(parsed)
  answer.evidenceAt = evidenceIso(parsed?.evidenceAt) ?? evidenceIso(parsed?.at)
  answer.detail = answer.measured === true ? '' : String(capture.stderr || '').trim().slice(0, 240)
  log(`mcp-win: relay functional probe 127.0.0.1:${port} → ${answer.status} measured=${answer.measured}${answer.reason === '' ? '' : ` reason=${answer.reason}`}`)
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

/* ------------------------------------------------------------------ *
 * C1 — THE BOOT-RACE WINDOW (RC-2, ticket item a)
 * ------------------------------------------------------------------ */

/**
 * THE WINDOW, AND WHY IT IS 90 s.
 *
 * A boot race is not a blind lane and not a stopped relay: it is the bounded,
 * expected interval between "the supervisor says the computer is ready" and "the
 * logon task's relay answers". `90000` MIRRORS THE GUARD'S OWN BUDGET — the
 * Windows-side `cua-relay-guard.ps1` waits up to 90 s for an `Active` console
 * session and then up to 20 s for the listener — because a harness that models a
 * different window than the guest would disagree with it about when a lane is
 * late. It is a constant on both sides on purpose (C10: no env knob; a knob here
 * would let the two sides drift).
 */
export const BOOT_RACE_WINDOW_MS = 90000

/**
 * THE ATTACH'S OWN CAP INSIDE THE WINDOW: 24 s.
 *
 * The ladder's last probe offset (20 s) plus one probe timeout (4 s) is exactly
 * this number, and `24000 < WIN_MCP_ATTACH_TIMEOUT_MS = 45000` leaves the
 * handshake its budget after the ladder gives up (S7 asserts the arithmetic).
 */
export const BOOT_RACE_ATTACH_MS = 24000

/** One probe inside the window. Short on purpose: a closed port answers at once. */
export const BOOT_RACE_PROBE_TIMEOUT_MS = 4000

/**
 * THE THROTTLE THE WINDOW HANDS TO `shouldUpgradeToRelay` — 10 s, four times
 * faster than the normal 60 s. Without it the first failed upgrade attempt
 * inside the window would lock the next out for 60 s, so a relay that binds at
 * ready+50 s would not be picked up until ready+99 s, long after the window
 * closed. The 15 s `setInterval` and its teardown are NOT touched (C1 rule 7):
 * at a 10 s throttle every 15 s beat is already an attempt.
 */
export const BOOT_RACE_UPGRADE_INTERVAL_MS = 10000

/**
 * THE LADDER'S SCHEDULE, in ms SINCE THE FIRST PROBE.
 *
 * `[0, 8000, 20000]` — the first probe is the attach's own, then two retries.
 * Frozen and strictly ascending; `last <= BOOT_RACE_ATTACH_MS` is the bound, and
 * the DELTAS (8 000 / 12 000) are what the transport's `sleep` seam records.
 */
export const BOOT_RACE_PROBE_OFFSETS_MS = Object.freeze([0, 8000, 20000])

/**
 * THE WINDOW'S TRUTH TABLE — the ONLY place it lives.
 *
 *   source  'stream'  the newest `vm-state:<name>:ready` event for THIS computer
 *                     (`readyAt`, epoch ms) — the anchor C1 rule 2 nominates;
 *           'attach'  only this client's first attach is known (`attachedAt`);
 *           'none'    neither: NO window, `live:false`, and the doctor keeps
 *                     saying `relay-stopped` (guessing a window from nothing is
 *                     how a doctor cries wolf);
 *   live    `sinceReadyMs >= 0 && sinceReadyMs < windowMs` AND `measured !== true`.
 *
 * A MEASURED fact outranks the window (C1 rule 4): a repair record that measured
 * `session: 0` or `hash: ''` is evidence, and evidence must never be relabelled
 * "wait a bit". `remainingMs` is what the doctor prints; it ages honestly because
 * the caller recomputes this object on every read (a stored snapshot would claim
 * a stale `live`).
 */
export function bootRaceFacts({
  readyAt = null,
  attachedAt = null,
  nowMs = null,
  windowMs = BOOT_RACE_WINDOW_MS,
  relayStatus = '',
  measured = false
} = {}) {
  // `Number(null)` is 0, which would silently mean "the epoch" — a null/absent
  // clock must mean NOW, and only a real number may be honoured.
  const at = nowMs === null || nowMs === undefined
    ? Date.now()
    : (Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now())
  const usable = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null)
  const ready = usable(readyAt)
  const attached = usable(attachedAt)
  const window = Number.isFinite(Number(windowMs)) && Number(windowMs) >= 0 ? Number(windowMs) : BOOT_RACE_WINDOW_MS
  // 'stream' WINS over 'attach': the supervisor's ready event is the real anchor,
  // the client's own attach is only the fallback when no event was seen.
  const source = ready !== null ? 'stream' : (attached !== null ? 'attach' : 'none')
  const anchorAt = ready !== null ? ready : attached
  const sinceReadyMs = anchorAt === null ? null : at - anchorAt
  const live = source !== 'none'
    && sinceReadyMs !== null
    && sinceReadyMs >= 0
    && sinceReadyMs < window
    && measured !== true
  return {
    live,
    source,
    windowMs: window,
    readyAt: ready,
    attachedAt: attached,
    anchorAt,
    sinceReadyMs,
    remainingMs: live === true ? Math.max(0, window - sinceReadyMs) : 0,
    measured: measured === true,
    relayStatus: String(relayStatus ?? ''),
    at
  }
}

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
 * THE LADDER (C1 rules 5-6): the attach's own probe, then TWO retries at the
 * frozen offsets, so a relay that binds at ready+37 s is caught INSIDE the
 * boot window instead of being reported as a stopped relay.
 *
 * Each probe is `force: true` — the cheap probe caches for
 * `RELAY_PROBE_TTL_MS = 10000`, and an unforced re-probe would answer from the
 * cache the first probe just wrote, making the ladder decorative.
 *
 * The bound is structural: `last(offsets) + one probe = 20000 + 4000 = 24000 =
 * BOOT_RACE_ATTACH_MS`, and that is < the 45 s attach budget, so the handshake
 * still has room after the ladder gives up.
 */
async function bootRaceProbeLadder({ log = () => {}, now = () => Date.now(), sleep, ...rest } = {}) {
  const pause = typeof sleep === 'function'
    ? sleep
    : (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); })
  const probeOptions = { ...rest, log, now }
  let probe = await relayProbe({ ...probeOptions, force: true, timeoutMs: BOOT_RACE_PROBE_TIMEOUT_MS })
  for (let index = 1; index < BOOT_RACE_PROBE_OFFSETS_MS.length; index += 1) {
    if (probe?.ok === true) break
    const wait = BOOT_RACE_PROBE_OFFSETS_MS[index] - BOOT_RACE_PROBE_OFFSETS_MS[index - 1]
    if (wait > 0) await pause(wait)
    probe = await relayProbe({ ...probeOptions, force: true, timeoutMs: BOOT_RACE_PROBE_TIMEOUT_MS })
  }
  return probe
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
  const {
    log = () => {},
    // C1 rule 2: a ZERO-ARG provider. The plugin owns how a computer is dated
    // (`windowsBootReadyAt(name)`); the client adapts it to this shape, so the
    // transport never learns the plugin's stream model.
    bootWindow: bootWindowProvider = null,
    now = () => Date.now(),
    sleep = null,
    measured = false,
    attachedAt = null
  } = normalized
  const readyAt = typeof bootWindowProvider === 'function' ? bootWindowProvider() : null
  const bootWindow = bootRaceFacts({ readyAt, attachedAt, nowMs: now(), measured })
  // TWO NAMES, ONE OBJECT: `bootWindow` is what the ladder's gate reads (and the
  // name the pins use); `bootRace` is what the facts travel under, so the client
  // and the doctor speak the same word as the payload field.
  const bootRace = bootWindow
  const override = winMcpCommandOverride()
  let probe
  if (bootWindow.live !== true) {
    // OUTSIDE THE WINDOW (or no anchor at all): ONE probe, exactly as before —
    // a genuinely dead relay must not cost 24 s of ladder.
    probe = await relayProbe({ ...normalized, log })
  } else if (override !== null) {
    // AN OVERRIDE IS A DECISION, NOT A LATE LOGON TASK: no ladder.
    probe = await relayProbe({ ...normalized, log })
  } else {
    probe = await bootRaceProbeLadder({ ...normalized, log, now, sleep })
  }
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
    override: override !== null,
    // C1: the window the attach decided in, so the client can publish it and the
    // doctor can print `remainingMs`. `null` here would be a guess; this is the
    // same object the ladder was gated on.
    bootRace,
    ladder: bootWindow.live === true && override === null
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
export function relayEvidenceSkew(relayStatus, record = null, functionalReason = '') {
  if (relayStatus === RELAY_SKEW) return true
  if (relayStatus === RELAY_BAD) return true
  if (record?.reason === 'probe-skew') return true
  // THE THIRD PRODUCER (C3, RC-3): the functional probe reached the relay's TCP
  // port, sent RELAY_FN and got ZERO bytes back — a relay that predates the
  // token. That is "the relay ANSWERED (its accept loop did) and the probe could
  // not read an answer", which is exactly what this flag says; reporting it as
  // "the child is dead" (the old `no-evidence` reading) sent the operator to
  // re-register a task that was already running.
  //
  // The client passes `state.relayFunctional?.reason`; the module-level helper
  // passes nothing (it has no functional answer, and inventing one would break
  // the "both doctors carry the same shape" rule at :548).
  return String(functionalReason ?? '') === 'probe-unsupported'
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
    // C1 rule 5: NO CLIENT, NO ATTACH CLOCK. This helper never attaches, so it
    // has no `attachedAt`; `null` is the honest answer, and it is documented
    // rather than a disagreement with the client's object.
    bootRace: null,
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
      //
      // C3: THE MODULE HELPER PASSES NO FUNCTIONAL REASON. It has no functional
      // answer (that is the client's), and inventing one would break the "both
      // doctors carry the same shape" rule — an absent fact is `''`, not a guess.
      skew: relayEvidenceSkew(facts.relayStatus, record),
      // WP-1B / C6: THE GUARD HALF OF THE PAYLOAD IDENTITY, and the one-word
      // verdict (`stale`) that RC-1 needed. `guardPresent` is three-valued like
      // relayPresent: true (a hash was read) / false (measured, no script) /
      // null (nothing measured). `stale` is C6's truth table, computed by its
      // one owner — never by comparing a field that may be null.
      expectedGuardHash: expectedGuardHash(),
      guardHash: record?.payload?.guardHash ?? null,
      // P1: THE INPUTS THE DERIVATION NEEDS, ON THIS PRODUCER TOO. `relayPresent`
      // and `task` used to be documented and produced by nobody, so index.js's
      // re-derivation lost a measured relay pair (`stale: null` where the owner
      // said `true`) and its `task` last resort never fired.
      ...payloadPresence(record),
      stale: payloadStale({
        expectedRelayHash: expectedRelayHash(),
        relayHash: record?.measured === true ? (record?.hash ?? null) : null,
        expectedGuardHash: expectedGuardHash(),
        guardHash: record?.payload?.guardHash ?? null
      })
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


/* ------------------------------------------------------------------ *
 * C4 — WHY THE FACTS FILE IS MISSING (RC-4, ticket item d)
 * ------------------------------------------------------------------ */

/**
 * THE ONE CODE FOR "THE GUEST HAS NO FACTS FILE", AND WHY IT IS A CODE.
 *
 * `desktop.error` used to be whatever two `type` calls printed on stderr — two
 * raw cmd.exe lines. It could not tell an operator the one thing that matters:
 * this guest has no facts WRITER (a pre-change payload), not an empty file. The
 * classification below is LANGUAGE-FREE on purpose: the guest may be a
 * translated Windows, and `The system cannot find the path specified` is
 * localized, so nothing here tests English.
 */
export const DESKTOP_FACTS_ABSENT = 'facts-file-absent'

/**
 * The closed set `desktop.errorCode` may name (C4). `''` is a measured answer.
 * NOT exported: the set is an implementation detail of the classifier below, and
 * an exported list invites a caller to validate against a copy of the contract
 * instead of against `classifyDesktopFactsError`. `DESKTOP_FACTS_ABSENT` stays
 * exported because callers COMPARE with it.
 */
const DESKTOP_FACTS_ERROR_CODES = Object.freeze(['', 'facts-file-absent', 'facts-unparsable', 'ssh-failed', 'read-error'])

/** The absent case's ONE sentence (C4) — never the doubled cmd stderr again. Internal, like the set above. */
const DESKTOP_FACTS_ABSENT_ERROR = `facts-file-absent: ${DESKTOP_FACTS_PATH} (the guest payload may predate the facts writer)`

/**
 * CLASSIFY ONE READ, FIRST MATCH WINS (C4's table, in its frozen order).
 *
 *   1. `connectionLevel` — SSH never reached the guest. Checked FIRST because a
 *      read that never happened also has empty stdout, and calling that a
 *      missing file would blame the guest for a transport failure.
 *   2. parsed `null` AND `stdout.trim() === ''` — both `type` calls failed:
 *      there is no file.
 *   3. parsed `null`, stdout non-empty — the file exists and is not JSON.
 *   4. the read threw — `read-error` (there is no capture to look at).
 *   5. a facts object was parsed — `''`, nothing to report.
 */
export function classifyDesktopFactsError({ parsed = null, stdout = '', connectionLevel = false, readError = false } = {}) {
  if (readError === true) return 'read-error'
  if (connectionLevel === true) return 'ssh-failed'
  if (parsed === null || parsed === undefined) {
    return String(stdout ?? '').trim() === '' ? DESKTOP_FACTS_ABSENT : 'facts-unparsable'
  }
  return ''
}
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
function normalizeDesktopFacts(parsed, { error = '', errorCode = '', now = () => Date.now(), ttlMs = DESKTOP_FACTS_TTL_MS } = {}) {
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
      // C4: WHY nothing was measured, as a closed code BESIDE the free-text
      // error. `''` here would mean "classified and fine", so an unclassified
      // failure falls back to the one code that is always true of it.
      errorCode: DESKTOP_FACTS_ERROR_CODES.includes(errorCode) && errorCode !== '' ? errorCode : 'facts-unparsable',
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
      // The file PARSED, so the code is `''`: `measured:false` is the guest's
      // own answer, not a read failure.
      errorCode: '',
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
    // A measured answer has nothing to classify.
    errorCode: '',
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
        // C4: THE CLASSIFICATION HAPPENS HERE AND ONLY HERE, because this is the
        // one place the CAPTURE is visible (stdout emptiness AND connectionLevel
        // together decide it). `desktop.error` for the absent case is the frozen
        // sentence, not the two cmd.exe stderr lines that named nothing.
        const errorCode = classifyDesktopFactsError({
          parsed,
          stdout: capture.stdout,
          connectionLevel: capture.connectionLevel === true
        })
        const failure = parsed !== null
          ? ''
          : (errorCode === DESKTOP_FACTS_ABSENT
              ? DESKTOP_FACTS_ABSENT_ERROR
              : String(capture.stderr || capture.stdout || capture.detail || '').trim().slice(0, 240))
        const facts = normalizeDesktopFacts(parsed, { error: failure, errorCode, now, ttlMs })
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
        return normalizeDesktopFacts(null, { error: `desktop facts: ${error?.message ?? error}`, errorCode: 'read-error', now, ttlMs })
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
    return normalizeDesktopFacts(null, { error: `desktop facts: ${error?.message ?? error}`, errorCode: 'read-error', now, ttlMs })
  }
}


/* ------------------------------------------------------------------ *
 * RC-1 / WP-1B — THE GUARD'S IDENTITY AND THE STAGING CARRIER
 * ------------------------------------------------------------------ */

/**
 * WHERE THE GUARD SCRIPT THIS BUILD SHIPS CAN BE READ FROM, harness side.
 *
 * One layout only, because the guard has exactly one home in both trees: beside
 * the relay in `docker/windows-oem/`. Resolved with `new URL(relative,
 * import.meta.url)` exactly like `RELAY_EXPECTED_HASH_SOURCES` — never
 * `process.cwd()`, which is the caller's, not the payload's. A build without the
 * `docker/` tree (an installed plugin bundle) answers `null`, and then a payload
 * repair MUST NOT pretend: it stages nothing and says `guardSource: 'absent'`.
 */
export const GUARD_EXPECTED_HASH_SOURCES = Object.freeze([
  '../../docker/windows-oem/cua-relay-guard.ps1'
])

/** Read-once cache: `{ loaded, hash, source }`. Lower-case hex SHA-256. */
let guardExpectedHashState = { loaded: false, hash: null, source: null }

/** The absolute path of the shipped guard script, or null when this build has none. */
export function guardExpectedHashSource() {
  for (const relative of GUARD_EXPECTED_HASH_SOURCES) {
    try {
      const url = new URL(relative, import.meta.url)
      const candidate = decodeURIComponent(url.pathname)
      if (existsSync(candidate) === true) return candidate
    } catch {}
  }
  return null
}

/**
 * THE HASH OF THE GUARD SCRIPT **THIS BUILD** SHIPS (C2 rule 1).
 *
 * `null` MEANS "THIS BUILD CANNOT SAY" — never `''` and never "mismatch". `''`
 * belongs to the guest-side fact "there is no guard file on this guest" (the
 * measure step writes `guard=''`), and conflating the two is how a harness
 * without a payload tree would call every guest stale.
 *
 * Read ONCE at first use, like `expectedRelayHash`; an explicit `sourcePath`
 * bypasses the cache (the seam a test uses).
 */
export function expectedGuardHash(sourcePath = null) {
  // J3: A ZERO-BYTE SOURCE IS "NO PAYLOAD", NOT `sha256('')`.
  //
  // The old code hashed whatever it read, so an empty (or truncated-to-empty)
  // `cua-relay-guard.ps1` produced the hash OF EMPTY — a value a guest can
  // legitimately match: the plan then staged 0 bytes, the verify CONFIRMED it
  // ("staged" with the hash of nothing) and the task was registered over a
  // guard that does nothing. `null` already means "this build cannot say"
  // everywhere else; an empty payload is exactly that case.
  const hashOfContent = (file) => {
    try {
      const bytes = readFileSync(file)
      return bytes.length === 0 ? null : createHash('sha256').update(bytes).digest('hex').toLowerCase()
    } catch {
      return null
    }
  }
  if (sourcePath !== null && sourcePath !== undefined && sourcePath !== '') {
    return hashOfContent(String(sourcePath))
  }
  if (guardExpectedHashState.loaded === true) return guardExpectedHashState.hash
  const source = guardExpectedHashSource()
  guardExpectedHashState = {
    loaded: true,
    hash: source === null ? null : hashOfContent(source),
    source
  }
  return guardExpectedHashState.hash
}

/** Which file the cached guard hash came from, or null (diagnostics + tests). */
export function expectedGuardHashSourcePath() {
  expectedGuardHash()
  return guardExpectedHashState.source
}

/** Forget the read-once guard hash (a test, or a caller that replaced the payload). */
export function resetExpectedGuardHashCache() {
  guardExpectedHashState = { loaded: false, hash: null, source: null }
}

/**
 * THE STAGING GEOMETRY (C2 rule 2), frozen:
 * `ceil(32590/3)*4 = 43456` base64 chars → `ceil(43456/6000) = 8` appends,
 * then 1 decode, 1 verify, 1 register — one measure in front (rule 3).
 *
 * WHY NOT `-EncodedCommand` (43 456 chars → ~87k UTF-16) or stdin: cmd.exe's
 * line limit is 8 191 characters, and `runSshCapture` spawns with
 * `stdio: ['ignore', 'pipe', 'pipe']`, so stdin is not a channel either. The
 * carrier is CHUNKED BASE64 APPENDS over the existing SSH child — base64 is
 * `A-Za-z0-9+/=`, so no quoting hazard survives `ssh → cmd.exe`.
 */
export const GUARD_STAGE_CHUNK_CHARS = 6000
export const GUARD_STAGE_PATH = 'C:\\ProgramData\\cua\\cua-relay-guard.ps1'
export const GUARD_STAGE_B64_PATH = 'C:\\ProgramData\\cua\\cua-relay-guard.b64'
export const GUARD_TASK_NAME = 'cua-mcp-host-guard'

/** The staging's own wall (C2 rule 8), enforced BETWEEN chunks. */
export const RELAY_PAYLOAD_REPAIR_TIMEOUT_MS = 25000

/**
 * `payload.stale` (C6), the words the docs must quote.
 *
 * `true` only when BOTH sides of at least one hash pair were measured and they
 * differ (relay or guard); `false` when every comparable pair agrees; `null`
 * when no pair is comparable — a build without the payload source cannot call a
 * guest stale. It is NOT skew: skew is "the relay answered and the probe could
 * not read it".
 */
export const PAYLOAD_STALE_SEMANTICS = 'payload.stale is true only when BOTH sides of at least one hash pair were measured and they differ (relay or guard); false when every comparable pair agrees; null when no pair is comparable (a build without the payload source cannot call a guest stale). It is not skew: skew is "the relay answered and the probe could not read it".'

/** C2 rule 9: the closed set for `record.payload.staged`, five values. */
export const PAYLOAD_STAGED_VALUES = Object.freeze(['none', 'current', 'staged', 'incomplete', 'absent'])

/** The second record line's prefix (C2 rule 10). `CUA_RELAY` is frozen. */
export const RELAY_PAYLOAD_RECORD_PREFIX = 'CUA_PAYLOAD'

const GUARD_POWERSHELL = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command '

/** One PowerShell body as an ssh remote command (single quotes inside only). */
function guardPowerShell(body) {
  return `${GUARD_POWERSHELL}"${body}"`
}

/**
 * ONE BASE64 APPEND, IN cmd.exe — NOT PowerShell.
 *
 * D2/D4 (live, 2026-11-21): a PowerShell child costs ≈2.9 s on `win-test`, and
 * 12 of them (8 appends + decode + verify + register + measure) could not fit
 * any deadline inside the doctor's 30 s forced-repair envelope. `cmd.exe` starts
 * in ≈0.15 s, so the CARRIER became cheap while the DECISIONS stayed in
 * PowerShell: 8 appends + register now cost ~1.5 s total instead of ~29 s.
 *
 * `echo <chunk> >>file` is safe for base64: the alphabet is `A-Za-z0-9+/=`, none
 * of which cmd.exe interprets. The trailing space `echo` writes before `>>` (and
 * the CRLF it adds) is stripped by the decoder (`-replace '\s',''`), which the
 * live run of this exact pair on `win-test` proved (`QUJD`+`REVG` → `ABCDEF`).
 * Chunk 0 truncates with `>`: no resume state, so a half-written carrier from an
 * interrupted run is replaced, never continued (C2 rule 8).
 */
export function relayStageAppendCommand({ path: target, chunk = '', truncate = false } = {}) {
  const file = String(target ?? '')
  const text = String(chunk ?? '')
  return `cmd /c "echo ${text} ${truncate === true ? '>' : '>>'}${file}"`
}

/**
 * DID THIS CHILD FAIL? — ONE predicate for both loops (P3).
 *
 * `runSshCapture` RESOLVES on `close` whatever happened, so the exit code is the
 * only signal a chunk had. Three shapes count as failure: a non-zero exit, a
 * TIMEOUT (`exitCode` null, the capture's own timer fired — the live run hit this
 * when the guest's sshd stopped answering mid-carrier and the old loop happily
 * counted the missing chunk as written), and a spawn-level failure (`detail`
 * set with no exit code). A clean close with code 0 is the only success.
 */
export function relayStepFailed(capture) {
  if (capture === null || capture === undefined) return true
  if (capture.timedOut === true) return true
  if (capture.exitCode === null || capture.exitCode === undefined) {
    // N2: NO EXIT CODE AT ALL IS A DEATH, NOT A SUCCESS. `runSshCapture` resolves
    // `{exitCode: null, detail: '', timedOut: false}` when the ssh child is killed
    // by a SIGNAL (SIGKILL/SIGTERM: no 'exit' event, no timer, no spawn error), and
    // the old predicate read that as success — a chunk that never landed was
    // counted as written. A clean `cmd /c echo` always reports a code, so an
    // unknown code is never a shape a successful step produces (spawn failures
    // land here too, with their `detail`).
    return true
  }
  return capture.exitCode !== 0
}

/** The decoded text of a base64 carrier, whitespace-insensitive (see above). */
function guardCarrierRead(path) {
  return `([IO.File]::ReadAllText('${path}') -replace '\\s','')`
}

/** The two hashes a guest can measure, as a PowerShell fragment. */
function guardHashFragment() {
  return [
    `$g=''`,
    `if (Test-Path '${GUARD_STAGE_PATH}') { $g=(Get-FileHash '${GUARD_STAGE_PATH}' -Algorithm SHA256).Hash.ToLowerInvariant() }`,
    `$r=''`,
    `if (Test-Path '${RELAY_SCRIPT}') { $r=(Get-FileHash '${RELAY_SCRIPT}' -Algorithm SHA256).Hash.ToLowerInvariant() }`
  ].join('; ')
}

/**
 * `stale=` FOR THE RECORD LINE — **C6'S TRUTH TABLE, NOT A NEAR MISS** (D5).
 *
 * The live round caught the guest printing `stale=0` (guard matches) while the
 * harness said `payload.stale:true` (relay differs) on the same guest, the same
 * second. Two rules, one field. From this revision the guest applies the SAME
 * table: a pair is COMPARABLE only when both sides are non-empty, `1` when a
 * comparable pair differs, `0` when every comparable pair agrees, and the EMPTY
 * value when nothing is comparable (`null` on the wire, exactly like
 * `payloadStale()`). The harness still derives its own `payload.stale` from the
 * measured hashes with `payloadStale()` — the ONE owner — so the line is a
 * rendering of the same table and can no longer disagree with the field.
 */
function guardStaleFragment(expectedGuard, expectedRelay) {
  return [
    `$p=0`,
    `$d=0`,
    `if ('${expectedGuard}' -ne '' -and $g -ne '') { $p=$p+1; if ($g -ne '${expectedGuard}') { $d=1 } }`,
    `if ('${expectedRelay}' -ne '' -and $r -ne '') { $p=$p+1; if ($r -ne '${expectedRelay}') { $d=1 } }`,
    `$s=''`,
    `if ($p -gt 0) { $s=$(if ($d -eq 1) { '1' } else { '0' }) }`
  ].join('; ')
}

/** Is the guard's scheduled task present? Measured, in the same child. */
function guardTaskFragment() {
  return [
    `$t=0`,
    `& schtasks /query /tn '${GUARD_TASK_NAME}' 2>$null | Out-Null`,
    `if ($LASTEXITCODE -eq 0) { $t=1 }`
  ].join('; ')
}

/** The record line, assembled from the fragments above. */
function guardPayloadLine(stagedExpression) {
  return `'${RELAY_PAYLOAD_RECORD_PREFIX} guard=' + $g + ' relay=' + $r + ' stale=' + $s + ' staged=' + ${stagedExpression} + ' task=' + $t`
}

/**
 * THE MEASURE (C2 rule 3): the first step, and the only one a HEAD guest pays.
 * It now also measures the TASK (D3): a guard file that is already ours does not
 * prove the task exists, and the live round found exactly that state — file
 * staged, `cua-mcp-host-guard` absent, and no way for the plan to create it.
 */
export function relayGuardMeasureCommand({ expectedGuard = '', expectedRelay = '', port = relayPort() } = {}) {
  const expected = String(expectedGuard ?? '').toLowerCase()
  const expectedRelayValue = String(expectedRelay ?? '').toLowerCase()
  const body = [
    // P2: THE MEASURE ALSO CLEANS THE CARRIER. The decode's `Remove-Item` is the
    // happy path, but a decode killed between WriteAllText and Remove-Item (or a
    // throwing decode on a host where a throw aborts the `;` list) leaves
    // `cua-relay-guard.b64` behind — and once the guard is CURRENT every later
    // plan is `[measure]` or `[measure, register]`, so no other step would ever
    // name it again. Deleting it here is free (same child), idempotent, and
    // means NO stale carrier can survive a completed repair.
    `Remove-Item -Force '${GUARD_STAGE_B64_PATH}' -ErrorAction SilentlyContinue`,
    guardHashFragment(),
    guardStaleFragment(expected, expectedRelayValue),
    guardTaskFragment(),
    `$c=0`,
    `if ('${expected}' -ne '' -and $g -eq '${expected}') { $c=1 }`,
    guardPayloadLine(`$(if ($c -eq 1) { 'current' } else { 'incomplete' })`)
  ].join('; ')
  return guardPowerShell(body)
}

/** THE VERIFY: re-hash after the decode and say `staged` only if it EQUALS. */
function relayGuardVerifyCommand({ expectedGuard = '', expectedRelay = '', port = relayPort() } = {}) {
  const expected = String(expectedGuard ?? '').toLowerCase()
  const expectedRelayValue = String(expectedRelay ?? '').toLowerCase()
  const body = [
    guardHashFragment(),
    guardStaleFragment(expected, expectedRelayValue),
    guardTaskFragment(),
    `$c=0`,
    `if ('${expected}' -ne '' -and $g -eq '${expected}') { $c=1 }`,
    guardPayloadLine(`$(if ($c -eq 1) { 'staged' } else { 'incomplete' })`)
  ].join('; ')
  return guardPowerShell(body)
}

/** THE DECODE: base64 (whitespace-stripped) → UTF-8 without BOM → the guard path.
 *
 * J2 — THE DECODE OWNS THE LAST LINE OF DEFENCE AGAINST A CORRUPT CARRIER.
 *
 * The carrier path is a fixed guest path, and `repairRelay()`'s single-flight is
 * PER PROCESS: two harness processes (or a harness and a stale attempt) append
 * into the same file, and the interleave used to decode a MIXED stream straight
 * over a good guard — 14 590 bytes of non-verifying script, after which the
 * register step still created the SYSTEM task (J1). A unique-per-process carrier
 * name would be the other half of the fix; it is NOT possible here without
 * breaking the frozen wire contract (the decoder child names the carrier path,
 * and the guest-side `cua-firstboot.ps1` / every shipped fixture models it), so
 * the invariant is enforced where it can be enforced atomically instead:
 *
 *   1. an EMPTY carrier is not "an empty payload" — refuse without writing, so
 *      a carrier another attempt reclaimed can never blank the guard;
 *   2. the DECODED BYTES are hashed and compared to the expected guard hash
 *      BEFORE `WriteAllText` — a mixed/truncated stream exits non-zero and
 *      leaves whatever guard was already there untouched.
 *
 * `expectedGuard` is the build's own hash, so this is a comparison of the
 * payload against itself: a legitimate decode always passes, and garbage never
 * reaches the guard file. `runPayloadRepair` still verifies AFTER the write
 * (bell and braces) and never registers without a verified guard (J1).
 */
function relayGuardDecodeCommand({ expectedGuard = '' } = {}) {
  const expected = String(expectedGuard ?? '').toLowerCase()
  const body = [
    `$b=${guardCarrierRead(GUARD_STAGE_B64_PATH)}`,
    `if ($b -eq '') { exit 3 }`,
    `$x=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))`,
    ...(expected === '' ? [] : [
      `$s=[Security.Cryptography.SHA256]::Create()`,
      `$h=(([BitConverter]::ToString($s.ComputeHash([Text.Encoding]::UTF8.GetBytes($x))) -replace '-','')).ToLowerInvariant()`,
      `if ($h -ne '${expected}') { Remove-Item -Force '${GUARD_STAGE_B64_PATH}' -ErrorAction SilentlyContinue; exit 4 }`
    ]),
    `[IO.File]::WriteAllText('${GUARD_STAGE_PATH}', $x, (New-Object Text.UTF8Encoding($false)))`,
    `Remove-Item -Force '${GUARD_STAGE_B64_PATH}' -ErrorAction SilentlyContinue`
  ].join('; ')
  return guardPowerShell(body)
}

/**
 * THE REGISTER (C2 rule 5), byte-compatible with `cua-firstboot.ps1`'s task so a
 * later provisioning pass cannot see a different shape — and now a **cmd** child
 * (≈0.15 s instead of ≈2.9 s) that MEASURES its own outcome: `&&` on the query
 * prints `task=1`, `||` prints `task=0`, so the record's `task` is what the
 * guest answered, never an assumption.
 */
export function relayGuardRegisterCommand({ port = relayPort() } = {}) {
  return `schtasks /create /tn "${GUARD_TASK_NAME}" /sc onstart /ru SYSTEM /rl HIGHEST /f /tr "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ${GUARD_STAGE_PATH} -Boot -Port ${port}" >nul 2>&1 && schtasks /query /tn "${GUARD_TASK_NAME}" >nul 2>&1 && echo ${RELAY_PAYLOAD_RECORD_PREFIX} task=1 || echo ${RELAY_PAYLOAD_RECORD_PREFIX} task=0`
}

/**
 * THE REPAIR SCRIPT'S CARRIER (D2) — the same base64-append geometry as the
 * guard, for the same reason: cmd.exe's line is 8 191 characters.
 *
 * THE LENGTH MOVES WITH THE CONFIGURATION (R2): the script EMBEDS the port and
 * the account (`--port <n> --user <s>`), so its character count — and therefore
 * its base64 — changes with their digits. At port=47999 / user=cua it is
 * ≈13 721 chars → ≈18 300 base64 (UTF-8, not UTF-16: nothing here needs
 * `-EncodedCommand`), which is **4 appends** of 6 000 + one short decoder that
 * decodes, deletes the carrier and `Invoke-Expression`s the script (which
 * prints the frozen `CUA_RELAY` line and exits 0/1 exactly as before). A wider
 * port or account moves the number by a handful of characters, never the
 * geometry — the append count is `ceil(base64 / 6 000)`, not a constant.
 *
 * Every child is ≤ 6 100 characters. A HEAD/poll repair therefore costs 5 SSH
 * children (~0.6 s of cmd + one ≈3 s PowerShell) instead of one refused child.
 */
export function relayRepairScriptCarrierPlan({ script = '', chunkChars = GUARD_STAGE_CHUNK_CHARS } = {}) {
  const text = String(script ?? '')
  const base64 = Buffer.from(text, 'utf8').toString('base64')
  const size = Number.isFinite(Number(chunkChars)) && Number(chunkChars) >= 1
    ? Math.floor(Number(chunkChars))
    : GUARD_STAGE_CHUNK_CHARS
  const chunks = Math.max(1, Math.ceil(base64.length / size))
  const steps = []
  for (let index = 0; index < chunks; index += 1) {
    steps.push({
      kind: 'append',
      command: relayStageAppendCommand({
        path: RELAY_REPAIR_CARRIER_PATH,
        chunk: base64.slice(index * size, (index + 1) * size),
        truncate: index === 0
      })
    })
  }
  steps.push({ kind: 'exec', command: relayRepairScriptExecCommand() })
  return steps
}

/** The short decoder that runs the staged script (and drops the carrier). */
export function relayRepairScriptExecCommand({ carrier = RELAY_REPAIR_CARRIER_PATH } = {}) {
  const body = [
    `$x=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${guardCarrierRead(carrier)}))`,
    `Remove-Item -Force '${carrier}' -ErrorAction SilentlyContinue`,
    `Invoke-Expression $x`
  ].join('; ')
  return guardPowerShell(body)
}

/**
 * THE PLAN (C2), PURE: it builds command strings and never spawns, which is what
 * makes the geometry and the ORDER testable without a guest (CB-1, CB-2, CB-3).
 *
 * Order: `measure → appends → decode → verify → register`. The first append
 * TRUNCATES the `.b64` (C2 rule 8) and the rest append.
 *
 * **D3 — REGISTRATION IS NOT CONDITIONAL ON THE FILE (C2 rule 5).** The live
 * round found the exact hole: once the guard file matched, the plan was
 * `[measure]`, so `register` could never run again — `win-test` had the file and
 * no task, permanently. The plan now takes BOTH measured facts and includes
 * `register` unless the FILE matches AND the TASK is present:
 *
 *   hash differs                      → measure + 8 appends + decode + verify + register (12)
 *   hash matches, task absent/unknown → measure + register (2)
 *   hash matches, task present        → measure only (1, nothing to write)
 */
export function relayGuardStagePlan({
  base64 = '',
  chunkChars = GUARD_STAGE_CHUNK_CHARS,
  measuredHash = null,
  expectedHash = null,
  expectedRelay = null,
  taskPresent = null,
  port = relayPort()
} = {}) {
  const expected = String(expectedHash ?? '').toLowerCase()
  const expectedRelayValue = String(expectedRelay ?? '').toLowerCase()
  const steps = [{
    kind: 'measure',
    command: relayGuardMeasureCommand({ expectedGuard: expected, expectedRelay: expectedRelayValue, port })
  }]
  const fileCurrent = measuredHash !== null && measuredHash !== undefined
    && expected !== ''
    && String(measuredHash).toLowerCase() === expected
  // `taskPresent === true` is the ONLY value that lets the plan stop: unknown is
  // not "present" (D3 — the state that made the task uncreatable).
  if (fileCurrent === true && taskPresent === true) return steps
  const text = String(base64 ?? '')
  // J3: AN EMPTY PAYLOAD CANNOT BE STAGED. Eight appends of nothing plus a
  // decode of nothing would overwrite the guest guard with a 0-byte file and
  // then "verify" the hash of empty — the plan must not contain a register for
  // a guard it could never verify. (The runtime refuses earlier, with
  // `staged: 'absent'`; this is the PURE builder's half of the same rule, so a
  // direct caller cannot get a task registered over nothing either.)
  const payloadAbsent = text.trim() === ''
  if (fileCurrent !== true) {
    const size = Number.isFinite(Number(chunkChars)) && Number(chunkChars) >= 1
      ? Math.floor(Number(chunkChars))
      : GUARD_STAGE_CHUNK_CHARS
    const chunks = Math.max(1, Math.ceil(text.length / size))
    for (let index = 0; index < chunks; index += 1) {
      const chunk = text.slice(index * size, (index + 1) * size)
      steps.push({
        kind: 'append',
        command: relayStageAppendCommand({ path: GUARD_STAGE_B64_PATH, chunk, truncate: index === 0 })
      })
    }
    steps.push({ kind: 'decode', command: relayGuardDecodeCommand({ expectedGuard: expected }) })
    steps.push({ kind: 'verify', command: relayGuardVerifyCommand({ expectedGuard: expected, expectedRelay: expectedRelayValue, port }) })
  }
  // A register is only ever planned for a guard that IS (or is about to be)
  // verified: the file already matches, or a non-empty payload with a known
  // expected hash is about to be decoded and verified.
  if (fileCurrent === true || (payloadAbsent === false && expected !== '')) {
    steps.push({ kind: 'register', command: relayGuardRegisterCommand({ port }) })
  }
  return steps
}

/**
 * `CUA_PAYLOAD` (C2 rule 10) — the SECOND record line, with its own prefix, so
 * the frozen `CUA_RELAY` grammar (and every fixture that parses it) is untouched.
 *
 * `staged` is the §C2-rule-9 WORD, not a boolean: "nothing to do" (`current`)
 * and "it worked" (`staged`) are different facts. A line that does not parse
 * yields `null`; a line that parses to an unknown word yields `incomplete` — the
 * value that means "try again" — and NEVER `staged`.
 */
export function parseCuaPayloadRecord(stdout) {
  // `[ \\t]*` (not `+`): a BARE `CUA_PAYLOAD` line is a MALFORMED record, and the
  // answer to that is `staged: 'incomplete'` — `null` is reserved for "no line
  // was printed at all", which a consumer must not confuse with a failed stage.
  const match = new RegExp(`${RELAY_PAYLOAD_RECORD_PREFIX}[ \\t]*([^\\r\\n]*)`, 'u').exec(String(stdout ?? ''))
  if (match === null) return null
  const fields = {}
  for (const token of match[1].trim().split(/\s+/u)) {
    const index = token.indexOf('=')
    if (index <= 0) continue
    fields[token.slice(0, index)] = token.slice(index + 1)
  }
  // J3-adjacent: a hash is hex, CASE-INSENSITIVE. PowerShell's own
  // `Get-FileHash` prints UPPERCASE by default; our fragments lower-case it
  // with `.ToLowerInvariant()`, but a guest (or a future launcher) that prints
  // the native form must not be read as "MEASURED ABSENT" — which is what the
  // old `/^[0-9a-f]{64}$/` did, and `guardPresent:false` on a matching guard
  // is exactly the inverted-presence class of defect. Normalize to lower case
  // so every consumer gets the same string.
  const hash = (value) => (typeof value === 'string' && /^[0-9a-f]{64}$/iu.test(value) ? value.toLowerCase() : null)
  const guardHash = hash(fields.guard)
  const relayHash = hash(fields.relay)
  return {
    guardHash,
    // PRESENCE IS "THIS LINE SPOKE ABOUT IT", NOT "the hash is non-null": the
    // register line carries `task=` alone, and deriving `false` from its missing
    // hash would overwrite the measure's `true` in the merge (the live repair
    // reported `guardPresent:false` on a guest whose guard matched, 2026-11-21).
    guardPresent: Object.hasOwn(fields, 'guard') ? guardHash !== null : null,
    relayHash,
    relayPresent: Object.hasOwn(fields, 'relay') ? relayHash !== null : null,
    // C6: `1`/`0`, and the EMPTY the guest prints when NO pair was comparable
    // (D5) — which is `null` here, exactly like `payloadStale()`.
    stale: fields.stale === '1' ? true : (fields.stale === '0' ? false : null),
    // D3: the guard TASK, measured by the same child. `null` when the line did
    // not carry it (a step that only registers prints `task=` alone).
    task: fields.task === '1' ? true : (fields.task === '0' ? false : null),
    // THE CLOSED SET OR `incomplete`. A guest that printed `staged=yes` did not
    // stage anything this harness can trust.
    staged: PAYLOAD_STAGED_VALUES.includes(fields.staged) ? fields.staged : 'incomplete',
    // WHICH fields this line actually carried — the merge in runPayloadRepair()
    // keeps the LAST value of each field a step spoke, so a register-only line
    // cannot reset the `staged` word the verify just proved.
    fields
  }
}

/**
 * MERGE ONE STEP'S RECORD INTO THE ATTEMPT'S (D3). Each step speaks about what it
 * measured: the measure says whether the FILE is `current` and whether the TASK
 * exists; the verify says `staged`/`incomplete`; the register says `task=` only.
 * The merge keeps the LAST value a step actually SPOKE for each field (`fields`
 * presence, not "the value differs from null"), so a register-only line cannot
 * reset the `staged` word the verify just proved.
 */
function mergePayloadRecord(base, parsed) {
  const next = { ...(base ?? {}) }
  if (parsed === null || parsed === undefined) return next
  for (const key of ['guardHash', 'guardPresent', 'relayHash', 'relayPresent', 'stale', 'task']) {
    if (parsed[key] !== null && parsed[key] !== undefined) next[key] = parsed[key]
  }
  const fields = parsed.fields ?? {}
  if (Object.hasOwn(fields, 'staged') === true) next.staged = parsed.staged
  return next
}

/** The record's `staged` word (the closed five), defaulting to the honest one. */
function mergedStaged(outcome) {
  return outcome?.staged === 'current' || outcome?.staged === 'staged' ? outcome.staged : 'incomplete'
}

/**
 * THE PAYLOAD'S PRESENCE FACTS — **THE ONE OWNER BOTH PRODUCERS CALL** (P1).
 *
 * `windowsPayloadFacts()` (index.js) keys the relay pair's COMPARABILITY on the
 * reported `relayPresent`, and its `guardPresent` ladder has a `task: true`
 * last resort. Neither producer ever emitted those two fields, so a MEASURED
 * relay pair was dropped by the doctor's re-derivation (`payload.stale: null`)
 * while `payloadStale()` said `true` — the published field contradicted the
 * verdict in the same answer (PRE defect 2).
 *
 * THREE-VALUED, LIKE EVERY OTHER MEASUREMENT IN THIS FILE:
 *   true   a hash was read (the file exists and hashed)
 *   false  MEASURED ABSENT — the line spoke about it and the value was empty
 *   null   nothing measured in this process (never "absent")
 *
 * `relayPresent` prefers the `CUA_PAYLOAD` line's own presence (it tracks
 * "this line spoke about relay=" per line) and falls back to the `CUA_RELAY`
 * record, which measures the relay hash on every parsed attempt — so a repair
 * run WITHOUT `payloadRepair` still reports the relay fact it measured.
 */
export function payloadPresence(record = null) {
  const payload = record?.payload ?? null
  const payloadMeasured = payload !== null && payload.staged !== 'none' && payload.staged !== 'absent'
  // A payload `XPresent: true` is only credible with a MEASURED hash beside it:
  // the parser can never produce the pair (it derives presence FROM the hash),
  // so a record that claims "present" over `garbage`/nothing is a fabrication
  // and is reported as false, not true (probe-4's sweep). An explicit `false`
  // stands as-is, and a missing field stays null.
  const payloadPresence = (present, hashValue) => {
    if (present === null || present === undefined) return null
    if (present !== true) return false
    return typeof hashValue === 'string' && /^[0-9a-f]{64}$/iu.test(hashValue.trim()) ? true : false
  }
  // THE `CUA_PAYLOAD` ARM: `payload.relayPresent` is already hasOwn-based in
  // parseCuaPayloadRecord (`relay=` empty ⇒ false, no field ⇒ null), so it is
  // spoken only when it is a real boolean; anything else falls through.
  const spoken = payloadMeasured === true && payload.relayPresent !== null && payload.relayPresent !== undefined
  const recordMeasured = record?.measured === true
  /**
   * THE `CUA_RELAY` ARM — READ `hashMeasured`, NOT `hash !== null` (re-PRE N1).
   *
   * The frozen grammar is: `hash=<hex>` measured present, `hash=` (EMPTY)
   * measured ABSENT, and a MISSING field never measured. parseRelayRepairRecord
   * already encodes that as `hashMeasured`; testing `hash !== null` instead
   * inverted BOTH non-hash arms (`''` read as present, `null` read as absent —
   * exactly backwards from DOCTOR_FACTS_FIELDS).
   */
  const hashText = typeof record?.hash === 'string' ? record.hash.trim() : null
  let fromRecord = null
  if (recordMeasured === true) {
    if (record?.hashMeasured === false) fromRecord = null            // the field was never spoken
    else if (hashText !== null) fromRecord = hashText !== ''         // '' = measured absent, hex = present
    else if (record?.hashMeasured === true) fromRecord = false       // measured, value gone
    else fromRecord = null
  }
  return {
    relayPresent: spoken === true ? payloadPresence(payload.relayPresent, payload.relayHash) : fromRecord,
    guardPresent: payloadMeasured === true
      ? payloadPresence(payload.guardPresent, payload.guardHash)
      : null,
    // D3's measured task: `true` after a register the guest confirmed, `false`
    // when it looked and the task was absent, `null` when nobody looked.
    task: payloadMeasured === true && payload.task !== undefined ? (payload.task ?? null) : null
  }
}

/**
 * C6's truth table, as ONE function so a consumer cannot re-derive it.
 *
 * `null` means NOTHING COMPARABLE (a build without the payload source, or no
 * measured hash) — never `false`: "this build cannot say" and "the guest agrees
 * with us" are different answers, and only one of them is actionable.
 */
export function payloadStale({ expectedRelayHash = null, relayHash = null, expectedGuardHash = null, guardHash = null } = {}) {
  const norm = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null)
  const pairs = []
  const expectedRelay = norm(expectedRelayHash)
  const measuredRelay = norm(relayHash)
  const expectedGuard = norm(expectedGuardHash)
  const measuredGuard = norm(guardHash)
  if (expectedRelay !== null && measuredRelay !== null) pairs.push(expectedRelay !== measuredRelay)
  if (expectedGuard !== null && measuredGuard !== null) pairs.push(expectedGuard !== measuredGuard)
  if (pairs.length === 0) return null
  return pairs.some(Boolean)
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

/**
 * THE REPAIR'S OWN WALL — the CALLER'S CAP FOR THE WHOLE ATTEMPT (P4).
 *
 * It is not "the launcher's budget": since the carrier was chunked, this number
 * bounds carrier + payload together, and `RELAY_REPAIR_TOTAL_MS` is the absolute
 * ceiling under it (`min(caller, TOTAL)` — a caller asking for 5 000 gets 5 000,
 * never 28 000).
 *
 * J5 — WHO ACTUALLY PASSES A BUDGET: the forced repair (`windows_mcp_doctor
 * {repair:true}`) now passes `timeoutMs: WIN_MCP_FORCE_REPAIR_MS = 30 000`, and
 * `min(caller, TOTAL)` clamps it to 28 000 — so the ceiling IS reached on that
 * path. The 15 s upgrade watch and the poll call `repairRelay()` WITHOUT a
 * budget and get `RELAY_REPAIR_TIMEOUT_MS` (25 000): that is the shipped
 * default, not the ceiling. Say which path you mean when you quote a number.
 */
export const RELAY_REPAIR_TIMEOUT_MS = 25_000

/**
 * THE WHOLE FORCED REPAIR'S ABSOLUTE CEILING (D2/D4) — a CLAMP, not a schedule.
 *
 * Two phases share it — the launcher CARRIER (5 children: 4 cmd appends + one
 * PowerShell exec) and the payload plan (12 children: measure, 8 cmd appends,
 * decode, verify, register) — and NEITHER phase may outlive it. The live round
 * measured ≈2.9 s per PowerShell child and ≈0.15 s per cmd child on `win-test`,
 * so the worst case is 4 × 2 900 + 13 × 150 ≈ 13 550 ms of work; 28 000 leaves
 * ~2× margin and still ends 2 000 ms before index.js's 30 000 guard, which is
 * what "the full plan fits" means in wall-clock terms.
 *
 * J5 — READ THIS BEFORE QUOTING 28 000: it is the UPPER BOUND of
 * `min(caller, TOTAL)`, so it only applies when the caller asks for it
 * (`timeoutMs: RELAY_REPAIR_TOTAL_MS`). With no caller budget the attempt gets
 * `RELAY_REPAIR_TIMEOUT_MS` (25 000), which is the shipped default. The ceiling
 * is reachable, the default is lower, and the two are not the same claim.
 */
export const RELAY_REPAIR_TOTAL_MS = 28_000

/**
 * THE PAYLOAD PHASE'S OWN WALL, normalised in ONE place (J4).
 *
 * `runPayloadRepair` takes a `deadline`; `deadline = null` (the default when a
 * caller reaches the phase directly) used to go through `Number(null) === 0`,
 * so `Math.min(0, startedAt + 25 000)` produced a deadline IN THE PAST and the
 * phase ran zero children — the "budget was gone before the measure" record on
 * a guest that would have answered. Non-positive/non-finite is UNSET here, the
 * same rule the caller side applies, so `null` gives the full staging budget.
 */
export function payloadStagingDeadline({ deadline = null, startedAt = 0, budgetMs = RELAY_PAYLOAD_REPAIR_TIMEOUT_MS } = {}) {
  const start = Number.isFinite(Number(startedAt)) ? Number(startedAt) : 0
  const budget = Number.isFinite(Number(budgetMs)) && Number(budgetMs) > 0 ? Number(budgetMs) : RELAY_PAYLOAD_REPAIR_TIMEOUT_MS
  const raw = Number(deadline)
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, start + budget) : start + budget
}

/**
 * WHAT ONE REPAIR CHILD COSTS, MEASURED ON THE LIVE GUEST (2026-11-21).
 *
 * `win-test` is a 2 vCPU tiny10: a cold `powershell -Command` child costs
 * ≈2 900 ms (the number that made 12 PowerShell children ≈30 s and cost the
 * `register` step its turn), and a `cmd /c` child ≈150 ms. These are EVIDENCE,
 * not budgets — the budgets are the two constants above — but they are exported
 * so `tests/modules-unit.mjs` can do the arithmetic the round is judged on
 * (CB-20) instead of asserting a comment.
 */
export const RELAY_REPAIR_STEP_MS = Object.freeze({ powershell: 2900, cmd: 150 })

/** What three failures buy: five minutes of silence. */
export const RELAY_REPAIR_BACKOFF_MS = 300_000

/** Consecutive failures that switch the interval to RELAY_REPAIR_BACKOFF_MS. */
export const RELAY_REPAIR_FAILURES_BEFORE_BACKOFF = 3

/** `DSH_CUA_VM_WIN_MCP_REPAIR=0` turns repair off without turning the bridge off. */
export const RELAY_REPAIR_DISABLED_ENV = 'DSH_CUA_VM_WIN_MCP_REPAIR'

/**
 * The marker a repair child is RECOGNISABLE by: probes carry `-c "exec(…)"`, the
 * relay lane carries `--connect`, and every child of the REPAIR CARRIER carries
 * this filename. D2 (live, 2026-11-21): the repair script used to ride ONE
 * `-EncodedCommand` — 13 721 chars → 36 592 base64 → a 36 667-character remote
 * command, past cmd.exe's 8 191-character line, refused by sshd with `exec
 * request failed on channel 0`. It is now staged in 6 000-char cmd appends into
 * this carrier file and executed by a short decoder, so every child is
 * cmd-line-safe.
 */
export const RELAY_REPAIR_CARRIER_PATH = 'C:\\ProgramData\\cua\\cua-relay-repair.b64'
export const RELAY_REPAIR_COMMAND_MARKER = 'cua-relay-repair.b64'

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
 * C6 — THE REPAIR'S SENTENCE. The ONE owner of "the repair could not tell us
 * anything", so `windows_mcp_doctor({repair:true})` can never answer
 * `ok:false, reason:''` again (R1b, measured: the diagnostic verb was silent on
 * the one occasion a user reaches for it).
 *
 * THE RETURN CONTRACT (and each half has a reason):
 *
 *   measured === true WITH a guest `reason`
 *                       → `''`. The record speaks for itself: `task-missing`,
 *                         `no-interactive-session`, `relay-missing`,
 *                         `probe-skew`, … Rewriting it here would be a second,
 *                         disagreeing diagnosis. This is the ONLY input that
 *                         returns an empty string.
 *   measured === true WITHOUT a `reason`
 *                       → `'the repair ran and reported no reason'` (+ `: detail`
 *                         when the record carries one). PRE-REVISE DEFECT #8: a
 *                         measured, failed repair with an empty reason used to
 *                         return `''`, which reached the model as
 *                         `forcedRepair.reason:''` — the same silence R1b fixed,
 *                         one branch further in.
 *   measured !== true   → a NON-EMPTY sentence naming WHY nothing was measured.
 *                         There is no such thing as "an unmeasured repair that
 *                         needs no explanation": that is the value the defect
 *                         produced.
 *
 * The caller's rule (index.js, WP-C) is
 * `String(answer?.reason ?? record?.reason ?? '') || describeRepairRecord(record)`,
 * so this function is the last line of defence: a record with no `reason` of its
 * own still yields words, never `''`.
 *
 * `unmeasured` outside the closed set (or absent) normalizes to `no-record`: the
 * honest reading of "this record does not say why" is "nothing came back", and
 * the detail is passed through verbatim — it is the only bytes that name the
 * actual error (an ssh stderr line, a throttle window, "bridge disabled").
 */
export function describeRepairRecord(record) {
  if (relayRepairMeasured(record) === true) {
    // A measured record that NAMED a cause speaks for itself: `''` tells the
    // caller "keep the record's own `reason` byte-identical" (C6).
    const why = String(record?.reason ?? '').trim()
    if (why !== '') return ''
    // MEASURED AND SILENT — and `''` is not an answer (DEFECT #8): the guest
    // answered the repair and named no cause, which is a fact the model must be
    // able to read. `forcedRepair.reason:''` on a measured, failed repair is the
    // same silence R1b was about, one branch further in.
    const said = String(record?.detail ?? '').trim()
    return said === '' ? 'the repair ran and reported no reason' : `the repair ran and reported no reason: ${said}`
  }
  const values = Object.values(RELAY_REPAIR_UNMEASURED)
  const said = String(record?.unmeasured ?? '').trim()
  const unmeasured = said !== '' && values.includes(said) ? said : RELAY_REPAIR_UNMEASURED.NO_RECORD
  const detail = String(record?.detail ?? '').trim()
  return `the guest never answered the repair (${unmeasured}): ${detail === '' ? 'no detail' : detail}`
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
/**
 * WP-1B's staging runner: MEASURE, then (only when the hash differs) the
 * append/decode/verify/register plan, inside ONE 25 s deadline.
 *
 * THE GATE IS THE FLAG, AND IT IS THE POINT (C2 rule 4): the 15 s upgrade watch
 * calls `repairRelay()` WITHOUT `payloadRepair`, because a poll that could stage
 * would push 8 SSH children every 60 s for the life of the machine. Only the
 * doctor's forced repair (`windows_mcp_doctor {repair:true}`) passes `true`.
 *
 * Costs, frozen by the live evidence: 13 SSH children on a stale guest (the
 * existing repair program + measure + 8 appends + decode + verify + register)
 * and 2 on a HEAD guest (the program + the measure, which finds the hash equal
 * and stages nothing). A doctor that spawns 13 where it should spawn 2 is this
 * gate broken.
 *
 * Never throws: a failed stage is a RECORD with `staged: 'incomplete'` and the
 * stderr that proves it.
 */
async function runPayloadRepair({
  payloadRepair = false,
  host = '127.0.0.1',
  sshPort,
  user = 'cua',
  keyPath,
  sshArgsFactory,
  spawnImpl = spawn,
  now = () => Date.now(),
  log = () => {},
  port = relayPort(),
  guardSource = 'local',
  // THE WHOLE REPAIR'S DEADLINE (D4): the payload phase may never outlive the
  // launcher phase's budget, or the doctor's 30 s guard cuts `register` — the
  // step the live round lost.
  deadline = null
} = {}) {
  const base = {
    staged: 'none',
    guardHash: null,
    guardPresent: null,
    relayHash: null,
    relayPresent: null,
    stale: null,
    guardSource,
    // J6: `writes` = FILE writes; `steps` = children that completed (so a
    // [measure, register] plan is writes 0 / steps 2, not "nothing happened").
    writes: 0,
    steps: 0,
    restaged: 0,
    ms: 0,
    detail: ''
  }
  if (payloadRepair !== true) return base
  const expected = expectedGuardHash()
  if (expected === null) {
    // THIS BUILD CANNOT STAGE (C2 rule 1): say so, write nothing.
    return { ...base, staged: 'absent', guardSource: 'absent', detail: 'this build has no guard payload source' }
  }
  const source = guardExpectedHashSource()
  let base64 = ''
  try {
    base64 = readFileSync(source).toString('base64')
  } catch (error) {
    return { ...base, staged: 'incomplete', detail: `guard payload unreadable: ${error?.message ?? error}`.slice(0, 240) }
  }
  // J3: 0 BYTES IS NOT A PAYLOAD. Staging "" writes an empty guard and the
  // verify then CONFIRMS the hash of empty (the plan only got here because the
  // engine's expected hash used to be `sha256('')`). Say "absent" and write
  // nothing — `staged: 'absent'` is the word consumers already understand.
  if (base64 === '') {
    return { ...base, staged: 'absent', guardSource: 'absent', detail: 'the guard payload is empty (0 bytes); refusing to stage nothing' }
  }
  const startedAt = now()
  // C2 rule 8's own wall, tightened by the shared deadline when one was passed.
  // J4: one normalizer (`payloadStagingDeadline`) so `null`/0/-1/NaN can never
  // become a deadline in the past — `Number(null) === 0` was exactly that bug.
  const stagingDeadline = payloadStagingDeadline({ deadline, startedAt, budgetMs: RELAY_PAYLOAD_REPAIR_TIMEOUT_MS })
  const expectedRelay = expectedRelayHash()
  /** One child, bounded by what is LEFT of the staging budget (C2 rule 8). */
  const runStep = async (step) => {
    const remaining = stagingDeadline - now()
    if (remaining <= 0) return null
    try {
      const argv = typeof sshArgsFactory === 'function'
        ? sshArgsFactory({ host, port: sshPort, user, keyPath, remoteCommand: step.command })
        : sshArgv({ host, port: sshPort, user, keyPath, remoteCommand: step.command })
      return await runSshCapture({ argv, spawnImpl, timeoutMs: remaining, now })
    } catch {
      return null
    }
  }
  let writes = 0
  // J6: `writes` counts FILE writes (append/decode) and stays 0 for a
  // [measure, register] plan — that is correct and unchanged. `steps` is the
  // honest "children that actually completed" counter, so a plan that created
  // the TASK is not reported as "nothing happened".
  let steps = 0
  let detail = ''
  /**
   * J1 — THE VERIFY GATE. A guest PowerShell child exits 0 on a MISMATCH
   * (the decode wrote *something*; only the record's word says whether it is
   * the payload), so the ONLY stop the old loop knew — the exit code — could
   * not see a failed verification: the live run answered `staged=incomplete`
   * and the very next child was `schtasks /create`, leaving a non-verifying
   * guard and a SYSTEM onstart task. Registration is now withheld unless a
   * MEASURED fact proved the file: the measure's `current`, or a verify's
   * `staged` whose hash matches this build's.
   *
   * J2 — ONE BOUNDED RE-STAGE. A mismatch right after OUR decode means the
   * carrier content was wrong (another process's appends, a reclaimed file).
   * Both `decode` and `verify` failures are retryable WE CARRIER problems; the
   * pass is re-run ONCE from the measure (which reclaims/cleans the carrier) if
   * budget remains. Append/register failures are not retried — an access-denied
   * chunk will not fix itself.
   */
  let passMismatch = false
  let restaged = 0
  const runPlanPass = async () => {
    let passOutcome = null
    let passDetail = ''
    const measured = await runStep({ kind: 'measure', command: relayGuardMeasureCommand({ expectedGuard: expected, expectedRelay, port }) })
    if (measured === null) return { budgetGone: true, outcome: null, detail: '', retryable: false }
    steps += 1
    passOutcome = parseCuaPayloadRecord(measured?.stdout)
    if (passOutcome === null) {
      passDetail = String(measured.stderr || measured.stdout || measured.detail || '').trim().slice(0, 240)
    }
    // 2. STAGE — the plan takes BOTH measured facts (D3): the guard hash AND the
    //    task. `[measure]` is returned only when the file matches AND the task is
    //    present; a matching file with no task yields `[measure, register]`.
    const plan = relayGuardStagePlan({
      base64,
      measuredHash: passOutcome?.guardHash ?? null,
      expectedHash: expected,
      expectedRelay,
      taskPresent: passOutcome?.task ?? null,
      port
    })
    // THE GATE'S STATE: the measure is a MEASURED proof only when it says the
    // file is `current` (hash equality with a known expected hash).
    let guardVerified = passOutcome?.staged === 'current' ? true : null
    let retryable = false
    for (const step of plan.slice(1)) {
      // J1: never create the SYSTEM task over a guard nothing verified.
      if (step.kind === 'register' && guardVerified !== true) {
        passDetail = passDetail === '' ? 'the register step was withheld: no pass verified the guard hash' : passDetail
        break
      }
      const capture = await runStep(step)
      if (capture === null) {
        // Out of budget: the carrier on the guest is half-written, and the
        // next call truncates and redoes it (no resume state). The FILE word is
        // kept when the measure already PROVED it current (index.js's
        // starved-register rule keys on exactly that pair).
        passOutcome = { ...(passOutcome ?? {}), staged: mergedStaged(passOutcome) === 'current' ? 'current' : 'incomplete' }
        passDetail = passDetail === '' ? 'the payload budget ended mid-stage' : passDetail
        break
      }
      // P3: A FAILED CHILD STOPS THE PLAN. A non-zero step is a hard stop, and
      // only SUCCESSFUL writes are counted. A decode that refuses the carrier
      // (J2's hash check / empty carrier) lands here.
      if (relayStepFailed(capture) === true) {
        passOutcome = { ...(passOutcome ?? {}), staged: 'incomplete' }
        passDetail = `payload step '${step.kind}' failed (${capture.exitCode === null ? capture.detail || 'no answer' : `exit ${capture.exitCode}`}): ${String(capture.stderr || capture.stdout || '').trim().slice(0, 200)}`
        // A refused decode is a CARRIER-content verdict, not a permission one.
        if (step.kind === 'decode') retryable = true
        break
      }
      steps += 1
      if (step.kind === 'append' || step.kind === 'decode') writes += 1
      const parsed = parseCuaPayloadRecord(capture.stdout)
      if (parsed !== null) passOutcome = mergePayloadRecord(passOutcome, parsed)
      if (step.kind === 'verify') {
        // J1: the verdict is the WORD plus the hash, never the exit code.
        const confirmed = parsed !== null && parsed.staged === 'staged'
          && (expected === '' || String(parsed.guardHash ?? '').toLowerCase() === expected)
        if (confirmed === true) {
          guardVerified = true
        } else {
          // The WORD (plus hash) is the verdict; stderr only rides along when
          // the guest failed to print one (stdout is the record itself).
          const raw = String(capture.stderr || capture.detail || '').trim()
          if (passDetail === '') {
            passDetail = `the verify did not report the expected hash${raw === '' ? '' : `: ${raw.slice(0, 160)}`}`
          }
          passOutcome = { ...(passOutcome ?? {}), staged: 'incomplete' }
          retryable = true
          break
        }
      }
    }
    return { budgetGone: false, outcome: passOutcome, detail: passDetail, retryable }
  }
  try {
    let pass = await runPlanPass()
    if (pass.budgetGone === true) {
      return { ...base, staged: 'incomplete', detail: 'the payload budget was gone before the measure' }
    }
    let outcome = pass.outcome
    detail = pass.detail
    passMismatch = pass.retryable === true
    // J2: ONE re-stage when the carrier content was wrong and the wall allows.
    if (passMismatch === true && now() < stagingDeadline) {
      const retry = await runPlanPass()
      if (retry.budgetGone !== true) {
        restaged = 1
        outcome = retry.outcome
        // The retry's verdict REPLACES the first pass's: a healed run must not
        // publish the mismatch that no longer describes the guest.
        detail = retry.detail
        passMismatch = retry.retryable === true
      }
    }
    const staged = mergedStaged(outcome)
    if (staged === 'incomplete' && detail === '') detail = 'the verify did not report the expected hash'
    // C6'S ONE OWNER (D5): `stale` is DERIVED from the measured hashes here, not
    // copied from the guest's line. The line prints the same table now, and this
    // is the field a consumer reads — two renderings, one rule.
    const guardHash = outcome?.guardHash ?? null
    const relayHash = outcome?.relayHash ?? null
    const task = outcome?.task ?? null
    log(`mcp-win: payload repair staged=${staged} task=${task} guard=${guardHash ?? ''} relay=${relayHash ?? ''} writes=${writes} steps=${steps}`)
    const payloadMs = Math.max(0, now() - startedAt)
    return {
      staged,
      guardHash,
      guardPresent: outcome?.guardPresent ?? null,
      relayHash,
      relayPresent: outcome?.relayPresent ?? null,
      stale: payloadStale({ expectedRelayHash: expectedRelay, relayHash, expectedGuardHash: expected, guardHash }),
      task,
      guardSource: 'local',
      writes,
      // J6: `writes` is FILE writes only, so a [measure, register] plan is 0 by
      // definition even though it CREATED THE TASK. `steps` is the honest
      // "children that completed" counter (measure included) and `restaged`
      // says the carrier was wrong once and the pass was re-run.
      steps,
      restaged,
      ms: payloadMs,
      detail
    }
  } catch (error) {
    return {
      ...base,
      staged: 'incomplete',
      guardSource: 'local',
      writes,
      steps,
      ms: Math.max(0, now() - startedAt),
      detail: `payload repair failed: ${error?.message ?? error}`.slice(0, 240)
    }
  }
}

export async function repairRelay(options = {}) {
  const normalized = typeof options === 'function' ? { sshArgsFactory: options } : (options ?? {})
  const {
    host = '127.0.0.1',
    port: sshPort,
    user = 'cua',
    keyPath,
    force = false,
    timeoutMs = RELAY_REPAIR_TIMEOUT_MS,
    // C2 RULE 4 — THE FROZEN OPTION NAME. index.js's forced repair passes
    // `{ payloadRepair: true }`; the 15 s upgrade watch deliberately does not,
    // because a poll that could stage would write 8 SSH children every 60 s.
    payloadRepair = false,
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
    detail: '',
    /**
     * WP-1B / C6: THE PAYLOAD OUTCOME, ALWAYS PRESENT. `staged: 'none'` is the
     * poll path (payload repair not requested); a requested attempt overwrites
     * the whole object with what the measure/verify lines proved. `guardSource`
     * is `'absent'` when this build cannot stage, so a consumer can tell "we did
     * not try" from "we cannot".
     */
    payload: {
      staged: 'none',
      guardHash: null,
      guardPresent: null,
      relayHash: null,
      relayPresent: null,
      stale: null,
      // D3: the guard TASK's presence as the guest measured it (`null` = not
      // measured). `staged` describes the FILE; `task` is the other half of
      // "the payload repair landed", and the live round proved they come apart.
      task: null,
      guardSource: expectedGuardHash() === null ? 'absent' : 'local',
      writes: 0,
      ms: 0,
      detail: ''
    }
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
      // D2: THE SCRIPT RIDES A CHUNKED CARRIER, NOT ONE 36 667-CHAR COMMAND.
      // Every child is ≤ 6 100 chars, so sshd accepts it; the last child is the
      // short decoder that decodes, deletes the carrier and runs the script,
      // whose own `CUA_RELAY` line and exit code are unchanged.
      // D4: ONE DEADLINE FOR THE WHOLE ATTEMPT (launcher + payload below), under
      // the doctor's 30 000 guard — see RELAY_REPAIR_TOTAL_MS.
      // ONE WALL FOR THE WHOLE ATTEMPT (P4): `min(caller, RELAY_REPAIR_TOTAL_MS)`,
      // read once and shared by the carrier chunks AND the payload phase below.
      // `repairRelay({timeoutMs: 5_000})` therefore finishes inside 5 s instead
      // of running the 28 s ceiling, and a payload step that cannot start
      // reports 'incomplete' rather than being silently skipped.
      const repairStartedAt = now()
      // NON-POSITIVE / NON-FINITE IS UNSET, NOT A ZERO BUDGET: `Number(null)` is 0,
      // so `{timeoutMs: null}` (or 0) used to collapse the wall to "now" and run
      // nothing at all. Every other reader in this file treats those as unset; this
      // one now does too.
      const callerRaw = Number(timeoutMs)
      const callerMs = Number.isFinite(callerRaw) && callerRaw > 0 ? callerRaw : RELAY_REPAIR_TIMEOUT_MS
      const repairDeadline = repairStartedAt + Math.min(callerMs, RELAY_REPAIR_TOTAL_MS)
      const carrierPlan = relayRepairScriptCarrierPlan({ script })
      let capture = null
      let carrierMs = 0
      // P3: A FAILED CHUNK STOPS THE CARRIER. `runSshCapture` resolves on
      // `close` whatever the exit code, so without this a chunk-0 `Access is
      // denied` let the remaining chunks append into the PREVIOUS run's carrier
      // and the exec ran a corrupt script. An `append` step that exits non-zero
      // breaks the loop; the `exec` step's exit code is the REPAIR'S OWN verdict
      // (`exit 0/1` from the script) and is deliberately not a carrier failure.
      let carrierFailure = ''
      for (const step of carrierPlan) {
        const remaining = repairDeadline - now()
        if (remaining <= 0) {
          carrierFailure = 'the repair budget ended mid-carrier'
          break
        }
        const argv = typeof sshArgsFactory === 'function'
          ? sshArgsFactory({ host, port: sshPort, user, keyPath, remoteCommand: step.command })
          : sshArgv({ host, port: sshPort, user, keyPath, remoteCommand: step.command })
        const stepCapture = await runSshCapture({ argv, spawnImpl, timeoutMs: remaining, now })
        carrierMs += stepCapture.ms
        capture = stepCapture
        if (step.kind === 'append' && relayStepFailed(stepCapture) === true) {
          carrierFailure = `carrier chunk failed (${stepCapture.exitCode === null ? stepCapture.detail || 'no answer' : `exit ${stepCapture.exitCode}`}): ${String(stepCapture.stderr ?? '').trim().slice(0, 160)}`
          break
        }
      }
      if (capture === null) {
        capture = { stdout: '', stderr: '', exitCode: null, detail: 'the repair budget was gone before its first chunk', ms: 0 }
      }
      if (carrierFailure !== '') {
        // The script never ran, so there is no CUA_RELAY line: the record below
        // is UNMEASURED and `detail` says why (never a parsed-looking record).
        capture = { ...capture, stdout: '', stderr: carrierFailure, exitCode: capture.exitCode ?? null, detail: carrierFailure }
      }
      const parsed = parseRelayRepairRecord(capture.stdout)
      // WP-1B: THE PAYLOAD HALF, AFTER THE PROGRAM (C2 rule 6 — the launcher the
      // guard will read already carries `--port`). Gated, bounded, never throws.
      const payload = await runPayloadRepair({
        payloadRepair,
        host,
        sshPort,
        user,
        keyPath,
        sshArgsFactory,
        spawnImpl,
        now,
        log,
        port,
        guardSource: base.payload.guardSource,
        deadline: repairDeadline
      })
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
        payload,
        at: state.lastAt,
        lastAt: state.lastAt,
        // J6: `ms` is the WHOLE ATTEMPT (carrier + payload), not just the
        // carrier's chunks — a 12-child payload phase used to be invisible in
        // the only duration field the record published. The split rides along
        // so a reader can still say which phase cost what.
        ms: Math.max(0, now() - repairStartedAt),
        carrierMs,
        payloadMs: Number.isFinite(Number(payload?.ms)) ? Math.max(0, Number(payload.ms)) : 0,
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
        // A requested payload repair that never reached its measure is
        // `incomplete` — the one value that means "try again".
        payload: payloadRepair === true ? { ...base.payload, staged: 'incomplete', detail: `payload repair failed: ${error?.message ?? error}`.slice(0, 240) } : base.payload,
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

/* ------------------------------------------------------------------ *
 * C5 — THE BUDGET LADDER, AND WHY IT IS A LADDER
 * ------------------------------------------------------------------ */

/**
 * THE GUEST'S WEDGE DEADLINE (C4), mirrored here as EVIDENCE ONLY.
 *
 * The relay kills a child that has not answered in 20 s and answers the pending
 * id with `child-wedged` (C4.4/C4.5). The host's per-call timer must be strictly
 * LARGER than this, or a `child-wedged` line can never reach the model: the
 * host would give up first and report a nameless timeout, which is the R3 defect
 * wearing a new number. This constant is not a second knob — the guest owns the
 * deadline (DSH_CUA_MCP_WEDGE_DEADLINE_MS); it is here so the margin below is
 * arithmetic a reader can check, and so a test can assert it.
 */
export const WIN_MCP_WEDGE_DEADLINE_MS = 20_000

/**
 * THE TRANSPORT BUDGET — one JSON-RPC REQUEST, 25 s (C5).
 *
 * `WEDGE_DEADLINE_MS + 5 000`: the guest's clock starts AFTER the host's (the
 * request has to be written, forwarded and answered), so the margin is
 * structural, not cosmetic. With 25 s the guest's `child-wedged` answer is the
 * FIRST thing the model can see; the host timer is the backstop for the case the
 * guest is too dead to send it.
 */
export const WIN_MCP_TRANSPORT_BUDGET_MS = 25_000

/**
 * THE ENVELOPE — how long the HARNESS waits around one request (26 s).
 *
 * It is the transport budget plus 1 s of harness-side overhead (registration,
 * the wrapper's own bookkeeping). `boundedExecute` is declared with this number
 * so its 250 ms `TIMEOUT_LEAD_MS` keeps the branchable error in front of the
 * harness guard (the §28 pattern).
 */
export const WIN_MCP_CALL_ENVELOPE_MS = 26_000

/**
 * THE RETRY BUDGET — TWO envelopes plus 4 s (56 s), for the three read-only
 * tools only (C7). The whole retry budget is inside the documented
 * `toolCallTimeoutMs: 120000` envelope (research Q1c).
 */
export const WIN_MCP_CALL_RETRY_BUDGET_MS = 56_000

/** The registration budget for a single-attempt tool: envelope + 4 s. */
export const WIN_MCP_CALL_GUARD_MS = 30_000

/** The env override, READ AT CALL TIME (C5) — never captured at module load. */
export const WIN_MCP_CALL_TIMEOUT_ENV = 'DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS'

/** The clamp C5 freezes: 200 ms .. 120 000 ms. */
export const WIN_MCP_CALL_TIMEOUT_MIN_MS = 200
export const WIN_MCP_CALL_TIMEOUT_MAX_MS = 120_000

/**
 * THE DOCUMENTED ENVELOPE (research Q1c): `toolCallTimeoutMs: 120000` is the
 * longest wall the harness was told about.
 *
 * INVARIANT (one line, and the derived ladder below is the proof): no derived
 * budget — envelope, retry budget or guard — may exceed this, so raising the
 * transport to its frozen ceiling can never ask for a wall outside the documented
 * envelope (at 120 000 the unclamped arithmetic would derive 121 000 / 246 000 /
 * 125 000 and the harness would cut a retry it never agreed to run).
 */
export const WIN_MCP_TOOL_CALL_ENVELOPE_MS = 120_000

/**
 * R3'S TRANSPORT HALF, AS A SENTENCE A TEST CAN POINT AT.
 *
 * A retry is a JSON-RPC REQUEST retry ON THE SAME SESSION. The per-call timer
 * rejects exactly one request (its id is dropped from `pending`) and NEVER closes
 * the SSH child, so the documented reconnect policy `{500 ms, 30 000 ms, 10
 * attempts}` is untouched and is not re-implemented here. The client test
 * asserts the structural half of this: after a per-call timeout the child is
 * still alive, was never killed, and the next request on the same session
 * succeeds. A "retry" that reconnected would change the id space and pay a
 * handshake — and would make `child-wedged`/`relay-unresponsive` meaningless.
 */
export const WIN_MCP_RETRY_SEMANTICS = 'a call retry is a JSON-RPC request retry on the SAME session: the per-call timer rejects one request and never closes the SSH child, so the reconnect policy is untouched and a transport reconnect is never a retry'

/**
 * THE TRANSPORT BUDGET, resolved the way C5 freezes it: the env override read at
 * CALL TIME, clamped to 200..120000, defaulting to WIN_MCP_TRANSPORT_BUDGET_MS.
 *
 * Reading it here (a function, not a const) is the whole point: a test — or a
 * session — can lower the budget to 200 ms and every call follows, without a
 * module reload and without touching the 60 s attach handshake.
 */
export function winMcpTransportBudgetMs(env = process.env) {
  // THE SAME ROUNDING AS index.js — `Math.floor`, not `Math.round`. Two readers
  // of ONE knob must agree on '25000.5' (index.js's winMcpCallTimeoutMs() floors
  // it to 25 000); a rounding split makes the transport time out 1 ms after the
  // envelope the plugin declared, which is a silent split budget, not a style
  // difference.
  const value = Math.floor(Number(String(env?.[WIN_MCP_CALL_TIMEOUT_ENV] ?? '').trim()))
  // NON-POSITIVE / NON-FINITE IS UNSET, not a zero budget — index.js's reader
  // makes the same choice for the same reason.
  if (Number.isFinite(value) !== true || value <= 0) return WIN_MCP_TRANSPORT_BUDGET_MS
  return Math.min(WIN_MCP_CALL_TIMEOUT_MAX_MS, Math.max(WIN_MCP_CALL_TIMEOUT_MIN_MS, value))
}

/**
 * THE LADDER, DERIVED — never three independent constants (C5).
 *
 * `envelope = transport + 1 000`, `retryBudget = 2 * envelope + 4 000`,
 * `guard = envelope + 4 000`, each CLAMPED to WIN_MCP_TOOL_CALL_ENVELOPE_MS.
 * A caller that scales the transport (a test, the env var) scales all three, so
 * the ordering `guest 20 000 < transport < envelope < retry budget` cannot be
 * broken by editing one number — and the clamps keep the whole retry budget
 * inside the documented 120 000 envelope even at the transport's ceiling (where
 * transport and envelope coincide and the retry budget degenerates to one
 * attempt, which is exactly what a 120 000 ms single request means).
 *
 * The `Math.floor` below is index.js's rounding, not a local taste: the plugin
 * and the transport must derive from the SAME integer ('25000.5' is 25 000 in
 * both readers).
 */
export function winMcpCallBudgets(transportMs = winMcpTransportBudgetMs()) {
  const raw = Number(transportMs)
  const transport = Number.isFinite(raw) === true && raw >= 1 ? Math.floor(raw) : WIN_MCP_TRANSPORT_BUDGET_MS
  // No derived budget may name a wall longer than the documented envelope.
  const capped = (value) => Math.min(WIN_MCP_TOOL_CALL_ENVELOPE_MS, value)
  const envelope = capped(transport + 1_000)
  return {
    wedgeDeadlineMs: WIN_MCP_WEDGE_DEADLINE_MS,
    transportMs: transport,
    envelopeMs: envelope,
    retryBudgetMs: capped((2 * envelope) + 4_000),
    guardMs: capped(envelope + 4_000)
  }
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
  log = () => {},
  /**
   * C1 rule 2 / WP-2A: THE BOOT ANCHOR, INJECTED. `(name) => number|null` epoch
   * ms — index.js passes `windowsBootReadyAt`, which reads the newest
   * `vm-state:<name>:ready` event for THIS computer. The client adapts it to the
   * zero-arg provider the transport takes, so a test drives the window with a
   * function and no stream exist. `null` (the default) means "no anchor":
   * `source:'attach'` becomes the fallback, and `live` is still honest.
   */
  bootWindow = null
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
     * C2/C3: the LAST functional-probe answer (or null before one ran), minus
     * nothing — the whole C3 shape, so `doctorFacts()` can report a measured child
     * without opening a second SSH session. It is written by
     * `relayFunctionalProbe()` on the client, never by a read path.
     */
    relayFunctional: null,
    /**
     * C1: the boot-race window as of the LAST read. Recomputed (never snapshotted
     * for good) by `computeBootRace()` on every attach, doctor call and upgrade
     * beat, so `remainingMs` ages honestly and `live` cannot outlive its window.
     */
    bootRace: null,
    /**
     * DEFECT 2: when the last upgrade attempt was made. 0 means "never", and the
     * throttle compares against RELAY_UPGRADE_INTERVAL_MS so a flapping relay
     * cannot turn a blind session into a reconnect loop.
     */
    lastUpgradeAttemptAt: 0
  }
  /** The lane decision of the last attach (null until connect() ran). */
  let decided = null
  /** The FIRST attach's epoch ms — the fallback anchor when no ready event exists. */
  let attachedAt = null

  /**
   * THE WINDOW, RECOMPUTED FROM LIVE INPUTS (C1 rules 3-4).
   *
   * The `readyAt` anchor is re-READ from the provider on every call: a newer
   * `vm-state:<name>:ready` event must win, and a stored snapshot would report a
   * `live` that the clock has already closed. A MEASURED repair record (one that
   * measured `session` or `hash`) outranks the window — evidence is never
   * relabelled "wait a bit".
   */
  const computeBootRace = (nowMs = Date.now()) => {
    const readyAt = typeof bootWindow === 'function' ? bootWindow(name) : null
    const record = state.repair
    const measured = record?.measured === true
      && (record?.sessionMeasured === true || record?.hashMeasured === true)
    const window = bootRaceFacts({
      readyAt,
      attachedAt,
      nowMs,
      measured,
      relayStatus: state.relayStatus ?? ''
    })
    state.bootRace = window
    return window
  }

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

  /**
   * C5/B-7: THE BUDGET OF ONE REQUEST, not of the client.
   *
   * `timeoutMs` (the `createDshCuaClient` option, 60 s by default) is the ATTACH
   * HANDSHAKE budget and stays exactly what it was: `connect()` calls `request()`
   * without a per-call value, so nothing about the handshake moves. A
   * `tools/call` supplies its own, which is the whole R3 split — one 45 s (now
   * 25 s) constant can no longer do the handshake's job and the tool's job at
   * once.
   *
   * Anything that is not a finite number >= 1 falls back to the client budget
   * rather than producing a `setTimeout(NaN)` (which fires immediately) or a
   * negative timer: a bad override must degrade to TODAY'S behaviour, never to
   * "every call times out at once".
   */
  const perCallBudget = (value) => {
    if (value === undefined || value === null) return timeoutMs
    const raw = Number(value)
    return Number.isFinite(raw) === true && raw >= 1 ? raw : timeoutMs
  }

  const request = (method, params = {}, perCallTimeoutMs = timeoutMs) => new Promise((resolve, reject) => {
    if (child === null) {
      reject(mcpError('not-connected', 'the Windows MCP bridge is not connected'))
      return
    }
    const id = nextId
    nextId += 1
    const budgetMs = perCallBudget(perCallTimeoutMs)
    const timer = setTimeout(() => {
      // ONE REQUEST GIVES UP — THE SESSION DOES NOT (R3 transport half, see
      // WIN_MCP_RETRY_SEMANTICS). Dropping the id is the entire teardown: the
      // child keeps running, so the caller's retry is a request retry on the
      // same session and not a reconnect.
      pending.delete(id)
      reject(mcpError('timeout', `the guest did not answer ${method} within ${budgetMs} ms`))
    }, budgetMs)
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
    // C1 RULE 7: THE TIMER IS NOT TOUCHED; THE THROTTLE IS. Inside a live boot
    // window the pure guard gets the 10 s interval, so the first failed upgrade
    // at ready+20 s does not lock the next one out until ready+80 s. At every
    // other moment `intervalMs` is `undefined` and the guard falls back to its
    // own 60 s default — the 15 s `setInterval` and its teardown are unchanged.
    const bootRace = computeBootRace(now)
    const decision = shouldUpgradeToRelay({
      transport: state.transport,
      relayOk: state.relayOk,
      lastUpgradeAttemptAt: state.lastUpgradeAttemptAt,
      now,
      inFlight: pending.size,
      intervalMs: state.bootRace?.live === true ? BOOT_RACE_UPGRADE_INTERVAL_MS : undefined
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
      const facts = normalizeDesktopFacts(null, { error: `desktop facts: ${error?.message ?? error}`, errorCode: 'read-error' })
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
      // C1: THE FIRST ATTACH IS THE FALLBACK ANCHOR. Recorded once (a retried
      // connect keeps the first one — the window belongs to the boot, not to the
      // attempt), and handed to the transport so the ladder can run even when the
      // plugin has no stream event for this computer.
      if (attachedAt === null) attachedAt = Date.now()
      const facts = await resolveGuestMcpTransport({
        host,
        port: sshPort,
        user,
        keyPath,
        log,
        spawnImpl,
        bootWindow: () => (typeof bootWindow === 'function' ? bootWindow(name) : null),
        attachedAt,
        measured: state.repair?.measured === true
          && (state.repair?.sessionMeasured === true || state.repair?.hashMeasured === true),
        now: () => Date.now()
      })
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
      // C1 rule 3: the same window the ladder was gated on, published for the
      // doctor. `computeBootRace()` re-derives it from the same inputs.
      state.bootRace = facts.bootRace ?? computeBootRace()
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
      // C1 rule 5: RECOMPUTED, NEVER STORED — the window ages between calls, and
      // a cached one would keep claiming `live` after it closed.
      const bootRace = computeBootRace()
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
        /**
         * B-5: THE CHILD, AS LAST MEASURED (C3).
         *
         * `relayOk`/`relayStatus` are the CHEAP probe's answer — the accept loop
         * (C1). They cannot tell a healthy child from a wedged one, which is why
         * the 7-minute outage was reported as healthy. This field is the other
         * half: the last `RELAY_FN` + `initialize`/`tools/list` round trip, with
         * the C3 counters (`lastSuccessfulCallAgeMs`, `outstandingRequestAgeMs`,
         * `childRestarts`, `lastWedgeAt`, `childPid`, `wedgeDeadlineMs`) around
         * it. `null` means NOTHING has been measured in this process — never
         * "the child is fine", and never `measured:false` borrowed from a probe
         * that did not run.
         *
         * It is here rather than in `payload` because it is not payload identity:
         * `payload` answers "is the guest running the relay we expect", this
         * answers "did its child answer".
         */
        relayFunctional: state.relayFunctional ?? null,
        /**
         * C1: THE WINDOW, WITH `remainingMs`. `null` never appears here — this is
         * a real object with `live:false` and `source:'none'` when there is no
         * anchor, which is the honest "no window" the doctor renders as
         * `relay-stopped` (it must not guess one).
         */
        bootRace,
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
          // C3: the CLIENT passes the functional reason, because it is the only
          // half that has one — `probe-unsupported` (TCP accepted, token sent,
          // zero bytes back) is a payload-staleness signal, not a dead child.
          skew: relayEvidenceSkew(relayStatus, record, state.relayFunctional?.reason ?? ''),
          // WP-1B / C6: the guard identity and the staleness verdict, the same
          // four fields relayDoctorFacts() carries (both producers, one shape).
          expectedGuardHash: expectedGuardHash(),
          guardHash: record?.payload?.guardHash ?? null,
          // P1: the SAME two fields, from the SAME owner — the client and the
          // module helper cannot disagree about the payload's presence.
          ...payloadPresence(record),
          stale: payloadStale({
            expectedRelayHash: expectedRelayHash(),
            relayHash: record?.measured === true ? (record?.hash ?? null) : null,
            expectedGuardHash: expectedGuardHash(),
            guardHash: record?.payload?.guardHash ?? null
          })
        }
      }
    },
    async callTool(toolName, args = {}, options = {}) {
      await assertOnline()
      // C5/B-7: THE TRANSPORT BUDGET IS PER CALL, AND IT IS EXPLICIT.
      //
      // A caller that names one (index.js does — `{timeoutMs: 25_000}`) gets
      // EXACTLY that budget in this request's timer. A caller that does not still
      // gets the frozen transport budget rather than the client's 60 s attach
      // handshake: a tool call and a handshake are different jobs with different
      // budgets, and conflating them was R3.
      const budgetMs = options?.timeoutMs ?? winMcpTransportBudgetMs()
      try {
        return await request('tools/call', { name: windowsGuestToolName(toolName), arguments: args }, budgetMs)
      } catch (error) {
        // B-8: A `child-wedged` ANSWER IS A ROUTABLE CODE. The guest's sentence
        // (C4.5 — "the call did not return, so its effect is UNKNOWN") is kept
        // VERBATIM; only the `code` is added here, so index.js can branch on it
        // and the model still reads the guest's own words.
        if (error?.code === 'timeout') throw error
        const message = String(error?.message ?? '')
        if (message.startsWith('child-wedged:')) throw mcpError('child-wedged', message)
        throw error
      }
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
     * THE FUNCTIONAL PROBE, FROM THE CLIENT (C2/C3/B-5).
     *
     * `windows_mcp_doctor` runs this before building its verdict (§5.2 C-6) and
     * `relayFunctionalProbe` is the ONE implementation: this method is a thin
     * delegation to the module-level function — the plugin must never re-implement
     * the probe. Never throws (the module function never does), and the answer is
     * remembered on the client so `doctorFacts()` — which is synchronous and
     * side-effect free — can carry it.
     *
     * It does NOT touch `state.relayOk`: a `RELAY_UNRESPONSIVE` answer must not be
     * turned into anything else, and a `RELAY_OK` here is the ACCEPT LOOP's fact
     * (C1), not a lane decision. `shouldUpgradeToRelay()` keeps deciding lanes
     * from the cheap probe exactly as before.
     */
    async relayFunctionalProbe(options = {}) {
      const answer = await relayFunctionalProbe({ host, port: sshPort, user, keyPath, spawnImpl, log, ...(options ?? {}) })
      // B-5: the C3 object WITHOUT `stdin` (the module function never sets one —
      // it never writes to the child) is what the doctor reports.
      state.relayFunctional = answer
      return answer
    },
    /** The last functional answer, for a synchronous reader. `null` until one ran. */
    relayFunctionalFacts() {
      return state.relayFunctional
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
