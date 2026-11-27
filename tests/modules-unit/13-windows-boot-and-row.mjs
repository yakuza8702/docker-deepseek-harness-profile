/**
 * 13-windows-boot-and-row.mjs — the Windows row name, the boot spec and the QMP adapter.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { REPO, WINDOWS_SETUP_COPY_DONE_PATTERN, cdbootKeyScheduleMs, cdbootKeysEnabled, cdbootPressFailure, cdbootPressTimeoutMs, cdbootPromptSeen, cdbootPromptWindowMs, cdbootRearmCycles, cdbootRearmWatchMs, check, createWindowsBackend, existsSync, mkdirSync, mkdtempSync, os, path, readFileSync, readSerialTail, rmSync, runCdbootKeys, spawn, startupNshText, windowsMediaEjectWatchMs, windowsPaths, windowsQmpAdapter, windowsRowName, windowsSetupCopyFinished, writeFileSync, writeOemPayload } from './harness.mjs'


// ---- R1/R2/R3/R5: THE FOUR LIVE-VERIFIED ROOT CAUSES ----
//
// R1  cdboot's "Press any key to boot from CD or DVD" window (5 s) was never
//     pressed: EFI_TIMEOUT, then the EFI Internal Shell. The schedule is asserted
//     with a stubbed clock and a recording `sendKey`.
// R2  a row has no `name` of its own — its name is the MAP KEY — so every
//     pidfile path carried "undefined" and a running QEMU read as dead.
// R3  the backend dials (host, port, cmds, opts) while the supervisor's
//     primitive is (port, cmds, { timeoutMs, host }): the HOST arrived as the
//     PORT and every probe threw. The adapter is the join.
// R5  the EFI Shell fallback script (belt and braces).
{
  // ---- R2: name resolution ----
  check('R2: windowsRowName reads a row\'s name', windowsRowName({ name: 'win-a' }) === 'win-a')
  check('R2: windowsRowName falls back to the map key when the row has none',
    windowsRowName({ kind: 'windows' }, 'win-key') === 'win-key')
  check('R2: windowsRowName accepts a bare name', windowsRowName('win-b') === 'win-b')
  check('R2: ...and never invents "undefined" from an empty row',
    windowsRowName({}, '') === '' && windowsRowName(null) === '' && windowsRowName(undefined, 'x') === 'x')

  // ---- R2 + R3 end to end: a row WITHOUT `name`, a faithful stub, and a real
  //      pidfile on disk under the map key. This is the exact live shape. ----
  const store = mkdtempSync(path.join(os.tmpdir(), 'cua-r2-'))
  try {
    const rowName = 'win-nameless'
    const p = windowsPaths(store, rowName)
    mkdirSync(p.dir, { recursive: true })
    writeFileSync(p.qemuPid, `${process.pid}\n`)
    // THE STUB SPEAKS THE SUPERVISOR'S SIGNATURE: (port, commands, { timeoutMs }).
    const calls = []
    const supervisorShaped = async (port, commands, opts = {}) => {
      calls.push({ port, commands, opts })
      if (!Number.isFinite(Number(port)) || Number(port) <= 0) {
        throw new TypeError('The "options" or "port" or "path" argument must be specified')
      }
      return [{ return: { status: 'running' } }]
    }
    // `name` here so the ALIVENESS half is observable; the nameless-row case is
    // asserted separately below (R2).
    const rawRow = { name: rowName, kind: 'windows', ports: { qmp: 46911, ssh: 47911, vnc: 5911 } }
    // THE LIVE BUG, REPLAYED: the backend calls `qmp(host, port, cmds, opts)`,
    // so a primitive that takes `(port, cmds, opts)` receives the HOST string as
    // its port and throws before a byte reaches the monitor.
    const mismatch = await supervisorShaped('127.0.0.1', 46911, [{ execute: 'query-status' }], { timeoutMs: 5000 })
      .then(() => 'answered', (error) => String(error?.message ?? error))
    check('R3 (the live bug): the supervisor primitive called with the backend\'s argument ORDER throws',
      /port.*must be specified|options/u.test(mismatch), mismatch)
    // THE FIX: the adapter joins the two signatures.
    const joined = await windowsQmpAdapter(supervisorShaped)('127.0.0.1', 46911, [{ execute: 'query-status' }], { timeoutMs: 5000 })
    check('R3: windowsQmpAdapter turns the backend shape into a running answer',
      joined?.[0]?.return?.status === 'running', JSON.stringify(joined))
    // ...and the backend adapts ANY primitive it is handed, so a raw stub still
    // works, and wrapping an adapter twice is a no-op rather than a new bug.
    const backend = createWindowsBackend({ store, qmp: windowsQmpAdapter(supervisorShaped), log: () => {} })
    const state = await backend.probe(rawRow)
    check('R3: with windowsQmpAdapter the SAME stub answers alive + QMP running',
      state.alive === true && state.status === 'running' && state.qmp === 'running', JSON.stringify(state))
    check('R3: ...the port reached the primitive as a PORT and the host in opts',
      calls.length > 0 && calls.at(-1).port === 46911 && calls.at(-1).opts.host === '127.0.0.1',
      JSON.stringify(calls.at(-1)))
    // R2: the row has no `name`, so only the map key can lead to that pidfile.
    const nameless = { kind: 'windows', ports: { qmp: 46911, ssh: 47911, vnc: 5911 } }
    check('R2: a row WITHOUT `name` finds NO pidfile (the live shape: path had "undefined")',
      backend.qemuPid(nameless) === 0 && backend.qemuPid({ ...nameless, name: rowName }) === process.pid,
      `nameless=${backend.qemuPid(nameless)} keyed=${backend.qemuPid({ ...nameless, name: rowName })}`)
    check('R2: ...and probe() takes the MAP KEY explicitly, so that row is not called dead',
      (await backend.probe(nameless, { name: rowName })).alive === true)
    check('R3: the adapter also accepts the supervisor shape as-is (port first)',
      await windowsQmpAdapter(supervisorShaped)(46911, [{ execute: 'query-status' }]) instanceof Array)

    // ---- R1: the cdboot key schedule ----
    const savedKeys = process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS
    const savedSwitch = process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS
    try {
      delete process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS
      check('R1: the default schedule covers the 5 s cdboot window',
        cdbootKeyScheduleMs().join(',') === '1500,3500,5500', cdbootKeyScheduleMs().join(','))
      check('R1: ...with three attempts inside it',
        cdbootKeyScheduleMs().length === 3 && cdbootKeyScheduleMs().at(-1) <= 6000)
      process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS = '200,400'
      check('R1: the schedule is configurable', cdbootKeyScheduleMs().join(',') === '200,400')
      process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS = 'nonsense'
      check('R1: an unparsable schedule falls back to the default', cdbootKeyScheduleMs().join(',') === '1500,3500,5500')
      delete process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS
      delete process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS
      check('R1: the keys are ON by default', cdbootKeysEnabled() === true)
      process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS = '0'
      check('R1: ...and can be switched off', cdbootKeysEnabled() === false)
    } finally {
      if (savedKeys === undefined) delete process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS
      else process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS = savedKeys
      if (savedSwitch === undefined) delete process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS
      else process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS = savedSwitch
    }

    // R1 mechanism: the delays are RELATIVE waits summing to the absolute
    // offsets, the key is Enter, and every attempt is logged.
    {
      const waits = []
      const keys = []
      const lines = []
      const sent = await runCdbootKeys({
        scheduleMs: [1500, 3500, 5500],
        key: 'enter',
        log: (line) => lines.push(line),
        wait: async (ms) => { waits.push(ms) },
        sendKey: async (key) => { keys.push(key) }
      })
      check('R1: three key presses are sent, at offsets 1.5 s / 3.5 s / 5.5 s',
        keys.length === 3 && keys.every((key) => key === 'enter') && waits.join(',') === '1500,2000,2000' && sent.join(',') === '1500,3500,5500',
        `keys=${keys.join(',')} waits=${waits.join(',')} sent=${sent.join(',')}`)
      check('R1: each press is logged with its offset',
        lines.length === 3 && lines.every((line) => /pressed enter/u.test(line) && /boot from CD or DVD/u.test(line)),
        lines.join(' | ').slice(0, 200))
    }
    // R1: a send that FAILS is logged and skipped — never fatal, the next one runs.
    {
      const keys = []
      const lines = []
      let attempt = 0
      const sent = await runCdbootKeys({
        scheduleMs: [100, 200, 300],
        log: (line) => lines.push(line),
        wait: async () => {},
        sendKey: async () => {
          attempt += 1
          if (attempt === 1) throw new Error('QMP not ready')
          keys.push(attempt)
        }
      })
      check('R1: a failed send is NOT fatal and does not stop the schedule',
        keys.join(',') === '2,3' && sent.join(',') === '200,300', `keys=${keys.join(',')} sent=${sent.join(',')}`)
      check('R1: ...and it says so without throwing', lines.some((line) => /could not press/u.test(line)), lines.join(' | ').slice(0, 160))
    }

    // ---- R6: A REFUSED PRESS IS NOT A PRESS ----
    //
    // The QMP primitive RESOLVES the monitor's refusal (`{error:{desc}}`) instead of
    // throwing it. The old scheduler only caught throws, so a run of refused
    // presses logged "pressed enter at ~1.7 s" while the guest never saw a key.
    {
      const lines = []
      const sent = await runCdbootKeys({
        scheduleMs: [100],
        log: (line) => lines.push(line),
        wait: async () => {},
        sendKey: async () => ({ error: { class: 'GenericError', desc: 'this feature is not supported' } })
      })
      check('R6: a press the monitor REFUSED is not counted as sent, and says so',
        sent.length === 0
        && lines.some((line) => /could not press enter/u.test(line) && /this feature is not supported/u.test(line)),
        lines.join(' | ').slice(0, 200))
      check('R6: ...and it is never logged as a successful press',
        lines.every((line) => !/pressed enter/u.test(line)))
    }
    // R6: the refusal reader itself — the shapes QMP and this supervisor emit.
    check('R6: cdbootPressFailure reads the monitor\'s refusal, and only the refusal',
      cdbootPressFailure({ error: { desc: 'GenericError: not enabled' } }) === 'GenericError: not enabled'
      && cdbootPressFailure([{ return: {} }, { error: 'refused' }]) === 'refused'
      && cdbootPressFailure({ error: { class: 'Duplicate' } }) === 'Duplicate'
      && cdbootPressFailure({ error: {} }) === 'the monitor refused the event'
      && cdbootPressFailure({ return: { OK: 'sent' } }) === null
      && cdbootPressFailure([{ return: {} }]) === null
      && cdbootPressFailure(null) === null
      && cdbootPressFailure('sent') === null,
      JSON.stringify([
        cdbootPressFailure({ error: { desc: 'x' } }),
        cdbootPressFailure({ return: {} }),
        cdbootPressFailure([{ error: 'y' }])
      ]))

    // R6: THE KNOBS. 90 s prompt window (measured: cdboot prints long after 8 s),
    // 12 re-arms, 180 s watch, 3 s per press — all clamped, all defaulting on junk.
    {
      check('R6: the prompt window defaults to 90 s, not the old 8 s',
        cdbootPromptWindowMs() === 90000, String(cdbootPromptWindowMs()))
      check('R6: the re-arm budget is 12 cycles inside a 180 s watch',
        cdbootRearmCycles() === 12 && cdbootRearmWatchMs() === 180000,
        `${cdbootRearmCycles()}/${cdbootRearmWatchMs()}`)
      check('R6: one press gets 3 s, not the monitor default of 15 s',
        cdbootPressTimeoutMs() === 3000, String(cdbootPressTimeoutMs()))
      const saved = {}
      try {
        for (const [env, value] of [
          ['DSH_CUA_WINDOWS_CDBOOT_PROMPT_MS', '5'],
          ['DSH_CUA_WINDOWS_CDBOOT_CYCLES', '999'],
          ['DSH_CUA_WINDOWS_CDBOOT_WATCH_MS', '99999999'],
          ['DSH_CUA_WINDOWS_CDBOOT_PRESS_MS', '1']
        ]) { saved[env] = process.env[env]; process.env[env] = value }
        check('R6: every knob is clamped on the way in (5→1000, 999→64, 99999999→3600000, 1→500)',
          cdbootPromptWindowMs() === 1000 && cdbootRearmCycles() === 64
          && cdbootRearmWatchMs() === 3600000 && cdbootPressTimeoutMs() === 500,
          `${cdbootPromptWindowMs()}/${cdbootRearmCycles()}/${cdbootRearmWatchMs()}/${cdbootPressTimeoutMs()}`)
        for (const env of Object.keys(saved)) process.env[env] = 'not-a-number'
        check('R6: an unparsable value falls back to the default, never to 0',
          cdbootPromptWindowMs() === 90000 && cdbootRearmCycles() === 12
          && cdbootRearmWatchMs() === 180000 && cdbootPressTimeoutMs() === 3000)
      } finally {
        for (const [env, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[env]
          else process.env[env] = value
        }
      }
    }

    // ---- P1: THE MEDIA LEAVE WHEN SETUP FINISHES COPYING ----
    //
    // Ejecting at READY needs the SSH banner, and a guest whose NIC has no driver
    // never answers SSH: the row stayed `installing` with SETUP (D:) mounted for
    // the life of the session. The trigger is the serial evidence instead.
    {
      check('P1: the copy-done pattern is a serial signature, not a clock',
        WINDOWS_SETUP_COPY_DONE_PATTERN instanceof RegExp
        && windowsSetupCopyFinished('Windows Setup is complete.') === true
        && windowsSetupCopyFinished('Setup has finished copying files') === true
        && windowsSetupCopyFinished('Setup is applying system settings') === true)
      check('P1: a booted-from-disk serial also means the copy is done',
        windowsSetupCopyFinished('BdsDxe: starting Boot0004 "Windows Boot Manager" from HD(1,GPT,') === true)
      check('P1: Setup is still copying / an empty tail is NOT an eject signal',
        windowsSetupCopyFinished('Windows Setup is starting') === false
        && windowsSetupCopyFinished('12%') === false
        && windowsSetupCopyFinished('') === false
        && windowsSetupCopyFinished(null) === false)
      check('P1: the watch window defaults to 90 minutes and is bounded',
        windowsMediaEjectWatchMs() === 90 * 60 * 1000, String(windowsMediaEjectWatchMs()))
      const saved = process.env.DSH_CUA_WINDOWS_EJECT_WATCH_MIN
      try {
        process.env.DSH_CUA_WINDOWS_EJECT_WATCH_MIN = '5'
        check('P1: ...and DSH_CUA_WINDOWS_EJECT_WATCH_MIN sets it (minutes)',
          windowsMediaEjectWatchMs() === 5 * 60 * 1000)
        process.env.DSH_CUA_WINDOWS_EJECT_WATCH_MIN = '9999'
        check('P1: ...clamped to 600 minutes, and junk falls back to 90',
          windowsMediaEjectWatchMs() === 600 * 60 * 1000
          && (process.env.DSH_CUA_WINDOWS_EJECT_WATCH_MIN = 'nonsense', windowsMediaEjectWatchMs() === 90 * 60 * 1000))
      } finally {
        if (saved === undefined) delete process.env.DSH_CUA_WINDOWS_EJECT_WATCH_MIN
        else process.env.DSH_CUA_WINDOWS_EJECT_WATCH_MIN = saved
      }
    }

    // ---- F2: THE SCHEDULE IS ANCHORED ON SERIAL ACTIVITY, NOT ON SPAWN ----
    //
    // The live forensic child proved the fixed 1.5/3.5/5.5 s presses land while
    // OVMF is still enumerating devices — BEFORE cdboot prints its prompt — so
    // the first press could never dismiss the window. These tests drive the
    // watcher against a STUBBED SERIAL TIMELINE with a virtual clock: no QEMU,
    // no real sleep, and the exact fire times are assertable.
    const runTimeline = async (timeline, extra = {}) => {
      let t = 0
      const waits = []
      const keys = []
      const lines = []
      const sent = await runCdbootKeys({
        scheduleMs: [1500, 3500, 5500],
        readSerial: () => timeline(t),
        now: () => t,
        wait: async (ms) => { waits.push(ms); t += ms },
        sendKey: async (key) => { keys.push({ key, at: t }) },
        log: (line) => lines.push(line),
        ...extra
      })
      return { t, waits, keys, lines, sent }
    }
    const PROMPT = 'cdboot.efi 10.0.26100.1\r\nPress any key to boot from CD or DVD . . .'
    {
      // The prompt is the anchor: the console is silent until it appears at 4 s,
      // the poll that sees it fires at ~4.1 s, then retries 0.8 s apart.
      const run = await runTimeline((t) => (t >= 4040 ? PROMPT : ''))
      const at = run.keys.map((entry) => entry.at)
      check('F2: a prompt at 4 s anchors the presses at ~4.1 / 4.9 / 5.7 s',
        at.length === 3 && at[0] >= 4000 && at[0] <= 4300
        && at[1] - at[0] === 800 && at[2] - at[1] === 800, at.join(','))
      check('F2: ...and NO spawn-relative press was sent before the prompt',
        at.every((value) => value >= 4000) && run.lines.every((line) => !/fixed-time fallback/u.test(line)),
        run.lines.join(' | ').slice(0, 200))
      check('F2: the presses are logged as serial-anchored', run.lines.every((line) => /pressed enter/u.test(line) && /serial:/u.test(line)),
        run.lines.join(' | ').slice(0, 160))
    }
    {
      // No prompt signature ever (an older/different cdboot wording), but the
      // console DID start printing at 0.6 s: fire at growth + 1.5 s.
      const run = await runTimeline((t) => (t >= 600 ? 'BdsDxe: loading Boot0001 from PciRoot(0x0)' : ''))
      const at = run.keys.map((entry) => entry.at)
      // A growth anchor is a guess, so it keeps retrying until the window
      // closes: an early press must never be the LAST one.
      check('F2: first serial output + ~1.5 s is the anchor when the prompt text never appears',
        at.length >= 3 && at[0] >= 2100 && at[0] <= 2400 && at[1] - at[0] === 800
        && at.at(-1) <= 8900, at.join(','))
    }
    {
      // COMPLETELY SILENT console: the fixed-time schedule is the fallback and
      // its offsets are honoured exactly (the historical behaviour).
      const run = await runTimeline(() => '')
      // The prompt never arrives, so the fixed schedule is replayed with its own
      // relative gaps as soon as the detection window closes (8 s): three
      // presses at 8.0 / 10.0 / 12.0 s, each logged with its nominal offset.
      check('F2: a silent serial console falls back to the fixed-time schedule (3 presses, 2 s gaps)',
        run.keys.map((entry) => entry.at).join(',') === '8000,10000,12000', run.keys.map((entry) => entry.at).join(','))
      check('F2: ...logged as the fallback (with the nominal offsets), so the two paths are never confused',
        run.lines.length === 3 && run.lines.every((line) => /fixed-time fallback/u.test(line))
        && run.lines.map((line) => /~(\d+) ms/u.exec(line)?.[1]).join(',') === '1500,3500,5500',
        run.lines.join(' | ').slice(0, 160))
    }
    {
      // The BdsDxe spelling of the same boot attempt anchors too, and a failing
      // send is still non-fatal in this mode.
      let attempts = 0
      const run = await runTimeline((t) => (t >= 2000 ? 'BdsDxe: starting Boot0001 "UEFI QEMU DVD-ROM"' : ''), {
        sendKey: async () => { attempts += 1; if (attempts === 1) throw new Error('QMP not ready') }
      })
      check('F2: "BdsDxe: starting Boot0001" is a prompt signature as well',
        run.lines.some((line) => /could not press/u.test(line)) && run.lines.filter((line) => /pressed enter/u.test(line)).length === 2,
        run.lines.join(' | ').slice(0, 200))
    }
    check('F2: the signature matcher is exported and case/space tolerant',
      cdbootPromptSeen('press ANY key to boot from cd or dvd') === true
      && cdbootPromptSeen('BdsDxe:  starting Boot0001') === true
      && cdbootPromptSeen('BdsDxe: starting Boot0002') === false
      && cdbootPromptSeen('') === false)
    {
      // readSerialTail reads only the tail of a growing file and never throws.
      const tailFile = path.join(os.tmpdir(), `cua-serial-tail-${process.pid}.log`)
      writeFileSync(tailFile, `${'x'.repeat(20000)}${PROMPT}`)
      check('F2: readSerialTail returns the tail (where the prompt is) and tolerates a missing file',
        readSerialTail(tailFile, 4096).includes('Press any key') && readSerialTail(path.join(os.tmpdir(), 'nope-no-such.log')) === '')
      rmSync(tailFile, { force: true })
    }

    // ---- R5: the EFI Shell fallback script ----
    const nsh = startupNshText()
    check('R5: startup.nsh tries every mapped filesystem\'s bootx64.efi',
      /for %f in fs0 fs1 fs2 fs3 fs4 fs5/u.test(nsh) && (nsh.match(/%f:\\efi\\boot\\bootx64\.efi/gu) ?? []).length >= 2)
    check('R5: ...guarded by `if exist`, and it names the failure when nothing boots',
      /if exist %f:\\efi\\boot\\bootx64\.efi then/u.test(nsh) && /Windows Setup did not start/u.test(nsh))
    check('R5: the script is EFI Shell dialect, not batch (no @echo off / goto)',
      nsh.startsWith('@echo -off') && !/goto|@echo off/u.test(nsh))
    // ...and writeOemPayload really writes it into the stick's ROOT.
    {
      const oemStore = mkdtempSync(path.join(os.tmpdir(), 'cua-r5-'))
      try {
        const oemPaths = windowsPaths(oemStore, 'win-nsh')
        const dir = writeOemPayload({
          paths: oemPaths, name: 'win-nsh', password: 'pw', sshPubKey: 'ssh-ed25519 AAAA x',
          sourceDir: path.join(REPO, 'docker', 'windows-oem'), pythonUrl: 'https://python', dshCuaSpec: 'dsh-cua==1'
        })
        const nshPath = path.join(dir, 'startup.nsh')
        check('R5: writeOemPayload puts startup.nsh in the stick ROOT (where the Shell looks)',
          existsSync(nshPath) && readFileSync(nshPath, 'utf8').includes('bootx64.efi'), nshPath)
        check('R5: ...next to Autounattend.xml, which Setup reads from the same root',
          existsSync(path.join(dir, 'Autounattend.xml')))
      } finally {
        rmSync(oemStore, { recursive: true, force: true })
      }
    }
    // ---- F2: A PAUSED GUEST IS CONTINUED BEFORE IT IS ASKED FOR ACPI ----
    //
    // The live defect: a VM left `paused` (a suspend, or a `-S` boot) never runs
    // its ACPI handler, so `system_powerdown` was accepted by QEMU and then
    // nothing happened for the full 120 s before a forced `quit`. The stub QMP
    // records the COMMAND ORDER, which is the only way to prove `cont` came
    // first, and ends the pid it reports when `quit` arrives so the wait loop
    // finishes in milliseconds instead of 15 s.
    const livePid = async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      // Wait for the pid to exist so pidAlive() is true on the first read.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try { process.kill(child.pid, 0); break } catch { await new Promise((r) => setTimeout(r, 20)) }
      }
      return child
    }
    const qmpRecorder = (order, { status, onQuit, onPowerdown }) => async (port, commands) => {
      for (const command of commands) {
        order.push(command.execute)
        if (command.execute === 'quit' && onQuit) onQuit()
        // A guest that HONOURS the powerdown: the process goes away inside the
        // wait window, which is the only shape where the outcome is not forced.
        if (command.execute === 'system_powerdown' && onPowerdown) onPowerdown()
      }
      if (commands[0].execute === 'query-status') return [{ return: { status } }]
      return [{ return: {} }]
    }
    {
      const child = await livePid()
      const name = 'win-paused'
      const paths = windowsPaths(store, name)
      mkdirSync(paths.dir, { recursive: true })
      writeFileSync(paths.qemuPid, `${child.pid}\n`)
      const order = []
      const backend = createWindowsBackend({
        store,
        qmp: qmpRecorder(order, {
          status: 'paused',
          onPowerdown: () => { try { child.kill('SIGKILL') } catch {} },
          onQuit: () => { try { child.kill('SIGKILL') } catch {} }
        }),
        log: () => {}
      })
      const row = { name, kind: 'windows', state: 'ready', ports: { qmp: 46912, ssh: 47912, vnc: 5912 } }
      const outcome = await backend.shutdown(row, { timeoutMs: 1000 })
      try { child.kill('SIGKILL') } catch {}
      check('F2: a PAUSED guest is sent `cont` before `system_powerdown`',
        order.join(',') === 'query-status,cont,system_powerdown', order.join(','))
      check('F2: ...and the continue-then-powerdown exit is not marked forced',
        outcome.exited === true && outcome.forced !== true, JSON.stringify(outcome))
    }
    // ---- F2: A MID-INSTALL SHUTDOWN IS SHORT, EXPLICIT AND TORN ----
    {
      const saved = process.env.DSH_CUA_WINDOWS_INSTALL_SHUTDOWN_MS
      try {
        process.env.DSH_CUA_WINDOWS_INSTALL_SHUTDOWN_MS = '0'
        const child = await livePid()
        const name = 'win-setup-shutdown'
        const paths = windowsPaths(store, name)
        mkdirSync(paths.dir, { recursive: true })
        writeFileSync(paths.qemuPid, `${child.pid}\n`)
        const order = []
        const backend = createWindowsBackend({
          store,
          qmp: qmpRecorder(order, { status: 'running', onQuit: () => { try { child.kill('SIGKILL') } catch {} } }),
          log: () => {}
        })
        // timeoutMs is the NORMAL 120 s: a mid-install guest must ignore it.
        const started = Date.now()
        const outcome = await backend.shutdown({ name, kind: 'windows', state: 'installing', ports: { qmp: 46913, ssh: 47913, vnc: 5913 } }, { timeoutMs: 120000 })
        const elapsed = Date.now() - started
        try { child.kill('SIGKILL') } catch {}
        check('F2: an installing row does not burn the full shutdown timeout',
          elapsed < 5000, `${elapsed} ms`)
        check('F2: ...it is a quit, classified installing, and marked forced (mayBeTorn)',
          outcome.installInProgress === true && outcome.forced === true && outcome.exited === true,
          JSON.stringify(outcome))
        check('F2: ...without a useless `cont` on a guest that is not paused',
          !order.includes('cont'), order.join(','))
        check('F2: the install window is clamped and defaults to 5 s',
          createWindowsBackend({ store, qmp: async () => [], log: () => {} }).installShutdownWindowMs() === 0)
        delete process.env.DSH_CUA_WINDOWS_INSTALL_SHUTDOWN_MS
        check('F2: ...unset it is 5 s',
          createWindowsBackend({ store, qmp: async () => [], log: () => {} }).installShutdownWindowMs() === 5000)
        process.env.DSH_CUA_WINDOWS_INSTALL_SHUTDOWN_MS = '999999'
        check('F2: ...and it never exceeds 30 s',
          createWindowsBackend({ store, qmp: async () => [], log: () => {} }).installShutdownWindowMs() === 30000)
      } finally {
        if (saved === undefined) delete process.env.DSH_CUA_WINDOWS_INSTALL_SHUTDOWN_MS
        else process.env.DSH_CUA_WINDOWS_INSTALL_SHUTDOWN_MS = saved
      }
    }
    // ---- F3: AN INSTALLING ROW IS NOT PROMOTED BY THE VNC BANNER ----
    //
    // The bug needs a REAL VNC peer: QEMU's VNC socket answers from the first
    // second of setup.exe, which is what made an ordinary status poll answer
    // "ready". The SSH port here has NO listener (the answer file has not
    // installed OpenSSH yet), so the two calls must disagree — the running
    // path accepts VNC, the install path (SSH only) refuses it.
    {
      const net = await import('node:net')
      const vnc = net.createServer((socket) => { try { socket.write('RFB 003.008\n') } catch {} })
      await new Promise((resolve) => vnc.listen(0, '127.0.0.1', resolve))
      const vncPort = vnc.address().port
      const name = 'win-setup-ready'
      const paths = windowsPaths(store, name)
      mkdirSync(paths.dir, { recursive: true })
      writeFileSync(paths.qemuPid, `${process.pid}\n`)
      const backend = createWindowsBackend({
        store,
        qmp: async () => [{ return: { status: 'running' } }],
        log: () => {}
      })
      const row = { name, kind: 'windows', state: 'installing', ports: { qmp: 46914, ssh: 0, vnc: vncPort } }
      const runningPhase = await backend.ready(row, { ssh: true })
      const installPhase = await backend.ready(row, { ssh: true, phase: 'install' })
      vnc.close()
      check('F3: the RUNNING readiness path accepts a bare VNC banner (the shape that promoted Setup)',
        runningPhase.ready === true && runningPhase.endpoint === 'vnc', JSON.stringify(runningPhase))
      check('F3: the INSTALL readiness path refuses it — SSH only, so the row stays installing',
        installPhase.ready === false && installPhase.endpoint === 'none', JSON.stringify(installPhase))
    }
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
}
