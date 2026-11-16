#!/usr/bin/env node
/**
 * windows-boot.mjs — the Windows backend's BOOT path, exercised end to end
 * against stub binaries.
 *
 * WHY A SECOND SUITE AND NOT MORE ASSERTS IN supervisor-smoke
 * -----------------------------------------------------------
 * `supervisor-smoke.mjs` drives the supervisor over its socket; this one drives
 * `createWindowsBackend().boot()` directly, because three of the four fixes this
 * suite pins live INSIDE boot() and are invisible from the socket:
 *
 *   F1  QEMU's stderr is captured to `$STORE/windows/<name>/qemu-stderr.log`
 *       (it used to be `/dev/null`, which is why the user's dead create left no
 *       diagnosis anywhere on the host);
 *   F2  a QEMU that exits WITHOUT writing its pidfile is a FAILED start, and the
 *       error carries the last ~20 stderr lines, so the supervisor can flip the
 *       row to `error` immediately instead of watching it for 60 minutes;
 *   F3  a start that fails on the EGL/render-node display path retries ONCE with
 *       `-display none` + plain VGA and returns a `gpu-fallback` warning — but a
 *       KVM failure is NEVER degraded that way.
 *
 * The host needs no QEMU, no /dev/kvm and no OVMF: the documented
 * `DSH_CUA_WINDOWS_FAKE_HOST_CAPS=1` hook reports the capabilities present, and
 * the two binaries this file talks to are shell scripts it writes itself.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'cua-winboot-'))
const STORE = path.join(ROOT, 'store')
const BIN = path.join(ROOT, 'bin')
mkdirSync(STORE, { recursive: true })
mkdirSync(BIN, { recursive: true })

const ARGV_LOG = path.join(ROOT, 'argv.log')
const FAIL_MARKER = path.join(ROOT, 'fail-mode')

/** The stub QEMU: parses the argv, records it, and behaves per `fail-mode`. */
const QEMU = path.join(BIN, 'qemu-system-x86_64')
writeFileSync(QEMU, `#!/bin/sh
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
printf 'display=%s\\n' "$DISPLAY" >> "${ARGV_LOG}"
MODE="$(cat "${FAIL_MARKER}" 2>/dev/null || echo ok)"
case "$MODE" in
  slow)
    # THE LIVE FAILURE SHAPE: a QEMU that is STILL INITIALIZING when it is asked
    # for its pidfile. It writes the file only after ~100 ms. A boot window of
    # 0 ms (the unset→0 defect) declared this dead on the first poll.
    sleep 0.1
    ;;
  egl)
    case "$DISPLAY" in
      egl-headless*)
        echo "qemu-system-x86_64: egl: no drm render node available" >&2
        echo "qemu-system-x86_64: egl: render node init failed" >&2
        exit 1
        ;;
    esac
    ;;
  kvm)
    echo "qemu-system-x86_64: -machine q35,accel=kvm: cannot access memory" >&2
    echo "qemu-system-x86_64: kvm_init_vcpu: failed to initialize vcpu" >&2
    exit 1
    ;;
esac
if [ -n "$PIDFILE" ]; then printf '%s\\n' "$$" > "$PIDFILE"; fi
exec sleep 60
`, { mode: 0o755 })

/** The stub swtpm: creates the control socket file and stays alive. */
const SWTPM = path.join(BIN, 'swtpm')
writeFileSync(SWTPM, `#!/bin/sh
SOCK=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--ctrl" ]; then
    SOCK="\${a#type=unixio,path=}"
  fi
  prev="$a"
done
[ -z "$SOCK" ] || : > "$SOCK"
exec sleep 60
`, { mode: 0o755 })
chmodSync(SWTPM, 0o755)

// The module reads these at IMPORT time, so they must be set first.
process.env.DSH_CUA_WINDOWS_FAKE_HOST_CAPS = '1'
process.env.DSH_CUA_WINDOWS_QEMU = QEMU
process.env.DSH_CUA_WINDOWS_SWTPM = SWTPM
process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS = '1500'

const { createWindowsBackend, windowsPaths, waitForQemuBoot, qemuStderrExcerpt, classifyQemuInitFailure, qemuBootWindowMs } =
  await import('../docker/cua-vm-windows-qemu.mjs')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/**
 * R1: A QMP STUB THAT RECORDS WHAT WAS SENT.
 *
 * The key schedule is only meaningful if the keystrokes actually reach QMP
 * during the install window, so this stub keeps every command and the test
 * asserts the `input-send-event` presses (and their count) rather than trusting
 * that the scheduling code ran.
 */
const qmpCalls = []
/**
 * THE STUB SPEAKS THE SUPERVISOR'S SIGNATURE — `(port, commands, opts)` — on
 * purpose: `createWindowsBackend` adapts whatever primitive it is given, so a
 * stub in the backend's shape would hide the R3 mismatch instead of proving the
 * adapter. `opts.host` and `opts.timeoutMs` are what the adapter adds.
 */
const recordingQmp = async (port, commands, opts = {}) => {
  qmpCalls.push({ port, host: opts.host, opts, commands, at: Date.now() })
  return (Array.isArray(commands) ? commands : []).map((command) =>
    command?.execute === 'query-status' ? { return: { status: 'running', running: true } } : { return: {} })
}
const backend = createWindowsBackend({ store: STORE, qmp: recordingQmp, log: () => {} })
const NAMES = ['win-egl', 'win-kvm', 'win-clean', 'win-slow', 'win-keys', 'win-nokeys']

/** A bootable-enough windows directory: the vars file must already exist. */
function prepare(name) {
  const p = windowsPaths(STORE, name)
  mkdirSync(p.dir, { recursive: true })
  mkdirSync(p.tpmDir, { recursive: true })
  writeFileSync(p.efiVars, 'fake OVMF vars')
  writeFileSync(p.disk, 'fake disk')
  writeFileSync(p.isoOem ?? path.join(p.dir, 'tiny.iso'), 'not an iso')
  return p
}

function specFor(name, overrides = {}) {
  const p = prepare(name)
  return {
    name,
    cpu: 2,
    memory: 4,
    gpu: true,
    virgl: true,
    paths: p,
    isoPath: path.join(p.dir, 'tiny.iso'),
    qmpPort: 46400 + NAMES.indexOf(name),
    vncPort: 5940 + NAMES.indexOf(name),
    sshPort: 47400 + NAMES.indexOf(name),
    ...overrides
  }
}

try {
  // ---- F3 (first attempt succeeds): no fallback, no warning ----
  {
    writeFileSync(FAIL_MARKER, 'ok')
    const spec = specFor('win-egl')
    const booted = await backend.boot(spec, { installPending: true })
    check('a clean start reports gpuFallback: false and no warnings',
      booted.gpuFallback === false && (booted.warnings ?? []).length === 0, JSON.stringify(booted))
    check('...and it really used the EGL display', readFileSync(ARGV_LOG, 'utf8').includes('display=egl-headless,rendernode=/dev/dri/renderD128'))
    backend.kill(spec.name)
  }

  // ---- F1 + F3: an EGL failure degrades ONCE with -display none ----
  {
    writeFileSync(ARGV_LOG, '')
    writeFileSync(FAIL_MARKER, 'egl')
    const spec = specFor('win-egl')
    const p = spec.paths
    const booted = await backend.boot(spec, { installPending: true })
    const argvLines = readFileSync(ARGV_LOG, 'utf8').trim().split('\n')
    check('an EGL/render-node failure retries ONCE without the GPU display',
      argvLines.length === 2 && argvLines[0].includes('egl-headless') && argvLines[1] === 'display=none', argvLines.join(' | '))
    check('...the retry succeeded, so boot() reports a live pid', typeof booted.pid === 'number' && booted.pid > 0 && booted.gpuFallback === true, JSON.stringify(booted))
    const warning = (booted.warnings ?? [])[0] ?? {}
    check('...and carries the gpu-fallback warning with the captured reason',
      warning.code === 'gpu-fallback' && /virgl\/EGL display unavailable on this host/u.test(warning.message ?? '')
      && /egl: no drm render node available|render node init failed/u.test(warning.message ?? '')
      && /emulated VGA\/WARP/u.test(warning.message ?? ''), JSON.stringify(warning))
    check('F1: QEMU stderr is captured to $STORE/windows/<name>/qemu-stderr.log',
      existsSync(p.qemuStderr) && /egl: no drm render node available/u.test(readFileSync(p.qemuStderr, 'utf8')), p.qemuStderr)
    backend.kill(spec.name)
  }

  // ---- F2: a die-at-init start is a FAILURE with the stderr excerpt ----
  {
    writeFileSync(ARGV_LOG, '')
    writeFileSync(FAIL_MARKER, 'kvm')
    const spec = specFor('win-kvm')
    const p = spec.paths
    let caught = null
    try {
      await backend.boot(spec, { installPending: true })
    } catch (error) {
      caught = error
    }
    check('a QEMU that exits at init THROWS instead of reporting a live computer', caught !== null)
    check('F1: the error carries the last QEMU stderr lines', /cannot access memory/u.test(caught?.message ?? '')
      && /kvm_init_vcpu/u.test(caught?.message ?? ''), String(caught?.message).split('\n').slice(0, 3).join(' / '))
    check('F1: ...and names the captured file', /qemu-stderr\.log/u.test(caught?.message ?? ''))
    check('F1/F2: no pidfile is left behind for a dead init', !existsSync(p.qemuPid))
    // F3's hard edge: a KVM failure is NEVER degraded to `-display none`.
    const argvLines = readFileSync(ARGV_LOG, 'utf8').trim().split('\n').filter((line) => line !== '')
    check('F3: a KVM failure is NOT retried with a GPU-less display',
      argvLines.length === 1 && argvLines[0].includes('egl-headless'), argvLines.join(' | '))
    check('F3: ...and the error says so in words (no silent TCG)',
      /KVM|accelerator/iu.test(caught?.message ?? '') && /NOT retried without the GPU/u.test(caught?.message ?? ''), String(caught?.message).slice(0, 200))
    backend.kill(spec.name)
  }

  // ---- F3 (live failure shape): BOTH WINDOWS UNSET, QEMU WRITES ITS PIDFILE
  //      LATE ----
  //
  // THE ACTUAL USER BUG, REPLAYED. `qemuBootWindowMs()` computed 0 when its env
  // var was UNSET (`Number(undefined ?? '')` → 0, `0 >= 0` → accepted), so the
  // first poll ran against an already-expired deadline and declared a QEMU that
  // was ~1 ms old dead: "died during init (none): no stderr output". The suites
  // missed it because both SET the window. Here NEITHER is set, and the stub
  // QEMU deliberately takes ~100 ms to write its pidfile — far longer than 0 ms,
  // comfortably inside the real 15 s default. With the old code this start dies
  // at ~1 ms; with the fix it reports a live computer.
  {
    writeFileSync(ARGV_LOG, '')
    writeFileSync(FAIL_MARKER, 'slow')
    const savedBoot = process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS
    const savedEarly = process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS
    delete process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS
    delete process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS
    const spec = specFor('win-slow')
    const p = spec.paths
    const started = Date.now()
    // CAPTURED WHILE UNSET: the suite's own header sets 1500 at import time, so
    // the value must be read here, not after the restore below.
    const windowWhileUnset = qemuBootWindowMs()
    let booted = null
    let caught = null
    try {
      booted = await backend.boot(spec, { installPending: true })
    } catch (error) {
      caught = error
    } finally {
      if (savedBoot === undefined) delete process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS
      else process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS = savedBoot
      if (savedEarly === undefined) delete process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS
      else process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS = savedEarly
    }
    const elapsed = Date.now() - started
    check('F3: with BOTH windows UNSET the default is used (15000 ms), not 0',
      windowWhileUnset === 15000, String(windowWhileUnset))
    check('F3: a QEMU that writes its pidfile ~100 ms after spawn is NOT called dead',
      caught === null && typeof booted?.pid === 'number' && booted.pid > 0,
      caught === null ? JSON.stringify(booted) : String(caught?.message).split('\n')[0])
    check('F3: ...the boot really waited for the late pidfile (>= 90 ms) and the pidfile is on disk',
      elapsed >= 90 && existsSync(p.qemuPid), `${elapsed}ms pidfile=${existsSync(p.qemuPid)}`)
    backend.kill(spec.name)
  }

  // ---- R1: THE CDBOOT "PRESS ANY KEY" WINDOW IS PRESSED, AND ONLY WHILE
  //      INSTALLING ----
  //
  // VERIFIED LIVE: OVMF reached the install CD, `cdboot.efi 10.0.26100.1`
  // printed "Press any key to boot from CD or DVD", nothing pressed a key, and
  // after 5 s the firmware printed EFI_TIMEOUT and dropped into the EFI Internal
  // Shell. boot() now presses Enter through the SAME QMP input path the GUI
  // uses, three times inside that window, gated on `installPending`.
  {
    const savedSchedule = process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS
    process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS = '20,60,120'
    try {
      writeFileSync(FAIL_MARKER, 'ok')
      qmpCalls.length = 0
      const spec = specFor('win-keys')
      const booted = await backend.boot(spec, { installPending: true })
      check('R1: an install boot reports a live pid', typeof booted.pid === 'number' && booted.pid > 0, JSON.stringify(booted))
      await new Promise((resolve) => setTimeout(resolve, 500))
      const keyPresses = qmpCalls.filter((entry) => (entry.commands ?? []).some((command) => command.execute === 'input-send-event'))
      check('R1: an install boot sends the cdboot key presses over QMP',
        keyPresses.length === 3, `${keyPresses.length} input-send-event call(s)`)
      const events = (keyPresses[0]?.commands?.[0]?.arguments?.events ?? [])
      check('R1: ...as a real Enter make/break pair (qcode ret)',
        events.length === 2
        && events.every((event) => event.data?.key?.data === 'ret')
        && events[0].data.down === true && events[1].data.down === false,
        JSON.stringify(events))
      check('R1: ...addressed to the row\'s QMP port on loopback',
        keyPresses.every((entry) => entry.port === spec.qmpPort && entry.opts?.host === '127.0.0.1'),
        JSON.stringify({ port: keyPresses[0]?.port, expect: spec.qmpPort, opts: keyPresses[0]?.opts }))
      backend.kill(spec.name)

      // THE OTHER HALF OF THE GATE: a normal boot of an INSTALLED disk must not
      // type into the guest.
      qmpCalls.length = 0
      const installed = specFor('win-nokeys')
      await backend.boot(installed, { installPending: false })
      await new Promise((resolve) => setTimeout(resolve, 400))
      const strayKeys = qmpCalls.filter((entry) => (entry.commands ?? []).some((command) => command.execute === 'input-send-event'))
      check('R1: a boot of an ALREADY-INSTALLED disk sends no keys', strayKeys.length === 0, `${strayKeys.length} call(s)`)
      backend.kill(installed.name)
    } finally {
      if (savedSchedule === undefined) delete process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS
      else process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS = savedSchedule
      try { writeFileSync(FAIL_MARKER, 'ok') } catch {}
    }
  }

  // ---- R2: a boot of a row WITHOUT `name` still owns its own pidfile ----
  {
    const spec = specFor('win-rowshape')
    const booted = await backend.boot(spec, { installPending: false })
    const row = { kind: 'windows', backend: 'qemu', ports: { qmp: spec.qmpPort, ssh: spec.sshPort, vnc: spec.vncPort } }
    check('R2: a nameless registry row finds no pidfile (the "undefined" path)',
      backend.qemuPid(row) === 0, String(backend.qemuPid(row)))
    check('R2: ...but the same row resolved by its map key does',
      backend.qemuPid({ ...row, name: 'win-rowshape' }) === booted.pid,
      `${backend.qemuPid({ ...row, name: 'win-rowshape' })} vs ${booted.pid}`)
    const state = await backend.probe(row, { name: 'win-rowshape' })
    check('R2: probe(row, { name }) is alive and QMP running — not the fake "not alive"',
      state.alive === true && state.qmp === 'running', JSON.stringify(state))
    backend.kill('win-rowshape')
  }

  // ---- F2 unit: waitForQemuBoot answers fast for a dead child ----
  {
    const pidFile = path.join(ROOT, 'nope.pid')
    const fakeChild = { once: () => {} }
    const started = Date.now()
    const verdict = await waitForQemuBoot({ child: fakeChild, pidFile, isAlive: () => false, windowMs: 60, pollMs: 10 })
    check('waitForQemuBoot reports "no pidfile" after the window, not a hang',
      verdict.ok === false && verdict.pidFile === false && verdict.reason === 'timeout' && Date.now() - started < 2000, JSON.stringify(verdict))
    writeFileSync(pidFile, 'not-a-pid\n')
    const bad = await waitForQemuBoot({ child: fakeChild, pidFile, isAlive: () => false, windowMs: 300, pollMs: 10 })
    check('waitForQemuBoot rejects a pidfile that names no pid', bad.ok === false && bad.reason === 'pidfile-invalid', JSON.stringify(bad))
    writeFileSync(pidFile, `${process.pid}\n`)
    const good = await waitForQemuBoot({ child: fakeChild, pidFile, isAlive: (pid) => pid === process.pid, windowMs: 200, pollMs: 10 })
    check('waitForQemuBoot accepts a pidfile whose pid is alive', good.ok === true && good.pid === process.pid, JSON.stringify(good))
  }

  // ---- the pure helpers ----
  {
    check('qemuStderrExcerpt keeps n lines and drops blanks',
      qemuStderrExcerpt('a\n\n b \n c \n', 2) === ' b\n c', JSON.stringify(qemuStderrExcerpt('a\n\n b \n c \n', 2)))
    check('classifyQemuInitFailure separates kvm from display',
      classifyQemuInitFailure('qemu-system-x86_64: kvm_init_vcpu: failed') === 'kvm'
      && classifyQemuInitFailure('qemu-system-x86_64: egl: no drm render node available') === 'display'
      && classifyQemuInitFailure('qemu-system-x86_64: -device foo: Bus "xhci.0" not found') === 'init'
      && classifyQemuInitFailure('') === 'none')
    check('a KVM+EGL mixture classifies as kvm (the accelerator wins)',
      classifyQemuInitFailure('egl: no drm render node available\nkvm_init_vcpu: failed') === 'kvm')
  }
} catch (error) {
  failures += 1
  console.log(` FAIL harness: ${error?.stack ?? error}`)
} finally {
  for (const name of NAMES) {
    try { backend.kill(name) } catch {}
  }
  rmSync(ROOT, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nwindows boot: PASS' : `\nwindows boot: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
