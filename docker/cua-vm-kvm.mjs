/**
 * cua-vm-kvm — ONE honest answer to "can THIS process open /dev/kvm?", and the
 * TWO different failures that used to share a single misleading sentence.
 *
 * THE BUG THIS MODULE EXISTS FOR
 * ------------------------------
 * A user on the latest branch image, with `devices: [/dev/kvm]` demonstrably in
 * their compose and `/dev/kvm` visible inside the container, got:
 *
 *   the Windows backend needs /dev/kvm (compose.emulator.yaml)
 *
 * Two separate defects produced that one sentence:
 *
 *   1. THE PROBE WAS WRONG FOR DEVICE NODES. `windowsHostCaps()` asked
 *      `statSync('/dev/kvm').isFile()`. `/dev/kvm` is a CHARACTER DEVICE
 *      (`crw-rw-rw-`), for which `isFile()` is `false` — so the capability was
 *      reported "absent" on a host where it was present, readable and writable.
 *      `access(2)` was never consulted at all, so a DENIED device and a MISSING
 *      device were indistinguishable.
 *   2. EVEN WITH A CORRECT EXISTENCE PROBE, the container's runtime user (uid
 *      1000, `USER node`) is not in the `kvm` group. The host's node is normally
 *      `root:kvm 0660`; Docker passes it through with that gid, so
 *      `open(O_RDWR)` fails with EACCES. Telling that user "add devices:
 *      /dev/kvm" is wrong advice — the device is already there.
 *
 * So the states are split, and each one carries the fix that actually applies:
 *
 *   ok          readable AND writable by this uid → nothing to say
 *   missing     the node is not in this container (ENOENT) → add `devices:`
 *   denied      the node is there and this uid may not open it (EACCES) → GID
 *   not-device  something exists at the path but is not a character device
 *
 * PURITY: every effect is injectable (`stat`, `access`, `uid`, `gid`, `groups`),
 * so both branches are unit-tested on a host that has no /dev/kvm at all.
 */

import { accessSync, constants as fsConstants, statSync } from 'node:fs'

/** The device every Linux VM backend needs. Overridable for tests only. */
export const KVM_DEVICE = process.env.DSH_CUA_KVM_DEVICE || '/dev/kvm'

/** The one command that answers "which gid does the host use for kvm?". */
export const KVM_GID_COMMAND = 'stat -c %g /dev/kvm'

/** States, in the order a message picks them. */
export const KVM_STATES = Object.freeze(['ok', 'missing', 'denied', 'not-device'])

/**
 * `true` when `file` is a device node this process could plausibly open.
 *
 * This is the replacement for `statSync(file).isFile()`: a character device is
 * presence, a regular file at that path is not, and a missing path is neither.
 * Injectable so a test can prove the character-device case without /dev/kvm.
 */
export function deviceNodePresent(file, stat = statSync) {
  try {
    const info = stat(file)
    if (typeof info.isCharacterDevice === 'function') return info.isCharacterDevice()
    // A stubbed stat() in a test may only carry a mode.
    const type = Number(info.mode) & 0o170000
    return type === 0o020000
  } catch {
    return false
  }
}

/** Regular-file presence (quem binaries, OVMF, swtpm) — unchanged semantics. */
export function regularFilePresent(file, stat = statSync) {
  try {
    const info = stat(file)
    if (typeof info.isFile === 'function') return info.isFile()
    const type = Number(info.mode) & 0o170000
    return type === 0o100000
  } catch {
    return false
  }
}

/** "uid 1000" — never a bare number in a message a human has to act on. */
function whoami(identity) {
  const groups = Array.isArray(identity.groups) ? identity.groups.join(',') : ''
  return `uid ${identity.uid ?? '?'}, gid ${identity.gid ?? '?'}, supplementary groups ${groups === '' ? 'none' : groups}`
}

/**
 * Which permission class a mode grants this identity: 'owner' | 'group' | 'other'.
 * This is what makes the message say WHY the uid is refused instead of only that
 * it is.
 */
function permissionClass({ mode, uid, gid }, identity) {
  if (identity.uid !== null && Number(identity.uid) === uid) return 'owner'
  const groups = Array.isArray(identity.groups) ? identity.groups.map(Number) : []
  if (groups.includes(gid)) return 'group'
  if (identity.gid !== null && Number(identity.gid) === gid) return 'group'
  return 'other'
}

/**
 * Classify the device ONCE. Never throws: the whole point is that a probe of a
 * device that cannot be opened is a normal, reportable answer.
 */
export function kvmStatus(options = {}) {
  const device = String(options.device ?? KVM_DEVICE)
  const stat = options.stat ?? statSync
  const access = options.access ?? accessSync
  const identity = {
    uid: options.uid !== undefined ? options.uid : (typeof process.getuid === 'function' ? process.getuid() : null),
    gid: options.gid !== undefined ? options.gid : (typeof process.getgid === 'function' ? process.getgid() : null),
    groups: options.groups !== undefined
      ? options.groups
      : (typeof process.getgroups === 'function' ? process.getgroups() : [])
  }
  const base = {
    device,
    identity,
    state: 'ok',
    exists: false,
    readable: false,
    writable: false,
    denied: null,
    info: null,
    reason: ''
  }

  let info
  try {
    info = stat(device)
  } catch (error) {
    const code = String(error?.code ?? 'UNKNOWN')
    if (code === 'EACCES' || code === 'EPERM') {
      // The node may be there and a PARENT directory non-traversable: the answer
      // is still EACCES, but not a GID the user can copy out of the message.
      return {
        ...base,
        state: 'denied',
        exists: true,
        denied: code,
        reason: `stat(${device}) was denied (${code}) — an ANCESTOR directory is not traversable by ${whoami(identity)}, so the device cannot even be described`
      }
    }
    return {
      ...base,
      state: 'missing',
      reason: `stat(${device}) answered ${code} — the device node is not in this container`
    }
  }

  const mode = Number(info.mode) & 0o777
  const described = {
    mode,
    modeText: mode.toString(8).padStart(4, '0'),
    uid: Number(info.uid),
    gid: Number(info.gid),
    isCharDevice: deviceNodePresent(device, () => info),
    owner: `${info.uid}:${info.gid}`
  }
  const withInfo = { ...base, exists: true, info: described }

  if (described.isCharDevice !== true) {
    return {
      ...withInfo,
      state: 'not-device',
      denied: 'ENODEV',
      reason: `${device} exists but is NOT a character device (mode ${described.modeText}, owner ${described.owner})`
    }
  }

  /** One access(2) question, as the answer nobody has to interpret. */
  const can = (flag) => {
    try {
      access(device, flag)
      return { ok: true, code: null }
    } catch (error) {
      return { ok: false, code: String(error?.code ?? 'EACCES') }
    }
  }
  const read = can(fsConstants.R_OK)
  const write = can(fsConstants.W_OK)
  const klass = permissionClass(described, identity)
  const granted = klass === 'owner'
    ? ((mode >> 6) & 0o7)
    : klass === 'group'
      ? ((mode >> 3) & 0o7)
      : (mode & 0o7)
  const bits = `${klass} bits ${granted.toString(8)} of mode ${described.modeText}`

  if (read.ok && write.ok) {
    return {
      ...withInfo,
      state: 'ok',
      readable: true,
      writable: true,
      reason: `readable and writable by ${whoami(identity)} (mode ${described.modeText}, owner ${described.owner}; ${bits})`
    }
  }
  const failed = !read.ok ? read.code : write.code
  const what = !read.ok && !write.ok ? 'read/write' : (!read.ok ? 'read' : 'write')
  return {
    ...withInfo,
    state: 'denied',
    readable: read.ok,
    writable: write.ok,
    denied: failed,
    reason: `mode ${described.modeText} owner ${described.owner} grants ${bits}, so ${whoami(identity)} cannot ${what} it (${failed})`
  }
}

/** The compose/CIDR hint that never changes: the host gid command. */
const GID_FIX = [
  'FIX — give the container\'s runtime user the device\'s GROUP (group membership is',
  'fixed when the container is CREATED, so a restart does not apply it):',
  '',
  `  1. on the HOST, read the gid of the device:   ${KVM_GID_COMMAND}`,
  '  2. in .env, record it:                        KVM_GID=<that gid>',
  '     (or non-interactively: echo "KVM_GID=$(' + KVM_GID_COMMAND + ')" >> .env)',
  '  3. in the compose SERVICE (compose.yaml, or compose.emulator.yaml / compose.windows.yaml):',
  '       group_add:',
  '         - "${KVM_GID:-<that gid>}"',
  '  4. recreate the container:',
  '       docker compose -f compose.yaml -f compose.windows.yaml up -d --force-recreate',
  '  5. verify INSIDE it:',
  '       ls -l /dev/kvm && id        # the device gid must appear in id\'s group list',
  '',
  'Alternative when the compose file cannot be changed — make the device world-accessible',
  'on the HOST with a udev rule (docker passes the node with the mode it has):',
  '  # /etc/udev/rules.d/99-kvm.rules',
  '  KERNEL=="kvm", GROUP="kvm", MODE="0666"',
  '  sudo udevadm control --reload-rules && sudo udevadm trigger /dev/kvm'
].join('\n')

/**
 * The error for a device that cannot be used, with the case split.
 *
 * `purpose` is the caller ("the Windows backend", "the Linux VM (cua sb create)")
 * so one message serves both backends without pretending they are the same path.
 * Returns `null` when the device is fine — callers use it as a preflight.
 */
export function kvmPreflightError(status, { purpose = 'the Windows backend' } = {}) {
  if (status === null || status === undefined || status.state === 'ok') return null
  const device = status.device ?? KVM_DEVICE
  const lines = []
  let code = 'ENODEV'

  if (status.state === 'missing') {
    code = 'ENOENT'
    lines.push(
      `${purpose} needs /dev/kvm (compose.emulator.yaml): ${device} does not exist in this container (ENOENT).`,
      '',
      'The device node is NOT mounted. A device cannot live in an image, so it is passed by an',
      'override file — and the override must be on the same `docker compose` command line as the',
      'base file:',
      '',
      '  # compose.yaml (or an override you keep):',
      '  services:',
      '    seek-harness:',
      '      devices:',
      '        - /dev/kvm',
      '',
      '  docker compose -f compose.yaml -f compose.emulator.yaml up -d',
      '',
      'If `docker compose config` lists the device and it is still absent inside, the container was',
      'NOT recreated with that override (`docker compose up -d` alone reuses the old one):',
      '  docker compose -f compose.yaml -f compose.emulator.yaml up -d --force-recreate',
      '',
      'The HOST must have it too: /dev/kvm exists only on a host with virtualisation enabled, and on',
      'a host that is itself a VM only with nested virtualisation on. Check on the host:',
      '  ls -l /dev/kvm || echo "the host has no /dev/kvm — enable VT-x/AMD-V (and nested virt)"'
    )
  } else if (status.state === 'denied') {
    code = status.denied === 'EPERM' ? 'EPERM' : 'EACCES'
    const described = status.info
    const subject = described === null
      // stat itself was denied: no mode to quote, and no gid to copy.
      ? `  ${status.reason}`
      : [
          `  ${device} is mode ${described.modeText}, owner ${described.uid}:${described.gid} (uid:gid)`,
          `  this process is ${whoami(status.identity)}`,
          `  → ${status.reason}`
        ].join('\n')
    lines.push(
      `${purpose} cannot OPEN ${device} — the device IS mounted. This is a GROUP/GID problem, not a missing device.`,
      '',
      subject,
      '',
      'QEMU opens /dev/kvm O_RDWR. A host node is normally root:kvm 0660, and Docker passes the',
      'node through with that gid — while this container runs as uid 1000 (`USER node`), whose',
      `supplementary groups do not include the device's gid. So access(open, O_RDWR) fails with EACCES.`,
      '',
      GID_FIX
    )
  } else {
    // not-device
    lines.push(
      `${purpose} needs a KVM device node, but ${device} is not one: ${status.reason}.`,
      '',
      'A regular file or a directory at that path means a bind mount / `devices:` entry is wrong —',
      'or a previous workaround created a placeholder there. Pass the real character device:',
      '',
      '  devices:',
      '    - /dev/kvm',
      '',
      'and confirm on the HOST that it is a character device:',
      `  test -c /dev/kvm && ls -l /dev/kvm      # else: modprobe kvm_intel / kvm_amd`
    )
  }

  return Object.assign(new Error(lines.join('\n')), {
    code,
    kvmState: status.state,
    kvmDevice: device,
    // Machine-readable, for the panel and for a caller that wants to branch.
    kvmInfo: status.info,
    kvmDenied: status.denied
  })
}

/** One line for `cua_vm_doctor` — accurate for a mounted-but-denied device. */
export function formatKvmStatus(status) {
  if (status.state === 'ok') return `${status.info.modeText} (${status.info.isCharDevice ? 'character device' : 'device'}, writable by uid ${status.identity.uid})`
  if (status.state === 'missing') return 'absent (device not mounted)'
  if (status.state === 'not-device') return `NOT a device (${status.info?.modeText ?? '?'}, regular file)`
  return `DENIED (${status.info === null ? status.denied : `mode ${status.info.modeText} owner ${status.info.uid}:${status.info.gid}, not openable by uid ${status.identity.uid}`})`
}

/** Doctor facts in one object, so the panel never has to re-derive them. */
export function kvmDoctorFacts(status) {
  return {
    kvm: formatKvmStatus(status),
    kvmUsable: status.state === 'ok',
    kvmDevice: status.device,
    kvmState: status.state,
    kvmMode: status.info === null ? null : status.info.modeText,
    kvmOwner: status.info === null ? null : `${status.info.uid}:${status.info.gid}`,
    kvmGroups: Array.isArray(status.identity.groups) ? status.identity.groups : [],
    kvmReason: status.reason
  }
}
