/**
 * 22-dsh-source-patch.mjs — the source-patch applier, asserted against a
 * throwaway git repository (no network, no image, no upstream checkout).
 *
 * The image builds its DSH source channel by cloning upstream, applying
 * `patches/auth-fix.patch`, running `pnpm run build`, then proving the compiled
 * lib carries the patch. A wrong answer here is expensive in the only place it
 * matters: a silent skip ships a harness without the fix, and a false failure
 * breaks every source build. So the three states are pinned as states:
 *
 *   pending   a clean tree the patch has not seen
 *   applied   the same tree after the patch — a second run MUST be a skip
 *   conflict  a tree that moved past the patch's base — MUST fail loudly
 *
 * plus the base-commit verdict (warn, never silently "verified") and the
 * built-artifact markers (a missing marker is a failure).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { check } from './harness.mjs'
import {
  BUILT_CHECKS, PROVENANCE_FILE, applyPatch, authFixEnabled, baseVerdict, main, patchState,
  repositoryHead, verifyAbsent, verifyBuilt
} from '../../tools/apply-dsh-source-patches.mjs'

const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-source-patch-'))
const repo = path.join(root, 'repo')
const patch = path.join(root, 'fixture.patch')
const conflicting = path.join(root, 'conflict.patch')

const git = (args) => spawnSync('git', ['-c', 'user.name=unit', '-c', 'user.email=unit@example.com', '-C', repo, ...args], { encoding: 'utf8' })
const read = (file) => readFileSync(file, 'utf8')

/** The fixture: one file the patch rewrites, committed as the "base". */
function makeRepo() {
  mkdirSync(repo, { recursive: true })
  writeFileSync(path.join(repo, 'account.txt'), 'grant: token-a\n')
  const init = git(['init', '-q'])
  const added = git(['add', 'account.txt'])
  const committed = git(['commit', '-q', '-m', 'base'])
  return init.status === 0 && added.status === 0 && committed.status === 0
}

/** A one-hunk unified diff over account.txt, in git's own format. */
function writePatch(file, before, after) {
  writeFileSync(file, [
    'diff --git a/account.txt b/account.txt',
    '--- a/account.txt',
    '+++ b/account.txt',
    '@@ -1 +1 @@',
    `-${before}`,
    `+${after}`,
    '',
  ].join('\n'))
}

const logs = []
const log = (line) => logs.push(line)

if (!makeRepo()) {
  check('S1: the throwaway git repo could not be created', false, 'git init/add/commit failed')
} else {
  writePatch(patch, 'grant: token-a', 'grant: token-a + two-strike expiry')
  check('S1: a clean tree reports the patch as pending', patchState(repo, patch).state === 'pending', patchState(repo, patch).state)
  check('S1: "pending" means the applier will act, not that it already did', applyPatch(repo, { patch, dryRun: true, log }).status === 'pending', 'dry run')
  check('S1: a dry run leaves the tree alone', read(path.join(repo, 'account.txt')) === 'grant: token-a\n', 'tree changed')

  // ---- apply, then the SAME call again ------------------------------------
  const first = applyPatch(repo, { patch, log })
  check('S2: the first run applies the patch', first.status === 'applied', first.status)
  check('S2: the file now carries the patched line', read(path.join(repo, 'account.txt')).includes('two-strike expiry'), 'file unchanged')

  const second = applyPatch(repo, { patch, log })
  check('S3: a second run is a no-op (idempotent)', second.status === 'already-applied', second.status)
  check('S3: the skip is announced, not silent', logs.some((line) => /already applied — skipped/u.test(line)), JSON.stringify(logs))
  check('S3: the second run did not double-apply', read(path.join(repo, 'account.txt')).split('two-strike expiry').length - 1 === 1, 'applied twice')

  // ---- a tree the patch cannot apply to ----------------------------------
  writePatch(conflicting, 'grant: token-zzz', 'grant: token-zzz + two-strike expiry')
  const conflict = (() => {
    try {
      applyPatch(repo, { patch: conflicting, log })
      return null
    } catch (error) {
      return error
    }
  })()
  const firstLine = (error) => String(error).split('\n')[0]
  check('S4: a patch that cannot apply fails instead of guessing', conflict instanceof Error, firstLine(conflict))
  check('S4: the failure names the patch file', /conflict\.patch does not apply to /u.test(String(conflict)), firstLine(conflict))
  check('S4: the failure keeps git\'s own reason', /error: patch failed:/u.test(String(conflict)) || /does not exist in index/u.test(String(conflict)), 'see the message above')

  // ---- base verdict: exact, mismatch, absent ------------------------------
  const head = repositoryHead(repo)
  check('S5: the exact base commit is reported as exact', baseVerdict(head, head.slice(0, 8)).exact === true, baseVerdict(head, head.slice(0, 8)).detail)
  const off = baseVerdict(head, '0123456789abcdef')
  check('S5: a different head is NOT reported as exact', off.exact === false, off.detail)
  check('S5: the mismatch says the patch was verified elsewhere', /NOT the patch base/u.test(off.detail), off.detail)
  const absent = baseVerdict(head, undefined)
  check('S5: no expected base is "unverified", never "exact"', absent.exact === false && /unverified/u.test(absent.detail), absent.detail)

  // ---- built-artifact markers --------------------------------------------
  // The fixtures are built FROM the contract table: a check added to
  // BUILT_CHECKS is exercised here without editing this suite, and a check
  // whose fixture this suite cannot build fails loudly instead of passing.
  const contract = BUILT_CHECKS['auth-fix.patch']
  const libDirs = []
  for (const spec of contract) {
    const dir = path.join(repo, spec.dir)
    libDirs.push(dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'index.js'), `// ${spec.reason}\n${spec.markers.join(' ')}\n`)
  }
  const hostLib = path.join(libDirs[0], 'index.js')
  const verified = verifyBuilt(repo, 'auth-fix.patch', log)
  check('S6: every compiled lib carrying its markers passes', verified.checks === contract.length && verified.files >= contract.length,
    `${verified.checks} check(s), ${verified.files} file(s)`)

  const firstSpec = contract[0]
  const missingMarker = firstSpec.markers[firstSpec.markers.length - 1]
  writeFileSync(hostLib, `// ${firstSpec.reason}\n${firstSpec.markers.slice(0, -1).join(' ')}\n`)
  const missing = (() => {
    try {
      verifyBuilt(repo, 'auth-fix.patch', log)
      return null
    } catch (error) {
      return error
    }
  })()
  check('S7: a compiled lib without a marker FAILS', missing instanceof Error, firstLine(missing))
  check('S7: the failure names the missing marker and its lib',
    new RegExp(`'${missingMarker}'`, 'u').test(String(missing)) && String(missing).includes(firstSpec.dir), 'see the message above')

  rmSync(libDirs[0], { recursive: true, force: true })
  const absentLib = (() => {
    try {
      verifyBuilt(repo, 'auth-fix.patch', log)
      return null
    } catch (error) {
      return error
    }
  })()
  check('S8: an unbuilt tree fails with the "was it built?" reason', absentLib instanceof Error && /was not built|does not exist/u.test(String(absentLib)), firstLine(absentLib))

  const noContract = (() => {
    try {
      verifyBuilt(repo, 'unrecorded.patch', log)
      return null
    } catch (error) {
      return error
    }
  })()
  check('S9: a patch with no artifact contract is refused, never assumed green',
    noContract instanceof Error && /no compiled-artifact contract for unrecorded\.patch/u.test(String(noContract)), firstLine(noContract))

  check('S10: the provenance file name is the documented one', PROVENANCE_FILE === '.dsh-profile-patches.json', PROVENANCE_FILE)

  // ---- the DSH_AUTH_FIX switch ------------------------------------------
  check('S11: the switch defaults to ON', authFixEnabled({}) === true, 'default')
  check('S11: DSH_AUTH_FIX=0 turns it OFF', authFixEnabled({ DSH_AUTH_FIX: '0' }) === false, '0')
  check('S11: an explicit 1 keeps it ON', authFixEnabled({ DSH_AUTH_FIX: '1' }) === true, '1')

  // A stock build proves the markers are ABSENT; a marker that leaks through is a failure.
  const absentTree = mkdtempSync(path.join(root, 'absent-'))
  const absentSpec = BUILT_CHECKS['auth-fix.patch'][0]
  const absentDirs = BUILT_CHECKS['auth-fix.patch'].map((spec) => path.join(absentTree, spec.dir))
  for (const dir of absentDirs) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'index.js'), '// stock upstream, no patch markers\n')
  }
  const absentDir = absentDirs[0]
  const absentOk = (() => {
    try {
      verifyAbsent(absentTree, 'auth-fix.patch', log)
      return true
    } catch (error) {
      return error
    }
  })()
  check('S12: a stock lib passes the DSH_AUTH_FIX=0 artifact check', absentOk === true, String(absentOk))
  writeFileSync(path.join(absentDir, 'index.js'), `// ${absentSpec.markers[0]}\n`)
  const leaked = (() => {
    try {
      verifyAbsent(absentTree, 'auth-fix.patch', log)
      return null
    } catch (error) {
      return error
    }
  })()
  check('S12: a patched marker in a DSH_AUTH_FIX=0 build FAILS', leaked instanceof Error, firstLine(leaked))

  // The CLI with the switch off must not patch and must record provenance "off".
  const offRepo = path.join(root, 'off-repo')
  mkdirSync(offRepo, { recursive: true })
  writeFileSync(path.join(offRepo, 'account.txt'), 'grant: token-a\n')
  const offGit = (args) => spawnSync('git', ['-c', 'user.name=unit', '-c', 'user.email=unit@example.com', '-C', offRepo, ...args], { encoding: 'utf8' })
  offGit(['init', '-q']); offGit(['add', 'account.txt']); offGit(['commit', '-q', '-m', 'base'])
  const offLogs = []
  const code = main([offRepo, '--patch', patch, '--auth-fix', '0'], (line) => offLogs.push(line))
  const offTree = read(path.join(offRepo, 'account.txt'))
  const provenance = JSON.parse(read(path.join(offRepo, PROVENANCE_FILE)))
  check('S13: the CLI exits cleanly with the switch off', code === 0, String(code))
  check('S13: it leaves the stock tree untouched', offTree === 'grant: token-a\n', offTree)
  check('S13: provenance records status "off"', provenance.patches[0].status === 'off', JSON.stringify(provenance))
  check('S13: the skip is announced, not silent', offLogs.some((line) => /auth fix: off/u.test(line)), JSON.stringify(offLogs))
}

rmSync(root, { recursive: true, force: true })
