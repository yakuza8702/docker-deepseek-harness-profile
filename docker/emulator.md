# Android emulator — run the app, not just read it

`apk-tools` answers *what does this APK contain*. This answers *what does it DO*:
permission prompts, camera capture, WebView rendering, insets on a device with a
camera cutout, whether a screen state survives rotation. Those need a booted
Android system, and this image ships one so the answer does not cost a 1.3 GB
download in the middle of a task.

```bash
emulator-tools                 # inventory: what is installed, what is missing, what to run
emulator-tools --up            # write the AVD, boot Android, wait for boot_completed
emulator-tools --apk app-debug.apk --pkg com.example.app
emulator-tools --down
```

---

## 1. Hardware acceleration is a runtime device, not a package

The emulator needs **`/dev/kvm`**, which cannot be baked into an image and is
deliberately not in the base compose (that file keeps the container locked down:

`cap_drop ALL`, read-only rootfs). Pass it with the override:

```bash
docker compose -f compose.yaml -f compose.emulator.yaml up -d
```

or, without compose:

```bash
docker run --device /dev/kvm --group-add kvm ...
```

Check it inside the container:

```bash
ls -l /dev/kvm            # must be readable AND writable
emulator-tools            # prints "hardware accel: /dev/kvm present and accessible"
```

**Without KVM the emulator refuses to start** (`x86_64 emulation currently
requires hardware acceleration!`). `emulator-tools --up --no-accel` falls back
to software emulation, but the guest is then so slow that Android's own watchdog
kills `system_server` within minutes (`*** WATCHDOG KILLING SYSTEM PROCESS`) —
measured, on API 36, at ~20 load average. API 34+ is effectively untestable
without KVM. On a host that is itself a VM, enable nested virtualisation.

## 2. The APK you install must carry x86_64 native code

The emulator image is **x86_64** and has **no ARM translation**. An APK whose
only native libraries are `arm64-v8a`/`armeabi-v7a` cannot run there — it fails
at `UnsatisfiedLinkError`, or installs and dies on first use of a library. For a
Gradle project that means:

```bash
./gradlew assembleDebug -PforEmulator     # adds lib/x86_64 to the APK
```

Verify before installing:

```bash
unzip -l app-debug.apk | grep 'lib/x86_64'   # must print lines
```

Pure-Java/JavaScript apps (no `.so` files) are unaffected and run as they are.

## 3. What the emulator is good for — and what it is not

| Good for | Not good for |
|---|---|
| Does it install, launch and render at all | Real inference latency (this is CPU emulation) |
| Permission dialogs and the flow after granting | Real camera quality (`hw.camera.back=virtualscene`) |
| Layout, insets, cutout, rotation, dark mode | Real sensor data (GPS, light, proximity are synthetic) |
| Automated UI driving via `adb input` / `uiautomator` | Anything needing Play Services + a Google account (the AVD is `google_apis`, not Play) |
| Screenshots and `screenrecord` evidence | Battery, thermal and network conditions |

## 4. Traps this image already handles for you

* **`avdmanager create avd` is broken** in the current cmdline-tools
  (`Package path is not valid. Valid system image paths are: null`). The
  replacement, `android emulator create <profile>`, *downloads* the image it
  prefers — which cannot work here because the SDK is read-only at runtime.
  So `emulator-tools` **writes the AVD by hand** (`config.ini` + `.ini`) against
  the image the image already ships. No registry, no network.
* **The AVD must live outside `/opt` and `/home`** — the rootfs is read-only.
  `ANDROID_AVD_HOME` defaults to `/workspace/.android/avd`, created at boot.
* **A streamed `adb install` of a large APK fails silently on a slow guest**
  (`cmd: Failure calling service package: Broken pipe`). The tool pushes to
  `/data/local/tmp` and runs `pm install`, then verifies with `pm path`.
* **`sys.boot_completed` flips before the launcher is usable.** The tool waits
  for the property *and* sleeps 20 s; on a cold software boot the launcher can
  take another ten minutes to appear.
* **`libpulse0` is a hard dependency of the emulator binary** and is installed by
  `docker/emulator-toolchain.sh`; without it the binary exits with
  "error while loading shared libraries" before printing anything.

## 5. Watching it (the human half)

```bash
DISPLAY=:99 emulator-tools --up --windowed     # a window on the image's desktop
```

The desktop is served by the same reverse proxy as the browser panel, so the
emulator window appears where the browser already appears. Headless (the
default) is best for agent-driven runs; `--windowed` is for watching one.

Screenshots come out of the emulator regardless:

```bash
emulator-tools --apk app-debug.apk --pkg com.example.app   # writes /workspace/emulator-shots/launch.png
adb exec-out screencap -p > shot.png
adb shell screenrecord --time-limit 20 /sdcard/demo.mp4    # video evidence
```

## 6. Driving the UI

```bash
adb shell uiautomator dump /data/local/tmp/ui.xml      # /sdcard is not writable for shell on API 30+
adb exec-out cat /data/local/tmp/ui.xml                # find a node's bounds
adb shell input tap 540 1200
adb shell input text 'hello'
adb shell am start -n com.example.app/.MainActivity
adb logcat -d | grep -iE 'AndroidRuntime|FATAL'        # crash triage
```

## 7. Limits and honesty

* The system image is **google_apis (no Play Store)** by design: no Google
  account, no Play Services, no licensed apps.
* Camera frames come from the emulator's **virtual scene** — enough to prove the
  capture flow and the permission handling, not enough to judge recognition
  accuracy. That needs real photos.
* Emulator results never excuse the real device: performance numbers from an
  emulated CPU are meaningless for anything user-facing.
* The Linux emulator exists for **x86_64 only**. On an arm64 host this toolchain
  installs nothing and `emulator-tools` says so; static APK analysis still works.

## 8. Inventory and proof

```bash
emulator-tools --check     # re-runs the build-time proof:
                           #   emulator binary runs (the libpulse0 canary)
                           #   system image metadata is complete
                           #   a hand-written AVD is discovered by the emulator
                           #   the emulator resolves the system image from that AVD
                           #   KVM presence (warning only — it is a runtime device)
```

Versions and paths are reported by `emulator-tools`; the installer pins the API
level and ABI in the Dockerfile (`EMU_API`, `EMU_TAG`, `EMU_ABI`).
