/**
 * 18-relay-unresponsive.mjs — RELAY_UNRESPONSIVE, the evidence object and the repair sentence.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { EventEmitter, REPO, check, path, readFileSync, winMcpApi } from './harness.mjs'


/* ================================================================== *
 * WP-B — CLIENT TRUTH: THE FUNCTIONAL PROBE, THE EVIDENCE, THE REPAIR
 * SENTENCE AND THE PER-CALL TRANSPORT BUDGET (SOL §4, C1/C2/C3/C5/C6)
 *
 * R1 had two halves and this file is the host one. `RELAY_OK` is an ACCEPT
 * LOOP answer (C1), so the harness needs a SECOND question it can ask the
 * guest — a real `initialize`/`tools/list` round trip — and a token that says
 * "the relay is listening and its child is not answering". The 14 checks
 * below are B-1…B-14 of §4.3, in that order: the token and its rank, the two
 * builders, the never-throwing probe with its five answers, the typing of the
 * evidence, the facts field, the repair sentence, and the transport half of
 * R3 (the 25 s ladder + a retry that is a REQUEST retry, never a reconnect).
 * ================================================================== */
{
  const UP = winMcpApi

  /* ---- B-1: THE TOKEN EXISTS AND IS ITS OWN VALUE ------------------- */
  const tokens = [UP.RELAY_OK, UP.RELAY_BAD, UP.RELAY_DOWN, UP.RELAY_SKEW]
  check('WP-B/B1: RELAY_UNRESPONSIVE is exported and is NOT OK/BAD/DOWN/SKEW (four answers, four values)',
    UP.RELAY_UNRESPONSIVE === 'RELAY_UNRESPONSIVE'
    && tokens.every((token) => token !== UP.RELAY_UNRESPONSIVE)
    && new Set([...tokens, UP.RELAY_UNRESPONSIVE]).size === 5,
    String(UP.RELAY_UNRESPONSIVE))

  /* ---- B-2: RANK 3, AND STILL NOT A USABLE LANE --------------------- */
  // C2 freezes BOTH facts, and they are not in tension: rank orders EVIDENCE
  // ("the child was measured and failed" outranks "we could not read an
  // answer"), `relayOk` orders USABILITY ("may we send a tools/call"). A
  // future reader who collapses them would let a wedged child pass the one
  // gate that exists to catch it — which is exactly how R1 stayed invisible.
  check('WP-B/B2: relayAnswerRank(UNRESPONSIVE)=3 > SKEW=2 > DOWN=1, and relayOk is FALSE for it (rank-3 evidence, unusable lane)',
    UP.relayAnswerRank(UP.RELAY_UNRESPONSIVE) === 3
    && UP.relayAnswerRank(UP.RELAY_UNRESPONSIVE) > UP.relayAnswerRank(UP.RELAY_SKEW)
    && UP.relayAnswerRank(UP.RELAY_SKEW) > UP.relayAnswerRank(UP.RELAY_DOWN)
    && UP.relayAnswerOutranks(UP.RELAY_UNRESPONSIVE, UP.RELAY_SKEW) === true
    && UP.relayAnswerRelayOk(UP.RELAY_UNRESPONSIVE) === false
    && UP.relayAnswerRelayOk(UP.RELAY_OK) === true
    && UP.relayAnswerRelayOk(UP.RELAY_DOWN) === false,
    `rank=${UP.relayAnswerRank(UP.RELAY_UNRESPONSIVE)} relayOk=${UP.relayAnswerRelayOk(UP.RELAY_UNRESPONSIVE)}`)

  /* ---- B-3: THE PROGRAM IS THE SESSION, NOT A PING ------------------ */
  // §11: no `--ping --functional` flag, because a flag is a dependency on a
  // payload staged at machine-create. The program speaks the wire protocol
  // itself: the evidence verb, then the same three frames `connect()` sends.
  const fnProgram = UP.relayFunctionalProbeProgram(47999)
  check('WP-B/B3: the program carries RELAY_FN + a REAL initialize/tools/list session (ids 900001/900002, the port) and no PowerShell',
    typeof fnProgram === 'string'
    && fnProgram.includes('RELAY_FN')
    && fnProgram.includes('initialize')
    && fnProgram.includes('tools/list')
    && fnProgram.includes('900001') && fnProgram.includes('900002')
    && fnProgram.includes('47999')
    && fnProgram.includes('RELAY_UNRESPONSIVE') && fnProgram.includes('RELAY_OK')
    && /powershell|GetBytes|TcpClient/iu.test(fnProgram) === false,
    `${fnProgram.length} bytes, portable python`)

  /* ---- B-4: THE CARRIER IS BASE64, NOT A CLI MODE ------------------- */
  const fnCommand = UP.relayFunctionalProbeCommand(47999)
  const fnDecoded = /b64decode\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/u.exec(String(fnCommand ?? ''))
  check('WP-B/B4: the command is ONE base64 carrier (`exec(__import__(\'base64\').b64decode(`) with no --ping and no --functional flag',
    typeof fnCommand === 'string'
    && fnCommand.includes("exec(__import__('base64').b64decode(")
    && fnCommand.includes('-c "')
    && fnCommand.includes('--ping') === false
    && fnCommand.includes('--functional') === false
    && fnDecoded !== null
    && Buffer.from(fnDecoded[1], 'base64').toString('utf8') === fnProgram,
    `${fnCommand.slice(0, 44)}… (${fnCommand.length} B)`)

  /* ---- THE ONE FAKE SSH CHILD THESE FIVE ANSWERS GO THROUGH --------- */
  const fnStub = ({ stdout = '', stderr = '', exitCode = 0 } = {}) => {
    const calls = []
    const spawnImpl = (_bin, argv) => {
      calls.push({ argv: [...(argv ?? [])] })
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
    return { calls, spawnImpl }
  }
  const FULL = {
    status: 'RELAY_OK',
    measured: true,
    reason: '',
    elapsedMs: 812,
    initializeMs: 120,
    toolsListMs: 260,
    tools: 19,
    mode: 'functional',
    evidenceAt: '2026-11-20T16:00:00Z',
    lastSuccessfulCallAgeMs: 412,
    outstandingRequestAgeMs: null,
    childRestarts: 0,
    lastWedgeAt: null,
    childPid: 4242,
    wedgeDeadlineMs: 20000,
    at: '2026-11-20T16:00:00Z'
  }

  /* ---- B-5: A MEASURED OK ------------------------------------------- */
  const okStub = fnStub({ stdout: `RELAY_OK\n${JSON.stringify(FULL)}\n` })
  const okAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: okStub.spawnImpl, now: () => 1_000 })
  check('WP-B/B5: RELAY_OK + a measured answer ⇒ measured:true, status RELAY_OK, tools:19 — and the probe runs in ONE ssh child with no early-settle seam',
    okAnswer.status === UP.RELAY_OK && okAnswer.measured === true && okAnswer.tools === 19
    && okAnswer.relayOk === true && okAnswer.reason === ''
    && okAnswer.mode === 'functional' && okAnswer.evidenceAt === '2026-11-20T16:00:00Z'
    && okStub.calls.length === 1
    && /base64/u.test(String(okStub.calls[0]?.argv?.at(-1) ?? ''))
    && /b64decode\(/u.test(String(okStub.calls[0]?.argv?.at(-1) ?? '')),
    `${okAnswer.status} measured=${okAnswer.measured} tools=${okAnswer.tools} spawns=${okStub.calls.length}`)

  /* ---- B-6: THE CHILD DID NOT ANSWER -------------------------------- */
  // R1's whole point: the relay is UP and the child is NOT. `measured:false`
  // with `child-silent` is the answer the doctor's `unresponsive` verdict is
  // built on, and it must NOT be RELAY_OK.
  const silentStub = fnStub({ stdout: `RELAY_UNRESPONSIVE\n${JSON.stringify({ measured: false, reason: 'child-silent', mode: 'functional' })}\n` })
  const silentAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: silentStub.spawnImpl, now: () => 1_000 })
  check('WP-B/B6: RELAY_UNRESPONSIVE + child-silent ⇒ status UNRESPONSIVE, measured:false, relayOk:false (the relay answered, the child did not)',
    silentAnswer.status === UP.RELAY_UNRESPONSIVE
    && silentAnswer.measured === false
    && silentAnswer.reason === 'child-silent'
    && silentAnswer.relayOk === false
    && silentAnswer.status !== UP.RELAY_OK,
    `${silentAnswer.status} measured=${silentAnswer.measured} reason=${silentAnswer.reason}`)

  /* ---- B-7: SESSION BUSY IS NOT HEALTH ------------------------------ */
  // The relay answered RELAY_OK, so a careless consumer would call this a
  // healthy lane. NOBODY MEASURED the child, and the answer says so.
  const busyStub = fnStub({ stdout: `RELAY_OK\n${JSON.stringify({ measured: false, reason: 'session-busy', mode: 'functional' })}\n` })
  const busyAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: busyStub.spawnImpl, now: () => 1_000 })
  check('WP-B/B7: RELAY_OK with measured:false/session-busy ⇒ measured:false, reason session-busy — the accept loop health is never borrowed as child health',
    busyAnswer.status === UP.RELAY_OK
    && busyAnswer.measured === false
    && busyAnswer.reason === 'session-busy'
    && busyAnswer.tools === null,
    `${busyAnswer.status} measured=${busyAnswer.measured} reason=${busyAnswer.reason}`)

  /* ---- B-8: A TOKEN WITH NO EVIDENCE LINE --------------------------- */
  // `evidenceAt`/`evidence` must stay null (never a fabricated `0`) and the
  // promise must RESOLVE: a probe that can reject is a probe the doctor's
  // verdict path has to guard, which is how a health check takes a call down.
  let noJsonRejected = null
  const noJsonStub = fnStub({ stdout: 'RELAY_UNRESPONSIVE\n' })
  let noJsonAnswer = null
  try { noJsonAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: noJsonStub.spawnImpl, now: () => 1_000 }) } catch (error) { noJsonRejected = error }
  check('WP-B/B8: a token with NO JSON line ⇒ measured:false, reason no-evidence, evidence:null — and the probe RESOLVES (never rejects)',
    noJsonRejected === null
    && noJsonAnswer?.status === UP.RELAY_UNRESPONSIVE
    && noJsonAnswer?.measured === false
    && noJsonAnswer?.reason === 'no-evidence'
    && noJsonAnswer?.evidence === null
    && noJsonAnswer?.evidenceAt === null,
    noJsonRejected === null ? `${noJsonAnswer?.status}/${noJsonAnswer?.reason}` : String(noJsonRejected?.message ?? noJsonRejected))

  /* ---- B-9: NOTHING ON THE WIRE IS A TRANSPORT FACT ----------------- */
  // exit 255 is ssh's own "I never got a session". That is RELAY_DOWN, not
  // UNRESPONSIVE: the child was never asked, so nothing about it was measured.
  const downStub = fnStub({ stdout: '', stderr: 'ssh: connect to host 127.0.0.1 port 47222: Connection refused', exitCode: 255 })
  const downAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: downStub.spawnImpl, now: () => 1_000 })
  check('WP-B/B9: silence + exit 255 ⇒ status RELAY_DOWN (a TRANSPORT failure, NOT the child) with no measured claim',
    downAnswer.status === UP.RELAY_DOWN
    && downAnswer.measured === false
    && downAnswer.relayOk === false
    && downAnswer.connectionLevel === true
    && downAnswer.evidence === null,
    `${downAnswer.status} connectionLevel=${downAnswer.connectionLevel} exit=${downAnswer.exitCode}`)

  /* ---- B-10: EVIDENCE TYPING (C3) ----------------------------------- */
  // `null` means "the relay never delivered one"; `0` means "measured: no
  // restarts". Collapsing them is how `measured:false` became "all facts
  // false" in the desktop-facts defect — the same mistake, one file over.
  const typedStub = fnStub({ stdout: `RELAY_OK\n${JSON.stringify({ measured: true, reason: '', tools: 19, lastSuccessfulCallAgeMs: 412, outstandingRequestAgeMs: null, childRestarts: 0, lastWedgeAt: null, childPid: 77, wedgeDeadlineMs: 20000 })}\n` })
  const typedAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: typedStub.spawnImpl, now: () => 1_000 })
  check('WP-B/B10: evidence typing — 412 stays 412, an explicit null stays null (never 0), 0 stays 0, and an absent key is null',
    typedAnswer.evidence?.lastSuccessfulCallAgeMs === 412
    && typedAnswer.evidence?.outstandingRequestAgeMs === null
    && typedAnswer.evidence?.childRestarts === 0
    && typedAnswer.evidence?.lastWedgeAt === null
    && typedAnswer.evidence?.childPid === 77
    && typedAnswer.evidence?.wedgeDeadlineMs === 20000
    && UP.normalizeRelayEvidence({ lastSuccessfulCallAgeMs: -5, childRestarts: 'x' })?.lastSuccessfulCallAgeMs === null
    && UP.normalizeRelayEvidence({ at: 'now' }) === null,
    JSON.stringify(typedAnswer.evidence))

  /* ---- B-11: THE FACTS FIELD AND ITS OWNER -------------------------- */
  // `doctorFacts()` is synchronous and side-effect free, so it can only carry
  // the LAST answer. `null` before one ran is the honest value: nothing
  // measured is not a healthy child (C1.2).
  const factsClient = UP.createDshCuaClient({ name: 'wp-b-facts', sshPort: 1 })
  const factsAnswer = factsClient.doctorFacts()
  const fieldsText = String(UP.DOCTOR_FACTS_FIELDS ?? '')
  const namedKeys = ['lastSuccessfulCallAgeMs', 'outstandingRequestAgeMs', 'childRestarts', 'lastWedgeAt', 'childPid']
  check('WP-B/B11: doctorFacts() carries relayFunctional (null until a probe ran) and DOCTOR_FACTS_FIELDS names it plus the C3 evidence keys',
    'relayFunctional' in factsAnswer
    && factsAnswer.relayFunctional === null
    && typeof factsClient.relayFunctionalProbe === 'function'
    && fieldsText.includes('relayFunctional')
    && namedKeys.every((key) => fieldsText.includes(key)),
    `relayFunctional=${JSON.stringify(factsAnswer.relayFunctional)} keys=${namedKeys.filter((key) => fieldsText.includes(key)).length}/5`)

  /* ---- B-12: THE SENTENCE AN UNMEASURED REPAIR GETS ----------------- */
  // R1b, exactly: `forcedRepair.ok:false` with `reason:""` was the observable
  // result. The sentence names WHY and carries the record's own detail bytes.
  const unmeasuredSentence = String(UP.describeRepairRecord({ measured: false, unmeasured: 'no-record', detail: 'throttled (30000 ms)' }) ?? '')
  check('WP-B/B12: describeRepairRecord() for an UNMEASURED record is a non-empty sentence naming the unmeasured reason and the detail',
    unmeasuredSentence !== ''
    && unmeasuredSentence.includes('no-record')
    && unmeasuredSentence.includes('throttled (30000 ms)')
    && unmeasuredSentence.startsWith('the guest never answered the repair'),
    unmeasuredSentence)

  /* ---- B-13: A MEASURED RECORD SPEAKS FOR ITSELF -------------------- */
  // The other half of the same contract: `''` is reserved for the record whose
  // OWN `reason` is the diagnosis (`task-missing` here), so index.js can keep
  // it byte-identical. And `reason:""` is otherwise impossible: even a record
  // that does not say why gets `no-record` plus `no detail`.
  check('WP-B/B13: describeRepairRecord() for a MEASURED record that NAMED a cause is exactly \'\' (its own reason wins, byte-identical), and an unknown unmeasured value still yields words',
    UP.describeRepairRecord({ measured: true, ok: false, reason: 'task-missing' }) === ''
    && UP.describeRepairRecord({ measured: true, ok: true, reason: 'repaired' }) === ''
    && UP.describeRepairRecord(null) !== ''
    && UP.describeRepairRecord({ measured: false }) !== ''
    && String(UP.describeRepairRecord({ measured: false })).includes('no-record')
    && String(UP.describeRepairRecord({ measured: false, unmeasured: 'throttled' })).includes('no detail'),
    JSON.stringify(UP.describeRepairRecord({ measured: false })))

  /* ---- B-14: THE TRANSPORT HALF OF R3 ------------------------------- */
  //
  // Four facts, one transport:
  //   (a) the C5 ladder is 20 000 (guest) < 25 000 (transport) < 26 000
  //       (envelope) and every larger number DERIVES from the transport;
  //   (b) `callTool(..., {timeoutMs})` gives that request exactly that budget,
  //       so a 40 ms call beats the 60 s attach handshake by three orders of
  //       magnitude (B-14 of §4.3);
  //   (c) a per-call timeout is a REQUEST timeout: the child is not killed, the
  //       session survives and the next call answers on the SAME ssh child —
  //       which is what makes the plugin's one retry a request retry and not a
  //       transport reconnect (WIN_MCP_RETRY_SEMANTICS);
  //   (d) a guest `child-wedged:` answer is rethrown with `code:'child-wedged'`
  //       and the guest's sentence verbatim (C4.5/C6).
  const keepAlive = setInterval(() => {}, 1_000)
  let sessionSpawns = 0
  let sessionKills = 0
  const sessionSpawn = (_bin, argv) => {
    sessionSpawns += 1
    const remote = String(argv?.at(-1) ?? '')
    const isSession = remote.includes('--connect')
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.stdout.setEncoding = () => {}
    child.stderr.setEncoding = () => {}
    child.stdin.end = () => {}
    // ONLY the session child's death counts: `runSshCapture` kills a PROBE child
    // on purpose once it settles early, and that is not a reconnect.
    child.kill = () => { if (isSession) sessionKills += 1 }
    child.stdin.write = (data) => {
      for (const line of String(data ?? '').split('\n')) {
        if (line.trim() === '') continue
        let message = null
        try { message = JSON.parse(line) } catch { continue }
        if (message?.id === undefined) continue
        const send = (payload) => setTimeout(() => child.stdout.emit('data', `${JSON.stringify(payload)}\n`), 0)
        if (message.method === 'initialize') {
          send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'dsh-cua', version: '0.4.1' }, capabilities: { tools: {} } } })
        } else if (message.method === 'tools/list') {
          send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'tool_list_windows', description: 'x', inputSchema: { type: 'object' } }] } })
        } else if (message.method === 'tools/call') {
          const name = String(message.params?.name ?? '')
          if (name === 'tool_read_clipboard') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } })
          else if (name === 'tool_type_text') send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'child-wedged: the MCP server did not answer in 20000 ms; killed pid 42 (restart #1); the call did not return, so its effect is UNKNOWN - re-observe before retrying' } })
          // tool_list_windows stays SILENT: the per-call timer is the only thing
          // that can end it, which is the point of (b).
        }
      }
      return true
    }
    setTimeout(() => {
      if (isSession) return
      child.stdout.emit('data', 'RELAY_OK\n')
      child.emit('exit', 0)
      child.emit('close', 0)
    }, 0)
    return child
  }
  const ladder = UP.winMcpCallBudgets()
  const scaled = UP.winMcpCallBudgets(UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '200' }))
  let budgetError = null
  let wedgedError = null
  let retryResult = null
  let connectError = null
  const budgetClient = UP.createDshCuaClient({ name: 'wp-b-budget', sshPort: 47200, isOnline: async () => true, spawnImpl: sessionSpawn, timeoutMs: 60_000 })
  try {
    try { await budgetClient.connect() } catch (error) { connectError = error }
    const spawnsAfterConnect = sessionSpawns
    const startedAt = Date.now()
    try { await budgetClient.callTool('tool_list_windows', {}, { timeoutMs: 40 }) } catch (error) { budgetError = error }
    const budgetWallMs = Date.now() - startedAt
    try { retryResult = await budgetClient.callTool('tool_read_clipboard', {}, { timeoutMs: 500 }) } catch (error) { retryResult = error }
    try { await budgetClient.callTool('tool_type_text', {}, { timeoutMs: 500 }) } catch (error) { wedgedError = error }
    check('WP-B/B14: the C5 ladder (20 000 < 25 000 < 26 000) + an explicit 40 ms per-call budget that fires in <500 ms while the SESSION survives (no kill, no respawn) so the retry is a request retry, and `child-wedged:` becomes code child-wedged',
      connectError === null
      && UP.WIN_MCP_WEDGE_DEADLINE_MS === 20_000
      && UP.WIN_MCP_TRANSPORT_BUDGET_MS === 25_000
      && UP.WIN_MCP_CALL_ENVELOPE_MS === 26_000
      && ladder.wedgeDeadlineMs === 20_000 && ladder.transportMs === 25_000
      && ladder.envelopeMs === 26_000 && ladder.retryBudgetMs === 56_000 && ladder.guardMs === 30_000
      && ladder.wedgeDeadlineMs < ladder.transportMs && ladder.transportMs < ladder.envelopeMs
      && scaled.transportMs === 200 && scaled.envelopeMs === 1_200 && scaled.retryBudgetMs === 6_400
      && UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '999999' }) === 120_000
      && UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '1' }) === 200
      && budgetError?.code === 'timeout'
      && /within 40 ms/u.test(String(budgetError?.message ?? '')) === true
      && budgetWallMs < 500
      && sessionKills === 0 && sessionSpawns === spawnsAfterConnect
      && budgetClient.state.connected === true
      && retryResult?.content?.[0]?.text === 'ok'
      && wedgedError?.code === 'child-wedged'
      && String(wedgedError?.message ?? '').startsWith('child-wedged: the MCP server did not answer in 20000 ms'),
      `wall=${budgetWallMs}ms code=${budgetError?.code} kills=${sessionKills} spawns=${sessionSpawns} retry=${retryResult?.content?.[0]?.text} wedged=${wedgedError?.code}`)
  } finally {
    clearInterval(keepAlive)
    try { budgetClient.close() } catch { /* the fake session has no process */ }
  }

  /* ---- D3: NO DERIVED BUDGET ESCAPES THE DOCUMENTED ENVELOPE -------- */
  //
  // PRE-REVISE DEFECT #3. `DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS=120000` is inside the
  // env's frozen 200..120000 clamp, but the UNCLAMPED arithmetic derived
  // envelope 121 000 / retry 246 000 / guard 125 000 — three walls the harness
  // was never told about (`toolCallTimeoutMs: 120000`). The ladder is clamped to
  // WIN_MCP_TOOL_CALL_ENVELOPE_MS, so the ceiling setting degenerates honestly
  // (one 120 s attempt) instead of asking for a 246 s retry budget.
  const ceiling = UP.winMcpCallBudgets(UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '120000' }))
  const sweep = ['200', '25000', '57000', '119999', '120000', '999999'].map((value) =>
    UP.winMcpCallBudgets(UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: value })))
  check('WP-B/D3: every DERIVED budget is clamped to the documented 120 000 toolCallTimeoutMs envelope (at the transport ceiling: 120000/120000/120000, not 121000/246000/125000)',
    UP.WIN_MCP_TOOL_CALL_ENVELOPE_MS === 120_000
    && ceiling.transportMs === 120_000
    && ceiling.envelopeMs === 120_000
    && ceiling.retryBudgetMs === 120_000
    && ceiling.guardMs === 120_000
    && sweep.every((budget) => budget.envelopeMs <= 120_000
      && budget.retryBudgetMs <= 120_000
      && budget.guardMs <= 120_000)
    // ...and the frozen default ladder is untouched by the clamp.
    && JSON.stringify(UP.winMcpCallBudgets()) === JSON.stringify({
      wedgeDeadlineMs: 20_000, transportMs: 25_000, envelopeMs: 26_000, retryBudgetMs: 56_000, guardMs: 30_000
    })
    // ...and 57 000 is the largest transport that still derives the full retry
    // budget inside the envelope (58 000 envelope ⇒ exactly 120 000).
    && UP.winMcpCallBudgets(57_000).retryBudgetMs === 120_000,
    `ceiling=${ceiling.envelopeMs}/${ceiling.retryBudgetMs}/${ceiling.guardMs} sweepMax=${Math.max(...sweep.map((b) => b.retryBudgetMs))}`)

  /* ---- D5: ONE KNOB, ONE ROUNDING (win-mcp.js === index.js) ---------- */
  //
  // PRE-REVISE DEFECT #5: win-mcp.js used `Math.round` while index.js's
  // winMcpCallTimeoutMs() uses `Math.floor`, so '25000.5' became 25 001 in the
  // transport and 25 000 in the plugin — a 1 ms split budget nobody can see.
  // Both readers now FLOOR, and the check pins BOTH halves: the behaviour here,
  // and the literal in the other file (the cross-file half is a source slice,
  // because index.js does not export its reader and importing the plugin would
  // register tools as a side effect).
  const winSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'win-mcp.js'), 'utf8')
  const indexSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
  const readerSlice = (source, marker) => {
    const start = source.indexOf(marker)
    if (start === -1) return ''
    const end = source.indexOf('\n}\n', start)
    return end === -1 ? source.slice(start, start + 1_500) : source.slice(start, end + 2)
  }
  const transportReader = readerSlice(winSource, 'export function winMcpTransportBudgetMs(')
  const pluginReader = readerSlice(indexSource, 'function winMcpCallTimeoutMs()')
  check('WP-B/D5: a fractional override floors in BOTH readers ("25000.5" ⇒ 25000, never 25001) — one knob, one rounding, no split budget',
    UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '25000.5' }) === 25_000
    && UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '25000.9' }) === 25_000
    && UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '25000.0' }) === 25_000
    // ...a sub-1 ms value floors to 0, which both readers treat as UNSET.
    && UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '0.5' }) === UP.WIN_MCP_TRANSPORT_BUDGET_MS
    // THE CROSS-FILE HALF: both reader bodies say Math.floor, neither says Math.round.
    && transportReader.includes('Math.floor(')
    && transportReader.includes('Math.round(') === false
    && pluginReader.includes('Math.floor(')
    && pluginReader.includes('Math.round(') === false
    // ...the SAME env name: win-mcp.js reads it through its exported constant,
    // index.js spells the literal — both must name one variable.
    && transportReader.includes('WIN_MCP_CALL_TIMEOUT_ENV')
    && UP.WIN_MCP_CALL_TIMEOUT_ENV === 'DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS'
    && pluginReader.includes('DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS'),
    `25000.5 ⇒ ${UP.winMcpTransportBudgetMs({ DSH_CUA_WIN_MCP_CALL_TIMEOUT_MS: '25000.5' })}; readers: win=${transportReader.length}B index=${pluginReader.length}B floor=${transportReader.includes('Math.floor(')}/${pluginReader.includes('Math.floor(')}`)

  /* ---- D8: A MEASURED REPAIR WITH NO REASON IS NOT SILENCE ---------- */
  //
  // PRE-REVISE DEFECT #8: `measured:true` returned `''` unconditionally, so a
  // measured, FAILED repair whose guest sentence was empty still surfaced as
  // `forcedRepair.reason:''` — the R1b silence, one branch further in. A record
  // that NAMED a cause keeps the byte-identical `''` path (the caller keeps the
  // record's own reason); a record that did not name one now says so.
  const unreasoned = String(UP.describeRepairRecord({ measured: true, ok: false }) ?? '')
  const unreasonedDetail = String(UP.describeRepairRecord({ measured: true, ok: true, detail: 'probe RELAY_OK' }) ?? '')
  check('WP-B/D8: a MEASURED record with an EMPTY reason is a non-empty honest sentence (never \'\'), while the measured-with-own-reason path stays byte-identical \'\'',
    unreasoned === 'the repair ran and reported no reason'
    && unreasonedDetail === 'the repair ran and reported no reason: probe RELAY_OK'
    && UP.describeRepairRecord({ measured: true, ok: false, reason: '' }) !== ''
    && UP.describeRepairRecord({ measured: true, ok: false, reason: 'task-missing' }) === ''
    && UP.describeRepairRecord({ measured: true, ok: false, reason: 'no-interactive-session' }) === '',
    JSON.stringify({ unreasoned, unreasonedDetail, named: UP.describeRepairRecord({ measured: true, ok: false, reason: 'task-missing' }) }))

  /* ---- D9: THE CLOSED REASON SET IS EXACTLY WHAT A PRODUCER EMITS --- */
  //
  // The set is a CLOSED vocabulary, and a member no producer can emit is a word
  // the doctor's sentences were never written for. `'wedge'` was that member:
  // the program's exits are ''/child-silent/child-eof/session-busy/no-evidence,
  // and the relay's RELAY_FN evidence carries no `reason` field at all — a wedge
  // is visible as `event('wedge', …)` / `lastWedgeAt`, never as an answer. It is
  // gone from the constant (a guest that claims it now normalizes to
  // 'no-evidence', exactly like any other out-of-set value), and this check pins
  // the EXACT five members so a surplus one cannot come back.
  const reasonSet = UP.RELAY_FN_REASONS
  const reasonStub = (reason) => fnStub({ stdout: `RELAY_UNRESPONSIVE\n${JSON.stringify({ measured: false, reason, mode: 'functional' })}\n` })
  const emitted = []
  for (const reason of ['child-silent', 'child-eof', 'session-busy', 'no-evidence']) {
    const answer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: reasonStub(reason).spawnImpl, now: () => 1_000 })
    emitted.push(answer.reason)
  }
  const wedgeStubAnswer = await UP.relayFunctionalProbe({ port: 47999, spawnImpl: reasonStub('wedge').spawnImpl, now: () => 1_000 })
  check('WP-B/D9: RELAY_FN_REASONS is EXACTLY the producer-emitted reasons (no surplus `wedge`; `probe-unsupported` is the cold-boot round\'s sixth), frozen, and an out-of-set reason normalizes to no-evidence',
    Array.isArray(reasonSet) === true
    && Object.isFrozen(reasonSet) === true
    && reasonSet.length === 6
    && JSON.stringify(reasonSet) === JSON.stringify(['', 'child-silent', 'child-eof', 'session-busy', 'no-evidence', 'probe-unsupported'])
    && reasonSet.includes('wedge') === false
    && reasonSet.includes('') === true
    // every member that names a cause survives the round trip…
    && JSON.stringify(emitted) === JSON.stringify(['child-silent', 'child-eof', 'session-busy', 'no-evidence'])
    // …and a retired member is not forwarded, it is replaced by the honest one.
    && wedgeStubAnswer.reason === 'no-evidence'
    && wedgeStubAnswer.reason !== 'wedge',
    `${JSON.stringify(reasonSet)} | emitted=${JSON.stringify(emitted)} | wedge⇒${wedgeStubAnswer.reason}`)
}
