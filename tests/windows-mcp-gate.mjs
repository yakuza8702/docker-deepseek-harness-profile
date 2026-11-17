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
 *   (c) every live agent's `restrict({deny})` hides all 19 while the gate is
 *       closed;
 *   (d) `tools.guard` refuses a bridged name offline with `code: vm-offline`;
 *   (e) the pre-step self-heal clears a leaked session (names alive, client
 *       dead) and still calls `next()` exactly once.
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
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
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

  // ---- (c) the per-agent restriction hides all 19 ----
  check('(c) every live agent restrict({deny}) covers all 19 bridged names',
    [agentA, agentB].every((agent) => {
      const denied = agent.denied()
      return denied.length === 19 && prefixed().every((name) => denied.includes(name))
    }),
    `A=${agentA.denied().length} B=${agentB.denied().length}`)
  check('(c) ...and the non-bridged tools are never in a deny list',
    [agentA, agentB].every((agent) => !agent.denied().some((name) => !name.startsWith('mcp__windows__'))))

  // ---- the guard, online: the grant and the reveal are both closed ----
  const grantOff = agentA.guards[0]({ name: 'mcp__windows__tool_click_at', agent: agentA.agent })
  check('(d) online with the grant off, the guard refuses with code grant-off',
    grantOff?.info?.code === 'grant-off', String(grantOff?.reason ?? '').split('\n')[1])
  check('the guard ignores a non-bridged name entirely',
    agentA.guards[0]({ name: 'cua_vm_exec', agent: agentA.agent }) === undefined)

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
process.exit(failures === 0 ? 0 : 1)
