# dsh-browser-mcp — the browser tooling as one switchable MCP row

The container's browser automation, exposed the way every other tool source in
DSH is: **one `@deepseek-ai/dsh-mcp-client` row** that you can see and switch off
in the Plugin list.

| | |
|---|---|
| Row id | `browser-mcp` |
| Module | `@deepseek-ai/dsh-mcp-client` |
| Server name | `playwright-mcp` (this is the tool namespace) |
| Tools | `mcp__playwright-mcp__browser_*` — **identical names** to the old provider |
| Attaches to | the visible Brave desktop this image runs, over CDP (`127.0.0.1:$DSH_CDP_PORT`) |

## Why it exists

The browser tools used to come from
`@deepseek-ai/dsh-browser-use` + `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`,
mounted by a **launcher overlay** — and a row mounted that way can never be
switched off: the overlay is applied *after* the profile layer, so it re-declares
the row enabled no matter what the user (or the Plugin list) writes into their
own profile patch. Measured with `dsh --profile web --patch … --dump-config`: a
profile-level `- id: browser-use` / `disabled: false` override is simply ignored.

The consequences were real: ~10k tokens of static context in **every** Session,
one MCP process per activated Session (~110–130 MB each), and upstream's attach
mode reserving the browser for a single Session — which this fork had to patch
out of the provider's code.

Going through `dsh-mcp-client` instead fixes all four at once:

* the row is an ordinary **plugin row** in the Plugin list, with a switch;
* switching it off removes the server, the tools and the token cost entirely —
  and it is **live** (the profile patch is watched), so no restart is needed;
* it costs **one** MCP process for the whole harness, not one per Session;
* a plain MCP client has no exclusive attach mode, so the upstream patch is no
  longer needed on this path.

## How it is installed

`docker/entrypoint.sh` seeds this directory's `cordis.patch.yml` into the
profile's own patch layer (`$DSH_HOME/profiles/<name>/cordis.patch.yml`) **once
per home**, marker-guarded (`.browser-mcp-row-seeded`). Seeding into the profile
layer is the whole point: that is the file the Plugin list writes to, so the
switch wins.

A fresh home gets it on the first boot — the entrypoint initialises the shipped
`web` profile with DSH's own `initProfile()` before the harness starts, so the
row exists when the tree is first composed.

## Switches

| Variable | Default | Meaning |
|---|---|---|
| `DSH_BROWSER_MCP` | `1` | `0` = do not seed the row at all (no browser tools) |
| `DSH_DESKTOP_ENABLED` | `1` | `0` = no desktop stack, and the row is disabled with it |
| `DSH_CDP_PORT` | `9222` | the browser's DevTools port inside the container |
| `DSH_BROWSER_MCP_TIMEOUT` | `60000` | per-tool-call timeout in ms |

Runtime switch: **Plugin list → `browser-mcp` → off/on.** The plugin manager
writes `- id: browser-mcp` / `disabled: true|false` into the same profile patch,
and the loader recomposes immediately.

## Alternative: the official provider

The overlay still carries the provider rows, switched **off** by default. Set
`DSH_BROWSER_USE_PROVIDER=1` to use them instead (per-Session tools, one process
per Session, single-owner attach unless `DSH_BROWSER_USE_EXCLUSIVE=0`). Do not
enable both: they would offer the same tool names from two servers.
