#!/usr/bin/env node
/**
 * Prove the Android EMULATOR toolchain really works.
 *
 * WHY THIS EXISTS
 * ---------------
 * The emulator is a QEMU build with a long list of shared-library
 * dependencies, plus a system image that is only usable when its metadata and
 * the AVD's `image.sysdir.1` agree. Every one of those failure modes looks the
 * same on disk — the files are there — and every one of them fails LATER, in
 * the turn where an agent is asked to actually run something:
 *
 *   * a missing `libpulse.so.0` makes the binary exit immediately
 *     ("error while loading shared libraries"), which a file listing hides;
 *   * an image directory without `source.properties` is a half-download that
 *     the emulator rejects at boot;
 *   * an AVD whose config points at the wrong image (or at no image) fails
 *     with "Cannot find AVD system path" only at start;
 *   * `avdmanager create avd` is broken in the current cmdline-tools, so the
 *     AVD is written by docker/emulator-tools.sh — and THAT assumption is
 *     worth proving rather than trusting.
 *
 * So this runs at image build time (Dockerfile) and is reachable in a running
 * container as `emulator-tools --check`. It executes the binary, writes a real
 * AVD, and starts the emulator far enough that it prints the system image it
 * resolved — then stops it. A container that passes this can be believed.
 *
 * WHAT IT DOES NOT DO: it does not boot Android. That needs /dev/kvm, which is
 * a RUNTIME device and is normally absent at build time; the check therefore
 * treats "no KVM" as a warning with instructions, not as a failure.
 *
 * Usage: node tools/check-emulator-toolchain.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SDK = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || "/opt/android-sdk";
const EMU = path.join(SDK, "emulator", "emulator");
const API = process.env.EMU_API || "android-36";
const TAG = process.env.EMU_TAG || "google_apis";
const ABI = process.env.EMU_ABI || "x86_64";
const IMAGE_DIR = path.join(SDK, "system-images", API, TAG, ABI);
const TOOLS = "/usr/local/bin/emulator-tools";

const failures = [];
const warnings = [];
const notes = [];

function ok(label, detail = "") {
  notes.push(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
}
function warn(label, detail = "") {
  warnings.push(`  warn ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label, detail = "") {
  failures.push(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 60_000,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
}

/**
 * The image is BUILT as root and RUNS as uid 1000, so a probe that only root can
 * pass proves nothing. This actually happened: the emulator launcher shipped as
 * 0744 root:root, every root-run probe here passed, and in a live session
 * `emulator-tools` reported "NOT INSTALLED" — because "others" had no execute
 * bit. Sdkmanager preserves the archive's mode, so it is not a hypothetical.
 *
 * When we are root, every emulator probe is therefore re-run as uid 1000 with
 * setpriv, i.e. as the user who will actually use it.
 */
function asRuntimeUser(cmd, args) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return [cmd, args];
  const found = spawnSync("sh", ["-c", "command -v setpriv"], { encoding: "utf8" });
  const setpriv = found.stdout?.trim();
  if (!setpriv) return [cmd, args];
  return [setpriv, ["--reuid=1000", "--regid=1000", "--clear-groups", cmd, ...args]];
}

console.log("check-emulator-toolchain: verifying the emulator toolchain\n");

// ---------------------------------------------------------------------------
// 0. Architecture: Google publishes no Linux aarch64 emulator. On arm64 this
//    section is legitimately absent, so the build must not be failed for it.
// ---------------------------------------------------------------------------
const arch = process.arch;
if (!["x64"].includes(arch) || (process.env.DPKG_ARCH && process.env.DPKG_ARCH !== "amd64")) {
  console.log(`emulator: not available for ${arch} — skipping (linux x86_64 only).`);
  console.log("Static APK analysis remains available: apk-tools --check\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. The binary runs at all — this is where a missing libpulse0 shows up.
// ---------------------------------------------------------------------------
if (!fs.existsSync(EMU)) {
  fail("emulator binary", `${EMU} missing`);
} else {
  const version = run(...asRuntimeUser(EMU, ["-version"]), { timeout: 30_000 });
  const out = `${version.stdout}${version.stderr}`;
  if (version.error) {
    fail("emulator -version", version.error.message);
  } else if (/Android emulator version \d/.test(out)) {
    ok("emulator -version", out.split("\n")[0].trim());
  } else {
    fail("emulator -version", out.trim().slice(0, 200) || `exit ${version.status}`);
  }
}

// ---------------------------------------------------------------------------
// 2. The system image is complete and self-describing.
// ---------------------------------------------------------------------------
const propsPath = path.join(IMAGE_DIR, "source.properties");
if (!fs.existsSync(propsPath)) {
  fail("system image", `${IMAGE_DIR}/source.properties missing (incomplete download?)`);
} else {
  const props = fs.readFileSync(propsPath, "utf8");
  const apiLevel = /AndroidVersion\.ApiLevel=(\S+)/.exec(props)?.[1];
  const imageAbi = /SystemImage\.Abi=(\S+)/.exec(props)?.[1];
  const tagId = /SystemImage\.TagId=(\S+)/.exec(props)?.[1];
  if (imageAbi && imageAbi !== ABI) fail("system image abi", `image is ${imageAbi}, expected ${ABI}`);
  else ok("system image", `API ${apiLevel ?? "?"} ${tagId ?? TAG} ${imageAbi ?? ABI}`);
}

// ---------------------------------------------------------------------------
// 3. Write a real AVD (the same code path an agent will use) and prove the
//    emulator accepts it AND resolves the system image from it.
// ---------------------------------------------------------------------------
if (fs.existsSync(EMU) && fs.existsSync(propsPath)) {
  const avdHome = fs.mkdtempSync(path.join(os.tmpdir(), "emu-check-"));
  const name = "check_avd";
  const dir = path.join(avdHome, `${name}.avd`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(avdHome, `${name}.ini`),
    ["avd.ini.encoding=UTF-8", `path=${dir}`, `path.rel=avd/${name}.avd`, `target=${API}`].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(dir, "config.ini"),
    [
      `AvdId=${name}`,
      "PlayStore.enabled=false",
      `abi.type=${ABI}`,
      `hw.cpu.arch=${ABI}`,
      "hw.cpu.ncore=2",
      "hw.ramSize=2048",
      "hw.lcd.width=1080",
      "hw.lcd.height=2400",
      "hw.lcd.density=420",
      "hw.keyboard=yes",
      "hw.gpu.enabled=yes",
      "hw.gpu.mode=swiftshader_indirect",
      "hw.camera.back=virtualscene",
      "disk.dataPartition.size=2G",
      `image.sysdir.1=system-images/${API}/${TAG}/${ABI}/`,
      "skin.dynamic=yes",
      `tag.id=${TAG}`,
      `tag.display=${TAG}`,
    ].join("\n") + "\n",
  );

  // (a) the AVD must be discoverable
  // The probe owns its environment: at build time HOME may be root-owned or
  // absent, and the emulator writes there before it does anything useful.
  const probeEnv = {
    ANDROID_AVD_HOME: avdHome,
    ANDROID_USER_HOME: avdHome,
    ANDROID_PREFS_ROOT: avdHome,
    HOME: avdHome,
    TMPDIR: avdHome,
  };

  if (typeof process.getuid === "function" && process.getuid() === 0) {
    spawnSync("chown", ["-R", "1000:1000", avdHome], { encoding: "utf8" });
  }
  const list = run(...asRuntimeUser(EMU, ["-list-avds"]), { timeout: 30_000, env: probeEnv });
  if (`${list.stdout}`.split("\n").map((s) => s.trim()).includes(name)) {
    ok("AVD", `written by hand and discovered (${name})`);
  } else {
    fail("AVD discovery", `-list-avds did not report ${name}`);
  }

  // (b) starting it must resolve the system image. We stop after a few seconds:
  // booting needs /dev/kvm, but "Found systemPath …" is printed before that.
  const probe = run(
    ...asRuntimeUser(EMU, [
      "-avd", name, "-no-window", "-no-audio", "-no-snapshot", "-accel", "off", "-verbose",
    ]),
    { timeout: 25_000, env: probeEnv },
  );
  const probeOut = `${probe.stdout}${probe.stderr}`;
  if (/Found systemPath/i.test(probeOut)) {
    const line = probeOut.split("\n").find((l) => /Found systemPath/i.test(l))?.trim();
    ok("AVD → system image", line?.replace(/^INFO\s*\|\s*/, "") ?? "resolved");
  } else if (/cannot find android emulator system path|Cannot find AVD system path|unknown AVD/i.test(probeOut)) {
    fail("AVD → system image", "emulator could not resolve the image from the AVD");
  } else {
    // The binary is executable and the image is on disk, so the launcher should
    // always get this far. A missing line means the SDK root could not be
    // validated (or another precondition failed) — a boot that never happens.
    const hint = /valid sdk root/i.test(probeOut)
      ? "the launcher could not validate its SDK root (is platform-tools installed?)"
      : `no confirmation line in the first 25 s — first output: ${probeOut.split("\n").find((l) => l.trim()) ?? "(none)"}`;
    fail("AVD → system image", hint);
  }

  fs.rmSync(avdHome, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3a. The emulator refuses to resolve a system image unless it can validate its
// SDK root, and it validates that root by finding `platform-tools` inside it.
// Without the directory the launcher only warns — so this is asserted, because
// the symptom is otherwise an AVD that simply never boots.
// ---------------------------------------------------------------------------
const platformTools = path.join(SDK, "platform-tools");
if (fs.existsSync(platformTools)) {
  ok("SDK root is valid (platform-tools present)");
} else {
  fail(
    "SDK root is NOT valid for the emulator",
    `${platformTools} missing — the launcher will print "Cannot find valid sdk root" and cannot resolve any system image (sdkmanager --install platform-tools)`,
  );
}

// ---------------------------------------------------------------------------
// 3b. The runtime user's view of the files, asserted in the mode bits — the one
// thing a root-run probe above cannot see.
// ---------------------------------------------------------------------------
function othersCanUse(p, needExecute) {
  try {
    const mode = fs.statSync(p).mode & 0o777;
    const read = (mode & 0o004) !== 0;
    const exec = (mode & 0o001) !== 0;
    return { ok: read && (!needExecute || exec), mode };
  } catch {
    return { ok: false, mode: null };
  }
}

if (fs.existsSync(EMU)) {
  const bin = othersCanUse(EMU, true);
  const dir = othersCanUse("/opt/emulator-tools", true);
  if (bin.ok) ok("emulator is usable by uid 1000", `mode ${bin.mode.toString(8)}`);
  else fail("emulator is NOT usable by uid 1000", `mode ${bin.mode?.toString(8) ?? "?"} — needs o+rX (see the installer's permissions step)`);
  if (dir.ok) ok("/opt/emulator-tools is reachable by uid 1000");
  else fail("/opt/emulator-tools is NOT reachable by uid 1000", `mode ${dir.mode?.toString(8) ?? "?"} — a directory without o+x cannot be listed`);
  const imageRoot = path.join(SDK, "system-images");
  const img = othersCanUse(path.join(IMAGE_DIR, "source.properties"), false);
  if (!img.ok) fail("system image is NOT readable by uid 1000", `mode ${img.mode?.toString(8) ?? "?"}`);
  if (!othersCanUse(imageRoot, true).ok) fail("system-images dir is NOT reachable by uid 1000");
}

// ---------------------------------------------------------------------------
// 4. Hardware acceleration: a runtime device, not a build artefact.
// ---------------------------------------------------------------------------
if (fs.existsSync("/dev/kvm") && fs.accessSync) {
  try {
    fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
    ok("/dev/kvm", "present and accessible — the emulator will run accelerated");
  } catch {
    warn(
      "/dev/kvm",
      "present but not accessible — this process lacks the gid that owns the device on the " +
        "HOST. Run `getent group kvm` there and add that NUMBER: group_add: [\"<gid>\"] " +
        "(a group NAME resolves against this image's /etc/group, so it only works when the " +
        "two gids happen to match)",
    );
  }
} else {
  warn(
    "/dev/kvm",
    "absent (expected at build time) — pass it to the container: " +
      "compose.emulator.yaml, or `docker run --device /dev/kvm --group-add kvm`",
  );
}

// ---------------------------------------------------------------------------
// 4b. KVM access by GROUP MEMBERSHIP, which is what removes the compose
// `group_add` line entirely: the image must carry a group with the gid that owns
// /dev/kvm on the host (KVM_GID, 104 by default) and the runtime user must be in
// it. Note the trap this only survives because of: a container started with an
// explicit `user:`/`USER name:group` spec has its supplementary groups DROPPED,
// so `USER node:node` silently defeats the membership.
// ---------------------------------------------------------------------------
function groupEntry(name) {
  try {
    return (
      fs.readFileSync("/etc/group", "utf8")
        .split("\n")
        .find((line) => line.startsWith(`${name}:`)) ?? null
    );
  } catch {
    return null;
  }
}

const kvmGroup = groupEntry("kvm");
if (!kvmGroup) {
  warn("no kvm group in the image", "the runtime user cannot open /dev/kvm without group_add");
} else {
  const parts = kvmGroup.split(":");
  const gid = parts[2];
  const members = (parts[3] ?? "").split(",").map((m) => m.trim());
  if (members.includes("node")) {
    ok("runtime user is in the kvm group", `gid ${gid} — no compose group_add needed`);
  } else {
    warn(
      `runtime user is NOT in the kvm group (gid ${gid})`,
      "containers will need group_add: [\"<host gid>\"] unless the membership is added",
    );
  }
}
// ---------------------------------------------------------------------------
// 5. The agent-facing command must exist, or the capability is theoretical.
// ---------------------------------------------------------------------------
if (fs.existsSync(TOOLS)) ok("emulator-tools", "on PATH");
else warn("emulator-tools", `${TOOLS} missing`);

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
console.log([...notes, ...warnings].join("\n"));
if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("\nemulator toolchain: OK (KVM is validated at container start, not here)");
console.log("  inventory: emulator-tools         boot: emulator-tools --up\n");
