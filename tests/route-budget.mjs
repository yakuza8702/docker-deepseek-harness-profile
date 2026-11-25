#!/usr/bin/env node
/**
 * route-budget.mjs — EVERY `/cua` ROUTE HAS ITS OWN BUDGET (R4, C16–C19).
 *
 * WHAT WAS WRONG AT HEAD
 * ----------------------
 * The plugin's tools were bounded (`boundedExecute`, 60 s, an actionable
 * `tool-timeout`), but the HTTP route the PANEL uses called
 * `request(socketPath, payload)` with no budget, so it inherited the socket
 * default: THIRTY MINUTES. One wedged supervisor operation therefore turned the
 * buttons into "nothing happens" — the user waited half an hour for an answer
 * the transport was never going to send. That is R4, and it is what made R1
 * (the deadline-less lock) look like a dead panel instead of an error.
 *
 * WHAT THIS SUITE PINS
 * --------------------
 *   * the table is FROZEN and every action of the switch has an entry;
 *   * `state` ≤ 15 s, every lifecycle action is 60–70 s (tool + a 5 s lead, so
 *     the supervisor's own 30 s `lock-timeout` wins on BOTH surfaces);
 *   * NO entry equals the 30-minute tool default — the whole point of the table;
 *   * `exec` is 0 in the table and COMPUTED per call from the caller's timeout,
 *     through the same resolver the `cua_vm_exec` tool uses (one clamp, not two);
 *   * an unknown action still gets 30 s, never the socket default;
 *   * no `case` of the switch calls `call(...)` without a budget (C17) — the
 *     source-level half, comments stripped so a commented-out `call(payload)`
 *     cannot satisfy it;
 *   * a socket timeout maps to 504 `route-timeout` with C18's sentence, and a
 *     plain refusal keeps its 503.
 *
 * 14 checks, no supervisor and no socket: this is a contract test on the table
 * and on the dispatch text. The behavioural half (a real wedged supervisor
 * answering 504) lives in `tests/watcher-wedge.mjs` and `tests/lock-deadline.mjs`,
 * where there is a supervisor to wedge.
 *
 * Run: node tests/route-budget.mjs
 */
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = process.env.REPO || path.resolve(import.meta.dirname, '..')
const INDEX = path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js')

// `@deepseek-ai/schemastery` lives in the DSH checkout, not in this repo; the
// repo's other suites map it to the fixture, and so does this one.
const SCHEMASTERY = [
  process.env.DSH_SCHEMASTERY_PATH,
  '/opt/dsh-src/node_modules/@deepseek-ai/schemastery/lib/index.mjs',
  path.join(REPO, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  .find((candidate) => existsSync(candidate)) ?? null
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/schemastery') {
      return {
        url: SCHEMASTERY === null
          ? new URL('./fixtures/schemastery-stub.mjs', import.meta.url).href
          : pathToFileURL(SCHEMASTERY).href,
        shortCircuit: true
      }
    }
    return nextResolve(specifier, context)
  }
})

let failures = 0
let checks = 0
const check = (label, ok, detail = '') => {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** JS comments removed, strings honoured — a commented-out line cannot pin. */
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

const plugin = await import(pathToFileURL(INDEX).href)
const { ROUTE_TIMEOUTS, ROUTE_TIMEOUT_FALLBACK_MS, routeTimeoutMs } = plugin
const source = stripJsComments(readFileSync(INDEX, 'utf8'))

/** THE DOC'S ACTION LIST (SOL §1.5 / WP-B B-1): every case of the `/cua` switch. */
const DOC_ACTIONS = [
  // 2026-11: `provision` is the panel's Retry install route (and the async
  // re-provision queue); it is documented because an action missing here is an
  // action nobody notices losing its budget.
  'state', 'config', 'create', 'provision', 'start', 'shutdown', 'suspend', 'gc', 'doctor', 'space',
  'windowsStatus', 'windowsPassword', 'windowsClipboardSet', 'windowsClipboardGet', 'windowsFreeSpace',
  'stop', 'delete', 'exec', 'metrics', 'view', 'screenshot', 'input', 'gui', 'pointer'
]
const LIFECYCLE = ['start', 'shutdown', 'suspend', 'stop', 'delete']
/** The socket default a route must NEVER inherit (30 min). */
const TOOL_TIMEOUT_MS = 1_800_000

// ---- 1. the table is frozen ------------------------------------------------
check('ROUTE_TIMEOUTS is a FROZEN object — a route budget is a constant, not a variable a later import can move',
  ROUTE_TIMEOUTS !== null && typeof ROUTE_TIMEOUTS === 'object' && Object.isFrozen(ROUTE_TIMEOUTS) === true,
  `frozen=${Object.isFrozen(ROUTE_TIMEOUTS)} keys=${Object.keys(ROUTE_TIMEOUTS ?? {}).length}`)

// ---- 2. the switch and the table name the same actions ---------------------
const switchStart = source.indexOf('switch (action) {')
const switchEnd = source.indexOf("default: return send(404", switchStart)
const switchText = switchStart === -1 || switchEnd === -1 ? '' : source.slice(switchStart, switchEnd)
const caseNames = [...switchText.matchAll(/case '([^']+)':/gu)].map((match) => match[1])
const missingEntries = caseNames.filter((name) => Object.hasOwn(ROUTE_TIMEOUTS ?? {}, name) === false)
const docDrift = DOC_ACTIONS.filter((name) => caseNames.includes(name) === false)
check('EVERY action of the `/cua` switch has a ROUTE_TIMEOUTS entry, and the switch still carries exactly the documented set',
  switchText !== '' && caseNames.length > 0 && missingEntries.length === 0 && docDrift.length === 0,
  `${caseNames.length} case(s); without an entry: ${missingEntries.join(',') || 'none'}; documented but absent: ${docDrift.join(',') || 'none'}`)

// ---- 3. state ≤ 15 s -------------------------------------------------------
check("routeTimeoutMs('state') ≤ 15 000 — the page's beat is a round trip, not a wait",
  routeTimeoutMs('state') <= 15_000 && ROUTE_TIMEOUTS.state === 15_000,
  `state=${routeTimeoutMs('state')}`)

// ---- 4. lifecycle 60–70 s --------------------------------------------------
const outOfWindow = LIFECYCLE.filter((action) => {
  const budget = ROUTE_TIMEOUTS[action]
  return typeof budget !== 'number' || budget < 60_000 || budget > 70_000
})
check('every lifecycle entry is inside [60 000, 70 000] — the tool budget plus a 5 s lead, so the lock-timeout wins on both surfaces',
  outOfWindow.length === 0,
  LIFECYCLE.map((action) => `${action}=${ROUTE_TIMEOUTS[action]}`).join(' ') || `offenders=${outOfWindow.join(',')}`)

// ---- 5. no entry is the 30-minute socket default ---------------------------
const atToolDefault = Object.entries(ROUTE_TIMEOUTS ?? {}).filter(([, value]) => value === TOOL_TIMEOUT_MS).map(([key]) => key)
check('NO entry equals TOOL_TIMEOUT_MS (the 30-minute socket default) — inheriting it IS defect R4',
  atToolDefault.length === 0,
  `equal=${atToolDefault.join(',') || 'none'}`)

// ---- 6. exec is 0 in the table (computed per call) -------------------------
check("ROUTE_TIMEOUTS.exec === 0 — 'exec' is the ONE argument-dependent route and may not be a constant",
  ROUTE_TIMEOUTS.exec === 0,
  `exec=${ROUTE_TIMEOUTS.exec}`)

// ---- 7. exec resolves to the caller's timeout + the envelope grace ---------
const execDefault = routeTimeoutMs('exec')
const execSixty = routeTimeoutMs('exec', { timeout: 60 })
check("'exec' resolves through the tool's own resolver: default 300 s → 360 000 and a 60 s command → 120 000",
  execDefault === 360_000 && execSixty === 120_000,
  `default=${execDefault} 60s=${execSixty}`)

// ---- 8. exec clamps, and it is the same clamp the tool declares ------------
check("'exec' applies the documented clamp (1 s floor, 3600 s ceiling) — a route and its tool can never disagree about a legal long exec",
  routeTimeoutMs('exec', { timeout: 3600 }) === 3_660_000
  && routeTimeoutMs('exec', { timeout: 99_999 }) === 3_660_000
  && routeTimeoutMs('exec', { timeout: 1 }) === 61_000
  // ...and the resolver is the TOOL's own, not a second copy of the arithmetic.
  && source.includes('cua_vm_exec: (args) => (Math.min(3600, Math.max(1, Number(args?.timeout) || 300)) * 1000) + EXEC_ENVELOPE_GRACE_MS')
  && source.includes('if (action === \'exec\') return PER_CALL_TIMEOUTS.cua_vm_exec(body)'),
  `3600=${routeTimeoutMs('exec', { timeout: 3600 })} clamp=${routeTimeoutMs('exec', { timeout: 99_999 })} 1s=${routeTimeoutMs('exec', { timeout: 1 })}`)

// ---- 9. an unknown action still gets a bounded answer ----------------------
check('an action the table has never heard of falls back to 30 000 — never the socket default',
  routeTimeoutMs('not-a-route') === 30_000 && ROUTE_TIMEOUT_FALLBACK_MS === 30_000,
  `unknown=${routeTimeoutMs('not-a-route')} fallback=${ROUTE_TIMEOUT_FALLBACK_MS}`)

// ---- 10. start is exactly 65 s --------------------------------------------
check("routeTimeoutMs('start') === 65 000", routeTimeoutMs('start') === 65_000, `start=${routeTimeoutMs('start')}`)

// ---- 11. every value is a finite, sane number, and exec is the only zero ---
const badValues = Object.entries(ROUTE_TIMEOUTS ?? {}).filter(([, value]) => typeof value !== 'number' || Number.isFinite(value) === false || value < 0)
const zeros = Object.entries(ROUTE_TIMEOUTS ?? {}).filter(([, value]) => value === 0).map(([key]) => key)
check("every entry is a finite, non-negative number and 'exec' is the ONLY 0 (a second 0 would be a silent fallback)",
  badValues.length === 0 && zeros.length === 1 && zeros[0] === 'exec',
  `bad=${badValues.map(([key]) => key).join(',') || 'none'} zeros=${zeros.join(',') || 'none'}`)

// ---- 12. every case passes a budget (C17), comments stripped --------------
const caseSlices = caseNames.map((name) => {
  const at = switchText.indexOf(`case '${name}':`)
  const next = switchText.slice(at + 1).search(/\n\s+(case '|default:)/u)
  return { name, slice: next === -1 ? switchText.slice(at) : switchText.slice(at, at + 1 + next) }
})
const casesWithoutBudget = caseSlices.filter((entry) => entry.slice.includes('routeTimeoutMs(') === false).map((entry) => entry.name)
const bareCalls = [...switchText.matchAll(/call\(\{[^;]*?\}\)/gu)]
  .filter((match) => match[0].includes('routeTimeoutMs(') === false)
check('EVERY case passes its own budget (`routeTimeoutMs(...)`) — no bare one-argument `call(payload)` survives anywhere in the switch',
  casesWithoutBudget.length === 0 && bareCalls.length === 0,
  `cases without a budget: ${casesWithoutBudget.join(',') || 'none'}; bare calls: ${bareCalls.map((match) => match[0].slice(0, 48)).join(' | ') || 'none'}`)

// ---- 13. the socket timeout carries its own type --------------------------
// D3: the negative leg used to look for `error: `the supervisor did not answer
// ${timeoutMs} ms`` — a string that never existed anywhere in the tree, so the
// leg could not fail. The honest pair is (a) `request` still carries its HEAD
// message verbatim, and (b) the ROUTE's C18 sentence is NOT pushed down into
// it: the transport fact and the route fact must stay distinguishable, which is
// the only thing this check ever claimed. Both legs can fail.
const requestAt = source.indexOf('function request(')
const requestBody = requestAt === -1
  ? ''
  : source.slice(requestAt, requestAt + source.slice(requestAt).indexOf('\n}\n'))
const keepsHeadMessage = requestBody.includes('cua-vm supervisor did not answer within ${timeoutMs} ms')
const routeSentenceInRequest = requestBody.includes('route-timeout') || requestBody.includes('the panel stopped waiting')
check("`request` tags its own timeout with code:'socket-timeout' and keeps its HEAD message — the ONE place that says the supervisor never answered, with the route's C18 sentence kept OUT of it",
  source.includes('error.code = \'socket-timeout\'')
  && /if \(error\?\.code === 'socket-timeout'\)/u.test(source)
  && requestBody !== ''
  && keepsHeadMessage
  && routeSentenceInRequest === false,
  `tag=${source.includes("error.code = 'socket-timeout'")} branch=${/if \(error\?\.code === 'socket-timeout'\)/u.test(source)} headMessage=${keepsHeadMessage} routeSentenceInRequest=${routeSentenceInRequest}`)

// ---- 14. 504 route-timeout vs 503 (C18) -----------------------------------
const sentenceAt = source.indexOf('the panel stopped waiting, the computer did not stop working')
const responded = /send\(504, \{/u.test(source) && source.includes("code: 'route-timeout'")
check('a socket timeout is answered 504 `route-timeout` with C18\'s sentence; every other failure keeps the 503',
  sentenceAt !== -1 && responded
  && /the supervisor did not answer \$\{action\} within \$\{waitedSeconds\} s/u.test(source)
  && /return send\(503, \{ ok: false, error: String\(error\?\.message \?\? error\) \}\)/u.test(source),
  `sentence=${sentenceAt !== -1} 504=${/send\(504, \{/u.test(source)} 503=${/send\(503, /u.test(source)}`)

if (checks !== 14) {
  console.error(`harness: expected exactly 14 checks, ran ${checks} — the suite's own count is part of its contract`)
}
console.log(failures === 0 && checks === 14 ? `route: PASS (${checks} checks)` : `route: FAIL (${failures}/${checks})`)
process.exit(failures === 0 && checks === 14 ? 0 : 1)
