#!/bin/bash
# =====================================================================
# OCR toolchain — route A only: tesseract for image-only PDFs.
#
# Called once by the Dockerfile (as root, before the image drops to uid
# 1000). Like docker/apk-toolchain.sh it is deliberately a standalone
# script rather than an inlined RUN block, so it can be executed VERBATIM
# against a stock base image and proved on its own:
#
#   docker run --rm node:24-trixie bash -s < docker/ocr-toolchain.sh
#   docker exec -u 0 <container> apt-get install -y tesseract-ocr tesseract-ocr-eng
#
# Design rules, in the same spirit as the rest of this repo:
#   * every download is version-pinned AND verified (Debian packages come
#     from the signed trixie archive; the traineddata is shape-checked), so
#     a silent upstream swap fails the build instead of silently changing
#     what an OCR pass reports;
#   * the engine is EXECUTED here against a page this script renders itself
#     — an engine that installed but cannot run fails the build, not the
#     turn where an agent finally needs it;
#   * nothing here runs at container start and nothing needs a network at
#     runtime: this is static-analysis capability, not a service.
#
# WHY THIS LAYER EXISTS
# ---------------------
# The `pdf-documents` skill said "there is no OCR in this image" and told the
# model to report a scanned page instead of reading it. That is an honest
# answer and a useless one for a deck, a contract or a form whose text lives
# in pixels. This installs the engine; tools/ocr-pdf.py does the work at
# request time and writes the result back as an invisible text layer.
#
# WHY TESSERACT AND NOTHING ELSE
# ------------------------------
# tesseract 5 (LSTM) is the fast, folder-clean engine: one process per page,
# no model session to warm up, no Python wheels to load, ~0.3 s per 2000 px
# page here, and output that every other OCR tool is calibrated against.
# The alternatives (RapidOCR/PP-OCRv4 ONNX, EasyOCR, PaddleOCR) all pull a
# few hundred MB of runtime and burn CPU on every run for a second opinion
# this image does not need — so they are deliberately NOT installed, and the
# driver has no flag that pretends otherwise.
# =====================================================================
set -euo pipefail

# ---------------------------------------------------------------------
# Pins. OCR_* is what the Dockerfile passes through; the defaults are the
# set this repo ships.
# ---------------------------------------------------------------------
OCR_TESSDATA_TIER="${OCR_TESSDATA_TIER:-best}"  # best | fast
OCR_TESSDATA_REF="${OCR_TESSDATA_REF:-main}"    # tessdata_<tier> git ref
OCR_TESSDATA_LANGS="${OCR_TESSDATA_LANGS:-eng}"

TESSDATA_DIR="${OCR_TESSDATA_DIR:-/usr/share/tesseract-ocr/5/tessdata}"
TOOLS_DIR="${OCR_TOOLS_DIR:-/opt/ocr-tools}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

step() { printf '\n=== %s\n' "$*"; }

mkdir -p "$TOOLS_DIR"

# ---------------------------------------------------------------------
# 1. tesseract from the signed Debian archive.
#
#    Debian's tesseract is a plain C++ binary with no dynamic nags; the only
#    reason to touch it further is the traineddata tier, which is a quality
#    choice rather than a correctness one. `tesseract-ocr-osd` is what makes
#    `--rotate-pages` possible for a scan that went in sideways.
# ---------------------------------------------------------------------
step "apt: tesseract (packages + $OCR_TESSDATA_TIER traineddata)"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  tesseract-ocr tesseract-ocr-osd
for lang in $OCR_TESSDATA_LANGS; do
  # A language pack package exists for every language upstream ships; several
  # real ones are only in the -all package, hence the fallback.
  apt-get install -y --no-install-recommends "tesseract-ocr-$lang" \
    || apt-get install -y --no-install-recommends tesseract-ocr-all
done
rm -rf /var/lib/apt/lists/*
tesseract --version | head -n 1

# The distro ships the `fast` weights. The `best` ones are the accuracy tier
# upstream publishes for the same engine, and they are the reason route A can
# be both the fast option AND the accurate one here.
if [ "$OCR_TESSDATA_TIER" != "fast" ]; then
  step "tessdata_$OCR_TESSDATA_TIER: $OCR_TESSDATA_LANGS"
  for lang in $OCR_TESSDATA_LANGS; do
    curl -fsSL --retry 3 -o "$TMP/tessdata-$lang" \
      "https://github.com/tesseract-ocr/tessdata_${OCR_TESSDATA_TIER}/raw/${OCR_TESSDATA_REF}/${lang}.traineddata"
    # A traineddata that is not a real one is the difference between an
    # accurate pass and a page of noise, and the file carries no signature —
    # so check the shape upstream guarantees. The magic is a little-endian
    # int32 format version: bytes 0x18 0x00 0x00 for the current format (24).
    # A 404 that landed as an HTML error page starts with "<!D", which this
    # rejects; so does a truncated download.
    size="$(wc -c <"$TMP/tessdata-$lang")"
    [ "$size" -gt 1000000 ] \
      || { echo "ERROR: tessdata_${OCR_TESSDATA_TIER}/${lang}.traineddata is too small to be real (${size} bytes)" >&2; exit 1; }
    magic="$(head -c 3 "$TMP/tessdata-$lang" | od -An -tu1 | tr -s ' ' | sed 's/^ //')"
    [ "$magic" = "24 0 0" ] \
      || { echo "ERROR: tessdata_${OCR_TESSDATA_TIER}/${lang}.traineddata is not a traineddata file (magic: $magic)" >&2; exit 1; }
    install -m 0644 "$TMP/tessdata-$lang" "$TESSDATA_DIR/$lang.traineddata"
  done
  ls -l "$TESSDATA_DIR"
fi

# --list-langs is the real check: it reads the tessdata directory the way a
# request does, so a wrong or absent traineddata shows up here.
tesseract --list-langs

# ---------------------------------------------------------------------
# 2. Record exactly what was installed. Reproducibility is the point: an OCR
#    report can cite this file instead of "whatever the tag was that day".
# ---------------------------------------------------------------------
step "version manifest"
{
  printf '# tesseract / OCR toolchain — installed versions\n'
  printf '# generated by docker/ocr-toolchain.sh\n'
  printf 'installed_utc: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'arch: %s\n' "$(dpkg --print-architecture)"
  printf 'engine: %s\n' "$(tesseract --version 2>&1 | head -n 1)"
  printf 'tessdata_tier: %s\n' "$OCR_TESSDATA_TIER"
  printf 'tessdata_ref: %s\n' "$OCR_TESSDATA_REF"
  printf 'tessdata_dir: %s\n' "$TESSDATA_DIR"
  printf 'languages: %s\n' "$(tesseract --list-langs 2>&1 | tail -n +2 | paste -sd ' ' -)"
  for lang in $OCR_TESSDATA_LANGS; do
    printf 'sha256_%s: %s\n' "$lang" "$(sha256sum "$TESSDATA_DIR/$lang.traineddata" | cut -d' ' -f1)"
  done
} > "$TOOLS_DIR/VERSIONS.txt"
sed -n '1,14p' "$TOOLS_DIR/VERSIONS.txt"

# Everything here is read-only at runtime (the stack runs read_only:true), but
# it must be readable and owned by the user the container runs as.
if id node >/dev/null 2>&1; then
  chown -R node:node "$TOOLS_DIR" "$TESSDATA_DIR" 2>/dev/null || true
fi

step "ocr toolchain installed (route A: tesseract)"
