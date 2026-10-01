/**
 * seek-harness recovery surface — the DSH-Desktop-style diagnostic screen.
 *
 * WHY THIS EXISTS
 * ---------------
 * When a profile cannot boot, the harness never starts — so no plugin inside it
 * can show anything. The one process that is always up is the reverse proxy, and
 * the one thing that always runs is the entrypoint. This module turns that into
 * the recovery assistant: a 1:1 recreation of the DSH Desktop (dsh-next) Recovery
 * Mode screen, served by the proxy while the harness itself is down (or while a
 * healthy harness could not compose its browser half).
 *
 * Tabs (mirroring dsh-plugin-desktop/src/native-ui/recovery/App.tsx):
 *   Quick recovery · Plugin management · Rollback · Switch Profile ·
 *   Reset & data · Diagnostics
 *
 * Deliberate Docker differences:
 *   - "Browse files" was REPLACED by a per-slot "Remove checkpoint" button
 *     (a Docker container has no folder GUI); "Change data directory" and
 *     "Open Profile folder" are disabled for the same reason; "Quit" is gone —
 *     the container restart policy owns the process lifecycle.
 * Safe Mode boots the harness with a THROWAWAY tmpfs DSH_HOME (the entrypoint
 * consumes the $DSH_HOME/.safe-mode-request flag), so existing profiles,
 * settings and sessions are untouched; only the DeepSeek API key credential is
 * carried over, and the temporary data disappears with the next restart.
 * Everything else works against the real filesystem: disable/enable/uninstall
 * plugins, restore checkpoints, switch/create profiles, factory reset, edit the
 * three configuration files, export the diagnostic archive.
 *
 * The state file is written by the entrypoint at each boot milestone:
 *   { state: 'starting' | 'ready' | 'degraded' | 'failed' | 'client-failed',
 *     reason, detail, profile, at, logTail }
 * Checkpoints are captured by the entrypoint on every healthy boot
 * (captureCheckpoint below) into $DSH_HOME/.recovery-checkpoints/slot-{1..3}.
 *
 * Zero npm dependencies, plain node:http handlers. The page is one file with
 * inline CSS/JS so it renders even when nothing else on the host works.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const LOCKED = new Set(['web'])
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/iu
const RESERVED = new Set(['node_modules', 'con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'lpt1', 'lpt2', 'lpt3'])
const SLOTS = ['slot-1', 'slot-2', 'slot-3']

const home = (env) => env.DSH_HOME ?? '/home/node/.dsh'
const profilesRoot = (env) => join(home(env), 'profiles')
const selectionFile = (env) => join(home(env), 'active-profile.json')
const labelsFile = (env) => join(home(env), 'profile-labels.json')
const orderFile = (env) => join(home(env), 'profile-order.json')
const stateFile = (env) => env.DSH_BOOT_STATE_FILE ?? '/tmp/dsh-boot.json'
const checkpointsRoot = (env) => join(home(env), '.recovery-checkpoints')
const dshVersion = () => {
  for (const file of ['/opt/dsh/.dsh-version', '/opt/dsh-src/.dsh-version']) {
    try { return readFileSync(file, 'utf8').trim() } catch { /* try next */ }
  }
  return null
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, file)
}

function bundlesOf(env, name) {
  const manifest = readJson(join(profilesRoot(env), name, 'package.json'))
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) && bundles.every((entry) => typeof entry === 'string') ? bundles : undefined
}

const webCapable = (bundles) => bundles !== undefined && WEB_BUNDLES.every((name) => bundles.includes(name))

function activeName(env) {
  const saved = readJson(selectionFile(env))
  return typeof saved?.active === 'string' ? saved.active : null
}

/** The profile everything plugin/config/checkpoint work targets. Never null:
 * the entrypoint falls back to `web` when no selection file exists, so the
 * recovery surface must do the same instead of crashing on a fresh volume. */
function currentProfile(env) {
  return activeName(env) ?? 'web'
}

function labels(env) {
  const saved = readJson(labelsFile(env))
  return saved !== null && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
}

/** The recorded boot outcome, with a conservative default. */
export function bootState(env = process.env) {
  const saved = readJson(stateFile(env))
  if (saved === null || typeof saved !== 'object') return { state: 'unknown', reason: null, detail: null, profile: null, at: null, logTail: null }
  return {
    state: typeof saved.state === 'string' ? saved.state : 'unknown',
    reason: typeof saved.reason === 'string' ? saved.reason : null,
    detail: typeof saved.detail === 'string' ? saved.detail : null,
    profile: typeof saved.profile === 'string' ? saved.profile : null,
    at: typeof saved.at === 'string' ? saved.at : null,
    logTail: typeof saved.logTail === 'string' ? saved.logTail : null,
  }
}

// ---------------------------------------------------------------------
// Plugin management — mirrors dsh-app-boot's readProfilePlugins semantics:
// a dependency is "enabled" iff its name is in dsh.profile.bundles.
// Disabling removes ONLY the bundles entry (the dependency, its version
// declaration and its configuration stay in the profile), which 0.1.7's
// reconciler preserves across boots.
// ---------------------------------------------------------------------

function pluginRows(env, profileName) {
  const dir = join(profilesRoot(env), profileName)
  const manifest = readJson(join(dir, 'package.json'))
  if (manifest === null || manifest === undefined || typeof manifest !== 'object') return undefined
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles.filter((n) => typeof n === 'string') : []
  const dependencies = manifest?.dependencies !== null && typeof manifest?.dependencies === 'object' && !Array.isArray(manifest.dependencies) ? manifest.dependencies : {}
  const rows = []
  const seen = new Set()
  const push = (name, owner) => {
    if (seen.has(name)) return
    seen.add(name)
    const installed = readJson(join(dir, 'node_modules', name, 'package.json'))
    rows.push({
      bundleId: name,
      packageName: name,
      version: typeof installed?.version === 'string' ? installed.version : null,
      status: bundles.includes(name) ? 'active' : 'disabled',
      owner,
      toggle: owner === 'core' ? null : (bundles.includes(name) ? 'disable' : 'enable'),
      action: owner === 'profile' ? 'uninstall' : null,
    })
  }
  for (const name of bundles) push(name, /^@deepseek-ai\//u.test(name) ? 'core' : (Object.hasOwn(dependencies, name) ? 'profile' : 'external'))
  for (const name of Object.keys(dependencies)) {
    if (!seen.has(name)) push(name, 'profile')
  }
  return rows
}

function writeProfileManifest(env, profileName, mutate) {
  const file = join(profilesRoot(env), profileName, 'package.json')
  const manifest = readJson(file)
  if (manifest === null || manifest === undefined) throw new Error(`profile "${profileName}" has no readable package.json`)
  mutate(manifest)
  if (!Array.isArray(manifest?.dsh?.profile?.bundles)) throw new Error('the manifest lost its bundle list — refusing to write')
  writeJsonAtomic(file, manifest)
  return manifest
}

function disablePlugin(env, name) {
  const profile = currentProfile(env)
  const manifest = writeProfileManifest(env, profile, (m) => {
    const bundles = m.dsh.profile.bundles
    const at = bundles.indexOf(name)
    if (at < 0) throw new Error(`plugin "${name}" is not loaded in the current profile`)
    bundles.splice(at, 1)
  })
  return { disabled: name, bundles: manifest.dsh.profile.bundles }
}

function enablePlugin(env, name) {
  const profile = currentProfile(env)
  const manifest = writeProfileManifest(env, profile, (m) => {
    if (!m.dsh.profile.bundles.includes(name)) m.dsh.profile.bundles.push(name)
  })
  return { enabled: name, bundles: manifest.dsh.profile.bundles }
}

function uninstallPlugin(env, name) {
  const profile = currentProfile(env)
  if (WEB_BUNDLES.includes(name) || /^@deepseek-ai\//u.test(name)) throw new Error(`"${name}" is part of the DSH installation and cannot be removed from a profile`)
  const manifest = writeProfileManifest(env, profile, (m) => {
    const bundles = m.dsh.profile.bundles
    const at = bundles.indexOf(name)
    if (at >= 0) bundles.splice(at, 1)
    if (manifest_dependencies_has(m, name)) delete m.dependencies[name]
  })
  return { uninstalled: name, bundles: manifest.dsh.profile.bundles }
}

const manifest_dependencies_has = (manifest, name) => (
  manifest.dependencies !== null && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies) && Object.hasOwn(manifest.dependencies, name)
)

// ---------------------------------------------------------------------
// Startup checkpoints — three rotating slots captured by the entrypoint on
// every healthy boot. Restoring copies the profile manifest, patch and the
// shared settings.yaml back into place.
// ---------------------------------------------------------------------

const checkpointFiles = [
  { from: (env) => join(profilesRoot(env), currentProfile(env), 'package.json'), to: 'profile/package.json' },
  { from: (env) => join(profilesRoot(env), currentProfile(env), 'cordis.patch.yml'), to: 'profile/cordis.patch.yml' },
  { from: (env) => join(profilesRoot(env), currentProfile(env), 'cordis.yml'), to: 'profile/cordis.yml' },
  { from: (env) => join(home(env), 'settings.yaml'), to: 'settings.yaml' },
]

/**
 * Capture the current configuration — dsh-next retention semantics:
 *   - exactly SLOTS.length slots, NO time-based expiry;
 *   - an empty slot is filled first, otherwise the OLDEST (by capturedAt) is
 *     overwritten;
 *   - the first healthy boot after a restore consumes a skip marker instead of
 *     a slot, so a restored checkpoint is not immediately displaced.
 * Safe to fail — never blocks the boot.
 */
export function captureCheckpoint(env = process.env) {
  try {
    const root = checkpointsRoot(env)
    // The skip marker written by restoreCheckpoint: preserve all slots once.
    const skipFile = join(root, '.skip-after-restore')
    if (existsSync(skipFile)) {
      const skip = readJson(skipFile)
      rmSync(skipFile, { force: true })
      return { skipped: true, restoredSlotId: typeof skip?.restoredSlotId === 'string' ? skip.restoredSlotId : null }
    }
    const profile = currentProfile(env)
    if (!existsSync(join(profilesRoot(env), profile, 'package.json'))) return null
    const source = (spec) => join(root, 'incoming', spec.to)
    rmSync(join(root, 'incoming'), { recursive: true, force: true })
    mkdirSync(join(root, 'incoming', 'profile'), { recursive: true })
    let fileCount = 0
    let totalBytes = 0
    for (const spec of checkpointFiles) {
      if (!existsSync(spec.from(env))) continue
      const from = spec.from(env)
      copyFileSync(from, source(spec))
      fileCount += 1
      totalBytes += statSync(from).size
    }
    if (fileCount === 0) return null
    const capturedAt = new Date().toISOString()
    writeFileSync(join(root, 'incoming', 'meta.json'), `${JSON.stringify({
      capturedAt,
      profile,
      appVersion: dshVersion(),
      fileCount,
      totalBytes,
    }, null, 2)}\n`)
    const rows = checkpointRows(env)
    const empty = rows.find((row) => row.status === 'empty')
    let target
    if (empty !== undefined) {
      target = empty.slotId
    } else {
      target = [...rows].sort((left, right) => {
        const leftTime = Date.parse(left.capturedAt ?? '') || 0
        const rightTime = Date.parse(right.capturedAt ?? '') || 0
        return leftTime - rightTime || left.slotId.localeCompare(right.slotId)
      })[0].slotId
    }
    rmSync(join(root, target), { recursive: true, force: true })
    renameSync(join(root, 'incoming'), join(root, target))
    return { slot: target, capturedAt }
  } catch (error) {
    console.log('[recovery] checkpoint capture failed:', error instanceof Error ? error.message : error)
    return null
  }
}

function checkpointRows(env) {
  const root = checkpointsRoot(env)
  return SLOTS.map((slotId) => {
    const meta = readJson(join(root, slotId, 'meta.json'))
    if (meta === null || meta === undefined || typeof meta !== 'object') {
      return { slotId, status: 'empty' }
    }
    return {
      slotId,
      status: 'available',
      capturedAt: typeof meta.capturedAt === 'string' ? meta.capturedAt : null,
      appVersion: typeof meta.appVersion === 'string' ? meta.appVersion : null,
      profile: typeof meta.profile === 'string' ? meta.profile : null,
      fileCount: typeof meta.fileCount === 'number' ? meta.fileCount : null,
      totalBytes: typeof meta.totalBytes === 'number' ? meta.totalBytes : null,
    }
  })
}

export function restoreCheckpoint(env, slotId) {
  if (!SLOTS.includes(slotId)) throw new Error(`unknown checkpoint slot: ${slotId}`)
  const root = join(checkpointsRoot(env), slotId)
  if (!existsSync(join(root, 'meta.json'))) throw new Error(`slot ${slotId} has no checkpoint to restore`)
  const meta = readJson(join(root, 'meta.json'))
  const profile = typeof meta?.profile === 'string' ? meta.profile : currentProfile(env)
  const profileDir = join(profilesRoot(env), profile)
  if (!existsSync(profileDir)) throw new Error(`the checkpointed profile "${profile}" no longer exists`)
  mkdirSync(join(profileDir), { recursive: true })
  const restored = []
  const copy = (from, to) => {
    if (!existsSync(from)) return
    copyFileSync(from, to)
    restored.push(to)
  }
  copy(join(root, 'profile/package.json'), join(profileDir, 'package.json'))
  copy(join(root, 'profile/cordis.patch.yml'), join(profileDir, 'cordis.patch.yml'))
  copy(join(root, 'profile/cordis.yml'), join(profileDir, 'cordis.yml'))
  copy(join(root, 'settings.yaml'), join(home(env), 'settings.yaml'))
  // dsh-next semantics: the first healthy start after a restore must NOT
  // consume a slot — otherwise the just-restored checkpoint would be rotated
  // out by the very boot that proves the restore worked.
  writeJsonAtomic(join(checkpointsRoot(env), '.skip-after-restore'), { version: 1, restoredSlotId: slotId })
  return { restored, slot: slotId }
}

export function removeCheckpoint(env, slotId) {
  if (!SLOTS.includes(slotId)) throw new Error(`unknown checkpoint slot: ${slotId}`)
  const root = join(checkpointsRoot(env), slotId)
  if (!existsSync(join(root, 'meta.json'))) throw new Error(`slot ${slotId} has no checkpoint to remove`)
  rmSync(root, { recursive: true, force: true })
  return { removed: slotId }
}

// ---------------------------------------------------------------------
// Profiles — the same model the in-app switcher uses, usable while the
// harness is down.
// ---------------------------------------------------------------------

function createProfile(env, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || RESERVED.has(name.toLowerCase())) {
    throw new Error(`invalid profile name: ${JSON.stringify(name)}`)
  }
  const target = join(profilesRoot(env), name)
  if (existsSync(join(target, 'package.json'))) throw new Error(`a profile named "${name}" already exists`)
  const source = join(profilesRoot(env), 'web')
  if (!existsSync(join(source, 'package.json'))) throw new Error('cannot create a profile: the shipped `web` profile is missing')
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    if (entry.isDirectory()) continue
    copyFileSync(join(source, entry.name), join(target, entry.name))
  }
  const manifestPath = join(target, 'package.json')
  const manifest = readJson(manifestPath) ?? {}
  manifest.name = `dsh-profile-${name}`
  manifest.private = true
  manifest.dependencies = {}
  manifest.dsh = { ...(manifest.dsh ?? {}), profile: { bundles: [...WEB_BUNDLES] } }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(target, 'cordis.patch.yml'), '# A new, empty profile: the shipped bundles only.\n[]\n')
  const order = (() => { const saved = readJson(orderFile(env)); return Array.isArray(saved) ? saved : [] })()
  if (!order.includes(name)) writeJsonAtomic(orderFile(env), [...order, name])
  return { created: name }
}

// ---------------------------------------------------------------------
// Factory reset — move the whole data directory aside (Docker has no
// Trash), preserve the shipped `web` profile, and let the next boot
// create a clean environment.
// ---------------------------------------------------------------------

function factoryReset(env) {
  const root = home(env)
  const webProfile = join(root, 'profiles', 'web')
  const keep = []
  if (existsSync(join(webProfile, 'package.json'))) {
    mkdirSync('/tmp/dsh-factory-keep/profiles/web', { recursive: true })
    for (const entry of readdirSync(webProfile, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.name.startsWith('.')) continue
      copyFileSync(join(webProfile, entry.name), join('/tmp/dsh-factory-keep/profiles/web', entry.name))
      keep.push(entry.name)
    }
  }
  const trash = `/tmp/dsh-factory-reset-${Date.now()}`
  renameSync(root, trash)
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
  for (const name of keep) copyFileSync(join('/tmp/dsh-factory-keep/profiles/web', name), join(root, 'profiles', 'web', name))
  rmSync('/tmp/dsh-factory-keep', { recursive: true, force: true })
  writeJsonAtomic(selectionFile(env), { version: 1, active: 'web' })
  return { trash, kept: keep }
}

// ---------------------------------------------------------------------
// Configuration files (Diagnostics tab). Keys, never raw paths — there is
// nothing here worth turning into a file server.
// ---------------------------------------------------------------------

const CONFIG_FILES = {
  settings: { label: 'settings.yaml', path: (env) => join(home(env), 'settings.yaml') },
  patch: { label: 'cordis.patch.yml', path: (env) => join(profilesRoot(env), currentProfile(env), 'cordis.patch.yml') },
  manifest: { label: 'package.json', path: (env) => join(profilesRoot(env), currentProfile(env), 'package.json') },
}

function readConfigFile(env, key) {
  const entry = CONFIG_FILES[key]
  if (entry === undefined) throw new Error(`unknown configuration file: ${key}`)
  const path = entry.path(env)
  return { key, label: entry.label, path, exists: existsSync(path), content: existsSync(path) ? readFileSync(path, 'utf8') : '' }
}

function saveConfigFile(env, key, content) {
  const entry = CONFIG_FILES[key]
  if (entry === undefined) throw new Error(`unknown configuration file: ${key}`)
  if (typeof content !== 'string') throw new Error('content must be a string')
  if (content.length > 1_000_000) throw new Error('file too large to save through the recovery surface')
  if (key === 'manifest') {
    try { JSON.parse(content) } catch { throw new Error('the manifest is not valid JSON — fix it before saving') }
  }
  const path = entry.path(env)
  mkdirSync(join(path, '..'), { recursive: true })
  const temporary = `${path}.recovery-tmp`
  writeFileSync(temporary, content)
  renameSync(temporary, path)
  return { saved: path, bytes: Buffer.byteLength(content) }
}

/** Everything the recovery page and the in-app panel need. */
export function recoverySnapshot(env = process.env) {
  const root = profilesRoot(env)
  const active = activeName(env)
  const names = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== 'node_modules').map((entry) => entry.name)
    : []
  const order = (() => { const saved = readJson(orderFile(env)); return Array.isArray(saved) ? saved : [] })()
  const rank = new Map(order.map((name, index) => [name, index]))
  const labelMap = labels(env)
  const profiles = names.map((name) => {
    const bundles = bundlesOf(env, name)
    return {
      name,
      label: typeof labelMap[name] === 'string' ? labelMap[name] : null,
      bundleCount: bundles?.length ?? 0,
      webCapable: webCapable(bundles),
      active: name === active,
      locked: LOCKED.has(name),
    }
  }).sort((a, b) => {
    const ra = rank.get(a.name)
    const rb = rank.get(b.name)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.name.localeCompare(b.name)
  })
  const boot = bootState(env)
  return {
    home: home(env),
    active,
    version: dshVersion(),
    profiles,
    boot,
    plugins: active === null ? undefined : pluginRows(env, active),
    checkpoints: checkpointRows(env),
    profileDirectory: join(root, currentProfile(env)),
    dataDirectory: home(env),
  }
}

// ---------------------------------------------------------------------
// The diagnostic archive — a single text file a user can hand to an agent.
// ---------------------------------------------------------------------

function diagnosticArchive(env) {
  const snapshot = recoverySnapshot(env)
  const lines = [
    'seek-harness diagnostic archive',
    'generated: ' + new Date().toISOString(),
    'dsh version: ' + (snapshot.version ?? 'unknown'),
    'data directory: ' + snapshot.dataDirectory,
    'state: ' + snapshot.boot.state,
    'profile: ' + (snapshot.boot.profile ?? '(unknown)'),
    'active profile: ' + (snapshot.active ?? '(unknown)'),
    'reason: ' + (snapshot.boot.reason ?? '(none)'),
    'detail: ' + (snapshot.boot.detail ?? '(none)'),
    '',
    '== profiles ==',
    ...snapshot.profiles.map((p) => `  - ${p.name}${p.active ? ' (current)' : ''} [${p.bundleCount} bundles${p.webCapable ? '' : ', NOT web-capable'}]`),
    '',
    '== plugins of the current profile ==',
    ...(snapshot.plugins ?? []).map((p) => `  - ${p.packageName} ${p.version ?? ''} [${p.status}, ${p.owner}]`),
    '',
    '== checkpoints ==',
    ...snapshot.checkpoints.map((c) => `  - ${c.slotId}: ${c.status === 'empty' ? 'empty' : `${c.capturedAt} (${c.fileCount} files, ${c.totalBytes} bytes)`}`),
    '',
    '== configuration files ==',
  ]
  for (const key of Object.keys(CONFIG_FILES)) {
    const file = readConfigFile(env, key)
    lines.push(`--- ${file.label} (${file.path})${file.exists ? '' : ' — not created yet'} ---`)
    lines.push(file.exists ? file.content : '(absent)')
    lines.push('')
  }
  lines.push('== boot log tail ==')
  lines.push(snapshot.boot.logTail ?? '(no log tail was recorded for this boot)')
  return lines.join('\n')
}

/** Write the selection the entrypoint reads at boot. Refuses a non-web profile. */
export function selectProfile(env, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || RESERVED.has(name.toLowerCase())) {
    throw new Error(`invalid profile name: ${JSON.stringify(name)}`)
  }
  const bundles = bundlesOf(env, name)
  if (bundles === undefined) throw new Error(`profile "${name}" has no readable package.json`)
  if (!webCapable(bundles)) throw new Error(`profile "${name}" cannot boot the Web app (needs ${WEB_BUNDLES.join(' + ')})`)
  mkdirSync(home(env), { recursive: true })
  writeJsonAtomic(selectionFile(env), { version: 1, active: name })
  return { active: name }
}

/** Safe Mode: request a temporary-environment boot. The flag lives in the REAL
 * home (the proxy's env never points at the temp home), the entrypoint consumes
 * it at the next boot and starts the harness with a throwaway tmpfs DSH_HOME.
 * Nothing else is written — the real home stays untouched. */
export function requestSafeMode(env = process.env) {
  const flag = join(home(env), '.safe-mode-request')
  mkdirSync(home(env), { recursive: true })
  writeJsonAtomic(flag, { version: 1, at: new Date().toISOString() })
  return { safeModeRequested: true }
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/gu, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
))

// ---------------------------------------------------------------------
// The page — one HTML document, inline CSS/JS, no build step.
// ---------------------------------------------------------------------

const ICONS = {
  lifebuoy: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="m4.9 4.9 4.2 4.2"/><path d="m19.1 4.9-4.2 4.2"/><path d="m4.9 19.1 4.2-4.2"/><path d="m19.1 19.1-4.2-4.2"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'hard-drive': '<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>',
  stethoscope: '<path d="M11 2v2"/><path d="M5 2v2"/><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/><path d="M8 15a6 6 0 0 0 12 0v-3"/><circle cx="20" cy="10" r="2"/>',
  'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  'circle-help': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  'power-off': '<path d="M18.36 6.25a9 9 0 1 1-12.72.04"/><path d="M12 2v10"/><line x1="2" x2="22" y1="2" y2="22"/>',
  'package-x': '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/><path d="m17 13-5 5"/><path d="m12 13 5 5"/>',
  'folder-open': '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  'trash-2': '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  'file-pen': '<path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10.4 12.6a2 2 0 1 1 3 3L8 21l-4 1 1-4Z"/>',
  'folder-input': '<path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"/><path d="M12 10v6"/><path d="m9 13 3 3 3-3"/>',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
}

const icon = (name, size = 16) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`

/** The standalone recovery page: no build step, no external asset. */
export function recoveryPage(snapshot) {
  const { boot, profiles, active, safeProfile, version, profileDirectory, dataDirectory } = snapshot
  // JSON lives inside a raw-text <script> element: HTML entities are NOT decoded
  // there, so escape only characters that could terminate the script tag.
  const bootData = JSON.stringify(snapshot)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  const manual = !(boot.state === 'failed' || boot.state === 'degraded' || boot.state === 'client-failed')
  const hasProfiles = profiles.some((profile) => !profile.active)

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH — Recovery Mode</title>
<style>
  :root{color-scheme:dark;--bg:#0e0f12;--fg:#e8eaed;--muted:#9aa3ad;--card:#17181d;--card2:#1d1f25;--line:#2c2f36;--line2:#3a3e47;--err:#f28b82;--warn:#e8c268;--warn-bg:#2b230a;--warn-line:#6b5514;--danger:#f28b82;--ok:#81c995}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  a{color:var(--fg)}
  .wrap{max-width:960px;margin:0 auto;padding:20px 16px 90px}
  .banner{border:1px solid var(--warn-line);background:var(--warn-bg);color:var(--warn);border-radius:10px;padding:12px 16px;font-size:12.5px;line-height:1.5;margin-bottom:18px}
  .banner a{color:var(--warn)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;margin-bottom:16px;overflow:hidden}
  .card.reason{border-color:var(--line2)}
  .card-head{padding:16px 20px 4px}
  .card-title{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600;margin:0}
  .card-title .ic{color:var(--muted)}
  .card-desc{color:var(--muted);font-size:13px;margin:6px 0 0}
  .card-body{padding:12px 20px 16px}
  .card-foot{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:12px 20px 16px}
  .card-foot.top{border-top:1px solid var(--line)}
  .pills{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .pill{background:var(--card2);border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--muted);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
  .pill code{font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted)}
  h2.line{font-size:14.5px;font-weight:600;margin:8px 0 2px}
  .muted{color:var(--muted)}
  .small{font-size:12.5px}
  pre{margin:0;padding:12px;border-radius:10px;background:var(--card2);border:1px solid var(--line);overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
  pre.log{max-height:280px}
  .facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin:14px 0 4px}
  .fact{background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
  .fact dt{font-size:11.5px;color:var(--muted)}
  .fact dd{margin:4px 0 0;font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tabs{display:flex;gap:4px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px;margin-bottom:16px;overflow-x:auto}
  .tab{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:9px 14px;border:0;border-radius:9px;background:transparent;color:var(--muted);font:inherit;font-size:13.5px;cursor:pointer;white-space:nowrap}
  .tab:hover{color:var(--fg);background:rgba(255,255,255,.04)}
  .tab[aria-selected="true"]{background:var(--card2);color:var(--fg);font-weight:600}
  .tab .ic{width:15px;height:15px}
  .pane{display:none}
  .pane.active{display:block}
  button.btn{display:inline-flex;align-items:center;gap:8px;font:inherit;font-size:13px;font-weight:500;min-height:36px;padding:7px 14px;border-radius:9px;border:1px solid var(--line2);background:var(--card2);color:var(--fg);cursor:pointer}
  button.btn:hover:not(:disabled){background:#25272e}
  button.btn:disabled{opacity:.38;cursor:not-allowed}
  button.btn.primary{background:#f2f3f5;border-color:#f2f3f5;color:#101114}
  button.btn.primary:hover:not(:disabled){background:#e2e4e8}
  button.btn.destructive{color:var(--danger);border-color:rgba(242,139,130,.35);background:rgba(242,139,130,.08)}
  button.btn.destructive:hover:not(:disabled){background:rgba(242,139,130,.16)}
  button.btn .ic{width:15px;height:15px}
  .rows{border-top:1px solid var(--line)}
  .row{display:flex;align-items:center;gap:14px;justify-content:space-between;padding:13px 20px;border-bottom:1px solid var(--line)}
  .row:last-child{border-bottom:0}
  .who{min-width:0}
  .who .name{font-weight:600;font-size:13.5px;overflow-wrap:anywhere}
  .who .meta{color:var(--muted);font-size:12px;margin-top:2px}
  .row-actions{display:flex;gap:8px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
  .badge{background:var(--card2);border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--muted);white-space:nowrap}
  .empty{padding:18px 20px;color:var(--muted);font-size:13px}
  .footbar{position:fixed;left:0;right:0;bottom:0;background:linear-gradient(transparent,var(--bg) 30%);padding:14px 16px 16px;display:flex;justify-content:flex-end;align-items:center;gap:10px;z-index:40}
  .footbar .spacer{margin-right:auto}
  .footbar a.escape{color:var(--muted);font-size:12.5px}
  .modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:100;padding:16px}
  .modal-backdrop.open{display:flex}
  .modal{background:var(--card);border:1px solid var(--line2);border-radius:14px;max-width:460px;width:100%;padding:20px;box-shadow:0 18px 50px rgba(0,0,0,.5)}
  .modal h3{margin:0 0 8px;font-size:15px}
  .modal p{margin:0 0 14px;color:var(--muted);font-size:13px;white-space:pre-wrap;word-break:break-word}
  .modal .actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
  .modal input{width:100%;font:inherit;font-size:13.5px;background:var(--card2);border:1px solid var(--line2);color:var(--fg);border-radius:9px;padding:9px 12px;margin-bottom:14px}
  .modal textarea{width:100%;min-height:46vh;font:12.5px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--card2);border:1px solid var(--line2);color:var(--fg);border-radius:10px;padding:12px;resize:vertical;white-space:pre;overflow:auto}
  .modal .filepath{font:11.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted);margin-bottom:8px;word-break:break-all}
  .notice{min-height:1.3em;color:var(--muted);font-size:12.5px;margin-top:10px}
  .busy-note{display:none;align-items:center;gap:8px;color:var(--muted);font-size:13px}
  .spin{animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  body.busy main{opacity:.6;pointer-events:none}
  @media (max-width:640px){
    .row{flex-direction:column;align-items:stretch}
    .row-actions{justify-content:flex-start}
    .card-foot{flex-direction:column}
    .card-foot button{width:100%;justify-content:center}
    .footbar{flex-wrap:wrap}
  }
</style></head><body>
<main>
<div class="wrap">
  <div class="banner">When reporting a problem, include the full error below and relevant logs from Diagnostics, not just the last line. Review and redact API keys, tokens and other sensitive information before sharing. <a href="https://github.com/yakuza8702/docker-deepseek-harness-profile/issues" target="_blank" rel="noopener">Contact us</a></div>

  <div class="card reason">
    <div class="card-head">
      <div class="pills">
        ${icon('lifebuoy', 18)}
        <h2 class="line">Why Recovery Mode opened</h2>
        <span class="pill">Current Profile: <code>${escapeHtml(active ?? 'unknown')}</code></span>
        <span class="pill">Profile folder: <code>${escapeHtml(profileDirectory ?? 'unknown')}</code></span>
      </div>
      ${manual
        ? '<p class="card-desc" style="font-weight:600;color:var(--fg);margin-top:8px">Recovery Mode opened manually</p><p class="card-desc">Normal startup is paused. The current Profile and plugins have not loaded.</p>'
        : `<p class="card-desc" style="color:var(--err);margin-top:8px">${escapeHtml(boot.reason ?? 'Startup failed')}</p>`}
    </div>
    ${manual ? '' : `<div class="card-body"><pre>${escapeHtml([boot.detail, 'state: ' + boot.state + (boot.profile ? ' · profile: ' + boot.profile : '') + (boot.at ? ' · at: ' + boot.at : '')].filter(Boolean).join('\n'))}</pre></div>`}
  </div>

  <div class="tabs" role="tablist">
    <button class="tab" role="tab" data-tab="quick" aria-selected="true">${icon('lifebuoy')}Quick recovery</button>
    <button class="tab" role="tab" data-tab="plugins" aria-selected="false">${icon('plug')}Plugin management</button>
    <button class="tab" role="tab" data-tab="rollback" aria-selected="false">${icon('history')}Rollback</button>
    <button class="tab" role="tab" data-tab="profiles" aria-selected="false">${icon('users')}Switch Profile</button>
    <button class="tab" role="tab" data-tab="data" aria-selected="false">${icon('hard-drive')}Reset &amp; data</button>
    <button class="tab" role="tab" data-tab="diagnostics" aria-selected="false">${icon('stethoscope')}Diagnostics</button>
  </div>

  <section class="pane active" id="pane-quick">
    <div class="card">
      <div class="card-head">
        <h3 class="card-title">${icon('circle-help', 18)}Quick recovery</h3>
        <p class="card-desc">Choose a recovery option for the problem. If the cause is unclear, try Safe Mode first. If you already have a clue, go directly to plugins, checkpoints, or Profiles.</p>
      </div>
    </div>
    <div class="card">
      <div class="card-head">
        <h3 class="card-title">${icon('shield-check', 18)}Safe Mode</h3>
        <p class="card-desc">Use a temporary environment without the original plugins, patches, settings or conversations. Only the official DeepSeek API key, if you saved one, is carried over. The temporary data is removed on the next normal startup.</p>
      </div>
      <div class="card-foot"><button class="btn primary" id="safe">${icon('shield-check')}Enter Safe Mode</button></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h3 class="card-title">${icon('plug', 18)}Plugin management</h3>
        <p class="card-desc">Problems after installing or updating a plugin? Review plugins in the current Profile and uninstall third-party plugins that may be involved.</p>
      </div>
      <div class="card-foot"><button class="btn goto" data-goto="plugins">Manage plugins</button></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h3 class="card-title">${icon('history', 18)}Rollback</h3>
        <p class="card-desc">Unable to start after a configuration change? Choose a startup checkpoint from before the failure, then preview and restore its configuration.</p>
      </div>
      <div class="card-foot"><button class="btn goto" data-goto="rollback">View checkpoints</button></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h3 class="card-title">${icon('users', 18)}Switch Profile</h3>
        <p class="card-desc">Need to get back to work? Switch to another Profile or create a new configuration environment. The current Profile is kept for later investigation.</p>
      </div>
      <div class="card-foot"><button class="btn goto" data-goto="profiles">Switch Profile</button></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h3 class="card-title">${icon('hard-drive', 18)}Reset &amp; data</h3>
        <p class="card-desc">View or change the DSH data directory. A factory reset removes data from the current directory, so try other recovery options first.</p>
      </div>
      <div class="card-foot"><button class="btn goto" data-goto="data">Manage data</button></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h3 class="card-title">${icon('stethoscope', 18)}Diagnostics</h3>
        <p class="card-desc">View configuration files or export a diagnostic archive to investigate. Review the archive before sharing it.</p>
      </div>
      <div class="card-foot"><button class="btn goto" data-goto="diagnostics">View diagnostics</button></div>
    </div>
  </section>

  <section class="pane" id="pane-plugins">
    <div class="card">
      <div class="card-head">
        <h3 class="card-title">Plugin management</h3>
        <p class="card-desc">View plugins installed directly in the current Profile. Disable a plugin to keep it installed without loading it, or uninstall it completely.</p>
      </div>
      <div class="rows" id="plugin-rows"></div>
      <div class="notice" id="plugins-note"></div>
    </div>
  </section>

  <section class="pane" id="pane-rollback">
    <div id="checkpoint-cards"></div>
  </section>

  <section class="pane" id="pane-profiles">
    <div class="card">
      <div class="card-head">
        <h3 class="card-title">Available Profiles</h3>
        <p class="card-desc">Switch to another Desktop-compatible Profile or create a new one.</p>
      </div>
      <div class="rows" id="profile-rows"></div>
      ${hasProfiles ? '' : `<div class="empty">No other Desktop-compatible Profiles are available.</div>`}
      <div class="card-foot">
        <button class="btn primary" id="new-profile">${icon('plus')}New Profile</button>
      </div>
      <div class="notice" id="profiles-note"></div>
    </div>
  </section>

  <section class="pane" id="pane-data">
    <div class="card">
      <div class="card-head">
        <h3 class="card-title">${icon('hard-drive', 18)}Data management</h3>
        <p class="card-desc">View or change the DSH data directory, which stores Profiles, plugins, settings, and conversations. Changing the directory does not delete data in the previous location.</p>
      </div>
      <div class="card-body">
        <p class="small muted" style="margin:0 0 6px">Current data directory</p>
        <pre style="max-height:none">${escapeHtml(dataDirectory ?? '')}</pre>
      </div>
      <div class="card-foot">
        <button class="btn" disabled title="Not available in the Docker environment — there is no folder GUI. Change it via the compose volume instead.">${icon('folder-input')}Change data directory</button>
      </div>
    </div>
    <div class="card" style="border-color:rgba(242,139,130,.4)">
      <div class="card-head">
        <h3 class="card-title" style="color:var(--danger)">${icon('trash-2', 18)}Factory reset</h3>
        <p class="card-desc">Move the current DSH data directory aside, then restart and create a new default Profile. Project files outside this directory are kept.</p>
      </div>
      <div class="card-foot"><button class="btn destructive" id="factory-reset">${icon('trash-2')}Reset data and restart</button></div>
    </div>
  </section>

  <section class="pane" id="pane-diagnostics">
    <div class="card">
      <div class="card-head">
        <h3 class="card-title">Diagnostic archive</h3>
        <p class="card-desc">Export diagnostics</p>
      </div>
      <div class="card-body">
        <p class="small muted" style="margin:0 0 8px">The archive may contain local paths, logs, system information, and crash-memory fragments. Review it before sharing.</p>
        <pre class="log" id="log">${escapeHtml(boot.logTail ?? 'No log tail was recorded for this boot.')}</pre>
      </div>
      <div class="card-foot">
        <button class="btn" id="copy-report">${icon('archive')}Copy report</button>
        <button class="btn primary" id="export-report">${icon('archive')}Export diagnostics</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head">
        <h3 class="card-title">Configuration files</h3>
        <p class="card-desc">View or edit the current Profile configuration and shared configuration in the DSH data directory. Restart the app to apply changes.</p>
      </div>
      <div class="card-foot" style="justify-content:flex-start">
        <button class="btn" data-edit="settings">${icon('file-pen')}Open settings.yaml</button>
        <button class="btn" data-edit="patch">${icon('file-pen')}Edit Profile patch</button>
        <button class="btn" data-edit="manifest">${icon('file-pen')}Edit plugin manifest</button>
      </div>
    </div>
  </section>
</div>
</main>

<div class="footbar">
  <span class="spacer"><a class="escape" href="/?skipRecovery=1">Open the main page anyway</a></span>
  <button class="btn primary" id="restart">${icon('refresh-cw')}Quit and restart</button>
</div>

<div class="modal-backdrop" id="modal-backdrop">
  <div class="modal" role="dialog" aria-modal="true">
    <div id="modal-confirm-view">
      <h3 id="modal-title"></h3>
      <p id="modal-body"></p>
      <div class="actions">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn primary" id="modal-ok"></button>
      </div>
    </div>
    <div id="modal-edit-view" style="display:none">
      <h3 id="edit-title">Edit file</h3>
      <div class="filepath" id="edit-path"></div>
      <textarea id="edit-area" spellcheck="false"></textarea>
      <div class="actions" style="margin-top:12px">
        <button class="btn" id="edit-cancel">Cancel</button>
        <button class="btn primary" id="edit-save">Save</button>
      </div>
    </div>
    <div id="modal-newprofile-view" style="display:none">
      <h3>Create a new Profile</h3>
      <p>Name of the new Profile folder (lowercase letters, digits, dashes). It starts from the shipped <code>web</code> bundles.</p>
      <input id="newprofile-name" maxlength="64" autocomplete="off" placeholder="my-profile">
      <div class="actions">
        <button class="btn" id="newprofile-cancel">Cancel</button>
        <button class="btn primary" id="newprofile-ok">Create Profile</button>
      </div>
    </div>
  </div>
</div>

<script type="application/json" id="bootdata">${bootData}</script>
<script>
  var BOOT = JSON.parse(document.getElementById('bootdata').textContent);
  var noteTimers = {};
  function note(id, text) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    if (noteTimers[id]) clearTimeout(noteTimers[id]);
    if (text) noteTimers[id] = setTimeout(function(){ el.textContent = ''; }, 12000);
  }
  function post(path, payload) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) })
      .then(function (r) { return r.json().then(function (d) { if (r.ok !== true || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
  }
  function waitAndReload() {
    noteBusy('restarting… the page reloads when the harness answers');
    var sawDown = false;
    var tick = function (i) {
      if (i > 240) { noteBusy('gave up waiting after 4 minutes — check the container log'); return; }
      setTimeout(function () {
        fetch('/__recovery/state', { headers: { accept: 'application/json' }, cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.ready !== true) { sawDown = true; noteBusy('harness is restarting…'); tick(i + 1); return; }
            if (!sawDown && i < 8) { noteBusy('waiting for the harness to restart…'); tick(i + 1); return; }
            setTimeout(function(){ window.location.replace('/'); }, 1500);
          })
          .catch(function () { sawDown = true; noteBusy('harness is restarting…'); tick(i + 1); });
      }, 1000);
    };
    tick(0);
  }
  function noteBusy(text) {
    var el = document.getElementById('busy-note');
    if (el) el.textContent = text;
    document.body.classList.add('busy');
  }
  function clearBusy() {
    document.body.classList.remove('busy');
    var el = document.getElementById('busy-note');
    if (el) el.textContent = '';
  }

  // ---- tabs -----------------------------------------------------------
  function openTab(name) {
    document.querySelectorAll('.tab').forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.tab === name)); });
    document.querySelectorAll('.pane').forEach(function (p) { p.classList.toggle('active', p.id === 'pane-' + name); });
  }
  document.querySelectorAll('.tab').forEach(function (t) { t.addEventListener('click', function () { openTab(t.dataset.tab); }); });
  document.querySelectorAll('.goto').forEach(function (b) { b.addEventListener('click', function () { openTab(b.dataset.goto); }); });

  // ---- modal ----------------------------------------------------------
  var backdrop = document.getElementById('modal-backdrop');
  var views = { confirm: 'modal-confirm-view', edit: 'modal-edit-view', newprofile: 'modal-newprofile-view' };
  var confirmOk = null;
  function showView(name) {
    Object.keys(views).forEach(function (k) { document.getElementById(views[k]).style.display = k === name ? '' : 'none'; });
    backdrop.classList.add('open');
  }
  function closeModal() { backdrop.classList.remove('open'); confirmOk = null; }
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('edit-cancel').addEventListener('click', closeModal);
  document.getElementById('newprofile-cancel').addEventListener('click', closeModal);
  backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  document.getElementById('modal-ok').addEventListener('click', function () { if (confirmOk) confirmOk(); });

  function ask(title, body, okLabel, danger, fn) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').textContent = body;
    var ok = document.getElementById('modal-ok');
    ok.textContent = okLabel;
    ok.className = danger ? 'btn destructive' : 'btn primary';
    confirmOk = function () { closeModal(); fn(); };
    showView('confirm');
  }

  function run(label, promise, after) {
    noteBusy(label);
    promise.then(function (result) { clearBusy(); if (after) after(result); })
      .catch(function (error) { clearBusy(); ask('Action failed', String(error.message || error), 'Close', false, function () {}); });
  }

  // Re-pull the snapshot after a mutating action so re-renders show the real
  // state, not the copy embedded at page load.
  function refreshState(after) {
    fetch('/__recovery/state', { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        BOOT.plugins = data.plugins; BOOT.profiles = data.profiles; BOOT.checkpoints = data.checkpoints;
        BOOT.active = data.active; BOOT.boot = data.boot;
        renderPlugins(); renderProfiles(); renderCheckpoints();
        if (after) after();
      })
      .catch(function () { if (after) after(); });
  }

  // ---- plugin management ----------------------------------------------
  function renderPlugins() {
    var wrap = document.getElementById('plugin-rows');
    var rows = BOOT.plugins || [];
    if (rows.length === 0) { wrap.innerHTML = '<div class="empty">No plugins were found in the current Profile.</div>'; return; }
    wrap.innerHTML = rows.map(function (p) {
      var meta = p.status === 'disabled' ? 'Still installed, not loaded' : (p.owner === 'core' ? 'Built in' : (p.owner === 'profile' ? 'Directly installed plugin' : 'Not directly removable'));
      var buttons = '';
      if (p.status === 'disabled') buttons += '<button class="btn" disabled title="This plugin is disabled — it is still installed, but the harness will not load it.">Disabled</button>';
      if (p.toggle === 'disable') buttons += '<button class="btn" data-act="disable" data-name="' + p.packageName.replace(/"/g, '&quot;') + '"><svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18.36 6.25a9 9 0 1 1-12.72.04"/><path d="M12 2v10"/><line x1="2" x2="22" y1="2" y2="22"/></svg>Disable</button>';
      if (p.toggle === 'enable') buttons += '<button class="btn primary" data-act="enable" data-name="' + p.packageName.replace(/"/g, '&quot;') + '"><svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/></svg>Enable</button>';
      if (p.action === 'uninstall') buttons += '<button class="btn destructive" data-act="uninstall" data-name="' + p.packageName.replace(/"/g, '&quot;') + '">Uninstall</button>';
      return '<div class="row"><div class="who"><div class="name">' + p.packageName + '</div><div class="meta">' + meta + (p.version ? ' · v' + p.version : '') + '</div></div><div class="row-actions">' + buttons + '</div></div>';
    }).join('');
    wrap.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () { pluginAction(b.dataset.act, b.dataset.name); });
    });
  }
  function pluginAction(act, name) {
    if (act === 'disable') {
      ask('Disable this plugin?', 'Nothing is deleted. The plugin, its version declaration and its configuration all stay in the current Profile — the harness simply will not load it on the next start. You can enable it again here at any time.', 'Disable plugin', false, function () {
        run('Disabling ' + name + '…', post('/__recovery/plugin/disable', { name: name }), function () { refreshState(function () { ask('Plugin disabled', 'The plugin is disabled and still installed. Restart the harness to start without it; nothing was removed from the Profile.', 'Quit and restart', false, function () { post('/__recovery/restart', {}); waitAndReload(); }); }); });
      });
    } else if (act === 'enable') {
      ask('Enable this plugin?', 'The harness will load this plugin again on the next start. If this plugin caused the startup failure, the recovery assistant will open again and you can disable it once more.', 'Enable plugin', false, function () {
        run('Enabling ' + name + '…', post('/__recovery/plugin/enable', { name: name }), function () { refreshState(function () { ask('Plugin enabled', 'The plugin is enabled again. Restart the harness to load it.', 'Quit and restart', false, function () { post('/__recovery/restart', {}); waitAndReload(); }); }); });
      });
    } else if (act === 'uninstall') {
      ask('Uninstall this plugin?', 'Uninstall this plugin from the current Profile and update plugin dependencies. The files in the profile store are pruned on the next plugin operation.', 'Uninstall', true, function () {
        run('Uninstalling ' + name + '…', post('/__recovery/plugin/uninstall', { name: name }), function () { refreshState(function () { ask('Plugin uninstalled', 'The plugin was removed from the current Profile. Restart the harness to use the updated plugin configuration.', 'Quit and restart', false, function () { post('/__recovery/restart', {}); waitAndReload(); }); }); });
      });
    }
  }
  renderPlugins();

  // ---- rollback --------------------------------------------------------
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB']; var v = bytes / 1024; var u = units[0];
    for (var i = 1; v >= 1024 && i < units.length; i++) { v /= 1024; u = units[i]; }
    return (Math.round(v * 10) / 10) + ' ' + u;
  }
  function renderCheckpoints() {
    var wrap = document.getElementById('checkpoint-cards');
    wrap.innerHTML = (BOOT.checkpoints || []).map(function (c) {
      var slot = c.slotId.slice(-1);
      var empty = c.status === 'empty';
      var when = empty ? 'No configuration from a successful startup has been saved here yet.' : new Date(c.capturedAt).toLocaleString();
      var badge = empty ? 'No checkpoint yet' : 'Ready to restore';
      var facts = empty ? '' : '<dl class="facts">' +
        '<div class="fact"><dt>DSH Desktop version</dt><dd>' + (c.appVersion || 'Unknown') + '</dd></div>' +
        '<div class="fact"><dt>Configuration files</dt><dd>' + (c.fileCount ?? 0) + '</dd></div>' +
        '<div class="fact"><dt>Checkpoint size</dt><dd>' + fmtSize(c.totalBytes || 0) + '</dd></div></dl>';
      var foot = empty ? '' : '<div class="card-foot top">' +
        '<button class="btn destructive" data-remove="' + c.slotId + '">Remove</button>' +
        '<button class="btn primary" data-restore="' + c.slotId + '">Restore this checkpoint</button></div>';
      return '<div class="card"><div class="card-head"><div class="pills" style="justify-content:space-between"><h3 class="card-title">Slot ' + slot + '</h3><span class="badge">' + badge + '</span></div>' +
        '<p class="card-desc">' + when + '</p>' + facts + '</div>' + foot + '</div>';
    }).join('');
    wrap.querySelectorAll('button[data-restore]').forEach(function (b) {
      b.addEventListener('click', function () {
        var slot = b.dataset.restore;
        var captured = (BOOT.checkpoints || []).find(function (c) { return c.slotId === slot; });
        var when = captured && captured.capturedAt ? new Date(captured.capturedAt).toLocaleString() : slot;
        ask('Restore this checkpoint?', 'This immediately restores the current Profile plus the checkpointed settings.yaml and Harness-home patch captured at ' + when + '. After restarting, the harness will use the rolled-back configuration.', 'Restore configuration', false, function () {
          run('Restoring ' + slot + '…', post('/__recovery/rollback', { slot: slot }), function () {
            ask('Checkpoint restored', 'Rolled back to ' + slot + '. Restart the harness to use this configuration.', 'Quit and restart', false, function () { post('/__recovery/restart', {}); waitAndReload(); });
          });
        });
      });
    });
    wrap.querySelectorAll('button[data-remove]').forEach(function (b) {
      b.addEventListener('click', function () {
        var slot = b.dataset.remove;
        var captured = (BOOT.checkpoints || []).find(function (c) { return c.slotId === slot; });
        var when = captured && captured.capturedAt ? new Date(captured.capturedAt).toLocaleString() : slot;
        ask('Remove this checkpoint?', 'The checkpoint captured at ' + when + ' is deleted. Its configuration cannot be restored afterwards.', 'Remove checkpoint', true, function () {
          run('Removing ' + slot + '…', post('/__recovery/checkpoint/remove', { slot: slot }), function () {
            refreshState(function () {});
          });
        });
      });
    });
  }
  renderCheckpoints();

  // ---- profiles ---------------------------------------------------------
  function renderProfiles() {
    var wrap = document.getElementById('profile-rows');
    var rows = BOOT.profiles || [];
    wrap.innerHTML = rows.map(function (p) {
      var buttons = p.active ? '<span class="badge">Current Profile</span>' :
        '<button class="btn" data-switch="' + p.name.replace(/"/g, '&quot;') + '"' + (p.webCapable ? '' : ' disabled title="This profile cannot boot the Web app."') + '>Switch</button>';
      var meta = p.label && p.label !== p.name ? p.label + ' · ' : '';
      return '<div class="row"><div class="who"><div class="name">' + p.name + '</div><div class="meta">' + meta + p.bundleCount + ' bundles</div></div><div class="row-actions">' + buttons + '</div></div>';
    }).join('');
    wrap.querySelectorAll('button[data-switch]').forEach(function (b) {
      b.addEventListener('click', function () {
        ask('Switch to "' + b.dataset.switch + '"?', 'The selection is written and the container restarts into it. Sessions, settings and credentials are shared by every profile and are never touched.', 'Switch Profile', false, function () {
          run('Switching to ' + b.dataset.switch + '…', post('/__recovery/select', { name: b.dataset.switch }).then(function () { return post('/__recovery/restart', {}); }), function () { waitAndReload(); });
        });
      });
    });
  }
  renderProfiles();
  document.getElementById('new-profile').addEventListener('click', function () {
    document.getElementById('newprofile-name').value = '';
    showView('newprofile');
    document.getElementById('newprofile-name').focus();
  });
  document.getElementById('newprofile-ok').addEventListener('click', function () {
    var name = document.getElementById('newprofile-name').value.trim();
    if (!name) return;
    post('/__recovery/profile/create', { name: name })
      .then(function () { closeModal(); location.reload(); })
      .catch(function (error) { document.getElementById('newprofile-name').value = ''; alert(error.message || String(error)); });
  });

  // ---- safe mode ----------------------------------------------------------
  document.getElementById('safe').addEventListener('click', function () {
    ask('Enter Safe Mode?', 'Restart with a temporary environment? The harness will use a separate temporary data directory: existing Profiles, plugins, settings and conversations are not read or changed. Only the official DeepSeek API key is carried over. The temporary environment is removed on the next restart.', 'Restart in Safe Mode', false, function () {
      run('Preparing Safe Mode…', post('/__recovery/safe', {}).then(function () { return post('/__recovery/restart', {}); }), function () { waitAndReload(); });
    });
  });

  // ---- reset & data ------------------------------------------------------
  document.getElementById('factory-reset').addEventListener('click', function () {
    ask('Factory reset the harness?', 'The following directory will be moved aside:\\n\\n' + (BOOT.dataDirectory || '') + '\\n\\nProfiles, plugins, settings, credentials, sessions and workspace records stored there are removed. The harness restarts and creates a clean default Profile.', 'Reset data and restart', true, function () {
      run('Resetting data…', post('/__recovery/factory-reset', {}), function () { waitAndReload(); });
    });
  });

  // ---- diagnostics --------------------------------------------------------
  function reportText() {
    return [
      'seek-harness diagnostic report',
      'generated: ' + new Date().toISOString(),
      'dsh version: ' + (BOOT.version || 'unknown'),
      'state: ' + (BOOT.boot ? BOOT.boot.state : 'unknown'),
      'profile: ' + (BOOT.boot && BOOT.boot.profile ? BOOT.boot.profile : '(unknown)'),
      'active: ' + (BOOT.active || '(unknown)'),
      'reason: ' + ((BOOT.boot && BOOT.boot.reason) || '(none)'),
      'detail: ' + ((BOOT.boot && BOOT.boot.detail) || '(none)'),
      'url: ' + location.href,
      '',
      'profiles:',
      ...(BOOT.profiles || []).map(function (p) { return '  - ' + p.name + (p.active ? ' (current)' : '') + ' [' + p.bundleCount + ' bundles' + (p.webCapable ? '' : ', NOT web-capable') + ']'; }),
      '',
      'plugins:',
      ...(BOOT.plugins || []).map(function (p) { return '  - ' + p.packageName + ' [' + p.status + ', ' + p.owner + ']' + (p.version ? ' v' + p.version : ''); }),
      '',
      'log tail:',
      document.getElementById('log') ? document.getElementById('log').textContent : '(none)',
    ].join('\\n');
  }
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return Promise.race([
          navigator.clipboard.writeText(text).then(function(){ return true; }),
          new Promise(function (_, reject) { setTimeout(function () { reject(new Error('clipboard timeout')); }, 1500); }),
        ]).catch(function () { return legacyCopy(text); });
      }
    } catch (e) { /* fall through */ }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-10000px';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    area.remove();
    return ok;
  }
  document.getElementById('copy-report').addEventListener('click', function () {
    copyText(reportText()).then(function (ok) { ask(ok ? 'Report copied' : 'Clipboard unavailable', ok ? 'The full diagnostic report is on the clipboard. Paste it wherever your agent can read it.' : 'Select the log text above and press Ctrl/Cmd+C instead.', 'Close', false, function () {}); });
  });
  document.getElementById('export-report').addEventListener('click', function () {
    window.location.href = '/__recovery/export';
  });

  // ---- configuration file editor ------------------------------------------
  var editingKey = null;
  document.querySelectorAll('button[data-edit]').forEach(function (b) {
    b.addEventListener('click', function () {
      var key = b.dataset.edit;
      editingKey = key;
      fetch('/__recovery/file?key=' + encodeURIComponent(key), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.ok === false) throw new Error(d.error || 'HTTP error');
          document.getElementById('edit-title').textContent = d.label;
          document.getElementById('edit-path').textContent = d.path + (d.exists ? '' : ' — file not created yet; saving creates it');
          document.getElementById('edit-area').value = d.content;
          showView('edit');
        })
        .catch(function (error) { ask('Cannot open file', String(error.message || error), 'Close', false, function () {}); });
    });
  });
  document.getElementById('edit-save').addEventListener('click', function () {
    var content = document.getElementById('edit-area').value;
    post('/__recovery/file/save', { key: editingKey, content: content })
      .then(function (d) { closeModal(); ask('File saved', 'Saved ' + d.saved + '. Restart the harness to apply the change.', 'Quit and restart', false, function () { post('/__recovery/restart', {}); waitAndReload(); }); })
      .catch(function (error) { ask('Save failed', String(error.message || error), 'Close', false, function () {}); });
  });

  // ---- footer ---------------------------------------------------------------
  document.getElementById('restart').addEventListener('click', function () {
    ask('Quit and restart?', 'The harness and the reverse proxy exit so the container can boot again with the current selection.', 'Quit and restart', false, function () {
      post('/__recovery/restart', {}).then(function () { waitAndReload(); });
    });
  });

  // A small live busy indicator under the tabs.
  var busyNote = document.createElement('div');
  busyNote.className = 'notice';
  busyNote.id = 'busy-note';
  document.querySelector('.tabs').after(busyNote);
</script>
</body></html>`
}

/**
 * The recovery API, mounted by the reverse proxy ahead of every other route.
 *
 * `restart` is the same mechanism the in-app switcher uses: answer, then leave.
 * The proxy is a child of the entrypoint, so its exit tears the container down
 * and `restart: unless-stopped` boots it again on the new selection.
 * @returns true when the request was handled here.
 */
export async function handleRecovery(req, res, { log = console.log } = {}) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/__recovery')) return false
  const env = process.env
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  const readBody = async () => {
    if (req.method !== 'POST') return {}
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw === '' ? {} : JSON.parse(raw)
  }
  const restartSoon = () => {
    setTimeout(() => { log('[recovery] exiting so the container can boot the selected profile'); process.exit(0) }, 600)
    return { ok: true, restarting: true }
  }

  try {
    const action = url.pathname.slice('/__recovery'.length).replace(/^\//u, '')
    switch (action) {
      case 'state': {
        let ready = false
        try {
          const probe = await fetch(`http://127.0.0.1:${process.env.DSH_PORT ?? '3079'}/`, { redirect: 'manual' })
          ready = probe.status < 500
        } catch { ready = false }
        return send(200, { ok: true, ready, ...recoverySnapshot(env) }), true
      }
      case 'select': {
        const body = await readBody()
        const result = selectProfile(env, String(body.name ?? ''))
        log(`[recovery] selected profile: ${result.active}`)
        return send(200, { ok: true, ...result }), true
      }
      case 'safe':
        return send(200, { ok: true, ...requestSafeMode(env) }), true
      case 'restart':
        return send(200, restartSoon()), true
      case 'plugin/disable': {
        const body = await readBody()
        return send(200, { ok: true, ...disablePlugin(env, String(body.name ?? '')) }), true
      }
      case 'plugin/enable': {
        const body = await readBody()
        return send(200, { ok: true, ...enablePlugin(env, String(body.name ?? '')) }), true
      }
      case 'plugin/uninstall': {
        const body = await readBody()
        return send(200, { ok: true, ...uninstallPlugin(env, String(body.name ?? '')) }), true
      }
      case 'checkpoint/remove': {
        const body = await readBody()
        return send(200, { ok: true, ...removeCheckpoint(env, String(body.slot ?? '')) }), true
      }
      case 'rollback': {
        const body = await readBody()
        return send(200, { ok: true, ...restoreCheckpoint(env, String(body.slot ?? '')) }), true
      }
      case 'profile/create': {
        const body = await readBody()
        return send(200, { ok: true, ...createProfile(env, String(body.name ?? '')) }), true
      }
      case 'factory-reset':
        return send(200, { ok: true, ...factoryReset(env) }), true
      case 'file': {
        const key = url.searchParams.get('key') ?? ''
        return send(200, { ok: true, ...readConfigFile(env, key) }), true
      }
      case 'file/save': {
        const body = await readBody()
        return send(200, { ok: true, ...saveConfigFile(env, String(body.key ?? ''), body.content) }), true
      }
      case 'export': {
        const archive = diagnosticArchive(env)
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="dsh-diagnostics-${new Date().toISOString().replace(/[:.]/gu, '-')}.txt"`,
          'cache-control': 'no-store',
        })
        res.end(archive)
        return true
      }
      case 'page': {
        // Served unconditionally — reached EITHER because the harness is down, or
        // because a healthy harness could not compose its browser half and the
        // page handed off (see the boot watchdog in proxy.mjs). The `from` query
        // only changes the wording, never the actions.
        const from = url.searchParams.get('from')
        const reason = url.searchParams.get('reason')
        // Record the client-side failure too. The harness is healthy, so the
        // entrypoint never sees it — without this the next reload would look like
        // a clean boot and lose the reason the user was sent here.
        if (from === 'client') {
          try {
            const file = stateFile(env)
            const previous = readJson(file) ?? {}
            writeJsonAtomic(file, {
              ...previous,
              state: 'client-failed',
              reason: reason === 'client-failed'
                ? 'the browser half of this profile failed to load'
                : 'the interface never finished loading',
              detail: 'the server is healthy — the failure is in the browser side of the plugin tree',
              profile: previous.profile ?? activeName(env),
              at: new Date().toISOString(),
            })
          } catch { /* the page must render even if the record cannot be written */ }
        }
        const snapshot = recoverySnapshot(env)
        const page = recoveryPage({
          ...snapshot,
          boot: from === 'client'
            ? {
                ...snapshot.boot,
                state: 'client-failed',
                reason: reason === 'client-failed'
                  ? 'The harness started, but its browser half failed to load'
                  : 'The harness started, but the interface never finished loading',
                detail: 'The server is healthy (its API answers) — the failure is in the browser side of the plugin tree, which is exactly what a profile switch or Safe Mode clears.',
              }
            : snapshot.boot,
        })
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(page),
        })
        res.end(page)
        return true
      }
      default:
        return send(404, { ok: false, error: `unknown recovery action "${action}"` }), true
    }
  } catch (error) {
    return send(400, { ok: false, error: error instanceof Error ? error.message : String(error) }), true
  }
}

/** True when this request should get the recovery PAGE rather than an error. */
export function wantsRecoveryPage(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname.startsWith('/__recovery')) return false
  if (url.pathname.startsWith('/api/')) return false
  if (/\.(?:js|mjs|css|json|map|png|jpe?g|svg|ico|webp|woff2?|ttf)$/iu.test(url.pathname)) return false
  return true
}
