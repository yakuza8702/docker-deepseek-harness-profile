#!/usr/bin/env node
/**
 * check-cua-vm.mjs — the personal VM is a chain of loose contracts, and this is
 * the gate that keeps them joined.
 *
 * WHY A TEXT GATE, AND WHY THIS ONE IS BIGGER THAN check-cua-rea
 * ------------------------------------------------------------
 * Nothing in this feature type-checks end to end:
 *
 *   * the supervisor is a shell-out around cua/QEMU, and its guarantees are
 *     STRINGS (a config key, an op name, a checkpoint filename, a state);
 *   * the guest provisioner is bash, addressed by filename from the supervisor;
 *   * the plugin is a tool schema whose names must match the supervisor's ops;
 *   * the client is a string-keyed UI that must name the same ops again;
 *   * the proxy rewrites a container console because ports.json says "relay".
 *
 * A rename in any one of those leaves a build that boots, a panel that looks
 * right, and a feature that silently does nothing — which is exactly how the
 * "Shutdown button suspends", "click lands 6% off", "delete leaves 6 GB behind"
 * and "Windows option that creates nothing" bugs survived their own commits.
 *
 * WHAT IT IS NOT: not a test of QEMU, of the guest, or of Docker. It asserts that
 * every hop EXISTS and that the two invariants that are easy to delete by
 * refactoring (one coordinate space, one delete manifest) are still spelled out.
 * The behavioural proof lives in `docker/cua-vm-supervisor.mjs` running against
 * a real store.
 *
 * USAGE
 * -----
 *   node tools/check-cua-vm.mjs                 # repository layout
 *   node tools/check-cua-vm.mjs --root DIR      # flat image layout
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    root: { type: 'string', default: path.resolve(import.meta.dirname, '..') },
    quiet: { type: 'boolean', default: false }
  }
})
const ROOT = path.resolve(values.root)

/** A file in either layout: flat (the image's check dir) or the repository's. */
function pick(name) {
  const candidates = [
    path.join(ROOT, name),
    path.join(ROOT, 'docker', name),
    path.join(ROOT, 'plugins', name),
    path.join(ROOT, 'plugins', 'dsh-cua-vm', name),
    path.join(ROOT, 'docker', 'windows-oem', name)
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Whitespace drifts when a line is rewrapped; everything else is literal. */
function needlePattern(needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return escaped.split(/ +/u).join('\\s+')
}

const FILES = {
  supervisor: { label: 'docker/cua-vm-supervisor.mjs', name: 'cua-vm-supervisor.mjs' },
  space: { label: 'docker/cua-vm-space.mjs', name: 'cua-vm-space.mjs' },
  windows: { label: 'docker/cua-vm-windows-qemu.mjs', name: 'cua-vm-windows-qemu.mjs' },
  winMcp: { label: 'plugins/dsh-cua-vm/win-mcp.js', name: 'win-mcp.js' },
  oemAnswer: { label: 'docker/windows-oem/Autounattend.xml', name: 'Autounattend.xml' },
  oemSetup: { label: 'docker/windows-oem/setupcomplete.cmd', name: 'setupcomplete.cmd' },
  oemBoot: { label: 'docker/windows-oem/cua-firstboot.ps1', name: 'cua-firstboot.ps1' },
  provision: { label: 'docker/cua-guest-provision.sh', name: 'cua-guest-provision.sh' },
  android: { label: 'docker/cua-guest-android.sh', name: 'cua-guest-android.sh' },
  dockerfile: { label: 'Dockerfile', name: 'Dockerfile' },
  client: { label: 'plugins/dsh-cua-vm/client.js', name: 'client.js' },
  index: { label: 'plugins/dsh-cua-vm/index.js', name: 'index.js' },
  proxy: { label: 'docker/proxy.mjs', name: 'proxy.mjs' },
  compose: { label: 'compose.yaml', name: 'compose.yaml' },
  composeWindows: { label: 'compose.windows.yaml', name: 'compose.windows.yaml' },
  env: { label: '.env.example', name: '.env.example' }
}

/**
 * The chain, in the order it breaks.
 *
 * Each needle is a fact the feature depends on. `min` > 1 is used where the SAME
 * call has to appear on more than one path (shutdown and suspend), because one
 * surviving call site is exactly the regression that looks fine until the second
 * button.
 */
const NEEDLES = {
  supervisor: [
    // registry v2 + read-migration
    ['const REGISTRY_VERSION = 2', 1],
    ['function migrateRegistryRow(row)', 1],
    ['function migrateRegistry(parsed)', 1],
    ['parsed.version !== REGISTRY_VERSION', 1],
    // policy keys
    ['shutdownTimeoutSec: 120,', 1],
    ["checkpointPolicy: 'shutdown',", 1],
    ['shotsKeepDays: 7,', 1],
    ['windowsInstallTimeoutMinutes: 60', 1],
    ['const CHECKPOINT_POLICIES = new Set(', 1],
    // credentials: 0600, never the registry
    ['function windowsCredentialsPath(name)', 1],
    ['chmodSync(file, 0o600)', 1],
    // accounting + quota rule
    ['async function storeUsedBytes()', 1],
    ["path.join(STORE, 'shots'),", 1],
    ['async function refuseOverQuota(config, requestedBytes)', 1],
    ['used + Math.max(0, requestedBytes) <= quota', 1],
    // the delete manifest
    ['async function destroyVm(name, { reason =', 1],
    ["record('sb rm --force'", 1],
    ['checkpointFilesFor(name)', 1],
    ['shotFilesFor(name)', 1],
    ["record('views.json'", 1],
    ['async function collectGarbage(', 1],
    ['async function reconcilePorts()', 1],
    // the real shutdown
    ['async function shutdownVm(name, { reason', 1],
    ["{ execute: 'system_powerdown' }", 1],
    ["{ execute: 'quit' }", 1],
    ['async function waitForPowerDown(name, target, timeoutMs)', 1],
    ['async function startFromCheckpoint(name, meta)', 1],
    ['DSH_CUA_VM_LEGACY_STOP', 1],
    ["state = 'powered-off'", 1],
    ['mayBeTorn', 2],
    // one spec, two backends
    ['const SPEC_DEFAULTS = {', 1],
    ['function normaliseSpec(input = {})', 1],
    ['android: input.android === true, rea: input.rea === true', 1],
    ['rea: false,', 1],
    ['function gpuDefault()', 1],
    ["args.push('--gpu', 'virgl')", 1],
    ['const RUNNING_STATES = new Set(', 1],
    // one coordinate space
    ['const space = createSpace({', 1],
    ['relativeToPixels(measured, x, y)', 1],
    ['toDisplayPixels(measured, toX, toY)', 1],
    ['spaceLine(measured)', 4],
    ["const SHOTS_DIR = path.join(STORE, 'shots')", 1],
    ['formatSpaceWarning,', 1],
    // host facts + windows surface
    ['async function doctorReport()', 1],
    ['async function windowsCreateManaged(spec)', 1],
    ['const WINDOWS_NO_AGENT = (tool) =>', 1],
    ['async function windowsGui({', 1],
    ["backend: 'relay'", 1],
    // boot work
    ['void reconcilePorts()', 1],
    ['watchWindowsInstall(name)', 2],
    // D1: a failed spawn is a RESULT. The old handler read a property off
    // `done()`'s return and threw inside the 'error' listener, killing the
    // process; the fix routes it through the same single-shot `done`.
    ["child.on('error', (error) => done(-1, false,", 1],
    ['if (settled) return', 1],
    // D2: a name is a path segment, validated at the dispatcher AND at the
    // helpers that build a path from it.
    ['const VM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/', 1],
    ['function assertVmName(name)', 1],
    ['assertVmName(request.name)', 1],
    ['assertVmName', 12],
    // D3: "QMP unreachable" is not "the computer is off" — the pid decides.
    ['let qemuMayBeAlive = false', 1],
    ['qemuMayBeAlive = pidAlive(qemuPid(name))', 2],
    ["method = qemuMayBeAlive ? 'abandoned' : 'already-off'", 1],
    // ...and an abandoned computer is LEFT ALONE: no checkpoint, no sb rm, no
    // `powered-off` lie that would make Start build a second QEMU on the disk.
    ['could not power ${name} off: QEMU (pid ${qemuPid(name)}) is still running', 1],
    ['nothing was removed', 1],
    // D3 (round 2): the stale marking has a PRODUCER, in the same write as
    // lastShutdown=abandoned — without it Start's refusal was dead code.
    ['const stale = meta.restoreFrom?.stale === true', 1],
    ["row.restoreFrom?.kind !== 'checkpoint'", 1],
    ['staleReason:', 1],
    ['shutdown abandoned while QEMU held the disk', 1],
    ['Its existing restore point is now marked stale', 1],
    // D4: measuring must point cua at the computer being measured first.
    ['if (DO_TARGET !== name)', 2],
    ['space.clear()', 2],
    // D5: registry mutations are serialised, so an await cannot resurrect a
    // row another handler already moved on.
    ['function mutateRegistry(mutator)', 1],
    ["withLock('@registry'", 1],
    // S3: every lifecycle op takes the same per-computer lock, and it is
    // re-entrant so shutdown→suspend and stop→shutdown cannot deadlock.
    ['function withVmLock(name, fn)', 1],
    ['VM_LOCK_CONTEXT', 3],
    // S8/S9: an unreadable registry throws instead of being persisted empty, and
    // the v1→v2 write happens under the lock (at boot).
    ['registry.json could not be read', 1],
    ['await migrateRegistryFile()', 1],
    // S1: GC is serialised against the lifecycle lock it shares with a convert
    // or a boot, so it cannot delete a `.tmp` or a restore temp mid-flight.
    ["return withLock('@gc'", 1],
    ['withVmLock(groupName, run)', 1],
    // S5/S15: a failed `sb rm` keeps the row (marked orphaned) and the delete
    // reports itself as partial.
    ['row.orphaned = true', 1],
    ['deleted: complete', 1],
    ['failed: failures.map', 1],
    // S10: the quota is a RESERVATION, not a check-then-act.
    ['function reserveStoreBytes(name, bytes)', 1],
    ['releaseStoreBytes(name)', 1],
    ['releaseStoreBytes(spec.name)', 2],
    // S11/S12/S13: a checkpoint needs room, a QEMU that survives `quit` is not
    // off, and a failed shutdown puts the preview back.
    ['diskBytesFor(name)', 1],
    ["abandonedBecause = 'survived the QMP quit'", 1],
    ['restorePorts(name, previews)', 1],
    // S2: mayBeTorn is READ on the start path, not just written.
    ['meta.mayBeTorn === true', 1],
    // The Windows refusals live in the supervisor's create path (the backend
    // module is only the QEMU command builder).
    ['REA is not available for Windows computers', 1],
    ['Android is not available for Windows computers', 1],
    // The Windows lifecycle now drives the SAME shutdown/start machinery.
    ['async function windowsShutdown(name, meta)', 1],
    ['const windowsBackend = createWindowsBackend({ store: STORE, qmp: qmpCommands, log })', 1],
    ['function sshRun(meta, command,', 1],
    ['function scpRun(meta, localPath, guestPath', 1],
    ['await ensureWindowsConsoleRelay(name)', 2],
    // F1: EACH SHUTDOWN CHECKPOINTS ITS OWN DISK. These two needles are a pair
    // on purpose: swapping them (which happened) makes both platforms silently
    // skip their checkpoint.
    ['function checkpointDiskFile(name, disk)', 1],
    ['checkpointDiskFile(name, windowsPaths(STORE, name).disk)', 1],
    ['checkpoint = checkpointSandbox(name)', 2],
    // B2: Start restores a Windows checkpoint over the disk.
    ['restored from its checkpoint', 1],
    // D4: the watcher records that the install finished.
    ['row.installComplete = true', 3],
    // D5: an aborted shutdown rebuilds the live view instead of relaying to a
    // dead websockify.
    ['async function replaceLiveView(name, preview)', 1],
    // D7: a rejected relay kills the websockify it spawned.
    ['stopLiveView(name)\n      throw error', 1],
    // D9: the port claim is serialised and tracked in memory, and a failed
    // create releases EXACTLY its own three ports (`Object.values` of a Set is
    // [], which made the first version a no-op).
    ["withLock('@ports'", 1],
    ['const CLAIMED_WINDOWS_PORTS = new Set()', 1],
    ['for (const port of Object.values(portTriple ?? {})) CLAIMED_WINDOWS_PORTS.delete(Number(port))', 1],
    // R1: a KEPT item (the disk of a live QEMU) is not a completed delete, and
    // the row keeps it reachable until GC can reclaim it.
    ["const skipped = items.filter((item) => item.status === 'skipped')", 1],
    ['skipped.length === 0 && sandboxGone', 1],
    ['kept: skipped.map', 1],
    ['would reclaim the kept disk', 1],
    // R2: the registry write is a manifest step, so it cannot throw out of it.
    ["await step('registry.json'", 1],
    // R3: the boot/timer paths cannot die on a corrupt registry.
    ['windows: install watches were NOT resumed', 1],
    ['idle: registry unreadable', 1]
  ],
  space: [
    ['export const CAPTURE_MAX_PIXELS = 900_000', 1],
    ['export const SPACE_CACHE_MS = 30_000', 1],
    ['export function pngSize(bytes)', 1],
    ["readUInt32BE(16)", 1],
    ['export function formatSpace(space)', 1],
    ['export function formatSpaceWarning(space)', 1],
    ['image px = ${inverse} × display px; cua maps it — do not rescale', 1],
    ['export function relativeToPixels(space, x, y)', 1],
    ['export function toDisplayPixels(space, x, y)', 1],
    ['export function resolutionProblem(resolution', 1],
    ['DSH_CUA_VM_RESOLUTION_ALLOW_SCALE', 1]
  ],
  /**
   * THE WINDOWS BACKEND IS DIRECT QEMU. Every entry below is a fact the boot
   * depends on: a missing firmware path, a mis-derived VNC display, a missing
   * `-device usb-tablet` (absolute pointer) or a published QMP socket is a
   * computer that boots and cannot be driven.
   */
  windows: [
    // direct qemu, no container runtime
    ["export const WINDOWS_QEMU = process.env.DSH_CUA_WINDOWS_QEMU || '/usr/bin/qemu-system-x86_64'", 1],
    ['export function windowsHostCaps()', 1],
    // firmware: shared OVMF code + a per-computer vars store
    ["export const OVMF_CODE = process.env.DSH_CUA_WINDOWS_OVMF_CODE || '/usr/share/OVMF/OVMF_CODE_4M.fd'", 1],
    ['if=pflash,format=raw,readonly=on,file=${OVMF_CODE}', 1],
    ['if=pflash,format=qcow2,file=${p.efiVars}', 1],
    // TPM2 via swtpm on a unix socket
    ["export const SWTPM = process.env.DSH_CUA_WINDOWS_SWTPM || '/usr/bin/swtpm'", 1],
    ['-chardev', 1],
    ['tpm-crb,tpmdev=tpm0', 1],
    ['--ctrl', 1],
    // kvm + host cpu, and the q35 machine
    ["'-machine', 'q35,accel=kvm,smm=off'", 1],
    ["'-cpu', 'host'", 1],
    // disks: plain qcow2 (checkpointing still applies)
    ['file=${p.disk},if=none,id=disk0,format=qcow2,cache=writeback,discard=unmap', 1],
    // install medium while installing, drivers ISO when present, OEM payload
    ['if=none,id=cd0', 1],
    ['file=fat:rw:${p.oemDir},format=raw,if=none,id=oem0', 1],
    ['usb-storage,drive=oem0,bus=xhci.0', 1],
    // networking: SLIRP + the SSH forward (no bridge, no tap)
    ['user,id=net0,hostfwd=tcp:127.0.0.1:${spec.sshPort}-:22', 1],
    ['e1000e,netdev=net0', 1],
    // absolute pointer + keyboard: the QMP input path depends on both
    ["'-device', 'usb-tablet'", 1],
    ["'-device', 'usb-kbd'", 1],
    // VNC on loopback (the live view) and QMP on loopback (control)
    // B1: QEMU reads the value after the colon as a DISPLAY NUMBER (it binds
    // 5900+display), so the raw port must never be passed here.
    ["'-vnc', `127.0.0.1:${vncDisplayFor(spec.vncPort)}`", 1],
    ['tcp:127.0.0.1:${spec.qmpPort},server=on,wait=off', 1],
    ['export function vncDisplayFor(port)', 1],
    // D6: a failed boot stops the swtpm it started.
    ['stopSwtpm(spec.name)', 2],
    // the ISO sources are pinned and documented
    ['export const WINDOWS_ISO_SOURCES = {', 1],
    ['software-static.download.prss.microsoft.com', 5],
    ['export async function ensureIso(', 1],
    ['export function writeOemPayload(', 1],
    // frames and input over QMP
    ["execute: 'screendump'", 1],
    ["execute: 'input-send-event'", 1],
    ["execute: 'system_powerdown'", 1],
    ["execute: 'quit'", 1],
    ['export function charToKey(char)', 1],
    ['export function generatePassword()', 1],
    ['export function frameSpace(png)', 1],
    ['export function windowsEnabled()', 1]
  ],
  winMcp: [
    ['export function windowsMcpEnabled()', 1],
    ["String(process.env.DSH_CUA_VM_WIN_MCP ?? '1') !== '0'", 1],
    ['export function sshArgv(', 1],
    ["'notifications/initialized'", 1],
    ["request('tools/list'", 1],
    ["request('tools/call'", 1],
    ['dsh_cua.server', 1],
    ['--stdio', 1]
  ],
  oemAnswer: [
    ['<unattend xmlns="urn:schemas-microsoft-com:unattend">', 1],
    // D8: schema order, asserted by position rather than by presence: a
    // RunSynchronous before DiskConfiguration is rejected on some media.
    ['<DiskConfiguration>\n        <Disk', 1],
    ['</ImageInstall>\n      <RunSynchronous>', 1],
    ['<AutoLogon>\n        <Username>cua</Username>', 1],
    ['</FirstLogonCommands>\n      <OOBE>', 1],
    ['</OOBE>\n      <UserAccounts>', 1],
    ['<LocalAccount wcm:action="add"', 1],
    ['<Name>cua</Name>', 1],
    ['{{PASSWORD}}', 3],
    ['BypassTPMCheck', 1],
    ['<AutoLogon>', 1]
  ],
  oemSetup: [
    ['cua-firstboot.ps1', 1],
    ['setupcomplete exit', 1]
  ],
  oemBoot: [
    ['OpenSSH.Server', 2],
    ['{{SSH_PUBKEY}}', 1],
    ['administrators_authorized_keys', 1],
    ['{{PYTHON_URL}}', 1],
    ['{{DSH_CUA_PIP}}', 1],
    ['dsh_cua.server', 1],
    ['Register-ScheduledTask', 1],
    ['-LogonType Interactive', 1],
    // D10: the marker is an audit trail, not a readiness signal.
    ['an AUDIT marker', 1]
  ],
  provision: [
    ['MARKER=/var/lib/cua-provision', 1],
    ['VERSION="${MARKER_VERSION:-7}"', 1],
    ['apt_ok=$APT_OK', 1],
    ['display=${GEOM:-unknown}', 1],
    ['space_helper=$SPACE_HELPER', 1],
    ['space helper: $SPACE_HELPER', 1],
    ['cua-space', 3],
    ['NOT OK apt_broken=1', 2],
    ['exit 2', 1],
    ['MESA_GL_VERSION_OVERRIDE=4.3FC', 3]
  ],
  android: [
    // The Android layer is deliberately untouched by this change; its marker is
    // the proof that the file is still the same script.
    ['say "OK image=$IMAGE avd=$AVD', 1],
    ['MARKER=/var/lib/cua-android', 1]
  ],
  dockerfile: [
    ['imagemagick', 1],
    ['--no-install-recommends', 1],
    ['docker/cua-vm-space.mjs', 1],
    ['docker/cua-vm-windows-qemu.mjs', 1],
    ['docker/windows-oem/', 1],
    ['ovmf swtpm', 1],
    ['tools/check-cua-vm.mjs /opt/seek-harness/check-cua-vm.mjs', 1],
    ['node /opt/seek-harness/check-cua-vm.mjs --root /opt/seek-harness/cua-check', 1]
  ],
  client: [
    // the four labels are a contract: automation reads them
    ["'Enable GPU'", 1],
    ["'Enable REA'", 1],
    ["'Install Android'", 1],
    // kind + version
    ["value: 'linux' }, 'Linux (Cua guest)'", 1],
    // F2: the kind picker and the provisioning blurb must say what runs now.
    ['Windows (direct QEMU)', 1],
    ["disabled: state.windows?.ok !== true", 1],
    ['windowsVersion', 2],
    ["kind: 'windows'", 1],
    // the shutdown/suspend split
    ["'Shutdown'", 1],
    ["'Suspend'", 1],
    ["'Clean up'", 1],
    ['Reveal password', 1],
    ["'installing'", 1],
    // the space line is shown, not hidden
    ["api('space'", 1],
    ['rea: false', 1],
    ['rea: draft.rea', 1]
  ],
  index: [
    ["name: 'cua_vm_start'", 1],
    ["name: 'cua_vm_shutdown'", 1],
    ["name: 'cua_vm_gc'", 1],
    ["name: 'cua_vm_doctor'", 1],
    ["op: 'vmWindowsCreate'", 1],
    ["op: 'vmGc'", 1],
    ["op: 'vmDoctor'", 1],
    // R1: a partial delete prints what failed AND what was kept on purpose.
    ['- KEPT ${item.target}: ${item.reason}', 1],
    // B3: the create result must not describe the container backend.
    ['Live view: ${answer.console} (noVNC over QEMU VNC, never published raw).', 1],
    // F2: the create result must not describe the container backend either.
    ['runs commands over SSH in cmd.exe', 1],
    // D11: a stop/delete takes the guest's tools away within 5 s.
    ['}, 5000)', 1],
    ['- FAILED ${item.target}: ${item.detail}', 1],
    // the port answer is url + localPort; `target` was never in the payload
    ['result.url', 1],
    ['result.localPort', 1],
    // guided refusal for a Windows computer
    ['not available', 1],
    ["rea: { type: 'boolean'", 1],
    ['input.rea === true', 1],
    // the prompt carries the invariants
    ['SPACE:', 1],
    ['SHUTDOWN vs SUSPEND:', 1],
    ['WINDOWS (`kind: "windows"`', 1]
  ],
  proxy: [
    ['export function prefixRootPaths(text, prefix)', 1],
    ["entry?.backend === \"relay\"", 1],
    ['REWRITABLE_TYPES', 2],
    ["delete headers[\"accept-encoding\"]", 1]
  ],
  compose: [
    ['DSH_CUA_VM_WINDOWS: "${DSH_CUA_VM_WINDOWS:-0}"', 1],
    ['DSH_CUA_VM_GPU: "${DSH_CUA_VM_GPU:-}"', 1],
    ['DSH_CUA_VM_RESOLUTION: "${DSH_CUA_VM_RESOLUTION:-1200x750}"', 1],
    ['DSH_CUA_VM_LEGACY_STOP', 1]
  ],
  composeWindows: [
    // The overlay hands over devices and switches; it does NOT add an engine.
    ['- /dev/kvm', 1],
    ['- /dev/dri', 1],
    ['DSH_CUA_VM_WINDOWS: "${DSH_CUA_VM_WINDOWS:-1}"', 1],
    ['DSH_CUA_WINDOWS_QEMU:', 1],
    ['DSH_CUA_WINDOWS_VIRTIO_ISO:', 1],
    ['DSH_CUA_VM_WIN_MCP:', 1],
    // SLIRP and the store layout are the documented contract
    ['10.0.2.2', 2],
    ['/cua-vm/windows/<name>/', 1],
    ['/cua-vm/iso/', 1],
    ['No DinD service', 1]
  ],
  env: [
    ['DSH_CUA_VM_WINDOWS=0', 1],
    ['DSH_CUA_VM_GPU=', 1],
    ['DSH_CUA_VM_RESOLUTION_ALLOW_SCALE=', 1],
    ['DSH_CUA_VM_LEGACY_STOP=', 1]
  ]
}

/**
 * Deletions this change made on purpose. A gate can only prove a thing is
 * present; these make sure the OLD shape does not come back, because both of
 * them were bugs that looked like features:
 *
 *   /cua-vm/shots      a hardcoded store path that ignored CUA_VM_STORE
 *   Math.sqrt(900000   the guessed capture scale, replaced by a measurement
 *   runCua(['sb','resume'] in a start path for a powered-off computer
 */
const FORBIDDEN = [
  {
    key: 'composeWindows',
    pattern: 'dind',
    reason: 'the Windows backend is direct QEMU now; a DinD sidecar is the architecture this replaced'
  },
  {
    key: 'windows',
    pattern: 'dockerRequest',
    reason: 'the Docker Engine API client was removed with the container backend'
  },
  {
    key: 'windows',
    pattern: 'dockurr',
    reason: 'the dockur/windows image is gone; the guest is a pinned Microsoft ISO on direct QEMU'
  },
  {
    key: 'windows',
    pattern: "['VRAM_SIZE'",
    reason: 'VRAM_SIZE is a no-op on the pinned qemux/qemu:7.12 base; asserting it made the gate pass on noise'
  },
  {
    key: 'windows',
    pattern: "['SHUTDOWN'",
    reason: 'v4.35 shuts down gracefully unconditionally, so SHUTDOWN=Y changes nothing'
  },
  {
    key: 'windows',
    pattern: "['ISO'",
    reason: 'there is no ISO variable in dockurr/windows v4.35: a remote ISO is VERSION=<url>, a local one is /boot.iso'
  },
  {
    key: 'supervisor',
    pattern: '/cua-vm/shots',
    reason: 'the bucket is `$STORE/shots`; a hardcoded path is invisible to cua_vm_gc and to destroy'
  },
  {
    key: 'supervisor',
    pattern: 'Math.sqrt(900000',
    reason: 'the capture scale is MEASURED from the PNG (space.measure); a budget guess is the 6%-off click'
  }
]

let failures = 0
let total = 0
const missing = []

console.log(`cua-vm gate — ${ROOT}`)

for (const [key, spec] of Object.entries(FILES)) {
  const file = pick(spec.name)
  if (file === null) {
    failures += 1
    missing.push(`${spec.label}: file not found under ${ROOT}`)
    console.log(`  FAIL ${spec.label}: file not found`)
    continue
  }
  const text = readFileSync(file, 'utf8')
  let checked = 0
  let bad = 0
  for (const [needle, min] of NEEDLES[key] ?? []) {
    checked += 1
    total += 1
    const hits = (text.match(new RegExp(needlePattern(needle), 'gu')) || []).length
    if (hits < min) {
      bad += 1
      failures += 1
      missing.push(`${spec.label}: ${hits}/${min} × ${needle}`)
    }
  }
  for (const rule of FORBIDDEN.filter((entry) => entry.key === key)) {
    checked += 1
    total += 1
    if (text.includes(rule.pattern)) {
      bad += 1
      failures += 1
      missing.push(`${spec.label}: forbidden "${rule.pattern}" — ${rule.reason}`)
    }
  }
  if (bad === 0) {
    if (!values.quiet) console.log(`  ok   ${spec.label} — ${checked} assertion(s)`)
  } else {
    console.log(`  FAIL ${spec.label} — ${bad}/${checked} assertion(s) failed`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed:`)
  for (const line of missing) console.error(`  - ${line}`)
  console.error('\nThe personal VM is one chain: spec → supervisor → guest → plugin → proxy → compose.')
  console.error('A missing line is a hop that no longer exists, not a formatting nit.')
  process.exit(1)
}

console.log(`\npersonal VM wired end to end: registry, accounting, shutdown, space, Windows, proxy, compose.`)
console.log(`${total} assertion(s) across ${Object.keys(FILES).length} file(s).`)
process.exit(0)
