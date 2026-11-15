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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
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

/** Run a node script and capture its exit code without throwing. */
function run(argv) {
  try {
    const stdout = execFileSync(process.execPath, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
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
    script: 'tools/patch-plugin-manager-page.mjs',
    fixture: 'tools/fixtures/plugin-manager-client.min.js',
    marker: 'plugins.page.top',
    rename: ['"plugins.item":{kind:`list`', '"plugins.entry":{kind:`list`'],
  },
  {
    name: 'sidebar',
    package: '@deepseek-ai/dsh-client-ui-sidebar',
    script: 'tools/patch-sidebar-footer.mjs',
    fixture: 'tools/fixtures/sidebar-client.min.js',
    marker: 'sidebar.footer.trailing',
    probe: 'sidebar',
    rename: ['"sidebar.footer.action":{kind:`list`', '"sidebar.footer.act":{kind:`list`'],
  },
]

for (const testCase of CASES) {
  const work = mkdtempSync(path.join(tmpdir(), 'check-anchors-'))
  try {
    const target = layout(work, testCase.package, path.join(ROOT, testCase.fixture))

    const first = run([path.join(ROOT, testCase.script), work])
    check(`${testCase.name}: the patch applies to the minified fixture`, first.code === 0, `exit ${first.code}`)
    const patched = readFileSync(target, 'utf8')
    check(`${testCase.name}: the marker is in the output`, patched.includes(testCase.marker))
    check(`${testCase.name}: the patched bundle still parses`, parses(target))

    const second = run([path.join(ROOT, testCase.script), work])
    check(`${testCase.name}: a second run is a no-op`, second.code === 0 && /already patched/u.test(second.stdout), `exit ${second.code}`)

    // NEGATIVE: rename the anchor and confirm the build-time refusal still fires.
    const pristine = readFileSync(path.join(ROOT, testCase.fixture), 'utf8')
    const broken = pristine.replace(testCase.rename[0], testCase.rename[1])
    check(`${testCase.name}: the fixture actually contains the anchor to rename`, broken !== pristine)
    writeFileSync(target, broken)
    const refused = run([path.join(ROOT, testCase.script), work])
    check(`${testCase.name}: a moved anchor still FAILS (never silently ships)`, refused.code === 1, `exit ${refused.code}`)

    // The probe reads the same anchors; both must agree on the pristine fixtures.
    // (`--from-file` is the plugin-manager bundle; the sidebar is its own flag.)
    const probeArgs = testCase.probe === 'sidebar'
      ? ['tools/probe-anchors.mjs', '--from-file', path.join(ROOT, 'tools/fixtures/plugin-manager-client.min.js'),
        '--sidebar-from-file', path.join(ROOT, testCase.fixture)]
      : ['tools/probe-anchors.mjs', '--from-file', path.join(ROOT, testCase.fixture), '--skip-sidebar']
    const probe = run(probeArgs)
    check(`${testCase.name}: probe-anchors agrees offline`, probe.code === 0, `exit ${probe.code}`)
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
