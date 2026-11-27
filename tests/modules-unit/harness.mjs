/**
 * harness.mjs — the shared probe for the per-unit suites.
 *
 * Extracted verbatim from tests/modules-unit.mjs (S3/O10): the imports, the
 * `check`/`checkContract` pair and the counters they write, plus the fixtures
 * (a real 1200x750 PNG, the tar builder) every suite imports. The counters are
 * exported as LIVE bindings, so the runner reads the final totals after the last
 * suite has run — exactly the numbers the single-file suite printed.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, accessSync, statSync, constants as fsConstants } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import {
  pngSize, formatSpace, formatSpaceWarning, spaceLine, relativeToPixels, toDisplayPixels, resolutionProblem, createSpace
} from '../../docker/cua-vm-space.mjs'
import {
  WINDOWS_VERSIONS, WINDOWS_CATALOG, WINDOWS_ISO_SOURCES, resolveWindowsIso, resolveWindowsIsoSources,
  canonicalWindowsVersion, windowsCapacityWarnings, windowsFirmwareProfile, windowsFirmwareForSpec, verifyIsoDigest,
  isoFileName, clipAckMatches, clipAckVerdict, clipSha256, ensureIso, qemuEscapeOptionValue,
  charToKey, parseKeySpec, generatePassword, windowsEnabled,
  buildQemuArgs, vncDisplayFor, vncPortFor, windowsPaths, frameSpace,
  OEM_PAYLOAD_FILES, OEM_PAYLOAD_REQUIRED, OEM_CLIP_AGENT_FILE, OEM_MCP_RELAY_FILE, OEM_GUARD_FILE, CLIP_AGENT_SENTINEL_FILE, SETUP_IMAGE_OPTIONAL, oemPayloadDir, oemPayloadDirStatus, oemPayloadDeniedDir, resolveOemSourceDir, writeOemPayload,
  oemPayloadMissingError, oemPayloadDeniedError, windowsKvmPreflight,
  SETUP_IMAGE_ENTRIES, SETUP_IMAGE_LABEL, buildSetupImage, verifySetupImage, answerFileDiskIds,
  assertAnswerFileTargetsSystemDisk, normaliseProductKey,
  SETUP_PARTITION_START_LBA, SETUP_PARTITION_OFFSET_BYTES, SETUP_PARTITION_TYPE, setupVolumeSpec,
  setupMbrSector, readSetupMbr, resolveWindowsImageSelection, imageInstallFromXml, assertAnswerFileSelectsImage,
  WINDOWS_IMAGE_SELECTIONS,
  formatWindowsInstallDetail, qmpStateLabel, endpointLabel, windowsTailLines, windowsPortsOf, windowsBootSpec,
  windowsReadinessSignals, qemuBootWindowMs, waitForQemuBoot,
  windowsRowName, windowsQmpAdapter, cdbootKeyScheduleMs, cdbootKeysEnabled, runCdbootKeys, cdbootPromptSeen, readSerialTail, startupNshText,
  cdbootPressFailure, cdbootPromptWindowMs, cdbootRearmCycles, cdbootRearmWatchMs, cdbootPressTimeoutMs,
  WINDOWS_SETUP_COPY_DONE_PATTERN, windowsSetupCopyFinished, windowsMediaEjectWatchMs,
  createWindowsBackend,
  // U4: the free-space probe's parser/formatter (pure), so the panel's number
  // and its below-floor warning are asserted without a guest.
  parseFreeSpaceProbe, formatWindowsFreeSpace, WINDOWS_FREE_FLOOR_GB,
  // F1: the SSH/VNC banner probe ITSELF — the one await that parked the install
  // watch for 79 minutes on 2026-11-21. Its contract (it answers on EVERY peer,
  // including the one that accepts and says nothing) is asserted below against
  // the real export, not against a copy of it.
  bannerProbe
} from '../../docker/cua-vm-windows-qemu.mjs'
import {
  KVM_GID_COMMAND, deviceNodePresent, formatKvmStatus, kvmDoctorFacts, kvmPreflightError, kvmStatus
} from '../../docker/cua-vm-kvm.mjs'
import {
  wsAccept, isClientCutText, parseClientCutText, serverCutTextFrame, encodeCutText,
  WS_SUBPROTOCOLS, selectSubprotocol, startClipboardBridge
} from '../../docker/cua-vnc-clip.mjs'
import {
  DEFAULT_SERVER_NAME, TOOL_PREFIX, REVEAL_TOOL_NAME, DOCTOR_TOOL_NAME,
  windowsToolName, windowsGuestToolName, sshArgv, SSH_KEEPALIVE,
  // J22-14: the interactive MCP relay's lane, probe and zero-SSH doctor facts.
  RELAY_COMMAND, RELAY_PORT_DEFAULT, RELAY_OK, RELAY_BAD, RELAY_DOWN, RELAY_PROBE_TTL_MS,
  // J22-14b: the `--ping` probe's 12 s wall and the upgrade watch that lets a
  // late-starting relay take over a live session-0 attach.
  RELAY_PROBE_TIMEOUT_MS, RELAY_UPGRADE_INTERVAL_MS, RELAY_UPGRADE_WATCH_MS, RELAY_UPGRADE_LOG,
  shouldUpgradeToRelay,
  // WP-2.1/2.3: the probe is an ORDERED CANDIDATE LIST (handshake first, the
  // legacy `--ping` last) and the payload skew has its OWN sentence.
  SESSION0_FALLBACK_REASON, SESSION0_SKEW_REASON, relayPort, relayProbeCommand, relayProbeCommands,
  createDshCuaClient
} from '../../plugins/dsh-cua-vm/win-mcp.js'

/**
 * THE SAME MODULE, UNDER A NAMESPACE. WP-4 lands `desktopFacts()` and WP-6.3
 * tests it; a NAMED import would make this whole file fail to LINK on a tree
 * where that export is absent, which would take 400 unrelated checks down with
 * it. The namespace keeps the file runnable and lets `checkContract` report the
 * missing contract as PENDING instead of an unhandled link error.
 */
import * as winMcpApi from '../../plugins/dsh-cua-vm/win-mcp.js'
// CUA-CLI: the Dockerfile's own `latest` resolution, run against a fixture. The
// import is the tool's pure half — its `--check` main is skipped because argv[1]
// is this file.
import {
  simulateResolution, readRunBlock, extractResolveFragment, cuaCliAssetUrl, RELEASES_API_URL
} from '../../tools/cua-cli-version.mjs'
// OPENCODE-CLI: the same treatment for the other CLI the Dockerfile resolves at
// build time. Aliased because both tools export a `readRunBlock` /
// `extractResolveFragment` pair and this file drives both.
import {
  simulateResolution as simulateOpencodeResolution,
  readRunBlock as readOpencodeRunBlock,
  extractResolveFragment as extractOpencodeResolveFragment,
  opencodeAssetUrl,
  versionFromTagName as opencodeVersionFromTagName,
  RELEASES_API_URL as OPENCODE_RELEASES_API_URL,
  PLUGIN_VERSION_FLOOR as OPENCODE_PLUGIN_FLOOR,
  SKIP_SENTINEL as OPENCODE_SKIP_SENTINEL,
  SKIP_ECHO as OPENCODE_SKIP_ECHO
} from '../../tools/check-opencode-cli.mjs'

/** The checkout root — the source of `docker/windows-oem/` in these tests. */
const REPO = path.resolve(import.meta.dirname, '..', '..')

let failures = 0
/** Checks whose production half has not landed yet (see `checkContract`). */
let pendings = 0
/** T2: a reverted production change must go RED, not "pending". */
const STRICT_CONTRACT = process.env.DSH_CUA_CONTRACT_STRICT === '1'
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}
/**
 * WP-6.3 — A CHECK THAT CAN ONLY PASS ONCE THE PRODUCTION HALF EXISTS.
 *
 * `landed` is the FEATURE's presence (an export, a field, a literal in the file
 * under test) — never the value being asserted. A missing feature is PENDING,
 * loudly; a present feature with the wrong value FAILS.
 * `DSH_CUA_CONTRACT_STRICT=1` requires them now (the T2 mutation check).
 */
const checkContract = (label, landed, ok, detail = '', expected = '') => {
  if (landed) { check(label, ok, detail); return }
  if (STRICT_CONTRACT) {
    failures += 1
    console.log(` FAIL  ${label} — contract absent and DSH_CUA_CONTRACT_STRICT=1${expected ? ` (${expected})` : ''}`)
    return
  }
  pendings += 1
  console.log(` PEND  ${label} — awaiting the production change${expected ? ` (${expected})` : ''}${detail ? ` — ${detail}` : ''}`)
}

/** Size in bytes, or -1 — used only to prove the sparse image was created. */
const statSyncSafe = (file) => { try { return statSync(file).size } catch { return -1 } }

/** A real 1200x750 PNG (IHDR + one IDAT + IEND), built with zlib only. */
function makePng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const crc32 = (buffer) => {
    let crc = 0xffffffff
    for (const byte of buffer) {
      crc ^= byte
      for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc((width * 3 + 1) * Math.min(height, 2))
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---- space: the PNG probe is the measurement, not a guess ----
const png = makePng(1200, 750)

export { CLIP_AGENT_SENTINEL_FILE, DEFAULT_SERVER_NAME, DOCTOR_TOOL_NAME, EventEmitter, KVM_GID_COMMAND, OEM_CLIP_AGENT_FILE, OEM_GUARD_FILE, OEM_MCP_RELAY_FILE, OEM_PAYLOAD_FILES, OEM_PAYLOAD_REQUIRED, OPENCODE_PLUGIN_FLOOR, OPENCODE_RELEASES_API_URL, OPENCODE_SKIP_ECHO, OPENCODE_SKIP_SENTINEL, RELAY_BAD, RELAY_COMMAND, RELAY_DOWN, RELAY_OK, RELAY_PORT_DEFAULT, RELAY_PROBE_TIMEOUT_MS, RELAY_PROBE_TTL_MS, RELAY_UPGRADE_INTERVAL_MS, RELAY_UPGRADE_LOG, RELAY_UPGRADE_WATCH_MS, RELEASES_API_URL, REPO, REVEAL_TOOL_NAME, SESSION0_FALLBACK_REASON, SESSION0_SKEW_REASON, SETUP_IMAGE_ENTRIES, SETUP_IMAGE_LABEL, SETUP_IMAGE_OPTIONAL, SETUP_PARTITION_OFFSET_BYTES, SETUP_PARTITION_START_LBA, SETUP_PARTITION_TYPE, SSH_KEEPALIVE, STRICT_CONTRACT, TOOL_PREFIX, WINDOWS_CATALOG, WINDOWS_FREE_FLOOR_GB, WINDOWS_IMAGE_SELECTIONS, WINDOWS_ISO_SOURCES, WINDOWS_SETUP_COPY_DONE_PATTERN, WINDOWS_VERSIONS, WS_SUBPROTOCOLS, accessSync, answerFileDiskIds, assertAnswerFileSelectsImage, assertAnswerFileTargetsSystemDisk, bannerProbe, buildQemuArgs, buildSetupImage, canonicalWindowsVersion, cdbootKeyScheduleMs, cdbootKeysEnabled, cdbootPressFailure, cdbootPressTimeoutMs, cdbootPromptSeen, cdbootPromptWindowMs, cdbootRearmCycles, cdbootRearmWatchMs, charToKey, check, checkContract, chmodSync, clipAckMatches, clipAckVerdict, clipSha256, createDshCuaClient, createSpace, createWindowsBackend, cuaCliAssetUrl, deviceNodePresent, encodeCutText, endpointLabel, ensureIso, existsSync, extractOpencodeResolveFragment, extractResolveFragment, failures, formatKvmStatus, formatSpace, formatSpaceWarning, formatWindowsFreeSpace, formatWindowsInstallDetail, frameSpace, fsConstants, generatePassword, http, imageInstallFromXml, isClientCutText, isoFileName, kvmDoctorFacts, kvmPreflightError, kvmStatus, makePng, mkdirSync, mkdtempSync, net, normaliseProductKey, oemPayloadDeniedDir, oemPayloadDeniedError, oemPayloadDir, oemPayloadDirStatus, oemPayloadMissingError, opencodeAssetUrl, opencodeVersionFromTagName, os, parseClientCutText, parseFreeSpaceProbe, parseKeySpec, path, pendings, png, pngSize, qemuBootWindowMs, qemuEscapeOptionValue, qmpStateLabel, readFileSync, readOpencodeRunBlock, readRunBlock, readSerialTail, readSetupMbr, relativeToPixels, relayPort, relayProbeCommand, relayProbeCommands, resolutionProblem, resolveOemSourceDir, resolveWindowsImageSelection, resolveWindowsIso, resolveWindowsIsoSources, rmSync, runCdbootKeys, selectSubprotocol, serverCutTextFrame, setupMbrSector, setupVolumeSpec, shouldUpgradeToRelay, simulateOpencodeResolution, simulateResolution, spaceLine, spawn, spawnSync, sshArgv, startClipboardBridge, startupNshText, statSync, statSyncSafe, toDisplayPixels, verifyIsoDigest, verifySetupImage, vncDisplayFor, vncPortFor, waitForQemuBoot, winMcpApi, windowsBootSpec, windowsCapacityWarnings, windowsEnabled, windowsFirmwareForSpec, windowsFirmwareProfile, windowsGuestToolName, windowsKvmPreflight, windowsMediaEjectWatchMs, windowsPaths, windowsPortsOf, windowsQmpAdapter, windowsReadinessSignals, windowsRowName, windowsSetupCopyFinished, windowsTailLines, windowsToolName, writeFileSync, writeOemPayload, wsAccept, zlib }
