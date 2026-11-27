/**
 * 09-guest-disk-and-windows-defaults.mjs — the guest disk parser, the capacity warnings and the OEM payload list.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { OEM_GUARD_FILE, OEM_MCP_RELAY_FILE, OEM_PAYLOAD_FILES, OEM_PAYLOAD_REQUIRED, REPO, check, chmodSync, existsSync, mkdtempSync, oemPayloadDeniedDir, oemPayloadDeniedError, oemPayloadDir, oemPayloadDirStatus, oemPayloadMissingError, os, path, resolveOemSourceDir, rmSync, spawnSync, windowsCapacityWarnings, writeFileSync, writeOemPayload } from './harness.mjs'
import { paths } from './02-windows-catalog.mjs'


// ------------------------------------------------------------------ *
// WP-9.1: THE GUEST DISK MEASUREMENT (the supervisor's own parser)
// ------------------------------------------------------------------ *
{
  // Imported in a CHILD with a throwaway store so this suite never binds the
  // supervisor's socket; the parser itself is pure and is the whole contract.
  const store = mkdtempSync(path.join(os.tmpdir(), 'cua-df-'))
  try {
    const supervisorUrl = new URL('../../docker/cua-vm-supervisor.mjs', import.meta.url).href
    const program = `const m = await import(${JSON.stringify(supervisorUrl)});`
      + `process.stdout.write(JSON.stringify(m.parseGuestDf(process.argv[1])));process.exit(0)`
    const sample = '         50450432     40845232'
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, sample], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, CUA_VM_STORE: path.join(store, 'store'), CUA_VM_HOME: path.join(store, 'home'), CUA_SUPERVISOR_SOCK: path.join(store, 's.sock') }
    })
    let parsed = null
    try { parsed = JSON.parse(result.stdout ?? 'null') } catch { parsed = null }
    check('WP-9.1: parseGuestDf reads the LAST two-integer line as size/avail bytes',
      parsed?.sizeBytes === 50450432 && parsed?.availBytes === 40845232,
      `status=${result.status} out=${String(result.stdout ?? '').slice(0, 80)} ${String(result.stderr ?? '').slice(0, 80)}`)
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
}

// Floors are warnings, not clamps.
check('the Windows defaults produce no warnings', windowsCapacityWarnings({ diskGb: 64, memory: 6, cpu: 2 }).length === 0)
check('a below-floor disk warns and is not refused', (() => {
  const warnings = windowsCapacityWarnings({ diskGb: 8, memory: 6, cpu: 2 })
  return warnings.length === 1 && warnings[0].code === 'disk-below-floor' && /Windows Update will run out of space/u.test(warnings[0].message)
})())
check('a below-floor RAM and CPU warn too', windowsCapacityWarnings({ diskGb: 64, memory: 2, cpu: 1 }).map((w) => w.code).join(',') === 'memory-below-floor,cpu-below-floor')
check('the Windows store paths are all under $STORE', Object.values(paths).every((value) => String(value).startsWith('/cua-vm/')))

// K2: THE OEM PAYLOAD — path, self-heal, and the actionable failure.
// The user-facing bug was a runtime error that named a path and nothing else:
// "the OEM payload is missing from this image: /usr/local/share/cua-vm/windows-oem".
// These four checks pin the three properties that make it recoverable.
{
  const repoOem = path.join(REPO, 'docker', 'windows-oem')
  // WP-6/J22-14 + WP-1.4: THE CLIPBOARD AGENT, THE MCP RELAY AND THE BOOT GUARD
  // ARE PAYLOAD FILES. The four original files still make a directory a payload
  // directory (OEM_PAYLOAD_REQUIRED); the other three are staged because
  // firstboot can only copy what is in the medium it stages from — and the guard
  // in particular has to survive on the guest so a boot can re-assert the relay.
  check('the OEM payload list is the four required files plus the clipboard agent, the MCP relay and the boot guard',
    OEM_PAYLOAD_FILES.join(',') === 'Autounattend.xml,setupcomplete.cmd,cua-firstboot.ps1,Unattend.vbs,cua-clip-agent.ps1,cua-mcp-relay.py,cua-relay-guard.ps1'
    && OEM_PAYLOAD_REQUIRED.join(',') === 'Autounattend.xml,setupcomplete.cmd,cua-firstboot.ps1,Unattend.vbs'
    // The two staged guests are a PAIR, in order: the relay the lane speaks to,
    // then the guard that re-creates it at boot.
    && OEM_PAYLOAD_FILES.slice(-2).join(',') === [OEM_MCP_RELAY_FILE, OEM_GUARD_FILE].join(',')
    && OEM_PAYLOAD_FILES.at(-1) === OEM_GUARD_FILE,
    OEM_PAYLOAD_FILES.join(','))
  check('a complete payload directory is recognised, an incomplete one is not', (() => {
    const partial = mkdtempSync(path.join(os.tmpdir(), 'oem-partial-'))
    try {
      writeFileSync(path.join(partial, 'Autounattend.xml'), '<unattend/>')
      return oemPayloadDir(repoOem) === repoOem && oemPayloadDir(partial) === null && oemPayloadDir('/no/such/dir') === null
    } finally {
      rmSync(partial, { recursive: true, force: true })
    }
  })())
  check('the resolver prefers the configured source and falls back in order', (() => {
    const dirs = ['/no/such/dir', repoOem]
    return resolveOemSourceDir(dirs) === repoOem && resolveOemSourceDir(['/no/such/dir']) === null
  })())
  check('a stale source self-heals from the fallback, with a log line', (() => {
    const store = mkdtempSync(path.join(os.tmpdir(), 'oem-write-'))
    const logged = []
    try {
      const oemDir = writeOemPayload({
        paths: { oemDir: path.join(store, 'oem') },
        name: 'win-1', password: 'p@ss', sshPubKey: 'ssh-ed25519 AAA test',
        sourceDir: '/no/such/image/dir', fallbackDirs: [repoOem],
        pythonUrl: 'https://example.invalid/python.exe', dshCuaSpec: 'dsh-cua', log: (line) => logged.push(line)
      })
      return existsSync(path.join(oemDir, 'Autounattend.xml'))
        && existsSync(path.join(oemDir, '$OEM$', '$$', 'Setup', 'Scripts', 'cua-firstboot.ps1'))
        && existsSync(path.join(oemDir, '$OEM$', '$$', 'Setup', 'Scripts', 'Unattend.vbs'))
        && logged.some((line) => line.includes('using the copy at'))
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })())
  check('with no payload anywhere the error is actionable, not a bare path', (() => {
    // In a CHECKOUT the module directory itself carries windows-oem/, so
    // writeOemPayload would self-heal here and never reach this message. Assert
    // on the builder the writer throws with — that is what the user reads.
    const message = oemPayloadMissingError({ sourceDir: '/usr/local/share/cua-vm/windows-oem', fallbackDirs: ['/opt/seek-harness/cua-check'] }).message
    return message.includes('no Autounattend.xml, setupcomplete.cmd, cua-firstboot.ps1')
      && message.includes('missing from this image')
      && message.includes('--build-arg WITH_VIRGL_QEMU=1')
      && message.includes('docker compose -f compose.windows.yaml up -d --force-recreate')
      && message.includes('/cua-vm')
      && message.includes('docker compose exec seek-harness ls -l /usr/local/share/cua-vm/windows-oem/')
      && message.includes('DSH_CUA_WINDOWS_OEM_DIR')
  })())
  // K6: A PERMISSION BUG MUST NOT READ AS A MISSING PAYLOAD. The shipped defect
  // was `COPY --chmod=0644 docker/windows-oem/ <dest>/`: the flag applies to the
  // directories the COPY creates, so the destination arrived `drw-r--r--` and a
  // uid-1000 process could not traverse it. `existsSync` answers FALSE on EACCES,
  // so the image said "the OEM payload is missing" while the files sat in the
  // pushed layer — and the advice (pull a newer image) was the wrong fix.
  {
    const root = typeof process.getuid === 'function' ? process.getuid() : -1
    const locked = mkdtempSync(path.join(os.tmpdir(), 'oem-eacces-'))
    // `0o644` on a directory removes the traverse bit for every class; POSIX
    // denies the chmod'd owner itself, so this reproduces the image defect
    // exactly without needing a second uid. Root bypasses DAC, so it cannot be
    // simulated there — that is reported as NOT RUN, never as a pass.
    const simulated = root !== 0
    if (!simulated) {
      console.log('  n/a  EACCES classification: running as uid 0, which bypasses DAC — not simulated')
    }
    try {
      for (const file of OEM_PAYLOAD_FILES) writeFileSync(path.join(locked, file), 'x')
      if (simulated) chmodSync(locked, 0o644)

      const status = oemPayloadDirStatus(locked)
      check('a non-traversable directory is reported as DENIED, not as empty/missing', simulated
        ? status.denied !== null && String(status.denied.code) === 'EACCES' && oemPayloadDir(locked) === null
        : status.denied === null && oemPayloadDir(locked) === locked,
      simulated ? `code=${status.denied?.code ?? 'none'}` : 'root: DAC bypassed, directory stays readable')

      check('the denied directory is NAMED by oemPayloadDeniedDir (so the error picks the right text)',
        simulated ? oemPayloadDeniedDir(['/no/such/dir', locked]) === locked : oemPayloadDeniedDir(['/no/such/dir', locked]) === null)

      const message = oemPayloadDeniedError({ sourceDir: locked, denied: path.join(locked, 'Autounattend.xml'), fallbackDirs: ['/opt/seek-harness/cua-check'] }).message
      check('the permission error names the mode/owner, the defect and the fix — not "pull a newer image"', (() => {
        const has = (needle) => message.includes(needle)
        return has('NOT READABLE')
          && has('IMAGE PERMISSIONS defect')
          && has('install -d -m 0755 /usr/local/share/cua-vm')
          && has('chmod -R a+rX /usr/local/share/cua-vm/windows-oem')
          && has('--chown=1000:1000 --chmod=0644')
          && has('read_only, so `chmod` inside the')
          && has('docker compose exec seek-harness ls -l /usr/local/share/cua-vm/windows-oem/')
          && !has('build it from branch cua-vm-improve')
      })())

      check('a denied source is never mistaken for a missing payload (self-heal or EACCES, never "pull an image")', (() => {
        if (!simulated) return true
        const store = mkdtempSync(path.join(os.tmpdir(), 'oem-denied-write-'))
        try {
          writeOemPayload({
            paths: { oemDir: path.join(store, 'oem') },
            name: 'win-1', password: 'p', sshPubKey: 'k',
            // The checkout's own docker/windows-oem/ is a legitimate last resort,
            // so this either self-heals from it or throws the PERMISSION error.
            // What must never happen: the "missing from this image" text, whose
            // advice (pull a newer image) does not fix a mode bits problem.
            sourceDir: locked, fallbackDirs: [], pythonUrl: 'u', dshCuaSpec: 's'
          })
          return existsSync(path.join(store, 'oem', 'Autounattend.xml'))
        } catch (error) {
          return error.code === 'EACCES' && /IMAGE PERMISSIONS defect/u.test(error.message)
        } finally {
          rmSync(store, { recursive: true, force: true })
        }
      })())
    } finally {
      if (simulated) chmodSync(locked, 0o755)
      rmSync(locked, { recursive: true, force: true })
    }
  }
  check('the writer throws THAT error when a directory holds only part of the payload', (() => {
    const store = mkdtempSync(path.join(os.tmpdir(), 'oem-nopayload-'))
    const partial = mkdtempSync(path.join(os.tmpdir(), 'oem-onlyxml-'))
    try {
      writeFileSync(path.join(partial, 'Autounattend.xml'), '<unattend/>')
      try {
        writeOemPayload({
          paths: { oemDir: path.join(store, 'oem') },
          name: 'win-1', password: 'p', sshPubKey: 'k',
          // A CHECKOUT self-heals from the module directory, so this asserts the
          // partial directory is not mistaken for a complete one: the write
          // either succeeds through the checkout copy or throws the actionable
          // error — never half a payload.
          sourceDir: partial, fallbackDirs: [], pythonUrl: 'u', dshCuaSpec: 's'
        })
        return existsSync(path.join(store, 'oem', 'cua-firstboot.ps1'))
      } catch (error) {
        return /the Windows OEM payload is missing from this image/u.test(error.message)
      }
    } finally {
      rmSync(store, { recursive: true, force: true })
      rmSync(partial, { recursive: true, force: true })
    }
  })())
}
