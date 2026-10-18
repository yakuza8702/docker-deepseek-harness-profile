# `dsh-workspace-browser` (vendored)

A workspace file manager for the DeepSeek Harness Web UI. It adds a sidebar
action, directory navigation, breadcrumbs, metadata, bounded text previews,
text editing, and create, rename, and delete controls.

## Vendored from runzhliu, ported to DSH 0.2.0 (`seek-harness`)

This directory is copied from
[`runzhliu/deepseek-harness-docker`](https://github.com/runzhliu/deepseek-harness-docker)
(`plugins/dsh-workspace-browser`). The plugin lives on his **unmerged**
`feat/workspace-browser-crud` branch and is **not published to npm**, so vendoring
is the only way to use it. Changes made here:

| Change | Why |
|---|---|
| Renamed `@runzhliu/dsh-workspace-browser` → **`dsh-workspace-browser`** (package name, `__ModuleLoader__.load` id and the bundle patch all match) | Same convention as `dsh-profile-switcher` and `dsh-browser-desktop` |
| `dsh.client.inject`: `@deepseek-ai/dsh-client-runtime` → **`@deepseek-ai/dsh-client-modules`** | The plugin was written against the DSH **0.1.0-rc.6** client runtime; that package does not exist in 0.2.0 — `dsh-client-modules` is its successor and is what the shipped client packages inject |
| `peerDependencies` widened to `^0.1.2-alpha.3 \|\| ^0.2.0-rc.1` | Matches the two client-module runtime lines DSH has shipped, exactly as `dsh-browser-desktop` 0.1.4 does |

Everything else — the host routes, the path/symlink confinement, the CRUD logic and
the whole client half — is upstream's and unmodified. The host half needed no
changes: `ctx.webServer.register({kind:'exact', path, handler})` and `ctx.effect(...)`
are the same in 0.2.0, and the client half's
`ctx.slots.inject('sidebar.footer.action' | 'shell.overlay', …)` registration shape
(`{name, id, order, label}`) is still supported by `dsh-client-ui-slots`.

`workspace.test.js` is upstream's own suite and runs unmodified against the ported
host half: `node --test plugins/dsh-workspace-browser/workspace.test.js` — 8/8,
covering traversal, escaping symlinks, root protection, write limits, optimistic
mtime conflict detection and recursive-delete confirmation.

### Sidebar entry (this image only)

The client half's `sidebar.footer.action` registration is the one part that is **not**
upstream's any more. Here the control is an **icon-only 36×36 folder glyph at the
trailing edge of the Settings row**, registered in `sidebar.footer.trailing` — a slot
this image adds to the sidebar at build time (see `tools/patch-sidebar-footer.mjs`).
The workspace overlay itself, and every endpoint below, are untouched.

`sidebar.footer.action` is one flex row shared by every footer action, so a second
registration there (the provider-usage panel in this deployment) competes for width and
the icons overlap in the ~56px collapsed rail; and `sidebar.settings` is `kind: "single"`
upstream, so the trailing slot is what creates the seat beside Settings. The glyph
matches the profile control next to it. See
`plugins/dsh-browser-desktop/README.md` for the full table of both states.

The Host half serves these endpoints:

- `GET /workspace-browser/list?path=<relative-path>` lists a directory.
- `GET /workspace-browser/file?path=<relative-path>` reads a bounded preview.
- `PUT /workspace-browser/file` updates a text file with an optional mtime precondition.
- `POST /workspace-browser/entry` creates a file or directory.
- `PATCH /workspace-browser/entry` renames or moves an entry.
- `DELETE /workspace-browser/entry` deletes an entry; recursive directory deletion must be explicit.

Every request is resolved under the configured workspace root. Parent traversal
and symbolic links escaping that root are rejected, and symbolic links cannot
be mutated. Mutation requests must be same-origin JSON. Text previews default
to 512 KiB, writes to 1 MiB, and directories to 2,000 entries.

## Install

There is nothing to install: the image copies this package into the DSH
installation's `node_modules`, declares it in the installation manifest, and mounts
it for every profile through `/opt/seek-harness/workspace-browser.overlay.yml`
(applied by the entrypoint as a `--patch` overlay, like the other two plugins).
`DSH_WORKSPACE_BROWSER_ENABLED=0` removes the row at boot without rebuilding.

Upstream's own `dsh plugin --profile web add …` instructions do not apply: the
package is not published.

## Configuration

```yaml
- id: workspace-browser
  name: 'dsh-workspace-browser'
  config:
    root: '/workspace'
    maxEntries: 2000
    maxPreviewBytes: 524288
    maxWriteBytes: 1048576
```

Each field is settable from the container environment
(`DSH_WORKSPACE_ROOT`, `DSH_WORKSPACE_MAX_ENTRIES`, `DSH_WORKSPACE_MAX_PREVIEW_BYTES`,
`DSH_WORKSPACE_MAX_WRITE_BYTES`); the overlay reads them at boot.

## Security

This plugin deliberately permits writes inside its configured root. It does not
turn the Harness Web UI into a safe multi-tenant file service: users who can
access DSH can create, edit, rename, and recursively delete workspace content,
and may already have Shell or Agent tool access. Keep Harness behind a trusted
local, Tailnet, or authenticated gateway boundary, mount only the intended
workspace, and rely on version control or backups for recovery.

## License

MIT
