# Docker engine access (agent can run docker)

How the agent reaches a Docker engine, and what each grant costs. See the [README](../README.md) for the quick start.

**Option A — Docker proxy over TCP (preferred):** point `DOCKER_HOST` at a filtered socket proxy, e.g. [tecnativa/docker-socket-proxy](https://hub.docker.com/r/tecnativa/docker-socket-proxy):

```yaml
# .env
DOCKER_HOST=tcp://docker-socket-proxy:2375
```

**Option B — host docker.sock:**

```bash
# on the HOST: get the docker group gid
stat -c %g /var/run/docker.sock     # e.g. 999

# .env
DOCKER_GID=999

# then run with the override
docker compose -f compose.yaml -f compose.docker.yaml up -d
```

> ⚠️ Mounting `docker.sock` is root-equivalent access to the host daemon. The TCP-proxy route with a filtered proxy is the safer pattern. Both keep the rest of the hardening intact (the docker CLI needs no capabilities).

**Option C — a FULL, ISOLATED engine in a sidecar (no host daemon involved):**

```bash
# .env — the two directories that survive a purge:
#   DIND_DATA          the engine itself (scratch: cache, test containers)
#   DIND_EXPORT        finished images as archives
#   DIND_REGISTRY_DATA finished images pushed to the bundled registry
# DIND_DATA MUST be a real filesystem (ext4/xfs/btrfs) — overlay2 refuses
# to sit on top of FUSE, so never aim it at a mergerfs pool.
DIND_DATA=/srv/<data-disk>/deepseek-harness-data/<stack>/dind
DIND_EXPORT=/srv/<data-disk>/deepseek-harness-data/<stack>/image-export
DIND_REGISTRY_DATA=/srv/<data-disk>/deepseek-harness-data/<stack>/dind-registry

docker compose -f compose.yaml -f compose.dind.yaml up -d
```

The agent then drives its **own** dockerd (`DOCKER_HOST=tcp://dind:2375`, a private
`harness-docker` network, never published): `docker build`, `docker compose up`,
`docker run` — all inside the sidecar. The harness container itself stays exactly as
hardened as before (`cap_drop ALL`, read-only rootfs, no socket), because *using* docker
needs no capability — only the sidecar does.

Getting a finished image out of the isolated engine, with no host-daemon changes:

```bash
# in the harness (DIND_EXPORT is mounted at /export)
docker save myapp:1.0 | gzip > /export/myapp-1.0.tgz

# on the HOST
docker load < <DIND_EXPORT>/myapp-1.0.tgz
```

Or, when the bundled `registry` is published on a free loopback port
(`DIND_REGISTRY_PORT`, default 5001 — 5000 is usually taken), the host can pull
the image directly. **No `daemon.json` edit and no daemon reload are needed**:
Docker treats `127.0.0.0/8` registries as insecure by default.

```bash
# in the harness
docker tag  myapp:1.0 registry:5000/myapp:1.0
docker push registry:5000/myapp:1.0

# on the HOST
docker pull 127.0.0.1:5001/myapp:1.0
```

Purging the isolated engine while keeping the finished images:

```bash
docker compose -f compose.yaml -f compose.dind.yaml rm -sf dind
sudo rm -rf "$DIND_DATA"   # build cache, test containers, scratch layers — gone
# $DIND_EXPORT and $DIND_REGISTRY_DATA are outside the engine's data root,
# so the complete images survive by construction.
# dockerd creates $DIND_DATA root-owned (0710): a non-root rm fails with
# EACCES, which reads like "the purge didn't work" — use sudo.
```

> ⚠️ With `compose.dind.yaml` alone the sidecar is `privileged` — a real nested dockerd must
> mount overlayfs and manage iptables/cgroups. It is not the host: its own PID/mount/net
> namespaces, and exactly one host path (DIND_DATA). Mount nothing else into it.

**Option C, hardened — run that engine under Sysbox (no privileges at all):**

```bash
docker compose -f compose.yaml -f compose.dind.yaml -f compose.dind-sysbox.yaml up -d
```

Two fields change (`runtime: sysbox-runc`, `privileged: false`); the network, the
never-published 2375, the `/export` hand-off and the purge story are identical. The whole
sidecar then runs in a user namespace with a full uid/gid mapping — container root becomes an
unprivileged host uid (e.g. 165536), so nothing holds `CAP_SYS_ADMIN` and an escape has to beat
the kernel rather than walk out through a capability.

Host requirements (Docker install, not Kubernetes):

```bash
# sysbox-runc registered + the three units active
docker info --format '{{json .Runtimes}}' | tr ',' '\n' | grep sysbox
systemctl is-active sysbox.service sysbox-mgr.service sysbox-fs.service
docker run --rm --runtime=sysbox-runc alpine:3.20 echo sysbox-ok
```

> Install note: the Sysbox `.deb` refuses to configure while containers exist **if**
> `daemon.json` has no `bip` key — add `"bip": "172.17.0.1/16"` (today's `docker0`, so a later
> restart changes nothing) and `dpkg --configure sysbox-ce` completes with no daemon restart:
> the runtime entry is picked up live via SIGHUP. Removing it is `dpkg -r sysbox-ce` plus
> restoring the `daemon.json` backup.
>
> Without Sysbox, the privilege-free alternatives are a rootless `docker:dind-rootless`
> (which still needs `CAP_SYS_ADMIN` + unconfined seccomp + `/dev/fuse`, i.e. no real
> boundary) or a VM-based engine on `/dev/kvm`. Neither ships in this repo.

Inside the container: `docker ps`, `docker compose version`, `docker build ...` all work via socket **or** `DOCKER_HOST`.
