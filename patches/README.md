# Source patches applied to the DSH monorepo

The image normally installs the official **npm** release of `@deepseek-ai/dsh`
(`/opt/dsh`). A defect that lives in the upstream **TypeScript sources** can only
be fixed where those sources are built: the **source channel**
(`DSH_SOURCE_REF=<github tag>`, which clones
`deepseek-ai/deepseek-harness` into `/src` and runs `pnpm run build`).

This directory holds those fixes as unified diffs against the upstream monorepo.
They are applied by `tools/apply-dsh-source-patches.mjs` from the `dsh-fetch`
stage of the [Dockerfile](../Dockerfile), **before** `pnpm install` / `pnpm run
build`, and the same script proves afterwards that the compiled Host lib carries
them.

| Patch | Base commit | Tag | Files |
|---|---|---|---|
| [`auth-fix.patch`](auth-fix.patch) | `4b399c39a6d1479cd84ca591b4d7c88e24d38a96` | `dsh-v0.2.3-alpha.2` | 26 files, +1394 / −102 |

## `auth-fix.patch` — what it fixes

Four user-visible defects in the DeepSeek account (sign-in) path, plus a
Host-survival hardening on the same surface:

1. **A sign-in is lost on restart.** The account rendered from the grant alone;
   the identity came from a Platform read at boot, so an unreachable Platform at
   startup showed a signed-out / empty card until a read succeeded. The profile
   is now written beside the grant (and seeded back on boot), so a restart shows
   the known account immediately and only a *ready* read replaces it.
2. **A single HTTP 401 removes the credential (403 / "logged out" storms).** One
   rejection — a proxy, a clock skew, a platform edge — used to delete the stored
   grant irreversibly. A rejection now only records a *strike*; the grant is
   removed when a **second** rejection of the same token arrives at least one
   `requestTimeoutMs` later and outside the boot grace (`attemptTimeoutMs`). A
   ready profile read, a new sign-in, or a completed removal clears the run.
3. **A fresh browser session or a second device reads as signed out.** The grant
   was on disk, but the identity behind the card came from a Platform read, so a
   new cookie jar (and a restarted container whose Platform egress is blocked)
   rendered signed out. `getProfile` now answers the persisted identity first —
   no Platform round-trip in the read path — and refreshes it in the background;
   the refresh is coalesced and shares the failure window, and a ready answer
   replaces the disk seed so later reads take the ordinary path.
4. **A page reload can exit the Host.** A browser that reloads or navigates away
   aborts its `/api` response; that abort was able to surface as a fatal
   unhandled rejection (`dsh: fatal load failure: DOMException [AbortError] …
   at ServerResponse.<anonymous> (client/connection/lib/index.js)`). The bridge
   now cancels with a marked `AbortError` (`ClientDisconnectedError`), settles
   quietly when a handler or body observes it, writes nothing to the dead
   socket, and `installFailLoud` ignores that marked reason — a client teardown
   can never take the process down.
5. **The settings card can stay blank when the account is unreachable.** The
   account section now mounts while the state is *unknown* (no frame yet, or a
   failed carrier), offers "Can't reach DeepSeek right now / Try again", and the
   retry shares the grant handle so a revoked grant starts no read and publishes
   nothing.

It also **bounds the read rate against a destination that rejects every request**
(the 202 `stage=parse-json` storm a WAF/edge challenge produced in the field):
one unreachable answer is retried at once, but a *run* of consecutive failures
for one field opens a doubling window (5 s → 60 s) in which profile and wallet
reads replay their last outcome without another round trip, so a broken
destination is probed rather than hammered. The identity write-back also no
longer re-arms itself on a cache invalidation (its fingerprint is token-scoped
and survives invalidation), so a credentials event can never drive a
read → write → event → invalidate cycle.

It also makes the credential-change listener suppress only a write-back it can
verify (a sign-out, a re-authorization, another process's edit still invalidates),
keeps the identity fingerprint across failed writes, and switches the expiry /
boot clocks to `performance.now()`.

Base upstream commit: **`4b399c39`** = tag **`dsh-v0.2.3-alpha.2`**. The patch
applies cleanly to that tree and fails the build loudly if it stops applying;
when the source ref is a *newer* tag the applier warns (the patch is then applied
against a tree it was not verified on) and still refuses to continue if any hunk
does not apply.

## How it is wired

```dockerfile
# dsh-fetch stage, source channel only; DSH_AUTH_FIX defaults to 1
git clone --depth 1 --branch "${DSH_SOURCE_REF}" … /src
node /tmp/apply-dsh-source-patches.mjs /src --patch /tmp/auth-fix.patch --expect-base 4b399c39 --auth-fix 1
pnpm install && pnpm run build
node /tmp/apply-dsh-source-patches.mjs /src --verify-built --patch /tmp/auth-fix.patch --auth-fix "${DSH_AUTH_FIX}"
```

`--verify-built --auth-fix 0` is the stock build's proof: it fails unless the
compiled artifact carries *none* of the patch's markers, so a `DSH_AUTH_FIX=0`
image cannot silently ship a half-applied tree.

* **Idempotent** — `git apply --check` first; if the patch is already applied
  (`--reverse --check` succeeds) it is skipped and the build continues.
* **Fail-loud** — an unapplicable patch, a non-git tree, or a built artifact
  without the expected markers stops the build.
* `DSH_AUTH_FIX` (build arg) is the switch: `1` (default) applies and verifies the
  patch; `0` ships **stock upstream** — the applier refuses to patch, writes
  provenance `status: "off"`, and the post-build check proves the compiled artifact
  carries none of the patch's markers. `docker build --build-arg DSH_AUTH_FIX=0`
  is therefore a supported way to publish an unpatched 0.2.3-alpha.2 image; the
  entrypoint then logs `auth fix: off` instead of the active-fix line.
* The patch is shipped read-only at `/opt/seek-harness/patches/auth-fix.patch`,
  and the build records provenance in `/src/.dsh-profile-patches.json`; the
  entrypoint logs one line at boot (`auth fix: active …`) and warns when a
  source-channel image was built without it.

## The npm channel does not carry this fix

`@deepseek-ai/dsh` on npm ships compiled JavaScript; a source patch cannot be
applied to it. An image built on the default **npm** channel therefore runs
upstream's behaviour and the entrypoint stays silent about the fix. To build an
image **with** the fix:

```bash
# local
docker build --build-arg DSH_SOURCE_REF=dsh-v0.2.3-alpha.2 -t seek-harness:auth-fix .

# GitHub Actions
#   Actions → docker-build → Run workflow → channel = github-tag
#   (or set the repository variable DSH_CHANNEL=github-tag)
```

The tag must be `dsh-v0.2.3-alpha.2` or newer; a newer tag is applied with the
warning described above.

## Verifying without a build

```bash
# the same check the build runs, against any checkout of the monorepo
node tools/apply-dsh-source-patches.mjs /path/to/deepseek-harness --dry-run \
  --patch patches/auth-fix.patch --expect-base 4b399c39

# idempotency: a second run is a no-op
node tools/apply-dsh-source-patches.mjs /path/to/deepseek-harness --patch patches/auth-fix.patch
node tools/apply-dsh-source-patches.mjs /path/to/deepseek-harness --patch patches/auth-fix.patch

# offline unit test of the applier (no network, no image)
node tests/modules-unit.mjs
```
