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
#   this build            : docker-ce-cli + docker-compose-plugin +
#                           docker-buildx-plugin (socket/TCP engine access;
#                           without buildx `docker build` silently falls back
#                           to the DEPRECATED legacy builder and every
#                           `docker buildx` call is "unknown command"),
#                           tini (init, orphan reaping),
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
      docker-ce-cli docker-compose-plugin docker-buildx-plugin \
      xvfb x11vnc x11-utils openbox websockify novnc \
      fonts-liberation fonts-noto-cjk; \
    rm -rf /var/lib/apt/lists/*

# Optional: a virgl-capable QEMU. cua provisions its own QEMU, but that build
# has no virtio-gpu-gl-pci (verified: "This QEMU was built without
# virglrenderer"), so the personal VM is limited to software GL. Installing the
# distro build lets `cua sb create --gpu virgl` hand the guest a virgl context;
# the supervisor points cua's wrapper at this binary when DSH_CUA_VM_GPU=virgl.
# Off by default: it costs ~200 MB and needs /dev/dri (or the NVIDIA toolkit)
# on the host to be worth anything.
ARG WITH_VIRGL_QEMU=0
RUN set -eux; \
    if [ "$WITH_VIRGL_QEMU" = "1" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends \
        qemu-system-x86 qemu-system-modules-opengl libvirglrenderer1 libegl1 libgl1-mesa-dri; \
      rm -rf /var/lib/apt/lists/*; \
    fi

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
# otherwise. The tool resolves the launcher through the installed package's own
# `launcherPath()` first and falls back to the platform-package locations every
# channel actually produces — the root's node_modules (npm), the API package's
# own fallback directory, the pnpm store sibling and the source workspace's
# in-tree `native/system/packages/<platform>/bin/` — so an upstream layout change
# cannot silently skip this step (an earlier version read only the npm layout and
# broke every source-channel build; the step before that computed
# `native/landlock-run/packages/linux-${TARGETARCH}`, which stopped matching
# upstream, and Docker's `TARGETARCH` (amd64/arm64) never matched the package
# names (x64/arm64) either).
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
# lockfile-integrity.mjs runs from the entrypoint BEFORE dsh starts (see the
# guard block there): pnpm refuses a lockfile tarball resolution without an
# integrity unless the URL is git-hosted, so one Market install of a curated
# release-archive plugin bricks every install in that profile.
COPY docker/proxy.mjs docker/entrypoint.sh docker/recovery.mjs docker/lockfile-integrity.mjs /opt/seek-harness/
# Hide the image-owned MCP rows from a user-installed MCP manager (see the file).
COPY --chmod=0644 tools/patch-mcp-manager.mjs /opt/seek-harness/patch-mcp-manager.mjs
RUN chmod 0755 /opt/seek-harness/proxy.mjs /opt/seek-harness/entrypoint.sh /opt/seek-harness/recovery.mjs \
 && ln -sfn /opt/seek-harness/entrypoint.sh /usr/local/bin/entrypoint.sh

# The lockfile guard must recognise exactly the shapes pnpm accepts without an
# integrity (and refuse everything else). A wrong predicate either misses the
# bricked profile or rewrites an entry pnpm was happy with, so its decision table
# is a build gate: well-formed fixtures in, expected classifications out, plus
# the exact rewritten line pnpm itself writes. Offline — no network in the gate.
RUN node /opt/seek-harness/lockfile-integrity.mjs --self-test

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

# Give the sidebar's Settings row a trailing LIST slot, so the file browser and
# browser-desktop controls can sit BESIDE Settings at the far right instead of in
# the footer action area — which belongs to whatever panel registers there (the
# provider-usage panel), and where they used to overlap it and each other in the
# collapsed rail. The shipped `sidebar.settings` slot is `kind: "single"`, so
# there is no second seat to use. The step also appends the glyph and rail layout
# rules to the package's own stylesheet, resolved from that file's own class map,
# and FAILS THE BUILD if upstream moves an anchor. See
# tools/patch-sidebar-footer.mjs and plugins/dsh-browser-desktop/README.md.
COPY tools/patch-sidebar-footer.mjs /tmp/patch-sidebar-footer.mjs
RUN node /tmp/patch-sidebar-footer.mjs /opt/dsh/node_modules /opt/dsh-src/node_modules \
 && rm -f /tmp/patch-sidebar-footer.mjs

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
COPY plugins/dsh-brave-devtools-mcp /opt/dsh-brave-devtools-mcp
COPY plugins/dsh-plugins-page-extras /opt/dsh-plugins-page-extras
COPY plugins/dsh-office /opt/dsh-office-bundle
RUN set -eux; \
    installed=0; \
    for target in /opt/dsh/node_modules /opt/dsh-src/node_modules; do \
      if [ -d "$target" ]; then \
        cp -a /opt/dsh-profile-switcher "$target/dsh-profile-switcher"; \
        cp -a /opt/dsh-browser-desktop "$target/dsh-browser-desktop"; \
        cp -a /opt/dsh-workspace-browser "$target/dsh-workspace-browser"; \
        cp -a /opt/dsh-browser-mcp "$target/dsh-browser-mcp"; \
        cp -a /opt/dsh-brave-devtools-mcp "$target/dsh-brave-devtools-mcp"; \
        cp -a /opt/dsh-plugins-page-extras "$target/dsh-plugins-page-extras"; \
        cp -a /opt/dsh-office-bundle "$target/dsh-office"; \
        installed=1; \
      fi; \
    done; \
    [ "$installed" = "1" ] || { echo "ERROR: no DSH installation node_modules found"; exit 1; }; \
    rm -rf /opt/dsh-profile-switcher /opt/dsh-browser-desktop /opt/dsh-workspace-browser /opt/dsh-browser-mcp /opt/dsh-brave-devtools-mcp /opt/dsh-plugins-page-extras /opt/dsh-office-bundle; \
    chmod -R a+rX \
      /opt/dsh/node_modules/dsh-profile-switcher /opt/dsh/node_modules/dsh-browser-desktop /opt/dsh/node_modules/dsh-workspace-browser /opt/dsh/node_modules/dsh-browser-mcp /opt/dsh/node_modules/dsh-brave-devtools-mcp /opt/dsh/node_modules/dsh-plugins-page-extras /opt/dsh/node_modules/dsh-office \
      /opt/dsh-src/node_modules/dsh-profile-switcher /opt/dsh-src/node_modules/dsh-browser-desktop /opt/dsh-src/node_modules/dsh-workspace-browser /opt/dsh-src/node_modules/dsh-browser-mcp /opt/dsh-src/node_modules/dsh-brave-devtools-mcp /opt/dsh-src/node_modules/dsh-plugins-page-extras /opt/dsh-src/node_modules/dsh-office 2>/dev/null || true
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
      node -e 'const fs = require("node:fs"); const a = process.argv[1]; const r = process.argv[2]; const m = JSON.parse(fs.readFileSync(a, "utf8")); const v = (n) => { try { return JSON.parse(fs.readFileSync(r + "/" + n + "/package.json", "utf8")).version; } catch { return null; } }; const deps = { ...(m.dependencies ?? {}) }; for (const n of ["dsh-profile-switcher", "dsh-browser-desktop", "dsh-workspace-browser", "dsh-browser-mcp", "dsh-brave-devtools-mcp", "dsh-plugins-page-extras", "dsh-office", "@deepseek-ai/dsh-browser-use", "@deepseek-ai/dsh-experimental-browser-use-playwright-mcp"]) { const ver = v(n); if (ver) { deps[n] = ver; console.log("declared", n, ver); } else { console.log("NOT declaring", n, "- not installed in", r); } } m.dependencies = deps; fs.writeFileSync(a, JSON.stringify(m, null, 2) + "\n"); console.log("updated", a);' "$anchor" "$root"; \
    done
COPY --chmod=0644 docker/profile-switcher.overlay.yml /opt/seek-harness/profile-switcher.overlay.yml
COPY --chmod=0644 docker/browser-use.overlay.yml /opt/seek-harness/browser-use.overlay.yml
COPY --chmod=0644 docker/workspace-browser.overlay.yml /opt/seek-harness/workspace-browser.overlay.yml
COPY --chmod=0644 docker/plugins-page.overlay.yml /opt/seek-harness/plugins-page.overlay.yml

# Gate the profile controls: the create CHOOSER and "Reset to Default".
#
# The pill's "+ New Profile" asks how a profile should start, which makes the
# answer a contract: `mode: "new"` has to produce a STOCK profile (two bundles, no
# dependencies, no node_modules, none of the source's patch layer) while a caller
# that sends no mode — the recovery page, an older client bundle — must keep
# getting the copy. The row's `Reset to Default` is the same skeleton written into
# an EXISTING profile, so it must wipe it and leave nothing of the old plugin set
# behind. The gate EXECUTES the plugin's own HTTP route against a throwaway
# $DSH_HOME for all of it, MOUNTS the browser half on a stub React runtime and
# clicks the chooser and the row controls through, and, when the image carries
# `dsh-app-boot`, proves the local fallback skeleton is byte-identical to
# `initProfile`'s output so a fresh profile cannot differ between the npm and
# source channels. See tools/check-profile-switcher.mjs.
COPY --chmod=0644 tools/check-profile-switcher.mjs /tmp/check-profile-switcher.mjs
RUN node /tmp/check-profile-switcher.mjs /opt/dsh /opt/dsh-src \
 && rm -f /tmp/check-profile-switcher.mjs

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

# The browser TROUBLESHOOTING row (`brave-devtools-mcp`, "Browser tools brave").
#
# `brave-mcp` (github.com/triuzzi/brave-devtools-mcp — a Brave-native fork of
# Chrome DevTools MCP) is what turns "the page looks wrong" into evidence: the
# console with source-mapped stacks, every network request and its status, the CSS
# cascade, performance traces with insight sets, Lighthouse audits, heap
# snapshots. It ATTACHES to the same visible Brave desktop over loopback CDP
# (127.0.0.1:$DSH_CDP_PORT, which start_desktop already passes to Brave as
# --remote-debugging-address/-port), so the model and the human share one browser
# and nothing here ever launches or downloads a second one.
#
# WHY IT IS PINNED AND INSTALLED, RATHER THAN `npx -y brave-mcp@latest`
#   * a boot would then depend on the npm registry being reachable: an offline or
#     rate-limited container would lose 30 tools at random, which is
#     indistinguishable from a broken plugin;
#   * `@latest` moves under the user without a rebuild — the tool surface (and so
#     its context cost) would change on a restart, and a bad upstream release
#     would land on the next restart instead of the next build.
# Bump BRAVE_MCP_VERSION and rebuild to move it; the gate below re-runs a real
# handshake, so a broken bump cannot ship.
#
# It lives in its OWN prefix rather than in the DSH installation's node_modules:
# upstream's rollup bundle makes `npm install brave-mcp` add exactly one package
# with no transitive tree, and only BUNDLES have to be resolvable by the loader —
# this one is a child process the row spawns.
ARG BRAVE_MCP_VERSION=1.9.0
RUN set -eux; \
    npm install --prefix /opt/brave-mcp --omit=dev --no-audit --no-fund "brave-mcp@${BRAVE_MCP_VERSION}"; \
    installed="$(node -p 'require("/opt/brave-mcp/node_modules/brave-mcp/package.json").version')"; \
    [ "$installed" = "${BRAVE_MCP_VERSION}" ] || { echo "ERROR: installed brave-mcp ${installed}, expected ${BRAVE_MCP_VERSION}"; exit 1; }; \
    [ -f /opt/brave-mcp/node_modules/brave-mcp/build/src/bin/brave-devtools-mcp.js ] \
      || { echo "ERROR: the brave-mcp package carries no build/src/bin/brave-devtools-mcp.js"; exit 1; }; \
    printf '%s\n' \
      '#!/bin/sh' \
      '# The DevTools MCP server this image offers as the switchable row' \
      '# `brave-devtools-mcp` ("Browser tools brave"): the pinned brave-mcp that' \
      '# ships inside the image, started in attach mode against the visible Brave' \
      '# desktop over loopback CDP. A stable path, so the row never has to know' \
      '# where the package lives — and never runs npx.' \
      'exec node /opt/brave-mcp/node_modules/brave-mcp/build/src/bin/brave-devtools-mcp.js "$@"' \
      > /usr/local/bin/dsh-brave-devtools-mcp; \
    chmod 0755 /usr/local/bin/dsh-brave-devtools-mcp; \
    echo "browser DevTools: brave-mcp ${installed} behind /usr/local/bin/dsh-brave-devtools-mcp"

# The row works only while FOUR pieces agree — the server above, the bundle patch
# that mounts the row, the Plugins-page switch (host table + client row) and the
# page's duplicate-card suppression. One of them missing still produces a healthy
# image and a dead switch, so this gate EXECUTES the server through the wrapper
# (a real MCP handshake — brave-mcp connects to the browser lazily, so no browser
# is needed at build time) and reads the other three out of the installed files.
# See tools/check-brave-mcp.mjs.
COPY --chmod=0644 tools/check-brave-mcp.mjs /tmp/check-brave-mcp.mjs
RUN node /tmp/check-brave-mcp.mjs /usr/local/bin/dsh-brave-devtools-mcp "${BRAVE_MCP_VERSION}" /opt/dsh/node_modules /opt/dsh-src/node_modules \
 && rm -f /tmp/check-brave-mcp.mjs

# ---------------------------------------------------------------------
# Office documents — Word, PowerPoint, Excel and PDF work for the model.
#
# WHY IT IS IN THE IMAGE
# The harness ships the whole feature and mounts none of it in a plain container:
# `@deepseek-ai/dsh-skill-office` carries the three skills (office-docx,
# office-pptx, office-xlsx) plus the standard-library check_office.py structural
# checker, and `@deepseek-ai/libreoffice-kit` carries the rendering engine
# (LibreOffice compiled to WebAssembly — a prebuilt dependency, nothing to
# apt-install and nothing to run as a service). What is missing is the interpreter
# the skills are told to use: they call `load_workspace_dependencies` and run the
# Python it returns, so a payload has to exist. That payload is what this step
# assembles, from a lock file pinned by SHA-256.
#
# The packages are already in the installation's node_modules (they are ordinary
# dependencies of the DSH release). What this image adds is:
#   1. /opt/dsh-office/primary-runtime — the pinned Python 3.12.14 payload with
#      python-docx, python-pptx, openpyxl, XlsxWriter, Pillow, lxml, numpy, pandas,
#      and this image's two additions: pypdf and PyMuPDF, which are what make
#      reading a PDF's text and embedded images possible.
#   2. /opt/dsh-office/office-skills/pdf-documents — this repository's fourth skill,
#      for PDFs, discovered through DSH_BUNDLED_SKILL_DIR (set in the entrypoint).
#   3. the bundle that mounts both rows, so the Plugins page has one switch for it.
#
# BOTH ARCHITECTURES ARE COVERED: the lock carries linux-x64 and linux-arm64, and
# the target is derived from the platform actually being built.
#
# The gate EXECUTES the payload and the engine — the interpreter imports every
# library, the checker passes on a document the payload itself wrote, the engine
# converts that document to a real PDF and renders a page to a real PNG, and the
# four declarations that have to agree (bundle patch row, Plugins-page row host
# table, duplicate-card suppression, entrypoint switch) are read out of the files.
# See tools/check-office.mjs.
COPY --chmod=0644 docker/office-runtime.lock.json tools/build-office-payload.mjs /tmp/office/
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      arm64) office_target=linux-arm64 ;; \
      *) office_target=linux-x64 ;; \
    esac; \
    dsh_version="$(node -p "require('/opt/dsh/node_modules/@deepseek-ai/dsh/package.json').version" 2>/dev/null || echo unknown)"; \
    node /tmp/office/build-office-payload.mjs \
      --lock /tmp/office/office-runtime.lock.json \
      --target "$office_target" \
      --output /opt/dsh-office \
      --cache /tmp/office-cache \
      --version "dsh-$dsh_version"; \
    rm -rf /tmp/office /tmp/office-cache
COPY --chmod=0644 office-skills /opt/dsh-office/office-skills
# The gate needs the four declarations, not the whole repository.
COPY --chmod=0644 plugins/dsh-office/cordis.patch.yml /tmp/office-repo/dsh-office.cordis.patch.yml
COPY --chmod=0644 plugins/dsh-plugins-page-extras/index.js /tmp/office-repo/plugins-page-extras.index.js
COPY --chmod=0644 tools/patch-plugin-manager-page.mjs /tmp/office-repo/patch-plugin-manager-page.mjs
COPY --chmod=0644 docker/entrypoint.sh /tmp/office-repo/entrypoint.sh
COPY --chmod=0644 tools/check-office.mjs /tmp/check-office.mjs
RUN node /tmp/check-office.mjs \
      --payload /opt/dsh-office \
      --repo /tmp/office-repo \
      --entrypoint /tmp/office-repo/entrypoint.sh \
      --install /opt/dsh/node_modules --install /opt/dsh-src/node_modules \
 && rm -rf /tmp/check-office.mjs /tmp/office-repo

# ---------------------------------------------------------------------
# Native LibreOffice layout — soffice --headless + system-python docx/xlsx.
#
# WHY IT IS IN THE IMAGE
# The `dsh-office` card above runs LibreOffice compiled to WebAssembly through
# @deepseek-ai/libreoffice-kit: a good PREVIEW engine, but bounded (100 pages,
# 16.7M pixels, not resident) and missing the add-on import/export filters of
# the real build. When an agent needs the REAL engine — a .doc (binary format)
# swapped to .docx, legacy .ods/.ppt round-tripping, batch-converting a folder,
# or a page swap that must not pass a bounded renderer — `soffice --headless`
# is the better-compatibility tool, so it ships here NEXT TO the card, not
# instead of it.
#
# WHAT EACH PIECE BUYS
#   libreoffice-writer/calc/impress/draw
#                       the real Word/Excel/PowerPoint/ODF engines, pulled in
#                       together with libreoffice-core and their full
#                       import/export filter sets (--no-install-recommends
#                       keeps out Java, the KDE/GNOME menu integration and the
#                       wiki/mediawiki filters the conversion path never
#                       touches; core itself provides the soffice launcher and
#                       binary). Layout-faithful fonts are ALREADY in the
#                       image (fonts-liberation + fonts-noto-cjk, installed
#                       above) and are the same files the WASM engine gets.
#   python3-docx        python-docx bound to the SYSTEM python3, so
#                       `python3 -c "import docx"` works in ANY shell the
#                       agent gets — even one that never reads the payload.
#                       The office payload interpreter keeps the full pinned
#                       set (python-pptx, XlsxWriter, Pillow, numpy, pandas…);
#                       this is the plain-default convenience layer, not a
#                       second source of truth.
#   python3-openpyxl    same, for .xlsx/.xlsm read-write on plain python3.
#                       Debian has no python3-pptx package, so PowerPoint work
#                       goes through the payload interpreter, where the wheel
#                       is SHA-256-pinned by the office lock.
#
# THE WRAPPERS the agent reaches for instead of memorising flags:
#   office-convert <to> <file>...
#                       soffice --headless --convert-to; output lands beside
#                       each input. `office-convert pdf report.odt` and
#                       `office-convert docx report/*.doc` both work.
#   office-swap-pages <in.pdf> <out.pdf> <order>
#                       rebuild a PDF with pages reordered / swapped
#                       (1,4,3,2) or rotated (6:180), on pypdf, WITHOUT
#                       re-encoding — copied pages stay byte-identical, the
#                       same rule ocr-pdf's invisible layer keeps to. Runs on
#                       the office payload interpreter (it owns pypdf).
#
# NO BUILD-TIME GATE is attached to this block, deliberately (unlike the WASM
# card above): the apt resolution is itself the proof — a package that is not
# in trixie fails the build loudly at install time, and the wrappers' behaviour
# is exercised by whoever first runs them against a real file.
# ---------------------------------------------------------------------
COPY --chmod=0644 tools/office-swap-pages.py /opt/office-native/office-swap-pages.py
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw \
      python3-docx python3-openpyxl; \
    rm -rf /var/lib/apt/lists/*; \
    soffice --version; \
    printf '%s\n' \
      '#!/bin/sh' \
      '# office-convert — the native LibreOffice format converter (soffice, headless).' \
      '# Whole-document compatibility swaps: doc->docx, odt->pdf, ppt->docx, xlsx->csv…' \
      '# Usage: office-convert <target-ext> <file>...   e.g. office-convert pdf a.docx b.odt' \
      '# Output files land beside the FIRST input file. For previews and page renders' \
      '# the dsh-office card is the correct path; this wrapper is the unbounded one.' \
      '[ "$#" -ge 2 ] || { echo "usage: office-convert <to> <file>... (e.g. office-convert pdf deck.odt)" >&2; exit 64; }' \
      'for f in "$@"; do [ -f "$f" ] || { echo "office-convert: not a file: $f" >&2; exit 66; }; done' \
      'to="$1"; shift' \
      'exec /usr/bin/soffice --headless --norestore --convert-to "$to" --outdir "$(dirname "$1")" -- "$@"' \
      > /usr/local/bin/office-convert; \
    chmod 0755 /usr/local/bin/office-convert; \
    printf '%s\n' \
      '#!/bin/sh' \
      '# office-swap-pages — rebuild a PDF with pages reordered / swapped / rotated.' \
      '# Usage: office-swap-pages <in.pdf> <out.pdf> <order>   e.g. ... 3,1-2  or  1-5,6:180' \
      '# Runs on the office payload interpreter when present (it owns the pinned' \
      '# pypdf); any other shell falls back to the system python3.' \
      'payload=/opt/dsh-office/primary-runtime/dependencies/python/bin/python3' \
      'if [ -x "$payload" ]; then exec "$payload" /opt/office-native/office-swap-pages.py "$@"; fi' \
      'exec python3 /opt/office-native/office-swap-pages.py "$@"' \
      > /usr/local/bin/office-swap-pages; \
    chmod 0755 /usr/local/bin/office-swap-pages


# ---------------------------------------------------------------------
# OCR for image-only PDFs — the other half of "read this PDF".
#
# WHY IT IS IN THE IMAGE
# The PDF skill could say, truthfully, that a page with no text layer was a
# scan — and nothing else. That is an honest answer and a useless one: a deck
# exported as pictures, a photographed form, a contract whose signature pages
# are scans all arrive as pages whose words exist only as pixels, and the
# deliverable the user wants is the searchable one they did not have to run a
# second tool for.
#
# THE ENGINE IS TESSERACT 5, and deliberately nothing else. It is the fast,
# folder-clean one: one process per page, no model session to warm up, no
# Python wheels to load, no runtime download, and output every other OCR tool is
# calibrated against. The alternatives (RapidOCR/PP-OCRv4 ONNX, EasyOCR,
# PaddleOCR) each pull a few hundred MB of runtime and burn CPU on every run for
# a second opinion this image does not need — so they are not installed, and the
# driver has no flag that pretends otherwise.
#
# WHAT IT DOES NOT DO: improve the picture. The driver adds an INVISIBLE text
# layer (render mode 3) on top of the page's own content and never re-encodes,
# re-samples or redraws an image — tesseract's own PDF writer re-renders its
# copies of the page images, which is how "OCR this PDF" usually becomes
# "quietly replace this PDF's images". See tools/ocr-pdf.py.
#
# The traineddata is shape-checked before it is installed (a 404 that landed as
# an HTML error page carries no version header), and the build then EXECUTES the
# surface — tools/check-ocr-toolchain.mjs renders a page whose text it knows,
# OCRs it through the real driver, requires the words back out of the RESULT and
# requires the layer to be invisible — so a broken engine cannot ship as a
# working one.
#
# SIZE: roughly 40 MB (the Debian packages plus tessdata_best).
# ---------------------------------------------------------------------
ARG OCR_TESSDATA_TIER=best

COPY --chmod=0755 docker/ocr-toolchain.sh /tmp/ocr-toolchain.sh
COPY --chmod=0755 docker/ocr-tools.sh /usr/local/bin/ocr-tools
COPY --chmod=0644 tools/ocr-pdf.py /opt/ocr-tools/ocr-pdf.py
RUN set -eux; \
    OCR_TESSDATA_TIER="${OCR_TESSDATA_TIER}" \
      /tmp/ocr-toolchain.sh; \
    rm -f /tmp/ocr-toolchain.sh

# The driver runs on the payload interpreter (pypdf + PyMuPDF live there), and
# the wrapper has to be able to find it from anywhere — including a shell whose
# PATH has been rewritten — so the resolving wrapper is written here rather than
# guessed at call time.
COPY --chmod=0644 docker/ocr-pdf.md /opt/ocr-tools/README.md
COPY --chmod=0644 tools/check-ocr-toolchain.mjs /opt/ocr-tools/check.mjs
ENV OCR_TESSDATA_DIR=/usr/share/tesseract-ocr/5/tessdata
RUN set -eux; \
    python="$(command -v python3)"; \
    payload=/opt/dsh-office/primary-runtime/dependencies/python/bin/python3; \
    [ -x "$payload" ] && python="$payload"; \
    printf '%s\n' \
      '#!/bin/sh' \
      '# ocr-pdf — the driver, always on the interpreter that owns pypdf/PyMuPDF.' \
      '# See /opt/ocr-tools/README.md; the wrapper `ocr-tools` prints the inventory.' \
      'payload=/opt/dsh-office/primary-runtime/dependencies/python/bin/python3' \
      'if [ -x "$payload" ]; then exec "$payload" /opt/ocr-tools/ocr-pdf.py "$@"; fi' \
      'exec python3 /opt/ocr-tools/ocr-pdf.py "$@"' \
      > /usr/local/bin/ocr-pdf; \
    chmod 0755 /usr/local/bin/ocr-pdf; \
    echo "ocr-pdf -> $python"; \
    /usr/local/bin/ocr-pdf --probe

# The build-time proof (also runnable in a live container: `ocr-tools --check`).
RUN node /opt/ocr-tools/check.mjs



# ---------------------------------------------------------------------
# CUA — the model's own computer, as a VM, OUTSIDE the workspace.
#
# THE PROBLEM THIS SOLVES
# The harness runs in `workspace-write`, where the sandbox grants read-write
# only to /dev/null, /tmp and the workspace root (see
# packages/sandbox/sandbox-local/src/profiles.ts). QEMU opens /dev/kvm O_RDWR,
# so a VM cannot be started from the agent's shell — and it should not be:
# a 1.3 GB base disk plus per-workspace deltas do not belong in the user's
# project directory.
#
# THE SPLIT
#   /usr/local/bin/cua-vm-supervisor   started by docker/entrypoint.sh BEFORE
#                                      any Session, owns /dev/kvm, QEMU, the
#                                      cua daemon and the /cua-vm volume
#   dsh-cua-vm (the plugin below)      tools that only write JSON to a unix
#                                      socket under /tmp, which the sandbox
#                                      already allows
#
# The CLI is not the daemon: it is the client the supervisor drives. QEMU
# itself is installed into the volume on first use (`cua runtime setup qemu`,
# user-local, no apt, no root) so it never lands in an image layer.
#
# SIZE: ~45 MB compressed for the CLI binary; QEMU ~200 MB in the volume, once.
# ---------------------------------------------------------------------
ARG CUA_CLI_VERSION=0.7.0
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) cua_asset="x64" ;; \
      arm64) cua_asset="arm64" ;; \
      *) echo "cua: unsupported architecture $arch"; exit 1 ;; \
    esac; \
    url="https://github.com/trycua/cua/releases/download/cua-sdk-v${CUA_CLI_VERSION}/cua-cli-${CUA_CLI_VERSION}-linux-${cua_asset}.tar.gz"; \
    curl -fsSL --retry 3 -o /tmp/cua.tgz "$url"; \
    tar -xzf /tmp/cua.tgz -C /usr/local/bin cua; \
    chmod 0755 /usr/local/bin/cua; \
    rm -f /tmp/cua.tgz; \
    # The harness shell runs with HOME=/workspace (the dir-selector fix), while
    # cua keeps its sandboxes under the VM store. Without this wrapper every
    # `cua sb ...` typed in a shell — by the model or a human — looks at
    # /workspace/.cua, finds nothing and answers "not found: sandbox <name>".
    # CUA_CLI_HOME overrides it for a different store.
    mv /usr/local/bin/cua /usr/local/bin/cua.real; \
    printf '%s\n' '#!/bin/sh' 'exec env HOME="${CUA_CLI_HOME:-/cua-vm/home}" /usr/local/bin/cua.real "$@"' > /usr/local/bin/cua; \
    chmod 0755 /usr/local/bin/cua; \
    /usr/local/bin/cua.real --version
COPY --chmod=0755 docker/cua-vm-supervisor.mjs /usr/local/bin/cua-vm-supervisor
# Guest provisioning runs INSIDE the VM, piped through `sudo bash` by the
# supervisor. Kept as real files (not a base64 blob in the supervisor) so
# they can be read, diffed and run by hand to debug a guest.
COPY --chmod=0644 docker/cua-guest-provision.sh docker/cua-guest-android.sh /usr/local/bin/
COPY plugins/dsh-cua-vm /opt/dsh-cua-vm
RUN set -eux; \
    installed=0; \
    for target in /opt/dsh/node_modules /opt/dsh-src/node_modules; do \
      if [ -d "$target" ]; then \
        cp -a /opt/dsh-cua-vm "$target/dsh-cua-vm"; \
        installed=1; \
      fi; \
    done; \
    [ "$installed" = "1" ] || { echo "ERROR: no DSH installation node_modules found"; exit 1; }; \
    rm -rf /opt/dsh-cua-vm; \
    chmod -R a+rX /opt/dsh/node_modules/dsh-cua-vm /opt/dsh-src/node_modules/dsh-cua-vm 2>/dev/null || true; \
    for spec in "/opt/dsh/node_modules/@deepseek-ai/dsh/package.json:/opt/dsh/node_modules" "/opt/dsh-src/apps/cli/package.json:/opt/dsh-src/node_modules"; do \
      anchor="${spec%%:*}"; root="${spec##*:}"; \
      [ -f "$anchor" ] || continue; \
      [ -d "$root/dsh-cua-vm" ] || continue; \
      node -e 'const fs=require("node:fs");const a=process.argv[1];const r=process.argv[2];const m=JSON.parse(fs.readFileSync(a,"utf8"));const v=JSON.parse(fs.readFileSync(r+"/dsh-cua-vm/package.json","utf8")).version;m.dependencies={...(m.dependencies??{}),"dsh-cua-vm":v};fs.writeFileSync(a,JSON.stringify(m,null,2)+"\n");console.log("declared dsh-cua-vm",v,"in",a)' "$anchor" "$root"; \
    done

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
# `USER node` — NOT `node:node`. The explicit user:group form makes Docker drop
# the image's supplementary groups, which is exactly what carries kvm access
# (measured: `USER node` → groups=1000(node),104(kvm); `--user node:node` →
# groups=1000(node) only). Same uid and same primary gid either way.
USER node

# entrypoint handles: `web` (default), `-`-prefixed dsh args, or arbitrary exec
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["web"]

# Healthcheck probes the public proxy port; 502 while DSH is still booting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
  CMD curl -s -o /dev/null "http://127.0.0.1:${PROXY_PORT}/" || exit 1
