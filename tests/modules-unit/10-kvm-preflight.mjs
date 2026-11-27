/**
 * 10-kvm-preflight.mjs — the /dev/kvm pre-flight: missing, denied, not-a-device and the doctor facts.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { KVM_GID_COMMAND, accessSync, check, deviceNodePresent, existsSync, formatKvmStatus, fsConstants, kvmDoctorFacts, kvmPreflightError, kvmStatus, os, path, rmSync, windowsKvmPreflight, writeFileSync } from './harness.mjs'



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
