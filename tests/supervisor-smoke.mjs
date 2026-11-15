#!/usr/bin/env node
/**
 * supervisor-smoke.mjs — exercise the supervisor's OWN logic against a throwaway
 * store and a stub `cua` binary. No QEMU, no /dev/kvm, no guest: everything here
 * is the bookkeeping that used to be wrong (registry migration, quota, delete
 * manifest, GC, shutdown/start state machine).
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync, readdirSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import zlib from 'node:zlib'

// Resolved from THIS file, so the suite runs from a checkout anywhere (CI,
// a worktree, a reviewer's clone) — it used to hardcode the author's path.
const REPO = process.env.REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STORE = path.join(os.tmpdir(), `cua-smoke-${process.pid}`)
const HOME = path.join(STORE, 'home')
const SOCK = path.join(STORE, 'supervisor.sock')
const STUB = path.join(STORE, 'bin', 'cua-stub')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

rmSync(STORE, { recursive: true, force: true })
mkdirSync(path.join(STORE, 'bin'), { recursive: true })
mkdirSync(HOME, { recursive: true })

// A real 1200x750 PNG (IHDR + a deflated 2-row IDAT), built with zlib only, so
// the stub's `do screenshot` produces a file pngSize() can read.
const PNG_SOURCE = path.join(STORE, 'fixture-1200x750.png')
writeFileSync(PNG_SOURCE, (() => {
  const crcTable = (() => {
    const table = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
    return table
  })()
  const crc32 = (buffer) => {
    let crc = 0xffffffff
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1200, 0)
  ihdr.writeUInt32BE(750, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((1200 * 3 + 1) * 2)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
})())

const STUB_LOG = path.join(STORE, 'stub.log')
writeFileSync(STUB, `#!/bin/bash
# Every invocation is recorded, so the tests can assert ORDER (switch before
# screenshot) and not just the final answer.
echo "$*" >> "${STUB_LOG}"
case "$*" in
  *"--version"*) echo "cua 0.7.0 (stub)"; exit 0 ;;
  *"sb ls"*) echo "[]"; exit 0 ;;
  *"sb exec"*)
    case "$*" in
      *cua-space*|*getdisplaygeometry*) echo "1280 800" ;;
    esac
    exit 0 ;;
  *"do switch"*) exit 0 ;;
  *"sb rm"*) [ -f "${STORE}/stub-fail-rm" ] && exit 3; exit 0 ;;
  *"do screenshot"*)
    # write a real 1200x750 PNG at the -s path
    out=""
    prev=""
    for a in "$@"; do
      if [ "$prev" = "-s" ]; then out="$a"; fi
      prev="$a"
    done
    [ -n "$out" ] || out=/tmp/stub.png
    cp "${PNG_SOURCE}" "$out" 2>/dev/null || : > "$out"
    exit 0 ;;
esac
exit 0
`, { mode: 0o755 })

// A v1 registry: the read path must migrate it and keep the row's fields.
const NAME = 'ws-0123456789ab'
writeFileSync(path.join(STORE, 'registry.json'), JSON.stringify({
  vms: {
    [NAME]: { workspace: '/workspace', tier: 'slim', cpu: 2, memory: 4, rea: false, diskGb: 20, state: 'ready', image: 'linux' },
    'win-legacy': { workspace: '/w2', tier: 'slim', cpu: 2, memory: 6, backend: 'windows', windowsVersion: '11', state: 'powered-off' },
    'ws-heal': { workspace: '/w3', tier: 'slim', cpu: 2, memory: 4, state: 'powered-off', image: 'linux' }
  }
}, null, 2) + '\n')

// A fabricated QEMU directory whose process is DEAD (pid 999999) and whose QMP
// port has no listener: shutdown must treat it as "already down", not hang.
const VM_DIR = path.join(HOME, '.cua', 'vmm', 'qemu', NAME)
mkdirSync(VM_DIR, { recursive: true })
writeFileSync(path.join(VM_DIR, 'cmdline'), `/usr/bin/qemu-system-x86_64 -name ${NAME} -qmp tcp:127.0.0.1:39599,server=on,wait=off -pidfile ${VM_DIR}/qemu.pid\n`)
writeFileSync(path.join(VM_DIR, 'qemu.pid'), '999999\n')
writeFileSync(path.join(VM_DIR, 'disk.qcow2'), 'not really a qcow2')
// Debris the delete/GC paths must find: a checkpoint, a restore temp, shots,
// a view row, a ports row and a trajectory.
mkdirSync(path.join(STORE, 'checkpoints'), { recursive: true })
writeFileSync(path.join(STORE, 'checkpoints', `${NAME}.qcow2`), 'cp')
writeFileSync(path.join(STORE, 'checkpoints', `${NAME}.qcow2.restore.qcow2`), 'restore')
writeFileSync(path.join(STORE, 'checkpoints', 'orphan.qcow2'), 'o1')
writeFileSync(path.join(STORE, 'checkpoints', 'orphan.qcow2.bak'), 'o2')
// A registered computer whose ONLY checkpoint is a killed convert: GC must
// PROMOTE it, not delete the last copy of the disk.
writeFileSync(path.join(STORE, 'checkpoints', 'ws-heal.qcow2.tmp'), 'tmp')
mkdirSync(path.join(STORE, 'shots'), { recursive: true })
writeFileSync(path.join(STORE, 'shots', `${NAME}-1.png`), 'png')
writeFileSync(path.join(STORE, 'views.json'), JSON.stringify({ [NAME]: { port: 5999, path: '/viewer/', openedAt: '2020-01-01T00:00:00Z', expiresAt: 1 } }))
mkdirSync(path.join(HOME, '.cua', 'trajectories', `local_${NAME}`, '20260101-000000'), { recursive: true })
writeFileSync(path.join(HOME, '.cua', 'trajectories', `local_${NAME}`, '20260101-000000', 'x.json'), '{}')

const QEMU_IMG_STUB = path.join(HOME, '.cua', 'bin', 'qemu-img')
mkdirSync(path.dirname(QEMU_IMG_STUB), { recursive: true })
// `convert -O qcow2 SRC DST` copies; `create -f qcow2 FILE SIZE` writes a small
// file (the smoke never boots it — it only has to exist and be non-empty).
writeFileSync(QEMU_IMG_STUB, [
  '#!/bin/sh',
  'if [ "$1" = "create" ]; then',
  '  shift',
  '  while [ "$#" -gt 0 ]; do',
  '    case "$1" in -f|-b) shift 2;; -F) shift 2;; *) FILE="$1"; shift;; esac',
  '  done',
  '  printf "stub qcow2" > "$FILE"',
  '  exit 0',
  'fi',
  'cp "$4" "$5"',
  ''
].join('\n'))
chmodSync(QEMU_IMG_STUB, 0o755)
// ssh-keygen writes the pair the create expects.
const SSH_KEYGEN_STUB = path.join(HOME, '.cua', 'bin', 'ssh-keygen')
writeFileSync(SSH_KEYGEN_STUB, [
  '#!/bin/sh',
  'while [ "$#" -gt 0 ]; do case "$1" in -f) KEY="$2"; shift 2;; *) shift;; esac; done',
  'printf "PRIVATE" > "$KEY"',
  'printf "ssh-ed25519 AAAA stub\n" > "$KEY.pub"',
  ''
].join('\n'))
chmodSync(SSH_KEYGEN_STUB, 0o755)
const STUB_BIN = path.dirname(QEMU_IMG_STUB)
// The supervisor spawns this and only needs a pid; it exits at once, which is
// exactly the "install died" case the state machine has to survive.
const FAKE_QEMU = path.join(STUB_BIN, 'qemu-system-x86_64')
writeFileSync(FAKE_QEMU, '#!/bin/sh\nexit 0\n')
chmodSync(FAKE_QEMU, 0o755)

const child = spawn(process.execPath, [path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')], {
  env: {
    ...process.env,
    CUA_VM_STORE: STORE,
    CUA_VM_HOME: HOME,
    CUA_SUPERVISOR_SOCK: SOCK,
    CUA_BIN: STUB,
    CUA_WORKSPACE_ROOT: '/workspace',
    // The Windows create path runs on this host (no qemu/OVMF/swtpm), so the
    // documented self-test hook reports the capabilities present and the stub
    // binaries stand in for qemu-img/ssh-keygen.
    DSH_CUA_WINDOWS_FAKE_HOST_CAPS: '1',
    // The OEM payload ships in the image at /usr/local/share/cua-vm/windows-oem;
    // in a checkout it is right there in the repository.
    DSH_CUA_WINDOWS_OEM_DIR: path.join(REPO, 'docker', 'windows-oem'),
    DSH_CUA_WINDOWS_QEMU: path.join(STUB_BIN, 'qemu-system-x86_64'),
    PATH: `${STUB_BIN}:${process.env.PATH ?? ''}`,
    DSH_CUA_VM_WINDOWS: '1',
    PNG_SOURCE
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += chunk })

const waitFor = async (predicate, ms = 15000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const call = (payload) => new Promise((resolve, reject) => {
  const socket = net.connect(SOCK)
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
  socket.on('data', (chunk) => { buffer += chunk })
  socket.on('close', () => {
    try { resolve(JSON.parse(buffer.split('\n')[0])) } catch (error) { reject(error) }
  })
  socket.on('error', reject)
})

// F1: `checkpointDiskFile` shells out to qemu-img. This host has none, so the
// stub flattens by copying — the CALL SITE and the restore bookkeeping are what
// the tests are about, not qemu's converter.

try {
  const up = await waitFor(() => existsSync(SOCK))
  check('supervisor listens on the store socket', up)
  if (!up) throw new Error(`no socket; stderr:\n${stderr}`)

  // ---- W1: registry v2 + read migration ----
  const registry = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
  check('registry migrated to v2', registry.version === 2, `version=${registry.version}`)
  check('a v1 row keeps its fields and gains kind/backend', registry.vms[NAME]?.kind === 'linux' && registry.vms[NAME]?.backend === 'linux' && registry.vms[NAME]?.diskGb === 20)
  check('a v1 windows row is recognised by `backend`', registry.vms['win-legacy']?.kind === 'windows' && registry.vms['win-legacy']?.windowsVersion === '11')

  const ping = await call({ op: 'ping' })
  check('ping answers', ping.ok === true)

  const config = await call({ op: 'configGet' })
  check('config carries the four new keys',
    config.config.shutdownTimeoutSec === 120 && config.config.checkpointPolicy === 'shutdown' && config.config.shotsKeepDays === 7 && config.config.windowsInstallTimeoutMinutes === 60,
    JSON.stringify(config.config))

  const doctor = await call({ op: 'vmDoctor' })
  check('doctor reports hostCaps', doctor.ok && typeof doctor.hostCaps.kvm === 'string' && typeof doctor.hostCaps.docker === 'string', JSON.stringify(doctor.hostCaps ?? {}).slice(0, 120))
  check('doctor reports the windows switch', doctor.windows?.enabled === true)

  // ---- W3: shutdown of a computer whose QEMU is already gone ----
  // F1 regression guard: the LINUX call site must read the cua vmm disk.
  const linuxDiskDir = path.join(HOME, '.cua', 'vmm', 'qemu', NAME)
  mkdirSync(linuxDiskDir, { recursive: true })
  writeFileSync(path.join(linuxDiskDir, 'disk.qcow2'), 'a Linux guest disk')
  const shutdown = await call({ op: 'vmShutdown', name: NAME })
  check('shutdown succeeds for a dead QEMU', shutdown.ok === true, JSON.stringify(shutdown).slice(0, 220))
  check('shutdown records powered-off', shutdown.state === 'powered-off', `state=${shutdown.state} method=${shutdown.method}`)
  check('shutdown records a restore source', shutdown.restoreFrom?.kind === 'image' || shutdown.restoreFrom?.kind === 'checkpoint', JSON.stringify(shutdown.restoreFrom))
  check('the LINUX shutdown checkpoints its own vmm disk', shutdown.restoreFrom?.kind === 'checkpoint' && existsSync(path.join(STORE, 'checkpoints', `${NAME}.qcow2`)), JSON.stringify(shutdown.restoreFrom))
  const afterShutdown = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
  check('registry says powered-off', afterShutdown.vms[NAME]?.state === 'powered-off')
  check('a clean shutdown leaves no stale marking on its restore point', afterShutdown.vms[NAME]?.restoreFrom?.stale !== true)

  // ---- W5: start cold-boots instead of resuming ----
  const started = await call({ op: 'vmStart', name: NAME })
  check('start succeeds on a powered-off computer', started.ok === true, JSON.stringify(started).slice(0, 240))
  check('start cold-booted (no sb resume trap)', started.coldBoot === true, `bootedFrom=${started.bootedFrom}`)
  check('start deleted the restore temp', !existsSync(path.join(STORE, 'checkpoints', `${NAME}.qcow2.restore.qcow2`)))

  // ---- W2: GC ----
  const gc = await call({ op: 'vmGc', dryRun: true })
  check('gc dry run reports the unrecognised artifact', gc.ok && gc.checkpoints.some((row) => row.file.endsWith('orphan.qcow2.bak')), JSON.stringify(gc.checkpoints))
  check('gc dry run reports the expired view row', gc.ok && gc.views.length >= 1)
  check('gc dry run deleted nothing', existsSync(path.join(STORE, 'checkpoints', 'orphan.qcow2.bak')))
  const gcReal = await call({ op: 'vmGc' })
  check('gc removes the unrecognised artifact', gcReal.ok && !existsSync(path.join(STORE, 'checkpoints', 'orphan.qcow2.bak')))
  check('gc keeps the newest orphan checkpoint (a possible manual restore)', existsSync(path.join(STORE, 'checkpoints', 'orphan.qcow2')))
  check('gc removes the restore temp', !existsSync(path.join(STORE, 'checkpoints', `${NAME}.qcow2.restore.qcow2`)))
  check('gc cleared the expired view row', gcReal.ok && Object.keys(JSON.parse(readFileSync(path.join(STORE, 'views.json'), 'utf8'))).length === 0)
  check('gc left the registered checkpoint alone', existsSync(path.join(STORE, 'checkpoints', `${NAME}.qcow2`)))
  check('gc healed an interrupted convert instead of deleting it', existsSync(path.join(STORE, 'checkpoints', 'ws-heal.qcow2')) && !existsSync(path.join(STORE, 'checkpoints', 'ws-heal.qcow2.tmp')))

  // ---- W2: the delete manifest ----
  const deleted = await call({ op: 'vmDelete', name: NAME })
  const items = deleted.items ?? []
  const statusOf = (fragment) => items.find((item) => item.target.includes(fragment))?.status ?? 'missing'
  check('delete reports every manifest item', deleted.ok === true && items.length >= 7, `${items.length} item(s)`)
  check('delete removed the checkpoint', statusOf('checkpoints') !== 'missing' && !readdirSync(path.join(STORE, 'checkpoints')).some((f) => f.startsWith(`${NAME}.qcow2`)))
  check('delete removed the screenshots', !existsSync(path.join(STORE, 'shots', `${NAME}-1.png`)), statusOf('shots'))
  check('delete removed the trajectory directory', !existsSync(path.join(HOME, '.cua', 'trajectories', `local_${NAME}`)))
  check('delete removed the qemu directory', !existsSync(VM_DIR))
  check('delete removed the registry row', JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[NAME] === undefined)
  check('delete still reports a failed sb rm as an item, not a throw', deleted.failures === 0, `failures=${deleted.failures}`)

  // ---- W2: quota refuses used + requested ----
  const setQuota = await call({ op: 'configSet', config: { diskQuotaGb: 1 } })
  check('configSet clamps and stores the quota', setQuota.ok && setQuota.config.diskQuotaGb === 1)
  const refused = await call({ op: 'vmCreate', name: 'too-big', diskGb: 40, rea: true })
  check('a create that would exceed the quota is refused before it starts', refused.ok === false, String(refused.error).slice(0, 160))

  // ---- W6: windows create is refused without an engine ----
  const win = await call({ op: 'vmWindowsCreate', name: 'win-box', kind: 'windows' })
  check('windows create answers (installing or a structured engine error)', typeof win.ok === 'boolean', win.ok ? 'created' : String(win.error).slice(0, 120))

  // ---- W6: the refusals ----
  const winRea = await call({ op: 'vmWindowsCreate', name: 'win-rea', kind: 'windows', rea: true })
  check('windows refuses REA explicitly', winRea.ok === false && /REA is not available for Windows/u.test(winRea.error ?? ''))
  const winAndroid = await call({ op: 'vmWindowsCreate', name: 'win-android', kind: 'windows', android: true })
  check('windows refuses Android explicitly', winAndroid.ok === false && /Android is not available for Windows/u.test(winAndroid.error ?? ''))

  const status = await call({ op: 'status' })
  check('status still answers after all of that', status.ok === true)

  // ---- D2: a name is a path segment; the dispatcher refuses the rest ----
  const canary = path.join(os.tmpdir(), `cua-canary-${process.pid}`)
  mkdirSync(canary, { recursive: true })
  writeFileSync(path.join(canary, 'keep.txt'), 'must survive')
  for (const evil of ['../../tmp', '../x', '/etc', 'a/b', '..', 'WS-UPPER']) {
    const answer = await call({ op: 'vmDelete', name: evil })
    check(`delete refuses the name "${evil}"`, answer.ok === false && /invalid computer name/u.test(answer.error ?? ''), String(answer.error).slice(0, 80))
  }
  const traversal = await call({ op: 'vmDelete', name: `../../${path.basename(canary)}` })
  check('a traversal name never reaches the canary directory', traversal.ok === false && existsSync(path.join(canary, 'keep.txt')))
  check('no path outside the store was touched', readdirSync(os.tmpdir()).some((entry) => entry.startsWith('cua-canary-')))

  // ---- D4: measuring switches the target FIRST, then captures ----
  writeFileSync(STUB_LOG, '')
  writeFileSync(path.join(STORE, 'registry.json'), JSON.stringify({
    version: 2,
    vms: { 'ws-space': { workspace: '/workspace', kind: 'linux', backend: 'linux', state: 'ready', cpu: 2, memory: 4, image: 'linux', diskGb: 20 } }
  }, null, 2) + '\n')
  const spaceAnswer = await call({ op: 'vmSpace', name: 'ws-space' })
  const calls = readFileSync(STUB_LOG, 'utf8').trim().split('\n').filter(Boolean)
  const switchAt = calls.findIndex((line) => line.includes('do switch local:ws-space'))
  const shotAt = calls.findIndex((line) => line.includes('do screenshot'))
  check('vmSpace answers with the measured line', spaceAnswer.ok === true && spaceAnswer.line === 'screenshot 1200x750 · display 1280x800 · scale 1.0667', spaceAnswer.line ?? spaceAnswer.error)
  check('the warning names the ratio', /image px = 0.9375 × display px; cua maps it — do not rescale/u.test(spaceAnswer.warning ?? ''), spaceAnswer.warning)
  check('it switched the cua target before capturing', switchAt !== -1 && shotAt !== -1 && switchAt < shotAt, `switch@${switchAt} shot@${shotAt}`)

  // ---- D5: a shutdown and a burst of execs cannot resurrect a stale row ----
  writeFileSync(path.join(STORE, 'registry.json'), JSON.stringify({
    version: 2,
    vms: { 'ws-race': { workspace: '/workspace', kind: 'linux', backend: 'linux', state: 'ready', cpu: 2, memory: 4, image: 'linux', diskGb: 20 } }
  }, null, 2) + '\n')
  const burst = Array.from({ length: 12 }, () => call({ op: 'exec', name: 'ws-race', cmd: 'true', timeout: 5 }))
  const shutdownRace = call({ op: 'vmShutdown', name: 'ws-race' })
  await Promise.all([...burst, shutdownRace])
  const raced = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms['ws-race']
  check('the shutdown state survives a concurrent exec burst', raced?.state === 'powered-off', `state=${raced?.state}`)
  check('the execs still recorded lastUsed', typeof raced?.lastUsed === 'string')

  // ---- D3: a live process with no QMP is NOT checkpointed ----
  //
  // The failure this covers: "QMP unreachable" was read as "the computer is
  // off", and qemu-img then converted a disk a running QEMU still held open and
  // offered it back as a clean restore point. A real `sleep` stands in for the
  // live QEMU: pidAlive() is the question, and the answer for a live pid must be
  // "abandoned", not "already-off".
  const zombieMd = { spawned: spawn('sleep', ['120'], { stdio: 'ignore' }) }
  const zombieName = 'ws-zombie'
  const zombieDir = path.join(HOME, '.cua', 'vmm', 'qemu', zombieName)
  mkdirSync(zombieDir, { recursive: true })
  writeFileSync(path.join(zombieDir, 'cmdline'), `qemu-system-x86_64 -name ${zombieName} -qmp tcp:127.0.0.1:39597,server=on,wait=off\n`)
  writeFileSync(path.join(zombieDir, 'qemu.pid'), `${zombieMd.spawned.pid}\n`)
  writeFileSync(path.join(zombieDir, 'disk.qcow2'), 'open elsewhere')
  writeFileSync(path.join(STORE, 'checkpoints', `${zombieName}.qcow2`), 'a checkpoint from an older shutdown')
  writeFileSync(path.join(STORE, 'registry.json'), JSON.stringify({
    version: 2,
    vms: {
      // A computer that had shut down cleanly once already: it owns a restore
      // point, and THAT is the row field the abandoned branch must distrust.
      [zombieName]: {
        workspace: '/workspace', kind: 'linux', backend: 'linux', state: 'ready', cpu: 2, memory: 4, image: 'linux', diskGb: 20,
        restoreFrom: { kind: 'checkpoint', file: path.join(STORE, 'checkpoints', `${zombieName}.qcow2`) }
      }
    }
  }, null, 2) + '\n')
  writeFileSync(STUB_LOG, '')
  const zombieShutdown = await call({ op: 'vmShutdown', name: zombieName })
  check('a live process with no QMP REFUSES the shutdown', zombieShutdown.ok === false && /still running/u.test(zombieShutdown.error ?? ''), String(zombieShutdown.error).slice(0, 120))
  check('the refusal says nothing was removed', /nothing was removed/u.test(zombieShutdown.error ?? ''))
  const zombieRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[zombieName]
  check('the computer is NOT recorded as powered-off', zombieRow?.state === 'ready', `state=${zombieRow?.state}`)
  check('the failed attempt is recorded on the row', zombieRow?.lastShutdown?.method === 'abandoned', JSON.stringify(zombieRow?.lastShutdown))
  // The marking is PRODUCED here (this is the only writer of `stale`), which is
  // what makes Start's refusal a live branch instead of dead code.
  check('the existing restore point is marked stale, with a reason', zombieRow?.restoreFrom?.stale === true && /QEMU held the disk/u.test(zombieRow?.restoreFrom?.staleReason ?? ''), JSON.stringify(zombieRow?.restoreFrom))
  check('the disk was never converted', existsSync(path.join(STORE, 'checkpoints', `${zombieName}.qcow2`)) && readFileSync(path.join(STORE, 'checkpoints', `${zombieName}.qcow2`), 'utf8') === 'a checkpoint from an older shutdown')
  const zombieCalls = readFileSync(STUB_LOG, 'utf8')
  check('no sandbox was removed while QEMU is alive', !zombieCalls.includes(`sb rm --local ${zombieName}`), zombieCalls.trim().split('\n').slice(-2).join(' | '))
  try { zombieMd.spawned.kill('SIGKILL') } catch {}

  // The READ half, on the row the shutdown above just marked. `powered-off` is
  // the state an older build left behind (it removed the sandbox before it knew
  // the disk was open), so Start takes the cold-boot path and must refuse the
  // checkpoint it was told to distrust.
  const seeded = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
  seeded.vms[zombieName].state = 'powered-off'
  writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(seeded, null, 2)}\n`)
  const staleStart = await call({ op: 'vmStart', name: zombieName })
  check('Start refuses the stale restore point and boots the base image', staleStart.ok === true && staleStart.bootedFrom === 'image', `bootedFrom=${staleStart.bootedFrom}`)
  check('Start says why it did not use the checkpoint', /could not prove the guest had stopped/u.test(staleStart.detail ?? ''), String(staleStart.detail).slice(0, 100))
  const afterStaleStart = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[zombieName]
  check('the stale marking is cleared once the computer is running again', afterStaleStart?.restoreFrom === undefined, JSON.stringify(afterStaleStart?.restoreFrom))

  // ---- S2: mayBeTorn is READ, not just written ----
  {
    const tornName = 'ws-torn'
    writeFileSync(path.join(STORE, 'checkpoints', `${tornName}.qcow2`), 'a torn image')
    writeFileSync(path.join(STORE, 'registry.json'), JSON.stringify({
      version: 2,
      vms: {
        [tornName]: {
          workspace: '/workspace', kind: 'linux', backend: 'linux', state: 'powered-off',
          cpu: 2, memory: 4, image: 'linux', diskGb: 20, mayBeTorn: true,
          restoreFrom: { kind: 'checkpoint', file: path.join(STORE, 'checkpoints', `${tornName}.qcow2`) }
        }
      }
    }, null, 2) + '\n')
    const tornStart = await call({ op: 'vmStart', name: tornName })
    check('a mayBeTorn checkpoint is NOT booted', tornStart.ok === true && tornStart.bootedFrom === 'image', `bootedFrom=${tornStart.bootedFrom}`)
    check('Start explains the torn image', /force-quit|may be torn/u.test(tornStart.detail ?? ''), String(tornStart.detail).slice(0, 110))
  }

  // ---- S10: two creates cannot both pass the quota check ----
  {
    await call({ op: 'configSet', config: { diskQuotaGb: 45, maxRunning: 4 } })
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify({ version: 2, vms: {} }, null, 2)}\n`)
    const [a, b] = await Promise.all([
      call({ op: 'vmCreate', name: 'ws-q1', diskGb: 40, image: 'linux' }),
      call({ op: 'vmCreate', name: 'ws-q2', diskGb: 40, image: 'linux' })
    ])
    const okCount = [a, b].filter((answer) => answer.ok === true).length
    const refused = [a, b].filter((answer) => answer.ok === false && /quota/u.test(answer.error ?? '')).length
    check('the store reservation admits exactly one of two 40 GB creates on a 45 GB quota', okCount === 1 && refused === 1, `ok=${okCount} refused=${refused}`)
    await call({ op: 'vmDelete', name: a.ok ? 'ws-q1' : 'ws-q2' })
  }

  // ---- S5/S15: a failed `sb rm` keeps the row and reports a partial delete ----
  {
    const keepName = 'ws-keep'
    writeFileSync(path.join(STORE, 'registry.json'), JSON.stringify({
      version: 2,
      vms: { [keepName]: { workspace: '/workspace', kind: 'linux', backend: 'linux', state: 'ready', cpu: 2, memory: 4, image: 'linux', diskGb: 20 } }
    }, null, 2) + '\n')
    writeFileSync(path.join(STORE, 'stub-fail-rm'), '1')
    const partial = await call({ op: 'vmDelete', name: keepName })
    check('a failed sb rm is reported as a partial delete', partial.ok === true && partial.complete === false && partial.deleted === false, `complete=${partial.complete} deleted=${partial.deleted}`)
    check('the surviving items are listed', Array.isArray(partial.failed) && partial.failed.some((item) => /sb rm/u.test(item.target)), JSON.stringify(partial.failed))
    const keptRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[keepName]
    check('the row is KEPT and marked orphaned (the name stays visible)', keptRow?.orphaned === true, JSON.stringify(keptRow?.orphanReason))
    // cua no longer lists the sandbox, so GC reconciles the row away.
    rmSync(path.join(STORE, 'stub-fail-rm'))
    const reconcile = await call({ op: 'vmGc' })
    check('gc reconciles an orphaned row once cua stops listing the sandbox', reconcile.ok === true && !JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[keepName], JSON.stringify(reconcile.orphans))
  }


  // ---- F1: a WINDOWS computer checkpoints ITS disk, not the vmm one ----
  {
    const winName = 'ws-win-cp'
    const winDir = path.join(STORE, 'windows', winName)
    mkdirSync(winDir, { recursive: true })
    writeFileSync(path.join(winDir, 'disk.qcow2'), 'a Windows system disk')
    const reg = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    reg.vms[winName] = {
      workspace: '/workspace', kind: 'windows', backend: 'qemu', state: 'ready',
      ports: { qmp: 46999, ssh: 47998, vnc: 5997 }, diskGb: 64, cpu: 2, memory: 6,
      installComplete: true, createdAt: new Date().toISOString()
    }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(reg, null, 2)}\n`)
    const winShutdown = await call({ op: 'vmShutdown', name: winName })
    const winRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[winName]
    check('the WINDOWS shutdown checkpoints its $STORE disk', winShutdown.ok === true
      && winShutdown.checkpoint === path.join(STORE, 'checkpoints', `${winName}.qcow2`)
      && existsSync(winShutdown.checkpoint)
      && winRow?.restoreFrom?.kind === 'checkpoint'
      && winRow?.restoreFrom?.file === winShutdown.checkpoint, JSON.stringify(winShutdown).slice(0, 200))
    check('the Windows restore point is the Windows disk, not the Linux one', (() => {
      const before = statSync(path.join(winDir, 'disk.qcow2')).size
      return before > 0 && winRow?.restoreFrom?.file?.includes(winName)
    })())
  }

  // ---- FLOORS ARE WARNINGS: a below-floor Windows create succeeds and warns ----
  {
    // A tiny local ISO: `windowsIso` inside the store is used directly, so the
    // create never reaches the download.
    mkdirSync(path.join(STORE, 'iso'), { recursive: true })
    writeFileSync(path.join(STORE, 'iso', 'tiny.iso'), 'not a real iso')
    const low = await call({
      op: 'vmWindowsCreate', name: 'ws-win-low', kind: 'windows',
      diskGb: 8, memory: 2, cpu: 1, windowsIso: 'iso/tiny.iso'
    })
    check('a below-floor Windows create succeeds', low.ok === true, JSON.stringify(low).slice(0, 200))
    check('the requested sizes are used, not clamped', low.diskGb === 8 && low.memory === 2 && low.cpu === 1,
      `disk=${low.diskGb} mem=${low.memory} cpu=${low.cpu}`)
    const codes = (low.warnings ?? []).map((warning) => warning.code).sort()
    check('the payload carries all three floor warnings', codes.join(',') === 'cpu-below-floor,disk-below-floor,memory-below-floor', codes.join(','))
    check('the disk warning says updates will fail', (low.warnings ?? []).some((warning) => /Windows Update will run out of space/u.test(warning.message)))
    const lowRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms['ws-win-low']
    check('the row keeps the warnings for the panel', Array.isArray(lowRow?.warnings) && lowRow.warnings.length === 3)
    await call({ op: 'vmDelete', name: 'ws-win-low' })

    // The default path is unchanged: omit everything → 64 GB / 6 GB / 2 vCPU,
    // no warnings.
    // The default 64 GB needs head-room in the quota this suite runs with.
    await call({ op: 'configSet', config: { diskQuotaGb: 120 } })
    const standard = await call({ op: 'vmWindowsCreate', name: 'ws-win-def', kind: 'windows', windowsIso: 'iso/tiny.iso' })
    check('omitting the sizes still gives the Windows defaults', standard.ok === true
      && standard.diskGb === 64 && standard.memory === 6 && standard.cpu === 2
      && (standard.warnings ?? []).length === 0, JSON.stringify(standard).slice(0, 200))
    await call({ op: 'vmDelete', name: 'ws-win-def' })
  }

  // ---- Z1/Z2: a cold start keeps a free port triple, and the claim is released ----
  {
    const stable = 'ws-win-stable'
    const reg = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    reg.vms[stable] = {
      workspace: '/workspace', kind: 'windows', backend: 'qemu', state: 'powered-off',
      ports: { qmp: 46996, ssh: 47995, vnc: 5994 }, diskGb: 64, cpu: 2, memory: 6,
      installComplete: true, createdAt: new Date().toISOString()
    }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(reg, null, 2)}\n`)
    const started = await call({ op: 'vmStart', name: stable })
    // QEMU is not installed in this container, so the boot fails — but the port
    // decision happens first, and that is what this asserts.
    check('a cold start with free ports does not re-allocate them', started.portsChanged === false
      && started.ports?.qmp === 46996 && started.ports?.ssh === 47995 && started.ports?.vnc === 5994, JSON.stringify(started).slice(0, 200))
    const afterRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[stable]
    check('the row keeps its port triple', afterRow?.ports?.qmp === 46996 && afterRow?.ports?.ssh === 47995 && afterRow?.ports?.vnc === 5994)
    // The claim set must not still own them: a second computer must be able to
    // allocate around this one (asserted by the absence of a "ports re-allocated"
    // decision on the *next* start).
    const again = await call({ op: 'vmStart', name: stable })
    check('a second start also keeps the triple', again.portsChanged === false, JSON.stringify(again.ports))
    const regAfter = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    delete regAfter.vms[stable]
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(regAfter, null, 2)}\n`)
  }

  // ---- X1: asking for the live view twice must not kill it ----
  {
    const viewName = 'ws-win-view'
    const reg = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    reg.vms[viewName] = { workspace: '/workspace', kind: 'windows', backend: 'qemu', state: 'ready', ports: { qmp: 46997, ssh: 47996, vnc: 5995 }, diskGb: 64, cpu: 2, memory: 6 }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(reg, null, 2)}\n`)
    const first = await call({ op: 'view', name: viewName })
    const second = await call({ op: 'view', name: viewName })
    check('the live view answers twice with the same URL', first.ok === true && second.ok === true
      && first.url === second.url && first.console === true, `${first.url} / ${second.url}`)
    // ports.json is keyed by computer name.
    check('the second call did not drop the relay row', (() => {
      try {
        const rows = JSON.parse(readFileSync(path.join(STORE, 'ports.json'), 'utf8'))
        return rows[viewName]?.url === `/vm/port/${viewName}/` && Number(rows[viewName]?.localPort) > 0
      } catch { return false }
    })())
    const regAfter = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    delete regAfter.vms[viewName]
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(regAfter, null, 2)}\n`)
  }

  // ---- H6: a Windows delete must not unlink a disk QEMU still holds ----
  {
    const liveWin = 'ws-win-live'
    const liveWinDir = path.join(STORE, 'windows', liveWin)
    mkdirSync(liveWinDir, { recursive: true })
    const sleeper = spawn('sleep', ['120'], { stdio: 'ignore' })
    writeFileSync(path.join(liveWinDir, 'qemu.pid'), `${sleeper.pid}\n`)
    writeFileSync(path.join(liveWinDir, 'disk.qcow2'), 'a live Windows disk')
    const reg = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    reg.vms[liveWin] = { workspace: '/workspace', kind: 'windows', backend: 'qemu', state: 'ready', ports: { qmp: 46998, ssh: 47997, vnc: 5996 }, diskGb: 64, cpu: 2, memory: 6 }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(reg, null, 2)}\n`)
    const winDelete = await call({ op: 'vmDelete', name: liveWin })
    check('a Windows delete skips the tree of a live QEMU', winDelete.ok === true
      && winDelete.complete === false
      && (winDelete.kept ?? []).some((item) => /windows/u.test(item.target) && /still running/u.test(item.reason)), JSON.stringify(winDelete.kept))
    check('the live Windows disk is still there', existsSync(path.join(liveWinDir, 'disk.qcow2')))
    try { sleeper.kill('SIGKILL') } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }

  // ---- R1: a KEPT disk is not a completed delete, and GC reclaims it ----
  {
    const liveName = 'ws-live'
    const sleeper = spawn('sleep', ['120'], { stdio: 'ignore' })
    const liveDir = path.join(HOME, '.cua', 'vmm', 'qemu', liveName)
    mkdirSync(liveDir, { recursive: true })
    writeFileSync(path.join(liveDir, 'qemu.pid'), `${sleeper.pid}\n`)
    writeFileSync(path.join(liveDir, 'disk.qcow2'), 'a 6 GB disk, held open')
    writeFileSync(path.join(STORE, 'registry.json'), JSON.stringify({
      version: 2,
      vms: { [liveName]: { workspace: '/workspace', kind: 'linux', backend: 'linux', state: 'ready', cpu: 2, memory: 4, image: 'linux', diskGb: 20 } }
    }, null, 2) + '\n')
    const liveDelete = await call({ op: 'vmDelete', name: liveName })
    check('a delete that keeps the disk is NOT complete', liveDelete.ok === true && liveDelete.complete === false && liveDelete.deleted === false, `complete=${liveDelete.complete}`)
    check('the kept item is named with its reason', Array.isArray(liveDelete.kept) && liveDelete.kept.some((item) => /vmm\/qemu/u.test(item.target) && /still running/u.test(item.reason)), JSON.stringify(liveDelete.kept))
    check('the disk is really still there', existsSync(path.join(liveDir, 'disk.qcow2')))
    const keptRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[liveName]
    check('the row is kept so the disk stays reachable', keptRow?.orphaned === true && /still running/u.test(keptRow?.orphanReason ?? ''), String(keptRow?.orphanReason))
    check('the panel-facing detail says partially deleted', /partially deleted/u.test(liveDelete.detail ?? ''), String(liveDelete.detail).slice(0, 80))

    // Process gone + sandbox gone -> GC reclaims the kept disk and drops the row.
    try { sleeper.kill('SIGKILL') } catch {}
    await new Promise((r) => setTimeout(r, 200))
    const reclaimed = await call({ op: 'vmGc' })
    check('gc reclaims a kept disk once QEMU is gone', reclaimed.ok === true && !existsSync(liveDir), JSON.stringify(reclaimed.orphans))
    check('the orphaned row is dropped after the reclaim', JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[liveName] === undefined)
  }

  // ---- R2: an unreadable registry still yields a structured delete ----
  {
    const keepName = 'ws-badreg'
    writeFileSync(path.join(STORE, 'registry.json'), '{ this is not json')
    const brokenDelete = await call({ op: 'vmDelete', name: keepName })
    check('a delete against a corrupt registry still answers', brokenDelete.ok === true, JSON.stringify(brokenDelete).slice(0, 120))
    check('it reports itself incomplete with the failed step', brokenDelete.complete === false && Array.isArray(brokenDelete.failed) && brokenDelete.failed.some((item) => /registry\.json/u.test(item.target)), JSON.stringify(brokenDelete.failed))
    // put a valid registry back for the checks that follow
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify({ version: 2, vms: {} }, null, 2)}\n`)
  }
} catch (error) {
  failures += 1
  console.log(` FAIL harness: ${error.message}`)
} finally {
  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  if (failures > 0) console.log(`\nsupervisor log tail:\n${stderr.split('\n').slice(-25).join('\n')}`)
  rmSync(STORE, { recursive: true, force: true })
}

/**
 * D1: A MISSING `cua` IS AN ANSWER, NOT A CRASH.
 *
 * The old error handler threw a TypeError inside the spawn 'error' listener
 * (`done(-1).error` — done returns undefined), which nothing catches: the
 * supervisor died on the first call in any image where `cua` is not on PATH.
 * This starts a SECOND supervisor with a bogus CUA_BIN and asks it the one
 * question that shells out.
 */
{
  const brokenStore = path.join(STORE, 'broken')
  mkdirSync(brokenStore, { recursive: true })
  const brokenSock = path.join(brokenStore, 's.sock')
  const broken = spawn(process.execPath, [path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')], {
    env: {
      ...process.env,
      CUA_VM_STORE: brokenStore,
      CUA_VM_HOME: path.join(brokenStore, 'home'),
      CUA_SUPERVISOR_SOCK: brokenSock,
      CUA_BIN: path.join(brokenStore, 'no-such-cua'),
      CUA_WORKSPACE_ROOT: '/workspace'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let brokenErr = ''
  broken.stderr.on('data', (chunk) => { brokenErr += chunk })
  let alive = false
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(brokenSock)) { alive = true; break }
    await new Promise((r) => setTimeout(r, 100))
  }
  const askBroken = (payload) => new Promise((resolve) => {
    const socket = net.connect(brokenSock)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', (chunk) => { buffer += chunk })
    socket.on('close', () => { try { resolve(JSON.parse(buffer.split('\n')[0])) } catch { resolve(null) } })
    socket.on('error', () => resolve(null))
  })
  const answer = alive ? await askBroken({ op: 'status' }) : null
  const stillUp = alive && broken.exitCode === null
  check('a missing cua binary does not kill the supervisor', stillUp, brokenErr.trim().split('\n').slice(-1)[0] ?? '')
  check('the call answers instead of hanging', answer !== null && answer.ok === true, JSON.stringify(answer).slice(0, 140))
  check('the answer names the missing binary', /no-such-cua/u.test(JSON.stringify(answer?.listed ?? answer?.registry ?? '')), 'listed carries the spawn error')
  try { broken.kill('SIGKILL') } catch {}
}

/**
 * R3: A CORRUPT REGISTRY MUST NOT KILL THE SUPERVISOR AT BOOT.
 *
 * `readRegistry` throws (S8), and the listen callback read it unguarded for the
 * Windows-resume loop: the socket existed, then the process exited 1, and the
 * only trace was a stack in the container log. The boot path now guards both the
 * listen callback and the idle timer.
 */
{
  const corruptStore = path.join(STORE, 'corrupt')
  mkdirSync(corruptStore, { recursive: true })
  writeFileSync(path.join(corruptStore, 'registry.json'), '{ "vms": { broken')
  const corruptSock = path.join(corruptStore, 's.sock')
  const corrupt = spawn(process.execPath, [path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')], {
    env: {
      ...process.env,
      CUA_VM_STORE: corruptStore,
      CUA_VM_HOME: path.join(corruptStore, 'home'),
      CUA_SUPERVISOR_SOCK: corruptSock,
      CUA_BIN: path.join(corruptStore, 'no-such-cua'),
      CUA_WORKSPACE_ROOT: '/workspace'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let corruptErr = ''
  corrupt.stderr.on('data', (chunk) => { corruptErr += chunk })
  let up = false
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(corruptSock)) { up = true; break }
    await new Promise((r) => setTimeout(r, 100))
  }
  await new Promise((r) => setTimeout(r, 500))
  const askCorrupt = (payload) => new Promise((resolve) => {
    const socket = net.connect(corruptSock)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', (chunk) => { buffer += chunk })
    socket.on('close', () => { try { resolve(JSON.parse(buffer.split('\n')[0])) } catch { resolve(null) } })
    socket.on('error', () => resolve(null))
  })
  const ping = up ? await askCorrupt({ op: 'ping' }) : null
  check('a corrupt registry does not kill the supervisor at boot', up && corrupt.exitCode === null, corruptErr.trim().split('\n').slice(-1)[0] ?? '')
  check('it still answers ping', ping !== null && ping.ok === true, JSON.stringify(ping).slice(0, 100))
  try { corrupt.kill('SIGKILL') } catch {}
}

console.log(failures === 0 ? '\nsmoke: PASS' : `\nsmoke: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
