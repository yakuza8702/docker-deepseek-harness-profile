/**
 * cua-vm-windows — a Windows computer, as a Docker container on a DinD engine.
 *
 * WHY A CONTAINER AND NOT A CUA SANDBOX
 * -------------------------------------
 * `cua sb create` builds Linux disks (its images are Ubuntu Cua disks), and the
 * guest agent, the 9p share, the `.cua` layout and the whole exec/put/get path
 * are Linux-specific. A Windows guest therefore cannot be a cua sandbox — but it
 * does not need to be: `dockurr/windows` boots Windows inside QEMU, does the
 * unattended install itself, and puts a web console (noVNC) on 8006. The
 * container is the computer; the Docker Engine API is its control plane.
 *
 * WHAT THIS MODULE OWNS
 * ---------------------
 *   * the container SPEC: every `dockurr/windows` environment variable, in one
 *     place, with the floors that make a Windows install succeed at all
 *     (64 GB disk, 6 GB RAM, 2 vCPU) and their `diskGbRaised` / `memoryRaised`
 *     reporting;
 *   * CREATE + BOOT: create, start, and the readiness predicate (RDP accepting
 *     AND QMP `query-status` = running), reported as `installing` until it holds
 *     or `error` with the last 40 log lines when the install times out;
 *   * INPUT + FRAMES over QMP, never over a viewer: `screendump` for a PNG and
 *     `input-send-event` for the pointer and the keyboard, which is why the
 *     guest is started with `-device usb-tablet` (absolute pointing) and
 *     `-qmp tcp:0.0.0.0:7100` (the control channel);
 *   * TEARDOWN, so `cua_vm_destroy` and `cua_vm_gc` have one implementation.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * No exec, no put/get, no disk growth, no accessibility tree, no window list and
 * no clipboard. Those are guest-agent services, and this guest has no guest
 * agent: pretending otherwise (`docker exec` into the Windows VM is not a thing)
 * is how a tool ends up hanging for two minutes and then reporting a timeout the
 * model reads as "the VM is broken". Each of those tools answers with a
 * structured "not available for Windows" and the two paths that DO work: the
 * console at /vm/port/<name>/ and RDP on 3389 when the operator opted in.
 *
 * TRANSPORT
 * ---------
 * Docker Engine API over `DOCKER_HOST` (tcp://dind:2375 in the compose overlay,
 * unix:///var/run/docker.sock for a local engine). Plain `node:http`, no SDK: the
 * whole surface used here is six endpoints.
 *
 * 7100 IS NEVER PUBLISHED. QMP is reached on the container's own network
 * address, which is why the container joins the network the harness is on
 * (DSH_CUA_WINDOWS_NETWORK) — an unpublished port is a control channel, and a
 * published one would be an unauthenticated QMP socket on the LAN.
 */

import http from 'node:http'
import net from 'node:net'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { pngSize } from './cua-vm-space.mjs'

/** Everything `dockurr/windows` accepts as a VERSION. */
export const WINDOWS_VERSIONS = ['11', '10', 'ltsc10', '2022', '2025']
/**
 * PINNED, deliberately. `latest` of an installer image is a different Windows
 * build with a different unattended answer file; a floating tag turns "the
 * console went blank" into an unreproducible report. Override only on purpose.
 */
export const WINDOWS_IMAGE = process.env.DSH_CUA_WINDOWS_IMAGE || 'dockurr/windows:4.35'
export const WINDOWS_IMAGE_PINNED = true

/** Floors that a Windows install does not survive below. */
export const WINDOWS_MIN_MEMORY_GB = 6
export const WINDOWS_MIN_DISK_GB = 64
export const WINDOWS_MIN_CPU = 2
export const WINDOWS_DEFAULT_CPU = 2
export const WINDOWS_DEFAULT_MEMORY_GB = 6
export const WINDOWS_DEFAULT_DISK_GB = 64
/** The QEMU monitor, INSIDE the container only. Never published. */
export const WINDOWS_QMP_PORT = 7100
/** dockurr's web console (noVNC). Relayed by the supervisor as /vm/port/<name>/. */
export const WINDOWS_CONSOLE_PORT = 8006
export const WINDOWS_RDP_PORT = 3389
export const WINDOWS_USERNAME = 'cua'
export const WINDOWS_STORAGE_DIR = 'windows'

/** The kill switch: DSH_CUA_VM_WINDOWS=0 removes the option entirely. */
export function windowsEnabled() {
  return String(process.env.DSH_CUA_VM_WINDOWS ?? '1') !== '0'
}

/* ------------------------------------------------------------------ *
 * Docker Engine API — six endpoints, zero dependencies.
 * ------------------------------------------------------------------ */

/**
 * Where the engine is. `tcp://dind:2375` is the compose overlay; a local engine
 * is `unix:///var/run/docker.sock`, which http.request reaches with
 * `socketPath`.
 */
function engineTarget() {
  const raw = String(process.env.DOCKER_HOST || '').trim()
  if (raw.startsWith('tcp://')) {
    const url = new URL(raw)
    return {
      kind: 'tcp',
      host: url.hostname,
      port: Number(url.port || 2375),
      reachable: true
    }
  }
  if (raw.startsWith('unix://')) {
    return { kind: 'unix', socketPath: raw.slice('unix://'.length), reachable: true }
  }
  // An unset DOCKER_HOST means the local socket, not "no engine".
  return { kind: 'unix', socketPath: '/var/run/docker.sock', reachable: true }
}

/** The hostname the harness uses to reach ports DINd publishes (0.0.0.0). */
function publishedHost() {
  const target = engineTarget()
  if (target.kind === 'tcp') return process.env.DSH_CUA_WINDOWS_PUBLISH_HOST || target.host
  return '127.0.0.1'
}

function dockerRequest(pathname, { method = 'GET', body = null, timeoutMs = 30000, binary = false } = {}) {
  const target = engineTarget()
  const payload = body === null ? null : Buffer.from(JSON.stringify(body))
  const headers = payload === null
    ? { host: 'docker' }
    : { host: 'docker', 'content-type': 'application/json', 'content-length': payload.length }
  return new Promise((resolve, reject) => {
    const request = http.request({
      ...(target.kind === 'unix' ? { socketPath: target.socketPath } : { host: target.host, port: target.port }),
      path: pathname,
      method,
      headers,
      timeout: timeoutMs
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const buffer = Buffer.concat(chunks)
        let parsed = null
        if (!binary) {
          try { parsed = JSON.parse(buffer.toString('utf8')) } catch { parsed = null }
        }
        resolve({ status: response.statusCode ?? 0, buffer, json: parsed })
      })
    })
    request.on('timeout', () => request.destroy(new Error(`docker engine did not answer ${method} ${pathname} within ${timeoutMs} ms`)))
    request.on('error', reject)
    if (payload !== null) request.write(payload)
    request.end()
  })
}

/** A tar entry, for the archive fallback below. 512-byte blocks, octal sizes. */
export function untarSingle(buffer, wanted) {
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.toString('ascii', 0, 100).replace(/\0+$/u, '')
    const sizeField = header.toString('ascii', 124, 136).replace(/\0+.*$/u, '').trim()
    const size = parseInt(sizeField, 8) || 0
    const body = buffer.subarray(offset + 512, offset + 512 + size)
    if (path.basename(name) === path.basename(wanted) && size > 0) return Buffer.from(body)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return null
}

/** PEM-style password: url-safe, no shell metacharacters, 20 chars, ~118 bits. */
export function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_'
  const bytes = randomBytes(20)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out
}

/* ------------------------------------------------------------------ *
 * QMP keyboard — ASCII only, US layout, physical qcodes.
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

/**
 * One character of printable ASCII as a (qcode, shift) pair, or null.
 *
 * ASCII ONLY is a deliberate limit: `input-send-event` sends physical key
 * positions, so a CJK or accented character has no single key to press. The
 * caller is told so instead of getting a silently wrong string.
 */
export function charToKey(char) {
  if (Object.prototype.hasOwnProperty.call(QCODE_SHIFT, char)) {
    return { qcode: QCODE_SHIFT[char], shift: true }
  }
  if (Object.prototype.hasOwnProperty.call(QCODE_PUNCT, char)) return { qcode: QCODE_PUNCT[char], shift: false }
  if (/^[a-z0-9]$/u.test(char)) return { qcode: char, shift: false }
  if (/^[A-Z]$/u.test(char)) return { qcode: char.toLowerCase(), shift: true }
  return null
}

/** `ctrl+c`, `shift+tab`, `enter` or a single ASCII character. */
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

/* ------------------------------------------------------------------ *
 * The backend.
 * ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {string} options.store         the VM store ($STORE)
 * @param {(host: string, port: number, commands: object[]) => Promise<object[]>} options.qmp
 *        the supervisor's QMP client, so there is ONE implementation of the
 *        capability handshake and the line protocol in this process.
 * @param {(...parts: any[]) => void} options.log
 */
export function createWindowsBackend({ store, qmp, log = () => {} } = {}) {
  const storageRoot = path.join(store, WINDOWS_STORAGE_DIR)

  function containerName(name) {
    // Deliberately not the VM name: a container shows up in `docker ps`, and
    // `ws-…` reads like a sandbox cua would manage.
    return `dsh-cua-win-${String(name).slice(0, 40)}`
  }

  function storageDir(name) {
    return path.join(storageRoot, String(name))
  }

  async function findContainer(name) {
    const listed = await dockerRequest(`/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`dsh.cua.vm=${name}`] }))}`)
    if (listed.status !== 200) throw new Error(`docker engine answered ${listed.status} for the container list`)
    const rows = Array.isArray(listed.json) ? listed.json : []
    const match = rows.find((row) => row.Labels?.['dsh.cua.vm'] === name && row.Labels?.['dsh.cua.kind'] === 'windows')
    return match ?? null
  }

  async function inspect(id) {
    const result = await dockerRequest(`/containers/${encodeURIComponent(id)}/json`)
    if (result.status === 404) return null
    if (result.status !== 200) throw new Error(`docker engine answered ${result.status} for the inspect`)
    return result.json
  }

  /**
   * The environment, built from one spec. Exported for the static gate: the
   * mapping IS the contract, and a dropped DISK_FMT is a raw-format disk that
   * cannot be reused.
   */
  function environment(spec, password) {
    const env = [
      ['VERSION', spec.windowsVersion],
      ['DISK_SIZE', `${spec.diskGb}G`],
      ['DISK_FMT', 'qcow2'],
      ['RAM_SIZE', `${spec.memory}G`],
      ['CPU_CORES', String(spec.cpu)],
      ['GPU', spec.gpu ? 'Y' : 'N'],
      ['VRAM_SIZE', '4G'],
      ['SHUTDOWN', 'Y'],
      ['MANUAL', 'N'],
      ['USERNAME', WINDOWS_USERNAME],
      ['PASSWORD', password],
      // usb-tablet is what makes absolute pointing possible (QMP sends
      // absolute axis values); the QMP socket is the control channel the
      // supervisor screenshots and types through.
      ['ARGUMENTS', `-device usb-tablet -qmp tcp:0.0.0.0:${WINDOWS_QMP_PORT},server=on,wait=off`]
    ]
    if (spec.gpu) env.push(['RENDERNODE', process.env.CUA_WINDOWS_RENDERNODE || '/dev/dri/renderD128'])
    // VERSION XOR ISO. dockurr treats ISO as "use this file", so sending both
    // makes VERSION meaningless; the spec normaliser already refuses that.
    if (spec.windowsIso) {
      env.splice(0, 1, ['ISO', spec.windowsIso])
    }
    return env.map(([key, value]) => `${key}=${value}`)
  }

  function hostConfig(spec) {
    const host = {
      Binds: [`${storageDir(spec.name)}:/storage`],
      CapAdd: ['NET_ADMIN'],
      Devices: [{ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm', CgroupPermissions: 'rwm' }],
      // No restart policy: a Windows computer is started and stopped
      // deliberately, and `unless-stopped` would resurrect one the user shut
      // down — and fight the supervisor's own state machine.
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      PortBindings: {
        [`${WINDOWS_CONSOLE_PORT}/tcp`]: [{ HostIp: '0.0.0.0', HostPort: '' }],
        [`${WINDOWS_RDP_PORT}/tcp`]: [{ HostIp: '0.0.0.0', HostPort: '' }]
      }
    }
    if (spec.gpu) {
      host.Devices.push({
        PathOnHost: process.env.CUA_WINDOWS_RENDERNODE || '/dev/dri/renderD128',
        PathInContainer: process.env.CUA_WINDOWS_RENDERNODE || '/dev/dri/renderD128',
        CgroupPermissions: 'rwm'
      })
    }
    return host
  }

  /**
   * The host port Docker actually published for a container port. A bind with
   * an empty HostPort is the only way to avoid collisions between two Windows
   * computers (both want 8006).
   */
  function publishedPort(info, containerPort) {
    const bindings = info?.NetworkSettings?.Ports?.[`${containerPort}/tcp`] ?? []
    const first = bindings.find((row) => row && Number(row.HostPort) > 0)
    return first ? { host: publishedHost(), port: Number(first.HostPort) } : null
  }

  function containerIp(info) {
    const networks = info?.NetworkSettings?.Networks ?? {}
    for (const entry of Object.values(networks)) {
      if (entry && typeof entry.IPAddress === 'string' && entry.IPAddress !== '') return entry.IPAddress
    }
    return ''
  }

  /** QMP to the container: its own IP, on the unpublished 7100. */
  async function qmpFor(info, commands) {
    const ip = containerIp(info)
    if (ip === '') throw new Error('the Windows container has no network address yet; attach it to the harness network (DSH_CUA_WINDOWS_NETWORK)')
    return qmp(ip, WINDOWS_QMP_PORT, commands, { timeoutMs: 15000 })
  }

  /**
   * READY = RDP accepting AND QMP query-status running.
   *
   * Both halves matter: the RDP listener appears while Windows is still in its
   * first-boot reboot loop (so "port open" alone reports ready during an
   * install that is about to reboot), and QMP says `running` from the moment
   * QEMU starts (so the monitor alone reports ready before the guest exists).
   */
  async function readyProbe(info) {
    const rdp = publishedPort(info, WINDOWS_RDP_PORT)
    const accept = await new Promise((resolve) => {
      if (!rdp) { resolve(false); return }
      const socket = new net.Socket()
      socket.setTimeout(1500)
      socket.on('connect', () => { socket.destroy(); resolve(true) })
      socket.on('timeout', () => { socket.destroy(); resolve(false) })
      socket.on('error', () => resolve(false))
      socket.connect(rdp.port, rdp.host)
    })
    let running = false
    let qmpError = ''
    try {
      const status = await qmpFor(info, [{ execute: 'query-status' }])
      running = /running|paused|suspended/u.test(String(status?.[0]?.return?.status ?? ''))
    } catch (error) {
      qmpError = error?.message ?? String(error)
    }
    return { ready: accept && running, rdp, running, qmpError }
  }

    /**
     * A PNG frame from the guest's own framebuffer. No 900k cap: this is the
     * QEMU console, not a cua capture, so the image IS the display.
     */
  async function screenshot(name, { saveTo = null } = {}) {
    const row = await findContainer(name)
    if (row === null) throw new Error(`no Windows container for "${name}"`)
    const info = await inspect(row.Id)
    if (info === null || info.State?.Running !== true) throw new Error('the Windows computer is not running')
    const fileInGuest = `/storage/cua-shot-${Date.now()}.png`
    const hostFile = path.join(storageDir(name), path.basename(fileInGuest))
    await qmpFor(info, [{ execute: 'screendump', arguments: { filename: fileInGuest } }])
    // The /storage bind is the fast path: the file appears on the host (the
    // shared cua-vm volume) without copying a byte. The archive API is the
    // fallback for an engine whose store is not the harness's volume.
    let png = null
    for (let attempt = 0; attempt < 20 && png === null; attempt += 1) {
      if (existsSync(hostFile)) {
        png = readFileSync(hostFile)
        try { unlinkSync(hostFile) } catch {}
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    if (png === null) {
      const archived = await dockerRequest(`/containers/${row.Id}/archive?path=${encodeURIComponent(fileInGuest)}`, { binary: true, timeoutMs: 30000 })
      if (archived.status === 200) png = untarSingle(archived.buffer, path.basename(fileInGuest))
      if (png === null) throw new Error('the guest produced no frame (screendump wrote nothing and the archive copy failed)')
    }
    if (typeof saveTo === 'string' && saveTo !== '') writeFileSync(saveTo, png)
    return { png, file: hostFile }
  }


  /** Is the option available at all? The kill switch removes it entirely. */
  function available() {
    if (!windowsEnabled()) return { ok: false, reason: 'the Windows backend is disabled (DSH_CUA_VM_WINDOWS=0)' }
    const target = engineTarget()
    return {
      ok: true,
      engine: target.kind === 'unix' ? target.socketPath : `${target.host}:${target.port}`,
      image: WINDOWS_IMAGE,
      pinned: WINDOWS_IMAGE_PINNED
    }
  }

  /** A frame's own size — the display size, with no capture budget applied. */
  async function frameSpace(name) {
    const { png } = await screenshot(name)
    const size = pngSize(png) ?? { width: 0, height: 0 }
    return {
      display: { width: size.width, height: size.height },
      screenshot: { width: size.width, height: size.height },
      scale: 1,
      source: 'qmp'
    }
  }

  return {
    enabled: windowsEnabled,
    image: WINDOWS_IMAGE,
    storageDir,
    containerName,
    available,

    /** Is the engine actually there? A tcp://dind that is down must be visible. */
    async ping() {
      const target = engineTarget()
      try {
        const result = await dockerRequest('/_ping', { timeoutMs: 4000 })
        return {
          reachable: result.status === 200,
          engine: target.kind === 'unix' ? target.socketPath : `${target.host}:${target.port}`,
          detail: result.status === 200 ? 'engine answered /_ping' : `engine answered HTTP ${result.status}`
        }
      } catch (error) {
        return {
          reachable: false,
          engine: target.kind === 'unix' ? target.socketPath : `${target.host}:${target.port}`,
          detail: error?.message ?? String(error)
        }
      }
    },

    /** docker logs tail, used for the install progress and the timeout error. */
    async logs(name, tail = 40) {
      const row = await findContainer(name)
      if (row === null) return ''
      const result = await dockerRequest(
        `/containers/${row.Id}/logs?stdout=1&stderr=1&timestamps=0&tail=${Math.max(1, Math.min(200, Number(tail) || 40))}`,
        { timeoutMs: 20000 }
      )
      // Docker prefixes each log line with an 8-byte stream header unless the
      // stream is a TTY; strip it so the text is readable.
      const raw = result.buffer
      const lines = []
      let offset = 0
      while (offset + 8 <= raw.length) {
        const size = raw.readUInt32BE(offset + 4)
        if (size > raw.length - offset - 8) break
        lines.push(raw.subarray(offset + 8, offset + 8 + size).toString('utf8'))
        offset += 8 + size
      }
      return (lines.length > 0 ? lines.join('') : raw.toString('utf8')).trim()
    },

    /**
     * Create and start. Returns as soon as the container is running — the
     * install takes tens of minutes and the caller (the panel) shows
     * `installing` with a live log tail rather than blocking a tool call.
     */
    async create(spec) {
      const gate = available()
      if (!gate.ok) throw new Error(gate.reason)
      if (spec.rea === true) throw new Error('REA is a Linux kit (REA is not available for Windows computers)')
      if (spec.android === true) throw new Error('Android is not available for Windows computers: the AVD runs on the Linux guest')
      const existing = await findContainer(spec.name)
      if (existing !== null) throw new Error(`a Windows container for "${spec.name}" already exists; destroy the computer first`)
      const password = generatePassword()
      const env = environment(spec, password)
      const body = {
        Image: WINDOWS_IMAGE,
        Env: env,
        Labels: { 'dsh.cua.vm': spec.name, 'dsh.cua.kind': 'windows' },
        ExposedPorts: { [`${WINDOWS_CONSOLE_PORT}/tcp`]: {}, [`${WINDOWS_RDP_PORT}/tcp`]: {} },
        HostConfig: hostConfig(spec),
        ...(process.env.DSH_CUA_WINDOWS_NETWORK
          ? { NetworkingConfig: { EndpointsConfig: { [process.env.DSH_CUA_WINDOWS_NETWORK]: {} } } }
          : {})
      }
      const created = await dockerRequest(`/containers/create?name=${encodeURIComponent(containerName(spec.name))}`, { method: 'POST', body, timeoutMs: 60000 })
      if (created.status !== 201) {
        throw new Error(`docker could not create the Windows container (${created.status}): ${created.json?.message ?? created.buffer.toString('utf8').slice(-300)}`)
      }
      const id = created.json?.Id ?? ''
      // CREATE AND START ARE TWO REQUESTS. A container that is created but never
      // started is invisible to the panel (no registry row, no credentials) and
      // it holds the name: the next create answers "a container already exists"
      // and the operator has to leave the UI to `docker rm` it by hand. Any
      // failure between the two therefore removes it before the error travels.
      let started
      try {
        started = await dockerRequest(`/containers/${encodeURIComponent(id)}/start`, { method: 'POST', timeoutMs: 120000 })
      } catch (error) {
        await dockerRequest(`/containers/${encodeURIComponent(id)}?force=1&v=1`, { method: 'DELETE', timeoutMs: 60000 }).catch(() => {})
        throw new Error(`docker did not answer the start of the Windows container: ${error?.message ?? error} (the container was removed)`)
      }
      if (started.status !== 204 && started.status !== 304) {
        await dockerRequest(`/containers/${encodeURIComponent(id)}?force=1&v=1`, { method: 'DELETE', timeoutMs: 60000 }).catch(() => {})
        throw new Error(`docker could not start the Windows container (${started.status}): ${started.json?.message ?? started.buffer.toString('utf8').slice(-300)} (the container was removed)`)
      }
      log(`windows: ${spec.name} installing (image ${WINDOWS_IMAGE}, ${spec.diskGb} GB, ${spec.memory} GB RAM, ${spec.cpu} vCPU${spec.gpu ? ', GPU' : ''})`)
      return {
        id,
        container: containerName(spec.name),
        password,
        passwordFile: path.join(storageDir(spec.name), 'credentials.json'),
        env: env.map((line) => line.replace(/^PASSWORD=.*$/u, 'PASSWORD=***'))
      }
    },

    /** Live status: the container state plus the two readiness halves. */
    async status(name, { timeoutMinutes = 60 } = {}) {
      const row = await findContainer(name)
      if (row === null) return { state: 'absent', detail: 'no container' }
      const info = await inspect(row.Id)
      if (info === null) return { state: 'absent', detail: 'container disappeared' }
      const startedAt = Date.parse(info.State?.StartedAt || '') || 0
      let probe = { ready: false, running: false, qmpError: '' }
      if (info.State?.Running === true) {
        try {
          probe = await readyProbe(info)
        } catch (error) {
          probe.qmpError = error?.message ?? String(error)
        }
      }
      if (info.State?.Running !== true) {
        return {
          state: info.State?.ExitCode ? 'error' : 'stopped',
          detail: `container is ${info.State?.Status ?? 'not running'} (exit ${info.State?.ExitCode ?? '?'})`,
          console: publishedPort(info, WINDOWS_CONSOLE_PORT),
          rdp: publishedPort(info, WINDOWS_RDP_PORT)
        }
      }
      if (probe.ready) {
        return { state: 'ready', console: publishedPort(info, WINDOWS_CONSOLE_PORT), rdp: publishedPort(info, WINDOWS_RDP_PORT), detail: 'RDP accepting and QMP running' }
      }
      const elapsedMin = startedAt ? Math.round((Date.now() - startedAt) / 60000) : 0
      if (timeoutMinutes > 0 && elapsedMin > timeoutMinutes) {
        return {
          state: 'error',
          detail: `the Windows install did not answer within ${timeoutMinutes} minutes (RDP ${probe.rdp ? 'open' : 'closed'}, QMP ${probe.running ? 'running' : (probe.qmpError || 'not running')})`,
          console: publishedPort(info, WINDOWS_CONSOLE_PORT),
          rdp: publishedPort(info, WINDOWS_RDP_PORT)
        }
      }
      return {
        state: 'installing',
        elapsedMinutes: elapsedMin,
        console: publishedPort(info, WINDOWS_CONSOLE_PORT),
        rdp: publishedPort(info, WINDOWS_RDP_PORT),
        detail: `installing (${elapsedMin} min): RDP ${probe.rdp ? 'open' : 'closed'}, QMP ${probe.running ? 'running' : (probe.qmpError || 'not answering')}`
      }
    },

    /** Where the console relay should point. */
    async consoleTarget(name) {
      const row = await findContainer(name)
      if (row === null) return null
      const info = await inspect(row.Id)
      return info === null ? null : publishedPort(info, WINDOWS_CONSOLE_PORT)
    },

    async remove(name) {
      const row = await findContainer(name)
      if (row === null) return { removed: false, detail: 'no container' }
      const result = await dockerRequest(`/containers/${row.Id}?force=1&v=1`, { method: 'DELETE', timeoutMs: 120000 })
      if (result.status !== 204 && result.status !== 404) {
        throw new Error(`docker could not remove the container (${result.status}): ${result.json?.message ?? ''}`)
      }
      log(`windows: ${name} container removed`)
      return { removed: true, detail: row.Id.slice(0, 12) }
    },

    /** docker start on an existing container (the installed disk is kept). */
    async start(name) {
      const row = await findContainer(name)
      if (row === null) throw new Error(`no Windows container for "${name}"`)
      const result = await dockerRequest(`/containers/${row.Id}/start`, { method: 'POST', timeoutMs: 120000 })
      if (result.status !== 204 && result.status !== 304) {
        throw new Error(`docker could not start the container (${result.status}): ${result.json?.message ?? ''}`)
      }
      log(`windows: ${name} container started`)
      return { started: true }
    },

    async stop(name) {
      const row = await findContainer(name)
      if (row === null) return { stopped: false, detail: 'no container' }
      await dockerRequest(`/containers/${row.Id}/stop?t=30`, { method: 'POST', timeoutMs: 120000 })
      return { stopped: true }
    },

    /* ---------------------------- guest surface ---------------------------- */

    /** Absolute pointer click, in IMAGE pixels (the frame IS the display). */
    async click(name, x, y, { width, height, button = 'left' } = {}) {
      const row = await findContainer(name)
      if (row === null) throw new Error(`no Windows container for "${name}"`)
      const info = await inspect(row.Id)
      const toAbsolute = (value, extent) => Math.max(0, Math.min(0x7fff, Math.round((Number(value) / Math.max(1, Number(extent))) * 0x7fff)))
      const ax = toAbsolute(x, width)
      const ay = toAbsolute(y, height)
      await qmpFor(info, [{
        execute: 'input-send-event',
        arguments: {
          events: [
            { type: 'abs', data: { axis: 'x', value: ax } },
            { type: 'abs', data: { axis: 'y', value: ay } },
            { type: 'btn', data: { down: true, button } },
            { type: 'btn', data: { down: false, button } }
          ]
        }
      }])
      return { x: Number(x), y: Number(y), absolute: { x: ax, y: ay } }
    },

    /** Absolute pointer motion without a button (hover, and half of a drag). */
    async move(name, x, y, { width, height } = {}) {
      const row = await findContainer(name)
      if (row === null) throw new Error(`no Windows container for "${name}"`)
      const info = await inspect(row.Id)
      const toAbsolute = (value, extent) => Math.max(0, Math.min(0x7fff, Math.round((Number(value) / Math.max(1, Number(extent))) * 0x7fff)))
      await qmpFor(info, [{
        execute: 'input-send-event',
        arguments: {
          events: [
            { type: 'abs', data: { axis: 'x', value: toAbsolute(x, width) } },
            { type: 'abs', data: { axis: 'y', value: toAbsolute(y, height) } }
          ]
        }
      }])
      return { x: Number(x), y: Number(y) }
    },

    /**
     * Press, move, release — three event batches, because the guest must see
     * the button held while the pointer travels for a drag to register.
     */
    async drag(name, fromX, fromY, toX, toY, { width, height } = {}) {
      const row = await findContainer(name)
      if (row === null) throw new Error(`no Windows container for "${name}"`)
      const info = await inspect(row.Id)
      const toAbsolute = (value, extent) => Math.max(0, Math.min(0x7fff, Math.round((Number(value) / Math.max(1, Number(extent))) * 0x7fff)))
      const at = (x, y) => [
        { type: 'abs', data: { axis: 'x', value: toAbsolute(x, width) } },
        { type: 'abs', data: { axis: 'y', value: toAbsolute(y, height) } }
      ]
      await qmpFor(info, [{ execute: 'input-send-event', arguments: { events: [...at(fromX, fromY), { type: 'btn', data: { down: true, button: 'left' } }] } }])
      await qmpFor(info, [{ execute: 'input-send-event', arguments: { events: at(toX, toY) } }])
      await qmpFor(info, [{ execute: 'input-send-event', arguments: { events: [...at(toX, toY), { type: 'btn', data: { down: false, button: 'left' } }] } }])
      return { from: { x: Number(fromX), y: Number(fromY) }, to: { x: Number(toX), y: Number(toY) } }
    },

    /** Keys and ASCII text, as physical key events with the right modifiers. */
    async sendKeys(name, { text = null, key = null } = {}) {
      const row = await findContainer(name)
      if (row === null) throw new Error(`no Windows container for "${name}"`)
      const info = await inspect(row.Id)
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
      await qmpFor(info, [{ execute: 'input-send-event', arguments: { events } }])
      return { sent: events.length }
    },

    /**
     * The frame's own size, which IS the display size for this backend: a QMP
     * screendump is the framebuffer, so there is no capture budget and scale is
     * always 1. `source: 'qmp'` is what the space line reports.
     */
    screenshot,
    space: frameSpace,
  }
}
