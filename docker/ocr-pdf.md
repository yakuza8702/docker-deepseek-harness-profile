# Reading an image-only PDF in this container

A PDF with no text layer — a scan, a phone photo of a form, a deck whose words were
exported as pictures — used to end the story with *"there is no OCR in this image."*
It does not any more. This is what is installed, and how to use it.

```sh
ocr-tools                       # what is here, with versions
ocr-tools --check               # re-run the build-time proof (exit 1 = broken image)
ocr-pdf --probe                 # the engine the driver can actually reach
cat /opt/ocr-tools/VERSIONS.txt # the pins this image was built from
```

## First move

```sh
ocr-pdf --input scan.pdf --output scan-searchable.pdf
ocr-pdf --input deck.pdf --output deck-searchable.pdf --verify
ocr-pdf --input book.pdf --output part.pdf --pages 1-40 --dpi 300 --text-dump part.md
```

The output is a **new file** whose pages are, pixel for pixel, the pages you gave
it — plus an *invisible* text layer (PDF text render mode 3) sitting on the glyphs.
Ctrl-F, copy/paste, `extract_text` and every PDF reader now find words that only ever
existed as pixels, and nothing in the picture changes.

`--output` must differ from `--input`. Nothing is written in place.

## The engine

**tesseract 5 (LSTM), with the `tessdata_best` weights.** One process per page, no
model session, no runtime download, ~0.3 s for a 2000 px-wide page render.

There is deliberately only one engine here. The alternatives — RapidOCR/PP-OCRv4
ONNX, EasyOCR, PaddleOCR — each pull a few hundred MB of runtime and burn CPU on
every run, for a second opinion this image does not need. If tesseract's read is
wrong, the right answer is a different `--dpi`, `--psm` or `--language`, or a render
of the page handed to a vision model — not a second OCR stack.

## The options worth knowing

| Flag | Why |
|---|---|
| `--dpi 300` | Default, and the useful band is 200–400. Below ~150 the small type stops resolving; above ~400 you pay time for no recognition gain. |
| `--pages 3-5,12` | OCR a range instead of the document. The common real case is a contract whose signature pages are scans and whose body is real text. |
| `--mode overlay` | Default. Keeps the page's own content and appends the layer. |
| `--mode reflow` | Rebuilds each OCR'd page as "raster background + text layer". Use it only when a page's own content cannot be appended to, or you need one known coordinate space. |
| `--min-conf 0.30` | Drops low-confidence words. **Raise it for a document you will search**: a wrong invisible word is worse than a missing one, because search *will* find it. 0.60 is a good start for clean scans, 0.30–0.40 for noisy ones. |
| `--rotate-pages` | Lets tesseract OSD detect a sideways scan and rotate the page for that pass. Off by default — it rewrites the page's `/Rotate`. |
| `--language eng+msa` | Several languages at once, when the traineddata for each is present. `tesseract --list-langs` says what is installed. |
| `--psm 6` | Page segmentation, when the default (3, "fully automatic") gets a form or a single-column scan wrong. `6` = one uniform block; `4` = a single column of variable-size text. |
| `--verify` | Measures the result instead of trusting it (see below). |
| `--text-dump out.md` | Also writes the per-page OCR text as plain text — the fastest way to answer a question about a scan without opening the PDF. |
| `--json report.json` | The full per-page record: word counts, timing, the frame, and the verification numbers. |

## `--verify`: the part that makes this trustworthy

Writing a text layer is easy. Writing it **in the right place** is the whole
problem, and a layer that is off by a few percent is invisible until someone
selects a line and gets the line below it. So `--verify` re-opens the output and
measures two things per page:

* **`extracted_chars`** — the layer must come back out of `get_text()`. A layer
  written to the wrong page, or dropped by the save, shows up here.
* **`sample.checked` / `sample.matched`** — for a sample of words it crops the
  **output page** at the word's own declared rectangle and OCRs that crop alone.
  The crop contains one word's pixels only if the layer really is where it says
  it is. Mismatches are printed verbatim, so a systematic offset reads as a
  pattern rather than as noise.

```sh
ocr-pdf --input in.pdf --output out.pdf --verify --json report.json
jq '.pages[] | {page, words_written, verify}' report.json
```

Read the mismatches for what they are. A stylised brand wordmark read back as
something else is the *source image* being decorative — the layer is still on the
right pixels. `'Prizes' read back as 'Structure'` means the layer is genuinely on
the wrong pixels, and the answer is `--dpi` up (small type), `--min-conf` up
(noise), or `--mode reflow` (unusual page geometry).

## What it does not do

* **It does not improve the picture.** The page image is never re-encoded,
  re-sampled or redrawn; only a content stream and its font resources are
  appended. If the scan is unreadable to a human, OCR produces confident
  nonsense and `--verify` will tell you so (`matched` low).
* **It does not fix a page that is damaged or cropped.** Use `--rotate-pages` for
  a sideways scan; for the rest, fix the source.
* **It does not make a scan reflow.** PDF has no reflow — the honest set stays
  "read, split, merge, rotate, stamp, render, or regenerate from the source".
* **It does not do handwriting reliably.** Neither tesseract's LSTM nor anything
  else offline does; the verification numbers will be honest about the result.

## When the answer is a picture, not text

For a page whose *layout* is the question (a diagram, a chart, a form's geometry),
OCR text is the wrong tool — render the page and look at it:

```sh
node /opt/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js render \
  --input scan.pdf --output-dir pages --pages 1-3 --dpi 144
```

That goes through PDFium, not LibreOffice. Use both when both matter: OCR for
"find the word", a render for "what does the page look like".
