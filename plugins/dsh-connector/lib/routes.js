/**
 * Connector Host routes — `/api/connector/*`.
 *
 * Same shape as the proven `/cua` handler: one prefix registration, a JSON body
 * reader, one `send()` that always sets `no-store`, and a switch over the action
 * path. The page (same origin, peer-trusted like every other harness route) calls
 * these; nothing here is reachable from a foreign origin because the handler
 * never adds CORS headers and always answers JSON.
 *
 * TWO RULES THAT MUST NOT DRIFT
 * -----------------------------
 * 1. The write paths that touch a credential, each with ONE job:
 *      * `POST /api/connector/ref` stores a credential reference NAME — config,
 *        not a secret — through `configEditor`;
 *      * `POST /api/connector/credentials` accepts the Gitea OAuth2 client SECRET
 *        ONCE, hands it to `ctx.credentials.set(credentialRef, value)` (the
 *        official store: atomic, 0600, under `$DSH_HOME/.credentials.yaml`) and
 *        answers `{ ok, credentialRef }` — nothing else. `DELETE
 *        /api/connector/credentials` clears the alias's reference the same way;
 *      * the two OAuth callbacks (`GET …/oauth/gitea/callback`, `GET
 *        …/oauth/cloudflare/callback`) write the token their exchange returned.
 *    No page posts a provider TOKEN at all: GitHub uses its device flow, Gitea its
 *    authorization-code flow, and Cloudflare a PKCE authorization-code flow whose
 *    callback (not the page) stores the access + refresh pair.
 *    The reference is never taken from the request body: it is the one the alias
 *    is configured with, so a caller cannot aim a write at a reference it did not
 *    address. No response names the value, its length, or any fragment of it.
 * 2. No response and no log line is built before passing through `redact`. Error
 *    text is provider/status/URL only.
 *
 * The pages the Connector client ships now render only the Status tab, but the
 * routes below are NOT the page's private API: they are the same operations the
 * `connector_*` tools call, exposed for same-origin callers. Write routes are
 * listed separately in {@link WRITE_ROUTES} so the read/write split is greppable,
 * and the two endpoints whose verb decides — `POST actions`, `POST files` — are
 * called out in {@link MIXED_ROUTES} rather than mislabelled as reads.
 *
 * @module dsh-connector/lib/routes
 */

import { StoreUnavailableError, redact } from './credentials.js'
import {
  CLOUDFLARE_CALLBACK_PATH, GITEA_CALLBACK_PATH, callbackErrorPage, completionPage, originOfRequest,
} from './oauth.js'

/** Action → operations method, reads first. Anything absent is a 404. */
const READ_ROUTES = {
  'GET state': 'status',
  'POST status': 'status',
  'POST test': 'test',
  'POST repos': 'repos',
  'POST rate': 'rateLimit',
  'POST inspect': 'inspectPath',
  // Device-flow polling reads provider state; it writes nothing itself (the
  // write happens on the terminal 'authorized' answer, inside operations).
  'POST device': 'devicePoll',
  // The Gitea secret's non-secret state: does the reference resolve?
  'POST secret/state': 'clientSecretState',
  // The authorize URL builders. Each mints a ONE-TIME state (Cloudflare's also
  // mints and parks the PKCE verifier) and returns it to the caller that opens the
  // tab; neither touches a credential and neither performs a write.
  'POST oauth/start': 'oauthStart',
  'POST oauth/cloudflare/start': 'oauthCloudflareStart',
}

/**
 * Routes that are ONE endpoint but carry BOTH reads and writes.
 *
 * `POST actions` dispatches `repoAction`, whose verb decides: `prs`, `issues`,
 * `commits` and the rest are reads, while `pr_merge`, `run_dispatch` and every
 * other write verb mutate the remote. `POST files` is the same shape — `put_file`
 * makes a commit. Filing them under {@link READ_ROUTES} claimed the whole
 * endpoint was safe to call; this map says "read OR write, decided by the verb",
 * so the approval surface is decided where it belongs.
 *
 * Keeping them out of both concrete maps is deliberate: the read/write split has
 * to stay greppable and honest, and a mixed route is neither. Behaviour is
 * unchanged — they are still registered under the same keys — only the
 * classification moved.
 */
const MIXED_ROUTES = {
  'POST actions': 'repoAction',
  'POST files': 'fileAction',
  // Cloudflare platform verbs: reads (zones/dns/waf/settings/ddos/analytics) and
  // writes (create/patch/delete/edit) share one endpoint; the ACTION decides.
  'POST cloudflare': 'cloudflareAction',
}

/**
 * Routes that change something: the remote (through a provider write verb), the
 * profile patch (a reference NAME or a non-secret setting), or the workspace
 * (a push). Documented as approval-gated wherever a caller is told about them.
 */
const WRITE_ROUTES = {
  // Reference NAME for an alias (configuration, written to the profile patch).
  'POST ref': 'setAliasRef',
  // The Gitea OAuth2 client SECRET, written once into DSH's own store under its
  // dedicated reference, and the alias's reference removal on Logout (which for
  // Cloudflare also revokes the OAuth grant and clears the refresh reference).
  'POST credentials': 'saveClientSecret',
  'DELETE credentials': 'clearRef',
  // Abandoning an in-flight login (panel close, Logout): drops the host-side flow
  // so a poll still on the wire cannot store a token for a login nobody finished.
  'POST device/abort': 'abortLogin',
  // The authorization-code callbacks run the exchange, so they WRITE the token
  // (Cloudflare: the access token AND its refresh token, under two references).
  'GET oauth/gitea/callback': 'oauthGiteaCallback',
  'GET oauth/cloudflare/callback': 'oauthCloudflareCallback',
  // The device flow's opening step; completion is the poll below.
  'POST device/start': 'deviceStart',
  'POST settings': 'saveSettings',
  'POST push': 'push',
}

/** Everything reachable, for the 404 message and the tests. */
const ROUTES = { ...READ_ROUTES, ...WRITE_ROUTES, ...MIXED_ROUTES }

/**
 * HTTP status for one failed request, decided by TYPE AND CODE — never by words
 * in a message.
 *
 * The old heuristic scanned the text for `unknown|must|cannot|not `, which is
 * both too narrow and too broad: "settings can only be saved from the running host
 * profile" matched nothing and surfaced as 502, while any sentence containing the
 * word "not" was reported to the page as a 400 caller error. Message text is for
 * humans and changes freely; these codes are the contract.
 *
 *   404 — the alias has no token stored (naming it is the actionable part)
 *   401 — the stored token is DEAD (expired/revoked): the pre-flight refused the
 *         write before anything was sent, so the page can say "press Login"
 *   400 — the caller's input or configuration is wrong (TypeError, our code)
 *   503 — this host mounted no credential store
 *   424 — the provider or its network refused; the request itself was fine
 *   500 — anything truly unexpected, including a bug in this plugin
 *
 * @param error - whatever the operation threw.
 * @returns the status code.
 */
function statusOf(error) {
  if (error instanceof StoreUnavailableError || error?.code === 'CONNECTOR_STORE_UNAVAILABLE') return 503
  if (error?.code === 'CONNECTOR_NO_TOKEN') return 404
  if (error?.code === 'CONNECTOR_TOKEN_DEAD') return 401
  // AUTHENTICATED BUT NOT ALLOWED TO WRITE: the token is live (the push
  // pre-flight passed), the OAuth App's grant lacks Contents write. 403 is the
  // honest answer — not 401 ("log in"), not 424 ("the provider broke").
  if (error?.code === 'CONNECTOR_PUSH_FORBIDDEN') return 403
  if (error?.code === 'CONNECTOR_BAD_REQUEST' || error instanceof TypeError) return 400
  if (error?.code === 'CONNECTOR_PROVIDER_ERROR') return 424
  return 500
}

/**
 * Read and JSON-parse a request body.
 * @param req - incoming request.
 * @param limit - maximum bytes accepted.
 * @returns the parsed body (an empty object when there is none).
 */
async function readJson(req, limit = 8 * 1024 * 1024) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return {}
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new TypeError('request body is too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('request body must be a JSON object')
  return parsed
}

/**
 * The callbacks are the routes a BROWSER visits by navigation, so they answer
 * HTML (a plain "you can close this tab") and never JSON. They are separated out
 * because a redirect target that renders a JSON error to a human is a dead end:
 * the success and every failure both land on a page that explains itself.
 *
 * Both providers use the same shape — `?code=&state=` — and the SAME one-time
 * state store, so one map covers them and nothing about the redirect differs
 * except the path each OAuth client registered.
 */
const CALLBACKS = {
  'oauth/gitea/callback': {
    operation: 'oauthGiteaCallback',
    provider: 'gitea',
    path: GITEA_CALLBACK_PATH,
    done: 'connector: gitea authorization completed',
    failed: 'connector: gitea authorization failed',
  },
  'oauth/cloudflare/callback': {
    operation: 'oauthCloudflareCallback',
    provider: 'cloudflare',
    path: CLOUDFLARE_CALLBACK_PATH,
    done: 'connector: cloudflare authorization completed',
    failed: 'connector: cloudflare authorization failed',
  },
}

/**
 * The redirect URI a callback (or the guide) must use for one request.
 *
 * Built from the origin the browser actually addressed, because both OAuth
 * servers compare it with the registered URI character for character. An empty
 * origin (a unit test, a bare socket) answers `undefined`, which makes the
 * operations layer fall back to the observed GUI origin rather than inventing a
 * port.
 */
function redirectUriFor(origin, path) {
  return origin === '' ? undefined : `${origin}${path}`
}

/**
 * Send a small HTML page. No token, code, state or secret is ever interpolated:
 * `completionPage` is a constant template and takes only a short message.
 */
function sendHtml(res, status, html) {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  // The page carries one inline script that nudges its opener; `self` keeps the
  // document from loading anything at all from elsewhere.
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
  res.end(html)
}

/**
 * The action key for one request path.
 *
 * The handler is mounted as a PREFIX route (`/api/connector`), so the norm is a
 * pathname under that prefix. Two shapes still have to work, because the GUI is
 * routinely served through a reverse proxy and a proxy is allowed to rewrite the
 * path it forwards:
 *
 *   * repeated slashes / a trailing slash (`/api/connector//oauth/…`,
 *     `/api/connector/oauth/…/`) — canonicalized before the prefix is stripped;
 *   * a path with the prefix already removed (`/oauth/cloudflare/callback`), which
 *     is what a proxy that mounts this plugin under a sub-path produces.
 *
 * Both are the SAME action, so the callback stays reachable whichever way the
 * GUI origin arrives at this web server.
 *
 * @param pathname - the request pathname.
 * @returns the action key (`auth/...`, `oauth/...`, or `''` for the index).
 */
function actionOfPath(pathname) {
  const canonical = String(pathname ?? '')
    .replace(/\/{2,}/gu, '/')
    .replace(/\/+$/u, '')
  const stripped = canonical.replace(/^\/api\/connector(?=\/|$)/u, '')
  const action = stripped.replace(/^\/+/u, '')
  // A prefix-stripped CALLBACK path is unambiguous (the two provider segments are
  // fixed), so it is accepted; nothing else outside `/api/connector` is routable.
  if (/^oauth\/(gitea|cloudflare)\/callback$/u.test(action)) return action
  return canonical.startsWith('/api/connector') ? action : ''
}

/**
 * Build the route handler.
 * @param options - wiring.
 * @param options.operations - the operations facade.
 * @param options.logger - optional logger (kind-only messages).
 * @returns an `(req, res)` handler for `ctx.webServer.register`.
 */
export function createRoutes({ operations, logger }) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/api/connector', 'http://localhost')
    const action = actionOfPath(url.pathname)
    // The origin the browser actually used. Every OAuth redirect URI is built
    // from it, so the value matches the address bar (Gitea compares it with the
    // registered URI exactly). Recording it is a side effect of a request, never
    // a persistence: nothing about it is written anywhere.
    const origin = originOfRequest(req.headers, '')
    if (origin !== '' && typeof operations.setGuiOrigin === 'function') operations.setGuiOrigin({ origin })

    const callback = CALLBACKS[action]
    if (callback !== undefined && req.method === 'GET') {
      // THE PROVIDER CAN REFUSE BEFORE ANY CODE IS ISSUED: an OAuth error is
      // delivered as `?error=…&error_description=…` on the SAME redirect URI. That
      // is a configuration problem the user can fix (a scope the client does not
      // allow, a declined consent), so it gets a page that says WHERE — never a
      // dead tab and never a silent bounce.
      const oauthError = url.searchParams.get('error') ?? ''
      if (oauthError !== '') {
        logger?.warn?.(`connector: ${callback.provider} authorization refused by the provider`)
        return sendHtml(res, 400, callbackErrorPage({
          provider: callback.provider,
          error: oauthError,
          description: url.searchParams.get('error_description') ?? '',
          // PUBLIC, and the one string this deployment actually sends: a refusal of
          // `redirect_uri_mismatch` is unactionable without it.
          redirectUri: redirectUriFor(origin, callback.path) ?? '',
        }))
      }
      const code = url.searchParams.get('code') ?? ''
      const stateValue = url.searchParams.get('state') ?? ''
      /**
       * A HAND-TYPED VISIT. A browser that was NOT redirected here carries no
       * `code` and no `state`; that is a user checking the URL, not a login, and
       * the honest answer is a page that says so. It never throws and never logs
       * a state, and it keeps our route from looking like the harness's generic
       * not-found page (which is what a proxy that never reaches this route
       * serves — see CONNECTOR-SOL.md §9).
       */
      const manual = code === '' && stateValue === ''
      if (manual) {
        return sendHtml(res, 400, completionPage({
          ok: false,
          message: 'No authorization code was returned. This URL only completes a redirect from the provider; press Login on the Connector card and let the provider send the browser here.',
          redirectUri: redirectUriFor(origin, callback.path) ?? '',
          errorCode: 'CONNECTOR_MANUAL_VISIT',
          manual: true,
        }))
      }
      try {
        const done = await operations[callback.operation]({
          code,
          state: stateValue,
          redirectUri: redirectUriFor(origin, callback.path),
        })
        logger?.info?.(callback.done)
        return sendHtml(res, 200, completionPage({
          ok: true,
          provider: callback.provider,
          alias: done.alias,
          credentialRef: done.credentialRef,
          // PUBLIC, and the one fact that explains a redirect mismatch: the exact
          // string this attempt sent (the operation reports the one it used).
          redirectUri: typeof done.redirectUri === 'string' ? done.redirectUri : '',
        }))
      } catch (error) {
        // Kind-only: the message names a reason, never a code, state or secret.
        logger?.warn?.(callback.failed)
        return sendHtml(res, statusOf(error), completionPage({
          ok: false,
          message: error?.message ?? 'Login not completed.',
          // The typed failure CLASS and the public redirect make the page
          // actionable (424 = the provider/network refused; 400 = this request;
          // 404/503 = the local store). Neither is derived from a value.
          errorCode: typeof error?.code === 'string' ? error.code : '',
          // The REASON id and the provider's own bounded sentence: a class name
          // alone cannot distinguish a redirect mismatch from a rotated secret.
          errorReason: typeof error?.reasonKind === 'string' ? error.reasonKind : '',
          providerMessage: typeof error?.providerMessage === 'string' ? error.providerMessage : '',
          provider: callback.provider,
          // Prefer the redirect the OPERATION reports (the parked / derived value
          // it really sent). When the failure happened before that point, the
          // request-derived callback is still the honest public value.
          redirectUri: typeof error?.redirectUri === 'string' && error.redirectUri !== ''
            ? error.redirectUri
            : (redirectUriFor(origin, callback.path) ?? ''),
        }))
      }
    }

    const send = (status, payload) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      // The page's own scripts only; no cross-origin read path exists.
      res.setHeader('x-content-type-options', 'nosniff')
      res.end(JSON.stringify(payload))
    }
    const method = req.method === 'GET' || req.method === 'DELETE' ? req.method : 'POST'
    const key = action === '' ? 'GET state' : `${method} ${action}`
    const name = ROUTES[key] ?? (action === '' ? 'status' : undefined)
    if (action !== '' && name === undefined) return send(404, { ok: false, error: `unknown action: ${action}` })

    try {
      const body = method === 'GET' ? {} : await readJson(req)
      // The answer's own origin rides along on every read: the Gitea panel has to
      // render the exact redirect URI this deployment expects, in the guide text.
      const result = action === ''
        ? await operations.status({
          redirectUri: redirectUriFor(origin, GITEA_CALLBACK_PATH),
          cloudflareRedirectUri: redirectUriFor(origin, CLOUDFLARE_CALLBACK_PATH),
        })
        : await operations[name](body)
      return send(200, { ok: true, ...result })
    } catch (error) {
      // Kind-only: the message is already token-free by construction, and the
      // redaction pass is the guarantee that a provider error body cannot leak.
      const message = redact(`connector: ${error?.message ?? error}`)
      logger?.warn?.(message)
      // The CLASS travels with the sentence so a same-origin caller can render a
      // code-aware failure card without reading prose. Both facts are public
      // classifications: no value, no length, no fragment.
      return send(statusOf(error), {
        ok: false,
        error: message,
        ...(typeof error?.code === 'string' ? { code: error.code } : {}),
        ...(typeof error?.reason === 'string' ? { reason: error.reason } : {}),
      })
    }
  }
}

export { READ_ROUTES, WRITE_ROUTES, MIXED_ROUTES, ROUTES }
