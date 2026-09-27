/**
 * dsh-profile-switcher — host half.
 *
 * The Web UI half renders the pill; this half owns the profile facts:
 *
 *   GET  /api/dsh-profile-switcher/list      -> { ok, active, profiles[], safeProfile, locked[] }
 *   POST /api/dsh-profile-switcher/select    { name }             -> writes the selection
 *   POST /api/dsh-profile-switcher/create    { name, from? }      -> copies a profile
 *   POST /api/dsh-profile-switcher/delete    { name }             -> deletes a profile
 *   POST /api/dsh-profile-switcher/safe      {}                   -> ensure + select Safe Mode
 *   POST /api/dsh-profile-switcher/restart   {}                   -> exit; the container policy reboots
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

const ROUTE = '/api/dsh-profile-switcher'
const WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const SAFE_PROFILE = 'shell-safe'
/** Profiles that must always exist: `web` is the entrypoint's fallback. */
const LOCKED = new Set(['web'])
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/iu
const RESERVED = new Set(['node_modules', 'con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'lpt1', 'lpt2', 'lpt3'])

/** Harness home; the launcher exports DSH_HOME, the default matches the image. */
const home = () => process.env.DSH_HOME ?? '/home/node/.dsh'
const profilesRoot = () => join(home(), 'profiles')
const selectionFile = () => join(home(), 'active-profile.json')

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

function activeName() {
  const saved = readJson(selectionFile())
  return typeof saved?.active === 'string' ? saved.active : null
}

function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !RESERVED.has(name.toLowerCase())
}

function listProfiles() {
  const root = profilesRoot()
  if (!existsSync(root)) return []
  const active = activeName()
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => {
      const bundles = bundlesOf(entry.name)
      return {
        name: entry.name,
        bundles: bundles ?? null,
        bundleCount: bundles?.length ?? 0,
        webCapable: webCapable(bundles),
        active: entry.name === active,
        safeMode: entry.name === SAFE_PROFILE,
        locked: LOCKED.has(entry.name),
        deletable: !LOCKED.has(entry.name) && entry.name !== active && bundles !== undefined,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
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

function create(name, from) {
  if (!validName(name)) throw new Error(`invalid profile name: ${JSON.stringify(name)}`)
  const source = validName(from) ? from : (activeName() ?? 'web')
  const sourceDir = join(profilesRoot(), source)
  if (!existsSync(join(sourceDir, 'package.json'))) throw new Error(`source profile "${source}" does not exist`)
  const target = join(profilesRoot(), name)
  if (existsSync(target)) throw new Error(`profile "${name}" already exists`)
  cpSync(sourceDir, target, { recursive: true, errorOnExist: true, force: false })
  log(`created profile ${name} from ${source}`)
  return { name, from: source }
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

/** Safe Mode: the shipped bundles only, so a broken third-party plugin can be removed. */
function ensureSafeProfile() {
  const target = join(profilesRoot(), SAFE_PROFILE)
  if (!existsSync(join(target, 'package.json'))) {
    create(SAFE_PROFILE, 'web')
    const patchPath = join(target, 'cordis.patch.yml')
    writeFileSync(patchPath, '# Safe Mode: the shipped bundles only, no user patch layer.\n[]\n')
    log(`created ${SAFE_PROFILE} (stock bundles only)`)
  }
  const manifestPath = join(target, 'package.json')
  const manifest = readJson(manifestPath) ?? {}
  manifest.dsh = { ...(manifest.dsh ?? {}), profile: { bundles: [...WEB_BUNDLES] } }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return select(SAFE_PROFILE)
}

/** Answer the caller first, then leave — the container policy boots the new profile. */
function restartSoon(extra = {}) {
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
              safeProfile: SAFE_PROFILE, locked: [...LOCKED],
            })
          case 'select':
            return send(res, 200, { ok: true, ...select(String(body.name ?? '')), restartRequired: true })
          case 'create': {
            const created = create(String(body.name ?? ''), body.from === undefined ? undefined : String(body.from))
            return send(res, 200, { ok: true, ...created, profiles: listProfiles() })
          }
          case 'delete': {
            const deleted = remove(String(body.name ?? ''))
            return send(res, 200, { ok: true, ...deleted, profiles: listProfiles() })
          }
          case 'safe':
            return send(res, 200, { ok: true, ...ensureSafeProfile(), restartRequired: true })
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
