/**
 * 03-answer-media-and-argv.mjs — the answer-file medium, the boot order and the ISO source chain.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { WINDOWS_ISO_SOURCES, WINDOWS_VERSIONS, buildQemuArgs, canonicalWindowsVersion, check, frameSpace, png, resolveWindowsIso, resolveWindowsIsoSources, vncDisplayFor, vncPortFor } from './harness.mjs'
import { argv, has, paths } from './02-windows-catalog.mjs'

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
