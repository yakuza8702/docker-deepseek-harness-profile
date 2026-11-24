#!/usr/bin/env node
/**
 * check-cua-vm.mjs — the personal VM is a chain of loose contracts, and this is
 * the gate that keeps them joined.
 *
 * WHY A TEXT GATE, AND WHY THIS ONE IS BIGGER THAN check-cua-rea
 * ------------------------------------------------------------
 * Nothing in this feature type-checks end to end:
 *
 *   * the supervisor is a shell-out around cua/QEMU, and its guarantees are
 *     STRINGS (a config key, an op name, a checkpoint filename, a state);
 *   * the guest provisioner is bash, addressed by filename from the supervisor;
 *   * the plugin is a tool schema whose names must match the supervisor's ops;
 *   * the client is a string-keyed UI that must name the same ops again;
 *   * the proxy rewrites a container console because ports.json says "relay".
 *
 * A rename in any one of those leaves a build that boots, a panel that looks
 * right, and a feature that silently does nothing — which is exactly how the
 * "Shutdown button suspends", "click lands 6% off", "delete leaves 6 GB behind"
 * and "Windows option that creates nothing" bugs survived their own commits.
 *
 * WHAT IT IS NOT: not a test of QEMU, of the guest, or of Docker. It asserts that
 * every hop EXISTS and that the two invariants that are easy to delete by
 * refactoring (one coordinate space, one delete manifest) are still spelled out.
 * The behavioural proof lives in `docker/cua-vm-supervisor.mjs` running against
 * a real store.
 *
 * USAGE
 * -----
 *   node tools/check-cua-vm.mjs                 # repository layout
 *   node tools/check-cua-vm.mjs --root DIR      # flat image layout
 *   node tools/check-cua-vm.mjs --mutations     # the revert-proof harness (§7.2 E-4)
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    root: { type: 'string', default: path.resolve(import.meta.dirname, '..') },
    quiet: { type: 'boolean', default: false },
    // E-4 (R10/C15): the mutation harness. A SEPARATE invocation, never part of
    // the default run — it copies the tree and spawns this very file 36 times.
    mutations: { type: 'boolean', default: false }
  }
})
const ROOT = path.resolve(values.root)
/** This file. The mutation table is asserted against it (E1/E2) and it is the judge. */
const SELF = fileURLToPath(import.meta.url)

/** A file in either layout: flat (the image's check dir) or the repository's. */
function pick(name) {
  return pickIn(ROOT, name)
}

/** The same resolver against ANY tree — the mutation runner's throwaway copy. */
function pickIn(rootDir, name) {
  const candidates = [
    path.join(rootDir, name),
    path.join(rootDir, 'docker', name),
    path.join(rootDir, 'plugins', name),
    path.join(rootDir, 'plugins', 'dsh-cua-vm', name),
    path.join(rootDir, 'docker', 'windows-oem', name)
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/* ====================================================================== *
 * E-4 / C15 — THE MUTATION TABLE: THIRTY-SIX REVERTS, EACH ONE JUDGED.
 * ====================================================================== *
 *
 * R10's second half. A needle proves a line is PRESENT; it does not prove the
 * line is LOAD-BEARING — a needle whose `min` is met by a comment, a docstring
 * or a second copy would stay green through the very revert it claims to catch.
 * Each row below is one plausible revert, applied as a literal substitution to a
 * COPY of the tree, and then judged by this very file:
 *
 *   red  + the failure text names the expected needle/assertion  => the row is PROVEN
 *   red  + some other failure                                     => FALSE GREEN (fails the run)
 *   exit 0                                                        => FALSE GREEN (fails the run)
 *
 * THE TABLE IS FROZEN IN SIZE (36 rows: §7.3's 20, JE1's M-21/M-22, the
 * cold-boot round's M-23..M-28, M-29 from the PRE review — the staged-side
 * measure that had no row at all — and M-30..M-36 from the power-buttons round,
 * one revert per L-block contract).
 *
 * THIRTEEN ROWS CARRY `all: true` (replace every occurrence, require at least
 * one), and the reasons are two kinds, not one:
 *
 *   • TEN replace a *word* that is also documentation in its file — M-02
 *     `child-wedged`, M-04 `lastSuccessfulCallAgeMs`, M-05 `refreshMs`, M-07
 *     `relayFunctionalProbeProgram(`, M-08 `describeRepairRecord(`, M-09
 *     `perCallTimeoutMs`, M-12 `relay-unresponsive`, M-13 `desktopWarning`, M-15
 *     `typeTextFix`, M-16 `created_dir` — so a single-occurrence substitution
 *     would leave a second hit (a docstring, a test-facing field, a log line) and
 *     the needle would stay green. Risk (b) from WP-A's report, absorbed here
 *     instead of rediscovered later.
 *   • TWO (M-21 `savePathFix`, M-22 `desktopProbe`) are `all: true` for
 *     MULTIPLICITY: 13 and 8 occurrences in `cua-firstboot.ps1`, because a marker
 *     is the whole family of rows the doctor reads and a rename takes all of
 *     them. Their `replace` values deliberately do NOT contain the needle as a
 *     substring (`savePathPatch`, `desktopRun`) — `desktopProbeMarker` would have
 *     left `desktopProbe` matching and the pair would have been a false green.
 *   • ONE (M-27 `probe-unsupported`) is multi-site for the cold-boot round: the
 *     reason lives at the producer (the python program), in the frozen
 *     `RELAY_FN_REASONS` array and in prose, and RC-3 is exactly what a partial
 *     rename restores.
 *
 * M-17 (`desktop-token-probe`) stays a single-occurrence row: its literal is the
 * `Step '…'` header, which occurs once.
 *
 * Where a unique literal exists, the row spells the LONGEST one the file offers
 * (`pid = self._kill_wedged_child(proc, age_ms)`, `'RELAY_FN'`,
 * `'tool_capture_window',`, `const WIN_MCP_CALL_RETRY_BUDGET_MS`) so the drift
 * check has one answer, not a choice between a line and its echo.
 *
 * THE RUNNER IS NEVER A MUTATION TARGET. A mutated runner would be the process
 * judging its own mutation, so every one of the thirty-six rows mutates a
 * PACKAGE file and spawns an UNMUTATED judge from the copy: each verdict comes
 * from the same gate CI runs, and no pair can pass by breaking its own judge.
 */
const MUTATIONS = Object.freeze([
  /* ---- WP-A: the relay's wedge watchdog, evidence, facts cadence (S1) ---- */
  {
    // A COMMENT-OUT, not a rename — exactly the revert WP-A's report called a
    // false-green risk: an index-only order check still finds the literal inside
    // the comment. S1 strips comments first, so this row is what PROVES the
    // stripping works (risk (a), absorbed).
    id: 'M-01',
    file: 'cua-mcp-relay.py',
    find: 'pid = self._kill_wedged_child(proc, age_ms)',
    replace: '# pid = self._kill_wedged_child(proc, age_ms)',
    expect: 'S1:',
    why: 'kill-then-answer order (C4.6) is invisible to every presence needle'
  },
  {
    id: 'M-02',
    file: 'cua-mcp-relay.py',
    find: 'child-wedged',
    replace: 'child-stuck',
    all: true,
    expect: '× child-wedged',
    why: 'the model branches on this exact code; a rename is the silent break'
  },
  {
    id: 'M-03',
    file: 'cua-mcp-relay.py',
    find: "'RELAY_FN'",
    replace: "'RELAY_X'",
    expect: "× PROBE_FN = b'RELAY_FN'",
    why: 'the functional token is what the host base64 probe sends'
  },
  {
    id: 'M-04',
    file: 'cua-mcp-relay.py',
    find: 'lastSuccessfulCallAgeMs',
    replace: 'lastCallAgeMs',
    all: true,
    expect: '× lastSuccessfulCallAgeMs',
    why: 'C3 evidence key; a renamed field is a null the doctor renders as unknown'
  },
  {
    id: 'M-05',
    file: 'cua-mcp-relay.py',
    find: 'refreshMs',
    replace: 'refreshInterval',
    all: true,
    expect: '× refreshMs',
    why: 'the facts reader (and the host) read this exact key for the cadence'
  },
  /* ---- WP-B: the client's truth (functional probe, evidence, repair) ---- */
  {
    id: 'M-06',
    file: 'win-mcp.js',
    find: "RELAY_UNRESPONSIVE = 'RELAY_UNRESPONSIVE'",
    replace: "RELAY_UNRESPONSIVE = 'RELAY_DOWN'",
    expect: '× export const RELAY_UNRESPONSIVE',
    why: 'three tokens become two: a wedged child reads as a dead transport'
  },
  {
    id: 'M-07',
    file: 'win-mcp.js',
    find: 'relayFunctionalProbeProgram(',
    replace: 'relayFnProbeProgram(',
    all: true,
    expect: '× export function relayFunctionalProbeProgram(',
    why: 'the base64-carried program is the only functional prover'
  },
  {
    id: 'M-08',
    file: 'win-mcp.js',
    find: 'describeRepairRecord(',
    replace: 'repairSentence(',
    all: true,
    expect: '× export function describeRepairRecord(',
    why: 'C6 one-owner sentence; losing it brings back `reason:""`'
  },
  {
    id: 'M-09',
    file: 'win-mcp.js',
    find: 'perCallTimeoutMs',
    replace: 'timeout',
    all: true,
    expect: '× perCallTimeoutMs',
    why: 'the per-call budget is what lets 200 ms beat the 60 s default'
  },
  /* ---- WP-C: the plugin surface (budgets, codes, DEGRADED, attach truth) ---- */
  {
    id: 'M-10',
    file: 'index.js',
    find: 'const WIN_MCP_CALL_TIMEOUT_MS = 25_000',
    replace: 'const WIN_MCP_CALL_TIMEOUT_MS = 20_000',
    expect: 'S2:',
    why: 'host budget must exceed the guest wedge deadline, or child-wedged can never arrive'
  },
  {
    id: 'M-11',
    file: 'index.js',
    find: "const prefix = winMcpElementLaneDegraded(guestName, snapshot) === true ? `${DEGRADED_ELEMENT_LANE_SENTENCE} ` : ''",
    replace: "const prefix = ''",
    expect: 'S4:',
    why: 'the [DEGRADED] prefix is the only warning a dead element lane gets'
  },
  {
    id: 'M-12',
    file: 'index.js',
    find: 'relay-unresponsive',
    replace: 'tool-timeout',
    all: true,
    expect: '× relay-unresponsive',
    why: 'C6 routing: one code for "the child did not answer" collapsed back into a generic timeout'
  },
  {
    id: 'M-13',
    file: 'index.js',
    find: 'desktopWarning',
    replace: 'desktopNote',
    all: true,
    expect: '× desktopWarning',
    why: 'C9: the reveal and the doctor publish this field; a rename is an unmeasured desktop going silent'
  },
  {
    id: 'M-14',
    file: 'index.js',
    find: "'tool_capture_window',",
    replace: "'find_elements',",
    expect: 'S3:',
    why: 'a retried tool on a dead element lane doubles the cost of the one call that cannot recover'
  },
  /* ---- WP-D: the guest payload (type_text, save_path, desktop token) ---- */
  {
    id: 'M-15',
    file: 'cua-firstboot.ps1',
    find: 'typeTextFix',
    replace: 'typeTextPatch',
    all: true,
    expect: '× typeTextFix',
    why: 'the idempotency key AND the marker: a rename re-patches on every boot'
  },
  {
    id: 'M-16',
    file: 'cua-firstboot.ps1',
    find: 'created_dir',
    replace: 'made_dir',
    all: true,
    expect: '× created_dir',
    why: 'the receipt that says the directory was created is what makes a silent save honest'
  },
  {
    id: 'M-17',
    file: 'cua-firstboot.ps1',
    find: "Step 'desktop-token-probe'",
    replace: "Step 'desktop-probe'",
    expect: '× Step \'desktop-token-probe\'',
    why: 'the only proof the desktop token can see a real session'
  },
  /* ---- cross-file rows: the ladder's derived budget, C3's owner, identity ---- */
  {
    id: 'M-18',
    file: 'index.js',
    find: 'const WIN_MCP_CALL_RETRY_BUDGET_MS',
    replace: 'const WIN_MCP_RETRY_TOTAL_MS',
    expect: '× const WIN_MCP_CALL_RETRY_BUDGET_MS',
    why: 'the retry budget is DERIVED (2 envelopes + 4 s); an independent constant drifts'
  },
  {
    id: 'M-19',
    file: 'cua-mcp-relay.py',
    find: 'def _fn_evidence(',
    replace: 'def _fn_facts(',
    expect: '× def _fn_evidence(',
    why: 'the single owner of the C3 evidence object'
  },
  {
    id: 'M-20',
    file: 'index.js',
    find: "PLUGIN_VERSION = '0.2.3'",
    // THE REPLACEMENT IS DELIBERATELY THE PREVIOUS RELEASE, not the current one:
    // M-20 has to make the two files DISAGREE, so this `0.2.2` is the mutation's
    // payload, not a claim about this build. A "stale version" sweep that
    // rewrote it to 0.2.3 would disarm the pair silently — do not.
    replace: "PLUGIN_VERSION = '0.2.2'",
    expect: 'WP-6.6',
    why: 'one identity, two files: half a bump makes "the fix is not in your plugin" a guess'
  },
  /* ---- JE1 (JURY chief + co-juror 2): the two markers a rename could erase ---- */
  {
    // `typeTextFix` had a needle AND M-15; these two had NEITHER, so a rename
    // passed every gate while the doctor read a marker that no longer existed.
    // `replace` deliberately does NOT contain the needle as a substring
    // (`savePathPatch` vs `savePathFix`) — `desktopProbeMarker` would have left
    // `desktopProbe` matching and the pair would have been a false green.
    id: 'M-21',
    file: 'cua-firstboot.ps1',
    find: 'savePathFix',
    replace: 'savePathPatch',
    all: true,
    expect: '× savePathFix',
    why: 'the save-path step is silent without its marker: "not attempted" and "attempted and refused" become one state'
  },
  {
    id: 'M-22',
    file: 'cua-firstboot.ps1',
    find: 'desktopProbe',
    replace: 'desktopRun',
    all: true,
    expect: '× desktopProbe',
    why: 'the desktop-token probe is the only proof the desktop can see a session; an orphaned marker key reports it as never run'
  },
  /* ---- CB / WP-6 (§4.3): the cold-boot round's six reverts ---- */
  {
    // Judged by S7, not by a needle: the ladder's SIZE is an arithmetic fact, and
    // a string row could be satisfied by the constant being declared and unused.
    id: 'M-23',
    file: 'win-mcp.js',
    find: 'BOOT_RACE_ATTACH_MS = 24000',
    replace: 'BOOT_RACE_ATTACH_MS = 90000',
    expect: 'S7',
    why: 'the ladder must fit inside the 45 s handshake; an equal-window ladder burns the attach and still lands blind'
  },
  {
    // The revert that turns every genuinely-dead relay into a 24 s attach.
    id: 'M-24',
    file: 'win-mcp.js',
    find: 'if (bootWindow.live !== true) ',
    replace: 'if (false) ',
    expect: "× if (bootWindow.live !== true)",
    why: 'a ladder outside the window is a 24 s delay on a relay that is simply off'
  },
  {
    // A closed set read by two surfaces (BLIND_REASONS + BLIND_ACTIONS): a rename
    // is the silent break, so the row pins the array entry.
    id: 'M-25',
    file: 'index.js',
    // The find follows row 13's corrected spelling (see the row's comment): the
    // value is the LAST array element, so it has no trailing comma to quote.
    find: "'boot-race'\n])",
    replace: "'boot-slow'\n])",
    expect: "× 'repair-disabled',",
    why: 'the reason is a closed set; a rename leaves the payload naming a value no consumer knows'
  },
  {
    // Judged by S11: this is the EXACT revert that restores the reported defect
    // (19 names reported as leaks while the bridge is online).
    id: 'M-26',
    file: 'index.js',
    find: 'const leaks = online === true ? [] : prefixSchemas',
    replace: 'const leaks = prefixSchemas',
    expect: 'S11',
    why: 'restoring the full prefix surface online is RC-5'
  },
  {
    // all: true: the reason occurs at the producer, in the constant and in prose.
    // A value outside the closed set is normalized to no-evidence (RC-3 returns).
    id: 'M-27',
    file: 'win-mcp.js',
    find: "'probe-unsupported'",
    replace: "'probe-unknown'",
    all: true,
    expect: '× export const RELAY_FN_REASONS',
    why: 'a reason the normaliser does not know is downgraded to no-evidence, which is RC-3 again'
  },
  {
    // Judged by S10 (gating, not spelling): this is the revert that lets the
    // 15 s poll stage a 43 KB file every minute. §4.3 spells the find
    // `payloadRepair === true`; the implemented gate is its inverse as an EARLY
    // RETURN (`if (payloadRepair !== true) return …`), which is the same decision
    // and the only form S10 can order against the staging call. Disabling it is
    // the revert; the spelling is the guard's own.
    id: 'M-28',
    file: 'win-mcp.js',
    find: 'if (payloadRepair !== true) return',
    replace: 'if (false) return',
    expect: 'S10',
    why: 'an ungated stage makes the poll push 8 SSH children a minute for the life of the machine'
  },
  {
    // THE VACUOUS-PIN REVERT (PRE/mimo, measured on this tree): delete the staged
    // measure and the guard is copied on every provisioning pass, because
    // `-not $stagedHash` then always holds. Before this row NOTHING went red —
    // the gate stayed at 1337 and guest-patch still passed. The replacement keeps
    // the variable and the catch intact (so the step still parses and the init
    // line still exists), which is precisely what made the deletion invisible.
    id: 'M-29',
    file: 'cua-firstboot.ps1',
    find: '$stagedHash = (Get-FileHash -LiteralPath $guardScript -Algorithm SHA256).Hash.ToLowerInvariant()',
    replace: "$stagedHash = ''",
    expect: '× $stagedHash = (Get-FileHash',
    why: 'a blanked measure makes the pin vacuous again: -not $stagedHash always holds, so E2 loses its literal and D12/S12 lose measure-then-write — the WP-1A write-always copy returns'
  },
  /* ------------------------------------------------------------------ *
   * THE POWER-BUTTONS ROUND (§WP-D D-6): M-30..M-36 — one revert per
   * L-block contract. Each `find` is a literal that is UNIQUE on this tree
   * (E2 asserts that on every gate run), and each `expect` is the L-block
   * whose failure message names the revert, so a red that says something
   * else is still a FALSE GREEN.
   * ------------------------------------------------------------------ */
  {
    // The whole refusal hinges on the deadline being FINITE: 0 is the legacy
    // "wait for ever" knob, i.e. exactly the HEAD behaviour this round removed.
    id: 'M-30',
    file: 'cua-vm-lock.mjs',
    find: 'export const LOCK_WAIT_MS = 30_000',
    replace: 'export const LOCK_WAIT_MS = 0',
    expect: 'L1',
    why: 'no finite deadline ⇒ a wedged holder silences every power op again, with no refusal to read (R1/C3)'
  },
  {
    // The CAS is the ONLY thing between a late verdict and a row that moved on.
    id: 'M-31',
    file: 'cua-vm-supervisor.mjs',
    find: 'if (row.state !== expect.state || row.stateSince !== expect.stateSince) return false',
    replace: 'if (false) return false',
    expect: 'L2',
    why: 'without the CAS a QMP verdict formed minutes ago clobbers a Start that landed in between (W3)'
  },
  {
    // C8.2 spelled: the busy branch must STILL schedule.
    id: 'M-32',
    file: 'cua-vm-supervisor.mjs',
    find: 'if (busy) { schedule(); return }   // C8.2',
    replace: 'if (busy) { return }   // C8.2',
    expect: 'L3',
    why: 'a busy tick that returns without scheduling is the death of the poll: one parked tick and the guest is invisible for the life of the process (R2)'
  },
  {
    // THE ORDER, not the presence: a deferral injected BEFORE the state write is
    // a capture that can fail before the fact is recorded.
    id: 'M-33',
    file: 'cua-vm-supervisor.mjs',
    find: 'const recorded = await mutateRegistryWith((registry) => {',
    replace: "await scheduleDeferredWindowsCheckpoint(name, token, config, { origin: 'guest-shutdown' })\n  const recorded = await mutateRegistryWith((registry) => {",
    expect: 'L2',
    why: 'a capture before the state write is the pre-fix finaliseGuestShutdown: one quota refusal and the powered-off row never lands (P4/D1)'
  },
  {
    // The 30-minute socket default, back on the one route the page polls.
    id: 'M-34',
    file: 'index.js',
    find: 'state: 15_000',
    replace: 'state: TOOL_TIMEOUT_MS',
    expect: 'L5',
    why: "the page's own beat inheriting the 30-minute socket default is defect R4 in one line"
  },
  {
    // The hidden-button symptom, restored: the buttons become a show-condition.
    id: 'M-35',
    file: 'client.js',
    find: 'disabled: !canPower || busy',
    replace: "canPower && h('button'",
    all: true,
    expect: 'L6',
    why: 'a button that is HIDDEN on a powered-off row is the reported symptom, and it leaves the user no exit from a wedge (C20)'
  },
  {
    // The space half of the pre-flight, disabled: a convert that cannot fit.
    id: 'M-36',
    file: 'cua-vm-supervisor.mjs',
    find: 'const shortfall = await checkpointSpaceShortfall(diskBytes)',
    replace: 'const shortfall = null',
    expect: 'L7',
    why: 'without the filesystem fact a 9.1 GiB disk is checkpointed onto 3.3 GB free — the live trigger that wedged the shutdown (C22)'
  }
])

/**
 * E-4's runner. Copies ROOT (never `.git`/`node_modules`), then applies each row
 * to the COPY, spawns this file as an unmutated judge against the copy, and
 * requires BOTH a non-zero exit AND the row's expected failure text.
 *
 * The expected text is what separates a red from a FALSE GREEN: a mutation that
 * breaks the tree in some unrelated way (a syntax error, a missing file) also
 * exits non-zero, and counting that as proof is how a mutation table rots into
 * 20 decorative rows.
 */
async function runMutations() {
  const startedAt = Date.now()
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cua-vm-mutations-'))
  const copy = path.join(tmpRoot, 'tree')
  const results = []
  try {
    cpSync(ROOT, copy, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src)
        return base !== '.git' && base !== 'node_modules'
      }
    })
    for (const mutation of MUTATIONS) {
      const target = pickIn(copy, mutation.file)
      if (target === null) {
        results.push({ id: mutation.id, proved: false, detail: `the target ${mutation.file} is missing from the copied tree` })
        continue
      }
      const original = readFileSync(target, 'utf8')
      const hits = original.split(mutation.find).length - 1
      if (hits < 1 || (mutation.all !== true && hits !== 1)) {
        results.push({
          id: mutation.id,
          proved: false,
          detail: hits === 0
            ? `the mutation target drifted: ${JSON.stringify(mutation.find)} no longer occurs in ${mutation.file}`
            : `the mutation target is ambiguous: ${hits} occurrences of ${JSON.stringify(mutation.find)} in ${mutation.file} — use all: true or a longer literal`
        })
        continue
      }
      const mutated = mutation.all === true
        ? original.split(mutation.find).join(mutation.replace)
        : original.replace(mutation.find, mutation.replace)
      let judged = null
      try {
        writeFileSync(target, mutated)
        judged = spawnSync(process.execPath, [SELF, '--root', copy, '--quiet'], {
          cwd: copy,
          encoding: 'utf8',
          timeout: 300_000
        })
      } finally {
        // ALWAYS restore, even when the judge could not be spawned: the next row
        // may target the same file, and a half-mutated copy judges nothing.
        writeFileSync(target, original)
      }
      const stderr = `${judged?.stderr ?? ''}`
      const red = judged !== null && judged.status !== 0
      const named = stderr.includes(mutation.expect)
      results.push({
        id: mutation.id,
        proved: red && named,
        detail: red === false
          ? `exit 0 — the gate stayed GREEN with ${mutation.id} applied (${mutation.why})`
          : named === false
            ? `exit ${judged.status} but the failure never names ${JSON.stringify(mutation.expect)} — a false red proves nothing (${mutation.why})`
            : `red, expected message present (${mutation.why})`
      })
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
  const proved = results.filter((row) => row.proved === true).length
  for (const row of results) {
    console.log(`  ${row.proved === true ? 'red ' : 'GREEN'} ${row.id} — ${row.detail}`)
  }
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  if (proved === MUTATIONS.length) {
    console.log(`\nmutations: ${proved}/${MUTATIONS.length} red, ${results.length - proved} false-green (${seconds}s, judge = ${path.relative(ROOT, SELF) || SELF})`)
    process.exit(0)
  }
  console.error(`\nmutations: ${proved}/${MUTATIONS.length} red, ${results.length - proved} FALSE-GREEN (${seconds}s)`)
  console.error('A false-green pair is worse than no pair: it claims a line is load-bearing while proving nothing.')
  process.exit(1)
}

// THE MODE. Placed before the default run so `--mutations` never pays for the
// gate's own assertions first: the judge runs inside the loop, twenty times.
if (values.mutations) {
  await runMutations()
}

/** Whitespace drifts when a line is rewrapped; everything else is literal. */
function needlePattern(needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return escaped.split(/ +/u).join('\\s+')
}

const FILES = {
  supervisor: { label: 'docker/cua-vm-supervisor.mjs', name: 'cua-vm-supervisor.mjs' },
  space: { label: 'docker/cua-vm-space.mjs', name: 'cua-vm-space.mjs' },
  kvm: { label: 'docker/cua-vm-kvm.mjs', name: 'cua-vm-kvm.mjs' },
  windows: { label: 'docker/cua-vm-windows-qemu.mjs', name: 'cua-vm-windows-qemu.mjs' },
  // WP-2/WP-3: the same module, three different questions. The catalog, the
  // firmware profiles and the ISO strategy chains are separate contracts, and a
  // single 200-needle list hid which one a failure belonged to.
  windowsCatalog: { label: 'docker/cua-vm-windows-qemu.mjs (catalog)', name: 'cua-vm-windows-qemu.mjs' },
  windowsSources: { label: 'docker/cua-vm-windows-qemu.mjs (ISO sources)', name: 'cua-vm-windows-qemu.mjs' },
  // WP-7: the RFB+clipboard bridge the live view prefers over raw websockify.
  vncClip: { label: 'docker/cua-vnc-clip.mjs', name: 'cua-vnc-clip.mjs' },
  winMcp: { label: 'plugins/dsh-cua-vm/win-mcp.js', name: 'win-mcp.js' },
  oemAnswer: { label: 'docker/windows-oem/Autounattend.xml', name: 'Autounattend.xml' },
  oemSetup: { label: 'docker/windows-oem/setupcomplete.cmd', name: 'setupcomplete.cmd' },
  oemBoot: { label: 'docker/windows-oem/cua-firstboot.ps1', name: 'cua-firstboot.ps1' },
  // WP-1: THE RELAY GUARD — its OWN entry, because the probe and the autologon
  // re-assert MOVED here. `cua-firstboot.ps1` no longer carries a TcpClient
  // probe at all (its old `Test-RelayPing` is what two separate short-read
  // defects lived in), so the needle list that keeps looking for it in the
  // firstboot file would either fail forever or, worse, pass on a stub copy. One
  // owner, one gate block: the firstboot block asserts that the STAGING and the
  // two tasks exist, this block asserts that the ONE probe is still correct.
  oemGuard: { label: 'docker/windows-oem/cua-relay-guard.ps1', name: 'cua-relay-guard.ps1' },
  clipAgent: { label: 'docker/cua-clip-agent.ps1', name: 'cua-clip-agent.ps1' },
  // J22-14: the two-mode python relay. Guest-side, so it gets its own section
  // instead of being folded into the Windows backend's 400 needles: `--serve`
  // is the listener inside the interactive session and `--connect` is the byte
  // bridge the SSH command starts, and BOTH live in this one file.
  relay: { label: 'docker/cua-mcp-relay.py', name: 'cua-mcp-relay.py' },
  oemLauncher: { label: 'docker/windows-oem/Unattend.vbs', name: 'Unattend.vbs' },
  provision: { label: 'docker/cua-guest-provision.sh', name: 'cua-guest-provision.sh' },
  android: { label: 'docker/cua-guest-android.sh', name: 'cua-guest-android.sh' },
  dockerfile: { label: 'Dockerfile', name: 'Dockerfile' },
  client: { label: 'plugins/dsh-cua-vm/client.js', name: 'client.js' },
  index: { label: 'plugins/dsh-cua-vm/index.js', name: 'index.js' },
  proxy: { label: 'docker/proxy.mjs', name: 'proxy.mjs' },
  compose: { label: 'compose.yaml', name: 'compose.yaml' },
  composeWindows: { label: 'compose.windows.yaml', name: 'compose.windows.yaml' },
  env: { label: '.env.example', name: '.env.example' }
}

/**
 * The chain, in the order it breaks.
 *
 * Each needle is a fact the feature depends on. `min` > 1 is used where the SAME
 * call has to appear on more than one path (shutdown and suspend), because one
 * surviving call site is exactly the regression that looks fine until the second
 * button.
 */
const NEEDLES = {
  supervisor: [
    // =====================================================================
    // WP-7.4 / WP-2 — THE PIN AND THE BOOT WAIT (SOL §7.4).
    //
    // These four needles are the whole difference between "a boot race" and
    // "a permanent failure" reaching the model, and every one of them is a
    // fact a revert breaks:
    //
    //   * `WINDOWS_DSH_CUA_DEFAULT` (2) — the EXPORTED default (so a unit test
    //     can assert the pin without creating a computer) and the SPEC that
    //     reads it. A bare literal in `WINDOWS_DSH_CUA_SPEC` would satisfy a
    //     "the version is pinned" grep while leaving nothing a test can import,
    //     and the env override must stay, so the default is the export.
    //   * `dsh-cua==0.4.1` (1) — the build Appendix A's hash gate and the
    //     relay's `dshCuaVersion` fact both assume. A float (`dsh-cua`) is the
    //     defect this release closes; the exact wheel is the contract.
    //   * `windowsSshBootWait` (2) — the helper AND at least one of
    //     exec/put/get. A wait that exists but is never called leaves the old
    //     `255` / `126 "no guest agent"` vocabulary in place (the defect) while
    //     every needle about booting still passes.
    //   * `code: booting` (1) — the give-up sentence's first line, verbatim, so
    //     the model branches on the same string the tool prints instead of on a
    //     paraphrase. It is `code: booting` (stderr text), not `code:'booting'`
    //     (the put/get field), because this is the sentence §4.8 freezes.
    ['WINDOWS_DSH_CUA_DEFAULT', 2],
    ['dsh-cua==0.4.1', 1],
    ['windowsSshBootWait', 2],
    ['code: booting', 1],
    // U2/U4: THE CLIPBOARD (session 2 only) AND THE MEASURED FREE SPACE.
    // The backend owns the protocol (file, then task, then the task's own Last
    // Result); this file owns the channel (the per-computer key, scp). The
    // transport is INJECTED so a test can drive the real protocol with a stub.
    ['async vmWindowsClipboardSet({ name, text } = {})', 1],
    ['async vmWindowsClipboardGet({ name } = {})', 1],
    ['async vmWindowsFreeSpace({ name, force = false } = {})', 1],
    // J21-3: THE TEXT IS THE SECOND POSITIONAL ARGUMENT. This call passed ONE
    // object (`{ ...meta, name }`), and the backend's `clipboardSet(rawSpec,
    // text)` refuses anything else with "clipboardSet needs the text to paste":
    // every host→guest paste (the panel route AND the noVNC bridge's control
    // socket write) failed after the whole SSH task had been prepared.
    ['windowsBackend.clipboardSet({ ...meta, name }, text)', 1],
    ['windowsBackend.clipboardGet({ ...meta, name })', 1],
    ['transport: windowsClipboardTransport()', 1],
    ['function windowsClipboardTransport()', 1],
    ['cua-clip-set', 2],
    ['cua-clip-get', 1],
    ['Last Result', 2],
    ['clip-read.txt', 1],
    ['U2: WHAT TO SAY WHEN THE CLIPBOARD SECTION IS UNAVAILABLE', 1],
    // U4: the measured C: free space, throttled, never fatal.
    ["freeSpace: state === 'ready' ? await windowsFreeSpace(meta)", 1],
    ['const WINDOWS_FREE_TTL_MS = 60000', 1],
    // One probe per computer at a time: the panel's 5 s status beat and the 60 s
    // free-space beat must not open two SSH sessions on a guest that is busy.
    ['const WINDOWS_FREE_INFLIGHT = new Map()', 1],
    ['if (WINDOWS_FREE_INFLIGHT.get(name) === probe) WINDOWS_FREE_INFLIGHT.delete(name)', 1],
    ['\'powershell -NoProfile -NonInteractive -Command "(Get-PSDrive -Name C).Free"\'', 1],
    // registry v2 + read-migration
    ['const REGISTRY_VERSION = 2', 1],
    ['function migrateRegistryRow(row, mapKey = \'\')', 1],
    // R2: the migration INJECTS `name` into every row already on disk, so a
    // store written before the fix stops answering "QEMU not alive" about a
    // running process. The map key is the only place that name exists.
    ['out[name] = migrateRegistryRow(row, name)', 1],
    // R3: the QMP join. The backend's `(host, port, cmds, opts)` and this
    // process's `(port, cmds, { timeoutMs, host })` are different signatures,
    // and passing the raw primitive made the HOST the PORT. The one-line
    // `createWindowsBackend({ store: STORE, qmp: qmpCommands, log })` needle was
    // REPLACED (not dropped) by the multi-line wiring below, in the same commit.
    ['const windowsBackend = createWindowsBackend({', 1],
    ['qmp: windowsQmpAdapter(qmpCommands),', 1],
    ['function migrateRegistry(parsed)', 1],
    ['parsed.version !== REGISTRY_VERSION', 1],
    // policy keys
    ['shutdownTimeoutSec: 120,', 1],
    ["checkpointPolicy: 'shutdown',", 1],
    ['shotsKeepDays: 7,', 1],
    ['windowsInstallTimeoutMinutes: 60', 1],
    ['const CHECKPOINT_POLICIES = new Set(', 1],
    // credentials: 0600, never the registry
    ['function windowsCredentialsPath(name)', 1],
    ['chmodSync(file, 0o600)', 1],
    // accounting + quota rule
    ['async function storeUsedBytes()', 1],
    ["path.join(STORE, 'shots'),", 1],
    ['async function refuseOverQuota(config, requestedBytes)', 1],
    ['used + Math.max(0, requestedBytes) <= quota', 1],
    // the delete manifest
    ['async function destroyVm(name, { reason =', 1],
    ["record('sb rm --force'", 1],
    ['checkpointFilesFor(name)', 1],
    ['shotFilesFor(name)', 1],
    ["record('views.json'", 1],
    ['async function collectGarbage(', 1],
    ['async function reconcilePorts()', 1],
    // the real shutdown
    ['async function shutdownVm(name, { reason', 1],
    ["{ execute: 'system_powerdown' }", 1],
    ["{ execute: 'quit' }", 1],
    ['async function waitForPowerDown(name, target, timeoutMs)', 1],
    ['async function startFromCheckpoint(name, meta)', 1],
    ['DSH_CUA_VM_LEGACY_STOP', 1],
    ["state = 'powered-off'", 1],
    ['mayBeTorn', 2],
    // one spec, two backends
    ['const SPEC_DEFAULTS = {', 1],
    ['function normaliseSpec(input = {})', 1],
    ['android: input.android === true, rea: input.rea === true', 1],
    ['rea: false,', 1],
    ['function gpuDefault()', 1],
    ["args.push('--gpu', 'virgl')", 1],
    ['const RUNNING_STATES = new Set(', 1],
    // one coordinate space
    ['const space = createSpace({', 1],
    ['relativeToPixels(measured, x, y)', 1],
    ['toDisplayPixels(measured, toX, toY)', 1],
    ['spaceLine(measured)', 4],
    ["const SHOTS_DIR = path.join(STORE, 'shots')", 1],
    ['formatSpaceWarning,', 1],
    // host facts + windows surface
    ['async function doctorReport()', 1],
    ['async function windowsCreateManaged(spec)', 1],
    ['const WINDOWS_NO_AGENT = (tool) =>', 1],
    ['async function windowsGui({', 1],
    ["backend: 'relay'", 1],
    // boot work
    ['void reconcilePorts()', 1],
    ['watchWindowsInstall(name)', 2],
    // D1: a failed spawn is a RESULT. The old handler read a property off
    // `done()`'s return and threw inside the 'error' listener, killing the
    // process; the fix routes it through the same single-shot `done`.
    ["child.on('error', (error) => done(-1, false,", 1],
    ['if (settled) return', 1],
    // D2: a name is a path segment, validated at the dispatcher AND at the
    // helpers that build a path from it.
    ['const VM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/', 1],
    ['function assertVmName(name)', 1],
    ['assertVmName(request.name)', 1],
    ['assertVmName', 12],
    // D3: "QMP unreachable" is not "the computer is off" — the pid decides.
    ['let qemuMayBeAlive = false', 1],
    ['qemuMayBeAlive = pidAlive(qemuPid(name))', 2],
    ["method = qemuMayBeAlive ? 'abandoned' : 'already-off'", 1],
    // ...and an abandoned computer is LEFT ALONE: no checkpoint, no sb rm, no
    // `powered-off` lie that would make Start build a second QEMU on the disk.
    ['could not power ${name} off: QEMU (pid ${qemuPid(name)}) is still running', 1],
    ['nothing was removed', 1],
    // D3 (round 2): the stale marking has a PRODUCER, in the same write as
    // lastShutdown=abandoned — without it Start's refusal was dead code.
    ['const stale = meta.restoreFrom?.stale === true', 1],
    ["row.restoreFrom?.kind !== 'checkpoint'", 1],
    ['staleReason:', 1],
    ['shutdown abandoned while QEMU held the disk', 1],
    ['Its existing restore point is now marked stale', 1],
    // D4: measuring must point cua at the computer being measured first.
    ['if (DO_TARGET !== name)', 2],
    ['space.clear()', 2],
    // D5: registry mutations are serialised, so an await cannot resurrect a
    // row another handler already moved on.
    ['function mutateRegistry(mutator)', 1],
    ["withLock('@registry'", 1],
    // S3: every lifecycle op takes the same per-computer lock, and it is
    // re-entrant so shutdown→suspend and stop→shutdown cannot deadlock.
    ['function withVmLock(name, fn)', 1],
    ['VM_LOCK_CONTEXT', 3],
    // S8/S9: an unreadable registry throws instead of being persisted empty, and
    // the v1→v2 write happens under the lock (at boot).
    ['registry.json could not be read', 1],
    ['await migrateRegistryFile()', 1],
    // S1: GC is serialised against the lifecycle lock it shares with a convert
    // or a boot, so it cannot delete a `.tmp` or a restore temp mid-flight.
    ["return withLock('@gc'", 1],
    // A-2/C6: the GC group takes the SAME adapter with a THIRD argument —
    // `{ mode: 'try', waitMs: GC_LOCK_WAIT_MS }` is the skip-and-say-so
    // classification, so a busy group is REPORTED in the GC answer instead of
    // spending the tool budget queueing. The options are an argument, never a
    // rename, because `function withVmLock(name, fn)` is itself pinned above.
    ["withVmLock(groupName, run, { mode: 'try', waitMs: GC_LOCK_WAIT_MS", 1],
    // S5/S15: a failed `sb rm` keeps the row (marked orphaned) and the delete
    // reports itself as partial.
    ['row.orphaned = true', 1],
    ['deleted: complete', 1],
    ['failed: failures.map', 1],
    // S10: the quota is a RESERVATION, not a check-then-act.
    ['function reserveStoreBytes(name, bytes)', 1],
    ['releaseStoreBytes(name)', 1],
    ['releaseStoreBytes(spec.name)', 2],
    // Q1: THE CREATE-TIME QUOTA IS REAL BYTES. A sparse disk's VIRTUAL size is
    // never charged: the create reserves 0 and reports `disk-over-policy`
    // instead of refusing (the report was "a 64 GB disk does not fit the VM
    // store quota (15 GB)"; the store held a few hundred MB).
    ['function diskPolicyWarnings(diskGb, config)', 1],
    ["code: 'disk-over-policy'", 1],
    ['the disk is sparse so creation proceeds', 1],
    ['diskPolicyWarnings(effectiveDiskGb, config)', 1],
    ['diskPolicyWarnings(diskGb, config)', 1],
    ['reserveStoreBytes(name, 0)', 1],
    ['reserveStoreBytes(spec.name, 0)', 1],
    // The refusal that survives names REAL usage, never the virtual request.
    ['of real store data', 1],
    ['warnings: warnings.length > 0 ? warnings : undefined', 2],
    // S11/S12/S13: a checkpoint needs room, a QEMU that survives `quit` is not
    // off, and a failed shutdown puts the preview back.
    ['diskBytesFor(name)', 1],
    ["abandonedBecause = 'survived the QMP quit'", 1],
    ['restorePorts(name, previews)', 1],
    // S2: mayBeTorn is READ on the start path, not just written.
    ['meta.mayBeTorn === true', 1],
    // The Windows refusals live in the supervisor's create path (the backend
    // module is only the QEMU command builder).
    ['REA is not available for Windows computers', 1],
    ['Android is not available for Windows computers', 1],
    // The Windows lifecycle now drives the SAME shutdown/start machinery.
    ['async function windowsShutdown(name, meta)', 1],
    // K2: the runtime path of the OEM payload, spelled with its default. The
    // Dockerfile must COPY to this exact string (cross-checked in the K2
    // assertion below); this needle keeps the literal from being rewritten to a
    // path no image ships.
    ["DSH_CUA_WINDOWS_OEM_DIR || '/usr/local/share/cua-vm/windows-oem'", 1],
    // K2: the fallback list is RESOLVED and HANDED to the writer, not just
    // declared — a constant nothing reads is not a fallback.
    ['fallbackDirs: WINDOWS_OEM_FALLBACK_DIRS', 1],
    ['DSH_CUA_WINDOWS_OEM_FALLBACK_DIRS', 1],
    ['function sshRun(meta, command,', 1],
    ['function scpRun(meta, localPath, guestPath', 1],
    ['await ensureWindowsConsoleRelay(name)', 2],
    // F1: EACH SHUTDOWN CHECKPOINTS ITS OWN DISK. These two needles are a pair
    // on purpose: swapping them (which happened) makes both platforms silently
    // skip their checkpoint.
    ['function checkpointDiskFile(name, disk)', 1],
    // C21: the WINDOWS capture awaits its child (`checkpointDiskFileAsync`,
    // `runCaptureCommand`), so `execFileSync` cannot block the event loop for a
    // 10 GB convert. `checkpointDiskFile` (sync) survives ONLY for the Linux
    // suspend/shutdown path, which is the needle directly above.
    ['await checkpointDiskFileAsync(name, windowsPaths(STORE, name).disk)', 1],
    ['checkpoint = checkpointSandbox(name)', 2],
    // B2: Start restores a Windows checkpoint over the disk.
    ['restored from its checkpoint', 1],
    // D4: the watcher records that the install finished.
    ['row.installComplete = true', 3],
    // K3: during Setup only SSH gates `ready` (QEMU's VNC socket answers from
    // the first second of setup.exe and used to mark a half-install ready).
    ["phase: 'install'", 1],
    // F3: THE STATUS POLL MUST NOT PROMOTE A HALF-INSTALL. `vmWindowsStatus`
    // called `ready(meta, { ssh })` with NO phase, so an ordinary panel poll
    // took the RUNNING path, accepted the VNC banner (which answers from the
    // first second of setup.exe), wrote state:'ready' + installComplete, stopped
    // the watcher and let the idle timer suspend a live install. The poll now
    // passes the SAME phase the watcher does, decided from the row.
    ['const installPhase = meta.state === \'installing\' || meta.state === \'booting\'', 1],
    ['...(installPhase ? { phase: \'install\' } : {})', 1],
    // H4: the abandoned Windows shutdown marks its restore point, like Linux.
    ['async function markWindowsShutdownAbandoned(name, because)', 1],
    ['windowsBackend.pidAlive(windowsPid)', 1],
    // H5: the start verifies QEMU reached `running` before trusting it.
    ['let running = false', 1],
    // H1/H7: per-attempt deadline, port reconciliation.
    ['row.startedAt = new Date().toISOString()', 1],
    ['async function reconcileWindowsPorts(name, meta)', 1],
    // M1: the ISO cache is accounted for and GC'd.
    ['ISO_DIR', 3],
    ['report.isos.push', 1],    // M6/X1: a genuine rebuild stops the old child; a live one is reused.
    ['stopLiveView(name)', 4],
    // M5: Windows guest paths are validated before they reach scp.
    ['function assertWindowsGuestPath(guest)', 1],
    // L2: one canonical backend value, also in the migration.
    ["backend: windows ? 'qemu' : 'linux'", 1],
    // X1: reuse the live view instead of killing it on every call.
    ['const alive = child !== undefined && child.exitCode === null && child.signalCode === null', 1],
    // X2: region/scale reach the Windows branch.
    ['windowsGui({ name, action, x, y, x2, y2, text, key, save, app, window: windowName, path: target, relative, region, scale })', 1],
    // X4: shared media is never pruned (the virtio ISO is referenced by no row).
    ['const alwaysKeep = new Set([', 1],
    // Z3: the allowlist uses the SAME name normalisation as the download.
    ['isoTargetPath(ISO_DIR, entry.url)', 1],
    // X5/Z1: reconciliation respects other rows and in-flight claims, and
    // excludes the SUBJECT by name (rows carry no `name` field, so comparing
    // against `meta.name` never matched and every start re-allocated).
    ['const reserved = new Set(CLAIMED_WINDOWS_PORTS)', 1],
    ['if (otherName === name) continue', 1],
    ['for (const port of Object.values(ports)) reserved.delete(Number(port))', 1],
    // Z2: the row owns its ports once written; the claim is released there.
    ['for (const port of Object.values(portTriple)) CLAIMED_WINDOWS_PORTS.delete(Number(port))', 1],
    // Z4: without websockify an existing raw relay IS the view.
    ["const rawRelay = existing.backend === 'relay'", 1],
    // X6: the download reserves before it writes.
    ['reserveStoreBytes(`${spec.name}/iso`, expectedBytes)', 1],
    // X7: resume rebuilds the preview.
    ["await ensureWindowsConsoleRelay(name)\n    return ok({ name, state: 'ready', kind: 'windows' })", 1],
    // K8: the Linux path keeps its behaviour (no new refusal) but a failed
    // create carries the SAME diagnosis when the device is mounted and denied.
    ['function linuxKvmFailureHint()', 1],
    ['${linuxKvmFailureHint()}', 1],
    ['const kvmError = windowsKvmPreflight()', 1],
    // K9: the doctor reads the probe instead of parsing its own text.
    ['const kvmFacts = kvmDoctorFacts(kvmStatus())', 1],
    ['kvmUsable: kvmFacts.kvmUsable,', 1],
    // The floors produce warnings, and the requested sizes are not clamped.
    ['const warnings = windowsCapacityWarnings({ diskGb, memory, cpu })', 1],
    ['warnings,', 2],
    ['const diskGb = given.disk ? spec.diskGb : WINDOWS_DEFAULT_DISK_GB', 1],
    // Y1: the virgl decision is made once and stored on the row.
    ["const virgl = spec.gpu === true && systemQemuSupportsVirgl() && existsSync('/dev/dri/renderD128')", 1],
    ['      virgl,', 1],
    // D5: an aborted shutdown rebuilds the live view instead of relaying to a
    // dead websockify.
    ['async function replaceLiveView(name, preview)', 1],
    // D7: a rejected relay kills the websockify it spawned.
    ['stopLiveView(name)\n      throw error', 1],
    // D9: the port claim is serialised and tracked in memory, and a failed
    // create releases EXACTLY its own three ports (`Object.values` of a Set is
    // [], which made the first version a no-op).
    ["withLock('@ports'", 1],
    ['const CLAIMED_WINDOWS_PORTS = new Set()', 1],
    ['for (const port of Object.values(portTriple ?? {})) CLAIMED_WINDOWS_PORTS.delete(Number(port))', 1],
    // R1: a KEPT item (the disk of a live QEMU) is not a completed delete, and
    // the row keeps it reachable until GC can reclaim it.
    ["const skipped = items.filter((item) => item.status === 'skipped')", 1],
    ['skipped.length === 0 && sandboxGone', 1],
    ['kept: skipped.map', 1],
    ['would reclaim the kept disk', 1],
    // R2: the registry write is a manifest step, so it cannot throw out of it.
    ["await step('registry.json'", 1],
    // R3: the boot/timer paths cannot die on a corrupt registry.
    ['windows: install watches were NOT resumed', 1],
    ['idle: registry unreadable', 1],
    // F1/F2: QEMU'S STDERR REACHES THE ROW, THE LOG AND THE ERROR — and the
    // early-death watchdog flips the row to `error` on its FIRST short tick
    // instead of waiting out the 60-minute install timeout.
    ['function windowsQemuStderrTail(name, lines = 20)', 1],
    ['function windowsEarlyDeathWindowMs()', 1],
    ["DSH_CUA_WINDOWS_EARLY_CHECK_MS", 1],
    // N1's second half: the same unset→0 trap in the watchdog's first tick.
    ['const raw = process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS', 1],
    ["if (raw !== undefined && raw !== '') {", 1],
    ['first ? windowsEarlyDeathWindowMs() : 15000', 1],
    ["const errorText = `${why}", 1],
    ['the Windows computer did not start:', 1],
    ['row.errorLog = errorLog', 1],
    ['died before it could install', 1],
    ['const stderrTail = windowsQemuStderrTail(name, 20)', 2],
    ['row.errorLog = stderrTail.slice(-4000)', 1],
    // F3: the row records the degraded display, and the create answer carries it.
    ['const gpuFallback = booted?.gpuFallback === true', 1],
    ['virgl: gpuFallback ? false : virgl,', 1],
    // F4: a row that never got an install sentence still answers with one.
    ['the last start attempt did not reach a guest', 1],
    ['meta.state === \'error\' && typeof meta.error === \'string\'', 1],
    // B1: THE ROW STORES THE REQUESTED SPEC. `vmCreate` (the panel's path, not
    // `vmWindowsCreate`) used to lose the "was this given?" flags, so a Windows
    // create read "nothing was given" and wrote 64 GB / 6 GB over a 20 GB / 4 GB
    // request. These lines are the fix; the floors stay warnings.
    ['spec.diskGiven = Number(input.diskGb) > 0', 2],
    ['spec.memoryGiven = Number(input.memory) > 0', 2],
    ['const diskGb = given.disk ? spec.diskGb : WINDOWS_DEFAULT_DISK_GB', 1],
    ['requested: { diskGb, memory, cpu }', 1],
    // B2: THE PROGRESS SENTENCE HAS ONE FORMATTER, shared by the watcher and the
    // status payload. The old inline template interpolated a raw `endpoint`
    // (undefined) and `status || 'not running'`.
    ['formatWindowsInstallDetail({ phase: \'install\', verdict, elapsedMinutes, serialTail })', 1],
    ['const installDetail = state === \'ready\'', 1],
    ['installDetail,', 1],
    // B3: THE INSTALLING PAYLOAD CARRIES THE SERIAL TAIL AND THE READINESS
    // SIGNALS, so the panel and the tool both answer "how do I know it finished"
    // without a second call. Reading is a SMALL tail, not the whole file.
    ['serialTail: showInstall ? serialTail : [],', 1],
    ['const serialTail = windowsProgressTail(name, Math.max(1, Math.min(5, Number(tail) || 20)))', 1],
    ['function windowsProgressTail(name, lines = 5)', 1],
    ['readiness: windowsReadinessSignals(name),', 1],
    ['row.serialTail = serialTail', 2],
    // D3/D5: DONE-DETECTION HAS A SECOND SIGNAL, AND THE DEADLINE FOLLOWS THE
    // STAGE. A booted disk with no SSH is "firstboot failed", not "the install
    // did not finish" — and the panel says so in the exact words the user asked
    // for. Both calls (watcher + status poll) read the same serial signal.
    ['function windowsInstallSshGraceMinutes()', 1],
    ['const bootedAtMs = Date.parse(meta.bootedAt || \'\')', 2],
    ['windowsBootedFromDisk(', 3],
    ['const overDeadline = bootedStage ? bootedMinutes > sshGraceMinutes : elapsedMinutes > timeoutMinutes', 1],
    ['the installed disk never booted', 1],
    ["row.installStage = 'booted'", 2],
    ['installStage: bootedStage ? \'booted\' : \'installing\',', 2],
    ['WINDOWS_SSH_MISSING_DETAIL', 2],
    // D2: THE READY TRANSITION EJECTS. One helper, called from the watcher AND
    // from the status poll (a panel can see ready first), guarded by
    // `installMediaDetached` so it is a once-only action.
    ['async function detachWindowsInstallMedia(name)', 1],
    ['await detachWindowsInstallMedia(name)', 2],
    ['freshRow.installMediaDetached = failed.length === 0', 1],
    // ...and only when nothing failed, so a QMP that did not answer is retried
    // (rate-limited) instead of leaving the media attached for the session.
    ['const lastAttempt = Date.parse(row.installMedia?.at || \'\') || 0', 1],
    // A row that says `installing` with no process is STUCK: the state is not
    // rewritten to `stopped`, so the panel keeps offering the one action that
    // resolves it (Force delete).
    ['const stuck = meta.state === \'installing\' && !verdict.alive', 1],
    ['stuck,', 1],
    // ADD-ON 1: A WINDOWS ROW HAS NO CUA SANDBOX, so the manifest must not run
    // `sb rm` for it — that failure is the user's "Partially deleted win-test —
    // failed: sb rm --force". The kind is read BEFORE anything is removed.
    ['const isWindows = subject?.kind === \'windows\' || subject?.backend === \'qemu\'', 1],
    ['if (isWindows) {', 1],
    ['a Windows computer has no cua sandbox (direct QEMU: its disks and its row are removed below)', 1],
    // ...and the skipped step is INFORMATIONAL: not a failure, not a kept disk,
    // so the manifest can be COMPLETE.
    ["record('sb rm --force', 'not-applicable'", 1],
    // ADD-ON 2: FORCE DELETE IS A VERIFIED KILL *BEFORE* THE MANIFEST. The kill
    // is recorded first, so the order is visible in the answer.
    ['if (force === true) {', 1],
    ['await windowsBackend.forceKill(name, { waitMs: 5000 })', 1],
    ['force: forced.requested ? { requested: true, killed: forced.killed } : undefined', 1],
    ['canForce: complete ? undefined : true', 1],
    ['async vmDelete({ name, force = false } = {})', 1],
    ['async destroy({ name, force = false } = {})', 1],
    ['force: force === true', 1]
    ,
    // WP-4: THE dsh-cua BRIDGE BINDS BY NAME, AND THE STREAM IS A REAL STREAM.
    ["async vmWindowsMcp({ name = '' } = {})", 1],
    ['name is required; the bridge binds to one Windows computer, not the first ready row', 1],
    ["async vmWindowsMcpState({ name = '' } = {})", 1],
    ["async subscribe({ events = ['vm-state'], socket = null } = {})", 1],
    ["function emitVmState(name, state, reason = '')", 1],
    ["function emitVmRemoved(name, reason = '')", 1],
    ["function publishRegistryChanges(before, registry, reason = 'registry')", 1],
    // the QMP watcher feeds the same bus, so a stop/start pair cannot be lost
    ['function installQmpStateWatcher(name)', 1],
    ['function mapQmpStateEvent(event)', 1],
    // WP-7: THE LIVE VIEW PREFERS THE RFB+CLIPBOARD BRIDGE, AND MUST FALL BACK.
    ['async function startConsoleBridge(name, vncPort)', 1],
    ['async function ensureWindowsConsoleRelay(name)', 1],
    ['cua-vnc-clip.mjs', 2],
    // WP-9.1: THE MEASURED GROW — no `|| true`, and a short grow is a REFUSAL.
    ['function parseGuestDf(stdout)', 1],
    ['short-grow', 1],
    ['guest-resize-failed', 1],
    ['guest-growpart-failed', 1],
    // WP-9.3/WP-9.4: the doctor's honest facts (no silent "works").
    ['gpuDegraded', 2],
    ['linux-checkpoint-layout', 1],
    ['9p-share-not-attached', 1],
    ['provenance', 2],
    // WP-8: an effect is a READ-BACK, and a stale capture is a refusal.
    ['function captureIdFor(name, pngBytes, width, height)', 1],
    ['function latestCapture(name)', 1],
    ['stale-capture', 1],
    ["verified: changed ? 'confirmed' : 'unverifiable'", 1],
    // J1-4: THE PREFLIGHT FOLLOWS THE FIRMWARE, NOT THE VERSION'S AGE. It used
    // to demand qemu + OVMF (both files) + swtpm from EVERY Windows create, while
    // the backend boots a seabios entry (7u) on pc/SeaBIOS with no pflash and no
    // TPM: a host that could run Windows 7 was refused for two files the boot
    // spec never opens. The required set comes from the SAME firmware profile.
    ["const requiredCaps = firmware.bios === 'seabios' ? ['qemu'] : ['qemu', 'ovmfCode', 'ovmfVars', 'swtpm']", 1],
    ['const firmware = windowsFirmwareProfile(spec.windowsVersion)', 1],
    // J20-1c: `DSH_CUA_VNC_CLIP_POLL_MS` WAS DOCUMENTED, NEVER PASSED. The bridge
    // has its own 1200 ms default, so the written interval and the real one could
    // disagree silently. Read here, clamped to 200–60000 ms, rounded to an
    // integer, and passed to the bridge on `--poll-ms`.
    ['function vncClipPollMs()', 1],
    ['const VNC_CLIP_POLL_MIN_MS = 200', 1],
    ['const VNC_CLIP_POLL_MAX_MS = 60000', 1],
    ['DSH_CUA_VNC_CLIP_POLL_MS', 1],
    ["'--poll-ms', String(vncClipPollMs())", 1],
    // J22-8: THE KIND IS READ FROM THE READY LINE, NOT ASSUMED. An image without
    // noVNC used to serve a WS-only bridge the panel rendered as a 404 page, with
    // a clipboard triple claiming a channel the page did not have.
    ['const BRIDGE_KIND_LINE = /\\[cua-vnc-clip\\]\\s+(novnc-clip(?:-bare)?)\\s+on\\s+\\S+/u', 1],
    ["const kindKnown = kind === 'novnc-clip' || kind === 'novnc-clip-bare'", 1],
    ['&& !(await portIsFree(httpPort))', 1],
    // J22-7: A SIGTERM MUST TAKE THE LIVE VIEWS WITH IT. `server.close()` closes
    // the unix socket and nothing else; the websockify/bridge children kept their
    // loopback ports, so the next process lost the port race or relayed to a
    // bridge whose supervisor socket was gone.
    ['const SHUTDOWN_LIVE_VIEW_DEADLINE_MS = 2000', 1],
    // P4: A GUEST-INITIATED SHUTDOWN IS OBSERVED, not inferred. A 3 s
    // query-status poll turns `shutdown` into powered-off with the SAME checkpoint
    // + restore-source bookkeeping the ACPI path uses (`method: guest-shutdown`),
    // and `paused` into suspended (reversible; never a checkpoint of a live disk).
    ['const QMP_STATE_POLL_DEFAULT_S = 3', 1],
    ['function qmpStatePollMs()', 1],
    ['DSH_CUA_VM_STATE_POLL_S', 1],
    ['function startQmpStatePoll(name)', 1],
    ['const watcher = startQmpStatePoll(name)', 1],
    // C21/A-5: ONE Windows capture lane. The sync `windowsCheckpointPlan` is
    // DELETED (a needle satisfied by a corpse is a false green); the deferred
    // planner is the only planner, and it awaits its child.
    ['async function windowsCheckpointPlanDeferred(name, config)', 1],
    ['async function finaliseGuestShutdown(name, { status = \'\', clean = false } = {})', 1],
    ['async function finaliseGuestPause(name, status)', 1],
    ['method: \'guest-shutdown\'', 1],
    ["{ reason: 'guest-shutdown' }", 1],
    // P5: THE SHUTDOWN ANSWERS FIRST. The op used to run the whole disk convert
    // SYNCHRONOUSLY before it answered, so a 10 GB guest wedged the harness tool
    // call and the panel's button for minutes — on a computer the row already
    // said was powered off. The order is now: a BOUNDED QMP phase (8 s, of which
    // 5 s is the handshake), the row write, the answer, then a DETACHED convert
    // that upgrades `restoreFrom`. The needles below pin each piece by name; the
    // order itself is asserted in the semantic block (P5).
    ['const WINDOWS_STOP_BUDGET_MS = 8000', 1],
    ['const WINDOWS_STOP_QMP_MS = 5000', 1],
    ['async function windowsStopPhase(meta)', 1],
    ['function continueWindowsStopInBackground(name, meta, config, method)', 1],
    ['async function recordWindowsPoweredOff(name, { method, config, forced = false, installInProgress = false } = {})', 1],
    ['function scheduleDeferredWindowsCheckpoint(name, token, config)', 1],
    // the pending marker is the TOKEN-GUARDED handshake between the answer and
    // the detached task: a row restarted while the convert ran is not resurrected.
    ['row.checkpointPending = { token, at }', 1],
    ['if (row.checkpointPending?.token !== token) return', 1],
    ['await new Promise((resolve) => setImmediate(resolve))', 1],
    // the DETACHED capture awaits its child instead of blocking the event loop
    // (`execFileSync` froze every status beat, the state stream and every other
    // computer's poll for the whole convert).
    ['async function checkpointDiskFileAsync(name, disk)', 1],
    ['await runCaptureCommand(qemuImgPath(), [\'convert\', \'-O\', \'qcow2\', disk, `${target}.tmp`], 600000)', 1],
    // the answer carries the WORD, never a path that cannot exist yet
    ['checkpoint: status,', 1],
    ["checkpointDeferred: status === 'deferred' || undefined", 1],
    ["const status = policySkip === null ? 'deferred' : `skipped:${policySkip.record.reason}`", 1],
    // P6: the guest-shutdown path is STATE-FIRST. A tick that fails must log once
    // a minute and be RE-ARMED, never die: it is the only observer of a guest
    // power-off.
    ['const STATE_POLL_ERROR_LOG_MS = 60000', 1],
    ['const noteTickFailure = (error) => {', 1],
    ['noteTickFailure(error)', 1],
    ["row.stateFrom = 'qmp-poll'", 2],
    ['const QMP_CONNECT_TIMEOUT_MS = 2000', 1],
    ['function qmpCommands(port, commands, { timeoutMs = null, defaultTimeout = null, connectTimeoutMs = QMP_CONNECT_TIMEOUT_MS, host = \'127.0.0.1\' } = {})', 1],
    ['const fallbackTimeout = Number(defaultTimeout) > 0 ? Number(defaultTimeout) : 0', 1],
    ['const connectTimeout = Number(connectTimeoutMs) > 0 ? Number(connectTimeoutMs) : QMP_CONNECT_TIMEOUT_MS', 1],
    // R7: the relay is opened right after the row write, non-fatally, so
    // /vm/port/<name>/ serves for the whole install (it used to exist only at ready).
    ['const relayed = await ensureWindowsConsoleRelay(spec.name)', 1],
    ['live view is not up yet (the display has not answered); the install watcher retries at ready', 1],
    ['function sweepLiveViews()', 1],
    ['const children = sweepLiveViews()', 1],
    // J22-12: A REOPENED RELAY KEEPS ITS CAPABILITIES. A relay is transport only;
    // reopening it with neither `view` nor `clipboard` erased both from ports.json,
    // and the panel's paste controls went dead after a shutdown that FAILED. The
    // triple is recomputed from the recorded front door by the same rules a fresh
    // ensure uses.
    ['function relayCapabilities(snapshot = {}, rawVncPort = 0)', 1],
    ['const capabilities = relayCapabilities(snapshot, rawVncPort)', 1],
    ['view: capabilities.view, clipboard: capabilities.clipboard', 1],
    ['const CLIPBOARD_NO_VIEW_REASON', 1],
    ['const CLIPBOARD_RAW_VNC_REASON', 1],
    // WP-10: THE scp PORT BUG (`scp: stat local "47000"`).
    // ssh's port flag is `-p PORT`; scp's `-p` means "preserve times/modes" and
    // takes NO VALUE, so reusing sshBaseArgs made the port a POSITIONAL — a
    // source file. The chain below is the fix: ONE shared option list, a
    // dedicated scpBaseArgs with `-P`, a direction-driven positional pair, and a
    // builder that owns the whole argv. `tools/scp-argv-check.mjs` drives this
    // real path against stub binaries and parses the recorded argv.
    ['const WINDOWS_SSH_OPTS = [', 1],
    ["scp takes `-P PORT` (CAPITAL)", 1],
    ['function scpBaseArgs(meta)', 1],
    ["'-P', windowsSshPort(meta)", 1],
    ['export function buildScpArgv(meta, localPath, guestPath, { direction } = {})', 1],
    ["const tail = direction === 'from-guest' ? [remote, local] : [local, remote]", 1],
    ["return ['-q', ...scpBaseArgs(meta ?? {}), ...tail]", 1],
    ['const args = buildScpArgv(meta, localPath, guestPath, { direction })', 1],
    ['scp: stat local "47000": No such file or directory', 1],
    // The two binaries are test hooks ONLY: a stub records argv so the shape can
    // be asserted without a guest. Nothing in production sets either one.
    ['const SSH_BIN = process.env.DSH_CUA_SSH_BIN', 1],
    ['const SCP_BIN = process.env.DSH_CUA_SCP_BIN', 1],
    ['scpRun(putMeta, source, assertWindowsGuestPath(guest), { direction: \'to-guest\', timeoutMs })', 1],
    ['scpRun(getMeta, absolute, assertWindowsGuestPath(guest), { direction: \'from-guest\', timeoutMs })', 1],
    // WP-4 / SOL §7: THE SUPERVISOR'S RELAY RE-ASSERT.
    //
    // The SYNC MATRIX promised this needle and the gate did not have it: WP-4
    // shipped `windowsRelayReassert()` and a fire-and-forget call at each ready
    // transition, and NOTHING here would have noticed if it were deleted — the
    // bridge would simply be blind again after a checkpoint boot while every
    // other assertion stayed green. Three facts, each a revert's target:
    //
    //   * the ONE command: `schtasks /run /tn cua-mcp-host`. No probe, no task
    //     re-creation — repairing the payload is WP-1/WP-2's job, and a
    //     supervisor that "helped" would duplicate the handshake-before-/run
    //     ordering (the 10048 lesson);
    //   * the 15 s throttle (`S3`): three Starts in ten seconds cost ONE ssh
    //     child. Removing the interval turns every retry into a guest command;
    //   * the log line the JURY reads (`S1`): `relay re-assert: cua-mcp-host
    //     exit <code>`. Without it the re-assert is unobservable, which is the
    //     "auto-start PASS" that started this whole SOL.
    //
    // TEST COVERAGE (landed — this needle no longer waits for it):
    // `tests/modules-unit.mjs` drives the REAL function through a loader-appended
    // export line (no production byte changes) and asserts S1 (one ssh child, the
    // exact `schtasks /run /tn cua-mcp-host` argv, the `exit 0` log sentence, the
    // 20 s/15 s constants), S2 (paused / off / booting / installing / ssh:false /
    // non-Windows / missing rows spawn nothing, and a row powered off BETWEEN the
    // transition and the call is a no-op because the row is re-read), S3 (three
    // same-tick calls cost one child; the next call after the window costs one
    // more) and S4 (non-zero exit, ENOENT and a hung child never throw). This gate
    // proves the facts are PRESENT; the suite proves the behaviour above them.
    ["const WINDOWS_RELAY_REASSERT_COMMAND = 'schtasks /run /tn cua-mcp-host'", 1],
    ['const WINDOWS_RELAY_REASSERT_INTERVAL_MS = 15000', 1],
    ['relay re-assert: cua-mcp-host exit ${result.code}', 1],
    ['async function windowsRelayReassert(name)', 1],
    // S2: the row is RE-READ and gated (`kind`, `ssh`, `state`) before a child
    // exists; a suspended/powered-off row must spawn nothing.
    ['if (meta.ssh === false) return', 1],
    ['if (meta.state !== \'ready\') return', 1],
    // ...and every ready transition fires it UN-AWAITED (3 call sites), so a
    // failed re-assert can never turn a successful Start into an error.
    ['void windowsRelayReassert(name)', 3],
    // C19: THE CREATE PATH WALKS THE CHAIN. Before this, `resolveWindowsIso()`
    // (static-only, by design) was the create path and `ensureIsoForSource()`
    // had NO caller outside its own module — the mido implementation was dead
    // code and every create booted a third-party mirror.
    ['resolveWindowsIsoSources(spec.windowsVersion)', 1],
    ['await ensureIsoForSource(sources, {', 1],
    // C19b: THE QUOTA GUARD MUST NAME THE FILE THE TAKEN BRANCH WILL WRITE.
    // The static mirror's target and mido's are different objects with different
    // cache names, so the plan is made (and its head resolved) BEFORE the
    // reservation, and the probe reads the plan's URL — not the mirror's.
    ['planWindowsIsoChain(sources, { log })', 1],
    ['const url = chainTarget !== null ? chainTarget.url', 1],
    ['isoSourceId', 2],
    ['DSH_CUA_WINDOWS_ISO_MIDO', 1],
    // C4/C18: the two computed facts ride the SAME decorate pass as staleness.
    ['row.holds = stateHolds(row.state)', 1],
    ['row.health = computerHealth(name, row, facts)', 1]
  ],
  space: [
    ['export const CAPTURE_MAX_PIXELS = 900_000', 1],
    ['export const SPACE_CACHE_MS = 30_000', 1],
    ['export function pngSize(bytes)', 1],
    ["readUInt32BE(16)", 1],
    ['export function formatSpace(space)', 1],
    ['export function formatSpaceWarning(space)', 1],
    ['image px = ${inverse} × display px; cua maps it — do not rescale', 1],
    ['export function relativeToPixels(space, x, y)', 1],
    ['export function toDisplayPixels(space, x, y)', 1],
    ['export function resolutionProblem(resolution', 1],
    ['DSH_CUA_VM_RESOLUTION_ALLOW_SCALE', 1]
  ],
  /**
   * THE WINDOWS BACKEND IS DIRECT QEMU. Every entry below is a fact the boot
   * depends on: a missing firmware path, a mis-derived VNC display, a missing
   * `-device usb-tablet` (absolute pointer) or a published QMP socket is a
   * computer that boots and cannot be driven.
   */
  /**
   * THE DEVICE SPLIT. `/dev/kvm` mounted is not `/dev/kvm` usable: the container
   * runs as uid 1000 while the host node is normally root:kvm 0660, and the old
   * probe (`statSync(...).isFile()`, false for a character device) reported a
   * MOUNTED device as absent. These needles pin the two cases apart, because
   * collapsing them again re-creates the user's bug: one sentence, wrong advice.
   */
  kvm: [
    // one module, one implementation, imported by both backends
    ["export const KVM_DEVICE = process.env.DSH_CUA_KVM_DEVICE || '/dev/kvm'", 1],
    ['export function kvmStatus(options = {})', 1],
    ['export function kvmPreflightError(status, { purpose', 1],
    ['export function deviceNodePresent(file, stat = statSync)', 1],
    ['export function regularFilePresent(file, stat = statSync)', 1],
    // the states are named, not inferred
    ["['ok', 'missing', 'denied', 'not-device']", 1],
    // presence is a CHARACTER DEVICE, and access is a real syscall
    ['isCharacterDevice()', 1],
    ['accessSync', 1],
    ['fsConstants.R_OK', 1],
    // the denial message quotes the observation and the fix
    ['(uid:gid)', 1],
    ['this process is ', 1],
    ['supplementary groups ', 1],
    ['GROUP/GID problem, not a missing device', 1],
    ['stat -c %g /dev/kvm', 1],
    ['group_add:', 1],
    ['KVM_GID', 1],
    // the missing message keeps the old instruction (never delete a needle)
    ['needs /dev/kvm (compose.emulator.yaml)', 1],
    ['does not exist in this container (ENOENT)', 1],
    // the doctor cannot say "usable" about a denied device
    ['export function formatKvmStatus(status)', 1],
    ['export function kvmDoctorFacts(status)', 1]
  ],
  windows: [
    // direct qemu, no container runtime
    ["export const WINDOWS_QEMU = process.env.DSH_CUA_WINDOWS_QEMU || '/usr/bin/qemu-system-x86_64'", 1],
    ['export function windowsHostCaps()', 1],
    // K7: a device node is not a file, and presence is not access.
    ['kvmUsable: kvm.state === \'ok\'', 1],
    ['kvm: deviceNodePresent(KVM_DEVICE) || kvm.exists', 1],
    ['export function windowsKvmPreflight()', 1],
    ['const kvmError = windowsKvmPreflight()', 1],
    // firmware: shared OVMF code + a per-computer vars store
    ["export const OVMF_CODE = process.env.DSH_CUA_WINDOWS_OVMF_CODE || '/usr/share/OVMF/OVMF_CODE_4M.fd'", 1],
    // J1-3: EVERY INTERPOLATED PATH GOES THROUGH THE COMMA ESCAPE. QEMU's own
    // QemuOpts splitter cuts an option value on commas, and `,,` is the only
    // escape that works there (quoting does not: the splitter runs before any
    // shell-like parsing). An operator medium named `win11,beta.iso`, or a store
    // path with a comma, used to hand QEMU `file=win11` plus a mystery option.
    // The needles below pin the ESCAPED form on all four file=/path= sites — the
    // unescaped spelling is the bug.
    ['if=pflash,format=raw,readonly=on,file=${qemuEscapeOptionValue(OVMF_CODE)}', 1],
    ['if=pflash,format=qcow2,file=${qemuEscapeOptionValue(p.efiVars)}', 1],
    // ...and the one function every interpolation calls, exported so a test can
    // prove the escaping without a QEMU.
    ['export function qemuEscapeOptionValue(value)', 1],
    ["return String(value ?? '').replace(/,/gu, ',,')", 1],
    // TPM2 via swtpm on a unix socket
    ["export const SWTPM = process.env.DSH_CUA_WINDOWS_SWTPM || '/usr/bin/swtpm'", 1],
    ['-chardev', 1],
    ['tpm-crb,tpmdev=tpm0', 1],
    ['--ctrl', 1],
    // kvm + host cpu, and the q35 machine
    // WP-2: the machine SPEC comes from the firmware profile now, so the
    // literal 'q35,accel=kvm,smm=off' alone could never appear again. The
    // needle is the ONE expression both profiles flow through; the semantic
    // assertion below proves '11' still gets q35+smm=off and '7u' gets pc.
    ['const machine = legacyBios ? `${firmware.machine},accel=kvm` : `${firmware.machine},accel=kvm,smm=off`', 1],
    ["'-machine', machine,", 1],
    ["'-cpu', 'host'", 1],
    // disks: plain qcow2 (checkpointing still applies)
    ['file=${qemuEscapeOptionValue(p.disk)},if=none,id=disk0,format=qcow2,cache=writeback,discard=unmap', 1],
    // R4: THE BOOT ORDER FOLLOWS THE PHASE. The old argv always put the disk at
    // bootindex 1 and the CD at 2 while its comment claimed the ISO booted
    // first: OVMF created Boot0002 for the unbootable HDD, tried it, said "HDD
    // Not Found", then reached the DVD — a wasted boot cycle per install, and
    // the reason cdboot's 5 s "Press any key" window was entered late.
    ['const diskBootIndex = boot ? 2 : 1', 1],
    ['ide-cd,drive=cd0,bus=ide.1,bootindex=1', 1],
    // install medium while installing, drivers ISO when present
    ['if=none,id=cd0', 1],
    // S1: THE ANSWER-FILE DISK REPLACED THE vvfat USB STICK. dockur/windows'
    // mechanism: a FAT32 HARD-DISK image whose root holds Autounattend.xml,
    // attached AFTER the system disk. `ide.2` is the first slot after the qcow2
    // on ide.0, so Windows still sees the qcow2 as Disk 0 (DiskID 0).
    // The old `file=fat:ro:${p.oemDir}` + usb-storage pair is GONE — Setup did
    // not reliably enumerate that stick, which is why a human had to click
    // through Setup. Never reintroduce it.
    //
    // F1/M9: THE MEDIUM IS WRITABLE **AND REMOVABLE**. This needle used to
    // require `readonly=on` (the OLD OEM stick's write protection) and then the
    // writable `ide-hd` shape. QEMU 10 rejects a read-only node behind ide-hd
    // ("Block node is read-only"), and — the live forensic finding — Setup
    // never scans a FIXED-disk root for Autounattend.xml, so an ide-hd attach
    // can never be read however correct the image is. The needle class is
    // RETARGETED, never deleted: it now pins the writable setup0 drive behind
    // usb-storage with `removable=on`, and the semantic assertion below rejects
    // ANY `readonly=on` reappearing on this drive and any `ide-hd` setup0 form.
    ['file=${qemuEscapeOptionValue(p.setupImg)},format=raw,if=none,id=setup0', 1],
    ['usb-storage,drive=setup0,removable=on,bus=xhci.0', 1],
    ["setupImg: path.join(dir, 'setup.img')", 1],
    ['export function buildSetupImage(', 1],
    ['export function verifySetupImage(', 1],
    ['export const SETUP_IMAGE_ENTRIES = Object.freeze([', 1],
    ["export const SETUP_IMAGE_LABEL = 'SETUP'", 1],
    ['export function answerFileDiskIds(xml)', 1],
    ['export function assertAnswerFileTargetsSystemDisk(', 1],
    ['export function normaliseProductKey(value)', 1],
    // F1: THE ANSWER DISK IS A PARTITIONED DISK. A partitionless FAT32
    // superfloppy is mounted by the FIRMWARE and by nothing else: Windows
    // enumerates fixed disks through their partition table, so WinPE never
    // mounted setup.img and the install fell back to the interactive language
    // screen. These needles pin the MBR + the LBA-2048 partition, and pin every
    // mtools call to the partition's BYTE OFFSET (`-i img@@offset`, mtools
    // 4.0.48 syntax) instead of the whole image.
    ['export const SETUP_PARTITION_START_LBA = 2048', 1],
    ['export const SETUP_PARTITION_OFFSET_BYTES = SETUP_PARTITION_START_LBA * SETUP_SECTOR_BYTES', 1],
    ['export const SETUP_PARTITION_TYPE = 0x0c', 1],
    ['export function setupVolumeSpec(imagePath)', 1],
    ['export function setupMbrSector({', 1],
    ['export function writeSetupMbr(imagePath)', 1],
    ['export function readSetupMbr(imagePath)', 1],
    ["sector[entry + 4] = SETUP_PARTITION_TYPE", 1],
    ['sector.writeUInt32LE(startLba, entry + 8)', 1],
    ['sector[SETUP_MBR_SIGNATURE.offset] = SETUP_MBR_SIGNATURE.bytes[0]', 1],
    ['const volume = setupVolumeSpec(p.setupImg)', 2],
    ["run(MTOOLS.format, ['-i', volume, '-F', '-H', String(SETUP_PARTITION_START_LBA), '-v', SETUP_IMAGE_LABEL, '::'])", 1],
    ["run(MTOOLS.copy, ['-i', volume, '-s', ...staged, oemTree, '::'])", 1],
    ["execFileSync(MTOOLS.dir, ['-i', volume, '-b', spec]", 1],
    ["if (mbr.signature !== '55aa')", 1],
    ['const mbr = readSetupMbr(p.setupImg)', 1],
    ['mdir', 1],
    // S2: the byte compare is part of the build, not a comment.
    ['staged.equals(fromImage)', 1],
    // S3: optional product key, never shown by Setup.
    ['{{PRODUCT_KEY}}', 1],
    ['WillShowUI>Never', 1],
    // F2: THE EDITION IS NAMED IN THE ANSWER FILE. Without <InstallFrom> Setup
    // stops at "Select the operating system you want to install" — the second
    // interactive stop after the language page. The name is pinned to the value
    // VERIFIED from the pinned 11ltsc ISO's own WIM XML (single image,
    // INDEX 1, NAME "Windows 11 IoT Enterprise LTSC 2024 Evaluation").
    ['{{IMAGE_INSTALL}}', 2],
    // WP-2: DERIVED, NOT DUPLICATED — the table is built from the catalog, so
    // the hand-written map that still said `11ltsc` cannot drift again.
    ['export const WINDOWS_IMAGE_SELECTIONS = Object.freeze(Object.fromEntries(', 1],
    ["    key: '/IMAGE/NAME',", 1],
    ["    value: 'Windows 11 IoT Enterprise LTSC 2024 Evaluation',", 1],
    ['export function resolveWindowsImageSelection({', 1],
    ['export function imageInstallFromXml(selection)', 1],
    ['export function assertAnswerFileSelectsImage(xml)', 1],
    ['const selected = assertAnswerFileSelectsImage(stagedXml)', 1],
    ["if (metadata !== 1)", 1],
    // S4: dockur's hidden launcher shape (the launcher itself is asserted in
    // oemLauncher / oemSetup; the writer must copy it into $OEM$).
    ['Unattend.vbs', 2],
    // networking: SLIRP + the SSH forward (no bridge, no tap)
    ['user,id=net0,hostfwd=tcp:127.0.0.1:${spec.sshPort}-:22', 1],
    // The NIC follows the same profile as the disk and the firmware: a BIOS
    // guest gets e1000e (an inbox Windows 7 driver), never virtio.
    // P2: THE DEVICE CLASS IS ONE DECISION. Default is the profile's INBOX
    // hardware (ide-hd on q35 AHCI / e1000e) for EVERY code; virtio only when the
    // operator opts in with DSH_CUA_WINDOWS_VIRTIO=1 (an image that carries the
    // virtio-win drivers). The old `legacyBios ? ...` ternary made it a firmware
    // question, which is how a UEFI guest got a NIC with no inbox driver.
    ['const wantVirtio = String(process.env.DSH_CUA_WINDOWS_VIRTIO ?? \'\') === \'1\' && spec.virtio === true', 1],
    ['const diskDevice = wantVirtio ? \'virtio-blk-pci\' : firmware.disk', 1],
    ['const nicDevice = wantVirtio ? \'virtio-net-pci\' : firmware.nic', 1],
    ["'-device', `${nicDevice},netdev=net0`", 1],
    ['DSH_CUA_WINDOWS_VIRTIO', 1],
    // absolute pointer + keyboard: the QMP input path depends on both
    ["'-device', 'usb-tablet'", 1],
    ["'-device', 'usb-kbd'", 1],
    // VNC on loopback (the live view) and QMP on loopback (control)
    // B1: QEMU reads the value after the colon as a DISPLAY NUMBER (it binds
    // 5900+display), so the raw port must never be passed here.
    ["'-vnc', `127.0.0.1:${vncDisplayFor(spec.vncPort)}`", 1],
    ['tcp:127.0.0.1:${spec.qmpPort},server=on,wait=off', 1],
    ['export function vncDisplayFor(port)', 1],
    // D6: a failed boot stops the swtpm it started.
    ['stopSwtpm(spec.name)', 2],
    // the ISO sources are pinned and documented
    ['export const WINDOWS_ISO_SOURCES = Object.freeze(Object.fromEntries(', 1],
    // K2: TWO probed public URLs are pinned now — Server 2025 and Windows 11 IoT
    // Enterprise LTSC 2024 (both answered 206 to a live ranged GET); the rest
    // answer 400 and require `windowsIso`.
    ['software-static.download.prss.microsoft.com', 4],
    ['export function resolveWindowsIso(version)', 1],
    ['has no public direct ISO link', 1],
    // The LTSC source, its alias, and the fact that the alias is canonicalised.
    // WP-2: the code is `11l`, and its chain is an ARRAY (two Microsoft objects,
    // then the mirror pair), not the single pinned object of the five-version era.
    ["'11l': Object.freeze([", 1],
    ['CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso', 1],
    // The alias map is FROZEN and still answers every spelling the old list
    // accepted — `11ltsc` now canonicalises to `11l` instead of naming a code.
    ['export const WINDOWS_VERSION_ALIASES = Object.freeze({', 1],
    ["'11ltsc': '11l', ltsc11: '11l',", 1],
    ['export function canonicalWindowsVersion(version)', 1],
    // FLOORS ARE WARNINGS. The create must produce advice, never a clamp.
    ['export function windowsCapacityWarnings({ diskGb, memory, cpu })', 1],
    // U4: the free-space formatters live in THIS module (pure, unit-tested).
    ['export function parseFreeSpaceProbe(stdout)', 1],
    ['export function formatWindowsFreeSpace(bytes)', 1],
    ['export const WINDOWS_FREE_FLOOR_GB = 10', 1],
    ['disk-below-floor', 1],
    ['memory-below-floor', 1],
    ['Created anyway on request', 3],
    ['export async function ensureIso(', 1],
    // R3: the backend dials `qmp(host, port, cmds, opts)` and this process's one
    // QMP implementation is `qmpCommands(port, cmds, { timeoutMs, host })`. The
    // raw primitive used to be handed over, so the HOST arrived as the PORT, the
    // dial threw, and a running QEMU never reached `ready` ("QMP not answering"
    // forever). The adapter is the join; it must be the thing passed in.
    ['export function windowsQmpAdapter(primitive)', 1],
    ['export function windowsRowName(spec, fallback = \'\')', 1],
    // R1: cdboot's "Press any key to boot from CD or DVD" is pressed over QMP
    // during the install phase only — the window is 5 s and EFI_TIMEOUT lands
    // the firmware in the Internal Shell, a dead end.
    // R6: THE CDBOOT SCHEDULER IS PROMPT-ANCHORED, RE-ARMING AND HONEST.
    //
    // The live forensic child showed the fixed 1.5/3.5/5.5 s presses landing while
    // OVMF was still enumerating, i.e. BEFORE cdboot printed its prompt; and a
    // monitor REFUSING an event answers `{error}` as a RESULT, which the old code
    // logged as "pressed". Four numbers and one reader are the fix.
    ['export function cdbootPressFailure(result)', 1],
    ['export function cdbootPromptWindowMs()', 1],
    ['export function cdbootRearmCycles()', 1],
    ['export function cdbootRearmWatchMs()', 1],
    ['export function cdbootPressTimeoutMs()', 1],
    ['DSH_CUA_WINDOWS_CDBOOT_PROMPT_MS', 1],
    ['DSH_CUA_WINDOWS_CDBOOT_PRESS_MS', 1],
    ['DSH_CUA_WINDOWS_CDBOOT_CYCLES', 1],
    ['DSH_CUA_WINDOWS_CDBOOT_WATCH_MS', 1],
    // the call site: 90 s prompt window, growth anchor OFF, 12 re-arms inside a
    // 180 s watch, and a 3 s budget per press (the 15 s default burned the window
    // on one refusal).
    ['maxWindowMs: cdbootPromptWindowMs()', 1],
    ['armDelayMs: 0,', 1],
    ['cycles: cdbootRearmCycles()', 1],
    ['watchMs: cdbootRearmWatchMs()', 1],
    ['timeoutMs: cdbootPressTimeoutMs()', 1],
    // an unparsable knob falls back, and the refusal is logged as a MISS
    ['function cdbootNumber(name, fallback, min, max)', 1],
    ['if (!Number.isFinite(parsed)) return fallback', 1],
    ['could not press ${key} at ~${Math.round(at)} ms ${reason}', 2],
    // and the caller reads RESULT refusals too (kept: the boot path's own sweep)
    ['const refused = cdbootPressFailure(result)', 1],
    ['const refused = cdbootPressFailure(replies)', 1],
    // P1: THE MEDIA LEAVE WHEN SETUP FINISHES COPYING — not at READY, which
    // needs the SSH banner. A guest whose NIC has no driver never answers SSH, so
    // the row stayed `installing` with SETUP (D:) mounted for the session.
    ['export const WINDOWS_SETUP_COPY_DONE_PATTERN', 1],
    ['export function windowsSetupCopyFinished(serialText)', 1],
    ['export const WINDOWS_MEDIA_EJECT_POLL_MS = 15000', 1],
    ['export function windowsMediaEjectWatchMs()', 1],
    ['DSH_CUA_WINDOWS_EJECT_WATCH_MIN', 1],
    ['const startMediaWatcher = (mediaChild) => {', 1],
    // both boot paths arm it: the first attempt AND the GPU-fallback retry
    ['if (installPending) startMediaWatcher(first.child)', 1],
    ['if (installPending) startMediaWatcher(retry.child)', 1],
    ['install media detached after Setup finished copying (before SSH/MCP)', 1],
    // P2: the profile table now names INBOX hardware for BOTH firmwares.
    ["ovmf: Object.freeze({ machine: 'q35', bios: 'ovmf', tpm: true, efiVars: true, disk: 'ide-hd', nic: 'e1000e' })", 1],
    ['export function cdbootKeyScheduleMs()', 1],
    ['export async function runCdbootKeys({', 1],
    ['if (installPending && cdbootKeysEnabled() && child?.pid)', 1],
    // F2: THE ANCHOR IS SERIAL ACTIVITY, NOT THE SPAWN CLOCK. A fixed 1.5 s
    // press lands before OVMF has reached the CD; the prompt (or first output
    // + 1.5 s) is the event that actually opens the window.
    ['export const CDBOOT_PROMPT_PATTERN', 1],
    ['export function cdbootPromptSeen(text)', 1],
    ['export function readSerialTail(file, bytes = 8192)', 1],
    ['serialLog: p.serialLog', 1],
    // R5: belt and braces for the Shell fallback.
    ['export function startupNshText()', 1],
    ["writeFileSync(path.join(p.oemDir, 'startup.nsh'), startupNshText())", 1],
    ['export function writeOemPayload(', 1],
    // K2: the payload writer must NAME the files it needs (the error text and
    // this gate quote the same list), must resolve a directory that actually
    // holds all of them, and must fail with the actionable image message rather
    // than a bare path. Deleting any of these re-creates the user-facing bug:
    // "the OEM payload is missing from this image: <path>" with no way forward.
    ['export const OEM_PAYLOAD_FILES = Object.freeze(', 1],
    ['export function oemPayloadDir(dir)', 1],
    ['export function resolveOemSourceDir(candidates)', 1],
    ['throw oemPayloadMissingError({ sourceDir, fallbackDirs })', 1],
    ['docker compose exec seek-harness ls -l /usr/local/share/cua-vm/windows-oem/', 1],
    ['--build-arg WITH_VIRGL_QEMU=1', 1],
    ['docker compose -f compose.windows.yaml up -d --force-recreate', 1],
    // frames and input over QMP
    ["execute: 'screendump'", 1],
    ["execute: 'input-send-event'", 1],
    ["execute: 'system_powerdown'", 1],
    ["execute: 'quit'", 1],
    ['export function charToKey(char)', 1],
    ['export function generatePassword()', 1],
    ['export function frameSpace(png)', 1],
    ['export function windowsEnabled()', 1],
    // M8: virgl when the build has it, plain virtio-gpu otherwise.
    ['virtio-gpu-gl-pci', 1],
    ['egl-headless,rendernode=', 1],
    // F1: QEMU'S OWN STDERR IS CAPTURED. `-serial file:` is the GUEST console;
    // a QEMU that dies during init explains itself on stderr, which used to be
    // `stdio: 'ignore'` — the user's dead create then left no diagnosis on the
    // host at all. The fd goes to the child, and the path is a store file.
    ["qemuStderr: path.join(dir, 'qemu-stderr.log')", 1],
    ["const stderrFd = openSync(stderrFile, 'w')", 1],
    ["spawn(WINDOWS_QEMU, argv, { stdio: ['ignore', stderrFd, stderrFd], detached: true })", 1],
    ['export function qemuStderrExcerpt(stderr, lines = 20)', 1],
    ['export function qemuStderrReason(stderr)', 1],
    // F2: A DEAD INIT IS A FAILED START, DECIDED INSIDE THE SHORT WINDOW.
    ['export async function waitForQemuBoot({ child, pidFile, isAlive, windowMs = 15000, pollMs = 50 } = {})', 1],
    ['export function qemuBootWindowMs()', 1],
    ["DSH_CUA_WINDOWS_BOOT_SETTLE_MS", 1],
    // N1: UNSET IS NOT ZERO. `Number(env ?? '')` made an unset variable 0 and
    // `0 >= 0` accepted it, so the 15000 fallback was unreachable and the boot
    // window was 0 ms on every real host. The raw string is inspected first.
    ['const raw = process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS', 1],
    ["if (raw !== undefined && raw !== '') {", 1],
    ["if (pid > 0) {", 1],
    ["reason: pidFileInvalid ? 'pidfile-invalid' : 'timeout'", 1],
    ['export function qemuInitError(', 1],
    ["code: 'QEMU_INIT_FAILED'", 1],
    // F3: THE DISPLAY MAY DEGRADE; THE ACCELERATOR MAY NOT. The retry is the
    // gpu:false argv shape (plain VGA + -display none), it happens ONCE, and
    // the warning is a row-carried object with a stable code.
    ['export function classifyQemuInitFailure(stderr)', 1],
    ['hardware acceleration is not supported', 1],
    ["const canFallback = allowGpuFallback && first.display !== 'none' && kind !== 'kvm' && kind !== 'none'", 1],
    ['await attempt({ ...spec, gpu: false, virgl: false }', 1],
    ["code: 'gpu-fallback'", 1],
    ['virgl/EGL display unavailable on this host', 1],
    ['emulated VGA/WARP', 1],
    ['gpuFallback: true', 1],
    // The retry needs a LIVE TPM: the cleanup stopped swtpm when the first QEMU
    // exited, so a retry without restarting it dies on "Failed to connect to
    // socket" — a second failure that would look like the fallback itself.
    ['swtpm did not restart for the GPU-less retry', 1],
    // The watchdog asks the CHILD whether it exited, so "pidfile not written
    // YET" is never mistaken for "never".
    ['function childState(name)', 1],
    // F4: THE SENTENCE HAS TWO HONEST HEADLINES AND NO RAW FIELD.
    ['export function formatWindowsInstallDetail(', 1],
    ['QEMU not alive (see qemu-stderr.log tail)', 1],
    ['waiting for SSH on 127.0.0.1:', 1],
    ["return text.replace(/\\bundefined\\b/gu, 'unknown')", 1],
    // B2: the readiness probe resolves the ROW's port shape, and QMP has three
    // named states instead of an empty string that the panel read as "not
    // running". A live install must never be reported as dead.
    ['const qmp = !alive ? \'no qemu\' : status === \'\' ? \'not answering\' : status', 1],
    ['const ports = windowsPortsOf(spec)', 1],
    ['export function windowsPortsOf(spec)', 1],
    // K1: the controller appears in the argv list before the device that uses it
    // (the ORDER is asserted separately, below).
    ["'-device', 'qemu-xhci,id=xhci'", 1],
    // F2: A SHUTDOWN THE GUEST CAN ACTUALLY HONOUR.
    //
    // * A PAUSED machine does not run its ACPI handler, so `system_powerdown`
    //   was accepted and then nothing happened for the whole 120 s timeout.
    //   `cont` FIRST is the fix, and the ORDER is asserted semantically below.
    ['await qmpFor(spec, [{ execute: \'cont\' }], { timeoutMs: 5000 })', 1],
    ['const paused = state.status === \'paused\' || state.status === \'suspended\'', 1],
    // * A MID-INSTALL WinPE has no ACPI handler either: it gets a SHORT window
    //   and then `quit`, and the result says so, so the supervisor persists
    //   `mayBeTorn` instead of recording a clean restore point from a
    //   half-written disk.
    ['const installInProgress = rowState === \'installing\' || rowState === \'booting\'', 1],
    ['function installShutdownWindowMs()', 1],
    ['return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 30000) : 5000', 1],
    ['const waitMs = installInProgress ? installShutdownWindowMs() : Math.max(1000, timeoutMs)', 1],
    ['...(installInProgress ? { forced: true } : {})', 1],
    ['forced: true, installInProgress', 1],
    // D2: THE INSTALL MEDIA LEAVE THE RUNNING SESSION. The CD is `eject`ed and
    // the usb-storage stick is `device_del`ed at the READY transition, so a
    // finished computer shows only its system disk. The device id is explicit in
    // the argv because `device_del` addresses the QOM frontend, not the block
    // node; both names share one constant so the two namespaces cannot drift.
    ['export const INSTALL_MEDIA_DEVICE_IDS = Object.freeze({ cd: \'cd0\', setup: \'setup0\', setupDevice: \'setupusb\' })', 1],
    ['async function detachInstallMedia(rawSpec)', 1],
    ['await qmpFor(spec, [command], { timeoutMs: 5000 })', 1],
    ["execute: 'eject'", 1],
    ["execute: 'device_del'", 1],
    ['detachInstallMedia,', 1],
    // D3/D5: THE BOOT-FROM-HD SIGNAL AND THE TWO EXACT SENTENCES. The watcher's
    // deadline follows the stage, so "installed but SSH missing" can no longer
    // be reported as "the install did not finish".
    ['export const WINDOWS_HD_BOOT_PATTERN', 1],
    ['export function windowsBootedFromDisk(serialText)', 1],
    ['export function windowsInstallStageFromSerial(serialText)', 1],
    ['export const WINDOWS_BOOTED_DETAIL', 1],
    ['export const WINDOWS_SSH_MISSING_DETAIL', 1],
    ['export const WINDOWS_SSH_MISSING_MINUTES = 5', 1],
    // D1/H1: $OEM$ IS INERT WITHOUT THIS. Both the element and the assertion
    // that refuses a staged answer file without it (the reported WSH dialog).
    ['export function assertAnswerFileUsesConfigurationSet(xml)', 1],
    ['assertAnswerFileUsesConfigurationSet(stagedXml)', 1],
    ['export function assertAnswerFileFirstbootLayers(xml)', 1],
    ['assertAnswerFileFirstbootLayers(stagedXml)', 1],
    ['export const FIRSTBOOT_FALLBACK_COMMAND', 1]
    ,
    // WP-6: THE CLIPBOARD AGENT IS PAYLOAD, AND IT HAS ITS OWN SOURCE CHAIN.
    // The on-demand schtasks pair stays the fallback; the agent is the fast,
    // VERIFIED path (it hashes what it put on the clipboard and echoes `equal`).
    ["export const OEM_CLIP_AGENT_FILE = 'cua-clip-agent.ps1'", 1],
    ['export function resolveOemClipAgentSource(candidates = [])', 1],
    ['export function clipAckMatches(expected = {}, ack = null)', 1],
    ['export function clipSha256(text)', 1],
    ['const CLIP_AGENT_STALE_MS = 5000', 1],
    // J21-2: THE VERDICT CARRIES THE REASON. `clipAckMatches` is the boolean
    // half; the backend needs to tell an agent that reported its own failure
    // (`agent-error:<code>`) from a digest/seq mismatch, because the two send an
    // operator to different places. The caller now RETURNS the verdict's reason
    // and detail instead of re-spelling `ack-mismatch` at every site.
    ['export function clipAckVerdict(expected = {}, ack = null)', 1],
    ['function clipAgentErrorCode(ack = {})', 1],
    ["return { ok: false, reason: `agent-error:${clipAgentErrorCode(ack)}`", 1],
    ['if (!verdict.ok) return { ok: false, reason: verdict.reason, detail: verdict.detail, seq, sha256: digest, ack }', 2],
    ['fastPathReason', 2],
    ['clip-ack.json', 1],
    ['outbox', 2],
    ['cua-clip-agent', 2],
    // J21-1: THE AGENT'S CLOCK HAS THREE SPELLINGS. `at` is what the shipped
    // cua-clip-agent.ps1 writes, `ts` is what an earlier build and the backend's
    // own stubs write, `updatedAt` is the JSON-idiomatic name. Reading only one
    // made a live agent evaluate as stale and the fast path never ran; a MISSING
    // stamp is 0 on purpose (the caller then says `agent-stale`, never freshness
    // invented from `undefined`).
    ['async function readClipState(spec, t)', 1],
    ["for (const key of ['at', 'ts', 'updatedAt'])", 1],
    ['if (Number.isFinite(value) && value > 0) { stamp = value; break }', 1],
    ['stampMissing: stamp === 0', 1],
    // J21-4: THE ACK IS WRITTEN BEFORE THE COPY, so one immediate read can catch
    // the PREVIOUS payload. Three reads, 250 ms apart, and the LAST matching ack
    // is the final word.
    ['const CLIP_ACK_READ_ATTEMPTS = 3', 1],
    ['for (let round = 0; round < CLIP_ACK_READ_ATTEMPTS; round += 1)', 1],
    // J21-5: THE AGENT REFUSES A JOB FILE, NOT A TEXT. The outbox budget is the
    // agent's file limit minus a conservative wrapper allowance, checked BEFORE
    // the first round trip.
    ['const CLIP_OUTBOX_WRAPPER_BUDGET = 2048', 1],
    ['const CLIP_OUTBOX_MAX_TEXT_BYTES = CLIP_MAX_BYTES - CLIP_OUTBOX_WRAPPER_BUDGET', 1],
    ["reason: 'too-large'", 2],
    // J21-6: A NUL IS A TRUNCATION, NOT A PASTE. The paste stays ok, but it is
    // explicitly unverified and says how many characters landed.
    ['const nulIndex = payload.indexOf(\'\\u0000\')', 1],
    ['nulTruncated: { landed, total }', 1],
    // J20-1: THE DIGEST OPT-OUT IS THE STRING '0' ONLY (unset and '1' keep the
    // full check), it disables the DIGEST and nothing else (size still applies),
    // and every skipped result says `verified: false` plus this note — a skipped
    // check is visible in the answer, never inferred from silence.
    ['export const ISO_DIGEST_DISABLED_NOTE', 1],
    ['export function isoDigestCheckDisabled()', 1],
    ["return String(process.env.DSH_CUA_WIN_ISO_SHA256 ?? '') === '0'", 1],
    // J1-5: AN UNPINNED CACHE IS NOT A PASS. Without a pin the sidecar is the
    // only claim available and it is hashed against the file; otherwise the cache
    // is refused with `unpinned-cache` and downloaded again.
    ["return { ok: false, reason: 'unpinned-cache' }", 1],
    // J1-1: A REDIRECT THE URL PARSER REJECTS FAILS THIS HOP, through fail()
    // (which unlinks the .part), instead of throwing out of a socket callback.
    ['bad-redirect', 2],
    // J22-7: the boot-time residue sweep (a killed boot's swtpm outlives the
    // process otherwise).
    ['const stopBootResidue = (name) => {', 1],
    ['stopBootResidue(spec.name)', 2],
    // J1-3 FOR SWTPM TOO: `--ctrl path=`, `--tpmstate dir=`, `--pid file=` and
    // `--log file=` go through swtpm's own comma-splitting option grammar, so an
    // unescaped store path with a comma used to truncate the socket/state path
    // and write the log somewhere else ("could not open pid file").
    ["'--ctrl', `type=unixio,path=${qemuEscapeOptionValue(p.tpmSocket)}`", 1],
    ["'--tpmstate', `dir=${qemuEscapeOptionValue(p.tpmDir)},mode=0600`", 1],
    ["'--pid', `file=${qemuEscapeOptionValue(p.tpmPid)}`", 1],
    ["'--log', `file=${qemuEscapeOptionValue(path.join(p.dir, 'swtpm.log'))},level=1`", 1],
    // J22-6: THE PRIVACY OFF-SWITCH'S WRITER. The guest cannot read the host
    // environment, so DSH_CUA_CLIP_AGENT=0 is MATERIALIZED as a file on the
    // medium; both guests consume the path, and nothing else writes it.
    ["export const CLIP_AGENT_SENTINEL_FILE = 'clip-agent-disabled'", 1],
    ['export const SETUP_IMAGE_OPTIONAL = Object.freeze([CLIP_AGENT_SENTINEL_FILE])', 1],
    ['CLIP_AGENT_SENTINEL_FILE,', 1],
    ["const clipAgentDisabled = String(process.env.DSH_CUA_CLIP_AGENT ?? '').trim() === '0'", 1],
    ["const sentinelPath = path.join(p.oemDir, CLIP_AGENT_SENTINEL_FILE)", 1],
    ['clip agent disabled by DSH_CUA_CLIP_AGENT=0 (sentinel staged)', 1],
    ['try { unlinkSync(sentinelPath) } catch {}', 1],
    ['if (existsSync(sentinelPath)) copyFileSync(sentinelPath, path.join(setupDir, CLIP_AGENT_SENTINEL_FILE))', 1],
    // the CONDITIONAL half: build/verify must not require an entry that the
    // knob legitimately did not stage, while a staged one must still be carried
    // and checked at BOTH firstboot search locations.
    ['const isOptionalEntry = (name) => SETUP_IMAGE_OPTIONAL.includes(name)', 1],
    ['.filter((name) => !isOptionalEntry(name) || existsSync(path.join(p.oemDir, name)))', 1],
    ['if (SETUP_IMAGE_OPTIONAL.includes(required) && !existsSync(path.join(p.oemDir, required))) continue', 1],
    ["if (existsSync(path.join(p.oemDir, CLIP_AGENT_SENTINEL_FILE)) && !oemScripts.includes(CLIP_AGENT_SENTINEL_FILE))", 1],
    ['the clip-agent off-switch would not reach the guest', 1],
    // J22-14: THE MCP RELAY RIDES THE SAME THREE ROUTES AS THE CLIPBOARD AGENT.
    // `OEM_MCP_RELAY_FILE` is the single name the staging, the medium's root, the
    // `$OEM$/$$/Setup/Scripts` copy and the byte-compare all read — a fifth file
    // added without its COPY is exactly the drift that constant prevents.
    ["export const OEM_MCP_RELAY_FILE = 'cua-mcp-relay.py'", 1],
    // WP-1/6.5: THE RELAY GUARD IS THE THIRD PAYLOAD SCRIPT, and the list needle
    // now names all three. It is the one a checkout keeps INSIDE
    // docker/windows-oem/, so its resolver probe is `<payload-dir>/<name>` — and
    // it is NOT in OEM_PAYLOAD_REQUIRED (a payload directory is identified by the
    // four answer-file members; a fifth identity test un-recognises a checkout's
    // own directory). A revert that drops it from the frozen set leaves a guest
    // whose firstboot has a task to register and no script to name.
    ["export const OEM_GUARD_FILE = 'cua-relay-guard.ps1'", 1],
    ['OEM_CLIP_AGENT_FILE, OEM_MCP_RELAY_FILE, OEM_GUARD_FILE])', 1],
    // staged into $STORE/windows/<name>/oem/ from the resolver (checkout: beside
    // docker/windows-oem/; image: inside it)
    ["stagePayloadFile(OEM_MCP_RELAY_FILE, 'MCP relay',", 1],
    ['a checkout keeps it beside it as docker/cua-mcp-relay.py', 1],
    ["stagePayloadFile(OEM_GUARD_FILE, 'relay guard',", 1],
    // ...then copied into $OEM$/$$/Setup/Scripts, which Setup turns into
    // C:\Windows\Setup\Scripts — one of the four places firstboot searches.
    ["for (const file of ['setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs', OEM_CLIP_AGENT_FILE, OEM_MCP_RELAY_FILE, OEM_GUARD_FILE])", 1],
    // ...and VERIFIED there. The base loop is still the FIVE answer/agent/relay
    // names, and the guard is verified by its OWN check right below it — exactly
    // how the sentinel is verified, and for the same reason: an entry that is
    // conditional on another stage does not belong in a fixed list, but a missing
    // verification does not either. (Earlier revision of this gate said the guard
    // "is not verified there"; that was true when writer H's first pass widened
    // only the copy. The dedicated `if (!oemScripts.includes(OEM_GUARD_FILE))`
    // check landed with the copy fix, so both statements below are now pinned.)
    ["for (const script of ['setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs', OEM_CLIP_AGENT_FILE, OEM_MCP_RELAY_FILE])", 1],
    // WP-1: THE GUARD'S OWN VERIFICATION, and the sentence a guest would get
    // without it ("the boot guard task firstboot registers would name a file that
    // is not there"). One `if`, so deleting it leaves the guard copy unverified.
    ['if (!oemScripts.includes(OEM_GUARD_FILE)) {', 1],
    // The medium's ROOT byte-compare is the base set PLUS the guard: `rootFiles`
    // is a `const` literal and the guard is APPENDED (`rootFiles.push`), the same
    // shape the conditional sentinel uses. It has to be here because the guard
    // really is copied to the medium's root (`SETUP_IMAGE_ENTRIES` + the
    // `mcopy -s`), so a differing byte is a corrupt-medium defect, not a file
    // that lives only under `$OEM$`. Dropping the push silently stops comparing
    // the one payload script that repairs an unwatched boot.
    ["const rootFiles = ['Autounattend.xml', 'setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs', OEM_CLIP_AGENT_FILE, OEM_MCP_RELAY_FILE]", 1],
    ['rootFiles.push(OEM_GUARD_FILE)', 1]
  ],
  /**
   * WP-2: THE CATALOG AND THE FIRMWARE SPLIT.
   *
   * Sixteen codes with a size, a firmware profile and an image selection each;
   * `xp` is LISTED and REFUSED (its Setup wants winnt.sif from a floppy/ISO
   * root, which this payload does not build). The needles pin the table; the
   * semantic assertion below calls the module and proves the SET.
   */
  windowsCatalog: [
    ["export const WINDOWS_VERSIONS = ['11', '11l', '11e', '10', '10l', '10e', '7u', 'xp', '2025', '2022', '2019', '2016', '2012', 'core11', 'tiny11', 'tiny10']", 1],
    ['export const WINDOWS_CATALOG = Object.freeze({', 1],
    ["refusal: 'legacy-installer-unsupported'", 1],
    ['its Setup reads winnt.sif from a floppy/ISO root', 1],
    // THE FIRMWARE IS A PROFILE, NOT A BOOLEAN: a BIOS guest rewrites five
    // decisions (machine, pflash, TPM, disk, NIC) and each one is wired below.
    ['export const WINDOWS_FIRMWARE_PROFILES = Object.freeze({', 1],
    ["seabios: Object.freeze({ machine: 'pc', bios: 'seabios', tpm: false, efiVars: false, disk: 'ide-hd', nic: 'e1000e' })", 1],
    ['export function windowsFirmwareProfile(version)', 1],
    ['export function windowsFirmwareForSpec(spec = {})', 1],
    ['...(firmware.efiVars', 1],
    ['...(firmware.tpm', 1],
    [": `${diskDevice},drive=disk0,bus=ide.0,bootindex=${diskBootIndex}`", 1],
    ["? `virtio-blk-pci,drive=disk0,bootindex=${diskBootIndex}`", 1],
    ["'-device', `${nicDevice},netdev=net0`", 1],
    // THE SELECTION IS DERIVED FROM THE CATALOG, so a code rename cannot leave
    // a hand-written table pointing at a spelling the catalog dropped.
    ['export function resolveWindowsImageSelection({', 1],
    ['export const WINDOWS_IMAGE_SELECTIONS = Object.freeze(Object.fromEntries(', 1],
    ["['11ltsc': '11l', ltsc11: '11l',", 0]
  ],
  /**
   * WP-3: WHERE THE INSTALL MEDIA COME FROM.
   *
   * One pinned URL per version was a bet on a Microsoft CDN object staying
   * alive; on 2026-11-15 four of the five answered 400. A version is an ORDERED
   * CHAIN now (mido → ESD → link1/link2/link6 → midoDirect), every entry
   * carrying the byte count and SHA-256 it must have, and the cache is only a
   * cache when the file matches the sidecar.
   */
  windowsSources: [
    ['export function resolveWindowsIsoSources(version)', 1],
    ['export async function ensureIsoForSource(sources, {', 1],
    ['export async function ensureIso({', 1],
    ['export async function verifyIsoDigest(file, expectedSha256)', 1],
    ['export function isoFileName(url)', 1],
    ['iso-digest-mismatch', 1],
    ['const ISO_PINS_BY_URL = (() => {', 1],
    // THE SIDECAR is what makes the next boot skip a 5.5 GB hash.
    ['writeFileSync(sidecar, `${verified.sha256}\\n`)', 1],
    ['iso-unavailable', 1],
    // MICROSOFT'S OWN PAGE, driven by the four calls its JavaScript makes.
    ["export const MIDO_PROFILE = '606624d44113'", 1],
    ["export const MIDO_ORG_ID = 'y6jn8c31'", 1],
    ['getskuinformationbyproductedition', 1],
    ['GetProductDownloadLinksBySku', 1],
    ['ov-df.microsoft.com/mdt.js?instanceId=', 1],
    // THE PINNED MIRRORS, by host, so a source cannot be swapped silently.
    ['linkid=2156292', 1],
    ['LinkId=841361', 1],
    ['dl.bobpony.com/windows', 1],
    ['files.dog/MSDN', 1],
    ['archive.org/download', 1],
    ['archive.org/download/tiny11_25H2/tiny11core_25H2_Nov25.iso', 1],
    ['archive.org/download/tiny11_25H2/tiny11_25H2_Nov25.iso', 1],
    ['tiny-10-23-h2/tiny10%20x64%2023h2.iso', 1],
    ['core11: Object.freeze([', 1],
    ['tiny11: Object.freeze([', 1],
    ['tiny10: Object.freeze([', 1],
    ["isoSource('midoDirect',", 1],
    ["isoSource('esd',", 1]
  ],
  /**
   * WP-7: THE RFB + CLIPBOARD BRIDGE that serves the live view.
   *
   * It is the websockify for that port when it starts, it is LOOPBACK ONLY (it
   * has no authentication), and its guest side is the supervisor's own control
   * socket — never a new TCP listener.
   */
  vncClip: [
    ['export function serverCutTextFrame(text)', 1],
    ['export function isClientCutText(frame)', 1],
    ['export function parseClientCutText(frame)', 1],
    ['export function encodeCutText(text)', 1],
    ['258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 1],
    ['export function wsAccept(key)', 1],
    ['127.0.0.1', 2],
    ["export function normaliseLoopbackHost(host, label = 'host')", 1],
    ['vmWindowsClipboardSet', 1],
    ['vmWindowsClipboardGet', 1],
    ['export function startClipboardBridge(options = {})', 1],
    ['export function parseArgs(argv)', 1],
    ['async function main()', 1],
    // R8: THE SUBPROTOCOL IS NEGOTIATED. noVNC 1.6.0 (Debian) offers NONE, and a
    // server that answers `Sec-WebSocket-Protocol: binary` to a client that did
    // not offer it is a handshake RFC 6455 says the CLIENT must abort — the page
    // loaded and the console said "not connected". No offer means no header.
    ['export const WS_SUBPROTOCOLS = Object.freeze([\'binary\'])', 1],
    ['export function selectSubprotocol(headerValue, supported = WS_SUBPROTOCOLS)', 1],
    ["const protocol = selectSubprotocol(request.headers['sec-websocket-protocol'])", 1],
    ['if (protocol !== null) lines.push(`Sec-WebSocket-Protocol: ${protocol}`)', 1],
    // the guard is the assertion: the unconditional line this replaced must not
    // come back (it was `Sec-WebSocket-Protocol: binary` on every handshake).
    ['NO UNCONDITIONAL `Sec-WebSocket-Protocol`', 1]
  ],
  winMcp: [
    // =====================================================================
    // WP-7.2 / WP-3 + WP-4 — THE DESKTOP-SESSION FACTS AND THE THREE RECEIPTS
    // (SOL §7.2). The relay measures the element lane WHERE IT IS USED (the
    // desktop session, the token that failed); this file consumes that file
    // and owns the three frozen sentences Appendix C adds to the descriptions.
    //
    //   * `desktopFacts` (2) — the export AND the call that makes it
    //     reachable. A defined-but-never-called reader leaves every consumer on
    //     `measured:false` and the doctor blind to a dead lane again; the
    //     doctor's whole `desktop` block is built on this one function.
    //   * `cua-desktop-facts.json` (2) — Appendix B's filename, twice because
    //     the read tries `C:\cua-work` and `%TEMP%`. The fallback is the branch
    //     that matters when the work dir's ACL is the defect (R2), so one path
    //     alone would let a reader silently stop trying.
    //   * `lastFailureKind` (2) — one assignment where the SSH child's
    //     stderr/exit is classified, one read in `doctorFacts()`. `lastError`
    //     stays byte-identical: the text is a receipt, this field is the branch
    //     the doctor and the tests can assert.
    //   * `connectionLevel` (1) — the ONE predicate WP-4.2 and WP-2.2 agree on.
    //     A second hand-rolled regex in the supervisor is how the two drift.
    //   * `WINDOWS_TOOL_CONTRACT` (1) — Appendix C's frozen object, the single
    //     place the three sentences live, so the registry and
    //     `windows_desktop`'s `tools[]` cannot disagree.
    //   * `not that the app acted on them (this receipt has no effect_verified)`
    //     (1) — Appendix C's `tool_send_keys` sentence, quoted verbatim. The
    //     locked §7.2 needle line spells the same clause "acted on it", which
    //     cannot match an appendix that says "them" — the appendix is the BYTE
    //     contract §4.6 tells the plugin to publish, so the appendix's wording
    //     is the needle; the §7.2 count (1) is unchanged.
    ['desktopFacts', 2],
    ['cua-desktop-facts.json', 2],
    ['lastFailureKind', 2],
    ['connectionLevel', 1],
    ['WINDOWS_TOOL_CONTRACT', 1],
    ['not that the app acted on them (this receipt has no effect_verified)', 1],
    ['export function windowsMcpEnabled()', 1],
    ["String(process.env.DSH_CUA_VM_WIN_MCP ?? '1') !== '0'", 1],
    ['export function sshArgv(', 1],
    ["'notifications/initialized'", 1],
    ["request('tools/list'", 1],
    ["request('tools/call'", 1],
    ['dsh_cua.server', 1],
    ['--stdio', 1],
    // U3: THE PIPE FLAG IS GONE FROM THE COMMAND. It named a listener upstream
    // does not implement; the documented consequence (one stdio server PER SSH
    // session, no shareable session-2 server yet) is what replaced it.
    ["'python -m dsh_cua.server --stdio'", 1],
    ['U3: THERE IS NO NAMED PIPE', 1],
    ['ONE shared session-2 server cannot be reached', 1]
    ,
    // WP-5: THE NAMESPACE IS THE HARNESS'S, NOT AN INVENTION. Everything the
    // model touches is `mcp__windows__<guest tool>`; the two helpers that are
    // never gated are the reveal and the doctor.
    ["export const DEFAULT_SERVER_NAME = 'windows'", 1],
    ["export const TOOL_PREFIX = 'mcp__windows__'", 1],
    ["export const REVEAL_TOOL_NAME = 'windows_desktop'", 1],
    ["export const DOCTOR_TOOL_NAME = 'windows_mcp_doctor'", 1],
    ['export function windowsToolName(tool)', 1],
    ['export function windowsGuestToolName(tool)', 1],
    // The keepalive that turns a suspended guest into a FAST, NAMED failure
    // instead of a call that hangs on a half-open socket.
    ["'-o', 'ServerAliveCountMax=2'", 1],
    // ...and the code the model branches on.
    ['vm-offline', 1],
    ['isOnline', 1],
    ['onClosed', 1],
    // J22-14: THE LANE. The SSH child runs the relay CLIENT (`py -3`, because on
    // the live guest python.exe is not on the non-interactive PATH while the
    // launcher resolves); the probe decides the lane on EVERY attach (the logon
    // task may come up minutes after boot), and the fallback RECORDS why it is
    // blind instead of looking identical to a working bridge.
    ["export const RELAY_COMMAND = 'py -3 ", 1],
    ['mcp-relay.py --connect', 1],
    ['export const RELAY_PORT_DEFAULT = 47999', 1],
    ['export const RELAY_SCRIPT = ', 1],
    ['export const SESSION0_FALLBACK_REASON = ', 1],
    ['desktop automation will be blind', 1],
    ['export const RELAY_PROBE_TTL_MS = 10000', 1],
    ['export function relayProbeCommand(', 1],
    ['export async function relayProbe(', 1],
    ['export async function relayDoctorFacts(', 1],
    ['export async function resolveGuestMcpTransport(', 1],
    // the lane is a property of the COMMAND that will run, not of the probe: an
    // override naming the relay still runs through the relay
    ["transport: relayLane ? 'interactive-relay' : 'session-0-direct'", 1],
    ['const relayLane = /mcp-relay\\.py/iu.test(wanted)', 1],
    // WP-2.3/§4.3: TWO SENTENCES, TWO DIAGNOSES, ONE LANE. `RELAY_SKEW` means the
    // guest ANSWERED and the harness could not read it (a payload/parse mismatch:
    // fix the probe); `RELAY_DOWN` means nothing answered (fix the relay). The
    // single `facts.reason = SESSION0_FALLBACK_REASON` assignment was exactly the
    // conflation the doctor could not undo, so the two branches are asserted
    // separately — the else branch keeps the DOWN sentence byte-identical for
    // every existing consumer.
    ['if (probe.status === RELAY_SKEW) facts.reason = SESSION0_SKEW_REASON', 1],
    ['else facts.reason = SESSION0_FALLBACK_REASON', 1],
    ['DSH_CUA_MCP_RELAY_PORT', 1],
    ['const relayProbeCache = { key: ', 1],
    // §4.1 — THE PROBE IS A HANDSHAKE, NOT A SUBCOMMAND, AND THE ORDER IS THE
    // CONTRACT. The old probe was `py -3 <RELAY_SCRIPT> --ping <port>`: a mode of
    // a payload that is STAGED AT MACHINE CREATE and never refreshed, so a guest
    // whose relay predates the mode answers a usage line on stderr and exits 2
    // (measured, Appendix A control) — and the harness read that as "down" on a
    // relay that was healthy. The fix is a program carried INSIDE the command:
    // base64, so `"`, `%`, `^`, `&`, `|` cannot be mangled by `ssh → cmd.exe →
    // python`; sent as `RELAY_PING`, read as an 8-BYTE ACCUMULATE, printed as
    // RELAY_OK/BAD/DOWN.
    //
    // `--ping` is KEPT, as the LAST candidate and in `legacyPingCommand()` — a
    // fresh payload really implements it, so it stays a tested third chance
    // instead of a string nobody can point at. What must never come back is
    // `--ping` as the FIRST question, and the needle that used to bless
    // `return \`py -3 ${RELAY_SCRIPT} --ping ${port}\`` as the probe is gone with
    // it: it described a command the relay might refuse, not a handshake.
    ['export function relayProbeCandidates(port = relayPort())', 1],
    ['export function relayProbeCommands(port = relayPort())', 1],
    ["{ id: 'py3-handshake', mode: 'handshake', interpreter: 'py -3'", 1],
    ["{ id: 'legacy-ping', mode: 'legacy', interpreter: 'py -3'", 1],
    // ...and the third candidate CALLS the builder instead of inlining a string:
    // removing the builder (or the candidate) is the revert this pair catches.
    ['command: legacyPingCommand(port) }', 1],
    ["exec(__import__('base64').b64decode('${encoded}').decode())", 1],
    ['const carrier = `exec(__import__(\'base64\').b64decode(', 1],
    // the legacy builder is a REAL function, not an inline literal, so its
    // existence is what says "third chance", not "the probe"
    ['function legacyPingCommand(port = relayPort())', 1],
    ['export function relayProbeCommand(port = relayPort())', 1],
    // §4.3/§4.2 — CLASSIFICATION AND THE INTERPRETER THAT ANSWERED. A token-less
    // answer is SKEW (the guest spoke), silence is DOWN; `probeMode` and
    // `interpreter` travel so the session command is built from the carrier the
    // probe proved exists (`py` vs `python`), instead of assuming `py`.
    ["export const RELAY_SKEW = 'RELAY_SKEW'", 1],
    ['export const SESSION0_SKEW_REASON = ', 1],
    ['const status = answeredAny === true ? RELAY_SKEW : RELAY_DOWN', 1],
    // THE INTERPRETER-MISSING CLASSIFICATION — DEFECT 3, IN ITS FINAL SHAPE.
    // Two earlier readings were wrong in opposite directions, and both are now
    // encoded as the thing that must not come back:
    //   * "any guest text means the relay answered" made a guest with no `py`/no
    //     `python` look like payload skew, so the doctor said "re-create the
    //     computer" when the real answer was "this guest has no interpreter";
    //   * "no token means DOWN" alone then hid that fact entirely.
    // The shipped rule: SKEW requires the text to NAME the relay script
    // (`mcp-relay` / `cua-mcp-relay`) AND to be unreadable (usage/option noise,
    // or the payload's own exit 2); an interpreter/shell failure is RELAY_DOWN,
    // and `interpreterMissing` carries the finer fact to the probe answer.
    ['const RELAY_SCRIPT_REFERENCE_RE = /mcp-relay|cua-mcp-relay/iu', 1],
    ['const RELAY_UNREADABLE_RE = /usage|invalid argument|unknown option|unrecognized argument|no such option|not recognized|cannot find/iu', 1],
    ['const INTERPRETER_MISSING_RE = /is not recognized as an internal or external command|command not found|is not recognized|was not found|not found|no such file or directory|cannot find the (?:path|file)|cannot find the file/iu', 1],
    // ONE OWNER FOR THE CLASSIFICATION, exported, and `answered` derived from it:
    // the SKEW flag can no longer be set by a message about the interpreter.
    ['export function classifyRelayProbeAnswer({ stderr = \'\', stdout = \'\', exitCode = null } = {})', 1],
    ['if (RELAY_SCRIPT_REFERENCE_RE.test(text) === true', 1],
    ['export function relayInterpreterMissing({ stderr = \'\', stdout = \'\' } = {})', 1],
    ['answered: classification === RELAY_SKEW', 1],
    ['interpreterMissing: relayInterpreterMissing({ stderr: capture.stderr, stdout: capture.stdout })', 1],
    // ...and it rides BOTH probe paths: the answering candidate and the
    // no-token one, so "no python here" survives to the doctor either way.
    ['interpreterMissing: attempt.interpreterMissing === true', 1],
    ['interpreterMissing: last?.interpreterMissing === true', 1],
    // WRITER B'S FINAL CONTRACT: THE RANK, THE SKEW SEMANTICS, AND THE ONE PAYLOAD
    // IDENTITY. Three exported facts that other files and docs now READ, so a
    // rename or an inline substitution breaks them silently:
    //   * `RELAY_ANSWER_RANK` / `relayAnswerRank()` — SKEW OUTRANKS DOWN. Two
    //     candidates can answer differently in one probe; "the guest answered"
    //     is the stronger fact, and a plain last-wins reducer loses it;
    //   * `PAYLOAD_SKEW_SEMANTICS` — the sentence `windowsPayloadFacts()` and the
    //     docs quote: skew is "the relay ANSWERED and the probe could not read
    //     it", NOT a hash comparison, and a missing interpreter is DOWN;
    //   * `expectedRelayHash()` — the harness-side payload identity index.js has
    //     always read; nothing produced it before, so `payload.expectedRelayHash`
    //     was structurally null.
    // (`export function classifyRelayProbeAnswer(` is already pinned by the FULL
    // signature needle above, so a second, shorter needle would only restate it.)
    ['export const RELAY_ANSWER_RANK = Object.freeze({', 1],
    ['export function relayAnswerRank(status)', 1],
    ['export const PAYLOAD_SKEW_SEMANTICS', 1],
    ['export const DOCTOR_FACTS_FIELDS', 1],
    ['export function expectedRelayHash(sourcePath = null)', 1],
    // THE BUDGET IS THE REMAINING BUDGET. One shared deadline covers every
    // candidate (§4.1), so the per-child timer is the leftover milliseconds with
    // a 1 ms floor — a 1 s floor here let a third candidate outlive the 12 s wall
    // and made the LAST carrier's silence indistinguishable from a slow one.
    ['const budget = Math.max(1, Math.round(Number(timeoutMs)))', 1],
    ['interpreter: candidate.interpreter', 1],
    ['probeMode: probe.probeMode ?? null', 1],
    // THE DOCTOR'S FIELD ALIASES ARE A CONTRACT ACROSS TWO FILES. The client
    // reports the lane's own words under `transportCommand` / `transportReason`
    // (the module-level `relayDoctorFacts()` says `command` / `reason`), and
    // index.js READS `transportReason` to build the fallback sentence. Renaming
    // either side blanks the doctor's command and reason without any type error —
    // `undefined` in a template is a string, not a failure — so the alias is
    // pinned here and its consumer is pinned in the index block.
    ['transportCommand: decided?.command ?? null', 1],
    ['transportReason: state.reason', 1],
    // §4.4 — REPAIR. One self-contained SSH attempt, bounded and throttled, with
    // an Appendix-B record so the doctor can SAY what happened instead of asking
    // the user to look at the guest. `spawnImpl` is the seam every child (probe,
    // repair, session) goes through; without it the repair path is untestable.
    ['export async function repairRelay(', 1],
    ['export const RELAY_REPAIR_INTERVAL_MS = 60_000', 1],
    ["export const RELAY_REPAIR_RECORD_PREFIX = 'CUA_RELAY'", 1],
    ['spawnImpl = spawn', 3],
    // ...and the launcher it REGENERATES names the harness's port: the
    // interactive session has no DSH_CUA_MCP_RELAY_PORT, so a bare `--serve`
    // would always listen on 47999 whatever the harness probes (direction E).
    ["--serve --port ' + $port", 1],
    ['export const RELAY_PROBE_TIMEOUT_MS = 12000', 1],
    // WP-2.5/§4.4 — THE REPAIR RECORD SAYS WHETHER IT MEASURED ANYTHING.
    // A repair that never reached the guest still returns a RECORD; before the
    // marker, that record carried the base defaults (`session: 0`, `hash: ''`,
    // `probe: 'RELAY_DOWN'`), which are indistinguishable from measurement — so
    // index.js read "a repair measured that no console exists" and "the guest has
    // no relay" on paths where NOTHING was measured (J7). Every consumer must
    // gate on `measured` first, and the per-field `*Measured` flags narrow it:
    // `session === 0` means "no console session" ONLY when `sessionMeasured`.
    ['export function relayRepairMeasured(record)', 1],
    ['export function relayRepairMeasurement(record)', 1],
    ["export const RELAY_REPAIR_UNMEASURED = Object.freeze({", 1],
    ['sessionMeasured: measured && record?.sessionMeasured === true', 1],
    ['unmeasured: RELAY_REPAIR_UNMEASURED.THROTTLED', 1],
    // BOTH DOCTORS CARRY IT (P2): the module-level relayDoctorFacts() and the
    // client's doctorFacts() must agree field for field, so the payload marker
    // and the measured-gated hash are asserted twice — a client that reports the
    // guest's hash for an unmeasured attempt is the "blind bridge reported ok" bug
    // wearing payload fields.
    ['measured: record?.measured === true,', 2],
    ['relayHash: record?.measured === true ? (record?.hash ?? null) : null,', 2],
    // DEFECT 4(b): `port=` IS A MEASUREMENT, NOT AN ECHO OF THE HARNESS PORT.
    // The guest now reports the port its handshake ACTUALLY answered on
    // (`$answerPort`, discovered from the launcher or from the python listener),
    // and an empty field parses to null with `portMeasured: false` — never to the
    // harness's own port. That is what lets `portMismatch` finally mean "the relay
    // answers somewhere else" instead of being unreachable by construction.
    ['portMeasured: port !== null', 1],
    ["' port=' + $answerPort", 1],
    ['function Get-PythonListenPorts', 1],
    // J22-14b: A LATE RELAY MUST BE ABLE TO TAKE OVER A LIVE BLIND ATTACH. The
    // lane is decided per attach and the logon task can come up AFTER the SSH
    // attach that found it down; without an upgrade nothing re-decided and the
    // computer stayed blind for the whole session. One probe + one reconnect per
    // minute at most, never during a `tools/call`, and an env escape hatch.
    ['export const RELAY_UPGRADE_INTERVAL_MS = 60_000', 1],
    ['export const RELAY_UPGRADE_WATCH_MS = 15_000', 1],
    ["export const RELAY_UPGRADE_LOG = 'upgrading mcp transport to the interactive relay'", 1],
    ['export function shouldUpgradeToRelay({', 1],
    ['async function maybeUpgradeTransport(now = Date.now())', 1],
    ['const startUpgradeWatch = () => {', 1],
    ['startUpgradeWatch()', 1],
    ['DSH_CUA_VM_WIN_MCP_UPGRADE', 2],
    // the upgrade FORCES a fresh probe: the cached answer may be the DOWN that
    // put the attach on this lane, and the whole point is that a relay started
    // since then is now seen
    ['force: true, timeoutMs: RELAY_PROBE_TIMEOUT_MS', 1],
    // =====================================================================
    // WP-B (SOL §4.4) — CLIENT TRUTH: the fourth token, the functional probe,
    // the repair sentence and the PER-CALL budget.
    //
    // The cheap probe can only ever answer "the accept loop is alive": it is
    // answered before the session lock, so a wedged child reads OK. These rows
    // keep the three things that turn that into a diagnosis: a THIRD status
    // (`RELAY_UNRESPONSIVE`), the base64-carried program that actually drives
    // `initialize` + `tools/list` through the child, and the evidence object
    // whose numbers are printed verbatim by the doctor's `unresponsive` verdict.
    // `tests/modules-unit.mjs` drives the behaviour (B-1..B-14); these are the
    // revert-proof half.
    // ---------------------------------------------------------------------
    // B1/B2 — the token, and its rank ABOVE skew. Rank 3 exists because
    // "the child did not answer" is stronger evidence than "the payload hash
    // did not match"; collapsing it into DOWN would send the operator to the
    // wrong repair.
    ['export const RELAY_UNRESPONSIVE = \'RELAY_UNRESPONSIVE\'', 1],
    ['[RELAY_UNRESPONSIVE]: 3', 1],
    // B3 — ONE token matcher for both probes. The group is explicit, not `.`:
    // `RELAY_OKAY` must not parse, and `RELAY_OK` must not need a boundary.
    ['RELAY_(OK|BAD|DOWN|UNRESPONSIVE)', 1],
    // B4/B5/B6 — program, command, runner. The base64 CARRIER is the §27
    // rule: no `--functional` flag, so a stale guest payload cannot answer a
    // probe it does not implement (its `usage()` stays byte-identical).
    ['export function relayFunctionalProbeProgram(', 1],
    ['export function relayFunctionalProbeCommand(', 1],
    ['export async function relayFunctionalProbe(', 1],
    // B7/B8 — the token the program SENDS, and the doctor field it publishes.
    ['RELAY_FN', 1],
    ['relayFunctional', 1],
    // B9/B10/B11 — C3's three evidence numbers, typed through `evidenceInt`:
    // `null` stays `null` (never 0), because "no successful call yet" and
    // "0 ms ago" are different diagnoses and C12 prints both.
    ['lastSuccessfulCallAgeMs', 1],
    ['outstandingRequestAgeMs', 1],
    ['childRestarts', 1],
    // B12 — C6's ONE owner for the repair sentence: an unmeasured attempt must
    // name WHY, so `ok:false, reason:""` can never be the answer again.
    ['export function describeRepairRecord(', 1],
    // B13 — the per-call budget: the only reason a 200 ms test beats the 60 s
    // default, and the reason a slow call is not reported as a dead attach.
    ['perCallTimeoutMs', 1],
    // =====================================================================
    // CB (cold-boot round, WP-6) — THE TRANSPORT HALF: the boot-race window,
    // the sixth probe reason, the payload guard, and the absent-facts code.
    //
    // These are §4.1's rows 1-12, and every literal is FROZEN by §1 of
    // `coldboot-sol.md`: a writer who rewords one is proposing a contract
    // change, and this block is where that shows up. The MIN values are the
    // multi-site rows — a declaration without its consumer is exactly the
    // "declared but unused" revert S7 and the wiring rows exist to catch.
    // ---------------------------------------------------------------------
    // 1-3: THE WINDOW ITSELF. 90000 mirrors the guard's own budget (it waits
    // up to 90 s for an Active console session); a different number here would
    // let the two sides disagree about when a lane is late. The offsets are
    // frozen, ascending and their last value must fit inside the attach budget
    // (S7 reads all three numbers out of the file).
    ['export const BOOT_RACE_WINDOW_MS = 90000', 1],
    ['export const BOOT_RACE_ATTACH_MS = 24000', 1],
    ['export const BOOT_RACE_PROBE_OFFSETS_MS = Object.freeze([0, 8000, 20000])', 1],
    // 4: the PURE function. `source`, `live` and `sinceReadyMs` are decided
    // here and nowhere else, so the doctor cannot invent a window.
    ['export function bootRaceFacts(', 1],
    // 5: THE FIELD HAS TWO SITES (min 2) — the client's doctor facts and the
    // payload that spreads them. One site alone means the doctor reports a
    // window the transport never computed (or the reverse).
    ['bootRace,', 2],
    // 6: THE LADDER'S DOOR. Without this comparison every genuinely-dead relay
    // pays a 24 s attach ladder before the verdict (M-24 applies this revert).
    ['if (bootWindow.live !== true) ', 1],
    // 7: THE THROTTLE, NOT THE TIMER. The pure guard takes 10 s inside a live
    // window; the 15 s interval and its teardown are untouched (JURY2-CO1).
    ['BOOT_RACE_UPGRADE_INTERVAL_MS', 2],
    // 8-9: THE SIXTH REASON. The constant is the closed set the normaliser
    // enforces, `'probe-unsupported'` occurs at the producer (python) and in
    // that constant — hence min 2 for the reason and 1 for the array.
    ['export const RELAY_FN_REASONS = Object.freeze([\'\', \'child-silent\', \'child-eof\', \'session-busy\', \'no-evidence\', \'probe-unsupported\'])', 1],
    ["'probe-unsupported'", 2],
    // 10-11: THE GUARD'S BYTES ARE THIS BUILD'S. The sources list is the same
    // two-layout probe the relay hash uses; expectedGuardHash() returns null
    // (never '' and never 'mismatch') on a build without the docker/ tree.
    ['export const GUARD_EXPECTED_HASH_SOURCES', 1],
    ['export function expectedGuardHash(', 1],
    // 12: THE ABSENT-FACTS CODE. A closed set on every desktop answer; the
    // classification is language-free because a translated Windows localises
    // `The system cannot find the path specified`.
    ["export const DESKTOP_FACTS_ABSENT = 'facts-file-absent'", 1]
  ],
  oemAnswer: [
    ['<unattend xmlns="urn:schemas-microsoft-com:unattend">', 1],
    // D8: schema order, asserted by position rather than by presence: a
    // RunSynchronous before DiskConfiguration is rejected on some media.
    ['<DiskConfiguration>\n        <Disk', 1],
    ['</ImageInstall>\n      <RunSynchronous>', 1],
    ['<AutoLogon>\n        <Username>cua</Username>', 1],
    ['</FirstLogonCommands>\n      <OOBE>', 1],
    ['</OOBE>\n      <UserAccounts>', 1],
    ['<LocalAccount wcm:action="add"', 1],
    ['<Name>cua</Name>', 1],
    ['{{PASSWORD}}', 3],
    ['BypassTPMCheck', 1],
    ['<AutoLogon>', 1],
    // S3: the key block is a placeholder; evaluation media leave it empty.
    ['{{PRODUCT_KEY}}', 1],
    // F2: THE EDITION IS NAMED. The placeholder must stay INSIDE <OSImage> and
    // BEFORE <InstallTo> (schema order), and writeOemPayload replaces it with
    // the <InstallFrom> block (or the staged file is refused, see the F2
    // semantic check).
    ['<OSImage>\n          <!-- F2: WITHOUT THIS, SETUP ASKS WHICH EDITION.', 1],
    ['{{IMAGE_INSTALL}}', 1],
    ['<InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>', 1],
    // S4: FirstLogonCommands uses the hidden launcher, not a bare powershell.
    ['wscript //nologo C:\\Windows\\Setup\\Scripts\\Unattend.vbs', 1],
    // D1/H1: THE SWITCH THAT MAKES $OEM$ MEAN SOMETHING. Without it Setup never
    // copies $OEM$\$$\Setup\Scripts into C:\Windows\Setup\Scripts, the
    // FirstLogonCommand above points at a missing Unattend.vbs, and the desktop
    // shows "Windows Script Host — Can not find script file".
    ['<UseConfigurationSet>true</UseConfigurationSet>', 1],
    // D1/H2: THE BELT. A first-logon fallback that scans drive roots for the
    // script, so a failed $OEM$ copy does not cost the computer its OpenSSH.
    ['for %d in (c d e f g h) do @if exist "%d:\\cua-firstboot.ps1"', 1],
    ['powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%d:\\cua-firstboot.ps1"', 1]
  ],
  oemSetup: [
    ['cua-firstboot.ps1', 1],
    ['Unattend.vbs', 1],
    ['wscript //nologo', 1],
    ['setupcomplete exit', 1],
    // S4: exit passthrough, not a hardcoded success.
    ['exit /b %CUA_EXIT%', 1]
  ],
  oemLauncher: [
    // S4: hidden window style (0) + wait (True) + exit passthrough.
    ['CreateObject("WScript.Shell")', 1],
    ['0, _', 1],
    ['True)', 1],
    ['WScript.Quit exitCode', 1],
    ['C:\\Windows\\Setup\\Scripts\\cua-firstboot.ps1', 1]
  ],
  oemBoot: [
    // =====================================================================
    // WP-7.1 / WP-1 — THE PAYLOAD MAY NOT LIE ABOUT ITS OWN INSTALL (SOL §7.1).
    //
    // The reported dead element lane was a pywin32 whose DLLs were never
    // copied, shipped through a `find_spec()` gate that never imports. These
    // needles pin the three parts of the honest gate plus the work dir and the
    // hash-gated scale patch:
    //
    //   * `pywin32_postinstall` — the step REPAIRS the wheel it just installed.
    //     Without this command a broken pywin32 can never heal in place, and
    //     `find_spec()` would still report the package as present.
    //   * `import win32ui` — the gate IMPORTS instead of looking up. A revert
    //     to a presence-only check turns this red; a spec finder cannot see a
    //     `.pyd` that fails to load, which is exactly the state that shipped.
    //   * `pywinauto.controls.uiawrapper` — the module every pattern action
    //     goes through (`_wrapper_for`), measured AFTER the repair. Importing
    //     only `win32ui` would pass on a tree where the automation lane is
    //     still broken.
    //   * `C:\cua-work` (2) — the one directory the desktop token can write:
    //     the step that CREATES it and the write assertion that PROVES it. One
    //     site is a directory nothing tests; the ACL is only a claim until the
    //     token writes.
    //   * `setintegritylevel` — the DACL alone is not enough: a Medium-IL
    //     process cannot write a High-IL directory however the ACL reads.
    //   * `Step 'cua-workdir'` / `Step 'dsh-cua-scale'` (1 each) — the marker
    //     rows the JURY reads in `C:\cua-provision.json`. A rename cannot
    //     leave the proof in a row nobody queries.
    //   * `base_w` (1) — Appendix A's patch anchor, the exact line the
    //     replacement rewrites. The gate is a SHA plus "the anchor occurs
    //     exactly once"; without this needle a patch that no longer matches
    //     could be replaced by a no-op that still reports `applied`.
    //   * `SCALE_OK` (1) — the no-window probe's positive answer, so a patch
    //     that lands but is never PROVEN is still red.
    //   * `scaleFix` (2) — the fact must be RETURNED by the step and SAID in
    //     the log the JURY reads (`applied` / `already` / `skipped:<why>`); the
    //     refusal path is the one that must never be silent.
    ['pywin32_postinstall', 1],
    ['import win32ui', 1],
    ['pywinauto.controls.uiawrapper', 1],
    ['C:\\cua-work', 2],
    ['setintegritylevel', 1],
    ["Step 'cua-workdir'", 1],
    ["Step 'dsh-cua-scale'", 1],
    ['base_w', 1],
    ['SCALE_OK', 1],
    ['scaleFix', 2],
    ['OpenSSH.Server', 2],
    ['{{SSH_PUBKEY}}', 1],
    ['administrators_authorized_keys', 1],
    ['{{PYTHON_URL}}', 1],
    ['{{DSH_CUA_PIP}}', 1],
    ['dsh_cua.server', 1],
    ['Register-ScheduledTask', 1],
    ['-LogonType Interactive', 1],
    // D10: the marker is an audit trail, not a readiness signal.
    ['an AUDIT marker', 1],
    // U2: THE CLIPBOARD BRIDGE. Two on-demand tasks that run IN THE USER'S
    // SESSION, because that is the only clipboard a human can see (RFB
    // ClientCutText has no guest agent; Set-Clipboard over SSH writes Session
    // 0's clipboard). The flags are the contract: /sc ondemand (only when the
    // supervisor asks), /it (interactive = the user's session), /rl LIMITED
    // (the same token the user's own PowerShell gets).
    // The task lines go through a generated .cmd because Windows PowerShell 5.1
    // passes a variable containing spaces to a native program UNQUOTED, so
    // `& schtasks /tr $var` arrived as `/tr powershell.exe ...` and only the
    // executable was registered. The batch file is the documented quoting path.
    ['cua-clip-set`" /sc ondemand /it /rl LIMITED /f /tr', 1],
    ['cua-clip-get`" /sc ondemand /it /rl LIMITED /f /tr', 1],
    ['cmd /c $cmdFile', 1],
    ['Set-Clipboard -Value ([IO.File]::ReadAllText(', 1],
    ["[IO.File]::WriteAllText('C:\\ProgramData\\cua\\clip-read.txt', [string](Get-Clipboard -Raw))", 1],
    ['clip-set.ps1', 1],
    ['clip-get.ps1', 1],
    // U3: THE CONSOLE IS GONE. python.exe always allocates one; pythonw.exe does
    // not, and the task carries -Hidden as well. The `--pipe` argument is gone
    // because upstream `dsh_cua.server main()` has no such option — it named a
    // listener nothing ever created.
    ['pythonw.exe', 2],
    ['New-ScheduledTaskAction -Execute $pyw -Argument', 1],
    ['-Settings $settings -Hidden -Force', 1],
    ['-WindowStyle Hidden', 1],
    ['U3: WHAT USED TO BE WRONG, TWICE', 1],
    ['upstream `dsh_cua.server main()` takes no pipe option', 1],
    // J22-2/J22-3: THE FIRSTBOOT SCRIPTS SHARE THE AGENT'S CONTRACT. The seq the
    // supervisor mints is a Date.now() stamp (~1.79e12), and an Int32 parameter
    // cannot hold it: the first assignment is `[long]`, not an afterthought cast.
    ['[long]$seq', 1],
    // J22-6: THE PRIVACY OFF-SWITCH IS A SENTINEL, AND IT MUST READ AS `skipped`.
    // A plain ok:true would report "registered" for a task nobody created; the
    // step records `skipped = $true` with the reason.
    ["clip-agent-disabled", 2],
    ["return @{ skipped = $true; reason = 'clip-agent-disabled' }", 1],
    // J22-9: A TASK THAT STARTED IS NOT A STATE THAT LANDED. `/run` followed by
    // a freshness proof on clip-state.json, or the step fails with its own name
    // instead of claiming the agent is live.
    ["throw 'task-started-but-no-state'", 1],
    // J22-6: THE SENTINEL'S GUEST HOP. The backend stages the file on the medium
    // and in Setup\Scripts; the guest's copy lives in C:\ProgramData\cua, so
    // firstboot SEARCHES THE SAME LOCATIONS AND STAGES IT BEFORE the off-switch
    // check — otherwise "a file on the medium" never becomes "the path the two
    // consumers test". Additive by construction: no staged copy anywhere means
    // no write and the old behaviour exactly.
    ["$sentinelName = 'clip-agent-disabled'", 1],
    ["$sentinelPath = 'C:\\ProgramData\\cua\\clip-agent-disabled'", 1],
    ["$sentinelDirs = @($PSScriptRoot, 'C:\\Windows\\Setup\\Scripts', 'C:\\ProgramData\\cua', 'C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\')", 1],
    ['Copy-Item -LiteralPath $sentinelStaged -Destination $sentinelPath -Force', 1],
    ['clip agent: staged sentinel $sentinelStaged -> $sentinelPath', 1],
    // ...and the EMBEDDED agent carries the same hop, for a guest whose payload
    // predates the file (it runs under $ErrorActionPreference = 'Stop', hence the
    // SilentlyContinue probes).
    ["$stagedSentinel = Join-Path $stagedDir 'clip-agent-disabled'", 1],
    ["if (Test-Path -LiteralPath (Join-Path $Dir 'clip-agent-disabled')) { exit 0 }", 1],
    // J22-14: THE INTERACTIVE MCP RELAY'S TASK. `/it` IS THE ENTIRE POINT: without
    // it the task runs in Session 0 again and the relay faithfully forwards
    // JSON-RPC to a server that still cannot see a single window. The .vbs
    // launcher is the quoting fix — `schtasks /tr` is ONE command line Windows
    // RE-PARSES, and a nested quote there silently truncates the action (a task
    // that exists and does nothing), so the command lives in a file /tr names by
    // a path with no spaces.
    ["Step 'mcp-relay-task'", 1],
    ["$relayScript = 'C:\\ProgramData\\cua\\mcp-relay.py'", 1],
    ["Join-Path $relayDir 'cua-mcp-relay.py'", 1],
    ['the relay would be a task that does nothing', 1],
    // WP-1.1/§1-fact-2: `/ru` IS THE FIX, NOT A TIDY-UP. `/it` without `/ru`
    // binds the task to the CALLER — and the pass that registers this task runs
    // as SYSTEM, so Windows refuses the create with exit 1 (reproduced). The
    // account is resolved ONCE with Get-LocalUser (`$relayAccount`), never from
    // `$env:USERNAME` (which IS "SYSTEM" in this pass), and the same value is
    // what the guard and the re-assert hand to their own `schtasks /create`.
    ["/tn `\"cua-mcp-host`\" /sc onlogon /ru `\"$relayAccount`\" /it /rl LIMITED /f /tr", 1],
    ["$relayLauncher = 'C:\\ProgramData\\cua\\mcp-relay-host.vbs'", 1],
    ['shell.Run', 1],
    ['", 0, False', 1],
    ['wscript.exe //B //NoLogo $relayLauncher', 1],
    ['cua-mcp-relay-task.cmd', 1],
    // WP-1.4/1.5/1.6 — THE GUARD TASK, THE NEVER-SKIPPED STEP, AND THE MARKER'S
    // IDENTITY. Three separate promises, so three separate needles:
    //
    //   * `relay-guard-task` stages cua-relay-guard.ps1 to C:\ProgramData\cua and
    //     registers it `/sc onstart /ru SYSTEM /rl HIGHEST`: it must exist for a
    //     boot that produces NO logon (expired autologon, a resume before
    //     Winlogon), which is the case an `onlogon` task cannot cover;
    //   * `mcp-relay-reassert` is the ONE step declared `-Always`, so every
    //     firstboot pass repairs a lane that died while its marker still said
    //     ok:true (the `$done` skip is right for OpenSSH and wrong for a server);
    //   * `attempts` and `scriptSha256` make the marker say HOW MANY TIMES and
    //     WHICH script — without them "was this step tried twice" and "is the
    //     stash stale" are inferences from duplicate rows and file sizes.
    //
    // The -File argument has no quotes on purpose: C:\ProgramData\cua is a path
    // with no spaces, and a nested quote in /tr silently truncates the action.
    ["Step 'relay-guard-task'", 1],
    ['/sc onstart /ru SYSTEM /rl HIGHEST /f /tr', 1],
    ['-WindowStyle Hidden -File $guardScript -Boot -Port $relayPort', 1],
    ["Step 'mcp-relay-reassert'", 1],
    ['} -Always', 1],
    ['attempts = $attempts', 2],
    ['scriptSha256 = $scriptSha256', 1],
    ["throw 'task-started-but-relay-not-listening'", 1],
    // the port is the same env override the relay and the client read
    ['DSH_CUA_MCP_RELAY_PORT', 1],
    // ...and the task is recorded as INTERACTIVE, like the clipboard tasks above
    ['mcp relay registered (cua-mcp-host: onlogon, INTERACTIVE, /rl LIMITED)', 1],
    // =====================================================================
    // WP-D (SOL §6.4) — THE GUEST PAYLOAD: type_text's receipt, save_path's
    // allow-list, and the desktop-token proof.
    //
    // Three defects, one shape: the guest reported success for work it had not
    // verified. `type_text` posted the text and trusted it (a focus race drops
    // the tail, and the old code still answered `effect_verified: true`);
    // `tool_capture_window` wrote to a path nobody could have written to and
    // raised; and nothing ever proved the DESKTOP token could see an interactive
    // session at all — the costliest blind lane in the report. Each is a NEW
    // here-string-patched step, so the anchors, the SHA pin, the `count == 1`
    // gate and the marker are all part of the contract. `tests/guest-patch.mjs`
    // applies them to the pinned 0.4.1 evidence copies and runs the patched code
    // (D-1..D-20); these rows are the revert-proof half.
    // ---------------------------------------------------------------------
    // D1/D2/D3 — the three steps exist, in the order S6 asserts.
    ['Step \'dsh-cua-typetext\'', 1],
    ['Step \'dsh-cua-savepath\'', 1],
    ['Step \'desktop-token-probe\'', 1],
    // D4 — the idempotency key AND the patch marker: a second boot must say
    // `already`, and the marker is the only witness that the step ran.
    ['typeTextFix', 1],
    // D9 (WP-E / JE1) — THE OTHER TWO MARKERS, which had a MUTATION-less hole:
    // `typeTextFix` had a needle and M-15, while `savePathFix` (13 occurrences)
    // and `desktopProbe` were pinned by NOTHING — renaming either marker passed
    // every gate, and a renamed marker is a marker the doctor reads as absent
    // (`savePathFix` absent = "the save-path patch was never attempted";
    // `desktopProbe` absent = "the desktop token was never proven"). One row
    // each, in the same one-word-revert style as D4; the pairs are M-21/M-22.
    ['savePathFix', 1],
    // D10 (WP-E / JE1) — the probe's own marker key. NOTE: unrelated to the
    // `D-9` that `tests/modules-unit.mjs` uses for the probe REASON SET; this is
    // the guest marker row, numbered after D8 in this block.
    ['desktopProbe', 1],
    // D5 — the receipt that makes an auto-created directory honest instead of
    // silent (a save into `%TEMP%\win32_mcp_shots\...` used to fail).
    ['created_dir', 1],
    // D6 — the proof that the exact-compare receipt is real: `short-insert` is
    // the reason a dropped tail is REPORTED instead of claimed as verified.
    ['short-insert', 1],
    // D7 — the probe's task name, and D8 the retry marker on its character
    // post: the two halves a revert would drop independently.
    ['cua-desktop-probe', 1],
    ['TYPE_TEXT_RETRY', 1],
    // D11 (CB, WP-1A) — THE MARKER'S NEW IDENTITY FIELD. `guardSha256` is the
    // top-level key a later provisioning pass (and the harness's own staging
    // decision) compares, so its assignment is the one line that says the marker
    // now carries the guard's identity instead of dating the payload by hand.
    ['$state.guardSha256 = ', 1],
    // D12 (PRE/mimo, WP-1A) — THE STAGED-SIDE MEASURE, which was a VACUOUS PIN.
    //
    // Measured defect: deleting `$stagedHash = (Get-FileHash -LiteralPath
    // $guardScript -Algorithm SHA256)…` left the gate GREEN at 1337 and
    // `tests/guest-patch.mjs` PASSING. Nothing targeted it — S12's
    // `indexOf('$stagedHash = ')` matched the INIT (`$stagedHash = ''`) two lines
    // above, and only the OEM-SOURCE side (`$sourceHash`) had a row. With the
    // measure gone, `elseif (-not $stagedHash) { $copyGuard = $true }` is always
    // true, so the guard is copied on EVERY provisioning pass — the exact WP-1A
    // defect, back with zero red.
    //
    // The literal is the GET-FILEHASH CALL on the staged path, not the variable
    // name: the variable is assigned three times in this step (`''`, the measure,
    // and the catch), so only the call distinguishes the measurement from the
    // initialisation. M-29 applies the revert.
    ['$stagedHash = (Get-FileHash -LiteralPath $guardScript -Algorithm SHA256).Hash.ToLowerInvariant()', 1]
  ],
  /**
   * WP-1.7: THE RELAY GUARD — ONE COPY OF "IS THE RELAY LISTENING", AND THE
   * BOOT-TIME RE-ASSERT THAT USES IT.
   *
   * This file exists because the question had TWO copies: firstboot's inline
   * `Test-RelayPing` and the client's probe both decided "down", and both got it
   * wrong in the same way. The firstboot copy is GONE (the file's own header says
   * so), and the guard is what firstboot `-Ensure`, the `/sc onstart` boot task
   * and the logon path all call — so the needles that used to live in `oemBoot`
   * are asserted HERE, against the file that actually carries them. That is a
   * MOVE, not a deletion: a revert that puts an 8-byte-buffer probe back into
   * `cua-firstboot.ps1` would leave this block red, because the guard would then
   * be a task that does nothing.
   */
  oemGuard: [
    // THE PROBE IS THE IDEMPOTENCY PROOF. The eight is asserted, not assumed: a
    // 9-byte buffer read one byte too many, and comparing a short read against
    // the wrong length made every "is it up?" answer $false — so every run
    // started a SECOND listener and the loser died on WinError 10048 while the
    // marker still read ok:true (the same defect, twice, in two copies).
    ['function Test-RelayPing(', 1],
    ["GetBytes('RELAY_PING')", 1],
    ['New-Object byte[] 8', 1],
    ["-ceq 'RELAY_OK'", 1],
    // ONE Read IS NOT THE ANSWER either: a legal short read is a healthy relay,
    // so the guard accumulates until 8 bytes or EOF. The loop's bound is the
    // stopwatch, not one socket timeout per Read.
    ['$read = 0', 1],
    ['while ($read -lt $answer.Length) {', 1],
    // THE PORT IS A PARAMETER, NEVER A CLOSURE. The boot task carries `-Port`,
    // the firstboot `-Ensure` call passes the same number, and the harness
    // probes that number — a literal 47999 in the probe is the port divergence
    // (direction E) the launcher fix closes on the host side.
    ['if (Test-RelayPing -Port $Port', 1],
    // THE /run IS GATED BY THE PROBE, and the action records WHY it did not run:
    // `already-up` is the 10048 lesson in one string (a /run against a live
    // relay races it for the bind).
    ["'already-up'", 1],
    // THE AUTOLOGON RE-ASSERT is the direction-D half, and it writes ONLY the two
    // values it must (an operator's DefaultPassword/DefaultUserName survives):
    // the key is resolved once, and the write is the literal 1 — not a re-assert
    // that rewrites whatever it read.
    ['-Name AutoAdminLogon', 2],
    ["-Value '1'", 1],
    // ONE LINE PER RUN, at a path firstboot can copy into the marker. The
    // ASSIGNMENT is asserted, not the word: the header comment also names the
    // file, so a needle matching the bare name would stay green after the writer
    // pointed $LogPath somewhere else (proven by mutation).
    ["$LogPath = $Dir + '\\relay-guard.log'", 1],
    // EXIT 0/1 AND NOTHING ELSE, so a caller can branch on the code.
    ['if ($Ok) { exit 0 }', 1]
  ],
  /**
   * THE CLIP AGENT ITSELF (J22-1/2/4/5/11): a separate file, gated separately,
   * because the supervisor copies it into the OEM payload and the firstboot
   * registers the task — a rename in either place silently ships an older agent.
   */
  clipAgent: [
    ['clip-agent-disabled', 2],
    // J22-3: the seq is a [long] from the first assignment.
    ['[long]$seq', 1],
    // J22-11: ONE OWNER, TWO PATHS. The session-suffixed file is this session's
    // own record; the un-suffixed file is what the backend already reads. Both
    // get the SAME bytes, so either reader sees one truth.
    ["$StatePath = Join-Path $Dir 'clip-state.json'", 1],
    ["$StatePathSession = Join-Path $Dir ('clip-state' + $SessionTag + '.json')", 1],
    ["$CurrentPathSession = Join-Path $Dir ('clip-current' + $SessionTag + '.txt')", 1],
    ["$AckPathSession = Join-Path $Dir ('clip-ack' + $SessionTag + '.json')", 1],
    ['function Write-JsonPair([string]$Canonical, [string]$Scoped, $Object)', 1],
    ['function Write-TextPair([string]$Canonical, [string]$Scoped, [string]$Text)', 1],
    // J22-11: a single owner, so two sessions cannot both write the canonical
    // copy and serve each other's payload.
    ['OwnerWindowSeconds', 1],
    // J22-4: READ-BACK BEFORE THE ACK, so an ack whose seq matches proves
    // clip-current.txt already holds the pasted text.
    ['# TEXT FIRST, THEN THE STATE THAT VOUCHES FOR IT', 1],
    // J22-5: the size test is on the TEXT (chars), not on the escaped JSON file.
    ["$error = 'too-large'", 1]
  ],
  /**
   * J22-14: THE INTERACTIVE-SESSION MCP RELAY.
   *
   * The relay is the fix for the session-0 problem: `ssh … python -m
   * dsh_cua.server --stdio` answers JSON-RPC perfectly from a process that owns
   * no desktop — UIA enumerates zero windows there, and a notepad started by a
   * tool lands in "Services". `--serve` runs the SAME server from a `/it` logon
   * task in the user's session; `--connect` is the byte bridge the SSH command
   * starts. Both halves are this one file, so a rename or a dropped mode breaks
   * the lane silently (the fallback still "works", which is the trap).
   */
  relay: [
    // THE TWO MODES, and the only thing they share: a loopback socket.
    ['--serve', 2],
    ['--connect', 2],
    ["LOOPBACK = '127.0.0.1'", 1],
    ['listener.bind((LOOPBACK, self.port))', 1],
    // LOOPBACK ONLY. A wider bind would let the VM's host bridge drive the
    // desktop; the SSH channel is the door.
    ['LOOPBACK ONLY.', 1],
    // THE PROBE PAIR. Eight bytes is the whole contract (see firstboot's
    // Test-RelayPing for the nine-byte defect this length exists to prevent).
    ["PROBE_PING = b'RELAY_PING'", 1],
    ["PROBE_OK = b'RELAY_OK'", 1],
    ['PROBE_WINDOW = 2.0', 1],
    // ...answered BEFORE the child is spawned and OUTSIDE the session lock, so a
    // health check can neither be blocked by nor block a live MCP session.
    ['PROBE_PING.startswith(buffered)', 1],
    ['conn.sendall(PROBE_OK)', 1],
    ['The probe took no lock', 1],
    // J22-14b: THE PROBE MODE ITSELF. `--ping [port]` replaced the guest-side
    // PowerShell one-liner (~4.6 s cold: a CLR start before the first socket
    // call) with the same handshake inside `py`: one socket, two writes, no
    // child, no session lock, no desktop. The answer is read as EXACTLY eight
    // bytes in a LOOP (a single recv is a bug — TCP may split RELAY_OK), and
    // PING_BUDGET bounds the whole run so a port that accepts and then says
    // nothing cannot hold the client's 12 s probe window.
    ['--ping [port]', 2],
    ['PING_TIMEOUT = 1.5', 1],
    ['PING_BUDGET = 2.0', 1],
    ['def read_probe_answer(sock, deadline):', 1],
    ['def run_ping(port):', 1],
    ["elif arg == '--ping':", 1],
    ['return run_ping(port)', 1],
    ['emit_token(PROBE_OK if ok else PROBE_DOWN)', 1],
    // THE CHILD IS THE REAL SERVER: pipes, no pty, no console on the desktop.
    ["DEFAULT_SERVER = 'python -m dsh_cua.server --stdio'", 1],
    ["'bufsize': 0", 1],
    ['CREATE_NO_WINDOW = 0x08000000', 1],
    // A DEAD CHILD IS RESTARTED FOR THE NEXT CLIENT, and its death is noticed by
    // the reader thread — so a client sees EOF immediately, never a silent hang.
    ['def child(self):', 1],
    ['child-exit', 2],
    ['the next client restarts it', 1],
    // THE TWO ENVIRONMENT KNOBS, both read here (and mirrored by the client).
    ['DEFAULT_PORT = 47999', 1],
    ['DSH_CUA_MCP_RELAY_PORT', 2],
    ['DSH_CUA_MCP_RELAY_LOG', 2],
    ['mcp-relay.log', 2],
    // RAW BYTES AT EVERY HOP: a pty would rewrite CR/LF and mangle the JSON.
    ['def write_all(fd, data)', 1],
    ['os.read(fd, size)', 1],
    ['no encoding decision', 1],
    // =====================================================================
    // WP-A (SOL §3.4) — THE RELAY'S WEDGE WATCHDOG, THE FUNCTIONAL PROBE, THE
    // EVIDENCE OBJECT AND THE FACTS CADENCE.
    //
    // One defect, five hops, and every hop used to be absent: `RELAY_OK` was
    // answered by the ACCEPT LOOP before the session lock, so a relay whose MCP
    // child was wedged — a PostMessage/UIA call that never returns — still said
    // OK; the call waited on the host's timer; and the facts file said nothing
    // about the child at all. `tests/relay-wedge.mjs` drives the behaviour
    // (18 checks); these rows are what a revert breaks. Position in the list is
    // the contract's order (A1..A24 as the SOL numbers them), so a reader can
    // map a red row back to §3.4 without guessing.
    // ---------------------------------------------------------------------
    // A1/A2 — THE TOKEN SET. `RELAY_FN` is deliberately not a `RELAY_PING`
    // prefix: a token spelled RELAY_PING_FN would be answered by the 10-byte
    // cheap path as soon as its prefix arrived, i.e. on bytes that never
    // completed a token.
    ['PROBE_FN = b\'RELAY_FN\'', 1],
    ['PROBES = ((PROBE_PING, \'ping\'), (PROBE_FN, \'functional\'))', 1],
    // A3 — one classifier, two kinds. A second comparison would drift from the
    // token set above on the first added probe.
    ['def _probe_kind(', 1],
    // A4/A5 — PASSIVE accounting. These are the only writers of `pending`; they
    // run AFTER a successful forward, so a byte that was never written can
    // never age into a wedge.
    ['def _observe_outbound(', 1],
    ['def _observe_inbound(', 1],
    // A6/A7 — 20 s, read at CALL time (`wedge_deadline_ms()`), never a module
    // constant captured once: the suite scales the deadline with an env var.
    ['WEDGE_DEADLINE_MS = 20000', 1],
    ['def wedge_deadline_ms(', 1],
    ['DSH_CUA_MCP_WEDGE_DEADLINE_MS', 1],
    // A9/A10/A11/A12 — the thread, its tick, the kill, the answer. All four
    // names are asserted because the ORDER assertion (S1) can only compare
    // calls that exist.
    ['def _wedge_watch(', 1],
    ['WEDGE_TICK_MS = 250', 1],
    ['def _kill_wedged_child(', 1],
    ['def _answer_wedged(', 1],
    // A13/A14/A15 — THE MODEL-FACING CONTRACT: one code string, one JSON-RPC
    // code, one log event. `child-wedged` is what the plugin maps to
    // `code: child-wedged` (index.js) and what says "its effect is UNKNOWN".
    ['child-wedged', 1],
    ['-32000', 1],
    ['event(\'wedge\'', 1],
    // A16..A19 — C3's evidence object: ONE owner (`_fn_evidence`) and the three
    // numbers the unresponsive verdict prints. A `null` stays a null.
    ['def _fn_evidence(', 1],
    ['lastSuccessfulCallAgeMs', 1],
    ['outstandingRequestAgeMs', 1],
    ['childRestarts', 1],
    // A20..A23 — the CADENCE, pure and testable in isolation: one interval for a
    // suspect guest, another for a healthy one, and a back-off after five
    // identical suspect passes (a permanently half-broken desktop must not cost
    // an SSH child every minute forever).
    ['def facts_refresh_interval(', 1],
    ['FACTS_REFRESH_MS = 60000', 1],
    ['FACTS_FULL_REFRESH_MS = 900000', 1],
    ['FACTS_SUSPECT_MAX = 5', 1],
    // A24 — the published interval, under the name the host reads.
    ['refreshMs', 1]
  ],
  provision: [
    ['MARKER=/var/lib/cua-provision', 1],
    ['VERSION="${MARKER_VERSION:-7}"', 1],
    ['apt_ok=$APT_OK', 1],
    ['display=${GEOM:-unknown}', 1],
    ['space_helper=$SPACE_HELPER', 1],
    ['space helper: $SPACE_HELPER', 1],
    ['cua-space', 3],
    ['NOT OK apt_broken=1', 2],
    ['exit 2', 1],
    ['MESA_GL_VERSION_OVERRIDE=4.3FC', 3]
  ],
  android: [
    // The Android layer is deliberately untouched by this change; its marker is
    // the proof that the file is still the same script.
    ['say "OK image=$IMAGE avd=$AVD', 1],
    ['MARKER=/var/lib/cua-android', 1]
  ],
  dockerfile: [
    ['imagemagick', 1],
    ['--no-install-recommends', 1],
    ['docker/cua-vm-space.mjs', 1],
    ['docker/cua-vm-windows-qemu.mjs', 1],
    // the KVM probe ships in BOTH trees (runtime + flat gate tree)
    ['docker/cua-vm-kvm.mjs', 2],
    ['docker/windows-oem/', 1],
    // S1: mtools is a RUNTIME dependency (mformat/mcopy/mdir/mtype), not a build
    // convenience. Without it every Windows create fails at buildSetupImage.
    ['mtools', 2],
    ['docker/windows-oem/Unattend.vbs', 1],
    // K2: THE DESTINATION, not just the source. `docker/windows-oem/` alone is
    // satisfied by a COPY anywhere, including the flat gate tree at
    // /opt/seek-harness/cua-check/ — which is exactly the drift that lets an
    // image build green and then fail the first Windows create with
    // "the OEM payload is missing from this image: /usr/local/share/cua-vm/windows-oem".
    // The destination string is pinned here AND cross-checked against the
    // supervisor's runtime constant in the K2 assertion below.
    ['docker/windows-oem/ /usr/local/share/cua-vm/windows-oem/', 1],
    ['--chmod=0644 docker/windows-oem/', 1],
    // K3: THE DIRECTORY MODE. `--chmod=0644` applies to the directories the COPY
    // CREATES, so the destination arrived `drw-r--r--` and uid 1000 could not
    // traverse a payload that was provably in the image: `ls` said "Permission
    // denied" and writeOemPayload failed on readFileSync (or worse, existsSync
    // reported "missing"). The fix is an explicit 0755 directory created for the
    // runtime uid BEFORE the copy, and the copy itself carrying that ownership.
    // These three needles are the fix; the uid-1000 proof RUN is pinned by K4.
    ['install -d -m 0755 /usr/local/share/cua-vm', 1],
    ['chmod -R a+rX /usr/local/share/cua-vm/windows-oem', 1],
    ['--chown=1000:1000 --chmod=0644 docker/windows-oem/', 1],
    ['install -d -m 0755 /opt/seek-harness/cua-check', 1],
    // K4: THE PROOF RUNS AS THE RUNTIME USER. A needle list cannot say "and a
    // uid-1000 process can traverse it"; this RUN does, for both the runtime path
    // and the fallback tree, and fails the BUILD instead of the first create.
    ['setpriv --reuid=1000 --regid=1000 --clear-groups', 3],
    ['is not traversable by uid 1000', 1],
    ['unreadable by uid 1000', 2],
    ['ovmf swtpm', 1],
    ['tools/check-cua-vm.mjs /opt/seek-harness/check-cua-vm.mjs', 1],
    ['node /opt/seek-harness/check-cua-vm.mjs --root /opt/seek-harness/cua-check', 1],
    // WP-6/WP-7: BOTH NEW FILES SHIP — at their RUNTIME paths and in the flat
    // gate tree the build re-runs this very script against.
    ['COPY --chmod=0755 docker/cua-vnc-clip.mjs /usr/local/bin/cua-vnc-clip.mjs', 1],
    ['COPY --chown=1000:1000 --chmod=0644 docker/cua-clip-agent.ps1 /usr/local/share/cua-vm/windows-oem/cua-clip-agent.ps1', 1],
    // The flat-tree COPY line is asserted SEMANTICALLY below (J1-6b): an
    // adjacency needle (`cua-vnc-clip.mjs Dockerfile …`) broke the moment
    // `docs/windows-iso-sources.md` was inserted between the two entries, even
    // though the tree was still correct. The loose needles here only say the
    // files are mentioned and the agent reaches BOTH destinations.
    ['docker/cua-vnc-clip.mjs', 1],
    ['docker/cua-clip-agent.ps1 /opt/seek-harness/cua-check/', 1],
    // J22-14: THE RELAY SHIPS ON BOTH PATHS AND IS PROVEN READABLE. The runtime
    // COPY puts it where the supervisor stages it from; the flat-tree COPY is what
    // makes the in-image gate (which reads the file by name) able to check it; and
    // the uid-1000 loop is the proof — a COPY that lands unreadable is the K6
    // defect one file over.
    ['COPY --chown=1000:1000 --chmod=0644 docker/cua-mcp-relay.py /usr/local/share/cua-vm/windows-oem/cua-mcp-relay.py', 1],
    // the flat-tree COPY is two lines above/below its neighbour depending on
    // where the relay was inserted, so presence is asserted here by COUNT and the
    // flat SET is proven semantically by J1-6b (adjacency needles broke the
    // clipboard agent's line once already).
    ['docker/cua-mcp-relay.py', 2],
    // WP-1/6.5: the permission loop reads the payload AS uid 1000, so a file the
    // image ships but the loop does not name is a file nobody proved readable —
    // and the guard is exactly the one a firstboot would then fail to stage. The
    // order inside the loop follows the COPY line above it.
    ['cua-clip-agent.ps1 cua-mcp-relay.py cua-relay-guard.ps1; do', 1],
    // ...and the FLAT gate tree carries it, like every file the gate reads: this
    // gate now resolves cua-relay-guard.ps1 by name (NEEDLES.oemGuard), so the
    // in-image run would find "file not found" without this COPY member.
    ['docker/windows-oem/cua-relay-guard.ps1 docker/cua-mcp-relay.py', 1],
    // ---------------------------------------------------------------------
    // CUA_CLI_VERSION: THE CLI IS RESOLVED AT BUILD TIME, NOT BAKED AS A FIXED
    // RELEASE. The step used to be `ARG CUA_CLI_VERSION=0.7.0` with the tarball
    // built from that one string, so every image shipped whatever release was
    // current the day the line was written. Now the default is `latest` and the
    // RUN resolves it from the releases API; a pinned value still goes through
    // verbatim. These rows are what a revert to a frozen ARG breaks, and the
    // LAST one is the point: the URL template must spend the RESOLVED variable
    // (`$cua_version`), not the build arg, or "latest" would resolve a version
    // and then download a different one.
    //
    // The failure paths are pinned too: the API being unreachable and the payload
    // carrying no `cua-sdk-v*` tag both have to FAIL the build. A `curl || true`
    // or a fallback tag turns a broken release into an image that looks fine.
    // tools/cua-cli-version.mjs executes this RUN fragment against a fixture so
    // the resolution itself is proved without a docker daemon (ci-gates).
    ['ARG CUA_CLI_VERSION=latest', 1],
    ['https://api.github.com/repos/trycua/cua/releases?per_page=100', 1],
    ['cua_version="${CUA_CLI_VERSION}"', 1],
    ['[ "$cua_version" = "latest" ]', 1],
    ['s/.*"cua-sdk-v//', 1],
    ['releases/download/cua-sdk-v${cua_version}/cua-cli-${cua_version}-linux-${cua_asset}.tar.gz', 1],
    ['the GitHub releases API did not answer', 1],
    ['no cua-sdk-v* release', 1]
  ],
  client: [
    // the four labels are a contract: automation reads them
    ["'Enable GPU'", 1],
    ["'Enable REA'", 1],
    ["'Install Android'", 1],
    // kind + version
    ["value: 'linux' }, 'Linux (Cua guest)'", 1],
    // F2: the kind picker and the provisioning blurb must say what runs now.
    ['Windows (direct QEMU)', 1],
    ["disabled: state.windows?.ok !== true", 1],
    ['windowsVersion', 2],
    ["kind: 'windows'", 1],
    // the shutdown/suspend split
    ["'Shutdown'", 1],
    ["'Suspend'", 1],
    ["'Clean up'", 1],
    ['Reveal password', 1],
    ["'installing'", 1],
    // the space line is shown, not hidden
    ["api('space'", 1],
    ['rea: false', 1],
    ['rea: draft.rea', 1],
    // B1: THE PANEL SENDS THE REQUESTED SPEC, and NEVER clamps it in the client.
    // `Math.max(6, draft.memory)` / `Math.max(64, draft.diskGb)` in the create
    // body is what made a 20 GB / 4 GB request arrive as 64 GB / 6 GB.
    ['cpu: draft.cpu,\n                memory: draft.memory,\n                diskGb: draft.diskGb,', 1],
    // B3: THE INSTALLING ROW SHOWS THE PROGRESS PICTURE — elapsed, the serial
    // tail, the readiness signals, and how the user knows it finished.
    ["api('windowsStatus'", 1],
    ['const serialTail = Array.isArray(info?.serialTail)', 1],
    ['elapsed ${elapsed} min of', 1],
    ['watching: ${(readiness.signals ?? []).join', 1],
    ['badge flips to Ready when readiness answers', 1],
    ['serialTail.join', 1],
    // B3: no-install-lines case is stated, not silently blank.
    ['Serial log: no lines yet', 1],
    // ADD-ON: FORCE DELETE affordance, with the destructive confirmation copy.
    ["h('button', {", 1],
    ['Force delete', 2],
    ['This kills the VM process and removes its disks even if the delete reported failures', 1],
    ['api(\'delete\', { name, force: true })', 1],
    // ...and a STUCK windows install says why the normal delete is not enough.
    ['This install is marked installing but QEMU is not running', 1],
    // F4: THE PANEL AFFORDANCES.
    //
    // * Shutdown/Suspend are offered for an INSTALLING Windows row too — with a
    //   confirm that says it aborts the install (hiding them left Force delete
    //   as the only way out of a 40-minute install).
    // C20: RENDER, THEN DISABLE WITH A REASON. `canPower` is the HEAD
    // expression kept as a greppable VALUE (it decides the title's reason), and
    // BOTH buttons are always rendered — `disabled: !canPower || busy` — so a
    // powered-off/suspended row still shows Start, Suspend and Shutdown.
    ['const canPower = (ready || (windows && installing))', 1],
    // The disable half (`disabled: !canPower || busy`, BOTH buttons) is asserted
    // by the L6 block below, which counts the two occurrences — one assertion,
    // not a needle row. The table's arithmetic, D6-corrected and then
    // J1-corrected (it read `1338 + 1 + 7 = 1345`, which is 1346 — and then
    // claimed the split-button needle left while flatRequired arrived, which
    // would net out): the split-button needle was REPLACED one-for-one (the row
    // count is identical) and flatRequired is ONE assertion for the whole list
    // (it adds no row), so the true derivation is:
    //   1338 + 7 (L1..L7) = 1345
    ['THIS ABORTS THE WINDOWS INSTALL', 1],
    ['Mid-install this PAUSES Windows Setup', 1],
    // * The wait is VISIBLE: a one-second ticker plus the row's own state, so a
    //   120 s ACPI wait no longer looks like a hung button.
    ['setWaitTick((value) => value + 1)', 1],
    ["const withWait = (text) => (waitedSec > 0 ? `${text} ${waitedSec}s` : text)", 1],
    ['Waiting for ${name} to power off', 1],
    // * The result is SURFACED: a mayBeTorn answer and the supervisor's own
    //   detail sentence reach the note instead of a silent success.
    ['payload?.mayBeTorn === true', 1],
    // U1: HIDE IS A CLEAR. The button toggles (the label already followed the
    // state, the click did not), the secret state is deletable, and the reveal
    // note no longer carries the password.
    ["onClick: () => (secret[name] ? hidePassword(name) : void revealPassword(name))", 1],
    ['const hidePassword = (name) => {', 1],
    ['setSecret((current) => hideSecretEntry(current, name))', 1],
    ['function hideSecretEntry(current, name) {', 1],
    ['delete next[name]', 1],
    ['function noteAfterHide(note, name, value) {', 1],
    ['password revealed below', 1],
    ['module.exports.__test', 1],
    // U3: THE BUTTON IS NOT A TERMINAL. A one-shot exec form labelled
    // "Terminal" promised a shell; there is no pty on either backend.
    ["}, 'Run command'),", 1],
    ['Not an interactive terminal: there is no pty', 1],
    ['ONE command (sh -c on Linux, cmd.exe on Windows)', 1],
    // U2: THE CLIPBOARD SECTION (the only clipboard path that works here).
    ["h('div', { style: { ...S.muted, fontWeight: 600 } }, 'Clipboard')", 1],
    ["'Paste to guest'", 1],
    ["'Read guest clipboard'", 1],
    ["api('windowsClipboardSet'", 1],
    ["api('windowsClipboardGet'", 1],
    ['there is no clipboard agent in the guest', 1],
    // U4: the MEASURED free space joins the spec line, with the warning visible.
    ["api('windowsFreeSpace'", 1],
    ['${space.line}', 1],
    ['space.belowFloor === true', 1],

  ],
  index: [
    // =====================================================================
    // WP-7.3 / WP-5 — ATTACHING, THE FACTS, AND THE RECEIPTS ON THE TOOL
    // SURFACE (SOL §7.3). Five surfaces get the same vocabulary; these needles
    // are the ones a revert breaks, not a restatement of the field names:
    //
    //   * `code: 'attaching'` (2) — the guard (`windowsGuardDecision`) and the
    //     reveal (`revealWindowsTools`). The doctor's `viewer` INHERITS the
    //     third occurrence from `targetMatchFor`, which is why the count is 2
    //     and not 3: a branch added only to `targetMatchFor` would make the
    //     doctor say "attaching" while the tools still answer `not-the-target`,
    //     and that is the lie this code exists to end.
    //   * `retryAfterMs` (2) — the doctor's `attach` payload AND the reveal /
    //     sentence. A bound that exists only in the doctor is a bound the tool
    //     surface never hands the model, which is the retry the report asked
    //     for.
    //   * `attachingFor` (2) — the helper plus at least one call site. One
    //     definition and zero calls is a vocabulary nothing speaks; the count
    //     catches the revert that keeps the function and drops the branch.
    //   * `attaching to ` (1) — the SENTENCE ("attaching to <name>: the SSH
    //     handshake is in flight … retry in ~Ns"), so `not-the-target` cannot
    //     come back as this state's words. The trailing space keeps the needle
    //     on the phrase the verdict prints.
    //   * `elementLaneOk` (2) / `workDirWritable` (2) — each fact appears in
    //     the doctor description AND in the verdict branch that turns it into
    //     advice. A description alone documents a dead lane nobody warns
    //     about; a branch alone hides the fallback in prose the model never
    //     reads (WP-5.6 / WP-5.8).
    //   * `scaleFix` (1) — the doctor description lists it, because the guest's
    //     scale mismatch is EXPECTED and a model that reads the numbers without
    //     that sentence clicks from image pixels.
    //   * `win32_mcp_shots` (1) / `dedupe by pid` (1) — Appendix C's two facts
    //     repeated in the plugin's own surface. The registry note rides the
    //     guest description; the prompt is what a model sees before its first
    //     call, so both spellings must exist HERE, not only in `win-mcp.js`.
    //   * `windowsToolContract` (2) — the registration expression and the
    //     `WIN_MCP_AUX.tools` map (WP-5.7). The same note on both paths is the
    //     whole point; one site means `windows_desktop` can disagree with the
    //     registry it just published.
    ["code: 'attaching'", 2],
    ['retryAfterMs', 2],
    ['attachingFor', 2],
    ['attaching to ', 1],
    ['elementLaneOk', 2],
    ['workDirWritable', 2],
    ['scaleFix', 1],
    ['win32_mcp_shots', 1],
    ['dedupe by pid', 1],
    ['windowsToolContract', 2],
    ["name: 'cua_vm_start'", 1],
    ["name: 'cua_vm_shutdown'", 1],
    ["name: 'cua_vm_gc'", 1],
    ["name: 'cua_vm_doctor'", 1],
    ["op: 'vmWindowsCreate'", 1],
    ["op: 'vmGc'", 1],
    ["op: 'vmDoctor'", 1],
    // F1: THE `/cua` SWITCH ANSWERS `suspend`. Shutdown, stop and gc had cases;
    // `suspend` did not, so the panel's Suspend button fell through to
    // `default` and answered 404 "unknown action: suspend" — a plugin-dispatch
    // gap the tool (`cua_vm_suspend`) never hit because it calls the supervisor
    // directly. The case must send the SAME op name the tool does.
    // ...and C17: the case passes its OWN budget, so the route can never inherit
    // the 30-minute socket default (R4).
    ["case 'suspend': return send(200, { ok: true, ...(await call({ op: 'suspend', ...(await body()) }, routeTimeoutMs('suspend'))) })", 1],
    ["const result = await call({ op: 'suspend', name: args.name })", 1],
    // R1: a partial delete prints what failed AND what was kept on purpose.
    ['- KEPT ${item.target}: ${item.reason}', 1],
    // B3: the create result must not describe the container backend.
    ['Live view: ${answer.console} (noVNC over QEMU VNC, never published raw).', 1],
    // F2: the create result must not describe the container backend either.
    ['runs commands over SSH in cmd.exe', 1],
    // D11: a stop/delete takes the guest's tools away within 5 s.
    // WP-5: THE STATE POLL IS THE PUSH (10 s, `DSH_CUA_MCP_STATE_POLL_MS`), and
    // the bind-triggered sync is throttled so an exec cannot become a poll.
    ['const WIN_MCP_DEFAULT_POLL_MS = 10_000', 1],
    ['now - WIN_MCP_AUX.lastBindSyncAt > 5000', 1],
    ['- FAILED ${item.target}: ${item.detail}', 1],
    // the port answer is url + localPort; `target` was never in the payload
    ['result.url', 1],
    ['result.localPort', 1],
    // guided refusal for a Windows computer
    ['not available', 1],
    ["rea: { type: 'boolean'", 1],
    ['input.rea === true', 1],
    // ADD-ON: FORCE DELETE on the tool surface — the param, the confirmation
    // rule (destructive: ask first), and the honest report when items survive.
    ["force: { type: 'boolean'", 1],
    ['force: args.force === true', 1],
    ['Call cua_vm_destroy again with force: true', 1],
    // B3: `cua_vm_status` polls a Windows install so an agent reads the same
    // sentence as a human (elapsed, serial tail, readiness).
    ["op: 'vmWindowsStatus', name, tail: 5", 1],
    ['serial (last ${info.serialTail.length})', 1],
    // U2/U4: the /cua switch forwards the three new calls, and the op names are
    // the supervisor's (so the panel and the model cannot drift).
    ["case 'windowsClipboardSet': return send(200, { ok: true, ...(await call({ op: 'vmWindowsClipboardSet'", 1],
    ["case 'windowsClipboardGet': return send(200, { ok: true, ...(await call({ op: 'vmWindowsClipboardGet'", 1],
    ["case 'windowsFreeSpace': return send(200, { ok: true, ...(await call({ op: 'vmWindowsFreeSpace'", 1],
    // the prompt carries the invariants
    ['SPACE:', 1],
    ['SHUTDOWN vs SUSPEND:', 1],
    ['WINDOWS (`kind: "windows"`', 1],
    // WP-5: THE GATE IS FOUR LAYERS, AND ALL OF THEM LIVE IN THIS FILE.
    ['mcp__windows__', 2],
    ['windows_desktop', 1],
    ['windows_mcp_doctor', 1],
    ["ctx.inject(['tools'], (scoped) =>", 1],
    ['scoped.tools.guard((execution) => windowsGuardDecision(execution))', 1],
    ['tools.restrict({ deny })', 1],
    ['registrations: new Map()', 1],
    // THE PER-TOOL BUDGET IS A TIMEOUT THE MODEL CAN BRANCH ON (R3, C5).
    //
    // RETIRED BY WP-E: this row used to pin
    // `execute: boundedExecute(publicName, WIN_MCP_ATTACH_TIMEOUT_MS, undefined,`
    // — the 45 s constant doing the handshake AND every per-call budget. WP-C
    // deleted that line, and the row only stayed green because WP-C left the old
    // literal spelled out inside a doc comment ("the line this replaces is kept
    // verbatim on ONE line because the repository gate pins it"). A needle that a
    // comment can satisfy pins documentation, not wiring: reverting the budget
    // while keeping the comment would have been green. It is replaced by the line
    // that actually executes, whose `declaredMs` comes from the ladder (C5) and
    // whose 250 ms lead keeps `code: relay-unresponsive` in front of the harness
    // guard. Mutation coverage: M-10 scales the ladder's input; M-18 names the
    // derived retry budget.
    ['const execute = boundedExecute(publicName, declaredMs, undefined,', 1],
    // the cheap state read, and the removal path that takes the names away
    ['vmWindowsMcpState', 1],
    ['vm-removed', 1],
    ['DSH_CUA_MCP_STATE_POLL_MS', 1],
    // the Computer Use grant, in memory, per session
    ["action !== 'cua-grant'", 1],
    // J22-15: THE GRANT STARTS ON. The off default cost every first-boot test a
    // manual panel step; the grant is a per-session in-memory safety default, not
    // a boundary (the page API, the SSH-only guest bridge, the guard and the
    // target binding are). `grant-off` stays a real refusal code — it is now the
    // answer to an EXPLICIT deny, which is what `tests/windows-mcp-gate.mjs`
    // drives (default read from the route, deny posted, refusal asserted).
    ['grantDefault: true,', 1],
    ['default: WIN_MCP_AUX.grantDefault === true ? \'on\' : \'off\'', 2],
    ['function teardown(reason)', 1],
    // J20-4: THE IN-FLIGHT ATTACH TICKET. `WIN_MCP.name` is '' for an attach
    // still in its 45 s handshake, so a delete that landed mid-handshake skipped
    // teardown and 19 schemas of a deleted computer reappeared until the next
    // beat. The ticket carries the target name and is killed by teardown, and
    // every write re-checks the generation.
    ['inflightTicket: null', 1],
    ['WIN_MCP.generation += 1', 1],
    ['const isDead = () => ticket.dead === true || WIN_MCP.generation !== generation', 1],
    ['if (isDead()) { abort(', 3],
    // DEFECT 8: THE HANDSHAKE THE TICKET CANNOT REACH. `WIN_MCP.client` is only
    // assigned AFTER `connect()` answers, so a teardown inside the 45 s handshake
    // had no handle: the ticket blocked registrations but the SSH child lived
    // until its request timer. Every client parked in `inflightClients` is closed
    // by `teardown()`, and the attach deletes itself when it settles. The ORDER
    // (`add` BEFORE `await client.connect()`) is asserted semantically (JURY-R2)
    // — these needles can only prove the four call sites exist.
    ['inflightClients: new Set(),', 1],
    ['WIN_MCP_AUX.inflightClients.add(client)', 1],
    ['for (const pending of WIN_MCP_AUX.inflightClients) {', 1],
    ['WIN_MCP_AUX.inflightClients.clear()', 1],
    ['if (ownClient !== null) WIN_MCP_AUX.inflightClients.delete(ownClient)', 1],
    ['function forgetSessionTarget(name)', 1],
    ['const inflightName = WIN_MCP_AUX.inflightTicket === null', 1],
    // J20-5: CROSS-SESSION TARGETING. One process, one attached computer, many
    // sessions: the tools may only be used by the session that bound THAT
    // computer, and the refusal is structured.
    ["code: 'not-the-target'", 2],
    ['this session is bound to ${row.name}; the Windows bridge is attached to ${attached}; bind this session first', 1],
    ['via: \'implicit-single-target\'', 1],
    ['function knownWindowsComputers()', 1],
    ['function targetMatchFor(agent)', 1],
    // J20-3: THE STATE BUS IS CONSUMED, NOT ONLY POLLED. One long-lived
    // subscription on the same unix socket; a supervisor without the op answers
    // `unknown op` (or closes without `ready`) and the 10 s poll does the job.
    ["socket.write(`${JSON.stringify({ op: 'subscribe', events: ['vm-state', 'vm-removed'] })}\\n`)", 1],
    ['function startWindowsStateStream(socketPath)', 1],
    ['function handleVmEvent(event)', 1],
    ['const WIN_MCP_STREAM = {', 1],
    // the doctor answers the new questions too
    ["reason: 'implicit-single-target'", 1],
    ['pendingName: WIN_MCP_AUX.inflightTicket === null ? null : String(WIN_MCP_AUX.inflightTicket.name ?? \'\')', 1],
    // J22-14: THE DOCTOR REPORTS THE LANE IT TOOK. The facts come from the
    // client's own SYNCHRONOUS, side-effect-free doctorFacts() — the doctor has
    // its own probe budget and must not open a second SSH session — and the
    // sentence is built from the SAME object that is spread into the payload, so
    // the text and the fields cannot disagree. `transportText` is null, never a
    // guess, when nothing was attached in this process.
    ['const transportFacts = WIN_MCP.client?.doctorFacts?.() ?? null', 1],
    // WP-3.1/3.3 — THE VERDICT LADDER, NOW FOUR VALUES (C12).
    //
    // RETIRED BY WP-E: this row used to pin the three-way expression
    // `... (blind === true ? 'blind' : 'ok')`. WP-C replaced it with the
    // four-way ladder and kept the OLD expression verbatim inside a comment
    // ("The revert-proof needle the repository gate pins for this field still
    // spells the OLD three-way expression, verbatim, on the next line"), so the
    // row was satisfied by documentation while the field could have been
    // reverted to `ok` for a wedged child. The replacement pins the real
    // expression: `leaking → blind → unresponsive → ok`, with the leak test's own
    // expression still in front (a leak while offline outranks everything).
    // `unresponsive` is the fourth status — "attached through the relay, but its
    // MCP child did not answer an initialize/tools/list round trip" — and it is
    // the value that used to read `ok` through a seven-minute outage.
    ["status: online !== true && leaks.length > 0 ? 'leaking' : (blind === true ? 'blind' : (unresponsive === true ? 'unresponsive' : 'ok')),", 1],
    ['const transportText = transportFacts === null', 1],
    ['? (blind === true ? windowsTransportLine(null, blindReason) : null)', 1],
    ['windowsTransportLine(transportFacts, blindReason)', 1],
    // ...the closed set the reason comes from (`§4.6`): six values, one owner,
    // and the doctor's `blindReason` is one of them or null.
    ['const BLIND_REASONS = Object.freeze([', 1],
    ['const BLIND_REASON_SET = new Set(BLIND_REASONS)', 1],
    ['function classifyBlindReason({ transportFacts, repairEnabled })', 1],
    ['const blindReason = lane.blindReason', 1],
    // the PAYLOAD field, not any of the six local mentions: constructor key and
    // verdict are adjacent there, so the pair is what says "the doctor sends it".
    ['blind,\n    blindReason,', 1],
    ['function windowsLaneVerdict(online, transportFacts)', 1],
    ['function windowsBlindAction(reason)', 1],
    // THE MEASURED GATE ON THE REPAIR RECORD (rules 4, 5 and 6). A record's
    // `session`/`hash` are only evidence when the attempt MEASURED them; the
    // base defaults (`session: 0`, `hash: ''`) used to answer "no console
    // session" and "the guest has no relay" for attempts that never reached the
    // guest. The four facts below are the fix, and rule 6 is the one a "helpful"
    // refactor deletes first (it looks redundant next to the sentence it checks):
    //   * `measured` is read from the record, never inferred from a value;
    //   * `measuredSession` / `hashMeasured` narrow it per field, so a client
    //     that ships only `measured` still classifies (absent = not contradicted);
    //   * rule 6 keeps the guest's OWN sentence, but only when that attempt
    //     measured something — otherwise any unmeasured producer borrowing the
    //     vocabulary would short-circuit the ladder.
    ['const measured = repair !== null && repair.measured === true', 1],
    ['const measuredSession = measured && sessionMeasured', 1],
    ['const hashMeasured = repair?.hashMeasured !== false', 1],
    ['const rawHash = measured && hashMeasured', 1],
    ['if (measured && recorded !== null) return recorded', 1],
    ['recordBlindReason(repair)', 2],
    // THE RELAY-ANSWERED PREDICATE, AND THE RULE THAT KEEPS THE DOCTOR FROM
    // CONTRADICTING ITSELF. A measured successful repair (or the client's
    // coherent up pair) means the relay is SERVING while the lane move is still
    // in flight; without rule 7 the payload said "up" and "blind" at once and
    // told the model to repeat the repair that had just worked.
    ['function windowsRelayAnswered(facts)', 1],
    ['function windowsLaneUpgrading(facts)', 1],
    ['if (windowsRelayAnswered(transportFacts) === true) return null', 1],
    // ...and the measured-session rule RANKS ABOVE the probe token: a probe
    // cannot see a console, so a stale RELAY_SKEW must not relabel a measured
    // session=0. That ORDER is asserted semantically (JURY-R1) — a needle can
    // only prove both lines exist.
    ["if (measuredSession === 0) return 'no-interactive-session'", 1],
    // DEFECT 1/2, THE OTHER HALF: "UP, BUT THE CHILD HAS NOT MOVED YET" is its
    // own verdict, not `blind`. When the relay ANSWERED (a measured repair, or the
    // client's coherent up pair) but `transport` is still `session-0-direct`, the
    // lane move is in flight for one poll; calling that blind makes the doctor say
    // "up" and "blind" together and sends the model to repeat a repair that just
    // worked. Three facts: the predicate input, the verdict field, and the two
    // sentences that must say "ANSWERED" instead of the DOWN one.
    ['const upgrading = online === true && transport !== \'interactive-relay\'', 1],
    ['laneUpgrading: lane.laneUpgrading === true,', 1],
    ['windows mcp transport: session-0-direct, relay ANSWERED;', 1],
    // THE EVIDENCE ITSELF IS NAMED, and it is ONE of two measured facts — never a
    // guess, because the sentence's whole job is to say WHY no repair is needed.
    ['const evidence = transportFacts?.relayOk === true', 1],
    // ...and a successful repair is evidence only while it is FRESH: two throttle
    // windows long (the lane move rides the next poll), short enough that an
    // ancient `ok=1` cannot excuse a lane that never moved. The trailing newline
    // is part of the needle on purpose: `120_000` is a PREFIX of `120_000_000`,
    // so a value that turns the window into "never expires" would satisfy the
    // bare literal (proven by mutation). The boundary is the fact.
    ['const RELAY_ANSWERED_FRESH_MS = 120_000\n', 1],
    ['...(transportFacts ?? {})', 1],
    ['    transportText,', 1],
    ['windows mcp transport: interactive-relay (port ${facts.relayPort}, relay ${relay})', 1],
    ["if (facts.transport === 'session-0-direct')", 1],
    ['windows mcp transport: session-0 fallback: ${detail}', 1],
    // ...and the sentence's REASON comes from the client's alias, not from a
    // re-derivation: this read is the other half of the `transportReason`
    // contract above. Drop it and a blind attach loses WHY it is blind (the line
    // falls back to "interactive relay not running", which is one cause of six).
    ["const recorded = String(facts.transportReason ?? '').trim()", 1],
    ['not attached yet (no lane decided in this process)', 1],
    // J22-15: THE RELAY HEAL RIDES THE 10 s POLL. The client's own upgrade watch
    // is one 15 s window at connect time; a relay whose logon task starts AFTER
    // that window was never seen, and the session stayed blind for its whole
    // life on a computer that had a working relay. Every poll beat that leaves
    // the bridge CONNECTED on the blind lane now nudges the client's own
    // `maybeUpgradeTransport()`: no second SSH session, no second decision, and
    // its 60 s throttle + in-flight guard are what bound the cost. The env
    // escape hatch is honoured HERE TOO, so `DSH_CUA_VM_WIN_MCP_UPGRADE=0`
    // silences the slow path as well as the 15 s watch.
    ['function nudgeRelayUpgrade(reason = \'poll\')', 1],
    ["if (WIN_MCP.client?.state?.transport !== 'session-0-direct') return false", 1],
    ["if (String(process.env.DSH_CUA_VM_WIN_MCP_UPGRADE ?? '1') === '0') return false", 1],
    ['void Promise.resolve(WIN_MCP.client?.maybeUpgradeTransport?.()).catch(() => {})', 1],
    // ...from the two places a poll can land: the already-attached tick and the
    // fresh attach, because a fresh attach can come up blind too.
    ['nudgeRelayUpgrade(reason)', 2],
    // WP-10: THE DOCTOR'S STALE PROBE (`online: true / state: ready` seconds
    // after a power-off). The verdict is built FIRST from the stream's newest
    // vm-state and the plugin's own state; a live probe is DETAIL, aged by
    // `probeAgeMs`, flagged `stale` past WIN_MCP_PROBE_STALE_MS and `overridden`
    // when the plugin's answer beat it. There is no bare `probe` in
    // `onlineSource`, on purpose: a probe alone may never hold a dead bridge up.
    ['const WIN_MCP_PROBE_STALE_MS = 5000', 1],
    ['const WIN_MCP_NOT_ONLINE_STATES = new Set([', 1],
    ['function recordVmState(name, state)', 1],
    ['WIN_MCP_STREAM.stateLog.push(row)', 1],
    ['function newestVmStateFor(names)', 1],
    ['// ---- THE VERDICT COMES FIRST (THE STALE-PROBE FIX) ----', 1],
    ['const streamSaysOffline = streamState !== null', 1],
    ['const online = streamSaysOffline !== true && WIN_MCP.online === true', 1],
    ['const onlineSource = streamSaysOffline === true', 1],
    ['const probeAgeMs = probeAt > 0 ? Math.max(0, Date.now() - probeAt) : null', 1],
    ['const probeStale = online !== true && probeAgeMs !== null && probeAgeMs > WIN_MCP_PROBE_STALE_MS', 1],
    ['const probeOverridden = online !== true && probeFacts.online === true', 1],
    ['probeAgeMs,', 1],
    ['overridden: probeOverridden', 1],
    // THE GATE IS MEASURED, NOT ASSERTED (J20-3/WP-3.7). `gate: 'restrict+guard'`
    // was a CONSTANT — a doctor claiming a fully armed gate on a process where
    // `tools.restrict()` or `tools.guard()` had THROWN. The install's own failure
    // record now decides: both halves armed only when nothing failed, `partial`
    // otherwise, with the reason beside it. A revert to the constant is exactly
    // the "verdict cannot lie" defect this release exists to end, so all three
    // facts are pinned (the verdict, its detail, and the error it reads).
    ["gate: WIN_MCP_AUX.gateError === '' ? 'restrict+guard' : 'partial'", 1],
    ["gateDetail: WIN_MCP_AUX.gateError === '' ? '' : WIN_MCP_AUX.gateError", 1],
    ['gateError: WIN_MCP_AUX.gateError', 1],
    // WP-3.7/§4.8 — IDENTITY TRAVELS, and it is a GATE-ENFORCED equality, not a
    // comment: `PLUGIN_VERSION` is the value the cross-file assertion at the end
    // of this file compares against `plugins/dsh-cua-vm/package.json`. Both
    // doctors report it, so "the fix is not in your plugin" stops being a guess.
    // WP-7.1/WP-8.1: the RELEASE LITERAL tracks the identity — this is the one
    // pre-existing needle whose payload changes with a version bump (the pair
    // still has to agree: the cross-file assertion below compares both files, so
    // a bump in one alone stays red). 0.2.3 is the cold-boot round (CB/WP-1..WP-6:
    // the 90 s boot-race window, the sixth probe reason, the payload-freshness
    // staging and `payload.stale`, the absent-facts code and the narrowed
    // `leaks`); 0.2.2 shipped the session-5 package (WP-A..WP-E), and 0.2.1 the
    // WP-1..WP-8 round before it.
    ["export const PLUGIN_VERSION = '0.2.3'", 1],
    ['pluginVersion: PLUGIN_VERSION', 1],
    // WP-3.4/C4 — A HIDDEN BRIDGE INVENTORIES NOTHING. Nineteen names used to come
    // back from a reveal that had FAILED (offline, grant off, wrong target), which
    // is how a doctor could show a full tool list for a computer with no schema.
    // `tools` exists only when the reveal really happened; otherwise `[]` + `code`.
    ['tools: revealed === true', 1],
    // WP-3.4/§4.7 — AUTO-REVEAL ON BIND, GRANT STILL THE VETO. A session that binds
    // a computer is revealed in the same beat, so a first desktop call does not
    // need a manual round trip; a session that binds NOTHING stays
    // `reveal-required`, and a bind of a Linux guest reveals nothing (the gate
    // still requires the Windows target to match).
    ['if (grantFor(agent) === true) markRevealed(agent)', 1],
    ['const guiNote = \'desktop automation uses the MCP windows tools; cua_vm_gui screenshots are the noVNC stream, not a framebuffer\'', 1],
    // =====================================================================
    // WP-C (SOL §5.4) — THE PLUGIN SURFACE: the budget ladder, the two tool
    // sets, the `[DEGRADED]` prefix, `desktopWarning`, the fourth status.
    //
    // WP-C added NO gate assertion of its own (§8: A–D must leave the gate at
    // exactly 1237), so these are the rows its behaviour is pinned by — and they
    // land here, in WP-E, with the two rows they REPLACE (see the note under the
    // retired `execute: boundedExecute(...)` literal above). WP-C's own proof is
    // `tests/windows-mcp-gate.mjs` (C-1..C-16, 115 checks).
    // ---------------------------------------------------------------------
    // C1..C3 — THE LADDER'S INPUT. One env var, read at CALL TIME, clamped to
    // 200..120000; every other rung is DERIVED from it (S2 asserts the
    // derivation and the guest-side ordering, which a needle cannot).
    ['const WIN_MCP_CALL_TIMEOUT_MS = 25_000', 1],
    ['function winMcpCallTimeoutMs()', 1],
    ['DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS', 1],
    // C4/C5 — THE TWO FROZEN SETS. Their exact membership and their
    // DISJOINTNESS are asserted (S3), because `Object.freeze` is not what makes
    // them disjoint and a list is not a set.
    ['const WIN_MCP_CALL_RETRY_TOOLS = Object.freeze([', 1],
    ['const WIN_MCP_ELEMENT_LANE_TOOLS = Object.freeze([', 1],
    // C6 — the retry budget is a DERIVATION, never an independent constant
    // (M-18 names this exact declaration).
    ['const WIN_MCP_CALL_RETRY_BUDGET_MS', 1],
    // C7/C8 — the frozen sentence and the prefix itself. One string, printed by
    // five tools and by nothing else (S4 asserts the shape with it).
    ['const DEGRADED_ELEMENT_LANE_SENTENCE =', 1],
    ['[DEGRADED]', 1],
    // C9 — the FOUR-argument description template: the facts are an ARGUMENT
    // (the registration loop must not cost an SSH child per tool).
    ['function windowsToolDescription(guestName, guestDescription, computerName, facts)', 1],
    // C10/C11 — the two routable codes the model branches on.
    ['relay-unresponsive', 1],
    ['child-wedged', 1],
    // C12 — C9's field on BOTH surfaces (the reveal and the doctor): one string,
    // computed once, so the two can never disagree. `min 2` is the two FIELDS.
    ['desktopWarning', 2],
    // C13 — the unmeasured branch's own condition: `measured:false` is UNKNOWN,
    // and S5 asserts it comes FIRST.
    ['measured !== true', 1],
    // =====================================================================
    // CB (cold-boot round, WP-6) — THE DOCTOR HALF: the seventh blind reason,
    // the offline `leaks` residue, the payload truth fields.
    //
    // §4.1's rows 13-21. `leaks` narrowing is the round's ONE behaviour change
    // (C5) and it is deliberately the smallest possible expression change: the
    // pinned `status`/`leaking` expressions are NOT touched, and S11 double-pins
    // that fact.
    // ---------------------------------------------------------------------
    // 13-14: THE SEVENTH REASON. The array entry and the action sentence are
    // two different strings on purpose: a reason with no action is a verdict the
    // model cannot act on (M-25 renames the reason and the needle catches it).
    //
    // §4.1's row 13 is spelled `'boot-race',` — WITH A COMMA. That literal can
    // never exist: C7 says the value is appended LAST to BLIND_REASONS, and a
    // last array element carries no trailing comma. The row is therefore pinned
    // at the pair that proves BOTH properties the SOL wanted (the value exists,
    // and it is last: it follows 'repair-disabled' and closes the array). This is
    // a deviation in SPELLING only, and it is stricter than the original — a
    // rename or a re-order both turn it red.
    ["'repair-disabled',\n  'boot-race'\n])", 1],
    ["'boot-race': 'next: nothing", 1],
    // 15: THE CLASSIFIER'S OWN DOOR — the ONLY branch that may read the window,
    // and it sits below the measured rules (S8 asserts the order).
    ['if (transportFacts?.bootRace?.live === true', 1],
    // 16-18: THE PREFIX SURFACE vs THE RESIDUE (C5). `prefixSchemas` is always
    // the raw 19-name surface; `leaks` is empty whenever the bridge is online.
    // Three literals because they are three different syntactic roles, and S11
    // reads their order.
    ['const prefixSchemas = names.filter((name) => name.startsWith(TOOL_PREFIX))', 1],
    ['const leaks = online === true ? [] : prefixSchemas', 1],
    ['prefixSchemas,', 1],
    // 19: `payload.stale` — the field RC-1 needed. §4.1 says to verify this row's
    // uniqueness before landing and, if `stale,` is not unique, to substitute
    // `stale: stale === true,`. IT IS NOT UNIQUE here: index.js's re-register
    // comment says "(stale, but TRUE)", so the bare literal is comment-satisfiable
    // — the very weakness S7-S12 exist for. The substitution the SOL offers would
    // require the payload to stop using shorthand, and index.js is B's file (this
    // slot owns one line of it). So the row is INDENTATION-QUALIFIED: the payload
    // line is `    stale,`, the prose has no whitespace before the word, and
    // `\s+stale,` can only match the code. Same intent, no behavior change, no
    // comment can satisfy it.
    ['    stale,', 1],
    // 20-21: the guard pair on the payload, and the desktop error CODE (the
    // free-text `error` keeps its semantics; the code is what a consumer reads).
    ['expectedGuardHash:', 1],
    ['errorCode,', 1],
    // C4/C18: the two new status segments (only one tool changed).
    ['holds=', 1],
    ['health=', 1],
    // PRE-2: `scaleFix` alone is satisfiable by the verdict branch (it warns at
    // runtime), so the needle names the SENTENCE that explains the field — the
    // caveat a schema-only reader needs, and the one the trim dropped.
    ['scaleFix`: the scale-arithmetic patch', 1],
    // S6: the floor is one number in two files; the doctor prints it.
    ['DSH_NODE_FLOOR', 2],
    // S5: the one-line desktop-path doctrine, next to the identity line.
    ['desktop paths:', 1]
  ],
  proxy: [
    ['export function prefixRootPaths(text, prefix)', 1],
    ["entry?.backend === \"relay\"", 1],
    ['REWRITABLE_TYPES', 2],
    ["delete headers[\"accept-encoding\"]", 1]
  ],
  compose: [
    ['DSH_CUA_VM_WINDOWS: "${DSH_CUA_VM_WINDOWS:-0}"', 1],
    ['DSH_CUA_VM_GPU: "${DSH_CUA_VM_GPU:-}"', 1],
    ['DSH_CUA_VM_RESOLUTION: "${DSH_CUA_VM_RESOLUTION:-1200x750}"', 1],
    ['DSH_CUA_VM_LEGACY_STOP', 1]
  ],
  composeWindows: [
    // The overlay hands over devices and switches; it does NOT add an engine.
    ['- /dev/kvm', 1],
    // K10: the DEVICE is not the ACCESS. The overlay must pass the gid too, or
    // the node is mounted and uid 1000 still cannot open it.
    ['- "${KVM_GID:-kvm}"', 1],
    ['- /dev/dri', 1],
    ['DSH_CUA_VM_WINDOWS: "${DSH_CUA_VM_WINDOWS:-1}"', 1],
    ['DSH_CUA_WINDOWS_QEMU:', 1],
    ['DSH_CUA_WINDOWS_VIRTIO_ISO:', 1],
    ['DSH_CUA_VM_WIN_MCP:', 1],
    // SLIRP and the store layout are the documented contract
    ['10.0.2.2', 2],
    ['/cua-vm/windows/<name>/', 1],
    ['/cua-vm/iso/', 1],
    ['No second container engine', 1]
  ],
  env: [
    ['DSH_CUA_VM_WINDOWS=0', 1],
    // CUA_CLI_VERSION defaults to `latest` in the operator's own .env, right
    // next to the store it belongs to, and says it is a BUILD argument.
    ['CUA_CLI_VERSION=latest', 1],
    // K10: the mounted-but-denied fix, with the host command that produces it.
    ['KVM_GID', 1],
    ['stat -c %g /dev/kvm', 1],
    ['group_add: ["${KVM_GID:-kvm}"]', 1],
    ['DSH_CUA_VM_GPU=', 1],
    ['DSH_CUA_VM_RESOLUTION_ALLOW_SCALE=', 1],
    ['DSH_CUA_VM_LEGACY_STOP=', 1],
    // R1/R5: the two new Windows knobs are documented where an operator looks,
    // next to the OEM payload path they belong to.
    ['DSH_CUA_WINDOWS_CDBOOT_KEYS_MS=1500,3500,5500', 1],
    ['DSH_CUA_WINDOWS_CDBOOT_KEYS=0', 1],
    ['startup.nsh', 1],
    // WP-2/WP-7/WP-9: the switches the new paths read.
    ['DSH_CUA_VNC_CLIP=1', 1],
    ['DSH_CUA_VNC_CLIP_POLL_MS=1200', 1],
    ['DSH_CUA_CLIP_AGENT=1', 1],
    ['DSH_CUA_WIN_LEGACY_BIOS=1', 1],
    ['DSH_CUA_MCP_STATE_POLL_MS=10000', 1],
    ['DSH_CUA_WIN_ISO_SHA256=1', 1],
    // C19: the switch that restores the static-only order, documented next to
    // the digest switch it belongs with.
    ['DSH_CUA_WINDOWS_ISO_MIDO=1', 1],
    // E-2 (SOL §7.2): THE FOUR KNOBS THIS RELEASE ADDS ARE DOCUMENTED WHERE AN
    // OPERATOR LOOKS. Each one changes behaviour a support ticket will ask
    // about — the wedge deadline (how long a guest call may hang), the two
    // desktop-facts cadences (how loud a half-broken guest is) and the per-call
    // transport budget (why a call gives up in 25 s, not 45) — so an operator
    // must be able to find the name without reading python.
    ['DSH_CUA_MCP_WEDGE_DEADLINE_MS=20000', 1],
    ['DSH_CUA_MCP_FACTS_REFRESH_MS=60000', 1],
    ['DSH_CUA_MCP_FACTS_FULL_REFRESH_MS=900000', 1],
    ['DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS=25000', 1]
  ]
}

/**
 * Deletions this change made on purpose. A gate can only prove a thing is
 * present; these make sure the OLD shape does not come back, because both of
 * them were bugs that looked like features:
 *
 *   /cua-vm/shots      a hardcoded store path that ignored CUA_VM_STORE
 *   Math.sqrt(900000   the guessed capture scale, replaced by a measurement
 *   runCua(['sb','resume'] in a start path for a powered-off computer
 */
const FORBIDDEN = [
  {
    key: 'composeWindows',
    pattern: 'dind',
    reason: 'the Windows backend is direct QEMU now; a DinD sidecar is the architecture this replaced'
  },
  {
    key: 'windows',
    pattern: 'dockerRequest',
    reason: 'the Docker Engine API client was removed with the container backend'
  },
  {
    key: 'windows',
    pattern: 'dockurr',
    reason: 'the dockur/windows image is gone; the guest is a pinned Microsoft ISO on direct QEMU'
  },
  {
    key: 'windows',
    pattern: "['VRAM_SIZE'",
    reason: 'VRAM_SIZE is a no-op on the pinned qemux/qemu:7.12 base; asserting it made the gate pass on noise'
  },
  {
    key: 'windows',
    pattern: "['SHUTDOWN'",
    reason: 'v4.35 shuts down gracefully unconditionally, so SHUTDOWN=Y changes nothing'
  },
  {
    key: 'windows',
    pattern: "['ISO'",
    reason: 'there is no ISO variable in dockurr/windows v4.35: a remote ISO is VERSION=<url>, a local one is /boot.iso'
  },
  {
    key: 'supervisor',
    pattern: '/cua-vm/shots',
    reason: 'the bucket is `$STORE/shots`; a hardcoded path is invisible to cua_vm_gc and to destroy'
  },
  {
    key: 'supervisor',
    pattern: 'Math.sqrt(900000',
    reason: 'the capture scale is MEASURED from the PNG (space.measure); a budget guess is the 6%-off click'
  },
  {
    key: 'windows',
    pattern: "kvm: exists('/dev/kvm')",
    reason: 'isFile() is FALSE for a character device: that probe reported a mounted /dev/kvm as absent and sent the user to add a device they already had (the GID is the real fix)'
  },
  {
    key: 'supervisor',
    pattern: 'kvmUsable: kvm.startsWith',
    reason: 'the doctor derived "usable" from the mode STRING, so a device uid 1000 cannot open read as usable; kvmDoctorFacts reports the probe\'s own observation'
  },
  {
    key: 'windows',
    pattern: "stdio: 'ignore', detached: true })\n      children.set(`qemu:",
    reason: 'QEMU stderr must go to $STORE/windows/<name>/qemu-stderr.log: `stdio: ignore` discarded the only diagnosis an init failure produces (the reported dead create left nothing on the host)'
  },
  {
    key: 'supervisor',
    pattern: "${verdict.endpoint === 'none' ? 'no SSH yet' : `${verdict.endpoint} answering`}",
    reason: 'the raw endpoint interpolated as "undefined answering": the progress sentence is built by formatWindowsInstallDetail, which never prints a raw field'
  },
  {
    key: 'supervisor',
    pattern: 'does not fit the VM store quota',
    reason: 'the create-time quota counts REAL bytes: a sparse virtual disk is never refused, it carries a disk-over-policy warning (the offending sentence refused every Windows create on a 15 GB policy)'
  }
]

let failures = 0
let total = 0
const missing = []

if (!values.quiet) console.log(`cua-vm gate — ${ROOT}`)

for (const [key, spec] of Object.entries(FILES)) {
  const file = pick(spec.name)
  if (file === null) {
    failures += 1
    missing.push(`${spec.label}: file not found under ${ROOT}`)
    console.log(`  FAIL ${spec.label}: file not found`)
    continue
  }
  const text = readFileSync(file, 'utf8')
  let checked = 0
  let bad = 0
  for (const [needle, min] of NEEDLES[key] ?? []) {
    checked += 1
    total += 1
    const hits = (text.match(new RegExp(needlePattern(needle), 'gu')) || []).length
    if (hits < min) {
      bad += 1
      failures += 1
      missing.push(`${spec.label}: ${hits}/${min} × ${needle}`)
    }
  }
  for (const rule of FORBIDDEN.filter((entry) => entry.key === key)) {
    checked += 1
    total += 1
    // L1: CASE-INSENSITIVE. `dind`, `DinD` and `DIND` are the same regression,
    // and the first version only caught the lowercase spelling.
    if (text.toLowerCase().includes(rule.pattern.toLowerCase())) {
      bad += 1
      failures += 1
      missing.push(`${spec.label}: forbidden "${rule.pattern}" — ${rule.reason}`)
    }
  }
  if (bad === 0) {
    if (!values.quiet) console.log(`  ok   ${spec.label} — ${checked} assertion(s)`)
  } else {
    console.log(`  FAIL ${spec.label} — ${bad}/${checked} assertion(s) failed`)
  }
}

/**
 * LAYOUT. `--root` is either a checkout (docker/, plugins/, tools/, tests/) or
 * the FLAT directory the image assembles under /opt/seek-harness/cua-check/.
 * The discriminators are repo-only paths that the image never copies: `tools/`
 * holds this gate itself. Anything asserted about the CHECKOUT is gated on this
 * flag instead of being skipped whenever a file happens to be absent, so
 * deleting tests/ from a checkout still fails the gate.
 */
const REPO_LAYOUT = existsSync(path.join(ROOT, 'tools')) || existsSync(path.join(ROOT, '.git'))

/** One of the files an assertion needs, or null — never an unhandled ENOENT. */
function sourceOf(label, name) {
  const file = pick(name)
  if (file === null) {
    console.log(`  FAIL ${label}: file not found`)
    return null
  }
  return readFileSync(file, 'utf8')
}

/** Semantic assertions the needle list cannot express (order, not presence). */
{
  const quietMode = process.argv.includes('--quiet')
  // K1: these used to hardcode ROOT/docker/, which is how a FAILED assertion in
  // the image turned into a truncated stack trace: readFileSync threw before the
  // gate could print its summary, and the build log showed a Node abort instead
  // of "the xhci controller is missing". Resolve through pick(), fail cleanly.
  const windowsSource = sourceOf('K1', 'cua-vm-windows-qemu.mjs')
  total += 1
  if (windowsSource === null) {
    failures += 1
    missing.push('docker/cua-vm-windows-qemu.mjs: file not found (K1 xhci ordering cannot be checked)')
  } else {
    // S1/S2: DISK ORDER IS THE CONTRACT. The system qcow2 is attached on ide.0
    // and setup.img's block node is declared AFTER it (its usb-storage device
    // follows the xHCI controller), so Windows Setup sees the qcow2 as Disk 0 —
    // the disk Autounattend.xml's <DiskID>0</DiskID> targets. This is an ORDER
    // assertion, not a presence one: reordering the argv silently partitions the
    // answer medium instead.
    // P2: the disk device now comes from `diskDevice` (ide-hd by default, virtio
    // on request), so the ORDER anchor is the bus, not the model name — a
    // renamed model must not silently turn this assertion into a no-op.
    const diskAttach = windowsSource.indexOf(',drive=disk0,bus=ide.0')
    const setupDrive = windowsSource.indexOf('id=setup0')
    const setupAttach = windowsSource.indexOf('usb-storage,drive=setup0,removable=on')
    const xhciAttach = windowsSource.indexOf('qemu-xhci,id=xhci')
    const noUsbStick = !/usb-storage,drive=oem0/u.test(windowsSource) && !/file=fat:ro:/u.test(windowsSource)
    const setupAfterDisk = diskAttach !== -1 && setupDrive !== -1 && setupAttach !== -1
      && diskAttach < setupDrive && xhciAttach !== -1 && xhciAttach < setupAttach
    // F1/M9: NO READ-ONLY BLOCK NODE ON AN ide-hd. QEMU 10 refuses
    // `-device ide-hd,drive=setup0`: "Block node is read-only", and the create
    // then cascades into "swtpm did not create its socket". The setup drive
    // line must not carry readonly/read-only, and the old OEM stick string
    // (`read-only=on,if=none,id=oem0`) must never come back either.
    const setupWritable = !/[^\n]*read-?only[^\n]*id=setup0/iu.test(windowsSource)
      && !/id=setup0[^\n]*read-?only/iu.test(windowsSource)
      && !/drive=setup0[^\n]*read-?only/iu.test(windowsSource)
      && !/id=oem0[^\n]*read-?only/iu.test(windowsSource)
      // F1: the ATTACH SHAPE is part of the contract now: removable media, and
      // never the old fixed-disk argv literal (a fixed-disk root is not scanned
      // for Autounattend.xml). Matched as the ARGV literal, not the words, so a
      // comment may still quote the historical failure.
      && !/'ide-hd,drive=setup0,bus=ide\.2'/u.test(windowsSource)
      && /usb-storage,drive=setup0,removable=on/u.test(windowsSource)
    if (setupAfterDisk && noUsbStick && setupWritable) {
      if (!quietMode) console.log('  ok   K1 the answer image is attached WRITABLE as a REMOVABLE usb-storage stick (after the system disk, after xhci) and the vvfat OEM stick is gone')
    } else {
      failures += 1
      missing.push('docker/cua-vm-windows-qemu.mjs: setup.img must attach WRITABLE (no readonly=on) as a REMOVABLE usb-storage device (removable=on, bus=xhci.0) declared AFTER disk0 on ide.0 (so the qcow2 is Windows Disk 0 / DiskID 0) and AFTER qemu-xhci; a fixed-disk (ide-hd) setup0 is never scanned by Setup for Autounattend.xml, and no usb-storage/file=fat:ro: OEM stick may remain')
      console.log('  FAIL K1 answer-disk order / writability / no vvfat stick')
    }
  }
  // F2 (shutdown): `cont` BEFORE `system_powerdown`, INSIDE `shutdown`.
  //
  // A needle list can prove both commands exist; only an ORDER assertion proves
  // the paused case is actually fixed. A paused guest ignores ACPI entirely, so
  // a `system_powerdown` that runs first costs the whole 120 s timeout and then
  // ends in `quit` — exactly the reported stall. The `cont` must also live in
  // `shutdown` (not in `unpause`, which the gate cannot tell apart from a needle
  // hit) and must precede the powerdown within that function's body.
  {
    total += 1
    const windows = sourceOf('F2', 'cua-vm-windows-qemu.mjs')
    if (windows === null) {
      failures += 1
      missing.push('docker/cua-vm-windows-qemu.mjs: file not found (F2 shutdown ordering cannot be checked)')
    } else {
      const bodyStart = windows.indexOf('async function shutdown(rawSpec')
      const bodyEnd = bodyStart === -1 ? -1 : windows.indexOf('\n  /** Kill the process', bodyStart)
      const body = bodyStart === -1 ? '' : windows.slice(bodyStart, bodyEnd === -1 ? windows.length : bodyEnd)
      const cont = body.indexOf("execute: 'cont'")
      const power = body.indexOf("execute: 'system_powerdown'")
      const quitOnInstall = body.indexOf('installInProgress')
      const ok = cont !== -1 && power !== -1 && quitOnInstall !== -1 && cont < power
      if (ok) {
        if (!quietMode) console.log('  ok   F2 shutdown continues a PAUSED guest before asking for ACPI, and carries the mid-install classification')
      } else {
        failures += 1
        missing.push('docker/cua-vm-windows-qemu.mjs: inside `shutdown`, the QMP `cont` must precede `system_powerdown` (a paused guest never runs its ACPI handler, so the powerdown is a no-op that burns the full timeout), and the function must classify `installing`/`booting` so a mid-install shutdown is a short window + `quit` + mayBeTorn')
        console.log('  FAIL F2 shutdown ordering / mid-install classification')
      }
    }
  }
  // F3: AN INSTALLING ROW IS NEVER PROMOTED BY THE STATUS POLL.
  //
  // `vmWindowsStatus` must pass `phase: 'install'` exactly when the row says
  // `installing`/`booting` — the same gate the watcher uses. A needle proves the
  // flag exists; this proves it is WIRED TO THE ROW STATE in that function, and
  // that the unconditional `{ ssh: meta.ssh !== false }` call is gone from it.
  {
    total += 1
    const supervisor = sourceOf('F3', 'cua-vm-supervisor.mjs')
    if (supervisor === null) {
      failures += 1
      missing.push('docker/cua-vm-supervisor.mjs: file not found (F3 status-poll promotion cannot be checked)')
    } else {
      const start = supervisor.indexOf('async vmWindowsStatus(')
      const end = start === -1 ? -1 : supervisor.indexOf('  async vmWindowsShutdown(', start)
      const body = start === -1 ? '' : supervisor.slice(start, end === -1 ? supervisor.length : end)
      const wired = /const installPhase = meta\.state === 'installing' \|\| meta\.state === 'booting'/u.test(body)
        && /\.\.\.\(installPhase \? \{ phase: 'install' \} : \{\}\)/u.test(body)
      const unguarded = /windowsBackend\.ready\(meta, \{ ssh: meta\.ssh !== false \}\)/u.test(body)
      const ok = wired && !unguarded
      if (ok) {
        if (!quietMode) console.log('  ok   F3 vmWindowsStatus gates readiness on the row state, so a Setup screen cannot be promoted to ready')
      } else {
        failures += 1
        missing.push('docker/cua-vm-supervisor.mjs: vmWindowsStatus must pass phase:\'install\' when the row is installing/booting (SSH-only readiness) — the unguarded ready(meta, { ssh }) call took the VNC fallback, promoted a mid-install Setup screen to state:"ready" + installComplete, stopped the watcher and let the idle timer suspend a half-install')
        console.log('  FAIL F3 status-poll promotion gate')
      }
    }
  }
  // F2: THE ANSWER FILE NAMES THE IMAGE, IN SCHEMA ORDER. A needle list can say
  // "InstallFrom exists"; only an ORDER assertion says Setup reads it before the
  // install target, and only a REAL staged file proves the placeholder was
  // replaced. Both run here: the template's order, and (below, via the exported
  // helpers) the staged shape.
  {
    const answer = sourceOf('F2', 'Autounattend.xml')
    total += 1
    if (answer === null) {
      failures += 1
      missing.push('docker/windows-oem/Autounattend.xml: file not found (F2 InstallFrom cannot be checked)')
    } else {
      // Comments are stripped first: the template EXPLAINS the ordering in an
      // XML comment that names both elements, and a raw indexOf would find the
      // prose instead of the elements. The placeholder is also named in the
      // header's substitution table, so the one that matters is the first after
      // <OSImage>.
      const bare = answer.replace(/<!--[\s\S]*?-->/gu, '')
      const osImage = bare.indexOf('<OSImage>')
      const installFrom = osImage === -1 ? -1 : bare.indexOf('{{IMAGE_INSTALL}}', osImage)
      const installTo = bare.indexOf('<InstallTo>')
      const ok = osImage !== -1 && installFrom !== -1 && installTo !== -1 && osImage < installFrom && installFrom < installTo
      if (ok) {
        if (!quietMode) console.log('  ok   F2 the answer template names the edition (<InstallFrom>) inside <OSImage>, before <InstallTo>')
      } else {
        failures += 1
        missing.push('docker/windows-oem/Autounattend.xml: {{IMAGE_INSTALL}} must sit inside <OSImage> BEFORE <InstallTo> (schema order) — without it Setup stops at "Select the operating system you want to install"')
        console.log('  FAIL F2 InstallFrom placement in the answer template')
      }
    }
  }
  // D2/D3: THE CALLS MUST BE ON THE READY PATH, NOT MERELY PRESENT. A needle
  // cannot say "this runs when the row becomes ready"; only the surrounding
  // text can. Both the watcher's stop branch and the status poll's transition
  // are checked, because either can be the first to observe `ready`.
  {
    const supervisor = sourceOf('D2', 'cua-vm-supervisor.mjs')
    total += 1
    if (supervisor === null) {
      failures += 1
      missing.push('docker/cua-vm-supervisor.mjs: file not found (D2 ready-transition wiring cannot be checked)')
    } else {
      const watcherStart = supervisor.indexOf('function watchWindowsInstall(name)')
      const watcherEnd = watcherStart === -1 ? -1 : supervisor.indexOf('\n}\n', supervisor.indexOf('WINDOWS_WATCHING.delete(name)', watcherStart))
      const watcher = watcherStart === -1 || watcherEnd === -1 ? '' : supervisor.slice(watcherStart, watcherEnd)
      const watcherWired = /if \(decision\.ready\) await detachWindowsInstallMedia\(name\)/u.test(watcher)
        && /const overDeadline = bootedStage \? bootedMinutes > sshGraceMinutes : elapsedMinutes > timeoutMinutes/u.test(watcher)
      const statusStart = supervisor.indexOf('async vmWindowsStatus(')
      const statusEnd = statusStart === -1 ? -1 : supervisor.indexOf('  async vmWindowsLogs(', statusStart)
      const status = statusStart === -1 || statusEnd === -1 ? '' : supervisor.slice(statusStart, statusEnd)
      const statusWired = /if \(state === 'ready'\) await detachWindowsInstallMedia\(name\)/u.test(status)
      const ok = watcherWired && statusWired
      if (ok) {
        if (!quietMode) console.log('  ok   D2/D3 the ready transition ejects the media (watcher + status) and the deadline follows the boot stage')
      } else {
        failures += 1
        missing.push(`docker/cua-vm-supervisor.mjs: detachWindowsInstallMedia() must run on the READY transition in BOTH the watcher and vmWindowsStatus, and the watcher's deadline must be 'bootedStage ? bootedMinutes > sshGraceMinutes : elapsedMinutes > timeoutMinutes' (watcher=${watcherWired} status=${statusWired}) — otherwise a desktop stays attached to D: and a successful install still times out at 60 minutes`)
        console.log('  FAIL D2/D3 ready-transition wiring')
      }
    }
  }
  // F2/F3 — EVERY `await` IN THE INSTALL WATCH IS BUDGETED OR A ROW WRITE.
  //
  // The 79-minute wedge was one line: `await windowsBackend.ready(...)` inside a
  // tick that held `vm:<name>`. Two contracts pin it, and neither is expressible
  // as a presence needle:
  //   1. the probe is awaited THROUGH `withDeadline` (F2) — a bare
  //      `await windowsBackend.…` in this function is the defect, whatever the
  //      probe's own timeouts say;
  //   2. the lifecycle key is taken by EXACTLY ONE call site, whose body is the
  //      single `mutateRegistryWith` row write (F3) — so the key cannot be held
  //      across a probe, a tail read or a clock.
  // The allowed `await` heads are enumerated, so an await added tomorrow fails
  // this row until it is classified: `withDeadline` (probe), `withVmLock` (the
  // key, one-row-write only), `writeRow` (the door the loop uses), `recordDeath`
  // and `leave` (the terminal paths), `new Promise` (the tick's sleep), and the
  // two post-lock ready helpers that were already outside the lock at HEAD.
  {
    total += 1
    const supervisor = stripJsComments(textOf('cua-vm-supervisor.mjs'))
    const watchStart = supervisor.indexOf('function watchWindowsInstall(name) {')
    const watchEnd = watchStart === -1 ? -1 : supervisor.indexOf('\n}\n', supervisor.indexOf('WINDOWS_WATCHING.delete(name)', watchStart))
    const watch = watchStart === -1 || watchEnd === -1 ? '' : supervisor.slice(watchStart, watchEnd)
    const AWAIT_OK = ['withDeadline', 'withVmLock', 'writeRow', 'recordDeath', 'leave', 'new', 'ensureWindowsConsoleRelay', 'detachWindowsInstallMedia']
    const heads = [...watch.matchAll(/\bawait\s+([A-Za-z_$][\w$.]*|new\b)/gu)].map((match) => match[1])
    const bare = heads.filter((head) => AWAIT_OK.includes(head) !== true)
    const deadlineSites = (watch.match(/withDeadline\(/gu) ?? []).length
    const probes = (watch.match(/windowsBackend\.ready\(/gu) ?? []).length
    const probeBudgeted = watch.indexOf('await withDeadline(') !== -1
      && watch.indexOf('installTickBudgetMs(),') > watch.indexOf('await withDeadline(')
      && probes === 1
    const lockSites = (watch.match(/withVmLock\(/gu) ?? []).length
    const mutates = (watch.match(/mutateRegistryWith\(/gu) ?? []).length
    const lockIsTheWrite = /withVmLock\(name, async \(\) => mutateRegistryWith\(/u.test(watch)
      && lockSites === 1
      && mutates === 1
    const skipIdiom = /mode: 'try', waitMs: INSTALL_WATCH_LOCK_WAIT_MS/u.test(watch)
    const ok = watch !== '' && bare.length === 0 && deadlineSites === 1 && probeBudgeted && lockIsTheWrite && skipIdiom
    if (ok) {
      if (!quietMode) console.log('  ok   F2/F3 every await in the install watch is either budgeted (withDeadline) or the one locked row write; the lifecycle key has exactly one call site, try-mode, and never spans a probe')
    } else {
      failures += 1
      missing.push(`docker/cua-vm-supervisor.mjs: the install watch must await its probe through withDeadline (F2) and take vm:<name> in ONE call site whose body is the single mutateRegistryWith (F3) — unclassified awaits=${JSON.stringify(bare)}, withDeadline sites=${deadlineSites}, windowsBackend.ready sites=${probes}, budgeted=${probeBudgeted}, withVmLock sites=${lockSites}, mutateRegistryWith sites=${mutates}, lock-is-the-write=${lockIsTheWrite}, skip-idiom=${skipIdiom}; a bare probe await under the key is the 79-minute wedge again`)
      console.log('  FAIL F2/F3 install-watch await classification')
    }
  }
  // P5: THE SHUTDOWN OP ANSWERS BEFORE IT CONVERTS, AND THE STATE IS WRITTEN
  // BEFORE ANYTHING THAT CAN FAIL. Three ORDER assertions, because each of the
  // three defects was a correct-looking call in the wrong place:
  //   1. inside `windowsShutdown`, the BOUNDED QMP phase runs before the row is
  //      recorded — the phase is what decides `already-off`, exited, or hand-off
  //      to the background, and it must never be replaced by "wait for the
  //      convert first";
  //   2. inside `recordWindowsPoweredOff`, `row.state = 'powered-off'` is written
  //      BEFORE `scheduleDeferredWindowsCheckpoint` — the answer is the truth the
  //      panel, Start and the doctor read, and the convert may only ADD to it;
  //   3. inside `finaliseGuestShutdown`, the same write precedes
  //      `windowsCheckpointPlan` — the throw that escaped from a quota-refused
  //      checkpoint BEFORE the row was touched is why a guest-initiated
  //      power-off went unrecorded for the rest of the session.
  {
    total += 1
    const supervisor = sourceOf('P5', 'cua-vm-supervisor.mjs')
    if (supervisor === null) {
      failures += 1
      missing.push('docker/cua-vm-supervisor.mjs: file not found (P5 answer-first shutdown ordering cannot be checked)')
    } else {
      const cut = (from, to) => {
        const start = supervisor.indexOf(from)
        const end = start === -1 ? -1 : supervisor.indexOf(to, start)
        return start === -1 || end === -1 ? '' : supervisor.slice(start, end)
      }
      const shutdown = cut('async function windowsShutdown(name, meta) {', 'async function doctorReport()')
      const record = cut('async function recordWindowsPoweredOff(name, {', 'async function windowsShutdown(name, meta) {')
      const finalise = cut('async function finaliseGuestShutdown(name, {', 'async function finaliseGuestPause(name, status)')
      const phaseFirst = shutdown.indexOf('await windowsStopPhase(meta)')
      const recordAfter = shutdown.indexOf('recordWindowsPoweredOff(name, {')
      const stateWrite = record.search(/row\.state = 'powered-off'/u)
      // A-7: the shutdown op's own origin is 'shutdown'. Pinned WITH the origin
      // (not a prefix) so the guest path's 'guest-shutdown' cannot satisfy this
      // slice and the row/log keeps naming where the capture came from.
      const deferred = record.indexOf("scheduleDeferredWindowsCheckpoint(name, token, config, { origin: 'shutdown' })")
      const guestState = finalise.search(/row\.state = 'powered-off'/u)
      // C9/C10: the tick writes the FACT and then HANDS THE CAPTURE to the same
      // deferred lane the shutdown op uses — with its origin named — instead of
      // running a convert inline. And the slice takes NO lifecycle lock: that
      // wrapper is exactly what parked the tick behind a wedged operation and
      // killed the poll for the life of the process (R2).
      const guestDefer = finalise.indexOf("scheduleDeferredWindowsCheckpoint(name, token, config, { origin: 'guest-shutdown' })")
      const guestLockFree = finalise.includes('withVmLock(') === false
      // The answer is a WORD, never a path (`checkpoint: status` +
      // `checkpointDeferred`), because a path in the answer can only be a lie
      // (the file does not exist yet) or a minutes-long wait (the defect).
      const wordAnswer = /checkpoint: status,/u.test(record) && /checkpointDeferred: status === 'deferred'/u.test(record)
      const ok = shutdown !== '' && record !== '' && finalise !== ''
        && phaseFirst !== -1 && recordAfter !== -1 && phaseFirst < recordAfter
        && stateWrite !== -1 && deferred !== -1 && stateWrite < deferred
        && guestState !== -1 && guestDefer !== -1 && guestState < guestDefer
        && guestLockFree
        && wordAnswer
      if (ok) {
        if (!quietMode) console.log('  ok   P5 the shutdown is answer-first: bounded QMP phase → powered-off row → deferred checkpoint (both paths state-first)')
      } else {
        failures += 1
        missing.push(`docker/cua-vm-supervisor.mjs: the shutdown must ANSWER-FIRST — windowsStopPhase before recordWindowsPoweredOff in windowsShutdown, powered-off before scheduleDeferredWindowsCheckpoint in recordWindowsPoweredOff, powered-off before the guest's deferred capture (origin 'guest-shutdown') in finaliseGuestShutdown, NO withVmLock( in that slice (C9: the tick must never queue on the lifecycle lock), and the answer must carry checkpoint: status + checkpointDeferred (phase=${phaseFirst}, record=${recordAfter}, state=${stateWrite}, deferred=${deferred}, guestState=${guestState}, guestDefer=${guestDefer}, lockFree=${guestLockFree}, word=${wordAnswer}); otherwise either the panel's button blocks on a 10 GB qemu-img convert again, or a quota-refused checkpoint deletes the only observer of a guest power-off`)
        console.log('  FAIL P5 answer-first shutdown ordering')
      }
    }
  }
  // D1/H1: $OEM$ IS ONLY COPIED WHEN THE ANSWER FILE ASKS FOR IT, AND THE ASK
  // MUST BE IN THE RIGHT COMPONENT. A needle can prove the element exists; only
  // a POSITION assertion proves Setup will read it as part of
  // Microsoft-Windows-Setup in the windowsPE pass. Without it Windows ignores
  // C:\$OEM$ and the desktop shows "Windows Script Host — Can not find script
  // file C:\Windows\Setup\Scripts\Unattend.vbs" (the reported D1).
  {
    const answer = sourceOf('D1', 'Autounattend.xml')
    total += 1
    if (answer === null) {
      failures += 1
      missing.push('docker/windows-oem/Autounattend.xml: file not found (D1 UseConfigurationSet cannot be checked)')
    } else {
      // Comments are stripped: the template EXPLAINS the switch in a comment
      // that names the element, so a raw search would match our own prose.
      const bare = answer.replace(/<!--[\s\S]*?-->/gu, '')
      const peStart = bare.indexOf('<settings pass="windowsPE">')
      const peEnd = peStart === -1 ? -1 : bare.indexOf('</settings>', peStart)
      const pe = peStart === -1 || peEnd === -1 ? '' : bare.slice(peStart, peEnd)
      const setupStart = pe.indexOf('<component name="Microsoft-Windows-Setup"')
      const setupEnd = setupStart === -1 ? -1 : pe.indexOf('</component>', setupStart)
      const component = setupStart === -1 || setupEnd === -1 ? '' : pe.slice(setupStart, setupEnd)
      const switchAt = component.indexOf('<UseConfigurationSet>true</UseConfigurationSet>')
      const userDataAt = component.indexOf('<UserData>')
      const count = (component.match(/<UseConfigurationSet\b/gu) ?? []).length
      const ok = switchAt !== -1 && count === 1 && (userDataAt === -1 || switchAt < userDataAt)
      if (ok) {
        if (!quietMode) console.log('  ok   D1 <UseConfigurationSet>true</UseConfigurationSet> sits in the windowsPE Microsoft-Windows-Setup component (exactly once, before <UserData>)')
      } else {
        failures += 1
        missing.push(`docker/windows-oem/Autounattend.xml: <UseConfigurationSet>true</UseConfigurationSet> must appear EXACTLY ONCE inside the windowsPE Microsoft-Windows-Setup component and before <UserData> (found at ${switchAt}, count ${count}) — without it Setup never copies $OEM$ into C:\\Windows\\Setup\\Scripts and firstboot never runs, which is the reported "Can not find script file ...Unattend.vbs"`)
        console.log('  FAIL D1 UseConfigurationSet placement')
      }
    }
  }
  // D1/H2: THE FIRSTBOOT FALLBACK. The primary launcher depends on the $OEM$
  // copy; the fallback scans drive roots for cua-firstboot.ps1. Only a position
  // assertion can prove BOTH live under FirstLogonCommands as separate commands.
  {
    const answer = sourceOf('D1', 'Autounattend.xml')
    total += 1
    if (answer === null) {
      failures += 1
      missing.push('docker/windows-oem/Autounattend.xml: file not found (D1 firstboot fallback cannot be checked)')
    } else {
      const bare = answer.replace(/<!--[\s\S]*?-->/gu, '')
      const start = bare.indexOf('<FirstLogonCommands>')
      const end = start === -1 ? -1 : bare.indexOf('</FirstLogonCommands>', start)
      const block = start === -1 || end === -1 ? '' : bare.slice(start, end)
      const launcher = /wscript \/\/nologo C:\\Windows\\Setup\\Scripts\\Unattend\.vbs/u.test(block)
      const fallback = /for %d in \(c d e f g h\) do @if exist "%d:\\cua-firstboot\.ps1"/u.test(block)
      const orders = [...block.matchAll(/<Order>(\d+)<\/Order>/gu)].map((match) => Number(match[1]))
      const ok = launcher && fallback && orders.length >= 2 && orders[0] < orders[1]
      if (ok) {
        if (!quietMode) console.log('  ok   D1 both firstboot layers are FirstLogonCommands: the $OEM$ Unattend.vbs launcher AND the drive-scanning fallback')
      } else {
        failures += 1
        missing.push('docker/windows-oem/Autounattend.xml: FirstLogonCommands must carry BOTH the $OEM$ launcher (wscript ... Unattend.vbs) and the drive-scanning fallback (`for %d in (c d e f g h) do @if exist "%d:\\cua-firstboot.ps1" powershell.exe ...`) as ordered commands — one copy failure must not cost the computer its OpenSSH')
        console.log('  FAIL D1 firstboot fallback layer')
      }
    }
  }
  // F1: THE MEDIUM IS A DISK WINDOWS CAN ENUMERATE. The gate cannot build a
  // 64 MiB image, but it can refuse the exact regression: any mtools call that
  // addresses setup.img WITHOUT the partition offset is back to the
  // partitionless superfloppy the firmware mounted and Windows ignored.
  {
    const windows = sourceOf('F1', 'cua-vm-windows-qemu.mjs')
    total += 1
    if (windows === null) {
      failures += 1
      missing.push('docker/cua-vm-windows-qemu.mjs: file not found (F1 partition checks cannot run)')
    } else {
      const direct = [...windows.matchAll(/execFileSync\(MTOOLS\.(?:dir|type), \['-i', ([^,]+),/gu)].map((m) => m[1].trim())
      const bad = direct.filter((target) => target !== 'volume')
      const mbr = /writeSetupMbr\(p\.setupImg\)/u.test(windows)
        && /readSetupMbr\(p\.setupImg\)/u.test(windows)
      if (bad.length === 0 && mbr) {
        if (!quietMode) console.log('  ok   F1 every setup.img read goes through the partition offset and the MBR is written + read back')
      } else {
        failures += 1
        missing.push(`docker/cua-vm-windows-qemu.mjs: setup.img mtools reads must use the partition volume (found ${bad.length} on ${bad.join(', ') || 'none'}) and the build must write AND read back the MBR — a partitionless image is never mounted by Windows`)
        console.log('  FAIL F1 partitioned answer medium')
      }
    }
  }
  // K2: THE OEM PATH AGREEMENT. The supervisor resolves the payload from one
  // string; the Dockerfile COPY decides where it lands. Nothing in the language
  // ties them together, and the failure mode is a green build followed by a red
  // create: "the OEM payload is missing from this image: <path>" (CI run
  // 43736227888 shipped exactly this shape). Parse both, fail on any difference,
  // and say which side moved.
  {
    const supervisor = sourceOf('K2', 'cua-vm-supervisor.mjs')
    const dockerfile = sourceOf('K2', 'Dockerfile')
    total += 1
    if (supervisor === null || dockerfile === null) {
      failures += 1
      missing.push('K2: the Dockerfile and docker/cua-vm-supervisor.mjs are both needed to prove the OEM COPY destination matches the runtime path')
      console.log('  FAIL K2 OEM path agreement (missing file)')
    } else {
      const runtime = /DSH_CUA_WINDOWS_OEM_DIR\s*\|\|\s*'([^']+)'/u.exec(supervisor)?.[1] ?? null
      // The LAST token of the COPY line is the destination; the source list is
      // every token after --chmod=… that starts with docker/.
      const copyLines = dockerfile.split('\n').filter((line) => /^\s*COPY\b/u.test(line) && line.includes('windows-oem/'))
      // Every destination those COPYs write to (the last token, minus the
      // sources). The flat gate tree is one of them and is NOT the runtime path,
      // so the assertion is "the runtime path is among them", not "the only one".
      const destinations = copyLines
        .map((line) => line.trim().split(/\s+/u).at(-1))
        .filter((target) => typeof target === 'string' && !target.startsWith('docker/'))
      // `cp -a`-style: the destination may or may not end in a slash; Docker
      // treats `dir/ /d/` and `dir/ /d` the same, so compare normalised.
      const norm = (value) => (value === null ? null : value.replace(/\/+$/u, ''))
      const agrees = runtime !== null && destinations.some((target) => norm(target) === norm(runtime))
      if (agrees) {
        if (!quietMode) console.log(`  ok   K2 the Dockerfile copies the OEM payload to the path the supervisor reads (${norm(runtime)})`)
      } else {
        failures += 1
        missing.push(`K2: no COPY writes the OEM payload to the supervisor's DSH_CUA_WINDOWS_OEM_DIR default (${runtime ?? 'constant not found'}); destinations found: ${destinations.join(', ') || 'none'} — otherwise the image builds green and every Windows create fails with "the OEM payload is missing from this image"`)
        console.log('  FAIL K2 OEM path agreement')
      }
    }
  }
  // K6: EACCES IS NOT "MISSING". The module must classify a denied directory as
  // a PERMISSION defect (its own error, naming the mode/owner and the fix) rather
  // than falling through to the pull-a-newer-image text — the two are
  // indistinguishable to existsSync, which is exactly how a permissions bug
  // shipped reading like a missing-payload bug.
  {
    const windows = sourceOf('K6', 'cua-vm-windows-qemu.mjs')
    total += 1
    if (windows === null) {
      failures += 1
      missing.push('K6: docker/cua-vm-windows-qemu.mjs is needed to check the EACCES classification')
      console.log('  FAIL K6 OEM permission classification (missing file)')
    } else if (
      /export function oemPayloadDirStatus\(dir\)/u.test(windows)
      && /export function oemPayloadDeniedDir\(candidates\)/u.test(windows)
      && /export function oemPayloadDeniedError\(\{ sourceDir, denied, deniedDir, fallbackDirs \}\)/u.test(windows)
      && /code === 'EACCES' \|\| code === 'EPERM'/u.test(windows)
      && /const deniedDir = oemPayloadDeniedDir\(candidates\)/u.test(windows)
      && /IMAGE PERMISSIONS defect/u.test(windows)
      && /EACCES traversing \$\{dir\}/u.test(windows)
    ) {
      if (!quietMode) console.log('  ok   K6 a denied OEM directory is reported as a permission defect, not as a missing payload')
    } else {
      failures += 1
      missing.push('K6: the OEM payload resolver must classify EACCES separately (oemPayloadDirStatus / oemPayloadDeniedDir / oemPayloadDeniedError) — a permission bug that reads as "pull a newer image" is the bug this branch fixes')
      console.log('  FAIL K6 OEM permission classification')
    }
  }
  // L5: the runtime suite ships IN the repository (it used to live outside it,
  // so every "pinned by a test" claim pointed at something a reviewer could not
  // open). It is a statement about the CHECKOUT: the image does not ship tests/
  // (and must not pay for them in a layer), so in the flat layout this assertion
  // is out of scope and says so out loud — it is never silently dropped.
  // F1/F2/F3/F4: the boot path has its own suite now (stub QEMU: a dead init, an
  // EGL failure that must degrade once, the watchdog and the sentence).
  // WP-D: the power-buttons round's three behavioural suites are part of that
  // same claim — the deadline (T1–T12), the wedged watcher (W1–W9) and the route
  // budgets (14 checks). A suite nobody committed is a claim nobody can run.
  const suite = [
    'supervisor-smoke.mjs', 'modules-unit.mjs', 'qmp-shutdown.mjs', 'windows-boot.mjs', 'windows-mcp-gate.mjs',
    'lock-deadline.mjs', 'watcher-wedge.mjs', 'route-budget.mjs'
  ]
  if (!REPO_LAYOUT) {
    if (!quietMode) console.log('  n/a  L5 the runtime suite lives in the checkout, not in the flat image check tree')
  } else {
    total += 1
    if (suite.every((file) => existsSync(path.join(ROOT, 'tests', file)))) {
      if (!quietMode) console.log('  ok   L5 the runtime suite is committed under tests/')
    } else {
      failures += 1
      missing.push('tests/: supervisor-smoke.mjs, modules-unit.mjs, qmp-shutdown.mjs, windows-boot.mjs and windows-mcp-gate.mjs must be committed')
      console.log('  FAIL L5 runtime suite')
    }
  }

  // N3: THE SUITES MUST WITNESS THE **UNSET** SHAPE. Every existing case SET the
  // window (`windows-boot.mjs:94`, `supervisor-smoke.mjs:242`), and a test that
  // supplies a number can never observe the default — which is exactly why the
  // unset→0 defect passed every green run. A semantic assertion (delete the env,
  // not just set it), because "the file exists" cannot express it.
  if (!REPO_LAYOUT) {
    if (!quietMode) console.log('  n/a  N3 the unset-window cases live with the suite in the checkout')
  } else {
    total += 1
    const unitSource = existsSync(path.join(ROOT, 'tests', 'modules-unit.mjs'))
      ? readFileSync(path.join(ROOT, 'tests', 'modules-unit.mjs'), 'utf8')
      : ''
    const smokeSource = existsSync(path.join(ROOT, 'tests', 'supervisor-smoke.mjs'))
      ? readFileSync(path.join(ROOT, 'tests', 'supervisor-smoke.mjs'), 'utf8')
      : ''
    const deletesBoot = /delete process\.env\.DSH_CUA_WINDOWS_BOOT_SETTLE_MS/u.test(unitSource)
    const assertsDefault = /qemuBootWindowMs\(\) === 15000/u.test(unitSource)
    const assertsEarly = /earlyWindow === 5000/u.test(unitSource)
    const explicitZero = /qemuBootWindowMs\(\) === 0/u.test(unitSource)
    // The smoke case must UNSET both variables for the CHILD supervisor, not
    // merely shorten them: that is the production shape of the live failure.
    const smokeUnsets = /delete env\.DSH_CUA_WINDOWS_BOOT_SETTLE_MS/u.test(smokeSource)
      && /delete env\.DSH_CUA_WINDOWS_EARLY_CHECK_MS/u.test(smokeSource)
    const smokeLatePidfile = /exec sleep 120/u.test(smokeSource) && /sleep 0\.1/u.test(smokeSource)
    if (deletesBoot && assertsDefault && assertsEarly && explicitZero && smokeUnsets && smokeLatePidfile) {
      if (!quietMode) console.log('  ok   N3 the suite exercises the UNSET window (not only the overridden one)')
    } else {
      failures += 1
      missing.push('N3: tests/modules-unit.mjs must DELETE the window env and assert unset → 15000 / 5000 (plus an explicit "0" → 0), and tests/supervisor-smoke.mjs must run a supervisor with BOTH windows unset against a stub QEMU that writes its pidfile ~100 ms late — otherwise the unset→0 defect is invisible again')
      console.log('  FAIL N3 unset-window coverage')
    }
  }

  const supervisorSource = sourceOf('M1', 'cua-vm-supervisor.mjs')
  total += 1
  if (supervisorSource === null) {
    failures += 1
    missing.push('docker/cua-vm-supervisor.mjs: file not found (M1 ISO accounting cannot be checked)')
  } else {
    const isoInAccounted = /const ACCOUNTED_PATHS = \(\) => \[[^\]]*ISO_DIR/su.test(supervisorSource)
    if (isoInAccounted) {
      if (!quietMode) console.log('  ok   M1 the ISO cache is part of the accounted store')
    } else {
      failures += 1
      missing.push('docker/cua-vm-supervisor.mjs: ISO_DIR must be in ACCOUNTED_PATHS (the ISO cache is the largest thing in a Windows store)')
      console.log('  FAIL M1 ISO accounting')
    }
  }
}

/**
 * WP-2/WP-3/WP-5/WP-7: THE TABLE, THE FIRMWARE SPLIT AND THE WIRE FORMAT ARE
 * EXERCISED, NOT SPELLED.
 *
 * A needle can prove a code is NAMED; only the module can prove the sixteen
 * codes are the set, that every installable one has a chain, that `xp` REFUSES,
 * that Windows 7 boots on pc/SeaBIOS with no pflash, and that an RFB
 * ServerCutText has the header noVNC reads. The module is imported from the
 * tree being gated (checkout OR the flat image tree), so this cannot pass
 * against another copy.
 */
{
  const winFile = pick('cua-vm-windows-qemu.mjs')
  const clipFile = pick('cua-vnc-clip.mjs')
  const supervisorFile = pick('cua-vm-supervisor.mjs')
  total += 1
  if (winFile === null || clipFile === null || supervisorFile === null) {
    failures += 1
    missing.push('WP-2: cua-vm-windows-qemu.mjs, cua-vnc-clip.mjs and cua-vm-supervisor.mjs are all needed for the semantic catalog/firmware/clipboard assertions')
    console.log('  FAIL WP-2 semantic catalog / firmware / clipboard / bridge')
  } else {
    let ok = false
    let detail = ''
    const supervisorText = readFileSync(supervisorFile, 'utf8')
    // WP-4.1: THE FIRST-READY FALLBACK MUST NOT COME BACK. A needle cannot say
    // "this expression is absent"; the regex can.
    const noFirstReady = !/entries\.find\(\(\[, row\]\) => row\?\.kind === 'windows' && row\.state === 'ready'\)/u.test(supervisorText)
    try {
      const win = await import(pathToFileURL(winFile).href)
      const clip = await import(pathToFileURL(clipFile).href)
      const EXPECTED = '11,11l,11e,10,10l,10e,7u,xp,2025,2022,2019,2016,2012,core11,tiny11,tiny10'
      const sixteen = [...win.WINDOWS_VERSIONS].join(',') === EXPECTED
      // every code except xp must have at least one source to walk
      const chained = win.WINDOWS_VERSIONS.filter((code) => code !== 'xp')
        .every((code) => Array.isArray(win.WINDOWS_ISO_SOURCES[code]?.sources) && win.WINDOWS_ISO_SOURCES[code].sources.length > 0)
      let refused = null
      try { win.resolveWindowsIsoSources('xp') } catch (error) { refused = error?.code ?? String(error) }
      let modernText = ''
      let legacyText = ''
      let legacyMachine = ''
      const store = mkdtempSync(path.join(os.tmpdir(), 'cua-gate-vm-'))
      try {
        const paths = win.windowsPaths(store, 'gate-check')
        const base = { name: 'gate-check', cpu: 2, memory: 4, gpu: false, paths, isoPath: '/x.iso', driverIso: null, sshPort: 1, vncPort: 2, qmpPort: 3, installPending: true, virtio: false }
        const modern = win.buildQemuArgs({ ...base, windowsVersion: '11' })
        const legacy = win.buildQemuArgs({ ...base, windowsVersion: '7u' })
        modernText = modern.join(' ')
        legacyText = legacy.join(' ')
        legacyMachine = String(legacy[legacy.indexOf('-machine') + 1] ?? '')
      } finally {
        rmSync(store, { recursive: true, force: true })
      }
      // THE UEFI PROFILE: q35 + smm=off + the OVMF pflash pair + a TPM.
      // THE BIOS PROFILE: pc/accel=kvm, NO pflash, NO TPM, an IDE disk.
      const firmwareOk = modernText.includes('q35,accel=kvm,smm=off')
        && modernText.includes('if=pflash,format=raw,readonly=on,file=')
        && modernText.includes('tpm-crb,tpmdev=tpm0')
        && /^pc,accel=kvm$/u.test(legacyMachine)
        && !legacyText.includes('if=pflash')
        && !legacyText.includes('tpm-crb')
        && legacyText.includes('ide-hd,drive=disk0')
      const alias = win.canonicalWindowsVersion('ltsc11') === '11l' && win.canonicalWindowsVersion('ltsc10') === '10l'
      // THE RFB FRAME noVNC reads: type 3, three pad bytes, BE length, bytes.
      const frame = clip.serverCutTextFrame('hi')
      const expectedFrame = Buffer.from([3, 0, 0, 0, 0, 0, 0, 2, 104, 105])
      const clipOk = frame.equals(expectedFrame)
        && clip.isClientCutText(Buffer.from([6, 0, 0, 0, 0, 0, 0, 3, 65, 66, 67])) === true
        && clip.wsAccept('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
      ok = sixteen && chained && refused === 'legacy-installer-unsupported' && firmwareOk && alias && clipOk && noFirstReady
      if (ok !== true) detail = JSON.stringify({ sixteen, chained, refused, firmwareOk, alias, clipOk, noFirstReady })
    } catch (error) {
      detail = String(error?.stack ?? error)
    }
    if (ok === true) {
      if (!process.argv.includes('--quiet')) console.log('  ok   WP-2/WP-3/WP-4/WP-7 sixteen codes, xp refused, 7u on pc/SeaBIOS without pflash, 11 on q35+OVMF+TPM, no first-ready fallback, RFB frame + handshake')
    } else {
      failures += 1
      missing.push(`WP-2/WP-3: the catalog, the firmware profiles, the xp refusal, the RFB frame or the first-ready-fallback invariant no longer holds — ${detail}`)
      console.log('  FAIL WP-2 semantic catalog / firmware / clipboard / bridge')
    }
  }
}

/**
 * J1-6b: THE FLAT GATE TREE CARRIES WHAT THE GATE READS.
 *
 * CI run 44092830634 failed here, not in the doc comparison: the image assembles
 * `/opt/seek-harness/cua-check/` as a FLAT directory (a list of COPY lines, every
 * file at the root) and re-runs THIS script against it. When the ISO doc was
 * added to the enforcement but `docs/` was never copied, the gate correctly
 * refused a "missing side" — in the image only, because the checkout has `docs/`.
 *
 * The check is SEMANTIC rather than an adjacency needle: it parses every COPY
 * whose destination is the flat tree, basenames each source tokren (so
 * `docs/windows-iso-sources.md` must land as `windows-iso-sources.md`), and
 * requires the same set of names `pick()` resolves in the flat layout. Reordering
 * or inserting entries cannot break it; DROPPING one fails it with the name.
 */
{
  const dockerfile = pick('Dockerfile')
  total += 1
  // Every file the gate resolves by name when ROOT is the flat image tree, plus
  // the doc J1-6 enforces. `windows-iso-sources.md` is the entry CI was missing.
  const flatRequired = [
    'cua-vm-supervisor.mjs', 'cua-vm-space.mjs', 'cua-vm-kvm.mjs', 'cua-vm-windows-qemu.mjs',
    // WP-A: the supervisor imports the power-op lock by RELATIVE PATH
    // (`import * as VM_LOCK from './cua-vm-lock.mjs'`), so a flat tree without it
    // is not a weaker check — L1 reports it missing and the supervisor itself
    // cannot load. Resolved from the supervisor's own directory, like space/kvm.
    'cua-vm-lock.mjs',
    'cua-vnc-clip.mjs', 'win-mcp.js', 'client.js', 'index.js',
    'Autounattend.xml', 'setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs', 'cua-clip-agent.ps1',
    // J22-14: this gate reads the relay by NAME (NEEDLES.relay), so the flat tree
    // must carry it or the image build fails on a file the checkout has.
    'cua-mcp-relay.py',
    // WP-1/WP-6.1: and the relay GUARD, which the gate reads by name too
    // (NEEDLES.oemGuard). Same rule, same failure if the COPY drops it.
    'cua-relay-guard.ps1',
    'cua-guest-provision.sh', 'cua-guest-android.sh', 'proxy.mjs',
    'compose.yaml', 'compose.windows.yaml', '.env.example', 'Dockerfile',
    'windows-iso-sources.md'
  ]
  let flatOk = false
  let flatDetail = 'Dockerfile not found'
  if (dockerfile !== null) {
    const flat = new Set()
    for (const line of readFileSync(dockerfile, 'utf8').split(/\r?\n/u)) {
      if (!/^\s*COPY\b/u.test(line)) continue
      const tokens = line.trim().split(/\s+/u).filter((token) => !token.startsWith('--')).slice(1)
      const destination = tokens.pop()
      if (destination !== '/opt/seek-harness/cua-check/') continue
      for (const source of tokens) flat.add(path.posix.basename(source))
    }
    const absent = flatRequired.filter((name) => !flat.has(name))
    flatOk = absent.length === 0
    flatDetail = absent.length === 0
      ? `${flatRequired.length} file(s), including windows-iso-sources.md`
      : `the in-image gate would fail: missing ${absent.join(', ')} from the flat COPY set`
  }
  if (flatOk) {
    if (!process.argv.includes('--quiet')) console.log(`  ok   J1-6b the flat /opt/seek-harness/cua-check tree carries every file the gate reads (${flatDetail})`)
  } else {
    failures += 1
    missing.push(`J1-6b: /opt/seek-harness/cua-check is FLAT, so the COPY set must carry the doc and every file the gate reads — ${flatDetail}`)
    console.log('  FAIL J1-6b flat gate tree')
  }
}

/**
 * R8: THE SUBPROTOCOL HEADER IS CONDITIONAL — ASSERTED, NOT ASSUMED.
 *
 * A needle can prove the guarded line EXISTS; only the absence of the old one
 * proves the bridge cannot answer a protocol the client never offered. This reads
 * the shipped source and requires exactly one emission, inside the `protocol !==
 * null` guard, with `selectSubprotocol(request.headers[...])` as its only source
 * of the value. The behavioural half (a real upgrade with and without the offer)
 * lives in tests/modules-unit.mjs; this is the structural half that survives a
 * refactor of the handshake function.
 */
{
  const clipFile = pick('cua-vnc-clip.mjs')
  total += 1
  let ok = false
  let detail = 'cua-vnc-clip.mjs not found'
  if (clipFile !== null) {
    const text = readFileSync(clipFile, 'utf8')
    const emits = [...text.matchAll(/lines\.push\(([^\n]*Sec-WebSocket-Protocol[^\n]*)\)/gu)].map((match) => match[1])
    const guarded = /if \(protocol !== null\) lines\.push\(`Sec-WebSocket-Protocol: \$\{protocol\}`\)/u.test(text)
    const fromRequest = /selectSubprotocol\(request\.headers\['sec-websocket-protocol'\]\)/u.test(text)
    // The exact shapes that made the handshake abort: a constant header, or a
    // push that is not behind the negotiation.
    const unconditional = /['"`]Sec-WebSocket-Protocol: (?:binary|base64)['"`]/u.test(text)
      || /^\s*lines\.push\(`Sec-WebSocket-Protocol:/mu.test(text)
    ok = emits.length === 1 && guarded && fromRequest && !unconditional
    detail = JSON.stringify({ emissions: emits.length, guarded, fromRequest, unconditional })
  }
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   R8 the console bridge answers Sec-WebSocket-Protocol ONLY when the client offered one')
  } else {
    failures += 1
    missing.push(`R8: cua-vnc-clip.mjs must negotiate the subprotocol — no offer means NO header, and the only emission is the guarded push of selectSubprotocol(request.headers[...]) — ${detail}`)
    console.log('  FAIL R8 subprotocol negotiation')
  }
}

/**
 * J1-6: THE ISO DOCUMENT IS ENFORCED, NOT "KEPT HONEST" BY HOPE.
 *
 * `docs/windows-iso-sources.md` is the page an operator reads before spending
 * 5–8 GB of store on an install medium. It is generated from the module, and the
 * README used to claim it was "kept honest" by the tests — but no test compared
 * the two, so a hand-edit of a SHA-256 (or a URL that moved) would sail through
 * every gate and only surface as a digest refusal after the download.
 *
 * The module is IMPORTED (not grepped) and `ISO_SOURCE_CHAINS` is reached the
 * public way — `WINDOWS_ISO_SOURCES[code].sources`, which IS that table — so the
 * comparison is against the data the downloader walks, not against its source
 * text. Each of the five columns is compared: strategy, url, bytes, sha256 and
 * selection. The first divergent code is named in the failure, because "the
 * docs drifted" is not actionable and `11l row 2 sha256` is.
 *
 * Deliberate non-comparisons: the prose (`label`, `probed`), and the `(live
 * handshake: …)` placeholder the writer emits for a strategy whose URL does not
 * exist until the network answers. Those are documentation, not pins.
 *
 * THE DOC IS FOUND WHEREVER THE TREE PUTS IT. The repository keeps it at
 * `docs/windows-iso-sources.md`, while the image's `/opt/seek-harness/cua-check`
 * is a FLAT tree (every file at the root, `docs/` never copied) — so a single
 * `path.join(ROOT, 'docs', …)` made the in-image gate fail on a file that ships
 * correctly. The two layouts are both real: resolve FLAT FIRST (the image), then
 * the checkout path, and fail only when NEITHER exists. The success line names
 * which one was used, so a reader can tell which tree the gate saw.
 */
{
  const winFile = pick('cua-vm-windows-qemu.mjs')
  const docCandidates = [
    path.join(ROOT, 'windows-iso-sources.md'),
    path.join(ROOT, 'docs', 'windows-iso-sources.md')
  ]
  const docFile = docCandidates.find((candidate) => existsSync(candidate)) ?? null
  total += 1
  if (winFile === null || docFile === null) {
    failures += 1
    missing.push(`J1-6: cua-vm-windows-qemu.mjs and windows-iso-sources.md are both required — the ISO doc is enforced against the module, so a missing side is a missing contract (looked for ${docCandidates.map((candidate) => path.relative(ROOT, candidate) || '.').join(', ')})`)
    console.log('  FAIL J1-6 ISO doc honesty')
  } else {
    let firstDrift = null
    let compared = 0
    try {
      const win = await import(pathToFileURL(winFile).href)
      const md = readFileSync(docFile, 'utf8').split(/\r?\n/u)
      // The doc's per-code sections: `### \`11\` — Windows 11 Pro`.
      const sections = new Map()
      let current = null
      for (const line of md) {
        const heading = /^### `([^`]+)`/u.exec(line)
        if (heading !== null) { current = heading[1]; sections.set(current, []); continue }
        if (/^## /u.test(line)) current = null
        if (current === null) continue
        if (!line.startsWith('|')) continue
        if (/\|\s*strategy\s*\|/u.test(line)) continue
        if (/^\|[-: |]+\|$/u.test(line)) continue
        sections.get(current).push(line)
      }
      const cellsOf = (line) => line.split('|').slice(1, -1).map((cell) => cell.trim())
      const expectedSelection = (source) => source?.selection === undefined
        ? 'catalog default'
        : `${source.selection.key} \`${source.selection.value}\``
      for (const code of win.WINDOWS_VERSIONS) {
        const rows = (sections.get(code) ?? []).map(cellsOf)
        const sources = win.WINDOWS_ISO_SOURCES?.[code]?.sources ?? []
        if (rows.length !== sources.length) {
          firstDrift = `code ${code}: the doc has ${rows.length} row(s), the module's chain has ${sources.length}`
          break
        }
        for (let index = 0; index < sources.length; index += 1) {
          const source = sources[index]
          const [strategy, url, bytes, sha256, selection] = rows[index]
          const urlOk = typeof source.url === 'string' && source.url !== ''
            ? url === source.url
            // A strategy with no static URL (mido/esd) says so in prose; the
            // placeholder is allowed, a fabricated URL is not.
            : url === '—' || url.startsWith('(')
          const checks = [
            ['strategy', strategy, String(source.strategy)],
            ['url', url, urlOk ? url : (source.url ?? '(a live handshake)')],
            ['bytes', bytes, source.bytes > 0 ? String(source.bytes) : '—'],
            ['sha256', sha256, source.sha256 !== '' ? `\`${source.sha256}\`` : '—'],
            ['selection', selection, expectedSelection(source)]
          ]
          compared += 1
          const wrong = checks.find(([, got, want]) => got !== want)
          if (wrong !== undefined) {
            firstDrift = `code ${code} row ${index + 1} (${source.strategy}) ${wrong[0]}: the doc says ${JSON.stringify(wrong[1])}, the module says ${JSON.stringify(wrong[2])}`
            break
          }
        }
        if (firstDrift !== null) break
      }
    } catch (error) {
      firstDrift = String(error?.stack ?? error)
    }
    if (firstDrift === null) {
      if (!process.argv.includes('--quiet')) console.log(`  ok   J1-6 ${path.relative(ROOT, docFile) || path.basename(docFile)} matches ISO_SOURCE_CHAINS on all five columns (${compared} chain row(s))`)
    } else {
      failures += 1
      missing.push(`J1-6: ${path.relative(ROOT, docFile) || path.basename(docFile)} drifted from ISO_SOURCE_CHAINS — ${firstDrift}`)
      console.log('  FAIL J1-6 ISO doc honesty')
    }
  }
}

/**
 * C19 — THE CHAIN REALLY STARTS AT MICROSOFT (order, not presence).
 *
 * A needle can prove that `resolveWindowsIsoSources()` and `ensureIsoForSource()`
 * are called. It cannot prove the LIST they are called with begins with the live
 * strategy: swapping `mido` behind `link1` in `ISO_SOURCE_CHAINS` would keep every
 * needle green while the create quietly went back to a third-party mirror. So the
 * module is IMPORTED (not grepped) and the order is read from the data the
 * downloader actually walks.
 *
 * `n/a` — never a silent pass — when the module cannot be imported in a layout
 * that lacks its neighbours, exactly like L5/N3.
 */
{
  total += 1
  const winFile = pick('cua-vm-windows-qemu.mjs')
  if (winFile === null) {
    failures += 1
    missing.push('C19: docker/cua-vm-windows-qemu.mjs is required — the ISO chain ORDER cannot be checked without it')
    console.log('  FAIL C19 ISO chain order')
  } else {
    let strategies = null
    let importProblem = null
    try {
      const win = await import(pathToFileURL(winFile).href)
      strategies = win.resolveWindowsIsoSources('11').map((source) => String(source?.strategy ?? ''))
    } catch (error) {
      importProblem = error
    }
    if (importProblem !== null) {
      total -= 1
      if (!process.argv.includes('--quiet')) console.log(`  n/a  C19 ISO chain order (the Windows module did not import here: ${String(importProblem?.message ?? importProblem).split('\n')[0]})`)
    } else if (strategies[0] === 'mido' && strategies.includes('link1')) {
      if (!process.argv.includes('--quiet')) console.log(`  ok   C19 the chain for windowsVersion "11" starts at the live Microsoft strategy and keeps a pinned mirror (${strategies.join(' -> ')})`)
    } else {
      failures += 1
      missing.push(`C19: the chain for windowsVersion "11" must START at the live Microsoft strategy and still carry a pinned mirror — got ${strategies.join(' -> ') || '(nothing)'}`)
      console.log('  FAIL C19 ISO chain order')
    }
  }
}

/**
 * C21/S6 — THE NODE FLOOR IS ONE NUMBER IN TWO FILES.
 *
 * `engines.node` is what a package manager checks and `DSH_NODE_FLOOR` is what
 * `cua_vm_doctor` prints; a release that bumps one and not the other tells an
 * operator a floor the install does not enforce (or the reverse). Same pattern as
 * WP-6.6's version equality: read both, compare the digits, name both values.
 *
 * Out of scope in the flat image tree (no `package.json` is copied), said out
 * loud like WP-6.6.
 */
{
  total += 1
  const indexFile = pick('index.js')
  const packageCandidates = [
    indexFile === null ? null : path.join(path.dirname(indexFile), 'package.json'),
    path.join(ROOT, 'plugins', 'dsh-cua-vm', 'package.json')
  ].filter((candidate) => candidate !== null)
  const packageFile = packageCandidates.find((candidate) => existsSync(candidate)) ?? null
  let engines = null
  if (packageFile !== null) {
    try {
      engines = JSON.parse(readFileSync(packageFile, 'utf8')).engines?.node ?? null
    } catch {
      engines = null
    }
  }
  const indexText = indexFile === null ? '' : stripJsComments(readFileSync(indexFile, 'utf8'))
  const floorMatch = /const DSH_NODE_FLOOR = '([^']+)'/u.exec(indexText)
  const floor = floorMatch === null ? null : floorMatch[1]
  if (!REPO_LAYOUT && packageFile === null) {
    total -= 1
    if (!process.argv.includes('--quiet')) console.log('  n/a  C21 the Node floor parity (engines vs DSH_NODE_FLOOR) lives in the checkout, not in the flat image check tree')
  } else if (typeof engines !== 'string' || floor === null) {
    failures += 1
    missing.push(`C21: both floors must be readable — package.json "engines"."node" (${engines === null ? `MISSING at ${packageFile ?? 'no package.json found'}` : `got ${JSON.stringify(engines)}`}) and index.js const DSH_NODE_FLOOR = '<x>' (${floor === null ? 'MISSING' : `got ${JSON.stringify(floor)}`})`)
    console.log('  FAIL C21 Node floor parity')
  } else if (engines.includes('24.22.3') && engines.includes('26.13.1') && floor === '24.22.3') {
    if (!process.argv.includes('--quiet')) console.log(`  ok   C21 the Node floor is one number in two files (engines ${JSON.stringify(engines)}, DSH_NODE_FLOOR ${JSON.stringify(floor)})`)
  } else {
    failures += 1
    missing.push(`C21: engines.node ${JSON.stringify(engines)} and DSH_NODE_FLOOR ${JSON.stringify(floor)} must both state 24.22.3 (24.x) and 26.13.1 (26.x) — DSH 0.2.3-alpha.2 refuses anything below`)
    console.log('  FAIL C21 Node floor parity')
  }
}

/**
 * C20 — THE TWO DESKTOP PATHS ARE WRITTEN DOWN, WITH THE RULE.
 *
 * A doc requirement with no assertion is a doc that gets deleted. The two facts
 * that must survive are the plugin name and the doctrine, because the failure
 * mode is a reader concluding that `dsh-windows-mcp` is a second bridge to the
 * same guest.
 */
{
  total += 1
  const docCandidates = [
    path.join(ROOT, 'desktop-paths.md'),
    path.join(ROOT, 'docs', 'desktop-paths.md')
  ]
  const docFile = docCandidates.find((candidate) => existsSync(candidate)) ?? null
  if (docFile === null && !REPO_LAYOUT) {
    total -= 1
    if (!process.argv.includes('--quiet')) console.log('  n/a  C20 docs/desktop-paths.md lives in the checkout, not in the flat image check tree')
  } else if (docFile === null) {
    failures += 1
    missing.push(`C20: docs/desktop-paths.md is required — the host-desktop path is opt-in and the rule ("one desktop target per session") has to be written down (looked for ${docCandidates.map((candidate) => path.relative(ROOT, candidate) || '.').join(', ')})`)
    console.log('  FAIL C20 desktop paths doc')
  } else {
    const md = readFileSync(docFile, 'utf8')
    const lost = ['dsh-windows-mcp', 'Session 0'].filter((token) => !md.includes(token))
    if (lost.length === 0) {
      if (!process.argv.includes('--quiet')) console.log(`  ok   C20 ${path.relative(ROOT, docFile) || path.basename(docFile)} names the host path and the Session-0 doctrine`)
    } else {
      failures += 1
      missing.push(`C20: ${path.relative(ROOT, docFile) || path.basename(docFile)} lost ${lost.map((token) => JSON.stringify(token)).join(' and ')} — a doc that stops naming them stops being the rule`)
      console.log('  FAIL C20 desktop paths doc')
    }
  }
}

/**
 * WP-6.6 / §4.8 — ONE IDENTITY, TWO FILES. A SCRIPTED CROSS-FILE ASSERTION.
 *
 * `index.js` exports `PLUGIN_VERSION` and both doctors report it, while the
 * package that a user installs carries `package.json`'s `version`. Nothing
 * type-checks the pair: bump one, ship the other, and "the fix is not in your
 * plugin" becomes a lie the doctor itself tells — the report says 0.2.0 while the
 * installed package is 0.1.0, or the reverse. A needle cannot express equality
 * between two files, so this READS BOTH and compares the strings.
 *
 * BOTH SIDES ARE FOUND THE WAY THE REST OF THE GATE FINDS THINGS: `index.js`
 * through `pick()` (checkout or flat image tree), `package.json` beside it. The
 * image's flat `/opt/seek-harness/cua-check` does not ship `package.json` (it
 * ships the three JS files the plugin runs), so in THAT layout the assertion is
 * out of scope and says so — never silently dropped, the same convention L5/N3
 * use for checkout-only facts.
 *
 * THE FAILURE NAMES THE TWO VALUES AND THE FILE. `package.json 0.1.0 ≠
 * PLUGIN_VERSION 0.2.0 (plugins/dsh-cua-vm/package.json)` is actionable; "the
 * versions disagree" is not. This assertion was RED the moment it was written —
 * index.js already exported 0.2.0 while the manifest still said 0.1.0 — and it is
 * the gate, not a review note, that made WP-7.1's bump unmissable. It was green
 * while both said 0.2.1 (the WP-1..WP-8 release) and is green again at 0.2.2 (the
 * session-5 WP-A..WP-E release); a future bump in ONE file turns it red again.
 */
{
  total += 1
  const indexFile = pick('index.js')
  const indexText = indexFile === null ? '' : readFileSync(indexFile, 'utf8')
  const versionMatch = /export const PLUGIN_VERSION = '([^']+)'/u.exec(indexText)
  const pluginVersion = versionMatch === null ? null : versionMatch[1]
  // The package manifest is the plugin's own, so resolve it from index.js's
  // directory first (a checkout keeps it there; the flat image tree does not have
  // it at all), then fall back to the checkout path.
  const packageCandidates = [
    indexFile === null ? null : path.join(path.dirname(indexFile), 'package.json'),
    path.join(ROOT, 'plugins', 'dsh-cua-vm', 'package.json')
  ].filter((candidate) => candidate !== null)
  const packageFile = packageCandidates.find((candidate) => existsSync(candidate)) ?? null
  let packageVersion = null
  if (packageFile !== null) {
    try {
      packageVersion = JSON.parse(readFileSync(packageFile, 'utf8')).version ?? null
    } catch {
      packageVersion = null
    }
  }
  if (!REPO_LAYOUT && packageFile === null) {
    if (!process.argv.includes('--quiet')) console.log('  n/a  WP-6.6 package.json vs PLUGIN_VERSION lives in the checkout, not in the flat image check tree')
    total -= 1
  } else if (pluginVersion === null || packageVersion === null) {
    failures += 1
    missing.push(`WP-6.6: both identities must be readable — index.js export const PLUGIN_VERSION = '<x>' (${pluginVersion === null ? 'MISSING' : `got ${JSON.stringify(pluginVersion)}`}) and package.json "version" (${packageVersion === null ? `MISSING or unparsable at ${packageFile === null ? 'no package.json found' : path.relative(ROOT, packageFile) || packageFile}` : `got ${JSON.stringify(packageVersion)}`})`)
    console.log('  FAIL WP-6.6 plugin identity (PLUGIN_VERSION vs package.json)')
  } else if (pluginVersion === packageVersion) {
    if (!process.argv.includes('--quiet')) console.log(`  ok   WP-6.6 plugins/dsh-cua-vm/package.json version ${packageVersion} === index.js PLUGIN_VERSION`)
  } else {
    failures += 1
    missing.push(`WP-6.6: plugins/dsh-cua-vm/package.json version ${JSON.stringify(packageVersion)} ≠ index.js PLUGIN_VERSION ${JSON.stringify(pluginVersion)} — §4.8/WP-7.1: both must be the same release (0.2.2), so the doctor's pluginVersion names the build that is actually installed. Bump BOTH (WP-5.10 / WP-8.1) or the release identity is a guess.`)
    console.log(`  FAIL WP-6.6 plugin identity: package.json ${packageVersion} ≠ PLUGIN_VERSION ${pluginVersion} (owner: WP-7.1 / writer G)`)
  }
}

/**
 * JURY-R1 — THE LADDER'S ORDER IS THE CONTRACT (index.js classifyBlindReason).
 *
 * A needle can prove both branches EXIST; only an ORDER assertion proves the
 * measured console fact still outranks a stale probe token. The reproduced
 * contradiction: a repair MEASURED `session=0` (no Active console session) while
 * the cached probe still said `RELAY_SKEW`, so the doctor answered `probe-skew`
 * and sent the operator to re-assert a payload — on a guest where the relay had
 * nowhere to run. Defect 3 moved the measured branch above the token; this keeps
 * it there. A reorder is invisible to every needle and to every "field present"
 * check, which is exactly why it is asserted here.
 */
{
  total += 1
  const indexText = pick('index.js') === null ? '' : readFileSync(pick('index.js'), 'utf8')
  const bodyStart = indexText.indexOf('function classifyBlindReason(')
  const bodyEnd = bodyStart === -1 ? -1 : indexText.indexOf('\nfunction windowsRelayAnswered(', bodyStart)
  const body = bodyStart === -1 ? '' : indexText.slice(bodyStart, bodyEnd === -1 ? indexText.length : bodyEnd)
  const sessionAt = body.indexOf("return 'no-interactive-session'")
  const skewAt = body.indexOf("return 'probe-skew'")
  const measuredAt = body.indexOf('const measured = repair !== null && repair.measured === true')
  const ok = body !== '' && measuredAt !== -1 && sessionAt !== -1 && skewAt !== -1 && sessionAt < skewAt
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   JURY-R1 a MEASURED console session outranks a stale RELAY_SKEW token in classifyBlindReason')
  } else {
    failures += 1
    missing.push(`JURY-R1: plugins/dsh-cua-vm/index.js classifyBlindReason() must rank the MEASURED session fact (return 'no-interactive-session') ABOVE the stale probe token (return 'probe-skew'), and read the measured marker first — got measured=${measuredAt} session=${sessionAt} skew=${skewAt} (session<skew required)`)
    console.log('  FAIL JURY-R1 blind-reason ladder order')
  }
}

/**
 * JURY-R2 — REGISTER THE CLIENT BEFORE THE AWAIT (index.js attach, DEFECT 8).
 *
 * `WIN_MCP.client` is assigned only AFTER the 45 s handshake answers, so a
 * teardown that lands INSIDE `connect()` has nothing to close: the inflight
 * ticket still refuses every late registration, but the SSH child lives until its
 * own request timer — a bounded zombie. The fix parks the client in
 * `WIN_MCP_AUX.inflightClients` BEFORE `await client.connect()` so `teardown()`
 * can close it. Moving that one line below the await restores the defect and is
 * invisible to every presence needle (both lines still exist), which is why the
 * order is asserted here.
 *
 * The search for `await client.connect()` starts AT the add, so the doc comment
 * that also spells the call (`index.js` header: "`await client.connect()` is 45 s
 * wide") cannot satisfy the assertion on its own.
 */
{
  total += 1
  const indexText = pick('index.js') === null ? '' : readFileSync(pick('index.js'), 'utf8')
  const addAt = indexText.indexOf('WIN_MCP_AUX.inflightClients.add(client)')
  const connectAt = addAt === -1 ? -1 : indexText.indexOf('await client.connect()', addAt)
  const ok = addAt !== -1 && connectAt !== -1 && addAt < connectAt
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   JURY-R2 the attach parks its client in inflightClients BEFORE awaiting the 45 s handshake (defect 8)')
  } else {
    failures += 1
    missing.push(`JURY-R2: plugins/dsh-cua-vm/index.js must call WIN_MCP_AUX.inflightClients.add(client) BEFORE await client.connect() — a teardown inside the handshake can only close what is already parked (add=${addAt}, connect-after-add=${connectAt})`)
    console.log('  FAIL JURY-R2 inflight client registered before the handshake')
  }
}

/* ====================================================================== *
 * E-3 (SOL §7.2) — THE SEMANTIC ASSERTIONS S1..S6.
 *
 * A needle says a line EXISTS. Five of this release's contracts are about
 * ORDER, MEMBERSHIP or DERIVATION, and those are exactly the properties a
 * "helpful" refactor breaks while every needle stays green: the kill can move
 * after the answer, the host budget can drop below the guest deadline, a tool
 * can join the retry set, `[DEGRADED]` can move behind the contract note, the
 * unmeasured warning can fall below the dead-lane one, and the guest's steps
 * can swap.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not cosmetic. WP-C left two of the
 * old literals verbatim inside doc comments so the previous needle rows would
 * stay green; an order check that reads raw text would have accepted the
 * comment as the call (WP-A's report called this out as its one false-green
 * risk, and M-01 is the row that proves the stripping works).
 * ====================================================================== */

/** Python: drop `#` comments, honouring ' " and escapes (no `#` inside them). */
function stripPythonComments(text) {
  let out = ''
  for (const line of text.split('\n')) {
    let quote = null
    let cut = line.length
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (quote !== null) {
        if (ch === '\\') { i += 1; continue }
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") { quote = ch; continue }
      if (ch === '#') { cut = i; break }
    }
    out += `${line.slice(0, cut)}\n`
  }
  return out
}

/** JS: drop `//` and block comments, honouring ' " ` and escapes. */
function stripJsComments(text) {
  let out = ''
  let quote = null
  let block = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (block === true) {
      if (ch === '*' && next === '/') { block = false; i += 1 }
      continue
    }
    if (quote !== null) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && next === '*') { block = true; i += 1; continue }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    out += ch
  }
  return out
}

/** The source of one file, or '' — a missing file is a FAIL, not a throw. */
function textOf(name) {
  const file = pick(name)
  return file === null ? '' : readFileSync(file, 'utf8')
}

/** `Object.freeze([ ... ])` → its string members, in order. `null` if absent. */
function frozenListOf(source, name) {
  const marker = `const ${name} = Object.freeze([`
  const at = source.indexOf(marker)
  if (at === -1) return null
  const close = source.indexOf('])', at)
  if (close === -1) return null
  return [...source.slice(at + marker.length, close).matchAll(/'([^']+)'/gu)].map((match) => match[1])
}

/**
 * S1 — KILL BEFORE ANSWER (C4.6, relay `_wedge_watch`).
 *
 * A client that is answered before the child is dead can immediately retry into
 * the same wedged process, and the answer says "restarted" about a process that
 * is still holding the window. The order is the whole fix; both call sites
 * existing is not.
 */
{
  total += 1
  const relayText = textOf('cua-mcp-relay.py')
  const start = relayText.indexOf('def _wedge_watch(')
  const end = start === -1 ? -1 : relayText.indexOf('def _child_ref(', start)
  const body = stripPythonComments(start === -1 ? '' : relayText.slice(start, end === -1 ? relayText.length : end))
  const killAt = body.indexOf('self._kill_wedged_child(')
  const answerAt = body.indexOf('self._answer_wedged(')
  const ok = body !== '' && killAt !== -1 && answerAt !== -1 && killAt < answerAt
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   S1 the wedge watchdog KILLS the child before it answers the pending ids (C4.6, comments stripped first)')
  } else {
    failures += 1
    missing.push(`S1: docker/cua-mcp-relay.py _wedge_watch() must call self._kill_wedged_child( BEFORE self._answer_wedged( — an answer before the kill lets the client retry into the same wedged child (kill=${killAt}, answer=${answerAt}; comments stripped, so a commented-out call cannot satisfy this)`)
    console.log('  FAIL S1 wedge watchdog order')
  }
}

/**
 * S2 — THE TWO LADDERS, IN THE ONLY ORDER THAT WORKS (C5).
 *
 * The guest's 20 s watchdog starts its clock AFTER the host's 25 s per-request
 * budget begins, so the guest's answer must be able to arrive first. If the
 * host budget were <= the guest deadline, every wedge would be replaced by a
 * local `timeout` and `child-wedged` could never reach the model — the exact
 * regression M-10 applies.
 *
 * THE DERIVATION HALF IS ASSERTED STRUCTURALLY, NOT BY SPELLING, and the revise
 * round is why: the ladder used to spell three one-line returns
 * (`winMcpCallTimeoutMs() + 1_000`, `(2 * winMcpCallEnvelopeMs()) + 4_000`, …)
 * and a legitimate WP-C fix replaced them with ONE reading per call
 * (`winMcpCallNumbers()`), which is strictly stronger — it also stops the race
 * and the per-request timer drifting apart when the env var changes mid-session
 * (the split C5 exists to prevent). A spelling pin would have failed on the
 * better code, so this reads the invariant instead: every rung is COMPUTED from
 * the call-time value, and all three readers route through that one reading.
 * A hardcoded `26_000`/`56_000`/`30_000`, or a rung that read the env on its own,
 * fails here.
 */
{
  total += 1
  const indexText = textOf('index.js')
  const relayText = textOf('cua-mcp-relay.py')
  const number = (raw) => (raw === null ? null : Number(String(raw).replace(/_/gu, '')))
  const hostMatch = /const WIN_MCP_CALL_TIMEOUT_MS = ([\d_]+)/u.exec(indexText)
  const guestMatch = /WEDGE_DEADLINE_MS = ([\d_]+)/u.exec(relayText)
  const host = number(hostMatch === null ? null : hostMatch[1])
  const guest = number(guestMatch === null ? null : guestMatch[1])
  // The ONE reading: `call` from the call-time reader, `envelope = call + 1 s`,
  // `attempts` from the retry flag, `total = attempts × envelope + 4 s`.
  const ladderAt = indexText.indexOf('function winMcpCallNumbers(')
  const ladderBody = ladderAt === -1 ? '' : indexText.slice(ladderAt, indexText.indexOf('\n}', ladderAt))
  const callRead = ladderBody.includes('winMcpCallTimeoutMs()')
  const envelopeDerived = /const envelope = call \+ 1_000/u.test(ladderBody)
  const attemptsDerived = /attempts = retried === true \? 2 : 1/u.test(ladderBody)
  const totalDerived = /attempts \* envelope\) \+ 4_000/u.test(ladderBody)
  const readers = ['winMcpCallEnvelopeMs', 'winMcpCallRetryBudgetMs', 'winMcpCallGuardMs']
  const routed = readers.filter((name) => {
    const at = indexText.indexOf(`function ${name}()`)
    const body = at === -1 ? '' : indexText.slice(at, indexText.indexOf('\n}', at))
    return body.includes('winMcpCallNumbers(')
  })
  const ok = host !== null && guest !== null && host > guest
    && callRead && envelopeDerived && attemptsDerived && totalDerived && routed.length === readers.length
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log(`  ok   S2 the host per-call budget (${host} ms) EXCEEDS the guest wedge deadline (${guest} ms), and envelope/attempts/total are all COMPUTED from the one call-time reading that every rung routes through (C5)`)
  } else {
    failures += 1
    missing.push(`S2: the budget ladder must satisfy host WIN_MCP_CALL_TIMEOUT_MS (${host}) > guest WEDGE_DEADLINE_MS (${guest}) AND derive every rung from ONE call-time reading — winMcpCallNumbers(): reads winMcpCallTimeoutMs()=${callRead}, envelope=call+1s=${envelopeDerived}, attempts=${attemptsDerived}, total=attempts*envelope+4s=${totalDerived}, rungs routed through it=${routed.length}/3 (${routed.join(',')}) — a host budget at or under the guest's deadline turns every child-wedged into a local timeout, and a hardcoded rung stops scaling with DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS (C5)`)
    console.log('  FAIL S2 per-call budget ladder')
  }
}

/**
 * S3 — THE TWO SETS: EXACT MEMBERSHIP, AND DISJOINT (C7).
 *
 * `[DEGRADED]` is placed by membership in the element set, and a retry is
 * allowed only for the read-only set. If a tool joined both, the plugin would
 * both warn about the lane and pay TWO timeouts on the one call class that
 * cannot recover by waiting. Order is asserted too: the sets are read by index
 * in two places and a reorder is fine, so the check compares membership, not
 * position.
 */
{
  total += 1
  const indexText = textOf('index.js')
  const element = frozenListOf(indexText, 'WIN_MCP_ELEMENT_LANE_TOOLS')
  const retried = frozenListOf(indexText, 'WIN_MCP_CALL_RETRY_TOOLS')
  const ELEMENT = ['find_elements', 'tool_invoke', 'tool_get_text', 'tool_set_value', 'tool_wait_for']
  const RETRY = ['tool_list_windows', 'tool_capture_window', 'tool_read_clipboard']
  const sameSet = (got, want) => Array.isArray(got) && got.length === want.length && want.every((name) => got.includes(name))
  const overlap = Array.isArray(element) && Array.isArray(retried) ? element.filter((name) => retried.includes(name)) : ['<unparsed>']
  const ok = sameSet(element, ELEMENT) && sameSet(retried, RETRY) && overlap.length === 0
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   S3 the element-lane set is exactly the five, the retry set exactly the three read-only tools, and they are DISJOINT (C7)')
  } else {
    failures += 1
    missing.push(`S3: WIN_MCP_ELEMENT_LANE_TOOLS must be exactly ${JSON.stringify(ELEMENT)} (got ${JSON.stringify(element)}) and WIN_MCP_CALL_RETRY_TOOLS exactly ${JSON.stringify(RETRY)} (got ${JSON.stringify(retried)}), DISJOINT (overlap ${JSON.stringify(overlap)}) — a retried element call doubles the cost of the one lane that fails in milliseconds (C7)`)
    console.log('  FAIL S3 tool sets')
  }
}

/**
 * S4 — THE `[DEGRADED]` SHAPE (C8): sentence FIRST, contract note, suffix LAST.
 *
 * The prefix is the only thing a model reads before choosing a tool, so it must
 * sit at position 0 of the description — before the guest's own prose and before
 * the contract note. Moving it behind either one is invisible to a presence
 * needle and makes the warning decorative.
 */
{
  total += 1
  const indexText = textOf('index.js')
  const start = indexText.indexOf('function windowsToolDescription(')
  const end = start === -1 ? -1 : indexText.indexOf('function guestToolDefinition(', start)
  const body = stripJsComments(start === -1 ? '' : indexText.slice(start, end === -1 ? indexText.length : end))
  const sentenceAt = body.indexOf('DEGRADED_ELEMENT_LANE_SENTENCE')
  const contractAt = body.indexOf('windowsToolContract(')
  const suffixAt = body.indexOf('(dsh-cua, Windows computer')
  const ok = body !== '' && sentenceAt !== -1 && contractAt !== -1 && suffixAt !== -1
    && sentenceAt < contractAt && contractAt < suffixAt
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   S4 windowsToolDescription() renders [DEGRADED] FIRST, then the contract note, then the (dsh-cua, Windows computer …) suffix (C8)')
  } else {
    failures += 1
    missing.push(`S4: index.js windowsToolDescription() must order the template [DEGRADED] (${sentenceAt}) < windowsToolContract( (${contractAt}) < "(dsh-cua, Windows computer" (${suffixAt}) — a prefix that is not first is a warning the model reads after it has chosen the tool (C8)`)
    console.log('  FAIL S4 [DEGRADED] description shape')
  }
}

/**
 * S5 — UNMEASURED BEFORE DEAD (C9).
 *
 * `measured:null` and `measured:true, elementLaneOk:false` are different
 * diagnoses with different next actions (call the doctor vs rebuild the guest).
 * The unmeasured branch must be evaluated first, because every later branch
 * reads `measured === true` — a reorder turns "nobody looked" into "nothing is
 * broken", which is the state the report was actually in.
 */
{
  total += 1
  const indexText = textOf('index.js')
  const start = indexText.indexOf('function windowsDesktopWarnings(')
  const end = start === -1 ? -1 : indexText.indexOf('\nfunction ', start + 1)
  const body = stripJsComments(start === -1 ? '' : indexText.slice(start, end === -1 ? indexText.length : end))
  const unmeasuredAt = body.indexOf('measured !== true')
  const deadAt = body.indexOf('elementLaneOk === false')
  const ok = body !== '' && unmeasuredAt !== -1 && deadAt !== -1 && unmeasuredAt < deadAt
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   S5 windowsDesktopWarnings() tests the UNMEASURED state before the dead element lane (C9)')
  } else {
    failures += 1
    missing.push(`S5: index.js windowsDesktopWarnings() must test "measured !== true" (${unmeasuredAt}) BEFORE "elementLaneOk === false" (${deadAt}) — the unmeasured branch is the one that says "nobody looked", and every later branch assumes measured:true (C9)`)
    console.log('  FAIL S5 desktop warning order')
  }
}

/**
 * S6 — THE GUEST'S STEP ORDER (D-20, C14).
 *
 * Both patch steps run AFTER the `dsh-cua` wheel is installed and BEFORE the
 * clipboard tasks; the desktop-token probe runs after both patches (it imports
 * the patched modules) and before the tasks that depend on the session it
 * proves. The order is not cosmetic: `dsh-cua-scale` edits the same two files,
 * so a reorder makes each step's `count == 1` anchor gate depend on luck.
 */
{
  total += 1
  const ps1 = textOf('cua-firstboot.ps1')
  const at = (name) => ps1.indexOf(`Step '${name}' {`)
  const order = ['dsh-cua-scale', 'dsh-cua-typetext', 'dsh-cua-savepath', 'desktop-token-probe', 'clipboard-tasks']
  const index = Object.fromEntries(order.map((name) => [name, at(name)]))
  const ok = order.every((name) => index[name] !== -1)
    && order.every((name, position) => position === 0 || index[order[position - 1]] < index[name])
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   S6 the guest steps run dsh-cua-scale < dsh-cua-typetext < dsh-cua-savepath < desktop-token-probe < clipboard-tasks (C14)')
  } else {
    failures += 1
    missing.push(`S6: docker/windows-oem/cua-firstboot.ps1 must order ${order.join(' < ')} — got ${order.map((name) => `${name}=${index[name]}`).join(', ')} (each patch step's count==1 anchor depends on the previous one having finished) (C14)`)
    console.log('  FAIL S6 guest patch step order')
  }
}

/* ====================================================================== *
 * CB / WP-6 (§4.2) — THE SIX SEMANTIC BLOCKS S7..S12, one per contract that a
 * needle cannot express.
 *
 * The round's own history is why they exist: two needles in the previous round
 * were satisfied by the OLD expression preserved verbatim inside a doc comment
 * (`tools/check-cua-vm.mjs:2860-2872`). A literal can be quoted by prose; an
 * ORDER, an ARITHMETIC and a GATING cannot. Every block below therefore reads
 * STRUCTURE — indices, parsed numbers, frozen arrays — and strips comments
 * first wherever the file it reads is prose-heavy.
 * ====================================================================== */

/**
 * S7 — THE BOOT WINDOW'S ARITHMETIC AND ITS WIRING (C1, C9).
 *
 * Four numbers decide whether a boot race is modelled or invented: the window
 * (90 000, mirroring the guard's own budget), the attach ladder (24 000), the
 * probe offsets ([0, 8000, 20000]) and the in-window throttle (10 000). The
 * budget arithmetic is the part a needle cannot see:
 *
 *     last(offsets) <= BOOT_RACE_ATTACH_MS < WIN_MCP_ATTACH_TIMEOUT_MS
 *     BOOT_RACE_UPGRADE_INTERVAL_MS < RELAY_UPGRADE_INTERVAL_MS
 *
 * A ladder that does not fit inside the 45 s handshake burns the attach and
 * still lands blind (M-23 applies exactly that revert). A declared-but-unused
 * throttle is the other half: the constant must reach the guard call site, and
 * the ladder's probes must pass `force: true` or the 10 s probe cache makes the
 * whole ladder decorative.
 */
{
  total += 1
  const mcp = textOf('win-mcp.js')
  const indexText = textOf('index.js')
  const num = (raw) => (raw === null || raw === undefined ? null : Number(String(raw).replace(/_/gu, '')))
  const offsetsMatch = /export const BOOT_RACE_PROBE_OFFSETS_MS = Object\.freeze\(\[([^\]]*)\]\)/u.exec(mcp)
  const offsets = offsetsMatch === null
    ? null
    : offsetsMatch[1].split(',').map((part) => num(part.trim())).filter((value) => value !== null)
  const attach = num(/export const BOOT_RACE_ATTACH_MS = ([\d_]+)/u.exec(mcp)?.[1] ?? null)
  const windowMs = num(/export const BOOT_RACE_WINDOW_MS = ([\d_]+)/u.exec(mcp)?.[1] ?? null)
  const upgrade = num(/export const BOOT_RACE_UPGRADE_INTERVAL_MS = ([\d_]+)/u.exec(mcp)?.[1] ?? null)
  const relayUpgrade = num(/export const RELAY_UPGRADE_INTERVAL_MS = ([\d_]+)/u.exec(mcp)?.[1] ?? null)
  const hostAttach = num(/const WIN_MCP_ATTACH_TIMEOUT_MS = ([\d_]+)/u.exec(indexText)?.[1] ?? null)
  // TWO SITES, TWO FACTS: the DOOR that closes the ladder outside the window,
  // and the LADDER FUNCTION whose probes must be forced. The ladder is its own
  // function (it sleeps between rungs), so slicing from the door would measure
  // the wrong region — that is how a rewrite moves the probe out of the slice and
  // the assertion goes quietly green.
  const doorAt = mcp.indexOf('if (bootWindow.live !== true) ')
  const ladderAt = mcp.indexOf('async function bootRaceProbeLadder(')
  const ladderEnd = ladderAt === -1 ? -1 : mcp.indexOf('\n}', ladderAt)
  const ladderSlice = ladderAt === -1 ? '' : mcp.slice(ladderAt, ladderEnd === -1 ? ladderAt + 4000 : ladderEnd)
  const ascending = Array.isArray(offsets) && offsets.length > 0 && offsets.every((value, position) => position === 0 || offsets[position - 1] < value)
  const offsetsFit = Array.isArray(offsets) && offsets.length > 0 && attach !== null && offsets[offsets.length - 1] <= attach
  const attachFits = attach !== null && hostAttach !== null && attach < hostAttach
  const upgradeFits = upgrade !== null && relayUpgrade !== null && upgrade < relayUpgrade
  const windowIsNinety = windowMs === 90000
  const forceInsideLadder = ladderSlice.includes('force: true')
  // THE THROTTLE IS WIRED WHEN THE CONSTANT IS USED NEXT TO `intervalMs`, in
  // either shape — inline (`intervalMs: … ? BOOT_RACE_UPGRADE_INTERVAL_MS : …`)
  // or through a local (`const intervalMs = … BOOT_RACE_UPGRADE_INTERVAL_MS …`;
  // `shouldUpgradeToRelay({ …, intervalMs })`). Each use is checked with 300
  // characters of context, because a declared-but-unused constant is the exact
  // revert this row exists for.
  const upgradeUses = [...mcp.matchAll(/BOOT_RACE_UPGRADE_INTERVAL_MS/gu)].map((match) => match.index)
  const throttleWired = upgradeUses.length >= 2
    && upgradeUses.slice(1).some((at) => /intervalMs/u.test(mcp.slice(Math.max(0, at - 300), at + 300)))
  const ok = ascending && offsetsFit && attachFits && upgradeFits && windowIsNinety
    && doorAt !== -1 && ladderAt !== -1 && forceInsideLadder && throttleWired
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log(`  ok   S7 the boot window is 90000, its offsets are frozen/ascending (${JSON.stringify(offsets)}), last ${offsets[offsets.length - 1]} <= attach ${attach} < handshake ${hostAttach}, throttle ${upgrade} < ${relayUpgrade}, and the ladder passes force:true (C1/C9)`)
  } else {
    failures += 1
    missing.push(`S7: the boot-race window's arithmetic/wiring is broken — window=${windowMs} (90000 required), offsets=${JSON.stringify(offsets)} (frozen, ascending), last<=attach: ${offsetsFit}, attach(${attach}) < handshake(${hostAttach}): ${attachFits}, throttle(${upgrade}) < relayUpgrade(${relayUpgrade}): ${upgradeFits}, the door (if (bootWindow.live !== true)) present: ${doorAt !== -1}, the ladder function present: ${ladderAt !== -1}, force:true inside it: ${forceInsideLadder}, the 10 s throttle wired into the upgrade guard: ${throttleWired} — a ladder that does not fit the handshake burns the attach and still lands blind (C1/C9)`)
    console.log('  FAIL S7 boot-race window arithmetic')
  }
}

/**
 * S8 — THE CLASSIFIER'S ORDER (C7): measured evidence outranks the window.
 *
 * `classifyBlindReason` is a rule ladder and its ORDER is the contract: a
 * measured `session=0` / `hash=''` (rules 3-4) must be decided BEFORE the boot
 * window is consulted, or a measured dead guest is relabelled "wait a bit" —
 * the same lie the window exists to stop, with the sign flipped. `'boot-race'`
 * in turn must come before the RELAY_DOWN/RELAY_BAD rule (rule 8), because it
 * IS that rule's case with an anchor. Comments are stripped: the rule table is
 * documented in prose right above the code.
 */
{
  total += 1
  const indexText = textOf('index.js')
  const start = indexText.indexOf('function classifyBlindReason(')
  const end = start === -1 ? -1 : indexText.indexOf('\nfunction ', start + 1)
  const body = stripJsComments(start === -1 ? '' : indexText.slice(start, end === -1 ? indexText.length : end))
  const measuredAt = body.indexOf('measuredSession === 0') !== -1
    ? body.indexOf('measuredSession === 0')
    : body.indexOf("return 'no-interactive-session'")
  const bootRaceAt = body.indexOf("'boot-race'")
  const downAt = body.indexOf("if (status === 'RELAY_DOWN' || status === 'RELAY_BAD')")
  const ok = measuredAt !== -1 && bootRaceAt !== -1 && downAt !== -1
    && measuredAt < bootRaceAt && bootRaceAt < downAt
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   S8 classifyBlindReason ranks MEASURED evidence above "boot-race", and "boot-race" above the RELAY_DOWN/RELAY_BAD rule (C7)')
  } else {
    failures += 1
    missing.push(`S8: index.js classifyBlindReason() must order measured-session evidence (${measuredAt}) < 'boot-race' (${bootRaceAt}) < the RELAY_DOWN|RELAY_BAD rule (${downAt}) — the window may never be consulted before measured evidence, or a measured dead guest is relabelled "wait a bit" (C7)`)
    console.log('  FAIL S8 blind-reason order')
  }
}

/**
 * S9 — THE PROBE'S PRODUCER ORDER AND THE SIX-MEMBER SET (C3).
 *
 * `probe-unsupported` is only honest if the program can PROVE it was talking to
 * an old relay: connected, `RELAY_FN` sent, zero bytes back. The flags must be
 * set in that order (and outside the `try`, so the `except` cannot erase them),
 * and the reason must be in the closed set — a reason the normaliser does not
 * know is silently downgraded to `no-evidence`, which is exactly RC-3 again.
 */
{
  total += 1
  const mcp = textOf('win-mcp.js')
  const programAt = mcp.indexOf('export function relayFunctionalProbeProgram(')
  const connectedAt = mcp.indexOf('_connected = True', programAt === -1 ? 0 : programAt)
  const sentAt = mcp.indexOf("sendall(b'RELAY_FN')", programAt === -1 ? 0 : programAt)
  const reasonAt = mcp.indexOf("'probe-unsupported'", programAt === -1 ? 0 : programAt)
  const reasonsMatch = /export const RELAY_FN_REASONS = Object\.freeze\(\[([^\]]*)\]\)/u.exec(mcp)
  const reasons = reasonsMatch === null ? null : [...reasonsMatch[1].matchAll(/'([^']*)'/gu)].map((match) => match[1])
  const six = reasons !== null && reasons.length === 6 && reasons[5] === 'probe-unsupported'
  const ok = programAt !== -1 && connectedAt !== -1 && sentAt !== -1 && reasonAt !== -1
    && connectedAt < sentAt && sentAt < reasonAt && six
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log(`  ok   S9 the functional program proves probe-unsupported in order (_connected < RELAY_FN sent < reason), and RELAY_FN_REASONS is exactly six members ending with it (C3)`)
  } else {
    failures += 1
    missing.push(`S9: the probe program must set _connected (${connectedAt}) BEFORE sending RELAY_FN (${sentAt}) and name probe-unsupported after both (${reasonAt}), and RELAY_FN_REASONS must be exactly six members ending with 'probe-unsupported' (got ${JSON.stringify(reasons)}) — an unknown reason is normalized to no-evidence, which is RC-3 again (C3)`)
    console.log('  FAIL S9 probe producer / reason set')
  }
}

/**
 * S10 — PAYLOAD STAGING IS GATED, MEASURED AND LANGUAGE-FREE (C2, C4).
 *
 * The single most dangerous mistake in the round: letting the 15 s poll stage a
 * 43 KB file. The gate is an EARLY RETURN — `if (payloadRepair !== true) return`
 * — and the assertion is that it runs BEFORE the staging call, i.e. before
 * `relayGuardStagePlan()` is ever invoked. The plan builder itself is a PURE
 * function that may be defined anywhere (it builds commands; it executes
 * nothing), so pinning the definition's position would test the file's layout
 * instead of the behaviour — which is exactly what S7-S12 exist not to do.
 *
 * The other two halves: a build that cannot say the expected hash must take the
 * `'absent'` path instead of writing, and the facts-file classification must
 * never branch on the localized English `cannot find`.
 */
{
  total += 1
  const mcp = textOf('win-mcp.js')
  const gateMatch = /if \(payloadRepair !== true\) return\b/u.exec(mcp)
  const gateAt = gateMatch === null ? -1 : gateMatch.index
  const stageAt = gateAt === -1 ? -1 : mcp.indexOf('relayGuardStagePlan(', gateAt)
  const planAt = mcp.indexOf('export function relayGuardStagePlan(')
  const expectedAt = mcp.indexOf('expectedGuardHash()')
  const absentAt = mcp.indexOf("'absent'")
  const factsAt = mcp.indexOf('desktopFacts')
  const factsSlice = factsAt === -1 ? '' : mcp.slice(factsAt, factsAt + 9000)
  const languageFree = factsSlice !== '' && /cannot find/iu.test(factsSlice) === false
  const gated = gateAt !== -1 && stageAt !== -1 && gateAt < stageAt
  const ok = gated && planAt !== -1 && expectedAt !== -1 && absentAt !== -1 && languageFree
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   S10 payload staging returns EARLY unless payloadRepair is true (gate < staging call), a build that cannot say the hash takes the \'absent\' path, and the facts classification is language-free (C2/C4)')
  } else {
    failures += 1
    missing.push(`S10: payload staging must be gated by an early return (if (payloadRepair !== true) return… at ${gateAt}) BEFORE relayGuardStagePlan() is called (${stageAt}); the pure plan must exist with an expectedGuardHash() null branch and the 'absent' outcome (plan=${planAt}, expected=${expectedAt}, absent=${absentAt}); and the desktopFacts classification must not branch on localized English 'cannot find' (languageFree=${languageFree}) — the ungated form makes the poll push 8 SSH children a minute (C2/C4)`)
    console.log('  FAIL S10 payload repair gating')
  }
}

/**
 * S11 — THE LEAKS SHAPE (C5): the prefix surface, then the offline residue.
 *
 * `prefixSchemas` is the raw 19-name surface and `leaks` is what is LEFT when
 * the bridge is offline. The order matters — `leaks` is computed FROM
 * `prefixSchemas` — and the pinned `status:` expression must still be there
 * byte-for-byte, because the alternative fix (`leaksScope`) would have had to
 * touch it, and touching it is forbidden.
 */
{
  total += 1
  const indexText = textOf('index.js')
  const prefixAt = indexText.indexOf('const prefixSchemas = names.filter((name) => name.startsWith(TOOL_PREFIX))')
  const leaksAt = indexText.indexOf('const leaks = online === true ? [] : prefixSchemas')
  const pinnedStatus = indexText.includes("status: online !== true && leaks.length > 0 ? 'leaking'")
  const ok = prefixAt !== -1 && leaksAt !== -1 && prefixAt < leaksAt && pinnedStatus
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   S11 leaks is the OFFLINE residue of prefixSchemas (prefix < leaks) and the pinned leaking status expression is untouched (C5)')
  } else {
    failures += 1
    missing.push(`S11: index.js must compute const prefixSchemas = names.filter(...) (${prefixAt}) BEFORE const leaks = online === true ? [] : prefixSchemas (${leaksAt}), and keep status: online !== true && leaks.length > 0 ? 'leaking' verbatim (${pinnedStatus}) — restoring the full surface online is the reported defect (C5)`)
    console.log('  FAIL S11 leaks shape')
  }
}

/**
 * S12 — GUEST IDENTITY, AND MEASURE-THEN-WRITE (WP-1A).
 *
 * `$scriptVersion = '1.3.0'` dates a provisioning-contract change (a marker
 * field and two steps that stop writing unconditionally). The two steps are the
 * point: the guard's `$stagedHash` must be MEASURED before it is compared, and
 * the compare must come before the single `Copy-Item`, or a later provisioning
 * pass overwrites a guard the harness staged from a newer plugin; the launcher's
 * port must be READ before `$relayPort` is used, or a provisioning pass undoes
 * the harness's `--port` repair.
 */
{
  total += 1
  const ps1 = textOf('cua-firstboot.ps1')
  const versionOk = ps1.includes("$scriptVersion = '1.3.0'")
  const slice = (marker) => {
    const at = ps1.indexOf(marker)
    if (at === -1) return ''
    const next = ps1.indexOf('\nStep ', at + 1)
    return ps1.slice(at, next === -1 ? ps1.length : next)
  }
  // COMMENTS STRIPPED FIRST, and it is not fastidiousness: the guard step's own
  // doc comment SAYS "this used to be an unconditional Copy-Item", so a raw
  // index() finds the prose before the code and the order assertion would pass
  // on a file that had been reverted. `#` is the comment syntax both ps1 and
  // python use, and the stripper is string-aware.
  const guardStep = stripPythonComments(slice("Step 'relay-guard-task' {"))
  // THE MEASURE, NOT THE INITIALISATION. `$stagedHash = ` alone is satisfied by
  // `$stagedHash = ''` two lines above the real measurement, which is how the PRE
  // review proved this block vacuous: deleting the Get-FileHash call left S12
  // green. The anchor is the ASSIGNMENT THAT MEASURES (`$stagedHash = (Get-FileHash
  // -LiteralPath $guardScript`): a bare call would match a later, unrelated
  // FileHash use in the same step and the order check would pass on a deleted
  // measurement (measured: -1 is the honest answer for "it is gone").
  const measuredAt = guardStep.indexOf('$stagedHash = (Get-FileHash -LiteralPath $guardScript')
  const comparedAt = guardStep.indexOf('-ne $stagedHash')
  const copiedAt = guardStep.indexOf('Copy-Item')
  const guardOrder = measuredAt !== -1 && comparedAt !== -1 && copiedAt !== -1
    && measuredAt < comparedAt && comparedAt < copiedAt
  const relayStep = stripPythonComments(slice("Step 'mcp-relay-task' {"))
  const portReadAt = relayStep.indexOf('Get-RelayLauncherPort')
  const portUsedAt = relayStep.indexOf('$relayPort')
  const portOrder = portReadAt !== -1 && portUsedAt !== -1 && portReadAt < portUsedAt
  const ok = versionOk && guardOrder && portOrder
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   S12 the guest identity is 1.3.0, the guard step MEASURES $stagedHash before it compares and before the single Copy-Item, and the launcher port is READ before $relayPort is used (WP-1A)')
  } else {
    failures += 1
    missing.push(`S12: cua-firstboot.ps1 must carry $scriptVersion = '1.3.0' (${versionOk}); inside Step 'relay-guard-task' the STAGED measure — Get-FileHash -LiteralPath $guardScript (${measuredAt}) must precede its comparison (${comparedAt}) and the Copy-Item (${copiedAt}); inside Step 'mcp-relay-task' Get-RelayLauncherPort (${portReadAt}) must precede $relayPort (${portUsedAt}) — write-always overwrites a guard/launcher the harness repaired (WP-1A)`)
    console.log('  FAIL S12 guest identity / measure-then-write')
  }
}

/* ====================================================================== *
 * WP-D (§D-4) — THE SEVEN LOCK/STATE/BUDGET BLOCKS, L1..L7.
 *
 * The round's contracts are ORDER, ARITHMETIC and CLASSIFICATION, and none of
 * those is expression-able as a needle: "the state is written before the thing
 * that can fail", "the busy branch re-arms the poll", "a waiter expires instead
 * of running". Every block below therefore reads STRUCTURE — slices, indices,
 * counted literals — and calls `stripJsComments` first, because each of these
 * files documents the very defect it must no longer contain, and a raw index()
 * would find the prose and pass on a reverted file (the exact failure that made
 * two earlier needles vacuous).
 *
 * ONE MUTATION PER CONTRACT (§D-6): M-30→L1, M-31/M-33→L2, M-32→L3,
 * M-34→L5, M-35→L6, M-36→L7. L4 (staleness) has no row of its own: it is proved
 * by construction, because every field it reads is produced by the code the
 * other six rows mutate.
 * ====================================================================== */

/** A slice of one file, comments stripped, '' when the anchors moved. */
function lSlice(source, from, to) {
  if (source === '') return ''
  const start = source.indexOf(from)
  if (start === -1) return ''
  const end = source.indexOf(to, start)
  return source.slice(start, end === -1 ? source.length : end)
}

/**
 * L1 — THE LOCK IS A DEADLINE, NOT A QUEUE (C2–C7).
 *
 * The module must carry the deadline, the poison threshold, the legacy `0 ⇒
 * Infinity` knob, the typed refusal with its three FIELDS, the snapshot and the
 * `try*` pair; the supervisor must ADOPT it through adapters (`withVmLock` stays
 * two-parameter — the needle above pins that), and the classification table must
 * be visible: user-facing ops through `withVmLockAs(`, background loops through
 * `mode: 'try'` (C6). A `withVmLock` that is a bare chain again fails here.
 */
{
  total += 1
  const supervisorFile = pick('cua-vm-supervisor.mjs')
  const lockFile = supervisorFile === null ? null : path.join(path.dirname(supervisorFile), 'cua-vm-lock.mjs')
  const lock = lockFile !== null && existsSync(lockFile) ? stripJsComments(readFileSync(lockFile, 'utf8')) : ''
  const supervisor = stripJsComments(textOf('cua-vm-supervisor.mjs'))
  const has = (text, needle) => text.includes(needle)
  const moduleFacts = lock !== '' && [
    has(lock, 'export const LOCK_WAIT_MS = 30_000'),
    has(lock, 'export const LOCK_POISON_MS = 1_800_000'),
    has(lock, 'zeroMeansInfinity: true'),
    has(lock, "this.code = 'lock-timeout'"),
    has(lock, 'this.lockHeldBy = holder'),
    has(lock, 'this.lockHeldMs = heldMs'),
    has(lock, 'this.waitedMs ='),
    has(lock, 'export class LockTimeoutError extends Error'),
    has(lock, 'export function lockSnapshot()'),
    has(lock, 'export async function tryLock('),
    has(lock, 'export async function tryVmLock('),
    has(lock, 'export function lockTimeoutSentence('),
    // J3: the removal path prunes the two rate-limiter maps by NAME, and the
    // supervisor calls it where it prunes its own VM_STATE_LAST. A delete that
    // leaves a cadence entry behind is the leak this pair exists to stop.
    has(lock, 'export function pruneLockWarnings(vmName)'),
    has(lock, "this.code = 'lock-order-violation'"),
    has(lock, 'options.reentrant !== false'),
    has(lock, 'reentrant: false')
  ].every(Boolean)
  const adapters = [
    has(supervisor, "import * as VM_LOCK from './cua-vm-lock.mjs'"),
    has(supervisor, 'const VM_LOCK_CONTEXT = new AsyncLocalStorage()'),
    has(supervisor, 'VM_LOCK.useLockLogger('),
    has(supervisor, 'function withLock(key, fn) {'),
    has(supervisor, 'VM_LOCK.withLock(lifecycleKey(key)'),
    has(supervisor, 'function withVmLock(name, fn) {'),
    has(supervisor, 'function withVmLockAs(name, holder, fn)'),
    has(supervisor, "if (options.mode === 'try') return VM_LOCK.tryVmLock(name, fn, shared)"),
    has(supervisor, 'VM_LOCK.lockSnapshot()'),
    has(supervisor, 'error instanceof VM_LOCK.LockTimeoutError'),
    has(supervisor, 'VM_LOCK.lockTimeoutSentence(error, { state })'),
    has(supervisor, 'VM_LOCK.pruneLockWarnings(key)')
  ].every(Boolean)
  // C6: user-facing ops THROW (they name a holder through the sibling), and the
  // background loops (gc, install watch, idle, checkpoint) SKIP.
  const throwSites = (supervisor.match(/withVmLockAs\(/gu) ?? []).length
  const trySites = (supervisor.match(/mode: 'try'/gu) ?? []).length
  const ok = moduleFacts && adapters && throwSites >= 6 && trySites >= 3
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log(`  ok   L1 a waiter DEADLINE, a named holder, a snapshot, try-modes and the order guard live in docker/cua-vm-lock.mjs; the supervisor adopts them through adapters (${throwSites} throwing sites, ${trySites} try sites) (C2–C7)`)
  } else {
    failures += 1
    missing.push(`L1: the lock contract is broken — docker/cua-vm-lock.mjs ${lock === '' ? `is MISSING next to the supervisor (${lockFile ?? 'no supervisor'})` : 'is present but incomplete'} (moduleFacts=${moduleFacts}); the supervisor adapters=${adapters}; user-facing withVmLockAs( sites=${throwSites} (≥6: destroy/suspend/resume/shutdown/start/provision); mode:'try' sites=${trySites} (≥3: gc, install-watch, idle/checkpoint) — a deadline-less withVmLock is R1 again, and a background loop that throws instead of skipping is R2 (C3/C5/C6)`)
    console.log('  FAIL L1 lock deadline / holder / try-modes')
  }
}

/**
 * L2 — THE FACT IS WRITTEN UNDER `@registry` ONLY, AND THE TICK TAKES NO LOCK (W1, C9/C10/C24).
 *
 * Inside `finaliseGuestShutdown`: the CAS token is captured BEFORE the mutate,
 * the CAS comparison is the only thing standing between a stale verdict and a
 * live row, the state + `restoreFrom:{kind:'image'}` + the pending token land in
 * ONE mutate, and the capture is DEFERRED with its origin named — never inline,
 * and never inside `withVmLock` (that wrapper is what parked the tick and killed
 * the poll for the life of the process).
 */
{
  total += 1
  const supervisor = stripJsComments(textOf('cua-vm-supervisor.mjs'))
  const finalise = lSlice(supervisor, 'async function finaliseGuestShutdown(name, {', 'async function finaliseGuestPause(name, status)')
  const record = lSlice(supervisor, 'async function recordWindowsPoweredOff(name, {', 'async function windowsShutdown(name, meta) {')
  const guestState = finalise.search(/row\.state = 'powered-off'/u)
  const guestDefer = finalise.indexOf("scheduleDeferredWindowsCheckpoint(name, token, config, { origin: 'guest-shutdown' })")
  const guestLockFree = finalise !== '' && finalise.includes('withVmLock(') === false
  const expectToken = finalise.indexOf('const expect = { state: meta.state, stateSince: meta.stateSince }')
  const mutateAt = finalise.indexOf('mutateRegistryWith((')
  const casAt = finalise.indexOf('if (row.state !== expect.state || row.stateSince !== expect.stateSince) return false')
  const factShape = /row\.restoreFrom = \{ kind: 'image', image: 'windows' \}/u.test(finalise)
    && finalise.includes('row.checkpointPending = { token, at }')
    && finalise.includes("method: 'guest-shutdown'")
  const noInlineConvert = finalise !== ''
    && finalise.includes('runCaptureCommand(') === false
    && finalise.includes('checkpointDiskFile(') === false
  const refused = finalise.includes('superseded')
  const recordState = record.search(/row\.state = 'powered-off'/u)
  const recordDefer = record.indexOf('scheduleDeferredWindowsCheckpoint(name, token, config,')
  const recordWord = /checkpoint: status,/u.test(record) && /checkpointDeferred: status === 'deferred'/u.test(record)
  const ok = finalise !== '' && record !== ''
    && expectToken !== -1 && mutateAt !== -1 && expectToken < mutateAt
    && casAt !== -1
    && guestState !== -1 && guestDefer !== -1 && guestState < guestDefer
    && guestLockFree && factShape && noInlineConvert && refused
    && recordState !== -1 && recordDefer !== -1 && recordState < recordDefer && recordWord
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   L2 the guest power-off is ONE @registry mutate: CAS token captured first, state + restoreFrom + pending token together, previews after, and the capture DEFERRED with origin \'guest-shutdown\' — the slice takes no lifecycle lock (C9/C10/C24)')
  } else {
    failures += 1
    missing.push(`L2: finaliseGuestShutdown must write the FACT without the lifecycle lock — expect-token (${expectToken}) BEFORE the mutate (${mutateAt}), the CAS comparison present (${casAt}), state (${guestState}) BEFORE the deferred capture (${guestDefer}), NO withVmLock( in the slice (${guestLockFree}), restoreFrom/pending/method together (${factShape}), no inline capture (${noInlineConvert}), a refused write logged as superseded (${refused}); and recordWindowsPoweredOff must write powered-off (${recordState}) BEFORE its deferral (${recordDefer}) with the word answer (${recordWord}) — otherwise a stale verdict clobbers a live row, or the tick parks on the mutex and the poll dies (W1/W3/C9/C10)`)
    console.log('  FAIL L2 guest-shutdown fact order / CAS')
  }
}

/**
 * L3 — THE TICK ALWAYS RE-ARMS, AND IT IS ABANDONED, NOT WAITED FOR (C8).
 *
 * Three independent guarantees, because one was not enough: the busy branch
 * still calls `schedule()` (HEAD returned without it — that WAS the death), the
 * `finally` re-arms, and a tick older than `tickBudgetMs()` is abandoned with one
 * log line a minute while the loop keeps its cadence. The tick also takes no
 * lifecycle lock: a verdict is a FACT (W1), not an action.
 */
{
  total += 1
  const supervisor = stripJsComments(textOf('cua-vm-supervisor.mjs'))
  const budget = supervisor.includes('const TICK_BUDGET_MS = 10_000')
    && supervisor.includes('function tickBudgetMs() {')
    && /return Math\.max\(TICK_BUDGET_MS, 3 \* qmpStatePollMs\(\)\)/u.test(supervisor)
  const busyShape = supervisor.includes('const busy = running !== null && Date.now() - running.at < tickBudgetMs()')
    && supervisor.includes('if (busy) { schedule(); return }')
  const abandon = supervisor.includes('state poll tick still running after')
  const tick = lSlice(supervisor, 'const tick = async () => {', 'function installQmpStateWatcher(')
  const rearms = tick !== ''
    && tick.includes('if (running === marker) running = null')
    && /finally \{\s*if \(running === marker\) running = null\s*schedule\(\)/u.test(tick)
  const lockFree = tick !== '' && tick.includes('withVmLock(') === false
  const watcher = supervisor.includes('function startQmpStatePoll(name)') && supervisor.includes('installQmpStateWatcher(name)')
  const ok = budget && busyShape && abandon && rearms && lockFree && watcher
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   L3 the QMP tick RE-ARMS in the busy branch and in the finally, is ABANDONED past tickBudgetMs() with one line a minute, and takes no lifecycle lock (C8)')
  } else {
    failures += 1
    missing.push(`L3: the QMP poll must survive a slow tick — TICK_BUDGET_MS/tickBudgetMs() (${budget}), the busy branch that still re-arms (${busyShape}), the abandon log line (${abandon}), the finally that clears the marker and schedules (${rearms}), no withVmLock( in the tick (${lockFree}), the watcher present (${watcher}) — a busy tick that returns without scheduling is the DEATH of the poll (R2/C8)`)
    console.log('  FAIL L3 watcher re-arm / abandon')
  }
}

/**
 * L4 — STALENESS IS DERIVED ON READ (C12–C15).
 *
 * A corroboration timestamp that survives no restart, a window table with the
 * four live states, the exact derivation (Windows-only, age compared to the
 * state's OWN window, `null`/`false` for Linux), the four row fields, and the
 * plugin's TOP-LEVEL `state{}` block — while `probe.stale` keeps its one old
 * meaning (`probeStale` still computed from the probe's own age).
 */
{
  total += 1
  const supervisor = stripJsComments(textOf('cua-vm-supervisor.mjs'))
  const indexText = stripJsComments(textOf('index.js'))
  const map = supervisor.includes('const STATE_CONFIRMED = new Map()')
    && supervisor.includes('function confirmVmState(name, source)')
    // J3: the map is PRUNED on removal, in the same block that prunes the state
    // bus's own VM_STATE_LAST. A corroboration timestamp for a computer that no
    // longer exists is a stale fact waiting to be read by a recreated name.
    && supervisor.includes('STATE_CONFIRMED.delete(key)')
  const windows = /const STATE_CONFIRM_WINDOW_MS = Object\.freeze\(\{\s*ready: 120_000,\s*running: 120_000,\s*booting: 300_000,\s*installing: 300_000/u.test(supervisor)
  const derived = supervisor.includes('function stateStaleness(name, row, now = Date.now())')
    && /stale: windowMs !== null && ageMs !== null && ageMs > windowMs/u.test(supervisor)
    && /if \(kind !== 'windows'\) return \{ confirmedAt: null, source: null, ageMs: null, stale: false, windowMs: null \}/u.test(supervisor)
  const rowFields = supervisor.includes('function decorateStateFacts(rows, now = Date.now())')
    && ['row.stateConfirmedAt = facts.confirmedAt', 'row.stateConfirmedSource = facts.source', 'row.stateAgeMs = facts.ageMs', 'row.stateStale = facts.stale', 'row.lock = vmLockFacts(name)'].every((needle) => supervisor.includes(needle))
  const doctorLocks = supervisor.includes('locks: Object.entries(VM_LOCK.lockSnapshot())')
  const pluginBlock = indexText.includes('export function windowsStateFacts(')
    && indexText.includes('state: stateFacts,')
    && indexText.includes('lastEventAgeMs:')
    && indexText.includes("'plugin-derived'")
  const probeUntouched = indexText.includes('const probeStale = online !== true && probeAgeMs !== null && probeAgeMs > WIN_MCP_PROBE_STALE_MS')
    && indexText.includes('stale: probeStale,')
  const ok = map && windows && derived && rowFields && doctorLocks && pluginBlock && probeUntouched
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   L4 STATE_CONFIRMED + a four-state window table derive stateStale on every read, the row carries the four fields plus the lock, the doctor carries state{} and locks[], and probe.stale keeps its old meaning (C12–C15)')
  } else {
    failures += 1
    missing.push(`L4: staleness is derived, not guessed — STATE_CONFIRMED/confirmVmState (${map}), the ready/running=120 s · booting/installing=300 s window table (${windows}), the derivation and the Linux null/false branch (${derived}), the four row fields + lock (${rowFields}), the doctor's locks[] (${doctorLocks}), the plugin's top-level state{} with source plugin-derived and lastEventAgeMs (${pluginBlock}), and probe.stale UNTOUCHED (${probeUntouched}) — overloading probe.stale resurrects the contradiction R3 describes (C12–C15)`)
    console.log('  FAIL L4 staleness facts')
  }
}

/**
 * L5 — EVERY ROUTE HAS A BUDGET (C16–C18).
 *
 * One frozen table, a fallback that is not the socket default, `exec` computed
 * per call through the TOOL's resolver, and the 504 mapping: only a
 * `socket-timeout` becomes `route-timeout`; every other failure keeps its 503.
 * A route that calls `call(payload)` with one argument inherits thirty minutes,
 * which is defect R4.
 */
{
  total += 1
  const indexText = stripJsComments(textOf('index.js'))
  const table = indexText.includes('export const ROUTE_TIMEOUTS = Object.freeze({')
    && indexText.includes('state: 15_000,')
    && indexText.includes('start: 65_000,')
    && indexText.includes('exec: 0')
  const resolver = indexText.includes('export function routeTimeoutMs(action, body = {})')
    && indexText.includes("if (action === 'exec') return PER_CALL_TIMEOUTS.cua_vm_exec(body)")
    && indexText.includes('export const ROUTE_TIMEOUT_FALLBACK_MS = 30_000')
  const mapped = indexText.includes("error.code = 'socket-timeout'")
    && indexText.includes("if (error?.code === 'socket-timeout')")
    && indexText.includes("code: 'route-timeout',")
    && indexText.includes('the panel stopped waiting, the computer did not stop working')
    && /return send\(503, \{ ok: false, error: String\(error\?\.message \?\? error\) \}\)/u.test(indexText)
  const switchStart = indexText.indexOf('switch (action) {')
  const switchText = switchStart === -1 ? '' : indexText.slice(switchStart)
  const budgeted = (switchText.match(/routeTimeoutMs\(/gu) ?? []).length
  const ok = table && resolver && mapped && budgeted >= 20
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log(`  ok   L5 one FROZEN ROUTE_TIMEOUTS table (state 15 s, lifecycle 65 s, exec per call), a 30 s fallback, ${budgeted} budgeted route calls, and socket-timeout → 504 route-timeout with every other failure keeping its 503 (C16–C18)`)
  } else {
    failures += 1
    missing.push(`L5: the route budget contract is broken — the frozen table with state:15_000/start:65_000/exec:0 (${table}), routeTimeoutMs + PER_CALL_TIMEOUTS.cua_vm_exec + the 30 s fallback (${resolver}), the socket-timeout→504 route-timeout mapping with C18's sentence and the surviving 503 (${mapped}), budgeted route calls=${budgeted} (≥20) — an unbudgeted route inherits the thirty-minute socket default, which is R4 (C16–C18)`)
    console.log('  FAIL L5 route budgets')
  }
}

/**
 * L6 — THE PANEL RENDERS BOTH BUTTONS AND DISABLES WITH A REASON (C19/C20).
 *
 * `canPower` stays the HEAD expression AS A VALUE (so the semantic is
 * greppable), BOTH power buttons are rendered unconditionally with
 * `disabled: !canPower || busy`, the title carries the reason ladder (pending →
 * lock → state), the client budget is the route's plus 5 s on an `AbortSignal`,
 * and `Clean up`/`Create` are no longer gated on `pending` — that gate is how a
 * user was left with NO way out of a wedged operation.
 */
{
  total += 1
  const client = stripJsComments(textOf('client.js'))
  const canPower = client.includes('const canPower = (ready || (windows && installing))')
  const disabledCount = (client.match(/disabled: !canPower \|\| busy/gu) ?? []).length
  const hiddenForm = client.includes('canPower && h(')
  const reasons = ['Powered off — Start boots it', 'Suspended — Start resumes it',
    'Booting — the power buttons work once it is ready', 'Error — Start or delete first',
    'Another operation on', 'restart the supervisor']
    .filter((needle) => client.includes(needle)).length
  const budgets = client.includes('const CLIENT_TIMEOUTS = Object.freeze({')
    && /state: 20_000,\s*config: 20_000,/u.test(client.replace(/\n/gu, ' '))
    && client.includes('start: 70_000,')
    && client.includes('create: 1_810_000,')
    && client.includes('AbortSignal.timeout(budget)')
  const notGated = client.includes("onClick: () => void cleanup() }, 'Clean up')")
    && client.includes("'Create computer'")
    && client.includes('disabled: pending') === false
  const ok = canPower && disabledCount === 2 && hiddenForm === false && reasons === 6 && budgets && notGated
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   L6 both power buttons are RENDERED and DISABLED with a six-rung reason ladder, the client budget is route+5 s on an AbortSignal, and Clean up/Create are not gated on pending (C19/C20)')
  } else {
    failures += 1
    missing.push(`L6: the panel's button contract is broken — canPower as a value (${canPower}), disabled: !canPower || busy ×${disabledCount} (must be 2), the hidden form gone (${hiddenForm === false}), the reason ladder rungs=${reasons}/6, CLIENT_TIMEOUTS at route+5 s with AbortSignal.timeout (${budgets}), Clean up/Create un-gated (${notGated}) — a hidden button is the reported symptom, and a pending gate on Clean up is how a wedge became a page reload (C19/C20)`)
    console.log('  FAIL L6 panel buttons / client budget')
  }
}

/**
 * L7 — THE CHECKPOINT IS PRE-FLIGHTED, RESERVED AND ASYNC (C21–C24).
 *
 * `quota` AND `statfs` (with the 2 GiB reserve) before a byte is written, a
 * store RESERVATION that is always released, the `lock-busy` record for a busy
 * computer, and an AWAITED child — while the sync `checkpointDiskFile` survives
 * only on the Linux path (the needle above pins the Windows lane's await).
 */
{
  total += 1
  const supervisor = stripJsComments(textOf('cua-vm-supervisor.mjs'))
  const importStatfs = supervisor.includes('statfsSync')
  const space = supervisor.includes('const CHECKPOINT_FREE_RESERVE_BYTES = 2 * 1024 ** 3')
    && supervisor.includes('async function checkpointSpaceShortfall(diskBytes)')
    && supervisor.includes('statfsSync(STORE)')
    && supervisor.includes('const shortfall = await checkpointSpaceShortfall(diskBytes)')
    && supervisor.includes("checkpointSkipRecord('space', shortfall)")
  const claim = supervisor.includes("reserveStoreBytes('checkpoint:' + name, diskBytes)")
    && supervisor.includes("releaseStoreBytes('checkpoint:' + name)")
  const busy = supervisor.includes("checkpointSkipRecord('lock-busy'")
    && supervisor.includes('CHECKPOINT_LOCK_WAIT_MS')
  const lane = supervisor.includes('async function windowsCheckpointPlanDeferred(name, config)')
    && supervisor.includes('await checkpointDiskFileAsync(name, ')
  const deferredPlan = lSlice(supervisor, 'async function windowsCheckpointPlanDeferred(name, config)', 'function scheduleDeferredWindowsCheckpoint(')
  const syncOnWindows = deferredPlan !== '' && deferredPlan.includes('execFileSync(')
  const ok = importStatfs && space && claim && busy && lane && syncOnWindows === false
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log('  ok   L7 the checkpoint pre-flights quota AND filesystem space (2 GiB reserve), reserves/releases store bytes, records lock-busy, and captures through the ASYNC lane only (C21–C24)')
  } else {
    failures += 1
    missing.push(`L7: the checkpoint contract is broken — statfs imported (${importStatfs}), the space shortfall with the 2 GiB reserve wired into the decision (${space}), the reservation claimed and released in a finally (${claim}), the lock-busy record with its bounded wait (${busy}), the single deferred lane awaiting its child (${lane}), and NO execFileSync in that lane (${syncOnWindows === false}) — an unmeasured convert on a full store is the wedged-shutdown defect, and a sync one blocks the loop for 300 s (C21–C24)`)
    console.log('  FAIL L7 checkpoint space / async lane')
  }
}

/**
 * E1 — THE MUTATION MODE IS PRESENT, AND IT IS THIS FILE'S OWN.
 *
 * R10's permanent half: the pairs are worthless if nothing ever runs them, and
 * a mode that is claimed but not spelled is a mode someone deletes in a cleanup.
 * Asserted against the RUNNER'S OWN SOURCE (never a mutation target, per §7.3).
 */
{
  total += 1
  const selfText = readFileSync(SELF, 'utf8')
  const modeOk = selfText.includes("mutations: { type: 'boolean'")
    && selfText.includes('if (values.mutations) {')
    && selfText.includes('await runMutations()')
    && selfText.includes('red, ${results.length - proved} false-green')
  if (modeOk) {
    if (!process.argv.includes('--quiet')) console.log('  ok   E1 --mutations is a real mode of this runner (option, branch, runner, false-green counter)')
  } else {
    failures += 1
    missing.push('E1: tools/check-cua-vm.mjs must keep the --mutations mode: the `mutations` option, the `if (values.mutations)` branch, `await runMutations()`, and the false-green counter in the summary — a mode that CI cannot invoke is a claim, not a gate (C15)')
    console.log('  FAIL E1 mutation mode')
  }
}

/**
 * E2 — THE MUTATION TABLE IS FROZEN AND ITS TARGETS HAVE NOT DRIFTED.
 *
 * This is the cheap half of `--mutations`: it runs on EVERY gate invocation and
 * costs 36 in-memory searches instead of 36 subprocesses. It catches the two
 * failures that make a mutation table rot silently — a row dropped from the
 * table (the count is the contract: 36 — 20 from §7.3, two from JE1's marker pair
 * (M-21/M-22), six from the cold-boot round (M-23..M-28), one from the PRE review
 * (M-29, the staged-side measure that had no row) and seven from the
 * power-buttons round (M-30..M-36, one per L-block contract)) and a `find` literal that no longer
 * occurs because the line it targeted was reworded (the pair then "passes" by
 * mutating nothing, which is the false-green the runner would report only if
 * someone ran it).
 */
{
  total += 1
  const ids = MUTATIONS.map((row) => row.id)
  const uniqueIds = new Set(ids).size === ids.length && ids.length === 36
  const drift = []
  for (const row of MUTATIONS) {
    const file = pick(row.file)
    if (file === null) { drift.push(`${row.id}: ${row.file} missing`); continue }
    const hits = readFileSync(file, 'utf8').split(row.find).length - 1
    if (hits < 1 || (row.all !== true && hits !== 1)) drift.push(`${row.id}: ${hits} × ${JSON.stringify(row.find)}`)
  }
  const ok = uniqueIds && drift.length === 0
  if (ok) {
    if (!process.argv.includes('--quiet')) console.log(`  ok   E2 the mutation table carries ${MUTATIONS.length} unique pairs and every find literal still occurs exactly where it should (E-4)`)
  } else {
    failures += 1
    missing.push(`E2: the mutation table must carry 36 unique pairs whose find literals still occur (ids=${ids.length}/${new Set(ids).size} unique; drift: ${drift.length === 0 ? 'none' : drift.join('; ')}) — a drifted literal mutates nothing and the pair goes quiet (E-4)`)
    console.log('  FAIL E2 mutation table drift')
  }
}

if (failures > 0) {
  // THE COUNT IS PART OF THE FAILURE, not only of the success. A red gate that
  // prints "3 assertion(s) failed" and nothing about the 1,100 that passed reads
  // as "the gate is broken", and the reader cannot tell a one-needle regression
  // from a truncated run. `total` is the same counter the green path prints.
  console.error(`\n${failures} assertion(s) failed of ${total}:`)
  for (const line of missing) console.error(`  - ${line}`)
  console.error('\nThe personal VM is one chain: spec → supervisor → guest → plugin → proxy → compose.')
  console.error('A missing line is a hop that no longer exists, not a formatting nit.')
  process.exit(1)
}

if (!values.quiet) {
  console.log(`\npersonal VM wired end to end: registry, accounting, shutdown, space, Windows, proxy, compose.`)
  console.log(`${total} assertion(s) across ${Object.keys(FILES).length} file(s).`)
}
process.exit(0)
