#!/usr/bin/env node
/**
 * qmp-shutdown.mjs — drive the REAL shutdown path against a REAL QEMU.
 *
 * No guest OS: QEMU is started `-S` (paused) with an empty machine, which is the
 * cleanest way to prove the parts this feature owns:
 *   * the QMP handshake (`qmp_capabilities`, one command per line),
 *   * `query-status` parsing,
 *   * the timeout → `quit` fallback (a paused machine never answers ACPI),
 *   * the registry state machine (`powered-off`, `mayBeTorn`),
 *   * the "ACPI refused → fall back to suspend" branch, on a machine with no
 *     ACPI at all (`-machine microvm`).
 *
 * It does NOT prove checkpointing (that needs qemu-img, absent on this host) or
 * a real guest's ACPI (that needs a bootable disk).
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

// Resolved from THIS file, so the suite runs from a checkout anywhere (CI,
// a worktree, a reviewer's clone) — it used to hardcode the author's path.
const REPO = process.env.REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const QEMU = '/usr/bin/qemu-system-x86_64'
let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}
const freePort = () => new Promise((resolve) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

if (!existsSync(QEMU)) {
  console.log(`NOT RUN: ${QEMU} is absent`)
  process.exit(0)
}

const STORE = path.join(os.tmpdir(), `cua-qmp-${process.pid}`)
const HOME = path.join(STORE, 'home')
const SOCK = path.join(STORE, 's.sock')
rmSync(STORE, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
const STUB = path.join(STORE, 'cua')
writeFileSync(STUB, '#!/bin/bash\nexit 0\n', { mode: 0o755 })

/** Start a paused QEMU with a QMP socket on 127.0.0.1:<port>. */
async function bootQemu(name, machine = 'q35') {
  const port = await freePort()
  const dir = path.join(HOME, '.cua', 'vmm', 'qemu', name)
  mkdirSync(dir, { recursive: true })
  const child = spawn(QEMU, [
    '-name', name, '-machine', machine, '-m', '128', '-display', 'none',
    '-qmp', `tcp:127.0.0.1:${port},server=on,wait=off`,
    '-pidfile', path.join(dir, 'qemu.pid'), '-S'
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  writeFileSync(path.join(dir, 'cmdline'), `${QEMU} -name ${name} -qmp tcp:127.0.0.1:${port},server=on,wait=off -pidfile ${dir}/qemu.pid\n`)
  // Wait for the monitor socket to accept.
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.on('connect', () => { socket.destroy(); resolve(true) })
      socket.on('error', () => resolve(false))
    })
    if (ready) break
    await new Promise((r) => setTimeout(r, 100))
  }
  return { child, port, pid: child.pid, dir }
}

/**
 * A protocol-level QMP peer that answers `system_powerdown` with QEMU's own
 * "Powerdown not supported" error. A real QEMU accepts the command even when the
 * machine has no ACPI PM and simply never powers off, so this is the only way to
 * prove the fallback branch without a device that refuses it.
 */
function fakeQmp(port, { refusePowerdown = true } = {}) {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (line.trim() === '') continue
        let message = {}
        try { message = JSON.parse(line) } catch { continue }
        if (message.execute === 'qmp_capabilities') { socket.write(JSON.stringify({ return: {} }) + '\n'); continue }
        if (message.execute === 'system_powerdown' && refusePowerdown) {
          socket.write(JSON.stringify({ error: { class: 'GenericError', desc: 'Powerdown not supported by this machine' } }) + '\n')
          continue
        }
        socket.write(JSON.stringify({ return: {} }) + '\n')
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(port, '127.0.0.1')
  return { server, close: () => { for (const socket of sockets) socket.destroy(); server.close() } }
}

const child = spawn(process.execPath, [path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')], {
  env: { ...process.env, CUA_VM_STORE: STORE, CUA_VM_HOME: HOME, CUA_SUPERVISOR_SOCK: SOCK, CUA_BIN: STUB, CUA_WORKSPACE_ROOT: '/workspace' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let stderr = ''
child.stderr.on('data', (c) => { stderr += c })
for (let i = 0; i < 150 && !existsSync(SOCK); i += 1) await new Promise((r) => setTimeout(r, 100))

const call = (payload) => new Promise((resolve, reject) => {
  const socket = net.connect(SOCK)
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
  socket.on('data', (c) => { buffer += c })
  socket.on('close', () => { try { resolve(JSON.parse(buffer.split('\n')[0])) } catch (e) { reject(e) } })
  socket.on('error', reject)
})

const qubits = []
try {
  // shutdownTimeoutSec is clamped to >= 10 by normaliseConfig; ask for the
  // smallest legal value so the test does not sit for two minutes.
  await call({ op: 'configSet', config: { shutdownTimeoutSec: 10, maxRunning: 4 } })

  // ---- A: a paused QEMU never answers ACPI, so the timeout + quit path runs ----
  const slow = await bootQemu('ws-timeout', 'q35')
  qubits.push(slow)
  writeFileSync(path.join(STORE, 'registry.json'), JSON.stringify({
    version: 2,
    vms: {
      'ws-timeout': { workspace: '/workspace', kind: 'linux', backend: 'linux', state: 'ready', cpu: 1, memory: 1, image: 'linux', diskGb: 20 },
      'ws-acpi': { workspace: '/workspace', kind: 'linux', backend: 'linux', state: 'ready', cpu: 1, memory: 1, image: 'linux', diskGb: 20 }
    }
  }, null, 2))
  const timed = await call({ op: 'vmShutdown', name: 'ws-timeout' })
  check('shutdown reaches QEMU and times out on a machine that never powers down', timed.ok === true && timed.method === 'quit', `method=${timed.method} notes=${JSON.stringify(timed.notes ?? [])}`)
  check('the forced shutdown marks the image mayBeTorn', timed.mayBeTorn === true)
  check('QEMU actually exited after the QMP quit', !alive(slow.pid))
  check('registry records powered-off', JSON.parse(readFileSync(path.join(STORE, 'registry.json'), 'utf8')).vms['ws-timeout'].state === 'powered-off')

  // ---- B: the guest refuses system_powerdown → explicit suspend fallback ----
  const acpiPort = await freePort()
  const acpiDir = path.join(HOME, '.cua', 'vmm', 'qemu', 'ws-acpi')
  mkdirSync(acpiDir, { recursive: true })
  writeFileSync(path.join(acpiDir, 'cmdline'), `${QEMU} -name ws-acpi -qmp tcp:127.0.0.1:${acpiPort},server=on,wait=off\n`)
  const fake = fakeQmp(acpiPort, { refusePowerdown: true })
  const fallback = await call({ op: 'vmShutdown', name: 'ws-acpi' })
  fake.close()
  check('an ACPI refusal falls back to suspend, explicitly', fallback.ok === true && fallback.fallback === 'acpi-unsupported', `state=${fallback.state} detail=${String(fallback.detail).slice(0, 110)}`)
  check('the fallback says what Start will do', /resumes it where it was/u.test(fallback.detail ?? ''))
  check('the fallback state is suspended, not powered-off', fallback.state === 'suspended', `state=${fallback.state}`)
} catch (error) {
  failures += 1
  console.log(` FAIL harness: ${error.message}`)
} finally {
  for (const q of qubits) { try { q.child.kill('SIGKILL') } catch {} }
  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 400))
  if (failures > 0) console.log(`\nsupervisor log:\n${stderr.split('\n').slice(-20).join('\n')}`)
  rmSync(STORE, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nqmp: PASS' : `\nqmp: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
