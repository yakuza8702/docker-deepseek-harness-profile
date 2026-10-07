/**
 * dsh-profile-switcher — host half.
 *
 * The Web UI half renders the pill; this half owns the profile facts:
 *
 *   GET  /api/dsh-profile-switcher/list      -> { ok, active, profiles[], locked[] }
 *   POST /api/dsh-profile-switcher/select    { name }             -> writes the selection
 *   POST /api/dsh-profile-switcher/create    { name, mode?, from? } -> creates a profile:
 *                                                                   "inherit" (default) copies
 *                                                                   `from`, "new" starts from
 *                                                                   the stock skeleton
 *   POST /api/dsh-profile-switcher/delete    { name }             -> deletes a profile
 *   POST /api/dsh-profile-switcher/rename    { name, label }      -> display label only
 *   POST /api/dsh-profile-switcher/move      { name, direction }  -> reorder the list
 *   POST /api/dsh-profile-switcher/safe      {}                   -> request a temporary-environment
 *                                                                   boot (flag + restart); the
 *                                                                   entrypoint boots a tmpfs home
 *   POST /api/dsh-profile-switcher/restart   {}                   -> exit; the container policy reboots
 *   GET  /api/dsh-profile-switcher/state     -> last boot outcome (for the recovery view)
 *
 * RENAME IS COSMETIC, ON PURPOSE: a profile's DIRECTORY name is its launcher
 * input (`dsh --profile <name>`) and every companion/entry that references it.
 * Renaming the directory would break those references, so a rename only writes a
 * display label into a sidecar (`profile-labels.json`) that this UI reads. The
 * folder keeps the name it was created with, exactly as asked.
 *
 * ORDER is likewise a sidecar (`profile-order.json`): a user-chosen list of
 * directory names. Unknown profiles are appended alphabetically, so a new
 * profile can never be hidden by a stale order file.
 *
 * WHY a restart: a DSH profile is a BOOT-TIME launcher input
 * (`dsh --profile <name>` -> `$DSH_HOME/profiles/<name>`), so nothing running
 * inside the process can change it. This plugin therefore writes
 * `$DSH_HOME/active-profile.json` (the file the image's entrypoint reads) and
 * then exits the process; `restart: unless-stopped` brings the container back on
 * the selected profile. The UI confirms before doing it.
 *
 * Guards: only a profile that can boot the Web app (`@deepseek-ai/dsh-base` +
 * `@deepseek-ai/dsh-web-app`) is selectable, the shipped `web` profile can never
 * be deleted (it is the launcher's fallback), and the active profile can never be
 * deleted — a bad request must not leave the container without a UI.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROUTE = '/api/dsh-profile-switcher'
const WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
/** The two ways a new profile can start — see `create`. */
const CREATE_MODES = ['inherit', 'new']
/** Profiles that must always exist: `web` is the entrypoint's fallback. */
const LOCKED = new Set(['web'])
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/iu
const RESERVED = new Set(['node_modules', 'con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'lpt1', 'lpt2', 'lpt3'])

/** The REAL harness home. In Safe Mode the launcher exports DSH_REAL_HOME (the
 * entrypoint keeps it pointing at the real home while the harness itself runs
 * on a throwaway tmpfs home) — the panel must always manage the REAL profiles
 * and the REAL selection, never the temporary environment. */
const home = () => process.env.DSH_REAL_HOME ?? process.env.DSH_HOME ?? '/home/node/.dsh'

/** True while this harness process is running on the temporary Safe Mode home. */
const isSafeModeActive = () => {
  const real = process.env.DSH_REAL_HOME
  const current = process.env.DSH_HOME
  return typeof real === 'string' && real !== '' && typeof current === 'string' && current !== '' && real !== current
}
const profilesRoot = () => join(home(), 'profiles')
const selectionFile = () => join(home(), 'active-profile.json')
/** Cosmetic layer: display labels + the user's ordering. Never the folder name. */
const labelsFile = () => join(home(), 'profile-labels.json')
const orderFile = () => join(home(), 'profile-order.json')
/**
 * Flag that marks this process exit as a REQUESTED profile switch. The image's
 * entrypoint supervises the reverse proxy and keeps serving the recovery page
 * when DSH exits (so a profile that cannot boot stays fixable from the browser),
 * which means exiting here no longer reboots the container on its own: the
 * supervisor waits for the proxy instead. This flag is how the supervisor tells
 * a requested switch apart from a crash and tears the stack down so
 * `restart: unless-stopped` boots the new selection.
 */
const RESTART_FLAG = '/tmp/dsh-restart-requested'

const log = (...parts) => console.log('[dsh-profile-switcher]', ...parts)

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** The bundle list a profile declares, or undefined when it has no usable manifest. */
function bundlesOf(name) {
  const manifest = readJson(join(profilesRoot(), name, 'package.json'))
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) && bundles.every((entry) => typeof entry === 'string') ? bundles : undefined
}

/** Only a profile that carries the Web app can be a switch target. */
function webCapable(bundles) {
  return bundles !== undefined && WEB_BUNDLES.every((name) => bundles.includes(name))
}

/**
 * The profile this harness actually BOOTED — resolved exactly the way the
 * image's entrypoint resolves it, because the two must never disagree.
 *
 * The entrypoint reads `$DSH_HOME/active-profile.json` and falls back to the
 * shipped `web` profile when the file is missing, malformed, or names a profile
 * that cannot boot the Web app. Resolving the fallback here as well is what
 * makes a FRESH volume behave: without it the panel reported the active profile
 * as `unknown`, showed no "Current Profile", and offered a "Switch" button for
 * `web` — the profile that was already running, and the only one that exists.
 *
 * A stored name is honoured only when it can boot this build; anything else
 * reports the effective fallback (`web`), or `null` in the degenerate case where
 * even `web` is missing — the panel then has nothing true to say about it.
 */
function activeName() {
  const saved = readJson(selectionFile())
  const savedName = typeof saved?.active === 'string' ? saved.active : null
  if (savedName !== null && validName(savedName) && webCapable(bundlesOf(savedName))) return savedName
  if (validName('web') && webCapable(bundlesOf('web'))) return 'web'
  return null
}

function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !RESERVED.has(name.toLowerCase())
}

/** Display labels, keyed by profile (folder) name. */
function readLabels() {
  const saved = readJson(labelsFile())
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return {}
  const labels = {}
  for (const [name, label] of Object.entries(saved)) {
    if (typeof label === 'string' && label.trim() !== '') labels[name] = label.trim().slice(0, 40)
  }
  return labels
}

/** The user's ordering, as a list of profile (folder) names. */
function readOrder() {
  const saved = readJson(orderFile())
  return Array.isArray(saved) ? saved.filter((entry) => typeof entry === 'string') : []
}

function writeJsonAtomic(file, value) {
  mkdirSync(home(), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, file)
}

/** Order: the user's list first (skipping names that no longer exist), then A→Z. */
function sortProfiles(profiles) {
  const order = readOrder()
  const rank = new Map(order.map((name, index) => [name, index]))
  return profiles.sort((a, b) => {
    const ra = rank.get(a.name)
    const rb = rank.get(b.name)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.name.localeCompare(b.name)
  })
}

function listProfiles() {
  const root = profilesRoot()
  if (!existsSync(root)) return []
  const active = activeName()
  const labels = readLabels()
  return sortProfiles(readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => {
      const bundles = bundlesOf(entry.name)
      return {
        name: entry.name,
        label: labels[entry.name] ?? null,
        bundles: bundles ?? null,
        bundleCount: bundles?.length ?? 0,
        webCapable: webCapable(bundles),
        active: entry.name === active,
        locked: LOCKED.has(entry.name),
        deletable: !LOCKED.has(entry.name) && entry.name !== active && bundles !== undefined,
      }
    }))
}

/** Atomic selection write — a torn file would be ignored by the launcher anyway. */
function select(name) {
  if (!validName(name)) throw new Error(`invalid profile name: ${JSON.stringify(name)}`)
  const bundles = bundlesOf(name)
  if (bundles === undefined) throw new Error(`profile "${name}" has no readable package.json`)
  if (!webCapable(bundles)) throw new Error(`profile "${name}" cannot boot the Web app (needs ${WEB_BUNDLES.join(' + ')})`)
  mkdirSync(home(), { recursive: true })
  const file = selectionFile()
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: 1, active: name }, null, 2)}\n`)
  renameSync(temporary, file)
  log(`selected profile: ${name}`)
  return { active: name }
}

/** Where an installation may live. `DSH_INSTALL_ROOTS` (colon-separated) REPLACES
 * the default list — the build gate uses that to prove the no-installation path. */
function installRoots() {
  const override = process.env.DSH_INSTALL_ROOTS
  if (typeof override === 'string' && override.trim() !== '') {
    return override.split(':').map((entry) => entry.trim()).filter((entry) => entry !== '')
  }
  return ['/opt/dsh', '/opt/dsh-src']
}

/**
 * DSH's own profile initialiser (`initProfile`), when this image carries one.
 *
 * Preferred over writing the skeleton here for the same reason the image's
 * entrypoint prefers it: no template knowledge is duplicated, so the stock
 * profile cannot drift from what the launcher itself creates. Both layouts this
 * image can have are searched — the npm channel hoists it into the installation
 * `node_modules`, the source channel keeps it in the workspace tree — and a
 * module that loads but has no `initProfile` is treated as absent rather than
 * trusted. Memoised: one lookup per process, `null` included.
 */
let initialiserPromise = null
function loadInitialiser() {
  if (initialiserPromise === null) {
    initialiserPromise = (async () => {
      for (const root of installRoots()) {
        for (const file of [
          join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'),
          join(root, 'packages', 'boot', 'app-boot', 'lib', 'index.js'),
        ]) {
          if (!existsSync(file)) continue
          try {
            const module = await import(pathToFileURL(file).href)
            if (typeof module.initProfile === 'function') return module
            log(`the initialiser at ${file} exports no initProfile — ignoring it`)
          } catch (error) {
            log(`could not load the initialiser at ${file}: ${error.message}`)
          }
        }
      }
      return null
    })()
  }
  return initialiserPromise
}

/**
 * The stock skeleton, byte-for-byte what `@deepseek-ai/dsh-app-boot`'s
 * `initProfile` writes (its `PROFILE_PATCH_TEMPLATE` + `PROFILE_PNPM_WORKSPACE`).
 * It is only ever written when no initialiser could be loaded, and
 * `tools/check-profile-switcher.mjs` fails the build if the two ever disagree.
 */
const STOCK_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`
const STOCK_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** Write the stock manifest + the two files an initialised profile carries. */
function writeStockSkeleton(dir, name) {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...WEB_BUNDLES] } },
  }, null, 2)}\n`)
  const patch = join(dir, 'cordis.patch.yml')
  if (!existsSync(patch)) writeFileSync(patch, STOCK_PATCH)
  const workspace = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspace)) writeFileSync(workspace, STOCK_WORKSPACE)
}

/** True when a directory already holds a stock manifest: the two Web bundles and
 * nothing else, no dependencies. Read back rather than assumed — a partial or
 * unexpected write must not be reported as a profile that can boot. */
function stockManifest(dir) {
  const manifest = readJson(join(dir, 'package.json'))
  const bundles = manifest?.dsh?.profile?.bundles
  const dependencies = manifest?.dependencies
  return Array.isArray(bundles) && bundles.length === WEB_BUNDLES.length
    && WEB_BUNDLES.every((bundle) => bundles.includes(bundle))
    && dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)
    && Object.keys(dependencies).length === 0
}

/** Materialise a stock profile directory; returns which writer was used. */
async function createStock(name) {
  const dir = join(profilesRoot(), name)
  mkdirSync(dir, { recursive: true })
  const initialiser = await loadInitialiser()
  if (initialiser !== null) {
    try {
      initialiser.initProfile(dir, [...WEB_BUNDLES])
    } catch (error) {
      log(`the initialiser refused ${name} (${error.message}) — writing the skeleton instead`)
    }
  }
  if (stockManifest(dir)) return initialiser === null ? 'template' : 'app-boot'
  writeStockSkeleton(dir, name)
  return 'template'
}

/**
 * Create a profile — and the difference between the two modes is the whole point
 * of the chooser the panel asks with:
 *
 *   inherit — COPY `from` (the active profile unless another is named). Its
 *             plugin set, pins, patch layer and installed `node_modules` all come
 *             along, so the new profile is a branch of it. This was the only mode
 *             until now, which is why "+ New Profile" silently cloned a plugin set.
 *   new     — a STOCK profile: `dsh-base` + `dsh-web-app`, no dependencies, no
 *             `node_modules`, no plugins of any kind. Nothing follows the source.
 *             Bootable and web-capable by construction, so the switcher can select
 *             it, and the integrated bundles stay available on the Plugins page.
 *
 * @param name - the new profile's name (folder name, validated).
 * @param from - source profile for `inherit`.
 * @param mode - `inherit` (default, so older callers keep working) or `new`.
 * @returns what was created and how.
 */
async function create(name, from, mode) {
  if (!validName(name)) throw new Error(`invalid profile name: ${JSON.stringify(name)}`)
  const how = mode === undefined || mode === null || mode === '' ? 'inherit' : String(mode)
  if (!CREATE_MODES.includes(how)) {
    throw new Error(`mode must be one of ${CREATE_MODES.map((entry) => JSON.stringify(entry)).join(', ')}, got ${JSON.stringify(mode)}`)
  }
  const target = join(profilesRoot(), name)
  if (existsSync(target)) throw new Error(`profile "${name}" already exists`)

  if (how === 'new') {
    const skeleton = await createStock(name)
    log(`created profile ${name} as a new profile (${skeleton} skeleton)`)
    return { name, mode: how, from: null, skeleton }
  }

  const source = validName(from) ? from : (activeName() ?? 'web')
  const sourceDir = join(profilesRoot(), source)
  if (!existsSync(join(sourceDir, 'package.json'))) throw new Error(`source profile "${source}" does not exist`)
  cpSync(sourceDir, target, { recursive: true, errorOnExist: true, force: false })
  log(`created profile ${name} as a copy of ${source}`)
  return { name, mode: how, from: source, skeleton: null }
}

function remove(name) {
  if (!validName(name)) throw new Error(`invalid profile name: ${JSON.stringify(name)}`)
  if (LOCKED.has(name)) throw new Error(`"${name}" is the default profile and cannot be deleted`)
  if (name === activeName()) throw new Error(`"${name}" is the active profile — switch to another profile first, then delete it`)
  const dir = join(profilesRoot(), name)
  if (!existsSync(join(dir, 'package.json'))) throw new Error(`profile "${name}" does not exist`)
  rmSync(dir, { recursive: true, force: false })
  log(`deleted profile ${name}`)
  return { name, deleted: true }
}

/**
 * Cosmetic rename: stores a display label; the profile directory keeps its name.
 * An empty label clears the override, so the row falls back to the folder name.
 */
function rename(name, label) {
  if (!validName(name) || bundlesOf(name) === undefined) throw new Error(`profile "${name}" does not exist`)
  const text = typeof label === 'string' ? label.trim().slice(0, 40) : ''
  const labels = readLabels()
  if (text === '') delete labels[name]
  else labels[name] = text
  writeJsonAtomic(labelsFile(), labels)
  log(`labelled ${name} as ${text === '' ? '(folder name)' : text}`)
  return { name, label: text === '' ? null : text }
}

/** Reorder the list by one step. Only the sidecar changes — never the folder. */
function move(name, direction) {
  if (direction !== 'up' && direction !== 'down') throw new Error(`direction must be "up" or "down", got ${JSON.stringify(direction)}`)
  const current = listProfiles().map((profile) => profile.name)
  const index = current.indexOf(name)
  if (index === -1) throw new Error(`profile "${name}" does not exist`)
  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= current.length) return { order: current, moved: false }
  const next = [...current]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  writeJsonAtomic(orderFile(), next)
  log(`moved ${name} ${direction}`)
  return { order: next, moved: true }
}

/**
 * Safe Mode — a TRUE temporary environment (dsh-next parity).
 *
 * Writes $DSH_REAL_HOME/.safe-mode-request; the entrypoint consumes it on the
 * next boot and starts the harness with a throwaway tmpfs DSH_HOME, so existing
 * profiles, settings and sessions are never read or changed. Only the official
 * DeepSeek API key credential is carried over, and the temporary data vanishes
 * with the following restart (tmpfs). DSH_REAL_HOME is exported by the
 * entrypoint and ALWAYS points at the real home — even while this harness is
 * itself running on the temporary one.
 */
function requestSafeMode() {
  const realHome = process.env.DSH_REAL_HOME ?? home()
  const flag = join(realHome, '.safe-mode-request')
  mkdirSync(realHome, { recursive: true })
  writeJsonAtomic(flag, { version: 1, at: new Date().toISOString(), requestedBy: 'panel' })
  log('requested Safe Mode (temporary environment) via ' + flag)
  return { safeModeRequested: true }
}

/**
 * The last boot outcome, written by the image's entrypoint.
 *
 * The entrypoint is the only thing that runs when a profile cannot boot (the
 * harness never starts, so no plugin code runs), so it is the one that records
 * the failure. When DSH is up — as now — this simply reports `ready`, and the
 * recovery VIEW lives in the reverse proxy, which also survives a dead DSH.
 */
function bootState() {
  const saved = readJson(process.env.DSH_BOOT_STATE_FILE ?? '/tmp/dsh-boot.json')
  if (saved === null || typeof saved !== 'object') return { state: 'unknown' }
  return {
    state: typeof saved.state === 'string' ? saved.state : 'unknown',
    reason: typeof saved.reason === 'string' ? saved.reason : null,
    detail: typeof saved.detail === 'string' ? saved.detail : null,
    profile: typeof saved.profile === 'string' ? saved.profile : null,
    at: typeof saved.at === 'string' ? saved.at : null,
  }
}

/** Answer the caller first, then leave — the container policy boots the new profile. */
function restartSoon(extra = {}) {
  try {
    writeFileSync(RESTART_FLAG, `${Date.now()}\n`)
  } catch (error) {
    log(`could not write ${RESTART_FLAG}: ${error.message}`)
  }
  setTimeout(() => {
    log('exiting so the container can boot the selected profile')
    process.exit(0)
  }, 750)
  return { ok: true, restarting: true, ...extra }
}

async function readBody(req) {
  if (req.method !== 'POST') {
    const url = new URL(req.url ?? ROUTE, 'http://localhost')
    return Object.fromEntries(url.searchParams)
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : JSON.parse(raw)
}

/** Required services: the browser HTTP carrier. */
export const inject = ['webServer']

/**
 * @param ctx - Host root context.
 */
export function apply(ctx) {
  const send = (res, status, payload) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      const action = new URL(req.url ?? ROUTE, 'http://localhost').pathname.slice(ROUTE.length).replace(/^\//u, '')
      try {
        const body = await readBody(req)
        switch (action) {
          case 'list':
            return send(res, 200, {
              ok: true, home: home(), active: activeName(), profiles: listProfiles(),
              safeModeActive: isSafeModeActive(), locked: [...LOCKED], boot: bootState(),
            })
          case 'select':
            return send(res, 200, { ok: true, ...select(String(body.name ?? '')), restartRequired: true })
          case 'create': {
            const created = await create(
              String(body.name ?? ''),
              body.from === undefined ? undefined : String(body.from),
              body.mode === undefined ? undefined : String(body.mode),
            )
            return send(res, 200, { ok: true, ...created, profiles: listProfiles() })
          }
          case 'rename':
            return send(res, 200, { ok: true, ...rename(String(body.name ?? ''), body.label), profiles: listProfiles() })
          case 'move':
            return send(res, 200, { ok: true, ...move(String(body.name ?? ''), body.direction), profiles: listProfiles() })
          case 'delete': {
            const deleted = remove(String(body.name ?? ''))
            return send(res, 200, { ok: true, ...deleted, profiles: listProfiles() })
          }
          case 'safe':
            return send(res, 200, restartSoon({ ...requestSafeMode() }))
          case 'state':
            return send(res, 200, { ok: true, boot: bootState(), active: activeName(), profiles: listProfiles() })
          case 'restart':
            return send(res, 200, restartSoon())
          default:
            return send(res, 404, { ok: false, error: `unknown action "${action}"` })
        }
      } catch (error) {
        log(`action ${action} failed:`, error instanceof Error ? error.message : String(error))
        return send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
}
