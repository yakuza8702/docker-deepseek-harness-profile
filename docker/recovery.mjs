/**
 * seek-harness recovery surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * When a profile cannot boot, the harness never starts — so no plugin inside it
 * can show anything. The one process that is always up is the reverse proxy, and
 * the one thing that always runs is the entrypoint. This module turns that into a
 * recovery screen: if DSH is unreachable, a browser navigation gets a real page
 * with the recorded boot failure, the log tail, and the two actions that fix it —
 * switch to another profile, or boot Safe Mode. The same actions an agent (or the
 * user) needs, without reading `docker logs`.
 *
 * The state file is written by the entrypoint at each boot milestone:
 *   { state: 'starting' | 'ready' | 'failed', reason, detail, profile, at, logTail }
 *
 * Zero npm dependencies, plain node:http handlers. The page is one file with
 * inline CSS/JS so it renders even when nothing else on the host works.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const SAFE_PROFILE = 'shell-safe'
const LOCKED = new Set(['web'])
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/iu
const RESERVED = new Set(['node_modules', 'con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'lpt1', 'lpt2', 'lpt3'])

const home = (env) => env.DSH_HOME ?? '/home/node/.dsh'
const profilesRoot = (env) => join(home(env), 'profiles')
const selectionFile = (env) => join(home(env), 'active-profile.json')
const labelsFile = (env) => join(home(env), 'profile-labels.json')
const stateFile = (env) => env.DSH_BOOT_STATE_FILE ?? '/tmp/dsh-boot.json'

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
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

/** Everything the recovery page and the in-app panel need. */
export function recoverySnapshot(env = process.env) {
  const root = profilesRoot(env)
  const active = activeName(env)
  const names = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== 'node_modules').map((entry) => entry.name)
    : []
  const order = (() => { const saved = readJson(join(home(env), 'profile-order.json')); return Array.isArray(saved) ? saved : [] })()
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
      safeMode: name === SAFE_PROFILE,
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
  return { home: home(env), active, profiles, safeProfile: SAFE_PROFILE, boot: bootState(env) }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, file)
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

/** Safe Mode: create `shell-safe` from `web` if needed, then select it. */
export function selectSafe(env) {
  const target = join(profilesRoot(env), SAFE_PROFILE)
  if (!existsSync(join(target, 'package.json'))) {
    const source = join(profilesRoot(env), 'web')
    if (!existsSync(join(source, 'package.json'))) throw new Error('cannot create Safe Mode: the shipped `web` profile is missing')
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const from = join(source, entry.name)
      const to = join(target, entry.name)
      if (entry.isDirectory()) continue
      writeFileSync(to, readFileSync(from))
    }
    const manifestPath = join(target, 'package.json')
    const manifest = readJson(manifestPath) ?? {}
    manifest.dsh = { ...(manifest.dsh ?? {}), profile: { bundles: [...WEB_BUNDLES] } }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(join(target, 'cordis.patch.yml'), '# Safe Mode: the shipped bundles only, no user patch layer.\n[]\n')
  }
  return selectProfile(env, SAFE_PROFILE)
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/gu, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
))

/** The standalone recovery page: no build step, no external asset. */
export function recoveryPage(snapshot) {
  const { boot, profiles, active, safeProfile } = snapshot
  const rows = profiles.map((profile) => `        <li class="row${profile.active ? ' is-current' : ''}">
          <div class="who">
            <span class="name">${escapeHtml(profile.label ?? profile.name)}${profile.active ? ' · current' : ''}</span>
            <span class="meta">${escapeHtml(profile.name)} · ${profile.bundleCount} bundles${profile.webCapable ? '' : ' · not web-capable'}${profile.safeMode ? ' · Safe Mode' : ''}</span>
          </div>
          ${profile.active
            ? '<span class="pill">Current</span>'
            : `<button class="pick" data-name="${escapeHtml(profile.name)}"${profile.webCapable ? '' : ' disabled'}>Switch</button>`}
        </li>`).join('\n')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH — recovery</title>
<style>
  :root{color-scheme:light dark;--bg:#f6f7f9;--fg:#0f1115;--muted:#5b6472;--card:#fff;--line:#e3e6ea;--err:#b3261e;--warn:#8a5a00}
  @media (prefers-color-scheme:dark){:root{--bg:#16181d;--fg:#e8eaed;--muted:#9aa3ad;--card:#1e2127;--line:#2c3037;--err:#ff8a80;--warn:#ffcc80}}
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:760px;margin:0 auto}
  h1{margin:0 0 4px;font-size:20px}
  .sub{color:var(--muted);margin-bottom:18px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
  .card h2{margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
  .reason{font-weight:600;color:var(--err);margin:0 0 6px;overflow-wrap:anywhere}
  .detail{margin:0;color:var(--muted);overflow-wrap:anywhere}
  pre{margin:0;padding:12px;border-radius:10px;background:rgba(127,127,127,.12);overflow:auto;max-height:280px;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap}
  ul{list-style:none;margin:0;padding:0}
  .row{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;background:transparent}
  .row.is-current{border-color:var(--muted)}
  .who{display:flex;flex-direction:column;min-width:0}
  .name{font-weight:600;overflow-wrap:anywhere}
  .meta{color:var(--muted);font-size:12px}
  button{font:inherit;min-height:38px;padding:8px 14px;border-radius:9px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
  button:hover:not(:disabled){background:rgba(127,127,127,.16)}
  button:disabled{opacity:.4;cursor:not-allowed}
  button.primary{border-color:transparent;background:#3b6ef0;color:#fff}
  button.primary:hover{background:#2f5bd0}
  .pill{color:var(--muted);font-size:12px}
  .actions{display:flex;gap:10px;flex-wrap:wrap}
  .note{margin-top:14px;color:var(--muted);min-height:1.4em}
  .busy{opacity:.6;pointer-events:none}
</style></head><body><div class="wrap">
  <h1>${boot.state === 'client-failed' ? 'Harness interface failed to load' : 'Harness did not start'}</h1>
  <div class="sub">${boot.state === 'client-failed'
    ? 'The server is running, but this profile’s browser half could not compose. Pick another profile or boot Safe Mode — the container restarts into it.'
    : 'The reverse proxy is up; the harness itself is not. Pick another profile or boot Safe Mode — the container restarts into it.'}</div>

  <div class="card">
    <h2>Why</h2>
    <p class="reason">${escapeHtml(boot.reason ?? 'No boot failure recorded yet — the harness may still be starting.')}</p>
    ${boot.detail === null ? '' : `<p class="detail">${escapeHtml(boot.detail)}</p>`}
    <p class="detail">state: ${escapeHtml(boot.state)}${boot.profile === null ? '' : ` · profile: ${escapeHtml(boot.profile)}`}${boot.at === null ? '' : ` · at: ${escapeHtml(boot.at)}`}</p>
  </div>

  <div class="card">
    <h2>Profiles</h2>
    <ul>
${rows}
    </ul>
    <div class="actions">
      <button class="primary" id="safe">Boot Safe Mode${active === safeProfile ? ' (already current)' : ''}</button>
      <button id="retry">Retry boot</button>
    </div>
    <div class="note" id="note"></div>
  </div>

  ${boot.logTail === null ? '' : `<div class="card"><h2>Last log lines</h2><pre>${escapeHtml(boot.logTail)}</pre></div>`}

  <div class="card">
    <h2>Notes</h2>
    <p class="detail">Switching writes the profile selection and restarts the container. Sessions, settings and credentials are shared by every profile and are never touched.</p>
  </div>
</div>
<script>
  const note = (text) => { document.getElementById('note').textContent = text }
  const body = () => document.body.classList.add('busy')
  const waitAndReload = async () => {
    note('restarting… the page reloads when the harness answers')
    // Two phases: the container goes down (ready:false), then comes back
    // (ready:true). We then reload — and let the BOOT WATCHDOG decide whether the
    // interface is healthy: if this profile's browser half is still broken, the
    // watchdog immediately hands the user back here, so a reload can never strand
    // anyone on a dead page. (An earlier version judged the client itself with a
    // content probe; it could not tell a working shell from a broken one, and one
    // of its checks matched the watchdog script that the proxy injects into every
    // page, so it waited forever.)
    let sawDown = false
    for (let i = 0; i < 240; i += 1) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const response = await fetch('/__recovery/state', { headers: { accept: 'application/json' }, cache: 'no-store' })
        const data = await response.json()
        if (data.ready !== true) { sawDown = true; note('harness is restarting…'); continue }
        if (!sawDown && i < 8) { note('waiting for the harness to restart…'); continue }
        // Settle briefly so the fresh shell is actually serving before we leave.
        await new Promise((r) => setTimeout(r, 1500))
        window.location.replace('/')
        return
      } catch { sawDown = true; note('harness is restarting…') }
    }
    note('gave up waiting after 4 minutes — check the container log')
  }
  const post = async (path, payload) => {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) })
    const data = await response.json().catch(() => ({}))
    if (response.ok !== true || data.ok === false) throw new Error(data.error || ('HTTP ' + response.status))
    return data
  }
  for (const button of document.querySelectorAll('button.pick')) {
    button.addEventListener('click', async () => {
      body()
      try { await post('/__recovery/select', { name: button.dataset.name }); await post('/__recovery/restart', {}); await waitAndReload() }
      catch (error) { document.body.classList.remove('busy'); note(error.message) }
    })
  }
  document.getElementById('safe').addEventListener('click', async () => {
    body()
    try { await post('/__recovery/safe', {}); await post('/__recovery/restart', {}); await waitAndReload() }
    catch (error) { document.body.classList.remove('busy'); note(error.message) }
  })
  document.getElementById('retry').addEventListener('click', async () => {
    body()
    try { await post('/__recovery/restart', {}); await waitAndReload() }
    catch (error) { document.body.classList.remove('busy'); note(error.message) }
  })
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
        return send(200, { ok: true, ...selectSafe(env) }), true
      case 'restart':
        return send(200, restartSoon()), true
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
