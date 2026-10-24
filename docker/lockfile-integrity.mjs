#!/usr/bin/env node
/**
 * lockfile-integrity — boot-time repair for a pnpm lockfile that pnpm refuses.
 *
 * WHY THIS EXISTS
 * ---------------
 * pnpm (verified on 10.34.6, `pnpm.cjs` → `pkgSnapshotToResolution`) rejects a
 * lockfile resolution that has no `integrity` unless pnpm can recognise it as
 * git-hosted itself:
 *
 *     resolution.type == null && resolution.integrity == null
 *       && !tarball.startsWith("file:")
 *       && !(gitHosted === true || isGitHostedTarballUrl(tarball))
 *     -> ERR_PNPM_MISSING_TARBALL_INTEGRITY
 *
 * `isGitHostedTarballUrl` is only codeload.github.com/<…>.tar.gz, bitbucket.org
 * and gitlab.com. A GitHub **release asset**
 * (`https://github.com/<o>/<r>/releases/download/<tag>/<file>.tgz`) is none of
 * them — and pnpm WRITES that shape itself when such a URL is added, then
 * refuses it on the next operation that has to materialise the package.
 *
 * pnpm verifies the lockfile before ANY add/remove, so one such entry bricks
 * every install and uninstall in that profile — including installing a
 * completely unrelated, perfectly compatible plugin. Measured on
 * seek-harness-browser-test 2026-10-02: the Market's "Install" failed for every
 * plugin with a stack that named none of this.
 *
 * dshmarket installs curated catalog entries that ship a prebuilt release
 * archive from exactly that URL shape (~70 entries), so the condition returns
 * whenever one of them is installed.
 *
 * WHAT IT DOES
 * ------------
 * For every profile lockfile under the DSH home, find tarball resolutions pnpm
 * will reject, download the tarball once, and pin `integrity: sha512-…` on that
 * line — the same hash pnpm computes for itself when it fetches the URL. The
 * URL is already in the profile's own manifest (the user installed that plugin
 * deliberately), so this records what pnpm would install rather than trusting
 * anything new. The lockfile is backed up before it is written, the repair is
 * idempotent, and every skip or failure is logged and left alone.
 *
 * USAGE
 *   node lockfile-integrity.mjs [--home DIR] [--dry-run] [--self-test]
 *                               [--timeout MS]
 *   --dry-run     report only: no network, no writes
 *   --self-test   run the offline fixtures (build gate) and exit
 *   --timeout MS  per-download timeout (default 20000)
 *
 * The entrypoint runs this before DSH starts and ignores its exit status;
 * `DSH_LOCKFILE_REPAIR=0` disables the call entirely.
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PREFIX = '[lockfile-integrity]'
const log = (...args) => console.log(PREFIX, ...args)

/** Shapes pnpm accepts a tarball resolution WITHOUT an integrity (pnpm.cjs). */
function acceptedWithoutIntegrity(url) {
  if (url.startsWith('file:')) return true
  // pnpm: startsWith("https://codeload.github.com/") && includes("tar.gz") —
  // the ref sits AFTER `tar.gz/`, so the URL does not end with it.
  if (/^https:\/\/codeload\.github\.com\//i.test(url) && url.includes('tar.gz')) return true
  if (/^https:\/\/bitbucket\.org\//i.test(url)) return true
  if (/^https:\/\/gitlab\.com\//i.test(url)) return true
  return false
}

const RESOLUTION_LINE = /^(\s*)resolution:\s*\{(.*)\}\s*$/

/**
 * Pure scan — nothing is fetched and nothing is written.
 *
 * @param text lockfile contents.
 * @returns {{repairs: {line: number, indent: string, url: string}[], accepted: number, intact: number, unclear: string[]}}
 *   `repairs` are the lines pnpm will reject; `intact` are resolutions that
 *   already carry an integrity (or a gitHosted marker), `accepted` are the
 *   shapes pnpm takes without one, and `unclear` are resolutions that carry
 *   other keys, which this script deliberately refuses to rewrite.
 */
export function scan(text) {
  const lines = text.split('\n')
  const repairs = []
  const unclear = []
  let accepted = 0
  let intact = 0
  for (let i = 0; i < lines.length; i += 1) {
    const match = RESOLUTION_LINE.exec(lines[i])
    if (match === null) continue
    const body = match[2]
    if (!/(^|[\s{,])tarball:/.test(body)) {
      if (/(^|[\s{,])integrity:/.test(body)) intact += 1
      continue
    }
    if (/(^|[\s{,])integrity:/.test(body)) {
      intact += 1
      continue
    }
    if (/(^|[\s{,])gitHosted:/.test(body)) {
      intact += 1
      continue
    }
    const url = /(?:^|[\s{,])tarball:\s*([^,\s}]+)/.exec(body)?.[1]
    if (url === undefined) continue
    if (acceptedWithoutIntegrity(url)) {
      accepted += 1
      continue
    }
    // pnpm also accepts a resolution whose sibling key says gitHosted: true.
    const siblings = lines.slice(i + 1, i + 4).join('\n')
    if (/^\s*gitHosted:\s*true\s*$/m.test(siblings)) {
      accepted += 1
      continue
    }
    if (!/^(?:tarball:\s*\S+)$/.test(body.trim())) {
      unclear.push(`line ${i + 1}: ${body.trim()}`)
      continue
    }
    repairs.push({ line: i + 1, indent: match[1], url })
  }
  return { repairs, accepted, intact, unclear }
}

/** Rewrite the scanned lines in place, using a url → `sha512-…` map. */
export function repairText(text, hashes) {
  const lines = text.split('\n')
  const { repairs } = scan(text)
  for (const repair of repairs) {
    const hash = hashes.get(repair.url)
    if (hash === undefined) continue
    lines[repair.line - 1] = `${repair.indent}resolution: {integrity: ${hash}, tarball: ${repair.url}}`
  }
  return lines.join('\n')
}

/** Download a tarball once and return pnpm's own integrity string. */
async function hashUrl(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length === 0) throw new Error('empty body')
    return { integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`, bytes: body.length }
  } finally {
    clearTimeout(timer)
  }
}

function profileLockfiles(home) {
  const root = join(home, 'profiles')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map((name) => join(root, name, 'pnpm-lock.yaml'))
    .filter((file) => existsSync(file) && statSync(file).isFile())
    .sort()
}

async function run(home, { dryRun, timeoutMs }) {
  const files = profileLockfiles(home)
  if (files.length === 0) {
    log(`no profile lockfile under ${join(home, 'profiles')} — nothing to do`)
    return 0
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z')
  let repairedTotal = 0
  let failedTotal = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const { repairs, accepted, intact, unclear } = scan(text)
    for (const entry of unclear) log(`SKIP ${file}: unrecognised resolution (${entry}) — left untouched`)
    if (repairs.length === 0) {
      log(`${file}: OK (${intact} with integrity, ${accepted} accepted by pnpm)`)
      continue
    }
    log(`${file}: ${repairs.length} tarball resolution(s) pnpm will refuse`)
    for (const repair of repairs) log(`  needs integrity: ${repair.url}`)
    if (dryRun) {
      log(`  --dry-run: not downloading, not writing`)
      continue
    }
    const hashes = new Map()
    for (const repair of repairs) {
      if (hashes.has(repair.url)) continue
      try {
        const { integrity, bytes } = await hashUrl(repair.url, timeoutMs)
        hashes.set(repair.url, integrity)
        log(`  downloaded ${bytes} byte(s) → ${integrity}`)
      } catch (error) {
        failedTotal += 1
        log(`  FAILED to download ${repair.url}: ${error instanceof Error ? error.message : String(error)}`)
        log(`  the entry is left as it is; repair it by hand once the network is reachable`)
      }
    }
    const patched = repairText(text, hashes)
    if (patched === text) continue
    const backupDir = join(home, `.lockfile-repair-${stamp}`)
    try {
      mkdirSync(backupDir, { recursive: true, mode: 0o700 })
      copyFileSync(file, join(backupDir, `${file.split('/').slice(-2).join('-')}`))
    } catch (error) {
      log(`  WARNING: could not write the backup (${error instanceof Error ? error.message : String(error)}) — refusing to change the lockfile`)
      failedTotal += 1
      continue
    }
    writeFileSync(file, patched)
    const applied = repairs.filter((repair) => hashes.has(repair.url)).length
    repairedTotal += applied
    log(`  wrote ${applied} integrity value(s); backup in ${backupDir}`)
    log(`  note: pnpm may re-resolve once and drop them again on the FIRST install after a failed run — the next boot re-applies it`)
  }
  if (repairedTotal > 0) log(`done: ${repairedTotal} lockfile entr(ies) repaired`)
  if (failedTotal > 0) log(`done: ${failedTotal} entr(ies) could not be repaired`)
  return failedTotal > 0 ? 1 : 0
}

function selfTest() {
  const cases = [
    {
      name: 'github release asset needs an integrity',
      text: 'packages:\n\n  pkg@https://github.com/o/r/releases/download/v1/p.tgz:\n    resolution: {tarball: https://github.com/o/r/releases/download/v1/p.tgz}\n    version: 1.0.0\n',
      repairs: 1,
      accepted: 0
    },
    {
      name: 'codeload tar.gz is accepted as-is',
      text: '  pkg@github:o/r:\n    resolution: {tarball: https://codeload.github.com/o/r/tar.gz/abc123}\n',
      repairs: 0,
      accepted: 1
    },
    {
      name: 'an integrity in either key order is left alone',
      text: '  a@pkg:\n    resolution: {integrity: sha512-AAA, tarball: https://github.com/o/r/releases/download/v1/a.tgz}\n  b@pkg:\n    resolution: {tarball: https://github.com/o/r/releases/download/v1/b.tgz, integrity: sha512-BBB}\n',
      repairs: 0,
      accepted: 0
    },
    {
      name: 'file: and gitHosted resolutions are accepted',
      text: '  a@file:../a.tgz:\n    resolution: {tarball: file:../a.tgz}\n  b@pkg:\n    resolution: {tarball: https://example.com/b.tgz}\n    gitHosted: true\n',
      repairs: 0,
      accepted: 2
    },
    {
      name: 'a registry resolution is not touched',
      text: '  zod@3.25.0:\n    resolution: {integrity: sha512-CCC}\n',
      repairs: 0,
      accepted: 0
    },
    {
      name: 'a resolution carrying other keys is refused, not guessed',
      text: '  pkg@https://example.com/p.tgz:\n    resolution: {tarball: https://example.com/p.tgz, registry: https://reg/}\n',
      repairs: 0,
      accepted: 0,
      unclear: 1
    }
  ]
  let failed = 0
  for (const testCase of cases) {
    const got = scan(testCase.text)
    const ok = got.repairs.length === testCase.repairs
      && got.accepted === testCase.accepted
      && got.unclear.length === (testCase.unclear ?? 0)
    if (!ok) {
      failed += 1
      console.error(`${PREFIX} SELF-TEST FAIL: ${testCase.name} — repairs=${got.repairs.length} (want ${testCase.repairs}), accepted=${got.accepted} (want ${testCase.accepted}), unclear=${got.unclear.length}`)
      continue
    }
    console.log(`${PREFIX} self-test ok: ${testCase.name}`)
  }
  // The rewrite must produce the exact line pnpm itself writes.
  const rewritten = repairText(cases[0].text, new Map([[ 'https://github.com/o/r/releases/download/v1/p.tgz', 'sha512-AAA' ]]))
  const want = '    resolution: {integrity: sha512-AAA, tarball: https://github.com/o/r/releases/download/v1/p.tgz}'
  if (!rewritten.includes(want)) {
    failed += 1
    console.error(`${PREFIX} SELF-TEST FAIL: rewrite shape\n  got:  ${rewritten.split('\n')[3]}\n  want: ${want}`)
  } else {
    console.log(`${PREFIX} self-test ok: rewrite shape`)
  }
  if (failed > 0) {
    console.error(`${PREFIX} self-test: ${failed} check(s) failed`)
    return 1
  }
  console.log(`${PREFIX} self-test: all checks passed`)
  return 0
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) return selfTest()
  const dryRun = argv.includes('--dry-run')
  const homeArg = argv.indexOf('--home')
  const home = homeArg === -1 ? (process.env.DSH_HOME ?? '/home/node/.dsh') : argv[homeArg + 1]
  const timeoutArg = argv.indexOf('--timeout')
  const timeoutMs = timeoutArg === -1 ? 20000 : Number(argv[timeoutArg + 1])
  return run(home, { dryRun, timeoutMs })
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      log(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    })
}
