/**
 * 19-payload-staging.mjs — the payload staging plan: measure, append, decode, verify, register.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { EventEmitter, REPO, check, mkdtempSync, net, os, path, readFileSync, rmSync, spawn, spawnSync, winMcpApi, writeFileSync } from './harness.mjs'


/* ================================================================== *
 * COLD-BOOT ROUND (6th) — PACKAGE A: win-mcp.js, CB-1..CB-17
 *
 * RC-1..RC-4, transport half. The four behaviours, in the order the plan
 * lands them: the guard staging carrier and its five-value outcome (CB-1..CB-5,
 * WP-1B), the boot-race window and its ladder (CB-6..CB-9, CB-17, WP-2A),
 * `probe-unsupported` and the third producer of payload.skew (CB-10..CB-13,
 * WP-3A), and the language-free facts-file-absent ladder (CB-14..CB-16, WP-4A).
 * ================================================================== */
{
  const UP = winMcpApi
  const HEX_A = 'a'.repeat(64)
  const HEX_B = 'b'.repeat(64)
  const HEX_C = 'c'.repeat(64)
  const guardSource = typeof UP.guardExpectedHashSource === 'function' ? UP.guardExpectedHashSource() : null
  const guardBytes = guardSource === null ? null : readFileSync(guardSource)
  const expectedGuard = typeof UP.expectedGuardHash === 'function' ? UP.expectedGuardHash() : null
  // The real payload on this checkout; a synthetic carrier of the SAME base64
  // length on a bundle without `docker/`, so the geometry is asserted either way.
  const guardBase64 = guardBytes === null ? 'A'.repeat(43456) : guardBytes.toString('base64')
  const planExpected = expectedGuard ?? HEX_A

  /* ---- CB-1: THE PLAN'S ORDER AND GEOMETRY -------------------------- */
  // C2 rule 2/3/5 + D2/D4: measure → 8 appends → decode → verify → register.
  // The APPENDS are `cmd` children (≈0.15 s) and the DECISIONS are PowerShell
  // (≈2.9 s) — the mix is what makes the plan fit its budget (CB-20).
  const stagePlan = UP.relayGuardStagePlan({ base64: guardBase64, expectedHash: planExpected, expectedRelay: HEX_B, taskPresent: false, port: 47999 })
  const stageKinds = stagePlan.map((step) => step.kind)
  const appends = stagePlan.filter((step) => step.kind === 'append')
  const appendChunks = appends.map((step) => /cmd \/c "echo (\S+) [>]{1,2}/u.exec(step.command)?.[1] ?? '')
  check('CB-1: the staging plan is measure → 8 appends → decode → verify → register, every child cmd-line-safe (< 8191) and every append carrying base64 through cmd (no quoting hazard)',
    stageKinds[0] === 'measure'
    && appends.length === 8
    && stageKinds.at(-3) === 'decode' && stageKinds.at(-2) === 'verify' && stageKinds.at(-1) === 'register'
    && stagePlan.length === 12
    && stagePlan.every((step) => typeof step.command === 'string' && step.command.length < 8_191)
    // Appends are `cmd /c "echo <chunk> >|>> <carrier>"`: chunk 0 truncates.
    && appends[0].command.includes(`cmd /c "echo `)
    && appends[0].command.includes(' >C:\\ProgramData\\cua\\cua-relay-guard.b64"')
    && appends.slice(1).every((step) => step.command.includes(' >>C:\\ProgramData\\cua\\cua-relay-guard.b64"'))
    && appendChunks.every((chunk) => /^[A-Za-z0-9+/=]+$/u.test(chunk))
    && appendChunks.join('') === guardBase64
    // The three DECISIONS stay PowerShell, and the decoder strips the whitespace
    // `echo` adds (the live-tested pair).
    && ['measure', 'decode', 'verify'].every((kind) => stagePlan.find((step) => step.kind === kind)?.command.startsWith('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "'))
    && stagePlan.find((step) => step.kind === 'decode')?.command.includes("-replace '\\s',''")
    && stagePlan.find((step) => step.kind === 'verify')?.command.includes("Get-FileHash")
    && stagePlan[0].command.includes('CUA_PAYLOAD')
    && stagePlan.at(-1).command.startsWith('schtasks /create /tn "cua-mcp-host-guard" /sc onstart /ru SYSTEM /rl HIGHEST /f ')
    && stagePlan.at(-1).command.includes('-Boot -Port 47999'),
    `${stageKinds.join(',')} (${stagePlan.length} steps, ${appends.length} appends, max=${Math.max(...stagePlan.map((step) => step.command.length))} chars)`)

  /* ---- CB-2: A HEAD GUEST STAGES NOTHING (AND A TASK-LESS ONE STILL
   *            REGISTERS) ------------------------------------------------ */
  // C2 rule 3 + D3: the measure is the whole plan only when the file matches AND
  // the task exists. A matching file with a missing/unknown task still registers.
  const currentPlan = UP.relayGuardStagePlan({ base64: guardBase64, expectedHash: planExpected, measuredHash: planExpected, expectedRelay: HEX_B, taskPresent: true, port: 47999 })
  const tasklessPlan = UP.relayGuardStagePlan({ base64: guardBase64, expectedHash: planExpected, measuredHash: planExpected, expectedRelay: HEX_B, taskPresent: false, port: 47999 })
  const unknownTaskPlan = UP.relayGuardStagePlan({ base64: guardBase64, expectedHash: planExpected, measuredHash: planExpected, expectedRelay: HEX_B, taskPresent: null, port: 47999 })
  const stalePlan = UP.relayGuardStagePlan({ base64: guardBase64, expectedHash: planExpected, measuredHash: HEX_C, expectedRelay: HEX_B, taskPresent: true, port: 47999 })
  check('CB-2: a matching hash WITH the task present yields the measure alone (no write), while a matching hash with the task absent/unverified yields measure+register — and a differing hash yields the full plan',
    currentPlan.length === 1 && currentPlan[0].kind === 'measure'
    && currentPlan.every((step) => step.kind !== 'append' && step.kind !== 'register')
    && tasklessPlan.length === 2 && tasklessPlan[1].kind === 'register'
    && unknownTaskPlan.length === 2 && unknownTaskPlan[1].kind === 'register'
    && stalePlan.length === 12 && stalePlan.filter((step) => step.kind === 'append').length === 8
    && stalePlan.at(-1).kind === 'register',
    `current=${currentPlan.length} taskless=${tasklessPlan.length} unknown=${unknownTaskPlan.length} stale=${stalePlan.length}`)

  /* ---- CB-3: THE FLAG IS THE GATE (spy spawn count) ------------------ */
  // C2 rule 4, the most dangerous mistake available: the 15 s poll calls
  // repairRelay() WITHOUT payloadRepair, so it stages nothing. The forced path
  // runs the launcher CARRIER (5 children: D2) plus the 12-step plan = 17.
  const spyStub = (verifyGuard, { measureGuard = '', taskAtMeasure = 0, lineStale = null } = {}) => {
    const calls = []
    let hashes = 0
    const spawnImpl = (_bin, argv) => {
      const remote = String(argv?.at(-1) ?? '')
      calls.push(remote)
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      let out = ''
      if (remote.includes('Invoke-Expression')) {
        // The last child of the launcher CARRIER (D2) runs the staged script.
        out = `CUA_RELAY ok=1 port=47999 task=1 running=1 session=2 probe=RELAY_OK hash=${HEX_B} mode=handshake reason=\n`
      } else if (remote.includes('schtasks /create')) {
        out = `${'CUA_PAYLOAD'} task=1\n`
      } else if (remote.includes('Get-FileHash')) {
        hashes += 1
        const isVerify = hashes > 1
        const guard = isVerify ? verifyGuard : measureGuard
        const staged = guard === planExpected ? (isVerify ? 'staged' : 'current') : 'incomplete'
        const task = isVerify ? 1 : taskAtMeasure
        // The guest applies C6 now; `lineStale` lets a check FORCE a disagreeing
        // line to prove the harness ignores it (D5).
        const stale = lineStale === null ? (staged === 'staged' ? 0 : 1) : lineStale
        out = `CUA_PAYLOAD guard=${guard} relay=${HEX_B} stale=${stale} staged=${staged} task=${task}\n`
      }
      setTimeout(() => {
        if (out !== '') child.stdout.emit('data', out)
        child.emit('close', 0)
      }, 0)
      return child
    }
    return { calls, spawnImpl }
  }
  UP.resetRelayRepairState()
  const pollSpy = spyStub(planExpected)
  const pollRecord = await UP.repairRelay({ port: 47999, force: true, spawnImpl: pollSpy.spawnImpl, now: () => 1_000, log: () => {} })
  const pollStaging = pollSpy.calls.filter((command) => command.includes('Get-FileHash') || command.includes('schtasks /create')).length
  UP.resetRelayRepairState()
  const forcedSpy = spyStub(planExpected)
  const forcedRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: forcedSpy.spawnImpl, now: () => 1_000, log: () => {} })
  UP.resetRelayRepairState()
  check('CB-3: `payloadRepair !== true` stages NOTHING (1 carrier child set, 0 payload steps), while the forced path runs the 5-child carrier + the 12-step plan (17 children) and reports the task',
    pollRecord.disabled !== true
    && pollSpy.calls.length === 5 && pollStaging === 0
    && pollRecord.payload.staged === 'none'
    && forcedSpy.calls.length === 17
    && forcedRecord.payload.staged === 'staged'
    && forcedRecord.payload.guardHash === planExpected
    && forcedRecord.payload.task === true,
    `poll=${pollSpy.calls.length} child(ren)/${pollStaging} staging, forced=${forcedSpy.calls.length} child(ren), staged=${forcedRecord.payload.staged} task=${forcedRecord.payload.task}`)

  /* ---- CB-4: THE SECOND RECORD LINE AND ITS CLOSED SET -------------- */
  // C2 rule 9/10: `CUA_PAYLOAD` is a SECOND line (the frozen `CUA_RELAY` grammar
  // is untouched), `staged` is one of exactly five words, and anything that does
  // not parse to one of them is `incomplete` — never `staged`.
  const payloadLine = (guard, relay, stale, staged) => `CUA_PAYLOAD guard=${guard} relay=${relay} stale=${stale} staged=${staged}\n`
  const goodPayload = UP.parseCuaPayloadRecord(payloadLine(HEX_A, HEX_B, 1, 'staged'))
  const worded = ['current', 'staged', 'incomplete'].map((word) => UP.parseCuaPayloadRecord(payloadLine('', '', 0, word))?.staged)
  check('CB-4: `CUA_PAYLOAD` parses guard/relay/stale/staged, `staged` is exactly the five closed values, and a malformed or unknown answer is `incomplete`',
    goodPayload?.guardHash === HEX_A && goodPayload?.relayHash === HEX_B
    && goodPayload?.guardPresent === true && goodPayload?.relayPresent === true
    && goodPayload?.stale === true && goodPayload?.staged === 'staged'
    && JSON.stringify(UP.PAYLOAD_STAGED_VALUES) === JSON.stringify(['none', 'current', 'staged', 'incomplete', 'absent'])
    && JSON.stringify(worded) === JSON.stringify(['current', 'staged', 'incomplete'])
    && UP.parseCuaPayloadRecord(payloadLine('', '', 0, 'yes'))?.staged === 'incomplete'
    && UP.parseCuaPayloadRecord(payloadLine('', '', 9, 'staged'))?.stale === null
    && UP.parseCuaPayloadRecord(payloadLine('', '', 0, 'staged'))?.guardHash === null
    && UP.parseCuaPayloadRecord('CUA_PAYLOAD\n')?.staged === 'incomplete'
    && UP.parseCuaPayloadRecord('') === null,
    `${JSON.stringify({ guardHash: goodPayload?.guardHash?.slice(0, 6), staged: goodPayload?.staged, unknown: UP.parseCuaPayloadRecord(payloadLine('', '', 0, 'yes'))?.staged })}`)

  /* ---- CB-5: THE STAGING BUDGET FITS THE FORCED REPAIR -------------- */
  // C2 rule 8 / C9: 25 000 < WIN_MCP_FORCE_REPAIR_MS (30 000). The right-hand
  // number is read from index.js — a second literal here would be a copy, not a
  // cross-file agreement.
  const indexSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
  const forcedMsMatch = /const WIN_MCP_FORCE_REPAIR_MS = ([\d_]+)/u.exec(indexSource)
  const forcedMs = forcedMsMatch === null ? null : Number(forcedMsMatch[1].replace(/_/gu, ''))
  check('CB-5: RELAY_PAYLOAD_REPAIR_TIMEOUT_MS (25 000) is STRICTLY inside index.js\'s WIN_MCP_FORCE_REPAIR_MS (30 000) — the doctor\'s forced repair can always hear the staging answer',
    UP.RELAY_PAYLOAD_REPAIR_TIMEOUT_MS === 25_000
    && forcedMs === 30_000
    && UP.RELAY_PAYLOAD_REPAIR_TIMEOUT_MS < forcedMs,
    `payload=${UP.RELAY_PAYLOAD_REPAIR_TIMEOUT_MS} forced=${forcedMs}`)

  /* ---- CB-6: THE WINDOW'S TRUTH TABLE ------------------------------- */
  // C1 rules 2-4, pure: the stream anchor wins, 'none' is never live, and a
  // MEASURED fact (a repair that measured session/hash) outranks the window.
  const T = 1_000_000
  const windowAt = (patch) => UP.bootRaceFacts({ nowMs: T, ...patch })
  const inside = windowAt({ readyAt: T - 1_000, attachedAt: T - 30_000 })
  check('CB-6: bootRaceFacts — readyAt wins over attachedAt, source is closed (stream|attach|none), \'none\' is never live, and a MEASURED fact outranks the window',
    inside.live === true && inside.source === 'stream' && inside.sinceReadyMs === 1_000 && inside.remainingMs === 89_000
    && windowAt({ attachedAt: T - 1_000 }).source === 'attach'
    && windowAt({}).source === 'none' && windowAt({}).live === false && windowAt({}).sinceReadyMs === null
    && windowAt({ readyAt: T - 90_000 }).live === false
    && windowAt({ readyAt: T + 5_000 }).live === false
    && windowAt({ readyAt: T - 1_000, measured: true }).live === false
    && windowAt({ readyAt: T - 1_000 }).remainingMs > 0
    && typeof UP.BOOT_RACE_WINDOW_MS === 'number' && UP.BOOT_RACE_WINDOW_MS === 90_000
    && UP.BOOT_RACE_ATTACH_MS === 24_000 && UP.BOOT_RACE_PROBE_TIMEOUT_MS === 4_000,
    `${JSON.stringify({ live: inside.live, source: inside.source, since: inside.sinceReadyMs, remaining: inside.remainingMs })}`)

  /* ---- CB-7/CB-8/CB-9: THE LADDER ----------------------------------- */
  const ladderStub = () => {
    const calls = []
    const spawnImpl = (_bin, argv) => {
      calls.push(String(argv?.at(-1) ?? ''))
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      setTimeout(() => {
        child.stdout.emit('data', 'RELAY_DOWN\n')
        child.emit('close', 0)
      }, 0)
      return child
    }
    return { calls, spawnImpl }
  }
  const fakeClock = { now: T, sleeps: [] }
  const fakeSleep = async (ms) => { fakeClock.sleeps.push(ms); fakeClock.now += ms }
  const fakeNow = () => fakeClock.now
  UP.resetRelayProbeCache()
  fakeClock.sleeps = []
  const liveStub = ladderStub()
  const liveFacts = await UP.resolveGuestMcpTransport({
    port: 47999, spawnImpl: liveStub.spawnImpl, now: fakeNow, sleep: fakeSleep,
    bootWindow: () => fakeClock.now - 1_000
  })
  check('CB-7: inside a live window the ladder waits EXACTLY [8000, 12000] ms and stops — the frozen offsets, not a poll',
    JSON.stringify(fakeClock.sleeps) === JSON.stringify([8000, 12_000])
    && liveFacts.ladder === true
    && liveFacts.bootRace.live === true
    && liveFacts.transport === 'session-0-direct',
    `sleeps=${JSON.stringify(fakeClock.sleeps)} ladder=${liveFacts.ladder}`)

  UP.resetRelayProbeCache()
  fakeClock.sleeps = []
  const outsideStub = ladderStub()
  const outsideFacts = await UP.resolveGuestMcpTransport({
    port: 47999, spawnImpl: outsideStub.spawnImpl, now: fakeNow, sleep: fakeSleep,
    bootWindow: () => fakeClock.now - 200_000
  })
  UP.resetRelayProbeCache()
  fakeClock.sleeps = []
  process.env.DSH_CUA_WIN_MCP_COMMAND = 'python -m dsh_cua.server --stdio'
  const overrideStub = ladderStub()
  let overrideFacts = null
  try {
    overrideFacts = await UP.resolveGuestMcpTransport({
      port: 47999, spawnImpl: overrideStub.spawnImpl, now: fakeNow, sleep: fakeSleep,
      bootWindow: () => fakeClock.now - 1_000
    })
  } finally {
    delete process.env.DSH_CUA_WIN_MCP_COMMAND
  }
  check('CB-8: NO ladder outside the window (one probe, zero waits) and NO ladder when a command override is set — a decision is not a late logon task',
    outsideFacts.ladder === false && outsideStub.calls.length === 1 && fakeClock.sleeps.length === 0
    && overrideFacts?.override === true && overrideFacts?.ladder === false
    && overrideStub.calls.length === 1,
    `outside=${outsideStub.calls.length} child(ren)/${outsideFacts.ladder}, override=${overrideStub.calls.length} child(ren)/${overrideFacts?.ladder}`)

  UP.resetRelayProbeCache()
  fakeClock.sleeps = []
  const forcedStub = ladderStub()
  const forcedFacts = await UP.resolveGuestMcpTransport({
    port: 47999, spawnImpl: forcedStub.spawnImpl, now: fakeNow, sleep: fakeSleep,
    bootWindow: () => fakeClock.now - 1_000
  })
  const winMcpSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'win-mcp.js'), 'utf8')
  check('CB-9: every ladder probe passes `force: true` — a cached DOWN cannot make the ladder decorative (3 children, not the 1 a cache hit would cost)',
    forcedStub.calls.length === 3
    && forcedFacts.relayStatus === 'RELAY_DOWN'
    && /async function bootRaceProbeLadder\(/u.test(winMcpSource)
    && winMcpSource.includes('force: true, timeoutMs: BOOT_RACE_PROBE_TIMEOUT_MS'),
    `${forcedStub.calls.length} probe child(ren), status=${forcedFacts.relayStatus}`)

  /* ---- CB-10: THE THREE WORLDS OF THE EVIDENCE READ ------------------ */
  // C3: connected + RELAY_FN sent + ZERO bytes back is `probe-unsupported`; a
  // refused TCP connect and a garbage answer both stay `no-evidence`. Driven
  // through the REAL program against local sockets (python3), because the
  // decision lives in the Python, not in the host's parser.
  const pythonReady = (() => {
    try {
      const probe = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8', timeout: 10_000 })
      return probe.status === 0
    } catch {
      return false
    }
  })()
  const freePort = async () => {
    const server = net.createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await new Promise((resolve) => server.close(resolve))
    return port
  }
  const runProgram = (port) => new Promise((resolve) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cb-fn-'))
    const file = path.join(dir, 'probe.py')
    writeFileSync(file, UP.relayFunctionalProbeProgram(port))
    const child = spawn('python3', [file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => { try { child.kill() } catch {} finish({ token: '', reason: null }) }, 20_000)
    timer.unref?.()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('close', (code) => {
      clearTimeout(timer)
      const lines = String(out).trim().split('\n')
      let json = null
      try { json = JSON.parse(lines.at(-1)) } catch {}
      finish({ token: lines[0], reason: json?.reason, code })
    })
  })
  let worlds = null
  if (pythonReady === true) {
    const destroyPort = await freePort()
    const destroyServer = net.createServer((socket) => socket.destroy())
    await new Promise((resolve) => destroyServer.listen(destroyPort, '127.0.0.1', resolve))
    let destroyWorld = null
    try { destroyWorld = await runProgram(destroyPort) } finally { await new Promise((resolve) => destroyServer.close(resolve)) }
    const closedWorld = await runProgram(await freePort())
    const garbagePort = await freePort()
    const garbageServer = net.createServer((socket) => { socket.on('data', () => socket.write('GARBAGE\n')) })
    await new Promise((resolve) => garbageServer.listen(garbagePort, '127.0.0.1', resolve))
    let garbageWorld = null
    try { garbageWorld = await runProgram(garbagePort) } finally { await new Promise((resolve) => garbageServer.close(resolve)) }
    worlds = { destroy: destroyWorld, closed: closedWorld, garbage: garbageWorld }
  }
  check('CB-10: `probe-unsupported` ONLY for connected + RELAY_FN sent + zero bytes (a refused connect and a garbage answer stay `no-evidence`)',
    pythonReady !== true
      ? (() => {
          // No python3 on this host: the DECISION is still asserted through its
          // source shape (the same predicate), and the detail says so.
          const program = UP.relayFunctionalProbeProgram(47999)
          return program.includes("('probe-unsupported' if (_connected and _sent and _bytes == 0) else 'no-evidence')")
        })()
      : (worlds?.destroy?.token === 'RELAY_UNRESPONSIVE' && worlds?.destroy?.reason === 'probe-unsupported'
          && worlds?.destroy?.code === 3
          && worlds?.closed?.reason === 'no-evidence'
          && worlds?.garbage?.reason === 'no-evidence'),
    pythonReady !== true
      ? 'python3 absent — the predicate is asserted from the program source'
      : JSON.stringify({ destroy: worlds?.destroy?.reason, closed: worlds?.closed?.reason, garbage: worlds?.garbage?.reason }))

  /* ---- CB-11: THE FLAGS SURVIVE AN EXCEPTION ------------------------ */
  // C3: the three flags are initialised OUTSIDE the try, then set as the read
  // progresses — so an exception inside the read cannot erase the evidence that
  // the socket was connected and the token was sent.
  const probeProgram = UP.relayFunctionalProbeProgram(47999)
  const iInit = probeProgram.indexOf('_connected = False')
  const iTry = probeProgram.indexOf('try:')
  const iConnected = probeProgram.indexOf('_connected = True')
  const iSent = probeProgram.indexOf("sendall(b'RELAY_FN')")
  const iUnsupported = probeProgram.indexOf("'probe-unsupported'")
  check('CB-11: the three evidence flags are initialised BEFORE the try and set in order (connected → sent → bytes), so an exception cannot lose them',
    iInit !== -1 && iTry !== -1
    && iInit < iTry && iTry < iConnected && iConnected < iSent && iSent < iUnsupported
    && probeProgram.includes('_sent = False') && probeProgram.includes('_bytes = 0')
    && probeProgram.includes('_bytes = len(_b)'),
    `init=${iInit} try=${iTry} connected=${iConnected} sent=${iSent} reason=${iUnsupported}`)

  /* ---- CB-12: THE SIX-MEMBER CLOSED SET ----------------------------- */
  // C3 / §4.1 row 8: six members, `''` still first, and anything outside the set
  // normalizes to `no-evidence` instead of reaching the doctor's sentences.
  const reasonProbe = (reason) => {
    const child = new EventEmitter()
    const spawnImpl = () => {
      const instance = new EventEmitter()
      instance.stdout = new EventEmitter()
      instance.stderr = new EventEmitter()
      instance.stdout.setEncoding = () => {}
      instance.stderr.setEncoding = () => {}
      instance.kill = () => {}
      setTimeout(() => {
        instance.stdout.emit('data', `RELAY_UNRESPONSIVE\n${JSON.stringify({ measured: false, reason, mode: 'functional' })}\n`)
        instance.emit('close', 0)
      }, 0)
      return instance
    }
    void child
    return spawnImpl
  }
  const supportedAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: reasonProbe('probe-unsupported'), now: () => 1_000 })
  const unknownAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: reasonProbe('probe-unknown'), now: () => 1_000 })
  const reasons = UP.RELAY_FN_REASONS
  check('CB-12: RELAY_FN_REASONS is six members with \'\' first (probe-unsupported last), frozen, and an unknown reason still normalizes to no-evidence',
    Array.isArray(reasons) && Object.isFrozen(reasons) && reasons.length === 6
    && JSON.stringify(reasons) === JSON.stringify(['', 'child-silent', 'child-eof', 'session-busy', 'no-evidence', 'probe-unsupported'])
    && supportedAnswer.reason === 'probe-unsupported'
    && unknownAnswer.reason === 'no-evidence',
    `${JSON.stringify(reasons)} | unknown⇒${unknownAnswer.reason}`)

  /* ---- CB-13: payload.skew'S THIRD PRODUCER ------------------------- */
  // C3: `probe-unsupported` means "the relay ANSWERED (accept loop) and the
  // probe could not read an answer" — the same class as SKEW/BAD, and NOT the
  // same as `no-evidence` (which stays false).
  check('CB-13: relayEvidenceSkew gains `probe-unsupported` as its third producer (true), keeps `no-evidence` false, and the semantics sentence names it',
    UP.relayEvidenceSkew(UP.RELAY_UNRESPONSIVE, null, 'probe-unsupported') === true
    && UP.relayEvidenceSkew(UP.RELAY_UNRESPONSIVE, null, 'no-evidence') === false
    && UP.relayEvidenceSkew(UP.RELAY_UNRESPONSIVE, null, '') === false
    && UP.relayEvidenceSkew(UP.RELAY_SKEW, null, '') === true
    && UP.relayEvidenceSkew(UP.RELAY_UNRESPONSIVE, { reason: 'probe-skew' }, '') === true
    && UP.PAYLOAD_SKEW_SEMANTICS.includes('probe-unsupported'),
    `supported=${UP.relayEvidenceSkew(UP.RELAY_UNRESPONSIVE, null, 'probe-unsupported')} no-evidence=${UP.relayEvidenceSkew(UP.RELAY_UNRESPONSIVE, null, 'no-evidence')}`)

  /* ---- CB-14/CB-15/CB-16: THE FACTS-FILE LADDER --------------------- */
  // C4, language-free: the code is decided by stdout emptiness and the capture's
  // connectionLevel, never by the guest's localized sentence.
  const desktopStub = ({ stdout = '', stderr = '', exitCode = 0 }) => (_bin, argv) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdout.setEncoding = () => {}
    child.stderr.setEncoding = () => {}
    child.kill = () => {}
    setTimeout(() => {
      if (stdout !== '') child.stdout.emit('data', stdout)
      if (stderr !== '') child.stderr.emit('data', stderr)
      child.emit('close', exitCode)
    }, 0)
    return child
  }
  const readFacts = (spec, port) => UP.desktopFacts({ name: `cb4-${port}`, port, spawnImpl: desktopStub(spec), now: () => 1_000, force: true })
  const absentLocalized = await readFacts({ stderr: 'The system cannot find the path specified.\r\n', exitCode: 1 }, 41_101)
  const absentSilent = await readFacts({ exitCode: 1 }, 41_102)
  check('CB-14: an empty stdout means facts-file-absent — with a LOCALIZED stderr and with no stderr at all (the rule never reads English)',
    absentLocalized.errorCode === UP.DESKTOP_FACTS_ABSENT
    && absentSilent.errorCode === 'facts-file-absent'
    && absentLocalized.error === 'facts-file-absent: C:\\cua-work\\cua-desktop-facts.json (the guest payload may predate the facts writer)'
    && absentSilent.error === absentLocalized.error
    && absentLocalized.measured === false
    && absentLocalized.error.includes('cannot find') === false,
    `${absentLocalized.errorCode} / ${absentSilent.errorCode}`)

  const unparsable = await readFacts({ stdout: 'this is not json' }, 41_103)
  check('CB-15: stdout that is NOT JSON is facts-unparsable (the file exists; the payload wrote something else) — never facts-file-absent',
    unparsable.errorCode === 'facts-unparsable'
    && unparsable.measured === false
    && unparsable.error === 'this is not json',
    `${unparsable.errorCode}: ${unparsable.error}`)

  const sshFailed = await readFacts({ stderr: 'Connection closed by 127.0.0.1 port 22', exitCode: 255 }, 41_104)
  check('CB-16: a connection-level capture is ssh-failed (the read never reached the guest, so its empty stdout is NOT a missing file)',
    sshFailed.errorCode === 'ssh-failed'
    && sshFailed.connectionLevel === true
    && sshFailed.measured === false,
    `${sshFailed.errorCode} connectionLevel=${sshFailed.connectionLevel}`)

  /* ---- CB-17: THE THROTTLE MOVED, NOT THE TIMER --------------------- */
  // C1 rule 7: the 15 s setInterval is untouched; the guard gets a 10 s interval
  // inside a live window, so a relay that binds at ready+50 s is not locked out
  // until ready+99 s.
  check('CB-17: shouldUpgradeToRelay REFUSES a 10 s-old attempt at the 60 s default and ACCEPTS it at BOOT_RACE_UPGRADE_INTERVAL_MS — and the timer is still 15 s',
    UP.BOOT_RACE_UPGRADE_INTERVAL_MS === 10_000
    && UP.RELAY_UPGRADE_INTERVAL_MS === 60_000
    && UP.RELAY_UPGRADE_WATCH_MS === 15_000
    && UP.shouldUpgradeToRelay({ transport: 'session-0-direct', now: T, lastUpgradeAttemptAt: T - 10_000 }) === false
    && UP.shouldUpgradeToRelay({ transport: 'session-0-direct', now: T, lastUpgradeAttemptAt: T - 10_000, intervalMs: UP.BOOT_RACE_UPGRADE_INTERVAL_MS }) === true
    && winMcpSource.includes('intervalMs: state.bootRace?.live === true ? BOOT_RACE_UPGRADE_INTERVAL_MS : undefined'),
    `boot=${UP.BOOT_RACE_UPGRADE_INTERVAL_MS} default=${UP.RELAY_UPGRADE_INTERVAL_MS} watch=${UP.RELAY_UPGRADE_WATCH_MS}`)

  /* ---- CB-18: THE LAUNCHER RIDES A CHUNKED CARRIER (D2) ------------- */
  // The live failure: one `-EncodedCommand` of 13 721 chars → 36 592 base64 →
  // a 36 667-character remote command, past cmd.exe's 8 191 line; sshd answered
  // `exec request failed on channel 0`. The carrier is now the guard's geometry.
  const repairScript = UP.relayRepairScriptSource({ port: 47999 })
  const repairCarrier = UP.relayRepairScriptCarrierPlan({ script: repairScript })
  const repairAppends = repairCarrier.filter((step) => step.kind === 'append')
  const repairChunks = repairAppends.map((step) => /cmd \/c "echo (\S+) [>]{1,2}/u.exec(step.command)?.[1] ?? '')
  const oldSingleCommand = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass ${UP.RELAY_REPAIR_COMMAND_MARKER} ${Buffer.from(repairScript, 'utf16le').toString('base64')}`
  check('CB-18: the repair script is staged in 6 000-char cmd appends + one short decoder EVERY child < 8191 chars (the old single command was 36 667) and the carrier round-trips the script',
    repairCarrier.length === 5 && repairAppends.length === 4 && repairCarrier.at(-1).kind === 'exec'
    && repairCarrier.every((step) => step.command.length < 8_191)
    && oldSingleCommand.length > 8_191
    && repairChunks.join('') === Buffer.from(repairScript, 'utf8').toString('base64')
    && repairAppends[0].command.includes(` >${UP.RELAY_REPAIR_CARRIER_PATH}"`)
    && repairAppends.slice(1).every((step) => step.command.includes(` >>${UP.RELAY_REPAIR_CARRIER_PATH}"`))
    && repairCarrier.at(-1).command.includes('Invoke-Expression')
    && repairCarrier.at(-1).command.includes(`Invoke-Expression $x`)
    && repairCarrier.every((step) => step.command.includes(UP.RELAY_REPAIR_COMMAND_MARKER)),
    `${repairCarrier.length} child(ren), max ${Math.max(...repairCarrier.map((step) => step.command.length))} chars (old ${oldSingleCommand.length})`)

  /* ---- CB-19: A CURRENT FILE WITH NO TASK STILL REGISTERS (D3) ------ */
  // The live state was exactly this: guard hash = expected, `cua-mcp-host-guard`
  // absent, plan `[measure]`, task uncreatable. The plan must now register.
  UP.resetRelayRepairState()
  const tasklessSpy = spyStub(planExpected, { measureGuard: planExpected, taskAtMeasure: 0 })
  const tasklessRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: tasklessSpy.spawnImpl, now: () => 1_000, log: () => {} })
  UP.resetRelayRepairState()
  const registerChildren = tasklessSpy.calls.filter((command) => command.includes('schtasks /create')).length
  check('CB-19: a matching guard hash with the task ABSENT runs measure+register (7 children, 0 file writes) and reports staged:current + task:true — the live state that could never create the task',
    tasklessSpy.calls.length === 7
    && registerChildren === 1
    && tasklessRecord.payload.staged === 'current'
    && tasklessRecord.payload.task === true
    && tasklessRecord.payload.writes === 0
    && tasklessRecord.payload.guardHash === planExpected
    // The register line speaks only `task=`; it must not reset the presence the
    // measure proved (the live run's `guardPresent:false` on a matching guard).
    && tasklessRecord.payload.guardPresent === true
    && tasklessRecord.payload.relayPresent === true,
    `children=${tasklessSpy.calls.length} register=${registerChildren} staged=${tasklessRecord.payload.staged} task=${tasklessRecord.payload.task} writes=${tasklessRecord.payload.writes}`)

  /* ---- CB-20: THE WHOLE PLAN FITS ITS BUDGET (D4) ------------------- */
  // The live arithmetic: 12 PowerShell children ≈ 29–35 s > 25 000, so `register`
  // (step 12) was cut. The plan is now 3 PowerShell + 9 cmd, and the launcher
  // phase 1 + 4 — both under the shared 28 000 deadline, which itself ends
  // before index.js's 30 000 guard.
  const stepCost = (plan) => plan.reduce((total, step) => total
    + (step.kind === 'append' || step.kind === 'register' ? UP.RELAY_REPAIR_STEP_MS.cmd : UP.RELAY_REPAIR_STEP_MS.powershell), 0)
  const payloadCost = stepCost(stagePlan)
  const carrierCost = stepCost(repairCarrier)
  const forcedMsMatch2 = /const WIN_MCP_FORCE_REPAIR_MS = ([\d_]+)/u.exec(indexSource)
  const forcedEnvelope = forcedMsMatch2 === null ? null : Number(forcedMsMatch2[1].replace(/_/gu, ''))
  check('CB-20: at the MEASURED per-child cost the payload plan (3 PowerShell + 9 cmd ≈ 10 050 ms) and the carrier (≈3 500 ms) fit RELAY_PAYLOAD_REPAIR_TIMEOUT_MS and the shared RELAY_REPAIR_TOTAL_MS (28 000 < 30 000), so `register` is never the step the deadline cuts',
    UP.RELAY_PAYLOAD_REPAIR_TIMEOUT_MS === 25_000
    && UP.RELAY_REPAIR_TOTAL_MS === 28_000
    && forcedEnvelope === 30_000
    && UP.RELAY_REPAIR_TOTAL_MS < forcedEnvelope
    && payloadCost < UP.RELAY_PAYLOAD_REPAIR_TIMEOUT_MS
    && payloadCost + carrierCost < UP.RELAY_REPAIR_TOTAL_MS
    && stagePlan.at(-1).kind === 'register'
    && repairCarrier.at(-1).kind === 'exec',
    `payload=${payloadCost} ms carrier=${carrierCost} ms total=${payloadCost + carrierCost} ms < ${UP.RELAY_REPAIR_TOTAL_MS} < ${forcedEnvelope}`)

  /* ---- CB-21: ONE `stale` RULE (D5) --------------------------------- */
  // The live defect: guest line `stale=0` (guard matched) vs harness
  // `payload.stale:true` (relay differed), same guest, same second. The guest
  // line now applies C6's table and the RECORD's value is derived by the one
  // owner — proven by feeding a disagreeing line and getting the harness answer.
  UP.resetRelayRepairState()
  const disagreeingSpy = spyStub(planExpected, { lineStale: 0 })
  const disagreeingRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: disagreeingSpy.spawnImpl, now: () => 1_000, log: () => {} })
  UP.resetRelayRepairState()
  const agreeing = UP.payloadStale({ expectedRelayHash: HEX_A, relayHash: HEX_A, expectedGuardHash: HEX_B, guardHash: HEX_B })
  const differing = UP.payloadStale({ expectedRelayHash: HEX_A, relayHash: HEX_C, expectedGuardHash: HEX_B, guardHash: HEX_B })
  const noPair = UP.payloadStale({ expectedRelayHash: null, relayHash: HEX_A, expectedGuardHash: HEX_B, guardHash: null })
  const lineStale = UP.parseCuaPayloadRecord(`${'CUA_PAYLOAD'} guard=${HEX_B} relay=${HEX_B} stale= staged=current task=1`)
  check('CB-21: `stale` has ONE owner — C6\'s table (agree false / differ true / no comparable pair null), the guest line prints the same table (`stale=` empty ⇒ null), and a DISAGREEING line cannot change the record\'s derived answer',
    agreeing === false && differing === true && noPair === null
    && lineStale?.stale === null
    && UP.parseCuaPayloadRecord(`${'CUA_PAYLOAD'} guard= relay= stale=0 staged=current task=1`)?.stale === false
    && UP.parseCuaPayloadRecord(`${'CUA_PAYLOAD'} guard= relay= stale=1 staged=current task=1`)?.stale === true
    && stagePlan[0].command.includes(`$s=''`) && stagePlan[0].command.includes(`-ne '' -and`)
    // The line said 0; the relay hash differs from the build's; the RECORD says true.
    && disagreeingRecord.payload.stale === true
    && disagreeingRecord.payload.guardHash === planExpected,
    `agree=${agreeing} differ=${differing} noPair=${noPair} lineSay=0 record=${disagreeingRecord.payload.stale}`)

  /* ---- P-ROUND PINS: PRE defects 2/4/5/6 ---------------------------- */
  //
  // One faithful, tiny guest for the three carrier/plan pins: `cmd /c echo`
  // appends, the real decode body, the real measure/verify/register shapes, and
  // a per-child CLOCK so a budget pin is deterministic. Nothing here re-implements
  // a decision — every command comes from the module's own builders.
  const GUARD_PATH_FOR_TEST = 'C:\\ProgramData\\cua\\cua-relay-guard.ps1'
  const GUARD_B64_FOR_TEST = 'C:\\ProgramData\\cua\\cua-relay-guard.b64'
  const REPAIR_B64_FOR_TEST = 'C:\\ProgramData\\cua\\cua-relay-repair.b64'
  const guardTextForTest = guardBytes === null ? '' : guardBytes.toString('utf8')
  const expectedForTest = expectedGuard ?? HEX_A
  const miniGuest = ({ guard = null, b64 = null, task = false, failAppendAt = 0, failCarrierAt = 0, killGuardAt = 0, killCarrierAt = 0, corruptDecode = false, corruptDecodeOnce = false, msPerChild = 0, hang = false } = {}) => {
    const fs = new Map()
    if (guard !== null) fs.set(GUARD_PATH_FOR_TEST, guard)
    if (b64 !== null) fs.set(GUARD_B64_FOR_TEST, b64)
    if (task === true) fs.set('__task__', '1')
    const log = []
    const clock = { now: 1_000 }
    let guardAppends = 0
    let carrierAppends = 0
    let decodeRuns = 0
    const spawnImpl = (_bin, argv) => {
      const command = String(argv?.at(-1) ?? '')
      log.push(command)
      clock.now += msPerChild
      const child = new EventEmitter()
      if (hang === true) {
        // A SILENT child: no stdout, no exit, no close — only the capture's own
        // timer can end it (the live carrier hit exactly this).
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.stdout.setEncoding = () => {}
        child.stderr.setEncoding = () => {}
        child.kill = () => {}
        return child
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      let out = ''
      let err = ''
      let code = 0
      // N2: a child KILLED BY A SIGNAL — no stdout, no stderr, no 'exit' event,
      // only `close(null)` (exactly what runSshCapture turns into
      // `{exitCode: null, detail: '', timedOut: false}`). The old predicate read
      // that shape as SUCCESS; a guest that dies mid-carrier is the live accident.
      let signalKill = false
      const echo = /^cmd \/c "echo (\S+) (>>?)([^"]+)"$/u.exec(command)
      if (echo !== null) {
        const [, chunk, op, file] = echo
        const isGuard = file === GUARD_B64_FOR_TEST
        if (isGuard) {
          guardAppends += 1
          if (killGuardAt > 0 && guardAppends === killGuardAt) { signalKill = true } else if (guardAppends === failAppendAt) { code = 1; err = 'Access is denied.' } else {
            fs.set(file, (op === '>' ? '' : (fs.get(file) ?? '')) + `${chunk} \r\n`)
          }
        } else {
          carrierAppends += 1
          if (killCarrierAt > 0 && carrierAppends === killCarrierAt) { signalKill = true } else if (carrierAppends === failCarrierAt) { code = 1; err = 'Access is denied.' } else {
            fs.set(file, (op === '>' ? '' : (fs.get(file) ?? '')) + `${chunk} \r\n`)
          }
        }
      } else if (command.includes('Invoke-Expression $x')) {
        fs.delete(REPAIR_B64_FOR_TEST)
        out = `CUA_RELAY ok=1 port=47999 task=1 running=1 session=2 probe=RELAY_OK hash=${HEX_B} mode=handshake reason=\n`
      } else if (command.includes('schtasks /create')) {
        fs.set('__task__', '1')
        out = 'CUA_PAYLOAD task=1\n'
      } else if (command.includes('FromBase64String') && command.includes('WriteAllText')) {
        decodeRuns += 1
        const raw = String(fs.get(GUARD_B64_FOR_TEST) ?? '').replace(/\s/gu, '')
        if (raw.length % 4 !== 0 || /^[A-Za-z0-9+/]*={0,2}$/u.test(raw) === false) {
          code = 1
          err = 'Exception calling FromBase64String'
        } else {
          const decoded = Buffer.from(raw, 'base64').toString('utf8')
          // J1/J2: a decode whose bytes are NOT the payload but which exits 0
          // (a cross-process interleave, a truncated write — the shape that made
          // the verify the only place the truth appears).
          const corrupt = corruptDecode === true || (corruptDecodeOnce === true && decodeRuns === 1)
          fs.set(GUARD_PATH_FOR_TEST, corrupt === true ? decoded.slice(0, Math.max(0, decoded.length - 37)) : decoded)
          fs.delete(GUARD_B64_FOR_TEST)
        }
      } else if (command.includes('Get-FileHash')) {
        if (command.includes('Remove-Item -Force')) fs.delete(GUARD_B64_FOR_TEST)
        const present = fs.has(GUARD_PATH_FOR_TEST)
        const g = present === false ? '' : (fs.get(GUARD_PATH_FOR_TEST) === guardTextForTest ? expectedForTest : HEX_C)
        const t = fs.get('__task__') === '1' ? 1 : 0
        const word = command.includes("{ 'staged' }") ? 'staged' : 'current'
        const staged = g === expectedForTest ? word : 'incomplete'
        out = `CUA_PAYLOAD guard=${g} relay=${HEX_B} stale=1 staged=${staged} task=${t}\n`
      } else {
        code = 1
        err = `unmodelled: ${command.slice(0, 40)}`
      }
      setTimeout(() => {
        if (signalKill === true) {
          // `close(null)` and NOTHING else: the shape that used to read as a
          // successful chunk (`exitCode: null, detail: '', timedOut: false`).
          child.signalCode = 'SIGKILL'
          child.emit('close', null)
          return
        }
        if (out !== '') child.stdout.emit('data', out)
        if (err !== '') child.stderr.emit('data', err)
        child.emit('close', code)
      }, 0)
      return child
    }
    return { fs, log, clock, spawnImpl }
  }

  /* ---- CB-22: BOTH PRODUCERS EMIT relayPresent AND task (P1) -------- */
  // PRE defect 2: `relayPresent`/`task` were documented and produced by nobody,
  // so index.js's re-derivation lost a MEASURED relay pair (`stale: null`) while
  // the owner said true. One owner (`payloadPresence`) feeds both producers.
  const measuredPayloadRecord = {
    measured: true,
    hash: HEX_C,
    payload: { staged: 'staged', guardHash: HEX_A, guardPresent: true, relayHash: HEX_C, relayPresent: true, task: true, writes: 10 }
  }
  const presenceClient = UP.createDshCuaClient({ name: 'p1-facts', sshPort: 1 })
  presenceClient.state.repair = measuredPayloadRecord
  const presenceClientPayload = presenceClient.doctorFacts().payload
  UP.resetRelayRepairState()
  const presenceSpy = spyStub(planExpected)
  await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: presenceSpy.spawnImpl, now: () => 1_000, log: () => {} })
  const probeStub = (() => {
    const spawnImpl = () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      setTimeout(() => { child.stdout.emit('data', 'RELAY_OK\n'); child.emit('close', 0) }, 0)
      return child
    }
    return spawnImpl
  })()
  const moduleFacts = await UP.relayDoctorFacts({ host: '127.0.0.1', port: 47999, user: 'cua', spawnImpl: probeStub, log: () => {} })
  const fieldsDoc = String(UP.DOCTOR_FACTS_FIELDS ?? '')
  UP.resetRelayRepairState()
  check('CB-22: BOTH payload producers emit relayPresent + task (three-valued, one owner) so payloadStale() has its inputs and the doctor\'s re-derivation cannot lose a measured relay pair',
    presenceClientPayload.relayPresent === true
    && presenceClientPayload.task === true
    && presenceClientPayload.guardPresent === true
    && presenceClientPayload.stale === true
    && moduleFacts.payload.relayPresent === true
    && moduleFacts.payload.task === true
    && moduleFacts.payload.guardPresent === true
    && moduleFacts.payload.stale === true
    // The three-valued rule, from the same owner — N1: `hash:''` is MEASURED
    // ABSENT (false) and a never-spoken hash is UNMEASURED (null); the inverted
    // pair this check used to pin is corrected in CB-26's full table.
    && UP.payloadPresence(null).relayPresent === null
    && UP.payloadPresence({ measured: true, hash: '' }).relayPresent === false
    && UP.payloadPresence({ measured: true, hash: null }).relayPresent === null
    && UP.payloadPresence({ measured: false, payload: { staged: 'none' } }).task === null
    && ['relayPresent', 'guardPresent', 'task', 'stale'].every((key) => fieldsDoc.includes(key)),
    `client=${JSON.stringify({ relayPresent: presenceClientPayload.relayPresent, task: presenceClientPayload.task, stale: presenceClientPayload.stale })} module=${JSON.stringify({ relayPresent: moduleFacts.payload.relayPresent, task: moduleFacts.payload.task, stale: moduleFacts.payload.stale })}`)

  /* ---- CB-23: NO CARRIER SURVIVES A COMPLETED REPAIR (P2) ----------- */
  // PRE defect 4: a decode killed between WriteAllText and Remove-Item leaves
  // cua-relay-guard.b64 forever, and once the guard is CURRENT no plan step names
  // it. The MEASURE now deletes it (same child, free), so every completed repair
  // — including the `[measure]` and `[measure, register]` shapes — cleans up.
  const residueGuest = miniGuest({ guard: guardTextForTest, b64: 'RESIDUE-OF-THE-ABORTED-RUN', task: true })
  UP.resetRelayRepairState()
  const residueRecord = await UP.repairRelay({
    port: 47999, force: true, payloadRepair: true, spawnImpl: residueGuest.spawnImpl, now: () => residueGuest.clock.now, log: () => {}
  })
  UP.resetRelayRepairState()
  const measureStep = stagePlan[0].command
  check('CB-23: the MEASURE deletes a leftover carrier (so no .b64 survives a completed repair, even when the guard is current and nothing is appended) — proven on a guest that had residue',
    measureStep.startsWith('powershell')
    && measureStep.includes(`Remove-Item -Force '${GUARD_B64_FOR_TEST}'`)
    && measureStep.indexOf('Remove-Item') < measureStep.indexOf('Get-FileHash')
    && residueRecord.payload.staged === 'current'
    && residueGuest.fs.has(GUARD_B64_FOR_TEST) === false
    && residueGuest.fs.get(GUARD_PATH_FOR_TEST) === guardTextForTest,
    `staged=${residueRecord.payload.staged} residueLeft=${residueGuest.fs.has(GUARD_B64_FOR_TEST)} children=${residueGuest.log.length}`)

  /* ---- CB-24: A FAILED CHILD STOPS THE PLAN (P3) -------------------- */
  // PRE defect 5: runSshCapture resolves on `close` whatever the exit code, so a
  // failed truncate let later chunks append into the OLD carrier, the decode ran
  // on a corrupt stream and `writes` counted the failed child. A non-zero step is
  // now a hard stop and only successful writes are counted.
  const brokenChunkGuest = miniGuest({ failAppendAt: 3 })
  UP.resetRelayRepairState()
  const brokenChunkRecord = await UP.repairRelay({
    port: 47999, force: true, payloadRepair: true, spawnImpl: brokenChunkGuest.spawnImpl, now: () => brokenChunkGuest.clock.now, log: () => {}
  })
  UP.resetRelayRepairState()
  const guardAppendsRan = brokenChunkGuest.log.filter((c) => c.startsWith('cmd /c "echo') && c.includes(GUARD_B64_FOR_TEST)).length
  // The carrier exec also mentions FromBase64String — count the GUARD decoder.
  const decodeRan = brokenChunkGuest.log.filter((c) => c.includes('FromBase64String') && c.includes('WriteAllText') && c.includes(GUARD_PATH_FOR_TEST)).length
  const silentGuest = miniGuest({ hang: true })
  UP.resetRelayRepairState()
  const silentRecord = await UP.repairRelay({
    port: 47999, force: true, payloadRepair: true, timeoutMs: 120,
    spawnImpl: silentGuest.spawnImpl, now: () => silentGuest.clock.now, log: () => {}
  })
  UP.resetRelayRepairState()
  const carrierBroken = miniGuest({ failCarrierAt: 2 })
  UP.resetRelayRepairState()
  const carrierBrokenRecord = await UP.repairRelay({
    port: 47999, force: true, payloadRepair: true, spawnImpl: carrierBroken.spawnImpl, now: () => carrierBroken.clock.now, log: () => {}
  })
  UP.resetRelayRepairState()
  const carrierChildren = carrierBroken.log.filter((c) => c.includes(REPAIR_B64_FOR_TEST) || c.includes('Invoke-Expression')).length
  check('CB-24: a non-zero chunk STOPS the loop (no later append, no decode of a corrupt carrier), `writes` counts only successful writes, and the CARRIER loop fails fast too (the script never runs, so the record is unmeasured)',
    brokenChunkRecord.payload.staged === 'incomplete'
    && guardAppendsRan === 3
    && decodeRan === 0
    && brokenChunkRecord.payload.writes === 2
    && /failed \(exit 1\)/u.test(String(brokenChunkRecord.payload.detail ?? ''))
    && carrierBrokenRecord.parsed === false
    && carrierBrokenRecord.measured === false
    && carrierChildren === 2
    && /carrier chunk failed/u.test(String(carrierBrokenRecord.detail ?? ''))
    // A SILENT child is a FAILED child, not a written one (the live accident):
    // the capture times out, the loop stops, and nothing is counted.
    && silentRecord.parsed === false
    && silentRecord.payload.writes === 0
    && silentRecord.payload.staged === 'incomplete'
    && /carrier chunk failed/u.test(String(silentRecord.detail ?? '')),
    `appends=${guardAppendsRan} decode=${decodeRan} writes=${brokenChunkRecord.payload.writes} carrierChildren=${carrierChildren} silentWrites=${silentRecord.payload.writes} detail=${String(carrierBrokenRecord.detail ?? '').slice(0, 60)}`)

  /* ---- CB-25: THE CALLER'S timeoutMs IS THE WALL (P4) --------------- */
  // PRE defect 6: the doc said "the repair's own wall" while the code used it as
  // a launcher sub-cap, and runPayloadRepair ignored the caller entirely, so
  // repairRelay({timeoutMs: 5000}) could run 28 s. ONE wall now:
  // min(caller, RELAY_REPAIR_TOTAL_MS), read once and shared by both phases.
  const slowGuest = miniGuest({ msPerChild: 400 })
  UP.resetRelayRepairState()
  const slowStarted = slowGuest.clock.now
  const slowRecord = await UP.repairRelay({
    port: 47999, force: true, payloadRepair: true, timeoutMs: 1_500,
    spawnImpl: slowGuest.spawnImpl, now: () => slowGuest.clock.now, log: () => {}
  })
  UP.resetRelayRepairState()
  const slowElapsed = slowGuest.clock.now - slowStarted
  // A NON-POSITIVE `timeoutMs` IS UNSET, NOT A ZERO BUDGET (`Number(null)` is 0,
  // so `{timeoutMs: 0}` used to collapse the wall to "now" and run nothing). The
  // normalization is pinned by running the SAME guest twice — the default and an
  // explicit 0 must produce the same plan — so removing it reddens this arm.
  const unsetBaselineGuest = miniGuest({})
  UP.resetRelayRepairState()
  const unsetBaselineRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: unsetBaselineGuest.spawnImpl, now: () => unsetBaselineGuest.clock.now, log: () => {} })
  UP.resetRelayRepairState()
  const unsetZeroGuest = miniGuest({})
  UP.resetRelayRepairState()
  const unsetZeroRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, timeoutMs: 0, spawnImpl: unsetZeroGuest.spawnImpl, now: () => unsetZeroGuest.clock.now, log: () => {} })
  UP.resetRelayRepairState()
  check('CB-25: `repairRelay({timeoutMs})` bounds the WHOLE attempt (a 1 500 ms cap with 400 ms children stops the 17-child plan early, and the payload says the budget was gone) — the doc and the code now say the same thing; a NON-POSITIVE timeoutMs (0/null) is UNSET, not a zero budget',
    slowElapsed <= 1_500 + 400
    && slowGuest.log.length <= 5
    && slowRecord.payload.staged === 'incomplete'
    && slowRecord.payload.staged !== 'staged'
    && UP.RELAY_REPAIR_TIMEOUT_MS === 25_000
    && UP.RELAY_REPAIR_TOTAL_MS === 28_000
    && /min\(callerMs, RELAY_REPAIR_TOTAL_MS\)/u.test(winMcpSource)
    // 0 is unset: same children, same outcome as the default call.
    && unsetZeroGuest.log.length === unsetBaselineGuest.log.length
    && unsetZeroGuest.log.length > 5
    && unsetZeroRecord.payload.staged === unsetBaselineRecord.payload.staged
    && unsetZeroRecord.payload.writes === unsetBaselineRecord.payload.writes,
    `elapsed=${slowElapsed} ms children=${slowGuest.log.length} staged=${slowRecord.payload.staged} unset=${unsetZeroGuest.log.length}/${unsetBaselineGuest.log.length} children staged=${unsetZeroRecord.payload.staged}/${unsetBaselineRecord.payload.staged}`)

  /* ---- CB-26: THE PRESENCE TRUTH TABLE, ONE OWNER (N1) -------------- */
  // re-PRE N1: `payloadPresence` tested `hash !== null`, so BOTH non-hash arms
  // were inverted — a guest that MEASURED `hash=` (empty: there is no relay
  // script) answered `relayPresent: true`, and a guest that never spoke a hash
  // answered `false`. DOCTOR_FACTS_FIELDS and `parseRelayRepairRecord`'s own
  // `hashMeasured` say the opposite: `hash=` is MEASURED ABSENT, a missing
  // field is UNMEASURED. The table is pinned here in EVERY shape a producer can
  // emit, including the `hash=` arm CB-22 never tested; reverting to the
  // `hash !== null` test reddens whichever arm it is reverted to.
  const presenceArms = [
    // [label, record, expected relayPresent]
    ['hash= (measured absent)', { measured: true, hash: '' }, false],
    ['hash=<hex> (measured present)', { measured: true, hash: HEX_C }, true],
    ['hash field missing (unmeasured)', { measured: true, hash: null }, null],
    ['hash missing, hashMeasured:false', { measured: true, hash: null, hashMeasured: false }, null],
    ['hash null, hashMeasured:true (measured, value gone)', { measured: true, hash: null, hashMeasured: true }, false],
    ['measured:false (nothing measured)', { measured: false, hash: '' }, null],
    ['no record at all', null, null]
  ]
  const presenceGot = presenceArms.map(([, record]) => UP.payloadPresence(record).relayPresent)
  const presenceText = presenceGot.map((value) => String(value)).join(',')
  const presenceOk = presenceArms.every(([, record, expect]) => UP.payloadPresence(record).relayPresent === expect)
  // THE GRAMMAR ARMS, end to end: the `CUA_RELAY` line is the only producer of a
  // measured hash, so the inversion is pinned where it was introduced.
  const presencePresentLine = UP.parseRelayRepairRecord(`CUA_RELAY ok=0 port=47999 task=0 running=0 session=2 probe=RELAY_DOWN hash=${HEX_C} mode=handshake reason=`)
  const presenceAbsentLine = UP.parseRelayRepairRecord('CUA_RELAY ok=0 port=47999 task=0 running=0 session=2 probe=RELAY_DOWN hash= mode=handshake reason=relay-missing')
  const presenceUnmeasuredLine = UP.parseRelayRepairRecord('CUA_RELAY ok=0 port=47999 task=0 running=0 session=2 probe=RELAY_DOWN mode=handshake reason=relay-stopped')
  // The poll/repair shape the probe uses: `measured/hash/hashMeasured` + a payload
  // arm that staged nothing (so the CUA_PAYLOAD arm cannot answer for the relay).
  const presencePoll = (parsed) => ({ measured: parsed?.measured === true, hash: parsed?.hash ?? null, hashMeasured: parsed?.hashMeasured === true, payload: { staged: 'none' } })
  // THE `CUA_PAYLOAD` ARM keys on "this line spoke about it" (hasOwn), so a
  // register-only line (`task=` alone) must not report the guard ABSENT, and an
  // empty `relay=` must not report the relay PRESENT.
  const presenceBlankRelay = UP.parseCuaPayloadRecord('CUA_PAYLOAD guard= relay= stale= staged=current task=1')
  const presenceSilentRelay = UP.parseCuaPayloadRecord('CUA_PAYLOAD stale= staged=current task=1')
  const presenceFromPayload = (parsed) => UP.payloadPresence({ measured: true, hash: null, payload: parsed })
  check('CB-26: relayPresent/guardPresent/task are THREE-VALUED from one owner — `hash=` is MEASURED ABSENT (false), a missing hash is UNMEASURED (null), a hex hash is PRESENT (true), and the CUA_PAYLOAD arm keys on "the line spoke", not on the hash value (re-PRE N1)',
    presenceOk
    && presenceText === 'false,true,null,null,false,null,null'
    && presencePresentLine?.hashMeasured === true
    && presenceAbsentLine?.hashMeasured === true
    && presenceUnmeasuredLine?.hashMeasured === false
    && UP.payloadPresence(presencePoll(presencePresentLine)).relayPresent === true
    && UP.payloadPresence(presencePoll(presenceAbsentLine)).relayPresent === false
    && UP.payloadPresence(presencePoll(presenceUnmeasuredLine)).relayPresent === null
    && presenceBlankRelay?.relayPresent === false
    && presenceBlankRelay?.guardPresent === false
    && presenceBlankRelay?.task === true
    && presenceFromPayload(presenceBlankRelay).relayPresent === false
    && presenceFromPayload(presenceBlankRelay).guardPresent === false
    && presenceSilentRelay?.relayPresent === null
    && presenceSilentRelay?.guardPresent === null
    && presenceFromPayload(presenceSilentRelay).relayPresent === null
    && String(UP.DOCTOR_FACTS_FIELDS ?? '').includes('false MEASURED absent'),
    `arms=${presenceText} (expect false,true,null,null,false,null,null) lines=${JSON.stringify({ present: presencePresentLine?.hashMeasured, absent: presenceAbsentLine?.hashMeasured, unmeasured: presenceUnmeasuredLine?.hashMeasured })} payload=${JSON.stringify({ blank: presenceBlankRelay?.relayPresent, silent: presenceSilentRelay?.relayPresent })}`)

  /* ---- CB-27: A SIGNAL-KILLED CHILD IS A DEATH, NOT A WRITE (N2) ---- */
  // re-PRE N2: `runSshCapture` resolves on `close` with `{exitCode: null,
  // detail: '', timedOut: false}` when the ssh child dies by SIGNAL (SIGKILL/
  // SIGTERM: no 'exit' event, no timer, no spawn error). The predicate only knew
  // timeout / spawn / non-zero, so that shape read as SUCCESS: the loop counted
  // `writes` for a chunk that never landed and carried on toward the decode of a
  // half-written carrier. The documented rule now: a clean `cmd /c echo` always
  // reports a code, so NO CODE AT ALL is never a successful step.
  const stepShapes = [
    ['exit 0', { exitCode: 0, detail: '', timedOut: false }, false],
    ['exit 1', { exitCode: 1, detail: '', timedOut: false }, true],
    ['exit 255', { exitCode: 255, detail: '', timedOut: false }, true],
    ['timeout', { exitCode: null, detail: 'no answer within 1500 ms', timedOut: true }, true],
    ['spawn failure', { exitCode: null, detail: 'spawn failed: ENOENT', timedOut: false }, true],
    ['SIGKILL (close null, no exit, no detail)', { exitCode: null, detail: '', timedOut: false }, true],
    ['no code at all (undefined)', { exitCode: undefined, detail: '', timedOut: false }, true],
    ['no capture', null, true]
  ]
  const stepOk = stepShapes.every(([, capture, expect]) => UP.relayStepFailed(capture) === expect)
  // THE LIVE SHAPE, end to end: the third guard chunk is SIGKILLed. A success
  // reading counts it as a write (writes 3), keeps going and decodes the
  // half-written carrier; the honest reading stops at 2 successful writes and
  // never decodes.
  const killedGuardGuest = miniGuest({ killGuardAt: 3 })
  UP.resetRelayRepairState()
  const killedGuardRecord = await UP.repairRelay({
    port: 47999, force: true, payloadRepair: true, spawnImpl: killedGuardGuest.spawnImpl, now: () => killedGuardGuest.clock.now, log: () => {}
  })
  UP.resetRelayRepairState()
  const killedGuardAppends = killedGuardGuest.log.filter((c) => c.startsWith('cmd /c "echo') && c.includes(GUARD_B64_FOR_TEST)).length
  const killedGuardDecode = killedGuardGuest.log.filter((c) => c.includes('FromBase64String') && c.includes('WriteAllText') && c.includes(GUARD_PATH_FOR_TEST)).length
  // The CARRIER loop has the same predicate: a SIGKILLed chunk must stop the
  // carrier, so the script never runs and the record stays UNMEASURED.
  const killedCarrierGuest = miniGuest({ killCarrierAt: 2 })
  UP.resetRelayRepairState()
  const killedCarrierRecord = await UP.repairRelay({
    port: 47999, force: true, payloadRepair: true, spawnImpl: killedCarrierGuest.spawnImpl, now: () => killedCarrierGuest.clock.now, log: () => {}
  })
  UP.resetRelayRepairState()
  const killedCarrierChildren = killedCarrierGuest.log.filter((c) => c.includes(REPAIR_B64_FOR_TEST) || c.includes('Invoke-Expression')).length
  check('CB-27: a child killed by a SIGNAL (exitCode null, no timeout, no spawn detail) is a FAILED step — the truth table covers SIGKILL, the guard loop stops at 2 successful writes and never decodes, and the carrier loop stops too (re-PRE N2)',
    stepOk
    && UP.relayStepFailed({ exitCode: null, detail: '', timedOut: false }) === true
    && UP.relayStepFailed({ exitCode: 0, detail: '', timedOut: false }) === false
    && killedGuardRecord.payload.staged === 'incomplete'
    && killedGuardRecord.payload.writes === 2
    && killedGuardAppends === 3
    && killedGuardDecode === 0
    && /payload step 'append' failed \(no answer\)/u.test(String(killedGuardRecord.payload.detail ?? ''))
    && killedCarrierRecord.parsed === false
    && killedCarrierRecord.measured === false
    && killedCarrierChildren === 2
    && /carrier chunk failed \(no answer\)/u.test(String(killedCarrierRecord.detail ?? '')),
    `shapes=${stepShapes.map(([, capture]) => UP.relayStepFailed(capture)).join(',')} guardWrites=${killedGuardRecord.payload.writes} guardAppends=${killedGuardAppends} decode=${killedGuardDecode} carrierChildren=${killedCarrierChildren} guardDetail=${String(killedGuardRecord.payload.detail ?? '').slice(0, 60)} carrierDetail=${String(killedCarrierRecord.detail ?? '').slice(0, 60)}`)

  /* ---- J1/J2: THE VERIFY IS THE GATE, AND A WRONG CARRIER RE-STAGES - */
  // JURY-34 probe-1: the verify child is PowerShell that exits 0 on a MISMATCH.
  // The plan's only stop used to be the exit code, so `staged=incomplete` was
  // followed by `schtasks /create`: a non-verifying guard with a SYSTEM onstart
  // task, while the published `task:true` read as "the hash verified".
  // probe-3: the carrier is a FIXED guest path and single-flight is per process,
  // so a second attempt interleaved and the decode wrote 14 590 B of garbage
  // over a good guard — and it still registered.
  const alwaysCorrupt = miniGuest({ corruptDecode: true })
  UP.resetRelayRepairState()
  const corruptRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: alwaysCorrupt.spawnImpl, now: () => alwaysCorrupt.clock.now, log: () => {} })
  UP.resetRelayRepairState()
  const corruptRegister = alwaysCorrupt.log.filter((c) => c.includes('schtasks /create')).length
  check('J1: a verify that answers incomplete STOPS the plan before register (the guest PowerShell exits 0 on a mismatch, so the WORD plus the hash is the verdict) — no SYSTEM task is ever created over a non-verifying guard',
    corruptRecord.payload.staged === 'incomplete'
    && corruptRegister === 0
    && corruptRecord.payload.task === false
    && corruptRecord.payload.restaged === 1
    && /the verify did not report the expected hash/u.test(String(corruptRecord.payload.detail ?? '')),
    `staged=${corruptRecord.payload.staged} register=${corruptRegister} task=${corruptRecord.payload.task} restaged=${corruptRecord.payload.restaged} detail=${String(corruptRecord.payload.detail).slice(0, 70)}`)

  const onceCorrupt = miniGuest({ corruptDecodeOnce: true })
  UP.resetRelayRepairState()
  const healedRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: onceCorrupt.spawnImpl, now: () => onceCorrupt.clock.now, log: () => {} })
  UP.resetRelayRepairState()
  const healedGuard = String(onceCorrupt.fs.get(GUARD_PATH_FOR_TEST) ?? '')
  const decodeCommand = stagePlan.find((step) => step.kind === 'decode')?.command ?? ''
  check('J2: a carrier that decodes to the WRONG bytes is detected by the verify and re-staged ONCE (bounded), so an interleaved carrier self-heals instead of leaving a corrupt guard registered — and the decode itself refuses an empty carrier / a mismatched payload',
    healedRecord.payload.staged === 'staged'
    && healedRecord.payload.task === true
    && healedRecord.payload.restaged === 1
    && healedRecord.payload.guardHash === planExpected
    && healedRecord.payload.detail === ''
    && healedGuard.trim() === guardTextForTest.trim()
    // Guest-side prevention: an empty carrier is not "an empty payload", and a
    // decoded stream that does not hash to the build's payload is refused
    // BEFORE WriteAllText (so a good guard is never overwritten by garbage).
    && decodeCommand.includes('exit 3')
    && decodeCommand.includes('exit 4')
    && decodeCommand.includes('ComputeHash')
    && decodeCommand.indexOf('ComputeHash') < decodeCommand.indexOf('WriteAllText'),
    `staged=${healedRecord.payload.staged} task=${healedRecord.payload.task} restaged=${healedRecord.payload.restaged} guardOk=${healedGuard.trim() === guardTextForTest.trim()} decodeCheck=${decodeCommand.includes('ComputeHash')}`)

  /* ---- J3: A 0-BYTE PAYLOAD IS "NO PAYLOAD" ------------------------- */
  // probe-2: `expectedGuardHash()` returned sha256('') for an empty shipped
  // file, so the plan staged 0 bytes and the verify CONFIRMED the hash of empty.
  const j3Dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-j3-'))
  const j3Empty = path.join(j3Dir, 'empty-guard.ps1')
  writeFileSync(j3Empty, '')
  const emptyExpected = UP.expectedGuardHash(j3Empty)
  const emptyPlan = UP.relayGuardStagePlan({ base64: '', expectedHash: planExpected, expectedRelay: HEX_B, taskPresent: false, port: 47999 })
  try { rmSync(j3Dir, { recursive: true, force: true }) } catch {}
  check('J3: a 0-byte guard payload is "this build cannot say" (null, never sha256(\'\')), so the plan cannot register a task over nothing and the runtime refuses with staged:absent before staging',
    emptyExpected === null
    && emptyExpected !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    && emptyPlan.every((step) => step.kind !== 'register')
    && winMcpSource.includes('the guard payload is empty (0 bytes)'),
    `expected=${String(emptyExpected)} kinds=${emptyPlan.map((step) => step.kind).join(',')}`)

  /* ---- J4: deadline IS NORMALIZED, THE WAY CALLERS ARE (JURY-34) ---- */
  // probe-2: `deadline = null` (runPayloadRepair's default) went through
  // `Number(null) === 0`, so the staging deadline was IN THE PAST and the phase
  // ran zero children. One normalizer now owns the rule.
  const T4 = 1_000_000
  const deadlineTable = [
    [null, T4 + 25_000],
    [undefined, T4 + 25_000],
    [0, T4 + 25_000],
    [-1, T4 + 25_000],
    [Number.NaN, T4 + 25_000],
    [T4 + 5_000, T4 + 5_000],
    [T4 + 60_000, T4 + 25_000]
  ]
  const deadlineOk = deadlineTable.every(([deadline, expectedDeadline]) =>
    UP.payloadStagingDeadline({ deadline, startedAt: T4 }) === expectedDeadline)
  check('J4: a `deadline` of null/undefined/0/-1/NaN means UNSET (the full 25 000 staging budget), a real one is honoured, and a far one is capped — `Number(null) === 0` can no longer produce a deadline in the past',
    deadlineOk
    && UP.payloadStagingDeadline({ deadline: null, startedAt: T4 }) === T4 + UP.RELAY_PAYLOAD_REPAIR_TIMEOUT_MS
    && UP.payloadStagingDeadline({ deadline: T4 + 1, startedAt: T4 }) === T4 + 1
    && winMcpSource.includes('payloadStagingDeadline({ deadline, startedAt'),
    `arms=${deadlineTable.map(([deadline]) => UP.payloadStagingDeadline({ deadline, startedAt: T4 }) - T4).join(',')}`)

  /* ---- J5: THE 28 000 CEILING IS A CLAMP ON A CALLER BUDGET --------- */
  // probe-2: with no caller budget the wall is always min(25 000, 28 000), so
  // the "declared ceiling" was unreachable — and the comment said otherwise.
  // index.js now passes WIN_MCP_FORCE_REPAIR_MS (30 000), which TOTAL clamps.
  check('J5: the 28 000 ceiling is documented as a CLAMP on a caller budget (the forced repair passes WIN_MCP_FORCE_REPAIR_MS = 30 000 and gets 28 000), while the default path gets 25 000 — the module no longer claims the ceiling is in use by itself',
    indexSource.includes('timeoutMs: WIN_MCP_FORCE_REPAIR_MS')
    && UP.RELAY_REPAIR_TOTAL_MS === 28_000
    && UP.RELAY_REPAIR_TIMEOUT_MS === 25_000
    && Math.min(30_000, UP.RELAY_REPAIR_TOTAL_MS) === 28_000
    && winMcpSource.includes('clamps it to 28 000'),
    `indexPasses=${indexSource.includes('timeoutMs: WIN_MCP_FORCE_REPAIR_MS')} total=${UP.RELAY_REPAIR_TOTAL_MS} default=${UP.RELAY_REPAIR_TIMEOUT_MS}`)

  /* ---- J6: COUNTERS AND THE DURATION ARE HONEST --------------------- */
  // probe-2/CB-19: `writes === 0` for a plan that CREATED the task, and
  // `record.ms` was the carrier's wall only — the 12-child payload phase was
  // invisible in the one duration field the record published.
  const clockGuest = miniGuest({ msPerChild: 100 })
  UP.resetRelayRepairState()
  const clockRecord = await UP.repairRelay({ port: 47999, force: true, payloadRepair: true, spawnImpl: clockGuest.spawnImpl, now: () => clockGuest.clock.now, log: () => {} })
  UP.resetRelayRepairState()
  check('J6: `steps` counts the children that COMPLETED (so [measure, register] is writes 0 / steps 2, not "nothing happened") and `record.ms` is the WHOLE attempt with a carrier/payload split, not the carrier alone',
    clockRecord.payload.steps === 12
    && clockRecord.payload.writes === 9
    && clockRecord.payloadMs > 0
    && clockRecord.carrierMs > 0
    && Math.abs(clockRecord.ms - (clockRecord.carrierMs + clockRecord.payloadMs)) <= 1
    && clockRecord.ms > clockRecord.carrierMs
    && tasklessRecord.payload.steps === 2
    && tasklessRecord.payload.writes === 0,
    `steps=${clockRecord.payload.steps} writes=${clockRecord.payload.writes} ms=${clockRecord.ms} carrier=${clockRecord.carrierMs} payload=${clockRecord.payloadMs} tasklessSteps=${tasklessRecord.payload.steps}`)

  /* ---- R1/R2: THE FROZEN SENTENCE AND A WIDTH-FREE LENGTH NOTE ------ */
  // docs juror (agent-8): the C3 sentence is quoted from the CONSTANT, and the
  // constant had drifted to a hyphen while the plan and the README carry an em
  // dash — nothing pinned it, so it drifted silently. R2: the carrier geometry
  // comment quoted 18 296 as if it were a constant, but the script EMBEDS the
  // port/account, so that number moves with their digits.
  const readmeSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'README.md'), 'utf8')
  check('R1: PAYLOAD_SKEW_SEMANTICS and the README blockquote carry the SAME em dash (U+2014) in the frozen C3 sentence, so the constant cannot drift from the plan and the docs again',
    UP.PAYLOAD_SKEW_SEMANTICS.includes('zero bytes back \u2014 a relay that predates the token')
    && UP.PAYLOAD_SKEW_SEMANTICS.includes('\u2014')
    && readmeSource.includes('zero bytes back \u2014 a relay')
    && UP.PAYLOAD_SKEW_SEMANTICS.includes('It is not a hash comparison'),
    `constant=${UP.PAYLOAD_SKEW_SEMANTICS.includes('\u2014')} readme=${readmeSource.includes('zero bytes back \u2014 a relay')}`)
  check('R2: the carrier-geometry note is WIDTH-INDEPENDENT (the script embeds the port and account, so ≈18 300 for port=47999/user=cua and no frozen 18 296), which ends the constant-swapping drift class',
    winMcpSource.includes('THE LENGTH MOVES WITH THE CONFIGURATION')
    && winMcpSource.includes('≈18 300')
    && winMcpSource.includes('the append count is `ceil(base64 / 6 000)`')
    && winMcpSource.includes('18 296') === false,
    `widthFree=${winMcpSource.includes('THE LENGTH MOVES WITH THE CONFIGURATION')} stale18296=${winMcpSource.includes('18 296')}`)
}
