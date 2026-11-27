#!/bin/sh
# =====================================================================
# ocr-tools — what this image can do with an image-only or scanned PDF.
#
# Installed by the image build (see docker/ocr-toolchain.sh). Safe to run
# any time; it only reads.
#
# THE INVENTORY IS NOT IMPLEMENTED HERE. `node /opt/ocr-tools/check.mjs` is the
# one owner of "what is installed, and does it work": it renders a page whose
# text it knows, OCRs it through the real driver and reads the words back out of
# the RESULT. A second inventory in shell could only disagree with it — and did:
# printing `tesseract --version` says "installed" for a tessdata directory the
# gate refuses, and the wrapper's `tier` line was a third copy of the pins. So
# every inventory path DELEGATES, and this file keeps only what a gate cannot
# answer: the option parsing, and `--versions` (a plain `cat` of the pins, which
# callers parse).
#
# Exit status: 0 = the stack proved itself, 1 = it did not (the gate's own
# verdict, propagated unchanged); `--help` is 0, an unknown option is 1.
#
# `ocr-pdf` is the driver an operator (or the agent) actually calls:
# tools/ocr-pdf.py, on the payload interpreter that already owns pypdf and
# PyMuPDF.
# =====================================================================
set -u

TOOLS=/opt/ocr-tools

case "${1:-}" in
  --check | --inventory)
    # Kept as an alias: it is the documented "re-prove the stack" spelling.
    exec node "$TOOLS/check.mjs"
    ;;
  --versions | --pin)
    exec cat "$TOOLS/VERSIONS.txt"
    ;;
  -h | --help)
    cat <<'EOF'
ocr-tools — what this image can do about image-only (scanned) PDFs.

  ocr-tools                   what is installed, with versions
                              (the full probe; exit 1 if the stack does not pass)
  ocr-tools --check           the same probe, spelled out (exit 1 on any failure)
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

# The bare invocation: the gate's inventory and its verdict, nothing restated.
# Status is captured (not `exec`ed) only so the "first moves" lines — which the
# gate has no reason to print — can follow it; the exit code is the gate's.
node "$TOOLS/check.mjs"
status=$?
printf '\nfirst moves\n'
printf '  ocr-pdf --probe                          which engines this container can reach\n'
printf '  ocr-pdf --input scan.pdf --output out.pdf  searchable copy, pixels untouched\n'
printf '  ocr-pdf --input in.pdf --output out.pdf --verify   measure the layer, do not assume it\n'
printf '  cat /opt/ocr-tools/README.md             the workflow, incl. engine choice\n'
exit "$status"
