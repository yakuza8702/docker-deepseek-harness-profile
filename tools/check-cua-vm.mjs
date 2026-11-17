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
  kvm: { label: 'docker/cua-vm-kvm.mjs', name: 'cua-vm-kvm.mjs' },
  windows: { label: 'docker/cua-vm-windows-qemu.mjs', name: 'cua-vm-windows-qemu.mjs' },
  winMcp: { label: 'plugins/dsh-cua-vm/win-mcp.js', name: 'win-mcp.js' },
  oemAnswer: { label: 'docker/windows-oem/Autounattend.xml', name: 'Autounattend.xml' },
  oemSetup: { label: 'docker/windows-oem/setupcomplete.cmd', name: 'setupcomplete.cmd' },
  oemBoot: { label: 'docker/windows-oem/cua-firstboot.ps1', name: 'cua-firstboot.ps1' },
  oemLauncher: { label: 'docker/windows-oem/Unattend.vbs', name: 'Unattend.vbs' },
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
    // U2/U4: THE CLIPBOARD (session 2 only) AND THE MEASURED FREE SPACE.
    // The backend owns the protocol (file, then task, then the task's own Last
    // Result); this file owns the channel (the per-computer key, scp). The
    // transport is INJECTED so a test can drive the real protocol with a stub.
    ['async vmWindowsClipboardSet({ name, text } = {})', 1],
    ['async vmWindowsClipboardGet({ name } = {})', 1],
    ['async vmWindowsFreeSpace({ name, force = false } = {})', 1],
    ['windowsBackend.clipboardSet({ ...meta, name })', 1],
    ['windowsBackend.clipboardGet({ ...meta, name })', 1],
    ['transport: windowsClipboardTransport()', 1],
    ['function windowsClipboardTransport()', 1],
    ['cua-clip-set', 2],
    ['cua-clip-get', 1],
    ['Last Result', 2],
    ['clip-read.txt', 1],
    ['U2: WHAT TO SAY WHEN THE CLIPBOARD SECTION IS UNAVAILABLE', 1],
    // U4: the measured C: free space, throttled, never fatal.
    ["freeSpace: state === 'ready' ? await windowsFreeSpace(meta)", 1],
    ['const WINDOWS_FREE_TTL_MS = 60000', 1],
    // One probe per computer at a time: the panel's 5 s status beat and the 60 s
    // free-space beat must not open two SSH sessions on a guest that is busy.
    ['const WINDOWS_FREE_INFLIGHT = new Map()', 1],
    ['if (WINDOWS_FREE_INFLIGHT.get(name) === probe) WINDOWS_FREE_INFLIGHT.delete(name)', 1],
    ['\'powershell -NoProfile -NonInteractive -Command "(Get-PSDrive -Name C).Free"\'', 1],
    // registry v2 + read-migration
    ['const REGISTRY_VERSION = 2', 1],
    ['function migrateRegistryRow(row, mapKey = \'\')', 1],
    // R2: the migration INJECTS `name` into every row already on disk, so a
    // store written before the fix stops answering "QEMU not alive" about a
    // running process. The map key is the only place that name exists.
    ['out[name] = migrateRegistryRow(row, name)', 1],
    // R3: the QMP join. The backend's `(host, port, cmds, opts)` and this
    // process's `(port, cmds, { timeoutMs, host })` are different signatures,
    // and passing the raw primitive made the HOST the PORT. The one-line
    // `createWindowsBackend({ store: STORE, qmp: qmpCommands, log })` needle was
    // REPLACED (not dropped) by the multi-line wiring below, in the same commit.
    ['const windowsBackend = createWindowsBackend({', 1],
    ['qmp: windowsQmpAdapter(qmpCommands),', 1],
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
    // Q1: THE CREATE-TIME QUOTA IS REAL BYTES. A sparse disk's VIRTUAL size is
    // never charged: the create reserves 0 and reports `disk-over-policy`
    // instead of refusing (the report was "a 64 GB disk does not fit the VM
    // store quota (15 GB)"; the store held a few hundred MB).
    ['function diskPolicyWarnings(diskGb, config)', 1],
    ["code: 'disk-over-policy'", 1],
    ['the disk is sparse so creation proceeds', 1],
    ['diskPolicyWarnings(effectiveDiskGb, config)', 1],
    ['diskPolicyWarnings(diskGb, config)', 1],
    ['reserveStoreBytes(name, 0)', 1],
    ['reserveStoreBytes(spec.name, 0)', 1],
    // The refusal that survives names REAL usage, never the virtual request.
    ['of real store data', 1],
    ['warnings: warnings.length > 0 ? warnings : undefined', 2],
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
    // K2: the runtime path of the OEM payload, spelled with its default. The
    // Dockerfile must COPY to this exact string (cross-checked in the K2
    // assertion below); this needle keeps the literal from being rewritten to a
    // path no image ships.
    ["DSH_CUA_WINDOWS_OEM_DIR || '/usr/local/share/cua-vm/windows-oem'", 1],
    // K2: the fallback list is RESOLVED and HANDED to the writer, not just
    // declared — a constant nothing reads is not a fallback.
    ['fallbackDirs: WINDOWS_OEM_FALLBACK_DIRS', 1],
    ['DSH_CUA_WINDOWS_OEM_FALLBACK_DIRS', 1],
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
    // K3: during Setup only SSH gates `ready` (QEMU's VNC socket answers from
    // the first second of setup.exe and used to mark a half-install ready).
    ["phase: 'install'", 1],
    // F3: THE STATUS POLL MUST NOT PROMOTE A HALF-INSTALL. `vmWindowsStatus`
    // called `ready(meta, { ssh })` with NO phase, so an ordinary panel poll
    // took the RUNNING path, accepted the VNC banner (which answers from the
    // first second of setup.exe), wrote state:'ready' + installComplete, stopped
    // the watcher and let the idle timer suspend a live install. The poll now
    // passes the SAME phase the watcher does, decided from the row.
    ['const installPhase = meta.state === \'installing\' || meta.state === \'booting\'', 1],
    ['...(installPhase ? { phase: \'install\' } : {})', 1],
    // H4: the abandoned Windows shutdown marks its restore point, like Linux.
    ['async function markWindowsShutdownAbandoned(name, because)', 1],
    ['windowsBackend.pidAlive(windowsPid)', 1],
    // H5: the start verifies QEMU reached `running` before trusting it.
    ['let running = false', 1],
    // H1/H7: per-attempt deadline, port reconciliation.
    ['row.startedAt = new Date().toISOString()', 1],
    ['async function reconcileWindowsPorts(name, meta)', 1],
    // M1: the ISO cache is accounted for and GC'd.
    ['ISO_DIR', 3],
    ['report.isos.push', 1],
    // M6/X1: a genuine rebuild stops the old child; a live one is reused.
    ['stopLiveView(name)', 4],
    // M5: Windows guest paths are validated before they reach scp.
    ['function assertWindowsGuestPath(guest)', 1],
    // L2: one canonical backend value, also in the migration.
    ["backend: windows ? 'qemu' : 'linux'", 1],
    // X1: reuse the live view instead of killing it on every call.
    ['const alive = child !== undefined && child.exitCode === null && child.signalCode === null', 1],
    // X2: region/scale reach the Windows branch.
    ['windowsGui({ name, action, x, y, x2, y2, text, key, save, app, window: windowName, path: target, relative, region, scale })', 1],
    // X4: shared media is never pruned (the virtio ISO is referenced by no row).
    ['const alwaysKeep = new Set([', 1],
    // Z3: the allowlist uses the SAME name normalisation as the download.
    ['isoTargetPath(ISO_DIR, entry.url)', 1],
    // X5/Z1: reconciliation respects other rows and in-flight claims, and
    // excludes the SUBJECT by name (rows carry no `name` field, so comparing
    // against `meta.name` never matched and every start re-allocated).
    ['const reserved = new Set(CLAIMED_WINDOWS_PORTS)', 1],
    ['if (otherName === name) continue', 1],
    ['for (const port of Object.values(ports)) reserved.delete(Number(port))', 1],
    // Z2: the row owns its ports once written; the claim is released there.
    ['for (const port of Object.values(portTriple)) CLAIMED_WINDOWS_PORTS.delete(Number(port))', 1],
    // Z4: without websockify an existing raw relay IS the view.
    ["const rawRelay = existing.backend === 'relay'", 1],
    // X6: the download reserves before it writes.
    ['reserveStoreBytes(`${spec.name}/iso`, expectedBytes)', 1],
    // X7: resume rebuilds the preview.
    ["await ensureWindowsConsoleRelay(name)\n    return ok({ name, state: 'ready', kind: 'windows' })", 1],
    // K8: the Linux path keeps its behaviour (no new refusal) but a failed
    // create carries the SAME diagnosis when the device is mounted and denied.
    ['function linuxKvmFailureHint()', 1],
    ['${linuxKvmFailureHint()}', 1],
    ['const kvmError = windowsKvmPreflight()', 1],
    // K9: the doctor reads the probe instead of parsing its own text.
    ['const kvmFacts = kvmDoctorFacts(kvmStatus())', 1],
    ['kvmUsable: kvmFacts.kvmUsable,', 1],
    // The floors produce warnings, and the requested sizes are not clamped.
    ['const warnings = windowsCapacityWarnings({ diskGb, memory, cpu })', 1],
    ['warnings,', 2],
    ['const diskGb = given.disk ? spec.diskGb : WINDOWS_DEFAULT_DISK_GB', 1],
    // Y1: the virgl decision is made once and stored on the row.
    ["const virgl = spec.gpu === true && systemQemuSupportsVirgl() && existsSync('/dev/dri/renderD128')", 1],
    ['      virgl,', 1],
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
    ['idle: registry unreadable', 1],
    // F1/F2: QEMU'S STDERR REACHES THE ROW, THE LOG AND THE ERROR — and the
    // early-death watchdog flips the row to `error` on its FIRST short tick
    // instead of waiting out the 60-minute install timeout.
    ['function windowsQemuStderrTail(name, lines = 20)', 1],
    ['function windowsEarlyDeathWindowMs()', 1],
    ["DSH_CUA_WINDOWS_EARLY_CHECK_MS", 1],
    // N1's second half: the same unset→0 trap in the watchdog's first tick.
    ['const raw = process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS', 1],
    ["if (raw !== undefined && raw !== '') {", 1],
    ['first ? windowsEarlyDeathWindowMs() : 15000', 1],
    ["const errorText = `${why}", 1],
    ['the Windows computer did not start:', 1],
    ['row.errorLog = errorLog', 1],
    ['died before it could install', 1],
    ['const stderrTail = windowsQemuStderrTail(name, 20)', 2],
    ['row.errorLog = stderrTail.slice(-4000)', 1],
    // F3: the row records the degraded display, and the create answer carries it.
    ['const gpuFallback = booted?.gpuFallback === true', 1],
    ['virgl: gpuFallback ? false : virgl,', 1],
    // F4: a row that never got an install sentence still answers with one.
    ['the last start attempt did not reach a guest', 1],
    ['meta.state === \'error\' && typeof meta.error === \'string\'', 1],
    // B1: THE ROW STORES THE REQUESTED SPEC. `vmCreate` (the panel's path, not
    // `vmWindowsCreate`) used to lose the "was this given?" flags, so a Windows
    // create read "nothing was given" and wrote 64 GB / 6 GB over a 20 GB / 4 GB
    // request. These lines are the fix; the floors stay warnings.
    ['spec.diskGiven = Number(input.diskGb) > 0', 2],
    ['spec.memoryGiven = Number(input.memory) > 0', 2],
    ['const diskGb = given.disk ? spec.diskGb : WINDOWS_DEFAULT_DISK_GB', 1],
    ['requested: { diskGb, memory, cpu }', 1],
    // B2: THE PROGRESS SENTENCE HAS ONE FORMATTER, shared by the watcher and the
    // status payload. The old inline template interpolated a raw `endpoint`
    // (undefined) and `status || 'not running'`.
    ['formatWindowsInstallDetail({ phase: \'install\', verdict, elapsedMinutes, serialTail })', 1],
    ['const installDetail = state === \'ready\'', 1],
    ['installDetail,', 1],
    // B3: THE INSTALLING PAYLOAD CARRIES THE SERIAL TAIL AND THE READINESS
    // SIGNALS, so the panel and the tool both answer "how do I know it finished"
    // without a second call. Reading is a SMALL tail, not the whole file.
    ['serialTail: showInstall ? serialTail : [],', 1],
    ['const serialTail = windowsProgressTail(name, Math.max(1, Math.min(5, Number(tail) || 20)))', 1],
    ['function windowsProgressTail(name, lines = 5)', 1],
    ['readiness: windowsReadinessSignals(name),', 1],
    ['row.serialTail = serialTail', 2],
    // D3/D5: DONE-DETECTION HAS A SECOND SIGNAL, AND THE DEADLINE FOLLOWS THE
    // STAGE. A booted disk with no SSH is "firstboot failed", not "the install
    // did not finish" — and the panel says so in the exact words the user asked
    // for. Both calls (watcher + status poll) read the same serial signal.
    ['function windowsInstallSshGraceMinutes()', 1],
    ['const bootedAtMs = Date.parse(meta.bootedAt || \'\')', 2],
    ['windowsBootedFromDisk(', 3],
    ['const overDeadline = bootedStage ? bootedMinutes > sshGraceMinutes : elapsedMinutes > timeoutMinutes', 1],
    ['the installed disk never booted', 1],
    ["row.installStage = 'booted'", 2],
    ['installStage: bootedStage ? \'booted\' : \'installing\',', 2],
    ['WINDOWS_SSH_MISSING_DETAIL', 2],
    // D2: THE READY TRANSITION EJECTS. One helper, called from the watcher AND
    // from the status poll (a panel can see ready first), guarded by
    // `installMediaDetached` so it is a once-only action.
    ['async function detachWindowsInstallMedia(name)', 1],
    ['await detachWindowsInstallMedia(name)', 2],
    ['freshRow.installMediaDetached = failed.length === 0', 1],
    // ...and only when nothing failed, so a QMP that did not answer is retried
    // (rate-limited) instead of leaving the media attached for the session.
    ['const lastAttempt = Date.parse(row.installMedia?.at || \'\') || 0', 1],
    // A row that says `installing` with no process is STUCK: the state is not
    // rewritten to `stopped`, so the panel keeps offering the one action that
    // resolves it (Force delete).
    ['const stuck = meta.state === \'installing\' && !verdict.alive', 1],
    ['stuck,', 1],
    // ADD-ON 1: A WINDOWS ROW HAS NO CUA SANDBOX, so the manifest must not run
    // `sb rm` for it — that failure is the user's "Partially deleted win-test —
    // failed: sb rm --force". The kind is read BEFORE anything is removed.
    ['const isWindows = subject?.kind === \'windows\' || subject?.backend === \'qemu\'', 1],
    ['if (isWindows) {', 1],
    ['a Windows computer has no cua sandbox (direct QEMU: its disks and its row are removed below)', 1],
    // ...and the skipped step is INFORMATIONAL: not a failure, not a kept disk,
    // so the manifest can be COMPLETE.
    ["record('sb rm --force', 'not-applicable'", 1],
    // ADD-ON 2: FORCE DELETE IS A VERIFIED KILL *BEFORE* THE MANIFEST. The kill
    // is recorded first, so the order is visible in the answer.
    ['if (force === true) {', 1],
    ['await windowsBackend.forceKill(name, { waitMs: 5000 })', 1],
    ['force: forced.requested ? { requested: true, killed: forced.killed } : undefined', 1],
    ['canForce: complete ? undefined : true', 1],
    ['async vmDelete({ name, force = false } = {})', 1],
    ['async destroy({ name, force = false } = {})', 1],
    ['force: force === true', 1]
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
  /**
   * THE DEVICE SPLIT. `/dev/kvm` mounted is not `/dev/kvm` usable: the container
   * runs as uid 1000 while the host node is normally root:kvm 0660, and the old
   * probe (`statSync(...).isFile()`, false for a character device) reported a
   * MOUNTED device as absent. These needles pin the two cases apart, because
   * collapsing them again re-creates the user's bug: one sentence, wrong advice.
   */
  kvm: [
    // one module, one implementation, imported by both backends
    ["export const KVM_DEVICE = process.env.DSH_CUA_KVM_DEVICE || '/dev/kvm'", 1],
    ['export function kvmStatus(options = {})', 1],
    ['export function kvmPreflightError(status, { purpose', 1],
    ['export function deviceNodePresent(file, stat = statSync)', 1],
    ['export function regularFilePresent(file, stat = statSync)', 1],
    // the states are named, not inferred
    ["['ok', 'missing', 'denied', 'not-device']", 1],
    // presence is a CHARACTER DEVICE, and access is a real syscall
    ['isCharacterDevice()', 1],
    ['accessSync', 1],
    ['fsConstants.R_OK', 1],
    // the denial message quotes the observation and the fix
    ['(uid:gid)', 1],
    ['this process is ', 1],
    ['supplementary groups ', 1],
    ['GROUP/GID problem, not a missing device', 1],
    ['stat -c %g /dev/kvm', 1],
    ['group_add:', 1],
    ['KVM_GID', 1],
    // the missing message keeps the old instruction (never delete a needle)
    ['needs /dev/kvm (compose.emulator.yaml)', 1],
    ['does not exist in this container (ENOENT)', 1],
    // the doctor cannot say "usable" about a denied device
    ['export function formatKvmStatus(status)', 1],
    ['export function kvmDoctorFacts(status)', 1]
  ],
  windows: [
    // direct qemu, no container runtime
    ["export const WINDOWS_QEMU = process.env.DSH_CUA_WINDOWS_QEMU || '/usr/bin/qemu-system-x86_64'", 1],
    ['export function windowsHostCaps()', 1],
    // K7: a device node is not a file, and presence is not access.
    ['kvmUsable: kvm.state === \'ok\'', 1],
    ['kvm: deviceNodePresent(KVM_DEVICE) || kvm.exists', 1],
    ['export function windowsKvmPreflight()', 1],
    ['const kvmError = windowsKvmPreflight()', 1],
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
    // R4: THE BOOT ORDER FOLLOWS THE PHASE. The old argv always put the disk at
    // bootindex 1 and the CD at 2 while its comment claimed the ISO booted
    // first: OVMF created Boot0002 for the unbootable HDD, tried it, said "HDD
    // Not Found", then reached the DVD — a wasted boot cycle per install, and
    // the reason cdboot's 5 s "Press any key" window was entered late.
    ['const diskBootIndex = boot ? 2 : 1', 1],
    ['ide-cd,drive=cd0,bus=ide.1,bootindex=1', 1],
    // install medium while installing, drivers ISO when present
    ['if=none,id=cd0', 1],
    // S1: THE ANSWER-FILE DISK REPLACED THE vvfat USB STICK. dockur/windows'
    // mechanism: a FAT32 HARD-DISK image whose root holds Autounattend.xml,
    // attached AFTER the system disk. `ide.2` is the first slot after the qcow2
    // on ide.0, so Windows still sees the qcow2 as Disk 0 (DiskID 0).
    // The old `file=fat:ro:${p.oemDir}` + usb-storage pair is GONE — Setup did
    // not reliably enumerate that stick, which is why a human had to click
    // through Setup. Never reintroduce it.
    //
    // F1/M9: THE MEDIUM IS WRITABLE **AND REMOVABLE**. This needle used to
    // require `readonly=on` (the OLD OEM stick's write protection) and then the
    // writable `ide-hd` shape. QEMU 10 rejects a read-only node behind ide-hd
    // ("Block node is read-only"), and — the live forensic finding — Setup
    // never scans a FIXED-disk root for Autounattend.xml, so an ide-hd attach
    // can never be read however correct the image is. The needle class is
    // RETARGETED, never deleted: it now pins the writable setup0 drive behind
    // usb-storage with `removable=on`, and the semantic assertion below rejects
    // ANY `readonly=on` reappearing on this drive and any `ide-hd` setup0 form.
    ['file=${p.setupImg},format=raw,if=none,id=setup0', 1],
    ['usb-storage,drive=setup0,removable=on,bus=xhci.0', 1],
    ["setupImg: path.join(dir, 'setup.img')", 1],
    ['export function buildSetupImage(', 1],
    ['export function verifySetupImage(', 1],
    ['export const SETUP_IMAGE_ENTRIES = Object.freeze([', 1],
    ["export const SETUP_IMAGE_LABEL = 'SETUP'", 1],
    ['export function answerFileDiskIds(xml)', 1],
    ['export function assertAnswerFileTargetsSystemDisk(', 1],
    ['export function normaliseProductKey(value)', 1],
    // F1: THE ANSWER DISK IS A PARTITIONED DISK. A partitionless FAT32
    // superfloppy is mounted by the FIRMWARE and by nothing else: Windows
    // enumerates fixed disks through their partition table, so WinPE never
    // mounted setup.img and the install fell back to the interactive language
    // screen. These needles pin the MBR + the LBA-2048 partition, and pin every
    // mtools call to the partition's BYTE OFFSET (`-i img@@offset`, mtools
    // 4.0.48 syntax) instead of the whole image.
    ['export const SETUP_PARTITION_START_LBA = 2048', 1],
    ['export const SETUP_PARTITION_OFFSET_BYTES = SETUP_PARTITION_START_LBA * SETUP_SECTOR_BYTES', 1],
    ['export const SETUP_PARTITION_TYPE = 0x0c', 1],
    ['export function setupVolumeSpec(imagePath)', 1],
    ['export function setupMbrSector({', 1],
    ['export function writeSetupMbr(imagePath)', 1],
    ['export function readSetupMbr(imagePath)', 1],
    ["sector[entry + 4] = SETUP_PARTITION_TYPE", 1],
    ['sector.writeUInt32LE(startLba, entry + 8)', 1],
    ['sector[SETUP_MBR_SIGNATURE.offset] = SETUP_MBR_SIGNATURE.bytes[0]', 1],
    ['const volume = setupVolumeSpec(p.setupImg)', 2],
    ["run(MTOOLS.format, ['-i', volume, '-F', '-H', String(SETUP_PARTITION_START_LBA), '-v', SETUP_IMAGE_LABEL, '::'])", 1],
    ["run(MTOOLS.copy, ['-i', volume, '-s', ...staged, oemTree, '::'])", 1],
    ["execFileSync(MTOOLS.dir, ['-i', volume, '-b', spec]", 1],
    ["if (mbr.signature !== '55aa')", 1],
    ['const mbr = readSetupMbr(p.setupImg)', 1],
    ['mdir', 1],
    // S2: the byte compare is part of the build, not a comment.
    ['staged.equals(fromImage)', 1],
    // S3: optional product key, never shown by Setup.
    ['{{PRODUCT_KEY}}', 1],
    ['WillShowUI>Never', 1],
    // F2: THE EDITION IS NAMED IN THE ANSWER FILE. Without <InstallFrom> Setup
    // stops at "Select the operating system you want to install" — the second
    // interactive stop after the language page. The name is pinned to the value
    // VERIFIED from the pinned 11ltsc ISO's own WIM XML (single image,
    // INDEX 1, NAME "Windows 11 IoT Enterprise LTSC 2024 Evaluation").
    ['{{IMAGE_INSTALL}}', 2],
    ['export const WINDOWS_IMAGE_SELECTIONS = Object.freeze({', 1],
    ["    key: '/IMAGE/NAME',", 1],
    ["    value: 'Windows 11 IoT Enterprise LTSC 2024 Evaluation',", 1],
    ['export function resolveWindowsImageSelection({', 1],
    ['export function imageInstallFromXml(selection)', 1],
    ['export function assertAnswerFileSelectsImage(xml)', 1],
    ['const selected = assertAnswerFileSelectsImage(stagedXml)', 1],
    ["if (metadata !== 1)", 1],
    // S4: dockur's hidden launcher shape (the launcher itself is asserted in
    // oemLauncher / oemSetup; the writer must copy it into $OEM$).
    ['Unattend.vbs', 2],
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
    // K2: TWO probed public URLs are pinned now — Server 2025 and Windows 11 IoT
    // Enterprise LTSC 2024 (both answered 206 to a live ranged GET); the rest
    // answer 400 and require `windowsIso`.
    ['software-static.download.prss.microsoft.com', 2],
    ['export function resolveWindowsIso(version)', 1],
    ['has no public direct ISO link', 1],
    // The LTSC source, its alias, and the fact that the alias is canonicalised.
    ["'11ltsc': {", 1],
    ['CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso', 1],
    ['export const WINDOWS_VERSION_ALIASES = { ltsc11: \'11ltsc\' }', 1],
    ['export function canonicalWindowsVersion(version)', 1],
    // FLOORS ARE WARNINGS. The create must produce advice, never a clamp.
    ['export function windowsCapacityWarnings({ diskGb, memory, cpu })', 1],
    // U4: the free-space formatters live in THIS module (pure, unit-tested).
    ['export function parseFreeSpaceProbe(stdout)', 1],
    ['export function formatWindowsFreeSpace(bytes)', 1],
    ['export const WINDOWS_FREE_FLOOR_GB = 10', 1],
    ['disk-below-floor', 1],
    ['memory-below-floor', 1],
    ['Created anyway on request', 3],
    ['export async function ensureIso(', 1],
    // R3: the backend dials `qmp(host, port, cmds, opts)` and this process's one
    // QMP implementation is `qmpCommands(port, cmds, { timeoutMs, host })`. The
    // raw primitive used to be handed over, so the HOST arrived as the PORT, the
    // dial threw, and a running QEMU never reached `ready` ("QMP not answering"
    // forever). The adapter is the join; it must be the thing passed in.
    ['export function windowsQmpAdapter(primitive)', 1],
    ['export function windowsRowName(spec, fallback = \'\')', 1],
    // R1: cdboot's "Press any key to boot from CD or DVD" is pressed over QMP
    // during the install phase only — the window is 5 s and EFI_TIMEOUT lands
    // the firmware in the Internal Shell, a dead end.
    ['export function cdbootKeyScheduleMs()', 1],
    ['export async function runCdbootKeys({', 1],
    ['if (installPending && cdbootKeysEnabled() && child?.pid)', 1],
    // F2: THE ANCHOR IS SERIAL ACTIVITY, NOT THE SPAWN CLOCK. A fixed 1.5 s
    // press lands before OVMF has reached the CD; the prompt (or first output
    // + 1.5 s) is the event that actually opens the window.
    ['export const CDBOOT_PROMPT_PATTERN', 1],
    ['export function cdbootPromptSeen(text)', 1],
    ['export function readSerialTail(file, bytes = 8192)', 1],
    ['serialLog: p.serialLog', 1],
    // R5: belt and braces for the Shell fallback.
    ['export function startupNshText()', 1],
    ["writeFileSync(path.join(p.oemDir, 'startup.nsh'), startupNshText())", 1],
    ['export function writeOemPayload(', 1],
    // K2: the payload writer must NAME the files it needs (the error text and
    // this gate quote the same list), must resolve a directory that actually
    // holds all of them, and must fail with the actionable image message rather
    // than a bare path. Deleting any of these re-creates the user-facing bug:
    // "the OEM payload is missing from this image: <path>" with no way forward.
    ['export const OEM_PAYLOAD_FILES = Object.freeze(', 1],
    ['export function oemPayloadDir(dir)', 1],
    ['export function resolveOemSourceDir(candidates)', 1],
    ['throw oemPayloadMissingError({ sourceDir, fallbackDirs })', 1],
    ['docker compose exec seek-harness ls -l /usr/local/share/cua-vm/windows-oem/', 1],
    ['--build-arg WITH_VIRGL_QEMU=1', 1],
    ['docker compose -f compose.windows.yaml up -d --force-recreate', 1],
    // frames and input over QMP
    ["execute: 'screendump'", 1],
    ["execute: 'input-send-event'", 1],
    ["execute: 'system_powerdown'", 1],
    ["execute: 'quit'", 1],
    ['export function charToKey(char)', 1],
    ['export function generatePassword()', 1],
    ['export function frameSpace(png)', 1],
    ['export function windowsEnabled()', 1],
    // M8: virgl when the build has it, plain virtio-gpu otherwise.
    ['virtio-gpu-gl-pci', 1],
    ['egl-headless,rendernode=', 1],
    // F1: QEMU'S OWN STDERR IS CAPTURED. `-serial file:` is the GUEST console;
    // a QEMU that dies during init explains itself on stderr, which used to be
    // `stdio: 'ignore'` — the user's dead create then left no diagnosis on the
    // host at all. The fd goes to the child, and the path is a store file.
    ["qemuStderr: path.join(dir, 'qemu-stderr.log')", 1],
    ["const stderrFd = openSync(stderrFile, 'w')", 1],
    ["spawn(WINDOWS_QEMU, argv, { stdio: ['ignore', stderrFd, stderrFd], detached: true })", 1],
    ['export function qemuStderrExcerpt(stderr, lines = 20)', 1],
    ['export function qemuStderrReason(stderr)', 1],
    // F2: A DEAD INIT IS A FAILED START, DECIDED INSIDE THE SHORT WINDOW.
    ['export async function waitForQemuBoot({ child, pidFile, isAlive, windowMs = 15000, pollMs = 50 } = {})', 1],
    ['export function qemuBootWindowMs()', 1],
    ["DSH_CUA_WINDOWS_BOOT_SETTLE_MS", 1],
    // N1: UNSET IS NOT ZERO. `Number(env ?? '')` made an unset variable 0 and
    // `0 >= 0` accepted it, so the 15000 fallback was unreachable and the boot
    // window was 0 ms on every real host. The raw string is inspected first.
    ['const raw = process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS', 1],
    ["if (raw !== undefined && raw !== '') {", 1],
    ["if (pid > 0) {", 1],
    ["reason: pidFileInvalid ? 'pidfile-invalid' : 'timeout'", 1],
    ['export function qemuInitError(', 1],
    ["code: 'QEMU_INIT_FAILED'", 1],
    // F3: THE DISPLAY MAY DEGRADE; THE ACCELERATOR MAY NOT. The retry is the
    // gpu:false argv shape (plain VGA + -display none), it happens ONCE, and
    // the warning is a row-carried object with a stable code.
    ['export function classifyQemuInitFailure(stderr)', 1],
    ['hardware acceleration is not supported', 1],
    ["const canFallback = allowGpuFallback && first.display !== 'none' && kind !== 'kvm' && kind !== 'none'", 1],
    ['await attempt({ ...spec, gpu: false, virgl: false }', 1],
    ["code: 'gpu-fallback'", 1],
    ['virgl/EGL display unavailable on this host', 1],
    ['emulated VGA/WARP', 1],
    ['gpuFallback: true', 1],
    // The retry needs a LIVE TPM: the cleanup stopped swtpm when the first QEMU
    // exited, so a retry without restarting it dies on "Failed to connect to
    // socket" — a second failure that would look like the fallback itself.
    ['swtpm did not restart for the GPU-less retry', 1],
    // The watchdog asks the CHILD whether it exited, so "pidfile not written
    // YET" is never mistaken for "never".
    ['function childState(name)', 1],
    // F4: THE SENTENCE HAS TWO HONEST HEADLINES AND NO RAW FIELD.
    ['export function formatWindowsInstallDetail(', 1],
    ['QEMU not alive (see qemu-stderr.log tail)', 1],
    ['waiting for SSH on 127.0.0.1:', 1],
    ["return text.replace(/\\bundefined\\b/gu, 'unknown')", 1],
    // B2: the readiness probe resolves the ROW's port shape, and QMP has three
    // named states instead of an empty string that the panel read as "not
    // running". A live install must never be reported as dead.
    ['const qmp = !alive ? \'no qemu\' : status === \'\' ? \'not answering\' : status', 1],
    ['const ports = windowsPortsOf(spec)', 1],
    ['export function windowsPortsOf(spec)', 1],
    // K1: the controller appears in the argv list before the device that uses it
    // (the ORDER is asserted separately, below).
    ["'-device', 'qemu-xhci,id=xhci'", 1],
    // F2: A SHUTDOWN THE GUEST CAN ACTUALLY HONOUR.
    //
    // * A PAUSED machine does not run its ACPI handler, so `system_powerdown`
    //   was accepted and then nothing happened for the whole 120 s timeout.
    //   `cont` FIRST is the fix, and the ORDER is asserted semantically below.
    ['await qmpFor(spec, [{ execute: \'cont\' }], { timeoutMs: 5000 })', 1],
    ['const paused = state.status === \'paused\' || state.status === \'suspended\'', 1],
    // * A MID-INSTALL WinPE has no ACPI handler either: it gets a SHORT window
    //   and then `quit`, and the result says so, so the supervisor persists
    //   `mayBeTorn` instead of recording a clean restore point from a
    //   half-written disk.
    ['const installInProgress = rowState === \'installing\' || rowState === \'booting\'', 1],
    ['function installShutdownWindowMs()', 1],
    ['return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 30000) : 5000', 1],
    ['const waitMs = installInProgress ? installShutdownWindowMs() : Math.max(1000, timeoutMs)', 1],
    ['...(installInProgress ? { forced: true } : {})', 1],
    ['forced: true, installInProgress', 1],
    // D2: THE INSTALL MEDIA LEAVE THE RUNNING SESSION. The CD is `eject`ed and
    // the usb-storage stick is `device_del`ed at the READY transition, so a
    // finished computer shows only its system disk. The device id is explicit in
    // the argv because `device_del` addresses the QOM frontend, not the block
    // node; both names share one constant so the two namespaces cannot drift.
    ['export const INSTALL_MEDIA_DEVICE_IDS = Object.freeze({ cd: \'cd0\', setup: \'setup0\', setupDevice: \'setupusb\' })', 1],
    ['async function detachInstallMedia(rawSpec)', 1],
    ['await qmpFor(spec, [command], { timeoutMs: 5000 })', 1],
    ["execute: 'eject'", 1],
    ["execute: 'device_del'", 1],
    ['detachInstallMedia,', 1],
    // D3/D5: THE BOOT-FROM-HD SIGNAL AND THE TWO EXACT SENTENCES. The watcher's
    // deadline follows the stage, so "installed but SSH missing" can no longer
    // be reported as "the install did not finish".
    ['export const WINDOWS_HD_BOOT_PATTERN', 1],
    ['export function windowsBootedFromDisk(serialText)', 1],
    ['export function windowsInstallStageFromSerial(serialText)', 1],
    ['export const WINDOWS_BOOTED_DETAIL', 1],
    ['export const WINDOWS_SSH_MISSING_DETAIL', 1],
    ['export const WINDOWS_SSH_MISSING_MINUTES = 5', 1],
    // D1/H1: $OEM$ IS INERT WITHOUT THIS. Both the element and the assertion
    // that refuses a staged answer file without it (the reported WSH dialog).
    ['export function assertAnswerFileUsesConfigurationSet(xml)', 1],
    ['assertAnswerFileUsesConfigurationSet(stagedXml)', 1],
    ['export function assertAnswerFileFirstbootLayers(xml)', 1],
    ['assertAnswerFileFirstbootLayers(stagedXml)', 1],
    ['export const FIRSTBOOT_FALLBACK_COMMAND', 1]
  ],
  winMcp: [
    ['export function windowsMcpEnabled()', 1],
    ["String(process.env.DSH_CUA_VM_WIN_MCP ?? '1') !== '0'", 1],
    ['export function sshArgv(', 1],
    ["'notifications/initialized'", 1],
    ["request('tools/list'", 1],
    ["request('tools/call'", 1],
    ['dsh_cua.server', 1],
    ['--stdio', 1],
    // U3: THE PIPE FLAG IS GONE FROM THE COMMAND. It named a listener upstream
    // does not implement; the documented consequence (one stdio server PER SSH
    // session, no shareable session-2 server yet) is what replaced it.
    ["'python -m dsh_cua.server --stdio'", 1],
    ['U3: THERE IS NO NAMED PIPE', 1],
    ['ONE shared session-2 server cannot be reached', 1]
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
    ['<AutoLogon>', 1],
    // S3: the key block is a placeholder; evaluation media leave it empty.
    ['{{PRODUCT_KEY}}', 1],
    // F2: THE EDITION IS NAMED. The placeholder must stay INSIDE <OSImage> and
    // BEFORE <InstallTo> (schema order), and writeOemPayload replaces it with
    // the <InstallFrom> block (or the staged file is refused, see the F2
    // semantic check).
    ['<OSImage>\n          <!-- F2: WITHOUT THIS, SETUP ASKS WHICH EDITION.', 1],
    ['{{IMAGE_INSTALL}}', 1],
    ['<InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>', 1],
    // S4: FirstLogonCommands uses the hidden launcher, not a bare powershell.
    ['wscript //nologo C:\\Windows\\Setup\\Scripts\\Unattend.vbs', 1],
    // D1/H1: THE SWITCH THAT MAKES $OEM$ MEAN SOMETHING. Without it Setup never
    // copies $OEM$\$$\Setup\Scripts into C:\Windows\Setup\Scripts, the
    // FirstLogonCommand above points at a missing Unattend.vbs, and the desktop
    // shows "Windows Script Host — Can not find script file".
    ['<UseConfigurationSet>true</UseConfigurationSet>', 1],
    // D1/H2: THE BELT. A first-logon fallback that scans drive roots for the
    // script, so a failed $OEM$ copy does not cost the computer its OpenSSH.
    ['for %d in (c d e f g h) do @if exist "%d:\\cua-firstboot.ps1"', 1],
    ['powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%d:\\cua-firstboot.ps1"', 1]
  ],
  oemSetup: [
    ['cua-firstboot.ps1', 1],
    ['Unattend.vbs', 1],
    ['wscript //nologo', 1],
    ['setupcomplete exit', 1],
    // S4: exit passthrough, not a hardcoded success.
    ['exit /b %CUA_EXIT%', 1]
  ],
  oemLauncher: [
    // S4: hidden window style (0) + wait (True) + exit passthrough.
    ['CreateObject("WScript.Shell")', 1],
    ['0, _', 1],
    ['True)', 1],
    ['WScript.Quit exitCode', 1],
    ['C:\\Windows\\Setup\\Scripts\\cua-firstboot.ps1', 1]
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
    ['an AUDIT marker', 1],
    // U2: THE CLIPBOARD BRIDGE. Two on-demand tasks that run IN THE USER'S
    // SESSION, because that is the only clipboard a human can see (RFB
    // ClientCutText has no guest agent; Set-Clipboard over SSH writes Session
    // 0's clipboard). The flags are the contract: /sc ondemand (only when the
    // supervisor asks), /it (interactive = the user's session), /rl LIMITED
    // (the same token the user's own PowerShell gets).
    // The task lines go through a generated .cmd because Windows PowerShell 5.1
    // passes a variable containing spaces to a native program UNQUOTED, so
    // `& schtasks /tr $var` arrived as `/tr powershell.exe ...` and only the
    // executable was registered. The batch file is the documented quoting path.
    ['cua-clip-set`" /sc ondemand /it /rl LIMITED /f /tr', 1],
    ['cua-clip-get`" /sc ondemand /it /rl LIMITED /f /tr', 1],
    ['cmd /c $cmdFile', 1],
    ['Set-Clipboard -Value ([IO.File]::ReadAllText(', 1],
    ["[IO.File]::WriteAllText('C:\\ProgramData\\cua\\clip-read.txt', [string](Get-Clipboard -Raw))", 1],
    ['clip-set.ps1', 1],
    ['clip-get.ps1', 1],
    // U3: THE CONSOLE IS GONE. python.exe always allocates one; pythonw.exe does
    // not, and the task carries -Hidden as well. The `--pipe` argument is gone
    // because upstream `dsh_cua.server main()` has no such option — it named a
    // listener nothing ever created.
    ['pythonw.exe', 2],
    ['New-ScheduledTaskAction -Execute $pyw -Argument', 1],
    ['-Settings $settings -Hidden -Force', 1],
    ['-WindowStyle Hidden', 1],
    ['U3: WHAT USED TO BE WRONG, TWICE', 1],
    ['upstream `dsh_cua.server main()` takes no pipe option', 1]
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
    // the KVM probe ships in BOTH trees (runtime + flat gate tree)
    ['docker/cua-vm-kvm.mjs', 2],
    ['docker/windows-oem/', 1],
    // S1: mtools is a RUNTIME dependency (mformat/mcopy/mdir/mtype), not a build
    // convenience. Without it every Windows create fails at buildSetupImage.
    ['mtools', 2],
    ['docker/windows-oem/Unattend.vbs', 1],
    // K2: THE DESTINATION, not just the source. `docker/windows-oem/` alone is
    // satisfied by a COPY anywhere, including the flat gate tree at
    // /opt/seek-harness/cua-check/ — which is exactly the drift that lets an
    // image build green and then fail the first Windows create with
    // "the OEM payload is missing from this image: /usr/local/share/cua-vm/windows-oem".
    // The destination string is pinned here AND cross-checked against the
    // supervisor's runtime constant in the K2 assertion below.
    ['docker/windows-oem/ /usr/local/share/cua-vm/windows-oem/', 1],
    ['--chmod=0644 docker/windows-oem/', 1],
    // K3: THE DIRECTORY MODE. `--chmod=0644` applies to the directories the COPY
    // CREATES, so the destination arrived `drw-r--r--` and uid 1000 could not
    // traverse a payload that was provably in the image: `ls` said "Permission
    // denied" and writeOemPayload failed on readFileSync (or worse, existsSync
    // reported "missing"). The fix is an explicit 0755 directory created for the
    // runtime uid BEFORE the copy, and the copy itself carrying that ownership.
    // These three needles are the fix; the uid-1000 proof RUN is pinned by K4.
    ['install -d -m 0755 /usr/local/share/cua-vm', 1],
    ['chmod -R a+rX /usr/local/share/cua-vm/windows-oem', 1],
    ['--chown=1000:1000 --chmod=0644 docker/windows-oem/', 1],
    ['install -d -m 0755 /opt/seek-harness/cua-check', 1],
    // K4: THE PROOF RUNS AS THE RUNTIME USER. A needle list cannot say "and a
    // uid-1000 process can traverse it"; this RUN does, for both the runtime path
    // and the fallback tree, and fails the BUILD instead of the first create.
    ['setpriv --reuid=1000 --regid=1000 --clear-groups', 3],
    ['is not traversable by uid 1000', 1],
    ['unreadable by uid 1000', 2],
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
    ['rea: draft.rea', 1],
    // B1: THE PANEL SENDS THE REQUESTED SPEC, and NEVER clamps it in the client.
    // `Math.max(6, draft.memory)` / `Math.max(64, draft.diskGb)` in the create
    // body is what made a 20 GB / 4 GB request arrive as 64 GB / 6 GB.
    ['cpu: draft.cpu,\n                memory: draft.memory,\n                diskGb: draft.diskGb,', 1],
    // B3: THE INSTALLING ROW SHOWS THE PROGRESS PICTURE — elapsed, the serial
    // tail, the readiness signals, and how the user knows it finished.
    ["api('windowsStatus'", 1],
    ['const serialTail = Array.isArray(info?.serialTail)', 1],
    ['elapsed ${elapsed} min of', 1],
    ['watching: ${(readiness.signals ?? []).join', 1],
    ['badge flips to Ready when readiness answers', 1],
    ['serialTail.join', 1],
    // B3: no-install-lines case is stated, not silently blank.
    ['Serial log: no lines yet', 1],
    // ADD-ON: FORCE DELETE affordance, with the destructive confirmation copy.
    ["h('button', {", 1],
    ['Force delete', 2],
    ['This kills the VM process and removes its disks even if the delete reported failures', 1],
    ['api(\'delete\', { name, force: true })', 1],
    // ...and a STUCK windows install says why the normal delete is not enough.
    ['This install is marked installing but QEMU is not running', 1],
    // F4: THE PANEL AFFORDANCES.
    //
    // * Shutdown/Suspend are offered for an INSTALLING Windows row too — with a
    //   confirm that says it aborts the install (hiding them left Force delete
    //   as the only way out of a 40-minute install).
    ['(ready || (windows && installing)) && h(\'button\'', 2],
    ['THIS ABORTS THE WINDOWS INSTALL', 1],
    ['Mid-install this PAUSES Windows Setup', 1],
    // * The wait is VISIBLE: a one-second ticker plus the row's own state, so a
    //   120 s ACPI wait no longer looks like a hung button.
    ['setWaitTick((value) => value + 1)', 1],
    ["const withWait = (text) => (waitedSec > 0 ? `${text} ${waitedSec}s` : text)", 1],
    ['Waiting for ${name} to power off', 1],
    // * The result is SURFACED: a mayBeTorn answer and the supervisor's own
    //   detail sentence reach the note instead of a silent success.
    ['payload?.mayBeTorn === true', 1],
    // U1: HIDE IS A CLEAR. The button toggles (the label already followed the
    // state, the click did not), the secret state is deletable, and the reveal
    // note no longer carries the password.
    ["onClick: () => (secret[name] ? hidePassword(name) : void revealPassword(name))", 1],
    ['const hidePassword = (name) => {', 1],
    ['setSecret((current) => hideSecretEntry(current, name))', 1],
    ['function hideSecretEntry(current, name) {', 1],
    ['delete next[name]', 1],
    ['function noteAfterHide(note, name, value) {', 1],
    ['password revealed below', 1],
    ['module.exports.__test', 1],
    // U3: THE BUTTON IS NOT A TERMINAL. A one-shot exec form labelled
    // "Terminal" promised a shell; there is no pty on either backend.
    ["}, 'Run command'),", 1],
    ['Not an interactive terminal: there is no pty', 1],
    ['ONE command (sh -c on Linux, cmd.exe on Windows)', 1],
    // U2: THE CLIPBOARD SECTION (the only clipboard path that works here).
    ["h('div', { style: { ...S.muted, fontWeight: 600 } }, 'Clipboard')", 1],
    ["'Paste to guest'", 1],
    ["'Read guest clipboard'", 1],
    ["api('windowsClipboardSet'", 1],
    ["api('windowsClipboardGet'", 1],
    ['there is no clipboard agent in the guest', 1],
    // U4: the MEASURED free space joins the spec line, with the warning visible.
    ["api('windowsFreeSpace'", 1],
    ['${space.line}', 1],
    ['space.belowFloor === true', 1]
  ],
  index: [
    ["name: 'cua_vm_start'", 1],
    ["name: 'cua_vm_shutdown'", 1],
    ["name: 'cua_vm_gc'", 1],
    ["name: 'cua_vm_doctor'", 1],
    ["op: 'vmWindowsCreate'", 1],
    ["op: 'vmGc'", 1],
    ["op: 'vmDoctor'", 1],
    // F1: THE `/cua` SWITCH ANSWERS `suspend`. Shutdown, stop and gc had cases;
    // `suspend` did not, so the panel's Suspend button fell through to
    // `default` and answered 404 "unknown action: suspend" — a plugin-dispatch
    // gap the tool (`cua_vm_suspend`) never hit because it calls the supervisor
    // directly. The case must send the SAME op name the tool does.
    ["case 'suspend': return send(200, { ok: true, ...(await call({ op: 'suspend', ...(await body()) })) })", 1],
    ["const result = await call({ op: 'suspend', name: args.name })", 1],
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
    // ADD-ON: FORCE DELETE on the tool surface — the param, the confirmation
    // rule (destructive: ask first), and the honest report when items survive.
    ["force: { type: 'boolean'", 1],
    ['force: args.force === true', 1],
    ['Call cua_vm_destroy again with force: true', 1],
    // B3: `cua_vm_status` polls a Windows install so an agent reads the same
    // sentence as a human (elapsed, serial tail, readiness).
    ["op: 'vmWindowsStatus', name, tail: 5", 1],
    ['serial (last ${info.serialTail.length})', 1],
    // U2/U4: the /cua switch forwards the three new calls, and the op names are
    // the supervisor's (so the panel and the model cannot drift).
    ["case 'windowsClipboardSet': return send(200, { ok: true, ...(await call({ op: 'vmWindowsClipboardSet'", 1],
    ["case 'windowsClipboardGet': return send(200, { ok: true, ...(await call({ op: 'vmWindowsClipboardGet'", 1],
    ["case 'windowsFreeSpace': return send(200, { ok: true, ...(await call({ op: 'vmWindowsFreeSpace'", 1],
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
    // K10: the DEVICE is not the ACCESS. The overlay must pass the gid too, or
    // the node is mounted and uid 1000 still cannot open it.
    ['- "${KVM_GID:-kvm}"', 1],
    ['- /dev/dri', 1],
    ['DSH_CUA_VM_WINDOWS: "${DSH_CUA_VM_WINDOWS:-1}"', 1],
    ['DSH_CUA_WINDOWS_QEMU:', 1],
    ['DSH_CUA_WINDOWS_VIRTIO_ISO:', 1],
    ['DSH_CUA_VM_WIN_MCP:', 1],
    // SLIRP and the store layout are the documented contract
    ['10.0.2.2', 2],
    ['/cua-vm/windows/<name>/', 1],
    ['/cua-vm/iso/', 1],
    ['No second container engine', 1]
  ],
  env: [
    ['DSH_CUA_VM_WINDOWS=0', 1],
    // K10: the mounted-but-denied fix, with the host command that produces it.
    ['KVM_GID', 1],
    ['stat -c %g /dev/kvm', 1],
    ['group_add: ["${KVM_GID:-kvm}"]', 1],
    ['DSH_CUA_VM_GPU=', 1],
    ['DSH_CUA_VM_RESOLUTION_ALLOW_SCALE=', 1],
    ['DSH_CUA_VM_LEGACY_STOP=', 1],
    // R1/R5: the two new Windows knobs are documented where an operator looks,
    // next to the OEM payload path they belong to.
    ['DSH_CUA_WINDOWS_CDBOOT_KEYS_MS=1500,3500,5500', 1],
    ['DSH_CUA_WINDOWS_CDBOOT_KEYS=0', 1],
    ['startup.nsh', 1]
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
  },
  {
    key: 'windows',
    pattern: "kvm: exists('/dev/kvm')",
    reason: 'isFile() is FALSE for a character device: that probe reported a mounted /dev/kvm as absent and sent the user to add a device they already had (the GID is the real fix)'
  },
  {
    key: 'supervisor',
    pattern: 'kvmUsable: kvm.startsWith',
    reason: 'the doctor derived "usable" from the mode STRING, so a device uid 1000 cannot open read as usable; kvmDoctorFacts reports the probe\'s own observation'
  },
  {
    key: 'windows',
    pattern: "stdio: 'ignore', detached: true })\n      children.set(`qemu:",
    reason: 'QEMU stderr must go to $STORE/windows/<name>/qemu-stderr.log: `stdio: ignore` discarded the only diagnosis an init failure produces (the reported dead create left nothing on the host)'
  },
  {
    key: 'supervisor',
    pattern: "${verdict.endpoint === 'none' ? 'no SSH yet' : `${verdict.endpoint} answering`}",
    reason: 'the raw endpoint interpolated as "undefined answering": the progress sentence is built by formatWindowsInstallDetail, which never prints a raw field'
  },
  {
    key: 'supervisor',
    pattern: 'does not fit the VM store quota',
    reason: 'the create-time quota counts REAL bytes: a sparse virtual disk is never refused, it carries a disk-over-policy warning (the offending sentence refused every Windows create on a 15 GB policy)'
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
    // L1: CASE-INSENSITIVE. `dind`, `DinD` and `DIND` are the same regression,
    // and the first version only caught the lowercase spelling.
    if (text.toLowerCase().includes(rule.pattern.toLowerCase())) {
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

/**
 * LAYOUT. `--root` is either a checkout (docker/, plugins/, tools/, tests/) or
 * the FLAT directory the image assembles under /opt/seek-harness/cua-check/.
 * The discriminators are repo-only paths that the image never copies: `tools/`
 * holds this gate itself. Anything asserted about the CHECKOUT is gated on this
 * flag instead of being skipped whenever a file happens to be absent, so
 * deleting tests/ from a checkout still fails the gate.
 */
const REPO_LAYOUT = existsSync(path.join(ROOT, 'tools')) || existsSync(path.join(ROOT, '.git'))

/** One of the files an assertion needs, or null — never an unhandled ENOENT. */
function sourceOf(label, name) {
  const file = pick(name)
  if (file === null) {
    console.log(`  FAIL ${label}: file not found`)
    return null
  }
  return readFileSync(file, 'utf8')
}

/** Semantic assertions the needle list cannot express (order, not presence). */
{
  const quietMode = process.argv.includes('--quiet')
  // K1: these used to hardcode ROOT/docker/, which is how a FAILED assertion in
  // the image turned into a truncated stack trace: readFileSync threw before the
  // gate could print its summary, and the build log showed a Node abort instead
  // of "the xhci controller is missing". Resolve through pick(), fail cleanly.
  const windowsSource = sourceOf('K1', 'cua-vm-windows-qemu.mjs')
  total += 1
  if (windowsSource === null) {
    failures += 1
    missing.push('docker/cua-vm-windows-qemu.mjs: file not found (K1 xhci ordering cannot be checked)')
  } else {
    // S1/S2: DISK ORDER IS THE CONTRACT. The system qcow2 is attached on ide.0
    // and setup.img's block node is declared AFTER it (its usb-storage device
    // follows the xHCI controller), so Windows Setup sees the qcow2 as Disk 0 —
    // the disk Autounattend.xml's <DiskID>0</DiskID> targets. This is an ORDER
    // assertion, not a presence one: reordering the argv silently partitions the
    // answer medium instead.
    const diskAttach = windowsSource.indexOf('ide-hd,drive=disk0,bus=ide.0')
    const setupDrive = windowsSource.indexOf('id=setup0')
    const setupAttach = windowsSource.indexOf('usb-storage,drive=setup0,removable=on')
    const xhciAttach = windowsSource.indexOf('qemu-xhci,id=xhci')
    const noUsbStick = !/usb-storage,drive=oem0/u.test(windowsSource) && !/file=fat:ro:/u.test(windowsSource)
    const setupAfterDisk = diskAttach !== -1 && setupDrive !== -1 && setupAttach !== -1
      && diskAttach < setupDrive && xhciAttach !== -1 && xhciAttach < setupAttach
    // F1/M9: NO READ-ONLY BLOCK NODE ON AN ide-hd. QEMU 10 refuses
    // `-device ide-hd,drive=setup0`: "Block node is read-only", and the create
    // then cascades into "swtpm did not create its socket". The setup drive
    // line must not carry readonly/read-only, and the old OEM stick string
    // (`read-only=on,if=none,id=oem0`) must never come back either.
    const setupWritable = !/[^\n]*read-?only[^\n]*id=setup0/iu.test(windowsSource)
      && !/id=setup0[^\n]*read-?only/iu.test(windowsSource)
      && !/drive=setup0[^\n]*read-?only/iu.test(windowsSource)
      && !/id=oem0[^\n]*read-?only/iu.test(windowsSource)
      // F1: the ATTACH SHAPE is part of the contract now: removable media, and
      // never the old fixed-disk argv literal (a fixed-disk root is not scanned
      // for Autounattend.xml). Matched as the ARGV literal, not the words, so a
      // comment may still quote the historical failure.
      && !/'ide-hd,drive=setup0,bus=ide\.2'/u.test(windowsSource)
      && /usb-storage,drive=setup0,removable=on/u.test(windowsSource)
    if (setupAfterDisk && noUsbStick && setupWritable) {
      if (!quietMode) console.log('  ok   K1 the answer image is attached WRITABLE as a REMOVABLE usb-storage stick (after the system disk, after xhci) and the vvfat OEM stick is gone')
    } else {
      failures += 1
      missing.push('docker/cua-vm-windows-qemu.mjs: setup.img must attach WRITABLE (no readonly=on) as a REMOVABLE usb-storage device (removable=on, bus=xhci.0) declared AFTER disk0 on ide.0 (so the qcow2 is Windows Disk 0 / DiskID 0) and AFTER qemu-xhci; a fixed-disk (ide-hd) setup0 is never scanned by Setup for Autounattend.xml, and no usb-storage/file=fat:ro: OEM stick may remain')
      console.log('  FAIL K1 answer-disk order / writability / no vvfat stick')
    }
  }
  // F2 (shutdown): `cont` BEFORE `system_powerdown`, INSIDE `shutdown`.
  //
  // A needle list can prove both commands exist; only an ORDER assertion proves
  // the paused case is actually fixed. A paused guest ignores ACPI entirely, so
  // a `system_powerdown` that runs first costs the whole 120 s timeout and then
  // ends in `quit` — exactly the reported stall. The `cont` must also live in
  // `shutdown` (not in `unpause`, which the gate cannot tell apart from a needle
  // hit) and must precede the powerdown within that function's body.
  {
    total += 1
    const windows = sourceOf('F2', 'cua-vm-windows-qemu.mjs')
    if (windows === null) {
      failures += 1
      missing.push('docker/cua-vm-windows-qemu.mjs: file not found (F2 shutdown ordering cannot be checked)')
    } else {
      const bodyStart = windows.indexOf('async function shutdown(rawSpec')
      const bodyEnd = bodyStart === -1 ? -1 : windows.indexOf('\n  /** Kill the process', bodyStart)
      const body = bodyStart === -1 ? '' : windows.slice(bodyStart, bodyEnd === -1 ? windows.length : bodyEnd)
      const cont = body.indexOf("execute: 'cont'")
      const power = body.indexOf("execute: 'system_powerdown'")
      const quitOnInstall = body.indexOf('installInProgress')
      const ok = cont !== -1 && power !== -1 && quitOnInstall !== -1 && cont < power
      if (ok) {
        if (!quietMode) console.log('  ok   F2 shutdown continues a PAUSED guest before asking for ACPI, and carries the mid-install classification')
      } else {
        failures += 1
        missing.push('docker/cua-vm-windows-qemu.mjs: inside `shutdown`, the QMP `cont` must precede `system_powerdown` (a paused guest never runs its ACPI handler, so the powerdown is a no-op that burns the full timeout), and the function must classify `installing`/`booting` so a mid-install shutdown is a short window + `quit` + mayBeTorn')
        console.log('  FAIL F2 shutdown ordering / mid-install classification')
      }
    }
  }
  // F3: AN INSTALLING ROW IS NEVER PROMOTED BY THE STATUS POLL.
  //
  // `vmWindowsStatus` must pass `phase: 'install'` exactly when the row says
  // `installing`/`booting` — the same gate the watcher uses. A needle proves the
  // flag exists; this proves it is WIRED TO THE ROW STATE in that function, and
  // that the unconditional `{ ssh: meta.ssh !== false }` call is gone from it.
  {
    total += 1
    const supervisor = sourceOf('F3', 'cua-vm-supervisor.mjs')
    if (supervisor === null) {
      failures += 1
      missing.push('docker/cua-vm-supervisor.mjs: file not found (F3 status-poll promotion cannot be checked)')
    } else {
      const start = supervisor.indexOf('async vmWindowsStatus(')
      const end = start === -1 ? -1 : supervisor.indexOf('  async vmWindowsShutdown(', start)
      const body = start === -1 ? '' : supervisor.slice(start, end === -1 ? supervisor.length : end)
      const wired = /const installPhase = meta\.state === 'installing' \|\| meta\.state === 'booting'/u.test(body)
        && /\.\.\.\(installPhase \? \{ phase: 'install' \} : \{\}\)/u.test(body)
      const unguarded = /windowsBackend\.ready\(meta, \{ ssh: meta\.ssh !== false \}\)/u.test(body)
      const ok = wired && !unguarded
      if (ok) {
        if (!quietMode) console.log('  ok   F3 vmWindowsStatus gates readiness on the row state, so a Setup screen cannot be promoted to ready')
      } else {
        failures += 1
        missing.push('docker/cua-vm-supervisor.mjs: vmWindowsStatus must pass phase:\'install\' when the row is installing/booting (SSH-only readiness) — the unguarded ready(meta, { ssh }) call took the VNC fallback, promoted a mid-install Setup screen to state:"ready" + installComplete, stopped the watcher and let the idle timer suspend a half-install')
        console.log('  FAIL F3 status-poll promotion gate')
      }
    }
  }
  // F2: THE ANSWER FILE NAMES THE IMAGE, IN SCHEMA ORDER. A needle list can say
  // "InstallFrom exists"; only an ORDER assertion says Setup reads it before the
  // install target, and only a REAL staged file proves the placeholder was
  // replaced. Both run here: the template's order, and (below, via the exported
  // helpers) the staged shape.
  {
    const answer = sourceOf('F2', 'Autounattend.xml')
    total += 1
    if (answer === null) {
      failures += 1
      missing.push('docker/windows-oem/Autounattend.xml: file not found (F2 InstallFrom cannot be checked)')
    } else {
      // Comments are stripped first: the template EXPLAINS the ordering in an
      // XML comment that names both elements, and a raw indexOf would find the
      // prose instead of the elements. The placeholder is also named in the
      // header's substitution table, so the one that matters is the first after
      // <OSImage>.
      const bare = answer.replace(/<!--[\s\S]*?-->/gu, '')
      const osImage = bare.indexOf('<OSImage>')
      const installFrom = osImage === -1 ? -1 : bare.indexOf('{{IMAGE_INSTALL}}', osImage)
      const installTo = bare.indexOf('<InstallTo>')
      const ok = osImage !== -1 && installFrom !== -1 && installTo !== -1 && osImage < installFrom && installFrom < installTo
      if (ok) {
        if (!quietMode) console.log('  ok   F2 the answer template names the edition (<InstallFrom>) inside <OSImage>, before <InstallTo>')
      } else {
        failures += 1
        missing.push('docker/windows-oem/Autounattend.xml: {{IMAGE_INSTALL}} must sit inside <OSImage> BEFORE <InstallTo> (schema order) — without it Setup stops at "Select the operating system you want to install"')
        console.log('  FAIL F2 InstallFrom placement in the answer template')
      }
    }
  }
  // D2/D3: THE CALLS MUST BE ON THE READY PATH, NOT MERELY PRESENT. A needle
  // cannot say "this runs when the row becomes ready"; only the surrounding
  // text can. Both the watcher's stop branch and the status poll's transition
  // are checked, because either can be the first to observe `ready`.
  {
    const supervisor = sourceOf('D2', 'cua-vm-supervisor.mjs')
    total += 1
    if (supervisor === null) {
      failures += 1
      missing.push('docker/cua-vm-supervisor.mjs: file not found (D2 ready-transition wiring cannot be checked)')
    } else {
      const watcherStart = supervisor.indexOf('function watchWindowsInstall(name)')
      const watcherEnd = watcherStart === -1 ? -1 : supervisor.indexOf('\n}\n', supervisor.indexOf('WINDOWS_WATCHING.delete(name)', watcherStart))
      const watcher = watcherStart === -1 || watcherEnd === -1 ? '' : supervisor.slice(watcherStart, watcherEnd)
      const watcherWired = /if \(decision\.ready\) await detachWindowsInstallMedia\(name\)/u.test(watcher)
        && /const overDeadline = bootedStage \? bootedMinutes > sshGraceMinutes : elapsedMinutes > timeoutMinutes/u.test(watcher)
      const statusStart = supervisor.indexOf('async vmWindowsStatus(')
      const statusEnd = statusStart === -1 ? -1 : supervisor.indexOf('  async vmWindowsLogs(', statusStart)
      const status = statusStart === -1 || statusEnd === -1 ? '' : supervisor.slice(statusStart, statusEnd)
      const statusWired = /if \(state === 'ready'\) await detachWindowsInstallMedia\(name\)/u.test(status)
      const ok = watcherWired && statusWired
      if (ok) {
        if (!quietMode) console.log('  ok   D2/D3 the ready transition ejects the media (watcher + status) and the deadline follows the boot stage')
      } else {
        failures += 1
        missing.push(`docker/cua-vm-supervisor.mjs: detachWindowsInstallMedia() must run on the READY transition in BOTH the watcher and vmWindowsStatus, and the watcher's deadline must be 'bootedStage ? bootedMinutes > sshGraceMinutes : elapsedMinutes > timeoutMinutes' (watcher=${watcherWired} status=${statusWired}) — otherwise a desktop stays attached to D: and a successful install still times out at 60 minutes`)
        console.log('  FAIL D2/D3 ready-transition wiring')
      }
    }
  }
  // D1/H1: $OEM$ IS ONLY COPIED WHEN THE ANSWER FILE ASKS FOR IT, AND THE ASK
  // MUST BE IN THE RIGHT COMPONENT. A needle can prove the element exists; only
  // a POSITION assertion proves Setup will read it as part of
  // Microsoft-Windows-Setup in the windowsPE pass. Without it Windows ignores
  // C:\$OEM$ and the desktop shows "Windows Script Host — Can not find script
  // file C:\Windows\Setup\Scripts\Unattend.vbs" (the reported D1).
  {
    const answer = sourceOf('D1', 'Autounattend.xml')
    total += 1
    if (answer === null) {
      failures += 1
      missing.push('docker/windows-oem/Autounattend.xml: file not found (D1 UseConfigurationSet cannot be checked)')
    } else {
      // Comments are stripped: the template EXPLAINS the switch in a comment
      // that names the element, so a raw search would match our own prose.
      const bare = answer.replace(/<!--[\s\S]*?-->/gu, '')
      const peStart = bare.indexOf('<settings pass="windowsPE">')
      const peEnd = peStart === -1 ? -1 : bare.indexOf('</settings>', peStart)
      const pe = peStart === -1 || peEnd === -1 ? '' : bare.slice(peStart, peEnd)
      const setupStart = pe.indexOf('<component name="Microsoft-Windows-Setup"')
      const setupEnd = setupStart === -1 ? -1 : pe.indexOf('</component>', setupStart)
      const component = setupStart === -1 || setupEnd === -1 ? '' : pe.slice(setupStart, setupEnd)
      const switchAt = component.indexOf('<UseConfigurationSet>true</UseConfigurationSet>')
      const userDataAt = component.indexOf('<UserData>')
      const count = (component.match(/<UseConfigurationSet\b/gu) ?? []).length
      const ok = switchAt !== -1 && count === 1 && (userDataAt === -1 || switchAt < userDataAt)
      if (ok) {
        if (!quietMode) console.log('  ok   D1 <UseConfigurationSet>true</UseConfigurationSet> sits in the windowsPE Microsoft-Windows-Setup component (exactly once, before <UserData>)')
      } else {
        failures += 1
        missing.push(`docker/windows-oem/Autounattend.xml: <UseConfigurationSet>true</UseConfigurationSet> must appear EXACTLY ONCE inside the windowsPE Microsoft-Windows-Setup component and before <UserData> (found at ${switchAt}, count ${count}) — without it Setup never copies $OEM$ into C:\\Windows\\Setup\\Scripts and firstboot never runs, which is the reported "Can not find script file ...Unattend.vbs"`)
        console.log('  FAIL D1 UseConfigurationSet placement')
      }
    }
  }
  // D1/H2: THE FIRSTBOOT FALLBACK. The primary launcher depends on the $OEM$
  // copy; the fallback scans drive roots for cua-firstboot.ps1. Only a position
  // assertion can prove BOTH live under FirstLogonCommands as separate commands.
  {
    const answer = sourceOf('D1', 'Autounattend.xml')
    total += 1
    if (answer === null) {
      failures += 1
      missing.push('docker/windows-oem/Autounattend.xml: file not found (D1 firstboot fallback cannot be checked)')
    } else {
      const bare = answer.replace(/<!--[\s\S]*?-->/gu, '')
      const start = bare.indexOf('<FirstLogonCommands>')
      const end = start === -1 ? -1 : bare.indexOf('</FirstLogonCommands>', start)
      const block = start === -1 || end === -1 ? '' : bare.slice(start, end)
      const launcher = /wscript \/\/nologo C:\\Windows\\Setup\\Scripts\\Unattend\.vbs/u.test(block)
      const fallback = /for %d in \(c d e f g h\) do @if exist "%d:\\cua-firstboot\.ps1"/u.test(block)
      const orders = [...block.matchAll(/<Order>(\d+)<\/Order>/gu)].map((match) => Number(match[1]))
      const ok = launcher && fallback && orders.length >= 2 && orders[0] < orders[1]
      if (ok) {
        if (!quietMode) console.log('  ok   D1 both firstboot layers are FirstLogonCommands: the $OEM$ Unattend.vbs launcher AND the drive-scanning fallback')
      } else {
        failures += 1
        missing.push('docker/windows-oem/Autounattend.xml: FirstLogonCommands must carry BOTH the $OEM$ launcher (wscript ... Unattend.vbs) and the drive-scanning fallback (`for %d in (c d e f g h) do @if exist "%d:\\cua-firstboot.ps1" powershell.exe ...`) as ordered commands — one copy failure must not cost the computer its OpenSSH')
        console.log('  FAIL D1 firstboot fallback layer')
      }
    }
  }
  // F1: THE MEDIUM IS A DISK WINDOWS CAN ENUMERATE. The gate cannot build a
  // 64 MiB image, but it can refuse the exact regression: any mtools call that
  // addresses setup.img WITHOUT the partition offset is back to the
  // partitionless superfloppy the firmware mounted and Windows ignored.
  {
    const windows = sourceOf('F1', 'cua-vm-windows-qemu.mjs')
    total += 1
    if (windows === null) {
      failures += 1
      missing.push('docker/cua-vm-windows-qemu.mjs: file not found (F1 partition checks cannot run)')
    } else {
      const direct = [...windows.matchAll(/execFileSync\(MTOOLS\.(?:dir|type), \['-i', ([^,]+),/gu)].map((m) => m[1].trim())
      const bad = direct.filter((target) => target !== 'volume')
      const mbr = /writeSetupMbr\(p\.setupImg\)/u.test(windows)
        && /readSetupMbr\(p\.setupImg\)/u.test(windows)
      if (bad.length === 0 && mbr) {
        if (!quietMode) console.log('  ok   F1 every setup.img read goes through the partition offset and the MBR is written + read back')
      } else {
        failures += 1
        missing.push(`docker/cua-vm-windows-qemu.mjs: setup.img mtools reads must use the partition volume (found ${bad.length} on ${bad.join(', ') || 'none'}) and the build must write AND read back the MBR — a partitionless image is never mounted by Windows`)
        console.log('  FAIL F1 partitioned answer medium')
      }
    }
  }
  // K2: THE OEM PATH AGREEMENT. The supervisor resolves the payload from one
  // string; the Dockerfile COPY decides where it lands. Nothing in the language
  // ties them together, and the failure mode is a green build followed by a red
  // create: "the OEM payload is missing from this image: <path>" (CI run
  // 43736227888 shipped exactly this shape). Parse both, fail on any difference,
  // and say which side moved.
  {
    const supervisor = sourceOf('K2', 'cua-vm-supervisor.mjs')
    const dockerfile = sourceOf('K2', 'Dockerfile')
    total += 1
    if (supervisor === null || dockerfile === null) {
      failures += 1
      missing.push('K2: the Dockerfile and docker/cua-vm-supervisor.mjs are both needed to prove the OEM COPY destination matches the runtime path')
      console.log('  FAIL K2 OEM path agreement (missing file)')
    } else {
      const runtime = /DSH_CUA_WINDOWS_OEM_DIR\s*\|\|\s*'([^']+)'/u.exec(supervisor)?.[1] ?? null
      // The LAST token of the COPY line is the destination; the source list is
      // every token after --chmod=… that starts with docker/.
      const copyLines = dockerfile.split('\n').filter((line) => /^\s*COPY\b/u.test(line) && line.includes('windows-oem/'))
      // Every destination those COPYs write to (the last token, minus the
      // sources). The flat gate tree is one of them and is NOT the runtime path,
      // so the assertion is "the runtime path is among them", not "the only one".
      const destinations = copyLines
        .map((line) => line.trim().split(/\s+/u).at(-1))
        .filter((target) => typeof target === 'string' && !target.startsWith('docker/'))
      // `cp -a`-style: the destination may or may not end in a slash; Docker
      // treats `dir/ /d/` and `dir/ /d` the same, so compare normalised.
      const norm = (value) => (value === null ? null : value.replace(/\/+$/u, ''))
      const agrees = runtime !== null && destinations.some((target) => norm(target) === norm(runtime))
      if (agrees) {
        if (!quietMode) console.log(`  ok   K2 the Dockerfile copies the OEM payload to the path the supervisor reads (${norm(runtime)})`)
      } else {
        failures += 1
        missing.push(`K2: no COPY writes the OEM payload to the supervisor's DSH_CUA_WINDOWS_OEM_DIR default (${runtime ?? 'constant not found'}); destinations found: ${destinations.join(', ') || 'none'} — otherwise the image builds green and every Windows create fails with "the OEM payload is missing from this image"`)
        console.log('  FAIL K2 OEM path agreement')
      }
    }
  }
  // K6: EACCES IS NOT "MISSING". The module must classify a denied directory as
  // a PERMISSION defect (its own error, naming the mode/owner and the fix) rather
  // than falling through to the pull-a-newer-image text — the two are
  // indistinguishable to existsSync, which is exactly how a permissions bug
  // shipped reading like a missing-payload bug.
  {
    const windows = sourceOf('K6', 'cua-vm-windows-qemu.mjs')
    total += 1
    if (windows === null) {
      failures += 1
      missing.push('K6: docker/cua-vm-windows-qemu.mjs is needed to check the EACCES classification')
      console.log('  FAIL K6 OEM permission classification (missing file)')
    } else if (
      /export function oemPayloadDirStatus\(dir\)/u.test(windows)
      && /export function oemPayloadDeniedDir\(candidates\)/u.test(windows)
      && /export function oemPayloadDeniedError\(\{ sourceDir, denied, deniedDir, fallbackDirs \}\)/u.test(windows)
      && /code === 'EACCES' \|\| code === 'EPERM'/u.test(windows)
      && /const deniedDir = oemPayloadDeniedDir\(candidates\)/u.test(windows)
      && /IMAGE PERMISSIONS defect/u.test(windows)
      && /EACCES traversing \$\{dir\}/u.test(windows)
    ) {
      if (!quietMode) console.log('  ok   K6 a denied OEM directory is reported as a permission defect, not as a missing payload')
    } else {
      failures += 1
      missing.push('K6: the OEM payload resolver must classify EACCES separately (oemPayloadDirStatus / oemPayloadDeniedDir / oemPayloadDeniedError) — a permission bug that reads as "pull a newer image" is the bug this branch fixes')
      console.log('  FAIL K6 OEM permission classification')
    }
  }
  // L5: the runtime suite ships IN the repository (it used to live outside it,
  // so every "pinned by a test" claim pointed at something a reviewer could not
  // open). It is a statement about the CHECKOUT: the image does not ship tests/
  // (and must not pay for them in a layer), so in the flat layout this assertion
  // is out of scope and says so out loud — it is never silently dropped.
  // F1/F2/F3/F4: the boot path has its own suite now (stub QEMU: a dead init, an
  // EGL failure that must degrade once, the watchdog and the sentence).
  const suite = ['supervisor-smoke.mjs', 'modules-unit.mjs', 'qmp-shutdown.mjs', 'windows-boot.mjs']
  if (!REPO_LAYOUT) {
    if (!quietMode) console.log('  n/a  L5 the runtime suite lives in the checkout, not in the flat image check tree')
  } else {
    total += 1
    if (suite.every((file) => existsSync(path.join(ROOT, 'tests', file)))) {
      if (!quietMode) console.log('  ok   L5 the runtime suite is committed under tests/')
    } else {
      failures += 1
      missing.push('tests/: supervisor-smoke.mjs, modules-unit.mjs, qmp-shutdown.mjs and windows-boot.mjs must be committed')
      console.log('  FAIL L5 runtime suite')
    }
  }

  // N3: THE SUITES MUST WITNESS THE **UNSET** SHAPE. Every existing case SET the
  // window (`windows-boot.mjs:94`, `supervisor-smoke.mjs:242`), and a test that
  // supplies a number can never observe the default — which is exactly why the
  // unset→0 defect passed every green run. A semantic assertion (delete the env,
  // not just set it), because "the file exists" cannot express it.
  if (!REPO_LAYOUT) {
    if (!quietMode) console.log('  n/a  N3 the unset-window cases live with the suite in the checkout')
  } else {
    total += 1
    const unitSource = existsSync(path.join(ROOT, 'tests', 'modules-unit.mjs'))
      ? readFileSync(path.join(ROOT, 'tests', 'modules-unit.mjs'), 'utf8')
      : ''
    const smokeSource = existsSync(path.join(ROOT, 'tests', 'supervisor-smoke.mjs'))
      ? readFileSync(path.join(ROOT, 'tests', 'supervisor-smoke.mjs'), 'utf8')
      : ''
    const deletesBoot = /delete process\.env\.DSH_CUA_WINDOWS_BOOT_SETTLE_MS/u.test(unitSource)
    const assertsDefault = /qemuBootWindowMs\(\) === 15000/u.test(unitSource)
    const assertsEarly = /earlyWindow === 5000/u.test(unitSource)
    const explicitZero = /qemuBootWindowMs\(\) === 0/u.test(unitSource)
    // The smoke case must UNSET both variables for the CHILD supervisor, not
    // merely shorten them: that is the production shape of the live failure.
    const smokeUnsets = /delete env\.DSH_CUA_WINDOWS_BOOT_SETTLE_MS/u.test(smokeSource)
      && /delete env\.DSH_CUA_WINDOWS_EARLY_CHECK_MS/u.test(smokeSource)
    const smokeLatePidfile = /exec sleep 120/u.test(smokeSource) && /sleep 0\.1/u.test(smokeSource)
    if (deletesBoot && assertsDefault && assertsEarly && explicitZero && smokeUnsets && smokeLatePidfile) {
      if (!quietMode) console.log('  ok   N3 the suite exercises the UNSET window (not only the overridden one)')
    } else {
      failures += 1
      missing.push('N3: tests/modules-unit.mjs must DELETE the window env and assert unset → 15000 / 5000 (plus an explicit "0" → 0), and tests/supervisor-smoke.mjs must run a supervisor with BOTH windows unset against a stub QEMU that writes its pidfile ~100 ms late — otherwise the unset→0 defect is invisible again')
      console.log('  FAIL N3 unset-window coverage')
    }
  }

  const supervisorSource = sourceOf('M1', 'cua-vm-supervisor.mjs')
  total += 1
  if (supervisorSource === null) {
    failures += 1
    missing.push('docker/cua-vm-supervisor.mjs: file not found (M1 ISO accounting cannot be checked)')
  } else {
    const isoInAccounted = /const ACCOUNTED_PATHS = \(\) => \[[^\]]*ISO_DIR/su.test(supervisorSource)
    if (isoInAccounted) {
      if (!quietMode) console.log('  ok   M1 the ISO cache is part of the accounted store')
    } else {
      failures += 1
      missing.push('docker/cua-vm-supervisor.mjs: ISO_DIR must be in ACCOUNTED_PATHS (the ISO cache is the largest thing in a Windows store)')
      console.log('  FAIL M1 ISO accounting')
    }
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
