#!/bin/bash
# =====================================================================
# emulator-tools — inventory and control for the on-device Android emulator.
#
#   emulator-tools                 what is installed, what is missing, what to run
#   emulator-tools --check         re-run the build-time proof
#   emulator-tools --avd           (re)write the default AVD, no emulator started
#   emulator-tools --up            write the AVD, boot the emulator, wait for boot
#   emulator-tools --down          stop it
#   emulator-tools --apk FILE      install an APK, launch it, screenshot the result
#
#   flags: --headless (default) | --windowed   (a window on $DISPLAY)
#          --no-accel                       try software emulation (slow, unstable)
#          --name AVD                       use/create a differently named AVD
#
# WHY A SCRIPT AND NOT A DOC
# Two things that look like configuration are actually traps, and both were
# measured the hard way:
#   * `avdmanager create avd` is BROKEN in the current cmdline-tools ("Package
#     path is not valid. Valid system image paths are: null"), and the
#     replacement (`android emulator create <profile>`) DOWNLOADS the image it
#     prefers — which cannot work at runtime here, because the rootfs (and so
#     the SDK) is read-only by design.
#     The AVD is therefore WRITTEN DIRECTLY (config.ini), pointing at the image
#     the image already ships. No registry, no network, no download.
#   * The rootfs is read-only, so nothing may be created under /opt or /home:
#     the AVD lives in $ANDROID_AVD_HOME, which defaults to the workspace.
# =====================================================================
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
EMU="$SDK/emulator/emulator"
AVD_HOME="${ANDROID_AVD_HOME:-/workspace/.android/avd}"

EMU_API="${EMU_API:-android-36}"
EMU_TAG="${EMU_TAG:-google_apis}"
EMU_ABI="${EMU_ABI:-x86_64}"
AVD_NAME="${AVD_NAME:-medium_phone}"
PROFILE="${PROFILE:-medium_phone}"

MODE="headless"
ACCEL="-accel on"
ACTION="status"
APK=""
PKG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --status) ACTION="status" ;;
    --check) ACTION="check" ;;
    --avd) ACTION="avd" ;;
    --up) ACTION="up" ;;
    --down) ACTION="down" ;;
    --apk) ACTION="apk"; APK="${2:-}"; shift ;;
    --pkg) PKG="${2:-}"; shift ;;
    --name) AVD_NAME="${2:-}"; shift ;;
    --windowed) MODE="windowed" ;;
    --headless) MODE="headless" ;;
    --no-accel) ACCEL="-accel off" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "emulator-tools: unknown argument '$1' (try --help)" >&2; exit 2 ;;
  esac
  shift
done

adb_bin() {
  if [ -x "$SDK/platform-tools/adb" ]; then printf '%s' "$SDK/platform-tools/adb"; return; fi
  command -v adb || true
}

have_emulator() { [ -x "$EMU" ]; }

kv_ok() { [ -r /dev/kvm ] && [ -w /dev/kvm ]; }

image_dir() { printf '%s/system-images/%s/%s/%s' "$SDK" "$EMU_API" "$EMU_TAG" "$EMU_ABI"; }

# ---------------------------------------------------------------------------
# The AVD, written by hand: deterministic, offline, and pointing at the image
# that is actually installed.
# ---------------------------------------------------------------------------
write_avd() {
  local dir="$AVD_HOME/$AVD_NAME.avd" ini="$AVD_HOME/$AVD_NAME.ini"
  mkdir -p "$dir" "$AVD_HOME"

  printf '%s\n' \
    'avd.ini.encoding=UTF-8' \
    "path=$dir" \
    "path.rel=avd/$AVD_NAME.avd" \
    "target=$EMU_API" > "$ini"

  printf '%s\n' \
    "AvdId=$AVD_NAME" \
    'PlayStore.enabled=false' \
    "abi.type=$EMU_ABI" \
    "avd.ini.displayname=$AVD_NAME" \
    'avd.ini.encoding=UTF-8' \
    'disk.dataPartition.size=6G' \
    'fastboot.forceChosenSnapshotBoot=no' \
    'fastboot.forceColdBoot=yes' \
    'fastboot.forceFastBoot=no' \
    'hw.accelerometer=yes' \
    'hw.audioInput=no' \
    'hw.audioOutput=no' \
    'hw.battery=yes' \
    'hw.camera.back=virtualscene' \
    'hw.camera.front=emulated' \
    "hw.cpu.arch=$EMU_ABI" \
    'hw.cpu.ncore=4' \
    'hw.dPad=no' \
    'hw.device.manufacturer=Generic' \
    "hw.device.name=$PROFILE" \
    'hw.gps=yes' \
    'hw.gpu.enabled=yes' \
    'hw.gpu.mode=swiftshader_indirect' \
    'hw.gyroscope=yes' \
    'hw.initialOrientation=portrait' \
    'hw.keyboard=yes' \
    'hw.lcd.density=420' \
    'hw.lcd.height=2400' \
    'hw.lcd.width=1080' \
    'hw.mainKeys=no' \
    'hw.ramSize=4096' \
    'hw.sdCard=yes' \
    'hw.sensors.light=yes' \
    'hw.sensors.magnetic_field=yes' \
    'hw.sensors.orientation=yes' \
    'hw.sensors.proximity=yes' \
    'hw.trackBall=no' \
    "image.sysdir.1=system-images/$EMU_API/$EMU_TAG/$EMU_ABI/" \
    'runtime.network.latency=none' \
    'runtime.network.speed=full' \
    'sdcard.size=512M' \
    'showDeviceFrame=no' \
    'skin.dynamic=yes' \
    "tag.display=$([ "$EMU_TAG" = "google_apis" ] && echo 'Google APIs' || echo 'Google Play')" \
    "tag.id=$EMU_TAG" \
    "tag.ids=$EMU_TAG" > "$dir/config.ini"

  echo "avd: $AVD_NAME -> $dir"
  echo "     image: $(image_dir)/"
}

start_emulator() {
  local extra=()
  [ "$MODE" = "headless" ] && extra+=("-no-window")
  [ "$MODE" = "windowed" ] && [ -n "${DISPLAY:-}" ] && echo "windowed on DISPLAY=$DISPLAY"

  echo "starting $AVD_NAME ($MODE, $ACCEL)"
  nohup "$EMU" -avd "$AVD_NAME" \
    -no-audio -no-boot-anim -no-snapshot -no-metrics \
    -gpu swiftshader_indirect $ACCEL \
    -memory 4096 -cores 4 \
    "${extra[@]}" > /tmp/emulator.log 2>&1 &
  echo "pid $! (log: /tmp/emulator.log)"
}

wait_for_boot() {
  local adb; adb="$(adb_bin)"
  [ -n "$adb" ] || { echo "no adb on PATH" >&2; return 1; }
  "$adb" wait-for-device
  printf 'waiting for sys.boot_completed'
  for _ in $(seq 1 120); do
    if [ "$("$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
      echo " — booted"
      # On a slow guest the launcher is still coming up when the prop flips.
      sleep 20
      return 0
    fi
    printf '.'
    sleep 5
  done
  echo " — TIMEOUT (see /tmp/emulator.log)" >&2
  return 1
}

# ---------------------------------------------------------------------------
status() {
  echo "emulator-tools — on-device Android testing"
  echo
  if ! have_emulator; then
    echo "emulator:            NOT INSTALLED for this architecture"
    echo "                     Google publishes the Linux emulator for x86_64 only."
    echo "                     Static APK analysis still works (see: apk-tools)."
    return 0
  fi
  echo "emulator:            $("$EMU" -version 2>/dev/null | head -1)"
  echo "sdk:                 $SDK"
  echo "system image:        $(image_dir)"
  if [ -f "$(image_dir)/source.properties" ]; then
    echo "                     $(grep -h 'AndroidVersion.ApiLevel\|SystemImage.Abi' "$(image_dir)/source.properties" 2>/dev/null | tr '\n' ' ')"
  else
    echo "                     MISSING — rebuild the image with docker/emulator-toolchain.sh"
  fi
  echo "avd home:            $AVD_HOME"
  if [ -f "$AVD_HOME/$AVD_NAME.avd/config.ini" ]; then
    echo "avd:                 $AVD_NAME (exists)"
  else
    echo "avd:                 $AVD_NAME (not created yet — run: emulator-tools --avd)"
  fi
  echo "adb:                 $(adb_bin || echo 'MISSING')"
  echo
  if kv_ok; then
    echo "hardware accel:      /dev/kvm present and accessible — good"
  else
    echo "hardware accel:      /dev/kvm MISSING or not accessible"
    echo "                     Add it to the run (see compose.emulator.yaml):"
    echo "                       devices: [/dev/kvm]"
    echo "                       group_add: [kvm]"
    echo "                     Without it the emulator refuses to start; with"
    echo "                     --no-accel it boots but Android's watchdog kills"
    echo "                     system_server within minutes (API 34+)."
  fi
  echo
  echo "next:"
  echo "  emulator-tools --up                     boot it, wait for Android"
  echo "  emulator-tools --apk app-debug.apk      install + launch + screenshot"
  echo "  emulator-tools --down                   stop it"
  echo "  docs: /opt/emulator-tools/README.md"
}

case "$ACTION" in
  status) status ;;
  check)  exec node /opt/emulator-tools/check.mjs ;;
  avd)    write_avd ;;
  up)
    have_emulator || { echo "emulator not installed for this architecture" >&2; exit 1; }
    [ -f "$(image_dir)/source.properties" ] || { echo "system image missing: $(image_dir)" >&2; exit 1; }
    if ! kv_ok && [ "$ACCEL" = "-accel on" ]; then
      echo "refusing to start: /dev/kvm is not accessible." >&2
      echo "Add the device to the container (compose.emulator.yaml), or pass --no-accel" >&2
      echo "to try software emulation (slow, and Android's watchdog usually kills it)." >&2
      exit 1
    fi
    write_avd
    start_emulator
    wait_for_boot
    ;;
  down)
    adb="$(adb_bin)"; [ -n "$adb" ] && "$adb" emu kill 2>/dev/null || pkill -f "qemu-system-x86_64" || true
    echo "stopped"
    ;;
  apk)
    [ -n "$APK" ] || { echo "usage: emulator-tools --apk <file.apk> [--pkg name]" >&2; exit 2; }
    [ -f "$APK" ] || { echo "no such file: $APK" >&2; exit 2; }
    adb="$(adb_bin)"
    shots="${EMULATOR_SHOTS:-/workspace/emulator-shots}"
    mkdir -p "$shots"
    # push + pm install: a streamed install of a large APK fails silently on a
    # slow guest ("Broken pipe"), and `pm list packages` is the only honest check.
    "$adb" push "$APK" /data/local/tmp/app.apk
    "$adb" shell pm install -r -t /data/local/tmp/app.apk || true
    if [ -n "$PKG" ]; then
      if ! "$adb" shell pm path "$PKG" 2>/dev/null | grep -q package; then
        echo "install did not land for $PKG" >&2; exit 1
      fi
      "$adb" shell pm grant "$PKG" android.permission.CAMERA 2>/dev/null || true
      "$adb" logcat -c 2>/dev/null || true
      "$adb" shell am start -n "$PKG/.MainActivity" || true
      sleep 25
      "$adb" exec-out screencap -p > "$shots/launch.png"
      echo "screenshot: $shots/launch.png"
      echo "logs:"
      "$adb" logcat -d 2>/dev/null | grep -iE "AndroidRuntime|FATAL|chromium" | tail -10 || true
    else
      echo "installed. Pass --pkg <package.name> to launch and screenshot."
    fi
    ;;
esac
