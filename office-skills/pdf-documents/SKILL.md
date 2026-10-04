---
name: pdf-documents
description: 'Read, create, assemble and check PDF files (.pdf). Use when a PDF is an input or a requested deliverable — extract text or embedded images, render pages as images so a vision model can look at the layout, split, merge, rotate, stamp or fill what is fillable, and produce a PDF from a Word, PowerPoint or Excel source. Load this before running any PDF command.'
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
layer). **There is no OCR in this image** — report that plainly and offer the page
renders instead; do not silently return empty text as if the page were blank.

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
* No OCR (no scanned-image text recovery).
* AES-encrypted PDFs may not open (no `cryptography` package in the payload).
* Page rendering: compare against the source before claiming a "missing" element — a
  font the payload does not carry renders as a substitute, and the manifest names it.
