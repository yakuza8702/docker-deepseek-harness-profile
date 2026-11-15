#!/usr/bin/env node
/**
 * check-anchors — prove the build-time bundle patches still apply, OFFLINE.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tools/patch-plugin-manager-page.mjs` and `tools/patch-sidebar-footer.mjs`
 * edit upstream client bundles at image build time. They are content-anchored on
 * purpose: when upstream moves the code they must fail the build rather than
 * silently ship a page without its slot. That is right, but it means the FIRST
 * signal is a red image build — and on 2026-11-15 that is exactly what happened:
 * `dsh-v0.2.2-rc.3` started shipping a MINIFIED bundle (backtick literals, one
 * line), the literal anchors matched 0 times, and the build died at
 * Dockerfile:394 with no local way to reproduce it.
 *
 * This gate makes both directions reproducible in a second, with no network:
 *
 *   fixture                         -> patcher exits 0, marker present, output parses
 *   fixture (patched)               -> second run is a no-op (idempotent)
 *   fixture with the anchor renamed -> patcher exits 1 (the refusal still works)
 *
 * The fixtures in tools/fixtures/ are SHAPED like the real 0.2.2-rc.3 bundles
 * (minified, backticked, one line) — not like the pretty-printed sources — so a
 * future bundler change shows up here before it shows up in CI.
 *
 * Usage: node tools/check-anchors.mjs [--quiet]
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// EVERY path below is resolved from THIS FILE's directory. The guard lives in
// `tools/` in a checkout and in `/opt/seek-harness/tools/` inside the image, and
// it is invoked from an arbitrary cwd — so a path that depends on `process.cwd()`
// (or on a `../` layout) works in exactly one of those places.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const QUIET = process.argv.includes('--quiet')

let failures = 0
let total = 0
const fail = (message) => {
  failures += 1
  console.log(`  FAIL ${message}`)
}
const check = (label, condition, detail = '') => {
  total += 1
  if (condition) {
    if (!QUIET) console.log(`  ok   ${label}${detail === '' ? '' : ` — ${detail}`}`)
  } else {
    fail(`${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/**
 * Run a node script and capture its exit code without throwing.
 *
 * `cwd: HERE` — the guard runs from `/` inside the image (`RUN node
 * /opt/seek-harness/tools/check-anchors.mjs`), so anything resolved against the
 * caller's cwd is wrong there and right in a checkout. That is exactly how the
 * first version failed the build: `run(['tools/probe-anchors.mjs', …])` looked
 * for `/tools/probe-anchors.mjs` and both probe assertions failed.
 */
function run(argv) {
  try {
    const stdout = execFileSync(process.execPath, argv, { encoding: 'utf8', cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Parses with the same checker the build itself implies (V8, via node --check). */
function parses(file) {
  return run(['--check', file]).code === 0
}

/** Build a fake installation root holding one package's bundle (flat npm layout). */
function layout(work, packageName, fixture) {
  const dir = path.join(work, ...packageName.split('/'), 'lib')
  mkdirSync(dir, { recursive: true })
  cpSync(fixture, path.join(dir, 'client.js'))
  return path.join(dir, 'client.js')
}

const CASES = [
  {
    name: 'plugin-manager',
    package: '@deepseek-ai/dsh-client-ui-plugin-manager',
    script: 'patch-plugin-manager-page.mjs',
    fixture: 'fixtures/plugin-manager-client.min.js',
    marker: 'plugins.page.top',
    rename: ['"plugins.item":{kind:`list`', '"plugins.entry":{kind:`list`'],
  },
  {
    name: 'sidebar',
    package: '@deepseek-ai/dsh-client-ui-sidebar',
    script: 'patch-sidebar-footer.mjs',
    fixture: 'fixtures/sidebar-client.min.js',
    marker: 'sidebar.footer.trailing',
    probe: 'sidebar',
    rename: ['"sidebar.footer.action":{kind:`list`', '"sidebar.footer.act":{kind:`list`'],
  },
]

// PACKAGING CHECK FIRST: every input must be beside this file. A missing copy
// used to surface as MODULE_NOT_FOUND from a child process, which reads like an
// anchor failure; say what is actually wrong.
{
  const needed = ['probe-anchors.mjs', ...CASES.map((c) => c.script), ...CASES.map((c) => c.fixture)]
  const absent = needed.filter((file) => !existsSync(path.join(HERE, file)))
  if (absent.length > 0) {
    console.error(`anchor self-test: these files must sit next to check-anchors.mjs (${HERE}): ${absent.join(', ')}`)
    console.error('The Dockerfile copies them into /opt/seek-harness/tools/; a checkout has them under tools/.')
    process.exit(1)
  }
}

for (const testCase of CASES) {
  const work = mkdtempSync(path.join(tmpdir(), 'check-anchors-'))
  try {
    const fixture = path.join(HERE, testCase.fixture)
    const target = layout(work, testCase.package, fixture)

    const first = run([path.join(HERE, testCase.script), work])
    check(`${testCase.name}: the patch applies to the minified fixture`, first.code === 0, `exit ${first.code}`)
    const patched = readFileSync(target, 'utf8')
    check(`${testCase.name}: the marker is in the output`, patched.includes(testCase.marker))
    check(`${testCase.name}: the patched bundle still parses`, parses(target))

    const second = run([path.join(HERE, testCase.script), work])
    check(`${testCase.name}: a second run is a no-op`, second.code === 0 && /already patched/u.test(second.stdout), `exit ${second.code}`)

    // NEGATIVE: rename the anchor and confirm the build-time refusal still fires.
    const pristine = readFileSync(fixture, 'utf8')
    const broken = pristine.replace(testCase.rename[0], testCase.rename[1])
    check(`${testCase.name}: the fixture actually contains the anchor to rename`, broken !== pristine)
    writeFileSync(target, broken)
    const refused = run([path.join(HERE, testCase.script), work])
    check(`${testCase.name}: a moved anchor still FAILS (never silently ships)`, refused.code === 1, `exit ${refused.code}`)

    // The probe reads the same anchors; both must agree on the pristine fixtures.
    // (`--from-file` is the plugin-manager bundle; the sidebar is its own flag.)
    const probeScript = path.join(HERE, 'probe-anchors.mjs')
    if (!existsSync(probeScript)) {
      // The image build copies it; a checkout always has it. A missing probe is a
      // packaging mistake, not an anchor drift — say so instead of failing the
      // contract this guard exists to protect.
      console.log(`  note ${testCase.name}: probe-anchors.mjs is not beside this guard — skipping the cross-check`)
    } else {
      const probeArgs = testCase.probe === 'sidebar'
        ? [probeScript, '--from-file', path.join(HERE, 'fixtures/plugin-manager-client.min.js'),
          '--sidebar-from-file', fixture]
        : [probeScript, '--from-file', fixture, '--skip-sidebar']
      const probe = run(probeArgs)
      check(`${testCase.name}: probe-anchors agrees offline`, probe.code === 0, `exit ${probe.code}`)
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

console.log('')
if (failures > 0) {
  console.error(`${failures} anchor self-test(s) failed.`)
  console.error('A build-time bundle patch no longer applies. Fix the anchor in tools/patch-*.mjs')
  console.error('(keep the old shape as a fallback) before the image build discovers it at Dockerfile:394.')
  process.exit(1)
}
console.log(`anchor self-test: ${total} assertion(s) — both directions verified.`)
process.exit(0)
