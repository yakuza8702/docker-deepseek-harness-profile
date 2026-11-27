/**
 * 07-relay-probe.mjs — the interactive MCP relay probe and its answer ranking.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { RELAY_BAD, RELAY_COMMAND, RELAY_DOWN, RELAY_OK, RELAY_PORT_DEFAULT, RELAY_PROBE_TIMEOUT_MS, RELAY_PROBE_TTL_MS, RELAY_UPGRADE_INTERVAL_MS, RELAY_UPGRADE_LOG, RELAY_UPGRADE_WATCH_MS, REPO, SESSION0_FALLBACK_REASON, SESSION0_SKEW_REASON, check, createDshCuaClient, path, readFileSync, relayPort, relayProbeCommand, relayProbeCommands, shouldUpgradeToRelay } from './harness.mjs'


// ------------------------------------------------------------------ *
// J22-14: THE INTERACTIVE MCP RELAY — one python file, two modes
// ------------------------------------------------------------------ *
// The Windows MCP server used to be started BY the SSH command, i.e. in
// Session 0, where UIA enumerates zero windows (`list_windows` answered 0 while
// notepad sat in "Services"). The relay keeps the stdio transport exactly as it
// is and moves only the SERVER into the logged-on user's session.
//
// What is asserted here is the part that is PURE: the probe pair and its LENGTH
// (the firstboot bug was a nine-byte read of an eight-byte answer), the lane
// constants on both sides of the wire, the port rule, and the doctor's zero-SSH
// facts. The guest-side wiring is gated by tools/check-cua-vm.mjs; the
// behavioural half (a real attach, a real doctor payload) is tests/windows-mcp-gate.mjs,
// which is why `transportText` — built inside index.js from those same facts —
// is not re-tested here.
{
  const relaySource = readFileSync(path.join(REPO, 'docker', 'cua-mcp-relay.py'), 'utf8')
  const ping = /PROBE_PING = b'([^']+)'/u.exec(relaySource)?.[1] ?? ''
  const ok = /PROBE_OK = b'([^']+)'/u.exec(relaySource)?.[1] ?? ''
  const pyPort = Number(/^DEFAULT_PORT = (\d+)$/mu.exec(relaySource)?.[1] ?? 0)
  check('J22-14: the relay answers RELAY_PING with RELAY_OK — and RELAY_OK is EIGHT bytes',
    ping === 'RELAY_PING' && ok === 'RELAY_OK'
    && Buffer.byteLength(ping, 'ascii') === 10 && Buffer.byteLength(ok, 'ascii') === 8,
    `${ping || 'missing'}(${Buffer.byteLength(ping, 'ascii')}) -> ${ok || 'missing'}(${Buffer.byteLength(ok, 'ascii')})`)
  // ONE spelling of the pair. The client compares constants; the guest compares
  // bytes. If either side is "fixed" alone, every attach falls back to the blind
  // lane — which works, and is exactly how it would go unnoticed.
  check('J22-14: ...and the client uses the SAME pair, with no second spelling',
    RELAY_OK === ok && RELAY_BAD === 'RELAY_BAD' && RELAY_DOWN === 'RELAY_DOWN'
    && RELAY_PROBE_TTL_MS === 10000,
    `${RELAY_OK}/${RELAY_BAD}/${RELAY_DOWN} ttl=${RELAY_PROBE_TTL_MS}`)
  check('J22-14: the relay port default agrees on both sides of the wire (47999)',
    pyPort === 47999 && RELAY_PORT_DEFAULT === 47999, `py=${pyPort} js=${RELAY_PORT_DEFAULT}`)
  const savedPort = process.env.DSH_CUA_MCP_RELAY_PORT
  try {
    process.env.DSH_CUA_MCP_RELAY_PORT = '51234'
    const overridden = relayPort()
    process.env.DSH_CUA_MCP_RELAY_PORT = 'not-a-port'
    const garbage = relayPort()
    process.env.DSH_CUA_MCP_RELAY_PORT = '70000'
    const outOfRange = relayPort()
    delete process.env.DSH_CUA_MCP_RELAY_PORT
    check('J22-14: DSH_CUA_MCP_RELAY_PORT overrides the port; garbage falls back instead of building a broken line',
      overridden === 51234 && garbage === 47999 && outOfRange === 47999 && relayPort() === 47999,
      `override=${overridden} garbage=${garbage} out-of-range=${outOfRange} unset=${relayPort()}`)
  } finally {
    if (savedPort === undefined) delete process.env.DSH_CUA_MCP_RELAY_PORT
    else process.env.DSH_CUA_MCP_RELAY_PORT = savedPort
  }
  check('J22-14: the SSH child runs the relay CLIENT verbatim (`py -3 ...\\mcp-relay.py --connect`)',
    RELAY_COMMAND === 'py -3 C:\\ProgramData\\cua\\mcp-relay.py --connect', RELAY_COMMAND)
  // THE PROBE IS A HANDSHAKE, NOT A SUBCOMMAND (P0 — this is the assertion that
  // would have caught it).
  //
  // THE OLD ASSERTION HERE SAID:
  //   relayProbeCommand(47999) === 'py -3 C:\\ProgramData\\cua\\mcp-relay.py --ping 47999'
  // and its comment called that "the relay's own `--ping`". It was wrong in the
  // one way that mattered: the script on the guest is staged at machine-create
  // time and never refreshed, and that copy (26,573 B, `--ping` occurrences = 0)
  // answers the flag with a usage line on STDERR, nothing on stdout, exit 2 — so
  // the harness settled `RELAY_DOWN` against a perfectly healthy relay, took
  // `session-0-direct`, and the desktop was blind. The test ASSERTED the defect.
  //
  // The contract now (SOL §4.1, Appendix A): an ordered candidate list whose
  // first entry is a base64-embedded PROGRAM that speaks the wire protocol
  // itself, and the legacy `--ping` form only as the LAST resort.
  //
  //   py -3 -c "exec(__import__('base64').b64decode('<BASE64>').decode())"
  //   python -c "…same program…"
  //   py -3 C:\ProgramData\cua\mcp-relay.py --ping 47999        (legacy, last)
  //
  // Base64 is the carrier because it keeps `"`, `%`, `^`, `&` and `|` out of a
  // command that travels `ssh → cmd.exe → python` (Appendix A).
  const decodeProbeProgram = (command) => {
    const match = /b64decode\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/u.exec(String(command ?? ''))
    return match === null ? null : Buffer.from(match[1], 'base64').toString('utf8')
  }
  const probeCandidates = relayProbeCommands(47999)
  const probeProgram = decodeProbeProgram(probeCandidates[0])
  check('WP-5.4: relayProbeCommands(port)[0] is a base64-embedded handshake PROGRAM (no `--ping` subcommand)',
    Array.isArray(probeCandidates) && probeCandidates.length >= 2
    && /^py -3 -c /u.test(probeCandidates[0])
    && probeProgram !== null
    && !/--ping/u.test(probeCandidates[0]),
    `${probeCandidates.length} candidate(s): ${probeCandidates[0]?.slice(0, 46)}…`)
  check('WP-5.4: ...the program speaks the wire protocol: RELAY_PING, the port, and an 8-BYTE ACCUMULATE',
    probeProgram !== null
    && /RELAY_PING/u.test(probeProgram)
    && probeProgram.includes('47999')
    // THE ACCUMULATE IS THE POINT: a single `recv(8)` is not a contract, because a
    // short read is legal on a socket (the same defect cua-firstboot.ps1 documents).
    && /while\s+len\([A-Za-z_]+\)\s*<\s*8\s*:/u.test(probeProgram)
    && /recv\(\s*8\s*-\s*len\(/u.test(probeProgram)
    && /\+=\s*/u.test(probeProgram)
    && /RELAY_OK/u.test(probeProgram) && /RELAY_BAD/u.test(probeProgram) && /RELAY_DOWN/u.test(probeProgram)
    && /print\(/u.test(probeProgram),
    (probeProgram ?? '(no base64 program)').split('\n').slice(0, 2).join(' | '))
  check('WP-5.4: ...and no candidate needs PowerShell (the CLR start was the OLD defect, not a fallback)',
    probeCandidates.every((candidate) => !/(powershell|GetBytes|TcpClient|byte\[\])/iu.test(String(candidate))),
    probeCandidates.map((candidate) => String(candidate).slice(0, 18)).join(' | '))
  check('WP-5.4: ...the legacy `--ping` form survives ONLY as the LAST candidate',
    probeCandidates.at(-1) === 'py -3 C:\\ProgramData\\cua\\mcp-relay.py --ping 47999'
    && probeCandidates.slice(0, -1).every((candidate) => !/--ping/u.test(String(candidate)))
    && relayProbeCommands(51234).at(-1) === 'py -3 C:\\ProgramData\\cua\\mcp-relay.py --ping 51234'
    && decodeProbeProgram(relayProbeCommands(51234)[0])?.includes('51234') === true,
    `last=${probeCandidates.at(-1)}`)
  check('WP-5.4: ...and relayProbeCommand() is kept as the FIRST candidate (compatibility, WP-2.1)',
    relayProbeCommand(47999) === probeCandidates[0]
    && probeCandidates.every((candidate) => !/\n/u.test(String(candidate))),
    String(relayProbeCommand(47999)).slice(0, 46))
  check('J22-14: ...and the probe budget is the 12 s wall the cold `py` start needs (not the 8 s the CLR blew)',
    RELAY_PROBE_TIMEOUT_MS === 12000 && RELAY_PROBE_TIMEOUT_MS > 8000,
    `probe budget=${RELAY_PROBE_TIMEOUT_MS} ms`)
  // DEFECT 2: A LATE RELAY MUST BE ABLE TO TAKE OVER A *LIVE* SESSION-0 ATTACH.
  // The lane is decided at attach and the logon task can come up after it, so
  // without an upgrade a two-second-late relay left the computer blind for the
  // whole session. The decision is pure, so it is asserted without an SSH child:
  // only a live blind lane, never with a request in flight, never twice a minute.
  const upgrade = (patch) => shouldUpgradeToRelay({ transport: 'session-0-direct', relayOk: null, lastUpgradeAttemptAt: 0, now: 600_000, inFlight: 0, ...patch })
  check('J22-14b: shouldUpgradeToRelay upgrades ONLY a live blind lane, never mid-call, at most once per 60 s',
    upgrade() === true
    && upgrade({ transport: 'interactive-relay' }) === false
    && upgrade({ relayOk: true }) === false
    && upgrade({ inFlight: 1 }) === false
    && upgrade({ lastUpgradeAttemptAt: 581_000 }) === false
    && upgrade({ lastUpgradeAttemptAt: 540_000 }) === true
    && RELAY_UPGRADE_INTERVAL_MS === 60000 && RELAY_UPGRADE_WATCH_MS === 15000
    && RELAY_UPGRADE_LOG === 'upgrading mcp transport to the interactive relay',
    `interval=${RELAY_UPGRADE_INTERVAL_MS} watch=${RELAY_UPGRADE_WATCH_MS}`)
  check('J22-14: the session-0 fallback RECORDS why it is blind rather than looking identical',
    SESSION0_FALLBACK_REASON === 'session-0 fallback (interactive relay not running; desktop automation will be blind)'
    && /desktop automation will be blind/u.test(SESSION0_FALLBACK_REASON),
    SESSION0_FALLBACK_REASON)
  // TWO CAUSES, TWO SENTENCES (SOL §2.3/§4.3). The DOWN sentence above is
  // byte-identical to what it always was; the SKEW case — the guest relay
  // ANSWERED and the harness still could not read it, which is exactly the P0
  // signature — gets its own, because "not running" is a lie about a relay that
  // is running. Neither may be reachable for the other's status.
  check('WP-5.5: RELAY_SKEW has its OWN sentence — a relay that answered is not "not running"',
    SESSION0_SKEW_REASON !== SESSION0_FALLBACK_REASON
    && /desktop automation will be blind/u.test(SESSION0_SKEW_REASON)
    && /the guest relay answered/u.test(SESSION0_SKEW_REASON)
    && /payload mismatch/u.test(SESSION0_SKEW_REASON)
    && /interactive relay not running/u.test(SESSION0_SKEW_REASON) === false
    && /payload mismatch/u.test(SESSION0_FALLBACK_REASON) === false,
    SESSION0_SKEW_REASON)
  // THE DOCTOR'S FACTS ARE SYNCHRONOUS AND SIDE-EFFECT FREE. Creating a client
  // dials nothing; before an attach there IS no lane, and the answer must be
  // null rather than a guess (a guessed "relay" would report a blind bridge as
  // healthy in exactly the case the doctor exists for).
  const unattached = createDshCuaClient({ name: 'relay-unit', sshPort: 1 })
  const facts = unattached.doctorFacts()
  check('J22-14: doctorFacts() before any attach says transport null — never a guessed lane',
    facts.transport === null && facts.relayOk === null && facts.relayStatus === null
    && facts.transportCommand === null && facts.transportReason === ''
    && facts.relayPort === RELAY_PORT_DEFAULT,
    JSON.stringify(facts))
}
