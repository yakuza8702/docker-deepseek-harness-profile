#!/usr/bin/env python3
"""office-swap-pages — rebuild a PDF with its pages reordered / swapped / rotated.

WHY THIS EXISTS
---------------
Page surgery is the piece neither soffice nor the office skills are shaped for:
LibreOffice repaginates (its pagination is the engine's, not the source file's),
and the bundled skills read rather than cut. python-docx/openpyxl cannot reach
PDF pages at all. pypdf can move whole pages WITHOUT re-encoding them — the
pixels, fonts and text layer of every copied page are byte-identical objects,
which is the same rule ocr-pdf honest-rebuild keeps to.

USAGE
-----
    office-swap-pages <input.pdf> <output.pdf> <order-spec>

<order-spec> is a comma-separated list of tokens; the output is built in exactly
that sequence. Each token is:

    N          the input's 1-based page N, carried over 1:1
    N-M        the consecutive run N..M (inclusive; M >= N)
    N[:angle]  the page copied AND rotated by angle (90|180|270)

"swap pages 2 and 4"          ->  1,4,3,2
"put the cover at the end"    ->  2-5,1
"swap AND turn page 6"        ->  1-5,6:180,7
Duplicates are allowed (a page may appear twice); references to pages that do
not exist fail loudly with a page-count report instead of producing a silent
stub. Nothing else about the document is touched, and metadata survives.

Exit codes: 0 = written, 2 = bad arguments / spec, 3 = PDF read error.
"""

from __future__ import annotations

import sys


def parse_token(token: str, page_count: int) -> list[tuple[int, int]]:
    """One token -> list of (1-based page, rotate-by) pairs. Raises ValueError."""
    rotate = 0
    page_text = token
    if ":" in token:
        page_text, _, angle = token.partition(":")
        rotate = int(angle)
        if rotate not in (0, 90, 180, 270):
            raise ValueError(f"rotation must be 90, 180 or 270, not {angle!r}")
    if "-" in page_text:
        lo_text, _, hi_text = page_text.partition("-")
        lo, hi = int(lo_text), int(hi_text)
        if lo > hi:
            raise ValueError(f"run {page_text!r} is not a run (needs start <= end)")
    else:
        lo = hi = int(page_text)
    if not (1 <= lo <= page_count) or hi > page_count:
        raise ValueError(f"page token {token!r} reaches outside this document ({page_count} pages)")
    return [(page, rotate) for page in range(lo, hi + 1)]


def main() -> int:
    import argparse

    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:  # the wrapper runs the payload interpreter first; report rather than crash
        sys.stderr.write("office-swap-pages: pypdf is not installed for this python — "
                         "the office payload interpreter has it (see /usr/local/bin/office-swap-pages)\n")
        return 3

    parser = argparse.ArgumentParser(
        description="Rebuild a PDF with pages reordered/swapped; pixels byte-identical.")
    parser.add_argument("input", help="source PDF")
    parser.add_argument("output", help="destination PDF")
    parser.add_argument("order", help="e.g. 3,1-2  or  1-5,6:180,7  (1-based)")
    args = parser.parse_args()

    try:
        reader = PdfReader(args.input)
        page_count = len(reader.pages)
    except Exception as exc:  # noqa: BLE001 — report the real read failure, not a traceback wall
        sys.stderr.write(f"office-swap-pages: cannot read {args.input}: {exc}\n")
        return 3

    try:
        plan: list[tuple[int, int]] = []
        for token in args.order.split(","):
            token = token.strip()
            if token:
                plan.extend(parse_token(token, page_count))
    except ValueError as exc:
        sys.stderr.write(f"office-swap-pages: {exc}\n")
        return 2
    if not plan:
        sys.stderr.write("office-swap-pages: empty order — nothing would be written\n")
        return 2

    writer = PdfWriter()
    for page_number, rotate in plan:
        page = reader.pages[page_number - 1]
        if rotate:
            page.rotate(rotate)
        writer.add_page(page)
    if reader.metadata:
        writer.add_metadata(reader.metadata)
    with open(args.output, "wb") as output:
        writer.write(output)

    print(f"office-swap-pages: {len(plan)} pages -> {args.output} (source had {page_count})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
