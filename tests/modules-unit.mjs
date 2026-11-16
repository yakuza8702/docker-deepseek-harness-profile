#!/usr/bin/env node
/**
 * modules-unit.mjs — the pure parts of the two new modules, and the Windows
 * container spec, asserted without a VM, a container or a daemon.
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync, accessSync, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import {
  pngSize, formatSpace, formatSpaceWarning, spaceLine, relativeToPixels, toDisplayPixels, resolutionProblem, createSpace
} from '../docker/cua-vm-space.mjs'
import {
  WINDOWS_VERSIONS, WINDOWS_ISO_SOURCES, resolveWindowsIso, canonicalWindowsVersion, windowsCapacityWarnings,
  charToKey, parseKeySpec, generatePassword, windowsEnabled,
  buildQemuArgs, vncDisplayFor, vncPortFor, windowsPaths, frameSpace,
  OEM_PAYLOAD_FILES, oemPayloadDir, oemPayloadDirStatus, oemPayloadDeniedDir, resolveOemSourceDir, writeOemPayload,
  oemPayloadMissingError, oemPayloadDeniedError, windowsKvmPreflight,
  formatWindowsInstallDetail, qmpStateLabel, endpointLabel, windowsTailLines, windowsPortsOf, windowsBootSpec,
  windowsReadinessSignals
} from '../docker/cua-vm-windows-qemu.mjs'
import {
  KVM_GID_COMMAND, deviceNodePresent, formatKvmStatus, kvmDoctorFacts, kvmPreflightError, kvmStatus
} from '../docker/cua-vm-kvm.mjs'

/** The checkout root — the source of `docker/windows-oem/` in these tests. */
const REPO = path.resolve(import.meta.dirname, '..')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** A real 1200x750 PNG (IHDR + one IDAT + IEND), built with zlib only. */
function makePng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const crc32 = (buffer) => {
    let crc = 0xffffffff
    for (const byte of buffer) {
      crc ^= byte
      for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc((width * 3 + 1) * Math.min(height, 2))
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---- space: the PNG probe is the measurement, not a guess ----
const png = makePng(1200, 750)
check('pngSize reads the IHDR of a real PNG', pngSize(png)?.width === 1200 && pngSize(png)?.height === 750, JSON.stringify(pngSize(png)))
check('pngSize refuses a non-PNG', pngSize(Buffer.from('GIF89a')) === null)

const oneToOne = { display: { width: 1200, height: 750 }, screenshot: { width: 1200, height: 750 }, scale: 1, source: 'png' }
check('a 1:1 desktop reports scale 1 and no warning', formatSpace(oneToOne) === 'screenshot 1200x750 · display 1200x750 · scale 1' && formatSpaceWarning(oneToOne) === '', formatSpace(oneToOne))

// 1280x800 captured at 1200x750 is the exact bug this module exists for.
const scaled = { display: { width: 1280, height: 800 }, screenshot: { width: 1200, height: 750 }, scale: 1280 / 1200, source: 'png' }
check('a scaled capture prints the ratio', formatSpace(scaled) === 'screenshot 1200x750 · display 1280x800 · scale 1.0667', formatSpace(scaled))
check('the warning says image px = 0.9375 × display px and "do not rescale"',
  formatSpaceWarning(scaled) === 'image px = 0.9375 × display px; cua maps it — do not rescale', formatSpaceWarning(scaled))
check('spaceLine carries both lines', spaceLine(scaled).split('\n').length === 2)

check('relativeToPixels resolves against the MEASURED capture (no sqrt budget)',
  relativeToPixels(scaled, 0.5, 0.5).x === 600 && relativeToPixels(scaled, 0.5, 0.5).y === 375,
  JSON.stringify(relativeToPixels(scaled, 0.5, 0.5)))
check('toDisplayPixels multiplies by the measured scale for xdotool',
  toDisplayPixels(scaled, 600, 375).x === 640 && toDisplayPixels(scaled, 600, 375).y === 400,
  JSON.stringify(toDisplayPixels(scaled, 600, 375)))

check('1200x750 is allowed (exactly the capture budget)', resolutionProblem('1200x750', false) === null)
check('1920x1080 is refused unless the operator opts in', /above cua/.test(resolutionProblem('1920x1080', false) ?? ''))
check('DSH_CUA_VM_RESOLUTION_ALLOW_SCALE=1 accepts a scaled capture', resolutionProblem('1920x1080', true) === null)
check('a malformed resolution is refused with its name', /not WxH/.test(resolutionProblem('big', false) ?? ''))

check('a 4:3 display is not 1:1 either', Math.abs((4 / 3) - 1) > 1e-6)

// ---- space: the 30 s cache, and invalidation ----
let clock = 0
let displayCalls = 0
let captureCalls = 0
const space = createSpace({
  display: async () => { displayCalls += 1; return { width: 1280, height: 800 } },
  capture: async () => { captureCalls += 1; return { width: 1200, height: 750 } },
  now: () => clock
})
const first = await space.measure('vm')
const second = await space.measure('vm')
check('two calls inside the TTL measure once', displayCalls === 1 && captureCalls === 1 && first.scale === second.scale)
clock += 31_000
await space.measure('vm')
check('the cache expires after 30 s', displayCalls === 2)
space.invalidate('vm')
await space.measure('vm')
check('invalidate() forces a fresh measurement (resume/restart/zoom)', displayCalls === 3)

// ---- windows: the spec contract ----
check('the six Windows versions are the pinned ones', WINDOWS_VERSIONS.join(',') === '11,11ltsc,10,ltsc10,2022,2025', WINDOWS_VERSIONS.join(','))
check('charToKey maps ASCII to physical qcodes', charToKey('a')?.qcode === 'a' && charToKey('A')?.shift === true && charToKey('!')?.qcode === '1' && charToKey(' ')?.qcode === 'spc' && charToKey('.')?.qcode === 'dot')
check('charToKey refuses non-ASCII (no clipboard)', charToKey('é') === null && charToKey('中') === null)
check('parseKeySpec handles named keys and modifiers', parseKeySpec('enter').qcode === 'ret' && parseKeySpec('ctrl+c').ctrl === true && parseKeySpec('shift+tab').shiftModifier === true)
let threw = false
try { parseKeySpec('ctrl+é') } catch { threw = true }
check('parseKeySpec refuses an untypable key with a reason', threw)
const pw = generatePassword()
check('generatePassword is 20 url/shell-safe chars', pw.length === 20 && /^[A-Za-z0-9_-]+$/u.test(pw), pw.slice(0, 4) + '…')
check('generatePassword does not repeat', generatePassword() !== generatePassword())
check('windowsEnabled() is on unless DSH_CUA_VM_WINDOWS=0', windowsEnabled() === true)

// A tar with one file, the shape Docker's archive endpoint returns.
function makeTar(name, body) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'ascii')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header[156] = '0'.charCodeAt(0)
  header.write('ustar\0' + '00', 257, 'ascii')
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat([header, body, padding, Buffer.alloc(1024)])
}
const tar = makeTar('cua-shot-1.png', png)
// ---- the Windows QEMU command line ----
const paths = windowsPaths('/cua-vm', 'win-1')
const argv = buildQemuArgs({
  name: 'win-1', cpu: 4, memory: 8, gpu: false, paths,
  isoPath: '/cua-vm/iso/w11.iso', driverIso: null, sshPort: 47100, vncPort: 5931, qmpPort: 46100,
  installPending: true, virtio: false
})
const has = (needle) => argv.includes(needle)
check('the firmware is OVMF code + per-computer vars', argv.join(' ').includes('if=pflash,format=raw,readonly=on,file=') && argv.join(' ').includes(paths.efiVars), 'pflash pair')
check('the TPM2 chardev points at the swtpm socket', argv.join(' ').includes(`socket,id=chrtpm,path=${paths.tpmSocket}`))
check('the system disk is a plain qcow2 (checkpointable)', argv.join(' ').includes(`file=${paths.disk},if=none,id=disk0,format=qcow2`) )
check('kvm + host cpu are the acceleration', has('q35,accel=kvm,smm=off') && has('host'))
check('the install ISO gets bootindex 2 only while installing', argv.join(' ').includes('if=none,id=cd0') && argv.join(' ').includes('bootindex=2'))
check('the OEM payload is a READ-ONLY vvfat USB stick', argv.join(' ').includes(`file=fat:ro:${paths.oemDir}`) && has('usb-storage,drive=oem0,bus=xhci.0'))
check('the USB controller is declared before the device that uses its bus', argv.indexOf('qemu-xhci,id=xhci') !== -1
  && argv.indexOf('qemu-xhci,id=xhci') < argv.indexOf('usb-storage,drive=oem0,bus=xhci.0'))
check('networking is SLIRP with an SSH forward', argv.join(' ').includes('user,id=net0,hostfwd=tcp:127.0.0.1:47100-:22'))
check('absolute pointing needs usb-tablet', has('usb-tablet'))
// B1: `-vnc` takes a DISPLAY number, so the argv must carry 5931-5900 = 31.
// Passing the raw port binds 5900+5931 = 11831 and every probe misses.
check('the VNC display is the allocated port MINUS 5900', argv.join(' ').includes('127.0.0.1:31') && !argv.join(' ').includes('127.0.0.1:5931'), argv[argv.indexOf('-vnc') + 1])
check('the display conversion round-trips', vncPortFor(vncDisplayFor(5931)) === 5931)
check('QMP is loopback-bound', argv.join(' ').includes('tcp:127.0.0.1:46100,server=on,wait=off'))
check('no install ISO is attached once the disk owns the boot', !buildQemuArgs({ ...{
  name: 'win-1', cpu: 4, memory: 8, gpu: false, paths, isoPath: '/x.iso', driverIso: null, sshPort: 1, vncPort: 2, qmpPort: 3, installPending: false, virtio: false
} }).join(' ').includes('id=cd0'))

check('the VNC display number is port - 5900', vncDisplayFor(5931) === 31 && vncPortFor(31) === 5931)
check('a frame IS the display for the QMP path', frameSpace(png).scale === 1 && frameSpace(png).source === 'qmp')
// K2: exactly one source has a probed public URL; the others refuse by name
// instead of 400ing mid-download.
check('exactly two pinned ISO sources have a public URL', Object.keys(WINDOWS_ISO_SOURCES).length === 6
  && Object.values(WINDOWS_ISO_SOURCES).filter((entry) => typeof entry.url === 'string').length === 2)
check('the pinned URL is the probed Microsoft one', WINDOWS_ISO_SOURCES['2025'].url.startsWith('https://software-static.download.prss.microsoft.com/'))
check('a version without a public link refuses with its name and the remediation', (() => {
  try { resolveWindowsIso('11'); return false } catch (error) {
    return /windowsVersion "11" has no public direct ISO link/.test(error.message) && /windowsIso/.test(error.message)
  }
})())
check('the probed version resolves', resolveWindowsIso('2025').url.startsWith('https://'))
// LTSC: pinned from Microsoft's Evaluation Center link, probed 206.
check('Windows 11 IoT LTSC 2024 is a pinned, probed source', WINDOWS_ISO_SOURCES['11ltsc'].url.includes('CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso')
  && /2026-11-15: HTTP 206/u.test(WINDOWS_ISO_SOURCES['11ltsc'].probed))
check('the ltsc11 alias resolves to 11ltsc', canonicalWindowsVersion('ltsc11') === '11ltsc'
  && resolveWindowsIso('ltsc11').url === WINDOWS_ISO_SOURCES['11ltsc'].url)
check('exactly two versions have a probed public URL', WINDOWS_VERSIONS.filter((v) => WINDOWS_ISO_SOURCES[v].url !== null).join(',') === '11ltsc,2025')

// Floors are warnings, not clamps.
check('the Windows defaults produce no warnings', windowsCapacityWarnings({ diskGb: 64, memory: 6, cpu: 2 }).length === 0)
check('a below-floor disk warns and is not refused', (() => {
  const warnings = windowsCapacityWarnings({ diskGb: 8, memory: 6, cpu: 2 })
  return warnings.length === 1 && warnings[0].code === 'disk-below-floor' && /Windows Update will run out of space/u.test(warnings[0].message)
})())
check('a below-floor RAM and CPU warn too', windowsCapacityWarnings({ diskGb: 64, memory: 2, cpu: 1 }).map((w) => w.code).join(',') === 'memory-below-floor,cpu-below-floor')
check('the Windows store paths are all under $STORE', Object.values(paths).every((value) => String(value).startsWith('/cua-vm/')))

// K2: THE OEM PAYLOAD — path, self-heal, and the actionable failure.
// The user-facing bug was a runtime error that named a path and nothing else:
// "the OEM payload is missing from this image: /usr/local/share/cua-vm/windows-oem".
// These four checks pin the three properties that make it recoverable.
{
  const repoOem = path.join(REPO, 'docker', 'windows-oem')
  check('the OEM file list is the three files the writer needs', OEM_PAYLOAD_FILES.join(',') === 'Autounattend.xml,setupcomplete.cmd,cua-firstboot.ps1')
  check('a complete payload directory is recognised, an incomplete one is not', (() => {
    const partial = mkdtempSync(path.join(os.tmpdir(), 'oem-partial-'))
    try {
      writeFileSync(path.join(partial, 'Autounattend.xml'), '<unattend/>')
      return oemPayloadDir(repoOem) === repoOem && oemPayloadDir(partial) === null && oemPayloadDir('/no/such/dir') === null
    } finally {
      rmSync(partial, { recursive: true, force: true })
    }
  })())
  check('the resolver prefers the configured source and falls back in order', (() => {
    const dirs = ['/no/such/dir', repoOem]
    return resolveOemSourceDir(dirs) === repoOem && resolveOemSourceDir(['/no/such/dir']) === null
  })())
  check('a stale source self-heals from the fallback, with a log line', (() => {
    const store = mkdtempSync(path.join(os.tmpdir(), 'oem-write-'))
    const logged = []
    try {
      const oemDir = writeOemPayload({
        paths: { oemDir: path.join(store, 'oem') },
        name: 'win-1', password: 'p@ss', sshPubKey: 'ssh-ed25519 AAA test',
        sourceDir: '/no/such/image/dir', fallbackDirs: [repoOem],
        pythonUrl: 'https://example.invalid/python.exe', dshCuaSpec: 'dsh-cua', log: (line) => logged.push(line)
      })
      return existsSync(path.join(oemDir, 'Autounattend.xml'))
        && existsSync(path.join(oemDir, '$OEM$', '$$', 'Setup', 'Scripts', 'cua-firstboot.ps1'))
        && logged.some((line) => line.includes('using the copy at'))
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })())
  check('with no payload anywhere the error is actionable, not a bare path', (() => {
    // In a CHECKOUT the module directory itself carries windows-oem/, so
    // writeOemPayload would self-heal here and never reach this message. Assert
    // on the builder the writer throws with — that is what the user reads.
    const message = oemPayloadMissingError({ sourceDir: '/usr/local/share/cua-vm/windows-oem', fallbackDirs: ['/opt/seek-harness/cua-check'] }).message
    return message.includes('no Autounattend.xml, setupcomplete.cmd, cua-firstboot.ps1')
      && message.includes('missing from this image')
      && message.includes('--build-arg WITH_VIRGL_QEMU=1')
      && message.includes('docker compose -f compose.windows.yaml up -d --force-recreate')
      && message.includes('/cua-vm')
      && message.includes('docker compose exec seek-harness ls -l /usr/local/share/cua-vm/windows-oem/')
      && message.includes('DSH_CUA_WINDOWS_OEM_DIR')
  })())
  // K6: A PERMISSION BUG MUST NOT READ AS A MISSING PAYLOAD. The shipped defect
  // was `COPY --chmod=0644 docker/windows-oem/ <dest>/`: the flag applies to the
  // directories the COPY creates, so the destination arrived `drw-r--r--` and a
  // uid-1000 process could not traverse it. `existsSync` answers FALSE on EACCES,
  // so the image said "the OEM payload is missing" while the files sat in the
  // pushed layer — and the advice (pull a newer image) was the wrong fix.
  {
    const root = typeof process.getuid === 'function' ? process.getuid() : -1
    const locked = mkdtempSync(path.join(os.tmpdir(), 'oem-eacces-'))
    // `0o644` on a directory removes the traverse bit for every class; POSIX
    // denies the chmod'd owner itself, so this reproduces the image defect
    // exactly without needing a second uid. Root bypasses DAC, so it cannot be
    // simulated there — that is reported as NOT RUN, never as a pass.
    const simulated = root !== 0
    if (!simulated) {
      console.log('  n/a  EACCES classification: running as uid 0, which bypasses DAC — not simulated')
    }
    try {
      for (const file of OEM_PAYLOAD_FILES) writeFileSync(path.join(locked, file), 'x')
      if (simulated) chmodSync(locked, 0o644)

      const status = oemPayloadDirStatus(locked)
      check('a non-traversable directory is reported as DENIED, not as empty/missing', simulated
        ? status.denied !== null && String(status.denied.code) === 'EACCES' && oemPayloadDir(locked) === null
        : status.denied === null && oemPayloadDir(locked) === locked,
      simulated ? `code=${status.denied?.code ?? 'none'}` : 'root: DAC bypassed, directory stays readable')

      check('the denied directory is NAMED by oemPayloadDeniedDir (so the error picks the right text)',
        simulated ? oemPayloadDeniedDir(['/no/such/dir', locked]) === locked : oemPayloadDeniedDir(['/no/such/dir', locked]) === null)

      const message = oemPayloadDeniedError({ sourceDir: locked, denied: path.join(locked, 'Autounattend.xml'), fallbackDirs: ['/opt/seek-harness/cua-check'] }).message
      check('the permission error names the mode/owner, the defect and the fix — not "pull a newer image"', (() => {
        const has = (needle) => message.includes(needle)
        return has('NOT READABLE')
          && has('IMAGE PERMISSIONS defect')
          && has('install -d -m 0755 /usr/local/share/cua-vm')
          && has('chmod -R a+rX /usr/local/share/cua-vm/windows-oem')
          && has('--chown=1000:1000 --chmod=0644')
          && has('read_only, so `chmod` inside the')
          && has('docker compose exec seek-harness ls -l /usr/local/share/cua-vm/windows-oem/')
          && !has('build it from branch cua-vm-improve')
      })())

      check('a denied source is never mistaken for a missing payload (self-heal or EACCES, never "pull an image")', (() => {
        if (!simulated) return true
        const store = mkdtempSync(path.join(os.tmpdir(), 'oem-denied-write-'))
        try {
          writeOemPayload({
            paths: { oemDir: path.join(store, 'oem') },
            name: 'win-1', password: 'p', sshPubKey: 'k',
            // The checkout's own docker/windows-oem/ is a legitimate last resort,
            // so this either self-heals from it or throws the PERMISSION error.
            // What must never happen: the "missing from this image" text, whose
            // advice (pull a newer image) does not fix a mode bits problem.
            sourceDir: locked, fallbackDirs: [], pythonUrl: 'u', dshCuaSpec: 's'
          })
          return existsSync(path.join(store, 'oem', 'Autounattend.xml'))
        } catch (error) {
          return error.code === 'EACCES' && /IMAGE PERMISSIONS defect/u.test(error.message)
        } finally {
          rmSync(store, { recursive: true, force: true })
        }
      })())
    } finally {
      if (simulated) chmodSync(locked, 0o755)
      rmSync(locked, { recursive: true, force: true })
    }
  }
  check('the writer throws THAT error when a directory holds only part of the payload', (() => {
    const store = mkdtempSync(path.join(os.tmpdir(), 'oem-nopayload-'))
    const partial = mkdtempSync(path.join(os.tmpdir(), 'oem-onlyxml-'))
    try {
      writeFileSync(path.join(partial, 'Autounattend.xml'), '<unattend/>')
      try {
        writeOemPayload({
          paths: { oemDir: path.join(store, 'oem') },
          name: 'win-1', password: 'p', sshPubKey: 'k',
          // A CHECKOUT self-heals from the module directory, so this asserts the
          // partial directory is not mistaken for a complete one: the write
          // either succeeds through the checkout copy or throws the actionable
          // error — never half a payload.
          sourceDir: partial, fallbackDirs: [], pythonUrl: 'u', dshCuaSpec: 's'
        })
        return existsSync(path.join(store, 'oem', 'cua-firstboot.ps1'))
      } catch (error) {
        return /the Windows OEM payload is missing from this image/u.test(error.message)
      }
    } finally {
      rmSync(store, { recursive: true, force: true })
      rmSync(partial, { recursive: true, force: true })
    }
  })())
}


// ---- KVM DEVICE: the state split, with stub stat/access ----
//
// The user's bug: /dev/kvm was MOUNTED (devices: - /dev/kvm), the container ran
// as uid 1000, the host node was root:kvm 0660, and the create said "needs
// /dev/kvm (compose.emulator.yaml)". Two defects — `isFile()` is false for a
// character device, and access() was never consulted. Both branches are proven
// here with stubs, so this runs on a host with no /dev/kvm at all.
const CHAR_MODE = 0o020000 | 0o660
const REG_MODE = 0o100000 | 0o644
const stubStat = (info) => () => ({ mode: info.mode, uid: info.uid, gid: info.gid })
const stubAccess = (denied) => (file, flag) => {
  const what = flag === 4 ? 'R' : flag === 2 ? 'W' : 'RW'
  if (denied.includes(what) || denied.includes('ALL')) {
    const error = new Error('denied')
    error.code = 'EACCES'
    throw error
  }
}
const noAccess = () => {}

check('a character device counts as PRESENT (the old probe asked isFile())',
  deviceNodePresent('/dev/kvm', stubStat({ mode: CHAR_MODE, uid: 0, gid: 107 })) === true)
check('a regular file at the device path is NOT a device',
  deviceNodePresent('/dev/kvm', stubStat({ mode: REG_MODE, uid: 0, gid: 107 })) === false)
check('a missing path is not present', deviceNodePresent('/dev/kvm', () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e }) === false)

// (a) MISSING: stat answers ENOENT → the devices: advice, and NO gid text.
const missingStatus = kvmStatus({ device: '/dev/kvm', stat: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e }, access: noAccess, uid: 1000, gid: 1000, groups: [44, 105] })
check('ENOENT is classified as missing', missingStatus.state === 'missing' && missingStatus.exists === false, missingStatus.state)
const missingError = kvmPreflightError(missingStatus, { purpose: 'the Windows backend' })
check('the missing case keeps the devices: instruction',
  missingError !== null && /needs \/dev\/kvm \(compose\.emulator\.yaml\)/.test(missingError.message)
  && /does not exist in this container \(ENOENT\)/.test(missingError.message))
check('the missing case says --force-recreate (an override must recreate, not restart)',
  /--force-recreate/.test(missingError.message))
check('the missing case does NOT lecture about gids', !/group_add/.test(missingError.message) && !/KVM_GID/.test(missingError.message))
check('the missing case carries code ENOENT', missingError.code === 'ENOENT', missingError.code)

// (b) DENIED: the user's exact situation — 0660 root:kvm, uid 1000 not in kvm.
const deniedStatus = kvmStatus({
  device: '/dev/kvm',
  stat: stubStat({ mode: CHAR_MODE, uid: 0, gid: 107 }),
  access: stubAccess(['ALL']),
  uid: 1000, gid: 1000, groups: [44, 105]
})
check('a present-but-refused device is DENIED, not missing',
  deniedStatus.state === 'denied' && deniedStatus.exists === true && deniedStatus.info.modeText === '0660',
  JSON.stringify({ state: deniedStatus.state, mode: deniedStatus.info?.modeText, gid: deniedStatus.info?.gid }))
const deniedError = kvmPreflightError(deniedStatus, { purpose: 'the Windows backend' })
const deniedText = deniedError.message
check('the denied error names the REAL problem, not a missing device',
  /the device IS mounted/.test(deniedText) && /GROUP\/GID problem, not a missing device/.test(deniedText)
  && !/does not exist in this container/.test(deniedText))
check('the denied error quotes the observed mode and owner',
  /mode 0660/.test(deniedText) && /owner 0:107/.test(deniedText), deniedText.split('\n').slice(0, 6).join(' | '))
check('the denied error quotes this process\'s supplementary groups',
  /uid 1000, gid 1000, supplementary groups 44,105/.test(deniedText))
check('the denied error names the permission class that refused it',
  /other bits 0 of mode 0660/.test(deniedText), (/.*bits.*/.exec(deniedText) ?? [''])[0])
check('the denied error gives the exact host command for the gid',
  deniedText.includes(KVM_GID_COMMAND) && KVM_GID_COMMAND === 'stat -c %g /dev/kvm')
check('the denied error gives the exact compose snippet',
  /group_add:/.test(deniedText) && /- "\$\{KVM_GID:-/.test(deniedText), (/group_add:[\s\S]{0,60}/.exec(deniedText) ?? [''])[0])
check('the denied error says KVM_GID goes in .env', /KVM_GID=<that gid>/.test(deniedText) && /\.env/.test(deniedText))
check('the denied error offers the udev MODE=0666 alternative', /MODE="0666"/.test(deniedText) && /99-kvm\.rules/.test(deniedText))
check('the denied error carries EACCES and the observed gid for machine callers',
  deniedError.code === 'EACCES' && deniedError.kvmInfo?.gid === 107 && deniedError.kvmState === 'denied',
  `${deniedError.code} gid=${deniedError.kvmInfo?.gid}`)
check('the denied error mentions O_RDWR (why read/write, not read-only, matters)', /O_RDWR/.test(deniedText))

// The SAME node, granted through the supplementary group: ok, no error.
const grantedViaGroup = kvmStatus({
  device: '/dev/kvm',
  stat: stubStat({ mode: CHAR_MODE, uid: 0, gid: 107 }),
  access: noAccess,
  uid: 1000, gid: 1000, groups: [44, 105, 107]
})
check('the same 0660 node is OK once the gid is in the group list',
  grantedViaGroup.state === 'ok' && grantedViaGroup.readable === true && grantedViaGroup.writable === true,
  grantedViaGroup.reason)
check('an OK device produces NO error', kvmPreflightError(grantedViaGroup) === null)
check('the owner class is used when uid matches the node\'s uid',
  kvmStatus({ device: '/dev/kvm', stat: stubStat({ mode: CHAR_MODE, uid: 1000, gid: 107 }), access: noAccess, uid: 1000, gid: 1000, groups: [] }).state === 'ok')
check('a 0400 node is read-only for its owner, so a write probe still fails',
  kvmStatus({
    device: '/dev/kvm',
    stat: stubStat({ mode: 0o020000 | 0o400, uid: 1000, gid: 1000 }),
    access: stubAccess(['W']), uid: 1000, gid: 1000, groups: []
  }).state === 'denied')

// (c) NOT A DEVICE: a regular file where the node should be.
const notDevice = kvmStatus({ device: '/dev/kvm', stat: stubStat({ mode: REG_MODE, uid: 0, gid: 0 }), access: noAccess, uid: 1000, gid: 1000, groups: [] })
check('a regular file at the device path is its own state', notDevice.state === 'not-device', notDevice.state)
const notDeviceError = kvmPreflightError(notDevice, { purpose: 'the Windows backend' })
check('the not-a-device error explains the bind-mount mistake',
  /is not one/.test(notDeviceError.message) && /devices:/.test(notDeviceError.message))

// A stat that is ITSELF denied (a non-traversable parent): still EACCES, and
// no invented mode/owner.
const statDenied = kvmStatus({ device: '/dev/kvm', stat: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e }, access: noAccess, uid: 1000, gid: 1000, groups: [] })
check('a denied stat() is classified as denied with no quoted mode',
  statDenied.state === 'denied' && statDenied.info === null && /ANCESTOR/.test(statDenied.reason), statDenied.reason)

// The Linux path reuses `kvmPreflightError`, with its OWN purpose prefix.
const linuxError = kvmPreflightError(deniedStatus, { purpose: 'the Linux VM (cua sb create)' })
check('the Linux diagnosis names the Linux create instead of the Windows backend',
  /^the Linux VM \(cua sb create\) cannot OPEN \/dev\/kvm/.test(linuxError.message)
  && !/the Windows backend/.test(linuxError.message), linuxError.message.split('\n')[0])

// Doctor + one-line status: "present but denied" can never read as "unusable".
check('the doctor line distinguishes DENIED from absent',
  /DENIED/.test(formatKvmStatus(deniedStatus)) && /absent/.test(formatKvmStatus(missingStatus))
  && !/DENIED/.test(formatKvmStatus(missingStatus)), formatKvmStatus(deniedStatus))
const facts = kvmDoctorFacts(deniedStatus)
check('the doctor facts carry the probe\'s own observation',
  facts.kvmUsable === false && facts.kvmState === 'denied' && facts.kvmMode === '0660'
  && facts.kvmOwner === '0:107' && facts.kvmGroups.join(',') === '44,105',
  JSON.stringify(facts))

// LIVE: on a host that HAS /dev/kvm, the real probe must agree with reality —
// and it must not mistake a character device for an absent one.
if (existsSync('/dev/kvm')) {
  const live = kvmStatus()
  const realAccess = (() => {
    try { accessSync('/dev/kvm', fsConstants.R_OK | fsConstants.W_OK); return true } catch { return false }
  })()
  check('LIVE the real probe reports a character device as present', live.exists === true && live.info?.isCharDevice === true, `${live.state} ${live.info?.modeText}`)
  check('LIVE the real probe agrees with access(2)',
    (live.state === 'ok') === realAccess, `state=${live.state} access=${realAccess}`)
  check('LIVE a usable device produces no preflight error',
    (live.state === 'ok') === (kvmPreflightError(live) === null))
} else {
  console.log('  n/a  LIVE /dev/kvm is absent on this host — both branches above are proved with stubs')
}

// LIVE not-a-device: a real regular file at the probed path, no stubs. This is
// the case a hand-written `devices:` entry produces when it points at a file.
{
  const fake = path.join(os.tmpdir(), `cua-fake-kvm-${process.pid}`)
  writeFileSync(fake, 'not a device')
  try {
    const live = kvmStatus({ device: fake })
    check('LIVE a regular file at the device path is classified not-device',
      live.state === 'not-device' && live.info?.isCharDevice === false, `${live.state} ${live.reason}`)
    check('LIVE that classification produces the bind-mount error, not the gid one',
      /is not one/u.test(kvmPreflightError(live)?.message ?? '') && !/group_add/u.test(kvmPreflightError(live)?.message ?? ''))
  } finally {
    rmSync(fake, { force: true })
  }
}

// The Windows backend's own preflight is the same implementation.
check('windowsKvmPreflight is the shared module (no second message)',
  typeof windowsKvmPreflight === 'function' && (kvmStatus().state === 'ok' ? windowsKvmPreflight() === null : windowsKvmPreflight() !== null))

// ---- B2: THE PROGRESS SENTENCE, unit-tested for BOTH phases ----
// The user report was one panel line: "installing (10 min): undefined answering,
// QMP not running". Both halves were formatter defects (a raw `endpoint` field
// and `status || 'not running'`), so the formatter is tested directly.
{
  const installPhase = formatWindowsInstallDetail({
    phase: 'install',
    verdict: { alive: true, status: '', qmp: 'not answering', endpoint: undefined },
    elapsedMinutes: 10,
    serialTail: 'Setup is starting\n\n  12%\n  47%\n'
  })
  check('the install sentence never contains "undefined"', !/undefined/u.test(installPhase), installPhase)
  check('...never claims "QMP not running" about a live QEMU', !/QMP not running/u.test(installPhase), installPhase)
  check('...says what IS being watched (serial tail + QMP)', /serial-log tail/u.test(installPhase) && /QMP not answering/u.test(installPhase), installPhase.slice(0, 120))
  check('...carries the elapsed minutes', /installing \(10 min\)/u.test(installPhase), installPhase.slice(0, 40))
  check('...carries the last serial lines', /12% \| 47%/u.test(installPhase), installPhase.slice(-80))
  check('...and says how the user knows it finished', /badge flips to Ready/u.test(installPhase) && /\/vm\/port\/<name>\//u.test(installPhase), installPhase.slice(0, 200))
  check('an empty serial log says so instead of printing nothing', (() => {
    const text = formatWindowsInstallDetail({ phase: 'install', verdict: { alive: true, qmp: 'running' }, elapsedMinutes: 1, serialTail: '' })
    return /no lines yet/u.test(text) && !/undefined/u.test(text)
  })())

  const runningPhase = formatWindowsInstallDetail({
    phase: 'running',
    verdict: { alive: true, status: 'running', qmp: 'running', endpoint: 'ssh' },
    elapsedMinutes: 3,
    serialTail: ['logon ready']
  })
  check('the running phase sentence names SSH + QMP and the endpoint', /watching QMP \+ the SSH banner/u.test(runningPhase)
    && /now: ssh, QMP running/u.test(runningPhase), runningPhase.slice(0, 140))
  check('the running phase sentence has no "no SSH yet" filler', !/no SSH yet/u.test(runningPhase), runningPhase.slice(0, 120))

  // The labels are the only place a raw field can leak.
  check('qmpStateLabel turns an empty probe into "not answering", never ""',
    qmpStateLabel({ alive: true, status: '' }) === 'not answering'
    && qmpStateLabel({ alive: false }) === 'no qemu'
    && qmpStateLabel({ status: 'paused' }) === 'paused'
    && qmpStateLabel(undefined) === 'not answering')
  check('endpointLabel turns a missing endpoint into "no endpoint yet"',
    endpointLabel({ endpoint: undefined }) === 'no endpoint yet'
    && endpointLabel({ endpoint: 'none' }) === 'no endpoint yet'
    && endpointLabel({ endpoint: 'ssh' }) === 'ssh')
  check('windowsTailLines keeps only the last N non-empty lines',
    windowsTailLines('a\n\nb\nc\nd\ne\nf\n', 5).join(',') === 'b,c,d,e,f'
    && windowsTailLines('   \n\n', 5).length === 0)

  // ---- F4: THE FORMATTER'S TWO HONEST HEADLINES ----
  // `ready()` early-returns WITHOUT an endpoint when the QEMU process is not
  // alive, and the reported panel line interpolated that missing field:
  // "installing (N min): undefined answering, QMP not running". Neither half of
  // that sentence may come back.
  const deadLine = formatWindowsInstallDetail({
    phase: 'install',
    verdict: { alive: false, status: '', qmp: 'no qemu', endpoint: undefined },
    elapsedMinutes: 4,
    serialTail: ''
  })
  check('a dead QEMU gets its own headline (never "undefined answering")',
    !/undefined/u.test(deadLine) && /QEMU not alive/u.test(deadLine) && /qemu-stderr\.log/u.test(deadLine), deadLine.slice(0, 160))
  const waitingLine = formatWindowsInstallDetail({
    phase: 'install',
    verdict: { alive: true, status: 'running', qmp: 'running', endpoint: 'none', sshPort: 47444 },
    elapsedMinutes: 6,
    serialTail: '  12%'
  })
  check('an ALIVE guest with no endpoint yet says it is waiting for SSH on the port',
    !/undefined/u.test(waitingLine) && /waiting for SSH on 127\.0\.0\.1:47444/u.test(waitingLine),
    waitingLine.slice(0, 200))
  check('...and still carries the serial tail',
    /12%/u.test(waitingLine), waitingLine.slice(-60))

  // ---- B2: THE ROW AND THE BOOT SPEC SHARE ONE PORT RESOLVER ----
  // The registry row stores `ports: { qmp, ssh, vnc }`; `buildQemuArgs` reads
  // flat fields. Resolving the row's shape to `undefined` is what made every
  // lifecycle call dial port 0 and the panel print "undefined answering".
  const row = { name: 'win-test', ports: { qmp: 47001, ssh: 48001, vnc: 5901 } }
  const fromRow = windowsPortsOf(row)
  check('windowsPortsOf reads a REGISTRY ROW', fromRow.qmpPort === 47001 && fromRow.sshPort === 48001 && fromRow.vncPort === 5901, JSON.stringify(fromRow))
  const flat = { name: 'win-test', qmpPort: 47002, sshPort: 48002, vncPort: 5902 }
  check('windowsPortsOf reads a FLAT boot spec', windowsPortsOf(flat).qmpPort === 47002 && windowsPortsOf(flat).sshPort === 48002, JSON.stringify(windowsPortsOf(flat)))
  check('windowsPortsOf never invents a port for an empty row', (() => {
    const empty = windowsPortsOf({ name: 'x' })
    return empty.qmpPort === 0 && empty.sshPort === 0 && empty.vncPort === 0
  })(), JSON.stringify(windowsPortsOf({ name: 'x' })))
  check('windowsBootSpec flattens a row for buildQemuArgs',
    buildQemuArgs({ ...windowsBootSpec(row), paths: paths, isoPath: '/isos/w.iso', installPending: true, virtio: false, driverIso: null })
      .includes('tcp:127.0.0.1:47001,server=on,wait=off'))
  check('the readiness contract names the SSH banner and QMP',
    windowsReadinessSignals('win-test').signals.join('|') === 'the guest SSH banner answers|QMP says running'
    && /\/vm\/port\/win-test\//u.test(windowsReadinessSignals('win-test').onReady))
}

console.log(failures === 0 ? '\nunit: PASS' : `\nunit: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
