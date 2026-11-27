# Compose hardening — why the file is shaped this way

One file holds the reasoning for all seven compose files. Each file's own header
is now short and points here, so the *security model* is written down once
instead of being re-argued, in slightly different words, above every override.

What lives where:

| file | adds |
| --- | --- |
| `compose.yaml` | the harness itself, the proxy, the volumes |
| `compose.windows.yaml` | `/dev/kvm` + `/dev/dri`, the Windows switches |
| `compose.emulator.yaml` | `/dev/kvm` alone, for the Linux guest |
| `compose.gpu.yaml` | virgl devices, GIDs, the NVIDIA toolkit |
| `compose.dind.yaml` | an isolated engine in a sidecar |
| `compose.dind-sysbox.yaml` | the same engine under Sysbox, unprivileged |
| `compose.docker.yaml` | the host `docker.sock` (root-equivalent, opt-in) |

## The baseline is not negotiable

`compose.yaml` carries the hardening every other file must preserve:
`cap_drop: [ALL]`, `no-new-privileges`, `read_only` rootfs, `tmpfs` for `/tmp`,
and loopback-only publishing. **No override in this repository adds a
capability.** Each one is written as the smallest set of `devices`,
`group_add`, `environment` and `volumes` entries that makes its feature work,
and each file says so in its own header. When a feature cannot work without a
capability, the file is not provided — see "What is not here" below.

Two consequences worth knowing before editing any of them:

- **`devices:` is a hard failure, not a fallback.** Docker refuses to start a
  container whose `devices:` entry does not exist on the host. That is why
  `/dev/kvm` is in `compose.emulator.yaml` and not in `compose.yaml`: with it in
  the base file the harness would not boot on any machine without KVM, and the
  VM tools would be unreachable rather than merely reporting a missing device.
- **`group_add` names resolve against the IMAGE, not the host.** A group name
  that exists on the host may not exist in the container, and a resolved numeric
  gid is fixed at container CREATE time — a `restart` does not apply a new one,
  `up -d --force-recreate` does.

## The store is not the place to "harden"

The VM store (`/cua-vm`) holds `disk.qcow2`, `efi-vars.qcow2`, `tpm/`, `oem/`,
`serial.log` and `credentials.json`. Do **not** mount it read-only expecting a
security win: QEMU writes the disk image and swtpm writes its state, so a
read-only store is a boot failure, not a hardening. The rootfs stays read-only
instead, and the store is the one writable volume by design — the same argument
applies to the `dsh-home` and workspace volumes.

## Resource ceilings are deliberately absent

A Windows install plus a running guest is the largest thing this image does, and
its memory profile is not a constant: QEMU reserves the guest's RAM eagerly in
1 GB chunks, so a ceiling has to cover guest memory **plus** OVMF, swtpm and the
supervisor. A `mem_limit` picked from a working development host OOM-kills the
install halfway through on a smaller one, which is the worst possible failure —
the guest is left half-installed and the container is gone.

So there is no `mem_limit` and no `pids_limit` in any file here, and there is no
"recommended" pair in comments either: a commented-out ceiling is still a
number an operator will uncomment. If you need a ceiling for your host, size it
from an install that already succeeded there:

```sh
docker stats --no-stream seek-harness    # during an install, not after it
```

and lower the guest's RAM **before** lowering the ceiling — the guest's memory
is the dominant term, and the ceiling has to stay above it.

## Per-file notes

### `compose.windows.yaml`

Direct QEMU, no second container engine: `qemu-system-x86_64` is started by the
same supervisor that runs the Linux guest, with OVMF + swtpm + a qcow2 disk
under `/cua-vm`. Networking is QEMU user-mode (SLIRP), so the guest reaches host
services through `10.0.2.2` and SSH is forwarded from the host loopback.

A tap/bridge interface is possible for real LAN presence, but it needs
`CAP_NET_ADMIN` and a host bridge. The harness runs `cap_drop: [ALL]`, so it is
**not** wired in any file here; the README's "One computer, two kinds" section
carries the same sentence (`A bridge/tap is possible but not default — it needs
CAP_NET_ADMIN`) next to what a Windows computer actually is.

### `compose.emulator.yaml`

The file name is historical — it used to pass `/dev/kvm` to the Android
emulator, which this image no longer ships. It keeps the name because existing
stacks reference it, and it now gives the device to `cua`, the Linux VM the
model builds and tests in. The supervisor runs outside the agent's sandbox and
owns `/dev/kvm`, QEMU and the `/cua-vm` volume; the harness keeps every bit of
its hardening.

If the device is present but `access(2)` fails with `EACCES`, the fix is the
host gid, not a new device:

```sh
echo "KVM_GID=$(stat -c %g /dev/kvm)" >> .env   # then recreate the container
```

### `compose.gpu.yaml`

virgl is paravirtual GL, **not** VFIO passthrough and **not** CUDA: the host GPU
stays usable (`llama-server` keeps working). It needs a render node
(`/dev/dri/renderD128`) and, on NVIDIA, the container toolkit with the
`graphics` capability — `compute` alone does not mount the EGL/GL libraries.
Vulkan (Venus) additionally needs host kernel ≥ 6.13, guest Mesa ≥ 24.2 and
driver ≥ 570.86.

### `compose.dind.yaml` and `compose.dind-sysbox.yaml`

The sidecar engine is the one place a `privileged` container appears, because a
real nested `dockerd` mounts overlayfs and manages iptables/cgroups. It is not
the host: it has its own PID/mount/net namespaces and sees exactly one host path
(`DIND_DATA`) — do not mount anything else into it. The engine's root API on
2375 is reachable only on the private `harness-docker` network and is never
published.

`compose.dind-sysbox.yaml` removes even that privilege: the same engine runs
under `sysbox-runc` in a user namespace with a full uid/gid mapping, so an
escape has to beat the kernel instead of walking out through `CAP_SYS_ADMIN`.
Only `runtime` and `privileged` differ from the base DinD file.

Purging the engine keeps the artifacts: `DIND_EXPORT` (archives) and
`DIND_REGISTRY_DATA` (pushed images) live outside the engine's data root. Note
that `dockerd` creates `DIND_DATA` root-owned (0710), so the purge `rm` needs
root — a plain user `rm` fails with `EACCES` and looks like "purge didn't work".

### `compose.docker.yaml`

Mounting `docker.sock` grants the container root-equivalent access to the HOST
daemon. That is strictly worse than the sidecar engine above and worse than a
filtered TCP proxy, which is why this is an override rather than part of the
base file, and why the base file's header says never to add the socket to it.
Prefer, in order: the isolated engine (`compose.dind.yaml`), a filtered
socket proxy over TCP, and only then this file.

## What is not here

Anything that would need `CAP_NET_ADMIN`, `CAP_SYS_ADMIN` or a privileged
helper alongside the harness is out of scope by construction. If you need one,
it belongs in a host-level install outside this compose project, not in an
override that quietly widens the harness.
