#!/bin/bash
# =====================================================================
# Android EMULATOR toolchain — build-time installer.
#
# Called once by the Dockerfile (as root, before the image drops to uid
# 1000). Like docker/apk-toolchain.sh it is a standalone script so it can be
# executed VERBATIM against a stock base image and proved on its own:
#
#   docker run --rm node:24-trixie bash -s < docker/emulator-toolchain.sh
#
# WHY IT IS IN THE IMAGE
# The APK toolchain answers "what does this app do?" from a FILE. It cannot
# answer "what does this app DO when it runs": permission prompts, camera
# capture, WebView rendering, insets on a device with a cutout. Those need a
# booted Android system. Without this layer the honest answer is "install an
# emulator first", which costs the agent a ~1.3 GB download and a detour in
# the middle of the task it was asked to do.
#
# WHAT EACH PIECE BUYS
#   emulator        the QEMU-based Android emulator (Linux x86_64 only)
#   system image    a bootable Android (API ${EMU_API}) google_apis image
#   libpulse0       the emulator links libpulse.so.0 DIRECTLY — without it the
#                   binary does not start at all (measured, not guessed)
#   libxdamage1     X11 damage extension, used by the emulator's Qt window path
#   kvm group       so a compose `group_add: [kvm]` can resolve the name
#   adb             already in the image from Debian — see apk-toolchain.sh
#
# HARDWARE ACCELERATION IS A RUNTIME DEVICE, NOT A PACKAGE.
# /dev/kvm must be handed to the container (compose.emulator.yaml, or
# `docker run --device /dev/kvm --group-add kvm`). Without it the emulator
# REFUSES to start: "x86_64 emulation currently requires hardware
# acceleration!". With `-accel off` it boots, but the guest is so slow that
# Android's own watchdog kills system_server ("*** WATCHDOG KILLING SYSTEM
# PROCESS") within minutes, so API 34+ is effectively untestable without KVM.
# That is why `-accel-check` is allowed to report "not found" here: the build
# has no device, the container does.
#
# ARCHITECTURE: Google publishes the Linux emulator for x86_64 ONLY
# (linux_x64, darwin_x64, darwin_aarch64, windows_x64 — there is no
# linux_aarch64). On any other architecture this installer installs nothing
# and says so, exactly as apk-toolchain.sh takes adb from Debian because
# Google's platform-tools has no aarch64 build either.
#
# SIZE: roughly 2.4 GB (emulator ~1.0 GB, system image ~1.3 GB).
# =====================================================================
set -euo pipefail

EMU_API="${EMU_API:-android-36}"
EMU_TAG="${EMU_TAG:-google_apis}"
EMU_ABI="${EMU_ABI:-x86_64}"

SDK="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"

step() { printf '\n=== %s\n' "$*"; }

arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"

if [ "$arch" != "amd64" ]; then
  step "Android emulator: not available for linux/$arch — skipping"
  echo "Google publishes the Linux emulator for x86_64 only (no linux_aarch64)."
  echo "Static APK analysis still works; device testing needs an x86_64 host."
  exit 0
fi

if [ ! -x "$SDKMANAGER" ]; then
  echo "emulator-toolchain: no sdkmanager at $SDKMANAGER — run apk-toolchain.sh first" >&2
  exit 1
fi

# ---------------------------------------------------------------------
# 1. The two host libraries the emulator binary needs. Both were measured
#    missing on the stock Debian base; every other X/GL dependency the
#    emulator has (libGL, libX11/xcb, libnss3, libasound) was already there.
# ---------------------------------------------------------------------
step "apt: libpulse0 libxdamage1 (emulator runtime libraries)"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends libpulse0 libxdamage1

# The `kvm` group must EXIST in the image for a compose `group_add: [kvm]` to
# resolve; the gid does not matter because the device node keeps its own.
step "kvm group"
groupadd -f kvm

# ---------------------------------------------------------------------
# 2. The emulator and one system image, into the SDK the APK toolchain
#    already created. Licenses are accepted non-interactively (the modern
#    CLI no longer needs this, older ones do — hence the fallback).
# ---------------------------------------------------------------------
step "Android SDK: emulator + system-images;${EMU_API};${EMU_TAG};${EMU_ABI}"
yes | "$SDKMANAGER" --sdk_root="$SDK" --licenses >/dev/null 2>&1 || true
"$SDKMANAGER" --sdk_root="$SDK" --install \
  "emulator" \
  "system-images;${EMU_API};${EMU_TAG};${EMU_ABI}"

# ---------------------------------------------------------------------
# 3. Prove it here, not in the turn where an agent needs it: the emulator
#    must be able to print its version (a missing libpulse0 fails exactly
#    here), and the system image must carry its own metadata.
# ---------------------------------------------------------------------
step "verifying the emulator runs"
"$SDK/emulator/emulator" -version

image_dir="$SDK/system-images/${EMU_API}/${EMU_TAG}/${EMU_ABI}"
if [ ! -f "$image_dir/source.properties" ]; then
  echo "emulator-toolchain: system image is incomplete (no source.properties in $image_dir)" >&2
  exit 1
fi
echo "system image: $image_dir"

# A convenience symlink: every other SDK tool is on PATH, this one should be too.
ln -sfn "$SDK/emulator/emulator" /usr/local/bin/emulator

# Expected to report "not found" at build time: /dev/kvm is a runtime device.
step "acceleration status (build time — /dev/kvm arrives with the container)"
"$SDK/emulator/emulator" -accel-check || true

# The AVD itself is created at container start (see docker/entrypoint.sh) into
# /workspace, because the rootfs is read-only at runtime by design.
step "done"
echo "AVDs live in \$ANDROID_AVD_HOME (default /workspace/.android/avd, created at boot)."
echo "Inventory: emulator-tools      Boot: emulator-tools --up"
