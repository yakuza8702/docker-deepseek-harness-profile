/**
 * 05-fix-round-pure.mjs — the pure halves of the J21/J1/J22 fix-round regressions.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10), which this suite
 * used to be a contiguous region of. The runner imports the suites in file
 * order, so every check below prints exactly where it printed before.
 */
import { check, clipAckVerdict, clipSha256, createWindowsBackend, os, qemuEscapeOptionValue } from './harness.mjs'


// ------------------------------------------------------------------ *
// J21/J1/J22 — THE FIX-ROUND REGRESSIONS (pure halves)
//
// Each check below is one defect from the jury round, asserted against the
// SHIPPED export (no copy of the logic): the verdict's reason, the comma
// escape, the agent's three clock spellings, the unpinned cache, the outbox
// budget and the NUL truncation. The end-to-end halves live in
// supervisor-smoke.mjs; these are the parts a module can prove alone.
// ------------------------------------------------------------------ *
{
  // J21-2: AN AGENT THAT SAYS "I FAILED" IS NOT A DIGEST MISMATCH. The old code
  // looked only at equal/seq/sha256, so `{ ok: false, error: 'locked' }` fell
  // through to the generic ack-mismatch — sending an operator to look at hashing
  // and encoding instead of at the agent's real complaint.
  const sha = clipSha256('hello')
  const locked = clipAckVerdict({ seq: 7, sha256: sha }, { ok: false, code: 'E_LOCK', error: 'clipboard is locked by another process' })
  check('J21-2: an ack with ok:false + a code answers agent-error:<code>, not ack-mismatch',
    locked.ok === false && locked.reason === 'agent-error:E_LOCK'
    && /the agent reported a failure/u.test(locked.detail) && /locked by another process/u.test(locked.detail),
    JSON.stringify(locked))
  const noCode = clipAckVerdict({ seq: 7, sha256: sha }, { ok: false, error: 'Set-Clipboard threw\r\nat line 4' })
  check('J21-2: ...a message with no code becomes the (one-line, truncated) agent-error text',
    noCode.reason === 'agent-error:Set-Clipboard threw at line 4', noCode.reason)
  // AGENTS THAT PREDATE THE FIELD SEND NO `ok` AT ALL: `undefined` is NOT false.
  const legacy = clipAckVerdict({ seq: 7, sha256: sha }, { seq: 7, sha256: sha, equal: true })
  check('J21-2: an ack with NO ok field is still a pass when seq+sha+equal agree (undefined ≠ false)',
    legacy.ok === true && legacy.reason === '', JSON.stringify(legacy))
  const emptyError = clipAckVerdict({ seq: 7, sha256: sha }, { seq: 7, sha256: sha, equal: true, error: '   ' })
  check('J21-2: ...and a whitespace-only error string is not a failure either', emptyError.ok === true)

  // J1-3: `,,` IS THE ONLY ESCAPE QEMU'S OPTION SPLITTER UNDERSTANDS.
  check("J1-3: qemuEscapeOptionValue('a,b') is 'a,,b' (and leaves a clean path alone)",
    qemuEscapeOptionValue('a,b') === 'a,,b'
    && qemuEscapeOptionValue('/store/windows/win1/disk.qcow2') === '/store/windows/win1/disk.qcow2'
    && qemuEscapeOptionValue('a,b,c') === 'a,,b,,c'
    && qemuEscapeOptionValue('') === '',
    qemuEscapeOptionValue('a,b'))

  // J21-1 + J21-6: THE AGENT-FIRST PATH, DRIVEN WITH A STUB TRANSPORT. `state`
  // is whatever the guest's clip-state.json holds; `agent:false` makes the file
  // unreadable (the schtasks fallback).
  const makeClipStub = ({ agent = true, state = { at: Date.now(), seq: 5 }, readBack = '' } = {}) => {
    const calls = []
    const files = new Map()
    let job = null
    return {
      calls,
      transport: {
        async sshRun(_spec, command) {
          calls.push({ kind: 'ssh', command })
          if (/type "[^"]*clip-state\.json"/u.test(command)) {
            return agent ? { code: 0, stdout: JSON.stringify(state), stderr: '' } : { code: 1, stdout: '', stderr: 'File Not Found' }
          }
          if (/type "[^"]*clip-ack\.json"/u.test(command)) {
            if (job === null) return { code: 1, stdout: '', stderr: 'File Not Found' }
            return { code: 0, stdout: JSON.stringify({ seq: job.seq, sha256: job.sha256, equal: true }), stderr: '' }
          }
          if (/type "[^"]*clip-current\.txt"/u.test(command)) return { code: 0, stdout: readBack, stderr: '' }
          if (/schtasks \/run/u.test(command)) return { code: 0, stdout: 'SUCCESS: Attempted to run', stderr: '' }
          if (/schtasks \/query/u.test(command)) return { code: 0, stdout: 'Status: Ready\r\nLast Result: 0\r\n', stderr: '' }
          return { code: 0, stdout: '', stderr: '' }
        },
        async putText(_spec, guestPath, text) {
          calls.push({ kind: 'put', guestPath, text })
          files.set(guestPath, text)
          if (guestPath.endsWith('.json')) { try { job = JSON.parse(text) } catch { job = null } }
          return { code: 0, stderr: '' }
        },
        async getText(_spec, guestPath) {
          calls.push({ kind: 'get', guestPath })
          return { code: 0, stderr: '', text: files.get(guestPath) ?? readBack }
        }
      }
    }
  }

  // J21-1a: `at`, `ts` AND `updatedAt` ALL NAME A LIVE AGENT. Reading only `ts`
  // made the shipped agent (which writes `at`) evaluate as age 0 → Infinity →
  // stale, so the fast path never ran.
  for (const key of ['at', 'ts', 'updatedAt']) {
    const stub = makeClipStub({ state: { [key]: Date.now(), seq: 5 } })
    const backend = createWindowsBackend({ store: os.tmpdir(), qmp: async () => [], log: () => {}, transport: stub.transport })
    const answer = await backend.clipboardSet({ name: 'clip-clock' }, 'hello')
    check(`J21-1: readClipState accepts \`${key}\` as the agent's clock (fast path taken)`,
      answer.ok === true && answer.via === 'agent', JSON.stringify(answer).slice(0, 180))
  }
  // NO STAMP AT ALL IS 0, and 0 is `stampMissing` + `agent-stale`, never
  // invented freshness: the backend declines the fast path and says why.
  {
    const stub = makeClipStub({ state: { seq: 5 } })
    const backend = createWindowsBackend({ store: os.tmpdir(), qmp: async () => [], log: () => {}, transport: stub.transport })
    const answer = await backend.clipboardSet({ name: 'clip-clock' }, 'hello')
    check('J21-1: a state file with NO clock stamp is agent-stale (missing = 0, never fresh)',
      answer.ok === true && answer.via === 'task' && answer.fastPathReason === 'agent-stale',
      JSON.stringify(answer).slice(0, 200))
  }

  // J21-5c: THE OUTBOX BUDGET IS CHECKED BEFORE ANY ROUND TRIP. The agent refuses
  // a JOB FILE, and 1 MiB − 2048 is the text budget; a text just over it must not
  // cost an SSH call that can only end in `agent-error:too-large`.
  {
    const stub = makeClipStub()
    const backend = createWindowsBackend({ store: os.tmpdir(), qmp: async () => [], log: () => {}, transport: stub.transport })
    const answer = await backend.clipboardSet({ name: 'clip-big' }, 'x'.repeat(1_047_000))
    // THE JOB NEVER LEAVES THE HOST. 1 MiB − 2048 is the outbox text budget, and
    // the text (1 047 000 bytes) is legal for the TASK path but not as a job FILE.
    // The fast path therefore declines with `too-large` before any clip-state /
    // clip-ack / outbox round trip, and the documented schtasks fallback — whose
    // limit is the 1 MiB text — still delivers. What must NOT happen is a job file
    // being uploaded only for the agent to refuse it, or a silent downgrade.
    const agentCalls = stub.calls.filter((call) => call.kind === 'ssh' && /clip-state|clip-ack/u.test(call.command))
    const jobUploads = stub.calls.filter((call) => call.kind === 'put' && /outbox/u.test(String(call.guestPath)))
    check('J21-5: an over-budget text declines the fast path as too-large with ZERO agent round trips',
      answer.ok === true && answer.via === 'task' && answer.fastPathReason === 'too-large'
      && agentCalls.length === 0 && jobUploads.length === 0,
      `via=${answer.via} fastPathReason=${answer.fastPathReason} agentCalls=${agentCalls.length} jobUploads=${jobUploads.length}`)
  }

  // J21-6: A NUL IS A TRUNCATION. Windows' clipboard stops at U+0000, so the
  // task path stays ok:true but must say `verified:false` and how much landed.
  {
    const stub = makeClipStub({ agent: false })
    const backend = createWindowsBackend({ store: os.tmpdir(), qmp: async () => [], log: () => {}, transport: stub.transport })
    const answer = await backend.clipboardSet({ name: 'clip-nul' }, 'a\u0000bc')
    check('J21-6: a NUL in the text reports nulTruncated{landed,total} and verified:false',
      answer.ok === true && answer.via === 'task' && answer.verified === false
      && answer.nulTruncated?.landed === 1 && answer.nulTruncated?.total === 4
      && /stops at the first NUL \(1 of 4 characters landed\)/u.test(answer.detail ?? ''),
      JSON.stringify(answer.nulTruncated ?? null) + ' ' + String(answer.detail ?? '').slice(0, 120))
  }
}
