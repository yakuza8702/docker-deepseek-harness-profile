#!/usr/bin/env node
/**
 * Gate the recovery page's inline JavaScript.
 *
 * WHY THIS EXISTS
 * ---------------
 * `recoveryPage()` emits the browser half as ONE big inline `<script>` inside a
 * TEMPLATE LITERAL. That makes every escape meant for the client-side JavaScript
 * string a double-escape (`\\n`, not `\n`: a single `\n` is consumed by the
 * template literal and lands in the served page as a RAW newline inside a
 * single-quoted string). One missing backslash is therefore not a cosmetic bug:
 * it is a SyntaxError in the whole inline script, so NO event listener is
 * attached and EVERY button on the recovery page silently stops working —
 * including the ones you need exactly when the harness is down.
 *
 * That regression really happened (2026-10-02, factory-reset copy). This script
 * is the gate: it renders the page from the real module and parses what a
 * browser would receive, so the class cannot ship again.
 *
 * WHAT IT CHECKS
 * --------------
 *   1. every `<script>` without `src` (JSON payloads excluded) PARSES as
 *      JavaScript — a syntax error fails the check with the offending line;
 *   2. the `<script type="application/json">` boot payload is valid JSON;
 *   3. every element the script looks up by id exists in the emitted HTML
 *      (a renamed or dropped element throws at load time and kills the script
 *      just as thoroughly as a syntax error);
 *   4. the critical controls exist and are wired to a click handler;
 *   5. the page renders in every boot state it has branches for.
 *
 * Usage: node tools/check-recovery-page.mjs [path/to/recovery.mjs]
 * Exit: 0 = ok, 1 = at least one failure.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'

const modulePath = process.argv[2] ?? new URL('../docker/recovery.mjs', import.meta.url).pathname
const recovery = await import(pathToFileURL(modulePath).href)
if (typeof recovery.recoveryPage !== 'function') {
  console.error(`[recovery-page] ERROR: ${modulePath} does not export recoveryPage()`)
  process.exit(1)
}

/** A fully-populated snapshot: the page has branches for every field. */
const snapshot = (overrides = {}) => ({
  home: '/home/node/.dsh',
  active: 'web',
  version: '0.0.0-check',
  dataDirectory: '/home/node/.dsh',
  profileDirectory: '/home/node/.dsh/profiles/web',
  safeProfile: null,
  safeModeActive: false,
  boot: { state: 'failed', reason: 'boot check', detail: 'the harness process exited', profile: 'web', at: '2026-01-01T00:00:00.000Z', logTail: 'tail' },
  profiles: [
    { name: 'web', label: null, bundleCount: 2, webCapable: true, active: true, locked: true },
    { name: 'research', label: 'Research', bundleCount: 4, webCapable: true, active: false, locked: false },
  ],
  plugins: [
    { packageName: 'dshmarket', version: '1.66.8', status: 'active', owner: 'profile' },
    { packageName: '@deepseek-ai/dsh-base', version: '0.0.0', status: 'active', owner: 'bundle' },
  ],
  checkpoints: [
    { slotId: 'slot-1', status: 'available', capturedAt: '2026-01-01T00:00:00.000Z', appVersion: '0.0.0', profile: 'web', fileCount: 4, totalBytes: 1024 },
    { slotId: 'slot-2', status: 'empty' },
  ],
  ...overrides,
})

const failures = []
const fail = (message) => { failures.push(message); console.log(`FAIL ${message}`) }

/** Every inline script the browser will execute, in document order. */
function inlineScripts(html) {
  const scripts = []
  const pattern = /<script([^>]*)>([\s\S]*?)<\/script>/giu
  let match
  while ((match = pattern.exec(html)) !== null) {
    const [, attributes, body] = match
    if (/\bsrc\s*=/iu.test(attributes)) continue
    const type = /type\s*=\s*["']?([^"'\s>]+)/iu.exec(attributes)?.[1] ?? 'text/javascript'
    scripts.push({ type, body, line: html.slice(0, match.index).split('\n').length })
  }
  return scripts
}

const states = [
  ['failed boot', snapshot()],
  ['healthy boot', snapshot({ boot: { state: 'ready', reason: null, detail: null, profile: 'web', at: '2026-01-01T00:00:00.000Z', logTail: null }, plugins: [] })],
  ['client-failed', snapshot({ boot: { state: 'client-failed', reason: 'browser half', detail: 'x', profile: 'web', at: null, logTail: null } })],
  ['safe mode', snapshot({ safeModeActive: true, boot: { state: 'ready', reason: null, detail: null, profile: 'web', at: null, logTail: null } })],
  ['single profile', snapshot({ profiles: [snapshot().profiles[0]], plugins: [] })],
]

const required = {
  restart: { what: 'restart the harness', wired: true },
  safe: { what: 'enter Safe Mode', wired: true },
  'factory-reset': { what: 'factory reset', wired: true },
  'export-report': { what: 'export diagnostics', wired: true },
  'copy-report': { what: 'copy the report', wired: true },
  'new-profile': { what: 'create a profile', wired: true },
  // Containers whose rows create their own listeners at render time.
  'profile-rows': { what: 'profile list', wired: false },
  'plugin-rows': { what: 'plugin list', wired: false },
  bootdata: { what: 'boot payload element', wired: false },
}
/** Ids the page creates at runtime, so they cannot be in the static HTML. */
const DYNAMIC_IDS = new Set(['busy-note'])

for (const [label, data] of states) {
  let html
  try {
    html = recovery.recoveryPage(data)
  } catch (error) {
    fail(`${label}: recoveryPage() threw — ${error?.message ?? error}`)
    continue
  }
  if (typeof html !== 'string' || !html.startsWith('<!doctype html>')) {
    fail(`${label}: recoveryPage() did not return a document`)
    continue
  }

  const scripts = inlineScripts(html)
  const js = scripts.filter((script) => !/json/iu.test(script.type))
  if (js.length === 0) fail(`${label}: no inline script found — the page cannot be interactive`)

  for (const script of js) {
    try {
      // Parse only: this is browser code, so it must never be executed here.
      new vm.Script(script.body, { filename: `recovery-page[${label}]` })
    } catch (error) {
      const at = Number(/(\d+)/u.exec(error?.stack?.split('\n')[1] ?? '')?.[1] ?? 0)
      const context = at > 0 ? `\n      page line ${script.line + at}: ${(script.body.split('\n')[at - 1] ?? '').trim().slice(0, 120)}` : ''
      fail(`${label}: inline script does not parse — ${error.message}${context}`)
    }
  }

  for (const script of scripts.filter((entry) => /json/iu.test(entry.type))) {
    try { JSON.parse(script.body) } catch (error) { fail(`${label}: boot payload is not valid JSON — ${error.message}`) }
  }

  for (const script of js) {
    for (const [, id] of script.body.matchAll(/getElementById\(["']([^"']+)["']\)/gu)) {
      if (DYNAMIC_IDS.has(id)) continue
      if (!new RegExp(`id=["']${id}["']`, 'u').test(html) && !failures.some((entry) => entry.includes(`#${id}`))) {
        fail(`${label}: the script looks up #${id}, which the page does not contain (it would throw and kill every handler)`)
      }
    }
  }

  if (js.length > 0) {
    const source = js.map((entry) => entry.body).join('\n')
    for (const [id, { what, wired }] of Object.entries(required)) {
      if (!new RegExp(`id=["']${id}["']`, 'u').test(html) && !DYNAMIC_IDS.has(id)) fail(`${label}: ${what} control #${id} is missing`)
      else if (wired && !new RegExp(`getElementById\\(["']${id}["']\\)[\\s\\S]{0,400}?addEventListener\\(["']click`, 'u').test(source)) {
        fail(`${label}: ${what} control #${id} has no click handler`)
      }
    }
    // The tab strip is wired by delegation over classes, not ids.
    if (!/class=["'][^"']*\btab\b/u.test(html) || !/querySelectorAll\(["']\.tab["']\)[\s\S]{0,160}?addEventListener\(["']click/u.test(source)) {
      fail(`${label}: the tab strip is not wired (the page would render but nothing would switch)`)
    }
  }
}

console.log(`\n[recovery-page] ${states.length} render(s), ${failures.length} failure(s) — ${modulePath}`)
process.exit(failures.length === 0 ? 0 : 1)
