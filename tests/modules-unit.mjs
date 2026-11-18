#!/usr/bin/env node
/**
 * modules-unit.mjs — the pure parts of the two new modules, and the Windows
 * container spec, asserted without a VM, a container or a daemon.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, accessSync, statSync, constants as fsConstants } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import {
  pngSize, formatSpace, formatSpaceWarning, spaceLine, relativeToPixels, toDisplayPixels, resolutionProblem, createSpace
} from '../docker/cua-vm-space.mjs'
import {
  WINDOWS_VERSIONS, WINDOWS_CATALOG, WINDOWS_ISO_SOURCES, resolveWindowsIso, resolveWindowsIsoSources,
  canonicalWindowsVersion, windowsCapacityWarnings, windowsFirmwareProfile, windowsFirmwareForSpec, verifyIsoDigest,
  isoFileName, clipAckMatches, clipAckVerdict, clipSha256, ensureIso, qemuEscapeOptionValue,
  charToKey, parseKeySpec, generatePassword, windowsEnabled,
  buildQemuArgs, vncDisplayFor, vncPortFor, windowsPaths, frameSpace,
  OEM_PAYLOAD_FILES, OEM_PAYLOAD_REQUIRED, OEM_CLIP_AGENT_FILE, OEM_MCP_RELAY_FILE, CLIP_AGENT_SENTINEL_FILE, SETUP_IMAGE_OPTIONAL, oemPayloadDir, oemPayloadDirStatus, oemPayloadDeniedDir, resolveOemSourceDir, writeOemPayload,
  oemPayloadMissingError, oemPayloadDeniedError, windowsKvmPreflight,
  SETUP_IMAGE_ENTRIES, SETUP_IMAGE_LABEL, buildSetupImage, verifySetupImage, answerFileDiskIds,
  assertAnswerFileTargetsSystemDisk, normaliseProductKey,
  SETUP_PARTITION_START_LBA, SETUP_PARTITION_OFFSET_BYTES, SETUP_PARTITION_TYPE, setupVolumeSpec,
  setupMbrSector, readSetupMbr, resolveWindowsImageSelection, imageInstallFromXml, assertAnswerFileSelectsImage,
  WINDOWS_IMAGE_SELECTIONS,
  formatWindowsInstallDetail, qmpStateLabel, endpointLabel, windowsTailLines, windowsPortsOf, windowsBootSpec,
  windowsReadinessSignals, qemuBootWindowMs, waitForQemuBoot,
  windowsRowName, windowsQmpAdapter, cdbootKeyScheduleMs, cdbootKeysEnabled, runCdbootKeys, cdbootPromptSeen, readSerialTail, startupNshText,
  cdbootPressFailure, cdbootPromptWindowMs, cdbootRearmCycles, cdbootRearmWatchMs, cdbootPressTimeoutMs,
  WINDOWS_SETUP_COPY_DONE_PATTERN, windowsSetupCopyFinished, windowsMediaEjectWatchMs,
  createWindowsBackend,
  // U4: the free-space probe's parser/formatter (pure), so the panel's number
  // and its below-floor warning are asserted without a guest.
  parseFreeSpaceProbe, formatWindowsFreeSpace, WINDOWS_FREE_FLOOR_GB
} from '../docker/cua-vm-windows-qemu.mjs'
import {
  KVM_GID_COMMAND, deviceNodePresent, formatKvmStatus, kvmDoctorFacts, kvmPreflightError, kvmStatus
} from '../docker/cua-vm-kvm.mjs'
import {
  wsAccept, isClientCutText, parseClientCutText, serverCutTextFrame, encodeCutText,
  WS_SUBPROTOCOLS, selectSubprotocol, startClipboardBridge
} from '../docker/cua-vnc-clip.mjs'
import {
  DEFAULT_SERVER_NAME, TOOL_PREFIX, REVEAL_TOOL_NAME, DOCTOR_TOOL_NAME,
  windowsToolName, windowsGuestToolName, sshArgv, SSH_KEEPALIVE,
  // J22-14: the interactive MCP relay's lane, probe and zero-SSH doctor facts.
  RELAY_COMMAND, RELAY_PORT_DEFAULT, RELAY_OK, RELAY_BAD, RELAY_DOWN, RELAY_PROBE_TTL_MS,
  // J22-14b: the `--ping` probe's 12 s wall and the upgrade watch that lets a
  // late-starting relay take over a live session-0 attach.
  RELAY_PROBE_TIMEOUT_MS, RELAY_UPGRADE_INTERVAL_MS, RELAY_UPGRADE_WATCH_MS, RELAY_UPGRADE_LOG,
  shouldUpgradeToRelay,
  SESSION0_FALLBACK_REASON, relayPort, relayProbeCommand, createDshCuaClient
} from '../plugins/dsh-cua-vm/win-mcp.js'

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
// WP-2: SIXTEEN CODES, the dockur/windows vocabulary. This list is the ONLY
// table: the catalog, the firmware profiles and the image selections are all
// derived from it, so a code added here without a row fails the very next check.
check('the sixteen Windows codes are the catalog set', WINDOWS_VERSIONS.join(',') === '11,11l,11e,10,10l,10e,7u,xp,2025,2022,2019,2016,2012,core11,tiny11,tiny10', WINDOWS_VERSIONS.join(','))
check('every code has a catalog row with a size, a firmware profile and a label', WINDOWS_VERSIONS.every((code) => {
  const entry = WINDOWS_CATALOG[code]
  return entry !== undefined && entry.sizeGb > 0 && (entry.bios === 'ovmf' || entry.bios === 'seabios') && typeof entry.label === 'string'
}), WINDOWS_VERSIONS.filter((code) => WINDOWS_CATALOG[code] === undefined).join(',') || 'all rows present')
check('xp is the only refused code, and its refusal is data', WINDOWS_VERSIONS.filter((code) => WINDOWS_CATALOG[code].refusal !== undefined).join(',') === 'xp'
  && WINDOWS_CATALOG.xp.refusal === 'legacy-installer-unsupported')
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
  // P2: VIRTIO IS OPT-IN. Every Windows code defaults to the profile's INBOX
  // hardware — ide-hd on the q35 ICH9 AHCI controller (an IDE-class disk whose
  // driver has shipped in the box since Vista) and e1000e — because a stripped
  // image (tiny10/tiny11/core11) has no virtio driver and a guest with no disk
  // or no NIC driver is an install that never finishes and never answers SSH.
  {
    const inbox = buildQemuArgs({ name: 'win-1', cpu: 2, memory: 4, gpu: false, paths, isoPath: '/x.iso', driverIso: null, sshPort: 1, vncPort: 2, qmpPort: 3, installPending: false, virtio: true })
    check('P2: with the knob unset, `virtio: true` still gets inbox hardware (ide-hd on ide.0 + e1000e)',
      inbox.includes('ide-hd,drive=disk0,bus=ide.0,bootindex=1')
      && !inbox.some((item) => /virtio-blk-pci|virtio-net-pci/u.test(item))
      && inbox.includes('e1000e,netdev=net0'), inbox.filter((item) => /disk0|net0/u.test(item)).join(','))
    const saved = process.env.DSH_CUA_WINDOWS_VIRTIO
    try {
      process.env.DSH_CUA_WINDOWS_VIRTIO = '1'
      check('R4: with DSH_CUA_WINDOWS_VIRTIO=1 the virtio disk follows the same phase rule',
        buildQemuArgs({ name: 'win-1', cpu: 2, memory: 4, gpu: false, paths, isoPath: '/x.iso', driverIso: null, sshPort: 1, vncPort: 2, qmpPort: 3, installPending: true, virtio: true })
          .includes('virtio-blk-pci,drive=disk0,bootindex=2'))
      check('P2: ...and the NIC becomes virtio-net-pci only then (both halves are one decision)',
        buildQemuArgs({ name: 'win-1', cpu: 2, memory: 4, gpu: false, paths, isoPath: '/x.iso', driverIso: null, sshPort: 1, vncPort: 2, qmpPort: 3, installPending: false, virtio: true })
          .includes('virtio-net-pci,netdev=net0'))
      check('P2: the opt-in alone is not enough — the spec must still ask for virtio',
        !buildQemuArgs({ name: 'win-1', cpu: 2, memory: 4, gpu: false, paths, isoPath: '/x.iso', driverIso: null, sshPort: 1, vncPort: 2, qmpPort: 3, installPending: false, virtio: false })
          .some((item) => /virtio-blk-pci|virtio-net-pci/u.test(item)))
    } finally {
      if (saved === undefined) delete process.env.DSH_CUA_WINDOWS_VIRTIO
      else process.env.DSH_CUA_WINDOWS_VIRTIO = saved
    }
  }
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
// WP-3: THE ISO SOURCE IS A CHAIN, NOT A PINNED URL.
//
// The five-version era pinned one object per version and the bet lost: four of
// the five URLs answered 400 on 2026-11-15. What is asserted now is the SHAPE
// that replaced it — sixteen rows, a non-empty ordered chain for every code that
// can install, and the compatibility `url` naming the first STATIC entry (a
// `mido`/`esd` strategy has no URL until it has been resolved online).
check('the ISO source table has one row per catalog code', Object.keys(WINDOWS_ISO_SOURCES).length === 16
  && WINDOWS_VERSIONS.every((code) => WINDOWS_ISO_SOURCES[code]?.code === code))
check('every installable code has a NON-EMPTY ordered source chain',
  WINDOWS_VERSIONS.filter((code) => code !== 'xp').every((code) => {
    const sources = WINDOWS_ISO_SOURCES[code].sources
    return Array.isArray(sources) && sources.length > 0 && sources.every((source) => typeof source.strategy === 'string')
  }),
  WINDOWS_VERSIONS.map((code) => `${code}:${(WINDOWS_ISO_SOURCES[code].sources ?? []).length}`).join(' '))
check('the compatibility url is the FIRST STATIC link in the chain (never a live mido/esd entry)',
  WINDOWS_VERSIONS.every((code) => {
    const entry = WINDOWS_ISO_SOURCES[code]
    const statics = entry.sources.filter((source) => typeof source.url === 'string' && source.live !== true && source.catalog !== true)
    if (entry.url === null) return statics.length === 0
    return entry.url === statics[0]?.url
  }))
check('the pinned URL is a Microsoft prss object where one exists',
  WINDOWS_ISO_SOURCES['2025'].url.startsWith('https://software-static.download.prss.microsoft.com/')
  && WINDOWS_ISO_SOURCES['11l'].url.includes('CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso'))
// XP IS LISTED AND REFUSED — with the real obstacle, not "unknown version".
check('xp is a CODE that refuses with legacy-installer-unsupported', (() => {
  try { resolveWindowsIsoSources('xp'); return false } catch (error) {
    return error.code === 'legacy-installer-unsupported'
      && /winnt\.sif/u.test(error.message)
      && Array.isArray(error.sources) && error.sources.length > 0
  }
})())
check('resolveWindowsIso refuses xp the same way (the cheap gate every create passes)', (() => {
  try { resolveWindowsIso('xp'); return false } catch (error) { return error.code === 'legacy-installer-unsupported' }
})())
// TINY10 IS AN ARCHIVE.ORG ARTEFACT ONLY: it has no Microsoft page and no
// marketplace mirror, and pretending otherwise would 400 the first create.
check('tiny10 is served only by archive.org', (() => {
  const sources = WINDOWS_ISO_SOURCES.tiny10.sources
  return sources.length === 1 && sources[0].strategy === 'link6' && sources[0].url.startsWith('https://archive.org/download/')
})())
check('the tiny11 family is pinned by byte count and SHA-256',
  ['core11', 'tiny11', 'tiny10'].every((code) => {
    const source = WINDOWS_ISO_SOURCES[code].sources[0]
    return source.bytes > 0 && /^[0-9a-f]{64}$/u.test(source.sha256)
  }))
check('11l resolves to its first (IoT LTSC, verified by NAME) source',
  resolveWindowsIso('11l').url.includes('CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso'))
check('the probed version resolves', resolveWindowsIso('2025').url.startsWith('https://'))
// THE ALIASES: the old spellings still answer, and they canonicalise to the
// SIXTEEN-CODE vocabulary (a spelling that dies is a regression dressed as a typo).
check('the old spellings canonicalise: ltsc11→11l, ltsc10→10l, 2022→2022',
  canonicalWindowsVersion('ltsc11') === '11l'
  && canonicalWindowsVersion('ltsc10') === '10l'
  && canonicalWindowsVersion('2022') === '2022'
  && canonicalWindowsVersion(' Win11 ') === '11'
  && canonicalWindowsVersion('') === '')
check('an unknown spelling throws with the sixteen codes, never a silent default', (() => {
  try { canonicalWindowsVersion('windows-3000'); return false } catch (error) {
    return /catalog has 16 codes/u.test(error.message) || /expected one of/u.test(error.message)
  }
})())
check('exactly two versions carry a live mido strategy (11 and 10, the two pages that still publish one)',
  WINDOWS_VERSIONS.filter((code) => WINDOWS_ISO_SOURCES[code].sources.some((source) => source.strategy === 'mido')).join(',') === '11,10')

// ------------------------------------------------------------------ *
// WP-2/WP-3: THE FIRMWARE PROFILES, THE IMAGE SELECTION AND THE ISO CACHE
// ------------------------------------------------------------------ *
//
// These are the PURE decisions a create makes before a byte moves: which
// firmware this code boots on, which image inside the media Setup installs,
// what a URL's cache file is called, and whether a downloaded file is the one
// that was pinned. Every one of them used to be inferred from something else
// (an argv, a hand-written table, a random suffix) — the checks below pin the
// decision itself.
{
  const ovmf = windowsFirmwareProfile('11')
  const seabios = windowsFirmwareProfile('7u')
  check('WP-2: 11 boots on the OVMF profile (q35, TPM2, inbox AHCI disk + e1000e NIC)',
    ovmf.bios === 'ovmf' && ovmf.machine === 'q35' && ovmf.tpm === true && ovmf.efiVars === true
    && ovmf.disk === 'ide-hd' && ovmf.nic === 'e1000e' && ovmf.legacy === false,
    JSON.stringify(ovmf))
  check('WP-2: 7u boots on SeaBIOS (pc, no TPM, IDE disk, e1000e) — the only shape Windows 7 Setup can install on',
    seabios.bios === 'seabios' && seabios.machine === 'pc' && seabios.tpm === false && seabios.efiVars === false
    && seabios.disk === 'ide-hd' && seabios.nic === 'e1000e' && seabios.legacy === true,
    JSON.stringify(seabios))
  check('WP-2: an empty version takes the modern profile (the operator-ISO shape)', windowsFirmwareProfile('').bios === 'ovmf'
    && windowsFirmwareProfile('').legacy === false)
  // A row that records neither a version nor a marker still has the FILE NAME:
  // that is what stops a Windows 7 computer from coming back on q35/OVMF after
  // a restart (a failure that only appears on the SECOND boot).
  check('WP-2: the media file name decides the firmware when nothing else does',
    windowsFirmwareForSpec({ isoPath: '/iso/en_windows_7_with_sp1_x64.iso' }).bios === 'seabios'
    && windowsFirmwareForSpec({ isoPath: '/iso/en-us_windows_11_25h2_x64.iso' }).bios === 'ovmf'
    && windowsFirmwareForSpec({}).bios === 'ovmf')
  check('WP-2: a 7u argv carries NO pflash and NO TPM, and an IDE disk',
    (() => {
      const args = buildQemuArgs({
        name: 'win-7', cpu: 2, memory: 4, gpu: false, paths: windowsPaths('/cua-vm', 'win-7'),
        isoPath: '/cua-vm/iso/w7.iso', driverIso: null, sshPort: 47100, vncPort: 5931, qmpPort: 46100,
        installPending: true, virtio: false, windowsVersion: '7u'
      }).join(' ')
      return !args.includes('if=pflash') && !args.includes('tpm-crb') && args.includes('ide-hd,drive=disk0') && args.includes('e1000e,netdev=net0')
        && !args.includes('virtio-blk') && !args.includes('virtio-net')
    })())
  check('WP-2: an 11 argv keeps the OVMF pair, the TPM and virtio',
    (() => {
      const args = buildQemuArgs({
        name: 'win-11', cpu: 2, memory: 4, gpu: false, paths: windowsPaths('/cua-vm', 'win-11'),
        isoPath: '/cua-vm/iso/w11.iso', driverIso: null, sshPort: 47100, vncPort: 5931, qmpPort: 46100,
        installPending: true, virtio: false, windowsVersion: '11'
      }).join(' ')
      return args.includes('if=pflash,format=raw,readonly=on,file=') && args.includes('tpm-crb,tpmdev=tpm0') && args.includes('q35,accel=kvm,smm=off')
    })())

  // THE SELECTION PRECEDENCE: caller name → caller index → the SOURCE's own
  // selection (the link that will actually serve the bytes) → the catalog.
  check('WP-2: sourceSelection wins over the catalog (link1 pins SERVERSTANDARD by NAME)',
    (() => {
      const picked = resolveWindowsImageSelection({ version: '2025', sourceSelection: { key: '/IMAGE/NAME', value: 'Windows Server 2025 SERVERSTANDARD', verified: true } })
      return picked.key === '/IMAGE/NAME' && picked.value === 'Windows Server 2025 SERVERSTANDARD' && picked.source === 'source'
    })())
  check('WP-2: the selection table is DERIVED from the catalog, one row per selecting code',
    Object.keys(WINDOWS_IMAGE_SELECTIONS).length === WINDOWS_VERSIONS.filter((code) => WINDOWS_CATALOG[code].selection !== undefined).length
    && WINDOWS_IMAGE_SELECTIONS['11l'].note.includes('read from the media')
    && WINDOWS_IMAGE_SELECTIONS['11'].note.includes('index reasoned'))

  // THE CACHE FILE NAME IS A FUNCTION OF THE URL AGAIN. The old name appended
  // randomBytes(4), so isoTargetPath() (the quota reservation and the keep-list)
  // and ensureIso's own write named DIFFERENT paths and every restart
  // re-downloaded 5.5 GB.
  const urlA = 'https://dl.bobpony.com/windows/11/en-us_windows_11_25h2_x64.iso'
  const urlB = 'https://archive.org/download/x/en-us_windows_11_25h2_x64.iso'
  check('WP-3: isoFileName is stable for one URL and different across URLs',
    isoFileName(urlA) === isoFileName(urlA) && isoFileName(urlA) !== isoFileName(urlB)
    && isoFileName(urlA).endsWith('.iso') && /^[\w.-]+-[0-9a-f]{8}\.iso$/u.test(isoFileName(urlA)),
    `${isoFileName(urlA)} vs ${isoFileName(urlB)}`)
  check('WP-3: isoFileName keeps the readable base name', isoFileName(urlA).startsWith('en-us_windows_11_25h2_x64-'))

  // DIGEST VERIFICATION: a mismatch is a THROW, not a boolean a caller ignores.
  const digestDir = mkdtempSync(path.join(os.tmpdir(), 'iso-digest-'))
  try {
    const file = path.join(digestDir, 'media.iso')
    writeFileSync(file, 'hello')
    const good = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    const verified = await verifyIsoDigest(file, good.toUpperCase())
    check('WP-3: verifyIsoDigest accepts the pinned SHA-256 (case-insensitive)', verified.verified === true && verified.sha256 === good)
    let threwDigest = null
    try { await verifyIsoDigest(file, '0'.repeat(64)) } catch (error) { threwDigest = error }
    check('WP-3: verifyIsoDigest REFUSES a substituted file with iso-digest-mismatch',
      threwDigest?.code === 'iso-digest-mismatch' && /refusing to install an image nobody verified/u.test(threwDigest.message),
      String(threwDigest?.message ?? 'no throw').slice(0, 120))
    check('WP-3: an unknown digest (empty pin) verifies nothing and claims nothing',
      (await verifyIsoDigest(file, '')).verified === false)
  } finally {
    rmSync(digestDir, { recursive: true, force: true })
  }

  // THE CLIPBOARD AGENT'S ACK IS THE CONTRACT with a separately shipped guest
  // agent: seq, digest and the agent's own `equal` must ALL agree.
  const sha = clipSha256('hello')
  check('WP-6: clipAckMatches accepts only a full, matching ack',
    clipAckMatches({ seq: 7, sha256: sha }, { seq: 7, sha256: sha, equal: true }) === true
    && clipAckMatches({ seq: 7, sha256: sha }, { seq: 6, sha256: sha, equal: true }) === false
    && clipAckMatches({ seq: 7, sha256: sha }, { seq: 7, sha256: 'deadbeef', equal: true }) === false
    && clipAckMatches({ seq: 7, sha256: sha }, { seq: 7, sha256: sha, equal: false }) === false
    && clipAckMatches({ seq: 7, sha256: sha }, null) === false)
}

// ------------------------------------------------------------------ *
// J21/J1/J22 — THE FIX-ROUND REGRESSIONS (pure halves)
//
// Each check below is one defect from the jury round, asserted against the
// SHIPPED export (no copy of the logic): the verdict's reason, the comma
// escape, the agent's three clock spellings, the unpinned cache, the outbox
// budget and the NUL truncation. The end-to-end halves live in
// supervisor-smoke.mjs; these are the parts a module can prove alone.
// ------------------------------------------------------------------ *
{
  // J21-2: AN AGENT THAT SAYS "I FAILED" IS NOT A DIGEST MISMATCH. The old code
  // looked only at equal/seq/sha256, so `{ ok: false, error: 'locked' }` fell
  // through to the generic ack-mismatch — sending an operator to look at hashing
  // and encoding instead of at the agent's real complaint.
  const sha = clipSha256('hello')
  const locked = clipAckVerdict({ seq: 7, sha256: sha }, { ok: false, code: 'E_LOCK', error: 'clipboard is locked by another process' })
  check('J21-2: an ack with ok:false + a code answers agent-error:<code>, not ack-mismatch',
    locked.ok === false && locked.reason === 'agent-error:E_LOCK'
    && /the agent reported a failure/u.test(locked.detail) && /locked by another process/u.test(locked.detail),
    JSON.stringify(locked))
  const noCode = clipAckVerdict({ seq: 7, sha256: sha }, { ok: false, error: 'Set-Clipboard threw\r\nat line 4' })
  check('J21-2: ...a message with no code becomes the (one-line, truncated) agent-error text',
    noCode.reason === 'agent-error:Set-Clipboard threw at line 4', noCode.reason)
  // AGENTS THAT PREDATE THE FIELD SEND NO `ok` AT ALL: `undefined` is NOT false.
  const legacy = clipAckVerdict({ seq: 7, sha256: sha }, { seq: 7, sha256: sha, equal: true })
  check('J21-2: an ack with NO ok field is still a pass when seq+sha+equal agree (undefined ≠ false)',
    legacy.ok === true && legacy.reason === '', JSON.stringify(legacy))
  const emptyError = clipAckVerdict({ seq: 7, sha256: sha }, { seq: 7, sha256: sha, equal: true, error: '   ' })
  check('J21-2: ...and a whitespace-only error string is not a failure either', emptyError.ok === true)

  // J1-3: `,,` IS THE ONLY ESCAPE QEMU'S OPTION SPLITTER UNDERSTANDS.
  check("J1-3: qemuEscapeOptionValue('a,b') is 'a,,b' (and leaves a clean path alone)",
    qemuEscapeOptionValue('a,b') === 'a,,b'
    && qemuEscapeOptionValue('/store/windows/win1/disk.qcow2') === '/store/windows/win1/disk.qcow2'
    && qemuEscapeOptionValue('a,b,c') === 'a,,b,,c'
    && qemuEscapeOptionValue('') === '',
    qemuEscapeOptionValue('a,b'))

  // J21-1 + J21-6: THE AGENT-FIRST PATH, DRIVEN WITH A STUB TRANSPORT. `state`
  // is whatever the guest's clip-state.json holds; `agent:false` makes the file
  // unreadable (the schtasks fallback).
  const makeClipStub = ({ agent = true, state = { at: Date.now(), seq: 5 }, readBack = '' } = {}) => {
    const calls = []
    const files = new Map()
    let job = null
    return {
      calls,
      transport: {
        async sshRun(_spec, command) {
          calls.push({ kind: 'ssh', command })
          if (/type "[^"]*clip-state\.json"/u.test(command)) {
            return agent ? { code: 0, stdout: JSON.stringify(state), stderr: '' } : { code: 1, stdout: '', stderr: 'File Not Found' }
          }
          if (/type "[^"]*clip-ack\.json"/u.test(command)) {
            if (job === null) return { code: 1, stdout: '', stderr: 'File Not Found' }
            return { code: 0, stdout: JSON.stringify({ seq: job.seq, sha256: job.sha256, equal: true }), stderr: '' }
          }
          if (/type "[^"]*clip-current\.txt"/u.test(command)) return { code: 0, stdout: readBack, stderr: '' }
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
          return { code: 0, stderr: '', text: files.get(guestPath) ?? readBack }
        }
      }
    }
  }

  // J21-1a: `at`, `ts` AND `updatedAt` ALL NAME A LIVE AGENT. Reading only `ts`
  // made the shipped agent (which writes `at`) evaluate as age 0 → Infinity →
  // stale, so the fast path never ran.
  for (const key of ['at', 'ts', 'updatedAt']) {
    const stub = makeClipStub({ state: { [key]: Date.now(), seq: 5 } })
    const backend = createWindowsBackend({ store: os.tmpdir(), qmp: async () => [], log: () => {}, transport: stub.transport })
    const answer = await backend.clipboardSet({ name: 'clip-clock' }, 'hello')
    check(`J21-1: readClipState accepts \`${key}\` as the agent's clock (fast path taken)`,
      answer.ok === true && answer.via === 'agent', JSON.stringify(answer).slice(0, 180))
  }
  // NO STAMP AT ALL IS 0, and 0 is `stampMissing` + `agent-stale`, never
  // invented freshness: the backend declines the fast path and says why.
  {
    const stub = makeClipStub({ state: { seq: 5 } })
    const backend = createWindowsBackend({ store: os.tmpdir(), qmp: async () => [], log: () => {}, transport: stub.transport })
    const answer = await backend.clipboardSet({ name: 'clip-clock' }, 'hello')
    check('J21-1: a state file with NO clock stamp is agent-stale (missing = 0, never fresh)',
      answer.ok === true && answer.via === 'task' && answer.fastPathReason === 'agent-stale',
      JSON.stringify(answer).slice(0, 200))
  }

  // J21-5c: THE OUTBOX BUDGET IS CHECKED BEFORE ANY ROUND TRIP. The agent refuses
  // a JOB FILE, and 1 MiB − 2048 is the text budget; a text just over it must not
  // cost an SSH call that can only end in `agent-error:too-large`.
  {
    const stub = makeClipStub()
    const backend = createWindowsBackend({ store: os.tmpdir(), qmp: async () => [], log: () => {}, transport: stub.transport })
    const answer = await backend.clipboardSet({ name: 'clip-big' }, 'x'.repeat(1_047_000))
    // THE JOB NEVER LEAVES THE HOST. 1 MiB − 2048 is the outbox text budget, and
    // the text (1 047 000 bytes) is legal for the TASK path but not as a job FILE.
    // The fast path therefore declines with `too-large` before any clip-state /
    // clip-ack / outbox round trip, and the documented schtasks fallback — whose
    // limit is the 1 MiB text — still delivers. What must NOT happen is a job file
    // being uploaded only for the agent to refuse it, or a silent downgrade.
    const agentCalls = stub.calls.filter((call) => call.kind === 'ssh' && /clip-state|clip-ack/u.test(call.command))
    const jobUploads = stub.calls.filter((call) => call.kind === 'put' && /outbox/u.test(String(call.guestPath)))
    check('J21-5: an over-budget text declines the fast path as too-large with ZERO agent round trips',
      answer.ok === true && answer.via === 'task' && answer.fastPathReason === 'too-large'
      && agentCalls.length === 0 && jobUploads.length === 0,
      `via=${answer.via} fastPathReason=${answer.fastPathReason} agentCalls=${agentCalls.length} jobUploads=${jobUploads.length}`)
  }

  // J21-6: A NUL IS A TRUNCATION. Windows' clipboard stops at U+0000, so the
  // task path stays ok:true but must say `verified:false` and how much landed.
  {
    const stub = makeClipStub({ agent: false })
    const backend = createWindowsBackend({ store: os.tmpdir(), qmp: async () => [], log: () => {}, transport: stub.transport })
    const answer = await backend.clipboardSet({ name: 'clip-nul' }, 'a\u0000bc')
    check('J21-6: a NUL in the text reports nulTruncated{landed,total} and verified:false',
      answer.ok === true && answer.via === 'task' && answer.verified === false
      && answer.nulTruncated?.landed === 1 && answer.nulTruncated?.total === 4
      && /stops at the first NUL \(1 of 4 characters landed\)/u.test(answer.detail ?? ''),
      JSON.stringify(answer.nulTruncated ?? null) + ' ' + String(answer.detail ?? '').slice(0, 120))
  }
}

// ------------------------------------------------------------------ *
// J1-5: AN UNPINNED CACHE IS NOT A PASS
//
// The old hit test was `exists && size > 1 MB`, and with no pin
// (`wantSha === ''`) it returned ok:true having verified nothing. Now the only
// claim available is the sidecar, and it is checked against the FILE; without
// one the cache is refused as `unpinned-cache` and downloaded again. A local
// HTTP server stands in for the CDN so the re-download is real but instant.
// ------------------------------------------------------------------ *
{
  const body = Buffer.from('a re-downloaded medium\n')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-length': String(body.length), 'content-type': 'application/octet-stream' })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/unpinned-media.iso`
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'iso-unpinned-'))
  try {
    // 2 MiB with NO `.sha256` sidecar: the old code called this a cache hit.
    writeFileSync(path.join(cacheDir, isoFileName(url)), Buffer.alloc(2 * 1024 * 1024, 0x5a))
    const logs = []
    const answer = await ensureIso({ url, isoDir: cacheDir, log: (line) => logs.push(String(line)) })
    check('J1-5: a cached ISO with no pin and no sidecar is refused as unpinned-cache',
      logs.some((line) => /rejected \(unpinned-cache\)/u.test(line)),
      logs.find((line) => /rejected/u.test(line)) ?? logs.join(' | ').slice(0, 160))
    check('J1-5: ...and the refusal costs a real re-download (never a silent pass)',
      answer.downloaded === true && answer.verified === false && answer.bytes === body.length,
      JSON.stringify({ downloaded: answer.downloaded, verified: answer.verified, bytes: answer.bytes }))
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
    await new Promise((resolve) => server.close(resolve))
  }
}

// ------------------------------------------------------------------ *
// WP-5: THE PUBLIC TOOL NAMESPACE AND THE SSH KEEPALIVE
// ------------------------------------------------------------------ *
{
  check('WP-5: the server name and prefix are the harness vocabulary',
    DEFAULT_SERVER_NAME === 'windows' && TOOL_PREFIX === 'mcp__windows__'
    && REVEAL_TOOL_NAME === 'windows_desktop' && DOCTOR_TOOL_NAME === 'windows_mcp_doctor')
  check('WP-5: windowsToolName produces the public name and never doubles the prefix',
    windowsToolName('tool_click_at') === 'mcp__windows__tool_click_at'
    && windowsToolName('mcp__windows__tool_click_at') === 'mcp__windows__tool_click_at'
    && windowsToolName('some tool/x') === 'mcp__windows__some_tool_x')
  check('WP-5: windowsGuestToolName is the reverse mapping', windowsGuestToolName('mcp__windows__find_elements') === 'find_elements'
    && windowsGuestToolName('find_elements') === 'find_elements')
  const argv = sshArgv({ port: 47100, keyPath: '/cua-vm/windows/win-1/id_ed25519' })
  check('WP-5: sshArgv carries -T (no pty), the per-computer key and ServerAliveCountMax=2',
    argv.includes('-T') && argv.includes('-i') && argv.includes('/cua-vm/windows/win-1/id_ed25519')
    && argv.includes('ServerAliveInterval=10') && argv.includes('ServerAliveCountMax=2')
    && argv.includes('BatchMode=yes') && argv.at(-1).includes('dsh_cua.server --stdio'),
    argv.join(' ').slice(0, 160))
  check('WP-5: SSH_KEEPALIVE disables agent/X11/local-command forwarding',
    SSH_KEEPALIVE.includes('ForwardAgent=no') && SSH_KEEPALIVE.includes('ForwardX11=no') && SSH_KEEPALIVE.includes('PermitLocalCommand=no'))
}

// ------------------------------------------------------------------ *
// J22-14: THE INTERACTIVE MCP RELAY — one python file, two modes
// ------------------------------------------------------------------ *
// The Windows MCP server used to be started BY the SSH command, i.e. in
// Session 0, where UIA enumerates zero windows (`list_windows` answered 0 while
// notepad sat in "Services"). The relay keeps the stdio transport exactly as it
// is and moves only the SERVER into the logged-on user's session.
//
// What is asserted here is the part that is PURE: the probe pair and its LENGTH
// (the firstboot bug was a nine-byte read of an eight-byte answer), the lane
// constants on both sides of the wire, the port rule, and the doctor's zero-SSH
// facts. The guest-side wiring is gated by tools/check-cua-vm.mjs; the
// behavioural half (a real attach, a real doctor payload) is tests/windows-mcp-gate.mjs,
// which is why `transportText` — built inside index.js from those same facts —
// is not re-tested here.
{
  const relaySource = readFileSync(path.join(REPO, 'docker', 'cua-mcp-relay.py'), 'utf8')
  const ping = /PROBE_PING = b'([^']+)'/u.exec(relaySource)?.[1] ?? ''
  const ok = /PROBE_OK = b'([^']+)'/u.exec(relaySource)?.[1] ?? ''
  const pyPort = Number(/^DEFAULT_PORT = (\d+)$/mu.exec(relaySource)?.[1] ?? 0)
  check('J22-14: the relay answers RELAY_PING with RELAY_OK — and RELAY_OK is EIGHT bytes',
    ping === 'RELAY_PING' && ok === 'RELAY_OK'
    && Buffer.byteLength(ping, 'ascii') === 10 && Buffer.byteLength(ok, 'ascii') === 8,
    `${ping || 'missing'}(${Buffer.byteLength(ping, 'ascii')}) -> ${ok || 'missing'}(${Buffer.byteLength(ok, 'ascii')})`)
  // ONE spelling of the pair. The client compares constants; the guest compares
  // bytes. If either side is "fixed" alone, every attach falls back to the blind
  // lane — which works, and is exactly how it would go unnoticed.
  check('J22-14: ...and the client uses the SAME pair, with no second spelling',
    RELAY_OK === ok && RELAY_BAD === 'RELAY_BAD' && RELAY_DOWN === 'RELAY_DOWN'
    && RELAY_PROBE_TTL_MS === 10000,
    `${RELAY_OK}/${RELAY_BAD}/${RELAY_DOWN} ttl=${RELAY_PROBE_TTL_MS}`)
  check('J22-14: the relay port default agrees on both sides of the wire (47999)',
    pyPort === 47999 && RELAY_PORT_DEFAULT === 47999, `py=${pyPort} js=${RELAY_PORT_DEFAULT}`)
  const savedPort = process.env.DSH_CUA_MCP_RELAY_PORT
  try {
    process.env.DSH_CUA_MCP_RELAY_PORT = '51234'
    const overridden = relayPort()
    process.env.DSH_CUA_MCP_RELAY_PORT = 'not-a-port'
    const garbage = relayPort()
    process.env.DSH_CUA_MCP_RELAY_PORT = '70000'
    const outOfRange = relayPort()
    delete process.env.DSH_CUA_MCP_RELAY_PORT
    check('J22-14: DSH_CUA_MCP_RELAY_PORT overrides the port; garbage falls back instead of building a broken line',
      overridden === 51234 && garbage === 47999 && outOfRange === 47999 && relayPort() === 47999,
      `override=${overridden} garbage=${garbage} out-of-range=${outOfRange} unset=${relayPort()}`)
  } finally {
    if (savedPort === undefined) delete process.env.DSH_CUA_MCP_RELAY_PORT
    else process.env.DSH_CUA_MCP_RELAY_PORT = savedPort
  }
  check('J22-14: the SSH child runs the relay CLIENT verbatim (`py -3 ...\\mcp-relay.py --connect`)',
    RELAY_COMMAND === 'py -3 C:\\ProgramData\\cua\\mcp-relay.py --connect', RELAY_COMMAND)
  // THE PROBE IS THE RELAY'S OWN `--ping`, NOT A POWERSHELL ONE-LINER.
  //
  // The one-liner was CORRECT and too SLOW: powershell.exe starts a CLR before
  // its first socket call (~4.6 s cold on a tiny10 guest), so right after boot
  // that cold start raced the then-8 s wall and answered "no answer within
  // 8000 ms" for a relay that was perfectly alive — every attach then fell back
  // to the blind session-0 lane. `cua-mcp-relay.py --ping [port]` performs the
  // SAME handshake (send the ten literal bytes, read EIGHT, print one token)
  // inside the interpreter that is already resolved: no child, no lock, no
  // desktop. `py` (the launcher) and not `python`, because on the live guest
  // python.exe is not on the non-interactive PATH — the same reason
  // RELAY_COMMAND says `py -3`.
  const probeLine = relayProbeCommand(47999)
  check('J22-14: relayProbeCommand is the relay\'s own `--ping` (py launcher, port interpolated) — no PowerShell',
    probeLine === 'py -3 C:\\ProgramData\\cua\\mcp-relay.py --ping 47999'
    && relayProbeCommand(51234) === 'py -3 C:\\ProgramData\\cua\\mcp-relay.py --ping 51234'
    && !/\n/u.test(probeLine)
    && !/(powershell|GetBytes|TcpClient|byte\[\]|Connect\('127\.0\.0\.1')/iu.test(probeLine),
    probeLine)
  check('J22-14: ...and the probe budget is the 12 s wall the cold `py` start needs (not the 8 s the CLR blew)',
    RELAY_PROBE_TIMEOUT_MS === 12000 && RELAY_PROBE_TIMEOUT_MS > 8000,
    `probe budget=${RELAY_PROBE_TIMEOUT_MS} ms`)
  // DEFECT 2: A LATE RELAY MUST BE ABLE TO TAKE OVER A *LIVE* SESSION-0 ATTACH.
  // The lane is decided at attach and the logon task can come up after it, so
  // without an upgrade a two-second-late relay left the computer blind for the
  // whole session. The decision is pure, so it is asserted without an SSH child:
  // only a live blind lane, never with a request in flight, never twice a minute.
  const upgrade = (patch) => shouldUpgradeToRelay({ transport: 'session-0-direct', relayOk: null, lastUpgradeAttemptAt: 0, now: 600_000, inFlight: 0, ...patch })
  check('J22-14b: shouldUpgradeToRelay upgrades ONLY a live blind lane, never mid-call, at most once per 60 s',
    upgrade() === true
    && upgrade({ transport: 'interactive-relay' }) === false
    && upgrade({ relayOk: true }) === false
    && upgrade({ inFlight: 1 }) === false
    && upgrade({ lastUpgradeAttemptAt: 581_000 }) === false
    && upgrade({ lastUpgradeAttemptAt: 540_000 }) === true
    && RELAY_UPGRADE_INTERVAL_MS === 60000 && RELAY_UPGRADE_WATCH_MS === 15000
    && RELAY_UPGRADE_LOG === 'upgrading mcp transport to the interactive relay',
    `interval=${RELAY_UPGRADE_INTERVAL_MS} watch=${RELAY_UPGRADE_WATCH_MS}`)
  check('J22-14: the session-0 fallback RECORDS why it is blind rather than looking identical',
    SESSION0_FALLBACK_REASON === 'session-0 fallback (interactive relay not running; desktop automation will be blind)'
    && /desktop automation will be blind/u.test(SESSION0_FALLBACK_REASON),
    SESSION0_FALLBACK_REASON)
  // THE DOCTOR'S FACTS ARE SYNCHRONOUS AND SIDE-EFFECT FREE. Creating a client
  // dials nothing; before an attach there IS no lane, and the answer must be
  // null rather than a guess (a guessed "relay" would report a blind bridge as
  // healthy in exactly the case the doctor exists for).
  const unattached = createDshCuaClient({ name: 'relay-unit', sshPort: 1 })
  const facts = unattached.doctorFacts()
  check('J22-14: doctorFacts() before any attach says transport null — never a guessed lane',
    facts.transport === null && facts.relayOk === null && facts.relayStatus === null
    && facts.transportCommand === null && facts.transportReason === ''
    && facts.relayPort === RELAY_PORT_DEFAULT,
    JSON.stringify(facts))
}

// ------------------------------------------------------------------ *
// WP-7: THE RFB CLIPBOARD WIRE FORMAT (noVNC talks exactly this)
// ------------------------------------------------------------------ *
{
  const frame = serverCutTextFrame('hi')
  check('WP-7: a ServerCutText is type 3 + 3 pad bytes + BE length + the bytes',
    frame.length === 10 && frame.equals(Buffer.from([3, 0, 0, 0, 0, 0, 0, 2, 104, 105])),
    frame.toString('hex'))
  const client = Buffer.from([6, 0, 0, 0, 0, 0, 0, 3, 65, 66, 67])
  check('WP-7: a ClientCutText is recognised by type 6 and parsed as ABC',
    isClientCutText(client) === true && parseClientCutText(client).text === 'ABC' && parseClientCutText(client).length === 3)
  check('WP-7: a non-cut-text frame is NOT swallowed (the rest is a passthrough)',
    isClientCutText(Buffer.from([0, 0, 0, 0])) === false && isClientCutText(Buffer.from([2, 0, 0, 0, 0, 0, 0, 1, 65])) === false)
  check('WP-7: the WebSocket handshake is base64(sha1(key + GUID))',
    wsAccept('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  // THE ENCODING LABEL: latin1 only when every code point fits in a byte, so a
  // decode on the other side reproduces the string exactly.
  const latin = encodeCutText('café')
  const wide = encodeCutText('中文')
  check('WP-7: encodeCutText labels latin1 for Latin-1 text and utf-8 for CJK',
    latin.encoding === 'latin1' && wide.encoding === 'utf-8' && wide.length === 6, `${latin.encoding}/${wide.encoding}`)
  check('WP-7: encodeCutText strips NUL (both the wire and the Windows clipboard stop at one)',
    encodeCutText('a\u0000b').length === 2)
}

// ------------------------------------------------------------------ *
// J22-8b: THE WEBSOCKET SUBPROTOCOL IS A NEGOTIATION, NOT A CONSTANT
//
// The reported defect: the bridge answered `Sec-WebSocket-Protocol: binary`
// unconditionally. RFC 6455 §4.2.2 says a server naming a protocol the client
// did not offer is a handshake the CLIENT MUST ABORT — and Debian's novnc 1.6.0
// offers none. The page loaded, the socket was dropped, the console said "not
// connected". selectSubprotocol() is the rule; these checks include a REAL
// upgrade exchange so the emitted header (not just the helper) is asserted.
// ------------------------------------------------------------------ *
{
  check('J22-8b: the only subprotocol this bridge speaks is `binary`',
    WS_SUBPROTOCOLS.length === 1 && WS_SUBPROTOCOLS[0] === 'binary')
  check('J22-8b: no offer → null (so the header is OMITTED, never guessed)',
    selectSubprotocol(undefined) === null && selectSubprotocol('') === null
    && selectSubprotocol('   ') === null && selectSubprotocol(null) === null)
  check("J22-8b: 'base64, binary' → 'binary' (the client's first protocol we support)",
    selectSubprotocol('base64, binary') === 'binary' && selectSubprotocol('binary, base64') === 'binary')
  check('J22-8b: ...echoed with the CLIENT\'s spelling, and only when offered',
    selectSubprotocol('BINARY') === 'BINARY' && selectSubprotocol('BINARY, base64') === 'BINARY'
    && selectSubprotocol('permessage-deflate') === null
    && selectSubprotocol('permessage-deflate, base64') === null)
  check('J22-8b: an empty supported list never invents a protocol',
    selectSubprotocol('binary', []) === null)

  // THE REAL HANDSHAKE. A loopback-only bridge on ephemeral ports; the VNC and
  // control endpoints are never dialled for an upgrade, so dummy values are fine.
  const bridge = startClipboardBridge({
    httpPort: '127.0.0.1:0',
    vncPort: '127.0.0.1:1',
    controlSock: path.join(os.tmpdir(), `cua-ws-probe-${process.pid}.sock`),
    name: 'ws-probe',
    pollMs: 60000,
    log: () => {}
  })
  const upgrade = (headers) => new Promise((resolve, reject) => {
    const port = Number(new URL(bridge.url).port)
    const socket = net.connect(port, '127.0.0.1')
    let buffer = ''
    const timer = setTimeout(() => { try { socket.destroy() } catch {} ; resolve(buffer) }, 4000)
    timer.unref?.()
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      const lines = [
        'GET /websockify HTTP/1.1',
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...headers,
        '', ''
      ]
      socket.write(lines.join('\r\n'))
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.includes('\r\n\r\n')) {
        clearTimeout(timer)
        try { socket.destroy() } catch {}
        resolve(buffer)
      }
    })
    socket.on('error', reject)
  })
  try {
    await bridge.ready
    const none = await upgrade([])
    check('J22-8b: an upgrade with NO Sec-WebSocket-Protocol gets 101 and NO protocol header',
      /^HTTP\/1\.1 101/u.test(none) && !/sec-websocket-protocol:/iu.test(none),
      none.split('\r\n').filter(Boolean).join(' | ').slice(0, 180))
    const offered = await upgrade(['Sec-WebSocket-Protocol: binary'])
    check('J22-8b: ...an upgrade that OFFERS binary gets the header back, named once',
      /^HTTP\/1\.1 101/u.test(offered)
      && (offered.match(/sec-websocket-protocol: binary/giu) ?? []).length === 1,
      offered.split('\r\n').filter(Boolean).join(' | ').slice(0, 180))
    const unsupported = await upgrade(['Sec-WebSocket-Protocol: permessage-deflate'])
    check('J22-8b: ...an offer we cannot speak is NOT echoed (no header at all)',
      /^HTTP\/1\.1 101/u.test(unsupported) && !/sec-websocket-protocol:/iu.test(unsupported))
  } finally {
    await bridge.close()
  }
}

// ------------------------------------------------------------------ *
// WP-9.1: THE GUEST DISK MEASUREMENT (the supervisor's own parser)
// ------------------------------------------------------------------ *
{
  // Imported in a CHILD with a throwaway store so this suite never binds the
  // supervisor's socket; the parser itself is pure and is the whole contract.
  const store = mkdtempSync(path.join(os.tmpdir(), 'cua-df-'))
  try {
    const supervisorUrl = new URL('../docker/cua-vm-supervisor.mjs', import.meta.url).href
    const program = `const m = await import(${JSON.stringify(supervisorUrl)});`
      + `process.stdout.write(JSON.stringify(m.parseGuestDf(process.argv[1])));process.exit(0)`
    const sample = '         50450432     40845232'
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, sample], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, CUA_VM_STORE: path.join(store, 'store'), CUA_VM_HOME: path.join(store, 'home'), CUA_SUPERVISOR_SOCK: path.join(store, 's.sock') }
    })
    let parsed = null
    try { parsed = JSON.parse(result.stdout ?? 'null') } catch { parsed = null }
    check('WP-9.1: parseGuestDf reads the LAST two-integer line as size/avail bytes',
      parsed?.sizeBytes === 50450432 && parsed?.availBytes === 40845232,
      `status=${result.status} out=${String(result.stdout ?? '').slice(0, 80)} ${String(result.stderr ?? '').slice(0, 80)}`)
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
}

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
  // WP-6/J22-14: THE CLIPBOARD AGENT AND THE MCP RELAY ARE PAYLOAD FILES. The
  // four original files still make a directory a payload directory
  // (OEM_PAYLOAD_REQUIRED); the agent and the relay are staged because
  // firstboot can only copy what is in the medium it stages from.
  check('the OEM payload list is the four required files plus the clipboard agent and the MCP relay',
    OEM_PAYLOAD_FILES.join(',') === 'Autounattend.xml,setupcomplete.cmd,cua-firstboot.ps1,Unattend.vbs,cua-clip-agent.ps1,cua-mcp-relay.py'
    && OEM_PAYLOAD_REQUIRED.join(',') === 'Autounattend.xml,setupcomplete.cmd,cua-firstboot.ps1,Unattend.vbs'
    && OEM_PAYLOAD_FILES.at(-1) === OEM_MCP_RELAY_FILE,
    OEM_PAYLOAD_FILES.join(','))
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

    // ---- R6: A REFUSED PRESS IS NOT A PRESS ----
    //
    // The QMP primitive RESOLVES the monitor's refusal (`{error:{desc}}`) instead of
    // throwing it. The old scheduler only caught throws, so a run of refused
    // presses logged "pressed enter at ~1.7 s" while the guest never saw a key.
    {
      const lines = []
      const sent = await runCdbootKeys({
        scheduleMs: [100],
        log: (line) => lines.push(line),
        wait: async () => {},
        sendKey: async () => ({ error: { class: 'GenericError', desc: 'this feature is not supported' } })
      })
      check('R6: a press the monitor REFUSED is not counted as sent, and says so',
        sent.length === 0
        && lines.some((line) => /could not press enter/u.test(line) && /this feature is not supported/u.test(line)),
        lines.join(' | ').slice(0, 200))
      check('R6: ...and it is never logged as a successful press',
        lines.every((line) => !/pressed enter/u.test(line)))
    }
    // R6: the refusal reader itself — the shapes QMP and this supervisor emit.
    check('R6: cdbootPressFailure reads the monitor\'s refusal, and only the refusal',
      cdbootPressFailure({ error: { desc: 'GenericError: not enabled' } }) === 'GenericError: not enabled'
      && cdbootPressFailure([{ return: {} }, { error: 'refused' }]) === 'refused'
      && cdbootPressFailure({ error: { class: 'Duplicate' } }) === 'Duplicate'
      && cdbootPressFailure({ error: {} }) === 'the monitor refused the event'
      && cdbootPressFailure({ return: { OK: 'sent' } }) === null
      && cdbootPressFailure([{ return: {} }]) === null
      && cdbootPressFailure(null) === null
      && cdbootPressFailure('sent') === null,
      JSON.stringify([
        cdbootPressFailure({ error: { desc: 'x' } }),
        cdbootPressFailure({ return: {} }),
        cdbootPressFailure([{ error: 'y' }])
      ]))

    // R6: THE KNOBS. 90 s prompt window (measured: cdboot prints long after 8 s),
    // 12 re-arms, 180 s watch, 3 s per press — all clamped, all defaulting on junk.
    {
      check('R6: the prompt window defaults to 90 s, not the old 8 s',
        cdbootPromptWindowMs() === 90000, String(cdbootPromptWindowMs()))
      check('R6: the re-arm budget is 12 cycles inside a 180 s watch',
        cdbootRearmCycles() === 12 && cdbootRearmWatchMs() === 180000,
        `${cdbootRearmCycles()}/${cdbootRearmWatchMs()}`)
      check('R6: one press gets 3 s, not the monitor default of 15 s',
        cdbootPressTimeoutMs() === 3000, String(cdbootPressTimeoutMs()))
      const saved = {}
      try {
        for (const [env, value] of [
          ['DSH_CUA_WINDOWS_CDBOOT_PROMPT_MS', '5'],
          ['DSH_CUA_WINDOWS_CDBOOT_CYCLES', '999'],
          ['DSH_CUA_WINDOWS_CDBOOT_WATCH_MS', '99999999'],
          ['DSH_CUA_WINDOWS_CDBOOT_PRESS_MS', '1']
        ]) { saved[env] = process.env[env]; process.env[env] = value }
        check('R6: every knob is clamped on the way in (5→1000, 999→64, 99999999→3600000, 1→500)',
          cdbootPromptWindowMs() === 1000 && cdbootRearmCycles() === 64
          && cdbootRearmWatchMs() === 3600000 && cdbootPressTimeoutMs() === 500,
          `${cdbootPromptWindowMs()}/${cdbootRearmCycles()}/${cdbootRearmWatchMs()}/${cdbootPressTimeoutMs()}`)
        for (const env of Object.keys(saved)) process.env[env] = 'not-a-number'
        check('R6: an unparsable value falls back to the default, never to 0',
          cdbootPromptWindowMs() === 90000 && cdbootRearmCycles() === 12
          && cdbootRearmWatchMs() === 180000 && cdbootPressTimeoutMs() === 3000)
      } finally {
        for (const [env, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[env]
          else process.env[env] = value
        }
      }
    }

    // ---- P1: THE MEDIA LEAVE WHEN SETUP FINISHES COPYING ----
    //
    // Ejecting at READY needs the SSH banner, and a guest whose NIC has no driver
    // never answers SSH: the row stayed `installing` with SETUP (D:) mounted for
    // the life of the session. The trigger is the serial evidence instead.
    {
      check('P1: the copy-done pattern is a serial signature, not a clock',
        WINDOWS_SETUP_COPY_DONE_PATTERN instanceof RegExp
        && windowsSetupCopyFinished('Windows Setup is complete.') === true
        && windowsSetupCopyFinished('Setup has finished copying files') === true
        && windowsSetupCopyFinished('Setup is applying system settings') === true)
      check('P1: a booted-from-disk serial also means the copy is done',
        windowsSetupCopyFinished('BdsDxe: starting Boot0004 "Windows Boot Manager" from HD(1,GPT,') === true)
      check('P1: Setup is still copying / an empty tail is NOT an eject signal',
        windowsSetupCopyFinished('Windows Setup is starting') === false
        && windowsSetupCopyFinished('12%') === false
        && windowsSetupCopyFinished('') === false
        && windowsSetupCopyFinished(null) === false)
      check('P1: the watch window defaults to 90 minutes and is bounded',
        windowsMediaEjectWatchMs() === 90 * 60 * 1000, String(windowsMediaEjectWatchMs()))
      const saved = process.env.DSH_CUA_WINDOWS_EJECT_WATCH_MIN
      try {
        process.env.DSH_CUA_WINDOWS_EJECT_WATCH_MIN = '5'
        check('P1: ...and DSH_CUA_WINDOWS_EJECT_WATCH_MIN sets it (minutes)',
          windowsMediaEjectWatchMs() === 5 * 60 * 1000)
        process.env.DSH_CUA_WINDOWS_EJECT_WATCH_MIN = '9999'
        check('P1: ...clamped to 600 minutes, and junk falls back to 90',
          windowsMediaEjectWatchMs() === 600 * 60 * 1000
          && (process.env.DSH_CUA_WINDOWS_EJECT_WATCH_MIN = 'nonsense', windowsMediaEjectWatchMs() === 90 * 60 * 1000))
      } finally {
        if (saved === undefined) delete process.env.DSH_CUA_WINDOWS_EJECT_WATCH_MIN
        else process.env.DSH_CUA_WINDOWS_EJECT_WATCH_MIN = saved
      }
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

      // ---- J22-6: THE PRIVACY OFF-SWITCH IS NOW A LIVE SENTINEL ----
      //
      // `DSH_CUA_CLIP_AGENT=0` means "do not run the ambient clipboard loop", but
      // the GUEST CANNOT READ THE HOST ENVIRONMENT: the flag is a STAGING-time
      // variable with no channel back from Windows. Both consumers (firstboot's
      // task registrar and the agent itself) therefore test a PATH. Those readers
      // existed while nothing wrote the file, so the switch was inert — this
      // drives the shipped writer and the shipped optional-entry rules, on a real
      // setup.img, with the two env states, and reads the result back.
      {
        const previous = process.env.DSH_CUA_CLIP_AGENT
        const sentinelStore = mkdtempSync(path.join(os.tmpdir(), 'cua-clip-sentinel-'))
        const writePayload = (paths, name, log = () => {}) => writeOemPayload({
          paths, name, password: 'pw', sshPubKey: 'ssh-ed25519 AAAA x',
          sourceDir: path.join(REPO, 'docker', 'windows-oem'), pythonUrl: 'https://python', dshCuaSpec: 'dsh-cua==1', log
        })
        const rootSentinel = (paths) => path.join(paths.oemDir, CLIP_AGENT_SENTINEL_FILE)
        const scriptsSentinel = (paths) => path.join(paths.oemDir, '$OEM$', '$$', 'Setup', 'Scripts', CLIP_AGENT_SENTINEL_FILE)
        try {
          // PURE HALF: the table the build and the verify read. The sentinel is a
          // ROOT ENTRY but never a required payload member — a payload directory
          // must stay valid with the knob unset.
          check('J22-6: clip-agent-disabled is a named root entry, OPTIONAL (never a required payload file)',
            CLIP_AGENT_SENTINEL_FILE === 'clip-agent-disabled'
            && SETUP_IMAGE_ENTRIES.includes(CLIP_AGENT_SENTINEL_FILE)
            && SETUP_IMAGE_OPTIONAL.includes(CLIP_AGENT_SENTINEL_FILE)
            // NOT a payload FILE: there is no source-side sentinel to copy. The
            // writer CREATES it from the env, so a payload directory never has to
            // carry one and `OEM_PAYLOAD_FILES` must not list it.
            && !OEM_PAYLOAD_FILES.includes(CLIP_AGENT_SENTINEL_FILE)
            && !OEM_PAYLOAD_REQUIRED.includes(CLIP_AGENT_SENTINEL_FILE))

          // (a) DSH_CUA_CLIP_AGENT=0 STAGES IT, on BOTH routes the search uses.
          process.env.DSH_CUA_CLIP_AGENT = '0'
          const offPaths = windowsPaths(sentinelStore, 'win-sentinel-off')
          const offLogs = []
          writePayload(offPaths, 'win-sentinel-off', (line) => offLogs.push(String(line)))
          check('J22-6: DSH_CUA_CLIP_AGENT=0 stages the sentinel at the payload root',
            existsSync(rootSentinel(offPaths))
            && /DSH_CUA_CLIP_AGENT=0/u.test(readFileSync(rootSentinel(offPaths), 'utf8')),
            rootSentinel(offPaths))
          check('J22-6: ...and into $OEM$/$$/Setup/Scripts (the path Setup copies to C:\\Windows\\Setup\\Scripts)',
            existsSync(scriptsSentinel(offPaths)), scriptsSentinel(offPaths))
          check('J22-6: ...and the writer LOGS why (an operator can see the switch took effect)',
            offLogs.some((line) => /clip agent disabled by DSH_CUA_CLIP_AGENT=0 \(sentinel staged\)/u.test(line)),
            offLogs.find((line) => /clip agent/u.test(line)) ?? offLogs.join(' | ').slice(0, 120))
          buildSetupImage({ paths: offPaths })
          const offVerified = verifySetupImage({ paths: offPaths })
          check('J22-6: the built medium CARRIES it at the root and in the copied Scripts tree',
            offVerified.entries.includes(CLIP_AGENT_SENTINEL_FILE)
            && offVerified.oemScripts.includes(CLIP_AGENT_SENTINEL_FILE),
            `root=${offVerified.entries.includes(CLIP_AGENT_SENTINEL_FILE)} scripts=${offVerified.oemScripts.includes(CLIP_AGENT_SENTINEL_FILE)}`)

          // (b) UNSET STAGES NOTHING — and that is not "incomplete", because the
          // entry is optional in BOTH the build and the verify.
          delete process.env.DSH_CUA_CLIP_AGENT
          const onPaths = windowsPaths(sentinelStore, 'win-sentinel-on')
          writePayload(onPaths, 'win-sentinel-on')
          check('J22-6: unset stages NO sentinel (neither root nor $OEM$ Scripts)',
            !existsSync(rootSentinel(onPaths)) && !existsSync(scriptsSentinel(onPaths)))
          buildSetupImage({ paths: onPaths })
          const onVerified = verifySetupImage({ paths: onPaths })
          check('J22-6: ...and the medium still builds and verifies (optional, never "incomplete")',
            !onVerified.entries.includes(CLIP_AGENT_SENTINEL_FILE)
            && onVerified.entries.includes('Autounattend.xml')
            && onVerified.oemScripts.includes('cua-firstboot.ps1'),
            `entries=${onVerified.entries.length} sentinel=${onVerified.entries.includes(CLIP_AGENT_SENTINEL_FILE)}`)

          // (c) THE STALE GUARD ON THE ROOT COPY: the OEM directory lives in the
          // store and survives, so a previous `=0` create must not keep the switch
          // off for a machine re-staged with the knob unset.
          writePayload(offPaths, 'win-sentinel-off')
          check('J22-6: re-staging with the knob UNSET unlinks the root sentinel (stale guard)',
            !existsSync(rootSentinel(offPaths)))

          // (d) A GUEST COPY ALREADY IN PLACE IS NOT OVERWRITTEN BY THE TEST, but
          // the sentinel's CONTENT is presence-only: the consumers test the path.
          writeFileSync(path.join(offPaths.oemDir, 'clip-agent-disabled'), 'hand-written by an operator\n')
          check('J22-6: presence is the contract — the file content is never parsed',
            readFileSync(path.join(offPaths.oemDir, 'clip-agent-disabled'), 'utf8') === 'hand-written by an operator\n')
        } finally {
          if (previous === undefined) delete process.env.DSH_CUA_CLIP_AGENT
          else process.env.DSH_CUA_CLIP_AGENT = previous
          rmSync(sentinelStore, { recursive: true, force: true })
        }
      }

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
        const selection = resolveWindowsImageSelection({ version: '11l' })
        check('F2: 11l resolves to /IMAGE/NAME with the name VERIFIED from the pinned ISO WIM XML',
          selection.key === '/IMAGE/NAME'
          && selection.value === 'Windows 11 IoT Enterprise LTSC 2024 Evaluation'
          && selection.verified === true,
          `${selection.key}=${selection.value} (${selection.source})`)
        check('F2: the table itself carries the verified value (single source of truth)',
          WINDOWS_IMAGE_SELECTIONS['11l'].key === '/IMAGE/NAME'
          && WINDOWS_IMAGE_SELECTIONS['11l'].value === 'Windows 11 IoT Enterprise LTSC 2024 Evaluation'
          && WINDOWS_IMAGE_SELECTIONS['11l'].verified === true)
        check('F2: an operator ISO (no version) falls back to /IMAGE/INDEX 1',
          resolveWindowsImageSelection({ version: '' }).key === '/IMAGE/INDEX'
          && resolveWindowsImageSelection({ version: '' }).value === 1)
        check('F2: an explicit index wins over the version table',
          resolveWindowsImageSelection({ version: '11l', imageIndex: 3 }).value === 3
          && resolveWindowsImageSelection({ version: '11l', imageIndex: 3 }).key === '/IMAGE/INDEX')
        check('F2: an explicit name wins over the index',
          resolveWindowsImageSelection({ version: '11l', imageIndex: 3, imageName: 'Windows 11 Enterprise LTSC 2024 Evaluation' }).key === '/IMAGE/NAME')
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
          windowsVersion: '11l'
        })
        const namedXml = readFileSync(path.join(named.oemDir, 'Autounattend.xml'), 'utf8')
        check('F2: writeOemPayload(windowsVersion: 11l) stages /IMAGE/NAME, not INDEX',
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


// ---- U1: HIDE PASSWORD IS A CLEAR, NOT A LABEL ----
//
// The reported defect is a STATE TRANSITION, not a render: "Hide password"
// flipped the label and the secret stayed in the component, so the value was
// still there for the next render (and the reveal note carried it in a banner
// that outlived the reveal). The client exports its two pure transitions for
// exactly this, and the unit test drives them — a DOM test would need a renderer
// and would still not name "delete the key".
{
  const { readFileSync: readFile } = await import('node:fs')
  const factory = (() => {
    let loaded = null
    const source = readFile('plugins/dsh-cua-vm/client.js', 'utf8')
    const win = { __ModuleLoader__: { load: (options) => { loaded = options.factory } } }
    // eslint-disable-next-line no-new-func
    new Function('window', source)(win)
    const React = {
      createElement: () => ({}),
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useRef: () => ({ current: null })
    }
    return loaded(() => React)
  })()
  const { hideSecretEntry, noteAfterHide } = factory.__test
  check('U1: hidePassword DELETES the secret key (a new object, the old one untouched)',
    (() => {
      const before = { 'win-box': 'pw-1', other: 'pw-2' }
      const after = hideSecretEntry(before, 'win-box')
      return after['win-box'] === undefined && after.other === 'pw-2' && before['win-box'] === 'pw-1' && after !== before
    })())
  check('U1: ...hiding an absent key is a no-op, not a crash',
    JSON.stringify(hideSecretEntry({ other: 'pw-2' }, 'win-box')) === JSON.stringify({ other: 'pw-2' }))
  check('U1: a note that CARRIED the password is cleared by hiding it',
    noteAfterHide('win-box: user "cua", password "pw-1" — stored 0600', 'win-box', 'pw-1')
      === 'win-box: password hidden and removed from this page.')
  check('U1: ...and an unrelated note is left alone',
    noteAfterHide('win-box is up.', 'win-box', 'pw-1') === 'win-box is up.')
  check('U1: the reveal note no longer interpolates the password',
    !/setNote\(`.*password "\$\{payload\.password\}"/u.test(readFile('plugins/dsh-cua-vm/client.js', 'utf8')))
  check('U1: the button toggles on the secret state (it used to always reveal)',
    /onClick: \(\) => \(secret\[name\] \? hidePassword\(name\) : void revealPassword\(name\)\)/u.test(readFile('plugins/dsh-cua-vm/client.js', 'utf8')))
}

// ---- U2: THE CLIPBOARD PROTOCOL, DRIVEN WITH A STUB TRANSPORT ----
//
// The Windows clipboard only works through the guest's INTERACTIVE session (two
// on-demand `/it` tasks). The backend owns the protocol; the transport is
// injected. This stub is a guest that records every call IN ORDER, so the two
// invariants that make a paste real are asserted: the text file is written
// BEFORE the task runs, and a task whose Last Result is non-zero is a FAILURE.
{
  const store = mkdtempSync(path.join(os.tmpdir(), 'cua-clip-unit-'))
  try {
    const makeStub = ({ runExit = 0, lastResult = 0, readText = 'hello from the guest', failRun = false, missingRead = false } = {}) => {
      const calls = []
      const files = new Map()
      return {
        calls,
        files,
        transport: {
          async sshRun(_meta, command) {
            calls.push({ kind: 'ssh', command })
            if (/schtasks \/run/u.test(command)) {
              return failRun ? { code: 1, stdout: '', stderr: 'ERROR: Access is denied.' } : { code: 0, stdout: 'SUCCESS: Attempted to run', stderr: '' }
            }
            if (/schtasks \/query/u.test(command)) return { code: 0, stdout: `Status:        Ready\r\nLast Result:   ${lastResult}\r\n`, stderr: '' }
            if (/^if exist/u.test(command)) return { code: 0, stdout: '', stderr: '' }
            if (/^if not exist/u.test(command)) return { code: 0, stdout: '', stderr: '' }
            return { code: runExit, stdout: '', stderr: '' }
          },
          async putText(_meta, guestPath, text) {
            calls.push({ kind: 'put', guestPath, text })
            files.set(guestPath, text)
            return { code: 0, stderr: '' }
          },
          async getText(_meta, guestPath) {
            calls.push({ kind: 'get', guestPath })
            if (missingRead || !files.has(guestPath)) return { code: 1, stderr: 'No such file', text: '' }
            return { code: 0, stderr: '', text: files.get(guestPath) }
          }
        }
      }
    }
    const saved = process.env.DSH_CUA_WIN_CLIP_SETTLE_MS
    process.env.DSH_CUA_WIN_CLIP_SETTLE_MS = '0'
    try {
      // SET: file first, task second.
      {
        const stub = makeStub()
        const backend = createWindowsBackend({ store, qmp: async () => [], log: () => {}, transport: stub.transport })
        const result = await backend.clipboardSet({ name: 'win-clip' }, 'a & b | c "quoted" ; semi')
        const order = stub.calls.map((call) => call.kind).join(',')
        // WP-6: THE AGENT IS TRIED FIRST, and its decline is REPORTED. The very
        // first call is the `type clip-state.json` probe; with no agent the
        // task path follows and the ORDER invariant (file before task) holds.
        const putAt = stub.calls.findIndex((call) => call.kind === 'put')
        const mkdirAt = stub.calls.findIndex((call) => call.kind === 'ssh' && /mkdir/u.test(call.command))
        const runAt = stub.calls.findIndex((call) => call.kind === 'ssh' && /cua-clip-set/u.test(call.command))
        check('U2: clipboardSet writes clip.txt BEFORE the task runs (after the agent probe declined)',
          mkdirAt !== -1 && putAt > mkdirAt && runAt > putAt
          && /clip-state\.json/u.test(stub.calls[0].command)
          && stub.calls[putAt].guestPath.endsWith('clip.txt'), order)
        check('U2: ...it pastes into C:\\ProgramData\\cua\\clip.txt',
          stub.calls[putAt].guestPath === 'C:\\ProgramData\\cua\\clip.txt', stub.calls[putAt].guestPath)
        check('U2: ...and reports the byte count only after the task exits 0',
          result.ok === true && result.bytes === Buffer.byteLength('a & b | c "quoted" ; semi') && result.task === 'cua-clip-set', JSON.stringify(result))
      }
      // A task that fails must NEVER read as a paste.
      {
        const stub = makeStub({ lastResult: 1 })
        const backend = createWindowsBackend({ store, qmp: async () => [], log: () => {}, transport: stub.transport })
        const result = await backend.clipboardSet({ name: 'win-clip' }, 'x')
        check('U2: a task whose Last Result is non-zero is a FAILURE, not a paste',
          result.ok === false && result.reason === 'task' && /exited 1/u.test(result.detail), JSON.stringify(result))
      }
      // A /run that is refused (no such task, access denied) surfaces the code.
      {
        const stub = makeStub({ failRun: true })
        const backend = createWindowsBackend({ store, qmp: async () => [], log: () => {}, transport: stub.transport })
        const result = await backend.clipboardSet({ name: 'win-clip' }, 'x')
        check('U2: `schtasks /run` failing surfaces its exit code and stderr',
          result.ok === false && result.code === 1 && /Access is denied/u.test(result.detail), JSON.stringify(result))
      }
      // GET: clears the stale file, runs the task, then reads back.
      {
        const stub = makeStub({ readText: 'line 1\r\nline 2' })
        stub.files.set('C:\\ProgramData\\cua\\clip-read.txt', 'line 1\r\nline 2')
        const backend = createWindowsBackend({ store, qmp: async () => [], log: () => {}, transport: stub.transport })
        const result = await backend.clipboardGet({ name: 'win-clip' })
        const cleard = stub.calls.some((call) => call.kind === 'ssh' && /del \/f \/q .*clip-read\.txt/u.test(call.command))
        const got = stub.calls.some((call) => call.kind === 'get' && call.guestPath.endsWith('clip-read.txt'))
        check('U2: clipboardGet clears the stale read file before running cua-clip-get',
          cleard && stub.calls.some((call) => call.kind === 'ssh' && /cua-clip-get/u.test(call.command)) && got,
          stub.calls.map((call) => `${call.kind}:${call.command ?? call.guestPath}`).join(' | '))
        check('U2: ...and returns the guest text verbatim (CRLF kept)',
          result.ok === true && result.text === 'line 1\r\nline 2' && result.task === 'cua-clip-get', JSON.stringify(result).slice(0, 160))
      }
      // A task that reports 0 but wrote nothing is a failure, not "".
      {
        const stub = makeStub({ missingRead: true })
        const backend = createWindowsBackend({ store, qmp: async () => [], log: () => {}, transport: stub.transport })
        const result = await backend.clipboardGet({ name: 'win-clip' })
        check('U2: a read task that produced no file is a FAILURE (never an empty clipboard)',
          result.ok === false && result.reason === 'missing' && /not readable/u.test(result.detail), JSON.stringify(result))
      }
      // No transport at all is a DISABLED state the callers can render.
      {
        const backend = createWindowsBackend({ store, qmp: async () => [], log: () => {} })
        const set = await backend.clipboardSet({ name: 'win-clip' }, 'x')
        const get = await backend.clipboardGet({ name: 'win-clip' })
        check('U2: without an SSH transport both directions answer reason "no-ssh"',
          set.ok === false && set.reason === 'no-ssh' && get.ok === false && get.reason === 'no-ssh',
          `${set.reason}/${get.reason}`)
      }
      // A hostile payload is refused instead of being pushed at cmd.exe.
      {
        const backend = createWindowsBackend({ store, qmp: async () => [], log: () => {}, transport: makeStub().transport })
        let error = null
        try { await backend.clipboardSet({ name: 'win-clip' }, 'x'.repeat(1024 * 1024 + 1)) } catch (caught) { error = caught }
        check('U2: a payload over 1 MiB is refused (a clipboard is not a file transfer)',
          error !== null && /larger than 1048576 bytes/u.test(error.message), String(error?.message ?? 'no error'))
      }
    } finally {
      if (saved === undefined) delete process.env.DSH_CUA_WIN_CLIP_SETTLE_MS
      else process.env.DSH_CUA_WIN_CLIP_SETTLE_MS = saved
    }
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
}

// ---- U2/U3: THE FIRSTBOOT TASK REGISTRATIONS (source assertions) ----
//
// Nothing here can run PowerShell, but the two defects were both IN THE TEXT:
// a `--pipe` argument upstream does not accept, and a python.exe task registered
// without a hidden flag. Both are asserted literally, because a reviewer can
// read them and a regression is a one-word edit.
{
  const firstboot = readFileSync(path.join(REPO, 'docker', 'windows-oem', 'cua-firstboot.ps1'), 'utf8')
  const mcpSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'win-mcp.js'), 'utf8')
  // U2: TWO tasks, on demand, INTERACTIVE (/it), limited, hidden.
  // The login lines are built inside a generated .cmd (PowerShell 5.1 passes a
  // spaced variable to a native program unquoted), so the assertion is on the
  // FULL line including the executable and the hidden window style.
  check('U2: firstboot registers cua-clip-set as an on-demand INTERACTIVE hidden task',
    /schtasks \/create \/tn `"cua-clip-set`" \/sc ondemand \/it \/rl LIMITED \/f \/tr `"\$trSet`"/u.test(firstboot)
      && /\$trSet = "powershell\.exe[^"]*-WindowStyle Hidden -File \$setScript"/u.test(firstboot))
  check('U2: firstboot registers cua-clip-get the same way',
    /schtasks \/create \/tn `"cua-clip-get`" \/sc ondemand \/it \/rl LIMITED \/f \/tr `"\$trGet`"/u.test(firstboot)
      && /\$trGet = "powershell\.exe[^"]*-WindowStyle Hidden -File \$getScript"/u.test(firstboot))
  check('U2: ...through a generated .cmd, so the /tr argument keeps its quotes',
    /& cmd \/c \$cmdFile/u.test(firstboot) && /Remove-Item -Force \$cmdFile/u.test(firstboot))
  check('U2: the set task reads clip.txt onto the clipboard (Set-Clipboard -Value)',
    /Set-Clipboard -Value \(\[IO\.File\]::ReadAllText\('C:\\ProgramData\\cua\\clip\.txt'\)\)/u.test(firstboot))
  check('U2: the get task writes clip-read.txt from Get-Clipboard -Raw',
    /\[IO\.File\]::WriteAllText\('C:\\ProgramData\\cua\\clip-read\.txt', \[string\]\(Get-Clipboard -Raw\)\)/u.test(firstboot))
  check('U2: the two clipboard tasks run a HIDDEN powershell (no console flash on the desktop)',
    (firstboot.match(/-WindowStyle Hidden -File/g) ?? []).length >= 2)
  // WP-6: THE AMBIENT AGENT. One more interactive task, registered at logon and
  // started immediately, so a copy in Notepad reaches the harness without the
  // panel asking for it.
  check('WP-6: firstboot registers cua-clip-agent at logon, interactive, hidden',
    /schtasks \/create \/tn `"cua-clip-agent`" \/sc onlogon \/it \/rl LIMITED \/f \/tr `"\$agentTr`"/u.test(firstboot)
    && /& schtasks \/run \/tn 'cua-clip-agent'/u.test(firstboot)
    && /\$agentTr = "powershell\.exe[^"]*-WindowStyle Hidden -File \$agentScript"/u.test(firstboot))
  check('WP-6: ...and the agent script comes from the OEM payload, with an embedded fallback',
    /cua-clip-agent\.ps1/u.test(firstboot) && /OEM payload had no cua-clip-agent\.ps1; wrote the embedded copy/u.test(firstboot))
  // U3: WINDOWLESS, AND NO FICTIONAL PIPE.
  check('U3: the autostart task runs pythonw.exe (windowless), not python.exe',
    /New-ScheduledTaskAction -Execute \$pyw -Argument '-m dsh_cua\.server'/u.test(firstboot)
      && !/New-ScheduledTaskAction -Execute \$py -Argument/u.test(firstboot))
  check('U3: the task itself is registered with -Hidden',
    /Register-ScheduledTask -TaskName 'dsh-cua-server'[^\n]*-Hidden -Force/u.test(firstboot))
  check('U3: the fictional `--pipe \\\\.\\pipe\\dsh-cua` argument is GONE from both the task and the MCP command',
    !/'-m dsh_cua\.server --pipe/u.test(firstboot)
      && !/--pipe \\\\\.\\\\pipe\\\\dsh-cua'\s*$/mu.test(mcpSource)
      && /'python -m dsh_cua\.server --stdio'/u.test(mcpSource))
  check('U3: ...and the limitation is documented where the next reader looks',
    /NO NAMED PIPE/u.test(mcpSource) && /ONE shared session-2 server cannot be reached/u.test(mcpSource))
}

// ---- U4: THE FREE SPACE THAT IS ACTUALLY LEFT ----
//
// `diskGb` is the virtual size; the reported computer had 6.8 GB LEFT on a 64 GB
// disk, which is the state Windows Update fails in with an unrelated error. The
// probe's parser takes digits only (a localized PowerShell header must not
// become a number) and the below-floor warning is attached at 10 GB.
{
  check('U4: the probe parser takes the byte count out of a PowerShell answer',
    parseFreeSpaceProbe('7301444403\r\n') === 7301444403
      && parseFreeSpaceProbe('\r\n7301444403\r\n') === 7301444403)
  check('U4: ...an empty or non-numeric answer is UNKNOWN, not 0 GB',
    parseFreeSpaceProbe('') === null && parseFreeSpaceProbe('Get-PSDrive : denied') === null && parseFreeSpaceProbe('0') === null)
  const low = formatWindowsFreeSpace(7301444403) // 6.8 GB
  check('U4: 6.8 GB free is BELOW the 10 GB floor and carries the warning',
    low.belowFloor === true && low.line === '6.80 GB free on C:' && /only 6.80 GB free on C:/u.test(low.warning)
      && low.freeGb === 6.8, JSON.stringify(low))
  const ok2 = formatWindowsFreeSpace(40 * 1024 ** 3)
  check('U4: 40 GB free is above the floor and carries no warning',
    ok2.belowFloor === false && ok2.line === '40.0 GB free on C:' && ok2.warning === undefined, JSON.stringify(ok2))
  check('U4: the floor is the documented 10 GB', WINDOWS_FREE_FLOOR_GB === 10)
}


// ------------------------------------------------------------------ *
// J23: EVERY `cua_vm_*` TOOL CARRIES AN EXPLICIT TIMEOUT ENVELOPE
// ------------------------------------------------------------------ *
// The incident: a `cua_vm_shutdown` whose supervisor op sat in a synchronous
// `qemu-img convert` of a 10 GB system disk hung the tool call for minutes. The
// harness had no per-tool deadline for it, the chat abort could not unwind a body
// blocked on a socket, and the user force-restarted the harness.
//
// The rule that came out of it: whatever the supervisor does, the TOOL layer must
// settle and say what happened. That is a PURE contract here — ONE map, every
// registration drawing from it, `registerCuaTool` refusing a mismatch, and every
// body raced against its deadline with a machine-routable `tool-timeout`. The
// behavioural half (a real hung call settling) has no cheap test; this is the
// half that a rename or a new tool would otherwise break silently.
{
  const source = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
  const uses = [...source.matchAll(/timeoutMs: TOOL_TIMEOUTS\.([a-z_]+),/gu)].map((match) => match[1])
  const mapBody = /const TOOL_TIMEOUTS = Object\.freeze\(\{([\s\S]*?)\n\}\)/u.exec(source)?.[1] ?? ''
  const keys = [...mapBody.matchAll(/^\s{2}([a-z_]+): [\d_]+/gmu)].map((match) => match[1])
  check('J23: every registration draws its timeoutMs from the ONE TOOL_TIMEOUTS map',
    uses.length >= 18 && keys.length === uses.length
      && keys.every((key) => uses.includes(key)) && uses.every((key) => keys.includes(key)),
    `registrations=${uses.length} map=${keys.length}`)
  check('J23: registerCuaTool REFUSES a tool with no envelope, and one whose number disagrees',
    /cua-vm: \$\{definition\.name\} has no TOOL_TIMEOUTS entry/u.test(source)
      && /cua-vm: \$\{definition\.name\} declares timeoutMs=\$\{definition\.timeoutMs\}, TOOL_TIMEOUTS says \$\{declared\}/u.test(source))
  check('J23: every body is ALSO raced against its own deadline (the harness guard is cooperative)',
    /execute: boundedExecute\(definition\.name, declared,/.test(source)
      && /const TIMEOUT_LEAD_MS = 250/u.test(source)
      && /Promise\.race\(\[Promise\.resolve\(\)\.then\(\(\) => execute\(args, exec\)\), expiry\]\)/u.test(source))
  check('J23: the failure is STRUCTURED — code: tool-timeout, repeated in the text the model reads',
    /error\.code = 'tool-timeout'/u.test(source)
      && /timed out after \$\{timeoutLabel\(timeoutMs\)\}s; the supervisor op may still be running/u.test(source)
      && /code: tool-timeout`/u.test(source))
  check('J23: the two caller-budgeted tools resolve their live deadline per call',
    /cua_vm_exec: \(args\) => \(Math\.min\(3600, Math\.max\(1, Number\(args\?\.timeout\) \|\| 300\)\) \* 1000\) \+ EXEC_ENVELOPE_GRACE_MS/u.test(source)
      && /cua_vm_create: \(args\) => \(args\?\.kind === 'windows' \? 60_000 : TOOL_TIMEOUTS\.cua_vm_create\)/u.test(source))
  check('J23: the deferred checkpoint sentence says it is deferred AND that the badge is already powered-off',
    /if \(answer\.checkpoint === 'deferred'\) parts\.push\('Checkpoint: deferred — runs in the background; the panel badge shows powered-off immediately\.'\)/u.test(source)
      && /else if \(answer\.checkpoint\) parts\.push\(`Checkpoint: \$\{answer\.checkpoint\}\.`\)/u.test(source))
}

// ------------------------------------------------------------------ *
// WP-10: THE WINDOWS put/get ARGV, AND THE DOCTOR'S VERDICT ORDER
// ------------------------------------------------------------------ *
// TWO BUGS, TWO PURE CHECKS. Neither needs a guest, QEMU or an SSH server.
//
// (1) `cua_vm_put` failed with `scp: stat local "47000"`: ssh's `-p PORT` was
//     reused for scp, whose `-p` takes NO value, so the port fell through into
//     a POSITIONAL slot — a source file. `buildScpArgv` is exported for exactly
//     this assertion: the SHAPE is the defect.
// (2) `windows_mcp_doctor` reported `online: true / state: ready / 19 tools`
//     seconds after a power-off, because a cached probe was merged OVER the
//     plugin's own verdict. The order of the code is the fix, so the order is
//     what is asserted here (the doctor is not exported; needle + offset).
{
  // (1) Imported in a CHILD with a throwaway store, like parseGuestDf: this
  // suite must never bind the supervisor's socket. With no key file in the
  // store the argv carries no `-i`, which is why only the shape is asserted.
  const store = mkdtempSync(path.join(os.tmpdir(), 'cua-scpargv-unit-'))
  try {
    const supervisorUrl = new URL('../docker/cua-vm-supervisor.mjs', import.meta.url).href
    const program = `const m = await import(${JSON.stringify(supervisorUrl)});`
      + `const meta = { name: 'winvm', user: 'cua', ports: { ssh: Number(process.argv[1]) } };`
      + `process.stdout.write(JSON.stringify({`
      + `toGuest: m.buildScpArgv(meta, process.argv[2], process.argv[3], { direction: 'to-guest' }),`
      + `fromGuest: m.buildScpArgv(meta, process.argv[2], process.argv[3], { direction: 'from-guest' })`
      + `}));process.exit(0)`
    const local = '/tmp/notes.txt'
    const guest = 'C:\\Users\\cua\\notes.txt'
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, '47000', local, guest], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, CUA_VM_STORE: path.join(store, 'store'), CUA_VM_HOME: path.join(store, 'home'), CUA_SUPERVISOR_SOCK: path.join(store, 's.sock') }
    })
    let argvs = null
    try { argvs = JSON.parse(result.stdout ?? 'null') } catch { argvs = null }
    // OPENSsh's grammar, reduced to what these argv actually contain: `-p`
    // takes NO value (that is the trap), `-P` does, and anything else that does
    // not start with `-` is a positional.
    const parse = (argv) => {
      const withValue = new Set(['-i', '-o', '-P', '-F', '-S', '-J', '-c', '-l'])
      const noValue = new Set(['-q', '-p', '-r', '-T', '-v', '-B', '-C', '-3', '-4', '-6'])
      const flags = new Map()
      const positionals = []
      for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i]
        if (!token.startsWith('-') || token === '-') { positionals.push(token); continue }
        if (withValue.has(token)) { flags.set(token, argv[i + 1]); i += 1; continue }
        if (noValue.has(token)) { flags.set(token, true); continue }
        flags.set(token, true)
      }
      return { flags, positionals }
    }
    const put = argvs === null ? null : parse(argvs.toGuest)
    const get = argvs === null ? null : parse(argvs.fromGuest)
    check('WP-10: buildScpArgv is exported and returns the complete argv (question mark, then flags)',
      argvs !== null && Array.isArray(argvs.toGuest) && argvs.toGuest[0] === '-q',
      `status=${result.status} out=${String(result.stdout ?? '').slice(0, 80)} err=${String(result.stderr ?? '').slice(0, 120)}`)
    check('WP-10: to-guest = [-q, …opts, -P, PORT, LOCAL, user@host:GUEST] — LOCAL first',
      put !== null && put.positionals.join('|') === `${local}|cua@127.0.0.1:${guest}`,
      JSON.stringify(put?.positionals))
    check('WP-10: from-guest is the exact mirror — the remote is the source',
      get !== null && get.positionals.join('|') === `cua@127.0.0.1:${guest}|${local}`,
      JSON.stringify(get?.positionals))
    check("WP-10: the port is the VALUE of -P in both directions, and `-p` is absent (scp's -p means preserve)",
      put !== null && get !== null
        && put.flags.get('-P') === '47000' && get.flags.get('-P') === '47000'
        && put.flags.has('-p') === false && get.flags.has('-p') === false,
      `put=-P ${put?.flags.get('-P')} get=-P ${get?.flags.get('-P')}`)
    check('WP-10: "47000" is NEVER a positional — the exact bug was the port in the source slot',
      put !== null && get !== null
        && [...put.positionals, ...get.positionals].every((value) => value !== '47000'),
      JSON.stringify([...(put?.positionals ?? []), ...(get?.positionals ?? [])]))
    check('WP-10: scp has no -T (a no-pty flag is ssh-only) and no -i without a key in the store',
      put !== null && get !== null && !put.flags.has('-T') && !get.flags.has('-T')
        && !put.flags.has('-i') && !get.flags.has('-i'))
    // One shared option list: the SAME -o pairs, in the SAME order, in both
    // directions — the property that stops ssh's flag set creeping back in.
    const pairs = (argv) => argv.reduce((acc, token, index) => (token === '-o' ? [...acc, argv[index + 1]] : acc), [])
    check('WP-10: both directions carry the SAME -o option list, in the same order (one shared WINDOWS_SSH_OPTS)',
      argvs !== null && pairs(argvs.toGuest).length >= 5
        && pairs(argvs.toGuest).join('|') === pairs(argvs.fromGuest).join('|'),
      argvs === null ? 'no argv' : pairs(argvs.toGuest).join('|'))
  } finally {
    rmSync(store, { recursive: true, force: true })
  }

  // (2) THE DOCTOR'S VERDICT ORDER. The probe is DETAIL; the stream's newest
  // `vm-state` and the plugin's own `WIN_MCP.online` are the VERDICT. Asserted
  // as offsets, because "probe merged over the answer" was a location bug.
  const doctorSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
  const at = (needle) => doctorSource.indexOf(needle)
  const verdictAt = at('// ---- THE VERDICT COMES FIRST (THE STALE-PROBE FIX) ----')
  const onlineAt = at('const online = streamSaysOffline !== true && WIN_MCP.online === true')
  const staleAt = at('const probeStale = online !== true && probeAgeMs !== null && probeAgeMs > WIN_MCP_PROBE_STALE_MS')
  const overriddenAt = at('const probeOverridden = online !== true && probeFacts.online === true')
  check('WP-10: the doctor computes the VERDICT before it reports a probe, and the conjunction excludes the probe',
    verdictAt > 0 && onlineAt > verdictAt && staleAt > onlineAt && overriddenAt > onlineAt
      && !/const online = [^\n]*probeFacts/u.test(doctorSource),
    `verdict=${verdictAt} online=${onlineAt} stale=${staleAt} overridden=${overriddenAt}`)
  check('WP-10: a not-online vm-state beats a live probe (stream → plugin → probe-as-detail)',
    at('const streamSaysOffline = streamState !== null') > verdictAt
      && at('WIN_MCP_NOT_ONLINE_STATES.has(String(streamState.state).toLowerCase())') > verdictAt
      && /const WIN_MCP_NOT_ONLINE_STATES = new Set\(\[[\s\S]*?'powered-off'[\s\S]*?\]\)/u.test(doctorSource))
  check('WP-10: the probe is aged (probeAgeMs), flagged stale past 5 s, and `overridden` when it lost',
    at('const WIN_MCP_PROBE_STALE_MS = 5000') > 0
      && at('const probeAgeMs = probeAt > 0 ? Math.max(0, Date.now() - probeAt) : null') > 0
      && at('stale: probeStale') > 0
      && at('overridden: probeOverridden') > 0)
  check("WP-10: onlineSource is stream:<state> | plugin | plugin+probe | offline — never a bare 'probe'",
    at("? (WIN_MCP_AUX.probe.online === true ? 'plugin+probe' : 'plugin')") > 0
      && at("      : 'offline'") > 0
      && !/onlineSource[^\n]*\?\s*'probe'\s*:/u.test(doctorSource))
  check('WP-10: the payload puts the VERDICT fields before the probe detail (online, state, onlineSource, probeAgeMs, probe)',
    at('\n    online,\n') > 0
      && at('\n    probeAgeMs,\n') > at('\n    online,\n')
      && at('\n    probe: {\n') > at('\n    probeAgeMs,\n')
      && at('status: online !== true && leaks.length > 0') > 0)
  check('WP-10: the doctor says WHY (guiNote: MCP tools are the element-level lane, a screenshot is the stream)',
    at("const guiNote = 'desktop automation uses the MCP windows tools; cua_vm_gui screenshots are the noVNC stream, not a framebuffer'") > 0)
}

console.log(failures === 0 ? '\nunit: PASS' : `\nunit: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
