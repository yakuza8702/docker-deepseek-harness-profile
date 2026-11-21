#!/usr/bin/env node
/**
 * exec-budget.mjs — THE CLIENT'S `exec` BUDGET IS PER CALL (D1, C19).
 *
 * WHAT WAS WRONG AT HEAD
 * ----------------------
 * `CLIENT_TIMEOUTS.exec` was a FROZEN `180_000` — exactly
 * `routeTimeoutMs('exec', { timeout: 120 })` (120 s + 60 s grace), i.e. the
 * panel's own AbortSignal fired at the same instant the route's 504 was due, so
 * C18's sentence ("the supervisor did not answer exec within 180 s …") never
 * rendered; and ANY exec whose body asked for more than 120 s was cut at 180 s
 * while the route allows up to 3 660 s. One number, two lies.
 *
 * WHAT THIS SUITE PINS
 * --------------------
 *   * `CLIENT_TIMEOUTS.exec === 0` — "ask the resolver", exactly like the
 *     route's own table;
 *   * the client budget for a body is `routeTimeoutMs('exec', body) + 5 000`
 *     for 60 s, 120 s, 300 s (the default) and 3 600 s (the clamp ceiling);
 *   * therefore the frozen 180 000 is GONE: the 60 s case must be 125 000, and
 *     a 3 600 s command must be allowed 3 665 000;
 *   * the client's copy of the clamp agrees with the tool's resolver at the
 *     edges (1 s floor, 3 600 s ceiling, junk → 300 s).
 *
 * It loads the REAL client bundle through a `__ModuleLoader__` shim (the same
 * way the host does) and the real `routeTimeoutMs` from `index.js`, so the two
 * halves cannot drift without this suite going red.
 *
 * Run: node tests/exec-budget.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const REPO = process.env.REPO || path.resolve(import.meta.dirname, '..')
const CLIENT = path.join(REPO, 'plugins', 'dsh-cua-vm', 'client.js')
const INDEX = path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js')

// `@deepseek-ai/schemastery` lives in the DSH checkout, not in this repo.
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

/**
 * The client bundle's own wrapper: `window.__ModuleLoader__.load({ factory })`.
 * A minimal React is enough — the module only BUILDS components at load time,
 * and the helpers this suite reads are plain functions.
 */
function loadClientBundle(file) {
  let spec = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { spec = value } } },
    console, Date, Math, JSON, Number, String, Object, Array, Promise, Map, Set, Error,
    RegExp, Intl, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortSignal: { timeout: () => ({}) },
    fetch: async () => { throw new Error('the bundle must not fetch at load time') }
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  if (spec === null) throw new Error('client.js did not call window.__ModuleLoader__.load')
  const React = {
    createElement: () => null,
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value })
  }
  return spec.factory((id) => (id === 'react' ? React : {}))
}

const client = loadClientBundle(CLIENT)
const test = client?.__test ?? {}
const plugin = await import(pathToFileURL(INDEX).href)
const routeTimeoutMs = plugin.routeTimeoutMs
if (typeof routeTimeoutMs !== 'function') throw new Error('index.js no longer exports routeTimeoutMs')

// ---- 1. the table entry is the resolver marker, not a number --------------
check("CLIENT_TIMEOUTS.exec === 0 — 'exec' asks the resolver, exactly like ROUTE_TIMEOUTS.exec",
  test.CLIENT_TIMEOUTS?.exec === 0,
  `exec=${test.CLIENT_TIMEOUTS?.exec}`)

// ---- 2. the per-call arithmetic agrees with the route for every budget -----
const CASES = [60, 120, 300, 3600]
const rows = CASES.map((timeout) => {
  const body = { timeout }
  return {
    timeout,
    route: routeTimeoutMs('exec', body),
    client: test.clientBudget('exec', body)
  }
})
const drifted = rows.filter((row) => row.client !== row.route + 5_000)
check("the client budget for an exec body is `routeTimeoutMs('exec', body) + 5 000` — 60/120/300/3600 s",
  rows.length === CASES.length && drifted.length === 0,
  rows.map((row) => `${row.timeout}s route=${row.route} client=${row.client}`).join(' · '))

// ---- 3. the frozen 180 000 is gone, and a long exec is no longer cut ------
const sixty = test.clientBudget('exec', { timeout: 60 })
const twelve = test.clientBudget('exec', { timeout: 120 })
const long = test.clientBudget('exec', { timeout: 3600 })
check('the frozen 180_000 is gone: 60 s → 125 000, 120 s → 185 000 (route 504 wins by 5 s), 3600 s → 3 665 000',
  sixty === 125_000 && twelve === 185_000 && long === 3_665_000,
  `60=${sixty} 120=${twelve} 3600=${long}`)

// ---- 4. the client copy of the clamp agrees with the tool at the edges ----
const floor = test.clientBudget('exec', { timeout: 1 })
const junk = test.clientBudget('exec', { timeout: 'not-a-number' })
const omitted = test.clientBudget('exec', {})
check("the client clamp matches the tool's: 1 s floor → 66 000, junk/omitted → 300 s default → 365 000",
  floor === 66_000 && junk === 365_000 && omitted === 365_000
  && floor === routeTimeoutMs('exec', { timeout: 1 }) + 5_000
  && junk === routeTimeoutMs('exec', { timeout: 'not-a-number' }) + 5_000,
  `floor=${floor} junk=${junk} omitted=${omitted}`)

// ---- 5. every other action keeps its route + 5 s entry --------------------
const others = ['state', 'start', 'create', 'gui']
const wrongOthers = others.filter((action) => test.clientBudget(action) !== routeTimeoutMs(action) + 5_000)
check('a non-exec action is unchanged: the client table is still the route table plus 5 s',
  wrongOthers.length === 0,
  others.map((action) => `${action}=${test.clientBudget(action)}/${routeTimeoutMs(action) + 5_000}`).join(' '))

console.log(`exec-budget: ${failures === 0 ? 'PASS' : 'FAIL'} (${checks} checks, ${failures} failing)`)
process.exit(failures === 0 ? 0 : 1)
