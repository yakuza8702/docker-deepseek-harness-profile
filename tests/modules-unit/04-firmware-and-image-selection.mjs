/**
 * 04-firmware-and-image-selection.mjs — firmware profiles, image selection and the ISO cache decision.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { WINDOWS_CATALOG, WINDOWS_IMAGE_SELECTIONS, WINDOWS_VERSIONS, buildQemuArgs, check, clipAckMatches, clipSha256, isoFileName, mkdtempSync, os, path, resolveWindowsImageSelection, rmSync, verifyIsoDigest, windowsFirmwareForSpec, windowsFirmwareProfile, windowsPaths, writeFileSync } from './harness.mjs'


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
