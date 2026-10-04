#!/usr/bin/env node
/**
 * build-office-payload.mjs — assemble the pinned Python payload the Office skills
 * run on, at image-build time, without installing anything from the build host.
 *
 * WHY THIS EXISTS
 * ---------------
 * `@deepseek-ai/dsh-skill-office` (the harness's own Word/PowerPoint/Excel skills)
 * deliberately does NOT ship an interpreter. Its instructions say so outright:
 * call `load_workspace_dependencies` and execute the Python path that comes back,
 * instead of discovering a system Python or installing packages. The tool behind
 * that call (`@deepseek-ai/dsh-tool-workspace-dependencies`) reads a *primary
 * runtime payload*: a directory holding `runtime.json` plus `dependencies/`, and
 * its README names the container case explicitly — copy the payload into an
 * immutable image layer and let the tool use it where it lies.
 *
 * This script produces exactly that payload from the lock file this repository
 * vendors (`docker/office-runtime.lock.json`, a copy of the upstream
 * `scripts/primary-runtime/lock.json` for the shipped DSH release with two wheels
 * added). Everything is downloaded over HTTPS and checked against a SHA-256 in the
 * lock BEFORE it is unpacked, so a rebuild cannot silently pick up a newer library,
 * and nothing is executed from the archives: this script only unpacks.
 *
 * WHAT IT WRITES
 * --------------
 *   <output>/primary-runtime/runtime.json          validated by the tool itself
 *   <output>/primary-runtime/dependencies/python/bin/python3
 *   <output>/primary-runtime/dependencies/python/lib/python3.X/site-packages/…
 *
 * The layout, the manifest fields and the `pythonPackages` distribution map are the
 * same shape upstream's `scripts/primary-runtime/prepare.ts` produces, because
 * `parsePrimaryRuntime` / `workspaceDependencyPaths` in
 * `@deepseek-ai/dsh-tool-workspace-dependencies` are what read it: the interpreter
 * must be a FILE at `dependencies/python/bin/python3`, site-packages must be a
 * DIRECTORY at `dependencies/python/lib/python<major>.<minor>/site-packages`, and
 * the manifest's platform/arch must match the running process or the tool refuses
 * the payload outright.
 *
 * ADDITIONS OVER UPSTREAM
 * -----------------------
 * Upstream's lock covers document authoring (python-docx, python-pptx, openpyxl,
 * XlsxWriter, Pillow, lxml, numpy, pandas). PDF *input* needs two more, and both are
 * in the vendored lock: `pypdf` for text and page assembly, and `PyMuPDF` for
 * embedded-image extraction, which is what makes "read the pictures inside this
 * PDF" work for a vision-capable model.
 *
 * USAGE
 * -----
 *   node tools/build-office-payload.mjs \
 *     --lock docker/office-runtime.lock.json \
 *     --target linux-x64 \
 *     --output /opt/dsh-office \
 *     [--cache /tmp/office-payload-cache] \
 *     [--version <string recorded as desktopVersion>]
 *
 * Requires `tar` and `unzip` on PATH (both are in the image) and network access to
 * the pinned URLs. It deliberately uses those two system tools rather than an npm
 * archive library, so this step works in either release channel — the npm channel
 * image has no repository checkout to resolve dependencies from.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** Identity of the assembly rules, bumped when the payload's bytes would change. */
const FORMAT = 'dsh-office-payload-1'

function fail(message) {
  console.error(`build-office-payload: ${message}`)
  process.exit(1)
}

/**
 * Download an asset once, keyed by its expected digest, and verify every byte.
 *
 * The cache is keyed by SHA-256 rather than by URL, so a re-run (or a second target)
 * that needs the same archive reads it from disk, and a cached file that does not
 * match the lock is a hard failure — never a silent fallback to the network.
 */
async function fetchVerified(url, sha256, cache) {
  const destination = join(cache, sha256)
  let bytes
  try {
    bytes = readFileSync(destination)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const response = await fetch(url)
    if (!response.ok) throw new Error(`download ${String(response.status)} for ${url}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== sha256) throw new Error(`checksum mismatch for ${url}\n  expected ${sha256}\n  actual   ${actual}`)
  if (!existsSync(destination)) writeFileSync(destination, bytes)
  return destination
}

/**
 * Reject a wheel this payload cannot represent.
 *
 * A wheel may install outside site-packages only through its `<name>.data/<scheme>/`
 * directory. Upstream refuses every scheme but `scripts` (entry-point wrappers we
 * neither need nor can relocate); we make the same refusal, but by LISTING the
 * archive first so the failure happens before anything is unpacked.
 */
function assertWheelIsPlain(archive) {
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).split('\n')
  const unsupported = entries.filter((entry) => /^[^/]+\.data\/(?!scripts\/)/u.test(entry))
  if (unsupported.length > 0) throw new Error(`${archive} needs unsupported installation paths, e.g. ${unsupported[0]}`)
}

/** The payload's identity: the locked inputs, not the environment that assembled them. */
function payloadDigest(target, lock, wheels) {
  return createHash('sha256').update(JSON.stringify({
    format: FORMAT,
    target,
    pythonVersion: lock.pythonVersion,
    pythonRelease: lock.pythonRelease,
    pythonPackages: lock.pythonPackages,
    wheels,
  })).digest('hex')
}

/** Every wheel this target installs: its own compiled ones first, then the shared pure-Python set. */
function wheelsFor(target, lock) {
  return [...lock.targets[target].wheels, ...lock.wheels]
}

async function main() {
  const { values } = parseArgs({
    options: {
      lock: { type: 'string' },
      target: { type: 'string' },
      output: { type: 'string' },
      cache: { type: 'string' },
      version: { type: 'string' },
    },
  })
  const lockPath = values.lock ?? 'docker/office-runtime.lock.json'
  const target = values.target ?? 'linux-x64'
  const output = values.output
  if (output === undefined || output === '') fail('--output <directory> is required (the payload root, e.g. /opt/dsh-office)')

  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  if (!Object.hasOwn(lock.targets ?? {}, target)) fail(`unknown target "${target}" — the lock has ${Object.keys(lock.targets ?? {}).join(', ')}`)
  const artifact = lock.targets[target]

  // The manifest has to describe THIS machine, or the tool rejects the payload at
  // activation and the Office skills never appear. Derived from the target string,
  // exactly as upstream does it.
  const platform = target.endsWith('-win-x64') || target === 'win-x64' ? 'win32' : target.startsWith('linux-') ? 'linux' : 'darwin'
  const arch = target.endsWith('-arm64') ? 'arm64' : 'x64'
  const sitePackages = join('python', 'lib', `python${lock.pythonVersion.split('.').slice(0, 2).join('.')}`, 'site-packages')

  const cache = resolve(values.cache ?? join(output, '.cache'))
  mkdirSync(cache, { recursive: true })

  const runtime = resolve(output)
  const staging = `${runtime}.staging`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(join(staging, 'dependencies'), { recursive: true })

  // 1. The interpreter. python-build-standalone's `install_only_stripped` archive
  //    already carries a top-level `python/` directory, so extracting it INTO
  //    dependencies/ lands it on exactly the path the tool expects.
  const pythonFilename = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${artifact.pythonTarget}-install_only_stripped.tar.gz`
  const pythonUrl = `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(pythonFilename)}`
  console.log(`build-office-payload: python ${lock.pythonVersion} (${artifact.pythonTarget})`)
  const pythonArchive = await fetchVerified(pythonUrl, artifact.pythonSha256, cache)
  execFileSync('tar', ['-xzf', pythonArchive, '-C', join(staging, 'dependencies')], { stdio: 'inherit' })

  const interpreter = join(staging, 'dependencies', 'python', 'bin', 'python3')
  if (!existsSync(interpreter)) fail(`the archive did not produce ${interpreter} — the lock's pythonTarget does not match this layout`)
  // A stripped standalone build ships site-packages already; create it anyway, so a
  // future archive that omits the (empty) directory cannot break the wheel step.
  mkdirSync(join(staging, 'dependencies', sitePackages), { recursive: true })

  // 2. Every library, each hash-checked before it is unpacked.
  const wheels = wheelsFor(target, lock)
  for (const wheel of wheels) {
    const name = wheel.url.split('/').pop()
    const archive = await fetchVerified(wheel.url, wheel.sha256, cache)
    assertWheelIsPlain(archive)
    execFileSync('unzip', ['-q', '-o', archive, '-d', join(staging, 'dependencies', sitePackages)], { stdio: 'inherit' })
    console.log(`  + ${name}`)
  }

  // 3. The manifest. `desktopVersion` is only an identity string for the legacy
  //    installer path; this payload is used IN PLACE (no `root:`), so what matters
  //    is platform/arch/python/pythonPackages.
  const manifest = {
    desktopVersion: values.version ?? 'dsh-office',
    platform,
    arch,
    payloadDigest: payloadDigest(target, lock, wheels),
    python: lock.pythonVersion,
    pythonPackages: lock.pythonPackages,
  }
  writeFileSync(join(staging, 'runtime.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)

  rmSync(runtime, { recursive: true, force: true })
  mkdirSync(dirname(runtime), { recursive: true })
  renameSync(staging, runtime)

  const bytes = Number(execFileSync('du', ['-sb', runtime], { encoding: 'utf8' }).split('\t')[0])
  const packages = Object.keys(lock.pythonPackages).length
  console.log(`build-office-payload: wrote ${runtime}`)
  console.log(`  platform ${platform}/${arch} · python ${lock.pythonVersion} · ${packages} distributions · ${wheels.length} wheels · ${(bytes / 1048576).toFixed(1)} MiB`)
  console.log(`  interpreter ${join(runtime, 'dependencies', 'python', 'bin', 'python3')}`)
  console.log(`  site-packages ${join(runtime, 'dependencies', sitePackages)}`)
}

await main()
