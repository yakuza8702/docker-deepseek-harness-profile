#!/usr/bin/env node
/**
 * supervisor-smoke.mjs — exercise the supervisor's OWN logic against a throwaway
 * store and a stub `cua` binary. No QEMU, no /dev/kvm, no guest: everything here
 * is the bookkeeping that used to be wrong (registry migration, quota, delete
 * manifest, GC, shutdown/start state machine).
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, statSync, readdirSync, chmodSync, truncateSync } from 'node:fs'
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

/**
 * F3 (smoke): A MID-INSTALL ROW MUST NOT BE PROMOTED TO READY BY THE STATUS POLL.
 *
 * The reported defect needs TWO live peers, so both are real here: a QMP peer
 * that answers `query-status` with `running`, and a VNC socket that speaks a
 * banner (QEMU's answers from the first second of setup.exe). During Setup only
 * SSH may count — and this row deliberately has NO SSH listener, because the
 * answer file has not installed OpenSSH yet. Before the fix `vmWindowsStatus`
 * took the RUNNING path, accepted the VNC banner, wrote state:'ready' +
 * installComplete, stopped the watch and let the idle timer suspend the install.
 */
const WIN_SETUP = 'win-setup'
const freePort = () => new Promise((resolve) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
})
const winQmpPort = await freePort()
const winVncPort = await freePort()
const winSshPort = await freePort() // bound by nothing: no SSH until the answer file ran
const vncPeer = net.createServer((socket) => { try { socket.write('RFB 003.008\n') } catch {} })
await new Promise((resolve) => vncPeer.listen(winVncPort, '127.0.0.1', resolve))
// The probe the supervisor dials: `qmp_capabilities`, then one command per line.
const qmpPeer = net.createServer((socket) => {
  socket.setEncoding('utf8')
  let buffer = ''
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
      const answer = message.execute === 'query-status' ? { return: { status: 'running' } } : { return: {} }
      try { socket.write(`${JSON.stringify(answer)}\n`) } catch {}
    }
  })
  socket.on('error', () => {})
})
await new Promise((resolve) => qmpPeer.listen(winQmpPort, '127.0.0.1', resolve))
// The row's pid file points at THIS process (alive), which is what the backend
// reads — the same "pid is the truth" contract every Windows row has.
const WIN_SETUP_DIR = path.join(STORE, 'windows', WIN_SETUP)
mkdirSync(WIN_SETUP_DIR, { recursive: true })
writeFileSync(path.join(WIN_SETUP_DIR, 'qemu.pid'), `${process.pid}\n`)

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

/**
 * MTOOLS STUBS — the suite must not require the image's mtools, but the Windows
 * create path now calls buildSetupImage() and verifySetupImage() on EVERY
 * create. The fakes model the parts the code depends on:
 *
 *   mformat  create the image file and empty its manifest
 *   mcopy    record each source (recursively for $OEM$) as VIRTUAL<TAB>HOST
 *   mdir     print `::/VIRTUAL` for every recorded entry
 *   mtype    cat the HOST file a VIRTUAL path maps to
 *
 * so a create exercises the REAL build/verify contract (mdir must list
 * Autounattend.xml at the root, mtype must return the staged bytes) without a
 * 64 MiB FAT32 write per case.
 *
 * F1: EVERY CALL ARRIVES AS `-i <image>@@<byte-offset>`, the real mtools
 * partition syntax. The stubs strip the `@@…` suffix exactly like mtools does
 * and then work on the image file — that difference is not cosmetic: if a future
 * change goes back to addressing the whole file, these stubs would still pass
 * while the real build produced a partitionless disk Windows never mounts, so
 * the suffix is also asserted as PRESENT below. The real mtools build is covered by
 * tests/modules-unit.mjs when the host has mtools, and by the image itself.
 */
// NOT under STORE: the main suite removes STORE before the F3 case runs, and
// these stubs must survive for that second supervisor too.
const MTOOLS_STUB = mkdtempSync(path.join(os.tmpdir(), 'cua-mtools-stub-'))
const mformat = path.join(MTOOLS_STUB, 'mformat')
writeFileSync(mformat, `#!/bin/sh
case "$1" in --version) exit 0 ;; esac
IMG=""; prev=""
for a in "$@"; do [ "$prev" = "-i" ] && IMG="$a"; prev="$a"; done
[ -n "$IMG" ] || exit 1
case "$IMG" in *@@*) ;; *) echo "mformat stub: expected <image>@@<offset>, got $IMG" >&2; exit 9 ;; esac
IMG="\${IMG%%@@*}"
# F1: real mformat formats IN PLACE and never resizes; buildSetupImage has
# already truncated the 64 MiB image, so the stub must not empty it either
# (writeSetupMbr needs a disk of known length to compute the partition).
[ -e "$IMG" ] || : > "$IMG"
: > "$IMG.manifest"
exit 0
`, { mode: 0o755 })
const mcopy = path.join(MTOOLS_STUB, 'mcopy')
writeFileSync(mcopy, `#!/bin/sh
IMG=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-i" ]; then IMG="$a"; fi
  prev="$a"
done
[ -n "$IMG" ] || exit 1
IMG="\${IMG%%@@*}"
for src in "$@"; do
  case "$src" in -*) continue ;; ::*) continue ;; esac
  [ "$src" = "$IMG" ] && continue
  [ -e "$src" ] || continue
  if [ -d "$src" ]; then
    base="$(basename "$src")"
    find "$src" -type f | while IFS= read -r f; do
      rel="\${f#"$src"/}"
      printf '::/%s/%s\\t%s\\n' "$base" "$rel" "$f" >> "$IMG.manifest"
    done
  else
    printf '::/%s\\t%s\\n' "$(basename "$src")" "$src" >> "$IMG.manifest"
  fi
done
exit 0
`, { mode: 0o755 })
const mdir = path.join(MTOOLS_STUB, 'mdir')
writeFileSync(mdir, `#!/bin/sh
IMG=""; prev=""
for a in "$@"; do [ "$prev" = "-i" ] && IMG="$a"; prev="$a"; done
[ -n "$IMG" ] || exit 1
IMG="\${IMG%%@@*}"
[ -f "$IMG.manifest" ] || exit 1
cut -f1 "$IMG.manifest" | sort -u
exit 0
`, { mode: 0o755 })
const mtype = path.join(MTOOLS_STUB, 'mtype')
writeFileSync(mtype, `#!/bin/sh
IMG=""; prev=""; VIRT=""
for a in "$@"; do
  if [ "$prev" = "-i" ]; then IMG="$a"; fi
  case "$a" in ::*) VIRT="$a" ;; esac
  prev="$a"
done
[ -n "$IMG" ] || exit 1
IMG="\${IMG%%@@*}"
[ -f "$IMG.manifest" ] || exit 1
HOST="$(awk -F '\\t' -v key="$VIRT" '$1 == key { print $2; exit }' "$IMG.manifest")"
[ -n "$HOST" ] || exit 1
cat "$HOST"
`, { mode: 0o755 })
/**
 * THE WINDOWS QEMU STUB, AND THE THREE STARTS IT CAN SIMULATE.
 *
 * It parses the argv it was handed (`-pidfile`, `-display`) and records it, so
 * the suite can assert WHICH command line produced which outcome — that is how
 * the GPU fallback is proved to retry with `-display none` rather than merely
 * printing a warning.
 *
 *   (no marker)                 write the pidfile, then stay alive: a start that
 *                               came up (QMP is never served, so readiness stays
 *                               false — exactly a machine mid-install)
 *   $STORE/stub-qemu-die        print a QEMU-style init error and exit WITHOUT a
 *                               pidfile: the reported "died during init" start
 *   $STORE/stub-qemu-egl        fail ONLY on `-display egl-headless...`, succeed
 *                               without it: the EGL/render-node host
 *   $STORE/stub-qemu-die-late   write the pidfile, print an stderr line, exit a
 *                               moment later: a start that passes boot() and
 *                               dies under the INSTALL WATCHDOG
 */
const FAKE_QEMU = path.join(STUB_BIN, 'qemu-system-x86_64')
writeFileSync(FAKE_QEMU, `#!/bin/sh
PIDFILE=""
DISPLAY=""
prev=""
for a in "$@"; do
  case "$prev" in
    -pidfile) PIDFILE="$a" ;;
    -display) DISPLAY="$a" ;;
  esac
  prev="$a"
done
printf '%s\\n' "$*" >> "${STUB_BIN}/qemu-argv.log"
if [ -f "${STORE}/stub-qemu-die" ]; then
  echo "qemu-system-x86_64: -machine q35,accel=kvm: cannot access memory" >&2
  echo "qemu-system-x86_64: kvm_init_vcpu: failed to initialize vcpu" >&2
  exit 1
fi
case "$DISPLAY" in
  egl-headless*)
    if [ -f "${STORE}/stub-qemu-egl" ]; then
      echo "qemu-system-x86_64: egl: no drm render node available" >&2
      echo "qemu-system-x86_64: egl: render node init failed" >&2
      exit 1
    fi
    ;;
esac
if [ -n "$PIDFILE" ]; then printf '%s\\n' "$$" > "$PIDFILE"; fi
if [ -f "${STORE}/stub-qemu-die-late" ]; then
  echo "qemu-system-x86_64: qemu: could not open disk image: No space left on device" >&2
  sleep 0.4
  exit 1
fi
exec sleep 120
`, { mode: 0o755 })

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
    PATH: `${MTOOLS_STUB}:${STUB_BIN}:${process.env.PATH ?? ''}`,
    DSH_CUA_VM_WINDOWS: '1',
    // SHORT WINDOWS: the same code runs, without the suite paying 15 s + 5 s per
    // case. The numbers are the production defaults in `qemuBootWindowMs` /
    // `windowsEarlyDeathWindowMs`; only the DURATION is overridden here.
    DSH_CUA_WINDOWS_BOOT_SETTLE_MS: '2000',
    DSH_CUA_WINDOWS_EARLY_CHECK_MS: '600',
    // R1: the cdboot key schedule, shortened for the suite. The stub QEMU serves
    // no QMP, so the presses FAIL here — which is exactly the "failure to send is
    // non-fatal, log only" contract, and it still proves the schedule ran.
    DSH_CUA_WINDOWS_CDBOOT_KEYS_MS: '300,900',
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
  // THE DEVICE AND ITS ACCESS ARE TWO FACTS. `kvmUsable` used to be derived from
  // the STRING "666 (writable)" (`startsWith('6')`), which is true for a device
  // this uid cannot open — so a mounted-but-denied node read as usable.
  check('doctor separates the device from its access',
    typeof doctor.hostCaps.kvmState === 'string' && ['ok', 'missing', 'denied', 'not-device'].includes(doctor.hostCaps.kvmState)
    && typeof doctor.hostCaps.kvmUsable === 'boolean',
    JSON.stringify({ state: doctor.hostCaps.kvmState, usable: doctor.hostCaps.kvmUsable, kvm: doctor.hostCaps.kvm }))
  check('doctor quotes the mode/owner/groups it actually observed',
    (doctor.hostCaps.kvmState === 'missing' && doctor.hostCaps.kvmMode === null)
    || (typeof doctor.hostCaps.kvmMode === 'string' && /^[0-7]{4}$/u.test(doctor.hostCaps.kvmMode)
        && /^\d+:\d+$/u.test(doctor.hostCaps.kvmOwner ?? '') && Array.isArray(doctor.hostCaps.kvmGroups)),
    `${doctor.hostCaps.kvmMode} ${doctor.hostCaps.kvmOwner} [${doctor.hostCaps.kvmGroups}]`)
  check('doctor\'s kvmUsable agrees with its own state (never "DENIED but usable")',
    doctor.hostCaps.kvmUsable === (doctor.hostCaps.kvmState === 'ok'),
    `state=${doctor.hostCaps.kvmState} usable=${doctor.hostCaps.kvmUsable}`)

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

  // ---- W2: the quota counts REAL bytes; a sparse disk is a WARNING ----
  const setQuota = await call({ op: 'configSet', config: { diskQuotaGb: 1 } })
  check('configSet clamps and stores the quota', setQuota.ok && setQuota.config.diskQuotaGb === 1)
  // THE USER'S CASE. A 40 GB (and the Windows default 64 GB) qcow2 is sparse:
  // it costs a few hundred KB until the guest writes. On a store with almost
  // nothing in it the create must proceed and carry `disk-over-policy` — it
  // used to be refused for charging the VIRTUAL size against the quota.
  const sparse = await call({ op: 'vmCreate', name: 'too-big', diskGb: 40, rea: true })
  check('a virtual disk larger than the quota is created, not refused', sparse.ok === true, JSON.stringify(sparse).slice(0, 200))
  const sparseCodes = (sparse.warnings ?? []).map((warning) => warning.code)
  check('...and it carries the disk-over-policy warning', sparseCodes.includes('disk-over-policy'), sparseCodes.join(',') || 'no warnings')
  check('the policy warning says the disk is sparse and the guest may hit the ceiling',
    (sparse.warnings ?? []).some((warning) => warning.code === 'disk-over-policy'
      && /sparse/u.test(warning.message) && /real disk ceiling/u.test(warning.message)))
  const sparseRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms['too-big']
  check('the row keeps the policy warning for the panel', sparseRow?.warnings?.[0]?.code === 'disk-over-policy')
  await call({ op: 'vmDelete', name: 'too-big' })
  // REAL BYTES still refuse: 1.5 GB in the accounted store on a 1 GB policy is
  // over the quota before anything is asked for, and the sentence names the
  // real usage instead of the virtual request.
  const heavy = path.join(STORE, 'shots', 'heavy.bin')
  mkdirSync(path.dirname(heavy), { recursive: true })
  writeFileSync(heavy, '')
  truncateSync(heavy, 1536 * 1024 * 1024)
  const refused = await call({ op: 'vmCreate', name: 'really-too-big', diskGb: 8, image: 'linux' })
  check('a create on a store whose REAL usage exceeds the quota is refused', refused.ok === false, String(refused.error).slice(0, 200))
  check('the refusal names real store data, not the virtual disk size',
    /real store data/u.test(refused.error ?? '') && !/does not fit the VM store quota/u.test(refused.error ?? ''),
    String(refused.error).slice(0, 200))
  rmSync(heavy, { force: true })

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

  // ---- S10: SPARSE DISKS ARE NOT CHARGED, so they do not serialise; REAL
  // bytes are what a reservation protects (the ISO download still reserves) ----
  {
    await call({ op: 'configSet', config: { diskQuotaGb: 45, maxRunning: 4 } })
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify({ version: 2, vms: {} }, null, 2)}\n`)
    const [a, b] = await Promise.all([
      call({ op: 'vmCreate', name: 'ws-q1', diskGb: 50, image: 'linux' }),
      call({ op: 'vmCreate', name: 'ws-q2', diskGb: 50, image: 'linux' })
    ])
    // Two 50 GB sparse disks on a 45 GB policy: qcow2 metadata is all they
    // occupy, and the quota no longer pretends the virtual sizes are bytes.
    // (The old assertion here was "exactly one of two 40 GB creates is
    // admitted" — that refusal was the same virtual-size charge the user
    // reported, on the Linux path.)
    const okCount = [a, b].filter((answer) => answer.ok === true).length
    const refused = [a, b].filter((answer) => answer.ok === false && /quota/u.test(answer.error ?? '')).length
    check('two sparse 50 GB creates both proceed on a 45 GB quota', okCount === 2 && refused === 0, `ok=${okCount} refused=${refused}`)
    check('...and each carries the over-policy warning instead of a refusal',
      [a, b].every((answer) => (answer.warnings ?? []).some((warning) => warning.code === 'disk-over-policy')))
    const cleared = await Promise.all([
      call({ op: 'vmDelete', name: 'ws-q1' }),
      call({ op: 'vmDelete', name: 'ws-q2' })
    ])
    check('...and both deletes clean up', cleared.every((answer) => answer.ok === true))
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

    // ---- THE USER-REPORTED REGRESSION ----
    // Quota 15 GB (the reported policy), real usage low, Windows default disk
    // 64 GB. The old check charged the VIRTUAL 64 GB and refused with "a 64 GB
    // disk does not fit the VM store quota (15 GB)". The disk is sparse, so the
    // create must proceed and warn.
    await call({ op: 'configSet', config: { diskQuotaGb: 15 } })
    const overPolicy = await call({ op: 'vmWindowsCreate', name: 'ws-win-policy', kind: 'windows', windowsIso: 'iso/tiny.iso' })
    check('a 64 GB Windows disk on a 15 GB quota is CREATED, not refused', overPolicy.ok === true, JSON.stringify(overPolicy).slice(0, 220))
    check('...the requested 64 GB default is untouched', overPolicy.diskGb === 64, `disk=${overPolicy.diskGb}`)
    check('...and it carries disk-over-policy naming both numbers',
      (overPolicy.warnings ?? []).some((warning) => warning.code === 'disk-over-policy'
        && /requested 64 GB/u.test(warning.message) && /15 GB/u.test(warning.message) && /sparse/u.test(warning.message)),
      JSON.stringify(overPolicy.warnings ?? []).slice(0, 220))
    const policyRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms['ws-win-policy']
    check('...the row keeps the policy warning for the panel',
      (policyRow?.warnings ?? []).some((warning) => warning.code === 'disk-over-policy'))
    await call({ op: 'vmDelete', name: 'ws-win-policy' })
    // Real bytes over the policy STILL refuse, and the sentence names them.
    const heavyWin = path.join(STORE, 'shots', 'heavy-win.bin')
    mkdirSync(path.dirname(heavyWin), { recursive: true })
    writeFileSync(heavyWin, '')
    truncateSync(heavyWin, 16 * 1024 ** 3)
    const refusedWin = await call({ op: 'vmWindowsCreate', name: 'ws-win-heavy', kind: 'windows', diskGb: 8, windowsIso: 'iso/tiny.iso' })
    check('a Windows create on a store whose REAL usage exceeds the quota is refused', refusedWin.ok === false, String(refusedWin.error).slice(0, 200))
    check('the Windows refusal names real store data, not the virtual disk',
      /real store data/u.test(refusedWin.error ?? '') && !/does not fit the VM store quota/u.test(refusedWin.error ?? ''),
      String(refusedWin.error).slice(0, 200))
    check('nothing was half-created by the refused Windows create',
      JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms['ws-win-heavy'] === undefined)
    rmSync(heavyWin, { force: true })

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

  // ---- B1: the WINDOWS ROW CARRIES THE REQUESTED SPEC ----
  // The panel posts kind:'windows' to `create` → op `vmCreate` (NOT
  // vmWindowsCreate), and that path used to lose the "was this given?" flags:
  // normaliseSpec filled the LINUX defaults, windowsCreateManaged then read
  // "nothing was given" and wrote 64 GB / 6 GB / 2 vCPU over the request. The
  // user saw a 20 GB / 4 GB computer reported as 64 GB / 6 GB.
  {
    await call({ op: 'configSet', config: { diskQuotaGb: 120 } })
    const asked = await call({
      op: 'vmCreate', name: 'ws-win-asked', kind: 'windows',
      diskGb: 20, memory: 4, cpu: 2, windowsIso: 'iso/tiny.iso'
    })
    check('a Windows create through vmCreate keeps the requested disk/RAM/cpu',
      asked.ok === true && asked.diskGb === 20 && asked.memory === 4 && asked.cpu === 2,
      `disk=${asked.diskGb} mem=${asked.memory} cpu=${asked.cpu} ${asked.error ?? ''}`)
    const askedRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms['ws-win-asked']
    check('...and the ROW stores the requested spec, not the defaults',
      askedRow?.diskGb === 20 && askedRow?.memory === 4 && askedRow?.cpu === 2,
      `row disk=${askedRow?.diskGb} mem=${askedRow?.memory} cpu=${askedRow?.cpu}`)
    check('...while still carrying the below-floor warnings that name the floor',
      (askedRow?.warnings ?? []).some((warning) => warning.code === 'disk-below-floor' && /64 GB/u.test(warning.message))
      && (askedRow?.warnings ?? []).some((warning) => warning.code === 'memory-below-floor' && /6 GB/u.test(warning.message)),
      JSON.stringify((askedRow?.warnings ?? []).map((warning) => warning.code)))
    // The installing payload must show the same numbers (the panel reads them).
    const askedStatus = await call({ op: 'vmWindowsStatus', name: 'ws-win-asked' })
    check('the windowsStatus payload echoes the requested spec',
      askedStatus.ok === true && askedStatus.diskGb === 20 && askedStatus.memory === 4 && askedStatus.cpu === 2,
      `payload disk=${askedStatus.diskGb} mem=${askedStatus.memory} cpu=${askedStatus.cpu} err=${askedStatus.error}`)
    check('...and its install sentence carries the serial tail and no "undefined"',
      typeof askedStatus.installDetail === 'string'
      && !/undefined/u.test(askedStatus.installDetail)
      && Array.isArray(askedStatus.serialTail)
      && Array.isArray(askedStatus.readiness?.signals),
      JSON.stringify({ detail: askedStatus.installDetail, tail: askedStatus.serialTail }).slice(0, 200))
    await call({ op: 'vmDelete', name: 'ws-win-asked', force: true })
  }

  // ---- B2/B3: the install progress sentence, with a real serial log ----
  {
    const progName = 'ws-win-progress'
    const progDir = path.join(STORE, 'windows', progName)
    mkdirSync(progDir, { recursive: true })
    // A DEAD pid (999999): QEMU is not answering, which is exactly the state the
    // user reported. The serial log has Setup output, so the sentence must show
    // it instead of a bare phase.
    writeFileSync(path.join(progDir, 'qemu.pid'), '999999\n')
    writeFileSync(path.join(progDir, 'serial.log'), [
      'Windows Boot Manager', '', 'Loading files...', '  12%', '  47%', ''
    ].join('\n'))
    const reg = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    reg.vms[progName] = {
      workspace: '/workspace', kind: 'windows', backend: 'qemu', state: 'installing',
      ports: { qmp: 46901, ssh: 47901, vnc: 5901 }, diskGb: 20, cpu: 2, memory: 4,
      windowsVersion: '11ltsc', installComplete: false,
      createdAt: new Date(Date.now() - 11 * 60000).toISOString(), startedAt: new Date(Date.now() - 11 * 60000).toISOString()
    }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(reg, null, 2)}\n`)
    const progress = await call({ op: 'vmWindowsStatus', name: progName, tail: 5 })
    check('the installing payload never prints "undefined"', progress.ok === true
      && typeof progress.installDetail === 'string' && !/undefined/u.test(progress.installDetail), String(progress.installDetail))
    check('it does not say "QMP not running" about a probe that simply did not answer',
      !/QMP not running/u.test(progress.installDetail ?? ''), String(progress.installDetail).slice(0, 120))
    check('it names what is being watched while Setup runs',
      /serial-log tail/u.test(progress.installDetail ?? '') && /QMP/u.test(progress.installDetail ?? ''),
      String(progress.installDetail).slice(0, 160))
    check('it says how the user knows it finished',
      /badge flips to Ready/u.test(progress.installDetail ?? '') && /\/vm\/port\//u.test(progress.installDetail ?? ''),
      String(progress.installDetail).slice(0, 200))
    check('the serial tail rides along (last non-empty lines)', Array.isArray(progress.serialTail)
      && progress.serialTail.includes('47%') && progress.serialTail.length <= 5, JSON.stringify(progress.serialTail))
    check('the readiness signals are the SSH banner + QMP', Array.isArray(progress.readiness?.signals)
      && progress.readiness.signals.some((line) => /SSH banner/u.test(line))
      && progress.readiness.signals.some((line) => /QMP/u.test(line)), JSON.stringify(progress.readiness?.signals))
    check('the elapsed minutes are reported', Number(progress.elapsedMinutes) >= 10, String(progress.elapsedMinutes))
    // The row the panel reads (no status poll) carries the same tail.
    const progRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[progName]
    check('the install sentence is also on the row the panel lists',
      typeof progRow.installDetail === 'string' && !/undefined/u.test(progRow.installDetail))

    // ---- ADD-ON: a Windows delete does NOT fail on `sb rm` ----
    // The row has no cua sandbox. The old manifest ran `sb rm --local <name>
    // --force` unconditionally; with a stub that fails it, the report was
    // "Partially deleted win-test — failed: sb rm --force" and the name stayed.
    writeFileSync(path.join(STORE, 'stub-fail-rm'), 'fail the next sb rm')
    const winDel = await call({ op: 'vmDelete', name: progName })
    check('a Windows delete does not fail the manifest on sb rm',
      winDel.ok === true && !(winDel.failed ?? []).some((item) => /sb rm/u.test(item.target)), JSON.stringify(winDel.failed))
    check('...the sb rm step is recorded as not-applicable, with its reason',
      (winDel.items ?? []).some((item) => /sb rm/u.test(item.target) && item.status === 'not-applicable'), JSON.stringify(winDel.items?.slice(0, 3)))
    check('...and the delete COMPLETES: row, disk dir and ports are gone',
      winDel.complete === true && !existsSync(progDir)
      && JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[progName] === undefined,
      `complete=${winDel.complete} dir=${existsSync(progDir)}`)
    rmSync(path.join(STORE, 'stub-fail-rm'), { force: true })
  }

  // ---- ADD-ON: FORCE DELETE of a stuck install (dead pid, installing row) ----
  {
    const stuckName = 'ws-win-stuck'
    const stuckDir = path.join(STORE, 'windows', stuckName)
    mkdirSync(path.join(stuckDir, 'tpm'), { recursive: true })
    writeFileSync(path.join(stuckDir, 'disk.qcow2'), 'a stuck Windows disk')
    writeFileSync(path.join(stuckDir, 'serial.log'), 'Setup is starting\n')
    writeFileSync(path.join(stuckDir, 'qemu.pid'), '999998\n')
    const reg = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    reg.vms[stuckName] = {
      workspace: '/workspace', kind: 'windows', backend: 'qemu', state: 'installing',
      ports: { qmp: 46902, ssh: 47902, vnc: 5902 }, diskGb: 20, cpu: 2, memory: 4,
      windowsVersion: '11ltsc', installComplete: false, createdAt: new Date().toISOString()
    }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(reg, null, 2)}\n`)
    const forced = await call({ op: 'vmDelete', name: stuckName, force: true })
    check('force delete answers with its kill log', forced.ok === true && forced.force?.requested === true
      && Array.isArray(forced.force.killed), JSON.stringify(forced.force))
    check('force delete kills/verifies the process BEFORE the manifest (the kill is reported first)',
      (forced.force?.killed ?? []).length > 0 && /windows qemu/u.test(forced.force.killed[0].target)
      && forced.items?.[0]?.target === forced.force.killed[0].target,
      JSON.stringify({ killed: forced.force?.killed?.[0]?.target, firstItem: forced.items?.[0]?.target }))
    check('...pids are gone and the record says so', (forced.force?.killed ?? []).every((item) => item.status === 'removed'),
      JSON.stringify(forced.force?.killed))
    check('force delete completes: registry row gone and the disk dir gone',
      forced.complete === true
      && JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[stuckName] === undefined
      && !existsSync(stuckDir), `complete=${forced.complete} dir=${existsSync(stuckDir)}`)
    check('the ports it owned are no longer reserved by its row',
      (JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[stuckName]?.ports ?? null) === null)
  }

  // ---- R1/R2/R3/R4: THE FOUR LIVE-VERIFIED ROOT CAUSES, OVER THE SOCKET ----
  //
  // R1  OVMF reached the install CD, cdboot printed "Press any key to boot from
  //     CD or DVD", nothing pressed one, EFI_TIMEOUT, then the EFI Internal
  //     Shell. The supervisor must schedule key presses for an INSTALL boot and
  //     never for a boot of an installed disk.
  // R2  rows were written without `name`, so every pidfile path said
  //     "undefined" and a RUNNING QEMU read as dead. The row must carry the name
  //     after a create, and a migrated row must gain it.
  // R3  the backend's QMP call and the supervisor's primitive had different
  //     signatures: the host arrived as the port and probe() always said "not
  //     answering". The join is the adapter; probe() must find the live pid.
  // R4  the install argv must boot the CD first (bootindex=1) and the disk
  //     second (2).
  {
    const bootName = 'ws-win-boot'
    const argvPath = path.join(STUB_BIN, 'qemu-argv.log')
    try { rmSync(argvPath, { force: true }) } catch {}
    const before = stderr.length
    const created = await call({ op: 'vmWindowsCreate', name: bootName, kind: 'windows', windowsIso: 'iso/tiny.iso' })
    check('R1/R4: the install-phase create answers installing', created.ok === true, JSON.stringify(created).slice(0, 180))

    // R2: the row carries its own name, and the migration injects it.
    const createdRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[bootName]
    check('R2: the row carries `name` after a create', createdRow?.name === bootName, `name=${createdRow?.name}`)
    check('R2: ...and the migration injects the map key when a row has none',
      registry.vms['win-legacy']?.name === 'win-legacy', `name=${registry.vms['win-legacy']?.name}`)

    // R4: the argv of the INSTALL boot.
    const argvLines = existsSync(argvPath) ? readFileSync(argvPath, 'utf8').trim().split('\n').filter((line) => line !== '') : []
    const installArgv = argvLines.at(-1) ?? ''
    check('R4: the install argv boots the CD FIRST (bootindex=1)',
      /-device ide-cd,drive=cd0,bus=ide\.1,bootindex=1/u.test(installArgv), installArgv.slice(0, 160))
    check('R4: ...and the still-empty disk second (bootindex=2)',
      /ide-hd,drive=disk0,bus=ide\.0,bootindex=2/u.test(installArgv), installArgv.slice(0, 160))
    // S1: the create built setup.img (through mtools) and the install argv
    // attaches it AFTER the system disk, so the qcow2 remains Windows Disk 0.
    check('S1: the create built the answer disk at $STORE/windows/<name>/setup.img',
      existsSync(path.join(STORE, 'windows', bootName, 'setup.img')))
    // F1: WRITABLE, AND — SINCE THE LIVE FORENSIC ROUND — REMOVABLE. `readonly=on`
    // on an ide-hd is what QEMU 10 refused ("Block node is read-only"); more
    // importantly, a FIXED-disk root is never scanned for Autounattend.xml, so
    // the medium must report removable media (usb-storage + removable=on).
    check('F1: the install argv attaches setup.img WRITABLE as a REMOVABLE usb-storage stick',
      /-drive file=[^ ]*\/setup\.img,format=raw,if=none,id=setup0/u.test(installArgv)
      && !/id=setup0[^ ]*read-?only/u.test(installArgv)
      && /usb-storage,drive=setup0,removable=on,bus=xhci\.0/u.test(installArgv)
      && !/ide-hd,drive=setup0/u.test(installArgv), installArgv.slice(0, 200))
    // F1/F4: the media exists BEFORE the boot and is writable by the runtime
    // uid (the supervisor runs as uid 1000 in the image).
    {
      const setupPath = path.join(STORE, 'windows', bootName, 'setup.img')
      const st = existsSync(setupPath) ? statSync(setupPath) : null
      check('F1/F4: setup.img exists before boot, owner-writable, owned by this uid',
        st !== null && (st.mode & 0o200) !== 0 && st.uid === process.getuid(), st === null ? 'missing' : `mode=${(st.mode & 0o777).toString(8)} uid=${st.uid}`)
    }
    // D2: THE STICK HAS AN EXPLICIT QDEV ID, which is what makes
    // `device_del` possible at the ready transition (the CD is ejected by its
    // block node). Without it the medium could only be removed by restarting
    // the computer.
    check('D2: the install argv gives the answer stick an explicit device id (hot-unpluggable)',
      /usb-storage,drive=setup0,removable=on,bus=xhci\.0,id=setupusb/u.test(installArgv), installArgv.slice(0, 200))
    check('S1: ...declared after the system disk, and with no vvfat OEM stick',
      installArgv.indexOf('id=setup0') > installArgv.indexOf('id=disk0')
      && !/fat:ro:|id=oem0/u.test(installArgv)
      && installArgv.indexOf('usb-storage,drive=setup0') > installArgv.indexOf('qemu-xhci,id=xhci'),
      installArgv.slice(0, 200))
    // F1: THE MEDIUM IS A PARTITIONED DISK BEFORE QEMU EVER SEES IT. The create
    // calls buildSetupImage() (stubs here), which writes the MBR with a real
    // file write — so this reads bytes the production code wrote, not a stub
    // artefact. A partitionless image is the live-verified bug: the firmware
    // mounts it, Windows does not, and Setup asks for a language.
    {
      const setupPath = path.join(STORE, 'windows', bootName, 'setup.img')
      const raw = existsSync(setupPath) ? readFileSync(setupPath) : Buffer.alloc(0)
      const signature = raw.length >= 512 ? raw.toString('hex', 510, 512) : 'missing'
      const startLba = raw.length >= 512 ? raw.readUInt32LE(0x1be + 8) : -1
      const type = raw.length >= 512 ? raw[0x1be + 4] : -1
      check('F1: setup.img is PARTITIONED before boot (MBR 0x55AA, FAT32-LBA entry at LBA 2048)',
        signature === '55aa' && startLba === 2048 && type === 0x0c,
        `sig=${signature} startLba=${startLba} type=0x${Number(type).toString(16)}`)
    }
    // F2: the staged answer file names the edition, inside <OSImage> and before
    // <InstallTo>, so Setup has no "Select the operating system" page left.
    {
      const staged = readFileSync(path.join(STORE, 'windows', bootName, 'oem', 'Autounattend.xml'), 'utf8')
      // Comments are stripped: the template explains this very ordering in an
      // XML comment that names both elements and <MetaData>.
      const bare = staged.replace(/<!--[\s\S]*?-->/gu, '')
      const from = bare.indexOf('<InstallFrom>')
      const to = bare.indexOf('<InstallTo>')
      check('F2: the staged Autounattend.xml carries <InstallFrom> (/IMAGE/NAME or /IMAGE/INDEX) before <InstallTo>',
        from !== -1 && to !== -1 && from < to
        && /<Key>\/IMAGE\/(NAME|INDEX)<\/Key>/u.test(bare)
        && (bare.match(/<MetaData\b/gu) ?? []).length === 1,
        `installFrom@${from} installTo@${to}`)
      check('F2: ...and no placeholder survived into the image copy',
        !staged.includes('{{IMAGE_INSTALL}}') && !staged.includes('{{PRODUCT_KEY}}'))
      // D1 (H1): THE REAL DONE-DETECTION START. Without <UseConfigurationSet>
      // Setup never copies $OEM$ into C:\Windows\Setup\Scripts, so the
      // FirstLogonCommand launched a script that was not there (the reported
      // "Windows Script Host — Can not find script file ...Unattend.vbs") and
      // OpenSSH was never installed. Asserted on the STAGED bytes, which is what
      // the guest actually reads.
      const stagedBare = staged.replace(/<!--[\s\S]*?-->/gu, '')
      const peStart = stagedBare.indexOf('<settings pass="windowsPE">')
      const peEnd = peStart === -1 ? -1 : stagedBare.indexOf('</settings>', peStart)
      const pe = peStart === -1 || peEnd === -1 ? '' : stagedBare.slice(peStart, peEnd)
      const setupStart = pe.indexOf('<component name="Microsoft-Windows-Setup"')
      const setupEnd = setupStart === -1 ? -1 : pe.indexOf('</component>', setupStart)
      const setupComponent = setupStart === -1 || setupEnd === -1 ? '' : pe.slice(setupStart, setupEnd)
      check('D1: the staged answer file switches on UseConfigurationSet (so $OEM$ is copied)',
        /<UseConfigurationSet>true<\/UseConfigurationSet>/u.test(setupComponent)
        && (setupComponent.match(/<UseConfigurationSet\b/gu) ?? []).length === 1,
        setupComponent.includes('<UseConfigurationSet>') ? 'present' : 'MISSING')
      // D1 (H2): THE BELT. Both layers must be in the file the guest reads: the
      // $OEM$ launcher AND the drive-scanning fallback that does not depend on
      // the copy at all.
      check('D1: ...and BOTH firstboot layers are FirstLogonCommands',
        /wscript \/\/nologo C:\\Windows\\Setup\\Scripts\\Unattend\.vbs/u.test(stagedBare)
        && /for %d in \(c d e f g h\) do @if exist "%d:\\cua-firstboot\.ps1"/u.test(stagedBare)
        && /powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%d:\\cua-firstboot\.ps1"/u.test(stagedBare),
        'launcher + fallback')
    }

    // R1: the cdboot presses were SCHEDULED for the install boot. The stub serves
    // no QMP, so each one fails and is logged — never fatal, never a failed
    // create (asserted above by created.ok).
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const bootLog = stderr.slice(before)
    // FILTERED BY COMPUTER: other creates in this suite also schedule presses,
    // and a line about a different computer would make this assertion vacuous.
    const ownPresses = bootLog.split('\n').filter((line) => line.includes(`windows: ${bootName} `) && /press/u.test(line))
    check(`R1: the install boot schedules cdboot key presses for THIS computer (1.5 s window)`,
      ownPresses.length >= 1 && ownPresses.every((line) => /~300 ms|~900 ms/u.test(line)),
      ownPresses.join(' | ').slice(0, 240) || bootLog.split('\n').filter((line) => /press/u.test(line)).slice(-2).join(' | ').slice(0, 200))
    check('R1: ...a failed press is LOGGED and does not fail the create',
      ownPresses.some((line) => /could not press enter/u.test(line) && /not fatal/u.test(line))
      && JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[bootName]?.state !== 'error',
      ownPresses.join(' | ').slice(0, 200))

    // R2/R3 END TO END: the stub QEMU wrote its pidfile and is still alive. A
    // Start must FIND it (through the row's name) instead of spawning a second
    // QEMU — that is only possible if probe() resolved the pidfile AND the QMP
    // contract was joined.
    const startedAgain = await call({ op: 'vmStart', name: bootName })
    check('R2: a live QEMU is found through its row (no second process, ports kept)',
      startedAgain.ok === true && startedAgain.state === 'booting' && startedAgain.portsChanged === false,
      JSON.stringify(startedAgain).slice(0, 220))
    const afterBootRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[bootName]
    check('R2: ...the row still has its name and its ports',
      afterBootRow?.name === bootName && Number(afterBootRow?.ports?.qmp) > 0,
      JSON.stringify({ name: afterBootRow?.name, ports: afterBootRow?.ports }))
    // R3: probe() reached QMP (the stub answers nothing, so the QMP state must be
    // the honest "not answering" with the pid found — never "no qemu").
    const status = await call({ op: 'vmWindowsStatus', name: bootName })
    check('R3: windowsStatus answers with the joined QMP contract (not a crash, not "no qemu")',
      status.ok === true && typeof status.installDetail === 'string' && !/undefined/u.test(status.installDetail)
      && !/no QEMU process is running/u.test(status.installDetail),
      String(status.installDetail).slice(0, 200))

    // R1 (the other half): a boot of an INSTALLED disk must send no keys. The
    // same row, now with installComplete true and a disk on the store.
    //
    // F2 NOTE — THE FIXTURE IS MARKED INSTALLED *BEFORE* THE SHUTDOWN. This row
    // still says `installing` up to here, which is a guest in WinPE: the backend
    // now gives such a row a SHORT powerdown window and then `quit`, because a
    // Setup screen has no ACPI handler and its disk must be marked mayBeTorn.
    // That is right for a real install and wrong for THIS fixture, which is
    // about the INSTALLED disk's next start (and whose stub QEMU is a bare
    // `sleep 120` that only ever exits by itself). Marking it installed first
    // also keeps the shutdown on the normal 120 s path, exactly as before.
    const installedRow = (() => {
      const reg = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
      reg.vms[bootName] = { ...reg.vms[bootName], installComplete: true, state: 'powered-off' }
      writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(reg, null, 2)}\n`)
      return reg.vms[bootName]
    })()
    check('R1: the installed-disk fixture is in place', installedRow?.installComplete === true)
    await call({ op: 'vmShutdown', name: bootName })
    const beforeInstalled = stderr.length
    const installedStart = await call({ op: 'vmStart', name: bootName })
    await new Promise((resolve) => setTimeout(resolve, 900))
    const installedLog = stderr.slice(beforeInstalled)
    // FOLLOW THE QEMU CHILD, NOT THE ANSWER: the stub serves no QMP, so a COLD
    // start's own `running` proof fails even though the process is healthy. What
    // this asserts is the KEY BEHAVIOUR — no presses for an installed disk — and
    // that the boot really reached the spawn (its argv is on the log).
    check('R1: a boot of an INSTALLED disk sends NO cdboot keys',
      !/press enter|pressed enter|could not press/u.test(installedLog),
      installedLog.split('\n').filter((line) => /press|qemu started/u.test(line)).join(' | ').slice(0, 200) || String(installedStart.error).slice(0, 160))
    check('R1: ...and that start really spawned QEMU (so the absence of keys is meaningful)',
      /qemu started/u.test(installedLog), installedLog.split('\n').filter((line) => /qemu started/u.test(line)).join(' | ').slice(0, 160))
    // R4: and its argv boots the DISK first.
    const postLines = readFileSync(argvPath, 'utf8').trim().split('\n').filter((line) => line !== '')
    const postArgv = postLines.at(-1) ?? ''
    check('R4: the post-install argv boots the disk FIRST and attaches no CD',
      /ide-hd,drive=disk0,bus=ide\.0,bootindex=1/u.test(postArgv) && !postArgv.includes('id=cd0'), postArgv.slice(0, 160))
    await call({ op: 'vmDelete', name: bootName, force: true })
  }

  // ---- F1/F2: A DEAD QEMU IS AN ERROR NOW, WITH ITS OWN STDERR ----
  // The user's create "win-test" died inside QEMU's init: the supervisor logged
  // "qemu started (pid 906, installing)", the serial log stayed 0 bytes, the
  // pidfile was never written, and the row sat at "installing" for the whole
  // 60-minute timeout before flipping to `error` with an empty tail. QEMU's own
  // diagnosis went to /dev/null, so nothing on the host explained it.
  {
    // (a) A CREATE THAT DIES AT INIT: answered as a failure, with the captured
    // stderr inline — and no row, so nothing waits for a computer that is not
    // there. The stub QEMU prints a KVM-style init error and exits before
    // writing its pidfile.
    writeFileSync(path.join(STORE, 'stub-qemu-die'), '1')
    const died = await call({ op: 'vmWindowsCreate', name: 'ws-win-die', kind: 'windows', windowsIso: 'iso/tiny.iso' })
    check('a create whose QEMU dies at init FAILS instead of reporting "installing"',
      died.ok === false, JSON.stringify(died).slice(0, 200))
    check('F1: the failure carries QEMU\'s own stderr lines',
      /cannot access memory|kvm_init_vcpu/u.test(died.error ?? ''), String(died.error).split('\n').slice(0, 2).join(' / '))
    check('F1: ...and names qemu-stderr.log as the place to look',
      /qemu-stderr\.log/u.test(died.error ?? ''), String(died.error).slice(0, 160))
    check('F2: no row is left behind for a QEMU that never started',
      JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms['ws-win-die'] === undefined)
    rmSync(path.join(STORE, 'stub-qemu-die'), { force: true })

    // (b) A START THAT PASSES boot() AND DIES A MOMENT LATER: the row must carry
    // the stderr excerpt, not "did not reach running (see its serial log)".
    const lateName = 'ws-win-late'
    const lateDir = path.join(STORE, 'windows', lateName)
    mkdirSync(lateDir, { recursive: true })
    writeFileSync(path.join(lateDir, 'disk.qcow2'), 'a Windows disk')
    writeFileSync(path.join(lateDir, 'serial.log'), '')
    const reg = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    reg.vms[lateName] = {
      workspace: '/workspace', kind: 'windows', backend: 'qemu', state: 'powered-off',
      ports: { qmp: 46903, ssh: 47903, vnc: 5903 }, diskGb: 20, cpu: 2, memory: 4,
      isoPath: path.join(STORE, 'iso', 'tiny.iso'), installComplete: false,
      createdAt: new Date().toISOString()
    }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(reg, null, 2)}\n`)
    writeFileSync(path.join(STORE, 'stub-qemu-die-late'), '1')
    const lateStart = await call({ op: 'vmStart', name: lateName })
    rmSync(path.join(STORE, 'stub-qemu-die-late'), { force: true })
    const lateRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[lateName]
    check('a start whose QEMU dies immediately ends in state error, not booting',
      lateStart.ok === false && lateRow?.state === 'error', `${lateStart.ok} ${lateRow?.state}`)
    check('F1: the row keeps the captured QEMU stderr for the panel',
      /No space left on device/u.test(lateRow?.errorLog ?? ''), String(lateRow?.errorLog).slice(0, 120))
    const lateStatus = await call({ op: 'vmWindowsStatus', name: lateName })
    check('F4: the status sentence of a dead row is not blank and not "undefined"',
      typeof lateStatus.installDetail === 'string' && !/undefined/u.test(lateStatus.installDetail), String(lateStatus.installDetail).slice(0, 120))
    await call({ op: 'vmDelete', name: lateName, force: true })
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
  // ---- F3 (smoke): the status poll does NOT promote a mid-install row ----
  //
  // Real QMP peer answering `running`, real VNC peer answering a banner, NO SSH
  // listener: exactly the live shape that used to read as ready. The row is
  // written HERE (not in the fixture registry) because the checks above count
  // `maxRunning` and the earlier cases rebuild registry.json from scratch.
  {
    writeFileSync(path.join(STORE, 'registry.json'), JSON.stringify({
      version: 2,
      vms: {
        [WIN_SETUP]: {
          workspace: '/w4', kind: 'windows', backend: 'qemu', state: 'installing', cpu: 2, memory: 4,
          windowsVersion: '11', diskGb: 64,
          createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
          ports: { qmp: winQmpPort, ssh: winSshPort, vnc: winVncPort }
        }
      }
    }, null, 2) + '\n')
    const setupStatus = await call({ op: 'vmWindowsStatus', name: WIN_SETUP, tail: 3 })
    check('F3: an installing row with a live VNC banner and NO SSH stays `installing`',
      setupStatus.ok === true && setupStatus.state === 'installing', `state=${setupStatus.state}`)
    check('F3: ...and the poll records no installComplete',
      JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[WIN_SETUP]?.installComplete !== true)
    check('F3: ...its readiness sentence still waits for the SSH banner, never claims ready',
      /SSH banner cannot answer until the answer file/u.test(String(setupStatus.installDetail ?? '')),
      String(setupStatus.installDetail ?? '').slice(0, 160))
    // Put the registry back the way the harness left it for the teardown.
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify({ version: 2, vms: {} }, null, 2)}\n`)
  }

  // ---- F1 (smoke): every action the PANEL sends has a case in the plugin ----
  //
  // The `/cua` switch is the one hop the supervisor tests cannot reach: it lives
  // in the plugin, and a missing `case` answers 404 "unknown action" without the
  // supervisor seeing anything. `suspend` was exactly that. This parity check is
  // the cheap end-to-end cover for the dispatch layer.
  {
    const clientSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'client.js'), 'utf8')
    const indexSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
    const sent = [...new Set([...clientSource.matchAll(/api\('([a-zA-Z]+)'/gu)].map((match) => match[1]))]
    const cases = new Set([...indexSource.matchAll(/case '([a-zA-Z]+)':/gu)].map((match) => match[1]))
    const unrouted = sent.filter((action) => !cases.has(action))
    check('F1: every panel action (suspend included) has a case in the /cua switch',
      unrouted.length === 0, `unrouted: ${unrouted.join(',') || 'none'} (panel sends ${sent.length}, switch has ${cases.size})`)
    check('F1: `suspend` is dispatched to the supervisor suspend op',
      /case 'suspend': return send\(200, \{ ok: true, \.\.\.\(await call\(\{ op: 'suspend'/u.test(indexSource))
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


// ---- KVM DEVICE: the two cases the user's report could not tell apart ----
//
// A second supervisor with `DSH_CUA_KVM_DEVICE` pointing at a path that does not
// exist proves the MISSING case end to end, through the real create handler —
// and proves the message is the ENOENT one, not the group/gid one. The DENIED
// case cannot be produced on a host whose /dev/kvm is 0666 (nor on one without
// it), so it is covered with stubbed stat/access in tests/modules-unit.mjs; that
// split is reported NOT RUN live, with the reason.
{
  const kvmStore = path.join(STORE, 'kvm-device')
  mkdirSync(kvmStore, { recursive: true })
  const kvmSock = path.join(kvmStore, 's.sock')
  const kvmSup = spawn(process.execPath, [path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')], {
    env: {
      ...process.env,
      CUA_VM_STORE: kvmStore,
      CUA_VM_HOME: path.join(kvmStore, 'home'),
      CUA_SUPERVISOR_SOCK: kvmSock,
      CUA_BIN: STUB,
      CUA_WORKSPACE_ROOT: '/workspace',
      DSH_CUA_VM_WINDOWS: '1',
      // NO fake caps: the probe must answer honestly.
      DSH_CUA_WINDOWS_FAKE_HOST_CAPS: '',
      // The device the probe is pointed at does not exist on any host.
      DSH_CUA_KVM_DEVICE: '/dev/dsh-no-such-kvm',
      DSH_CUA_WINDOWS_OEM_DIR: path.join(REPO, 'docker', 'windows-oem'),
      // The REAL system tools this host has: the point of this block is the
      // DEVICE, so qemu/OVMF/swtpm must not be the first thing to fail.
      PATH: `${MTOOLS_STUB}:${STUB_BIN}:${process.env.PATH ?? ''}`,
      PNG_SOURCE
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let kvmErr = ''
  kvmSup.stderr.on('data', (chunk) => { kvmErr += chunk })
  let kvmUp = false
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(kvmSock)) { kvmUp = true; break }
    await new Promise((r) => setTimeout(r, 100))
  }
  const askKvm = (payload) => new Promise((resolve) => {
    const socket = net.connect(kvmSock)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', (chunk) => { buffer += chunk })
    socket.on('close', () => { try { resolve(JSON.parse(buffer.split('\n')[0])) } catch { resolve(null) } })
    socket.on('error', () => resolve(null))
  })
  check('a supervisor with a missing KVM device still starts', kvmUp, kvmErr.trim().split('\n').slice(-1)[0] ?? '')
  if (kvmUp) {
    const doctorMissing = await askKvm({ op: 'vmDoctor' })
    check('doctor says the device is ABSENT (not "DENIED")',
      doctorMissing?.hostCaps?.kvmState === 'missing' && /absent \(device not mounted\)/u.test(doctorMissing?.hostCaps?.kvm ?? ''),
      `${doctorMissing?.hostCaps?.kvmState} ${doctorMissing?.hostCaps?.kvm}`)
    check('doctor never reports a missing device as usable', doctorMissing?.hostCaps?.kvmUsable === false)
    const refusedKvm = await askKvm({ op: 'vmWindowsCreate', name: 'win-nokvm', kind: 'windows' })
    check('a Windows create on a missing device is refused', refusedKvm?.ok === false)
    const text = String(refusedKvm?.error ?? '')
    check('the refusal is the ENOENT split, naming the device it probed',
      /needs \/dev\/dev\/dsh-no-such-kvm/.test(text) || /\/dev\/dsh-no-such-kvm does not exist in this container \(ENOENT\)/u.test(text),
      text.split('\n')[0])
    check('the missing-device refusal keeps the devices:/compose.emulator.yaml instruction',
      /compose\.emulator\.yaml/u.test(text) && /- \/dev\/kvm/u.test(text) && /--force-recreate/u.test(text))
    check('the missing-device refusal does NOT give the gid advice (the device is not there)',
      !/group_add/u.test(text) && !/KVM_GID/u.test(text))
    check('a missing device creates no row and downloads nothing',
      !existsSync(path.join(kvmStore, 'windows', 'win-nokvm', 'disk.qcow2'))
      && !existsSync(path.join(kvmStore, 'iso')))
  }
  try { kvmSup.kill('SIGKILL') } catch {}
}

// ---- F3: BOTH BOOT WINDOWS UNSET, AND A QEMU THAT WRITES ITS PIDFILE LATE ----
//
// THE USER'S LIVE FAILURE, THROUGH THE REAL SUPERVISOR. `qemuBootWindowMs()`
// used `Number(process.env.X ?? '')`, which turns an UNSET variable into 0 and
// accepts it (`0 >= 0`), so the production boot window was 0 ms: `boot()` polled
// once against an already-expired deadline and reported a QEMU that was ~1 ms
// old dead — "died during init (none): no stderr output" — while QEMU was still
// initializing. No suite caught it because every suite SET the window.
//
// This case sets NEITHER `DSH_CUA_WINDOWS_BOOT_SETTLE_MS` NOR
// `DSH_CUA_WINDOWS_EARLY_CHECK_MS` (both are deleted from the child env), and its
// stub QEMU writes its pidfile only after ~100 ms — longer than 0 ms, far inside
// the real 15 s default. With the old code the create fails; with the fix it
// succeeds, with the default window.
{
  const slowStore = path.join(STORE, 'slow-window')
  mkdirSync(path.join(slowStore, 'iso'), { recursive: true })
  writeFileSync(path.join(slowStore, 'iso', 'tiny.iso'), 'not a real iso')
  const slowSock = path.join(slowStore, 's.sock')
  const slowBin = path.join(slowStore, 'bin')
  mkdirSync(slowBin, { recursive: true })
  // The late-pidfile stub: it is still INITIALIZING for 100 ms — the exact moment
  // the 0 ms window used to call it dead.
  const SLOW_QEMU = path.join(slowBin, 'qemu-system-x86_64')
  writeFileSync(SLOW_QEMU, `#!/bin/sh
PIDFILE=""
prev=""
for a in "$@"; do
  [ "$prev" = "-pidfile" ] && PIDFILE="$a"
  prev="$a"
done
sleep 0.1
[ -z "$PIDFILE" ] || printf '%s\\n' "$$" > "$PIDFILE"
exec sleep 120
`, { mode: 0o755 })
  // qemu-img/ssh-keygen come from the suite's own stub dir; qemu from slowBin.
  const slow = spawn(process.execPath, [path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')], {
    env: (() => {
      const env = {
        ...process.env,
        CUA_VM_STORE: slowStore,
        CUA_VM_HOME: path.join(slowStore, 'home'),
        CUA_SUPERVISOR_SOCK: slowSock,
        CUA_BIN: STUB,
        CUA_WORKSPACE_ROOT: '/workspace',
        DSH_CUA_WINDOWS_FAKE_HOST_CAPS: '1',
        DSH_CUA_WINDOWS_OEM_DIR: path.join(REPO, 'docker', 'windows-oem'),
        DSH_CUA_WINDOWS_QEMU: SLOW_QEMU,
        DSH_CUA_VM_WINDOWS: '1',
        PATH: `${MTOOLS_STUB}:${slowBin}:${STUB_BIN}:${process.env.PATH ?? ''}`,
        PNG_SOURCE
      }
      // UNSET, not merely short: this is the production shape.
      delete env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS
      delete env.DSH_CUA_WINDOWS_EARLY_CHECK_MS
      return env
    })(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let slowErr = ''
  slow.stderr.on('data', (chunk) => { slowErr += chunk })
  let slowUp = false
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(slowSock)) { slowUp = true; break }
    await new Promise((r) => setTimeout(r, 100))
  }
  const askSlow = (payload) => new Promise((resolve) => {
    const socket = net.connect(slowSock)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', (chunk) => { buffer += chunk })
    socket.on('close', () => { try { resolve(JSON.parse(buffer.split('\n')[0])) } catch { resolve(null) } })
    socket.on('error', () => resolve(null))
  })
  check('F3: a supervisor with BOTH boot windows unset starts', slowUp, slowErr.trim().split('\n').slice(-1)[0] ?? '')
  if (slowUp) {
    const started = Date.now()
    const created = await askSlow({ op: 'vmWindowsCreate', name: 'ws-win-slow', kind: 'windows', windowsIso: 'iso/tiny.iso' })
    const elapsed = Date.now() - started
    check('F3: a QEMU whose pidfile lands ~100 ms after spawn is NOT declared dead',
      created?.ok === true, JSON.stringify(created).slice(0, 300))
    check('F3: ...the create really waited for it (>= 90 ms)',
      elapsed >= 90, `${elapsed}ms`)
    check('F3: ...and the real QEMU pidfile is on disk',
      existsSync(path.join(slowStore, 'windows', 'ws-win-slow', 'qemu.pid')))
    check('F3: ...no "died during init" line was logged',
      !/died during init/u.test(slowErr), slowErr.split('\n').filter((line) => /died during init/u.test(line)).join(' / ').slice(0, 200))
  }
  try { slow.kill('SIGKILL') } catch {}
}

console.log(failures === 0 ? '\nsmoke: PASS' : `\nsmoke: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
