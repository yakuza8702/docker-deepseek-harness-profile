# Integrated plugins — the Plugins page, Browser tools, Office, OpenCode, OCR and Files

These are the feature rows this fork adds to the Plugins page, and the switches that turn each one off. The overview lives in the [README](../README.md); the tool-level contracts live in each plugin's own `README.md`.

## The top of the Plugins page — the integrated features + the market selector

Two groups render **above the "Official" group**, arranged the way DSH Desktop
arranges its own features there (`dsh-plugins-page-extras`):

```
Plugin market         Only one can be enabled at a time            (on)
  ┌ dsh-community-market  Beta ┐   ┌ dsh-market ┐
  └───────────────────────────┘   └────────────┘
  Browser tools                                                      (on)
  Browser tools brave                                                (on)
  Browser Use                                  [Open panel]          (on)
Official 8
```

* **Plugin market** — a master switch plus one card per market, only one of which
  can be on at a time; mirrors Desktop's `MARKET_OPTIONS` and links the same
  repositories. `dsh-market` (npm `dshmarket`) is fully wired — the card installs
  it into the profile (pnpm) and enables it. `dsh-community-market` is listed with
  its Desktop provenance, but its card explains rather than pretends: npm carries
  only a 719-byte reserved-name stub, the real package being a Desktop-only
  TypeScript workspace that is not published.
* **Browser tools / Browser tools brave / Browser Use** — one row per feature, no
  group heading (Desktop has none above its own rows), each with the 48px icon
  tile, title, description and switch of the page's own official cards. They are
  three rows and not one because they cost three different things: the Playwright
  tools (24 definitions), the Brave DevTools tools (30) and the `browser_open`
  hand-off (one tool + a prompt section). The **Open panel** button belongs to the
  desktop row. Every switch writes the same state the page's own cards would,
  because both go through the plugin manager.

The upstream page offers **no extension point above its groups** (you can only
contribute a card INTO "Official"), so `tools/patch-plugin-manager-page.mjs` adds
the `plugins.page.top` slot to `@deepseek-ai/dsh-client-ui-plugin-manager` at image
build time — content-anchored, idempotent, and it **fails the build** if upstream
moves either anchor. Desktop patches the same package for the same reason.

## Browser tools as a switchable plugin

The model-facing browser tools are **one plugin you switch on and off** — on the
**Plugins page**, next to the shipped plugins:

```
Plugins page → Browser tools → off      # server gone, tools gone, tokens gone
Plugins page → Browser tools → on       # 24 browser_* tools, attached to the visible Brave
```

| | |
|---|---|
| Bundle / package | `dsh-browser-mcp` (title "Browser tools") |
| Plugin row it mounts | `browser-mcp` → `@deepseek-ai/dsh-mcp-client` |
| Server name | `playwright-mcp` → tools `mcp__playwright-mcp__browser_*` |
| Attaches to | the visible Brave desktop, over CDP (`127.0.0.1:$DSH_CDP_PORT`) |
| Applies | at the next boot (bundle selection is read when the tree is composed) |

**Why this matters:** the tool definitions cost roughly 10k tokens of static
context in every Session, and they used to be unavoidable — a row mounted by a
launcher **overlay** is applied *after* the profile layer, so it re-declares itself
enabled and no switch can turn it off (measured: a profile-level `disabled: false`
override on an overlay row is ignored, `--dump-config` shows why). The row now
ships **inside a bundle**, which is the unit the Plugins page lists and toggles
(`listBundles()` builds that list from `dsh.profile.bundles` ∪ the profile's
dependencies ∪ the **installation's** dependencies, and gives every entry with a
`dsh.bundle.patch` a switch). Two further wins: **one** MCP process for the whole
harness instead of one per activated Session (~110-130 MB each), and no need for
the exclusivity patch below — a plain MCP client has no single-owner attach mode.

The bundle is selected for the active profile **once per home** by the entrypoint
(marker `.browser-mcp-bundle-seeded`), so switching it off is a decision the image
never overrides. `DSH_BROWSER_MCP=0` skips the selection entirely — the plugin
then shows up as *available* (off) rather than selected. A profile patch that
still carries the row an earlier image spliced in is migrated away automatically
(exact text match, validated with the launcher's own YAML parser before writing).

The official provider is still in the image and still one flag away
(`DSH_BROWSER_USE_PROVIDER=1`), for anyone who wants per-Session tools.

## Browser troubleshooting as a switchable plugin

Driving a page and **diagnosing** one are different jobs, so they are different
rows with different switches. The second one is `dsh-brave-devtools-mcp`, titled
**Browser tools brave** on the Plugins page, sitting between the other two:

```
Plugins page → Browser tools brave → off   # 30 DevTools tools gone, server gone
Plugins page → Browser tools brave → on    # console, network, CSS, perf, Lighthouse, heap
```

| | |
|---|---|
| Bundle / package | `dsh-brave-devtools-mcp` (title "Browser tools brave") |
| Plugin row it mounts | `brave-devtools-mcp` → `@deepseek-ai/dsh-mcp-client` |
| Server name | `brave-devtools` → tools `mcp__brave-devtools__*` |
| Server behind them | [`brave-mcp`](https://github.com/triuzzi/brave-devtools-mcp) — Brave-native, full Chrome DevTools MCP parity, pinned in the image |
| Attaches to | the same visible Brave desktop, over **loopback** CDP (`127.0.0.1:$DSH_CDP_PORT`) |
| Switch | **Plugins page → Browser tools brave → off/on** (live, no restart) |

**Why it is worth 30 more tool definitions.** The Playwright row can navigate and
click; it cannot tell you *why* the result was wrong. This one reads the console
(with source-mapped stacks), lists every request with its status and body, matches
CSS rules and reports which one won the cascade, records a performance trace with
insight sets, runs Lighthouse, and snapshots the heap. On a self-hosted stack
behind a reverse proxy that is the difference between "the page looks broken" and
"`/dsh-market/api/v1/updates` returned 502 because the upstream socket was reset".

**Why "attach", and why loopback.** The row starts the server with
`--browserUrl=http://127.0.0.1:$DSH_CDP_PORT`, i.e. against the browser this
container already runs. `start_desktop` launches Brave with
`--remote-debugging-address=127.0.0.1 --remote-debugging-port=$DSH_CDP_PORT`, so
**CDP is on by default and bound to loopback**: the MCP can only reach a browser
inside this container, nothing on the LAN can attach to it, no second browser is
launched or downloaded, and the model shares your tabs, cookies and logins — you
will see what it is doing in the noVNC panel. Both MCP rows attach to that same
browser; Chrome accepts several CDP clients, and the two switches stay
independent. If two sessions ever visibly fight over the active tab, turn one of
the two rows off.

**It is a pinned copy, not `npx`.** `/usr/local/bin/dsh-brave-devtools-mcp` execs
the `brave-mcp` installed at build time (`BRAVE_MCP_VERSION`), so a boot cannot
depend on the npm registry and `@latest` cannot move the tool surface under you.
The privacy defaults are explicit: no usage statistics, no npm update check, and
`--no-performance-crux` keeps a trace URL from being offered to Google's CrUX API
(the lab trace, which is the part that finds your bug, is unaffected).

**Selection, again, is once per home** (marker `.brave-devtools-bundle-seeded`),
so switching it off is a decision the image never overrides;
`DSH_BRAVE_DEVTOOLS_MCP=0` skips the selection entirely.

### One browser, every Session (provider path — this fork patches upstream)

*Applies to the official provider, which is opt-in (`DSH_BROWSER_USE_PROVIDER=1`).
The default MCP row has no exclusive attach mode at all, so this limitation simply
does not exist on that path.*

Upstream's attach mode reserves the attached browser for **one** live Session:
`exclusive: config.mode === "attach"`. Its own runtime README calls this out under
*Known Limitations* — *“a busy attachment skips startup permanently for that live
activation”* and *“releasing the attachment does not retry skipped activations”*.
In a container that boots with sessions already open, the winner of that race is
whichever activation happens first, which is frequently **not** the session you are
looking at; every other session then shows no browser tools at all, silently and
permanently, and closing the “owner” does not bring them back.

This image patches that expression off (see `tools/patch-browser-use-exclusivity.mjs`
and the Dockerfile step that applies it), so **every** Session gets its own MCP client
attached to the same browser. The patch is content-anchored and idempotent, and it
**fails the build** if upstream changes that line — an upstream refactor must never
silently restore the behaviour this fork removed.

The trade-off is explicit: there is one browser, so **cookies, logins, tabs and
installed extensions are shared between Sessions**, and two Sessions driving it at the
same time compete for the active tab. That is inherent to “one visible browser with
your logins” — it was already true before the patch, when it simply travelled with
ownership. Set `DSH_BROWSER_USE_EXCLUSIVE=1` to get upstream's single-owner semantics
back (useful if you want a strict one-session-at-a-time browser).

Compose already sets `shm_size: "1g"` for renderer shared memory. If you run the image
with plain `docker run`, add `--shm-size=1g` — the entrypoint detects a small `/dev/shm`
and falls back to `--disable-dev-shm-usage` automatically, but the properly sized path
is faster.

## Office documents — Word, PowerPoint, Excel and PDF, as one switchable card

DeepSeek Harness **already ships** the Office feature; a plain container mounts none of
it. This image mounts it, supplies the interpreter it expects, and puts a switch on it:

```
Plugins page → Office documents → on    # the harness's Office skills + pdf-documents
Plugins page → Office documents → off   # the skills released from every request
```

| | |
|---|---|
| Bundle / package | `dsh-office` (`plugins/dsh-office`) |
| Rows it mounts | `skill-office` → `@deepseek-ai/dsh-skill-office` · `workspace-dependencies` → `@deepseek-ai/dsh-tool-workspace-dependencies` |
| Skills | the release's Office skills — `office` alone from 0.2.3; split skills plus `office` through 0.2.2 — + `pdf-documents` (this image) |
| Interpreter | `/opt/dsh-office/primary-runtime` — Python 3.12.14, 15 distributions, ~282 MiB |
| Engine | `@deepseek-ai/libreoffice-kit` — LibreOffice, prebuilt, WebAssembly backend on Linux |
| Switches | `DSH_OFFICE=0` · `DSH_OFFICE_RUNTIME=<dir>` |
| Selection | once per home (marker `.office-bundle-seeded`) |

**Nothing here is a third-party plugin and nothing installs at runtime.** The skills and
the engine are ordinary dependencies of the DSH release already in the image; what the
image adds is the payload those skills are instructed to use — `python-docx`,
`python-pptx`, `openpyxl`, `XlsxWriter`, `Pillow`, `lxml`, `numpy`, `pandas`, and two
wheels this repo adds on purpose: `pypdf` and `PyMuPDF`.

`docker/office-runtime.lock.json` is the upstream
`scripts/primary-runtime/lock.json` for the shipped release, pinned by SHA-256
everywhere. `tools/build-office-payload.mjs` downloads, verifies and unpacks it at build
time (no repository checkout needed, no compiler on the build host); `tools/check-office.mjs`
then **executes** the result — imports all ten libraries, writes a `.docx` with the
payload's own interpreter, validates the skill bodies the release ships against the
provider's own frontmatter rules, converts that document to a real PDF and renders a page
to a real PNG with the real engine, and reads the four declarations that put the card on
the Plugins page.

What the model can do, and what proves it works:

| Capability | How |
|---|---|
| Create, read and edit `.docx` / `.pptx` / `.xlsx` | the bundled office skill(s) on the payload's libraries |
| Look at a page, slide or worksheet range | the engine renders it to PNG; the core `read_image` tool hands it to the model |
| Extract embedded pictures | `word/media/`, `ppt/media/`, `xl/media/` from the package, or PyMuPDF inside a PDF |
| Convert to PDF | `convert` — real PDF 1.7 (measured: a one-page document in ~3.2 s) |
| Recalculate a workbook | `recalculate`, formulas preserved |
| Read a PDF's text, images and pages | `pypdf` + `PyMuPDF` + the engine's PDFium render path |
| Check before delivering | the skills' own Python validation — re-open the package with python-docx / openpyxl, render a page to catch overflow (`check_office.py` was removed upstream in 0.2.1-rc.2) |

And for the PDF that has **no text to read at all** — a scan, a photographed form, a
deck exported as pictures — the image carries a real OCR layer (`ocr-pdf`, tesseract 5):
it writes the recognised words back as an *invisible* text layer, so Ctrl-F and
`extract_text` work on the result while the pages stay pixel-for-pixel what they were.
`--verify` re-reads the output and measures that the layer sits on the glyphs, instead
of asserting it. See [OCR for image-only PDFs](#ocr-for-image-only-pdfs--when-the-text-is-only-pixels).

**What it is not:** the engine is LibreOffice, so pagination can differ from Word —
previews are layout QA, not proof of print. A render is bounded to 100 pages and 16.7M
pixels, and the engine is not resident (each operation starts it for ~2-3 s). PDF has no
reflow: read, split, merge, rotate, stamp, render, or regenerate from the Office source.
Missing fonts are reported (`missingFonts`), never silently substituted. Full detail and
provenance: `plugins/dsh-office/README.md`.

### Native LibreOffice beside the card — the compatibility exit

The card's engine is LibreOffice-for-WASM: bounded (100 pages, 16.7M pixels, not
resident). The image ALSO carries the real `soffice --headless` — Writer, Calc, Impress
and Draw with the full import/export filters (`--no-install-recommends`, so no Java and
no desktop menus) — plus `python-docx` and `openpyxl` bound to the system `python3`, so
document code works in ANY shell even before the payload is found:

```
office-convert pdf report.odt           # whole-document compatibility swap, output beside the input
office-convert docx report/*.doc        # swap legacy binary formats to OOXML
office-swap-pages scan.pdf out.pdf 1,4,3,2   # rebuild a PDF with pages swapped/reordered (pixels byte-identical)
office-swap-pages deck.pdf full.pdf 1-5,6:180 # ...and rotated, the same pypdf path ocr-pdf trusts
python3 -c "import docx, openpyxl"      # the system interpreter is ready too
```

PowerPoint authoring has no Debian package, so it stays on the SHA-256-pinned payload
interpreter (`/opt/dsh-office/primary-runtime`, full set: python-pptx, XlsxWriter,
Pillow, pypdf, PyMuPDF…). This native layer ships WITHOUT a build-time gate on
purpose: the apt resolution is the proof, and the wrappers are plain `sh` over
`soffice --convert-to`.

## OpenCode's free models — the CLI is in the image, the plugin is yours

The image ships a working **OpenCode CLI** at `/usr/local/bin/opencode`, and
**deliberately does not bundle** the plugin that drives it.

```
Plugins page → install dsh-opencode-connect        # a fresh install: one card, under Installed
docker exec seek-harness dsh plugin install dsh-opencode-connect   # or from the CLI
```

[`dsh-opencode-connect`](https://github.com/sanser9/dsh-opencode-connect) registers the
`opencode` model provider, so OpenCode's free models show up in the DSH model picker with
no API key and no cost. Once installed it walks this list for its binary — nothing has to
be configured, the third entry is the image's:

```
~/.local/share/dsh-opencode-connect/bin/opencode
~/.local/bin/opencode
/usr/local/bin/opencode                # <- the copy this image ships
opencode on $PATH
```

| | |
|---|---|
| Binary | `/usr/local/bin/opencode` — the official release tarball (no npm, no postinstall, no download at runtime) |
| Version | `OPENCODE_VERSION=latest` → the newest **v1** tag, resolved at **build** time |
| Why v1 only | the plugin speaks the v1 API paths (`/session`, `/config/providers`, `/event`); OpenCode 2 moved them under `/api/...`, so `latest` skips every v2 tag, pre-releases included |
| Pin it | `OPENCODE_VERSION=1.19.6` (`docker build --build-arg OPENCODE_VERSION=1.19.6 .`) |
| Build toggle | uncheck `opencode` in the workflow trigger, or `OPENCODE_VERSION=0` as a build-arg — the build skips the CLI install entirely (exit 0, one logged line, no `/usr/local/bin/opencode`) |
| Floor | the build refuses anything below **1.18.0** (the plugin's free-tier minimum) and refuses a 2.x pin |
| Plugin | **not in this image** — no bundle, no seed step, no card; installing it is the user's step |

Not bundling it is deliberate: it is a third-party bundle with its own release cadence,
and the one thing it needs that a user cannot add later without root is a CLI it can find
and drive — which is what the image supplies. The plugin spawns `opencode serve --port
40961` itself on loopback (never published), and talks to it over HTTP.

The build gate is offline and hard: `node tools/check-opencode-cli.mjs --check` extracts the
Dockerfile's own resolution fragment and runs it under `sh` with a stub `curl`, against a
fixture that puts two v2 tags above the v1 one — proving the pick, the skipped-tag log, both
refusals (2.x pin, below floor) and both offline failures (API down, no v1 tag).

**There is no agent bridge — only this CLI.** It exists for the one job above: it is the
prerequisite the optional `dsh-opencode-connect` model bridge spawns, and nothing more. A
free model served through a foreign harness **cannot drive DSH's tools**: OpenCode's agency
is its server-side instruction stack and tool loop, not the weights, so a DSH-side adapter
gets a chat endpoint that talks about file access instead of making the call. The "why" —
what a real bridge would have to re-implement, and why it was dropped — was researched in a
local note, `research/opencode-agent-bridge-brief.md` (§2 the mechanism, §6 the feasibility
verdict). That file is **not in this tree**: `research/` is gitignored on purpose
(`.gitignore`), so no clone carries it — treat the note as local-only working evidence, not
something a reader of this README can open, and re-run the research if you need it. The
conclusion is what matters here and it does not depend on the file: the decision is closed,
not deferred to a document.

**If you ever remove it.** Two rungs, and the first one needs no edit:

* **For one build** — uncheck `opencode` in the manual workflow trigger (the input sends
  `OPENCODE_VERSION=0`), or pass `--build-arg OPENCODE_VERSION=0` yourself. `0` is an OFF
  sentinel, not a version: the `RUN` prints one line and exits 0 before it touches the
  network, and the image simply has no `/usr/local/bin/opencode`.
* **Permanently** — delete, in this order: the `ARG OPENCODE_VERSION` line plus the whole
  opencode `RUN` block in the `Dockerfile`; the `opencode` input and the
  `OPENCODE_VERSION=…` build-arg lines in `.github/workflows/docker-build.yml` and
  `.github/workflows/prebuild-gates.yml`; the `check-opencode-cli.mjs` row from
  `REPO_GATES` in `tools/ci-gates.mjs`; the tool file `tools/check-opencode-cli.mjs`; the
  import block and every `OPENCODE-CLI-*` check in `tests/modules-unit.mjs`; the
  `OPENCODE_VERSION` entry in `.env.example`; and this README section.

What stays: nothing outside the image. `/usr/local/bin/opencode` is a file in an image
layer — no volume holds it, no entrypoint seeds it, no `~/.config` copy is made — so an image
rebuilt without it has no opencode anywhere and a container recreated from that image loses
nothing else. If `dsh-opencode-connect` was installed through the plugin manager, remove it
from the Plugins page too: it lives in the DSH profile, not the image, and because it only
ever required the binary it uninstalls cleanly ("opencode not found", never a wedged provider).

## OCR for image-only PDFs — when the text is only pixels

The Office card above reads a PDF's text layer. This is what handles the PDF that has
none: a scan, a phone photo of a form, a deck whose words were exported as pictures.

```sh
ocr-pdf --input scan.pdf --output scan-searchable.pdf
ocr-pdf --input deck.pdf --output deck-searchable.pdf --verify --json report.json
ocr-pdf --input book.pdf --output part.pdf --pages 1-40 --dpi 300 --text-dump part.md
ocr-tools --check          # re-prove the stack in a running container (exit 1 = broken)
```

| | |
|---|---|
| Engine | tesseract 5 (LSTM) with the `tessdata_best` weights, plus `tesseract-ocr-osd` for `--rotate-pages` |
| Driver | `tools/ocr-pdf.py` → `/usr/local/bin/ocr-pdf`, on the Office payload interpreter |
| What it writes | an *invisible* text layer (PDF text render mode 3) over the page's own content |
| What it never does | re-encode, re-sample or redraw the page image — the pixels are byte-identical afterwards |
| Guide | `/opt/ocr-tools/README.md` (also `docker/ocr-pdf.md`) |
| Gate | `tools/check-ocr-toolchain.mjs` — renders a page whose text it knows, OCRs it through the real driver, and requires the words back out of the RESULT |

**One engine, on purpose.** tesseract is the fast, folder-clean option: one process per
page, no model session, no runtime download, no Python wheels. The heavier alternatives
(RapidOCR/PP-OCRv4 ONNX, EasyOCR, PaddleOCR) each add hundreds of MB of runtime and burn
CPU on every run for a second opinion this image does not need, so they are not
installed and the driver has no flag that pretends otherwise.

`--verify` is the part that makes the output trustworthy. Writing a text layer is easy;
writing it *in the right place* is the whole problem, and a layer off by a few percent
is invisible until someone selects a line and gets the line below it. So the driver
re-opens the result, crops the **output page** at each sampled word's own declared
rectangle, and OCRs that crop alone: the crop contains one word's pixels only if the
layer really is where it says it is. The report carries `matched`/`checked` per page and
prints the mismatches verbatim, so a systematic offset reads as a pattern rather than as
noise. The gate applies the same discipline at build time and also asserts the page's
rendered pixels are **unchanged** by the pass.

**What it is not:** OCR does not improve the picture. A scan unreadable to a human
produces confident nonsense, and `--verify` is how that is discovered rather than
promised over. It does not do handwriting reliably, and it does not make a scan reflow —
PDF has no reflow. For layout questions, render the page and look at it; use OCR for
"find the word" and a render for "what does the page look like".

## Workspace file manager — the "Files" entry in the sidebar footer

The image also carries **`dsh-workspace-browser`**, a file manager for `/workspace`
that the Harness Web UI does not otherwise have. DSH's built-in file sidebar is
read-oriented (tree, previews, open-in-local-app, diff review of Agent changes); this
adds the write half:

| In the panel | Detail |
|---|---|
| Navigate | Directory listing with breadcrumbs, size and modification time |
| Preview | Bounded text preview, 512 KiB by default |
| Edit | In-UI text editing with `Ctrl`/`Cmd`+`S`, and an mtime precondition so a save refuses to silently overwrite an outside change |
| Create / rename / delete | Files and directories; deleting a non-empty directory asks first and is explicit about being recursive |

**It writes, so read this before enabling it.** Every path is resolved under the
configured root with `realpath` checks; `..` traversal and symlinks escaping the root
are rejected, symlinks cannot be mutated, mutations must be same-origin JSON, and
single writes are capped. But above that, the only boundary is who can reach the UI:
anyone who can open the Harness can create, edit, rename and recursively delete inside
`/workspace`. Keep it behind Pangolin/Badger, Basic Auth, or a trusted network, and
mount only the directory you are willing to expose. `DSH_WORKSPACE_BROWSER_ENABLED=0`
removes it entirely.

| Variable | Default | Meaning |
|---|---|---|
| `DSH_WORKSPACE_BROWSER_ENABLED` | `1` | `0` = no file manager row at boot |
| `DSH_WORKSPACE_ROOT` | `/workspace` | The only directory it can touch |
| `DSH_WORKSPACE_MAX_ENTRIES` | `2000` | Directory listing cap |
| `DSH_WORKSPACE_MAX_PREVIEW_BYTES` | `524288` | Text preview cap |
| `DSH_WORKSPACE_MAX_WRITE_BYTES` | `1048576` | Single write cap |

Vendored from runzhliu's **unmerged** `feat/workspace-browser-crud` branch (the package
is not on npm) and ported from the 0.1.0-rc.6 client runtime to `dsh-client-modules` for
DSH 0.2.0 — see [`plugins/dsh-workspace-browser/README.md`](../plugins/dsh-workspace-browser/README.md).
Its own suite covers the host logic and runs in the image:
`docker exec <container> node --test /opt/dsh/node_modules/dsh-workspace-browser/workspace.test.js`.
