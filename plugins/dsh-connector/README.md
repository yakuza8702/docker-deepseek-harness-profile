# dsh-connector — GitHub, Cloudflare and Gitea for the model

The connector as a **built-in bundle**: six `connector_*` agent tools, the
`/api/connector` Host routes, one `tool:connector` system-prompt section, and one
sidebar page (`Connector`, order 21 — directly under **Personal VM (CUA)** at 20).

This package is the `@local/connector` plugin from the source checkout, renamed
and installed by the image. The rename is functional, not cosmetic: the loader
mounts a patch row by **package specifier**, every built-in bundle in this image
is a bare package name, and `@local/...` is not a name any installation can
resolve.

## What the row gives the model

| Tool | Purpose |
|---|---|
| `connector_status` | which providers/aliases resolve, whether the token is LIVE or EXPIRED, and the reference NAMES only (`liveness:false` / `rateLimit:false` skip the probes) |
| `connector_repos_list` | repositories the alias can see |
| `connector_repo_actions` | issues, PRs, labels, assignees, branches, tags, workflow runs, `pr_merge` |
| `connector_file` | read a tree, read a file, commit a file (`sha` replaces, absent creates) |
| `connector_cloudflare` | zones, DNS, WAF, Access, analytics, DDoS, botnet feed, Pages deploy |
| `connector_push` | `wrangler deploy` for a Pages project (`dryRun:false` only) |

`READ ✓` calls are unrestricted; every `WRITE ⚠` is approval-gated. A write is
pre-flighted with one cheap identity call, so a dead token is refused *before*
the request (HTTP 401, "no write was attempted") instead of surfacing later as a
provider 401.

The GitHub device flow asks for `repo workflow` by default (`githubRequestedScopes`);
a login that grants neither still succeeds but yields an identity-only token, so
the panel prints the granted scopes and warns when `repo` is missing. A push the
git transport refuses for want of Contents write is classified as
`CONNECTOR_PUSH_FORBIDDEN` (HTTP 403, authenticated-but-not-allowed) and names the
OAuth App permission screens, never re-labelled as a dead token.

**No secret is ever in this package.** Configuration carries credential
*reference names* (`GITHUB_TOKEN`), never values: DSH resolves a reference per
call, and the value is handed to one request's `Authorization` header. It is never
returned, logged, displayed, measured or masked — a mask is still an oracle.

## Installed as a built-in (not a marketplace plugin)

`plugins/dsh-connector/` is copied into **both** installation roots at build time
(`/opt/dsh/node_modules/dsh-connector` and `/opt/dsh-src/node_modules/dsh-connector`)
and declared in each installation's own `package.json`, exactly like
`dsh-cua-vm` and `dsh-office`. That is why it can be mounted by bare name from ANY
profile, and why it appears **once**, in the top section of the Plugins page next
to "Personal VM (CUA)" — never under "Installed plugins" and never in the market
(`tools/patch-plugin-manager-page.mjs` keeps it out of the page's own list).

Selection — the half that composes the row — lives in `dsh.profile.bundles` and
is seeded once per home by `docker/entrypoint.sh:seed_connector_bundle`. A home
the pre-rename image seeded with `"@local/connector": "link:…/plugin/connector"` is
repaired on boot: only a `link:` whose path suffix is `/plugin/connector` is
dropped, so a user's own pin (any other spec or path) is left alone.

## Switches

| Variable | Effect |
|---|---|
| `DSH_CONNECTOR=0` | the patch row is `disabled:` — no connector tools, routes or prompt section |
| `CONNECTOR_WORKSPACE_ROOT` | the only tree `connector_push` may read (default `/workspace`) |

Switching the row off in the Plugins page releases the tools, the routes and the
prompt section from the next request. Nothing stored is touched: no credential is
read, moved, or deleted.

## Wiring

| Piece | Where |
|---|---|
| bundle patch (`id: connector`, `name: dsh-connector`) | `cordis.patch.yml` |
| host half (tools, routes, prompt) | `index.js`, `lib/` |
| client half (sidebar row + page) | `client.js` — loader id `dsh-connector` |
| Plugins-page switch | `plugins/dsh-plugins-page-extras` (`{ id: 'connector', bundle: 'dsh-connector' }`) |
| boot selection + migration | `docker/entrypoint.sh` (`seed_connector_bundle`, `drop_connector_profile_link`) |
| build gate | `tools/check-connector.mjs` |
