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

import { createServer, connect as netConnect } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync
} from 'node:fs'
import path from 'node:path'

const SOCK = process.env.CUA_SUPERVISOR_SOCK || '/tmp/cua-vm/supervisor.sock'
const CUA_BIN = process.env.CUA_BIN || 'cua'
const STORE = process.env.CUA_VM_STORE || '/cua-vm'
const CUA_HOME = process.env.CUA_VM_HOME || path.join(STORE, 'home')
const WORKSPACE_ROOT = process.env.CUA_WORKSPACE_ROOT || '/workspace'
const REGISTRY = path.join(STORE, 'registry.json')
const LOG_PREFIX = '[cua-vm]'

const CUA_ENV = {
  ...process.env,
  HOME: CUA_HOME,
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
const CONFIG_DEFAULTS = {
  idleSuspendMinutes: 30, // 0 disables the idle timer
  diskQuotaGb: 20,
  maxRunning: 1,
  autoSuspend: true
}

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
  return {
    idleSuspendMinutes: int(input.idleSuspendMinutes, CONFIG_DEFAULTS.idleSuspendMinutes, 0, 1440),
    diskQuotaGb: int(input.diskQuotaGb, CONFIG_DEFAULTS.diskQuotaGb, 1, 500),
    maxRunning: int(input.maxRunning, CONFIG_DEFAULTS.maxRunning, 1, 8),
    autoSuspend: input.autoSuspend !== false
  }
}

function writeConfig(config) {
  const tmp = `${CONFIG_FILE}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
  renameSync(tmp, CONFIG_FILE)
}

/** Bytes used by the cua store (images + disks + QEMU), measured on demand. */
function storeUsedBytes() {
  return new Promise((resolve) => {
    const child = spawn('du', ['-sb', path.join(CUA_HOME, '.cua')], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(0))
    child.on('close', () => resolve(Number(String(out).split(/\s+/)[0]) || 0))
  })
}

/* ------------------------------------------------------------------ *
 * PORT PREVIEWS — a real forward per (VM, guest port), published to the
 * proxy at /vm/port/<name>/ so a page the build started is reachable
 * from the harness origin instead of a bare loopback port.
 * ------------------------------------------------------------------ */
const PORTS_FILE = path.join(STORE, 'ports.json')
const PORT_BASE = Number(process.env.CUA_PORT_BASE || 39000)
const ports = new Map()

function writePorts() {
  const out = {}
  for (const [name, entry] of ports) {
    out[name] = { guestPort: entry.guestPort, localPort: entry.localPort, url: `/vm/port/${name}/` }
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

async function openPort(name, guestPort) {
  closePort(name)
  let localPort = PORT_BASE
  while (localPort < PORT_BASE + 500 && !(await portIsFree(localPort))) localPort += 1
  if (localPort >= PORT_BASE + 500) throw new Error('no free local port for the preview')
  const child = spawn(CUA_BIN, ['sb', 'port-forward', '--local', name, `${guestPort}:${localPort}`], { env: CUA_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('exit', () => {
    if (ports.get(name)?.child === child) { ports.delete(name); writePorts() }
  })
  ports.set(name, { child, guestPort, localPort })
  writePorts()
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await portIsFree(localPort))) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { name, guestPort, localPort, url: `/vm/port/${name}/`, stderr: stderr.trim().slice(-400) }
}

function closePort(name) {
  const entry = ports.get(name)
  if (!entry) return
  try { entry.child.kill('SIGTERM') } catch {}
  ports.delete(name)
  writePorts()
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

function readRegistry() {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY, 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.vms ? parsed : { vms: {} }
  } catch {
    return { vms: {} }
  }
}

function writeRegistry(registry) {
  const tmp = `${REGISTRY}.tmp`
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`)
  renameSync(tmp, REGISTRY)
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

/** Run the cua CLI and capture its streams. Never throws on a non-zero exit. */
function runCua(args, { timeoutMs = 180000, signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(CUA_BIN, args, {
      env: CUA_ENV,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timer
    const done = (code, timedOut = false) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => done(-1).error ? null : resolve({ code: -1, stdout, stderr: String(error) }))
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

function fail(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
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
  if (!existsSync(wrapper)) {
    const setup = await runCua(['runtime', 'setup', 'qemu'], { timeoutMs: 900000 })
    if (setup.code !== 0) throw new Error(`cua runtime setup qemu failed: ${(setup.stderr || setup.stdout).trim().slice(-800)}`)
  }
  repairQemuData()
  return existsSync(wrapper)
}

const CREATE_LOCK = new Map()

function withLock(key, fn) {
  const previous = CREATE_LOCK.get(key) || Promise.resolve()
  const next = previous.then(fn, fn)
  CREATE_LOCK.set(key, next.catch(() => {}))
  return next
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
function createArgs(name, tier, cpu, memory, waitDesktop, image = 'linux') {
  return [
    'sb', 'create', image,
    '--on', 'local', '--kind', 'vm',
    '--name', name,
    '--tier', String(tier),
    '--cpu', String(cpu),
    '--memory', `${memory}GB`,
    '--json',
    '--wait', waitDesktop ? 'desktop' : 'tcp:3211'
  ]
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

  async ensure({ workspace = WORKSPACE_ROOT, tier = 'slim', cpu = 2, memory = 4, waitDesktop = false }) {
    const real = realpathSync(workspace)
    const name = vmName(real)
    return withLock(name, async () => {
      const registry = readRegistry()
      const known = registry.vms[name]
      const { parsed } = await listSandboxes()
      const listed = findListed(parsed, name)
      const exists = Boolean(known || listed)

      if (exists) {
        const state = String((listed && (listed.status || listed.phase)) || (known && known.state) || 'unknown')
        if (!/ready|running|started/i.test(state)) {
          const resumed = await runCua(['sb', 'resume', '--local', name], { timeoutMs: 180000 })
          if (resumed.code !== 0) {
            const restarted = await runCua(['sb', 'restart', '--local', name], { timeoutMs: 180000 })
            if (restarted.code !== 0) {
              // A QEMU VM whose process died (the harness container was replaced,
              // or the host restarted) cannot be started again — cua says so
              // explicitly. Rebuild it from the base image so the workspace keeps
              // a computer, and say that the previous disk did not survive.
              log(`recovering ${name}: ${(restarted.stderr || restarted.stdout).trim().slice(-200)}`)
              await runCua(['sb', 'rm', '--local', name, '--force'], { timeoutMs: 180000 })
              await ensureRuntime()
              const recreated = await runCua(createArgs(name, known?.tier || tier, known?.cpu || cpu, known?.memory || memory, waitDesktop), { timeoutMs: 1500000 })
              if (recreated.code !== 0) {
                return fail(`the VM could not be resumed or recreated: ${(recreated.stderr || recreated.stdout).trim().slice(-1200)}`)
              }
              registry.vms[name] = {
                workspace: real,
                tier: String(known?.tier || tier),
                cpu: known?.cpu || cpu,
                memory: known?.memory || memory,
                createdAt: new Date().toISOString(),
                lastUsed: new Date().toISOString(),
                state: 'ready'
              }
              writeRegistry(registry)
              return ok({ name, state: 'ready', created: true, recovered: true, tier: registry.vms[name].tier })
            }
          }
        }
        registry.vms[name] = { ...(known || {}), workspace: real, tier: known?.tier || tier, state: 'ready', lastUsed: new Date().toISOString() }
        writeRegistry(registry)
        return ok({ name, state: 'ready', created: false, tier: registry.vms[name].tier })
      }

      await ensureRuntime()
      const config = readConfig()
      const running = Object.entries(registry.vms).filter(([vm, meta]) => vm !== name && meta.state === 'ready').length
      if (running >= config.maxRunning) {
        return fail(`VM limit reached (${running}/${config.maxRunning} running). Suspend or destroy one, or raise the limit under Plugins → Personal VM (CUA).`)
      }
      const used = await storeUsedBytes()
      if (used > config.diskQuotaGb * 1024 ** 3) {
        return fail(`VM store quota reached (${(used / 1024 ** 3).toFixed(1)} GB of ${config.diskQuotaGb} GB). Destroy a VM or raise the quota under Plugins → Personal VM (CUA).`)
      }

      const created = await runCua(createArgs(name, tier, cpu, memory, waitDesktop), { timeoutMs: 1500000 })
      if (created.code !== 0) {
        return fail(`cua sb create failed (${created.code}): ${(created.stderr || created.stdout).trim().slice(-2000)}`)
      }

      registry.vms[name] = {
        workspace: real,
        tier: String(tier),
        cpu,
        memory,
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        state: 'ready'
      }
      writeRegistry(registry)
      let info = null
      try { info = JSON.parse(created.stdout) } catch { info = created.stdout.trim() || null }
      return ok({ name, state: 'ready', created: true, tier: String(tier), info })
    })
  },

  async exec({ name, cmd, cwd, timeout = 300 }) {
    if (!name) throw new Error('name is required')
    if (typeof cmd !== 'string' || cmd.trim().length === 0) throw new Error('cmd is required')
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
    const registry = readRegistry()
    if (registry.vms[name]) {
      registry.vms[name].lastUsed = new Date().toISOString()
      registry.vms[name].lastCommand = cmd.slice(0, 500)
      writeRegistry(registry)
    }
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
    if (typeof guest !== 'string' || !guest.startsWith('/')) throw new Error('guest must be an absolute guest path')
    const source = workspacePath(local, { mustExist: true })
    const result = await runCua(['sb', 'cp', '--local', source, `${name}:${guest}`], { timeoutMs: 600000 })
    if (result.code !== 0) return fail(`vm_put failed: ${(result.stderr || result.stdout).trim().slice(-1000)}`)
    return ok({ local: source, guest })
  },

  async get({ name, guest, local }) {
    if (!name) throw new Error('name is required')
    if (typeof guest !== 'string' || !guest.startsWith('/')) throw new Error('guest must be an absolute guest path')
    const target = workspacePath(local, { forWrite: true })
    mkdirSync(path.dirname(target), { recursive: true })
    const result = await runCua(['sb', 'cp', '--local', `${name}:${guest}`, target], { timeoutMs: 600000 })
    if (result.code !== 0) return fail(`vm_get failed: ${(result.stderr || result.stdout).trim().slice(-1000)}`)
    return ok({ guest, local: target, bytes: statSync(target).size })
  },

  /**
   * Open a real forward for one guest port and publish it as /vm/port/<name>/.
   * The forward lives until portClose, suspend or destroy — the proxy reads
   * ports.json, so a page survives a harness restart as long as the VM does.
   */
  async port({ name, guestPort = 8080 }) {
    if (!name) throw new Error('name is required')
    const opened = await openPort(name, Number(guestPort) || 8080)
    return ok(opened)
  },

  async portClose({ name }) {
    closePort(name)
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
      if (row?.name && registry.vms[row.name]) {
        registry.vms[row.name].state = row.state || row.status || registry.vms[row.name].state
      }
    }
    return ok({ registry: registry.vms, listed: parsed ?? raw })
  },

  /**
   * Create a NAMED computer with an explicit spec, the way the Computers page
   * asks for one. `image` is a cua alias or an OCI reference; unknown aliases
   * fail at create with cua's own message, which is better than a silent
   * substitution. Debian/Arch are not Cua disk images: they need
   * `cua images build` and a pinned reference, so the UI offers aliases only.
   */
  async vmCreate({ name, cpu = 2, memory = 4, image = 'linux', tier = 'slim', workspace = WORKSPACE_ROOT, waitDesktop = false }) {
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(String(name || ''))) {
      throw new Error('name must be 2-31 chars: lowercase letters, digits and dashes')
    }
    return withLock(name, async () => {
      const registry = readRegistry()
      if (registry.vms[name]) throw new Error(`a computer named "${name}" already exists`)
      const config = readConfig()
      const running = Object.entries(registry.vms).filter(([, meta]) => meta.state === 'ready').length
      if (running >= config.maxRunning) {
        return fail(`VM limit reached (${running}/${config.maxRunning} running). Start/suspend one, or raise the limit above.`)
      }
      const used = await storeUsedBytes()
      if (used > config.diskQuotaGb * 1024 ** 3) {
        return fail(`VM store quota reached (${(used / 1024 ** 3).toFixed(1)} GB of ${config.diskQuotaGb} GB). Delete a computer or raise the quota above.`)
      }
      await ensureRuntime()
      const created = await runCua(createArgs(name, tier, Number(cpu) || 2, Number(memory) || 4, waitDesktop, String(image || 'linux')), { timeoutMs: 1500000 })
      if (created.code !== 0) return fail((created.stderr || created.stdout).trim().slice(-1500))
      registry.vms[name] = {
        workspace,
        image: String(image),
        tier: String(tier),
        cpu: Number(cpu) || 2,
        memory: Number(memory) || 4,
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        state: 'ready'
      }
      writeRegistry(registry)
      return ok({ name, state: 'ready', created: true })
    })
  },

  async vmStart({ name }) {
    const registry = readRegistry()
    const meta = registry.vms[name]
    if (!meta) throw new Error(`no computer named "${name}"`)
    let result = await runCua(['sb', 'resume', '--local', name], { timeoutMs: 180000 })
    if (result.code !== 0) result = await runCua(['sb', 'restart', '--local', name], { timeoutMs: 180000 })
    if (result.code !== 0) {
      // Same reality as ensure: a QEMU VM whose process is gone cannot start.
      // Rebuild it from its recorded spec so the Start button is never a dead end.
      log(`start: recreating ${name} after "${(result.stderr || result.stdout).trim().slice(-160)}"`)
      await runCua(['sb', 'rm', '--local', name, '--force'], { timeoutMs: 180000 })
      await ensureRuntime()
      result = await runCua(createArgs(name, meta.tier, meta.cpu, meta.memory, false, meta.image), { timeoutMs: 1500000 })
      if (result.code !== 0) return fail((result.stderr || result.stdout).trim().slice(-800))
    }
    meta.state = 'ready'
    meta.lastUsed = new Date().toISOString()
    writeRegistry(registry)
    return ok({ name, state: 'ready' })
  },

  async vmDelete({ name }) {
    closePort(name)
    const result = await runCua(['sb', 'rm', '--local', name, '--force'], { timeoutMs: 180000 })
    const registry = readRegistry()
    delete registry.vms[name]
    writeRegistry(registry)
    if (result.code !== 0) return fail((result.stderr || result.stdout).trim().slice(-800))
    return ok({ name, deleted: true })
  },

  /**
   * One PNG still, base64. The viewer's video path needs a secure context,
   * which a LAN http page is not, so the panel offers frames as a fallback:
   * plain images work anywhere.
   */
  async screenshot({ name }) {
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
    const display = 'DISPLAY=${DISPLAY:-:1}'
    let command
    if (kind === 'click') {
      const px = Math.max(0, Math.round(Number(x) || 0))
      const py = Math.max(0, Math.round(Number(y) || 0))
      command = `${display} xdotool mousemove ${px} ${py} click 1`
    } else if (kind === 'type') {
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
   * GUI control. Pointer actions are animated: a single `mousemove` teleports
   * the cursor, which reads as a machine; a short eased path with sub-pixel
   * jitter reads as a hand, and it is what makes the streamed desktop look like
   * the upstream demo. Everything else goes through `cua do`.
   */
  async gui({ name, action, x, y, x2, y2, text, key, direction, amount, app, path: target, save, smooth = true, steps = 24, durationMs = 380 }) {
    const num = (value) => {
      const parsed = Math.round(Number(value))
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error('coordinates must be positive numbers')
      return parsed
    }
    const pointer = ['click', 'dclick', 'move', 'drag'].includes(action)
    await runCua(['sb', 'resume', '--local', name], { timeoutMs: 120000 })

    if (pointer) {
      const read = await runCua(['sb', 'exec', '--local', name, '--timeout', '20', 'DISPLAY=${DISPLAY:-:1} xdotool getmouselocation --shell'], { timeoutMs: 60000 })
      const matchX = /X=(-?\d+)/u.exec(read.stdout)
      const matchY = /Y=(-?\d+)/u.exec(read.stdout)
      const fromX = matchX === null ? 0 : Number(matchX[1])
      const fromY = matchY === null ? 0 : Number(matchY[1])
      const toX = num(x)
      const toY = num(y)
      const total = Math.max(2, Math.min(120, Math.round(Number(steps) || 24)))
      const perStep = Math.max(0.004, Math.min(0.05, (Number(durationMs) || 380) / 1000 / total))
      const parts = []
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2)
      if (action === 'drag') parts.push('mousedown 1')
      for (let index = 1; index <= total; index += 1) {
        const t = ease(index / total)
        const jitter = smooth && index < total ? (Math.random() * 2 - 1) : 0
        const px = Math.round(fromX + (toX - fromX) * t + jitter)
        const py = Math.round(fromY + (toY - fromY) * t + jitter)
        parts.push(`mousemove ${Math.max(0, px)} ${Math.max(0, py)}`, `sleep ${perStep.toFixed(3)}`)
      }
      if (action === 'click') parts.push('click 1')
      if (action === 'dclick') parts.push('click --repeat 2 --delay 80 1')
      if (action === 'drag') parts.push('mouseup 1')
      const script = `DISPLAY=\${DISPLAY:-:1} xdotool ${parts.join(' ')}`
      const moved = await runCua(['sb', 'exec', '--local', name, '--timeout', '60', script], { timeoutMs: 120000 })
      if (moved.code !== 0) return fail((moved.stderr || moved.stdout).trim().slice(-400))
      return ok({ name, action, output: `${action} at ${toX},${toY} (${total} steps over ${Math.round(perStep * total * 1000)} ms)` })
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
        case 'screenshot': {
          mkdirSync('/cua-vm/shots', { recursive: true })
          return ['screenshot', '-s', String(save || `/cua-vm/shots/${name}-${Date.now()}.png`), '--json']
        }
        case 'windows': return ['window', 'list']
        case 'a11y': return ['a11y', 'tree', '--json']
        case 'clipboard': return ['clipboard']
        case 'launch': return ['launch', String(app ?? '')]
        case 'open': return ['open', String(target ?? '')]
        default: throw new Error(`unknown gui action: ${action}`)
      }
    })()

    const switched = await runCua(['do', 'switch', `local:${name}`], { timeoutMs: 60000 })
    if (switched.code !== 0) return fail((switched.stderr || switched.stdout).trim().slice(-400))
    let acted = await runCua(['do', ...argv], { timeoutMs: 120000 })
    let output = `${acted.stdout}${acted.stderr}`.trim()
    // A freshly resumed VM takes a moment to answer on spacesd; retry once
    // instead of reporting a failure the caller cannot act on.
    if (acted.code !== 0 && /spacesd is not available|not answering/i.test(output)) {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      acted = await runCua(['do', ...argv], { timeoutMs: 120000 })
      output = `${acted.stdout}${acted.stderr}`.trim()
    }
    if (acted.code !== 0) return fail(output.slice(-600))
    return ok({ name, action, output })
  },

  /**
   * Where the guest's pointer is. X11 draws the cursor as an overlay the
   * capture path does not composite, so screenshots and the stream show no
   * cursor even though the agent is moving it — the panel draws one instead.
   */
  async pointer({ name }) {
    const read = await runCua(['sb', 'exec', '--local', name, '--timeout', '15',
      'DISPLAY=${DISPLAY:-:1} xdotool getmouselocation --shell; DISPLAY=${DISPLAY:-:1} xdotool getdisplaygeometry'], { timeoutMs: 60000 })
    if (read.code !== 0) return fail((read.stderr || read.stdout).trim().slice(-300))
    const x = Number((/X=(-?\d+)/u.exec(read.stdout) || [])[1] ?? 0)
    const y = Number((/Y=(-?\d+)/u.exec(read.stdout) || [])[1] ?? 0)
    const geometry = /^(\d+)\s+(\d+)$/mu.exec(read.stdout)
    return ok({
      name, x, y,
      width: geometry === null ? 0 : Number(geometry[1]),
      height: geometry === null ? 0 : Number(geometry[2])
    })
  },

  async stop({ name }) {
    return handlers.suspend({ name })
  },

  /** Mint the shared viewer link and publish it at /vm/view/<name>/. */
  async view({ name }) {
    if (!name) throw new Error('name is required')
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
    const result = await runCua(['sb', 'suspend', '--local', name], { timeoutMs: 180000 })
    closePort(name)
    const registry = readRegistry()
    if (registry.vms[name]) { registry.vms[name].state = 'suspended'; writeRegistry(registry) }
    if (result.code !== 0) return fail((result.stderr || result.stdout).trim().slice(-800))
    return ok({ name, state: 'suspended' })
  },

  async resume({ name }) {
    const result = await runCua(['sb', 'resume', '--local', name], { timeoutMs: 180000 })
    const registry = readRegistry()
    if (registry.vms[name]) { registry.vms[name].state = 'ready'; writeRegistry(registry) }
    if (result.code !== 0) return fail((result.stderr || result.stdout).trim().slice(-800))
    return ok({ name, state: 'ready' })
  },

  async destroy({ name }) {
    const result = await runCua(['sb', 'rm', '--local', name, '--force'], { timeoutMs: 180000 })
    closePort(name)
    const registry = readRegistry()
    delete registry.vms[name]
    writeRegistry(registry)
    if (result.code !== 0) return fail((result.stderr || result.stdout).trim().slice(-800))
    return ok({ name, destroyed: true })
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
  const registry = readRegistry()
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

server.listen(SOCK, () => {
  try { chmodSync(SOCK, 0o600) } catch {}
  log(`listening on ${SOCK} (store ${STORE}, workspace ${WORKSPACE_ROOT})`)
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
