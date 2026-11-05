/**
 * Connector — the OAuth pieces: one-time `state` bookkeeping for the Gitea
 * authorization-code flow, and the URL builders both flows share.
 *
 * WHY A SEPARATE MODULE
 * --------------------
 * The state map is the only mutable, cross-request object in this plugin's login
 * path, and the rules on it are load-bearing security rules:
 *
 *   * `state` is an OPAQUE one-time token — 32 random bytes, base64url — never
 *     derived from a credential, a user id, or a timestamp;
 *   * it is SINGLE-USE: `consume()` removes it, so a replayed callback (a
 *     refreshed tab, a mail scanner following the URL twice, an attacker
 *     replaying a captured link) is refused rather than exchanged again;
 *   * it EXPIRES after ten minutes, because a browser tab left open forever is
 *     not a login;
 *   * the map is BOUNDED, so a caller that starts a thousand logins cannot make
 *     this process grow without limit.
 *
 * Nothing in this module ever holds a client secret or a token beyond the
 * exchange itself: `buildAuthorizeUrl` only writes the PUBLIC client id and the
 * state, and `exchangeCode` hands the secret it is given straight to one request
 * body and returns the access token to its caller.
 *
 * CLOUDFLARE IS PKCE-ONLY (public client, `token_endpoint_auth_method: none`)
 * --------------------------------------------------------------------------
 * Cloudflare's self-managed OAuth clients (Manage Account → OAuth clients) are
 * ordinary RFC 6749/7636/7009 endpoints on `https://dash.cloudflare.com`:
 * `/oauth2/auth`, `/oauth2/token`, `/oauth2/revoke` (see `/.well-known/
 * openid-configuration`, which advertises `code_challenge_methods_supported:
 * ["plain","S256"]` and `token_endpoint_auth_methods_supported` including
 * `none`). A desktop/self-hosted app like DSH cannot keep a client secret, so
 * this module mints a fresh verifier per attempt and never registers a secret:
 * the verifier stays in the state entry (memory, single-use, bounded, ten-minute
 * TTL) and travels to exactly one token request.
 *
 * @module dsh-connector/lib/oauth
 */

import { createHash, randomBytes } from 'node:crypto'
import { normalizeBaseUrl } from './providers/gitea.js'

/** How long one authorization attempt stays valid. */
export const STATE_TTL_MS = 10 * 60 * 1000

/** How many pending authorizations are remembered at once. */
const STATE_CAPACITY = 16

/**
 * Canonicalize a `state` value that arrived in a query string.
 *
 * WHY THIS EXISTS. A state is 32 random bytes as base64url, so it is already
 * URL-safe — but the value travels through whatever reverse proxy the operator
 * put in front of the GUI, and a proxy (or a second encoder) may hand the query
 * parameter over percent-encoded (`%2D` for `-`, `%3D`, …) or with a stray
 * trailing newline. An exact string compare then refuses a login that is
 * perfectly valid, which is indistinguishable from "the login link is unknown".
 *
 * The rules are deliberately narrow so canonicalization can never widen the
 * attack surface:
 *   * whitespace around the value is dropped (a header artifact, never data);
 *   * ONE percent-decoding pass is applied, and ONLY when the decoded text is
 *     entirely base64url — i.e. it looks exactly like a state this store minted;
 *   * nothing else is rewritten: no case folding, no `+`/space translation, no
 *     truncation. Two distinct live states therefore cannot collide, and the
 *     attacker still needs the 256 bits of entropy.
 *
 * @param value - the raw `state` from the query string.
 * @returns the canonical form (possibly the input, unchanged).
 */
export function normalizeStateValue(value) {
  let key = typeof value === 'string' ? value.trim() : ''
  if (key === '') return ''
  if (key.includes('%')) {
    try {
      const decoded = decodeURIComponent(key)
      if (/^[A-Za-z0-9_-]+$/u.test(decoded)) key = decoded
    } catch {
      // A malformed escape stays as-is: the lookup simply misses, which is the
      // same answer as any other unknown state, and nothing is thrown at a
      // browser navigation.
    }
  }
  return /^[A-Za-z0-9_-]+$/u.test(key) ? key : ''
}

/**
 * The same-origin callback path the plugin's Host half answers.
 *
 * It is derived from the GUI origin at REQUEST time (`callbackUrlOf`), never
 * stored, so a harness that is opened on another port still exchanges correctly —
 * the value must match what the user pasted into their Gitea application exactly,
 * and the guide renders the live one.
 */
export const GITEA_CALLBACK_PATH = '/api/connector/oauth/gitea/callback'

/**
 * The one-time state store.
 *
 * Entries are `{ provider, alias, extra, createdAt }`. The value is random, so an
 * entry carries no fact a caller could forge: knowing a state string is the only
 * way to match it, and consuming it destroys it. `extra` exists for the PKCE
 * verifier (Cloudflare): it rides with the state so the two cannot be mixed
 * across attempts, and it is destroyed at the same moment.
 */
export function createStateStore({ ttlMs = STATE_TTL_MS, capacity = STATE_CAPACITY, now = () => Date.now() } = {}) {
  const entries = new Map()

  /** Drop everything past its deadline. Called before every write and read. */
  function prune() {
    const at = now()
    for (const [state, entry] of entries) {
      if (at - entry.createdAt > ttlMs) entries.delete(state)
    }
  }

  return {
    /** How many attempts are pending right now (tests and the page's own sanity). */
    get size() {
      prune()
      return entries.size
    },

    /**
     * Mint one state value and remember what it is for.
     * @param context - `{ provider, alias }` the callback will act on.
     * @returns the opaque state string.
     */
    issue({ provider, alias, extra }) {
      prune()
      // Bounded: drop the OLDEST pending attempt rather than the newest, so a
      // flood of starts cannot evict the login the user is actually completing.
      while (entries.size >= capacity) entries.delete(entries.keys().next().value)
      const state = randomBytes(32).toString('base64url')
      entries.set(state, { provider, alias, extra, createdAt: now() })
      return state
    },

    /**
     * Read and DESTROY one state value.
     * @param state - the value the callback received.
     * @returns the context it was issued for, or `undefined` when it is unknown,
     *   already consumed, or past its deadline.
     */
    consume(state) {
      const key = normalizeStateValue(state)
      if (key === '') return undefined
      prune()
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      entries.delete(key)
      return entry
    },

    /** Whether a value is still live — a READ, for inspection only. */
    has(state) {
      prune()
      return entries.has(normalizeStateValue(state))
    },

    /**
     * Forget every pending attempt issued FOR ONE PROVIDER.
     *
     * A logout (or a single abandoned login) is scoped: dropping a Gitea state
     * must not cancel an in-flight Cloudflare authorization, and the reverse. The
     * clear is by the provider the entry was minted for, never by "everything".
     *
     * @param provider - provider id (`gitea`, `cloudflare`, …).
     * @returns how many attempts were dropped.
     */
    clearProvider(provider) {
      prune()
      let removed = 0
      for (const [state, entry] of entries) {
        if (entry.provider === provider) { entries.delete(state); removed += 1 }
      }
      return removed
    },

    /** Forget everything (test teardown, or a host that really means "all"). */
    clear() {
      entries.clear()
    },
  }
}

/**
 * The Gitea WEB origin for a configured base.
 *
 * The configured value is the API root (`https://git.example.com/api/v1`), while
 * the OAuth pages live on the instance itself — so the `/api/v1` suffix is
 * stripped here. `normalizeBaseUrl` has already refused a non-http(s) URL and one
 * carrying embedded credentials, which is what keeps this from becoming an
 * open-redirect primitive.
 *
 * @param apiBase - configured base (`https://git.example.com` or `…/api/v1`).
 * @returns the instance origin, or `''` when unconfigured.
 */
export function giteaWebOrigin(apiBase) {
  const root = normalizeBaseUrl(apiBase)
  if (root === '') return ''
  return root.replace(/\/api\/v1$/u, '').replace(/\/+$/u, '')
}

/**
 * Build the authorize URL the Login click opens in a new tab.
 *
 * Everything here is PUBLIC: the client id travels in a URL by design, and the
 * state is a value this plugin just minted. The client secret is deliberately
 * absent — it exists only in the token exchange.
 *
 * @param options - wiring.
 * @param options.apiBase - the configured Gitea base URL.
 * @param options.clientId - the public OAuth2 application client id.
 * @param options.redirectUri - the same-origin callback URL.
 * @param options.state - the one-time state.
 * @returns the absolute authorize URL.
 */
export function buildGiteaAuthorizeUrl({ apiBase, clientId, redirectUri, state }) {
  const origin = giteaWebOrigin(apiBase)
  if (origin === '') {
    const error = new TypeError('Gitea base URL is not configured; set it on the Gitea card before logging in')
    error.code = 'CONNECTOR_BAD_REQUEST'
    throw error
  }
  const url = new URL(`${origin}/login/oauth/authorize`)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  // `state` is REQUIRED here: without it the callback could not tell one attempt
  // from another, and the single-use rule would have nothing to bind to.
  url.searchParams.set('state', state)
  return url.toString()
}

/**
 * Build a same-origin callback URL for one GUI origin.
 *
 * The origin is taken from the request the browser actually made (`Host`, or the
 * forwarded pair) so the value matches the address bar — Gitea requires an exact
 * match with the registered redirect URI, and a hard-coded port would break any
 * deployment that is not on 3079.
 *
 * @param origin - `scheme://host[:port]`.
 * @returns the absolute callback URL.
 */
export function callbackUrlOf(origin) {
  const base = typeof origin === 'string' && origin !== '' ? origin.replace(/\/+$/u, '') : ''
  return `${base}${GITEA_CALLBACK_PATH}`
}

/**
 * The GUI origin a request arrived on, when the harness can tell us.
 *
 * Preference order: the forwarded origin/host a reverse proxy sets, then the
 * plain `Host` header. A request with neither (a unit test, a bare socket) gets
 * `''`, which makes the caller fall back to its configured/observed origin rather
 * than inventing `localhost:80`.
 *
 * @param headers - the request headers (any `{ [name]: value }` object).
 * @param fallback - origin to use when the headers say nothing.
 * @returns the origin, or the fallback.
 */
export function originOfRequest(headers, fallback = '') {
  const read = (name) => {
    const value = headers?.[name] ?? headers?.[String(name).toLowerCase()]
    if (Array.isArray(value)) return String(value[0] ?? '')
    return typeof value === 'string' ? value : ''
  }
  // `x-forwarded-proto` is attacker-controlled too, and it lands in a redirect URI
  // the provider compares exactly. Only `http`/`https` are accepted; anything else
  // (absent, `file`, a header-injection attempt) falls back to `https` rather than
  // being reflected into the URL.
  const forwardedScheme = read('x-forwarded-proto').split(',')[0].trim().toLowerCase()
  const scheme = /^https?$/u.test(forwardedScheme) ? forwardedScheme : 'https'
  const forwardedHost = read('x-forwarded-host').split(',')[0].trim()
  const host = forwardedHost !== '' ? forwardedHost : read('host')
  // A Host header is attacker-controlled in general, so it is used ONLY to build
  // a redirect URI that the provider then compares with its own registration.
  // Anything outside a plausible host shape falls back rather than reflecting.
  if (!/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(host)) return fallback
  return `${scheme}://${host}`
}

/**
 * Exchange an authorization code for an access token.
 *
 * The client secret is a parameter of this function and lives only inside the
 * request body: it is not logged, not returned, and not compared. The caller keeps
 * the returned token in memory for exactly as long as it takes to hand it to
 * `ctx.credentials.set`, and the answer object below never includes the raw
 * provider body (a server that echoes the request must not reach a log).
 *
 * @param options - wiring.
 * @param options.apiBase - the configured Gitea base URL.
 * @param options.clientId - the public client id.
 * @param options.clientSecret - the SECRET, resolved at call time.
 * @param options.code - the authorization code from the callback.
 * @param options.redirectUri - the same `redirect_uri` used in the authorize step.
 * @param options.request - injected HTTP function (`(url, init) => response`).
 * @returns `{ ok, status, accessToken?, scope?, reason? }` — never the code or the secret.
 */
export async function exchangeGiteaCode({ apiBase, clientId, clientSecret, code, redirectUri, request }) {
  const origin = giteaWebOrigin(apiBase)
  if (origin === '') {
    const error = new TypeError('Gitea base URL is not configured; set it on the Gitea card before logging in')
    error.code = 'CONNECTOR_BAD_REQUEST'
    throw error
  }
  const answer = await request(`${origin}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    // Gitea's token endpoint takes the client credentials in the BODY (it is a
    // confidential client), and answers JSON when asked politely with Accept.
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }).toString(),
  })
  const body = answer.json ?? {}
  if (!answer.ok) {
    // Status only: a provider error body could quote the code or the secret.
    return { ok: false, status: Number(answer.status ?? 0), reason: 'the token exchange was refused' }
  }
  const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
  if (accessToken === '') {
    return { ok: false, status: Number(answer.status ?? 200), reason: 'the token exchange answered without an access_token' }
  }
  return {
    ok: true,
    status: Number(answer.status ?? 200),
    accessToken,
    ...(typeof body.scope === 'string' && body.scope !== '' ? { scope: body.scope } : {}),
  }
}

/** The same-origin callback path for Cloudflare's authorization-code flow. */
export const CLOUDFLARE_CALLBACK_PATH = '/api/connector/oauth/cloudflare/callback'

/**
 * Cloudflare's OAuth origin. Both the authorize and the token endpoint live on
 * the dashboard host, NOT on `api.cloudflare.com`: the API host serves the REST
 * verbs, the dashboard host serves the OAuth server.
 */
export const CLOUDFLARE_OAUTH_ORIGIN = 'https://dash.cloudflare.com'

/**
 * The scope list one Cloudflare login asks for — THE WANT-LIST, in the order the
 * panel renders and the authorize call sends.
 *
 * GROUND TRUTH = the dashboard's "Select permission scopes" picker, refreshed on
 * 2026-11-04 for the user's live account. Three corrections are baked in here
 * because each one silently cost an action before this list existed:
 *
 *   1. **`zone-settings.read` / `zone-settings.write`** — NOT
 *      `config-settings.*`. The catalogue lists "Zone Settings Read/Write" under
 *      *DNS & Zones*, and that is what gates `GET|PATCH /zones/{id}/settings`
 *      ("Zone Settings Read"). `config-settings.*` is a SEPARATE id under *Rules &
 *      Configuration*; requesting it does not unlock `/settings`. Both ids stay
 *      in the list (different actions use them), but the zone-settings verbs now
 *      name the right one in their 403.
 *   2. **`account-firewall-access-rules.read` / `.write`** — "Account Firewall
 *      Access Rules …". `account-rule-lists.*` is a different surface (rule
 *      LISTS, not the per-zone/account access rules this connector edits), so
 *      both pairs are requested and the access-rule verbs name the firewall pair.
 *   3. **DDoS**: `ddos-protection.read` gates the feature, and the L7 entrypoint
 *      that actually holds OVERRIDE rules is served under
 *      `http-ddos-managed-ruleset.read`. A `ddos_l7` read therefore asks for BOTH
 *      — the deny-check names both ids, and the server decides which one it
 *      wanted.
 *
 * Pages ids stay SINGULAR (`page.read`, `page.write`): the dashboard's own
 * wording is "Pages Read (page.read)". Plural `pages.*` and the colon form are
 * not valid ids and are rejected with `invalid_scope`.
 *
 * `offline_access` is a PROTOCOL scope from the "Other" group, never a permission:
 * a client gains it from its `grant_types`, and it is in the AUTHORIZE list
 * because that is what makes the server issue a refresh token.
 *
 * `account.read` is still DELIBERATELY ABSENT: the picker of a live account may
 * expose no such entry, and the Pages verbs are account-scoped by PATH
 * (`/accounts/{id}/pages/projects`). The account-scoped ids that ARE requested
 * are the two pairs the connector's own actions need (firewall access rules,
 * rule lists).
 *
 * A client that grants only part of the list still logs in; the actions whose
 * scope is missing answer 403, which the operations layer classifies as
 * `CONNECTOR_PROVIDER_ERROR` (route 424) with the endpoint AND the missing scope
 * id named (see `CLOUDFLARE_SCOPE_IDS` in `providers/cloudflare.js`).
 *
 * The live catalogue is `GET https://api.cloudflare.com/client/v4/oauth/scopes`
 * (authenticated, pre-authorization). The guide names it so a user who needs
 * another permission can add it verbatim.
 */
export const CLOUDFLARE_DEFAULT_SCOPES = [
  // Pages — the dashboard's picker: "Pages Write (page.write)", "Pages Read (page.read)".
  'page.write', 'page.read',
  // Protocol scope from the "Other" group — added by the Refresh Token grant.
  'offline_access',
  // DNS & Zones.
  'dns.write', 'dns.read',
  'zone.read', 'zone.write',
  // THE gatekeepers for /zones/{id}/settings (NOT config-settings.*).
  'zone-settings.read', 'zone-settings.write',
  // WAF rulesets and their phase entry points.
  'zone-waf.read', 'zone-waf.write',
  // DDoS: the feature id AND the L7 managed-ruleset entrypoint file.
  'ddos-protection.read', 'http-ddos-managed-ruleset.read',
  // Access rules (the surface this connector edits) …
  'account-firewall-access-rules.read', 'account-firewall-access-rules.write',
  // … and rule LISTS (a different surface, requested on purpose).
  'account-rule-lists.read', 'account-rule-lists.write',
  // Rules & Configuration: a separate id for its own endpoints.
  'config-settings.read', 'config-settings.write',
  // GraphQL analytics.
  'analytics.read',
]

/**
 * The same-origin callback URL for one GUI origin.
 * @param origin - `scheme://host[:port]`.
 * @returns the absolute callback URL.
 */
export function cloudflareCallbackUrlOf(origin) {
  const base = typeof origin === 'string' && origin !== '' ? origin.replace(/\/+$/u, '') : ''
  return `${base}${CLOUDFLARE_CALLBACK_PATH}`
}

/**
 * Which redirect origins a provider will actually accept.
 *
 * CLOUDFLARE'S RULE, and the reason a login can fail before any consent screen:
 * a redirect URL must be HTTPS, or HTTP **only** when the host's suffix is
 * exactly `localhost` (`http://localhost:3079` is fine, `http://127.0.0.1:3079`
 * is not). Cloudflare answers `invalid_request` — "Redirect URL is using an
 * insecure protocol" — for anything else, so this is checked BEFORE a state is
 * minted: a login that cannot complete must not leave a pending attempt behind.
 *
 * GITEA IS NOT COVERED HERE and stays permissive: a self-hosted instance is
 * routinely reachable over plain HTTP on a LAN address, and Gitea itself only
 * compares the redirect string with what was registered.
 *
 * @param origin - `scheme://host[:port]`, no path.
 * @returns whether Cloudflare would accept a redirect on this origin.
 */
export function isCloudflareRedirectOrigin(origin) {
  let url
  try {
    url = new URL(String(origin ?? ''))
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  // Cloudflare's own wording: "http is only allowed for hosts with suffix
  // localhost". `localhost`, `app.localhost`, `127.0.0.1`? No — 127.0.0.1 has no
  // localhost suffix, which is exactly the failure this guard names.
  return /(^|\.)localhost$/iu.test(url.hostname)
}

/**
 * Mint one PKCE pair (RFC 7636, `S256`).
 *
 * The verifier is 32 random bytes as base64url — 43 characters, inside the
 * spec's 43–128 range and drawn from the unreserved alphabet — and the challenge
 * is `BASE64URL(SHA256(ASCII(verifier)))`. Both are returned to the caller: the
 * verifier is parked in the state entry, the challenge travels in the URL.
 *
 * @returns `{ verifier, challenge, method: 'S256' }`.
 */
export function createPkcePair() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
  return { verifier, challenge, method: 'S256' }
}

/**
 * Build the Cloudflare authorize URL the Login click opens in a new tab.
 *
 * Everything in it is public: the client id, the redirect URI, the scope list,
 * the one-time state and the PKCE challenge. There is no client secret, by
 * design — a Cloudflare client with `token_endpoint_auth_method: none` has none.
 *
 * @param options - wiring.
 * @param options.clientId - the PUBLIC registered client id.
 * @param options.redirectUri - this deployment's same-origin callback.
 * @param options.state - the one-time state minted with the verifier.
 * @param options.challenge - the S256 code challenge.
 * @param options.scopes - scope ids; joined with a single space.
 * @param options.origin - OAuth origin (defaults to the dashboard host).
 * @returns the absolute authorize URL.
 */
export function buildCloudflareAuthorizeUrl({ clientId, redirectUri, state, challenge, scopes, origin = CLOUDFLARE_OAUTH_ORIGIN }) {
  const url = new URL(`${String(origin).replace(/\/+$/u, '')}/oauth2/auth`)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  // Cloudflare advertises both `plain` and `S256`; this client only ever sends
  // `S256`, which is the one that actually protects the code.
  url.searchParams.set('code_challenge_method', 'S256')
  if (Array.isArray(scopes) && scopes.length > 0) url.searchParams.set('scope', scopes.join(' '))
  return url.toString()
}

/**
 * Exchange an authorization code at the Cloudflare token endpoint (PKCE, no
 * client secret).
 *
 * The verifier is a parameter of this function and lives only inside the request
 * body for the life of one call. The answer object never includes the raw
 * provider body, so a server that echoes the request cannot reach a log.
 *
 * @param options - wiring.
 * @param options.clientId - the public client id.
 * @param options.code - the authorization code from the callback.
 * @param options.redirectUri - the same `redirect_uri` used in the authorize step.
 * @param options.codeVerifier - the PKCE verifier minted for this attempt.
 * @param options.request - injected HTTP function.
 * @param options.origin - OAuth origin (defaults to the dashboard host).
 * @returns `{ ok, status, accessToken?, refreshToken?, expiresIn?, scope?, reason? }`.
 */
export async function exchangeCloudflareCode({ clientId, code, redirectUri, codeVerifier, request, origin = CLOUDFLARE_OAUTH_ORIGIN }) {
  const answer = await request(`${String(origin).replace(/\/+$/u, '')}/oauth2/token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }).toString(),
  })
  const body = answer.json ?? {}
  if (!answer.ok) {
    // Status only: a provider body could quote the code or the verifier.
    return { ok: false, status: Number(answer.status ?? 0), reason: 'the token exchange was refused' }
  }
  const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
  if (accessToken === '') {
    return { ok: false, status: Number(answer.status ?? 200), reason: 'the token exchange answered without an access_token' }
  }
  return {
    ok: true,
    status: Number(answer.status ?? 200),
    accessToken,
    ...(typeof body.refresh_token === 'string' && body.refresh_token !== '' ? { refreshToken: body.refresh_token } : {}),
    ...(Number.isFinite(Number(body.expires_in)) ? { expiresIn: Number(body.expires_in) } : {}),
    ...(typeof body.scope === 'string' && body.scope !== '' ? { scope: body.scope } : {}),
  }
}

/**
 * Refresh an access token (`grant_type=refresh_token`, PKCE client, no secret).
 *
 * Cloudflare rotates the refresh token on use, so the caller must store the one
 * in the answer when it is present. A refusal is reported by status only.
 *
 * @param options - wiring.
 * @param options.clientId - the public client id.
 * @param options.refreshToken - the refresh token resolved at call time.
 * @param options.request - injected HTTP function.
 * @param options.origin - OAuth origin (defaults to the dashboard host).
 * @returns `{ ok, status, accessToken?, refreshToken?, expiresIn?, reason? }`.
 */
export async function refreshCloudflareToken({ clientId, refreshToken, request, origin = CLOUDFLARE_OAUTH_ORIGIN }) {
  const answer = await request(`${String(origin).replace(/\/+$/u, '')}/oauth2/token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    }).toString(),
  })
  const body = answer.json ?? {}
  if (!answer.ok) return { ok: false, status: Number(answer.status ?? 0), reason: 'the refresh was refused' }
  const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
  if (accessToken === '') return { ok: false, status: Number(answer.status ?? 200), reason: 'the refresh answered without an access_token' }
  return {
    ok: true,
    status: Number(answer.status ?? 200),
    accessToken,
    ...(typeof body.refresh_token === 'string' && body.refresh_token !== '' ? { refreshToken: body.refresh_token } : {}),
    ...(Number.isFinite(Number(body.expires_in)) ? { expiresIn: Number(body.expires_in) } : {}),
  }
}

/**
 * Revoke one token at the Cloudflare revocation endpoint (RFC 7009).
 *
 * Best effort by contract: the caller unsets the reference regardless, and a
 * provider refusal is reported by status, never by echoing the token.
 *
 * @param options - wiring.
 * @param options.clientId - the public client id.
 * @param options.token - the access or refresh token being revoked.
 * @param options.tokenTypeHint - `access_token` or `refresh_token`.
 * @param options.request - injected HTTP function.
 * @param options.origin - OAuth origin (defaults to the dashboard host).
 * @returns `{ ok, status }`.
 */
export async function revokeCloudflareToken({ clientId, token, tokenTypeHint = 'access_token', request, origin = CLOUDFLARE_OAUTH_ORIGIN }) {
  try {
    const answer = await request(`${String(origin).replace(/\/+$/u, '')}/oauth2/revoke`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, token, token_type_hint: tokenTypeHint }).toString(),
    })
    return { ok: answer.ok === true, status: Number(answer.status ?? 0) }
  } catch {
    // A network failure during logout must not stop the local unset: the caller
    // clears the reference either way, and says so.
    return { ok: false, status: 0 }
  }
}

/**
 * Escape text for interpolation into the completion page.
 *
 * The page is a constant template, so this exists for defence in depth: nothing
 * user-controlled is ever inserted, and if that ever changes the escaping is
 * already in place.
 *
 * @param value - candidate text.
 * @returns HTML-safe text.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#39;')
}

/**
 * The constant HTML shell both callback pages share.
 *
 * Nothing user-controlled is interpolated here: the caller passes finished body
 * lines (already escaped where they carry provider text) and the script lines.
 * The document loads NOTHING (no fonts, no images, no network) so the page works
 * behind the strictest CSP and leaves no request behind it.
 */
function pageShell({ title, tone, body, scripts }) {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    ':root{color-scheme:light dark}',
    'body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:Canvas;color:CanvasText}',
    'main{max-width:460px;padding:28px 32px;border-radius:12px;border:1px solid rgba(128,128,128,.3);text-align:center}',
    `strong{display:block;font-size:17px;margin-bottom:6px;color:${tone}}`,
    'p{margin:0;opacity:.78}',
    'section{margin-top:16px;padding-top:12px;border-top:1px dashed rgba(128,128,128,.35)}',
    'h2{font-size:13px;margin:0 0 8px;letter-spacing:.04em;text-transform:uppercase;opacity:.7}',
    'ol{margin:0;padding-left:20px;display:grid;gap:6px;opacity:.85}',
    'li{text-align:left}',
    'code{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.95;word-break:break-word}',
    'p.kv{text-align:left;margin:0 0 6px}',
    '</style></head><body><main>',
    ...body,
    '</main>',
    '<script>',
    ...scripts,
    '</script>',
    '</body></html>',
  ].join('\n')
}

/**
 * The nudge every callback page sends to its opener.
 *
 * Best-effort and guarded: tell a same-origin opener to re-read the state so the
 * badge flips and its panel closes without a manual reload. An exception here
 * would be the only thing the user sees, hence the try/catch.
 */
const NUDGE_SCRIPT = 'try{if(window.opener&&!window.opener.closed){window.opener.postMessage({type:"connector:oauth-complete"},window.location.origin)}}catch(e){}'

/**
 * The tiny completion page the callback answers with.
 *
 * A CONSTANT. It names no reference, no account, no code, no state and no token —
 * only that the login finished and the tab can be closed. On SUCCESS the page
 * also closes ITSELF: the Login click opened this tab, which is the case browsers
 * allow `window.close()` for, and it runs only when a real opener exists so a
 * standalone visit keeps its readable text instead of vanishing.
 *
 * DIAGNOSTICS (non-secret, and only diagnostics). A login that fails at the token
 * step is dominated by ONE question: which `redirect_uri` did this host actually
 * send, and was it the one registered on the OAuth client? That string is public
 * — it is in the authorize URL, in the address bar and in every log line at
 * Cloudflare — so the page carries it as a `data-` attribute plus the typed
 * failure class, and nothing else. The code, the state and both tokens stay out:
 * the attribute set is whitelisted here, not assembled from a provider body.
 *
 * @param options - wiring.
 * @param options.ok - whether the exchange succeeded.
 * @param options.message - a SHORT, constant-ish reason (never a value).
 * @param options.redirectUri - the callback URL this attempt actually used (public).
 * @param options.errorCode - the typed failure class (`CONNECTOR_PROVIDER_ERROR`, …).
 * @param options.manual - whether this looks like a hand-typed visit, not a redirect.
 * @returns the HTML document.
 */
export function completionPage({ ok, message, redirectUri = '', errorCode = '', manual = false }) {
  const tone = ok === true ? '#1f7a3d' : '#a8323a'
  const title = ok === true ? 'Login complete' : 'Login not completed'
  // A success page says ONE thing. The reference name, the alias, the code and
  // the state are all deliberately absent: this tab can be screenshotted, shared,
  // or left open on a shared machine, and the Connector page itself already shows
  // which reference resolved.
  const line = ok === true
    ? 'Login complete — this tab closes itself. You can also close it manually if your browser blocked that.'
    : escapeHtml(trimMessage(message))
  const redirect = typeof redirectUri === 'string' && /^https?:\/\//u.test(redirectUri) ? redirectUri : ''
  const kind = typeof errorCode === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(errorCode) ? errorCode : ''
  const diagnostics = [
    redirect === '' ? '' : `<p class="kv">Redirect URI: <code data-connector-redirect-uri="${escapeHtml(redirect)}">${escapeHtml(redirect)}</code></p>`,
    kind === '' ? '' : `<p class="kv">Reason class: <code data-connector-error-kind="${escapeHtml(kind)}">${escapeHtml(kind)}</code></p>`,
    manual === true
      ? '<p class="kv">This is the OAuth callback endpoint. Opening it by hand cannot complete a login; start from the Connector card and let the provider redirect here.</p>'
      : '',
  ].filter(part => part !== '')
  return pageShell({
    title,
    tone,
    body: [
      `<strong>${title}</strong>`,
      `<p>${line}</p>`,
      diagnostics.length === 0
        ? ''
        : `<section data-connector-diagnostics="true"><h2>Diagnostics</h2>${diagnostics.join('')}</section>`,
    ],
    scripts: [
      NUDGE_SCRIPT,
      // CLOSE OURSELVES — on SUCCESS only. A blocked close is harmless: the page
      // still says "Login complete".
      ok === true ? 'try{if(window.opener){window.close()}}catch(e){}' : '',
    ],
  })
}

/**
 * The page a browser lands on when the provider REDIRECTS WITH AN OAUTH ERROR
 * instead of an authorization code (`?error=invalid_scope&error_description=…`).
 *
 * That is not a host bug and it must not be a dead end: Cloudflare refuses a
 * request for any scope the registered OAuth client does not allow, so the page
 * names the error, repeats the provider's own description (ESCAPED — it is
 * provider-controlled text), and prints the exact place to fix it. Nothing else
 * from the query string is echoed: no code, no state, no client id.
 *
 * @param options - wiring.
 * @param options.provider - `cloudflare` or `gitea` (picks the fix-it steps).
 * @param options.error - the OAuth `error` code, e.g. `invalid_scope`.
 * @param options.description - the OAuth `error_description` (provider text).
 * @returns the HTML document.
 */
export function callbackErrorPage({ provider = 'cloudflare', error = '', description = '' }) {
  const errorName = escapeHtml(String(error ?? '').slice(0, 80))
  const detail = escapeHtml(trimMessage(description))
  const steps = provider === 'cloudflare'
    ? [
      'Open dash.cloudflare.com → Manage Account → OAuth clients → your client → Select permission scopes → add the scope named in the message above (e.g. page.read) → retry Login from Connector.',
      'Connector asks for: page.write, page.read, offline_access. Your OAuth client must allow EVERY scope Connector requests — Cloudflare refuses the rest with invalid_scope. If the client lacks the page.* scopes, edit the client (or recreate it) with the scope selection above; the same client can also be updated with PATCH /client/v4/accounts/{account_id}/oauth_clients/{client_id}.',
      'If you do not want to widen the client, change the requested list in the Connector Login panel (Scopes → Edit) and press Save, then retry Login.',
    ]
    : [
      'Open your Gitea instance → the OAuth2 application → check its allowed scopes and redirect URI, then retry Login from Connector.',
      'If you do not want to widen the application, change the requested list in the Connector Login panel (Scopes → Edit) and press Save, then retry Login.',
    ]
  const body = [
    '<strong>Login not completed</strong>',
    `<p>The provider refused the authorization before any token was issued (${errorName}).</p>`,
    '<section data-connector-troubleshoot="true">',
    '<h2>Troubleshooting</h2>',
    `<p class="kv">Error: <code>${errorName}</code></p>`,
    detail === '' ? '' : `<p class="kv">Message: <code>${detail}</code></p>`,
    `<ol>${steps.map(step => `<li>${step}</li>`).join('')}</ol>`,
    '</section>',
  ]
  return pageShell({
    title: 'Login not completed',
    tone: '#a8323a',
    body,
    scripts: [NUDGE_SCRIPT],
  })
}

/**
 * Bound a failure message before it reaches a page.
 *
 * The messages this plugin raises are its own constants, but a page is the one
 * place a length is user-visible, so it is capped here too: a long provider error
 * must not be able to fill the tab.
 *
 * @param message - candidate message.
 * @returns a short, single-paragraph reason.
 */
function trimMessage(message) {
  const text = String(message ?? '').trim()
  if (text === '') return 'Login not completed.'
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}
