/**
 * cua-vm-lock — THE WAITERS' HALF OF THE SUPERVISOR'S LOCKS (C1–C7).
 *
 * WHAT WAS WRONG AT HEAD
 * ----------------------
 * `withLock` (`cua-vm-supervisor.mjs`, `CREATE_LOCK`) had no deadline: a waiter
 * was a promise chained behind every predecessor, so ONE holder that never
 * settled (a `qemu-img` convert, a QMP monitor that stopped answering, a wedged
 * ACPI powerdown) silently silenced every later power operation on that
 * computer — the panel's Start/Shutdown buttons simply never answered, with no
 * error to read and nothing in the log. There was also no way to LOOK at the
 * lock: "is something holding it?" was unanswerable from outside.
 *
 * WHAT THIS MODULE ADDS, AND WHAT IT DELIBERATELY DOES NOT
 * --------------------------------------------------------
 *   * a per-WAITER deadline (queue time only, C3/I5) — a waiter that expires
 *     never runs its `fn`, and its slot is released immediately so the chain
 *     never stalls;
 *   * a HELD map, so the holder can be NAMED (`lockSnapshot`, the refusal
 *     sentence, the panel's `lock` row);
 *   * a `try*` variant for background loops (C6: user-facing ops throw,
 *     background loops skip);
 *   * poison-not-break (C5): past `LOCK_POISON_MS` new waiters fail fast with
 *     the restart runbook instead of queueing behind a holder that is never
 *     coming back.
 *
 * It does NOT break a lock. There is no forced release, no cancellation, no
 * context switch: a holder is ALWAYS allowed to finish (C3/C5). Releasing a
 * lock whose holder is still inside `qemu-img` or QMP would let two operations
 * touch one disk, which is silently worse than an honest refusal.
 *
 * PURITY: this module imports `AsyncLocalStorage` and timers, nothing else. It
 * never reads the registry, never logs by itself (a logger can be injected with
 * `useLockLogger`) and has no idea what a computer is. That is what makes it
 * unit-testable, and it is why it can be adopted without touching a single
 * operation body.
 *
 * THE CHAIN IS THE HEAD CHAIN (C2). One promise chain per key, stored
 * non-rejecting, so a failed predecessor still runs the next `fn` (I4) and one
 * thrown operation can never deadlock the key (I3/I4). Everything else above is
 * additive.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** Default waiter deadline — QUEUE TIME ONLY (C3). Seconds, not minutes: a
 *  refusal at 30 s is an answer; a queue for 30 min is the defect. */
export const LOCK_WAIT_MS = 30_000
/** A holder this old is named in the log (once a minute, per key). */
export const LOCK_HOLD_WARN_MS = 600_000
/** A holder this old poisons its key: new waiters fail fast (C5). It is NEVER
 *  released — see the header. */
export const LOCK_POISON_MS = 1_800_000
/** How often the "holder is old" line may repeat for one key. */
const HOLD_WARN_INTERVAL_MS = 60_000

/** `DSH_CUA_VM_LOCK_WAIT_MS`: a finite millisecond deadline, or "0" for the
 *  legacy — wait for ever — semantics. One env var is the whole rollback knob
 *  (C6/§5): `DSH_CUA_VM_LOCK_WAIT_MS=0` restores HEAD behaviour without a code
 *  revert. An unreadable value is the default, never "no deadline". */
export function lockWaitMs() {
  return envMs('DSH_CUA_VM_LOCK_WAIT_MS', LOCK_WAIT_MS, { zeroMeansInfinity: true })
}

/** `DSH_CUA_VM_LOCK_POISON_MS`: how long a holder may run before new waiters
 *  refuse instantly (never releases the lock, only changes the failure speed). */
export function lockPoisonMs() {
  return envMs('DSH_CUA_VM_LOCK_POISON_MS', LOCK_POISON_MS, { zeroMeansInfinity: true })
}

/** `DSH_CUA_VM_LOCK_HOLD_WARN_MS`: when a holder starts being named in the log. */
export function lockHoldWarnMs() {
  return envMs('DSH_CUA_VM_LOCK_HOLD_WARN_MS', LOCK_HOLD_WARN_MS, { zeroMeansInfinity: false })
}

function envMs(name, fallback, { zeroMeansInfinity = false } = {}) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return fallback
  if (value === 0) return zeroMeansInfinity ? Infinity : fallback
  return Math.round(value)
}

/** The human name of a key: `vm:win-1` is the computer `win-1`; `@registry`
 *  keeps its own name, because "another operation on @registry" is the truth. */
function lockNameOf(key) {
  const text = String(key ?? '')
  return text.startsWith('vm:') ? text.slice(3) : text
}

/**
 * THE LOUD, TYPED REFUSAL (C4).
 *
 * Frozen message shape, built by `lockTimeoutSentence`:
 *   another operation on <name> has been running for <N>s (<holder>); the panel
 *   still shows <state>
 * The state is not known HERE (this module has no registry), so it is appended
 * by the caller that does — the supervisor's dispatcher — through
 * `lockTimeoutSentence(error, { state })`. Everything a caller can act on is a
 * FIELD (`code`, `lockHeldBy`, `lockHeldMs`, `waitedMs`, `poisoned`), because
 * the supervisor renders every refusal through `fail(error, extra)`.
 */
export class LockTimeoutError extends Error {
  constructor(key, held, waitedMs, { poisoned = null } = {}) {
    const name = lockNameOf(key)
    const holder = String(held?.holder ?? '')
    const heldMs = Math.max(0, Number(held?.heldMs ?? 0) || 0)
    const seconds = Math.round(heldMs / 1000)
    super(`another operation on ${name} has been running for ${seconds}s (${holder === '' ? 'unknown holder' : holder})`)
    this.name = 'LockTimeoutError'
    this.code = 'lock-timeout'
    this.lockKey = String(key ?? '')
    this.lockName = name
    this.lockHeldBy = holder
    this.lockHeldMs = heldMs
    // `Infinity` is not JSON — a caller that renders this into an answer gets
    // `null`, which reads as "waited for ever", the truth in legacy mode.
    this.waitedMs = Number.isFinite(waitedMs) ? waitedMs : null
    this.poisoned = poisoned === null ? held?.poisoned === true : poisoned === true
  }
}

/**
 * THE ORDER GUARD (C7).
 *
 * One total order: `vm:<name>` → (`@ports` | `@store`) → `@registry`, and
 * `@registry` is a LEAF: a mutator callback may never acquire anything else.
 * The rule is already true in the tree (verified on the call sites); this makes
 * it a CHECKED invariant instead of a comment.
 */
export class LockOrderError extends Error {
  constructor(heldKey, key) {
    super(`lock order violation: ${key} cannot be acquired while ${heldKey} is held (@registry is a leaf lock: take it, write, release it, and acquire nothing inside the mutator)`)
    this.name = 'LockOrderError'
    this.code = 'lock-order-violation'
    this.lockKey = String(key ?? '')
    this.lockHeldBy = String(heldKey ?? '')
  }
}

/**
 * ONE PROMISE CHAIN PER KEY (C2) — never rejecting, so a failed predecessor
 * still runs the next `fn` (I4) and no operation can deadlock its key (I3).
 */
const CHAIN = new Map()
/** key -> { holder, since } while a `fn` is running (the truth `lockSnapshot` reads). */
const HELD = new Map()
/** key -> Set of queued waiters (who is waiting, and how many). */
const WAITERS = new Map()
/** key -> last ms at which the "old holder" line was emitted. */
const WARNED_AT = new Map()
/** `held -> key` -> last ms at which the order-violation line was emitted (D4). */
const VIOLATION_WARNED_AT = new Map()

/**
 * The chain context: which keys THIS async chain already owns.
 *
 * It is per-process state, so the supervisor INJECTS its own store (one process
 * has one chain identity — see `options.context`). When the module is used on
 * its own (the unit tests) this default carries it.
 */
const DEFAULT_CONTEXT = new AsyncLocalStorage()

/** Where `useLockLogger` output goes. Silent by default: a library that logs is
 *  a library that surprises the process that embedded it. */
let notice = () => {}

/** Route this module's rare, rate-limited notices into the host's log. */
export function useLockLogger(fn) {
  notice = typeof fn === 'function' ? fn : () => {}
}

function say(line) {
  try {
    notice(String(line))
  } catch {
    // A logger that throws must never fail an operation.
  }
}

/** C7's strict switch: production LOGS, the tests and `ci-gates` THROW. */
export function lockOrderStrict() {
  const raw = String(process.env.DSH_CUA_VM_LOCK_ORDER_STRICT ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

function contextOf(options) {
  const candidate = options?.context
  return candidate instanceof AsyncLocalStorage ? candidate : DEFAULT_CONTEXT
}

function waitersOf(key) {
  let set = WAITERS.get(key)
  if (set === undefined) {
    set = new Set()
    WAITERS.set(key, set)
  }
  return set
}

/** The facts about the current holder, or null. `heldMs` is measured NOW. */
function heldFacts(key) {
  const held = HELD.get(key)
  if (held === undefined) return null
  const heldMs = Math.max(0, Date.now() - held.since)
  return { holder: held.holder, since: held.since, heldMs, poisoned: heldMs >= lockPoisonMs() }
}

/** Queue time only (I5): an explicit option wins; 0 means "for ever" (legacy). */
function resolveWait(waitMs) {
  if (waitMs === undefined || waitMs === null) return lockWaitMs()
  const value = Number(waitMs)
  if (!Number.isFinite(value) || value < 0) return lockWaitMs()
  if (value === 0) return Infinity
  return Math.round(value)
}

/** C7: is `key` legal while `held` is owned by this chain? */
function orderViolation(held, key) {
  if (!(held instanceof Set) || held.size === 0) return null
  if (held.has('@registry') !== true) return null
  // `@registry` itself is allowed: it is the leaf, re-entering or acquiring it
  // from a place that already holds it is the one legal shape.
  if (key === '@registry') return null
  return new LockOrderError('@registry', key)
}

function sayOldHolder(key, facts) {
  if (facts === null || facts.heldMs < lockHoldWarnMs()) return
  const at = Date.now()
  if (at - (WARNED_AT.get(key) ?? 0) < HOLD_WARN_INTERVAL_MS) return
  WARNED_AT.set(key, at)
  say(`lock ${key}: ${facts.holder || 'an unnamed operation'} has held it for ${Math.round(facts.heldMs / 1000)}s${facts.poisoned ? ` — poisoned since ${Math.round(lockPoisonMs() / 1000)}s; new waiters refuse instantly and the only cure is a supervisor restart` : ''}`)
}

/**
 * D4 — THE ORDER GUARD GETS THE SAME CADENCE, NOT A LINE PER ACQUISITION.
 *
 * C7's violation is a PROGRAMMING error, so it must never be silent; but the
 * old call site said it on EVERY offending acquisition, and one loop that holds
 * `@registry` and reaches for `vm:<name>` in its mutator would write a line per
 * iteration — a flood is how the single line that matters goes unread. Same
 * 60 s rule as `sayOldHolder` above, keyed by the offending PAIR: the first
 * offence of a pair is always logged, a repeat inside the window is dropped, and
 * a different pair still speaks at once.
 */
function sayOrderViolation(violation) {
  const at = Date.now()
  const pair = `${violation.lockHeldBy} -> ${violation.lockKey}`
  if (at - (VIOLATION_WARNED_AT.get(pair) ?? 0) < HOLD_WARN_INTERVAL_MS) return
  VIOLATION_WARNED_AT.set(pair, at)
  say(`${violation.code}: ${violation.message}`)
}

/**
 * ACQUIRE, RUN, RELEASE — the whole of C2/C3/I1–I5.
 *
 * `mode: 'wait'` (default) resolves with `fn`'s value and rejects on expiry;
 * `mode: 'try'` is handled by `attempt` below, which turns the expiry into a
 * RESULT instead of a throw (C6: a background loop must never die).
 */
function acquire(key, fn, options = {}) {
  const context = contextOf(options)
  const holder = String(options.holder ?? '').trim()
  const waitMs = resolveWait(options.waitMs)
  // I6: the SAME chain already owns this key — run immediately, touch nothing.
  // (`withVmLock`'s historical behaviour: shutdown may fall back to suspend,
  // `stop` delegates to `shutdown`, and both would otherwise wait for a lock
  // they already hold.)
  const held = context.getStore()
  if (options.reentrant !== false && held instanceof Set && held.has(key)) return runNow(key, fn, options)
  // C7: the order is enforced, not documented.
  const violation = orderViolation(held, key)
  if (violation !== null) {
    if (lockOrderStrict()) return Promise.reject(violation)
    sayOrderViolation(violation)
  }
  // C5: no forced break. Past the poison threshold a NEW waiter refuses at once
  // instead of queueing behind a holder that is never coming back.
  const current = heldFacts(key)
  if (current !== null && current.poisoned) {
    sayOldHolder(key, current)
    return Promise.reject(new LockTimeoutError(key, current, 0))
  }
  sayOldHolder(key, current)

  const previous = CHAIN.get(key) ?? Promise.resolve()
  let releaseSlot
  const slot = new Promise((resolve) => { releaseSlot = resolve })
  // The chain never rejects (I4), and this waiter's slot is part of it whether
  // it runs `fn` or expires, so the next waiter is never stranded (I3).
  CHAIN.set(key, previous.then(() => slot, () => slot))

  return new Promise((resolve, reject) => {
    let settled = false
    let entered = false
    let timer = null
    const waiter = { holder, at: Date.now() }
    const queue = waitersOf(key)
    queue.add(waiter)
    const leaveQueue = () => {
      queue.delete(waiter)
      if (queue.size === 0) WAITERS.delete(key)
    }
    const expire = () => {
      if (entered || settled) return
      settled = true
      leaveQueue()
      // C3: the deadline is QUEUE time. This waiter never runs `fn`, and its
      // slot is released at once so the chain cannot stall behind a refusal.
      releaseSlot()
      const facts = heldFacts(key)
      reject(new LockTimeoutError(key, facts, waitMs))
    }
    if (waitMs !== Infinity) {
      timer = setTimeout(expire, waitMs)
      timer.unref?.()
    }
    const enter = () => {
      if (settled) return
      entered = true
      if (timer !== null) clearTimeout(timer)
      leaveQueue()
      const since = Date.now()
      HELD.set(key, { holder, since })
      const next = new Set(held ?? [])
      next.add(key)
      // I3: the slot ALWAYS comes back — success, throw or expiry — and it comes
      // back BEFORE the caller is resolved, so a reader that awaits an operation
      // and then takes `lockSnapshot()` never sees a holder that already finished.
      const settle = (value, error) => {
        settled = true
        HELD.delete(key)
        releaseSlot()
        if (error === undefined) resolve(value)
        else reject(error)
      }
      Promise.resolve()
        .then(() => context.run(next, fn))
        .then((value) => settle(value, undefined), (error) => settle(undefined, error))
    }
    previous.then(enter, enter) // I4: a failed predecessor still runs `fn`
  })
}

/** Re-entrant entry (I6): the chain already owns the key, so there is no queue,
 *  no HELD write and no release — the OUTER frame owns all three. */
function runNow(key, fn, options = {}) {
  const context = contextOf(options)
  const next = new Set(context.getStore() ?? [])
  next.add(key)
  return Promise.resolve().then(() => context.run(next, fn))
}

/**
 * RUN `fn` UNDER `key` (C2–C7). Rejects with `LockTimeoutError` when the queue
 * time exceeds the deadline; never interrupts a holder.
 *
 * NOT RE-ENTRANT, deliberately, and this is HEAD's behaviour: the raw key form
 * is what a DETACHED task uses when it must queue behind the operation that
 * armed it — `scheduleDeferredWindowsCheckpoint` captures the disk only after
 * the shutdown op has released it, and a re-entrant acquire would run
 * `qemu-img` INSIDE that op, holding the key it was supposed to wait for. Only
 * `withVmLock` re-enters (I6), because a power op calls itself
 * (`shutdown → suspend`, `stop → shutdown`, `vmStart → windowsStart`).
 */
export function withLock(key, fn, options = {}) {
  return acquire(String(key), fn, { ...(options ?? {}), reentrant: false })
}

/**
 * THE PER-COMPUTER LIFECYCLE KEY: `vm:<name>` (C1).
 *
 * Re-entrant within one async chain (I6), which is what keeps
 * `shutdown → windowsShutdown`, `stop → shutdown` and `vmStart → windowsStart`
 * from waiting for a lock they already hold.
 */
export function withVmLock(name, fn, options = {}) {
  const { reentrant = true, ...rest } = options ?? {}
  return acquire(`vm:${String(name)}`, fn, { ...rest, reentrant })
}

/**
 * TRY MODE (C6) — `{ ran: true, value }` or `{ ran: false, holder, heldMs }`.
 *
 * A background loop that throws is a NEW R2 (a dead watcher), so every
 * non-user-facing site uses this form and SKIP-AND-SAY-SO instead of refusing.
 *
 * It NEVER re-enters: the caller is a detached task, and inheriting an outer
 * operation's hold would run a `qemu-img` convert inside the very operation that
 * is supposed to have released the disk (the deferred checkpoint exists exactly
 * to queue behind the op, not to run inside it).
 */
export async function tryLock(key, fn, options = {}) {
  return attempt(String(key), fn, options)
}

/** Try-mode for the lifecycle key. */
export async function tryVmLock(name, fn, options = {}) {
  return attempt(`vm:${String(name)}`, fn, { ...(options ?? {}), reentrant: false })
}

async function attempt(key, fn, options = {}) {
  const facts = heldFacts(key)
  if (facts !== null && facts.poisoned) {
    sayOldHolder(key, facts)
    return { ran: false, holder: facts.holder, heldMs: facts.heldMs, poisoned: true, key }
  }
  try {
    const value = await acquire(key, fn, { ...options, reentrant: false })
    return { ran: true, value, key }
  } catch (error) {
    // ONLY this lock's expiry is a skip. An error thrown by `fn` (or by a
    // NESTED lock with its own key) is the caller's problem and must travel.
    if (error instanceof LockTimeoutError && error.lockKey === key) {
      return { ran: false, holder: error.lockHeldBy, heldMs: error.lockHeldMs, poisoned: error.poisoned === true, waitedMs: error.waitedMs, key }
    }
    throw error
  }
}

/**
 * PRUNE THE WARNING CADENCE FOR A COMPUTER THAT NO LONGER EXISTS (J3).
 *
 * `WARNED_AT` and `VIOLATION_WARNED_AT` are 60 s rate limiters: they are keyed
 * by a lock key / an offending pair and NOTHING ever removed them, so a deleted
 * computer left one entry per name behind for the life of the supervisor. The
 * supervisor already prunes its own `VM_STATE_LAST` on removal
 * (`emitVmRemoved`) — this is the peer it forgot, with the same idiom.
 *
 * Pruned BY NAME, and only the cadence: `HELD`/`WAITERS`/`CHAIN` describe an
 * operation that is still running, and deleting those on a registry event would
 * be a lie (and would strand the chain). Returns how many entries went, so a
 * caller can log it without inspecting the maps.
 */
export function pruneLockWarnings(vmName) {
  const name = String(vmName ?? '').trim()
  if (name === '') return 0
  const key = `vm:${name}`
  let dropped = WARNED_AT.delete(key) ? 1 : 0
  for (const pair of [...VIOLATION_WARNED_AT.keys()]) {
    if (pair.split(' -> ').includes(key)) dropped += VIOLATION_WARNED_AT.delete(pair) ? 1 : 0
  }
  return dropped
}

/**
 * HOW A READER SEES THE LOCKS — `{ [key]: { holder, heldMs, waiters, poisoned } }`.
 *
 * This is what puts `lock` on a `vmList` row and `locks` on the doctor: the
 * panel can then say "another operation has been running for 12 min" instead of
 * spinning, and an operator can find the actual holder by name.
 */
export function lockSnapshot() {
  const now = Date.now()
  const out = {}
  for (const [key, held] of HELD) {
    const heldMs = Math.max(0, now - held.since)
    out[key] = {
      holder: held.holder,
      heldMs,
      waiters: WAITERS.get(key)?.size ?? 0,
      poisoned: heldMs >= lockPoisonMs()
    }
  }
  return out
}

/**
 * THE ONE SENTENCE (C4), rendered where the state is known.
 *
 * `another operation on <name> has been running for <N>s (<holder>); the panel
 * still shows <state>` — plus the C5 runbook when the key is poisoned, because
 * "restart the supervisor" is the only thing that clears an in-memory lock whose
 * holder will never return.
 */
export function lockTimeoutSentence(error, detail = {}) {
  const base = error instanceof Error ? error.message : String(error)
  const state = String(detail.state ?? '')
  const tail = state === '' ? '' : `; the panel still shows ${state}`
  const runbook = error?.poisoned === true ? '; restart the supervisor (the lock lives in process memory)' : ''
  return `${base}${tail}${runbook}`
}
