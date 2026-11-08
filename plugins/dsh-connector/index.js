/**
 * dsh-connector — HOST half.
 *
 * WHAT THIS ROW IS
 * ----------------
 * One switchable bundle row that
 *   * registers six `connector_*` agent tools,
 *   * registers the `/api/connector` Host routes the Connector page calls,
 *   * registers the `tool:connector` system-prompt section,
 * and, through `./client`, the sidebar entry (order 21 — directly below
 * Personal VM (CUA) at 20) and its keyed `main` page.
 *
 * CONFIGURATION HOLDS NO SECRET — and neither does this plugin. Each provider
 * alias carries a credential REFERENCE name (`GITHUB_TOKEN`): configuration, not a
 * secret, which is why it may appear in the config editor and on the page. DSH
 * resolves that reference per call from its own store, the environment, or a
 * `.env`. The value is handed straight to one request's Authorization header; it
 * is never returned, logged, displayed, or characterized (no mask, no length).
 *
 * @module dsh-connector
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  DEFAULT_CLIENT_SECRET_REF, DEFAULT_CLOUDFLARE_REFRESH_REF, DEFAULT_GITHUB_REFRESH_REF, DEFAULT_REFS, PROVIDERS,
} from './lib/credentials.js'
import { CLOUDFLARE_CALLBACK_PATH, GITEA_CALLBACK_PATH } from './lib/oauth.js'
import { createOperations, GITHUB_DEFAULT_SCOPES } from './lib/operations.js'
import { createRoutes } from './lib/routes.js'
import { createTools } from './lib/tools.js'

export const name = 'connector'

/**
 * Resolve Schemastery the way the LOADER sees it, not the way this file sees it.
 *
 * A bundle installed into a profile is materialized as a symlink
 * (`profiles/<name>/node_modules/dsh-connector -> …`), and Node resolves a
 * module's bare specifiers against its REAL path — so a plain
 * `import z from '@deepseek-ai/schemastery'` would look for the dependency beside
 * the source checkout, not beside the profile that mounted it. That is not a
 * hypothesis: with the plugin symlinked and Schemastery present only in the
 * profile, that import fails with ERR_MODULE_NOT_FOUND and takes the whole loader
 * tree down with it.
 *
 * So the dependency is resolved at runtime against, in order: this package (a
 * real install with hoisted deps), the live profile, `$DSH_HOME`, and the process
 * cwd. Finding none of them is survivable — the row still mounts and `apply` reads
 * the same defaults — which is what keeps one missing optional dependency from
 * blanking the Harness.
 */
function loadSchemastery() {
  const bases = [
    import.meta.url,
    process.env.DSH_PROFILE_DIR === undefined ? undefined : join(process.env.DSH_PROFILE_DIR, 'package.json'),
    process.env.DSH_HOME === undefined || process.env.DSH_PROFILE === undefined
      ? undefined
      : join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE, 'package.json'),
    join(process.cwd(), 'package.json'),
  ]
  for (const base of bases) {
    if (base === undefined) continue
    try {
      return createRequire(base)('@deepseek-ai/schemastery')
    } catch { /* try the next base */ }
  }
  return undefined
}

const z = loadSchemastery()

/**
 * `credentials` and `configEditor` are optional-safe: the tools still answer
 * "no token stored" and the page still renders when a host lacks them, which is
 * why they are reached through `ctx.get()` rather than a hard `inject` entry.
 */
export const inject = ['tools', 'systemPrompt', 'webServer']

/**
 * The non-secret config surface. There is deliberately no token field: a token
 * written here would sit in the profile patch on disk, which is exactly what the
 * credential store exists to prevent.
 */
function buildConfig() {
  const workspaceRoot = z.string().default('/workspace').description(
    'The only tree a push may read. Project paths outside it are refused.',
  )
  // Per provider: a default alias, the credential REFERENCE that alias uses, and
  // an optional alias → reference map. A reference name is not a secret — it is
  // the name DSH resolves — so it belongs in config; the value never does.
  const aliases = () => z.dict(z.string()).default({})
  const github = z.object({
    defaultAlias: z.string().default('default').description('Alias used when a call names no alias.'),
    credentialRef: z.string().default(DEFAULT_REFS.github).description(
      'DSH credential reference that holds the GitHub token (a NAME, e.g. GITHUB_TOKEN; the value lives in DSH).',
    ),
    aliases: aliases().description('Extra aliases: alias name to credential reference name.'),
    apiBase: z.string().default('https://api.github.com').description('GitHub REST origin (GitHub Enterprise: https://HOST/api/v3).'),
    // The refresh half of a device-flow grant (present when the OAuth App has
    // "Expire user access tokens" enabled). A NAME, never a value.
    refreshCredentialRef: z.string().default(DEFAULT_GITHUB_REFRESH_REF).description(
      'DSH credential reference holding the GitHub OAuth REFRESH token (a NAME; written by the device-flow poll).',
    ),
    refreshAliases: aliases().description('Extra aliases for the refresh reference: alias name to reference name.'),
    // OPTIONAL: a confidential OAuth App refresh needs its client secret. A ref
    // NAME only; when it does not resolve, the refresh request omits it.
    clientSecretRef: z.string().default('GITHUB_CLIENT_SECRET').description(
      'OPTIONAL DSH credential reference holding the OAuth App client SECRET used ONLY for a token refresh (a NAME).',
    ),
  }).default({})
  const cloudflare = z.object({
    defaultAlias: z.string().default('default'),
    credentialRef: z.string().default(DEFAULT_REFS.cloudflare).description(
      'DSH credential reference holding the Cloudflare access token (a NAME; the value lives in DSH).',
    ),
    aliases: aliases().description('Extra aliases: alias name to credential reference name.'),
    apiBase: z.string().default('https://api.cloudflare.com'),
    // The refresh half of the OAuth grant. Same rule as the access reference: a
    // NAME, never a value, and it is written by the Login callback.
    refreshCredentialRef: z.string().default(DEFAULT_CLOUDFLARE_REFRESH_REF).description(
      'DSH credential reference holding the Cloudflare OAuth REFRESH token (a NAME; written by the Login callback).',
    ),
    refreshAliases: aliases().description('Extra aliases for the refresh reference: alias name to reference name.'),
    oauthBase: z.string().default('').description(
      'OAuth origin for the dashboard endpoints (default https://dash.cloudflare.com). Never carries a token.',
    ),
  }).default({})
  const gitea = z.object({
    defaultAlias: z.string().default('default'),
    credentialRef: z.string().default(DEFAULT_REFS.gitea).description(
      'DSH credential reference holding the Gitea token (a NAME; the value lives in DSH).',
    ),
    aliases: aliases().description('Extra aliases: alias name to credential reference name.'),
    apiBase: z.string().default('').description(
      'REQUIRED for Gitea: the self-hosted origin, e.g. https://git.example.com. Never carries a token.',
    ),
    allowSelfSigned: z.boolean().default(false).description(
      'Accept a self-signed certificate for this one self-hosted instance. Off by default.',
    ),
  }).default({})
  // The Gitea OAuth2 application's PUBLIC client id. Same reasoning as GitHub's:
  // a client id travels in the authorize URL, so it is configuration, not a
  // secret. The client SECRET is never here — it is a credential reference name.
  const giteaOAuthClientId = z.string().default('').description(
    'PUBLIC Gitea OAuth2 application client id used for the authorization-code login. Empty = the Login panel asks for it inline.',
  )
  const giteaClientSecretRef = z.string().default(DEFAULT_CLIENT_SECRET_REF).description(
    'DSH credential reference holding the Gitea OAuth2 client SECRET (a NAME; the value lives in DSH and is resolved only at exchange time).',
  )
  const outputLimit = z.number().step(1).min(512).max(200000).default(8000).description(
    'Maximum characters one tool result keeps (log tails are truncated here).',
  )
  const requestTimeoutMs = z.number().step(1).min(1000).max(120000).default(20000).description(
    'Per-request timeout for provider API calls.',
  )
  // A PUBLIC identifier, not a secret: GitHub device-flow client ids travel in a
  // URL and no client secret is involved, so this is the one "OAuth-ish" value
  // that may live in config. Empty = the Login panel asks for it inline.
  const githubDeviceClientId = z.string().default('').description(
    'PUBLIC GitHub OAuth App client id for the device flow (no client secret is used or needed). Empty = the Login panel asks for it inline.',
  )
  // THE SCOPES THE DEVICE FLOW ASKS FOR. `POST /login/device/code` accepts an
  // OPTIONAL space-delimited `scope`; OMITTED, GitHub issues an IDENTITY-ONLY
  // token — private reads fall back anonymously and `git push` answers 403.
  // Public configuration (it travels in the request body), never a secret.
  const githubRequestedScopes = z.string().default(GITHUB_DEFAULT_SCOPES).description(
    'Space-separated GitHub OAuth scopes the device flow requests at consent (default "repo workflow": private reads + push). Non-secret. Empty = an IDENTITY-ONLY token: private reads fall back anonymously and git push answers 403 until you re-Login with repo.',
  )
  // The Cloudflare OAuth client is a PUBLIC client (PKCE, `token_endpoint_auth_method:
  // none`), so it has a client id and NOTHING ELSE: no secret exists to store.
  // The scope list is the user's choice (live catalogue: GET /client/v4/oauth/scopes),
  // and it travels in the authorize URL, so it is configuration too.
  const cloudflareOAuthClientId = z.string().default('').description(
    'PUBLIC Cloudflare OAuth client id (Manage Account → OAuth clients). PKCE, no client secret. Empty = the Login panel asks for it inline.',
  )
  const cloudflareOAuthScopes = z.string().default('').description(
    'Space-separated Cloudflare OAuth scopes (dot form, SINGULAR ids: page.read/page.write). Empty = the 20-id want-list the plugin ships (pages, DNS, zones, zone-settings.*, zone-waf.*, ddos-protection.read + http-ddos-managed-ruleset.read, account-firewall-access-rules.*, account-rule-lists.*, config-settings.*, analytics.read, offline_access).',
  )
  // A redirect ORIGIN, not a URL and not a secret. Cloudflare accepts HTTPS (or
  // http://localhost:<port>) only, so a page reached on http://127.0.0.1:<port>
  // must name the HTTPS origin registered on the OAuth client to log in at all.
  const cloudflareCallbackOrigin = z.string().default('').description(
    'Optional redirect ORIGIN override for Cloudflare, e.g. https://connector.example.com. Must be HTTPS (or http://localhost:<port>) and must be registered among the OAuth client redirect (callback) URLs. Empty = derive it from the page origin.',
  )
  // THE GITEA EQUIVALENT — the same non-secret origin override, held to the same
  // rule. A Gitea OAuth2 application compares its registered callback EXACTLY, so
  // a login pressed on http://127.0.0.1:<port> must be able to name the domain the
  // application registered instead of sending the loopback origin.
  const giteaCallbackOrigin = z.string().default('').description(
    'Optional redirect ORIGIN override for Gitea, e.g. https://connector.example.com. Must be HTTPS (or http://localhost:<port>) and must be registered among the OAuth2 application redirect (callback) URIs, EXACTLY. Empty = derive it from the page origin.',
  )
  return z.object({
    workspaceRoot, github, cloudflare, gitea, giteaOAuthClientId, giteaClientSecretRef,
    cloudflareOAuthClientId, cloudflareOAuthScopes, cloudflareCallbackOrigin, giteaCallbackOrigin,
    outputLimit, requestTimeoutMs, githubDeviceClientId, githubRequestedScopes,
  })
}

/**
 * The Config export, or nothing.
 *
 * With no Schemastery there is no schema to declare, and a half-built one would
 * be worse than none: the loader would call it and throw on the first
 * `z.string()`. Exporting `undefined` in that case is the honest answer — the
 * loader validates nothing and reads the row's config as written, so the plugin
 * still mounts with the same defaults `apply` already applies itself.
 */
export const Config = z === undefined ? undefined : buildConfig()

/**
 * The prompt the model always reads: the operational facts, compressively.
 *
 * STYLE RULE (token budget). One fact per line, telegraphic, no marketing. Every
 * tool description carries only what DISCRIMINATES it; everything shared lives
 * here once, so six descriptions never repeat a sentence six times:
 *
 *   * the read/write markers (`READ ✓` / `WRITE ⚠`) that every description uses
 *     as its first token, and what a WRITE actually requires;
 *   * the reference/secret model (values never leave DSH; never ask, never echo)
 *     and the `no value in or out` clause the descriptions no longer repeat;
 *   * the slot keys and their shared semantics (`provider`/`alias` default,
 *     `owner` = Cloudflare account id, `repo` = Pages project, 32-hex ids);
 *   * the degrade rules (Cloudflare verbs stay inside `connector_cloudflare`;
 *     Gitea capability probes) and the login/scope-403 answer;
 *   * the one ordering rule that prevents wasted calls (`connector_status` first).
 *
 * Measured budget: this section is 1303 characters (1129 before the LIVE-token
 * clause and the liveness hint). `selftest/harness.mjs`
 * asserts an upper bound and `selftest/measure-text.mjs` reports the exact value
 * beside the tool descriptions, so a future edit cannot re-inflate it unnoticed.
 *
 * Nothing value-dependent is composed here, so it never needs a credential to
 * build, and it names no mask shape (a mask is still an oracle).
 */
const CONNECTOR_PROMPT = [
  'Connector (`connector_*`) on GitHub/Gitea/Cloudflare, through DSH credential REFERENCES: an alias names one (`GITHUB_TOKEN`) that DSH resolves per call. Never ask the user for a credential, never repeat one — no value is returned, never derived; `connector_status` prints the reference name only.',
  '`READ ✓` unrestricted; `WRITE ⚠` approval-gated (approval policy: state what changes and why). Slots: provider, alias (default: provider default), owner, repo, action; ids 32-hex, Cloudflare `owner` = account id and `repo` = Pages project. `no value in or out`.',
  'Writes require a LIVE token — if status marks the token dead, direct the user to Login; never route github pushes through arbitrary git remotes.',
  '`connector_status` first (liveness flags a dead token; rateLimit:false skips the probes). `connector_file`: read_tree/read_file read, put_file commits (sha replaces, else creates). `connector_repo_actions`: 8 reads, the rest write — issue/label/assignee/branch/tag/PR edits, run_dispatch/run_cancel/run_rerun/delete_run, pr_merge.',
  'Cloudflare verbs outside `connector_cloudflare` are unsupported; Gitea capability-detects (Swagger), the rest is explicit unsupported; `connector_push` = wrangler deploy there, dryRun:false. 401 or an "invalid token" 403 = token expired (refresh once, then Login); a plain 403 = scope not granted; unresolved reference or OAuth: Connector page Login.',
].join(' ')

/**
 * Mount the host half.
 * @param ctx - plugin context.
 * @param config - validated non-secret config.
 */
export function apply(ctx, config = {}) {
  const workspaceRoot = config.workspaceRoot ?? '/workspace'
  const operations = createOperations({ ctx, config, workspaceRoot, logger: ctx.logger })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/connector',
    handler: createRoutes({ operations, logger: ctx.logger }),
  }), 'connector: page api')

  /**
   * THE TWO CALLBACKS ARE ALSO REGISTERED AS EXACT ROUTES.
   *
   * The prefix above already answers them, so this is not a second handler: it is
   * the same handler on the exact-path seat, which the web server consults BEFORE
   * any prefix (`responderFor`: exact, then longest prefix, then fallback). That
   * matters for the one route a browser reaches by NAVIGATION rather than by
   * `fetch`: an error page instead of our page — the harness's generic "this route
   * does not exist" shell — is what a user sees when some other plugin claims a
   * broader prefix, and no plugin can take a seat that is already exact.
   *
   * A duplicate registration is impossible (the exact table and the prefix table
   * are separate, and `register` throws on a duplicate within one table), so this
   * cannot make the plugin double-answer a request.
   */
  for (const path of [CLOUDFLARE_CALLBACK_PATH, GITEA_CALLBACK_PATH]) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: createRoutes({ operations, logger: ctx.logger }),
    }), `connector: ${path} seat`)
  }

  for (const tool of createTools({ operations })) ctx.tools.register(tool)

  ctx.systemPrompt.section({
    name: 'tool:connector',
    // Right after the personal-VM block (120), before the MCP catalogue region.
    order: 121,
    // Named rather than value-dependent: the paragraph describes the tools, and
    // it names no provider state, so it never needs a token to compose.
    text: () => CONNECTOR_PROMPT,
  })

  // One informational line at mount: no credential, no path derived from one.
  // Nothing is resolved here — references are read per call.
  ctx.logger?.info?.(`connector: reference-only credentials; values resolve through DSH (${PROVIDERS.join(', ')})`)
}

export { createOperations, createRoutes, createTools }
