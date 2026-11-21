#!/usr/bin/env node
/**
 * watcher-wedge.mjs — THE WATCHER SURVIVES A WEDGED LIFECYCLE OP (R2, C8–C11, C13).
 *
 * WHAT WAS WRONG AT HEAD
 * ----------------------
 * The QMP poll is the ONLY thing that notices a guest shutting itself down. A
 * tick was guarded by a boolean `ticking`: if the tick parked — and the tick
 * parked inside `finaliseGuestShutdown`, which took the SAME lifecycle lock a
 * wedged operation was holding — then `ticking` stayed `true` for ever, every
 * later tick returned at the "already running" branch WITHOUT rescheduling, and
 * the poll was dead for the life of the process. That is R2, and it is a
 * self-sustaining deadlock: the one path that records `powered-off` needs the
 * mutex that the wedged op holds.
 *
 * THE DECISIVE CHECK (W1): while a `provision` holds `vm:win-gone` for 20 s, a
 * QMP `shutdown` verdict must write `powered-off` in UNDER 2 s — before
 * `provision` answers. At HEAD this cannot happen: the write queues behind the
 * lock. Everything else here is the consequence of that write being free:
 *
 *   W1  powered-off lands in ≤ 2 s while provision is unanswered  (the R2 proof)
 *   W2  restoreFrom stays { kind: 'image' } — a fact needs no checkpoint (C24)
 *   W3  a capture that cannot complete is RECORDED, not silent    (C23)
 *   W4  a row the watcher just confirmed is not stale             (C13)
 *   W5  a row nobody confirmed for 10 min IS stale, aged ≥ 600 s  (C13)
 *   W6  the row names the holder while the op runs                (A-6)
 *   W7  the holder released it when it returned                   (C3)
 *   W8  the state stream carried the transition                   (C10)
 *   W9  vmStart on the wedged row answers lock-timeout, in ≤ 2 s  (C4)
 *
 * FIXTURE — no QEMU, no /dev/kvm, no backdoor: a temp store with two Windows
 * rows, a fake QMP peer (`query-status` is mutable; a `shutdown` status IS the
 * guest powering itself off), an SSH banner (readiness needs one endpoint), a
 * stub `cua` whose `sb exec` sleeps 20 s (that is `provision` holding the lock)
 * and a stub `qemu-img` that exits 1 (a capture that cannot complete).
 *
 * A MISSING PRECONDITION IS A FAILURE: if the holder is never observed, this
 * suite exits non-zero with `harness: no holder observed` — it never passes by
 * measuring an idle supervisor.
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = process.env.REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUPERVISOR = path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')

let failures = 0
let checks = 0
const check = (label, ok, detail = '') => {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'cua-watcher-wedge-'))
const STORE = path.join(ROOT, 'store')
const HOME = path.join(ROOT, 'home')
const BIN = path.join(ROOT, 'bin')
const SOCK = path.join(ROOT, 'supervisor.sock')
for (const dir of [STORE, HOME, BIN, path.join(HOME, '.cua', 'bin'), path.join(STORE, 'windows', 'win-gone'), path.join(STORE, 'windows', 'win-stale'), path.join(STORE, 'checkpoints')]) {
  mkdirSync(dir, { recursive: true })
}

// ---- the stub `cua`: 20 s of nothing, which IS `provision` holding the lock ---
const CUA_STUB = path.join(BIN, 'cua')
writeFileSync(CUA_STUB, [
  '#!/bin/bash',
  '# `sb exec` is the only verb that HANGS: that is `provision` holding the',
  '# lifecycle lock for 20 s. Everything else answers at once, so a vmList poll',
  '# is a poll and not a 20 s stall.',
  'case "$*" in',
  '  *"--version"*) echo "cua 0.7.0 (wedge stub)"; exit 0 ;;',
  '  *"sb ls"*) echo "[]"; exit 0 ;;',
  '  *"sb exec"*) sleep 20; exit 0 ;;',
  'esac',
  'exit 0',
  ''
].join('\n'))
chmodSync(CUA_STUB, 0o755)
// ---- the stub qemu-img: a capture that cannot complete -----------------------
const QEMU_IMG = path.join(HOME, '.cua', 'bin', 'qemu-img')
writeFileSync(QEMU_IMG, '#!/bin/sh\necho "stub qemu-img: convert is not available" >&2\nexit 1\n')
chmodSync(QEMU_IMG, 0o755)
// ---- the stub QEMU binary (never spawned by these checks) -------------------
const QEMU_STUB = path.join(BIN, 'qemu-system-x86_64')
writeFileSync(QEMU_STUB, '#!/bin/bash\nexit 0\n')
chmodSync(QEMU_STUB, 0o755)

const freePort = () => new Promise((resolve) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})
const QMP_PORT = await freePort()
const SSH_PORT = await freePort()
const VNC_PORT = await freePort()

// ---- fake QMP: the mutable status is how a guest "shuts down" ---------------
const qmpState = { status: 'running', queries: 0 }
const qmpServer = net.createServer((socket) => {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.write(`${JSON.stringify({ QMP: { version: { qemu: { major: 10, minor: 0, micro: 0 }, package: '' }, capabilities: [] } })}\n`)
  socket.on('data', (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (line.trim() === '') continue
      let message = {}
      try { message = JSON.parse(line) } catch { continue }
      let answer = { return: {} }
      if (message.execute === 'query-status') {
        qmpState.queries += 1
        answer = { return: { status: qmpState.status } }
      }
      try { socket.write(`${JSON.stringify(answer)}\n`) } catch {}
    }
  })
})
await new Promise((resolve) => qmpServer.listen(QMP_PORT, '127.0.0.1', resolve))
// ---- an SSH banner: `ready()` needs ONE endpoint to answer -------------------
const sshServer = net.createServer((socket) => {
  socket.on('error', () => {})
  try { socket.write('SSH-2.0-wedge-stub\r\n') } catch {}
})
await new Promise((resolve) => sshServer.listen(SSH_PORT, '127.0.0.1', resolve))

// ---- the two rows -----------------------------------------------------------
const tenMinutesAgo = new Date(Date.now() - 600_000).toISOString()
const row = (extra) => ({
  backend: 'qemu',
  kind: 'windows',
  state: 'ready',
  stateSince: tenMinutesAgo,
  installComplete: true,
  windowsVersion: '11',
  cpu: 2,
  memory: 6,
  createdAt: tenMinutesAgo,
  lastUsed: tenMinutesAgo,
  restoreFrom: { kind: 'image', image: 'windows' },
  ...extra
})
writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify({
  version: 2,
  vms: {
    'win-gone': row({ ports: { qmp: QMP_PORT, ssh: SSH_PORT, vnc: VNC_PORT } }),
    'win-stale': row({})
  }
}, null, 2)}\n`)
// A live pidfile (this process) — the backend's "the process is the truth".
writeFileSync(path.join(STORE, 'windows', 'win-gone', 'qemu.pid'), `${process.pid}\n`)
writeFileSync(path.join(STORE, 'windows', 'win-gone', 'disk.qcow2'), 'not really a qcow2')
writeFileSync(path.join(STORE, 'windows', 'win-stale', 'disk.qcow2'), 'not really a qcow2')

// ---- the supervisor ---------------------------------------------------------
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
    // ONE-SECOND TICKS: the whole point is that a verdict lands within 2 s.
    DSH_CUA_VM_STATE_POLL_S: '1',
    // The waiter budget the refusal is measured against (production: 30 s).
    DSH_CUA_VM_LOCK_WAIT_MS: '300',
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

// ---- the event stream (W8) --------------------------------------------------
// Created AFTER the supervisor answers: a socket opened before `listen` dies on
// ENOENT, and a dead subscriber looks exactly like "no events were published".
const events = []
let subscription = null
const openSubscription = () => new Promise((resolve) => {
  subscription = net.connect(SOCK)
  subscription.setEncoding('utf8')
  let buffer = ''
  subscription.on('data', (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      try {
        const parsed = JSON.parse(line)
        if (parsed?.event === 'vm-state') events.push(parsed)
      } catch {}
    }
  })
  subscription.on('error', () => {})
  const timer = setTimeout(resolve, 5000)
  subscription.on('connect', () => {
    clearTimeout(timer)
    subscription.write(`${JSON.stringify({ op: 'subscribe', events: ['vm-state'] })}\n`)
    resolve()
  })
  subscription.on('error', () => { clearTimeout(timer); resolve() })
})

let exitCode = 2
try {
  const up = await waitFor(async () => (await call({ op: 'ping' }, 1000))?.ok === true, 20_000, 500)
  if (!up) {
    console.error('harness: the supervisor never answered ping')
    console.error(supervisorLog.slice(-2000))
    process.exit(2)
  }
  await openSubscription()
  await sleep(300)

  // 1. Install the state watch the way the panel does — one status poll on a
  //    ready row — so a QMP verdict has an observer and the row is corroborated.
  const status = await call({ op: 'vmWindowsStatus', name: 'win-gone' }, 30_000)
  if (status?.ok !== true) {
    console.error(`harness: vmWindowsStatus did not reach the row — ${JSON.stringify(status).slice(0, 300)}`)
    process.exit(2)
  }
  await waitFor(async () => {
    const row = await rowOf('win-gone')
    return row?.stateConfirmedAt !== null && row?.stateConfirmedAt !== undefined
  }, 5000)

  // 2. THE GUEST SHUTS ITSELF DOWN, and a 20 s `provision` takes the lock.
  qmpState.status = 'shutdown'
  const provision = call({ op: 'provision', name: 'win-gone' }, 120_000)
  const holderSeen = await waitFor(async () => (await rowOf('win-gone'))?.lock?.heldBy === 'provision', 2000, 25)
  if (!holderSeen) {
    // A MISSING PRECONDITION IS A FAILURE — never a pass on an idle supervisor.
    console.error(`harness: no holder observed (${JSON.stringify((await rowOf('win-gone'))?.lock ?? null)})`)
    throw new Error('harness: no holder observed')
  }
  const firedAt = Date.now()

  // 3. W1 — THE R2 PROOF: `powered-off` lands while `provision` is unanswered.
  const flipped = await waitFor(async () => (await rowOf('win-gone'))?.state === 'powered-off', 2000, 25)
  const elapsed = Date.now() - firedAt
  const stillHolding = (await rowOf('win-gone'))?.lock?.heldBy === 'provision'
  check('W1 a QMP shutdown verdict writes powered-off within 2 s — WHILE provision still holds the lifecycle lock (HEAD queued here and never wrote)',
    flipped === true && elapsed <= 2000 && stillHolding === true,
    `flipped=${flipped} ${elapsed} ms holding=${stillHolding} lock=${JSON.stringify((await rowOf('win-gone'))?.lock ?? null)}`)

  // 4. W2 — C24: the state write names a real restore source, with no capture.
  const poweredOff = await rowOf('win-gone')
  check("W2 restoreFrom stays { kind: 'image' } until a capture lands — the FACT needs no checkpoint (C24)",
    poweredOff?.restoreFrom?.kind === 'image',
    JSON.stringify(poweredOff?.restoreFrom ?? null))

  // 5. W6 — the row names the holder while the operation really runs (A-6).
  check("W3 vmList carries lock.heldBy:'provision' with a measured heldMs while it runs",
    poweredOff?.lock?.heldBy === 'provision' && typeof poweredOff?.lock?.heldMs === 'number' && poweredOff.lock.heldMs >= 0,
    JSON.stringify(poweredOff?.lock ?? null))

  // 6. W9 — a Start on the wedged row is REFUSED with the typed code, in ≤ 2 s.
  const startAt = Date.now()
  const startAnswer = await call({ op: 'vmStart', name: 'win-gone' }, 30_000)
  const startWall = Date.now() - startAt
  check("W4 vmStart on the wedged row answers ok:false code:'lock-timeout' inside the waiter budget (never a test timeout), naming the holder",
    startAnswer?.ok === false && startAnswer?.code === 'lock-timeout' && startWall <= 2000
    && startAnswer?.lockHeldBy === 'provision' && /\(provision\)/u.test(startAnswer?.error ?? ''),
    `${startWall} ms ${JSON.stringify(startAnswer).slice(0, 240)}`)

  // 7. W4/W5 — C13 staleness, computed on read: the row the watcher just
  //    confirmed is fresh; the row nobody ever confirmed is 10 minutes old.
  const confirmed = await rowOf('win-gone')
  check('W5 a row the watcher just CONFIRMED reports stateStale:false (and carries stateConfirmedAt)',
    confirmed?.stateStale === false && confirmed?.stateConfirmedAt !== null && confirmed?.stateConfirmedAt !== undefined,
    JSON.stringify({ at: confirmed?.stateConfirmedAt, age: confirmed?.stateAgeMs, stale: confirmed?.stateStale }))
  const stale = await rowOf('win-stale')
  check('W6 a ready row with no corroboration for 10 minutes reports stateStale:true and stateAgeMs ≥ 600 000',
    stale?.stateStale === true && typeof stale?.stateAgeMs === 'number' && stale.stateAgeMs >= 600_000,
    JSON.stringify({ at: stale?.stateConfirmedAt, age: stale?.stateAgeMs, stale: stale?.stateStale }))

  // 8. W8 — the transition reached the state stream (C10).
  check("W7 subscribe received at least one vm-state event with state:'powered-off'",
    events.some((event) => event.state === 'powered-off'),
    JSON.stringify(events.slice(0, 3)))

  // 8. W8 — the holder keeps the lock until it is DONE (C3), and only then
  //    releases it: no path here may break a lock whose holder is still working.
  const provisionAnswer = await provision
  const released = await waitFor(async () => (await rowOf('win-gone'))?.lock === null, 40_000, 200)
  check('W8 once the holder RETURNS the lock is null — the holder was allowed to finish, never forced out (C3)',
    released === true && typeof provisionAnswer === 'object',
    `released=${released} provision=${JSON.stringify(provisionAnswer).slice(0, 120)}`)

  // 9. W9 — the capture the shutdown deferred is a RECORD, not a silence: a
  //    `qemu-img` that cannot convert lands as one of the closed-set reasons.
  const skipRecorded = await waitFor(async () => (await rowOf('win-gone'))?.checkpointSkipped !== undefined, 20_000, 200)
  const skipReason = (await rowOf('win-gone'))?.checkpointSkipped?.reason
  check('W9 a capture that cannot complete is RECORDED (checkpointSkipped.reason in the closed set), never silently absent (C23)',
    skipRecorded === true
    && ['quota', 'space', 'lock-busy', 'convert-failed', 'no-disk', 'policy'].includes(String(skipReason)),
    `recorded=${skipRecorded} reason=${String(skipReason)}`)
  exitCode = failures === 0 ? 0 : 1
} catch (error) {
  console.error(`harness: ${error?.message ?? error}`)
  console.error(supervisorLog.slice(-3000))
  exitCode = 2
} finally {
  try { subscription?.destroy() } catch {}
  try { child.kill('SIGTERM') } catch {}
  try { qmpServer.close() } catch {}
  try { sshServer.close() } catch {}
  await sleep(300)
  try { child.kill('SIGKILL') } catch {}
  try { rmSync(ROOT, { recursive: true, force: true }) } catch {}
}

if (checks !== 9) {
  console.error(`harness: expected exactly 9 checks, ran ${checks} — the suite's own count is part of its contract`)
}
console.log(failures === 0 && checks === 9 ? `wedge: PASS (${checks} checks)` : `wedge: FAIL (${failures}/${checks})`)
process.exit(failures === 0 && checks === 9 ? 0 : (exitCode === 2 ? 2 : 1))
