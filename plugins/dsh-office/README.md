# dsh-office — Office documents as a switchable bundle

Word, PowerPoint and Excel work for the model — create, read, edit, render, convert,
check and deliver — on top of the harness's **own** Office packages. Nothing here is
a third-party plugin, nothing is installed at runtime, and no Marketplace entry is
involved.

```
Plugins page → Office documents → on    # office-docx / office-pptx / office-xlsx skills + the payload tool
Plugins page → Office documents → off   # skills released; the tool row stays, inert
```

| | |
|---|---|
| Bundle / package | `dsh-office` (title "Office documents") |
| Plugin rows it mounts | `skill-office` → `@deepseek-ai/dsh-skill-office` · `workspace-dependencies` → `@deepseek-ai/dsh-tool-workspace-dependencies` |
| Skills it makes available | `office-docx`, `office-pptx`, `office-xlsx` (bundled upstream), plus this image's `pdf-documents` |
| Interpreter | the pinned payload at `/opt/dsh-office/primary-runtime` (Python 3.12.14) |
| Rendering / conversion | `@deepseek-ai/libreoffice-kit` — LibreOffice compiled to WebAssembly, already inside the image |
| Applies | at the next boot (bundle selection is read when the tree is composed) |

## What it adds

The harness ships three Office skills and the engine that renders them, but a plain
container deployment mounts neither: `@deepseek-ai/dsh-base` carries the skill
*registry* (`skill-filesystem`, `tool-skill`), not the Office provider. Only the SDK
profile and DSH Desktop mount `skill-office`, and both of them supply the Python their
instructions depend on. This bundle is the container's equivalent — the same two rows,
plus the payload that makes them work.

The skills are deliberately explicit about that dependency: `office-docx` says *"call
`load_workspace_dependencies` and execute the returned Python path with its bundled
libraries. Do not install packages or discover a system Python for the default
workflow."* So the payload is not an optimisation, it is the contract.

## The payload, and why it is pinned

`docker/office-runtime.lock.json` is a copy of the upstream
`scripts/primary-runtime/lock.json` for the shipped DSH release, extended with two
wheels: `pypdf` (text, page assembly) and `PyMuPDF` (embedded-image extraction — the
part that makes "read the pictures inside this PDF" work for a vision model).

`tools/build-office-payload.mjs` downloads every archive over HTTPS, checks it against
the SHA-256 in the lock *before* unpacking, and writes the layout
`@deepseek-ai/dsh-tool-workspace-dependencies` validates: `runtime.json`, then
`dependencies/python/bin/python3` and `dependencies/python/lib/python3.12/site-packages`.
`tools/check-office.mjs` then proves it in the same build — the interpreter imports the
libraries, the checker passes on a document the payload itself wrote, and the engine
converts and renders a real file.

Payload contents: `numpy`, `pandas`, `python-dateutil`, `six`, `tzdata`, `python-docx`,
`python-pptx`, `openpyxl`, `Pillow`, `lxml`, `XlsxWriter`, `typing_extensions`,
`et_xmlfile`, `PyMuPDF`, `pypdf` — 15 distributions, about 282 MiB unpacked.

## How the engine works without installing LibreOffice

`@deepseek-ai/libreoffice-kit` ships a *prebuilt* engine: a native helper on macOS and
Windows, and a WebAssembly build of LibreOffice on Linux. The image carries the WASM
package (it is an optional dependency of the kit as installed), so nothing has to be
apt-installed and nothing runs as a service. Every operation starts the engine for its
own two to three seconds and exits:

| Operation | Command |
|---|---|
| Convert an Office file to PDF | `node <cli> convert --input deck.pptx --output deck.pdf` |
| Render pages, slides, or a worksheet range to PNG | `node <cli> render --input report.xlsx --output-dir preview --sheet Summary --range A1:D20 --dpi 144` |
| Render a PDF page to PNG (the vision path for PDFs) | `node <cli> render --input paper.pdf --output-dir pages --pages 1-3 --dpi 144` |
| Recalculate a workbook, formulas preserved | `node <cli> recalculate --input book.xlsx --output book2.xlsx` |

`univer_*`-style wrappers do not exist here and are not needed: the `office-*` skills
carry the exact commands, with the absolute interpreter and CLI paths injected into the
loaded skill text at runtime.

## Reading layouts and images with a vision model

Two different things, both covered:

* **Look at the page.** `render … --dpi 144` writes PNG pages plus a manifest, and the
  core `read_image` tool hands them to the model. Works for `.docx`, `.pptx`, `.xlsx`
  and `.pdf` — the PDF path goes through PDFium, not LibreOffice.
* **Pull the pictures out.** Embedded media lives in the package: `word/media/`,
  `ppt/media/`, `xl/media/` (plain `unzip`), or inside a PDF (PyMuPDF). Save them to
  files and read those images directly.

Upstream's own gate applies: the skills establish that the session's model accepts image
input before generating previews, and say so plainly when it does not.

## Why a bundle

A bundle is the unit the Plugins page lists and switches, so Office appears there as a
card beside the browser rows instead of being an always-on overlay nobody can turn off.
An overlay row is applied *after* the profile layer, which is why the browser rows moved
into bundles too — see `plugins/dsh-browser-mcp/README.md`.

The switch flips the `skill-office` row. That is the half worth switching: it is what
puts three skill descriptions in the catalog and their instructions behind them. The
`workspace-dependencies` row stays mounted — one tool definition, answering one
question, with nothing left to call it once the skills are released.

## Switches

| Variable | Default | Meaning |
|---|---|---|
| `DSH_OFFICE` | `1` | `0` mounts neither row (the feature disappears from the catalog) |
| `DSH_OFFICE_RUNTIME` | `/opt/dsh-office/primary-runtime` | a different payload directory |
| `DSH_BUNDLED_SKILL_DIR` | `/opt/dsh-office/office-skills` | where the `pdf-documents` skill is discovered from |

Both rows also refuse to mount when `runtime.json` is missing from the payload. That is
a boot-safety gate, not a policy: the plugin tree aborts on the first failing entry, so a
skill whose interpreter is gone takes the whole harness with it.

Toggling from the UI writes an id-targeted `disabled:` override into the profile patch
and the loader recomposes live — no restart. Selecting or deselecting the *bundle* is
read at boot.

## Limits, stated honestly

* Rendering and conversion are **LibreOffice**, and upstream's own skill says it:
  pagination can differ from Microsoft Word. Previews are layout QA, not a pixel-exact
  proof of what Word will print.
* A render is bounded to 100 pages, 16.7 million pixels and an 8192 px dimension; the
  engine is not resident, so each operation pays a fresh start.
* **PDF has no reflow.** The honest set is: extract text and images, split, merge,
  rotate, stamp, fill what is fillable, render, and regenerate from the Office source.
  Editing a PDF the way you edit a `.docx` is not a thing this or any offline engine does.
* Delivered `.docx` / `.pptx` / `.xlsx` are genuine OOXML — Microsoft Office opens and
  edits them natively — but the skills cannot preserve what the libraries do not model:
  tracked changes, SmartArt, ActiveX, macros and the like survive only as bytes nobody
  touched.
* Missing fonts are **reported**, not fixed (`missingFonts` in every render manifest).

## Provenance

* Rows and skills: `@deepseek-ai/dsh-skill-office` and
  `@deepseek-ai/dsh-tool-workspace-dependencies`, shipped inside the DSH release the
  image installs (node_modules of the installation; never modified).
* Engine: `@deepseek-ai/libreoffice-kit` (+ `libreoffice-kit-wasm`), an independent
  upstream package — LuKit / LibreOffice under MPL-2.0.
* Payload lock: vendored from `deepseek-ai/deepseek-harness`
  `scripts/primary-runtime/lock.json` at the tag matching the shipped release, with the
  `pypdf` and `PyMuPDF` wheels appended. Python itself comes from
  `astral-sh/python-build-standalone`, hash-verified.
* ⚠️ **Licence note for redistribution:** `pypdf` is BSD-3-Clause, but **PyMuPDF is
  AGPL-3.0** (or a commercial licence from Artifex). It is bundled here because it is
  what makes embedded-image extraction from PDFs reliable; if you mirror or redistribute
  this image publicly, satisfy the AGPL's source-availability and notice obligations, or
  drop that wheel from `docker/office-runtime.lock.json` and the import list in
  `tools/check-office.mjs`.
* The `pdf-documents` skill in `office-skills/` is this repository's own, written
  against the same payload.
