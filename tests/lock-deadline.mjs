#!/usr/bin/env node
/**
 * lock-deadline.mjs — THE WAITER'S DEADLINE, THE HOLDER'S NAME, AND THE REFUSAL.
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * `withVmLock` at HEAD was a bare promise chain: a waiter queued behind every
 * predecessor for ever. One wedged holder (a `qemu-img` convert of a 10 GB disk,
 * a QMP monitor that stopped answering, an ACPI powerdown that never returned)
 * therefore silenced EVERY power operation on that computer — the panel's Start
 * and Shutdown buttons simply never answered, with no error, no log line and
 * nothing in the doctor to look at. That is diagnosis R1, and it produced both
 * reported symptoms: dead buttons AND a row stuck at `ready`.
 *
 * The fix has four halves, and each one fails on its own without the others:
 *
 *   T1–T3  a waiter EXPIRES instead of queueing for ever, the holder is NOT
 *          interrupted (C3), and the chain is still usable afterwards (I3/I4);
 *   T4     re-entrancy survives (I6) — `shutdown→suspend` and `stop→shutdown`
 *          call themselves and must not wait for a lock they already hold;
 *   T5     the holder is VISIBLE (`lockSnapshot`), which is what puts
 *          `lock.heldBy` on a row and the holder's name in the refusal;
 *   T6/T7  poison-not-break (C5) and the one env knob that restores HEAD
 *          (`DSH_CUA_VM_LOCK_WAIT_MS=0`);
 *   T8     the lock ORDER is enforced (C7), log-only in production;
 *   T9–T12 the same three facts over the SOCKET, against the REAL supervisor:
 *          a `provision` that sleeps holds `vm:win-hold`, `vmList` names it, and
 *          a `vmStart` answers `code: 'lock-timeout'` inside the waiter budget
 *          instead of hanging for thirty minutes.
 *
 * THE FIXTURE HAS NO QEMU, no /dev/kvm and no backdoor: a temp store, a stub
 * `cua` whose `sb exec` sleeps (that IS `provision` holding the lock), a stub
 * `qemu-img` that exits 1, and a registry row with a dead QMP port. A missing
 * precondition is reported as a FAILURE, never as a pass.
 *
 * Exit 0 ⇔ `lock: PASS (12 checks)`.
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = process.env.REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCK_MODULE = path.join(REPO, 'docker', 'cua-vm-lock.mjs')
const SUPERVISOR = path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')

let failures = 0
let checks = 0
const check = (label, ok, detail = '') => {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ====================================================================== *
 * T1–T8 — THE MODULE ITSELF (`docker/cua-vm-lock.mjs`).
 *
 * Pure by design (AsyncLocalStorage + timers, no I/O), which is what makes these
 * eight checks possible without a supervisor, a store or a computer.
 * ====================================================================== */
const L = await import(`file://${LOCK_MODULE}`)

// The default waiter deadline is 30 s in production; the suite runs it at 300 ms
// so every assertion below is measured in milliseconds, not minutes.
process.env.DSH_CUA_VM_LOCK_WAIT_MS = '300'
delete process.env.DSH_CUA_VM_LOCK_ORDER_STRICT
delete process.env.DSH_CUA_VM_LOCK_POISON_MS
delete process.env.DSH_CUA_VM_LOCK_HOLD_WARN_MS

// ---- T1: a wedged holder ⇒ the waiter is REFUSED, loudly and typedly --------
let holderSettled = false
const heldPromise = L.withVmLock('win-a', async () => {
  await sleep(1200)
  holderSettled = true
  return 'held'
}, { holder: 'provision' })
const t1Start = Date.now()
let t1Error = null
try {
  await L.withVmLock('win-a', async () => 'never-runs', { holder: 'vmStart' })
} catch (error) {
  t1Error = error
}
const t1Wall = Date.now() - t1Start
check('T1 a waiter behind a wedged holder is REFUSED with code lock-timeout, the holder named, inside the deadline',
  t1Error instanceof L.LockTimeoutError
  && t1Error.code === 'lock-timeout'
  && t1Error.lockHeldBy === 'provision'
  && typeof t1Error.lockHeldMs === 'number' && t1Error.lockHeldMs >= 0
  && t1Wall <= 2000
  // the FROZEN sentence shape (C4): name, seconds, holder — the state is
  // appended by the caller that has a registry, not by this module.
  && /^another operation on win-a has been running for \d+s \(provision\)$/u.test(t1Error.message ?? ''),
  `${t1Error?.name}/${t1Error?.code} heldBy=${t1Error?.lockHeldBy} wall=${t1Wall} ms msg=${JSON.stringify(t1Error?.message)}`)

// Captured while the holder still owns the key: T5 asserts on this snapshot.
const t5WhileHeld = L.lockSnapshot()['vm:win-a'] ?? null

// ---- T2: the holder was NOT interrupted (C3) --------------------------------
const t2Value = await heldPromise
check('T2 the holder is NEVER interrupted by an expired waiter — it runs to completion and returns its own value',
  holderSettled === true && t2Value === 'held',
  `settled=${holderSettled} value=${JSON.stringify(t2Value)}`)

// ---- T5: the snapshot names the holder while held, and is empty afterwards --
check('T5 lockSnapshot() carries {holder, heldMs, waiters} while held and {} once the key is free',
  t5WhileHeld !== null
  && t5WhileHeld.holder === 'provision'
  && typeof t5WhileHeld.heldMs === 'number' && t5WhileHeld.heldMs >= 0
  && t5WhileHeld.waiters === 0            // the T1 waiter expired and left the queue
  && t5WhileHeld.poisoned === false
  && JSON.stringify(L.lockSnapshot()) === '{}',
  `whileHeld=${JSON.stringify(t5WhileHeld)} after=${JSON.stringify(L.lockSnapshot())}`)

// ---- T3: the chain is NOT poisoned by an expired waiter (I3/I4) -------------
let t3Value = null
try {
  t3Value = await L.withVmLock('win-a', async () => 'next', { holder: 'vmStart' })
} catch (error) {
  t3Value = `threw ${error?.code ?? error}`
}
check('T3 after the holder settles the NEXT acquire succeeds (an expiry releases its slot, so the chain never stalls)',
  t3Value === 'next' && JSON.stringify(L.lockSnapshot()) === '{}',
  `value=${JSON.stringify(t3Value)} snapshot=${JSON.stringify(L.lockSnapshot())}`)

// ---- T4: re-entrancy — a nested acquire runs IMMEDIATELY (I6) ---------------
let t4NestedMs = -1
let t4NestedValue = null
await L.withVmLock('win-b', async () => {
  const start = Date.now()
  t4NestedValue = await L.withVmLock('win-b', async () => 'inner')
  t4NestedMs = Date.now() - start
}, { holder: 'vmShutdown' })
check('T4 a nested acquire of a key this async chain already holds returns at once (shutdown→suspend must never self-deadlock)',
  t4NestedValue === 'inner' && t4NestedMs >= 0 && t4NestedMs < 100,
  `value=${JSON.stringify(t4NestedValue)} nested=${t4NestedMs} ms`)

// ---- T6: POISON, never break (C5) ------------------------------------------
process.env.DSH_CUA_VM_LOCK_POISON_MS = '1'
process.env.DSH_CUA_VM_LOCK_WAIT_MS = '5000'
const poisonHolder = L.withVmLock('win-c', async () => {
  await sleep(1200)
}, { holder: 'qemu-img' })
await sleep(30)
const t6Start = Date.now()
let t6Error = null
try {
  await L.withVmLock('win-c', async () => 'never-runs', { holder: 'vmStart' })
} catch (error) {
  t6Error = error
}
const t6Wall = Date.now() - t6Start
const t6Snapshot = L.lockSnapshot()['vm:win-c'] ?? null
const t6Sentence = t6Error === null ? '' : L.lockTimeoutSentence(t6Error, { state: 'ready' })
check('T6 past LOCK_POISON_MS a new waiter fails FAST with poisoned:true and the restart runbook — the holder is still not released',
  t6Error?.poisoned === true
  && t6Error?.code === 'lock-timeout'
  && t6Wall < 200
  && t6Snapshot?.poisoned === true
  && t6Snapshot?.holder === 'qemu-img'
  // the state clause first, then the C5 runbook — one frozen sentence
  && t6Sentence.endsWith('; the panel still shows ready; restart the supervisor (the lock lives in process memory)'),
  `${t6Wall} ms poisoned=${t6Error?.poisoned} snapshot=${JSON.stringify(t6Snapshot)} sentence=${JSON.stringify(t6Sentence)}`)
await poisonHolder
delete process.env.DSH_CUA_VM_LOCK_POISON_MS
process.env.DSH_CUA_VM_LOCK_WAIT_MS = '300'

// ---- T7: the rollback knob — DSH_CUA_VM_LOCK_WAIT_MS=0 waits for ever ------
process.env.DSH_CUA_VM_LOCK_WAIT_MS = '0'
let t7Ran = false
const legacyHolder = L.withVmLock('win-d', async () => {
  await sleep(700)
}, { holder: 'legacy-holder' })
const t7Value = await L.withVmLock('win-d', async () => {
  t7Ran = true
  return 'legacy'
}, { holder: 'vmStart' })
await legacyHolder
check("T7 DSH_CUA_VM_LOCK_WAIT_MS=0 restores the HEAD semantics: the waiter WAITS behind a 700 ms holder and then runs",
  t7Ran === true && t7Value === 'legacy',
  `ran=${t7Ran} value=${JSON.stringify(t7Value)}`)
process.env.DSH_CUA_VM_LOCK_WAIT_MS = '300'

// ---- T8: the lock ORDER is enforced (C7) ----------------------------------
const orderLog = []
L.useLockLogger((line) => orderLog.push(String(line)))
let logOnlyError = null
await L.withLock('@registry', async () => {
  try {
    await L.withVmLock('win-e', async () => 'inner')
  } catch (error) {
    logOnlyError = error
  }
})
const loggedViolation = orderLog.some((line) => line.includes('lock-order-violation'))
process.env.DSH_CUA_VM_LOCK_ORDER_STRICT = '1'
let strictError = null
await L.withLock('@registry', async () => {
  try {
    await L.withLock('@store', async () => 'inner')
  } catch (error) {
    strictError = error
  }
})
delete process.env.DSH_CUA_VM_LOCK_ORDER_STRICT
L.useLockLogger(null)
check('T8 @registry is a LEAF: acquiring vm:/@store inside it logs lock-order-violation in production, and THROWS LockOrderError under DSH_CUA_VM_LOCK_ORDER_STRICT=1',
  logOnlyError === null && loggedViolation === true
  && strictError instanceof L.LockOrderError && strictError.code === 'lock-order-violation',
  `logOnly=${logOnlyError === null} logged=${loggedViolation} strict=${strictError?.name}/${strictError?.code} lines=${JSON.stringify(orderLog).slice(0, 200)}`)

/* ====================================================================== *
 * T9–T12 — THE SAME FACTS OVER THE SOCKET, AGAINST THE REAL SUPERVISOR.
 *
 * `provision` is the user-facing op that holds `vm:<name>` the longest (it runs
 * the guest's provisioning script), and the fixture makes its very first `cua sb
 * exec` sleep — so the lock is held for 20 s while `vmStart` must answer in
 * 300 ms. At HEAD that `vmStart` queued for the whole 20 s (and in the live
 * defect, for thirty minutes); here it is refused, and the row says who.
 * ====================================================================== */
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'cua-lock-deadline-'))
const STORE = path.join(ROOT, 'store')
const HOME = path.join(ROOT, 'home')
const BIN = path.join(ROOT, 'bin')
const SOCK = path.join(ROOT, 'supervisor.sock')
for (const dir of [STORE, HOME, BIN, path.join(HOME, '.cua', 'bin'), path.join(STORE, 'windows', 'win-hold'), path.join(STORE, 'checkpoints')]) {
  mkdirSync(dir, { recursive: true })
}

const CUA_STUB = path.join(BIN, 'cua')
writeFileSync(CUA_STUB, [
  '#!/bin/bash',
  '# `sb exec` is the ONLY verb that hangs: that is `provision` holding the',
  '# lifecycle lock. Everything else answers at once, so a vmList poll is a poll.',
  'case "$*" in',
  '  *"--version"*) echo "cua 0.7.0 (lock-deadline stub)"; exit 0 ;;',
  '  *"sb ls"*) echo "[]"; exit 0 ;;',
  '  *"sb exec"*) sleep 20; exit 0 ;;',
  'esac',
  'exit 0',
  ''
].join('\n'))
chmodSync(CUA_STUB, 0o755)
const QEMU_IMG = path.join(HOME, '.cua', 'bin', 'qemu-img')
writeFileSync(QEMU_IMG, '#!/bin/sh\necho "stub qemu-img: convert is not available" >&2\nexit 1\n')
chmodSync(QEMU_IMG, 0o755)
const QEMU_STUB = path.join(BIN, 'qemu-system-x86_64')
writeFileSync(QEMU_STUB, '#!/bin/bash\nexit 0\n')
chmodSync(QEMU_STUB, 0o755)

const now = new Date().toISOString()
writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify({
  version: 2,
  vms: {
    'win-hold': {
      backend: 'qemu', kind: 'windows', state: 'ready', stateSince: now,
      installComplete: true, windowsVersion: '11', cpu: 2, memory: 6,
      createdAt: now, lastUsed: now, restoreFrom: { kind: 'image', image: 'windows' },
      // A DEAD port: no QMP peer exists, and nothing here needs one — the row is
      // only the computer whose lock `provision` holds.
      ports: { qmp: 46991, ssh: 47991, vnc: 5991 }
    }
  }
}, null, 2)}\n`)
writeFileSync(path.join(STORE, 'windows', 'win-hold', 'disk.qcow2'), 'not really a qcow2')

const child = spawn(process.execPath, [SUPERVISOR], {
  env: {
    ...process.env,
    CUA_VM_STORE: STORE,
    CUA_VM_HOME: HOME,
    CUA_SUPERVISOR_SOCK: SOCK,
    CUA_BIN: CUA_STUB,
    CUA_WORKSPACE_ROOT: '/workspace',
    DSH_CUA_WINDOWS_FAKE_HOST_CAPS: '1',
    DSH_CUA_WINDOWS_OEM_DIR: path.join(REPO, 'docker', 'windows-oem'),
    DSH_CUA_WINDOWS_QEMU: QEMU_STUB,
    DSH_CUA_VM_WINDOWS: '1',
    // THE POINT OF THE SOCKET HALF: the waiter budget is 300 ms, so a queue is
    // measurable and a hang is impossible.
    DSH_CUA_VM_LOCK_WAIT_MS: '300',
    DSH_CUA_VM_STATE_POLL_S: '30',
    PATH: `${BIN}:${process.env.PATH ?? ''}`
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let supervisorLog = ''
child.stdout.on('data', (chunk) => { supervisorLog += chunk })
child.stderr.on('data', (chunk) => { supervisorLog += chunk })

const call = (payload, timeoutMs = 60_000) => new Promise((resolve) => {
  const socket = net.connect(SOCK)
  let buffer = ''
  let settled = false
  const done = (answer) => {
    if (settled) return
    settled = true
    try { socket.destroy() } catch {}
    resolve(answer)
  }
  const timer = setTimeout(() => done({ ok: false, error: `harness: no answer within ${timeoutMs} ms` }), timeoutMs)
  socket.setEncoding('utf8')
  socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
  socket.on('data', (chunk) => {
    buffer += chunk
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    clearTimeout(timer)
    try {
      done(JSON.parse(buffer.slice(0, newline)))
    } catch (error) {
      done({ ok: false, error: `harness: bad JSON (${error.message})` })
    }
  })
  socket.on('error', (error) => {
    clearTimeout(timer)
    done({ ok: false, error: `harness: ${error.message}` })
  })
})
const waitFor = async (predicate, ms, stepMs = 50) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(stepMs)
  }
  return false
}
const rowOf = async (name) => {
  const answer = await call({ op: 'vmList' })
  return answer?.registry?.[name] ?? null
}

let exitCode = 2
try {
  const up = await waitFor(async () => (await call({ op: 'ping' }, 1000))?.ok === true, 20_000, 500)
  if (!up) {
    console.error('harness: the supervisor never answered ping')
    console.error(supervisorLog.slice(-2000))
    process.exit(2)
  }

  // 1. FIRE `provision` AND NEVER AWAIT IT: it takes the lock immediately and
  //    keeps it for the 20 s the stub's `sb exec` sleeps.
  const provision = call({ op: 'provision', name: 'win-hold' }, 120_000)
  const holderSeen = await waitFor(async () => (await rowOf('win-hold'))?.lock?.heldBy === 'provision', 5000, 25)
  check('T9 provision holds vm:win-hold and vmList NAMES the holder (a missing precondition would be a harness failure)',
    holderSeen === true,
    holderSeen ? JSON.stringify((await rowOf('win-hold'))?.lock ?? null) : `no holder observed; log=${supervisorLog.slice(-400)}`)

  // 2. T10 — the refusal, measured.
  const startAt = Date.now()
  const startAnswer = await call({ op: 'vmStart', name: 'win-hold' }, 30_000)
  const startWall = Date.now() - startAt
  check("T10 vmStart on the wedged computer answers ok:false code:'lock-timeout' inside the waiter budget — never a 30-minute queue",
    startAnswer?.ok === false && startAnswer?.code === 'lock-timeout' && startWall <= 2000,
    `${startWall} ms ${JSON.stringify(startAnswer).slice(0, 240)}`)

  // 3. T11 — the row still names the holder while the operation really runs.
  const stillHeld = await rowOf('win-hold')
  check("T11 the vmList row carries lock.heldBy:'provision' with a measured heldMs WHILE it runs",
    stillHeld?.lock?.heldBy === 'provision' && typeof stillHeld?.lock?.heldMs === 'number' && stillHeld.lock.heldMs >= 0,
    JSON.stringify(stillHeld?.lock ?? null))
  const stateSentence = `the panel still shows ${stillHeld?.state ?? ''}`

  // 4. T12 — the refusal is a SENTENCE that names the holder and the row's state
  //    (C4), plus the fields a caller can branch on.
  check('T12 the refusal names the holder, repeats the panel state, and exposes lockHeldBy/lockHeldMs/waitedMs',
    /another operation on win-hold has been running for \d+s \(provision\)/u.test(startAnswer?.error ?? '')
    && (startAnswer?.error ?? '').includes(stateSentence)
    && startAnswer?.lockHeldBy === 'provision'
    && typeof startAnswer?.lockHeldMs === 'number'
    && typeof startAnswer?.waitedMs === 'number',
    `error=${JSON.stringify(startAnswer?.error)} heldBy=${startAnswer?.lockHeldBy} heldMs=${startAnswer?.lockHeldMs} waitedMs=${startAnswer?.waitedMs}`)

  // The holder must be allowed to finish (C3) — and when it does the lock is
  // gone, which is the fact T1–T3 proved at the module level.
  const provisionAnswer = await provision
  const released = await waitFor(async () => (await rowOf('win-hold'))?.lock === null, 40_000, 200)
  if (!released || typeof provisionAnswer !== 'object') {
    console.log(`  .. note: provision answered ${JSON.stringify(provisionAnswer).slice(0, 160)}; lock released=${released}`)
  }
  exitCode = failures === 0 ? 0 : 1
} catch (error) {
  console.error(`harness: ${error?.message ?? error}`)
  console.error(supervisorLog.slice(-3000))
  exitCode = 2
} finally {
  try { child.kill('SIGTERM') } catch {}
  await sleep(300)
  try { child.kill('SIGKILL') } catch {}
  try { rmSync(ROOT, { recursive: true, force: true }) } catch {}
}

if (checks !== 12) {
  console.error(`harness: expected exactly 12 checks, ran ${checks} — the suite's own count is part of its contract`)
}
console.log(failures === 0 && checks === 12 ? `lock: PASS (${checks} checks)` : `lock: FAIL (${failures}/${checks})`)
process.exit(failures === 0 && checks === 12 ? 0 : (exitCode === 2 ? 2 : 1))
