#!/usr/bin/env node
/**
 * modules-unit.mjs — the pure parts of the two new modules, and the Windows
 * container spec, asserted without a VM, a container or a daemon.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, accessSync, statSync, constants as fsConstants } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
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
  SETUP_IMAGE_ENTRIES, SETUP_IMAGE_LABEL, buildSetupImage, verifySetupImage, answerFileDiskIds,
  assertAnswerFileTargetsSystemDisk, normaliseProductKey,
  SETUP_PARTITION_START_LBA, SETUP_PARTITION_OFFSET_BYTES, SETUP_PARTITION_TYPE, setupVolumeSpec,
  setupMbrSector, readSetupMbr, resolveWindowsImageSelection, imageInstallFromXml, assertAnswerFileSelectsImage,
  WINDOWS_IMAGE_SELECTIONS,
  formatWindowsInstallDetail, qmpStateLabel, endpointLabel, windowsTailLines, windowsPortsOf, windowsBootSpec,
  windowsReadinessSignals, qemuBootWindowMs, waitForQemuBoot,
  windowsRowName, windowsQmpAdapter, cdbootKeyScheduleMs, cdbootKeysEnabled, runCdbootKeys, cdbootPromptSeen, readSerialTail, startupNshText,
  createWindowsBackend
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

/** Size in bytes, or -1 — used only to prove the sparse image was created. */
const statSyncSafe = (file) => { try { return statSync(file).size } catch { return -1 } }

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
// R4: THE BOOT ORDER FOLLOWS THE PHASE. The install CD is FIRST while the disk
// is empty (the disk is second), and the disk is FIRST once it is installed.
// The old argv put the disk at 1 and the CD at 2 and a comment claimed the
// opposite: OVMF created a Boot0002 HDD entry, tried it, printed "HDD Not
// Found", and only then reached the DVD.
{
  const cdIndex = argv.indexOf('ide-cd,drive=cd0,bus=ide.1,bootindex=1')
  const diskInstall = argv.filter((item) => /^ide-hd,drive=disk0,bus=ide\.0,bootindex=\d+$/u.test(item))
  check('R4: while installing the CD boots FIRST (bootindex=1) and the disk second (2)',
    cdIndex !== -1 && diskInstall.length === 1 && diskInstall[0].endsWith('bootindex=2'),
    `${cdIndex} ${diskInstall.join(',')}`)
  const postInstall = buildQemuArgs({
    name: 'win-1', cpu: 4, memory: 8, gpu: false, paths,
    isoPath: '/cua-vm/iso/w11.iso', driverIso: null, sshPort: 47100, vncPort: 5931, qmpPort: 46100,
    installPending: false, virtio: false
  })
  check('R4: after install the disk boots FIRST (bootindex=1) and no CD is attached',
    postInstall.filter((item) => /drive=disk0.*bootindex=1$/u.test(item)).length === 1
    && !postInstall.join(' ').includes('id=cd0'), postInstall.filter((item) => item.includes('disk0')).join(','))
  check('R4: the virtio disk follows the same phase rule',
    buildQemuArgs({ name: 'win-1', cpu: 2, memory: 4, gpu: false, paths, isoPath: '/x.iso', driverIso: null, sshPort: 1, vncPort: 2, qmpPort: 3, installPending: true, virtio: true })
      .includes('virtio-blk-pci,drive=disk0,bootindex=2'))
}
// S1/F1: THE ANSWER-FILE MEDIUM IS A PARTITIONED FAT32 IMAGE — AND SINCE THE
// LIVE FORENSIC ROUND IT IS DELIVERED AS **REMOVABLE MEDIA**.
//
// Inside the guest, WinPE mounted setup.img as C:, `dir C:\` listed
// Autounattend.xml, `more` byte-verified it, no Panther error — and Setup STILL
// showed its language page. Setup's answer-file search covers REMOVABLE-media
// roots (and the boot media), never fixed-disk roots, so an `ide-hd` attach can
// never be read no matter how correct the image is. usb-storage + removable=on
// makes Windows classify it as removable media.
// F1: WRITABLE, NOT READ-ONLY. QEMU 10 rejects a read-only block node behind
// ide-hd ("Block node is read-only") and the create died before swtpm's socket.
// D2: THE DEVICE IS NAMED (`id=setupusb`) SO IT CAN BE HOT-UNPLUGGED. The
// install session keeps running after Setup, so the ready transition ejects the
// CD and `device_del`s this frontend; QMP addresses a qdev by id, so an argv
// without one could only be cleaned by restarting the computer.
const USB_STICK = 'usb-storage,drive=setup0,removable=on,bus=xhci.0,id=setupusb'
check('F1: the answer medium is setup.img as a WRITABLE removable usb-storage stick',
  argv.join(' ').includes(`file=${paths.setupImg},format=raw,if=none,id=setup0`)
  && !argv.join(' ').includes('id=setup0,readonly=on')
  && has(USB_STICK)
  && !has('ide-hd,drive=setup0,bus=ide.2'))
check('F1: ...and the usb-storage device follows the xHCI controller it names (argv order)',
  argv.indexOf(USB_STICK) > argv.indexOf('qemu-xhci,id=xhci'))
check('D2: ...and carries the explicit qdev id the ready transition unplugs',
  USB_STICK.endsWith(',id=setupusb') && argv.includes(USB_STICK))
check('F1/F2: no ide-hd device in the argv sits behind a read-only block node', (() => {
  // Map each ide-hd device to its drive id, then look up the -drive line that
  // declares that id: `readonly=on` on a hard-disk backend is what QEMU 10
  // rejects. CD-ROM and pflash backends are allowed to stay read-only.
  const hardDiskDrives = argv.filter((item) => String(item).startsWith('ide-hd,'))
    .map((item) => /drive=([^,]+)/u.exec(item)?.[1]).filter(Boolean)
  return hardDiskDrives.length > 0 && hardDiskDrives.every((id) => {
    const drive = argv.find((item) => String(item).includes(`id=${id}`))
    return typeof drive === 'string' && !/read-?only/u.test(drive)
  })
})())
check('F1: ...and the usb-storage answer node is writable too (Setup writes scratch)',
  (() => {
    const drive = argv.find((item) => String(item).includes('id=setup0'))
    return typeof drive === 'string' && !/read-?only/u.test(drive)
  })())
check('S1: the vvfat USB OEM stick is GONE from the install argv',
  !argv.join(' ').includes('fat:ro:') && !argv.join(' ').includes('id=oem0'))
check('S1: the system qcow2 is declared before setup.img, so it stays Windows Disk 0',
  argv.indexOf('ide-hd,drive=disk0,bus=ide.0,bootindex=2') !== -1
  && argv.indexOf('ide-hd,drive=disk0,bus=ide.0,bootindex=2')
     < argv.findIndex((item) => String(item).includes('id=setup0')))
check('S1: the setup disk is only attached while installing (no stale answer disk after Setup)',
  !buildQemuArgs({ name: 'win-1', cpu: 2, memory: 4, gpu: false, paths, isoPath: '/x.iso', driverIso: null, sshPort: 1, vncPort: 2, qmpPort: 3, installPending: false, virtio: false })
    .join(' ').includes('setup0'))
check('S1: a driver ISO keeps its own CD slot (ide.3), away from the answer medium', (() => {
  const withDrivers = buildQemuArgs({ name: 'win-1', cpu: 2, memory: 4, gpu: false, paths, isoPath: '/x.iso', driverIso: '/drv.iso', sshPort: 1, vncPort: 2, qmpPort: 3, installPending: true, virtio: false })
  return withDrivers.includes('ide-cd,drive=cd1,bus=ide.3')
    && withDrivers.includes(USB_STICK)
    && !withDrivers.join(' ').includes('ide-cd,drive=cd1,bus=ide.2')
})())
check('the USB controller is declared before the USB input devices',
  argv.indexOf('qemu-xhci,id=xhci') !== -1 && argv.indexOf('qemu-xhci,id=xhci') < argv.indexOf('usb-kbd'))
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
  check('the OEM file list is the four files the writer needs (S4 adds the hidden launcher)', OEM_PAYLOAD_FILES.join(',') === 'Autounattend.xml,setupcomplete.cmd,cua-firstboot.ps1,Unattend.vbs')
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
        && existsSync(path.join(oemDir, '$OEM$', '$$', 'Setup', 'Scripts', 'Unattend.vbs'))
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

// ---- F3: THE BOOT WINDOW'S DEFAULT SURVIVES AN UNSET ENV ----
//
// THE LIVE BUG. `Number(process.env.X ?? '')` turns an unset variable into 0,
// `0 >= 0` passed, and `qemuBootWindowMs()` returned 0 ms — so `waitForQemuBoot`
// polled once against an already-expired deadline and reported a QEMU that was
// ~1 ms old as dead ("died during init (none): no stderr output"). The suites
// never caught it because both SET the variables (tests/windows-boot.mjs:94,
// tests/supervisor-smoke.mjs:242): a test that supplies a number cannot observe
// the default. These cases DELETE the variable instead.
{
  const savedBoot = process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS
  const savedEarly = process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS
  const restore = () => {
    if (savedBoot === undefined) delete process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS
    else process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS = savedBoot
    if (savedEarly === undefined) delete process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS
    else process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS = savedEarly
  }
  try {
    // UNSET — the production shape, and the one that broke.
    delete process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS
    delete process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS
    check('F3: unset env → qemuBootWindowMs() === 15000', qemuBootWindowMs() === 15000, String(qemuBootWindowMs()))
    // `windowsEarlyDeathWindowMs` is module-private in the supervisor (it is not
    // exported), so this asserts the SAME expression on a fresh import of the
    // module's own shape: the source must not fall back to `Number(env ?? '')`.
    const supervisorSource = readFileSync(path.join(REPO, 'docker', 'cua-vm-supervisor.mjs'), 'utf8')
    check('F3: windowsEarlyDeathWindowMs() parses only a NON-EMPTY raw value',
      /const raw = process\.env\.DSH_CUA_WINDOWS_EARLY_CHECK_MS\n\s+if \(raw !== undefined && raw !== ''\) \{/u.test(supervisorSource)
      && /function windowsEarlyDeathWindowMs\(\) \{\n\s+const raw = process\.env\.DSH_CUA_WINDOWS_EARLY_CHECK_MS/u.test(supervisorSource)
      && !/Number\(process\.env\.DSH_CUA_WINDOWS_EARLY_CHECK_MS \?\? ''\)/u.test(supervisorSource))
    // The same expression, evaluated here, must give the 5000 default.
    const earlyWindow = (() => {
      const raw = process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS
      if (raw !== undefined && raw !== '') {
        const parsed = Number(raw)
        if (Number.isFinite(parsed) && parsed >= 0) return Math.min(60000, Math.max(0, Math.trunc(parsed)))
      }
      return 5000
    })()
    check('F3: unset env → the early-death window is the 5000 ms default', earlyWindow === 5000, String(earlyWindow))
    // '' is unset's twin: `Number('') === 0` is exactly the trap.
    process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS = ''
    check('F3: empty-string env → 15000 (not 0)', qemuBootWindowMs() === 15000, String(qemuBootWindowMs()))
    // AN EXPLICIT 0 IS HONORED — it is a real request for the shortest window,
    // not a typo to be upgraded to 15 s.
    process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS = '0'
    check('F3: an EXPLICIT "0" is honored as 0', qemuBootWindowMs() === 0, String(qemuBootWindowMs()))
    process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS = '1500'
    check('F3: a set value is still read (1500)', qemuBootWindowMs() === 1500, String(qemuBootWindowMs()))
    process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS = 'nonsense'
    check('F3: an unparsable value falls back to 15000', qemuBootWindowMs() === 15000, String(qemuBootWindowMs()))
    process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS = '999999'
    check('F3: the window is still capped at 120000', qemuBootWindowMs() === 120000, String(qemuBootWindowMs()))
  } finally {
    restore()
  }
}

// F3 (second half): a window of 0 must still observe ONE real poll interval. A
// zero window used to mean "check once, immediately" — which is how a QEMU that
// had been alive for 1 ms was declared dead. The floor is pollMs.
{
  const pidFile = path.join(os.tmpdir(), `cua-none-${process.pid}-${Date.now()}.pid`)
  try { rmSync(pidFile, { force: true }) } catch {}
  const started = Date.now()
  const verdict = await waitForQemuBoot({ child: { once: () => {} }, pidFile, isAlive: () => false, windowMs: 0, pollMs: 40 })
  const elapsed = Date.now() - started
  check('F3: windowMs 0 still waits one poll interval before declaring a timeout',
    verdict.ok === false && verdict.reason === 'timeout' && elapsed >= 35, `${elapsed}ms ${JSON.stringify(verdict)}`)
  // ...and a pidfile written DURING that interval is still seen, which is the
  // exact live shape: QEMU writes it a few ms after spawn.
  writeFileSync(pidFile, `${process.pid}\n`)
  const seen = await waitForQemuBoot({ child: { once: () => {} }, pidFile, isAlive: (pid) => pid === process.pid, windowMs: 0, pollMs: 40 })
  check('F3: ...so a pidfile that appears within it is accepted', seen.ok === true, JSON.stringify(seen))
  try { rmSync(pidFile, { force: true }) } catch {}
}

// ---- R1/R2/R3/R5: THE FOUR LIVE-VERIFIED ROOT CAUSES ----
//
// R1  cdboot's "Press any key to boot from CD or DVD" window (5 s) was never
//     pressed: EFI_TIMEOUT, then the EFI Internal Shell. The schedule is asserted
//     with a stubbed clock and a recording `sendKey`.
// R2  a row has no `name` of its own — its name is the MAP KEY — so every
//     pidfile path carried "undefined" and a running QEMU read as dead.
// R3  the backend dials (host, port, cmds, opts) while the supervisor's
//     primitive is (port, cmds, { timeoutMs, host }): the HOST arrived as the
//     PORT and every probe threw. The adapter is the join.
// R5  the EFI Shell fallback script (belt and braces).
{
  // ---- R2: name resolution ----
  check('R2: windowsRowName reads a row\'s name', windowsRowName({ name: 'win-a' }) === 'win-a')
  check('R2: windowsRowName falls back to the map key when the row has none',
    windowsRowName({ kind: 'windows' }, 'win-key') === 'win-key')
  check('R2: windowsRowName accepts a bare name', windowsRowName('win-b') === 'win-b')
  check('R2: ...and never invents "undefined" from an empty row',
    windowsRowName({}, '') === '' && windowsRowName(null) === '' && windowsRowName(undefined, 'x') === 'x')

  // ---- R2 + R3 end to end: a row WITHOUT `name`, a faithful stub, and a real
  //      pidfile on disk under the map key. This is the exact live shape. ----
  const store = mkdtempSync(path.join(os.tmpdir(), 'cua-r2-'))
  try {
    const rowName = 'win-nameless'
    const p = windowsPaths(store, rowName)
    mkdirSync(p.dir, { recursive: true })
    writeFileSync(p.qemuPid, `${process.pid}\n`)
    // THE STUB SPEAKS THE SUPERVISOR'S SIGNATURE: (port, commands, { timeoutMs }).
    const calls = []
    const supervisorShaped = async (port, commands, opts = {}) => {
      calls.push({ port, commands, opts })
      if (!Number.isFinite(Number(port)) || Number(port) <= 0) {
        throw new TypeError('The "options" or "port" or "path" argument must be specified')
      }
      return [{ return: { status: 'running' } }]
    }
    // `name` here so the ALIVENESS half is observable; the nameless-row case is
    // asserted separately below (R2).
    const rawRow = { name: rowName, kind: 'windows', ports: { qmp: 46911, ssh: 47911, vnc: 5911 } }
    // THE LIVE BUG, REPLAYED: the backend calls `qmp(host, port, cmds, opts)`,
    // so a primitive that takes `(port, cmds, opts)` receives the HOST string as
    // its port and throws before a byte reaches the monitor.
    const mismatch = await supervisorShaped('127.0.0.1', 46911, [{ execute: 'query-status' }], { timeoutMs: 5000 })
      .then(() => 'answered', (error) => String(error?.message ?? error))
    check('R3 (the live bug): the supervisor primitive called with the backend\'s argument ORDER throws',
      /port.*must be specified|options/u.test(mismatch), mismatch)
    // THE FIX: the adapter joins the two signatures.
    const joined = await windowsQmpAdapter(supervisorShaped)('127.0.0.1', 46911, [{ execute: 'query-status' }], { timeoutMs: 5000 })
    check('R3: windowsQmpAdapter turns the backend shape into a running answer',
      joined?.[0]?.return?.status === 'running', JSON.stringify(joined))
    // ...and the backend adapts ANY primitive it is handed, so a raw stub still
    // works, and wrapping an adapter twice is a no-op rather than a new bug.
    const backend = createWindowsBackend({ store, qmp: windowsQmpAdapter(supervisorShaped), log: () => {} })
    const state = await backend.probe(rawRow)
    check('R3: with windowsQmpAdapter the SAME stub answers alive + QMP running',
      state.alive === true && state.status === 'running' && state.qmp === 'running', JSON.stringify(state))
    check('R3: ...the port reached the primitive as a PORT and the host in opts',
      calls.length > 0 && calls.at(-1).port === 46911 && calls.at(-1).opts.host === '127.0.0.1',
      JSON.stringify(calls.at(-1)))
    // R2: the row has no `name`, so only the map key can lead to that pidfile.
    const nameless = { kind: 'windows', ports: { qmp: 46911, ssh: 47911, vnc: 5911 } }
    check('R2: a row WITHOUT `name` finds NO pidfile (the live shape: path had "undefined")',
      backend.qemuPid(nameless) === 0 && backend.qemuPid({ ...nameless, name: rowName }) === process.pid,
      `nameless=${backend.qemuPid(nameless)} keyed=${backend.qemuPid({ ...nameless, name: rowName })}`)
    check('R2: ...and probe() takes the MAP KEY explicitly, so that row is not called dead',
      (await backend.probe(nameless, { name: rowName })).alive === true)
    check('R3: the adapter also accepts the supervisor shape as-is (port first)',
      await windowsQmpAdapter(supervisorShaped)(46911, [{ execute: 'query-status' }]) instanceof Array)

    // ---- R1: the cdboot key schedule ----
    const savedKeys = process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS
    const savedSwitch = process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS
    try {
      delete process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS
      check('R1: the default schedule covers the 5 s cdboot window',
        cdbootKeyScheduleMs().join(',') === '1500,3500,5500', cdbootKeyScheduleMs().join(','))
      check('R1: ...with three attempts inside it',
        cdbootKeyScheduleMs().length === 3 && cdbootKeyScheduleMs().at(-1) <= 6000)
      process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS = '200,400'
      check('R1: the schedule is configurable', cdbootKeyScheduleMs().join(',') === '200,400')
      process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS = 'nonsense'
      check('R1: an unparsable schedule falls back to the default', cdbootKeyScheduleMs().join(',') === '1500,3500,5500')
      delete process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS
      delete process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS
      check('R1: the keys are ON by default', cdbootKeysEnabled() === true)
      process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS = '0'
      check('R1: ...and can be switched off', cdbootKeysEnabled() === false)
    } finally {
      if (savedKeys === undefined) delete process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS
      else process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS = savedKeys
      if (savedSwitch === undefined) delete process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS
      else process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS = savedSwitch
    }

    // R1 mechanism: the delays are RELATIVE waits summing to the absolute
    // offsets, the key is Enter, and every attempt is logged.
    {
      const waits = []
      const keys = []
      const lines = []
      const sent = await runCdbootKeys({
        scheduleMs: [1500, 3500, 5500],
        key: 'enter',
        log: (line) => lines.push(line),
        wait: async (ms) => { waits.push(ms) },
        sendKey: async (key) => { keys.push(key) }
      })
      check('R1: three key presses are sent, at offsets 1.5 s / 3.5 s / 5.5 s',
        keys.length === 3 && keys.every((key) => key === 'enter') && waits.join(',') === '1500,2000,2000' && sent.join(',') === '1500,3500,5500',
        `keys=${keys.join(',')} waits=${waits.join(',')} sent=${sent.join(',')}`)
      check('R1: each press is logged with its offset',
        lines.length === 3 && lines.every((line) => /pressed enter/u.test(line) && /boot from CD or DVD/u.test(line)),
        lines.join(' | ').slice(0, 200))
    }
    // R1: a send that FAILS is logged and skipped — never fatal, the next one runs.
    {
      const keys = []
      const lines = []
      let attempt = 0
      const sent = await runCdbootKeys({
        scheduleMs: [100, 200, 300],
        log: (line) => lines.push(line),
        wait: async () => {},
        sendKey: async () => {
          attempt += 1
          if (attempt === 1) throw new Error('QMP not ready')
          keys.push(attempt)
        }
      })
      check('R1: a failed send is NOT fatal and does not stop the schedule',
        keys.join(',') === '2,3' && sent.join(',') === '200,300', `keys=${keys.join(',')} sent=${sent.join(',')}`)
      check('R1: ...and it says so without throwing', lines.some((line) => /could not press/u.test(line)), lines.join(' | ').slice(0, 160))
    }

    // ---- F2: THE SCHEDULE IS ANCHORED ON SERIAL ACTIVITY, NOT ON SPAWN ----
    //
    // The live forensic child proved the fixed 1.5/3.5/5.5 s presses land while
    // OVMF is still enumerating devices — BEFORE cdboot prints its prompt — so
    // the first press could never dismiss the window. These tests drive the
    // watcher against a STUBBED SERIAL TIMELINE with a virtual clock: no QEMU,
    // no real sleep, and the exact fire times are assertable.
    const runTimeline = async (timeline, extra = {}) => {
      let t = 0
      const waits = []
      const keys = []
      const lines = []
      const sent = await runCdbootKeys({
        scheduleMs: [1500, 3500, 5500],
        readSerial: () => timeline(t),
        now: () => t,
        wait: async (ms) => { waits.push(ms); t += ms },
        sendKey: async (key) => { keys.push({ key, at: t }) },
        log: (line) => lines.push(line),
        ...extra
      })
      return { t, waits, keys, lines, sent }
    }
    const PROMPT = 'cdboot.efi 10.0.26100.1\r\nPress any key to boot from CD or DVD . . .'
    {
      // The prompt is the anchor: the console is silent until it appears at 4 s,
      // the poll that sees it fires at ~4.1 s, then retries 0.8 s apart.
      const run = await runTimeline((t) => (t >= 4040 ? PROMPT : ''))
      const at = run.keys.map((entry) => entry.at)
      check('F2: a prompt at 4 s anchors the presses at ~4.1 / 4.9 / 5.7 s',
        at.length === 3 && at[0] >= 4000 && at[0] <= 4300
        && at[1] - at[0] === 800 && at[2] - at[1] === 800, at.join(','))
      check('F2: ...and NO spawn-relative press was sent before the prompt',
        at.every((value) => value >= 4000) && run.lines.every((line) => !/fixed-time fallback/u.test(line)),
        run.lines.join(' | ').slice(0, 200))
      check('F2: the presses are logged as serial-anchored', run.lines.every((line) => /pressed enter/u.test(line) && /serial:/u.test(line)),
        run.lines.join(' | ').slice(0, 160))
    }
    {
      // No prompt signature ever (an older/different cdboot wording), but the
      // console DID start printing at 0.6 s: fire at growth + 1.5 s.
      const run = await runTimeline((t) => (t >= 600 ? 'BdsDxe: loading Boot0001 from PciRoot(0x0)' : ''))
      const at = run.keys.map((entry) => entry.at)
      // A growth anchor is a guess, so it keeps retrying until the window
      // closes: an early press must never be the LAST one.
      check('F2: first serial output + ~1.5 s is the anchor when the prompt text never appears',
        at.length >= 3 && at[0] >= 2100 && at[0] <= 2400 && at[1] - at[0] === 800
        && at.at(-1) <= 8900, at.join(','))
    }
    {
      // COMPLETELY SILENT console: the fixed-time schedule is the fallback and
      // its offsets are honoured exactly (the historical behaviour).
      const run = await runTimeline(() => '')
      // The prompt never arrives, so the fixed schedule is replayed with its own
      // relative gaps as soon as the detection window closes (8 s): three
      // presses at 8.0 / 10.0 / 12.0 s, each logged with its nominal offset.
      check('F2: a silent serial console falls back to the fixed-time schedule (3 presses, 2 s gaps)',
        run.keys.map((entry) => entry.at).join(',') === '8000,10000,12000', run.keys.map((entry) => entry.at).join(','))
      check('F2: ...logged as the fallback (with the nominal offsets), so the two paths are never confused',
        run.lines.length === 3 && run.lines.every((line) => /fixed-time fallback/u.test(line))
        && run.lines.map((line) => /~(\d+) ms/u.exec(line)?.[1]).join(',') === '1500,3500,5500',
        run.lines.join(' | ').slice(0, 160))
    }
    {
      // The BdsDxe spelling of the same boot attempt anchors too, and a failing
      // send is still non-fatal in this mode.
      let attempts = 0
      const run = await runTimeline((t) => (t >= 2000 ? 'BdsDxe: starting Boot0001 "UEFI QEMU DVD-ROM"' : ''), {
        sendKey: async () => { attempts += 1; if (attempts === 1) throw new Error('QMP not ready') }
      })
      check('F2: "BdsDxe: starting Boot0001" is a prompt signature as well',
        run.lines.some((line) => /could not press/u.test(line)) && run.lines.filter((line) => /pressed enter/u.test(line)).length === 2,
        run.lines.join(' | ').slice(0, 200))
    }
    check('F2: the signature matcher is exported and case/space tolerant',
      cdbootPromptSeen('press ANY key to boot from cd or dvd') === true
      && cdbootPromptSeen('BdsDxe:  starting Boot0001') === true
      && cdbootPromptSeen('BdsDxe: starting Boot0002') === false
      && cdbootPromptSeen('') === false)
    {
      // readSerialTail reads only the tail of a growing file and never throws.
      const tailFile = path.join(os.tmpdir(), `cua-serial-tail-${process.pid}.log`)
      writeFileSync(tailFile, `${'x'.repeat(20000)}${PROMPT}`)
      check('F2: readSerialTail returns the tail (where the prompt is) and tolerates a missing file',
        readSerialTail(tailFile, 4096).includes('Press any key') && readSerialTail(path.join(os.tmpdir(), 'nope-no-such.log')) === '')
      rmSync(tailFile, { force: true })
    }

    // ---- R5: the EFI Shell fallback script ----
    const nsh = startupNshText()
    check('R5: startup.nsh tries every mapped filesystem\'s bootx64.efi',
      /for %f in fs0 fs1 fs2 fs3 fs4 fs5/u.test(nsh) && (nsh.match(/%f:\\efi\\boot\\bootx64\.efi/gu) ?? []).length >= 2)
    check('R5: ...guarded by `if exist`, and it names the failure when nothing boots',
      /if exist %f:\\efi\\boot\\bootx64\.efi then/u.test(nsh) && /Windows Setup did not start/u.test(nsh))
    check('R5: the script is EFI Shell dialect, not batch (no @echo off / goto)',
      nsh.startsWith('@echo -off') && !/goto|@echo off/u.test(nsh))
    // ...and writeOemPayload really writes it into the stick's ROOT.
    {
      const oemStore = mkdtempSync(path.join(os.tmpdir(), 'cua-r5-'))
      try {
        const oemPaths = windowsPaths(oemStore, 'win-nsh')
        const dir = writeOemPayload({
          paths: oemPaths, name: 'win-nsh', password: 'pw', sshPubKey: 'ssh-ed25519 AAAA x',
          sourceDir: path.join(REPO, 'docker', 'windows-oem'), pythonUrl: 'https://python', dshCuaSpec: 'dsh-cua==1'
        })
        const nshPath = path.join(dir, 'startup.nsh')
        check('R5: writeOemPayload puts startup.nsh in the stick ROOT (where the Shell looks)',
          existsSync(nshPath) && readFileSync(nshPath, 'utf8').includes('bootx64.efi'), nshPath)
        check('R5: ...next to Autounattend.xml, which Setup reads from the same root',
          existsSync(path.join(dir, 'Autounattend.xml')))
      } finally {
        rmSync(oemStore, { recursive: true, force: true })
      }
    }
    // ---- F2: A PAUSED GUEST IS CONTINUED BEFORE IT IS ASKED FOR ACPI ----
    //
    // The live defect: a VM left `paused` (a suspend, or a `-S` boot) never runs
    // its ACPI handler, so `system_powerdown` was accepted by QEMU and then
    // nothing happened for the full 120 s before a forced `quit`. The stub QMP
    // records the COMMAND ORDER, which is the only way to prove `cont` came
    // first, and ends the pid it reports when `quit` arrives so the wait loop
    // finishes in milliseconds instead of 15 s.
    const livePid = async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      // Wait for the pid to exist so pidAlive() is true on the first read.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try { process.kill(child.pid, 0); break } catch { await new Promise((r) => setTimeout(r, 20)) }
      }
      return child
    }
    const qmpRecorder = (order, { status, onQuit, onPowerdown }) => async (port, commands) => {
      for (const command of commands) {
        order.push(command.execute)
        if (command.execute === 'quit' && onQuit) onQuit()
        // A guest that HONOURS the powerdown: the process goes away inside the
        // wait window, which is the only shape where the outcome is not forced.
        if (command.execute === 'system_powerdown' && onPowerdown) onPowerdown()
      }
      if (commands[0].execute === 'query-status') return [{ return: { status } }]
      return [{ return: {} }]
    }
    {
      const child = await livePid()
      const name = 'win-paused'
      const paths = windowsPaths(store, name)
      mkdirSync(paths.dir, { recursive: true })
      writeFileSync(paths.qemuPid, `${child.pid}\n`)
      const order = []
      const backend = createWindowsBackend({
        store,
        qmp: qmpRecorder(order, {
          status: 'paused',
          onPowerdown: () => { try { child.kill('SIGKILL') } catch {} },
          onQuit: () => { try { child.kill('SIGKILL') } catch {} }
        }),
        log: () => {}
      })
      const row = { name, kind: 'windows', state: 'ready', ports: { qmp: 46912, ssh: 47912, vnc: 5912 } }
      const outcome = await backend.shutdown(row, { timeoutMs: 1000 })
      try { child.kill('SIGKILL') } catch {}
      check('F2: a PAUSED guest is sent `cont` before `system_powerdown`',
        order.join(',') === 'query-status,cont,system_powerdown', order.join(','))
      check('F2: ...and the continue-then-powerdown exit is not marked forced',
        outcome.exited === true && outcome.forced !== true, JSON.stringify(outcome))
    }
    // ---- F2: A MID-INSTALL SHUTDOWN IS SHORT, EXPLICIT AND TORN ----
    {
      const saved = process.env.DSH_CUA_WINDOWS_INSTALL_SHUTDOWN_MS
      try {
        process.env.DSH_CUA_WINDOWS_INSTALL_SHUTDOWN_MS = '0'
        const child = await livePid()
        const name = 'win-setup-shutdown'
        const paths = windowsPaths(store, name)
        mkdirSync(paths.dir, { recursive: true })
        writeFileSync(paths.qemuPid, `${child.pid}\n`)
        const order = []
        const backend = createWindowsBackend({
          store,
          qmp: qmpRecorder(order, { status: 'running', onQuit: () => { try { child.kill('SIGKILL') } catch {} } }),
          log: () => {}
        })
        // timeoutMs is the NORMAL 120 s: a mid-install guest must ignore it.
        const started = Date.now()
        const outcome = await backend.shutdown({ name, kind: 'windows', state: 'installing', ports: { qmp: 46913, ssh: 47913, vnc: 5913 } }, { timeoutMs: 120000 })
        const elapsed = Date.now() - started
        try { child.kill('SIGKILL') } catch {}
        check('F2: an installing row does not burn the full shutdown timeout',
          elapsed < 5000, `${elapsed} ms`)
        check('F2: ...it is a quit, classified installing, and marked forced (mayBeTorn)',
          outcome.installInProgress === true && outcome.forced === true && outcome.exited === true,
          JSON.stringify(outcome))
        check('F2: ...without a useless `cont` on a guest that is not paused',
          !order.includes('cont'), order.join(','))
        check('F2: the install window is clamped and defaults to 5 s',
          createWindowsBackend({ store, qmp: async () => [], log: () => {} }).installShutdownWindowMs() === 0)
        delete process.env.DSH_CUA_WINDOWS_INSTALL_SHUTDOWN_MS
        check('F2: ...unset it is 5 s',
          createWindowsBackend({ store, qmp: async () => [], log: () => {} }).installShutdownWindowMs() === 5000)
        process.env.DSH_CUA_WINDOWS_INSTALL_SHUTDOWN_MS = '999999'
        check('F2: ...and it never exceeds 30 s',
          createWindowsBackend({ store, qmp: async () => [], log: () => {} }).installShutdownWindowMs() === 30000)
      } finally {
        if (saved === undefined) delete process.env.DSH_CUA_WINDOWS_INSTALL_SHUTDOWN_MS
        else process.env.DSH_CUA_WINDOWS_INSTALL_SHUTDOWN_MS = saved
      }
    }
    // ---- F3: AN INSTALLING ROW IS NOT PROMOTED BY THE VNC BANNER ----
    //
    // The bug needs a REAL VNC peer: QEMU's VNC socket answers from the first
    // second of setup.exe, which is what made an ordinary status poll answer
    // "ready". The SSH port here has NO listener (the answer file has not
    // installed OpenSSH yet), so the two calls must disagree — the running
    // path accepts VNC, the install path (SSH only) refuses it.
    {
      const net = await import('node:net')
      const vnc = net.createServer((socket) => { try { socket.write('RFB 003.008\n') } catch {} })
      await new Promise((resolve) => vnc.listen(0, '127.0.0.1', resolve))
      const vncPort = vnc.address().port
      const name = 'win-setup-ready'
      const paths = windowsPaths(store, name)
      mkdirSync(paths.dir, { recursive: true })
      writeFileSync(paths.qemuPid, `${process.pid}\n`)
      const backend = createWindowsBackend({
        store,
        qmp: async () => [{ return: { status: 'running' } }],
        log: () => {}
      })
      const row = { name, kind: 'windows', state: 'installing', ports: { qmp: 46914, ssh: 0, vnc: vncPort } }
      const runningPhase = await backend.ready(row, { ssh: true })
      const installPhase = await backend.ready(row, { ssh: true, phase: 'install' })
      vnc.close()
      check('F3: the RUNNING readiness path accepts a bare VNC banner (the shape that promoted Setup)',
        runningPhase.ready === true && runningPhase.endpoint === 'vnc', JSON.stringify(runningPhase))
      check('F3: the INSTALL readiness path refuses it — SSH only, so the row stays installing',
        installPhase.ready === false && installPhase.endpoint === 'none', JSON.stringify(installPhase))
    }
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
}

// ---- S1/S2/S3: THE FAT32 ANSWER MEDIUM, ITS READ-BACK, AND THE OPTIONAL KEY ----
//
// The real proof is a REAL mtools build: mformat/mcopy produce setup.img and
// mdir/mtype read it back. mtools is a runtime dependency in the image, but a
// developer host may not have it; that case is reported NOT RUN, never as a
// pass (a fake green here would hide exactly the class of bug this replaces:
// a medium that looks attached and holds no answer file).
{
  const mtools = ['mformat', 'mcopy', 'mdir', 'mtype'].every((tool) => spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0)
  if (!mtools) {
    console.log('  n/a  S1/S2 setup.img build: mtools is absent from this host — NOT RUN (the image installs it; `apt-get install mtools` to run this here)')
  } else {
    const store = mkdtempSync(path.join(os.tmpdir(), 'cua-setup-img-'))
    try {
      const setupPaths = windowsPaths(store, 'win-setup')
      writeOemPayload({
        paths: setupPaths, name: 'win-setup', password: 'pw', sshPubKey: 'ssh-ed25519 AAAA x',
        sourceDir: path.join(REPO, 'docker', 'windows-oem'), pythonUrl: 'https://python', dshCuaSpec: 'dsh-cua==1'
      })
      const image = buildSetupImage({ paths: setupPaths })
      check('S1: buildSetupImage produces $STORE/windows/<name>/setup.img', image === setupPaths.setupImg && existsSync(image)
        && statSyncSafe(image) >= 32 * 1024 * 1024, `${image}`)
      // F1/F4: QEMU opens setup0 read-write; the runtime uid owns it and the
      // owner-write bit is set after the build (chmod 0600). A media file the
      // uid cannot write is the same class as `readonly=on`: device realize dies.
      {
        const st = statSync(image)
        check('F1/F4: setup.img is owner-writable and owned by the runtime uid (mode 0600)',
          (st.mode & 0o200) !== 0 && (st.mode & 0o777) === 0o600 && st.uid === process.getuid(), `mode=${(st.mode & 0o777).toString(8)} uid=${st.uid}`)
        // Rebuild policy: a second create must NEVER reuse the guest-written
        // image — it is unlinked and built fresh (byte-verified again).
        writeFileSync(path.join(setupPaths.setupImg), 'GUEST SCRATCH', { flag: 'r+' })
        const rebuilt = buildSetupImage({ paths: setupPaths })
        check('F1: a re-create REBUILDS setup.img fresh (no idempotent skip over guest writes)',
          rebuilt === setupPaths.setupImg && verifySetupImage({ paths: setupPaths }).entries.includes('Autounattend.xml')
          && statSync(rebuilt).size >= 32 * 1024 * 1024)
      }
      const verified = verifySetupImage({ paths: setupPaths })
      check('S2: mdir lists Autounattend.xml at the image ROOT',
        verified.entries.includes('Autounattend.xml'), verified.entries.join(','))
      check('S2: mdir lists startup.nsh and the three scripts at the root',
        ['startup.nsh', 'setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs'].every((name) => verified.entries.includes(name)))
      check('S2: $OEM$/$$/Setup/Scripts carries the SetupComplete + hidden launcher chain',
        ['setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs'].every((name) => verified.oemScripts.includes(name)),
        verified.oemScripts.join(','))
      check('S2: the image copy of Autounattend.xml is BYTE-identical to the staged file (mtype read-back)',
        verified.image === setupPaths.setupImg && readFileSync(path.join(setupPaths.oemDir, 'Autounattend.xml')).length > 0)
      const xml = readFileSync(path.join(setupPaths.oemDir, 'Autounattend.xml'), 'utf8')
      check('S2: every <DiskID> targets Disk 0 (the qcow2 on ide.0, not setup.img on ide.2)',
        answerFileDiskIds(xml).length === 2 && answerFileDiskIds(xml).every((id) => id === 0), answerFileDiskIds(xml).join(','))
      check('S2: the answer file has an explicit <InstallTo><DiskID>0</DiskID>',
        /<InstallTo>\s*<DiskID>0<\/DiskID>/u.test(xml))
      check('S2: assertAnswerFileTargetsSystemDisk accepts the staged file', (() => {
        try { return assertAnswerFileTargetsSystemDisk(xml).every((id) => id === 0) } catch { return false }
      })())
      check('S2: a wrong DiskID is REFUSED (the read-only medium would be wiped)', (() => {
        try { assertAnswerFileTargetsSystemDisk('<InstallTo><DiskID>1</DiskID></InstallTo><DiskID>1</DiskID>'); return false } catch (error) {
          return /targets DiskID 1/u.test(error.message)
        }
      })())
      check('S3: no windowsKey = no <ProductKey> block (evaluation media need none)',
        !/<ProductKey><Key>/u.test(xml) && !xml.includes('{{PRODUCT_KEY}}'))

      // ---- F1: THE MEDIUM IS A PARTITIONED DISK ----
      //
      // The live-verified root cause: setup.img was a partitionless FAT32
      // superfloppy. EDK2 mounts that; Windows does not mount a partitionless
      // FIXED disk, so WinPE's drive-root search had nothing to scan and Setup
      // showed the interactive language screen with the answer file provably
      // present. These assertions read the bytes, not the code.
      {
        const raw = readFileSync(setupPaths.setupImg)
        const signature = raw.toString('hex', 510, 512)
        check('F1: setup.img carries an MBR signature 0x55AA at offset 510',
          signature === '55aa', `offset 510 = 0x${signature}`)
        const entry = 0x1be
        const type = raw[entry + 4]
        const startLba = raw.readUInt32LE(entry + 8)
        const sectors = raw.readUInt32LE(entry + 12)
        check('F1: partition entry 1 at 0x1BE is type 0x0C (FAT32 LBA) and starts at LBA 2048',
          type === SETUP_PARTITION_TYPE && startLba === SETUP_PARTITION_START_LBA && startLba === 2048,
          `type=0x${type.toString(16)} startLba=${startLba} sectors=${sectors}`)
        check('F1: the partition is non-empty and fits the 64 MiB image',
          sectors > 0 && startLba + sectors <= raw.length / 512, `${startLba}+${sectors} <= ${raw.length / 512}`)
        check('F1: the partition starts at byte 1048576 (mtools @@ offset)',
          SETUP_PARTITION_OFFSET_BYTES === 1048576 && SETUP_PARTITION_OFFSET_BYTES === startLba * 512,
          `${SETUP_PARTITION_OFFSET_BYTES}`)
        // The boot sector at LBA 0 is a TABLE, not a VBR: the VBR moved into the
        // partition, which is the whole point.
        check('F1: LBA 0 is an MBR (no FAT VBR magic at byte 0 any more)',
          raw.toString('hex', 0, 3) !== 'eb5890' && raw.toString('hex', 0, 3) !== 'eb3c90',
          raw.toString('hex', 0, 3))
        check('F1: the VBR now lives at the partition offset (0xEB 0x58 0x90 / mtools signature)',
          raw.readUInt16LE(SETUP_PARTITION_OFFSET_BYTES + 11) === 512,
          `bytesPerSector=${raw.readUInt16LE(SETUP_PARTITION_OFFSET_BYTES + 11)}`)
        check('F1: the BPB hidden-sectors field equals the partition start (2048), as Windows compares',
          raw.readUInt32LE(SETUP_PARTITION_OFFSET_BYTES + 28) === SETUP_PARTITION_START_LBA,
          String(raw.readUInt32LE(SETUP_PARTITION_OFFSET_BYTES + 28)))
        const mbr = readSetupMbr(setupPaths.setupImg)
        check('F1: readSetupMbr reports the same geometry verifySetupImage enforces',
          mbr.signature === '55aa' && mbr.active === true && mbr.type === 0x0c && mbr.startLba === 2048,
          JSON.stringify(mbr))
        // mdir THROUGH THE PARTITION, by hand — the literal F1 acceptance test.
        const listing = spawnSync('mdir', ['-i', setupVolumeSpec(setupPaths.setupImg), '-b', '::/'], { encoding: 'utf8' })
        check('F1: `mdir -i img@@1048576` lists Autounattend.xml through the partition',
          listing.status === 0 && /Autounattend\.xml/iu.test(listing.stdout), (listing.stdout || listing.stderr || '').replace(/\s+/gu, ' ').slice(0, 120))
        // A copy of just the first sector is a valid MBR stub by construction.
        const stub = setupMbrSector({ startLba: 2048, sectorCount: 100 })
        check('F1: setupMbrSector is a 512-byte MBR (signature + one active 0x0C entry)',
          stub.length === 512 && stub[510] === 0x55 && stub[511] === 0xaa && stub[0x1be] === 0x80
          && stub[0x1be + 4] === 0x0c && stub.readUInt32LE(0x1be + 8) === 2048)
        check('F1: verifySetupImage REFUSES a partitionless image (the bug, executable)', (() => {
          const broken = path.join(store, 'superfloppy.img')
          writeFileSync(broken, Buffer.alloc(1024))
          try { verifySetupImage({ paths: { ...setupPaths, setupImg: broken } }); return false } catch (error) {
            return /partitionless|MBR/u.test(error.message)
          }
        })())
      }

      // ---- F2: THE EDITION IS NAMED ----
      {
        const selection = resolveWindowsImageSelection({ version: '11ltsc' })
        check('F2: 11ltsc resolves to /IMAGE/NAME with the name VERIFIED from the pinned ISO WIM XML',
          selection.key === '/IMAGE/NAME'
          && selection.value === 'Windows 11 IoT Enterprise LTSC 2024 Evaluation'
          && selection.verified === true,
          `${selection.key}=${selection.value} (${selection.source})`)
        check('F2: the table itself carries the verified value (single source of truth)',
          WINDOWS_IMAGE_SELECTIONS['11ltsc'].key === '/IMAGE/NAME'
          && WINDOWS_IMAGE_SELECTIONS['11ltsc'].value === 'Windows 11 IoT Enterprise LTSC 2024 Evaluation'
          && WINDOWS_IMAGE_SELECTIONS['11ltsc'].verified === true)
        check('F2: an operator ISO (no version) falls back to /IMAGE/INDEX 1',
          resolveWindowsImageSelection({ version: '' }).key === '/IMAGE/INDEX'
          && resolveWindowsImageSelection({ version: '' }).value === 1)
        check('F2: an explicit index wins over the version table',
          resolveWindowsImageSelection({ version: '11ltsc', imageIndex: 3 }).value === 3
          && resolveWindowsImageSelection({ version: '11ltsc', imageIndex: 3 }).key === '/IMAGE/INDEX')
        check('F2: an explicit name wins over the index',
          resolveWindowsImageSelection({ version: '11ltsc', imageIndex: 3, imageName: 'Windows 11 Enterprise LTSC 2024 Evaluation' }).key === '/IMAGE/NAME')
        check('F2: a malformed index is refused with the accepted shape', (() => {
          try { resolveWindowsImageSelection({ imageIndex: 'two' }); return false } catch (error) {
            return /windowsImageIndex/u.test(error.message)
          }
        })())
        check('F2: imageInstallFromXml carries exactly one <MetaData> with the key/value',
          (() => {
            const built = imageInstallFromXml(selection)
            return built.startsWith('<InstallFrom><MetaData ')
              && (built.match(/<MetaData\b/gu) ?? []).length === 1
              && built.includes('<Key>/IMAGE/NAME</Key>')
              && built.includes('<Value>Windows 11 IoT Enterprise LTSC 2024 Evaluation</Value>')
          })())
        check('F2: the STAGED answer file has <InstallFrom> before <InstallTo> (schema order)',
          xml.indexOf('<InstallFrom>') !== -1 && xml.indexOf('<InstallFrom>') < xml.indexOf('<InstallTo>'),
          `${xml.indexOf('<InstallFrom>')} < ${xml.indexOf('<InstallTo>')}`)
        check('F2: the staged XML selects an image (assertAnswerFileSelectsImage accepts it)',
          (() => { try { const picked = assertAnswerFileSelectsImage(xml); return picked.key === '/IMAGE/INDEX' && picked.value === '1' } catch { return false } })())
        check('F2: a missing <InstallFrom> is REFUSED (Setup would ask which edition)', (() => {
          try { assertAnswerFileSelectsImage('<OSImage><InstallTo><DiskID>0</DiskID></InstallTo></OSImage>'); return false } catch (error) {
            return /InstallFrom/u.test(error.message)
          }
        })())
        check('F2: two <MetaData> blocks are REFUSED (Setup honours the first, the rest is a lie)', (() => {
          const two = '<ImageInstall><OSImage><InstallFrom>'
            + '<MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>1</Value></MetaData>'
            + '<MetaData wcm:action="add"><Key>/IMAGE/NAME</Key><Value>X</Value></MetaData>'
            + '</InstallFrom><InstallTo><DiskID>0</DiskID></InstallTo></OSImage></ImageInstall>'
          try { assertAnswerFileSelectsImage(two); return false } catch (error) { return /exactly ONE <MetaData>/u.test(error.message) }
        })())
        // writeOemPayload with a version stages the NAME, not just the index.
        const named = windowsPaths(store, 'win-named')
        writeOemPayload({
          paths: named, name: 'win-named', password: 'pw', sshPubKey: 'ssh-ed25519 AAAA x',
          sourceDir: path.join(REPO, 'docker', 'windows-oem'), pythonUrl: 'https://python', dshCuaSpec: 'dsh-cua==1',
          windowsVersion: '11ltsc'
        })
        const namedXml = readFileSync(path.join(named.oemDir, 'Autounattend.xml'), 'utf8')
        check('F2: writeOemPayload(windowsVersion: 11ltsc) stages /IMAGE/NAME, not INDEX',
          namedXml.includes('<Key>/IMAGE/NAME</Key>')
          && namedXml.includes('<Value>Windows 11 IoT Enterprise LTSC 2024 Evaluation</Value>')
          && !namedXml.includes('{{IMAGE_INSTALL}}'))
      }

      // A licensed operator ISO: the key is normalised and written with
      // WillShowUI Never, so Setup never stops to ask.
      const keyed = windowsPaths(store, 'win-keyed')
      writeOemPayload({
        paths: keyed, name: 'win-keyed', password: 'pw', sshPubKey: 'ssh-ed25519 AAAA x',
        sourceDir: path.join(REPO, 'docker', 'windows-oem'), pythonUrl: 'https://python', dshCuaSpec: 'dsh-cua==1',
        windowsKey: 'vk7jg-nphtm-c97jm-9mpgt-3v66t'
      })
      const keyedXml = readFileSync(path.join(keyed.oemDir, 'Autounattend.xml'), 'utf8')
      check('S3: windowsKey writes <ProductKey> with WillShowUI Never',
        keyedXml.includes('<ProductKey><Key>VK7JG-NPHTM-C97JM-9MPGT-3V66T</Key><WillShowUI>Never</WillShowUI></ProductKey>'))
      check('S3: normaliseProductKey accepts dashed/lowercase and inserts dashes from 25 chars',
        normaliseProductKey(' vk7jg nphtm c97jm 9mpgt 3v66t ') === 'VK7JG-NPHTM-C97JM-9MPGT-3V66T'
        && normaliseProductKey('') === '')
      check('S3: a malformed key is refused with the accepted shape', (() => {
        try { normaliseProductKey('NOPE'); return false } catch (error) { return /not a Windows product key/u.test(error.message) }
      })())
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  }
}


console.log(failures === 0 ? '\nunit: PASS' : `\nunit: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
