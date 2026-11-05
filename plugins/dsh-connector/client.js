/**
 * dsh-connector — CLIENT half.
 *
 * One sidebar row (`sidebar.panellist`, id `connector`, order 21 — directly under
 * "Personal VM (CUA)" at 20) and one keyed `main` page (`key: 'connector'`).
 *
 * THE PAGE IS THE STATUS TAB, AND ONLY THAT (owner decision)
 * ---------------------------------------------------------
 * The page renders exactly one surface: the three provider cards with their
 * aliases, the credential REFERENCE each alias names, whether DSH resolves it,
 * the reference editor, and the Gitea base-URL form.
 *
 * Repository browsing, PR/issue/CI verbs and push were REMOVED from the page.
 * They remain fully available to the agent through the `connector_*` tools
 * (`connector_repos_list`, `connector_repo_actions`, `connector_file`,
 * `connector_push`) and to same-origin callers through `/api/connector/*`. The
 * page is not a second console: it exists to answer "which reference does this
 * alias use, and does it resolve?" and nothing else.
 *
 * CREDENTIALS IN, CREDENTIALS OUT — OAUTH ONLY (owner decision)
 * ------------------------------------------------------------
 * There is NO token paste field on this page, for any provider. The two moves
 * that touch a credential are:
 *
 *   * **Login** — a pure OAuth gesture, one per provider:
 *       - GitHub: `POST device/start` mints a code, the click opens
 *         github.com/login/device in a NEW TAB, and the poll loop
 *         (`POST device`) stores the token the moment the user approves. The
 *         device code never leaves the host.
 *       - Gitea: `POST oauth/start` mints a one-time `state` and an authorize
 *         URL; the click opens a tab and navigates it. The user authorizes on
 *         their own instance, Gitea redirects to this plugin's same-origin
 *         callback, the HOST exchanges the code (with the client secret resolved
 *         from its own reference at that moment) and stores the token.
 *       - Cloudflare: `POST oauth/cloudflare/start` mints a one-time `state` AND
 *         a PKCE S256 verifier (kept in the host's memory, never in the page).
 *         The click opens the dashboard's consent screen in a NEW TAB; Cloudflare
 *         redirects to this plugin's same-origin callback, the host exchanges the
 *         code at dash.cloudflare.com/oauth2/token with `code_verifier` and
 *         stores the access token AND its refresh token. The client the user
 *         registers is a PUBLIC client (`token_endpoint_auth_method: none`), so
 *         there is no client secret anywhere — one public Client ID and a scope
 *         list, both editable here, are the whole configuration.
 *   * **Logout** — the confirm "Do you want to logout?", then a FULL reset: the
 *     host aborts every pending flow for the provider, the reference is cleared
 *     with `DELETE /api/connector/credentials`, and the page drops its login slot
 *     wholesale (drafts, flow, code, guide). The poll timer dies with the slot, so
 *     no zombie "Waiting…" panel can survive a logout.
 *
 * The ONE secret this page can still ask for is the Gitea application CLIENT
 * SECRET — a password-type input with the same eye pattern, posted once to
 * `POST /api/connector/credentials`, answered with `{ ok, credentialRef }` and
 * unmounted immediately. Everything else it edits is PUBLIC configuration (a
 * client id, a credential REFERENCE name, a base URL).
 *
 * Nothing here is ever rendered, logged, put in a URL, persisted, or described:
 * no echo, no length, no trailing characters, no mask. After a login the page
 * re-reads `state`, so what the user sees is the store's own verdict (the badge),
 * not an assertion about the value.
 *
 * THE GITHUB DEVICE FLOW (Login → code → authorized, no paste)
 * ------------------------------------------------------------
 * GitHub's card adds a three-step login that never puts a token on screen:
 *
 *   1. **Client ID first.** The client id is a PUBLIC identifier (it travels in
 *      the verification URL and no client secret exists), so it lives in config —
 *      and the panel shows "Client ID: <id>" with an Edit control that swaps to
 *      the inline input. Without one it leads with the field rather than
 *      dead-ending on "not configured".
 *   2. **Start = a gesture.** The click handler opens the verification page in a
 * The client id is echoed freely; the token, the device code and any fragment of
 * either are not. No second application root, no iframe, no body append; theme
 * tokens only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-connector',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useMemo, useState } = React
    const h = React.createElement

    const PANEL_ID = 'connector'
    const NS = 'connector'

    /** Design tokens exactly as the theme plugin declares them. */
    const T = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      secondary: 'var(--dsw-alias-label-secondary, #9aa3ad)',
      caption: 'var(--dsw-alias-label-caption, #8b949e)',
      error: 'var(--dsw-alias-state-error-primary, #f28b82)',
      success: 'var(--dsw-alias-state-success-primary, #7ee787)',
      warning: 'var(--dsw-alias-state-warning-primary, #f0b849)',
      line: 'var(--dsw-alias-border-l3, rgba(255,255,255,.14))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))',
      accent: 'var(--dsw-alias-interactive-bg-hover-accent, rgba(43,127,255,.12))',
      info: 'var(--dsw-alias-button-info-fill, #4d6bfe)',
      brand: 'var(--dsw-alias-brand-primary, #111)',
      onBrand: 'var(--dsw-alias-label-primary-inverted, #fff)',
      radiusSm: 'var(--dsw-radius-sm, 6px)',
      radiusLg: 'var(--dsw-radius-lg, 10px)',
    }
    const S = {
      /**
       * THE SCROLL ROOT.
       *
       * The main slot is a flex column (`ui-layout` `.mainPanel` / `.centerCol`)
       * that clips its overflow: `overflow: hidden` on the column, no scroll
       * root of its own. A page that only grows therefore renders content that
       * is longer than the viewport and CANNOT BE REACHED — which is exactly
       * what happened to a long guide panel.
       *
       * Shipped pages solve it the same way: ui-schedule's `.pageScroll`
       * (`flex: 1; min-height: 0; overflow: auto`) and dsh-ssh's
       * `.tabBody` (`flex: 1; min-height: 0; overflow-y: auto`). This is that
       * contract — the page fills the slot, and the slot's content scrolls.
       *
       * `minHeight: 0` is load-bearing: without it a flex child refuses to
       * shrink below its content, the root grows past the column, and the
       * column's `overflow: hidden` clips instead of scrolling.
       */
      scroll: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        // Reserve the rail so a guide opening never shifts the layout sideways.
        scrollbarGutter: 'stable',
        width: '100%',
        color: T.text,
      },
      /** The content column INSIDE the scroller: centred, padded, never clamped. */
      page: { padding: '28px 24px 48px', display: 'grid', gap: 14, color: T.text, maxWidth: 1000, width: '100%', margin: '0 auto', boxSizing: 'border-box' },
      head: { display: 'grid', gap: 4 },
      title: { fontSize: 18, fontWeight: 600 },
      sub: { fontSize: 13, color: T.secondary },
      card: { padding: '12px 14px', borderRadius: T.radiusLg, border: `1px solid ${T.line}`, display: 'grid', gap: 8 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      button: {
        height: 28, padding: '0 10px', borderRadius: T.radiusSm, cursor: 'pointer', font: 'inherit',
        border: `0.5px solid ${T.line}`, background: 'transparent', color: T.text, fontSize: 12, fontWeight: 500,
      },
      primary: { height: 28, padding: '0 12px', borderRadius: T.radiusSm, cursor: 'pointer', font: 'inherit', border: 'none', background: T.brand, color: T.onBrand, fontSize: 12, fontWeight: 600 },
      input: { padding: '6px 8px', borderRadius: T.radiusSm, border: `1px solid ${T.line}`, background: 'transparent', color: T.text, font: 'inherit', fontSize: 13, minWidth: 0 },
      muted: { fontSize: 12, color: T.secondary },
      badge: (on) => ({
        fontSize: 11, padding: '1px 6px', borderRadius: 999,
        background: on ? T.accent : T.hover, color: on ? T.info : T.secondary,
      }),
      label: { display: 'grid', gap: 4, fontSize: 12, color: T.secondary },
    }

    /** Host calls: one JSON round trip, never cached by the browser. */
    async function api(path, body, method) {
      const verb = method ?? (body === undefined ? 'GET' : 'POST')
      const response = await fetch(`/api/connector/${path}`, {
        method: verb,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const payload = await response.json().catch(() => null)
      // A failed OPERATION surfaced through a route is a real request failure
      // (those routes answer `{ ok: false, error }` with a non-2xx status); only
      // an `error` string or a non-JSON body is treated as one here.
      if (payload === null || typeof payload?.error === 'string') {
        throw new Error(payload?.error ?? `HTTP ${response.status}`)
      }
      return payload
    }

    /**
     * The DISPLAY HINT for a GitHub user code — `XXXX-XXXX`.
     *
     * Display only, on purpose: the host returns whatever GitHub sent (today
     * already hyphenated, historically not), and that raw string is what
     * `navigator.clipboard` copies and what the poll path compares. This function
     * never rewrites the flow's value, it only draws it with one hyphen in the
     * middle, so an 8-character code reads as two 4-character groups.
     *
     * @param code - the raw `userCode` the host returned.
     * @returns the same characters, grouped for reading.
     */
    function formatUserCode(code) {
      const raw = String(code ?? '').trim().toUpperCase()
      const bare = raw.replace(/[^A-Z0-9]/gu, '')
      // Anything that is not a clean 8 characters is shown exactly as received:
      // guessing at a length this does not know would be worse than not helping.
      if (bare.length !== 8) return raw
      return `${bare.slice(0, 4)}-${bare.slice(4)}`
    }

    /** Strings. Registered under `connector`; falls back to the key itself. */
    const EN = {
      'panel': 'Connector',
      'page.title': 'Connector',
      'page.sub': 'Credential references for this workspace. Each alias names a DSH credential reference; the value never enters this page.',
      'status.providers': 'Providers',
      'status.resolved': 'resolved',
      'status.unresolved': 'not resolved',
      'status.noRef': '(no reference set)',
      'status.noAlias': 'This provider has no alias yet.',
      'status.setRef': 'Set reference',
      'status.editRef': 'Reference',
      'status.refPlaceholder': 'GITHUB_TOKEN',
      'status.refHint': 'A credential reference NAME that DSH resolves. Storing the credential itself happens in DSH, not here.',
      'status.manageHint': 'Manage the token in DSH credentials / environment.',
      'status.test': 'Test connection',
      'status.save': 'Save',
      'status.cancel': 'Cancel',
      'status.alias': 'Alias',
      'status.baseUrl': 'Base URL',
      'status.baseUrlHint': 'Self-hosted origin, e.g. https://git.example.com. Never carries a token.',
      'status.saveUrl': 'Save URL',
      'status.foot': 'This plugin stores credential REFERENCE names only. The credential values live in DSH — .credentials.yaml, the environment, or a .env — and are resolved per call:',
      'status.toolsHint': 'Repository, file, CI, issue and pull-request actions run through the connector_* agent tools, not this page.',
      'busy': 'Working…',
      'loading': 'Loading…',

      // ── card actions ─────────────────────────────────────────────────────
      'login': 'Login',
      'logout': 'Logout',
      'logoutConfirm': 'Do you want to logout?',
      'login.confirmLogout': 'Do you want to logout?',
      'logout.done': 'Logged out — the stored credential and any pending login are gone.',
      'login.guide': 'Guide',
      'login.saved': 'Signed in — the token is stored and the reference resolves.',
      'login.cleared': 'Token cleared from the DSH store.',
      'login.success': 'Signed in — the token is stored and the reference resolves.',
      'login.saving': 'Saving…',
      'login.cancel': 'Cancel',
      'login.start': 'Start login',
      'login.instructions.github': 'Login opens github.com/login/device in a new tab and shows a code; approve it there and this card saves the token itself.',
      'login.instructions.gitea': 'Login opens your Gitea instance in a new tab; authorize the application there and the token is saved automatically.',
      'login.instructions.cloudflare': 'Login opens the Cloudflare consent screen in a NEW TAB. This deployment uses a PKCE OAuth client you register (public, no secret): the browser grants the access token and its refresh token, and this host stores both.',

      // ── client id / secret editors ───────────────────────────────────────
      'clientId': 'Client ID',
      'clientIdEdit': 'Edit',
      'clientIdLabel': 'Client ID:',
      'clientIdHint': 'The public "Client ID" of your GitHub OAuth App (github.com/settings/developers). Public configuration — the device flow uses no client secret.',
      'clientIdPlaceholder': 'Iv1.0123456789abcdef',
      'saveClientId': 'Save Client ID',
      'clientIdSaved': 'Client ID saved. Start the device flow.',
      'cf.clientIdSaved': 'Cloudflare Client ID saved. Press Login to authorize.',
      // The per-provider save acks the code asks for by their own keys.
      'login.clientIdSaved': 'Client ID saved. Start the device flow.',
      'gitea.clientIdSaved': 'Client ID saved. Press Login to authorize.',
      'cf.edit': 'Edit',
      'cancelEdit': 'Cancel',
      'secretSaved': 'Saved — a client secret is stored.',
      'secretHint': 'The application client secret. Stored once in DSH under its own reference and used only for the token exchange; it is never shown again.',
      'secretPlaceholder': 'client secret',
      'secretSave': 'Save secret',
      'secretReplace': 'Replace',
      'secretNeeded': 'This application needs its client secret before it can exchange a code.',
      'showToken': 'Show',
      'hideToken': 'Hide',

      // ── GitHub device flow ───────────────────────────────────────────────
      'login.clientIdNeeded': 'Paste your OAuth App Client ID first to start the device flow.',
      'login.device.start': 'Start device flow',
      'login.device.code': 'Enter this code at',
      'login.device.waiting': 'Waiting for approval…',
      'login.device.expiry': 'The code expires 15 minutes after it was issued; start again for a fresh one.',
      'login.copy': 'Copy',
      'login.copied': 'Copied',
      'login.copyFailed': 'Copy failed — select the code and copy it manually',
      'login.openManual': 'Open github.com/login/device',
      'login.autoOpened': 'Opened github.com/login/device in a new tab. If it was blocked, use the link below.',
      'login.expired': 'The code expired. Start the device flow again.',
      'login.denied': 'The authorization was denied at GitHub. You can start again.',

      // ── Gitea authorization-code flow ────────────────────────────────────
      'gitea.clientId': 'Application Client ID',
      'gitea.clientSecret': 'Application Client Secret',
      'gitea.authorizing': 'Authorizing — after you approve in the tab that opened, this finishes automatically: the tab closes itself and this card turns resolved.',
      'gitea.openManual': 'Open the Gitea authorize page',
      'gitea.blocked': 'The new tab was blocked. Use the link above to continue.',
      'gitea.baseUrlNeeded': 'Set the Gitea base URL on this card first.',
      'oauthComplete': 'Login complete — the token is stored and the reference resolves.',

      // ── guides ───────────────────────────────────────────────────────────
      'guide.redirectGithub': 'Authorization callback URL / Redirect URI: {origin} — GitHub requires it non-blank; the device flow never uses it.',
      'guide.redirectGitea': 'Authorization callback URI: {callback} — copy it exactly; the plugin exchanges the code on this same origin.',
      'login.guide.github.title': 'GitHub — OAuth App + device flow',
      'login.guide.github.steps': [
        'Open github.com/settings/developers (avatar → Settings → Developer settings → OAuth Apps) and press "New OAuth App".',
        'Form fields, verbatim: "Application name" (anything you recognise, e.g. DSH Connector); "Homepage URL" (this DSH GUI origin, e.g. http://127.0.0.1:3079); "Application description" (optional).',
        '"Authorization callback URL" (the app page also calls it the Redirect URI; max 10 registered, "Add callback URL" adds more): fill {origin} — this deployment\'s origin. It must EXACTLY match the origin this page is served from at authorize time; http://127.0.0.1:<port> is accepted for loopback, and the device flow never uses it.',
        'Tick "Enable Device Flow" — REQUIRED. The device grant then answers with verification_uri https://github.com/login/device, an 8-character user_code (XXXX-XXXX), expires_in 900 s and interval 5 s.',
        '"Expire user access tokens" is checked by default: with it ON an access token lives 8 hours and a refresh token 6 months — this plugin stores BOTH, silently refreshes ONCE when GitHub rejects the expired access token, and only asks you to Login again if the refresh itself is refused; with it OFF you get a long-lived token that never expires. ON is recommended.',
        'Press "Register application". The "Client ID" is at the top of the app page; NO client secret is needed for the device flow.',
        'Back on this card press Login: with no Client ID yet, the panel shows "Client ID:" with an Edit control — paste the id, press Save.',
        'The primary action becomes "Start device flow". Press it: the code appears LARGE and github.com/login/device opens in a NEW TAB.',
        'If no tab opened (a popup blocker), press the "Open github.com/login/device" link instead; Copy puts the code on your clipboard. The code expires 15 minutes after it is issued — start again for a fresh one.',
        'Enter the code at github.com/login/device and press "Authorize".',
        'The plugin saves the token by itself — the panel closes, a short success note appears and the badge turns resolved.',
      ],
      'login.guide.github.note': 'Login is OAuth only: there is no token field anywhere. Swapping apps is the same panel — press Edit beside "Client ID:", paste the new id, Save, then Start device flow; the previous app\'s login is abandoned the moment the change lands.',
      'login.guide.gitea.title': 'Gitea — OAuth2 application',
      'login.guide.gitea.steps': [
        'Make sure the Base URL on this card is your instance origin, e.g. https://git.example.com.',
        'Open {base}/user/settings/applications — the SELF-SERVICE path on the account that will authorize. (Site Administration → Applications is the site-wide admin path; the user path is the one to use.)',
        'Press "Create OAuth2 Application". Fields: "Application Name" (e.g. DSH Connector); "Redirect URI(s)" — an array, each entry matched EXACTLY.',
        'Redirect URI: {callback} — copy it exactly. Use the 127.0.0.1 form this page shows, not "localhost" (RFC 8252 §8.3 recommends the loopback IP; Gitea matches the string).',
        'Tick "Confidential client": this plugin is a confidential client — the code exchange sends its client secret. Untick it and the exchange has no secret and will be refused.',
        'Press Create, then copy the generated Client ID and Client Secret. The secret is shown ONLY once: if you lose it, regenerate the application; this plugin stores it under GITEA_CLIENT_SECRET.',
        'Back on this card press Login: the panel shows "Application Client ID" and "Application Client Secret" — save both (the secret goes into DSH under its own reference and is never shown again).',
        'Press Login again: your Gitea instance opens in a NEW TAB where you must already be signed in.',
        'Press "Authorize" on that page. The plugin exchanges the code at {base}/login/oauth/access_token (POST: client_id, client_secret, code, grant_type=authorization_code, redirect_uri) and writes the token to GITEA_TOKEN.',
        'The tab shows "Login complete", closes ITSELF (the Login click opened it, so the browser allows it), and this panel closes too while the badge turns resolved — no Cancel click, no coming back.',
      ],
      'login.guide.gitea.note': 'You must be logged into Gitea in the SAME browser: the browser is what authorizes the application. If the tab lands on a login page, sign in there and the redirect continues to the callback. Scopes: this client asks for what the connector uses (repository and issue access); Gitea versions before 1.23 have no scope picker and grant full access to the authorizing account.',
      'login.guide.cloudflare.title': 'Cloudflare — register an OAuth client, then authorize',
      'login.guide.cloudflare.steps': [
        'In THIS Login panel, set "Callback origin" to the HTTPS origin your browser uses (origin only, no path — e.g. https://seek-harness.dfm.homes) and press Save. It is the same value as the cloudflareCallbackOrigin setting in the plugin config. Your reverse proxy must forward /api/connector/… to this harness, otherwise the redirect never reaches the plugin.',
        'In the OAuth client\'s "Redirect (Callback) URLs" register EXACTLY {redirect} — no trailing slash, correct scheme (https, never http on a public host). That is the string this panel shows and the string the authorize call sends.',
        'In the Cloudflare dashboard select your account, then go to Manage Account → OAuth clients → "Create client".',
        'Fields, verbatim: "Client Name" (anything you recognise); "Response type" → keep Code; "Grant type" → Authorization Code, and ADD Refresh Token so the refresh and the logout revoke actually work.',
        '"Token authentication method" → "None (PKCE)". This is the desktop/CLI public client: Cloudflare then REQUIRES PKCE with S256 (43–128-char verifier from [A-Za-z0-9-._~], challenge = BASE64URL(SHA256(verifier)), which this host mints per attempt). There is NO client secret to enter or store.',
        '"Redirect (Callback) URLs" → {redirect} — exactly this, built from the origin in your address bar. Cloudflare accepts HTTPS, or HTTP only for hosts whose suffix is exactly `localhost` (http://localhost:<port>); http://127.0.0.1:<port> is NOT a localhost suffix and is refused.',
        'Start Login from the tab whose origin matches BOTH: (a) one of the OAuth client\'s registered redirect URLs and (b) HTTPS (or http://localhost:<port>). If your 127.0.0.1:3079 tab fails with insecure-protocol, switch to your https domain tab and press Login there, or set cloudflareCallbackOrigin to the https origin.',
'In "Select permission scopes" tick EXACTLY these 20 ids — all of them exist in the catalogue as refreshed on 2026-11-04: page.write, page.read, dns.write, dns.read, zone.read, zone.write, zone-settings.read, zone-settings.write, zone-waf.read, zone-waf.write, ddos-protection.read, http-ddos-managed-ruleset.read, account-firewall-access-rules.read, account-firewall-access-rules.write, account-rule-lists.read, account-rule-lists.write, config-settings.read, config-settings.write, analytics.read — plus offline_access, which is protocol-only and added by the Refresh Token grant. The dashboard labels the first pair "Pages Write (page.write)" and "Pages Read (page.read)" under Developer Platform, and those ids are SINGULAR: pages.write / pages.read are not valid ids and are rejected with invalid_scope. "Zone Settings Read/Write" is its own entry under DNS & Zones: config-settings.read does NOT unlock /zones/{id}/settings. An Account-wide scope is never requested: not every account exposes one, and the Pages calls are account-scoped by PATH. Live catalogue: GET https://api.cloudflare.com/client/v4/oauth/scopes.',
        'If a needed id is MISSING from that picker, refresh the client edit page: Cloudflare\'s catalogue grew recently — zone-settings.* and account-firewall-access-rules.* appeared after 2026-11-04 — and a client created before that date can show only the old set until the page is reloaded. If the ids are still absent, attach them with PATCH /client/v4/accounts/{account_id}/oauth_clients/{client_id} (Select permission scopes) or recreate the client.',
'A client that grants only PART of that list still logs in: the action whose scope is missing answers 403, surfaced as a typed "scope not granted on this OAuth token" that NAMES the id — /zones/{id}/settings wants zone-settings.read (zone-settings.write to edit), access rules want account-firewall-access-rules.read/.write, the DDoS L7 entry point wants ddos-protection.read AND http-ddos-managed-ruleset.read, DNS wants dns.read/.write, WAF wants zone-waf.read/.write, analytics wants analytics.read. Edit the client, re-consent, and the action starts working — no code change.',
        'offline_access needs no ticking: with Grant type = Authorization Code + Refresh Token it is added automatically and appears under "Other" (it is a protocol scope, not a permission). Connector requests it in the authorize call so the server issues a refresh token.',
        'If that step shows no Pages entries (only a condensed Developer Platform set such as workers-scripts.*), the client cannot request page.*: the account needs the OAuth-client permission role, or attach the scopes from the client\'s edit form (Select permission scopes) or with PATCH /client/v4/accounts/{account_id}/oauth_clients/{client_id}. There is no separate client "type" and no documented plan gate — every self-managed client uses the same scope catalogue.',
        'Copy the "Client ID" shown after creation (a secret appears only when the auth method is not None) and paste it into the field below; press Save — the pencil reopens it later, it is public configuration.',
        'Press Login: the consent screen opens in a NEW TAB at https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=…&redirect_uri=…&scope=…&state=…&code_challenge=…&code_challenge_method=S256. You must already be signed in to dash.cloudflare.com in THAT browser.',
        'Pick the account, review the permissions, press Authorize. Cloudflare redirects to this plugin\'s callback; the host exchanges the code at https://dash.cloudflare.com/oauth2/token (grant_type=authorization_code, client_id, code_verifier, redirect_uri; no secret) and stores the access token (CLOUDFLARE_API_TOKEN) plus the refresh token (CLOUDFLARE_REFRESH_TOKEN).',
        'The tab shows "Login complete" and closes itself; this panel closes on its own and the badge turns resolved. Press Test connection: it calls GET https://api.cloudflare.com/client/v4/user/tokens/verify and reports the token status.',
        'Analytics and Security Events are ONE permission: Analytics Read (analytics.read), ticked on the OAuth client AND granted on the zone being queried. If a query is refused with "zone does not have access to the path", re-consent with Analytics Read ticked at the consent screen; the old REST analytics endpoints were retired in 2021 and Connector does not fall back to them.',
        'DDoS L7 overrides: GET /zones/{zone}/rulesets/phases/ddos_l7/entrypoint answers 404 when the zone has no overrides yet — that means the managed defaults are active, not that anything failed. The FIRST override is a PUT to that same URL with rules:[{action:"execute",expression:"true",action_parameters:{id:"<HTTP_MANAGED_RULESET_ID>",overrides:{…}}}], and it needs http-ddos-managed-ruleset.write — an add-on id to tick separately (the read uses the .read half already in the list).',
        'Pausing a custom WAF rule is a PATCH to /zones/{zone}/rulesets/{ruleset_id}/rules/{rule_id} carrying enabled:false, and because the rule PATCH docs require expression and action, Connector replays the rule\'s unchanged pair from the live rule first. There is no skip action and no ETag; every mutation bumps the ruleset version.',
        'Access rules are account-scope whatever the tool\'s scope argument says: Cloudflare gates the zone path with Account Firewall Access Rules Read/Write too, so with an OAuth login Connector calls /accounts/{account_id}/firewall/access_rules/rules for BOTH scopes. The zone id is informational and the list you see is the whole account.',
      ],
      'login.guide.cloudflare.note': 'If the consent screen refuses with invalid_scope, the callback tab names the missing scope and where to add it (client edit → Select permission scopes → the page.* entries); the panel\'s Scopes block shows the same list. Why PKCE and no secret: a self-hosted app cannot keep a client secret, so the OAuth client is registered as a public client (auth method none) and every login mints a fresh verifier. The access token is short-lived: when the API answers 401, this host refreshes it ONCE with the stored refresh token (CLOUDFLARE_REFRESH_TOKEN) and retries; a refused refresh clears both references so the card asks for Login again. Wrangler is Cloudflare\'s own first-party client with a fixed localhost callback and is not reused here; for CLI workflows `npx wrangler login` still works, and a push inside DSH uses the OAuth token you just stored (subprocess env, never argv). One more diagnostic: opening the callback URL by hand (no code, no state) answers a "no authorization code" page from THIS plugin; if you see the harness\'s own "route does not exist" page instead, the browser is not reaching this harness at all (another app on that vhost, or a proxy that does not forward /api/connector), and only a real provider redirect round-trip can complete a login.',
      'cf.setupTitle': 'OAuth client (public, PKCE S256 — no client secret)',
      'cf.setupHint': 'Register a client under Manage Account → OAuth clients, then paste its public Client ID here. These two fields are configuration, not credentials.',
      'cf.clientIdLabel': 'Client ID',
      'cf.clientIdHint': 'Public identifier: it travels in the authorize URL. An auth-method "none" client has no secret, so there is none to store.',
      'cf.scopesLabel': 'Scopes',
      'cf.scopesHint': 'Space-separated dot-form ids (singular: page.read, page.write), and every one must ALSO be allowed by your OAuth client — Cloudflare rejects the rest with invalid_scope. offline_access is a protocol scope: the Refresh Token grant adds it automatically. Live catalogue: GET /client/v4/oauth/scopes.',
      'cf.scopesDefault': 'Scopes → Edit — Connector requests these by default: {scopes}. Tick EXACTLY this list on the OAuth client; zone settings need zone-settings.read, access rules need account-firewall-access-rules.read, and the DDoS L7 entry point needs ddos-protection.read + http-ddos-managed-ruleset.read.',
      'cf.scopesSaved': 'Scopes saved. Press Login to authorize with the new list.',
      'cf.originTitle': 'This origin needs one fix before Cloudflare can accept it.',
      'cf.originCurrent': 'Current origin: {origin} — Cloudflare only accepts HTTPS redirects, or HTTP for hosts ending in localhost.',
      'cf.originSuggested': 'Open {suggested} in this browser and press Login there. That origin must resolve and be one of the OAuth client\'s registered redirect (callback) URLs.',
      'cf.originApproved': 'Cloudflare will send the browser back to {redirect} — that is the redirect this login uses.',
      'cf.originOverride': 'Or set cloudflareCallbackOrigin to that HTTPS origin in the plugin settings.',
      'cf.redirectLabel': 'Redirect URI to register on the client',
      'cf.redirectHint': 'Rendered from this deployment\'s own origin. Cloudflare compares it exactly, so register this string as-is.',
      'cf.authorizing': 'Waiting for Cloudflare — choose the account and press Authorize in the tab that opened; it finishes automatically there, the tab closes itself and this card turns resolved.',
      'cf.blocked': 'If no tab opened (pop-up blocked) use the address above; it must be the SAME browser, already signed in to the Cloudflare dashboard.',
      'cf.manualLink': 'Open the Cloudflare authorize page',
      'cf.checkStatus': 'Check status',
      'cf.saved': 'Signed in — the access token and its refresh token are stored and the reference resolves.',
      'cf.originHostDerived': 'The host derived {derived} from the request it received and judged it unusable for Cloudflare. This tab is {origin}; an HTTPS tab is used exactly as the address bar shows it, and if Cloudflare still refuses, set Callback origin below to the origin registered on your OAuth client.',
      'cf.redirectUnavailable': 'Cannot derive a redirect from this tab — set Callback origin below',
      'cf.redirectFromOverride': 'Built from your saved Callback origin. Cloudflare compares it character for character, so the OAuth client must list it as-is.',
      'cf.redirectFromTab': 'Built from this tab\'s address bar, and this is exactly what the authorize call sends. Register this string on the OAuth client as-is.',
      'cf.redirectNoneHint': 'Set Callback origin below (origin only, e.g. https://your-domain.example) and this line becomes the exact URL to register on the OAuth client.',
      'cf.callbackOriginLabel': 'Callback origin',
      'cf.callbackOriginHint': 'Origin only, no path — the plugin appends /api/connector/oauth/cloudflare/callback. Set it when this harness sits behind a reverse proxy that cannot report the browser\'s scheme, and register the resulting URL on the OAuth client. Same value as the cloudflareCallbackOrigin setting.',
      'cf.callbackOriginDerived': '(derived from this tab)',
      'cf.callbackOriginClearHint': 'Clear the field and press Save to fall back to this tab\'s own origin.',
      'cf.callbackOriginSaved': 'Callback origin saved. Press Login to authorize with it.',
      'cf.startErrorTitle': 'Login did not start.',
      'cf.startErrorOrigin': 'This tab cannot be a Cloudflare redirect (HTTPS, or HTTP only for hosts ending in localhost). Current origin:',
      'cf.startErrorNoOrigin': 'This host cannot tell which origin the page is on.',
      'cf.startErrorOriginHint': 'Nothing was opened. Set Callback origin below to your HTTPS domain (origin only, e.g. https://your-domain.example), press Save, then press Login again.',
    }
    /**
     * Strings — ENGLISH ONLY (owner decision).
     *
     * The bundle carries ONE dictionary. There is no language switch, no second
     * table and no fallback chain: every string is read straight from `EN`, and a
     * key that is missing renders as the key itself so a regression is visible in
     * the UI instead of silently blanking.
     *
     * The `locale` service is still subscribed to — a host may replace the
     * registered dictionary at runtime — but the answer never depends on which
     * language the host has selected. This is deliberate: the page is English, in
     * every deployment.
     */
    function useTranslate(locale) {
      const [revision, setRevision] = useState(0)
      useEffect(() => {
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setRevision(value => value + 1))
      }, [locale])
      return useMemo(() => (key) => EN[key] ?? key, [revision])
    }

    const PROVIDER_LABEL = { github: 'GitHub', cloudflare: 'Cloudflare', gitea: 'Gitea' }

    /** Instructions per provider, as the key suffix. */
    const INSTRUCTIONS_KEY = {
      github: 'login.instructions.github',
      cloudflare: 'login.instructions.cloudflare',
      gitea: 'login.instructions.gitea',
    }

    /**
     * One provider card.
     *
     * BUTTONS ARE DYNAMIC (owner decision). The row is
     *
     *   resolved   → [Logout] [Test connection] [Reference]
     *   unresolved → [Login]  [Test connection] [Reference]
     *
     * Login is OAuth ONLY: there is no token field anywhere on this page. GitHub
     * runs its device flow; Gitea and Cloudflare run authorization-code flows
     * through their same-origin callbacks (Cloudflare additionally uses PKCE S256
     * with a public, secret-less client).
     *
     * Logout is a FULL reset, and the reset is the point: the value is unset in
     * DSH, the host drops every flow for the provider, any in-flight poll timer is
     * cancelled and the panel state (client-id draft, secret draft, flow, guide)
     * is cleared wholesale, so the card re-renders as if the page were fresh — and
     * a device-flow box cannot survive as a zombie "Waiting…" panel.
     */
    function ProviderCard({ provider, data, t, onChanged, device, oauth, oauthCloudflare, secret, openLogin, setOpenLogin, login, setLogin, origin }) {
      const [open, setOpen] = useState(false)
      const [alias, setAlias] = useState(data?.defaultAlias ?? 'default')
      const [refDraft, setRefDraft] = useState('')
      const [baseUrl, setBaseUrl] = useState(data?.baseUrl ?? '')
      const [busy, setBusy] = useState(null)
      const [local, setLocal] = useState(null)
      // The Client ID drafts are PUBLIC configuration: plain card state, never
      // masked, cleared after a successful save. They are NOT part of the login
      // slot, so a card can show them without opening a login.
      const [clientIdDraft, setClientIdDraft] = useState('')
      const [clientIdEditing, setClientIdEditing] = useState(false)
      // Once a secret is stored the INPUT is gone; "Replace" brings it back, so
      // swapping a rotated application secret is still one click.
      const [secretEditing, setSecretEditing] = useState(false)
      // The Gitea client SECRET is the ONE secret this page can still ask for, and
      // it lives in the login slot like every other flow value.
      const [copyState, setCopyState] = useState(null)

      // ── login state ──
      // The OPEN slot lives in StatusTab, not here: at most one card on the page
      // may hold an open login. This card only asks "is it mine?" and renders.
      const loginFor = openLogin !== null && openLogin.provider === provider ? openLogin.alias : null
      const mine = loginFor !== null
      const guideOpen = mine ? (login?.guideOpen === true) : false
      const setGuideOpen = (next) => setLogin(current => current === null ? current : { ...current, guideOpen: next })
      const revealed = mine ? (login?.revealed === true) : false
      const secretDraft = mine ? (login?.secretDraft ?? '') : ''
      const tokenError = mine ? (login?.error ?? null) : null
      const flow = mine ? (login?.flow ?? null) : null
      const oauthPending = mine ? (login?.oauthPending === true) : false
      // The URL the host actually minted for THIS attempt (state + challenge).
      // It is the only correct fallback for a blocked popup: a bare endpoint URL
      // would fail at Cloudflare with no state.
      const cfAuthorize = mine ? (login?.cfAuthorize ?? '') : ''
      const setSecretDraft = (next) => setLogin(current => current === null ? current : { ...current, secretDraft: next })
      const setRevealed = (next) => setLogin(current => current === null ? current : { ...current, revealed: typeof next === 'function' ? next(current.revealed === true) : next })
      const setError = (next) => setLogin(current => current === null ? current : { ...current, error: next })
      const setFlow = (next) => setLogin(current => current === null ? current : { ...current, flow: typeof next === 'function' ? next(current.flow) : next })
      const setOauthPending = (next) => setLogin(current => current === null ? current : { ...current, oauthPending: next })
      // The typed verdict of the LAST Cloudflare Login press: `{ kind, message }`
      // where kind is 'origin' | 'host' | null. It lives in the login slot beside
      // the other flow values, so closing the panel clears it.
      const cfStartError = mine ? (login?.cfStartError ?? null) : null
      const setCfStartError = (next) => setLogin(current => current === null ? current : { ...current, cfStartError: next })

      const aliases = data?.aliases ?? []
      // The dynamic-button predicate: does THIS provider's credential resolve?
      const anyResolved = aliases.some(row => row.resolved === true)
      // Every provider's Login is a real gesture now, so the only thing that
      // disables it is a request already in flight.
      const loginDisabled = busy !== null
      const instructions = INSTRUCTIONS_KEY[provider] ?? 'login.instructions.github'

      // The GitHub device flow is offered only where the host says it can finish one.
      const deviceReady = provider === 'github' && device?.supported === true
      const hasClientId = device?.clientIdConfigured === true || device?.supported === true
      const canSaveClientId = (provider === 'gitea' ? oauth : device)?.canSaveClientId === true

      // Gitea's authorization-code predicate, straight from the host.
      const oauthReady = provider === 'gitea' && oauth?.ready === true
      const secretStored = secret?.resolved === true
      const giteaClientIdConfigured = oauth?.clientIdConfigured === true
      const giteaClientId = typeof oauth?.clientId === 'string' ? oauth.clientId : ''

      /**
       * THE ORIGIN THIS PAGE IS ACTUALLY ON — read from the BROWSER.
       *
       * `window.location.origin` is the ONLY party that knows the address bar. The
       * host's answer (`report.oauth.redirectUri`) is derived from the request it
       * saw, and behind a reverse proxy that request is whatever the proxy chose
       * to forward: a plain-http `Host`, a stripped `x-forwarded-proto`, an
       * internal port. Trusting it for DISPLAY produced the reported bug — an
       * https tab told "Current origin: http://…, this tab cannot complete a
       * login" — and it also made the panel print a redirect URI different from
       * the one the browser would come back to.
       *
       * So: display and the redirect this page SENDS come from the browser, the
       * host's value is only a fallback for a bundle running without `location`
       * (a unit test, a headless sandbox), and the server keeps its own
       * proxy-aware derivation for anything it builds without a request.
       */
      const browserOrigin = (() => {
        try {
          const value = globalThis.location?.origin
          if (typeof value !== 'string' || value === 'null') return ''
          const trimmed = value.replace(/\/+$/u, '')
          return /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(trimmed) ? trimmed : ''
        } catch {
          return ''
        }
      })()
      const pageOrigin = browserOrigin !== '' ? browserOrigin : (typeof origin === 'string' ? origin : '')
      // The exact redirect URI this deployment expects — rendered in the guide.
      // Built from the page origin, because that is what the browser will send.
      const giteaCallbackPath = '/api/connector/oauth/gitea/callback'
      const callbackUri = pageOrigin !== '' ? `${pageOrigin}${giteaCallbackPath}` : ''

      // The Gitea instance origin, for the guide's self-service URL and the token
      // exchange line. Public, and empty when the card has not been configured.
      const giteaBase = typeof oauth?.authorizeBase === 'string' && oauth.authorizeBase !== ''
        ? oauth.authorizeBase
        : (typeof data?.baseUrl === 'string' ? data.baseUrl : '')

      // ── Cloudflare: a PUBLIC PKCE client, no secret, dashboard endpoints ──
      // Everything here is configuration, never a credential: the client id and
      // the scope list both travel in the authorize URL.
      const cf = oauthCloudflare ?? null
      const cfClientId = typeof cf?.clientId === 'string' ? cf.clientId : ''
      const cfScopesText = typeof cf?.scopesText === 'string' ? cf.scopesText : ''
      const cfAuthorizeUrl = typeof cf?.authorizeUrl === 'string' && cf.authorizeUrl !== ''
        ? cf.authorizeUrl
        : 'https://dash.cloudflare.com/oauth2/auth'
      const cfCanSave = cf?.canSaveSettings === true
      const cfReady = cf?.ready === true
      // The non-secret override, as saved in the profile patch (or '').
      const cfOriginOverride = typeof cf?.callbackOriginConfigured === 'string' ? cf.callbackOriginConfigured : ''
      const cfCallbackPath = typeof cf?.callbackPath === 'string' && cf.callbackPath !== ''
        ? cf.callbackPath
        : '/api/connector/oauth/cloudflare/callback'
      /**
       * THE ORIGIN FACTS, parsed WITHOUT `URL` (the bundle runs in places that do
       * not expose it). Cloudflare refuses an http redirect unless the host's
       * suffix is exactly `localhost`, so a page reached on http://127.0.0.1:<port>
       * can never complete a login — the panel says so BEFORE the click, and the
       * suggested HTTPS origin is DISPLAY TEXT ONLY (nothing is redirected to it
       * silently; the user must open it, because it has to resolve and be
       * registered on the OAuth client).
       */
      const originFacts = (() => {
        const text = typeof pageOrigin === 'string' ? pageOrigin.replace(/\/+$/u, '') : ''
        const match = /^(https?):\/\/([^/:?#]+)(?::(\d{1,5}))?$/u.exec(text)
        if (match === null) return { text, scheme: '', insecure: false, suggested: '', accepted: false }
        const [, scheme, host] = match
        const localhost = /(^|\.)localhost$/iu.test(host)
        const insecure = scheme === 'http' && !localhost
        return {
          text,
          scheme,
          insecure,
          suggested: insecure ? text.replace(/^http:/u, 'https:') : '',
          // What Cloudflare would accept for a redirect from this tab.
          accepted: scheme === 'https' || localhost,
        }
      })()
      /**
       * THE REDIRECT THIS LOGIN WILL USE, and where it comes from.
       *
       * Precedence mirrors the host exactly (`cloudflareCallbackTarget`):
       *   1. the non-secret `cloudflareCallbackOrigin` override;
       *   2. THIS TAB's origin, when Cloudflare would accept it (https, or
       *      http on a localhost suffix);
       *   3. nothing usable — the panel says so instead of printing a URL that
       *      cannot work.
       *
       * The value built here is ALSO the value sent to `oauth/cloudflare/start`,
       * so what the panel shows is what the authorize call carries. The host
       * parks it in the state entry and repeats it at the token exchange, which
       * makes the round-trip exact even when a proxy rewrites the Host.
       */
      const cfRedirectOrigin = cfOriginOverride !== ''
        ? cfOriginOverride
        : (originFacts.accepted ? pageOrigin : '')
      const cfRedirectSource = cfOriginOverride !== '' ? 'configured' : (cfRedirectOrigin !== '' ? 'tab' : 'none')
      const cfRedirect = cfRedirectOrigin !== '' ? `${cfRedirectOrigin}${cfCallbackPath}` : ''
      // The host's own derivation rejected the request it saw (a proxy that did
      // not forward https). Worth SAYING, even when this https tab can proceed.
      const cfHostRejected = cf?.callbackOriginAccepted === false
      const cfHostDerived = typeof cf?.redirectUri === 'string' ? cf.redirectUri : ''
      /**
       * Whether the ORIGIN needs attention at all.
       *
       * A saved Callback origin answers the question by itself, so the warning is
       * suppressed once it is configured: there is nothing left to fix, and a
       * permanent banner over a working login is noise. With no override, an http
       * non-localhost tab or a host that rejected its own derivation both raise it.
       */
      const cfOriginProblem = cfRedirectSource === 'configured'
        ? ''
        : (originFacts.insecure ? 'insecure' : (cfHostRejected ? 'host-rejected' : ''))
      // Scopes are card-local editing state: they are public configuration, not a
      // secret, so they do NOT live in the login slot.
      const [cfScopesEditing, setCfScopesEditing] = useState(false)
      const [cfScopesDraft, setCfScopesDraft] = useState('')
      // The Callback-origin field is the same non-secret setting as the config
      // entry, editable where the user needs it (inline, in the Login panel).
      const [cfOriginEditing, setCfOriginEditing] = useState(false)
      const [cfOriginDraft, setCfOriginDraft] = useState('')
      const [cfOriginNote, setCfOriginNote] = useState(null)

      /**
       * Forget everything about the login. Closing the slot IS the reset: the
       * secret draft, the reveal flag, the flow, the pending flag and its error
       * all live inside it, so nothing is left for the next open to inherit.
       */
      const resetLogin = () => {
        setLogin(null)
        setOpenLogin(null)
        setCopyState(null)
        setSecretEditing(false)
      }

      // Opening the editor prefills the alias's CURRENT reference name. That is a
      // name like GITHUB_TOKEN — configuration, never a credential.
      const startEdit = (row) => {
        setAlias(row?.alias ?? (data?.defaultAlias ?? 'default'))
        setRefDraft(row?.credentialRef ?? '')
        setOpen(true)
        setLocal(null)
      }

      const saveRef = async () => {
        const ref = refDraft.trim()
        if (ref === '' || alias.trim() === '') return
        setBusy('save')
        setLocal(null)
        try {
          const result = await api('ref', { provider, alias: alias.trim(), credentialRef: ref })
          setOpen(false)
          setLocal(result.resolved
            ? `${result.credentialRef} ${t('status.resolved')}`
            : `${result.credentialRef} ${t('status.unresolved')}`)
          await onChanged()
        } catch (error) {
          setLocal(String(error?.message ?? error))
        } finally {
          setBusy(null)
        }
      }

      const saveUrl = async () => {
        setBusy('url')
        setLocal(null)
        try {
          await api('settings', { giteaUrl: baseUrl })
          setLocal(t('status.saveUrl'))
          await onChanged()
        } catch (error) {
          setLocal(String(error?.message ?? error))
        } finally {
          setBusy(null)
        }
      }

      const test = async (row) => {
        setBusy(`test:${row.alias}`)
        setLocal(null)
        try {
          const result = await api('test', { provider, alias: row.alias })
          setLocal(result.detail)
        } catch (error) {
          setLocal(String(error?.message ?? error))
        } finally {
          setBusy(null)
        }
      }

      /**
       * LOGOUT — the confirm, then a FULL reset.
       *
       * Three things happen, in this order, and the order matters:
       *   1. the host drops every pending flow for this provider BEFORE the store
       *      write, so a poll already on the wire fails closed instead of storing a
       *      token for a login the user just ended;
       *   2. the reference is unset in DSH (`DELETE /credentials`);
       *   3. the page clears the login slot wholesale and re-reads `state`.
       *
       * The local slot is cleared in `finally` even when the delete fails, because
       * "the user pressed Logout" means the panel and its timers are gone either
       * way — a stale code sitting in a box is the worse failure.
       */
      const logout = async (row) => {
        const question = t('logoutConfirm')
        const confirmed = typeof globalThis.confirm === 'function' ? globalThis.confirm(question) : true
        if (!confirmed) return
        setBusy(`logout:${row.alias}`)
        setLocal(null)
        try {
          // 1. Abort host-side flows first (best effort: a host that does not
          // know the route must not block the logout).
          await api('device/abort', { provider, alias: row.alias }).catch(() => null)
          // 2. The credential itself.
          await api('credentials', { provider, alias: row.alias }, 'DELETE')
          setLocal(t('logout.done'))
        } catch (error) {
          setLocal(String(error?.message ?? error))
        } finally {
          // 3. The page side, unconditionally: panel shut, drafts gone, timers
          // cancelled by the effect's own cleanup on the cleared flow.
          resetLogin()
          setClientIdEditing(false)
          await onChanged()
          setBusy(null)
        }
      }

      /**
       * Persist the PUBLIC client id through the settings route — configuration,
       * never a credential. The key differs per provider, and both are the same
       * kind of value: a public identifier that travels in a URL.
       */
      const saveClientId = async () => {
        const value = clientIdDraft.trim()
        if (value === '') return
        setBusy('clientId')
        setError(null)
        try {
          await api('settings', provider === 'cloudflare'
            ? { cloudflareOAuthClientId: value }
            : (provider === 'gitea' ? { giteaOAuthClientId: value } : { githubDeviceClientId: value }))
          setClientIdDraft('')
          setClientIdEditing(false)
          setLocal(provider === 'cloudflare'
            ? t('cf.clientIdSaved')
            : (provider === 'gitea' ? t('gitea.clientIdSaved') : t('login.clientIdSaved')))
          await onChanged()
        } catch (error) {
          setError(String(error?.message ?? error))
        } finally {
          setBusy(null)
        }
      }

      /**
       * Store the Gitea client SECRET.
       *
       * The ONE secret field on this page. It posts straight to
       * `POST /api/connector/credentials`, which answers `{ ok, credentialRef }`
       * and nothing else; the field unmounts immediately afterwards and the value
       * is never held anywhere on the page again.
       */
      const saveSecret = async () => {
        if (secretDraft.trim() === '') return
        setBusy('secret')
        setError(null)
        try {
          await api('credentials', { alias: loginFor ?? undefined, secret: secretDraft })
          // Unmount the field FIRST: the value is already stored, so there is no
          // reason for it to exist in this state for another render.
          setLogin(current => current === null ? null : { ...current, secretDraft: '', revealed: false })
          setSecretEditing(false)
          setLocal(t('secretSaved'))
          await onChanged()
        } catch (error) {
          setError(String(error?.message ?? error))
        } finally {
          setBusy(null)
        }
      }

      /** Open the GitHub device flow: user_code + verification URL, no token yet. */
      const startDevice = async (row, tabOpened = false, tabTarget = '') => {
        setBusy('device')
        setError(null)
        try {
          const answer = await api('device/start', { provider, alias: row.alias })
          setFlow({
            flowId: answer.flowId,
            userCode: answer.userCode,
            verificationUri: answer.verificationUri,
            status: 'pending',
            intervalSeconds: answer.intervalSeconds ?? 5,
            opened: tabOpened === true,
            openedTarget: tabTarget,
            attempt: 0,
          })
        } catch (error) {
          setError(String(error?.message ?? error))
        } finally {
          setBusy(null)
        }
      }

      /**
       * The click handler for "Start device flow".
       *
       * THE GESTURE IS THE POINT: `window.open` runs SYNCHRONOUSLY inside the
       * click, before the start request is awaited, because a browser only allows
       * a popup while a real activation is in progress. A blocked popup leaves the
       * manual link on screen instead of pretending a tab exists.
       */
      const startDeviceFromClick = (row) => {
        const target = typeof device?.verificationUri === 'string' && device.verificationUri !== ''
          ? device.verificationUri
          : 'https://github.com/login/device'
        let opened
        try {
          opened = typeof globalThis.open === 'function' ? globalThis.open(target, '_blank') : null
        } catch {
          opened = null
        }
        void startDevice(row, opened !== null && opened !== undefined, target)
      }

      /**
       * The Gitea login click.
       *
       * Same gesture rule: the tab opens inside the handler. The URL is built by
       * the host first (`oauth/start` mints the one-time state), which would break
       * the gesture — so the click opens `about:blank`… no: it opens the tab and
       * then NAVIGATES it once the URL arrives. A popup opened on a blank document
       * inside the gesture is allowed everywhere, and `tab.location.replace` keeps
       * the blank page out of the back history.
       */
      const startOauth = async (row) => {
        setBusy('oauth')
        setError(null)
        let tab
        try {
          tab = typeof globalThis.open === 'function' ? globalThis.open('', '_blank') : null
        } catch {
          tab = null
        }
        try {
          const answer = await api('oauth/start', {
            provider: 'gitea', alias: row.alias,
            ...(callbackUri === '' ? {} : { redirectUri: callbackUri }),
          })
          setOauthPending(true)
          if (tab !== null && tab !== undefined && typeof tab.location?.replace === 'function') {
            tab.location.replace(answer.authorizeUrl)
          } else if (tab !== null && tab !== undefined && typeof tab.location !== 'undefined') {
            tab.location.href = answer.authorizeUrl
          }
        } catch (error) {
          // The tab is open on a blank page while the start failed; close it so a
          // stray empty tab is not left behind, and say what went wrong here.
          try { tab?.close?.() } catch { /* the tab is already gone */ }
          setError(String(error?.message ?? error))
        } finally {
          setBusy(null)
        }
      }

      /**
       * The Cloudflare login click.
       *
       * THE GESTURE IS THE POINT, exactly as with Gitea: the tab is opened
       * SYNCHRONOUSLY in the click handler — a browser only allows a popup during
       * a real activation — and then NAVIGATED once the host answers with the
       * authorize URL. `tab.location.replace` keeps the blank document out of the
       * back history.
       *
       * The redirect it hands the host is the one the PANEL SHOWS
       * (`cfRedirect`, built from the address bar or the saved override), so the
       * string in the guide, the string in the authorize URL and the string sent
       * to the token endpoint are one value.
       *
       * A failed start is TYPED, never silent: the tab is closed, and the panel
       * keeps a `host`-kind reason line so the user is not left with nothing.
       *
       * Nothing secret crosses this boundary: the host keeps the PKCE verifier in
       * the one-time state entry, and the page receives only the public URL (client
       * id, scopes, redirect URI, state, challenge).
       */
      const startCloudflare = async (row) => {
        setBusy('cfoauth')
        setError(null)
        setCfStartError(null)
        let tab
        try {
          tab = typeof globalThis.open === 'function' ? globalThis.open('', '_blank') : null
        } catch { tab = null }
        try {
          const answer = await api('oauth/cloudflare/start', {
            alias: row.alias,
            // An origin-only or empty value is dropped: the host then falls back
            // to the override/its own derivation instead of receiving "" as a URI.
            ...(cfRedirect === '' ? {} : { redirectUri: cfRedirect }),
          })
          setLogin(current => (current === null ? current : { ...current, oauthPending: true, cfAuthorize: String(answer.authorizeUrl ?? '') }))
          if (tab !== null && tab !== undefined && typeof tab.location?.replace === 'function') {
            tab.location.replace(answer.authorizeUrl)
          } else if (tab !== null && tab !== undefined && typeof tab.location !== 'undefined') {
            tab.location.href = answer.authorizeUrl
          }
        } catch (error) {
          // The tab is open on a blank page while the start failed; close it so a
          // stray empty tab is not left behind, and say what went wrong here.
          try { tab?.close?.() } catch { /* the tab is already gone */ }
          const message = String(error?.message ?? error)
          setError(message)
          setCfStartError({ kind: 'host', message })
        } finally {
          setBusy(null)
        }
      }

      /**
       * THE PRE-FLIGHT VERDICT, and the ONE rule it must obey.
       *
       * A Login press is NEVER a silent no-op. The old build disabled the panel's
       * Login whenever the host's `ready` predicate was false, which includes
       * "this origin cannot be a Cloudflare redirect" — so on an http://127.0.0.1
       * tab the button was inert: no panel change, no tab, no explanation. That is
       * the reported dead click.
       *
       * Now the press ALWAYS resolves the panel first, and only an origin that
       * cannot possibly be a Cloudflare redirect (no override, and this tab is
       * http on a non-localhost host) stops before opening a tab — with a TYPED
       * 'origin' line pointing at the Callback-origin field. Everything else goes
       * to the host, whose refusal is rendered as a typed 'host' line.
       *
       * @returns `{ kind, message }` — kind '' means "go".
       */
      const cfStartVerdict = () => {
        if (cfOriginOverride !== '') return { kind: '', message: '' }
        if (cfRedirectOrigin !== '') return { kind: '', message: '' }
        if (originFacts.insecure) {
          return { kind: 'origin', message: `${t('cf.startErrorOrigin')} ${originFacts.text}` }
        }
        return { kind: 'origin', message: t('cf.startErrorNoOrigin') }
      }

      /** The panel's primary action: always resolve the panel, then decide. */
      const loginCloudflare = (row) => {
        // 1. THE PANEL FIRST. A press opens it even when the flow cannot start,
        //    so the reason has somewhere to render (never a dead button).
        if (loginFor !== row.alias) {
          setLocal(null)
          setLogin({
            secretDraft: '', revealed: false, error: null, flow: null,
            oauthPending: false, guideOpen: false, cfStartError: null,
          })
          setOpenLogin({ provider, alias: row.alias })
        }
        // 2. The typed pre-flight. Only an unusable origin stops here.
        const verdict = cfStartVerdict()
        if (verdict.kind !== '') {
          setCfStartError(verdict)
          return
        }
        // 3. The real gesture.
        void startCloudflare(row)
      }

      /**
       * Save the Callback origin — the SAME non-secret setting as the plugin
       * config's `cloudflareCallbackOrigin`, editable where the user is standing.
       * It is configuration (an origin string), never a credential, so it goes
       * through the ordinary settings route and no store is touched.
       */
      const saveCfOrigin = async () => {
        setBusy('cforigin')
        setError(null)
        setCfStartError(null)
        setCfOriginNote(null)
        try {
          await api('settings', { cloudflareCallbackOrigin: cfOriginDraft.trim() })
          setCfOriginEditing(false)
          setCfOriginDraft('')
          setCfOriginNote(t('cf.callbackOriginSaved'))
          await onChanged()
        } catch (error) {
          setCfOriginNote(String(error?.message ?? error))
        } finally {
          setBusy(null)
        }
      }

      /** Persist the PUBLIC scope list (configuration, not a credential). */
      const saveCfScopes = async () => {
        setBusy('cfscopes')
        setError(null)
        try {
          await api('settings', { cloudflareOAuthScopes: cfScopesDraft })
          setCfScopesEditing(false)
          setLocal(t('cf.scopesSaved'))
          await onChanged()
        } catch (error) {
          setError(String(error?.message ?? error))
        } finally {
          setBusy(null)
        }
      }

      /**
       * The want-list hint. The DEFAULT set comes from the host (`defaultScopesText`),
       * never from this bundle, so the sentence cannot drift from what a fresh
       * consent actually requests.
       */
      const cfDefaultScopesHint = () => {
        const defaults = typeof cf?.defaultScopesText === 'string' && cf.defaultScopesText !== ''
          ? cf.defaultScopesText
          : cfScopesText
        return t('cf.scopesDefault').split('{scopes}').join(defaults)
      }

      /**
       * The scope list: a readout with a pencil, or the input. Public values only
       * — the scope ids travel in the authorize URL beside the client id.
       */
      const cfScopesBlock = () => {
        if (cfScopesEditing !== true) {
          return h('div', {
            'data-connector-cf-scopes-readout': 'true',
            style: { display: 'grid', gap: 4, paddingTop: 6, borderTop: `1px solid ${T.line}` },
          },
            h('div', { style: S.row },
              h('span', { style: { ...S.muted, fontSize: 12 } }, t('cf.scopesLabel')),
              h('code', {
                'data-connector-cf-scopes-value': 'true',
                style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: T.text, userSelect: 'all' },
              }, cfScopesText),
              h('button', {
                type: 'button', style: { ...S.button, height: 22, padding: '0 8px' },
                'data-connector-cf-scopes-edit': 'true',
                disabled: busy !== null || cfCanSave !== true,
                onClick: () => { setCfScopesDraft(cfScopesText); setCfScopesEditing(true) },
              }, t('cf.edit')),
            ),
            h('span', { style: S.muted }, t('cf.scopesHint')),
            h('span', { 'data-connector-cf-scopes-default': 'true', style: S.muted }, cfDefaultScopesHint()),
          )
        }
        return h('div', {
          'data-connector-cf-scopes-form': 'true',
          style: { display: 'grid', gap: 6, paddingTop: 6, borderTop: `1px solid ${T.line}` },
        },
          h('div', { style: S.row },
            h('input', {
              type: 'text',
              'data-connector-cf-scopes': 'true',
              autoComplete: 'off',
              spellCheck: false,
              value: cfScopesDraft,
              placeholder: 'page.write page.read zone-settings.read analytics.read',
              'aria-label': t('cf.scopesLabel'),
              style: { ...S.input, flex: 1, fontFamily: 'ui-monospace, monospace' },
              onChange: (event) => setCfScopesDraft(event.target.value),
            }),
            h('button', {
              type: 'button', style: S.primary,
              'data-connector-cf-scopes-save': 'true',
              disabled: busy !== null || cfScopesDraft.trim() === '',
              onClick: () => void saveCfScopes(),
            }, busy === 'cfscopes' ? t('busy') : t('status.save')),
            h('button', {
              type: 'button', style: S.button,
              'data-connector-cf-scopes-cancel': 'true',
              onClick: () => { setCfScopesEditing(false); setCfScopesDraft('') },
            }, t('cancelEdit')),
          ),
          h('span', { style: S.muted }, t('cf.scopesHint')),
          h('span', { 'data-connector-cf-scopes-default': 'true', style: S.muted }, cfDefaultScopesHint()),
        )
      }

      /**
       * The Callback origin: the SAME non-secret setting as
       * `cloudflareCallbackOrigin` in the plugin config, editable HERE.
       *
       * Why it exists on the panel at all: a harness served behind a reverse proxy
       * cannot see the browser's scheme, and the user's own domain is the only
       * redirect the OAuth client can register. Making that value two clicks away
       * (a config page the user could not find) was the second half of the reported
       * failure; this field is the one-line fix, and the config entry stays for
       * scripted installs.
       *
       * It is an ORIGIN, not a URL: the plugin appends the callback path, so the
       * value cannot silently disagree with the path Cloudflare compares.
       */
      const cfOriginBlock = () => {
        if (cfOriginEditing !== true) {
          return h('div', {
            'data-connector-cf-origin-readout': cfOriginOverride === '' ? 'derived' : 'configured',
            style: { display: 'grid', gap: 4, paddingTop: 6, borderTop: `1px solid ${T.line}` },
          },
            h('div', { style: S.row },
              h('span', { style: { ...S.muted, fontSize: 12 } }, t('cf.callbackOriginLabel')),
              h('code', {
                'data-connector-cf-origin-value': 'true',
                style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: T.text, userSelect: 'all' },
              }, cfOriginOverride !== '' ? cfOriginOverride : t('cf.callbackOriginDerived')),
              h('button', {
                type: 'button', style: { ...S.button, height: 22, padding: '0 8px' },
                'data-connector-cf-origin-edit': 'true',
                disabled: busy !== null || cfCanSave !== true,
                onClick: () => { setCfOriginDraft(cfOriginOverride); setCfOriginEditing(true); setCfOriginNote(null) },
              }, t('cf.edit')),
            ),
            h('span', { style: S.muted }, t('cf.callbackOriginHint')),
            cfOriginNote !== null && h('span', {
              'data-connector-cf-origin-note': 'true',
              style: { ...S.muted, color: T.info, fontSize: 12 },
            }, cfOriginNote),
          )
        }
        return h('div', {
          'data-connector-cf-origin-form': 'true',
          style: { display: 'grid', gap: 6, paddingTop: 6, borderTop: `1px solid ${T.line}` },
        },
          h('span', { style: { ...S.muted, fontSize: 12 } }, t('cf.callbackOriginLabel')),
          h('div', { style: S.row },
            h('input', {
              type: 'text',
              'data-connector-cf-callback-origin': 'true',
              autoComplete: 'off',
              spellCheck: false,
              value: cfOriginDraft,
              placeholder: 'https://your-domain.example',
              'aria-label': t('cf.callbackOriginLabel'),
              style: { ...S.input, flex: 1, fontFamily: 'ui-monospace, monospace' },
              onChange: (event) => setCfOriginDraft(event.target.value),
            }),
            h('button', {
              type: 'button', style: S.primary,
              'data-connector-cf-origin-save': 'true',
              disabled: busy !== null || cfCanSave !== true,
              onClick: () => void saveCfOrigin(),
            }, busy === 'cforigin' ? t('busy') : t('status.save')),
            h('button', {
              type: 'button', style: S.button,
              'data-connector-cf-origin-cancel': 'true',
              onClick: () => { setCfOriginEditing(false); setCfOriginDraft('') },
            }, t('cancelEdit')),
          ),
          h('span', { style: S.muted }, t('cf.callbackOriginHint')),
          h('span', { style: S.muted }, t('cf.callbackOriginClearHint')),
          cfOriginNote !== null && h('span', {
            'data-connector-cf-origin-note': 'true',
            style: { ...S.muted, color: T.info, fontSize: 12 },
          }, cfOriginNote),
        )
      }

      /**
       * Copy the 8-character code. `navigator.clipboard.writeText` first (the
       * secure-context path), then the legacy `execCommand('copy')` through a
       * hidden textarea — the only thing that works on an http origin such as
       * http://127.0.0.1:3079. Both are best-effort and never throw into render.
       */
      const copyCode = async (code) => {
        const text = String(code ?? '')
        if (text === '') return
        let copied = false
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text)
            copied = true
          }
        } catch { copied = false }
        if (!copied) {
          try {
            const doc = globalThis.document
            if (doc !== undefined && typeof doc.execCommand === 'function') {
              const area = doc.createElement('textarea')
              area.value = text
              area.setAttribute('readonly', 'readonly')
              area.style.position = 'fixed'
              area.style.left = '-1000px'
              doc.body.appendChild(area)
              // focus() before select(): some engines only put the selection on
              // the element (and therefore on the clipboard) once it is focused.
              area.focus()
              area.select()
              copied = doc.execCommand('copy') === true
              doc.body.removeChild(area)
            }
          } catch { copied = false }
        }
        setCopyState(copied ? 'copied' : 'failed')
      }

      /**
       * One poll per tick while a flow is open; the host holds the device code.
       *
       * The timer is per-effect and its cleanup clears it, which is what makes a
       * logout mid-poll a real abort: `resetLogin()` nulls the flow, the effect's
       * dependency changes, the cleanup runs `clearTimeout`, and no further poll
       * can start. The `cancelled` flag additionally drops a response that was
       * already in flight, so nothing can call `setLocal`/`onChanged` after the
       * reset.
       */
      useEffect(() => {
        if (flow === null || flow.status !== 'pending') return undefined
        let cancelled = false
        const wait = Math.max(Number(flow.intervalSeconds ?? 5), 3) * 1000
        const timer = setTimeout(async () => {
          if (cancelled) return
          try {
            const answer = await api('device', { flowId: flow.flowId })
            if (cancelled) return
            if (answer.status === 'authorized') {
              // Authorized: the panel closes (the slot is cleared, so the code
              // goes with it), the badge re-reads from `state`, and a short
              // success note stands where the card was.
              resetLogin()
              setCopyState(null)
              setLocal(t('login.success'))
              await onChanged()
              return
            }
            if (answer.status === 'pending' || answer.status === 'slow_down') {
              setFlow(current => (current === null ? null : {
                ...current,
                status: 'pending',
                intervalSeconds: answer.intervalSeconds ?? current.intervalSeconds,
                attempt: (current.attempt ?? 0) + 1,
              }))
              return
            }
            setCopyState(null)
            setFlow(current => (current === null ? null : {
              ...current,
              status: answer.status ?? 'expired',
              message: String(answer.message ?? ''),
            }))
            setError(null)
          } catch (error) {
            // A transient failure (a restart, a dropped connection) must NOT stop
            // the login while the panel still says "Waiting for approval": record
            // the reason and bump the attempt so the effect re-arms.
            if (cancelled) return
            setError(String(error?.message ?? error))
            setFlow(current => (current === null ? null : {
              ...current,
              status: 'pending',
              attempt: (current.attempt ?? 0) + 1,
            }))
          }
        }, wait)
        return () => { cancelled = true; clearTimeout(timer) }
        // `flow.attempt` is in the dependency list on purpose: every finished
        // attempt changes it, so the timer re-arms — including after a FAILED
        // request, which used to leave the panel waiting forever.
      }, [flow?.flowId, flow?.status, flow?.intervalSeconds, flow?.attempt, t, onChanged])

      /**
       * The numbered steps for one provider. The dictionary value is an ARRAY, so
       * a translator edits a list in place and the order is data, not code.
       */
      const guideSteps = (name) => {
        const list = t(`login.guide.${name}.steps`)
        return Array.isArray(list) ? list.map(step => String(step)) : []
      }
      /** One closing note (scope advice, expiry caveat), or ''. */
      const guideNote = (name) => {
        const key = `login.guide.${name}.note`
        const value = t(key)
        return typeof value === 'string' && value !== key ? value : ''
      }

      /**
       * The client-id block: a plain readout (it is PUBLIC) with an Edit control,
       * or the input itself. Three providers, one shape:
       *
       *   github      → the device-flow OAuth App id;
       *   gitea       → the OAuth2 application id (its SECRET has its own field);
       *   cloudflare  → the PKCE client id — and that provider has NO secret at
       *                 all, because its client is registered as a public client.
       */
      const clientIdBlock = (kind) => {
        const configured = kind === 'cloudflare'
          ? cfClientId
          : (kind === 'gitea' ? giteaClientId : (device?.clientIdConfigured === true ? (device?.clientId ?? '') : ''))
        const canSave = kind === 'cloudflare' ? cfCanSave : canSaveClientId
        const label = kind === 'cloudflare' ? t('cf.clientIdLabel') : (kind === 'gitea' ? t('gitea.clientId') : t('clientId'))
        const placeholder = kind === 'cloudflare' ? 'cloudflare-oauth-client-id' : (kind === 'gitea' ? t('clientId') : t('clientIdPlaceholder'))
        if (!canSave) {
          // A host that cannot persist the id says so in its own words instead of
          // showing a field whose save would be refused.
          const reason = (kind === 'cloudflare' ? cf?.reason : (kind === 'gitea' ? oauth?.reason : device?.reason))
          if (typeof reason === 'string' && reason !== '') {
            return h('div', {
              'data-connector-clientid-blocked': kind,
              style: { display: 'grid', gap: 4, paddingTop: 6, borderTop: `1px solid ${T.line}` },
            },
              // The "why" line differs by provider: GitHub/Gitea need an app id for
            // their flow, Cloudflare's is the PKCE client id.
            h('span', { style: S.muted }, kind === 'cloudflare' ? t('cf.clientIdHint') : t('login.clientIdNeeded')),
              h('span', { style: { ...S.muted, fontSize: 12, color: T.warning } }, reason),
            )
          }
          return null
        }
        // CONFIGURED, not editing: the readout is the id itself (it is public) with
        // an Edit control. "Masked-none" in the owner's terms means no token-style
        // masking is applied at all — a client id is not a secret.
        if (configured !== '' && !clientIdEditing) {
          return h('div', {
            'data-connector-clientid-readout': kind,
            style: { display: 'grid', gap: 4, paddingTop: 6, borderTop: `1px solid ${T.line}` },
          },
            h('div', { style: S.row },
              h('span', { style: { ...S.muted, fontSize: 12 } }, t('clientIdLabel')),
              h('code', {
                'data-connector-clientid-value': kind,
                style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: T.text },
              }, configured),
              h('button', {
                type: 'button', style: { ...S.button, height: 22, padding: '0 8px' },
                'data-connector-clientid-edit': kind,
                disabled: busy !== null,
                onClick: () => { setClientIdDraft(configured); setClientIdEditing(true) },
              }, t('clientIdEdit')),
            ),
          )
        }
        return h('div', {
          'data-connector-clientid-form': kind,
          style: { display: 'grid', gap: 6, paddingTop: 6, borderTop: `1px solid ${T.line}` },
        },
          h('div', { style: S.row },
            h('input', {
              type: 'text',
              'data-connector-clientid': kind,
              autoComplete: 'off',
              spellCheck: false,
              value: clientIdDraft,
              placeholder,
              'aria-label': label,
              style: { ...S.input, flex: 1, fontFamily: 'ui-monospace, monospace' },
              onChange: (event) => setClientIdDraft(event.target.value),
            }),
            h('button', {
              type: 'button', style: S.primary,
              'data-connector-clientid-save': kind,
              disabled: busy !== null || clientIdDraft.trim() === '',
              onClick: () => void saveClientId(),
            }, busy === 'clientId' ? t('busy') : t('saveClientId')),
            clientIdEditing && h('button', {
              type: 'button', style: S.button,
              'data-connector-clientid-cancel': kind,
              onClick: () => { setClientIdEditing(false); setClientIdDraft('') },
            }, t('cancelEdit')),
          ),
          h('span', { style: S.muted }, kind === 'cloudflare' ? t('cf.clientIdHint') : t('clientIdHint')),
        )
      }

      /**
       * The Gitea client-secret field — the ONLY secret input left on this page,
       * and it follows the same eye pattern the token field used to.
       */
      const secretBlock = () => {
        return h('div', {
          'data-connector-secret-form': 'gitea',
          style: { display: 'grid', gap: 6, paddingTop: 6, borderTop: `1px solid ${T.line}` },
        },
          h('div', { style: S.row },
            h('input', {
              // THE CONTRACT: masked while hidden (`type="password"`), and a real
              // `type="text"` while revealed. The eye flips the TYPE.
              type: revealed ? 'text' : 'password',
              autoComplete: 'off',
              spellCheck: false,
              'data-connector-secret': 'true',
              'data-revealed': revealed ? 'true' : 'false',
              value: secretDraft,
              placeholder: t('secretPlaceholder'),
              'aria-label': t('gitea.clientSecret'),
              style: { ...S.input, flex: 1, fontFamily: revealed ? 'ui-monospace, monospace' : 'inherit' },
              onChange: (event) => setSecretDraft(event.target.value),
            }),
            h('button', {
              type: 'button', style: S.button, 'data-connector-eye': 'true',
              'aria-pressed': revealed ? 'true' : 'false',
              'aria-label': revealed ? t('hideToken') : t('showToken'),
              title: revealed ? t('hideToken') : t('showToken'),
              onClick: () => setRevealed(value => !value),
            }, revealed ? t('hideToken') : t('showToken')),
            h('button', {
              type: 'button', style: S.primary,
              'data-connector-secret-save': 'true',
              disabled: busy !== null || secretDraft.trim() === '',
              onClick: () => void saveSecret(),
            }, busy === 'secret' ? t('login.saving') : t('secretSave')),
          ),
          h('span', { style: S.muted }, t('secretHint')),
        )
      }

      const loginPanel = (row) => {
        return h('div', {
          style: { display: 'grid', gap: 6, padding: '8px 0 0', borderTop: `1px solid ${T.line}` },
          'data-connector-login': provider,
        },
          h('span', { style: S.muted }, instructions),
          h('div', { style: S.row },
            // Guide sits LEFT of everything: "how do I set this up?" comes first.
            h('button', {
              type: 'button', style: S.button,
              'data-connector-guide': provider,
              'aria-expanded': guideOpen ? 'true' : 'false',
              'aria-controls': `connector-guide-${provider}`,
              onClick: () => setGuideOpen(!guideOpen),
            }, t('login.guide')),
            h('button', { type: 'button', style: S.button, 'data-connector-login-close': provider, onClick: resetLogin }, t('login.cancel')),
          ),
          guideOpen && h('div', {
            id: `connector-guide-${provider}`,
            'data-connector-guide-panel': provider,
            // A guide is plain content, never an inner scroll area: no
            // max-height, no clamp, no `overflow: hidden`. It expands to its full
            // text inline and the PAGE's scroll root carries the scrollbar.
            // `aria-scrollable=false` says so to assistive tech, matching the
            // `data-connector-scrollable` marker the test asserts on.
            'data-connector-scrollable': 'false',
            'aria-scrollable': 'false',
            style: {
              ...S.card, gap: 6, background: T.hover, padding: '10px 12px',
              maxHeight: 'none', overflow: 'visible',
            },
          },
            h('div', { style: { fontSize: 12, fontWeight: 600 } }, t(`login.guide.${provider}.title`)),
            h('ol', { style: { margin: 0, paddingLeft: 18, display: 'grid', gap: 5, fontSize: 12, color: T.secondary } },
              guideSteps(provider).map((step, index) => h('li', {
                key: `${provider}:${index}`,
                'data-connector-guide-step': String(index + 1),
              // The Gitea guide must render THIS deployment's callback, so the one
              // placeholder the copy carries is substituted here rather than being
              // frozen at build time.
              }, String(step)
                // A placeholder is ALWAYS substituted, even when this tab cannot
                // derive a value: the copy must never render "{redirect}" to a
                // human. The fallbacks are templates, marked as such.
                .split('{callback}').join(callbackUri !== '' ? callbackUri : `<this-deployment-origin>${giteaCallbackPath}`)
                .split('{redirect}').join(cfRedirect !== '' ? cfRedirect : `<your-domain>${cfCallbackPath}`)
                .split('{base}').join(giteaBase)
                .split('{origin}').join(pageOrigin !== '' ? pageOrigin : '<this-deployment-origin>'))),
            ),
            // THE REDIRECT URI, as its own line: the one value the user must copy
            // character for character, rendered from THIS deployment's origin
            // rather than frozen into the copy (a hard-coded port would be wrong
            // on every other deployment, and GitHub/Gitea compare it exactly).
            (provider === 'github' || provider === 'gitea') && h('div', {
              'data-connector-redirect': provider,
              style: {
                display: 'grid', gap: 2, paddingTop: 6, borderTop: `1px dashed ${T.line}`,
                fontSize: 12, color: T.secondary,
              },
            },
              // The substitution runs on the SELECTED string: a ternary whose
              // branches carry the chain would only ever substitute the else
              // branch, which is exactly the bug this comment replaces.
              h('span', {}, String(provider === 'gitea' ? t('guide.redirectGitea') : t('guide.redirectGithub'))
                .split('{callback}').join(callbackUri !== '' ? callbackUri : `<this-deployment-origin>${giteaCallbackPath}`)
                .split('{origin}').join(pageOrigin !== '' ? pageOrigin : '<this-deployment-origin>')),
              h('code', {
                'data-connector-redirect-value': provider,
                style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: T.text, userSelect: 'all' },
              }, provider === 'gitea'
                ? (callbackUri !== '' ? callbackUri : `<this-deployment-origin>${giteaCallbackPath}`)
                : (pageOrigin !== '' ? pageOrigin : '<this-deployment-origin>')),
            ),
            guideNote(provider) !== '' && h('div', { style: { ...S.muted, fontSize: 12 } }, guideNote(provider)),
          ),
          tokenError !== null && h('span', { style: { ...S.muted, color: T.error } }, tokenError),

          // ── GitHub: public client id, then the device flow ────────────────
          provider === 'github' && clientIdBlock('github'),
          provider === 'github' && deviceReady && flow === null && h('div', { style: S.row },
            h('button', {
              type: 'button', style: S.primary,
              'data-connector-device-start': 'true',
              disabled: busy !== null,
              onClick: () => void startDeviceFromClick(row),
            }, busy === 'device' ? t('busy') : t('login.device.start')),
          ),
          provider === 'github' && flow !== null && h('div', {
            'data-connector-device-flow': 'true',
            style: { ...S.card, gap: 6, background: T.hover, padding: '12px 14px' },
          },
            (flow.status === 'pending')
              ? h('div', { 'data-connector-device-pending': 'true', style: { display: 'grid', gap: 6 } },
                h('span', { style: { fontSize: 12, color: T.secondary } }, t('login.device.code')),
                h('div', { style: S.row },
                  h('code', {
                    'data-connector-user-code': 'true',
                    style: {
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                      fontSize: 30, fontWeight: 700, letterSpacing: 6,
                      lineHeight: 1.15, userSelect: 'all', color: T.text,
                    },
                  }, formatUserCode(flow.userCode)),
                  h('button', {
                    type: 'button', style: S.button,
                    'data-connector-copy-code': 'true',
                    onClick: () => void copyCode(flow.userCode),
                  }, copyState === 'copied' ? t('login.copied') : t('login.copy')),
                  h('button', {
                    type: 'button', style: S.button,
                    'data-connector-device-cancel': 'true',
                    onClick: () => { setCopyState(null); resetLogin() },
                  }, t('login.cancel')),
                ),
                copyState === 'failed' && h('span', { style: { ...S.muted, color: T.warning } }, t('login.copyFailed')),
                h('span', { style: { fontFamily: 'ui-monospace, monospace', fontSize: 13, color: T.secondary } }, flow.verificationUri),
                h('a', {
                  href: flow.verificationUri, target: '_blank', rel: 'noreferrer noopener',
                  'data-connector-open-manual': flow.opened === true ? 'auto' : 'fallback',
                  style: { fontSize: 12, color: T.info },
                }, t('login.openManual')),
                flow.opened === true && h('span', { style: S.muted }, t('login.autoOpened')),
                h('span', { style: { ...S.muted, color: T.info } }, t('login.device.waiting')),
                h('span', { style: S.muted }, t('login.device.expiry')),
              )
              : h('div', { style: { display: 'grid', gap: 6 } },
                h('span', { style: { ...S.muted, color: T.error } },
                  flow.status === 'denied' ? t('login.denied') : String(flow.message ?? t('login.expired'))),
                h('button', {
                  type: 'button', style: S.primary,
                  'data-connector-device-start': 'true',
                  disabled: busy !== null,
                  onClick: () => void startDeviceFromClick(row),
                }, busy === 'device' ? t('busy') : t('login.device.start')),
              ),
          ),

          // ── Gitea: public client id + the ONE secret field, then authorize ─
          provider === 'gitea' && clientIdBlock('gitea'),
          // The field exists only while there is nothing stored, or when the user
          // asked to replace it: a stored secret is not shown again, and there is
          // no reason to keep an empty password box on screen.
          provider === 'gitea' && (secretStored !== true || secretEditing === true) && secretBlock(),
          provider === 'gitea' && secretStored === true && secretEditing !== true && h('div', {
            'data-connector-secret-saved': 'true',
            style: S.row,
          },
            h('span', { style: { ...S.muted, color: T.success, fontSize: 12 } }, t('secretSaved')),
            h('button', {
              type: 'button', style: { ...S.button, height: 22, padding: '0 8px' },
              'data-connector-secret-replace': 'true',
              onClick: () => setSecretEditing(true),
            }, t('secretReplace')),
          ),
          provider === 'gitea' && h('div', { style: S.row },
            h('button', {
              type: 'button', style: S.primary,
              'data-connector-oauth-start': 'true',
              disabled: busy !== null || oauthReady !== true,
              title: oauthReady === true ? undefined : (typeof oauth?.reason === 'string' ? oauth.reason : undefined),
              onClick: () => void startOauth(row),
            }, busy === 'oauth' ? t('busy') : t('login')),
          ),
          provider === 'gitea' && oauthReady !== true && typeof oauth?.reason === 'string' && h('span', {
            'data-connector-oauth-blocked': 'true',
            style: { ...S.muted, fontSize: 12, color: T.warning },
          }, oauth.reason),
          provider === 'gitea' && oauthPending && h('div', {
            'data-connector-oauth-pending': 'true',
            style: { ...S.card, gap: 6, background: T.hover, padding: '12px 14px' },
          },
            h('span', { style: { ...S.muted, color: T.info } }, t('gitea.authorizing')),
            typeof oauth?.authorizeBase === 'string' && oauth.authorizeBase !== '' && h('span', {
              style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: T.secondary },
            }, `${oauth.authorizeBase}/login/oauth/authorize`),
            h('span', { style: S.muted }, t('gitea.blocked')),
            h('button', {
              type: 'button', style: S.button,
              'data-connector-oauth-cancel': 'true',
              onClick: resetLogin,
            }, t('login.cancel')),
          ),

          // ── Cloudflare: public PKCE client, dynamic redirect, then authorize ─
          provider === 'cloudflare' && h('div', {
            'data-connector-cf-setup': 'true',
            style: { ...S.card, gap: 6, background: T.hover, padding: '10px 12px' },
          },
            h('div', { style: { fontSize: 12, fontWeight: 600 } }, t('cf.setupTitle')),
            h('span', { style: S.muted }, t('cf.setupHint')),
            // THE ONE VALUE THAT MUST MATCH EXACTLY, rendered from THIS TAB (or
            // the saved override) — the same string the authorize call carries
            // and the same one the host parks for the token exchange. Cloudflare
            // compares it character for character.
            h('div', {
              'data-connector-cf-redirect': cfRedirectSource,
              style: { display: 'grid', gap: 2, paddingTop: 6, borderTop: `1px dashed ${T.line}` },
            },
              h('span', { style: { ...S.muted, fontSize: 12 } }, t('cf.redirectLabel')),
              cfRedirect !== ''
                ? h('code', {
                  'data-connector-cf-redirect-value': 'true',
                  style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: T.text, userSelect: 'all' },
                }, cfRedirect)
                // NEVER print a redirect that cannot work: say what is missing.
                : h('code', {
                  'data-connector-cf-redirect-value': 'unavailable',
                  style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: T.warning },
                }, t('cf.redirectUnavailable')),
              h('span', { style: S.muted }, cfRedirectSource === 'configured'
                ? t('cf.redirectFromOverride')
                : (cfRedirectSource === 'tab' ? t('cf.redirectFromTab') : t('cf.redirectNoneHint'))),
            ),
            // The SAME non-secret setting as the plugin config, inline where the
            // Login press happens.
            cfOriginBlock(),
          ),
          // THE ORIGIN WARNING. Shown whenever this tab (or the host's view of it)
          // cannot be a Cloudflare redirect, and it is also what the typed start
          // error explains — so a failed Login always lands next to the fix.
          provider === 'cloudflare' && cfOriginProblem !== '' && h('div', {
            'data-connector-cf-origin-hint': cfOriginProblem,
            style: { display: 'grid', gap: 4, padding: '8px 10px', borderRadius: T.radiusSm, border: `1px dashed ${T.warning}` },
          },
            h('span', { style: { fontSize: 12, fontWeight: 600, color: T.warning } }, t('cf.originTitle')),
            // THE BROWSER'S OWN ORIGIN — never the server-derived one. A page
            // that is genuinely on https must never be told it is on http.
            h('span', { style: S.muted }, t('cf.originCurrent').split('{origin}').join(originFacts.text)),
            cfOriginProblem === 'insecure' && h('span', { style: { ...S.muted, color: T.info } }, t('cf.originSuggested').split('{suggested}').join(originFacts.suggested)),
            // The host's derivation disagreed with this tab: say so, because that
            // is the reverse-proxy symptom, and name the override that fixes it.
            cfOriginProblem === 'host-rejected' && h('span', {
              'data-connector-cf-origin-host-derivation': 'true',
              style: { ...S.muted, fontSize: 12 },
            }, t('cf.originHostDerived').split('{derived}').join(cfHostDerived === '' ? '(none)' : cfHostDerived)),
            h('span', { style: S.muted }, t('cf.originOverride')),
            cfRedirect !== '' && h('span', { style: S.muted }, t('cf.originApproved').split('{redirect}').join(cfRedirect)),
          ),
          provider === 'cloudflare' && clientIdBlock('cloudflare'),
          provider === 'cloudflare' && cfScopesBlock(),
          // THE TYPED START VERDICT. A press that cannot open a tab leaves this
          // line behind; a press the host refuses leaves the 'host' variant. The
          // button itself is NEVER disabled for readiness (that was the dead
          // click), so this block is the only way a press can end without a tab.
          provider === 'cloudflare' && cfStartError !== null && h('div', {
            'data-connector-cf-start-error': cfStartError.kind,
            role: 'alert',
            style: { display: 'grid', gap: 4, padding: '8px 10px', borderRadius: T.radiusSm, border: `1px solid ${T.error}` },
          },
            h('span', { style: { fontSize: 12, fontWeight: 600, color: T.error } }, t('cf.startErrorTitle')),
            h('span', { style: { ...S.muted, color: T.error } }, cfStartError.message),
            cfStartError.kind === 'origin' && h('span', { style: { ...S.muted, color: T.info } }, t('cf.startErrorOriginHint')),
          ),
          provider === 'cloudflare' && h('div', { style: S.row },
            h('button', {
              type: 'button', style: S.primary,
              'data-connector-cf-start': 'true',
              // ONLY an in-flight request disables it. Readiness is not a lock:
              // a press must always answer (panel, tab, or typed reason).
              disabled: busy !== null,
              title: cfStartError !== null ? undefined : (cfReady === true ? undefined : (typeof cf?.reason === 'string' ? cf.reason : undefined)),
              onClick: () => loginCloudflare(row),
            }, busy === 'cfoauth' ? t('busy') : t('login')),
            // A visible fallback for a BLOCKED popup, and only once the host has
            // minted this attempt's URL: the link carries the same one-time state
            // and PKCE challenge, so it is a real login and not a dead endpoint.
            cfAuthorize !== '' && h('a', {
              href: cfAuthorize,
              target: '_blank', rel: 'noreferrer noopener',
              'data-connector-cf-open-manual': 'true',
              style: { fontSize: 12, color: T.info, wordBreak: 'break-all' },
            }, t('cf.manualLink')),
          ),
          provider === 'cloudflare' && cfReady !== true && typeof cf?.reason === 'string' && h('span', {
            'data-connector-cf-blocked': 'true',
            style: { ...S.muted, fontSize: 12, color: T.warning },
          }, cf.reason),
          provider === 'cloudflare' && oauthPending && h('div', {
            'data-connector-cf-pending': 'true',
            style: { ...S.card, gap: 6, background: T.hover, padding: '12px 14px' },
          },
            h('span', { style: { ...S.muted, color: T.info } }, t('cf.authorizing')),
            h('span', {
              'data-connector-cf-authorize-url': 'true',
              style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: T.secondary, wordBreak: 'break-all' },
            }, cfAuthorize === '' ? cfAuthorizeUrl : cfAuthorize),
            h('span', { style: S.muted }, t('cf.blocked')),
            h('div', { style: S.row },
              h('button', {
                type: 'button', style: S.button,
                'data-connector-cf-check': 'true',
                onClick: () => { void onChanged() },
              }, t('cf.checkStatus')),
              h('button', {
                type: 'button', style: S.button,
                'data-connector-cf-cancel': 'true',
                onClick: resetLogin,
              }, t('login.cancel')),
            ),
          ),
        )
      }

      return h('div', { style: S.card, 'data-connector-card': provider },
        h('div', { style: S.row },
          h('span', { style: { fontWeight: 600, fontSize: 13 } }, PROVIDER_LABEL[provider] ?? provider),
          h('span', { style: S.badge(anyResolved) }, anyResolved ? t('status.resolved') : t('status.unresolved')),
          data?.defaultAlias !== undefined && h('span', { style: { ...S.muted, marginLeft: 'auto' } }, `default “${data.defaultAlias}”`),
        ),

        aliases.length === 0 && h('div', { style: S.muted }, t('status.noAlias')),
        aliases.map(row => h('div', { key: `${provider}:${row.alias}`, style: S.row },
          h('span', { style: { fontSize: 13, fontWeight: 500 } }, row.alias),
          h('span', { style: { ...S.muted, fontFamily: 'ui-monospace, monospace' } }, row.credentialRef || t('status.noRef')),
          h('span', { style: S.badge(row.resolved === true) }, row.resolved ? t('status.resolved') : t('status.unresolved')),
          row.source !== undefined && h('span', { style: S.muted }, row.source),
          h('div', { style: { display: 'flex', gap: 6, marginLeft: 'auto' } },
            /**
             * THE DYNAMIC PAIR. A resolved reference offers Logout (RED); an
             * unresolved one offers Login. Test connection always sits beside
             * whichever of the two is showing.
             */
            row.resolved === true
              ? h('button', {
                type: 'button',
                style: { ...S.button, color: T.error, borderColor: T.error },
                'data-connector-logout-button': provider,
                'data-connector-button-style': 'danger',
                disabled: busy !== null,
                onClick: () => void logout(row),
              }, busy === `logout:${row.alias}` ? t('busy') : t('logout'))
              : h('button', {
                type: 'button', style: S.button,
                'data-connector-login-button': provider,
                disabled: loginDisabled,
                onClick: () => {
                  // Toggle THIS row: closing is a full reset of the one slot.
                  if (loginFor === row.alias) { resetLogin(); return }
                  setLocal(null)
                  // Opening a different row (on this card or another) replaces the
                  // slot wholesale, so the previous panel's draft cannot survive.
                  setLogin({ secretDraft: '', revealed: false, error: null, flow: null, oauthPending: false, guideOpen: false, cfStartError: null })
                  setOpenLogin({ provider, alias: row.alias })
                },
              }, loginFor === row.alias ? t('login.cancel') : t('login')),
            h('button', {
              type: 'button', style: S.button,
              'data-connector-test-button': provider,
              disabled: busy !== null || row.resolved !== true,
              onClick: () => void test(row),
            }, busy === `test:${row.alias}` ? t('busy') : t('status.test')),
            h('button', { type: 'button', style: S.button, disabled: busy !== null, onClick: () => startEdit(row) }, t('status.editRef')),
          ),
        )),

        loginFor !== null && loginPanel({ alias: loginFor }),

        provider === 'gitea' && h('div', { style: { display: 'grid', gap: 6, paddingTop: 4, borderTop: `1px solid ${T.line}` } },
          h('label', { style: S.label }, t('status.baseUrl'),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('input', {
                value: baseUrl, placeholder: 'https://git.example.com', style: { ...S.input, flex: 1 },
                onChange: (event) => setBaseUrl(event.target.value),
              }),
              h('button', { type: 'button', style: S.button, disabled: busy !== null, onClick: () => void saveUrl() }, busy === 'url' ? t('busy') : t('status.saveUrl')),
            ),
          ),
          h('span', { style: S.muted }, t('status.baseUrlHint')),
        ),

        h('div', { style: S.row },
          h('button', { type: 'button', style: open ? S.button : S.primary, onClick: () => (open ? setOpen(false) : startEdit(null)) }, open ? t('status.cancel') : t('status.setRef')),
        ),

        open && h('div', { style: { display: 'grid', gap: 6, padding: '8px 0 0', borderTop: `1px solid ${T.line}` } },
          h('div', { style: { display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8 } },
            h('input', {
              value: alias, placeholder: 'default', style: S.input,
              onChange: (event) => setAlias(event.target.value),
            }),
            // A plain text field: the value being edited is a credential NAME,
            // never a credential.
            h('input', {
              value: refDraft, placeholder: t('status.refPlaceholder'), style: { ...S.input, flex: 1 },
              onChange: (event) => setRefDraft(event.target.value),
            }),
          ),
          h('span', { style: S.muted }, t('status.refHint')),
          h('div', { style: S.row },
            h('button', {
              type: 'button', style: S.primary,
              disabled: busy !== null || refDraft.trim() === '' || alias.trim() === '',
              onClick: () => void saveRef(),
            }, busy === 'save' ? t('busy') : t('status.save')),
          ),
        ),

        h('div', { style: { ...S.muted, marginTop: 2 } }, t('status.manageHint')),
        local !== null && h('div', {
          // The card's one-line verdict: a reference answer, a settings ack, the
          // device flow's success note, or an inline failure. Never a value.
          'data-connector-note': 'true',
          style: { ...S.muted },
        }, local),
      )
    }

    /** Status: cards + store footnote. This is the whole page. */
    function StatusTab({ report, t, onChanged }) {
      /**
       * THE single open-login slot for the whole page.
       *
       * It lives here, above the cards, because "one open panel" is a PAGE-level
       * invariant: with this state inside `ProviderCard`, two cards could each
       * hold an open panel and two password fields, and two token strings, at the
       * same time. One slot means opening a login anywhere closes the other one,
       * and only one `type="password"` input can ever be mounted.
       *
       * `openLogin` = { provider, alias } | null; `login` = { secretDraft,
       * revealed, error, flow, oauthPending, guideOpen } | null. Both are cleared
       * together, and the flow's poll timer is torn down by its own effect as soon
       * as the slot goes — which is what makes Logout a real abort.
       */
      const [openLogin, setOpenLogin] = useState(null)
      const [login, setLogin] = useState(null)
      /**
       * The OAuth callback tab nudges its opener when it finishes, and closes
       * itself. Listening for that one message does BOTH halves of the owner's
       * contract: the panel is dropped WHOLESALE (`setLogin`/`setOpenLogin` null —
       * the same reset Cancel performs) and `state` is re-read, so the card's pair
       * flips from the store's own verdict with no Cancel click and no trip back.
       *
       * Guarded: a host without window events (a unit test, a bare sandbox) simply
       * never subscribes, and the auto-resolve effect below still covers it.
       */
      useEffect(() => {
        const target = globalThis
        if (typeof target.addEventListener !== 'function') return undefined
        const onMessage = (event) => {
          if (event?.origin !== target.location?.origin) return
          if (event?.data?.type !== 'connector:oauth-complete') return
          // The login this page is waiting for has landed: close the panel the
          // same way Cancel does (a full reset of the one slot), then reconcile.
          setLogin(null)
          setOpenLogin(null)
          void onChanged()
        }
        target.addEventListener('message', onMessage)
        return () => { target.removeEventListener('message', onMessage) }
      }, [onChanged])

      /**
       * AUTO-RESOLVE, belt and braces. Whatever made the reference resolve — the
       * OAuth nudge above, the GitHub device-flow poll, a login finished in
       * another tab, an operator storing the value in DSH — the OPEN panel must
       * not survive a resolved alias: it closes itself here, on the state the page
       * already re-read. Nobody has to press Cancel.
       */
      useEffect(() => {
        if (openLogin === null || report === null) return
        const entry = (report.providers ?? []).find(row => row.provider === openLogin.provider)
        const resolved = (entry?.aliases ?? []).some(row => row.alias === openLogin.alias && row.resolved === true)
        if (resolved === true) {
          setLogin(null)
          setOpenLogin(null)
        }
      }, [report, openLogin])

      /**
       * And while a panel IS waiting, coming back to this tab re-reads `state`:
       * a browser that dropped the message (or a callback that landed after the
       * tab lost focus) is reconciled on focus/visibilitychange instead of
       * leaving the user to hunt for a button.
       */
      useEffect(() => {
        if (openLogin === null) return undefined
        const target = globalThis
        if (typeof target.addEventListener !== 'function') return undefined
        const refresh = () => { void onChanged() }
        target.addEventListener('focus', refresh)
        target.addEventListener('visibilitychange', refresh)
        return () => {
          target.removeEventListener('focus', refresh)
          target.removeEventListener('visibilitychange', refresh)
        }
      }, [openLogin, onChanged])
      if (report === null) return h('div', { style: S.muted }, t('loading'))
      // A host that answers without `providers` (an older build, a failed read)
      // must not blank the whole panel: an empty list still renders the footnote.
      const entries = Array.isArray(report.providers) ? report.providers : []
      // The origin the page was loaded from — the value every OAuth callback URL
      // must match, rendered in the Gitea guide and sent with `oauth/start`.
      /**
       * THE GUI ORIGIN, taken from the HOST's own answer first.
       *
       * `report.oauth.redirectUri` is built by the Host half from the `Host`
       * header of the request the browser actually made, so it is the value Gitea
       * will compare against — not a guess from a hard-coded port. `location` is
       * only the fallback for a host too old to answer with `oauth`.
       */
      const reportedCallback = typeof report?.oauth?.redirectUri === 'string' ? report.oauth.redirectUri : ''
      const origin = reportedCallback !== ''
        ? reportedCallback.replace(/\/api\/connector\/oauth\/gitea\/callback$/u, '')
        : (typeof globalThis.location?.origin === 'string' && globalThis.location.origin !== 'null'
          ? globalThis.location.origin
          : '')
      return h('div', { style: { display: 'grid', gap: 10 } },
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, t('status.providers')),
        entries.map(entry => h(ProviderCard, {
          key: entry.provider, provider: entry.provider, data: entry, t, onChanged,
          device: report.device,
          oauth: report.oauth,
          oauthCloudflare: report.oauthCloudflare,
          secret: report.secret,
          origin,
          openLogin, setOpenLogin, login, setLogin,
        })),
        h('div', { style: { ...S.card, gap: 4 } },
          h('div', { style: { fontSize: 12, color: T.secondary } }, t('status.foot')),
          h('div', { style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: T.caption } },
            report.storePath ?? '$DSH_HOME/.credentials.yaml'),
          // The reference names this plugin owns, per provider. Names only.
          h('div', { style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: T.caption } },
            entries.map(entry => `${entry.provider}: ${(entry.aliases ?? []).map(row => `${row.alias} → ${row.credentialRef || '(none)'}`).join(', ')}`).join('\n')),
          h('div', { style: { ...S.muted, paddingTop: 2 } }, t('status.toolsHint')),
        ),
      )
    }

    /** The page: one head, one status surface. No tabs, no other sections. */
    function ConnectorPage(props) {
      const t = useTranslate(props?.ctx?.locale ?? props?.locale)
      const [report, setReport] = useState(null)
      const [note, setNote] = useState(null)

      const load = useCallback(async () => {
        try {
          const status = await api('state')
          setReport(status)
          setNote(null)
        } catch (error) {
          setNote(String(error?.message ?? error))
        }
      }, [])

      useEffect(() => { void load() }, [load])

      // ONE scroll root wrapping the sheet: the slot clips, so the page owns the
      // scrollbar. Nothing between here and the guide panels may clamp a height
      // or hide overflow — the sheet grows with its content and the root scrolls.
      return h('div', {
        style: S.scroll,
        'data-connector-scroll': 'true',
        // A scrollable region, not an interactive one: keep it out of the tab
        // order while staying keyboard-scrollable once focused.
        tabIndex: -1,
      },
        h('div', { style: S.page, 'data-connector-page': 'true' },
          h('div', { style: S.head },
            h('div', { style: S.title }, t('page.title')),
            h('div', { style: S.sub }, t('page.sub')),
          ),
          note !== null && h('div', { style: { ...S.muted, color: T.error } }, note),
          h(StatusTab, { report, t, onChanged: load }),
        ),
      )
    }

    /** Sidebar glyph: a plug seating into a port — original artwork, currentColor. */
    function ConnectorIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
      },
        h('path', { d: 'M9 3v4M15 3v4' }),
        h('path', { d: 'M7 7h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5z' }),
        h('path', { d: 'M12 15v3' }),
        h('path', { d: 'M4 20h16' }),
        h('path', { d: 'M6 20v-1.5M18 20v-1.5' }),
      )
    }

    /** Only slots + locale: every fact comes from the host's /api/connector routes. */
    const inject = ['slots', 'locale']

    function apply(ctx) {
      // ONE dictionary: English. There is no zh half to register or to keep in sync.
      ctx.effect(() => ctx.locale.register(NS, { en: EN }), 'connector: dictionaries')
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ ctx, locale: ctx.locale }),
      }, ConnectorPage))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        // 20 is Personal VM (CUA); 21 is the smallest integer above it, so this
        // row renders directly beneath that one.
        order: 21,
        locale: NS,
        label: () => ctx.locale.bind(NS)('panel'),
      }, ConnectorIcon))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
