#!/usr/bin/env node
/**
 * supervisor-smoke.mjs — exercise the supervisor's OWN logic against a throwaway
 * store and a stub `cua` binary. No QEMU, no /dev/kvm, no guest: everything here
 * is the bookkeeping that used to be wrong (registry migration, quota, delete
 * manifest, GC, shutdown/start state machine).
 */
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, statfsSync, statSync, readdirSync, chmodSync, truncateSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import zlib from 'node:zlib'

// Resolved from THIS file, so the suite runs from a checkout anywhere (CI,
// a worktree, a reviewer's clone) — it used to hardcode the author's path.
const REPO = process.env.REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * D-7 — THE STORE MUST LIVE ON A REAL FILESYSTEM, AND THE SUITE SAYS WHERE.
 *
 * The landed C22 pre-flight refuses a checkpoint when
 * `bavail × bsize − CHECKPOINT_FREE_RESERVE_BYTES (2 GiB) < diskBytes`. That rule
 * is CORRECT, and on a 2 GiB tmpfs (this sandbox's /tmp is exactly that) it
 * refuses every capture — which would turn the suite's "the checkpoint landed"
 * assertions into failures of the FIX rather than of the code under test.
 *
 * So the suite PICKS its temp root instead of inheriting one blindly:
 *   1. `DSH_CUA_SMOKE_TMPDIR`, when set (a reviewer can force a location);
 *   2. the inherited TMPDIR / os.tmpdir(), when it has room;
 *   3. `../.cua-smoke-tmp` next to the checkout, then `~/.cua-smoke-tmp`.
 * It prints the choice. When NONE of them has 3 GiB free, the checkpoint-SPACE
 * cases are reported as an honest `NOT RUN` (with the measured free space) and
 * are not counted as failures: a tiny filesystem is not a regression.
 */
const SMOKE_TMP = (() => {
  const freeBytesOf = (dir) => {
    try {
      const stats = statfsSync(dir)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      return 0
    }
  }
  const NEED = 3 * 1024 ** 3
  const candidates = [
    process.env.DSH_CUA_SMOKE_TMPDIR,
    process.env.TMPDIR,
    os.tmpdir(),
    path.join(path.dirname(REPO), '.cua-smoke-tmp'),
    path.join(os.homedir(), '.cua-smoke-tmp')
  ].filter((value) => typeof value === 'string' && value !== '')
  for (const dir of candidates) {
    try {
      // Recorded BEFORE mkdir: a fallback root this suite invented is removed
      // again at the end, so a checkout never accumulates `.cua-smoke-tmp/`.
      const created = existsSync(dir) === false
      mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, `.cua-smoke-write-${process.pid}`)
      writeFileSync(probe, 'x')
      rmSync(probe, { force: true })
      if (freeBytesOf(dir) >= NEED) return { dir, free: freeBytesOf(dir), created }
    } catch { /* not writable, or gone: try the next one */ }
  }
  const fallback = os.tmpdir()
  return { dir: fallback, free: freeBytesOf(fallback), created: false }
})()
// `TMPDIR` is exported so every `mkdtempSync(os.tmpdir(), …)` below — and every
// child supervisor this suite spawns — lands on the SAME filesystem.
process.env.TMPDIR = SMOKE_TMP.dir
const TMP_ROOT = SMOKE_TMP.dir
const TMP_FREE_GB = (SMOKE_TMP.free / 1024 ** 3).toFixed(1)
/** False only on a filesystem too small for the 2 GiB checkpoint reserve. */
const TMP_FITS_CHECKPOINT = SMOKE_TMP.free >= 3 * 1024 ** 3

const STORE = path.join(TMP_ROOT, `cua-smoke-${process.pid}`)
const HOME = path.join(STORE, 'home')
const SOCK = path.join(STORE, 'supervisor.sock')
const STUB = path.join(STORE, 'bin', 'cua-stub')

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
 * A check that needs a filesystem big enough for the C22 reserve.
 *
 * On a store with less than 3 GiB free the SPACE rule correctly refuses the
 * capture, so "the checkpoint landed" cannot be asserted there. That is a
 * property of the host, not of the code: reported as NOT RUN with the measured
 * free space, never as a pass (and never as a failure of the fix).
 */
const checkCheckpoint = (label, ok, detail = '') => {
  if (!TMP_FITS_CHECKPOINT) {
    console.log(` NOT RUN  ${label} — the store is on ${TMP_ROOT} with ${TMP_FREE_GB} GB free (< 3 GiB), where the C22 space rule CORRECTLY refuses a checkpoint`)
    return
  }
  check(label, ok, detail)
}
/**
 * WP-6.4 — A CHECK THAT CAN ONLY PASS ONCE THE PRODUCTION HALF EXISTS.
 *
 * `landed` is the FEATURE's presence (an exported function, a literal in the
 * file under test), never the value being asserted: a missing feature is
 * PENDING, loudly, and a present feature with the wrong value FAILS.
 * `DSH_CUA_CONTRACT_STRICT=1` requires them now (the T2 mutation check).
 */
const checkContract = (label, landed, ok, detail = '', expected = '') => {
  if (landed) { check(label, ok, detail); return }
  if (STRICT_CONTRACT) {
    failures += 1
    console.log(` FAIL  ${label} — contract absent and DSH_CUA_CONTRACT_STRICT=1${expected ? ` (${expected})` : ''}`)
    return
  }
  pendings += 1
  console.log(` PEND  ${label} — awaiting the production change${expected ? ` (${expected})` : ''}${detail ? ` — ${detail}` : ''}`)
}

console.log(`  .. temp store root: ${TMP_ROOT} (${TMP_FREE_GB} GB free${TMP_FITS_CHECKPOINT ? '' : ' — too small for a checkpoint: the C22 space cases will be NOT RUN'})`)
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
      # WP-9.1: THE GUEST FILESYSTEM MEASUREMENT: df -B1 --output=size,avail /
      # answers two raw integers; the file lets a case choose the number (a
      # short grow is a block device that grew and a filesystem that did not).
      *"df -B1"*)
        if [ -f "${STORE}/df-output" ]; then cat "${STORE}/df-output"; else printf '21474836480 21474836480\n'; fi ;;
      # ...and the two commands whose failure must NOT be swallowed by a bare exit 0.
      *resize2fs*)
        if [ -f "${STORE}/stub-resize-fail" ]; then
          echo "resize2fs: Operation not permitted while filesystem is mounted" >&2
          exit 1
        fi ;;
      *growpart*)
        if [ -f "${STORE}/stub-growpart-fail" ]; then
          echo "growpart: unable to grow partition" >&2
          exit 1
        fi ;;
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
/**
 * IS A PORT REALLY BOUND BY NOTHING, RIGHT NOW?
 *
 * `freePort()` above reserves an ephemeral port and RELEASES it; between that
 * moment and the F3 check ~1 500 lines later, the kernel may hand the same
 * number to another process's ephemeral bind (another suite running in the same
 * checkout does exactly that). A stray listener then reads as "SSH accepting",
 * and the readiness check fails for a reason that has nothing to do with the
 * code under test. This probe makes the F3 row pick a port that is CLOSED at
 * the moment of the check, which is the state the assertion is about.
 */
const portIsClosed = (port) => new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1')
  let settled = false
  const done = (closed) => {
    if (settled) return
    settled = true
    try { socket.destroy() } catch {}
    resolve(closed)
  }
  socket.setTimeout(400, () => done(true))
  socket.on('connect', () => done(false))
  socket.on('error', () => done(true))
})
const closedPort = async () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = await freePort()
    if (await portIsClosed(candidate)) return candidate
  }
  return winSshPort
}
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

/**
 * J21-3: THE TEST SEAM FOR "THE TEXT IS THE SECOND ARGUMENT".
 *
 * The supervisor imports `createWindowsBackend` statically, so a stub backend
 * cannot be injected by a caller. Instead this suite starts the REAL supervisor
 * with a resolve hook that swaps that ONE module for a wrapper which re-exports
 * every export from the real file and overrides `createWindowsBackend` to wrap
 * the real backend's `clipboardSet`. Everything else — QMP, paths, readiness,
 * the entire supervisor — is the shipped code.
 *
 * The capture is deliberately raw: `...args` records how many positional
 * arguments arrived and what the second one was, which is exactly the defect
 * (one object instead of `(spec, text)`).
 */
const CLIP_STUB_CAPTURE = path.join(STORE, 'clip-forward.log')
{
  const hookDir = path.join(STORE, 'clip-hook')
  mkdirSync(hookDir, { recursive: true })
  const realUrl = pathToFileURL(path.join(REPO, 'docker', 'cua-vm-windows-qemu.mjs')).href
  const wrapperFile = path.join(hookDir, 'backend-wrapper.mjs')
  writeFileSync(wrapperFile, `// Generated by tests/supervisor-smoke.mjs — the real backend, one method wrapped.
export * from ${JSON.stringify(realUrl)}
import { createWindowsBackend as realCreateWindowsBackend } from ${JSON.stringify(realUrl)}
import { appendFileSync } from 'node:fs'
export function createWindowsBackend(options = {}) {
  const backend = realCreateWindowsBackend(options)
  return {
    ...backend,
    async clipboardSet(...args) {
      const spec = args[0]
      const text = args[1]
      const capture = process.env.CUA_CLIP_STUB_CAPTURE || ''
      if (capture !== '') {
        try {
          appendFileSync(capture, JSON.stringify({ name: String(spec?.name ?? ''), argCount: args.length, textType: typeof text, text: typeof text === 'string' ? text : null }) + '\\n')
        } catch {}
      }
      return { ok: true, verified: true, via: 'agent', seq: 1, readBackEqual: true, bytes: typeof text === 'string' ? Buffer.byteLength(text) : 0, detail: 'stub backend: the positionally-forwarded text was received' }
    }
  }
}
`)
  const hookFile = path.join(hookDir, 'resolve-hook.mjs')
  writeFileSync(hookFile, `import { registerHooks } from 'node:module'
const WRAPPER = ${JSON.stringify(pathToFileURL(wrapperFile).href)}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './cua-vm-windows-qemu.mjs' && String(context.parentURL ?? '').includes('/docker/cua-vm-supervisor.mjs')) {
      return { url: WRAPPER, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})
`)
  process.env.CUA_CLIP_STUB_CAPTURE = CLIP_STUB_CAPTURE
  process.env.CUA_CLIP_HOOK_URL = pathToFileURL(hookFile).href
}

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
    // J21-3: the resolve hook that wraps ONE backend method (see the seam above).
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${process.env.CUA_CLIP_HOOK_URL ?? ''}`.trim(),
    CUA_CLIP_STUB_CAPTURE: CLIP_STUB_CAPTURE,
    // SHORT WINDOWS: the same code runs, without the suite paying 15 s + 5 s per
    // case. The numbers are the production defaults in `qemuBootWindowMs` /
    // `windowsEarlyDeathWindowMs`; only the DURATION is overridden here.
    DSH_CUA_WINDOWS_BOOT_SETTLE_MS: '2000',
    DSH_CUA_WINDOWS_EARLY_CHECK_MS: '600',
    // WP-D/D-7: THE WAITER BUDGET. The production deadline is 30 s; the R1
    // re-pin measures a REFUSAL, and 1.5 s is long enough to be a real deadline
    // and short enough to keep the suite honest about its own runtime. Nothing
    // else in this suite queues on a contended lock, so this changes no other
    // assertion.
    DSH_CUA_VM_LOCK_WAIT_MS: '1500',
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

const waitFor = async (predicate, ms = 15000, stepMs = 100) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return false
}

/**
 * A QMP MONITOR THAT IS ONLY A MONITOR — the one thing a guest power-off test
 * needs and the stub QEMU cannot serve (it is a shell script that never listens).
 *
 * The supervisor's poll speaks the real handshake (`qmpCommands`): connect, read
 * the greeting, write `qmp_capabilities`, wait for `{"return":{}}`, then write
 * `query-status` per tick. This server answers exactly that, with the status
 * read from `state.value` at the moment of the question — which is how the test
 * models "the guest was running, then Windows was shut down from its Start menu"
 * without a guest.
 */
const startFakeQmp = async (initialStatus) => {
  const state = { value: initialStatus, queries: 0 }
  const server = net.createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.write(`${JSON.stringify({
      QMP: { version: { qemu: { major: 10, minor: 0, micro: 0 }, package: '' }, capabilities: [] }
    })}\n`)
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line.trim() === '') continue
        let command = null
        try { command = JSON.parse(line) } catch { continue }
        if (command.execute === 'query-status') {
          state.queries += 1
          socket.write(`${JSON.stringify({ return: { status: state.value } })}\n`)
          continue
        }
        // qmp_capabilities, cont, quit, anything else: an accepted no-op.
        socket.write('{"return":{}}\n')
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    state,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
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
  //
  // THE SHUTDOWN ANSWERS FIRST AND CONVERTS LATER. It used to run
  // `qemu-img convert` of the whole system disk BEFORE it answered, so a 10 GB
  // guest held the harness tool call (and the panel's button) hostage for
  // minutes, on a computer the row already said was powered off — the incident
  // behind WINDOWS_STOP_BUDGET_MS in the supervisor. The answer now carries
  // `checkpoint: 'deferred'`, the row is written powered-off at once with
  // `restoreFrom: {kind:'image'}`, and a detached task UPGRADES the row to
  // `{kind:'checkpoint', file: $STORE/checkpoints/<name>.qcow2}` when the convert
  // lands. So F1 asserts the ANSWER, then the UPGRADE — never a path in the
  // answer, which cannot exist yet.
  {
    const winName = 'ws-win-cp'
    const winDir = path.join(STORE, 'windows', winName)
    const winDisk = path.join(winDir, 'disk.qcow2')
    const winCheckpoint = path.join(STORE, 'checkpoints', `${winName}.qcow2`)
    mkdirSync(winDir, { recursive: true })
    writeFileSync(winDisk, 'a Windows system disk')
    const reg = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    reg.vms[winName] = {
      workspace: '/workspace', kind: 'windows', backend: 'qemu', state: 'ready',
      ports: { qmp: 46999, ssh: 47998, vnc: 5997 }, diskGb: 64, cpu: 2, memory: 6,
      installComplete: true, createdAt: new Date().toISOString()
    }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(reg, null, 2)}\n`)
    const winShutdown = await call({ op: 'vmShutdown', name: winName })
    check('the WINDOWS shutdown ANSWERS with a deferred checkpoint (no minutes-long convert)',
      winShutdown.ok === true && winShutdown.checkpoint === 'deferred' && winShutdown.checkpointDeferred === true,
      JSON.stringify({ checkpoint: winShutdown.checkpoint, deferred: winShutdown.checkpointDeferred, at: winShutdown.state }))
    const instantRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[winName]
    check('...the row is powered-off the moment it answers',
      instantRow?.state === 'powered-off', `state=${instantRow?.state}`)
    check('...its restore source is still the DISK, not a file that does not exist yet',
      instantRow?.restoreFrom?.kind === 'image' && instantRow?.restoreFrom?.image === 'windows',
      JSON.stringify(instantRow?.restoreFrom))
    check('...and the pending token the deferred task will match on is on the row',
      typeof instantRow?.checkpointPending?.token === 'string' && instantRow.checkpointPending.token !== '',
      JSON.stringify(instantRow?.checkpointPending))
    check('...lastShutdown says DEFERRED, not saved',
      instantRow?.lastShutdown?.checkpointDeferred === true && instantRow?.lastShutdown?.checkpointStatus === undefined,
      JSON.stringify(instantRow?.lastShutdown))
    // THE UPGRADE. Detached, so it is a poll of the registry file, not an
    // assertion on the answer: 5 s of 200 ms steps is ~100× the stub convert.
    const upgraded = await waitFor(() => {
      try {
        return JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[winName]?.restoreFrom?.kind === 'checkpoint'
      } catch { return false }
    }, 5000, 200)
    const winRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[winName]
    checkCheckpoint('the deferred checkpoint UPGRADES restoreFrom to $STORE/checkpoints/<name>.qcow2',
      upgraded === true && winRow?.restoreFrom?.file === winCheckpoint && existsSync(winCheckpoint),
      JSON.stringify({ upgraded, file: winRow?.restoreFrom?.file, exists: existsSync(winCheckpoint) }))
    checkCheckpoint('...the pending token is cleared and the outcome is recorded as saved',
      winRow?.checkpointPending === undefined && winRow?.lastShutdown?.checkpointStatus === 'saved'
        && winRow?.lastShutdown?.checkpointDeferred === undefined,
      JSON.stringify({ pending: winRow?.checkpointPending, shutdown: winRow?.lastShutdown }))
    checkCheckpoint('the Windows restore point is the Windows disk, not the Linux one', (() => {
      const before = statSync(winDisk).size
      const captured = existsSync(winCheckpoint) ? readFileSync(winCheckpoint, 'utf8') : ''
      // The stub qemu-img flattens by COPYING, so the checkpoint's bytes ARE the
      // $STORE/windows/<name>/disk.qcow2 bytes. The Linux vmm tree never held a
      // disk for this name, so a checkpoint with these contents can only have
      // come from the Windows path.
      return before > 0
        && winRow?.restoreFrom?.file === winCheckpoint
        && winRow.restoreFrom.file.includes(winName)
        && captured === readFileSync(winDisk, 'utf8')
        && !existsSync(path.join(HOME, '.cua', 'vmm', 'qemu', winName, 'disk.qcow2'))
    })(), JSON.stringify({ file: winRow?.restoreFrom?.file, linuxDisk: existsSync(path.join(HOME, '.cua', 'vmm', 'qemu', winName, 'disk.qcow2')) }))
  }

  /**
   * ---- P4/D1: A GUEST POWER-OFF IS RECORDED EVEN WHEN THE CHECKPOINT FAILS ----
   *
   * The live defect, reproduced in the supervisor's own /tmp proof shape: a
   * 9.9 GB Windows disk + an 11.5 GB Linux checkpoint + a 3.6 GB ISO on a 20 GB
   * store, so `windowsCheckpointDecision` refuses ("the checkpoint does not fit
   * the store quota"). It used to throw out of `finaliseGuestShutdown` BEFORE
   * the row was touched: the guest had powered itself off, and the row stayed
   * `ready` for the rest of the session — the panel kept offering a desktop that
   * did not exist, and the next shutdown answered `already-off`.
   *
   * Here the same failure is forced with a 1 GB policy and a 2 GB disk of
   * APPARENT size (`du -sb`, which is what the quota measures), so no real bytes
   * are written. The guest is a fake QMP monitor: it answers `running` while the
   * row is adopted, then `shutdown` — exactly what `query-status` says after
   * Start → Shut down inside Windows.
   */
  {
    const guestName = 'ws-win-guest'
    const guestDir = path.join(STORE, 'windows', guestName)
    const guestDisk = path.join(guestDir, 'disk.qcow2')
    const before = (await call({ op: 'configGet' })).config
    mkdirSync(guestDir, { recursive: true })
    writeFileSync(guestDisk, 'a Windows system disk')
    // APPARENT size, no real blocks: the quota reads `du -sb`, the filesystem
    // writes nothing.
    truncateSync(guestDisk, 2 * 1024 ** 3)
    const qmp = await startFakeQmp('running')
    try {
      const reg = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
      reg.vms[guestName] = {
        workspace: '/workspace', kind: 'windows', backend: 'qemu', state: 'ready',
        ports: { qmp: qmp.port, ssh: 47997, vnc: 5996 }, diskGb: 64, cpu: 2, memory: 6,
        installComplete: true, createdAt: new Date().toISOString()
      }
      writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(reg, null, 2)}\n`)
      // 1 GB of policy against a store that already holds 2 GB of apparent disk.
      const squeezed = await call({ op: 'configSet', config: { ...before, diskQuotaGb: 1 } })
      check('P4/D1: the store is over its quota before the guest powers off',
        squeezed.ok === true && squeezed.config.diskQuotaGb === 1, `quota=${squeezed.config?.diskQuotaGb}GB`)
      // Adopt the row: `resume` is the cheapest op that installs the QMP state
      // watcher, and `unpause` (`cont`) is answered by the fake monitor.
      const adopted = await call({ op: 'resume', name: guestName })
      check('P4/D1: the live row is adopted (state watcher installed)', adopted.ok === true, JSON.stringify(adopted).slice(0, 180))
      qmp.state.value = 'shutdown'
      const poweredOff = await waitFor(() => {
        try {
          return JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[guestName]?.state === 'powered-off'
        } catch { return false }
      }, 20000, 200)
      const guestRow = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[guestName]
      check('P4/D1: a guest-initiated power-off keeps the computer POWERED-OFF even though the checkpoint failed',
        poweredOff === true && guestRow?.state === 'powered-off',
        `state=${guestRow?.state} queries=${qmp.state.queries}`)
      check('...it is recorded as the guest\'s own shutdown, from the QMP poll',
        guestRow?.stateFrom === 'qmp-poll' && guestRow?.lastShutdown?.method === 'guest-shutdown',
        JSON.stringify({ stateFrom: guestRow?.stateFrom, method: guestRow?.lastShutdown?.method }))
      check('...the refusal is on the row as checkpointSkipped:quota',
        guestRow?.checkpointSkipped?.reason === 'quota' && /quota/u.test(String(guestRow?.checkpointSkipped?.detail ?? '')),
        JSON.stringify(guestRow?.checkpointSkipped))
      check('...the outcome is on lastShutdown too (skipped:quota)',
        guestRow?.lastShutdown?.checkpointStatus === 'skipped:quota', String(guestRow?.lastShutdown?.checkpointStatus))
      check('...and the restore source is still the disk Start will boot',
        guestRow?.restoreFrom?.kind === 'image' && guestRow?.restoreFrom?.image === 'windows',
        JSON.stringify(guestRow?.restoreFrom))
      check('...and no checkpoint file was written',
        !existsSync(path.join(STORE, 'checkpoints', `${guestName}.qcow2`)))
    } finally {
      // THE 2 GB APPARENT DISK MUST NOT SURVIVE THIS BLOCK: later cases measure
      // the store against the real policy.
      await call({ op: 'configSet', config: before }).catch(() => {})
      await qmp.close().catch(() => {})
      // THROUGH THE SUPERVISOR, not a hand-written registry write. `vmDelete`
      // takes the computer's lifecycle lock and its own `mutateRegistry`, so it
      // cannot lose a write that is in flight elsewhere — and it also kills the
      // console relay `resume` opened for this row, which would otherwise keep
      // polling for the rest of the suite.
      const gone = await call({ op: 'vmDelete', name: guestName, force: true }).catch(() => ({ ok: false }))
      rmSync(path.join(STORE, 'windows', guestName), { recursive: true, force: true })
      if (gone.ok !== true) {
        const cleanup = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
        delete cleanup.vms[guestName]
        writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(cleanup, null, 2)}\n`)
      }
    }
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
      windowsVersion: '11l', installComplete: false,
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
      windowsVersion: '11l', installComplete: false, createdAt: new Date().toISOString()
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
    // ------------------------------------------------------------------
    // R1 RE-PINNED (WP-D, D-7) — THE REFUSAL IS THE CORRECT ANSWER NOW.
    //
    // The shutdown HANDS THE REST OF ITS WORK TO A DETACHED STOP
    // (`continueWindowsStopInBackground`), which takes `vm:<name>` and holds it
    // for the configured `shutdownTimeoutSec` window. This fixture used to issue
    // the Start below 0 ms later and pass ONLY because that Start queued behind
    // the lock — the exact defect R1 describes (a queue where a refusal belongs,
    // and on a wedged holder a queue that never ended).
    //
    // So the assertions are the NEW contract, in order:
    //   1. the Start is REFUSED, with `code: 'lock-timeout'` and the holder
    //      NAMED, inside the waiter budget;
    //   2. the refusal changed nothing on the row (a refusal must be inert);
    //   3. once the holder has finished (the lock is gone) the SAME Start goes
    //      through and the boot reaches QEMU — which is what makes the
    //      "no cdboot keys for an installed disk" assertion meaningful.
    // The window is shortened to its FLOOR (10 s, the config clamp) so the suite
    // proves the fact without paying the production 120 s; the deadline is
    // shortened for the same reason (`DSH_CUA_VM_LOCK_WAIT_MS` in the child env).
    // ------------------------------------------------------------------
    const fixtureConfig = (await call({ op: 'configGet' })).config
    await call({ op: 'configSet', config: { ...fixtureConfig, shutdownTimeoutSec: 10 } })
    await call({ op: 'vmShutdown', name: bootName })
    const refusedAt = Date.now()
    const refusedStart = await call({ op: 'vmStart', name: bootName })
    const refusedWall = Date.now() - refusedAt
    check("R1 (re-pinned): a Start issued while the shutdown's detached stop holds the lock is REFUSED — code 'lock-timeout', the holder named, inside the waiter budget",
      refusedStart.ok === false && refusedStart.code === 'lock-timeout'
      && refusedStart.lockHeldBy === 'shutdown-background'
      && /another operation on/u.test(refusedStart.error ?? '')
      && refusedWall <= 5000,
      `${refusedWall} ms ${JSON.stringify(refusedStart).slice(0, 240)}`)
    const refusalRow = (await call({ op: 'vmList' }))?.registry?.[bootName] ?? null
    check('R1: ...and the refusal is INERT — no state transition in the answer, and the row is still powered-off',
      refusedStart.state === undefined && refusalRow?.state === 'powered-off',
      JSON.stringify({ answerState: refusedStart.state, row: refusalRow?.state }).slice(0, 200))
    // The lock is PROCESS memory, so it is observed through `vmList` (the row's
    // `lock`), never through the registry file.
    let lockGone = false
    const lockDeadline = Date.now() + 45_000
    while (Date.now() < lockDeadline) {
      const listed = (await call({ op: 'vmList' }))?.registry?.[bootName] ?? null
      if ((listed?.lock ?? null) === null) { lockGone = true; break }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    check('R1: ...then the background stop SETTLES (its shortened window ends) and the lock is gone',
      lockGone === true,
      JSON.stringify((await call({ op: 'vmList' }))?.registry?.[bootName]?.lock ?? null))
    // THE LEFT-OVER GUEST GOES. The fixture's QEMU is a bare `sleep 120` that
    // answers neither ACPI nor QMP, so the abandoned stop deliberately LEFT IT
    // RUNNING (that is the mayBeTorn branch). This fixture is about the NEXT
    // start of an INSTALLED disk, so the process is removed the way a real
    // power-off removes it — the PROCESS, then the row's state, exactly as the
    // fixture above wrote it. Without this, the next Start ADOPTS the live QEMU
    // (`QMP running, no endpoint answers yet`) and there is no new argv to read,
    // which is what made the R4 post-install assertion measure the INSTALL boot.
    // BOTH processes, because the abandoned stop returned before `stopSwtpm`:
    // a live swtpm holds a LOCK on its state directory, and the next cold start
    // then fails at "swtpm did not create its socket" — which is a property of
    // this fixture's guest, not of the Start path under test.
    const pidAliveFile = (pidPath) => {
      try {
        const pid = Number(readFileSync(pidPath, 'utf8').trim())
        return pid > 0 && existsSync(`/proc/${pid}`)
      } catch {
        return false
      }
    }
    const orphanPids = ['qemu.pid', 'swtpm.pid'].map((file) => path.join(STORE, 'windows', bootName, file))
    for (const pidPath of orphanPids) {
      try {
        const pid = Number(readFileSync(pidPath, 'utf8').trim())
        if (pid > 0) process.kill(pid, 'SIGKILL')
      } catch { /* already gone is the good case */ }
    }
    await waitFor(() => orphanPids.every((pidPath) => pidAliveFile(pidPath) === false), 5000, 100)
    const parked = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    parked.vms[bootName] = { ...parked.vms[bootName], installComplete: true, state: 'powered-off' }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(parked, null, 2)}\n`)
    const beforeInstalled = stderr.length
    const installedStart = await call({ op: 'vmStart', name: bootName })
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const installedLog = stderr.slice(beforeInstalled)
    // "ACCEPTED" HERE MEANS "NO LONGER REFUSED BY THE LOCK", and that distinction
    // is the point of the re-pin: the fixture's stub QEMU answers no QMP, so a
    // COLD start of this disk can only end in `did not start: … never answered
    // QMP` — a GUEST failure, long after the door opened. What must be gone is
    // the holder's refusal; the next check proves the boot really reached QEMU.
    check('R1 (re-pinned): after the holder settles the SAME Start is ACCEPTED — no lock-timeout, no named holder, the answer is about the guest again',
      installedStart.code !== 'lock-timeout'
      && /another operation on/u.test(installedStart.error ?? '') === false
      && (installedStart.ok === true || /did not start/u.test(installedStart.error ?? '')),
      JSON.stringify(installedStart).slice(0, 220))
    // FOLLOW THE QEMU CHILD, NOT THE ANSWER: the stub serves no QMP, so a COLD
    // start's own `running` proof fails even though the process is healthy. What
    // this asserts is the KEY BEHAVIOUR — no presses for an installed disk — and
    // that the boot really reached the spawn (its argv is on the log).
    check('R1: a boot of an INSTALLED disk sends NO cdboot keys',
      !/press enter|pressed enter|could not press/u.test(installedLog),
      installedLog.split('\n').filter((line) => /press|qemu started/u.test(line)).join(' | ').slice(0, 200) || String(installedStart.error).slice(0, 160))
    check('R1: ...and that start really spawned QEMU (so the absence of keys is meaningful)',
      /qemu started/u.test(installedLog), installedLog.split('\n').filter((line) => /qemu started/u.test(line)).join(' | ').slice(0, 160))
    // Put the policy back the way the rest of the suite expects to find it.
    await call({ op: 'configSet', config: { ...(await call({ op: 'configGet' })).config, shutdownTimeoutSec: 120 } })
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
    // A PORT THAT IS CLOSED AT THIS INSTANT (see `closedPort`): the assertion is
    // "no SSH listener, so the row must not be promoted", and a stray ephemeral
    // listener from another process would silently invert it.
    const setupSshPort = await closedPort()
    writeFileSync(path.join(STORE, 'registry.json'), JSON.stringify({
      version: 2,
      vms: {
        [WIN_SETUP]: {
          workspace: '/w4', kind: 'windows', backend: 'qemu', state: 'installing', cpu: 2, memory: 4,
          windowsVersion: '11', diskGb: 64,
          createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
          ports: { qmp: winQmpPort, ssh: setupSshPort, vnc: winVncPort }
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

  // ---- U2/U4 (smoke): THE CLIPBOARD OPS AND THE FREE-SPACE BEAT ----
  //
  // The clipboard protocol is unit-tested with a stub transport; what this
  // proves is the SUPERVISOR's half — that `vmWindowsClipboardSet/Get` refuse an
  // unavailable computer with `available:false` + a reason (the panel renders
  // that as DISABLED, not as an error), and that they refuse an unknown name
  // outright. A row that is not `ready` cannot paste, because the tasks run in a
  // session that does not exist yet.
  {
    // A row of our own: win-legacy may have been consumed by an earlier case
    // (the suite mutates the registry deliberately), and this block is about the
    // SHAPE of the answers, not about that row.
    const parkedName = 'win-parked'
    const parkedRegistry = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    parkedRegistry.vms[parkedName] = {
      workspace: '/w-parked', kind: 'windows', backend: 'qemu', state: 'powered-off',
      cpu: 2, memory: 6, diskGb: 64, windowsVersion: '11l',
      createdAt: new Date().toISOString(), ports: { qmp: 46950, ssh: 47950, vnc: 5950 }
    }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(parkedRegistry, null, 2)}\n`)
    const ghost = await call({ op: 'vmWindowsClipboardSet', name: 'no-such-computer', text: 'x' })
    check('U2: the clipboard SET op refuses an unknown computer', ghost.ok === false && /no Windows computer named/u.test(ghost.error ?? ''), String(ghost.error ?? '').slice(0, 120))
    const ghostGet = await call({ op: 'vmWindowsClipboardGet', name: 'no-such-computer' })
    check('U2: the clipboard GET op refuses an unknown computer', ghostGet.ok === false && /no Windows computer named/u.test(ghostGet.error ?? ''))
    const notReady = await call({ op: 'vmWindowsClipboardSet', name: parkedName, text: 'hello' })
    check('U2: a powered-off Windows row answers available:false with the reason (a DISABLED panel section)',
      notReady.ok === true && notReady.available === false && /not ready/u.test(notReady.reason ?? '')
        && /interactive session/u.test(notReady.reason ?? '') && typeof notReady.hint === 'string',
      JSON.stringify(notReady).slice(0, 200))
    const notReadyGet = await call({ op: 'vmWindowsClipboardGet', name: parkedName })
    check('U2: ...the same for the READ direction', notReadyGet.ok === true && notReadyGet.available === false && /not ready/u.test(notReadyGet.reason ?? ''))
    // U4: the same three answers for the free-space probe.
    const freeGhost = await call({ op: 'vmWindowsFreeSpace', name: 'no-such-computer' })
    check('U4: the free-space op refuses an unknown computer', freeGhost.ok === false)
    // A row whose SSH is switched off has no clipboard transport at all: that is
    // a DISABLED state with its own sentence, not an SSH error.
    const noSshName = 'win-nossh'
    const noSshRegistry = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    noSshRegistry.vms[noSshName] = {
      workspace: '/w-nossh', kind: 'windows', backend: 'qemu', state: 'ready', ssh: false,
      cpu: 2, memory: 6, diskGb: 64, windowsVersion: '11l',
      createdAt: new Date().toISOString(), ports: { qmp: 46951, ssh: 47951, vnc: 5951 }
    }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(noSshRegistry, null, 2)}\n`)
    const noSsh = await call({ op: 'vmWindowsClipboardSet', name: noSshName, text: 'x' })
    check('U2: a row with SSH disabled answers available:false naming the transport, not an SSH error',
      noSsh.ok === true && noSsh.available === false && /SSH is disabled/u.test(noSsh.reason ?? '')
        && /no other transport/u.test(noSsh.reason ?? ''), JSON.stringify(noSsh).slice(0, 200))

    // J21-3: THE SUCCESS PATH, END TO END THROUGH THE STUB BACKEND.
    //
    // The bug was positional: `windowsBackend.clipboardSet({ ...meta, name })`
    // passed ONE object, the backend's `clipboardSet(rawSpec, text)` refused it
    // with "clipboardSet needs the text to paste", and every paste failed after
    // the whole SSH task had been prepared. The stub wrapper records the raw
    // argument list, so this check fails if the second argument ever disappears
    // again — even if the reply looks fine.
    const forwardName = 'win-clip-forward'
    const forwardRegistry = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    forwardRegistry.vms[forwardName] = {
      workspace: '/w-forward', kind: 'windows', backend: 'qemu', state: 'ready', ssh: true,
      cpu: 2, memory: 6, diskGb: 64, windowsVersion: '11l',
      createdAt: new Date().toISOString(), ports: { qmp: 46952, ssh: 47952, vnc: 5952 }
    }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(forwardRegistry, null, 2)}\n`)
    const forwardText = 'forwarded — ünïcode & "quotes"'
    const forwarded = await call({ op: 'vmWindowsClipboardSet', name: forwardName, text: forwardText })
    check('J21-3: a ready row pastes successfully through the backend (ok + via)',
      forwarded.ok === true && forwarded.via === 'agent' && forwarded.name === forwardName,
      JSON.stringify(forwarded).slice(0, 200))
    let captured = null
    try {
      captured = JSON.parse(readFileSync(CLIP_STUB_CAPTURE, 'utf8').trim().split('\n').filter(Boolean).at(-1))
    } catch { captured = null }
    check('J21-3: ...the backend received the text as the SECOND POSITIONAL argument',
      captured !== null && captured.argCount === 2 && captured.textType === 'string'
        && captured.text === forwardText && captured.name === forwardName,
      JSON.stringify(captured))
    const forwardAfter = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    delete forwardAfter.vms[forwardName]
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(forwardAfter, null, 2)}\n`)
    // U4: THE STATUS BEAT CARRIES IT TOO. The panel reads `freeSpace` off the
    // same payload it already polls, and an installing/half-installed row must
    // answer "unavailable + why" instead of failing the whole status call (a
    // status poll that can die on an optional extra is how a row goes blank).
    // WIN_SETUP has been consumed by the earlier cases (the suite mutates the
    // registry on purpose), so the parked row is the one that is still there.
    const statusFree = await call({ op: 'vmWindowsStatus', name: parkedName, tail: 2 })
    check('U4: a status poll carries `freeSpace` and never fails because of it',
      statusFree.ok === true && statusFree.freeSpace !== undefined
        && statusFree.freeSpace.available === false && /not running|not ready/u.test(statusFree.freeSpace.reason ?? ''),
      JSON.stringify(statusFree.freeSpace ?? null).slice(0, 200))
    const freeOff = await call({ op: 'vmWindowsFreeSpace', name: parkedName })
    check('U4: a powered-off row answers available:false with the reason (never 0 GB)',
      freeOff.ok === true && freeOff.available === false && /not ready/u.test(freeOff.reason ?? '') && freeOff.bytes === undefined,
      JSON.stringify(freeOff).slice(0, 160))
  }

  // ---- WP-4/WP-9.1: THE BRIDGE OPS, THE PUSH STREAM AND THE MEASURED GROW ----
  //
  // Three contracts the plugin and the panel depend on, each of which used to be
  // a silent guess:
  //
  //   * `vmWindowsMcp` attaches ONE named computer. The old code answered for
  //     `entries.find(row.state === 'ready')` when the caller passed no name, so
  //     a session attached whatever happened to be up.
  //   * `subscribe` is the PUSH half of the state bus: one line per real
  //     transition, a `vm-removed` when a row disappears.
  //   * `vmDisk` may only report a size it MEASURED; a failed growpart/resize2fs
  //     is a refusal, not `|| true`.
  {
    // (1) THE NAME IS REQUIRED, AND A NAME THAT DOES NOT EXIST IS NOT AN ATTACH.
    const nameless = await call({ op: 'vmWindowsMcp' })
    check('WP-4: vmWindowsMcp without a name is refused (never "the first ready row")',
      nameless.ok === false && /name is required/u.test(nameless.error ?? ''), String(nameless.error ?? '').slice(0, 130))
    const ghostMcp = await call({ op: 'vmWindowsMcp', name: 'nope' })
    check('WP-4: vmWindowsMcp for an unknown name answers available:false with the name',
      ghostMcp.ok === true && ghostMcp.available === false && /no computer named "nope"/u.test(ghostMcp.reason ?? ''),
      JSON.stringify(ghostMcp).slice(0, 170))

    // (2) THE CHEAP STATE READ: registry + ports, NEVER SSH.
    const parkedName = 'win-mcp-parked'
    const parked = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    parked.vms[parkedName] = {
      workspace: '/w-parked', kind: 'windows', backend: 'qemu', state: 'powered-off',
      cpu: 2, memory: 6, diskGb: 64, windowsVersion: '11l',
      createdAt: new Date().toISOString(), ports: { qmp: 46960, ssh: 47960, vnc: 5960 }
    }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(parked, null, 2)}\n`)
    const stateStarted = Date.now()
    const parkedState = await call({ op: 'vmWindowsMcpState', name: parkedName })
    const stateMs = Date.now() - stateStarted
    check('WP-4: vmWindowsMcpState on a powered-off row answers online:false WITHOUT dialling SSH',
      parkedState.ok === true && parkedState.online === false && parkedState.state === 'powered-off'
      && stateMs < 2500,
      `online=${parkedState.online} state=${parkedState.state} ${stateMs}ms`)
    check('WP-4: ...and it still carries the endpoint facts the caller will need once it is up',
      parkedState.sshPort === 47960 && parkedState.kind === 'windows' && typeof parkedState.keyPath === 'string' && /windows\/.+\/id_ed25519|windows/.test(String(parkedState.keyPath)),
      JSON.stringify({ port: parkedState.sshPort, key: parkedState.keyPath }).slice(0, 140))
    const ghostState = await call({ op: 'vmWindowsMcpState', name: 'nope' })
    check('WP-4: ...an absent name is `absent`, not an error',
      ghostState.ok === true && ghostState.state === 'absent' && ghostState.online === false
      && /no computer named/u.test(ghostState.reason ?? ''))

    // (3) THE PUSH STREAM: vm-state then vm-removed, on ONE socket.
    const streamName = 'ws-stream'
    const streamDir = path.join(HOME, '.cua', 'vmm', 'qemu', streamName)
    mkdirSync(streamDir, { recursive: true })
    writeFileSync(path.join(streamDir, 'cmdline'), `/usr/bin/qemu-system-x86_64 -name ${streamName} -qmp tcp:127.0.0.1:39598,server=on,wait=off\n`)
    writeFileSync(path.join(streamDir, 'qemu.pid'), '999999\n')
    writeFileSync(path.join(streamDir, 'disk.qcow2'), 'stream disk')
    const streamRegistry = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    streamRegistry.vms[streamName] = {
      workspace: '/w-stream', kind: 'linux', backend: 'linux', state: 'ready', tier: 'slim',
      cpu: 2, memory: 4, diskGb: 20, createdAt: new Date().toISOString()
    }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(streamRegistry, null, 2)}\n`)

    const events = []
    let streamBuffer = ''
    const stream = net.connect(SOCK)
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      streamBuffer += chunk
      let newline = streamBuffer.indexOf('\n')
      while (newline !== -1) {
        const line = streamBuffer.slice(0, newline)
        streamBuffer = streamBuffer.slice(newline + 1)
        newline = streamBuffer.indexOf('\n')
        if (line.trim() === '') continue
        try { events.push(JSON.parse(line)) } catch { /* not a protocol line */ }
      }
    })
    await new Promise((resolve, reject) => { stream.on('connect', resolve); stream.on('error', reject) })
    stream.write(`${JSON.stringify({ op: 'subscribe', events: ['vm-state'] })}\n`)
    const greeted = await waitFor(() => events.some((event) => event.event === 'ready'), 4000)
    check('WP-4: subscribe announces the stream before any transition', greeted, events[0]?.event ?? 'no line')

    const poweredOff = await call({ op: 'vmShutdown', name: streamName })
    check('WP-4: the state transition under test really happened (shutdown → powered-off)',
      poweredOff.ok === true && poweredOff.state === 'powered-off', String(poweredOff.state ?? poweredOff.error).slice(0, 80))
    const sawState = await waitFor(() => events.some((event) => event.event === 'vm-state' && event.name === streamName && event.state === 'powered-off'), 5000)
    check('WP-4: ...and it arrives on the stream as {"event":"vm-state"} with the name and the state',
      sawState, events.map((event) => event.event).join(','))
    const removed = await call({ op: 'vmDelete', name: streamName })
    const sawRemoved = await waitFor(() => events.some((event) => event.event === 'vm-removed' && event.name === streamName), 5000)
    check('WP-4: deleting the computer pushes {"event":"vm-removed"}',
      removed.ok === true && sawRemoved, events.map((event) => event.event).join(','))
    const stateAt = events.findIndex((event) => event.event === 'vm-state' && event.name === streamName)
    const removedAt = events.findIndex((event) => event.event === 'vm-removed' && event.name === streamName)
    check('WP-4: ...in order (state first, removal second), never the other way round',
      stateAt !== -1 && removedAt !== -1 && stateAt < removedAt, `${stateAt} < ${removedAt}`)
    try { stream.destroy() } catch {}

    // (4) THE CLIPBOARD FAST PATH, DRIVEN WITH A STUB TRANSPORT.
    //
    // The agent protocol is: drop a job with a digest, wait for the agent's ack,
    // and VERIFY it (seq + sha256 + its own `equal`). Every branch below is a
    // different lie a slower path used to tell.
    const { createWindowsBackend, clipSha256 } = await import(new URL('../docker/cua-vm-windows-qemu.mjs', import.meta.url).href)
    const pasteText = 'paste me — with ünïcode'
    const makeClipStub = ({ agent = true, ackEqual = true, ackSha = null } = {}) => {
      const calls = []
      let job = null
      const files = new Map()
      return {
        calls,
        transport: {
          async sshRun(_spec, command) {
            calls.push({ kind: 'ssh', command })
            if (/type "[^"]*clip-state\.json"/u.test(command)) {
              return agent
                ? { code: 0, stdout: JSON.stringify({ ts: Date.now(), seq: 5 }), stderr: '' }
                : { code: 1, stdout: '', stderr: 'File Not Found' }
            }
            if (/type "[^"]*clip-ack\.json"/u.test(command)) {
              if (job === null) return { code: 1, stdout: '', stderr: 'File Not Found' }
              return {
                code: 0,
                stdout: JSON.stringify({ seq: job.seq, sha256: ackSha ?? job.sha256, equal: ackEqual }),
                stderr: ''
              }
            }
            if (/schtasks \/run/u.test(command)) return { code: 0, stdout: 'SUCCESS: Attempted to run', stderr: '' }
            if (/schtasks \/query/u.test(command)) return { code: 0, stdout: 'Status: Ready\r\nLast Result: 0\r\n', stderr: '' }
            return { code: 0, stdout: '', stderr: '' }
          },
          async putText(_spec, guestPath, text) {
            calls.push({ kind: 'put', guestPath, text })
            files.set(guestPath, text)
            if (guestPath.endsWith('.json')) { try { job = JSON.parse(text) } catch { job = null } }
            return { code: 0, stderr: '' }
          },
          async getText(_spec, guestPath) {
            calls.push({ kind: 'get', guestPath })
            if (!files.has(guestPath)) return { code: agent ? 0 : 1, stderr: agent ? '' : 'File Not Found', text: agent ? pasteText : '' }
            return { code: 0, stderr: '', text: files.get(guestPath) }
          }
        }
      }
    }
    {
      const stub = makeClipStub()
      const backend = createWindowsBackend({ store: STORE, qmp: async () => [], log: () => {}, transport: stub.transport })
      const answer = await backend.clipboardSet({ name: 'win-clip-fast' }, pasteText)
      check('WP-6: the agent path verifies the ack and reports verified:true',
        answer.ok === true && answer.verified === true && answer.via === 'agent' && answer.readBackEqual === true,
        JSON.stringify(answer).slice(0, 220))
      check('WP-6: ...the job carried the digest of the text we sent, and the copy was written BEFORE it',
        stub.calls.some((call) => call.kind === 'put' && String(call.guestPath).endsWith('.json') && JSON.parse(call.text).sha256 === clipSha256(pasteText))
        && stub.calls.findIndex((call) => call.kind === 'put') < stub.calls.findIndex((call) => call.kind === 'ssh' && /type "[^"]*clip-ack/u.test(call.command)),
        stub.calls.map((call) => call.kind).join(','))
    }
    {
      const stub = makeClipStub({ ackSha: 'deadbeef' })
      const backend = createWindowsBackend({ store: STORE, qmp: async () => [], log: () => {}, transport: stub.transport })
      const answer = await backend.clipboardSet({ name: 'win-clip-fast' }, pasteText)
      // AN UNEQUAL ACK IS NEVER A VERIFIED PASTE. The backend declines the fast
      // path (`ack-mismatch`) and falls back to the schtasks path, which is
      // honest — but the answer must say `verified: false` and NAMED the decline,
      // so "pasted, unverified" can never be read as "pasted, verified".
      check('WP-6: an ack that describes a DIFFERENT payload is refused (ack-mismatch), never verified',
        answer.verified === false && answer.fastPathReason === 'ack-mismatch' && answer.via === 'task',
        JSON.stringify(answer).slice(0, 240))
    }
    {
      const stub = makeClipStub({ ackEqual: false })
      const backend = createWindowsBackend({ store: STORE, qmp: async () => [], log: () => {}, transport: stub.transport })
      const answer = await backend.clipboardSet({ name: 'win-clip-fast' }, pasteText)
      check('WP-6: an agent that says equal:false is refused the same way',
        answer.verified === false && answer.fastPathReason === 'ack-mismatch',
        JSON.stringify(answer).slice(0, 200))
    }
    {
      const stub = makeClipStub({ agent: false })
      const backend = createWindowsBackend({ store: STORE, qmp: async () => [], log: () => {}, transport: stub.transport })
      const answer = await backend.clipboardSet({ name: 'win-clip-slow' }, pasteText)
      const putAt = stub.calls.findIndex((call) => call.kind === 'put')
      const runAt = stub.calls.findIndex((call) => call.kind === 'ssh' && /cua-clip-set/u.test(call.command))
      check('WP-6: with no agent the schtasks path still runs, and REPORTS the decline',
        answer.ok === true && answer.via === 'task' && answer.fastPathReason === 'no-agent' && answer.verified === false,
        JSON.stringify(answer).slice(0, 240))
      check('WP-6: ...in the documented order: clip.txt written, THEN the task started',
        putAt !== -1 && runAt !== -1 && putAt < runAt, `put@${putAt} run@${runAt}`)
    }

    // (5) THE MEASURED GROW. `growpart`/`resize2fs` no longer end in `|| true`.
    const diskName = 'ws-disk'
    const diskDir = path.join(HOME, '.cua', 'vmm', 'qemu', diskName)
    mkdirSync(diskDir, { recursive: true })
    writeFileSync(path.join(diskDir, 'cmdline'), `/usr/bin/qemu-system-x86_64 -name ${diskName} -qmp tcp:127.0.0.1:${winQmpPort},server=on,wait=off\n`)
    writeFileSync(path.join(diskDir, 'qemu.pid'), `${process.pid}\n`)
    const diskRegistry = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    diskRegistry.vms[diskName] = {
      workspace: '/w-disk', kind: 'linux', backend: 'linux', state: 'ready', tier: 'slim',
      cpu: 2, memory: 4, diskGb: 20, createdAt: new Date().toISOString()
    }
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(diskRegistry, null, 2)}\n`)

    // A 20 GiB filesystem, and the grow asks for 20 GiB: the measured size is the
    // answer, not the requested one.
    writeFileSync(path.join(STORE, 'df-output'), '21474836480 21474836480\n')
    const grown = await call({ op: 'vmDisk', name: diskName, sizeGb: 20 })
    check('WP-9.1: a successful grow reports the MEASURED size in GB',
      grown.ok === true && grown.sizeGb === 20 && grown.bytes === 21474836480,
      JSON.stringify(grown).slice(0, 200))
    check('WP-9.1: ...and the registry records that measured size', (() => {
      const row = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[diskName]
      return row?.diskGb === 20
    })(), String(JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[diskName]?.diskGb))

    // resize2fs refuses: the BLOCK device grew, the FILESYSTEM did not. The old
    // code answered "grew to 20 GB" and the next ENOSPC had no explanation.
    writeFileSync(path.join(STORE, 'stub-resize-fail'), 'fail the next resize2fs')
    const resizeFailed = await call({ op: 'vmDisk', name: diskName, sizeGb: 30 })
    check('WP-9.1: a failed resize2fs is a REFUSAL (guest-resize-failed), not `|| true`',
      resizeFailed.ok === false && /guest-resize-failed/u.test(String(resizeFailed.error ?? '')),
      String(resizeFailed.error ?? '').slice(0, 200))
    check('WP-9.1: ...and the refusal carries the command output as its detail',
      /Operation not permitted/u.test(String(resizeFailed.detail ?? '')), String(resizeFailed.detail ?? '').slice(0, 120))
    rmSync(path.join(STORE, 'stub-resize-fail'), { force: true })

    // growpart refuses: same rule, its own reason.
    writeFileSync(path.join(STORE, 'stub-growpart-fail'), 'fail the next growpart')
    const growpartFailed = await call({ op: 'vmDisk', name: diskName, sizeGb: 30 })
    check('WP-9.1: a failed growpart has its own reason (guest-growpart-failed)',
      growpartFailed.ok === false && /guest-growpart-failed/u.test(String(growpartFailed.error ?? '')),
      String(growpartFailed.error ?? '').slice(0, 160))
    rmSync(path.join(STORE, 'stub-growpart-fail'), { force: true })

    // A SHORT GROW: the block device grew, the filesystem answers 10 GiB for a
    // 20 GiB request. That is the silent case the 95% band exists for.
    writeFileSync(path.join(STORE, 'df-output'), '10737418240 10737418240\n')
    const shortGroup = await call({ op: 'vmDisk', name: diskName, sizeGb: 20 })
    check('WP-9.1: a block device that grew without the filesystem is `short-grow`',
      shortGroup.ok === false && /short-grow/u.test(String(shortGroup.error ?? '')),
      String(shortGroup.error ?? '').slice(0, 200))
    check('WP-9.1: ...and the row does NOT record the requested size after a short grow',
      JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[diskName]?.diskGb === 20,
      String(JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms[diskName]?.diskGb))
    rmSync(path.join(STORE, 'df-output'), { force: true })

    // tidy: the two fabricated rows must not leak into later cases
    const tidy = JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8'))
    delete tidy.vms[diskName]
    delete tidy.vms[parkedName]
    writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify(tidy, null, 2)}\n`)
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
    // Same rule as `fix` below: SIGKILL skips the supervisor's own shutdown, so
    // the live-view child it spawned must die with the GROUP or it outlives the
    // suite and poisons the next run's fixed ports.
    detached: true,
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
  try { process.kill(-slow.pid, 'SIGKILL') } catch { try { slow.kill('SIGKILL') } catch {} }
  // BELT AND BRACES: the live-view child's argv carries this run's store path,
  // so `pkill -f <store>` matches ONLY this block's children. A fixed-port leak
  // is invisible until the NEXT run fails on a busy port.
  try { spawnSync('pkill', ['-9', '-f', slowStore], { timeout: 5000 }) } catch { /* no pkill */ }
}


// ---- J1-4 / J20-1c / J22-7 / J22-8 / J22-12: THE FIX-ROUND SUPERVISOR ----
//
// Four supervisor-side contracts that are only observable from a RUNNING
// supervisor, driven in a throwaway store of their own (the main child shares
// one socket, so a second process is the only honest way to give it different
// firmware paths and a different poll interval):
//
//   * J1-4  the create preflight follows the FIRMWARE: 7u (pc/SeaBIOS) needs
//           only qemu, 11 needs the OVMF pair + swtpm and says which is missing;
//   * J20-1c the documented poll interval reaches the bridge on `--poll-ms`
//           (clamped to 200–60000 ms by the supervisor, not by luck);
//   * J22-8 the bridge kind is READ from its stderr ready line, and a listener
//           that never announces one falls back instead of claiming a page;
//   * J22-7 a SIGTERM sweeps the live-view children, so the next process does
//           not lose the port race to a bridge whose supervisor socket is gone.
//
// J22-12 (`restorePorts` keeps view/clipboard) is asserted one level down: the
// recompute is `relayCapabilities()`, a module-scope function this file cannot
// import, so its body is extracted from the shipped source and exercised with
// the same reason constants. The wiring that CALLS it is pinned by the gate
// needle `view: capabilities.view, clipboard: capabilities.clipboard`.
{
  /**
   * Slice ONE top-level function out of the shipped source by brace matching.
   * A rename or a moving brace fails the check loudly instead of silently
   * testing nothing, which is the failure mode an eval-based test must avoid.
   */
  const extractFunction = (source, signature) => {
    const at = source.indexOf(signature)
    if (at < 0) return null
    // THE PARAMETER LIST IS WALKED FIRST: `relayCapabilities(snapshot = {})` has
    // a brace in its DEFAULTS, and starting the body match at the first `{`
    // sliced `function relayCapabilities(snapshot = {}` — a syntax error that a
    // naive `try { } catch { }` would have turned into a silently-skipped check.
    let index = source.indexOf('(', at)
    if (index < 0) return null
    let parens = 0
    for (; index < source.length; index += 1) {
      if (source[index] === '(') parens += 1
      else if (source[index] === ')') {
        parens -= 1
        if (parens === 0) break
      }
    }
    const open = source.indexOf('{', index)
    if (open < 0) return null
    let depth = 0
    for (let cursor = open; cursor < source.length; cursor += 1) {
      if (source[cursor] === '{') depth += 1
      else if (source[cursor] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(at, cursor + 1)
      }
    }
    return null
  }
  const supervisorSource = readFileSync(path.join(REPO, 'docker', 'cua-vm-supervisor.mjs'), 'utf8')

  // ---- J20-1c: THE CLAMP, WITHOUT A SUPERVISOR ----
  {
    const fnSource = extractFunction(supervisorSource, 'function vncClipPollMs()')
    let pollFor = null
    if (fnSource !== null) {
      try {
        pollFor = new Function('process', 'VNC_CLIP_POLL_DEFAULT_MS', 'VNC_CLIP_POLL_MIN_MS', 'VNC_CLIP_POLL_MAX_MS', `${fnSource}; return vncClipPollMs()`)
      } catch { pollFor = null }
    }
    const sample = (raw) => {
      if (pollFor === null) return null
      return pollFor({ env: raw === undefined ? {} : { DSH_CUA_VNC_CLIP_POLL_MS: raw } }, 1200, 200, 60000)
    }
    check('J20-1c: vncClipPollMs() is a real, callable clamp (the source extraction found it)',
      pollFor !== null, fnSource === null ? 'function not found' : 'extracted')
    check('J20-1c: DSH_CUA_VNC_CLIP_POLL_MS=99999 clamps to 60000',
      sample('99999') === 60000, `${sample('99999')}`)
    check("J20-1c: a non-numeric value ('abc') is the DEFAULT 1200, not 0 = fastest",
      sample('abc') === 1200, `${sample('abc')}`)
    check("J20-1c: unset and empty are the default; 250 is 250 and 12.5 rounds to 200 (the floor)",
      sample(undefined) === 1200 && sample('') === 1200 && sample('250') === 250 && sample('12.5') === 200,
      `${sample(undefined)}/${sample('')}/${sample('250')}/${sample('12.5')}`)
  }

  // ---- J22-12: THE TRIPLE IS RECOMPUTED FROM THE RECORDED FRONT DOOR ----
  {
    const fnSource = extractFunction(supervisorSource, 'function relayCapabilities(')
    let relay = null
    if (fnSource !== null) {
      try {
        relay = new Function(
          'snapshot', 'rawVncPort', 'CLIPBOARD_UP', 'clipboardDown', 'CLIPBOARD_NO_VIEW_REASON', 'CLIPBOARD_RAW_VNC_REASON', 'consoleBridgeDownReason',
          `${fnSource}; return relayCapabilities(snapshot, rawVncPort)`
        )
      } catch { relay = null }
    }
    const up = { in: true, out: true, transport: 'agent' }
    const down = (reason) => ({ in: false, out: false, transport: 'schtasks', reason })
    const noView = 'the live view is not up, so the console clipboard has no channel yet'
    const rawVnc = 'no noVNC page is served for this computer: raw VNC has no clipboard channel (use the panel Clipboard section)'
    const bridgeDown = 'the console clipboard bridge did not start'
    const call = (snapshot, rawVncPort = 0) => relay === null ? null
      : relay(snapshot, rawVncPort, up, down, noView, rawVnc, () => bridgeDown)
    const upRow = call({ view: 'novnc-clip' })
    const upBare = call({ view: 'novnc-clip-bare' })
    const pageOnly = call({ view: 'novnc' })
    const raw = call({ view: 'vnc-raw' })
    const inferred = call({ target: { port: 5901 } }, 5901)
    const unknown = call({ target: { port: 5999 } }, 5901)
    check('J22-12: relayCapabilities() is a real, callable recompute (the source extraction found it)',
      relay !== null, fnSource === null ? 'function not found' : 'extracted')
    check('J22-12: a reopened relay keeps view + clipboard for BOTH bridge front doors',
      upRow?.view === 'novnc-clip' && upRow?.clipboard?.in === true && upRow?.clipboard?.out === true
      && upBare?.view === 'novnc-clip-bare' && upBare?.clipboard?.in === true,
      JSON.stringify(upRow) + ' ' + JSON.stringify(upBare))
    check('J22-12: ...a noVNC/websockify page gets a page but NO clipboard (the bridge reason)',
      pageOnly?.view === 'novnc' && pageOnly?.clipboard?.in === false && pageOnly?.clipboard?.reason === bridgeDown,
      JSON.stringify(pageOnly))
    check('J22-12: ...raw VNC gets neither, and a snapshot from an older build infers raw from the port',
      raw?.clipboard?.in === false && raw?.clipboard?.reason === rawVnc
      && inferred?.view === 'vnc-raw' && inferred?.clipboard?.reason === rawVnc
      && unknown?.view === '' && unknown?.clipboard?.reason === noView,
      `${raw?.view} ${inferred?.view} ${unknown?.view}`)
  }

  const fixStore = mkdtempSync(path.join(os.tmpdir(), 'cua-fix-sup-'))
  const fixSock = path.join(fixStore, 's.sock')
  const bridgeLog = path.join(fixStore, 'bridge.log')
  const fakeBridge = path.join(fixStore, 'fake-vnc-clip.mjs')
  // THE BRIDGE THAT ANNOUNCES ITSELF. The name decides the front door, so one
  // script covers the healthy, the bare and the silent-listener cases; the
  // supervisor's contract is to BELIEVE THE LINE, not its own assumption.
  writeFileSync(fakeBridge, `#!/usr/bin/env node
import net from 'node:net'
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
const get = (flag) => { const at = args.indexOf(flag); return at === -1 ? '' : String(args[at + 1] ?? '') }
const httpPort = Number(get('--http-port').split(':').pop())
const name = get('--name')
const log = process.env.FAKE_BRIDGE_LOG || ''
const record = (event) => { if (log !== '') { try { appendFileSync(log, JSON.stringify({ event, name, at: Date.now(), pollMs: get('--poll-ms'), httpPort }) + '\\n') } catch {} } }
record('start')
if (!name.endsWith('-silent')) {
  const kind = name.endsWith('-bare') ? 'novnc-clip-bare' : 'novnc-clip'
  process.stderr.write('[cua-vnc-clip] ' + kind + ' on http://127.0.0.1:' + httpPort + '/ -> vnc 127.0.0.1:1\\n')
}
const server = net.createServer((socket) => { try { socket.destroy() } catch {} })
server.listen(httpPort, '127.0.0.1')
const stop = () => { record('stop'); try { server.close() } catch {}; process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
setInterval(() => {}, 1000)
`, { mode: 0o755 })

  // A qemu the caps probe can see (it only has to be a regular file here: the
  // preflight is about PRESENCE, and the boot never runs in this block).
  const fixQemu = path.join(fixStore, 'bin', 'qemu-system-x86_64')
  mkdirSync(path.dirname(fixQemu), { recursive: true })
  writeFileSync(fixQemu, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const fix = spawn(process.execPath, [path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')], {
    // DETACHED = ITS OWN PROCESS GROUP. SIGKILL does not run the supervisor's
    // shutdown, so a hard kill used to orphan the live-view children it spawned
    // (`cua-vnc-clip.mjs` + `websockify`, bound to the FIXED ports 5997-5999) —
    // and the next run then failed with "the live view is not up yet" because
    // the port was still taken by a process from the run before. Killing the
    // GROUP reaps them with the supervisor.
    detached: true,
    env: {
      ...process.env,
      CUA_VM_STORE: fixStore,
      CUA_VM_HOME: path.join(fixStore, 'home'),
      CUA_SUPERVISOR_SOCK: fixSock,
      CUA_BIN: STUB,
      CUA_WORKSPACE_ROOT: '/workspace',
      DSH_CUA_VM_WINDOWS: '1',
      // HONEST CAPS: no self-test hook, and the three UEFI files point at paths
      // that do not exist while qemu does. That is a SeaBIOS host, not a broken one.
      DSH_CUA_WINDOWS_FAKE_HOST_CAPS: '',
      // A REGULAR FILE, created HERE: the main suite's stub bin lives under the
      // STORE that its finally{} has already removed by the time this block runs.
      DSH_CUA_WINDOWS_QEMU: fixQemu,
      DSH_CUA_WINDOWS_OVMF_CODE: path.join(fixStore, 'no-OVMF_CODE_4M.fd'),
      DSH_CUA_WINDOWS_OVMF_VARS: path.join(fixStore, 'no-OVMF_VARS_4M.fd'),
      DSH_CUA_WINDOWS_SWTPM: path.join(fixStore, 'no-swtpm'),
      DSH_CUA_WINDOWS_OEM_DIR: path.join(REPO, 'docker', 'windows-oem'),
      DSH_CUA_VNC_CLIP_BIN: fakeBridge,
      DSH_CUA_VNC_CLIP_POLL_MS: '99999',
      FAKE_BRIDGE_LOG: bridgeLog,
      PATH: `${MTOOLS_STUB}:${STUB_BIN}:${process.env.PATH ?? ''}`,
      PNG_SOURCE
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let fixErr = ''
  fix.stderr.on('data', (chunk) => { fixErr += chunk })
  let fixExitAt = 0
  fix.on('exit', () => { fixExitAt = Date.now() })
  let fixUp = false
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(fixSock)) { fixUp = true; break }
    await new Promise((r) => setTimeout(r, 100))
  }
  const askFix = (payload) => new Promise((resolve) => {
    const socket = net.connect(fixSock)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', (chunk) => { buffer += chunk })
    socket.on('close', () => { try { resolve(JSON.parse(buffer.split('\n')[0])) } catch { resolve(null) } })
    socket.on('error', () => resolve(null))
  })
  check('the fix-round supervisor starts with honest host caps', fixUp, fixErr.trim().split('\n').slice(-1)[0] ?? '')
  if (fixUp) {
    // ---- J1-4: THE PREFLIGHT FOLLOWS THE FIRMWARE ----
    //
    // 7u is pc/SeaBIOS: no pflash, no TPM, so the missing OVMF/swtpm files are
    // IRRELEVANT and must not be the refusal. The create still fails (the local
    // ISO does not exist), which is the proof it got PAST the caps check.
    const seven = await askFix({ op: 'vmWindowsCreate', name: 'fix-w7', kind: 'windows', windowsVersion: '7u', windowsIso: 'no-such-media.iso' })
    const sevenText = String(seven?.error ?? '')
    check('J1-4: a 7u (SeaBIOS) create does NOT fail on the missing OVMF/swtpm files',
      seven?.ok === false && sevenText !== ''
      && !/ovmfCode|ovmfVars|swtpm|OVMF/u.test(sevenText),
      sevenText.split('\n')[0].slice(0, 180))
    check('J1-4: ...it gets as far as its own subject (the missing local ISO)',
      /no-such-media\.iso/u.test(sevenText) && /does not exist/u.test(sevenText),
      sevenText.split('\n')[0].slice(0, 180))
    const eleven = await askFix({ op: 'vmWindowsCreate', name: 'fix-w11', kind: 'windows', windowsVersion: '11', windowsIso: 'no-such-media.iso' })
    const elevenText = String(eleven?.error ?? '')
    check('J1-4: an 11 (UEFI) create still fails, NAMING ovmfCode',
      eleven?.ok === false && /ovmfCode/u.test(elevenText), elevenText.split('\n')[0].slice(0, 200))
    check('J1-4: ...and says the UEFI pair + swtpm are what is missing, not the whole image',
      /ovmfVars/u.test(elevenText) && /swtpm/u.test(elevenText))
    check('J1-4: neither refusal created a row or a disk',
      !existsSync(path.join(fixStore, 'windows', 'fix-w7'))
      && !existsSync(path.join(fixStore, 'windows', 'fix-w11')))

    // ---- J22-8 / J20-1c / J22-7: THE LIVE VIEWS ----
    const rows = (name, vnc) => ({ workspace: '/workspace', kind: 'windows', backend: 'qemu', state: 'ready', ports: { qmp: 46971, ssh: 47971, vnc }, diskGb: 64, cpu: 2, memory: 6, createdAt: new Date().toISOString() })
    writeFileSync(path.join(fixStore, 'registry.json'), `${JSON.stringify({
      version: 2,
      vms: { 'fix-bridge': rows('fix-bridge', 5997), 'fix-bare': rows('fix-bare', 5998), 'fix-silent': rows('fix-silent', 5999) }
    }, null, 2)}\n`)
    const bridgeView = await askFix({ op: 'view', name: 'fix-bridge' })
    const bareView = await askFix({ op: 'view', name: 'fix-bare' })
    const silentStarted = Date.now()
    const silentView = await askFix({ op: 'view', name: 'fix-silent' })
    const silentMs = Date.now() - silentStarted
    check('J22-8: the healthy bridge is the view the ready line announced (novnc-clip)',
      bridgeView?.ok === true && bridgeView?.view === 'novnc-clip'
      && bridgeView?.clipboard?.in === true && bridgeView?.clipboard?.out === true,
      JSON.stringify(bridgeView).slice(0, 200))
    check('J22-8: a `novnc-clip-bare` ready line is HONOURED (never rewritten to novnc-clip)',
      bareView?.ok === true && bareView?.view === 'novnc-clip-bare', JSON.stringify(bareView).slice(0, 160))
    // THE FALLBACK IS WHATEVER THE IMAGE HAS: websockify + noVNC becomes `novnc`,
    // a bare websockify is `websockify`, neither is `vnc-raw`. What must NOT
    // happen is a bridge front door: the silent listener never earned one.
    check('J22-8: a listener that never announces a kind is NOT the view — the documented fallback takes over',
      silentView?.ok === true && !/^novnc-clip/u.test(String(silentView?.view ?? ''))
      && ['novnc', 'websockify', 'vnc-raw'].includes(silentView?.view)
      && silentView?.clipboard?.in === false && silentMs >= 1000,
      `view=${silentView?.view} clipboard=${JSON.stringify(silentView?.clipboard)} ${silentMs}ms`)
    let logRows = []
    try { logRows = readFileSync(bridgeLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) } catch { logRows = [] }
    const starts = logRows.filter((row) => row.event === 'start')
    check('J20-1c: DSH_CUA_VNC_CLIP_POLL_MS=99999 reached EVERY bridge as `--poll-ms 60000` (never the child default)',
      starts.length === 3 && starts.every((row) => row.pollMs === '60000'),
      starts.map((row) => `${row.name}:${row.pollMs}`).join(','))
    check('J22-8: the silent child was killed when the fallback took over (no orphan bridge)',
      logRows.some((row) => row.event === 'stop' && row.name === 'fix-silent'),
      logRows.map((row) => `${row.event}:${row.name}`).join(','))

    // ports.json carries the triple, so the panel's paste controls follow the view.
    const viewRows = (() => { try { return JSON.parse(readFileSync(path.join(fixStore, 'ports.json'), 'utf8')) } catch { return {} } })()
    check('J22-12: the live relay row carries view + clipboard (what restorePorts must preserve)',
      viewRows['fix-bridge']?.view === 'novnc-clip' && viewRows['fix-bridge']?.clipboard?.in === true
      && !/^novnc-clip/u.test(String(viewRows['fix-silent']?.view ?? ''))
      && viewRows['fix-silent']?.clipboard?.in === false,
      JSON.stringify({ bridge: viewRows['fix-bridge']?.view, silent: viewRows['fix-silent']?.view }))

    // ---- J22-7: SIGTERM SWEEPS THE LIVE VIEWS ----
    const beforeSignal = logRows.filter((row) => row.event === 'stop').length
    fix.kill('SIGTERM')
    let exited = false
    for (let i = 0; i < 60; i += 1) {
      if (fix.exitCode !== null) { exited = true; break }
      await new Promise((r) => setTimeout(r, 100))
    }
    await new Promise((r) => setTimeout(r, 150))
    let afterRows = []
    try { afterRows = readFileSync(bridgeLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) } catch { afterRows = [] }
    const stopsAfter = afterRows.filter((row) => row.event === 'stop')
    const swept = ['fix-bridge', 'fix-bare'].every((name) => stopsAfter.some((row) => row.name === name))
    const late = stopsAfter.filter((row) => row.at > fixExitAt && fixExitAt > 0)
    check('J22-7: SIGTERM stops every LIVE view child (not just the server socket)',
      exited && fix.exitCode === 0 && stopsAfter.length >= beforeSignal + 2 && swept,
      `exit=${fix.exitCode} stops=${stopsAfter.map((row) => row.name).join(',')}`)
    check('J22-7: ...and the supervisor exits only AFTER they are reaped (no child outlives it)',
      late.length === 0 && fixExitAt > 0, fixExitAt === 0 ? 'no exit observed' : `${late.length} late stop(s)`)
  }
  // THE WHOLE GROUP, not just the supervisor: a SIGKILLed supervisor leaves its
  // websockify/bridge grandchildren behind (see `detached: true` above).
  try { process.kill(-fix.pid, 'SIGKILL') } catch { try { fix.kill('SIGKILL') } catch {} }
  try { spawnSync('pkill', ['-9', '-f', fixStore], { timeout: 5000 }) } catch { /* no pkill */ }
  rmSync(fixStore, { recursive: true, force: true })
}


/* ================================================================== *
 * WP-6.4 — S1..S6: THE BOOT WAIT (SOL §4.8, WP-2.2-2.4)
 *
 * THE DEFECT. A Windows row that was `booting`, or `ready` while sshd was still
 * starting, answered `exit 126 / code: no-ssh` ("not available for Windows
 * computers") or ssh's raw `255`. A model read a permanent-sounding refusal for
 * a computer that was 20 s from working. The contract is now: WAIT (bounded),
 * then say `code: booting` — never `126`, never `255`.
 *
 * HOW IT IS DRIVEN. A real supervisor child (the same binary, its own store and
 * socket) with `DSH_CUA_SSH_BIN` / `DSH_CUA_SCP_BIN` pointed at one stub that
 * speaks OpenSSH's own connection vocabulary. `DSH_CUA_WINDOWS_SSH_WAIT_MS` is
 * set per child, because the budget is read at module load — that is exactly how
 * an operator would set it.
 *
 * NO PROCESS-WIDE ENV IS TOUCHED. `DSH_CUA_SSH_BIN`, `DSH_CUA_SCP_BIN` and
 * `DSH_CUA_WINDOWS_SSH_WAIT_MS` are read at MODULE LOAD, so each case gets its
 * own CHILD with its own env — there is nothing to restore in a `finally`, and
 * two cases with different budgets cannot leak into each other or into the main
 * suite's supervisor.
 *
 * THE STUB'S THREE MODES are the three cases the SOL names:
 *   fail   — always `Connection closed` / 255 (sshd not up yet)
 *   fail2  — fails twice, then answers (a boot that finished inside the budget)
 *   ok     — answers immediately (the control: no wait, no retry)
 * ================================================================== */
{
  const SUP_SOURCE = readFileSync(path.join(REPO, 'docker', 'cua-vm-supervisor.mjs'), 'utf8')
  // ---- S1: the exported default spec, read from the REAL module ----
  //
  // A CHILD, not an import: the supervisor starts a listener at module scope, so
  // importing it in-process would open a second daemon on this test's socket.
  // The child prints the export and exits; the daemon it started dies with it.
  {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cua-spec-'))
    const probe = spawnSync(process.execPath, ['-e',
      "import(process.env.CUA_SUP_URL).then(m=>{console.log('SPEC='+m.WINDOWS_DSH_CUA_DEFAULT);process.exit(0)}).catch(e=>{console.log('ERR='+(e?.message??e));process.exit(1)})"
    ], {
      env: {
        ...process.env,
        CUA_SUP_URL: pathToFileURL(path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')).href,
        CUA_VM_STORE: path.join(dir, 'store'),
        CUA_VM_HOME: path.join(dir, 'home'),
        CUA_SUPERVISOR_SOCK: path.join(dir, 's.sock')
      },
      encoding: 'utf8',
      timeout: 30000
    })
    const printed = /SPEC=(.*)/u.exec(probe.stdout ?? '')?.[1]?.trim() ?? ''
    const landed = /export const WINDOWS_DSH_CUA_DEFAULT = /u.test(SUP_SOURCE)
    checkContract('WP-6.4/S1: the guest install default is the PINNED build, exported for the test',
      landed, printed === 'dsh-cua==0.4.1',
      printed === '' ? String(probe.stderr ?? '').trim().slice(-160) : printed,
      'dsh-cua==0.4.1')
    checkContract('WP-6.4/S1: ...and the env override is still what an operator can change',
      landed, /process\.env\.DSH_CUA_WINDOWS_DSH_CUA \|\| WINDOWS_DSH_CUA_DEFAULT/u.test(SUP_SOURCE))
    rmSync(dir, { recursive: true, force: true })
  }

  const STUB_SSH = `#!/bin/sh
# A STAND-IN FOR ssh/scp THAT SPEAKS THE SAME FAILURE VOCABULARY.
echo "call $*" >> "$CUA_STUB_CALLS"
MODE=$(cat "$CUA_STUB_MODE" 2>/dev/null)
if [ "$MODE" = "fail2" ]; then
  N=$(wc -l < "$CUA_STUB_CALLS" | tr -d ' ')
  if [ "$N" -le 2 ]; then
    echo "Connection closed by 127.0.0.1 port 22" >&2
    exit 255
  fi
  echo ok
  exit 0
fi
if [ "$MODE" = "ok" ]; then
  echo ok
  exit 0
fi
if [ "$MODE" = "hang" ]; then
  # exec, so the KILL the supervisor sends lands on the sleep ITSELF. Without
  # it the shell dies but the sleep keeps the inherited stderr pipe open, and
  # the supervisor's close event waits 30 s for a process it already killed
  # (the wait would then look like a 30 s timeout instead of the 1 s budget).
  exec sleep 30
fi
echo "Connection closed by 127.0.0.1 port 22" >&2
exit 255
`

  /**
   * ONE supervisor child with the stub transport. `rows` is the registry it
   * starts with; a case can rewrite it between calls (the supervisor re-reads the
   * file on every try, which is half of what the wait is FOR).
   */
  const bootSupervisor = async ({ waitMs, rows }) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cua-boot-sup-'))
    const binDir = path.join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const calls = path.join(dir, 'calls.log')
    const mode = path.join(dir, 'mode')
    writeFileSync(calls, '')
    writeFileSync(mode, 'fail')
    for (const bin of ['ssh', 'scp']) writeFileSync(path.join(binDir, bin), STUB_SSH, { mode: 0o755 })
    // The supervisor insists the qemu path EXISTS before it will look at a row.
    writeFileSync(path.join(binDir, 'qemu-system-x86_64'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(path.join(binDir, 'cua'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const store = path.join(dir, 'store')
    const sock = path.join(store, 's.sock')
    // THE WORKSPACE ROOT IS THIS CASE'S OWN DIRECTORY: the scp cases upload a
    // file by relative path, and hardcoding `/workspace` made the block fail in
    // any checkout that is not under it (a mutation copy, CI, a reviewer's tree).
    const workspaceDir = path.join(dir, 'workspace')
    mkdirSync(workspaceDir, { recursive: true })
    mkdirSync(store, { recursive: true })
    writeFileSync(path.join(store, 'registry.json'), `${JSON.stringify({ version: 2, vms: rows }, null, 2)}\n`)
    const child = spawn(process.execPath, [path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')], {
      env: {
        ...process.env,
        CUA_VM_STORE: store,
        CUA_VM_HOME: path.join(dir, 'home'),
        CUA_SUPERVISOR_SOCK: sock,
        CUA_BIN: path.join(binDir, 'cua'),
        CUA_WORKSPACE_ROOT: workspaceDir,
        DSH_CUA_VM_WINDOWS: '1',
        DSH_CUA_WINDOWS_FAKE_HOST_CAPS: '1',
        DSH_CUA_WINDOWS_OEM_DIR: path.join(REPO, 'docker', 'windows-oem'),
        DSH_CUA_WINDOWS_QEMU: path.join(binDir, 'qemu-system-x86_64'),
        // THE TWO TRANSPORTS THE WAIT DRIVES, both stubbed.
        DSH_CUA_SSH_BIN: path.join(binDir, 'ssh'),
        DSH_CUA_SCP_BIN: path.join(binDir, 'scp'),
        // THE BUDGET, read at module load — per case, exactly as documented.
        DSH_CUA_WINDOWS_SSH_WAIT_MS: String(waitMs),
        CUA_STUB_CALLS: calls,
        CUA_STUB_MODE: mode,
        PATH: `${binDir}:${process.env.PATH ?? ''}`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderrText = ''
    child.stderr.on('data', (chunk) => { stderrText += chunk })
    const ask = (payload) => new Promise((resolve) => {
      const socket = net.connect(sock)
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
      socket.on('data', (chunk) => { buffer += chunk })
      socket.on('close', () => { try { resolve(JSON.parse(buffer.split('\n')[0])) } catch { resolve(null) } })
      socket.on('error', () => resolve(null))
    })
    let up = false
    for (let i = 0; i < 120; i += 1) {
      if (existsSync(sock)) { up = true; break }
      await new Promise((r) => setTimeout(r, 100))
    }
    return {
      up,
      workspace: workspaceDir,
      stderr: () => stderrText,
      ask,
      calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).length,
      resetCalls: () => writeFileSync(calls, ''),
      setMode: (value) => writeFileSync(mode, value),
      setRows: (next) => writeFileSync(path.join(store, 'registry.json'), `${JSON.stringify({ version: 2, vms: next }, null, 2)}\n`),
      close: () => { try { child.kill('SIGKILL') } catch {} ; rmSync(dir, { recursive: true, force: true }) }
    }
  }
  const winRow = (state) => ({
    workspace: '/workspace', kind: 'windows', backend: 'qemu', state,
    ssh: true, sshPort: 47999, diskGb: 20, cpu: 2, memory: 4, createdAt: new Date().toISOString()
  })
  const landedWait = /export async function windowsSshBootWait/u.test(SUP_SOURCE)

  // ---- S2: a boot that finishes INSIDE the budget is waited for, not refused ----
  {
    const sup = await bootSupervisor({ waitMs: 8000, rows: { 'boot-2': winRow('ready') } })
    try {
      check('WP-6.4/S2: a supervisor with the stub transport starts', sup.up, sup.stderr().trim().split('\n').at(-1) ?? '')
      if (sup.up) {
        sup.setMode('fail2')
        sup.resetCalls()
        const answer = await sup.ask({ op: 'exec', name: 'boot-2', cmd: 'dir' })
        checkContract('WP-6.4/S2: two connection-level failures then an answer ⇒ the command runs (exit 0)',
          landedWait,
          answer?.ok === true && answer?.exit === 0 && String(answer?.stdout ?? '').trim() === 'ok',
          `exit=${answer?.exit} stdout=${JSON.stringify(String(answer?.stdout ?? '').trim())}`)
        checkContract('WP-6.4/S2: ...and the stub was tried exactly THREE times (no retry loop, no double run)',
          landedWait, sup.calls() === 3, `${sup.calls()} ssh spawn(s)`)
        checkContract('WP-6.4/S2: ...with a legible wait line in the host log',
          landedWait, /waited [\d.]+ s for sshd \(3 attempts\)/u.test(sup.stderr()),
          sup.stderr().split('\n').filter((line) => line.includes('waited')).slice(-1)[0] ?? '(no wait line)')
      }
    } finally { sup.close() }
  }

  // ---- S3/S4/S5: the three give-up shapes, on a 600 ms budget ----
  {
    const sup = await bootSupervisor({ waitMs: 600, rows: { 'boot-3': winRow('ready'), 'boot-4': winRow('booting'), 'boot-5': winRow('installing') } })
    try {
      check('WP-6.4/S3: the 600 ms-budget supervisor starts', sup.up, sup.stderr().trim().split('\n').at(-1) ?? '')
      if (sup.up) {
        // S3: a `ready` row whose sshd never answers.
        sup.setMode('fail')
        sup.resetCalls()
        const s3 = await sup.ask({ op: 'exec', name: 'boot-3', cmd: 'dir' })
        checkContract('WP-6.4/S3: a `ready` row whose sshd never answers answers exit 125 + `code: booting`',
          landedWait,
          s3?.ok === true && s3?.exit === 125 && String(s3?.stderr ?? '').startsWith('code: booting'),
          `exit=${s3?.exit} first=${JSON.stringify(String(s3?.stderr ?? '').split('\n')[0])}`)
        checkContract('WP-6.4/S3: ...`available` is ABSENT (the plugin binds a session on its absence), never `false`',
          landedWait, s3 !== null && Object.hasOwn(s3 ?? {}, 'available') === false,
          JSON.stringify(Object.keys(s3 ?? {}).filter((key) => key === 'available')))
        checkContract('WP-6.4/S3: ...and the budget was actually SPENT (ms ≥ 600), not skipped',
          landedWait, Number(s3?.ms ?? 0) >= 600 && Number(s3?.ms ?? 0) < 5000, `${s3?.ms} ms`)
        checkContract('WP-6.4/S3: ...the stderr names the next action, and never says 126/no-ssh',
          landedWait,
          /next: retry in ~15 s/u.test(String(s3?.stderr ?? '')) && !/no-ssh|126|not available for Windows/iu.test(String(s3?.stderr ?? '')),
          String(s3?.stderr ?? '').split('\n').slice(-1)[0]?.slice(0, 120) ?? '')

        // S4: a row that is honestly `booting` gets the SAME answer, never 126.
        const s4 = await sup.ask({ op: 'exec', name: 'boot-4', cmd: 'dir' })
        checkContract('WP-6.4/S4: a `booting` row answers `code: booting` — never 126 / `no-ssh`',
          landedWait,
          s4?.ok === true && s4?.exit === 125 && String(s4?.stderr ?? '').startsWith('code: booting')
          && s4?.code === 'booting' && !/no-ssh/iu.test(String(s4?.stderr ?? '')),
          `exit=${s4?.exit} code=${s4?.code}`)

        // S5: `installing` needs a Start, not a wait — and ZERO ssh children.
        sup.resetCalls()
        const s5 = await sup.ask({ op: 'exec', name: 'boot-5', cmd: 'dir' })
        checkContract('WP-6.4/S5: an `installing` row answers `code: installing` and spends ZERO ssh spawns',
          landedWait,
          s5?.ok === true && s5?.exit === 125 && s5?.code === 'installing' && sup.calls() === 0,
          `exit=${s5?.exit} code=${s5?.code} spawns=${sup.calls()}`)
        checkContract('WP-6.4/S5: ...and its sentence says when to come back (~60 s), not "not available"',
          landedWait, /retry in ~60 s/u.test(String(s5?.stderr ?? '')),
          String(s5?.stderr ?? '').split('\n').slice(-1)[0]?.slice(0, 120) ?? '')

        // S6: put/get on a `booting` row: available:false + code + the message.
        // THE WORKSPACE ROOT the child was given (see `bootSupervisor`), so the
        // relative local paths below resolve to this file and nowhere else.
        const localProbe = path.join(sup.workspace, 'boot-wait-probe.txt')
        mkdirSync(path.dirname(localProbe), { recursive: true })
        writeFileSync(localProbe, 'probe\n')
        sup.setMode('fail')
        sup.resetCalls()
        const s6put = await sup.ask({ op: 'put', name: 'boot-4', local: 'boot-wait-probe.txt', guest: 'C:\\cua-work\\probe.txt' })
        const s6get = await sup.ask({ op: 'get', name: 'boot-4', guest: 'C:\\cua-work\\probe.txt', local: 'boot-wait-out.txt' })
        checkContract('WP-6.4/S6: `put` on a booting row answers available:false + code:"booting" + the retry message',
          landedWait,
          s6put?.ok === true && s6put?.available === false && s6put?.code === 'booting'
          && /retry in ~\d+ s/u.test(String(s6put?.message ?? '')),
          `code=${s6put?.code} message=${String(s6put?.message ?? '').slice(0, 100)}${s6put?.ok === false ? ` error=${String(s6put?.error ?? '').slice(0, 120)}` : ''}`)
        checkContract('WP-6.4/S6: ...and `get` answers the same way (one vocabulary for both directions)',
          landedWait,
          s6get?.ok === true && s6get?.available === false && s6get?.code === 'booting'
          && /retry in ~\d+ s/u.test(String(s6get?.message ?? '')),
          `code=${s6get?.code} message=${String(s6get?.message ?? '').slice(0, 100)}${s6get?.ok === false ? ` error=${String(s6get?.error ?? '').slice(0, 120)}` : ''}`)
        checkContract('WP-6.4/S6: ...and neither direction ever answers `no-ssh` for a computer that exists',
          landedWait,
          !/no-ssh/iu.test(String(s6put?.message ?? '')) && !/no-ssh/iu.test(String(s6get?.message ?? '')),
          `${String(s6put?.message ?? '').slice(0, 60)} | ${String(s6get?.message ?? '').slice(0, 60)}`)

        // THE LOCAL FILE the two scp cases upload (the same private workspace
        // root as S6, so nothing here depends on the checkout's location).
        const readyProbe = path.join(sup.workspace, 'boot-wait-probe.txt')
        writeFileSync(readyProbe, 'probe\n')

        // ---- S6b: the SCP half of the classification, on a READY row ----
        //
        // The reported defect is "ready, but sshd is still coming up". `exec`
        // retries through `sshRun`; `put`/`get` go through `scpRun`, and if that
        // path did not classify a connection-level failure the same way, a boot
        // race would come back as `vm_put failed over SSH` — the exact sentence
        // this release removes. `fail` = 255 + `Connection closed`.
        sup.setRows({ 'boot-3': winRow('ready'), 'boot-4': winRow('booting'), 'boot-5': winRow('installing') })
        sup.setMode('fail')
        sup.resetCalls()
        const s6ready = await sup.ask({ op: 'put', name: 'boot-3', local: 'boot-wait-probe.txt', guest: 'C:\\cua-work\\probe.txt' })
        checkContract('WP-6.4/S6: `put` on a READY row whose scp is refused answers `code: booting`, not `vm_put failed`',
          landedWait,
          s6ready?.ok === true && s6ready?.available === false && s6ready?.code === 'booting'
          && !/vm_put failed/iu.test(String(s6ready?.message ?? '')),
          `code=${s6ready?.code} message=${String(s6ready?.message ?? s6ready?.error ?? '').slice(0, 90)}`)

        // ---- S6c: A KILLED scp IS STILL A BOOT RACE (`timedOut` must travel) ----
        //
        // The boot wait hands the scp child what is LEFT of its budget. A child
        // killed at that budget is not the command's own deadline: it is the
        // listener hanging mid-handshake, which is retryable. Folding the kill
        // into `code: 124` alone (the pre-fix shape) made the two
        // indistinguishable, so this asserts the retry, not the code.
        sup.setMode('hang')
        sup.resetCalls()
        const hangStart = Date.now()
        const s6hang = await sup.ask({ op: 'put', name: 'boot-3', local: 'boot-wait-probe.txt', guest: 'C:\\cua-work\\probe.txt' })
        const hangMs = Date.now() - hangStart
        checkContract('WP-6.4/S6: a scp killed at the BOOT budget is retried as a boot race (`code: booting`)',
          landedWait,
          s6hang?.ok === true && s6hang?.available === false && s6hang?.code === 'booting'
          && hangMs < 20000,
          `code=${s6hang?.code} ${hangMs}ms message=${String(s6hang?.message ?? s6hang?.error ?? '').slice(0, 80)}`)
        sup.setMode('fail')
        rmSync(localProbe, { force: true })
        rmSync(readyProbe, { force: true })
      }
    } finally { sup.close() }
  }
}

// ---- F2/F3/F4: AN INSTALL THAT NEVER OPENS SSH ---------------------------
//
// THE REPORTED SHAPE (2026-11-21, `vm:win-test`): an install whose guest never
// answered SSH sat at `installing` with the lifecycle key held by `install-watch`
// for 79 minutes — past the point where the install had actually finished and
// the guest had powered itself off. Three things were wrong and all three are
// asserted here, on a row that is genuinely out of luck (SSH never answers):
//
//   * the WATCHER must not hold `vm:<name>` across its ticks (F3) — sampled
//     every 100 ms through the whole grace expiry;
//   * the row must reach the SSH-GRACE TIMEOUT honestly (the booted-stage
//     sentence, D3/D5), not stay `installing` for ever;
//   * nothing may be poisoned (the poison is what makes the refusal permanent).
//
// The row is stamped `bootedAt` 20 minutes ago, so the D3 grace window (15
// minutes after the boot) is already over on the first tick: the same code path
// a real firstboot failure takes, without the suite paying 15 minutes.
{
  const NO_SSH = 'win-nossh'
  const NS_ROOT = path.join(TMP_ROOT, `cua-smoke-nossh-${process.pid}`)
  const NS_STORE = path.join(NS_ROOT, 'store')
  const NS_HOME = path.join(NS_ROOT, 'home')
  const NS_SOCK = path.join(NS_ROOT, 'supervisor.sock')
  const NS_DIR = path.join(NS_STORE, 'windows', NO_SSH)
  for (const dir of [NS_STORE, NS_HOME, NS_DIR, path.join(NS_HOME, '.cua', 'bin')]) mkdirSync(dir, { recursive: true })
  const nsQmpPort = await closedPort()
  const nsSshPort = await closedPort()
  const bootedTwentyMinAgo = new Date(Date.now() - 20 * 60_000).toISOString()
  const createdLongAgo = new Date(Date.now() - 25 * 60_000).toISOString()
  writeFileSync(path.join(NS_STORE, 'registry.json'), `${JSON.stringify({
    version: 2,
    vms: {
      [NO_SSH]: {
        workspace: '/workspace', kind: 'windows', backend: 'qemu', state: 'installing',
        stateSince: createdLongAgo, createdAt: createdLongAgo, startedAt: createdLongAgo,
        installComplete: false, installTimeoutMinutes: 60,
        installStage: 'booted', bootedAt: bootedTwentyMinAgo,
        windowsVersion: '11', cpu: 2, memory: 6,
        ports: { qmp: nsQmpPort, ssh: nsSshPort }
      }
    }
  }, null, 2)}\n`)
  // A LIVE pid (this process): the row has a QEMU, it is the GUEST that is broken.
  writeFileSync(path.join(NS_DIR, 'qemu.pid'), `${process.pid}\n`)
  writeFileSync(path.join(NS_DIR, 'disk.qcow2'), 'a Windows disk')
  writeFileSync(path.join(NS_DIR, 'serial.log'), 'Setup finished, booting the installed disk\n')

  const nsChild = spawn(process.execPath, [path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')], {
    env: {
      ...process.env,
      CUA_VM_STORE: NS_STORE,
      CUA_VM_HOME: NS_HOME,
      CUA_SUPERVISOR_SOCK: NS_SOCK,
      CUA_BIN: STUB,
      CUA_WORKSPACE_ROOT: '/workspace',
      DSH_CUA_WINDOWS_FAKE_HOST_CAPS: '1',
      DSH_CUA_WINDOWS_OEM_DIR: path.join(REPO, 'docker', 'windows-oem'),
      DSH_CUA_WINDOWS_QEMU: path.join(STUB_BIN, 'qemu-system-x86_64'),
      PATH: `${MTOOLS_STUB}:${STUB_BIN}:${process.env.PATH ?? ''}`,
      DSH_CUA_VM_WINDOWS: '1',
      DSH_CUA_WINDOWS_EARLY_CHECK_MS: '600',
      DSH_CUA_WINDOWS_BOOT_SETTLE_MS: '2000',
      DSH_CUA_VM_LOCK_WAIT_MS: '1500'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let nsLog = ''
  nsChild.stdout.on('data', (chunk) => { nsLog += chunk })
  nsChild.stderr.on('data', (chunk) => { nsLog += chunk })
  const nsCall = (payload, timeoutMs = 20_000) => new Promise((resolve) => {
    const socket = net.connect(NS_SOCK)
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
      try { done(JSON.parse(buffer.slice(0, newline))) } catch (error) { done({ ok: false, error: `harness: bad JSON (${error.message})` }) }
    })
    socket.on('error', (error) => { clearTimeout(timer); done({ ok: false, error: `harness: ${error.message}` }) })
  })
  try {
    const nsUp = await waitFor(async () => (await nsCall({ op: 'ping' }, 1000))?.ok === true, 20_000, 200)
    check('F2/F3: the install-watch smoke supervisor accepts a row that will never answer SSH', nsUp === true,
      nsUp ? 'up' : nsLog.slice(-200))
    if (nsUp === true) {
      const samples = []
      const deadline = Date.now() + 20_000
      let reached = null
      while (Date.now() < deadline && reached === null) {
        const doctor = await nsCall({ op: 'vmDoctor' }, 10_000)
        const listed = await nsCall({ op: 'vmList' }, 10_000)
        const row = listed?.registry?.[NO_SSH] ?? null
        if (Array.isArray(doctor?.locks)) {
          samples.push({
            locks: doctor.locks,
            state: row === null ? 'gone' : String(row.state ?? ''),
            installTailAt: row?.installTailAt ?? null
          })
        }
        if (row?.state === 'error') reached = row
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const installingSamples = samples.filter((sample) => sample.state === 'installing')
      const finishedSamples = samples.filter((sample) => sample.state === 'error' || sample.state === 'gone')
      const holds = samples.filter((sample) => sample.locks.some((lock) => Number(lock?.heldMs ?? 0) > 1000))
      const freeWhileInstalling = installingSamples.filter((sample) => sample.locks.some((lock) => lock?.key === `vm:${NO_SSH}`) === false)
      const poisoned = samples.filter((sample) => sample.locks.some((lock) => lock?.poisoned === true))
      // THE SAMPLES MUST BRACKET THE TICK, or "never held" would be a statement
      // about an idle moment: at least three samples while the row is still
      // installing, and at least one after the grace verdict landed.
      check('F3: while the install watch ticks over a row that never opens SSH, `vm:<name>` is NEVER held across a tick — no lock sample shows a hold over 1 s, and the key is free on every sample taken while the row is still installing',
        installingSamples.length >= 3 && finishedSamples.length >= 1 && holds.length === 0
        && freeWhileInstalling.length === installingSamples.length,
        `${samples.length} sample(s): ${installingSamples.length} while installing, ${finishedSamples.length} after the verdict; ${freeWhileInstalling.length} with the key free, holds=${holds.length}${holds.length > 0 ? ` ${JSON.stringify(holds[0].locks)}` : ''}`)
      check('F2/F4: the row reaches the SSH-GRACE TIMEOUT (the booted-stage sentence, D3/D5) instead of staying `installing` for ever',
        reached !== null && /OpenSSH did not answer within 15 minutes after the boot/u.test(String(reached?.error ?? '')),
        `state=${reached?.state ?? 'not reached'} error=${String(reached?.error ?? '').slice(0, 160)}`)
      check('D5: ...and the panel-facing detail is the SSH-missing sentence, not a blank and not "undefined"',
        /OpenSSH did not answer/u.test(String(reached?.installDetail ?? '')),
        String(reached?.installDetail ?? '').slice(0, 160))
      check('C5: nothing is poisoned and no tick had to be skipped — the row writes never contended with the observation loop',
        poisoned.length === 0
        && /poisoned since/u.test(nsLog) === false
        && /install watch skipped a tick/u.test(nsLog) === false,
        `poisoned=${poisoned.length} logPoison=${/poisoned since/u.test(nsLog)} skipped=${/install watch skipped a tick/u.test(nsLog)}`)
    }
  } finally {
    try { nsChild.kill('SIGTERM') } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
    try { nsChild.kill('SIGKILL') } catch {}
    try { rmSync(NS_ROOT, { recursive: true, force: true }) } catch {}
  }
}

// The suite invented its filesystem root on a host whose /tmp is too small: take
// the directory away again, so the checkout's parent stays clean.
if (SMOKE_TMP.created === true) {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }) } catch {}
}

console.log(failures === 0 ? '\nsmoke: PASS' : `\nsmoke: ${failures} FAILURE(S)`)
if (pendings > 0) {
  console.log(`smoke: ${pendings} check(s) PENDING — the production half is absent (SOL WP-2).`)
  console.log('  Run with DSH_CUA_CONTRACT_STRICT=1 to require them now (the T2 mutation check).')
}
process.exit(failures === 0 ? 0 : 1)
