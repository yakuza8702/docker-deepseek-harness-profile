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
# The image prunes /var/lib/apt/lists at the end of every earlier apt block, so
# an install without an index refresh fails with "Unable to locate package" —
# measured in CI, where this exact omission failed three consecutive builds.
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends libpulse0 libxdamage1
rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------
# 1b. The container user must be able to open /dev/kvm.
#
# The device node carries the gid that owns /dev/kvm ON THE HOST (104 on the
# reference host: `kvm:x:104:`), so the image needs a group with that same
# NUMBER and the runtime user in it. Nothing on the compose side is then
# required — no `group_add`, no udev rule, and the device stays 0660.
#
# This only works because the runtime user's supplementary groups are applied
# at all: Docker DROPS them when a container is started with an explicit
# `user:`/`USER name:group` spec, even when it names the same user and group.
# Measured:
#     USER node          → groups=1000(node),104(kvm)
#     --user node:node   → groups=1000(node)          ← no 104, no device access
# The Dockerfile therefore ends with `USER node`, not `USER node:node`.
#
# If a compose file sets `user: node:node` anyway, the membership is dropped
# again and `group_add: ["<gid>"]` is the only way back — that is a property of
# how Docker composes the spec, not something this image can work around.
# ---------------------------------------------------------------------
KVM_GID="${KVM_GID:-104}"
step "kvm group at the host's gid (${KVM_GID}) + membership for the runtime user"
KVM_GROUP_NAME="kvm"
_existing="$(getent group "$KVM_GID" | cut -d: -f1 || true)"
if [ -n "$_existing" ] && [ "$_existing" != "kvm" ]; then
  # The gid is already taken by another group name: use it as-is rather than
  # renaming a package's group out from under its files.
  KVM_GROUP_NAME="$_existing"
  echo "gid ${KVM_GID} belongs to the existing group '${KVM_GROUP_NAME}'"
elif getent group kvm >/dev/null; then
  groupmod -g "$KVM_GID" kvm
else
  groupadd -g "$KVM_GID" kvm
fi
usermod -aG "$KVM_GROUP_NAME" node
echo "node supplementary groups: $(id -nG node 2>/dev/null)"
getent group "$KVM_GROUP_NAME"

# ---------------------------------------------------------------------
# 2. The emulator and one system image, into the SDK the APK toolchain
#    already created. Licenses are accepted non-interactively (the modern
#    CLI no longer needs this, older ones do — hence the fallback).
# ---------------------------------------------------------------------
step "Android SDK: platform-tools + emulator + system-images;${EMU_API};${EMU_TAG};${EMU_ABI}"
# platform-tools is NOT for adb — the image keeps Debian's adb on purpose (see
# apk-toolchain.sh: Google's platform-tools has no aarch64 build). It is here
# because the EMULATOR validates its SDK root by looking for that directory:
# without it the launcher prints
#     WARN: Cannot find valid sdk root from environment variable ANDROID_HOME …
# and then cannot resolve the system image at all, so no AVD will ever boot.
# Measured: with the directory, "Found systemPath …"; without it, the warning and
# nothing else. This whole section is x86_64-only anyway, where the package exists.
yes | "$SDKMANAGER" --sdk_root="$SDK" --licenses >/dev/null 2>&1 || true
"$SDKMANAGER" --sdk_root="$SDK" --install \
  "platform-tools" \
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

# ---------------------------------------------------------------------
# 3b. HAND IT TO THE RUNTIME USER.
#
# The image is built as root but RUNS as uid 1000, and this section comes
# AFTER apk-toolchain.sh's own `chown -R node:node …` — so nothing installed
# here is reachable unless it is said so explicitly. sdkmanager preserves the
# archive's mode for the launcher, which arrives as 0744 root:root: root can
# execute it, "others" — the runtime user — cannot. Every symptom of that is
# the same and misleading: `emulator-tools` reports NOT INSTALLED, and a
# `ls` of /opt looks completely fine. Measured in CI, where the build passed.
#
# `a+rX` adds read for all and execute only where it already exists (dirs and
# programs), and the find mirrors root's execute bit onto every program.
# ---------------------------------------------------------------------
step "runtime-user permissions (uid 1000)"
chown -R node:node "$SDK/emulator" "$SDK/system-images"
chmod -R a+rX "$SDK/emulator" "$SDK/system-images"
find "$SDK/emulator" -type f -perm -0100 -exec chmod a+x {} +
chmod 0755 "$SDK/emulator/emulator"
# Created here with the right mode: a later `COPY --chmod=0644 … /opt/emulator-tools/x`
# would otherwise create the DIRECTORY as 0644 — a directory without the search bit,
# which nobody but root can even list.
mkdir -p /opt/emulator-tools
chmod 0755 /opt/emulator-tools

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
