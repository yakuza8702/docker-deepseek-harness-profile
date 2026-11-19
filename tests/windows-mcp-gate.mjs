#!/usr/bin/env node
/**
 * windows-mcp-gate.mjs — THE LEAK-PROOF SUITE for the Windows dsh-cua bridge.
 *
 * THE BUG THIS SUITE EXISTS FOR
 * -----------------------------
 * The bridge registered ~19 `mcp__windows__*` tools on the HOST-GLOBAL tool
 * registry. Its only teardown was a 5 s heartbeat inside one `apply()`, so a
 * computer deleted, stopped or never online still left 19 dead schemas in EVERY
 * session's tool list: they cost context and answered "connection refused".
 *
 * WHAT IS DRIVEN, AND WHY IT IS THE REAL CODE
 * -------------------------------------------
 * This file imports the REAL `plugins/dsh-cua-vm/index.js` — the registration
 * loop, the hand-kept `registrations` map, `teardown()`, `restrict({deny})`,
 * `tools.guard`, the `/dsh-cua-vm/cua-grant` route, the `/cua` delete route and
 * the `agent/pre-step` self-heal. Only two things are substituted:
 *
 *   * `./win-mcp.js` → `tests/fixtures/fake-win-mcp.mjs`, which re-exports the
 *     real module and replaces ONLY `createDshCuaClient` (no ssh, no guest);
 *   * `@deepseek-ai/schemastery` → a stub, because the real one lives in the DSH
 *     checkout. The Config declaration is still executed.
 *
 * THE EVENTS. Since J20-3 the plugin DOES consume the supervisor's `subscribe`
 * stream; this fake supervisor answers the op with a `ready` line and keeps the
 * socket, which is what the stream client dials. The events themselves are
 * delivered the way the plugin really learns them:
 *
 *   {"event":"vm-state","state":"powered-off"}  → the row's state changes and the
 *                                                 belt (DSH_CUA_MCP_STATE_POLL_MS)
 *                                                 observes it — the stream and the
 *                                                 poll share one teardown(), so
 *                                                 this asserts the OUTCOME, not the
 *                                                 transport;
 *   {"event":"vm-removed"}                      → the row disappears AND the
 *                                                 `/cua` delete route runs, which
 *                                                 is the immediate path and the
 *                                                 one that must kill an in-flight
 *                                                 attach ticket (J20-4).
 *
 * CHECKS
 * ------
 *   (a) 19 registrations land under `mcp__windows__*`;
 *   (b) an offline / removed computer leaves NO prefixed schema and calls EVERY
 *       disposer;
 *   (c) the 19 are DENIED to every session that may not see them: an
 *       un-revealed session carries all 19 in its deny list, the bound (and
 *       therefore auto-revealed) session carries none;
 *   (d) `tools.guard` refuses a bridged name offline with `code: vm-offline`,
 *       and ONLINE the refusal proves the grant's default: a new session starts
 *       GRANTED (`GET /dsh-cua-vm/cua-grant` answers `default: "on"`).
 *
 *       **REWRITTEN (WP-5.3, SOL §4.7).** A BOUND session is no longer
 *       `reveal-required`: binding a computer while granted REVEALS it
 *       (`revealedFor()` now honours the session id as well as the agent
 *       object), so the guard lets the call through. The veto is still
 *       reachable — an UNBOUND session that is only allowed by
 *       `implicit-single-target` is still refused with `reveal-required`, and an
 *       explicit `POST {"grant":false,"sessionId":"session-A"}` is still the code
 *       `grant-off`. The suite restores the grant because the checks after (d)
 *       need session A granted. Nothing persists — the whole grant map is
 *       in-memory and dies with the plugin;
 *   (e) the pre-step self-heal clears a leaked session (names alive, client
 *       dead) and still calls `next()` exactly once.
 *
 * WP-5.2 — THE LANE, THE REPAIR AND THE VERDICT (SOL §4.3/§4.6/§4.10, §5.2)
 * ------------------------------------------------------------------------
 * The reported defect was invisible to this suite: it could see THAT a bridge
 * was attached, never WHICH lane the attach took, so a blind bridge (healthy
 * relay, unreadable probe) passed every check. The five checks below close that
 * hole; they are driven by the fixture's lane knobs, because the lane itself is
 * decided inside `win-mcp.js`, which the fixture replaces:
 *
 *   (f) default lane ⇒ `status: ok`, `transport: interactive-relay`,
 *       `relayOk: true`, `probeMode: handshake`, and the doctor's facts are the
 *       CLIENT's facts (both agree);
 *   (g) blind lane ⇒ `status: blind`, `blindReason` from the closed set
 *       (`relay-stopped` for a DOWN probe, `probe-skew` for the P0 signature:
 *       the guest answered but the harness could not read the answer), and
 *       `windows_desktop` SAYS blind instead of pretending;
 *   (h) repair ⇒ a failing repair costs exactly ONE attempt per throttle window
 *       (never one per poll beat), and a frozen-grammar `CUA_RELAY ok=1` record
 *       flips the lane to `interactive-relay` on the next sync with
 *       `repair.ok === true` in the doctor; the kill switch
 *       (`DSH_CUA_VM_WIN_MCP_REPAIR=0`) spends no attempt at all. A MEASURED
 *       record is allowed to prove things — `session=0` ⇒ `no-interactive-session`,
 *       `hash=` ⇒ `relay-missing` — while an UNMEASURED one (`measured:false`,
 *       fields null) proves nothing and stays `relay-stopped`;
 *   (i) restore path ⇒ `vm-state powered-off` → `ready` re-attaches with a FRESH
 *       probe: the cached DOWN does not pin the lane, and the new attach lands on
 *       the lane the fixture now reports;
 *   (j) reveal + identity ⇒ `windows_desktop` returns an EMPTY inventory to a
 *       session that may not use the bridge, a session that binds + is granted
 *       is auto-revealed with no manual reveal call, and the doctor carries
 *       `pluginVersion` + `payload.relayHash`.
 *
 * WP-6.2 — ATTACHING, THE CONTRACT NOTES AND THE DESKTOP FACTS (§4.7/§4.10)
 * ------------------------------------------------------------------------
 * A boot race is not a permanent failure. With the handshake HELD OPEN
 * (`fake.holdConnect()`), the checks below drive the same window a model hits
 * one second after `cua_vm_start`:
 *
 *   (k) the doctor says `attaching` (not `not-the-target`) with the pending name,
 *       `pendingSinceMs` and a `retryAfterMs` inside [1000, 20000], and a verdict
 *       sentence that names the computer and the retry;
 *   (l) the dispatch guard answers `attaching` for the session bound to the
 *       pending name, and does NOT swallow a session bound to another computer;
 *   (m) `windows_desktop` answers `attaching` with an EMPTY inventory;
 *   (n) releasing the handshake clears the state, and the mismatch that really
 *       exists still gets the EXACT `not-the-target` sentence;
 *   (o) the three Appendix C notes are appended verbatim to the three tools and
 *       every other description is byte-identical (the scope proof);
 *   (p) a measured dead element lane / an unwritable work dir are verdict
 *       WARNINGS naming the fallback, never a silent `ok`.
 *
 * A check whose verdict depends on a field a WP adds is PENDING (loudly, never
 * silently green) when the field is ABSENT — never when it is present and wrong;
 * `DSH_CUA_CONTRACT_STRICT=1` turns every pending into a failure, which is the
 * mutation check (T2).
 */
import net from 'node:net'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { registerHooks } from 'node:module'

const REPO = path.resolve(import.meta.dirname, '..')
const SOCK = path.join(process.env.TMPDIR ?? '/tmp', `cua-mcp-gate-${process.pid}`, 'sup.sock')

/**
 * THE HOOKS MUST BE REGISTERED BEFORE `index.js` IS IMPORTED, and they are
 * narrow on purpose: only the two specifiers this plugin resolves differently.
 */
const SCHEMASTERY = [
  process.env.DSH_SCHEMASTERY_PATH,
  '/opt/dsh-src/node_modules/@deepseek-ai/schemastery/lib/index.mjs',
  path.join(REPO, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  .find((candidate) => existsSync(candidate)) ?? null

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './win-mcp.js' && String(context.parentURL ?? '').includes('/plugins/dsh-cua-vm/index.js')) {
      return { url: new URL('./fixtures/fake-win-mcp.mjs', import.meta.url).href, shortCircuit: true }
    }
    if (specifier === '@deepseek-ai/schemastery') {
      return {
        url: SCHEMASTERY === null
          ? new URL('./fixtures/schemastery-stub.mjs', import.meta.url).href
          : new URL(`file://${SCHEMASTERY}`).href,
        shortCircuit: true
      }
    }
    return nextResolve(specifier, context)
  }
})

/* ------------------------------------------------------------------ *
 * THE FAKE SUPERVISOR — one request per connection, JSON line in/out
 * ------------------------------------------------------------------ */
const rows = new Map([
  ['winbox', { kind: 'windows', state: 'ready', ssh: true, sshPort: 47101 }],
  ['winbox2', { kind: 'windows', state: 'ready', ssh: true, sshPort: 47102 }]
])
const supervisorOps = []
/** What `vmList` answers — the registry the implicit-single-target rule counts. */
let listRegistry = {}

mkdirSync(path.dirname(SOCK), { recursive: true })
try { rmSync(SOCK, { force: true }) } catch {}

const server = net.createServer((socket) => {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    let request = {}
    try { request = JSON.parse(buffer.slice(0, newline)) } catch { socket.end('{"ok":false,"error":"bad json"}\n'); return }
    supervisorOps.push({ op: request.op, name: String(request.name ?? '') })
    const row = rows.get(request.name)
    let answer = { ok: true }
    switch (request.op) {
      case 'vmList': answer = { ok: true, registry: { ...listRegistry } }; break
      case 'configGet': answer = { ok: true, config: {} }; break
      case 'exec': answer = { ok: true, exit: 0, stdout: 'ok', stderr: '', ms: 1 }; break
      case 'destroy':
        rows.delete(request.name)
        answer = { ok: true, name: request.name, complete: true, items: [] }
        break
      // THE PANEL'S `/cua` DELETE ROUTE (the immediate path, and the one that
      // has to kill an in-flight attach ticket).
      case 'vmDelete':
        rows.delete(request.name)
        answer = { ok: true, name: request.name, complete: true, deleted: true, items: [] }
        break
      case 'vmWindowsMcpState':
        answer = row === undefined
          ? { ok: true, name: request.name, kind: 'unknown', state: 'absent', available: false, online: false, ssh: false, sshPort: 0, reason: `no computer named "${request.name}"` }
          : {
              ok: true,
              name: request.name,
              kind: row.kind,
              state: row.state,
              available: row.state === 'ready',
              online: row.state === 'ready' && row.ssh === true,
              ssh: row.ssh === true,
              sshPort: row.sshPort,
              keyPath: `/tmp/${request.name}/id_ed25519`,
              user: 'cua',
              host: '127.0.0.1'
            }
        break
      case 'vmWindowsMcp':
        answer = row?.state === 'ready' && row.ssh === true
          ? { ok: true, available: true, online: true, name: request.name, sshPort: row.sshPort, keyPath: `/tmp/${request.name}/id_ed25519`, user: 'cua', state: 'ready' }
          : { ok: true, available: false, name: request.name, reason: 'not ready' }
        break
      default: answer = { ok: true }
    }
    socket.end(`${JSON.stringify(answer)}\n`)
  })
  socket.on('error', () => {})
})
await new Promise((resolve) => server.listen(SOCK, resolve))

/* ------------------------------------------------------------------ *
 * THE FAKE HOST: a global tool registry, per-agent scoped tools, ctx
 * ------------------------------------------------------------------ */
let failures = 0
/** Checks whose production half has not landed yet (see `checkContract`). */
let pendings = 0
/** T2: a reverted production change must go RED, not "pending". */
const STRICT_CONTRACT = process.env.DSH_CUA_CONTRACT_STRICT === '1'
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}
/**
 * A check that can only pass once a WP-3 field exists. `landed` is the FIELD's
 * presence — never the value — so a wrong value FAILS and only a missing field
 * is pending. That keeps the suite honest on a tree where the change has not
 * landed yet without ever turning a real regression green.
 */
const checkContract = (label, landed, ok, detail = '', expected = '') => {
  if (landed) { check(label, ok, detail); return }
  if (STRICT_CONTRACT) {
    failures += 1
    console.log(` FAIL  ${label} — contract field absent and DSH_CUA_CONTRACT_STRICT=1${expected ? ` (${expected})` : ''}`)
    return
  }
  pendings += 1
  console.log(` PEND  ${label} — awaiting the production field${expected ? ` (${expected})` : ''}${detail ? ` — ${detail}` : ''}`)
}

const globalTools = new Map()
const registered = []
const disposed = []
const changeHandlers = []
const emitChange = () => { for (const fn of [...changeHandlers]) fn() }

const hostTools = {
  register(definition) {
    if (globalTools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
    globalTools.set(definition.name, definition)
    registered.push(definition.name)
    emitChange()
    return () => {
      if (globalTools.delete(definition.name)) disposed.push(definition.name)
      emitChange()
    }
  },
  schemas() { return [...globalTools.values()].map((definition) => ({ name: definition.name, description: definition.description })) },
  restrict() { throw new Error('tools.restrict() requires a scoped context (agent.ctx)') },
  guard() { throw new Error('tools.guard() requires a scoped context') }
}

function makeAgent(id) {
  const guards = []
  const restrictions = []
  const tools = {
    register: hostTools.register,
    schemas: hostTools.schemas,
    restrict(filter) {
      for (const name of [...(filter.deny ?? []), ...(filter.allow ?? [])]) {
        if (!globalTools.has(name)) throw new Error(`tools.restrict() names unknown global tool "${name}"`)
      }
      const entry = { filter, active: true }
      restrictions.push(entry)
      return () => {
        entry.active = false
        const at = restrictions.indexOf(entry)
        if (at >= 0) restrictions.splice(at, 1)
        // The host re-emits on a lifted restriction, exactly like the real one.
        emitChange()
      }
    },
    guard(fn) {
      guards.push(fn)
      return () => { const at = guards.indexOf(fn); if (at >= 0) guards.splice(at, 1) }
    }
  }
  const agentCtx = {
    tools,
    get: (name) => (name === 'tools' ? tools : undefined),
    inject: (_deps, fn) => { fn({ tools }); return { dispose: () => Promise.resolve() } },
    on() {},
    effect: (fn) => fn()
  }
  return {
    agent: { id, session: { id }, ctx: agentCtx },
    guards,
    restrictions,
    /** Every name this agent currently has HIDDEN (the union of live denies). */
    denied() {
      const names = new Set()
      for (const entry of restrictions) for (const name of entry.filter.deny ?? []) names.add(name)
      return [...names]
    }
  }
}

const handlers = new Map()
const effects = []
const routes = new Map()
const ctx = {
  tools: hostTools,
  webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
  systemPrompt: { section() {} },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose },
  on(event, fn) { const list = handlers.get(event) ?? []; list.push(fn); handlers.set(event, list) },
  get() { return undefined },
  inject() { return { dispose: () => Promise.resolve() } }
}

// The poll is read at call time and the floor is 1 s, so the suite runs fast
// without weakening the production default (10 s).
process.env.DSH_CUA_MCP_STATE_POLL_MS = '1000'
process.env.DSH_CUA_VM_WIN_MCP = '1'

const plugin = await import(new URL('../plugins/dsh-cua-vm/index.js', import.meta.url).href)
plugin.apply(ctx, { socketPath: SOCK })

const fake = await import(new URL('./fixtures/fake-win-mcp.mjs', import.meta.url).href)
/**
 * THE REAL MODULE, imported directly (the resolve hook only redirects
 * `./win-mcp.js` when its PARENT is `index.js`). The gate needs it for ONE
 * reason: to tell "the contract has not landed yet" (pending) from "the contract
 * landed with a different string" (a red). The fixture re-exports the real
 * module, so a fake cannot make this answer differ.
 */
const realWinMcp = await import(new URL('../plugins/dsh-cua-vm/win-mcp.js', import.meta.url).href)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate, ms = 8000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(50)
  }
  return false
}
const prefixed = () => [...globalTools.keys()].filter((name) => name.startsWith('mcp__windows__'))
const doctor = async (agent) => JSON.parse((await globalTools.get('windows_mcp_doctor').execute({}, { agent })).text)
/** The reveal/inventory helper the model itself calls (WP-5.2 (g)/(j)). */
const desktop = async (agent = agentA.agent) => JSON.parse((await globalTools.get('windows_desktop').execute({}, { agent })).text)
const post = async (routePath, body, headers = { origin: 'http://127.0.0.1:3079', host: '127.0.0.1:3079' }) => {
  // THE PAGE API IS ONE PREFIX ROUTE (`kind: 'prefix'`, path `/cua`), so a
  // sub-action is selected by the request URL, not by a second registration.
  const route = routes.get(routePath) ?? routes.get('/cua')
  const req = {
    method: 'POST',
    url: routePath === '/cua' ? '/cua/delete' : routePath,
    headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) }
  }
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(text) { this.text = text } }
  await route.handler(req, res)
  return { status: res.statusCode, body: JSON.parse(res.text) }
}

/**
 * The Computer Use grant route. It is a SECOND prefix registration
 * (`/dsh-cua-vm`), so `post()` above (which resolves `/cua`) cannot reach it and
 * a GET is a read with no body. Same-origin headers, because the route refuses a
 * cross-origin mutation by design.
 */
const grant = async (method, body = undefined) => {
  const route = routes.get('/dsh-cua-vm')
  const req = {
    method,
    url: '/dsh-cua-vm/cua-grant',
    headers: { origin: 'http://127.0.0.1:3079', host: '127.0.0.1:3079' },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) }
  }
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(text) { this.text = text } }
  await route.handler(req, res)
  return { status: res.statusCode, body: JSON.parse(res.text) }
}

/** Deliver one supervisor event the way the plugin really learns it. */
const deliver = {
  /** The row's state changed; the poll (and the shared teardown) observes it. */
  async state(name, state) {
    const row = rows.get(name) ?? {}
    rows.set(name, { ...row, state })
    return waitFor(async () => (await doctor(agentA.agent)).online === false)
  },
  /** The row is gone; the delete route is the immediate path. */
  async removed(name) {
    rows.delete(name)
    const answer = await post('/cua', { name })
    return { answer, settled: await waitFor(() => prefixed().length === 0) }
  }
}

const agentA = makeAgent('session-A')
const agentB = makeAgent('session-B')
for (const { agent } of [agentA, agentB]) for (const fn of handlers.get('agent/created') ?? []) fn({ agent })

try {
  check('the two ungated helpers are registered (reveal + doctor)',
    globalTools.has('windows_desktop') && globalTools.has('windows_mcp_doctor'))
  check('nothing is registered under the prefix before a computer is bound', prefixed().length === 0, prefixed().join(','))

  // ---- (a) 19 registrations ----
  await globalTools.get('cua_vm_exec').execute({ name: 'winbox', cmd: 'dir' }, { agent: agentA.agent })
  const attached = await waitFor(() => prefixed().length === 19)
  check('(a) binding a Windows computer registers all 19 guest tools under mcp__windows__*',
    attached && prefixed().length === 19, `${prefixed().length} name(s)`)
  check('(a) ...and they are the guest tool names, prefixed (never doubled)',
    prefixed().includes('mcp__windows__tool_click_at') && prefixed().includes('mcp__windows__find_elements')
    && prefixed().filter((name) => name.startsWith('mcp__windows__mcp__windows__')).length === 0,
    prefixed().slice(0, 2).join(','))
  // `leaks` is the RAW prefix surface the doctor reports; while the bridge is
  // online those 19 names are the point, and `status` stays "ok". Offline the
  // same list MUST be empty — asserted below, which is what makes this a leak test.
  const onlineDoctor = await doctor(agentA.agent)
  check('(a) ...the doctor sees the same 19 registered names and reports status ok online',
    onlineDoctor.registered.length === 19 && onlineDoctor.status === 'ok' && onlineDoctor.leaks.length === 19,
    `registered=${onlineDoctor.registered.length} status=${onlineDoctor.status} leaks=${onlineDoctor.leaks.length}`)

  // ---- (c) the per-agent restriction hides the 19 from whoever may not see them ----
  //
  // SINCE AUTO-REVEAL (WP-3.4) THE OLD "every live agent has all 19 denied" IS
  // FALSE BY DESIGN: session A is bound, and a bound + granted session is
  // revealed (SOL §4.7), so its restriction is LIFTED — that is the fix, not a
  // leak. What must still hold is the asymmetry: a session that may not use the
  // bridge carries all 19 in its deny list, and the revealed one carries none.
  check('(c) the un-revealed session has all 19 bridged names denied',
    agentB.denied().length === 19 && prefixed().every((name) => agentB.denied().includes(name)),
    `A=${agentA.denied().length} B=${agentB.denied().length}`)
  check('(c) ...while the revealed (bound) session is denied NONE of them — auto-reveal is the gate, not a bypass',
    agentA.denied().length === 0 && (await doctor(agentA.agent)).revealed.includes('session-A'),
    `denied=${agentA.denied().length} revealed=${JSON.stringify((await doctor(agentA.agent)).revealed)}`)
  check('(c) ...and the non-bridged tools are never in a deny list',
    [agentA, agentB].every((agent) => !agent.denied().some((name) => !name.startsWith('mcp__windows__'))))

  // ---- (d) the guard, online: THE GRANT STARTS ON, AND A BOUND SESSION IS REVEALED ----
  //
  // The grant default flipped to ON (see `WIN_MCP_AUX.grantDefault`): a fresh
  // session no longer has to find the panel switch before its first click, so
  // "the guard refuses with grant-off" is no longer the state of a NEW session —
  // it is the state of an EXPLICITLY DENIED one.
  //
  // THE REVEAL CHANGED TOO (SOL §4.7, WP-3.4). A session that BINDS a computer
  // while granted is revealed by the bind, and `revealedFor()` honours the
  // session id, so the guard NO LONGER answers `reveal-required` for it. The old
  // assertion ("granted but unrevealed ⇒ reveal-required") described the defect,
  // not the contract: it is replaced by the pair below — bound ⇒ allowed, and
  // UNBOUND (implicit target) ⇒ still `reveal-required`, which is what keeps the
  // veto reachable. The grant is restored because every later check needs
  // session A granted.
  //
  // The default is read with GET (never POST `{}`: without a `sessionId` the
  // route flips the PROCESS default and clears the per-session overrides).
  const grantDefaultView = await grant('GET')
  check('(d) a new session starts with the Computer Use grant ON (the route says default on)',
    grantDefaultView.status === 200 && grantDefaultView.body.ok === true
    && grantDefaultView.body.default === 'on'
    && grantDefaultView.body.off.includes('session-A') === false,
    `default=${grantDefaultView.body.default} on=${JSON.stringify(grantDefaultView.body.on)} off=${JSON.stringify(grantDefaultView.body.off)}`)
  // BOUND + GRANTED ⇒ REVEALED ⇒ the guard lets the call through.
  const boundRevealed = await waitFor(async () => ((await doctor(agentA.agent)).revealed ?? []).includes('session-A'), 4000)
  const boundGuard = agentA.guards[0]({ name: 'mcp__windows__tool_click_at', agent: agentA.agent })
  checkContract('(d) a BOUND session is revealed by the bind, so the guard is NOT at reveal-required',
    'revealed' in onlineDoctor, boundRevealed && boundGuard === undefined,
    `revealed=${boundRevealed} code=${boundGuard?.info?.code ?? '(none)'}`,
    'WP-3.4 auto-reveal on bind: guard returns undefined for a revealed session')
  // THE VETO STAYS REACHABLE: an UNBOUND session that is allowed only by
  // `implicit-single-target` (exactly one computer known) is still refused.
  listRegistry = { winbox: { kind: 'windows', state: 'ready' } }
  await post('/cua/state', {})
  const agentU = makeAgent('session-U')
  for (const fn of handlers.get('agent/created') ?? []) fn({ agent: agentU.agent })
  await sleep(120)
  const unboundGuard = agentU.guards[0]({ name: 'mcp__windows__tool_click_at', agent: agentU.agent })
  check('(d) an UNBOUND session (implicit-single-target) is STILL refused with reveal-required',
    unboundGuard?.info?.code === 'reveal-required',
    `${unboundGuard?.info?.code ?? '(none)'} — ${String(unboundGuard?.reason ?? '').split('\n')[1] ?? ''}`)
  // Put the registry back the way the earlier checks found it.
  listRegistry = {}
  await post('/cua/state', {})
  const denyAnswer = await grant('POST', { grant: false, sessionId: 'session-A' })
  check('(d) POST /dsh-cua-vm/cua-grant {"grant":false,"sessionId":"session-A"} denies exactly that session',
    denyAnswer.status === 200 && denyAnswer.body.ok === true && denyAnswer.body.granted === false
    && denyAnswer.body.off.includes('session-A') && denyAnswer.body.off.includes('session-B') === false,
    `granted=${denyAnswer.body.granted} off=${JSON.stringify(denyAnswer.body.off)} on=${JSON.stringify(denyAnswer.body.on)}`)
  const grantOff = agentA.guards[0]({ name: 'mcp__windows__tool_click_at', agent: agentA.agent })
  check('(d) denied, the guard refuses with code grant-off',
    grantOff?.info?.code === 'grant-off' && /code: grant-off/u.test(grantOff?.reason ?? ''),
    String(grantOff?.reason ?? '').split('\n')[1])
  check('the guard ignores a non-bridged name entirely',
    agentA.guards[0]({ name: 'cua_vm_exec', agent: agentA.agent }) === undefined)
  const restoreAnswer = await grant('POST', { grant: true, sessionId: 'session-A' })
  check('(d) ...and granting session A back restores it (the later checks need it granted)',
    restoreAnswer.status === 200 && restoreAnswer.body.granted === true
    && restoreAnswer.body.on.includes('session-A') && restoreAnswer.body.default === 'on',
    `granted=${restoreAnswer.body.granted} on=${JSON.stringify(restoreAnswer.body.on)} default=${restoreAnswer.body.default}`)
  check('(d) ...so the guard is back to allowing the revealed bound session (never grant-off) for the rest of the suite',
    agentA.guards[0]({ name: 'mcp__windows__tool_click_at', agent: agentA.agent }) === undefined)

  // ================================================================== *
  // WP-5.2 — THE LANE, THE REPAIR AND THE VERDICT
  //
  // Everything below is driven by the FIXTURE's lane knobs, because the lane is
  // decided inside `win-mcp.js` (replaced by the fixture, §5.1). That is the
  // point of the seam: the plugin's verdict (`status`/`blind`/`blindReason`),
  // its repair wiring and its reveal rules are the REAL ones, and only the
  // guest's answer is staged. `setLane('session-0-direct')` is the reported P0
  // bug on demand — a healthy relay the harness cannot read.
  // ================================================================== */
  const RELAY_DOWN = fake.RELAY_DOWN ?? 'RELAY_DOWN'
  const RELAY_SKEW = fake.RELAY_SKEW ?? 'RELAY_SKEW'
  /**
   * Tear the bridge down and bring the same computer back: a genuinely FRESH
   * attach, which is the only way to make the fixture's CURRENT lane apply (the
   * lane is decided at attach, exactly like the real client).
   *
   * THESE CHECKS RUN WHILE THE BRIDGE IS HEALTHY AND BOUND — before the
   * power-off / removal blocks below — because a lane is only re-decided by a
   * real attach, and the attach path needs a live, bound computer. `reattach()`
   * is exactly the power cycle `cua_vm_shutdown` → `cua_vm_start`.
   */
  const reattach = async (name = 'winbox') => {
    rows.set(name, { kind: 'windows', state: 'powered-off', ssh: true, sshPort: 47101 })
    const down = await waitFor(async () => (await doctor(agentA.agent)).online === false, 8000)
    rows.set(name, { kind: 'windows', state: 'ready', ssh: true, sshPort: 47101 })
    const up = await waitFor(() => prefixed().length === 19, 10000)
    return { down, up }
  }

  // ---- (f) the DEFAULT lane: an attach through the relay is `ok` ----
  //
  // The healthy half has to stay healthy: a suite where every attach is blind
  // would "pass" a repair test and prove nothing about the good path.
  fake.setLane('interactive-relay')
  rows.set('winbox', { kind: 'windows', state: 'ready', ssh: true, sshPort: 47101 })
  const laneAttached = await waitFor(() => prefixed().length === 19)
  const healthy = await doctor(agentA.agent)
  const healthyClient = fake.SESSIONS.at(-1)
  check('(f) the default lane attaches through the interactive relay',
    laneAttached && healthy.transport === 'interactive-relay' && healthy.relayOk === true,
    `attached=${laneAttached} transport=${healthy.transport} relayOk=${healthy.relayOk}`)
  check('(f) ...with the HANDSHAKE probe recorded and the same port on both sides',
    healthy.probeMode === 'handshake' && healthy.relayStatus === 'RELAY_OK'
    && healthy.relayPort === healthyClient.state.relayPort,
    `mode=${healthy.probeMode} status=${healthy.relayStatus} doctorPort=${healthy.relayPort} clientPort=${healthyClient.state.relayPort}`)
  checkContract('(f) ...and the verdict is ok — never blind, no blindReason',
    'blind' in healthy,
    healthy.status === 'ok' && healthy.blind === false && healthy.blindReason === null,
    `status=${healthy.status} blind=${healthy.blind} blindReason=${healthy.blindReason}`,
    'WP-3.1: status ∈ {ok,blind,leaking} + blind + blindReason')
  check('(f) ...because the facts are the CLIENT\'s facts (the fake client and the doctor agree)',
    healthyClient.state.transport === 'interactive-relay' && healthyClient.state.relayOk === true
    && healthy.transport === healthyClient.state.transport,
    `client=${healthyClient.state.transport}/${healthyClient.state.relayOk} doctor=${healthy.transport}/${healthy.relayOk}`)

  // ---- (g) the BLIND lane: the verdict must say so ----
  //
  // THE REPORTED BUG: a healthy relay the harness cannot read ⇒ session-0-direct
  // ⇒ blind desktop ⇒ and `status: ok`. The lane is staged from the fixture; the
  // verdicts below are the plugin's.
  fake.setLane('session-0-direct', { relayStatus: RELAY_DOWN, probeMode: 'handshake' })
  const blindCycle = await reattach()
  const blindDown = await doctor(agentA.agent)
  checkContract('(g) a blind attach is reported as BLIND, never as ok',
    'blindReason' in blindDown,
    blindCycle.up && blindDown.status === 'blind' && blindDown.blind === true,
    `cycle=${JSON.stringify(blindCycle)} status=${blindDown.status}`,
    'WP-3.1: status blind when online but the lane is not the relay')
  checkContract('(g) ...with a blindReason from the CLOSED set (relay-stopped for a DOWN probe)',
    'blindReason' in blindDown,
    fake.BLIND_REASONS.includes(blindDown.blindReason) && blindDown.blindReason === 'relay-stopped',
    `blindReason=${blindDown.blindReason}`,
    'WP-3.1: blindReason ∈ {probe-skew,relay-missing,relay-stopped,no-interactive-session,lane-unknown,repair-disabled}')
  check('(g) ...and the transport is session-0-direct with relayOk false — still a handshake, not a legacy ping',
    blindDown.transport === 'session-0-direct' && blindDown.relayOk === false && blindDown.probeMode === 'handshake',
    `transport=${blindDown.transport} relayOk=${blindDown.relayOk} mode=${blindDown.probeMode}`)
  // THE TWO CAUSES CARRY TWO SENTENCES (§2.3): a relay that is NOT RUNNING and a
  // relay that ANSWERED but could not be read are different facts, and the doctor
  // must repeat which one it saw. The DOWN sentence stays byte-identical.
  check('(g) ...and the reason it repeats is the DOWN sentence, byte-identical to the old one',
    blindDown.transportReason === fake.SESSION0_FALLBACK_REASON,
    String(blindDown.transportReason ?? '').slice(0, 88))
  const blindDesk = await desktop()
  checkContract('(g) windows_desktop SAYS the desktop is blind instead of pretending it works',
    'blindReason' in blindDown,
    /blind/iu.test(String(blindDesk.note ?? '')) && /relay-stopped/u.test(String(blindDesk.note ?? '')),
    String(blindDesk.note ?? '').slice(0, 90),
    'WP-3.3: the desktop tool names the reason and the next action')
  // THE P0 SIGNATURE, EXACTLY: the guest relay ANSWERED (usage on stderr, exit 2
  // on the old probe) — that is a payload skew, NOT a dead relay, and the two
  // must not be reported as the same thing.
  fake.setLane('session-0-direct', { relayStatus: RELAY_SKEW, probeMode: 'handshake', relayDetail: 'usage on stderr, exit 2' })
  const skewCycle = await reattach()
  const skewDoctor = await doctor(agentA.agent)
  checkContract('(g) the P0 signature — relay answered, probe could not read it — is probe-skew, not a dead relay',
    'blindReason' in skewDoctor,
    skewCycle.up && skewDoctor.status === 'blind' && skewDoctor.blindReason === 'probe-skew'
    && skewDoctor.relayStatus === RELAY_SKEW,
    `cycle=${JSON.stringify(skewCycle)} status=${skewDoctor.status} blindReason=${skewDoctor.blindReason} relayStatus=${skewDoctor.relayStatus}`,
    'WP-3.1 + WP-2.2: RELAY_SKEW ⇒ blindReason probe-skew')
  check('(g) ...and it repeats the SKEW sentence, never the DOWN one',
    skewDoctor.transportReason === fake.SESSION0_SKEW_REASON
    && skewDoctor.transportReason !== fake.SESSION0_FALLBACK_REASON
    && /desktop automation will be blind/u.test(String(skewDoctor.transportReason ?? '')),
    String(skewDoctor.transportReason ?? '').slice(0, 88))

  // ---- (h) the REPAIR: throttled, grammatical, and it heals the lane ----
  //
  // A failing repair must cost ONE child per window (a poll beat is every second;
  // an unthrottled repair would be an ssh storm), and a frozen-grammar
  // `CUA_RELAY ok=1` record must flip the lane on the next sync.
  fake.setLane('session-0-direct', { relayStatus: RELAY_DOWN, probeMode: 'handshake' })
  await reattach()
  fake.setRepairThrottleMs(60_000)
  fake.setRepairResult({ ok: false, reason: 'relay-stopped', probe: RELAY_DOWN })
  // THE REATTACH ITSELF MAY HAVE SPENT THE WINDOW — an attempt that produced no
  // record is still an attempt (`measured:false`, `unmeasured:'no-record'`) and
  // must be throttled like any other. Open a fresh window, then measure.
  fake.advanceRepairWindow(60_000)
  const repairBase = fake.counters.repairCalls
  for (let i = 0; i < 6; i += 1) { await doctor(agentA.agent); await sleep(180) }
  const firstWindowRepairs = fake.counters.repairCalls - repairBase
  check('(h) a failing repair costs exactly ONE attempt per throttle window (never one per sync beat)',
    firstWindowRepairs === 1, `${firstWindowRepairs} attempt(s) across 6 sync beat(s)`)
  // THE FORCED PATH (WP-3.6): `windows_mcp_doctor { repair: true }` is the model's
  // "do it now" argument, and it must spend exactly ONE attempt even though the
  // throttle window is still closed.
  const windowBase = fake.counters.repairCalls
  const forced = JSON.parse((await globalTools.get('windows_mcp_doctor').execute({ repair: true }, { agent: agentA.agent })).text)
  check('(h) windows_mcp_doctor {repair:true} forces exactly ONE attempt inside a closed throttle window',
    fake.counters.repairCalls - windowBase === 1 && forced.repair?.enabled === true,
    `${fake.counters.repairCalls - windowBase} attempt(s) — enabled=${forced.repair?.enabled}`)
  // THE HEAL. The record is the FROZEN Appendix B line, not a private JS shape —
  // this is the assertion that keeps the guest's grammar and the harness's
  // parser from drifting apart.
  fake.setRepairResult(`CUA_RELAY ok=1 port=47999 task=1 running=1 session=2 probe=RELAY_OK hash=${fake.FIXTURE_RELAY_HASH} mode=handshake reason=`)
  fake.advanceRepairWindow(60_000)
  const laneHealed = await waitFor(async () => (await doctor(agentA.agent)).transport === 'interactive-relay', 10000)
  const healedDoctor = await doctor(agentA.agent)
  check('(h) a frozen-grammar `CUA_RELAY ok=1` record flips a blind client to the relay lane on the next sync',
    laneHealed && healedDoctor.transport === 'interactive-relay' && healedDoctor.relayOk === true,
    `healed=${laneHealed} transport=${healedDoctor.transport} relayOk=${healedDoctor.relayOk}`)
  check('(h) ...and the repair record reaches doctorFacts() with ok=true (P3: the client, not a guess)',
    fake.SESSIONS.at(-1).doctorFacts().repair?.ok === true
    && fake.SESSIONS.at(-1).doctorFacts().repair?.port === 47999,
    JSON.stringify(fake.SESSIONS.at(-1).doctorFacts().repair))
  checkContract('(h) ...and the doctor reports the repair as ok (the verdict is backed by the record)',
    'repair' in healedDoctor,
    healedDoctor.repair?.ok === true && healedDoctor.repair?.probe === 'RELAY_OK',
    JSON.stringify(healedDoctor.repair),
    'WP-3.2: repair { attempts, lastAt, ok, reason, backoffMs } — ok/probe come from the CUA_RELAY record')
  // THE KILL SWITCH SPENDS NOTHING: with REPAIR=0 the lane goes blind again and
  // the plugin must not spawn a repair, nor claim one.
  const savedKill = process.env.DSH_CUA_VM_WIN_MCP_REPAIR
  process.env.DSH_CUA_VM_WIN_MCP_REPAIR = '0'
  try {
    fake.setLane('session-0-direct', { relayStatus: RELAY_DOWN, probeMode: 'handshake' })
    await reattach()
    const killedBase = fake.counters.repairCalls
    for (let i = 0; i < 4; i += 1) { await doctor(agentA.agent); await sleep(180) }
    const killedDoctor = await doctor(agentA.agent)
    check('(h) DSH_CUA_VM_WIN_MCP_REPAIR=0 spends NO attempt and the doctor says repair is disabled',
      fake.counters.repairCalls === killedBase && killedDoctor.repair?.enabled === false,
      `attempts=${fake.counters.repairCalls - killedBase} enabled=${killedDoctor.repair?.enabled}`)
  } finally {
    if (savedKill === undefined) delete process.env.DSH_CUA_VM_WIN_MCP_REPAIR
    else process.env.DSH_CUA_VM_WIN_MCP_REPAIR = savedKill
  }

  // ---- (h) THE MEASUREMENT: what a repair record is allowed to PROVE ----
  //
  // A parsed `CUA_RELAY …` line is a MEASUREMENT of an attempt that ran: it can
  // say "session=0" (there is no console session) or "hash=" (the payload is not
  // there). An attempt that never ran measures NOTHING, and `session: 0` is not
  // the same fact as "nobody looked" — collapsing the two is how a bridge that
  // was merely throttled gets reported as "no interactive session", which sends
  // an operator to open a console that was never the problem. The records below
  // are the three shapes, and the verdict must distinguish them.
  //
  // The lane is still `session-0-direct` here (the kill-switch arm left it blind
  // and restored the flag), so every repair attempt is legal.
  fake.setRepairThrottleMs(60_000)
  /** Force ONE repair with `record` and return the doctor the plugin renders. */
  const repairWith = async (record) => {
    fake.setRepairResult(record)
    const forcedText = (await globalTools.get('windows_mcp_doctor').execute({ repair: true }, { agent: agentA.agent })).text
    try { return JSON.parse(forcedText) } catch { return doctor(agentA.agent) }
  }

  // 1. THE ATTEMPT RAN AND FOUND NO CONSOLE SESSION: session=0 is a measurement,
  //    so the reason is no-interactive-session — the one reason that tells the
  //    operator "a console has to exist", not "start the relay".
  const measuredNoSession = await repairWith({ measured: true, ok: false, session: 0, hash: fake.FIXTURE_RELAY_HASH, probe: RELAY_DOWN, reason: 'no-interactive-session' })
  checkContract('(h) a MEASURED session=0 is no-interactive-session (a console is missing, not a relay)',
    'measured' in (measuredNoSession.repair ?? {}),
    measuredNoSession.repair?.measured === true
    && measuredNoSession.repair?.session === 0
    && measuredNoSession.blindReason === 'no-interactive-session',
    `measured=${measuredNoSession.repair?.measured} session=${measuredNoSession.repair?.session} blindReason=${measuredNoSession.blindReason}`,
    'WP-2.5/§4.6: the record is the measurement, and session=0 selects no-interactive-session')

  // 2. THE ATTEMPT RAN AND THE PAYLOAD IS MISSING: `hash=` (empty, measured) is
  //    relay-missing — a different repair (re-stage the payload), not a `/run`.
  const measuredNoPayload = await repairWith({ measured: true, ok: false, session: 2, hash: '', probe: RELAY_DOWN, reason: 'relay-missing' })
  checkContract('(h) a MEASURED empty hash is relay-missing (the payload is absent, not the session)',
    'measured' in (measuredNoPayload.repair ?? {}),
    measuredNoPayload.repair?.measured === true
    && measuredNoPayload.repair?.hash === ''
    && measuredNoPayload.blindReason === 'relay-missing',
    `measured=${measuredNoPayload.repair?.measured} hash=${JSON.stringify(measuredNoPayload.repair?.hash)} blindReason=${measuredNoPayload.blindReason}`,
    'WP-2.5/§4.6: hash="" on a measured record selects relay-missing')

  // 3. THE ATTEMPT NEVER RAN. The record carries `session: 0` (the tempting
  //    default) but `measured: false`, so the harness must NOT read it as a
  //    console verdict: it falls back to the lane fact, relay-stopped.
  const unmeasuredAttempt = await repairWith({ measured: false, unmeasured: 'no-record', session: 0, hash: '', probe: null })
  checkContract('(h) an UNMEASURED record never claims no-interactive-session or relay-missing',
    'measured' in (unmeasuredAttempt.repair ?? {}),
    unmeasuredAttempt.repair?.measured === false
    && unmeasuredAttempt.repair?.session === null
    && unmeasuredAttempt.repair?.hash === null
    && unmeasuredAttempt.blindReason === 'relay-stopped',
    `measured=${unmeasuredAttempt.repair?.measured} session=${JSON.stringify(unmeasuredAttempt.repair?.session)} hash=${JSON.stringify(unmeasuredAttempt.repair?.hash)} blindReason=${unmeasuredAttempt.blindReason}`,
    'WP-2.5: measured:false + null fields ⇒ relay-stopped, never a console/payload claim')

  // 4. AND THE VERDICT CARRIES WHICH OF THE TWO IT IS. Without `repair.measured`
  //    a consumer has to guess whether `session: 0` was seen or assumed.
  checkContract('(h) the doctor exposes repair.measured, so "nobody looked" is distinguishable from "session=0"',
    'measured' in (unmeasuredAttempt.repair ?? {}),
    typeof measuredNoSession.repair?.measured === 'boolean'
    && typeof unmeasuredAttempt.repair?.measured === 'boolean'
    && measuredNoSession.repair.measured !== unmeasuredAttempt.repair.measured,
    `measured(no-session)=${measuredNoSession.repair?.measured} measured(not-run)=${unmeasuredAttempt.repair?.measured}`,
    'WP-3.2: the repair block carries measured/unmeasured')

  // ---- (i) the RESTORE path: a cached DOWN must not pin the lane ----
  //
  // `cua_vm_shutdown` → `cua_vm_start` is a real boot: the relay comes back in a
  // NEW interactive session. The defect would be a probe cache that keeps
  // answering DOWN from before the reboot.
  fake.setLane('interactive-relay')
  const connectsBefore = fake.counters.connects
  const probesBefore = fake.counters.probeCalls
  const restored = await reattach()
  const restoreDoctor = await doctor(agentA.agent)
  check('(i) restore: powered-off → ready re-attaches with a FRESH probe (the attach is not cached)',
    restored.down && restored.up && fake.counters.connects > connectsBefore && fake.counters.probeCalls > probesBefore,
    `down=${restored.down} up=${restored.up} connects +${fake.counters.connects - connectsBefore} probes +${fake.counters.probeCalls - probesBefore}`)
  check('(i) ...and the lane is the one the fixture NOW reports — the cached DOWN did not pin it',
    restoreDoctor.transport === 'interactive-relay' && restoreDoctor.relayOk === true,
    `transport=${restoreDoctor.transport} relayOk=${restoreDoctor.relayOk}`)
  checkContract('(i) ...so the verdict follows the lane back to ok',
    'blind' in restoreDoctor,
    restoreDoctor.status === 'ok' && restoreDoctor.blindReason === null,
    `status=${restoreDoctor.status} blindReason=${restoreDoctor.blindReason}`)

  // ---- (j) the INVENTORY and the IDENTITY ----
  //
  // The other reported lie: 19 tool names handed to a session that cannot use
  // them (unbound, or a bridge it may not touch). And the identity gap: nothing
  // in the doctor said WHICH plugin and WHICH payload.
  // Two computers exist for a moment, so an unbound session has no implicit
  // target — that is the session that must NOT receive 19 tool names.
  rows.set('winbox2', { kind: 'windows', state: 'ready', ssh: true, sshPort: 47102 })
  listRegistry = { winbox: { kind: 'windows', state: 'ready' }, winbox2: { kind: 'windows', state: 'ready' } }
  await post('/cua/state', {})
  const agentJ = makeAgent('session-J')
  for (const fn of handlers.get('agent/created') ?? []) fn({ agent: agentJ.agent })
  await sleep(150)
  const hiddenDesk = await desktop(agentJ.agent)
  check('(j) windows_desktop returns an EMPTY inventory to a session that may not use the bridge',
    Array.isArray(hiddenDesk.tools) && hiddenDesk.tools.length === 0 && hiddenDesk.revealed === false,
    `revealed=${hiddenDesk.revealed} tools=${Array.isArray(hiddenDesk.tools) ? hiddenDesk.tools.length : typeof hiddenDesk.tools}`)
  check('(j) ...with a code that says WHY (an empty list alone looks like a dead guest)',
    typeof hiddenDesk.code === 'string' && hiddenDesk.code !== '', `code=${hiddenDesk.code}`)
  // BIND + GRANTED ⇒ AUTO-REVEALED. There is no reveal call anywhere in this
  // file: the binding is the reveal (SOL §4.7).
  await globalTools.get('cua_vm_exec').execute({ name: 'winbox', cmd: 'dir' }, { agent: agentJ.agent })
  const autoRevealed = await waitFor(async () => ((await doctor(agentJ.agent)).revealed ?? []).includes('session-J'), 8000)
  const boundDesk = await desktop(agentJ.agent)
  check('(j) a session that binds + is granted is AUTO-revealed: 19 tools with no manual reveal step',
    autoRevealed && boundDesk.revealed === true && Array.isArray(boundDesk.tools) && boundDesk.tools.length === 19,
    `autoRevealed=${autoRevealed} revealed=${boundDesk.revealed} tools=${Array.isArray(boundDesk.tools) ? boundDesk.tools.length : typeof boundDesk.tools}`)
  const jDoctor = await doctor(agentJ.agent)
  checkContract('(j) the doctor carries pluginVersion (identity travels with the verdict)',
    'pluginVersion' in jDoctor,
    typeof jDoctor.pluginVersion === 'string' && /^\d+\.\d+\.\d+/u.test(jDoctor.pluginVersion),
    `pluginVersion=${jDoctor.pluginVersion}`,
    'WP-3.7 + WP-7.1: PLUGIN_VERSION 0.2.1 === package.json')
  checkContract('(j) ...and payload.relayHash (WHICH guest payload answered the probe)',
    'payload' in jDoctor,
    /^[0-9a-f]{64}$/u.test(String(jDoctor.payload?.relayHash ?? '')),
    `payload=${JSON.stringify(jDoctor.payload)}`,
    'WP-2.7 + WP-3.2: payload { relayHash, skew }')

  // Hand the block below exactly what it found: both computers present, the
  // registry empty again (J20-5 populates it), and an online bridge bound to
  // winbox. Nothing here deletes a row — (e) and J20-5 bind winbox2 next.
  rows.set('winbox', { kind: 'windows', state: 'ready', ssh: true, sshPort: 47101 })
  rows.set('winbox2', { kind: 'windows', state: 'ready', ssh: true, sshPort: 47102 })
  listRegistry = {}
  await post('/cua/state', {})
  const handedBack = await waitFor(async () => (await doctor(agentA.agent)).online === true && prefixed().length === 19, 8000)
  check('(j) ...and the lane checks hand the suite back a healthy, attached bridge',
    handedBack, `online=${(await doctor(agentA.agent)).online} names=${prefixed().length}`)


  // ---- (b) event 1: vm-state powered-off ----
  const before = disposed.length
  const observed = await deliver.state('winbox', 'powered-off')
  check('(b) {"event":"vm-state","state":"powered-off"} is observed by the state poll', observed)
  check('(b) ...and every one of the 19 disposers was called',
    disposed.length - before === 19 && prefixed().length === 0,
    `disposed=${disposed.length - before} left=${prefixed().length}`)
  check('(b) ...no mcp__windows__* schema survives on the GLOBAL registry',
    hostTools.schemas().filter((schema) => schema.name.startsWith('mcp__windows__')).length === 0,
    hostTools.schemas().map((schema) => schema.name).join(','))
  check('(b) ...the doctor reports status ok with zero leaks',
    (await doctor(agentA.agent)).status === 'ok' && (await doctor(agentA.agent)).leaks.length === 0)

  // ---- (d) the guard offline ----
  const offline = agentA.guards[0]({ name: 'mcp__windows__tool_click_at', agent: agentA.agent })
  check('(d) offline, guard({name:"mcp__windows__tool_click_at"}) returns the vm-offline text',
    offline?.info?.code === 'vm-offline'
    && /code: vm-offline/u.test(offline.reason ?? '')
    && /the Windows computer is not online/u.test(offline.reason ?? '')
    && /windows_desktop/u.test(offline.reason ?? ''),
    String(offline?.reason ?? '').split('\n')[0])

  // ---- (b) event 2: vm-removed ----
  rows.set('winbox', { kind: 'windows', state: 'ready', ssh: true, sshPort: 47101 })
  const reattached = await waitFor(() => prefixed().length === 19)
  check('(b) the same binding re-attaches when the computer comes back (still 19)', reattached, `${prefixed().length}`)
  const beforeRemove = disposed.length
  const removal = await deliver.removed('winbox')
  check('(b) {"event":"vm-removed"} is answered by the delete route', removal.answer.status === 200 && removal.answer.body.ok === true)
  check('(b) ...and the 19 disposers for THAT attach ran (no schema left behind)',
    removal.settled && disposed.length - beforeRemove === 19 && prefixed().length === 0,
    `disposed=${disposed.length - beforeRemove} left=${prefixed().length}`)
  check('(b) ...the binding is forgotten, so a poll cannot resurrect it',
    (await doctor(agentA.agent)).bound.length === 0 && (await doctor(agentA.agent)).target === null)

  // ---- (e) the pre-step self-heal clears a LEAKED session ----
  //
  // THE REPORTED SHAPE: the SSH session died (or was never told about) while the
  // 19 schemas stayed registered. `leakSession` reproduces exactly that — a
  // disconnected client that never fired `onClosed`, so `teardown` was never
  // called. The pre-step hook must notice and clear it, and it must still let the
  // step continue.
  await globalTools.get('cua_vm_exec').execute({ name: 'winbox2', cmd: 'dir' }, { agent: agentA.agent })
  const reattached2 = await waitFor(() => prefixed().length === 19)
  check('(e) a second computer attaches too (19 names)', reattached2, `${prefixed().length}`)
  const leaked = fake.SESSIONS.at(-1)
  fake.leakSession(leaked)
  check('(e) the leak is real: 19 schemas alive while the client says disconnected',
    prefixed().length === 19 && leaked.state.connected === false)
  const beforeHeal = disposed.length
  const preStep = (handlers.get('agent/pre-step') ?? [])[0]
  let nextCalls = 0
  const decision = preStep === undefined ? null : await preStep({ agent: agentA.agent, messages: [] }, async () => { nextCalls += 1; return { kind: 'allow' } })
  check('(e) ...the pre-step hook continues the step EXACTLY once (never swallowed)',
    preStep !== undefined && nextCalls === 1 && decision?.kind === 'allow', `next=${nextCalls}`)
  const healed = await waitFor(() => prefixed().length === 0, 2000)
  check('(e) ...and the leaked registrations are cleared by the self-heal',
    healed && disposed.length - beforeHeal === 19, `disposed=${disposed.length - beforeHeal} left=${prefixed().length}`)
  check('(e) ...so the global registry carries no bridged name afterwards',
    hostTools.schemas().every((schema) => !schema.name.startsWith('mcp__windows__')))

  // ---- J20-5: TWO COMPUTERS, ONE ATTACHED, AND THE STRUCTURED REFUSAL ----
  //
  // One process, one SSH session, many sessions. The bug: session B (bound to
  // winbox) clicked on session A's winbox2 desktop because the guard only asked
  // "is the grant on for you", never "is that machine yours". The refusal is now
  // structured (`code: not-the-target`) and names BOTH computer names, so the
  // model can rebind instead of guessing.
  let lastDoctor = {}
  const freshDoctor = async (agent = agentA.agent) => { lastDoctor = await doctor(agent); return lastDoctor }
  rows.set('winbox', { kind: 'windows', state: 'ready', ssh: true, sshPort: 47101 })
  await globalTools.get('cua_vm_exec').execute({ name: 'winbox', cmd: 'dir' }, { agent: agentB.agent })
  check('J20-5: a second session can bind a different computer (and it attaches)',
    await waitFor(async () => (await doctor(agentB.agent)).target === 'winbox', 8000),
    `target=${(await doctor(agentB.agent)).target}`)
  await globalTools.get('cua_vm_exec').execute({ name: 'winbox2', cmd: 'dir' }, { agent: agentA.agent })
  const switched = await waitFor(async () => (await doctor(agentA.agent)).target === 'winbox2', 8000)
  check('J20-5: ...the most recent binding becomes the attached computer', switched,
    `target=${(await doctor(agentA.agent)).target}`)
  const crossGuard = agentB.guards[0]({ name: 'mcp__windows__tool_click_at', agent: agentB.agent })
  check('J20-5: session B is refused with code not-the-target, not "grant-off"/"reveal-required"',
    crossGuard?.info?.code === 'not-the-target', String(crossGuard?.reason ?? '').split('\n')[1])
  check('J20-5: ...the reason names BOTH computers and the fix ("bind this session first")',
    /this session is bound to winbox; the Windows bridge is attached to winbox2; bind this session first/u.test(crossGuard?.reason ?? ''),
    String(crossGuard?.reason ?? '').split('\n')[2])
  check("J20-5: ...and B's bridge names stay hidden (19 denied), so the mismatch is a list, not one call at a time",
    agentB.denied().length === 19 && prefixed().every((name) => agentB.denied().includes(name)),
    `denied=${agentB.denied().length} attached=${prefixed().length}`)

  // ---- J20-5: THE ONE DECLARED RELAXATION, AND ITS WITHDRAWAL ----
  //
  // `implicit-single-target`: when exactly ONE Windows computer is known and this
  // session never bound anything, it may use it — recorded in the doctor, never
  // silent. A second computer withdraws the allowance.
  const agentC = makeAgent('session-C')
  for (const fn of handlers.get('agent/created') ?? []) fn({ agent: agentC.agent })
  const dropWinbox = await post('/cua', { name: 'winbox' })
  check('J20-5: deleting winbox is answered by the route (binding B goes with it)',
    dropWinbox.status === 200 && dropWinbox.body.ok === true, JSON.stringify(dropWinbox.body).slice(0, 140))
  // Exactly one computer exists, and the registry says so (the live count, not a guess).
  listRegistry = { winbox2: { kind: 'windows', state: 'ready' } }
  const stateOne = await post('/cua/state', {})
  check('J20-5: the registry snapshot was refreshed through the page API (one computer)',
    stateOne.status === 200 && Object.keys(stateOne.body.vms ?? {}).length === 1,
    JSON.stringify(Object.keys(stateOne.body.vms ?? {})))
  const singleViewer = (await doctor(agentC.agent)).viewer
  check('J20-5: a never-bound session may use the ONLY computer, via implicit-single-target',
    singleViewer.match === true && singleViewer.via === 'implicit-single-target' && singleViewer.code === null,
    JSON.stringify(singleViewer))
  const implicitRecorded = (await doctor(agentC.agent)).implicitTarget
  check('J20-5: ...and the doctor RECORDS the relaxation (session + computer count)',
    implicitRecorded.active === true && implicitRecorded.reason === 'implicit-single-target'
    && implicitRecorded.computers.length === 1 && implicitRecorded.sessions.includes('session-C'),
    JSON.stringify(implicitRecorded))

  rows.set('winbox', { kind: 'windows', state: 'ready', ssh: true, sshPort: 47101 })
  listRegistry = { winbox: { kind: 'windows', state: 'ready' }, winbox2: { kind: 'windows', state: 'ready' } }
  const stateTwo = await post('/cua/state', {})
  const withdrawnViewer = (await doctor(agentC.agent)).viewer
  check('J20-5: a SECOND computer withdraws the allowance (not-the-target again)',
    stateTwo.status === 200 && withdrawnViewer.match === false && withdrawnViewer.code === 'not-the-target'
    && /this session is bound to nothing; the Windows bridge is attached to winbox2; bind this session first/u.test(withdrawnViewer.reason ?? ''),
    JSON.stringify(withdrawnViewer).slice(0, 240))
  check('J20-5: ...the doctor shows both computers, so "why did it stop working" is answerable',
    (await doctor(agentC.agent)).implicitTarget.computers.length === 2)

  /* ================================================================== *
   * (k)-(p) — ATTACHING IS A STATE, NOT A FAILURE (WP-5.1-5.6, §4.7)
   *
   * THE DEFECT. `targetMatchFor()` answered `not-the-target` + "no Windows
   * computer is attached to this bridge right now" for BOTH "nothing is
   * attached" and "an attach is in flight". A model that called the doctor one
   * second after `cua_vm_start` therefore read a permanent failure and gave up
   * on a computer that was still coming up. `attaching` is the state between
   * those two answers; `not-the-target` keeps its exact text for the case that
   * really has nothing attached — checks (d) and J20-5 above are the control.
   *
   * THE WINDOW IS REAL, NOT SIMULATED. `fake.holdConnect()` parks the next
   * `connect()` on a promise (the same seam J20-4 uses), so the ticket, the
   * generation and the elapsed time are the plugin's own.
   *
   * PENDING vs FAILING. A check whose verdict needs a field WP-5 adds is PENDING
   * (loudly) while the field is ABSENT — never because a value is wrong: a
   * present field with the wrong value FAILS. `DSH_CUA_CONTRACT_STRICT=1` turns
   * every pending into a failure, which is the T2 mutation check.
   * ================================================================== */
  const CONTRACT_NOTES = {
    tool_open_application: 'Contract: returns when Windows ACCEPTED the launch, not when a window appeared — poll tool_list_windows and dedupe by pid before retrying, or a retry starts a second instance.',
    tool_send_keys: 'Contract: success means the keys were injected into the FOREGROUND window, not that the app acted on them (this receipt has no effect_verified) — confirm with tool_capture_window or a tool_list_windows read-back before assuming it worked.',
    tool_capture_window: 'Contract: an EMPTY save_path writes under %TEMP%\\win32_mcp_shots (that is the default, not a redirect); a non-empty save_path that cannot be written FAILS with PermissionError and does not fall back — use C:\\cua-work\\... inside the guest.'
  }
  const TARGET_NAME = 'winbox3'
  /** `JSON.stringify(undefined)` is `undefined` — never call `.slice` on it. */
  const brief = (value, n = 140) => String(JSON.stringify(value) ?? 'undefined').slice(0, n)
  const guestDescriptionOf = (guest) => fake.GUEST_TOOLS.find((tool) => tool.name === guest)?.description ?? ''
  const registeredDescription = (guest) => String(globalTools.get(`mcp__windows__${guest}`)?.description ?? '')

  rows.set('winbox3', { kind: 'windows', state: 'ready', ssh: true, sshPort: 47103 })
  rows.set('winbox4', { kind: 'windows', state: 'ready', ssh: true, sshPort: 47104 })
  listRegistry = { winbox3: { kind: 'windows', state: 'ready' }, winbox4: { kind: 'windows', state: 'ready' } }
  await post('/cua/state', {})
  // Session B takes winbox4 and attaches there FIRST, so the mismatch below is
  // a real one: two computers exist and the two sessions own different ones.
  await globalTools.get('cua_vm_exec').execute({ name: 'winbox4', cmd: 'dir' }, { agent: agentB.agent })
  const boundB = await waitFor(async () => (await doctor(agentB.agent)).target === 'winbox4', 8000)
  check('(k) setup: session B is bound to winbox4 and the bridge is attached there',
    boundB, `target=${(await doctor(agentB.agent)).target}`)
  const attachGate = fake.holdConnect()
  await globalTools.get('cua_vm_exec').execute({ name: 'winbox3', cmd: 'dir' }, { agent: agentA.agent })
  let attachingSeen = false
  for (let i = 0; i < 80 && !attachingSeen; i += 1) {
    lastDoctor = await doctor(agentA.agent)
    attachingSeen = lastDoctor.attach?.pendingName === TARGET_NAME && lastDoctor.attach?.pendingDead === false
    if (!attachingSeen) await sleep(100)
  }
  check('(k) setup: the attach to winbox3 is in flight (the handshake is held open)',
    attachingSeen && fake.connectHeld() && prefixed().length === 0,
    `held=${fake.connectHeld()} pending=${JSON.stringify(lastDoctor.attach)} names=${prefixed().length}`)
  // THE FIELD'S PRESENCE IS THE LANDED FLAG — never its value. WP-5.4 adds these
  // two fields to `attach`; until they exist the checks below are PENDING, and
  // the moment they exist with a wrong value they FAIL.
  const ATTACH_LANDED = Object.hasOwn(lastDoctor.attach ?? {}, 'retryAfterMs')
    || Object.hasOwn(lastDoctor.attach ?? {}, 'pendingSinceMs')
  const heldDoctor = await freshDoctor()
  const heldViewer = heldDoctor.viewer ?? {}
  const heldAttach = heldDoctor.attach ?? {}
  checkContract('(k) during a held attach the doctor says `attaching`, not `not-the-target`',
    ATTACH_LANDED,
    heldViewer.code === 'attaching'
      && heldAttach.pendingName === TARGET_NAME
      && Number.isFinite(heldAttach.retryAfterMs) && heldAttach.retryAfterMs >= 1000 && heldAttach.retryAfterMs <= 20000
      && Number.isFinite(heldAttach.pendingSinceMs) && heldAttach.pendingSinceMs >= 0
      && /attaching to winbox3/u.test(String(heldDoctor.verdict ?? '')),
    `viewer=${JSON.stringify(heldViewer)} attach=${JSON.stringify(heldAttach)} verdict=${String(heldDoctor.verdict ?? '').slice(0, 140)}`)
  // ONE STORY, NOT TWO (JURY co-juror-1 defect 2): the attaching sentence must
  // REPLACE the "nothing is attached; start the computer" base, not follow it —
  // a verdict that says both is how a model reads "permanent failure, and also
  // wait". `attaching.text` is still allowed to repeat the name; the BASE is what
  // this asserts.
  checkContract('(k) ...and the verdict is ONE story: `attaching` replaces the "not attached" base',
    ATTACH_LANDED,
    String(heldDoctor.verdict ?? '').startsWith('attaching:')
    && /dialling winbox3/u.test(String(heldDoctor.verdict ?? ''))
    && !/ok: not attached and no prefixed schema is leaked/u.test(String(heldDoctor.verdict ?? '')),
    String(heldDoctor.verdict ?? '').slice(0, 160))
  // (l) THE GUARD, and its SCOPING. The attaching branch must be reachable from
  // the dispatch veto (the model calls the tool, not the doctor) and must NOT
  // swallow a session that is bound somewhere else: that session's refusal is
  // the pre-existing `vm-offline` here (the bridge is down during the hold) and
  // the exact `not-the-target` sentence once attached (asserted after release).
  const attachingGuard = agentA.guards[0]({ name: 'mcp__windows__tool_click_at', agent: agentA.agent })
  checkContract('(l) the guard answers `attaching` for the session bound to the pending name',
    ATTACH_LANDED,
    attachingGuard?.info?.code === 'attaching'
      && /attaching to winbox3/u.test(String(attachingGuard?.reason ?? ''))
      && /retry in ~\d+s/u.test(String(attachingGuard?.reason ?? '')),
    `code=${attachingGuard?.info?.code} why=${String(attachingGuard?.reason ?? '').split('\n')[1] ?? ''}`)
  const otherGuard = agentB.guards[0]({ name: 'mcp__windows__tool_click_at', agent: agentB.agent })
  checkContract('(l) ...and a session bound to ANOTHER computer is not told "attaching" (its refusal is unchanged)',
    ATTACH_LANDED,
    otherGuard?.info?.code === 'vm-offline',
    `code=${otherGuard?.info?.code} why=${String(otherGuard?.reason ?? '').split('\n')[1] ?? ''}`)
  // (m) THE REVEAL. A hidden inventory plus a code is the honest answer; 19
  // names that refuse one by one is not.
  const heldReveal = await desktop(agentA.agent)
  checkContract('(m) windows_desktop during the hold answers `attaching` with an EMPTY inventory',
    ATTACH_LANDED,
    heldReveal.code === 'attaching' && heldReveal.revealed === false
      && Array.isArray(heldReveal.tools) && heldReveal.tools.length === 0
      && /attaching|in flight|handshake/iu.test(String(heldReveal.note ?? '')),
    JSON.stringify({ code: heldReveal.code, revealed: heldReveal.revealed, tools: heldReveal.tools?.length, note: String(heldReveal.note ?? '').slice(0, 120) }))
  // (n) THE RELEASE: the state is temporary by construction, and the mismatch
  // that really exists keeps the byte-exact sentence from today.
  attachGate.release()
  const attachedAgain = await waitFor(() => prefixed().length === 19, 10000)
  const settledDoctor = await freshDoctor()
  checkContract('(n) releasing the handshake clears `attaching` (the attach completes with 19 names)',
    ATTACH_LANDED,
    attachedAgain && (settledDoctor.viewer?.code ?? null) !== 'attaching'
      && settledDoctor.viewer?.match === true
      && (settledDoctor.attach?.pendingName ?? null) === null,
    `names=${prefixed().length} viewer=${JSON.stringify(settledDoctor.viewer)} attach=${JSON.stringify(settledDoctor.attach)}`)
  const crossAfter = agentB.guards[0]({ name: 'mcp__windows__tool_click_at', agent: agentB.agent })
  check('(n) ...and the mismatch that really exists still gets the EXACT `not-the-target` sentence',
    crossAfter?.info?.code === 'not-the-target'
      && /this session is bound to winbox4; the Windows bridge is attached to winbox3; bind this session first/u.test(String(crossAfter?.reason ?? '')),
    `code=${crossAfter?.info?.code} why=${String(crossAfter?.reason ?? '').split('\n')[2] ?? ''}`)
  // (o) THE THREE CONTRACT NOTES (Appendix C, frozen), plus the CONTROL: every
  // other description must stay byte-identical to the shipped sentence, which is
  // what proves the change is scoped to three tools.
  // WP-5.7 APPENDS the notes; WP-4.4 owns the table. The landed flag is the
  // WP-5 surface (`attach.retryAfterMs`), so a tree where only the TABLE has
  // landed is PENDING rather than a red for a file that has not been edited yet.
  const CONTRACT_LANDED = ATTACH_LANDED
  checkContract('(o) the three Appendix C notes are appended verbatim, before the "(dsh-cua, Windows computer …)" suffix',
    CONTRACT_LANDED,
    Object.keys(CONTRACT_NOTES).every((guest) => registeredDescription(guest)
      === `${guestDescriptionOf(guest)} ${CONTRACT_NOTES[guest]} (dsh-cua, Windows computer ${TARGET_NAME})`),
    Object.keys(CONTRACT_NOTES).filter((guest) => registeredDescription(guest)
      !== `${guestDescriptionOf(guest)} ${CONTRACT_NOTES[guest]} (dsh-cua, Windows computer ${TARGET_NAME})`).join(',') || 'all three exact')
  checkContract('(o) ...and every OTHER description is byte-identical to `<guest description> (dsh-cua, Windows computer <name>)`',
    CONTRACT_LANDED,
    fake.GUEST_TOOLS.filter((tool) => !Object.hasOwn(CONTRACT_NOTES, tool.name))
      .every((tool) => registeredDescription(tool.name) === `${tool.description} (dsh-cua, Windows computer ${TARGET_NAME})`),
    `${fake.GUEST_TOOLS.length - Object.keys(CONTRACT_NOTES).length} control description(s)`)
  checkContract('(o) ...and the module table IS those three sentences (a divergent string is a red, not a new baseline)',
    CONTRACT_LANDED,
    Object.keys(realWinMcp.WINDOWS_TOOL_CONTRACT ?? {}).length === 3
      && Object.keys(CONTRACT_NOTES).every((guest) => realWinMcp.WINDOWS_TOOL_CONTRACT?.[guest] === CONTRACT_NOTES[guest]),
    JSON.stringify(Object.keys(realWinMcp.WINDOWS_TOOL_CONTRACT ?? {})))
  // (p) THE DESKTOP FACTS IN THE VERDICT. `measured:false` must never read as
  // "false"; a measured dead lane and an unwritable work dir are sentences with
  // a next action, not a silent `ok`.
  const DESKTOP_LANDED = Object.hasOwn(settledDoctor, 'desktop')
  fake.setDesktopFacts({ win32ui: false, elementLaneOk: false })
  const deadDoctor = await freshDoctor()
  checkContract('(p) a measured DEAD element lane is a verdict warning naming the fallback',
    DESKTOP_LANDED,
    deadDoctor.desktop?.measured === true && deadDoctor.desktop?.elementLaneOk === false
      && /element lane is DEAD/iu.test(String(deadDoctor.verdict ?? ''))
      && /tool_click_at/u.test(String(deadDoctor.verdict ?? '')),
    `desktop=${brief(deadDoctor.desktop)} verdict=${String(deadDoctor.verdict ?? '').slice(0, 140)}`)
  fake.setDesktopFacts({ workDirWritable: false })
  const noWriteDoctor = await freshDoctor()
  checkContract('(p) an unwritable work dir names the path to use (and the %TEMP% fallback) instead of pretending',
    DESKTOP_LANDED,
    noWriteDoctor.desktop?.workDirWritable === false
      && /C:\\cua-work/u.test(String(noWriteDoctor.verdict ?? ''))
      && /win32_mcp_shots|TEMP/iu.test(String(noWriteDoctor.verdict ?? '')),
    `desktop=${brief(noWriteDoctor.desktop)} verdict=${String(noWriteDoctor.verdict ?? '').slice(0, 140)}`)
  // THE ROLLBACK CASE IS NOT A SILENT PASS (writer A's shipped shape): a
  // `skipped:<why>` scaleFix means the arithmetic is UNPATCHED — including when
  // the patch was rolled back because the import/probe failed — so the scale
  // warning must stay active and name the value.
  fake.setDesktopFacts({ scaleFix: 'skipped:write-failed' })
  const skippedDoctor = await freshDoctor()
  checkContract('(p) a `skipped:<why>` scaleFix keeps the scale warning ACTIVE (a rolled-back patch is not applied)',
    DESKTOP_LANDED,
    skippedDoctor.desktop?.scaleFix === 'skipped:write-failed'
    && /scaleFix:skipped:write-failed/u.test(String(skippedDoctor.verdict ?? ''))
    && /do not click from image pixels/u.test(String(skippedDoctor.verdict ?? '')),
    `scaleFix=${skippedDoctor.desktop?.scaleFix} verdict=${String(skippedDoctor.verdict ?? '').slice(-140)}`)
  fake.resetDesktopFacts()
  // THE BLOCK HANDS J20-4 A KNOWN BOARD: winbox4 (session B's) is deleted so its
  // binding cannot resurrect an attach, and the bridge stays ATTACHED to winbox3
  // — J20-4's own switch to winbox2 then has a live attach to tear down first,
  // which is exactly the state its race is about.
  await post('/cua', { name: 'winbox4' })
  rows.delete('winbox4')
  listRegistry = { winbox3: { kind: 'windows', state: 'ready' } }
  await post('/cua/state', {})
  const blockBoardOk = await waitFor(() => prefixed().length === 19, 5000)
  check('(k)-(p) the block hands the suite back a live attach (winbox3, 19 names)',
    blockBoardOk && (await freshDoctor()).target === 'winbox3',
    `names=${prefixed().length} target=${lastDoctor.target}`)
  // ---- THE TEARDOWN FORGETS THE FACTS (JURY co-juror-1 defect 3, plugin half) ----
  //
  // `desktop` was MEASURED for winbox3. Once that computer is destroyed its
  // facts belong to nobody: a doctor that keeps serving them is how winbox3's
  // `win32ui:false` (or its writable work dir) becomes a claim about the next
  // computer that reuses the name and the port.
  const beforeTeardown = await freshDoctor()
  await post('/cua', { name: 'winbox3' })
  rows.delete('winbox3')
  // EITHER `null` (never measured in this process) OR the honest unmeasured
  // shape — what must NOT survive is a MEASURED copy: `measured:true` with
  // `win32ui`/`workDir` filled in is winbox3's truth wearing the next
  // computer's name.
  const factsForgotten = (desktop) => desktop === null
    || (desktop?.measured === false && desktop?.win32ui === null && desktop?.workDir === null
      && desktop?.elementLaneOk === null && desktop?.scaleFix === null)
  const teardownCleared = await waitFor(async () => factsForgotten((await freshDoctor()).desktop), 8000)
  checkContract('(k)-(p) destroying the computer forgets its desktop facts (no measured copy survives)',
    DESKTOP_LANDED,
    beforeTeardown.desktop?.measured === true && teardownCleared,
    `before.measured=${beforeTeardown.desktop?.measured} after=${JSON.stringify((await freshDoctor()).desktop)?.slice(0, 120)}`)

  // ---- J20-4: THE DELETE THAT LANDS MID-HANDSHAKE ----
  //
  // The reported race: WIN_MCP.name is '' for an attach that is still in its
  // handshake, so a delete skipped teardown and the attach registered 19 schemas
  // of a computer that no longer existed. The ticket carries the name for exactly
  // that window and is killed by teardown; every write re-checks the generation.
  const preRace = await post('/cua', { name: 'winbox2' })
  check('J20-4: the board is cleared before the race (winbox2 deleted)',
    preRace.status === 200 && preRace.body.ok === true, JSON.stringify(preRace.body).slice(0, 110))
  rows.set('winbox2', { kind: 'windows', state: 'ready', ssh: true, sshPort: 47102 })
  listRegistry = { winbox2: { kind: 'windows', state: 'ready' } }
  const gate = fake.holdConnect()
  await globalTools.get('cua_vm_exec').execute({ name: 'winbox2', cmd: 'dir' }, { agent: agentA.agent })
  let heldSeen = false
  for (let i = 0; i < 80 && !heldSeen; i += 1) {
    const state = await freshDoctor()
    heldSeen = state.attach?.pendingName === 'winbox2' && state.attach?.pendingDead === false
    if (!heldSeen) await sleep(100)
  }
  check('J20-4: the attach really is in flight (the handshake is held open)',
    heldSeen && fake.connectHeld() && prefixed().length === 0,
    `held=${fake.connectHeld()} pending=${JSON.stringify(lastDoctor.attach)} names=${prefixed().length}`)
  const generationBefore = lastDoctor.attach.generation
  const duringDelete = await post('/cua', { name: 'winbox2' })
  check('J20-4: deleting the computer DURING the handshake is answered by the route',
    duringDelete.status === 200 && duringDelete.body.ok === true, JSON.stringify(duringDelete.body).slice(0, 120))
  const attachAfterDelete = (await freshDoctor()).attach
  check('J20-4: ...and it kills the in-flight ticket, which the name alone could not have named',
    attachAfterDelete.pendingName === 'winbox2' && attachAfterDelete.pendingDead === true,
    JSON.stringify(attachAfterDelete))
  check('J20-4: ...the generation was bumped, so ANY late write is already dead',
    attachAfterDelete.generation > generationBefore,
    `${generationBefore} -> ${attachAfterDelete.generation}`)
  gate.release()
  await sleep(800)
  check('J20-4: when the handshake finally returns, ZERO registrations are resurrected',
    prefixed().length === 0, `${prefixed().length} name(s)`)
  const attachSettled = (await freshDoctor()).attach
  check('J20-4: ...the dead ticket does not linger as "pending"',
    attachSettled.pendingName === null && attachSettled.pendingDead === null,
    JSON.stringify(attachSettled))
  await sleep(1200)
  check('J20-4: ...and a later poll beat cannot attach a computer that no longer exists',
    prefixed().length === 0 && lastDoctor.target === null, `${prefixed().length} / target=${lastDoctor.target}`)

  // ---- the teardown path is idempotent, and the plugin dispose is a teardown ----
  const disposedPrefix = disposed.filter((name) => name.startsWith('mcp__windows__')).length
  for (const dispose of effects.reverse()) { try { dispose() } catch { /* already gone */ } }
  const disposedAfter = disposed.filter((name) => name.startsWith('mcp__windows__')).length
  check('plugin dispose leaves no bridged schema and re-disposes no prefixed name',
    prefixed().length === 0 && disposedAfter === disposedPrefix,
    `left=${prefixed().length} extraPrefixDisposals=${disposedAfter - disposedPrefix}`)
  check('...and removes the two ungated helpers it registered',
    globalTools.has('windows_desktop') === false && globalTools.has('windows_mcp_doctor') === false)

  // ---- the supervisor ops the bridge used, as a shape assertion ----
  //
  // The name is REQUIRED on every state read: an empty one would be "the first
  // ready row" wearing a parameter, which is the bug this branch removed.
  const stateReads = supervisorOps.filter((entry) => entry.op === 'vmWindowsMcpState')
  check('the bridge asked the supervisor for state by NAME on every probe (never an empty name)',
    stateReads.length > 0 && stateReads.every((entry) => String(entry.name ?? '') !== ''),
    `${stateReads.length} read(s): ${stateReads.map((entry) => entry.name).slice(0, 4).join(',')}`)
} catch (error) {
  failures += 1
  console.log(` FAIL harness: ${error?.stack ?? error}`)
} finally {
  for (const row of [...rows.keys()]) rows.delete(row)
  await new Promise((resolve) => server.close(resolve))
  try { rmSync(path.dirname(SOCK), { recursive: true, force: true }) } catch {}
}

console.log(failures === 0 ? '\nwindows mcp gate: PASS' : `\nwindows mcp gate: ${failures} FAILURE(S)`)
if (pendings > 0) {
  console.log(`windows mcp gate: ${pendings} check(s) PENDING — the production field is absent (SOL WP-3).`)
  console.log('  These are assertions, not skips: they go red the moment the field exists with a wrong value.')
  console.log('  Run with DSH_CUA_CONTRACT_STRICT=1 to require them now (the T2 mutation check).')
}
process.exit(failures === 0 ? 0 : 1)
