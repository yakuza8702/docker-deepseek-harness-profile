#!/usr/bin/env node
/**
 * probe-anchors.mjs — tell me whether the build-time patches still fit upstream,
 * WITHOUT building an image and WITHOUT touching this repository.
 *
 * Downloads the plugin-manager client bundle for a given version (default: the
 * `next` dist-tag, i.e. what a fresh `latest` build would install), then asks the
 * same anchor questions tools/patch-plugin-manager-page.mjs asks — but answers
 * them as a report instead of exiting 1.
 *
 * Exit 0 = every anchor resolves; the next build will patch cleanly.
 * Exit 1 = at least one anchor moved; read the report, re-anchor, then build.
 *
 * Usage:
 *   node tools/probe-anchors.mjs                 # dist-tag `next`
 *   node tools/probe-anchors.mjs --version 0.2.2-alpha.2
 *   node tools/probe-anchors.mjs --json
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const PACKAGE = '@deepseek-ai/dsh-client-ui-plugin-manager'
const SIDEBAR_PACKAGE = '@deepseek-ai/dsh-client-ui-sidebar'

// ── the anchors, mirrored from tools/patch-plugin-manager-page.mjs ────────────
const ANCHOR_SLOT_DECL = /([ \t]*)"plugins\.item": \{\s*\n\s*kind: "list",\s*\n\s*scope: "root"\s*\n\s*\},/u
const ANCHOR_RENDER_VARIANTS = [
  { since: '0.2.1-alpha.2+', anchor: 'renderGroup("basic", t("basicTitle"), basicCards)' },
  { since: '<= 0.2.1-alpha.1', anchor: 'renderGroup("official", t("officialTitle"), officialCards)' },
]
const ANCHOR_LIST_FILTERS = [
  { kind: 'has', re: /\.filter\(\s*\(?(\w+)\)?\s*=>\s*!(\w+)\.has\(\1\.name\)/u },
  { kind: 'includes', re: /\.filter\(\s*\(?(\w+)\)?\s*=>\s*!(\w+)\.includes\(\1\.name\)/u },
]

const SIDEBAR_SLOT_DECL = /([ \t]*)"sidebar\.footer\.action": \{\s*\n\s*kind: "list",\s*\n\s*scope: "root"\s*\n\s*\},?/u
const SIDEBAR_RENDER = 'renderSlot("sidebar.settings", { wide })'

const count = (text, needle) => text.split(needle).length - 1

function resolveVersion(explicit) {
  if (explicit !== undefined) return explicit
  const tags = JSON.parse(execFileSync('npm', ['view', PACKAGE, 'dist-tags', '--json'], { encoding: 'utf8' }))
  return tags.next ?? tags.latest
}

function fetchBundle(pkg, version, work) {
  const tarball = execFileSync('npm', ['pack', `${pkg}@${version}`, '--silent'], { cwd: work, encoding: 'utf8' }).trim().split('\n').pop()
  execFileSync('tar', ['xzf', join(work, tarball), '-C', work, '--strip-components=1'])
  return readFileSync(join(work, 'lib', 'client.js'), 'utf8')
}

function probe(source) {
  const checks = []

  const declCount = (source.match(new RegExp(ANCHOR_SLOT_DECL.source, 'gu')) ?? []).length
  checks.push({
    anchor: 'slot declaration "plugins.item"',
    found: declCount,
    ok: declCount === 1,
    hint: declCount === 1 ? 'declares the child slot the top section clones' : 'expected exactly one "plugins.item" list-slot declaration',
  })

  const variants = ANCHOR_RENDER_VARIANTS.map((v) => ({ ...v, found: count(source, v.anchor) }))
  const renderHit = variants.find((v) => v.found === 1)
  checks.push({
    anchor: 'render site (group before the main list)',
    found: renderHit === undefined ? 0 : 1,
    ok: renderHit !== undefined,
    detail: variants.map((v) => `${v.since}: ${v.found}x`).join(', '),
    hint: renderHit === undefined
      ? 'no renderGroup(...) variant appears exactly once — the page restructured its groups'
      : `matched the ${renderHit.since} shape`,
  })

  // The exclusion idiom is an ALTERNATIVE set, not a conjunction: one of these has to
  // resolve uniquely. That is what lets a Set->array refactor pass without a change.
  const filterHits = ANCHOR_LIST_FILTERS.map((f) => {
    const all = [...source.matchAll(new RegExp(f.re.source, 'gu'))]
    return { ...f, all }
  })
  const filterHit = filterHits.find((f) => f.all.length === 1)
  checks.push({
    anchor: 'list filter (exclusion idiom)',
    found: filterHit === undefined ? 0 : 1,
    ok: filterHit !== undefined,
    detail: filterHit === undefined
      ? filterHits.map((f) => `${f.kind}: ${f.all.length}x`).join(', ')
      : `excludes by !${filterHit.all[0][2]}.${filterHit.kind}(${filterHit.all[0][1]}.name)`,
    hint: filterHits.some((f) => f.all.length > 1)
      ? 'more than one candidate match — cannot tell which filter is the bundle list'
      : 'no `.filter(p => !X.has(p.name))` or `.filter(p => !X.includes(p.name))` — the exclusion idiom changed',
  })

  return checks
}

function probeSidebar(source) {
  const declCount = (source.match(new RegExp(SIDEBAR_SLOT_DECL.source, 'gu')) ?? []).length
  const renderCount = count(source, SIDEBAR_RENDER)
  return [
    {
      anchor: 'sidebar slot declaration "sidebar.footer.action"',
      found: declCount,
      ok: declCount === 1,
      hint: 'expected exactly one list-slot declaration for the footer action',
    },
    {
      anchor: 'sidebar render site (sidebar.settings wide)',
      found: renderCount,
      ok: renderCount === 1,
      hint: 'no \`renderSlot("sidebar.settings", { wide })\` — the sidebar footer slot moved',
    },
  ]
}

const { values } = parseArgs({ options: {
  version: { type: 'string' },
  'from-file': { type: 'string' },
  'sidebar-from-file': { type: 'string' },
  'skip-sidebar': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} })

if (values.help) {
  console.log('usage: node tools/probe-anchors.mjs [--version <semver>] [--from-file <client.js>]')
  console.log('                                   [--sidebar-from-file <client.js>] [--skip-sidebar] [--json]')
  process.exit(0)
}

let version = resolveVersion(values.version)
let checks = []
if (values['from-file'] !== undefined) {
  // Offline / CI-fixture mode: probe a bundle you already have on disk.
  version = `file:${values['from-file']}`
  checks = probe(readFileSync(values['from-file'], 'utf8'))
} else {
  const work = mkdtempSync(join(tmpdir(), 'probe-anchors-'))
  try {
    checks = probe(fetchBundle(PACKAGE, version, work))
    if (values['skip-sidebar'] !== true) {
      const sideWork = mkdtempSync(join(tmpdir(), 'probe-anchors-sidebar-'))
      try { checks = checks.concat(probeSidebar(fetchBundle(SIDEBAR_PACKAGE, version, sideWork))) }
      finally { rmSync(sideWork, { recursive: true, force: true }) }
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const failures = checks.filter((c) => !c.ok)

if (values.json) {
  console.log(JSON.stringify({ package: PACKAGE, version, ok: failures.length === 0, checks }, null, 2))
} else {
  console.log(`probe-anchors: ${PACKAGE}@${version}\n`)
  for (const c of checks) {
    const mark = c.ok ? 'ok  ' : 'FAIL'
    const detail = c.detail === undefined ? '' : ` — ${c.detail}`
    console.log(`  ${mark}  ${c.anchor}${detail}`)
    if (!c.ok) console.log(`        ${c.hint}`)
  }
  console.log('')
  if (failures.length === 0) {
    console.log('probe-anchors: every anchor resolves — the next build will patch cleanly.')
  } else {
    console.log(`probe-anchors: ${failures.length} anchor(s) moved. Re-anchor tools/patch-plugin-manager-page.mjs`)
    console.log('              BEFORE building; a build would now fail at that step with the same message.')
  }
}
process.exit(failures.length === 0 ? 0 : 1)
