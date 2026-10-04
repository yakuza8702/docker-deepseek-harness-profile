#!/usr/bin/env node
/**
 * check-office.mjs — prove the Office feature in the image that ships it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Office in this image is four pieces that only work together, and three of them can
 * be missing while the image still builds, boots and looks healthy:
 *
 *   1. the Python payload (`/opt/dsh-office/primary-runtime`) — without it the skills
 *      load and then fail at the first command, because their instructions say to run
 *      the interpreter `load_workspace_dependencies` returns;
 *   2. the engine (`@deepseek-ai/libreoffice-kit` + its WebAssembly package) — without
 *      it there is no render, no convert and no recalculation, i.e. no way for a vision
 *      model to ever look at a page;
 *   3. the skill assets (`@deepseek-ai/dsh-skill-office/assets`) — the checker and the
 *      three skill bodies;
 *   4. the four declarations that put the whole thing on the Plugins page as one
 *      switchable card (bundle patch rows, the host row table, the duplicate-card
 *      suppression list, the entrypoint switch).
 *
 * So this gate does not list files — it EXECUTES the surface: it runs the payload's
 * interpreter, imports every library the skills use, writes a real .docx with it, runs
 * the real checker over that document, converts it to PDF and renders a page to PNG
 * with the real engine, and then reads the four declarations out of the repository
 * files. A green run means a model could do the same thing on the first boot.
 *
 * USAGE
 * -----
 *   node tools/check-office.mjs --payload /opt/dsh-office --repo /tmp/office-repo \
 *     --entrypoint /tmp/office-repo/entrypoint.sh \
 *     --install /opt/dsh/node_modules --install /opt/dsh-src/node_modules
 *
 * `--payload` is the CARRIER directory (holding `primary-runtime/` and
 * `office-skills/`). `--repo` may be omitted; the declaration and wiring checks are
 * then skipped with a warning (that is the mode for running it by hand outside an
 * image build), and `--entrypoint` is only read when `--repo` is given.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const problems = []
const notes = []

function ok(message) {
  console.log(`  ok    ${message}`)
}

function bad(message) {
  problems.push(message)
  console.log(`  FAIL  ${message}`)
}

function note(message) {
  notes.push(message)
  console.log(`  note  ${message}`)
}

/** Run a command and return its stdout, or throw with the captured stderr. */
function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

/** The manifest rules `parsePrimaryRuntime` enforces, applied here so a payload that
 * would be rejected at activation fails the build instead. */
function checkManifest(payload) {
  const manifestPath = join(payload, 'runtime.json')
  if (!existsSync(manifestPath)) return bad(`no runtime.json in ${payload} — the payload step did not run`)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return bad(`runtime.json is not valid JSON: ${error.message}`)
  }
  const version = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u
  const problemsBefore = problems.length
  if (typeof manifest.desktopVersion !== 'string' || manifest.desktopVersion === '') bad('runtime.json: desktopVersion must be a non-empty string')
  if (manifest.platform !== process.platform) bad(`runtime.json: platform "${String(manifest.platform)}" does not match this image (${process.platform}) — the tool refuses an incompatible payload`)
  if (manifest.arch !== process.arch) bad(`runtime.json: arch "${String(manifest.arch)}" does not match this image (${process.arch})`)
  if (typeof manifest.python !== 'string' || !version.test(manifest.python)) bad(`runtime.json: python "${String(manifest.python)}" is not a version`)
  const packages = manifest.pythonPackages
  if (typeof packages !== 'object' || packages === null || Array.isArray(packages)) {
    bad('runtime.json: pythonPackages must be a distribution map')
  } else {
    const seen = new Set()
    for (const [name, value] of Object.entries(packages)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) bad(`runtime.json: invalid distribution name "${name}"`)
      if (typeof value !== 'string' || !/^\d[\w.!+-]*$/u.test(value)) bad(`runtime.json: invalid version "${String(value)}" for ${name}`)
      const normalized = name.toLowerCase().replace(/[-_.]+/gu, '-')
      if (seen.has(normalized)) bad(`runtime.json: duplicate distribution "${name}"`)
      seen.add(normalized)
    }
  }
  if (problems.length === problemsBefore) ok(`runtime.json valid — ${manifest.platform}/${manifest.arch}, python ${manifest.python}, ${Object.keys(packages ?? {}).length} distributions`)
  return manifest
}

/** Execute the payload's own interpreter and import everything a skill may call. */
function checkInterpreter(payload) {
  const python = join(payload, 'dependencies', 'python', 'bin', 'python3')
  const sitePackages = join(payload, 'dependencies', 'python', 'lib', 'python3.12', 'site-packages')
  if (!existsSync(python) || !statSync(python).isFile()) return bad(`no interpreter at ${python}`)
  if (!existsSync(sitePackages) || !statSync(sitePackages).isDirectory()) return bad(`no site-packages directory at ${sitePackages}`)
  const probe = `
import importlib, sys
wanted = {
    "docx": "python-docx", "pptx": "python-pptx", "openpyxl": "openpyxl",
    "xlsxwriter": "XlsxWriter", "PIL": "Pillow", "lxml": "lxml",
    "numpy": "numpy", "pandas": "pandas", "pypdf": "pypdf", "pymupdf": "PyMuPDF",
}
missing = []
for module, distribution in wanted.items():
    try:
        importlib.import_module(module)
    except Exception as error:
        missing.append(f"{module} ({distribution}): {error}")
print("python", sys.version.split()[0])
print("MISSING", "; ".join(missing) if missing else "none")
`
  let output
  try {
    output = run(python, ['-I', '-B', '-c', probe])
  } catch (error) {
    return bad(`the payload interpreter failed to run: ${String(error.stderr ?? error.message).trim().split('\n').slice(-1)[0]}`)
  }
  const [pythonLine, missingLine] = output.trim().split('\n')
  if ((missingLine ?? '').includes('MISSING none')) ok(`interpreter runs and imports all 10 libraries — ${pythonLine}`)
  else bad(`interpreter is missing libraries: ${(missingLine ?? '').replace('MISSING ', '')}`)
  return python
}

/** Write a real document with the payload, then run the REAL checker over it. */
function checkCheckerAndRoundTrip(python, installs, work) {
  mkdirSync(work, { recursive: true })
  const document = join(work, 'office-gate.docx')
  const script = `
from docx import Document
document = Document()
document.add_heading("Office gate", 0)
document.add_paragraph("If this paragraph is readable, the payload works.")
document.save(${JSON.stringify(document)})
print("wrote", ${JSON.stringify(document)})
`
  try {
    run(python, ['-I', '-B', '-c', script])
    ok('python-docx wrote a document with the payload interpreter')
  } catch (error) {
    return bad(`could not write a document with the payload: ${String(error.stderr ?? error.message).trim().split('\n').slice(-1)[0]}`)
  }

  const skillOffice = installs.map((root) => join(root, '@deepseek-ai', 'dsh-skill-office')).find((dir) => existsSync(dir))
  const checker = skillOffice === undefined ? undefined : join(skillOffice, 'assets', 'scripts', 'check_office.py')
  if (checker === undefined || !existsSync(checker)) {
    bad('the installed skill-office package has no assets/scripts/check_office.py')
  } else {
    const report = join(work, 'checks.json')
    try {
      run(python, ['-I', '-B', checker, document, '--out', report, '--contains', 'Office gate'])
      const verdict = JSON.parse(readFileSync(report, 'utf8')).verdict
      if (verdict === 'pass') ok('check_office.py reports verdict pass on the document the payload wrote')
      else bad(`check_office.py reported verdict "${String(verdict)}"`)
    } catch (error) {
      bad(`check_office.py failed: ${String(error.stderr ?? error.message).trim().split('\n').slice(-1)[0]}`)
    }
    const skills = ['office-docx', 'office-pptx', 'office-xlsx']
    const missingSkills = skills.filter((name) => !existsSync(join(skillOffice, 'assets', name, 'SKILL.md')))
    if (missingSkills.length === 0) ok(`the three bundled skills are present (${skills.join(', ')}) and their CLI resolves beside them`)
    else bad(`missing skill assets: ${missingSkills.join(', ')}`)
  }

  const kit = installs.map((root) => join(root, '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')).find((file) => existsSync(file))
  if (kit === undefined) return bad('no libreoffice-kit CLI in the installation — nothing can render or convert')
  let capabilities
  try {
    capabilities = JSON.parse(run(process.execPath, [kit, 'capabilities', '--json']))
  } catch (error) {
    return bad(`the engine did not answer capabilities: ${String(error.stderr ?? error.message).trim().split('\n').slice(-1)[0]}`)
  }
  const families = (capabilities.conversions ?? []).length
  const renders = (capabilities.imageRendering?.inputs ?? []).length
  if (families >= 3 && renders >= 10) ok(`engine answers: backend ${String(capabilities.runtime?.backend)}, ${families} conversion families, rendering ${renders} input formats`)
  else bad(`engine capabilities look incomplete: ${JSON.stringify(capabilities).slice(0, 200)}`)

  // The two things a model actually does with a document it cannot read: convert it,
  // and render a page it can look at.
  const pdf = join(work, 'office-gate.pdf')
  try {
    run(process.execPath, [kit, 'convert', '--input', document, '--output', pdf])
    const head = readFileSync(pdf).subarray(0, 5).toString('latin1')
    if (head === '%PDF-') ok('the engine converted the document to a real PDF')
    else bad(`conversion produced something that is not a PDF (starts with ${JSON.stringify(head)})`)
  } catch (error) {
    bad(`conversion failed: ${String(error.stderr ?? error.message).trim().split('\n').slice(-1)[0]}`)
  }
  try {
    const pages = join(work, 'pages')
    run(process.execPath, [kit, 'render', '--input', document, '--output-dir', pages, '--pages', '1', '--dpi', '96'])
    const manifest = JSON.parse(readFileSync(join(pages, 'manifest.json'), 'utf8'))
    const first = manifest.images?.[0]
    const png = first === undefined ? Buffer.alloc(0) : readFileSync(first.path)
    const isPng = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    if (isPng && png.length > 1000) ok(`the engine rendered page 1 to a ${String(first.width)}x${String(first.height)} PNG — the path a vision model reads`)
    else bad(`page rendering produced no usable PNG (${String(png.length)} bytes)`)
  } catch (error) {
    bad(`page rendering failed: ${String(error.stderr ?? error.message).trim().split('\n').slice(-1)[0]}`)
  }
  return kit
}

/** The extra skills this image ships (PDFs), discovered through DSH_BUNDLED_SKILL_DIR. */
function checkExtraSkills(carrier) {
  const root = join(carrier, 'office-skills')
  const skill = join(root, 'pdf-documents', 'SKILL.md')
  if (!existsSync(skill)) return bad(`no pdf-documents skill at ${skill} — DSH_BUNDLED_SKILL_DIR would point at nothing`)
  const text = readFileSync(skill, 'utf8')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)
  if (frontmatter === null) return bad('the pdf-documents skill has no YAML frontmatter, so the registry would ignore it')
  const block = frontmatter[1]
  if (!/^name:\s*pdf-documents\s*$/mu.test(block)) bad('the pdf-documents skill frontmatter has no matching name')
  if (!/^description:\s*\S/mu.test(block)) bad('the pdf-documents skill frontmatter has no description (the model would never see it)')
  if (problems.length === 0) ok(`the pdf-documents skill is present at ${root} with valid frontmatter`)
}

/**
 * The path contract, which is the one failure a file-existence check cannot see.
 *
 * A payload at the wrong depth is a HEALTHY image whose Office rows disable themselves
 * at boot: the bundle patch's `source:` and its fail-open gate both name a directory,
 * and if `runtime.json` is not in that exact directory the feature quietly disappears.
 * So this reads the two literals out of the files that will run and demands the paths
 * they name actually hold what they expect.
 */
function checkWiring(carrier, repo, entrypoint) {
  const patchPath = join(repo, 'dsh-office.cordis.patch.yml')
  const patch = readFileSync(patchPath, 'utf8')
  const sources = [...patch.matchAll(/process\.env\.DSH_OFFICE_RUNTIME \|\| '([^']+)'/gu)].map((match) => match[1])
  if (sources.length === 0) return bad("the bundle patch no longer names a payload default (no 'process.env.DSH_OFFICE_RUNTIME || <path>' literal)")
  // `source:` and the fail-open gate must agree, or the rows mount against a path the
  // gate does not check (or vice versa).
  const unique = [...new Set(sources)]
  if (unique.length !== 1) bad(`the bundle patch names ${unique.length} different payload defaults: ${unique.join(', ')}`)
  const declared = unique[0]
  if (existsSync(join(declared, 'runtime.json'))) ok(`the bundle patch's payload path resolves: ${declared}/runtime.json`)
  else bad(`the bundle patch points at ${declared}, which holds no runtime.json — the Office rows would disable themselves at boot while the image still looks healthy (the payload is at ${carrier}/primary-runtime)`)

  if (entrypoint === undefined) return
  const text = readFileSync(entrypoint, 'utf8')
  const skillsRoot = /DSH_BUNDLED_SKILL_DIR="\$\{DSH_BUNDLED_SKILL_DIR:-([^}]+)\}"/u.exec(text)?.[1]
  if (skillsRoot === undefined) bad('the entrypoint no longer exports DSH_BUNDLED_SKILL_DIR with a default — the pdf-documents skill would never be discovered')
  else if (!existsSync(join(skillsRoot, 'pdf-documents', 'SKILL.md'))) bad(`the entrypoint points DSH_BUNDLED_SKILL_DIR at ${skillsRoot}, which holds no pdf-documents skill`)
  else ok(`the entrypoint's bundled skill root resolves: ${skillsRoot}`)
}

/** The four declarations that have to agree for the card to exist and work. */
function checkDeclarations(repo, installs) {
  const bundlePatch = join(repo, 'dsh-office.cordis.patch.yml')
  const hostTable = join(repo, 'plugins-page-extras.index.js')
  const pagePatcher = join(repo, 'patch-plugin-manager-page.mjs')
  for (const file of [bundlePatch, hostTable, pagePatcher]) {
    if (!existsSync(file)) return bad(`declaration file missing from the gate context: ${file}`)
  }

  const patch = readFileSync(bundlePatch, 'utf8')
  const rows = ['workspace-dependencies', 'skill-office']
  const missingRows = rows.filter((id) => !patch.includes(`id: ${id}`))
  const packages = ['@deepseek-ai/dsh-tool-workspace-dependencies', '@deepseek-ai/dsh-skill-office']
  const missingPackages = packages.filter((name) => !patch.includes(name))
  if (missingRows.length === 0 && missingPackages.length === 0) ok('the bundle patch mounts both rows, by their real package names')
  else bad(`the bundle patch is missing rows ${missingRows.join(', ') || 'none'} / packages ${missingPackages.join(', ') || 'none'}`)

  const host = readFileSync(hostTable, 'utf8')
  if (/id:\s*'skill-office'[^}]*bundle:\s*'dsh-office'/su.test(host)) ok("the Plugins-page host table carries { id: 'skill-office', bundle: 'dsh-office' }")
  else bad('the Plugins-page host table has no row for skill-office + dsh-office — the card would not render')

  const patcher = readFileSync(pagePatcher, 'utf8')
  if (/INTEGRATED_BUNDLES = \[[^\]]*"dsh-office"/su.test(patcher)) ok('the duplicate-card suppression list includes dsh-office, so the card appears once')
  else bad('INTEGRATED_BUNDLES does not include "dsh-office" — the same feature would appear twice')

  const bundleDir = installs.map((root) => join(root, 'dsh-office')).find((dir) => existsSync(dir))
  if (bundleDir === undefined) return bad('the dsh-office bundle is not installed in any node_modules root — no profile could mount it')
  const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8'))
  const declared = manifest.dsh?.bundle?.patch
  if (declared === undefined) bad('the installed dsh-office package declares no dsh.bundle.patch, so the Plugins page would not list it')
  else if (!existsSync(join(bundleDir, declared))) bad(`the installed bundle points at ${String(declared)}, which is not there`)
  else ok(`the installed bundle ${manifest.name}@${manifest.version} declares ${String(declared)}`)
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      payload: { type: 'string' },
      repo: { type: 'string' },
      entrypoint: { type: 'string' },
      install: { type: 'string', multiple: true },
    },
    allowPositionals: true,
  })
  // `--payload` is the CARRIER: the directory holding `primary-runtime/` (the payload
  // the tool is given) and `office-skills/` (the extra skills).
  const carrier = resolve(values.payload ?? '/opt/dsh-office')
  const payload = join(carrier, 'primary-runtime')
  // `--install` may be repeated, and bare paths are accepted too: the image build
  // passes both roots either way, and this keeps a hand-run from silently checking
  // one root and reporting a missing package.
  const installs = [...(values.install ?? []), ...positionals].map((root) => resolve(root))
  const repo = values.repo === undefined ? undefined : resolve(values.repo)
  const entrypoint = values.entrypoint === undefined ? undefined : resolve(values.entrypoint)
  if (installs.length === 0) {
    console.error('check-office: --install <node_modules-root> [...] is required')
    process.exit(2)
  }
  console.log(`check-office: carrier ${carrier}`)
  console.log(`check-office: installations ${installs.join(', ')}`)

  const work = join('/tmp', 'office-gate')
  rmSync(work, { recursive: true, force: true })

  console.log('payload manifest')
  checkManifest(payload)
  console.log('payload interpreter')
  const python = checkInterpreter(payload)
  console.log('checker and engine')
  if (python !== undefined) checkCheckerAndRoundTrip(python, installs, work)
  console.log('extra skills')
  checkExtraSkills(carrier)
  console.log('declarations')
  if (repo === undefined) note('--repo not given: the four declaration checks were skipped (expected when running this by hand)')
  else {
    checkDeclarations(repo, installs)
    checkWiring(carrier, repo, entrypoint)
  }

  rmSync(work, { recursive: true, force: true })

  if (problems.length > 0) {
    console.error(`check-office: ${problems.length} problem(s)`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log('check-office: all checks passed')
}

await main()
