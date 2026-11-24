#!/usr/bin/env node
/**
 * check-cua-vm-tools.mjs — the `cua_vm_*` tool layer is a SCHEMA FREEZE plus a
 * PROSE BUDGET, and both are numbers rather than opinions.
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * The tool layer (`plugins/dsh-cua-vm/index.js`) is not documentation: its
 * `description` / `parameters` / `output` strings are inlined into EVERY model
 * request. Two opposite defects live in that one fact:
 *
 *   * a trim that is "just wording" can drop an enum value, a `required` entry
 *     or a parameter — the schema the model is offered then differs from the
 *     one the code implements, and nothing fails until a call is refused;
 *   * a description that restates the payload's own field names costs tokens on
 *     every request for a reader who already has the JSON.
 *
 * So this file freezes the SHAPE — names, parameter keys in order, types, enums,
 * numeric bounds (`minimum`/`maximum`), `required`, every `additionalProperties`
 * flag, and the output schema's own `required`/`properties`/`additionalProperties`
 * — and caps the PROSE (tool description, each parameter description, the
 * `textOutput` sentence). Each of those is a real defect class this repo has
 * seen elsewhere: a dropped `stderr` from an output's `required` makes a consumer
 * read `undefined`, a flipped `additionalProperties` lets an unbounded object
 * through, and a widened `maximum` turns a refused budget into a hung call.
 * A deliberate schema change
 * is still possible — `--print` dumps the table to paste back — but it can no
 * longer happen by accident, because the run after it is red until someone
 * pastes.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not run the plugin, resolve imports, or reach the network. It reads
 * two files as text (`index.js` and `win-mcp.js` for the two live tool names),
 * exactly like `check-tool-trim.mjs` reads the catalogue: a text gate can run
 * in a checkout with no `node_modules`, which is the only way it can be the
 * first thing CI answers.
 *
 * USAGE
 *   node tools/check-cua-vm-tools.mjs            # exit 0 or 1, prints the totals
 *   node tools/check-cua-vm-tools.mjs --print    # dump the CURRENT table as JS
 *
 * `--print` is the only legitimate way to refresh the freeze after a
 * DELIBERATE schema change; the default run never rewrites anything.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const INDEX_FILE = join(ROOT, "plugins", "dsh-cua-vm", "index.js");
const WIN_MCP_FILE = join(ROOT, "plugins", "dsh-cua-vm", "win-mcp.js");

/** The prose measured on the tree BEFORE the trim (the freeze's before-image). */
const PROSE_BASELINE = 11163;
/** TT-7: total prose after the trim. */
const PROSE_BUDGET = 7700;
/** TT-1: tool description caps. */
const DESC_CAP = 240;
const DESC_CAP_BIG = 480;
const BIG_DESCRIPTION_TOOLS = new Set(["windows_desktop", "windows_mcp_doctor"]);
/** TT-2: parameter description cap, one documented exception. */
const PARAM_CAP = 200;
const PARAM_CAP_OVERRIDES = new Map([["cua_vm_create.windowsVersion", 320]]);
/** TT-4: `output:` prose cap. */
const OUTPUT_CAP = 160;

/**
 * TT-5: THE PROMPT IS THE AUTHORITATIVE COPY OF THE RULES, and the trim dedupes
 * AGAINST it, never deletes from it. `CUA_PROMPT_LINES` is untouched by this
 * slice; these three lines carry the rules a compressed tool description is
 * allowed to shorten. If one of them disappears, the descriptions below stop
 * being "compressed" and become the only copy — which is the defect this list
 * exists to catch.
 */
const PROMPT_CONTRACT = [
  ["SPACE:", "the measured coordinate space"],
  ["SHUTDOWN vs SUSPEND:", "memory vs disk"],
  ['WINDOWS (`kind: "windows"`', "the Windows session-0 / no-clipboard / WARP contract"],
];

/* ===================================================================== *
 * THE FREEZE
 * ===================================================================== */
const TOOLS = Object.freeze([
  { name: 'windows_desktop', required: [], ap: 'false', out: 'text', params: [] },
  { name: 'windows_mcp_doctor', required: [], ap: 'false', out: 'text', params: ['repair:boolean', 'functional:boolean'] },
  { name: 'cua_vm_status', required: [], ap: 'false', out: 'text', params: [] },
  { name: 'cua_vm_ensure', required: [], ap: 'false', out: 'text', params: ['workspace:string', 'tier:string[slim,full]', 'cpu:integer{1..16}', 'memory:integer{1..64}', 'waitForDesktop:boolean', 'image:string', 'gpu:boolean', 'diskGb:number', 'android:boolean', 'rea:boolean'] },
  { name: 'cua_vm_create', required: ['name'], ap: 'false', out: 'text', params: ['name:string', 'kind:string[linux,windows]', 'cpu:number', 'memory:number', 'image:string', 'gpu:boolean', 'diskGb:number', 'android:boolean', 'rea:boolean', 'windowsVersion:string[11,11l,11e,10,10l,10e,7u,xp,2025,2022,2019,2016,2012,core11,tiny11,tiny10]', 'windowsIso:string', 'windowsImageIndex:integer', 'windowsImageName:string'] },
  { name: 'cua_vm_gui', required: ['action', 'name'], ap: 'false', out: 'text', params: ['action:string[screenshot,geometry,click,dclick,move,drag,type,key,hotkey,scroll,windows,a11y,clipboard,launch,open,zoom,unzoom]', 'name:string', 'x:number', 'y:number', 'x2:number', 'y2:number', 'text:string', 'key:string', 'direction:string[up,down,left,right]', 'amount:number', 'app:string', 'window:string', 'path:string', 'save:string', 'region:object', 'region.x:number', 'region.y:number', 'region.width:number', 'region.height:number', 'region.scale:number', 'relative:boolean', 'smooth:boolean', 'steps:number', 'durationMs:number'] },
  { name: 'cua_vm_disk', required: ['name', 'sizeGb'], ap: 'false', out: 'text', params: ['name:string', 'sizeGb:number'] },
  { name: 'cua_vm_android', required: ['name'], ap: 'false', out: 'text', params: ['name:string', 'api:integer', 'variant:string', 'arch:string', 'avd:string'] },
  { name: 'cua_vm_exec', required: ['name', 'cmd'], ap: 'false', out: 'object{ap:false;props:exit,stdout,stderr,ms;req:exit,stdout,stderr,ms}', params: ['name:string', 'cmd:string', 'cwd:string', 'timeout:integer{1..3600}'] },
  { name: 'cua_vm_put', required: ['name', 'local', 'guest'], ap: 'false', out: 'text', params: ['name:string', 'local:string', 'guest:string'] },
  { name: 'cua_vm_get', required: ['name', 'guest', 'local'], ap: 'false', out: 'text', params: ['name:string', 'guest:string', 'local:string'] },
  { name: 'cua_vm_port', required: ['name', 'guestPort'], ap: 'false', out: 'text', params: ['name:string', 'guestPort:integer{1..65535}', 'localPort:integer{1..65535}'] },
  { name: 'cua_vm_start', required: ['name'], ap: 'false', out: 'text', params: ['name:string'] },
  { name: 'cua_vm_shutdown', required: ['name'], ap: 'false', out: 'text', params: ['name:string'] },
  { name: 'cua_vm_gc', required: [], ap: 'false', out: 'text', params: ['dryRun:boolean'] },
  { name: 'cua_vm_doctor', required: [], ap: 'false', out: 'text', params: [] },
  { name: 'cua_vm_suspend', required: ['name'], ap: 'false', out: 'text', params: ['name:string'] },
  { name: 'cua_vm_destroy', required: ['name'], ap: 'false', out: 'text', params: ['name:string', 'force:boolean'] },
]);

/* ===================================================================== *
 * READING THE TOOL LAYER
 * ===================================================================== */

/**
 * Strip `//` and block comments, leaving strings untouched.
 *
 * THE SAME SHAPE as `check-cua-vm.mjs`'s helper (text gates are standalone by
 * convention — importing the other gate would drag 5,000 lines and its CLI into
 * this one). It is string-aware on purpose: a `//` inside a description (every
 * `https://…` in this file) is not a comment.
 */
function stripJsComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  let quote = null;
  while (i < n) {
    const ch = text[i];
    if (quote !== null) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Decode one quoted JS string literal (escapes included: the tree uses \u2019). */
function decodeLiteral(raw) {
  const body = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === "u") {
      if (body[i + 2] === "{") {
        const close = body.indexOf("}", i + 2);
        out += String.fromCodePoint(parseInt(body.slice(i + 3, close), 16));
        i = close;
      } else {
        out += String.fromCharCode(parseInt(body.slice(i + 2, i + 6), 16));
        i += 5;
      }
      continue;
    }
    const map = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
    if (next === "\n") {
      i += 1;
      continue;
    }
    out += Object.hasOwn(map, next) ? map[next] : next;
    i += 1;
  }
  return out;
}

/** Tokenise the object-literal subset `registerCuaTool({...})` uses. */
function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === ch) break;
        j += 1;
      }
      tokens.push({ kind: "string", value: decodeLiteral(text.slice(i, j + 1)) });
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      // A template literal: consumed whole, braces inside it are NOT structure.
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === "$" && text[j + 1] === "{") {
          depth += 1;
          j += 2;
          continue;
        }
        if (depth > 0 && text[j] === "}") {
          depth -= 1;
          j += 1;
          continue;
        }
        if (depth === 0 && text[j] === "`") break;
        j += 1;
      }
      tokens.push({ kind: "template", value: text.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
      tokens.push({ kind: "ident", value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9._a-zA-Z]/.test(text[j])) j += 1;
      tokens.push({ kind: "number", value: text.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ kind: "punct", value: ch });
    i += 1;
  }
  return tokens;
}

/** Skip one expression (a call, a template, a ternary) to its `,`/`}` boundary. */
function skipExpr(tokens, at) {
  let i = at;
  let depth = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.kind === "punct") {
      if (token.value === "(" || token.value === "[" || token.value === "{") depth += 1;
      else if (token.value === ")" || token.value === "]" || token.value === "}") {
        if (depth === 0) return i;
        depth -= 1;
      } else if (token.value === "," && depth === 0) return i;
    }
    i += 1;
  }
  return i;
}

function parseValue(tokens, at) {
  const token = tokens[at];
  if (token === undefined) return { value: { __expr: "eof" }, next: at };
  if (token.kind === "punct" && token.value === "{") return parseObject(tokens, at + 1);
  if (token.kind === "punct" && token.value === "[") return parseArray(tokens, at + 1);
  if (token.kind === "string" || token.kind === "template") return { value: token.value, next: at + 1 };
  if (token.kind === "number") return { value: Number(token.value), next: at + 1 };
  if (token.kind === "ident") {
    // `output: textOutput('…')` — the only call whose ARGUMENT is prose.
    if (token.value === "textOutput" && tokens[at + 1]?.value === "(" && tokens[at + 2]?.kind === "string") {
      return { value: { __textOutput: tokens[at + 2].value }, next: skipExpr(tokens, at) };
    }
    if (token.value === "true") return { value: true, next: at + 1 };
    if (token.value === "false") return { value: false, next: at + 1 };
    if (token.value === "null") return { value: null, next: at + 1 };
    return { value: { __expr: token.value }, next: skipExpr(tokens, at) };
  }
  return { value: { __expr: String(token.value) }, next: skipExpr(tokens, at) };
}

function parseArray(tokens, at) {
  const out = [];
  let i = at;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.kind === "punct" && token.value === "]") return { value: out, next: i + 1 };
    if (token.kind === "punct" && token.value === ",") {
      i += 1;
      continue;
    }
    const parsed = parseValue(tokens, i);
    out.push(parsed.value);
    i = parsed.next;
    if (tokens[i]?.kind === "punct" && tokens[i].value === ",") i += 1;
  }
  return { value: out, next: i };
}

function parseObject(tokens, at) {
  const out = {};
  let i = at;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.kind === "punct" && token.value === "}") return { value: out, next: i + 1 };
    if (token.kind === "punct" && token.value === ",") {
      i += 1;
      continue;
    }
    if (token.kind !== "string" && token.kind !== "ident") {
      i += 1;
      continue;
    }
    const key = token.value;
    i += 1;
    // Stop at the handler: everything this gate freezes is declared ABOVE it,
    // and its body is code (with `name: target` and friends) that would
    // otherwise overwrite the tool's own fields.
    if (key === "execute") break;
    if (tokens[i]?.kind === "punct" && tokens[i].value === ":") {
      const parsed = parseValue(tokens, i + 1);
      out[key] = parsed.value;
      i = parsed.next;
      continue;
    }
    out[key] = { __expr: key };
  }
  return { value: out, next: i };
}

/**
 * Every `registerCuaTool({ … })` block, sliced by BRACE DEPTH with strings,
 * template literals and comments skipped.
 *
 * A naive `{`-counter mis-slices on the first description that mentions a brace
 * (`%TEMP%\win32_mcp_shots`, `{"repair":true}`) and would then freeze the wrong
 * text; a block that does not close is a hard error, never a silent pass.
 */
function sliceToolBlocks(text, sourceName) {
  const blocks = [];
  const marker = "registerCuaTool({";
  let from = 0;
  while (true) {
    const start = text.indexOf(marker, from);
    if (start === -1) break;
    let i = start + marker.length - 1;
    let depth = 0;
    let quote = null;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (quote !== null) {
        if (ch === "\\") {
          i += 1;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
    if (depth !== 0) throw new Error(`${sourceName}: the block for the tool at offset ${start} did not close`);
    blocks.push(text.slice(start, i));
    from = i;
  }
  return blocks;
}

/**
 * `name:string[linux,windows]{1..16}` — the freeze's one-line shape per
 * parameter: type, every enum value in order, and the numeric bounds.
 *
 * BOUNDS ARE PART OF THE CONTRACT, not decoration: `timeout` with `maximum: 3600`
 * and `timeout` with `maximum: 60` are two different tools to a caller, and a
 * widened `maximum` is exactly how "the tool refused my budget" becomes "the
 * call hung for an hour". `minimum`/`maximum` may legitimately be 0, so the test
 * is `!== undefined`, never truthiness.
 */
function shapeOf(property) {
  const type = typeof property?.type === "string" ? property.type : "?";
  const values = Array.isArray(property?.enum) ? property.enum : null;
  const shape = values === null ? type : `${type}[${values.join(",")}]`;
  const bounds = property?.minimum !== undefined || property?.maximum !== undefined
    ? `{${property.minimum ?? ""}..${property.maximum ?? ""}}`
    : "";
  return `${shape}${bounds}`;
}

/** Flatten `properties` into ordered `path:shape` rows (nested objects too). */
function flagOf(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "unset";
}

function flattenProperties(properties, prefix = "") {
  const rows = [];
  if (properties === null || typeof properties !== "object") return rows;
  for (const [key, value] of Object.entries(properties)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    rows.push(`${path}:${shapeOf(value)}`);
    if (value?.properties !== undefined) rows.push(...flattenProperties(value.properties, path));
  }
  return rows;
}

/** The prose this gate budgets, with the path needed to name a violation. */
function collectProse(properties, prefix = "") {
  const rows = [];
  if (properties === null || typeof properties !== "object") return rows;
  for (const [key, value] of Object.entries(properties)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value?.description === "string") rows.push({ path, text: value.description });
    if (value?.properties !== undefined) rows.push(...collectProse(value.properties, path));
  }
  return rows;
}

/** Read `export const NAME = '…'` out of win-mcp.js. */
function readConstant(text, name) {
  const match = new RegExp(`export const ${name} = '([^']*)'`, "u").exec(text);
  return match === null ? null : match[1];
}

function readToolLayer() {
  if (!existsSync(INDEX_FILE)) throw new Error(`index.js not found at ${INDEX_FILE}`);
  const raw = readFileSync(INDEX_FILE, "utf8");
  const text = stripJsComments(raw);
  const winMcp = existsSync(WIN_MCP_FILE) ? readFileSync(WIN_MCP_FILE, "utf8") : "";
  const aliases = new Map([
    ["REVEAL_TOOL_NAME", readConstant(winMcp, "REVEAL_TOOL_NAME")],
    ["DOCTOR_TOOL_NAME", readConstant(winMcp, "DOCTOR_TOOL_NAME")],
  ]);
  const tools = [];
  for (const block of sliceToolBlocks(text, "index.js")) {
    const tokens = tokenize(block);
    const brace = tokens.findIndex((token) => token.kind === "punct" && token.value === "{");
    const parsed = parseObject(tokens, brace + 1).value;
    const rawName = typeof parsed.name === "string" ? parsed.name : String(parsed.name?.__expr ?? "?");
    const name = aliases.get(rawName) ?? rawName;
    const description = typeof parsed.description === "string" ? parsed.description : "";
    const parameters = parsed.parameters !== null && typeof parsed.parameters === "object" ? parsed.parameters : {};
    const properties = parameters.properties ?? {};
    const required = Array.isArray(parameters.required) ? parameters.required.filter((value) => typeof value === "string") : [];
    const outputProse = typeof parsed.output?.__textOutput === "string" ? parsed.output.__textOutput : "";
    // A `textOutput` tool returns `{text}` through one shared helper, so `text`
    // is the whole marker. A CUSTOM output carries three separate contracts and
    // all three are frozen: the property set, its `required` list (a consumer
    // reads `value.stderr` — dropping it from `required` is a schema lie), and
    // its `additionalProperties` flag.
    const outputSchema = parsed.output?.schema ?? null;
    const outputMarker = outputProse !== ""
      ? "text"
      : `object{ap:${flagOf(outputSchema?.additionalProperties)};props:${Object.keys(outputSchema?.properties ?? {}).join(",")};req:${Array.isArray(outputSchema?.required) ? outputSchema.required.join(",") : ""}}`;
    const parameterAp = flagOf(parameters.additionalProperties);
    tools.push({
      name,
      description,
      required,
      params: flattenProperties(properties),
      paramProse: collectProse(properties),
      outputMarker,
      outputProse,
      parameterAp,
    });
  }
  return { tools, text };
}

/* ===================================================================== *
 * THE COMPARISON
 * ===================================================================== */
const describe = (tool) => ({
  name: tool.name,
  required: [...tool.required],
  ap: tool.parameterAp,
  out: tool.outputMarker,
  params: [...tool.params],
});

function formatEntry(tool) {
  const required = `[${tool.required.map((value) => `'${value}'`).join(", ")}]`;
  const params = tool.params.map((value) => `'${value}'`).join(", ");
  return `  { name: '${tool.name}', required: ${required}, ap: '${tool.parameterAp}', out: '${tool.outputMarker}', params: [${params}] },`;
}

function printTable(tools) {
  console.log("const TOOLS = Object.freeze([");
  for (const tool of tools) console.log(formatEntry(tool));
  console.log("]);");
}

function main() {
  let layer;
  try {
    layer = readToolLayer();
  } catch (error) {
    console.error(`cua_vm tool layer — FAIL: ${error.message}`);
    process.exit(1);
  }
  const current = layer.tools.map(describe);

  if (process.argv.includes("--print")) {
    printTable(layer.tools);
    console.error(`# ${layer.tools.length} tool(s), prose ${layer.tools.reduce((sum, tool) => sum + tool.description.length + tool.paramProse.reduce((inner, row) => inner + row.text.length, 0) + tool.outputProse.length, 0)} chars`);
    return;
  }

  const failures = [];
  const frozen = [...TOOLS];

  console.log(`cua_vm tool layer — ${current.length} tools`);

  // 1. NAME SET AND ORDER (TT-6: no rename, no add, no delete).
  const currentNames = current.map((tool) => tool.name);
  const frozenNames = frozen.map((tool) => tool.name);
  if (currentNames.length !== frozenNames.length || currentNames.some((name, index) => name !== frozenNames[index])) {
    failures.push(`tool set changed: frozen [${frozenNames.join(", ")}] — found [${currentNames.join(", ")}]`);
  } else {
    console.log("  schema: names/keys/required/enums identical to the freeze");
  }

  // 2. SHAPE (keys, order, types, enums, required, output marker).
  for (const [index, name] of frozenNames.entries()) {
    const before = frozen[index];
    const after = current[index];
    if (after === undefined) continue;
    if (before.required.join("\u0000") !== after.required.join("\u0000")) {
      failures.push(`required drift: ${name} (frozen [${before.required.join(", ")}] — found [${after.required.join(", ")}])`);
    }
    if (before.out !== after.out) failures.push(`output drift: ${name} (frozen ${before.out} — found ${after.out})`);
    if (before.ap !== after.ap) {
      failures.push(`additionalProperties drift: ${name}.parameters (frozen ${before.ap} — found ${after.ap}) — a tool that accepts undeclared keys is a different contract`);
    }
    const beforeParams = new Map(before.params.map((row) => [row.split(":")[0], row]));
    const afterParams = new Map(after.params.map((row) => [row.split(":")[0], row]));
    for (const [path, row] of beforeParams) {
      if (!afterParams.has(path)) {
        failures.push(`schema drift: ${name}.${path} was removed`);
        continue;
      }
      if (afterParams.get(path) !== row) {
        const enumDrift = row.includes("[") || afterParams.get(path).includes("[");
        failures.push(enumDrift
          ? `enum drift: ${name}.${path} (frozen ${row} — found ${afterParams.get(path)})`
          : `schema drift: ${name}.${path} (frozen ${row} — found ${afterParams.get(path)})`);
      }
    }
    for (const path of afterParams.keys()) {
      if (!beforeParams.has(path)) failures.push(`schema drift: ${name}.${path} was added`);
    }
    const beforeOrder = before.params.map((row) => row.split(":")[0]);
    const afterOrder = after.params.map((row) => row.split(":")[0]);
    if (beforeOrder.join("\u0000") !== afterOrder.join("\u0000")) failures.push(`schema drift: ${name} parameter order`);
  }

  // 3. THE PROMPT STILL CARRIES THE RULES THE PROSE DEDUPES AGAINST (TT-5).
  for (const [needle, what] of PROMPT_CONTRACT) {
    if (!layer.text.includes(needle)) failures.push(`prompt contract lost: "${needle}" (${what})`);
  }

  // 4. THE LINUX-ONLY CLIPBOARD ACTION MUST NOT DISAPPEAR WITH THE WINDOWS NOTE
  //    (TT-3): the enum is the only place that says the action exists at all.
  const gui = current.find((tool) => tool.name === "cua_vm_gui");
  const guiAction = gui?.params.find((row) => row.startsWith("action:")) ?? "";
  if (!guiAction.includes("clipboard")) failures.push("enum drift: cua_vm_gui.action (the Linux-only `clipboard` value is gone)");

  // 5. CAPS (TT-1, TT-2, TT-4) and the BUDGET (TT-7).
  let maxDescription = 0;
  let maxDescriptionTool = "";
  let overCap = 0;
  let overParams = 0;
  let prose = 0;
  for (const tool of layer.tools) {
    prose += tool.description.length;
    const cap = BIG_DESCRIPTION_TOOLS.has(tool.name) ? DESC_CAP_BIG : DESC_CAP;
    if (tool.description.length > maxDescription) {
      maxDescription = tool.description.length;
      maxDescriptionTool = tool.name;
    }
    if (tool.description.length > cap) {
      overCap += 1;
      failures.push(`over cap: ${tool.name}.description ${tool.description.length} > ${cap}`);
    }
    prose += tool.outputProse.length;
    if (tool.outputProse.length > OUTPUT_CAP) {
      overCap += 1;
      failures.push(`over cap: ${tool.name}.output ${tool.outputProse.length} > ${OUTPUT_CAP}`);
    }
    for (const row of tool.paramProse) {
      prose += row.text.length;
      const key = `${tool.name}.${row.path}`;
      const cap2 = PARAM_CAP_OVERRIDES.get(key) ?? PARAM_CAP;
      if (row.text.length > cap2) {
        overParams += 1;
        failures.push(`over cap: ${key} ${row.text.length} > ${cap2}`);
      }
    }
  }
  if (prose > PROSE_BUDGET) failures.push(`prose budget: ${prose} > ${PROSE_BUDGET} chars`);

  if (failures.length === 0) {
    console.log(`  descriptions: max ${maxDescription} (${maxDescriptionTool}), cap ${DESC_CAP} elsewhere, 0 over`);
    const delta = PROSE_BASELINE - prose;
    const percent = ((delta / PROSE_BASELINE) * 100).toFixed(1);
    console.log(`  prose: ${PROSE_BASELINE} -> ${prose} chars (~${Math.round(PROSE_BASELINE / 3.7)} -> ~${Math.round(prose / 3.7)} tokens, -${percent}%)`);
    console.log(`cua_vm tool layer: ${current.length} tools, schema frozen, prose under budget (${PROSE_BUDGET}).`);
    return;
  }

  for (const failure of failures) console.error(`  FAIL ${failure}`);
  console.error(`\ncua_vm tool layer: ${failures.length} failure(s) — ${overCap} prose cap(s), ${overParams} parameter cap(s).`);
  console.error("  A deliberate schema change? Re-run with --print and paste the table back.");
  process.exit(1);
}

main();
