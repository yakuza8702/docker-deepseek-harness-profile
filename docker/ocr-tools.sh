#!/bin/sh
# =====================================================================
# ocr-tools — what this image can do with an image-only or scanned PDF,
# and what answers.
#
# Installed by the image build (see docker/ocr-toolchain.sh). Safe to run
# any time; it only reads. `ocr-tools --check` re-runs the same probe the
# build ran (tools/check-ocr-toolchain.mjs), so a deployed container can
# prove its own OCR stack instead of assuming the image was built right.
#
# `ocr-pdf` is the driver an operator (or the agent) actually calls:
# tools/ocr-pdf.py, on the payload interpreter that already owns pypdf and
# PyMuPDF. This wrapper only answers "what is here" and forwards.
# =====================================================================
set -u

TOOLS=/opt/ocr-tools
PAYLOAD_PYTHON=/opt/dsh-office/primary-runtime/dependencies/python/bin/python3
DRIVER=/opt/ocr-tools/ocr-pdf.py

have() { # have <label> <cmd> — presence only
  if command -v "$2" >/dev/null 2>&1; then
    printf '  %-16s installed (%s)\n' "$1" "$(command -v "$2")"
  else
    printf '  %-16s MISSING — node /opt/ocr-tools/check.mjs says why\n' "$1"
  fi
}

case "${1:-}" in
  --check) exec node "$TOOLS/check.mjs" ;;
  --versions | --pin)
    exec cat "$TOOLS/VERSIONS.txt"
    ;;
  -h | --help)
    cat <<'EOF'
ocr-tools — what this image can do about image-only (scanned) PDFs.

  ocr-tools                   what is installed, with versions
  ocr-tools --check           re-run the build-time probe (exit 1 on any failure)
  ocr-tools --versions        the versions this image was built with

  ocr-pdf --probe             the engines the driver can actually reach

  ocr-pdf --input IN.pdf --output OUT.pdf
                              add a real, searchable text layer (route A: tesseract)
  ocr-pdf --input IN.pdf --output OUT.pdf --verify
                              add the layer, and prove it sits on the pixels
  ocr-pdf --input IN.pdf --output OUT.pdf --pages 3-5 --text-dump out.md
                              a page range, plus the OCR text as plain text

  cat /opt/ocr-tools/README.md   the full guide, incl. which engine for what
EOF
    exit 0
    ;;
  '') ;;
  *)
    echo "ocr-tools: unknown option: $1 (try --help)" >&2
    exit 1
    ;;
esac

printf 'OCR toolchain (image-only / scanned PDFs)\n'
printf '  driver           %s\n' "$DRIVER"
printf '  python           %s\n' "$PAYLOAD_PYTHON"

printf '\nengine — tesseract 5 (route A)\n'
if command -v tesseract >/dev/null 2>&1; then
  printf '  %-16s %s\n' "tesseract" "$(tesseract --version 2>&1 | head -n 1)"
  printf '  %-16s %s\n' "tessdata" "$(tesseract --print-tessdata-dir 2>/dev/null || echo '?')"
  printf '  %-16s %s\n' "languages" "$(tesseract --list-langs 2>/dev/null | tail -n +2 | paste -sd ' ' -)"
else
  printf '  %-16s MISSING — node /opt/ocr-tools/check.mjs says why\n' "tesseract"
fi
if [ -f "$TOOLS/VERSIONS.txt" ]; then
  printf '  %-16s %s\n' "traineddata" "$(sed -n 's/^tessdata_tier: /tier /p' "$TOOLS/VERSIONS.txt")"
fi

printf '\nfirst moves\n'
printf '  ocr-pdf --probe                          which engines this container can reach\n'
printf '  ocr-pdf --input scan.pdf --output out.pdf  searchable copy, pixels untouched\n'
printf '  ocr-pdf --input in.pdf --output out.pdf --verify   measure the layer, do not assume it\n'
printf '  cat /opt/ocr-tools/README.md             the workflow, incl. engine choice\n'
