/**
 * Connector operations — the ONE implementation of every keyword.
 *
 * The `/api/connector/*` Host routes (used by the page) and the `connector_*`
 * agent tools both call these methods, so the UI and the model can never
 * disagree about what "list the PRs" or "push this project" means.
 *
 * SECRET DISCIPLINE (reference-only)
 * ----------------------------------
 * This plugin stores REFERENCES, never values. A provider alias maps to a DSH
 * credential reference name (`GITHUB_TOKEN`), which is plain config and not a
 * secret; DSH resolves it from `.credentials.yaml`, the environment, or a `.env`.
 *
 * A value enters this module in exactly one place — `withSecret()`, which calls
 * `credentials.resolve(ref)` at call time — and leaves it in exactly two places:
 * the provider adapter's `Authorization` header for that one request, and the
 * askpass file described in {@link push} (0600 inside a 0700 temp dir, removed in
 * `finally`). It is never part of a result object, an error message, a tool
 * payload, a log line, or the page. Nothing derived from it is published either:
 * no trailing characters, no length, no mask. The only fact that leaves here
 * about a credential is whether its reference RESOLVES.
 *
 * There is no cache: re-pointing the reference or rotating the value in DSH
 * applies to the very next call.
 *
 * READ / WRITE SPLIT
 * ------------------
 * Every verb is in exactly one of {@link READ_ACTIONS} and {@link WRITE_ACTIONS},
 * and there is no third state: an action that is not in either set is refused by
 * name before any request is made. The tool layer uses the same sets to tell the
 * model which of its own calls need the session's approval.
 *
 * @module dsh-connector/lib/operations
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import {
  DEFAULT_REFS, PROVIDERS, assertAlias, assertProvider, clientSecretRefName, cloudflareRefreshRefName,
  describeCredential, githubRefreshRefName, isRefName, listReferences, redact, requireRefName,
  resolveSecret, setSecret, storePath, unsetSecret,
} from './credentials.js'
import {
  CLOUDFLARE_CALLBACK_PATH, CLOUDFLARE_DEFAULT_SCOPES, CLOUDFLARE_OAUTH_ORIGIN,
  buildCloudflareAuthorizeUrl, buildGiteaAuthorizeUrl, callbackUrlOf, cloudflareCallbackUrlOf,
  createPkcePair, createStateStore, exchangeCloudflareCode, exchangeGiteaCode, giteaWebOrigin,
  isCloudflareRedirectOrigin, refreshCloudflareToken, revokeCloudflareToken,
} from './oauth.js'
import { createGitHub, decodeTextBase64, webOriginOf } from './providers/github.js'
import { CLOUDFLARE_DDOS_SCOPES, CLOUDFLARE_SCOPE_IDS, createCloudflare } from './providers/cloudflare.js'
import { createGitea, normalizeBaseUrl } from './providers/gitea.js'

/** Refuse a repository identifier that could escape its path segment. */
const REPO_PART = /^[A-Za-z0-9._-]{1,100}$/u

/** Branch / ref names git itself would accept, minus anything that re-parses as an option. */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,200}$/u

/** A workflow file name or numeric id. */
const WORKFLOW_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u

/** An issue / pull-request number or an Actions run id. */
const NUMERIC_ID = /^[0-9]{1,20}$/u

/** One path segment of a login name. */
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u

/** Characters a repository path may contain, segment separator included. */
const FILE_PATH_PATTERN = /^[A-Za-z0-9._@+~-][A-Za-z0-9._@+~/-]{0,399}$/u

/** The largest file body this plugin will send in one commit. */
const MAX_FILE_BYTES = 4 * 1024 * 1024

/** Actions the shared `connector_repo_actions` tool understands as reads. */
const READ_ACTIONS = new Set(['prs', 'issues', 'branches', 'actions_logs', 'commits', 'blame', 'pr_files', 'pr_diff'])
/** Actions that write to the remote — these need the caller's go-ahead. */
const WRITE_ACTIONS = new Set([
  'comment', 'edit_issue', 'pull_comment', 'create_branch',
  'run_dispatch', 'run_cancel', 'run_rerun', 'delete_run',
  'delete_branch', 'create_tag',
  'set_labels', 'add_assignees',
  'issue_create', 'issue_state',
  'pr_create', 'pr_merge',
])

/** The file verbs `connector_file` exposes, split the same way. */
const FILE_READ_ACTIONS = new Set(['read_tree', 'read_file'])
const FILE_WRITE_ACTIONS = new Set(['put_file'])

/**
 * CLOUDFLARE PLATFORM ACTIONS — one tool, one discriminator, one read/write split.
 *
 * Reads are unrestricted; writes are the caller's approval-preset business and
 * are named as such in the tool description (and in these exported sets, which
 * the tests assert against so the prose cannot drift from the behaviour).
 */
const CLOUDFLARE_READ_ACTIONS = new Set([
  'zones', 'dns_records', 'waf_rules', 'access_rules', 'zone_settings', 'ddos_overrides', 'analytics',
  // Security Events (GraphQL firewallEventsAdaptive) and the DDoS botnet feed.
  'security_events', 'botnet_feed',
])
const CLOUDFLARE_WRITE_ACTIONS = new Set([
  'dns_record_create', 'dns_record_patch', 'dns_record_delete',
  'waf_rule_set', 'waf_rule_add', 'waf_rule_patch', 'waf_rule_delete',
  'access_rule_create', 'access_rule_patch', 'access_rule_delete',
  'zone_setting_edit',
  // Creating the FIRST ddos_l7 override (PUT entry point).
  'ddos_override_set',
])

/**
 * THE SCOPE IDS EACH ACTION NEEDS — public, per action, and pinned to the REAL
 * gatekeeper ids (see `CLOUDFLARE_SCOPE_IDS` in `providers/cloudflare.js`).
 *
 * This map exists twice over, on purpose:
 *   * it is attached to every action result as `requiredScopes`, so a caller that
 *     hit a 403 knows what to grant without reading this source; and
 *   * it is what the guide/panel want-list must match, which the tests assert.
 *
 * `zone_settings` names `zone-settings.*` (NOT `config-settings.*`), access rules
 * name `account-firewall-access-rules.*` (NOT `account-rule-lists.*`), and
 * `ddos_overrides` names BOTH DDoS ids because the L7 entry point is a file in
 * the managed ruleset.
 *
 * `ddos_override_set` names `http-ddos-managed-ruleset.write` and `botnet_feed`
 * names `ddos-botnet-feed.read` — both REAL ids that are deliberately NOT in the
 * 20-id want-list (they are add-on gates; see `CLOUDFLARE_ADDON_SCOPE_IDS` in the
 * provider). The selftest exempts exactly those two from the want-list rule.
 */
export const CLOUDFLARE_ACTION_SCOPES = {
  zones: [CLOUDFLARE_SCOPE_IDS.zoneRead],
  dns_records: [CLOUDFLARE_SCOPE_IDS.dnsRead],
  dns_record_create: [CLOUDFLARE_SCOPE_IDS.dnsWrite],
  dns_record_patch: [CLOUDFLARE_SCOPE_IDS.dnsWrite],
  dns_record_delete: [CLOUDFLARE_SCOPE_IDS.dnsWrite],
  waf_rules: [CLOUDFLARE_SCOPE_IDS.wafRead],
  waf_rule_set: [CLOUDFLARE_SCOPE_IDS.wafWrite],
  waf_rule_add: [CLOUDFLARE_SCOPE_IDS.wafWrite],
  waf_rule_patch: [CLOUDFLARE_SCOPE_IDS.wafWrite],
  waf_rule_delete: [CLOUDFLARE_SCOPE_IDS.wafWrite],
  access_rules: [CLOUDFLARE_SCOPE_IDS.accessRulesRead],
  access_rule_create: [CLOUDFLARE_SCOPE_IDS.accessRulesWrite],
  access_rule_patch: [CLOUDFLARE_SCOPE_IDS.accessRulesWrite],
  access_rule_delete: [CLOUDFLARE_SCOPE_IDS.accessRulesWrite],
  zone_settings: [CLOUDFLARE_SCOPE_IDS.zoneSettingsRead],
  zone_setting_edit: [CLOUDFLARE_SCOPE_IDS.zoneSettingsWrite],
  ddos_overrides: [...CLOUDFLARE_DDOS_SCOPES],
  ddos_override_set: [CLOUDFLARE_SCOPE_IDS.ddosManagedRulesetWrite],
  analytics: [CLOUDFLARE_SCOPE_IDS.analyticsRead],
  security_events: [CLOUDFLARE_SCOPE_IDS.analyticsRead],
  botnet_feed: [CLOUDFLARE_SCOPE_IDS.botnetFeedRead],
}

/** Cloudflare ids are 32 hex characters (zone, account, record, ruleset, rule). */
const CF_ID = /^[0-9a-f]{32}$/u
/** The rule phases this plugin touches, plus the DDoS L7 entry point. */
const CF_PHASES = new Set(['http_request_firewall_custom', 'http_ratelimit', 'http_request_firewall_managed'])
const CF_DDOS_PHASE = 'ddos_l7'
const CF_DNS_TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA', 'PTR', 'SPF', 'HTTPS', 'SVCB'])
const CF_ACCESS_TARGETS = new Set(['ip', 'ip_range', 'asn', 'country'])
const CF_ACCESS_MODES = new Set(['block', 'challenge', 'managed_challenge', 'js_challenge', 'whitelist'])
/** Clamp helpers keep a caller from paginating the whole zone in one call. */
const cfPage = (value) => {
  const number = Number(value ?? 1)
  if (!Number.isInteger(number) || number < 1 || number > 10000) throw configError('page must be an integer between 1 and 10000')
  return number
}
const cfPerPage = (value, fallback = 50) => {
  const number = Number(value ?? fallback)
  if (!Number.isInteger(number) || number < 1 || number > 100) throw configError('per_page must be an integer between 1 and 100')
  return number
}
/** A required Cloudflare numeric id. */
function cfId(value, label) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!CF_ID.test(text)) throw configError(`${label} must be a 32-character Cloudflare id`)
  return text
}
/** An optional short string, bounded. */
function cfText(value, label, max = 512, { required = false } = {}) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') {
    if (required) throw configError(`${label} is required`)
    return ''
  }
  if (text.length > max) throw configError(`${label} must be at most ${max} characters`)
  return text
}
/** A DNS type in the accepted set. */
function cfDnsType(value, { required = false } = {}) {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : ''
  if (text === '') {
    if (required) throw configError('type is required for a DNS record')
    return ''
  }
  if (!CF_DNS_TYPES.has(text)) throw configError(`type must be one of ${[...CF_DNS_TYPES].join(', ')}`)
  return text
}
/** A rule phase from the supported set (`ddos_l7` only for the read). */
function cfPhase(value, { required = true, allowDdos = false } = {}) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') {
    if (required) throw configError(`phase is required; expected one of ${[...CF_PHASES].join(', ')}`)
    return ''
  }
  if (!CF_PHASES.has(text) && !(allowDdos && text === CF_DDOS_PHASE)) {
    throw configError(`phase must be one of ${[...CF_PHASES].join(', ')}${allowDdos ? `, ${CF_DDOS_PHASE}` : ''}`)
  }
  return text
}
/**
 * DNS TTL: `1` means automatic; anything else must be 60–86400 seconds.
 * Proxying exists only for the three record types Cloudflare can front.
 */
function cfTtl(value) {
  if (value === undefined || value === null || value === '') return undefined
  const ttl = Number(value)
  if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 60 || ttl > 86400))) {
    throw configError('ttl must be 1 (automatic) or a number of seconds between 60 and 86400')
  }
  return ttl
}
function cfProxied(value, type) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw configError('proxied must be true or false')
  if (value === true && !['A', 'AAAA', 'CNAME'].includes(String(type ?? '').toUpperCase())) {
    throw configError('proxied is allowed only on A, AAAA and CNAME records')
  }
  return value
}
/** The access-rule body, validated against Cloudflare's own enums. */
function cfAccessRuleBody(input) {
  const target = cfText(input.target, 'target', 32, { required: true })
  if (!CF_ACCESS_TARGETS.has(target)) throw configError(`target must be one of ${[...CF_ACCESS_TARGETS].join(', ')}`)
  const value = cfText(input.rule_value, 'rule_value', 128, { required: true })
  const mode = cfText(input.mode, 'mode', 32, { required: true })
  if (!CF_ACCESS_MODES.has(mode)) throw configError(`mode must be one of ${[...CF_ACCESS_MODES].join(', ')}`)
  const notes = cfText(input.notes, 'notes', 512)
  return { mode, notes, configuration: { target, value } }
}

/**
 * ACCESS RULES ARE ACCOUNT-SCOPE, whichever scope the caller picked.
 *
 * Cloudflare's docs gate BOTH `/zones/{z}/firewall/access_rules/rules` and
 * `/accounts/{a}/firewall/access_rules/rules` with Account Firewall Access Rules
 * Read/Write, and a zone-scoped OAuth token is refused on the zone path in
 * practice. Every access-rule action therefore resolves an ACCOUNT id and calls
 * the account path; the zone is informational and the result says the list is
 * account-wide, so nobody mistakes it for a zone filter.
 */
export const CLOUDFLARE_ACCESS_RULES_NOTE = 'account-scope OAuth governs access rules; the list is account-wide'

/**
 * Resolve the account an access-rule call must use, from either scope shape.
 *
 * `scope:'account'` needs `account`; `scope:'zone'` needs `zone` and learns the
 * account from the zone (unless the caller supplied `account` too, which avoids
 * the extra read). The answer distinguishes the scope that was REQUESTED from
 * the account path that is actually sent.
 */
async function resolveAccessRuleTarget(cf, token, input) {
  const requestedScope = input.scope === 'account' ? 'account' : 'zone'
  if (requestedScope === 'account') {
    return { requestedScope, account: cfId(input.account, 'account'), zone: cfText(input.zone, 'zone', 64) }
  }
  const zone = cfId(input.zone, 'zone')
  const explicit = cfText(input.account, 'account', 64)
  const account = explicit === '' ? await cf.zoneAccountId(token, zone) : cfId(explicit, 'account')
  return { requestedScope, account, zone }
}

/** A DDoS ASN: the autonomous-system number, 1..4294967295. */
function cfAsn(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > 4294967295) {
    throw configError('asn must be an integer between 1 and 4294967295')
  }
  return number
}

/** A `day_report` date: a real calendar day written YYYY-MM-DD. */
function cfDate(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw configError('date must be a calendar day written YYYY-MM-DD (required for day_report)')
  }
  return text
}

/** The two botnet-feed report shapes, and nothing else. */
const CF_BOTNET_REPORTS = new Set(['full_report', 'day_report'])
function cfBotnetReport(value) {
  const text = cfText(value, 'report', 16)
  const report = text === '' ? 'full_report' : text
  if (!CF_BOTNET_REPORTS.has(report)) throw configError(`report must be one of ${[...CF_BOTNET_REPORTS].join(', ')}`)
  return report
}

/** The DDoS overrides object — an opaque, non-empty JSON object by design. */
function cfOverrides(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    throw configError('overrides must be a non-empty object, e.g. {rules:[{id,enabled,action}]} or {enabled:true}')
  }
  return value
}

/**
 * The analytics query this plugin sends — ONE builder, so the tool, the route and
 * the tests cannot disagree about the shape.
 *
 * Two adaptive groups per zone: HTTP request counts by edge status, and firewall
 * events by action. `datetime_geq/leq` are the documented filter names; the zone
 * tag is a variable, never string-interpolated (the query text is constant, so a
 * caller cannot inject GraphQL through a zone id or a timestamp).
 *
 * @param options - `{ since, until, limit }`.
 * @returns `{ query, variables }`.
 */
export function buildCloudflareAnalyticsQuery({ since, until, limit = 10 } = {}) {
  const iso = (value, label) => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '' || Number.isNaN(Date.parse(text))) throw configError(`${label} must be an ISO-8601 timestamp`)
    return new Date(text).toISOString()
  }
  const size = Number(limit ?? 10)
  if (!Number.isInteger(size) || size < 1 || size > 1000) throw configError('limit must be an integer between 1 and 1000')
  const query = [
    'query ConnectorZoneAnalytics($zoneTag: String!, $since: Time!, $until: Time!, $limit: Int!) {',
    '  viewer {',
    '    zones(filter: { zoneTag: $zoneTag }) {',
    '      httpRequestsAdaptiveGroups(limit: $limit, filter: { datetime_geq: $since, datetime_leq: $until }) {',
    '        count',
    '        dimensions { edgeResponseStatus }',
    '      }',
    '      firewallEventsAdaptiveGroups(limit: $limit, filter: { datetime_geq: $since, datetime_leq: $until }) {',
    '        count',
    '        dimensions { action }',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n')
  return { query, variables: { since: iso(since, 'since'), until: iso(until, 'until'), limit: size } }
}

/**
 * The SECURITY EVENTS query — one builder, same discipline as the analytics one.
 *
 * There is NO REST `/security/events` endpoint: the dashboard's Security Events
 * view is `firewallEventsAdaptive` over GraphQL, gated by `analytics.read` on the
 * zone. This builder is the exact documented shape:
 *
 *   viewer.zones(filter:{zoneTag}) { firewallEventsAdaptive(
 *     filter:{datetime_geq,datetime_leq}, limit:≤100, orderBy:[datetime_DESC])
 *     { action, clientIP, clientRequestHTTPHost, clientRequestPath, ruleId, source, datetime } }
 *
 * The zone tag and both timestamps travel as VARIABLES (never interpolated), and
 * `limit` is capped at 100 — the documented maximum for this dataset (the
 * analytics builder's 1000 is a different dataset, so the two caps are separate).
 *
 * @param options - `{ since, until, limit }`.
 * @returns `{ query, variables }`.
 */
export function buildCloudflareSecurityEventsQuery({ since, until, limit = 100 } = {}) {
  const iso = (value, label) => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '' || Number.isNaN(Date.parse(text))) throw configError(`${label} must be an ISO-8601 timestamp`)
    return new Date(text).toISOString()
  }
  const size = Number(limit ?? 100)
  if (!Number.isInteger(size) || size < 1 || size > 100) {
    throw configError('limit must be an integer between 1 and 100 for security events')
  }
  const query = [
    'query ConnectorSecurityEvents($zoneTag: String!, $since: Time!, $until: Time!, $limit: Int!) {',
    '  viewer {',
    '    zones(filter: { zoneTag: $zoneTag }) {',
    '      firewallEventsAdaptive(filter: { datetime_geq: $since, datetime_leq: $until }, limit: $limit, orderBy: [datetime_DESC]) {',
    '        action',
    '        clientIP',
    '        clientRequestHTTPHost',
    '        clientRequestPath',
    '        ruleId',
    '        source',
    '        datetime',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n')
  return { query, variables: { since: iso(since, 'since'), until: iso(until, 'until'), limit: size } }
}

/**
 * Truncate text to a configured character budget, keeping the tail.
 * @param text - candidate text.
 * @param limit - maximum characters.
 * @returns the (possibly truncated) text.
 */
function clamp(text, limit) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (value.length <= limit) return value
  return `… [truncated ${value.length - limit} chars]\n${value.slice(value.length - limit)}`
}

/**
 * A caller-side precondition: bad input, a missing setting, a path outside the
 * workspace. Carries `code` so the route layer answers 400 by inspection.
 * @param message - token-free, user-facing text.
 * @returns the error, for `throw`.
 */
function configError(message) {
  const error = new TypeError(message)
  error.code = 'CONNECTOR_BAD_REQUEST'
  return error
}

/**
 * Assert a repository owner/name pair before it reaches a URL path.
 * @param value - candidate part.
 * @param label - field name for the error.
 * @returns the part.
 */
function repoPart(value, label) {
  const text = String(value ?? '')
  if (!REPO_PART.test(text) || text === '.' || text === '..') throw new TypeError(`${label} must match ${String(REPO_PART)}`)
  return text
}

/**
 * Assert a branch / tag / commit-ish name.
 * @param value - candidate ref.
 * @param label - field name for the error.
 * @returns the ref.
 */
function refName(value, label = 'ref') {
  const text = String(value ?? '')
  if (!REF_PATTERN.test(text)) throw new TypeError(`${label} is not a valid ref name`)
  return text
}

/**
 * Assert the containment of a REPOSITORY path.
 *
 * This is the remote counterpart of {@link resolveInWorkspace}: the caller types a
 * path inside a repository, and nothing may climb out of it. Rules, all checked
 * before the string reaches a URL:
 *   * no absolute path, no backslash (which some servers normalize into one),
 *   * no `.` or `..` segment, no empty segment (`a//b`), no NUL or control char,
 *   * a conservative character set and a length bound.
 *
 * @param value - the path the caller named.
 * @param label - field name for the error.
 * @returns the path, unchanged.
 */
function repoPathIn(value, label = 'path') {
  const text = String(value ?? '').trim()
  if (text === '') throw new TypeError(`${label} must not be empty`)
  if (text.startsWith('/') || text.includes('\\') || text.includes('\u0000')) {
    throw configError(`${label} must be a relative repository path (no leading slash, no backslashes)`)
  }
  const segments = text.split('/')
  if (segments.some(part => part === '' || part === '.' || part === '..')) {
    throw configError(`${label} must not contain empty, "." or ".." segments`)
  }
  if (!FILE_PATH_PATTERN.test(text)) throw configError(`${label} contains characters that are not allowed in a repository path`)
  return text
}

/**
 * Assert a numeric id (issue number, pull number, run id).
 * @param value - candidate id.
 * @param label - field name for the error.
 * @returns the id as a string.
 */
function numericId(value, label) {
  const text = String(value ?? '').trim()
  if (!NUMERIC_ID.test(text)) throw new TypeError(`${label} must be a positive integer`)
  return text
}

/**
 * Assert a list of short strings (labels, assignees) with a bound.
 * @param value - candidate list.
 * @param label - field name for the error.
 * @param each - per-entry validator.
 * @param max - maximum entries.
 * @returns the normalized list.
 */
function stringList(value, label, each, max = 50) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of strings`)
  if (value.length > max) throw new TypeError(`${label} accepts at most ${max} entries`)
  const rows = value.map(entry => String(entry).trim())
  for (const row of rows) {
    if (!each.test(row)) throw new TypeError(`${label} contains an invalid entry: ${row}`)
  }
  return rows
}

/**
 * Resolve a possibly-relative project path and prove it is inside the workspace.
 *
 * Symlinks are resolved first, so `workspace/link -> /etc` cannot be pushed. The
 * comparison is done on the resolved strings with a trailing separator, which is
 * what stops `/workspace-evil` from satisfying a prefix test for `/workspace`.
 *
 * @param workspaceRoot - the only tree a push may read.
 * @param candidate - the path the user typed.
 * @returns the resolved absolute path.
 * @throws Error when the path is outside the workspace or missing.
 */
export function resolveInWorkspace(workspaceRoot, candidate) {
  const root = realpathSync(resolve(workspaceRoot))
  const absolute = resolve(root, String(candidate ?? ''))
  let real
  try {
    real = realpathSync(absolute)
  } catch {
    throw configError(`path not found inside the workspace: ${candidate}`)
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw configError('the project path must stay inside the workspace')
  }
  return real
}

/**
 * Run a child process without a shell, capturing both streams.
 * @param command - executable.
 * @param args - argv (never carries a secret).
 * @param options - `cwd` and extra environment.
 * @returns exit code and captured text.
 */
function run(command, args, { cwd, env = {}, timeoutMs = 120000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: -1, stdout, stderr: `${stderr}${error.message}`, spawnError: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * Flows parked across a config write.
 *
 * `configEditor.edit` applies the new config to the Loader, which DISPOSES and
 * re-creates the plugin row: `createOperations` runs again and every per-instance
 * map is new. A device flow started in the window between the page's "Save Client
 * ID" and its "Start device flow" would therefore be unpollable at its first
 * tick. The module itself stays loaded across that reload, so this ONE map lives
 * at module scope: a flow parked here is adopted by whichever instance polls it
 * next, and is consumed at that moment.
 *
 * The entries carry exactly the same deadline and single-use rule as the live map
 * — nothing about the device code changes, and it still never leaves the host.
 */
const handedOffFlows = new Map()

/** Park one flow for the instance that replaces this one. */
function handOff(flowId, flow) {
  const now = Date.now()
  for (const [id, parked] of handedOffFlows) {
    if (now > parked.expiresAt) handedOffFlows.delete(id)
  }
  // Bounded: a hand-off is a rare, one-turn event and never an unbounded log.
  if (handedOffFlows.size >= 8) handedOffFlows.delete(handedOffFlows.keys().next().value)
  handedOffFlows.set(flowId, flow)
}

/** Adopt a parked flow into the calling instance's map, once. */
function adoptHandedOff(flowId) {
  const parked = handedOffFlows.get(flowId)
  if (parked === undefined) return undefined
  handedOffFlows.delete(flowId)
  if (Date.now() > parked.expiresAt) return undefined
  return parked
}

/**
 * Create the operations facade.
 *
 * @param options - wiring.
 * @param options.ctx - plugin context (credential store, config editor).
 * @param options.config - live non-secret config (mutated by the settings route).
 * @param options.workspaceRoot - the tree a push may read.
 * @param options.logger - optional logger used for KIND-ONLY diagnostics.
 * @returns the operations.
 */
export function createOperations({ ctx, config, workspaceRoot, logger }) {
  const outputLimit = Number(config?.outputLimit ?? 8000)
  const timeoutMs = Number(config?.requestTimeoutMs ?? 20000)
  /**
   * Device-flow state lives HERE and only here: the `device_code` a GitHub
   * device-flow login returns is a bearer-equivalent secret, so the page is given
   * an opaque `flowId` and never the code itself. Nothing is persisted, and an
   * entry expires on its own deadline.
   */
  const deviceFlows = new Map()
  const settings = {
    gitea: { baseUrl: normalizeBaseUrl(config?.gitea?.apiBase ?? ''), allowSelfSigned: config?.gitea?.allowSelfSigned === true },
    defaultAlias: {
      github: config?.github?.defaultAlias ?? 'default',
      cloudflare: config?.cloudflare?.defaultAlias ?? 'default',
      gitea: config?.gitea?.defaultAlias ?? 'default',
    },
    // Reference NAMES only — never a value. They are read from the live config
    // on every call (an alias's reference is live config, not a cached copy).
    credentialRef: { ...DEFAULT_REFS },
    aliases: {},
    /**
     * The GUI origin the last request arrived on, e.g. `http://127.0.0.1:3079`.
     *
     * NOT a setting and not persisted: the routes set it per request from the
     * `Host` header, because the OAuth redirect URI must match the address bar
     * exactly and a hard-coded port would break any other deployment. It is only
     * ever used to BUILD a callback URL for the user's own browser.
     */
    guiOrigin: '',
  }
  /** Per-instance capability memo for Gitea's Actions / blame / route surface. */
  const giteaVersion = { at: 0, baseUrl: '', caps: { version: '', actions: true, actionLogs: false }, routes: undefined, routesBaseUrl: '' }

  /**
   * One HTTP call. `redirect: 'follow'` matters for GitHub's log archive; the
   * response is normalized to `{ ok, status, headers, json, text }` so adapters
   * never touch a `Response` body twice.
   */
  async function request(url, { method = 'GET', headers = {}, body } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const response = await fetch(url, { method, headers, body, redirect: 'follow', signal: controller.signal })
      const text = await response.text()
      let json
      try { json = text === '' ? undefined : JSON.parse(text) } catch { json = undefined }
      const flat = {}
      response.headers.forEach((value, key) => { flat[key.toLowerCase()] = value })
      return { ok: response.ok, status: response.status, headers: flat, json, text }
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`request timed out after ${timeoutMs} ms`)
      throw new Error(`request failed: ${error?.message ?? error}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Adapters are stateless views over the current config, so they are cheap to rebuild. */
  function adapters(alias = undefined) {
    return {
      github: createGitHub({
        apiBase: config?.github?.apiBase ?? 'https://api.github.com',
        request,
        // THE REFRESH HOOK, bound to the alias whose read is in flight. The
        // adapter calls it at most once, only for a 401 on a `/repos/...` READ —
        // never for a write and never for `/user*`.
        onUnauthorized: () => refreshGitHubAccess(alias),
      }),
      cloudflare: createCloudflare({
        apiBase: config?.cloudflare?.apiBase ?? 'https://api.cloudflare.com',
        request,
        runWrangler: (args, env, cwd) => run('npx', ['--yes', 'wrangler', ...args], { cwd, env }),
      }),
      gitea: createGitea({ apiBase: settings.gitea.baseUrl, request, version: giteaVersion }),
    }
  }

  /**
   * Scrub one or more values out of a result tree (string leaves only).
   *
   * The caller's own value is already the only one it knows; the refresh flow can
   * introduce a SECOND value (the renewed access token) that the caller never
   * saw, so both are scrubbed together.
   */
  function scrubResult(result, secrets) {
    return JSON.parse(JSON.stringify(result, (_key, value) => (
      typeof value === 'string'
        ? secrets.reduce((text, secret) => redact(text, secret), value)
        : value
    )))
  }

  /**
   * ONE refresh attempt for a Cloudflare access token the API rejected.
   *
   * Called from {@link withSecret} when — and only when — a Cloudflare response
   * carried a 401 for the token itself. The refresh token is resolved at call
   * time from its own dedicated reference, used for one request body, and
   * released; Cloudflare rotates it on use, so a new one is written back.
   *
   * A REFUSED refresh is terminal for this login: both references are cleared, so
   * the card reads UNRESOLVED (and offers Login again) instead of advertising a
   * token that can never work. The error is typed and carries
   * `reason: 'refresh_refused'`; it never names a value.
   *
   * @param alias - the alias the call was made for.
   * @returns the renewed access token, or `undefined` when no refresh is possible.
   */
  async function refreshCloudflareAccess(alias) {
    const clientId = cloudflareOAuthClientId()
    if (clientId === '') return undefined
    const refreshRef = cloudflareRefreshRefName(config, alias)
    const refreshToken = await resolveSecret(ctx, refreshRef)
    if (refreshToken === undefined) return undefined
    const answer = await refreshCloudflareToken({
      clientId, refreshToken, request, origin: cloudflareOAuthOrigin(),
    })
    if (answer.ok !== true) {
      const { ref } = targetOf('cloudflare', alias)
      // Best effort: a store failure here must not mask the provider's refusal.
      await unsetSecret(ctx, ref).catch(() => undefined)
      await unsetSecret(ctx, refreshRef).catch(() => undefined)
      const refused = new Error('Cloudflare refused to refresh this login; press Login on the Cloudflare card to authorize again')
      refused.code = 'CONNECTOR_PROVIDER_ERROR'
      refused.reason = 'refresh_refused'
      throw refused
    }
    const { ref } = targetOf('cloudflare', alias)
    await setSecret(ctx, ref, answer.accessToken)
    if (typeof answer.refreshToken === 'string' && answer.refreshToken !== '') {
      // Rotation is the provider's call, not ours: store what it sent, keep the
      // old one only when it sent nothing (some servers do not rotate).
      await setSecret(ctx, refreshRef, answer.refreshToken)
    }
    return answer.accessToken
  }

  /**
   * ONE refresh attempt for a rejected GitHub access token — the device-flow
   * analogue of {@link refreshCloudflareAccess}.
   *
   * GitHub's device flow returns a `refresh_token` when the OAuth App has
   * "Expire user access tokens" enabled (access token 8 h, refresh token 6
   * months). When a repo READ answers 401 "Bad credentials", the adapter calls
   * this ONCE, retries AUTHENTICATED, and only then falls back to an anonymous
   * public read.
   *
   * The refresh token is resolved at call time from its own reference, sent in
   * ONE request body, and released. GitHub rotates it, so a new one is stored
   * when present. A REFUSED refresh is terminal: both references are cleared, so
   * the card reads UNRESOLVED and offers Login again, and the error is typed with
   * `reason: 'refresh_refused'` (route 424) — never quiet, never echoing a value.
   *
   * @param alias - the alias the read was made for.
   * @returns the renewed access token, or `undefined` when no refresh is possible.
   */
  async function refreshGitHubAccess(alias) {
    const clientId = deviceClientId()
    if (clientId === '') return undefined
    const refreshRef = githubRefreshRefName(config, alias)
    const refreshToken = await resolveSecret(ctx, refreshRef)
    if (refreshToken === undefined) return undefined
    // OPTIONAL client secret: an OAuth App that refreshes for a confidential
    // client sends one. It is a reference NAME in config and resolved here only.
    const secretRef = config?.github?.clientSecretRef
    const clientSecret = isRefName(secretRef) ? await resolveSecret(ctx, secretRef) : undefined
    const origin = webOriginOf(config?.github?.apiBase)
    const answer = await request(`${origin}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
        ...(clientSecret === undefined ? {} : { client_secret: clientSecret }),
      }).toString(),
    })
    const body = answer.json ?? {}
    const token = typeof body.access_token === 'string' ? body.access_token : ''
    if (!answer.ok || token === '') {
      const { ref } = targetOf('github', alias)
      await unsetSecret(ctx, ref).catch(() => undefined)
      await unsetSecret(ctx, refreshRef).catch(() => undefined)
      const refused = new Error('GitHub refused to refresh this login; press Login on the GitHub card to authorize again')
      refused.code = 'CONNECTOR_PROVIDER_ERROR'
      refused.reason = 'refresh_refused'
      throw refused
    }
    const { ref } = targetOf('github', alias)
    await setSecret(ctx, ref, token)
    if (typeof body.refresh_token === 'string' && body.refresh_token !== '') {
      await setSecret(ctx, refreshRef, body.refresh_token)
    }
    return token
  }

  /**
   * Revoke a Cloudflare OAuth grant (access + refresh), best effort.
   *
   * Only the OAuth pair is revoked: a manually stored API token has nothing to
   * revoke at `/oauth2/revoke` (the dashboard's token page owns it), and this
   * function never guesses. A host with no client id, or an alias with no stored
   * value, simply reports `false`; the caller unsets the local reference either
   * way. Neither token is logged, echoed or measured.
   *
   * @param alias - the alias being logged out.
   * @param ref - its access reference.
   * @returns whether at least one revocation was accepted.
   */
  async function revokeCloudflareGrant(alias, ref) {
    const clientId = cloudflareOAuthClientId()
    if (clientId === '') return false
    const origin = cloudflareOAuthOrigin()
    let revoked = false
    const accessToken = await resolveSecret(ctx, ref).catch(() => undefined)
    if (accessToken !== undefined) {
      const answer = await revokeCloudflareToken({ clientId, token: accessToken, tokenTypeHint: 'access_token', request, origin })
      revoked = revoked || answer.ok === true
    }
    const refreshRef = cloudflareRefreshRefName(config, alias)
    const refreshToken = await resolveSecret(ctx, refreshRef).catch(() => undefined)
    if (refreshToken !== undefined) {
      const answer = await revokeCloudflareToken({ clientId, token: refreshToken, tokenTypeHint: 'refresh_token', request, origin })
      revoked = revoked || answer.ok === true
    }
    return revoked
  }

  /**
   * Resolve one alias's reference and run `fn` with the value — THE ONLY place a
   * secret is read, and the only place one exists in this plugin's scope.
   *
   * `fn` receives `(secret, alias, credentialRef)`. The secret is for one request
   * (or one askpass file); everything `fn` returns is scrubbed of it before it
   * leaves this module, and a thrown error is scrubbed the same way.
   *
   * CLOUDFLARE OAUTH RETRY. An access token minted by the OAuth flow expires. When
   * a Cloudflare call fails with a 401 for the token itself, this attempts ONE
   * refresh and ONE retry; a second failure is surfaced as the typed provider
   * error (route: 424), and a refused refresh additionally clears both references
   * (see {@link refreshCloudflareAccess}). No other provider retries: a GitHub PAT
   * or Gitea token that fails does not become valid by asking again.
   */
  async function withSecret(provider, alias, fn) {
    const name = alias === undefined || alias === '' ? settings.defaultAlias[provider] : assertAlias(alias)
    const credentialRef = requireRefName(config, provider, alias)
    const secret = await resolveSecret(ctx, credentialRef)
    if (secret === undefined) {
      const missing = new Error(`credential reference ${credentialRef} does not resolve; store that credential in DSH (or point alias "${name}" at another reference)`)
      missing.code = 'CONNECTOR_NO_TOKEN'
      throw missing
    }
    /** A typed failure whose message cannot contain either value. */
    const fail = (error, secrets) => {
      const text = secrets.reduce((value, secretValue) => redact(value, secretValue), String(error?.message ?? error))
      const failure = new Error(text)
      failure.code = error?.code ?? 'CONNECTOR_PROVIDER_ERROR'
      if (Number.isFinite(error?.status)) failure.status = error.status
      if (error?.tokenRejected === true) failure.tokenRejected = true
      if (typeof error?.reason === 'string') failure.reason = error.reason
      // A classification (not a value): the consent vs missing-scope distinction
      // survives the redaction wrapper, so a caller can branch on the reason.
      if (typeof error?.reasonClass === 'string') failure.reasonClass = error.reasonClass
      if (typeof error?.scopeMissing === 'string') failure.scopeMissing = error.scopeMissing
      return failure
    }
    let result
    try {
      result = await fn(secret, name, credentialRef)
    } catch (error) {
      if (provider !== 'cloudflare' || error?.tokenRejected !== true) throw fail(error, [secret])
      let renewed
      try {
        renewed = await refreshCloudflareAccess(name)
      } catch (refreshError) {
        throw fail(refreshError, [secret])
      }
      if (renewed === undefined) throw fail(error, [secret])
      try {
        result = await fn(renewed, name, credentialRef)
      } catch (second) {
        throw fail(second, [secret, renewed])
      }
      // Defense in depth: neither value may appear in what this returns.
      return scrubResult(result, [secret, renewed])
    }
    // Defense in depth: nothing returned may carry the value.
    return scrubResult(result, [secret])
  }

  /**
   * Refuse a verb on a provider that does not have it, in words the model can
   * repeat to the user. Cloudflare has Pages deployments and nothing else, so
   * every repository verb lands here instead of on a missing adapter method.
   */
  function assertProviderVerb(name, action) {
    if (name !== 'cloudflare') return
    if (action === 'actions_logs') return
    throw new TypeError(`Cloudflare supports only actions_logs (Pages deployments); "${action}" is a GitHub/Gitea verb and has no Cloudflare equivalent`)
  }

  /** The Gitea base URL must be configured before any Gitea call can be built. */
  function assertGiteaReady(name) {
    if (name === 'gitea' && settings.gitea.baseUrl === '') {
      throw configError('Gitea base URL is not configured; set it under Status → Gitea first')
    }
  }

  /**
   * The non-secret answer a Login/Logout returns — and the whole of it.
   *
   * `{ ok, credentialRef, source }` names the reference and, when the store
   * reports one, the layer that now supplies it (`file` after a save). It carries
   * no token, no fragment of one, no length, and no timestamp derived from one.
   */
  async function referenceReceipt(name, ref) {
    const state = await describeCredential(ctx, ref)
    return {
      ok: true,
      credentialRef: ref,
      source: state.source ?? 'file',
      provider: name,
      resolved: state.resolved,
    }
  }

  /**
   * Normalize the alias half of a Login request and return both the alias and the
   * reference it addresses, so a write can never land on an unintended reference.
   */
  function targetOf(providerName, alias) {
    const target = assertAlias(alias === undefined || alias === '' ? settings.defaultAlias[providerName] : alias)
    return { alias: target, ref: requireRefName(config, providerName, target) }
  }

  /**
   * The Gitea OAuth2 application's PUBLIC client id, when one is configured.
   *
   * Same rule as GitHub's: it travels in the authorize URL, so it is config, not a
   * secret. Empty means the panel asks for it inline before it can start a login.
   */
  function giteaOAuthClientId() {
    const value = config?.giteaOAuthClientId
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
  }

  /**
   * Cloudflare's PUBLIC OAuth client id.
   *
   * The user registers their own client (Manage Account → OAuth clients) and
   * pastes its Client ID here. Wrangler's fixed first-party client is NEVER
   * reused: its redirect is bound to `localhost:8976`, it is not ours to
   * impersonate, and a login that depended on it could not complete inside this
   * host. A client with `token_endpoint_auth_method: none` has NO secret, which
   * is why this is one public value and nothing more.
   */
  function cloudflareOAuthClientId() {
    const value = config?.cloudflareOAuthClientId
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
  }

  /**
   * The OAuth origin for Cloudflare's dashboard endpoints.
   *
   * Defaults to `https://dash.cloudflare.com` (authorize/token/revoke all live
   * there). Configurable so a test — or a future enterprise dashboard host — can
   * point at its own origin; it is never derived from a token.
   */
  function cloudflareOAuthOrigin() {
    const configured = config?.cloudflare?.oauthBase
    const value = typeof configured === 'string' ? configured.trim().replace(/\/+$/u, '') : ''
    return /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(value) ? value : CLOUDFLARE_OAUTH_ORIGIN
  }

  /**
   * The exact text a refused redirect origin produces. One constant, so the page,
   * the route and the tests cannot drift.
   */
  const CLOUDFLARE_INSECURE_ORIGIN_MESSAGE = 'Cloudflare only accepts HTTPS redirect URLs (or http://localhost:…). Open the Connector at your HTTPS domain (e.g. https://<domain>) and press Login there, or add cloudflareCallbackOrigin to settings with your HTTPS origin.'

  /**
   * Resolve the redirect that will actually be sent to Cloudflare.
   *
   * Precedence: the configured `cloudflareCallbackOrigin` override, then the
   * origin the browser's request arrived on. The override exists because the
   * page can be reached over plain HTTP on an IP address (a LAN address, a
   * loopback alias), which Cloudflare refuses as an insecure redirect — the user
   * therefore registers their HTTPS domain on the OAuth client and points this
   * setting at it.
   *
   * Nothing is guessed: an unparseable value yields an empty origin, which the
   * callers report as "cannot tell the origin" rather than inventing one.
   *
   * @param redirectUri - the callback URL the caller derived from the request.
   * @returns `{ configured, origin, redirectUri }`.
   */
  function cloudflareCallbackTarget(redirectUri) {
    const configuredRaw = config?.cloudflareCallbackOrigin
    const configured = typeof configuredRaw === 'string' ? configuredRaw.trim().replace(/\/+$/u, '') : ''
    const requested = typeof redirectUri === 'string' && redirectUri !== '' ? redirectUri : cloudflareCallbackUrlOf(settings.guiOrigin ?? '')
    const candidate = configured !== '' ? configured : requested
    let origin = ''
    let bare = false
    try {
      const parsed = new URL(candidate)
      origin = `${parsed.protocol}//${parsed.host}`
      // A caller may hand over an ORIGIN (the page derives it from the address
      // bar, which is the only place that knows the real scheme). An origin has
      // no path, so the callback path is appended rather than sent bare.
      bare = parsed.pathname === '' || parsed.pathname === '/'
    } catch {
      origin = ''
      bare = false
    }
    return {
      configured,
      origin,
      // A configured override is an ORIGIN, so the callback path is rebuilt onto
      // it; an incoming callback URL is used verbatim.
      redirectUri: origin === '' ? '' : (configured !== '' || bare ? cloudflareCallbackUrlOf(origin) : candidate),
    }
  }

  /**
   * Normalize (and gate) the non-secret `cloudflareCallbackOrigin` setting.
   *
   * Bare origin only — it is a redirect PREFIX, not a URL — and it must already
   * satisfy Cloudflare's policy, so a save can never configure a login that will
   * be refused at the authorize step.
   *
   * @param value - candidate origin (`''` clears the override).
   * @returns the normalized origin.
   */
  function normalizeCloudflareCallbackOrigin(value) {
    const text = typeof value === 'string' ? value.trim().replace(/\/+$/u, '') : ''
    if (text === '') return ''
    let parsed
    try {
      parsed = new URL(text)
    } catch {
      throw configError('cloudflareCallbackOrigin must be an origin such as https://connector.example.com')
    }
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      throw configError('cloudflareCallbackOrigin must be an origin only — no path; the callback path is added by the plugin')
    }
    const origin = `${parsed.protocol}//${parsed.host}`
    if (!isCloudflareRedirectOrigin(origin)) {
      throw configError('cloudflareCallbackOrigin must be HTTPS (or http://localhost:<port>) and must be registered among the OAuth client\'s redirect (callback) URLs')
    }
    return origin
  }

  /**
   * The scopes this login asks for.
   *
   * Default is the Pages/Workers write set plus `offline_access` (which is what
   * makes Cloudflare return a refresh token). The value is editable in the Login
   * panel and stored as a space/comma separated string, because the scope ids are
   * the user's choice: the live catalogue is
   * `GET https://api.cloudflare.com/client/v4/oauth/scopes`.
   */
  function cloudflareScopes() {
    const raw = config?.cloudflareOAuthScopes
    const text = typeof raw === 'string' ? raw.trim() : ''
    const parsed = text === '' ? [] : text.split(/[,\s]+/u).map(part => part.trim()).filter(Boolean)
    // Scope ids are dot-delimited lowercase identifiers. Anything else is a typo,
    // and refusing it here beats a provider error on the consent screen.
    const valid = []
    for (const scope of parsed) {
      if (!/^[a-z][a-z0-9._:-]{1,80}$/u.test(scope)) {
        throw configError(`"${scope}" is not a Cloudflare OAuth scope id; use GET /client/v4/oauth/scopes for the live list`)
      }
      if (!valid.includes(scope)) valid.push(scope)
    }
    return valid.length === 0 ? [...CLOUDFLARE_DEFAULT_SCOPES] : valid
  }

  /**
   * Verify the Gitea OAuth2 client SECRET resolves — WITHOUT reading or exposing it.
   *
   * The exchange resolves the value itself at call time; this exists so the panel
   * can say "a secret is stored" instead of offering a form that would silently
   * fail an exchange later. `describe` answers configured/source only.
   */
  async function giteaSecretState(alias) {
    const ref = clientSecretRefName(config, alias)
    const state = await describeCredential(ctx, ref)
    return { credentialRef: ref, resolved: state.resolved === true, ...(state.source === undefined ? {} : { source: state.source }) }
  }

  /**
   * The OAuth state store for the Gitea authorization-code flow.
   *
   * One per operations instance, and handed off across a config reload exactly
   * like the device flows: `configEditor.edit` disposes this module instance, and
   * a callback that arrives immediately after an inline Client ID save would
   * otherwise be refused as "unknown state". Only ONE pending attempt per alias is
   * kept — a second start supersedes the first, which is also what a user pressing
   * Login twice expects.
   */
  const oauthStates = createStateStore()

  /**
   * The GitHub device-flow client id, when one is configured. It is a public
   * identifier (it travels in a URL), which is exactly why it is config and not a
   * secret; the device flow needs no client secret.
   */
  function deviceClientId() {
    const value = config?.githubDeviceClientId
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
  }

  /**
   * A public client id, as pasted from GitHub's OAuth App page.
   *
   * It is NOT a secret — it travels in the verification URL and the device flow
   * uses no client secret — so it lives in config beside the endpoints. The
   * grammar is deliberately loose (GitHub has shipped `Iv1.<hex>`, `Ov23li…`
   * and app-slug forms); what is refused is an empty-but-not-blank value, a
   * value with whitespace inside, and anything URL-ish enough to be a mistake.
   */
  function normalizeClientId(value) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '') return ''
    if (!/^[A-Za-z0-9._-]{4,128}$/u.test(text)) {
      throw configError('the GitHub client id must be the public "Client ID" string (letters, digits, dot, dash or underscore)')
    }
    return text
  }

  /**
   * Drop every flow whose deadline has passed, so the map only ever holds live
   * entries. Called before a new flow is parked; a retry for the same
   * provider+alias removes its predecessor explicitly.
   */
  function pruneDeviceFlows(now = Date.now()) {
    for (const [id, flow] of deviceFlows) {
      if (now > flow.expiresAt) deviceFlows.delete(id)
    }
  }

  /** Park one flow for the instance that replaces this one. */
  function handOff(flowId, flow) {
    const now = Date.now()
    for (const [id, parked] of handedOffFlows) {
      if (now > parked.expiresAt) handedOffFlows.delete(id)
    }
    // Bounded: a hand-off is a rare, one-turn event and never an unbounded log.
    if (handedOffFlows.size >= 8) handedOffFlows.delete(handedOffFlows.keys().next().value)
    handedOffFlows.set(flowId, flow)
  }

  /** Adopt a parked flow into THIS instance's map, once. */
  function adopt(flowId) {
    const parked = adoptHandedOff(flowId)
    if (parked === undefined) return undefined
    deviceFlows.set(flowId, parked)
    return parked
  }

  /**
   * Make sure the LIVE config object carries a client id before a flow starts.
   *
   * Two situations reach here: (a) the page saved the public id a moment ago and
   * the row has already reloaded — the config object is then fresh and nothing
   * happens; (b) the save is still in flight, so this instance still sees an
   * empty `githubDeviceClientId` while the request the user just made was
   * accepted. In (b) the id is read back from the profile's own config document
   * and adopted, so the very click that follows the save starts a flow instead
   * of failing on a value the user can see on screen.
   *
   * @returns true when the value had to be adopted from disk (a reload may be
   *   imminent, so a started flow is handed off).
   */
  async function ensureDeviceConfigFresh() {
    if (deviceClientId() !== '') return false
    const editor = ctx?.get?.('configEditor')
    let saved
    try { saved = editor?.documentPath } catch { saved = undefined }
    if (typeof saved !== 'string' || saved === '') return false
    let raw
    try { raw = await readFile(saved, 'utf8') } catch { return false }
    const recovered = findClientIdInPatch(raw)
    if (recovered === '') return false
    if (config !== null && typeof config === 'object') config.githubDeviceClientId = recovered
    return true
  }

  /**
   * Pull `githubDeviceClientId` out of a profile patch without a YAML engine.
   *
   * A plain line scan is enough and safer here: the key is top-level in the row
   * config, appears at most a few times, and the value is a PUBLIC identifier.
   * The LAST occurrence wins, which matches a patch that has been rewritten
   * several times.
   */
  function findClientIdInPatch(text) {
    let found = ''
    for (const line of String(text).split('\n')) {
      const match = /^\s*githubDeviceClientId:\s*(.+?)\s*$/u.exec(line)
      if (match === null) continue
      const value = match[1].replace(/^['"]|['"]$/gu, '').trim()
      if (/^[A-Za-z0-9._-]{4,128}$/u.test(value)) found = value
    }
    return found
  }

  const operations = {
    /** Where tokens live and which record keys this plugin owns. Values never appear. */
    store: () => ({ path: storePath(), scope: 'connector', keys: PROVIDERS.map(provider => `connector/${provider}-<alias>`) }),

    /** Current non-secret settings (safe for the page): endpoints and ref names. */
    settings: () => ({
      gitea: { baseUrl: settings.gitea.baseUrl, allowSelfSigned: settings.gitea.allowSelfSigned },
      defaultAlias: { ...settings.defaultAlias },
      credentialRef: { ...settings.credentialRef },
      // The Cloudflare want-list a re-consent asks for (public scope ids).
      cloudflareScopes: [...CLOUDFLARE_DEFAULT_SCOPES],
      // PUBLIC identifiers only. The Gitea client secret appears here as a
      // reference NAME; its value never does.
      giteaOAuthClientId: giteaOAuthClientId(),
      giteaClientSecretRef: clientSecretRefName(config, undefined),
      guiOrigin: settings.guiOrigin,
      workspaceRoot,
    }),

    /**
     * Record the origin this request arrived on, so callback URLs match the
     * browser's own address bar. Called by the route layer; a no-op value ('')
     * simply means "unknown", and callers fall back rather than guessing a port.
     *
     * @param input - `{ origin }`.
     * @returns `{ ok, origin }`.
     */
    setGuiOrigin({ origin } = {}) {
      const value = typeof origin === 'string' ? origin.trim().replace(/\/+$/u, '') : ''
      // http(s) only: this value is interpolated into a URL handed to a browser.
      settings.guiOrigin = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(value) ? value : ''
      return { ok: true, origin: settings.guiOrigin }
    },

    /**
     * Alias table: reference names and whether each resolves. No value, no mask.
     *
     * With `rateLimit: true` it also probes each resolvable provider's budget.
     * The probe is optional and fails soft: a provider that refuses, or whose
     * reference does not resolve, simply contributes no `rateLimit` field — the
     * status answer itself never fails because a budget could not be read.
     */
    async status({ provider, alias, rateLimit, redirectUri, cloudflareRedirectUri } = {}) {
      const table = await listReferences(ctx, config, { provider, alias })
      const providers = table.providers
      if (rateLimit === true) {
        for (const entry of providers) {
          const usable = (entry.aliases ?? []).filter(row => row.resolved === true)
          if (usable.length === 0) continue
          try {
            const budget = await operations.rateLimit({ provider: entry.provider, alias: usable[0].alias })
            if (budget.supported === true) entry.rateLimit = budget
            else if (typeof budget.reason === 'string') entry.rateLimit = { supported: false, reason: budget.reason }
          } catch (error) {
            entry.rateLimit = { supported: false, reason: redact(error?.message ?? error) }
          }
        }
      }
      return {
        scope: 'connector',
        storePath: storePath(),
        // DSH is the only place a credential value lives; this plugin persists
        // reference NAMES, which is why they are safe to show here.
        manageHint: 'Manage the credential itself in DSH (Settings → credentials, or the environment). This plugin stores only the reference name.',
        settings: operations.settings(),
        // Both logins are OAuth: the GitHub device flow, and Gitea's
        // authorization-code flow. Each advertises only what the panel needs to
        // render, and neither carries a value of any kind.
        device: operations.deviceFlow(),
        oauth: operations.oauthFlow({ redirectUri }),
        // Cloudflare's login is a real OAuth2 authorization-code + PKCE flow of
        // its own (public client, no secret, dashboard endpoints), so its
        // predicate is advertised separately rather than squeezed into Gitea's.
        oauthCloudflare: operations.cloudflareOAuthFlow({ redirectUri: cloudflareRedirectUri }),
        secret: settings.guiOrigin === undefined ? undefined : await operations.clientSecretState({}),
        providers,
      }
    },

    /**
     * The token's remaining budget, when the provider publishes one.
     *
     * GitHub answers `/rate_limit` (which costs no quota). Gitea emits
     * `X-RateLimit-*` headers only when its limiter is on, so an absent header is
     * reported as `supported: false` rather than "0 left". Cloudflare has no
     * equivalent surface and says so.
     */
    async rateLimit({ provider, alias } = {}) {
      const name = assertProvider(provider)
      assertGiteaReady(name)
      return withSecret(name, alias, async (token, usedAlias) => {
        const built = adapters(usedAlias)
        if (name === 'cloudflare') {
          return { supported: false, provider: name, reason: 'Cloudflare does not publish a GitHub-style rate limit for this token; usage is metered per token scope' }
        }
        const budget = await built[name].rateLimit(token)
        return { provider: name, ...budget }
      })
    },

    /**
     * Point one alias at a credential REFERENCE NAME (configuration, not a
     * secret) — the reference editor, not the login path.
     *
     * Kept separate from {@link saveRef} on purpose: this one edits the profile
     * patch through `configEditor` and never touches the credential store, which
     * is why it is safe for a request body to carry its argument.
     */
    async setAliasRef({ provider, alias, credentialRef }) {
      const name = assertProvider(provider)
      const target = assertAlias(alias === undefined || alias === '' ? settings.defaultAlias[name] : alias)
      const ref = String(credentialRef ?? '').trim()
      if (!isRefName(ref)) {
        throw configError('credential reference must be a name like GITHUB_TOKEN (letters, digits, underscore; not starting with a digit)')
      }
      const editor = ctx?.get?.('configEditor')
      const entry = ctx?.fiber?.entry
      if (editor === undefined || entry === undefined) {
        throw configError('settings can only be saved from the running host profile')
      }
      await editor.edit(entry, (current) => {
        const section = { ...(current[name] ?? {}) }
        if (target === (section.defaultAlias ?? 'default')) section.credentialRef = ref
        else section.aliases = { ...(section.aliases ?? {}), [target]: ref }
        return { ...current, [name]: section }
      })
      const state = await describeCredential(ctx, ref)
      return {
        ok: true, provider: name, alias: target, credentialRef: ref, resolved: state.resolved,
        ...(state.source === undefined ? {} : { source: state.source }),
      }
    },

    /**
     * LOGIN is OAuth ONLY (owner decision): there is no paste field anywhere.
     *
     * This entry point still exists because it is the seam the GitHub device-flow
     * poll writes through, and because a headless caller (a test, an operator, a
     * future provider adapter that completes a flow itself) needs one place to
     * hand over a token a PROVIDER issued. It is deliberately NOT reachable from
     * the page: there is no token input, so nothing in the UI can call it, and the
     * `POST /api/connector/credentials` route accepts only a client SECRET under
     * an explicitly named reference (see `saveClientSecret`).
     *
     * The receipt is `{ ok, credentialRef, source }` plus the non-secret
     * provider/resolved labels — never the token, never a suffix, never a length.
     * The reference NAME is not taken from the request: it is the one the alias is
     * already configured with (`refNameOf`), so a caller cannot write a value into
     * a reference it did not address.
     */
    async saveRef({ provider, alias, token } = {}) {
      const name = assertProvider(provider)
      const { alias: target, ref } = targetOf(name, alias)
      if (typeof token !== 'string' || token.trim() === '') throw configError('a token is required')
      await setSecret(ctx, ref, token)
      return { ...(await referenceReceipt(name, ref)), alias: target }
    },

    /**
     * Store the Gitea OAuth2 application's client SECRET.
     *
     * The secret is entered ONCE, in the Login panel, through a password-type
     * input, and travels to exactly one place: `ctx.credentials.set` under a
     * DEDICATED reference (`GITEA_CLIENT_SECRET` by default, per-alias aware).
     *
     * The reference is NOT taken from the request body when the alias maps one: it
     * is derived from config (`clientSecretRefName`), so a write cannot be aimed at
     * an arbitrary reference. The receipt is `{ ok, credentialRef }` and nothing
     * else — no value, no length, no fragment, and it is never logged.
     *
     * Cloudflare does NOT reach this route: its login is a real OAuth2
     * authorization-code + PKCE flow whose callback writes the token (see
     * {@link oauthCloudflareCallback}), so no page ever posts a Cloudflare value.
     *
     * @param input - `{ alias?, secret }`.
     * @returns `{ ok, credentialRef, provider }`.
     */
    async saveClientSecret({ alias, secret } = {}) {
      const target = assertAlias(alias === undefined || alias === '' ? settings.defaultAlias.gitea : alias)
      if (typeof secret !== 'string' || secret.trim() === '') throw configError('a client secret is required')
      const ref = clientSecretRefName(config, target)
      await setSecret(ctx, ref, secret)
      return { ok: true, provider: 'gitea', credentialRef: ref }
    },

    /**
     * LOGOUT — clear the value stored under one alias's credential REFERENCE.
     *
     * `ctx.credentials.unset` removes only the DSH-managed layer. A reference that
     * also resolves from the environment or a `.env` will read as resolved again
     * after this, and the receipt reports what the store says rather than
     * pretending the credential is gone.
     *
     * A logout ALSO abandons this provider's pending OAuth work: the pending
     * authorization states and every device flow for the provider are dropped, so
     * a callback or a poll that arrives afterwards cannot resurrect a login the
     * user has just ended. The client's counter is separate (`device/abort`), but
     * this makes the host's own state agree immediately.
     *
     * @param input - `{ provider, alias }`.
     * @returns the reference receipt.
     */
    async clearRef({ provider, alias } = {}) {
      const name = assertProvider(provider)
      const { alias: target, ref } = targetOf(name, alias)
      // CLOUDFLARE: a logout is a revoke, not only a local delete. Both halves of
      // the OAuth grant are revoked at the dashboard endpoint (best effort — the
      // local unset happens regardless, and a provider failure never stops it),
      // and the refresh reference is cleared with the access reference.
      let revoked = false
      if (name === 'cloudflare') {
        revoked = await revokeCloudflareGrant(target, ref)
      }
      // THE CLEANUP IS UNCONDITIONAL. A store refusal (a locked file, a provider
      // that throws on unset) must NOT abort the rest of the chain: the refresh
      // reference still gets its best-effort clear, every pending device flow and
      // every pending authorization state for THIS provider is still dropped, and
      // only then is the failure re-raised so the page can report it. A logout
      // that half-succeeds silently is worse than one that says it failed.
      let failure
      try {
        await unsetSecret(ctx, ref)
      } catch (error) {
        failure = error
      } finally {
        if (name === 'cloudflare') await unsetSecret(ctx, cloudflareRefreshRefName(config, target)).catch(() => undefined)
        // Abandon anything still in flight for this provider. No value is
        // involved: these are opaque flow ids and one-time state strings.
        for (const [flowId, flow] of deviceFlows) {
          if (flow.provider === name && flow.alias === target) deviceFlows.delete(flowId)
        }
        // ONLY this provider's pending states: a Gitea logout must not kill an
        // in-flight Cloudflare login, and vice versa.
        oauthStates.clearProvider(name)
      }
      if (failure !== undefined) throw failure
      return {
        ...(await referenceReceipt(name, ref)),
        alias: target,
        ...(name === 'cloudflare' ? { revoked } : {}),
      }
    },

    /**
     * ABANDON one in-flight login, without touching the credential store.
     *
     * Called when the page closes a login panel or presses Logout: the client also
     * clears its timer, but a poll that was already on the wire would otherwise
     * land and store a token for a login the user has walked away from. Dropping
     * the flow here makes that poll fail closed.
     *
     * SCOPED: the authorization states dropped are the ones minted for the
     * provider this call names (or the provider of the flow id it names). Only a
     * call with NEITHER means "every pending state", which is the page's logout
     * path. Another provider's in-flight login is never collateral.
     *
     * @param input - `{ flowId? }`; with no flow id, every flow for `provider` goes.
     * @returns `{ ok, aborted }` — a count, never a value.
     */
    async abortLogin({ flowId, provider } = {}) {
      const id = typeof flowId === 'string' ? flowId : ''
      let scope = provider === undefined ? undefined : assertProvider(provider)
      let aborted = 0
      if (id !== '') {
        // Learn the provider from the flow BEFORE dropping it, so a single-flow
        // abort still scopes the authorization-state cleanup correctly.
        if (scope === undefined) scope = deviceFlows.get(id)?.provider
        if (deviceFlows.delete(id)) aborted += 1
      } else {
        for (const [key, flow] of deviceFlows) {
          if (scope === undefined || flow.provider === scope) { deviceFlows.delete(key); aborted += 1 }
        }
      }
      // ONE provider's pending states go, never the whole store: abandoning a
      // Gitea login must not cancel an in-flight Cloudflare authorization. A flow
      // id that matched nothing (and named no provider) drops NO state either —
      // a bogus id must not be able to wipe every pending login.
      if (scope !== undefined) oauthStates.clearProvider(scope)
      else if (id === '') oauthStates.clear()
      return { ok: true, aborted }
    },

    /**
     * The Gitea authorization-code flow, step 0 — what the panel needs to decide
     * whether a click can authorize immediately or must first ask for the app's
     * public client id and its secret.
     *
     * Everything here is non-secret: the client id is public, and the secret's
     * state is `configured/source` only. `redirectUri` is the value the guide must
     * render, derived from the GUI origin the request arrived on.
     *
     * @param input - `{ redirectUri? }` (the caller's own origin wins).
     * @returns the panel's predicate.
     */
    oauthFlow: ({ redirectUri } = {}) => {
      const clientId = giteaOAuthClientId()
      const credentials = ctx?.get?.('credentials') ?? ctx?.credentials
      const writable = typeof credentials?.set === 'function'
      const editor = ctx?.get?.('configEditor')
      const canSaveClientId = typeof editor?.edit === 'function' && ctx?.fiber?.entry !== undefined
      const origin = giteaWebOrigin(settings.gitea.baseUrl)
      const callback = typeof redirectUri === 'string' && redirectUri !== ''
        ? redirectUri
        : callbackUrlOf(settings.guiOrigin ?? '')
      return {
        provider: 'gitea',
        // A click can authorize when the app is configured AND the store can
        // receive the token; otherwise the panel asks inline first.
        ready: clientId !== '' && writable && origin !== '',
        clientIdConfigured: clientId !== '',
        ...(clientId === '' ? {} : { clientId }),
        canSaveClientId,
        canStoreSecret: writable,
        baseUrlConfigured: origin !== '',
        authorizeBase: origin,
        // The exact URI the OAuth2 application must be registered with.
        redirectUri: callback,
        ...(writable ? {} : { reason: 'this host mounted no writable credential store' }),
        ...(origin === '' ? { reason: 'the Gitea base URL is not configured yet' } : {}),
        ...(clientId === '' ? { reason: 'no giteaOAuthClientId is configured (set one inline in the Login panel)' } : {}),
      }
    },

    /**
     * The Gitea secret's non-secret state, for the panel's "already stored" line.
     * @param input - `{ alias? }`.
     * @returns `{ credentialRef, resolved, source? }`.
     */
    async clientSecretState({ alias } = {}) {
      return giteaSecretState(alias)
    },

    /**
     * The Gitea authorization-code flow, step 1 — mint the authorize URL.
     *
     * The `state` is opaque, random, single-use and expires in ten minutes (see
     * `lib/oauth.js`). It is returned to the page because the page is what opens
     * the tab; it grants nothing on its own, and the callback is the only consumer.
     *
     * @param input - `{ alias?, redirectUri? }`.
     * @returns `{ ok, authorizeUrl, state, redirectUri, provider, alias }`.
     */
    async oauthStart({ alias, redirectUri } = {}) {
      const target = assertAlias(alias === undefined || alias === '' ? settings.defaultAlias.gitea : alias)
      const clientId = giteaOAuthClientId()
      if (clientId === '') throw configError('no giteaOAuthClientId is configured; enter the OAuth2 application client id in the Login panel')
      if (settings.gitea.baseUrl === '') throw configError('Gitea base URL is not configured; set it on the Gitea card')
      const callback = typeof redirectUri === 'string' && redirectUri !== '' ? redirectUri : callbackUrlOf(settings.guiOrigin ?? '')
      const state = oauthStates.issue({ provider: 'gitea', alias: target })
      const authorizeUrl = buildGiteaAuthorizeUrl({
        apiBase: settings.gitea.baseUrl,
        clientId,
        redirectUri: callback,
        state,
      })
      return {
        ok: true,
        provider: 'gitea',
        alias: target,
        authorizeUrl,
        state,
        redirectUri: callback,
        expiresInSeconds: 600,
      }
    },

    /**
     * The Gitea authorization-code flow, step 2 — the callback.
     *
     * This is the ONLY place the client secret is resolved, and it is resolved at
     * call time from the credential store (`resolveSecret`), used for exactly one
     * request body, and released. The access token that comes back is handed to
     * `setSecret` under the alias's GITEA reference and is never returned.
     *
     * Failure is reported by KIND: an unknown/consumed/expired state, a provider
     * refusal, or a missing token. No branch echoes the code, the state, the
     * secret, or the token, and none of them is logged.
     *
     * @param input - `{ code, state, redirectUri? }` from the query string.
     * @returns `{ ok, provider, alias, credentialRef, resolved, source? }`.
     */
    async oauthGiteaCallback({ code, state, redirectUri } = {}) {
      const entry = oauthStates.consume(state)
      if (entry === undefined) {
        const error = new Error('this login link is unknown, already used, or expired; start the login again')
        error.code = 'CONNECTOR_BAD_REQUEST'
        throw error
      }
      if (entry.provider !== 'gitea') {
        const error = new Error('this login link was issued for another provider')
        error.code = 'CONNECTOR_BAD_REQUEST'
        throw error
      }
      const authorizationCode = typeof code === 'string' ? code.trim() : ''
      if (authorizationCode === '') {
        const error = new Error('the provider did not return an authorization code; start the login again')
        error.code = 'CONNECTOR_BAD_REQUEST'
        throw error
      }
      const clientId = giteaOAuthClientId()
      if (clientId === '') throw configError('no giteaOAuthClientId is configured; start the login again')
      // `targetOf` proves the alias still has a reference NAME to write to.
      const { alias: target, ref } = targetOf('gitea', entry.alias)
      const secretRef = clientSecretRefName(config, target)
      const clientSecret = await resolveSecret(ctx, secretRef)
      if (clientSecret === undefined) {
        const error = new Error(`the Gitea OAuth2 client secret is not stored (reference ${secretRef}); enter it in the Login panel`)
        error.code = 'CONNECTOR_NO_TOKEN'
        throw error
      }
      const callback = typeof redirectUri === 'string' && redirectUri !== '' ? redirectUri : callbackUrlOf(settings.guiOrigin ?? '')
      const exchanged = await exchangeGiteaCode({
        apiBase: settings.gitea.baseUrl,
        clientId,
        clientSecret,
        code: authorizationCode,
        redirectUri: callback,
        request,
      })
      if (exchanged.ok !== true) {
        const error = new Error(`Gitea refused the token exchange${exchanged.status === 0 ? '' : ` (${exchanged.status})`}`)
        error.code = 'CONNECTOR_PROVIDER_ERROR'
        throw error
      }
      await setSecret(ctx, ref, exchanged.accessToken)
      const receipt = await referenceReceipt('gitea', ref)
      return { ...receipt, provider: 'gitea', alias: target }
    },

    /**
     * CLOUDFLARE OAUTH — step 0: what the Login panel needs.
     *
     * Cloudflare's self-managed OAuth clients are public clients: they have NO
     * client secret (`token_endpoint_auth_method: none`) and REQUIRE PKCE S256.
     * So this login needs exactly ONE value from the user — the public Client ID
     * of the client they registered — plus a scope list, and both are
     * configuration (they travel in a URL), not credentials.
     *
     * The redirect URI is rendered from THIS deployment's origin, because the
     * value must match the one registered on the Cloudflare client exactly.
     *
     * @param input - `{ redirectUri? }` (the caller's own origin wins).
     * @returns the panel's predicate: readiness, the public values, the reason.
     */
    cloudflareOAuthFlow: ({ redirectUri } = {}) => {
      const clientId = cloudflareOAuthClientId()
      const credentials = ctx?.get?.('credentials') ?? ctx?.credentials
      const writable = typeof credentials?.set === 'function'
      const editor = ctx?.get?.('configEditor')
      const canSaveSettings = typeof editor?.edit === 'function' && ctx?.fiber?.entry !== undefined
      let scopes
      let scopesValid = true
      try {
        scopes = cloudflareScopes()
      } catch (error) {
        scopesValid = false
        scopes = [...CLOUDFLARE_DEFAULT_SCOPES]
      }
      const oauthOrigin = cloudflareOAuthOrigin()
      const target = cloudflareCallbackTarget(redirectUri)
      const callback = target.redirectUri
      const accepted = target.origin !== '' && isCloudflareRedirectOrigin(target.origin)
      const reasons = []
      if (!accepted) reasons.push(CLOUDFLARE_INSECURE_ORIGIN_MESSAGE)
      if (clientId === '') reasons.unshift('no cloudflareOAuthClientId is configured (register an OAuth client under Manage Account → OAuth clients and enter its Client ID here)')
      if (writable !== true) reasons.push('this host mounted no writable credential store')
      if (!scopesValid) reasons.push('a configured Cloudflare scope is not a valid scope id')
      return {
        provider: 'cloudflare',
        ready: clientId !== '' && writable && scopesValid && accepted,
        clientIdConfigured: clientId !== '',
        ...(clientId === '' ? {} : { clientId }),
        canSaveSettings,
        scopes,
        scopesText: scopes.join(' '),
        // The WANT-LIST this build asks for on a fresh consent, independent of
        // what the user has edited: the panel shows the difference plainly.
        defaultScopes: [...CLOUDFLARE_DEFAULT_SCOPES],
        defaultScopesText: CLOUDFLARE_DEFAULT_SCOPES.join(' '),
        // The per-action gatekeepers, public: a 403 from `cloudflareAction`
        // carries the same ids, so the panel/agent can name the fix before the
        // call is even made.
        scopesByAction: Object.fromEntries(
          Object.entries(CLOUDFLARE_ACTION_SCOPES).map(([action, ids]) => [action, [...ids]]),
        ),
        // The public endpoints the guide names, and the PKCE method this client
        // uses. Wrangler's fixed first-party client is never involved.
        authorizeBase: oauthOrigin,
        authorizeUrl: `${oauthOrigin}/oauth2/auth`,
        tokenUrl: `${oauthOrigin}/oauth2/token`,
        revokeUrl: `${oauthOrigin}/oauth2/revoke`,
        pkce: 'S256',
        // The redirect Cloudflare will actually receive, its origin, whether that
        // origin satisfies Cloudflare's https-or-localhost rule, and the
        // non-secret override that produced it ('' = derived from the request).
        redirectUri: callback,
        callbackOrigin: target.origin,
        callbackOriginAccepted: accepted,
        callbackOriginConfigured: target.configured,
        // The PATH the page appends to an origin it derives itself (the browser
        // is the only party that knows the address bar; see the panel's display
        // rule). Served from here so the two halves cannot drift.
        callbackPath: CLOUDFLARE_CALLBACK_PATH,
        // Where the redirect came from: the non-secret override, or this host's
        // reading of the request. The panel shows which, so a proxy that strips
        // https is visible instead of mysterious.
        callbackOriginSource: target.configured !== '' ? 'configured' : 'request',
        httpLocalhostOnly: true,
        scopeCatalog: 'GET /client/v4/oauth/scopes',
        refreshCredentialRef: cloudflareRefreshRefName(config, undefined),
        ...(reasons.length === 0 ? {} : { reason: reasons[0] }),
      }
    },

    /**
     * CLOUDFLARE OAUTH — step 1: mint the authorize URL (PKCE S256).
     *
     * The verifier is random, single-use and lives ONLY in the state entry (in
     * memory, bounded, ten-minute TTL) — it never reaches the page. What the page
     * receives is the public authorize URL: client id, scopes, redirect URI, the
     * one-time state and the S256 challenge.
     *
     * A missing client id is refused BEFORE any state is minted, so a dead end
     * leaves nothing pending.
     *
     * @param input - `{ alias?, redirectUri? }`.
     * @returns `{ ok, provider, alias, credentialRef, authorizeUrl, state, redirectUri, scopes, pkce, expiresInSeconds }`.
     */
    async oauthCloudflareStart({ alias, redirectUri } = {}) {
      const clientId = cloudflareOAuthClientId()
      if (clientId === '') {
        throw configError('no cloudflareOAuthClientId is configured; register an OAuth client (Manage Account → OAuth clients) and enter its Client ID in the Login panel')
      }
      const scopes = cloudflareScopes()
      const { alias: target, ref } = targetOf('cloudflare', alias)
      const callbackTarget = cloudflareCallbackTarget(redirectUri)
      const callback = callbackTarget.redirectUri
      if (callback === '' || callbackTarget.origin === '') {
        throw configError('this host cannot tell which origin the page is on; reload the Connector page and press Login again')
      }
      // THE POLICY GATE, BEFORE ANY STATE IS MINTED. Cloudflare rejects an http
      // redirect whose host is not a `localhost` suffix with invalid_request, and
      // a login that cannot complete must not park a pending state/verifier. The
      // message is actionable: it names the HTTPS tab and the override setting.
      if (!isCloudflareRedirectOrigin(callbackTarget.origin)) {
        throw configError(CLOUDFLARE_INSECURE_ORIGIN_MESSAGE)
      }
      const pkce = createPkcePair()
      // The verifier rides WITH the state: one entry, one consumer, one deletion.
      // THE REDIRECT RIDES WITH IT TOO (fix: callback round-trip). The token
      // exchange must repeat the EXACT `redirect_uri` the authorize step sent,
      // and rebuilding it from the callback request's Host is precisely what
      // breaks behind a reverse proxy (the browser arrives on https, the host
      // sees http://127.0.0.1 — Cloudflare answers invalid_grant). Parking the
      // string that was actually sent makes the round-trip exact by construction,
      // whatever the proxy does to headers, and it is public data (it was in the
      // authorize URL).
      const state = oauthStates.issue({
        provider: 'cloudflare',
        alias: target,
        extra: { verifier: pkce.verifier, redirectUri: callback },
      })
      const authorizeUrl = buildCloudflareAuthorizeUrl({
        clientId,
        redirectUri: callback,
        state,
        challenge: pkce.challenge,
        scopes,
        origin: cloudflareOAuthOrigin(),
      })
      return {
        ok: true,
        provider: 'cloudflare',
        alias: target,
        credentialRef: ref,
        authorizeUrl,
        // Public facts only: the state is opaque, and the challenge is useless
        // without the verifier this host holds.
        challenge: pkce.challenge,
        pkce: pkce.method,
        state,
        redirectUri: callback,
        scopes,
        expiresInSeconds: 600,
      }
    },

    /**
     * CLOUDFLARE OAUTH — step 2: the callback (the browser lands here).
     *
     * The state is consumed FIRST, so a replay is refused even if everything after
     * it would have succeeded. The verifier comes out of that same consumed entry
     * and is used for exactly one token request; the access token is written to
     * the alias's reference, the refresh token (present when `offline_access` was
     * granted) to its own dedicated reference, and neither is ever returned.
     *
     * Failure is reported by KIND: an unknown/consumed/expired state, a provider
     * refusal, or an answer without a token. No branch echoes the code, the state,
     * the verifier, the access token or the refresh token.
     *
     * @param input - `{ code, state, redirectUri? }` from the query string.
     * @returns `{ ok, provider, alias, credentialRef, resolved, refreshStored }`.
     */
    async oauthCloudflareCallback({ code, state, redirectUri } = {}) {
      const entry = oauthStates.consume(state)
      if (entry === undefined) {
        const error = new Error('this login link is unknown, already used, or expired; start the login again')
        error.code = 'CONNECTOR_BAD_REQUEST'
        throw error
      }
      if (entry.provider !== 'cloudflare') {
        const error = new Error('this login link was issued for another provider')
        error.code = 'CONNECTOR_BAD_REQUEST'
        throw error
      }
      const verifier = typeof entry.extra?.verifier === 'string' ? entry.extra.verifier : ''
      if (verifier === '') {
        const error = new Error('this login link carries no PKCE verifier; start the login again')
        error.code = 'CONNECTOR_BAD_REQUEST'
        throw error
      }
      const authorizationCode = typeof code === 'string' ? code.trim() : ''
      if (authorizationCode === '') {
        const error = new Error('Cloudflare did not return an authorization code; start the login again')
        error.code = 'CONNECTOR_BAD_REQUEST'
        throw error
      }
      const clientId = cloudflareOAuthClientId()
      if (clientId === '') throw configError('no cloudflareOAuthClientId is configured; start the login again')
      // `targetOf` proves the alias still has a reference NAME to write.
      const { alias: target, ref } = targetOf('cloudflare', entry.alias)
      /**
       * THE REDIRECT THIS ATTEMPT USED — resolved in the SAME precedence as the
       * authorize step, and preferably read from the state entry where the start
       * parked the literal string it sent.
       *
       *   1. the parked value (exact by construction — the normal path);
       *   2. the configured `cloudflareCallbackOrigin` override, rebuilt onto the
       *      callback path (the user's own domain, whatever host this request
       *      arrived on);
       *   3. the callback URL of the request origin (the old behaviour).
       *
       * Steps 2 and 3 matter for a login that was started before an upgrade or by
       * a caller that never went through this host's start: without them a valid
       * code would be exchanged against a `redirect_uri` Cloudflare never saw.
       */
      const parked = typeof entry.extra?.redirectUri === 'string' && entry.extra.redirectUri !== ''
        ? entry.extra.redirectUri
        : ''
      const resolved = cloudflareCallbackTarget(redirectUri).redirectUri
      const callback = parked !== ''
        ? parked
        : (resolved !== '' ? resolved : cloudflareCallbackUrlOf(settings.guiOrigin ?? ''))
      if (callback === '') {
        const error = configError('this host cannot tell which origin the page is on; set cloudflareCallbackOrigin and start the login again')
        throw error
      }
      /**
       * The exchange is the ONE step that talks to the network, so its failure
       * modes are classified HERE rather than escaping as a bare `Error` (a
       * network failure would then have been reported as an untyped 500 by the
       * route layer). Every branch names the class and the public redirect, never
       * the code, the verifier or a token.
       */
      let exchanged
      try {
        exchanged = await exchangeCloudflareCode({
          clientId,
          code: authorizationCode,
          redirectUri: callback,
          codeVerifier: verifier,
          request,
          origin: cloudflareOAuthOrigin(),
        })
      } catch (error) {
        const failure = new Error(`the token exchange could not be completed (${redact(error?.message ?? 'network failure')})`)
        failure.code = 'CONNECTOR_PROVIDER_ERROR'
        failure.stage = 'exchange'
        failure.redirectUri = callback
        throw failure
      }
      if (exchanged.ok !== true) {
        // Status only: a provider body could quote the code or the verifier.
        const error = new Error(`Cloudflare refused the token exchange${exchanged.status === 0 ? '' : ` (${exchanged.status})`}`)
        error.code = 'CONNECTOR_PROVIDER_ERROR'
        error.stage = 'exchange'
        // The redirect is PUBLIC and is the one fact that turns this failure into
        // a fix ("this is the string Cloudflare compared — register it").
        error.redirectUri = callback
        throw error
      }
      await setSecret(ctx, ref, exchanged.accessToken)
      const refreshRef = cloudflareRefreshRefName(config, target)
      const refreshStored = typeof exchanged.refreshToken === 'string' && exchanged.refreshToken !== ''
      if (refreshStored) await setSecret(ctx, refreshRef, exchanged.refreshToken)
      const receipt = await referenceReceipt('cloudflare', ref)
      return {
        ...receipt,
        provider: 'cloudflare',
        alias: target,
        refreshStored,
        refreshCredentialRef: refreshRef,
        // The exact string this login sent, so the completion page can show it.
        redirectUri: callback,
        // The granted scope list is the provider's answer, not a request echo.
        ...(typeof exchanged.scope === 'string' && exchanged.scope !== '' ? { scope: exchanged.scope } : {}),
      }
    },

    /**
     * Whether this host offers the GitHub device flow: a public `client_id` is
     * configured AND the host mounted a writable credential store. Without
     * either, the panel shows the host's own reason instead of a dead button.
     *
     * `clientIdConfigured` and `canSaveClientId` exist so the page can lead with
     * the inline Client ID field instead of dead-ending on "no client id": the
     * value is public configuration, and it is editable from the panel that
     * needs it.
     */
    deviceFlow: () => {
      const clientId = deviceClientId()
      const credentials = ctx?.get?.('credentials') ?? ctx?.credentials
      const writable = typeof credentials?.set === 'function'
      const editor = ctx?.get?.('configEditor')
      const canSaveClientId = typeof editor?.edit === 'function' && ctx?.fiber?.entry !== undefined
      return {
        supported: clientId !== '' && writable,
        clientIdConfigured: clientId !== '',
        canSaveClientId,
        // The verification page this deployment uses. PUBLIC and stable, and it
        // is advertised so the page can open the tab synchronously inside the
        // click that starts the flow — a `window.open` after an `await` is what
        // browsers block. GitHub answers with the same URI on the start call,
        // and a GHE install answers with its own instance root.
        verificationUri: `${webOriginOf(config?.github?.apiBase)}/login/device`,
        // The client id is a public identifier, not a secret: it is embedded in
        // the verification URL the user opens.
        ...(clientId === '' ? {} : { clientId }),
        ...(writable ? {} : { reason: 'this host mounted no writable credential store' }),
        ...(clientId === '' ? { reason: 'no githubDeviceClientId is configured (set one in the plugin config to enable the device flow)' } : {}),
      }
    },

    /**
     * DEVICE FLOW, step 1 — start the login.
     *
     * `POST https://github.com/login/device/code` with the public client id. The
     * answer carries `device_code` (a bearer-equivalent secret) and `user_code`
     * (what the user types at the verification page). The device code NEVER leaves
     * this module: it is parked in {@link deviceFlows} behind an opaque flow id,
     * and the page only ever sees the flow id, the user code and the URL.
     */
    async deviceStart({ provider, alias } = {}) {
      const name = assertProvider(provider)
      if (name !== 'github') throw configError('the device flow is a GitHub login; Gitea and Cloudflare use authorization-code flows (Cloudflare with PKCE)')
      // A config write is a Loader-level event: `configEditor.edit` resolves the
      // new config, the row reloads, and THIS module instance is disposed. Two
      // things follow, and both are handled here:
      //   * a save still in flight leaves this instance's config empty, so the
      //     public id is read back from the profile patch instead of failing the
      //     click that came right after the save;
      //   * a flow started in that window is parked for the next instance (see
      //     `handedOffFlows`), because the flow map is disposed with the module.
      // The device code still never leaves the host in either case.
      const freshConfig = await ensureDeviceConfigFresh()
      const clientId = deviceClientId()
      if (clientId === '') throw configError('no githubDeviceClientId is configured; enter the OAuth App client id in the Login panel')
      const { alias: target, ref } = targetOf(name, alias)
      // `/login/device/code` is an OAUTH-WEB endpoint, not a REST one. The REST
      // base is wrong for it in both deployments: public GitHub serves it at
      // https://github.com while api.github.com answers with a doc page, and a
      // GitHub Enterprise install serves it at https://HOST (its REST lives under
      // /api/v3). `webOriginOf` is the one mapping already used for push remotes.
      const origin = webOriginOf(config?.github?.apiBase)
      const answer = await request(`${origin}/login/device/code`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId }).toString(),
      })
      const body = answer.json ?? {}
      if (!answer.ok) {
        const failure = new Error(`GitHub refused to start a device flow (${answer.status})`)
        failure.code = 'CONNECTOR_PROVIDER_ERROR'
        throw failure
      }
      const deviceCode = typeof body.device_code === 'string' ? body.device_code : ''
      if (deviceCode === '') throw new Error('GitHub answered a device-flow start without a device_code')
      const flowId = randomUUID()
      const intervalSeconds = Number.isFinite(Number(body.interval)) && Number(body.interval) > 0 ? Number(body.interval) : 5
      const expiresIn = Number.isFinite(Number(body.expires_in)) && Number(body.expires_in) > 0 ? Number(body.expires_in) : 900
      // RETRY-SAFE START. A page that retries a start (a double click, a reload
      // while the request was in flight, a row restart) must get the SAME success
      // shape — never an error about a flow that is already live. The old flow
      // for this provider is REPLACED here: its entry leaves the map, so its
      // device code can no longer be polled and cannot outlive the new one. That
      // keeps the map's expiry semantics exactly as before (an entry is dead the
      // moment it leaves the map or passes `expiresAt`), and it keeps at most one
      // live flow per provider+alias.
      pruneDeviceFlows()
      for (const [existingId, existing] of deviceFlows) {
        if (existing.provider === name && existing.alias === target) deviceFlows.delete(existingId)
      }
      const flow = {
        provider: name,
        alias: target,
        ref,
        clientId,
        deviceCode,
        intervalSeconds,
        expiresAt: Date.now() + expiresIn * 1000,
      }
      deviceFlows.set(flowId, flow)
      // Only a flow parked while the config was being saved needs the hand-off.
      if (freshConfig) handOff(flowId, flow)
      return {
        ok: true,
        flowId,
        provider: name,
        alias: target,
        credentialRef: ref,
        // Both are public: the user reads one out loud and opens the other.
        userCode: String(body.user_code ?? ''),
        verificationUri: String(body.verification_uri ?? 'https://github.com/login/device'),
        expiresIn,
        intervalSeconds,
      }
    },

    /**
     * DEVICE FLOW, step 2 — poll once.
     *
     * GitHub answers `authorization_pending` / `slow_down` until the user
     * approves, then `access_token`. The page polls this rather than the provider,
     * so the device code stays inside the host. On success the token goes straight
     * into the credential store and the receipt is the same non-secret one
     * {@link saveRef} returns.
     */
    async devicePoll({ flowId } = {}) {
      const id = String(flowId ?? '')
      // A flow started across a config write is adopted on its first poll (see
      // `handedOffFlows`): the contract of this operation is unchanged — an
      // unknown or expired id is still refused by name.
      const flow = deviceFlows.get(id) ?? adopt(id)
      if (flow === undefined) throw configError('unknown or expired device flow; start the login again')
      if (Date.now() > flow.expiresAt) {
        deviceFlows.delete(id)
        return { ok: false, status: 'expired', credentialRef: flow.ref, message: 'the device code expired; start the login again' }
      }
      const origin = webOriginOf(config?.github?.apiBase)
      const answer = await request(`${origin}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: flow.clientId, device_code: flow.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }).toString(),
      })
      const body = answer.json ?? {}
      const error = typeof body.error === 'string' ? body.error : ''
      if (error === 'authorization_pending') {
        return { ok: true, status: 'pending', credentialRef: flow.ref, intervalSeconds: flow.intervalSeconds }
      }
      if (error === 'slow_down') {
        // RFC 8628 §3.5: the client MUST raise its interval — by the server's
        // `interval` when one is given, otherwise by 5 seconds — and every later
        // poll must already use the new value. So the FLOW is updated, not just
        // the answer: a `slow_down` that only changed the reply would let the
        // page fall back to the old interval on the next tick.
        const asked = Number(body.interval)
        const next = Number.isFinite(asked) && asked > 0 ? asked : flow.intervalSeconds + 5
        flow.intervalSeconds = next
        return { ok: true, status: 'slow_down', credentialRef: flow.ref, intervalSeconds: next }
      }
      if (error === 'expired_token') {
        deviceFlows.delete(id)
        return { ok: false, status: 'expired', credentialRef: flow.ref, message: 'the device code expired; start the login again' }
      }
      if (error === 'access_denied') {
        deviceFlows.delete(id)
        return { ok: false, status: 'denied', credentialRef: flow.ref, message: 'the login was denied at GitHub' }
      }
      const token = typeof body.access_token === 'string' ? body.access_token : ''
      if (token === '') {
        deviceFlows.delete(id)
        const failure = new Error(`GitHub answered the token exchange without an access_token${error === '' ? '' : ` (${error})`}`)
        failure.code = 'CONNECTOR_PROVIDER_ERROR'
        throw failure
      }
      deviceFlows.delete(id)
      await setSecret(ctx, flow.ref, token)
      // GitHub hands back a refresh token when the OAuth App has "Expire user
      // access tokens" enabled (access 8 h / refresh 6 months). Store it under its
      // OWN reference so the 8-hour expiry becomes self-healing instead of a
      // 401 the user has to fix by hand.
      const refreshRef = githubRefreshRefName(config, flow.alias)
      const rotated = typeof body.refresh_token === 'string' ? body.refresh_token : ''
      if (rotated !== '') await setSecret(ctx, refreshRef, rotated)
      return {
        ...(await referenceReceipt(flow.provider, flow.ref)),
        status: 'authorized',
        alias: flow.alias,
        refreshStored: rotated !== '',
      }
    },

    /**
     * Prove an alias's reference resolves and works. The answer names the account
     * and scopes (neither is a secret); it never describes the credential itself.
     *
     * Cloudflare's branch is the REAL verify endpoint — `GET
     * /user/tokens/verify` with `Authorization: Bearer …` — because a pasted
     * token has no identity endpoint of its own and because that answer is what
     * proves the write the Login panel just made. A 401/403 reaches here as a
     * typed provider error (route: 424) whose message classifies the refusal and
     * never carries the token. Account scope is reported ONLY when the verify
     * answer itself exposes it; otherwise the detail says so in one clause rather
     * than spending a second request on a different fact.
     */
    async test({ provider, alias }) {
      const name = assertProvider(provider)
      return withSecret(name, alias, async (token, usedAlias, credentialRef) => {
        const built = adapters(usedAlias)
        let detail
        let extra
        if (name === 'github') {
          const me = await built.github.whoami(token)
          detail = `GitHub: OK — signed in as @${me.login}${me.scopes === '' ? '' : ` (scopes: ${me.scopes})`}`
        } else if (name === 'cloudflare') {
          // THE CHEAP SCOPED PROBE, not `/user/tokens/verify` (API-token only —
          // an OAuth access token gets 1000/10000 there, which is what produced a
          // misleading "Invalid API Token" on a working login).
          const probed = await built.cloudflare.probe(token)
          const identity = probed.identity
          const who = identity?.email !== undefined
            ? ` (${identity.email})`
            : (identity?.id !== undefined ? ` (user ${identity.id})` : '')
          detail = `Cloudflare: OK — verified: true, checked /${probed.passed}${who}`
          extra = { verified: true, check: probed.passed }
        } else {
          if (settings.gitea.baseUrl === '') throw configError('Gitea base URL is not configured; set it under Status → Gitea first')
          const me = await built.gitea.whoami(token)
          detail = `Gitea: OK — signed in as @${me.login}${me.version === '' ? '' : ` (server ${me.version})`}`
        }
        return { ok: true, provider: name, alias: usedAlias, credentialRef, detail, ...(extra ?? {}) }
      })
    },

    /**
     * CLOUDFLARE PLATFORM ACTIONS — zones, DNS, WAF, access rules, zone settings,
     * DDoS overrides and analytics, with an `action` discriminator.
     *
     * Same contract as `repoAction`: reads are unrestricted, writes are the
     * caller's approval business and are marked in the tool description. Every
     * call resolves the alias's OAuth token at call time and sends it as the
     * `Authorization: Bearer …` header for that request only.
     *
     * ERROR CLASSIFICATION (owner rule): a 401 is the token's own refusal and
     * gets ONE refresh + retry (in `withSecret`); a 403 is raised at the
     * endpoint's scope ("scope not granted on this OAuth token", typed
     * `CONNECTOR_PROVIDER_ERROR` → route 424); a 400 from the provider is
     * surfaced as a provider error too. Only a genuine CALLER mistake — a bad id,
     * an unknown phase, a wrong ttl, an unsupported action — is a `configError`
     * (route 400), and it is refused before any request is made.
     *
     * @param input - `{ action, alias?, zone?, account?, scope?, record_id?, … }`.
     * @returns the action's normalized answer.
     */
    async cloudflareAction(input = {}) {
      const action = String(input.action ?? '')
      if (!CLOUDFLARE_READ_ACTIONS.has(action) && !CLOUDFLARE_WRITE_ACTIONS.has(action)) {
        throw configError(`unknown Cloudflare action "${action}"; expected one of ${[...CLOUDFLARE_READ_ACTIONS, ...CLOUDFLARE_WRITE_ACTIONS].join(', ')}`)
      }
      return withSecret('cloudflare', input.alias, async (token, usedAlias) => {
        const cf = adapters(usedAlias).cloudflare
        const base = {
          ok: true,
          provider: 'cloudflare',
          alias: usedAlias,
          action,
          // PUBLIC configuration, not a credential: the scope ids this action's
          // 403 would name, so a caller can fix the OAuth client in one edit.
          requiredScopes: [...(CLOUDFLARE_ACTION_SCOPES[action] ?? [])],
        }

        switch (action) {
          case 'zones': {
            const items = await cf.listZones(token, { page: cfPage(input.page), perPage: cfPerPage(input.per_page, 100) })
            return { ...base, count: items.length, items }
          }

          case 'dns_records': {
            const zone = cfId(input.zone, 'zone')
            const items = await cf.listDnsRecords(token, zone, {
              type: cfDnsType(input.type),
              name: cfText(input.name, 'name', 253),
              page: cfPage(input.page),
              perPage: cfPerPage(input.per_page, 100),
            })
            return {
              ...base,
              zone,
              count: items.length,
              items,
              ttlSemantics: 'ttl 1 = automatic; otherwise 60-86400 seconds. proxied is valid only for A/AAAA/CNAME.',
            }
          }

          case 'waf_rules': {
            const zone = cfId(input.zone, 'zone')
            const phase = cfPhase(input.phase, { required: false })
            if (phase === '') {
              const items = await cf.listRulesets(token, zone)
              return { ...base, zone, count: items.length, items }
            }
            const ruleset = await cf.getPhaseEntrypoint(token, zone, phase)
            return { ...base, zone, phase, ruleset }
          }

          case 'access_rules': {
            const target = await resolveAccessRuleTarget(cf, token, input)
            const items = await cf.listAccessRules(token, target.account, {
              page: cfPage(input.page),
              perPage: cfPerPage(input.per_page, 100),
            })
            return {
              ...base,
              // `scope` is what was asked for; `route` is what was actually sent.
              scope: target.requestedScope,
              route: 'account',
              owner: target.account,
              ...(target.zone === '' ? {} : { zone: target.zone }),
              count: items.length,
              items,
              note: CLOUDFLARE_ACCESS_RULES_NOTE,
            }
          }

          case 'zone_settings': {
            const zone = cfId(input.zone, 'zone')
            const setting = cfText(input.setting_id, 'setting_id', 64)
            if (setting !== '') return { ...base, zone, setting: await cf.getZoneSetting(token, zone, setting) }
            const items = await cf.listZoneSettings(token, zone)
            return { ...base, zone, count: items.length, items }
          }

          case 'ddos_overrides': {
            const zone = cfId(input.zone, 'zone')
            try {
              const ruleset = await cf.getPhaseEntrypoint(token, zone, CF_DDOS_PHASE)
              return {
                ...base,
                zone,
                ruleset,
                defaultsActive: false,
                // Override-only: this entry point carries the L7 OVERRIDE rules. The
                // managed DDoS ruleset itself is not editable through it.
                semantics: 'ddos_l7 entry point holds OVERRIDE rules only; the managed ruleset is not editable from here.',
              }
            } catch (error) {
              // A 404 on ddos_l7 means "no overrides configured yet" — Cloudflare's
              // default state. It is NOT a failure, and it must not look like one.
              if (error?.status === 404) {
                return {
                  ...base,
                  zone,
                  ruleset: null,
                  defaultsActive: true,
                  count: 0,
                  rules: [],
                  note: 'ddos_l7: defaults active (no overrides configured)',
                  semantics: 'ddos_l7 entry point holds OVERRIDE rules only; the managed ruleset is not editable from here.',
                }
              }
              throw error
            }
          }

          case 'analytics': {
            const zone = cfId(input.zone, 'zone')
            const { query, variables } = buildCloudflareAnalyticsQuery({
              since: input.since,
              until: input.until,
              limit: input.limit ?? 10,
            })
            const data = await cf.graphql(token, query, { zoneTag: zone, ...variables })
            return { ...base, zone, query, data }
          }

          case 'security_events': {
            // The dashboard's Security Events view, via GraphQL. NO REST endpoint
            // exists for this (the old /security/events route was retired), so
            // there is no fallback to try.
            const zone = cfId(input.zone, 'zone')
            const { query, variables } = buildCloudflareSecurityEventsQuery({
              since: input.since,
              until: input.until,
              limit: input.limit ?? 100,
            })
            const data = await cf.graphql(token, query, { zoneTag: zone, ...variables })
            const events = data?.viewer?.zones?.[0]?.firewallEventsAdaptive ?? []
            return {
              ...base,
              zone,
              count: events.length,
              events,
              query,
              // Public: the ONE permission both analytics surfaces need, and the
              // consent sentence a "zone does not have access to the path" 403 gets.
              semantics: `Analytics Read (${CLOUDFLARE_SCOPE_IDS.analyticsRead}) gates both HTTP analytics and security events on the queried zone; the account-level variant is never requested.`,
            }
          }

          case 'botnet_feed': {
            const account = cfId(input.account, 'account')
            const asn = cfAsn(input.asn)
            const report = cfBotnetReport(input.report)
            const date = report === 'day_report' ? cfDate(input.date) : ''
            try {
              const feed = await cf.getBotnetFeed(token, account, asn, report, date)
              return {
                ...base,
                account,
                asn,
                report,
                ...(date === '' ? {} : { date }),
                supported: true,
                feed,
              }
            } catch (error) {
              // The feed is a plan surface: an account without it answers 403 (or
              // 404) and that is an explicit "no scope here", not a caller error.
              if (error?.status === 403 || error?.status === 404) {
                return {
                  ...base,
                  account,
                  asn,
                  report,
                  ...(date === '' ? {} : { date }),
                  supported: false,
                  reason: `botnet feed: no scope on this account/plan — ${CLOUDFLARE_SCOPE_IDS.botnetFeedRead} (ddos-botnet-feed.read) is not granted. Nothing was read.`,
                }
              }
              throw error
            }
          }

          case 'dns_record_create': {
            const zone = cfId(input.zone, 'zone')
            const type = cfDnsType(input.type, { required: true })
            const record = {
              type,
              name: cfText(input.name, 'name', 253, { required: true }),
              content: cfText(input.content, 'content', 2048, { required: true }),
              ...(cfTtl(input.ttl) === undefined ? {} : { ttl: cfTtl(input.ttl) }),
              ...(cfProxied(input.proxied, type) === undefined ? {} : { proxied: cfProxied(input.proxied, type) }),
              ...(input.priority === undefined ? {} : { priority: Number(input.priority) }),
              ...(cfText(input.comment, 'comment', 100) === '' ? {} : { comment: cfText(input.comment, 'comment', 100) }),
            }
            return { ...base, zone, changed: true, record: await cf.createDnsRecord(token, zone, record) }
          }

          case 'dns_record_patch': {
            const zone = cfId(input.zone, 'zone')
            const recordId = cfId(input.record_id, 'record_id')
            const type = cfDnsType(input.type)
            const patch = {
              ...(type === '' ? {} : { type }),
              ...(cfText(input.name, 'name', 253) === '' ? {} : { name: cfText(input.name, 'name', 253) }),
              ...(cfText(input.content, 'content', 2048) === '' ? {} : { content: cfText(input.content, 'content', 2048) }),
              ...(cfTtl(input.ttl) === undefined ? {} : { ttl: cfTtl(input.ttl) }),
              ...(cfProxied(input.proxied, type) === undefined ? {} : { proxied: cfProxied(input.proxied, type) }),
              ...(cfText(input.comment, 'comment', 100) === '' ? {} : { comment: cfText(input.comment, 'comment', 100) }),
            }
            if (Object.keys(patch).length === 0) throw configError('dns_record_patch needs at least one of type/name/content/ttl/proxied/comment')
            return { ...base, zone, changed: true, record: await cf.patchDnsRecord(token, zone, recordId, patch) }
          }

          case 'dns_record_delete': {
            const zone = cfId(input.zone, 'zone')
            const recordId = cfId(input.record_id, 'record_id')
            return { ...base, zone, changed: true, record: await cf.deleteDnsRecord(token, zone, recordId) }
          }

          case 'waf_rule_set': {
            const zone = cfId(input.zone, 'zone')
            const phase = cfPhase(input.phase)
            const rules = Array.isArray(input.rules) ? input.rules : []
            if (rules.length === 0) throw configError('waf_rule_set needs a rules array (an empty array clears the entry point)')
            if (rules.length > 1000) throw configError('waf_rule_set accepts at most 1000 rules in one call')
            if (rules.some(rule => rule === null || typeof rule !== 'object' || Array.isArray(rule))) {
              throw configError('every entry of rules must be an object')
            }
            const body = {
              ...(cfText(input.name, 'name', 100) === '' ? {} : { name: cfText(input.name, 'name', 100) }),
              ...(cfText(input.description, 'description', 500) === '' ? {} : { description: cfText(input.description, 'description', 500) }),
              rules,
            }
            const ruleset = await cf.putPhaseEntrypoint(token, zone, phase, body)
            return { ...base, zone, phase, changed: true, ruleset }
          }

          case 'waf_rule_add': {
            const zone = cfId(input.zone, 'zone')
            const rulesetId = cfId(input.ruleset_id, 'ruleset_id')
            const rule = input.rule
            if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
              throw configError('waf_rule_add needs a rule object (action, expression, optional description/enabled)')
            }
            // The add-rule endpoint takes ONE rule object, so the shape is checked
            // here instead of trusting an envelope: action and expression are the
            // two fields Cloudflare requires, and the optional ones keep their
            // documented types. `action_parameters` is passed through untouched.
            const allowed = new Set(['expression', 'action', 'action_parameters', 'description', 'enabled'])
            for (const key of Object.keys(rule)) {
              if (!allowed.has(key)) throw configError(`waf_rule_add: "${key}" is not a rule field (expression, action, action_parameters, description, enabled)`)
            }
            if (typeof rule.expression !== 'string' || rule.expression.trim() === '') throw configError('waf_rule_add: rule.expression is required')
            if (typeof rule.action !== 'string' || rule.action.trim() === '') throw configError('waf_rule_add: rule.action is required')
            if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') throw configError('waf_rule_add: rule.enabled must be true or false')
            return { ...base, zone, rulesetId, changed: true, rule: await cf.createRule(token, zone, rulesetId, rule) }
          }

          case 'waf_rule_patch': {
            const zone = cfId(input.zone, 'zone')
            const rulesetId = cfId(input.ruleset_id, 'ruleset_id')
            const ruleId = cfId(input.rule_id, 'rule_id')
            const sent = input.rule
            if (sent === null || typeof sent !== 'object' || Array.isArray(sent) || Object.keys(sent).length === 0) {
              throw configError('waf_rule_patch needs a rule object with the fields to change')
            }
            const allowed = new Set(['expression', 'action', 'action_parameters', 'description', 'enabled'])
            for (const key of Object.keys(sent)) {
              if (!allowed.has(key)) throw configError(`waf_rule_patch: "${key}" is not a patchable rule field (expression, action, action_parameters, description, enabled)`)
            }
            if (sent.enabled !== undefined && typeof sent.enabled !== 'boolean') {
              throw configError('waf_rule_patch: enabled must be true or false')
            }
            const patch = { ...sent }
            // PAUSE = `{enabled:false}` and NOTHING ELSE. The ruleset PATCH docs
            // require expression and action in the body, so the unchanged pair is
            // read from the live rule and replayed — no skip action, no ETag, and
            // the server bumps the ruleset version itself.
            if (patch.expression === undefined || patch.action === undefined) {
              const current = await cf.getRule(token, zone, rulesetId, ruleId)
              if (patch.expression === undefined) {
                if (typeof current.expression !== 'string' || current.expression === '') {
                  throw configError('waf_rule_patch cannot read the rule\'s current expression; pass expression and action explicitly')
                }
                patch.expression = current.expression
              }
              if (patch.action === undefined) {
                if (typeof current.action !== 'string' || current.action === '') {
                  throw configError('waf_rule_patch cannot read the rule\'s current action; pass action explicitly')
                }
                patch.action = current.action
              }
            }
            return {
              ...base,
              zone,
              rulesetId,
              changed: true,
              // A mutation bumps the ruleset version on Cloudflare's side; the rule
              // reply itself does not carry it, so the note states the fact.
              versionNote: 'each rule mutation bumps the ruleset version',
              rule: await cf.patchRule(token, zone, rulesetId, ruleId, patch),
            }
          }

          case 'waf_rule_delete': {
            const zone = cfId(input.zone, 'zone')
            const rulesetId = cfId(input.ruleset_id, 'ruleset_id')
            const ruleId = cfId(input.rule_id, 'rule_id')
            return { ...base, zone, rulesetId, changed: true, rule: await cf.deleteRule(token, zone, rulesetId, ruleId) }
          }

          case 'access_rule_create': {
            // Validate FIRST: a caller mistake must not cost a provider read.
            const body = cfAccessRuleBody(input)
            const target = await resolveAccessRuleTarget(cf, token, input)
            return {
              ...base,
              scope: target.requestedScope,
              route: 'account',
              owner: target.account,
              ...(target.zone === '' ? {} : { zone: target.zone }),
              changed: true,
              note: CLOUDFLARE_ACCESS_RULES_NOTE,
              rule: await cf.createAccessRule(token, target.account, body),
            }
          }

          case 'access_rule_patch': {
            // Validate FIRST, then resolve (a bad mode must not cost a read).
            const ruleId = cfId(input.rule_id, 'rule_id')
            const mode = cfText(input.mode, 'mode', 32, { required: true })
            if (!CF_ACCESS_MODES.has(mode)) throw configError(`mode must be one of ${[...CF_ACCESS_MODES].join(', ')}`)
            const notes = cfText(input.notes, 'notes', 512)
            const target = await resolveAccessRuleTarget(cf, token, input)
            return {
              ...base,
              scope: target.requestedScope,
              route: 'account',
              owner: target.account,
              ...(target.zone === '' ? {} : { zone: target.zone }),
              changed: true,
              note: CLOUDFLARE_ACCESS_RULES_NOTE,
              rule: await cf.patchAccessRule(token, target.account, ruleId, { mode, ...(notes === '' ? {} : { notes }) }),
            }
          }

          case 'access_rule_delete': {
            const target = await resolveAccessRuleTarget(cf, token, input)
            const ruleId = cfId(input.rule_id, 'rule_id')
            return {
              ...base,
              scope: target.requestedScope,
              route: 'account',
              owner: target.account,
              ...(target.zone === '' ? {} : { zone: target.zone }),
              changed: true,
              note: CLOUDFLARE_ACCESS_RULES_NOTE,
              rule: await cf.deleteAccessRule(token, target.account, ruleId),
            }
          }

          case 'ddos_override_set': {
            // CREATING THE FIRST OVERRIDE. Cloudflare's documented recipe is a PUT
            // of the phase entry point with ONE rule that executes the HTTP managed
            // ruleset by id and carries the overrides object:
            //
            //   PUT /zones/{z}/rulesets/phases/ddos_l7/entrypoint
            //   { rules: [{ action:'execute', expression:'true',
            //               action_parameters: { id:'<HTTP_MANAGED_RULESET_ID>',
            //                                    overrides: { … } } }] }
            //
            // `httpManagedRulesetId` is required (32 hex): it names WHICH managed
            // ruleset the override targets, and guessing it is not acceptable.
            const zone = cfId(input.zone, 'zone')
            const httpManagedRulesetId = cfId(input.httpManagedRulesetId, 'httpManagedRulesetId')
            const overrides = cfOverrides(input.overrides)
            const body = {
              rules: [{
                action: 'execute',
                expression: 'true',
                action_parameters: { id: httpManagedRulesetId, overrides },
              }],
            }
            const ruleset = await cf.putPhaseEntrypoint(token, zone, CF_DDOS_PHASE, body)
            return {
              ...base,
              zone,
              httpManagedRulesetId,
              changed: true,
              ruleset,
              note: 'ddos_l7: override written (PUT replaces the entry point; the managed defaults stay active where no override applies)',
            }
          }

          case 'zone_setting_edit': {
            const zone = cfId(input.zone, 'zone')
            const settingId = cfText(input.setting_id, 'setting_id', 64, { required: true })
            if (!/^[a-z][a-z0-9_]{1,63}$/u.test(settingId)) throw configError('setting_id must be a lowercase setting name such as security_level')
            if (input.setting_value === undefined) throw configError('zone_setting_edit needs a setting_value')
            const value = input.setting_value
            if (typeof value === 'object' && value !== null) throw configError('zone_setting_edit value must be a string, number or boolean')
            return { ...base, zone, changed: true, setting: await cf.patchZoneSetting(token, zone, settingId, value) }
          }

          default:
            // Unreachable: the set check above refuses anything else by name.
            throw configError(`unknown Cloudflare action "${action}"`)
        }
      })
    },

    /** Repositories for one provider, normalized across all three. */
    async repos({ provider, alias } = {}) {
      const name = assertProvider(provider)
      return withSecret(name, alias, async (token, usedAlias) => {
        const built = adapters(usedAlias)
        let items
        if (name === 'github') items = await built.github.listRepos(token)
        else if (name === 'gitea') {
          if (settings.gitea.baseUrl === '') throw configError('Gitea base URL is not configured; set it under Status → Gitea first')
          items = await built.gitea.listRepos(token)
        } else {
          // Cloudflare has projects, not repositories; the tab shows Pages projects.
          const accounts = await built.cloudflare.listAccounts(token)
          const projects = []
          for (const account of accounts.slice(0, 5)) {
            for (const project of await built.cloudflare.listPagesProjects(token, account.id)) {
              projects.push({
                provider: 'cloudflare', fullName: `${account.name}/${project.name}`, owner: account.id,
                name: project.name, private: true, defaultBranch: project.productionBranch, url: project.subdomain,
              })
            }
          }
          items = projects
        }
        return { ok: true, provider: name, alias: usedAlias, count: items.length, items }
      })
    },

    /**
     * Repository FILE verbs: `read_tree | read_file` (reads) and `put_file` (a
     * write that commits). Split from {@link repoAction} because a file body is a
     * different shape — and because `put_file` is the one verb here that mutates
     * content rather than metadata.
     */
    async fileAction(input = {}) {
      const name = assertProvider(input.provider)
      const action = String(input.action ?? '')
      if (!FILE_READ_ACTIONS.has(action) && !FILE_WRITE_ACTIONS.has(action)) {
        throw new TypeError(`action must be one of ${[...FILE_READ_ACTIONS, ...FILE_WRITE_ACTIONS].join(', ')}`)
      }
      if (name === 'cloudflare') {
        throw new TypeError(`Cloudflare stores Pages projects rather than repositories; "${action}" is a GitHub/Gitea verb with no Cloudflare equivalent`)
      }
      return withSecret(name, input.alias, async (token, usedAlias) => {
        const built = adapters(usedAlias)
        assertGiteaReady(name)
        const owner = repoPart(input.owner, 'owner')
        const repo = repoPart(input.repo, 'repo')
        const api = built[name]
        const branch = input.ref === undefined || input.ref === '' ? '' : refName(input.ref, 'ref')

        switch (action) {
          case 'read_tree': {
            const path = input.path === undefined || input.path === '' ? '' : repoPathIn(input.path)
            const meta = {}
            const tree = await api.readTree(token, owner, repo, branch, path, meta)
            const items = (tree.items ?? []).slice(0, 5000)
            return {
              ok: true, provider: name, alias: usedAlias, action, owner, repo,
              ref: branch === '' ? '(default branch)' : branch,
              path: path === '' ? '/' : path,
              supported: tree.supported !== false,
              ...(tree.reason === undefined ? {} : { reason: tree.reason }),
              count: items.length,
              // GitHub's own truncation verdict, passed through untouched.
              truncated: tree.truncated === true,
              ...(tree.public === true ? { public: true } : {}),
              items,
            }
          }
          case 'read_file': {
            const path = repoPathIn(input.path)
            const meta = {}
            const file = await api.readFile(token, owner, repo, path, branch, meta)
            const utf8 = decodeTextBase64(file.contentBase64)
            return {
              ok: true, provider: name, alias: usedAlias, action, owner, repo, path,
              ref: branch === '' ? '(default branch)' : branch,
              sha: file.sha,
              size: file.size,
              encoding: file.encoding ?? 'base64',
              contentBase64: file.contentBase64,
              ...(utf8 === undefined ? {} : { utf8: clamp(utf8, outputLimit) }),
              ...(utf8 === undefined ? { binary: true } : {}),
              truncated: file.truncated === true,
              ...(file.public === true ? { public: true } : {}),
            }
          }
          case 'put_file': {
            const path = repoPathIn(input.path)
            const content = typeof input.content === 'string' ? input.content : String(input.content ?? '')
            if (content === '') throw new TypeError('content must not be empty (pass the whole file text to write)')
            const bytes = Buffer.byteLength(content, 'utf8')
            if (bytes > MAX_FILE_BYTES) throw new TypeError(`content is ${bytes} bytes; this tool writes at most ${MAX_FILE_BYTES} bytes per commit`)
            const message = String(input.message ?? '').trim()
            if (message === '') throw new TypeError('message (the commit message) must not be empty')
            const target = String(input.branch ?? '').trim()
            if (target === '') throw new TypeError('branch is required: a commit needs a branch to land on')
            const written = await api.putFile(token, owner, repo, {
              path, content, message, branch: refName(target, 'branch'),
              sha: input.sha === undefined || input.sha === '' ? undefined : String(input.sha),
            })
            return {
              ok: true, provider: name, alias: usedAlias, action, owner, repo,
              path: written.path ?? path, branch: target, bytes,
              commit: written.commit, contentSha: written.contentSha,
            }
          }
          default:
            throw new TypeError(`unsupported action ${action}`)
        }
      })
    },

    /**
     * The shared repo verb surface: the reads and writes in
     * {@link READ_ACTIONS} / {@link WRITE_ACTIONS}. Everything that reaches the
     * remote goes through here, so a new verb cannot appear on one surface
     * (route or tool) and be missing from the other.
     */
    async repoAction(input = {}) {
      const name = assertProvider(input.provider)
      const action = String(input.action ?? '')
      if (!READ_ACTIONS.has(action) && !WRITE_ACTIONS.has(action)) {
        throw new TypeError(`action must be one of ${[...READ_ACTIONS, ...WRITE_ACTIONS].join(', ')}`)
      }
      // The provider/verb assert lives ABOVE withSecret, exactly as fileAction
      // does it: a verb Cloudflare does not have is a caller error about the
      // VERB, not a missing credential. Checking it after resolution masked the
      // real message behind CONNECTOR_NO_TOKEN whenever no Cloudflare credential
      // happened to exist.
      assertProviderVerb(name, action)
      return withSecret(name, input.alias, async (token, usedAlias, credentialRef) => {
        const built = adapters(usedAlias)
        const owner = repoPart(input.owner, 'owner')
        const repo = repoPart(input.repo, 'repo')
        assertGiteaReady(name)
        const api = built[name]
        const receipt = { ok: true, provider: name, alias: usedAlias, action, owner, repo }

        switch (action) {
          case 'prs': {
            const meta = {}
            const items = await api.listPulls(token, owner, repo, input.state ?? 'open', meta)
            return { ...receipt, count: items.length, items, ...(meta.public === true ? { public: true } : {}) }
          }
          case 'issues': {
            const meta = {}
            const items = await api.listIssues(token, owner, repo, input.state ?? 'open', meta)
            return { ...receipt, count: items.length, items, ...(meta.public === true ? { public: true } : {}) }
          }
          case 'branches': {
            const meta = {}
            const items = await api.listBranches(token, owner, repo, meta)
            return { ...receipt, count: items.length, items, ...(meta.public === true ? { public: true } : {}) }
          }
          case 'actions_logs': {
            if (input.runId === undefined || input.runId === '') {
              if (name === 'cloudflare') {
                const deployments = await api.listDeployments(token, repoPart(input.owner, 'account'), repo)
                return { ...receipt, items: deployments, count: deployments.length }
              }
              const meta = {}
              const listed = await api.listRuns(token, owner, repo, meta)
              return {
                ...receipt,
                supported: listed.supported, reason: listed.reason, count: listed.runs.length, items: listed.runs,
                ...(meta.public === true ? { public: true } : {}),
              }
            }
            const runId = numericId(input.runId, 'runId')
            if (name === 'cloudflare') {
              const deployments = await api.listDeployments(token, repoPart(input.owner, 'account'), repo)
              return { ...receipt, items: deployments, count: deployments.length }
            }
            const log = await api.runLog(token, owner, repo, runId)
            if (log.supported === false) {
              return { ...receipt, supported: false, reason: log.reason, text: '' }
            }
            return {
              ...receipt, supported: true,
              text: clamp(log.text, outputLimit), truncated: log.text.length > outputLimit,
            }
          }
          case 'commits': {
            const path = input.path === undefined || input.path === '' ? '' : repoPathIn(input.path)
            const branch = input.ref === undefined || input.ref === '' ? '' : refName(input.ref, 'ref')
            const limit = Math.min(Math.max(Number.parseInt(String(input.limit ?? 20), 10) || 20, 1), 100)
            const meta = {}
            const items = await api.commits(token, owner, repo, { path, ref: branch, limit }, meta)
            return {
              ...receipt, path: path === '' ? undefined : path, ref: branch === '' ? undefined : branch,
              count: items.length, items, ...(meta.public === true ? { public: true } : {}),
            }
          }
          case 'blame': {
            const path = repoPathIn(input.path)
            const branch = input.ref === undefined || input.ref === '' ? '' : refName(input.ref, 'ref')
            const blamed = await api.blame(token, owner, repo, path, branch)
            if (blamed.supported === false) return { ...receipt, path, supported: false, reason: blamed.reason, count: 0, items: [] }
            return { ...receipt, path, supported: true, count: blamed.items.length, items: blamed.items }
          }
          case 'pr_files': {
            const number = numericId(input.number, 'number')
            const meta = {}
            const items = await api.pullFiles(token, owner, repo, number, meta)
            return { ...receipt, number, count: items.length, items, ...(meta.public === true ? { public: true } : {}) }
          }
          case 'pr_diff': {
            const number = numericId(input.number, 'number')
            const meta = {}
            const diff = await api.pullDiff(token, owner, repo, number, meta)
            if (diff.supported === false) return { ...receipt, number, supported: false, reason: diff.reason, text: '' }
            return {
              ...receipt, number, supported: true,
              text: clamp(diff.text, outputLimit),
              truncated: diff.text.length > outputLimit,
              ...(meta.public === true ? { public: true } : {}),
            }
          }
          case 'run_dispatch': {
            const workflow = String(input.workflow ?? '').trim()
            if (!WORKFLOW_PATTERN.test(workflow)) throw new TypeError('workflow must be a workflow file name or id (letters, digits, dot, dash, underscore)')
            const ref = refName(input.ref, 'ref')
            let inputs
            if (input.inputs !== undefined && input.inputs !== null) {
              if (typeof input.inputs !== 'object' || Array.isArray(input.inputs)) throw new TypeError('inputs must be an object of string values')
              inputs = Object.fromEntries(Object.entries(input.inputs).map(([key, value]) => [String(key), String(value)]))
            }
            const dispatched = await api.runDispatch(token, owner, repo, workflow, ref, inputs)
            return { ...receipt, ...dispatched, workflow, ref }
          }
          case 'run_cancel': {
            const runId = numericId(input.runId, 'runId')
            const answer = await api.runCancel(token, owner, repo, runId)
            return { ...receipt, ...answer, runId }
          }
          case 'run_rerun': {
            const runId = numericId(input.runId, 'runId')
            const answer = await api.runRerun(token, owner, repo, runId)
            return { ...receipt, ...answer, runId }
          }
          case 'delete_run': {
            const runId = numericId(input.runId, 'runId')
            const answer = await api.deleteRun(token, owner, repo, runId)
            return { ...receipt, ...answer, runId }
          }
          case 'delete_branch': {
            const branch = refName(input.branch, 'branch')
            const answer = await api.deleteBranch(token, owner, repo, branch)
            return { ...receipt, ...answer, branch }
          }
          case 'create_tag': {
            const tag = refName(input.tag, 'tag')
            const sha = String(input.sha ?? '').trim()
            if (sha === '') throw new TypeError('sha is required: a tag needs a commit to point at')
            const message = input.message === undefined ? undefined : String(input.message)
            const answer = await api.createTag(token, owner, repo, tag, sha, message)
            return { ...receipt, ...answer, tag }
          }
          case 'set_labels': {
            const number = numericId(input.number, 'number')
            const labels = stringList(input.labels, 'labels', /^[^\u0000-\u001f]{1,100}$/u)
            const answer = await api.setLabels(token, owner, repo, number, labels)
            return { ...receipt, ...answer, number }
          }
          case 'add_assignees': {
            const number = numericId(input.number, 'number')
            const assignees = stringList(input.assignees, 'assignees', LOGIN_PATTERN, 20)
            if (assignees.length === 0) throw new TypeError('assignees must name at least one login')
            const answer = await api.addAssignees(token, owner, repo, number, assignees)
            return { ...receipt, ...answer, number }
          }
          case 'issue_create': {
            const title = String(input.title ?? '').trim()
            if (title === '') throw new TypeError('title must not be empty')
            const body = input.body === undefined ? undefined : String(input.body).slice(0, 60000)
            const labels = stringList(input.labels, 'labels', /^[^\u0000-\u001f]{1,100}$/u)
            const answer = await api.createIssue(token, owner, repo, { title, body, labels })
            return { ...receipt, ...answer }
          }
          case 'issue_state': {
            const number = numericId(input.number, 'number')
            const state = String(input.state ?? '')
            if (state !== 'open' && state !== 'closed') throw new TypeError('state must be "open" or "closed"')
            // Both adapters express this as the same PATCH /issues/{n}; the
            // separate verb exists so the intent is not confused with a title
            // or body edit.
            const answer = await api.issueState(token, owner, repo, number, state)
            return { ...receipt, ...answer, number, state }
          }
          case 'pr_create': {
            const head = refName(input.head, 'head')
            const base = refName(input.base, 'base')
            const title = String(input.title ?? '').trim()
            if (title === '') throw new TypeError('title must not be empty')
            if (head === base) throw new TypeError('head and base must be different branches')
            const body = input.body === undefined ? undefined : String(input.body).slice(0, 60000)
            const answer = await api.createPull(token, owner, repo, { head, base, title, body })
            return { ...receipt, ...answer }
          }
          case 'pr_merge': {
            const number = numericId(input.number, 'number')
            const method = String(input.method ?? 'merge')
            if (!['merge', 'squash', 'rebase'].includes(method)) throw new TypeError('method must be merge, squash or rebase')
            const answer = await api.mergePull(token, owner, repo, number, {
              method,
              commitTitle: input.commitTitle === undefined ? undefined : String(input.commitTitle),
              commitMessage: input.commitMessage === undefined ? undefined : String(input.commitMessage),
            })
            return { ...receipt, ...answer, number, method }
          }
          case 'comment':
          case 'pull_comment': {
            const number = numericId(input.number, 'number')
            const body = String(input.body ?? '').slice(0, 60000)
            if (body.trim() === '') throw new TypeError('body must not be empty')
            const written = action === 'comment'
              ? await api.comment(token, owner, repo, number, body)
              : await api.pullComment(token, owner, repo, number, body)
            return { ...receipt, ...written }
          }
          case 'edit_issue': {
            const number = numericId(input.number, 'number')
            const patch = {}
            if (typeof input.title === 'string' && input.title !== '') patch.title = input.title
            if (typeof input.body === 'string') patch.body = input.body
            if (typeof input.state === 'string' && ['open', 'closed'].includes(input.state)) patch.state = input.state
            if (Array.isArray(input.labels)) patch.labels = input.labels.map(String)
            if (Object.keys(patch).length === 0) throw new TypeError('edit_issue needs at least one of title/body/state/labels')
            const written = await api.editIssue(token, owner, repo, number, patch)
            return { ...receipt, ...written }
          }
          case 'create_branch': {
            const branch = refName(input.branch, 'branch')
            const from = input.from === undefined || input.from === '' ? '' : refName(input.from, 'from')
            const written = await api.createBranch(token, owner, repo, { branch, from })
            // `from` echoes what the ADAPTER resolved (the default branch when the
            // caller named none), not the empty string the caller sent.
            return { ...receipt, ...written, branch: written.branch ?? branch }
          }
          default:
            throw new TypeError(`unsupported action ${action}`)
        }
      })
    },

    /**
     * Push a workspace project — dry run first, by contract.
     *
     * SECURITY (SOL §5, §8.5): the token is never in the remote URL, never in
     * argv, and never in `.git/config`. It goes into a 0600 file inside a 0700
     * temp dir; a generated 0700 askpass script `cat`s that file, so git reads the
     * secret through its own askpass protocol. Credential helpers are disabled
     * (`-c credential.helper=`) so nothing can persist it either. The temp dir is
     * removed in `finally`, and stderr/stdout are redacted before returning.
     */
    async push(input = {}) {
      const name = assertProvider(input.provider ?? 'github')
      const dryRun = input.dryRun !== false
      const projectPath = resolveInWorkspace(workspaceRoot, input.path)
      const info = await stat(projectPath)
      if (!info.isDirectory()) throw configError('the project path must be a directory')

      const inside = await run('git', ['-C', projectPath, 'rev-parse', '--is-inside-work-tree'], { cwd: projectPath })
      if (inside.code !== 0) throw configError('the project path is not a git working tree (run `git init` there first)')

      const branchRun = await run('git', ['-C', projectPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath })
      const branch = branchRun.stdout.trim() === '' ? 'HEAD' : branchRun.stdout.trim()
      const statusRun = await run('git', ['-C', projectPath, 'status', '--porcelain'], { cwd: projectPath })
      const dirty = statusRun.stdout.split('\n').filter(line => line.trim() !== '')
      const headRun = await run('git', ['-C', projectPath, 'rev-parse', '--short', 'HEAD'], { cwd: projectPath })
      const head = headRun.stdout.trim()

      const plan = {
        provider: name,
        path: projectPath,
        branch,
        head,
        dirtyFiles: dirty.length,
        dirtySample: dirty.slice(0, 10),
        dryRun,
      }

      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          ...plan,
          summary: `${projectPath} → ${branch} (${head === '' ? 'no commits' : head}); ${dirty.length} uncommitted file${dirty.length === 1 ? '' : 's'} would NOT be pushed — commit first. Nothing was sent anywhere.`,
        }
      }
      if (dirty.length > 0) {
        throw configError(`the working tree has ${dirty.length} uncommitted change(s); commit them before pushing (the push sends commits, not the working tree)`)
      }

      const owner = repoPart(input.owner, 'owner')
      const repo = repoPart(input.repo, 'repo')
      const ref = input.ref === undefined ? branch : String(input.ref)
      if (!REF_PATTERN.test(ref)) throw new TypeError('ref is not a valid ref name')

      return withSecret(name, input.alias, async (token, usedAlias) => {
        const built = adapters(usedAlias)
        let remoteUrl
        let created = false
        if (name === 'cloudflare') {
          const deployed = await built.cloudflare.deployWrangler(token, projectPath, false)
          return {
            ok: deployed.code === 0,
            dryRun: false,
            provider: name,
            alias: usedAlias,
            path: projectPath,
            exit: deployed.code,
            summary: deployed.code === 0 ? 'wrangler deploy finished' : 'wrangler deploy failed (see output)',
            output: clamp(redact(`${deployed.stdout}\n${deployed.stderr}`, token), outputLimit),
          }
        }
        if (name === 'gitea') {
          const root = settings.gitea.baseUrl
          if (root === '') throw configError('Gitea base URL is not configured; set it under Status → Gitea first')
          const origin = root.replace(/\/api\/v1$/u, '')
          const exists = await built.gitea.repoInfo(token, owner, repo)
          if (exists.exists !== true) {
            await built.gitea.createRepo(token, repo, { private: input.private !== false })
            created = true
          }
          remoteUrl = `${origin}/${owner}/${repo}.git`
        } else {
          const exists = await built.github.repoInfo(token, owner, repo)
          // The clone URL comes from the ADAPTER's origin, never from
          // `github.com` and never from an API response field: `apiBase` may be a
          // GitHub Enterprise install (`https://ghe.example.com/api/v3`), whose
          // REST host is not its git host and which cannot be reached at all on
          // the public site.
          if (exists.exists !== true) {
            const made = await built.github.createRepo(token, repo, { private: input.private !== false })
            created = made.created === true
            remoteUrl = made.cloneUrl ?? `${built.github.webOrigin}/${owner}/${repo}.git`
          } else {
            remoteUrl = exists.cloneUrl ?? `${built.github.webOrigin}/${owner}/${repo}.git`
          }
        }

        const dir = await mkdtemp(join(tmpdir(), 'connector-push-'))
        const secretFile = join(dir, 'secret')
        const askpassFile = join(dir, 'askpass.sh')
        try {
          await writeFile(secretFile, token, { mode: 0o600 })
          await writeFile(askpassFile, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "x-access-token" ;;\n  *) cat "$(dirname "$0")/secret" ;;\nesac\n', { mode: 0o700 })
          const args = [
            '-C', projectPath,
            '-c', 'credential.helper=',
            '-c', `core.askPass=${askpassFile}`,
            '-c', 'push.default=current',
          ]
          if (name === 'gitea' && settings.gitea.allowSelfSigned === true) args.push('-c', 'http.sslVerify=false')
          args.push('push', remoteUrl, `HEAD:refs/heads/${ref}`)
          const pushed = await run('git', args, {
            cwd: projectPath,
            env: { GIT_ASKPASS: askpassFile, GIT_ASKPASS_REQUIRE: 'force' },
            timeoutMs: 300000,
          })
          // The token cannot appear in this text — but the URL could, and a
          // future git version might echo an askpass answer, so redact anyway.
          const output = clamp(redact(`${pushed.stdout}${pushed.stderr === '' ? '' : `\n${pushed.stderr}`}`, token), outputLimit)
          return {
            ok: pushed.code === 0,
            dryRun: false,
            provider: name,
            alias: usedAlias,
            path: projectPath,
            branch,
            ref,
            repo: `${owner}/${repo}`,
            createdRepository: created,
            exit: pushed.code,
            summary: pushed.code === 0
              ? `Pushed ${branch} → ${owner}/${repo}:${ref}${created ? ' (repository created)' : ''}`
              : `git push failed with exit ${pushed.code}`,
            output,
          }
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {})
        }
      })
    },

    /**
     * Persist non-secret settings (Gitea base URL, default alias, the PUBLIC
     * GitHub device-flow client id) through `configEditor`, which owns the
     * profile patch. No token can reach this path: the accepted fields are
     * listed explicitly, and the client id is a public identifier — the device
     * flow uses no client secret, and the id is printed in the verification URL.
     */
    async saveSettings(input = {}) {
      const next = {}
      if (input.giteaUrl !== undefined) {
        const normalized = normalizeBaseUrl(input.giteaUrl)
        next.gitea = { apiBase: normalized === '' ? '' : normalized.replace(/\/api\/v1$/u, '') }
      }
      if (input.allowSelfSigned !== undefined) {
        next.gitea = { ...(next.gitea ?? {}), allowSelfSigned: input.allowSelfSigned === true }
      }
      // The IN-PANEL Client ID. Accepting it here is what turns the Login panel
      // from a dead end into a one-line setup: paste the public client id, save,
      // and the primary action becomes "Start device flow" without a restart.
      let nextClientId
      if (input.githubDeviceClientId !== undefined) {
        nextClientId = normalizeClientId(input.githubDeviceClientId)
        next.githubDeviceClientId = nextClientId
      }
      // The Gitea OAuth2 application's PUBLIC client id: same rule as GitHub's,
      // and it is what makes "Login" a one-click authorize from now on.
      let nextGiteaClientId
      if (input.giteaOAuthClientId !== undefined) {
        nextGiteaClientId = normalizeClientId(input.giteaOAuthClientId)
        next.giteaOAuthClientId = nextGiteaClientId
      }
      // The Cloudflare OAuth client's PUBLIC id and its scope list. Neither is a
      // secret: the id travels in the authorize URL, the scopes travel with it, and
      // a PKCE client has no secret at all. They are edited from the Login panel
      // (the pencil) and land in the profile patch like the other public values.
      let nextCloudflareClientId
      if (input.cloudflareOAuthClientId !== undefined) {
        nextCloudflareClientId = normalizeClientId(input.cloudflareOAuthClientId)
        next.cloudflareOAuthClientId = nextCloudflareClientId
      }
      // The non-secret ORIGIN OVERRIDE. Validated here, so a save can never
      // configure a login Cloudflare will refuse at the authorize step.
      let nextCloudflareCallbackOrigin
      if (input.cloudflareCallbackOrigin !== undefined) {
        nextCloudflareCallbackOrigin = normalizeCloudflareCallbackOrigin(input.cloudflareCallbackOrigin)
        next.cloudflareCallbackOrigin = nextCloudflareCallbackOrigin
      }
      let nextCloudflareScopes
      if (input.cloudflareOAuthScopes !== undefined) {
        // Validate by round-tripping through the same parser the start uses, so a
        // typo is refused HERE rather than on the consent screen.
        const previous = config?.cloudflareOAuthScopes
        config.cloudflareOAuthScopes = typeof input.cloudflareOAuthScopes === 'string' ? input.cloudflareOAuthScopes : ''
        try {
          nextCloudflareScopes = cloudflareScopes().join(' ')
        } finally {
          config.cloudflareOAuthScopes = previous
        }
      }
      if (Object.keys(next).length === 0) throw new TypeError('nothing to save')
      const editor = ctx?.get?.('configEditor')
      const entry = ctx?.fiber?.entry
      if (editor === undefined || entry === undefined) {
        throw configError('settings can only be saved from the running host profile')
      }
      await editor.edit(entry, (current) => ({
        ...current,
        ...(next.gitea === undefined ? {} : { gitea: { ...(current.gitea ?? {}), ...next.gitea } }),
        ...(nextClientId === undefined ? {} : { githubDeviceClientId: nextClientId }),
        ...(nextGiteaClientId === undefined ? {} : { giteaOAuthClientId: nextGiteaClientId }),
        ...(nextCloudflareClientId === undefined ? {} : { cloudflareOAuthClientId: nextCloudflareClientId }),
        ...(nextCloudflareScopes === undefined ? {} : { cloudflareOAuthScopes: nextCloudflareScopes }),
        ...(nextCloudflareCallbackOrigin === undefined ? {} : { cloudflareCallbackOrigin: nextCloudflareCallbackOrigin }),
      }))
      if (next.gitea?.apiBase !== undefined) settings.gitea.baseUrl = normalizeBaseUrl(next.gitea.apiBase)
      if (next.gitea?.allowSelfSigned !== undefined) settings.gitea.allowSelfSigned = next.gitea.allowSelfSigned === true
      // The live config object is what every later call reads (`deviceClientId`,
      // the adapters), so the public id has to land there too — otherwise the
      // panel would have to wait for a restart for its own save to take effect.
      if (nextClientId !== undefined && config !== null && typeof config === 'object') {
        config.githubDeviceClientId = nextClientId
      }
      if (nextGiteaClientId !== undefined && config !== null && typeof config === 'object') {
        config.giteaOAuthClientId = nextGiteaClientId
      }
      if (nextCloudflareClientId !== undefined && config !== null && typeof config === 'object') {
        config.cloudflareOAuthClientId = nextCloudflareClientId
      }
      if (nextCloudflareScopes !== undefined && config !== null && typeof config === 'object') {
        config.cloudflareOAuthScopes = nextCloudflareScopes
      }
      if (nextCloudflareCallbackOrigin !== undefined && config !== null && typeof config === 'object') {
        config.cloudflareCallbackOrigin = nextCloudflareCallbackOrigin
      }
      // Capabilities belong to one origin; a new origin must be re-probed.
      giteaVersion.at = 0
      giteaVersion.routes = undefined
      return {
        ok: true,
        settings: operations.settings(),
        device: operations.deviceFlow(),
        oauth: operations.oauthFlow(),
        oauthCloudflare: operations.cloudflareOAuthFlow(),
      }
    },

    /** Filesystem sanity used by the page: does this project path look pushable? */
    async inspectPath(input = {}) {
      const projectPath = resolveInWorkspace(workspaceRoot, input.path)
      const entries = await readdir(projectPath, { withFileTypes: true })
      const inside = await run('git', ['-C', projectPath, 'rev-parse', '--is-inside-work-tree'], { cwd: projectPath })
      return {
        ok: true,
        path: projectPath,
        isGit: inside.code === 0,
        entries: entries.slice(0, 30).map(entry => entry.name),
      }
    },
  }

  // A logger here would be tempting; the rule is kind-only diagnostics, so the
  // only thing ever emitted is the operation name.
  if (logger !== undefined) logger.debug?.('connector: operations ready')
  return operations
}

export {
  READ_ACTIONS, WRITE_ACTIONS, FILE_READ_ACTIONS, FILE_WRITE_ACTIONS,
  CLOUDFLARE_READ_ACTIONS, CLOUDFLARE_WRITE_ACTIONS,
}
