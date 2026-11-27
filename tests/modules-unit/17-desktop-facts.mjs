/**
 * 17-desktop-facts.mjs — the guest desktop facts, the timeouts and the click-scale probes.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { EventEmitter, REPO, check, checkContract, path, readFileSync, winMcpApi } from './harness.mjs'


/* ================================================================== *
 * WP-6.3 — THE DESKTOP FACTS READER (C1-C5, SOL §4.3/Appendix B)
 *
 * `desktopFacts()` is the ONE reader of what the desktop session measured, and
 * its contract is a list of "never"s: never throws, never claims a field it did
 * not read, never spends a second ssh inside the TTL, and never lets a dead
 * `win32ui` look like a healthy lane. Each check below drives it through the
 * `spawnImpl` seam the real client already exposes, so no guest and no ssh
 * binary are involved — only the code that ships.
 *
 * (Writer D's seam notes are the contract asserted here: options
 * `{host, port, user, keyPath, timeoutMs=8000, ttlMs=60000, force, spawnImpl,
 * now, log}`; a MEASURED answer is cached 60 s, a FAILURE 5 s; `runSshCapture`
 * is exported; a successful JSON-RPC answer CLEARS `lastFailureKind`; a fake
 * child must be EventEmitter-shaped; the client carries `desktopFacts()`,
 * `refreshDesktopFacts()`, `desktopFactsCached()`, `state.lastFailureKind` and
 * `state.desktop`.)
 * ================================================================== */
{
  const desktopFacts = typeof winMcpApi.desktopFacts === 'function' ? winMcpApi.desktopFacts : null
  const resetDesktopFactsCache = typeof winMcpApi.resetDesktopFactsCache === 'function' ? winMcpApi.resetDesktopFactsCache : () => {}
  /**
   * ONE FAKE SSH CHILD, the shape `runSshCapture` drives: stdout/stderr streams,
   * `kill()`, and a `close` event. Emitted on a timer so the capture's listeners
   * are attached first (a synchronous emit would be lost).
   */
  const sshStub = ({ stdout = '', stderr = '', exitCode = 0, delayMs = 0 } = {}) => {
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
      }, delayMs)
      return child
    }
    return { calls, spawnImpl }
  }
  const APPENDIX_B = {
    schema: 1,
    measured: true,
    at: '2026-11-19T15:04:05Z',
    user: 'cua',
    session: 2,
    python: 'C:\\Program Files\\Python312\\python.exe',
    dshCuaVersion: '0.4.1',
    pywin32Version: '306',
    win32ui: false,
    uiaLane: true,
    scaleFix: 'skipped:anchor',
    workDir: 'C:\\cua-work',
    workDirWritable: true,
    profileRootWritable: false,
    source: 'cua-work',
    error: ''
  }

  // ---- C1: a valid file ⇒ measured facts, and the DEAD lane is derived ----
  if (desktopFacts === null) {
    checkContract('WP-6.3/C1: desktopFacts() reads the guest file and derives elementLaneOk', false, false,
      'the export is absent', 'win-mcp.js must export desktopFacts()')
  } else {
    resetDesktopFactsCache()
    const stub = sshStub({ stdout: JSON.stringify(APPENDIX_B) })
    let facts = null
    let threw = null
    try { facts = await desktopFacts({ port: 47101, spawnImpl: stub.spawnImpl, now: () => 1_000 }) } catch (error) { threw = error }
    check('WP-6.3/C1: desktopFacts() reads the guest file with ONE bounded ssh and never throws',
      threw === null && stub.calls.length === 1 && facts?.measured === true,
      threw === null ? `${stub.calls.length} spawn(s)` : String(threw?.message ?? threw))
    check('WP-6.3/C1: ...`win32ui:false` becomes `elementLaneOk:false` (the D1 signature)',
      facts?.win32ui === false && facts?.uiaLane === true && facts?.elementLaneOk === false,
      `win32ui=${facts?.win32ui} uiaLane=${facts?.uiaLane} elementLaneOk=${facts?.elementLaneOk}`)
    check('WP-6.3/C1: ...and the typed fields are the file\'s, not defaults',
      facts?.dshCuaVersion === '0.4.1' && facts?.pywin32Version === '306'
      && facts?.session === 2 && facts?.workDirWritable === true
      && facts?.profileRootWritable === false && facts?.scaleFix === 'skipped:anchor'
      && facts?.source === 'cua-work' && facts?.schema === 1,
      JSON.stringify({ v: facts?.dshCuaVersion, s: facts?.session, w: facts?.workDirWritable, scaleFix: facts?.scaleFix }))
    check('WP-6.3/C1: ...the read asks for the two documented paths in ONE command (work dir, then %TEMP%)',
      String(stub.calls[0]?.argv?.at(-1) ?? '').includes('C:\\cua-work\\cua-desktop-facts.json')
      && String(stub.calls[0]?.argv?.at(-1) ?? '').includes('cua-desktop-facts.json'),
      String(stub.calls[0]?.argv?.at(-1) ?? '').slice(0, 120))

    // ---- C2: nothing readable ⇒ measured:false + an error, still no throw ----
    resetDesktopFactsCache()
    const empty = sshStub({ stdout: '', stderr: 'The system cannot find the file specified.', exitCode: 1 })
    let unreadable = null
    let unreadableThrew = null
    try { unreadable = await desktopFacts({ port: 47102, spawnImpl: empty.spawnImpl, now: () => 1_000 }) } catch (error) { unreadableThrew = error }
    check('WP-6.3/C2: an unreadable guest answers {measured:false, source:"none", error} and never rejects',
      unreadableThrew === null && unreadable?.measured === false && unreadable?.source === 'none'
      && typeof unreadable?.error === 'string' && unreadable.error !== '',
      unreadableThrew === null ? String(unreadable?.error ?? '').slice(0, 100) : String(unreadableThrew?.message ?? unreadableThrew))
    check('WP-6.3/C2: ...and EVERY measured field is UNKNOWN (null), never `false`',
      unreadable?.win32ui === null && unreadable?.workDirWritable === null && unreadable?.elementLaneOk === null
      && unreadable?.scaleFix === null,
      JSON.stringify({ win32ui: unreadable?.win32ui, workDirWritable: unreadable?.workDirWritable, scaleFix: unreadable?.scaleFix }))

    // ---- C3: the TTL is one ssh per window, and `force` is the escape ----
    resetDesktopFactsCache()
    const ttlStub = sshStub({ stdout: JSON.stringify(APPENDIX_B) })
    const clock = { now: 5_000 }
    const first = await desktopFacts({ port: 47103, spawnImpl: ttlStub.spawnImpl, now: () => clock.now })
    clock.now += 1_000
    const second = await desktopFacts({ port: 47103, spawnImpl: ttlStub.spawnImpl, now: () => clock.now })
    check('WP-6.3/C3: two reads inside the 60 s TTL spend exactly ONE ssh child',
      ttlStub.calls.length === 1 && first?.cached === false && second?.cached === true,
      `${ttlStub.calls.length} spawn(s), cached=${second?.cached}`)
    clock.now += 60_001
    const afterTtl = await desktopFacts({ port: 47103, spawnImpl: ttlStub.spawnImpl, now: () => clock.now })
    check('WP-6.3/C3: ...a read AFTER the window spawns again (the cache is a TTL, not a latch)',
      ttlStub.calls.length === 2 && afterTtl?.cached === false, `${ttlStub.calls.length} spawn(s)`)
    await desktopFacts({ port: 47103, spawnImpl: ttlStub.spawnImpl, now: () => clock.now, force: true })
    check('WP-6.3/C3: ...and `force` bypasses the window (the doctor\'s one-shot read)',
      ttlStub.calls.length === 3, `${ttlStub.calls.length} spawn(s)`)

    // ---- C3b: a FAILURE is cached for 5 s, not the 60 s a measurement gets ----
    //
    // (Writer D's note: the measured answer lives 60 s, the failure 5 s — a
    // booting guest must be re-read soon, a healthy one must not cost an ssh
    // child per doctor call.) The TTL above is written against VALID JSON on
    // purpose: a failure cache of 60 s would make the healthy case unreachable.
    resetDesktopFactsCache()
    const failStub = sshStub({ stdout: '', stderr: 'The system cannot find the file specified.', exitCode: 1 })
    const failClock = { now: 10_000 }
    await desktopFacts({ port: 47106, spawnImpl: failStub.spawnImpl, now: () => failClock.now })
    failClock.now += 1_000
    const cachedFailure = await desktopFacts({ port: 47106, spawnImpl: failStub.spawnImpl, now: () => failClock.now })
    check('WP-6.3/C3b: a failed read is cached for 5 s (one ssh per boot window, not per doctor call)',
      failStub.calls.length === 1 && cachedFailure?.measured === false,
      `${failStub.calls.length} spawn(s) inside 1 s, measured=${cachedFailure?.measured}`)
    failClock.now += 5_001
    await desktopFacts({ port: 47106, spawnImpl: failStub.spawnImpl, now: () => failClock.now })
    check('WP-6.3/C3b: ...and after 5 s it re-reads (the boot race is retried, never pinned)',
      failStub.calls.length === 2 && winMcpApi.DESKTOP_FACTS_FAILURE_TTL_MS === 5000,
      `${failStub.calls.length} spawn(s); failureTtl=${winMcpApi.DESKTOP_FACTS_FAILURE_TTL_MS}`)

    // ---- C4: the boot-race signature is CONNECTION-LEVEL, and the kind follows ----
    resetDesktopFactsCache()
    const closed = sshStub({ stdout: '', stderr: 'Connection closed by 127.0.0.1 port 22', exitCode: 255 })
    const closedFacts = await desktopFacts({ port: 47104, spawnImpl: closed.spawnImpl, now: () => 1_000 })
    const sshConnectionLevel = typeof winMcpApi.sshConnectionLevel === 'function' ? winMcpApi.sshConnectionLevel : null
    const classify = typeof winMcpApi.classifySshFailureKind === 'function' ? winMcpApi.classifySshFailureKind : null
    check('WP-6.3/C4: a 255 `Connection closed` capture is `connectionLevel:true` (the boot race, not a guest answer)',
      closedFacts?.connectionLevel === true && closedFacts?.measured === false,
      `connectionLevel=${closedFacts?.connectionLevel} measured=${closedFacts?.measured}`)
    check('WP-6.3/C4: ...the classifier calls it `ssh-closed`, and an auth refusal is NOT ssh-closed',
      sshConnectionLevel?.({ exitCode: 255, stderr: '' }) === true
      && sshConnectionLevel?.({ exitCode: 1, stderr: 'The system cannot find the file specified.' }) === false
      // THE STDERR-ONLY PATH IS THE ONE THE CLIENT USES for its first
      // classification (`recordFailureKind(text, null)`), and there an auth
      // refusal must NOT read as the boot race. Exit 255 is ssh's own code and
      // wins over the text by design, so that precedence is asserted too.
      && classify?.({ text: 'Connection closed by 127.0.0.1 port 22' }) === 'ssh-closed'
      && classify?.({ text: 'Permission denied (publickey).' }) === 'auth'
      && classify?.({ text: 'Permission denied (publickey).', exitCode: 255 }) === 'ssh-closed'
      && classify?.({ text: 'JSON-RPC initialize failed', exitCode: 1 }) === 'handshake',
      `${classify?.({ text: 'Connection closed by 127.0.0.1 port 22' })}/${classify?.({ text: 'Permission denied (publickey).' })}/${classify?.({ text: 'JSON-RPC initialize failed', exitCode: 1 })}`)

    // ---- C4b: the CLIENT records the kind beside a BYTE-IDENTICAL lastError ----
    const sessionStderr = 'Connection closed by 127.0.0.1 port 22'
    const clientSpawn = (_bin, argv) => {
      const last = String(argv?.at(-1) ?? '')
      const isSession = last.includes('dsh_cua.server') || last.includes('--connect')
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = new EventEmitter()
      child.stdin.write = () => true
      child.stdin.end = () => {}
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      setTimeout(() => {
        if (isSession) {
          child.stderr.emit('data', `${sessionStderr}\n`)
          child.emit('exit', 255)
          child.emit('close', 255)
        } else {
          child.stdout.emit('data', 'RELAY_DOWN\n')
          child.emit('exit', 0)
          child.emit('close', 0)
        }
      }, 0)
      return child
    }
    let connectThrew = null
    const failingClient = winMcpApi.createDshCuaClient({
      name: 'facts-c4', sshPort: 47105, isOnline: async () => true, spawnImpl: clientSpawn, timeoutMs: 2_000
    })
    try { await failingClient.connect() } catch (error) { connectThrew = error }
    const failingFacts = failingClient.doctorFacts()
    check('WP-6.3/C4: a refused session makes connect() reject (it never resolves a dead bridge)',
      connectThrew !== null, String(connectThrew?.code ?? connectThrew?.message ?? 'no error'))
    check('WP-6.3/C4: ...`lastFailureKind` is `ssh-closed` and `lastError` is the SAME text as before',
      failingFacts?.lastFailureKind === 'ssh-closed' && failingClient.state.lastError === sessionStderr,
      `kind=${failingFacts?.lastFailureKind} lastError=${JSON.stringify(failingClient.state.lastError)}`)

    // ---- C4c: the kind CLEARS on the next successful JSON-RPC answer ----
    const successSpawn = (_bin, argv) => {
      const last = String(argv?.at(-1) ?? '')
      const isSession = last.includes('dsh_cua.server') || last.includes('--connect')
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = new EventEmitter()
      child.stdout.setEncoding = () => {}
      child.stderr.setEncoding = () => {}
      child.kill = () => {}
      child.stdin.write = (data) => {
        for (const line of String(data ?? '').split('\n')) {
          if (line.trim() === '') continue
          let message = null
          try { message = JSON.parse(line) } catch { continue }
          if (message?.id === undefined) continue
          const result = message.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dsh-cua', version: '0.4.1' } }
            : { tools: [] }
          setTimeout(() => child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`), 0)
        }
        return true
      }
      child.stdin.end = () => {}
      setTimeout(() => {
        if (isSession) child.stderr.emit('data', 'Connection closed by 127.0.0.1 port 22\n')
        else { child.stdout.emit('data', 'RELAY_DOWN\n'); child.emit('exit', 0); child.emit('close', 0) }
      }, 0)
      return child
    }
    const recovered = winMcpApi.createDshCuaClient({
      name: 'facts-c4c', sshPort: 47107, isOnline: async () => true, spawnImpl: successSpawn, timeoutMs: 2_000
    })
    let recoveredThrew = null
    try { await recovered.connect() } catch (error) { recoveredThrew = error }
    const recoveredFacts = recovered.doctorFacts()
    check('WP-6.3/C4c: a successful JSON-RPC answer CLEARS `lastFailureKind` (a healed link is not still "ssh-closed")',
      recoveredThrew === null && recoveredFacts?.lastFailureKind === null
      && recovered.state.lastError === 'Connection closed by 127.0.0.1 port 22',
      `connected=${recovered.state.connected} kind=${JSON.stringify(recoveredFacts?.lastFailureKind)} lastError=${JSON.stringify(recovered.state.lastError)}`)
    try { recovered.close() } catch { /* already gone */ }
    check('WP-6.3/C4c: ...and `runSshCapture` is an exported seam (the capture half is testable on its own)',
      typeof winMcpApi.runSshCapture === 'function' && typeof winMcpApi.sshConnectionLevel === 'function')

    // ---- C5: the frozen three-sentence table, and the empty answer for the rest ----
    const contract = winMcpApi.WINDOWS_TOOL_CONTRACT
    const windowsToolContract = typeof winMcpApi.windowsToolContract === 'function' ? winMcpApi.windowsToolContract : null
    check('WP-6.3/C5: WINDOWS_TOOL_CONTRACT has exactly the three Appendix C keys',
      contract !== undefined && Object.keys(contract).length === 3
      && ['tool_open_application', 'tool_send_keys', 'tool_capture_window'].every((key) => typeof contract[key] === 'string'),
      JSON.stringify(Object.keys(contract ?? {})))
    check('WP-6.3/C5: ...and every OTHER guest tool gets the EMPTY note (no accidental fourth)',
      windowsToolContract !== null && windowsToolContract('tool_click_at') === ''
      && windowsToolContract('find_elements') === '' && windowsToolContract('') === ''
      && windowsToolContract('tool_open_application') === contract?.tool_open_application,
      `tool_click_at=${JSON.stringify(windowsToolContract?.('tool_click_at'))}`)
  }
}

/* ================================================================== *
 * WP-6.3 — SOURCE ASSERTIONS FOR THE GUEST PAYLOAD AND THE PIN
 *
 * PowerShell does not exist on the Linux host, so the firstboot text is gated
 * HERE, literally: the pip exit that used to fall through to "did not import",
 * the postinstall + real IMPORT that make `win32ui` live, the work directory and
 * its integrity label, and the hash-gated D3 patch with both frozen anchors.
 * Every assertion is a one-word edit away from a regression, which is exactly
 * the class of defect WP-1 fixes.
 * ================================================================== */
{
  const firstboot = readFileSync(path.join(REPO, 'docker', 'windows-oem', 'cua-firstboot.ps1'), 'utf8')
  const supervisor = readFileSync(path.join(REPO, 'docker', 'cua-vm-supervisor.mjs'), 'utf8')
  // THE FROZEN LITERALS, copied from WP-1's contract (writer A's exact text).
  // Asserting the WORD, not a regex over a paraphrase, is the point: a one-word
  // edit is the regression class this block exists for.
  const L = {
    spec: "$spec = '{{DSH_CUA_PIP}}'",
    pipExit: "if ($pipExit -ne 0) { throw \"pip install '$spec' exited $pipExit; the wheel was not installed\" }",
    win32ui: 'import win32ui, win32gui',
    uiawrapper: 'import pywinauto.controls.uiawrapper',
    uiaOk: "print('UIA_OK')",
    postinstall: 'pywin32_postinstall.py',
    deadLane: 'the element lane is dead: import win32ui failed after pywin32_postinstall',
    workdirStep: "Step 'cua-workdir'",
    integrity: "'/setintegritylevel' '(OI)(CI)M'",
    scaleStep: "Step 'dsh-cua-scale'",
    hash: "$expectedHash = '59280ee9079cc09aa94b3813fd7a7665cfebffe68fb7259b752e161abf1f9209'",
    anchorA: 'base_w, base_h = img.size',
    anchorB: '"scale_x": round(base_w / ew, 6) if ew else 1.0',
    clearPyc: 'Clear-BridgePyc'
  }
  const missingLiteral = (key) => firstboot.includes(L[key]) === false
  check('WP-6.3/A1: the install keeps the {{DSH_CUA_PIP}} placeholder AND throws on a non-zero pip exit',
    missingLiteral('spec') === false && missingLiteral('pipExit') === false,
    missingLiteral('spec') || missingLiteral('pipExit') ? 'one of the two literals is missing' : 'both exact')
  check('WP-6.3/A2: the lane is verified by IMPORT (win32ui + win32gui + pywinauto.controls.uiawrapper)',
    missingLiteral('win32ui') === false && missingLiteral('uiawrapper') === false && missingLiteral('uiaOk') === false,
    `present: win32ui=${!missingLiteral('win32ui')} uiawrapper=${!missingLiteral('uiawrapper')} UIA_OK=${!missingLiteral('uiaOk')}`)
  check('WP-6.3/A5: pywin32_postinstall.py is located and run, and a lane that stays dead THROWS the exact sentence',
    missingLiteral('postinstall') === false && missingLiteral('deadLane') === false,
    missingLiteral('postinstall') || missingLiteral('deadLane') ? 'the repair or the throw is missing' : 'both exact')
  check('WP-6.3/A4: the work dir is created by its own step with the explicit DACL and the Medium label',
    missingLiteral('workdirStep') === false && missingLiteral('integrity') === false
    && /\$cuaGrant = "\$\(\$env:COMPUTERNAME\)\\cua:\(OI\)\(CI\)F"/u.test(firstboot),
    `${(firstboot.match(/C:\\cua-work/gu) ?? []).length} C:\\cua-work mention(s)`)
  check('WP-6.3/A6: the D3 patch is hash-gated on the PINNED sha256 and clears the stale .pyc afterwards',
    missingLiteral('hash') === false && missingLiteral('clearPyc') === false && /scaleFix/u.test(firstboot),
    `hash=${!missingLiteral('hash')} Clear-BridgePyc=${!missingLiteral('clearPyc')}`)
  check('WP-6.3/A3: ...and it applies BOTH frozen replacements (anchor A + the base_w ratio)',
    missingLiteral('anchorA') === false && missingLiteral('anchorB') === false
    && missingLiteral('scaleStep') === false && /SCALE_OK/u.test(firstboot),
    `anchorA=${!missingLiteral('anchorA')} anchorB=${!missingLiteral('anchorB')} step=${!missingLiteral('scaleStep')}`)
  check('WP-6.3/S1: the guest install is PINNED by default (`dsh-cua==0.4.1`) with the env override kept',
    /export const WINDOWS_DSH_CUA_DEFAULT = 'dsh-cua==0\.4\.1'/u.test(supervisor)
    && /WINDOWS_DSH_CUA_SPEC = String\(process\.env\.DSH_CUA_WINDOWS_DSH_CUA \|\| WINDOWS_DSH_CUA_DEFAULT\)/u.test(supervisor),
    'exported default + `DSH_CUA_WINDOWS_DSH_CUA` override')
  check('WP-6.3: the two new steps exist under the names the needles and the provision log use',
    !missingLiteral('workdirStep') && !missingLiteral('scaleStep'))
}

/* ================================================================== *
 * WP-6.5 — THE BUDGET INVARIANTS (nothing else moved)
 *
 * `TOOL_TIMEOUTS` is the tool envelope every registration is validated against,
 * so a "small" edit here is a change to what every caller may wait for. The
 * table is asserted literally: 19 guest tools share the attach envelope, the two
 * ungated helpers keep theirs, and `cua_vm_exec` keeps its 3 660 000 ms ceiling
 * (the boot wait — at most 60 s — stays far inside it).
 * ================================================================== */
{
  const source = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
  const frozen = {
    windows_desktop: '30_000',
    windows_mcp_doctor: '60_000',
    cua_vm_status: '30_000',
    cua_vm_doctor: '30_000',
    cua_vm_gc: '30_000',
    cua_vm_disk: '30_000',
    cua_vm_port: '30_000',
    cua_vm_start: '60_000',
    cua_vm_suspend: '60_000',
    cua_vm_shutdown: '60_000',
    cua_vm_destroy: '60_000',
    cua_vm_put: '120_000',
    cua_vm_get: '120_000',
    cua_vm_gui: '120_000',
    cua_vm_exec: '3_660_000',
    // 2026-11: a create no longer waits for the REA/Android layers (they are a
    // supervisor background job), but `sb create` + the desktop provisioning +
    // the disk grow still live inside this answer, so the envelope GREW rather
    // than shrinking. 48 min is 1 500 s of `sb create`, the guest provisioning
    // and the disk work, with room for a cold store.
    cua_vm_create: '2_880_000',
    cua_vm_ensure: '2_880_000',
    cua_vm_android: '3_360_000'
  }
  const missing = Object.entries(frozen)
    .filter(([name, value]) => !new RegExp(`\\n  ${name}: ${value},?`, 'u').test(source))
    .map(([name]) => name)
  check('WP-6.5: TOOL_TIMEOUTS is byte-identical to the frozen envelope (18 names, same numbers)',
    missing.length === 0, missing.length === 0 ? '18/18 exact' : `changed: ${missing.join(',')}`)
  const execCeiling = 3_660_000
  const bootWaitMax = 60_000
  check('WP-6.5: the boot wait (≤ 60 s) stays far inside `cua_vm_exec`\'s envelope',
    bootWaitMax < execCeiling / 10,
    `${bootWaitMax} ms vs ${execCeiling} ms (${Math.round((bootWaitMax / execCeiling) * 1000) / 10}%)`)
  // THE CREATE BUDGET IS A LADDER, NOT THREE NUMBERS. The tool envelope is what
  // the harness guard may arm, the route is the page's request, and the client
  // is the page's own abort — each must outlive the one below it, or the
  // specific sentence ("the supervisor did not answer create within …") is
  // replaced by a generic abort on exactly the surface the user watches.
  const clientSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'client.js'), 'utf8')
  const ladder = {
    tool: source.includes('cua_vm_create: 2_880_000,'),
    route: source.includes('create: 2_885_000,'),
    client: clientSource.includes('create: 2_890_000,')
  }
  check('WP-6.5: the create/ensure budget ladder is 2 880 000 (tool) → 2 885 000 (route) → 2 890 000 (client)',
    ladder.tool && ladder.route && ladder.client,
    `tool=${ladder.tool} route=${ladder.route} client=${ladder.client}`)
  // THE FOREGROUND HALF OF THE BUSY GUARD. A background provisioning job holds no
  // lock, so these holder names are the ONLY thing that stops a queued job from
  // racing a synchronous installer over /opt/node22, /opt/ghidra and the npm
  // global root. A name lost here re-opens the race silently, which is exactly
  // why the set is pinned rather than left to review.
  const supervisorSource = readFileSync(path.join(REPO, 'docker', 'cua-vm-supervisor.mjs'), 'utf8')
  const holdersLine = /const INSTALLER_HOLDERS = new Set\(\[([^\]]*)\]\)/u.exec(supervisorSource)
  const holders = (holdersLine?.[1] ?? '')
    .split(',')
    .map((part) => part.trim().replace(/^'|'$/gu, ''))
    .filter((part) => part !== '')
  const requiredHolders = ['vmStart', 'provision', 'vmAndroid', 'vmCreate', 'ensure']
  const missingHolders = requiredHolders.filter((holder) => holders.includes(holder) === false)
  check('WP-6.5: INSTALLER_HOLDERS names every synchronous installer leg (start, provision, android, create, ensure)',
    holdersLine !== null && missingHolders.length === 0,
    holdersLine === null ? 'INSTALLER_HOLDERS not found' : `holders=${holders.join(',')}${missingHolders.length > 0 ? ` missing=${missingHolders.join(',')}` : ''}`)
}

/* ================================================================== *
 * WP-6.3/C6 — THE scaleFix VOCABULARY (co-juror-1 defect 6)
 *
 * `scaleFix` is a FACT the guest publishes, so a test may only pin a value a
 * PRODUCER can actually emit. This suite used to pin `skipped:hash`, which
 * nothing writes: the relay (the writer of the facts file) emits
 * `applied | skipped:no-file | skipped:anchor | unverified:<why>`, and
 * firstboot emits its own marker vocabulary. The check parses BOTH producers and
 * fails on any literal this suite pins that neither can produce — so the
 * impossible pin cannot come back, and a new producer value (writer A's
 * rollback `failed:restore-failed`) is accepted the moment it lands.
 * ================================================================== */
{
  const relayText = readFileSync(path.join(REPO, 'docker', 'cua-mcp-relay.py'), 'utf8')
  const firstbootText = readFileSync(path.join(REPO, 'docker', 'windows-oem', 'cua-firstboot.ps1'), 'utf8')
  const relayValues = new Set([
    // EVERY such literal, not only the ones after `return`: the relay's D3
    // verdict is `'applied' if 'base_w' in source else 'skipped:anchor'`, and a
    // `return`-anchored regex silently missed the second half.
    ...[...relayText.matchAll(/'(applied|skipped:[a-z-]+|unverified:[^']*)'/gu)].map((match) => match[1]),
    ...[...relayText.matchAll(/'scaleFix': '([^']+)'/gu)].map((match) => match[1])
  ])
  const firstbootValues = new Set([
    ...[...firstbootText.matchAll(/scaleFix = '([^']+)'/gu)].map((match) => match[1]),
    ...[...firstbootText.matchAll(/scaleFix = "([^"]+)"/gu)].map((match) => match[1])
  ])
  const producers = new Set([...relayValues, ...firstbootValues])
  // EVERY scaleFix literal THIS SUITE PINS must be producible. A vocabulary word
  // only (`applied`, `skipped:x`, `unverified:x`) — the regex sources below are
  // not pins.
  const pinned = []
  for (const file of ['modules-unit.mjs', 'windows-mcp-gate.mjs', path.join('fixtures', 'fake-win-mcp.mjs')]) {
    const text = readFileSync(path.join(REPO, 'tests', file), 'utf8')
    for (const match of text.matchAll(/scaleFix: '([^']+)'/gu)) pinned.push({ file, value: match[1] })
    for (const match of text.matchAll(/scaleFix === '([^']+)'/gu)) pinned.push({ file, value: match[1] })
  }
  const unique = [...new Map(pinned.map((entry) => [`${entry.file}:${entry.value}`, entry])).values()]
  const impossible = unique.filter((entry) => /^[a-z][a-z:-]*$/u.test(entry.value) && producers.has(entry.value) === false)
  check('WP-6.3/C6: every scaleFix value pinned in these tests is one a PRODUCER can emit',
    unique.length > 0 && impossible.length === 0,
    impossible.length === 0 ? `${unique.length} pin(s) ⊆ ${producers.size} producer value(s)` : impossible.map((entry) => `${entry.file}:${entry.value}`).join(','))
  check('WP-6.3/C6: ...the relay (the facts-file writer) has its own closed vocabulary, not firstboot\'s markers',
    relayValues.has('applied') && relayValues.has('skipped:anchor') && relayValues.has('skipped:no-file')
    && relayValues.has('unverified:not measured'),
    [...relayValues].sort().join(' | '))
  check('WP-6.3/C6: ...and firstboot reports the hash gate honestly (`skipped:hash-mismatch`, never `skipped:hash`)',
    firstbootValues.has('skipped:hash-mismatch') && firstbootValues.has('skipped:version-mismatch')
    && firstbootValues.has('skipped:anchor-missing') && firstbootValues.has('skipped:write-failed')
    && firstbootValues.has('skipped:hash') === false,
    [...firstbootValues].sort().join(' | '))
}

/* ================================================================== *
 * WP-3 — THE RELAY PRODUCER, ASSERTED WITHOUT PYTHON (chief defect 6)
 *
 * The facts file is written from INSIDE the desktop session by
 * `docker/cua-mcp-relay.py`. Nothing on this host runs it and a guest run is
 * JURY's, so what a reviewer can prove here is that the producer EXISTS, uses
 * the frozen names, is bounded, and starts its measurement only after the
 * listener is up. Each assertion below is one edit away from a regression.
 * ================================================================== */
{
  const relay = readFileSync(path.join(REPO, 'docker', 'cua-mcp-relay.py'), 'utf8')
  const once = (needle) => relay.split(needle).length - 1 === 1
  check('WP-3.3: the relay names the facts file exactly once (one contract, no second path)',
    once("DESKTOP_FACTS_NAME = 'cua-desktop-facts.json'"))
  check('WP-3.3: ...and the ONE writable work dir, with %TEMP% as the documented fallback',
    once("WORK_DIR = 'C:\\\\cua-work'") && /def facts_temp_dir\(\)/u.test(relay)
    && /os\.path\.join\(WORK_DIR, DESKTOP_FACTS_NAME\)/u.test(relay))
  check('WP-3.3: ...bounded at 20 s (a doctor read must never outlive the doctor)',
    once('FACTS_PROBE_TIMEOUT = 20'))
  check('WP-3.3: the measurement is ONE function (`collect_desktop_facts`) carrying the frozen keys',
    once('def collect_desktop_facts(') && /'win32ui'/u.test(relay) && /'uiaLane'/u.test(relay)
    && /'workDirWritable'/u.test(relay) && /'profileRootWritable'/u.test(relay))
  check('WP-3.4: ...published as ONE `event(\'desktop-facts\' …)` log line (the JURY timeline)',
    once("event('desktop-facts'"))
  check('WP-3.1: ...from a DAEMON thread started AFTER the listener exists, never joined',
    once('threading.Thread(target=self.publish_desktop_facts,')
    && /facts_thread\.daemon = True/u.test(relay)
    && relay.indexOf('listener.listen(') !== -1
    && relay.indexOf('listener.listen(') < relay.indexOf('facts_thread.start()'))
}

/* ================================================================== *
 * WP-6.3/C7-C9 — THE DESKTOP-FACTS CACHE INVARIANTS (JURY-CO1 2/3/5)
 *
 * Three defects that a "does it read the file" test cannot see:
 *   C7  the attach path fires TWO reads in one tick; without single-flight the
 *       second one spent a second ssh child (JURY-CO1 defect 2);
 *   C8  `stale` was computed once, inside the normaliser, and replayed verbatim
 *       on every cache hit — a file 59 s old still said `stale:false` at 118 s
 *       (defect 5). The verdict belongs to the moment of the ANSWER;
 *   C9  a destroyed computer's facts must never serve again — including a read
 *       that was IN FLIGHT across the teardown (defect 3), and including a
 *       replacement that reuses the same name and port.
 * ================================================================== */
{
  const desktopFacts = typeof winMcpApi.desktopFacts === 'function' ? winMcpApi.desktopFacts : null
  const forgetDesktopFacts = typeof winMcpApi.forgetDesktopFacts === 'function' ? winMcpApi.forgetDesktopFacts : null
  const resetDesktopFactsCache = typeof winMcpApi.resetDesktopFactsCache === 'function' ? winMcpApi.resetDesktopFactsCache : () => {}
  const LANDED = desktopFacts !== null && forgetDesktopFacts !== null
  const sshStub = ({ stdout = '', stderr = '', exitCode = 0, delayMs = 0 } = {}) => {
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
      }, delayMs)
      return child
    }
    return { calls, spawnImpl }
  }
  const FACTS = {
    schema: 1,
    measured: true,
    at: '2026-11-19T15:00:00Z',
    user: 'cua',
    session: 2,
    dshCuaVersion: '0.4.1',
    pywin32Version: '306',
    win32ui: true,
    uiaLane: true,
    scaleFix: 'applied',
    workDir: 'C:\\cua-work',
    workDirWritable: true,
    profileRootWritable: false,
    source: 'cua-work',
    error: ''
  }

  if (LANDED === false) {
    checkContract('WP-6.3/C7: two concurrent reads share ONE ssh child', false, false,
      'the single-flight latch is absent', 'win-mcp.js must export forgetDesktopFacts()')
  } else {
    // ---- C7: TWO READS IN ONE TICK ⇒ ONE CHILD ----
    resetDesktopFactsCache()
    const shared = sshStub({ stdout: JSON.stringify(FACTS), delayMs: 40 })
    const [first, second] = await Promise.all([
      desktopFacts({ port: 47110, name: 'sf', spawnImpl: shared.spawnImpl, now: () => 1_000 }),
      desktopFacts({ port: 47110, name: 'sf', spawnImpl: shared.spawnImpl, now: () => 1_000 })
    ])
    check('WP-6.3/C7: two concurrent reads for ONE computer share a single ssh child',
      shared.calls.length === 1 && first?.measured === true && second?.measured === true,
      `${shared.calls.length} spawn(s)`)
    check('WP-6.3/C7: ...and the shared caller is told it did not spawn (`cached:true`)',
      second?.cached === true && first?.cached === false,
      `first.cached=${first?.cached} second.cached=${second?.cached}`)

    // ---- C8: `stale` IS RE-DERIVED AT READ TIME, NOT REPLAYED FROM THE ENTRY ----
    resetDesktopFactsCache()
    const atMs = Date.parse(FACTS.at)
    const clock = { now: atMs + 30_000 }
    const staleStub = sshStub({ stdout: JSON.stringify(FACTS) })
    const fresh = await desktopFacts({ port: 47111, name: 'age', spawnImpl: staleStub.spawnImpl, now: () => clock.now })
    clock.now += 40_000 // the cache entry is still inside its 60 s window; the FILE is not
    const aged = await desktopFacts({ port: 47111, name: 'age', spawnImpl: staleStub.spawnImpl, now: () => clock.now })
    check('WP-6.3/C8: `stale` follows the FILE\'s age at the moment of the answer (a cache hit cannot pin it)',
      fresh?.stale === false && aged?.stale === true && aged?.cached === true && staleStub.calls.length === 1,
      `fresh.stale=${fresh?.stale} aged.stale=${aged?.stale} cached=${aged?.cached} spawns=${staleStub.calls.length}`)

    // ---- C9a: FORGET ⇒ the next read spawns again ----
    resetDesktopFactsCache()
    const forgetStub = sshStub({ stdout: JSON.stringify(FACTS) })
    await desktopFacts({ port: 47112, name: 'dead', spawnImpl: forgetStub.spawnImpl, now: () => 1_000 })
    const hit = await desktopFacts({ port: 47112, name: 'dead', spawnImpl: forgetStub.spawnImpl, now: () => 1_000 })
    forgetDesktopFacts({ port: 47112, name: 'dead' })
    const afterForget = await desktopFacts({ port: 47112, name: 'dead', spawnImpl: forgetStub.spawnImpl, now: () => 1_000 })
    check('WP-6.3/C9: forgetting a computer drops its cached facts (the next read is a real one)',
      hit?.cached === true && afterForget?.cached === false && forgetStub.calls.length === 2,
      `hit=${hit?.cached} after=${afterForget?.cached} spawns=${forgetStub.calls.length}`)

    // ---- C9b: A READ IN FLIGHT ACROSS THE TEARDOWN DOES NOT REPOPULATE ----
    resetDesktopFactsCache()
    const slowStub = sshStub({ stdout: JSON.stringify(FACTS), delayMs: 60 })
    const inFlight = desktopFacts({ port: 47113, name: 'dead2', spawnImpl: slowStub.spawnImpl, now: () => 1_000 })
    forgetDesktopFacts({ port: 47113, name: 'dead2' })
    await inFlight
    const afterEpoch = await desktopFacts({ port: 47113, name: 'dead2', spawnImpl: slowStub.spawnImpl, now: () => 1_000 })
    check('WP-6.3/C9: a read that lands AFTER a teardown cannot write the dead computer\'s answer back',
      afterEpoch?.cached === false && slowStub.calls.length === 2,
      `after.cached=${afterEpoch?.cached} spawns=${slowStub.calls.length}`)

    // ---- C9c: the CLIENT's close() is the teardown that forgets (the wiring) ----
    resetDesktopFactsCache()
    const closeStub = sshStub({ stdout: JSON.stringify(FACTS) })
    const doomed = winMcpApi.createDshCuaClient({ name: 'gone', sshPort: 47114, isOnline: async () => true, spawnImpl: closeStub.spawnImpl })
    const beforeClose = await doomed.desktopFacts()
    doomed.close()
    const afterClose = await desktopFacts({ port: 47114, name: 'gone', spawnImpl: closeStub.spawnImpl, now: () => 1_000 })
    check('WP-6.3/C9: ...and the client\'s close() is what forgets it (the same name AND port may be reused)',
      beforeClose?.measured === true && afterClose?.cached === false && closeStub.calls.length === 2
      && doomed.state.desktop === null,
      `before=${beforeClose?.measured} after=${afterClose?.cached} spawns=${closeStub.calls.length} state.desktop=${String(doomed.state.desktop)}`)
  }
}

/* ================================================================== *
 * WP-6.3/A7-A8 — THE D3 ROLLBACK, REPORTED HONESTLY (writer A's fix round)
 *
 * The patch writes bridge.py in place. If the write, the import or the probe
 * then fails, the original bytes go back — and the ONE thing the marker must
 * never do is call that "skipped, nothing happened" without measuring the
 * restore. A7 asserts the three failure branches capture `$restoreOk` and only
 * say "reverted" when it is true; A8 tracks the vocabulary the README promises
 * for the case where the ROLLBACK ITSELF failed.
 * ================================================================== */
{
  const firstboot = readFileSync(path.join(REPO, 'docker', 'windows-oem', 'cua-firstboot.ps1'), 'utf8')
  const readme = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'README.md'), 'utf8')
  const restoreCalls = (firstboot.match(/\$restoreOk = Restore-BridgeSource -BridgePath \$bridgePath -OriginalBytes \$originalBytes -ExpectedHash \$measureHash/gu) ?? []).length
  const markerRows = (firstboot.match(/restoreOk = \$restoreOk/gu) ?? []).length
  const guarded = (firstboot.match(/if \(\$restoreOk\) \{/gu) ?? []).length
  check('WP-6.3/A7: every D3 failure branch MEASURES the rollback (three `$restoreOk = Restore-BridgeSource …` calls)',
    restoreCalls === 3, `${restoreCalls} restore call(s)`)
  check('WP-6.3/A7: ...and carries the measured outcome in the marker row (three `restoreOk = $restoreOk`)',
    markerRows === 3, `${markerRows} marker row(s)`)
  check('WP-6.3/A7: ...so "reverted" is only ever SAID when the restore measured true',
    guarded === 3 && /NOT RESTORED/u.test(firstboot)
    && /NOT RESTORED \(bridge\.py was not writable/u.test(firstboot)
    && /NOT RESTORED after a failed import/u.test(firstboot)
    && /NOT RESTORED after a bad probe/u.test(firstboot),
    `${guarded} guarded branch(es), NOT RESTORED x${(firstboot.match(/NOT RESTORED/gu) ?? []).length}`)
  check('WP-6.3/A7: ...and `applied` is only reachable AFTER the arithmetic probe (never before it)',
    firstboot.indexOf("scaleFix = 'applied'") > firstboot.indexOf('SCALE_BAD')
    && firstboot.indexOf("scaleFix = 'applied'") > firstboot.indexOf("scaleFix = 'skipped:import-failed'"),
    `applied@${firstboot.indexOf("scaleFix = 'applied'")} probe@${firstboot.indexOf('SCALE_BAD')}`)
  // A8: THE REAL CONTRACT OF THE ROLLBACK (writer A's shipped shape).
  //
  // The README once named `failed:restore-failed` for "the revert itself could
  // not be written back". The shipped shape is DIFFERENT and better: the frozen
  // `skipped:<why>` family is unchanged, and the marker row gains an ADDITIVE
  // `restoreOk` boolean on exactly the three rows where a rollback was
  // attempted (`restoreOk:false` = not restored, so the file is in an unknown
  // state). Asserting the phantom value would have pinned a lie — so this check
  // asserts the value is NOT producible, and that the three rows carry the
  // measured outcome instead.
  const emitted = new Set([...firstboot.matchAll(/scaleFix = '([^']+)'/gu)].map((match) => match[1]))
  check('WP-6.3/A8: `failed:restore-failed` is NOT a producer value (the frozen skipped:<why> family is what ships)',
    emitted.has('failed:restore-failed') === false
    && emitted.has('skipped:write-failed') && emitted.has('skipped:import-failed') && emitted.has('skipped:probe-failed'),
    [...emitted].sort().join(' | '))
  check('WP-6.3/A8: ...and a failed rollback is reported by the ADDITIVE `restoreOk` on exactly those three rows',
    (firstboot.match(/restoreOk = \$restoreOk/gu) ?? []).length === 3
    && /scaleFix = 'skipped:write-failed';[^\n]*restoreOk = \$restoreOk/u.test(firstboot)
    && /scaleFix = 'skipped:import-failed';[^\n]*restoreOk = \$restoreOk/u.test(firstboot)
    && /scaleFix = 'skipped:probe-failed';[^\n]*restoreOk = \$restoreOk/u.test(firstboot),
    'write-failed / import-failed / probe-failed each carry restoreOk')
  check('WP-6.3/A8: ...`applied` and `already` carry NO restoreOk (nothing was rolled back on the happy path)',
    /scaleFix = 'applied'[^\n]*restoreOk/u.test(firstboot) === false
    && /scaleFix = 'already'[^\n]*restoreOk/u.test(firstboot) === false)
}
