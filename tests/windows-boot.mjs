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
/**
 * D2: THE COMPLETE ARGV OF EVERY ATTEMPT, one line each.
 *
 * `ARGV_LOG` is display-only (it exists for the GPU-fallback assertions and
 * their exact line count). The post-install-shape assertion needs the WHOLE
 * command line, so it gets its own file and cannot disturb those counts.
 */
const ARGV_FULL = path.join(ROOT, 'argv-full.log')
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
printf '%s\\n' "$*" >> "${ARGV_FULL}"
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

const {
  createWindowsBackend, windowsPaths, waitForQemuBoot, qemuStderrExcerpt, classifyQemuInitFailure, qemuBootWindowMs,
  windowsBootedFromDisk, windowsInstallStageFromSerial, formatWindowsInstallDetail,
  WINDOWS_BOOTED_DETAIL, WINDOWS_SSH_MISSING_DETAIL, WINDOWS_SSH_MISSING_MINUTES,
  assertAnswerFileUsesConfigurationSet, assertAnswerFileFirstbootLayers, FIRSTBOOT_FALLBACK_COMMAND,
  // WP-2: the firmware split and the legacy payload staging.
  windowsFirmwareProfile, WINDOWS_CATALOG, writeOemPayload
} = await import('../docker/cua-vm-windows-qemu.mjs')

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
const BLOCK_TABLE = [
  { device: 'disk0', qdev: 'disk0', removable: false },
  { device: 'cd0', qdev: '#block-cd', removable: true, inserted: { file: 'windows.iso' } },
  { device: 'setup0', qdev: 'setupusb', removable: true, inserted: { file: 'setup.img' } }
]
let blockTable = BLOCK_TABLE
const recordingQmp = async (port, commands, opts = {}) => {
  qmpCalls.push({ port, host: opts.host, opts, commands, at: Date.now() })
  return (Array.isArray(commands) ? commands : []).map((command) => {
    if (command?.execute === 'query-status') return { return: { status: 'running', running: true } }
    if (command?.execute === 'query-block') return { return: blockTable }
    return { return: {} }
  })
}
const backend = createWindowsBackend({ store: STORE, qmp: recordingQmp, log: () => {} })
const NAMES = ['win-egl', 'win-kvm', 'win-clean', 'win-slow', 'win-keys', 'win-nokeys', 'win-nocd', 'win-detach', 'win-detach-none', 'win-legacy', 'win-xp']

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

  // ---- D3: THE POST-INSTALL BOOT IS DETECTED FROM THE SERIAL LOG ----
  //
  // THE REPORTED DEFECT: after the install the panel still said "installing
  // (35 min)" while Windows was already on the desktop, and the 60-minute
  // timeout would have marked that SUCCESSFUL install as `error`. The signal is
  // the firmware's own boot narration — a "Windows Boot Manager" boot option
  // exists only after Setup wrote a BCD to the system disk's ESP.
  {
    const userReported = [
      'BdsDxe: loading Boot0004 "Windows Boot Manager" from HD(1,GPT,0F2A...)/\\EFI\\Microsoft\\Boot\\bootmgfw.efi',
      'BdsDxe: starting Boot0004 "Windows Boot Manager"'
    ].join('\n')
    check('D3: the user-reported "Boot0004 Windows Boot Manager from HD(1,GPT...)" counts as booted',
      windowsBootedFromDisk(userReported) === true, 'user-reported serial shape')
    check('D3: ...and a DVD/Setup boot does NOT',
      windowsBootedFromDisk('BdsDxe: loading Boot0002 "UEFI QEMU DVD-ROM QM00003" from PciRoot(0x0)/Pci(0x1F,0x2)/Sata(0x1,0x0,0x0)') === false
      && windowsBootedFromDisk('') === false
      && windowsBootedFromDisk(null) === false)
    check('D3: ...a bare "loading Boot0004" only counts together with a HARD DISK hint',
      windowsBootedFromDisk('BdsDxe: loading Boot0004 from PciRoot(0x0)') === false
      && windowsBootedFromDisk('BdsDxe: loading Boot0004 from HD(1,GPT,abc)') === true)
    check('D3: windowsInstallStageFromSerial names both stages',
      windowsInstallStageFromSerial('Windows Setup is starting') === 'installing'
      && windowsInstallStageFromSerial(userReported) === 'booted')
  }

  // ---- D3/D5: THE TWO SENTENCES ARE EXACT, AND THE 5-MINUTE THRESHOLD ----
  {
    const booted = formatWindowsInstallDetail({ phase: 'install', verdict: {}, elapsedMinutes: 35, serialTail: '', installStage: 'booted', bootedMinutes: 1 })
    check('D3: a booted disk with no SSH says exactly what the user asked for',
      booted === 'Windows booted from the installed disk; waiting for OpenSSH (installed by firstboot) — if this never answers, firstboot failed (see the Unattend.vbs error on the desktop)',
      JSON.stringify(booted))
    const missing = formatWindowsInstallDetail({ phase: 'install', verdict: {}, elapsedMinutes: 40, serialTail: '', installStage: 'booted', bootedMinutes: WINDOWS_SSH_MISSING_MINUTES + 1 })
    check('D5: past five minutes the sentence is the exact firstboot-failed guidance',
      missing === 'OpenSSH did not answer — the firstboot script likely failed; use the noVNC view to check, and Force delete + recreate to retry',
      JSON.stringify(missing))
    check('D3: ...and the constants are those strings (no template can paraphrase them)',
      WINDOWS_BOOTED_DETAIL === booted && WINDOWS_SSH_MISSING_DETAIL === missing && WINDOWS_SSH_MISSING_MINUTES === 5)
    // THE STAGE MAY ARRIVE ON THE VERDICT (the watcher's one-line call site).
    const viaVerdict = formatWindowsInstallDetail({ phase: 'install', verdict: { installStage: 'booted', bootedMinutes: 0 }, elapsedMinutes: 35, serialTail: '' })
    check('D3: ...the watcher\'s one-line call gets the same sentence via verdict.installStage',
      viaVerdict === WINDOWS_BOOTED_DETAIL, JSON.stringify(viaVerdict).slice(0, 80))
    const stillInstalling = formatWindowsInstallDetail({ phase: 'install', verdict: { alive: true, status: 'running', endpoint: 'none' }, elapsedMinutes: 10, serialTail: 'Windows Setup is starting' })
    check('D3: a guest still in Setup keeps the Setup sentence', /^installing \(10 min\)/u.test(stillInstalling), stillInstalling.slice(0, 80))
  }

  // ---- D1: THE ANSWER FILE ASKS FOR $OEM$ AND CARRIES BOTH FIRSTBOOT LAYERS ----
  {
    const template = readFileSync(new URL('../docker/windows-oem/Autounattend.xml', import.meta.url), 'utf8')
    let ok = true
    let detail = ''
    try {
      ok = assertAnswerFileUsesConfigurationSet(template) === true
    } catch (error) {
      ok = false
      detail = String(error?.message)
    }
    check('D1: the answer template sets UseConfigurationSet inside windowsPE/Microsoft-Windows-Setup', ok, detail)
    // NEGATIVE CONTROL: this is the exact shape the reported image shipped — a
    // $OEM$ tree with nothing asking Setup to use it. It must be REFUSED, or the
    // assertion is decoration.
    let refused = false
    try {
      assertAnswerFileUsesConfigurationSet(template.replace('<UseConfigurationSet>true</UseConfigurationSet>', ''))
    } catch {
      refused = true
    }
    check('D1: ...and a template WITHOUT it is refused (the reported D1 shape)', refused)
    let layers = true
    let layerDetail = ''
    try {
      layers = assertAnswerFileFirstbootLayers(template) === true
    } catch (error) {
      layers = false
      layerDetail = String(error?.message)
    }
    check('D1: both firstboot layers are present (hidden launcher + drive-scan fallback)', layers, layerDetail)
    check('D1: the fallback command is the shared constant, single-%d command-line form',
      template.includes(FIRSTBOOT_FALLBACK_COMMAND)
      && /^cmd \/c for %d in \(c d e f g h\) do @if exist "%d:\\cua-firstboot\.ps1" powershell\.exe /u.test(FIRSTBOOT_FALLBACK_COMMAND),
      FIRSTBOOT_FALLBACK_COMMAND.slice(0, 60))
    let bareRefused = false
    try {
      assertAnswerFileFirstbootLayers(template.replace(FIRSTBOOT_FALLBACK_COMMAND, 'rem removed'))
    } catch {
      bareRefused = true
    }
    check('D1: ...and a file missing the fallback is refused', bareRefused)
  }

  // ---- D2: THE INSTALL MEDIA ARE EJECTED, IN ORDER, AND NON-FATALLY ----
  {
    blockTable = BLOCK_TABLE
    qmpCalls.length = 0
    const spec = specFor('win-detach')
    const result = await backend.detachInstallMedia(spec)
    const sent = qmpCalls.flatMap((entry) => (entry.commands ?? []).map((command) => ({ command, port: entry.port, opts: entry.opts })))
    const order = sent.map((entry) => entry.command.execute)
    check('D2: detach asks query-block first, then ejects the CD, then unplugs the stick',
      order.join('>') === 'query-block>eject>device_del', order.join('>'))
    check('D2: ...the eject names the CD block node with force',
      order[1] === 'eject'
      && sent[1]?.command?.arguments?.device === 'cd0'
      && sent[1]?.command?.arguments?.force === true,
      JSON.stringify(sent[1]?.command))
    check('D2: ...and device_del addresses the qdev id from query-block (not the block node)',
      sent[2]?.command?.arguments?.id === 'setupusb', JSON.stringify(sent[2]?.command))
    check('D2: ...every command went to the row\'s QMP port on loopback',
      sent.every((entry) => entry.port === spec.qmpPort && entry.opts?.host === '127.0.0.1'))
    check('D2: the result reports both commands and no errors',
      result.commands.length === 2 && result.errors.length === 0 && result.skipped.length === 0,
      JSON.stringify(result))

    // ALREADY DETACHED: a second call must be silent, not a wall of
    // DeviceNotFound. This is what makes the status poll safe.
    blockTable = [{ device: 'disk0', qdev: 'disk0', removable: false }]
    qmpCalls.length = 0
    const again = await backend.detachInstallMedia(spec)
    check('D2: an already-detached session sends no eject/device_del',
      again.commands.length === 0 && again.skipped.join(',') === 'cd0,setup0'
      && qmpCalls.every((entry) => (entry.commands ?? []).every((command) => command.execute === 'query-block')),
      JSON.stringify(again))

    // THE CONTRACT IS NON-FATAL: no QMP, no exception, and the fields say why.
    const deadBackend = createWindowsBackend({
      store: STORE,
      qmp: async () => { throw new Error('ECONNREFUSED 127.0.0.1') },
      log: () => {}
    })
    const deadSpec = specFor('win-detach-none')
    let threw = null
    let deadResult = null
    try {
      deadResult = await deadBackend.detachInstallMedia(deadSpec)
    } catch (error) {
      threw = error
    }
    check('D2: a dead QMP cannot fail the ready transition (attempted, logged, non-fatal)',
      threw === null && deadResult?.attempted?.length === 2 && deadResult.errors.length >= 2,
      threw === null ? JSON.stringify(deadResult) : String(threw?.message))
  }

  // ---- D2/argv: THE POST-INSTALL BOOT CARRIES NO INSTALL MEDIA ----
  //
  // The running install session is fixed by QMP above; every LATER start builds
  // its argv from `installPending: false`, which must attach neither the CD nor
  // setup.img — otherwise the computer would keep a DVD drive and the SETUP
  // volume after a reboot, and could boot the DVD again.
  {
    writeFileSync(ARGV_FULL, '')
    writeFileSync(FAIL_MARKER, 'ok')
    const spec = specFor('win-nocd')
    await backend.boot(spec, { installPending: false })
    const lines = readFileSync(ARGV_FULL, 'utf8').trim().split('\n').filter((line) => line !== '')
    const argv = lines.at(-1) ?? ''
    check('D2: a post-install boot attaches NO CD and NO setup.img',
      !/id=cd0|drive=cd0|id=setup0|drive=setup0|setup\.img/u.test(argv), argv.slice(0, 240))
    check('D2: ...while the system disk still boots first',
      /ide-hd,drive=disk0,bus=ide\.0,bootindex=1/u.test(argv), argv.slice(0, 200))
    backend.kill(spec.name)
  }

  // ---- WP-2: WINDOWS 7 BOOTS ON A LEGACY BIOS (pc/SeaBIOS) ----
  //
  // The backend was written for Windows 11 and hard-coded its firmware: q35 +
  // OVMF + swtpm + virtio. Windows 7 x64 Setup boots under BIOS only — handed
  // OVMF it reaches "Press any key", finds no bootable device, and drops into
  // the EFI Shell. The profile rewrites FIVE decisions (machine, pflash, TPM,
  // disk, NIC); the assertions below are the ones a diff cannot show.
  {
    writeFileSync(ARGV_LOG, '')
    writeFileSync(ARGV_FULL, '')
    writeFileSync(FAIL_MARKER, 'ok')
    const spec = specFor('win-legacy', { windowsVersion: '7u' })
    const p = spec.paths
    const booted = await backend.boot(spec, { installPending: true })
    const argv = readFileSync(ARGV_FULL, 'utf8').trim().split('\n').filter((line) => line !== '').at(-1) ?? ''
    check('WP-2: a 7u start reports a live pid (the BIOS profile can boot)', typeof booted.pid === 'number' && booted.pid > 0, JSON.stringify(booted).slice(0, 120))
    check('WP-2: ...with NO pflash drive (a BIOS guest handed one is "unsupported machine configuration")',
      !/if=pflash/u.test(argv), argv.slice(0, 200))
    // The literal in the task is `-machine pc`; the argv carries the accelerator
    // suffix too, which is what QEMU accepts, so this is the closest exact form.
    check('WP-2: ...the machine is pc (i440FX/PIIX) with kvm, not q35',
      /-machine pc,accel=kvm(?: |$)/u.test(argv) && !/q35/u.test(argv), (/-machine \S+/u.exec(argv) ?? [''])[0])
    check('WP-2: ...no TPM chardev and no swtpm socket was ever created',
      !/tpm-crb|tpmdev/u.test(argv) && !existsSync(p.tpmSocket), `socket=${existsSync(p.tpmSocket)}`)
    check('WP-2: ...the system disk is IDE and the NIC is e1000e (inbox Windows 7 drivers)',
      /ide-hd,drive=disk0,bus=ide\.0/u.test(argv) && /e1000e,netdev=net0/u.test(argv)
      && !/virtio-blk|virtio-net/u.test(argv), argv.slice(0, 260))
    check('WP-2: the 7u firmware snapshot is the profile the table documents',
      windowsFirmwareProfile('7u').bios === 'seabios' && windowsFirmwareProfile('7u').machine === 'pc')
    // THE ANSWER FILE IS NOT OPTIONAL ON A LEGACY INSTALL: the firmware changed,
    // the unattended contract did not, and writeOemPayload must still stage an
    // <InstallFrom> (Setup asks which edition otherwise).
    const oemPaths = windowsPaths(path.join(ROOT, 'oem-7u'), 'win-legacy')
    mkdirSync(oemPaths.dir, { recursive: true })
    writeOemPayload({
      paths: oemPaths, name: 'win-legacy', password: 'pw', sshPubKey: 'ssh-ed25519 AAAA x',
      sourceDir: path.join(ROOT, '..', 'docker', 'windows-oem'),
      pythonUrl: 'https://example.invalid/python.exe', dshCuaSpec: 'dsh-cua==1.0', windowsVersion: '7u'
    })
    const staged = readFileSync(path.join(oemPaths.oemDir, 'Autounattend.xml'), 'utf8')
    check('WP-2: ...and the staged answer file still names the image (<InstallFrom>)',
      staged.includes('<InstallFrom>') && staged.includes('<Key>/IMAGE/NAME</Key>')
      && staged.includes('<Value>Windows 7 Ultimate</Value>') && !staged.includes('{{IMAGE_INSTALL}}'),
      (staged.match(/<InstallFrom>[\s\S]{0,120}/u) ?? [''])[0].replace(/\s+/gu, ' ').slice(0, 120))
    backend.kill(spec.name)
  }

  // ---- WP-2: XP IS LISTED AND REFUSED — BEFORE ANY PROCESS IS SPAWNED ----
  //
  // Windows XP has no UEFI and no Autounattend path: its Setup reads winnt.sif
  // from a floppy/ISO root, which this payload does not build. The refusal is
  // cheap and NAMED, and it happens in buildQemuArgs — so no QEMU is exec'd, no
  // swtpm is started and the argv log gains no line. A refusal that spawns
  // first would leave a dead process and a half-created store behind.
  {
    writeFileSync(ARGV_LOG, '')
    writeFileSync(ARGV_FULL, '')
    writeFileSync(FAIL_MARKER, 'ok')
    const spec = specFor('win-xp', { windowsVersion: 'xp' })
    let caught = null
    try {
      await backend.boot(spec, { installPending: true })
    } catch (error) {
      caught = error
    }
    check('WP-2: xp boot REFUSES with code legacy-installer-unsupported',
      caught?.code === 'legacy-installer-unsupported', String(caught?.code ?? caught?.message ?? 'no throw'))
    check('WP-2: ...and the refusal names the real obstacle (winnt.sif), not "unknown version"',
      /winnt\.sif/u.test(caught?.message ?? '') && /Windows XP/u.test(caught?.message ?? ''),
      String(caught?.message ?? '').slice(0, 140))
    check('WP-2: the refusal happens BEFORE spawn (no QEMU argv, no pidfile)',
      readFileSync(ARGV_FULL, 'utf8').trim() === '' && !existsSync(spec.paths.qemuPid),
      `argv=${JSON.stringify(readFileSync(ARGV_FULL, 'utf8').slice(0, 60))} pidfile=${existsSync(spec.paths.qemuPid)}`)
    check('WP-2: ...and the catalog is what the refusal quotes',
      WINDOWS_CATALOG.xp.refusal === 'legacy-installer-unsupported' && WINDOWS_CATALOG.xp.bios === 'seabios')
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
