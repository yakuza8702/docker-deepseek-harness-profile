/**
 * Connector — credential REFERENCES only. No token is ever stored, shown, or
 * characterized by this plugin.
 *
 * THE MODEL (owner decision, superseding the earlier record-store scheme)
 * ----------------------------------------------------------------------
 * A provider alias maps to a DSH **credential reference** — a POSIX-identifier
 * name such as `GITHUB_TOKEN` — and to nothing else. The reference is not a
 * secret: it lives in this plugin's Config like any other setting, visible in the
 * config editor, and it is the only thing this plugin persists.
 *
 * DSH owns the value. It may sit in `$DSH_HOME/.credentials.yaml` under `refs:`,
 * in the process environment, or in a project `.env`; the official credential
 * provider decides, and this plugin never learns which except as the non-secret
 * `source` label that provider already publishes (`env`, `file`, …).
 *
 * WHAT THIS MODULE MAY DO WITH A VALUE
 * ------------------------------------
 * Two things, and no more:
 *
 *   * READ it at call time (`resolveSecret`) and hand it straight to the provider
 *     adapter as an Authorization header for that one request;
 *   * WRITE it when the owner logs in (`setSecret`) or logs out (`unsetSecret`),
 *     through the official `ctx.credentials.set/unset` seam, which is the only
 *     writer of `$DSH_HOME/.credentials.yaml`.
 *
 * In both directions the value stays inside this module's scope. It is never
 * returned to a route, a tool, a log, or the page, and it is never described — no
 * trailing characters, no length, no prefix, no check digit, no mask of any kind.
 * The only facts this plugin ever publishes about a credential are whether it
 * RESOLVES and which REFERENCE NAME carries it. A Login response therefore says
 * `{ ok, credentialRef, source }` and nothing whatsoever about the token.
 *
 * That is why `describeCredential` returns `{ credentialRef, resolved, source? }`
 * and why this package contains no masking helper of any kind: a mask is still an
 * oracle, and the owner asked for none.
 *
 * @module dsh-connector/lib/credentials
 */

/** Providers this plugin speaks to. */
export const PROVIDERS = ['github', 'cloudflare', 'gitea']

/** The reference each provider defaults to; not a secret, and editable in Config. */
export const DEFAULT_REFS = {
  github: 'GITHUB_TOKEN',
  cloudflare: 'CLOUDFLARE_API_TOKEN',
  gitea: 'GITEA_TOKEN',
}

/**
 * The default reference for the Gitea OAuth2 client SECRET.
 *
 * Kept OUT of {@link DEFAULT_REFS} on purpose: that map answers "which reference
 * holds this provider's TOKEN", and the client secret is not a token — it belongs
 * to the registered application, it is never sent as an Authorization header, and
 * it is resolved exactly once, inside the authorization-code exchange.
 */
export const DEFAULT_CLIENT_SECRET_REF = 'GITEA_CLIENT_SECRET'

/**
 * The reference that holds the Cloudflare OAuth REFRESH token.
 *
 * Kept OUT of {@link DEFAULT_REFS} for the same reason as the Gitea client
 * secret: that map answers "which reference holds this provider's TOKEN", and the
 * refresh token is the credential that MINTS the access token. It is written by
 * the same Login callback, read exactly once per refresh, and never sent as an
 * `Authorization` header.
 */
export const DEFAULT_CLOUDFLARE_REFRESH_REF = 'CLOUDFLARE_REFRESH_TOKEN'

/**
 * The reference that holds the GitHub OAuth REFRESH token.
 *
 * GitHub's device flow returns one when the OAuth App has "Expire user access
 * tokens" enabled (access token 8 h, refresh token 6 months). It is written by
 * the device-flow poll, read exactly once per refresh, and never sent as an
 * `Authorization` header.
 */
export const DEFAULT_GITHUB_REFRESH_REF = 'GITHUB_REFRESH_TOKEN'

/** Alias grammar: a stable key inside one provider's alias map. */
export const ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

/** The seam's CredentialRef grammar, mirrored so we fail before the store does. */
export const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const PROVIDER_SET = new Set(PROVIDERS)

/**
 * Raised when this host mounted no credential provider. Carried as a typed error
 * (with `code`) so the route layer answers 503 by inspection.
 */
export class StoreUnavailableError extends Error {
  constructor(message = 'no credential provider is available in this host') {
    super(message)
    this.name = 'StoreUnavailableError'
    this.code = 'CONNECTOR_STORE_UNAVAILABLE'
  }
}

/**
 * Whether a string is a well-formed credential reference NAME.
 * @param value - candidate reference.
 * @returns whether it matches {@link REF_PATTERN}.
 */
export function isRefName(value) {
  return typeof value === 'string' && REF_PATTERN.test(value)
}

/**
 * Validate a reference name.
 * @param value - candidate reference.
 * @returns the name.
 * @throws TypeError when it is not a POSIX identifier.
 */
export function assertRefName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!isRefName(name)) {
    const error = new TypeError('credential reference must be a name like GITHUB_TOKEN (letters, digits, underscore; not starting with a digit)')
    error.code = 'CONNECTOR_BAD_REQUEST'
    throw error
  }
  return name
}

/**
 * Validate an alias.
 * @param value - candidate alias.
 * @returns the alias.
 * @throws TypeError when it is outside {@link ALIAS_PATTERN}.
 */
export function assertAlias(value) {
  const alias = typeof value === 'string' ? value.trim() : ''
  if (!ALIAS_PATTERN.test(alias)) {
    const error = new TypeError('alias must be lowercase letters, digits or dashes (1-32 chars, starting alphanumeric)')
    error.code = 'CONNECTOR_BAD_REQUEST'
    throw error
  }
  return alias
}

/**
 * Assert a provider id.
 * @param value - candidate provider.
 * @returns the normalized id.
 * @throws TypeError when unknown.
 */
export function assertProvider(value) {
  const provider = String(value ?? '').toLowerCase()
  if (!PROVIDER_SET.has(provider)) {
    const error = new TypeError(`unknown provider "${provider}"; expected one of ${PROVIDERS.join(', ')}`)
    error.code = 'CONNECTOR_BAD_REQUEST'
    throw error
  }
  return provider
}

/**
 * The reference name one provider+alias uses.
 *
 * The default alias reads `config[provider].credentialRef`; extra aliases read
 * their own entry in `config[provider].aliases`. An alias with no entry has no
 * reference at all, which the caller reports as unresolvable rather than guessing.
 *
 * @param config - the live non-secret config.
 * @param provider - provider id.
 * @param alias - alias, or `undefined` for the provider default.
 * @returns the reference name, or `''` when this alias has none.
 */
export function refNameOf(config, provider, alias) {
  const section = config?.[provider] ?? {}
  const name = alias === undefined || alias === '' ? section.defaultAlias ?? 'default' : alias
  if (name === (section.defaultAlias ?? 'default')) {
    const configured = section.credentialRef
    return isRefName(configured) ? configured : DEFAULT_REFS[provider]
  }
  const mapped = section.aliases?.[name]
  return isRefName(mapped) ? mapped : ''
}

/**
 * The reference one provider+alias is configured with, resolved and validated.
 * @param config - the live non-secret config.
 * @param provider - provider id.
 * @param alias - alias, or `undefined` for the default.
 * @returns the reference name.
 * @throws TypeError when the alias has no reference name at all.
 */
export function requireRefName(config, provider, alias) {
  const name = refNameOf(config, provider, alias)
  if (name === '') {
    const error = new TypeError(`alias "${alias}" has no credential reference; set one on the Connector page (Status)`)
    error.code = 'CONNECTOR_NO_TOKEN'
    throw error
  }
  return name
}

/**
 * The reference that holds the Gitea OAuth2 application's client SECRET.
 *
 * Two layers, exactly like a token: `config.gitea.clientSecretRef` for the
 * default alias, and `config.gitea.clientSecretAliases[alias]` for the rest. An
 * alias with no entry of its own falls back to the default reference, because
 * one application usually serves every alias of one instance.
 *
 * @param config - the live non-secret config.
 * @param alias - alias, or `undefined` for the provider default.
 * @returns the reference name (never empty).
 */
export function clientSecretRefName(config, alias = undefined) {
  const section = config?.gitea ?? {}
  const name = alias === undefined || alias === '' ? section.defaultAlias ?? 'default' : alias
  const mapped = section.clientSecretAliases?.[name]
  if (isRefName(mapped)) return mapped
  const configured = section.clientSecretRef
  return isRefName(configured) ? configured : DEFAULT_CLIENT_SECRET_REF
}

/**
 * The reference that holds the Cloudflare OAuth refresh token for one alias.
 *
 * Two layers, exactly like Gitea's client secret: `config.cloudflare.
 * refreshCredentialRef` for the default alias, `config.cloudflare.
 * refreshAliases[alias]` for the rest. An alias with no entry of its own falls
 * back to the default reference, because one registered OAuth client usually
 * serves every alias of one account.
 *
 * @param config - the live non-secret config.
 * @param alias - alias, or `undefined` for the provider default.
 * @returns the reference name (never empty).
 */
export function cloudflareRefreshRefName(config, alias = undefined) {
  const section = config?.cloudflare ?? {}
  const name = alias === undefined || alias === '' ? section.defaultAlias ?? 'default' : alias
  const mapped = section.refreshAliases?.[name]
  if (isRefName(mapped)) return mapped
  const configured = section.refreshCredentialRef
  return isRefName(configured) ? configured : DEFAULT_CLOUDFLARE_REFRESH_REF
}

/**
 * The reference that holds the GitHub OAuth refresh token for one alias.
 *
 * Two layers like the others: `config.github.refreshCredentialRef` for the
 * default alias, `config.github.refreshAliases[alias]` for the rest. An alias
 * with no entry of its own falls back to the default reference.
 *
 * @param config - the live non-secret config.
 * @param alias - alias, or `undefined` for the provider default.
 * @returns the reference name (never empty).
 */
export function githubRefreshRefName(config, alias = undefined) {
  const section = config?.github ?? {}
  const name = alias === undefined || alias === '' ? section.defaultAlias ?? 'default' : alias
  const mapped = section.refreshAliases?.[name]
  if (isRefName(mapped)) return mapped
  const configured = section.refreshCredentialRef
  return isRefName(configured) ? configured : DEFAULT_GITHUB_REFRESH_REF
}

/** The credential provider, when this host has one mounted. */
function provider(ctx) {
  return ctx?.get?.('credentials') ?? ctx?.credentials
}

/**
 * Resolve a reference to its value — THE ONLY read path, and the only place a
 * secret enters this plugin's scope.
 *
 * Callers must hand the result straight to the adapter that needs it for one
 * request. It must not be returned, logged, compared, measured, or stored.
 *
 * @param ctx - plugin context.
 * @param ref - validated reference name.
 * @returns the secret value, or `undefined` when the reference does not resolve.
 */
export async function resolveSecret(ctx, ref) {
  const credentials = provider(ctx)
  if (credentials === undefined) throw new StoreUnavailableError()
  const resolved = await credentials.resolve(ref)
  // `resolve` answers `{ value, source }`; an empty value is not a usable secret.
  return typeof resolved?.value === 'string' && resolved.value !== '' ? resolved.value : undefined
}

/**
 * Store a credential VALUE under one reference — the Login write path, and the
 * only place a value is ever handed to DSH.
 *
 * This is the official seam (`ctx.credentials.set`), which the local provider
 * implements as an atomic, 0600 rewrite of `$DSH_HOME/.credentials.yaml` under a
 * cross-process lock. The value exists in this function's scope, in the store's
 * own write, and nowhere else: it is not returned, not logged, not measured, and
 * not echoed into the error path (a store failure is reported by REFERENCE NAME
 * and a constant message, because a provider is free to quote what it refused).
 *
 * @param ctx - plugin context.
 * @param ref - reference name; validated here before the store sees it.
 * @param value - the token to store.
 * @returns the reference name that was written.
 * @throws TypeError when the reference or the value is unusable.
 * @throws StoreUnavailableError when this host mounted no writable provider.
 */
export async function setSecret(ctx, ref, value) {
  const name = assertRefName(ref)
  if (typeof value !== 'string' || value === '') {
    const error = new TypeError('a token is required')
    error.code = 'CONNECTOR_BAD_REQUEST'
    throw error
  }
  const credentials = provider(ctx)
  if (credentials === undefined || typeof credentials.set !== 'function') throw new StoreUnavailableError()
  try {
    await credentials.set(name, value)
  } catch {
    // Deliberately NOT `error.message`: a store may quote the value it refused.
    const failure = new Error(`the credential store refused a write for ${name}`)
    failure.code = 'CONNECTOR_STORE_WRITE_FAILED'
    throw failure
  }
  return name
}

/**
 * Remove the value stored under one reference — the Logout path.
 *
 * After this the reference may still resolve from the environment or a `.env`;
 * the page reports whatever the next `describe` says rather than assuming the
 * credential is gone, because DSH owns that decision.
 *
 * @param ctx - plugin context.
 * @param ref - reference name.
 * @returns the reference name that was cleared.
 * @throws TypeError when the reference is not a name.
 * @throws StoreUnavailableError when this host mounted no writable provider.
 */
export async function unsetSecret(ctx, ref) {
  const name = assertRefName(ref)
  const credentials = provider(ctx)
  if (credentials === undefined || typeof credentials.unset !== 'function') throw new StoreUnavailableError()
  try {
    await credentials.unset(name)
  } catch {
    const failure = new Error(`the credential store refused to clear ${name}`)
    failure.code = 'CONNECTOR_STORE_WRITE_FAILED'
    throw failure
  }
  return name
}

/**
 * The non-secret status of one reference: does it resolve, and through which
 * source layer. Never the value, and never anything derived from it.
 *
 * `source` is included only because the credential provider already publishes it
 * as a non-secret label (`env`, `file`, …) for exactly this purpose.
 *
 * @param ctx - plugin context.
 * @param ref - reference name.
 * @returns `{ credentialRef, resolved, source? }`.
 */
export async function describeCredential(ctx, ref) {
  const credentials = provider(ctx)
  if (credentials === undefined) return { credentialRef: ref, resolved: false }
  let info
  try {
    info = await credentials.describe(ref)
  } catch {
    // A host that refuses to describe must read as "not configured", never as an
    // error that could echo anything.
    return { credentialRef: ref, resolved: false }
  }
  const resolved = info?.configured === true
  return {
    credentialRef: ref,
    resolved,
    ...(resolved && typeof info?.source === 'string' && info.source !== '' ? { source: info.source } : {}),
  }
}

/**
 * Status for one provider (or all of them): each alias, its reference name, and
 * whether that reference resolves.
 *
 * @param ctx - plugin context.
 * @param config - live non-secret config.
 * @param options - `provider` and `alias` filters.
 * @returns `{ providers: [{ provider, defaultAlias, aliases: [...] }] }`.
 */
export async function listReferences(ctx, config, { provider, alias } = {}) {
  const names = provider === undefined ? PROVIDERS : [assertProvider(provider)]
  const rows = []
  for (const name of names) {
    const section = config?.[name] ?? {}
    const defaultAlias = section.defaultAlias ?? 'default'
    const aliases = [{ alias: defaultAlias, credentialRef: section.credentialRef ?? DEFAULT_REFS[name] }]
    for (const [key, value] of Object.entries(section.aliases ?? {})) {
      if (key === defaultAlias) continue
      aliases.push({ alias: key, credentialRef: value })
    }
    const wanted = alias === undefined ? aliases : aliases.filter(row => row.alias === assertAlias(alias))
    const described = []
    for (const row of wanted) {
      const state = isRefName(row.credentialRef)
        ? await describeCredential(ctx, row.credentialRef)
        : { credentialRef: '', resolved: false }
      described.push({
        alias: row.alias,
        credentialRef: state.credentialRef,
        resolved: state.resolved,
        ...(state.source === undefined ? {} : { source: state.source }),
      })
    }
    rows.push({
      provider: name,
      defaultAlias,
      ...(name === 'gitea' ? { baseUrl: config?.gitea?.apiBase ?? '' } : {}),
      aliases: described,
    })
  }
  return { providers: rows }
}

/**
 * Where DSH keeps managed references, for the page footnote. A path — never a
 * value, and never a hint about any value.
 * @param env - process environment.
 * @returns the credential document path, when the home is known.
 */
export function storePath(env = process.env) {
  const home = env.DSH_HOME ?? ''
  return home === '' ? '$DSH_HOME/.credentials.yaml' : `${home.replace(/\/+$/u, '')}/.credentials.yaml`
}

/**
 * Replace a resolved secret in text about to leave the plugin.
 *
 * The value is used only as a search needle, and the replacement is a constant, so
 * nothing about it (length, prefix, suffix) survives in the output. This exists for
 * push stderr, where git could conceivably echo what askpass handed it.
 *
 * @param value - text about to leave the plugin.
 * @param secret - the value resolved for this call, if any.
 * @returns the redacted text.
 */
export function redact(value, secret) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (typeof secret !== 'string' || secret === '') return text
  return text.split(secret).join('***')
}
