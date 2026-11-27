/**
 * 15-clipboard-payload.mjs — the clipboard transport, the free-space probe and the put/get argv.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { REPO, WINDOWS_FREE_FLOOR_GB, check, createWindowsBackend, formatWindowsFreeSpace, mkdtempSync, os, parseFreeSpaceProbe, path, readFileSync, rmSync, spawnSync } from './harness.mjs'



// ---- U1: HIDE PASSWORD IS A CLEAR, NOT A LABEL ----
//
// The reported defect is a STATE TRANSITION, not a render: "Hide password"
// flipped the label and the secret stayed in the component, so the value was
// still there for the next render (and the reveal note carried it in a banner
// that outlived the reveal). The client exports its two pure transitions for
// exactly this, and the unit test drives them — a DOM test would need a renderer
// and would still not name "delete the key".
{
  const { readFileSync: readFile } = await import('node:fs')
  const factory = (() => {
    let loaded = null
    const source = readFile('plugins/dsh-cua-vm/client.js', 'utf8')
    const win = { __ModuleLoader__: { load: (options) => { loaded = options.factory } } }
    // eslint-disable-next-line no-new-func
    new Function('window', source)(win)
    const React = {
      createElement: () => ({}),
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useRef: () => ({ current: null })
    }
    return loaded(() => React)
  })()
  const { hideSecretEntry, noteAfterHide } = factory.__test
  check('U1: hidePassword DELETES the secret key (a new object, the old one untouched)',
    (() => {
      const before = { 'win-box': 'pw-1', other: 'pw-2' }
      const after = hideSecretEntry(before, 'win-box')
      return after['win-box'] === undefined && after.other === 'pw-2' && before['win-box'] === 'pw-1' && after !== before
    })())
  check('U1: ...hiding an absent key is a no-op, not a crash',
    JSON.stringify(hideSecretEntry({ other: 'pw-2' }, 'win-box')) === JSON.stringify({ other: 'pw-2' }))
  check('U1: a note that CARRIED the password is cleared by hiding it',
    noteAfterHide('win-box: user "cua", password "pw-1" — stored 0600', 'win-box', 'pw-1')
      === 'win-box: password hidden and removed from this page.')
  check('U1: ...and an unrelated note is left alone',
    noteAfterHide('win-box is up.', 'win-box', 'pw-1') === 'win-box is up.')
  check('U1: the reveal note no longer interpolates the password',
    !/setNote\(`.*password "\$\{payload\.password\}"/u.test(readFile('plugins/dsh-cua-vm/client.js', 'utf8')))
  check('U1: the button toggles on the secret state (it used to always reveal)',
    /onClick: \(\) => \(secret\[name\] \? hidePassword\(name\) : void revealPassword\(name\)\)/u.test(readFile('plugins/dsh-cua-vm/client.js', 'utf8')))
}

// ---- U2: THE CLIPBOARD PROTOCOL, DRIVEN WITH A STUB TRANSPORT ----
//
// The Windows clipboard only works through the guest's INTERACTIVE session (two
// on-demand `/it` tasks). The backend owns the protocol; the transport is
// injected. This stub is a guest that records every call IN ORDER, so the two
// invariants that make a paste real are asserted: the text file is written
// BEFORE the task runs, and a task whose Last Result is non-zero is a FAILURE.
{
  const store = mkdtempSync(path.join(os.tmpdir(), 'cua-clip-unit-'))
  try {
    const makeStub = ({ runExit = 0, lastResult = 0, readText = 'hello from the guest', failRun = false, missingRead = false } = {}) => {
      const calls = []
      const files = new Map()
      return {
        calls,
        files,
        transport: {
          async sshRun(_meta, command) {
            calls.push({ kind: 'ssh', command })
            if (/schtasks \/run/u.test(command)) {
              return failRun ? { code: 1, stdout: '', stderr: 'ERROR: Access is denied.' } : { code: 0, stdout: 'SUCCESS: Attempted to run', stderr: '' }
            }
            if (/schtasks \/query/u.test(command)) return { code: 0, stdout: `Status:        Ready\r\nLast Result:   ${lastResult}\r\n`, stderr: '' }
            if (/^if exist/u.test(command)) return { code: 0, stdout: '', stderr: '' }
            if (/^if not exist/u.test(command)) return { code: 0, stdout: '', stderr: '' }
            return { code: runExit, stdout: '', stderr: '' }
          },
          async putText(_meta, guestPath, text) {
            calls.push({ kind: 'put', guestPath, text })
            files.set(guestPath, text)
            return { code: 0, stderr: '' }
          },
          async getText(_meta, guestPath) {
            calls.push({ kind: 'get', guestPath })
            if (missingRead || !files.has(guestPath)) return { code: 1, stderr: 'No such file', text: '' }
            return { code: 0, stderr: '', text: files.get(guestPath) }
          }
        }
      }
    }
    const saved = process.env.DSH_CUA_WIN_CLIP_SETTLE_MS
    process.env.DSH_CUA_WIN_CLIP_SETTLE_MS = '0'
    try {
      // SET: file first, task second.
      {
        const stub = makeStub()
        const backend = createWindowsBackend({ store, qmp: async () => [], log: () => {}, transport: stub.transport })
        const result = await backend.clipboardSet({ name: 'win-clip' }, 'a & b | c "quoted" ; semi')
        const order = stub.calls.map((call) => call.kind).join(',')
        // WP-6: THE AGENT IS TRIED FIRST, and its decline is REPORTED. The very
        // first call is the `type clip-state.json` probe; with no agent the
        // task path follows and the ORDER invariant (file before task) holds.
        const putAt = stub.calls.findIndex((call) => call.kind === 'put')
        const mkdirAt = stub.calls.findIndex((call) => call.kind === 'ssh' && /mkdir/u.test(call.command))
        const runAt = stub.calls.findIndex((call) => call.kind === 'ssh' && /cua-clip-set/u.test(call.command))
        check('U2: clipboardSet writes clip.txt BEFORE the task runs (after the agent probe declined)',
          mkdirAt !== -1 && putAt > mkdirAt && runAt > putAt
          && /clip-state\.json/u.test(stub.calls[0].command)
          && stub.calls[putAt].guestPath.endsWith('clip.txt'), order)
        check('U2: ...it pastes into C:\\ProgramData\\cua\\clip.txt',
          stub.calls[putAt].guestPath === 'C:\\ProgramData\\cua\\clip.txt', stub.calls[putAt].guestPath)
        check('U2: ...and reports the byte count only after the task exits 0',
          result.ok === true && result.bytes === Buffer.byteLength('a & b | c "quoted" ; semi') && result.task === 'cua-clip-set', JSON.stringify(result))
      }
      // A task that fails must NEVER read as a paste.
      {
        const stub = makeStub({ lastResult: 1 })
        const backend = createWindowsBackend({ store, qmp: async () => [], log: () => {}, transport: stub.transport })
        const result = await backend.clipboardSet({ name: 'win-clip' }, 'x')
        check('U2: a task whose Last Result is non-zero is a FAILURE, not a paste',
          result.ok === false && result.reason === 'task' && /exited 1/u.test(result.detail), JSON.stringify(result))
      }
      // A /run that is refused (no such task, access denied) surfaces the code.
      {
        const stub = makeStub({ failRun: true })
        const backend = createWindowsBackend({ store, qmp: async () => [], log: () => {}, transport: stub.transport })
        const result = await backend.clipboardSet({ name: 'win-clip' }, 'x')
        check('U2: `schtasks /run` failing surfaces its exit code and stderr',
          result.ok === false && result.code === 1 && /Access is denied/u.test(result.detail), JSON.stringify(result))
      }
      // GET: clears the stale file, runs the task, then reads back.
      {
        const stub = makeStub({ readText: 'line 1\r\nline 2' })
        stub.files.set('C:\\ProgramData\\cua\\clip-read.txt', 'line 1\r\nline 2')
        const backend = createWindowsBackend({ store, qmp: async () => [], log: () => {}, transport: stub.transport })
        const result = await backend.clipboardGet({ name: 'win-clip' })
        const cleard = stub.calls.some((call) => call.kind === 'ssh' && /del \/f \/q .*clip-read\.txt/u.test(call.command))
        const got = stub.calls.some((call) => call.kind === 'get' && call.guestPath.endsWith('clip-read.txt'))
        check('U2: clipboardGet clears the stale read file before running cua-clip-get',
          cleard && stub.calls.some((call) => call.kind === 'ssh' && /cua-clip-get/u.test(call.command)) && got,
          stub.calls.map((call) => `${call.kind}:${call.command ?? call.guestPath}`).join(' | '))
        check('U2: ...and returns the guest text verbatim (CRLF kept)',
          result.ok === true && result.text === 'line 1\r\nline 2' && result.task === 'cua-clip-get', JSON.stringify(result).slice(0, 160))
      }
      // A task that reports 0 but wrote nothing is a failure, not "".
      {
        const stub = makeStub({ missingRead: true })
        const backend = createWindowsBackend({ store, qmp: async () => [], log: () => {}, transport: stub.transport })
        const result = await backend.clipboardGet({ name: 'win-clip' })
        check('U2: a read task that produced no file is a FAILURE (never an empty clipboard)',
          result.ok === false && result.reason === 'missing' && /not readable/u.test(result.detail), JSON.stringify(result))
      }
      // No transport at all is a DISABLED state the callers can render.
      {
        const backend = createWindowsBackend({ store, qmp: async () => [], log: () => {} })
        const set = await backend.clipboardSet({ name: 'win-clip' }, 'x')
        const get = await backend.clipboardGet({ name: 'win-clip' })
        check('U2: without an SSH transport both directions answer reason "no-ssh"',
          set.ok === false && set.reason === 'no-ssh' && get.ok === false && get.reason === 'no-ssh',
          `${set.reason}/${get.reason}`)
      }
      // A hostile payload is refused instead of being pushed at cmd.exe.
      {
        const backend = createWindowsBackend({ store, qmp: async () => [], log: () => {}, transport: makeStub().transport })
        let error = null
        try { await backend.clipboardSet({ name: 'win-clip' }, 'x'.repeat(1024 * 1024 + 1)) } catch (caught) { error = caught }
        check('U2: a payload over 1 MiB is refused (a clipboard is not a file transfer)',
          error !== null && /larger than 1048576 bytes/u.test(error.message), String(error?.message ?? 'no error'))
      }
    } finally {
      if (saved === undefined) delete process.env.DSH_CUA_WIN_CLIP_SETTLE_MS
      else process.env.DSH_CUA_WIN_CLIP_SETTLE_MS = saved
    }
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
}

// ---- U2/U3: THE FIRSTBOOT TASK REGISTRATIONS (source assertions) ----
//
// Nothing here can run PowerShell, but the two defects were both IN THE TEXT:
// a `--pipe` argument upstream does not accept, and a python.exe task registered
// without a hidden flag. Both are asserted literally, because a reviewer can
// read them and a regression is a one-word edit.
{
  const firstboot = readFileSync(path.join(REPO, 'docker', 'windows-oem', 'cua-firstboot.ps1'), 'utf8')
  const mcpSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'win-mcp.js'), 'utf8')
  // U2: TWO tasks, on demand, INTERACTIVE (/it), limited, hidden.
  // The login lines are built inside a generated .cmd (PowerShell 5.1 passes a
  // spaced variable to a native program unquoted), so the assertion is on the
  // FULL line including the executable and the hidden window style.
  check('U2: firstboot registers cua-clip-set as an on-demand INTERACTIVE hidden task',
    /schtasks \/create \/tn `"cua-clip-set`" \/sc ondemand \/it \/rl LIMITED \/f \/tr `"\$trSet`"/u.test(firstboot)
      && /\$trSet = "powershell\.exe[^"]*-WindowStyle Hidden -File \$setScript"/u.test(firstboot))
  check('U2: firstboot registers cua-clip-get the same way',
    /schtasks \/create \/tn `"cua-clip-get`" \/sc ondemand \/it \/rl LIMITED \/f \/tr `"\$trGet`"/u.test(firstboot)
      && /\$trGet = "powershell\.exe[^"]*-WindowStyle Hidden -File \$getScript"/u.test(firstboot))
  check('U2: ...through a generated .cmd, so the /tr argument keeps its quotes',
    /& cmd \/c \$cmdFile/u.test(firstboot) && /Remove-Item -Force \$cmdFile/u.test(firstboot))
  check('U2: the set task reads clip.txt onto the clipboard (Set-Clipboard -Value)',
    /Set-Clipboard -Value \(\[IO\.File\]::ReadAllText\('C:\\ProgramData\\cua\\clip\.txt'\)\)/u.test(firstboot))
  check('U2: the get task writes clip-read.txt from Get-Clipboard -Raw',
    /\[IO\.File\]::WriteAllText\('C:\\ProgramData\\cua\\clip-read\.txt', \[string\]\(Get-Clipboard -Raw\)\)/u.test(firstboot))
  check('U2: the two clipboard tasks run a HIDDEN powershell (no console flash on the desktop)',
    (firstboot.match(/-WindowStyle Hidden -File/g) ?? []).length >= 2)
  // WP-6: THE AMBIENT AGENT. One more interactive task, registered at logon and
  // started immediately, so a copy in Notepad reaches the harness without the
  // panel asking for it.
  check('WP-6: firstboot registers cua-clip-agent at logon, interactive, hidden',
    /schtasks \/create \/tn `"cua-clip-agent`" \/sc onlogon \/it \/rl LIMITED \/f \/tr `"\$agentTr`"/u.test(firstboot)
    && /& schtasks \/run \/tn 'cua-clip-agent'/u.test(firstboot)
    && /\$agentTr = "powershell\.exe[^"]*-WindowStyle Hidden -File \$agentScript"/u.test(firstboot))
  check('WP-6: ...and the agent script comes from the OEM payload, with an embedded fallback',
    /cua-clip-agent\.ps1/u.test(firstboot) && /OEM payload had no cua-clip-agent\.ps1; wrote the embedded copy/u.test(firstboot))
  // U3: WINDOWLESS, AND NO FICTIONAL PIPE.
  check('U3: the autostart task runs pythonw.exe (windowless), not python.exe',
    /New-ScheduledTaskAction -Execute \$pyw -Argument '-m dsh_cua\.server'/u.test(firstboot)
      && !/New-ScheduledTaskAction -Execute \$py -Argument/u.test(firstboot))
  check('U3: the task itself is registered with -Hidden',
    /Register-ScheduledTask -TaskName 'dsh-cua-server'[^\n]*-Hidden -Force/u.test(firstboot))
  check('U3: the fictional `--pipe \\\\.\\pipe\\dsh-cua` argument is GONE from both the task and the MCP command',
    !/'-m dsh_cua\.server --pipe/u.test(firstboot)
      && !/--pipe \\\\\.\\\\pipe\\\\dsh-cua'\s*$/mu.test(mcpSource)
      && /'python -m dsh_cua\.server --stdio'/u.test(mcpSource))
  check('U3: ...and the limitation is documented where the next reader looks',
    /NO NAMED PIPE/u.test(mcpSource) && /ONE shared session-2 server cannot be reached/u.test(mcpSource))
}

// ---- U4: THE FREE SPACE THAT IS ACTUALLY LEFT ----
//
// `diskGb` is the virtual size; the reported computer had 6.8 GB LEFT on a 64 GB
// disk, which is the state Windows Update fails in with an unrelated error. The
// probe's parser takes digits only (a localized PowerShell header must not
// become a number) and the below-floor warning is attached at 10 GB.
{
  check('U4: the probe parser takes the byte count out of a PowerShell answer',
    parseFreeSpaceProbe('7301444403\r\n') === 7301444403
      && parseFreeSpaceProbe('\r\n7301444403\r\n') === 7301444403)
  check('U4: ...an empty or non-numeric answer is UNKNOWN, not 0 GB',
    parseFreeSpaceProbe('') === null && parseFreeSpaceProbe('Get-PSDrive : denied') === null && parseFreeSpaceProbe('0') === null)
  const low = formatWindowsFreeSpace(7301444403) // 6.8 GB
  check('U4: 6.8 GB free is BELOW the 10 GB floor and carries the warning',
    low.belowFloor === true && low.line === '6.80 GB free on C:' && /only 6.80 GB free on C:/u.test(low.warning)
      && low.freeGb === 6.8, JSON.stringify(low))
  const ok2 = formatWindowsFreeSpace(40 * 1024 ** 3)
  check('U4: 40 GB free is above the floor and carries no warning',
    ok2.belowFloor === false && ok2.line === '40.0 GB free on C:' && ok2.warning === undefined, JSON.stringify(ok2))
  check('U4: the floor is the documented 10 GB', WINDOWS_FREE_FLOOR_GB === 10)
}


// ------------------------------------------------------------------ *
// J23: EVERY `cua_vm_*` TOOL CARRIES AN EXPLICIT TIMEOUT ENVELOPE
// ------------------------------------------------------------------ *
// The incident: a `cua_vm_shutdown` whose supervisor op sat in a synchronous
// `qemu-img convert` of a 10 GB system disk hung the tool call for minutes. The
// harness had no per-tool deadline for it, the chat abort could not unwind a body
// blocked on a socket, and the user force-restarted the harness.
//
// The rule that came out of it: whatever the supervisor does, the TOOL layer must
// settle and say what happened. That is a PURE contract here — ONE map, every
// registration drawing from it, `registerCuaTool` refusing a mismatch, and every
// body raced against its deadline with a machine-routable `tool-timeout`. The
// behavioural half (a real hung call settling) has no cheap test; this is the
// half that a rename or a new tool would otherwise break silently.
{
  const source = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
  const uses = [...source.matchAll(/timeoutMs: TOOL_TIMEOUTS\.([a-z_]+),/gu)].map((match) => match[1])
  const mapBody = /const TOOL_TIMEOUTS = Object\.freeze\(\{([\s\S]*?)\n\}\)/u.exec(source)?.[1] ?? ''
  const keys = [...mapBody.matchAll(/^\s{2}([a-z_]+): [\d_]+/gmu)].map((match) => match[1])
  check('J23: every registration draws its timeoutMs from the ONE TOOL_TIMEOUTS map',
    uses.length >= 18 && keys.length === uses.length
      && keys.every((key) => uses.includes(key)) && uses.every((key) => keys.includes(key)),
    `registrations=${uses.length} map=${keys.length}`)
  check('J23: registerCuaTool REFUSES a tool with no envelope, and one whose number disagrees',
    /cua-vm: \$\{definition\.name\} has no TOOL_TIMEOUTS entry/u.test(source)
      && /cua-vm: \$\{definition\.name\} declares timeoutMs=\$\{definition\.timeoutMs\}, TOOL_TIMEOUTS says \$\{declared\}/u.test(source))
  check('J23: every body is ALSO raced against its own deadline (the harness guard is cooperative)',
    /execute: boundedExecute\(definition\.name, declared,/.test(source)
      && /const TIMEOUT_LEAD_MS = 250/u.test(source)
      && /Promise\.race\(\[Promise\.resolve\(\)\.then\(\(\) => execute\(args, exec\)\), expiry\]\)/u.test(source))
  check('J23: the failure is STRUCTURED — code: tool-timeout, repeated in the text the model reads',
    /error\.code = 'tool-timeout'/u.test(source)
      && /timed out after \$\{timeoutLabel\(timeoutMs\)\}s; the supervisor op may still be running/u.test(source)
      && /code: tool-timeout`/u.test(source))
  check('J23: the two caller-budgeted tools resolve their live deadline per call',
    /cua_vm_exec: \(args\) => \(Math\.min\(3600, Math\.max\(1, Number\(args\?\.timeout\) \|\| 300\)\) \* 1000\) \+ EXEC_ENVELOPE_GRACE_MS/u.test(source)
      && /cua_vm_create: \(args\) => \(args\?\.kind === 'windows' \? 60_000 : TOOL_TIMEOUTS\.cua_vm_create\)/u.test(source))
  check('J23: the deferred checkpoint sentence says it is deferred AND that the badge is already powered-off',
    /if \(answer\.checkpoint === 'deferred'\) parts\.push\('Checkpoint: deferred — runs in the background; the panel badge shows powered-off immediately\.'\)/u.test(source)
      && /else if \(answer\.checkpoint\) parts\.push\(`Checkpoint: \$\{answer\.checkpoint\}\.`\)/u.test(source))
}

// ------------------------------------------------------------------ *
// WP-10: THE WINDOWS put/get ARGV, AND THE DOCTOR'S VERDICT ORDER
// ------------------------------------------------------------------ *
// TWO BUGS, TWO PURE CHECKS. Neither needs a guest, QEMU or an SSH server.
//
// (1) `cua_vm_put` failed with `scp: stat local "47000"`: ssh's `-p PORT` was
//     reused for scp, whose `-p` takes NO value, so the port fell through into
//     a POSITIONAL slot — a source file. `buildScpArgv` is exported for exactly
//     this assertion: the SHAPE is the defect.
// (2) `windows_mcp_doctor` reported `online: true / state: ready / 19 tools`
//     seconds after a power-off, because a cached probe was merged OVER the
//     plugin's own verdict. The order of the code is the fix, so the order is
//     what is asserted here (the doctor is not exported; needle + offset).
{
  // (1) Imported in a CHILD with a throwaway store, like parseGuestDf: this
  // suite must never bind the supervisor's socket. With no key file in the
  // store the argv carries no `-i`, which is why only the shape is asserted.
  const store = mkdtempSync(path.join(os.tmpdir(), 'cua-scpargv-unit-'))
  try {
    const supervisorUrl = new URL('../../docker/cua-vm-supervisor.mjs', import.meta.url).href
    const program = `const m = await import(${JSON.stringify(supervisorUrl)});`
      + `const meta = { name: 'winvm', user: 'cua', ports: { ssh: Number(process.argv[1]) } };`
      + `process.stdout.write(JSON.stringify({`
      + `toGuest: m.buildScpArgv(meta, process.argv[2], process.argv[3], { direction: 'to-guest' }),`
      + `fromGuest: m.buildScpArgv(meta, process.argv[2], process.argv[3], { direction: 'from-guest' })`
      + `}));process.exit(0)`
    const local = '/tmp/notes.txt'
    const guest = 'C:\\Users\\cua\\notes.txt'
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, '47000', local, guest], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, CUA_VM_STORE: path.join(store, 'store'), CUA_VM_HOME: path.join(store, 'home'), CUA_SUPERVISOR_SOCK: path.join(store, 's.sock') }
    })
    let argvs = null
    try { argvs = JSON.parse(result.stdout ?? 'null') } catch { argvs = null }
    // OPENSsh's grammar, reduced to what these argv actually contain: `-p`
    // takes NO value (that is the trap), `-P` does, and anything else that does
    // not start with `-` is a positional.
    const parse = (argv) => {
      const withValue = new Set(['-i', '-o', '-P', '-F', '-S', '-J', '-c', '-l'])
      const noValue = new Set(['-q', '-p', '-r', '-T', '-v', '-B', '-C', '-3', '-4', '-6'])
      const flags = new Map()
      const positionals = []
      for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i]
        if (!token.startsWith('-') || token === '-') { positionals.push(token); continue }
        if (withValue.has(token)) { flags.set(token, argv[i + 1]); i += 1; continue }
        if (noValue.has(token)) { flags.set(token, true); continue }
        flags.set(token, true)
      }
      return { flags, positionals }
    }
    const put = argvs === null ? null : parse(argvs.toGuest)
    const get = argvs === null ? null : parse(argvs.fromGuest)
    check('WP-10: buildScpArgv is exported and returns the complete argv (question mark, then flags)',
      argvs !== null && Array.isArray(argvs.toGuest) && argvs.toGuest[0] === '-q',
      `status=${result.status} out=${String(result.stdout ?? '').slice(0, 80)} err=${String(result.stderr ?? '').slice(0, 120)}`)
    check('WP-10: to-guest = [-q, …opts, -P, PORT, LOCAL, user@host:GUEST] — LOCAL first',
      put !== null && put.positionals.join('|') === `${local}|cua@127.0.0.1:${guest}`,
      JSON.stringify(put?.positionals))
    check('WP-10: from-guest is the exact mirror — the remote is the source',
      get !== null && get.positionals.join('|') === `cua@127.0.0.1:${guest}|${local}`,
      JSON.stringify(get?.positionals))
    check("WP-10: the port is the VALUE of -P in both directions, and `-p` is absent (scp's -p means preserve)",
      put !== null && get !== null
        && put.flags.get('-P') === '47000' && get.flags.get('-P') === '47000'
        && put.flags.has('-p') === false && get.flags.has('-p') === false,
      `put=-P ${put?.flags.get('-P')} get=-P ${get?.flags.get('-P')}`)
    check('WP-10: "47000" is NEVER a positional — the exact bug was the port in the source slot',
      put !== null && get !== null
        && [...put.positionals, ...get.positionals].every((value) => value !== '47000'),
      JSON.stringify([...(put?.positionals ?? []), ...(get?.positionals ?? [])]))
    check('WP-10: scp has no -T (a no-pty flag is ssh-only) and no -i without a key in the store',
      put !== null && get !== null && !put.flags.has('-T') && !get.flags.has('-T')
        && !put.flags.has('-i') && !get.flags.has('-i'))
    // One shared option list: the SAME -o pairs, in the SAME order, in both
    // directions — the property that stops ssh's flag set creeping back in.
    const pairs = (argv) => argv.reduce((acc, token, index) => (token === '-o' ? [...acc, argv[index + 1]] : acc), [])
    check('WP-10: both directions carry the SAME -o option list, in the same order (one shared WINDOWS_SSH_OPTS)',
      argvs !== null && pairs(argvs.toGuest).length >= 5
        && pairs(argvs.toGuest).join('|') === pairs(argvs.fromGuest).join('|'),
      argvs === null ? 'no argv' : pairs(argvs.toGuest).join('|'))
  } finally {
    rmSync(store, { recursive: true, force: true })
  }

  // (2) THE DOCTOR'S VERDICT ORDER. The probe is DETAIL; the stream's newest
  // `vm-state` and the plugin's own `WIN_MCP.online` are the VERDICT. Asserted
  // as offsets, because "probe merged over the answer" was a location bug.
  const doctorSource = readFileSync(path.join(REPO, 'plugins', 'dsh-cua-vm', 'index.js'), 'utf8')
  const at = (needle) => doctorSource.indexOf(needle)
  const verdictAt = at('// ---- THE VERDICT COMES FIRST (THE STALE-PROBE FIX) ----')
  const onlineAt = at('const online = streamSaysOffline !== true && WIN_MCP.online === true')
  const staleAt = at('const probeStale = online !== true && probeAgeMs !== null && probeAgeMs > WIN_MCP_PROBE_STALE_MS')
  const overriddenAt = at('const probeOverridden = online !== true && probeFacts.online === true')
  check('WP-10: the doctor computes the VERDICT before it reports a probe, and the conjunction excludes the probe',
    verdictAt > 0 && onlineAt > verdictAt && staleAt > onlineAt && overriddenAt > onlineAt
      && !/const online = [^\n]*probeFacts/u.test(doctorSource),
    `verdict=${verdictAt} online=${onlineAt} stale=${staleAt} overridden=${overriddenAt}`)
  check('WP-10: a not-online vm-state beats a live probe (stream → plugin → probe-as-detail)',
    at('const streamSaysOffline = streamState !== null') > verdictAt
      && at('WIN_MCP_NOT_ONLINE_STATES.has(String(streamState.state).toLowerCase())') > verdictAt
      && /const WIN_MCP_NOT_ONLINE_STATES = new Set\(\[[\s\S]*?'powered-off'[\s\S]*?\]\)/u.test(doctorSource))
  check('WP-10: the probe is aged (probeAgeMs), flagged stale past 5 s, and `overridden` when it lost',
    at('const WIN_MCP_PROBE_STALE_MS = 5000') > 0
      && at('const probeAgeMs = probeAt > 0 ? Math.max(0, Date.now() - probeAt) : null') > 0
      && at('stale: probeStale') > 0
      && at('overridden: probeOverridden') > 0)
  check("WP-10: onlineSource is stream:<state> | plugin | plugin+probe | offline — never a bare 'probe'",
    at("? (WIN_MCP_AUX.probe.online === true ? 'plugin+probe' : 'plugin')") > 0
      && at("      : 'offline'") > 0
      && !/onlineSource[^\n]*\?\s*'probe'\s*:/u.test(doctorSource))
  check('WP-10: the payload puts the VERDICT fields before the probe detail (online, state, onlineSource, probeAgeMs, probe)',
    at('\n    online,\n') > 0
      && at('\n    probeAgeMs,\n') > at('\n    online,\n')
      && at('\n    probe: {\n') > at('\n    probeAgeMs,\n')
      && at('status: online !== true && leaks.length > 0') > 0)
  check('WP-10: the doctor says WHY (guiNote: MCP tools are the element-level lane, a screenshot is the stream)',
    at("const guiNote = 'desktop automation uses the MCP windows tools; cua_vm_gui screenshots are the noVNC stream, not a framebuffer'") > 0)
}
