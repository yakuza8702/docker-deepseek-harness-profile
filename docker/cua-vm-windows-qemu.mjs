/**
 * cua-vm-windows-qemu — a Windows computer as a DIRECT QEMU process.
 *
 * WHY THIS EXISTS (and what it replaced)
 * --------------------------------------
 * Windows used to be a third-party Windows container image on a Docker Engine sidecar.
 * That architecture had three problems that could not be fixed from inside it:
 *
 *   1. it needed a second container runtime (privileged DinD) just to hold a
 *      QEMU that this image can run itself;
 *   2. its own monitor owned port 7100, so our QMP collided with it at boot;
 *   3. the store was split — the container's `/storage` bind had to be the same
 *      volume as `/cua-vm` or frames and credentials lived in two places.
 *
 * So Windows is now what Linux already is: `qemu-system-x86_64` started by the
 * supervisor, with the SAME /dev/kvm, the SAME `/cua-vm` store, the SAME
 * lifecycle locks and the SAME shutdown/checkpoint machinery. What changes is
 * only the firmware and the guest-facing devices:
 *
 *   firmware   OVMF (UEFI), with a per-computer vars store under
 *              `$STORE/windows/<name>/efi-vars.qcow2`, plus a swtpm TPM2 so
 *              Windows 11's installer is satisfied honestly instead of being
 *              talked past with registry bypasses.
 *   disks      qcow2 under `$STORE/windows/<name>/disk.qcow2` — a plain qcow2,
 *              which is why `qemu-img convert` checkpointing keeps working.
 *   install    the pinned Microsoft ISO, a FAT `vvfat` directory holding
 *              `Autounattend.xml` + the OEM scripts (see docker/windows-oem/),
 *              and — when the operator provides it — the virtio-win drivers ISO.
 *   control    QMP on loopback (screendump / input-send-event / query-status /
 *              system_powerdown / quit) and a VNC display on loopback that the
 *              proxy relays, so "Show VM" is a live stream the user drives.
 *
 * WHAT THIS MODULE IS, AND IS NOT
 * -------------------------------
 * It is a COMMAND BUILDER plus lifecycle helpers over injected primitives
 * (`spawn`, `qmp`, `log`, `now`), so the argv can be asserted in a test without
 * a hypervisor, and so the supervisor keeps owning every lock, the registry and
 * the quotas. It never reads the registry and never writes it.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { pngSize } from './cua-vm-space.mjs'
import { KVM_DEVICE, deviceNodePresent, kvmPreflightError, kvmStatus, regularFilePresent } from './cua-vm-kvm.mjs'

/* ------------------------------------------------------------------ *
 * The pinned images
 * ------------------------------------------------------------------ */

/**
 * Windows versions and where their install media comes from.
 *
 * PROBED LIVE (ranged GET, 2 bytes, 2026-11-15): of the five URLs this module
 * used to pin, four answer **HTTP 400** and one answers **206** — Microsoft
 * moved the older evaluation media behind a session-token download page. A
 * pinned URL that 400s is worse than no pin at all: the first create of every
 * default version died inside the download with a generic error.
 *
 * So the contract is now explicit:
 *
 *   * `url` is non-null ONLY when it was probed and answered (today: Server
 *     2025).
 *   * `url: null` means "no public direct link": the version is still listed
 *     (the answer file and the floors are version-independent), but a create
 *     must be given `windowsIso` — a direct URL or a local ISO. The refusal
 *     names the version and the two remediations, before any bytes move.
 *
 * An operator-supplied ISO is therefore the PRIMARY path, and the pinned list is
 * a convenience where one exists — which is also the honest shape, because
 * Microsoft's own download pages are session-token protected.
 */
export const WINDOWS_ISO_SOURCES = {
  '2025': {
    label: 'Windows Server 2025 (evaluation)',
    url: 'https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/26100.1742.240906-0331.ge_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso',
    probed: '2026-11-15: HTTP 206 (ranged GET)'
  },
  '11ltsc': {
    label: 'Windows 11 IoT Enterprise LTSC 2024 (evaluation)',
    // PROBED 2026-11-15 with a ranged GET: HTTP 206, 5,060,020,224 bytes. This is
    // the URL the Evaluation Center's own x64 button resolves to
    // (go.microsoft.com/fwlink/?linkid=2270353 → this static prss.microsoft.com
    // object), so it is an official Microsoft host, not a mirror.
    url: 'https://software-static.download.prss.microsoft.com/dbazure/998969d5-f34g-4e03-ac9d-1f9786c66749/26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso',
    probed: '2026-11-15: HTTP 206 (ranged GET), 5,060,020,224 bytes'
  },
  '11': {
    label: 'Windows 11 (evaluation)',
    url: null,
    note: 'Microsoft publishes the 11 evaluation ISO through the Evaluation Center page, which is session-token protected',
    probed: '2026-11-15: the previously pinned URL answers HTTP 400'
  },
  '10': {
    label: 'Windows 10 (evaluation)',
    url: null,
    note: 'the same: a session-token download page, no stable direct link',
    probed: '2026-11-15: the previously pinned URL answers HTTP 400'
  },
  ltsc10: {
    label: 'Windows 10 LTSC (evaluation)',
    url: null,
    note: 'LTSC evaluation media is served from the Evaluation Center only',
    probed: '2026-11-15: the previously pinned URL answers HTTP 400'
  },
  '2022': {
    label: 'Windows Server 2022 (evaluation)',
    url: null,
    note: 'the 2022 evaluation link was retired; 2025 is the pinned Server image',
    probed: '2026-11-15: the previously pinned URL answers HTTP 400'
  }
}

/**
 * Resolve a version to a downloadable URL, or explain precisely why there is
 * none. Called BEFORE any download so the refusal is cheap and actionable.
 */
export function resolveWindowsIso(version) {
  const canonical = canonicalWindowsVersion(version)
  const entry = WINDOWS_ISO_SOURCES[canonical]
  if (entry === undefined) {
    throw new Error(`windowsVersion must be one of ${WINDOWS_VERSIONS.join(', ')} (or give windowsIso instead)`)
  }
  if (entry.url === null) {
    throw new Error(`windowsVersion "${version}" has no public direct ISO link (${entry.note}). `
      + 'Pass windowsIso instead: either a direct https URL, or a local .iso file inside the VM store or the workspace. '
      + `Versions with a pinned, probed link: ${WINDOWS_VERSIONS.filter((key) => WINDOWS_ISO_SOURCES[key].url !== null).join(', ') || 'none'}.`)
  }
  return { entry, url: entry.url }
}

export const WINDOWS_VERSIONS = ['11', '11ltsc', '10', 'ltsc10', '2022', '2025']

/**
 * Aliases people type. `ltsc11` is the obvious one for Windows 11 LTSC (the
 * Windows 10 one is `ltsc10`), so it is accepted everywhere a version is.
 */
export const WINDOWS_VERSION_ALIASES = { ltsc11: '11ltsc' }

/** The canonical version for a user-supplied string (alias-aware). */
export function canonicalWindowsVersion(version) {
  const text = String(version ?? '')
  return WINDOWS_VERSION_ALIASES[text] ?? text
}

/** Floors a Windows install does not survive below (same as the old backend). */
export const WINDOWS_MIN_MEMORY_GB = 6
export const WINDOWS_MIN_DISK_GB = 64
export const WINDOWS_MIN_CPU = 2
export const WINDOWS_DEFAULT_CPU = 2
export const WINDOWS_DEFAULT_MEMORY_GB = 6
export const WINDOWS_DEFAULT_DISK_GB = 64
export const WINDOWS_USERNAME = 'cua'

/** Which QEMU this module drives. The system build is the only one with OVMF.** */
export const WINDOWS_QEMU = process.env.DSH_CUA_WINDOWS_QEMU || '/usr/bin/qemu-system-x86_64'
/** OVMF code image (read-only) and the template for the per-VM vars store. */
export const OVMF_CODE = process.env.DSH_CUA_WINDOWS_OVMF_CODE || '/usr/share/OVMF/OVMF_CODE_4M.fd'
export const OVMF_VARS_TEMPLATE = process.env.DSH_CUA_WINDOWS_OVMF_VARS || '/usr/share/OVMF/OVMF_VARS_4M.fd'
/** swtpm (TPM2 emulator) — a software TPM, no hardware needed. */
export const SWTPM = process.env.DSH_CUA_WINDOWS_SWTPM || '/usr/bin/swtpm'
/** Optional virtio-win drivers ISO (see attachDrivers()). */
export const VIRTIO_WIN_ISO = process.env.DSH_CUA_WINDOWS_VIRTIO_ISO || ''

/** The kill switch: DSH_CUA_VM_WINDOWS=0 removes the option entirely. */
export function windowsEnabled() {
  return String(process.env.DSH_CUA_VM_WINDOWS ?? '1') !== '0'
}

/**
 * The capacity advice for a Windows computer.
 *
 * The three numbers below are RECOMMENDATIONS (the defaults), not gates: a
 * smaller computer is created when it is asked for, and this function produces
 * the warnings that travel with the result and the panel. It is pure so the
 * decision can be tested without a hypervisor.
 */
export function windowsCapacityWarnings({ diskGb, memory, cpu }) {
  const warnings = []
  if (Number(diskGb) < WINDOWS_MIN_DISK_GB) {
    warnings.push({
      code: 'disk-below-floor',
      message: `disk ${diskGb} GB is below the recommended ${WINDOWS_MIN_DISK_GB} GB floor; a Windows install needs roughly 52 GB after updates, so Windows Update will run out of space and the install may fail. Created anyway on request (the quota still counts the real bytes).`
    })
  }
  if (Number(memory) < WINDOWS_MIN_MEMORY_GB) {
    warnings.push({
      code: 'memory-below-floor',
      message: `RAM ${memory} GB is below the recommended ${WINDOWS_MIN_MEMORY_GB} GB floor; Setup and the first logon will be very slow and may fail. Created anyway on request.`
    })
  }
  if (Number(cpu) < WINDOWS_MIN_CPU) {
    warnings.push({
      code: 'cpu-below-floor',
      message: `${cpu} vCPU is below the recommended ${WINDOWS_MIN_CPU}; Windows Setup will be slow. Created anyway on request.`
    })
  }
  return warnings
}

/**
 * Is this host able to boot a Windows computer at all?
 *
 * `kvm` used to be `statSync('/dev/kvm').isFile()`, which is FALSE for a device
 * node: a container with the device mounted, mode 0666, answered "kvm: false"
 * and the create said "needs /dev/kvm (compose.emulator.yaml)". Two facts are
 * now reported separately, because they have two different fixes:
 *
 *   kvm         the device node is present (a CHARACTER device, not a file)
 *   kvmUsable   access(R_OK|W_OK) SUCCEEDS for this uid — a present-but-denied
 *               node is `kvm: true, kvmUsable: false`, and its error names the
 *               gid/group_add fix instead of telling the user to mount it again
 *
 * `kvmStatus` is exported too, so the doctor and the create path quote the same
 * observation (mode, usr:grp, this process's groups) instead of re-deriving it.
 */
export function windowsHostCaps() {
  // SELF-TEST HOOK. The create path (quota → ports → ISO → OEM payload → boot) is
  // the part worth testing, and it cannot run on a host without qemu/OVMF/swtpm.
  // This makes the capability check report "present" so the smoke suite can drive
  // the real code. It is never set in compose/.env, and a gate forbids that.
  if (String(process.env.DSH_CUA_WINDOWS_FAKE_HOST_CAPS ?? '') === '1') {
    return { qemu: true, ovmfCode: true, ovmfVars: true, swtpm: true, virtioWin: false, kvm: true, kvmUsable: true, render: true, faked: true }
  }
  const kvm = kvmStatus()
  return {
    qemu: regularFilePresent(WINDOWS_QEMU),
    ovmfCode: regularFilePresent(OVMF_CODE),
    ovmfVars: regularFilePresent(OVMF_VARS_TEMPLATE),
    swtpm: regularFilePresent(SWTPM),
    virtioWin: VIRTIO_WIN_ISO !== '' && regularFilePresent(VIRTIO_WIN_ISO),
    // A device node is presence; whether THIS uid may open it is `kvmUsable`.
    kvm: deviceNodePresent(KVM_DEVICE) || kvm.exists,
    kvmUsable: kvm.state === 'ok',
    kvmMode: kvm.info === null ? null : kvm.info.modeText,
    kvmOwner: kvm.info === null ? null : `${kvm.info.uid}:${kvm.info.gid}`,
    kvmGroups: kvm.identity.groups,
    kvmReason: kvm.reason,
    render: deviceNodePresent('/dev/dri/renderD128')
  }
}

/**
 * The Windows backend's KVM preflight, as one exported value.
 *
 * Both the supervisor (before a single byte of ISO is downloaded) and `boot()`
 * (before swtpm is spawned) ask THIS, so the two refusals cannot drift apart —
 * and neither can fall back to the old "needs /dev/kvm (compose.emulator.yaml)"
 * sentence, which was wrong for a mounted-but-denied device.
 */
export function windowsKvmPreflight() {
  // The documented self-test hook reports the capabilities present; the device
  // refusal must honour it too, or the smoke suite would pass on this host and
  // fail on a CI runner that has no /dev/kvm.
  if (String(process.env.DSH_CUA_WINDOWS_FAKE_HOST_CAPS ?? '') === '1') return null
  return kvmPreflightError(kvmStatus(), { purpose: 'the Windows backend' })
}

/* ------------------------------------------------------------------ *
 * Paths — everything Windows lives under $STORE
 * ------------------------------------------------------------------ */

/**
 * ONE DIRECTORY PER COMPUTER, and nothing outside `$STORE`.
 *
 *   $STORE/windows/<name>/disk.qcow2        the system disk (plain qcow2)
 *   $STORE/windows/<name>/efi-vars.qcow2    OVMF NVRAM (boot order, keys)
 *   $STORE/windows/<name>/tpm/              swtpm state (persisted TPM2)
 *   $STORE/windows/<name>/oem/              Autounattend.xml + Setup scripts
 *   $STORE/windows/<name>/credentials.json  the generated password + SSH key
 *   $STORE/windows/<name>/serial.log        the console (also the install tail)
 *   $STORE/iso/                             downloaded install media
 */
export function windowsPaths(store, name) {
  const dir = path.join(store, 'windows', name)
  return {
    dir,
    disk: path.join(dir, 'disk.qcow2'),
    efiVars: path.join(dir, 'efi-vars.qcow2'),
    tpmDir: path.join(dir, 'tpm'),
    tpmSocket: path.join(dir, 'swtpm.sock'),
    tpmPid: path.join(dir, 'swtpm.pid'),
    oemDir: path.join(dir, 'oem'),
    credentials: path.join(dir, 'credentials.json'),
    sshKey: path.join(dir, 'id_ed25519'),
    sshKeyPub: path.join(dir, 'id_ed25519.pub'),
    serialLog: path.join(dir, 'serial.log'),
    qemuPid: path.join(dir, 'qemu.pid'),
    qmp: path.join(dir, 'qmp.json'),
    isoDir: path.join(store, 'iso')
  }
}

/* ------------------------------------------------------------------ *
 * The command line
 * ------------------------------------------------------------------ */

/**
 * The QEMU argv for one Windows computer.
 *
 * DESIGN NOTES THAT MATTER WHEN SOMETHING DOES NOT BOOT:
 *
 *   * `q35` + `-cpu host` + KVM: the same acceleration the Linux guest uses;
 *     without /dev/kvm this refuses at start rather than crawling.
 *   * The two pflash drives are the firmware. OVMF_CODE is read-only and
 *     SHARED; `efi-vars.qcow2` is PER COMPUTER, so boot entries and the TPM's
 *     measured state survive a restart (a fresh vars file re-runs Setup).
 *   * `swtpm` is a separate process listening on a unix socket; QEMU's chardev
 *     connects to it. Both are cleaned up by `stopSwtpm`.
 *   * The install medium and the OEM payload are CD-ROM / USB removable media,
 *     because that is where Setup looks for `Autounattend.xml`. The OEM payload
 *     is a `vvfat` directory (no ISO authoring tool needed — the host may have
 *     none) exposed as a USB stick.
 *   * `bootindex` puts the install ISO first ONLY while the disk is empty;
 *     after the first boot the disk owns the boot order (see `installPending`).
 *   * Networking is SLIRP: outbound internet, the host reachable at 10.0.2.2,
 *     and SSH forwarded from 127.0.0.1:<port> to guest :22. No bridge, no tap,
 *     no CAP_NET_ADMIN — the harness keeps `cap_drop ALL`.
 *   * Video: `-vga std` by default (a plain framebuffer every Windows has an
 *     inbox driver for). With `gpu: true` the display becomes virtio-gpu backed
 *     by the host's render node — the SAME virgl wiring as the Linux guest —
 *     with the honest caveat documented in the README: Windows has no
 *     accelerated 3D driver here, so Direct3D falls back to WARP (CPU).
 */
export function buildQemuArgs(spec) {
  const p = spec.paths
  const boot = spec.installPending === true
  const args = [
    '-name', `dsh-win-${spec.name}`,
    '-machine', 'q35,accel=kvm,smm=off',
    '-cpu', 'host',
    '-smp', String(spec.cpu),
    '-m', String(spec.memory * 1024),
    // firmware: shared code + per-computer NVRAM
    '-drive', `if=pflash,format=raw,readonly=on,file=${OVMF_CODE}`,
    '-drive', `if=pflash,format=qcow2,file=${p.efiVars}`,
    // TPM2: char socket to swtpm + the TPM device Windows 11 requires
    '-chardev', `socket,id=chrtpm,path=${p.tpmSocket}`,
    '-tpmdev', 'emulator,id=tpm0,chardev=chrtpm',
    '-device', 'tpm-crb,tpmdev=tpm0',
    // system disk
    '-drive', `file=${p.disk},if=none,id=disk0,format=qcow2,cache=writeback,discard=unmap`,
    '-device', spec.virtio ? 'virtio-blk-pci,drive=disk0,bootindex=1' : 'ide-hd,drive=disk0,bus=ide.0,bootindex=1',
    // install medium (only while installing) + drivers + OEM payload
    ...(boot
      ? ['-drive', `file=${spec.isoPath},media=cdrom,readonly=on,if=none,id=cd0`,
        '-device', 'ide-cd,drive=cd0,bus=ide.1,bootindex=2']
      : []),
    ...(spec.driverIso !== null
      ? ['-drive', `file=${spec.driverIso},media=cdrom,readonly=on,if=none,id=cd1`,
        '-device', 'ide-cd,drive=cd1,bus=ide.2']
      : []),
    // THE USB CONTROLLER COMES FIRST. QEMU parses argv in order, so a device
    // that names `bus=xhci.0` before `-device qemu-xhci,id=xhci` dies with
    // "Bus 'xhci.0' not found" (verified on QEMU 10). Order is asserted by a
    // gate needle, because it is invisible in a diff.
    '-device', 'qemu-xhci,id=xhci',
    // the OEM payload: a READ-ONLY vvfat directory presented as a USB stick
    // (nothing in the guest writes to it; `rw` only gives Setup a chance to
    // corrupt the staging directory until the host copy breaks)
    '-drive', `file=fat:ro:${p.oemDir},format=raw,if=none,id=oem0`,
    '-device', 'usb-storage,drive=oem0,bus=xhci.0',
    // networking: SLIRP + the SSH forward
    '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${spec.sshPort}-:22`,
    '-device', spec.virtio ? 'virtio-net-pci,netdev=net0' : 'e1000e,netdev=net0',
    // input: absolute pointer (QMP input-send-event) + keyboard
    '-device', 'usb-kbd',
    '-device', 'usb-tablet',
    // display: the panel's live view and the agent's frames
    '-display', spec.gpu && spec.virgl ? 'egl-headless,rendernode=/dev/dri/renderD128' : 'none',
    // QEMU READS THIS AS A DISPLAY NUMBER, NOT A PORT: `-vnc host:31` binds
    // 5900+31. Passing the raw port (5931) binds 11831 — the relay, the banner
    // probe and websockify all point at 5931, so the live view never connects
    // and the non-SSH readiness probe never answers. The conversion lives in one
    // function so it cannot drift again.
    '-vnc', `127.0.0.1:${vncDisplayFor(spec.vncPort)}`,
    // GPU: virgl only when the distro QEMU advertises virtio-gpu-gl-pci AND a
    // render node exists — otherwise a plain virtio-gpu framebuffer. Windows has
    // no accelerated driver either way (Direct3D is WARP); the difference is that
    // virgl routes the guest's GL through the host render node, which is what the
    // Linux guest does.
    '-device', spec.gpu ? (spec.virgl ? 'virtio-gpu-gl-pci' : 'virtio-gpu-pci') : 'VGA,vgamem_mb=32',
    // control + observability
    '-qmp', `tcp:127.0.0.1:${spec.qmpPort},server=on,wait=off`,
    '-monitor', 'none',
    '-serial', `file:${p.serialLog}`,
    '-pidfile', p.qemuPid,
    '-no-user-config'
  ]
  return args
}

/**
 * VNC takes a DISPLAY NUMBER, not a port: QEMU computes `5900 + n`.
 * These helpers are the only place that arithmetic happens.
 */
export function vncDisplayFor(port) {
  return Math.max(0, Number(port) - 5900)
}

export function vncPortFor(display) {
  return 5900 + Number(display)
}

/* ------------------------------------------------------------------ *
 * ISO handling
 * ------------------------------------------------------------------ */

/** Where an ISO URL will land. Exported so the caller can tell "cached" from
 *  "about to download 5.5 GB" BEFORE calling ensureIso (and reserve for it). */
export function isoTargetPath(isoDir, url) {
  return path.join(isoDir, isoFileName(url))
}

/** A short, stable file name for a URL (the hash keeps two dates apart). */
function isoFileName(url) {
  const base = decodeURIComponent(String(url).split('/').pop() || 'windows.iso').replace(/[^\w.-]+/gu, '-')
  const digest = randomBytes(4).toString('hex')
  return base.toLowerCase().endsWith('.iso') ? base : `${base}-${digest}.iso`
}

/**
 * Make sure an ISO is on disk, downloading it once.
 *
 * WHY A TIMEOUT AND A PROGRESS HOOK: a 5.5 GB download over a slow link is
 * minutes, and a create that reports nothing for minutes looks hung. The
 * supervisor turns `onProgress` into a log line and keeps the row's
 * `installDetail` moving; `timeoutMs` bounds the whole transfer.
 */
export async function ensureIso({ url, isoDir, timeoutMs = 60 * 60 * 1000, onProgress = () => {}, log = () => {} }) {
  if (!/^https?:\/\//iu.test(String(url || ''))) return { path: url, downloaded: false }
  mkdirSync(isoDir, { recursive: true })
  const target = path.join(isoDir, isoFileName(url))
  if (existsSync(target) && statSync(target).size > 1024 * 1024) return { path: target, downloaded: false }
  const partial = `${target}.part`
  // A killed download leaves a `.part` behind; the next attempt must not append
  // to it (which is how a truncated ISO ends up "complete").
  try { unlinkSync(partial) } catch {}

  const started = Date.now()
  let received = 0
  let expected = 0
  let lastReport = 0

  const fetchTo = (from) => new Promise((resolve, reject) => {
    const client = String(from).startsWith('https:') ? https : http
    let settled = false
    let stream = null
    const fail = (error) => {
      if (settled) return
      settled = true
      try { stream?.destroy() } catch {}
      try { request.destroy() } catch {}
      try { unlinkSync(partial) } catch {}
      reject(error)
    }
    const request = client.get(from, { timeout: 60000 }, (response) => {
      // Redirects are normal for Microsoft's CDN.
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        settled = true
        resolve({ redirect: new URL(response.headers.location, from).toString() })
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        fail(new Error(`ISO download failed: HTTP ${response.statusCode} for ${from}`))
        return
      }
      expected = Number(response.headers['content-length'] || 0)
      stream = createWriteStream(partial)
      response.on('data', (chunk) => {
        received += chunk.length
        if (Date.now() - started > timeoutMs) {
          fail(new Error(`ISO download timed out after ${Math.round(timeoutMs / 1000)} s (${(received / 1024 ** 3).toFixed(2)} GB received)`))
          return
        }
        if (Date.now() - lastReport > 5000) {
          lastReport = Date.now()
          onProgress(expected > 0 ? received / expected : null, received)
        }
      })
      response.on('aborted', () => fail(new Error('the ISO connection was aborted')))
      response.on('error', fail)
      stream.on('error', fail)
      response.pipe(stream)
      stream.on('finish', () => {
        if (settled) return
        // SHORT READ = A BROKEN ISO. Content-Length is authoritative; without
        // this check a connection that drops at 80% leaves a 4 GB file that
        // `existsSync && size > 1 MB` would happily reuse forever.
        if (expected > 0 && received !== expected) {
          fail(new Error(`ISO download was truncated: ${received} of ${expected} bytes`))
          return
        }
        stream.close(() => {
          if (settled) return
          settled = true
          try {
            // SAME DIRECTORY → a real atomic rename. `copyFileSync` here meant
            // another 5.5 GB write and a window where a kill left a half-copied
            // file wearing the final name.
            renameSync(partial, target)
            log(`iso: ${path.basename(target)} (${(statSync(target).size / 1024 ** 3).toFixed(2)} GB)`)
            resolve({ path: target })
          } catch (error) {
            fail(error)
          }
        })
      })
    })
    request.on('timeout', () => fail(new Error('ISO download socket timed out')))
    request.on('error', fail)
  })

  let current = url
  for (let hop = 0; hop < 5; hop += 1) {
    const result = await fetchTo(current)
    if (result.redirect !== undefined) {
      current = result.redirect
      received = 0
      expected = 0
      continue
    }
    return { path: result.path, downloaded: true, bytes: statSync(result.path).size }
  }
  throw new Error(`ISO download followed too many redirects (>5) starting at ${url}`)
}

/* ------------------------------------------------------------------ *
 * The OEM payload
 * ------------------------------------------------------------------ */

/**
 * The three files the unattended install cannot run without. Exported because
 * both the error text and the image gate talk about the same list: a fourth
 * file added here without its COPY is exactly the drift this constant prevents.
 */
export const OEM_PAYLOAD_FILES = Object.freeze(['Autounattend.xml', 'setupcomplete.cmd', 'cua-firstboot.ps1'])

/** Where this module itself lives — the last-resort source of the payload. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * A directory that holds ALL of `OEM_PAYLOAD_FILES`, or null.
 *
 * A directory is enough — the flat image check tree (`/opt/seek-harness/
 * cua-check/`) keeps the same three files at its root, so the same predicate
 * answers "is this a payload directory?" for both layouts.
 *
 * EACCES IS NOT "MISSING". `existsSync` answers false for BOTH, which is how a
 * permission bug shipped reading like a missing-payload bug: the files were in
 * the image, but the directory arrived `drw-r--r--` from `COPY --chmod=0644`
 * (that flag applies to the directories it creates too), so a uid-1000 process
 * could not traverse it and the user was told to pull a newer image. Anything
 * other than ENOENT/ENOTDIR is reported as a PERMISSION problem by name.
 */
export function oemPayloadDirStatus(dir) {
  if (typeof dir !== 'string' || dir.length === 0) {
    return { dir: String(dir ?? ''), ok: false, missing: [], denied: null }
  }
  const missing = []
  for (const file of OEM_PAYLOAD_FILES) {
    const target = path.join(dir, file)
    try {
      statSync(target)
    } catch (error) {
      const code = error?.code
      if (code === 'EACCES' || code === 'EPERM') {
        return { dir, ok: false, missing, denied: { path: target, code, cause: error } }
      }
      missing.push(file)
    }
  }
  return { dir, ok: missing.length === 0, missing, denied: null }
}

export function oemPayloadDir(dir) {
  return oemPayloadDirStatus(dir).ok ? dir : null
}

/**
 * The first directory among `candidates` that carries the whole payload.
 * Order matters: the configured source wins, the fallbacks are self-healing.
 */
export function resolveOemSourceDir(candidates) {
  for (const candidate of candidates) {
    const found = oemPayloadDir(candidate)
    if (found !== null) return found
  }
  return null
}

/**
 * The first candidate whose TRAVERSAL was denied (EACCES), or null.
 *
 * Used only to choose the error text: a denied directory is an image PERMISSION
 * defect, and telling that user to rebuild with newer media is wrong advice.
 */
export function oemPayloadDeniedDir(candidates) {
  for (const candidate of candidates) {
    const status = oemPayloadDirStatus(candidate)
    if (status.denied !== null) return candidate
  }
  return null
}

/**
 * WHAT THE USER SEES WHEN THE IMAGE HAS NO WINDOWS BACKEND.
 *
 * The old one-liner ("the OEM payload is missing from this image: <path>") named
 * a path and nothing else: no reason, no rebuild steps, no way to tell a stale
 * image from a broken mount. It is a failure of the IMAGE, not of the computer
 * spec, so the message says so in that order and ends with a command to run.
 */
/**
 * THE OTHER IMAGE FAILURE: THE FILES ARE THERE, THE PROCESS MAY NOT READ THEM.
 *
 * `COPY --chmod=0644 docker/windows-oem/ <dest>/` applies 0644 to EVERY copied
 * entry, the destination DIRECTORY included, so a hardened container that runs
 * as uid 1000 could not traverse it while the files were verifiably in the
 * pushed layer. The symptom is identical to the missing-payload one (`ls:
 * Permission denied`, `existsSync === false`), and the old advice — pull a newer
 * image — is exactly wrong. Say which mode/owner is wrong and what the fix is.
 */
export function oemPayloadDeniedError({ sourceDir, denied, deniedDir, fallbackDirs }) {
  const looked = [sourceDir, ...fallbackDirs].filter(Boolean)
  const describe = (target) => {
    try {
      const s = statSync(target)
      return `${(s.mode & 0o777).toString(8).padStart(4, '0')} ${s.uid}:${s.gid}`
    } catch {
      return null
    }
  }
  // The mode that decides whether the payload is reachable is the DIRECTORY's:
  // a 0644 directory denies traversal before any file's own mode is consulted,
  // so `stat`-ing the file itself is the one thing guaranteed to fail here.
  const dir = deniedDir ?? path.dirname(denied)
  const dirMode = describe(dir)
  const fileMode = describe(denied)
  // Neither the file nor the directory may be stat'ed at all when a PARENT is
  // the non-traversable one (the same COPY creates /usr/local/share/cua-vm), so
  // the message walks up to the first ancestor that can still be described.
  const firstReachable = (() => {
    let current = dir
    for (let hop = 0; hop < 4; hop += 1) {
      const mode = describe(current)
      if (mode !== null) return { path: current, mode }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return null
  })()
  const where = fileMode !== null
    ? `EACCES on ${denied} (mode/owner: ${fileMode})`
    : dirMode !== null
      ? `EACCES traversing ${dir} (dir mode/owner: ${dirMode})`
      : `EACCES reaching ${denied} — neither the file nor its directory could be opened, so an ANCESTOR is not traversable (last readable: ${firstReachable === null ? 'none' : `${firstReachable.path} ${firstReachable.mode}`})`
  return Object.assign(new Error([
    `the Windows OEM payload is present but NOT READABLE by uid ${typeof process.getuid === 'function' ? process.getuid() : '?'} — ${where}`,
    `(searched ${looked.join(' or ')})`,
    '',
    'This is an IMAGE PERMISSIONS defect, not a missing payload and not a computer setting.',
    'A directory needs its execute bit to be traversed, and `COPY --chmod=0644` sets 0644 on',
    'the directories it CREATES as well as on the files, which leaves',
    '`/usr/local/share/cua-vm/windows-oem` as `drw-r--r--` — the three files are in the image',
    'and no non-root process can open them.',
    '',
    'FIXED IN THE IMAGE by creating the parent 0755, copying as the runtime uid, and',
    'normalising the copied directory modes afterwards:',
    '  RUN install -d -m 0755 /usr/local/share/cua-vm',
    '  COPY --chown=1000:1000 --chmod=0644 docker/windows-oem/ /usr/local/share/cua-vm/windows-oem/',
    '  RUN chmod -R a+rX /usr/local/share/cua-vm/windows-oem',
    'Pull or rebuild an image that carries it, then recreate the container:',
    '  docker compose -f compose.windows.yaml up -d --force-recreate',
    '',
    'To work around it without rebuilding (the rootfs is read_only, so `chmod` inside the',
    'container answers "Read-only file system"), shadow the directory with a read-only mount',
    'from a checkout — the mount\'s own modes replace the image\'s:',
    '  # compose override',
    '  volumes: [./docker/windows-oem:/usr/local/share/cua-vm/windows-oem:ro]',
    '  docker compose -f compose.yaml -f compose.windows.yaml up -d',
    'then verify as the runtime user:',
    '  docker compose exec seek-harness ls -l /usr/local/share/cua-vm/windows-oem/',
  ].join('\n')), { code: 'EACCES', deniedPath: denied, deniedDir: dir })
}

export function oemPayloadMissingError({ sourceDir, fallbackDirs }) {
  const looked = [sourceDir, ...fallbackDirs].filter(Boolean)
  return new Error([
    `the Windows OEM payload is missing from this image: no ${OEM_PAYLOAD_FILES.join(', ')} under ${looked.join(' or ')}`,
    '',
    'A Windows computer is a DIRECT-QEMU guest: its unattended install reads those files from',
    `the image (default /usr/local/share/cua-vm/windows-oem/). An image without the Windows backend —`,
    'a main-branch build, or any build older than the one that added the Windows backend — cannot',
    'create one, and no computer setting can fix that. Pull or build a newer image:',
    '',
    '  1. build it from branch cua-vm-improve WITH the virgl QEMU (the Windows guest needs it):',
    '     git fetch origin && git checkout cua-vm-improve',
    '     docker build --build-arg WITH_VIRGL_QEMU=1 -t ghcr.io/OWNER/REPO:local .',
    '     (or run Actions → docker-build on cua-vm-improve with channel=github-tag, virgl=true,',
    '      which publishes ghcr.io/OWNER/REPO:latest; then docker pull ghcr.io/OWNER/REPO:latest)',
    '  2. recreate the container against the NEW image, with the SAME compose env you use now',
    '     (notably DSH_CUA_VM_GPU=virgl if your computer is a GPU one), keeping the /cua-vm',
    '     volume mounted at /cua-vm so the existing store and its computers survive:',
    '     docker compose -f compose.windows.yaml up -d --force-recreate',
    '  3. confirm the payload actually landed, from inside the running container',
    '     (`seek-harness` is the service name in compose.yaml / compose.windows.yaml):',
    `     docker compose exec seek-harness ls -l /usr/local/share/cua-vm/windows-oem/${OEM_PAYLOAD_FILES.join(' ')}`,
    '',
    'If step 3 lists all three files and this error persists, DSH_CUA_WINDOWS_OEM_DIR points',
    `somewhere else — unset it (it currently overrides the image default with ${sourceDir}).`
  ].join('\n'))
}

/**
 * Write the unattended-answer payload into `$STORE/windows/<name>/oem/`.
 *
 * The files live in the repository (`docker/windows-oem/`) so they can be read,
 * diffed and fixed without touching JavaScript, exactly like the guest shell
 * scripts. The supervisor copies them with the per-computer substitutions:
 *
 *   {{COMPUTERNAME}}  a DNS-safe name derived from the computer name
 *   {{PASSWORD}}      the generated administrator password
 *   {{SSH_PUBKEY}}    the supervisor's public key (authorized_keys)
 *   {{PYTHON_URL}}    the pinned python.org installer
 *   {{DSH_CUA_PIP}}   the dsh-cua package spec
 *
 * SELF-HEALING: `sourceDir` is the image path the supervisor resolves; the
 * `fallbackDirs` are the other places the SAME three files are known to exist
 * (the image's flat check tree, the module's own directory, a checkout). A file
 * or two missing from `sourceDir` therefore costs a log line, not a failed
 * computer create — as long as ONE candidate directory is complete.
 */
export function writeOemPayload({ paths: p, name, password, sshPubKey, sourceDir, fallbackDirs = [], pythonUrl, dshCuaSpec, log = () => {} }) {
  mkdirSync(p.oemDir, { recursive: true })
  const substitutions = {
    '{{COMPUTERNAME}}': `cua-${name}`.slice(0, 15).toUpperCase(),
    '{{PASSWORD}}': password,
    '{{SSH_PUBKEY}}': sshPubKey.trim(),
    '{{PYTHON_URL}}': pythonUrl,
    '{{DSH_CUA_PIP}}': dshCuaSpec
  }
  const files = OEM_PAYLOAD_FILES
  const candidates = [sourceDir, ...fallbackDirs, path.join(MODULE_DIR, 'windows-oem'), path.resolve(MODULE_DIR, '..', 'docker', 'windows-oem')]
  const resolved = resolveOemSourceDir(candidates)
  if (resolved === null) {
    // EACCES before ENOENT: a denied directory is an image permission defect and
    // must not be reported as "the payload is missing" (they were the same
    // symptom for `existsSync`, and the wrong advice sent users to re-pull).
    const deniedDir = oemPayloadDeniedDir(candidates)
    if (deniedDir !== null) {
      const deniedPath = oemPayloadDirStatus(deniedDir).denied?.path ?? deniedDir
      throw oemPayloadDeniedError({ sourceDir, denied: deniedPath, deniedDir, fallbackDirs })
    }
    throw oemPayloadMissingError({ sourceDir, fallbackDirs })
  }
  if (path.resolve(resolved) !== path.resolve(sourceDir)) {
    log(`windows: OEM payload not found at ${sourceDir}; using the copy at ${resolved}`)
  }
  for (const file of files) {
    const source = path.join(resolved, file)
    let text = readFileSync(source, 'utf8')
    for (const [needle, value] of Object.entries(substitutions)) text = text.split(needle).join(value)
    writeFileSync(path.join(p.oemDir, file), text)
  }
  // The media is a vvfat directory: Setup reads Autounattend.xml from its root,
  // and the scripts arrive under $OEM$ so Setup copies them into the image.
  const setupDir = path.join(p.oemDir, '$OEM$', '$$', 'Setup', 'Scripts')
  mkdirSync(setupDir, { recursive: true })
  for (const file of ['setupcomplete.cmd', 'cua-firstboot.ps1']) {
    copyFileSync(path.join(p.oemDir, file), path.join(setupDir, file))
  }
  log(`windows: ${name} OEM payload written (${files.length} files + $OEM$ scripts)`)
  return p.oemDir
}

/* ------------------------------------------------------------------ *
 * The backend
 * ------------------------------------------------------------------ */

/**
 * The lifecycle object.
 *
 * @param {object} options
 * @param {string} options.store            the VM store
 * @param {(host: string, port: number, commands: object[], opts?: object) => Promise<object[]>} options.qmp
 * @param {(...parts: any[]) => void} options.log
 */
export function createWindowsBackend({ store, qmp, log = () => {} }) {
  /** Monotonic counter so two frames never share a serial name. */
  let FRAME_SEQUENCE = 0
  /** One QEMU child per computer, so stop/kill act on the right process. */
  const children = new Map()

  function pathsFor(name) {
    return windowsPaths(store, name)
  }

  /** Which of our two QEMU processes is alive (pidfile is written by QEMU). */
  function qemuPid(name) {
    try {
      const pid = Number(readFileSync(pathsFor(name).qemuPid, 'utf8').trim())
      return Number.isFinite(pid) && pid > 0 ? pid : 0
    } catch {
      return 0
    }
  }

  function pidAlive(pid) {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }

  /** The ports one computer uses: QMP, VNC and the SSH forward. */
  function portsFor(spec) {
    return { qmpPort: spec.qmpPort, vncPort: spec.vncPort, sshPort: spec.sshPort }
  }

  /**
   * START SWTMP FIRST, THEN QEMU.
   *
   * swtpm owns the TPM state directory and the socket; QEMU connects to it as a
   * chardev, so a QEMU that starts before the socket exists fails with "Failed
   * to connect to socket". It is a plain child process, killed by `stopSwtpm`.
   */
  function startSwtpm(name) {
    const p = pathsFor(name)
    mkdirSync(p.tpmDir, { recursive: true })
    try { unlinkSync(p.tpmSocket) } catch {}
    const child = spawn(SWTPM, [
      'socket', '--tpm2',
      '--ctrl', `type=unixio,path=${p.tpmSocket}`,
      '--tpmstate', `dir=${p.tpmDir},mode=0600`,
      '--pid', `file=${p.tpmPid}`,
      '--log', `file=${path.join(p.dir, 'swtpm.log')},level=1`,
      '--flags', 'not-need-init,startup-clear'
    ], { stdio: 'ignore', detached: true })
    child.unref()
    children.set(`tpm:${name}`, child)
    // Wait for the socket: QEMU connects immediately.
    for (let index = 0; index < 100; index += 1) {
      if (existsSync(p.tpmSocket)) return true
      execFileSync('sleep', ['0.1'])
    }
    return existsSync(p.tpmSocket)
  }

  function stopSwtpm(name) {
    const child = children.get(`tpm:${name}`)
    children.delete(`tpm:${name}`)
    try { child?.kill('SIGTERM') } catch {}
    try {
      const pid = Number(readFileSync(pathsFor(name).tpmPid, 'utf8').trim())
      if (pidAlive(pid)) process.kill(pid, 'SIGTERM')
    } catch {}
  }

  /**
   * Boot the computer, or bring it back.
   *
   * `installPending` is decided by the caller from the disk's existence: a fresh
   * create boots the install ISO; every later start boots the disk.
   */
  async function boot(spec, { installPending = false } = {}) {
    const p = pathsFor(spec.name)
    mkdirSync(p.dir, { recursive: true })
    const caps = windowsHostCaps()
    if (!caps.qemu) throw new Error(`the Windows backend needs ${WINDOWS_QEMU} (install qemu-system-x86 in the image)`)
    // THE DEVICE SPLIT. A missing node and a mounted-but-denied node are two
    // different defects with two different fixes, and the old single sentence
    // ("needs /dev/kvm (compose.emulator.yaml)") was wrong for both of the new
    // cases: wrong for a char device (isFile() is false) and wrong advice for a
    // GID problem. `kvmPreflightError` quotes the observed mode/owner/groups.
    const kvmError = windowsKvmPreflight()
    if (kvmError !== null) throw kvmError
    if (!caps.ovmfCode || !caps.ovmfVars) {
      throw new Error(`the Windows backend needs OVMF (${OVMF_CODE} + ${OVMF_VARS_TEMPLATE}); install the ovmf package in the image`)
    }
    if (!caps.swtpm) throw new Error(`the Windows backend needs swtpm (${SWTPM}); install the swtpm package in the image`)
    if (!existsSync(p.efiVars)) {
      // OVMF fails with "Could not open backing file" when vars qcow2 is missing.
      mkdirSync(path.dirname(p.efiVars), { recursive: true })
      execFileSync('/usr/bin/qemu-img', ['create', '-f', 'qcow2', '-b', OVMF_VARS_TEMPLATE, '-F', 'raw', p.efiVars, '4M'], { timeout: 30000 })
      log(`windows: ${spec.name} EFI vars created from ${OVMF_VARS_TEMPLATE}`)
    }
    if (!startSwtpm(spec.name)) throw new Error('swtpm did not create its socket (see swtpm.log)')
    // FROM HERE swtpm IS RUNNING, so every failure has to stop it again: a
    // leaked swtpm keeps the TPM state directory open and the next boot fails
    // with "TPM is already in use" — the kind of failure that only appears on
    // the SECOND attempt, long after the first error was read.
    try {
      const argv = buildQemuArgs({
        ...spec,
        paths: p,
        installPending,
        virtio: Boolean(caps.virtioWin),
        driverIso: caps.virtioWin ? VIRTIO_WIN_ISO : null
      })
      const child = spawn(WINDOWS_QEMU, argv, { stdio: 'ignore', detached: true })
      children.set(`qemu:${spec.name}`, child)
      // A SPAWN ERROR IS AN EVENT, NOT A THROW: without this listener, a missing
      // qemu binary (or E2BIG on a bad argv) raises an unhandled 'error' and takes
      // the whole supervisor down — every computer with it.
      child.on('error', (error) => {
        log(`windows: ${spec.name} qemu failed to start: ${error?.message ?? error}`)
        stopSwtpm(spec.name)
      })
      child.unref()
      log(`windows: ${spec.name} qemu started (pid ${child.pid}${installPending ? ', installing' : ''})`)
      return { pid: child.pid, installPending }
    } catch (error) {
      stopSwtpm(spec.name)
      throw error
    }
  }

  /** QMP to this computer's loopback socket, with the supervisor's client. */
  async function qmpFor(spec, commands, { timeoutMs = 15000 } = {}) {
    return qmp('127.0.0.1', spec.qmpPort, commands, { timeoutMs })
  }

  /** `query-status` plus the process table: the only trustworthy "is it up". */
  async function probe(spec) {
    const alive = pidAlive(qemuPid(spec.name))
    let status = ''
    let error = ''
    if (alive) {
      try {
        const answer = await qmpFor(spec, [{ execute: 'query-status' }], { timeoutMs: 5000 })
        status = String(answer?.[0]?.return?.status ?? '')
      } catch (caught) {
        error = caught?.message ?? String(caught)
      }
    }
    return { alive, status, error }
  }

  /**
   * READY = QMP `running` AND a guest endpoint that answers.
   *
   * The endpoint is SSH by default (the OEM script installs it, and exec/put/get
   * depend on it), with VNC-accept as the fallback for a computer created with
   * `ssh: false` or one whose first boot is still finishing. `paused` is NOT
   * ready — a paused guest keeps its VNC port open and used to read as running.
   */
  async function ready(spec, { ssh = true, phase = 'running' } = {}) {
    const state = await probe(spec)
    if (!state.alive || state.status !== 'running') return { ready: false, phase, ...state }
    if (phase === 'install') {
      // DURING SETUP only SSH counts. QEMU's VNC socket answers from the first
      // second of setup.exe, so a VNC probe called a half-installed Windows
      // "ready", set installComplete, and the next Start booted the half-written
      // disk. SSH exists only after the answer file has run.
      const banner = await bannerProbe('127.0.0.1', spec.sshPort, { timeoutMs: 3000 })
      if (banner !== null) return { ready: true, endpoint: 'ssh', banner: banner.slice(0, 24), phase, ...state }
      return { ready: false, endpoint: 'none', phase, ...state }
    }
    if (ssh) {
      const banner = await bannerProbe('127.0.0.1', spec.sshPort)
      if (banner !== null) return { ready: true, endpoint: 'ssh', banner: banner.slice(0, 24), phase, ...state }
    }
    const vnc = await bannerProbe('127.0.0.1', spec.vncPort)
    if (vnc !== null) return { ready: true, endpoint: 'vnc', phase, ...state }
    return { ready: false, endpoint: 'none', phase, ...state }
  }

  /** A PNG frame of the guest's framebuffer (QMP screendump). */
  async function screenshot(spec, { saveTo = null } = {}) {
    const p = pathsFor(spec.name)
    const unique = `${(FRAME_SEQUENCE += 1)}-${randomBytes(4).toString('hex')}`
    const file = path.join(p.dir, `shot-${unique}.png`)
    await qmpFor(spec, [{ execute: 'screendump', arguments: { filename: file } }])
    let png = null
    for (let attempt = 0; attempt < 40 && png === null; attempt += 1) {
      if (existsSync(file)) {
        png = readFileSync(file)
        try { unlinkSync(file) } catch {}
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    if (png === null) throw new Error('the guest produced no frame (screendump wrote nothing)')
    if (typeof saveTo === 'string' && saveTo !== '') writeFileSync(saveTo, png)
    return { png }
  }

  /** Absolute pointer, in frame pixels (the frame IS the display). */
  async function click(spec, x, y, { width, height, button = 'left' } = {}) {
    const toAbsolute = (value, extent) => Math.max(0, Math.min(0x7fff, Math.round((Number(value) / Math.max(1, Number(extent))) * 0x7fff)))
    const events = [
      { type: 'abs', data: { axis: 'x', value: toAbsolute(x, width) } },
      { type: 'abs', data: { axis: 'y', value: toAbsolute(y, height) } },
      { type: 'btn', data: { down: true, button } },
      { type: 'btn', data: { down: false, button } }
    ]
    await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events } }])
    return { x: Number(x), y: Number(y) }
  }

  async function move(spec, x, y, { width, height } = {}) {
    const toAbsolute = (value, extent) => Math.max(0, Math.min(0x7fff, Math.round((Number(value) / Math.max(1, Number(extent))) * 0x7fff)))
    await qmpFor(spec, [{
      execute: 'input-send-event',
      arguments: {
        events: [
          { type: 'abs', data: { axis: 'x', value: toAbsolute(x, width) } },
          { type: 'abs', data: { axis: 'y', value: toAbsolute(y, height) } }
        ]
      }
    }])
    return { x: Number(x), y: Number(y) }
  }

  async function drag(spec, fromX, fromY, toX, toY, { width, height } = {}) {
    const toAbsolute = (value, extent) => Math.max(0, Math.min(0x7fff, Math.round((Number(value) / Math.max(1, Number(extent))) * 0x7fff)))
    const at = (x, y) => [
      { type: 'abs', data: { axis: 'x', value: toAbsolute(x, width) } },
      { type: 'abs', data: { axis: 'y', value: toAbsolute(y, height) } }
    ]
    await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events: [...at(fromX, fromY), { type: 'btn', data: { down: true, button: 'left' } }] } }])
    await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events: at(toX, toY) } }])
    await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events: [...at(toX, toY), { type: 'btn', data: { down: false, button: 'left' } }] } }])
    return { from: { x: Number(fromX), y: Number(fromY) }, to: { x: Number(toX), y: Number(toY) } }
  }

  /** Keys and ASCII text, as physical qcodes with the right modifiers. */
  async function sendKeys(spec, { text = null, key = null } = {}) {
    const events = []
    const press = (qcode, { shift = false, ctrl = false, alt = false } = {}) => {
      const modifiers = []
      if (ctrl) modifiers.push('ctrl')
      if (alt) modifiers.push('alt')
      if (shift) modifiers.push('shift')
      for (const modifier of modifiers) events.push({ type: 'key', data: { down: true, key: { type: 'qcode', data: modifier } } })
      events.push({ type: 'key', data: { down: true, key: { type: 'qcode', data: qcode } } })
      events.push({ type: 'key', data: { down: false, key: { type: 'qcode', data: qcode } } })
      for (const modifier of modifiers.reverse()) events.push({ type: 'key', data: { down: false, key: { type: 'qcode', data: modifier } } })
    }
    if (key !== null) {
      const parsed = parseKeySpec(key)
      press(parsed.qcode, { shift: parsed.shift || parsed.shiftModifier, ctrl: parsed.ctrl, alt: parsed.alt })
    }
    if (text !== null) {
      for (const char of String(text)) {
        const mapped = charToKey(char)
        if (mapped === null) {
          throw new Error(`"${char}" cannot be typed on a Windows computer: the QMP keyboard sends physical keys, so only printable ASCII is supported (no clipboard)`)
        }
        press(mapped.qcode, { shift: mapped.shift })
      }
    }
    if (events.length === 0) return { sent: 0 }
    await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events } }])
    return { sent: events.length }
  }

  /** Suspend is QMP `stop` (pause the VM, keep RAM); resume is `cont`. */
  async function pause(spec) {
    await qmpFor(spec, [{ execute: 'stop' }])
    return { paused: true }
  }

  async function unpause(spec) {
    await qmpFor(spec, [{ execute: 'cont' }])
    return { unpaused: true }
  }

  /**
   * Graceful power-off: `system_powerdown`, then wait, then `quit`.
   *
   * The supervisor owns the checkpoint and the registry; this only makes the
   * process stop. Returns which method worked so shutdown can mark `mayBeTorn`.
   */
  async function shutdown(spec, { timeoutMs = 120000 } = {}) {
    const state = await probe(spec)
    if (!state.alive) {
      stopSwtpm(spec.name)
      return { method: 'already-off', exited: true }
    }
    let method = 'acpi'
    try {
      const answer = await qmpFor(spec, [{ execute: 'system_powerdown' }], { timeoutMs: 15000 })
      if (answer?.[0]?.error) {
        method = 'quit'
      }
    } catch {
      method = 'quit'
    }
    const deadline = Date.now() + Math.max(1000, timeoutMs)
    while (Date.now() < deadline) {
      if (!pidAlive(qemuPid(spec.name))) {
        stopSwtpm(spec.name)
        return { method, exited: true }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    method = 'quit'
    try {
      await qmpFor(spec, [{ execute: 'quit' }], { timeoutMs: 10000 })
    } catch {}
    for (let index = 0; index < 30; index += 1) {
      if (!pidAlive(qemuPid(spec.name))) {
        stopSwtpm(spec.name)
        return { method, exited: true, forced: true }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return { method: 'quit', exited: false, forced: true }
  }

  /** Kill the process (last resort, after `shutdown` refused to exit). */
  function kill(name) {
    const child = children.get(`qemu:${name}`)
    children.delete(`qemu:${name}`)
    try { child?.kill('SIGKILL') } catch {}
    const pid = qemuPid(name)
    if (pidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    stopSwtpm(name)
  }

  return {
    enabled: windowsEnabled,
    hostCaps: windowsHostCaps,
    paths: pathsFor,
    portsFor,
    qemuPid,
    pidAlive,
    boot,
    probe,
    ready,
    qmpFor,
    screenshot,
    click,
    move,
    drag,
    sendKeys,
    pause,
    unpause,
    shutdown,
    kill,
    stopSwtpm
  }
}

/* ------------------------------------------------------------------ *
 * TCP banner probe (readiness, zero dependencies)
 * ------------------------------------------------------------------ */

/** The first bytes a service says, or null when nothing answers. */
export async function bannerProbe(host, port, { timeoutMs = 1500, readBytes = 32 } = {}) {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const socket = net.connect(port, host)
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try { socket.destroy() } catch {}
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => {
      // SSH speaks first; VNC's server also speaks first. Read the banner.
      socket.once('data', (chunk) => finish(chunk.subarray(0, readBytes).toString('latin1')))
    })
    socket.on('timeout', () => finish(null))
    socket.on('error', () => finish(null))
  })
}

/* ------------------------------------------------------------------ *
 * Keyboard mapping (ASCII only — a physical keyboard has no key for "é")
 * ------------------------------------------------------------------ */

const QCODE_PUNCT = {
  ' ': 'spc', '-': 'minus', '=': 'equal', '[': 'bracket_left', ']': 'bracket_right',
  '\\': 'backslash', ';': 'semicolon', "'": 'apostrophe', '`': 'grave_accent',
  ',': 'comma', '.': 'dot', '/': 'slash', '\n': 'ret', '\t': 'tab'
}

const QCODE_SHIFT = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8',
  '(': '9', ')': '0', '_': 'minus', '+': 'equal', '{': 'bracket_left', '}': 'bracket_right',
  '|': 'backslash', ':': 'semicolon', '"': 'apostrophe', '~': 'grave_accent',
  '<': 'comma', '>': 'dot', '?': 'slash'
}

const NAMED_KEYS = {
  enter: 'ret', return: 'ret', tab: 'tab', escape: 'esc', esc: 'esc', space: 'spc',
  backspace: 'backspace', delete: 'delete', del: 'delete', insert: 'insert',
  up: 'up', down: 'down', left: 'left', right: 'right',
  home: 'home', end: 'end', pageup: 'pgup', pagedown: 'pgdn',
  f1: 'f1', f2: 'f2', f3: 'f3', f4: 'f4', f5: 'f5', f6: 'f6',
  f7: 'f7', f8: 'f8', f9: 'f9', f10: 'f10', f11: 'f11', f12: 'f12'
}

export function charToKey(char) {
  if (Object.prototype.hasOwnProperty.call(QCODE_SHIFT, char)) return { qcode: QCODE_SHIFT[char], shift: true }
  if (Object.prototype.hasOwnProperty.call(QCODE_PUNCT, char)) return { qcode: QCODE_PUNCT[char], shift: false }
  if (/^[a-z0-9]$/u.test(char)) return { qcode: char, shift: false }
  if (/^[A-Z]$/u.test(char)) return { qcode: char.toLowerCase(), shift: true }
  return null
}

export function parseKeySpec(spec) {
  const text = String(spec ?? '').trim()
  if (text === '') throw new Error('key is required')
  const parts = text.split('+').filter((part) => part !== '')
  const base = parts.pop() ?? ''
  const modifiers = parts.map((part) => part.toLowerCase())
  const named = NAMED_KEYS[base.toLowerCase()]
  const character = named ? null : (base.length === 1 ? charToKey(base) : null)
  if (named === undefined && character === null) {
    throw new Error(`unsupported key for a Windows computer: ${spec} (ASCII keys and ${Object.keys(NAMED_KEYS).join('/')} only)`)
  }
  return {
    qcode: named ?? character.qcode,
    shift: character?.shift === true,
    ctrl: modifiers.includes('ctrl') || modifiers.includes('control'),
    alt: modifiers.includes('alt'),
    shiftModifier: modifiers.includes('shift')
  }
}

/** A generated Windows password: url/shell-safe, 20 chars, ~118 bits. */
export function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_'
  return Array.from(randomBytes(20), (byte) => alphabet[byte % alphabet.length]).join('')
}

/** The frame's own size: a QMP screendump IS the display, so scale is always 1. */
export function frameSpace(png) {
  const size = pngSize(png) ?? { width: 0, height: 0 }
  return {
    display: { width: size.width, height: size.height },
    screenshot: { width: size.width, height: size.height },
    scale: 1,
    source: 'qmp'
  }
}
