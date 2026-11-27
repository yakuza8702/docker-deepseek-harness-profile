/**
 * 20-supervisor-window-and-relay.mjs — withDeadline, bannerProbe and the state-hold table.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { REPO, bannerProbe, check, mkdtempSync, net, os, path, readFileSync, rmSync, spawnSync } from './harness.mjs'



/* ====================================================================== *
 * F2 — `withDeadline`, THE INSTALL WATCH'S PER-TICK BUDGET.
 *
 * The 2026-11-21 wedge was an `await` with no settling path (`bannerProbe` on a
 * peer that accepted and closed), awaited while the tick held the lifecycle
 * lock. F1 fixes that probe; F2 is the answer to the NEXT one: the budget is a
 * HARD deadline on the await, whatever it awaits.
 *
 * The helper is extracted from the supervisor the same way this file already
 * exercises swappable window code (`new Function`), because the supervisor is a
 * process, not a library — and the properties below are exactly the ones the
 * loop depends on:
 *   * expiry resolves the FALLBACK (and never throws — the watch's tail `catch`
 *     is fatal to the watch),
 *   * a late settlement is DISCARDED, including a late rejection (an unhandled
 *     rejection ends the process, which is worse than the wedge),
 *   * a rejection BEFORE the budget is reported through the fallback with the
 *     error, so a probe that panics is not silently labelled "budget expired",
 *   * the timer is cleared, so an answered probe does not pay the budget.
 * ====================================================================== */
{
  const supervisorSource = readFileSync(path.join(REPO, 'docker', 'cua-vm-supervisor.mjs'), 'utf8')
  const extract = (signature) => {
    const start = supervisorSource.indexOf(signature)
    const end = start === -1 ? -1 : supervisorSource.indexOf('\n}\n', start)
    if (start === -1 || end === -1) return ''
    return supervisorSource.slice(start, end + 3)
  }
  const withDeadlineSource = extract('function withDeadline(pending, budgetMs, fallback) {')
  const budgetSource = extract('function installTickBudgetMs() {')
  const load = (source, name) => {
    if (source === '') return null
    try {
      return new Function(`${source}\nreturn ${name}`)()
    } catch {
      return null
    }
  }
  const withDeadline = load(withDeadlineSource, 'withDeadline')
  const installTickBudgetMs = load(budgetSource, 'installTickBudgetMs')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  check('F2: the supervisor defines withDeadline(pending, budgetMs, fallback) and installTickBudgetMs() (the helper is extractable, so it has no hidden dependencies)',
    withDeadline !== null && installTickBudgetMs !== null,
    `withDeadline=${withDeadline !== null} installTickBudgetMs=${installTickBudgetMs !== null}`)

  // (1) THE BUDGET IS A DEADLINE, AND EXPIRY IS A VERDICT — NOT A THROW.
  const never = new Promise(() => {})
  const startedAt = Date.now()
  const expired = withDeadline === null ? { harness: 'missing' } : await withDeadline(never, 120, () => ({ ready: false, alive: true, budgetExpired: true }))
  const expiredMs = Date.now() - startedAt
  check('F2: a promise that NEVER settles resolves the fallback verdict at the budget (a budget expiry is a verdict, not a throw — the watch continues)',
    expired?.budgetExpired === true && expiredMs >= 100 && expiredMs <= 1500,
    `${expiredMs} ms ${JSON.stringify(expired)}`)

  // (2) A LATE SETTLEMENT IS DISCARDED — VALUE OR REJECTION.
  let unhandled = 0
  const onUnhandled = () => { unhandled += 1 }
  process.on('unhandledRejection', onUnhandled)
  const lateValue = new Promise((resolve) => setTimeout(() => resolve('late value'), 260))
  const lateRejection = new Promise((resolve, reject) => setTimeout(() => reject(new Error('late rejection')), 260))
  const firstAnswer = withDeadline === null ? null : await withDeadline(lateValue, 80, () => 'fallback')
  const secondAnswer = withDeadline === null ? null : await withDeadline(lateRejection, 80, () => 'fallback')
  await sleep(400)
  process.off('unhandledRejection', onUnhandled)
  check('F2: a promise that settles AFTER the budget is discarded (both its value and its rejection), and a late rejection never becomes an unhandled rejection',
    firstAnswer === 'fallback' && secondAnswer === 'fallback' && unhandled === 0,
    `value=${JSON.stringify(firstAnswer)} rejection=${JSON.stringify(secondAnswer)} unhandled=${unhandled}`)

  // (3) A PANIC BEFORE THE BUDGET IS NOT A BUDGET EXPIRY.
  const panicked = withDeadline === null
    ? null
    : await withDeadline(Promise.reject(new Error('probe panicked')), 5000, (why) => ({
      expired: why?.expired === true,
      message: why?.error?.message ?? String(why?.error)
    }))
  check('F2: a rejection BEFORE the budget answers the fallback with { expired: false, error } — a probe that panicked is never labelled "budget expired"',
    panicked?.expired === false && /probe panicked/u.test(String(panicked?.message)),
    JSON.stringify(panicked))

  // (4) AN ANSWERED PROBE DOES NOT PAY THE BUDGET.
  const quickFrom = Date.now()
  const quick = withDeadline === null ? null : await withDeadline(Promise.resolve('answered'), 20_000, () => 'fallback')
  const quickMs = Date.now() - quickFrom
  check('F2: a probe that answers resolves at once (the budget timer is cleared, so a fast tick is not held to the deadline)',
    quick === 'answered' && quickMs < 1000,
    `${quickMs} ms ${JSON.stringify(quick)}`)

  // (5) THE KNOB: UNSET IS NOT ZERO (the module's read-once-the-raw-string rule).
  const savedBudget = process.env.DSH_CUA_INSTALL_TICK_BUDGET_MS
  const budgets = []
  try {
    delete process.env.DSH_CUA_INSTALL_TICK_BUDGET_MS
    budgets.push(installTickBudgetMs?.())
    process.env.DSH_CUA_INSTALL_TICK_BUDGET_MS = '1500'
    budgets.push(installTickBudgetMs?.())
    process.env.DSH_CUA_INSTALL_TICK_BUDGET_MS = ''
    budgets.push(installTickBudgetMs?.())
    process.env.DSH_CUA_INSTALL_TICK_BUDGET_MS = 'nonsense'
    budgets.push(installTickBudgetMs?.())
  } finally {
    if (savedBudget === undefined) delete process.env.DSH_CUA_INSTALL_TICK_BUDGET_MS
    else process.env.DSH_CUA_INSTALL_TICK_BUDGET_MS = savedBudget
  }
  check('F2: DSH_CUA_INSTALL_TICK_BUDGET_MS defaults to 20 000 with the variable UNSET or empty (an unset knob is never a zero-second budget) and honours a finite value',
    budgets[0] === 20000 && budgets[1] === 1500 && budgets[2] === 20000 && budgets[3] === 20000,
    JSON.stringify(budgets))
}

/* ====================================================================== *
 * F1 — `bannerProbe` ANSWERS ON EVERY PEER, INCLUDING THE ONE THAT SAYS
 * NOTHING. THIS IS THE RED-ON-REVERT PIN F1 WAS MISSING.
 *
 * The 79-minute wedge of 2026-11-21 (`vm:win-test`) was ONE await with no
 * settling path: QEMU's slirp host-forward ACCEPTS the SSH port, cannot reach
 * the guest (OpenSSH is installed by the answer file after the image copy) and
 * closes the socket without a byte. `bannerProbe` had `socket.setTimeout()` —
 * an IDLE timer libuv drops the moment the stream closes — and resolved only on
 * 'data', 'timeout' and 'error'. An accept-then-FIN peer emits 'end'/'close'
 * and never 'error', so the promise stayed PENDING FOR THE LIFE OF THE PROCESS
 * and the install watch, which awaited it under the lifecycle key, held
 * `vm:<name>` for 79 minutes (the install had finished at 16:35:52; the guest
 * powered off at 17:05:18).
 *
 * F2 bounds the observer's tick, F3 stops the tick holding the key — neither of
 * them makes THIS function settle, and the live `windowsStart` awaits it bare,
 * under the key, in `await windowsBackend.ready(current, …)`. So the function
 * itself is pinned here, against the real export, for the five peers that
 * exist:
 *   (1) accept, then FIN, no bytes            → null, BEFORE the deadline
 *   (2) accept, then destroy, no bytes        → null, BEFORE the deadline
 *   (3) accept, say nothing, stay open        → null AT the deadline
 *   (4) speak the banner, then close          → the bytes
 *   (5) refused (nothing listening)           → null
 *
 * `Promise.race` against a harness guard is deliberate: an un-settling probe
 * must FAIL this check, not hang the suite (a hung suite is a worse witness
 * than a red one, and this file runs without a timeout).
 * ====================================================================== */
{
  const settleGuardMs = 1200
  const deadlineMs = 400
  const serve = async (onSocket) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {})
      onSocket(socket)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
      port: server.address().port,
      close: () => new Promise((resolve) => { try { server.close(resolve) } catch { resolve() } })
    }
  }
  const closedPort = async () => {
    const server = net.createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    await new Promise((resolve) => server.close(resolve))
    return port
  }
  const probe = async (port) => {
    const from = Date.now()
    const answer = await Promise.race([
      bannerProbe('127.0.0.1', port, { timeoutMs: deadlineMs }).then((value) => ({ settled: true, value })),
      new Promise((resolve) => setTimeout(() => resolve({ settled: false, value: 'HARNESS-GUARD' }), deadlineMs + settleGuardMs))
    ])
    return { ...answer, ms: Date.now() - from }
  }

  // (1) ACCEPT, THEN FIN — the 2026-11-21 peer, exactly.
  const finPeer = await serve((socket) => { try { socket.end() } catch {} })
  let fin
  try { fin = await probe(finPeer.port) } finally { await finPeer.close() }
  check('F1: bannerProbe answers a peer that ACCEPTS and then FINs without a byte — null, and BEFORE its deadline (the peer FIN is an answer; the idle timer never fires because the stream is closed)',
    fin.settled === true && fin.value === null && fin.ms < deadlineMs + 250,
    `${fin.ms} ms settled=${fin.settled} value=${JSON.stringify(fin.value)} deadline=${deadlineMs} ms`)

  // (2) ACCEPT, THEN DESTROY — the other half-close shape (a proxy in front of
  // the port does this). Also 'close', never 'error'.
  const destroyPeer = await serve((socket) => { try { socket.destroy() } catch {} })
  let destroyed
  try { destroyed = await probe(destroyPeer.port) } finally { await destroyPeer.close() }
  check('F1: bannerProbe answers a peer that ACCEPTS and then DESTROYS the socket without a byte — null, and BEFORE its deadline (close is not error)',
    destroyed.settled === true && destroyed.value === null && destroyed.ms < deadlineMs + 250,
    `${destroyed.ms} ms settled=${destroyed.settled} value=${JSON.stringify(destroyed.value)}`)

  // (3) ACCEPT, SAY NOTHING, STAY OPEN — the deadline is the answer, and it is
  // the PROBE's deadline (the hard timer), not the harness's guard.
  const silentPeer = await serve(() => {})
  let silent
  try { silent = await probe(silentPeer.port) } finally { await silentPeer.close() }
  check('F1: a peer that accepts and stays silent answers null AT the deadline (the hard timer, armed before connect — the probe\'s own budget, not the caller\'s patience)',
    silent.settled === true && silent.value === null && silent.ms >= deadlineMs - 50 && silent.ms < deadlineMs + 250,
    `${silent.ms} ms settled=${silent.settled} value=${JSON.stringify(silent.value)}`)

  // (4) SPEAK, THEN CLOSE — the GOOD peer: the banner is the answer and it is
  // NOT truncated to nothing or replaced by the close that follows it.
  const banner = 'SSH-2.0-unit-stub\r\n'
  const bannerPeer = await serve((socket) => { try { socket.write(banner) } catch {} })
  let spoke
  try { spoke = await probe(bannerPeer.port) } finally { await bannerPeer.close() }
  check('F1: a peer that SPEAKS and then closes answers the bytes (the banner wins; the close that follows it does not overwrite the answer)',
    spoke.settled === true && String(spoke.value ?? '').startsWith('SSH-2.0-unit-stub'),
    `${spoke.ms} ms settled=${spoke.settled} value=${JSON.stringify(spoke.value)}`)

  // (5) NOTHING LISTENING — refused is an answer too.
  const nothing = await closedPort()
  const refused = await probe(nothing)
  check('F1: a refused port answers null (nothing listening is an answer, not a wait)',
    refused.settled === true && refused.value === null && refused.ms < deadlineMs + 250,
    `${refused.ms} ms settled=${refused.settled} value=${JSON.stringify(refused.value)}`)
}



// ------------------------------------------------------------------ *
// C4 + C18 — THE TWO COMPUTED FACTS ON A STATUS READ
// ------------------------------------------------------------------ *
//
// `stateHolds` and `computerHealth` are exported from the supervisor, so they are
// asserted against the REAL module (imported in a child with a throwaway store,
// like parseGuestDf/buildScpArgv above — this suite must never bind the
// supervisor's socket).
{
  const store = mkdtempSync(path.join(os.tmpdir(), 'cua-holds-unit-'))
  try {
    const supervisorUrl = new URL('../../docker/cua-vm-supervisor.mjs', import.meta.url).href
    const program = `const m = await import(${JSON.stringify(supervisorUrl)});`
      + `const states = ['ready','running','installing','booting','suspended','powered-off','off','stopped','error','missing'];`
      + `const holds = Object.fromEntries(states.map((state) => [state, m.stateHolds(state)]));`
      + `holds.nonsense = m.stateHolds('nonsense'); holds.undefined = m.stateHolds(undefined);`
      + `const ready = { kind: 'windows', state: 'ready', stateStale: false, stateAgeMs: 1000, lock: null, gpuDegraded: null, share: 'attached', restoreFrom: { kind: 'checkpoint' }, isoSourceId: 'mido', isoMedia: 'chain' };`
      + `const facts = { ageMs: 1000, stale: false, windowMs: 120000, source: 'probe', confirmedAt: null };`
      + `const rows = {`
      + ` ready: m.computerHealth('vm', ready, facts),`
      + ` stale: m.computerHealth('vm', { ...ready, stateStale: true }, { ...facts, ageMs: 300000, stale: true }),`
      + ` image: m.computerHealth('vm', { ...ready, state: 'powered-off', restoreFrom: { kind: 'image' } }, { ageMs: null, stale: false, windowMs: null }),`
      + ` pinned: m.computerHealth('vm', { ...ready, isoMedia: 'pinned', isoSourceId: 'pinned-url' }, facts),`
      + ` locked: m.computerHealth('vm', { ...ready, lock: { heldBy: 'gc:vm', heldMs: 5000, poisoned: false } }, facts),`
      + ` noAge: m.computerHealth('vm', { ...ready }, { ageMs: null, stale: false, windowMs: null, source: null, confirmedAt: null }),`
      + ` linux: m.computerHealth('vm', { kind: 'linux', state: 'ready', stateStale: false }, { ageMs: null, stale: false, windowMs: null }) };`
      + `process.stdout.write(JSON.stringify({ holds, rows }));process.exit(0)`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, CUA_VM_STORE: path.join(store, 'store'), CUA_VM_HOME: path.join(store, 'home'), CUA_SUPERVISOR_SOCK: path.join(store, 's.sock') }
    })
    let parsed = null
    try { parsed = JSON.parse(result.stdout ?? 'null') } catch { parsed = null }
    const holds = parsed?.holds ?? {}
    const rows = parsed?.rows ?? {}

    // (1) THE SIX-STATE TABLE. `error`/`missing`/anything else are NULL, never
    // false: a torn or vanished disk is not a claim about memory.
    const live = ['ready', 'running', 'installing', 'booting']
    check('C4: stateHolds says memory+disk for every live state',
      live.every((state) => holds[state]?.memory === true && holds[state]?.disk === true && holds[state]?.text === 'memory+disk'),
      live.map((state) => `${state}=${JSON.stringify(holds[state])}`).join(' '))
    check('C4: stateHolds(suspended) keeps memory AND says resume is instant',
      holds.suspended?.memory === true && holds.suspended?.disk === true && /resume is instant/u.test(String(holds.suspended?.text ?? '')),
      JSON.stringify(holds.suspended))
    check('C4: stateHolds says disk-only (checkpoint) for powered-off/off/stopped',
      ['powered-off', 'off', 'stopped'].every((state) => holds[state]?.memory === false && holds[state]?.disk === true && holds[state]?.text === 'disk only (checkpoint)'),
      ['powered-off', 'off', 'stopped'].map((state) => `${state}=${JSON.stringify(holds[state])}`).join(' '))
    check('C4: stateHolds answers null/null (unverified) for error, missing, an unknown word and undefined — never false',
      ['error', 'missing', 'nonsense', 'undefined'].every((state) => holds[state]?.memory === null && holds[state]?.disk === null && holds[state]?.text === 'unverified'),
      ['error', 'missing', 'nonsense', 'undefined'].map((state) => `${state}=${JSON.stringify(holds[state])}`).join(' '))

    // (2) THE PER-COMPUTER VERDICT.
    check('C18: a fresh ready Windows row is ok and carries no guide',
      rows.ready?.verdict === 'ok' && rows.ready?.guide === null && rows.ready?.checks?.length === 6,
      JSON.stringify(rows.ready))
    check('C18: a stale Windows row is degraded, names state-fresh and prints the frozen guide',
      rows.stale?.verdict === 'degraded'
      && rows.stale?.checks?.some((entry) => entry.id === 'state-fresh' && entry.ok === false)
      && /has not answered for \d+m/u.test(String(rows.stale?.guide ?? '')),
      `${rows.stale?.verdict} ${JSON.stringify(rows.stale?.guide)}`)
    check('C18: a powered-off row whose restoreFrom.kind is image is degraded — Start would boot the base image',
      rows.image?.verdict === 'degraded'
      && rows.image?.checks?.some((entry) => entry.id === 'restore-point' && entry.ok === false)
      && rows.image?.guide === 'Start boots the base image: the previous disk is gone',
      `${rows.image?.verdict} ${JSON.stringify(rows.image?.guide)}`)
    check('C18: a pinned medium is degraded with the pin guide; a held lock is degraded and names the holder',
      rows.pinned?.verdict === 'degraded'
      && /operator-pinned medium/u.test(String(rows.pinned?.guide ?? ''))
      && rows.locked?.verdict === 'degraded'
      && /gc:vm/u.test(String(rows.locked?.guide ?? '')),
      `${rows.pinned?.verdict}/${JSON.stringify(rows.pinned?.guide)} ${rows.locked?.verdict}/${JSON.stringify(rows.locked?.guide)}`)
    // J6: THE SENTENCE FOLLOWS THE KIND. A Windows row with no parseable
    // `stateSince` has no recorded AGE — it is not a kind without a clock, and
    // printing the Linux sentence there told an operator the wrong thing.
    const noAgeDetail = String(rows.noAge?.checks?.find((entry) => entry.id === 'state-fresh')?.detail ?? '')
    check('J6: a Windows row with no recorded age says "no confirmation age", never "this kind has no staleness clock"',
      rows.noAge?.verdict === 'ok' && noAgeDetail.includes('no confirmation age recorded') && !noAgeDetail.includes('no staleness clock'),
      noAgeDetail)
    // A NULL CHECK NEVER DEGRADES: the Linux row has no staleness clock, no
    // restore point and no medium — all null — and it is still `ok`.
    check('C18: a null check never degrades (a Linux row: three null checks, verdict ok)',
      rows.linux?.verdict === 'ok'
      && rows.linux?.checks?.filter((entry) => entry.ok === null).length >= 2
      && rows.linux?.guide === null,
      JSON.stringify(rows.linux?.checks))
    // The verdict RULE itself: any false → degraded; else any true → ok; else
    // unknown. Asserted over every row above, so collapsing `null` into
    // `false` (a nag screen) or `true` (a green lie) fails here.
    const ruleHolds = Object.values(rows).every((row) => {
      const checks = Array.isArray(row?.checks) ? row.checks : []
      const expected = checks.some((entry) => entry.ok === false) ? 'degraded' : (checks.some((entry) => entry.ok === true) ? 'ok' : 'unknown')
      return row?.verdict === expected
    })
    check('C18: the verdict rule is any-false→degraded, else any-true→ok, else unknown (null never decides)',
      ruleHolds, JSON.stringify(Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, row?.verdict]))))
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
}
