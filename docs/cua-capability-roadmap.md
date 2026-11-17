# CUA capability roadmap — what is deferred, and what it would take

This file records the capabilities the personal-VM feature **deliberately does not
have yet**, so the next round starts from a design instead of a bug report. Each
item states the current state, the gap, a design sketch, the prerequisites that
make it possible, and the acceptance criteria that would let a reviewer say
"done" without reading the implementation.

Nothing here is a promise about a release. The rule for every entry is the same
one the shipped code follows: **do not claim a capability the evidence does not
support** — a refusal that names the obstacle is better than a path that
half-works.

---

## 1. Per-window capture

**Current state.** A frame is the whole desktop. Linux goes through
`cua sb screenshot`; Windows goes through QMP `screendump`. Every frame is named
by a `captureId` (`<name>:<epochMs>:<sha1(png)[:8]>`), and the coordinate space is
MEASURED from the PNG (`screenshot WxH · display WxH · scale N`). The panel and
the model can crop after the fact with `region` (`cua_vm_gui` `zoom` /
`region {x,y,width,height,scale}`), which is a crop of an already-captured frame.

**Gap.** There is no "capture THIS window": no window enumeration, so a crop is
guessed from pixels rather than derived from geometry; on Windows there is no
window list at all (no accessibility tree on the QMP path). A crop also does not
move the capture space, so a click computed from a zoomed image still has to be
translated back by hand.

**Design sketch.** Ask the guest for geometry, then crop server-side:

* Linux: `xdotool search --name` / AT-SPI bounds → a rectangle in display pixels,
  then `cua sb screenshot` + a PNG crop in the supervisor;
* Windows: a small Win32 helper in the guest (`GetForegroundWindow` +
  `GetWindowRect` over the existing SSH channel) → the same rectangle → QMP
  `screendump` + crop;
* the answer carries a NEW `captureId` for the crop and a `space` line whose
  display size is the CROP's, so "click what you see" stays true.

**Prerequisites.** A geometry source on both platforms; a PNG crop that does not
resample (integer pixels only); the capture id must be the crop's, not the
frame's, or a stale-capture refusal will be wrong.

**Acceptance criteria.** `cua_vm_gui {action:"screenshot", window:"Notepad"}`
returns a PNG whose dimensions equal the window's client rect; the same call
twice with the window moved produces two different `captureId`s; a click at
`(10,10)` of that crop lands at `window.x+10, window.y+10` in display pixels
(asserted with a fixture window at a known offset), and a click citing the
previous crop is refused with `code: stale-capture`.

---

## 2. Background AT-SPI / UIA invoke (act without focus)

**Current state.** Element actions run in the guest through `dsh-cua`
(pywinauto) over one SSH session; `tool_click_at` and `tool_invoke` act on the
focused desktop, and the Linux path goes through `cua`'s agent. Verification is a
read-back (window title, element list, pointer, frame change), not a claim of
success.

**Gap.** Every action needs the desktop to be visible and focused: an occluded or
minimised window cannot be driven, and a click can be stolen by whatever is on
top. There is no queue that invokes a control's pattern directly, so a background
job cannot use the computer while a human does.

**Design sketch.** Use the accessibility layer's own actions instead of synthetic
input: pywinauto `InvokePattern`/`ValuePattern` on Windows, AT-SPI `do_action` on
Linux, exposed as `tool_invoke {background: true}`. The reply carries the same
`effect`/`verified` shape, so a background invoke and a synthesized click are
comparable. On Windows this needs a listener in the INTERACTIVE session (a click
in Session 0 goes nowhere).

**Prerequisites.** A long-lived in-session service (the pipe server the clipboard
agent's firstboot task already gestures at) so a call can reach session 2 without
starting a process per invocation; an action allow-list (Invoke/Value only — never
`SetFocus`); a per-window lock so two background jobs do not race one control.

**Acceptance criteria.** With Notepad minimised behind another window, `find_elements`
returns its controls and `tool_invoke` changes the document text; a foreground
click during the same interval does not disturb it; the answer reports
`effect.source: "uia"` (not `"pointer"`), and a control with no InvokePattern is
refused by name instead of being clicked.

---

## 3. Rich clipboard (HTML, RTF, files, images)

**Current state.** The clipboard moves **text only**, both directions, capped at
1 MiB for the `schtasks` path and at `1 MiB − 2048` bytes for the agent's JOB file
(the wrapper allowance is checked before any round trip, so a legal text never
costs an upload the guest will refuse). Encoding is reversible: latin1 when every
code point fits in a byte, UTF-8 otherwise, with the RFB length header counting
bytes. The agent path is verified end to end (seq is a `[long]` `Date.now()`
stamp, SHA-256, `equal`, and a read-back hash re-read up to three times because
the copy is written after the ack); an agent that reports its own failure is
`agent-error:<code>`, not a digest mismatch. A U+0000 truncates the Windows
clipboard, so that paste is `verified: false` with `nulTruncated {landed,total}`.
The files are per-session (`clip-*-<session>.*` plus the canonical copies written
by the same owner), so two logons cannot serve each other's payload.
`DSH_CUA_CLIP_AGENT=0` (now live: the backend stages the
`clip-agent-disabled` sentinel on the answer medium and in `$OEM$/$$/Setup/Scripts`,
firstboot copies it to `C:\ProgramData\cua` and both consumers honour it),
`DSH_CUA_VNC_CLIP=0` and
`DSH_CUA_WIN_ISO_SHA256=0` are the live switches — each is documented with its
exact contract in the README.

**Gap.** A browser copy is HTML plus a plain-text fallback; a Word copy is RTF;
Explorer copies a file LIST; an image is `CF_DIB`/PNG. All of those arrive as
"nothing" today, and the 1 MiB cap makes even large text a `cua_vm_put` job.

**Design sketch.** Make the job a MIME bundle instead of a string:
`{ seq, mime: "text/plain" | "text/html" | "text/rtf" | "image/png" | "files", sha256, data }`,
with binary payloads base64 in the outbox JSON (or a sibling file for anything
over a few hundred KiB, since the JSON is written over SSH). The agent uses
`Set-Clipboard -AsHtml`, `[Windows.Forms.Clipboard]::SetImage`, and a
`FileDrop` list; the get direction enumerates `Clipboard.GetDataObject().GetFormats()`
and returns the richest format it has, plus the plain-text fallback. The panel
renders the richest format it understands and always offers the text.

**Prerequisites.** A size budget (the 1 MiB cap has to move, or large payloads go
through `put`/`get`); a MIME allow-list to avoid handing an arbitrary object to
the UI; RFB can only carry text, so the console path stays text-only by design and
the panel is the authoritative surface for rich formats.

**Acceptance criteria.** Copying a table from a browser and pasting into the guest
lands formatted HTML; copying an image in Paint and calling `windowsClipboardGet`
returns a PNG artefact whose bytes hash to the ack's digest; copying 40 files in
Explorer returns the list (not a concatenated string); a payload over the budget
is refused with a sentence that names `cua_vm_put`.

---

## 4. ESD catalog parsing without an external extractor

**Current state.** The `esd` strategy resolves `go.microsoft.com/fwlink` to a
`catalog.cab` and parses `products.xml` from it — but ONLY when `7z`, `7za` or
`cabextract` is already in `PATH`. Otherwise the entry reports
`skipped: no cab extractor` and the chain continues. `cabExtractor()` is a pure
`PATH` walk; nothing is installed at runtime.

**Gap.** On a host without one of those binaries the strategy is dead weight, and
the chain silently loses its "official Microsoft catalogue" step. The parsing that
follows the extraction is also regex-over-XML with a product-family filter, not a
real selection.

**Design sketch.** Either (a) a minimal MS-CAB reader in Node (the format is
documented: CFHEADER + CFFOLDER + CFDATA, MSZIP/LZX compression) used only for
this catalog, or (b) keep the external extractor but make the absence a WARNING on
the row instead of a silent skip, and expose `cabExtractor()` in the doctor so an
operator can see which strategy is unavailable and why. (a) is the real fix; (b)
is the honest stopgap.

**Prerequisites.** An inflate implementation already available in Node
(`zlib.inflateRaw` covers MSZIP; LZX would need a decoder); a size cap on the
catalog (64 MiB today) and a strict parse so a malformed CAB cannot become an
unbounded loop.

**Acceptance criteria.** With `PATH` stripped of every extractor, `resolveWindowsIsoSources('11')`
still returns an `esd` entry that is NOT `skipped`, and a fixture CAB parses to the
same product list a 7z run produces byte for byte; a truncated or hostile CAB is
refused with a named error and no partial extraction.

---

## 5. UEFI Class 2 / legacy beyond Windows 7

**Current state.** Two firmware profiles: `ovmf` (q35, UEFI, TPM2, virtio-blk,
virtio-net) and `seabios` (`pc`/i440FX, no pflash, no TPM, IDE disk, e1000e). The
media heuristic maps Vista/Server 2008 file names onto the same `seabios` profile
as `7u`. Windows 7 installs and boots on it; **Windows XP is listed and refused**
(`code: legacy-installer-unsupported`) because its Setup waits for a `winnt.sif`
this OEM payload does not build. `DSH_CUA_WIN_LEGACY_BIOS=0` refuses the BIOS path
outright.

**Gap.** No CSM (a UEFI machine that can also boot legacy option ROMs — QEMU's
newer builds dropped CSM entirely), no 32-bit UEFI, and no answer medium for the
`winnt.sif` generation. Anything older than 7 is therefore either mapped to the
7u profile (Vista) or refused (XP, 2000, 9x).

**Design sketch.** Add a `csm`/`legacy32` profile in the SAME table (machine,
pflash, TPM, disk, NIC are already data), plus a `winnt-sif` answer-medium
builder: a floppy image (`-drive if=floppy`) or an ISO root carrying
`winnt.sif` + `$OEM$`, with the product key and the network/auto-logon sections
that generation expects. The IMAGE would be a catalog row with
`bios: 'legacy32'`, so the refusal disappears only for codes that have a working
medium.

**Prerequisites.** A QEMU build that still offers CSM, or an acceptance that these
are SeaBIOS-only; a floppy-capable answer medium (QEMU supports `if=floppy`, but
the guest must find it — 9x and NT5 differ); a Windows XP/2000 ISO whose licence
the operator supplies (the mirrors pin bytes, not entitlement).

**Acceptance criteria.** A `windowsVersion: "xp"` create completes an unattended
install on the legacy profile with OpenSSH reachable, and the refusal is deleted
from the catalog only in the same commit that adds the acceptance case. Until
then the refusal stays, and it names `windowsIso` as the operator escape hatch.

---

## 6. Guest → host image clipboard

**Current state.** Text only, both directions. On the host side the RFB bridge
wraps text in `ServerCutText`/`ClientCutText`; RFB has no image-star clipboard
message at all, so the console path cannot carry one.

**Gap.** "Copy this chart from Excel and paste it into the harness" does not work:
the image never leaves the guest, and the panel has nothing to render.

**Design sketch.** A panel-only path (the console cannot do it): the agent writes
`clip-current.png` next to `clip-current.txt` when the clipboard's `CF_DIB`/
`PNG` format is present, and a small index file names the format, the size and the
SHA-256. `windowsClipboardGet` grows `format: "png"` and returns an artifact
reference (the panel streams it from the same route), never an inline base64 blob
in a tool answer (that is tokens nobody asked for). The reverse direction accepts
a workspace PNG path or a small base64 payload and sets it with
`[Windows.Forms.Clipboard]::SetImage`.

**Prerequisites.** A binary transport (`cua_vm_get` already copies files, so the
agent writing a file is enough); a size cap and a PNG validation on the host
(reject anything that is not a PNG, and anything over the budget); the panel needs
an image renderer for the Clipboard section.

**Acceptance criteria.** Copying an image in the guest makes `windowsClipboardGet`
answer `format: "png"` with a digest that matches the file, and the panel shows a
thumbnail; a non-PNG payload is refused by name; the tool answer stays under a
stated byte budget (the image is fetched, not inlined).

---

## 7. OCR, and "verified" OCR

**Current state.** Click/type verification is behavioural: the pointer, the window
title, an element read-back from the accessibility layer, or a frame change
(`effect.before`/`after`, `verified: confirmed | unverifiable`). A frame that
changed is not a frame that changed CORRECTLY. The image's `ocr-pdf.py` /
`ocr-toolchain.sh` OCR **documents** (scanned PDFs), not the VM's screen, and the
guest has no OCR of its own.

**Gap.** "Type the invoice number and check it appeared" cannot be verified when
the app exposes no accessibility text — which is the normal case for a canvas, a
Java app, or a remote desktop inside the guest. The model falls back to looking at
a PNG, which is exactly the cost the element tools exist to avoid.

**Design sketch.** Two levels, both explicit about what they prove:

1. **OCR text**: run `tesseract` in the guest (Linux) or the Windows OCR engine via
   the agent, over the cropped region of interest, and return `{ text, boxes,
   confidence }`. `effect.kind: "ocr"`, `verified: "confirmed"` only when the
   expected string is found inside the expected box.
2. **Verified OCR**: require the SAME text to appear in TWO frames (or in the
   accessibility tree AND the frame) before claiming confirmation — a single
   reading can be a stale frame, a spinner, or a watermark.

**Prerequisites.** An OCR binary in the guest image (tesseract + `eng` traineddata
is ~20 MB, and pinning it is a licensing/size decision); a fixture corpus of
screenshots with known text for the precision/recall numbers; a latency budget
(OCR is 100-400 ms per region, so it must be opt-in, never on every action).

**Acceptance criteria.** On the fixture corpus, a region OCR returns the expected
string with ≥ 95 % precision and a per-region latency under 500 ms; an action
asserted with `expect: { text: "Saved" }` reports `verified: "confirmed"` only
when the text is present, and `unverifiable` (never `confirmed`) when the frame
did not change; the OCR path is OFF unless asked for, and its absence degrades to
the current `unverifiable` rather than failing the action.
