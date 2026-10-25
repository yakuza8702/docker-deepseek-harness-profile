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
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync
} from 'node:fs'
import path from 'node:path'

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
    log(`provision: ${name} incomplete (${output.slice(-400)})`)
    return { ok: false, renderer, output }
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
const PROVISION_SCRIPT = String(process.env.DSH_CUA_PROVISION_SCRIPT || '/usr/local/bin/cua-guest-provision.sh')
const ANDROID_SCRIPT = String(process.env.DSH_CUA_ANDROID_SCRIPT || '/usr/local/bin/cua-guest-android.sh')

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
function qmpCommands(port, commands, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1')
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
  const disk = path.join(CUA_HOME, '.cua', 'vmm', 'qemu', name, 'disk.qcow2')
  if (!existsSync(disk)) return null
  const target = path.join(CHECKPOINT_DIR, `${name}.qcow2`)
  try {
    mkdirSync(CHECKPOINT_DIR, { recursive: true })
    // FLATTEN. A plain copy keeps the backing chain, and a disk that was itself
    // created from the previous restore file turns that chain into a cycle
    // ("Could not open backing file … Too many open files"). `convert` follows
    // the chain once and writes a self-contained disk, which is what a restore
    // needs.
    execFileSync(path.join(CUA_HOME, '.cua', 'bin', 'qemu-img'), ['convert', '-O', 'qcow2', disk, `${target}.tmp`], { timeout: 180000 })
    renameSync(`${target}.tmp`, target)
    log(`checkpoint ${name}: ${(statSync(target).size / 1024 ** 2).toFixed(1)} MB (flattened)`)
    return target
  } catch (error) {
    log(`checkpoint ${name} failed: ${error && error.message}`)
    try { unlinkSync(`${target}.tmp`) } catch {}
    return null
  }
}

/** VMs whose screenshot space cua already knows (see the gui pointer branch). */
const SHOT_STATE = new Set()
/** Which computer `cua do` is pointed at — switching resets the zoom state. */
let DO_TARGET = ''

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
              const snapshot = checkpointSandbox(name)
              await runCua(['sb', 'rm', '--local', name, '--force'], { timeoutMs: 180000 })
              await ensureRuntime()
              const bootImage = snapshot !== null ? `${snapshot}.restore.qcow2` : 'linux'
              if (snapshot !== null) copyFileSync(snapshot, bootImage)
              installQemuShim()
              let recreated = await runCua(createArgs(name, known?.tier || tier, known?.cpu || cpu, known?.memory || memory, waitDesktop, bootImage, known?.gpu === true), { timeoutMs: 1500000 })
              if (recreated.code !== 0 && snapshot !== null) {
                log(`restore from checkpoint failed for ${name}; falling back to the base image`)
                recreated = await runCua(createArgs(name, known?.tier || tier, known?.cpu || cpu, known?.memory || memory, waitDesktop, 'linux', known?.gpu === true), { timeoutMs: 1500000 })
              }
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
  async vmCreate({ name, cpu = 2, memory = 4, image = 'linux', tier = 'slim', workspace = WORKSPACE_ROOT, waitDesktop = false, gpu = false, diskGb = 0, android = false }) {
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
      installQemuShim()
      const created = await runCua(createArgs(name, tier, Number(cpu) || 2, Number(memory) || 4, waitDesktop, String(image || 'linux'), gpu === true), { timeoutMs: 1500000 })
      if (created.code !== 0) return fail((created.stderr || created.stdout).trim().slice(-1500))
      registry.vms[name] = {
        workspace,
        image: String(image),
        tier: String(tier),
        gpu: gpu === true,
        cpu: Number(cpu) || 2,
        memory: Number(memory) || 4,
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        state: 'ready'
      }
      writeRegistry(registry)
      // Provision first (it needs the desktop, not the other way round), then
      // grow the disk: Android's SDK + AVD do not fit in the stock 20 GB.
      const provisioned = await provisionGuest(name, { gpu: gpu === true })
      let disk = null
      if (Number(diskGb) > 0) disk = await growGuestDisk(name, Number(diskGb))
      let androidResult = null
      if (android === true) androidResult = await provisionAndroidGuest(name, {})
      return ok({
        name,
        state: 'ready',
        created: true,
        renderer: provisioned.renderer,
        provisioned: provisioned.ok,
        disk,
        android: androidResult ? androidResult.ok : undefined,
        output: `${(provisioned.output || '').slice(-1200)}${androidResult ? `\n${(androidResult.output || '').slice(-1200)}` : ''}`
      })
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
      const snapshot = checkpointSandbox(name)
      await runCua(['sb', 'rm', '--local', name, '--force'], { timeoutMs: 180000 })
      await ensureRuntime()
      const bootImage = snapshot !== null ? `${snapshot}.restore.qcow2` : meta.image
      if (snapshot !== null) copyFileSync(snapshot, bootImage)
      installQemuShim()
      result = await runCua(createArgs(name, meta.tier, meta.cpu, meta.memory, false, bootImage, meta.gpu === true), { timeoutMs: 1500000 })
      if (result.code !== 0 && snapshot !== null) {
        log(`restore from checkpoint failed for ${name}; falling back to ${meta.image}`)
        result = await runCua(createArgs(name, meta.tier, meta.cpu, meta.memory, false, meta.image, meta.gpu === true), { timeoutMs: 1500000 })
      }
      if (result.code !== 0) return fail((result.stderr || result.stdout).trim().slice(-800))
    }
    meta.state = 'ready'
    meta.lastUsed = new Date().toISOString()
    writeRegistry(registry)
    // Version-checked: an up-to-date disk answers in one exec, an outdated one
    // is re-provisioned here (the first start after an image update takes a
    // minute longer and the result says so).
    const provisioned = await provisionGuest(name, { gpu: meta.gpu === true })
    return ok({ name, state: 'ready', provisioned: provisioned.ok, renderer: provisioned.renderer, output: provisioned.ok ? undefined : provisioned.output.slice(-1200) })
  },

  /** Force a re-provision of an existing computer (after an image update). */
  async provision({ name }) {
    const registry = readRegistry()
    const meta = registry.vms[name]
    if (!meta) return fail(`no computer named "${name}"`)
    const result = await provisionGuest(name, { gpu: meta.gpu === true })
    return result.ok
      ? ok({ name, renderer: result.renderer, output: result.output.slice(-1500) })
      : fail(`provisioning failed:\n${result.output.slice(-1200)}`)
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
  async gui({ name, action, x, y, x2, y2, text, key, direction, amount, app, window: windowName, path: target, save, region = null, scale = 1, relative = false, smooth = true, steps = 3, durationMs = 200 }) {
    const num = (value) => {
      const parsed = Math.round(Number(value))
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error('coordinates must be positive numbers')
      return parsed
    }
    const pointer = ['click', 'dclick', 'move', 'drag'].includes(action)
    await runCua(['sb', 'resume', '--local', name], { timeoutMs: 120000 })

    // `do switch` also clears `zoom`, so it must not run on every call: the
    // model zooms to a window, takes two screenshots and clicks. Only switch
    // when the daemon is pointed at another computer (it keeps the target
    // across processes).
    if (DO_TARGET !== name) {
      const switched = await runCua(['do', 'switch', `local:${name}`], { timeoutMs: 60000 })
      if (switched.code !== 0) return fail((switched.stderr || switched.stdout).trim().slice(-400))
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
      // cua maps screenshot pixels to the display only once it knows the
      // capture size: its first click in a fresh daemon session is 1:1 screen
      // coordinates, every later one is scaled by image/display. Priming one
      // screenshot per VM makes the mapping deterministic, so the model never
      // gets a 6%-off click because it skipped looking first.
      if (!SHOT_STATE.has(name)) {
        await doAct(['screenshot', '-s', `/tmp/cua-prime-${process.pid}.png`, '--json'])
        SHOT_STATE.add(name)
      }
      // Fractional coordinates (0..1) still work for a caller that only ever
      // saw a resized preview. A fraction is invariant across the
      // image→screen mapping, so resolve it against the *capture* size —
      // cua caps captures at ~900k pixels, hence the scale below.
      let toX = num(x)
      let toY = num(y)
      if (relative === true) {
        const size = await guestExec(name, 'DISPLAY=${DISPLAY:-:1} xdotool getdisplaygeometry')
        const matched = /^(\d+)\s+(\d+)$/mu.exec(size.stdout)
        if (matched) {
          const width = Number(matched[1])
          const height = Number(matched[2])
          const factor = Math.min(1, Math.sqrt(900000 / (width * height)))
          toX = Math.round(Number(x) * width * factor)
          toY = Math.round(Number(y) * height * factor)
        }
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
        const steps_ = smooth === false ? 1 : Math.max(1, Math.min(8, Math.round(Number(steps) || 3)))
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
      if (result.code !== 0) return fail(result.output.slice(-600))
      const at = await pointerNow()
      const context = await guiContext(name)
      return ok({ name, action, output: `${action} at screenshot pixel ${toX},${toY} (cua maps it to the display)${at ? `\npointer now at screen ${at}` : ''}\n${context}` })
    }

    if (action === 'screenshot') {
      mkdirSync('/cua-vm/shots', { recursive: true })
      const stamp = Date.now()
      const hostFile = `/cua-vm/shots/${name}-${stamp}.png`
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
        const hostCrop = `/cua-vm/shots/${name}-${stamp}-crop.png`
        try {
          execFileSync('/usr/bin/convert', [hostFile, '-crop', `${rw}x${rh}+${rx}+${ry}`, '+repage', '-resize', `${Math.round(zoom * 100)}%`, hostCrop], { timeout: 30000 })
          source = hostCrop
          mapping = `crop ${rw}x${rh} at screenshot (${rx},${ry}) magnified ${zoom}x → this image is only for reading: to click, divide by ${zoom} and add the origin, i.e. click at (${rx} + px/${zoom}, ${ry} + py/${zoom}).\n`
        } catch (error) {
          mapping = `crop failed (${error && error.message}); the full frame below is unchanged.\n`
        }
      }

      const copied = await runCua(['sb', 'cp', source, `${name}:${guestFile}`], { timeoutMs: 120000 })
      const dimensions = (() => {
        try {
          return execFileSync('/usr/bin/identify', ['-format', '%w %h', source], { timeout: 20000 }).toString().trim()
        } catch { return 'unknown' }
      })()
      const space = `screenshot ${dimensions} — these are the pixels every pointer action takes (cua maps them). The desktop is ${DESKTOP_RESOLUTION}; when the two match, image pixels are display pixels.`
      if (copied.code !== 0) {
        return ok({ name, action, output: `${mapping}${space}\nscreenshot on the host: ${source} (copy into the guest failed; use this host path only from the panel)` })
      }
      return ok({ name, action, output: `${mapping}${space}\nscreenshot saved in the guest: ${guestFile}
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
      return ok({
        name,
        action,
        output: `display: ${geometry ? `${geometry[1]}x${geometry[2]}` : 'unknown'} (screenshot pixels are the click space; they match when the desktop is ${DESKTOP_RESOLUTION})\npointer: ${at || `${px ?? '?'},${py ?? '?'}`} (screen points)\nwindows:\n${bounds.length > 0 ? bounds.map((w) => `- "${w.title}" at [${w.rect}]${w.app && w.app !== w.title ? ` (app: ${w.app})` : ''}`).join('\n') : (windows.map((w) => `- ${w}`).join('\n') || '- none')}\nuse \`zoom\` with one of these titles to crop the desktop to that window (coordinates stay correct).`
      })
    }

    if (action === 'zoom' || action === 'unzoom') {
      const target_ = action === 'zoom' ? String(windowName ?? app ?? '').trim() : ''
      if (action === 'zoom' && target_ === '') return fail('zoom needs a window title (see the windows list from geometry)')
      const result = action === 'zoom'
        ? await doAct(['zoom', target_])
        : await doAct(['unzoom'])
      if (result.code !== 0) return fail(result.output.slice(-500))
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
    }
    return ok({ name, action, output })
  },

  /** Grow the disk of a running computer; the filesystem grows online. */
  async vmDisk({ name, sizeGb }) {
    const registry = readRegistry()
    if (!registry.vms[name]) return fail(`no computer named "${name}"`)
    try {
      const result = await growGuestDisk(name, Number(sizeGb))
      if (result.changed) log(`disk: ${name} grew to ${result.sizeGb} GB`)
      return ok({ name, ...result })
    } catch (error) {
      return fail(`${error && error.message}`)
    }
  },

  /** Install the Android SDK + an AVD inside the guest (several GB, one-off). */
  async vmAndroid({ name, api = 35, variant = 'google_apis', arch = 'x86_64', avd = 'cua' }) {
    const registry = readRegistry()
    if (!registry.vms[name]) return fail(`no computer named "${name}"`)
    const result = await provisionAndroidGuest(name, { api: Number(api) || 35, variant, arch, avd })
    return result.ok
      ? ok({ name, installed: true, output: result.output.slice(-1500) })
      : fail(`android provisioning failed:\n${result.output.slice(-1200)}`)
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
