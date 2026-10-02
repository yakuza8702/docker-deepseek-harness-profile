# Working on an .apk in this container

Everything below is already installed — no downloads, no phone required.
`apk-tools` prints what is here with versions; `apk-tools --check` re-runs the
build-time proof (exit 1 means the image is broken, not your command).

Pinned versions and checksums: `/opt/apk-tools/VERSIONS.txt`.

## First move

```sh
apk-unpack ./app.apk              # -> ./app-unpacked/
apk-unpack ./app.apks ./out       # split bundle: analyses the inner base.apk
apk-unpack ./app.apk ./out --no-jadx   # fast pass: manifest + resources only
```

The layout it produces, and why each part exists:

| Path | What it is | Read it for |
|---|---|---|
| `out/raw/` | the zip, as-is | `assets/`, `lib/`, `*.dex`, `META-INF/` |
| `out/apktool/` | decoded resources | `AndroidManifest.xml`, `res/`, `smali/` |
| `out/jadx/` | decompiled Java | the app's logic |
| `out/AndroidManifest.xml` | apkanalyzer's manifest print | permissions, exported components, services |
| `out/apk-summary.txt` | package/version summary | "is this the app I think it is" |
| `out/SUMMARY.txt` | what the app looks like from outside | dex count, native libs, Hermes/Flutter/Unity hints |
| `out/logs/` | each step's output | when a step failed, read the log (jadx errors are normal) |

Nothing is ever deleted, so grep the tree rather than re-running a step.

## The three things that actually answer "how does this app work?"

**1. The Java half** — `out/jadx/sources/`. Grep for the interesting nouns:
`SharedPreferences`, `Retrofit`/`OkHttp` base URLs, `FirebaseMessagingService`,
`NotificationListenerService`, `api/`, `token`, `secret`, `insert`/`update`.
Obfuscated names are normal; string literals and the manifest usually survive.

**2. The resource half** — `out/apktool/AndroidManifest.xml` is the
authoritative list of what the app can do (permissions, exported activities,
services with `BIND_*` permissions). `out/apktool/res/values/strings.xml` often
holds API hosts and feature flags that never reach a Java constant.

**3. The bundle half (React Native / Expo)** — if `SUMMARY.txt` mentions
`index.android.bundle`, the app's real logic is *not* in the dex. That file is
Hermes bytecode (HBC), and `jadx`/`strings` see only a string table:

```sh
hbctool disasm out/raw/assets/index.android.bundle bundle-asm   # readable listing
hbc-decompiler out/raw/assets/index.android.bundle out.js      # JS-ish output
grep -n "https\|token\|supabase\|firebase" bundle-asm/* 2>/dev/null | head
```

Try both tools: they cover different HBC revisions. If one rejects the file
with a version error, use the other — and say so in your report instead of
guessing at the bytecode.

## Native code

`out/raw/lib/<abi>/*.so` — `strings`, `readelf -d`, `nm -D`, `objdump -d` are
all available (binutils ships with the base image). `file` tells you the arch.
No decompiler is installed for .so files; if a task needs one, that is a
deliberate gap to raise, not to work around silently.

## Dynamic analysis (only with a device)

`frida`, `frida-dexdump` and `objection` are installed but there is no phone
here. With a rooted device or an emulator reachable over the network:

```sh
adb connect 192.0.2.10:5555
adb devices
frida-ps -U                       # or: frida-ps -H 192.0.2.10:27042
frida -U -f com.example.app -l hook.js
frida-dexdump -U                  # dump dex from a running process
```

The container is not privileged and has no USB: use TCP, not a cable.

## Repack, sign, install

`apktool` is the rebuild path (`jadx` cannot produce an APK):

```sh
apktool b out/apktool -o patched.apk
zipalign -f -p 4 patched.apk patched-aligned.apk
apksigner sign --ks my.keystore --ks-pass pass:secret --out patched-signed.apk patched-aligned.apk
apksigner verify --print-certs patched-signed.apk
```

`zipalign` must run before `apksigner`. A rebuild loses the original signature
by construction — the app will only install if the original was not
signature-checked by something else (Play Integrity, an in-app tamper check,
or a paired companion app).

## Known limits — read before promising a result

- **Read-only rootfs.** The image ships `build-tools` + one platform. Adding
  another (`sdkmanager --install "platforms;android-35"`) writes under
  `$ANDROID_HOME`, which is read-only in the hardened compose stack: either use
  a `compose.override.yaml` with `read_only: false`, or point `ANDROID_HOME` at
  a writable directory. Android *projects* usually just need their wrapper
  (`./gradlew`) — that downloads its own Gradle into `$HOME`.
- **Split bundles.** `.apks` / `.xapk` / `.apkm` are zips of split APKs;
  `apk-unpack` picks `base.apk` (the one with the code) and lists the rest.
- **Obfuscation.** R8/ProGuard, string encryption and packers defeat static
  reading; `apkid` tells you whether a packer is in play — say that instead of
  reporting "no findings".
- **Signature checks.** A modified APK is a *different* app to Play Integrity
  and to anything pinning a certificate. Say so when a patch depends on it.
- **Scope.** Analysis here is static and offline: no bank/API calls are made on
  someone else's behalf, and no device is touched unless you connect one.
