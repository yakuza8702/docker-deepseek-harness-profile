/**
 * Cloudflare adapter — api.cloudflare.com client v4.
 *
 * Cloudflare's tokens are scoped, so "which calls work" is a property of the
 * token, not of this plugin. The adapter therefore reports the account and
 * project surface it can actually see and degrades with an explicit message
 * (never a partial result) when a scope is missing.
 *
 * LOGIN IS OAUTH. Cloudflare ships self-managed OAuth clients (Manage Account →
 * OAuth clients), and this plugin runs a real authorization-code flow against
 * them: PKCE `S256` (the client is registered `token_endpoint_auth_method:
 * none`, so there is NO client secret), `GET https://dash.cloudflare.com/oauth2/
 * auth` → `POST https://dash.cloudflare.com/oauth2/token`, then a refresh grant
 * and `POST /oauth2/revoke` on logout. Those calls live in `lib/oauth.js` and
 * `lib/operations.js`; this module only speaks the API surface below.
 *
 * `verify()` — `GET /user/tokens/verify` — is the token check the Connector
 * page's "Test connection" uses. It works for an OAuth ACCESS token exactly as
 * it does for a dashboard-created API token, which is why the same check covers
 * both. A 401 there (or on any other call) is the ONE signal that lets the
 * operations layer attempt a single refresh-and-retry; 403 is a permission
 * refusal and never becomes a refresh.
 *
 * The token is only ever the `Authorization: Bearer …` header of the request it
 * belongs to. Push goes through `wrangler` with the stored token in the
 * subprocess environment — never argv, never config, never a URL. `wrangler` is
 * Cloudflare's own first-party client and is used ONLY for the deploy subprocess;
 * the login is the OAuth flow above.
 *
 * @module dsh-connector/lib/providers/cloudflare
 */

const API_VERSION = '2024-01-01'
/** Cloudflare account/zone/rule ids are 32 lowercase hex characters. */
const CF_ACCOUNT_ID = /^[0-9a-f]{32}$/u

/**
 * THE GATEKEEPER IDS, by surface — the canonical strings this adapter names when
 * a 403 means "this token may not do that".
 *
 * Pinned against the dashboard catalogue as refreshed on 2026-11-04, because two
 * of them are counter-intuitive and were wrong in an earlier build:
 *
 *   * `/zones/{id}/settings` is gated by `zone-settings.read|write` ("Zone
 *     Settings Read/Write", *DNS & Zones*) — NOT by `config-settings.*`, which is
 *     a separate id under *Rules & Configuration* for its own endpoints;
 *   * access rules are gated by `account-firewall-access-rules.read|write` — NOT
 *     by `account-rule-lists.*`, which covers rule LISTS;
 *   * the L7 DDoS override entry point is served under
 *     `http-ddos-managed-ruleset.read` on top of `ddos-protection.read`.
 *
 * Every id here is also in `CLOUDFLARE_DEFAULT_SCOPES` (`lib/oauth.js`), so a
 * fresh consent asks for exactly what the 403 messages name. Naming an id is not
 * a secret: scope ids travel in the authorize URL.
 */
export const CLOUDFLARE_SCOPE_IDS = {
  zoneRead: 'zone.read',
  zoneWrite: 'zone.write',
  dnsRead: 'dns.read',
  dnsWrite: 'dns.write',
  wafRead: 'zone-waf.read',
  wafWrite: 'zone-waf.write',
  zoneSettingsRead: 'zone-settings.read',
  zoneSettingsWrite: 'zone-settings.write',
  ddosProtectionRead: 'ddos-protection.read',
  ddosManagedRulesetRead: 'http-ddos-managed-ruleset.read',
  // The WRITE half of the L7 managed-ruleset file — the gate for creating the
  // FIRST ddos_l7 override (PUT entry point).
  ddosManagedRulesetWrite: 'http-ddos-managed-ruleset.write',
  // The botnet feed endpoints (GET .../botnet_feed/asn/{asn}/full_report|day_report).
  botnetFeedRead: 'ddos-botnet-feed.read',
  accessRulesRead: 'account-firewall-access-rules.read',
  accessRulesWrite: 'account-firewall-access-rules.write',
  analyticsRead: 'analytics.read',
}

/**
 * ADD-ON GATES — real catalogue ids that are deliberately NOT in the 20-id
 * want-list (`CLOUDFLARE_DEFAULT_SCOPES`).
 *
 * The want-list is what a FRESH consent asks for in one go. Some surfaces are
 * add-ons a user ticks only when they actually intend to use them, and putting
 * them in the default request would widen every login:
 *
 *   * `http-ddos-managed-ruleset.write` — only `ddos_override_set` (creating a
 *     first L7 override) needs it; the L7 READ works with the `.read` paired id
 *     that IS in the want-list;
 *   * `ddos-botnet-feed.read` — only `botnet_feed` needs it, and many accounts
 *     /plans do not expose the feed at all (the action degrades to an explicit
 *     "no scope" answer rather than asking for a permission that cannot work).
 *
 * The tests pin both facts: no add-on id may enter the want-list, and every
 * action's ids must be either a want-list id or a member of this set.
 */
export const CLOUDFLARE_ADDON_SCOPE_IDS = [
  CLOUDFLARE_SCOPE_IDS.ddosManagedRulesetWrite,
  CLOUDFLARE_SCOPE_IDS.botnetFeedRead,
]

/** The DDoS L7 entry point asks for BOTH ids: the server decides which it wanted. */
export const CLOUDFLARE_DDOS_SCOPES = [
  CLOUDFLARE_SCOPE_IDS.ddosProtectionRead,
  CLOUDFLARE_SCOPE_IDS.ddosManagedRulesetRead,
]

/**
 * THE PUBLIC SENTENCE for a token the API refused as expired/invalid.
 *
 * ONE constant, because it is now produced by three call sites (REST `unwrap`,
 * the GraphQL endpoint, and the identity probe chain) and the whole defect this
 * replaces was a WRONG-CAUSE message: an expired OAuth access token was reported
 * as "scope not granted … (needs zone-settings.read)", sending the user to
 * re-consent a permission that was never the problem.
 *
 * It names the action ("press Login"), never a value, a length or a mask.
 */
export const CLOUDFLARE_TOKEN_EXPIRED_MESSAGE = 'Cloudflare access token expired/invalid — press Login on the Connector page, then retry.'

/**
 * Does this answer say THE TOKEN ITSELF is dead?
 *
 * THE LIVE EVIDENCE this exists for: an expired OAuth access token answered
 *
 *   * `POST /graphql` → **401** `{"errors":[{"code":10000,"message":"Authentication error"}]}`
 *   * `GET /zones/{z}/settings` → **403** `{"errors":[{"code":10000,"message":"Invalid access token"}]}`
 *
 * The second one used to be classified as a missing SCOPE (403 ⇒ "scope not
 * granted … (needs zone-settings.read)") even though re-consenting cannot fix an
 * expired token. So the token signal is checked FIRST, and only after it fails can
 * a 403 mean "this token may not do THIS".
 *
 * The rules are evidence-based, never "any 403 is a permission" or "code 10000 is
 * always auth" (Cloudflare uses 10000 for ordinary permission refusals too — e.g.
 * "This token does not have permission for dns_records" — and those MUST keep
 * their scope guidance):
 *
 *   1. any **401** — the status Cloudflare uses only when the token itself is
 *      missing/expired/revoked (this was already the refresh trigger);
 *   2. a **403** whose message is an AUTHENTICATION phrase: `Invalid access
 *      token` / `invalid_token` (the live /settings body), `Authentication
 *      error`, or `Unable to authenticate request`;
 *   3. `code 1000` (CF's "Invalid API Token" code) with token-shaped text.
 *
 * Everything else — `This token does not have permission …`, `not authorized`,
 * `does not have access to the path`, `botnet feed is not available` — stays a
 * SCOPE refusal even when it carries code 10000.
 *
 * @param response - `{ status }` of the answer.
 * @param payload - the parsed `{ success, errors, result }` body.
 * @returns whether the failure is the TOKEN's, not a scope's.
 */
export function isInvalidTokenResponse(response, payload) {
  const status = Number(response?.status ?? 0)
  if (status !== 401 && status !== 403) return false
  // 401 IS the token's own refusal, whatever the wording rides along with it.
  if (status === 401) return true
  const errors = Array.isArray(payload?.errors) ? payload.errors : []
  const messages = errors.map(error => String(error?.message ?? '')).filter(message => message !== '')
  const codes = errors.map(error => Number(error?.code)).filter(code => Number.isFinite(code))
  for (const message of messages) {
    // "Invalid access token", "invalid_token" — the phrase Cloudflare used on the
    // live /settings 403. Not "invalid_request", not "does not have access".
    if (/^\s*invalid[\s_-]*(access[\s_-]+)?token\b/iu.test(message)) return true
    // The 401-wording that also appears on 403s in some zones' responses, and the
    // bare "Unable to authenticate request" body. Neither is a permission phrase.
    if (/^\s*(authentication\s+(error|failed|required)|unable\s+to\s+authenticate)\b/iu.test(message)) return true
  }
  // Code 1000 is CF's "Invalid API Token"; only token-shaped text makes it one.
  if (codes.includes(1000) && messages.some(message => (
    /\btoken\b/iu.test(message) && /\b(invalid|expired|revoked|not valid)\b/iu.test(message)
  ))) return true
  return false
}

/**
 * The scope ids one API call needs, from the label the call was given.
 *
 * The labels are the short, greppable names used in `unwrap(..., what)` — e.g.
 * `dns_records`, `dns_records/create`, `settings/{id} (PATCH)`,
 * `access_rules/patch`, `rulesets/phases/ddos_l7/entrypoint`. An unmapped label
 * returns `[]`, and the 403 message then keeps its generic wording instead of
 * inventing a scope id.
 *
 * @param what - the call label.
 * @returns the required scope ids (possibly several, e.g. for DDoS).
 */
export function requiredScopesForLabel(what) {
  const label = String(what ?? '')
  if (label === 'zones') return [CLOUDFLARE_SCOPE_IDS.zoneRead]
  if (/^zones\b/u.test(label)) return [CLOUDFLARE_SCOPE_IDS.zoneRead]
  if (label === 'dns_records') return [CLOUDFLARE_SCOPE_IDS.dnsRead]
  if (/^dns_records\b/u.test(label)) return [CLOUDFLARE_SCOPE_IDS.dnsWrite]
  if (/^access_rules\b/u.test(label)) {
    return label === 'access_rules' ? [CLOUDFLARE_SCOPE_IDS.accessRulesRead] : [CLOUDFLARE_SCOPE_IDS.accessRulesWrite]
  }
  // Zone settings FIRST: `settings` is the /zones/{id}/settings surface, and its
  // gatekeeper is zone-settings.*. The (PATCH) marker decides read vs write.
  if (/^settings\b/u.test(label)) {
    return /\(PATCH\)/u.test(label) ? [CLOUDFLARE_SCOPE_IDS.zoneSettingsWrite] : [CLOUDFLARE_SCOPE_IDS.zoneSettingsRead]
  }
  if (/^rulesets\b/u.test(label)) {
    // The DDoS L7 entry point is its own file and its own scope. A READ names
    // both DDoS ids (the server checks both and decides); the WRITE (creating the
    // first override) is gated by the .write half alone.
    if (label.includes('ddos_l7')) {
      return /\(PUT\)/u.test(label)
        ? [CLOUDFLARE_SCOPE_IDS.ddosManagedRulesetWrite]
        : [...CLOUDFLARE_DDOS_SCOPES]
    }
    return /\((PUT|POST|PATCH|DELETE)\)/u.test(label) ? [CLOUDFLARE_SCOPE_IDS.wafWrite] : [CLOUDFLARE_SCOPE_IDS.wafRead]
  }
  if (label === 'analytics' || label === 'security_events') return [CLOUDFLARE_SCOPE_IDS.analyticsRead]
  if (label === 'botnet_feed') return [CLOUDFLARE_SCOPE_IDS.botnetFeedRead]
  return []
}

/**
 * Build the Cloudflare adapter.
 * @param options - adapter options.
 * @param options.apiBase - API origin, e.g. `https://api.cloudflare.com`.
 * @param options.request - injected HTTP function.
 * @param options.runWrangler - injected subprocess runner for `wrangler deploy`.
 * @returns the adapter.
 */
export function createCloudflare({ apiBase, request, runWrangler }) {
  const base = String(apiBase || 'https://api.cloudflare.com').replace(/\/+$/u, '')
  const root = `${base}/client/v4`

  const call = (token, path, { method = 'GET', body } = {}) => request(`${root}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'user-agent': 'dsh-connector/0.1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  /**
   * A provider refusal, typed so the route layer can answer 424 by INSPECTION
   * (`code === 'CONNECTOR_PROVIDER_ERROR'`) instead of guessing from prose.
   *
   * The message names the endpoint, the HTTP status and Cloudflare's own error
   * text. It never contains the token: this module only ever holds it as the
   * `Authorization` header of the request it belongs to, and nothing here reads
   * it back out.
   */
  function providerError(message, { status, tokenRejected = false } = {}) {
    const error = new Error(message)
    error.code = 'CONNECTOR_PROVIDER_ERROR'
    if (Number.isFinite(status)) error.status = Number(status)
    // `tokenRejected` is what the operations layer uses to decide whether ONE
    // OAuth refresh (and one retry) is worth attempting. It is a classification,
    // not a guess from prose: only 401, and Cloudflare's own invalid-token code
    // on the verify endpoint, set it.
    if (tokenRejected === true) error.tokenRejected = true
    return error
  }

  /** Cloudflare's `errors[]` as one short sentence, or ''. */
  function errorsOf(payload) {
    return (Array.isArray(payload?.errors) ? payload.errors : [])
      .map(error => error?.message ?? error?.code)
      .filter(Boolean)
      .join('; ')
  }

  /** The typed "the token is dead" failure. ONE shape, THREE call sites. */
  function tokenExpiredError(status) {
    const error = providerError(CLOUDFLARE_TOKEN_EXPIRED_MESSAGE, {
      status,
      // The operations layer may attempt ONE refresh + retry for this error.
      tokenRejected: true,
    })
    // PUBLIC classification: a caller (and the page) can tell expiry from scope.
    error.reason = 'token_expired'
    error.tokenExpired = true
    return error
  }

  /** Unwrap Cloudflare's `{success, errors, result}` envelope. */
  function unwrap(response, what) {
    const payload = response.json ?? {}
    if (response.ok && payload.success !== false) return payload.result
    /**
     * ORDER MATTERS, AND THIS IS THE BUG THAT WAS FIXED: an expired token that
     * arrives as a 403 ("Invalid access token") used to fall through to the
     * permission branch and print "scope not granted … (needs zone-settings.read)".
     * The token signal is therefore tested BEFORE any scope reasoning — a
     * re-consent cannot revive an expired token.
     */
    if (isInvalidTokenResponse(response, payload)) throw tokenExpiredError(response.status)
    const errors = errorsOf(payload)
    const detail = errors === '' ? `Cloudflare ${response.status}` : `Cloudflare: ${errors}`
    // 403 (with no token signal) = this token may not do THIS — reported at the
    // endpoint's own scope so the user knows what to grant, not "log in again".
    // The message NAMES the gatekeeper id(s) (e.g. zone-settings.read for
    // /zones/{id}/settings, both DDoS ids for the ddos_l7 entry point), which is
    // the difference between a dead end and one edit on the OAuth client.
    const needed = response.status === 403 ? requiredScopesForLabel(what) : []
    const suffix = response.status === 403
      ? ` — scope not granted on this OAuth token${needed.length === 0 ? '' : ` (needs ${needed.join(', ')})`}`
      : ''
    throw providerError(`${detail} (${what})${suffix}`, { status: response.status, tokenRejected: false })
  }

  /**
   * What the VERIFY ANSWER itself says about where the token may act.
   *
   * The public `/user/tokens/verify` result is `{ id, status, not_before,
   * expires_on }` and, on most accounts, carries NO account identity at all. A
   * deployment that adds one (an `account` object, an `accounts` array, or the
   * token's `policies[].permission_groups`) is read here rather than guessed at
   * with a second call: an extra `/accounts` request would answer "which accounts
   * can this token SEE", not "what does verify say", and the two are not the same
   * fact.
   *
   * @param result - the verify `result` object.
   * @returns `{ accounts, permissionGroups }` — both empty when the answer is silent.
   */
  function scopeOf(result) {
    const accounts = []
    const push = (entry) => {
      if (entry === null || typeof entry !== 'object') return
      const id = typeof entry.id === 'string' ? entry.id : (typeof entry.account_id === 'string' ? entry.account_id : '')
      const name = typeof entry.name === 'string' ? entry.name : (typeof entry.account_name === 'string' ? entry.account_name : '')
      if (id !== '' || name !== '') accounts.push({ id, name })
    }
    if (Array.isArray(result?.accounts)) result.accounts.forEach(push)
    push(result?.account)
    const permissionGroups = []
    for (const policy of Array.isArray(result?.policies) ? result.policies : []) {
      for (const group of Array.isArray(policy?.permission_groups) ? policy.permission_groups : []) {
        const name = typeof group?.name === 'string' ? group.name : ''
        if (name !== '') permissionGroups.push(name)
      }
    }
    return { accounts, permissionGroups }
  }

  /** A ruleset answer, reduced to what a caller can act on. */
  function normalizeRuleset(result) {
    const rows = Array.isArray(result?.rules) ? result.rules : []
    return {
      id: result?.id,
      name: result?.name,
      phase: result?.phase,
      // Cloudflare bumps this on every write — the reply names it so a caller can
      // prove the change landed on a NEW version, not a cached one.
      version: result?.version,
      rules: rows.map(rule => ({
        id: rule?.id,
        action: rule?.action,
        expression: rule?.expression,
        description: rule?.description ?? rule?.ref,
        enabled: rule?.enabled,
      })),
    }
  }

  /** One rule, reduced. */
  function normalizeRule(rule) {
    return {
      id: rule?.id,
      action: rule?.action,
      expression: rule?.expression,
      description: rule?.description ?? rule?.ref,
      enabled: rule?.enabled,
    }
  }

  return {
    /**
     * DOES THIS TOKEN WORK — and WHERE. (Replaces the old
     * `/user/tokens/verify` check, which is API-token-only: an OAuth access
     * token gets code 1000/10000 there, which is what produced a misleading
     * "Invalid API Token" on a perfectly valid login.)
     *
     * The probe is a chain of CHEAP SCOPED reads, and the FIRST one that answers
     * is the answer:
     *
     *   1. `GET /user`          — identity; succeeds for a user-scoped token.
     *   2. `GET /zones?per_page=1` — `zone.read` is in practically every catalog.
     *   3. `GET /accounts?per_page=1` — the last resort, account-scoped tokens.
     *
     * A 401/403 on one step simply moves to the next; anything else is a real
     * provider failure. When every step is refused, the thrown error is typed and
     * names the step (`token rejected at /user (401)`) — never a fabricated
     * "Invalid API Token" phrasing, and only a 401 sets `tokenRejected` (the one
     * signal the operations layer may answer with a single refresh + retry).
     *
     * @param token - the access token, for these requests only.
     * @returns `{ passed, status, identity? }` — `passed` is user|zones|accounts.
     */
    async probe(token) {
      const attempts = [
        { label: 'user', path: '/user' },
        { label: 'zones', path: '/zones?per_page=1' },
        { label: 'accounts', path: '/accounts?per_page=1' },
      ]
      let rejection
      for (const attempt of attempts) {
        const response = await call(token, attempt.path)
        const payload = response.json ?? {}
        if (response.ok && payload.success !== false) {
          const result = payload.result
          return {
            passed: attempt.label,
            status: response.status,
            // Only ever non-secret identity facts, and only when they were sent.
            ...(attempt.label === 'user' && result !== null && typeof result === 'object'
              ? { identity: { id: result.id, email: result.email } }
              : {}),
          }
        }
        if (response.status === 401 || response.status === 403) {
          rejection = {
            label: attempt.label,
            status: response.status,
            errors: errorsOf(payload),
            // A 401 is the token's own refusal; a 403 is one only with an
            // invalid-token phrase ("Invalid access token").
            invalidToken: isInvalidTokenResponse(response, payload),
          }
          continue
        }
        const errors = errorsOf(payload)
        throw providerError(`Cloudflare ${response.status} on ${attempt.path}${errors === '' ? '' : `: ${errors}`}`, { status: response.status })
      }
      const label = rejection?.label ?? 'user'
      const status = rejection?.status ?? 401
      const errors = rejection?.errors ?? ''
      // EVERY step refused, and the refusal was the token's: say so with the one
      // sentence that names the fix, instead of a chain position the user cannot use.
      if (rejection?.invalidToken === true) throw tokenExpiredError(status)
      throw providerError(
        `token rejected at /${label} (${status})${errors === '' ? '' : `: ${errors}`}`,
        { status, tokenRejected: false },
      )
    },

    /** Zones the token can read — the entry point for every zone-scoped action. */
    async listZones(token, { page = 1, perPage = 100 } = {}) {
      const rows = unwrap(await call(token, `/zones?per_page=${perPage}&page=${page}`), 'zones') ?? []
      return rows.map(row => ({
        id: row.id, name: row.name, status: row.status, paused: row.paused,
        type: row.type, developmentMode: row.development_mode, accountName: row.account?.name,
      }))
    },

    /** DNS records of one zone, filtered server-side. */
    async listDnsRecords(token, zone, { type, name, page = 1, perPage = 100 } = {}) {
      const params = new URLSearchParams({ per_page: String(perPage), page: String(page) })
      if (type !== undefined && type !== '') params.set('type', type)
      if (name !== undefined && name !== '') params.set('name', name)
      const rows = unwrap(await call(token, `/zones/${encodeURIComponent(zone)}/dns_records?${params.toString()}`), 'dns_records') ?? []
      return rows.map(row => ({
        id: row.id, type: row.type, name: row.name, content: row.content,
        ttl: row.ttl, proxied: row.proxied, priority: row.priority, comment: row.comment,
      }))
    },

    async createDnsRecord(token, zone, record) {
      const result = unwrap(await call(token, `/zones/${encodeURIComponent(zone)}/dns_records`, { method: 'POST', body: record }), 'dns_records/create')
      return { id: result?.id, type: result?.type, name: result?.name, ttl: result?.ttl, proxied: result?.proxied }
    },

    async patchDnsRecord(token, zone, recordId, patch) {
      const result = unwrap(await call(token, `/zones/${encodeURIComponent(zone)}/dns_records/${encodeURIComponent(recordId)}`, { method: 'PATCH', body: patch }), 'dns_records/patch')
      return { id: result?.id, type: result?.type, name: result?.name, ttl: result?.ttl, proxied: result?.proxied }
    },

    async deleteDnsRecord(token, zone, recordId) {
      const result = unwrap(await call(token, `/zones/${encodeURIComponent(zone)}/dns_records/${encodeURIComponent(recordId)}`, { method: 'DELETE' }), 'dns_records/delete')
      return { id: result?.id ?? recordId }
    },

    /** Rulesets attached to a zone (WAF/custom/rate-limit/ddos entry points). */
    async listRulesets(token, zone) {
      const rows = unwrap(await call(token, `/zones/${encodeURIComponent(zone)}/rulesets`), 'rulesets') ?? []
      return rows.map(row => ({
        id: row.id, name: row.name, description: row.description, kind: row.kind, phase: row.phase,
        version: row.version,
      }))
    },

    /**
     * The entry point ruleset of one phase (`…/rulesets/phases/{phase}/entrypoint`).
     *
     * A 404 here is only an error for a phase that MUST exist (WAF/rate-limit).
     * For `ddos_l7` Cloudflare answers 404 when the zone has NO overrides yet —
     * that is the default state, not a failure, and the operations layer maps it
     * to "defaults active (no overrides configured)".
     */
    async getPhaseEntrypoint(token, zone, phase) {
      const result = unwrap(await call(token, `/zones/${encodeURIComponent(zone)}/rulesets/phases/${encodeURIComponent(phase)}/entrypoint`), `rulesets/phases/${phase}/entrypoint`)
      return normalizeRuleset(result)
    },

    /** Create-or-replace a phase entry point. Cloudflare bumps `version` itself. */
    async putPhaseEntrypoint(token, zone, phase, body) {
      const result = unwrap(await call(token, `/zones/${encodeURIComponent(zone)}/rulesets/phases/${encodeURIComponent(phase)}/entrypoint`, { method: 'PUT', body }), `rulesets/phases/${phase}/entrypoint (PUT)`)
      return normalizeRuleset(result)
    },

    async createRule(token, zone, rulesetId, rule) {
      // ONE rule object in the body — the add-a-rule endpoint takes a single rule
      // (`{expression, action, action_parameters?, description?, enabled?}`), not
      // a `{rules:[…]}` envelope. That envelope belongs to the ENTRY POINT PUT.
      const result = unwrap(await call(token, `/zones/${encodeURIComponent(zone)}/rulesets/${encodeURIComponent(rulesetId)}/rules`, { method: 'POST', body: rule }), 'rulesets/rules (POST)')
      return normalizeRule(result)
    },

    async patchRule(token, zone, rulesetId, ruleId, patch) {
      const result = unwrap(await call(token, `/zones/${encodeURIComponent(zone)}/rulesets/${encodeURIComponent(rulesetId)}/rules/${encodeURIComponent(ruleId)}`, { method: 'PATCH', body: patch }), 'rulesets/rules (PATCH)')
      return normalizeRule(result)
    },

    /**
     * ONE rule of a ruleset — the read a PAUSE needs.
     *
     * The ruleset PATCH docs require `expression` and `action` in the body, so a
     * caller that only wants `enabled:false` first reads the rule and replays its
     * unchanged expression/action. There is no skip-action hack and no ETag: the
     * server bumps the ruleset `version` on every mutation by itself.
     */
    async getRule(token, zone, rulesetId, ruleId) {
      const result = unwrap(await call(token, `/zones/${encodeURIComponent(zone)}/rulesets/${encodeURIComponent(rulesetId)}/rules/${encodeURIComponent(ruleId)}`), 'rulesets/rules/{id}')
      return normalizeRule(result)
    },

    async deleteRule(token, zone, rulesetId, ruleId) {
      unwrap(await call(token, `/zones/${encodeURIComponent(zone)}/rulesets/${encodeURIComponent(rulesetId)}/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' }), 'rulesets/rules (DELETE)')
      return { rulesetId, ruleId }
    },

    /**
     * The DDoS botnet feed for one ASN.
     *
     * Two documented report shapes share the prefix:
     *   * `GET /accounts/{id}/botnet_feed/asn/{asn}/full_report`
     *   * `GET /accounts/{id}/botnet_feed/asn/{asn}/day_report?date=YYYY-MM-DD`
     *
     * Gated by `ddos-botnet-feed.read`. Not every account/plan exposes the feed;
     * the operations layer turns that refusal into an explicit "no scope" answer
     * rather than erroring, because it is a plan surface, not a bad request.
     */
    async getBotnetFeed(token, accountId, asn, report, date = '') {
      const params = new URLSearchParams()
      if (report === 'day_report' && date !== '') params.set('date', date)
      const query = params.toString() === '' ? '' : `?${params.toString()}`
      const result = unwrap(await call(token, `/accounts/${encodeURIComponent(accountId)}/botnet_feed/asn/${encodeURIComponent(String(asn))}/${report}${query}`), 'botnet_feed')
      return result ?? null
    },

    /**
     * The ACCOUNT id a zone belongs to — one cheap read of `/zones/{id}`.
     *
     * Access rules need it because BOTH of their documented paths are gated only
     * by `account-firewall-access-rules.read|write`; a zone-scoped OAuth login
     * therefore calls the ACCOUNT path and must learn the account first. The
     * zone itself travels in the reply (`account.id`), never guessed.
     */
    async zoneAccountId(token, zone) {
      const result = unwrap(await call(token, `/zones/${encodeURIComponent(zone)}`), 'zones/{id}')
      const account = typeof result?.account?.id === 'string' ? result.account.id : ''
      if (!CF_ACCOUNT_ID.test(account)) {
        throw providerError('the zone answer carried no account id, so the account-scoped access-rule path cannot be built', { status: 200 })
      }
      return account
    },

    /**
     * IP Access rules — ALWAYS the account path.
     *
     * Cloudflare documents BOTH `/zones/{z}/firewall/access_rules/rules` and
     * `/accounts/{a}/firewall/access_rules/rules` as gated by Account Firewall
     * Access Rules Read/Write, and in practice a zone-scoped OAuth token is
     * refused (401/403) on the zone path. Both of this plugin's scopes therefore
     * go to the account path; the zone is informational (the list is
     * account-wide), which the result states rather than implying it filtered.
     */
    async listAccessRules(token, accountId, { page = 1, perPage = 100 } = {}) {
      const rows = unwrap(await call(token, `/accounts/${encodeURIComponent(accountId)}/firewall/access_rules/rules?per_page=${perPage}&page=${page}`), 'access_rules') ?? []
      return rows.map(row => ({
        id: row.id, mode: row.mode, notes: row.notes,
        target: row.configuration?.target, value: row.configuration?.value,
      }))
    },

    async createAccessRule(token, accountId, body) {
      const result = unwrap(await call(token, `/accounts/${encodeURIComponent(accountId)}/firewall/access_rules/rules`, { method: 'POST', body }), 'access_rules/create')
      return { id: result?.id, mode: result?.mode, target: result?.configuration?.target, value: result?.configuration?.value }
    },

    async patchAccessRule(token, accountId, ruleId, body) {
      const result = unwrap(await call(token, `/accounts/${encodeURIComponent(accountId)}/firewall/access_rules/rules/${encodeURIComponent(ruleId)}`, { method: 'PATCH', body }), 'access_rules/patch')
      return { id: result?.id, mode: result?.mode }
    },

    async deleteAccessRule(token, accountId, ruleId) {
      const result = unwrap(await call(token, `/accounts/${encodeURIComponent(accountId)}/firewall/access_rules/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' }), 'access_rules/delete')
      return { id: result?.id ?? ruleId }
    },

    /** Zone settings, all of them or one by id. */
    async listZoneSettings(token, zone) {
      const rows = unwrap(await call(token, `/zones/${encodeURIComponent(zone)}/settings`), 'settings') ?? []
      return rows.map(row => ({ id: row.id, value: row.value, editable: row.editable, modifiedOn: row.modified_on }))
    },

    async getZoneSetting(token, zone, settingId) {
      const row = unwrap(await call(token, `/zones/${encodeURIComponent(zone)}/settings/${encodeURIComponent(settingId)}`), 'settings/{id}')
      return { id: row?.id, value: row?.value, editable: row?.editable }
    },

    async patchZoneSetting(token, zone, settingId, value) {
      const row = unwrap(await call(token, `/zones/${encodeURIComponent(zone)}/settings/${encodeURIComponent(settingId)}`, { method: 'PATCH', body: { value } }), 'settings/{id} (PATCH)')
      return { id: row?.id, value: row?.value }
    },

    /**
     * One GraphQL analytics query (POST /graphql). The API key/token travels as
     * the same Bearer header as every REST call.
     *
     * BOTH analytics surfaces this plugin exposes — zone HTTP analytics AND
     * Security Events — are gated by the SAME catalog permission, `Analytics
     * Read` (`analytics.read`), on the zone being queried. The account-level
     * variant would need `account-analytics.read`, which the catalogue this
     * plugin ships against does not expose, so it is never requested.
     *
     * The retired REST fallbacks (`/zones/{id}/analytics/dashboard`,
     * `/zones/{id}/security/events`) do not exist any more; there is no fallback
     * path here on purpose.
     *
     * A 403 — or a GraphQL error naming the permission — is surfaced as a typed
     * "analytics needs Analytics Read" refusal, never as an empty dataset: an
     * empty chart and a refused scope look identical to a user otherwise. The
     * "zone does not have access to the path" variant is classified separately:
     * it means the ZONE refuses this token even though the scope is ticked, and
     * the only fix is the consent screen, so the reason says exactly that.
     */
    async graphql(token, query, variables) {
      const response = await request(`${root}/graphql`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'dsh-connector/0.1',
        },
        body: JSON.stringify({ query, variables }),
      })
      const payload = response.json ?? {}
      const errors = Array.isArray(payload.errors) ? payload.errors : []
      const first = errors.map(error => error?.message).filter(Boolean).join('; ')
      /**
       * THE TOKEN FIRST. The live 401 was
       * `{"errors":[{"code":10000,"message":"Authentication error"}]}` — before this
       * check it fell past the permission branch (the wording contains none of
       * "permission|not authorized|analytics|access to the path") and surfaced as
       * `Cloudflare graphql 401: Authentication error`: true, but unactionable, and
       * it skipped the refresh-once policy.
       */
      if (isInvalidTokenResponse(response, payload)) throw tokenExpiredError(response.status)
      if (response.status === 403 || /(permission|not authorized|analytics|access to the path)/iu.test(first)) {
        // TWO reason classes, not one: a missing scope id (tick it on the client)
        // vs a zone-level consent refusal (re-consent with Analytics Read ticked).
        const consentRefused = /does not have access to the path/iu.test(first)
        const reason = consentRefused
          ? 're-consent with Analytics Read ticked at the consent screen'
          : `${CLOUDFLARE_SCOPE_IDS.analyticsRead} must be granted on this OAuth token`
        const error = providerError(
          `Cloudflare analytics was refused${first === '' ? '' : `: ${first}`}; ${reason}`,
          { status: response.status === 403 ? 403 : 200 },
        )
        error.reason = reason
        error.reasonClass = consentRefused ? 'analytics_consent_required' : 'analytics_scope_missing'
        // PUBLIC, and the one id the consent screen labels "Analytics Read".
        error.scopeMissing = CLOUDFLARE_SCOPE_IDS.analyticsRead
        throw error
      }
      if (!response.ok) throw providerError(`Cloudflare graphql ${response.status}${first === '' ? '' : `: ${first}`}`, { status: response.status })
      if (first !== '') throw providerError(`Cloudflare graphql: ${first}`, { status: response.status })
      return payload.data ?? {}
    },

    /** Accounts the token can read. */
    async listAccounts(token) {
      const rows = unwrap(await call(token, '/accounts?per_page=50'), 'accounts') ?? []
      return rows.map(row => ({ id: row.id, name: row.name, type: row.type }))
    },

    /** Pages projects under one account. */
    async listPagesProjects(token, accountId) {
      const rows = unwrap(await call(token, `/accounts/${encodeURIComponent(accountId)}/pages/projects?per_page=50`), 'pages/projects') ?? []
      return rows.map(row => ({
        name: row.name, subdomain: row.subdomain, domains: row.domains ?? [],
        productionBranch: row.production_branch, createdOn: row.created_on,
      }))
    },

    /** Recent deployments for one project — the troubleshooting view. */
    async listDeployments(token, accountId, project) {
      const rows = unwrap(await call(token, `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(project)}/deployments?per_page=25`), 'pages/deployments') ?? []
      return rows.map(row => ({
        id: row.id, shortId: row.short_id, environment: row.environment, url: row.url,
        createdOn: row.created_on, latestStage: row.latest_stage?.name, stageStatus: row.latest_stage?.status,
      }))
    },

    /** Workers scripts under one account (read-only list). */
    async listWorkers(token, accountId) {
      const rows = unwrap(await call(token, `/accounts/${encodeURIComponent(accountId)}/workers/scripts`), 'workers/scripts') ?? []
      return rows.map(row => ({ id: row.id, modifiedOn: row.modified_on }))
    },

    /**
     * Deploy a project with `wrangler`.
     *
     * The token is handed to the runner as an environment entry, which is the
     * whole point: argv is world-readable through `ps`, the environment is not.
     *
     * @param token - Cloudflare API token.
     * @param directory - project directory inside the workspace.
     * @param dryRun - ask wrangler for a build without uploading.
     * @returns the runner's verdict.
     */
    async deployWrangler(token, directory, dryRun) {
      const args = ['deploy']
      if (dryRun) args.push('--dry-run')
      return runWrangler(args, { CLOUDFLARE_API_TOKEN: token }, directory)
    },
  }
}

/**
 * DOCUMENTED, DELIBERATELY UNIMPLEMENTED SURFACES (no actions, on purpose).
 *
 * These are real Cloudflare APIs that map onto this adapter's shape, kept here as
 * guidance for a future batch rather than as half-built actions:
 *
 *   * dns-firewall.*      → /accounts/{id}/dns_firewall (the DNS Firewall clusters).
 *     The paired dns-analytics endpoint is DEPRECATED (2025-12-09) — do not build
 *     analytics on it; GraphQL is the analytics surface.
 *   * dns-view.*          → /accounts/{id}/dns_settings/views (internal DNS views).
 *   * account-dns-settings.* → GET|PATCH /accounts/{id}/dns_settings, plus the
 *     per-zone /zones/{z}/dns_settings.
 *
 * AUDIT LOGS ARE NOT `account-logs.*`. `GET /accounts/{id}/logs/audit` is gated by
 * Account Settings Read/Write. `account-logs.read` gates Logpush / Instant Logs —
 * a different surface. Audit is therefore NOT implemented under account-logs, and
 * no action here should ever claim it does.
 */
