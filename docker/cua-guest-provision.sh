#!/bin/bash
# =====================================================================
# cua-guest-provision.sh — turn a fresh CUA disk into a workstation the
# agent can actually work in.
#
# Run by the supervisor through `cua sb exec ... | sudo -n bash`, once per
# computer and image version. Everything here is idempotent and every step
# is verified before the version marker is written, so a run that dies
# halfway is retried in full on the next start.
#
# What it fixes (each one was a real failure observed in testing):
#
#   1. `UNAVAILABLE` apt suites. A fresh Cua disk ships placeholder
#      sources, so `apt-get install` exits 100 and everything that depends
#      on a package silently degrades — the desktop stays on Xvfb, the
#      render node stays 0660, the guest has no `growpart`.
#   2. Xvfb cannot see the virgl DRM node. `glxinfo` reports llvmpipe even
#      though `eglinfo` says virgl, because Xvfb never opens /dev/dri. Xorg
#      with an explicit virtio/modesetting config is the only fix.
#   3. `renderD128` is root:render 0660 and the desktop user is not in
#      `render`. EGL apps (Chromium, the Android emulator, Blender) fall
#      back to llvmpipe even on an accelerated desktop.
#   4. `/dev/kvm` is root:kvm 0660. It IS there (the VM runs with `-cpu
#      host`, so vmx/svm is exposed and nesting works), but the guest user
#      cannot open it, so the official Android emulator refuses to start.
#   5. virgl reports OpenGL **4.2** although it exposes the 4.3 extension
#      set (compute shaders, SSBOs, program interface query, multi-bind).
#      Blender 4.x refuses to start below 4.3 and the only workaround was
#      `LIBGL_ALWAYS_SOFTWARE=1` — i.e. giving up the GPU. The reported
#      version is what is capped, not the feature set, so the session gets
#      MESA_GL_VERSION_OVERRIDE=4.3FC: real GPU, no software fallback.
#   6. The host workspace is not visible in the guest, so "build here,
#      deliver there" needed a copy in and a copy out. With 9p enabled by
#      the supervisor's QEMU shim, /workspace is the same tree on both
#      sides and a build inside the VM lands where the harness can read it.
#
# Environment:
#   GPU=0|1             the computer was created with `--gpu virgl`
#   SHARE_TAG=NAME      QEMU 9p mount tag to mount at /workspace ("" = off)
#   RESOLUTION=WxH      desktop geometry (default 1200x750, see below)
#   MARKER_VERSION=N    bump to force a re-provision on existing disks
# =====================================================================
set -u

VERSION="${MARKER_VERSION:-6}"
GPU="${GPU:-0}"
SHARE_TAG="${SHARE_TAG:-dshworkspace}"
# cua captures at most ~900k pixels: a 1280x800 display is delivered as a
# 1200x750 PNG (scale 0.9375), which is exactly the "screenshot is smaller
# than the screen" trap. 1200x750 is 900k pixels, so the capture is 1:1 and
# a pixel the model reads in the image is the pixel it clicks.
RESOLUTION="${RESOLUTION:-1200x750}"
MARKER=/var/lib/cua-provision
LOG=/var/log/cua-provision.log

exec > >(tee -a "$LOG") 2>&1
echo "=== $(date -Is) provision v$VERSION gpu=$GPU share='$SHARE_TAG' res=$RESOLUTION ==="

say() { echo "[provision] $*"; }
die() { echo "[provision] FAILED: $*"; exit 1; }

if [ -f "$MARKER" ] && grep -qx "version=$VERSION" "$MARKER" 2>/dev/null; then
  say "already provisioned (v$VERSION)"
  exit 0
fi

# ---------------------------------------------------------------------
# 1. apt — repair the placeholder suites, then make sure apt works at all
# ---------------------------------------------------------------------
APT_OK=0
apt_update() { apt-get update -qq >/dev/null 2>&1; }

if apt_update; then
  APT_OK=1
else
  say "apt update failed; repairing sources"
  SOURCES=/etc/apt/sources.list.d/ubuntu.sources
  if [ -f "$SOURCES" ] && grep -q UNAVAILABLE "$SOURCES"; then
    cp -n "$SOURCES" "$SOURCES.orig" 2>/dev/null || true
    cat >"$SOURCES" <<'EOF'
Types: deb
URIs: http://archive.ubuntu.com/ubuntu
Suites: noble noble-updates noble-backports
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu
Suites: noble-security
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
  fi
  if apt_update; then
    APT_OK=1
  fi
fi

if [ "$APT_OK" = "1" ]; then
  export DEBIAN_FRONTEND=noninteractive
  # A GUI workstation needs a terminal to fall back on, an X server that can
  # open the DRM node, mesa-utils to prove which renderer is live, growpart
  # for the disk tool and pciutils so the guest can show its own hardware.
  PKGS="xserver-xorg-core xserver-xorg-video-modesetting mesa-utils x11-xserver-utils xdotool xterm pciutils cloud-guest-utils unzip curl ca-certificates mesa-vulkan-drivers"
  # shellcheck disable=SC2086
  apt-get install -y -qq $PKGS >/dev/null 2>&1 || say "some packages failed to install (continuing)"
  say "packages installed"
else
  say "apt still broken; the GPU/desktop steps below will be skipped"
fi

# ---------------------------------------------------------------------
# 2. device permissions — the guest user must open the render node and KVM
# ---------------------------------------------------------------------
mkdir -p /etc/udev/rules.d
cat >/etc/udev/rules.d/99-cua-devices.rules <<'EOF'
# CUA guest: the desktop user is not in `render`/`kvm` on a fresh disk and
# the udev tag can be re-applied after a checkpoint restore.
SUBSYSTEM=="drm", KERNEL=="renderD*", MODE="0666"
SUBSYSTEM=="misc", KERNEL=="kvm", MODE="0666"
EOF
chmod 0666 /dev/dri/renderD* 2>/dev/null || true
chmod 0666 /dev/kvm 2>/dev/null || true
usermod -aG render,video,kvm cua 2>/dev/null || true
getent group render >/dev/null && chgrp render /dev/dri/renderD* 2>/dev/null || true
say "permissions: render=$(ls -l /dev/dri/renderD* 2>/dev/null | awk '{print $1}' | head -1) kvm=$(ls -l /dev/kvm 2>/dev/null | awk '{print $1}')"

# ---------------------------------------------------------------------
# 3. the workspace share (9p), so both sides see the same files
# ---------------------------------------------------------------------
if [ -n "$SHARE_TAG" ]; then
  modprobe 9pnet_virtio 2>/dev/null || true
  modprobe 9p 2>/dev/null || true
  mkdir -p /workspace
  if mountpoint -q /workspace; then
    say "workspace already mounted"
  else
    grep -q "mount_tag=$SHARE_TAG" /etc/fstab 2>/dev/null || cat >>/etc/fstab <<EOF
$SHARE_TAG /workspace 9p trans=virtio,version=9p2000.L,msize=262144,rw,nofail,x-systemd.automount 0 0
EOF
    if mount -t 9p -o trans=virtio,version=9p2000.L,msize=262144 "$SHARE_TAG" /workspace 2>/dev/null; then
      say "workspace share mounted at /workspace"
    else
      say "9p share '$SHARE_TAG' not available (older QEMU wrapper?)"
    fi
  fi
fi

# ---------------------------------------------------------------------
# 4. a desktop resolution whose capture is 1:1
#
# cua caps a capture at ~900k pixels: a 1280x800 desktop comes back as a
# 1200x750 PNG, so a pixel the model reads in the image is 0.9375 of the one
# it must click. 1200x750 is exactly 900k pixels, so the capture is 1:1 and
# the ambiguity disappears even for tool paths that bypass cua's mapping.
# Xvfb honours CUA_RESOLUTION directly; Xorg takes its mode list from the
# virtio EDID, which has no 1200x750, so add the mode at session start.
# ---------------------------------------------------------------------
install -d /etc/systemd/system/cua-desktop.service.d
cat >/etc/systemd/system/cua-desktop.service.d/10-resolution.conf <<EOF
[Service]
Environment=CUA_RESOLUTION=$RESOLUTION
EOF

cat >/usr/local/bin/cua-resolution <<'EOS'
#!/bin/bash
# Select the capture-sized mode. Idempotent; silent when it does not exist.
export DISPLAY="${DISPLAY:-:1}"
for _ in $(seq 1 40); do xrandr >/dev/null 2>&1 && break; sleep 0.5; done
OUT=$(xrandr 2>/dev/null | awk '/ connected/{print $1; exit}')
[ -n "$OUT" ] || exit 0
W=${CUA_RESOLUTION%x*}
H=${CUA_RESOLUTION#*x}
xrandr --newmode "${W}x${H}" 74.25 ${W} 1264 1376 1560 ${H} 753 763 793 2>/dev/null
xrandr --addmode "$OUT" "${W}x${H}" 2>/dev/null
xrandr --output "$OUT" --mode "${W}x${H}" 2>/dev/null
exit 0
EOS
chmod 0755 /usr/local/bin/cua-resolution

mkdir -p /etc/xdg/autostart
cat >/etc/xdg/autostart/cua-resolution.desktop <<EOF
[Desktop Entry]
Type=Application
Name=CUA desktop resolution
Comment=Make the desktop the size cua captures, so screenshot pixels are display pixels
Exec=/usr/local/bin/cua-resolution
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
X-XFCE-Autostart-Override=true
EOF

# ---------------------------------------------------------------------
# 5. GPU: Xorg on the virtio DRM node, not Xvfb
# ---------------------------------------------------------------------
RENDERER="none"
if [ "$GPU" = "1" ] && [ "$APT_OK" = "1" ] && command -v Xorg >/dev/null 2>&1; then
  cat >/etc/X11/xorg-virtio.conf <<'EOF'
Section "Device"
    Identifier "virtio"
    Driver "modesetting"
    Option "kmsdev" "/dev/dri/card0"
EndSection
Section "Screen"
    Identifier "screen"
    Device "virtio"
    DefaultDepth 24
    SubSection "Display"
        Depth 24
        Modes "1200x750"
    EndSubSection
EndSection
Section "ServerLayout"
    Identifier "layout"
    Screen "screen"
EndSection
EOF
  printf 'allowed_users=anybody\nneeds_root_rights=yes\n' >/etc/X11/Xwrapper.config

  # The image already ships an `xorg)` branch in start-desktop.sh. Only add
  # one when it is missing, otherwise a second `case` arm is a syntax error.
  SCRIPT=/opt/cua/desktop/start-desktop.sh
  if [ -f "$SCRIPT" ] && ! grep -q '^xorg)' "$SCRIPT"; then
    cp -n "$SCRIPT" "$SCRIPT.orig" 2>/dev/null || true
    python3 - "$SCRIPT" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
branch = """xorg)
    log "Xorg ${DISPLAY_NUM} ${GEOMETRY}"
    sudo -n /usr/bin/Xorg "${DISPLAY_NUM}" -config /etc/X11/xorg-virtio.conf -noreset +extension GLX -dpi 96 &
    ;;
"""
needle = "\nxvnc)\n"
if needle not in s:
    sys.exit("cannot find the xvnc branch")
open(p, "w").write(s.replace(needle, "\n" + branch + "xvnc)\n", 1))
PYEOF
  fi
  printf '[Service]\nEnvironment=CUA_X_SERVER=xorg\n' >/etc/systemd/system/cua-desktop.service.d/x-server.conf

  # virgl caps the *reported* version at 4.2 while the 4.3 extension set is
  # present (compute shaders, SSBOs, program interface query, multi-bind).
  # Blender 4.x refuses to start below 4.3, so the whole session reports the
  # version the driver actually implements instead of giving up the GPU.
  printf '[Service]\nEnvironment=MESA_GL_VERSION_OVERRIDE=4.3FC\n' >/etc/systemd/system/cua-desktop.service.d/20-gl-version.conf
  # Apps started through `cua sb exec` (blender -b, glxinfo, tests) do not
  # inherit the session environment; /etc/environment covers login shells.
  grep -q MESA_GL_VERSION_OVERRIDE /etc/environment 2>/dev/null || echo 'MESA_GL_VERSION_OVERRIDE=4.3FC' >>/etc/environment
  # `cua sb exec` runs commands as children of cua-spacesd, which has a fixed
  # environment: the session drop-in above does not reach `blender -b` or
  # `glxinfo` typed into the shell. Give spacesd the variable too.
  install -d /etc/systemd/system/cua-spacesd.service.d
  printf '[Service]\nEnvironment=MESA_GL_VERSION_OVERRIDE=4.3FC\n' >/etc/systemd/system/cua-spacesd.service.d/10-gl-version.conf
fi

systemctl daemon-reload
systemctl restart cua-desktop || true

# ---------------------------------------------------------------------
# 6. verify what the desktop actually got
# ---------------------------------------------------------------------
for _ in $(seq 1 40); do [ -S /tmp/.X11-unix/X1 ] && break; sleep 0.5; done
# Xorg ignores the Modes line when the EDID does not advertise the mode.
CUA_RESOLUTION="$RESOLUTION" /usr/local/bin/cua-resolution >/dev/null 2>&1 || true
GEOM=$(DISPLAY=:1 xdotool getdisplaygeometry 2>/dev/null | tr ' ' 'x')
say "desktop: ${GEOM:-unknown} (target $RESOLUTION)"

if [ "$GPU" = "1" ] && [ "$APT_OK" = "1" ]; then
  R=$(DISPLAY=:1 glxinfo -B 2>/dev/null | grep -m1 "OpenGL renderer" | sed 's/.*: //')
  V=$(DISPLAY=:1 glxinfo -B 2>/dev/null | grep -m1 "Max core profile version" | sed 's/.*: //')
  VS=$(DISPLAY=:1 MESA_GL_VERSION_OVERRIDE=4.3FC glxinfo -B 2>/dev/null | grep -m1 "Max core profile version" | sed 's/.*: //')
  RENDERER="${R:-none} GL ${V:-?}"
  say "session GL: ${VS:-?} (virgl reports ${V:-?} without the override)"
  say "renderer: $RENDERER"
  case "$R" in
    *virgl*)
      ;;
    *)
      say "no virgl renderer; reverting the desktop to Xvfb so it is not black"
      printf '[Service]\nEnvironment=CUA_X_SERVER=xvfb\n' >/etc/systemd/system/cua-desktop.service.d/x-server.conf
      rm -f /etc/systemd/system/cua-desktop.service.d/20-gl-version.conf
      systemctl daemon-reload
      systemctl restart cua-desktop || true
      GPU=0
      RENDERER="${R:-none} (reverted)"
      ;;
  esac
fi

# KVM is what makes the official Android emulator usable; report it so a
# failure shows up before the model spends an hour downloading an AVD.
KVM=no
if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  if python3 -c 'import os,fcntl; fd=os.open("/dev/kvm",os.O_RDWR); assert fcntl.ioctl(fd,0xAE00,0)==12' 2>/dev/null; then KVM=yes; fi
fi
say "nested kvm: $KVM"

cat >"$MARKER" <<EOF
version=$VERSION
gpu=$GPU
renderer=$RENDERER
kvm=$KVM
share=$SHARE_TAG
resolution=$RESOLUTION
provisioned=$(date -Is)
EOF
say "OK v$VERSION renderer=$RENDERER kvm=$KVM"

# Restart spacesd detached: it is the channel this script is running on, so a
# restart in the foreground would kill the answer. Without it the new
# environment only applies at the next boot.
if [ "$GPU" = "1" ]; then
  setsid sh -c 'sleep 5; systemctl daemon-reload; systemctl restart cua-spacesd' </dev/null >/dev/null 2>&1 &
fi
