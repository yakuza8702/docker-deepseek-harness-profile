#!/usr/bin/env node
/**
 * modules-unit.mjs — the pure parts of the two new modules, and the Windows
 * container spec, asserted without a VM, a container or a daemon.
 */
import { EventEmitter } from 'node:events'
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
  OEM_PAYLOAD_FILES, OEM_PAYLOAD_REQUIRED, OEM_CLIP_AGENT_FILE, OEM_MCP_RELAY_FILE, OEM_GUARD_FILE, CLIP_AGENT_SENTINEL_FILE, SETUP_IMAGE_OPTIONAL, oemPayloadDir, oemPayloadDirStatus, oemPayloadDeniedDir, resolveOemSourceDir, writeOemPayload,
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
  parseFreeSpaceProbe, formatWindowsFreeSpace, WINDOWS_FREE_FLOOR_GB,
  // F1: the SSH/VNC banner probe ITSELF — the one await that parked the install
  // watch for 79 minutes on 2026-11-21. Its contract (it answers on EVERY peer,
  // including the one that accepts and says nothing) is asserted below against
  // the real export, not against a copy of it.
  bannerProbe
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
  // WP-2.1/2.3: the probe is an ORDERED CANDIDATE LIST (handshake first, the
  // legacy `--ping` last) and the payload skew has its OWN sentence.
  SESSION0_FALLBACK_REASON, SESSION0_SKEW_REASON, relayPort, relayProbeCommand, relayProbeCommands,
  createDshCuaClient
} from '../plugins/dsh-cua-vm/win-mcp.js'

/**
 * THE SAME MODULE, UNDER A NAMESPACE. WP-4 lands `desktopFacts()` and WP-6.3
 * tests it; a NAMED import would make this whole file fail to LINK on a tree
 * where that export is absent, which would take 400 unrelated checks down with
 * it. The namespace keeps the file runnable and lets `checkContract` report the
 * missing contract as PENDING instead of an unhandled link error.
 */
import * as winMcpApi from '../plugins/dsh-cua-vm/win-mcp.js'
// CUA-CLI: the Dockerfile's own `latest` resolution, run against a fixture. The
// import is the tool's pure half — its `--check` main is skipped because argv[1]
// is this file.
import {
  simulateResolution, readRunBlock, extractResolveFragment, cuaCliAssetUrl, RELEASES_API_URL
} from '../tools/cua-cli-version.mjs'
// OPENCODE-CLI: the same treatment for the other CLI the Dockerfile resolves at
// build time. Aliased because both tools export a `readRunBlock` /
// `extractResolveFragment` pair and this file drives both.
import {
  simulateResolution as simulateOpencodeResolution,
  readRunBlock as readOpencodeRunBlock,
  extractResolveFragment as extractOpencodeResolveFragment,
  opencodeAssetUrl,
  versionFromTagName as opencodeVersionFromTagName,
  RELEASES_API_URL as OPENCODE_RELEASES_API_URL,
  PLUGIN_VERSION_FLOOR as OPENCODE_PLUGIN_FLOOR
} from '../tools/check-opencode-cli.mjs'

/** The checkout root — the source of `docker/windows-oem/` in these tests. */
const REPO = path.resolve(import.meta.dirname, '..')

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
 * WP-6.3 — A CHECK THAT CAN ONLY PASS ONCE THE PRODUCTION HALF EXISTS.
 *
 * `landed` is the FEATURE's presence (an export, a field, a literal in the file
 * under test) — never the value being asserted. A missing feature is PENDING,
 * loudly; a present feature with the wrong value FAILS.
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
  // THE PROBE IS A HANDSHAKE, NOT A SUBCOMMAND (P0 — this is the assertion that
  // would have caught it).
  //
  // THE OLD ASSERTION HERE SAID:
  //   relayProbeCommand(47999) === 'py -3 C:\\ProgramData\\cua\\mcp-relay.py --ping 47999'
  // and its comment called that "the relay's own `--ping`". It was wrong in the
  // one way that mattered: the script on the guest is staged at machine-create
  // time and never refreshed, and that copy (26,573 B, `--ping` occurrences = 0)
  // answers the flag with a usage line on STDERR, nothing on stdout, exit 2 — so
  // the harness settled `RELAY_DOWN` against a perfectly healthy relay, took
  // `session-0-direct`, and the desktop was blind. The test ASSERTED the defect.
  //
  // The contract now (SOL §4.1, Appendix A): an ordered candidate list whose
  // first entry is a base64-embedded PROGRAM that speaks the wire protocol
  // itself, and the legacy `--ping` form only as the LAST resort.
  //
  //   py -3 -c "exec(__import__('base64').b64decode('<BASE64>').decode())"
  //   python -c "…same program…"
  //   py -3 C:\ProgramData\cua\mcp-relay.py --ping 47999        (legacy, last)
  //
  // Base64 is the carrier because it keeps `"`, `%`, `^`, `&` and `|` out of a
  // command that travels `ssh → cmd.exe → python` (Appendix A).
  const decodeProbeProgram = (command) => {
    const match = /b64decode\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/u.exec(String(command ?? ''))
    return match === null ? null : Buffer.from(match[1], 'base64').toString('utf8')
  }
  const probeCandidates = relayProbeCommands(47999)
  const probeProgram = decodeProbeProgram(probeCandidates[0])
  check('WP-5.4: relayProbeCommands(port)[0] is a base64-embedded handshake PROGRAM (no `--ping` subcommand)',
    Array.isArray(probeCandidates) && probeCandidates.length >= 2
    && /^py -3 -c /u.test(probeCandidates[0])
    && probeProgram !== null
    && !/--ping/u.test(probeCandidates[0]),
    `${probeCandidates.length} candidate(s): ${probeCandidates[0]?.slice(0, 46)}…`)
  check('WP-5.4: ...the program speaks the wire protocol: RELAY_PING, the port, and an 8-BYTE ACCUMULATE',
    probeProgram !== null
    && /RELAY_PING/u.test(probeProgram)
    && probeProgram.includes('47999')
    // THE ACCUMULATE IS THE POINT: a single `recv(8)` is not a contract, because a
    // short read is legal on a socket (the same defect cua-firstboot.ps1 documents).
    && /while\s+len\([A-Za-z_]+\)\s*<\s*8\s*:/u.test(probeProgram)
    && /recv\(\s*8\s*-\s*len\(/u.test(probeProgram)
    && /\+=\s*/u.test(probeProgram)
    && /RELAY_OK/u.test(probeProgram) && /RELAY_BAD/u.test(probeProgram) && /RELAY_DOWN/u.test(probeProgram)
    && /print\(/u.test(probeProgram),
    (probeProgram ?? '(no base64 program)').split('\n').slice(0, 2).join(' | '))
  check('WP-5.4: ...and no candidate needs PowerShell (the CLR start was the OLD defect, not a fallback)',
    probeCandidates.every((candidate) => !/(powershell|GetBytes|TcpClient|byte\[\])/iu.test(String(candidate))),
    probeCandidates.map((candidate) => String(candidate).slice(0, 18)).join(' | '))
  check('WP-5.4: ...the legacy `--ping` form survives ONLY as the LAST candidate',
    probeCandidates.at(-1) === 'py -3 C:\\ProgramData\\cua\\mcp-relay.py --ping 47999'
    && probeCandidates.slice(0, -1).every((candidate) => !/--ping/u.test(String(candidate)))
    && relayProbeCommands(51234).at(-1) === 'py -3 C:\\ProgramData\\cua\\mcp-relay.py --ping 51234'
    && decodeProbeProgram(relayProbeCommands(51234)[0])?.includes('51234') === true,
    `last=${probeCandidates.at(-1)}`)
  check('WP-5.4: ...and relayProbeCommand() is kept as the FIRST candidate (compatibility, WP-2.1)',
    relayProbeCommand(47999) === probeCandidates[0]
    && probeCandidates.every((candidate) => !/\n/u.test(String(candidate))),
    String(relayProbeCommand(47999)).slice(0, 46))
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
  // TWO CAUSES, TWO SENTENCES (SOL §2.3/§4.3). The DOWN sentence above is
  // byte-identical to what it always was; the SKEW case — the guest relay
  // ANSWERED and the harness still could not read it, which is exactly the P0
  // signature — gets its own, because "not running" is a lie about a relay that
  // is running. Neither may be reachable for the other's status.
  check('WP-5.5: RELAY_SKEW has its OWN sentence — a relay that answered is not "not running"',
    SESSION0_SKEW_REASON !== SESSION0_FALLBACK_REASON
    && /desktop automation will be blind/u.test(SESSION0_SKEW_REASON)
    && /the guest relay answered/u.test(SESSION0_SKEW_REASON)
    && /payload mismatch/u.test(SESSION0_SKEW_REASON)
    && /interactive relay not running/u.test(SESSION0_SKEW_REASON) === false
    && /payload mismatch/u.test(SESSION0_FALLBACK_REASON) === false,
    SESSION0_SKEW_REASON)
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
  // WP-6/J22-14 + WP-1.4: THE CLIPBOARD AGENT, THE MCP RELAY AND THE BOOT GUARD
  // ARE PAYLOAD FILES. The four original files still make a directory a payload
  // directory (OEM_PAYLOAD_REQUIRED); the other three are staged because
  // firstboot can only copy what is in the medium it stages from — and the guard
  // in particular has to survive on the guest so a boot can re-assert the relay.
  check('the OEM payload list is the four required files plus the clipboard agent, the MCP relay and the boot guard',
    OEM_PAYLOAD_FILES.join(',') === 'Autounattend.xml,setupcomplete.cmd,cua-firstboot.ps1,Unattend.vbs,cua-clip-agent.ps1,cua-mcp-relay.py,cua-relay-guard.ps1'
    && OEM_PAYLOAD_REQUIRED.join(',') === 'Autounattend.xml,setupcomplete.cmd,cua-firstboot.ps1,Unattend.vbs'
    // The two staged guests are a PAIR, in order: the relay the lane speaks to,
    // then the guard that re-creates it at boot.
    && OEM_PAYLOAD_FILES.slice(-2).join(',') === [OEM_MCP_RELAY_FILE, OEM_GUARD_FILE].join(',')
    && OEM_PAYLOAD_FILES.at(-1) === OEM_GUARD_FILE,
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


// ------------------------------------------------------------------ *
// WP-4 / SOL §5 WP-4.1 — THE SUPERVISOR'S RELAY RE-ASSERT (S1-S4)
//
// THE DEFECT THIS COVERS (chief JURY finding 1: zero coverage). A checkpoint
// boot restores a DISK, not a logged-on desktop, so the supervisor can report a
// Windows row `ready` while the relay task never ran and the desktop is blind.
// `windowsRelayReassert()` is the host half of the fix: ONE `schtasks /run` at
// the moment the supervisor decides the row is ready.
//
// HOW IT IS DRIVEN WITHOUT A GUEST. The function is module-private, so this
// block imports the REAL `docker/cua-vm-supervisor.mjs` through two registered
// hooks and touches nothing else:
//
//   * a `load` hook appends ONE `export { … }` line to the source (no behaviour
//     change — the same trick a debugger uses to read a local), so the function,
//     its throttle map and its three constants are reachable;
//   * a `resolve` hook points the supervisor's `node:child_process` at a stub
//     whose `spawn` RECORDS the argv and then behaves: exit 0, exit 1 with
//     stderr, a spawn error, or a child that never closes (the 20 s timeout).
//
// The registry is a throwaway `CUA_VM_STORE`; the socket the module binds on
// import goes to that store and nobody dials it. `log()` writes to stderr, so
// stderr is captured per case — the log line IS part of the contract (S1).
// ------------------------------------------------------------------ *
{
  const { registerHooks } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const store = mkdtempSync(path.join(os.tmpdir(), 'cua-reassert-'))
  const capture = path.join(store, 'spawn.log')
  const modeFile = path.join(store, 'mode.txt')
  const registryFile = path.join(store, 'registry.json')
  const sock = path.join(store, 'supervisor.sock')
  const supervisorUrl = pathToFileURL(path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')).href

  // THE ROW MATRIX (S1/S2). All of these are rewritten between cases, because the
  // function re-reads the registry on every call — that re-read is the R7 guard
  // (a shutdown that lands between the transition and the call must win).
  const ROWS = {
    win: { name: 'win', kind: 'windows', state: 'ready', ssh: true, ports: { ssh: 47101 } },
    paused: { name: 'paused', kind: 'windows', state: 'suspended', ssh: true, ports: { ssh: 47102 } },
    off: { name: 'off', kind: 'windows', state: 'powered-off', ssh: true, ports: { ssh: 47103 } },
    booting: { name: 'booting', kind: 'windows', state: 'booting', ssh: true, ports: { ssh: 47104 } },
    installing: { name: 'installing', kind: 'windows', state: 'installing', ssh: true, ports: { ssh: 47105 } },
    noSsh: { name: 'noSsh', kind: 'windows', state: 'ready', ssh: false, ports: { ssh: 47106 } },
    linux: { name: 'linux', kind: 'linux', state: 'ready', ssh: true, ports: { ssh: 47107 } }
  }
  const writeRegistry = (rows) => writeFileSync(registryFile, JSON.stringify({ version: 2, vms: rows }))
  // NOT the `installing` row at BOOT: the module resumes an install watch for any
  // such row the moment it listens, and that watcher would spawn ssh behind the
  // counters below. The state is set at call time instead — which is the only
  // thing S2 is about.
  const BOOT_ROWS = { ...ROWS }
  delete BOOT_ROWS.installing

  writeFileSync(modeFile, 'ok')
  // The stub `ssh`: records every spawn, then plays the mode file. A killed child
  // CLOSES (like a real SIGTERM), which is what lets the 20 s cap resolve.
  const stub = path.join(store, 'child-stub.mjs')
  writeFileSync(stub, `import { EventEmitter } from 'node:events'
import { appendFileSync, readFileSync } from 'node:fs'
export * from 'node:child_process'
export function spawn(bin, args) {
  try { appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ bin, args }) + '\\n') } catch {}
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 4242
  child.kill = (signal) => { setTimeout(() => child.emit('close', null, signal), 1) }
  let mode = 'ok'
  try { mode = readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim() } catch {}
  setTimeout(() => {
    if (mode === 'error') { child.emit('error', new Error('spawn ENOENT')); return }
    if (mode === 'fail') { child.stderr.emit('data', 'ERROR: The system cannot find the task\\r\\n'); child.emit('close', 1); return }
    if (mode === 'hang') return
    child.stdout.emit('data', 'SUCCESS: Attempted to run the scheduled task\\r\\n')
    child.emit('close', 0)
  }, 3)
  return child
}
`)
  const hook = path.join(store, 'hook.mjs')
  writeFileSync(hook, `import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
const STUB = ${JSON.stringify(pathToFileURL(stub).href)}
const SUP = ${JSON.stringify(supervisorUrl)}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:child_process' && String(context.parentURL ?? '') === SUP) {
      return { url: STUB, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === SUP) {
      // + THE ONE EXPORT LINE. No line of the module is changed.
      return {
        format: 'module',
        source: readFileSync(new URL(SUP), 'utf8')
          + '\\nexport { windowsRelayReassert, WINDOWS_RELAY_REASSERT_AT, WINDOWS_RELAY_REASSERT_COMMAND, WINDOWS_RELAY_REASSERT_TIMEOUT_MS, WINDOWS_RELAY_REASSERT_INTERVAL_MS }\\n',
        shortCircuit: true
      }
    }
    return nextLoad(url, context)
  }
})
`)

  // The module reads both at load time.
  const savedStore = process.env.CUA_VM_STORE
  const savedSock = process.env.CUA_SUPERVISOR_SOCK
  process.env.CUA_VM_STORE = store
  process.env.CUA_SUPERVISOR_SOCK = sock
  writeRegistry(BOOT_ROWS)

  /** Run one case with stderr captured, and return what it wrote + spawned. */
  const errLines = []
  const write = process.stderr.write.bind(process.stderr)
  const captureStart = () => { errLines.length = 0 }
  const spawned = () => {
    try {
      return readFileSync(capture, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    } catch { return [] }
  }
  const resetSpawns = () => { try { writeFileSync(capture, '') } catch {} }
  const setMode = (m) => writeFileSync(modeFile, m)
  const logs = () => errLines.join('')

  let reassert = null
  let throttle = null
  let tick = null
  try {
    await import(pathToFileURL(hook).href)
    process.stderr.write = (chunk, ...rest) => { errLines.push(String(chunk)); return true }
    const supervisor = await import(supervisorUrl)
    reassert = supervisor.windowsRelayReassert
    throttle = supervisor.WINDOWS_RELAY_REASSERT_AT
    tick = {
      command: supervisor.WINDOWS_RELAY_REASSERT_COMMAND,
      timeoutMs: supervisor.WINDOWS_RELAY_REASSERT_TIMEOUT_MS,
      intervalMs: supervisor.WINDOWS_RELAY_REASSERT_INTERVAL_MS
    }

    // ---- S1: a READY windows row costs exactly one ssh, and says so ----
    throttle.clear(); resetSpawns(); captureStart()
    await reassert('win')
    const s1 = spawned()
    check('WP-4/S1: a ready Windows row fires exactly ONE ssh, ending in `schtasks /run /tn cua-mcp-host`',
      typeof reassert === 'function' && s1.length === 1
      && s1[0].args.at(-1) === 'schtasks /run /tn cua-mcp-host'
      && s1[0].args.includes('-p') && s1[0].args[s1[0].args.indexOf('-p') + 1] === '47101',
      `${s1.length} spawn(s) — ${JSON.stringify(s1[0]?.args.slice(-1) ?? [])}`)
    check('WP-4/S1: ...and the child\'s exit code is logged (the human half of the contract)',
      /windows: win relay re-assert: cua-mcp-host exit 0/u.test(logs()),
      logs().trim().split('\n').at(-1) ?? '(no log line)')
    check('WP-4/S1/S3: the command is verbatim, the cap is 20 s and the throttle window is 15 s',
      tick !== null && tick.command === 'schtasks /run /tn cua-mcp-host'
      && tick.timeoutMs === 20000 && tick.intervalMs === 15000,
      JSON.stringify(tick))

    // ---- S2: everything that is NOT a live windows row spawns NOTHING ----
    const quiet = {}
    for (const name of ['paused', 'off', 'booting', 'installing', 'noSsh', 'linux', 'missing']) {
      throttle.clear(); resetSpawns(); captureStart()
      await reassert(name)
      quiet[name] = spawned().length
    }
    check('WP-4/S2: suspended / powered-off / booting / installing / ssh:false / non-windows / missing rows never spawn ssh',
      Object.values(quiet).every((count) => count === 0), JSON.stringify(quiet))
    // THE RACE (R7): the row is re-read, so a shutdown that landed between the
    // transition and this call wins — no child for a computer that just stopped.
    throttle.clear(); resetSpawns()
    const live = { ...ROWS.win }
    writeRegistry({ ...ROWS, win: { ...live, state: 'powered-off' } })
    await reassert('win')
    const afterShutdown = spawned().length
    writeRegistry(ROWS)
    check('WP-4/S2: a row powered off BETWEEN the transition and the call is a no-op (the row is re-read)',
      afterShutdown === 0, `${afterShutdown} spawn(s)`)

    // ---- S3: three rapid Starts cost one child ----
    writeRegistry(ROWS)
    throttle.clear(); resetSpawns(); captureStart()
    await Promise.all([reassert('win'), reassert('win'), reassert('win')])
    const burst = spawned().length
    await reassert('win')
    const burstAfter = spawned().length
    check('WP-4/S3: three rapid calls (same tick) spawn ONE ssh, and a fourth inside the window adds none',
      burst === 1 && burstAfter === 1, `${burst} then ${burstAfter}`)
    // The window measured without a 15 s sleep: the throttle compares Date.now()
    // against the stamp, so moving the STAMP back is exactly "15 s later".
    throttle.set('win', Date.now() - tick.intervalMs - 1)
    await reassert('win')
    check('WP-4/S3: ...and the next call AFTER the window spawns exactly one more',
      spawned().length === 2, `${spawned().length} spawn(s) total`)

    // ---- S4: a failing ssh is a log line, never a throw ----
    setMode('fail')
    throttle.clear(); resetSpawns(); captureStart()
    let threw = null
    try { await reassert('win') } catch (error) { threw = error }
    check('WP-4/S4: a non-zero ssh exit never throws and is logged WITH the guest detail',
      threw === null && spawned().length === 1
      && /cua-mcp-host exit 1/u.test(logs())
      && /relay re-assert detail: ERROR: The system cannot find the task/u.test(logs()),
      logs().trim().split('\n').slice(-2).join(' | ') || '(no log)')
    setMode('error')
    throttle.clear(); resetSpawns(); captureStart()
    threw = null
    try { await reassert('win') } catch (error) { threw = error }
    check('WP-4/S4: a spawn that cannot even start (ENOENT) never throws and is logged',
      threw === null && /cua-mcp-host exit -1/u.test(logs()) && /spawn ENOENT/u.test(logs()),
      logs().trim().split('\n').slice(-2).join(' | ') || '(no log)')
    // THE 20 s CAP, measured: a child that never closes is killed and the call
    // still resolves. This is the one case that must not hang a Start.
    setMode('hang')
    throttle.clear(); resetSpawns(); captureStart()
    const hangStart = Date.now()
    threw = null
    try { await reassert('win') } catch (error) { threw = error }
    const hangMs = Date.now() - hangStart
    check('WP-4/S4: a HUNG ssh child is capped at 20 s, logged as timed out, and still never throws',
      threw === null && /cua-mcp-host exit 124 \(timed out\)/u.test(logs()) && hangMs >= 19000 && hangMs < 30000,
      `${Math.round(hangMs / 1000)}s — ${logs().trim().split('\n').at(-1) ?? '(no log)'}`)
  } finally {
    process.stderr.write = write
    if (savedStore === undefined) delete process.env.CUA_VM_STORE
    else process.env.CUA_VM_STORE = savedStore
    if (savedSock === undefined) delete process.env.CUA_SUPERVISOR_SOCK
    else process.env.CUA_SUPERVISOR_SOCK = savedSock
    try { rmSync(store, { recursive: true, force: true }) } catch {}
  }
}

/* ================================================================== *
 * WP-6.3 — THE DESKTOP FACTS READER (C1-C5, SOL §4.3/Appendix B)
 *
 * `desktopFacts()` is the ONE reader of what the desktop session measured, and
 * its contract is a list of "never"s: never throws, never claims a field it did
 * not read, never spends a second ssh inside the TTL, and never lets a dead
 * `win32ui` look like a healthy lane. Each check below drives it through the
 * `spawnImpl` seam the real client already exposes, so no guest and no ssh
 * binary are involved — only the code that ships.
 *
 * (Writer D's seam notes are the contract asserted here: options
 * `{host, port, user, keyPath, timeoutMs=8000, ttlMs=60000, force, spawnImpl,
 * now, log}`; a MEASURED answer is cached 60 s, a FAILURE 5 s; `runSshCapture`
 * is exported; a successful JSON-RPC answer CLEARS `lastFailureKind`; a fake
 * child must be EventEmitter-shaped; the client carries `desktopFacts()`,
 * `refreshDesktopFacts()`, `desktopFactsCached()`, `state.lastFailureKind` and
 * `state.desktop`.)
 * ================================================================== */
{
  const desktopFacts = typeof winMcpApi.desktopFacts === 'function' ? winMcpApi.desktopFacts : null
  const resetDesktopFactsCache = typeof winMcpApi.resetDesktopFactsCache === 'function' ? winMcpApi.resetDesktopFactsCache : () => {}
  /**
   * ONE FAKE SSH CHILD, the shape `runSshCapture` drives: stdout/stderr streams,
   * `kill()`, and a `close` event. Emitted on a timer so the capture's listeners
   * are attached first (a synchronous emit would be lost).
   */
  const sshStub = ({ stdout = '', stderr = '', exitCode = 0, delayMs = 0 } = {}) => {
    const calls = []
    const spawnImpl = (_bin, argv) => {
      calls.push({ argv: [...(argv ?? [])] })
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      setTimeout(() => {
        if (stdout !== '') child.stdout.emit('data', stdout)
        if (stderr !== '') child.stderr.emit('data', stderr)
        child.emit('close', exitCode)
      }, delayMs)
      return child
    }
    return { calls, spawnImpl }
  }
  const APPENDIX_B = {
    schema: 1,
    measured: true,
    at: '2026-11-19T15:04:05Z',
    user: 'cua',
    session: 2,
    python: 'C:\\Program Files\\Python312\\python.exe',
    dshCuaVersion: '0.4.1',
    pywin32Version: '306',
    win32ui: false,
    uiaLane: true,
    scaleFix: 'skipped:anchor',
    workDir: 'C:\\cua-work',
    workDirWritable: true,
    profileRootWritable: false,
    source: 'cua-work',
    error: ''
  }

  // ---- C1: a valid file ⇒ measured facts, and the DEAD lane is derived ----
  if (desktopFacts === null) {
    checkContract('WP-6.3/C1: desktopFacts() reads the guest file and derives elementLaneOk', false, false,
      'the export is absent', 'win-mcp.js must export desktopFacts()')
  } else {
    resetDesktopFactsCache()
    const stub = sshStub({ stdout: JSON.stringify(APPENDIX_B) })
    let facts = null
    let threw = null
    try { facts = await desktopFacts({ port: 47101, spawnImpl: stub.spawnImpl, now: () => 1_000 }) } catch (error) { threw = error }
    check('WP-6.3/C1: desktopFacts() reads the guest file with ONE bounded ssh and never throws',
      threw === null && stub.calls.length === 1 && facts?.measured === true,
      threw === null ? `${stub.calls.length} spawn(s)` : String(threw?.message ?? threw))
    check('WP-6.3/C1: ...`win32ui:false` becomes `elementLaneOk:false` (the D1 signature)',
      facts?.win32ui === false && facts?.uiaLane === true && facts?.elementLaneOk === false,
      `win32ui=${facts?.win32ui} uiaLane=${facts?.uiaLane} elementLaneOk=${facts?.elementLaneOk}`)
    check('WP-6.3/C1: ...and the typed fields are the file\'s, not defaults',
      facts?.dshCuaVersion === '0.4.1' && facts?.pywin32Version === '306'
      && facts?.session === 2 && facts?.workDirWritable === true
      && facts?.profileRootWritable === false && facts?.scaleFix === 'skipped:anchor'
      && facts?.source === 'cua-work' && facts?.schema === 1,
      JSON.stringify({ v: facts?.dshCuaVersion, s: facts?.session, w: facts?.workDirWritable, scaleFix: facts?.scaleFix }))
    check('WP-6.3/C1: ...the read asks for the two documented paths in ONE command (work dir, then %TEMP%)',
      String(stub.calls[0]?.argv?.at(-1) ?? '').includes('C:\\cua-work\\cua-desktop-facts.json')
      && String(stub.calls[0]?.argv?.at(-1) ?? '').includes('cua-desktop-facts.json'),
      String(stub.calls[0]?.argv?.at(-1) ?? '').slice(0, 120))

    // ---- C2: nothing readable ⇒ measured:false + an error, still no throw ----
    resetDesktopFactsCache()
    const empty = sshStub({ stdout: '', stderr: 'The system cannot find the file specified.', exitCode: 1 })
    let unreadable = null
    let unreadableThrew = null
    try { unreadable = await desktopFacts({ port: 47102, spawnImpl: empty.spawnImpl, now: () => 1_000 }) } catch (error) { unreadableThrew = error }
    check('WP-6.3/C2: an unreadable guest answers {measured:false, source:"none", error} and never rejects',
      unreadableThrew === null && unreadable?.measured === false && unreadable?.source === 'none'
      && typeof unreadable?.error === 'string' && unreadable.error !== '',
      unreadableThrew === null ? String(unreadable?.error ?? '').slice(0, 100) : String(unreadableThrew?.message ?? unreadableThrew))
    check('WP-6.3/C2: ...and EVERY measured field is UNKNOWN (null), never `false`',
      unreadable?.win32ui === null && unreadable?.workDirWritable === null && unreadable?.elementLaneOk === null
      && unreadable?.scaleFix === null,
      JSON.stringify({ win32ui: unreadable?.win32ui, workDirWritable: unreadable?.workDirWritable, scaleFix: unreadable?.scaleFix }))

    // ---- C3: the TTL is one ssh per window, and `force` is the escape ----
    resetDesktopFactsCache()
    const ttlStub = sshStub({ stdout: JSON.stringify(APPENDIX_B) })
    const clock = { now: 5_000 }
    const first = await desktopFacts({ port: 47103, spawnImpl: ttlStub.spawnImpl, now: () => clock.now })
    clock.now += 1_000
    const second = await desktopFacts({ port: 47103, spawnImpl: ttlStub.spawnImpl, now: () => clock.now })
    check('WP-6.3/C3: two reads inside the 60 s TTL spend exactly ONE ssh child',
      ttlStub.calls.length === 1 && first?.cached === false && second?.cached === true,
      `${ttlStub.calls.length} spawn(s), cached=${second?.cached}`)
    clock.now += 60_001
    const afterTtl = await desktopFacts({ port: 47103, spawnImpl: ttlStub.spawnImpl, now: () => clock.now })
    check('WP-6.3/C3: ...a read AFTER the window spawns again (the cache is a TTL, not a latch)',
      ttlStub.calls.length === 2 && afterTtl?.cached === false, `${ttlStub.calls.length} spawn(s)`)
    await desktopFacts({ port: 47103, spawnImpl: ttlStub.spawnImpl, now: () => clock.now, force: true })
    check('WP-6.3/C3: ...and `force` bypasses the window (the doctor\'s one-shot read)',
      ttlStub.calls.length === 3, `${ttlStub.calls.length} spawn(s)`)

    // ---- C3b: a FAILURE is cached for 5 s, not the 60 s a measurement gets ----
    //
    // (Writer D's note: the measured answer lives 60 s, the failure 5 s — a
    // booting guest must be re-read soon, a healthy one must not cost an ssh
    // child per doctor call.) The TTL above is written against VALID JSON on
    // purpose: a failure cache of 60 s would make the healthy case unreachable.
    resetDesktopFactsCache()
    const failStub = sshStub({ stdout: '', stderr: 'The system cannot find the file specified.', exitCode: 1 })
    const failClock = { now: 10_000 }
    await desktopFacts({ port: 47106, spawnImpl: failStub.spawnImpl, now: () => failClock.now })
    failClock.now += 1_000
    const cachedFailure = await desktopFacts({ port: 47106, spawnImpl: failStub.spawnImpl, now: () => failClock.now })
    check('WP-6.3/C3b: a failed read is cached for 5 s (one ssh per boot window, not per doctor call)',
      failStub.calls.length === 1 && cachedFailure?.measured === false,
      `${failStub.calls.length} spawn(s) inside 1 s, measured=${cachedFailure?.measured}`)
    failClock.now += 5_001
    await desktopFacts({ port: 47106, spawnImpl: failStub.spawnImpl, now: () => failClock.now })
    check('WP-6.3/C3b: ...and after 5 s it re-reads (the boot race is retried, never pinned)',
      failStub.calls.length === 2 && winMcpApi.DESKTOP_FACTS_FAILURE_TTL_MS === 5000,
      `${failStub.calls.length} spawn(s); failureTtl=${winMcpApi.DESKTOP_FACTS_FAILURE_TTL_MS}`)

    // ---- C4: the boot-race signature is CONNECTION-LEVEL, and the kind follows ----
    resetDesktopFactsCache()
    const closed = sshStub({ stdout: '', stderr: 'Connection closed by 127.0.0.1 port 22', exitCode: 255 })
    const closedFacts = await desktopFacts({ port: 47104, spawnImpl: closed.spawnImpl, now: () => 1_000 })
    const sshConnectionLevel = typeof winMcpApi.sshConnectionLevel === 'function' ? winMcpApi.sshConnectionLevel : null
    const classify = typeof winMcpApi.classifySshFailureKind === 'function' ? winMcpApi.classifySshFailureKind : null
    check('WP-6.3/C4: a 255 `Connection closed` capture is `connectionLevel:true` (the boot race, not a guest answer)',
      closedFacts?.connectionLevel === true && closedFacts?.measured === false,
      `connectionLevel=${closedFacts?.connectionLevel} measured=${closedFacts?.measured}`)
    check('WP-6.3/C4: ...the classifier calls it `ssh-closed`, and an auth refusal is NOT ssh-closed',
      sshConnectionLevel?.({ exitCode: 255, stderr: '' }) === true
      && sshConnectionLevel?.({ exitCode: 1, stderr: 'The system cannot find the file specified.' }) === false
      // THE STDERR-ONLY PATH IS THE ONE THE CLIENT USES for its first
      // classification (`recordFailureKind(text, null)`), and there an auth
      // refusal must NOT read as the boot race. Exit 255 is ssh's own code and
      // wins over the text by design, so that precedence is asserted too.
      && classify?.({ text: 'Connection closed by 127.0.0.1 port 22' }) === 'ssh-closed'
      && classify?.({ text: 'Permission denied (publickey).' }) === 'auth'
      && classify?.({ text: 'Permission denied (publickey).', exitCode: 255 }) === 'ssh-closed'
      && classify?.({ text: 'JSON-RPC initialize failed', exitCode: 1 }) === 'handshake',
      `${classify?.({ text: 'Connection closed by 127.0.0.1 port 22' })}/${classify?.({ text: 'Permission denied (publickey).' })}/${classify?.({ text: 'JSON-RPC initialize failed', exitCode: 1 })}`)

    // ---- C4b: the CLIENT records the kind beside a BYTE-IDENTICAL lastError ----
    const sessionStderr = 'Connection closed by 127.0.0.1 port 22'
    const clientSpawn = (_bin, argv) => {
      const last = String(argv?.at(-1) ?? '')
      const isSession = last.includes('dsh_cua.server') || last.includes('--connect')
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = new EventEmitter()
      child.stdin.write = () => true
      child.stdin.end = () => {}
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      setTimeout(() => {
        if (isSession) {
          child.stderr.emit('data', `${sessionStderr}\n`)
          child.emit('exit', 255)
          child.emit('close', 255)
        } else {
          child.stdout.emit('data', 'RELAY_DOWN\n')
          child.emit('exit', 0)
          child.emit('close', 0)
        }
      }, 0)
      return child
    }
    let connectThrew = null
    const failingClient = winMcpApi.createDshCuaClient({
      name: 'facts-c4', sshPort: 47105, isOnline: async () => true, spawnImpl: clientSpawn, timeoutMs: 2_000
    })
    try { await failingClient.connect() } catch (error) { connectThrew = error }
    const failingFacts = failingClient.doctorFacts()
    check('WP-6.3/C4: a refused session makes connect() reject (it never resolves a dead bridge)',
      connectThrew !== null, String(connectThrew?.code ?? connectThrew?.message ?? 'no error'))
    check('WP-6.3/C4: ...`lastFailureKind` is `ssh-closed` and `lastError` is the SAME text as before',
      failingFacts?.lastFailureKind === 'ssh-closed' && failingClient.state.lastError === sessionStderr,
      `kind=${failingFacts?.lastFailureKind} lastError=${JSON.stringify(failingClient.state.lastError)}`)

    // ---- C4c: the kind CLEARS on the next successful JSON-RPC answer ----
    const successSpawn = (_bin, argv) => {
      const last = String(argv?.at(-1) ?? '')
      const isSession = last.includes('dsh_cua.server') || last.includes('--connect')
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      child.stdin.write = (data) => {
        for (const line of String(data ?? '').split('\n')) {
          if (line.trim() === '') continue
          let message = null
          try { message = JSON.parse(line) } catch { continue }
          if (message?.id === undefined) continue
          const result = message.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dsh-cua', version: '0.4.1' } }
            : { tools: [] }
          setTimeout(() => child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`), 0)
        }
        return true
      }
      child.stdin.end = () => {}
      setTimeout(() => {
        if (isSession) child.stderr.emit('data', 'Connection closed by 127.0.0.1 port 22\n')
        else { child.stdout.emit('data', 'RELAY_DOWN\n'); child.emit('exit', 0); child.emit('close', 0) }
      }, 0)
      return child
    }
    const recovered = winMcpApi.createDshCuaClient({
      name: 'facts-c4c', sshPort: 47107, isOnline: async () => true, spawnImpl: successSpawn, timeoutMs: 2_000
    })
    let recoveredThrew = null
    try { await recovered.connect() } catch (error) { recoveredThrew = error }
    const recoveredFacts = recovered.doctorFacts()
    check('WP-6.3/C4c: a successful JSON-RPC answer CLEARS `lastFailureKind` (a healed link is not still "ssh-closed")',
      recoveredThrew === null && recoveredFacts?.lastFailureKind === null
      && recovered.state.lastError === 'Connection closed by 127.0.0.1 port 22',
      `connected=${recovered.state.connected} kind=${JSON.stringify(recoveredFacts?.lastFailureKind)} lastError=${JSON.stringify(recovered.state.lastError)}`)
    try { recovered.close() } catch { /* already gone */ }
    check('WP-6.3/C4c: ...and `runSshCapture` is an exported seam (the capture half is testable on its own)',
      typeof winMcpApi.runSshCapture === 'function' && typeof winMcpApi.sshConnectionLevel === 'function')

    // ---- C5: the frozen three-sentence table, and the empty answer for the rest ----
    const contract = winMcpApi.WINDOWS_TOOL_CONTRACT
    const windowsToolContract = typeof winMcpApi.windowsToolContract === 'function' ? winMcpApi.windowsToolContract : null
    check('WP-6.3/C5: WINDOWS_TOOL_CONTRACT has exactly the three Appendix C keys',
      contract !== undefined && Object.keys(contract).length === 3
      && ['tool_open_application', 'tool_send_keys', 'tool_capture_window'].every((key) => typeof contract[key] === 'string'),
      JSON.stringify(Object.keys(contract ?? {})))
    check('WP-6.3/C5: ...and every OTHER guest tool gets the EMPTY note (no accidental fourth)',
      windowsToolContract !== null && windowsToolContract('tool_click_at') === ''
      && windowsToolContract('find_elements') === '' && windowsToolContract('') === ''
      && windowsToolContract('tool_open_application') === contract?.tool_open_application,
      `tool_click_at=${JSON.stringify(windowsToolContract?.('tool_click_at'))}`)
  }
}

/* ================================================================== *
 * WP-6.3 — SOURCE ASSERTIONS FOR THE GUEST PAYLOAD AND THE PIN
 *
 * PowerShell does not exist on the Linux host, so the firstboot text is gated
 * HERE, literally: the pip exit that used to fall through to "did not import",
 * the postinstall + real IMPORT that make `win32ui` live, the work directory and
 * its integrity label, and the hash-gated D3 patch with both frozen anchors.
 * Every assertion is a one-word edit away from a regression, which is exactly
 * the class of defect WP-1 fixes.
 * ================================================================== */
{
  const firstboot = readFileSync(path.join(REPO, 'docker', 'windows-oem', 'cua-firstboot.ps1'), 'utf8')
  const supervisor = readFileSync(path.join(REPO, 'docker', 'cua-vm-supervisor.mjs'), 'utf8')
  // THE FROZEN LITERALS, copied from WP-1's contract (writer A's exact text).
  // Asserting the WORD, not a regex over a paraphrase, is the point: a one-word
  // edit is the regression class this block exists for.
  const L = {
    spec: "$spec = '{{DSH_CUA_PIP}}'",
    pipExit: "if ($pipExit -ne 0) { throw \"pip install '$spec' exited $pipExit; the wheel was not installed\" }",
    win32ui: 'import win32ui, win32gui',
    uiawrapper: 'import pywinauto.controls.uiawrapper',
    uiaOk: "print('UIA_OK')",
    postinstall: 'pywin32_postinstall.py',
    deadLane: 'the element lane is dead: import win32ui failed after pywin32_postinstall',
    workdirStep: "Step 'cua-workdir'",
    integrity: "'/setintegritylevel' '(OI)(CI)M'",
    scaleStep: "Step 'dsh-cua-scale'",
    hash: "$expectedHash = '59280ee9079cc09aa94b3813fd7a7665cfebffe68fb7259b752e161abf1f9209'",
    anchorA: 'base_w, base_h = img.size',
    anchorB: '"scale_x": round(base_w / ew, 6) if ew else 1.0',
    clearPyc: 'Clear-BridgePyc'
  }
  const missingLiteral = (key) => firstboot.includes(L[key]) === false
  check('WP-6.3/A1: the install keeps the {{DSH_CUA_PIP}} placeholder AND throws on a non-zero pip exit',
    missingLiteral('spec') === false && missingLiteral('pipExit') === false,
    missingLiteral('spec') || missingLiteral('pipExit') ? 'one of the two literals is missing' : 'both exact')
  check('WP-6.3/A2: the lane is verified by IMPORT (win32ui + win32gui + pywinauto.controls.uiawrapper)',
    missingLiteral('win32ui') === false && missingLiteral('uiawrapper') === false && missingLiteral('uiaOk') === false,
    `present: win32ui=${!missingLiteral('win32ui')} uiawrapper=${!missingLiteral('uiawrapper')} UIA_OK=${!missingLiteral('uiaOk')}`)
  check('WP-6.3/A5: pywin32_postinstall.py is located and run, and a lane that stays dead THROWS the exact sentence',
    missingLiteral('postinstall') === false && missingLiteral('deadLane') === false,
    missingLiteral('postinstall') || missingLiteral('deadLane') ? 'the repair or the throw is missing' : 'both exact')
  check('WP-6.3/A4: the work dir is created by its own step with the explicit DACL and the Medium label',
    missingLiteral('workdirStep') === false && missingLiteral('integrity') === false
    && /\$cuaGrant = "\$\(\$env:COMPUTERNAME\)\\cua:\(OI\)\(CI\)F"/u.test(firstboot),
    `${(firstboot.match(/C:\\cua-work/gu) ?? []).length} C:\\cua-work mention(s)`)
  check('WP-6.3/A6: the D3 patch is hash-gated on the PINNED sha256 and clears the stale .pyc afterwards',
    missingLiteral('hash') === false && missingLiteral('clearPyc') === false && /scaleFix/u.test(firstboot),
    `hash=${!missingLiteral('hash')} Clear-BridgePyc=${!missingLiteral('clearPyc')}`)
  check('WP-6.3/A3: ...and it applies BOTH frozen replacements (anchor A + the base_w ratio)',
    missingLiteral('anchorA') === false && missingLiteral('anchorB') === false
    && missingLiteral('scaleStep') === false && /SCALE_OK/u.test(firstboot),
    `anchorA=${!missingLiteral('anchorA')} anchorB=${!missingLiteral('anchorB')} step=${!missingLiteral('scaleStep')}`)
  check('WP-6.3/S1: the guest install is PINNED by default (`dsh-cua==0.4.1`) with the env override kept',
    /export const WINDOWS_DSH_CUA_DEFAULT = 'dsh-cua==0\.4\.1'/u.test(supervisor)
    && /WINDOWS_DSH_CUA_SPEC = String\(process\.env\.DSH_CUA_WINDOWS_DSH_CUA \|\| WINDOWS_DSH_CUA_DEFAULT\)/u.test(supervisor),
    'exported default + `DSH_CUA_WINDOWS_DSH_CUA` override')
  check('WP-6.3: the two new steps exist under the names the needles and the provision log use',
    !missingLiteral('workdirStep') && !missingLiteral('scaleStep'))
}

/* ================================================================== *
 * WP-6.5 — THE BUDGET INVARIANTS (nothing else moved)
 *
 * `TOOL_TIMEOUTS` is the tool envelope every registration is validated against,
 * so a "small" edit here is a change to what every caller may wait for. The
 * table is asserted literally: 19 guest tools share the attach envelope, the two
 * ungated helpers keep theirs, and `cua_vm_exec` keeps its 3 660 000 ms ceiling
 * (the boot wait — at most 60 s — stays far inside it).
 * ================================================================== */
{
  const source = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
  const frozen = {
    windows_desktop: '30_000',
    windows_mcp_doctor: '60_000',
    cua_vm_status: '30_000',
    cua_vm_doctor: '30_000',
    cua_vm_gc: '30_000',
    cua_vm_disk: '30_000',
    cua_vm_port: '30_000',
    cua_vm_start: '60_000',
    cua_vm_suspend: '60_000',
    cua_vm_shutdown: '60_000',
    cua_vm_destroy: '60_000',
    cua_vm_put: '120_000',
    cua_vm_get: '120_000',
    cua_vm_gui: '120_000',
    cua_vm_exec: '3_660_000',
    cua_vm_create: '1_800_000',
    cua_vm_ensure: '1_800_000',
    cua_vm_android: '3_360_000'
  }
  const missing = Object.entries(frozen)
    .filter(([name, value]) => !new RegExp(`\\n  ${name}: ${value},?`, 'u').test(source))
    .map(([name]) => name)
  check('WP-6.5: TOOL_TIMEOUTS is byte-identical to the frozen envelope (18 names, same numbers)',
    missing.length === 0, missing.length === 0 ? '18/18 exact' : `changed: ${missing.join(',')}`)
  const execCeiling = 3_660_000
  const bootWaitMax = 60_000
  check('WP-6.5: the boot wait (≤ 60 s) stays far inside `cua_vm_exec`\'s envelope',
    bootWaitMax < execCeiling / 10,
    `${bootWaitMax} ms vs ${execCeiling} ms (${Math.round((bootWaitMax / execCeiling) * 1000) / 10}%)`)
}

/* ================================================================== *
 * WP-6.3/C6 — THE scaleFix VOCABULARY (co-juror-1 defect 6)
 *
 * `scaleFix` is a FACT the guest publishes, so a test may only pin a value a
 * PRODUCER can actually emit. This suite used to pin `skipped:hash`, which
 * nothing writes: the relay (the writer of the facts file) emits
 * `applied | skipped:no-file | skipped:anchor | unverified:<why>`, and
 * firstboot emits its own marker vocabulary. The check parses BOTH producers and
 * fails on any literal this suite pins that neither can produce — so the
 * impossible pin cannot come back, and a new producer value (writer A's
 * rollback `failed:restore-failed`) is accepted the moment it lands.
 * ================================================================== */
{
  const relayText = readFileSync(path.join(REPO, 'docker', 'cua-mcp-relay.py'), 'utf8')
  const firstbootText = readFileSync(path.join(REPO, 'docker', 'windows-oem', 'cua-firstboot.ps1'), 'utf8')
  const relayValues = new Set([
    // EVERY such literal, not only the ones after `return`: the relay's D3
    // verdict is `'applied' if 'base_w' in source else 'skipped:anchor'`, and a
    // `return`-anchored regex silently missed the second half.
    ...[...relayText.matchAll(/'(applied|skipped:[a-z-]+|unverified:[^']*)'/gu)].map((match) => match[1]),
    ...[...relayText.matchAll(/'scaleFix': '([^']+)'/gu)].map((match) => match[1])
  ])
  const firstbootValues = new Set([
    ...[...firstbootText.matchAll(/scaleFix = '([^']+)'/gu)].map((match) => match[1]),
    ...[...firstbootText.matchAll(/scaleFix = "([^"]+)"/gu)].map((match) => match[1])
  ])
  const producers = new Set([...relayValues, ...firstbootValues])
  // EVERY scaleFix literal THIS SUITE PINS must be producible. A vocabulary word
  // only (`applied`, `skipped:x`, `unverified:x`) — the regex sources below are
  // not pins.
  const pinned = []
  for (const file of ['modules-unit.mjs', 'windows-mcp-gate.mjs', path.join('fixtures', 'fake-win-mcp.mjs')]) {
    const text = readFileSync(path.join(REPO, 'tests', file), 'utf8')
    for (const match of text.matchAll(/scaleFix: '([^']+)'/gu)) pinned.push({ file, value: match[1] })
    for (const match of text.matchAll(/scaleFix === '([^']+)'/gu)) pinned.push({ file, value: match[1] })
  }
  const unique = [...new Map(pinned.map((entry) => [`${entry.file}:${entry.value}`, entry])).values()]
  const impossible = unique.filter((entry) => /^[a-z][a-z:-]*$/u.test(entry.value) && producers.has(entry.value) === false)
  check('WP-6.3/C6: every scaleFix value pinned in these tests is one a PRODUCER can emit',
    unique.length > 0 && impossible.length === 0,
    impossible.length === 0 ? `${unique.length} pin(s) ⊆ ${producers.size} producer value(s)` : impossible.map((entry) => `${entry.file}:${entry.value}`).join(','))
  check('WP-6.3/C6: ...the relay (the facts-file writer) has its own closed vocabulary, not firstboot\'s markers',
    relayValues.has('applied') && relayValues.has('skipped:anchor') && relayValues.has('skipped:no-file')
    && relayValues.has('unverified:not measured'),
    [...relayValues].sort().join(' | '))
  check('WP-6.3/C6: ...and firstboot reports the hash gate honestly (`skipped:hash-mismatch`, never `skipped:hash`)',
    firstbootValues.has('skipped:hash-mismatch') && firstbootValues.has('skipped:version-mismatch')
    && firstbootValues.has('skipped:anchor-missing') && firstbootValues.has('skipped:write-failed')
    && firstbootValues.has('skipped:hash') === false,
    [...firstbootValues].sort().join(' | '))
}

/* ================================================================== *
 * WP-3 — THE RELAY PRODUCER, ASSERTED WITHOUT PYTHON (chief defect 6)
 *
 * The facts file is written from INSIDE the desktop session by
 * `docker/cua-mcp-relay.py`. Nothing on this host runs it and a guest run is
 * JURY's, so what a reviewer can prove here is that the producer EXISTS, uses
 * the frozen names, is bounded, and starts its measurement only after the
 * listener is up. Each assertion below is one edit away from a regression.
 * ================================================================== */
{
  const relay = readFileSync(path.join(REPO, 'docker', 'cua-mcp-relay.py'), 'utf8')
  const once = (needle) => relay.split(needle).length - 1 === 1
  check('WP-3.3: the relay names the facts file exactly once (one contract, no second path)',
    once("DESKTOP_FACTS_NAME = 'cua-desktop-facts.json'"))
  check('WP-3.3: ...and the ONE writable work dir, with %TEMP% as the documented fallback',
    once("WORK_DIR = 'C:\\\\cua-work'") && /def facts_temp_dir\(\)/u.test(relay)
    && /os\.path\.join\(WORK_DIR, DESKTOP_FACTS_NAME\)/u.test(relay))
  check('WP-3.3: ...bounded at 20 s (a doctor read must never outlive the doctor)',
    once('FACTS_PROBE_TIMEOUT = 20'))
  check('WP-3.3: the measurement is ONE function (`collect_desktop_facts`) carrying the frozen keys',
    once('def collect_desktop_facts(') && /'win32ui'/u.test(relay) && /'uiaLane'/u.test(relay)
    && /'workDirWritable'/u.test(relay) && /'profileRootWritable'/u.test(relay))
  check('WP-3.4: ...published as ONE `event(\'desktop-facts\' …)` log line (the JURY timeline)',
    once("event('desktop-facts'"))
  check('WP-3.1: ...from a DAEMON thread started AFTER the listener exists, never joined',
    once('threading.Thread(target=self.publish_desktop_facts,')
    && /facts_thread\.daemon = True/u.test(relay)
    && relay.indexOf('listener.listen(') !== -1
    && relay.indexOf('listener.listen(') < relay.indexOf('facts_thread.start()'))
}

/* ================================================================== *
 * WP-6.3/C7-C9 — THE DESKTOP-FACTS CACHE INVARIANTS (JURY-CO1 2/3/5)
 *
 * Three defects that a "does it read the file" test cannot see:
 *   C7  the attach path fires TWO reads in one tick; without single-flight the
 *       second one spent a second ssh child (JURY-CO1 defect 2);
 *   C8  `stale` was computed once, inside the normaliser, and replayed verbatim
 *       on every cache hit — a file 59 s old still said `stale:false` at 118 s
 *       (defect 5). The verdict belongs to the moment of the ANSWER;
 *   C9  a destroyed computer's facts must never serve again — including a read
 *       that was IN FLIGHT across the teardown (defect 3), and including a
 *       replacement that reuses the same name and port.
 * ================================================================== */
{
  const desktopFacts = typeof winMcpApi.desktopFacts === 'function' ? winMcpApi.desktopFacts : null
  const forgetDesktopFacts = typeof winMcpApi.forgetDesktopFacts === 'function' ? winMcpApi.forgetDesktopFacts : null
  const resetDesktopFactsCache = typeof winMcpApi.resetDesktopFactsCache === 'function' ? winMcpApi.resetDesktopFactsCache : () => {}
  const LANDED = desktopFacts !== null && forgetDesktopFacts !== null
  const sshStub = ({ stdout = '', stderr = '', exitCode = 0, delayMs = 0 } = {}) => {
    const calls = []
    const spawnImpl = (_bin, argv) => {
      calls.push({ argv: [...(argv ?? [])] })
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      setTimeout(() => {
        if (stdout !== '') child.stdout.emit('data', stdout)
        if (stderr !== '') child.stderr.emit('data', stderr)
        child.emit('close', exitCode)
      }, delayMs)
      return child
    }
    return { calls, spawnImpl }
  }
  const FACTS = {
    schema: 1,
    measured: true,
    at: '2026-11-19T15:00:00Z',
    user: 'cua',
    session: 2,
    dshCuaVersion: '0.4.1',
    pywin32Version: '306',
    win32ui: true,
    uiaLane: true,
    scaleFix: 'applied',
    workDir: 'C:\\cua-work',
    workDirWritable: true,
    profileRootWritable: false,
    source: 'cua-work',
    error: ''
  }

  if (LANDED === false) {
    checkContract('WP-6.3/C7: two concurrent reads share ONE ssh child', false, false,
      'the single-flight latch is absent', 'win-mcp.js must export forgetDesktopFacts()')
  } else {
    // ---- C7: TWO READS IN ONE TICK ⇒ ONE CHILD ----
    resetDesktopFactsCache()
    const shared = sshStub({ stdout: JSON.stringify(FACTS), delayMs: 40 })
    const [first, second] = await Promise.all([
      desktopFacts({ port: 47110, name: 'sf', spawnImpl: shared.spawnImpl, now: () => 1_000 }),
      desktopFacts({ port: 47110, name: 'sf', spawnImpl: shared.spawnImpl, now: () => 1_000 })
    ])
    check('WP-6.3/C7: two concurrent reads for ONE computer share a single ssh child',
      shared.calls.length === 1 && first?.measured === true && second?.measured === true,
      `${shared.calls.length} spawn(s)`)
    check('WP-6.3/C7: ...and the shared caller is told it did not spawn (`cached:true`)',
      second?.cached === true && first?.cached === false,
      `first.cached=${first?.cached} second.cached=${second?.cached}`)

    // ---- C8: `stale` IS RE-DERIVED AT READ TIME, NOT REPLAYED FROM THE ENTRY ----
    resetDesktopFactsCache()
    const atMs = Date.parse(FACTS.at)
    const clock = { now: atMs + 30_000 }
    const staleStub = sshStub({ stdout: JSON.stringify(FACTS) })
    const fresh = await desktopFacts({ port: 47111, name: 'age', spawnImpl: staleStub.spawnImpl, now: () => clock.now })
    clock.now += 40_000 // the cache entry is still inside its 60 s window; the FILE is not
    const aged = await desktopFacts({ port: 47111, name: 'age', spawnImpl: staleStub.spawnImpl, now: () => clock.now })
    check('WP-6.3/C8: `stale` follows the FILE\'s age at the moment of the answer (a cache hit cannot pin it)',
      fresh?.stale === false && aged?.stale === true && aged?.cached === true && staleStub.calls.length === 1,
      `fresh.stale=${fresh?.stale} aged.stale=${aged?.stale} cached=${aged?.cached} spawns=${staleStub.calls.length}`)

    // ---- C9a: FORGET ⇒ the next read spawns again ----
    resetDesktopFactsCache()
    const forgetStub = sshStub({ stdout: JSON.stringify(FACTS) })
    await desktopFacts({ port: 47112, name: 'dead', spawnImpl: forgetStub.spawnImpl, now: () => 1_000 })
    const hit = await desktopFacts({ port: 47112, name: 'dead', spawnImpl: forgetStub.spawnImpl, now: () => 1_000 })
    forgetDesktopFacts({ port: 47112, name: 'dead' })
    const afterForget = await desktopFacts({ port: 47112, name: 'dead', spawnImpl: forgetStub.spawnImpl, now: () => 1_000 })
    check('WP-6.3/C9: forgetting a computer drops its cached facts (the next read is a real one)',
      hit?.cached === true && afterForget?.cached === false && forgetStub.calls.length === 2,
      `hit=${hit?.cached} after=${afterForget?.cached} spawns=${forgetStub.calls.length}`)

    // ---- C9b: A READ IN FLIGHT ACROSS THE TEARDOWN DOES NOT REPOPULATE ----
    resetDesktopFactsCache()
    const slowStub = sshStub({ stdout: JSON.stringify(FACTS), delayMs: 60 })
    const inFlight = desktopFacts({ port: 47113, name: 'dead2', spawnImpl: slowStub.spawnImpl, now: () => 1_000 })
    forgetDesktopFacts({ port: 47113, name: 'dead2' })
    await inFlight
    const afterEpoch = await desktopFacts({ port: 47113, name: 'dead2', spawnImpl: slowStub.spawnImpl, now: () => 1_000 })
    check('WP-6.3/C9: a read that lands AFTER a teardown cannot write the dead computer\'s answer back',
      afterEpoch?.cached === false && slowStub.calls.length === 2,
      `after.cached=${afterEpoch?.cached} spawns=${slowStub.calls.length}`)

    // ---- C9c: the CLIENT's close() is the teardown that forgets (the wiring) ----
    resetDesktopFactsCache()
    const closeStub = sshStub({ stdout: JSON.stringify(FACTS) })
    const doomed = winMcpApi.createDshCuaClient({ name: 'gone', sshPort: 47114, isOnline: async () => true, spawnImpl: closeStub.spawnImpl })
    const beforeClose = await doomed.desktopFacts()
    doomed.close()
    const afterClose = await desktopFacts({ port: 47114, name: 'gone', spawnImpl: closeStub.spawnImpl, now: () => 1_000 })
    check('WP-6.3/C9: ...and the client\'s close() is what forgets it (the same name AND port may be reused)',
      beforeClose?.measured === true && afterClose?.cached === false && closeStub.calls.length === 2
      && doomed.state.desktop === null,
      `before=${beforeClose?.measured} after=${afterClose?.cached} spawns=${closeStub.calls.length} state.desktop=${String(doomed.state.desktop)}`)
  }
}

/* ================================================================== *
 * WP-6.3/A7-A8 — THE D3 ROLLBACK, REPORTED HONESTLY (writer A's fix round)
 *
 * The patch writes bridge.py in place. If the write, the import or the probe
 * then fails, the original bytes go back — and the ONE thing the marker must
 * never do is call that "skipped, nothing happened" without measuring the
 * restore. A7 asserts the three failure branches capture `$restoreOk` and only
 * say "reverted" when it is true; A8 tracks the vocabulary the README promises
 * for the case where the ROLLBACK ITSELF failed.
 * ================================================================== */
{
  const firstboot = readFileSync(path.join(REPO, 'docker', 'windows-oem', 'cua-firstboot.ps1'), 'utf8')
  const readme = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'README.md'), 'utf8')
  const restoreCalls = (firstboot.match(/\$restoreOk = Restore-BridgeSource -BridgePath \$bridgePath -OriginalBytes \$originalBytes -ExpectedHash \$measureHash/gu) ?? []).length
  const markerRows = (firstboot.match(/restoreOk = \$restoreOk/gu) ?? []).length
  const guarded = (firstboot.match(/if \(\$restoreOk\) \{/gu) ?? []).length
  check('WP-6.3/A7: every D3 failure branch MEASURES the rollback (three `$restoreOk = Restore-BridgeSource …` calls)',
    restoreCalls === 3, `${restoreCalls} restore call(s)`)
  check('WP-6.3/A7: ...and carries the measured outcome in the marker row (three `restoreOk = $restoreOk`)',
    markerRows === 3, `${markerRows} marker row(s)`)
  check('WP-6.3/A7: ...so "reverted" is only ever SAID when the restore measured true',
    guarded === 3 && /NOT RESTORED/u.test(firstboot)
    && /NOT RESTORED \(bridge\.py was not writable/u.test(firstboot)
    && /NOT RESTORED after a failed import/u.test(firstboot)
    && /NOT RESTORED after a bad probe/u.test(firstboot),
    `${guarded} guarded branch(es), NOT RESTORED x${(firstboot.match(/NOT RESTORED/gu) ?? []).length}`)
  check('WP-6.3/A7: ...and `applied` is only reachable AFTER the arithmetic probe (never before it)',
    firstboot.indexOf("scaleFix = 'applied'") > firstboot.indexOf('SCALE_BAD')
    && firstboot.indexOf("scaleFix = 'applied'") > firstboot.indexOf("scaleFix = 'skipped:import-failed'"),
    `applied@${firstboot.indexOf("scaleFix = 'applied'")} probe@${firstboot.indexOf('SCALE_BAD')}`)
  // A8: THE REAL CONTRACT OF THE ROLLBACK (writer A's shipped shape).
  //
  // The README once named `failed:restore-failed` for "the revert itself could
  // not be written back". The shipped shape is DIFFERENT and better: the frozen
  // `skipped:<why>` family is unchanged, and the marker row gains an ADDITIVE
  // `restoreOk` boolean on exactly the three rows where a rollback was
  // attempted (`restoreOk:false` = not restored, so the file is in an unknown
  // state). Asserting the phantom value would have pinned a lie — so this check
  // asserts the value is NOT producible, and that the three rows carry the
  // measured outcome instead.
  const emitted = new Set([...firstboot.matchAll(/scaleFix = '([^']+)'/gu)].map((match) => match[1]))
  check('WP-6.3/A8: `failed:restore-failed` is NOT a producer value (the frozen skipped:<why> family is what ships)',
    emitted.has('failed:restore-failed') === false
    && emitted.has('skipped:write-failed') && emitted.has('skipped:import-failed') && emitted.has('skipped:probe-failed'),
    [...emitted].sort().join(' | '))
  check('WP-6.3/A8: ...and a failed rollback is reported by the ADDITIVE `restoreOk` on exactly those three rows',
    (firstboot.match(/restoreOk = \$restoreOk/gu) ?? []).length === 3
    && /scaleFix = 'skipped:write-failed';[^\n]*restoreOk = \$restoreOk/u.test(firstboot)
    && /scaleFix = 'skipped:import-failed';[^\n]*restoreOk = \$restoreOk/u.test(firstboot)
    && /scaleFix = 'skipped:probe-failed';[^\n]*restoreOk = \$restoreOk/u.test(firstboot),
    'write-failed / import-failed / probe-failed each carry restoreOk')
  check('WP-6.3/A8: ...`applied` and `already` carry NO restoreOk (nothing was rolled back on the happy path)',
    /scaleFix = 'applied'[^\n]*restoreOk/u.test(firstboot) === false
    && /scaleFix = 'already'[^\n]*restoreOk/u.test(firstboot) === false)
}

/* ================================================================== *
 * WP-B — CLIENT TRUTH: THE FUNCTIONAL PROBE, THE EVIDENCE, THE REPAIR
 * SENTENCE AND THE PER-CALL TRANSPORT BUDGET (SOL §4, C1/C2/C3/C5/C6)
 *
 * R1 had two halves and this file is the host one. `RELAY_OK` is an ACCEPT
 * LOOP answer (C1), so the harness needs a SECOND question it can ask the
 * guest — a real `initialize`/`tools/list` round trip — and a token that says
 * "the relay is listening and its child is not answering". The 14 checks
 * below are B-1…B-14 of §4.3, in that order: the token and its rank, the two
 * builders, the never-throwing probe with its five answers, the typing of the
 * evidence, the facts field, the repair sentence, and the transport half of
 * R3 (the 25 s ladder + a retry that is a REQUEST retry, never a reconnect).
 * ================================================================== */
{
  const UP = winMcpApi

  /* ---- B-1: THE TOKEN EXISTS AND IS ITS OWN VALUE ------------------- */
  const tokens = [UP.RELAY_OK, UP.RELAY_BAD, UP.RELAY_DOWN, UP.RELAY_SKEW]
  check('WP-B/B1: RELAY_UNRESPONSIVE is exported and is NOT OK/BAD/DOWN/SKEW (four answers, four values)',
    UP.RELAY_UNRESPONSIVE === 'RELAY_UNRESPONSIVE'
    && tokens.every((token) => token !== UP.RELAY_UNRESPONSIVE)
    && new Set([...tokens, UP.RELAY_UNRESPONSIVE]).size === 5,
    String(UP.RELAY_UNRESPONSIVE))

  /* ---- B-2: RANK 3, AND STILL NOT A USABLE LANE --------------------- */
  // C2 freezes BOTH facts, and they are not in tension: rank orders EVIDENCE
  // ("the child was measured and failed" outranks "we could not read an
  // answer"), `relayOk` orders USABILITY ("may we send a tools/call"). A
  // future reader who collapses them would let a wedged child pass the one
  // gate that exists to catch it — which is exactly how R1 stayed invisible.
  check('WP-B/B2: relayAnswerRank(UNRESPONSIVE)=3 > SKEW=2 > DOWN=1, and relayOk is FALSE for it (rank-3 evidence, unusable lane)',
    UP.relayAnswerRank(UP.RELAY_UNRESPONSIVE) === 3
    && UP.relayAnswerRank(UP.RELAY_UNRESPONSIVE) > UP.relayAnswerRank(UP.RELAY_SKEW)
    && UP.relayAnswerRank(UP.RELAY_SKEW) > UP.relayAnswerRank(UP.RELAY_DOWN)
    && UP.relayAnswerOutranks(UP.RELAY_UNRESPONSIVE, UP.RELAY_SKEW) === true
    && UP.relayAnswerRelayOk(UP.RELAY_UNRESPONSIVE) === false
    && UP.relayAnswerRelayOk(UP.RELAY_OK) === true
    && UP.relayAnswerRelayOk(UP.RELAY_DOWN) === false,
    `rank=${UP.relayAnswerRank(UP.RELAY_UNRESPONSIVE)} relayOk=${UP.relayAnswerRelayOk(UP.RELAY_UNRESPONSIVE)}`)

  /* ---- B-3: THE PROGRAM IS THE SESSION, NOT A PING ------------------ */
  // §11: no `--ping --functional` flag, because a flag is a dependency on a
  // payload staged at machine-create. The program speaks the wire protocol
  // itself: the evidence verb, then the same three frames `connect()` sends.
  const fnProgram = UP.relayFunctionalProbeProgram(47999)
  check('WP-B/B3: the program carries RELAY_FN + a REAL initialize/tools/list session (ids 900001/900002, the port) and no PowerShell',
    typeof fnProgram === 'string'
    && fnProgram.includes('RELAY_FN')
    && fnProgram.includes('initialize')
    && fnProgram.includes('tools/list')
    && fnProgram.includes('900001') && fnProgram.includes('900002')
    && fnProgram.includes('47999')
    && fnProgram.includes('RELAY_UNRESPONSIVE') && fnProgram.includes('RELAY_OK')
    && /powershell|GetBytes|TcpClient/iu.test(fnProgram) === false,
    `${fnProgram.length} bytes, portable python`)

  /* ---- B-4: THE CARRIER IS BASE64, NOT A CLI MODE ------------------- */
  const fnCommand = UP.relayFunctionalProbeCommand(47999)
  const fnDecoded = /b64decode\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/u.exec(String(fnCommand ?? ''))
  check('WP-B/B4: the command is ONE base64 carrier (`exec(__import__(\'base64\').b64decode(`) with no --ping and no --functional flag',
    typeof fnCommand === 'string'
    && fnCommand.includes("exec(__import__('base64').b64decode(")
    && fnCommand.includes('-c "')
    && fnCommand.includes('--ping') === false
    && fnCommand.includes('--functional') === false
    && fnDecoded !== null
    && Buffer.from(fnDecoded[1], 'base64').toString('utf8') === fnProgram,
    `${fnCommand.slice(0, 44)}… (${fnCommand.length} B)`)

  /* ---- THE ONE FAKE SSH CHILD THESE FIVE ANSWERS GO THROUGH --------- */
  const fnStub = ({ stdout = '', stderr = '', exitCode = 0 } = {}) => {
    const calls = []
    const spawnImpl = (_bin, argv) => {
      calls.push({ argv: [...(argv ?? [])] })
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      setTimeout(() => {
        if (stdout !== '') child.stdout.emit('data', stdout)
        if (stderr !== '') child.stderr.emit('data', stderr)
        child.emit('close', exitCode)
      }, 0)
      return child
    }
    return { calls, spawnImpl }
  }
  const FULL = {
    status: 'RELAY_OK',
    measured: true,
    reason: '',
    elapsedMs: 812,
    initializeMs: 120,
    toolsListMs: 260,
    tools: 19,
    mode: 'functional',
    evidenceAt: '2026-11-20T16:00:00Z',
    lastSuccessfulCallAgeMs: 412,
    outstandingRequestAgeMs: null,
    childRestarts: 0,
    lastWedgeAt: null,
    childPid: 4242,
    wedgeDeadlineMs: 20000,
    at: '2026-11-20T16:00:00Z'
  }

  /* ---- B-5: A MEASURED OK ------------------------------------------- */
  const okStub = fnStub({ stdout: `RELAY_OK\n${JSON.stringify(FULL)}\n` })
  const okAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: okStub.spawnImpl, now: () => 1_000 })
  check('WP-B/B5: RELAY_OK + a measured answer ⇒ measured:true, status RELAY_OK, tools:19 — and the probe runs in ONE ssh child with no early-settle seam',
    okAnswer.status === UP.RELAY_OK && okAnswer.measured === true && okAnswer.tools === 19
    && okAnswer.relayOk === true && okAnswer.reason === ''
    && okAnswer.mode === 'functional' && okAnswer.evidenceAt === '2026-11-20T16:00:00Z'
    && okStub.calls.length === 1
    && /base64/u.test(String(okStub.calls[0]?.argv?.at(-1) ?? ''))
    && /b64decode\(/u.test(String(okStub.calls[0]?.argv?.at(-1) ?? '')),
    `${okAnswer.status} measured=${okAnswer.measured} tools=${okAnswer.tools} spawns=${okStub.calls.length}`)

  /* ---- B-6: THE CHILD DID NOT ANSWER -------------------------------- */
  // R1's whole point: the relay is UP and the child is NOT. `measured:false`
  // with `child-silent` is the answer the doctor's `unresponsive` verdict is
  // built on, and it must NOT be RELAY_OK.
  const silentStub = fnStub({ stdout: `RELAY_UNRESPONSIVE\n${JSON.stringify({ measured: false, reason: 'child-silent', mode: 'functional' })}\n` })
  const silentAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: silentStub.spawnImpl, now: () => 1_000 })
  check('WP-B/B6: RELAY_UNRESPONSIVE + child-silent ⇒ status UNRESPONSIVE, measured:false, relayOk:false (the relay answered, the child did not)',
    silentAnswer.status === UP.RELAY_UNRESPONSIVE
    && silentAnswer.measured === false
    && silentAnswer.reason === 'child-silent'
    && silentAnswer.relayOk === false
    && silentAnswer.status !== UP.RELAY_OK,
    `${silentAnswer.status} measured=${silentAnswer.measured} reason=${silentAnswer.reason}`)

  /* ---- B-7: SESSION BUSY IS NOT HEALTH ------------------------------ */
  // The relay answered RELAY_OK, so a careless consumer would call this a
  // healthy lane. NOBODY MEASURED the child, and the answer says so.
  const busyStub = fnStub({ stdout: `RELAY_OK\n${JSON.stringify({ measured: false, reason: 'session-busy', mode: 'functional' })}\n` })
  const busyAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: busyStub.spawnImpl, now: () => 1_000 })
  check('WP-B/B7: RELAY_OK with measured:false/session-busy ⇒ measured:false, reason session-busy — the accept loop health is never borrowed as child health',
    busyAnswer.status === UP.RELAY_OK
    && busyAnswer.measured === false
    && busyAnswer.reason === 'session-busy'
    && busyAnswer.tools === null,
    `${busyAnswer.status} measured=${busyAnswer.measured} reason=${busyAnswer.reason}`)

  /* ---- B-8: A TOKEN WITH NO EVIDENCE LINE --------------------------- */
  // `evidenceAt`/`evidence` must stay null (never a fabricated `0`) and the
  // promise must RESOLVE: a probe that can reject is a probe the doctor's
  // verdict path has to guard, which is how a health check takes a call down.
  let noJsonRejected = null
  const noJsonStub = fnStub({ stdout: 'RELAY_UNRESPONSIVE\n' })
  let noJsonAnswer = null
  try { noJsonAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: noJsonStub.spawnImpl, now: () => 1_000 }) } catch (error) { noJsonRejected = error }
  check('WP-B/B8: a token with NO JSON line ⇒ measured:false, reason no-evidence, evidence:null — and the probe RESOLVES (never rejects)',
    noJsonRejected === null
    && noJsonAnswer?.status === UP.RELAY_UNRESPONSIVE
    && noJsonAnswer?.measured === false
    && noJsonAnswer?.reason === 'no-evidence'
    && noJsonAnswer?.evidence === null
    && noJsonAnswer?.evidenceAt === null,
    noJsonRejected === null ? `${noJsonAnswer?.status}/${noJsonAnswer?.reason}` : String(noJsonRejected?.message ?? noJsonRejected))

  /* ---- B-9: NOTHING ON THE WIRE IS A TRANSPORT FACT ----------------- */
  // exit 255 is ssh's own "I never got a session". That is RELAY_DOWN, not
  // UNRESPONSIVE: the child was never asked, so nothing about it was measured.
  const downStub = fnStub({ stdout: '', stderr: 'ssh: connect to host 127.0.0.1 port 47222: Connection refused', exitCode: 255 })
  const downAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: downStub.spawnImpl, now: () => 1_000 })
  check('WP-B/B9: silence + exit 255 ⇒ status RELAY_DOWN (a TRANSPORT failure, NOT the child) with no measured claim',
    downAnswer.status === UP.RELAY_DOWN
    && downAnswer.measured === false
    && downAnswer.relayOk === false
    && downAnswer.connectionLevel === true
    && downAnswer.evidence === null,
    `${downAnswer.status} connectionLevel=${downAnswer.connectionLevel} exit=${downAnswer.exitCode}`)

  /* ---- B-10: EVIDENCE TYPING (C3) ----------------------------------- */
  // `null` means "the relay never delivered one"; `0` means "measured: no
  // restarts". Collapsing them is how `measured:false` became "all facts
  // false" in the desktop-facts defect — the same mistake, one file over.
  const typedStub = fnStub({ stdout: `RELAY_OK\n${JSON.stringify({ measured: true, reason: '', tools: 19, lastSuccessfulCallAgeMs: 412, outstandingRequestAgeMs: null, childRestarts: 0, lastWedgeAt: null, childPid: 77, wedgeDeadlineMs: 20000 })}\n` })
  const typedAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: typedStub.spawnImpl, now: () => 1_000 })
  check('WP-B/B10: evidence typing — 412 stays 412, an explicit null stays null (never 0), 0 stays 0, and an absent key is null',
    typedAnswer.evidence?.lastSuccessfulCallAgeMs === 412
    && typedAnswer.evidence?.outstandingRequestAgeMs === null
    && typedAnswer.evidence?.childRestarts === 0
    && typedAnswer.evidence?.lastWedgeAt === null
    && typedAnswer.evidence?.childPid === 77
    && typedAnswer.evidence?.wedgeDeadlineMs === 20000
    && UP.normalizeRelayEvidence({ lastSuccessfulCallAgeMs: -5, childRestarts: 'x' })?.lastSuccessfulCallAgeMs === null
    && UP.normalizeRelayEvidence({ at: 'now' }) === null,
    JSON.stringify(typedAnswer.evidence))

  /* ---- B-11: THE FACTS FIELD AND ITS OWNER -------------------------- */
  // `doctorFacts()` is synchronous and side-effect free, so it can only carry
  // the LAST answer. `null` before one ran is the honest value: nothing
  // measured is not a healthy child (C1.2).
  const factsClient = UP.createDshCuaClient({ name: 'wp-b-facts', sshPort: 1 })
  const factsAnswer = factsClient.doctorFacts()
  const fieldsText = String(UP.DOCTOR_FACTS_FIELDS ?? '')
  const namedKeys = ['lastSuccessfulCallAgeMs', 'outstandingRequestAgeMs', 'childRestarts', 'lastWedgeAt', 'childPid']
  check('WP-B/B11: doctorFacts() carries relayFunctional (null until a probe ran) and DOCTOR_FACTS_FIELDS names it plus the C3 evidence keys',
    'relayFunctional' in factsAnswer
    && factsAnswer.relayFunctional === null
    && typeof factsClient.relayFunctionalProbe === 'function'
    && fieldsText.includes('relayFunctional')
    && namedKeys.every((key) => fieldsText.includes(key)),
    `relayFunctional=${JSON.stringify(factsAnswer.relayFunctional)} keys=${namedKeys.filter((key) => fieldsText.includes(key)).length}/5`)

  /* ---- B-12: THE SENTENCE AN UNMEASURED REPAIR GETS ----------------- */
  // R1b, exactly: `forcedRepair.ok:false` with `reason:""` was the observable
  // result. The sentence names WHY and carries the record's own detail bytes.
  const unmeasuredSentence = String(UP.describeRepairRecord({ measured: false, unmeasured: 'no-record', detail: 'throttled (30000 ms)' }) ?? '')
  check('WP-B/B12: describeRepairRecord() for an UNMEASURED record is a non-empty sentence naming the unmeasured reason and the detail',
    unmeasuredSentence !== ''
    && unmeasuredSentence.includes('no-record')
    && unmeasuredSentence.includes('throttled (30000 ms)')
    && unmeasuredSentence.startsWith('the guest never answered the repair'),
    unmeasuredSentence)

  /* ---- B-13: A MEASURED RECORD SPEAKS FOR ITSELF -------------------- */
  // The other half of the same contract: `''` is reserved for the record whose
  // OWN `reason` is the diagnosis (`task-missing` here), so index.js can keep
  // it byte-identical. And `reason:""` is otherwise impossible: even a record
  // that does not say why gets `no-record` plus `no detail`.
  check('WP-B/B13: describeRepairRecord() for a MEASURED record that NAMED a cause is exactly \'\' (its own reason wins, byte-identical), and an unknown unmeasured value still yields words',
    UP.describeRepairRecord({ measured: true, ok: false, reason: 'task-missing' }) === ''
    && UP.describeRepairRecord({ measured: true, ok: true, reason: 'repaired' }) === ''
    && UP.describeRepairRecord(null) !== ''
    && UP.describeRepairRecord({ measured: false }) !== ''
    && String(UP.describeRepairRecord({ measured: false })).includes('no-record')
    && String(UP.describeRepairRecord({ measured: false, unmeasured: 'throttled' })).includes('no detail'),
    JSON.stringify(UP.describeRepairRecord({ measured: false })))

  /* ---- B-14: THE TRANSPORT HALF OF R3 ------------------------------- */
  //
  // Four facts, one transport:
  //   (a) the C5 ladder is 20 000 (guest) < 25 000 (transport) < 26 000
  //       (envelope) and every larger number DERIVES from the transport;
  //   (b) `callTool(..., {timeoutMs})` gives that request exactly that budget,
  //       so a 40 ms call beats the 60 s attach handshake by three orders of
  //       magnitude (B-14 of §4.3);
  //   (c) a per-call timeout is a REQUEST timeout: the child is not killed, the
  //       session survives and the next call answers on the SAME ssh child —
  //       which is what makes the plugin's one retry a request retry and not a
  //       transport reconnect (WIN_MCP_RETRY_SEMANTICS);
  //   (d) a guest `child-wedged:` answer is rethrown with `code:'child-wedged'`
  //       and the guest's sentence verbatim (C4.5/C6).
  const keepAlive = setInterval(() => {}, 1_000)
  let sessionSpawns = 0
  let sessionKills = 0
  const sessionSpawn = (_bin, argv) => {
    sessionSpawns += 1
    const remote = String(argv?.at(-1) ?? '')
    const isSession = remote.includes('--connect')
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.stdout.setEncoding = () => {}
    child.stderr.setEncoding = () => {}
    child.stdin.end = () => {}
    // ONLY the session child's death counts: `runSshCapture` kills a PROBE child
    // on purpose once it settles early, and that is not a reconnect.
    child.kill = () => { if (isSession) sessionKills += 1 }
    child.stdin.write = (data) => {
      for (const line of String(data ?? '').split('\n')) {
        if (line.trim() === '') continue
        let message = null
        try { message = JSON.parse(line) } catch { continue }
        if (message?.id === undefined) continue
        const send = (payload) => setTimeout(() => child.stdout.emit('data', `${JSON.stringify(payload)}\n`), 0)
        if (message.method === 'initialize') {
          send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'dsh-cua', version: '0.4.1' }, capabilities: { tools: {} } } })
        } else if (message.method === 'tools/list') {
          send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'tool_list_windows', description: 'x', inputSchema: { type: 'object' } }] } })
        } else if (message.method === 'tools/call') {
          const name = String(message.params?.name ?? '')
          if (name === 'tool_read_clipboard') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } })
          else if (name === 'tool_type_text') send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'child-wedged: the MCP server did not answer in 20000 ms; killed pid 42 (restart #1); the call did not return, so its effect is UNKNOWN - re-observe before retrying' } })
          // tool_list_windows stays SILENT: the per-call timer is the only thing
          // that can end it, which is the point of (b).
        }
      }
      return true
    }
    setTimeout(() => {
      if (isSession) return
      child.stdout.emit('data', 'RELAY_OK\n')
      child.emit('exit', 0)
      child.emit('close', 0)
    }, 0)
    return child
  }
  const ladder = UP.winMcpCallBudgets()
  const scaled = UP.winMcpCallBudgets(UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '200' }))
  let budgetError = null
  let wedgedError = null
  let retryResult = null
  let connectError = null
  const budgetClient = UP.createDshCuaClient({ name: 'wp-b-budget', sshPort: 47200, isOnline: async () => true, spawnImpl: sessionSpawn, timeoutMs: 60_000 })
  try {
    try { await budgetClient.connect() } catch (error) { connectError = error }
    const spawnsAfterConnect = sessionSpawns
    const startedAt = Date.now()
    try { await budgetClient.callTool('tool_list_windows', {}, { timeoutMs: 40 }) } catch (error) { budgetError = error }
    const budgetWallMs = Date.now() - startedAt
    try { retryResult = await budgetClient.callTool('tool_read_clipboard', {}, { timeoutMs: 500 }) } catch (error) { retryResult = error }
    try { await budgetClient.callTool('tool_type_text', {}, { timeoutMs: 500 }) } catch (error) { wedgedError = error }
    check('WP-B/B14: the C5 ladder (20 000 < 25 000 < 26 000) + an explicit 40 ms per-call budget that fires in <500 ms while the SESSION survives (no kill, no respawn) so the retry is a request retry, and `child-wedged:` becomes code child-wedged',
      connectError === null
      && UP.WIN_MCP_WEDGE_DEADLINE_MS === 20_000
      && UP.WIN_MCP_TRANSPORT_BUDGET_MS === 25_000
      && UP.WIN_MCP_CALL_ENVELOPE_MS === 26_000
      && ladder.wedgeDeadlineMs === 20_000 && ladder.transportMs === 25_000
      && ladder.envelopeMs === 26_000 && ladder.retryBudgetMs === 56_000 && ladder.guardMs === 30_000
      && ladder.wedgeDeadlineMs < ladder.transportMs && ladder.transportMs < ladder.envelopeMs
      && scaled.transportMs === 200 && scaled.envelopeMs === 1_200 && scaled.retryBudgetMs === 6_400
      && UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '999999' }) === 120_000
      && UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '1' }) === 200
      && budgetError?.code === 'timeout'
      && /within 40 ms/u.test(String(budgetError?.message ?? '')) === true
      && budgetWallMs < 500
      && sessionKills === 0 && sessionSpawns === spawnsAfterConnect
      && budgetClient.state.connected === true
      && retryResult?.content?.[0]?.text === 'ok'
      && wedgedError?.code === 'child-wedged'
      && String(wedgedError?.message ?? '').startsWith('child-wedged: the MCP server did not answer in 20000 ms'),
      `wall=${budgetWallMs}ms code=${budgetError?.code} kills=${sessionKills} spawns=${sessionSpawns} retry=${retryResult?.content?.[0]?.text} wedged=${wedgedError?.code}`)
  } finally {
    clearInterval(keepAlive)
    try { budgetClient.close() } catch { /* the fake session has no process */ }
  }

  /* ---- D3: NO DERIVED BUDGET ESCAPES THE DOCUMENTED ENVELOPE -------- */
  //
  // PRE-REVISE DEFECT #3. `DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS=120000` is inside the
  // env's frozen 200..120000 clamp, but the UNCLAMPED arithmetic derived
  // envelope 121 000 / retry 246 000 / guard 125 000 — three walls the harness
  // was never told about (`toolCallTimeoutMs: 120000`). The ladder is clamped to
  // WIN_MCP_TOOL_CALL_ENVELOPE_MS, so the ceiling setting degenerates honestly
  // (one 120 s attempt) instead of asking for a 246 s retry budget.
  const ceiling = UP.winMcpCallBudgets(UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '120000' }))
  const sweep = ['200', '25000', '57000', '119999', '120000', '999999'].map((value) =>
    UP.winMcpCallBudgets(UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: value })))
  check('WP-B/D3: every DERIVED budget is clamped to the documented 120 000 toolCallTimeoutMs envelope (at the transport ceiling: 120000/120000/120000, not 121000/246000/125000)',
    UP.WIN_MCP_TOOL_CALL_ENVELOPE_MS === 120_000
    && ceiling.transportMs === 120_000
    && ceiling.envelopeMs === 120_000
    && ceiling.retryBudgetMs === 120_000
    && ceiling.guardMs === 120_000
    && sweep.every((budget) => budget.envelopeMs <= 120_000
      && budget.retryBudgetMs <= 120_000
      && budget.guardMs <= 120_000)
    // ...and the frozen default ladder is untouched by the clamp.
    && JSON.stringify(UP.winMcpCallBudgets()) === JSON.stringify({
      wedgeDeadlineMs: 20_000, transportMs: 25_000, envelopeMs: 26_000, retryBudgetMs: 56_000, guardMs: 30_000
    })
    // ...and 57 000 is the largest transport that still derives the full retry
    // budget inside the envelope (58 000 envelope ⇒ exactly 120 000).
    && UP.winMcpCallBudgets(57_000).retryBudgetMs === 120_000,
    `ceiling=${ceiling.envelopeMs}/${ceiling.retryBudgetMs}/${ceiling.guardMs} sweepMax=${Math.max(...sweep.map((b) => b.retryBudgetMs))}`)

  /* ---- D5: ONE KNOB, ONE ROUNDING (win-mcp.js === index.js) ---------- */
  //
  // PRE-REVISE DEFECT #5: win-mcp.js used `Math.round` while index.js's
  // winMcpCallTimeoutMs() uses `Math.floor`, so '25000.5' became 25 001 in the
  // transport and 25 000 in the plugin — a 1 ms split budget nobody can see.
  // Both readers now FLOOR, and the check pins BOTH halves: the behaviour here,
  // and the literal in the other file (the cross-file half is a source slice,
  // because index.js does not export its reader and importing the plugin would
  // register tools as a side effect).
  const winSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'win-mcp.js'), 'utf8')
  const indexSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
  const readerSlice = (source, marker) => {
    const start = source.indexOf(marker)
    if (start === -1) return ''
    const end = source.indexOf('\n}\n', start)
    return end === -1 ? source.slice(start, start + 1_500) : source.slice(start, end + 2)
  }
  const transportReader = readerSlice(winSource, 'export function winMcpTransportBudgetMs(')
  const pluginReader = readerSlice(indexSource, 'function winMcpCallTimeoutMs()')
  check('WP-B/D5: a fractional override floors in BOTH readers ("25000.5" ⇒ 25000, never 25001) — one knob, one rounding, no split budget',
    UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '25000.5' }) === 25_000
    && UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '25000.9' }) === 25_000
    && UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '25000.0' }) === 25_000
    // ...a sub-1 ms value floors to 0, which both readers treat as UNSET.
    && UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '0.5' }) === UP.WIN_MCP_TRANSPORT_BUDGET_MS
    // THE CROSS-FILE HALF: both reader bodies say Math.floor, neither says Math.round.
    && transportReader.includes('Math.floor(')
    && transportReader.includes('Math.round(') === false
    && pluginReader.includes('Math.floor(')
    && pluginReader.includes('Math.round(') === false
    // ...the SAME env name: win-mcp.js reads it through its exported constant,
    // index.js spells the literal — both must name one variable.
    && transportReader.includes('WIN_MCP_CALL_TIMEOUT_ENV')
    && UP.WIN_MCP_CALL_TIMEOUT_ENV === 'DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS'
    && pluginReader.includes('DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS'),
    `25000.5 ⇒ ${UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '25000.5' })}; readers: win=${transportReader.length}B index=${pluginReader.length}B floor=${transportReader.includes('Math.floor(')}/${pluginReader.includes('Math.floor(')}`)

  /* ---- D8: A MEASURED REPAIR WITH NO REASON IS NOT SILENCE ---------- */
  //
  // PRE-REVISE DEFECT #8: `measured:true` returned `''` unconditionally, so a
  // measured, FAILED repair whose guest sentence was empty still surfaced as
  // `forcedRepair.reason:''` — the R1b silence, one branch further in. A record
  // that NAMED a cause keeps the byte-identical `''` path (the caller keeps the
  // record's own reason); a record that did not name one now says so.
  const unreasoned = String(UP.describeRepairRecord({ measured: true, ok: false }) ?? '')
  const unreasonedDetail = String(UP.describeRepairRecord({ measured: true, ok: true, detail: 'probe RELAY_OK' }) ?? '')
  check('WP-B/D8: a MEASURED record with an EMPTY reason is a non-empty honest sentence (never \'\'), while the measured-with-own-reason path stays byte-identical \'\'',
    unreasoned === 'the repair ran and reported no reason'
    && unreasonedDetail === 'the repair ran and reported no reason: probe RELAY_OK'
    && UP.describeRepairRecord({ measured: true, ok: false, reason: '' }) !== ''
    && UP.describeRepairRecord({ measured: true, ok: false, reason: 'task-missing' }) === ''
    && UP.describeRepairRecord({ measured: true, ok: false, reason: 'no-interactive-session' }) === '',
    JSON.stringify({ unreasoned, unreasonedDetail, named: UP.describeRepairRecord({ measured: true, ok: false, reason: 'task-missing' }) }))

  /* ---- D9: THE CLOSED REASON SET IS EXACTLY WHAT A PRODUCER EMITS --- */
  //
  // The set is a CLOSED vocabulary, and a member no producer can emit is a word
  // the doctor's sentences were never written for. `'wedge'` was that member:
  // the program's exits are ''/child-silent/child-eof/session-busy/no-evidence,
  // and the relay's RELAY_FN evidence carries no `reason` field at all — a wedge
  // is visible as `event('wedge', …)` / `lastWedgeAt`, never as an answer. It is
  // gone from the constant (a guest that claims it now normalizes to
  // 'no-evidence', exactly like any other out-of-set value), and this check pins
  // the EXACT five members so a surplus one cannot come back.
  const reasonSet = UP.RELAY_FN_REASONS
  const reasonStub = (reason) => fnStub({ stdout: `RELAY_UNRESPONSIVE\n${JSON.stringify({ measured: false, reason, mode: 'functional' })}\n` })
  const emitted = []
  for (const reason of ['child-silent', 'child-eof', 'session-busy', 'no-evidence']) {
    const answer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: reasonStub(reason).spawnImpl, now: () => 1_000 })
    emitted.push(answer.reason)
  }
  const wedgeStubAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: reasonStub('wedge').spawnImpl, now: () => 1_000 })
  check('WP-B/D9: RELAY_FN_REASONS is EXACTLY the producer-emitted reasons (no surplus `wedge`; `probe-unsupported` is the cold-boot round\'s sixth), frozen, and an out-of-set reason normalizes to no-evidence',
    Array.isArray(reasonSet) === true
    && Object.isFrozen(reasonSet) === true
    && reasonSet.length === 6
    && JSON.stringify(reasonSet) === JSON.stringify(['', 'child-silent', 'child-eof', 'session-busy', 'no-evidence', 'probe-unsupported'])
    && reasonSet.includes('wedge') === false
    && reasonSet.includes('') === true
    // every member that names a cause survives the round trip…
    && JSON.stringify(emitted) === JSON.stringify(['child-silent', 'child-eof', 'session-busy', 'no-evidence'])
    // …and a retired member is not forwarded, it is replaced by the honest one.
    && wedgeStubAnswer.reason === 'no-evidence'
    && wedgeStubAnswer.reason !== 'wedge',
    `${JSON.stringify(reasonSet)} | emitted=${JSON.stringify(emitted)} | wedge⇒${wedgeStubAnswer.reason}`)
}

/* ================================================================== *
 * COLD-BOOT ROUND (6th) — PACKAGE A: win-mcp.js, CB-1..CB-17
 *
 * RC-1..RC-4, transport half. The four behaviours, in the order the plan
 * lands them: the guard staging carrier and its five-value outcome (CB-1..CB-5,
 * WP-1B), the boot-race window and its ladder (CB-6..CB-9, CB-17, WP-2A),
 * `probe-unsupported` and the third producer of payload.skew (CB-10..CB-13,
 * WP-3A), and the language-free facts-file-absent ladder (CB-14..CB-16, WP-4A).
 * ================================================================== */
{
  const UP = winMcpApi
  const HEX_A = 'a'.repeat(64)
  const HEX_B = 'b'.repeat(64)
  const HEX_C = 'c'.repeat(64)
  const guardSource = typeof UP.guardExpectedHashSource === 'function' ? UP.guardExpectedHashSource() : null
  const guardBytes = guardSource === null ? null : readFileSync(guardSource)
  const expectedGuard = typeof UP.expectedGuardHash === 'function' ? UP.expectedGuardHash() : null
  // The real payload on this checkout; a synthetic carrier of the SAME base64
  // length on a bundle without `docker/`, so the geometry is asserted either way.
  const guardBase64 = guardBytes === null ? 'A'.repeat(43456) : guardBytes.toString('base64')
  const planExpected = expectedGuard ?? HEX_A

  /* ---- CB-1: THE PLAN'S ORDER AND GEOMETRY -------------------------- */
  // C2 rule 2/3/5 + D2/D4: measure → 8 appends → decode → verify → register.
  // The APPENDS are `cmd` children (≈0.15 s) and the DECISIONS are PowerShell
  // (≈2.9 s) — the mix is what makes the plan fit its budget (CB-20).
  const stagePlan = UP.relayGuardStagePlan({ base64: guardBase64, expectedHash: planExpected, expectedRelay: HEX_B, taskPresent: false, port: 47999 })
  const stageKinds = stagePlan.map((step) => step.kind)
  const appends = stagePlan.filter((step) => step.kind === 'append')
  const appendChunks = appends.map((step) => /cmd \/c "echo (\S+) [>]{1,2}/u.exec(step.command)?.[1] ?? '')
  check('CB-1: the staging plan is measure → 8 appends → decode → verify → register, every child cmd-line-safe (< 8191) and every append carrying base64 through cmd (no quoting hazard)',
    stageKinds[0] === 'measure'
    && appends.length === 8
    && stageKinds.at(-3) === 'decode' && stageKinds.at(-2) === 'verify' && stageKinds.at(-1) === 'register'
    && stagePlan.length === 12
    && stagePlan.every((step) => typeof step.command === 'string' && step.command.length < 8_191)
    // Appends are `cmd /c "echo <chunk> >|>> <carrier>"`: chunk 0 truncates.
    && appends[0].command.includes(`cmd /c "echo `)
    && appends[0].command.includes(' >C:\\ProgramData\\cua\\cua-relay-guard.b64"')
    && appends.slice(1).every((step) => step.command.includes(' >>C:\\ProgramData\\cua\\cua-relay-guard.b64"'))
    && appendChunks.every((chunk) => /^[A-Za-z0-9+/=]+$/u.test(chunk))
    && appendChunks.join('') === guardBase64
    // The three DECISIONS stay PowerShell, and the decoder strips the whitespace
    // `echo` adds (the live-tested pair).
    && ['measure', 'decode', 'verify'].every((kind) => stagePlan.find((step) => step.kind === kind)?.command.startsWith('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "'))
    && stagePlan.find((step) => step.kind === 'decode')?.command.includes("-replace '\\s',''")
    && stagePlan.find((step) => step.kind === 'verify')?.command.includes("Get-FileHash")
    && stagePlan[0].command.includes('CUA_PAYLOAD')
    && stagePlan.at(-1).command.startsWith('schtasks /create /tn "cua-mcp-host-guard" /sc onstart /ru SYSTEM /rl HIGHEST /f ')
    && stagePlan.at(-1).command.includes('-Boot -Port 47999'),
    `${stageKinds.join(',')} (${stagePlan.length} steps, ${appends.length} appends, max=${Math.max(...stagePlan.map((step) => step.command.length))} chars)`)

  /* ---- CB-2: A HEAD GUEST STAGES NOTHING (AND A TASK-LESS ONE STILL
   *            REGISTERS) ------------------------------------------------ */
  // C2 rule 3 + D3: the measure is the whole plan only when the file matches AND
  // the task exists. A matching file with a missing/unknown task still registers.
  const currentPlan = UP.relayGuardStagePlan({ base64: guardBase64, expectedHash: planExpected, measuredHash: planExpected, expectedRelay: HEX_B, taskPresent: true, port: 47999 })
  const tasklessPlan = UP.relayGuardStagePlan({ base64: guardBase64, expectedHash: planExpected, measuredHash: planExpected, expectedRelay: HEX_B, taskPresent: false, port: 47999 })
  const unknownTaskPlan = UP.relayGuardStagePlan({ base64: guardBase64, expectedHash: planExpected, measuredHash: planExpected, expectedRelay: HEX_B, taskPresent: null, port: 47999 })
  const stalePlan = UP.relayGuardStagePlan({ base64: guardBase64, expectedHash: planExpected, measuredHash: HEX_C, expectedRelay: HEX_B, taskPresent: true, port: 47999 })
  check('CB-2: a matching hash WITH the task present yields the measure alone (no write), while a matching hash with the task absent/unverified yields measure+register — and a differing hash yields the full plan',
    currentPlan.length === 1 && currentPlan[0].kind === 'measure'
    && currentPlan.every((step) => step.kind !== 'append' && step.kind !== 'register')
    && tasklessPlan.length === 2 && tasklessPlan[1].kind === 'register'
    && unknownTaskPlan.length === 2 && unknownTaskPlan[1].kind === 'register'
    && stalePlan.length === 12 && stalePlan.filter((step) => step.kind === 'append').length === 8
    && stalePlan.at(-1).kind === 'register',
    `current=${currentPlan.length} taskless=${tasklessPlan.length} unknown=${unknownTaskPlan.length} stale=${stalePlan.length}`)

  /* ---- CB-3: THE FLAG IS THE GATE (spy spawn count) ------------------ */
  // C2 rule 4, the most dangerous mistake available: the 15 s poll calls
  // repairRelay() WITHOUT payloadRepair, so it stages nothing. The forced path
  // runs the launcher CARRIER (5 children: D2) plus the 12-step plan = 17.
  const spyStub = (verifyGuard, { measureGuard = '', taskAtMeasure = 0, lineStale = null } = {}) => {
    const calls = []
    let hashes = 0
    const spawnImpl = (_bin, argv) => {
      const remote = String(argv?.at(-1) ?? '')
      calls.push(remote)
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      let out = ''
      if (remote.includes('Invoke-Expression')) {
        // The last child of the launcher CARRIER (D2) runs the staged script.
        out = `CUA_RELAY ok=1 port=47999 task=1 running=1 session=2 probe=RELAY_OK hash=${HEX_B} mode=handshake reason=\n`
      } else if (remote.includes('schtasks /create')) {
        out = `${'CUA_PAYLOAD'} task=1\n`
      } else if (remote.includes('Get-FileHash')) {
        hashes += 1
        const isVerify = hashes > 1
        const guard = isVerify ? verifyGuard : measureGuard
        const staged = guard === planExpected ? (isVerify ? 'staged' : 'current') : 'incomplete'
        const task = isVerify ? 1 : taskAtMeasure
        // The guest applies C6 now; `lineStale` lets a check FORCE a disagreeing
        // line to prove the harness ignores it (D5).
        const stale = lineStale === null ? (staged === 'staged' ? 0 : 1) : lineStale
        out = `CUA_PAYLOAD guard=${guard} relay=${HEX_B} stale=${stale} staged=${staged} task=${task}\n`
      }
      setTimeout(() => {
        if (out !== '') child.stdout.emit('data', out)
        child.emit('close', 0)
      }, 0)
      return child
    }
    return { calls, spawnImpl }
  }
  UP.resetRelayRepairState()
  const pollSpy = spyStub(planExpected)
  const pollRecord = await UP.repairRelay({ port: 47999, force: true, spawnImpl: pollSpy.spawnImpl, now: () => 1_000, log: () => {} })
  const pollStaging = pollSpy.calls.filter((command) => command.includes('Get-FileHash') || command.includes('schtasks /create')).length
  UP.resetRelayRepairState()
  const forcedSpy = spyStub(planExpected)
  const forcedRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: forcedSpy.spawnImpl, now: () => 1_000, log: () => {} })
  UP.resetRelayRepairState()
  check('CB-3: `payloadRepair !== true` stages NOTHING (1 carrier child set, 0 payload steps), while the forced path runs the 5-child carrier + the 12-step plan (17 children) and reports the task',
    pollRecord.disabled !== true
    && pollSpy.calls.length === 5 && pollStaging === 0
    && pollRecord.payload.staged === 'none'
    && forcedSpy.calls.length === 17
    && forcedRecord.payload.staged === 'staged'
    && forcedRecord.payload.guardHash === planExpected
    && forcedRecord.payload.task === true,
    `poll=${pollSpy.calls.length} child(ren)/${pollStaging} staging, forced=${forcedSpy.calls.length} child(ren), staged=${forcedRecord.payload.staged} task=${forcedRecord.payload.task}`)

  /* ---- CB-4: THE SECOND RECORD LINE AND ITS CLOSED SET -------------- */
  // C2 rule 9/10: `CUA_PAYLOAD` is a SECOND line (the frozen `CUA_RELAY` grammar
  // is untouched), `staged` is one of exactly five words, and anything that does
  // not parse to one of them is `incomplete` — never `staged`.
  const payloadLine = (guard, relay, stale, staged) => `CUA_PAYLOAD guard=${guard} relay=${relay} stale=${stale} staged=${staged}\n`
  const goodPayload = UP.parseCuaPayloadRecord(payloadLine(HEX_A, HEX_B, 1, 'staged'))
  const worded = ['current', 'staged', 'incomplete'].map((word) => UP.parseCuaPayloadRecord(payloadLine('', '', 0, word))?.staged)
  check('CB-4: `CUA_PAYLOAD` parses guard/relay/stale/staged, `staged` is exactly the five closed values, and a malformed or unknown answer is `incomplete`',
    goodPayload?.guardHash === HEX_A && goodPayload?.relayHash === HEX_B
    && goodPayload?.guardPresent === true && goodPayload?.relayPresent === true
    && goodPayload?.stale === true && goodPayload?.staged === 'staged'
    && JSON.stringify(UP.PAYLOAD_STAGED_VALUES) === JSON.stringify(['none', 'current', 'staged', 'incomplete', 'absent'])
    && JSON.stringify(worded) === JSON.stringify(['current', 'staged', 'incomplete'])
    && UP.parseCuaPayloadRecord(payloadLine('', '', 0, 'yes'))?.staged === 'incomplete'
    && UP.parseCuaPayloadRecord(payloadLine('', '', 9, 'staged'))?.stale === null
    && UP.parseCuaPayloadRecord(payloadLine('', '', 0, 'staged'))?.guardHash === null
    && UP.parseCuaPayloadRecord('CUA_PAYLOAD\n')?.staged === 'incomplete'
    && UP.parseCuaPayloadRecord('') === null,
    `${JSON.stringify({ guardHash: goodPayload?.guardHash?.slice(0, 6), staged: goodPayload?.staged, unknown: UP.parseCuaPayloadRecord(payloadLine('', '', 0, 'yes'))?.staged })}`)

  /* ---- CB-5: THE STAGING BUDGET FITS THE FORCED REPAIR -------------- */
  // C2 rule 8 / C9: 25 000 < WIN_MCP_FORCE_REPAIR_MS (30 000). The right-hand
  // number is read from index.js — a second literal here would be a copy, not a
  // cross-file agreement.
  const indexSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
  const forcedMsMatch = /const WIN_MCP_FORCE_REPAIR_MS = ([\d_]+)/u.exec(indexSource)
  const forcedMs = forcedMsMatch === null ? null : Number(forcedMsMatch[1].replace(/_/gu, ''))
  check('CB-5: RELAY_PAYLOAD_REPAIR_TIMEOUT_MS (25 000) is STRICTLY inside index.js\'s WIN_MCP_FORCE_REPAIR_MS (30 000) — the doctor\'s forced repair can always hear the staging answer',
    UP.RELAY_PAYLOAD_REPAIR_TIMEOUT_MS === 25_000
    && forcedMs === 30_000
    && UP.RELAY_PAYLOAD_REPAIR_TIMEOUT_MS < forcedMs,
    `payload=${UP.RELAY_PAYLOAD_REPAIR_TIMEOUT_MS} forced=${forcedMs}`)

  /* ---- CB-6: THE WINDOW'S TRUTH TABLE ------------------------------- */
  // C1 rules 2-4, pure: the stream anchor wins, 'none' is never live, and a
  // MEASURED fact (a repair that measured session/hash) outranks the window.
  const T = 1_000_000
  const windowAt = (patch) => UP.bootRaceFacts({ nowMs: T, ...patch })
  const inside = windowAt({ readyAt: T - 1_000, attachedAt: T - 30_000 })
  check('CB-6: bootRaceFacts — readyAt wins over attachedAt, source is closed (stream|attach|none), \'none\' is never live, and a MEASURED fact outranks the window',
    inside.live === true && inside.source === 'stream' && inside.sinceReadyMs === 1_000 && inside.remainingMs === 89_000
    && windowAt({ attachedAt: T - 1_000 }).source === 'attach'
    && windowAt({}).source === 'none' && windowAt({}).live === false && windowAt({}).sinceReadyMs === null
    && windowAt({ readyAt: T - 90_000 }).live === false
    && windowAt({ readyAt: T + 5_000 }).live === false
    && windowAt({ readyAt: T - 1_000, measured: true }).live === false
    && windowAt({ readyAt: T - 1_000 }).remainingMs > 0
    && typeof UP.BOOT_RACE_WINDOW_MS === 'number' && UP.BOOT_RACE_WINDOW_MS === 90_000
    && UP.BOOT_RACE_ATTACH_MS === 24_000 && UP.BOOT_RACE_PROBE_TIMEOUT_MS === 4_000,
    `${JSON.stringify({ live: inside.live, source: inside.source, since: inside.sinceReadyMs, remaining: inside.remainingMs })}`)

  /* ---- CB-7/CB-8/CB-9: THE LADDER ----------------------------------- */
  const ladderStub = () => {
    const calls = []
    const spawnImpl = (_bin, argv) => {
      calls.push(String(argv?.at(-1) ?? ''))
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      setTimeout(() => {
        child.stdout.emit('data', 'RELAY_DOWN\n')
        child.emit('close', 0)
      }, 0)
      return child
    }
    return { calls, spawnImpl }
  }
  const fakeClock = { now: T, sleeps: [] }
  const fakeSleep = async (ms) => { fakeClock.sleeps.push(ms); fakeClock.now += ms }
  const fakeNow = () => fakeClock.now
  UP.resetRelayProbeCache()
  fakeClock.sleeps = []
  const liveStub = ladderStub()
  const liveFacts = await UP.resolveGuestMcpTransport({
    port: 47999, spawnImpl: liveStub.spawnImpl, now: fakeNow, sleep: fakeSleep,
    bootWindow: () => fakeClock.now - 1_000
  })
  check('CB-7: inside a live window the ladder waits EXACTLY [8000, 12000] ms and stops — the frozen offsets, not a poll',
    JSON.stringify(fakeClock.sleeps) === JSON.stringify([8000, 12_000])
    && liveFacts.ladder === true
    && liveFacts.bootRace.live === true
    && liveFacts.transport === 'session-0-direct',
    `sleeps=${JSON.stringify(fakeClock.sleeps)} ladder=${liveFacts.ladder}`)

  UP.resetRelayProbeCache()
  fakeClock.sleeps = []
  const outsideStub = ladderStub()
  const outsideFacts = await UP.resolveGuestMcpTransport({
    port: 47999, spawnImpl: outsideStub.spawnImpl, now: fakeNow, sleep: fakeSleep,
    bootWindow: () => fakeClock.now - 200_000
  })
  UP.resetRelayProbeCache()
  fakeClock.sleeps = []
  process.env.DSH_CUA_WIN_MCP_COMMAND = 'python -m dsh_cua.server --stdio'
  const overrideStub = ladderStub()
  let overrideFacts = null
  try {
    overrideFacts = await UP.resolveGuestMcpTransport({
      port: 47999, spawnImpl: overrideStub.spawnImpl, now: fakeNow, sleep: fakeSleep,
      bootWindow: () => fakeClock.now - 1_000
    })
  } finally {
    delete process.env.DSH_CUA_WIN_MCP_COMMAND
  }
  check('CB-8: NO ladder outside the window (one probe, zero waits) and NO ladder when a command override is set — a decision is not a late logon task',
    outsideFacts.ladder === false && outsideStub.calls.length === 1 && fakeClock.sleeps.length === 0
    && overrideFacts?.override === true && overrideFacts?.ladder === false
    && overrideStub.calls.length === 1,
    `outside=${outsideStub.calls.length} child(ren)/${outsideFacts.ladder}, override=${overrideStub.calls.length} child(ren)/${overrideFacts?.ladder}`)

  UP.resetRelayProbeCache()
  fakeClock.sleeps = []
  const forcedStub = ladderStub()
  const forcedFacts = await UP.resolveGuestMcpTransport({
    port: 47999, spawnImpl: forcedStub.spawnImpl, now: fakeNow, sleep: fakeSleep,
    bootWindow: () => fakeClock.now - 1_000
  })
  const winMcpSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'win-mcp.js'), 'utf8')
  check('CB-9: every ladder probe passes `force: true` — a cached DOWN cannot make the ladder decorative (3 children, not the 1 a cache hit would cost)',
    forcedStub.calls.length === 3
    && forcedFacts.relayStatus === 'RELAY_DOWN'
    && /async function bootRaceProbeLadder\(/u.test(winMcpSource)
    && winMcpSource.includes('force: true, timeoutMs: BOOT_RACE_PROBE_TIMEOUT_MS'),
    `${forcedStub.calls.length} probe child(ren), status=${forcedFacts.relayStatus}`)

  /* ---- CB-10: THE THREE WORLDS OF THE EVIDENCE READ ------------------ */
  // C3: connected + RELAY_FN sent + ZERO bytes back is `probe-unsupported`; a
  // refused TCP connect and a garbage answer both stay `no-evidence`. Driven
  // through the REAL program against local sockets (python3), because the
  // decision lives in the Python, not in the host's parser.
  const pythonReady = (() => {
    try {
      const probe = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8', timeout: 10_000 })
      return probe.status === 0
    } catch {
      return false
    }
  })()
  const freePort = async () => {
    const server = net.createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await new Promise((resolve) => server.close(resolve))
    return port
  }
  const runProgram = (port) => new Promise((resolve) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cb-fn-'))
    const file = path.join(dir, 'probe.py')
    writeFileSync(file, UP.relayFunctionalProbeProgram(port))
    const child = spawn('python3', [file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => { try { child.kill() } catch {} finish({ token: '', reason: null }) }, 20_000)
    timer.unref?.()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('close', (code) => {
      clearTimeout(timer)
      const lines = String(out).trim().split('\n')
      let json = null
      try { json = JSON.parse(lines.at(-1)) } catch {}
      finish({ token: lines[0], reason: json?.reason, code })
    })
  })
  let worlds = null
  if (pythonReady === true) {
    const destroyPort = await freePort()
    const destroyServer = net.createServer((socket) => socket.destroy())
    await new Promise((resolve) => destroyServer.listen(destroyPort, '127.0.0.1', resolve))
    let destroyWorld = null
    try { destroyWorld = await runProgram(destroyPort) } finally { await new Promise((resolve) => destroyServer.close(resolve)) }
    const closedWorld = await runProgram(await freePort())
    const garbagePort = await freePort()
    const garbageServer = net.createServer((socket) => { socket.on('data', () => socket.write('GARBAGE\n')) })
    await new Promise((resolve) => garbageServer.listen(garbagePort, '127.0.0.1', resolve))
    let garbageWorld = null
    try { garbageWorld = await runProgram(garbagePort) } finally { await new Promise((resolve) => garbageServer.close(resolve)) }
    worlds = { destroy: destroyWorld, closed: closedWorld, garbage: garbageWorld }
  }
  check('CB-10: `probe-unsupported` ONLY for connected + RELAY_FN sent + zero bytes (a refused connect and a garbage answer stay `no-evidence`)',
    pythonReady !== true
      ? (() => {
          // No python3 on this host: the DECISION is still asserted through its
          // source shape (the same predicate), and the detail says so.
          const program = UP.relayFunctionalProbeProgram(47999)
          return program.includes("('probe-unsupported' if (_connected and _sent and _bytes == 0) else 'no-evidence')")
        })()
      : (worlds?.destroy?.token === 'RELAY_UNRESPONSIVE' && worlds?.destroy?.reason === 'probe-unsupported'
          && worlds?.destroy?.code === 3
          && worlds?.closed?.reason === 'no-evidence'
          && worlds?.garbage?.reason === 'no-evidence'),
    pythonReady !== true
      ? 'python3 absent — the predicate is asserted from the program source'
      : JSON.stringify({ destroy: worlds?.destroy?.reason, closed: worlds?.closed?.reason, garbage: worlds?.garbage?.reason }))

  /* ---- CB-11: THE FLAGS SURVIVE AN EXCEPTION ------------------------ */
  // C3: the three flags are initialised OUTSIDE the try, then set as the read
  // progresses — so an exception inside the read cannot erase the evidence that
  // the socket was connected and the token was sent.
  const probeProgram = UP.relayFunctionalProbeProgram(47999)
  const iInit = probeProgram.indexOf('_connected = False')
  const iTry = probeProgram.indexOf('try:')
  const iConnected = probeProgram.indexOf('_connected = True')
  const iSent = probeProgram.indexOf("sendall(b'RELAY_FN')")
  const iUnsupported = probeProgram.indexOf("'probe-unsupported'")
  check('CB-11: the three evidence flags are initialised BEFORE the try and set in order (connected → sent → bytes), so an exception cannot lose them',
    iInit !== -1 && iTry !== -1
    && iInit < iTry && iTry < iConnected && iConnected < iSent && iSent < iUnsupported
    && probeProgram.includes('_sent = False') && probeProgram.includes('_bytes = 0')
    && probeProgram.includes('_bytes = len(_b)'),
    `init=${iInit} try=${iTry} connected=${iConnected} sent=${iSent} reason=${iUnsupported}`)

  /* ---- CB-12: THE SIX-MEMBER CLOSED SET ----------------------------- */
  // C3 / §4.1 row 8: six members, `''` still first, and anything outside the set
  // normalizes to `no-evidence` instead of reaching the doctor's sentences.
  const reasonProbe = (reason) => {
    const child = new EventEmitter()
    const spawnImpl = () => {
      const instance = new EventEmitter()
      instance.stdout = new EventEmitter()
      instance.stderr = new EventEmitter()
      instance.stdout.setEncoding = () => {}
      instance.stderr.setEncoding = () => {}
      instance.kill = () => {}
      setTimeout(() => {
        instance.stdout.emit('data', `RELAY_UNRESPONSIVE\n${JSON.stringify({ measured: false, reason, mode: 'functional' })}\n`)
        instance.emit('close', 0)
      }, 0)
      return instance
    }
    void child
    return spawnImpl
  }
  const supportedAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: reasonProbe('probe-unsupported'), now: () => 1_000 })
  const unknownAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: reasonProbe('probe-unknown'), now: () => 1_000 })
  const reasons = UP.RELAY_FN_REASONS
  check('CB-12: RELAY_FN_REASONS is six members with \'\' first (probe-unsupported last), frozen, and an unknown reason still normalizes to no-evidence',
    Array.isArray(reasons) && Object.isFrozen(reasons) && reasons.length === 6
    && JSON.stringify(reasons) === JSON.stringify(['', 'child-silent', 'child-eof', 'session-busy', 'no-evidence', 'probe-unsupported'])
    && supportedAnswer.reason === 'probe-unsupported'
    && unknownAnswer.reason === 'no-evidence',
    `${JSON.stringify(reasons)} | unknown⇒${unknownAnswer.reason}`)

  /* ---- CB-13: payload.skew'S THIRD PRODUCER ------------------------- */
  // C3: `probe-unsupported` means "the relay ANSWERED (accept loop) and the
  // probe could not read an answer" — the same class as SKEW/BAD, and NOT the
  // same as `no-evidence` (which stays false).
  check('CB-13: relayEvidenceSkew gains `probe-unsupported` as its third producer (true), keeps `no-evidence` false, and the semantics sentence names it',
    UP.relayEvidenceSkew(UP.RELAY_UNRESPONSIVE, null, 'probe-unsupported') === true
    && UP.relayEvidenceSkew(UP.RELAY_UNRESPONSIVE, null, 'no-evidence') === false
    && UP.relayEvidenceSkew(UP.RELAY_UNRESPONSIVE, null, '') === false
    && UP.relayEvidenceSkew(UP.RELAY_SKEW, null, '') === true
    && UP.relayEvidenceSkew(UP.RELAY_UNRESPONSIVE, { reason: 'probe-skew' }, '') === true
    && UP.PAYLOAD_SKEW_SEMANTICS.includes('probe-unsupported'),
    `supported=${UP.relayEvidenceSkew(UP.RELAY_UNRESPONSIVE, null, 'probe-unsupported')} no-evidence=${UP.relayEvidenceSkew(UP.RELAY_UNRESPONSIVE, null, 'no-evidence')}`)

  /* ---- CB-14/CB-15/CB-16: THE FACTS-FILE LADDER --------------------- */
  // C4, language-free: the code is decided by stdout emptiness and the capture's
  // connectionLevel, never by the guest's localized sentence.
  const desktopStub = ({ stdout = '', stderr = '', exitCode = 0 }) => (_bin, argv) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdout.setEncoding = () => {}
    child.stderr.setEncoding = () => {}
    child.kill = () => {}
    setTimeout(() => {
      if (stdout !== '') child.stdout.emit('data', stdout)
      if (stderr !== '') child.stderr.emit('data', stderr)
      child.emit('close', exitCode)
    }, 0)
    return child
  }
  const readFacts = (spec, port) => UP.desktopFacts({ name: `cb4-${port}`, port, spawnImpl: desktopStub(spec), now: () => 1_000, force: true })
  const absentLocalized = await readFacts({ stderr: 'The system cannot find the path specified.\r\n', exitCode: 1 }, 41_101)
  const absentSilent = await readFacts({ exitCode: 1 }, 41_102)
  check('CB-14: an empty stdout means facts-file-absent — with a LOCALIZED stderr and with no stderr at all (the rule never reads English)',
    absentLocalized.errorCode === UP.DESKTOP_FACTS_ABSENT
    && absentSilent.errorCode === 'facts-file-absent'
    && absentLocalized.error === 'facts-file-absent: C:\\cua-work\\cua-desktop-facts.json (the guest payload may predate the facts writer)'
    && absentSilent.error === absentLocalized.error
    && absentLocalized.measured === false
    && absentLocalized.error.includes('cannot find') === false,
    `${absentLocalized.errorCode} / ${absentSilent.errorCode}`)

  const unparsable = await readFacts({ stdout: 'this is not json' }, 41_103)
  check('CB-15: stdout that is NOT JSON is facts-unparsable (the file exists; the payload wrote something else) — never facts-file-absent',
    unparsable.errorCode === 'facts-unparsable'
    && unparsable.measured === false
    && unparsable.error === 'this is not json',
    `${unparsable.errorCode}: ${unparsable.error}`)

  const sshFailed = await readFacts({ stderr: 'Connection closed by 127.0.0.1 port 22', exitCode: 255 }, 41_104)
  check('CB-16: a connection-level capture is ssh-failed (the read never reached the guest, so its empty stdout is NOT a missing file)',
    sshFailed.errorCode === 'ssh-failed'
    && sshFailed.connectionLevel === true
    && sshFailed.measured === false,
    `${sshFailed.errorCode} connectionLevel=${sshFailed.connectionLevel}`)

  /* ---- CB-17: THE THROTTLE MOVED, NOT THE TIMER --------------------- */
  // C1 rule 7: the 15 s setInterval is untouched; the guard gets a 10 s interval
  // inside a live window, so a relay that binds at ready+50 s is not locked out
  // until ready+99 s.
  check('CB-17: shouldUpgradeToRelay REFUSES a 10 s-old attempt at the 60 s default and ACCEPTS it at BOOT_RACE_UPGRADE_INTERVAL_MS — and the timer is still 15 s',
    UP.BOOT_RACE_UPGRADE_INTERVAL_MS === 10_000
    && UP.RELAY_UPGRADE_INTERVAL_MS === 60_000
    && UP.RELAY_UPGRADE_WATCH_MS === 15_000
    && UP.shouldUpgradeToRelay({ transport: 'session-0-direct', now: T, lastUpgradeAttemptAt: T - 10_000 }) === false
    && UP.shouldUpgradeToRelay({ transport: 'session-0-direct', now: T, lastUpgradeAttemptAt: T - 10_000, intervalMs: UP.BOOT_RACE_UPGRADE_INTERVAL_MS }) === true
    && winMcpSource.includes('intervalMs: state.bootRace?.live === true ? BOOT_RACE_UPGRADE_INTERVAL_MS : undefined'),
    `boot=${UP.BOOT_RACE_UPGRADE_INTERVAL_MS} default=${UP.RELAY_UPGRADE_INTERVAL_MS} watch=${UP.RELAY_UPGRADE_WATCH_MS}`)

  /* ---- CB-18: THE LAUNCHER RIDES A CHUNKED CARRIER (D2) ------------- */
  // The live failure: one `-EncodedCommand` of 13 721 chars → 36 592 base64 →
  // a 36 667-character remote command, past cmd.exe's 8 191 line; sshd answered
  // `exec request failed on channel 0`. The carrier is now the guard's geometry.
  const repairScript = UP.relayRepairScriptSource({ port: 47999 })
  const repairCarrier = UP.relayRepairScriptCarrierPlan({ script: repairScript })
  const repairAppends = repairCarrier.filter((step) => step.kind === 'append')
  const repairChunks = repairAppends.map((step) => /cmd \/c "echo (\S+) [>]{1,2}/u.exec(step.command)?.[1] ?? '')
  const oldSingleCommand = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass ${UP.RELAY_REPAIR_COMMAND_MARKER} ${Buffer.from(repairScript, 'utf16le').toString('base64')}`
  check('CB-18: the repair script is staged in 6 000-char cmd appends + one short decoder EVERY child < 8191 chars (the old single command was 36 667) and the carrier round-trips the script',
    repairCarrier.length === 5 && repairAppends.length === 4 && repairCarrier.at(-1).kind === 'exec'
    && repairCarrier.every((step) => step.command.length < 8_191)
    && oldSingleCommand.length > 8_191
    && repairChunks.join('') === Buffer.from(repairScript, 'utf8').toString('base64')
    && repairAppends[0].command.includes(` >${UP.RELAY_REPAIR_CARRIER_PATH}"`)
    && repairAppends.slice(1).every((step) => step.command.includes(` >>${UP.RELAY_REPAIR_CARRIER_PATH}"`))
    && repairCarrier.at(-1).command.includes('Invoke-Expression')
    && repairCarrier.at(-1).command.includes(`Invoke-Expression $x`)
    && repairCarrier.every((step) => step.command.includes(UP.RELAY_REPAIR_COMMAND_MARKER)),
    `${repairCarrier.length} child(ren), max ${Math.max(...repairCarrier.map((step) => step.command.length))} chars (old ${oldSingleCommand.length})`)

  /* ---- CB-19: A CURRENT FILE WITH NO TASK STILL REGISTERS (D3) ------ */
  // The live state was exactly this: guard hash = expected, `cua-mcp-host-guard`
  // absent, plan `[measure]`, task uncreatable. The plan must now register.
  UP.resetRelayRepairState()
  const tasklessSpy = spyStub(planExpected, { measureGuard: planExpected, taskAtMeasure: 0 })
  const tasklessRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: tasklessSpy.spawnImpl, now: () => 1_000, log: () => {} })
  UP.resetRelayRepairState()
  const registerChildren = tasklessSpy.calls.filter((command) => command.includes('schtasks /create')).length
  check('CB-19: a matching guard hash with the task ABSENT runs measure+register (7 children, 0 file writes) and reports staged:current + task:true — the live state that could never create the task',
    tasklessSpy.calls.length === 7
    && registerChildren === 1
    && tasklessRecord.payload.staged === 'current'
    && tasklessRecord.payload.task === true
    && tasklessRecord.payload.writes === 0
    && tasklessRecord.payload.guardHash === planExpected
    // The register line speaks only `task=`; it must not reset the presence the
    // measure proved (the live run's `guardPresent:false` on a matching guard).
    && tasklessRecord.payload.guardPresent === true
    && tasklessRecord.payload.relayPresent === true,
    `children=${tasklessSpy.calls.length} register=${registerChildren} staged=${tasklessRecord.payload.staged} task=${tasklessRecord.payload.task} writes=${tasklessRecord.payload.writes}`)

  /* ---- CB-20: THE WHOLE PLAN FITS ITS BUDGET (D4) ------------------- */
  // The live arithmetic: 12 PowerShell children ≈ 29–35 s > 25 000, so `register`
  // (step 12) was cut. The plan is now 3 PowerShell + 9 cmd, and the launcher
  // phase 1 + 4 — both under the shared 28 000 deadline, which itself ends
  // before index.js's 30 000 guard.
  const stepCost = (plan) => plan.reduce((total, step) => total
    + (step.kind === 'append' || step.kind === 'register' ? UP.RELAY_REPAIR_STEP_MS.cmd : UP.RELAY_REPAIR_STEP_MS.powershell), 0)
  const payloadCost = stepCost(stagePlan)
  const carrierCost = stepCost(repairCarrier)
  const forcedMsMatch2 = /const WIN_MCP_FORCE_REPAIR_MS = ([\d_]+)/u.exec(indexSource)
  const forcedEnvelope = forcedMsMatch2 === null ? null : Number(forcedMsMatch2[1].replace(/_/gu, ''))
  check('CB-20: at the MEASURED per-child cost the payload plan (3 PowerShell + 9 cmd ≈ 10 050 ms) and the carrier (≈3 500 ms) fit RELAY_PAYLOAD_REPAIR_TIMEOUT_MS and the shared RELAY_REPAIR_TOTAL_MS (28 000 < 30 000), so `register` is never the step the deadline cuts',
    UP.RELAY_PAYLOAD_REPAIR_TIMEOUT_MS === 25_000
    && UP.RELAY_REPAIR_TOTAL_MS === 28_000
    && forcedEnvelope === 30_000
    && UP.RELAY_REPAIR_TOTAL_MS < forcedEnvelope
    && payloadCost < UP.RELAY_PAYLOAD_REPAIR_TIMEOUT_MS
    && payloadCost + carrierCost < UP.RELAY_REPAIR_TOTAL_MS
    && stagePlan.at(-1).kind === 'register'
    && repairCarrier.at(-1).kind === 'exec',
    `payload=${payloadCost} ms carrier=${carrierCost} ms total=${payloadCost + carrierCost} ms < ${UP.RELAY_REPAIR_TOTAL_MS} < ${forcedEnvelope}`)

  /* ---- CB-21: ONE `stale` RULE (D5) --------------------------------- */
  // The live defect: guest line `stale=0` (guard matched) vs harness
  // `payload.stale:true` (relay differed), same guest, same second. The guest
  // line now applies C6's table and the RECORD's value is derived by the one
  // owner — proven by feeding a disagreeing line and getting the harness answer.
  UP.resetRelayRepairState()
  const disagreeingSpy = spyStub(planExpected, { lineStale: 0 })
  const disagreeingRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: disagreeingSpy.spawnImpl, now: () => 1_000, log: () => {} })
  UP.resetRelayRepairState()
  const agreeing = UP.payloadStale({ expectedRelayHash: HEX_A, relayHash: HEX_A, expectedGuardHash: HEX_B, guardHash: HEX_B })
  const differing = UP.payloadStale({ expectedRelayHash: HEX_A, relayHash: HEX_C, expectedGuardHash: HEX_B, guardHash: HEX_B })
  const noPair = UP.payloadStale({ expectedRelayHash: null, relayHash: HEX_A, expectedGuardHash: HEX_B, guardHash: null })
  const lineStale = UP.parseCuaPayloadRecord(`${'CUA_PAYLOAD'} guard=${HEX_B} relay=${HEX_B} stale= staged=current task=1`)
  check('CB-21: `stale` has ONE owner — C6\'s table (agree false / differ true / no comparable pair null), the guest line prints the same table (`stale=` empty ⇒ null), and a DISAGREEING line cannot change the record\'s derived answer',
    agreeing === false && differing === true && noPair === null
    && lineStale?.stale === null
    && UP.parseCuaPayloadRecord(`${'CUA_PAYLOAD'} guard= relay= stale=0 staged=current task=1`)?.stale === false
    && UP.parseCuaPayloadRecord(`${'CUA_PAYLOAD'} guard= relay= stale=1 staged=current task=1`)?.stale === true
    && stagePlan[0].command.includes(`$s=''`) && stagePlan[0].command.includes(`-ne '' -and`)
    // The line said 0; the relay hash differs from the build's; the RECORD says true.
    && disagreeingRecord.payload.stale === true
    && disagreeingRecord.payload.guardHash === planExpected,
    `agree=${agreeing} differ=${differing} noPair=${noPair} lineSay=0 record=${disagreeingRecord.payload.stale}`)

  /* ---- P-ROUND PINS: PRE defects 2/4/5/6 ---------------------------- */
  //
  // One faithful, tiny guest for the three carrier/plan pins: `cmd /c echo`
  // appends, the real decode body, the real measure/verify/register shapes, and
  // a per-child CLOCK so a budget pin is deterministic. Nothing here re-implements
  // a decision — every command comes from the module's own builders.
  const GUARD_PATH_FOR_TEST = 'C:\\ProgramData\\cua\\cua-relay-guard.ps1'
  const GUARD_B64_FOR_TEST = 'C:\\ProgramData\\cua\\cua-relay-guard.b64'
  const REPAIR_B64_FOR_TEST = 'C:\\ProgramData\\cua\\cua-relay-repair.b64'
  const guardTextForTest = guardBytes === null ? '' : guardBytes.toString('utf8')
  const expectedForTest = expectedGuard ?? HEX_A
  const miniGuest = ({ guard = null, b64 = null, task = false, failAppendAt = 0, failCarrierAt = 0, killGuardAt = 0, killCarrierAt = 0, corruptDecode = false, corruptDecodeOnce = false, msPerChild = 0, hang = false } = {}) => {
    const fs = new Map()
    if (guard !== null) fs.set(GUARD_PATH_FOR_TEST, guard)
    if (b64 !== null) fs.set(GUARD_B64_FOR_TEST, b64)
    if (task === true) fs.set('__task__', '1')
    const log = []
    const clock = { now: 1_000 }
    let guardAppends = 0
    let carrierAppends = 0
    let decodeRuns = 0
    const spawnImpl = (_bin, argv) => {
      const command = String(argv?.at(-1) ?? '')
      log.push(command)
      clock.now += msPerChild
      const child = new EventEmitter()
      if (hang === true) {
        // A SILENT child: no stdout, no exit, no close — only the capture's own
        // timer can end it (the live carrier hit exactly this).
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdout.setEncoding = () => {}
        child.stderr.setEncoding = () => {}
        child.kill = () => {}
        return child
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      let out = ''
      let err = ''
      let code = 0
      // N2: a child KILLED BY A SIGNAL — no stdout, no stderr, no 'exit' event,
      // only `close(null)` (exactly what runSshCapture turns into
      // `{exitCode: null, detail: '', timedOut: false}`). The old predicate read
      // that shape as SUCCESS; a guest that dies mid-carrier is the live accident.
      let signalKill = false
      const echo = /^cmd \/c "echo (\S+) (>>?)([^"]+)"$/u.exec(command)
      if (echo !== null) {
        const [, chunk, op, file] = echo
        const isGuard = file === GUARD_B64_FOR_TEST
        if (isGuard) {
          guardAppends += 1
          if (killGuardAt > 0 && guardAppends === killGuardAt) { signalKill = true } else if (guardAppends === failAppendAt) { code = 1; err = 'Access is denied.' } else {
            fs.set(file, (op === '>' ? '' : (fs.get(file) ?? '')) + `${chunk} \r\n`)
          }
        } else {
          carrierAppends += 1
          if (killCarrierAt > 0 && carrierAppends === killCarrierAt) { signalKill = true } else if (carrierAppends === failCarrierAt) { code = 1; err = 'Access is denied.' } else {
            fs.set(file, (op === '>' ? '' : (fs.get(file) ?? '')) + `${chunk} \r\n`)
          }
        }
      } else if (command.includes('Invoke-Expression $x')) {
        fs.delete(REPAIR_B64_FOR_TEST)
        out = `CUA_RELAY ok=1 port=47999 task=1 running=1 session=2 probe=RELAY_OK hash=${HEX_B} mode=handshake reason=\n`
      } else if (command.includes('schtasks /create')) {
        fs.set('__task__', '1')
        out = 'CUA_PAYLOAD task=1\n'
      } else if (command.includes('FromBase64String') && command.includes('WriteAllText')) {
        decodeRuns += 1
        const raw = String(fs.get(GUARD_B64_FOR_TEST) ?? '').replace(/\s/gu, '')
        if (raw.length % 4 !== 0 || /^[A-Za-z0-9+/]*={0,2}$/u.test(raw) === false) {
          code = 1
          err = 'Exception calling FromBase64String'
        } else {
          const decoded = Buffer.from(raw, 'base64').toString('utf8')
          // J1/J2: a decode whose bytes are NOT the payload but which exits 0
          // (a cross-process interleave, a truncated write — the shape that made
          // the verify the only place the truth appears).
          const corrupt = corruptDecode === true || (corruptDecodeOnce === true && decodeRuns === 1)
          fs.set(GUARD_PATH_FOR_TEST, corrupt === true ? decoded.slice(0, Math.max(0, decoded.length - 37)) : decoded)
          fs.delete(GUARD_B64_FOR_TEST)
        }
      } else if (command.includes('Get-FileHash')) {
        if (command.includes('Remove-Item -Force')) fs.delete(GUARD_B64_FOR_TEST)
        const present = fs.has(GUARD_PATH_FOR_TEST)
        const g = present === false ? '' : (fs.get(GUARD_PATH_FOR_TEST) === guardTextForTest ? expectedForTest : HEX_C)
        const t = fs.get('__task__') === '1' ? 1 : 0
        const word = command.includes("{ 'staged' }") ? 'staged' : 'current'
        const staged = g === expectedForTest ? word : 'incomplete'
        out = `CUA_PAYLOAD guard=${g} relay=${HEX_B} stale=1 staged=${staged} task=${t}\n`
      } else {
        code = 1
        err = `unmodelled: ${command.slice(0, 40)}`
      }
      setTimeout(() => {
        if (signalKill === true) {
          // `close(null)` and NOTHING else: the shape that used to read as a
          // successful chunk (`exitCode: null, detail: '', timedOut: false`).
          child.signalCode = 'SIGKILL'
          child.emit('close', null)
          return
        }
        if (out !== '') child.stdout.emit('data', out)
        if (err !== '') child.stderr.emit('data', err)
        child.emit('close', code)
      }, 0)
      return child
    }
    return { fs, log, clock, spawnImpl }
  }

  /* ---- CB-22: BOTH PRODUCERS EMIT relayPresent AND task (P1) -------- */
  // PRE defect 2: `relayPresent`/`task` were documented and produced by nobody,
  // so index.js's re-derivation lost a MEASURED relay pair (`stale: null`) while
  // the owner said true. One owner (`payloadPresence`) feeds both producers.
  const measuredPayloadRecord = {
    measured: true,
    hash: HEX_C,
    payload: { staged: 'staged', guardHash: HEX_A, guardPresent: true, relayHash: HEX_C, relayPresent: true, task: true, writes: 10 }
  }
  const presenceClient = UP.createDshCuaClient({ name: 'p1-facts', sshPort: 1 })
  presenceClient.state.repair = measuredPayloadRecord
  const presenceClientPayload = presenceClient.doctorFacts().payload
  UP.resetRelayRepairState()
  const presenceSpy = spyStub(planExpected)
  await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: presenceSpy.spawnImpl, now: () => 1_000, log: () => {} })
  const probeStub = (() => {
    const spawnImpl = () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      setTimeout(() => { child.stdout.emit('data', 'RELAY_OK\n'); child.emit('close', 0) }, 0)
      return child
    }
    return spawnImpl
  })()
  const moduleFacts = await UP.relayDoctorFacts({ host: '127.0.0.1', port: 47999, user: 'cua', spawnImpl: probeStub, log: () => {} })
  const fieldsDoc = String(UP.DOCTOR_FACTS_FIELDS ?? '')
  UP.resetRelayRepairState()
  check('CB-22: BOTH payload producers emit relayPresent + task (three-valued, one owner) so payloadStale() has its inputs and the doctor\'s re-derivation cannot lose a measured relay pair',
    presenceClientPayload.relayPresent === true
    && presenceClientPayload.task === true
    && presenceClientPayload.guardPresent === true
    && presenceClientPayload.stale === true
    && moduleFacts.payload.relayPresent === true
    && moduleFacts.payload.task === true
    && moduleFacts.payload.guardPresent === true
    && moduleFacts.payload.stale === true
    // The three-valued rule, from the same owner — N1: `hash:''` is MEASURED
    // ABSENT (false) and a never-spoken hash is UNMEASURED (null); the inverted
    // pair this check used to pin is corrected in CB-26's full table.
    && UP.payloadPresence(null).relayPresent === null
    && UP.payloadPresence({ measured: true, hash: '' }).relayPresent === false
    && UP.payloadPresence({ measured: true, hash: null }).relayPresent === null
    && UP.payloadPresence({ measured: false, payload: { staged: 'none' } }).task === null
    && ['relayPresent', 'guardPresent', 'task', 'stale'].every((key) => fieldsDoc.includes(key)),
    `client=${JSON.stringify({ relayPresent: presenceClientPayload.relayPresent, task: presenceClientPayload.task, stale: presenceClientPayload.stale })} module=${JSON.stringify({ relayPresent: moduleFacts.payload.relayPresent, task: moduleFacts.payload.task, stale: moduleFacts.payload.stale })}`)

  /* ---- CB-23: NO CARRIER SURVIVES A COMPLETED REPAIR (P2) ----------- */
  // PRE defect 4: a decode killed between WriteAllText and Remove-Item leaves
  // cua-relay-guard.b64 forever, and once the guard is CURRENT no plan step names
  // it. The MEASURE now deletes it (same child, free), so every completed repair
  // — including the `[measure]` and `[measure, register]` shapes — cleans up.
  const residueGuest = miniGuest({ guard: guardTextForTest, b64: 'RESIDUE-OF-THE-ABORTED-RUN', task: true })
  UP.resetRelayRepairState()
  const residueRecord = await UP.repairRelay({
    port: 47999, force: true, payloadRepair: true, spawnImpl: residueGuest.spawnImpl, now: () => residueGuest.clock.now, log: () => {}
  })
  UP.resetRelayRepairState()
  const measureStep = stagePlan[0].command
  check('CB-23: the MEASURE deletes a leftover carrier (so no .b64 survives a completed repair, even when the guard is current and nothing is appended) — proven on a guest that had residue',
    measureStep.startsWith('powershell')
    && measureStep.includes(`Remove-Item -Force '${GUARD_B64_FOR_TEST}'`)
    && measureStep.indexOf('Remove-Item') < measureStep.indexOf('Get-FileHash')
    && residueRecord.payload.staged === 'current'
    && residueGuest.fs.has(GUARD_B64_FOR_TEST) === false
    && residueGuest.fs.get(GUARD_PATH_FOR_TEST) === guardTextForTest,
    `staged=${residueRecord.payload.staged} residueLeft=${residueGuest.fs.has(GUARD_B64_FOR_TEST)} children=${residueGuest.log.length}`)

  /* ---- CB-24: A FAILED CHILD STOPS THE PLAN (P3) -------------------- */
  // PRE defect 5: runSshCapture resolves on `close` whatever the exit code, so a
  // failed truncate let later chunks append into the OLD carrier, the decode ran
  // on a corrupt stream and `writes` counted the failed child. A non-zero step is
  // now a hard stop and only successful writes are counted.
  const brokenChunkGuest = miniGuest({ failAppendAt: 3 })
  UP.resetRelayRepairState()
  const brokenChunkRecord = await UP.repairRelay({
    port: 47999, force: true, payloadRepair: true, spawnImpl: brokenChunkGuest.spawnImpl, now: () => brokenChunkGuest.clock.now, log: () => {}
  })
  UP.resetRelayRepairState()
  const guardAppendsRan = brokenChunkGuest.log.filter((c) => c.startsWith('cmd /c "echo') && c.includes(GUARD_B64_FOR_TEST)).length
  // The carrier exec also mentions FromBase64String — count the GUARD decoder.
  const decodeRan = brokenChunkGuest.log.filter((c) => c.includes('FromBase64String') && c.includes('WriteAllText') && c.includes(GUARD_PATH_FOR_TEST)).length
  const silentGuest = miniGuest({ hang: true })
  UP.resetRelayRepairState()
  const silentRecord = await UP.repairRelay({
    port: 47999, force: true, payloadRepair: true, timeoutMs: 120,
    spawnImpl: silentGuest.spawnImpl, now: () => silentGuest.clock.now, log: () => {}
  })
  UP.resetRelayRepairState()
  const carrierBroken = miniGuest({ failCarrierAt: 2 })
  UP.resetRelayRepairState()
  const carrierBrokenRecord = await UP.repairRelay({
    port: 47999, force: true, payloadRepair: true, spawnImpl: carrierBroken.spawnImpl, now: () => carrierBroken.clock.now, log: () => {}
  })
  UP.resetRelayRepairState()
  const carrierChildren = carrierBroken.log.filter((c) => c.includes(REPAIR_B64_FOR_TEST) || c.includes('Invoke-Expression')).length
  check('CB-24: a non-zero chunk STOPS the loop (no later append, no decode of a corrupt carrier), `writes` counts only successful writes, and the CARRIER loop fails fast too (the script never runs, so the record is unmeasured)',
    brokenChunkRecord.payload.staged === 'incomplete'
    && guardAppendsRan === 3
    && decodeRan === 0
    && brokenChunkRecord.payload.writes === 2
    && /failed \(exit 1\)/u.test(String(brokenChunkRecord.payload.detail ?? ''))
    && carrierBrokenRecord.parsed === false
    && carrierBrokenRecord.measured === false
    && carrierChildren === 2
    && /carrier chunk failed/u.test(String(carrierBrokenRecord.detail ?? ''))
    // A SILENT child is a FAILED child, not a written one (the live accident):
    // the capture times out, the loop stops, and nothing is counted.
    && silentRecord.parsed === false
    && silentRecord.payload.writes === 0
    && silentRecord.payload.staged === 'incomplete'
    && /carrier chunk failed/u.test(String(silentRecord.detail ?? '')),
    `appends=${guardAppendsRan} decode=${decodeRan} writes=${brokenChunkRecord.payload.writes} carrierChildren=${carrierChildren} silentWrites=${silentRecord.payload.writes} detail=${String(carrierBrokenRecord.detail ?? '').slice(0, 60)}`)

  /* ---- CB-25: THE CALLER'S timeoutMs IS THE WALL (P4) --------------- */
  // PRE defect 6: the doc said "the repair's own wall" while the code used it as
  // a launcher sub-cap, and runPayloadRepair ignored the caller entirely, so
  // repairRelay({timeoutMs: 5000}) could run 28 s. ONE wall now:
  // min(caller, RELAY_REPAIR_TOTAL_MS), read once and shared by both phases.
  const slowGuest = miniGuest({ msPerChild: 400 })
  UP.resetRelayRepairState()
  const slowStarted = slowGuest.clock.now
  const slowRecord = await UP.repairRelay({
    port: 47999, force: true, payloadRepair: true, timeoutMs: 1_500,
    spawnImpl: slowGuest.spawnImpl, now: () => slowGuest.clock.now, log: () => {}
  })
  UP.resetRelayRepairState()
  const slowElapsed = slowGuest.clock.now - slowStarted
  // A NON-POSITIVE `timeoutMs` IS UNSET, NOT A ZERO BUDGET (`Number(null)` is 0,
  // so `{timeoutMs: 0}` used to collapse the wall to "now" and run nothing). The
  // normalization is pinned by running the SAME guest twice — the default and an
  // explicit 0 must produce the same plan — so removing it reddens this arm.
  const unsetBaselineGuest = miniGuest({})
  UP.resetRelayRepairState()
  const unsetBaselineRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: unsetBaselineGuest.spawnImpl, now: () => unsetBaselineGuest.clock.now, log: () => {} })
  UP.resetRelayRepairState()
  const unsetZeroGuest = miniGuest({})
  UP.resetRelayRepairState()
  const unsetZeroRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, timeoutMs: 0, spawnImpl: unsetZeroGuest.spawnImpl, now: () => unsetZeroGuest.clock.now, log: () => {} })
  UP.resetRelayRepairState()
  check('CB-25: `repairRelay({timeoutMs})` bounds the WHOLE attempt (a 1 500 ms cap with 400 ms children stops the 17-child plan early, and the payload says the budget was gone) — the doc and the code now say the same thing; a NON-POSITIVE timeoutMs (0/null) is UNSET, not a zero budget',
    slowElapsed <= 1_500 + 400
    && slowGuest.log.length <= 5
    && slowRecord.payload.staged === 'incomplete'
    && slowRecord.payload.staged !== 'staged'
    && UP.RELAY_REPAIR_TIMEOUT_MS === 25_000
    && UP.RELAY_REPAIR_TOTAL_MS === 28_000
    && /min\(callerMs, RELAY_REPAIR_TOTAL_MS\)/u.test(winMcpSource)
    // 0 is unset: same children, same outcome as the default call.
    && unsetZeroGuest.log.length === unsetBaselineGuest.log.length
    && unsetZeroGuest.log.length > 5
    && unsetZeroRecord.payload.staged === unsetBaselineRecord.payload.staged
    && unsetZeroRecord.payload.writes === unsetBaselineRecord.payload.writes,
    `elapsed=${slowElapsed} ms children=${slowGuest.log.length} staged=${slowRecord.payload.staged} unset=${unsetZeroGuest.log.length}/${unsetBaselineGuest.log.length} children staged=${unsetZeroRecord.payload.staged}/${unsetBaselineRecord.payload.staged}`)

  /* ---- CB-26: THE PRESENCE TRUTH TABLE, ONE OWNER (N1) -------------- */
  // re-PRE N1: `payloadPresence` tested `hash !== null`, so BOTH non-hash arms
  // were inverted — a guest that MEASURED `hash=` (empty: there is no relay
  // script) answered `relayPresent: true`, and a guest that never spoke a hash
  // answered `false`. DOCTOR_FACTS_FIELDS and `parseRelayRepairRecord`'s own
  // `hashMeasured` say the opposite: `hash=` is MEASURED ABSENT, a missing
  // field is UNMEASURED. The table is pinned here in EVERY shape a producer can
  // emit, including the `hash=` arm CB-22 never tested; reverting to the
  // `hash !== null` test reddens whichever arm it is reverted to.
  const presenceArms = [
    // [label, record, expected relayPresent]
    ['hash= (measured absent)', { measured: true, hash: '' }, false],
    ['hash=<hex> (measured present)', { measured: true, hash: HEX_C }, true],
    ['hash field missing (unmeasured)', { measured: true, hash: null }, null],
    ['hash missing, hashMeasured:false', { measured: true, hash: null, hashMeasured: false }, null],
    ['hash null, hashMeasured:true (measured, value gone)', { measured: true, hash: null, hashMeasured: true }, false],
    ['measured:false (nothing measured)', { measured: false, hash: '' }, null],
    ['no record at all', null, null]
  ]
  const presenceGot = presenceArms.map(([, record]) => UP.payloadPresence(record).relayPresent)
  const presenceText = presenceGot.map((value) => String(value)).join(',')
  const presenceOk = presenceArms.every(([, record, expect]) => UP.payloadPresence(record).relayPresent === expect)
  // THE GRAMMAR ARMS, end to end: the `CUA_RELAY` line is the only producer of a
  // measured hash, so the inversion is pinned where it was introduced.
  const presencePresentLine = UP.parseRelayRepairRecord(`CUA_RELAY ok=0 port=47999 task=0 running=0 session=2 probe=RELAY_DOWN hash=${HEX_C} mode=handshake reason=`)
  const presenceAbsentLine = UP.parseRelayRepairRecord('CUA_RELAY ok=0 port=47999 task=0 running=0 session=2 probe=RELAY_DOWN hash= mode=handshake reason=relay-missing')
  const presenceUnmeasuredLine = UP.parseRelayRepairRecord('CUA_RELAY ok=0 port=47999 task=0 running=0 session=2 probe=RELAY_DOWN mode=handshake reason=relay-stopped')
  // The poll/repair shape the probe uses: `measured/hash/hashMeasured` + a payload
  // arm that staged nothing (so the CUA_PAYLOAD arm cannot answer for the relay).
  const presencePoll = (parsed) => ({ measured: parsed?.measured === true, hash: parsed?.hash ?? null, hashMeasured: parsed?.hashMeasured === true, payload: { staged: 'none' } })
  // THE `CUA_PAYLOAD` ARM keys on "this line spoke about it" (hasOwn), so a
  // register-only line (`task=` alone) must not report the guard ABSENT, and an
  // empty `relay=` must not report the relay PRESENT.
  const presenceBlankRelay = UP.parseCuaPayloadRecord('CUA_PAYLOAD guard= relay= stale= staged=current task=1')
  const presenceSilentRelay = UP.parseCuaPayloadRecord('CUA_PAYLOAD stale= staged=current task=1')
  const presenceFromPayload = (parsed) => UP.payloadPresence({ measured: true, hash: null, payload: parsed })
  check('CB-26: relayPresent/guardPresent/task are THREE-VALUED from one owner — `hash=` is MEASURED ABSENT (false), a missing hash is UNMEASURED (null), a hex hash is PRESENT (true), and the CUA_PAYLOAD arm keys on "the line spoke", not on the hash value (re-PRE N1)',
    presenceOk
    && presenceText === 'false,true,null,null,false,null,null'
    && presencePresentLine?.hashMeasured === true
    && presenceAbsentLine?.hashMeasured === true
    && presenceUnmeasuredLine?.hashMeasured === false
    && UP.payloadPresence(presencePoll(presencePresentLine)).relayPresent === true
    && UP.payloadPresence(presencePoll(presenceAbsentLine)).relayPresent === false
    && UP.payloadPresence(presencePoll(presenceUnmeasuredLine)).relayPresent === null
    && presenceBlankRelay?.relayPresent === false
    && presenceBlankRelay?.guardPresent === false
    && presenceBlankRelay?.task === true
    && presenceFromPayload(presenceBlankRelay).relayPresent === false
    && presenceFromPayload(presenceBlankRelay).guardPresent === false
    && presenceSilentRelay?.relayPresent === null
    && presenceSilentRelay?.guardPresent === null
    && presenceFromPayload(presenceSilentRelay).relayPresent === null
    && String(UP.DOCTOR_FACTS_FIELDS ?? '').includes('false MEASURED absent'),
    `arms=${presenceText} (expect false,true,null,null,false,null,null) lines=${JSON.stringify({ present: presencePresentLine?.hashMeasured, absent: presenceAbsentLine?.hashMeasured, unmeasured: presenceUnmeasuredLine?.hashMeasured })} payload=${JSON.stringify({ blank: presenceBlankRelay?.relayPresent, silent: presenceSilentRelay?.relayPresent })}`)

  /* ---- CB-27: A SIGNAL-KILLED CHILD IS A DEATH, NOT A WRITE (N2) ---- */
  // re-PRE N2: `runSshCapture` resolves on `close` with `{exitCode: null,
  // detail: '', timedOut: false}` when the ssh child dies by SIGNAL (SIGKILL/
  // SIGTERM: no 'exit' event, no timer, no spawn error). The predicate only knew
  // timeout / spawn / non-zero, so that shape read as SUCCESS: the loop counted
  // `writes` for a chunk that never landed and carried on toward the decode of a
  // half-written carrier. The documented rule now: a clean `cmd /c echo` always
  // reports a code, so NO CODE AT ALL is never a successful step.
  const stepShapes = [
    ['exit 0', { exitCode: 0, detail: '', timedOut: false }, false],
    ['exit 1', { exitCode: 1, detail: '', timedOut: false }, true],
    ['exit 255', { exitCode: 255, detail: '', timedOut: false }, true],
    ['timeout', { exitCode: null, detail: 'no answer within 1500 ms', timedOut: true }, true],
    ['spawn failure', { exitCode: null, detail: 'spawn failed: ENOENT', timedOut: false }, true],
    ['SIGKILL (close null, no exit, no detail)', { exitCode: null, detail: '', timedOut: false }, true],
    ['no code at all (undefined)', { exitCode: undefined, detail: '', timedOut: false }, true],
    ['no capture', null, true]
  ]
  const stepOk = stepShapes.every(([, capture, expect]) => UP.relayStepFailed(capture) === expect)
  // THE LIVE SHAPE, end to end: the third guard chunk is SIGKILLed. A success
  // reading counts it as a write (writes 3), keeps going and decodes the
  // half-written carrier; the honest reading stops at 2 successful writes and
  // never decodes.
  const killedGuardGuest = miniGuest({ killGuardAt: 3 })
  UP.resetRelayRepairState()
  const killedGuardRecord = await UP.repairRelay({
    port: 47999, force: true, payloadRepair: true, spawnImpl: killedGuardGuest.spawnImpl, now: () => killedGuardGuest.clock.now, log: () => {}
  })
  UP.resetRelayRepairState()
  const killedGuardAppends = killedGuardGuest.log.filter((c) => c.startsWith('cmd /c "echo') && c.includes(GUARD_B64_FOR_TEST)).length
  const killedGuardDecode = killedGuardGuest.log.filter((c) => c.includes('FromBase64String') && c.includes('WriteAllText') && c.includes(GUARD_PATH_FOR_TEST)).length
  // The CARRIER loop has the same predicate: a SIGKILLed chunk must stop the
  // carrier, so the script never runs and the record stays UNMEASURED.
  const killedCarrierGuest = miniGuest({ killCarrierAt: 2 })
  UP.resetRelayRepairState()
  const killedCarrierRecord = await UP.repairRelay({
    port: 47999, force: true, payloadRepair: true, spawnImpl: killedCarrierGuest.spawnImpl, now: () => killedCarrierGuest.clock.now, log: () => {}
  })
  UP.resetRelayRepairState()
  const killedCarrierChildren = killedCarrierGuest.log.filter((c) => c.includes(REPAIR_B64_FOR_TEST) || c.includes('Invoke-Expression')).length
  check('CB-27: a child killed by a SIGNAL (exitCode null, no timeout, no spawn detail) is a FAILED step — the truth table covers SIGKILL, the guard loop stops at 2 successful writes and never decodes, and the carrier loop stops too (re-PRE N2)',
    stepOk
    && UP.relayStepFailed({ exitCode: null, detail: '', timedOut: false }) === true
    && UP.relayStepFailed({ exitCode: 0, detail: '', timedOut: false }) === false
    && killedGuardRecord.payload.staged === 'incomplete'
    && killedGuardRecord.payload.writes === 2
    && killedGuardAppends === 3
    && killedGuardDecode === 0
    && /payload step 'append' failed \(no answer\)/u.test(String(killedGuardRecord.payload.detail ?? ''))
    && killedCarrierRecord.parsed === false
    && killedCarrierRecord.measured === false
    && killedCarrierChildren === 2
    && /carrier chunk failed \(no answer\)/u.test(String(killedCarrierRecord.detail ?? '')),
    `shapes=${stepShapes.map(([, capture]) => UP.relayStepFailed(capture)).join(',')} guardWrites=${killedGuardRecord.payload.writes} guardAppends=${killedGuardAppends} decode=${killedGuardDecode} carrierChildren=${killedCarrierChildren} guardDetail=${String(killedGuardRecord.payload.detail ?? '').slice(0, 60)} carrierDetail=${String(killedCarrierRecord.detail ?? '').slice(0, 60)}`)

  /* ---- J1/J2: THE VERIFY IS THE GATE, AND A WRONG CARRIER RE-STAGES - */
  // JURY-34 probe-1: the verify child is PowerShell that exits 0 on a MISMATCH.
  // The plan's only stop used to be the exit code, so `staged=incomplete` was
  // followed by `schtasks /create`: a non-verifying guard with a SYSTEM onstart
  // task, while the published `task:true` read as "the hash verified".
  // probe-3: the carrier is a FIXED guest path and single-flight is per process,
  // so a second attempt interleaved and the decode wrote 14 590 B of garbage
  // over a good guard — and it still registered.
  const alwaysCorrupt = miniGuest({ corruptDecode: true })
  UP.resetRelayRepairState()
  const corruptRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: alwaysCorrupt.spawnImpl, now: () => alwaysCorrupt.clock.now, log: () => {} })
  UP.resetRelayRepairState()
  const corruptRegister = alwaysCorrupt.log.filter((c) => c.includes('schtasks /create')).length
  check('J1: a verify that answers incomplete STOPS the plan before register (the guest PowerShell exits 0 on a mismatch, so the WORD plus the hash is the verdict) — no SYSTEM task is ever created over a non-verifying guard',
    corruptRecord.payload.staged === 'incomplete'
    && corruptRegister === 0
    && corruptRecord.payload.task === false
    && corruptRecord.payload.restaged === 1
    && /the verify did not report the expected hash/u.test(String(corruptRecord.payload.detail ?? '')),
    `staged=${corruptRecord.payload.staged} register=${corruptRegister} task=${corruptRecord.payload.task} restaged=${corruptRecord.payload.restaged} detail=${String(corruptRecord.payload.detail).slice(0, 70)}`)

  const onceCorrupt = miniGuest({ corruptDecodeOnce: true })
  UP.resetRelayRepairState()
  const healedRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: onceCorrupt.spawnImpl, now: () => onceCorrupt.clock.now, log: () => {} })
  UP.resetRelayRepairState()
  const healedGuard = String(onceCorrupt.fs.get(GUARD_PATH_FOR_TEST) ?? '')
  const decodeCommand = stagePlan.find((step) => step.kind === 'decode')?.command ?? ''
  check('J2: a carrier that decodes to the WRONG bytes is detected by the verify and re-staged ONCE (bounded), so an interleaved carrier self-heals instead of leaving a corrupt guard registered — and the decode itself refuses an empty carrier / a mismatched payload',
    healedRecord.payload.staged === 'staged'
    && healedRecord.payload.task === true
    && healedRecord.payload.restaged === 1
    && healedRecord.payload.guardHash === planExpected
    && healedRecord.payload.detail === ''
    && healedGuard.trim() === guardTextForTest.trim()
    // Guest-side prevention: an empty carrier is not "an empty payload", and a
    // decoded stream that does not hash to the build's payload is refused
    // BEFORE WriteAllText (so a good guard is never overwritten by garbage).
    && decodeCommand.includes('exit 3')
    && decodeCommand.includes('exit 4')
    && decodeCommand.includes('ComputeHash')
    && decodeCommand.indexOf('ComputeHash') < decodeCommand.indexOf('WriteAllText'),
    `staged=${healedRecord.payload.staged} task=${healedRecord.payload.task} restaged=${healedRecord.payload.restaged} guardOk=${healedGuard.trim() === guardTextForTest.trim()} decodeCheck=${decodeCommand.includes('ComputeHash')}`)

  /* ---- J3: A 0-BYTE PAYLOAD IS "NO PAYLOAD" ------------------------- */
  // probe-2: `expectedGuardHash()` returned sha256('') for an empty shipped
  // file, so the plan staged 0 bytes and the verify CONFIRMED the hash of empty.
  const j3Dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-j3-'))
  const j3Empty = path.join(j3Dir, 'empty-guard.ps1')
  writeFileSync(j3Empty, '')
  const emptyExpected = UP.expectedGuardHash(j3Empty)
  const emptyPlan = UP.relayGuardStagePlan({ base64: '', expectedHash: planExpected, expectedRelay: HEX_B, taskPresent: false, port: 47999 })
  try { rmSync(j3Dir, { recursive: true, force: true }) } catch {}
  check('J3: a 0-byte guard payload is "this build cannot say" (null, never sha256(\'\')), so the plan cannot register a task over nothing and the runtime refuses with staged:absent before staging',
    emptyExpected === null
    && emptyExpected !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    && emptyPlan.every((step) => step.kind !== 'register')
    && winMcpSource.includes('the guard payload is empty (0 bytes)'),
    `expected=${String(emptyExpected)} kinds=${emptyPlan.map((step) => step.kind).join(',')}`)

  /* ---- J4: deadline IS NORMALIZED, THE WAY CALLERS ARE (JURY-34) ---- */
  // probe-2: `deadline = null` (runPayloadRepair's default) went through
  // `Number(null) === 0`, so the staging deadline was IN THE PAST and the phase
  // ran zero children. One normalizer now owns the rule.
  const T4 = 1_000_000
  const deadlineTable = [
    [null, T4 + 25_000],
    [undefined, T4 + 25_000],
    [0, T4 + 25_000],
    [-1, T4 + 25_000],
    [Number.NaN, T4 + 25_000],
    [T4 + 5_000, T4 + 5_000],
    [T4 + 60_000, T4 + 25_000]
  ]
  const deadlineOk = deadlineTable.every(([deadline, expectedDeadline]) =>
    UP.payloadStagingDeadline({ deadline, startedAt: T4 }) === expectedDeadline)
  check('J4: a `deadline` of null/undefined/0/-1/NaN means UNSET (the full 25 000 staging budget), a real one is honoured, and a far one is capped — `Number(null) === 0` can no longer produce a deadline in the past',
    deadlineOk
    && UP.payloadStagingDeadline({ deadline: null, startedAt: T4 }) === T4 + UP.RELAY_PAYLOAD_REPAIR_TIMEOUT_MS
    && UP.payloadStagingDeadline({ deadline: T4 + 1, startedAt: T4 }) === T4 + 1
    && winMcpSource.includes('payloadStagingDeadline({ deadline, startedAt'),
    `arms=${deadlineTable.map(([deadline]) => UP.payloadStagingDeadline({ deadline, startedAt: T4 }) - T4).join(',')}`)

  /* ---- J5: THE 28 000 CEILING IS A CLAMP ON A CALLER BUDGET --------- */
  // probe-2: with no caller budget the wall is always min(25 000, 28 000), so
  // the "declared ceiling" was unreachable — and the comment said otherwise.
  // index.js now passes WIN_MCP_FORCE_REPAIR_MS (30 000), which TOTAL clamps.
  check('J5: the 28 000 ceiling is documented as a CLAMP on a caller budget (the forced repair passes WIN_MCP_FORCE_REPAIR_MS = 30 000 and gets 28 000), while the default path gets 25 000 — the module no longer claims the ceiling is in use by itself',
    indexSource.includes('timeoutMs: WIN_MCP_FORCE_REPAIR_MS')
    && UP.RELAY_REPAIR_TOTAL_MS === 28_000
    && UP.RELAY_REPAIR_TIMEOUT_MS === 25_000
    && Math.min(30_000, UP.RELAY_REPAIR_TOTAL_MS) === 28_000
    && winMcpSource.includes('clamps it to 28 000'),
    `indexPasses=${indexSource.includes('timeoutMs: WIN_MCP_FORCE_REPAIR_MS')} total=${UP.RELAY_REPAIR_TOTAL_MS} default=${UP.RELAY_REPAIR_TIMEOUT_MS}`)

  /* ---- J6: COUNTERS AND THE DURATION ARE HONEST --------------------- */
  // probe-2/CB-19: `writes === 0` for a plan that CREATED the task, and
  // `record.ms` was the carrier's wall only — the 12-child payload phase was
  // invisible in the one duration field the record published.
  const clockGuest = miniGuest({ msPerChild: 100 })
  UP.resetRelayRepairState()
  const clockRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: clockGuest.spawnImpl, now: () => clockGuest.clock.now, log: () => {} })
  UP.resetRelayRepairState()
  check('J6: `steps` counts the children that COMPLETED (so [measure, register] is writes 0 / steps 2, not "nothing happened") and `record.ms` is the WHOLE attempt with a carrier/payload split, not the carrier alone',
    clockRecord.payload.steps === 12
    && clockRecord.payload.writes === 9
    && clockRecord.payloadMs > 0
    && clockRecord.carrierMs > 0
    && Math.abs(clockRecord.ms - (clockRecord.carrierMs + clockRecord.payloadMs)) <= 1
    && clockRecord.ms > clockRecord.carrierMs
    && tasklessRecord.payload.steps === 2
    && tasklessRecord.payload.writes === 0,
    `steps=${clockRecord.payload.steps} writes=${clockRecord.payload.writes} ms=${clockRecord.ms} carrier=${clockRecord.carrierMs} payload=${clockRecord.payloadMs} tasklessSteps=${tasklessRecord.payload.steps}`)

  /* ---- R1/R2: THE FROZEN SENTENCE AND A WIDTH-FREE LENGTH NOTE ------ */
  // docs juror (agent-8): the C3 sentence is quoted from the CONSTANT, and the
  // constant had drifted to a hyphen while the plan and the README carry an em
  // dash — nothing pinned it, so it drifted silently. R2: the carrier geometry
  // comment quoted 18 296 as if it were a constant, but the script EMBEDS the
  // port/account, so that number moves with their digits.
  const readmeSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'README.md'), 'utf8')
  check('R1: PAYLOAD_SKEW_SEMANTICS and the README blockquote carry the SAME em dash (U+2014) in the frozen C3 sentence, so the constant cannot drift from the plan and the docs again',
    UP.PAYLOAD_SKEW_SEMANTICS.includes('zero bytes back \u2014 a relay that predates the token')
    && UP.PAYLOAD_SKEW_SEMANTICS.includes('\u2014')
    && readmeSource.includes('zero bytes back \u2014 a relay')
    && UP.PAYLOAD_SKEW_SEMANTICS.includes('It is not a hash comparison'),
    `constant=${UP.PAYLOAD_SKEW_SEMANTICS.includes('\u2014')} readme=${readmeSource.includes('zero bytes back \u2014 a relay')}`)
  check('R2: the carrier-geometry note is WIDTH-INDEPENDENT (the script embeds the port and account, so ≈18 300 for port=47999/user=cua and no frozen 18 296), which ends the constant-swapping drift class',
    winMcpSource.includes('THE LENGTH MOVES WITH THE CONFIGURATION')
    && winMcpSource.includes('≈18 300')
    && winMcpSource.includes('the append count is `ceil(base64 / 6 000)`')
    && winMcpSource.includes('18 296') === false,
    `widthFree=${winMcpSource.includes('THE LENGTH MOVES WITH THE CONFIGURATION')} stale18296=${winMcpSource.includes('18 296')}`)
}


/* ====================================================================== *
 * F2 — `withDeadline`, THE INSTALL WATCH'S PER-TICK BUDGET.
 *
 * The 2026-11-21 wedge was an `await` with no settling path (`bannerProbe` on a
 * peer that accepted and closed), awaited while the tick held the lifecycle
 * lock. F1 fixes that probe; F2 is the answer to the NEXT one: the budget is a
 * HARD deadline on the await, whatever it awaits.
 *
 * The helper is extracted from the supervisor the same way this file already
 * exercises swappable window code (`new Function`), because the supervisor is a
 * process, not a library — and the properties below are exactly the ones the
 * loop depends on:
 *   * expiry resolves the FALLBACK (and never throws — the watch's tail `catch`
 *     is fatal to the watch),
 *   * a late settlement is DISCARDED, including a late rejection (an unhandled
 *     rejection ends the process, which is worse than the wedge),
 *   * a rejection BEFORE the budget is reported through the fallback with the
 *     error, so a probe that panics is not silently labelled "budget expired",
 *   * the timer is cleared, so an answered probe does not pay the budget.
 * ====================================================================== */
{
  const supervisorSource = readFileSync(path.join(REPO, 'docker', 'cua-vm-supervisor.mjs'), 'utf8')
  const extract = (signature) => {
    const start = supervisorSource.indexOf(signature)
    const end = start === -1 ? -1 : supervisorSource.indexOf('\n}\n', start)
    if (start === -1 || end === -1) return ''
    return supervisorSource.slice(start, end + 3)
  }
  const withDeadlineSource = extract('function withDeadline(pending, budgetMs, fallback) {')
  const budgetSource = extract('function installTickBudgetMs() {')
  const load = (source, name) => {
    if (source === '') return null
    try {
      return new Function(`${source}\nreturn ${name}`)()
    } catch {
      return null
    }
  }
  const withDeadline = load(withDeadlineSource, 'withDeadline')
  const installTickBudgetMs = load(budgetSource, 'installTickBudgetMs')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  check('F2: the supervisor defines withDeadline(pending, budgetMs, fallback) and installTickBudgetMs() (the helper is extractable, so it has no hidden dependencies)',
    withDeadline !== null && installTickBudgetMs !== null,
    `withDeadline=${withDeadline !== null} installTickBudgetMs=${installTickBudgetMs !== null}`)

  // (1) THE BUDGET IS A DEADLINE, AND EXPIRY IS A VERDICT — NOT A THROW.
  const never = new Promise(() => {})
  const startedAt = Date.now()
  const expired = withDeadline === null ? { harness: 'missing' } : await withDeadline(never, 120, () => ({ ready: false, alive: true, budgetExpired: true }))
  const expiredMs = Date.now() - startedAt
  check('F2: a promise that NEVER settles resolves the fallback verdict at the budget (a budget expiry is a verdict, not a throw — the watch continues)',
    expired?.budgetExpired === true && expiredMs >= 100 && expiredMs <= 1500,
    `${expiredMs} ms ${JSON.stringify(expired)}`)

  // (2) A LATE SETTLEMENT IS DISCARDED — VALUE OR REJECTION.
  let unhandled = 0
  const onUnhandled = () => { unhandled += 1 }
  process.on('unhandledRejection', onUnhandled)
  const lateValue = new Promise((resolve) => setTimeout(() => resolve('late value'), 260))
  const lateRejection = new Promise((resolve, reject) => setTimeout(() => reject(new Error('late rejection')), 260))
  const firstAnswer = withDeadline === null ? null : await withDeadline(lateValue, 80, () => 'fallback')
  const secondAnswer = withDeadline === null ? null : await withDeadline(lateRejection, 80, () => 'fallback')
  await sleep(400)
  process.off('unhandledRejection', onUnhandled)
  check('F2: a promise that settles AFTER the budget is discarded (both its value and its rejection), and a late rejection never becomes an unhandled rejection',
    firstAnswer === 'fallback' && secondAnswer === 'fallback' && unhandled === 0,
    `value=${JSON.stringify(firstAnswer)} rejection=${JSON.stringify(secondAnswer)} unhandled=${unhandled}`)

  // (3) A PANIC BEFORE THE BUDGET IS NOT A BUDGET EXPIRY.
  const panicked = withDeadline === null
    ? null
    : await withDeadline(Promise.reject(new Error('probe panicked')), 5000, (why) => ({
      expired: why?.expired === true,
      message: why?.error?.message ?? String(why?.error)
    }))
  check('F2: a rejection BEFORE the budget answers the fallback with { expired: false, error } — a probe that panicked is never labelled "budget expired"',
    panicked?.expired === false && /probe panicked/u.test(String(panicked?.message)),
    JSON.stringify(panicked))

  // (4) AN ANSWERED PROBE DOES NOT PAY THE BUDGET.
  const quickFrom = Date.now()
  const quick = withDeadline === null ? null : await withDeadline(Promise.resolve('answered'), 20_000, () => 'fallback')
  const quickMs = Date.now() - quickFrom
  check('F2: a probe that answers resolves at once (the budget timer is cleared, so a fast tick is not held to the deadline)',
    quick === 'answered' && quickMs < 1000,
    `${quickMs} ms ${JSON.stringify(quick)}`)

  // (5) THE KNOB: UNSET IS NOT ZERO (the module's read-once-the-raw-string rule).
  const savedBudget = process.env.DSH_CUA_INSTALL_TICK_BUDGET_MS
  const budgets = []
  try {
    delete process.env.DSH_CUA_INSTALL_TICK_BUDGET_MS
    budgets.push(installTickBudgetMs?.())
    process.env.DSH_CUA_INSTALL_TICK_BUDGET_MS = '1500'
    budgets.push(installTickBudgetMs?.())
    process.env.DSH_CUA_INSTALL_TICK_BUDGET_MS = ''
    budgets.push(installTickBudgetMs?.())
    process.env.DSH_CUA_INSTALL_TICK_BUDGET_MS = 'nonsense'
    budgets.push(installTickBudgetMs?.())
  } finally {
    if (savedBudget === undefined) delete process.env.DSH_CUA_INSTALL_TICK_BUDGET_MS
    else process.env.DSH_CUA_INSTALL_TICK_BUDGET_MS = savedBudget
  }
  check('F2: DSH_CUA_INSTALL_TICK_BUDGET_MS defaults to 20 000 with the variable UNSET or empty (an unset knob is never a zero-second budget) and honours a finite value',
    budgets[0] === 20000 && budgets[1] === 1500 && budgets[2] === 20000 && budgets[3] === 20000,
    JSON.stringify(budgets))
}

/* ====================================================================== *
 * F1 — `bannerProbe` ANSWERS ON EVERY PEER, INCLUDING THE ONE THAT SAYS
 * NOTHING. THIS IS THE RED-ON-REVERT PIN F1 WAS MISSING.
 *
 * The 79-minute wedge of 2026-11-21 (`vm:win-test`) was ONE await with no
 * settling path: QEMU's slirp host-forward ACCEPTS the SSH port, cannot reach
 * the guest (OpenSSH is installed by the answer file after the image copy) and
 * closes the socket without a byte. `bannerProbe` had `socket.setTimeout()` —
 * an IDLE timer libuv drops the moment the stream closes — and resolved only on
 * 'data', 'timeout' and 'error'. An accept-then-FIN peer emits 'end'/'close'
 * and never 'error', so the promise stayed PENDING FOR THE LIFE OF THE PROCESS
 * and the install watch, which awaited it under the lifecycle key, held
 * `vm:<name>` for 79 minutes (the install had finished at 16:35:52; the guest
 * powered off at 17:05:18).
 *
 * F2 bounds the observer's tick, F3 stops the tick holding the key — neither of
 * them makes THIS function settle, and the live `windowsStart` awaits it bare,
 * under the key, in `await windowsBackend.ready(current, …)`. So the function
 * itself is pinned here, against the real export, for the five peers that
 * exist:
 *   (1) accept, then FIN, no bytes            → null, BEFORE the deadline
 *   (2) accept, then destroy, no bytes        → null, BEFORE the deadline
 *   (3) accept, say nothing, stay open        → null AT the deadline
 *   (4) speak the banner, then close          → the bytes
 *   (5) refused (nothing listening)           → null
 *
 * `Promise.race` against a harness guard is deliberate: an un-settling probe
 * must FAIL this check, not hang the suite (a hung suite is a worse witness
 * than a red one, and this file runs without a timeout).
 * ====================================================================== */
{
  const settleGuardMs = 1200
  const deadlineMs = 400
  const serve = async (onSocket) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {})
      onSocket(socket)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
      port: server.address().port,
      close: () => new Promise((resolve) => { try { server.close(resolve) } catch { resolve() } })
    }
  }
  const closedPort = async () => {
    const server = net.createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    await new Promise((resolve) => server.close(resolve))
    return port
  }
  const probe = async (port) => {
    const from = Date.now()
    const answer = await Promise.race([
      bannerProbe('127.0.0.1', port, { timeoutMs: deadlineMs }).then((value) => ({ settled: true, value })),
      new Promise((resolve) => setTimeout(() => resolve({ settled: false, value: 'HARNESS-GUARD' }), deadlineMs + settleGuardMs))
    ])
    return { ...answer, ms: Date.now() - from }
  }

  // (1) ACCEPT, THEN FIN — the 2026-11-21 peer, exactly.
  const finPeer = await serve((socket) => { try { socket.end() } catch {} })
  let fin
  try { fin = await probe(finPeer.port) } finally { await finPeer.close() }
  check('F1: bannerProbe answers a peer that ACCEPTS and then FINs without a byte — null, and BEFORE its deadline (the peer FIN is an answer; the idle timer never fires because the stream is closed)',
    fin.settled === true && fin.value === null && fin.ms < deadlineMs + 250,
    `${fin.ms} ms settled=${fin.settled} value=${JSON.stringify(fin.value)} deadline=${deadlineMs} ms`)

  // (2) ACCEPT, THEN DESTROY — the other half-close shape (a proxy in front of
  // the port does this). Also 'close', never 'error'.
  const destroyPeer = await serve((socket) => { try { socket.destroy() } catch {} })
  let destroyed
  try { destroyed = await probe(destroyPeer.port) } finally { await destroyPeer.close() }
  check('F1: bannerProbe answers a peer that ACCEPTS and then DESTROYS the socket without a byte — null, and BEFORE its deadline (close is not error)',
    destroyed.settled === true && destroyed.value === null && destroyed.ms < deadlineMs + 250,
    `${destroyed.ms} ms settled=${destroyed.settled} value=${JSON.stringify(destroyed.value)}`)

  // (3) ACCEPT, SAY NOTHING, STAY OPEN — the deadline is the answer, and it is
  // the PROBE's deadline (the hard timer), not the harness's guard.
  const silentPeer = await serve(() => {})
  let silent
  try { silent = await probe(silentPeer.port) } finally { await silentPeer.close() }
  check('F1: a peer that accepts and stays silent answers null AT the deadline (the hard timer, armed before connect — the probe\'s own budget, not the caller\'s patience)',
    silent.settled === true && silent.value === null && silent.ms >= deadlineMs - 50 && silent.ms < deadlineMs + 250,
    `${silent.ms} ms settled=${silent.settled} value=${JSON.stringify(silent.value)}`)

  // (4) SPEAK, THEN CLOSE — the GOOD peer: the banner is the answer and it is
  // NOT truncated to nothing or replaced by the close that follows it.
  const banner = 'SSH-2.0-unit-stub\r\n'
  const bannerPeer = await serve((socket) => { try { socket.write(banner) } catch {} })
  let spoke
  try { spoke = await probe(bannerPeer.port) } finally { await bannerPeer.close() }
  check('F1: a peer that SPEAKS and then closes answers the bytes (the banner wins; the close that follows it does not overwrite the answer)',
    spoke.settled === true && String(spoke.value ?? '').startsWith('SSH-2.0-unit-stub'),
    `${spoke.ms} ms settled=${spoke.settled} value=${JSON.stringify(spoke.value)}`)

  // (5) NOTHING LISTENING — refused is an answer too.
  const nothing = await closedPort()
  const refused = await probe(nothing)
  check('F1: a refused port answers null (nothing listening is an answer, not a wait)',
    refused.settled === true && refused.value === null && refused.ms < deadlineMs + 250,
    `${refused.ms} ms settled=${refused.settled} value=${JSON.stringify(refused.value)}`)
}



// ------------------------------------------------------------------ *
// C4 + C18 — THE TWO COMPUTED FACTS ON A STATUS READ
// ------------------------------------------------------------------ *
//
// `stateHolds` and `computerHealth` are exported from the supervisor, so they are
// asserted against the REAL module (imported in a child with a throwaway store,
// like parseGuestDf/buildScpArgv above — this suite must never bind the
// supervisor's socket).
{
  const store = mkdtempSync(path.join(os.tmpdir(), 'cua-holds-unit-'))
  try {
    const supervisorUrl = new URL('../docker/cua-vm-supervisor.mjs', import.meta.url).href
    const program = `const m = await import(${JSON.stringify(supervisorUrl)});`
      + `const states = ['ready','running','installing','booting','suspended','powered-off','off','stopped','error','missing'];`
      + `const holds = Object.fromEntries(states.map((state) => [state, m.stateHolds(state)]));`
      + `holds.nonsense = m.stateHolds('nonsense'); holds.undefined = m.stateHolds(undefined);`
      + `const ready = { kind: 'windows', state: 'ready', stateStale: false, stateAgeMs: 1000, lock: null, gpuDegraded: null, share: 'attached', restoreFrom: { kind: 'checkpoint' }, isoSourceId: 'mido', isoMedia: 'chain' };`
      + `const facts = { ageMs: 1000, stale: false, windowMs: 120000, source: 'probe', confirmedAt: null };`
      + `const rows = {`
      + ` ready: m.computerHealth('vm', ready, facts),`
      + ` stale: m.computerHealth('vm', { ...ready, stateStale: true }, { ...facts, ageMs: 300000, stale: true }),`
      + ` image: m.computerHealth('vm', { ...ready, state: 'powered-off', restoreFrom: { kind: 'image' } }, { ageMs: null, stale: false, windowMs: null }),`
      + ` pinned: m.computerHealth('vm', { ...ready, isoMedia: 'pinned', isoSourceId: 'pinned-url' }, facts),`
      + ` locked: m.computerHealth('vm', { ...ready, lock: { heldBy: 'gc:vm', heldMs: 5000, poisoned: false } }, facts),`
      + ` noAge: m.computerHealth('vm', { ...ready }, { ageMs: null, stale: false, windowMs: null, source: null, confirmedAt: null }),`
      + ` linux: m.computerHealth('vm', { kind: 'linux', state: 'ready', stateStale: false }, { ageMs: null, stale: false, windowMs: null }) };`
      + `process.stdout.write(JSON.stringify({ holds, rows }));process.exit(0)`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, CUA_VM_STORE: path.join(store, 'store'), CUA_VM_HOME: path.join(store, 'home'), CUA_SUPERVISOR_SOCK: path.join(store, 's.sock') }
    })
    let parsed = null
    try { parsed = JSON.parse(result.stdout ?? 'null') } catch { parsed = null }
    const holds = parsed?.holds ?? {}
    const rows = parsed?.rows ?? {}

    // (1) THE SIX-STATE TABLE. `error`/`missing`/anything else are NULL, never
    // false: a torn or vanished disk is not a claim about memory.
    const live = ['ready', 'running', 'installing', 'booting']
    check('C4: stateHolds says memory+disk for every live state',
      live.every((state) => holds[state]?.memory === true && holds[state]?.disk === true && holds[state]?.text === 'memory+disk'),
      live.map((state) => `${state}=${JSON.stringify(holds[state])}`).join(' '))
    check('C4: stateHolds(suspended) keeps memory AND says resume is instant',
      holds.suspended?.memory === true && holds.suspended?.disk === true && /resume is instant/u.test(String(holds.suspended?.text ?? '')),
      JSON.stringify(holds.suspended))
    check('C4: stateHolds says disk-only (checkpoint) for powered-off/off/stopped',
      ['powered-off', 'off', 'stopped'].every((state) => holds[state]?.memory === false && holds[state]?.disk === true && holds[state]?.text === 'disk only (checkpoint)'),
      ['powered-off', 'off', 'stopped'].map((state) => `${state}=${JSON.stringify(holds[state])}`).join(' '))
    check('C4: stateHolds answers null/null (unverified) for error, missing, an unknown word and undefined — never false',
      ['error', 'missing', 'nonsense', 'undefined'].every((state) => holds[state]?.memory === null && holds[state]?.disk === null && holds[state]?.text === 'unverified'),
      ['error', 'missing', 'nonsense', 'undefined'].map((state) => `${state}=${JSON.stringify(holds[state])}`).join(' '))

    // (2) THE PER-COMPUTER VERDICT.
    check('C18: a fresh ready Windows row is ok and carries no guide',
      rows.ready?.verdict === 'ok' && rows.ready?.guide === null && rows.ready?.checks?.length === 6,
      JSON.stringify(rows.ready))
    check('C18: a stale Windows row is degraded, names state-fresh and prints the frozen guide',
      rows.stale?.verdict === 'degraded'
      && rows.stale?.checks?.some((entry) => entry.id === 'state-fresh' && entry.ok === false)
      && /has not answered for \d+m/u.test(String(rows.stale?.guide ?? '')),
      `${rows.stale?.verdict} ${JSON.stringify(rows.stale?.guide)}`)
    check('C18: a powered-off row whose restoreFrom.kind is image is degraded — Start would boot the base image',
      rows.image?.verdict === 'degraded'
      && rows.image?.checks?.some((entry) => entry.id === 'restore-point' && entry.ok === false)
      && rows.image?.guide === 'Start boots the base image: the previous disk is gone',
      `${rows.image?.verdict} ${JSON.stringify(rows.image?.guide)}`)
    check('C18: a pinned medium is degraded with the pin guide; a held lock is degraded and names the holder',
      rows.pinned?.verdict === 'degraded'
      && /operator-pinned medium/u.test(String(rows.pinned?.guide ?? ''))
      && rows.locked?.verdict === 'degraded'
      && /gc:vm/u.test(String(rows.locked?.guide ?? '')),
      `${rows.pinned?.verdict}/${JSON.stringify(rows.pinned?.guide)} ${rows.locked?.verdict}/${JSON.stringify(rows.locked?.guide)}`)
    // J6: THE SENTENCE FOLLOWS THE KIND. A Windows row with no parseable
    // `stateSince` has no recorded AGE — it is not a kind without a clock, and
    // printing the Linux sentence there told an operator the wrong thing.
    const noAgeDetail = String(rows.noAge?.checks?.find((entry) => entry.id === 'state-fresh')?.detail ?? '')
    check('J6: a Windows row with no recorded age says "no confirmation age", never "this kind has no staleness clock"',
      rows.noAge?.verdict === 'ok' && noAgeDetail.includes('no confirmation age recorded') && !noAgeDetail.includes('no staleness clock'),
      noAgeDetail)
    // A NULL CHECK NEVER DEGRADES: the Linux row has no staleness clock, no
    // restore point and no medium — all null — and it is still `ok`.
    check('C18: a null check never degrades (a Linux row: three null checks, verdict ok)',
      rows.linux?.verdict === 'ok'
      && rows.linux?.checks?.filter((entry) => entry.ok === null).length >= 2
      && rows.linux?.guide === null,
      JSON.stringify(rows.linux?.checks))
    // The verdict RULE itself: any false → degraded; else any true → ok; else
    // unknown. Asserted over every row above, so collapsing `null` into
    // `false` (a nag screen) or `true` (a green lie) fails here.
    const ruleHolds = Object.values(rows).every((row) => {
      const checks = Array.isArray(row?.checks) ? row.checks : []
      const expected = checks.some((entry) => entry.ok === false) ? 'degraded' : (checks.some((entry) => entry.ok === true) ? 'ok' : 'unknown')
      return row?.verdict === expected
    })
    check('C18: the verdict rule is any-false→degraded, else any-true→ok, else unknown (null never decides)',
      ruleHolds, JSON.stringify(Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, row?.verdict]))))
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
}

// (3) THE CHAIN'S ORDER, in the suite too: the gate can answer n/a in the flat
// image layout, and "mido first" is the whole point of candidate 19.
check('C19: resolveWindowsIsoSources("11") starts at mido and keeps the pinned mirrors',
  resolveWindowsIsoSources('11')[0]?.strategy === 'mido'
  && resolveWindowsIsoSources('11').some((source) => source.strategy === 'link1')
  && resolveWindowsIsoSources('11').map((source) => source.strategy).join(' -> ') === 'mido -> esd -> link1 -> link6 -> midoDirect',
  resolveWindowsIsoSources('11').map((source) => source.strategy).join(' -> '))
check('C19: the static API the quota/cache probe uses is unchanged (entry.url is still the pinned mirror)',
  typeof WINDOWS_ISO_SOURCES['11']?.url === 'string'
  && WINDOWS_ISO_SOURCES['11'].url.startsWith('https://dl.bobpony.com/windows/11/')
  && WINDOWS_ISO_SOURCES['11'].sources.length === 5,
  `${String(WINDOWS_ISO_SOURCES['11']?.url ?? '')} (${WINDOWS_ISO_SOURCES['11']?.sources?.length ?? 0} chain entries)`)

// ------------------------------------------------------------------ *
// C21 — THE NODE FLOOR, ASSERTED AGAINST THE SHIPPED FUNCTION
// ------------------------------------------------------------------ *
//
// `index.js` cannot be imported here (it needs the harness's schemastery), so
// the FUNCTION is sliced out of the file and evaluated: the assertions still run
// against the source that ships, and a drift in the arithmetic fails here.
{
  const indexText = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
  const marker = 'export function nodeFloorOk('
  const start = indexText.indexOf(marker)
  let end = -1
  if (start !== -1) {
    let depth = 0
    let quote = null
    for (let i = start; i < indexText.length; i += 1) {
      const ch = indexText[i]
      if (quote !== null) {
        if (ch === '\\') { i += 1; continue }
        if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
      if (ch === '{') depth += 1
      else if (ch === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
    }
  }
  let nodeFloorOk = null
  if (start !== -1 && end !== -1) {
    const source = indexText.slice(start, end).replace(/^export /u, '')
    nodeFloorOk = new Function(`${source}; return nodeFloorOk;`)()
  }
  const table = [['24.22.2', false], ['24.22.3', true], ['24.0.0', false], ['25.9.0', false], ['26.13.0', false], ['26.13.1', true], ['26.14.0', true], ['27.0.0', true]]
  const wrong = typeof nodeFloorOk !== 'function' ? 'nodeFloorOk not found in index.js' : table.filter(([version, expected]) => nodeFloorOk(version) !== expected).map(([version, expected]) => `${version}→${!expected}`).join(' ')
  check('C21: nodeFloorOk matches DSH 0.2.3-alpha.2 (24.22.3+ in 24.x, 26.13.1+ in 26.x, no 25.x)', wrong === '', wrong || 'all eight cases agree')
  const floor = /const DSH_NODE_FLOOR = '([^']+)'/u.exec(indexText)?.[1] ?? null
  check('C21: the floor constant and package.json engines state the same two numbers', floor === '24.22.3', String(floor))
}

// (5) THE SPOKEN HALF — the two answers agree with the prompt, for both kinds.
{
  const indexText = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
  check('C4: the shutdown answer states memory is freed and the disk survives in the checkpoint',
    indexText.includes('Memory is freed; the disk survives in the checkpoint (`cua_vm_start` cold-boots it).'),
    'the sentence is the contract the tool answer must carry')
  const suspend = 'Memory and the QEMU process are kept; resume is instant.'
  check('C4: BOTH suspend branches (Windows and Linux) say memory and the process are kept',
    (indexText.split('Memory and the QEMU process are kept; resume is instant.').length - 1) === 2,
    `${indexText.split(suspend).length - 1} occurrence(s)`)
}

// (6) CUA-CLI: THE DOCKERFILE RESOLVES THE NEWEST cua-sdk RELEASE AT BUILD TIME.
//
// `ARG CUA_CLI_VERSION=0.7.0` baked one release into every image, so "the image
// has the current CLI" was only true on the day the line was written. The default
// is now `latest` and the RUN resolves it from the releases API — which no unit
// test can prove by reading a string, because the bug lives in the shell (a grep
// that stops matching, a prefix strip that eats a digit, a failure swallowed by
// `|| true`).
//
// So the Dockerfile's RUN fragment is EXTRACTED and EXECUTED under `sh` with a stub
// `curl`. The payload below is the fixture; it is deliberate about the three
// things a naive implementation gets wrong — another package's tag comes first,
// an OLDER cua-sdk tag follows the newest, and a draft/prerelease entry is in
// between (the API's order is "newest first", which is what "first match" means).
{
  const dockerfileText = readFileSync(path.join(REPO, 'Dockerfile'), 'utf8')
  const RELEASES = JSON.stringify([
    { tag_name: 'cua-computer-v1.4.0', name: 'cua-computer 1.4.0', draft: false, prerelease: false, published_at: '2026-11-20T10:00:00Z' },
    { tag_name: 'cua-sdk-v0.9.4', name: 'cua-sdk 0.9.4', draft: false, prerelease: false, published_at: '2026-11-18T10:00:00Z' },
    { tag_name: 'cua-sdk-v0.10.0-rc.1', name: 'cua-sdk 0.10.0-rc.1', draft: true, prerelease: true, published_at: '2026-11-19T10:00:00Z' },
    { tag_name: 'cua-sdk-v0.9.3', name: 'cua-sdk 0.9.3', draft: false, prerelease: false, published_at: '2026-11-01T10:00:00Z' }
  ], null, 2)

  // The fragment is the RUN's own text, not a copy: this assertion is what makes
  // the two below honest when someone rewrites the step.
  let fragment = ''
  let parseError = ''
  try {
    fragment = extractResolveFragment(readRunBlock(dockerfileText))
  } catch (error) {
    parseError = String(error?.message ?? error)
  }
  check('CUA-CLI-1: the Dockerfile still carries the ARG + RUN fragment this test extracts',
    parseError === '' && /CUA_CLI_VERSION/u.test(fragment) && /cua-sdk-v/u.test(fragment),
    parseError || `${fragment.split('\n').length} shell line(s) from the RUN block`)

  const latest = simulateResolution({ dockerfileText, requested: 'latest', apiJson: RELEASES })
  check('CUA-CLI-2: latest takes the FIRST cua-sdk-v* tag (API order = newest) and strips the prefix',
    latest.status === 0 && latest.version === '0.9.4' && latest.curlCalled === true,
    `status ${latest.status}, version ${JSON.stringify(latest.version)}`)

  // The resolved version is what the URL spends — resolving 0.9.4 and fetching
  // 0.7.0 would be the exact defect the template needle guards.
  check('CUA-CLI-3: the asset URL is built from the RESOLVED version, per architecture',
    latest.version !== null
      && cuaCliAssetUrl(latest.version, 'x64') === 'https://github.com/trycua/cua/releases/download/cua-sdk-v0.9.4/cua-cli-0.9.4-linux-x64.tar.gz'
      && cuaCliAssetUrl(latest.version, 'arm64').endsWith('/cua-cli-0.9.4-linux-arm64.tar.gz'),
    cuaCliAssetUrl(latest.version ?? '?', 'x64'))

  const pinned = simulateResolution({ dockerfileText, requested: '0.7.0', apiJson: RELEASES })
  check('CUA-CLI-4: a non-latest CUA_CLI_VERSION is used verbatim, and the API is never called',
    pinned.status === 0 && pinned.version === '0.7.0' && pinned.curlCalled === false,
    `status ${pinned.status}, version ${JSON.stringify(pinned.version)}, curl ${pinned.curlCalled}`)

  const noTag = simulateResolution({
    dockerfileText, requested: 'latest', apiJson: JSON.stringify([{ tag_name: 'cua-computer-v1.4.0' }])
  })
  check('CUA-CLI-5: a response with no cua-sdk-v* tag FAILS instead of falling back to a frozen release',
    noTag.status !== 0 && noTag.version === null && /no cua-sdk-v\*/u.test(noTag.output),
    `status ${noTag.status}: ${noTag.output.trim().split('\n').at(-1) ?? ''}`)

  const apiDown = simulateResolution({ dockerfileText, requested: 'latest', apiFails: true })
  check('CUA-CLI-6: an unreachable releases API FAILS the build (curl exit 22 is not swallowed)',
    apiDown.status !== 0 && apiDown.version === null && /GitHub releases API did not answer/u.test(apiDown.output),
    `status ${apiDown.status}: ${apiDown.output.trim().split('\n').at(-1) ?? ''}`)

  check('CUA-CLI-7: the RUN queries the documented releases endpoint, not a cached or proxy URL',
    readRunBlock(dockerfileText).includes(RELEASES_API_URL), RELEASES_API_URL)
}


// (7) OPENCODE-CLI: THE OTHER CLI THE IMAGE RESOLVES AT BUILD TIME.
//
// The image deliberately does NOT bundle `dsh-opencode-connect` — the user adds
// it from the Plugins page — so the one thing it owes that plugin is a WORKING
// `opencode`. The plugin speaks the v1 root API paths (`/session`,
// `/config/providers`, `/event`) and spawns `opencode serve --port 40961`
// itself; a 2.x CLI would answer none of those calls. Same proof as CUA-CLI
// above: the Dockerfile's fragment, extracted and executed, never a copy.
//
// The fixture is deliberately hostile in four ways a naive resolver gets wrong:
// a v2 release at the TOP, a v2 PRE-RELEASE under it, another package's tag in
// between, and the newest v1 BELOW all of them (the real API interleaves the
// lines — v1.19.6 shipped after v2.3.1).
{
  const dockerfileText = readFileSync(path.join(REPO, 'Dockerfile'), 'utf8')
  const OPENCODE_RELEASES = JSON.stringify([
    { tag_name: 'v2.4.1', name: 'v2.4.1', draft: false, prerelease: false, published_at: '2026-11-22T10:00:00Z' },
    { tag_name: 'v2.0.0-rc.1', name: 'v2.0.0-rc.1', draft: false, prerelease: true, published_at: '2026-11-21T10:00:00Z' },
    { tag_name: 'process-daemon-v0.6.0', name: 'process-daemon 0.6.0', draft: false, prerelease: false, published_at: '2026-11-20T10:00:00Z' },
    { tag_name: 'v1.19.6', name: 'v1.19.6', draft: false, prerelease: false, published_at: '2026-11-17T10:00:00Z' },
    { tag_name: 'v1.18.35', name: 'v1.18.35', draft: false, prerelease: false, published_at: '2026-10-30T10:00:00Z' }
  ], null, 2)

  let fragment = ''
  let parseError = ''
  try {
    fragment = extractOpencodeResolveFragment(readOpencodeRunBlock(dockerfileText))
  } catch (error) {
    parseError = String(error?.message ?? error)
  }
  check('OPENCODE-CLI-1: the Dockerfile still carries the ARG + RUN fragment this test extracts',
    parseError === '' && /OPENCODE_VERSION/u.test(fragment) && /v1\./u.test(fragment),
    parseError || `${fragment.split('\n').length} shell line(s) from the RUN block`)

  const latest = simulateOpencodeResolution({ dockerfileText, requested: 'latest', apiJson: OPENCODE_RELEASES })
  check('OPENCODE-CLI-2: latest takes the FIRST v1.* tag and skips v2 (prerelease included) + other packages',
    latest.status === 0 && latest.version === '1.19.6' && latest.curlCalled === true,
    `status ${latest.status}, version ${JSON.stringify(latest.version)}`)
  check('OPENCODE-CLI-2b: the build log names the version it resolved AND the v2 tags it skipped',
    /resolved to 1\.19\.6/u.test(latest.stdout) && /skipped v2 tags: .*2\.4\.1/u.test(latest.stdout),
    (latest.stdout.match(/skipped v2 tags: .*$/mu) ?? ['missing'])[0])

  check('OPENCODE-CLI-3: the asset URL is built from the RESOLVED version, per target',
    latest.version !== null
      && opencodeAssetUrl(latest.version, 'x64') === 'https://github.com/sst/opencode/releases/download/v1.19.6/opencode-linux-x64.tar.gz'
      && opencodeAssetUrl(latest.version, 'arm64').endsWith('/opencode-linux-arm64.tar.gz'),
    opencodeAssetUrl(latest.version ?? '?', 'x64'))

  const pinned = simulateOpencodeResolution({ dockerfileText, requested: '1.19.6', apiJson: OPENCODE_RELEASES })
  check('OPENCODE-CLI-4: a pinned OPENCODE_VERSION is used as given, and the API is never called',
    pinned.status === 0 && pinned.version === '1.19.6' && pinned.curlCalled === false,
    `status ${pinned.status}, version ${JSON.stringify(pinned.version)}, curl ${pinned.curlCalled}`)

  // THE REASON THIS GATE EXISTS AT ALL: a 2.x CLI exists, is newer, and would be
  // resolved by a plain "newest tag" rule — and then the plugin could not talk to
  // it. Both the pin and the resolution must refuse it.
  const pinnedV2 = simulateOpencodeResolution({ dockerfileText, requested: '2.4.1', apiJson: OPENCODE_RELEASES })
  check('OPENCODE-CLI-5: a pinned 2.x version is REFUSED (the plugin speaks the v1 API)',
    pinnedV2.status !== 0 && pinnedV2.version === null && /speaks the v1 API/u.test(pinnedV2.output),
    `status ${pinnedV2.status}: ${pinnedV2.output.trim().split('\n').at(-1) ?? ''}`)

  const noV1 = simulateOpencodeResolution({
    dockerfileText, requested: 'latest', apiJson: JSON.stringify([{ tag_name: 'v2.4.1' }, { tag_name: 'v2.0.0-rc.1' }])
  })
  check('OPENCODE-CLI-6: a response with no v1.* tag FAILS instead of falling back to a frozen release',
    noV1.status !== 0 && noV1.version === null && /no v1\.\* release/u.test(noV1.output),
    `status ${noV1.status}: ${noV1.output.trim().split('\n').at(-1) ?? ''}`)

  const apiDown = simulateOpencodeResolution({ dockerfileText, requested: 'latest', apiFails: true })
  check('OPENCODE-CLI-7: an unreachable releases API FAILS the build (curl exit 22 is not swallowed)',
    apiDown.status !== 0 && apiDown.version === null && /GitHub releases API did not answer/u.test(apiDown.output),
    `status ${apiDown.status}: ${apiDown.output.trim().split('\n').at(-1) ?? ''}`)

  // The plugin's README gates on CLI >= 1.18.0 for the free tier; an older CLI in
  // the image is a plugin that installs and then shows no models.
  const tooOld = simulateOpencodeResolution({ dockerfileText, requested: '1.17.9', apiJson: OPENCODE_RELEASES })
  const atFloor = simulateOpencodeResolution({ dockerfileText, requested: '1.18.0', apiJson: OPENCODE_RELEASES })
  check('OPENCODE-CLI-8: the plugin free-tier floor (1.18.0) is enforced, and 1.18.0 itself passes',
    OPENCODE_PLUGIN_FLOOR === '1.18.0'
      && tooOld.status !== 0 && tooOld.version === null && /1\.18\.0 floor/u.test(tooOld.output)
      && atFloor.status === 0 && atFloor.version === '1.18.0',
    `1.17.9 → ${tooOld.status}, 1.18.0 → ${atFloor.status}`)

  const runBlock = readOpencodeRunBlock(dockerfileText)
  check('OPENCODE-CLI-9: the RUN queries the documented releases endpoint, not a cached or proxy URL',
    runBlock.includes(OPENCODE_RELEASES_API_URL)
      && OPENCODE_RELEASES_API_URL === 'https://api.github.com/repos/sst/opencode/releases?per_page=100',
    OPENCODE_RELEASES_API_URL)
  check('OPENCODE-CLI-10: the binary lands on /usr/local/bin/opencode (third in the plugin lookup order) and is verified',
    runBlock.includes('/usr/local/bin/opencode --version')
      && /tar -xzf [^\n]*\s+-C \/usr\/local\/bin opencode/u.test(runBlock),
    'tar → /usr/local/bin/opencode, then --version')

  check('OPENCODE-CLI-11: the tag helper accepts v1 tags only',
    opencodeVersionFromTagName('v1.19.6') === '1.19.6'
      && opencodeVersionFromTagName('v2.4.1') === null
      && opencodeVersionFromTagName('process-daemon-v0.6.0') === null,
    'three cases')
}

console.log(failures === 0 ? '\nunit: PASS' : `\nunit: ${failures} FAILURE(S)`)
if (pendings > 0) {
  console.log(`unit: ${pendings} check(s) PENDING — the production half is absent (SOL WP-4).`)
  console.log('  Run with DSH_CUA_CONTRACT_STRICT=1 to require them now (the T2 mutation check).')
}
process.exit(failures === 0 ? 0 : 1)
