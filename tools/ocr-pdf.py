#!/usr/bin/env python3
"""ocr-pdf.py — route A: tesseract OCR for PDFs, injected as an invisible text layer.

WHAT THIS IS
------------
The `pdf-documents` skill used to answer a page with no text layer with "there
is no OCR in this image" and stop there. This is the missing half: it turns the
pixels of a page into real, selectable, searchable text and writes that text
back into the SAME PDF as an INVISIBLE layer (PDF text render mode 3), so that

  * the deliverable still shows exactly the image it showed before — the page's
    own pixels are never re-encoded, never re-sampled and never re-drawn;
  * Ctrl-F, copy/paste and text extraction now find words that only ever existed
    as pixels.

It runs on the pinned interpreter the Office skills already use (pypdf and
PyMuPDF are in that payload) and drives the system OCR engine, so nothing is
installed at request time and there is no second Python to disagree with the
first.

WHY TESSERACT, AND NOTHING ELSE
-----------------------------
tesseract 5 (LSTM, `tessdata_best`) is the fast, folder-clean engine: one process
per page, no model session to warm up, no Python wheels to load, and output that
every other OCR tool is calibrated against. The alternatives (RapidOCR/PP-OCRv4
ONNX, EasyOCR, PaddleOCR) each pull a few hundred MB of runtime and burn CPU on
every run for a second opinion this image does not need — so they are deliberately
not installed and this driver has no flag that pretends otherwise.

THE TWO LAYER SHAPES
--------------------
Tesseract's own `pdf` writer emits an invisible layer — by RENDERing its own
copies of the page images into the page. That is how "OCR this PDF" becomes
"quietly replace this PDF's images", which is what this driver will not do:

  --mode overlay  (DEFAULT) keep the page as it is and draw the OCR text on top
                  with render mode 3. Only an extra content stream and its
                  resources are appended.
  --mode reflow   produce a new page of the SAME size for each OCR'd page, put
                  the rasterised source page on it as a background image, and
                  lay the text on that. Use it when a page's own content cannot
                  be appended to, or when the layer must land in a page whose
                  pixel content is known to be exactly the raster.

THE GEOMETRY, AND WHY IT IS MEASURED RATHER THAN ASSUMED
--------------------------------------------------------
The page-filling image is the bitmap the text was baked into, so the mapping is
"pixel box -> image rectangle -> page points", and the raster produced by
`get_pixmap` is the page's view box at `dpi/72`. The driver takes the filling
image's own bbox (`get_image_info`) and scales from THAT, which is what makes
the layer land on the glyphs instead of on an approximation of them.

`--verify` then measures it: it re-opens the RESULT, and for a sample of words
crops the OUTPUT page at the word's declared rectangle and OCRs that crop back
alone. A layer written at the wrong scale or offset is shifted relative to the
picture, and this is the check that catches it — so "the layer is in the right
place" is a number in the report, not a hope.

USAGE (operator-facing guide: docker/ocr-pdf.md)
------------------------------------------------
  ocr-pdf --input IN.pdf --output OUT.pdf
  ocr-pdf --input IN.pdf --output OUT.pdf --pages 3-5,12 --dpi 300
  ocr-pdf --input IN.pdf --output OUT.pdf --verify --text-dump out.md
  ocr-pdf --input IN.pdf --output OUT.pdf --verify --json report.json
  ocr-pdf --probe
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

import pymupdf  # PyMuPDF — the payload ships it
import pypdf  # noqa: F401 — imported so a wrong interpreter fails loudly here


def fail(message: str) -> Any:
    print(f"ocr-pdf: {message}", file=sys.stderr)
    sys.exit(1)


# --------------------------------------------------------------------------
# Engine discovery
# --------------------------------------------------------------------------

def tessdata_dir() -> str:
    """Tesseract's tessdata directory, asked of tesseract itself when possible."""
    explicit = os.environ.get("OCR_TESSDATA_DIR")
    if explicit:
        return explicit
    binary = shutil.which("tesseract")
    if binary:
        try:
            probe = subprocess.run([binary, "--print-tessdata-dir"],
                                   capture_output=True, text=True, timeout=30)
            if probe.returncode == 0 and probe.stdout.strip():
                return probe.stdout.strip()
        except Exception:
            pass
    return "/usr/share/tesseract-ocr/5/tessdata"


def engine_report() -> dict:
    """What is actually installed — for `--probe` and for the run report."""
    report: dict = {"python": sys.version.split()[0], "pymupdf": pymupdf.VersionBind,
                    "pypdf": None, "tesseract": None, "tessdata": None}
    try:
        report["pypdf"] = pypdf.__version__
    except Exception:
        pass

    binary = shutil.which("tesseract")
    if binary:
        try:
            version = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=60)
            lines = (version.stdout + version.stderr).strip().splitlines()
            report["tesseract"] = lines[0].strip() if lines else binary
            langs = subprocess.run([binary, "--list-langs"], capture_output=True, text=True, timeout=60)
            report["tessdata"] = {
                "dir": tessdata_dir(),
                "languages": [line.strip() for line in (langs.stdout + langs.stderr).splitlines()[1:] if line.strip()],
            }
        except Exception as error:
            report["tesseract"] = f"{binary} (probe failed: {error})"
    else:
        # No CLI on PATH: say whether the binding fallback is usable, so `--probe`
        # answers "can route A run here" instead of only "is tesseract installed".
        try:
            import tesserocr  # type: ignore

            version = str(tesserocr.tesseract_version()).splitlines()[0].strip()
            languages = list(tesserocr.get_languages(tessdata_dir())[1])
            report["tesseract"] = f"{version} (tesserocr binding, no CLI)"
            report["tessdata"] = {"dir": tessdata_dir(), "languages": languages}
        except Exception as error:
            report["tesseract"] = f"unavailable ({type(error).__name__}: {error})"

    return report


def parse_pages(spec: str, count: int) -> list[int]:
    """'1-3,7,10-' -> 1-based page numbers, de-duplicated, bounded to the document."""
    wanted: list[int] = []
    for chunk in spec.replace(" ", "").split(","):
        if not chunk:
            continue
        if "-" in chunk:
            start, _, end = chunk.partition("-")
            first = int(start) if start else 1
            last = int(end) if end else count
            wanted.extend(range(first, last + 1))
        else:
            wanted.append(int(chunk))
    ordered: list[int] = []
    seen: set[int] = set()
    for number in wanted:
        if 1 <= number <= count and number not in seen:
            seen.add(number)
            ordered.append(number)
    return ordered


def normalise(text: str) -> str:
    """Case- and punctuation-insensitive comparison, for the verification step."""
    keep = [character.lower() for character in text if character.isalnum() or character.isspace()]
    return " ".join("".join(keep).split())


# --------------------------------------------------------------------------
# Route A — tesseract
# --------------------------------------------------------------------------

class Tesseract:
    """The tesseract CLI: one process per page, TSV as the word geometry.

    This is route A's front door. When the `tesseract` binary is not on PATH but
    the `tesserocr` binding is importable (it ships its own libtesseract), the
    class falls back to that binding — same engine, same TSV, no CLI. That keeps
    route A working in a deployment where only the Python half was installed,
    and it is what lets the build gate exercise this driver without a second
    install step.
    """

    def __init__(self, language: str = "eng", psm: int = 3, oem: int = 1):
        self.language = language
        self.psm = psm
        self.oem = oem
        self.last_seconds = 0.0
        self.backend = ""
        self.binary = shutil.which("tesseract") or ""
        self._binding_api = None
        if self.binary:
            self.backend = "cli"
            return
        try:
            import tesserocr  # type: ignore

            self._binding_api = tesserocr.PyTessBaseAPI(path=tessdata_dir(), lang=language, oem=oem, psm=psm)
            self.backend = "tesserocr"
        except Exception as error:
            fail("neither the tesseract CLI nor the tesserocr binding is usable: "
                 f"{error} — this image installs tesseract; see /opt/ocr-tools/README.md")

    def words(self, image_path: str, workdir: str) -> tuple[list[dict], str]:
        """OCR one raster. Returns (words with pixel boxes, the page's raw text)."""
        started = time.time()
        if self.backend == "cli":
            words, text = self._words_cli(image_path, workdir)
        else:
            words, text = self._words_binding(image_path)
        self.last_seconds = time.time() - started
        return words, text

    def _words_cli(self, image_path: str, workdir: str) -> tuple[list[dict], str]:
        base = os.path.join(workdir, "page")
        self.last_args = [self.binary, image_path, base, "-l", self.language,
                          "--oem", str(self.oem), "--psm", str(self.psm), "tsv"]
        result = subprocess.run(self.last_args, capture_output=True, text=True, timeout=1800)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip().splitlines()
            fail(f"tesseract exited {result.returncode}: {detail[-1] if detail else '(no output)'}")
        with open(base + ".tsv", "r", encoding="utf-8", errors="replace") as handle:
            words = parse_tsv(handle.read())
        try:
            with open(base + ".txt", "r", encoding="utf-8", errors="replace") as handle:
                text = handle.read()
        except FileNotFoundError:
            text = " ".join(word["text"] for word in words)
        return words, text

    def _words_binding(self, image_path: str) -> tuple[list[dict], str]:
        from PIL import Image  # Pillow is in the same payload as PyMuPDF

        with Image.open(image_path) as image:
            # Annotate is the LSTM path; the fixed psm/oem on the API govern it.
            self._binding_api.SetImage(image.convert("RGB"))
            text = self._binding_api.GetUTF8Text()
            words = parse_tsv(self._binding_api.GetTSVText(0))
        return words, text


def parse_tsv(tsv: str) -> list[dict]:
    """tesseract's TSV -> word rows with pixel boxes. Shared by both backends.

    Only level-5 rows with a non-negative confidence are words; every other row
    is a container (page, block, paragraph, line), and a negative confidence row
    is a container too — treating one as a word is how a layer ends up with
    stray entries that search then finds.

    The column order is data-driven rather than assumed, because the two
    backends disagree about the header: the CLI's TSV starts with a named header
    row, while the Python binding's `GetTSVText` omits it — so the header is
    taken from the first row only if that row actually names the columns, and the
    documented order is the fallback.
    """
    named = ["level", "page_num", "block_num", "par_num", "line_num", "word_num",
             "left", "top", "width", "height", "conf", "text"]
    lines = tsv.splitlines()
    if not lines:
        return []
    header = lines[0].split("\t")
    body = lines[1:]
    if "text" not in header or "level" not in header:
        header = named
        body = lines
    index = {name: position for position, name in enumerate(header)}

    words: list[dict] = []
    for line in body:
        fields = line.split("\t")
        if len(fields) < len(header):
            continue
        text = fields[index["text"]].strip()
        if not text:
            continue
        try:
            level = int(fields[index["level"]])
            conf = float(fields[index["conf"]])
            left, top = int(fields[index["left"]]), int(fields[index["top"]])
            width, height = int(fields[index["width"]]), int(fields[index["height"]])
        except (ValueError, KeyError):
            continue
        if level != 5 or conf < 0:
            continue
        words.append({
            "text": text,
            "conf": conf / 100.0,
            "box": (left, top, left + width, top + height),
        })
    return words


class TesseractOsd:
    """Orientation and script detection — what `--rotate-pages` actually needs."""

    def __init__(self):
        self.binary = shutil.which("tesseract") or ""
        if not self.binary:
            fail("tesseract is not installed (route A)")

    def detect(self, image_path: str) -> dict | None:
        """'Rotate: <deg>' from tesseract's OSD, or None when it cannot tell."""
        try:
            result = subprocess.run([self.binary, image_path, "stdout", "--psm", "0"],
                                    capture_output=True, text=True, timeout=300)
        except Exception:
            return None
        if result.returncode != 0:
            return None
        orientation = None
        confidence = None
        for line in (result.stdout + result.stderr).splitlines():
            key, _, value = line.partition(":")
            key, value = key.strip(), value.strip()
            if key == "Rotate":
                try:
                    orientation = int(value)
                except ValueError:
                    orientation = None
            elif key == "Orientation confidence":
                try:
                    confidence = float(value)
                except ValueError:
                    confidence = None
        if orientation is None:
            return None
        return {"rotate": orientation, "confidence": confidence}


# --------------------------------------------------------------------------
# The driver
# --------------------------------------------------------------------------

def page_frame(page: "pymupdf.Page", dpi: int) -> tuple["pymupdf.Rect", float, int, int]:
    """The mapping constants between one page's raster pixels and page points.

    Returns (the rectangle the OCR text is measured against, points-per-pixel,
    raster width, raster height).

    The raster from `get_pixmap` is the page's VIEW box at `dpi/72`, so one pixel
    is exactly `72/dpi` points — but the text was baked into the page-FILLING
    IMAGE, whose rectangle can be larger or smaller than the page (a bleed, an
    inset scan). Anchoring on that image's own rectangle is what makes the layer
    land on the glyphs rather than on a scaled approximation of them; the page
    view box is the fallback for a page with no single filling image.
    """
    view = pymupdf.Rect(page.rect)
    frame = view
    for info in page.get_image_info():
        box = pymupdf.Rect(info["bbox"])
        if box.width >= view.width * 0.5 and box.height >= view.height * 0.5:
            frame = box
            break
    points_per_pixel = 72.0 / dpi
    return frame, points_per_pixel, int(round(view.width * dpi / 72.0)), int(round(view.height * dpi / 72.0))


def word_rect(word: dict, frame: "pymupdf.Rect", points_per_pixel: float) -> "pymupdf.Rect":
    """A word's raster-pixel box -> a rectangle in page points."""
    x0, y0, x1, y1 = word["box"]
    return pymupdf.Rect(
        frame.x0 + x0 * points_per_pixel,
        frame.y0 + y0 * points_per_pixel,
        frame.x0 + x1 * points_per_pixel,
        frame.y0 + y1 * points_per_pixel,
    )


def write_layer(target: "pymupdf.Page", words: list[dict], boxes: list["pymupdf.Rect"],
                options: argparse.Namespace) -> None:
    """Draw the words as invisible text (render mode 3) over their own glyphs."""
    for word, rect in zip(words, boxes):
        # The baseline sits at the box's bottom: the confidence-scaled height
        # keeps a taller glyph from being clipped by its own advance width.
        baseline = pymupdf.Point(rect.x0, rect.y1)
        fontsize = max(2.0, rect.height * (1.0 if options.tight else 0.98))
        if options.use_textbox:
            target.insert_textbox(rect, word["text"], fontsize=fontsize,
                                  fontname=options.font, render_mode=3, overlay=True)
        else:
            target.insert_text(baseline, word["text"], fontsize=fontsize,
                               fontname=options.font, render_mode=3, overlay=True)


def verify_page(page: "pymupdf.Page", words: list[dict], boxes: list["pymupdf.Rect"],
                options: argparse.Namespace, workdir: str, number: int) -> dict:
    """Re-OCR the RESULT: the layer must be extractable AND on the right pixels.

    Two independent measurements, because each alone can be fooled:

      * `extracted_chars` — the injected words must come back out of
        `get_text()`; a layer written to another page, dropped by a save, or
        never applied shows up here;
      * `sample` — crop the OUTPUT page at each sampled word's declared
        rectangle and OCR that crop on its own. A layer written at the wrong
        scale or offset is shifted relative to the picture it describes, and
        this is what catches it.
    """
    extracted = page.get_text()
    result: dict = {"extracted_chars": len(extracted), "sample": None}
    if not words:
        return result

    step = max(1, len(words) // max(1, options.verify_samples))
    checked = 0
    matched = 0
    mismatches: list[str] = []
    for index in range(0, len(words), step):
        word, rect = words[index], boxes[index]
        clip = pymupdf.Rect(rect.x0 - 1.5, rect.y0 - 1.5, rect.x1 + 1.5, rect.y1 + 1.5) & page.rect
        if clip.is_empty or clip.width < 2 or clip.height < 2:
            continue
        crop = os.path.join(workdir, f"verify-{number}-{checked}.png")
        page.get_pixmap(dpi=options.verify_dpi, clip=clip, alpha=False).save(crop)
        probe = Tesseract(language=options.language, psm=options.verify_psm, oem=options.oem)
        try:
            found, _text = probe.words(crop, workdir)
        except SystemExit:
            continue
        seen = " ".join(entry["text"] for entry in found).strip()
        checked += 1
        if normalise(seen) == normalise(word["text"]):
            matched += 1
        elif len(mismatches) < 5:
            mismatches.append(f"{word['text']!r} read back as {seen!r}")
    result["sample"] = {"checked": checked, "matched": matched, "mismatches": mismatches}
    return result


def ocr_document(options: argparse.Namespace) -> dict:
    if not os.path.exists(options.input):
        fail(f"no such file: {options.input}")
    document = pymupdf.open(options.input)
    if document.needs_pass:
        fail("the input PDF is encrypted — decrypt it first (the payload has no AES support)")

    total_pages = document.page_count
    selected = parse_pages(options.pages, total_pages) if options.pages else list(range(1, total_pages + 1))
    if not selected:
        fail(f"--pages {options.pages!r} selected nothing in a {total_pages}-page document")

    ocr = Tesseract(language=options.language, psm=options.psm, oem=options.oem)
    osd = TesseractOsd() if options.rotate_pages else None

    report: dict = {
        "input": os.path.abspath(options.input),
        "output": os.path.abspath(options.output),
        "mode": options.mode,
        "engine": "tesseract",
        "dpi": options.dpi,
        "language": options.language,
        "source_pages": total_pages,
        "selected_pages": selected,
        "engine_report": engine_report(),
        "pages": [],
    }

    workdir = tempfile.mkdtemp(prefix="ocr-pdf-")
    started = time.time()
    reflowed: set[int] = set()
    try:
        out = pymupdf.open() if options.mode == "reflow" else None

        for number in selected:
            page = document[number - 1]
            rotation = page.rotation or 0

            detected = None
            effective_rotation = rotation
            if options.rotate_pages:
                osd_raster = os.path.join(workdir, f"osd-{number}.png")
                page.get_pixmap(matrix=pymupdf.Matrix(150 / 72.0, 150 / 72.0), alpha=False).save(osd_raster)
                detected = osd.detect(osd_raster) if osd else None
                if (detected and detected.get("rotate") in (90, 180, 270)
                        and (detected.get("confidence") or 0) >= options.osd_min_conf):
                    effective_rotation = (rotation + detected["rotate"]) % 360

            # A rotated page is OCR'd through a detached copy carrying the new
            # /Rotate, so the pixels and the boxes share one coordinate system.
            view = page
            if effective_rotation != rotation:
                holder = pymupdf.open()
                holder.insert_pdf(document, from_page=number - 1, to_page=number - 1)
                view = holder[0]
                view.set_rotation(effective_rotation)

            raster = os.path.join(workdir, f"page-{number}.png")
            view.get_pixmap(dpi=options.dpi, alpha=False).save(raster)
            frame, points_per_pixel, pixel_width, pixel_height = page_frame(view, options.dpi)

            words, text = ocr.words(raster, workdir)
            engine_timing = {"engine": "tesseract", "words": len(words), "seconds": round(ocr.last_seconds, 3)}

            if options.mode == "reflow":
                target = out.new_page(width=page.rect.width, height=page.rect.height)
                target.show_pdf_page(target.rect, document, number - 1)
                reflowed.add(number - 1)
            else:
                target = page

            kept: list[dict] = []
            boxes: list["pymupdf.Rect"] = []
            for word in words:
                if word["conf"] < options.min_conf:
                    continue
                rect = word_rect(word, frame, points_per_pixel)
                if rect.is_empty or rect.width < 0.5 or rect.height < 0.5:
                    continue
                kept.append(word)
                boxes.append(rect)
            write_layer(target, kept, boxes, options)

            entry = {
                "page": number,
                "rotation_declared": rotation,
                "rotation_used": effective_rotation,
                "osd": detected,
                "dpi": options.dpi,
                "frame": {"x": round(frame.x0, 2), "y": round(frame.y0, 2),
                          "width": round(frame.width, 2), "height": round(frame.height, 2)},
                "raster": {"width": pixel_width, "height": pixel_height},
                "words_candidates": len(words),
                "words_written": len(kept),
                "engine": engine_timing,
                "text_chars": len(text),
                "text_preview": " ".join(text.split())[:200],
            }
            if options.verify:
                entry["verify"] = verify_page(target, kept, boxes, options, workdir, number)
            report["pages"].append(entry)

            if options.text_dump:
                with open(options.text_dump, "a", encoding="utf-8") as handle:
                    handle.write(f"\n===== page {number} =====\n{text.strip()}\n")
            if options.verbose:
                print(f"ocr-pdf: page {number}: {len(kept)} words, {len(text)} chars", file=sys.stderr)

        if out is not None:
            # Reflow rebuilds the OCR'd pages; every other page is copied through
            # untouched, in order, so the document's page count cannot change.
            for index in range(total_pages):
                if index not in reflowed:
                    out.insert_pdf(document, from_page=index, to_page=index)
            try:
                out.set_metadata(document.metadata or {})
            except Exception:
                pass
            out.save(options.output, garbage=3, deflate=True)
        else:
            document.save(options.output, garbage=3, deflate=True, incremental=False)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    report["seconds"] = round(time.time() - started, 3)
    report["words_total"] = sum(entry["words_written"] for entry in report["pages"])
    report["pages_ocred"] = len(report["pages"])
    if options.json:
        with open(options.json, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ocr-pdf",
        description="Add a real, searchable text layer to a PDF by OCR'ing its pages (route A: tesseract).",
    )
    parser.add_argument("--input", "-i", help="input PDF")
    parser.add_argument("--output", "-o", help="output PDF (must differ from the input)")
    parser.add_argument("--pages", help="page selection, e.g. 1-3,7,10- (default: every page)")
    parser.add_argument("--dpi", type=int, default=300,
                        help="raster resolution fed to the engine (default 300; 200-400 is the useful range)")
    parser.add_argument("--mode", default="overlay", choices=["overlay", "reflow"],
                        help="overlay keeps the page's own pixels and adds the text layer (default); "
                             "reflow rebuilds each OCR'd page with the raster as its background")
    parser.add_argument("--language", "-l", default="eng", help="tesseract language(s), e.g. eng or eng+msa")
    parser.add_argument("--psm", type=int, default=3, help="tesseract page segmentation mode (default 3)")
    parser.add_argument("--oem", type=int, default=1, help="tesseract engine mode (default 1 = LSTM)")
    parser.add_argument("--font", default="helv", help="base-14 font for the invisible layer (default helv)")
    parser.add_argument("--use-textbox", action="store_true",
                        help="lay each word out inside its own box instead of at its baseline")
    parser.add_argument("--tight", action="store_true",
                        help="size the layer from the exact glyph height instead of 98%% of the box")
    parser.add_argument("--min-conf", type=float, default=0.30,
                        help="drop words below this confidence (default 0.30; a wrong invisible word is "
                             "worse than a missing one, because search WILL find it)")
    parser.add_argument("--rotate-pages", action="store_true",
                        help="let tesseract OSD detect a sideways scan and rotate the page for the pass")
    parser.add_argument("--osd-min-conf", type=float, default=3.0,
                        help="minimum OSD confidence for --rotate-pages (default 3.0)")
    parser.add_argument("--verify", action="store_true",
                        help="after writing, extract the layer and OCR a sample of words back out")
    parser.add_argument("--verify-samples", type=int, default=8, help="words checked per page (default 8)")
    parser.add_argument("--verify-dpi", type=int, default=600, help="dpi for the verification crops (default 600)")
    parser.add_argument("--verify-psm", type=int, default=7, help="psm for the verification crops (default 7)")
    parser.add_argument("--text-dump", help="also append the per-page OCR text to this file")
    parser.add_argument("--json", help="write a machine-readable report here")
    parser.add_argument("--probe", action="store_true", help="print what is installed and exit")
    parser.add_argument("--verbose", "-v", action="store_true")
    options = parser.parse_args(argv)

    if options.probe:
        print(json.dumps({"installed": engine_report(), "tessdata_dir": tessdata_dir()}, indent=2))
        return 0
    if not options.input or not options.output:
        parser.error("--input and --output are required (or use --probe)")
    if os.path.abspath(options.input) == os.path.abspath(options.output):
        parser.error("--output must differ from --input: a new file is written, never in place")

    report = ocr_document(options)
    print(json.dumps({
        "pages_ocred": report["pages_ocred"],
        "words": report["words_total"],
        "seconds": report["seconds"],
        "output": report["output"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
