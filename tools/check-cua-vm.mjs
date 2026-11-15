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
    path.join(ROOT, 'plugins', 'dsh-cua-vm', name)
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
  windows: { label: 'docker/cua-vm-windows.mjs', name: 'cua-vm-windows.mjs' },
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
    ["withLock('@registry'", 1]
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
  windows: [
    ["export const WINDOWS_IMAGE = process.env.DSH_CUA_WINDOWS_IMAGE || 'dockurr/windows:4.35'", 1],
    ["export const WINDOWS_MIN_MEMORY_GB = 6", 1],
    ["export const WINDOWS_MIN_DISK_GB = 64", 1],
    ["export const WINDOWS_MIN_CPU = 2", 1],
    ["export const WINDOWS_QMP_PORT = 7100", 1],
    ["export const WINDOWS_CONSOLE_PORT = 8006", 1],
    ["export const WINDOWS_RDP_PORT = 3389", 1],
    ["['DISK_FMT', 'qcow2']", 1],
    ["['SHUTDOWN', 'Y']", 1],
    ["['MANUAL', 'N']", 1],
    ["['CPU_CORES', String(spec.cpu)]", 1],
    ["['GPU', spec.gpu ? 'Y' : 'N']", 1],
    ["['VRAM_SIZE', '4G']", 1],
    ["['USERNAME', WINDOWS_USERNAME]", 1],
    ["['PASSWORD', password]", 1],
    ['-device usb-tablet -qmp tcp:0.0.0.0:${WINDOWS_QMP_PORT},server=on,wait=off', 1],
    ["CapAdd: ['NET_ADMIN']", 1],
    ["PathOnHost: '/dev/kvm'", 1],
    ["RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }", 1],
    ["'dsh.cua.vm': spec.name, 'dsh.cua.kind': 'windows'", 1],
    ['export function windowsEnabled()', 1],
    ["String(process.env.DSH_CUA_VM_WINDOWS ?? '1') !== '0'", 1],
    ["execute: 'screendump'", 1],
    ["execute: 'input-send-event'", 1],
    ['export function charToKey(char)', 1],
    ['REA is a Linux kit', 1],
    ['Android is not available for Windows computers', 1],
    // D6: create and start are two requests; a failure between them must not
    // leave a container that holds the name but has no registry row.
    ['(the container was removed)', 2],
    ['?force=1&v=1', 2]
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
    ['docker/cua-vm-windows.mjs', 1],
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
    ['Windows (Docker/DinD)', 1],
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
    ['docker:27-dind', 1],
    ['DOCKER_HOST: "tcp://dind:2375"', 1],
    ['DSH_CUA_VM_WINDOWS: "${DSH_CUA_VM_WINDOWS:-1}"', 1],
    ['- /dev/kvm', 1],
    ['cua-vm:/cua-vm', 1],
    ['RDP', 3],
    ['7100', 1]
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
