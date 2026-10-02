#!/usr/bin/env node
/**
 * Prove the APK / Android reverse-engineering toolchain really works.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything this toolchain needs is a DOWNLOAD: a JDK from apt, a jadx zip
 * from GitHub, an apktool jar, a Hermes decompiler from PyPI, and ~400 MB of
 * Android SDK. None of that is exercised by "the file exists" — a Python
 * package that installed but cannot import, a jar that needs a newer JVM, a
 * build-tools binary whose shebang resolves to a missing interpreter, or a
 * download that silently 404'd into an HTML error page all look identical on
 * disk and all fail LATER, in the middle of an analysis an agent is being
 * asked to trust.
 *
 * So this runs at image build time (Dockerfile) and is reachable inside a
 * running container as `apk-tools --check`: it EXECUTES every tool, checks
 * the shape of what came back, and fails loudly (exit 1) if any of it does
 * not actually run. A container that passes this can be believed.
 *
 * It is deliberately not a version assertion: jadx/apktool/SDK versions move
 * (the pins live in docker/apk-toolchain.sh and are recorded in
 * /opt/apk-tools/VERSIONS.txt), and pinning them here too would mean this
 * gate starts failing on a routine bump instead of on a real breakage.
 *
 * Usage: node tools/check-apk-toolchain.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const VENV = "/opt/apk-tools/venv";
const SDK = process.env.ANDROID_HOME || "/opt/android-sdk";

/** Commands must exit with one of `codes` (default 0) AND match `match` (default: any output). */
const probes = [
  // The JVM everything else is built on.
  { label: "java", cmd: "java", args: ["-version"], match: /version "\d+(\.\d+)+/ },
  { label: "javac", cmd: "javac", args: ["-version"], match: /^javac \d+/m },
  // DEX -> Java.
  { label: "jadx", cmd: "jadx", args: ["--version"], match: /^\d+\.\d+\.\d+$/m },
  // AndroidManifest/resources/smali decode + rebuild.
  { label: "apktool", cmd: "apktool", args: ["--version"], match: /^\d+\.\d+/m },
  // React-Native Hermes bytecode (the part jadx and strings cannot see).
  // hbctool refuses unknown HBC revisions by design; both must still RUN.
  { label: "hbctool", cmd: `${VENV}/bin/hbctool`, args: [], codes: [0, 1, 2], match: /hbctool/i },
  { label: "hbc-disassembler", cmd: `${VENV}/bin/hbc-disassembler`, args: ["--help"], codes: [0, 1, 2], match: /usage: hbc-disassembler/i },
  { label: "hbc-decompiler", cmd: `${VENV}/bin/hbc-decompiler`, args: ["--help"], codes: [0, 1, 2], match: /usage: hbc-decompiler/i },
  // Scriptable analysis + packer detection.
  { label: "androguard", cmd: `${VENV}/bin/androguard`, args: ["--version"], match: /androguard, version \d+/i },
  { label: "apkid", cmd: `${VENV}/bin/apkid`, args: ["-v"], match: /APKiD \d+\.\d+/ },
  // Dynamic instrumentation (needs a device — the tools must still RUN here).
  // `objection version` is avoided on purpose: it checks the network.
  { label: "frida", cmd: `${VENV}/bin/frida`, args: ["--version"], match: /^\d+\.\d+\.\d+/m },
  { label: "frida-ps", cmd: `${VENV}/bin/frida-ps`, args: ["--help"], codes: [0, 1, 2], match: /usage: frida-ps/i },
  { label: "objection", cmd: `${VENV}/bin/objection`, args: ["--help"], match: /Usage: objection/i },
  // Sign / align / inspect a rebuilt APK. (zipalign with no args prints its
  // usage and exits 2; apkanalyzer's --version prints its verb list.)
  { label: "apksigner", cmd: "apksigner", args: ["--version"], match: /\d+\.\d+/ },
  { label: "zipalign", cmd: "zipalign", args: [], codes: [0, 1, 2], match: /Zip alignment utility/i },
  { label: "aapt2", cmd: "aapt2", args: ["version"], match: /Android Asset Packaging Tool/i },
  { label: "apkanalyzer", cmd: "apkanalyzer", args: ["--version"], codes: [0, 1], match: /apkanalyzer/i },
  { label: "sdkmanager", cmd: "sdkmanager", args: ["--version"], codes: [0, 1], match: /Android CLI|sdkmanager/i },
  { label: "adb", cmd: "adb", args: ["version"], match: /Android Debug Bridge/ },
  // The two wrappers an agent is meant to reach for first.
  { label: "apk-tools --help", cmd: "apk-tools", args: ["--help"], match: /apk-unpack/ },
  { label: "apk-unpack --help", cmd: "apk-unpack", args: ["--help"], match: /--no-jadx/ },
];

/** Filesystem shape the probes above cannot express. */
function filesystemChecks() {
  const out = [];
  const add = (label, ok, detail) => out.push({ label, ok, detail });

  const javaHome = process.env.JAVA_HOME;
  add(
    "env JAVA_HOME",
    Boolean(javaHome) && fs.existsSync(path.join(javaHome, "bin", "java")),
    javaHome ? `${javaHome}/bin/java` : "JAVA_HOME is not set — Gradle, sdkmanager and jadx-gui rely on it",
  );
  add("env ANDROID_HOME", Boolean(process.env.ANDROID_HOME) && fs.existsSync(SDK), `${SDK}`);

  let buildTools = null;
  try {
    buildTools = fs
      .readdirSync(path.join(SDK, "build-tools"))
      .filter((v) => fs.existsSync(path.join(SDK, "build-tools", v, "apksigner")))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .pop();
  } catch {
    buildTools = null;
  }
  add(
    "build-tools (apksigner)",
    Boolean(buildTools),
    buildTools ? path.join(SDK, "build-tools", buildTools) : "no build-tools with apksigner under " + SDK,
  );

  let platform = null;
  try {
    platform = fs
      .readdirSync(path.join(SDK, "platforms"))
      .filter((p) => fs.existsSync(path.join(SDK, "platforms", p, "android.jar")))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .pop();
  } catch {
    platform = null;
  }
  add("platform (android.jar)", Boolean(platform), platform ? path.join(SDK, "platforms", platform) : "no platform with android.jar");

  const versions = "/opt/apk-tools/VERSIONS.txt";
  add("version manifest", fs.existsSync(versions) && fs.statSync(versions).size > 0, versions);
  add("in-image guide", fs.existsSync("/opt/apk-tools/README.md"), "/opt/apk-tools/README.md");

  // Every pinned Python distribution must be importable, not merely listed:
  // `pip list` reports what pip believes, an import is what an agent needs.
  const py = [
    ["hbctool", "hbctool"],
    ["hermes-dec", null], // ships console scripts; asserted by the hbc-* probes above
    ["frida-tools", "frida"],
    ["frida-dexdump", "frida_dexdump"],
    ["objection", "objection"],
    ["androguard", "androguard"],
    ["apkid", "apkid"],
  ];
  const imports = py.filter(([, mod]) => mod).map(([, mod]) => mod);
  const probe = spawnSync(
    `${VENV}/bin/python`,
    ["-c", `import importlib\n[importlib.import_module(m) for m in ${JSON.stringify(imports)}]`],
    { encoding: "utf8", timeout: 120_000 },
  );
  add(
    "python imports",
    probe.status === 0,
    probe.status === 0
      ? `importable: ${imports.join(", ")}`
      : `${(probe.stderr ?? "").trim().split("\n").pop() ?? "import failed"} (install pins live in docker/apk-toolchain.sh)`,
  );

  return out;
}

function runProbe(p) {
  const r = spawnSync(p.cmd, p.args, { encoding: "utf8", timeout: 120_000 });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const codes = p.codes ?? [0];
  if (r.error) return { ok: false, detail: r.error.code === "ENOENT" ? `${p.cmd}: not installed` : String(r.error.message) };
  if (r.status === null) return { ok: false, detail: `${p.cmd}: killed (timeout/signal)` };
  if (!codes.includes(r.status)) return { ok: false, detail: `${p.cmd} exited ${r.status}: ${text.split("\n")[0] || "(no output)"}` };
  if (p.match && !p.match.test(text)) return { ok: false, detail: `${p.cmd}: unexpected output: ${text.split("\n").slice(0, 2).join(" / ") || "(empty)"}` };
  return { ok: true, detail: text.split("\n")[0] || "ok" };
}

const results = [];
for (const p of probes) {
  const { ok, detail } = runProbe(p);
  results.push({ label: p.label, ok, detail });
}
results.push(...filesystemChecks());

const width = Math.max(...results.map((r) => r.label.length));
for (const r of results) {
  console.log(`${r.ok ? "  ok  " : " FAIL "} ${r.label.padEnd(width)}  ${r.detail}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(
    `\napk toolchain: ${failed.length} of ${results.length} checks FAILED — the image would ship an APK toolchain that cannot run ` +
      `(broken entry: ${failed.map((f) => f.label).join(", ")}). Fix docker/apk-toolchain.sh; do not weaken this gate.`,
  );
  process.exit(1);
}
console.log(`\napk toolchain: ${results.length}/${results.length} checks passed`);
