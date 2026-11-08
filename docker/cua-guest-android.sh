#!/bin/bash
# =====================================================================
# cua-guest-android.sh — Android development inside the personal VM.
#
# The official Google emulator runs **inside** the CUA computer, with
# hardware acceleration, because the VM is created with `-cpu host` (so
# vmx/svm reach the guest) and provision-gpu.sh opens /dev/kvm. Nothing
# Android-related belongs in the harness image: this script keeps ~8 GB of
# SDK and AVD inside the VM disk, where the model can create, boot, install
# and test apps and only export the APK when it builds.
#
# Environment:
#   API=35                        Android API level to install
#   VARIANT=google_apis           google_apis | google_apis_playstore | default
#   ARCH=x86_64                   x86_64 (fast, needs KVM) | arm64-v8a
#   AVD=cua                       AVD name
#   CMDTOOLS_URL=...              override the command-line tools zip
#
# The whole run is idempotent; `sdkmanager` skips what is already there.
# =====================================================================
set -u

API="${API:-35}"
VARIANT="${VARIANT:-google_apis}"
ARCH="${ARCH:-x86_64}"
AVD="${AVD:-cua}"
SDK=/opt/android-sdk
MARKER=/var/lib/cua-android
LOG=/var/log/cua-android.log
CMDTOOLS_URL="${CMDTOOLS_URL:-https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip}"
IMAGE="system-images;android-${API};${VARIANT};${ARCH}"

exec > >(tee -a "$LOG") 2>&1
echo "=== $(date -Is) android provision image=$IMAGE avd=$AVD ==="
say() { echo "[android] $*"; }

if [ -f "$MARKER" ] && grep -qx "image=$IMAGE" "$MARKER" 2>/dev/null && grep -qx "avd=$AVD" "$MARKER" 2>/dev/null; then
  say "already provisioned"
  exit 0
fi

# --- preflight -------------------------------------------------------
FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
say "free disk: ${FREE_GB}G"
if [ "${FREE_GB:-0}" -lt 12 ]; then
  say "FAILED: need at least 12G free for the SDK + system image + AVD userdata (have ${FREE_GB}G)."
  say "Grow the disk first (cua_vm_disk) or delete files in the VM."
  exit 3
fi
if [ ! -w /dev/kvm ]; then
  say "FAILED: /dev/kvm is not writable by the guest user; the emulator would fall back to"
  say "software emulation (unusably slow). Run the GPU provision step first."
  exit 4
fi

export DEBIAN_FRONTEND=noninteractive
say "installing host packages for the emulator"
# sdkmanager/avdmanager are Java; the emulator itself links the usual X/GL/
# audio/nspr stack plus libpulse.
apt-get update -qq >/dev/null 2>&1 || true
apt-get install -y -qq openjdk-17-jdk-headless unzip curl ca-certificates \
  libpulse0 libnss3 libx11-6 libxcb1 libxcomposite1 libxcursor1 libxi6 \
  libxtst6 libglu1-mesa libgbm1 fonts-dejavu-core >/dev/null 2>&1 || true
command -v java >/dev/null 2>&1 || { say "FAILED: java missing (apt is broken?)"; exit 5; }

# --- command-line tools ----------------------------------------------
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  say "downloading command-line tools"
  mkdir -p "$SDK/cmdline-tools"
  TMP=$(mktemp -d)
  if ! curl -fsSL --retry 3 -o "$TMP/cmdtools.zip" "$CMDTOOLS_URL"; then
    say "FAILED: could not download $CMDTOOLS_URL"
    exit 6
  fi
  unzip -q "$TMP/cmdtools.zip" -d "$TMP/x"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$TMP/x/cmdline-tools" "$SDK/cmdline-tools/latest"
  rm -rf "$TMP"
fi
chown -R cua:cua "$SDK"
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
export PATH="$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$SDK/emulator:$PATH"

# sdkmanager refuses to run as root's HOME mismatch; run as the desktop user.
as_cua() { sudo -u cua -H env ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK" PATH="$PATH" "$@"; }

say "accepting licences"
yes 2>/dev/null | as_cua sdkmanager --licenses >/dev/null 2>&1 || true
say "installing platform-tools, emulator, platform $API and $IMAGE (this is the slow part)"
# shellcheck disable=SC2086
if ! as_cua sdkmanager --install "platform-tools" "emulator" "platforms;android-${API}" "$IMAGE" >/dev/null 2>&1; then
  say "sdkmanager failed; retrying with output"
  as_cua sdkmanager --install "platform-tools" "emulator" "platforms;android-${API}" "$IMAGE" || exit 7
fi

# --- AVD -------------------------------------------------------------
say "creating AVD $AVD"
# shellcheck disable=SC2086
echo no | as_cua avdmanager create avd -n "$AVD" -k "$IMAGE" -d pixel_6 --force >/dev/null 2>&1 || true
CFG="/home/cua/.android/avd/${AVD}.avd/config.ini"
if [ -f "$CFG" ]; then
  # RAM/GPU tuned for a VM guest: the emulator's default 2 GB plus the
  # desktop does not fit in a 4 GB computer.
  sed -i '/^hw\.gpu\./d;/^hw\.ramSize/d;/^hw\.keyboard/d' "$CFG" 2>/dev/null || true
  cat >>"$CFG" <<EOF
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
hw.keyboard=yes
hw.ramSize=3072
EOF
  chown cua:cua "$CFG" 2>/dev/null || true
fi

# --- launcher --------------------------------------------------------
cat >/usr/local/bin/cua-emulator <<'EOF'
#!/bin/bash
# Launch the CUA Android emulator inside the guest desktop.
#   cua-emulator                 # windowed, software GLES (safe in a VM)
#   cua-emulator -no-window      # headless, for adb-driven testing
#   CUA_EMU_GPU=host cua-emulator  # try virgl through the host GL stack
set -u
export ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"
export DISPLAY="${DISPLAY:-:1}"
exec "$ANDROID_HOME/emulator/emulator" -avd "${AVD:-cua}" \
  -gpu "${CUA_EMU_GPU:-swiftshader_indirect}" \
  -no-boot-anim -no-snapshot -no-audio -netdelay none -netspeed full \
  "$@"
EOF
chmod 0755 /usr/local/bin/cua-emulator
cat >/etc/profile.d/android.sh <<'EOF'
export ANDROID_HOME=/opt/android-sdk
export ANDROID_SDK_ROOT=/opt/android-sdk
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
EOF

cat >"$MARKER" <<EOF
image=$IMAGE
avd=$AVD
sdk=$SDK
provisioned=$(date -Is)
EOF
say "OK image=$IMAGE avd=$AVD (run: cua-emulator)"
