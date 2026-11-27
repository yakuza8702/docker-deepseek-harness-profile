#!/usr/bin/env node
/**
 * modules-unit.mjs — the pure parts of the two new modules, and the Windows
 * container spec, asserted without a VM, a container or a daemon.
 *
 * SPLIT (S3/O10): the contract groups now live one file per unit under
 * ./modules-unit/, and this file is the runner. It imports them in the same
 * order the statements used to run, so `node tests/modules-unit.mjs` prints the
 * same lines, the same count and the same verdict as the single 5,682-line file
 * it replaced. The shared probe (imports, check(), fixtures) is harness.mjs.
 *
 * The F3 boot-window block below stays IN THIS FILE on purpose:
 * `tools/check-cua-vm.mjs` N3 asserts, by text, that this path deletes
 * DSH_CUA_WINDOWS_BOOT_SETTLE_MS and pins 15000 / 5000 / explicit-0. Moving it
 * into a suite would leave the gate reading a runner with no such evidence, so
 * the block runs here between the two halves of the suite list — same order,
 * same assertions, same output.
 */
import { REPO, check, failures, path, pendings, qemuBootWindowMs, readFileSync } from './modules-unit/harness.mjs'

await import('./modules-unit/01-space-and-geometry.mjs')
await import('./modules-unit/02-windows-catalog.mjs')
await import('./modules-unit/03-answer-media-and-argv.mjs')
await import('./modules-unit/04-firmware-and-image-selection.mjs')
await import('./modules-unit/05-fix-round-pure.mjs')
await import('./modules-unit/06-iso-cache-and-tool-namespace.mjs')
await import('./modules-unit/07-relay-probe.mjs')
await import('./modules-unit/08-clipboard-and-websocket.mjs')
await import('./modules-unit/09-guest-disk-and-windows-defaults.mjs')
await import('./modules-unit/10-kvm-preflight.mjs')
await import('./modules-unit/11-windows-install-detail.mjs')

// ---- F3: the boot window, unset / empty / explicit zero (check-cua-vm N3) ----

// ---- F3: THE BOOT WINDOW'S DEFAULT SURVIVES AN UNSET ENV ----
//
// THE LIVE BUG. `Number(process.env.X ?? '')` turns an unset variable into 0,
// `0 >= 0` passed, and `qemuBootWindowMs()` returned 0 ms — so `waitForQemuBoot`
// polled once against an already-expired deadline and reported a QEMU that was
// ~1 ms old as dead ("died during init (none): no stderr output"). The suites
// never caught it because both SET the variables (tests/windows-boot.mjs:94,
// tests/supervisor-smoke.mjs:242): a test that supplies a number cannot observe
// the default. These cases DELETE the variable instead.
{
  const savedBoot = process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS
  const savedEarly = process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS
  const restore = () => {
    if (savedBoot === undefined) delete process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS
    else process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS = savedBoot
    if (savedEarly === undefined) delete process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS
    else process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS = savedEarly
  }
  try {
    // UNSET — the production shape, and the one that broke.
    delete process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS
    delete process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS
    check('F3: unset env → qemuBootWindowMs() === 15000', qemuBootWindowMs() === 15000, String(qemuBootWindowMs()))
    // `windowsEarlyDeathWindowMs` is module-private in the supervisor (it is not
    // exported), so this asserts the SAME expression on a fresh import of the
    // module's own shape: the source must not fall back to `Number(env ?? '')`.
    const supervisorSource = readFileSync(path.join(REPO, 'docker', 'cua-vm-supervisor.mjs'), 'utf8')
    check('F3: windowsEarlyDeathWindowMs() parses only a NON-EMPTY raw value',
      /const raw = process\.env\.DSH_CUA_WINDOWS_EARLY_CHECK_MS\n\s+if \(raw !== undefined && raw !== ''\) \{/u.test(supervisorSource)
      && /function windowsEarlyDeathWindowMs\(\) \{\n\s+const raw = process\.env\.DSH_CUA_WINDOWS_EARLY_CHECK_MS/u.test(supervisorSource)
      && !/Number\(process\.env\.DSH_CUA_WINDOWS_EARLY_CHECK_MS \?\? ''\)/u.test(supervisorSource))
    // The same expression, evaluated here, must give the 5000 default.
    const earlyWindow = (() => {
      const raw = process.env.DSH_CUA_WINDOWS_EARLY_CHECK_MS
      if (raw !== undefined && raw !== '') {
        const parsed = Number(raw)
        if (Number.isFinite(parsed) && parsed >= 0) return Math.min(60000, Math.max(0, Math.trunc(parsed)))
      }
      return 5000
    })()
    check('F3: unset env → the early-death window is the 5000 ms default', earlyWindow === 5000, String(earlyWindow))
    // '' is unset's twin: `Number('') === 0` is exactly the trap.
    process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS = ''
    check('F3: empty-string env → 15000 (not 0)', qemuBootWindowMs() === 15000, String(qemuBootWindowMs()))
    // AN EXPLICIT 0 IS HONORED — it is a real request for the shortest window,
    // not a typo to be upgraded to 15 s.
    process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS = '0'
    check('F3: an EXPLICIT "0" is honored as 0', qemuBootWindowMs() === 0, String(qemuBootWindowMs()))
    process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS = '1500'
    check('F3: a set value is still read (1500)', qemuBootWindowMs() === 1500, String(qemuBootWindowMs()))
    process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS = 'nonsense'
    check('F3: an unparsable value falls back to 15000', qemuBootWindowMs() === 15000, String(qemuBootWindowMs()))
    process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS = '999999'
    check('F3: the window is still capped at 120000', qemuBootWindowMs() === 120000, String(qemuBootWindowMs()))
  } finally {
    restore()
  }
}

await import('./modules-unit/12-boot-window-fallback.mjs')
await import('./modules-unit/13-windows-boot-and-row.mjs')
await import('./modules-unit/14-setup-image.mjs')
await import('./modules-unit/15-clipboard-payload.mjs')
await import('./modules-unit/16-relay-reassert.mjs')
await import('./modules-unit/17-desktop-facts.mjs')
await import('./modules-unit/18-relay-unresponsive.mjs')
await import('./modules-unit/19-payload-staging.mjs')
await import('./modules-unit/20-supervisor-window-and-relay.mjs')
await import('./modules-unit/21-cli-resolution.mjs')


console.log(failures === 0 ? '\nunit: PASS' : `\nunit: ${failures} FAILURE(S)`)
if (pendings > 0) {
  console.log(`unit: ${pendings} check(s) PENDING — the production half is absent (SOL WP-4).`)
  console.log('  Run with DSH_CUA_CONTRACT_STRICT=1 to require them now (the T2 mutation check).')
}
process.exit(failures === 0 ? 0 : 1)
