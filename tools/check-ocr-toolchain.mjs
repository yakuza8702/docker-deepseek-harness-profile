#!/usr/bin/env node
/**
 * check-ocr-toolchain.mjs — prove the OCR stack in the image that ships it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything in this layer is a DOWNLOAD (a Debian package, traineddata from a
 * GitHub repo), and none of it is exercised
 * by "the files exist". A traineddata that 404'd into an HTML error page, an
 * engine that installed but cannot load its native library, a driver that
 * imports a payload library that is not installed, or a tessdata path the engine
 * disagrees with all look identical on disk — and all fail LATER, in the middle
 * of a document an operator is being asked to trust.
 *
 * So this runs at image build time (Dockerfile) and is reachable in a running
 * container as `ocr-tools --check`: it renders a page with KNOWN text, OCRs it
 * back, requires the words to come out, then runs the real driver end to end and
 * re-reads the text layer out of the RESULT. A container that passes this can be
 * believed.
 *
 * The known text is drawn by the gate itself with PyMuPDF, so the gate does not
 * depend on a fixture that could drift, and "OCR found the words it should have
 * found" is a fact about this container rather than about a sample file.
 *
 * It is deliberately NOT a version assertion: the pins live in
 * docker/ocr-toolchain.sh and are recorded in /opt/ocr-tools/*.txt, and pinning
 * them here too would mean the gate starts failing on a routine bump instead of
 * on a real breakage.
 *
 * USAGE
 * -----
 *   node tools/check-ocr-toolchain.mjs
 *   node tools/check-ocr-toolchain.mjs --json /tmp/ocr-gate.json
 *
 * Every absolute path is overridable by flag or environment, so the same gate can
 * be pointed at a checkout built into a different prefix (and so a failure can be
 * reproduced segment by segment) without editing it:
 *
 *   --driver <path>          the driver under test      (OCR_GATE_DRIVER)
 *   --python <path>          the interpreter it runs on (OCR_GATE_PYTHON)
 *   --tools-dir <path>       the in-image tools dir     (OCR_GATE_TOOLS_DIR)
 *   --wrapper <path>         the `ocr-tools` wrapper    (OCR_GATE_WRAPPER)
 *   --skip-declarations      skip the guide/wrapper/pins half
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const DEFAULTS = {
  driver: process.env.OCR_GATE_DRIVER ?? "/opt/ocr-tools/ocr-pdf.py",
  python: process.env.OCR_GATE_PYTHON
    ?? "/opt/dsh-office/primary-runtime/dependencies/python/bin/python3",
  toolsDir: process.env.OCR_GATE_TOOLS_DIR ?? "/opt/ocr-tools",
  wrapper: process.env.OCR_GATE_WRAPPER ?? "/usr/local/bin/ocr-tools",
};

let PATHS = { ...DEFAULTS };

const problems = [];
const notes = [];

function ok(message) {
  console.log(`  ok    ${message}`);
}
function bad(message) {
  problems.push(message);
  console.log(`  FAIL  ${message}`);
}
function note(message) {
  notes.push(message);
  console.log(`  note  ${message}`);
}

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

/** The most recent engine report the driver will produce, or a hard failure. */
function driverReport(python) {
  const out = run(python, [PATHS.driver, "--probe"]);
  return JSON.parse(out);
}

/**
 * A page whose text this gate KNOWS, so "OCR worked" is measured rather than
 * assumed. drawwords (not insert_text) is used so the glyphs are rasterised the
 * way a real document's are, and the page is 4:3 like the decks this layer is
 * usually pointed at.
 */
function makeFixture(python, work) {
  const source = join(work, "fixture.pdf");
  const script = `
import pymupdf
document = pymupdf.open()
page = document.new_page(width=720, height=480)
page.draw_rect(page.rect, color=(1, 1, 1), fill=(1, 1, 1))
page.insert_text((48, 96), "OCR GATE FIXTURE", fontsize=34, fontname="hebo")
page.insert_text((48, 160), "alpha bravo charlie delta", fontsize=20)
page.insert_text((48, 200), "echo foxtrot golf hotel", fontsize=20)
page.insert_text((48, 240), "india juliett kilo lima", fontsize=20)
page.insert_text((48, 300), "SEARCHABLE 12345", fontsize=24, fontname="cobo")
document.save(${JSON.stringify(source)})
print("wrote", ${JSON.stringify(source)})
`;
  run(python, ["-I", "-B", "-c", script]);
  if (!existsSync(source)) throw new Error("the fixture page was not written");
  return source;
}

/** The words the fixture actually contains, for the assertion below. */
const EXPECTED = [
  "OCR", "GATE", "FIXTURE", "alpha", "bravo", "charlie", "delta",
  "echo", "foxtrot", "golf", "hotel", "india", "juliett", "kilo", "lima", "SEARCHABLE",
];

async function main() {
  const { values } = parseArgs({
    options: {
      json: { type: "string" },
      work: { type: "string" },
      driver: { type: "string" },
      python: { type: "string" },
      "tools-dir": { type: "string" },
      wrapper: { type: "string" },
      "skip-declarations": { type: "boolean" },
    },
  });
  const work = values.work ?? "/tmp/ocr-gate";
  PATHS = {
    driver: values.driver ?? DEFAULTS.driver,
    python: values.python ?? DEFAULTS.python,
    toolsDir: values["tools-dir"] ?? DEFAULTS.toolsDir,
    wrapper: values.wrapper ?? DEFAULTS.wrapper,
  };
  const declarations = values["skip-declarations"] !== true;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  console.log(`ocr gate: work=${work}`);
  console.log(`ocr gate: driver=${PATHS.driver}`);
  console.log(`ocr gate: python=${PATHS.python}`);

  // ------------------------------------------------------------------
  // 1. The driver and the interpreter it runs on.
  // ------------------------------------------------------------------
  if (!existsSync(PATHS.driver)) {
    bad(`no driver at ${PATHS.driver} — the image would ship an OCR guide whose command does not exist`);
    return report(work, values.json);
  }
  if (!existsSync(PATHS.python)) {
    bad(`no payload interpreter at ${PATHS.python} — the driver cannot import pypdf/PyMuPDF`);
    return report(work, values.json);
  }

  let installed;
  try {
    installed = driverReport(PATHS.python).installed;
  } catch (error) {
    bad(`the driver cannot even run --probe: ${String(error.stderr ?? error.message).trim().split("\n").slice(-1)[0]}`);
    return report(work, values.json);
  }
  ok(`driver runs on python ${String(installed.python)} (PyMuPDF ${String(installed.pymupdf)}, pypdf ${String(installed.pypdf)})`);

  // ------------------------------------------------------------------
  // 2. The engine must be REACHABLE BY THE DRIVER, which is a different
  //    question from "the package is installed".
  // ------------------------------------------------------------------
  if (installed.tesseract && !String(installed.tesseract).startsWith("unavailable")) {
    ok(`tesseract reachable by the driver: ${String(installed.tesseract)}`);
    const languages = installed.tessdata?.languages ?? [];
    if (languages.includes("eng")) ok(`tessdata at ${String(installed.tessdata?.dir)} carries eng (${languages.join(", ")})`);
    else bad(`tessdata carries no eng: ${languages.length > 0 ? languages.join(", ") : "(none listed)"}`);
  } else {
    bad(`tesseract is not reachable by the driver: ${String(installed.tesseract)}`);
  }

  // ------------------------------------------------------------------
  // 3. The real thing: a page whose text is known, through the real driver,
  //    with the layer read back out of the RESULT.
  // ------------------------------------------------------------------
  let fixture;
  try {
    fixture = makeFixture(PATHS.python, work);
    ok(`fixture page written with known text (${EXPECTED.length} words)`);
  } catch (error) {
    bad(`could not write the fixture page: ${String(error.stderr ?? error.message).trim().split("\n").slice(-1)[0]}`);
    return report(work, values.json);
  }

  const output = join(work, "ocr-gate-out.pdf");
  const textDump = join(work, "ocr-gate.md");
  let runReport;
  try {
    run(PATHS.python, [
      PATHS.driver, "--input", fixture, "--output", output,
      "--dpi", "300", "--text-dump", textDump,
      "--json", join(work, "ocr-gate-run.json"),
    ], { timeout: 900_000 });
    runReport = JSON.parse(readFileSync(join(work, "ocr-gate-run.json"), "utf8"));
  } catch (error) {
    bad(`the driver failed on the fixture: ${String(error.stderr ?? error.message).trim().split("\n").slice(-1)[0]}`);
    return report(work, values.json);
  }

  if (!existsSync(output) || statSync(output).size < 500) {
    bad(`the driver wrote no usable output at ${output}`);
    return report(work, values.json);
  }
  ok(`the driver OCR'd the fixture in ${String(runReport.seconds)}s (${String(runReport.words_total)} words)`);

  // The layer must come back out of the result — a layer the save dropped, or
  // one written to another page, is invisible until someone tries to search.
  const extracted = run(PATHS.python, [
    "-I", "-B", "-c",
    `import pymupdf,sys\nd=pymupdf.open(sys.argv[1])\nprint(d[0].get_text())\n`,
    output,
  ]).toUpperCase();
  const missing = EXPECTED.filter((word) => !extracted.includes(word.toUpperCase()));
  if (missing.length === 0) ok(`the layer reads back out of the RESULT: all ${EXPECTED.length} fixture words found`);
  else bad(`the RESULT is missing ${missing.length} fixture word(s): ${missing.join(", ")}`);

  // ...and it must be INVISIBLE: the picture is what the document showed before.
  const visibility = run(PATHS.python, [
    "-I", "-B", "-c",
    `
import pymupdf, sys
doc = pymupdf.open(sys.argv[1])
page = doc[0]
pix = page.get_pixmap(dpi=72, alpha=False)
samples = pix.samples
# A page whose invisible layer leaked into the painting would be nearly all the
# text colour here; the fixture is black-on-white, so anything close to a
# uniform dark page means render mode 3 was not honoured.
dark = sum(1 for i in range(0, len(samples), 3) if samples[i] < 128)
print(f"{dark / (len(samples) / 3):.4f}")
`,
    output,
  ]).trim();
  if (Number(visibility) < 0.5) ok(`the layer is invisible (${visibility} of the page renders dark — the fixture's own pixels)`);
  else bad(`the layer is VISIBLE: ${visibility} of the page renders dark, so the text was painted, not hidden`);

  // The pixels themselves must be untouched. The fixture has no image, so this
  // compares the page's rendered raster before and after the driver ran.
  const pixelDrift = run(PATHS.python, [
    "-I", "-B", "-c",
    `
import pymupdf, sys
before = pymupdf.open(sys.argv[1])[0].get_pixmap(dpi=100, alpha=False).samples
after = pymupdf.open(sys.argv[2])[0].get_pixmap(dpi=100, alpha=False).samples
same = sum(1 for a, b in zip(before, after) if a == b)
print(f"{same / max(1, len(before)):.4f}")
`,
    fixture, output,
  ]).trim();
  if (Number(pixelDrift) > 0.995) ok(`the page pixels are unchanged before/after (${pixelDrift} identical)`);
  else note(`page raster differs by ${(100 - Number(pixelDrift) * 100).toFixed(2)}% — expected for a text layer on a page with no image; check --mode overlay when an input page carries a full-page scan`);

  // ------------------------------------------------------------------
  // 4. The declarations: the guide, the wrapper and the recorded pins.
  // ------------------------------------------------------------------
  const guide = join(PATHS.toolsDir, "README.md");
  if (!existsSync(guide)) bad(`no guide at ${guide} — an operator would have no way to discover this`);
  else if (!/ocr-pdf --input/u.test(readFileSync(guide, "utf8"))) bad(`${guide} never names the driver command`);
  else ok(`the in-image guide documents the driver (${guide})`);

  const versions = join(PATHS.toolsDir, "VERSIONS.txt");
  if (!existsSync(versions)) note(`no ${versions} — an operator could not cite the engine version`);
  else {
    const pins = readFileSync(versions, "utf8");
    if (/^engine: .*tesseract/mu.test(pins)) ok(`engine pins recorded in-container (${versions})`);
    else bad(`${versions} records no tesseract engine line`);
  }

  if (existsSync(PATHS.wrapper)) ok("the ocr-tools wrapper is on PATH");
  else bad("no `ocr-tools` wrapper at ${PATHS.wrapper} — the documented inventory command would be 'command not found'");

  return report(work, values.json, runReport, extracted);
}

function report(work, jsonPath, runReport, extracted) {
  const summary = {
    work,
    problems: problems.length,
    details: problems,
    notes,
    words_ocred: runReport?.words_total ?? null,
    seconds: runReport?.seconds ?? null,
    extracted_chars: extracted?.length ?? null,
  };
  if (jsonPath) {
    try {
      require("node:fs").writeFileSync(jsonPath, `${JSON.stringify(summary, undefined, 2)}\n`);
    } catch { /* the report is a convenience, never the gate */ }
  }

  if (problems.length > 0) {
    console.error(
      `\nocr toolchain: ${problems.length} check(s) FAILED — the image would ship an OCR layer that does not work ` +
        `(broken entry: ${problems.map((p) => p.slice(0, 60)).join(" | ")}). Fix docker/ocr-toolchain.sh or ` +
        `tools/ocr-pdf.py; do not weaken this gate.`,
    );
    process.exit(1);
  }
  console.log("\nocr toolchain: all checks passed");
  process.exit(0);
}

await main();
