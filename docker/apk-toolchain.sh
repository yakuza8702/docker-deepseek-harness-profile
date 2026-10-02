#!/bin/bash
# =====================================================================
# APK / Android reverse-engineering toolchain — build-time installer.
#
# Called once by the Dockerfile (as root, before the image drops to uid
# 1000). It is deliberately a standalone script rather than an inlined RUN
# block so it can be executed VERBATIM against a stock base image and
# proved on its own, without building this repo's image:
#
#   docker run --rm node:24-trixie bash -s < docker/apk-toolchain.sh
#
# (the Dockerfile passes the versions through the APK_* environment
# variables below; their defaults are the pinned set this repo ships).
#
# Design rules, in the same spirit as the rest of this repo:
#   * every download is version-pinned AND checksum-verified against the
#     value the vendor publishes (GitHub release digest / Google's
#     repository2-3.xml), so a silent upstream swap fails the build
#     instead of silently changing what an .apk analysis reports;
#   * every tool is EXECUTED here at least once — a "downloaded" tool that
#     cannot run (missing JVM, wrong arch) fails the build, not the turn
#     where an agent finally needs it;
#   * nothing here talks to a phone and nothing runs at container start:
#     this is static analysis capability, not a service.
#
# adb comes from Debian, not from Google's platform-tools: that zip ships
# no aarch64 build, and this image is built for arm64 too.
# =====================================================================
set -euo pipefail

APK_JADX_VERSION="${APK_JADX_VERSION:-1.5.6}"
APK_JADX_SHA256="${APK_JADX_SHA256:-545ea2be9c242511bc145755cf4bda2485ade42966e096f8b4d3da2a230e8974}"
APK_APKTOOL_VERSION="${APK_APKTOOL_VERSION:-3.0.3}"
APK_APKTOOL_SHA256="${APK_APKTOOL_SHA256:-dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423}"
APK_CMDLINE_TOOLS_BUILD="${APK_CMDLINE_TOOLS_BUILD:-16111833}"
APK_CMDLINE_TOOLS_SHA1="${APK_CMDLINE_TOOLS_SHA1:-e025545c62a8e64c7559119566a569fb1dec5f60}"
APK_BUILD_TOOLS="${APK_BUILD_TOOLS:-36.1.0}"
APK_PLATFORM="${APK_PLATFORM:-android-36}"
# Python-facing half: Hermes bytecode, dynamic instrumentation, and
# scriptable APK analysis without a JVM. Pinned as one list so a single
# override (APK_PY_PINS="...") can bump any of them.
APK_PY_PINS="${APK_PY_PINS:-hbctool==0.1.5 hermes-dec==0.1.7 frida-tools==14.10.4 frida-dexdump==2.0.1 objection==1.12.5 androguard==4.1.4 apkid==3.1.0}"

VENV=/opt/apk-tools/venv
SDK=/opt/android-sdk
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

step() { printf '\n=== %s\n' "$*"; }

# ---------------------------------------------------------------------
# 1. The JVM. jadx, apktool, apksigner, sdkmanager and apkanalyzer are all
#    Java programs; without a JRE none of them can even print a version.
#    python3-venv is what pip-installs the analysis libraries into their
#    own prefix instead of fighting Debian's PEP 668 "externally managed".
# ---------------------------------------------------------------------
step "apt: JDK, python venv, adb"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  default-jdk-headless \
  python3-venv \
  adb
rm -rf /var/lib/apt/lists/*
javac -version
adb version | head -n 1

# JAVA_HOME as a stable, architecture-independent path: the real JDK path
# carries the arch (java-21-openjdk-amd64 / -arm64) and tools like Gradle
# and sdkmanager refuse to guess. /opt/java is the single spelling the
# image (and its users) can rely on.
JAVA_HOME_REAL="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
ln -sfn "$JAVA_HOME_REAL" /opt/java
export JAVA_HOME=/opt/java
[ -x "$JAVA_HOME/bin/java" ] || { echo "ERROR: JAVA_HOME=$JAVA_HOME has no bin/java" >&2; exit 1; }
java -version

# ---------------------------------------------------------------------
# 2. jadx — DEX to Java source. This is the tool that turns "strings from
#    the string table" into the app's actual logic.
# ---------------------------------------------------------------------
step "jadx ${APK_JADX_VERSION}"
curl -fsSL --retry 3 -o "$TMP/jadx.zip" \
  "https://github.com/skylot/jadx/releases/download/v${APK_JADX_VERSION}/jadx-${APK_JADX_VERSION}.zip"
echo "${APK_JADX_SHA256}  $TMP/jadx.zip" | sha256sum -c -
mkdir -p /opt/jadx
unzip -q "$TMP/jadx.zip" -d /opt/jadx
chmod 0755 /opt/jadx/bin/jadx /opt/jadx/bin/jadx-gui
ln -sfn /opt/jadx/bin/jadx /usr/local/bin/jadx
# jadx-gui runs on the VNC desktop (DISPLAY=:99) — the same visible-desktop
# idea as the browser stack: a human can point at what the agent found.
ln -sfn /opt/jadx/bin/jadx-gui /usr/local/bin/jadx-gui
jadx --version

# ---------------------------------------------------------------------
# 3. apktool — the only sane path to a REPACK: it decodes the binary
#    AndroidManifest.xml and resources.arsc into real XML and smali, and
#    rebuilds them. (jadx is a decompiler; it cannot produce an APK.)
# ---------------------------------------------------------------------
step "apktool ${APK_APKTOOL_VERSION}"
mkdir -p /opt/apktool
curl -fsSL --retry 3 -o /opt/apktool/apktool.jar \
  "https://github.com/iBotPeaches/Apktool/releases/download/v${APK_APKTOOL_VERSION}/apktool_${APK_APKTOOL_VERSION}.jar"
echo "${APK_APKTOOL_SHA256}  /opt/apktool/apktool.jar" | sha256sum -c -
printf '%s\n' \
  '#!/bin/sh' \
  '# apktool — pinned jar, run through the image JDK (see /opt/apk-tools/README.md).' \
  'exec java -jar /opt/apktool/apktool.jar "$@"' \
  > /usr/local/bin/apktool
chmod 0755 /usr/local/bin/apktool
apktool --version

# ---------------------------------------------------------------------
# 4. Python half. Hermes is the reason this exists: a React-Native app's
#    real logic is NOT in the DEX, it is in assets/index.android.bundle,
#    which is Hermes bytecode (HBC) — a black box to jadx and to strings.
#    hbctool and hermes-dec cover different HBC revisions, so both ship.
#    --system-site-packages keeps the venv transparent: `python3` and
#    `pip` stay the same interpreter, so `pip install X` followed by
#    `python3 -c "import X"` behaves the way an operator expects.
# ---------------------------------------------------------------------
step "python venv: ${APK_PY_PINS}"
python3 -m venv --system-site-packages "$VENV"
"$VENV/bin/pip" install --no-cache-dir --upgrade pip >/dev/null
# shellcheck disable=SC2086  # APK_PY_PINS is intentionally a space-separated list
"$VENV/bin/pip" install --no-cache-dir ${APK_PY_PINS}
"$VENV/bin/pip" list --format=freeze \
  | grep -Ei '^(hbctool|hermes-dec|frida|frida-tools|frida-dexdump|objection|androguard|apkid)='

# ---------------------------------------------------------------------
# 5. Android SDK (command-line tools only): apksigner + zipalign + aapt2
#    sign and align a rebuilt APK; apkanalyzer reads an APK without
#    unpacking it. Needed to INSTALL a patched build, and to answer "is
#    this the same app" from the shell. (Platform + build-tools are
#    pinned; `sdkmanager --install …` adds more when the rootfs is
#    writable — by default it is not, see the README.)
# ---------------------------------------------------------------------
step "Android SDK cmdline-tools ${APK_CMDLINE_TOOLS_BUILD}, build-tools ${APK_BUILD_TOOLS}, ${APK_PLATFORM}"
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
mkdir -p "$SDK/cmdline-tools"
curl -fsSL --retry 3 -o "$TMP/cmdline-tools.zip" \
  "https://dl.google.com/android/repository/commandlinetools-linux-${APK_CMDLINE_TOOLS_BUILD}_latest.zip"
echo "${APK_CMDLINE_TOOLS_SHA1}  $TMP/cmdline-tools.zip" | sha1sum -c -
unzip -q "$TMP/cmdline-tools.zip" -d "$TMP/clt"
mv "$TMP/clt/cmdline-tools" "$SDK/cmdline-tools/latest"
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"
# License prompts read from stdin; `yes` is killed by SIGPIPE when the
# prompt loop ends, which pipefail would turn into a failure, and the
# install below is what actually proves the licenses were accepted.
set +o pipefail
yes | "$SDKMANAGER" --sdk_root="$SDK" --licenses >/dev/null 2>&1 || true
set -o pipefail
"$SDKMANAGER" --sdk_root="$SDK" --install "build-tools;${APK_BUILD_TOOLS}" "platforms;${APK_PLATFORM}"
ln -sfn "$SDK/cmdline-tools/latest/bin/sdkmanager" /usr/local/bin/sdkmanager
ln -sfn "$SDK/cmdline-tools/latest/bin/apkanalyzer" /usr/local/bin/apkanalyzer
ln -sfn "$SDK/cmdline-tools/latest/bin/avdmanager" /usr/local/bin/avdmanager

# Build-tools binaries are versioned directories, so the wrappers below
# resolve "newest installed" at call time — bumping APK_BUILD_TOOLS never
# leaves a stale absolute path behind.
for tool in apksigner zipalign aapt aapt2 aidl d8 dexdump; do
  printf '%s\n' \
    '#!/bin/sh' \
    "# $tool — newest Android build-tools installed in this image." \
    "# See /opt/apk-tools/README.md; APK_BUILD_TOOLS pins what ships." \
    'set -eu' \
    'name="$(basename "$0")"' \
    'for dir in $(ls -1d /opt/android-sdk/build-tools/*/ 2>/dev/null | sort -Vr); do' \
    '  if [ -x "$dir$name" ]; then exec "$dir$name" "$@"; fi' \
    'done' \
    'echo "$name: no Android build-tools under /opt/android-sdk (sdkmanager --install \"build-tools;<version>\")" >&2' \
    'exit 127' \
    > "/usr/local/bin/$tool"
  chmod 0755 "/usr/local/bin/$tool"
done
"$SDKMANAGER" --sdk_root="$SDK" --list_installed | sed -n '1,12p'
apksigner --version
zipalign 2>&1 | head -n 1 || true

# ---------------------------------------------------------------------
# 6. Record exactly what was installed. Reproducibility is the point: an
#    analysis report can cite this file instead of "whatever :latest was".
# ---------------------------------------------------------------------
step "version manifest"
{
  printf '# APK / Android reverse-engineering toolchain — installed versions\n'
  printf '# generated by docker/apk-toolchain.sh\n'
  printf 'installed_utc: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'arch: %s\n' "$(dpkg --print-architecture)"
  printf 'java: %s\n' "$(java -version 2>&1 | head -n 1)"
  printf 'javac: %s\n' "$(javac -version 2>&1 | head -n 1)"
  printf 'jadx: %s\n' "$(jadx --version 2>&1 | head -n 1)"
  printf 'apktool: %s\n' "$(apktool --version 2>&1 | head -n 1)"
  printf 'adb: %s\n' "$(adb version 2>&1 | head -n 1)"
  printf 'android_build_tools: %s\n' "$APK_BUILD_TOOLS"
  printf 'android_platform: %s\n' "$APK_PLATFORM"
  printf 'android_cmdline_tools_build: %s\n' "$APK_CMDLINE_TOOLS_BUILD"
  printf 'apksigner: %s\n' "$(apksigner --version 2>&1 | head -n 1)"
  printf 'python: %s\n' "$("$VENV/bin/python" -V 2>&1)"
  printf 'python_pins: %s\n' "$APK_PY_PINS"
  printf 'sha256_jadx_zip: %s\n' "$APK_JADX_SHA256"
  printf 'sha256_apktool_jar: %s\n' "$APK_APKTOOL_SHA256"
  printf 'sha1_cmdline_tools_zip: %s\n' "$APK_CMDLINE_TOOLS_SHA1"
} > /opt/apk-tools/VERSIONS.txt
sed -n '1,20p' /opt/apk-tools/VERSIONS.txt

# Everything here is read-only at runtime (the stack runs read_only:true),
# but it must be readable AND the SDK must stay writable for a build that
# needs one more platform package with read_only turned off.
if id node >/dev/null 2>&1; then
  chown -R node:node /opt/apk-tools "$SDK" /opt/jadx /opt/apktool
fi

step "apk toolchain installed"
