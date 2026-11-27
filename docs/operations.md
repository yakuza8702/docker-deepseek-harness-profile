# Operations — auto-update, security model, debugging, smoke test and factory reset

The lifecycle of the image itself: how it follows upstream, what it does and does not trust, how to debug it, and how to reset it. See the [README](../README.md) for image coordinates and credits.

## Auto-update workflow

`.github/workflows/docker-build.yml` keeps `:latest` in sync with the official project:

- **every 6h** (cron) it resolves the newest release on the selected **channel** and compares it against what's already on GHCR
- **the version pin is empty by default**: push and cron runs follow npm's `latest`
  dist-tag, so an upstream release lands in `:latest` with no commit here. Set the
  `DSH_VERSION_PIN` workflow env to a version string to freeze the image instead
  (that is how this repo ran while it was deliberately held on `0.1.7-rc.2`).
  The browser-use packages follow whatever version is resolved — if upstream ever
  publishes a core release before the matching browser-use release, the build
  falls back to that package's `next` tag and says so in the log
- **the cua CLI is `latest` unless you pin it**: each build resolves the newest
  `cua-sdk-v*` release from the GitHub API and fails rather than falling back;
  set `CUA_CLI_VERSION` (workflow env / repo variable / the `cua_cli_version`
  trigger input, or `--build-arg CUA_CLI_VERSION=0.7.0`) to pin one
- build key = `dsh <version>` + this repo's commit SHA → rebuilds only when **either** upstream releases a new version **or** this repo's Dockerfile changes
- pushes `linux/amd64` (default; arm64 opt-in via workflow input or `vars.DSH_PLATFORMS`) to `ghcr.io/<owner>/<repo>` with tags `latest`, `dsh-<version>`, `build-<version>-<sha8>`
- manual **Run workflow** button always available (`force_build` to bypass the skip check)
- uses only the built-in `GITHUB_TOKEN` — no secrets needed

Point your docker manager (watchtower/Portainer/etc.) at `ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest` and it will pick up every upstream update.

### Release channels

| Channel | Resolves | Build | Use when |
|---|---|---|---|
| `npm` (default) | `@deepseek-ai/dsh` `dist-tags.latest` on the npm registry | installs the official npm package (fast, slim, what runzhliu & smanx do) | normal operation. Caveat: GitHub-only pre-releases that were never published to npm can't be installed this way |
| `github-tag` | newest `dsh-v*` tag on the official GitHub repo — **includes pre-releases/alphas** | clones + builds the upstream monorepo from source (slow, much larger image) | you want bleeding-edge tags like `dsh-v0.1.2-alpha.1` that npm doesn't have |

Channel selection precedence: workflow input (manual run) > repository **variable** `DSH_CHANNEL` (Settings → Secrets and variables → Actions → Variables; also applies to the cron) > default `npm`.

Example reality check (Aug 2026): npm `latest` = `0.1.1-rc.2`; GitHub has `dsh-v0.1.2-alpha.1` as a source-only pre-release (no npm package, no release assets). With the default channel a push builds `0.1.1-rc.2`; run the workflow once with `channel=github-tag` to build the alpha from source. The moment `0.1.2` (rc or final) is published to npm `latest`, the default channel picks it up automatically.

### The sign-in durability fix is a source-channel patch

`patches/auth-fix.patch` repairs the account path — a durable identity across a
restart, a single 401 no longer deleting the stored grant, and an honest "Can't
reach DeepSeek right now / Try again" card instead of a blank one. It is a diff
against the upstream **TypeScript sources**, so an image can only carry it on the
**source** channel: the `dsh-fetch` stage applies it after the clone and before
`pnpm run build` (`DSH_SIGNIN_FIX=1`, the default), then verifies the compiled Host
lib carries it. Either step failing stops the build; `DSH_SIGNIN_FIX=0` builds the
source tree unpatched (debugging only) and the entrypoint then warns at boot.

Consequence for this repository's automation: to keep `:latest` carrying the fix,
build with `channel=github-tag` — the workflow input, or the repository variable
`DSH_CHANNEL=github-tag` so the cron does it too. The tag must be
`dsh-v0.2.3-alpha.2` (commit `4b399c39`) or newer; on a newer tag the applier warns
that the patch was verified on `4b399c39` only, and still refuses to continue if a
hunk does not apply. Base commit, scope and the update procedure:
[patches/README.md](../patches/README.md).

## Security model

- **Non-root** (uid/gid 1000), rootfs read-only, `cap_drop: ALL`, `no-new-privileges`, `/tmp` tmpfs — in the provided `compose.yaml`
- DSH state (profiles/credentials/sessions/plugins) persists in the `dsh-home` volume at `/home/node/.dsh`; only `/workspace` (the agent's world) is a bind mount
- The Web UI runs `dsh web`, which has **its own per-boot token auth** (printed to the container log as `dsh web: http://…/?token=…`); the proxy auto-mints sessions for browsers (zero-auth LAN). **Consequence: any device on the LAN can open the UI** — it executes code, so add Basic Auth (`PROXY_USERNAME` + `PROXY_PASSWORD`) if that is not acceptable, and never expose to the public internet
- **The browser desktop is the same trust boundary as the UI.** It is served on the UI's port, behind the same auth, and it drives a real browser holding your logins — whoever reaches the URL reaches the browser. Keep it behind Pangolin/Badger or Basic Auth, and treat the `dsh-home` volume as credential material (the browser profile lives in it)
- Docker socket access is opt-in and widens the trust boundary — prefer the filtered TCP proxy

## Debugging with the read-only rootfs

`read_only: true` locks the image layers (`/usr`, `/etc`, `/opt`, ...). The harness itself stays fully functional — all of its state is on mounts: the `dsh-home` volume (`/home/node/.dsh` — settings, sessions, credentials, plugins), the `/workspace` bind, and the `/tmp` tmpfs. If you need to poke at system paths (e.g. test an apt install or edit image files), create a local `compose.override.yaml` (compose merges it automatically; it is git-ignored):

```yaml
# compose.override.yaml — local debugging only, do not commit
services:
  seek-harness:
    read_only: false
```

`docker compose up -d` then recreates the container with a writable rootfs; delete the file to return to the hardened posture. Need another persistent path (logs, exports)? Add a volume/bind for it in the same way rather than disabling `read_only` globally.

## Smoke test

```bash
docker run --rm --entrypoint dsh ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest --version   # prints pinned DSH version
docker run --rm --entrypoint bash ghcr.io/yakuza8702/docker-deepseek-harness-profile:latest -c \
  'docker --version && docker compose version && pnpm --version && uv --version && bwrap --version'
docker compose up -d && curl -fsS http://127.0.0.1:3080/ && docker compose ps   # healthy
```

## Factory reset — what it actually does

The recovery page (`/__recovery/page`, reachable whenever the harness is down or
its browser half fails to load) has a **Reset data and restart** action. Because
the data directory is a **mount**, it cannot be moved aside — `rename()` of a
mount point fails with `EBUSY`, and `/tmp` is a different filesystem (`EXDEV`).
The reset therefore clears the data directory **in place**, one top-level entry
at a time, and then restarts the stack (a wiped home is only adopted by a new
process):

| Removed | Kept |
|---|---|
| conversations (`sessions/`), other profiles, `settings.yaml`, plugin installs (`node_modules`, `dependencies`), the browser profile, logs, caches, plugin stores | `.credentials.yaml` (so the harness still reaches a model — Safe Mode carries the same file over), `.recovery-checkpoints/` including a checkpoint taken just before the reset, and the shipped `web` profile |

Inside the shipped profile, the **authored** files survive
(`cordis.patch.yml`, `cordis.yml`, `pnpm-workspace.yaml` — your patch layer and
pnpm settings) while `package.json` is rebuilt to the shipped default and
generated artefacts (`pnpm-lock.yaml`) are dropped: plugin installs live in
`dependencies` + `dsh.profile.bundles`, and their `node_modules` is gone, so a
manifest kept as-is would advertise bundles that no longer exist. Everything is
recoverable *as configuration* through the Rollback tab; the data itself is not
recoverable, which is what the confirmation dialog says. Project files outside
the data directory (the workspace mount) are never touched.
