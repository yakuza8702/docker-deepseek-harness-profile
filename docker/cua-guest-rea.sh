#!/bin/bash
# =====================================================================
# cua-guest-rea.sh — the reverse-engineering kit inside the personal VM.
#
# REA (the rea-agents MCP server) is what turns "a Linux desktop" into "a
# workstation that can take a binary apart": it bundles jadx for Android,
# Ghidra's headless analyzer for native code, and an MCP surface the harness
# mounts as one row (`rea-mcp`). None of it belongs in the harness image —
# Ghidra alone is ~1.4 GB unpacked and the decompiler ships per-OS native
# binaries. Keeping it in the VM means the model installs it once per
# computer, next to the files it is analyzing, and the harness image stays
# the same size whatever the model decides to reverse.
#
# THIS IS A SEPARATE LAYER FROM cua-guest-provision.sh
# ----------------------------------------------------
# Provisioning answers "is this a usable desktop" and is versioned by
# cua-guest-provision.sh's own marker. This script answers "does this desktop
# have the RE kit" and owns /var/lib/cua-rea. Two markers, two versions:
# bumping the REA kit must never re-run the desktop provisioning (and the
# reverse), so a computer without `rea: true` never pays for any of this.
#
# WHAT IT INSTALLS
#   1. openjdk-21 (Ghidra 12.x and jadx both need a JDK; 21 is the LTS the
#      REA release tests against), plus procps/unzip/curl/xz-utils.
#   2. Node v22.23.4 under /opt/node22 — NOT the distro node and NOT the
#      harness node. The image's node is owned by the harness; a VM that
#      upgrades its own node must not be able to break `dsh` in the same
#      breath. Symlinked into /usr/local/bin last (see the note there).
#   3. rea-agents (npm, global) and its resolved entry point
#      lib/node_modules/rea-agents/scripts/rea.mjs.
#   4. Ghidra 12.1.4 PUBLIC, unpacked at /opt/ghidra, with the two things
#      REA actually shells out to verified: support/analyzeHeadless and a
#      Decompiler/os/*/decompile native binary. A Ghidra without the
#      decompiler looks installed and fails at analysis time; that is why
#      this is asserted here and not discovered later.
#   5. jadx 1.5.6 and jadx-headless-mcp 0.7.1 (the jar REA's Android provider
#      drives), the jar checked against a pinned sha256 — a truncated or
#      proxied HTML download must fail the run, not the first APK.
#   6. The environment, three ways, because three different processes need
#      it: login shells (/etc/profile.d), the systemd user environment
#      (/etc/environment) and cua-spacesd itself (a drop-in). The desktop
#      session is what `cua sb exec` inherits, so a variable exported only in
#      this script would be invisible to every tool call after it.
#   7. Registration: `rea setup --client dsh` writes the MCP row for the
#      guest's own DSH profile. When that command is unavailable (older REA,
#      a profile layout it does not know) the row is written by hand into
#      ~/.dsh/cordis.patch.yml — the same fragment shape the image uses for
#      browser-mcp. `registered=dsh|manual` records which path ran; it is
#      reported, not a failure.
#   8. Proof: `rea doctor --provider ghidra --json` as the desktop user. The
#      marker is written only after that passes.
#
# Environment:
#   REA_MARKER_VERSION=1     bump to force a re-run on existing disks
#   REA_NODE_VERSION=v22.23.4 pinned Node for the REA runtime
# =====================================================================
set -u

VERSION="${REA_MARKER_VERSION:-1}"
NODE_VERSION="${REA_NODE_VERSION:-v22.23.4}"
GHIDRA_VERSION=12.1.4
# The asset tag is Ghidra_12.1.4_build and the file is dated 20260921 — the
# release that REA tests against. 12.2 is refused by REA's version probe, so
# do not "helpfully" bump this.
GHIDRA_URL="https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip"
JADX_VERSION=1.5.6
JADX_URL="https://github.com/skylot/jadx/releases/download/v${JADX_VERSION}/jadx-${JADX_VERSION}.zip"
JADX_MCP_JAR="jadx-headless-mcp-0.7.1-all.jar"
JADX_MCP_URL="https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/${JADX_MCP_JAR}"
JADX_MCP_SHA256="6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75"
GHIDRA_DIR=/opt/ghidra
REA_ANDROID_DIR=/opt/rea/android
NODE_DIR=/opt/node22
MARKER=/var/lib/cua-rea
LOG=/var/log/cua-rea.log
SPACESD_DROPIN=/etc/systemd/system/cua-spacesd.service.d/20-rea.conf

exec > >(tee -a "$LOG") 2>&1
echo "=== $(date -Is) rea v$VERSION node=$NODE_VERSION ghidra=$GHIDRA_VERSION jadx=$JADX_VERSION ==="

say() { echo "[rea] $*"; }
die() { echo "[rea] FAILED: $*"; exit 1; }

if [ -f "$MARKER" ] && grep -qx "version=$VERSION" "$MARKER" 2>/dev/null; then
  say "already provisioned (v$VERSION)"
  exit 0
fi

# --- 1. preflight ----------------------------------------------------
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64)  NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) die "unsupported architecture $ARCH_RAW (Ghidra ships x86_64 and aarch64 builds only)" ;;
esac
say "arch: $ARCH_RAW (node asset $NODE_ARCH)"

# The JDK is the one thing every later step needs; installing it after the
# 1.4 GB Ghidra download would waste the download when apt is broken.
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1 || true

FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
say "free disk: ${FREE_GB:-0}G"
if [ "${FREE_GB:-0}" -lt 8 ]; then
  say "FAILED: need at least 8G free for the JDK + Node + Ghidra + jadx (have ${FREE_GB:-0}G)."
  say "Grow the disk first (cua_vm_disk) or delete files in the VM."
  exit 3
fi

# --- 2. JDK and host tools -------------------------------------------
say "installing openjdk-21-jdk-headless + unzip/curl/xz-utils/procps"
apt-get install -y -qq openjdk-21-jdk-headless procps unzip curl ca-certificates xz-utils \
  >/dev/null 2>&1 || die "apt could not install the JDK and the archive tools"
command -v javac >/dev/null 2>&1 || die "javac is missing after installing openjdk-21-jdk-headless"
JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
[ -x "$JAVA_HOME/bin/java" ] || die "derived JAVA_HOME ($JAVA_HOME) has no bin/java"
export JAVA_HOME
say "JAVA_HOME=$JAVA_HOME ($("$JAVA_HOME/bin/java" -version 2>&1 | head -1))"

# --- 3. Node ---------------------------------------------------------
# A floor, not equality: a disk that already has a newer 22.x keeps it, so a
# re-run after an image bump does not downgrade a working runtime.
node_ok() {
  [ -x "$NODE_DIR/bin/node" ] || return 1
  local have
  have="$("$NODE_DIR/bin/node" --version 2>/dev/null)" || return 1
  [ -n "$have" ] || return 1
  [ "$(printf '%s\n%s\n' "$NODE_VERSION" "$have" | sort -V | tail -1)" = "$have" ]
}

if node_ok; then
  say "node already present: $("$NODE_DIR/bin/node" --version) (>= $NODE_VERSION)"
else
  say "downloading node $NODE_VERSION"
  TMP_NODE=$(mktemp -d)
  NODE_TARBALL="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  if ! curl -fsSL --retry 3 -o "$TMP_NODE/$NODE_TARBALL" "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"; then
    rm -rf "$TMP_NODE"
    die "could not download node ${NODE_VERSION} (network or the pinned version is gone)"
  fi
  tar -xJf "$TMP_NODE/$NODE_TARBALL" -C "$TMP_NODE" || { rm -rf "$TMP_NODE"; die "node tarball did not extract (truncated download?)"; }
  rm -rf "$NODE_DIR"
  mv "$TMP_NODE/node-${NODE_VERSION}-linux-${NODE_ARCH}" "$NODE_DIR"
  rm -rf "$TMP_NODE"
fi
node_ok || die "node at $NODE_DIR is still unusable after installation"
# Symlink LAST so the VM's own PATH never resolves a half-installed node, and
# use /usr/local/bin (ahead of /usr/bin) so `node` in a desktop terminal is
# this one, not the harness runtime.
for bin in node npm npx corepack; do
  [ -e "$NODE_DIR/bin/$bin" ] || continue
  ln -sfn "$NODE_DIR/bin/$bin" "/usr/local/bin/$bin"
done
export PATH="$NODE_DIR/bin:/usr/local/bin:$PATH"
say "node: $("$NODE_DIR/bin/node" --version) npm: $("$NODE_DIR/bin/npm" --version)"

# --- 4. rea-agents ---------------------------------------------------
say "installing rea-agents (npm global, log /tmp/rea-npm.log)"
if ! "$NODE_DIR/bin/npm" install --global --no-fund --no-audit rea-agents@latest \
     >/tmp/rea-npm.log 2>&1; then
  tail -30 /tmp/rea-npm.log
  die "npm install --global rea-agents failed (see /tmp/rea-npm.log)"
fi
NPM_GLOBAL_ROOT="$("$NODE_DIR/bin/npm" root -g)"
REA_MJS="${NPM_GLOBAL_ROOT}/rea-agents/scripts/rea.mjs"
[ -f "$REA_MJS" ] || die "rea-agents installed but $REA_MJS is missing (layout changed?)"
REA_BIN="$NODE_DIR/bin/rea"
[ -x "$REA_BIN" ] || REA_BIN="$(command -v rea)"
[ -n "${REA_BIN:-}" ] || die "the rea launcher did not land in $NODE_DIR/bin"
ln -sfn "$REA_BIN" /usr/local/bin/rea
REA_VERSION="$("$REA_BIN" --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -1)"
REA_VERSION="${REA_VERSION:-unknown}"
say "rea $REA_VERSION at $REA_MJS"

# --- 5. Ghidra -------------------------------------------------------
ghidra_ok() {
  [ -x "$GHIDRA_DIR/support/analyzeHeadless" ] || return 1
  # The decompiler is a per-OS native binary; without it analyzeHeadless runs
  # and every decompile comes back empty.
  compgen -G "$GHIDRA_DIR/Ghidra/Features/Decompiler/os/*/decompile" >/dev/null 2>&1
}

if ghidra_ok; then
  say "ghidra already present at $GHIDRA_DIR"
else
  say "downloading Ghidra $GHIDRA_VERSION (~1.4G unpacked)"
  TMP_GHIDRA=$(mktemp -d)
  if ! curl -fsSL --retry 3 -o "$TMP_GHIDRA/ghidra.zip" "$GHIDRA_URL"; then
    rm -rf "$TMP_GHIDRA"
    die "could not download Ghidra $GHIDRA_VERSION from $GHIDRA_URL"
  fi
  unzip -q "$TMP_GHIDRA/ghidra.zip" -d "$TMP_GHIDRA/x" || { rm -rf "$TMP_GHIDRA"; die "Ghidra zip did not extract (truncated download?)"; }
  EXTRACTED="$(find "$TMP_GHIDRA/x" -maxdepth 1 -mindepth 1 -type d -name 'ghidra_*' | head -1)"
  [ -n "$EXTRACTED" ] || { rm -rf "$TMP_GHIDRA"; die "Ghidra zip had no ghidra_* top-level directory"; }
  rm -rf "$GHIDRA_DIR"
  mv "$EXTRACTED" "$GHIDRA_DIR"
  rm -rf "$TMP_GHIDRA"
fi
[ -x "$GHIDRA_DIR/support/analyzeHeadless" ] || die "$GHIDRA_DIR/support/analyzeHeadless is missing"
compgen -G "$GHIDRA_DIR/Ghidra/Features/Decompiler/os/*/decompile" >/dev/null 2>&1 \
  || die "Ghidra has no Decompiler/os/*/decompile binary — analysis would run but produce nothing"
ln -sfn "$GHIDRA_DIR" /opt/ghidra
chmod 0755 "$GHIDRA_DIR/support/analyzeHeadless" 2>/dev/null || true
say "ghidra: $("$GHIDRA_DIR/support/analyzeHeadless" 2>&1 | grep -oE 'Ghidra [0-9.]+' | head -1 || echo "$GHIDRA_VERSION")"

# --- 6. jadx + the headless MCP jar ----------------------------------
JADX_DIR=/opt/jadx
if [ -x "$JADX_DIR/bin/jadx" ]; then
  say "jadx already present at $JADX_DIR"
else
  say "downloading jadx $JADX_VERSION"
  TMP_JADX=$(mktemp -d)
  if ! curl -fsSL --retry 3 -o "$TMP_JADX/jadx.zip" "$JADX_URL"; then
    rm -rf "$TMP_JADX"
    die "could not download jadx $JADX_VERSION from $JADX_URL"
  fi
  unzip -q "$TMP_JADX/jadx.zip" -d "$TMP_JADX/x" || { rm -rf "$TMP_JADX"; die "jadx zip did not extract"; }
  # The release zip is either flat (bin/jadx) or wraps everything in
  # jadx-<version>/ (the 1.5.x layout). Both must land at /opt/jadx/bin/jadx,
  # because that is the path the env block and REA both point at.
  JADX_SRC="$TMP_JADX/x"
  if [ ! -x "$JADX_SRC/bin/jadx" ]; then
    NESTED="$(find "$JADX_SRC" -maxdepth 3 -type f -path '*/bin/jadx' | head -1)"
    [ -n "$NESTED" ] || { rm -rf "$TMP_JADX"; die "jadx zip has no bin/jadx"; }
    JADX_SRC="$(dirname "$(dirname "$NESTED")")"
  fi
  rm -rf "$JADX_DIR"
  mv "$JADX_SRC" "$JADX_DIR"
  rm -rf "$TMP_JADX"
fi
[ -x "$JADX_DIR/bin/jadx" ] || die "$JADX_DIR/bin/jadx is missing"
ln -sfn "$JADX_DIR/bin/jadx" /usr/local/bin/jadx
JADX_BIN="$JADX_DIR/bin/jadx"
say "jadx: $("$JADX_BIN" --version 2>/dev/null | head -1)"

mkdir -p "$REA_ANDROID_DIR"
JAR_PATH="$REA_ANDROID_DIR/$JADX_MCP_JAR"
if [ -f "$JAR_PATH" ] && \
   [ "$(sha256sum "$JAR_PATH" | awk '{print $1}')" = "$JADX_MCP_SHA256" ]; then
  say "jadx-headless-mcp jar already present (sha256 ok)"
else
  say "downloading $JADX_MCP_JAR"
  if ! curl -fsSL --retry 3 -o "$JAR_PATH.part" "$JADX_MCP_URL"; then
    rm -f "$JAR_PATH.part"
    die "could not download $JADX_MCP_JAR from $JADX_MCP_URL"
  fi
  HAVE_SHA="$(sha256sum "$JAR_PATH.part" | awk '{print $1}')"
  if [ "$HAVE_SHA" != "$JADX_MCP_SHA256" ]; then
    rm -f "$JAR_PATH.part"
    die "sha256 mismatch for $JADX_MCP_JAR: got $HAVE_SHA, want $JADX_MCP_SHA256 (truncated or proxied download)"
  fi
  mv "$JAR_PATH.part" "$JAR_PATH"
fi
[ "$(sha256sum "$JAR_PATH" | awk '{print $1}')" = "$JADX_MCP_SHA256" ] \
  || die "$JAR_PATH does not match the pinned sha256"
say "jadx-headless-mcp: $JAR_PATH (sha256 verified)"

# --- 7. environment, three ways --------------------------------------
# A login shell reads /etc/profile.d; anything started by systemd (the desktop
# session) reads its unit environment; /etc/environment covers PAM sessions
# that are neither. The supervisor's `cua sb exec` children land in the
# desktop session, which is why the drop-in is not optional.
say "persisting the REA environment (profile.d + /etc/environment + cua-spacesd drop-in)"

cat >/etc/profile.d/rea.sh <<EOF
# Reverse-engineering kit inside the CUA computer (see cua-guest-rea.sh).
export JAVA_HOME="$JAVA_HOME"
export GHIDRA_INSTALL_DIR="$GHIDRA_DIR"
export REA_ANALYSIS_PROVIDER=ghidra
export REA_JADX_MCP_JAR="$JAR_PATH"
case ":\$PATH:" in
  *":$NODE_DIR/bin:"*) ;;
  *) export PATH="$NODE_DIR/bin:/usr/local/bin:\$PATH" ;;
esac
EOF
chmod 0644 /etc/profile.d/rea.sh

# /etc/environment is KEY=value, not shell: no export, no $PATH edits. Replace
# an existing line rather than appending a duplicate (systemd and PAM disagree
# about which duplicate wins, so a stack of them is a real bug).
env_set() {
  local key="$1" value="$2"
  if grep -q "^${key}=" /etc/environment 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=\"${value}\"|" /etc/environment
  else
    printf '%s="%s"\n' "$key" "$value" >> /etc/environment
  fi
}
env_set JAVA_HOME "$JAVA_HOME"
env_set GHIDRA_INSTALL_DIR "$GHIDRA_DIR"
env_set REA_ANALYSIS_PROVIDER ghidra
env_set REA_JADX_MCP_JAR "$JAR_PATH"

mkdir -p "$(dirname "$SPACESD_DROPIN")"
cat >"$SPACESD_DROPIN" <<EOF
# REA inside the CUA desktop session (see cua-guest-rea.sh).
# cua sb exec inherits this session, so the variables have to be here and not
# only in the provisioning shell.
[Service]
Environment=JAVA_HOME=$JAVA_HOME
Environment=GHIDRA_INSTALL_DIR=$GHIDRA_DIR
Environment=REA_ANALYSIS_PROVIDER=ghidra
Environment=REA_JADX_MCP_JAR=$JAR_PATH
Environment=PATH=$NODE_DIR/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin
EOF
chmod 0644 "$SPACESD_DROPIN"
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload >/dev/null 2>&1 || say "daemon-reload deferred (no systemd running yet)"
fi

# --- 8. registration as the desktop user -----------------------------
# Everything from here runs as `cua`: ~/.dsh belongs to the desktop user, and
# a root-owned profile is a plugin loader that silently ignores its own file.
say "registering the rea MCP row for the guest's DSH profile"
REA_ENV=(HOME=/home/cua
  JAVA_HOME="$JAVA_HOME"
  GHIDRA_INSTALL_DIR="$GHIDRA_DIR"
  REA_ANALYSIS_PROVIDER=ghidra
  REA_JADX_MCP_JAR="$JAR_PATH"
  PATH="$NODE_DIR/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin")
as_cua_rea() { sudo -u cua -H env "${REA_ENV[@]}" "$@"; }

REGISTERED=""
if as_cua_rea "$REA_BIN" setup --client dsh --yes --json >/tmp/rea-setup.json 2>/tmp/rea-setup.err; then
  REGISTERED=dsh
  say "rea setup --client dsh wrote the row"
else
  say "rea setup --client dsh did not complete; writing the row by hand"
  tail -5 /tmp/rea-setup.err || true
  PATCH_DIR=/home/cua/.dsh
  PATCH_FILE="$PATCH_DIR/cordis.patch.yml"
  mkdir -p "$PATCH_DIR"
  if [ ! -f "$PATCH_FILE" ] || ! grep -q 'rea-mcp' "$PATCH_FILE" 2>/dev/null; then
    {
      printf '\n# rea — the RE kit installed by cua-guest-rea.sh. One MCP row, the\n'
      printf "# same fragment shape as the image's browser-mcp row.\n"
      printf -- '- insert:\n'
      printf '    - id: rea-mcp\n'
      printf "      name: '@deepseek-ai/dsh-mcp-client'\n"
      printf '      config:\n'
      printf '        serverName: rea\n'
      printf '        transport: stdio\n'
      printf '        command: %s\n' "$NODE_DIR/bin/node"
      printf '        args:\n'
      printf '          - %s\n' "$REA_MJS"
      printf '          - mcp\n'
      printf '        env:\n'
      printf '          GHIDRA_INSTALL_DIR: %s\n' "$GHIDRA_DIR"
      printf '          JAVA_HOME: %s\n' "$JAVA_HOME"
      printf '          REA_ANALYSIS_PROVIDER: ghidra\n'
      printf '          REA_JADX_MCP_JAR: %s\n' "$JAR_PATH"
    } >>"$PATCH_FILE"
    REGISTERED=manual
  else
    REGISTERED=manual
    say "a rea-mcp row is already present; left untouched"
  fi
  chown -R cua:cua "$PATCH_DIR" 2>/dev/null || true
  chmod 0644 "$PATCH_FILE" 2>/dev/null || true
fi
# `registered=dsh|manual` is a provenance note, not a pass/fail gate: the row
# exists either way, and a probe that fails on the spelling of its own success
# would be worse than useless.
REGISTERED="${REGISTERED:-manual}"

if as_cua_rea "$REA_BIN" setup --skill --yes --json >/tmp/rea-skill.json 2>/tmp/rea-skill.err; then
  say "rea skills installed for the desktop user"
else
  say "rea setup --skill did not complete (the MCP row is still usable)"
  tail -5 /tmp/rea-skill.err || true
fi
chown -R cua:cua /opt/rea /home/cua/.dsh 2>/dev/null || true

# --- 9. prove it -----------------------------------------------------
say "running rea doctor --provider ghidra --json as cua"
if ! as_cua_rea "$REA_BIN" doctor --provider ghidra --json >/tmp/rea-doctor.json 2>/tmp/rea-doctor.err; then
  tail -30 /tmp/rea-doctor.json 2>/dev/null || true
  tail -10 /tmp/rea-doctor.err 2>/dev/null || true
  die "rea doctor --provider ghidra failed; the kit is installed but unusable"
fi
say "doctor: $(tr -d '\n' </tmp/rea-doctor.json | cut -c1-400)"

# Marker LAST: a run that dies before this point is retried in full.
cat >"$MARKER" <<EOF
version=$VERSION
node=$("$NODE_DIR/bin/node" --version)
rea=$REA_VERSION
ghidra=$GHIDRA_VERSION
jdk=$("$JAVA_HOME/bin/java" -version 2>&1 | head -1 | grep -oE '[0-9]+(\.[0-9]+)*' | head -1)
jadx=$("$JADX_BIN" --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
java_home=$JAVA_HOME
rea_mjs=$REA_MJS
jadx_mcp_jar=$JAR_PATH
registered=$REGISTERED
provisioned=$(date -Is)
EOF

say "OK node=$("$NODE_DIR/bin/node" --version) rea=$REA_VERSION ghidra=$GHIDRA_VERSION jdk=$("$JAVA_HOME/bin/java" -version 2>&1 | head -1 | grep -oE '[0-9]+(\.[0-9]+)*' | head -1) jadx=$("$JADX_BIN" --version 2>/dev/null | head -1) registered=$REGISTERED"
# Detach the restart: cua-spacesd owns this session, and restarting it from
# inside a `cua sb exec` child would kill the child mid-restart. The sleep lets
# this script and the exec return first.
setsid sh -c 'sleep 5; systemctl daemon-reload; systemctl restart cua-spacesd' </dev/null >/dev/null 2>&1 &
