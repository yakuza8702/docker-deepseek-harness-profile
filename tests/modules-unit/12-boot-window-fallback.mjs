/**
 * 12-boot-window-fallback.mjs — the boot-window fallback after an explicit zero.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { check, os, path, rmSync, waitForQemuBoot, writeFileSync } from './harness.mjs'


// F3 (second half): a window of 0 must still observe ONE real poll interval. A
// zero window used to mean "check once, immediately" — which is how a QEMU that
// had been alive for 1 ms was declared dead. The floor is pollMs.
{
  const pidFile = path.join(os.tmpdir(), `cua-none-${process.pid}-${Date.now()}.pid`)
  try { rmSync(pidFile, { force: true }) } catch {}
  const started = Date.now()
  const verdict = await waitForQemuBoot({ child: { once: () => {} }, pidFile, isAlive: () => false, windowMs: 0, pollMs: 40 })
  const elapsed = Date.now() - started
  check('F3: windowMs 0 still waits one poll interval before declaring a timeout',
    verdict.ok === false && verdict.reason === 'timeout' && elapsed >= 35, `${elapsed}ms ${JSON.stringify(verdict)}`)
  // ...and a pidfile written DURING that interval is still seen, which is the
  // exact live shape: QEMU writes it a few ms after spawn.
  writeFileSync(pidFile, `${process.pid}\n`)
  const seen = await waitForQemuBoot({ child: { once: () => {} }, pidFile, isAlive: (pid) => pid === process.pid, windowMs: 0, pollMs: 40 })
  check('F3: ...so a pidfile that appears within it is accepted', seen.ok === true, JSON.stringify(seen))
  try { rmSync(pidFile, { force: true }) } catch {}
}
