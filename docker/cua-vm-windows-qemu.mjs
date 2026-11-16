/**
 * cua-vm-windows-qemu — a Windows computer as a DIRECT QEMU process.
 *
 * WHY THIS EXISTS (and what it replaced)
 * --------------------------------------
 * Windows used to be a third-party Windows container image on a Docker Engine sidecar.
 * That architecture had three problems that could not be fixed from inside it:
 *
 *   1. it needed a second container runtime (privileged DinD) just to hold a
 *      QEMU that this image can run itself;
 *   2. its own monitor owned port 7100, so our QMP collided with it at boot;
 *   3. the store was split — the container's `/storage` bind had to be the same
 *      volume as `/cua-vm` or frames and credentials lived in two places.
 *
 * So Windows is now what Linux already is: `qemu-system-x86_64` started by the
 * supervisor, with the SAME /dev/kvm, the SAME `/cua-vm` store, the SAME
 * lifecycle locks and the SAME shutdown/checkpoint machinery. What changes is
 * only the firmware and the guest-facing devices:
 *
 *   firmware   OVMF (UEFI), with a per-computer vars store under
 *              `$STORE/windows/<name>/efi-vars.qcow2`, plus a swtpm TPM2 so
 *              Windows 11's installer is satisfied honestly instead of being
 *              talked past with registry bypasses.
 *   disks      qcow2 under `$STORE/windows/<name>/disk.qcow2` — a plain qcow2,
 *              which is why `qemu-img convert` checkpointing keeps working.
 *   install    the pinned Microsoft ISO, an MBR + FAT32 answer DISK built with
 *              mtools from `Autounattend.xml` + the OEM scripts (see
 *              docker/windows-oem/), and — when the operator provides it — the
 *              virtio-win drivers ISO.
 *   control    QMP on loopback (screendump / input-send-event / query-status /
 *              system_powerdown / quit) and a VNC display on loopback that the
 *              proxy relays, so "Show VM" is a live stream the user drives.
 *
 * WHAT THIS MODULE IS, AND IS NOT
 * -------------------------------
 * It is a COMMAND BUILDER plus lifecycle helpers over injected primitives
 * (`spawn`, `qmp`, `log`, `now`), so the argv can be asserted in a test without
 * a hypervisor, and so the supervisor keeps owning every lock, the registry and
 * the quotas. It never reads the registry and never writes it.
 */

import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, closeSync, copyFileSync, createWriteStream, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { pngSize } from './cua-vm-space.mjs'
import { KVM_DEVICE, deviceNodePresent, kvmPreflightError, kvmStatus, regularFilePresent } from './cua-vm-kvm.mjs'

/* ------------------------------------------------------------------ *
 * The pinned images
 * ------------------------------------------------------------------ */

/**
 * Windows versions and where their install media comes from.
 *
 * PROBED LIVE (ranged GET, 2 bytes, 2026-11-15): of the five URLs this module
 * used to pin, four answer **HTTP 400** and one answers **206** — Microsoft
 * moved the older evaluation media behind a session-token download page. A
 * pinned URL that 400s is worse than no pin at all: the first create of every
 * default version died inside the download with a generic error.
 *
 * So the contract is now explicit:
 *
 *   * `url` is non-null ONLY when it was probed and answered (today: Server
 *     2025).
 *   * `url: null` means "no public direct link": the version is still listed
 *     (the answer file and the floors are version-independent), but a create
 *     must be given `windowsIso` — a direct URL or a local ISO. The refusal
 *     names the version and the two remediations, before any bytes move.
 *
 * An operator-supplied ISO is therefore the PRIMARY path, and the pinned list is
 * a convenience where one exists — which is also the honest shape, because
 * Microsoft's own download pages are session-token protected.
 */
export const WINDOWS_ISO_SOURCES = {
  '2025': {
    label: 'Windows Server 2025 (evaluation)',
    url: 'https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/26100.1742.240906-0331.ge_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso',
    probed: '2026-11-15: HTTP 206 (ranged GET)'
  },
  '11ltsc': {
    label: 'Windows 11 IoT Enterprise LTSC 2024 (evaluation)',
    // PROBED 2026-11-15 with a ranged GET: HTTP 206, 5,060,020,224 bytes. This is
    // the URL the Evaluation Center's own x64 button resolves to
    // (go.microsoft.com/fwlink/?linkid=2270353 → this static prss.microsoft.com
    // object), so it is an official Microsoft host, not a mirror.
    url: 'https://software-static.download.prss.microsoft.com/dbazure/998969d5-f34g-4e03-ac9d-1f9786c66749/26100.1742.240906-0331.ge_release_svc_refresh_CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso',
    probed: '2026-11-15: HTTP 206 (ranged GET), 5,060,020,224 bytes'
  },
  '11': {
    label: 'Windows 11 (evaluation)',
    url: null,
    note: 'Microsoft publishes the 11 evaluation ISO through the Evaluation Center page, which is session-token protected',
    probed: '2026-11-15: the previously pinned URL answers HTTP 400'
  },
  '10': {
    label: 'Windows 10 (evaluation)',
    url: null,
    note: 'the same: a session-token download page, no stable direct link',
    probed: '2026-11-15: the previously pinned URL answers HTTP 400'
  },
  ltsc10: {
    label: 'Windows 10 LTSC (evaluation)',
    url: null,
    note: 'LTSC evaluation media is served from the Evaluation Center only',
    probed: '2026-11-15: the previously pinned URL answers HTTP 400'
  },
  '2022': {
    label: 'Windows Server 2022 (evaluation)',
    url: null,
    note: 'the 2022 evaluation link was retired; 2025 is the pinned Server image',
    probed: '2026-11-15: the previously pinned URL answers HTTP 400'
  }
}

/**
 * Resolve a version to a downloadable URL, or explain precisely why there is
 * none. Called BEFORE any download so the refusal is cheap and actionable.
 */
export function resolveWindowsIso(version) {
  const canonical = canonicalWindowsVersion(version)
  const entry = WINDOWS_ISO_SOURCES[canonical]
  if (entry === undefined) {
    throw new Error(`windowsVersion must be one of ${WINDOWS_VERSIONS.join(', ')} (or give windowsIso instead)`)
  }
  if (entry.url === null) {
    throw new Error(`windowsVersion "${version}" has no public direct ISO link (${entry.note}). `
      + 'Pass windowsIso instead: either a direct https URL, or a local .iso file inside the VM store or the workspace. '
      + `Versions with a pinned, probed link: ${WINDOWS_VERSIONS.filter((key) => WINDOWS_ISO_SOURCES[key].url !== null).join(', ') || 'none'}.`)
  }
  return { entry, url: entry.url }
}

export const WINDOWS_VERSIONS = ['11', '11ltsc', '10', 'ltsc10', '2022', '2025']

/**
 * Aliases people type. `ltsc11` is the obvious one for Windows 11 LTSC (the
 * Windows 10 one is `ltsc10`), so it is accepted everywhere a version is.
 */
export const WINDOWS_VERSION_ALIASES = { ltsc11: '11ltsc' }

/** The canonical version for a user-supplied string (alias-aware). */
export function canonicalWindowsVersion(version) {
  const text = String(version ?? '')
  return WINDOWS_VERSION_ALIASES[text] ?? text
}

/** Floors a Windows install does not survive below (same as the old backend). */
export const WINDOWS_MIN_MEMORY_GB = 6
export const WINDOWS_MIN_DISK_GB = 64
export const WINDOWS_MIN_CPU = 2
export const WINDOWS_DEFAULT_CPU = 2
export const WINDOWS_DEFAULT_MEMORY_GB = 6
export const WINDOWS_DEFAULT_DISK_GB = 64
export const WINDOWS_USERNAME = 'cua'

/** Which QEMU this module drives. The system build is the only one with OVMF.** */
export const WINDOWS_QEMU = process.env.DSH_CUA_WINDOWS_QEMU || '/usr/bin/qemu-system-x86_64'
/** OVMF code image (read-only) and the template for the per-VM vars store. */
export const OVMF_CODE = process.env.DSH_CUA_WINDOWS_OVMF_CODE || '/usr/share/OVMF/OVMF_CODE_4M.fd'
export const OVMF_VARS_TEMPLATE = process.env.DSH_CUA_WINDOWS_OVMF_VARS || '/usr/share/OVMF/OVMF_VARS_4M.fd'
/** swtpm (TPM2 emulator) — a software TPM, no hardware needed. */
export const SWTPM = process.env.DSH_CUA_WINDOWS_SWTPM || '/usr/bin/swtpm'
/** Optional virtio-win drivers ISO (see attachDrivers()). */
export const VIRTIO_WIN_ISO = process.env.DSH_CUA_WINDOWS_VIRTIO_ISO || ''

/** The kill switch: DSH_CUA_VM_WINDOWS=0 removes the option entirely. */
export function windowsEnabled() {
  return String(process.env.DSH_CUA_VM_WINDOWS ?? '1') !== '0'
}

/**
 * THE INSTALL PROGRESS SENTENCE — pure, so it can be asserted without a VM.
 *
 * WHAT WENT WRONG (user report): the panel showed
 *   `installing (10 min): undefined answering, QMP not running`
 * and the store really was mid-install. Two independent defects produced that
 * one line, and both are why this function exists rather than a template string
 * at the call site:
 *
 *   1. `verdict.endpoint` was `undefined`. The readiness probe dialled a port
 *      field that does not exist on a registry row (`spec.sshPort` vs
 *      `ports.ssh`), threw inside `probe()`, and `ready()` returned early —
 *      before it ever set `endpoint: 'none'`. Interpolating the raw field put
 *      the word "undefined" into a user-facing sentence.
 *   2. `QMP not running` was a LIE about a live QEMU: `status` was '' because
 *      the same bad port threw, and `'' || 'not running'` collapsed "the
 *      monitor did not answer" into "there is no monitor".
 *
 * So: no raw field ever reaches the text (`text()` + `endpointLabel()`), QMP has
 * three named states instead of two, and during Setup the sentence names what is
 * ACTUALLY being watched — the serial log and QMP — because SSH cannot answer
 * until the answer file has installed OpenSSH.
 *
 * @param {object} input
 * @param {'install'|'running'} [input.phase]        which readiness phase
 * @param {object} [input.verdict]                   windowsBackend.ready()'s answer
 * @param {number} [input.elapsedMinutes]            minutes since this attempt started
 * @param {string|string[]} [input.serialTail]       the last serial-log lines (already read)
 */
export function formatWindowsInstallDetail({ phase = 'install', verdict = {}, elapsedMinutes = 0, serialTail = '', sshPort = 0 } = {}) {
  const minutes = Number(elapsedMinutes) > 0 ? Math.round(Number(elapsedMinutes)) : 0
  const qmp = qmpStateLabel(verdict)
  const endpoint = endpointLabel(verdict)
  const tail = windowsTailLines(serialTail, 5)
  const port = Number(sshPort) > 0 ? Number(sshPort) : (Number(verdict?.sshPort) > 0 ? Number(verdict.sshPort) : 0)
  // F4: THE TWO HONEST HEADLINES. `ready()` early-returns WITHOUT an endpoint
  // when the QEMU process is not alive (or is not `running`), and the old
  // template then interpolated the missing field straight into the panel:
  // "installing (10 min): undefined answering, QMP not running" — a sentence
  // that was wrong twice (there was no endpoint, and the empty QMP status became
  // "not running" even for a live guest). Each state now gets its own words.
  const dead = verdict?.alive === false
  const waiting = !dead && qmp !== 'running'
  const watched = phase === 'install'
    // SSH IS NOT EXPECTED YET during Setup — saying "no SSH yet" (or worse,
    // interpolating a missing endpoint) reads like a failure, when the guest is
    // simply still inside Windows Setup.
    ? 'watching the serial-log tail + QMP (the SSH banner cannot answer until the answer file has installed OpenSSH)'
    : 'watching QMP + the SSH banner'
  const headline = dead
    ? `QEMU not alive (see qemu-stderr.log tail)`
    : `QMP ${qmp}${waiting ? '' : ', guest running'}`
  const signals = `ready when the SSH banner answers AND QMP says running (now: ${endpoint}, QMP ${qmp})`
  const where = !dead && endpoint === 'no endpoint yet' && port > 0
    ? ` waiting for SSH on 127.0.0.1:${port}`
    : ''
  const beyond = 'then the badge flips to Ready and /vm/port/<name>/ becomes the noVNC stream you can drive'
  const head = `installing (${minutes} min): ${headline}. ${watched}. ${signals};${where} ${beyond}.`
  // LAST LINE OF DEFENCE: no raw field can put the word in the sentence.
  const text = tail.length === 0
    ? `${head} Serial log: no lines yet (Windows Setup has not printed to the serial console).`
    : `${head} Serial log (last ${tail.length}): ${tail.join(' | ')}`
  return text.replace(/\bundefined\b/gu, 'unknown')
}

/** `running` / `paused` / `not answering` / `no qemu` — never an empty string. */
export function qmpStateLabel(verdict = {}) {
  const record = verdict && typeof verdict === 'object' ? verdict : {}
  if (record.alive === false) return 'no qemu'
  const explicit = typeof record.qmp === 'string' ? record.qmp.trim() : ''
  if (explicit !== '') return explicit
  const status = typeof record.status === 'string' ? record.status.trim() : ''
  return status === '' ? 'not answering' : status
}

/** `ssh` / `vnc` / `none` — the endpoint never reads as "undefined". */
export function endpointLabel(verdict = {}) {
  const record = verdict && typeof verdict === 'object' ? verdict : {}
  const value = typeof record.endpoint === 'string' ? record.endpoint.trim() : ''
  return value === '' || value === 'none' ? 'no endpoint yet' : value
}

/** The last `count` NON-EMPTY lines of a serial tail, as an array. */
export function windowsTailLines(serialTail, count = 5) {
  const limit = Math.max(1, Math.min(40, Number(count) || 5))
  const lines = Array.isArray(serialTail)
    ? serialTail
    : String(serialTail ?? '').split('\n')
  return lines.map((line) => String(line).trim()).filter((line) => line !== '').slice(-limit)
}

/**
 * The readiness contract, spelled once: the payload and the tool text both read
 * it from here, so "how do I know it finished" cannot drift between the panel
 * and the model.
 */
export function windowsReadinessSignals(name = '<name>') {
  return {
    signals: ['the guest SSH banner answers', 'QMP says running'],
    onReady: `the panel badge flips to Ready, and /vm/port/${name}/ becomes the noVNC stream you can drive`,
    watchedDuringInstall: ['serial-log tail', 'QMP query-status', 'SSH banner (not expected until the answer file has installed OpenSSH)']
  }
}

/* ------------------------------------------------------------------ *
 * QEMU's OWN DIAGNOSTICS: capture, classify, and degrade honestly
 * ------------------------------------------------------------------ */

/**
 * HOW LONG A START MUST SURVIVE BEFORE IT COUNTS.
 *
 * A QEMU that dies during init leaves exactly the fingerprint the user reported:
 * the spawn succeeded (a pid existed for a moment), `qemu.pid` was NEVER written
 * (QEMU writes it after its init), the serial log stayed 0 bytes (the guest never
 * spoke) and the supervisor watched a dead computer for the full 60-minute
 * install timeout. Fifteen seconds is the honest window: a QEMU that is going to
 * boot writes its pidfile in well under a second, so waiting the whole window is
 * only ever paid by a start that is already dead.
 *
 * Overridable so the smoke suite can exercise the SAME code without spending 15 s
 * per case (a test that stubs the timer would not be testing this code).
 *
 * UNSET IS NOT ZERO. The previous version did `Number(process.env.X ?? '')`,
 * which turns an UNSET variable into `Number('') === 0`; `0 >= 0` then passed and
 * the function returned 0 ms — the fallback was unreachable, so the default boot
 * window on every real host was 0 ms. `waitForQemuBoot` polled once against an
 * already-expired deadline and declared a QEMU that was ~1 ms old dead ("died
 * during init (none): no stderr output"). The raw string is inspected FIRST:
 * only a non-empty value is parsed, so unset and '' both reach the 15000 default.
 */
export function qemuBootWindowMs() {
  const raw = process.env.DSH_CUA_WINDOWS_BOOT_SETTLE_MS
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(120000, Math.max(0, Math.trunc(parsed)))
  }
  return 15000
}

/**
 * R1: THE "PRESS ANY KEY TO BOOT FROM CD OR DVD" WINDOW.
 *
 * VERIFIED LIVE: OVMF boots the install CD, `cdboot.efi 10.0.26100.1` prints
 * "Press any key to boot from CD or DVD", nobody presses a key, `cdboot` waits
 * ~5 s, prints `EFI_TIMEOUT`, and BDS falls through to the EFI Internal Shell —
 * a dead end with a firmware prompt no unattended install can leave.
 *
 * So the backend presses the key itself, over the same QMP input path the GUI
 * uses. The delay list below is the FALLBACK: three points inside that window
 * (1.5 s / 3.5 s / 5.5 s by default), overridable for tests and for a host
 * whose firmware is slower.
 *
 * F2: WHY A FIXED SCHEDULE WAS NOT ENOUGH (VERIFIED LIVE, inside the guest).
 * The forensic child proved the FIRST boot missed the ~3 s window entirely: the
 * presses at 1.5 / 3.5 / 5.5 s after spawn landed while OVMF was still
 * enumerating devices, so `cdboot.efi` printed its prompt to a keyboard nobody
 * had touched yet and timed out. Wall-clock delays are measured from SPAWN, but
 * the window opens when the FIRMWARE reaches the CD — a variable ~2-6 s.
 *
 * So the schedule is anchored on SERIAL ACTIVITY (`serial.log`): the watcher
 * polls the file's size (cheap stat) and its tail, and fires the presses when
 * the log carries the cdboot prompt signature ("Press any key to boot from CD"
 * or "BdsDxe: starting Boot0001"), or — for a firmware that prints neither —
 * once output has appeared and `armDelayMs` (~1.5 s) has passed since it did.
 * From that anchor the presses repeat every 0.8 s: a prompt anchor stops after
 * `attempts` = 3, a growth anchor retries until the ~8 s window closes (a guess
 * must not be the last press). The fixed-time list above is the fallback, and it
 * runs in two cases only: the detection window closes with no anchor at all
 * (console silent), replayed with its own relative gaps; or QEMU never created
 * the serial log, where the offsets run exactly as before.
 *
 * NOT a keystroke into an installed guest: scheduling is gated on
 * `installPending`, so a normal boot of a finished disk never sees a key.
 */
export function cdbootKeyScheduleMs() {
  const raw = process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS_MS
  if (raw !== undefined && raw !== '') {
    const parsed = String(raw)
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .map((value) => Math.min(120000, Math.trunc(value)))
    if (parsed.length > 0) return parsed
  }
  return [1500, 3500, 5500]
}

/**
 * F2: THE SIGNATURE OF THE CDBOOT PROMPT, AS THE FIRMWARE PRINTS IT.
 *
 * Two spellings are accepted because two firmwares are in play on this path:
 * the install CD's `cdboot.efi` prints "Press any key to boot from CD or DVD",
 * and OVMF's BDS announces the same boot attempt as "BdsDxe: starting
 * Boot0001" (the CD's boot entry while `installPending`). Matching either
 * anchors the key schedule on real serial activity instead of on a spawn-
 * relative timer that was measured against the wrong event.
 */
export const CDBOOT_PROMPT_PATTERN = /Press any key to boot from CD|BdsDxe:\s*starting Boot0001/iu

/** True when a serial tail carries the cdboot prompt (or BDS naming the CD). */
export function cdbootPromptSeen(text) {
  return CDBOOT_PROMPT_PATTERN.test(String(text ?? ''))
}

/**
 * F2: the last `bytes` bytes of a file, or '' when it is missing/empty/shorter.
 *
 * Deliberately small and allocation-light: the watcher calls it every poll on a
 * file the guest is appending to, so it stats first and reads only the tail
 * (the prompt is near the end of what cdboot writes, and the log can grow to
 * megabytes once Setup starts).
 */
export function readSerialTail(file, bytes = 8192) {
  const limit = Math.max(1, Math.min(262144, Number(bytes) || 8192))
  try {
    const { size } = statSync(file)
    if (!(size > 0)) return ''
    const start = Math.max(0, size - limit)
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(size - start)
      readSync(fd, buffer, 0, buffer.length, start)
      return buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/**
 * R1/F2 (the mechanism): press Enter for the cdboot prompt, sequential only.
 *
 * `sendKey` is the backend's own `sendKeys`, `wait` is a sleep that can be
 * stubbed, `now` is the clock, and `readSerial` is the serial tail — ALL are
 * injected so the suite can prove the schedule against a stubbed serial
 * timeline (prompt at 4 s → presses at ~4.1/4.9/5.7 s; a silent console → the
 * fixed-time fallback at exactly the configured offsets) without a hypervisor
 * or a real clock.
 *
 * Modes:
 *   * WITH a serial source (`readSerial` or `serialLog`): poll for the prompt
 *     (or for first output + `armDelayMs`), then press at the anchor and every
 *     `retryGapMs` up to `attempts` times. The detection window is bounded by
 *     `maxWindowMs` (~8 s). The fixed-time list is NOT raced in parallel —
 *     pressing at 1.5 s while a 4 s prompt is still coming is the bug itself.
 *     It is replayed, with its own relative gaps, only when (a) the window
 *     closes with no anchor at all, or (b) QEMU never created the serial log
 *     (`serialLog` given but the file is still missing at the first offset —
 *     the historical schedule, unchanged).
 *   * WITHOUT one: the original fixed-time loop, unchanged.
 *
 * A failed send is logged and SKIPPED — the firmware may simply not have the
 * keyboard up yet, and the next attempt covers it. This function never throws
 * and never rejects: it is background belt-and-braces, not a boot precondition.
 */
export async function runCdbootKeys({
  scheduleMs = cdbootKeyScheduleMs(),
  serialLog = null,
  readSerial = null,
  pollMs = 100,
  armDelayMs = 1500,
  retryGapMs = 800,
  attempts = 3,
  maxWindowMs = 8000,
  now = null,
  sendKey,
  wait,
  log = () => {},
  key = 'enter',
  name = '<name>'
} = {}) {
  const delays = (Array.isArray(scheduleMs) ? scheduleMs : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b)
  const sleep = typeof wait === 'function' ? wait : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const clock = typeof now === 'function' ? now : () => Date.now()
  const startedAt = clock()
  const elapsed = () => Math.max(0, Math.round(clock() - startedAt))
  const reader = typeof readSerial === 'function'
    ? readSerial
    : (typeof serialLog === 'string' && serialLog !== '' ? () => readSerialTail(serialLog) : null)
  const poll = Math.max(1, Math.min(2000, Number(pollMs) || 100))
  const gap = Math.max(0, Math.min(120000, Number(retryGapMs) || 0))
  const armAfter = Math.max(0, Math.min(120000, Number(armDelayMs) || 0))
  const window = Math.max(0, Math.min(120000, Number(maxWindowMs) || 0))
  const totalAttempts = Math.max(1, Math.min(20, Math.trunc(Number(attempts) || 1)))
  const sent = []
  const press = async (reason, at) => {
    try {
      await sendKey(key)
      sent.push(Math.round(at))
      log(`windows: ${name} pressed ${key} at ~${Math.round(at)} ms ${reason} to get past "Press any key to boot from CD or DVD"`)
    } catch (error) {
      log(`windows: ${name} could not press ${key} at ~${Math.round(at)} ms ${reason} (not fatal, the next attempt covers it): ${error?.message ?? error}`)
    }
  }

  // NO SERIAL SOURCE: the historical behaviour, byte for byte.
  if (reader === null) {
    let previous = 0
    for (const at of delays) {
      const delay = Math.max(0, at - previous)
      previous = Math.max(previous, at)
      try {
        await sleep(delay)
      } catch {
        return sent
      }
      await press('(fixed-time schedule)', at)
    }
    return sent
  }

  // SERIAL-ANCHORED. Wait for an ANCHOR (the prompt signature, or first output
  // + `armDelayMs`) inside a bounded window. The fixed-time list is NOT raced in
  // parallel: pressing at 1.5 s while a 4 s prompt is still coming is exactly the
  // bug this replaces. It is replayed only when the window closes without an
  // anchor — as the last resort it is — and, byte for byte, when there is no
  // serial console at all (a log file QEMU never created, e.g. a stub).
  const serialFile = typeof serialLog === 'string' && serialLog !== '' ? serialLog : null
  const serialFilePresent = () => {
    if (serialFile === null) return true
    try {
      statSync(serialFile)
      return true
    } catch {
      return false
    }
  }
  // REPLAY THE FIXED SCHEDULE WITH ITS OWN RELATIVE GAPS, starting now. The
  // nominal offsets are kept in the log line so the fallback is never mistaken
  // for an anchored press.
  const replayFixed = async (reason) => {
    let previousAt = null
    for (const at of delays) {
      const gapMs = previousAt === null ? 0 : Math.max(0, at - previousAt)
      previousAt = at
      if (gapMs > 0) {
        try {
          await sleep(gapMs)
        } catch {
          return sent
        }
      }
      await press(reason, at)
    }
    return sent
  }

  let firstGrowthAt = null
  let anchor = null
  let anchorReason = ''
  let noConsole = false
  for (;;) {
    const t = elapsed()
    let text = ''
    try {
      text = String(reader() ?? '')
    } catch {
      text = ''
    }
    if (text.length > 0 && firstGrowthAt === null) firstGrowthAt = t
    if (cdbootPromptSeen(text)) {
      anchor = t
      anchorReason = '(serial: cdboot prompt seen)'
      break
    }
    if (firstGrowthAt !== null && t - firstGrowthAt >= armAfter) {
      anchor = t
      anchorReason = `(serial: boot output seen at ~${firstGrowthAt} ms)`
      break
    }
    // NO CONSOLE AT ALL: QEMU was told `-serial file:` but never created the
    // file (a stub, or a QEMU that never got that far). Nothing can ever be
    // anchored, so the historical schedule takes over — its first offset is the
    // grace period a real QEMU needs to open the file.
    if (firstGrowthAt === null && !serialFilePresent() && t >= (delays[0] ?? 1500)) {
      noConsole = true
      break
    }
    if (t >= window) break
    const step = Math.max(1, Math.min(poll, window - t))
    try {
      await sleep(step)
    } catch {
      return sent
    }
  }

  if (noConsole) return replayFixed('(fixed-time schedule: no serial console)')
  if (anchor === null) return replayFixed('(fixed-time fallback: the prompt never appeared)')
  // A PROMPT ANCHOR IS CERTAIN, so three presses cover a dropped event. A
  // GROWTH anchor is only a guess ("the console woke up, the prompt should be
  // near"), so it keeps retrying every `retryGapMs` until the window closes —
  // the prompt may arrive later than the first output, and an early press must
  // never be the last one.
  const promptAnchored = anchorReason.startsWith('(serial: cdboot prompt')
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) {
      try {
        await sleep(gap)
      } catch {
        return sent
      }
    }
    await press(anchorReason, elapsed())
    const finished = promptAnchored ? attempt + 1 >= totalAttempts : elapsed() + gap > window
    if (finished) break
  }
  return sent
}

/** A hard switch for a host that wants the old behaviour (keys not sent). */
export function cdbootKeysEnabled() {
  const raw = process.env.DSH_CUA_WINDOWS_CDBOOT_KEYS
  if (raw === undefined || raw === '') return true
  return !/^(0|false|no|off)$/iu.test(String(raw).trim())
}

/** The last `lines` NON-EMPTY lines of a stderr capture, or '' when empty. */
export function qemuStderrExcerpt(stderr, lines = 20) {
  const limit = Math.max(1, Math.min(200, Number(lines) || 20))
  return String(stderr ?? '')
    .split('\n')
    .map((line) => line.replace(/[\r\t]+$/u, '').trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-limit)
    .join('\n')
}

/** The first non-empty line that looks like the CAUSE (QEMU prefixes errors). */
export function qemuStderrReason(stderr) {
  const lines = qemuStderrExcerpt(stderr, 40).split('\n').filter((line) => line.trim() !== '')
  const chosen = lines.find((line) => /error|failed|cannot|unable|no .*available|unsupported/iu.test(line)) ?? lines[0] ?? ''
  return chosen.replace(/^.*?qemu-system-x86_64:\s*/u, '').trim().slice(0, 300)
}

/**
 * WHICH KIND OF INIT FAILURE IS THIS? The answer decides whether boot() may
 * degrade (a display/GPU backend that the host cannot provide) or must refuse
 * loudly (the accelerator: the kvmStatus preflight owns that fix, and quietly
 * booting a Windows guest on TCG would be a 30-minute lie).
 *
 *   'kvm'     the accelerator could not be used — NEVER degrade
 *   'display' the EGL/render-node/virgl path could not initialize — degrade once
 *   'init'    anything else QEMU said — the caller may still retry a GPU attempt
 *   'none'    QEMU said nothing at all (killed, OOM, an exec problem)
 */
export function classifyQemuInitFailure(stderr) {
  const text = String(stderr ?? '')
  if (text.trim() === '') return 'none'
  // KVM FIRST: an EGL message and a KVM message can appear together, and the
  // accelerator is the one that must not be papered over.
  if (/(\/dev\/kvm|kvm_init|kvm[_ ]?init|cannot access memory|KVM_CREATE|accel=kvm|accel 'kvm'|kvm: |hardware acceleration is not supported|Failed to initialize KVM)/iu.test(text)) return 'kvm'
  if (/(egl|render node|rendernode|virgl|virtio-gpu|drm|opengl|glx|display|gtk|sdl)/iu.test(text)) return 'display'
  return 'init'
}

/**
 * DID THIS QEMU ACTUALLY COME UP?
 *
 * "spawn() returned a pid" is not "QEMU is running": a QEMU that rejects its own
 * argv exits a few milliseconds later, and the supervisor then watched a dead
 * computer for the whole install timeout (the user report: "installing (N min):
 * undefined answering, QMP not running" for 60 minutes on a store whose
 * serial.log was 0 bytes and whose qemu.pid was never written).
 *
 * Two facts are required, in this order, within `windowMs`:
 *
 *   1. the PIDFILE exists — QEMU writes it AFTER its init, so its absence after
 *      the window is the cleanest "never started" signal there is;
 *   2. the pid in it is ALIVE (not a zombie from this very child).
 *
 * It resolves EARLY when the child exits, so a dead start is reported in
 * milliseconds rather than after the full window. It never throws: the answer is
 * a value, and `boot()` decides what to do with it.
 */
export async function waitForQemuBoot({ child, pidFile, isAlive, windowMs = 15000, pollMs = 50 } = {}) {
  const step = Math.max(10, Number(pollMs) || 50)
  // THE FLOOR IS ONE FULL POLL INTERVAL. A window of 0 was never "do not wait":
  // when it was the *effective* value (the unset→0 defect above, or a caller that
  // asked for 0), the loop below ran ONE check against a deadline that had
  // already passed and reported a one-millisecond-old QEMU dead. A start that is
  // given any window at least gets to observe one real interval, so `pollMs`
  // (≥10 ms) is the floor — and `Date.now() >= deadline` only fires after that
  // observation, never before it. An explicitly-set 0 is still honored as "the
  // shortest window there is", not silently upgraded to 15 s.
  const window = Math.max(step, Math.max(0, Number(windowMs) || 0))
  const deadline = Date.now() + window
  let exited = false
  let pidFileInvalid = false
  let exitCode = null
  let exitSignal = null
  const noteExit = (code, signal) => { exited = true; exitCode = code ?? null; exitSignal = signal ?? null }
  try { child?.once?.('exit', noteExit) } catch {}
  for (;;) {
    const pid = (() => {
      try {
        const value = Number(readFileSync(pidFile, 'utf8').trim())
        if (Number.isFinite(value) && value > 0) return value
        // A file that exists but names nothing is noted (and reported at the
        // deadline, never immediately: QEMU may be mid-write).
        pidFileInvalid = true
        return 0
      } catch {
        return 0
      }
    })()
    if (pid > 0) {
      const alive = typeof isAlive === 'function' ? isAlive(pid) : pid > 0
      if (alive) return { ok: true, pid, pidFile: true, exited }
      // The pidfile names a pid nobody owns: an init that wrote it and died.
      return { ok: false, pid, pidFile: true, exited: true, exitCode, exitSignal, reason: 'pidfile' }
    }
    if (exited) {
      // The child is reaped and the pidfile never appeared — the init failure the
      // user reported, now with a cause instead of a 60-minute wait.
      return { ok: false, pid: 0, pidFile: false, exited: true, exitCode, exitSignal, reason: 'exited' }
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        pid: 0,
        pidFile: pidFileInvalid,
        exited: false,
        exitCode,
        exitSignal,
        reason: pidFileInvalid ? 'pidfile-invalid' : 'timeout'
      }
    }
    await new Promise((resolve) => setTimeout(resolve, step))
  }
}

/**
 * THE ERROR A DEAD INIT DESERVES: the captured stderr, the classification, and
 * the next step — never a bare "QEMU exited".
 *
 * The text is what reaches the row's `error`/`errorLog`, the supervisor log and
 * the panel, so it carries the file it read (`qemu-stderr.log`, named because
 * that is where a human looks next) and the QEMU lines verbatim.
 */
export function qemuInitError({ name = '<name>', kind = 'none', reason = '', excerpt = '', stderrPath = '', retriedWithoutGpu = false } = {}) {
  const what = kind === 'kvm'
    ? 'QEMU could not use the KVM accelerator'
    : kind === 'display'
      ? 'QEMU could not initialize the display/GPU backend'
      : 'QEMU exited during init before writing its pidfile'
  const head = retriedWithoutGpu
    ? `${what} (the GPU-less retry failed too)`
    : what
  const lines = [`windows: ${name}: ${head}${reason === '' ? '' : ` — ${reason}`}`]
  if (excerpt !== '') lines.push('', `QEMU stderr (last lines of ${path.basename(stderrPath || 'qemu-stderr.log')}):`, excerpt)
  else lines.push('', `QEMU wrote nothing to ${path.basename(stderrPath || 'qemu-stderr.log')} — it was killed or could not exec (check the supervisor log and \`dmesg\` for an OOM kill).`)
  if (kind === 'kvm') {
    // NEVER DEGRADED. The preflight said the device is usable; if QEMU still
    // cannot use it, the fix is the device/gid one, and this module must not
    // quietly boot Windows on TCG.
    lines.push('', 'This is a KVM/accelerator failure, not a display failure: the create is NOT retried without the GPU, because a Windows guest on emulated TCG is not the computer that was asked for.', 'Run `cua_vm_doctor` and check /dev/kvm (device present, gid usable by this uid).')
  } else if (kind === 'display') {
    lines.push('', 'The GPU display backend could not initialize on this host; a create retries once with `-display none` and an emulated VGA framebuffer. If this text appeared after that retry, the host cannot give this guest any display.')
  }
  lines.push('', `Full QEMU output: ${stderrPath || '<store>/windows/<name>/qemu-stderr.log'}`)
  return Object.assign(new Error(lines.join('\n')), { code: 'QEMU_INIT_FAILED', kind, stderrExcerpt: excerpt, stderrPath })
}

/**
 * The capacity advice for a Windows computer.
 *
 * The three numbers below are RECOMMENDATIONS (the defaults), not gates: a
 * smaller computer is created when it is asked for, and this function produces
 * the warnings that travel with the result and the panel. It is pure so the
 * decision can be tested without a hypervisor.
 */
export function windowsCapacityWarnings({ diskGb, memory, cpu }) {
  const warnings = []
  if (Number(diskGb) < WINDOWS_MIN_DISK_GB) {
    warnings.push({
      code: 'disk-below-floor',
      message: `disk ${diskGb} GB is below the recommended ${WINDOWS_MIN_DISK_GB} GB floor; a Windows install needs roughly 52 GB after updates, so Windows Update will run out of space and the install may fail. Created anyway on request (the quota still counts the real bytes).`
    })
  }
  if (Number(memory) < WINDOWS_MIN_MEMORY_GB) {
    warnings.push({
      code: 'memory-below-floor',
      message: `RAM ${memory} GB is below the recommended ${WINDOWS_MIN_MEMORY_GB} GB floor; Setup and the first logon will be very slow and may fail. Created anyway on request.`
    })
  }
  if (Number(cpu) < WINDOWS_MIN_CPU) {
    warnings.push({
      code: 'cpu-below-floor',
      message: `${cpu} vCPU is below the recommended ${WINDOWS_MIN_CPU}; Windows Setup will be slow. Created anyway on request.`
    })
  }
  return warnings
}

/**
 * Is this host able to boot a Windows computer at all?
 *
 * `kvm` used to be `statSync('/dev/kvm').isFile()`, which is FALSE for a device
 * node: a container with the device mounted, mode 0666, answered "kvm: false"
 * and the create said "needs /dev/kvm (compose.emulator.yaml)". Two facts are
 * now reported separately, because they have two different fixes:
 *
 *   kvm         the device node is present (a CHARACTER device, not a file)
 *   kvmUsable   access(R_OK|W_OK) SUCCEEDS for this uid — a present-but-denied
 *               node is `kvm: true, kvmUsable: false`, and its error names the
 *               gid/group_add fix instead of telling the user to mount it again
 *
 * `kvmStatus` is exported too, so the doctor and the create path quote the same
 * observation (mode, usr:grp, this process's groups) instead of re-deriving it.
 */
export function windowsHostCaps() {
  // SELF-TEST HOOK. The create path (quota → ports → ISO → OEM payload → boot) is
  // the part worth testing, and it cannot run on a host without qemu/OVMF/swtpm.
  // This makes the capability check report "present" so the smoke suite can drive
  // the real code. It is never set in compose/.env, and a gate forbids that.
  if (String(process.env.DSH_CUA_WINDOWS_FAKE_HOST_CAPS ?? '') === '1') {
    return { qemu: true, ovmfCode: true, ovmfVars: true, swtpm: true, virtioWin: false, kvm: true, kvmUsable: true, render: true, faked: true }
  }
  const kvm = kvmStatus()
  return {
    qemu: regularFilePresent(WINDOWS_QEMU),
    ovmfCode: regularFilePresent(OVMF_CODE),
    ovmfVars: regularFilePresent(OVMF_VARS_TEMPLATE),
    swtpm: regularFilePresent(SWTPM),
    virtioWin: VIRTIO_WIN_ISO !== '' && regularFilePresent(VIRTIO_WIN_ISO),
    // A device node is presence; whether THIS uid may open it is `kvmUsable`.
    kvm: deviceNodePresent(KVM_DEVICE) || kvm.exists,
    kvmUsable: kvm.state === 'ok',
    kvmMode: kvm.info === null ? null : kvm.info.modeText,
    kvmOwner: kvm.info === null ? null : `${kvm.info.uid}:${kvm.info.gid}`,
    kvmGroups: kvm.identity.groups,
    kvmReason: kvm.reason,
    render: deviceNodePresent('/dev/dri/renderD128')
  }
}

/**
 * The Windows backend's KVM preflight, as one exported value.
 *
 * Both the supervisor (before a single byte of ISO is downloaded) and `boot()`
 * (before swtpm is spawned) ask THIS, so the two refusals cannot drift apart —
 * and neither can fall back to the old "needs /dev/kvm (compose.emulator.yaml)"
 * sentence, which was wrong for a mounted-but-denied device.
 */
export function windowsKvmPreflight() {
  // The documented self-test hook reports the capabilities present; the device
  // refusal must honour it too, or the smoke suite would pass on this host and
  // fail on a CI runner that has no /dev/kvm.
  if (String(process.env.DSH_CUA_WINDOWS_FAKE_HOST_CAPS ?? '') === '1') return null
  return kvmPreflightError(kvmStatus(), { purpose: 'the Windows backend' })
}

/* ------------------------------------------------------------------ *
 * Paths — everything Windows lives under $STORE
 * ------------------------------------------------------------------ */

/**
 * ONE DIRECTORY PER COMPUTER, and nothing outside `$STORE`.
 *
 *   $STORE/windows/<name>/disk.qcow2        the system disk (plain qcow2)
 *   $STORE/windows/<name>/efi-vars.qcow2    OVMF NVRAM (boot order, keys)
 *   $STORE/windows/<name>/tpm/              swtpm state (persisted TPM2)
 *   $STORE/windows/<name>/oem/              Autounattend.xml + Setup scripts
 *   $STORE/windows/<name>/credentials.json  the generated password + SSH key
 *   $STORE/windows/<name>/serial.log        the console (also the install tail)
 *   $STORE/iso/                             downloaded install media
 */
export function windowsPaths(store, name) {
  const dir = path.join(store, 'windows', name)
  return {
    dir,
    disk: path.join(dir, 'disk.qcow2'),
    efiVars: path.join(dir, 'efi-vars.qcow2'),
    tpmDir: path.join(dir, 'tpm'),
    tpmSocket: path.join(dir, 'swtpm.sock'),
    tpmPid: path.join(dir, 'swtpm.pid'),
    oemDir: path.join(dir, 'oem'),
    // THE ANSWER-FILE MEDIUM. A partitioned FAT32 image, not the host
    // directory: WinPE mounts a real disk and lists its root, while a
    // directory-backed vvfat node was not reliably visible. Setup then reads
    // Autounattend.xml only from REMOVABLE-media roots, so the image is
    // delivered through usb-storage with removable=on — see buildQemuArgs()
    // and buildSetupImage().
    setupImg: path.join(dir, 'setup.img'),
    credentials: path.join(dir, 'credentials.json'),
    sshKey: path.join(dir, 'id_ed25519'),
    sshKeyPub: path.join(dir, 'id_ed25519.pub'),
    serialLog: path.join(dir, 'serial.log'),
    // QEMU'S OWN STDERR, NOT THE GUEST CONSOLE. `-serial file:` above records
    // what the GUEST prints; a QEMU that dies during init (a bad display
    // backend, an unusable accelerator, a missing firmware file) writes its
    // diagnosis to STDERR and nowhere else. With `stdio: 'ignore'` that text was
    // discarded, which is why a user-reported dead create left one line
    // ("qemu started (pid 906, installing)") and no reason anywhere.
    qemuStderr: path.join(dir, 'qemu-stderr.log'),
    // The GPU-less retry writes its own file, so the reason the first attempt
    // died (the EGL/render-node line the panel quotes) is never overwritten.
    qemuStderrRetry: path.join(dir, 'qemu-stderr-retry.log'),
    qemuPid: path.join(dir, 'qemu.pid'),
    qmp: path.join(dir, 'qmp.json'),
    isoDir: path.join(store, 'iso')
  }
}

/* ------------------------------------------------------------------ *
 * Ports — ONE shape, whichever object the caller hands in
 * ------------------------------------------------------------------ */

/**
 * THE ROW AND THE BOOT SPEC DO NOT SHARE A PORT SHAPE, and that mismatch was a
 * user-visible bug.
 *
 * `boot()` is called with FLAT fields (`qmpPort`, `vncPort`, `sshPort`) because
 * it builds QEMU's argv. Every lifecycle helper (`probe`, `ready`, `qmpFor`,
 * `screenshot`, `click`, …) is called with the REGISTRY ROW, which stores the
 * same three numbers under `ports: { qmp, ssh, vnc }` and has no flat field at
 * all. So `qmpFor(spec)` dialled `undefined`:
 *
 *   * `net.connect(undefined)` throws `TypeError: The "options" or "port" or
 *     "path" argument must be specified`;
 *   * `probe()` swallowed that into `error` and reported `status: ''`;
 *   * `ready()` returned `{ ready: false, endpoint: undefined }` (it never
 *     reached the `endpoint: 'none'` line because the throw happened first);
 *   * the watcher interpolated that straight into the panel:
 *     `installing (10 min): undefined answering, QMP not running`.
 *
 * The whole sentence was true about nothing. One resolver, used by every helper,
 * makes the shape invisible to the caller — and it is also what keeps the row
 * authoritative after a port reconcile moved the triple.
 */
export function windowsPortsOf(spec) {
  const record = spec && typeof spec === 'object' ? spec : {}
  const ports = record.ports && typeof record.ports === 'object' ? record.ports : {}
  const first = (...values) => {
    for (const value of values) {
      const port = Number(value)
      if (Number.isFinite(port) && port > 0) return port
    }
    return 0
  }
  return {
    qmpPort: first(record.qmpPort, ports.qmp),
    vncPort: first(record.vncPort, ports.vnc),
    sshPort: first(record.sshPort, ports.ssh)
  }
}

/** This computer's ports, in the flat shape QEMU's argv wants. */
export function windowsBootSpec(spec) {
  return { ...spec, ...windowsPortsOf(spec) }
}

/**
 * R2: A REGISTRY ROW HAS NO `name` FIELD — ITS NAME IS THE MAP KEY.
 *
 * The supervisor stored rows as `{ vms: { "win-box": { kind, ports, … } } }`, and
 * every lifecycle helper read `spec.name`. For a row that is `undefined`, so
 * `pathsFor(undefined)` resolved `/cua-vm/windows/undefined/qemu.pid`, nothing
 * was ever alive at that path, and the install watcher printed
 *
 *     QEMU not alive (see qemu-stderr.log tail)
 *
 * forever while QMP answered `running` — the reported "fake dead" computer.
 *
 * The fix is at both ends: rows are WRITTEN with `name` (and the read migration
 * injects it for rows that predate this), and every helper resolves through this
 * one function so a caller that only has the map key still works.
 */
export function windowsRowName(spec, fallback = '') {
  if (typeof spec === 'string' && spec !== '') return spec
  const direct = spec && typeof spec === 'object' ? spec.name : ''
  if (typeof direct === 'string' && direct !== '') return direct
  return typeof fallback === 'string' ? fallback : ''
}

/* ------------------------------------------------------------------ *
 * The command line
 * ------------------------------------------------------------------ */

/**
 * The QEMU argv for one Windows computer.
 *
 * DESIGN NOTES THAT MATTER WHEN SOMETHING DOES NOT BOOT:
 *
 *   * `q35` + `-cpu host` + KVM: the same acceleration the Linux guest uses;
 *     without /dev/kvm this refuses at start rather than crawling.
 *   * The two pflash drives are the firmware. OVMF_CODE is read-only and
 *     SHARED; `efi-vars.qcow2` is PER COMPUTER, so boot entries and the TPM's
 *     measured state survive a restart (a fresh vars file re-runs Setup).
 *   * `swtpm` is a separate process listening on a unix socket; QEMU's chardev
 *     connects to it. Both are cleaned up by `stopSwtpm`.
 *   * The install medium is the untouched Microsoft ISO on a CD-ROM. The
 *     answer file and its scripts live on a SEPARATE DISK (`setup.img`, built
 *     with mtools), attached WRITABLE: MBR + one FAT32 partition at LBA 2048,
 *     with `Autounattend.xml` at the volume root. It is delivered as a
 *     **removable usb-storage stick** since the live forensic round: WinPE
 *     mounts it, lists the answer file, and STILL ignored it as a fixed disk,
 *     because Setup only scans removable-media roots (and the boot media) for
 *     an answer file. The old `fat:ro:` vvfat directory behind usb-storage was
 *     not seen by Setup at all, and neither is a PARTITIONLESS FAT32 image: the
 *     firmware mounts one, Windows never does (it enumerates fixed disks through
 *     their partition table), and the symptom is Setup silently showing its
 *     interactive language screen. That is why the MBR is part of the build and
 *     why it is asserted — see buildSetupImage(). **NOT a dockur/windows
 *     mirror**: their overlay is also FAT32 but partitionless, and it works in
 *     their flow, not in this one. The disk is writable because QEMU 10 refuses
 *     a read-only block node behind `ide-hd` (it is legal on usb-storage, which
 *     is verified both ways now) and because Setup may write logs/scratch to
 *     the medium.
 *   * `bootindex` ORDERS THE BOOT, and the order follows the INTENT of each
 *     phase instead of the order the devices happen to be declared in:
 *
 *       installPending: true   CD bootindex=1, disk bootindex=2 — Setup must
 *                              run from the install media on a disk that has
 *                              nothing bootable on it yet. The old argv had
 *                              this BACKWARDS (disk 1, CD 2) while its comment
 *                              claimed the ISO booted first: OVMF created
 *                              Boot0002 for the unbootable HDD, tried it, said
 *                              "HDD Not Found", and only then fell through to
 *                              the DVD. Pinning the CD first removes a full
 *                              failed-start cycle from every install.
 *       installPending: false  disk bootindex=1, no CD attached — after Setup
 *                              the disk owns the boot order.
 *   * Networking is SLIRP: outbound internet, the host reachable at 10.0.2.2,
 *     and SSH forwarded from 127.0.0.1:<port> to guest :22. No bridge, no tap,
 *     no CAP_NET_ADMIN — the harness keeps `cap_drop ALL`.
 *   * Video: `-vga std` by default (a plain framebuffer every Windows has an
 *     inbox driver for). With `gpu: true` the display becomes virtio-gpu backed
 *     by the host's render node — the SAME virgl wiring as the Linux guest —
 *     with the honest caveat documented in the README: Windows has no
 *     accelerated 3D driver here, so Direct3D falls back to WARP (CPU).
 */
export function buildQemuArgs(spec) {
  const p = spec.paths
  const boot = spec.installPending === true
  // R4: ONE ORDER, DECIDED BY THE PHASE. While installing the CD is FIRST and
  // the (still empty) disk second; afterwards the disk is FIRST and no CD is
  // attached. The old argv always put the disk at 1 and the CD at 2 and left a
  // comment claiming the opposite.
  const diskBootIndex = boot ? 2 : 1
  const args = [
    '-name', `dsh-win-${spec.name}`,
    '-machine', 'q35,accel=kvm,smm=off',
    '-cpu', 'host',
    '-smp', String(spec.cpu),
    '-m', String(spec.memory * 1024),
    // firmware: shared code + per-computer NVRAM
    '-drive', `if=pflash,format=raw,readonly=on,file=${OVMF_CODE}`,
    '-drive', `if=pflash,format=qcow2,file=${p.efiVars}`,
    // TPM2: char socket to swtpm + the TPM device Windows 11 requires
    '-chardev', `socket,id=chrtpm,path=${p.tpmSocket}`,
    '-tpmdev', 'emulator,id=tpm0,chardev=chrtpm',
    '-device', 'tpm-crb,tpmdev=tpm0',
    // system disk — SECOND while installing (see diskBootIndex above)
    '-drive', `file=${p.disk},if=none,id=disk0,format=qcow2,cache=writeback,discard=unmap`,
    '-device', spec.virtio ? `virtio-blk-pci,drive=disk0,bootindex=${diskBootIndex}` : `ide-hd,drive=disk0,bus=ide.0,bootindex=${diskBootIndex}`,
    // install medium (only while installing) + drivers + OEM payload.
    // R4: THE CD IS bootindex=1 DURING INSTALL. Booting a blank disk first made
    // OVMF create a Boot0002 HDD entry, try it, print "HDD Not Found" and only
    // then reach the DVD — one wasted boot cycle per install, and the reason the
    // CD's "Press any key to boot from CD or DVD" window was ever entered late.
    // S1/F1: THE ANSWER-FILE MEDIUM, AFTER THE SYSTEM DISK. `ide.0` is the
    // qcow2 and therefore Windows DISK 0 — which is what Autounattend.xml's
    // <DiskID>0</DiskID> targets. On QEMU's q35 (ICH9 AHCI) the slots are:
    //
    //   ide.0  system qcow2      -> Windows Disk 0  (EFI/MSR/Primary)
    //   ide.1  install CD-ROM    -> not a disk, but the boot device during install
    //   ide.3  virtio-win CD-ROM -> not a disk (when a driver ISO is supplied)
    //
    // F1: AND IT IS NO LONGER AN ide-hd. VERIFIED INSIDE THE GUEST, with the
    // answer image mounted and byte-correct: WinPE mounted setup.img as C:,
    // `dir C:\` listed Autounattend.xml, `more C:\Autounattend.xml` was byte-
    // verified, there were NO Panther parse errors — and Setup STILL showed its
    // interactive language page. The cause is the DELIVERY CLASS, not the file:
    // WinPE/Setup searches for Autounattend.xml on REMOVABLE-media roots (and on
    // the boot media), NOT on fixed-disk roots. An `ide-hd` is a fixed disk: the
    // firmware mounted it, Windows mounted it, and Setup never scanned it. The
    // same image on usb-storage with `removable=on` reports removable media and
    // IS scanned. (Windows' documented search order: removable drives, the boot
    // media, %WINDIR%\Panther\Unattend / $WINNT$.~BT, and the
    // UnattendFile/HKLM\SYSTEM\Setup registry override — a fixed disk root is
    // nowhere in it.)
    //
    // The drive node stays declared here, right after the system disk, so the
    // block graph keeps the same order and the image is attached BEFORE any
    // device names it. The usb-storage device itself is declared AFTER the xHCI
    // controller (below), because QEMU parses argv in order and a device that
    // names `bus=xhci.0` before `-device qemu-xhci` dies with "Bus 'xhci.0' not
    // found".
    //
    // THE NODE IS WRITABLE, AND THAT IS STILL NOT NEGOTIABLE: QEMU 10 refuses a
    // read-only block node behind an IDE hard disk ("Block node is read-only",
    // which used to cascade into "swtpm did not create its socket"), and Setup
    // may write logs/scratch to the medium. It is now legal on BOTH shapes —
    // verified on this container's QEMU 10.0.13: usb-storage accepts a writable
    // node AND a read-only one, and `query-block` reports `removable: true` for
    // `removable=on` (and `false` for `removable=off` or the property omitted,
    // which is why the property is explicit). The image is rebuilt fresh on
    // every create anyway (see buildSetupImage), so guest writes never leak into
    // the next install.
    ...(boot
      ? ['-drive', `file=${p.setupImg},format=raw,if=none,id=setup0`]
      : []),
    ...(boot
      ? ['-drive', `file=${spec.isoPath},media=cdrom,readonly=on,if=none,id=cd0`,
        '-device', 'ide-cd,drive=cd0,bus=ide.1,bootindex=1']
      : []),
    ...(spec.driverIso !== null
      ? ['-drive', `file=${spec.driverIso},media=cdrom,readonly=on,if=none,id=cd1`,
        '-device', 'ide-cd,drive=cd1,bus=ide.3']
      : []),
    // THE USB CONTROLLER COMES FIRST. QEMU parses argv in order, so a device
    // that names `bus=xhci.0` before `-device qemu-xhci,id=xhci` dies with
    // "Bus 'xhci.0' not found" (verified on QEMU 10). Order is asserted by a
    // gate needle, because it is invisible in a diff.
    '-device', 'qemu-xhci,id=xhci',
    // F1: THE ANSWER MEDIUM IS A REMOVABLE USB STICK, NOT A FIXED IDE DISK.
    // `removable=on` is the SEMANTIC that makes Windows classify the device as
    // removable media, and removable media roots are what WinPE scans for
    // Autounattend.xml — a fixed-disk root is never scanned, which is the whole
    // reported bug. QEMU's usb-storage `removable` property is explicit here
    // because QEMU 10 defaults it to OFF when omitted (verified with query-block
    // on this container's 10.0.13: omitted → removable=false, `removable=on` →
    // removable=true), and a default is not a contract.
    //
    // This is NOT a return of the old `fat:ro:` vvfat OEM stick: that was a
    // directory-backed vvfat node (read-only, no partition table, unreliable
    // even as removable media). setup.img stays a REAL MBR + FAT32 partitioned
    // image, built by mtools, attached writable — only its delivery class
    // changed.
    ...(boot
      ? ['-device', 'usb-storage,drive=setup0,removable=on,bus=xhci.0']
      : []),
    // networking: SLIRP + the SSH forward
    '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${spec.sshPort}-:22`,
    '-device', spec.virtio ? 'virtio-net-pci,netdev=net0' : 'e1000e,netdev=net0',
    // input: absolute pointer (QMP input-send-event) + keyboard
    '-device', 'usb-kbd',
    '-device', 'usb-tablet',
    // display: the panel's live view and the agent's frames
    '-display', spec.gpu && spec.virgl ? 'egl-headless,rendernode=/dev/dri/renderD128' : 'none',
    // QEMU READS THIS AS A DISPLAY NUMBER, NOT A PORT: `-vnc host:31` binds
    // 5900+31. Passing the raw port (5931) binds 11831 — the relay, the banner
    // probe and websockify all point at 5931, so the live view never connects
    // and the non-SSH readiness probe never answers. The conversion lives in one
    // function so it cannot drift again.
    '-vnc', `127.0.0.1:${vncDisplayFor(spec.vncPort)}`,
    // GPU: virgl only when the distro QEMU advertises virtio-gpu-gl-pci AND a
    // render node exists — otherwise a plain virtio-gpu framebuffer. Windows has
    // no accelerated driver either way (Direct3D is WARP); the difference is that
    // virgl routes the guest's GL through the host render node, which is what the
    // Linux guest does.
    '-device', spec.gpu ? (spec.virgl ? 'virtio-gpu-gl-pci' : 'virtio-gpu-pci') : 'VGA,vgamem_mb=32',
    // control + observability
    '-qmp', `tcp:127.0.0.1:${spec.qmpPort},server=on,wait=off`,
    '-monitor', 'none',
    '-serial', `file:${p.serialLog}`,
    '-pidfile', p.qemuPid,
    '-no-user-config'
  ]
  return args
}

/**
 * VNC takes a DISPLAY NUMBER, not a port: QEMU computes `5900 + n`.
 * These helpers are the only place that arithmetic happens.
 */
export function vncDisplayFor(port) {
  return Math.max(0, Number(port) - 5900)
}

export function vncPortFor(display) {
  return 5900 + Number(display)
}

/* ------------------------------------------------------------------ *
 * ISO handling
 * ------------------------------------------------------------------ */

/** Where an ISO URL will land. Exported so the caller can tell "cached" from
 *  "about to download 5.5 GB" BEFORE calling ensureIso (and reserve for it). */
export function isoTargetPath(isoDir, url) {
  return path.join(isoDir, isoFileName(url))
}

/** A short, stable file name for a URL (the hash keeps two dates apart). */
function isoFileName(url) {
  const base = decodeURIComponent(String(url).split('/').pop() || 'windows.iso').replace(/[^\w.-]+/gu, '-')
  const digest = randomBytes(4).toString('hex')
  return base.toLowerCase().endsWith('.iso') ? base : `${base}-${digest}.iso`
}

/**
 * Make sure an ISO is on disk, downloading it once.
 *
 * WHY A TIMEOUT AND A PROGRESS HOOK: a 5.5 GB download over a slow link is
 * minutes, and a create that reports nothing for minutes looks hung. The
 * supervisor turns `onProgress` into a log line and keeps the row's
 * `installDetail` moving; `timeoutMs` bounds the whole transfer.
 */
export async function ensureIso({ url, isoDir, timeoutMs = 60 * 60 * 1000, onProgress = () => {}, log = () => {} }) {
  if (!/^https?:\/\//iu.test(String(url || ''))) return { path: url, downloaded: false }
  mkdirSync(isoDir, { recursive: true })
  const target = path.join(isoDir, isoFileName(url))
  if (existsSync(target) && statSync(target).size > 1024 * 1024) return { path: target, downloaded: false }
  const partial = `${target}.part`
  // A killed download leaves a `.part` behind; the next attempt must not append
  // to it (which is how a truncated ISO ends up "complete").
  try { unlinkSync(partial) } catch {}

  const started = Date.now()
  let received = 0
  let expected = 0
  let lastReport = 0

  const fetchTo = (from) => new Promise((resolve, reject) => {
    const client = String(from).startsWith('https:') ? https : http
    let settled = false
    let stream = null
    const fail = (error) => {
      if (settled) return
      settled = true
      try { stream?.destroy() } catch {}
      try { request.destroy() } catch {}
      try { unlinkSync(partial) } catch {}
      reject(error)
    }
    const request = client.get(from, { timeout: 60000 }, (response) => {
      // Redirects are normal for Microsoft's CDN.
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        settled = true
        resolve({ redirect: new URL(response.headers.location, from).toString() })
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        fail(new Error(`ISO download failed: HTTP ${response.statusCode} for ${from}`))
        return
      }
      expected = Number(response.headers['content-length'] || 0)
      stream = createWriteStream(partial)
      response.on('data', (chunk) => {
        received += chunk.length
        if (Date.now() - started > timeoutMs) {
          fail(new Error(`ISO download timed out after ${Math.round(timeoutMs / 1000)} s (${(received / 1024 ** 3).toFixed(2)} GB received)`))
          return
        }
        if (Date.now() - lastReport > 5000) {
          lastReport = Date.now()
          onProgress(expected > 0 ? received / expected : null, received)
        }
      })
      response.on('aborted', () => fail(new Error('the ISO connection was aborted')))
      response.on('error', fail)
      stream.on('error', fail)
      response.pipe(stream)
      stream.on('finish', () => {
        if (settled) return
        // SHORT READ = A BROKEN ISO. Content-Length is authoritative; without
        // this check a connection that drops at 80% leaves a 4 GB file that
        // `existsSync && size > 1 MB` would happily reuse forever.
        if (expected > 0 && received !== expected) {
          fail(new Error(`ISO download was truncated: ${received} of ${expected} bytes`))
          return
        }
        stream.close(() => {
          if (settled) return
          settled = true
          try {
            // SAME DIRECTORY → a real atomic rename. `copyFileSync` here meant
            // another 5.5 GB write and a window where a kill left a half-copied
            // file wearing the final name.
            renameSync(partial, target)
            log(`iso: ${path.basename(target)} (${(statSync(target).size / 1024 ** 3).toFixed(2)} GB)`)
            resolve({ path: target })
          } catch (error) {
            fail(error)
          }
        })
      })
    })
    request.on('timeout', () => fail(new Error('ISO download socket timed out')))
    request.on('error', fail)
  })

  let current = url
  for (let hop = 0; hop < 5; hop += 1) {
    const result = await fetchTo(current)
    if (result.redirect !== undefined) {
      current = result.redirect
      received = 0
      expected = 0
      continue
    }
    return { path: result.path, downloaded: true, bytes: statSync(result.path).size }
  }
  throw new Error(`ISO download followed too many redirects (>5) starting at ${url}`)
}

/* ------------------------------------------------------------------ *
 * The OEM payload
 * ------------------------------------------------------------------ */

/**
 * The three files the unattended install cannot run without. Exported because
 * both the error text and the image gate talk about the same list: a fourth
 * file added here without its COPY is exactly the drift this constant prevents.
 */
export const OEM_PAYLOAD_FILES = Object.freeze(['Autounattend.xml', 'setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs'])

/**
 * S1: THE ANSWER-FILE MEDIUM'S ROOT ENTRIES.
 *
 * This is the list copied into `setup.img`'s ROOT — the same layout dockur uses:
 *
 *   Autounattend.xml                     what WinPE reads
 *   startup.nsh                          the EFI Shell fallback (see R5)
 *   $OEM$/$$/Setup/Scripts/*.cmd|ps1|vbs  copied by Setup into C:\Windows\Setup\Scripts
 *
 * `setupcomplete.cmd` and `cua-firstboot.ps1` are ALSO at the root: Setup finds
 * the `$OEM$` copies, and the root copies are what a human can inspect from the
 * medium. `Unattend.vbs` is the hidden launcher (see docker/windows-oem/).
 */
export const SETUP_IMAGE_ENTRIES = Object.freeze([
  'Autounattend.xml',
  'setupcomplete.cmd',
  'cua-firstboot.ps1',
  'Unattend.vbs',
  'startup.nsh'
])

/** The FAT32 volume label Setup presents as the answer medium. */
export const SETUP_IMAGE_LABEL = 'SETUP'

/**
 * FAT32's minimum useful size (the format needs >= 65525 clusters of 512 B),
 * rounded up to 64 MiB: sparse on the host, trivial for the guest, and large
 * enough that mtools never has to guess about cluster geometry.
 */
export const SETUP_IMAGE_BYTES = 64 * 1024 * 1024

/** The mtools commands, named once so a gate and the error text agree. */
export const MTOOLS = Object.freeze({ format: 'mformat', copy: 'mcopy', dir: 'mdir', type: 'mtype' })

/* ------------------------------------------------------------------ *
 * F1: THE ANSWER DISK IS A REAL DISK WITH A REAL PARTITION TABLE
 * ------------------------------------------------------------------ */

/**
 * WHY THERE IS AN MBR HERE AT ALL — the live-verified root cause of the
 * interactive language screen.
 *
 * This module used to hand `mformat`/`mcopy` a bare 64 MiB file: a FAT32
 * "superfloppy", VBR at LBA 0, no MBR and no GPT. mtools' own VBR template puts
 * bytes at 0x1BE that look like a partition entry but are not one.
 *
 * That medium is legal, and the FIRMWARE likes it: EDK2 mounts a raw FAT volume
 * from any block device and even wrote its NvVars to it (the blockstats showed
 * 114 KB of firmware writes on `setup0` and nothing else). WINDOWS IS NOT THE
 * FIRMWARE: WinPE enumerates *fixed disks* through their partition table, so a
 * partitionless fixed disk is never given a drive letter, never mounted, and
 * Setup's drive-root search for `Autounattend.xml` had nothing to scan. The
 * result was the interactive language screen on every install, with the answer
 * file provably present in the image.
 *
 * So the build now writes an MBR with one active type-0x0C (FAT32 LBA) partition
 * starting at LBA 2048 — the conventional 1 MiB alignment — and points EVERY
 * mtools call at the volume through mtools' `@@<byte-offset>` syntax:
 *
 *     mformat -i /path/setup.img@@1048576 …
 *     mcopy  -i /path/setup.img@@1048576 …
 *
 * `@@` takes a BYTE offset (verified against mtools 4.0.48: `@@2048` lands the
 * volume at byte 2048 and mtools rejects the unaligned geometry as "non DOS
 * media", while `@@4194304` = LBA 2048 formats cleanly and `mdir` reads it back).
 *
 * mtools cannot write an MBR, and no partitioner is installed in the image, so
 * the 512-byte stub is generated here in Node and written with `writeSync`.
 * That is deliberately one fewer runtime dependency rather than one more: no
 * `sfdisk`/`parted` addition to the Dockerfile, nothing to keep in sync with
 * util-linux, and the bytes are assertable in a test.
 */
export const SETUP_SECTOR_BYTES = 512

/** First partition sector: 1 MiB of alignment, the universal convention. */
export const SETUP_PARTITION_START_LBA = 2048

/** Where the FAT32 volume actually begins inside setup.img (1 048 576). */
export const SETUP_PARTITION_OFFSET_BYTES = SETUP_PARTITION_START_LBA * SETUP_SECTOR_BYTES

/** MBR partition type 0x0C = FAT32 LBA (0x0B is FAT32 CHS; 0x0C is LBA-mapped). */
export const SETUP_PARTITION_TYPE = 0x0c

/** The boot signature every firmware and Windows' disk driver look for. */
export const SETUP_MBR_SIGNATURE = Object.freeze({ offset: 510, bytes: Object.freeze([0x55, 0xaa]) })

/**
 * The `-i` argument for every mtools call on setup.img: the image PLUS the byte
 * offset of its partition. One function so the build and the read-back can
 * never disagree about where the volume starts.
 */
export function setupVolumeSpec(imagePath) {
  return `${imagePath}@@${SETUP_PARTITION_OFFSET_BYTES}`
}

/**
 * The 512-byte MBR sector: one active FAT32-LBA partition and the 0x55AA
 * signature. Pure, so a test can assert the geometry without a disk.
 *
 * CHS fields are written as 0xFE/0xFF/0xFF — the "too big, use LBA" encoding
 * mtools itself emits — because a 63 MiB partition does not fit the legacy
 * 10/8/6-bit tuple in any meaningful way and every consumer that matters reads
 * the LBA fields.
 */
export function setupMbrSector({ startLba = SETUP_PARTITION_START_LBA, sectorCount = 0, active = true } = {}) {
  if (!Number.isInteger(startLba) || startLba <= 0) throw new Error(`setupMbrSector: startLba must be a positive integer (got ${startLba})`)
  if (!Number.isInteger(sectorCount) || sectorCount <= 0) throw new Error(`setupMbrSector: sectorCount must be a positive integer (got ${sectorCount})`)
  const sector = Buffer.alloc(SETUP_SECTOR_BYTES)
  const entry = 0x1be
  sector[entry] = active ? 0x80 : 0x00
  sector[entry + 1] = 0xfe
  sector[entry + 2] = 0xff
  sector[entry + 3] = 0xff
  sector[entry + 4] = SETUP_PARTITION_TYPE
  sector[entry + 5] = 0xfe
  sector[entry + 6] = 0xff
  sector[entry + 7] = 0xff
  sector.writeUInt32LE(startLba, entry + 8)
  sector.writeUInt32LE(sectorCount, entry + 12)
  sector[SETUP_MBR_SIGNATURE.offset] = SETUP_MBR_SIGNATURE.bytes[0]
  sector[SETUP_MBR_SIGNATURE.offset + 1] = SETUP_MBR_SIGNATURE.bytes[1]
  return sector
}

/** How many sectors the FAT32 volume mformat just laid down, or 0. */
export function setupVolumeSectors(imagePath) {
  const fd = openSync(imagePath, 'r')
  try {
    const bpb = Buffer.alloc(64)
    if (readSync(fd, bpb, 0, 64, SETUP_PARTITION_OFFSET_BYTES) < 64) return 0
    // A BPB only counts if its sector size is the one mtools formats with.
    if (bpb.readUInt16LE(11) !== SETUP_SECTOR_BYTES) return 0
    const total32 = bpb.readUInt32LE(32)
    return total32 > 0 ? total32 : bpb.readUInt16LE(19)
  } finally { closeSync(fd) }
}

/**
 * Write the MBR over an image whose FAT32 volume is already formatted at
 * SETUP_PARTITION_OFFSET_BYTES, and return the partition geometry.
 *
 * ORDER MATTERS: this runs AFTER mformat and BEFORE mcopy. mformat only touches
 * the volume at the offset (verified: LBA 0 survives a `@@`-offset format), but
 * writing the table last means the partition size can be the FAT's real length
 * instead of a guess.
 */
export function writeSetupMbr(imagePath) {
  const totalSectors = Math.floor(statSync(imagePath).size / SETUP_SECTOR_BYTES)
  const available = totalSectors - SETUP_PARTITION_START_LBA
  if (available <= 0) {
    throw new Error(`setup.img is too small to hold a partition at LBA ${SETUP_PARTITION_START_LBA} (${totalSectors} sectors)`)
  }
  const fatSectors = setupVolumeSectors(imagePath)
  // The partition covers the formatted volume (so Windows' idea of the volume
  // length matches the BPB), never more than the disk.
  const sectorCount = fatSectors > 0 ? Math.min(fatSectors, available) : available
  const fd = openSync(imagePath, 'r+')
  try {
    writeSync(fd, setupMbrSector({ startLba: SETUP_PARTITION_START_LBA, sectorCount }), 0, SETUP_SECTOR_BYTES, 0)
  } finally { closeSync(fd) }
  return { startLba: SETUP_PARTITION_START_LBA, offsetBytes: SETUP_PARTITION_OFFSET_BYTES, sectorCount, type: SETUP_PARTITION_TYPE }
}

/** Read the MBR back: the structural assertion that the medium is a DISK. */
export function readSetupMbr(imagePath) {
  const fd = openSync(imagePath, 'r')
  let mbr
  try {
    mbr = Buffer.alloc(SETUP_SECTOR_BYTES)
    if (readSync(fd, mbr, 0, SETUP_SECTOR_BYTES, 0) < SETUP_SECTOR_BYTES) {
      throw new Error(`setup.img has no MBR (shorter than one sector): ${imagePath}`)
    }
  } finally { closeSync(fd) }
  const entry = 0x1be
  return {
    signature: mbr.toString('hex', SETUP_MBR_SIGNATURE.offset, SETUP_MBR_SIGNATURE.offset + 2),
    active: mbr[entry] === 0x80,
    type: mbr[entry + 4],
    startLba: mbr.readUInt32LE(entry + 8),
    sectorCount: mbr.readUInt32LE(entry + 12)
  }
}

/**
 * F2: THE EDITION — SETUP MUST NEVER BE ASKED *WHICH* IMAGE TO INSTALL.
 *
 * `<InstallFrom>` was missing from the answer file. Everything else could be
 * right and Setup still stopped: with no image named, WinPE shows its "Select
 * the operating system you want to install" list, and on a multi-edition
 * evaluation medium (Server 2025 carries four images) that is a page no
 * unattended install can skip.
 *
 * `/IMAGE/NAME` is preferred where the name is KNOWN AND VERIFIED, because it is
 * stable across media revisions that add or reorder indexes. Verified by reading
 * the WIM XML resource straight out of the pinned 11ltsc evaluation ISO
 * (`26100.1742…CLIENT_IOT_LTSC_EVAL_x64FRE_en-us.iso`, read on 2026-11-16):
 *
 *   <IMAGE INDEX="1"> … <NAME>Windows 11 IoT Enterprise LTSC 2024 Evaluation</NAME>
 *                    … <DISPLAYNAME>Windows 11 IoT Enterprise LTSC Evaluation</DISPLAYNAME>
 *
 * Note the media's NAME is the LONG form with the year and the word
 * "Evaluation" — the short label on Microsoft's download page does NOT match it,
 * and a NAME that does not match fails Setup with "the image is not found".
 *
 * `/IMAGE/INDEX` is used where the exact name cannot be verified offline (the
 * media is not on this host) or where the caller supplies an operator ISO. An
 * index is coarser but cannot misspell a name, and index 1 exists on every
 * Windows ISO Microsoft ships.
 */

/** The selection shape every caller sees: which key, which value, and why. */
export const WINDOWS_IMAGE_SELECTIONS = Object.freeze({
  // VERIFIED against the pinned ISO's own WIM metadata (see above).
  '11ltsc': Object.freeze({
    key: '/IMAGE/NAME',
    value: 'Windows 11 IoT Enterprise LTSC 2024 Evaluation',
    verified: true,
    note: 'read from the pinned 11ltsc EVAL ISO WIM XML (single image, INDEX 1)'
  }),
  // Server eval media carry Standard / Standard-DE / Datacenter / Datacenter-DE
  // in that order, Desktop Experience second. The ISO is not on this host, so the
  // index is reasoned, not read: an index cannot be misspelled, and a Windows
  // *computer* needs the Desktop Experience image to have a desktop at all
  // (image 1 is Server Core). Override with windowsImageIndex if a future
  // revision reorders them.
  '2025': Object.freeze({
    key: '/IMAGE/INDEX',
    value: 2,
    verified: false,
    note: 'Server 2025 EVAL: image 2 is Standard Evaluation (Desktop Experience); image 1 is Server Core'
  }),
  // No pinned media: these versions REQUIRE windowsIso, so the medium is the
  // operator's and the honest default is the first image.
  '11': Object.freeze({ key: '/IMAGE/INDEX', value: 1, verified: false, note: 'operator ISO: first image' }),
  '10': Object.freeze({ key: '/IMAGE/INDEX', value: 1, verified: false, note: 'operator ISO: first image' }),
  ltsc10: Object.freeze({ key: '/IMAGE/INDEX', value: 1, verified: false, note: 'operator ISO: first image' }),
  '2022': Object.freeze({ key: '/IMAGE/INDEX', value: 1, verified: false, note: 'operator ISO: first image' })
})

/**
 * Decide the `<InstallFrom>` selection for one create.
 *
 * Precedence: explicit `imageName` → explicit `imageIndex` → the version table →
 * `/IMAGE/INDEX 1`. Explicit values win because an operator with an unusual ISO
 * is the one caller who knows better than the table.
 */
export function resolveWindowsImageSelection({ version = '', imageIndex = 0, imageName = '' } = {}) {
  const name = String(imageName ?? '').trim()
  const indexText = String(imageIndex ?? '').trim()
  const index = Number(indexText === '' ? 0 : indexText)
  if (indexText !== '' && index !== 0) {
    if (!Number.isInteger(index) || index < 1 || index > 999) {
      throw new Error(`windowsImageIndex "${imageIndex}" is not a Windows image index: expected a whole number 1-999 (see /sources/install.wim in the ISO)`)
    }
  }
  if (name !== '') {
    if (/[<>]/u.test(name)) throw new Error(`windowsImageName "${name}" contains XML delimiters; give the plain edition name, e.g. "Windows 11 IoT Enterprise LTSC 2024 Evaluation"`)
    return { key: '/IMAGE/NAME', value: name, verified: true, source: 'caller' }
  }
  if (index !== 0) return { key: '/IMAGE/INDEX', value: index, verified: true, source: 'caller' }
  const canonical = canonicalWindowsVersion(version)
  const known = WINDOWS_IMAGE_SELECTIONS[canonical]
  if (known !== undefined) return { ...known, source: 'version' }
  return { key: '/IMAGE/INDEX', value: 1, verified: false, source: 'default' }
}

/** The `<InstallFrom>` element for a selection, escaped and schema-ordered. */
export function imageInstallFromXml(selection) {
  const escape = (text) => String(text)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
  return '<InstallFrom><MetaData wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">'
    + `<Key>${escape(selection.key)}</Key><Value>${escape(selection.value)}</Value>`
    + '</MetaData></InstallFrom>'
}

/**
 * S3: PRODUCT KEYS ARE OPTIONAL, AND VALIDATED BEFORE THEY REACH XML.
 *
 * The pinned media are EVALUATION images (11ltsc, 2025): they need no key, and
 * an evaluation image ignores a <ProductKey> it is handed. A future operator
 * ISO (a volume/licensed Windows) can pass `windowsKey`, which is written into
 * the staged Autounattend.xml with `<WillShowUI>Never</WillShowUI>` so Setup
 * never stops to ask. Accepts the canonical 25-character form with or without
 * dashes; anything else is refused with the accepted shape in the message.
 */
export function normaliseProductKey(value) {
  const text = String(value ?? '').trim().toUpperCase().replace(/\s+/gu, '')
  if (text === '') return ''
  const compact = text.replace(/-/gu, '')
  if (!/^[A-Z0-9]{25}$/u.test(compact)) {
    throw new Error(`windowsKey "${value}" is not a Windows product key: expected 25 letters/digits, with or without dashes (XXXXX-XXXXX-XXXXX-XXXXX-XXXXX). Leave it empty for the pinned EVALUATION media, which need no key.`)
  }
  return compact.match(/.{5}/gu).join('-')
}

/** Every `<DiskID>` an answer file names, in document order. */
export function answerFileDiskIds(xml) {
  return [...String(xml).matchAll(/<DiskID>\s*(\d+)\s*<\/DiskID>/gu)].map((match) => Number(match[1]))
}

/**
 * S2: THE ANSWER FILE MUST TARGET THE SYSTEM DISK, AND THE SYSTEM DISK MUST BE
 * THE QCOW2.
 *
 * The QEMU argv puts the qcow2 on `ide.0` (first, a fixed disk) and setup.img on
 * a REMOVABLE usb-storage stick (a second disk), so Windows sees the qcow2 as
 * Disk 0. If a future argv change reorders those, Setup would install onto the
 * answer medium and fail in a way that looks like a corrupt ISO. This is the
 * check that makes the ordering a contract instead of a comment.
 */
export function assertAnswerFileTargetsSystemDisk(xml, { expected = 0 } = {}) {
  const ids = answerFileDiskIds(xml)
  if (ids.length === 0) throw new Error('Autounattend.xml has no <DiskID> — Setup would ask which disk to use')
  const wrong = ids.filter((id) => id !== expected)
  if (wrong.length > 0) {
    throw new Error(`Autounattend.xml targets DiskID ${wrong.join(', ')} but the system qcow2 is Disk ${expected} (QEMU: disk0 on ide.0, setup.img on a removable usb-storage stick). Fix the disk order in buildQemuArgs() or the XML together — never one alone.`)
  }
  if (!/<InstallTo>\s*<DiskID>\s*0\s*<\/DiskID>/u.test(String(xml))) {
    throw new Error('Autounattend.xml has no <InstallTo><DiskID>0</DiskID> — Setup would not know where to install Windows')
  }
  return ids
}

/**
 * F2: THE STAGED ANSWER FILE MUST NAME THE IMAGE IT WANTS.
 *
 * Setup's "Select the operating system you want to install" page is the second
 * interactive stop after the language page, and it appears whenever
 * `<ImageInstall><OSImage>` carries no `<InstallFrom>`. This asserts the exact
 * shape Setup requires — one `<MetaData>` with `/IMAGE/NAME` or `/IMAGE/INDEX`
 * INSIDE `<InstallFrom>`, and `<InstallFrom>` BEFORE `<InstallTo>` (schema
 * order; the reverse is rejected as an unparseable answer file on some media).
 */
export function assertAnswerFileSelectsImage(xml) {
  const text = String(xml)
  const installFrom = /<InstallFrom>([\s\S]*?)<\/InstallFrom>/u.exec(text)
  if (installFrom === null) {
    throw new Error('Autounattend.xml has no <ImageInstall><OSImage><InstallFrom> — Setup would stop at "Select the operating system you want to install"')
  }
  // Comments are prose: the template explains the shape in an XML comment that
  // names <MetaData>, so counting raw occurrences would fail on our own advice.
  const body = installFrom[1].replace(/<!--[\s\S]*?-->/gu, '')
  const key = /<Key>\s*(\/IMAGE\/(?:NAME|INDEX))\s*<\/Key>/u.exec(body)
  const value = /<Value>\s*([^<]+?)\s*<\/Value>/u.exec(body)
  if (key === null || value === null) {
    throw new Error(`Autounattend.xml's <InstallFrom> has no <Key>/IMAGE/NAME|/IMAGE/INDEX + <Value> (found ${body.trim().slice(0, 120) || 'nothing'})`)
  }
  const metadata = (body.match(/<MetaData\b/gu) ?? []).length
  if (metadata !== 1) {
    throw new Error(`Autounattend.xml's <InstallFrom> must carry exactly ONE <MetaData> (found ${metadata}); Setup honours the first and ignores the rest, so a second one is a silent lie`)
  }
  if (key[1] === '/IMAGE/INDEX' && !/^\d+$/u.test(value[1])) {
    throw new Error(`Autounattend.xml selects ${key[1]} but its <Value> "${value[1]}" is not a number`)
  }
  if (key[1] === '/IMAGE/NAME' && /^(Microsoft )?Windows$/iu.test(value[1])) {
    throw new Error(`Autounattend.xml selects ${key[1]} "${value[1]}", which is not an edition name`)
  }
  const installTo = text.indexOf('<InstallTo>')
  if (installTo !== -1 && installTo < text.indexOf('<InstallFrom>')) {
    throw new Error('Autounattend.xml puts <InstallTo> before <InstallFrom>; the answer-file schema requires InstallFrom first')
  }
  return { key: key[1], value: value[1] }
}

/**
 * S1: BUILD `$STORE/windows/<name>/setup.img` — a FAT32 hard-disk image whose
 * ROOT holds the answer file and whose `$OEM$` tree holds the Setup scripts.
 *
 * WHY A DISK IMAGE AND NOT A vvfat DIRECTORY: a directory-backed vvfat stick
 * behind usb-storage was not visible to Setup in practice, while a real MBR +
 * FAT32 image IS mounted by WinPE. The image is then delivered as REMOVABLE
 * media (usb-storage, removable=on), because Setup only scans removable-media
 * roots — and the boot media — for `Autounattend.xml`; see the argv comments.
 *
 * WHERE THIS DELIBERATELY DIFFERS FROM dockur/windows (CORRECTED VERDICT — the
 * old comment claimed the two were identical and that claim was the bug): their
 * overlay is a plain FAT32 image formatted as a *superfloppy* (no partition
 * table), and it works THERE because of how their run flow hands the medium to
 * QEMU. Here the identical superfloppy was attached as a fixed disk and the
 * result was the interactive language screen: the firmware mounted the raw FAT volume
 * (EDK2 wrote its NvVars into it — 114 KB, the only writes that block device
 * ever saw), but Windows does not mount a partitionless FIXED disk at all, so
 * WinPE's drive-root search had no drive to look at. `setup.img` must therefore
 * carry an MBR with one FAT32 partition; see the F1 block above. Both media are
 * FAT32 — only one of them is a disk Windows will ever enumerate.
 *
 * The build is deterministic and verified in the same call:
 *   1. truncate a 64 MiB raw image (sparse);
 *   2. `mformat -F -H 2048 -v SETUP` on the volume at byte offset 1 MiB;
 *   3. write the MBR partition table (type 0x0C, start LBA 2048) over sector 0;
 *   4. `mcopy -s` the root files and `$OEM$` tree INTO that partition;
 *   5. `mdir` must list Autounattend.xml at the volume root, `mtype` must return
 *      bytes IDENTICAL to the staged file, and the MBR must read back as a
 *      signature + partition entry (so "a disk Windows can enumerate" is
 *      asserted, not assumed).
 *
 * F1: REBUILD POLICY — ALWAYS FRESH, ON EVERY CREATE. The image is attached
 * WRITABLE (QEMU 10 rejects `readonly=on` behind an IDE hard disk; usb-storage
 * accepts either, and Setup may write logs/scratch to the medium),
 * so the guest can legitimately leave bytes behind. There is deliberately no
 * "skip if it already exists" branch: a re-create of the same computer must
 * start from a byte-exact answer medium, never from a possibly-modified one.
 * The old file is unlinked and rebuilt, and the FAT32 image is chmod 0600 for
 * the runtime uid so QEMU can open it read-write.
 *
 * mtools is a runtime dependency in the image (see the Dockerfile); a host
 * without it gets an error naming the package, not a QEMU that cannot boot.
 */
export function buildSetupImage({ paths: p, log = () => {}, expectedDiskId = 0 } = {}) {
  if (!p || typeof p.setupImg !== 'string' || typeof p.oemDir !== 'string') {
    throw new Error('buildSetupImage needs paths.setupImg and paths.oemDir')
  }
  const staged = SETUP_IMAGE_ENTRIES.map((name) => path.join(p.oemDir, name))
  const missing = SETUP_IMAGE_ENTRIES.filter((name, index) => !existsSync(staged[index]))
  if (missing.length > 0) {
    throw new Error(`the staged OEM payload is incomplete (missing ${missing.join(', ')} in ${p.oemDir}); writeOemPayload() must run first`)
  }
  // S2: the answer file's disk target, checked BEFORE the image is built.
  assertAnswerFileTargetsSystemDisk(readFileSync(path.join(p.oemDir, 'Autounattend.xml'), 'utf8'), { expected: expectedDiskId })
  const oemTree = path.join(p.oemDir, '$OEM$')
  if (!existsSync(path.join(oemTree, '$$', 'Setup', 'Scripts', 'setupcomplete.cmd'))) {
    throw new Error(`the staged $OEM$/$$/Setup/Scripts tree is missing under ${p.oemDir}; Setup would never run SetupComplete.cmd`)
  }
  try {
    execFileSync(MTOOLS.format, ['--version'], { stdio: 'ignore', timeout: 10000 })
  } catch {
    throw new Error(`mtools is not installed (${MTOOLS.format} not found on PATH). The Windows answer-file disk needs mtools: install the "mtools" package in the image.`)
  }
  mkdirSync(path.dirname(p.setupImg), { recursive: true })
  try { unlinkSync(p.setupImg) } catch {}
  const fd = openSync(p.setupImg, 'w')
  try { ftruncateSync(fd, SETUP_IMAGE_BYTES) } finally { closeSync(fd) }
  const run = (command, args) => execFileSync(command, args, { stdio: 'pipe', timeout: 120000 })
  // F1: THE VOLUME LIVES AT LBA 2048, NOT AT BYTE 0. Every mtools call names
  // the partition through `@@<byte-offset>`; `-H 2048` writes the matching
  // "hidden sectors" value into the BPB, which is what Windows compares against
  // the partition table when it mounts the volume.
  const volume = setupVolumeSpec(p.setupImg)
  run(MTOOLS.format, ['-i', volume, '-F', '-H', String(SETUP_PARTITION_START_LBA), '-v', SETUP_IMAGE_LABEL, '::'])
  // The table goes on AFTER the format (mformat only touches its own volume, but
  // the partition length is read from the BPB it just wrote).
  const partition = writeSetupMbr(p.setupImg)
  // `-s` recurses into $OEM$; the explicit root list keeps startup.nsh and the
  // scripts visible at the medium's root where a human (and the EFI Shell for
  // startup.nsh) expects them.
  run(MTOOLS.copy, ['-i', volume, '-s', ...staged, oemTree, '::'])
  // F1: the medium is WRITABLE by the user that runs QEMU (uid 1000). mkstemp's
  // default mode is already owner-writable, but pinning it makes the contract
  // explicit and survives a restrictive umask / a copied store.
  chmodSync(p.setupImg, 0o600)
  const verified = verifySetupImage({ paths: p })
  log(`windows: setup.img built (${(SETUP_IMAGE_BYTES / 1024 ** 2).toFixed(0)} MB MBR + FAT32 partition at LBA ${partition.startLba}, ${verified.entries.length} root entries, Autounattend.xml byte-verified)`)
  return p.setupImg
}

/**
 * S2: READ THE IMAGE BACK. This is the assertion that would have caught the
 * invisible-media bug: `mdir` must list `Autounattend.xml` at the root, the
 * `$OEM$` script path must exist, and `mtype` must return the SAME BYTES that
 * were staged (a FAT write that silently truncates is a Setup that asks
 * questions).
 *
 * F1: AND IT READS THROUGH THE PARTITION. The MBR is verified first — 0x55AA at
 * 510, one active type-0x0C entry at 0x1BE starting at LBA 2048 — because a
 * perfectly populated FAT32 volume that Windows never enumerates is exactly the
 * bug this replaced. The listing then goes through `@@<offset>`, the same
 * volume spec the build used.
 */
export function verifySetupImage({ paths: p } = {}) {
  const mbr = readSetupMbr(p.setupImg)
  if (mbr.signature !== '55aa') {
    throw new Error(`setup.img has no valid MBR signature at 510 (found ${mbr.signature || 'nothing'}) — Windows never mounts a partitionless fixed disk, so Setup would show the interactive language screen`)
  }
  if (mbr.type !== SETUP_PARTITION_TYPE || mbr.startLba !== SETUP_PARTITION_START_LBA) {
    throw new Error(`setup.img's first partition is type 0x${mbr.type.toString(16)} at LBA ${mbr.startLba}; the answer volume must be type 0x${SETUP_PARTITION_TYPE.toString(16)} at LBA ${SETUP_PARTITION_START_LBA}`)
  }
  if (mbr.sectorCount <= 0) throw new Error('setup.img\'s MBR partition has zero sectors')
  const volume = setupVolumeSpec(p.setupImg)
  const readDir = (spec) => {
    const listing = execFileSync(MTOOLS.dir, ['-i', volume, '-b', spec], { encoding: 'utf8', timeout: 30000 })
    return listing
      .split(/\r?\n/u)
      .map((line) => line.trim().replace(/^::[\\/]?/u, '').replace(/\\/gu, '/'))
      .filter(Boolean)
      // mdir prints a nested listing with the whole path; callers compare names.
      .map((entry) => entry.split('/').filter(Boolean).pop())
  }
  const root = readDir('::/')
  for (const required of SETUP_IMAGE_ENTRIES) {
    if (!root.includes(required)) {
      throw new Error(`setup.img does not list ${required} at its root (mdir said: ${root.slice(0, 12).join(', ') || 'nothing'}). Setup will not find the answer file.`)
    }
  }
  // The `$OEM$` tree is a DIRECTORY entry at the root; its contents need their
  // own listing. Setup copies these into C:\Windows\Setup\Scripts, and
  // SetupComplete.cmd is what makes the provisioning run at all.
  const oemScripts = readDir('::/$OEM$/$$/Setup/Scripts')
  for (const script of ['setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs']) {
    if (!oemScripts.includes(script)) {
      throw new Error(`setup.img's $OEM$/$$/Setup/Scripts is missing ${script} (listed: ${oemScripts.join(', ') || 'nothing'}) — Setup would never stage it into C:\\Windows\\Setup\\Scripts`)
    }
  }
  // BYTE COMPARE, exactly like dockur: the host copy and the image copy must be
  // indistinguishable. mtype emits the raw file.
  for (const name of ['Autounattend.xml', 'setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs']) {
    const staged = readFileSync(path.join(p.oemDir, name))
    const fromImage = execFileSync(MTOOLS.type, ['-i', volume, `::/${name}`], { timeout: 30000 })
    if (!staged.equals(fromImage)) {
      throw new Error(`setup.img's ${name} differs from the staged copy (${fromImage.length} vs ${staged.length} bytes) — the answer medium is corrupt`)
    }
  }
  const startup = execFileSync(MTOOLS.type, ['-i', volume, '::/startup.nsh'], { timeout: 30000 })
  if (!startup.equals(readFileSync(path.join(p.oemDir, 'startup.nsh')))) {
    throw new Error('setup.img\'s startup.nsh differs from the staged copy — the EFI Shell fallback would not run')
  }
  return { entries: root, oemScripts, image: p.setupImg, mbr, partition: { startLba: mbr.startLba, offsetBytes: SETUP_PARTITION_OFFSET_BYTES, sectorCount: mbr.sectorCount } }
}

/**
 * R5 (BELT AND BRACES): THE EFI SHELL'S `startup.nsh`.
 *
 * If R1's QMP key press misses, OVMF's BDS falls into the EFI Internal Shell.
 * The firmware Shell runs `startup.nsh` from the filesystem it lands on, so this
 * script tries `\efi\boot\bootx64.efi` on every mapped FS0..FS5 and chain-loads
 * the install media instead of stopping at a prompt. It is shipped at the ROOT
 * of setup.img (the medium we author ourselves), which is where the Shell looks.
 */
export function startupNshText() {
  // The EFI Shell dialect: `%f` iterates the word list, `if exist` tests the
  // mapping, and a bare path on its own line chain-loads it.
  const lines = [
    '@echo -off',
    "REM R5: written by dsh-cua-vm. If Windows Setup was not reached (R1's key",
    'REM press missed, or cdboot timed out), chain-load the install media itself',
    'REM instead of stopping at this prompt. The CD is one of FS0..FS5.',
    'for %f in fs0 fs1 fs2 fs3 fs4 fs5',
    '  if exist %f:\\efi\\boot\\bootx64.efi then',
    '    echo "cua: chaining to %f:\\efi\\boot\\bootx64.efi"',
    '    %f:\\efi\\boot\\bootx64.efi',
    '  endif',
    'endfor',
    'echo "cua: no bootable \\efi\\boot\\bootx64.efi on FS0..FS5 - Windows Setup did not start."',
    'echo "cua: the install medium is missing or unreadable; see qemu-stderr.log / serial.log on the host."'
  ]
  return `${lines.join('\n')}\n`
}

/** Where this module itself lives — the last-resort source of the payload. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * A directory that holds ALL of `OEM_PAYLOAD_FILES`, or null.
 *
 * A directory is enough — the flat image check tree (`/opt/seek-harness/
 * cua-check/`) keeps the same files at its root, so the same predicate
 * answers "is this a payload directory?" for both layouts.
 *
 * EACCES IS NOT "MISSING". `existsSync` answers false for BOTH, which is how a
 * permission bug shipped reading like a missing-payload bug: the files were in
 * the image, but the directory arrived `drw-r--r--` from `COPY --chmod=0644`
 * (that flag applies to the directories it creates too), so a uid-1000 process
 * could not traverse it and the user was told to pull a newer image. Anything
 * other than ENOENT/ENOTDIR is reported as a PERMISSION problem by name.
 */
export function oemPayloadDirStatus(dir) {
  if (typeof dir !== 'string' || dir.length === 0) {
    return { dir: String(dir ?? ''), ok: false, missing: [], denied: null }
  }
  const missing = []
  for (const file of OEM_PAYLOAD_FILES) {
    const target = path.join(dir, file)
    try {
      statSync(target)
    } catch (error) {
      const code = error?.code
      if (code === 'EACCES' || code === 'EPERM') {
        return { dir, ok: false, missing, denied: { path: target, code, cause: error } }
      }
      missing.push(file)
    }
  }
  return { dir, ok: missing.length === 0, missing, denied: null }
}

export function oemPayloadDir(dir) {
  return oemPayloadDirStatus(dir).ok ? dir : null
}

/**
 * The first directory among `candidates` that carries the whole payload.
 * Order matters: the configured source wins, the fallbacks are self-healing.
 */
export function resolveOemSourceDir(candidates) {
  for (const candidate of candidates) {
    const found = oemPayloadDir(candidate)
    if (found !== null) return found
  }
  return null
}

/**
 * The first candidate whose TRAVERSAL was denied (EACCES), or null.
 *
 * Used only to choose the error text: a denied directory is an image PERMISSION
 * defect, and telling that user to rebuild with newer media is wrong advice.
 */
export function oemPayloadDeniedDir(candidates) {
  for (const candidate of candidates) {
    const status = oemPayloadDirStatus(candidate)
    if (status.denied !== null) return candidate
  }
  return null
}

/**
 * WHAT THE USER SEES WHEN THE IMAGE HAS NO WINDOWS BACKEND.
 *
 * The old one-liner ("the OEM payload is missing from this image: <path>") named
 * a path and nothing else: no reason, no rebuild steps, no way to tell a stale
 * image from a broken mount. It is a failure of the IMAGE, not of the computer
 * spec, so the message says so in that order and ends with a command to run.
 */
/**
 * THE OTHER IMAGE FAILURE: THE FILES ARE THERE, THE PROCESS MAY NOT READ THEM.
 *
 * `COPY --chmod=0644 docker/windows-oem/ <dest>/` applies 0644 to EVERY copied
 * entry, the destination DIRECTORY included, so a hardened container that runs
 * as uid 1000 could not traverse it while the files were verifiably in the
 * pushed layer. The symptom is identical to the missing-payload one (`ls:
 * Permission denied`, `existsSync === false`), and the old advice — pull a newer
 * image — is exactly wrong. Say which mode/owner is wrong and what the fix is.
 */
export function oemPayloadDeniedError({ sourceDir, denied, deniedDir, fallbackDirs }) {
  const looked = [sourceDir, ...fallbackDirs].filter(Boolean)
  const describe = (target) => {
    try {
      const s = statSync(target)
      return `${(s.mode & 0o777).toString(8).padStart(4, '0')} ${s.uid}:${s.gid}`
    } catch {
      return null
    }
  }
  // The mode that decides whether the payload is reachable is the DIRECTORY's:
  // a 0644 directory denies traversal before any file's own mode is consulted,
  // so `stat`-ing the file itself is the one thing guaranteed to fail here.
  const dir = deniedDir ?? path.dirname(denied)
  const dirMode = describe(dir)
  const fileMode = describe(denied)
  // Neither the file nor the directory may be stat'ed at all when a PARENT is
  // the non-traversable one (the same COPY creates /usr/local/share/cua-vm), so
  // the message walks up to the first ancestor that can still be described.
  const firstReachable = (() => {
    let current = dir
    for (let hop = 0; hop < 4; hop += 1) {
      const mode = describe(current)
      if (mode !== null) return { path: current, mode }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return null
  })()
  const where = fileMode !== null
    ? `EACCES on ${denied} (mode/owner: ${fileMode})`
    : dirMode !== null
      ? `EACCES traversing ${dir} (dir mode/owner: ${dirMode})`
      : `EACCES reaching ${denied} — neither the file nor its directory could be opened, so an ANCESTOR is not traversable (last readable: ${firstReachable === null ? 'none' : `${firstReachable.path} ${firstReachable.mode}`})`
  return Object.assign(new Error([
    `the Windows OEM payload is present but NOT READABLE by uid ${typeof process.getuid === 'function' ? process.getuid() : '?'} — ${where}`,
    `(searched ${looked.join(' or ')})`,
    '',
    'This is an IMAGE PERMISSIONS defect, not a missing payload and not a computer setting.',
    'A directory needs its execute bit to be traversed, and `COPY --chmod=0644` sets 0644 on',
    'the directories it CREATES as well as on the files, which leaves',
    '`/usr/local/share/cua-vm/windows-oem` as `drw-r--r--` — the three files are in the image',
    'and no non-root process can open them.',
    '',
    'FIXED IN THE IMAGE by creating the parent 0755, copying as the runtime uid, and',
    'normalising the copied directory modes afterwards:',
    '  RUN install -d -m 0755 /usr/local/share/cua-vm',
    '  COPY --chown=1000:1000 --chmod=0644 docker/windows-oem/ /usr/local/share/cua-vm/windows-oem/',
    '  RUN chmod -R a+rX /usr/local/share/cua-vm/windows-oem',
    'Pull or rebuild an image that carries it, then recreate the container:',
    '  docker compose -f compose.windows.yaml up -d --force-recreate',
    '',
    'To work around it without rebuilding (the rootfs is read_only, so `chmod` inside the',
    'container answers "Read-only file system"), shadow the directory with a read-only mount',
    'from a checkout — the mount\'s own modes replace the image\'s:',
    '  # compose override',
    '  volumes: [./docker/windows-oem:/usr/local/share/cua-vm/windows-oem:ro]',
    '  docker compose -f compose.yaml -f compose.windows.yaml up -d',
    'then verify as the runtime user:',
    '  docker compose exec seek-harness ls -l /usr/local/share/cua-vm/windows-oem/',
  ].join('\n')), { code: 'EACCES', deniedPath: denied, deniedDir: dir })
}

export function oemPayloadMissingError({ sourceDir, fallbackDirs }) {
  const looked = [sourceDir, ...fallbackDirs].filter(Boolean)
  return new Error([
    `the Windows OEM payload is missing from this image: no ${OEM_PAYLOAD_FILES.join(', ')} under ${looked.join(' or ')}`,
    '',
    'A Windows computer is a DIRECT-QEMU guest: its unattended install reads those files from',
    `the image (default /usr/local/share/cua-vm/windows-oem/). An image without the Windows backend —`,
    'a main-branch build, or any build older than the one that added the Windows backend — cannot',
    'create one, and no computer setting can fix that. Pull or build a newer image:',
    '',
    '  1. build it from branch cua-vm-improve WITH the virgl QEMU (the Windows guest needs it):',
    '     git fetch origin && git checkout cua-vm-improve',
    '     docker build --build-arg WITH_VIRGL_QEMU=1 -t ghcr.io/OWNER/REPO:local .',
    '     (or run Actions → docker-build on cua-vm-improve with channel=github-tag, virgl=true,',
    '      which publishes ghcr.io/OWNER/REPO:latest; then docker pull ghcr.io/OWNER/REPO:latest)',
    '  2. recreate the container against the NEW image, with the SAME compose env you use now',
    '     (notably DSH_CUA_VM_GPU=virgl if your computer is a GPU one), keeping the /cua-vm',
    '     volume mounted at /cua-vm so the existing store and its computers survive:',
    '     docker compose -f compose.windows.yaml up -d --force-recreate',
    '  3. confirm the payload actually landed, from inside the running container',
    '     (`seek-harness` is the service name in compose.yaml / compose.windows.yaml):',
    `     docker compose exec seek-harness ls -l /usr/local/share/cua-vm/windows-oem/${OEM_PAYLOAD_FILES.join(' ')}`,
    '',
    'If step 3 lists all the files and this error persists, DSH_CUA_WINDOWS_OEM_DIR points',
    `somewhere else — unset it (it currently overrides the image default with ${sourceDir}).`
  ].join('\n'))
}

/**
 * Write the unattended-answer payload into `$STORE/windows/<name>/oem/`.
 *
 * The files live in the repository (`docker/windows-oem/`) so they can be read,
 * diffed and fixed without touching JavaScript, exactly like the guest shell
 * scripts. The supervisor copies them with the per-computer substitutions:
 *
 *   {{COMPUTERNAME}}  a DNS-safe name derived from the computer name
 *   {{PASSWORD}}      the generated administrator password
 *   {{SSH_PUBKEY}}    the supervisor's public key (authorized_keys)
 *   {{PYTHON_URL}}    the pinned python.org installer
 *   {{DSH_CUA_PIP}}   the dsh-cua package spec
 *   {{PRODUCT_KEY}}   empty for evaluation media, or a <ProductKey> block when
 *                     the operator passed a licensed-ISO windowsKey
 *   {{IMAGE_INSTALL}} the <InstallFrom> block naming the edition (F2). Resolved
 *                     from windowsImageName / windowsImageIndex / the version
 *                     table — see resolveWindowsImageSelection().
 *
 * SELF-HEALING: `sourceDir` is the image path the supervisor resolves; the
 * `fallbackDirs` are the other places the SAME files are known to exist
 * (the image's flat check tree, the module's own directory, a checkout). A file
 * or two missing from `sourceDir` therefore costs a log line, not a failed
 * computer create — as long as ONE candidate directory is complete.
 */
export function writeOemPayload({ paths: p, name, password, sshPubKey, sourceDir, fallbackDirs = [], pythonUrl, dshCuaSpec, windowsKey = '', windowsVersion = '', windowsImageIndex = 0, windowsImageName = '', log = () => {} }) {
  mkdirSync(p.oemDir, { recursive: true })
  const productKey = normaliseProductKey(windowsKey)
  // F2: the edition, decided BEFORE a byte of XML is written and asserted after,
  // so "Setup asks which image" cannot come back as a surprise at the console.
  const imageSelection = resolveWindowsImageSelection({ version: windowsVersion, imageIndex: windowsImageIndex, imageName: windowsImageName })
  const substitutions = {
    '{{COMPUTERNAME}}': `cua-${name}`.slice(0, 15).toUpperCase(),
    '{{PASSWORD}}': password,
    '{{SSH_PUBKEY}}': sshPubKey.trim(),
    '{{PYTHON_URL}}': pythonUrl,
    '{{DSH_CUA_PIP}}': dshCuaSpec,
    // S3: EVALUATION MEDIA IGNORE THIS; a licensed operator ISO uses it and
    // Setup never shows a product-key page (WillShowUI Never).
    '{{PRODUCT_KEY}}': productKey === ''
      ? ''
      : `<ProductKey><Key>${productKey}</Key><WillShowUI>Never</WillShowUI></ProductKey>`,
    '{{IMAGE_INSTALL}}': imageInstallFromXml(imageSelection)
  }
  const files = OEM_PAYLOAD_FILES
  const candidates = [sourceDir, ...fallbackDirs, path.join(MODULE_DIR, 'windows-oem'), path.resolve(MODULE_DIR, '..', 'docker', 'windows-oem')]
  const resolved = resolveOemSourceDir(candidates)
  if (resolved === null) {
    // EACCES before ENOENT: a denied directory is an image permission defect and
    // must not be reported as "the payload is missing" (they were the same
    // symptom for `existsSync`, and the wrong advice sent users to re-pull).
    const deniedDir = oemPayloadDeniedDir(candidates)
    if (deniedDir !== null) {
      const deniedPath = oemPayloadDirStatus(deniedDir).denied?.path ?? deniedDir
      throw oemPayloadDeniedError({ sourceDir, denied: deniedPath, deniedDir, fallbackDirs })
    }
    throw oemPayloadMissingError({ sourceDir, fallbackDirs })
  }
  if (path.resolve(resolved) !== path.resolve(sourceDir)) {
    log(`windows: OEM payload not found at ${sourceDir}; using the copy at ${resolved}`)
  }
  for (const file of files) {
    const source = path.join(resolved, file)
    let text = readFileSync(source, 'utf8')
    for (const [needle, value] of Object.entries(substitutions)) text = text.split(needle).join(value)
    writeFileSync(path.join(p.oemDir, file), text)
  }
  // F2: the staged answer file must actually name the edition, in the schema
  // position Setup reads. A placeholder left unreplaced is caught here, not on
  // the install console.
  const stagedXml = readFileSync(path.join(p.oemDir, 'Autounattend.xml'), 'utf8')
  if (stagedXml.includes('{{')) {
    const leftover = [...stagedXml.matchAll(/\{\{[A-Z_]+\}\}/gu)].map((match) => match[0])
    throw new Error(`the staged Autounattend.xml still contains ${[...new Set(leftover)].join(', ')} — Setup would read a literal placeholder`)
  }
  const selected = assertAnswerFileSelectsImage(stagedXml)
  // The staged payload is a DIRECTORY on the host; buildSetupImage() copies it
  // into the FAT32 partition at the ROOT (where Setup reads Autounattend.xml)
  // and into $OEM$ (so Setup copies the scripts into C:\Windows\Setup\Scripts).
  const setupDir = path.join(p.oemDir, '$OEM$', '$$', 'Setup', 'Scripts')
  mkdirSync(setupDir, { recursive: true })
  // S4: the SAME scripts Setup copies into C:\Windows\Setup\Scripts.
  // SetupComplete.cmd is the SYSTEM pass and Unattend.vbs is the hidden
  // first-logon launcher; both invoke cua-firstboot.ps1 idempotently.
  for (const file of ['setupcomplete.cmd', 'cua-firstboot.ps1', 'Unattend.vbs']) {
    copyFileSync(path.join(p.oemDir, file), path.join(setupDir, file))
  }
  // R5: the EFI Shell fallback script goes in the medium's ROOT (that is where
  // firmware Shell looks for `startup.nsh`), not under $OEM$. buildSetupImage()
  // copies it into setup.img's root beside Autounattend.xml.
  writeFileSync(path.join(p.oemDir, 'startup.nsh'), startupNshText())
  log(`windows: ${name} OEM payload written (${files.length} files + $OEM$ scripts + startup.nsh fallback; ${selected.key}=${selected.value} from ${imageSelection.source}${imageSelection.verified === false ? ', UNVERIFIED' : ''})`)
  return p.oemDir
}

/* ------------------------------------------------------------------ *
 * The backend
 * ------------------------------------------------------------------ */

/**
 * R3: THE TWO QMP SIGNATURES, JOINED.
 *
 * The backend's helpers dial `qmp(host, port, commands, opts)`; the supervisor's
 * one implementation is `qmpCommands(port, commands, { timeoutMs, host })`. The
 * supervisor used to pass its primitive in directly, so the backend's HOST
 * string arrived as the supervisor's PORT argument and every probe died before
 * a byte reached the monitor:
 *
 *     probe(row) → qmpFor → qmp('127.0.0.1', 46100, …)
 *     qmpCommands('127.0.0.1', 46100, …) → net.connect('127.0.0.1' as port) → throws
 *     → status '' → qmp 'not answering' → a RUNNING QEMU never became ready.
 *
 * This adapter is the fix at the seam: it accepts the backend's signature and
 * forwards the supervisor's, so neither side has to change its contract and a
 * test can prove the join with a faithful stub. It is also tolerant of a plain
 * `(port, commands, opts)` primitive (a test or an older caller), which is
 * resolved by the argument TYPES — a number first is a port, a string first is
 * a host.
 */
/** Marks a function that already IS an adapter, so wrapping is idempotent. */
const QMP_ADAPTED = Symbol.for('dsh.cua.windows.qmpAdapted')

export function windowsQmpAdapter(primitive) {
  if (typeof primitive !== 'function') {
    throw new Error('the Windows backend needs a QMP primitive: (host, port, commands, opts) => Promise<object[]>')
  }
  // DOUBLE WRAPPING IS A REAL CALL PATH: the supervisor wraps its primitive AND
  // `createWindowsBackend` wraps whatever it is handed (a test may pass a stub
  // with no wrapper at all). Without this marker the second wrap treats the
  // backend-shaped call as a supervisor-shaped one — port becomes the command
  // array — which is the same class of bug as the one being fixed.
  if (primitive[QMP_ADAPTED] === true) return primitive
  const adapted = function qmp(host, port, commands, opts = {}) {
    // A caller that already speaks the supervisor's shape: (port, commands, opts).
    if (typeof host === 'number' && Array.isArray(port) && commands === undefined) {
      return primitive(host, port, opts)
    }
    return primitive(port, commands, { ...opts, host })
  }
  Object.defineProperty(adapted, QMP_ADAPTED, { value: true })
  return adapted
}

/**
 * The lifecycle object.
 *
 * @param {object} options
 * @param {string} options.store            the VM store
 * @param {(host: string, port: number, commands: object[], opts?: object) => Promise<object[]>} options.qmp
 * @param {(...parts: any[]) => void} options.log
 */
export function createWindowsBackend({ store, qmp, log = () => {} }) {
  /** Monotonic counter so two frames never share a serial name. */
  let FRAME_SEQUENCE = 0

  /**
   * R3: ONE QMP CALL SIGNATURE IN, THE SUPERVISOR'S ONE OUT.
   *
   * The backend's helpers all dial `qmp(host, port, commands, opts)` (that is
   * what `qmpFor` writes), but the primitive the supervisor injects has always
   * been `qmpCommands(port, commands, { timeoutMs, host })`. Passing it straight
   * in therefore sent the HOST as the PORT: the monitor dial threw
   * `ECONNREFUSED`/`ERR_INVALID_ARG_TYPE` on every probe, `probe()` reported
   * `qmp: 'not answering'`, and a perfectly running QEMU never became ready —
   * even after the row's `name` was fixed.
   *
   * `windowsQmpAdapter` is that missing half, exported so a test can prove the
   * two shapes line up instead of trusting the wiring.
   */
  const callQmp = windowsQmpAdapter(qmp)

  /**
   * ACCEPT A NAME *OR* A ROW. Every helper below is called with the registry row
   * in production and with a flat spec in tests; resolving once here keeps both
   * correct (R2).
   */
  function namedSpec(spec, fallback = '') {
    const name = windowsRowName(spec, fallback)
    if (spec && typeof spec === 'object') return spec.name === name ? spec : { ...spec, name }
    return { name }
  }
  /** One QEMU child per computer, so stop/kill act on the right process. */
  const children = new Map()

  /**
   * R2: A NAME, OR A ROW THAT CARRIES ONE.
   *
   * The supervisor's rows are keyed by name and (before this fix) had no `name`
   * field at all, so `pathsFor(row.name)` was `pathsFor(undefined)` →
   * `$STORE/windows/undefined/qemu.pid`, and every liveness answer was a lie.
   * Resolving through `windowsRowName` here means the same helper is correct
   * whether it is handed `'win-box'` or the row for it.
   */
  function pathsFor(target) {
    return windowsPaths(store, windowsRowName(target))
  }

  /** Which of our two QEMU processes is alive (pidfile is written by QEMU). */
  function qemuPid(target) {
    try {
      const pid = Number(readFileSync(pathsFor(target).qemuPid, 'utf8').trim())
      return Number.isFinite(pid) && pid > 0 ? pid : 0
    } catch {
      return 0
    }
  }

  function pidAlive(pid) {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }

  /**
   * WHAT THE SPAWNED CHILD ITSELF SAYS: `exited` is true only when the child has
   * been reaped. It exists because "no pidfile" has two very different causes —
   * QEMU never started, or QEMU has not WRITTEN the pidfile yet — and only this
   * distinguishes them. Without it the install watchdog would call a QEMU that
   * is one millisecond away from writing its pidfile dead.
   */
  function childState(name) {
    const child = children.get(`qemu:${windowsRowName(name)}`)
    if (child === undefined) return { known: false, exited: false }
    return { known: true, exited: child.exitCode !== null || child.signalCode !== null }
  }

  /** The ports one computer uses: QMP, VNC and the SSH forward. */
  function portsFor(spec) {
    return windowsPortsOf(spec)
  }

  /**
   * START SWTMP FIRST, THEN QEMU.
   *
   * swtpm owns the TPM state directory and the socket; QEMU connects to it as a
   * chardev, so a QEMU that starts before the socket exists fails with "Failed
   * to connect to socket". It is a plain child process, killed by `stopSwtpm`.
   */
  function startSwtpm(target) {
    const name = windowsRowName(target)
    const p = pathsFor(name)
    mkdirSync(p.tpmDir, { recursive: true })
    try { unlinkSync(p.tpmSocket) } catch {}
    const child = spawn(SWTPM, [
      'socket', '--tpm2',
      '--ctrl', `type=unixio,path=${p.tpmSocket}`,
      '--tpmstate', `dir=${p.tpmDir},mode=0600`,
      '--pid', `file=${p.tpmPid}`,
      '--log', `file=${path.join(p.dir, 'swtpm.log')},level=1`,
      '--flags', 'not-need-init,startup-clear'
    ], { stdio: 'ignore', detached: true })
    child.unref()
    children.set(`tpm:${name}`, child)
    // Wait for the socket: QEMU connects immediately.
    for (let index = 0; index < 100; index += 1) {
      if (existsSync(p.tpmSocket)) return true
      execFileSync('sleep', ['0.1'])
    }
    return existsSync(p.tpmSocket)
  }

  function stopSwtpm(target) {
    const name = windowsRowName(target)
    const child = children.get(`tpm:${name}`)
    children.delete(`tpm:${name}`)
    try { child?.kill('SIGTERM') } catch {}
    try {
      const pid = Number(readFileSync(pathsFor(name).tpmPid, 'utf8').trim())
      if (pidAlive(pid)) process.kill(pid, 'SIGTERM')
    } catch {}
  }

  /**
   * Boot the computer, or bring it back.
   *
   * `installPending` is decided by the caller from the disk's existence: a fresh
   * create boots the install ISO; every later start boots the disk.
   */
  async function boot(rawSpec, { installPending = false, allowGpuFallback = true } = {}) {
    // ACCEPT EITHER SHAPE: the create path hands in flat fields, a start path
    // could hand in a registry row. buildQemuArgs only reads the flat ones.
    const spec = windowsBootSpec(rawSpec)
    const p = pathsFor(spec.name)
    mkdirSync(p.dir, { recursive: true })
    const caps = windowsHostCaps()
    if (!caps.qemu) throw new Error(`the Windows backend needs ${WINDOWS_QEMU} (install qemu-system-x86 in the image)`)
    // THE DEVICE SPLIT. A missing node and a mounted-but-denied node are two
    // different defects with two different fixes, and the old single sentence
    // ("needs /dev/kvm (compose.emulator.yaml)") was wrong for both of the new
    // cases: wrong for a char device (isFile() is false) and wrong advice for a
    // GID problem. `kvmPreflightError` quotes the observed mode/owner/groups.
    const kvmError = windowsKvmPreflight()
    if (kvmError !== null) throw kvmError
    if (!caps.ovmfCode || !caps.ovmfVars) {
      throw new Error(`the Windows backend needs OVMF (${OVMF_CODE} + ${OVMF_VARS_TEMPLATE}); install the ovmf package in the image`)
    }
    if (!caps.swtpm) throw new Error(`the Windows backend needs swtpm (${SWTPM}); install the swtpm package in the image`)
    if (!existsSync(p.efiVars)) {
      // OVMF fails with "Could not open backing file" when vars qcow2 is missing.
      mkdirSync(path.dirname(p.efiVars), { recursive: true })
      execFileSync('/usr/bin/qemu-img', ['create', '-f', 'qcow2', '-b', OVMF_VARS_TEMPLATE, '-F', 'raw', p.efiVars, '4M'], { timeout: 30000 })
      log(`windows: ${spec.name} EFI vars created from ${OVMF_VARS_TEMPLATE}`)
    }
    if (!startSwtpm(spec.name)) throw new Error('swtpm did not create its socket (see swtpm.log)')
    // FROM HERE swtpm IS RUNNING, so every failure has to stop it again: a
    // leaked swtpm keeps the TPM state directory open and the next boot fails
    // with "TPM is already in use" — the kind of failure that only appears on
    // the SECOND attempt, long after the first error was read.
    const attempt = async (attemptSpec, { stderrFile = p.qemuStderr } = {}) => {
      // A STALE PIDFILE IS NOT THIS BOOT. `qemuPid()` is how the watchdog below
      // (and every other helper) decides "alive"; a pidfile left by a previous
      // boot names a pid that is gone or, worse, recycled. QEMU rewrites it
      // after init, but the WINDOW between spawn and that write must not be
      // filled by last night's answer.
      try { unlinkSync(p.qemuPid) } catch {}
      const argv = buildQemuArgs({
        ...attemptSpec,
        paths: p,
        installPending,
        virtio: Boolean(caps.virtioWin),
        driverIso: caps.virtioWin ? VIRTIO_WIN_ISO : null
      })
      // QEMU'S STDERR IS THE ONLY PLACE AN INIT FAILURE IS EXPLAINED, and it
      // used to go to /dev/null: the reported create left one supervisor line
      // ("qemu started (pid 906, installing)"), an EMPTY serial.log and no QEMU
      // diagnosis anywhere on the host. `-serial file:` records the GUEST;
      // this records QEMU itself, on both streams, truncated per attempt so the
      // excerpt read after a failure belongs to the attempt that failed.
      const stderrFd = openSync(stderrFile, 'w')
      let child
      try {
        child = spawn(WINDOWS_QEMU, argv, { stdio: ['ignore', stderrFd, stderrFd], detached: true })
      } finally {
        // The child holds its own copy; keeping ours open would leak an fd per
        // restart and delay nothing.
        try { closeSync(stderrFd) } catch {}
      }
      children.set(`qemu:${spec.name}`, child)
      // A SPAWN ERROR IS AN EVENT, NOT A THROW: without this listener, a missing
      // qemu binary (or E2BIG on a bad argv) raises an unhandled 'error' and takes
      // the whole supervisor down — every computer with it.
      child.on('error', (error) => {
        log(`windows: ${spec.name} qemu failed to start: ${error?.message ?? error}`)
        stopSwtpm(spec.name)
      })
      child.unref()
      log(`windows: ${spec.name} qemu started (pid ${child.pid}${installPending ? ', installing' : ''})`)
      // R1/F2: THE INSTALL CD'S "PRESS ANY KEY" WINDOW, PRESSED FOR THE USER.
      //
      // VERIFIED LIVE: OVMF reaches the DVD, `cdboot.efi 10.0.26100.1` prints
      // "Press any key to boot from CD or DVD", nobody presses a key within 5 s,
      // cdboot prints EFI_TIMEOUT and BDS falls into the EFI Internal Shell —
      // where the install simply stops. This schedules QMP key presses inside
      // that window and deliberately does NOT await them: boot()'s pidfile
      // window must not be extended by a keystroke.
      //
      // F2: THE ANCHOR IS THE SERIAL CONSOLE, NOT THE SPAWN CLOCK. The live
      // forensic child proved the fixed 1.5/3.5/5.5 s presses land while OVMF is
      // still enumerating, i.e. BEFORE cdboot prints its prompt, so the first
      // boot missed the window entirely. `serial.log` is watched for the prompt
      // signature (or for first output + ~1.5 s) and the presses fire from
      // there, every 0.8 s; the fixed schedule survives only as the fallback
      // for a console that stays silent. See runCdbootKeys().
      //
      // ONLY WHILE INSTALLING. A boot of an already-installed disk has no
      // prompt to dismiss, and typing into a live guest would be a keystroke
      // the user never asked for.
      //
      // Failure to send is NOT fatal (the firmware may not have the keyboard up
      // yet, or the child may have exited): it is logged, and the next attempt
      // in the schedule covers the same window.
      if (installPending && cdbootKeysEnabled() && child?.pid) {
        const keyedSpec = windowsBootSpec({ ...attemptSpec, paths: p })
        void runCdbootKeys({
          scheduleMs: cdbootKeyScheduleMs(),
          serialLog: p.serialLog,
          log,
          name: spec.name,
          sendKey: (key) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              throw new Error('this QEMU child exited before the key was due')
            }
            return sendKeys(keyedSpec, { key })
          }
        }).catch(() => {})
      }
      const settled = await waitForQemuBoot({
        child,
        pidFile: p.qemuPid,
        isAlive: (pid) => pidAlive(pid),
        windowMs: qemuBootWindowMs()
      })
      return { child, display: attemptSpec.gpu && attemptSpec.virgl ? 'egl-headless' : 'none', ...settled }
    }

    const readStderr = (file = p.qemuStderr) => {
      try { return readFileSync(file, 'utf8') } catch { return '' }
    }

    const first = await attempt(spec)
    if (first.ok) return { pid: first.pid, installPending, display: spec.gpu && spec.virgl ? 'egl-headless' : 'none', gpuFallback: false, warnings: [] }

    const stderr = readStderr()
    const excerpt = qemuStderrExcerpt(stderr, 20)
    const reason = qemuStderrReason(stderr)
    const kind = classifyQemuInitFailure(stderr)
    // NOTHING OF THE DEAD ATTEMPT MAY SURVIVE: its child has exited (or is
    // about to), and its swtpm socket belongs to a TPM the next QEMU must be
    // able to claim.
    try { children.delete(`qemu:${spec.name}`) } catch {}
    try { first.child?.kill('SIGKILL') } catch {}
    stopSwtpm(spec.name)
    log(`windows: ${spec.name} qemu died during init (${kind}): ${reason || 'no stderr output'}`)
    if (excerpt !== '') log(`windows: ${spec.name} qemu-stderr.log tail:\n${excerpt}`)

    // F3: THE DISPLAY PATH MAY DEGRADE, THE ACCELERATOR MAY NOT.
    //
    // A host whose EGL/render-node/virgl stack cannot initialize is a host that
    // cannot give Windows an accelerated display — but Windows renders on an
    // emulated VGA/WARP framebuffer perfectly well, which is the documented
    // behaviour of this backend. Retrying ONCE with `-display none` + VGA turns
    // a dead create into a working computer WITH a warning naming the captured
    // reason.
    //
    // KVM is the opposite: the preflight already proved the device is usable, so
    // a KVM failure here is news (a host that lost the device, a nested-VM
    // restriction) and booting on TCG would be a 30-minute silent lie. It is
    // surfaced with the captured stderr and NEVER degraded.
    const canFallback = allowGpuFallback && first.display !== 'none' && kind !== 'kvm' && kind !== 'none' && (kind === 'display' || kind === 'init')
    if (canFallback) {
      // THE TPM MUST BE BACK BEFORE THE RETRY. The cleanup above stopped swtpm
      // (a QEMU that has exited leaves the emulator with a dead data client, and
      // the next QEMU would die on "Failed to connect to socket"), so the retry
      // gets a FRESH emulator on the SAME per-computer state directory — the TPM
      // therefore keeps its state and the reinstall does not re-measure it.
      if (!startSwtpm(spec.name)) throw new Error('swtpm did not restart for the GPU-less retry (see swtpm.log)')
      log(`windows: ${spec.name} retrying once without the GPU display (-display none, plain VGA)`)
      // THE RETRY WRITES ITS OWN FILE: `qemu-stderr.log` keeps the FIRST
      // attempt's diagnosis (the EGL line the warning quotes), and a second
      // failure has its own evidence at `qemu-stderr-retry.log`.
      const retry = await attempt({ ...spec, gpu: false, virgl: false }, { stderrFile: p.qemuStderrRetry })
      if (retry.ok) {
        const warning = {
          code: 'gpu-fallback',
          message: `virgl/EGL display unavailable on this host (${reason || 'QEMU could not initialize the egl-headless display'}); continuing without GPU display — Windows renders on emulated VGA/WARP as documented`
        }
        log(`windows: ${spec.name} ${warning.message}`)
        return { pid: retry.pid, installPending, display: 'none', gpuFallback: true, warnings: [warning], stderrExcerpt: excerpt }
      }
      const retryStderr = readStderr(p.qemuStderrRetry)
      const retryExcerpt = qemuStderrExcerpt(retryStderr, 20) || excerpt
      const retryReason = qemuStderrReason(retryStderr) || reason
      const retryKind = classifyQemuInitFailure(retryStderr)
      try { children.delete(`qemu:${spec.name}`) } catch {}
      try { retry.child?.kill('SIGKILL') } catch {}
      stopSwtpm(spec.name)
      log(`windows: ${spec.name} the GPU-less retry ALSO failed (${retryKind}): ${retryReason || 'no stderr output'}`)
      throw qemuInitError({
        name: spec.name,
        kind: retryKind === 'none' ? kind : retryKind,
        reason: retryReason,
        excerpt: retryExcerpt,
        stderrPath: p.qemuStderrRetry,
        retriedWithoutGpu: true
      })
    }

    throw qemuInitError({ name: spec.name, kind, reason, excerpt, stderrPath: p.qemuStderr, retriedWithoutGpu: false })
  }

  /** QMP to this computer's loopback socket, with the supervisor's client. */
  async function qmpFor(spec, commands, { timeoutMs = 15000 } = {}) {
    // THE ROW HAS `ports: { qmp }`, the boot spec has `qmpPort`. Resolving here
    // means no caller can dial `undefined` (see windowsPortsOf).
    const { qmpPort } = windowsPortsOf(spec)
    if (qmpPort <= 0) throw new Error('this computer has no QMP port recorded (the row is missing ports.qmp)')
    return callQmp('127.0.0.1', qmpPort, commands, { timeoutMs })
  }

  /** `query-status` plus the process table: the only trustworthy "is it up". */
  async function probe(rawSpec, { name = '' } = {}) {
    const spec = namedSpec(rawSpec, name)
    const alive = pidAlive(qemuPid(spec))
    let status = ''
    let error = ''
    if (alive) {
      try {
        const answer = await qmpFor(spec, [{ execute: 'query-status' }], { timeoutMs: 5000 })
        status = String(answer?.[0]?.return?.status ?? '')
      } catch (caught) {
        error = caught?.message ?? String(caught)
      }
    }
    // `qmp` is the fact the PANEL prints. It is deliberately not `status ||
    // 'not running'` at the call sites: "QEMU is alive but its monitor did not
    // answer" is a third state, and collapsing it into "not running" is what
    // made a live install read as dead.
    const qmp = !alive ? 'no qemu' : status === '' ? 'not answering' : status
    return { alive, status, qmp, error, name: spec.name }
  }

  /**
   * READY = QMP `running` AND a guest endpoint that answers.
   *
   * The endpoint is SSH by default (the OEM script installs it, and exec/put/get
   * depend on it), with VNC-accept as the fallback for a computer created with
   * `ssh: false` or one whose first boot is still finishing. `paused` is NOT
   * ready — a paused guest keeps its VNC port open and used to read as running.
   */
  async function ready(rawSpec, { ssh = true, phase = 'running', name = '' } = {}) {
    const spec = namedSpec(rawSpec, name)
    const state = await probe(spec)
    const ports = windowsPortsOf(spec)
    if (!state.alive || state.status !== 'running') return { ready: false, endpoint: 'none', phase, ...state }
    if (phase === 'install') {
      // DURING SETUP only SSH counts. QEMU's VNC socket answers from the first
      // second of setup.exe, so a VNC probe called a half-installed Windows
      // "ready", set installComplete, and the next Start booted the half-written
      // disk. SSH exists only after the answer file has run.
      const banner = ports.sshPort > 0 ? await bannerProbe('127.0.0.1', ports.sshPort, { timeoutMs: 3000 }) : null
      if (banner !== null) return { ready: true, endpoint: 'ssh', banner: banner.slice(0, 24), phase, ...state }
      return { ready: false, endpoint: 'none', phase, ...state }
    }
    if (ssh) {
      const banner = ports.sshPort > 0 ? await bannerProbe('127.0.0.1', ports.sshPort) : null
      if (banner !== null) return { ready: true, endpoint: 'ssh', banner: banner.slice(0, 24), phase, ...state }
    }
    const vnc = ports.vncPort > 0 ? await bannerProbe('127.0.0.1', ports.vncPort) : null
    if (vnc !== null) return { ready: true, endpoint: 'vnc', phase, ...state }
    return { ready: false, endpoint: 'none', phase, ...state }
  }

  /** A PNG frame of the guest's framebuffer (QMP screendump). */
  async function screenshot(rawSpec, { saveTo = null } = {}) {
    const spec = namedSpec(rawSpec)
    const p = pathsFor(spec)
    const unique = `${(FRAME_SEQUENCE += 1)}-${randomBytes(4).toString('hex')}`
    const file = path.join(p.dir, `shot-${unique}.png`)
    await qmpFor(spec, [{ execute: 'screendump', arguments: { filename: file } }])
    let png = null
    for (let attempt = 0; attempt < 40 && png === null; attempt += 1) {
      if (existsSync(file)) {
        png = readFileSync(file)
        try { unlinkSync(file) } catch {}
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    if (png === null) throw new Error('the guest produced no frame (screendump wrote nothing)')
    if (typeof saveTo === 'string' && saveTo !== '') writeFileSync(saveTo, png)
    return { png }
  }

  /** Absolute pointer, in frame pixels (the frame IS the display). */
  async function click(rawSpec, x, y, { width, height, button = 'left' } = {}) {
    const spec = namedSpec(rawSpec)
    const toAbsolute = (value, extent) => Math.max(0, Math.min(0x7fff, Math.round((Number(value) / Math.max(1, Number(extent))) * 0x7fff)))
    const events = [
      { type: 'abs', data: { axis: 'x', value: toAbsolute(x, width) } },
      { type: 'abs', data: { axis: 'y', value: toAbsolute(y, height) } },
      { type: 'btn', data: { down: true, button } },
      { type: 'btn', data: { down: false, button } }
    ]
    await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events } }])
    return { x: Number(x), y: Number(y) }
  }

  async function move(rawSpec, x, y, { width, height } = {}) {
    const spec = namedSpec(rawSpec)
    const toAbsolute = (value, extent) => Math.max(0, Math.min(0x7fff, Math.round((Number(value) / Math.max(1, Number(extent))) * 0x7fff)))
    await qmpFor(spec, [{
      execute: 'input-send-event',
      arguments: {
        events: [
          { type: 'abs', data: { axis: 'x', value: toAbsolute(x, width) } },
          { type: 'abs', data: { axis: 'y', value: toAbsolute(y, height) } }
        ]
      }
    }])
    return { x: Number(x), y: Number(y) }
  }

  async function drag(rawSpec, fromX, fromY, toX, toY, { width, height } = {}) {
    const spec = namedSpec(rawSpec)
    const toAbsolute = (value, extent) => Math.max(0, Math.min(0x7fff, Math.round((Number(value) / Math.max(1, Number(extent))) * 0x7fff)))
    const at = (x, y) => [
      { type: 'abs', data: { axis: 'x', value: toAbsolute(x, width) } },
      { type: 'abs', data: { axis: 'y', value: toAbsolute(y, height) } }
    ]
    await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events: [...at(fromX, fromY), { type: 'btn', data: { down: true, button: 'left' } }] } }])
    await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events: at(toX, toY) } }])
    await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events: [...at(toX, toY), { type: 'btn', data: { down: false, button: 'left' } }] } }])
    return { from: { x: Number(fromX), y: Number(fromY) }, to: { x: Number(toX), y: Number(toY) } }
  }

  /** Keys and ASCII text, as physical qcodes with the right modifiers. */
  async function sendKeys(rawSpec, { text = null, key = null } = {}) {
    const spec = namedSpec(rawSpec)
    const events = []
    const press = (qcode, { shift = false, ctrl = false, alt = false } = {}) => {
      const modifiers = []
      if (ctrl) modifiers.push('ctrl')
      if (alt) modifiers.push('alt')
      if (shift) modifiers.push('shift')
      for (const modifier of modifiers) events.push({ type: 'key', data: { down: true, key: { type: 'qcode', data: modifier } } })
      events.push({ type: 'key', data: { down: true, key: { type: 'qcode', data: qcode } } })
      events.push({ type: 'key', data: { down: false, key: { type: 'qcode', data: qcode } } })
      for (const modifier of modifiers.reverse()) events.push({ type: 'key', data: { down: false, key: { type: 'qcode', data: modifier } } })
    }
    if (key !== null) {
      const parsed = parseKeySpec(key)
      press(parsed.qcode, { shift: parsed.shift || parsed.shiftModifier, ctrl: parsed.ctrl, alt: parsed.alt })
    }
    if (text !== null) {
      for (const char of String(text)) {
        const mapped = charToKey(char)
        if (mapped === null) {
          throw new Error(`"${char}" cannot be typed on a Windows computer: the QMP keyboard sends physical keys, so only printable ASCII is supported (no clipboard)`)
        }
        press(mapped.qcode, { shift: mapped.shift })
      }
    }
    if (events.length === 0) return { sent: 0 }
    await qmpFor(spec, [{ execute: 'input-send-event', arguments: { events } }])
    return { sent: events.length }
  }

  /** Suspend is QMP `stop` (pause the VM, keep RAM); resume is `cont`. */
  async function pause(rawSpec) {
    await qmpFor(namedSpec(rawSpec), [{ execute: 'stop' }])
    return { paused: true }
  }

  async function unpause(rawSpec) {
    await qmpFor(namedSpec(rawSpec), [{ execute: 'cont' }])
    return { unpaused: true }
  }

  /** F2: how long a mid-install guest may have for ACPI before `quit`. */
  function installShutdownWindowMs() {
    const raw = Number(process.env.DSH_CUA_WINDOWS_INSTALL_SHUTDOWN_MS)
    return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 30000) : 5000
  }

  /**
   * Graceful power-off: `system_powerdown`, then wait, then `quit`.
   *
   * The supervisor owns the checkpoint and the registry; this only makes the
   * process stop. Returns which method worked so shutdown can mark `mayBeTorn`.
   *
   * F2 — TWO GUESTS THAT CANNOT HONOUR A 120 s ACPI WAIT, and used to burn it
   * anyway:
   *
   *   * PAUSED. `query-status` says `paused` (a suspend left the machine paused,
   *     or it was created `-S` and never continued). A paused guest does not run
   *     its ACPI handler at all: `system_powerdown` is accepted by QEMU and then
   *     nothing happens for the whole timeout. Sending `cont` FIRST is the fix —
   *     the guest gets to run the handler, and a suspend→resume→shutdown is
   *     honest instead of a 120 s stall ending in `quit`.
   *
   *   * MID-INSTALL. A WinPE / Setup screen has no ACPI handler either, so a
   *     shutdown during a half-finished install is never "clean". It gets a
   *     SHORT explicit window and then `quit`, and the result says
   *     `installing: true` + `forced: true` so the supervisor marks `mayBeTorn`:
   *     the disk is half-written and must never be recorded as a clean restore
   *     point that Start would silently cold-boot.
   *
   * A NORMAL RUNNING GUEST keeps the full timeout semantics (the 120 s default
   * is for a slow init).
   */
  async function shutdown(rawSpec, { timeoutMs = 120000 } = {}) {
    const spec = namedSpec(rawSpec)
    const state = await probe(spec)
    if (!state.alive) {
      stopSwtpm(spec)
      return { method: 'already-off', exited: true, installInProgress: false }
    }
    // F2a: a paused machine ignores ACPI. Continue it first, or the powerdown
    // below is a no-op that costs the entire timeout.
    const paused = state.status === 'paused' || state.status === 'suspended'
    if (paused) {
      try {
        await qmpFor(spec, [{ execute: 'cont' }], { timeoutMs: 5000 })
      } catch {
        // A monitor that will not `cont` still has `quit`; fall through and let
        // the powerdown/quit path decide.
      }
    }
    // F2b: classify the row, not just the process. `installing`/`booting` is a
    // guest in Setup: no ACPI handler, half-written disk.
    const rowState = String(rawSpec?.state ?? '')
    const installInProgress = rowState === 'installing' || rowState === 'booting'
    const waitMs = installInProgress ? installShutdownWindowMs() : Math.max(1000, timeoutMs)
    let method = 'acpi'
    try {
      const answer = await qmpFor(spec, [{ execute: 'system_powerdown' }], { timeoutMs: 15000 })
      if (answer?.[0]?.error) {
        method = 'quit'
      }
    } catch {
      method = 'quit'
    }
    const deadline = Date.now() + Math.max(installInProgress ? 0 : 1000, waitMs)
    while (Date.now() < deadline) {
      if (!pidAlive(qemuPid(spec))) {
        stopSwtpm(spec)
        // F2b: a mid-install exit is still a torn disk — never a clean restore
        // point — so it carries `forced` even when ACPI appeared to work.
        return { method, exited: true, ...(installInProgress ? { forced: true } : {}), installInProgress }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    method = 'quit'
    try {
      await qmpFor(spec, [{ execute: 'quit' }], { timeoutMs: 10000 })
    } catch {}
    for (let index = 0; index < 30; index += 1) {
      if (!pidAlive(qemuPid(spec))) {
        stopSwtpm(spec)
        // F2b: `forced` is the truth the supervisor persists as `mayBeTorn`. A
        // guest that actually honoured ACPI is NOT forced; a mid-install `quit`
        // is, even though it exited — the disk is half-written either way.
        return { method, exited: true, forced: true, installInProgress }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return { method: 'quit', exited: false, forced: true, installInProgress }
  }

  /** Kill the process (last resort, after `shutdown` refused to exit). */
  function kill(target) {
    const name = windowsRowName(target)
    const child = children.get(`qemu:${name}`)
    children.delete(`qemu:${name}`)
    try { child?.kill('SIGKILL') } catch {}
    const pid = qemuPid(name)
    if (pidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    stopSwtpm(name)
  }

  /**
   * FORCE KILL: the escape hatch behind "Force delete".
   *
   * A stuck install can leave a QEMU whose row is `installing` and whose pid
   * file is the ONLY handle on the process (the supervisor may have been
   * restarted, so `children` is empty). `kill()` sends the signal but cannot
   * say whether it worked — and the delete manifest MUST be able to say so,
   * because it decides whether the disk may be unlinked.
   *
   * So this waits, re-reads the pid file (QEMU may rewrite it) and reports the
   * truth: `qemuGone` / `swtpmGone` after `waitMs`. It never throws: a pid that
   * vanished between the two `process.kill` calls is `gone`, not a failure.
   */
  async function forceKill(target, { waitMs = 3000 } = {}) {
    const name = windowsRowName(target)
    const firstPid = qemuPid(name)
    kill(name)
    const deadline = Date.now() + Math.max(200, Number(waitMs) || 3000)
    let pid = firstPid
    while (Date.now() < deadline) {
      // The child we spawned is reaped asynchronously; the pid file is the
      // durable answer, and it may have been rewritten by a late QEMU start.
      const fromFile = qemuPid(name)
      if (fromFile > 0 && fromFile !== pid && pidAlive(fromFile)) {
        pid = fromFile
        try { process.kill(fromFile, 'SIGKILL') } catch {}
      }
      if (!pidAlive(pid) && !pidAlive(fromFile)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const finalPid = qemuPid(name) || pid
    const swtpmPid = (() => {
      try {
        const value = Number(readFileSync(pathsFor(name).tpmPid, 'utf8').trim())
        return Number.isFinite(value) && value > 0 ? value : 0
      } catch {
        return 0
      }
    })()
    return {
      pid: finalPid,
      qemuGone: !pidAlive(finalPid),
      swtpmPid,
      swtpmGone: !pidAlive(swtpmPid),
      detail: !pidAlive(finalPid)
        ? `QEMU (pid ${finalPid || 'none'}) is gone, swtpm is ${pidAlive(swtpmPid) ? `STILL RUNNING (pid ${swtpmPid})` : 'stopped'}`
        : `QEMU (pid ${finalPid}) is STILL RUNNING after SIGKILL`
    }
  }

  return {
    enabled: windowsEnabled,
    hostCaps: windowsHostCaps,
    paths: pathsFor,
    portsFor,
    qemuPid,
    pidAlive,
    childState,
    boot,
    probe,
    ready,
    qmpFor,
    screenshot,
    click,
    move,
    drag,
    sendKeys,
    pause,
    unpause,
    shutdown,
    installShutdownWindowMs,
    kill,
    forceKill,
    stopSwtpm
  }
}

/* ------------------------------------------------------------------ *
 * TCP banner probe (readiness, zero dependencies)
 * ------------------------------------------------------------------ */

/** The first bytes a service says, or null when nothing answers. */
export async function bannerProbe(host, port, { timeoutMs = 1500, readBytes = 32 } = {}) {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const socket = net.connect(port, host)
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try { socket.destroy() } catch {}
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => {
      // SSH speaks first; VNC's server also speaks first. Read the banner.
      socket.once('data', (chunk) => finish(chunk.subarray(0, readBytes).toString('latin1')))
    })
    socket.on('timeout', () => finish(null))
    socket.on('error', () => finish(null))
  })
}

/* ------------------------------------------------------------------ *
 * Keyboard mapping (ASCII only — a physical keyboard has no key for "é")
 * ------------------------------------------------------------------ */

const QCODE_PUNCT = {
  ' ': 'spc', '-': 'minus', '=': 'equal', '[': 'bracket_left', ']': 'bracket_right',
  '\\': 'backslash', ';': 'semicolon', "'": 'apostrophe', '`': 'grave_accent',
  ',': 'comma', '.': 'dot', '/': 'slash', '\n': 'ret', '\t': 'tab'
}

const QCODE_SHIFT = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8',
  '(': '9', ')': '0', '_': 'minus', '+': 'equal', '{': 'bracket_left', '}': 'bracket_right',
  '|': 'backslash', ':': 'semicolon', '"': 'apostrophe', '~': 'grave_accent',
  '<': 'comma', '>': 'dot', '?': 'slash'
}

const NAMED_KEYS = {
  enter: 'ret', return: 'ret', tab: 'tab', escape: 'esc', esc: 'esc', space: 'spc',
  backspace: 'backspace', delete: 'delete', del: 'delete', insert: 'insert',
  up: 'up', down: 'down', left: 'left', right: 'right',
  home: 'home', end: 'end', pageup: 'pgup', pagedown: 'pgdn',
  f1: 'f1', f2: 'f2', f3: 'f3', f4: 'f4', f5: 'f5', f6: 'f6',
  f7: 'f7', f8: 'f8', f9: 'f9', f10: 'f10', f11: 'f11', f12: 'f12'
}

export function charToKey(char) {
  if (Object.prototype.hasOwnProperty.call(QCODE_SHIFT, char)) return { qcode: QCODE_SHIFT[char], shift: true }
  if (Object.prototype.hasOwnProperty.call(QCODE_PUNCT, char)) return { qcode: QCODE_PUNCT[char], shift: false }
  if (/^[a-z0-9]$/u.test(char)) return { qcode: char, shift: false }
  if (/^[A-Z]$/u.test(char)) return { qcode: char.toLowerCase(), shift: true }
  return null
}

export function parseKeySpec(spec) {
  const text = String(spec ?? '').trim()
  if (text === '') throw new Error('key is required')
  const parts = text.split('+').filter((part) => part !== '')
  const base = parts.pop() ?? ''
  const modifiers = parts.map((part) => part.toLowerCase())
  const named = NAMED_KEYS[base.toLowerCase()]
  const character = named ? null : (base.length === 1 ? charToKey(base) : null)
  if (named === undefined && character === null) {
    throw new Error(`unsupported key for a Windows computer: ${spec} (ASCII keys and ${Object.keys(NAMED_KEYS).join('/')} only)`)
  }
  return {
    qcode: named ?? character.qcode,
    shift: character?.shift === true,
    ctrl: modifiers.includes('ctrl') || modifiers.includes('control'),
    alt: modifiers.includes('alt'),
    shiftModifier: modifiers.includes('shift')
  }
}

/** A generated Windows password: url/shell-safe, 20 chars, ~118 bits. */
export function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_'
  return Array.from(randomBytes(20), (byte) => alphabet[byte % alphabet.length]).join('')
}

/** The frame's own size: a QMP screendump IS the display, so scale is always 1. */
export function frameSpace(png) {
  const size = pngSize(png) ?? { width: 0, height: 0 }
  return {
    display: { width: size.width, height: size.height },
    screenshot: { width: size.width, height: size.height },
    scale: 1,
    source: 'qmp'
  }
}
