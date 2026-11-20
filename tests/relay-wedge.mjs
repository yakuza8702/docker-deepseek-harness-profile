#!/usr/bin/env node
/**
 * relay-wedge.mjs — the behavioural acceptance for WP-A (SOL §3.3, checks A-1..A-26).
 *
 * WHAT THIS SUITE IS FOR. `docker/cua-mcp-relay.py` is the guest-side process
 * that keeps the MCP server in the interactive Windows session. Three of its
 * defects are invisible to a text gate and were never asserted anywhere (R10):
 *
 *   R1  `RELAY_OK` is an ACCEPT-LOOP handshake. The doctor printed it while
 *       every tool call timed out, because nothing could measure the child.
 *   R2  one non-returning PostMessage/UIA call wedged the child and poisoned
 *       the lane for N x 45 s, with no reset until the guest's call happened to
 *       finish (the report's recovery was the guest, not the host).
 *   R8  desktop facts were measured ONCE per --serve process, so the file
 *       reported boot-time truth forever.
 *
 * So this suite starts the REAL relay (no stub of the thing under test), gives
 * it a fixture child that can wedge on demand, and proves behaviour:
 *
 *   A-1  the file compiles and is pure ASCII (a `—` in an answer message is a
 *        UnicodeEncodeError inside a pythonw.exe process with no console)
 *   A-2  the token set: RELAY_FN classifies `functional`, RELAY_PING `ping`,
 *        `{"json` a session — the split C2 exists for
 *   A-3  with a wedged child attached, the CHEAP probe still answers RELAY_OK
 *   A-4  RELAY_FN answers one JSON line with every C3 key and `null` (not 0)
 *        before the first successful call
 *   A-5  a request to the wedged child is answered child-wedged between 0.6 s
 *        and 1.6 s with a 800 ms deadline
 *   A-6  two outstanding ids are BOTH answered, ascending, exactly once each
 *   A-7  the log has two `child-start pid=` lines with DIFFERENT pids and one
 *        `wedge id=1` line
 *   A-8  the next RELAY_FN reports childRestarts:1 and the new child's pid
 *   A-9  the request AFTER the wedge succeeds — the lane heals in place, with
 *        no reconnect (this is the whole point of R2)
 *   A-10 no duplicate answer: exactly one error line per id
 *   A-11 DSH_CUA_MCP_WEDGE_DEADLINE_MS=0 disables the watchdog: no answer in
 *        1.5 s and the child pid never moves
 *   A-12 a non-JSON line is forwarded byte-identically and pairs nothing
 *   A-13 a normal request line reaches the child byte-identically (the bridge
 *        is still raw; accounting is passive)
 *   A-14 a 300 ms facts refresh really refreshes (mtime moves >= 3 times) and
 *        the file says refreshMs:300
 *   A-15 the facts file carries the relay counters, `null` where unknown
 *   A-16/A-17 facts_refresh_interval: 900000 healthy, 60000 for EACH of the
 *        four suspect fields (the ladder that closes R8)
 *   A-18 wedge_deadline_ms() clamps 5 -> 200, 999999 -> 600000, 0 -> 0, '' ->
 *        20000, garbage -> 20000
 *   A-19 a 1.3 MB result (past the 1 MiB scan cap) crosses byte-exactly, arms
 *        NO wedge, kills NO healthy child, and pairing resumes afterwards —
 *        the PRE defect where a cap artifact was read as a wedged child
 *   A-20 the poll/write window (child killed between them) retries the same
 *        chunk against the respawned child instead of closing the session
 *   A-21 a CRASHED child's outstanding id never arms a wedge on its healthy
 *        replacement (drives the REAL `Relay.child()` respawn, not a stub)
 *   A-22 ONE writer on the client socket: a second message cannot enter while a
 *        result is in flight (JURY J1 — no interleaved, unparsable line)
 *   A-23 a slow client cannot make an answered call look wedged (JURY J2)
 *   A-24 the wedge is booked before its answers, so a blocked write cannot
 *        leave the doctor reading childRestarts:0 (JURY J3)
 *   A-25 exactly once: an id the child already answered is not answered again,
 *        and a fire with no kill books no restart (JURY J7)
 *   A-26 a >1 MiB REQUEST line degrades pairing loudly instead of silently
 *        (JURY J8)
 *
 * RUN: node tests/relay-wedge.mjs        (PY = process.env.DSH_CUA_MCP_PYTHON ?? 'python3')
 * Every child is killed in `finally`; each scenario owns its own temp dir.
 */
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELAY = path.join(REPO, 'docker', 'cua-mcp-relay.py')
const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'fake-wedged-child.py')
const PY = process.env.DSH_CUA_MCP_PYTHON ?? 'python3'

let checks = 0
let failures = 0
const check = (label, ok, detail = '') => {
  checks += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(probe, timeoutMs = 5000, stepMs = 40) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value = false
    try { value = await probe() } catch { value = false }
    if (value) return value
    if (Date.now() >= deadline) return null
    await sleep(stepMs)
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/* ------------------------------------------------------------------ *
 * a Python one-shot against the relay's own module (imports are cheap:
 * the module is stdlib-only and runs nothing at import time)
 * ------------------------------------------------------------------ */
function python(program, env = {}) {
  const cleanEnv = { ...process.env }
  for (const name of Object.keys(cleanEnv)) {
    if (name.startsWith('DSH_CUA_MCP_FACTS_') || name.startsWith('DSH_CUA_MCP_WEDGE_')) delete cleanEnv[name]
  }
  const result = spawnSync(PY, ['-c', program], { encoding: 'utf8', env: { ...cleanEnv, ...env } })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const LOAD_MODULE = [
  'import importlib.util, json, os, sys',
  `spec = importlib.util.spec_from_file_location('cua_relay', ${JSON.stringify(RELAY)})`,
  "mod = importlib.util.module_from_spec(spec)",
  'spec.loader.exec_module(mod)'
].join('\n')

function lastJson(text) {
  for (const line of String(text).split('\n').reverse()) {
    const trimmed = line.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try { return JSON.parse(trimmed) } catch { return null }
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * the relay under test
 * ------------------------------------------------------------------ */
const live = { relays: [], clients: [] }

async function startRelay(env = {}, { wedgeTickets = 0, bigResult = 0, crashTickets = 0 } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cua-relay-wedge-'))
  const port = await freePort()
  const marker = path.join(dir, 'wedge-tickets')
  writeFileSync(marker, String(wedgeTickets))
  const crashMarker = path.join(dir, 'crash-tickets')
  writeFileSync(crashMarker, String(crashTickets))
  const logPath = path.join(dir, 'relay.log')
  const childEnv = {
    ...process.env,
    // EVERY knob this suite depends on is set here, so a developer's own shell
    // cannot make a check pass or fail.
    DSH_CUA_MCP_RELAY_LOG: logPath,
    DSH_CUA_MCP_SERVER: `${PY} ${FIXTURE}`,
    FAKE_CHILD_WEDGE_MARKER: marker,
    FAKE_CHILD_RX_LOG: path.join(dir, 'child-rx.bin'),
    FAKE_CHILD_READY: path.join(dir, 'children.txt'),
    FAKE_CHILD_BIG_RESULT: String(bigResult),
    FAKE_CHILD_CRASH_MARKER: crashMarker,
    HOME: dir,
    TEMP: dir,
    TMP: dir,
    ...env
  }
  // A fresh relay must never inherit a port from the caller's environment.
  delete childEnv.DSH_CUA_MCP_RELAY_PORT
  const proc = spawn(PY, [RELAY, '--serve', '--port', String(port)], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true                       // own process group: cleanup kills grandchildren too
  })
  const relay = { dir, port, proc, logPath, marker, stdout: '', stderr: '' }
  proc.stdout.on('data', (chunk) => { relay.stdout += chunk.toString('utf8') })
  proc.stderr.on('data', (chunk) => { relay.stderr += chunk.toString('utf8') })
  proc.on('error', () => {})
  live.relays.push(relay)
  const ready = await waitRelay(port, 10000)
  if (!ready) {
    throw new Error(`the relay did not answer RELAY_PING on 127.0.0.1:${port} (stderr: ${relay.stderr.slice(0, 400)})`)
  }
  return relay
}

async function waitRelay(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const answer = await new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' })
      let seen = ''
      let settled = false
      const settle = (value) => { if (!settled) { settled = true; try { socket.destroy() } catch {} resolve(value) } }
      const timer = setTimeout(() => settle(null), 1200)
      timer.unref?.()
      socket.once('connect', () => socket.write('RELAY_PING'))
      socket.on('data', (chunk) => {
        seen += chunk.toString('latin1')
        if (seen.length >= 8) { clearTimeout(timer); settle(seen) }
      })
      socket.once('error', () => { clearTimeout(timer); settle(null) })
      socket.once('close', () => { clearTimeout(timer); settle(null) })
    })
    if (answer === 'RELAY_OK') return true
    await sleep(60)
  }
  return false
}

function stopRelay(relay) {
  if (!relay?.proc) return
  try { process.kill(-relay.proc.pid, 'SIGKILL') } catch {
    try { relay.proc.kill('SIGKILL') } catch {}
  }
  // The scenario's temp dir holds the relay log, the fixture's byte log and the
  // facts file. Every reader has already finished with them; nothing outlives
  // the process that wrote them (and a run leaves no litter in /tmp).
  try { rmSync(relay.dir, { recursive: true, force: true }) } catch {}
}

/* ------------------------------------------------------------------ *
 * one client connection, newline-delimited
 * ------------------------------------------------------------------ */
function openClient(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const state = { socket, buffer: '', waiters: [], queued: [], closed: false }
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      state.buffer += chunk
      let cut = state.buffer.indexOf('\n')
      while (cut >= 0) {
        const line = state.buffer.slice(0, cut)
        state.buffer = state.buffer.slice(cut + 1)
        const waiter = state.waiters.shift()
        if (waiter) { clearTimeout(waiter.timer); waiter.resolve(line) } else state.queued.push(line)
        cut = state.buffer.indexOf('\n')
      }
    })
    socket.on('error', () => { state.closed = true })
    socket.on('close', () => {
      state.closed = true
      for (const waiter of state.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(null) }
    })
    socket.once('connect', () => { live.clients.push(state); resolve(state) })
    socket.once('error', reject)
  })
}

function nextLine(state, timeoutMs = 3000) {
  if (state.queued.length > 0) return Promise.resolve(state.queued.shift())
  return new Promise((resolve) => {
    const waiter = { resolve, timer: null }
    waiter.timer = setTimeout(() => {
      const at = state.waiters.indexOf(waiter)
      if (at >= 0) state.waiters.splice(at, 1)
      resolve(null)
    }, timeoutMs)
    waiter.timer.unref?.()
    state.waiters.push(waiter)
  })
}

async function collectLines(state, ms) {
  const out = []
  const deadline = Date.now() + ms
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) return out
    const line = await nextLine(state, left)
    if (line === null) return out
    out.push(line)
  }
}

const parse = (line) => {
  try { return JSON.parse(line) } catch { return null }
}

/** Ask the evidence verb on a FRESH connection (never the attached session). */
async function askEvidence(port, timeoutMs = 3000) {
  const client = await openClient(port)
  client.socket.write('RELAY_FN')
  const line = await nextLine(client, timeoutMs)
  try { client.socket.destroy() } catch {}
  return { line, evidence: line === null ? null : parse(line) }
}

const REQUEST = (id, method = 'tools/call') => `{"jsonrpc":"2.0","id":${id},"method":"${method}","params":{}}\n`

/* ================================================================== *
 * A-1 — compiles and is pure ASCII
 * ================================================================== */
{
  const cachePrefix = mkdtempSync(path.join(os.tmpdir(), 'cua-relay-pyc-'))
  const compiled = spawnSync(PY, ['-m', 'py_compile', RELAY], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPYCACHEPREFIX: cachePrefix }
  })
  rmSync(cachePrefix, { recursive: true, force: true })
  const bytes = readFileSync(RELAY)
  let maxByte = 0
  for (const value of bytes) if (value > maxByte) maxByte = value
  check('A-1 `docker/cua-mcp-relay.py` compiles and is pure ASCII (a dash in an answer message is a guest-side crash)',
    compiled.status === 0 && maxByte < 0x80,
    `py_compile=${compiled.status} maxByte=0x${maxByte.toString(16)}${compiled.status === 0 ? '' : ` ${String(compiled.stderr).slice(0, 200)}`}`)
}

/* ================================================================== *
 * A-2 — the token set (C2): RELAY_FN is NOT a RELAY_PING prefix
 * ================================================================== */
{
  const source = readFileSync(RELAY, 'utf8')
  const program = `${LOAD_MODULE}
out = {
    'probe_fn': mod.PROBE_FN.decode('ascii'),
    'probes': [[token.decode('ascii'), kind] for token, kind in mod.PROBES],
    'fn': mod._probe_kind(b'RELAY_FN'),
    'ping': mod._probe_kind(b'RELAY_PING'),
    'session': mod._probe_kind(b'{"jsonrpc":"2.0"'),
    'empty': mod._probe_kind(b''),
    'fn_prefix': mod._probe_prefix(b'RELAY_F'),
    'session_prefix': mod._probe_prefix(b'{'),
}
print(json.dumps(out))`
  const run = python(program)
  const out = lastJson(run.stdout)
  const prefixCollision = `${out?.probe_fn ?? ''}`.startsWith('RELAY_PING')
  check('A-2 the relay declares RELAY_FN + the token set, and classify splits functional/ping/session (a RELAY_PING-prefixed token would be swallowed)',
    run.status === 0 && out !== null
    && source.includes('PROBE_FN = b\'RELAY_FN\'')
    && source.includes("PROBES = ((PROBE_PING, 'ping'), (PROBE_FN, 'functional'))")
    && source.includes('def _probe_kind(')
    && out.probe_fn === 'RELAY_FN' && prefixCollision === false
    && out.fn === 'functional' && out.ping === 'ping'
    && out.session === null && out.empty === null
    && out.fn_prefix === true && out.session_prefix === false
    && out.probes.length === 2,
    out === null ? `python exited ${run.status}: ${String(run.stderr).slice(0, 200)}` : `fn=${out.fn} ping=${out.ping} session=${out.session}`)
}

/* ================================================================== *
 * A-4 — RELAY_FN's evidence shape on a FRESH relay: null, never 0
 * ================================================================== */
{
  const relay = await startRelay({ DSH_CUA_MCP_WEDGE_DEADLINE_MS: '800' })
  const { line, evidence } = await askEvidence(relay.port)
  const iso = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(value)
  check('A-4 `RELAY_FN` answers ONE JSON line with every C3 key, and `null` (never a fabricated 0) before the first success',
    line !== null && evidence !== null
    && Object.keys(evidence).sort().join(',') === 'at,attached,busy,childPid,childRestarts,lastSuccessfulCallAgeMs,lastWedgeAt,mode,outstandingRequestAgeMs,wedgeDeadlineMs'
    && evidence.mode === 'functional' && iso(evidence.at)
    && evidence.childPid === null && evidence.childRestarts === 0
    && evidence.lastSuccessfulCallAgeMs === null && evidence.outstandingRequestAgeMs === null
    && evidence.lastWedgeAt === null && evidence.wedgeDeadlineMs === 800
    && evidence.busy === false && evidence.attached === false,
    line === null ? 'no evidence line' : `pid=${evidence?.childPid} success=${evidence?.lastSuccessfulCallAgeMs} busy=${evidence?.busy}`)
  stopRelay(relay)
}

/* ================================================================== *
 * A-3 / A-5 / A-6 / A-7 / A-8 / A-9 / A-10 — THE WEDGE, END TO END
 *
 * One scenario, because the checks are one story: two requests go out to a
 * child that will never answer; the cheap probe must still say RELAY_OK; the
 * watchdog must kill and answer; the next request must be served by a fresh
 * child on the SAME socket.
 * ================================================================== */
{
  const relay = await startRelay({ DSH_CUA_MCP_WEDGE_DEADLINE_MS: '800' }, { wedgeTickets: 1 })
  const client = await openClient(relay.port)
  const sentAt = Date.now()
  client.socket.write(REQUEST(1) + REQUEST(2))

  // The child is wedged and the requests are outstanding: the ACCEPT LOOP is
  // still the cheapest true thing to say, and the R1 pair is exactly this.
  await sleep(300)
  const cheap = await new Promise((resolve) => {
    const socket = net.connect({ port: relay.port, host: '127.0.0.1' })
    let seen = ''
    let settled = false
    const settle = (value) => { if (!settled) { settled = true; try { socket.destroy() } catch {} resolve(value) } }
    const timer = setTimeout(() => settle(null), 2500)
    socket.once('connect', () => socket.write('RELAY_PING'))
    socket.on('data', (chunk) => { seen += chunk.toString('latin1'); if (seen.length >= 8) { clearTimeout(timer); settle(seen) } })
    socket.once('error', () => { clearTimeout(timer); settle(null) })
    socket.once('close', () => { clearTimeout(timer); settle(null) })
  })
  const firstLine = await nextLine(client, 4000)
  const firstAt = Date.now()
  const secondLine = await nextLine(client, 4000)
  const rest = await collectLines(client, 700)
  const answers = [firstLine, secondLine].filter((line) => line !== null).map(parse).filter(Boolean)
  const allLines = [firstLine, secondLine, ...rest].filter((line) => line !== null)
  const errorLines = allLines.map(parse).filter((message) => message?.error !== undefined)

  check('A-3 with a wedged child attached, the cheap probe still answers RELAY_OK (the accept loop is up; the child is not)',
    cheap === 'RELAY_OK', `answer=${cheap === null ? 'none' : cheap}`)

  const joined = errorLines.map((message) => JSON.stringify(message.error?.message ?? '')).join(' ')
  const timing = firstAt - sentAt
  check('A-5 the wedged call is answered `child-wedged` inside the 800 ms deadline, between 0.6 s and 1.6 s',
    errorLines.length >= 1
    && errorLines[0].id === 1
    && errorLines[0].error.code === -32000
    && String(errorLines[0].error.message).startsWith('child-wedged: ')
    && timing >= 600 && timing <= 1600,
    `id=${errorLines[0]?.id} code=${errorLines[0]?.error?.code} at=${timing}ms`)

  check('A-6 two outstanding ids are BOTH answered, ascending, exactly once each (no lost caller, no duplicate)',
    answers.length === 2 && answers[0].id === 1 && answers[1].id === 2
    && errorLines.length === 2
    && joined.includes('child-wedged'),
    `ids=${answers.map((message) => message.id).join(',')} errors=${errorLines.length}`)

  const killedPidsAfterHeal = () => [...readFileSync(relay.logPath, 'utf8').matchAll(/child-start pid=(\d+)/gu)].map((match) => match[1])

  // THE HEAL: same socket, no reconnect, fresh child.
  client.socket.write(REQUEST(3))
  const healedLine = await nextLine(client, 4000)
  const healed = healedLine === null ? null : parse(healedLine)
  const { evidence } = await askEvidence(relay.port)
  // ...and only NOW can the log have gone quiet: the heal is what spawns the
  // second child, so a log read before it can only ever see one start.
  const startedPids = killedPidsAfterHeal()
  const wedgeLines = readFileSync(relay.logPath, 'utf8').split('\n').filter((line) => / wedge id=1 age=\d+ child=/u.test(line))

  check('A-7 the log shows TWO child starts with different pids and one `wedge id=1` line (the kill is the reported cause)',
    startedPids.length === 2 && startedPids[0] !== startedPids[1] && wedgeLines.length === 1,
    `pids=${startedPids.join(',')} wedge=${wedgeLines.length}`)

  check('A-8 the next `RELAY_FN` reports childRestarts:1 and the new child pid (one wedge == one restart)',
    evidence !== null && evidence.childRestarts === 1
    && typeof evidence.childPid === 'number'
    && startedPids.length === 2 && String(evidence.childPid) === startedPids[1],
    `restarts=${evidence?.childRestarts} pid=${evidence?.childPid} starts=${startedPids.join(',')}`)

  check('A-9 the request AFTER the wedge is served by a fresh child on the SAME socket (the lane heals in place)',
    healed !== null && healed.id === 3 && healed.result?.ok === true,
    healedLine === null ? 'no answer' : healedLine.slice(0, 120))

  const idCounts = new Map()
  for (const line of allLines) {
    const message = parse(line)
    if (message?.error !== undefined) idCounts.set(message.id, (idCounts.get(message.id) ?? 0) + 1)
  }
  check('A-10 no duplicate answer: exactly ONE error line per id',
    idCounts.size >= 1 && [...idCounts.values()].every((count) => count === 1) && (idCounts.get(1) ?? 0) === 1,
    [...idCounts.entries()].map(([id, count]) => `${id}x${count}`).join(','))

  try { client.socket.destroy() } catch {}
  stopRelay(relay)
}

/* ================================================================== *
 * A-11 — the kill switch: deadline 0 disables the watchdog entirely
 * ================================================================== */
{
  const relay = await startRelay({ DSH_CUA_MCP_WEDGE_DEADLINE_MS: '0' }, { wedgeTickets: 9 })
  const client = await openClient(relay.port)
  client.socket.write(REQUEST(1))
  await sleep(350)
  const before = (await askEvidence(relay.port)).evidence
  const lines = await collectLines(client, 1500)
  const after = (await askEvidence(relay.port)).evidence
  check('A-11 `DSH_CUA_MCP_WEDGE_DEADLINE_MS=0` disables the watchdog: no answer in 1.5 s and the child pid never moves',
    lines.length === 0
    && typeof before?.childPid === 'number' && after?.childPid === before.childPid
    && after?.childRestarts === 0 && after?.wedgeDeadlineMs === 0
    && after?.outstandingRequestAgeMs !== null,
    `lines=${lines.length} pid=${before?.childPid}->${after?.childPid} restarts=${after?.childRestarts} deadline=${after?.wedgeDeadlineMs}`)
  try { client.socket.destroy() } catch {}
  stopRelay(relay)
}

/* ================================================================== *
 * A-12 / A-13 — the bridge is still RAW (accounting changed no byte)
 * ================================================================== */
{
  const relay = await startRelay({ DSH_CUA_MCP_WEDGE_DEADLINE_MS: '800' }, { wedgeTickets: 0 })
  const client = await openClient(relay.port)
  const rxPath = path.join(relay.dir, 'child-rx.bin')
  const notJson = 'NOT-JSON-LINE-1234\n'
  const request = '{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n'
  client.socket.write(notJson)
  await sleep(1100)                                   // past the 800 ms deadline
  const silent = await collectLines(client, 50)
  const evidence = (await askEvidence(relay.port)).evidence
  check('A-12 a non-JSON line is forwarded and pairs NOTHING (no id, no wedge, no answer)',
    silent.length === 0 && evidence !== null
    && evidence.outstandingRequestAgeMs === null
    && evidence.childRestarts === 0,
    `lines=${silent.length} outstanding=${evidence?.outstandingRequestAgeMs} restarts=${evidence?.childRestarts}`)

  client.socket.write(request)
  const answer = await nextLine(client, 4000)
  const parsed = answer === null ? null : parse(answer)
  const rx = existsSync(rxPath) ? readFileSync(rxPath, 'utf8') : ''
  check('A-13 the child received every byte EXACTLY as sent (raw bridge) and answered the request',
    rx === notJson + request
    && parsed !== null && parsed.id === 7 && Array.isArray(parsed.result?.tools) && parsed.result.tools.length === 1,
    `rx=${JSON.stringify(rx.slice(0, 60))}${rx.length > 60 ? '…' : ''} id=${parsed?.id} tools=${parsed?.result?.tools?.length}`)
  try { client.socket.destroy() } catch {}
  stopRelay(relay)
}

/* ================================================================== *
 * A-14 / A-15 — facts re-measure (R8) and carry the relay counters
 * ================================================================== */
{
  const relay = await startRelay({ DSH_CUA_MCP_WEDGE_DEADLINE_MS: '800', DSH_CUA_MCP_FACTS_REFRESH_MS: '300' }, { wedgeTickets: 0 })
  const factsPath = path.join(relay.dir, 'cua-desktop-facts.json')
  const client = await openClient(relay.port)
  client.socket.write(REQUEST(1, 'tools/list'))
  const answered = await nextLine(client, 4000)
  const appeared = await waitUntil(() => existsSync(factsPath), 8000)
  const stamps = new Set()
  let elapsed = 0
  if (appeared) {
    stamps.add(statSync(factsPath).mtimeMs)
    const started = Date.now()
    // A 300 ms interval plus one measurement pass (~4 bounded python probes) is
    // the period; the window is generous because a loaded CI box may take
    // seconds to start four interpreters, and the contract under test is that
    // the file KEEPS being rewritten - not the exact period.
    while (Date.now() - started < 6000 && stamps.size < 4) {
      await sleep(40)
      try { stamps.add(statSync(factsPath).mtimeMs) } catch {}
    }
    elapsed = Date.now() - started
  }
  const changes = stamps.size === 0 ? 0 : stamps.size - 1
  const first = appeared ? JSON.parse(readFileSync(factsPath, 'utf8')) : null
  check('A-14 with DSH_CUA_MCP_FACTS_REFRESH_MS=300 the facts file is REWRITTEN (>= 3 mtime changes) and says refreshMs:300',
    appeared !== null && changes >= 3 && first?.refreshMs === 300,
    `changes=${changes} elapsed=${elapsed}ms refreshMs=${first?.refreshMs} answered=${answered !== null}`)

  const withPid = await waitUntil(() => {
    try {
      const data = JSON.parse(readFileSync(factsPath, 'utf8'))
      return typeof data.relay?.childPid === 'number' ? data : null
    } catch { return null }
  }, 6000)
  const relayFacts = withPid?.relay ?? null
  const keys = relayFacts === null ? [] : Object.keys(relayFacts).sort().join(',')
  check('A-15 the facts file carries the C3 counters (childPid/childRestarts/lastSuccessfulCallAgeMs/outstandingRequestAgeMs/lastWedgeAt), null where unknown, and no RELAY_FN-only lane keys',
    relayFacts !== null
    && keys === 'at,childPid,childRestarts,lastSuccessfulCallAgeMs,lastWedgeAt,outstandingRequestAgeMs,wedgeDeadlineMs'
    && typeof relayFacts.childPid === 'number'
    && relayFacts.childRestarts === 0
    && typeof relayFacts.lastSuccessfulCallAgeMs === 'number' && relayFacts.lastSuccessfulCallAgeMs >= 0
    && relayFacts.outstandingRequestAgeMs === null
    && relayFacts.lastWedgeAt === null
    && typeof relayFacts.wedgeDeadlineMs === 'number',
    relayFacts === null ? 'no facts pass carried a child pid' : `keys=${keys} pid=${relayFacts.childPid} last=${relayFacts.lastSuccessfulCallAgeMs} out=${relayFacts.outstandingRequestAgeMs}`)
  try { client.socket.destroy() } catch {}
  stopRelay(relay)
}

/* ================================================================== *
 * A-16 / A-17 — the frozen refresh ladder (C13), asserted by import
 * ================================================================== */
{
  const program = `${LOAD_MODULE}
healthy = {'measured': True, 'win32ui': True, 'uiaLane': True, 'workDirWritable': True}
out = {'healthy': mod.facts_refresh_interval(healthy), 'suspect': {}}
for key in ('measured', 'win32ui', 'uiaLane', 'workDirWritable'):
    falsey = dict(healthy)
    falsey[key] = False
    out['suspect'][key] = mod.facts_refresh_interval(falsey)
    unknown = dict(healthy)
    unknown[key] = None
    out['suspect'][key + ':null'] = mod.facts_refresh_interval(unknown)
print(json.dumps(out))`
  const run = python(program)
  const out = lastJson(run.stdout)
  check('A-16 `facts_refresh_interval(healthy)` is FACTS_FULL_REFRESH_MS (900000) — a healthy guest is not re-probed every minute',
    run.status === 0 && out?.healthy === 900000, `healthy=${out?.healthy}`)

  const suspect = out?.suspect ?? {}
  const measured = Object.keys(suspect).length === 8 ? Object.values(suspect) : []
  check('A-17 `facts_refresh_interval` is FACTS_REFRESH_MS (60000) for EACH of the four suspect facts, false OR unknown',
    measured.length === 8 && measured.every((value) => value === 60000),
    Object.entries(suspect).map(([key, value]) => `${key}=${value}`).join(' '))
}

/* ================================================================== *
 * A-18 — the deadline clamps (C4 numbers)
 * ================================================================== */
{
  const program = `${LOAD_MODULE}
values = {}
for raw in ('5', '999999', '0', ''):
    os.environ['DSH_CUA_MCP_WEDGE_DEADLINE_MS'] = raw
    values[raw if raw != '' else 'blank'] = mod.wedge_deadline_ms()
os.environ['DSH_CUA_MCP_WEDGE_DEADLINE_MS'] = 'not-a-number'
values['garbage'] = mod.wedge_deadline_ms()
os.environ.pop('DSH_CUA_MCP_WEDGE_DEADLINE_MS', None)
values['unset'] = mod.wedge_deadline_ms()
print(json.dumps(values))`
  const run = python(program)
  const out = lastJson(run.stdout)
  check('A-18 `wedge_deadline_ms()` clamps 5 -> 200, 999999 -> 600000, 0 -> 0 (off), blank -> 20000, garbage -> 20000',
    run.status === 0 && out !== null
    && out['5'] === 200 && out['999999'] === 600000 && out['0'] === 0
    && out.blank === 20000 && out.garbage === 20000 && out.unset === 20000,
    out === null ? `python exited ${run.status}` : JSON.stringify(out))
}

/* ================================================================== *
 * A-19 — A RESULT BIGGER THAN THE SCAN CAP IS NOT A WEDGE (PRE defect #2)
 *
 * THE DEFECT THIS CLOSES, measured: a 1,300,063-byte result line passes the
 * relay's 1 MiB LineScan cap. The old scan dropped the line, the fragments of
 * its tail were then parsed as if they were a line (they are not JSON), the
 * request id never popped from `pending` — and 20 s later the watchdog killed a
 * perfectly HEALTHY child and wrote a `child-wedged` error for an id that the
 * client had already received a successful result for. Three wrongs in one:
 * a live process terminated, a duplicate id on the wire, and a false claim that
 * the call's effect was UNKNOWN.
 *
 * The contract is "never kill a healthy child for a bookkeeping artifact", so
 * this check pins all four halves: the bytes cross byte-exactly, no error
 * arrives, the pid never moves, and the evidence says `null` (pairing honest)
 * rather than ageing an id it can no longer see. Pairing must then RESUME: a
 * second, ordinary request after the huge one has to be paired and answered.
 * ================================================================== */
{
  const BIG_LINE = 1300063
  const relay = await startRelay({ DSH_CUA_MCP_WEDGE_DEADLINE_MS: '800' },
    { wedgeTickets: 0, bigResult: BIG_LINE })
  const client = await openClient(relay.port)
  // The request goes out FIRST: classify() drops a connection that says nothing
  // within 2 s, so the session (and its child) only exists once bytes arrive.
  client.socket.write(REQUEST(1))
  const before = await waitUntil(async () => {
    const evidence = (await askEvidence(relay.port)).evidence
    return typeof evidence?.childPid === 'number' ? evidence : null
  }, 5000)
  const bigLine = await nextLine(client, 15000)
  const big = bigLine === null ? null : parse(bigLine)
  const bigBytes = bigLine === null ? 0 : Buffer.byteLength(bigLine, 'utf8')
  // Past the deadline the watchdog would have fired had the id survived the cap.
  await sleep(1300)
  const afterWedge = await collectLines(client, 60)
  const evidence = (await askEvidence(relay.port)).evidence
  const starts = [...readFileSync(relay.logPath, 'utf8').matchAll(/child-start pid=(\d+)/gu)].map((match) => match[1])
  const wedges = readFileSync(relay.logPath, 'utf8').split('\n').filter((line) => / wedge id=/u.test(line))
  // ...and pairing is not merely silent, it RESUMES on the next line.
  client.socket.write(REQUEST(2))
  const nextLine2 = await nextLine(client, 4000)
  const next = nextLine2 === null ? null : parse(nextLine2)

  check('A-19 a 1.3 MB result crosses the 1 MiB scan cap byte-exactly, arms NO wedge, kills NO child, and pairing resumes on the next request',
    big !== null && big.id === 1 && big.result?.ok === true
    && bigBytes >= BIG_LINE
    // not merely "a big line arrived": every pad byte survived the bridge
    && typeof big.result?.pad === 'string' && big.result.pad.length === BIG_LINE
    && afterWedge.length === 0
    && evidence !== null
    && evidence.childPid === before?.childPid
    && evidence.childRestarts === 0
    && evidence.outstandingRequestAgeMs === null
    && evidence.attached === true
    && starts.length === 1
    && wedges.length === 0
    && next !== null && next.id === 2 && next.result?.ok === true,
    `line=${bigBytes}B id=${big?.id} after=${afterWedge.length} pid=${before?.childPid}->${evidence?.childPid} restarts=${evidence?.childRestarts} outstanding=${evidence?.outstandingRequestAgeMs} starts=${starts.length} wedges=${wedges.length} next=${next?.id}`)
  try { client.socket.destroy() } catch {}
  stopRelay(relay)
}

/* ================================================================== *
 * A-20 — THE POLL/WRITE WINDOW NEVER CLOSES THE SESSION (PRE defect #9)
 *
 * `serve_client` used to check `proc.poll()` and then write. The watchdog kills
 * the child BETWEEN those two statements (it clears `self.proc` first), so the
 * write failed on a dead fd, the pump `break`ed, and `handle()`'s finally closed
 * the client — the exact opposite of "the client socket is never closed" and
 * "the lane heals in place", and it happens precisely when a wedge is being
 * repaired, i.e. when the client most needs its session.
 *
 * This check drives `Relay._pump_out` itself, deterministically, because the
 * race cannot be scheduled from outside: a dead child and a live-but-unwritable
 * fd must both end with the SAME chunk written once to the RESPAWNED child, and
 * a lane that cannot spawn must still give up instead of spinning.
 * ================================================================== */
{
  const program = `${LOAD_MODULE}
import tempfile

tmp = tempfile.mkdtemp()
sink = os.path.join(tmp, 'respawned.bin')
with open(sink, 'wb'):
    pass


class FakePipe(object):
    def __init__(self, fd):
        self._fd = fd

    def fileno(self):
        return self._fd


class FakeProc(object):
    def __init__(self, pid, alive, fd):
        self.pid = pid
        self._alive = alive
        self.stdin = FakePipe(fd)

    def poll(self):
        return None if self._alive else 1


relay = mod.Relay(47999)
spawns = {'n': 0}
live_fd = os.open(sink, os.O_RDWR)
live = FakeProc(2222, True, live_fd)


def spawn_live():
    spawns['n'] += 1
    return live


# 1) the child is ALREADY dead when the pump looks (the wedge was just killed)
relay.child = spawn_live
dead = FakeProc(1111, False, live_fd)
out_dead = relay._pump_out(dead, b'{"id":1}\\n')
dead_ok = out_dead is live and spawns['n'] == 1

# 2) the child still LOOKS alive but its fd is already broken (the race itself)
readonly = os.open(sink, os.O_RDONLY)          # a write to this fd always fails
broken = FakeProc(3333, True, readonly)
out_broken = relay._pump_out(broken, b'{"id":2}\\n')
broken_ok = out_broken is live and spawns['n'] == 2
os.close(readonly)

os.close(live_fd)
written = open(sink, 'rb').read()

# 3) a lane that cannot spawn must END the session, not loop forever
relay.child = lambda: None
gave_up = relay._pump_out(FakeProc(4444, False, live_fd), b'{"id":3}\\n') is None
print(json.dumps({
    'dead': dead_ok,
    'broken': broken_ok,
    'gave_up': gave_up,
    'written': written.decode('ascii', 'replace'),
    'spawns': spawns['n'],
}))`
  const run = python(program)
  const out = lastJson(run.stdout)
  check('A-20 a dead fd in the poll/write window is retried against the RESPAWNED child (same chunk, once) instead of closing the session',
    run.status === 0 && out !== null
    && out.dead === true && out.broken === true && out.gave_up === true
    && out.written === '{"id":1}\n{"id":2}\n'
    && out.spawns === 2,
    out === null ? `python exited ${run.status}: ${String(run.stderr).slice(0, 200)}` : `dead=${out.dead} broken=${out.broken} gaveUp=${out.gave_up} written=${JSON.stringify(out.written)} spawns=${out.spawns}`)
}

/* ================================================================== *
 * A-21 — A CRASHED CHILD'S ID MUST NOT KILL ITS REPLACEMENT (re-PRE, MED)
 *
 * THE DEFECT THIS CLOSES, and why A-20 could not see it: A-20 stubs
 * `relay.child`, so the REAL respawn bookkeeping was never driven. A real child
 * that dies with a request outstanding leaves that id in `pending` (its reader
 * thread may not have run its EOF cleanup — and a respawn wins that race by
 * design, because the pump heals as soon as it polls the death). 20 s later the
 * watchdog then kills the HEALTHY replacement, which never received those bytes,
 * and writes `child-wedged` for a call the replacement cannot possibly have
 * been handling. That is the "never kill a healthy child for a bookkeeping
 * artifact" invariant broken on the one path still open.
 *
 * The fixture makes the state reachable on purpose: the crashed child leaves a
 * grandchild holding its stdout pipe, so the relay's reader stays blocked (no
 * EOF, no reader-side cleanup) while the pump notices the death and respawns
 * for real. That is precisely the race, made deterministic.
 *
 * The fix is to CLEAR the dead child's ids on respawn (never to answer them: a
 * replay of the same chunk to the replacement would then produce a duplicate
 * id). So this check asserts, in one story: the replacement answers the next
 * request, no `child-wedged` is ever written for the dead child's id, the log
 * says WHICH decision was taken, the replacement is still the live pid at the
 * end, and a third request is served normally.
 * ================================================================== */
{
  const relay = await startRelay({ DSH_CUA_MCP_WEDGE_DEADLINE_MS: '800' },
    { wedgeTickets: 0, crashTickets: 1 })
  const client = await openClient(relay.port)
  const startedAt = Date.now()
  client.socket.write(REQUEST(1))          // delivered to child A, which dies unanswered
  await sleep(250)                         // A is dead; its reader is held open on purpose
  client.socket.write(REQUEST(2))          // the pump heals: the REAL child() spawns B
  const lineFor2 = await nextLine(client, 6000)
  const second = lineFor2 === null ? null : parse(lineFor2)
  // ...past the 800 ms deadline id 1 was registered at: the unfixed code kills B here.
  const left = 1500 - (Date.now() - startedAt)
  if (left > 0) await sleep(left)
  const spurious = await collectLines(client, 80)
  const evidence = (await askEvidence(relay.port)).evidence
  const log = readFileSync(relay.logPath, 'utf8')
  const starts = [...log.matchAll(/child-start pid=(\d+)/gu)].map((match) => match[1])
  const wedgeLines = log.split('\n').filter((line) => / wedge id=/u.test(line))
  const droppedLines = log.split('\n').filter((line) => /pending-dropped/.test(line))
  // the lane is still healthy: B serves a third request
  client.socket.write(REQUEST(3))
  const lineFor3 = await nextLine(client, 4000)
  const third = lineFor3 === null ? null : parse(lineFor3)

  check('A-21 a crashed child\'s id never arms a wedge: the REAL respawn forgets it (logged), the healthy replacement is never killed, and the session carries on',
    second !== null && second.id === 2 && second.result?.ok === true
    && spurious.length === 0
    && starts.length === 2 && starts[0] !== starts[1]
    && typeof evidence?.childPid === 'number' && String(evidence.childPid) === starts[1]
    && evidence.childRestarts === 1
    && evidence.attached === true
    && evidence.outstandingRequestAgeMs === null
    && wedgeLines.length === 0
    && droppedLines.length === 1
    && /NOT answered/.test(droppedLines[0] || '')
    && /outstandingRequestAgeMs now reports null/.test(droppedLines[0] || '')
    && third !== null && third.id === 3 && third.result?.ok === true,
    `second=${second?.id} spurious=${spurious.length} starts=${starts.join(',')} pid=${evidence?.childPid} restarts=${evidence?.childRestarts} wedges=${wedgeLines.length} dropped=${droppedLines.length} third=${third?.id}`)
  try { client.socket.destroy() } catch {}
  stopRelay(relay)
}

/* ================================================================== *
 * A-22 — ONE WRITER ON THE CLIENT SOCKET (JURY co-juror 1, J1)
 *
 * Two threads write to the client: the child's reader (result bytes) and the
 * watchdog (the child-wedged answer). Unserialised, `sendall` can put the small
 * answer INSIDE a partly written result under backpressure — one unparsable
 * line carrying both objects, which the host parses as nothing and drops, so
 * the caller loses the result AND the error.
 *
 * The test is deterministic rather than racy: a 4 MiB payload on a socketpair
 * whose peer is not reading yet must be IN FLIGHT (blocked in sendall) when a
 * second, tiny write is attempted. That second write may not complete while the
 * first message is unfinished; when both are drained, the byte stream must be
 * two contiguous blocks, never interleaved.
 * ================================================================== */
{
  const program = `${LOAD_MODULE}
import socket, threading, time

relay = mod.Relay(47999)
left, right = socket.socketpair()
big = b'A' * (4 * 1024 * 1024)
small = b'B' * 256
done = []
lock = threading.Lock()


def send(payload, name):
    ok = relay._send_to_client(left, payload)
    with lock:
        done.append((name, ok))


first = threading.Thread(target=send, args=(big, 'big'))
first.daemon = True
first.start()
time.sleep(0.40)                      # the big write is blocked on a full socket
second = threading.Thread(target=send, args=(small, 'small'))
second.daemon = True
second.start()
time.sleep(0.40)
with lock:
    during = [name for name, _ok in done]
# now drain: both writes can finish
received = b''
right.settimeout(5.0)
while len(received) < len(big) + len(small):
    try:
        chunk = right.recv(262144)
    except socket.timeout:
        break
    if not chunk:
        break
    received += chunk
first.join(5.0)
second.join(5.0)
with lock:
    after = sorted(name for name, _ok in done)
contiguous = received == big + small or received == small + big
print(json.dumps({
    'during': during,
    'after': after,
    'contiguous': contiguous,
    'big_bytes': received.count(b'A'),
    'small_bytes': received.count(b'B'),
    'total': len(received),
}))
try:
    left.close()
    right.close()
except Exception:
    pass`
  const run = python(program)
  const out = lastJson(run.stdout)
  check('A-22 a second writer cannot enter while a message is in flight (one contiguous result block, then one answer block — never interleaved)',
    run.status === 0 && out !== null
    && out.during.includes('small') === false
    && out.after.join(',') === 'big,small'
    && out.contiguous === true
    && out.big_bytes === 4 * 1024 * 1024 && out.small_bytes === 256,
    out === null ? `python exited ${run.status}: ${String(run.stderr).slice(0, 200)}` : `during=[${out.during}] after=[${out.after}] contiguous=${out.contiguous} A=${out.big_bytes} B=${out.small_bytes}`)
}

/* ================================================================== *
 * A-24 — THE WEDGE IS BOOKED BEFORE THE ANSWERS (JURY co-juror 1, J3)
 *
 * `childRestarts`/`lastWedgeAt` used to be written AFTER the answer loop. A
 * client that stopped reading blocked those sends, so the doctor saw
 * `childRestarts:0` / `lastWedgeAt:null` beside a `child-killed` log line —
 * "no wedge ever happened" — exactly when the lane was at its worst.
 *
 * The counters are read from INSIDE `sendall`, i.e. while the answer is in
 * flight, so the assertion is about the ordering itself, not about a timing
 * window.
 * ================================================================== */
{
  const program = `${LOAD_MODULE}
import time

relay = mod.Relay(47999)
relay.pending = {7: time.monotonic()}
seen = []


class Stalling(object):
    def sendall(self, data):
        # the answer is being written RIGHT NOW: what does the doctor read?
        seen.append((relay.child_restarts, relay.last_wedge_at))
        raise OSError('client gone')


relay.client = Stalling()
relay._answer_wedged([7], 900, 4321)
print(json.dumps({
    'seen': seen,
    'restarts_after': relay.child_restarts,
    'wedge_after': relay.last_wedge_at,
    'pending_after': len(relay.pending),
}))`
  const run = python(program)
  const out = lastJson(run.stdout)
  const iso = typeof out?.wedge_after === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(out.wedge_after)
  check('A-24 childRestarts/lastWedgeAt are already booked WHILE the answer is being written (a blocked client cannot hide the wedge)',
    run.status === 0 && out !== null
    && Array.isArray(out.seen) && out.seen.length === 1
    && out.seen[0][0] === 1 && typeof out.seen[0][1] === 'string'
    && out.restarts_after === 1 && iso
    && out.pending_after === 0,
    out === null ? `python exited ${run.status}: ${String(run.stderr).slice(0, 200)}` : `seen=${JSON.stringify(out.seen)} after=${out.restarts_after}/${out.wedge_after} pending=${out.pending_after}`)
}

/* ================================================================== *
 * A-25 — EXACTLY ONCE, AND ONLY A REAL KILL BOOKS A RESTART (JURY J7)
 *
 * Two defects in one path:
 *   (a) the ids were answered from a SNAPSHOT. If the child answered an id
 *       while the watchdog was killing it, the client got a second answer for
 *       that id — a duplicate on the wire, and C4.5 says exactly once;
 *   (b) a fire with no child to kill (`pid is None`) still booked a restart,
 *       so one restart was counted twice (1 -> 2) once the spawn incremented.
 * ================================================================== */
{
  const program = `${LOAD_MODULE}
import time

relay = mod.Relay(47999)
writes = []


class Sink(object):
    def sendall(self, data):
        writes.append(data.decode('ascii', 'replace'))


relay.client = Sink()
# (a) the child answers id 5 while the watchdog is deciding: pop it exactly as
# the response path does, then hand the watchdog the stale snapshot.
relay.pending = {5: time.monotonic()}
with relay.pending_lock:
    del relay.pending[5]
relay._answer_wedged([5], 900, 1111)
duplicates = [line for line in writes if '"id": 5' in line or '"id":5' in line]
after_stale = (len(writes), relay.child_restarts)

# (b) a fire with NO child killed must not book a restart
relay.pending = {6: time.monotonic()}
relay._answer_wedged([6], 900, None)
print(json.dumps({
    'duplicates': len(duplicates),
    'writes_after_stale': after_stale[0],
    'restarts_after_stale': after_stale[1],
    'writes_total': len(writes),
    'restarts_total': relay.child_restarts,
    'wedge_at': relay.last_wedge_at,
    'pending_after': len(relay.pending),
    'answered_6': any('"id": 6' in line or '"id":6' in line for line in writes),
}))`
  const run = python(program)
  const out = lastJson(run.stdout)
  check('A-25 an id the child already answered is NOT answered again, and a fire with no kill books no restart (exactly once, no double count)',
    run.status === 0 && out !== null
    && out.duplicates === 0 && out.writes_after_stale === 0 && out.restarts_after_stale === 1
    && out.writes_total === 1 && out.restarts_total === 1
    && out.answered_6 === true
    && out.pending_after === 0,
    out === null ? `python exited ${run.status}: ${String(run.stderr).slice(0, 200)}` : `dups=${out.duplicates} stale=${out.writes_after_stale}/${out.restarts_after_stale} total=${out.writes_total}/${out.restarts_total} pending=${out.pending_after}`)
}

/* ================================================================== *
 * A-23 — AN ANSWERED CALL STOPS BEING OUTSTANDING IMMEDIATELY (J2)
 *
 * The improbable-but-real sequence the jury measured: the child ANSWERS, the
 * reader starts forwarding a multi-megabyte result, the client stops reading,
 * `sendall` blocks — and the id whose answer sits in the socket buffer keeps
 * aging, so the watchdog kills a HEALTHY child that already executed the call
 * (and later ids get UNKNOWN for work that was done).
 *
 * The fix is ORDERING, so the check pins the order directly: the real
 * `_read_child` is driven over a real pipe with a client stub that records what
 * `pending` holds AT THE MOMENT the bytes are forwarded. With the fix the id is
 * already gone; with the old order it is still there. Socket buffers cannot
 * hide that difference.
 *
 * The end-to-end half then exercises the same path through the real relay with
 * a paused client and a 12 MB result: nothing may be killed, and the whole
 * result must still arrive once the client reads again.
 * ================================================================== */
{
  const program = `${LOAD_MODULE}
import os, threading, time

relay = mod.Relay(47999)
rfd, wfd = os.pipe()


class _Out(object):
    def __init__(self, fd):
        self._fd = fd

    def fileno(self):
        return self._fd


class FakeProc(object):
    def __init__(self, fd):
        self.pid = 4242
        self.stdout = _Out(fd)

    def wait(self, timeout=None):
        return 0

    def poll(self):
        return 0


class Sink(object):
    def __init__(self):
        self.writes = []
        self.pending_at_write = []

    def sendall(self, data):
        with relay.pending_lock:
            self.pending_at_write.append(sorted(relay.pending.keys()))
        self.writes.append(data)

    def shutdown(self, how):
        pass

    def close(self):
        pass


proc = FakeProc(rfd)
sink = Sink()
relay.proc = proc
relay.client = sink
with relay.pending_lock:
    relay.pending[1] = time.monotonic()
os.write(wfd, b'{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\\n')
os.close(wfd)
relay._read_child(proc)                 # the real pump: read -> observe -> send
forwarded = b''.join(sink.writes)
try:
    parsed = json.loads(forwarded.decode('ascii').split('\\n')[0])
except Exception:
    parsed = {}
print(json.dumps({
    'pending_at_write': sink.pending_at_write,
    'writes': len(sink.writes),
    'forwarded_bytes': len(forwarded),
    'forwarded_ok': parsed.get('id') == 1 and parsed.get('result', {}).get('ok') is True,
    'success_marked': relay.last_success_at is not None,
}))`
  const order = python(program)
  const ordered = lastJson(order.stdout)

  const BIG = 12 * 1000 * 1000
  const relay = await startRelay({ DSH_CUA_MCP_WEDGE_DEADLINE_MS: '800' },
    { wedgeTickets: 0, bigResult: BIG })
  const client = await openClient(relay.port)
  client.socket.pause()                    // a client that stops reading
  client.socket.write(REQUEST(1))
  await sleep(1500)                        // well past the 800 ms deadline
  const evidence = (await askEvidence(relay.port)).evidence
  const stalls = readFileSync(relay.logPath, 'utf8')
  const starts = [...stalls.matchAll(/child-start pid=(\d+)/gu)].map((match) => match[1])
  const wedgeLines = stalls.split('\n').filter((line) => / wedge id=/u.test(line))
  client.socket.resume()                   // ...and reads again
  const bigLine = await nextLine(client, 30000)
  const big = bigLine === null ? null : parse(bigLine)
  client.socket.write(REQUEST(2))
  const afterLine = await nextLine(client, 5000)
  const after = afterLine === null ? null : parse(afterLine)

  check('A-23 an answered call stops being outstanding BEFORE the bytes are forwarded: a stalled client cannot arm a wedge, the healthy child survives, and the full 12 MB result still arrives',
    order.status === 0 && ordered !== null
    // THE ORDER: during the forward, the answered id is already out of pending,
    // the bytes still went out, and the success was dated afterwards.
    && Array.isArray(ordered.pending_at_write) && ordered.pending_at_write.length >= 1
    && ordered.pending_at_write.every((ids) => Array.isArray(ids) && ids.length === 0)
    && ordered.forwarded_bytes > 0 && ordered.forwarded_ok === true
    && ordered.success_marked === true
    && big !== null && big.id === 1 && big.result?.ok === true
    && typeof big.result?.pad === 'string' && big.result.pad.length === BIG
    && starts.length === 1
    && typeof evidence?.childPid === 'number' && String(evidence.childPid) === starts[0]
    && evidence.childRestarts === 0
    && evidence.outstandingRequestAgeMs === null
    && wedgeLines.length === 0
    && after !== null && after.id === 2 && after.result?.ok === true,
    ordered === null
      ? `order probe exited ${order.status}: ${String(order.stderr).slice(0, 160)}`
      : `pendingAtWrite=${JSON.stringify(ordered.pending_at_write)} forwarded=${ordered.forwarded_bytes} success=${ordered.success_marked} pad=${big?.result?.pad?.length} starts=${starts.length} pid=${evidence?.childPid} restarts=${evidence?.childRestarts} outstanding=${evidence?.outstandingRequestAgeMs} wedges=${wedgeLines.length} after=${after?.id}`)
  try { client.socket.destroy() } catch {}
  stopRelay(relay)
}

/* ================================================================== *
 * A-26 — A >1 MiB REQUEST LINE DEGRADES PAIRING LOUDLY (J8)
 *
 * `capture_window`-class tools take big params the other way too: a caller can
 * send a multi-megabyte request line. The scan drops it at the cap, so its id
 * was never registered and the call can NEVER be watched for a wedge on the
 * guest side — the model waits out the host timer instead of getting
 * `child-wedged`. The response path already said so; the request path was
 * silent. It must now say so on the SAME `pairing-degraded` path, while still
 * bridging every byte and without forgetting other calls' ids.
 * ================================================================== */
{
  const relay = await startRelay({ DSH_CUA_MCP_WEDGE_DEADLINE_MS: '800' }, { wedgeTickets: 0 })
  const client = await openClient(relay.port)
  const sent = `{"jsonrpc":"2.0","id":41,"method":"tools/call","params":{"pad":"${'x'.repeat(1300000)}"}}\n`
  client.socket.write(sent)
  const answerLine = await nextLine(client, 15000)
  const answer = answerLine === null ? null : parse(answerLine)
  const evidence = (await askEvidence(relay.port)).evidence
  const log = readFileSync(relay.logPath, 'utf8')
  const degraded = log.split('\n').filter((line) => /pairing-degraded/.test(line))
  const rx = existsSync(path.join(relay.dir, 'child-rx.bin')) ? readFileSync(path.join(relay.dir, 'child-rx.bin'), 'utf8') : ''
  check('A-26 a 1.3 MB REQUEST line is bridged byte-exactly, answered, and its un-pairable id is reported on the pairing-degraded path (not silently ignored)',
    answer !== null && answer.id === 41 && answer.result?.ok === true
    && rx === sent
    && degraded.length === 1
    && /a request line passed the/u.test(degraded[0] || '')
    && /cannot be watched for a wedge/u.test(degraded[0] || '')
    && evidence !== null && evidence.outstandingRequestAgeMs === null && evidence.childRestarts === 0,
    `answer=${answer?.id} rx=${rx.length} degraded=${degraded.length} outstanding=${evidence?.outstandingRequestAgeMs}`)
  try { client.socket.destroy() } catch {}
  stopRelay(relay)
}

/* ================================================================== */
for (const client of live.clients) { try { client.socket.destroy() } catch {} }
for (const relay of live.relays) stopRelay(relay)

if (checks !== 26) {
  console.log(`\nrelay wedge: FAIL — the suite emitted ${checks} check(s), the contract is 26`)
  process.exit(1)
}
if (failures > 0) {
  console.log(`\nrelay wedge: FAIL — ${failures} of ${checks} check(s) failed`)
  process.exit(1)
}
console.log(`\nrelay wedge: PASS — ${checks} check(s)`)
process.exit(0)
