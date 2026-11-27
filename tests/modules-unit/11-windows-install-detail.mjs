/**
 * 11-windows-install-detail.mjs — the install sentence, the serial tail and the readiness signals.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { buildQemuArgs, check, endpointLabel, formatWindowsInstallDetail, qmpStateLabel, windowsBootSpec, windowsPortsOf, windowsReadinessSignals, windowsTailLines } from './harness.mjs'
import { paths } from './02-windows-catalog.mjs'


// ---- B2: THE PROGRESS SENTENCE, unit-tested for BOTH phases ----
// The user report was one panel line: "installing (10 min): undefined answering,
// QMP not running". Both halves were formatter defects (a raw `endpoint` field
// and `status || 'not running'`), so the formatter is tested directly.
{
  const installPhase = formatWindowsInstallDetail({
    phase: 'install',
    verdict: { alive: true, status: '', qmp: 'not answering', endpoint: undefined },
    elapsedMinutes: 10,
    serialTail: 'Setup is starting\n\n  12%\n  47%\n'
  })
  check('the install sentence never contains "undefined"', !/undefined/u.test(installPhase), installPhase)
  check('...never claims "QMP not running" about a live QEMU', !/QMP not running/u.test(installPhase), installPhase)
  check('...says what IS being watched (serial tail + QMP)', /serial-log tail/u.test(installPhase) && /QMP not answering/u.test(installPhase), installPhase.slice(0, 120))
  check('...carries the elapsed minutes', /installing \(10 min\)/u.test(installPhase), installPhase.slice(0, 40))
  check('...carries the last serial lines', /12% \| 47%/u.test(installPhase), installPhase.slice(-80))
  check('...and says how the user knows it finished', /badge flips to Ready/u.test(installPhase) && /\/vm\/port\/<name>\//u.test(installPhase), installPhase.slice(0, 200))
  check('an empty serial log says so instead of printing nothing', (() => {
    const text = formatWindowsInstallDetail({ phase: 'install', verdict: { alive: true, qmp: 'running' }, elapsedMinutes: 1, serialTail: '' })
    return /no lines yet/u.test(text) && !/undefined/u.test(text)
  })())

  const runningPhase = formatWindowsInstallDetail({
    phase: 'running',
    verdict: { alive: true, status: 'running', qmp: 'running', endpoint: 'ssh' },
    elapsedMinutes: 3,
    serialTail: ['logon ready']
  })
  check('the running phase sentence names SSH + QMP and the endpoint', /watching QMP \+ the SSH banner/u.test(runningPhase)
    && /now: ssh, QMP running/u.test(runningPhase), runningPhase.slice(0, 140))
  check('the running phase sentence has no "no SSH yet" filler', !/no SSH yet/u.test(runningPhase), runningPhase.slice(0, 120))

  // The labels are the only place a raw field can leak.
  check('qmpStateLabel turns an empty probe into "not answering", never ""',
    qmpStateLabel({ alive: true, status: '' }) === 'not answering'
    && qmpStateLabel({ alive: false }) === 'no qemu'
    && qmpStateLabel({ status: 'paused' }) === 'paused'
    && qmpStateLabel(undefined) === 'not answering')
  check('endpointLabel turns a missing endpoint into "no endpoint yet"',
    endpointLabel({ endpoint: undefined }) === 'no endpoint yet'
    && endpointLabel({ endpoint: 'none' }) === 'no endpoint yet'
    && endpointLabel({ endpoint: 'ssh' }) === 'ssh')
  check('windowsTailLines keeps only the last N non-empty lines',
    windowsTailLines('a\n\nb\nc\nd\ne\nf\n', 5).join(',') === 'b,c,d,e,f'
    && windowsTailLines('   \n\n', 5).length === 0)

  // ---- F4: THE FORMATTER'S TWO HONEST HEADLINES ----
  // `ready()` early-returns WITHOUT an endpoint when the QEMU process is not
  // alive, and the reported panel line interpolated that missing field:
  // "installing (N min): undefined answering, QMP not running". Neither half of
  // that sentence may come back.
  const deadLine = formatWindowsInstallDetail({
    phase: 'install',
    verdict: { alive: false, status: '', qmp: 'no qemu', endpoint: undefined },
    elapsedMinutes: 4,
    serialTail: ''
  })
  check('a dead QEMU gets its own headline (never "undefined answering")',
    !/undefined/u.test(deadLine) && /QEMU not alive/u.test(deadLine) && /qemu-stderr\.log/u.test(deadLine), deadLine.slice(0, 160))
  const waitingLine = formatWindowsInstallDetail({
    phase: 'install',
    verdict: { alive: true, status: 'running', qmp: 'running', endpoint: 'none', sshPort: 47444 },
    elapsedMinutes: 6,
    serialTail: '  12%'
  })
  check('an ALIVE guest with no endpoint yet says it is waiting for SSH on the port',
    !/undefined/u.test(waitingLine) && /waiting for SSH on 127\.0\.0\.1:47444/u.test(waitingLine),
    waitingLine.slice(0, 200))
  check('...and still carries the serial tail',
    /12%/u.test(waitingLine), waitingLine.slice(-60))

  // ---- B2: THE ROW AND THE BOOT SPEC SHARE ONE PORT RESOLVER ----
  // The registry row stores `ports: { qmp, ssh, vnc }`; `buildQemuArgs` reads
  // flat fields. Resolving the row's shape to `undefined` is what made every
  // lifecycle call dial port 0 and the panel print "undefined answering".
  const row = { name: 'win-test', ports: { qmp: 47001, ssh: 48001, vnc: 5901 } }
  const fromRow = windowsPortsOf(row)
  check('windowsPortsOf reads a REGISTRY ROW', fromRow.qmpPort === 47001 && fromRow.sshPort === 48001 && fromRow.vncPort === 5901, JSON.stringify(fromRow))
  const flat = { name: 'win-test', qmpPort: 47002, sshPort: 48002, vncPort: 5902 }
  check('windowsPortsOf reads a FLAT boot spec', windowsPortsOf(flat).qmpPort === 47002 && windowsPortsOf(flat).sshPort === 48002, JSON.stringify(windowsPortsOf(flat)))
  check('windowsPortsOf never invents a port for an empty row', (() => {
    const empty = windowsPortsOf({ name: 'x' })
    return empty.qmpPort === 0 && empty.sshPort === 0 && empty.vncPort === 0
  })(), JSON.stringify(windowsPortsOf({ name: 'x' })))
  check('windowsBootSpec flattens a row for buildQemuArgs',
    buildQemuArgs({ ...windowsBootSpec(row), paths: paths, isoPath: '/isos/w.iso', installPending: true, virtio: false, driverIso: null })
      .includes('tcp:127.0.0.1:47001,server=on,wait=off'))
  check('the readiness contract names the SSH banner and QMP',
    windowsReadinessSignals('win-test').signals.join('|') === 'the guest SSH banner answers|QMP says running'
    && /\/vm\/port\/win-test\//u.test(windowsReadinessSignals('win-test').onReady))
}
