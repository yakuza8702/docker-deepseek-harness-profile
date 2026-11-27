# Overrides directory (`overrides/`)

Local build-time overrides, and the rule that keeps them out of a release. See the [README](../README.md) for the image coordinates.

The `overrides/` folder used to hold bind-mounted patches that fixed or extended
the upstream image without rebuilding it. It is **empty now — and deliberately
so.** Every patch that used to live here either landed upstream or in this
image's own copy of the file, and a stale override silently shadows the image,
which is a worse failure than the one it patches. Do not add a file here without
a date, a reason and a removal condition.

> **Removed 2026-11-26:** `overrides/settings-index.js` (616 lines) and its
> compose bind-mount to
> `/opt/dsh-src/packages/settings/settings/lib/index.js`. It was a full fork of
> upstream's settings module that only existed for one line — a re-export of
> `settingsNamespace`, which upstream made internal in 0.1.2-alpha.3. Nothing in
> this tree imports that name, and the mount meant every later upstream settings
> fix was served by a stale copy instead. Delete any
> `./overrides/settings-index.js` line from an existing compose file; the image's
> own module is authoritative.

> **Removed 2026-10-01:** `overrides/proxy.mjs` (and its compose bind-mount). It
> carried the 2026-09-01 dotted-chain regex fix as a runtime patch over the image
> copy — but `docker/proxy.mjs` in the image has owned that fix since, plus the
> recovery surface, the client-boot watchdog and the `/desktop` route, so the stale
> 415-line copy was silently shadowing every later proxy change. The image copy is
> authoritative again; drop any `./overrides/proxy.mjs` line from an existing
> deployment or the browser desktop path will 404.

> **Removed 2026-10-02:** `overrides/landlock-run/` (the hand-built static
> `landlock-run` binary) and its compose bind-mount. The launcher now comes from
> the published platform package
> `@deepseek-ai/node-addon-system-<platform>-<arch>` — the exact package and path
> the runtime resolves through `launcherPath()` — and
> `tools/ensure-landlock-launcher.mjs` guarantees it during the build and **fails
> the build** unless `landlock-run --probe` reports `full`/`partial`. The old
> mount pointed at a source-channel path (`/opt/dsh-src/native/landlock-run/…`)
> that does not exist in an npm-channel image, so it shadowed nothing while
> making a fresh start look like it needed a manual download. Delete the
> `./overrides/landlock-run/…` line from an existing compose file: confined
> permission modes (`read-only`, `workspace-write`) work with no mount at all.

To remove an override: delete the file and remove the `- ./overrides/...` line
from compose.yaml. There is nothing else to undo — the override never touched
`$DSH_HOME`, so no profile or patch layer has to be edited (an earlier version of
this section told you to re-enable `disabled: true` rows in
`dsh-home/profiles/web/cordis.patch.yml`; those rows do not exist in this tree and
never did).
