/**
 * 16-relay-reassert.mjs — the supervisor relay re-assert matrix (S1-S4).
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { REPO, check, mkdtempSync, os, path, readFileSync, rmSync, writeFileSync } from './harness.mjs'



// ------------------------------------------------------------------ *
// WP-4 / SOL §5 WP-4.1 — THE SUPERVISOR'S RELAY RE-ASSERT (S1-S4)
//
// THE DEFECT THIS COVERS (chief JURY finding 1: zero coverage). A checkpoint
// boot restores a DISK, not a logged-on desktop, so the supervisor can report a
// Windows row `ready` while the relay task never ran and the desktop is blind.
// `windowsRelayReassert()` is the host half of the fix: ONE `schtasks /run` at
// the moment the supervisor decides the row is ready.
//
// HOW IT IS DRIVEN WITHOUT A GUEST. The function is module-private, so this
// block imports the REAL `docker/cua-vm-supervisor.mjs` through two registered
// hooks and touches nothing else:
//
//   * a `load` hook appends ONE `export { … }` line to the source (no behaviour
//     change — the same trick a debugger uses to read a local), so the function,
//     its throttle map and its three constants are reachable;
//   * a `resolve` hook points the supervisor's `node:child_process` at a stub
//     whose `spawn` RECORDS the argv and then behaves: exit 0, exit 1 with
//     stderr, a spawn error, or a child that never closes (the 20 s timeout).
//
// The registry is a throwaway `CUA_VM_STORE`; the socket the module binds on
// import goes to that store and nobody dials it. `log()` writes to stderr, so
// stderr is captured per case — the log line IS part of the contract (S1).
// ------------------------------------------------------------------ *
{
  const { registerHooks } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const store = mkdtempSync(path.join(os.tmpdir(), 'cua-reassert-'))
  const capture = path.join(store, 'spawn.log')
  const modeFile = path.join(store, 'mode.txt')
  const registryFile = path.join(store, 'registry.json')
  const sock = path.join(store, 'supervisor.sock')
  const supervisorUrl = pathToFileURL(path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')).href

  // THE ROW MATRIX (S1/S2). All of these are rewritten between cases, because the
  // function re-reads the registry on every call — that re-read is the R7 guard
  // (a shutdown that lands between the transition and the call must win).
  const ROWS = {
    win: { name: 'win', kind: 'windows', state: 'ready', ssh: true, ports: { ssh: 47101 } },
    paused: { name: 'paused', kind: 'windows', state: 'suspended', ssh: true, ports: { ssh: 47102 } },
    off: { name: 'off', kind: 'windows', state: 'powered-off', ssh: true, ports: { ssh: 47103 } },
    booting: { name: 'booting', kind: 'windows', state: 'booting', ssh: true, ports: { ssh: 47104 } },
    installing: { name: 'installing', kind: 'windows', state: 'installing', ssh: true, ports: { ssh: 47105 } },
    noSsh: { name: 'noSsh', kind: 'windows', state: 'ready', ssh: false, ports: { ssh: 47106 } },
    linux: { name: 'linux', kind: 'linux', state: 'ready', ssh: true, ports: { ssh: 47107 } }
  }
  const writeRegistry = (rows) => writeFileSync(registryFile, JSON.stringify({ version: 2, vms: rows }))
  // NOT the `installing` row at BOOT: the module resumes an install watch for any
  // such row the moment it listens, and that watcher would spawn ssh behind the
  // counters below. The state is set at call time instead — which is the only
  // thing S2 is about.
  const BOOT_ROWS = { ...ROWS }
  delete BOOT_ROWS.installing

  writeFileSync(modeFile, 'ok')
  // The stub `ssh`: records every spawn, then plays the mode file. A killed child
  // CLOSES (like a real SIGTERM), which is what lets the 20 s cap resolve.
  const stub = path.join(store, 'child-stub.mjs')
  writeFileSync(stub, `import { EventEmitter } from 'node:events'
import { appendFileSync, readFileSync } from 'node:fs'
export * from 'node:child_process'
export function spawn(bin, args) {
  try { appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ bin, args }) + '\\n') } catch {}
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 4242
  child.kill = (signal) => { setTimeout(() => child.emit('close', null, signal), 1) }
  let mode = 'ok'
  try { mode = readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim() } catch {}
  setTimeout(() => {
    if (mode === 'error') { child.emit('error', new Error('spawn ENOENT')); return }
    if (mode === 'fail') { child.stderr.emit('data', 'ERROR: The system cannot find the task\\r\\n'); child.emit('close', 1); return }
    if (mode === 'hang') return
    child.stdout.emit('data', 'SUCCESS: Attempted to run the scheduled task\\r\\n')
    child.emit('close', 0)
  }, 3)
  return child
}
`)
  const hook = path.join(store, 'hook.mjs')
  writeFileSync(hook, `import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
const STUB = ${JSON.stringify(pathToFileURL(stub).href)}
const SUP = ${JSON.stringify(supervisorUrl)}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:child_process' && String(context.parentURL ?? '') === SUP) {
      return { url: STUB, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === SUP) {
      // + THE ONE EXPORT LINE. No line of the module is changed.
      return {
        format: 'module',
        source: readFileSync(new URL(SUP), 'utf8')
          + '\\nexport { windowsRelayReassert, WINDOWS_RELAY_REASSERT_AT, WINDOWS_RELAY_REASSERT_COMMAND, WINDOWS_RELAY_REASSERT_TIMEOUT_MS, WINDOWS_RELAY_REASSERT_INTERVAL_MS }\\n',
        shortCircuit: true
      }
    }
    return nextLoad(url, context)
  }
})
`)

  // The module reads both at load time.
  const savedStore = process.env.CUA_VM_STORE
  const savedSock = process.env.CUA_SUPERVISOR_SOCK
  process.env.CUA_VM_STORE = store
  process.env.CUA_SUPERVISOR_SOCK = sock
  writeRegistry(BOOT_ROWS)

  /** Run one case with stderr captured, and return what it wrote + spawned. */
  const errLines = []
  const write = process.stderr.write.bind(process.stderr)
  const captureStart = () => { errLines.length = 0 }
  const spawned = () => {
    try {
      return readFileSync(capture, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    } catch { return [] }
  }
  const resetSpawns = () => { try { writeFileSync(capture, '') } catch {} }
  const setMode = (m) => writeFileSync(modeFile, m)
  const logs = () => errLines.join('')

  let reassert = null
  let throttle = null
  let tick = null
  try {
    await import(pathToFileURL(hook).href)
    process.stderr.write = (chunk, ...rest) => { errLines.push(String(chunk)); return true }
    const supervisor = await import(supervisorUrl)
    reassert = supervisor.windowsRelayReassert
    throttle = supervisor.WINDOWS_RELAY_REASSERT_AT
    tick = {
      command: supervisor.WINDOWS_RELAY_REASSERT_COMMAND,
      timeoutMs: supervisor.WINDOWS_RELAY_REASSERT_TIMEOUT_MS,
      intervalMs: supervisor.WINDOWS_RELAY_REASSERT_INTERVAL_MS
    }

    // ---- S1: a READY windows row costs exactly one ssh, and says so ----
    throttle.clear(); resetSpawns(); captureStart()
    await reassert('win')
    const s1 = spawned()
    check('WP-4/S1: a ready Windows row fires exactly ONE ssh, ending in `schtasks /run /tn cua-mcp-host`',
      typeof reassert === 'function' && s1.length === 1
      && s1[0].args.at(-1) === 'schtasks /run /tn cua-mcp-host'
      && s1[0].args.includes('-p') && s1[0].args[s1[0].args.indexOf('-p') + 1] === '47101',
      `${s1.length} spawn(s) — ${JSON.stringify(s1[0]?.args.slice(-1) ?? [])}`)
    check('WP-4/S1: ...and the child\'s exit code is logged (the human half of the contract)',
      /windows: win relay re-assert: cua-mcp-host exit 0/u.test(logs()),
      logs().trim().split('\n').at(-1) ?? '(no log line)')
    check('WP-4/S1/S3: the command is verbatim, the cap is 20 s and the throttle window is 15 s',
      tick !== null && tick.command === 'schtasks /run /tn cua-mcp-host'
      && tick.timeoutMs === 20000 && tick.intervalMs === 15000,
      JSON.stringify(tick))

    // ---- S2: everything that is NOT a live windows row spawns NOTHING ----
    const quiet = {}
    for (const name of ['paused', 'off', 'booting', 'installing', 'noSsh', 'linux', 'missing']) {
      throttle.clear(); resetSpawns(); captureStart()
      await reassert(name)
      quiet[name] = spawned().length
    }
    check('WP-4/S2: suspended / powered-off / booting / installing / ssh:false / non-windows / missing rows never spawn ssh',
      Object.values(quiet).every((count) => count === 0), JSON.stringify(quiet))
    // THE RACE (R7): the row is re-read, so a shutdown that landed between the
    // transition and this call wins — no child for a computer that just stopped.
    throttle.clear(); resetSpawns()
    const live = { ...ROWS.win }
    writeRegistry({ ...ROWS, win: { ...live, state: 'powered-off' } })
    await reassert('win')
    const afterShutdown = spawned().length
    writeRegistry(ROWS)
    check('WP-4/S2: a row powered off BETWEEN the transition and the call is a no-op (the row is re-read)',
      afterShutdown === 0, `${afterShutdown} spawn(s)`)

    // ---- S3: three rapid Starts cost one child ----
    writeRegistry(ROWS)
    throttle.clear(); resetSpawns(); captureStart()
    await Promise.all([reassert('win'), reassert('win'), reassert('win')])
    const burst = spawned().length
    await reassert('win')
    const burstAfter = spawned().length
    check('WP-4/S3: three rapid calls (same tick) spawn ONE ssh, and a fourth inside the window adds none',
      burst === 1 && burstAfter === 1, `${burst} then ${burstAfter}`)
    // The window measured without a 15 s sleep: the throttle compares Date.now()
    // against the stamp, so moving the STAMP back is exactly "15 s later".
    throttle.set('win', Date.now() - tick.intervalMs - 1)
    await reassert('win')
    check('WP-4/S3: ...and the next call AFTER the window spawns exactly one more',
      spawned().length === 2, `${spawned().length} spawn(s) total`)

    // ---- S4: a failing ssh is a log line, never a throw ----
    setMode('fail')
    throttle.clear(); resetSpawns(); captureStart()
    let threw = null
    try { await reassert('win') } catch (error) { threw = error }
    check('WP-4/S4: a non-zero ssh exit never throws and is logged WITH the guest detail',
      threw === null && spawned().length === 1
      && /cua-mcp-host exit 1/u.test(logs())
      && /relay re-assert detail: ERROR: The system cannot find the task/u.test(logs()),
      logs().trim().split('\n').slice(-2).join(' | ') || '(no log)')
    setMode('error')
    throttle.clear(); resetSpawns(); captureStart()
    threw = null
    try { await reassert('win') } catch (error) { threw = error }
    check('WP-4/S4: a spawn that cannot even start (ENOENT) never throws and is logged',
      threw === null && /cua-mcp-host exit -1/u.test(logs()) && /spawn ENOENT/u.test(logs()),
      logs().trim().split('\n').slice(-2).join(' | ') || '(no log)')
    // THE 20 s CAP, measured: a child that never closes is killed and the call
    // still resolves. This is the one case that must not hang a Start.
    setMode('hang')
    throttle.clear(); resetSpawns(); captureStart()
    const hangStart = Date.now()
    threw = null
    try { await reassert('win') } catch (error) { threw = error }
    const hangMs = Date.now() - hangStart
    check('WP-4/S4: a HUNG ssh child is capped at 20 s, logged as timed out, and still never throws',
      threw === null && /cua-mcp-host exit 124 \(timed out\)/u.test(logs()) && hangMs >= 19000 && hangMs < 30000,
      `${Math.round(hangMs / 1000)}s — ${logs().trim().split('\n').at(-1) ?? '(no log)'}`)
  } finally {
    process.stderr.write = write
    if (savedStore === undefined) delete process.env.CUA_VM_STORE
    else process.env.CUA_VM_STORE = savedStore
    if (savedSock === undefined) delete process.env.CUA_SUPERVISOR_SOCK
    else process.env.CUA_SUPERVISOR_SOCK = savedSock
    try { rmSync(store, { recursive: true, force: true }) } catch {}
  }
}
