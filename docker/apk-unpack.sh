#!/bin/sh
# =====================================================================
# apk-unpack — turn an .apk (or a split bundle: .apks / .xapk / .apkm)
# into a directory an agent (or a human) can read directly.
#
# One command instead of five, with every step's failure kept in a log
# rather than thrown away: `apktool` fails on some obfuscated APKs, `jadx`
# reports errors on almost all of them, and neither should stop you from
# reading the manifest or the Hermes bundle that was extracted anyway.
#
# Layout produced (nothing is deleted, everything is greppable):
#   raw/              the zip as-is: dex, assets, lib/, res/, META-INF
#   apktool/          decoded AndroidManifest.xml, resources, smali/
#   jadx/             Java sources
#   AndroidManifest.xml + apk-summary.txt   (apkanalyzer, no unpack needed)
#   SUMMARY.txt       what this app looks like, from the outside
#   logs/             apktool.log, jadx.log, warnings.txt
# =====================================================================
set -eu

usage() {
  cat <<'EOF'
usage: apk-unpack <file.apk|file.apks|xapk|apkm> [outdir] [--no-jadx] [--no-apktool]

  outdir defaults to ./<name>-unpacked

  --no-apktool   skip the resource/smali decode   (fast; skips the repack path)
  --no-jadx      skip the Java decompile          (fast; big APKs take minutes)
EOF
}

SRC=""
OUT=""
DO_JADX=1
DO_APKTOOL=1
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --no-jadx) DO_JADX=0 ;;
    --no-apktool) DO_APKTOOL=0 ;;
    -*)
      echo "apk-unpack: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ -z "$SRC" ]; then
        SRC="$1"
      elif [ -z "$OUT" ]; then
        OUT="$1"
      else
        echo "apk-unpack: unexpected argument: $1" >&2
        exit 1
      fi
      ;;
  esac
  shift
done

[ -n "$SRC" ] || { usage >&2; exit 1; }
[ -f "$SRC" ] || { echo "apk-unpack: no such file: $SRC" >&2; exit 1; }
BASE="$(basename "$SRC")"
[ -n "$OUT" ] || OUT="./${BASE%.*}-unpacked"

LOG="$OUT/logs"
mkdir -p "$OUT/raw" "$LOG"
: >"$LOG/warnings.txt"

warn() {
  printf '%s\n' "$*" | tee -a "$LOG/warnings.txt" >&2
}

# ---------------------------------------------------------------------
# 1. The zip itself. Works for a plain APK and for a split bundle — an
#    .apks/.xapk is just a zip whose entries are the split APKs.
# ---------------------------------------------------------------------
unzip -q -o "$SRC" -d "$OUT/raw"
TARGET="$SRC"
CODE="$OUT/raw" # the directory that holds the app's own files (dex/assets/lib)
SPLITS=""
if [ -f "$OUT/raw/base.apk" ]; then
  # A split bundle: base.apk carries the code, the rest are config splits
  # (dpi/locale/abi). Analysing the bundle file itself would only show
  # nested zips, so everything below runs against base.apk — and it is
  # unpacked too, so the classic paths (base/assets/index.android.bundle,
  # base/lib/<abi>/*.so, base/classes*.dex) can be grepped directly.
  TARGET="$OUT/raw/base.apk"
  CODE="$OUT/base"
  mkdir -p "$CODE"
  unzip -q -o "$TARGET" -d "$CODE"
  SPLITS="$(cd "$OUT/raw" && ls -1 ./*.apk 2>/dev/null | sed 's|^\./||' || true)"
fi

# ---------------------------------------------------------------------
# 2. Manifest + identity, before any heavy lifting.
# ---------------------------------------------------------------------
if command -v apkanalyzer >/dev/null 2>&1; then
  apkanalyzer manifest print "$TARGET" >"$OUT/AndroidManifest.xml" 2>"$LOG/apkanalyzer.log" ||
    warn "warn: apkanalyzer could not print the manifest — see logs/apkanalyzer.log"
  apkanalyzer apk summary "$TARGET" >"$OUT/apk-summary.txt" 2>>"$LOG/apkanalyzer.log" ||
    warn "warn: apkanalyzer could not summarise the APK"
else
  warn "warn: apkanalyzer is missing from this image; manifest is still in apktool/"
fi

# ---------------------------------------------------------------------
# 3. apktool — real XML + smali, i.e. the rebuild path.
# ---------------------------------------------------------------------
if [ "$DO_APKTOOL" = "1" ] && command -v apktool >/dev/null 2>&1; then
  if apktool d -f -o "$OUT/apktool" "$TARGET" >"$LOG/apktool.log" 2>&1; then
    :
  else
    warn "warn: apktool failed on this APK — resources/smali may be partial (logs/apktool.log)"
  fi
fi

# ---------------------------------------------------------------------
# 4. jadx — the readable half. -j 0 would use every core; the default is
#    deliberately kept so a shared container does not get starved.
# ---------------------------------------------------------------------
if [ "$DO_JADX" = "1" ] && command -v jadx >/dev/null 2>&1; then
  if jadx -d "$OUT/jadx" --no-res "$TARGET" >"$LOG/jadx.log" 2>&1; then
    :
  else
    warn "warn: jadx reported errors (normal on obfuscated code) — logs/jadx.log"
  fi
fi

# ---------------------------------------------------------------------
# 5. What does this thing actually look like? Cheap heuristics that decide
#    where an agent should look next: Hermes bundle, Flutter, Unity, native
#    code, packers.
# ---------------------------------------------------------------------
BUNDLE=""
for cand in "$CODE/assets/index.android.bundle" "$CODE/assets/index.android.bundle.js" "$CODE/index.android.bundle"; do
  [ -f "$cand" ] && BUNDLE="$cand" && break
done

DEX_COUNT="$(ls -1 "$CODE"/*.dex 2>/dev/null | wc -l | tr -d ' ')"
SO_COUNT="$(find "$CODE/lib" -name '*.so' 2>/dev/null | wc -l | tr -d ' ')"
SO_LIST="$(find "$CODE/lib" -name '*.so' 2>/dev/null | sed "s|^$CODE/||" | sort | head -n 20)"

{
  echo "# apk-unpack summary"
  echo
  echo "source        : $SRC"
  echo "sha256        : $(sha256sum "$SRC" | cut -d' ' -f1)"
  echo "size          : $(wc -c <"$SRC" | tr -d ' ') bytes"
  echo "analysed      : $TARGET"
  echo "code dir      : $CODE"
  if [ -n "$SPLITS" ]; then
    echo "split bundle  : yes"
    printf '%s\n' "$SPLITS" | sed 's/^/  split       : /'
  fi
  echo "dex files     : $DEX_COUNT"
  echo "native libs   : $SO_COUNT"
  [ -n "$SO_LIST" ] && printf '%s\n' "$SO_LIST" | sed 's/^/  lib         : /'
  if [ -n "$BUNDLE" ]; then
    echo "react native  : $BUNDLE ($(wc -c <"$BUNDLE" | tr -d ' ') bytes)"
    echo "                Hermes bytecode — jadx/strings cannot read it. Disassemble with"
    echo "                  hbc-disassembler \"$BUNDLE\" <out.hasm>   # newest HBC revisions"
    echo "                  hbctool disasm \"$BUNDLE\" <outdir>        # older revisions only;"
    echo "                                                          # it REFUSES unknown versions"
  fi
  [ -f "$CODE/lib/arm64-v8a/libflutter.so" ] && echo "flutter       : yes (libflutter.so)"
  [ -f "$CODE/assets/bin/Data/Managed/Metadata/global-metadata.dat" ] && echo "unity/il2cpp  : yes (global-metadata.dat)"
  echo
  echo "logs          : $(ls -1 "$LOG" | tr '\n' ' ')"
} >"$OUT/SUMMARY.txt"

cat "$OUT/SUMMARY.txt"
echo
echo "apk-unpack: wrote $OUT  (manifest: $OUT/AndroidManifest.xml)"
if [ -s "$LOG/warnings.txt" ]; then
  echo "apk-unpack: warnings:" >&2
  sed 's/^/  /' "$LOG/warnings.txt" >&2
fi
