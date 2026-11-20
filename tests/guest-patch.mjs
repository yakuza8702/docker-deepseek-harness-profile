#!/usr/bin/env node
/**
 * guest-patch.mjs — WP-D (R5, R7, R9): the guest payload's in-place patches and
 * its desktop-token proof, asserted WITHOUT a Windows guest.
 *
 * HOW THIS PROVES ANYTHING (the §28 technique, with the stubs written down):
 *
 *   * The three `Step` blocks exist with their pinned version, their pinned
 *     SHA-256 and a `count == 1` gate on every anchor, in the order the boot log
 *     has to show (`scale < typetext < savepath < probe < clipboard`).
 *   * The here-strings the ps1 uses are EXTRACTED BY NAME and applied to the
 *     evidence copies (`tooldefects-evidence/{bridge.py,server.py}`, the pinned
 *     0.4.1 wheel files). Every anchor must occur exactly once, so the patch is
 *     proven against the bytes it will actually meet — not against a paraphrase.
 *   * `type_text` and `_ensure_save_dir` are AST-EXTRACTED from the patched
 *     source and RUN against stubs. A control that accepts only 10 of 11
 *     characters must answer `ok:false` + `reason:'short-insert'` + `missing:'d'`
 *     + `restoreOk:true`; a control whose limit grows must answer
 *     `recovered:true` after exactly two retries that carried only the tail; and
 *     the UNPATCHED copy still answers `effect_verified:true` for the same
 *     truncated insert — that last one IS the R5 defect, and it is the reason
 *     this file exists.
 *   * The save_path allow-list is exercised cross-platform on a temp directory:
 *     an allowed missing path is created and reported, anything else fails closed
 *     with a sentence naming both roots, and an existing allowed directory
 *     triggers no `makedirs` at all.
 *   * The desktop-token step's contract is read from the ps1: an on-demand
 *     `/it /rl LIMITED` task bound to the provisioned account, a ≤30 s wait for a
 *     marker carrying `scriptSha256`/`session`/the three booleans, and a `throw`
 *     when the marker is missing or stale.
 *
 * WHAT IT DOES NOT PROVE: that the guest's own wheel answers the same way (that
 * needs a built image), or that the desktop token passes the probe (that needs a
 * logged-on session — the point of the step is that the BUILD fails when it does
 * not).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved from THIS file, so the suite runs from a checkout anywhere (CI, a
// worktree, a reviewer's clone).
const REPO = process.env.REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PS1 = path.join(REPO, 'docker', 'windows-oem', 'cua-firstboot.ps1')
const EVIDENCE = process.env.GUEST_EVIDENCE || path.resolve(REPO, '..', 'tooldefects-evidence')

// The pins this file was written against: the two evidence copies, asserted as
// VALUES, so "the steps agree with the files" cannot pass by agreeing on a typo.
const PINNED_BRIDGE = '59280ee9079cc09aa94b3813fd7a7665cfebffe68fb7259b752e161abf1f9209'
const PINNED_SERVER = '29668590f5ed3b25e82bd8176bbf9268dd9b6108991943cb8db6ae5c7a2d8713'

let failures = 0
// The total is COUNTED, never asserted from memory: a check that was added or
// removed must move the printed number, or the "N check(s)" line becomes a claim
// nobody maintains.
let checks = 0
const check = (label, ok, detail = '') => {
  checks += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const ps1 = existsSync(PS1) ? readFileSync(PS1, 'utf8') : ''
if (!ps1) {
  console.log(` FAIL  the guest payload is missing: ${PS1}`)
  process.exit(1)
}

/** The `Step 'name' { … }` block, sliced at the next step. */
const stepText = (name) => {
  const start = ps1.indexOf(`Step '${name}' {`)
  if (start < 0) return ''
  const next = ps1.indexOf("\nStep '", start + 1)
  return ps1.slice(start, next < 0 ? ps1.length : next)
}

/** A here-string assigned to `$name`, LF-normalised like the step itself does. */
const hereString = (name) => {
  const match = new RegExp(`\\$${name} = @'\\n([\\s\\S]*?)\\n'@`, 'u').exec(ps1)
  return match ? match[1].replace(/\r\n/gu, '\n') : null
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const occurrences = (haystack, needle) => (needle ? haystack.split(needle).length - 1 : -1)

// The type_text / save_path anchors, plus the EXISTING scale step's (JD1 needs to
// compose the two bridge.py patches, and composing them from the ps1's own
// here-strings is the only version that cannot drift from what the guest runs).
const NAMES = [
  'anchorTTHelper', 'replacementTTHelper', 'anchorTT', 'replacementTT',
  'anchorTTReceipt', 'replacementTTReceipt',
  'anchorSP', 'replacementSP', 'anchorSP2', 'replacementSP2', 'anchorSP3', 'replacementSP3',
  'anchorA', 'replacementA', 'anchorB', 'replacementB'
]
const anchors = Object.fromEntries(NAMES.map((name) => [name, hereString(name)]))
const missingAnchors = NAMES.filter((name) => !anchors[name])
const bridgeFile = path.join(EVIDENCE, 'bridge.py')
const serverFile = path.join(EVIDENCE, 'server.py')
const evidenceMissing = existsSync(bridgeFile) && existsSync(serverFile) ? '' : `the pinned 0.4.1 evidence copies are not under ${EVIDENCE} (set GUEST_EVIDENCE)`
const bridgeText = existsSync(bridgeFile) ? readFileSync(bridgeFile, 'utf8') : ''
const serverText = existsSync(serverFile) ? readFileSync(serverFile, 'utf8') : ''
const scaleStep = stepText('dsh-cua-scale')
const ttStep = stepText('dsh-cua-typetext')
const spStep = stepText('dsh-cua-savepath')
const probeStep = stepText('desktop-token-probe')

// ---------------------------------------------------------------- D-1..D-7
check('D-1: both patch steps exist, each pins 0.4.1, its own SHA-256, and a count == 1 gate',
  [ttStep, spStep].every((block) => block.includes("$expectedVersion = '0.4.1'")
    && /\$expectedHash = '[0-9a-f]{64}'/u.test(block)
    && /\[regex\]::Matches\(/u.test(block) && /-ne 1/u.test(block))
  && ttStep.includes(`$expectedHash = '${PINNED_BRIDGE}'`)
  && spStep.includes(`$expectedHash = '${PINNED_SERVER}'`),
  `typetext=${ttStep.length}B savepath=${spStep.length}B`)

check('D-2: every named here-string is extractable and non-empty (and the file is balanced)',
  missingAnchors.length === 0 && NAMES.every((name) => anchors[name].length > 0)
  && (ps1.match(/@'\n/gu) ?? []).length === (ps1.match(/\n'@/gu) ?? []).length,
  missingAnchors.length === 0
    ? `${NAMES.length} here-strings, openers=${(ps1.match(/@'\n/gu) ?? []).length}`
    : `missing ${missingAnchors.join(',')}`)

check('D-3: all three type_text anchors occur exactly once in bridge.py',
  occurrences(bridgeText, anchors.anchorTT) === 1
  && occurrences(bridgeText, anchors.anchorTTHelper) === 1
  && occurrences(bridgeText, anchors.anchorTTReceipt) === 1,
  `effect=${occurrences(bridgeText, anchors.anchorTT)} helper=${occurrences(bridgeText, anchors.anchorTTHelper)} receipt=${occurrences(bridgeText, anchors.anchorTTReceipt)}`)

check('D-4: the save_path anchors occur exactly once (open block, tool descriptor, payload line)',
  occurrences(serverText, anchors.anchorSP) === 1
  && occurrences(serverText, anchors.anchorSP2) === 1
  && occurrences(serverText, anchors.anchorSP3) === 1,
  `open=${occurrences(serverText, anchors.anchorSP)} tool=${occurrences(serverText, anchors.anchorSP2)} payload=${occurrences(serverText, anchors.anchorSP3)}`)

// ------------------------------------------------- the behaviour harness
// One python process: it applies the anchors, AST-extracts the patched
// functions and runs them against the stubs below. A harness failure is
// REPORTED (report.error) and fails every check that depends on it — never
// swallowed into a green run.
const PROGRAM = String.raw`"""Apply the guest-patch here-strings to the evidence copies and prove the
receipts by RUNNING them (AST extraction, stubbed globals) - the section 28
technique, with the stubs written down instead of assumed.

The stub control models the reported defect honestly: it accepts characters up
to a MAXIMUM LENGTH, so "hello world" lands as "hello worl" and the tail stays
lost until the limit grows. A stub that simply dropped every post would model a
different failure (nothing ever lands) and could not tell the two receipts apart.
"""
import ast
import ctypes
import hashlib
import json
import os
import sys
import types

payload = json.load(sys.stdin)
BRIDGE = payload["bridge"]
SERVER = payload["server"]
A = payload["anchors"]
TEXT = payload["text"]
DEST = payload["dest"]

report = {"ok": False, "error": ""}


def apply_pairs(text, pairs):
    out = text
    counts = {}
    for name in sorted(pairs):
        anchor, replacement = pairs[name]
        counts[name] = out.count(anchor)
        if counts[name] != 1:
            raise AssertionError("anchor %s occurs %d time(s), not 1" % (name, counts[name]))
        out = out.replace(anchor, replacement)
    return out, counts


def extract(source, functions, assignments=()):
    tree = ast.parse(source)
    body = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in functions:
            body.append(node)
        elif isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            if any(n in assignments for n in names):
                body.append(node)
    found = {n.name for n in body if isinstance(n, ast.FunctionDef)}
    missing = set(functions) - found
    if missing:
        raise AssertionError("source is missing %s" % sorted(missing))
    return compile(ast.Module(body=body, type_ignores=[]), "<guest-patch>", "exec")


class Control(object):
    def __init__(self, text=""):
        self.text = text
        self.reads = 0
        self.limit = None
        self.grow_from_read = None


class User32(object):
    def __init__(self, control):
        self.control = control
        self.posts = []

    def PostMessageW(self, hwnd, message, wparam, lparam):
        self.posts.append(chr(int(wparam)))
        self.control.text += chr(int(wparam))
        if self.control.limit is not None:
            self.control.text = self.control.text[:self.control.limit]
        return 1

    def SendMessageTimeoutW(self, hwnd, message, wparam, lparam, flags, timeout, result):
        if int(message) != 0x000C:            # only WM_SETTEXT is modelled
            return 0
        self.control.text = ctypes.wstring_at(lparam)
        return 1


def run_type_text(source, limit=None, grow=0, text=TEXT, before="", patched=True):
    control = Control(before)
    control.limit = limit
    user32 = User32(control)

    def read_control(hwnd):
        control.reads += 1
        if control.limit is not None and grow and control.reads >= 3:
            control.limit += grow
        return control.text

    namespace = {
        "ctypes": ctypes,
        "w": types.SimpleNamespace(HWND=lambda handle: handle),
        "user32": user32,
        "WM_CHAR": 0x0102,
        "WM_SETTEXT": 0x000C,
        "SMTO_ABORTIFHUNG": 0x0002,
        "_SEND_TIMEOUT_MS": 1500,
        "byref": ctypes.byref,
        "time": types.SimpleNamespace(sleep=lambda seconds: None),
        "foreground_root": lambda: 11,
        "arbiter": types.SimpleNamespace(
            admit_mutating=lambda hard=False: {"ok": True, "release": lambda: None},
            receipt=lambda gate: {"ok": True}),
        "_ensure_visible": lambda hwnd: {"raised": False},
        "find_text_target": lambda hwnd: (DEST, "thread-focus"),
        "_read_control_text": read_control,
    }
    if patched:
        exec(extract(source, ["type_text", "_type_text_delta", "_type_text_restore"],
                     ["TYPE_TEXT_RETRY", "WM_SETTEXT"]), namespace)
    else:
        exec(extract(source, ["type_text"]), namespace)
    receipt = namespace["type_text"](DEST, text)
    return receipt, control, user32


class OsShim(object):
    def __init__(self, env):
        self.path = os.path
        self.environ = env
        self.makedirs_calls = 0

    def makedirs(self, name, exist_ok=False):
        self.makedirs_calls += 1
        return os.makedirs(name, exist_ok=exist_ok)


def run_save_path(source, env):
    shim = OsShim(env)
    namespace = {"os": shim}
    exec(extract(source, ["_ensure_save_dir", "_is_allowed_save_dir",
                          "_same_dir", "_save_path_dir", "_temp_shots_root"]), namespace)
    return namespace["_ensure_save_dir"], namespace["_is_allowed_save_dir"], shim


def pick(receipt, keys):
    return {k: receipt.get(k) for k in keys}


def main():
    bridge_pairs = {
        "helper": (A["anchorTTHelper"], A["replacementTTHelper"]),
        "effect": (A["anchorTT"], A["replacementTT"]),
        "receipt": (A["anchorTTReceipt"], A["replacementTTReceipt"]),
    }
    server_pairs = {
        "open": (A["anchorSP"], A["replacementSP"]),
        "helper": (A["anchorSP2"], A["replacementSP2"]),
        "payload": (A["anchorSP3"], A["replacementSP3"]),
    }
    patched_bridge, bridge_counts = apply_pairs(BRIDGE, bridge_pairs)
    patched_server, server_counts = apply_pairs(SERVER, server_pairs)
    report["bridge_counts"] = bridge_counts
    report["server_counts"] = server_counts
    report["bridge_changed"] = patched_bridge != BRIDGE
    report["server_changed"] = patched_server != SERVER
    report["sentinel_count"] = patched_bridge.count("if expected is not None:")
    report["anchor_left"] = patched_bridge.count(A["anchorTT"])
    ast.parse(patched_bridge)
    ast.parse(patched_server)
    report["bridge_parses"] = True

    # ---- D-8: the control keeps 10 of 11 characters and never grows.
    short, short_control, short_user32 = run_type_text(patched_bridge, limit=10, grow=0)
    report["short"] = pick(short, ("ok", "effect_verified", "reason", "missing",
                                   "retries", "recovered", "restoreOk", "after", "error"))
    report["short_after_restore"] = short_control.text
    report["short_posts"] = "".join(short_user32.posts)

    # ---- D-9: two lost tails, then the limit grows and the third attempt lands.
    recovered, recovered_control, recovered_user32 = run_type_text(patched_bridge, limit=10, grow=1)
    report["recovered"] = pick(recovered, ("ok", "effect_verified", "reason", "missing",
                                           "retries", "recovered", "restoreOk"))

    # ---- D-10: an exact insert, no retry at all.
    exact, exact_control, exact_user32 = run_type_text(patched_bridge, limit=None)
    report["exact"] = pick(exact, ("ok", "effect_verified", "reason", "missing",
                                   "retries", "recovered", "restoreOk"))

    # ---- D-12: the UNPATCHED copy against the same truncating control: the R5 lie.
    baseline, baseline_control, _ = run_type_text(BRIDGE, limit=10, grow=0, patched=False)
    report["baseline"] = pick(baseline, ("ok", "effect_verified", "reason"))
    report["baseline_text"] = baseline_control.text

    # ---- D-21/D-22: the COMPOSED file - scale + typetext on the same bridge.py.
    #
    # JD1: the two patches share one file, so the hash gate must accept the other
    # patch's output. This builds both orders from the ps1's own here-strings and
    # requires them to be the SAME BYTES - the property that lets each step accept
    # the other's result without a combinatorial set of pins.
    def apply_list(text, pairs):
        for anchor, replacement in pairs:
            if text.count(anchor) != 1:
                raise AssertionError("composed anchor occurs %d time(s)" % text.count(anchor))
            text = text.replace(anchor, replacement)
        return text

    scale_pairs = [(A["anchorA"], A["replacementA"]), (A["anchorB"], A["replacementB"])]
    tt_pairs = [bridge_pairs["helper"], bridge_pairs["effect"], bridge_pairs["receipt"]]
    scale_only = apply_list(BRIDGE, scale_pairs)
    tt_only = apply_list(BRIDGE, tt_pairs)
    both = apply_list(scale_only, tt_pairs)
    reverse = apply_list(tt_only, scale_pairs)
    composed_receipt, _composed_control, _composed_user32 = run_type_text(both, limit=10, grow=0)
    report["composed"] = {
        "order_independent": both == reverse,
        "hash_scaled": hashlib.sha256(scale_only.encode("utf-8")).hexdigest(),
        "hash_typetext": hashlib.sha256(tt_only.encode("utf-8")).hexdigest(),
        "hash_both": hashlib.sha256(both.encode("utf-8")).hexdigest(),
        "scale_sentinel": "base_w, base_h = img.size" in both,
        "tt_sentinel": "if expected is not None:" in both,
        # NOT "anchors left": two of the three type_text edits are INSERTIONS, so
        # the helper's def line and the receipt's first four lines are deliberately
        # still there (that is what makes them insertions). What must be gone is the
        # effect anchor the state machine replaces, and the two scale anchors.
        "scale_anchors_left": sum(both.count(anchor) for anchor, _ in scale_pairs),
        "effect_anchor_left": both.count(bridge_pairs["effect"][0]),
        "helper_anchor_count": both.count(bridge_pairs["helper"][0]),
        "receipt_extended": both.count('"retries": retries, "recovered": bool(recovered),'),
        "receipt": pick(composed_receipt, ("ok", "effect_verified", "reason", "missing", "retries")),
    }

    # ---- D-14..D-17: the save_path allow-list.
    import tempfile
    sandbox = tempfile.mkdtemp(prefix="cua-guest-save-")
    ensure, allowed, shim = run_save_path(patched_server, {"TEMP": sandbox})
    report["allowed_cua_work"] = allowed(os.path.join("C:\\cua-work", "a", "b.jpg"))
    report["allowed_prefix_trap"] = allowed("C:\\cua-workevil\\x")
    report["allowed_other"] = allowed(os.path.join(sandbox, "not-allowed"))
    report["allowed_empty"] = allowed("")

    target = os.path.join(sandbox, "win32_mcp_shots", "x", "y.jpg")
    made, where, err = ensure(target)
    report["create"] = {"made": made, "dir": where, "err": err,
                        "exists": os.path.isdir(os.path.dirname(target)),
                        "makedirs": shim.makedirs_calls}

    shim.makedirs_calls = 0
    blocked_dir = os.path.join(sandbox, "not-allowed")
    blocked, where2, why = ensure(os.path.join(blocked_dir, "x.jpg"))
    report["refuse"] = {"made": blocked, "err": why,
                        "exists": os.path.isdir(blocked_dir),
                        "makedirs": shim.makedirs_calls}

    shim.makedirs_calls = 0
    present = os.path.join(sandbox, "win32_mcp_shots")
    made2, where3, err2 = ensure(os.path.join(present, "z.jpg"))
    report["present"] = {"made": made2, "err": err2, "makedirs": shim.makedirs_calls}

    # The sandbox was only there to give the allow-list real directories to
    # create and refuse; the assertions above already hold its answers.
    import shutil
    shutil.rmtree(sandbox, ignore_errors=True)

    report["ok"] = True


try:
    main()
except Exception as exc:
    report["error"] = "%s: %s" % (type(exc).__name__, exc)
print("CUA_GUEST_PATCH_JSON " + json.dumps(report))`

// The PROGRAM rides in argv (`-c`) and the payload on stdin: `python3 -` would
// read the PROGRAM from stdin, which is the one thing this harness must not do.
const probe = evidenceMissing
  ? { stdout: '', stderr: evidenceMissing, error: null }
  : spawnSync(process.env.PYTHON || 'python3', ['-c', PROGRAM], {
  input: JSON.stringify({ bridge: bridgeText, server: serverText, anchors, text: 'hello world', dest: 4242 }),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
const report = (() => {
  const line = String(probe.stdout ?? '').split('\n').find((entry) => entry.startsWith('CUA_GUEST_PATCH_JSON '))
  if (!line) {
    const why = probe.error ? (probe.error.message ?? String(probe.error)) : (probe.stderr || probe.stdout || 'no output')
    return { ok: false, error: String(why).trim().slice(-500) }
  }
  try {
    return JSON.parse(line.slice('CUA_GUEST_PATCH_JSON '.length))
  } catch (error) {
    return { ok: false, error: `unparsable report: ${error.message}` }
  }
})()
const harness = report.ok ? '' : `harness: ${report.error}`

check('D-5: applying the replacements changes both evidence files',
  report.ok === true && report.bridge_changed === true && report.server_changed === true,
  report.ok ? '' : harness)

check('D-6: the idempotence key occurs exactly once in the PATCHED bridge.py (and the old anchor is gone)',
  report.ok === true && report.sentinel_count === 1 && report.anchor_left === 0,
  report.ok ? `sentinel=${report.sentinel_count} old-anchor=${report.anchor_left}` : harness)

const already = ttStep.indexOf('if ($text.Contains($sentinel))')
// JD1 moved the gate from "must equal the pristine pin" to "must equal one of the
// two accepted bases", so the check follows the GATE, not a spelling of it.
const hashGate = ttStep.indexOf('if ($measureHash -eq $expectedHash)')
check('D-7: the already-patched branch is a string in the ps1 and PRECEDES the hash gate',
  ttStep.includes("$sentinel = 'if expected is not None:'") && already >= 0 && hashGate > already,
  `already@${already} hashGate@${hashGate}`)

// ------------------------------------------------------- D-8..D-12 (type_text)
const short = report.ok ? report.short : {}
check('D-8: a truncated insert is a FAILED receipt (ok:false, short-insert, missing:"d")',
  report.ok === true && short.ok === false && short.effect_verified === false
  && short.reason === 'short-insert' && short.missing === 'd' && short.retries === 2
  && short.after === 'hello worl',
  report.ok ? `${short.reason} missing=${JSON.stringify(short.missing)} retries=${short.retries} after=${JSON.stringify(short.after)}` : harness)

const recovered = report.ok ? report.recovered : {}
check('D-9: two retries carry ONLY the missing tail, and the attempt that lands is recovered:true',
  report.ok === true && report.short_posts === 'hello worlddd'
  && recovered.effect_verified === true && recovered.recovered === true
  && recovered.retries === 2 && recovered.missing === '' && recovered.reason === 'typed',
  report.ok ? `posts=${JSON.stringify(report.short_posts)} retries=${recovered.retries} recovered=${recovered.recovered}` : harness)

const exact = report.ok ? report.exact : {}
check('D-10: an exact insert is the only "verified", with no retry ink',
  report.ok === true && exact.ok === true && exact.effect_verified === true
  && exact.retries === 0 && exact.recovered === false && exact.missing === ''
  && exact.restoreOk === null,
  report.ok ? `retries=${exact.retries} recovered=${exact.recovered} missing=${JSON.stringify(exact.missing)}` : harness)

check('D-11: a tail that never lands RESTORES the control and reports the measured restoreOk',
  report.ok === true && short.restoreOk === true && report.short_after_restore === '',
  report.ok ? `restoreOk=${short.restoreOk} final=${JSON.stringify(report.short_after_restore)}` : harness)

check('D-12: the UNPATCHED copy still calls the same truncated insert verified (the R5 baseline)',
  report.ok === true && report.baseline.effect_verified === true && report.baseline.ok === true
  && report.baseline_text === 'hello worl',
  report.ok ? `effect_verified=${report.baseline.effect_verified} text=${JSON.stringify(report.baseline_text)}` : harness)

// ------------------------------------------------------------------- D-13
const bridgeHash = bridgeText ? sha256(bridgeFile) : ''
const serverHash = serverText ? sha256(serverFile) : ''
check('D-13: the evidence copies still hash to the pinned values (and the steps carry the same pins)',
  bridgeHash === PINNED_BRIDGE && serverHash === PINNED_SERVER,
  `${bridgeHash.slice(0, 8)}…/${serverHash.slice(0, 8)}…`)

// ------------------------------------------------------ D-14..D-17 (save_path)
const created = report.ok ? report.create : {}
const refused = report.ok ? report.refuse : {}
const present = report.ok ? report.present : {}
check('D-14: an allowed directory (a C:\\cua-work descendant) is accepted, cross-platform',
  report.ok === true && report.allowed_cua_work === true
  && report.allowed_prefix_trap === false && report.allowed_other === false,
  report.ok ? `cua-work=${report.allowed_cua_work} prefix-trap=${report.allowed_prefix_trap} other=${report.allowed_other}` : harness)

check('D-15: an allowed MISSING path under %TEMP%\\win32_mcp_shots is created (created_dir:true)',
  report.ok === true && created.made === true && created.exists === true && created.err === ''
  && created.makedirs === 1 && /win32_mcp_shots/u.test(created.dir ?? ''),
  report.ok ? `made=${created.made} makedirs=${created.makedirs} dir=${created.dir}` : harness)

check('D-16: anything outside the two roots is REFUSED, not created, and the sentence names both',
  report.ok === true && refused.made === false && refused.exists === false && refused.makedirs === 0
  && String(refused.err).includes('C:\\cua-work')
  && String(refused.err).includes('%TEMP%\\win32_mcp_shots'),
  report.ok ? `made=${refused.made} makedirs=${refused.makedirs}` : harness)

check('D-17: an allowed directory that already EXISTS is not created again (no makedirs call)',
  report.ok === true && present.made === false && present.err === '' && present.makedirs === 0,
  report.ok ? `made=${present.made} makedirs=${present.makedirs}` : harness)

// -------------------------------------------------- D-18..D-20 (the proof step)
check('D-18: the probe registers cua-desktop-probe /it /rl LIMITED, waits <=30 s, and THROWS on missing/stale',
  probeStep.length > 0
  && /schtasks \/create \/tn `"cua-desktop-probe`" \/sc ondemand \/ru `"\$relayAccount`" \/it \/rl LIMITED/u.test(probeStep)
  && /\[guid\]::NewGuid\(\)/u.test(probeStep)
  && /AddSeconds\(30\)/u.test(probeStep)
  && /Test-Path -LiteralPath \$probeMarker/u.test(probeStep)
  && /'stale-marker'/u.test(probeStep) && /'stale-boot'/u.test(probeStep)
  && /throw "desktop-token-probe: the DESKTOP token did not prove the lane/u.test(probeStep),
  `${probeStep.length}B, throws=${/throw "desktop-token-probe: the DESKTOP token did not prove the lane/u.test(probeStep)}`)

check('D-19: the marker template carries scriptSha256, session and the three booleans',
  ['scriptSha256', 'session', 'win32ui', 'uiaLane', 'workDirWritable', 'probeToken'].every((field) => probeStep.includes(field))
  && /Get-FileHash -LiteralPath \$PSCommandPath/u.test(probeStep)
  && /Set-Content -LiteralPath 'C:\\cua-work\\\.desktop-probe'/u.test(probeStep),
  `fields=${['scriptSha256', 'session', 'win32ui', 'uiaLane', 'workDirWritable'].filter((field) => probeStep.includes(field)).length}/5`)

const order = ["Step 'dsh-cua-scale'", "Step 'dsh-cua-typetext'", "Step 'dsh-cua-savepath'",
  "Step 'desktop-token-probe'", "Step 'clipboard-tasks'"].map((needle) => ps1.indexOf(needle))
check('D-20: the step order is scale < typetext < savepath < desktop-token-probe < clipboard-tasks',
  order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1])),
  order.join(' < '))

// ------------------------------------------------- JD-1..JD-3 (jury round 2)
const composed = report.ok ? report.composed : {}
check('D-21: scale + typetext COMPOSE on the same bridge.py - either order, the same bytes, both live (JD1)',
  report.ok === true && composed.order_independent === true
  && composed.scale_sentinel === true && composed.tt_sentinel === true
  && composed.scale_anchors_left === 0 && composed.effect_anchor_left === 0
  && composed.helper_anchor_count === 1 && composed.receipt_extended === 1
  && composed.receipt?.reason === 'short-insert' && composed.receipt?.missing === 'd',
  report.ok
    ? `both=${String(composed.hash_both).slice(0, 8)}… order-free=${composed.order_independent} sentinels=${composed.scale_sentinel}/${composed.tt_sentinel} replaced=${composed.scale_anchors_left}/${composed.effect_anchor_left}`
    : harness)

const pinScaled = /\$expectedHashScaled = '([0-9a-f]{64})'/u.exec(ttStep)?.[1]
const pinTypeText = /\$expectedHashTypeText = '([0-9a-f]{64})'/u.exec(scaleStep)?.[1]
check('D-22: each bridge.py step gates on "pristine OR the other patch applied", and the pins are the REAL hashes (JD1)',
  report.ok === true
  && pinScaled === composed.hash_scaled && pinTypeText === composed.hash_typetext
  && /if \(\$measureHash -eq \$expectedHash\) \{ \$typeTextBase = 'pristine' \}/u.test(ttStep)
  && /elseif \(\$measureHash -eq \$expectedHashScaled\) \{ \$typeTextBase = 'scale-patched' \}/u.test(ttStep)
  && /elseif \(\$measureHash -eq \$expectedHashTypeText\) \{ \$scaleBase = 'typetext-patched' \}/u.test(scaleStep)
  && ttStep.includes("typeTextBase = $typeTextBase") && scaleStep.includes("scaleBase = $scaleBase")
  && /\$typeTextBase -eq 'scale-patched'[^\n]*base_w, base_h = img\.size/u.test(ttStep)
  && /\$scaleBase -eq 'typetext-patched'[^\n]*if expected is not None:/u.test(scaleStep),
  `scaledPin=${String(pinScaled).slice(0, 8)}… ttPin=${String(pinTypeText).slice(0, 8)}…`)

const restoreSig = "function Restore-BridgeSource([string]$BridgePath, [byte[]]$OriginalBytes, [string]$ExpectedHash = '', [string]$Filter = 'bridge.*.pyc')"
const spRestores = (spStep.match(/\$spRestoreOk = Restore-BridgeSource [^\n]*-Filter 'server\.\*\.pyc'/gu) ?? []).length
check('D-23: a savepath rollback clears AND verifies server.*.pyc (the filter is the file it restored) (JD2)',
  ps1.includes(restoreSig)
  && ps1.includes('Clear-BridgePyc -BridgePath $BridgePath -Filter $Filter')
  && ps1.includes('Get-ChildItem -LiteralPath $cacheDir -Filter $Filter -File')
  && spRestores === 3
  && (spStep.match(/-Filter 'server\.\*\.pyc'/gu) ?? []).length >= 4,
  `${spRestores} rollback call(s) carry the server filter`)

const sessionGuard = probeStep.indexOf("elseif ($desktopSession -le 0) {")
const boolGuard = probeStep.indexOf("elseif ($markerInfo.win32ui -ne $true)")
check('D-24: a Session-0 (or unread) probe is a FAILURE - no-session is thrown BEFORE the booleans (JD3)',
  sessionGuard >= 0 && boolGuard > sessionGuard
  && probeStep.indexOf("$why = 'no-session'") > sessionGuard
  && /throw "desktop-token-probe: the DESKTOP token did not prove the lane \(\$why\)/u.test(probeStep),
  `session@${sessionGuard} booleans@${boolGuard}`)

console.log(failures === 0 ? `\nguest patch: PASS — ${checks} check(s)` : `\nguest patch: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
