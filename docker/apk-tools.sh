#!/bin/sh
# =====================================================================
# apk-tools — what this image can do with an .apk, and what answers.
#
# Installed by the image build (see docker/apk-toolchain.sh). Safe to run
# any time; it only reads. `apk-tools --check` re-runs the same probe the
# build ran (tools/check-apk-toolchain.mjs), so a deployed container can
# prove its own toolchain instead of assuming the image was built right.
#
# Everything here is OFFLINE on purpose: several of these tools do a
# "checking for a newer version" call on startup, which would make an
# inventory hang in a container without egress. Python versions therefore
# come from the installed package metadata, not from the CLI.
# =====================================================================
set -u

VENV=/opt/apk-tools/venv

cmdver() { # cmdver <label> <cmd> [args…] — first output line with a digit, else "installed"
  label="$1"
  shift
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '  %-13s MISSING — this image is not what it claims (node /opt/apk-tools/check.mjs says why)\n' "$label"
    return 0
  fi
  out="$("$@" 2>&1 | grep -m1 '[0-9]' | cut -c1-64 || true)"
  printf '  %-13s %s\n' "$label" "${out:-installed}"
}

pyver() { # pyver <label> <distribution> — from package metadata; no CLI, no network
  v="$("$VENV/bin/python" -c "import importlib.metadata as m; print(m.version('$2'))" 2>/dev/null || true)"
  printf '  %-13s %s\n' "$1" "${v:-MISSING}"
}

have() { # have <label> <cmd> — presence only, for tools whose "version" flag dumps usage
  if command -v "$2" >/dev/null 2>&1; then
    printf '  %-13s installed\n' "$1"
  else
    printf '  %-13s MISSING — this image is not what it claims (node /opt/apk-tools/check.mjs says why)\n' "$1"
  fi
}

case "${1:-}" in
  --check) exec node /opt/apk-tools/check.mjs ;;
  --versions | --pin)
    exec cat /opt/apk-tools/VERSIONS.txt
    ;;
  -h | --help)
    cat <<'EOF'
apk-tools — inventory of the APK / Android reverse-engineering toolchain in this image.

  apk-tools              what is installed, with versions
  apk-tools --check      re-run the build-time probe of every tool (exit 1 on any failure)
  apk-tools --versions   the pinned versions this image was built from

  apk-unpack <file>      raw zip + apktool XML/smali + jadx sources + manifest, in one go
  (cat /opt/apk-tools/README.md for the workflow, incl. Hermes bytecode and repacking)
EOF
    exit 0
    ;;
  '') ;;
  *)
    echo "apk-tools: unknown option: $1 (try --help)" >&2
    exit 1
    ;;
esac

printf 'APK / Android reverse-engineering toolchain\n'
printf '  java home    %s\n' "${JAVA_HOME:-unset}"
printf '  android sdk  %s\n' "${ANDROID_HOME:-unset}"

printf '\nstatic analysis\n'
cmdver jadx jadx --version
cmdver apktool apktool --version
have apkanalyzer apkanalyzer
pyver apkid apkid
pyver androguard androguard

printf '\nHermes bytecode (React Native bundle)\n'
pyver hbctool hbctool
pyver hermes-dec hermes-dec
cmdver hbc-disasm "$VENV/bin/hbc-disassembler" --help
cmdver hbc-decomp "$VENV/bin/hbc-decompiler" --help

printf '\ndynamic instrumentation (needs a target device)\n'
pyver frida frida
pyver frida-tools frida-tools
pyver frida-dexdump frida-dexdump
pyver objection objection
cmdver adb adb version

printf '\nrebuild, sign, inspect\n'
cmdver apksigner apksigner --version
have zipalign zipalign
cmdver aapt2 aapt2 version
cmdver java java -version
CT_REV="$(sed -n 's/^Pkg.Revision *= *//p' /opt/android-sdk/cmdline-tools/latest/source.properties 2>/dev/null | head -n 1)"
BT_REV="$(ls -1 /opt/android-sdk/build-tools 2>/dev/null | sort -V | tail -n 1)"
PLATFORM="$(ls -1 /opt/android-sdk/platforms 2>/dev/null | sort -V | tail -n 1)"
printf '  %-13s %s\n' "android sdk" \
  "cmdline-tools ${CT_REV:-?} (apkanalyzer, sdkmanager) · build-tools ${BT_REV:-?} · ${PLATFORM:-?}"

printf '\nfirst moves\n'
printf '  apk-unpack <file.apk>          one-shot unpack (raw + apktool + jadx + manifest)\n'
printf '  cat /opt/apk-tools/README.md   the workflow, incl. Hermes and repacking\n'
printf '  cat /opt/apk-tools/VERSIONS.txt pinned versions this image was built from\n'
