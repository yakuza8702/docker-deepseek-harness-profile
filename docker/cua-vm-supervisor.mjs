#!/usr/bin/env node
/**
 * cua-vm-supervisor — the one process that owns QEMU.
 *
 * WHY A SUPERVISOR, AND WHY IT RUNS OUTSIDE THE AGENT'S SANDBOX
 * ------------------------------------------------------------
 * The harness's `workspace-write` sandbox grants read-write only to
 * `/dev/null`, `/tmp` and the workspace root (packages/sandbox/sandbox-local/
 * src/profiles.ts). QEMU opens `/dev/kvm` O_RDWR, so a VM started from the
 * sandboxed shell can never work — and it must not, because the VM store has
 * to live OUTSIDE the workspace (a 1.3 GB base disk plus per-workspace deltas
 * is not something the user wants in their project directory).
 *
 * So the QEMU/daemon lifetime belongs to a process the harness started before
 * any session existed: this one, launched by docker/entrypoint.sh exactly like
 * Xvfb/noVNC/the proxy. The agent-facing tools never touch /dev/kvm, the VM
 * store, or the `cua` binary. They speak newline-delimited JSON over a unix
 * socket in /tmp — which `workspace-write` already allows — and this process
 * does the rest.
 *
 * WHAT IT ENFORCES (because it is the only thing that can)
 * -------------------------------------------------------
 *   * every workspace path is resolved and must stay under CUA_WORKSPACE_ROOT;
 *   * file copies only read from / write to the workspace; the guest side is
 *     free, the host side is not;
 *   * one VM per workspace, named from sha256(workspace)[0:12], so the same
 *     project always comes back to the same computer;
 *   * the store is /cua-vm (a volume), never the workspace;
 *   * CUA_HOME is the volume (`HOME=/cua-vm/home`), because cua keeps images,
 *     QEMU and sandbox state under `$HOME/.cua`.
 *
 * PROTOCOL
 * --------
 *   connect -> write one JSON line -> read one JSON line -> close.
 *   {"op":"ping"}
 *   {"op":"status"}
 *   {"op":"ensure","workspace":"/workspace/proj","tier":"docker","cpu":2,"memory":4}
 *   {"op":"exec","name":"ws-1a2b3c4d5e6f","cmd":"cargo build","cwd":"/work","timeout":600}
 *   {"op":"put","name":"…","local":"dist/app","guest":"/work/app"}
 *   {"op":"get","name":"…","guest":"/work/out.tgz","local":"dist/out.tgz"}
 *   {"op":"port","name":"…","guestPort":8080}
 *   {"op":"suspend"|"resume"|"destroy","name":"…"}
 *
 * ANSWERS are always {"ok":true,…} or {"ok":false,"error":"…"}.
 */

import { createServer, createServer as netCreateServer, connect as netConnect } from 'node:net'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync
} from 'node:fs'
import path from 'node:path'
import { createSpace, formatSpace, formatSpaceWarning, pngSize, relativeToPixels, resolutionProblem, toDisplayPixels, SPACE_CACHE_MS } from './cua-vm-space.mjs'
import {
  createWindowsBackend, windowsEnabled, windowsHostCaps, windowsQmpAdapter,
  WINDOWS_ISO_SOURCES, WINDOWS_VERSIONS, WINDOWS_MIN_MEMORY_GB, WINDOWS_MIN_DISK_GB,
  WINDOWS_MIN_CPU, WINDOWS_DEFAULT_CPU, WINDOWS_DEFAULT_MEMORY_GB, WINDOWS_DEFAULT_DISK_GB,
  WINDOWS_USERNAME, WINDOWS_QEMU, canonicalWindowsVersion, windowsCapacityWarnings,
  windowsPaths, ensureIso, isoTargetPath, writeOemPayload, generatePassword, frameSpace, resolveWindowsIso,
  buildSetupImage, normaliseProductKey, resolveWindowsImageSelection,
  windowsKvmPreflight, windowsPortsOf, windowsTailLines, formatWindowsInstallDetail, windowsReadinessSignals,
  // D3/D5: the post-install boot signal and the two exact sentences. The watcher
  // derives its deadline from windowsBootedFromDisk()'s answer, so the probe and
  // the sentence can never disagree about the stage.
  windowsBootedFromDisk, WINDOWS_SSH_MISSING_DETAIL,
  // R3-adjacent: `qmpStateLabel` / `endpointLabel` are used by the windowsStatus
  // sentences. They were never imported, so every status call that REACHED those
  // lines threw `qmpStateLabel is not defined` — a latent bug that stayed hidden
  // only because the QMP signature mismatch made `probe()` fail earlier.
  qmpStateLabel, endpointLabel,
  qemuStderrExcerpt, qemuStderrReason
} from './cua-vm-windows-qemu.mjs'
import { kvmDoctorFacts, kvmPreflightError, kvmStatus } from './cua-vm-kvm.mjs'

const SOCK = process.env.CUA_SUPERVISOR_SOCK || '/tmp/cua-vm/supervisor.sock'
const CUA_BIN = process.env.CUA_BIN || 'cua'
const STORE = process.env.CUA_VM_STORE || '/cua-vm'
const CUA_HOME = process.env.CUA_VM_HOME || path.join(STORE, 'home')
const WORKSPACE_ROOT = process.env.CUA_WORKSPACE_ROOT || '/workspace'
const REGISTRY = path.join(STORE, 'registry.json')
const LOG_PREFIX = '[cua-vm]'

/**
 * THE QEMU PATH SHIM
 * ------------------
 * cua 0.7.0 does not exec a wrapper script: it resolves `qemu-system-x86_64`
 * from PATH (verified: a shim in a PATH prefix is executed, and its extra
 * argv reaches QEMU). Our shim lives in the volume, is prepended to PATH for
 * every cua call, and does two things the launcher cannot do for us:
 *   * run the distro QEMU (the only build with virtio-gpu-gl-pci), and
 *   * append `-virtfs local,path=/workspace`, which shares the project into
 *     the guest as a real mount at /workspace.
 * Rewritten on every start, so a `cua runtime setup` cannot drop it.
 */
const QEMU_SHIM_DIR = path.join(STORE, 'bin')

const CUA_ENV = {
  ...process.env,
  HOME: CUA_HOME,
  PATH: `${QEMU_SHIM_DIR}:${process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`,
  DO_NOT_TRACK: '1',
  CUA_TELEMETRY: '0'
}

mkdirSync(STORE, { recursive: true })
mkdirSync(CUA_HOME, { recursive: true })
mkdirSync(path.dirname(SOCK), { recursive: true })

/* ------------------------------------------------------------------ *
 * CONFIG — edited from the Plugins page ("Personal VM (CUA)"), never
 * hardcoded, and persisted outside the image so it survives a rebuild.
 * ------------------------------------------------------------------ */
const CONFIG_FILE = path.join(STORE, 'config.json')
/**
 * EVERY knob here is policy, and every one of them has a measured default:
 *
 *   shutdownTimeoutSec          how long an ACPI powerdown may take before QMP
 *                               `quit` makes it happen. 120 s is long enough for
 *                               a guest with a slow init but short enough that a
 *                               wedged kernel does not hold the panel for ever.
 *   checkpointPolicy            'shutdown' (default) captures a disk after a
 *                               clean powerdown, 'always' also captures before
 *                               a suspend takes the qcow2 away, 'never' turns
 *                               the whole checkpoint path off.
 *   shotsKeepDays               the screenshot files under $STORE/shots are
 *                               read-once artefacts; 7 days is plenty, 0 keeps
 *                               them for ever.
 *   windowsInstallTimeoutMinutes the Windows backend's "installing" window. A
 *                               first boot re-partitions a 64 GB disk and runs
 *                               the whole OOBE, which is 20-40 minutes on a
 *                               good host and much worse on a spinning disk.
 */
const CONFIG_DEFAULTS = {
  idleSuspendMinutes: 30, // 0 disables the idle timer
  diskQuotaGb: 20,
  maxRunning: 1,
  autoSuspend: true,
  shutdownTimeoutSec: 120,
  checkpointPolicy: 'shutdown',
  shotsKeepDays: 7,
  windowsInstallTimeoutMinutes: 60
}

const CHECKPOINT_POLICIES = new Set(['shutdown', 'always', 'never'])

function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return { ...CONFIG_DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { ...CONFIG_DEFAULTS }
  }
}

function normaliseConfig(input = {}) {
  const int = (value, fallback, min, max) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback
  }
  const policy = String(input.checkpointPolicy ?? CONFIG_DEFAULTS.checkpointPolicy).trim().toLowerCase()
  return {
    idleSuspendMinutes: int(input.idleSuspendMinutes, CONFIG_DEFAULTS.idleSuspendMinutes, 0, 1440),
    diskQuotaGb: int(input.diskQuotaGb, CONFIG_DEFAULTS.diskQuotaGb, 1, 500),
    maxRunning: int(input.maxRunning, CONFIG_DEFAULTS.maxRunning, 1, 8),
    autoSuspend: input.autoSuspend !== false,
    shutdownTimeoutSec: int(input.shutdownTimeoutSec, CONFIG_DEFAULTS.shutdownTimeoutSec, 10, 900),
    checkpointPolicy: CHECKPOINT_POLICIES.has(policy) ? policy : CONFIG_DEFAULTS.checkpointPolicy,
    shotsKeepDays: int(input.shotsKeepDays, CONFIG_DEFAULTS.shotsKeepDays, 0, 365),
    windowsInstallTimeoutMinutes: int(input.windowsInstallTimeoutMinutes, CONFIG_DEFAULTS.windowsInstallTimeoutMinutes, 5, 240)
  }
}

function writeConfig(config) {
  const tmp = `${CONFIG_FILE}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
  renameSync(tmp, CONFIG_FILE)
}

/**
 * WHAT COUNTS AGAINST THE QUOTA
 * -----------------------------
 * `du -sb $CUA_HOME/.cua` was the whole story when the store held one image and
 * one delta. It is not any more: a checkpoint is a full flattened disk (6 GB in
 * the store this was written on), the screenshot corpus grows by a few MB a
 * day, and a Windows computer keeps its qcow2 under $STORE/windows. Measuring
 * only `.cua` let a user fill the volume with checkpoints while the panel said
 * "0.0 GB of 20 GB" — and the next create died at ENOSPC, halfway through a
 * base-image download.
 *
 * The four roots below are disjoint by construction: nothing is counted twice
 * (the checkpoints are NOT under .cua, the shots are NOT under checkpoints, the
 * windows tree is its own directory).
 */
const ACCOUNTED_PATHS = () => [
  path.join(CUA_HOME, '.cua'),
  CHECKPOINT_DIR,
  path.join(STORE, 'shots'),
  WINDOWS_DIR,
  // M1: the ISO cache is the LARGEST thing in a Windows store (5.5 GB per
  // version + the optional virtio-win ISO). It used to be invisible to the
  // quota: ~25 GB could sit there while the panel showed "0 used".
  ISO_DIR
]

/** Bytes under one path, via du (fast, sparse-aware) or 0 when it is absent. */
function dirBytes(target) {
  return new Promise((resolve) => {
    if (!existsSync(target)) {
      resolve(0)
      return
    }
    const child = spawn('du', ['-sb', target], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(0))
    child.on('close', (code) => resolve(code === 0 ? (Number(String(out).split(/\s+/)[0]) || 0) : 0))
  })
}

/** Bytes used by the store: cua's own tree + checkpoints + shots + Windows. */
async function storeUsedBytes() {
  const sizes = await Promise.all(ACCOUNTED_PATHS().map((target) => dirBytes(target)))
  return sizes.reduce((total, size) => total + size, 0)
}

/** The same measurement, itemised, for the panel's store line and cua_vm_doctor. */
async function storeUsage() {
  const rows = await Promise.all(ACCOUNTED_PATHS().map(async (target) => ({ path: target, bytes: await dirBytes(target) })))
  return { totalBytes: rows.reduce((total, row) => total + row.bytes, 0), paths: rows }
}

/**
 * The quota rule for a TRANSIENT WRITE: `used + requested > quota` is refused,
 * BEFORE the bytes are written. `requested` must be a REAL size the next write
 * will consume (an ISO download, a checkpoint convert) — never the virtual size
 * of a sparse disk. `diskPolicyWarnings` carries the create-time rule, which
 * refuses only when the store's real usage is already over the policy.
 */
/**
 * QUOTA RESERVATIONS — check-then-act is not a check.
 *
 * `used + requested > quota` was evaluated twice, minutes apart: once before the
 * write and once (implicitly) when it appeared. Two writes that both start at
 * 5 GB of a 20 GB quota both pass, and the second one dies at ENOSPC halfway
 * through a download. A reservation makes the boundary serialised: the check and
 * the claim happen under one store lock, in-flight bytes count against the
 * quota, and the claim is released when the write finishes (success or failure).
 * Creates reserve 0 bytes on purpose: their disk is sparse, so the only real
 * consumption is the ISO download, which reserves its own size.
 */
const RESERVED_BYTES = new Map()

async function reserveStoreBytes(name, bytes) {
  return withLock('@store', async () => {
    const config = readConfig()
    const reserved = [...RESERVED_BYTES.values()].reduce((total, value) => total + value, 0)
    // `refuseOverQuota` re-measures; the reservation rides in as part of the
    // request, so "used + reserved + requested" is what gets compared.
    const over = await refuseOverQuota(config, Math.max(0, bytes) + reserved)
    if (over !== null) return over
    RESERVED_BYTES.set(name, Math.max(0, bytes))
    return null
  })
}

function releaseStoreBytes(name) {
  RESERVED_BYTES.delete(name)
}

async function refuseOverQuota(config, requestedBytes) {
  const used = await storeUsedBytes()
  const quota = config.diskQuotaGb * 1024 ** 3
  if (used + Math.max(0, requestedBytes) <= quota) return null
  const freeGb = Math.max(0, (quota - used) / 1024 ** 3).toFixed(1)
  const requested = Math.max(0, requestedBytes)
  // NAME THE REAL BYTES. A create reserves ZERO (its disk is sparse), so a
  // refusal here always means "the store already holds more than the policy";
  // only a transient write (an ISO download, a checkpoint convert) adds a real
  // size on top. The old wording printed the VIRTUAL request as if it were
  // consumption, which is the sentence that refused every Windows create.
  const requestedText = requested > 0 ? ` + ${(requested / 1024 ** 3).toFixed(1)} GB to be written` : ''
  return `VM store quota reached: ${(used / 1024 ** 3).toFixed(1)} GB of real store data${requestedText} `
    + `> ${config.diskQuotaGb} GB. The store has ${freeGb} GB free. Delete a computer, run cua_vm_gc, or raise the quota under Plugins → Personal VM (CUA) → Policy.`
}

/**
 * THE CREATE-TIME QUOTA RULE COUNTS REAL BYTES, NEVER A SPARSE DISK'S VIRTUAL
 * SIZE.
 *
 * `qemu-img create -f qcow2 disk 64G` writes a few hundred KB of metadata: the
 * guest only consumes store bytes as it writes. Charging the REQUESTED size
 * against `diskQuotaGb` therefore refused every Windows create on the shipped
 * 20 GB policy ("a 64 GB disk does not fit the store quota") while the store
 * held almost nothing — the exact opposite of what the sparse design buys, and
 * inconsistent with the branch's own rule that the quota counts real bytes.
 *
 * So a create now:
 *   * reserves NO virtual bytes (`reserveStoreBytes(name, 0)`), which still
 *     refuses when the store's REAL usage is already over the policy, and
 *   * reports "this disk is bigger than the policy" as a WARNING, not a refusal
 *     (`disk-over-policy`, same `[{ code, message }]` shape as the Windows
 *     floors). It applies to Linux too: a 40 GB REA disk on a 20 GB policy is
 *     created, with the same warning.
 *
 * `reserveStoreBytes` remains the tool for a TRANSIENT write whose real bytes
 * are known up front (the ISO download, and — through `refuseOverQuota` — the
 * checkpoint convert, which genuinely writes a full disk).
 */
function diskPolicyWarnings(diskGb, config) {
  const requested = Number(diskGb)
  const quota = Number(config.diskQuotaGb)
  if (!(requested > 0) || !(quota > 0) || requested <= quota) return []
  return [{
    code: 'disk-over-policy',
    message: `requested ${requested} GB exceeds the ${quota} GB store quota policy; the disk is sparse so creation proceeds, but the guest will hit the real disk ceiling and may fail to install — raised policy is recommended`
  }]
}

/* ------------------------------------------------------------------ *
 * PORT PREVIEWS — a real forward per (VM, guest port), published to the
 * proxy at /vm/port/<name>/ so a page the build started is reachable
 * from the harness origin instead of a bare loopback port.
 * ------------------------------------------------------------------ */
const PORTS_FILE = path.join(STORE, 'ports.json')
const PORT_BASE = Number(process.env.CUA_PORT_BASE || 39000)
const ports = new Map()

/**
 * PORT PREVIEWS — two backends, one table.
 *
 *   backend:'linux'  a real `cua sb port-forward` child process (the guest's
 *                    TCP is forwarded through cua's own channels).
 *   backend:'relay'  a plain TCP relay this process owns, pointing at a host
 *                    port a container already publishes (the Windows backend's
 *                    8006 web console). It exists so the proxy keeps ONE rule:
 *                    read `localPort` from ports.json and dial it on loopback.
 *
 * `target` is informational — the proxy deliberately ignores it (it only ever
 * dials localPort, so a stale row cannot be used to reach an arbitrary host).
 * It is written for the human reading ports.json and for cua_vm_doctor.
 */
function writePorts() {
  const out = {}
  for (const [name, entry] of ports) {
    out[name] = {
      guestPort: entry.guestPort,
      localPort: entry.localPort,
      url: `/vm/port/${name}/`,
      backend: entry.backend ?? 'linux',
      ...(entry.target ? { target: entry.target } : {})
    }
  }
  writeFileSync(PORTS_FILE, `${JSON.stringify(out, null, 2)}\n`)
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const socket = netConnect(port, '127.0.0.1')
    socket.setTimeout(400)
    socket.on('connect', () => { socket.destroy(); resolve(false) })
    socket.on('timeout', () => { socket.destroy(); resolve(true) })
    socket.on('error', () => resolve(true))
  })
}

async function firstFreePort() {
  let localPort = PORT_BASE
  while (localPort < PORT_BASE + 500 && !(await portIsFree(localPort))) localPort += 1
  if (localPort >= PORT_BASE + 500) throw new Error('no free local port for the preview')
  return localPort
}

/** A guest port through cua's own forwarder. */
async function openPort(name, guestPort) {
  closePort(name)
  const localPort = await firstFreePort()
  const child = spawn(CUA_BIN, ['sb', 'port-forward', '--local', name, `${guestPort}:${localPort}`], { env: CUA_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('exit', () => {
    if (ports.get(name)?.child === child) { ports.delete(name); writePorts() }
  })
  ports.set(name, {
    child,
    guestPort,
    localPort,
    backend: 'linux',
    alive: () => child.exitCode === null,
    stop: () => { try { child.kill('SIGTERM') } catch {} }
  })
  writePorts()
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await portIsFree(localPort))) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { name, guestPort, localPort, backend: 'linux', url: `/vm/port/${name}/`, stderr: stderr.trim().slice(-400) }
}

/**
 * A guest port that a CONTAINER already publishes on this host. The relay is a
 * TCP proxy this process owns; it is torn down with the computer and by
 * cua_vm_gc when its upstream stops answering.
 */
async function openRelay(name, guestPort, target, { backend = 'relay' } = {}) {
  closePorts(name)
  const localPort = await firstFreePort()
  const sockets = new Set()
  const server = netCreateServer((client) => {
    const upstream = netConnect(target.port, target.host || '127.0.0.1')
    sockets.add(client)
    sockets.add(upstream)
    const drop = () => {
      sockets.delete(client)
      sockets.delete(upstream)
      client.destroy()
      upstream.destroy()
    }
    client.on('error', drop)
    upstream.on('error', drop)
    client.on('close', drop)
    upstream.on('close', drop)
    client.pipe(upstream).pipe(client)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(localPort, '127.0.0.1', resolve)
  })
  ports.set(name, {
    guestPort,
    localPort,
    backend,
    target: { host: target.host || '127.0.0.1', port: target.port },
    alive: () => server.listening,
    stop: () => {
      for (const socket of sockets) {
        try { socket.destroy() } catch {}
      }
      try { server.close() } catch {}
    }
  })
  writePorts()
  return { name, guestPort, localPort, backend, url: `/vm/port/${name}/`, target: { host: target.host || '127.0.0.1', port: target.port } }
}

/** Stop every preview of one computer; returns how much there was to stop. */
function closePorts(name) {
  const entry = ports.get(name)
  if (!entry) return { rows: 0, killed: 0 }
  try { entry.stop?.() } catch {}
  ports.delete(name)
  writePorts()
  return { rows: 1, killed: entry.backend === 'relay' ? 0 : 1 }
}

function closePort(name) {
  closePorts(name)
}

/**
 * The preview a computer already had, so a failed shutdown can put it back.
 * Only the shape is kept (port + backend + relay target), never a socket: the
 * forward is re-created, which is what a restart of the process would do anyway.
 */
function snapshotPorts(name) {
  const entry = ports.get(name)
  if (!entry) return null
  return {
    guestPort: entry.guestPort,
    backend: entry.backend ?? 'linux',
    target: entry.target ?? null
  }
}

/** Reopen a preview; returns whether one was actually restored. */
async function restorePorts(name, snapshot) {
  if (!snapshot) return false
  try {
    if (snapshot.backend === 'relay' && snapshot.target) {
      await openRelay(name, snapshot.guestPort, snapshot.target, { backend: 'relay' })
    } else {
      await openPort(name, snapshot.guestPort)
    }
    log(`ports: ${name} preview on ${snapshot.guestPort} restored after the aborted shutdown`)
    return true
  } catch (error) {
    log(`ports: ${name} preview could not be restored (${error?.message ?? error})`)
    return false
  }
}

/**
 * BOOT RECONCILIATION. The table outlives the process that wrote it; after a
 * container restart every forward child is gone but ports.json still points at
 * dead loopback ports, so /vm/port/<name>/ answered 502 for a page that looks
 * "open". Drop the rows that cannot work, keep the ones a relay re-created.
 */
async function reconcilePorts() {
  let table = {}
  try {
    table = JSON.parse(readFileSync(PORTS_FILE, 'utf8')) || {}
  } catch {
    table = {}
  }
  const kept = {}
  let dropped = 0
  for (const [name, row] of Object.entries(table)) {
    const entry = ports.get(name)
    const local = Number(row?.localPort ?? entry?.localPort ?? 0)
    if (!local) { dropped += 1; continue }
    const alive = entry ? (typeof entry.alive === 'function' ? entry.alive() : true) : false
    if (!alive || (await portIsFree(local))) { dropped += 1; continue }
    kept[name] = {
      guestPort: row.guestPort ?? entry.guestPort,
      localPort: local,
      url: `/vm/port/${name}/`,
      backend: row.backend ?? entry.backend ?? 'linux',
      ...(row.target ? { target: row.target } : {})
    }
  }
  writeFileSync(PORTS_FILE, `${JSON.stringify(kept, null, 2)}\n`)
  if (dropped > 0) log(`ports: reconciled at boot, dropped ${dropped} stale row(s)`)
  return { kept: Object.keys(kept).length, dropped }
}

/** One command in flight per VM is enough to keep the idle timer honest. */
/* ------------------------------------------------------------------ *
 * VM VIEWER — the human takeover surface. `cua sb view --no-open --json`
 * mints a loopback URL with a ticket in the fragment; we record the port
 * and path here so the proxy can serve it at /vm/view/<name>/ (the ticket
 * stays in the fragment, so it never reaches the proxy).
 * ------------------------------------------------------------------ */
const VIEWS_FILE = path.join(STORE, 'views.json')

function readViews() {
  try {
    const parsed = JSON.parse(readFileSync(VIEWS_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeViews(views) {
  const tmp = `${VIEWS_FILE}.tmp`
  writeFileSync(tmp, `${JSON.stringify(views, null, 2)}\n`)
  renameSync(tmp, VIEWS_FILE)
}

const activeExecs = new Map()

function log(...parts) {
  process.stderr.write(`${LOG_PREFIX} ${parts.join(' ')}\n`)
}

/**
 * THE REGISTRY (v2)
 * -----------------
 * v1 was a map: `{ "name": {cpu, memory, rea, …} }`. It could not express "this
 * computer is Windows", it had nowhere to put the Windows version or ISO, and
 * it silently lost any field a reader did not know about.
 *
 * v2 is `{ "version": 2, "vms": { … } }` and every row carries `kind`
 * ('linux' | 'windows') and `backend` ('linux' | 'qemu': `qemu` is canonical for
 * Windows, because that is what the code drives — there is no container). The READ PATH
 * migrates: a v1 file is turned into v2 rows (kind/backend default to linux,
 * and a row that already said `backend: 'windows'` is normalised to `'qemu'`,
 * the one canonical value — see migrateRegistryRow), the migrated
 * content is written back, and the caller never sees the difference. That is
 * what makes this safe to land on a store with a running computer: no rename
 * of the file, no "please delete registry.json".
 */
const REGISTRY_VERSION = 2
const VM_KINDS = new Set(['linux', 'windows'])

/**
 * One row, upgraded in place. Unknown fields are preserved verbatim.
 *
 * `image` IS PART OF THE UPGRADE, not an optional extra: a v1 row written by an
 * older build has no `image`, and the rebuild paths used to pass `meta.image`
 * straight into `sb create` — a v1 row could only produce `sb create undefined`.
 * The live store this was written against has exactly such a row
 * (`ws-…`: workspace/tier/cpu/memory/rea/state, no image), so this is a real
 * migration, not a hypothetical one.
 */
function migrateRegistryRow(row, mapKey = '') {
  const record = row && typeof row === 'object' ? row : {}
  const windows = record.kind === 'windows' || record.backend === 'windows' || record.backend === 'qemu'
  const kind = windows ? 'windows' : (VM_KINDS.has(record.kind) ? record.kind : 'linux')
  return {
    ...record,
    // R2: A ROW'S NAME IS THE MAP KEY. Rows used to be written WITHOUT a `name`
    // field while every backend helper read `spec.name`, so the Windows pidfile
    // path became `/cua-vm/windows/undefined/qemu.pid`, nothing was ever alive
    // there, and the install watch printed "QEMU not alive (see
    // qemu-stderr.log tail)" forever while QMP answered `running`. Injecting it
    // here upgrades every row already on disk, not just the ones written next.
    name: String(record.name || mapKey || ''),
    kind,
    // L2: ONE canonical value per kind. A created row writes `qemu`; a migrated
    // v1 row used to keep `windows`, so `vmList` and the doctor could disagree
    // about what backend a computer had. `qemu` is canonical for Windows (it is
    // what the code drives), `linux` for the cua guest.
    backend: windows ? 'qemu' : 'linux',
    ...(windows
      ? { windowsVersion: String(record.windowsVersion || '11'), windowsIso: String(record.windowsIso || '') }
      : { image: String(record.image || 'linux'), tier: String(record.tier || 'slim') })
  }
}

function migrateRegistry(parsed) {
  const vms = parsed && typeof parsed === 'object' && parsed.vms && typeof parsed.vms === 'object'
    ? parsed.vms
    : (parsed && typeof parsed === 'object' && !('version' in parsed) ? parsed : {})
  const out = {}
  for (const [name, row] of Object.entries(vms)) {
    if (!row || typeof row !== 'object') continue
    out[name] = migrateRegistryRow(row, name)
  }
  return { version: REGISTRY_VERSION, vms: out }
}

/**
 * READ THE REGISTRY, OR FAIL LOUDLY.
 *
 * The previous version answered `{vms:{}}` for ANY failure — a missing file (the
 * normal first boot), a transient EIO, a permission change, a truncated write —
 * and `mutateRegistry` then persisted that empty map over the real one. One
 * `EACCES` during an `exec`'s lastUsed update would have silently deleted every
 * computer from the store. A missing file is the only case that legitimately
 * means "empty"; everything else throws, and `mutateRegistry` propagates it
 * WITHOUT writing, because a registry that could not be read must never be
 * rewritten from a guess.
 */
function readRegistry() {
  let text
  try {
    text = readFileSync(REGISTRY, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: REGISTRY_VERSION, vms: {} }
    throw new Error(`registry.json could not be read (${error?.code ?? error?.message ?? error}); refusing to continue with an empty registry`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`registry.json is not valid JSON (${error?.message ?? error}); refusing to continue with an empty registry`)
  }
  return migrateRegistry(parsed)
}

/** Was the file on disk still a v1 shape? Used by the boot-time migration. */
function registryNeedsMigration() {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY, 'utf8'))
    return !parsed || parsed.version !== REGISTRY_VERSION || parsed.vms === undefined
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    return false // unreadable is not "needs migration"; the read path throws
  }
}

function writeRegistry(registry) {
  const out = { version: REGISTRY_VERSION, vms: registry.vms || {} }
  const tmp = `${REGISTRY}.tmp`
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`)
  renameSync(tmp, REGISTRY)
}

/**
 * REGISTRY MUTATIONS ARE SERIALISED, BECAUSE AWAITS INTERLEAVE.
 *
 * The supervisor is one process with many concurrent waits: an `exec` finishing
 * while a shutdown updates the same row, a Windows install tick landing during a
 * create. Every one of them used to do read → mutate → write across `await`s, so
 * the LAST writer won with the FIRST reader's snapshot: an `exec` that started
 * before a shutdown could write `state: "ready"` back over `powered-off`, and
 * then Start would try to resume a computer that had no sandbox. The lock is the
 * same one creates use, under a key that no computer name can collide with
 * (`@` is not legal in a name), and the critical section is deliberately tiny —
 * a re-read, a field, a write — so a five-minute provisioning run never holds it.
 */
function mutateRegistry(mutator) {
  // `readRegistry` THROWS on an unreadable file, and the throw happens before
  // `writeRegistry`, so a failing read can never be persisted as an empty store.
  return withLock('@registry', async () => {
    const registry = readRegistry()
    const result = await mutator(registry)
    writeRegistry(registry)
    return result
  })
}

/**
 * The v1→v2 migration is a WRITE, so it happens under the same lock as every
 * other write: doing it on the read path meant two concurrent readers could both
 * decide to "migrate" and the second could write a snapshot that predated the
 * first's update. Called once at boot; every later mutation writes v2 anyway.
 */
async function migrateRegistryFile() {
  if (!registryNeedsMigration()) return false
  const count = await mutateRegistry(() => Object.keys(readRegistry().vms).length)
  log(`registry: migrated to v${REGISTRY_VERSION} (${count} computer(s))`)
  return true
}

/**
 * WINDOWS CREDENTIALS — never in the registry.
 *
 * registry.json is read by the panel, copied into bug reports and printed by
 * `cua_vm_status`; a generated Windows password in there would be one careless
 * paste away from a public issue. The password lives in
 * `$STORE/windows/<name>/credentials.json` with mode 0600 and the row only
 * records that the file exists. The panel reveals it on demand through the
 * supervisor, which is the one process that has to read it anyway.
 */
const WINDOWS_DIR = path.join(STORE, 'windows')
/** Downloaded install media hold: shared by every computer, counted by the quota. */
const ISO_DIR = path.join(STORE, 'iso')

function windowsCredentialsPath(name) {
  return path.join(WINDOWS_DIR, assertVmName(name), 'credentials.json')
}

function writeWindowsCredentials(name, record) {
  const file = windowsCredentialsPath(assertVmName(name))
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  chmodSync(file, 0o600)
  return file
}

function readWindowsCredentials(name) {
  try {
    assertVmName(name)
    return JSON.parse(readFileSync(windowsCredentialsPath(name), 'utf8'))
  } catch {
    return null
  }
}

/** Resolve a host path and require it to stay inside the workspace root. */
function workspacePath(input, { mustExist = false, forWrite = false } = {}) {
  if (typeof input !== 'string' || input.length === 0) throw new Error('path is required')
  const root = realpathSync(WORKSPACE_ROOT)
  const absolute = path.isAbsolute(input) ? input : path.join(root, input)
  const parent = forWrite ? path.dirname(absolute) : absolute
  let resolved
  try {
    resolved = realpathSync(parent)
  } catch {
    throw new Error(`no such path: ${input}`)
  }
  const target = forWrite ? path.join(resolved, path.basename(absolute)) : resolved
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`path escapes the workspace: ${input}`)
  }
  if (mustExist) statSync(target)
  return target
}

function vmName(workspace) {
  const real = realpathSync(workspace)
  return `ws-${createHash('sha256').update(real).digest('hex').slice(0, 12)}`
}

/**
 * A COMPUTER NAME IS A PATH SEGMENT, SO IT IS VALIDATED EVERYWHERE IT BECOMES ONE.
 *
 * The name reaches `path.join(WINDOWS_DIR, name)`, `.cua/vmm/qemu/<name>`,
 * `.cua/trajectories/local_<name>` and `$STORE/checkpoints/<name>.qcow2`, and
 * `vmDelete` used to accept any string it was given: `{"op":"vmDelete",
 * "name":"../../etc"}` joined outside the store and `rmSync(recursive)` deleted
 * whatever it pointed at. Create validated its name; the destructive ops did not.
 *
 * This is the same rule create has always used, in one function, called from the
 * request dispatcher (so no op can forget it) AND from the path helpers (so an
 * internal caller cannot slip a name past it either).
 */
const VM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/

function assertVmName(name) {
  const text = String(name ?? '')
  if (!VM_NAME_PATTERN.test(text)) {
    throw new Error(`invalid computer name "${text}": 2-31 chars, lowercase letters, digits and dashes (a name is a path segment, so it cannot contain "/", ".." or a separator)`)
  }
  return text
}

/** Run the cua CLI and capture its streams. Never throws on a non-zero exit. */
function runCua(args, { timeoutMs = 180000, signal } = {}) {
  return new Promise((resolve) => {
    // A FAILED SPAWN IS A RESULT, NOT AN EXCEPTION.
    //
    // `spawn` reports two different failures on two different channels: a
    // synchronous throw (EACCES on a non-executable path) and an asynchronous
    // 'error' event (ENOENT — the usual one, a missing CUA_BIN). The old handler
    // for the second one called `done(-1).error ? … : …`, i.e. it read a property
    // off `undefined`: the TypeError was thrown INSIDE the 'error' listener,
    // where nothing catches it, and the supervisor died with the pending request
    // never answered. Any deployment with `cua` not on PATH therefore killed the
    // VM supervisor the first time a tool called it.
    //
    // Both channels now resolve the same `{code:-1, stderr}` shape (so `sb ls`
    // reports "cua is not available" instead of hanging), and `settled` makes
    // the promise single-shot no matter which event lands first.
    let child
    try {
      child = spawn(CUA_BIN, args, { env: CUA_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: `could not run ${CUA_BIN}: ${error?.message ?? error}`, timedOut: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let timer
    let settled = false
    const done = (code, timedOut = false, extra = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        stdout,
        stderr: extra === '' ? stderr : `${stderr}${stderr === '' ? '' : '\n'}${extra}`,
        timedOut
      })
    }
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => done(-1, false, `could not run ${CUA_BIN}: ${error?.message ?? error}`))
    child.on('close', (code) => done(code ?? -1))
    if (signal) signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
    timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.()
      done(-1, true)
    }, timeoutMs)
    timer.unref?.()
  })
}

function ok(result) {
  return { ok: true, ...result }
}

function fail(error, extra = null) {
  const message = error instanceof Error ? error.message : String(error)
  // `extra` carries diagnostics (a partial result, a changed port triple) on an
  // answer that is otherwise a plain refusal; every existing caller passes one
  // argument, so nothing else changes.
  return { ok: false, error: message, ...(extra ?? {}) }
}

/**
 * The user-local QEMU bundle cua installs under $HOME/.cua/qemu loses the
 * seabios symlinks Debian normally carries (`bios-256k.bin` lives in
 * share/seabios, not share/qemu), and QEMU then dies with
 * "could not load PC BIOS 'bios-256k.bin'". Repair them once, idempotently.
 */
function repairQemuData() {
  const share = path.join(CUA_HOME, '.cua', 'qemu', 'usr', 'share')
  const seabios = path.join(share, 'seabios')
  const qemu = path.join(share, 'qemu')
  if (!existsSync(seabios) || !existsSync(qemu)) return
  for (const entry of readdirSync(seabios)) {
    if (!entry.endsWith('.bin')) continue
    const target = path.join(qemu, entry)
    if (existsSync(target)) continue
    try { symlinkSync(path.join('..', 'seabios', entry), target) } catch {}
  }
}

/** Make sure the VMM exists in the store before the first create. */
async function ensureRuntime() {
  const wrapper = path.join(CUA_HOME, '.cua', 'bin', 'qemu-system-x86_64')
  // A wrapper swapped by an image that had the system QEMU is dead weight in an
  // image that does not: restore cua's own, or force a re-provision.
  if (existsSync(wrapper) && !existsSync(SYSTEM_QEMU)) {
    try {
      if (readFileSync(wrapper, 'utf8').includes(SYSTEM_QEMU)) {
        if (existsSync(`${wrapper}.cua`)) {
          renameSync(`${wrapper}.cua`, wrapper)
          log('qemu: restored cua\'s wrapper (the system QEMU is not in this image)')
        } else {
          unlinkSync(wrapper)
          log('qemu: dropped a stale system wrapper; re-provisioning')
        }
      }
    } catch (error) {
      log(`qemu: could not restore the wrapper: ${error && error.message}`)
    }
  }
  if (!existsSync(wrapper)) {
    const setup = await runCua(['runtime', 'setup', 'qemu'], { timeoutMs: 900000 })
    if (setup.code !== 0) throw new Error(`cua runtime setup qemu failed: ${(setup.stderr || setup.stdout).trim().slice(-800)}`)
  }
  repairQemuData()
  // Runs every time: a re-provision puts cua's non-virgl binary back and would
  // silently drop the GPU, and the 9p share lives in the same wrapper.
  installQemuShim()
  return existsSync(wrapper)
}

/**
 * Guest provisioning lives in real scripts inside the image
 * (docker/cua-guest-provision.sh, docker/cua-guest-android.sh), not in a
 * base64 blob buried in this file. They repair the placeholder apt sources,
 * install the X server and mesa-utils, open the render node and /dev/kvm,
 * mount the workspace share, force a capture-sized desktop and — on a GPU
 * computer — move the desktop from Xvfb to Xorg and lift the OpenGL version
 * virgl under-reports. A file can be read, diffed and run by hand; the
 * previous inline blob could not.
 */
function readProvisionScript(file) {
  try { return readFileSync(file, 'utf8') } catch { return null }
}

/** Pipe a guest script through `sudo bash`; the base64 removes every quoting risk. */
async function runGuestScript(name, file, env, { timeoutSec = 900, timeoutMs = 960000 } = {}) {
  const script = readProvisionScript(file)
  if (script === null) {
    log(`provision: ${file} is missing from this image (rebuild with the current Dockerfile)`)
    return { code: 127, stdout: '', stderr: `${file} missing from the image` }
  }
  const b64 = Buffer.from(script, 'utf8').toString('base64')
  const assigns = Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')
  const command = `printf %s ${b64} | base64 -d | sudo -n env ${assigns} bash`
  return runCua(['sb', 'exec', '--local', name, '--timeout', String(timeoutSec), command], { timeoutMs })
}

/**
 * Make the guest a workstation. Idempotent and versioned: the script writes
 * /var/lib/cua-provision and returns immediately when it matches.
 */
async function provisionGuest(name, { gpu = false } = {}) {
  const result = await runGuestScript(name, PROVISION_SCRIPT, {
    GPU: gpu === true ? 1 : 0,
    SHARE_TAG: SHARE_WORKSPACE ? SHARE_TAG : '',
    RESOLUTION: DESKTOP_RESOLUTION
  })
  let output = `${result.stdout}${result.stderr}`.trim()
  const renderer = (/\[provision\] OK.*?renderer=([^\n]*)/u.exec(output) || [])[1]
    || (/renderer: ([^\n]*)/u.exec(output) || [])[1]
    || 'unknown'
  if (result.code !== 0 || !/\[provision\] (OK|already provisioned)/u.test(output)) {
    // v7 reports a broken apt with `NOT OK apt_broken=1 reason=…` AND writes the
    // marker, so the reason has to travel with the failure instead of being
    // re-derived from a ten-minute re-run.
    const reason = (/\[provision\] NOT OK[^\n]*reason=([^\n]*)/u.exec(output) || [])[1]
      || (/\[provision\] NOT OK[^\n]*/u.exec(output) || [])[0]
      || ''
    log(`provision: ${name} incomplete (${output.slice(-400)})`)
    return { ok: false, renderer, reason: reason.trim(), aptOk: !/apt_broken=1/u.test(output), output }
  }
  // The script restarts cua-spacesd in the background so the GPU environment
  // reaches `cua sb exec` children too. Wait for it, then prove it took.
  if (gpu === true) {
    const deadline = Date.now() + 60000
    let override = ''
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 4000))
      const check = await guestExec(name, 'printf %s "$MESA_GL_VERSION_OVERRIDE"')
      override = check.stdout.trim()
      if (override !== '') break
    }
    log(`provision: ${name} shell GL override ${override || '(not set)'}`)
    output += `\n[provision] shell override: ${override || '(not set — GUI session only)'}`
  }
  log(`provision: ${name} ready (${renderer})`)
  return { ok: true, renderer, output }
}

/** Android SDK + AVD inside the guest. Slow (a few GB) but one-off per computer. */
async function provisionAndroidGuest(name, { api = 35, variant = 'google_apis', arch = 'x86_64', avd = 'cua' } = {}) {
  const result = await runGuestScript(name, ANDROID_SCRIPT, { API: api, VARIANT: variant, ARCH: arch, AVD: avd }, { timeoutSec: 3000, timeoutMs: 3300000 })
  const output = `${result.stdout}${result.stderr}`.trim()
  if (result.code !== 0 || !/\[android\] OK/u.test(output)) {
    log(`android: ${name} failed (${output.slice(-400)})`)
    return { ok: false, output }
  }
  log(`android: ${name} ready (${avd})`)
  return { ok: true, output }
}

/**
 * The REA kit inside the guest: JDK, its own Node, rea-agents, Ghidra 12.1.4,
 * jadx + jadx-headless-mcp, the persisted environment, and the MCP row in the
 * guest user's own profile. One-off per computer and slow (a 1.4 GB Ghidra
 * download), hence an hour of headroom: a 15-minute timeout here would kill
 * healthy downloads on a slow link and then report a provisioning failure that
 * was really a too-short deadline.
 */
async function provisionReaGuest(name) {
  const result = await runGuestScript(name, REA_SCRIPT, {}, { timeoutSec: 3600, timeoutMs: 3900000 })
  const output = `${result.stdout}${result.stderr}`.trim()
  // A provisioned disk answers `[rea] already provisioned (v1)` and exits 0,
  // exactly like the desktop layer's `[provision] already provisioned`.
  // Without that arm a fully installed kit read as rea:false on every start,
  // provision and recovery.
  if (result.code !== 0 || !/\[rea\] OK|\[rea\] already provisioned/u.test(output)) {
    log(`rea: ${name} failed (${output.slice(-400)})`)
    return { ok: false, node: 'unknown', output }
  }
  // `say "OK node=... rea=... ghidra=... jdk=... jadx=..."` is the contract;
  // the node version is the one field the panel cannot re-derive. The
  // already-provisioned early exit prints no such line, so fall back to the
  // banner's own `node=v...` and finally to 'unknown'.
  const node = (/\[rea\] OK[^\n]*\bnode=(v[0-9][^\s]*)/u.exec(output) || [])[1]
    || (/\bnode=(v[0-9][^\s]*)/u.exec(output) || [])[1]
    || 'unknown'
  log(`rea: ${name} ready (node ${node})`)
  return { ok: true, node, output }
}

/**
 * Window titles with the desktop's own furniture removed. XFCE registers the
 * session, the WM, the settings daemon, the panel and one window per panel
 * plugin; none of them is a click target and together they pushed the real
 * app off the end of the list the model reads.
 */
function cleanWindowList(raw) {
  const noise = /^(xfce4-session|xfwm4|Xfwm4|xfsettingsd|xfce4-panel|xfdesktop|wrapper-2\.0|Desktop|Cua\.AgentCursorOverlay.*|\s*)$/u
  const seen = new Set()
  return String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^\d+\s+\d+$/u.test(line) && !/^[XY]=/u.test(line) && !noise.test(line))
    .filter((line) => {
      if (seen.has(line)) return false
      seen.add(line)
      return true
    })
    .slice(0, 16)
}

/**
 * `cua do window ls` prints one window per line as
 *   <handle>  <app>  <title>  [x,y,w,h]  <flags>
 * The bounds are the click targets; the titles are what `zoom` matches on.
 */
function listWindows(raw) {
  const rows = []
  for (const line of String(raw || '').split('\n')) {
    const matched = /^(\S+)\s+(.+?)\s{2,}(.+?)\s{2,}\[(\d+),(-?\d+),(\d+),(\d+)\]/u.exec(line.trim())
    if (!matched) continue
    const noise = /^(xfce4-session|xfwm4|Xfwm4|xfsettingsd|xfce4-panel|xfdesktop|wrapper-2\.0|Desktop|Cua\.AgentCursorOverlay.*)$/u
    if (noise.test(matched[2]) || noise.test(matched[3])) continue
    rows.push({ handle: matched[1], app: matched[2], title: matched[3], rect: `${matched[4]},${matched[5]} ${matched[6]}x${matched[7]}` })
  }
  return rows.slice(0, 12)
}

/** Focus + pointer context, so the model can tell whether its action landed. */
async function guiContext(name) {
  const read = await runCua(['sb', 'exec', '--local', name, '--timeout', '20',
    'DISPLAY=${DISPLAY:-:1} xdotool getactivewindow getwindowname 2>/dev/null; DISPLAY=${DISPLAY:-:1} xdotool getmouselocation --shell 2>/dev/null | head -2'], { timeoutMs: 60000 })
  if (read.code !== 0) return ''
  const lines = read.stdout.trim().split('\n').filter(Boolean)
  const x = (/X=(-?\d+)/u.exec(read.stdout) || [])[1]
  const y = (/Y=(-?\d+)/u.exec(read.stdout) || [])[1]
  const title = lines.find((line) => !/^(X|Y|WINDOW|SCREEN)=/u.test(line)) || 'none'
  return `focus: ${title}, pointer: ${x ?? '?'},${y ?? '?'}`
}

/** sb exec, but patient: the guest daemon restarts with the desktop. */
async function guestExec(name, command, timeoutMs = 60000, attempts = 3) {
  let last = null
  for (let index = 0; index < attempts; index += 1) {
    last = await runCua(['sb', 'exec', '--local', name, '--timeout', '20', command], { timeoutMs })
    const text = `${last.stdout}${last.stderr}`
    if (last.code === 0 || !/spacesd is not available|nothing answered|connection reset|timed out/iu.test(text)) return last
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  return last
}

const CREATE_LOCK = new Map()

function withLock(key, fn) {
  const previous = CREATE_LOCK.get(key) || Promise.resolve()
  const next = previous.then(fn, fn)
  CREATE_LOCK.set(key, next.catch(() => {}))
  return next
}

/**
 * ONE LIFECYCLE OPERATION PER COMPUTER.
 *
 * `ensure`/`vmCreate` took a lock; Start, Shutdown, Delete, Suspend, Resume and
 * the idle timer did not. Two of those running at once is how a start reads a
 * row that a delete is halfway through removing, and how the idle timer suspends
 * a computer that a shutdown has just powered off (both then write the row).
 *
 * The lock is RE-ENTRANT within one async chain: `shutdown` may fall back to
 * `suspend`, `stop` delegates to `shutdown`, and both would otherwise wait for
 * the lock they already hold. AsyncLocalStorage carries "this chain already owns
 * name X" across every `await`, so the inner call runs immediately and a
 * DIFFERENT chain still queues behind `withLock`.
 */
const VM_LOCK_CONTEXT = new AsyncLocalStorage()

function withVmLock(name, fn) {
  assertVmName(name)
  const held = VM_LOCK_CONTEXT.getStore()
  if (held instanceof Set && held.has(name)) return fn()
  return withLock(name, () => {
    const next = new Set(held ?? [])
    next.add(name)
    return VM_LOCK_CONTEXT.run(next, fn)
  })
}

async function listSandboxes() {
  const result = await runCua(['sb', 'ls', '--local', '--json'], { timeoutMs: 60000 })
  if (result.code !== 0) return { parsed: null, raw: result.stdout || result.stderr }
  try {
    return { parsed: JSON.parse(result.stdout), raw: result.stdout }
  } catch {
    return { parsed: null, raw: result.stdout }
  }
}

function findListed(parsed, name) {
  if (!parsed) return null
  const rows = Array.isArray(parsed) ? parsed : parsed.sandboxes || parsed.items || []
  return rows.find((row) => row && (row.name === name || row.id === name || row.ref === `local:${name}`)) || null
}

/** The create argv, shared by a fresh create and a recovery recreate. */
function createArgs(name, tier, cpu, memory, waitDesktop, image = 'linux', gpu = false) {
  const args = ['sb', 'create', image, '--on', 'local', '--kind', 'vm', '--name', name]
  // A local disk path carries its own variant; --tier only applies to catalog refs.
  if (String(image).startsWith('/') === false) args.push('--tier', String(tier))
  if (gpu === true) args.push('--gpu', 'virgl')
  args.push('--cpu', String(cpu), '--memory', `${memory}GB`, '--json', '--wait', waitDesktop ? 'desktop' : 'tcp:3211')
  return args
}

/**
 * A QEMU VM that outlives its process is gone as a *sandbox*, but its writable
 * disk is still in the store. Copy it out before anything deletes it, so the
 * recreated computer boots the filesystem the model had (installed packages,
 * cloned repos) instead of a blank image.
 */
const CHECKPOINT_DIR = path.join(STORE, 'checkpoints')

/**
 * DSH_CUA_VM_GPU=virgl makes the supervisor point cua's QEMU wrapper at the
 * distro build (the one with virtio-gpu-gl-pci) and pass `--gpu virgl` on
 * create. Without it everything stays exactly as before.
 */
const GPU_MODE = String(process.env.DSH_CUA_VM_GPU || '').trim().toLowerCase()
const SYSTEM_QEMU = '/usr/bin/qemu-system-x86_64'

/**
 * THE WORKSPACE SHARE (9p)
 * ------------------------
 * "Use the VM as your computer" only works when the VM sees the project. A
 * bind mount cannot cross the QEMU boundary, virtiofs needs /dev/fuse (absent
 * in the harness container), so 9p it is: the QEMU shim below adds
 *   -virtfs local,path=/workspace,mount_tag=dshworkspace,security_model=none
 * and the guest mounts it at /workspace. QEMU runs as the same user that owns
 * /workspace, so writes from the guest land as ordinary workspace files and
 * `cua_vm_get` stops being the only way out of the VM.
 *
 * Turn it off with DSH_CUA_VM_SHARE_WORKSPACE=0 (the guest then keeps only
 * its own filesystem and the put/get tools are the only bridge).
 */
const SHARE_WORKSPACE = String(process.env.DSH_CUA_VM_SHARE_WORKSPACE ?? '1') !== '0'
const SHARE_TAG = String(process.env.DSH_CUA_VM_SHARE_TAG || 'dshworkspace')
/**
 * Desktop geometry. cua captures at most ~900k pixels, so a 1280x800 display
 * is delivered as a 1200x750 PNG and every pixel coordinate the model reads
 * is 0.9375 of the one it must click. 1200x750 is exactly 900k pixels: the
 * capture is 1:1 and the ambiguity disappears even for tools that bypass
 * cua's own coordinate mapping.
 */
const DESKTOP_RESOLUTION = String(process.env.DSH_CUA_VM_RESOLUTION || '1200x750')
const SHOTS_DIR = path.join(STORE, 'shots')
const WINDOWS_ARTIFACT_DIR = path.join(WORKSPACE_ROOT, '.cua-vm', 'shots')

/**
 * THE RESOLUTION GUARD
 * --------------------
 * A desktop above cua's ~900k px capture budget is delivered as a resampled
 * PNG: the model reads one pixel grid and clicks another, and the drift grows
 * with the distance from the origin. It is refused at create time (a clear
 * sentence, before a 1.3 GB download) unless the operator has explicitly
 * accepted the mapping with DSH_CUA_VM_RESOLUTION_ALLOW_SCALE=1 — in which case
 * every result reports the ratio instead of hiding it.
 */
const RESOLUTION_ALLOW_SCALE = String(process.env.DSH_CUA_VM_RESOLUTION_ALLOW_SCALE ?? '') === '1'

/** Space measurement: xdotool geometry + the PNG's own IHDR, cached 30 s. */
const space = createSpace({
  display: async (name) => {
    // The guest's own helper first (installed by provision v7: it retries while
    // the desktop comes up), xdotool second, so a guest provisioned before v7 —
    // or one whose helper was removed — still measures.
    const read = await guestExec(name, 'command -v cua-space >/dev/null 2>&1 && cua-space || DISPLAY=${DISPLAY:-:1} xdotool getdisplaygeometry')
    const matched = /^(\d+)\s+(\d+)$/mu.exec(read.stdout.trim())
    if (!matched) throw new Error(`the guest did not report its display geometry ("${read.stdout.trim().slice(0, 80)}")`)
    return { width: Number(matched[1]), height: Number(matched[2]) }
  },
  capture: async (name) => {
    // `cua do` KEEPS ITS TARGET ACROSS PROCESSES. Without a switch, a measurement
    // taken for computer A could capture computer B — the daemon was still
    // pointed at whatever the last `cua do` call selected — and the scale the
    // tool then reported (and every click it derived from it) belonged to the
    // wrong desktop. The gui path always switched; this one now does too, and a
    // switch drops the cached space because a new target is a new capture.
    if (DO_TARGET !== name) {
      const switched = await runCua(['do', 'switch', `local:${name}`], { timeoutMs: 60000 })
      if (switched.code !== 0) throw new Error((switched.stderr || switched.stdout).trim().slice(-200) || 'the desktop daemon did not accept the target')
      if (DO_TARGET !== '') space.clear()
      DO_TARGET = name
      // cua's first click after a switch is 1:1 until it has seen a capture, so
      // the "prime once" flag belongs to the old target.
      SHOT_STATE.delete(name)
    }
    const file = path.join('/tmp', `cua-space-${process.pid}-${Date.now()}.png`)
    const taken = await runCua(['do', 'screenshot', '-s', file, '--json'], { timeoutMs: 60000 })
    if (taken.code !== 0) throw new Error((taken.stderr || taken.stdout).trim().slice(-200))
    const size = pngSize(readFileSync(file))
    try { unlinkSync(file) } catch {}
    if (size === null) throw new Error('cua wrote something that is not a PNG')
    return size
  },
  log
})

/**
 * The Windows backend: DIRECT QEMU, wired to this process's QMP client so the
 * monitor protocol has exactly one implementation. No Docker Engine, no DinD —
 * the same /dev/kvm, the same store, the same locks as the Linux computer.
 */
const windowsBackend = createWindowsBackend({
  store: STORE,
  // R3: THE TWO QMP SIGNATURES ARE JOINED HERE, ONCE.
  //
  // The backend calls `qmp(host, port, commands, opts)`; this process's one QMP
  // implementation is `qmpCommands(port, commands, { timeoutMs, host })`. The
  // raw primitive used to be passed through, so `'127.0.0.1'` arrived as the
  // PORT, the dial threw, `probe()` reported `qmp: 'not answering'`, and a
  // running QEMU never reached `ready` — the "probe always yields not answering"
  // half of the reported bug. `windowsQmpAdapter` accepts the backend's shape
  // and forwards this one's, so neither contract moves and a unit test can
  // prove the join with a faithful stub.
  qmp: windowsQmpAdapter(qmpCommands),
  log
})

/**
 * THE OEM PAYLOAD'S TWO ENDS.
 *
 * `WINDOWS_OEM_DIR` is the runtime path; the Dockerfile's
 * `COPY docker/windows-oem/ <that path>` is the image end. They are two strings
 * in two files with nothing between them, which is why tools/check-cua-vm.mjs
 * pins the dockerfile destination to this literal (K2) — an image that copies
 * the payload somewhere else, or not at all, fails the build instead of failing
 * the first Windows create with a path in the error.
 */
const WINDOWS_OEM_DIR = String(process.env.DSH_CUA_WINDOWS_OEM_DIR || '/usr/local/share/cua-vm/windows-oem')
/**
 * Self-healing fallbacks, in order. The image's flat gate tree keeps the same
 * three files at its root (/opt/seek-harness/cua-check/, see the Dockerfile),
 * and the module's own directory carries a `windows-oem/` copy inside a
 * checkout — so a stale mount that hides only the primary directory degrades to
 * a log line instead of a dead "create Windows computer" button.
 * Colon-separated, like PATH; empty by default except for the image tree.
 */
const WINDOWS_OEM_FALLBACK_DIRS = String(process.env.DSH_CUA_WINDOWS_OEM_FALLBACK_DIRS
  || '/opt/seek-harness/cua-check:/usr/local/bin/windows-oem')
  .split(':')
  .map((dir) => dir.trim())
  .filter(Boolean)
/** Pinned python.org installer for the guest (silent install). */
const WINDOWS_PYTHON_URL = String(process.env.DSH_CUA_WINDOWS_PYTHON_URL
  || 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe')
/** What pip installs in the guest for the UI-automation server. */
const WINDOWS_DSH_CUA_SPEC = String(process.env.DSH_CUA_WINDOWS_DSH_CUA || 'dsh-cua')
/** Free-port ranges for one Windows computer's three sockets. */
const WINDOWS_QMP_RANGE = [46000, 46500]
const WINDOWS_SSH_RANGE = [47000, 47500]
const WINDOWS_VNC_RANGE = [5920, 5999]
const PROVISION_SCRIPT = String(process.env.DSH_CUA_PROVISION_SCRIPT || '/usr/local/bin/cua-guest-provision.sh')
const ANDROID_SCRIPT = String(process.env.DSH_CUA_ANDROID_SCRIPT || '/usr/local/bin/cua-guest-android.sh')
/**
 * THE REVERSE-ENGINEERING KIT (REA)
 * ---------------------------------
 * Ghidra + jadx + the rea-agents MCP server, installed INSIDE the guest as its
 * own layer with its own marker (/var/lib/cua-rea). It is deliberately not
 * folded into the desktop provisioning: a computer created without `rea: true`
 * must never pay for a ~2 GB download, and a version bump on one layer must not
 * invalidate the other. Same contract as provisionGuest — idempotent, and the
 * marker is written only after `rea doctor` passes.
 */
const REA_SCRIPT = String(process.env.DSH_CUA_REA_SCRIPT || '/usr/local/bin/cua-guest-rea.sh')
/**
 * A REA computer is never smaller than this. Ghidra unpacks to ~1.4 GB, the
 * JDK and its own Node add ~1 GB, jadx another ~150 MB on top of a 20 GB
 * desktop — a 20 GB disk dies mid-unzip with ENOSPC, and the failure reads
 * like a corrupt download rather than a sizing mistake. Create-time floors it;
 * the guest script's own free-space preflight is the backstop.
 */
const REA_MIN_DISK_GB = 40
/**
 * The disk a record must actually have: the REA floor for a RE computer, the
 * recorded size (20 GB when unset) otherwise. `cua sb create` always builds the
 * stock disk, so every rebuild has to re-apply this — the same floor vmCreate
 * applies at create time.
 */
function effectiveDiskGbFor(meta) {
  const configured = Number(meta?.diskGb) > 0 ? Number(meta.diskGb) : 20
  return meta?.rea === true ? Math.max(configured, REA_MIN_DISK_GB) : configured
}

/**
 * Re-apply that size after a rebuild, mirroring vmCreate's own
 * `effectiveDiskGb > 20` grow. growGuestDisk no-ops when the block device is
 * already big enough. Android's identical rebuild gap is pre-existing and
 * deliberately untouched here.
 */
async function regrowDiskAfterRebuild(name, meta) {
  const needGb = effectiveDiskGbFor(meta)
  if (meta?.rea !== true || needGb <= 20) return null
  try {
    const grown = await growGuestDisk(name, needGb)
    log(`disk: ${name} ${grown && grown.changed ? `regrown to ${grown.sizeGb} GB` : `already ${grown?.sizeGb ?? 'unknown'} GB`}`)
    return grown
  } catch (error) {
    log(`disk: ${name} regrow failed (${error.message}); provisioning continues`)
    return null
  }
}

/**
 * QMP LOCATION FOR ONE COMPUTER
 * -----------------------------
 * The listening port is in the QEMU command line cua wrote
 * (`$CUA_HOME/.cua/vmm/qemu/<name>/cmdline`), which is the only source that is
 * always current: `state.json` can lag a restart, and a stale port would send
 * `system_powerdown` to whatever else happens to listen there. `state.json` is
 * the fallback for a cua build that stops writing the cmdline.
 */
function qmpTarget(name) {
  const dir = path.join(CUA_HOME, '.cua', 'vmm', 'qemu', assertVmName(name))
  const cmdlinePath = path.join(dir, 'cmdline')
  if (existsSync(cmdlinePath)) {
    const cmdline = readFileSync(cmdlinePath, 'utf8')
    const matched = /-qmp tcp:(?:[^:]+):(\d+)/u.exec(cmdline)
    if (matched) return { port: Number(matched[1]), host: '127.0.0.1', source: 'cmdline' }
  }
  try {
    const state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'))
    if (Number(state?.qmp_port) > 0) return { port: Number(state.qmp_port), host: '127.0.0.1', source: 'state.json' }
  } catch {}
  return null
}

/** The QEMU pid cua recorded, or 0 when there is no process to signal. */
function qemuPid(name) {
  try {
    const raw = readFileSync(path.join(CUA_HOME, '.cua', 'vmm', 'qemu', assertVmName(name), 'qemu.pid'), 'utf8').trim()
    const pid = Number(raw)
    return Number.isFinite(pid) && pid > 0 ? pid : 0
  } catch {
    return 0
  }
}

/** Is that pid still a live process? EPERM means it exists and is not ours. */
function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

let systemQemuChecked = false
let systemQemuHasVirgl = false

/** Does the distro QEMU in this image carry virtio-gpu-gl-pci? */
function systemQemuSupportsVirgl() {
  if (systemQemuChecked) return systemQemuHasVirgl
  systemQemuChecked = true
  if (!existsSync(SYSTEM_QEMU)) return (systemQemuHasVirgl = false)
  try {
    const help = execFileSync(SYSTEM_QEMU, ['-device', 'help'], { encoding: 'utf8', timeout: 30000 })
    systemQemuHasVirgl = help.includes('virtio-gpu-gl-pci')
  } catch {
    systemQemuHasVirgl = false
  }
  return systemQemuHasVirgl
}

/**
 * Write the PATH shim. `real` is whatever QEMU this image actually has: the
 * distro build when the image was built with WITH_VIRGL_QEMU=1, otherwise
 * cua's own unpacked binary (no virgl, but the share still works).
 */
function installQemuShim() {
  const real = existsSync(SYSTEM_QEMU)
    ? SYSTEM_QEMU
    : path.join(CUA_HOME, '.cua', 'qemu', 'usr', 'bin', 'qemu-system-x86_64')
  if (!existsSync(real)) {
    log('qemu: no QEMU binary found yet; the shim is written after `runtime setup`')
    return false
  }
  const target = path.join(QEMU_SHIM_DIR, 'qemu-system-x86_64')
  const lines = [
    '#!/bin/bash',
    '# Installed by the DSH CUA supervisor (PATH prefix). Rewritten on every start.',
    'args=()',
    'skip=0',
    'for a in "$@"; do',
    '  if [ "$skip" = 1 ]; then skip=0; continue; fi',
    '  case "$a" in',
    '    -virtfs) skip=1 ;;',
    '    *) args+=("$a") ;;',
    '  esac',
    'done'
  ]
  if (SHARE_WORKSPACE) {
    lines.push(`args+=("-virtfs" "local,path=${WORKSPACE_ROOT},mount_tag=${SHARE_TAG},security_model=none,multidevs=remap")`)
  }
  lines.push(`exec ${real} "\${args[@]}"`)
  const body = `${lines.join('\n')}\n`
  try {
    mkdirSync(QEMU_SHIM_DIR, { recursive: true })
    let current = ''
    try { current = readFileSync(target, 'utf8') } catch {}
    if (current !== body) writeFileSync(target, body)
    chmodSync(target, 0o755)
    if (current !== body) log(`qemu: shim -> ${real}${SHARE_WORKSPACE ? ` + 9p share ${SHARE_TAG} -> ${WORKSPACE_ROOT}` : ''}`)
    return true
  } catch (error) {
    log(`qemu: could not write the shim: ${error && error.message}`)
    return false
  }
}

/**
 * QMP, because a disk can be grown *while the guest runs* — and that is the
 * only way to do it here. cua 0.7.0 has no `stop` (suspend pauses QEMU and
 * keeps the qcow2 open), so `qemu-img resize` has no window. QMP's
 * `block_resize` grows the virtual size under a live QEMU; the guest then
 * grows its partition and filesystem online. No downtime, no data loss.
 */
function qmpCommands(port, commands, { timeoutMs = 15000, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, host)
    let buffer = ''
    let stage = 'caps'
    let index = 0
    let settled = false
    const results = []
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error(`QMP did not answer within ${timeoutMs} ms`))
    }, timeoutMs)
    const write = (command) => socket.write(`${JSON.stringify(command)}\n`)
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(results)
    }
    const advance = () => {
      if (index >= commands.length) {
        finish()
        return
      }
      write(commands[index])
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => write({ execute: 'qmp_capabilities' }))
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line.trim() === '') continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.QMP || message.event) continue
        if (stage === 'caps') {
          stage = 'run'
          advance()
          continue
        }
        results.push(message)
        index += 1
        advance()
      }
    })
    socket.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

/**
 * Grow a computer's disk. QMP grows the qcow2 under the running QEMU, then
 * growpart + resize2fs grow the guest filesystem online. Called at create
 * time (android) and by the cua_vm_disk tool.
 */
async function growGuestDisk(name, sizeGb) {
  const bytes = Math.round(Number(sizeGb) * 1024 ** 3)
  if (!Number.isFinite(bytes) || bytes < 8 * 1024 ** 3) throw new Error('disk size must be at least 8 GB')
  const cmdlinePath = path.join(CUA_HOME, '.cua', 'vmm', 'qemu', name, 'cmdline')
  if (!existsSync(cmdlinePath)) return { ok: false, error: 'this computer has no QEMU cmdline (is it running?)' }
  const cmdline = readFileSync(cmdlinePath, 'utf8')
  const port = Number((/-qmp tcp:127\.0\.0\.1:(\d+)/u.exec(cmdline) || [])[1])
  if (!port) return { ok: false, error: 'no QMP socket in the QEMU cmdline' }
  const before = await qmpCommands(port, [{ execute: 'query-block' }])
  const block = (before[0]?.return || []).find((entry) => entry.device === 'disk0')
  const current = Number(block?.inserted?.image?.['virtual-size'] || 0)
  if (current >= bytes) {
    return { ok: true, sizeGb: Math.round(current / 1024 ** 3), changed: false }
  }
  const resized = await qmpCommands(port, [{ execute: 'block_resize', arguments: { device: 'disk0', size: bytes } }])
  if (resized[0]?.error) throw new Error(`block_resize refused: ${resized[0].error.desc || 'unknown'}`)
  // The guest has to notice the bigger block device before the filesystem
  // can. growpart issues BLKPG itself; partprobe is the fallback.
  const grown = await guestExec(name, `sudo -n growpart /dev/vda 3 >/dev/null 2>&1 || sudo -n partprobe /dev/vda >/dev/null 2>&1 || true
sudo -n resize2fs /dev/vda3 >/dev/null 2>&1 || true
df -BG --output=size,avail / | tail -1`, 180000)
  return {
    ok: true,
    sizeGb: Math.round(bytes / 1024 ** 3),
    changed: true,
    guest: grown.stdout.trim()
  }
}

function checkpointSandbox(name) {
  return checkpointDiskFile(name, path.join(CUA_HOME, '.cua', 'vmm', 'qemu', name, 'disk.qcow2'))
}

/**
 * Flatten ANY disk behind `<name>` into `$STORE/checkpoints/<name>.qcow2`.
 *
 * The Linux guest's disk lives under `$CUA_HOME/.cua/vmm/qemu/<name>/`, the
 * Windows computer's under `$STORE/windows/<name>/`. The Windows shutdown used
 * to call the Linux-only helper, which looked in the wrong directory, returned
 * null on every machine, and recorded `checkpointSkipped: "no disk to
 * checkpoint"` — a checkpoint path that existed only in the docs. One writer,
 * one output name, two callers.
 */
function checkpointDiskFile(name, disk) {
  if (!existsSync(disk)) return null
  const target = path.join(CHECKPOINT_DIR, `${name}.qcow2`)
  try {
    mkdirSync(CHECKPOINT_DIR, { recursive: true })
    // FLATTEN. A plain copy keeps the backing chain, and a disk that was itself
    // created from the previous restore file turns that chain into a cycle
    // ("Could not open backing file … Too many open files"). `convert` follows
    // the chain once and writes a self-contained disk, which is what a restore
    // needs.
    execFileSync(qemuImgPath(), ['convert', '-O', 'qcow2', disk, `${target}.tmp`], { timeout: 180000 })
    renameSync(`${target}.tmp`, target)
    log(`checkpoint ${name}: ${(statSync(target).size / 1024 ** 2).toFixed(1)} MB (flattened)`)
    return target
  } catch (error) {
    log(`checkpoint ${name} failed: ${error && error.message}`)
    try { unlinkSync(`${target}.tmp`) } catch {}
    return null
  }
}

/** cua's own qemu-img, or the distro one; never a hard failure. */
function qemuImgPath() {
  const local = path.join(CUA_HOME, '.cua', 'bin', 'qemu-img')
  return existsSync(local) ? local : 'qemu-img'
}

/** Every file this store holds for one computer, as absolute paths. */
/** Bytes of the live disk, or 0 when there is none (checkpoint sizing). */
function diskBytesFor(name) {
  try {
    return statSync(path.join(CUA_HOME, '.cua', 'vmm', 'qemu', assertVmName(name), 'disk.qcow2')).size
  } catch {
    return 0
  }
}

function checkpointFilesFor(name) {
  const safe = assertVmName(name)
  try {
    return readdirSync(CHECKPOINT_DIR)
      .filter((file) => file === `${safe}.qcow2` || file.startsWith(`${safe}.qcow2.`))
      .map((file) => path.join(CHECKPOINT_DIR, file))
  } catch {
    return []
  }
}

function shotFilesFor(name) {
  const safe = assertVmName(name)
  try {
    return readdirSync(path.join(STORE, 'shots'))
      .filter((file) => file.startsWith(`${safe}-`))
      .map((file) => path.join(STORE, 'shots', file))
  } catch {
    return []
  }
}

/**
 * THE DELETE MANIFEST
 * -------------------
 * A computer is not one `sb rm`. It is: a sandbox record, a QEMU directory with
 * a 6 GB delta, a flattened checkpoint (plus the `.restore.qcow2` boot temp the
 * restore path copies), hundreds of screenshot PNGs, a port-forward child
 * process and its ports.json row, a viewer row, a trajectory directory, and — for
 * a Windows computer — a container plus its storage tree. Deleting only the
 * sandbox left all of that behind, and the next create on the same name booted
 * the OLD checkpoint because the restore file was still there.
 *
 * Every item is attempted, every item is reported, and a failure on one never
 * stops the rest: a wedged `sb rm` must not keep the 6 GB checkpoint alive.
 */
async function destroyVm(name, { reason = 'delete', deleteContainer = true, force = false } = {}) {
  return withVmLock(name, () => destroyVmLocked(name, { reason, deleteContainer, force }))
}

/** Caller already holds the computer's lifecycle lock. */
async function destroyVmLocked(name, { reason = 'delete', deleteContainer = true, force = false } = {}) {
  // First statement, before any path is built.
  assertVmName(name)
  const items = []
  // THE ROW DECIDES WHAT KIND OF COMPUTER THIS IS, before anything is removed:
  // a `kind: 'windows'` row has NO cua sandbox, so `cua sb rm --local <name>` is
  // guaranteed to fail and used to fail the whole manifest.
  const subject = (() => {
    try {
      return readRegistry().vms[name] ?? null
    } catch {
      return null
    }
  })()
  const isWindows = subject?.kind === 'windows' || subject?.backend === 'qemu'
  const record = (target, status, detail) => {
    items.push({ target, status, ...(detail ? { detail } : {}) })
    if (status === 'failed') log(`destroy ${name}: ${target} failed (${detail})`)
  }
  /**
   * EVERY STEP IS ITS OWN TRY/CATCH.
   *
   * One unguarded step (the `views.json` write was the obvious one) would throw
   * out of the manifest and skip everything after it — the trajectory and QEMU
   * directories, the container, the registry row — leaving a half-deleted
   * computer that the panel still showed. `record` reports the failure and the
   * next step runs.
   */
  const step = async (label, fn) => {
    try {
      await fn()
    } catch (error) {
      record(label, 'failed', error?.message ?? String(error))
    }
  }

  // 0. FORCE DELETE KILLS FIRST. The manifest can only unlink a disk safely when
  //    nothing holds it, and the two things that hold a Windows disk are QEMU and
  //    swtpm — neither of which the ordinary path is allowed to kill behind a
  //    live guest's back. With `force`, the process tree goes FIRST, its death is
  //    VERIFIED (pidAlive), and only then does the same manifest run with that
  //    truth. The order is the whole promise: killing after the unlink is how a
  //    store gets corrupted, and claiming "gone" without checking is how the
  //    panel ends up offering Delete for ever.
  const forced = { requested: force === true, killed: [] }
  if (force === true) {
    const pidBefore = isWindows ? windowsBackend.qemuPid(name) : qemuPid(name)
    const wasAlive = pidBefore > 0 && pidAlive(pidBefore)
    try {
      if (isWindows) {
        const outcome = await windowsBackend.forceKill(name, { waitMs: 5000 })
        forced.killed.push({
          target: `windows qemu (pid ${outcome.pid || 'none'})`,
          status: outcome.qemuGone ? 'removed' : 'failed',
          detail: outcome.detail
        })
        record(`windows qemu (pid ${outcome.pid || 'none'})`, outcome.qemuGone ? 'removed' : 'failed', outcome.detail)
        if (!outcome.swtpmGone) {
          record(`swtpm (pid ${outcome.swtpmPid})`, 'failed', 'swtpm is still running and holds the TPM state; the disk can be removed but the next boot will fail with "TPM is already in use"')
        }
      } else if (wasAlive) {
        // A Linux computer's QEMU belongs to cua; killing it by pid is the last
        // resort and only ever happens behind `force`.
        try { process.kill(pidBefore, 'SIGKILL') } catch {}
        const deadline = Date.now() + 5000
        while (Date.now() < deadline && pidAlive(pidBefore)) await new Promise((resolve) => setTimeout(resolve, 100))
        record(`cua qemu (pid ${pidBefore})`, pidAlive(pidBefore) ? 'failed' : 'removed', pidAlive(pidBefore) ? 'the QEMU process survived SIGKILL' : 'killed on request (force delete)')
      }
      // websockify / preview relays: killed by the live-view bookkeeping, then
      // the ports are closed below as usual.
      stopLiveView(name)
    } catch (error) {
      record('force kill', 'failed', error?.message ?? String(error))
    }
  }

  // 1. Port forwards and relays first: a still-listening relay would answer the
  //    browser for a guest that is about to disappear.
  // Guarded: `readRegistry` throws on a corrupt file, and a delete must still
  // produce a structured manifest when the registry is unreadable (R2).
  try {
    for (const port of Object.values(readRegistry().vms[name]?.ports ?? {})) CLAIMED_WINDOWS_PORTS.delete(Number(port))
  } catch {}

  const closed = closePorts(name)
  record('ports.json', closed.rows > 0 ? 'removed' : 'absent', closed.rows > 0 ? `${closed.rows} row(s), ${closed.killed} child process(es) stopped` : 'no row')

  // 2. The sandbox itself. A failure here is REPORTED and changes the SHAPE of
  //    the delete (see step 9): a sandbox cua still owns must not lose its row.
  //
  //    A WINDOWS ROW HAS NO CUA SANDBOX. Running `sb rm --local win-test` there
  //    can only fail ("sandbox not found"), and it failed the MANIFEST — which is
  //    the user report `Partially deleted win-test — failed: sb rm --force`, on a
  //    row whose disks were gone and whose name stayed unusable. So the step is
  //    skipped for Windows (recorded as `skipped` with the reason, not silently),
  //    and `sandboxGone` starts TRUE: there is no sandbox to be gone.
  let sandboxGone = true
  if (isWindows) {
    // `not-applicable` is INFORMATIONAL: neither a failure nor a kept disk, so it
    // does not stop the manifest from being complete. (A `skipped` item means
    // "deliberately kept", which is a different promise.)
    record('sb rm --force', 'not-applicable', 'a Windows computer has no cua sandbox (direct QEMU: its disks and its row are removed below)')
  } else {
    const removed = await runCua(['sb', 'rm', '--local', name, '--force'], { timeoutMs: 180000 })
    sandboxGone = removed.code === 0
    record('sb rm --force', sandboxGone ? 'removed' : 'failed', sandboxGone ? '' : (removed.stderr || removed.stdout).trim().slice(-300))
  }

  // 3. Checkpoints, including the restore temp and any interrupted convert.
  await step('checkpoints', async () => {
    const checkpoints = checkpointFilesFor(name)
    if (checkpoints.length === 0) { record('checkpoints', 'absent'); return }
    for (const file of checkpoints) {
      try {
        unlinkSync(file)
        record(file, 'removed')
      } catch (error) {
        record(file, 'failed', error.message)
      }
    }
  })

  // 4. Screenshots. The supervisor writes `<name>-<stamp>.png` and the region
  //    crop adds `-crop`; both start with the name and a dash.
  await step('shots', async () => {
    const shots = shotFilesFor(name)
    if (shots.length === 0) { record('shots', 'absent'); return }
    for (const file of shots) {
      try {
        unlinkSync(file)
        record(file, 'removed')
      } catch (error) {
        record(file, 'failed', error.message)
      }
    }
  })

  // 5. The viewer row. `writeViews` is a file write: it can throw, and before
  //    this wrapper did, that throw skipped the rest of the manifest.
  await step('views.json', async () => {
    const views = readViews()
    if (!views[name]) { record('views.json', 'absent'); return }
    delete views[name]
    writeViews(views)
    record('views.json', 'removed')
  })

  // 6. cua's trajectory history and its QEMU state directory.
  await step('trajectories', async () => {
    for (const target of [
      path.join(CUA_HOME, '.cua', 'trajectories', `local_${name}`),
      path.join(CUA_HOME, '.cua', 'trajectories', name)
    ]) {
      if (!existsSync(target)) { record(target, 'absent'); continue }
      try {
        rmSync(target, { recursive: true, force: true })
        record(target, 'removed')
      } catch (error) {
        record(target, 'failed', error.message)
      }
    }
  })

  // 7. The QEMU directory holds the live disk and the pid file. Removing it
  //    while QEMU is alive would delete the file out from under a running
  //    process (the delete would "succeed" and the guest would keep writing to
  //    an unlinked inode) — and the next start would then boot a stale image.
  await step('vmm/qemu', async () => {
    const vmDir = path.join(CUA_HOME, '.cua', 'vmm', 'qemu', name)
    if (!existsSync(vmDir)) { record(vmDir, 'absent'); return }
    const pid = qemuPid(name)
    if (pidAlive(pid)) {
      record(vmDir, 'skipped', `QEMU (pid ${pid}) is still running; its disk is not deleted under it — stop the process first (cua_vm_shutdown) and delete again`)
      return
    }
    try {
      rmSync(vmDir, { recursive: true, force: true })
      record(vmDir, 'removed')
    } catch (error) {
      record(vmDir, 'failed', error.message)
    }
  })

  // 8. The Windows tree: disk, EFI vars, TPM state, OEM payload, credentials and
  //    the two sockets. QEMU is a child of this process, so it is killed first —
  //    deleting a qcow2 under a live guest is how a store gets corrupted.
  await step('windows store', async () => {
    const already = readRegistry().vms[name]
    const windowsStore = path.join(WINDOWS_DIR, name)
    if (already?.kind !== 'windows' && !existsSync(windowsStore)) return
    // H6: CHECK LIVENESS BEFORE ANYTHING IS KILLED OR UNLINKED. The first
    // version killed the process and THEN asked whether it was alive, which is
    // always false — so the guard never fired.
    const windowsPid = windowsBackend.qemuPid(name)
    if (windowsBackend.pidAlive(windowsPid)) {
      record(windowsStore, 'skipped', `QEMU (pid ${windowsPid}) is still running; its disk is not deleted under it — stop it with cua_vm_shutdown and delete again`)
      return
    }
    if (deleteContainer) {
      try {
        windowsBackend.kill(name)
        record('windows qemu', 'stopped', 'no live qemu; swtpm stopped')
      } catch (error) {
        record('windows qemu', 'failed', error?.message ?? String(error))
      }
      stopLiveView(name)
    }
    for (const target of [windowsPaths(STORE, name).tpmSocket, windowsPaths(STORE, name).tpmPid]) {
      try { unlinkSync(target) } catch {}
    }
    if (!existsSync(windowsStore)) {
      record(windowsStore, 'absent')
      return
    }
    try {
      rmSync(windowsStore, { recursive: true, force: true })
      record(windowsStore, 'removed')
    } catch (error) {
      record(windowsStore, 'failed', error.message)
    }
  })

  // 9. The registry row.
  //
  //    When `sb rm` FAILED the sandbox may still exist, and deleting the row
  //    would leave an orphan cua knows about and the harness does not: the name
  //    becomes permanently unusable (create refuses "already exists") with
  //    nothing in the UI to delete. Keep the row and mark it orphaned instead;
  //    cua_vm_gc reconciles it against `sb ls` once the sandbox is really gone.
  // R2: THE ROW WRITE IS A MANIFEST STEP TOO. `mutateRegistry` throws when the
  // registry cannot be read, and before this wrapper that throw escaped
  // `destroyVm` AFTER the checkpoints, shots and QEMU directory were already
  // unlinked: the caller got a bare error with no `items`, no `failed`, no
  // `complete`, and no way to tell what had happened.
  await step('registry.json', async () => {
    const diskKept = items.some((item) => item.status === 'skipped')
    const hadRow = Boolean(readRegistry().vms[name])
    if (hadRow && (!sandboxGone || diskKept)) {
      await mutateRegistry((registry) => {
        const row = registry.vms[name]
        if (!row) return
        row.orphaned = true
        row.orphanReason = diskKept
          ? 'the QEMU directory was kept because the process is still running; cua_vm_gc reclaims it once QEMU is gone'
          : 'sb rm failed during delete; the sandbox may still exist'
        row.orphanedAt = new Date().toISOString()
      })
      record('registry.json', 'kept', 'the row is marked orphaned (cua_vm_gc reconciles it)')
    } else if (hadRow) {
      await mutateRegistry((registry) => { delete registry.vms[name] })
      record('registry.json', 'removed')
    } else {
      record('registry.json', 'absent')
    }
  })

  const failures = items.filter((item) => item.status === 'failed')
  // A `skipped` item is a DELIBERATE leftover, not a success: the QEMU directory
  // of a computer whose process is still running is skipped so the disk is not
  // deleted under a live guest. Counting it as completion is how the panel came
  // to say "destroyed" about a computer whose 6 GB disk was still on the volume
  // and unreachable (the row had been dropped).
  const skipped = items.filter((item) => item.status === 'skipped')
  const complete = failures.length === 0 && skipped.length === 0 && sandboxGone
  log(`destroy ${name} (${reason}${forced.requested ? ', FORCE' : ''}): ${items.filter((item) => item.status === 'removed').length}/${items.length} item(s) removed${failures.length ? `, ${failures.length} failed` : ''}${skipped.length ? `, ${skipped.length} kept` : ''}${complete ? '' : ' (INCOMPLETE)'}`)
  return {
    name,
    // `deleted` stays truthful: a partial manifest is not a deletion.
    deleted: complete,
    complete,
    items,
    failures: failures.length,
    failed: failures.map((item) => ({ target: item.target, detail: item.detail ?? '' })),
    kept: skipped.map((item) => ({ target: item.target, reason: item.detail ?? '' })),
    // WHAT FORCE ACTUALLY DID, so the panel and the tool can report it instead
    // of implying the kill happened because it was asked for.
    force: forced.requested ? { requested: true, killed: forced.killed } : undefined,
    ...(complete ? {} : {
      detail: skipped.length > 0
        ? 'partially deleted — the disk was kept (QEMU still holds it); it stays reachable through the orphaned row. Run cua_vm_gc after the process is gone to reclaim it.'
        : sandboxGone
          ? `${failures.length} item(s) could not be removed; the registry row was kept. Force delete kills the process and removes what is left.`
          : 'the sandbox could not be removed, so the registry row is kept and marked orphaned; run cua_vm_gc after the sandbox is gone. Force delete kills the process and removes what is left.'
    }),
    // Offered by the panel (a button) and the tool (`force: true`): the same
    // manifest, preceded by a verified kill.
    canForce: complete ? undefined : true
  }
}

/**
 * GARBAGE COLLECTION
 * ------------------
 * Five classes of debris, each with a rule that cannot delete a live disk:
 *
 *   restore temps   every `*.restore.qcow2` is a boot temp; the start path
 *                   deletes its own, so any that survived a crash are debris.
 *   checkpoints     the newest file per name is the restore point. A name with
 *                   no registry row is an orphan (its computer was deleted by an
 *                   older build, before the manifest existed): keep the newest,
 *                   drop the rest.
 *   shots           older than config.shotsKeepDays (0 = keep for ever).
 *   views           rows for computers that are gone, or past their expiry.
 *   ports           rows whose local port is not listening any more.
 */
async function collectGarbage({ dryRun = false } = {}) {
  // ONE GC AT A TIME, AND ONE COMPUTER AT A TIME INSIDE IT.
  //
  // The checkpoint directory is shared with two asynchronous users: a shutdown
  // that is flattening a disk into a checkpoint, and a start that is booting
  // from `<name>.qcow2.restore.qcow2`. `remove()` is a synchronous unlink, so
  // nothing protected a `.tmp` that a convert was writing or a restore temp a
  // create was about to open — GC could delete either one mid-flight. The
  // lifecycle ops hold `withVmLock(name)` for their whole duration and GC now
  // takes the same lock per name, so it waits for them instead of racing them.
  return withLock('@gc', async () => {
    const config = readConfig()
    let registry = readRegistry()
    const report = { checkpoints: [], shots: [], views: [], ports: [], orphans: [], isos: [], sandboxes: [], bytesFreed: 0, errors: [] }
    const remove = (file, bytes) => {
      if (!dryRun) {
        try { unlinkSync(file) } catch (error) { report.errors.push(`${file}: ${error.message}`); return }
      }
      report.bytesFreed += bytes
    }
    const sizeOf = (file) => { try { return statSync(file).size } catch { return 0 } }

    // ---------------------------------------------------------------
    // RECONCILE ORPHANED ROWS (see destroyVm step 9): a row kept because its
    // sandbox could not be removed is only safe to drop once cua no longer
    // lists the sandbox. Until then it stays visible — the alternative is a
    // name nobody can create and nobody can delete.
    // ---------------------------------------------------------------
    const orphans = Object.entries(registry.vms).filter(([, row]) => row?.orphaned === true)
    if (orphans.length > 0) {
      const { parsed } = await listSandboxes()
      const listed = new Set((Array.isArray(parsed) ? parsed : []).map((row) => row?.name ?? row?.id ?? ''))
      for (const [name] of orphans) {
        await withVmLock(name, async () => {
          const stillThere = listed.has(name)
          if (stillThere) {
            report.orphans.push({ name, sandbox: 'still listed by cua', action: 'kept' })
            return
          }
          // The sandbox is gone, but the DISK may still be held by a live QEMU:
          // that is exactly why it was kept at delete time. Reclaiming it now
          // would delete the file out from under the process.
          const pid = qemuPid(name)
          if (pidAlive(pid)) {
            report.orphans.push({ name, sandbox: 'gone from cua', action: `kept: QEMU (pid ${pid}) still running` })
            return
          }
          // SAFE TO RECLAIM: cua no longer knows the sandbox and no process holds
          // the directory, so the leftover disk, its checkpoints, screenshots and
          // rows go, and then the row that made them reachable.
          const reclaimed = []
          if (dryRun) {
            report.orphans.push({ name, sandbox: 'gone from cua', action: 'would reclaim the kept disk and drop the row' })
            return
          }
          await withVmLock(name, async () => {
            const vmDir = path.join(CUA_HOME, '.cua', 'vmm', 'qemu', name)
            if (existsSync(vmDir)) {
              try { rmSync(vmDir, { recursive: true, force: true }); reclaimed.push(vmDir) } catch (error) { report.errors.push(`${vmDir}: ${error.message}`) }
            }
            for (const file of checkpointFilesFor(name)) {
              try { unlinkSync(file); reclaimed.push(file) } catch (error) { report.errors.push(`${file}: ${error.message}`) }
            }
            for (const file of shotFilesFor(name)) {
              try { unlinkSync(file); reclaimed.push(file) } catch (error) { report.errors.push(`${file}: ${error.message}`) }
            }
            const views = readViews()
            if (views[name]) {
              delete views[name]
              try { writeViews(views) } catch (error) { report.errors.push(`views.json: ${error.message}`) }
            }
            closePorts(name)
            await mutateRegistry((fresh) => { delete fresh.vms[name] })
          })
          report.orphans.push({ name, sandbox: 'gone from cua', action: 'reclaimed the kept disk and dropped the row', reclaimed })
          registry = readRegistry()
        })
      }
      // A sandbox cua lists with NO row is not ours to delete (it may belong to
      // another workspace or a previous install); report it so the cause is
      // visible instead of silently accumulating disks.
      for (const row of (Array.isArray(parsed) ? parsed : [])) {
        const vmName = row?.name ?? row?.id ?? ''
        if (vmName === '' || registry.vms[vmName]) continue
        report.sandboxes.push({ name: vmName, status: String(row?.status ?? row?.phase ?? 'unknown') })
      }
    }

  // 2b. M1: the ISO cache. It is counted by the quota now, but nothing ever
  // removed from it: five versions plus virtio-win is ~25 GB that survives every
  // delete. An ISO no row references and that is older than the retention
  // policy is reported (and removed unless this is a dry run).
  if (config.shotsKeepDays > 0) {
    const referenced = new Set(Object.values(readRegistry().vms)
      .map((row) => row?.isoPath)
      .filter((value) => typeof value === 'string' && value !== ''))
    // X4: SHARED MEDIA IS NOT AN ORPHAN. The virtio-win drivers ISO is configured
    // by env and referenced by no row, and the one pinned evaluation ISO is the
    // fallback for every new computer — pruning either silently downgrades the
    // next boot (no virtio-blk/NIC) or forces a 5.5 GB re-download.
    const alwaysKeep = new Set([
      path.join(ISO_DIR, 'virtio-win.iso'),
      ...(process.env.DSH_CUA_WINDOWS_VIRTIO_ISO ? [path.resolve(process.env.DSH_CUA_WINDOWS_VIRTIO_ISO)] : []),
      // Z3: through isoTargetPath, so the name is the one ensureIso actually
      // writes (sanitised + digested); a raw basename would stop matching as
      // soon as a URL carries a character the sanitiser rewrites.
      ...Object.values(WINDOWS_ISO_SOURCES)
        .filter((entry) => typeof entry.url === 'string')
        .map((entry) => isoTargetPath(ISO_DIR, entry.url))
    ])
    const keepMs = config.shotsKeepDays * 24 * 60 * 60 * 1000
    let isos = []
    try { isos = readdirSync(ISO_DIR).filter((file) => file.endsWith('.iso') || file.endsWith('.iso.part')) } catch {}
    for (const file of isos) {
      const absolute = path.join(ISO_DIR, file)
      if (referenced.has(absolute)) continue
      if (alwaysKeep.has(absolute) || alwaysKeep.has(path.join(ISO_DIR, file.replace(/\.part$/u, '')))) continue
      let ageMs = 0
      let bytes = 0
      try {
        const info = statSync(absolute)
        ageMs = Date.now() - info.mtimeMs
        bytes = info.size
      } catch {
        continue
      }
      if (ageMs < keepMs) continue
      report.isos.push({ file: absolute, bytes, ageDays: Math.round(ageMs / 86400000) })
      if (!dryRun) {
        try {
          unlinkSync(absolute)
          report.bytesFreed += bytes
        } catch (error) {
          report.errors.push(`${absolute}: ${error.message}`)
        }
      }
    }
  }

    // Every entry in the checkpoint directory, grouped by the computer name.
    let entries = []
    try {
      entries = readdirSync(CHECKPOINT_DIR)
    } catch {
      entries = []
    }
    const groups = new Map()
    const restoreTemps = new Map()
    for (const file of entries) {
      const match = /^(.+?)\.qcow2(?:\.(.+))?$/u.exec(file)
      if (!match) continue
      const groupName = match[1]
      const suffix = match[2] || ''
      const full = path.join(CHECKPOINT_DIR, file)
      const bucket = (suffix === 'restore' ? restoreTemps : groups)
      const list = bucket.get(groupName) || []
      list.push({ file: full, suffix, at: (() => { try { return statSync(full).mtimeMs } catch { return 0 } })() })
      bucket.set(groupName, list)
    }

    /** One computer's checkpoint decisions, serialised against its lifecycle. */
    const collectFor = async (groupName, files) => {
      const safely = VM_NAME_PATTERN.test(groupName)
      const run = async () => {
        const registered = safely && Boolean(registry.vms[groupName])
        const stable = files.filter((entry) => entry.suffix === '').sort((a, b) => b.at - a.at)
        const tmp = files.filter((entry) => entry.suffix === 'tmp').sort((a, b) => b.at - a.at)
        for (const junk of files.filter((entry) => entry.suffix !== '' && entry.suffix !== 'tmp')) {
          report.checkpoints.push({ file: junk.file, reason: `unrecognised checkpoint artifact (.${junk.suffix})` })
          remove(junk.file, sizeOf(junk.file))
        }
        // HEAL, don't delete: a registered computer whose only checkpoint is a
        // `.tmp` had its convert killed. The data is complete — `rename` was the
        // step that never ran — so promote the newest temp instead of throwing
        // away the last copy of the disk.
        if (registered && stable.length === 0 && tmp.length > 0 && !dryRun) {
          const newest = tmp.shift()
          try {
            renameSync(newest.file, path.join(CHECKPOINT_DIR, `${groupName}.qcow2`))
            log(`gc: promoted ${path.basename(newest.file)} to ${groupName}.qcow2 (interrupted convert)`)
          } catch (error) {
            report.errors.push(`${newest.file}: ${error.message}`)
          }
        }
        for (const stale of tmp) {
          report.checkpoints.push({ file: stale.file, reason: registered ? 'interrupted convert (superseded)' : 'orphan temp (no computer)' })
          remove(stale.file, sizeOf(stale.file))
        }
        if (stable.length > 1) {
          for (const older of stable.slice(1)) {
            report.checkpoints.push({ file: older.file, reason: registered ? 'superseded checkpoint' : 'orphan (no computer)' })
            remove(older.file, sizeOf(older.file))
          }
        }
      }
      return safely ? withVmLock(groupName, run) : run()
    }

    for (const [groupName, files] of groups) {
      await collectFor(groupName, files)
    }
    // Restore temps: `start` deletes its own, so a survivor is from a crash —
    // unless a start is running right now, which the lock decides.
    for (const [groupName, files] of restoreTemps) {
      const safely = VM_NAME_PATTERN.test(groupName)
      const run = async () => {
        for (const entry of files) {
          report.checkpoints.push({ file: entry.file, reason: 'restore temp' })
          remove(entry.file, sizeOf(entry.file))
        }
      }
      await (safely ? withVmLock(groupName, run) : run())
    }

    // Screenshots past the retention window.
    if (config.shotsKeepDays > 0) {
      const cutoff = Date.now() - config.shotsKeepDays * 86400000
      let shots = []
      try { shots = readdirSync(path.join(STORE, 'shots')) } catch { shots = [] }
      for (const file of shots) {
        if (!file.endsWith('.png')) continue
        const full = path.join(STORE, 'shots', file)
        let at = 0
        try { at = statSync(full).mtimeMs } catch { continue }
        if (at > cutoff) continue
        report.shots.push({ file: full, reason: `older than ${config.shotsKeepDays} day(s)` })
        remove(full, sizeOf(full))
      }
    }

    // Viewer rows: a computer that is gone, or a ticket that expired.
    const views = readViews()
    let viewsChanged = false
    for (const [name, entry] of Object.entries(views)) {
      const expired = Number(entry?.expiresAt) > 0 && Number(entry.expiresAt) < Date.now()
      if (registry.vms[name] && !expired) continue
      report.views.push({ name, reason: registry.vms[name] ? 'expired' : 'no computer' })
      delete views[name]
      viewsChanged = true
    }
    if (viewsChanged && !dryRun) {
      try { writeViews(views) } catch (error) { report.errors.push(`views.json: ${error.message}`) }
    }

    // Ports: rows whose forward/relay is gone, or that name a computer nobody
    // owns. Both backends answer the same two questions (alive/stop), so a relay
    // and a cua forward are cleaned up by the same rule.
    for (const [name, entry] of [...ports]) {
      const alive = typeof entry?.alive === 'function' ? entry.alive() : Boolean(entry?.child && entry.child.exitCode === null)
      const listening = alive ? !(await portIsFree(entry.localPort)) : false
      if (alive && listening && registry.vms[name]) continue
      report.ports.push({ name, localPort: entry?.localPort ?? 0, reason: !registry.vms[name] ? 'no computer' : 'forward is gone' })
      closePorts(name)
    }
    await reconcilePorts()

    log(`gc: ${report.checkpoints.length} checkpoint(s), ${report.shots.length} shot(s), ${report.views.length} view(s), ${report.ports.length} port(s), ${report.orphans.length} orphan row(s)${dryRun ? ' (dry run)' : ''}, ${(report.bytesFreed / 1024 ** 2).toFixed(1)} MB freed`)
    return { ...report, dryRun, usedBytes: await storeUsedBytes() }
  })
}

/** VMs whose screenshot space cua already knows (see the gui pointer branch). */
const SHOT_STATE = new Set()
/** Which computer `cua do` is pointed at — switching resets the zoom state. */
let DO_TARGET = ''

/* ------------------------------------------------------------------ *
 * CREATE — one spec, two backends, one set of rules
 * ------------------------------------------------------------------ */

/**
 * Every default a create can have, in one object.
 *
 * WHY AN EXPLICIT NORMALISER: `ensure` used to build its own registry row with a
 * different set of fields from `vmCreate`, so a computer created by "the first
 * cua_vm_exec" and one created by the panel differed in whether they recorded an
 * image, a disk size, `gpu` or `android`. The differences were invisible until a
 * rebuild had to restore one: ensure's recreate asked for `known?.gpu` and got
 * `undefined`, and the computer came back without its GPU. One spec, normalised
 * once, is the fix.
 *
 * `rea: false` here is the gate needle: a computer is never born with the RE kit
 * unless the caller asked for it in so many words.
 */
const SPEC_DEFAULTS = {
  name: '',
  kind: 'linux',
  tier: 'slim',
  cpu: 2,
  memory: 4,
  image: 'linux',
  gpu: false,
  diskGb: 0,
  android: false,
  rea: false,
  windowsVersion: '11',
  windowsIso: '',
  // S3: optional product key for a licensed (non-evaluation) operator ISO.
  windowsKey: '',
  // F2: which edition to install. 0 / '' = resolve from windowsVersion (see
  // WINDOWS_IMAGE_SELECTIONS); a number/year pair wins for an operator ISO.
  windowsImageIndex: 0,
  windowsImageName: '',
  waitDesktop: false,
  workspace: WORKSPACE_ROOT
}

/** States that occupy a `maxRunning` slot. `installing` is one of them. */
const RUNNING_STATES = new Set(['ready', 'running', 'installing'])

/**
 * The GPU default. DSH_CUA_VM_GPU=virgl means "this host can do virgl", so a
 * create that does not mention gpu GETS it — that was the whole point of the
 * switch, and until now the variable was read into GPU_MODE and never used.
 * An explicit `gpu: false` always wins (someone who wants llvmpipe on a GPU host
 * is entitled to it), and the flag is gated on the QEMU that is actually
 * installed: asking cua for `--gpu virgl` with a QEMU that has no
 * virtio-gpu-gl-pci fails the create with a message about a missing device.
 */
const GPU_MODES = new Set(['virgl', '1', 'on', 'true', 'yes'])

function gpuDefault() {
  if (!GPU_MODES.has(String(process.env.DSH_CUA_VM_GPU || '').trim().toLowerCase())) return false
  return systemQemuSupportsVirgl()
}

/** One spec shape for every caller. Unknown keys are dropped, not forwarded. */
function normaliseSpec(input = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const flags = { android: input.android === true, rea: input.rea === true }
  const int = (value, fallback, min, max) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback
  }
  const kind = raw.kind === 'windows' ? 'windows' : 'linux'
  return {
    name: String(raw.name ?? '').trim(),
    kind,
    tier: String(raw.tier || SPEC_DEFAULTS.tier),
    cpu: int(raw.cpu, SPEC_DEFAULTS.cpu, 1, 16),
    memory: int(raw.memory, SPEC_DEFAULTS.memory, 1, 64),
    image: String(raw.image || SPEC_DEFAULTS.image),
    // omitted = the host default; explicit false = llvmpipe, on purpose
    gpu: raw.gpu === undefined || raw.gpu === null ? gpuDefault() : raw.gpu === true,
    diskGb: Number(raw.diskGb) > 0 ? Math.trunc(Number(raw.diskGb)) : 0,
    android: flags.android,
    rea: flags.rea,
    windowsVersion: String(raw.windowsVersion || SPEC_DEFAULTS.windowsVersion),
    windowsIso: String(raw.windowsIso || ''),
    // S3: only non-evaluation media need it; validated in windowsCreateManaged.
    windowsKey: String(raw.windowsKey || '').trim(),
    // F2: the edition selector. `0` means "use the version table".
    windowsImageIndex: Number(raw.windowsImageIndex) > 0 ? Math.trunc(Number(raw.windowsImageIndex)) : 0,
    windowsImageName: String(raw.windowsImageName || '').trim(),
    waitDesktop: raw.waitDesktop === true,
    workspace: String(raw.workspace || WORKSPACE_ROOT)
  }
}

/**
 * The Linux create. NO LOCK of its own (see vmCreate/ensure): the caller holds
 * it for the whole create+provision, so two "first exec" calls cannot both
 * decide the computer is missing.
 */
async function createManaged(spec) {
  const { name, rea } = spec
  const registry = readRegistry()
  if (registry.vms[name]) throw new Error(`a computer named "${name}" already exists`)
  if (spec.kind === 'windows') return windowsCreateManaged(spec)

  const config = readConfig()
  const running = Object.values(registry.vms).filter((meta) => RUNNING_STATES.has(meta?.state)).length
  if (running >= config.maxRunning) {
    return fail(`VM limit reached (${running}/${config.maxRunning} running). Start/suspend one, or raise the limit above.`)
  }
  // Disk sizing happens BEFORE the quota check, because a REA computer's
  // minimum is a property of the workload, not of what the caller typed.
  const wantedDiskGb = Number(spec.diskGb) > 0 ? Number(spec.diskGb) : 20
  const effectiveDiskGb = rea === true ? Math.max(wantedDiskGb, REA_MIN_DISK_GB) : wantedDiskGb
  // THE DISK IS SPARSE, SO ITS VIRTUAL SIZE IS NOT A WRITE. The create reserves
  // ZERO bytes (which still refuses when the store's real usage is ALREADY over
  // the policy) and carries a `disk-over-policy` warning when the requested disk
  // is bigger than the policy. A 40 GB REA disk on a 20 GB quota is created; it
  // used to be refused here, which contradicted the real-bytes accounting.
  const warnings = diskPolicyWarnings(effectiveDiskGb, config)
  const over = await reserveStoreBytes(name, 0)
  if (over !== null) return fail(over)
  // The claim is held for the whole create, so a SECOND create sees it.
  try {
    return await createLinuxNow(spec, warnings)
  } finally {
    releaseStoreBytes(name)
  }
}

/**
 * WHY THE LINUX PATH DOES NOT REFUSE UP FRONT.
 *
 * `cua sb create` is the only thing that knows whether it can use the device,
 * and this branch shipped without a preflight of its own — adding a refusal
 * would change behaviour. What it CAN do is stop relaying cua's opaque failure
 * ("qemu exited" / "KVM is not available") when the supervisor already knows
 * the device is present but denied: that is the user's reported symptom, and the
 * gid/group_add fix is the only thing that resolves it.
 */
function linuxKvmFailureHint() {
  const kvm = kvmStatus()
  if (kvm.state === 'ok') return ''
  const error = kvmPreflightError(kvm, { purpose: 'the Linux VM (cua sb create)' })
  return error === null ? '' : `\n\n${error.message}`
}

/** The create itself, with the store quota already reserved for this name. */
async function createLinuxNow(spec, warnings = []) {
  const { name, rea } = spec
  const wantedDiskGb = Number(spec.diskGb) > 0 ? Number(spec.diskGb) : 20
  const effectiveDiskGb = rea === true ? Math.max(wantedDiskGb, REA_MIN_DISK_GB) : wantedDiskGb
  const blocked = resolutionProblem(DESKTOP_RESOLUTION, RESOLUTION_ALLOW_SCALE)
  if (blocked !== null) return fail(blocked)

  await ensureRuntime()
  installQemuShim()
  const created = await runCua(createArgs(name, spec.tier, spec.cpu, spec.memory, spec.waitDesktop, spec.image, spec.gpu), { timeoutMs: 1500000 })
  if (created.code !== 0) return fail(`${(created.stderr || created.stdout).trim().slice(-1500)}${linuxKvmFailureHint()}`)
  await mutateRegistry((fresh) => {
    fresh.vms[name] = {
      // R2: the same `name` field the Windows rows carry; a row IS reachable by
      // its map key either way, but every reader that takes a row (rather than
      // a name) needs the field to survive `...row` copies.
      name: spec.name,
      workspace: spec.workspace,
      kind: 'linux',
      backend: 'linux',
      image: spec.image,
      tier: spec.tier,
      gpu: spec.gpu,
      // Kept so the panel can show a GPU / Android / REA indicator per
      // computer long after creation, without asking the guest.
      android: spec.android,
      rea: rea === true,
      // The disk this computer was actually given, after the REA floor.
      diskGb: effectiveDiskGb,
      // `disk-over-policy` travels with the row too, so the panel can still
      // explain the sparse-disk risk after a reload (Windows does the same).
      warnings: warnings.length > 0 ? warnings : undefined,
      cpu: spec.cpu,
      memory: spec.memory,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      state: 'ready'
    }
  })
  // Provision first (it needs the desktop, not the other way round), then
  // grow the disk: the Android SDK and the REA kit do not fit in the stock
  // 20 GB. REA comes before Android because it is the smaller, more
  // frequently used half — a failure there must not be hidden behind an
  // 8 GB emulator download.
  const provisioned = await provisionGuest(name, { gpu: spec.gpu })
  let disk = null
  if (effectiveDiskGb > 20) disk = await growGuestDisk(name, effectiveDiskGb)
  const reaResult = rea === true ? await provisionReaGuest(name) : null
  let androidResult = null
  if (spec.android === true) androidResult = await provisionAndroidGuest(name, {})
  return ok({
    name,
    kind: 'linux',
    state: 'ready',
    created: true,
    renderer: provisioned.renderer,
    provisioned: provisioned.ok,
    disk,
    // The panel says "disk raised to 40 GB" from this, instead of
    // discovering the floor by reading the registry.
    diskGbRaised: effectiveDiskGb > wantedDiskGb ? effectiveDiskGb : undefined,
    // A sparse disk bigger than the quota is CREATED (never refused); the
    // warning says the guest may hit the real ceiling.
    warnings: warnings.length > 0 ? warnings : undefined,
    rea: reaResult ? reaResult.ok : undefined,
    android: androidResult ? androidResult.ok : undefined,
    gpu: spec.gpu,
    output: `${(provisioned.output || '').slice(-1200)}${reaResult ? `\n${(reaResult.output || '').slice(-1200)}` : ''}${androidResult ? `\n${(androidResult.output || '').slice(-1200)}` : ''}`
  })
}

async function waitForPowerDown(name, target, timeoutMs) {
  const deadline = Date.now() + Math.max(1000, timeoutMs)
  const pid = qemuPid(name)
  let status = ''
  while (Date.now() < deadline) {
    if (pid !== 0 && !pidAlive(pid)) return { exited: true, reason: 'process exited' }
    try {
      const answer = await qmpCommands(target.port, [{ execute: 'query-status' }], { host: target.host, timeoutMs: 4000 })
      status = String(answer?.[0]?.return?.status ?? '')
      if (status === 'shutdown') return { exited: true, reason: 'query-status shutdown' }
    } catch {
      // No listener AND no live pid: QEMU really is gone.
      if (pid === 0 || !pidAlive(pid)) return { exited: true, reason: 'QMP socket closed' }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return { exited: false, timedOut: true, reason: status === '' ? 'QMP stopped answering' : `still ${status}` }
}

/** Suspend: pause the sandbox, keep the disk. Unchanged behaviour. */
async function suspendVm(name) {
  return withVmLock(name, () => suspendVmLocked(name))
}

/** Caller already holds the computer's lifecycle lock. */
async function suspendVmLocked(name) {
  assertVmName(name)
  const config = readConfig()
  const meta = readRegistry().vms[name]
  if (!meta) throw new Error(`no computer named "${name}"`)
  if (meta.kind === 'windows') {
    // No cua sandbox behind a Windows computer: suspend is QMP `stop`, which
    // pauses the VM with its RAM and disk exactly as they were.
    try {
      await windowsBackend.pause(meta)
    } catch (error) {
      return fail(`${error?.message ?? error}`)
    }
    closePorts(name)
    await mutateRegistry((registry) => {
      const row = registry.vms[name]
      if (!row) return
      row.state = 'suspended'
      row.lastUsed = new Date().toISOString()
    })
    return ok({ name, state: 'suspended', kind: 'windows', detail: 'the VM is paused (QMP stop); Start continues it' })
  }
  space.invalidate(name)
  // `always` captures the disk BEFORE the delta goes away, so a suspend is as
  // recoverable as a shutdown. `never` skips it, `shutdown` leaves suspends
  // alone (the sandbox stays resumable, so there is nothing to protect).
  let checkpoint = null
  if (config.checkpointPolicy === 'always') checkpoint = checkpointSandbox(name)
  const result = await runCua(['sb', 'suspend', '--local', name], { timeoutMs: 180000 })
  closePorts(name)
  await mutateRegistry((registry) => {
    if (!registry.vms[name]) return
    registry.vms[name].state = 'suspended'
    registry.vms[name].lastUsed = new Date().toISOString()
    if (checkpoint !== null) registry.vms[name].restoreFrom = { kind: 'checkpoint', file: checkpoint }
  })
  if (result.code !== 0) return fail((result.stderr || result.stdout).trim().slice(-800))
  return ok({ name, state: 'suspended', checkpoint: checkpoint ?? undefined })
}

async function resumeVm(name) {
  return withVmLock(name, () => resumeVmLocked(name))
}

async function resumeVmLocked(name) {
  assertVmName(name)
  space.invalidate(name)
  const meta = readRegistry().vms[name]
  if (meta?.kind === 'windows') {
    try {
      await windowsBackend.unpause(meta)
    } catch (error) {
      return fail(`${error?.message ?? error}`)
    }
    await mutateRegistry((registry) => {
      const row = registry.vms[name]
      if (!row) return
      row.state = 'ready'
      row.lastUsed = new Date().toISOString()
    })
    // X7: suspend closed the preview; resume rebuilds it HERE, not on the next
    // status/view call (the panel showed a dead tab until then).
    await ensureWindowsConsoleRelay(name)
    return ok({ name, state: 'ready', kind: 'windows' })
  }
  const result = await runCua(['sb', 'resume', '--local', name], { timeoutMs: 180000 })
  await mutateRegistry((registry) => {
    if (!registry.vms[name]) return
    registry.vms[name].state = 'ready'
    registry.vms[name].lastUsed = new Date().toISOString()
  })
  if (result.code !== 0) return fail((result.stderr || result.stdout).trim().slice(-800))
  return ok({ name, state: 'ready' })
}

/**
 * SHUTDOWN, in the order that makes it survivable:
 *
 *   1. close the port previews (a relay to a dying guest answers half-requests)
 *   2. QMP `system_powerdown` — the guest's own ACPI shutdown, so Windows/Linux
 *      flush their filesystems; this is the part `sb suspend` never did
 *   3. wait for the process to exit or `query-status` to say `shutdown`
 *   4. on timeout, QMP `quit` (and remember that the image may be torn)
 *   5. flatten the disk into a checkpoint (qemu-img convert)
 *   6. `sb rm --force` — the sandbox is gone, because the computer is off
 *   7. registry: `powered-off` + `restoreFrom`, which is what makes Start a
 *      cold boot instead of a resume that cannot work
 *
 * `stop` is this function (DSH_CUA_VM_LEGACY_STOP=1 restores the old alias).
 */
async function shutdownVm(name, { reason = 'shutdown' } = {}) {
  return withVmLock(name, () => shutdownVmLocked(name, { reason }))
}

/** Caller already holds the computer's lifecycle lock. */
async function shutdownVmLocked(name, { reason = 'shutdown' } = {}) {
  assertVmName(name)
  const registry = readRegistry()
  const meta = registry.vms[name]
  if (!meta) throw new Error(`no computer named "${name}"`)
  if (meta.kind === 'windows') return windowsShutdown(name, meta)
  const config = readConfig()
  const notes = []
  // A preview is a promise to the user: closing it before the outcome is known
  // is fine, dropping it because the shutdown failed is not. Remember it.
  const previews = snapshotPorts(name)
  closePorts(name)
  space.invalidate(name)

  const target = qmpTarget(name)
  let method = 'already-off'
  let timedOut = false
  /**
   * IS THE DISK STILL OPEN?
   *
   * "QMP did not answer" has two very different causes: the computer is off (the
   * normal case — the socket went with the process) or the process is alive and
   * only its monitor is wedged. The second one used to be indistinguishable, and
   * the code checkpointed anyway: `qemu-img convert` of a qcow2 that a running
   * QEMU has open produces a file that may be internally inconsistent, and the
   * registry then offered it as a clean restore point. A dead pid is proof; a
   * pidfile is not, so this is `pidAlive`, never "the file exists".
   */
  let qemuMayBeAlive = false
  let abandonedBecause = 'its monitor does not answer'
  if (target !== null) {
    method = 'acpi'
    let powerdown = null
    try {
      powerdown = await qmpCommands(target.port, [{ execute: 'system_powerdown' }], { host: target.host, timeoutMs: 15000 })
    } catch (error) {
      // No QMP listener. Could be a corpse cua has not reaped — or a live QEMU
      // whose monitor is gone. Ask the process table, not the filesystem.
      qemuMayBeAlive = pidAlive(qemuPid(name))
      notes.push(qemuMayBeAlive
        ? `QMP was unreachable (${error?.message ?? error}) while QEMU (pid ${qemuPid(name)}) is still running`
        : `QMP was unreachable (${error?.message ?? error}); the process is gone, so the guest is already down`)
      method = qemuMayBeAlive ? 'abandoned' : 'already-off'
      if (qemuMayBeAlive) {
        // A forced kill would tear a disk we cannot checkpoint anyway. Leave it
        // running, say so, and make Start refuse the stale restore point.
        timedOut = true
        notes.push('the disk is still open, so NO checkpoint was taken; an existing restore point is marked stale')
      }
    }
    if (powerdown?.[0]?.error) {
      // ACPI POWERDOWN UNSUPPORTED — say so, and suspend instead of pretending
      // a shutdown happened. `Start` resumes a suspend exactly where it was, so
      // the user loses nothing but the power cycle they asked for.
      const detail = powerdown[0].error.desc || powerdown[0].error.class || 'not supported'
      log(`shutdown ${name}: ACPI powerdown refused (${detail}); falling back to suspend`)
      const suspended = await suspendVmLocked(name)
      if (!suspended.ok) return suspended
      return ok({
        name,
        state: 'suspended',
        fallback: 'acpi-unsupported',
        detail: `the guest refused an ACPI powerdown (${detail}), so it was suspended instead — Start resumes it where it was. Use cua_vm_destroy for a real power-off.`
      })
    }
    if (powerdown !== null) {
      const waited = await waitForPowerDown(name, target, config.shutdownTimeoutSec * 1000)
      if (!waited.exited) {
        log(`shutdown ${name}: no powerdown after ${config.shutdownTimeoutSec}s (${waited.reason}); sending QMP quit`)
        method = 'quit'
        timedOut = true
        try {
          await qmpCommands(target.port, [{ execute: 'quit' }], { host: target.host, timeoutMs: 10000 })
        } catch (error) {
          // `quit` has no reply: QEMU closes the socket instead of answering, so
          // an ECONNRESET here is the SUCCESS case, not a failure. Only report it
          // when the process is still there afterwards.
          if (pidAlive(qemuPid(name))) notes.push(`QMP quit failed (${error?.message ?? error})`)
        }
        const after = await waitForPowerDown(name, target, 15000)
        if (after.exited) {
          notes.push('QEMU exited after quit, but the guest did not run its own shutdown hooks')
        } else {
          // It survived the forced quit: the disk is still open, so this is the
          // same situation as an unreachable monitor, and it must be handled by
          // the same branch — no convert, no `sb rm`, no clean restore point.
          qemuMayBeAlive = true
          abandonedBecause = 'survived the QMP quit'
          notes.push('QEMU survived quit; refusing to convert a disk it still holds')
        }
      }
    }
  } else {
    // No cmdline and no state.json, but a pid may still be there.
    qemuMayBeAlive = pidAlive(qemuPid(name))
    notes.push(qemuMayBeAlive
      ? `no QMP endpoint and QEMU (pid ${qemuPid(name)}) is still running`
      : 'no QMP endpoint: the computer was not running')
    if (qemuMayBeAlive) {
      method = 'abandoned'
      timedOut = true
      notes.push('the disk is still open, so NO checkpoint was taken')
    }
  }

  // 4b. AN ABANDONED COMPUTER IS LEFT ALONE.
  //
  // QEMU is running and its monitor does not answer: we cannot power it down,
  // the disk is open, and every remaining step would make it worse. Removing the
  // sandbox and Start would build a second QEMU on the same qcow2; converting it
  // would publish a possibly-inconsistent image as a restore point; claiming
  // `powered-off` would be a lie the panel then acts on. So: record that the
  // attempt failed, change nothing else, and say exactly what is true.
  //
  // ONE THING IS STILL MUTATED, IN THE SAME WRITE: a restore point this computer
  // already had is marked stale, because we have just proved we cannot vouch for
  // the disk any more (the machine is up and writing to it while its monitor is
  // gone). That marking is what makes Start's stale-refusal branch reachable —
  // `startFromCheckpoint` reads `restoreFrom.stale` and, without a producer, the
  // guard was dead code guarding nothing.
  if (qemuMayBeAlive) {
    const reopened = await restorePorts(name, previews)
    const markedStale = await mutateRegistry((fresh) => {
      const row = fresh.vms[name]
      if (!row) return false
      row.lastShutdown = {
        at: new Date().toISOString(),
        method: 'abandoned',
        reason,
        error: 'QEMU is still running and its QMP monitor does not answer'
      }
      if (row.restoreFrom?.kind !== 'checkpoint') return false
      row.restoreFrom = {
        ...row.restoreFrom,
        stale: true,
        staleReason: 'shutdown abandoned while QEMU held the disk (its monitor never answered)'
      }
      return true
    })
    log(`shutdown ${name}: abandoned — QEMU (pid ${qemuPid(name)}) is alive (${abandonedBecause}); nothing was removed${markedStale ? ', restore point marked stale' : ''}${reopened ? ', preview restored' : ''}`)
    return fail(
      `could not power ${name} off: QEMU (pid ${qemuPid(name)}) is still running and ${abandonedBecause}, so the disk is open. `
      + 'No checkpoint was taken and nothing was removed — the computer is still running. '
      + `${markedStale ? 'Its existing restore point is now marked stale, so Start will boot the base image instead of trusting it. ' : ''}`
      + `${reopened ? 'Its port preview was reopened. ' : ''}`
      + 'Retry in a moment, or use cua_vm_destroy to remove it.'
    )
  }

  // 5. The checkpoint. `never` turns the whole path off; a timeout marks the
  // image because a convert of a live qcow2 is not guaranteed consistent.
  let checkpoint = null
  let checkpointSkipped = ''
  if (config.checkpointPolicy === 'never') {
    checkpointSkipped = 'checkpointPolicy=never'
  } else {
    // A CHECKPOINT COSTS A FULL DISK. Writing one into a store that has no room
    // for it either fails halfway (leaving a `.tmp`) or fills the volume and
    // takes the next create down with it. The requirement is the new file MINUS
    // the checkpoint it replaces, because `rename` overwrites it.
    const diskBytes = diskBytesFor(name)
    const existingBytes = (() => { try { return statSync(path.join(CHECKPOINT_DIR, `${name}.qcow2`)).size } catch { return 0 } })()
    const needed = Math.max(0, diskBytes - existingBytes)
    const over = await refuseOverQuota(config, needed)
    if (over !== null) {
      checkpointSkipped = `the checkpoint needs ~${(needed / 1024 ** 3).toFixed(1)} GB and the store quota does not allow it`
      notes.push(`${checkpointSkipped} (${over})`)
    } else {
      // LINUX: the guest disk is the cua sandbox's own qcow2.
      checkpoint = checkpointSandbox(name)
      if (checkpoint === null) checkpointSkipped = 'no disk to checkpoint'
    }
  }
  if (checkpoint === null) {
    notes.push(checkpointSkipped === 'no disk to checkpoint'
      ? 'no disk to checkpoint; Start will use the base image'
      : `no checkpoint was written (${checkpointSkipped}); Start will use the base image`)
  }

  // 6. The sandbox record. A failure is reported, never fatal: the disk is
  // already captured, so keeping the record would only block the name.
  const removed = await runCua(['sb', 'rm', '--local', name, '--force'], { timeoutMs: 180000 })
  if (removed.code !== 0) notes.push(`sb rm failed (${(removed.stderr || removed.stdout).trim().slice(-200)})`)

  // 7. Registry FIRST-CLASS state, so the panel says powered-off and Start
  // knows it must cold-boot.
  const restoreFrom = await mutateRegistry((fresh) => {
    if (!fresh.vms[name]) return undefined
    fresh.vms[name].state = 'powered-off'
    fresh.vms[name].lastUsed = new Date().toISOString()
    fresh.vms[name].lastShutdown = {
      at: new Date().toISOString(),
      method,
      reason,
      ...(checkpointSkipped !== '' ? { checkpointSkipped } : {})
    }
    // A CLEAN shutdown always writes a restore point from scratch, so a stale
    // marking from an earlier abandoned attempt cannot survive it.
    fresh.vms[name].restoreFrom = checkpoint !== null
      ? { kind: 'checkpoint', file: checkpoint }
      : { kind: 'image', image: fresh.vms[name].image || 'linux' }
    if (timedOut) fresh.vms[name].mayBeTorn = true
    else delete fresh.vms[name].mayBeTorn
    return fresh.vms[name].restoreFrom
  })
  log(`shutdown ${name} (${method}${timedOut ? ', timed out' : ''}): ${checkpoint !== null ? 'checkpoint captured' : 'no checkpoint'}`)
  return ok({
    name,
    state: 'powered-off',
    method,
    checkpoint: checkpoint ?? undefined,
    mayBeTorn: timedOut || undefined,
    restoreFrom,
    notes: notes.length > 0 ? notes : undefined,
    detail: `powered off via ${method}${checkpoint !== null ? `; its disk is checkpointed and Start cold-boots from it` : '; Start will boot the base image'}.`
  })
}

/**
 * Cold boot from the checkpoint.
 *
 * `sb resume` is deliberately NOT attempted: the sandbox was removed by the
 * shutdown, so there is nothing to resume and every attempt is a two-minute
 * error. `sb create` from the flattened checkpoint is the same primitive the
 * recovery path uses, and the `.restore.qcow2` copy is deleted afterwards so the
 * next shutdown's checkpoint does not inherit a backing file.
 */
async function startFromCheckpoint(name, meta) {
  assertVmName(name)
  const checkpoint = path.join(CHECKPOINT_DIR, `${name}.qcow2`)
  const restore = `${checkpoint}.restore.qcow2`
  try { unlinkSync(restore) } catch {}
  let bootImage = meta.image || 'linux'
  let from = 'image'
  // A checkpoint the last shutdown could not vouch for (QEMU was still alive, so
  // the disk was open) is NOT booted: it may be internally inconsistent, and a
  // silent bad boot is worse than a clean base-image one that says why.
  // TWO REASONS NOT TO TRUST A CHECKPOINT, and both must be READ here or the
  // field is decoration: `stale` (an abandoned shutdown proved the disk was
  // open) and `mayBeTorn` (a shutdown timed out and QEMU was forced to quit
  // while the guest was mid-write). A torn image boots — and then fails in a way
  // nobody can attribute to the shutdown that produced it.
  const stale = meta.restoreFrom?.stale === true
  const torn = meta.mayBeTorn === true
  const distrust = stale || torn
  if (!distrust && existsSync(checkpoint)) {
    copyFileSync(checkpoint, restore)
    bootImage = restore
    from = 'checkpoint'
  } else if (distrust) {
    log(`start: ${name}'s checkpoint is ${stale ? 'stale' : 'marked mayBeTorn'}; booting ${bootImage} instead`)
  } else {
    log(`start: ${name} has no checkpoint; booting ${bootImage}`)
  }
  // A stale sandbox record would make `sb create` refuse the name.
  await runCua(['sb', 'rm', '--local', name, '--force'], { timeoutMs: 180000 })
  await ensureRuntime()
  installQemuShim()
  let created = await runCua(createArgs(name, meta.tier, meta.cpu, meta.memory, false, bootImage, meta.gpu === true), { timeoutMs: 1500000 })
  if (created.code !== 0 && from === 'checkpoint') {
    log(`start: the checkpoint of ${name} did not boot; falling back to ${meta.image || 'linux'}`)
    // The failed attempt may have left a half-created sandbox holding the name:
    // the first attempt always removes one before creating, so must the fallback.
    await runCua(['sb', 'rm', '--local', name, '--force'], { timeoutMs: 180000 })
    created = await runCua(createArgs(name, meta.tier, meta.cpu, meta.memory, false, meta.image || 'linux', meta.gpu === true), { timeoutMs: 1500000 })
    from = 'image'
  }
  try { unlinkSync(restore) } catch {}
  if (created.code !== 0) return fail((created.stderr || created.stdout).trim().slice(-1200))
  await mutateRegistry((registry) => {
    if (!registry.vms[name]) return
    registry.vms[name].state = 'ready'
    registry.vms[name].lastUsed = new Date().toISOString()
    delete registry.vms[name].restoreFrom
    delete registry.vms[name].mayBeTorn
  })
  space.invalidate(name)
  await regrowDiskAfterRebuild(name, meta)
  const provisioned = await provisionGuest(name, { gpu: meta.gpu === true })
  const rea = meta.rea === true ? await provisionReaGuest(name) : null
  return ok({
    name,
    state: 'ready',
    coldBoot: true,
    bootedFrom: from,
    provisioned: provisioned.ok,
    rea: rea ? rea.ok : undefined,
    renderer: provisioned.renderer,
    detail: from === 'checkpoint'
      ? 'cold-booted from its checkpoint (the sandbox was removed at shutdown, so there was nothing to resume)'
      : stale
        ? 'cold-booted from the base image: the last shutdown could not prove the guest had stopped, so its checkpoint is not trustworthy'
        : torn
          ? 'cold-booted from the base image: the last shutdown timed out and the guest was force-quit, so its checkpoint may be torn'
          : 'cold-booted from the base image: no checkpoint was available'
  })
}

/* ------------------------------------------------------------------ *
 * WINDOWS: start / ensure / shutdown
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * WINDOWS LIFECYCLE
 * ------------------------------------------------------------------ */

/**
 * THE LIVE VIEW — noVNC over the relay pipeline.
 *
 * A Windows computer's display is QEMU's VNC socket on loopback. Browsers
 * cannot speak VNC, so the supervisor starts `websockify` in front of it
 * (serving the image's own noVNC page) and relays THAT port through the normal
 * `/vm/port/<name>/` pipeline: the proxy's relay rewrite makes the page's
 * root-absolute URLs work under the prefix, and the websocket upgrade is
 * tunnelled like every other preview. If websockify is missing the raw VNC port
 * is relayed instead, and the answer says so — a live view with a caveat is
 * better than a button that 502s.
 */
/**
 * Put the live view back after an aborted shutdown.
 *
 * `restorePorts` alone is wrong here: `stopLiveView` already killed the
 * websockify child, so the relay would be reopened to a port nobody listens on
 * and every request would 502 while the message said "reopened".
 */
/**
 * Mark the Windows restore point unusable after a shutdown that left QEMU
 * running — the same semantics as the Linux abandoned branch: `stale` +
 * `staleReason` + `mayBeTorn` + a `lastShutdown` record, in ONE write.
 */
async function markWindowsShutdownAbandoned(name, because) {
  let marked = false
  await mutateRegistry((fresh) => {
    const row = fresh.vms[name]
    if (!row) return
    row.lastShutdown = { at: new Date().toISOString(), method: 'abandoned', reason: 'shutdown', error: because }
    row.mayBeTorn = true
    if (row.restoreFrom?.kind === 'checkpoint') {
      row.restoreFrom = { ...row.restoreFrom, stale: true, staleReason: `shutdown abandoned while QEMU held the disk (${because})` }
      marked = true
    }
  })
  return marked
}

async function replaceLiveView(name, preview) {
  try {
    const relay = await ensureWindowsConsoleRelay(name)
    if (relay !== null) return true
    return await restorePorts(name, preview)
  } catch (error) {
    log(`windows: ${name} live view could not be reopened (${error?.message ?? error})`)
    return false
  }
}

async function ensureWindowsConsoleRelay(name) {
  // A live view that is already up is reused; a STALE child (or one from a
  // previous boot) is killed before a new one is spawned, otherwise the old
  // websockify keeps the port and LIVE_VIEWS silently forgets it.
  const registry = readRegistry()
  const meta = registry.vms[name]
  if (!meta?.ports?.vnc) return null
  const existing = ports.get(name)
  // REUSE FIRST. This function is called at the end of Start, on every watcher
  // tick, from `view` and from `vmWindowsStatus`; killing the child before
  // looking at the row made the SECOND call leave a relay pointing at a dead
  // websockify — a permanent 502 on /vm/port/<name>/. Rebuild only when the
  // child is gone or the row is missing.
  if (existing !== undefined) {
    const child = LIVE_VIEWS.get(name)
    const alive = child !== undefined && child.exitCode === null && child.signalCode === null
    // Z4: without websockify no child ever exists, so "alive" could never be
    // true and every tick rebuilt the relay. A relay row that still points at
    // this computer's VNC port and is listening IS the view.
    const rawRelay = existing.backend === 'relay'
      && Number(existing.target?.port) === Number(meta.ports.vnc)
      && existing.alive?.() === true
    if (alive || rawRelay) return existing
    stopLiveView(name)
    closePorts(name)
  } else {
    // A child without a row is a leftover from a crash: it holds the port.
    stopLiveView(name)
  }
  try {
    const websockify = '/usr/bin/websockify'
    let targetPort = meta.ports.vnc
    let kind = 'vnc-raw'
    if (existsSync(websockify)) {
      targetPort = await firstFreePort()
      const novnc = ['/usr/share/novnc', '/usr/share/novnc-python', '/usr/local/share/novnc'].find((dir) => existsSync(path.join(dir, 'vnc.html')))
      const argv = novnc !== undefined
        ? [websockify, '--web', novnc, `127.0.0.1:${targetPort}`, `127.0.0.1:${meta.ports.vnc}`]
        : [websockify, `127.0.0.1:${targetPort}`, `127.0.0.1:${meta.ports.vnc}`]
      const child = spawn(websockify, argv.slice(1), { stdio: ['ignore', 'ignore', 'ignore'] })
      LIVE_VIEWS.set(name, child)
      child.on('exit', () => {
        if (LIVE_VIEWS.get(name) === child) LIVE_VIEWS.delete(name)
      })
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (!(await portIsFree(targetPort))) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      kind = novnc !== undefined ? 'novnc' : 'websockify'
    }
    try {
      return await openRelay(name, 5900, { host: '127.0.0.1', port: targetPort }, { backend: 'relay', view: kind })
    } catch (error) {
      // `openRelay` can reject AFTER websockify was spawned (no free relay port,
      // a listen failure); without this the child outlives the failure and the
      // next attempt spawns a second one on the same VNC port.
      stopLiveView(name)
      throw error
    }
  } catch (error) {
    log(`windows: ${name} live view relay failed (${error?.message ?? error})`)
    return null
  }
}

/** websockify children, one per computer, killed with it. */
const LIVE_VIEWS = new Map()

/**
 * Close the live view: the relay AND the websockify behind it. A preview that
 * "closed" while its child kept the VNC port busy blocks the next open with
 * EADDRINUSE (and the port would answer with a stale framebuffer).
 */
function stopLiveView(name) {
  const child = LIVE_VIEWS.get(name)
  LIVE_VIEWS.delete(name)
  try { child?.kill('SIGTERM') } catch {}
}

/**
 * The port triple one computer owns, allocated once and recorded in its row.
 *
 * QMP (control), SSH (the agent surface) and VNC (the live view) are three
 * LOOPBACK listeners inside the harness container. They are allocated from
 * disjoint ranges so a restart finds its own ports free and a stale row cannot
 * hand one computer another's socket.
 */
/** Ports claimed by creates that have not written their registry row yet. */
const CLAIMED_WINDOWS_PORTS = new Set()

async function allocateWindowsPorts(existing = null) {
  const taken = new Set(CLAIMED_WINDOWS_PORTS)
  for (const [name, entry] of ports) taken.add(entry.localPort)
  for (const row of Object.values(readRegistry().vms)) {
    for (const port of Object.values(row?.ports ?? {})) taken.add(Number(port))
  }
  const pick = async ([from, to]) => {
    for (let port = from; port < to; port += 1) {
      if (taken.has(port)) continue
      if (await portIsFree(port)) return port
    }
    throw new Error(`no free port in ${from}-${to} for the Windows computer`)
  }
  const chosen = {
    qmp: Number(existing?.qmp) > 0 ? Number(existing.qmp) : await pick(WINDOWS_QMP_RANGE),
    ssh: Number(existing?.ssh) > 0 ? Number(existing.ssh) : await pick(WINDOWS_SSH_RANGE),
    // VNC's port is 5900 + DISPLAY; QEMU is handed the DISPLAY (see buildQemuArgs).
    vnc: Number(existing?.vnc) > 0 ? Number(existing.vnc) : await pick(WINDOWS_VNC_RANGE)
  }
  for (const port of Object.values(chosen)) CLAIMED_WINDOWS_PORTS.add(port)
  return chosen
}

/** Serial log tail: Windows Setup prints to the serial console, so this is the
 *  install progress a human (and the timeout error) can read. */
function windowsLogTail(name, lines = 40) {
  try {
    const text = readFileSync(windowsPaths(STORE, name).serialLog, 'utf8')
    return text.split('\n').filter((line) => line.trim() !== '').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

/**
 * QEMU'S OWN STDERR TAIL — the half of the story `windowsLogTail` cannot tell.
 *
 * `serial.log` is the GUEST console. A QEMU that dies during init (a display
 * backend this host cannot provide, a firmware file it cannot open) says so on
 * its OWN stderr, which now goes to `$STORE/windows/<name>/qemu-stderr.log`.
 * This is the reader every failure path (and the panel's errorLog) uses, so the
 * discarded diagnosis the user reported can never happen again.
 */
function windowsQemuStderrTail(name, lines = 20) {
  try {
    return qemuStderrExcerpt(readFileSync(windowsPaths(STORE, name).qemuStderr, 'utf8'), lines)
  } catch {
    return ''
  }
}

/**
 * The cheap progress tail the PANEL reads: the last handful of non-empty serial
 * lines. `windowsLogTail` with a small number is one bounded read of the tail
 * region — not a full-file read, and never a second process.
 */
function windowsProgressTail(name, lines = 5) {
  return windowsTailLines(windowsLogTail(name, lines), lines)
}

const WINDOWS_WATCHING = new Set()

/**
 * The install watcher: poll until `ready`, or until the timeout says otherwise.
 *
 * READY is `QMP running` AND a guest endpoint that answers (SSH banner first,
 * VNC accept as the fallback) — see windowsBackend.ready. The row carries the
 * elapsed time and the last serial lines while it installs, so the panel can
 * show progress without a second call.
 */
/**
 * F2: HOW LONG THE FIRST TICK WAITS BEFORE IT DEMANDS A PIDFILE.
 *
 * The user's create died during QEMU's init: the supervisor logged "qemu started
 * (pid 906, installing)" and then watched a dead computer for the FULL 60-minute
 * install timeout, only to flip to `error` with an empty serial tail. boot() now
 * refuses to return a dead start, but a QEMU can also die a second later (OOM,
 * a disk that filled up) — so the watcher's FIRST tick happens inside a short
 * window and treats "no pidfile / no live pid" as DEATH, not as progress.
 *
 * UNSET IS NOT ZERO (same defect as `qemuBootWindowMs`). `Number(env ?? '')`
 * made an unset variable 0, `0 >= 0` passed, and the first tick fired with no
 * wait at all — the row was judged dead before the QEMU it was watching had a
 * chance to write its pidfile. Only a NON-EMPTY raw value is parsed now.
 */
function windowsEarlyDeathWindowMs() {
  const raw = process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(60000, Math.max(0, Math.trunc(parsed)))
  }
  return 5000
}

/**
 * D3: HOW LONG OPENSSH GETS AFTER THE INSTALLED DISK BOOTS.
 *
 * The main install window (`windowsInstallTimeoutMinutes`, 60) is about Setup:
 * partitioning, applying the image, OOBE. Once the disk boots, firstboot is a
 * different job — install OpenSSH, download python.org's installer, pip-install
 * dsh-cua — and it deserves its own bounded window measured from the BOOT, not
 * from the start of the attempt. 15 minutes is generous for three downloads and
 * short enough that a failed firstboot is reported the same afternoon.
 *
 * Overridable so a lab can shorten it (`DSH_CUA_WINDOWS_SSH_GRACE_MIN`). Unset
 * is not zero (the read-once-the-raw-string rule this module uses everywhere).
 */
function windowsInstallSshGraceMinutes() {
  const raw = process.env.DSH_CUA_WINDOWS_SSH_GRACE_MIN
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 1) return Math.min(240, Math.trunc(parsed))
  }
  return 15
}

/**
 * D2: TAKE THE INSTALL MEDIA OUT OF THE SESSION THAT FINISHED INSTALLING.
 *
 * Called at the READY transition from the watcher and from the status poll (a
 * panel can observe ready before the watcher's next 15 s tick, and the watcher
 * may have been restarted). `installMediaDetached` makes it a once-only action,
 * so a poll every 5 s does not issue QMP commands for ever.
 *
 * It NEVER throws: the transition to ready is worth more than a tidy device
 * list, and every failure is logged with the device it concerned.
 */
async function detachWindowsInstallMedia(name) {
  try {
    const row = readRegistry().vms[name]
    if (!row || row.kind !== 'windows') return null
    if (row.installMediaDetached === true) return null
    // A FAILED attempt is retried, but not every 5 s: one QMP failure is worth
    // repeating a minute later, not 12 times per minute in the log.
    const lastAttempt = Date.parse(row.installMedia?.at || '') || 0
    if (lastAttempt > 0 && Date.now() - lastAttempt < 60000) return null
    const result = await windowsBackend.detachInstallMedia(row)
    // ONCE-ONLY IS EARNED, NOT ASSUMED. A QMP that did not answer must be
    // retried on the next ready observation (the panel polls every 5 s); marking
    // the row detached after a failure would leave the media attached for the
    // life of the session.
    const failed = result.errors.filter((error) => error.command !== 'query-block')
    await mutateRegistry((fresh) => {
      const freshRow = fresh.vms[name]
      if (!freshRow) return
      freshRow.installMediaDetached = failed.length === 0
      freshRow.installMedia = {
        ejected: result.commands.filter((command) => command.execute === 'eject').map((command) => command.arguments?.device).filter(Boolean),
        detached: result.commands.filter((command) => command.execute === 'device_del').map((command) => command.arguments?.id).filter(Boolean),
        skipped: result.skipped,
        errors: failed.length > 0 ? failed.slice(0, 4) : undefined,
        at: new Date().toISOString()
      }
    })
    return result
  } catch (error) {
    log(`windows: ${name} could not detach the install media (non-fatal): ${error?.message ?? error}`)
    return null
  }
}

function watchWindowsInstall(name) {
  assertVmName(name)
  if (WINDOWS_WATCHING.has(name)) return
  WINDOWS_WATCHING.add(name)
  void (async () => {
    try {
      let first = true
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, first ? windowsEarlyDeathWindowMs() : 15000))
        first = false
        // THE TICK BELONGS INSIDE THE LOCK. This loop used to write the row from
        // outside it, so a tick that started before a shutdown could land after
        // it and clobber `powered-off` with `installing` (and the same for
        // suspend). Inside the lock, and guarded on the CURRENT state, a tick can
        // only touch a computer that is still installing.
        const decision = await withVmLock(name, async () => {
          const meta = readRegistry().vms[name]
          if (!meta || meta.kind !== 'windows') return { stop: true }
          if (meta.state !== 'installing' && meta.state !== 'booting') return { stop: true, reason: `state is ${meta.state}` }
          // H1: the deadline is per START ATTEMPT. Using createdAt made every
          // restart of an old computer "timed out" on the first tick.
          const started = Date.parse(meta.startedAt || meta.createdAt || '') || Date.now()
          const timeoutMinutes = Number(meta.installTimeoutMinutes ?? readConfig().windowsInstallTimeoutMinutes)
          const elapsedMinutes = Math.round((Date.now() - started) / 60000)
          // D3: THE STAGE THE SERIAL LOG PROVES. Read once per tick (a bounded
          // tail read) and used by BOTH the deadline and the sentence, so the
          // panel and the timeout can never disagree about whether Setup or
          // firstboot is the thing being waited on.
          const serialHead = windowsLogTail(name, 200)
          const bootedNow = windowsBootedFromDisk(serialHead)
          const bootedAtMs = Date.parse(meta.bootedAt || '') || (bootedNow ? Date.now() : 0)
          const bootedStage = bootedAtMs > 0
          const bootedMinutes = bootedStage ? Math.round((Date.now() - bootedAtMs) / 60000) : 0
          const sshGraceMinutes = windowsInstallSshGraceMinutes()
          let verdict
          try {
            verdict = await windowsBackend.ready(meta, { ssh: meta.ssh !== false, phase: 'install' })
          } catch (error) {
            verdict = { ready: false, endpoint: 'none', alive: false, qmp: 'not answering', error: error?.message ?? String(error) }
          }
          // THE PORT THE SENTENCE NAMES comes from the ROW (the only place it is
          // authoritative after a reconcile); the formatter reads it from the
          // verdict so its call site stays one expression.
          // D3: the stage rides WITH the verdict so the one-line formatter call
          // below describes the same clock the deadline above used.
          verdict = {
            ...verdict,
            sshPort: Number(meta.ports?.ssh ?? 0),
            installStage: bootedStage ? 'booted' : 'installing',
            bootedMinutes
          }
          // F2: A DEAD QEMU IS AN ERROR NOW, NOT A 60-MINUTE INSTALL.
          //
          // Everything the reported failure looked like from the outside is
          // checked here, and the FIRST tick is the important one: a start whose
          // pidfile never appeared (or whose pid is already gone) has no guest,
          // no serial output and no future — waiting for the timeout just delays
          // the same answer by an hour. The captured QEMU stderr is attached, so
          // the row explains itself without anyone reading the host.
          if (verdict.alive !== true && verdict.ready !== true) {
            // "alive: false" during an install means the QEMU process is gone —
            // it is never a transient state of a healthy guest, because the
            // pidfile is written before the guest runs. The ONLY question left is
            // whether it died at init (no pidfile/pid) or exited later (a clean
            // shutdown would have been a state change, and a guest that dies
            // mid-install is a failure either way).
            const pid = windowsBackend.qemuPid(name)
            const pidFileExists = existsSync(windowsPaths(STORE, name).qemuPid)
            // A MISSING PIDFILE IS NOT PROOF OF DEATH when the child we spawned
            // has not exited: QEMU writes the pidfile during its init, and a
            // watchdog that cannot tell "not yet" from "never" would flip a
            // healthy start to error. The child's own exit state settles it.
            const child = windowsBackend.childState(name)
            const notYet = !pidFileExists && child.known && child.exited !== true
            const exitedEarly = !notYet && (!pidFileExists || !windowsBackend.pidAlive(pid))
            if (exitedEarly) {
              const stderrTail = windowsQemuStderrTail(name, 20)
              const serialTail = windowsLogTail(name, 40)
              const why = pidFileExists
                ? `QEMU (pid ${pid}) is gone`
                : 'QEMU exited during init before writing its pidfile'
              const errorText = `${why}${stderrTail === '' ? '; it wrote nothing to qemu-stderr.log (killed or could not exec)' : ''}`
              const errorLog = stderrTail === ''
                ? (serialTail === '' ? '(no QEMU stderr and an empty serial log: the guest never spoke)' : serialTail.slice(-4000))
                : stderrTail.slice(-4000)
              await mutateRegistry((fresh) => {
                const row = fresh.vms[name]
                if (!row || (row.state !== 'installing' && row.state !== 'booting')) return
                row.state = 'error'
                row.error = `the Windows computer did not start: ${errorText}`
                row.errorLog = errorLog
                row.installDetail = `error: ${errorText} (see $STORE/windows/${name}/qemu-stderr.log)`
              })
              log(`windows: ${name} died before it could install: ${errorText}`)
              if (stderrTail !== '') log(`windows: ${name} qemu-stderr.log tail:\n${stderrTail}`)
              return { stop: true, died: true }
            }
          }
          if (verdict.ready) {
            await mutateRegistry((fresh) => {
              const row = fresh.vms[name]
              if (!row || (row.state !== 'installing' && row.state !== 'booting')) return
              row.state = 'ready'
              row.endpoint = verdict.endpoint
              row.installComplete = true
              row.installDetail = `ready (${verdict.endpoint} accepting, QMP running)`
              row.readiness = windowsReadinessSignals(name)
              delete row.error
              delete row.errorLog
              delete row.startedAt
              delete row.serialTail
              delete row.installTailAt
              // D3: the install is over; a stale 'booted' stage would keep
              // answering a finished row with an install sentence.
              delete row.installStage
              delete row.bootedAt
            })
            return { stop: true, ready: true }
          }
          // D3: THE DEADLINE FOLLOWS THE STAGE.
          //
          // Before the installed disk boots, the 60-minute window is about
          // DISK WORK (partition, apply image, OOBE) and is compared against the
          // START of this attempt. After it boots, the remaining work is
          // firstboot (OpenSSH, python, pip) and gets its OWN window measured
          // from the boot — otherwise a slow install that booted at minute 55
          // would be marked `error` five minutes later while firstboot was still
          // legitimately downloading python.
          const overDeadline = bootedStage ? bootedMinutes > sshGraceMinutes : elapsedMinutes > timeoutMinutes
          if (overDeadline) {
            const tail = windowsLogTail(name, 40)
            await mutateRegistry((fresh) => {
              const row = fresh.vms[name]
              if (!row || (row.state !== 'installing' && row.state !== 'booting')) return
              row.state = 'error'
              if (bootedStage) {
                // D5: "INSTALLED BUT SSH MISSING" IS NOT "THE INSTALL FAILED".
                // The disk booted; what did not happen is firstboot. Say that,
                // name the log a human can open, and point at the one action
                // that resolves it.
                row.error = `the Windows disk booted, but OpenSSH did not answer within ${sshGraceMinutes} minutes after the boot (${verdict.error ?? 'the SSH banner never came'}); the firstboot script likely failed — check the noVNC view and C:\\Windows\\Setup\\Scripts\\cua-setup.log, then Force delete + recreate`
                row.installDetail = WINDOWS_SSH_MISSING_DETAIL
              } else {
                row.error = `the Windows install did not become ready within ${timeoutMinutes} minutes and the installed disk never booted (${verdict.error ?? 'SSH did not answer'}); Windows Setup did not finish — see the serial log tail and the noVNC view`
              }
              row.errorLog = tail.slice(-4000)
            })
            return { stop: true, timedOut: true }
          }
          // THE PROGRESS SENTENCE IS BUILT BY `formatWindowsInstallDetail`, NOT
          // HERE. The old inline template interpolated `verdict.endpoint` (which
          // the port-shape bug left `undefined`) and rendered an empty QMP
          // status as "not running" — one panel line that was wrong twice.
          const serialTail = windowsProgressTail(name, 5)
          await mutateRegistry((fresh) => {
            const row = fresh.vms[name]
            if (!row || (row.state !== 'installing' && row.state !== 'booting')) return
            row.state = 'installing'
            // D3: 'booted' is an INSTALL STAGE, not a state — the row keeps
            // saying `installing` (so the panel still offers Force delete) but
            // the sentence changes from "Setup is running" to the truth: the
            // installed disk booted and OpenSSH has not answered yet.
            row.installDetail = formatWindowsInstallDetail({ phase: 'install', verdict, elapsedMinutes, serialTail })
            if (bootedStage) {
              row.installStage = 'booted'
              // STAMP ONCE: the grace window must not restart on every 15 s
              // tick (that would wait for ever instead of telling the user).
              if (!row.bootedAt) row.bootedAt = new Date().toISOString()
            }
            // The tail travels with the row so the panel shows Setup progress
            // without a second call, and an agent reading `status` sees it too.
            row.serialTail = serialTail
            row.installTailAt = new Date().toISOString()
            row.readiness = windowsReadinessSignals(name)
          })
          return { stop: false }
        })
        if (decision.stop) {
          if (decision.ready) await ensureWindowsConsoleRelay(name)
          // D2: THE MEDIA LEAVE WITH THE INSTALL. This is the READY transition:
          // the desktop is up, the SSH banner answered, firstboot has finished.
          // Ejecting here (and not at "the disk booted") matters because the
          // drive-scanning firstboot fallback may still need the medium at the
          // first logon.
          if (decision.ready) await detachWindowsInstallMedia(name)
          if (decision.reason !== undefined) log(`windows: install watch for ${name} stopped (${decision.reason})`)
          if (decision.ready) log(`windows: ${name} ready`)
          if (decision.died) log(`windows: install watch for ${name} ended: QEMU died (the row is 'error' with the captured stderr)`)
          return
        }
      }
    } catch (error) {
      log(`windows: install watch for ${name} stopped (${error?.message ?? error})`)
    } finally {
      WINDOWS_WATCHING.delete(name)
    }
  })()
}

/**
 * A Windows computer, on the direct-QEMU backend.
 *
 * The order matters and is the same for every install:
 *   quota → ports → ISO (download once) → OEM payload → credentials → boot.
 * A failure after the boot is compensated by killing the process, exactly like
 * the container path did with `docker rm`.
 */
async function windowsCreateManaged(spec) {
  if (windowsEnabled() === false) throw new Error('the Windows backend is disabled (DSH_CUA_VM_WINDOWS=0)')
  // `ltsc11` is an accepted spelling of the Windows 11 IoT LTSC version.
  spec.windowsVersion = canonicalWindowsVersion(spec.windowsVersion)
  // S3: refuse a malformed key BEFORE the 5 GB download and before setup.img is
  // built. Empty is valid: every pinned ISO is an EVALUATION image.
  spec.windowsKey = normaliseProductKey(spec.windowsKey)
  // F2: resolve (and thus VALIDATE) the edition selector here — before the
  // 5 GB download and before setup.img is built. A bad windowsImageIndex is a
  // sentence about the answer file, not an install page the user has to click.
  const imageSelection = resolveWindowsImageSelection({
    version: spec.windowsVersion,
    imageIndex: spec.windowsImageIndex,
    imageName: spec.windowsImageName
  })
  log(`windows: ${spec.name} will install ${imageSelection.key}=${imageSelection.value} (${imageSelection.source}${imageSelection.verified === false ? ', UNVERIFIED' : ''})`)
  if (spec.rea === true) throw new Error('REA is not available for Windows computers: the kit is a Linux guest layer (create the Windows computer without it, or use a Linux computer)')
  if (spec.android === true) throw new Error('Android is not available for Windows computers: the SDK and the AVD run in a Linux guest')
  const caps = windowsHostCaps()
  const missing = ['qemu', 'ovmfCode', 'ovmfVars', 'swtpm'].filter((key) => caps[key] !== true)
  if (missing.length > 0) {
    throw new Error(`the Windows backend needs ${missing.join(', ')} on the host (install qemu-system-x86, ovmf and swtpm in the image: ${WINDOWS_QEMU})`)
  }
  // THE DEVICE, BEFORE 5.5 GB OF ISO. `boot()` refuses too, but by then the
  // download and the qcow2 have already happened. This is the SAME preflight
  // (one implementation, `cua-vm-kvm.mjs`) so the sentence cannot drift: missing
  // → add `devices:`; present-but-denied → the gid/group_add fix, quoting the
  // observed mode, owner and this process's supplementary groups.
  const kvmError = windowsKvmPreflight()
  if (kvmError !== null) throw kvmError
  if (spec.windowsIso !== '' && !/^https?:\/\//iu.test(spec.windowsIso)) {
    // A local ISO is used DIRECTLY as a QEMU drive, so it must be a host path
    // this process can read: the store, or the workspace (which is a bind).
    const absolute = path.isAbsolute(spec.windowsIso) ? spec.windowsIso : path.resolve(STORE, spec.windowsIso)
    const root = realpathSync(WORKSPACE_ROOT)
    const inStore = absolute === STORE || absolute.startsWith(STORE + path.sep)
    const inWorkspace = absolute === root || absolute.startsWith(root + path.sep)
    if (!inStore && !inWorkspace) {
      throw new Error('windowsIso must be an http(s) URL, a path inside the VM store, or a path inside the workspace')
    }
    if (!existsSync(absolute)) throw new Error(`windowsIso "${spec.windowsIso}" does not exist (expected ${absolute})`)
  }
  if (spec.windowsIso === '' && !WINDOWS_VERSIONS.includes(spec.windowsVersion)) {
    throw new Error(`windowsVersion must be one of ${WINDOWS_VERSIONS.join(', ')} (or give windowsIso instead)`)
  }
  const registry = readRegistry()
  if (registry.vms[spec.name]) throw new Error(`a computer named "${spec.name}" already exists`)
  const config = readConfig()
  const running = Object.values(registry.vms).filter((meta) => RUNNING_STATES.has(meta?.state)).length
  if (running >= config.maxRunning) {
    return fail(`VM limit reached (${running}/${config.maxRunning} running). Shutdown one, or raise the limit above.`)
  }
  // THE FLOORS ARE DEFAULTS, NOT MINIMUMS. A smaller computer is created when it
  // is asked for — the user may be testing an install failure, or running a tiny
  // workload — and the result carries a WARNING instead of a refusal. What is
  // still refused is anything that cannot exist: a zero disk, or a create on a
  // store whose REAL usage is already over the policy.
  // `normaliseSpec` fills the LINUX defaults (memory 4), so "omitted" has to be
  // carried explicitly — otherwise an omitted memory would become 4 GB + a
  // warning instead of the Windows default of 6.
  const given = { disk: spec.diskGiven === true, memory: spec.memoryGiven === true, cpu: spec.cpuGiven === true }
  const diskGb = given.disk ? spec.diskGb : WINDOWS_DEFAULT_DISK_GB
  const memory = given.memory ? spec.memory : WINDOWS_DEFAULT_MEMORY_GB
  const cpu = given.cpu ? spec.cpu : WINDOWS_DEFAULT_CPU
  // One pure builder, so the same advice reaches the result, the row and the panel.
  const warnings = windowsCapacityWarnings({ diskGb, memory, cpu })
  // THE 64 GB DEFAULT IS A SPARSE DISK, NOT 64 GB OF STORE. It used to be
  // refused (`a 64 GB disk does not fit the store quota`) before QEMU was
  // ever asked to create the qcow2 — so no Windows computer could be created on
  // the shipped quota, and the branch's "the quota counts real bytes" rule did
  // not hold on the one path that needed it most. The virtual size is now a
  // WARNING; the refusal below is about bytes that are really on disk.
  warnings.push(...diskPolicyWarnings(diskGb, config))
  const over = await reserveStoreBytes(spec.name, 0)
  if (over !== null) return fail(over)

  let booted = null
  // Declared OUTSIDE the try so the failure path can release exactly the three
  // ports this create claimed — `Object.values` of a Set is [], which made the
  // release a silent no-op (and a naive fix would clear other creates' claims).
  let portTriple = null
  try {
    const paths = windowsPaths(STORE, spec.name)
    mkdirSync(paths.dir, { recursive: true })
    mkdirSync(paths.tpmDir, { recursive: true })
    // TWO CREATES, TWO NAMES, ONE FREE PORT: the old allocation read "taken"
    // from the registry, which does not yet contain the row being built. The
    // claim is serialised globally and recorded in memory until the row exists.
    portTriple = await withLock('@ports', () => allocateWindowsPorts())
    // The disk is created up-front: its existence is what tells a later start
    // whether Setup still has to run.
    execFileSync('/usr/bin/qemu-img', ['create', '-f', 'qcow2', paths.disk, `${diskGb}G`], { timeout: 120000 })

    // ISO: a local file is used as-is; a URL is downloaded once into $STORE/iso.
    let isoPath
    if (spec.windowsIso !== '' && !/^https?:\/\//iu.test(spec.windowsIso)) {
      isoPath = path.isAbsolute(spec.windowsIso) ? spec.windowsIso : path.resolve(STORE, spec.windowsIso)
    } else {
      // K2: a version without a probed public link refuses HERE, with the
      // version named and both remediations, instead of 400ing inside the
      // download after the quota was reserved.
      const url = spec.windowsIso !== '' ? spec.windowsIso : resolveWindowsIso(spec.windowsVersion).url
      // X6: A DOWNLOAD IS A WRITE. The quota used to be checked for the disk
      // only, and the ISO then dropped ~5.5 GB into the store unchecked — one
      // create could exceed the quota on its own. Reserve the expected size,
      // but ONLY when the file is not already cached (a cached ISO is already
      // counted by `used`; reserving again would refuse a create that fits).
      const cached = existsSync(isoTargetPath(paths.isoDir, url))
      const expectedBytes = Number(process.env.DSH_CUA_WINDOWS_ISO_BYTES || 6 * 1024 ** 3)
      if (!cached) {
        const isoOver = await reserveStoreBytes(`${spec.name}/iso`, expectedBytes)
        if (isoOver !== null) {
          throw new Error(`the Windows ISO needs about ${(expectedBytes / 1024 ** 3).toFixed(1)} GB, which does not fit the store quota: ${isoOver}`)
        }
      }
      try {
        const downloaded = await ensureIso({
          url,
          isoDir: paths.isoDir,
          timeoutMs: Number(process.env.DSH_CUA_WINDOWS_ISO_TIMEOUT_MS || 60 * 60 * 1000),
          log,
          onProgress: (fraction, bytes) => log(`iso: ${(bytes / 1024 ** 3).toFixed(2)} GB${fraction === null ? '' : ` (${Math.round(fraction * 100)}%)`}`)
        })
        isoPath = downloaded.path
      } finally {
        if (!cached) releaseStoreBytes(`${spec.name}/iso`)
      }
    }

    // SSH keypair: the agent surface authenticates with it, the password is the
    // fallback a human can read in the panel.
    if (!existsSync(paths.sshKey)) {
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', paths.sshKey, '-C', `dsh-cua-${spec.name}`], { timeout: 30000 })
      chmodSync(paths.sshKey, 0o600)
    }
    const sshPubKey = readFileSync(paths.sshKeyPub, 'utf8')
    const password = generatePassword()
    writeWindowsCredentials(spec.name, {
      username: WINDOWS_USERNAME,
      password,
      sshKey: paths.sshKey,
      createdAt: new Date().toISOString()
    })
    writeOemPayload({
      paths,
      name: spec.name,
      password,
      sshPubKey,
      sourceDir: WINDOWS_OEM_DIR,
      fallbackDirs: WINDOWS_OEM_FALLBACK_DIRS,
      pythonUrl: WINDOWS_PYTHON_URL,
      dshCuaSpec: WINDOWS_DSH_CUA_SPEC,
      windowsKey: spec.windowsKey,
      // F2: the edition, so Setup never shows "Select the operating system".
      windowsVersion: spec.windowsVersion,
      windowsImageIndex: spec.windowsImageIndex,
      windowsImageName: spec.windowsImageName,
      log
    })
    // S1: build the FAT32 answer-file disk and PROVE it (mdir listing + byte
    // compare) before QEMU is started. This is the step the old vvfat stick did
    // not have: a medium whose root is known to hold Autounattend.xml.
    buildSetupImage({ paths, log })

    const qemuSpec = {
      name: spec.name,
      cpu,
      memory,
      gpu: spec.gpu,
      paths,
      isoPath,
      qmpPort: portTriple.qmp,
      vncPort: portTriple.vnc,
      sshPort: portTriple.ssh
    }
    // Y1: THE GPU DECISION IS MADE ONCE, HERE. `buildQemuArgs` switches on
    // `spec.virgl`, and the install-time spec used to omit it while the row had
    // no field at all — so the post-install boot (`virgl: current.virgl === true`)
    // was always false and the virgl branch was unreachable. Gate it on the same
    // capability probe the Linux guest uses, plus a render node.
    const virgl = spec.gpu === true && systemQemuSupportsVirgl() && existsSync('/dev/dri/renderD128')
    qemuSpec.virgl = virgl
    // F3: THE BOOT MAY COME BACK DEGRADED. A host whose EGL/render-node path
    // cannot initialize retries ONCE with `-display none` + VGA and reports a
    // `gpu-fallback` warning; the row must then describe the computer that
    // actually runs (no virgl, no accelerated display) and keep the warning, so
    // the panel, the create answer and cua_vm_doctor agree.
    booted = await windowsBackend.boot(qemuSpec, { installPending: true })
    const gpuFallback = booted?.gpuFallback === true
    if (gpuFallback) {
      for (const warning of booted.warnings ?? []) {
        if (!warnings.some((existing) => existing.code === warning.code)) warnings.push(warning)
      }
    }
    const row = {
      // R2: THE ROW CARRIES ITS NAME. `vms` is keyed by it, but every backend
      // helper resolves `spec.name`, and a row without one gave every pidfile
      // path the segment "undefined" (see migrateRegistryRow).
      name: spec.name,
      workspace: spec.workspace,
      kind: 'windows',
      backend: 'qemu',
      windowsVersion: spec.windowsIso === '' ? spec.windowsVersion : '',
      windowsIso: spec.windowsIso,
      // F2: what the answer file names, recorded so the panel / a later support
      // question can tell WHICH edition this computer was installed from.
      windowsImage: `${imageSelection.key}=${imageSelection.value}`,
      isoPath,
      ports: portTriple,
      ssh: true,
      qemu: WINDOWS_QEMU,
      // THE REQUESTED GPU FLAG, and whether the running display is the virgl
      // one. After a `gpu-fallback` retry the answer must not claim virgl.
      gpu: spec.gpu,
      virgl: gpuFallback ? false : virgl,
      ...(gpuFallback ? { gpuFallback: true } : {}),
      android: false,
      rea: false,
      diskGb,
      cpu,
      memory,
      warnings,
      credentials: true,
      installTimeoutMinutes: readConfig().windowsInstallTimeoutMinutes,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      state: 'installing',
      endpoint: 'none',
      // B3: the first sentence already names what is watched and how the user
      // will know it finished (the same formatter the watcher uses, with an
      // empty tail because Setup has not printed yet).
      installDetail: formatWindowsInstallDetail({ phase: 'install', verdict: { endpoint: 'none', qmp: 'starting' }, elapsedMinutes: 0, serialTail: '', sshPort: portTriple.ssh }),
      serialTail: [],
      readiness: windowsReadinessSignals(spec.name)
    }
    await mutateRegistry((fresh) => { fresh.vms[spec.name] = row })
    // Z2: THE ROW NOW OWNS THESE PORTS. The claim existed only for the window
    // between allocation and the row write; keeping it made every later
    // reconcile (and every other create) see them as taken.
    for (const port of Object.values(portTriple)) CLAIMED_WINDOWS_PORTS.delete(Number(port))
  } catch (error) {
    // Nothing half-created survives: kill the QEMU we started, stop its TPM (a
    // leaked swtpm holds the TPM state directory) and release the port claim.
    windowsBackend.kill(spec.name)
    windowsBackend.stopSwtpm(spec.name)
    // Release THIS create's claim only.
    for (const port of Object.values(portTriple ?? {})) CLAIMED_WINDOWS_PORTS.delete(Number(port))
    releaseStoreBytes(spec.name)
    throw error
  } finally {
    releaseStoreBytes(spec.name)
  }
  watchWindowsInstall(spec.name)
  return ok({
    name: spec.name,
    kind: 'windows',
    state: 'installing',
    created: true,
    backend: 'qemu',
    diskGb,
    cpu,
    memory,
    warnings,
    gpu: spec.gpu,
    // B1: echo WHAT WAS ASKED FOR (the row's own numbers), so a caller can tell
    // "created at 20 GB / 4 GB" from "created at the 64 GB default".
    requested: { diskGb, memory, cpu },
    passwordHint: 'the generated password is in the computer list (Reveal) — user "cua"',
    console: `/vm/port/${spec.name}/`,
    readiness: windowsReadinessSignals(spec.name),
    detail: `Windows ${spec.windowsVersion || spec.windowsIso} is installing on ${diskGb} GB disk / ${memory} GB RAM / ${cpu} CPU. The live view is at /vm/port/${spec.name}/ as soon as the display answers; OpenSSH, python and dsh-cua are installed by the answer file, so cua_vm_exec works once the computer is ready. The panel badge flips to Ready when the SSH banner answers and QMP says running.`
  })
}

/**
 * SSH IS THE AGENT SURFACE OF A WINDOWS COMPUTER.
 *
 * There is no cua-spacesd to talk to, so exec/put/get go through the OpenSSH
 * server the answer file installs. Three details that break a naive version:
 *
 *   * `-T` (no pty): a pty would translate CRLF and echo the command back.
 *   * the key is per computer (`$STORE/windows/<name>/id_ed25519`, 0600); the
 *     generated password is the human fallback, not what the supervisor uses.
 *   * a Windows command line is parsed by cmd.exe, so a path with spaces is
 *     quoted with double quotes — NOT POSIX single quotes.
 */
function sshBaseArgs(meta) {
  const paths = windowsPaths(STORE, meta.name ?? '')
  const keyPath = existsSync(paths.sshKey) ? paths.sshKey : null
  return [
    '-T',
    ...(keyPath !== null ? ['-i', keyPath] : []),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-p', String(meta.ports?.ssh ?? 0)
  ]
}

/** Quote for cmd.exe (double quotes; no single-quote convention). */
/**
 * A Windows guest path that reaches `scp` must not contain cmd.exe
 * metacharacters: the remote side is `cmd.exe /c scp`-ish, and a path with `&`
 * or `"` re-parses as a second command. Absolute drive paths only (C:\…).
 */
function assertWindowsGuestPath(guest) {
  const text = String(guest ?? '')
  if (text === '') throw new Error('guest path is required')
  if (/["&|<>^]/u.test(text)) throw new Error(`guest path contains a shell metacharacter: ${guest} (quotes, &, |, <, >, ^ are refused on a Windows computer)`)
  if (!/^[A-Za-z]:[\\/]/u.test(text)) throw new Error(`guest path must be an absolute Windows path such as C:\\Users\\cua\\file.txt (got ${guest})`)
  return text
}

function quoteForWindows(value) {
  const text = String(value)
  return /\s/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text
}

/** Run one command in the guest over SSH; never throws on a non-zero exit. */
function sshRun(meta, command, { timeoutMs = 330000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/ssh', [...sshBaseArgs(meta), `${meta.user ?? 'cua'}@127.0.0.1`, command], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
    }, timeoutMs)
    const done = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: timedOut ? 124 : code, stdout, stderr, timedOut })
    }
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { stderr += `${error?.message ?? error}`; done(-1) })
    child.on('close', (code) => done(code ?? -1))
  })
}

/** Copy a file in or out with scp (the same key, the same port). */
function scpRun(meta, localPath, guestPath, { direction }) {
  return new Promise((resolve) => {
    const remote = `${meta.user ?? 'cua'}@127.0.0.1:${guestPath}`
    const args = [
      '-q',
      ...sshBaseArgs(meta).filter((arg) => arg !== '-T'),
      ...(direction === 'to-guest' ? [localPath, remote] : [remote, localPath])
    ]
    const child = spawn('/usr/bin/scp', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let timedOut = false
    // M5: scp had NO timeout, so an unresponsive guest hung cua_vm_put/get
    // forever (the Linux path caps at 600 s).
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL') } catch {} }, Number(process.env.DSH_CUA_WIN_SCP_TIMEOUT_MS || 300000))
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stderr: `${error?.message ?? error}` }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: timedOut ? 124 : (code ?? -1), stderr: timedOut ? `${stderr}\nscp timed out` : stderr })
    })
  })
}

/** The one sentence every Windows refusal uses, so they cannot drift apart. */
const WINDOWS_NO_AGENT = (tool) => `cua_vm_${tool} needs the guest SSH server, which this Windows computer does not answer yet (still installing, or sshd is down). `
  + 'Once it is ready, exec/put/get work over SSH like the Linux computer; for the desktop use cua_vm_gui (QMP) or the live view at /vm/port/<name>/.'

/**
 * The desktop surface of a Windows computer: QMP frames and QMP input.
 *
 * There is no cursor overlay: CUA's agent cursor is an X11 overlay the Linux
 * guest draws, and nothing equivalent exists on Windows — the real pointer is
 * what the frame shows (and what VNC draws for a human).
 */
async function windowsGui({ name, action, x, y, x2, y2, text, key, save, relative, region = null, scale = 1 }) {
  if (typeof save === 'string' && save !== '') {
    return fail('`save` is not available for Windows computers: the frame is written into the workspace, and there is no guest filesystem to save a path into. Use the returned workspace path or the live view.')
  }
  const meta = readRegistry().vms[name]
  if (!meta) return fail(`no computer named "${name}"`)
  let measured
  try {
    const frame = await windowsBackend.screenshot(meta)
    measured = frameSpace(frame.png)
    if (action === 'screenshot') {
      const stamp = Date.now()
      mkdirSync(SHOTS_DIR, { recursive: true })
      mkdirSync(WINDOWS_ARTIFACT_DIR, { recursive: true })
      const hostFile = path.join(SHOTS_DIR, `${name}-${stamp}.png`)
      const artifact = path.join(WINDOWS_ARTIFACT_DIR, `${name}-${stamp}.png`)
      writeFileSync(hostFile, frame.png)
      // M7: the region crop the Linux path has. The model should not have to
      // crop a 1024x768 frame by hand (and lose the coordinate mapping doing it).
      let pngOut = frame.png
      let mapping = ''
      const area = region === null || region === undefined ? null : region
      if (area !== null) {
        const rx = Math.max(0, Math.round(Number(area.x) || 0))
        const ry = Math.max(0, Math.round(Number(area.y) || 0))
        const rw = Math.max(16, Math.min(4096, Math.round(Number(area.width ?? area.w) || 320)))
        const rh = Math.max(16, Math.min(4096, Math.round(Number(area.height ?? area.h) || 200)))
        const zoom = Math.max(1, Math.min(4, Number(area.scale ?? scale ?? 1) || 1))
        const cropped = path.join(SHOTS_DIR, `${name}-${stamp}-crop.png`)
        try {
          execFileSync('/usr/bin/convert', [hostFile, '-crop', `${rw}x${rh}+${rx}+${ry}`, '+repage', '-resize', `${Math.round(zoom * 100)}%`, cropped], { timeout: 30000 })
          pngOut = readFileSync(cropped)
          mapping = `crop ${rw}x${rh} at frame (${rx},${ry}) magnified ${zoom}x → this image is only for reading: to click, divide by ${zoom} and add the origin, i.e. click at (${rx} + px/${zoom}, ${ry} + py/${zoom}).\n`
        } catch (error) {
          // No ImageMagick in the image is a real possibility: say so instead of
          // silently returning the full frame as if it were the crop.
          mapping = `crop unavailable (${error?.message ?? error}); the FULL frame is below, so click using display coordinates.\n`
        }
      }
      copyFileSync(hostFile, artifact)
      return ok({
        name,
        action,
        png: pngOut.toString('base64'),
        output: `${formatSpace(measured)} (QMP screendump: the PNG IS the display, no capture budget)\n`
          + mapping
          + `the frame is in the workspace at ${artifact} — image px = display px, and clicks take the same pixels.\n`
          + 'Windows limits: no clipboard, no accessibility tree, no window list, no cursor overlay (the real pointer is in the frame). For element-level actions use the dsh-cua tools once the guest is ready.'
      })
    }
  } catch (error) {
    return fail(`${error?.message ?? error}. A Windows computer answers its display only while it is running.`)
  }
  const width = measured.display.width
  const height = measured.display.height
  const toPixels = (value, extent) => {
    if (relative === true) return Math.round(Math.min(1, Math.max(0, Number(value) || 0)) * extent)
    const parsed = Math.round(Number(value))
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error('coordinates must be positive numbers')
    return parsed
  }
  const limits = 'Windows limits: no clipboard, no accessibility tree, no window list, no driver cursor overlay. Use screenshot + click, or the dsh-cua element tools.'
  switch (action) {
    case 'click':
    case 'dclick':
    case 'move':
    case 'drag': {
      const fromX = toPixels(x, width)
      const fromY = toPixels(y, height)
      try {
        if (action === 'move') await windowsBackend.move(meta, fromX, fromY, { width, height })
        else if (action === 'drag') await windowsBackend.drag(meta, fromX, fromY, toPixels(x2, width), toPixels(y2, height), { width, height })
        else {
          await windowsBackend.click(meta, fromX, fromY, { width, height })
          if (action === 'dclick') await windowsBackend.click(meta, fromX, fromY, { width, height })
        }
      } catch (error) {
        return fail(`${error?.message ?? error}`)
      }
      return ok({
        name,
        action,
        output: `${action} at ${action === 'drag' ? `${fromX},${fromY} → ${toPixels(x2, width)},${toPixels(y2, height)}` : `${fromX},${fromY}`} (QMP abs pointer, usb-tablet)\n${spaceLine(measured)}\n${limits}`
      })
    }
    case 'type':
    case 'key':
    case 'hotkey': {
      try {
        await windowsBackend.sendKeys(meta, action === 'type' ? { text: String(text ?? '') } : { key: String(key ?? '') })
      } catch (error) {
        return fail(`${error?.message ?? error}`)
      }
      return ok({
        name,
        action,
        output: `${action} sent over QMP\n${spaceLine(measured)}\n${limits}${action === 'type' ? '\nASCII only: the QMP keyboard sends physical keys, so there is no clipboard for anything else.' : ''}`
      })
    }
    case 'geometry':
      return ok({
        name,
        action,
        output: `${spaceLine(measured)}\nThe frame is the whole display: no separately-scaled capture, no window list and no a11y tree on this backend.`
      })
    default:
      return fail(`"${action}" is not available for a Windows computer (QMP gives frames and input only: no a11y, no window list, no clipboard, no launch). Use screenshot + click + type, or the live view at /vm/port/${name}/.`)
  }
}

/**
 * START a Windows computer.
 *
 * Three cases, and they are the same three as Linux + one Windows-only one:
 *   suspended     QMP `cont` (the VM is paused, RAM intact)
 *   powered-off   boot QEMU again; the disk decides whether Setup runs
 *   installing    nothing to do but keep watching
 * A computer whose process died is re-booted from its own disk, never rebuilt.
 */
/**
 * Ports that a previous run left behind, or that something else grabbed while
 * this computer was off. A stale row must not boot QEMU onto an occupied socket
 * (it fails with "Could not set up host forwarding rule", long after the user
 * pressed Start) — so each port is probed and, when taken, re-allocated under
 * the same global lock the create uses.
 */
async function reconcileWindowsPorts(name, meta) {
  const ports = { ...(meta.ports ?? {}) }
  // X5: a FREE port may still belong to another computer — a powered-off one
  // keeps its row, and a create in flight keeps an in-memory claim. Asking only
  // the OS could hand out a port another row reserves, which is exactly the
  // hostfwd collision this function exists to prevent.
  // Z1: THE SUBJECT IS EXCLUDED BY NAME, passed in — rows carry no `name` field,
  // so `otherName === meta.name` never matched and the computer's own triple
  // landed in `reserved`: every cold start re-allocated all three ports.
  const reserved = new Set(CLAIMED_WINDOWS_PORTS)
  for (const [otherName, row] of Object.entries(readRegistry().vms)) {
    if (otherName === name) continue
    for (const port of Object.values(row?.ports ?? {})) reserved.add(Number(port))
  }
  for (const port of Object.values(ports)) reserved.delete(Number(port))
  const mine = new Set(Object.values(ports).map(Number))
  let changed = false
  for (const [key, range] of [['qmp', WINDOWS_QMP_RANGE], ['ssh', WINDOWS_SSH_RANGE], ['vnc', WINDOWS_VNC_RANGE]]) {
    const value = Number(ports[key])
    if (Number.isFinite(value) && value > 0 && !reserved.has(value) && await portIsFree(value)) continue
    ports[key] = await (async () => {
      for (let port = range[0]; port < range[1]; port += 1) {
        if (mine.has(port) || reserved.has(port)) continue
        if (await portIsFree(port)) { reserved.add(port); return port }
      }
      throw new Error(`no free port in ${range[0]}-${range[1]} for the Windows computer`)
    })()
    changed = true
  }
  return { ports, changed }
}

async function windowsStart(name, meta) {
  assertVmName(name)
  // THE SAME LOCK AS EVERY OTHER LIFECYCLE OP. Without it two concurrent Starts
  // both saw a dead QEMU, both spawned one, and the second `-pidfile` write left
  // the first process unkillable by name.
  return withVmLock(name, async () => {
    const current = readRegistry().vms[name]
    if (!current) return fail(`no computer named "${name}"`)
    const verdict = await windowsBackend.probe(current)

    if (verdict.alive) {
      // A live process is never started twice.
      if (verdict.status === 'paused' || verdict.status === 'suspended' || current.state === 'suspended') {
        await windowsBackend.unpause(current)
        await mutateRegistry((fresh) => {
          const row = fresh.vms[name]
          if (!row) return
          row.state = 'ready'
          row.lastUsed = new Date().toISOString()
          delete row.startedAt
        })
        // M6: a suspended computer lost its live view with the relay; rebuild it.
        await ensureWindowsConsoleRelay(name)
        return ok({ name, state: 'ready', kind: 'windows', detail: 'unpaused (suspend kept the guest exactly as it was)' })
      }
      const ready = await windowsBackend.ready(current, { ssh: current.ssh !== false })
      if (ready.ready) {
        await mutateRegistry((fresh) => {
          const row = fresh.vms[name]
          if (!row) return
          row.state = 'ready'
          row.endpoint = ready.endpoint
          row.installComplete = true
          row.lastUsed = new Date().toISOString()
          delete row.error
          row.installDetail = `ready (${ready.endpoint} accepting, QMP running)`
        })
        await ensureWindowsConsoleRelay(name)
        return ok({ name, state: 'ready', kind: 'windows', console: `/vm/port/${name}/`, detail: ready.endpoint })
      }
      watchWindowsInstall(name)
      await ensureWindowsConsoleRelay(name)
      // R2 SIDE EFFECT: NOW THAT `probe(row)` ACTUALLY FINDS THE PIDFILE, this
      // branch is reachable for a live QEMU whose guest is still booting (it used
      // to be skipped because the pidfile path said "undefined"). The answer
      // carries the SAME port diagnostics as the cold-start path, so a caller
      // cannot tell "ports kept" from "field missing".
      return ok({
        name,
        state: 'booting',
        kind: 'windows',
        ports: current.ports,
        portsChanged: false,
        detail: `QMP running, ${ready.endpoint === 'none' ? 'no endpoint answers yet' : `${ready.endpoint} answering`}`
      })
    }

    // ---- the process is gone: reconcile ports, restore a checkpoint, boot ----
    const reconciled = await withLock('@ports', () => reconcileWindowsPorts(name, current))
    const restore = current.restoreFrom
    const distrust = restore?.stale === true || current.mayBeTorn === true
    if (reconciled.changed) log(`windows: ${name} ports re-allocated (${JSON.stringify(current.ports)} → ${JSON.stringify(reconciled.ports)})`)
    if (restore?.kind === 'checkpoint' && distrust !== true && existsSync(restore.file)) {
      const target = windowsPaths(STORE, name).disk
      const staged = `${target}.restore.qcow2`
      try {
        execFileSync('/usr/bin/qemu-img', ['convert', '-O', 'qcow2', restore.file, staged], { timeout: 300000 })
        renameSync(staged, target)
        log(`start: ${name} restored from its checkpoint`)
      } catch (error) {
        try { unlinkSync(staged) } catch {}
        log(`start: ${name} could not restore its checkpoint (${error?.message ?? error}); booting the existing disk`)
      }
    } else if (restore?.kind === 'checkpoint' && distrust) {
      log(`start: ${name} refuses its ${restore.stale === true ? 'stale' : 'torn'} checkpoint; booting the existing disk`)
    }
    const installPending = !existsSync(windowsPaths(STORE, name).disk) || current.installComplete !== true
    try {
      await windowsBackend.boot({
        name,
        cpu: current.cpu,
        memory: current.memory,
        gpu: current.gpu === true,
        virgl: current.virgl === true,
        paths: windowsPaths(STORE, name),
        isoPath: current.isoPath,
        qmpPort: reconciled.ports.qmp,
        vncPort: reconciled.ports.vnc,
        sshPort: reconciled.ports.ssh
      }, { installPending })
    } catch (error) {
      // THE CAPTURED STDERR BELONGS ON THE ROW, not only in the exception: the
      // panel renders `errorLog`, and a start that died at init is exactly the
      // case where the log is the whole story.
      const stderrTail = windowsQemuStderrTail(name, 20)
      await mutateRegistry((fresh) => {
        const row = fresh.vms[name]
        if (!row) return
        row.state = 'error'
        row.error = `could not start the Windows computer: ${error?.message ?? error}`
        if (stderrTail !== '') row.errorLog = stderrTail.slice(-4000)
      })
      if (stderrTail !== '') log(`windows: ${name} qemu-stderr.log tail:\n${stderrTail}`)
      // `portsChanged` is diagnostic gold: a failed boot that also moved the
      // port triple is a different bug from one that kept it.
      return fail(`could not start ${name}: ${error?.message ?? error}`, { ports: reconciled.ports, portsChanged: reconciled.changed })
    }
    // H5: PROVE IT IS RUNNING BEFORE TRUSTING IT. The old code deleted
    // `restoreFrom` and reported a state captured BEFORE the boot, so a QEMU
    // that died on a bad argv looked started and lost its restore point.
    // F2: the pidfile + a live pid are part of that proof — `probe()` alone asks
    // QMP, and a QEMU that exits between spawn and the first probe answers
    // nothing, which used to read as "still booting".
    let running = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await windowsBackend.probe({ ...current, ports: reconciled.ports })
      if (state.alive && state.status === 'running') { running = true; break }
      if (!state.alive && attempt > 2) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const earlyStderr = running ? '' : windowsQemuStderrTail(name, 20)
    const bootState = !running ? 'error' : (installPending ? 'installing' : 'booting')
    await mutateRegistry((fresh) => {
      const row = fresh.vms[name]
      if (!row) return
      row.ports = reconciled.ports
      row.state = bootState
      row.startedAt = new Date().toISOString()
      row.lastUsed = new Date().toISOString()
      // D2/D3: A NEW INSTALL STARTS WITH A CLEAN MEDIA/STAGE HISTORY. The argv
      // of an install boot re-attaches the CD and setup.img, so a row that once
      // reached ready must not keep `installMediaDetached` (the ready transition
      // would then never eject the NEW session's media) or a stale `booted`
      // stage.
      if (installPending) {
        delete row.installMediaDetached
        delete row.installMedia
        delete row.installStage
        delete row.bootedAt
      }
      if (running) {
        delete row.restoreFrom
        delete row.mayBeTorn
        row.installDetail = installPending ? 'Windows Setup is running' : 'the guest is booting'
      } else {
        row.error = 'QEMU started but did not reach `running` (see its serial log and qemu-stderr.log)'
        if (earlyStderr !== '') row.errorLog = earlyStderr.slice(-4000)
      }
    })
    if (!running) {
      // The same port diagnostics as the spawn-failure path: a start that failed
      // after moving the ports is a different bug from one that kept them.
      return fail(`${name} did not start: QEMU exited or never answered QMP. The restore point was kept.`, { ports: reconciled.ports, portsChanged: reconciled.changed })
    }
    watchWindowsInstall(name)
    await ensureWindowsConsoleRelay(name)
    return ok({
      name,
      state: bootState,
      kind: 'windows',
      console: `/vm/port/${name}/`,
      detail: installPending ? 'Windows Setup is running again' : 'the guest is booting from its disk'
    })
  })
}

async function windowsEnsure(name, meta) {
  return windowsStart(name, meta)
}

/**
 * SHUTDOWN a Windows computer: QMP `system_powerdown` → wait → `quit` →
 * checkpoint → `powered-off`.
 *
 * This is the SAME state machine the Linux computer uses — the only differences
 * are where the QMP socket lives (a row field, not a cua cmdline) and the swtpm
 * process, which is stopped with the guest.
 */
async function windowsShutdown(name, meta) {
  assertVmName(name)
  const config = readConfig()
  const preview = snapshotPorts(name)
  closePorts(name)
  stopLiveView(name)
  let outcome
  try {
    outcome = await windowsBackend.shutdown(meta, { timeoutMs: config.shutdownTimeoutSec * 1000 })
  } catch (error) {
    // H4: THE ABANDONED BRANCH MUST MARK THE RESTORE POINT, like Linux does.
    // A shutdown that throws because the monitor never answered leaves the disk
    // open; a restore point from before that is not trustworthy, and the next
    // Start must not silently boot it.
    const marked = await markWindowsShutdownAbandoned(name, 'its monitor did not answer')
    const reopened = await replaceLiveView(name, preview)
    log(`shutdown ${name}: abandoned — nothing was removed${marked ? ', restore point marked stale' : ''}${reopened ? '' : ', live view NOT reopened'}`)
    return fail(`could not power ${name} off: ${error?.message ?? error}. Nothing was removed${marked ? '; its restore point is now marked stale (Start will boot the existing disk instead of trusting it)' : ''}${reopened ? '' : '; the live view could NOT be reopened'}.`)
  }
  if (!outcome.exited) {
    // It survived ACPI and `quit`: the disk is still open, so it is NOT
    // checkpointed and the computer is still running.
    const marked = await markWindowsShutdownAbandoned(name, 'it survived the QMP quit')
    const reopened = await replaceLiveView(name, preview)
    return fail(`could not power ${name} off: QEMU is still running after a forced quit, so the disk is open and no checkpoint was taken.${marked ? ' Its restore point is now marked stale.' : ''}${reopened ? ' The live view was reopened.' : ' The live view could NOT be reopened.'} Use cua_vm_destroy to remove it.`)
  }
  let checkpoint = null
  let checkpointSkipped = ''
  if (config.checkpointPolicy === 'never') {
    checkpointSkipped = 'checkpointPolicy=never'
  } else {
    const paths = windowsPaths(STORE, name)
    const diskBytes = (() => { try { return statSync(paths.disk).size } catch { return 0 } })()
    const existing = (() => { try { return statSync(path.join(CHECKPOINT_DIR, `${name}.qcow2`)).size } catch { return 0 } })()
    const over = await refuseOverQuota(config, Math.max(0, diskBytes - existing))
    if (over !== null) {
      checkpointSkipped = 'the checkpoint does not fit the store quota'
    } else {
      // WINDOWS: its disk is under $STORE/windows/<name>/, not the cua vmm tree.
      checkpoint = checkpointDiskFile(name, windowsPaths(STORE, name).disk)
      if (checkpoint === null) checkpointSkipped = 'no disk to checkpoint'
    }
  }
  await mutateRegistry((registry) => {
    const row = registry.vms[name]
    if (!row) return
    row.state = 'powered-off'
    row.lastUsed = new Date().toISOString()
    row.lastShutdown = {
      at: new Date().toISOString(),
      method: outcome.method,
      reason: 'shutdown',
      // F2: a shutdown during Setup is recorded as what it was, so nothing
      // downstream has to infer "torn" from `mayBeTorn` alone.
      ...(outcome.installInProgress === true ? { installInProgress: true } : {}),
      ...(checkpointSkipped !== '' ? { checkpointSkipped } : {})
    }
    row.restoreFrom = checkpoint !== null
      ? { kind: 'checkpoint', file: checkpoint }
      : { kind: 'image', image: 'windows' }
    if (outcome.forced) row.mayBeTorn = true
    else delete row.mayBeTorn
  })
  log(`shutdown ${name} (${outcome.method}${outcome.forced ? ', forced' : ''}): ${checkpoint !== null ? 'checkpoint captured' : 'no checkpoint'}`)
  return ok({
    name,
    state: 'powered-off',
    method: outcome.method,
    checkpoint: checkpoint ?? undefined,
    mayBeTorn: outcome.forced || undefined,
    detail: `powered off via ${outcome.method}${checkpoint !== null ? '; its disk is checkpointed and Start cold-boots from it' : '; Start boots the disk it already has'}.${outcome.installInProgress === true ? ' The install was still in progress: this ABORTED it, its disk is marked mayBeTorn, and Start will not resume Setup.' : ''}`
  })
}

/* ------------------------------------------------------------------ *
 * DOCTOR + GC
 * ------------------------------------------------------------------ */

/**
 * What the HOST can do, answered from inside the supervisor because these are
 * exactly the facts the agent's sandbox cannot see: /dev/kvm, the render node,
 * whether the installed QEMU has virtio-gpu-gl-pci, and whether DOCKER_HOST
 * answers at all.
 */
async function doctorReport() {
  const mode = (target) => {
    try {
      const info = statSync(target)
      return `${(info.mode & 0o777).toString(8)} (${info.mode & 0o200 ? 'writable' : 'read-only'})`
    } catch {
      return 'absent'
    }
  }
  // THE DEVICE IS NOT A FILE. `mode('/dev/kvm')` described a character device
  // as "666 (writable)" and then `kvmUsable` was derived from the STRING
  // ("starts with 6 or 2"), which is true for a device this uid cannot open.
  // The observation now comes from the same probe the create path refuses on.
  const kvmFacts = kvmDoctorFacts(kvmStatus())
  const kvm = kvmFacts.kvm
  const render = mode('/dev/dri/renderD128')
  // No Docker Engine any more: the Windows backend IS qemu, so its health is
  // the host tools it needs (qemu, OVMF, swtpm, /dev/kvm).
  const docker = { reachable: windowsBackend.hostCaps().qemu, engine: WINDOWS_QEMU, detail: 'direct qemu (no Docker Engine)' }
  const config = readConfig()
  const usage = await storeUsage()
  const sandboxList = await listSandboxes()
  return ok({
    hostCaps: {
      kvm,
      kvmUsable: kvmFacts.kvmUsable,
      kvmState: kvmFacts.kvmState,
      kvmMode: kvmFacts.kvmMode,
      kvmOwner: kvmFacts.kvmOwner,
      kvmGroups: kvmFacts.kvmGroups,
      kvmReason: kvmFacts.kvmReason,
      renderNode: render,
      systemQemu: existsSync(SYSTEM_QEMU) ? SYSTEM_QEMU : 'absent (cua\'s own QEMU is used)',
      virtioGpuGl: systemQemuSupportsVirgl(),
      gpuDefault: gpuDefault(),
      gpuMode: String(process.env.DSH_CUA_VM_GPU || 'off'),
      desktop: DESKTOP_RESOLUTION,
      resolutionAllowed: resolutionProblem(DESKTOP_RESOLUTION, RESOLUTION_ALLOW_SCALE) === null,
      share: SHARE_WORKSPACE ? SHARE_TAG : 'off',
      spaceCacheMs: SPACE_CACHE_MS,
      docker: docker.reachable ? `reachable (${docker.engine})` : `unreachable (${docker.engine}: ${docker.detail})`
    },
    windows: {
      enabled: windowsEnabled(),
      backend: 'qemu',
      qemu: WINDOWS_QEMU,
      hostCaps: windowsBackend.hostCaps(),
      portRanges: { qmp: WINDOWS_QMP_RANGE, ssh: WINDOWS_SSH_RANGE, vnc: WINDOWS_VNC_RANGE },
      versions: WINDOWS_VERSIONS,
      isoSources: Object.fromEntries(Object.entries(WINDOWS_ISO_SOURCES).map(([key, value]) => [key, value.label])),
      liveView: 'noVNC over websockify, relayed at /vm/port/<name>/',
    },
    policy: config,
    store: {
      usedBytes: usage.totalBytes,
      quotaBytes: config.diskQuotaGb * 1024 ** 3,
      paths: usage.paths
    },
    vms: Object.keys(readRegistry().vms).length,
    sandboxes: Array.isArray(sandboxList.parsed) ? sandboxList.parsed.length : null,
    checkpointPolicy: config.checkpointPolicy,
    shutdownTimeoutSec: config.shutdownTimeoutSec
  })
}

const handlers = {
  async ping() {
    const version = await runCua(['--version'], { timeoutMs: 30000 })
    return ok({
      version: version.stdout.trim() || version.stderr.trim(),
      qemu: existsSync(path.join(CUA_HOME, '.cua', 'bin', 'qemu-system-x86_64')),
      store: STORE,
      workspaceRoot: WORKSPACE_ROOT,
      socket: SOCK
    })
  },

  async status() {
    const registry = readRegistry()
    const { parsed, raw } = await listSandboxes()
    return ok({ registry: registry.vms, listed: parsed ?? raw })
  },

  /**
   * Create or resume THE workspace computer.
   *
   * It now carries the whole spec (image, gpu, diskGb, android, rea) instead of
   * only tier/cpu/memory: a computer born from "the first cua_vm_exec" used to
   * record no image and no gpu, which is exactly what a rebuild needs. The
   * defaults come from normaliseSpec, the explicit values from the caller, and
   * a create is delegated to the SAME createManaged the panel uses — one code
   * path, one set of rules, one registry shape.
   *
   * The lock is taken here and NOT in createManaged (a nested withLock on the
   * same name would deadlock waiting for itself).
   */
  async ensure(input = {}) {
    const spec = normaliseSpec(input)
    const real = realpathSync(spec.workspace)
    const name = vmName(real)
    spec.workspace = real
    return withLock(name, async () => {
      const registry = readRegistry()
      const known = registry.vms[name]
      if (known?.kind === 'windows') return windowsEnsure(name, known)
      const { parsed } = await listSandboxes()
      const listed = findListed(parsed, name)
      const exists = Boolean(known || listed)

      if (exists) {
        const state = String((listed && (listed.status || listed.phase)) || (known && known.state) || 'unknown')
        if (!/ready|running|started/i.test(state)) {
          const resumed = await runCua(['sb', 'resume', '--local', name], { timeoutMs: 180000 })
          if (resumed.code !== 0) {
            space.invalidate(name)
            const restarted = await runCua(['sb', 'restart', '--local', name], { timeoutMs: 180000 })
            if (restarted.code !== 0) {
              // A QEMU VM whose process died (the harness container was replaced,
              // or the host restarted) cannot be started again — cua says so
              // explicitly. Rebuild it from the checkpoint of the base image so
              // the workspace keeps a computer, and say that the previous disk
              // did not survive.
              log(`recovering ${name}: ${(restarted.stderr || restarted.stdout).trim().slice(-200)}`)
              const snapshot = checkpointSandbox(name)
              await runCua(['sb', 'rm', '--local', name, '--force'], { timeoutMs: 180000 })
              await ensureRuntime()
              const bootImage = snapshot !== null ? `${snapshot}.restore.qcow2` : (known?.image || 'linux')
              if (snapshot !== null) copyFileSync(snapshot, bootImage)
              installQemuShim()
              // The FULL recorded spec, not just tier/cpu/memory: an image, a
              // GPU and a disk size are what make the rebuilt computer the one
              // the user had.
              let recreated = await runCua(createArgs(
                name,
                known?.tier || spec.tier,
                known?.cpu || spec.cpu,
                known?.memory || spec.memory,
                spec.waitDesktop,
                bootImage,
                known?.gpu === true
              ), { timeoutMs: 1500000 })
              if (recreated.code !== 0 && snapshot !== null) {
                log(`restore from checkpoint failed for ${name}; falling back to the base image`)
                // A failed create can leave a record that holds the name.
                await runCua(['sb', 'rm', '--local', name, '--force'], { timeoutMs: 180000 })
                recreated = await runCua(createArgs(name, known?.tier || spec.tier, known?.cpu || spec.cpu, known?.memory || spec.memory, spec.waitDesktop, known?.image || 'linux', known?.gpu === true), { timeoutMs: 1500000 })
              }
              if (snapshot !== null) { try { unlinkSync(bootImage) } catch {} }
              if (recreated.code !== 0) {
                return fail(`the VM could not be resumed or recreated: ${(recreated.stderr || recreated.stdout).trim().slice(-1200)}`)
              }
              await mutateRegistry((fresh) => {
                fresh.vms[name] = {
                  // Everything the old row knew (rea, diskGb, image, android,
                  // kind, windows fields …) survives the rebuild. Only the disk
                  // did not — and dropping `rea` here would quietly turn a RE
                  // computer back into a plain desktop the next time it restarted.
                  ...(fresh.vms[name] || known || {}),
                  workspace: real,
                  tier: String(known?.tier || spec.tier),
                  cpu: known?.cpu || spec.cpu,
                  memory: known?.memory || spec.memory,
                  image: String(known?.image || spec.image),
                  gpu: known?.gpu === true,
                  createdAt: new Date().toISOString(),
                  lastUsed: new Date().toISOString(),
                  state: 'ready'
                }
                delete fresh.vms[name].restoreFrom
                delete fresh.vms[name].mayBeTorn
              })
              // The rebuilt disk is the base image at the stock build size, so
              // the 40 GB REA floor vmCreate applied is gone even though the
              // row still says diskGb: 40. Put the size back BEFORE the kit
              // unpacks Ghidra into it.
              await regrowDiskAfterRebuild(name, readRegistry().vms[name])
              // The rebuilt disk is the base image, so every provisioned layer
              // is gone with it. Put the RE kit back when this computer had
              // one; the desktop provisioning happens on the next exec.
              const reaBack = known?.rea === true ? await provisionReaGuest(name) : null
              if (reaBack !== null) log(`recovering ${name}: rea ${reaBack.ok ? 're-provisioned' : 're-provision failed'}`)
              return ok({ name, state: 'ready', created: true, recovered: true, tier: readRegistry().vms[name]?.tier, rea: reaBack ? reaBack.ok : undefined })
            }
          }
        }
        const record = await mutateRegistry((fresh) => {
          fresh.vms[name] = {
            ...(fresh.vms[name] || known || {}),
            workspace: real,
            tier: known?.tier || spec.tier,
            state: 'ready',
            lastUsed: new Date().toISOString()
          }
          delete fresh.vms[name].restoreFrom
          return fresh.vms[name]
        })
        space.invalidate(name)
        return ok({ name, state: 'ready', created: false, tier: record.tier, kind: 'linux' })
      }

      return createManaged({ ...spec, name })
    })
  },

  /**
   * Start a computer.
   *
   * THE TRAP THIS EXISTS FOR: `cua sb resume` only works on a sandbox cua still
   * knows about. A computer that went through `cua_vm_shutdown` has had its
   * sandbox REMOVED on purpose (that is what makes the powerdown real), so
   * resume answers "sandbox not found" — for ever — and every Start button was a
   * dead end that ended in a rebuild. A `powered-off` row therefore cold-boots
   * from its checkpoint and never asks cua to resume anything.
   */
  async vmStart({ name }) {
    return withVmLock(name, async () => {
      const registry = readRegistry()
      const meta = registry.vms[name]
      if (!meta) throw new Error(`no computer named "${name}"`)
      if (meta.kind === 'windows') return windowsStart(name, meta)
      space.invalidate(name)
      if (meta.state === 'powered-off') return startFromCheckpoint(name, meta)
      let result = await runCua(['sb', 'resume', '--local', name], { timeoutMs: 180000 })
      if (result.code !== 0) result = await runCua(['sb', 'restart', '--local', name], { timeoutMs: 180000 })
      if (result.code !== 0) {
        // Same reality as ensure: a QEMU VM whose process is gone cannot start.
        // Rebuild it from its recorded spec so the Start button is never a dead end.
        log(`start: recreating ${name} after "${(result.stderr || result.stdout).trim().slice(-160)}"`)
        const snapshot = checkpointSandbox(name)
        await runCua(['sb', 'rm', '--local', name, '--force'], { timeoutMs: 180000 })
        await ensureRuntime()
        const bootImage = snapshot !== null ? `${snapshot}.restore.qcow2` : (meta.image || 'linux')
        if (snapshot !== null) copyFileSync(snapshot, bootImage)
        installQemuShim()
        result = await runCua(createArgs(name, meta.tier, meta.cpu, meta.memory, false, bootImage, meta.gpu === true), { timeoutMs: 1500000 })
        if (result.code !== 0 && snapshot !== null) {
          log(`restore from checkpoint failed for ${name}; falling back to ${meta.image || 'linux'}`)
          // A failed create can leave a record that holds the name.
        await runCua(['sb', 'rm', '--local', name, '--force'], { timeoutMs: 180000 })
        result = await runCua(createArgs(name, meta.tier, meta.cpu, meta.memory, false, meta.image || 'linux', meta.gpu === true), { timeoutMs: 1500000 })
        }
        if (snapshot !== null) { try { unlinkSync(bootImage) } catch {} }
        if (result.code !== 0) return fail((result.stderr || result.stdout).trim().slice(-800))
        // Same rebuild, same lost floor: this disk came from base/meta.image (or
        // a checkpoint whose size is not guaranteed), so re-apply the REA size
        // before the kit is asked to fit into it.
        await regrowDiskAfterRebuild(name, meta)
      }
      await mutateRegistry((fresh) => {
        const row = fresh.vms[name]
        if (!row) return
        row.state = 'ready'
        row.lastUsed = new Date().toISOString()
        delete row.restoreFrom
        delete row.mayBeTorn
      })
      // Version-checked: an up-to-date disk answers in one exec, an outdated one
      // is re-provisioned here (the first start after an image update takes a
      // minute longer and the result says so). The REA layer has its own marker,
      // so a plain computer returns from it in one exec as well.
      const provisioned = await provisionGuest(name, { gpu: meta.gpu === true })
      const rea = meta.rea === true ? await provisionReaGuest(name) : null
      return ok({
        name,
        state: 'ready',
        provisioned: provisioned.ok,
        rea: rea ? rea.ok : undefined,
        renderer: provisioned.renderer,
        output: provisioned.ok ? (rea && !rea.ok ? rea.output.slice(-1200) : undefined) : provisioned.output.slice(-1200)
      })
    })
  },
  /**
   * Create a NAMED computer with an explicit spec, the way the Computers page
   * asks for one. `image` is a cua alias or an OCI reference; unknown aliases
   * fail at create with cua's own message, which is better than a silent
   * substitution. Debian/Arch are not Cua disk images: they need
   * `cua images build` and a pinned reference, so the UI offers aliases only.
   *
   * The lock lives HERE and not in createManaged: ensure() already holds it when
   * it decides there is no computer yet, and a second withLock on the same name
   * would wait for the first one for ever.
   */
  async vmCreate(input = {}) {
    const spec = normaliseSpec(input)
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(String(spec.name || ''))) {
      throw new Error('name must be 2-31 chars: lowercase letters, digits and dashes')
    }
    // B1: WHICH NUMBERS DID THE CALLER ACTUALLY CHOOSE? `normaliseSpec` fills the
    // LINUX defaults, so "omitted" has to be carried explicitly — otherwise a
    // Windows create through THIS op (the panel's path) always looked like
    // "nothing was given" and windowsCreateManaged wrote its own defaults
    // (64 GB / 6 GB / 2 vCPU) over the requested 20 GB / 4 GB. `vmWindowsCreate`
    // already did this; the panel does not call it (it posts kind:'windows' to
    // `create`), so the flags were lost on the path users actually take.
    spec.diskGiven = Number(input.diskGb) > 0
    spec.memoryGiven = Number(input.memory) > 0
    spec.cpuGiven = Number(input.cpu) > 0
    return withLock(spec.name, () => createManaged(spec))
  },

  async exec({ name, cmd, cwd, timeout = 300 }) {
    if (!name) throw new Error('name is required')
    if (typeof cmd !== 'string' || cmd.trim().length === 0) throw new Error('cmd is required')
    const meta = readRegistry().vms[name]
    if (meta?.kind === 'windows') {
      // THE AGENT SURFACE IS SSH. A Windows guest has no cua-spacesd, so the
      // command runs through the OpenSSH server the answer file installs; the
      // remote shell is cmd.exe by default and `cwd` is passed to `cd /d`.
      const started = Date.now()
      if (meta.state !== 'ready') {
        return ok({ exit: 126, stdout: '', stderr: WINDOWS_NO_AGENT('exec'), ms: 0, available: false })
      }
      const remote = cwd ? `cd /d ${quoteForWindows(cwd)} && ${cmd}` : cmd
      const result = await sshRun(meta, remote, { timeoutMs: (Number(timeout) || 300) * 1000 + 30000 })
      await mutateRegistry((registry) => {
        const row = registry.vms[name]
        if (!row) return
        row.lastUsed = new Date().toISOString()
        row.lastCommand = cmd.slice(0, 500)
      })
      return ok({ exit: result.code, stdout: result.stdout, stderr: result.stderr, ms: Date.now() - started, timedOut: result.timedOut })
    }
    const args = ['sb', 'exec', '--local', name, '--timeout', String(Math.max(1, Number(timeout) || 300))]
    if (cwd) args.push('--cwd', String(cwd))
    args.push(cmd)
    const started = Date.now()
    activeExecs.set(name, (activeExecs.get(name) || 0) + 1)
    let result
    try {
      result = await runCua(args, { timeoutMs: (Number(timeout) || 300) * 1000 + 30000 })
    } finally {
      activeExecs.set(name, Math.max(0, (activeExecs.get(name) || 1) - 1))
    }
    await mutateRegistry((registry) => {
      if (!registry.vms[name]) return
      registry.vms[name].lastUsed = new Date().toISOString()
      registry.vms[name].lastCommand = cmd.slice(0, 500)
    })
    return ok({
      exit: result.timedOut ? 124 : result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      ms: Date.now() - started,
      timedOut: result.timedOut
    })
  },

  async put({ name, local, guest }) {
    if (!name) throw new Error('name is required')
    const putMeta = readRegistry().vms[name]
    if (putMeta?.kind === 'windows') {
      if (putMeta.state !== 'ready') return ok({ available: false, name, local, guest, message: WINDOWS_NO_AGENT('put') })
      const source = workspacePath(local, { mustExist: true })
      // scp speaks POSIX paths; Windows OpenSSH accepts forward slashes and
      // `/c/...`-style is NOT valid, so a drive path is normalised here.
      const result = await scpRun(putMeta, source, assertWindowsGuestPath(guest), { direction: 'to-guest' })
      if (result.code !== 0) return fail(`vm_put failed over SSH: ${result.stderr.trim().slice(-600)}`)
      return ok({ local: source, guest })
    }
    if (typeof guest !== 'string' || !guest.startsWith('/')) throw new Error('guest must be an absolute guest path')
    const source = workspacePath(local, { mustExist: true })
    const result = await runCua(['sb', 'cp', '--local', source, `${name}:${guest}`], { timeoutMs: 600000 })
    if (result.code !== 0) return fail(`vm_put failed: ${(result.stderr || result.stdout).trim().slice(-1000)}`)
    return ok({ local: source, guest })
  },

  async get({ name, guest, local }) {
    if (!name) throw new Error('name is required')
    const getMeta = readRegistry().vms[name]
    if (getMeta?.kind === 'windows') {
      if (getMeta.state !== 'ready') return ok({ available: false, name, guest, local, message: WINDOWS_NO_AGENT('get') })
      const root = realpathSync(WORKSPACE_ROOT)
      const absolute = path.isAbsolute(local) ? path.normalize(local) : path.join(root, local)
      if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error(`path escapes the workspace: ${local}`)
      mkdirSync(path.dirname(absolute), { recursive: true })
      const result = await scpRun(getMeta, absolute, assertWindowsGuestPath(guest), { direction: 'from-guest' })
      if (result.code !== 0) return fail(`vm_get failed over SSH: ${result.stderr.trim().slice(-600)}`)
      return ok({ guest, local: absolute, bytes: statSync(absolute).size })
    }
    if (typeof guest !== 'string' || !guest.startsWith('/')) throw new Error('guest must be an absolute guest path')
    // Create the destination directory first: a fresh project has no shots/
    // folder, and "no such path" is a dead end the model cannot fix cheaply.
    const root = realpathSync(WORKSPACE_ROOT)
    const absolute = path.isAbsolute(local) ? path.normalize(local) : path.join(root, local)
    if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error(`path escapes the workspace: ${local}`)
    mkdirSync(path.dirname(absolute), { recursive: true })
    const target = workspacePath(local, { forWrite: true })
    const result = await runCua(['sb', 'cp', '--local', `${name}:${guest}`, target], { timeoutMs: 600000 })
    if (result.code !== 0) return fail(`vm_get failed: ${(result.stderr || result.stdout).trim().slice(-1000)}`)
    return ok({ guest, local: target, bytes: statSync(target).size })
  },

  /**
   * Open a real forward for one guest port and publish it as /vm/port/<name>/.
   * The forward lives until portClose, shutdown or destroy — the proxy reads
   * ports.json, so a page survives a harness restart as long as the VM does.
   * A Windows computer's live view is already a relay; asking for it again
   * returns the same row instead of a second listener.
   */
  async port({ name, guestPort = 8080 }) {
    if (!name) throw new Error('name is required')
    const meta = readRegistry().vms[name]
    const wanted = Number(guestPort) || 8080
    if (meta?.kind === 'windows') {
      // A Windows computer's only published surface is its LIVE VIEW: the
      // noVNC page the supervisor relays. Guest ports are reachable through
      // SSH (cua_vm_exec → localhost:PORT inside the guest), and there is no
      // cua port-forward agent to open one.
      if (wanted !== 5900) {
        return fail('a Windows computer exposes its live view at /vm/port/<name>/; other guest ports are reachable through cua_vm_exec (ssh → localhost:PORT in the guest), not through the proxy.')
      }
      const relayed = await ensureWindowsConsoleRelay(name)
      if (relayed === null) return fail('the live view is not up yet (the display has not started or websockify is missing)')
      return ok(relayed)
    }
    const opened = await openPort(name, wanted)
    return ok(opened)
  },

  async portClose({ name }) {
    closePorts(name)
    return ok({ name, closed: true })
  },

  /** Every VM this store knows, with its own spec — not just workspace-derived. */
  async vmList() {
    const { parsed, raw } = await listSandboxes()
    const registry = readRegistry()
    // The registry remembers the spec; cua owns the live state. Report the live
    // one so the page never says "ready" about a paused VM.
    const rows = Array.isArray(parsed) ? parsed : []
    for (const row of rows) {
      if (row?.name && registry.vms[row.name] && registry.vms[row.name].kind !== 'windows') {
        registry.vms[row.name].state = row.state || row.status || registry.vms[row.name].state
      }
    }
    return ok({
      registry: registry.vms,
      listed: parsed ?? raw,
      windows: {
        ok: windowsEnabled(),
        backend: 'qemu',
        qemu: WINDOWS_QEMU,
        hostCaps: windowsBackend.hostCaps(),
        liveView: 'noVNC over websockify at /vm/port/<name>/',
        ...(windowsEnabled() ? {} : { reason: 'the Windows backend is disabled (DSH_CUA_VM_WINDOWS=0)' })
      }
    })
  },

  /**
   * Force a re-provision of an existing computer (after an image update). Both
   * layers are re-run: the desktop one is version-guarded, the REA one has its
   * own marker. Success means BOTH answered — a start that restores the
   * desktop but silently drops the RE kit would be the worst of both.
   */
  async provision({ name }) {
    return withVmLock(name, async () => {
      const registry = readRegistry()
      const meta = registry.vms[name]
      if (!meta) return fail(`no computer named "${name}"`)
      const result = await provisionGuest(name, { gpu: meta.gpu === true })
      const rea = meta.rea === true ? await provisionReaGuest(name) : null
      const both = result.ok && (rea === null || rea.ok)
      if (!both) {
        const reaPart = rea !== null && !rea.ok ? `\nrea:\n${rea.output.slice(-900)}` : ''
        return fail(`provisioning failed:\n${result.output.slice(-1200)}${reaPart}`)
      }
      return ok({ name, renderer: result.renderer, rea: rea ? rea.ok : undefined, output: `${result.output.slice(-1500)}${rea ? `\n${rea.output.slice(-900)}` : ''}` })
    })
  },
  /**
   * Delete a computer and EVERYTHING it left in the store (see destroyVm): the
   * sandbox, its checkpoints and restore temp, its screenshots, its port and
   * viewer rows, its trajectory and QEMU directories, its Windows container and
   * its registry row. Every item is reported, and a failed `sb rm` no longer
   * keeps a 6 GB checkpoint alive.
   */
  async vmDelete({ name, force = false } = {}) {
    if (!name) throw new Error('name is required')
    return ok(await destroyVm(name, { reason: 'delete', force: force === true }))
  },

  /** Delete + "only when the user asks" alias, same manifest. */
  async destroy({ name, force = false } = {}) {
    if (!name) throw new Error('name is required')
    return ok(await destroyVm(name, { reason: 'destroy', force: force === true }))
  },

  /** Shutdown: ACPI powerdown → checkpoint → sandbox removed → powered-off. */
  async vmShutdown({ name, reason = 'shutdown' }) {
    if (!name) throw new Error('name is required')
    return shutdownVm(name, { reason })
  },

  /** Garbage collection: orphan checkpoints, old shots, stale views, dead ports. */
  async vmGc({ dryRun = false } = {}) {
    return ok(await collectGarbage({ dryRun: dryRun === true }))
  },

  /** Host capabilities the agent's sandbox cannot see. */
  async vmDoctor() {
    return doctorReport()
  },

  /** The measured coordinate space, for a caller that wants the numbers. */
  async vmSpace({ name }) {
    if (!name) throw new Error('name is required')
    const registry = readRegistry()
    if (registry.vms[name]?.kind === 'windows') {
      const frame = await windowsBackend.screenshot(registry.vms[name])
      const measured = frameSpace(frame.png)
      return ok({ name, ...measured, line: formatSpace(measured), warning: formatSpaceWarning(measured) || undefined })
    }
    const measured = await space.measure(name)
    if (measured === null) return fail('the desktop did not report its geometry')
    return ok({ name, ...measured, line: formatSpace(measured), warning: formatSpaceWarning(measured) || undefined })
  },

  /* ------------------------- Windows surface ------------------------- */

  async vmWindowsCreate(input = {}) {
    const spec = normaliseSpec({ ...input, kind: 'windows' })
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(String(spec.name || ''))) {
      throw new Error('name must be 2-31 chars: lowercase letters, digits and dashes')
    }
    // No floor clamp: `windowsCreateManaged` decides the effective values and
    // reports a warning when one is below the recommended default.
    spec.windowsVersion = canonicalWindowsVersion(spec.windowsVersion)
    // Which numbers did the caller actually choose? A default is not a request,
    // so an omitted memory must not read as "4 GB on purpose".
    spec.diskGiven = Number(input.diskGb) > 0
    spec.memoryGiven = Number(input.memory) > 0
    spec.cpuGiven = Number(input.cpu) > 0
    return withLock(spec.name, () => windowsCreateManaged(spec))
  },

  async vmWindowsStatus({ name, tail = 20 } = {}) {
    if (!name) throw new Error('name is required')
    const registry = readRegistry()
    const meta = registry.vms[name]
    if (!meta || meta.kind !== 'windows') return fail(`no Windows computer named "${name}"`)
    const timeoutMinutes = Number(meta.installTimeoutMinutes ?? readConfig().windowsInstallTimeoutMinutes)
    const verdict = await windowsBackend.probe(meta)
    // F3: THE STATUS POLL MUST NOT PROMOTE A HALF-INSTALL.
    //
    // This call omitted `phase`, so it took the RUNNING path: SSH, then the VNC
    // banner as the fallback. QEMU's VNC socket answers from the first second of
    // setup.exe, so an ordinary panel poll during Setup answered "ready", wrote
    // `installComplete = true` and `state: 'ready'` — the watcher then stopped
    // (its state guard says only installing/booting tick) and the idle timer
    // read a live install as an idle computer and suspended it under the user.
    // A row that is installing/booting is in SETUP: only SSH counts, exactly
    // like the watcher's own call.
    const installPhase = meta.state === 'installing' || meta.state === 'booting'
    // D3: THE SAME BOOT-FROM-DISK SIGNAL THE WATCHER USES. The panel polls every
    // 5 s and the watcher every 15 s, so without this the badge would keep
    // saying "Setup is running" for up to a quarter of a minute after the serial
    // log proved otherwise — and a watcher that was restarted would never say it
    // at all.
    const serialHead = windowsLogTail(name, 200)
    const bootedNow = installPhase && windowsBootedFromDisk(serialHead)
    const bootedAtMs = Date.parse(meta.bootedAt || '') || (bootedNow ? Date.now() : 0)
    const bootedStage = installPhase && bootedAtMs > 0
    const bootedMinutes = bootedStage ? Math.round((Date.now() - bootedAtMs) / 60000) : 0
    const ready = verdict.alive && verdict.status === 'running'
      ? await windowsBackend.ready(meta, { ssh: meta.ssh !== false, ...(installPhase ? { phase: 'install' } : {}) })
      : { ready: false, endpoint: 'none' }
    const state = !verdict.alive
      // A row that says `installing` with no process is STUCK, not "stopped":
      // the install never finished. Leaving the state as `stopped` hid the row a
      // user had to delete — the panel showed Start (which cannot work on a
      // half-written disk) instead of the one action that resolves it.
      ? (meta.state === 'installing' ? 'installing' : meta.state === 'powered-off' ? 'powered-off' : 'stopped')
      : verdict.status === 'paused' || verdict.status === 'suspended'
        ? 'suspended'
        : ready.ready ? 'ready' : 'installing'
    // Keep the row honest even when nobody is watching the install watcher —
    // EXCEPT for a stuck install, which stays `installing` on purpose so the
    // panel keeps offering Force delete for it.
    if (state !== meta.state && !(state === 'installing' && meta.state === 'installing')) {
      await mutateRegistry((fresh) => {
        const row = fresh.vms[name]
        if (!row) return
        row.state = state
        if (state === 'ready') {
          row.endpoint = ready.endpoint
          row.installComplete = true
          delete row.error
          // D3: a finished row must not keep answering with an install stage.
          delete row.installStage
          delete row.bootedAt
        }
      })
    }
    if (state === 'ready') await ensureWindowsConsoleRelay(name)
    // D2: the transition to ready also happens HERE when the panel polls faster
    // than the watcher ticks (or after a supervisor restart). Once-only is
    // enforced by `installMediaDetached` inside the helper.
    if (state === 'ready') await detachWindowsInstallMedia(name)
    // X8: per START ATTEMPT, the same clock the watcher's deadline uses; a
    // legacy row without startedAt still falls back to createdAt.
    const elapsedMinutes = Math.round((Date.now() - (Date.parse(meta.startedAt || meta.createdAt || '') || Date.now())) / 60000)
    // B3: HOW THE USER KNOWS IT FINISHED. The payload carries the same sentence
    // the watcher writes, the tail it was built from, and the two signals that
    // decide readiness — so the panel needs no second call and an agent polling
    // `cua_vm_status` reads the same facts as a human looking at the badge.
    const serialTail = windowsProgressTail(name, Math.max(1, Math.min(5, Number(tail) || 20)))
    // A ROW THAT SAYS `installing` WHILE QEMU IS GONE IS STUCK, not merely
    // stopped: the install never finished and the process that was doing it is
    // not there. The payload keeps the progress sentence (so the panel shows the
    // last thing Setup printed) and adds the one fact that explains it.
    const stuck = meta.state === 'installing' && !verdict.alive
    const showInstall = state === 'installing' || stuck
    const installDetail = state === 'ready'
      ? `ready (${endpointLabel(ready)} accepting, QMP ${qmpStateLabel(verdict)})`
      : showInstall
        ? `${formatWindowsInstallDetail({ phase: 'install', verdict: { ...verdict, endpoint: ready.endpoint }, elapsedMinutes, serialTail, sshPort: meta.ports?.ssh ?? 0, installStage: bootedStage ? 'booted' : 'installing', bootedMinutes })}${stuck ? ' No QEMU process is running for this row: the install is stuck — Force delete removes it.' : ''}`
        // F4: A FINISHED (OR FAILED) ROW STILL GETS A SENTENCE. `meta.installDetail`
        // is the LAST install sentence, and a row that never got one (a start
        // that died before the first watcher tick) used to answer `undefined` —
        // the same blank the user reported, one state later.
        : (typeof meta.installDetail === 'string' && meta.installDetail.trim() !== ''
            ? meta.installDetail
            : meta.state === 'error' && typeof meta.error === 'string'
              ? `error: ${meta.error}`
              : `not running (${meta.state}): the last start attempt did not reach a guest, so there is no install progress to show`)
    // THE SENTENCE GOES BACK TO THE ROW, not just into this answer: the list the
    // panel renders comes from `state.vms`, so a status poll is also what keeps
    // the row's progress picture fresh between watcher ticks (the watcher runs
    // every 15 s, this poll every 5 s while a computer installs).
    if (showInstall || state === 'ready') {
      await mutateRegistry((fresh) => {
        const row = fresh.vms[name]
        if (!row || row.kind !== 'windows') return
        row.installDetail = installDetail
        if (state === 'ready') {
          row.serialTail = []
          row.readiness = windowsReadinessSignals(name)
          return
        }
        row.serialTail = serialTail
        row.installTailAt = new Date().toISOString()
        row.readiness = windowsReadinessSignals(name)
        // D3: keep the stage on the row, stamped once, so the deadline and the
        // sentence survive a supervisor restart and a slow install that only
        // booted near the end of the 60-minute window.
        if (bootedStage) {
          row.installStage = 'booted'
          if (!row.bootedAt) row.bootedAt = new Date().toISOString()
        }
      })
    }
    return ok({
      name,
      kind: 'windows',
      backend: 'qemu',
      state: stuck ? 'installing' : state,
      stuck,
      // THE REQUESTED SPEC, not a default: the panel shows these numbers.
      diskGb: Number(meta.diskGb) > 0 ? Number(meta.diskGb) : undefined,
      memory: Number(meta.memory) > 0 ? Number(meta.memory) : undefined,
      cpu: Number(meta.cpu) > 0 ? Number(meta.cpu) : undefined,
      windowsVersion: meta.windowsVersion || '',
      warnings: meta.warnings ?? [],
      detail: verdict.alive
        ? `QMP ${qmpStateLabel(verdict)}, ${endpointLabel(ready)}`
        : stuck
          ? 'the row says installing but no QEMU process is running: this install is stuck, and Force delete removes it (the normal delete keeps the disk)'
          : 'no QEMU process',
      // THE ONE SENTENCE THE PANEL PRINTS. During install it is the progress
      // formatter's answer (never "undefined", never a bare phase); otherwise it
      // is the ready/booting sentence the watcher would have written.
      installDetail,
      serialTail: showInstall ? serialTail : [],
      elapsedMinutes,
      // D3: WHICH HALF OF THE INSTALL IS BEING WAITED ON. 'booted' means the
      // installed disk is up and OpenSSH is what has not answered yet — the
      // distinction the user needed and the old payload could not make.
      installStage: showInstall ? (bootedStage ? 'booted' : 'installing') : undefined,
      bootedMinutes: showInstall && bootedStage ? bootedMinutes : undefined,
      readiness: windowsReadinessSignals(name),
      // ONE LINE A MODEL CAN ACT ON without composing its own readiness rules.
      operationalNote: state === 'installing'
        ? (bootedStage
          ? 'the installed disk has booted; OpenSSH is installed by firstboot, so if this never answers the firstboot script failed — check the noVNC view, then Force delete + recreate'
          : 'poll this call until state is "ready" (or call cua_vm_status): readiness answers when the SSH banner answers AND QMP says running; a timeout past installTimeoutMinutes marks the row error with the serial tail')
        : state === 'ready' ? `exec/put/get work over SSH; the desktop is cua_vm_gui over QMP, or the live view at /vm/port/${name}/` : undefined,
      installTimeoutMinutes: timeoutMinutes,
      console: state === 'ready' ? `/vm/port/${name}/` : undefined,
      ports: meta.ports,
      logTail: windowsLogTail(name, Math.max(1, Math.min(200, Number(tail) || 20))).slice(-4000)
    })
  },

  async vmWindowsLogs({ name, tail = 40 } = {}) {
    if (!name) throw new Error('name is required')
    return ok({ name, log: windowsLogTail(name, Math.max(1, Math.min(200, Number(tail) || 40))).slice(-4000) })
  },

  /**
   * The generated Windows password. It is read from the 0600 credentials file,
   * never from the registry — the registry is the thing that ends up in a bug
   * report.
   */
  async vmWindowsPassword({ name } = {}) {
    if (!name) throw new Error('name is required')
    const credentials = readWindowsCredentials(name)
    if (credentials === null) return fail(`no credentials are stored for "${name}" (only a Windows computer has them)`)
    // The file is written 0600; re-assert it on every read so a backup/restore
    // that lost the mode cannot leave a password world-readable.
    let healed = false
    try {
      const info = statSync(windowsCredentialsPath(name))
      if ((info.mode & 0o777) !== 0o600) {
        chmodSync(windowsCredentialsPath(name), 0o600)
        healed = true
      }
    } catch {}
    return ok({ name, username: credentials.username, password: credentials.password, createdAt: credentials.createdAt, modeHealed: healed || undefined })
  },

  /**
   * The facts the harness needs to attach the guest's dsh-cua MCP server, and
   * nothing more: host, SSH port, key path, user. The password never travels
   * here — the plugin speaks SSH with the per-computer key.
   */
  async vmWindowsMcp({ name = '' } = {}) {
    const registry = readRegistry()
    const entries = name === ''
      ? Object.entries(registry.vms).filter(([, row]) => row?.kind === 'windows')
      : [[name, registry.vms[name]]]
    const ready = entries.find(([, row]) => row?.kind === 'windows' && row.state === 'ready')
    if (ready === undefined) return ok({ available: false, reason: 'no ready Windows computer' })
    const [targetName, meta] = ready
    const verdict = await windowsBackend.ready(meta, { ssh: true })
    if (!verdict.ready) {
      return ok({ available: false, reason: `not ready (${verdict.endpoint === 'none' ? 'no endpoint answers' : verdict.endpoint})` })
    }
    return ok({
      available: true,
      name: targetName,
      host: '127.0.0.1',
      sshPort: meta.ports?.ssh ?? 0,
      keyPath: windowsPaths(STORE, targetName).sshKey,
      user: WINDOWS_USERNAME,
      endpoint: verdict.endpoint
    })
  },

  async vmWindowsStart({ name }) {
    const meta = readRegistry().vms[name]
    if (!meta || meta.kind !== 'windows') return fail(`no Windows computer named "${name}"`)
    return windowsStart(name, meta)
  },

  /**
   * One PNG still, base64. The viewer's video path needs a secure context,
   * which a LAN http page is not, so the panel offers frames as a fallback:
   * plain images work anywhere.
   */
  async screenshot({ name }) {
    const registry = readRegistry()
    if (registry.vms[name]?.kind === 'windows') {
      // The panel's frame view, on the QMP backend: the same PNG the model
      // would get, base64 for the <img> element.
      try {
        const frame = await windowsBackend.screenshot(readRegistry().vms[name])
        return ok({ name, png: frame.png.toString('base64'), source: 'qmp' })
      } catch (error) {
        return fail(`${error?.message ?? error}`)
      }
    }
    const file = path.join('/tmp', `cua-shot-${process.pid}-${Date.now()}.png`)
    const result = await runCua(['sb', 'screenshot', '--local', name, '-o', file], { timeoutMs: 60000 })
    if (result.code !== 0) {
      try { unlinkSync(file) } catch {}
      return fail((result.stderr || result.stdout).trim().slice(-500))
    }
    try {
      const png = readFileSync(file).toString('base64')
      return ok({ name, png })
    } finally {
      try { unlinkSync(file) } catch {}
    }
  },

  /**
   * Input for the frame view. The viewer's own input rides its websocket and
   * needs a secure context, so a LAN http page drives the guest through
   * xdotool instead: clicks, typing and named keys. Text travels base64 so no
   * quoting can ever reach the shell.
   */
  async input({ name, kind, x, y, text, key }) {
    const registry = readRegistry()
    if (registry.vms[name]?.kind === 'windows') {
      // The frame view's clicks and typing, on the QMP backend. The frame IS the
      // display, so the coordinates need no conversion.
      try {
        if (kind === 'click') {
          const frame = await windowsBackend.screenshot(meta)
          const measured = frameSpace(frame.png)
          const px = Math.max(0, Math.round(Number(x) || 0))
          const py = Math.max(0, Math.round(Number(y) || 0))
          await windowsBackend.click(meta, px, py, { width: measured.display.width, height: measured.display.height })
          return ok({ name, kind, source: 'qmp' })
        }
        if (kind === 'type') {
          await windowsBackend.sendKeys(meta, { text: String(text ?? '') })
          return ok({ name, kind, source: 'qmp' })
        }
        if (kind === 'key') {
          await windowsBackend.sendKeys(meta, { key: String(key ?? '') })
          return ok({ name, kind, source: 'qmp' })
        }
        return fail(`unknown input kind: ${kind}`)
      } catch (error) {
        return fail(`${error?.message ?? error}`)
      }
    }
    const display = 'DISPLAY=${DISPLAY:-:1}'
    let command
    if (kind === 'click') {
      // The panel clicked a pixel in a frame it rendered; on the measured
      // backend that pixel is a screenshot pixel, so the same `cua do` path the
      // model uses applies. xdotool stays the fallback for a frame-view click
      // when the daemon is restarting.
      const measured = await space.measure(name).catch(() => null)
      const px = Math.max(0, Math.round(Number(x) || 0))
      const py = Math.max(0, Math.round(Number(y) || 0))
      const viaCua = await runCua(['do', 'click', String(px), String(py)], { timeoutMs: 30000 })
      if (viaCua.code === 0) return ok({ name, kind, source: 'cua' })
      if (measured === null) return fail((viaCua.stderr || viaCua.stdout).trim().slice(-400))
      const target = toDisplayPixels(measured, px, py)
      command = `${display} xdotool mousemove ${target.x} ${target.y} click 1`
      const result = await runCua(['sb', 'exec', '--local', name, '--timeout', '20', command], { timeoutMs: 60000 })
      if (result.code !== 0) return fail((result.stderr || result.stdout).trim().slice(-400))
      return ok({ name, kind, source: 'xdotool', display: target })
    }
    if (kind === 'type') {
      const b64 = Buffer.from(String(text ?? ''), 'utf8').toString('base64')
      command = `printf %s ${b64} | base64 -d | ${display} xdotool type --clearmodifiers --delay 20 --file -`
    } else if (kind === 'key') {
      const allowed = /^[A-Za-z0-9_+\-]+$/
      const pressed = String(key ?? '')
      if (!allowed.test(pressed)) throw new Error('unsupported key name')
      command = `${display} xdotool key --clearmodifiers ${pressed}`
    } else {
      throw new Error(`unknown input kind: ${kind}`)
    }
    const result = await runCua(['sb', 'exec', '--local', name, '--timeout', '20', command], { timeoutMs: 60000 })
    if (result.code !== 0) return fail((result.stderr || result.stdout).trim().slice(-400))
    return ok({ name, kind })
  },

  /**
   * COORDINATES: one space, and it is the screenshot.
   *
   * cua captures at most ~900k pixels, so a 1280x800 display comes back as a
   * 1200x750 PNG — every "the click landed 6% off" report was this, because
   * the old code took the screenshot from cua but clicked with xdotool in
   * *display* pixels. cua's own input verbs take **screenshot pixels** and
   * map them internally (`cua do click 600 375` on a 1280x800 display puts
   * the pointer at 640,400 — verified). So every pointer and keyboard action
   * goes through `cua do` and the model can use the pixels it sees, with no
   * arithmetic and no fractional guesswork. Pair this with a 1200x750
   * desktop (cua-guest-provision.sh) and image pixels are display pixels too.
   */
  async gui({ name, action, x, y, x2, y2, text, key, direction, amount, app, window: windowName, path: target, save, region = null, scale = 1, relative = false, smooth = true, steps = 6, durationMs = 200 }) {
    const num = (value) => {
      const parsed = Math.round(Number(value))
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error('coordinates must be positive numbers')
      return parsed
    }
    const pointer = ['click', 'dclick', 'move', 'drag'].includes(action)
    const registry = readRegistry()
    if (registry.vms[name]?.kind === 'windows') return windowsGui({ name, action, x, y, x2, y2, text, key, save, app, window: windowName, path: target, relative, region, scale })
    // A powered-off computer has no sandbox to drive: `sb resume` would answer
    // "not found" for two minutes and then the action would be applied to
    // nothing. Say what to do instead.
    if (registry.vms[name]?.state === 'powered-off') {
      return fail(`${name} is powered off. Start it with cua_vm_start (it cold-boots from its checkpoint) before driving its desktop.`)
    }
    await runCua(['sb', 'resume', '--local', name], { timeoutMs: 120000 })

    // `do switch` also clears `zoom`, so it must not run on every call: the
    // model zooms to a window, takes two screenshots and clicks. Only switch
    // when the daemon is pointed at another computer (it keeps the target
    // across processes).
    if (DO_TARGET !== name) {
      const switched = await runCua(['do', 'switch', `local:${name}`], { timeoutMs: 60000 })
      if (switched.code !== 0) return fail((switched.stderr || switched.stdout).trim().slice(-400))
      // A different computer is a different desktop: the cached space (and the
      // "cua already knows this capture" flag) belong to the previous one.
      if (DO_TARGET !== '') space.clear()
      SHOT_STATE.delete(name)
      DO_TARGET = name
    }

    /** Run one `cua do` verb, retrying while spacesd restarts with the desktop. */
    const doAct = async (argv) => {
      let result = await runCua(['do', ...argv], { timeoutMs: 120000 })
      let output = `${result.stdout}${result.stderr}`.trim()
      if (result.code !== 0 && /spacesd is not available|not answering|connection reset/iu.test(output)) {
        // The daemon restarted with the desktop: it lost the target (and the
        // zoom), so re-select and retry once.
        await new Promise((resolve) => setTimeout(resolve, 5000))
        const again = await runCua(['do', 'switch', `local:${name}`], { timeoutMs: 60000 })
        DO_TARGET = again.code === 0 ? name : ''
        result = await runCua(['do', ...argv], { timeoutMs: 120000 })
        output = `${result.stdout}${result.stderr}`.trim()
      }
      return { code: result.code, output }
    }

    /** Where the pointer actually is, in screen points, after an action. */
    const pointerNow = async () => {
      const read = await doAct(['cursor', '--json'])
      const matched = /\((-?\d+),\s*(-?\d+)\)/u.exec(read.output)
      return matched ? `${matched[1]},${matched[2]}` : ''
    }

    if (pointer) {
      // THE MEASURED SPACE, not an assumption.
      //
      // `cua do click` takes SCREENSHOT pixels and maps them to the display, so
      // the only thing a caller needs is the image it just looked at. What it
      // must never do is rescale by hand — and what this code must never do is
      // guess the capture size. space.measure() reads the display geometry from
      // the guest and the capture size from cua's own PNG (IHDR), so the ratio
      // is a measurement, cached for 30 s and dropped on resume/restart/zoom.
      let measured = await space.measure(name)
      if (measured === null) return fail('the guest did not report its display geometry, so the click space is unknown; take a screenshot first')
      // cua maps screenshot pixels to the display only once it knows the
      // capture size: its first click in a fresh daemon session is 1:1 screen
      // coordinates, every later one is scaled by image/display. Priming one
      // screenshot per VM makes the mapping deterministic, so the model never
      // gets a 6%-off click because it skipped looking first.
      if (!SHOT_STATE.has(name)) {
        await doAct(['screenshot', '-s', `/tmp/cua-prime-${process.pid}.png`, '--json'])
        SHOT_STATE.add(name)
        // The prime IS a capture: re-measure from it so the scale is the one
        // cua just learned, not a number from before the restart.
        const primed = await space.measure(name, { force: true })
        if (primed !== null) measured = primed
      }
      let toX = num(x)
      let toY = num(y)
      // A fractional coordinate (0..1) is invariant across the image→display
      // mapping, so it resolves against the MEASURED capture. The old
      // `sqrt(900000 / area)` was a guess at cua's pixel budget.
      if (relative === true) {
        const resolved = relativeToPixels(measured, x, y)
        toX = resolved.x
        toY = resolved.y
      }
      let argv
      let result
      if (action === 'drag') {
        const fromX = num(x)
        const fromY = num(y)
        const endX = num(x2)
        const endY = num(y2)
        result = await doAct(['drag', String(fromX), String(fromY), String(endX), String(endY)])
        toX = endX
        toY = endY
      } else {
        const steps_ = smooth === false ? 1 : Math.max(1, Math.min(12, Math.round(Number(steps) || 6)))
        if (steps_ > 1 && action !== 'move') {
          // A few intermediate moves make the agent's cursor animate for a
          // human watching the shared desktop; the last one is redundant.
          const read = await doAct(['cursor', '--json'])
          const from = /\((-?\d+),\s*(-?\d+)\)/u.exec(read.output)
          if (from) {
            const fx = Number(from[1])
            const fy = Number(from[2])
            for (let index = 1; index < steps_; index += 1) {
              const t = index / steps_
              const ease = (value) => (value < 0.5 ? 2 * value * value : 1 - ((-2 * value + 2) ** 2) / 2)
              const at = ease(t)
              await doAct(['move', String(Math.round(fx + (toX - fx) * at)), String(Math.round(fy + (toY - fy) * at))])
            }
          }
        }
        if (action === 'click') result = await doAct(['click', String(toX), String(toY)])
        else if (action === 'dclick') result = await doAct(['dclick', String(toX), String(toY)])
        else result = await doAct(['move', String(toX), String(toY)])
      }
      if (result.code !== 0) {
        // THE FALLBACK: `cua do` is gone (daemon restart, an image without the
        // verb). xdotool speaks DISPLAY pixels, so the image coordinate is
        // multiplied by the measured scale — `round(x * scale)` — and the answer
        // says which of the two paths ran.
        const display = 'DISPLAY=${DISPLAY:-:1}'
        const fallback = action === 'drag'
          ? `${display} xdotool mousemove ${toDisplayPixels(measured, num(x), num(y)).x} ${toDisplayPixels(measured, num(x), num(y)).y} mousedown 1 mousemove ${toDisplayPixels(measured, num(x2), num(y2)).x} ${toDisplayPixels(measured, num(x2), num(y2)).y} mouseup 1`
          : `${display} xdotool mousemove ${toDisplayPixels(measured, toX, toY).x} ${toDisplayPixels(measured, toX, toY).y}${action === 'move' ? '' : ` click ${action === 'dclick' ? '--repeat 2 --delay 80 1' : '1'}`}`
        const tried = await guestExec(name, fallback)
        if (tried.code !== 0) return fail(`${result.output.slice(-400)}\nthe xdotool fallback also failed: ${(tried.stderr || tried.stdout).trim().slice(-200)}`)
        const context = await guiContext(name)
        return ok({
          name,
          action,
          fellBack: 'xdotool',
          output: `${action} via xdotool at display pixel ${toDisplayPixels(measured, toX, toY).x},${toDisplayPixels(measured, toX, toY).y} (cua's own verb failed)\n${spaceLine(measured)}\n${context}`
        })
      }
      const at = await pointerNow()
      const context = await guiContext(name)
      return ok({
        name,
        action,
        output: `${action} at screenshot pixel ${toX},${toY} (cua maps it to the display)${at ? `\npointer now at screen ${at}` : ''}\n${spaceLine(measured)}\n${context}`
      })
    }

    if (action === 'screenshot') {
      // $STORE/shots, never a hardcoded /cua-vm: the store is configurable
      // (CUA_VM_STORE), and a screenshot written to the wrong tree is invisible
      // to cua_vm_gc and to the next destroy, so the volume fills silently.
      mkdirSync(SHOTS_DIR, { recursive: true })
      const stamp = Date.now()
      const hostFile = path.join(SHOTS_DIR, `${name}-${stamp}.png`)
      const guestFile = typeof save === 'string' && save.startsWith('/') ? save : `/home/cua/shots/${name}-${stamp}.png`
      const guestDir = guestFile.slice(0, guestFile.lastIndexOf('/')) || '/home/cua'
      await guestExec(name, `mkdir -p ${guestDir}`)
      const taken = await runCua(['do', 'screenshot', '-s', hostFile, '--json'], { timeoutMs: 120000 })
      if (taken.code !== 0) return fail((taken.stderr || taken.stdout).trim().slice(-400))

      // A region crop, magnified here, so the model does not have to crop and
      // zoom screenshots by hand (and lose track of the coordinate mapping).
      let source = hostFile
      let mapping = ''
      const area = region === null || region === undefined ? null : region
      if (area !== null) {
        const rx = Math.max(0, Math.round(Number(area.x) || 0))
        const ry = Math.max(0, Math.round(Number(area.y) || 0))
        const rw = Math.max(16, Math.min(4096, Math.round(Number(area.width ?? area.w) || 320)))
        const rh = Math.max(16, Math.min(4096, Math.round(Number(area.height ?? area.h) || 200)))
        const zoom = Math.max(1, Math.min(4, Number(area.scale ?? scale ?? 1) || 1))
        const hostCrop = path.join(SHOTS_DIR, `${name}-${stamp}-crop.png`)
        try {
          execFileSync('/usr/bin/convert', [hostFile, '-crop', `${rw}x${rh}+${rx}+${ry}`, '+repage', '-resize', `${Math.round(zoom * 100)}%`, hostCrop], { timeout: 30000 })
          source = hostCrop
          mapping = `crop ${rw}x${rh} at screenshot (${rx},${ry}) magnified ${zoom}x → this image is only for reading: to click, divide by ${zoom} and add the origin, i.e. click at (${rx} + px/${zoom}, ${ry} + py/${zoom}).\n`
        } catch (error) {
          mapping = `crop failed (${error && error.message}); the full frame below is unchanged.\n`
        }
      }

      const copied = await runCua(['sb', 'cp', source, `${name}:${guestFile}`], { timeoutMs: 120000 })
      // The PNG's own IHDR is the truth, and it costs a 24-byte read: no
      // ImageMagick spawn, no chance of disagreeing with the file the model sees.
      const measured = await space.measure(name, { force: true })
      let dimensions = 'unknown'
      try {
        const size = pngSize(readFileSync(source))
        if (size !== null) dimensions = `${size.width} ${size.height}`
      } catch {}
      if (dimensions === 'unknown') {
        try { dimensions = execFileSync('/usr/bin/identify', ['-format', '%w %h', source], { timeout: 20000 }).toString().trim() } catch {}
      }
      const head = measured === null
        ? `screenshot ${dimensions} — these are the pixels every pointer action takes (cua maps them).`
        : spaceLine(measured)
      if (copied.code !== 0) {
        return ok({ name, action, output: `${mapping}${head}\nscreenshot on the host: ${source} (copy into the guest failed; use this host path only from the panel)` })
      }
      return ok({ name, action, output: `${mapping}${head}\nscreenshot saved in the guest: ${guestFile}
fetch it with cua_vm_get {guest: "${guestFile}"}; the panel's copy is ${source}` })
    }

    if (action === 'geometry') {
      const read = await runCua(['sb', 'exec', '--local', name, '--timeout', '20',
        'DISPLAY=${DISPLAY:-:1} xdotool getdisplaygeometry; DISPLAY=${DISPLAY:-:1} xdotool getmouselocation --shell 2>/dev/null | head -2; DISPLAY=${DISPLAY:-:1} xdotool search --name "." getwindowname %@ 2>/dev/null | head -14'], { timeoutMs: 60000 })
      const geometry = /^(\d+)\s+(\d+)$/mu.exec(read.stdout)
      const px = (/X=(-?\d+)/u.exec(read.stdout) || [])[1]
      const py = (/Y=(-?\d+)/u.exec(read.stdout) || [])[1]
      const windows = cleanWindowList(read.stdout)
      // cua's own window list carries the bounds, which is what a click needs.
      const listed = await doAct(['window', 'ls'])
      const bounds = listWindows(listed.output)
      const at = await pointerNow()
      const measured = await space.measure(name, { force: true })
      return ok({
        name,
        action,
        output: `${measured === null ? `display: ${geometry ? `${geometry[1]}x${geometry[2]}` : 'unknown'}` : spaceLine(measured)}\npointer: ${at || `${px ?? '?'},${py ?? '?'}`} (screen points)\nwindows:\n${bounds.length > 0 ? bounds.map((w) => `- "${w.title}" at [${w.rect}]${w.app && w.app !== w.title ? ` (app: ${w.app})` : ''}`).join('\n') : (windows.map((w) => `- ${w}`).join('\n') || '- none')}\nuse \`zoom\` with one of these titles to crop the desktop to that window (coordinates stay correct).`
      })
    }

    if (action === 'zoom' || action === 'unzoom') {
      const target_ = action === 'zoom' ? String(windowName ?? app ?? '').trim() : ''
      if (action === 'zoom' && target_ === '') return fail('zoom needs a window title (see the windows list from geometry)')
      const result = action === 'zoom'
        ? await doAct(['zoom', target_])
        : await doAct(['unzoom'])
      if (result.code !== 0) return fail(result.output.slice(-500))
      // A zoom changes the capture (and therefore the image→display scale), so
      // the cached space and the primed-capture flag are both dropped.
      space.invalidate(name)
      SHOT_STATE.delete(name)
      const shot = await doAct(['screenshot', '-s', `/tmp/cua-zoom-${process.pid}.png`, '--json'])
      let size = ''
      try {
        size = execFileSync('/usr/bin/identify', ['-format', '%w %h', `/tmp/cua-zoom-${process.pid}.png`], { timeout: 20000 }).toString().trim()
      } catch {}
      return ok({ name, action, output: `${result.output}\n${action === 'zoom' ? `zoomed to "${target_}"` : 'back to the full screen'}${size ? `; screenshots are now ${size} and coordinates are relative to that image` : ''}. Take a screenshot to see it.` })
    }

    const argv = (() => {
      switch (action) {
        case 'type': return ['type', String(text ?? '')]
        case 'key': {
          if (!/^[A-Za-z0-9_+\-]+$/.test(String(key ?? ''))) throw new Error('unsupported key name')
          return ['key', String(key)]
        }
        case 'hotkey': {
          if (!/^[A-Za-z0-9_+\-]+$/.test(String(key ?? ''))) throw new Error('unsupported key combination')
          return ['hotkey', String(key)]
        }
        case 'scroll': {
          const dir = String(direction ?? 'down')
          if (!['up', 'down', 'left', 'right'].includes(dir)) throw new Error('direction must be up, down, left or right')
          return ['scroll', dir, String(Math.max(1, Math.min(50, Math.round(Number(amount) || 3))))]
        }
        case 'windows': return ['window', 'ls']
        case 'a11y': return ['a11y', 'tree', '--json']
        case 'clipboard': return ['clipboard']
        case 'launch': return ['launch', String(app ?? '')]
        case 'open': return ['open', String(target ?? '')]
        default: throw new Error(`unknown gui action: ${action}`)
      }
    })()

    const acted = await doAct(argv)
    let output = acted.output
    if (acted.code !== 0) {
      // AT-SPI is missing on most custom-drawn apps (Blender) and its error is a
      // dead end for the model. Answer with what IS available instead.
      if (action === 'a11y') {
        const fallback = await runCua(['sb', 'exec', '--local', name, '--timeout', '20',
          'DISPLAY=${DISPLAY:-:1} xdotool getdisplaygeometry; DISPLAY=${DISPLAY:-:1} xdotool getactivewindow getwindowname 2>/dev/null; DISPLAY=${DISPLAY:-:1} xdotool search --name "." getwindowname %@ 2>/dev/null | head -12'], { timeoutMs: 60000 })
        const geometry = /^(\d+)\s+(\d+)$/mu.exec(fallback.stdout)
        return ok({ name, action, output: `accessibility tree is unavailable for this app (AT-SPI not exposed).\ndisplay: ${geometry ? `${geometry[1]}x${geometry[2]}` : 'unknown'}\nwindows:\n${cleanWindowList(fallback.stdout).map((w) => `- ${w}`).join('\n') || '- none'}\nUse zoom + screenshot + screenshot pixels, or drive the app from its own scripting API.` })
      }
      return fail(output.slice(-600))
    }
    if (['type', 'key', 'hotkey', 'scroll', 'launch', 'open'].includes(action)) {
      const context = await guiContext(name)
      if (context !== '') output = `${output}\n${context}`
      // Keyboard actions are not pointer actions, but the caller is looking at
      // a screenshot while it types: the space line belongs on every desktop
      // result, or the one result that lacks it is the one someone trusts.
      const measured = await space.measure(name)
      if (measured !== null) output = `${output}\n${spaceLine(measured)}`
    }
    return ok({ name, action, output })
  },

  /**
   * The panel's cursor. X11 paints the pointer outside the capture, so the
   * frames view draws one from this position. It is also the cheapest way to
   * tell whether the model actually moved the mouse or just ran a shell
   * command. Deliberately does NOT `do switch` (that clears the agent's zoom).
   */
  async pointer({ name }) {
    if (DO_TARGET !== name) {
      const switched = await runCua(['do', 'switch', `local:${name}`], { timeoutMs: 60000 })
      if (switched.code !== 0) return fail((switched.stderr || switched.stdout).trim().slice(-300))
      DO_TARGET = name
    }
    const registry = readRegistry()
    if (registry.vms[name]?.kind === 'windows') {
      // QMP does not report a pointer position (the guest owns it), so the panel
      // draws no cursor on a Windows frame — the frame shows the real one.
      return ok({ name, x: 0, y: 0, width: 0, height: 0, source: 'qmp', detail: 'no pointer telemetry on the Windows backend' })
    }
    const read = await runCua(['do', 'cursor', '--json'], { timeoutMs: 30000 })
    const matched = /\((-?\d+),\s*(-?\d+)\)/u.exec(`${read.stdout}${read.stderr}`)
    if (!matched) return fail('the guest did not report a pointer position')
    // The display size comes from the SAME measurement every other coordinate
    // path uses, and from the same 30 s cache, so the drawn cursor can never
    // disagree with the frame it is drawn on.
    const measured = await space.measure(name)
    const width = measured?.display.width ?? 0
    const height = measured?.display.height ?? 0
    return ok({ name, x: Number(matched[1]), y: Number(matched[2]), width, height, scale: measured?.scale ?? 1, source: measured?.source ?? 'unknown' })
  },

  /** Grow the disk of a running computer; the filesystem grows online. */
  async vmDisk({ name, sizeGb }) {
    return withVmLock(name, async () => {
      const registry = readRegistry()
      if (!registry.vms[name]) return fail(`no computer named "${name}"`)
      if (registry.vms[name].kind === 'windows') {
        return ok({ available: false, name, message: `cua_vm_disk is not available for a Windows computer: ${WINDOWS_NO_AGENT('disk')} Its size is fixed at create time (DISK_SIZE in the container spec); destroy and recreate to change it.` })
      }
      try {
        const result = await growGuestDisk(name, Number(sizeGb))
        if (result.changed) {
          log(`disk: ${name} grew to ${result.sizeGb} GB`)
          await mutateRegistry((fresh) => {
            if (fresh.vms[name]) fresh.vms[name].diskGb = result.sizeGb
          })
        }
        return ok({ name, ...result })
      } catch (error) {
        return fail(`${error && error.message}`)
      }
    })
  },
  /** Install the Android SDK + an AVD inside the guest (several GB, one-off). */
  async vmAndroid({ name, api = 35, variant = 'google_apis', arch = 'x86_64', avd = 'cua' }) {
    return withVmLock(name, async () => {
      const registry = readRegistry()
      if (!registry.vms[name]) return fail(`no computer named "${name}"`)
      if (registry.vms[name].kind === 'windows') {
        return ok({ available: false, name, message: 'Android is not available for Windows computers: the SDK and the AVD run in a Linux guest.' })
      }
      const result = await provisionAndroidGuest(name, { api: Number(api) || 35, variant, arch, avd })
      return result.ok
        ? ok({ name, installed: true, output: result.output.slice(-1500) })
        : fail(`android provisioning failed:\n${result.output.slice(-1200)}`)
    })
  },
  /**
   * `stop` used to mean "suspend", because cua 0.7.0 has no power command of its
   * own. It means SHUTDOWN now: a real ACPI powerdown, a checkpoint, and a
   * `powered-off` row that Start cold-boots. DSH_CUA_VM_LEGACY_STOP=1 restores
   * the old alias for a caller that relied on it.
   */
  async stop({ name }) {
    if (String(process.env.DSH_CUA_VM_LEGACY_STOP || '') === '1') return handlers.suspend({ name })
    return handlers.vmShutdown({ name, reason: 'stop' })
  },

  /**
   * Mint the shared viewer link and publish it at /vm/view/<name>/.
   *
   * A Windows computer has no cua viewer (there is no spacesd to talk to): its
   * live view is the noVNC page relayed at /vm/port/<name>/, so that is what the
   * panel opens. Answering with a /vm/view link there would be a 502 with no
   * explanation.
   */
  async view({ name }) {
    if (!name) throw new Error('name is required')
    if (readRegistry().vms[name]?.kind === 'windows') {
      const relayed = await ensureWindowsConsoleRelay(name)
      if (relayed === null) return fail('the live view is not up yet: the display has not started, or websockify is missing from the image')
      return ok({ name, kind: 'windows', url: `/vm/port/${name}/`, hash: '', console: true })
    }
    const result = await runCua(['sb', 'view', '--no-open', '--json', '--local', name], { timeoutMs: 60000 })
    if (result.code !== 0) return fail((result.stderr || result.stdout).trim().slice(-600))
    let info
    try { info = JSON.parse(result.stdout) } catch { return fail('the viewer did not return a URL') }
    const url = new URL(info.url)
    const views = readViews()
    const ticket = new URLSearchParams(String(url.hash || '').replace(/^#/u, '')).get('ticket') || ''
    views[name] = {
      port: Number(url.port) || 0,
      path: url.pathname || '/viewer/',
      hash: url.hash || '',
      // The proxy accepts this hash instead of the gate cookie, because the
      // viewer's gRPC client sends the ticket but not cookies.
      ticketHash: ticket === '' ? '' : createHash('sha256').update(ticket).digest('hex'),
      expiresAt: Number(info.expires_at_unix ?? 0) * 1000,
      openedAt: new Date().toISOString()
    }
    writeViews(views)
    return ok({ name, url: `/vm/view/${name}/`, hash: views[name].hash })
  },

  /** The Computer page's Metrics tab: guest load/memory/disk, one round trip. */
  async vmMetrics({ name }) {
    if (readRegistry().vms[name]?.kind === 'windows') {
      return ok({ available: false, name, message: 'cua_vm_metrics reads /proc and free(1) inside the Linux guest; a Windows computer has no guest agent to ask. Use cua_vm_gui (screenshot) or the console at /vm/port/<name>/.' })
    }
    const result = await runCua(['sb', 'exec', '--local', name, '--timeout', '20',
      'echo "###load"; cat /proc/loadavg; echo "###mem"; free -m | sed -n 2p; echo "###disk"; df -h / | tail -1; echo "###cpu"; nproc'], { timeoutMs: 60000 })
    if (result.code !== 0) return fail((result.stderr || result.stdout).trim().slice(-600))
    const text = result.stdout
    const grab = (key) => (text.split(`###${key}`)[1] || '').split('###')[0].trim()
    const mem = (grab('mem') || '').split(/\s+/)
    const disk = (grab('disk') || '').split(/\s+/)
    return ok({
      name,
      load: (grab('load') || '').split(/\s+/).slice(0, 3).join(' '),
      memTotalMb: Number(mem[1]) || 0,
      memUsedMb: Number(mem[2]) || 0,
      diskSize: disk[1] || '',
      diskUsed: disk[2] || '',
      diskUsePct: disk[4] || '',
      cpus: Number(grab('cpu')) || 0
    })
  },

  async configGet() {
    return ok({ config: readConfig(), defaults: CONFIG_DEFAULTS, usedBytes: await storeUsedBytes() })
  },

  async configSet(request = {}) {
    const config = normaliseConfig({ ...readConfig(), ...request.config })
    writeConfig(config)
    log(`config saved: idle=${config.idleSuspendMinutes}m quota=${config.diskQuotaGb}GB max=${config.maxRunning} auto=${config.autoSuspend}`)
    return ok({ config })
  },

  async suspend({ name }) {
    return suspendVm(name)
  },

  async resume({ name }) {
    return resumeVm(name)
  }
}

const server = createServer((socket) => {
  let buffer = ''
  let handled = false
  socket.setEncoding('utf8')
  socket.on('data', async (chunk) => {
    if (handled) return
    buffer += chunk
    const newline = buffer.indexOf('\n')
    if (newline === -1) {
      if (buffer.length > 65536) socket.destroy()
      return
    }
    handled = true
    const line = buffer.slice(0, newline)
    let response
    try {
      const request = JSON.parse(line)
      // EVERY op that carries a name has it validated here, once: the name is a
      // path segment in the store, and a destructive handler that forgets to check
      // is one `"../.."` away from deleting something that is not a computer.
      if (request.name !== undefined && request.name !== null && request.name !== '') assertVmName(request.name)
      const handler = handlers[request.op]
      if (!handler) throw new Error(`unknown op: ${request.op}`)
      response = await handler(request)
    } catch (error) {
      response = fail(error)
    }
    socket.end(`${JSON.stringify(response)}\n`)
  })
  socket.on('error', () => {})
})

server.on('error', (error) => {
  log('server error:', error.message)
  process.exit(1)
})

// The idle timer is a policy, not a constant: it reads config.json every minute,
// so a change saved from the Plugins page takes effect without a restart.
setInterval(() => {
  const config = readConfig()
  if (config.autoSuspend !== true || config.idleSuspendMinutes <= 0) return
  // A THROW IN A TIMER IS FATAL. `readRegistry` throws on a corrupt file, and an
  // uncaught throw from a `setInterval` callback ends the process — the same
  // failure as the listen path, one minute later.
  let registry
  try {
    registry = readRegistry()
  } catch (error) {
    log(`idle: registry unreadable (${error?.message ?? error}); the idle timer skips this minute`)
    return
  }
  const now = Date.now()
  for (const [name, meta] of Object.entries(registry.vms)) {
    if (meta.state !== 'ready') continue
    if ((activeExecs.get(name) || 0) > 0) continue
    const last = Date.parse(meta.lastUsed || meta.createdAt || '') || 0
    // Unknown timestamps never trigger a suspend: a missing `lastUsed` must not
    // read as "idle since the epoch".
    if (last === 0 || now - last < config.idleSuspendMinutes * 60000) continue
    log(`idle: suspending ${name} after ${config.idleSuspendMinutes} min without use`)
    handlers.suspend({ name }).catch((error) => log(`idle suspend failed for ${name}: ${error.message}`))
  }
}, 60000).unref?.()

// THE v1→v2 MIGRATION IS A WRITE, so it runs once, under the registry lock,
// BEFORE the socket exists: a caller that connects must never observe a v1 file,
// and two concurrent readers must never race to write it.
try {
  await migrateRegistryFile()
} catch (error) {
  log(`registry: migration failed (${error?.message ?? error}); the first write will retry it`)
}

server.listen(SOCK, () => {
  try { chmodSync(SOCK, 0o600) } catch {}
  log(`listening on ${SOCK} (store ${STORE}, workspace ${WORKSPACE_ROOT})`)
  // BOOT RECONCILIATION: the ports table outlives this process. Every forward
  // child it named died with the previous container, so a row that still points
  // at a dead loopback port must go — otherwise /vm/port/<name>/ answers 502 for
  // a preview the panel shows as open.
  void reconcilePorts().catch((error) => log(`ports: boot reconciliation failed (${error?.message ?? error})`))
  // A Windows computer that was `installing` when the process stopped has no
  // watcher any more; resume watching the rows that are still in flight.
  //
  // GUARDED, because `readRegistry` throws on a corrupt file — and this callback
  // runs AFTER the socket exists but INSIDE the listen event: an uncaught throw
  // here took the whole process down (exit 1) with the cause only in the
  // container log, i.e. every VM tool dead because one JSON file was truncated.
  // A boot that cannot read the registry still has to serve `cua_vm_doctor`.
  try {
    for (const [name, meta] of Object.entries(readRegistry().vms)) {
      if (meta?.kind === 'windows' && meta.state === 'installing') {
        log(`windows: resuming the install watch for ${name}`)
        watchWindowsInstall(name)
      }
    }
  } catch (error) {
    log(`windows: install watches were NOT resumed (${error?.message ?? error}); fix registry.json and restart to pick them up`)
  }
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
