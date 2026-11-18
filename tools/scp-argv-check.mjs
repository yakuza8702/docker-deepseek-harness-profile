#!/usr/bin/env node
/**
 * scp-argv-check.mjs — pin the POSITION of every argument in the Windows
 * put/get chain, end to end, against a stub `scp`.
 *
 * THE BUG THIS FILE EXISTS FOR
 * ----------------------------
 * A live `cua_vm_put` to a Windows computer failed with:
 *
 *   scp: stat local "47000": No such file or directory
 *
 * The SSH port had become the LOCAL FILE. `sshBaseArgs()` emits ssh's port flag
 * `-p PORT`; `scpRun()` reused that list, stripped only `-T`, and handed the
 * rest to scp. scp's `-p` means "preserve times/modes" and takes NO value, so
 * the port number was never consumed as a flag value — it fell through as a
 * POSITIONAL, i.e. a source file. (OpenSSH reads positionals back-to-front: the
 * last is the destination and everything before it is a source, so `47000`
 * became a source and the real local file became a second destination.)
 *
 * HOW THIS IS PROVEN
 * ------------------
 * The shape of the argv IS the defect; it needs no SSH server. This file points
 * `DSH_CUA_SCP_BIN` (a test-only hook) and `CUA_BIN` at shell scripts that
 * record their own argv, drives the REAL supervisor over its REAL unix socket
 * (`{op:'put'}`, `{op:'get'}`, `{op:'vmWindowsClipboardSet/Get'}`) and then
 * parses the recorded argv the way OpenSSH parses it. A port in a positional
 * slot fails the parse.
 *
 * ASSERTED
 *   put (to-guest)     [scp, …opts…, -P, PORT, LOCAL, user@host:GUEST]
 *   get (from-guest)   [scp, …opts…, user@host:GUEST, LOCAL]
 *   putText/getText    the SAME shape with the clipboard temp file
 *   PORT is the value of `-P` and is NEVER a positional
 *   ssh's `-p` is ABSENT from the scp argv
 *   Linux path          `sb cp --local SRC DST`, no port flag at all
 *   CONTROL            the OLD argv still parses PORT as a source, which is
 *                      exactly the user's error string
 *
 * No QEMU, no KVM, no guest, no network: two shell scripts and a temp store.
 * Run: node tools/scp-argv-check.mjs   (REPO=/path/to/repo to point elsewhere)
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO = process.env.REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUPERVISOR = path.join(REPO, 'docker', 'cua-vm-supervisor.mjs')
const PORT = 47000
const WIN = 'winvm'
const GUEST_FILE = 'C:\\Users\\cua\\notes.txt'

const ROOT = path.join(os.tmpdir(), `cua-scpargv-${process.pid}`)
const STORE = path.join(ROOT, 'store')
const HOME = path.join(ROOT, 'home')
const WS = path.join(ROOT, 'ws')
const BIN = path.join(ROOT, 'bin')
const SOCK = path.join(ROOT, 'supervisor.sock')
const SCP_LOG = path.join(ROOT, 'scp-argv.log')
const CUA_LOG = path.join(ROOT, 'cua-argv.log')
const SSH_LOG = path.join(ROOT, 'ssh-argv.log')
const SCP_STUB = path.join(BIN, 'scp-stub')
const SSH_STUB = path.join(BIN, 'ssh-stub')
const CUA_STUB = path.join(BIN, 'cua-stub')
const LOCAL_SRC = path.join(WS, 'notes.txt')
const KEY = path.join(STORE, 'windows', WIN, 'id_ed25519')

let failures = 0
let checks = 0
let childOut = ''
const check = (label, ok, detail = '') => {
  checks += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/**
 * OPENSsh's OWN ARGUMENT GRAMMAR, reduced to what scp takes here.
 * Flags WITH a value: -i -o -P -F -S -J -c -l. `-p` is a flag with NO value
 * (preserve times/modes) — that is the whole trap, so it is modelled explicitly.
 */
const SCP_FLAGS_WITH_VALUE = new Set(['-i', '-o', '-P', '-F', '-S', '-J', '-c', '-l'])
const SCP_FLAGS_NO_VALUE = new Set(['-3', '-4', '-6', '-B', '-C', '-p', '-q', '-r', '-T', '-v'])

/** argv → { flags, positionals, unknown }, read the way scp reads it. */
export function parseScpArgv(argv) {
  const flags = new Map()
  const positionals = []
  const unknown = []
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]
    // A Windows drive path (C:\x) or a remote (cua@h:/x) is a positional, and
    // so is anything scp would read as a path rather than an option.
    const looksLikeOption = token.startsWith('-') && token.length > 1 && !/^-\d/u.test(token)
    if (!looksLikeOption) { positionals.push(token); continue }
    if (SCP_FLAGS_WITH_VALUE.has(token)) { flags.set(token, argv[i + 1]); i += 1; continue }
    if (SCP_FLAGS_NO_VALUE.has(token)) { flags.set(token, true); continue }
    unknown.push(token)
  }
  return { flags, positionals, unknown }
}

/**
 * ssh's grammar — DELIBERATELY DIFFERENT from scp's in exactly one place:
 * ssh's `-p` TAKES A VALUE (the port) while scp's `-p` does not. Two parsers,
 * because one parser cannot model both without hiding the bug.
 */
const SSH_FLAGS_WITH_VALUE = new Set(['-i', '-o', '-p', '-l', '-c', '-F', '-S', '-J', '-b', '-D', '-E', '-e', '-I', '-L', '-m', '-O', '-Q', '-R', '-W', '-w'])
const SSH_FLAGS_NO_VALUE = new Set(['-T', '-t', '-q', '-v', '-4', '-6', '-A', '-a', '-C', '-N', '-n', '-x', '-X', '-Y', '-y', '-f', '-G', '-K', '-k', '-s'])

export function parseSshArgv(argv) {
  const flags = new Map()
  const positionals = []
  const unknown = []
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]
    const looksLikeOption = token.startsWith('-') && token.length > 1 && !/^-\d/u.test(token)
    if (!looksLikeOption) { positionals.push(token); continue }
    if (SSH_FLAGS_WITH_VALUE.has(token)) { flags.set(token, argv[i + 1]); i += 1; continue }
    if (SSH_FLAGS_NO_VALUE.has(token)) { flags.set(token, true); continue }
    unknown.push(token)
  }
  return { flags, positionals, unknown }
}

/** A stub that appends each of its arguments, one per line, then a record mark. */
function writeStub(file, logFile, extra = '') {
  writeFileSync(file, [
    '#!/bin/sh',
    `LOG=${JSON.stringify(logFile)}`,
    'printf "%s\\n" "$0" >> "$LOG"',
    'for a in "$@"; do printf "%s\\n" "$a" >> "$LOG"; done',
    'printf "__ARGV__\\n" >> "$LOG"',
    extra,
    'exit "${DSH_STUB_EXIT:-0}"',
    ''
  ].join('\n'), { encoding: 'utf8', mode: 0o755 })
  chmodSync(file, 0o755)
}

/** All argv records the stub wrote since the log was last truncated. */
function readArgv(logFile) {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8')
    .split('__ARGV__\n')
    .filter((block) => block !== '')
    .map((block) => block.split('\n').slice(0, -1))
}

/** One request on the real supervisor socket: one JSON line out, one back. */
function callSupervisor(sock, request, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`supervisor did not answer ${JSON.stringify(request.op)} in ${timeoutMs} ms`))
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      clearTimeout(timer)
      socket.end()
      try { resolve(JSON.parse(buffer.slice(0, newline))) } catch (error) {
        reject(new Error(`unparseable answer: ${buffer.slice(0, 200)}`))
      }
    })
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

async function waitForSocket(sock, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(sock)) {
      try { await callSupervisor(sock, { op: 'status' }, 5000); return true } catch { /* not listening yet */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

async function main() {
  rmSync(ROOT, { recursive: true, force: true })
  for (const dir of [path.join(STORE, 'windows', WIN), HOME, WS, BIN]) mkdirSync(dir, { recursive: true })
  writeFileSync(LOCAL_SRC, 'hello from the workspace\n')
  // The per-computer key exists, so `-i KEY` in the argv is real, not incidental.
  writeFileSync(KEY, '-----BEGIN OPENSSH PRIVATE KEY-----\nstub\n-----END OPENSSH PRIVATE KEY-----\n', { mode: 0o600 })
  writeFileSync(path.join(STORE, 'registry.json'), `${JSON.stringify({
    version: 2,
    vms: {
      [WIN]: {
        name: WIN, kind: 'windows', state: 'ready', backend: 'qemu',
        cpu: 2, memory: 4, diskGb: 64, createdAt: '2026-01-01T00:00:00.000Z',
        windowsVersion: '11', installComplete: true,
        ports: { ssh: PORT, vnc: 5900 }, lastUsed: '2026-01-01T00:00:00.000Z'
      },
      lxvm: {
        name: 'lxvm', kind: 'linux', state: 'ready', backend: 'cua',
        cpu: 2, memory: 4, diskGb: 20, createdAt: '2026-01-01T00:00:00.000Z',
        ports: { ssh: 2222 }, lastUsed: '2026-01-01T00:00:00.000Z'
      }
    }
  }, null, 2)}\n`)

  writeStub(SCP_STUB, SCP_LOG)
  writeStub(SSH_STUB, SSH_LOG, [
    '# A Windows task that reports a Last Result is "done": without it the',
    '# clipboard task path polls for its full 20 s budget before giving up.',
    'case "$*" in',
    '  *"schtasks /query"*) printf "Status: Ready\\nLast Result: 0\\n" ;;',
    'esac'
  ].join('\n'))
  writeStub(CUA_STUB, CUA_LOG)
  writeFileSync(SSH_LOG, '')

  const child = spawn(process.execPath, [SUPERVISOR], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CUA_VM_STORE: STORE,
      CUA_VM_HOME: HOME,
      CUA_SUPERVISOR_SOCK: SOCK,
      CUA_WORKSPACE_ROOT: WS,
      CUA_BIN: CUA_STUB,
      DSH_CUA_SCP_BIN: SCP_STUB,
      DSH_CUA_SSH_BIN: SSH_STUB,
      DSH_CUA_WIN_SCP_TIMEOUT_MS: '10000'
    }
  })
  child.stdout.on('data', (chunk) => { childOut += chunk })
  child.stderr.on('data', (chunk) => { childOut += chunk })

  try {
    const up = await waitForSocket(SOCK)
    check('supervisor listens on the temp socket', up, up ? SOCK : childOut.slice(-400))
    if (!up) return

    /* ------------------------------ PUT ------------------------------ */
    writeFileSync(SCP_LOG, '')
    const put = await callSupervisor(SOCK, { op: 'put', name: WIN, local: 'notes.txt', guest: GUEST_FILE })
    const putArgv = readArgv(SCP_LOG)[0] ?? []
    console.log(`        put argv: ${JSON.stringify(putArgv)}`)
    const p = parseScpArgv(putArgv)
    check('put: the copy succeeded', put?.ok === true, JSON.stringify(put).slice(0, 240))
    check('put: argv[0] is the scp binary', putArgv[0] === SCP_STUB, String(putArgv[0]))
    check('put: the -i slot holds the per-computer key', p.flags.get('-i') === KEY, String(p.flags.get('-i')))
    check(`put: the -P slot holds the port ${PORT}`, p.flags.get('-P') === String(PORT), String(p.flags.get('-P')))
    check("put: ssh's -p is ABSENT from the scp argv", !putArgv.includes('-p'), putArgv.includes('-p') ? 'found -p' : 'none')
    check('put: exactly two positionals (source, destination)', p.positionals.length === 2, JSON.stringify(p.positionals))
    check('put: the LOCAL file is the SOURCE (positional 1)', p.positionals[0] === LOCAL_SRC, String(p.positionals[0]))
    check('put: the remote is the DESTINATION (positional 2)', p.positionals[1] === `cua@127.0.0.1:${GUEST_FILE}`, String(p.positionals[1]))
    check(`put: "${PORT}" NEVER appears as a positional`, !p.positionals.includes(String(PORT)), JSON.stringify(p.positionals))
    check('put: no unknown flags', p.unknown.length === 0, JSON.stringify(p.unknown))

    /* ------------------------------ GET ------------------------------ */
    writeFileSync(SCP_LOG, '')
    const got = await callSupervisor(SOCK, { op: 'get', name: WIN, guest: GUEST_FILE, local: 'pulled.txt' })
    const getArgv = readArgv(SCP_LOG)[0] ?? []
    console.log(`        get argv: ${JSON.stringify(getArgv)}`)
    const g = parseScpArgv(getArgv)
    check('get: argv[0] is the scp binary', getArgv[0] === SCP_STUB, String(getArgv[0]))
    check('get: the -P slot holds the port', g.flags.get('-P') === String(PORT), String(g.flags.get('-P')))
    check("get: ssh's -p is ABSENT", !getArgv.includes('-p'), getArgv.includes('-p') ? 'found -p' : 'none')
    check('get: exactly two positionals', g.positionals.length === 2, JSON.stringify(g.positionals))
    check('get: the remote is the SOURCE (positional 1)', g.positionals[0] === `cua@127.0.0.1:${GUEST_FILE}`, String(g.positionals[0]))
    check('get: the LOCAL file is the DESTINATION (positional 2)', g.positionals[1] === path.join(WS, 'pulled.txt'), String(g.positionals[1]))
    check(`get: "${PORT}" NEVER appears as a positional`, !g.positionals.includes(String(PORT)), JSON.stringify(g.positionals))
    check('get: no unknown flags', g.unknown.length === 0, JSON.stringify(g.unknown))
    // The stub exits 0 but writes no file, so `get` fails on the READ — which is
    // after the copy and says nothing about the argv. The check is that it is
    // not scp's argv error.
    check('get: the reported failure is not an argv error', !JSON.stringify(got).includes('stat local'), JSON.stringify(got).slice(0, 200))

    /* ------------------- putText / getText (clipboard) ---------------- */
    // THE REAL PATH: vmWindowsClipboardSet → transport.putText → scpRun. The
    // file is written BEFORE any task runs, so this drives the putText argv
    // itself; the ssh half is stubbed too, so the whole call completes.
    writeFileSync(SCP_LOG, '')
    writeFileSync(SSH_LOG, '')
    const clipSet = await callSupervisor(SOCK, { op: 'vmWindowsClipboardSet', name: WIN, text: 'argv shape check' }, 60000)
    const clipArgv = readArgv(SCP_LOG)[0] ?? []
    console.log(`        putText argv: ${JSON.stringify(clipArgv)}`)
    const cp = parseScpArgv(clipArgv)
    check('putText: scp was actually invoked', clipArgv.length > 0, clipArgv.length > 0 ? '' : JSON.stringify(clipSet).slice(0, 300))
    check('putText: argv[0] is the scp binary', clipArgv[0] === SCP_STUB, String(clipArgv[0]))
    check('putText: the -P slot holds the port', cp.flags.get('-P') === String(PORT), String(cp.flags.get('-P')))
    check("putText: ssh's -p is ABSENT", !clipArgv.includes('-p'), clipArgv.includes('-p') ? 'found -p' : 'none')
    check('putText: exactly two positionals', cp.positionals.length === 2, JSON.stringify(cp.positionals))
    check('putText: the clip temp file is the SOURCE', /\/cua-clip-[^/]+\//u.test(cp.positionals[0] ?? ''), String(cp.positionals[0]))
    check('putText: the clip temp file is a LOCAL path, not a port', cp.positionals[0] !== String(PORT), String(cp.positionals[0]))
    check('putText: the guest ProgramData path is the DESTINATION', /^cua@127\.0\.0\.1:C:\\ProgramData\\cua\\/u.test(cp.positionals[1] ?? ''), String(cp.positionals[1]))
    check(`putText: "${PORT}" is never a positional`, !cp.positionals.includes(String(PORT)), JSON.stringify(cp.positionals))

    writeFileSync(SCP_LOG, '')
    writeFileSync(SSH_LOG, '')
    const clipGet = await callSupervisor(SOCK, { op: 'vmWindowsClipboardGet', name: WIN }, 60000)
    const clipGetArgv = readArgv(SCP_LOG)[0] ?? []
    console.log(`        getText argv: ${JSON.stringify(clipGetArgv)}`)
    const cg = parseScpArgv(clipGetArgv)
    check('getText: scp was actually invoked', clipGetArgv.length > 0, clipGetArgv.length > 0 ? '' : JSON.stringify(clipGet).slice(0, 300))
    check('getText: argv[0] is the scp binary', clipGetArgv[0] === SCP_STUB, String(clipGetArgv[0]))
    check('getText: the -P slot holds the port', cg.flags.get('-P') === String(PORT), String(cg.flags.get('-P')))
    check("getText: ssh's -p is ABSENT", !clipGetArgv.includes('-p'), clipGetArgv.includes('-p') ? 'found -p' : 'none')
    check('getText: the guest path is the SOURCE', /^cua@127\.0\.0\.1:C:\\ProgramData\\cua\\/u.test(cg.positionals[0] ?? ''), String(cg.positionals[0]))
    check('getText: the local temp file is the DESTINATION', /\/cua-clip-[^/]+\//u.test(cg.positionals[1] ?? ''), String(cg.positionals[1]))
    check(`getText: "${PORT}" is never a positional`, !cg.positionals.includes(String(PORT)), JSON.stringify(cg.positionals))

    /* --------------- ssh keeps its OWN flag: `-p PORT` ---------------- */
    // The audit's other half: the port flag is right for ssh and wrong for scp.
    const sshRecords = readArgv(SSH_LOG)
    const sshArgv = sshRecords[sshRecords.length - 1] ?? []
    console.log(`        ssh argv: ${JSON.stringify(sshArgv).slice(0, 400)}`)
    const sshp = parseSshArgv(sshArgv)
    check('ssh: argv[0] is the ssh binary', sshArgv[0] === SSH_STUB, String(sshArgv[0]))
    check('ssh: -T is present (no pty)', sshp.flags.has('-T'), JSON.stringify([...sshp.flags.keys()]))
    check('ssh: `-p` holds the port (ssh is NOT scp)', sshp.flags.get('-p') === String(PORT), String(sshp.flags.get('-p')))
    check('ssh: the host is a positional, the command is last', sshp.positionals[0] === 'cua@127.0.0.1' && sshp.positionals.length === 2, JSON.stringify(sshp.positionals).slice(0, 200))
    /* ------------------- the LINUX path: `sb cp`, no port ------------ */
    writeFileSync(CUA_LOG, '')
    const lxPut = await callSupervisor(SOCK, { op: 'put', name: 'lxvm', local: 'notes.txt', guest: '/workspace/notes.txt' })
    const cuaArgv = readArgv(CUA_LOG)[0] ?? []
    console.log(`        linux put argv: ${JSON.stringify(cuaArgv)}`)
    const cuaArgs = cuaArgv.slice(1)
    check('linux put: argv[0] is the cua binary', cuaArgv[0] === CUA_STUB, String(cuaArgv[0]))
    check('linux put: `sb cp --local <local> <name>:<guest>`', cuaArgs.join(' ') === `sb cp --local ${LOCAL_SRC} lxvm:/workspace/notes.txt`, cuaArgs.join(' ') || JSON.stringify(lxPut).slice(0, 160))
    check('linux put: no -p/-P anywhere', !cuaArgs.includes('-p') && !cuaArgs.includes('-P'), cuaArgs.join(' '))
    check('linux put: the local file precedes the remote', cuaArgs.indexOf(LOCAL_SRC) !== -1 && cuaArgs.indexOf(LOCAL_SRC) < cuaArgs.indexOf('lxvm:/workspace/notes.txt'), cuaArgs.join(' '))

    writeFileSync(CUA_LOG, '')
    await callSupervisor(SOCK, { op: 'get', name: 'lxvm', guest: '/workspace/notes.txt', local: 'back.txt' })
    const cuaGetArgv = readArgv(CUA_LOG)[0] ?? []
    console.log(`        linux get argv: ${JSON.stringify(cuaGetArgv)}`)
    check('linux get: the remote is the source, the local the destination', cuaGetArgv.slice(1).join(' ') === `sb cp --local lxvm:/workspace/notes.txt ${path.join(WS, 'back.txt')}`, cuaGetArgv.slice(1).join(' '))

    /* ---------------- CONTROL: the OLD shape reproduces the bug ------ */
    const oldArgv = ['scp', '-q', '-i', KEY, '-o', 'BatchMode=yes', '-p', String(PORT), LOCAL_SRC, `cua@127.0.0.1:${GUEST_FILE}`]
    const o = parseScpArgv(oldArgv)
    console.log(`        old-shape argv: ${JSON.stringify(oldArgv)}`)
    console.log(`        old-shape positionals: ${JSON.stringify(o.positionals)}`)
    check('CONTROL: the old argv parses the PORT as source positional 1', o.positionals[0] === String(PORT), JSON.stringify(o.positionals))
    check('CONTROL: so the old argv IS `scp: stat local "47000"`', /^\d+$/u.test(o.positionals[0] ?? ''), 'the reported error, reproduced from the argv alone')
    check('CONTROL: the fixed argv does not reproduce it', !p.positionals.includes(String(PORT)))
  } finally {
    try { child.kill('SIGTERM') } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
    try { child.kill('SIGKILL') } catch {}
    if (process.env.KEEP_TEMP === '1') console.log(`  (temp kept at ${ROOT})`)
    else rmSync(ROOT, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  failures += 1
  console.log(` FAIL  the harness itself threw — ${error?.stack ?? error}`)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks`)
if (failures > 0 && childOut !== '') console.log(`\nsupervisor output (tail):\n${childOut.slice(-2500)}`)
process.exit(failures === 0 ? 0 : 1)
