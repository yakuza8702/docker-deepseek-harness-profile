---
name: pdf-documents
description: 'Read, create, assemble and check PDF files (.pdf). Use when a PDF is an input or a requested deliverable — extract text or embedded images, OCR a scanned or image-only page into a real searchable text layer, render pages as images so a vision model can look at the layout, split, merge, rotate, stamp or fill what is fillable, and produce a PDF from a Word, PowerPoint or Excel source. Load this before running any PDF command.'
---

# PDF documents

A PDF is a **finished page description**, not an editable document. Everything below
follows from that one fact: you can read it, rearrange it, stamp it and regenerate it,
but you cannot reflow text inside it. When the user asks to "edit" a PDF, decide which
of those it actually is, and say so if the honest answer is "regenerate from the
source".

## The runtime

Call `load_workspace_dependencies` once and use the Python it returns — it owns
`pypdf`, `PyMuPDF`, `Pillow`, `python-docx`, `python-pptx` and `openpyxl`. Do not
install packages and do not hunt for a system Python; the returned
`pythonPackages` path is the site-packages those libraries live in.

The rendering and conversion engine is the bundled LibreOffice kit — LibreOffice
compiled to WebAssembly, already in this image, no service to start. Its CLI entry is
absolute and stable:

```sh
node /opt/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js <verb> --input <file> …
```

Verbs: `capabilities`, `convert`, `render`, `recalculate`. Run `capabilities --json`
once if you need to confirm what the engine accepts.

## Read it

**Text.** `pypdf` is the quick path:

```python
from pypdf import PdfReader
reader = PdfReader("paper.pdf")
print(len(reader.pages), reader.metadata.title)
for index, page in enumerate(reader.pages, 1):
    print(index, page.extract_text()[:400])
```

Text that extracts as garbage usually means a scanned page (an image of text, no text
layer). **Do not report that as a dead end — OCR it** (see below), or render the page
and read it with a vision model. Never return empty text as if the page were blank.

**Image-only pages — OCR them, and hand back a searchable PDF.**

```sh
ocr-pdf --input paper.pdf --output paper-searchable.pdf            # every page
ocr-pdf --input paper.pdf --output paper-searchable.pdf --pages 3-5 --verify
ocr-pdf --input paper.pdf --output part.pdf --pages 1-40 --text-dump part.md
```

`ocr-pdf` runs tesseract 5 over the page's pixels and writes the result back as an
**invisible text layer** (render mode 3), so the output is the same document — the
images are never re-encoded or redrawn — but Ctrl-F, copy/paste and `extract_text`
now find words that only existed as pictures. `--output` must differ from `--input`.

| You want | Flag |
|---|---|
| A page range (a contract whose signature pages are scans) | `--pages 3-5,12` |
| More precision on small type | `--dpi 300` (default) up to 400 |
| Fewer wrong invisible words in a document that will be searched | `--min-conf 0.60` |
| A sideways scan | `--rotate-pages` |
| The OCR text without opening the PDF | `--text-dump notes.md` |
| Proof the layer sits on the right pixels | `--verify --json report.json` |

Read `--verify`'s output rather than assuming: `sample.matched == sample.checked` is
the bar for delivering, and the mismatches are printed verbatim. A stylised brand
wordmark read back differently is the *source image* being decorative — the layer is
still correctly placed; a real word read back as an unrelated one means the layer is
on the wrong pixels, and the fix is `--dpi` up, `--min-conf` up, or `--mode reflow`.

`ocr-tools` prints what is installed; `ocr-tools --check` re-proves it. Full guide:
`/opt/ocr-tools/README.md`.

**OCR is not a substitute for looking.** For a page whose *layout* is the question — a
diagram, a chart, a form's geometry — render the page and read the image. Use both
when both matter: OCR for "find the word", a render for "what does the page look like".

**Layout, figures and scans — for a vision model.** Render pages to PNG and read them:

```sh
node /opt/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js render \
  --input paper.pdf --output-dir pages --pages 1-3 --dpi 144
```

Then `read_image` each PNG from the manifest (`pages/manifest.json` lists the paths,
page numbers and any missing fonts). Rendering a PDF goes through PDFium, not
LibreOffice, so a PDF never needs the Office pipeline. Check that the session's model
accepts images before generating previews — if it does not, finish the text and
structural work and state that the layout was not inspected.

**Embedded images** (photos, logos, scanned figures) are separate objects. Pull them
out with PyMuPDF and read them individually:

```python
import pymupdf
doc = pymupdf.open("paper.pdf")
for page_number, page in enumerate(doc, 1):
    for index, info in enumerate(page.get_images(full=True), 1):
        image = doc.extract_image(info[0])
        open(f"figure-{page_number}-{index}.{image['ext']}", "wb").write(image["image"])
```

`page.get_images()` finds what is *placed* on a page; `doc.get_page_images()` on a page
object and `page.get_drawings()` help when a figure is vector art. Vector art has no
embedded bitmap to extract — render the page and read that instead.

## Create it

**From an Office source** (the usual answer — this is how you get real typography):

```sh
node /opt/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js convert \
  --input report.docx --output report.pdf
```

Or from images with Pillow: `Image.save("out.pdf", save_all=True, append_images=[…])`.

Prefer building the `.docx`/`.pptx`/`.xlsx` first (load the matching office skill) and
converting: you get the layout engine's pagination, and the user gets a document they
can edit later instead of a dead PDF.

## Assemble and edit

The honest set, all with `pypdf`:

| Task | Call |
|---|---|
| Merge | `PdfWriter()` · `writer.append(path)` … |
| Split / extract a range | `writer.add_page(reader.pages[i])` |
| Rotate | `page.rotate(90)` |
| Delete / reorder | add pages in the order you want |
| Stamp or watermark | `page.merge_page(overlay_page)` |
| Crop | `page.mediabox = RectangleObject(...)` |
| Metadata | `writer.add_metadata({"/Title": …})` |
| Fill a form | `writer.update_page_form_field_values(page, {"field": "value"})` |

Encrypted input: `PdfReader(path)` then `reader.decrypt(password)` for the classic
schemes. AES-encrypted files need the `cryptography` package, which is **not** in this
payload — if `decrypt` raises, report the limitation rather than working around it.

## Check before delivering

1. Page count and page size are what the user asked for (`len(reader.pages)`, `page.mediabox`).
2. The text you claimed to add is actually present in the extracted text.
3. Render one or two representative pages and look at them — a blank or transparent
   render means the render failed, not that the page is empty. Do not retry a wider
   range, another DPI or another format: report the visual check as unavailable.
4. Embedded assets you meant to keep are still there (`page.get_images()`).

Rendering proves layout on this engine; it does not prove how Acrobat or a printer will
lay it out. Say which one you checked.

## Deliver

Call `present({"files":[{"path":"report.pdf"}]})` with the final PDF path, and keep that
file in place. Workspace paths are fine too when `present` is unavailable.

## Limits, state them rather than fight them

* No reflow, no editing text inside an existing page, no re-pagination.
* OCR adds a *text layer*, it does not improve the picture: a scan unreadable to a
  human produces confident nonsense, and `--verify` is how you find that out rather
  than promise a search that works.
* OCR does not do handwriting reliably. Say so instead of returning guesses.
* AES-encrypted PDFs may not open (no `cryptography` package in the payload).
* Page rendering: compare against the source before claiming a "missing" element — a
  font the payload does not carry renders as a substitute, and the manifest names it.
