# syntax=docker/dockerfile:1
# =====================================================================
# seek-harness — hardened DeepSeek Harness container
#
# Provenance:
#   * Official upstream : @deepseek-ai/dsh npm package (deepseek-ai/deepseek-harness)
#   * smanx             : complete devtools package set + the "0.0.0.0 fix"
#                         (built-in Node reverse proxy 0.0.0.0 -> 127.0.0.1 with
#                         HTTP+WS forwarding, optional Basic Auth, and a
#                         crypto.randomUUID polyfill for non-secure LAN pages)
#   * runzhliu          : security hardening (non-root UID 1000, tini, fixed
#                         pnpm, build-time version pin+verify, HOME=/workspace
#                         dir-selector fix, --expose-internals only for the DSH
#                         main process). Its Chromium/Xvfb/noVNC desktop stack is
#                         adopted here (see "browser desktop" below), with Brave
#                         instead of Chromium and a SINGLE public port.
#   * This repo         : Docker access — pass a mounted docker.sock (with
#                         group_add) OR a Docker proxy over TCP via
#                         DOCKER_HOST env var. docker CLI + compose plugin
#                         included.
#
# Base: node:24-trixie (Debian 13, glibc 2.41, non-slim buildpack-deps) —
# chosen by runzhliu so newer prebuilt agent binaries keep working.
# =====================================================================

ARG NODE_IMAGE=node:24-trixie

# ---------------------------------------------------------------------
# Stage 1 — obtain the OFFICIAL DeepSeek Harness release, pin and verify
# the exact version at build time (runzhliu pattern).
#
# Two channels (see README "Release channels"):
#   DSH_SOURCE_REF=""           -> npm channel: install @deepseek-ai/dsh
#                                  <DSH_VERSION> from the npm registry
#                                  (DEFAULT — what runzhliu & smanx do)
#   DSH_SOURCE_REF=<github tag> -> source channel: clone the official repo
#                                  at that tag (e.g. dsh-v0.1.2-alpha.1)
#                                  and build the monorepo. For GitHub
#                                  pre-releases/alphas that are not (yet)
#                                  published to npm. Slower, larger image.
# ---------------------------------------------------------------------
FROM ${NODE_IMAGE} AS dsh-fetch
ARG DSH_VERSION=latest
ARG DSH_SOURCE_REF
WORKDIR /opt/dsh
RUN mkdir -p /opt/dsh /src

# npm channel
RUN if [ -z "${DSH_SOURCE_REF}" ]; then \
      npm init -y >/dev/null 2>&1 \
   && npm install --omit=dev --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}" \
   && node -p "require('/opt/dsh/node_modules/@deepseek-ai/dsh/package.json').version" > /opt/dsh/.dsh-version \
   && echo "fetched @deepseek-ai/dsh $(cat /opt/dsh/.dsh-version) (npm)" \
   && /opt/dsh/node_modules/.bin/dsh --version; \
    fi

# source channel (github tag, incl. pre-releases/alphas missing from npm)
RUN if [ -n "${DSH_SOURCE_REF}" ]; then \
      apt-get update && apt-get install -y --no-install-recommends git python3 \
   && rm -rf /var/lib/apt/lists/* \
   && git clone --depth 1 --branch "${DSH_SOURCE_REF}" https://github.com/deepseek-ai/deepseek-harness.git /src \
   && npm install -g --no-audit --no-fund pnpm@10 \
   && cd /src \
   && (pnpm install --frozen-lockfile || pnpm install) \
   && pnpm run build \
   && node -p "require('/src/package.json').version" > /src/.dsh-version \
   && echo "built @deepseek-ai/dsh $(cat /src/.dsh-version) (source ${DSH_SOURCE_REF})" \
   && node /src/apps/cli/lib/bin.js --version; \
    fi

# ---------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------
FROM ${NODE_IMAGE}
ARG DSH_VERSION=latest
ARG DSH_SOURCE_REF
ARG PNPM_VERSION=10
ARG TARGETARCH=amd64
LABEL org.opencontainers.image.title="seek-harness" \
      org.opencontainers.image.description="Hardened DeepSeek Harness container — smanx devtools + 0.0.0.0 reverse-proxy fix + runzhliu hardening + docker.sock/TCP support + official Browser Use with a visible Brave desktop on the SAME port (path-routed, human takeover)" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/yakuza8702/docker-deepseek-harness" \
      org.opencontainers.image.version="${DSH_VERSION}"

ENV NPM_CONFIG_CACHE=/tmp/.npm-cache \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# smanx devtools-latest package set (merged with runzhliu extras):
#   smanx devtools-latest : git curl wget nano jq procps ca-certificates unzip
#                           vim openssh-client zip htop tmux tree openssl
#                           python3 build-essential bash-completion + pnpm + uv
#   runzhliu extras       : less ripgrep rsync (build-essential/git/curl/...
#                           already ship inside node:24-trixie buildpack-deps)
#   this build            : docker-ce-cli + docker-compose-plugin (socket/TCP
#                           engine access), tini (init, orphan reaping),
#                           bubblewrap (DSH Linux bwrap sandbox backend)
#   browser desktop       : the virtual display + VNC stack the visible browser
#                           runs on (Xvfb -> openbox -> x11vnc -> websockify +
#                           noVNC). Same set runzhliu ships: x11-utils provides
#                           xdpyinfo (the entrypoint waits for the display with
#                           it) and the fonts keep real web pages readable,
#                           including CJK.
RUN set -eux; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" \
      > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      nano jq unzip vim zip htop tmux tree openssl python3 bash-completion \
      less ripgrep rsync procps ca-certificates \
      tini bubblewrap \
      docker-ce-cli docker-compose-plugin \
      xvfb x11vnc x11-utils openbox websockify novnc \
      fonts-liberation fonts-noto-cjk; \
    rm -rf /var/lib/apt/lists/*

# Brave — the browser the desktop runs (user's choice; it is also the browser
# they use locally). Installed from Brave's official APT repository, added here
# explicitly with its keyring rather than via a curl|bash installer.
#   * Shields do ad blocking natively, so no ad-block extension is needed
#   * Chrome Web Store extensions still install normally
#   * ANY Debian Chromium fork would work; swap this block for
#     `apt-get install chromium` to drop the third-party repo.
ARG BRAVE_APT_URL=https://brave-browser-apt-release.s3.brave.com
RUN set -eux; \
    install -m 0755 -d /usr/share/keyrings; \
    curl -fsSL --retry 3 -o /usr/share/keyrings/brave-browser-archive-keyring.gpg \
      "${BRAVE_APT_URL}/brave-browser-archive-keyring.gpg"; \
    chmod 0644 /usr/share/keyrings/brave-browser-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] ${BRAVE_APT_URL}/ stable main" \
      > /etc/apt/sources.list.d/brave-browser-release.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends brave-browser; \
    rm -rf /var/lib/apt/lists/*; \
    brave-browser --version

# uv (static binary) — many community DSH MCP servers launch via "uvx"
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh \
 && uv --version

# pnpm pinned at build (required by `dsh plugin ...` and plugin marketplaces)
RUN npm install -g --no-audit --no-fund "pnpm@${PNPM_VERSION}" \
 && pnpm --version

# Official DSH release from stage 1 + CLI on PATH (version re-verified here).
#   npm channel    -> /opt/dsh/node_modules/.bin/dsh
#   source channel -> /opt/dsh-src (cloned + built monorepo incl. node_modules)
COPY --from=dsh-fetch /opt/dsh /opt/dsh
COPY --from=dsh-fetch /src /opt/dsh-src
RUN if [ -f /opt/dsh/node_modules/.bin/dsh ]; then \
      ln -sfn /opt/dsh/node_modules/.bin/dsh /usr/local/bin/dsh \
   && echo "installed @deepseek-ai/dsh $(cat /opt/dsh/.dsh-version) (npm)"; \
    else \
      ln -sfn /opt/dsh-src/apps/cli/lib/bin.js /usr/local/bin/dsh \
   && echo "installed @deepseek-ai/dsh $(cat /opt/dsh-src/.dsh-version) (source)"; \
    fi \
 && dsh --version

# ---------------------------------------------------------------------
# Official Browser Use — the model-facing half of the browser stack.
#
# The browser-use packages are published SEPARATELY from the core and carry
# their own dist-tags, so they are installed at the CORE's resolved version:
# their `latest` tag lags the core (0.1.6-alpha.1 while the core is 0.2.0-rc.2),
# and installing a mismatched pair fails at load time. If a future core release
# has no matching browser-use release yet, the build falls back to the package's
# `next` tag and says so loudly instead of failing — which is what keeps the
# unpinned, auto-following build in the workflow working.
#
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 is load-bearing: @playwright/mcp depends on
# the full `playwright` package, whose install script downloads Chromium,
# Firefox and WebKit (~500 MB) that this image never uses — the provider runs in
# ATTACH mode against the desktop browser over CDP.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# The packages are installed into a SCRATCH prefix and then merged in, rather
# than `npm install --prefix /opt/dsh ...`: a plain install re-resolves the
# installation's whole dependency tree, which would silently upgrade the very
# core version stage 1 pinned and verified. Packages the core already provides
# are kept at the core's version (the peers are satisfied by it by construction);
# only genuinely new packages are copied in.
RUN set -eux; \
    if [ -f /opt/dsh/.dsh-version ]; then T=/opt/dsh; else T=/opt/dsh-src; fi; \
    V="$(cat "$T/.dsh-version")"; \
    BU="$V"; \
    if ! npm view "@deepseek-ai/dsh-browser-use@${BU}" version >/dev/null 2>&1; then \
      BU="$(npm view '@deepseek-ai/dsh-browser-use' dist-tags.next 2>/dev/null || true)"; \
      echo "WARNING: @deepseek-ai/dsh-browser-use@${V} is not published; falling back to the 'next' tag (${BU}) — the browser integration may not match the core runtime"; \
    fi; \
    [ -n "$BU" ] || { echo "ERROR: could not resolve any browser-use version"; exit 1; }; \
    echo "browser-use ${BU} (core ${V}) -> ${T}/node_modules"; \
    SB=/tmp/browser-use-install; rm -rf "$SB"; mkdir -p "$SB"; \
    cd "$SB"; \
    npm init -y >/dev/null 2>&1; \
    npm install --omit=dev --no-audit --no-fund \
      "@deepseek-ai/dsh-browser-use@${BU}" \
      "@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@${BU}"; \
    for p in "$SB"/node_modules/* "$SB"/node_modules/@*/*; do \
      [ -e "$p" ] || continue; \
      rel="${p#"$SB"/node_modules/}"; \
      if [ -e "$T/node_modules/$rel" ]; then \
        echo "kept the core copy of $rel"; \
      else \
        mkdir -p "$(dirname "$T/node_modules/$rel")"; \
        cp -a "$p" "$T/node_modules/$rel"; \
        echo "added $rel"; \
      fi; \
    done; \
    rm -rf "$SB"; \
    node -e 'const p=process.argv[1];for(const n of ["@deepseek-ai/dsh-browser-use","@deepseek-ai/dsh-experimental-browser-use-playwright-mcp"]){console.log("installed",n,require(p+"/node_modules/"+n+"/package.json").version)}' "$T"

# ---------------------------------------------------------------------
# Make the attached browser usable from EVERY Session instead of exactly one.
#
# Upstream passes `exclusive: config.mode === "attach"`, which reserves the
# browser for a single live Session; every other Session is skipped silently and
# permanently ("A busy attachment skips startup permanently for that live
# activation" — runtime README, Known Limitations). In a container that boots with
# sessions already open, the winner of that race is whichever activation happens
# first, often not the session you are looking at, so browser tools appear to be
# missing at random and closing the "owner" does not bring them back.
#
# The patch makes the provider non-exclusive: each live Session gets its own MCP
# client attached to the SAME visible browser, so the tools are always present and
# human takeover still works. The honest trade-off: it is one browser, so cookies,
# logins and tabs are shared between Sessions, and two Sessions driving it at once
# compete for the active tab. DSH_BROWSER_USE_EXCLUSIVE=1 restores upstream.
#
# Content-anchored and idempotent, and it FAILS THE BUILD if upstream changes that
# expression — an upstream refactor must never silently restore the behaviour this
# fork removed. Same philosophy as tools/apply-profile-patch.mjs.
# ---------------------------------------------------------------------
COPY tools/patch-browser-use-exclusivity.mjs /tmp/patch-browser-use-exclusivity.mjs
RUN set -eux; \
    node /tmp/patch-browser-use-exclusivity.mjs /opt/dsh/node_modules /opt/dsh-src/node_modules; \
    rm -f /tmp/patch-browser-use-exclusivity.mjs

# ---------------------------------------------------------------------
# Landlock launcher — the confinement backend DSH's sandbox modes need.
#
# DSH's Linux runner chain is `bwrap` then `landlock` (probed in order). bwrap
# needs unprivileged user namespaces, which this container refuses BY DESIGN
# (`cap_drop: ALL` + `no-new-privileges` + the daemon's seccomp profile), so the
# chain always falls through to the Landlock launcher — and without that binary
# every confined permission mode fails closed ("no backend usable").
#
# The binary ships in the per-platform npm package
# `@deepseek-ai/node-addon-system-<platform>-<arch>` and is resolved by
# `launcherPath()`. It is an OPTIONAL dependency of the install, so a build that
# skipped optional deps, or a source-channel monorepo build that only linked the
# workspace copy, can be missing it. tools/ensure-landlock-launcher.mjs provides
# it in EITHER channel, then proves it with the real functional probe
# (`landlock-run --probe` builds and enforces a maximal ruleset, so a kernel that
# has the syscalls but refuses enforcement reads as unusable) and FAILS THE BUILD
# otherwise. The path is never spelled out here — it is derived from
# `launcherPath()` — so an upstream layout change cannot silently skip this step
# (the old step computed `native/landlock-run/packages/linux-${TARGETARCH}`,
# which stopped matching upstream, and Docker's `TARGETARCH` (amd64/arm64) never
# matched the package names (x64/arm64) either).
#
# CONSEQUENCE FOR DEPLOYMENTS: nothing to download and nothing to mount. The
# compose file no longer asks for a Landlock bind-mount; images built before this
# change can keep their mount (it is simply redundant now).
# ---------------------------------------------------------------------
COPY tools/ensure-landlock-launcher.mjs /tmp/ensure-landlock-launcher.mjs
RUN set -eux; \
    node /tmp/ensure-landlock-launcher.mjs /opt/dsh /opt/dsh-src; \
    rm -f /tmp/ensure-landlock-launcher.mjs

# ---------------------------------------------------------------------
# The harness home must be unambiguous in EVERY shell.
#
# DSH resolves its user data as `--dsh-home` > `$DSH_HOME` > `~/.dsh`
# (@deepseek-ai/dsh-home-paths) while this image sets HOME=/workspace (the Web
# UI's directory picker treats the mounted workspace as home) and the harness
# home is /home/node/.dsh. A shell that starts WITHOUT the image environment
# (su -, ssh, a console with a scrubbed env) therefore resolves `~/.dsh` to a
# phantom home, and a `dsh plugin … add` run there installs into a directory the
# launcher never reads. The entrypoint also symlinks ~/.dsh to the real home;
# these two files make the env itself consistent for interactive and login
# shells, so the documented path works even before the alias is in place.
# ---------------------------------------------------------------------
RUN printf '%s\n' \
      '# DeepSeek Harness home — see the image docs. `~/.dsh` is symlinked to this' \
      '# directory by the entrypoint, so both spellings are the same place.' \
      ': "${DSH_HOME:=/home/node/.dsh}"' \
      'export DSH_HOME' \
      > /etc/profile.d/10-dsh-home.sh \
 && chmod 0644 /etc/profile.d/10-dsh-home.sh \
 && printf '%s\n' \
      '' \
      '# DeepSeek Harness home (see /etc/profile.d/10-dsh-home.sh).' \
      ': "${DSH_HOME:=/home/node/.dsh}"' \
      'export DSH_HOME' \
      >> /etc/bash.bashrc

# Reverse proxy ("0.0.0.0 fix", smanx pattern) + entrypoint + recovery surface.
# recovery.mjs is imported by the proxy: it renders the boot-failure screen and
# serves its API while the harness itself is down.
COPY docker/proxy.mjs docker/entrypoint.sh docker/recovery.mjs /opt/seek-harness/
RUN chmod 0755 /opt/seek-harness/proxy.mjs /opt/seek-harness/entrypoint.sh /opt/seek-harness/recovery.mjs \
 && ln -sfn /opt/seek-harness/entrypoint.sh /usr/local/bin/entrypoint.sh

# Gate the recovery page's inline JavaScript BEFORE it can ship.
#
# The page is emitted from a template literal, so one mistake in it (an escape
# that is not double-escaped, or a stray backtick) is not cosmetic: the served
# page carries a SyntaxError in its single inline script, no listener is attached,
# and EVERY button on the surface a user needs when the harness is down stops
# working. That regression shipped on 2026-10-02 and this build step makes the
# class unshippable: it renders the page in every boot state, parses what the
# browser would receive, and fails the build on a syntax error or a control that
# lost its wiring.
COPY tools/check-recovery-page.mjs /tmp/check-recovery-page.mjs
RUN node /tmp/check-recovery-page.mjs /opt/seek-harness/recovery.mjs \
 && rm -f /tmp/check-recovery-page.mjs

# Give the Plugins page a slot ABOVE its groups, so this image can put its
# integrated feature and the market selector there the way DSH Desktop does (see
# plugins/dsh-plugins-page-extras/README.md). Desktop patches the same package for
# the same reason; here it is content-anchored, idempotent and FAILS THE BUILD if
# upstream moves either anchor.
COPY tools/patch-plugin-manager-page.mjs /tmp/patch-plugin-manager-page.mjs
RUN node /tmp/patch-plugin-manager-page.mjs /opt/dsh/node_modules /opt/dsh-src/node_modules \
 && rm -f /tmp/patch-plugin-manager-page.mjs

# Browser launcher. The container drops every capability and sets
# no-new-privileges, so Brave's setuid/user-namespace sandbox cannot initialise
# and the browser would refuse to start. Keep the exception scoped to the
# already-isolated browser process instead of weakening the container.
RUN printf '%s\n' \
      '#!/bin/sh' \
      '# Brave inside this container: the container IS the sandbox boundary' \
      '# (cap_drop ALL + no-new-privileges), so the in-process sandbox cannot be' \
      '# used. Call this wrapper, never brave-browser directly.' \
      'exec /usr/bin/brave-browser --no-sandbox "$@"' \
      > /usr/local/bin/brave-desktop \
 && chmod 0755 /usr/local/bin/brave-desktop \
 && brave-desktop --version

# In-app profile control (dsh-profile-switcher), the visible browser desktop
# (dsh-browser-desktop) and the workspace file manager (dsh-workspace-browser).
# The last two are vendored from runzhliu — neither is published to npm; see each
# plugin's README for its provenance and port notes.
# All three packages are placed in the DSH installation's node_modules so the
# launcher can mount them by name from ANY profile; the overlay patches that mount
# them sit beside the entrypoint that applies them (`--patch`, AFTER the profile
# layer) — no profile directory in $DSH_HOME is ever edited. Uninstall = remove the
# overlay (or set DSH_PROFILE_OVERLAY= / DSH_BROWSER_USE_OVERLAY= /
# DSH_WORKSPACE_BROWSER_OVERLAY=).
COPY plugins/dsh-profile-switcher /opt/dsh-profile-switcher
COPY plugins/dsh-browser-desktop /opt/dsh-browser-desktop
COPY plugins/dsh-workspace-browser /opt/dsh-workspace-browser
COPY plugins/dsh-browser-mcp /opt/dsh-browser-mcp
COPY plugins/dsh-plugins-page-extras /opt/dsh-plugins-page-extras
RUN set -eux; \
    installed=0; \
    for target in /opt/dsh/node_modules /opt/dsh-src/node_modules; do \
      if [ -d "$target" ]; then \
        cp -a /opt/dsh-profile-switcher "$target/dsh-profile-switcher"; \
        cp -a /opt/dsh-browser-desktop "$target/dsh-browser-desktop"; \
        cp -a /opt/dsh-workspace-browser "$target/dsh-workspace-browser"; \
        cp -a /opt/dsh-browser-mcp "$target/dsh-browser-mcp"; \
        cp -a /opt/dsh-plugins-page-extras "$target/dsh-plugins-page-extras"; \
        installed=1; \
      fi; \
    done; \
    [ "$installed" = "1" ] || { echo "ERROR: no DSH installation node_modules found"; exit 1; }; \
    rm -rf /opt/dsh-profile-switcher /opt/dsh-browser-desktop /opt/dsh-workspace-browser /opt/dsh-browser-mcp /opt/dsh-plugins-page-extras; \
    chmod -R a+rX \
      /opt/dsh/node_modules/dsh-profile-switcher /opt/dsh/node_modules/dsh-browser-desktop /opt/dsh/node_modules/dsh-workspace-browser /opt/dsh/node_modules/dsh-browser-mcp /opt/dsh/node_modules/dsh-plugins-page-extras \
      /opt/dsh-src/node_modules/dsh-profile-switcher /opt/dsh-src/node_modules/dsh-browser-desktop /opt/dsh-src/node_modules/dsh-workspace-browser /opt/dsh-src/node_modules/dsh-browser-mcp /opt/dsh-src/node_modules/dsh-plugins-page-extras 2>/dev/null || true
# The workspace plugin's own suite, kept in the image so the ported host logic can
# be re-verified in place: docker exec <c> node --test /opt/dsh/node_modules/dsh-workspace-browser/workspace.test.js


# Declare the plugins in the DSH installation's own manifest. This is what makes
# their bare row names resolvable at boot: the launcher builds a module-resolution
# table by walking the installation package's dependency closure (a package that
# merely sits in node_modules is invisible to the loader — it fails with
# "failed to import"), and `client-modules` scans loader entries for packages
# declaring `dsh.client`, which needs the specifier to be a package name.
#
# It is ALSO what puts a bundle on the Plugins page: the plugin manager builds that
# list from `dsh.profile.bundles` ∪ the profile's dependencies ∪ the INSTALLATION's
# dependencies, and gives every entry with a `dsh.bundle.patch` a switch that
# selects/deselects it. `dsh-browser-mcp` relies on exactly that — declare it here
# or it is invisible in the UI no matter what else is done.
RUN set -eux; \
    for spec in "/opt/dsh/node_modules/@deepseek-ai/dsh/package.json:/opt/dsh/node_modules" "/opt/dsh-src/apps/cli/package.json:/opt/dsh-src/node_modules"; do \
      anchor="${spec%%:*}"; root="${spec##*:}"; \
      [ -f "$anchor" ] || continue; \
      [ -d "$root/dsh-browser-desktop" ] || continue; \
      node -e 'const fs = require("node:fs"); const a = process.argv[1]; const r = process.argv[2]; const m = JSON.parse(fs.readFileSync(a, "utf8")); const v = (n) => { try { return JSON.parse(fs.readFileSync(r + "/" + n + "/package.json", "utf8")).version; } catch { return null; } }; const deps = { ...(m.dependencies ?? {}) }; for (const n of ["dsh-profile-switcher", "dsh-browser-desktop", "dsh-workspace-browser", "dsh-browser-mcp", "dsh-plugins-page-extras", "@deepseek-ai/dsh-browser-use", "@deepseek-ai/dsh-experimental-browser-use-playwright-mcp"]) { const ver = v(n); if (ver) { deps[n] = ver; console.log("declared", n, ver); } else { console.log("NOT declaring", n, "- not installed in", r); } } m.dependencies = deps; fs.writeFileSync(a, JSON.stringify(m, null, 2) + "\n"); console.log("updated", a);' "$anchor" "$root"; \
    done
COPY --chmod=0644 docker/profile-switcher.overlay.yml /opt/seek-harness/profile-switcher.overlay.yml
COPY --chmod=0644 docker/browser-use.overlay.yml /opt/seek-harness/browser-use.overlay.yml
COPY --chmod=0644 docker/workspace-browser.overlay.yml /opt/seek-harness/workspace-browser.overlay.yml
COPY --chmod=0644 docker/plugins-page.overlay.yml /opt/seek-harness/plugins-page.overlay.yml

# The browser tooling as ONE switchable MCP row. The fragment is what the
# entrypoint splices into a profile's own patch layer (the layer the Plugin
# list's switch writes to — an overlay row could never be switched off, see
# plugins/dsh-browser-mcp/README.md), and the wrapper is what that row spawns.
#
# @playwright/mcp is the server behind those tools. It arrives as a dependency of
# the browser-use provider, which is still installed (the provider remains an
# opt-in alternative), and this step FAILS THE BUILD if it is ever missing: the
# row would otherwise be seeded into profiles and then fail to start, which looks
# exactly like a broken plugin.
COPY --chmod=0644 plugins/dsh-browser-mcp/cordis.patch.yml /opt/seek-harness/browser-mcp.patch.yml
RUN set -eux; \
    printf '%s\n' \
      '#!/bin/sh' \
      '# The browser MCP server this image offers as the switchable row `browser-mcp`:' \
      '# the pinned @playwright/mcp that ships inside the image, started in attach' \
      '# mode against the visible Brave desktop over CDP. A stable path, so the row' \
      '# never has to know whether DSH came from the npm channel (/opt/dsh) or the' \
      '# source channel (/opt/dsh-src).' \
      'for root in /opt/dsh /opt/dsh-src; do' \
      '  cli="$root/node_modules/@playwright/mcp/cli.js"' \
      '  if [ -f "$cli" ]; then exec node "$cli" "$@"; fi' \
      'done' \
      'echo "dsh-playwright-mcp: @playwright/mcp is not installed in this image" >&2' \
      'exit 127' \
      > /usr/local/bin/dsh-playwright-mcp; \
    chmod 0755 /usr/local/bin/dsh-playwright-mcp; \
    found=""; \
    for root in /opt/dsh /opt/dsh-src; do \
      if [ -f "$root/node_modules/@playwright/mcp/cli.js" ]; then found="$root"; fi; \
    done; \
    [ -n "$found" ] || { echo "ERROR: @playwright/mcp is missing — the switchable browser MCP row would fail to start"; exit 1; }; \
    echo "browser MCP: @playwright/mcp present in $found"

# ---------------------------------------------------------------------
# APK / Android reverse-engineering toolchain.
#
# WHY IT IS IN THE IMAGE
# The harness gets pointed at an .apk ("what does this app actually do, and
# where does my data go?") and the honest answer without this layer is
# `unzip` + `strings`: enough for the DEX string table, useless for the real
# logic — which for a React-Native app is not in the DEX at all, it is a
# Hermes BYTECODE bundle that neither jadx nor strings can read.
#
# WHAT EACH PIECE BUYS
#   JDK                 jadx, apktool, apksigner, sdkmanager and
#                       apkanalyzer are all JVM programs
#   jadx                DEX -> Java source: the readable half of an APK
#   apktool             binary AndroidManifest + resources.arsc -> real XML,
#                       plus smali decode/rebuild — the only sane repack path
#                       (a decompiler cannot produce an APK; this can)
#   hbctool, hermes-dec Hermes HBC bytecode -> disassembly/decompilation,
#                       covering different HBC revisions so both ship
#   frida-tools,        dynamic instrumentation on a target device, dexdump
#   frida-dexdump,      from memory, and objection's wrapper on top
#   objection
#   androguard, apkid   scriptable APK/DEX/AXML analysis WITHOUT a JVM, and
#                       packer/obfuscator detection
#   Android SDK         apksigner + zipalign + aapt2 + apkanalyzer: sign,
#                       align and inspect a rebuilt APK
#   adb                 talks to a device/emulator when there is one. Taken
#                       from Debian on purpose: Google's platform-tools zip
#                       has no aarch64 build, and this image builds for arm64
#                       too.
#
# Nothing here runs at container start and nothing needs a phone, an account
# or a network call at runtime — it is static-analysis capability for the
# agent's shell. `apk-tools` prints the inventory from inside a running
# container; `apk-unpack` is the one-shot entry point.
#
# Versions are pinned in docker/apk-toolchain.sh (and every download is
# checksum-verified against the vendor's own digest), because a silent
# upstream change would make yesterday's analysis unreproducible. The build
# then EXECUTES all of it — tools/check-apk-toolchain.mjs fails the build if
# a tool cannot run, so a broken toolchain cannot ship as a working one.
#
# SIZE WARNING: this section adds roughly 0.7 GB to the image (mostly the
# JDK and the Android SDK). It is the price of being able to answer the
# question offline instead of downloading a toolchain per session.
# ---------------------------------------------------------------------
ARG JADX_VERSION=1.5.6
ARG APKTOOL_VERSION=3.0.3
ARG ANDROID_CMDLINE_TOOLS_BUILD=16111833
ARG ANDROID_BUILD_TOOLS=36.1.0
ARG ANDROID_PLATFORM=android-36

COPY --chmod=0755 docker/apk-toolchain.sh /tmp/apk-toolchain.sh
COPY --chmod=0755 docker/apk-tools.sh /usr/local/bin/apk-tools
COPY --chmod=0755 docker/apk-unpack.sh /usr/local/bin/apk-unpack
RUN set -eux; \
    APK_JADX_VERSION="${JADX_VERSION}" \
    APK_APKTOOL_VERSION="${APKTOOL_VERSION}" \
    APK_CMDLINE_TOOLS_BUILD="${ANDROID_CMDLINE_TOOLS_BUILD}" \
    APK_BUILD_TOOLS="${ANDROID_BUILD_TOOLS}" \
    APK_PLATFORM="${ANDROID_PLATFORM}" \
      /tmp/apk-toolchain.sh; \
    rm -f /tmp/apk-toolchain.sh

# JAVA_HOME is /opt/java because the real JDK path carries the architecture
# (java-21-openjdk-amd64 / -arm64) and tools like Gradle and sdkmanager
# refuse to guess; the installer points that symlink at whatever apt
# installed. The tool venv comes FIRST on PATH so `python3` and `pip` stay
# the same interpreter — `pip install X` then `python3 -c "import X"` must
# not disagree with itself.
ENV JAVA_HOME=/opt/java \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    PATH=/opt/apk-tools/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# The build-time proof (also runnable in a live container: `apk-tools --check`).
COPY --chmod=0644 docker/apk-tools.md /opt/apk-tools/README.md
COPY --chmod=0644 tools/check-apk-toolchain.mjs /opt/apk-tools/check.mjs
RUN node /opt/apk-tools/check.mjs

ENV NODE_ENV=production \
    DSH_HOME=/home/node/.dsh \
    HOME=/workspace \
    DSH_PORT=3079 \
    PROXY_PORT=3080 \
    PROXY_HOST=0.0.0.0 \
    DSH_TELEMETRY_DISABLED=1 \
    DSH_DESKTOP_ENABLED=1 \
    DSH_BROWSER_USE_ENABLED=1 \
    DSH_BROWSER_USE_EXCLUSIVE=0 \
    DSH_DESKTOP_PREFIX=desktop \
    DSH_NOVNC_PORT=6080 \
    DSH_CDP_PORT=9222 \
    DSH_DESKTOP_WIDTH=1440 \
    DSH_DESKTOP_HEIGHT=900 \
    DISPLAY=:99

WORKDIR /workspace
# Build residue in /tmp must not ship root-owned. The npm cache and Node's
# compile cache were created by the BUILD (running as root) and stay inside the
# image layer; with the compose tmpfs on /tmp that is invisible, but under a plain
# `docker run` (documented below) or any mount that exposes the image's /tmp,
# every npm/npx call for uid 1000 dies with EACCES — "Your cache folder contains
# root-owned files" — which breaks `dsh plugin add`, npx-launched MCP servers and
# `npm pack` at runtime. npm recreates both caches as the running user when it
# needs them, so removing them is free.
RUN rm -rf /tmp/.npm-cache /tmp/node-compile-cache \
 && mkdir -p /workspace /home/node/.dsh \
 && chown -R node:node /home/node/.dsh /workspace /opt/seek-harness

# Non-root (runzhliu hardening): uid/gid 1000 = image "node" user
USER node:node

# entrypoint handles: `web` (default), `-`-prefixed dsh args, or arbitrary exec
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["web"]

# Healthcheck probes the public proxy port; 502 while DSH is still booting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
  CMD curl -s -o /dev/null "http://127.0.0.1:${PROXY_PORT}/" || exit 1
