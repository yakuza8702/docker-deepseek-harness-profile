# Troubleshooting

The failures that look like bugs in this image but are usually a host-side edit, a lockfile, or a missing peer. The Personal VM has its own failure catalogue in [personal-vm.md](personal-vm.md).

### A host-side edit "does not reflect" in the container, or a plugin installs but never appears

Both symptoms are usually the **same** mistake: editing (or installing into) the
wrong home. `~/.dsh` and `$DSH_HOME` are one directory in this image (see
[Where your data lives](profiles-and-data.md#where-your-data-lives--dsh-dsh_home-and-workspace)), so
check *which* path you touched:

```bash
# what the launcher actually boots, and where its data lives
docker exec <container> sh -c 'echo DSH_HOME=$DSH_HOME; readlink -f ~/.dsh; ls -la ~/.dsh/profiles/*/'
# the same directory, seen from the host (the mounted data dir)
cat <data-dir>/dsh-home/active-profile.json
```

* A file is only real if it exists under **`$DSH_HOME`** (`/home/node/.dsh`,
  i.e. `<data-dir>/dsh-home/` on the host). A `pnpm-workspace.yaml` under
  `/workspace/.dsh/...` is a phantom home from an image built before the alias —
  it is parked as `/workspace/.dsh.orphan-<UTC>` on the first boot with the
  alias, and the fix is to re-run the install so it lands in the real home.
* Profile/plugin state changes only take effect on the **next boot** (`dsh
  --profile` is a launcher input): `docker restart <container>`, then read the
  boot log.

### `dsh plugin --profile web add dshmarket` warns about a missing peer

```
WARN  Issues with peer dependencies found
└─┬ dshmarket 1.66.8
  └── ✕ missing peer @deepseek-ai/cordis@^4.0.1
```

That warning is **cosmetic** in this image and does not stop the plugin from
loading: pnpm resolves the profile's own workspace (`nodeLinker: hoisted`,
`autoInstallPeers: false` — DSH's shipped template) and therefore cannot see
`@deepseek-ai/cordis`, `@deepseek-ai/dsh-settings` and `@deepseek-ai/schemastery`,
which the *core installation* provides at runtime. To silence the warning without
installing a second copy of the core:

```yaml
# $DSH_HOME/profiles/web/pnpm-workspace.yaml  (host: <data-dir>/dsh-home/profiles/web/)
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

peerDependencyRules:
  ignoreMissing:
    - "@deepseek-ai/*"
```

The install is not what makes the market appear — the **restart** is: `dsh
plugin add` writes the dependency *and* appends the package to
`dsh.profile.bundles`, and the loader composes that list at boot. So: install →
`docker restart` → the Market section shows up. `autoInstallPeers: false` stays:
it is upstream's own setting and prevents a duplicate copy of the core's
framework packages from being installed into the profile (which is what makes
`dshmarket`, or any other bundle, fail to load with two competing runtimes).

### The Plugin Market's Install button fails for every plugin (pnpm refuses the lockfile)

```
Install  <any plugin>
…node_modules/pnpm/dist/pnpm.cjs:168629:34)
 at Array.map (<anonymous>)
 at resolveDependenciesOfImporters (…/pnpm/dist/pnpm.cjs:168195:58)
 at async _installInContext (…/pnpm/dist/pnpm.cjs:175355:232)
```

The stack names no package, and the plugin you were installing is usually not the
problem. pnpm verifies a profile's **whole** lockfile before any `add`/`remove`,
and refuses a tarball resolution that carries no `integrity` unless it can
recognise the URL as git-hosted itself (`codeload.github.com/…tar.gz`,
`bitbucket.org`, `gitlab.com`):

```
ERR_PNPM_MISSING_TARBALL_INTEGRITY: Cannot install package
"<name>@https://github.com/<owner>/<repo>/releases/…/<file>.tgz":
its lockfile entry has no "integrity" field
```

A GitHub **release asset** is not one of those shapes — and pnpm *writes* that
shape when such a URL is added, then refuses it on the next operation that has to
materialise the package. The Market installs curated catalog entries that ship a
prebuilt release archive from exactly that URL (about 70 of them), so one such
install is enough to stop every later install and uninstall in that profile —
including perfectly compatible plugins. The market's own log names the culprit:

```bash
docker exec <container> tail -5 /home/node/.dsh/profiles/web/.dsh-market/log.ndjson
# {"event":"install","detail":"<plugin> exit=1 err=ERR_PNPM_MISSING_TARBALL_INTEGRITY: … <culprit> …"}
```

This image repairs it at boot (`docker/lockfile-integrity.mjs`, called by the
entrypoint before `dsh` starts): it finds tarball resolutions pnpm would reject,
downloads each tarball once, and pins `integrity: sha512-…` on that line — the
hash pnpm itself computes for the URL, which is already in the profile's own
manifest. The lockfile is backed up to `$DSH_HOME/.lockfile-repair-<UTC>/` first,
the repair is idempotent, and a failed download changes nothing.

```bash
# what the guard did on this boot
docker logs <container> 2>&1 | grep lockfile-integrity
# run it by hand (dry-run = report only, no download, no write)
docker exec <container> node /opt/seek-harness/lockfile-integrity.mjs --home "$DSH_HOME" --dry-run
```

* `DSH_LOCKFILE_REPAIR=0` switches the guard off; `=dry` reports without writing.
* pnpm may re-resolve once and drop the pinned integrity on the **first** install
  after a failed run — the next boot re-applies it. Two `pnpm install` passes are
  enough by hand; `--lockfile-only` must **not** be used to check a repair, it
  rewrites the entry without an integrity.
* The guard only pins; it never deletes a dependency or installs anything.

### Installing a GitHub plugin — use a git spec, not a release asset

```bash
# safe: pnpm resolves it through codeload with `gitHosted: true` + an integrity
docker exec <container> dsh plugin --profile web add github:owner/repo
docker exec <container> dsh plugin --profile web add github:owner/repo#v1.2.3
```

A **release asset** URL (`https://github.com/<owner>/<repo>/releases/download/<tag>/<file>.tgz`,
`.tar.gz` is the same) is the shape pnpm refuses when it carries no integrity —
and pnpm writes it that way itself. Measured on pnpm 10.34.6 against a fresh
profile with this image's workspace file: the add fails with
`ERR_PNPM_MISSING_TARBALL_INTEGRITY`, the manifest change is rolled back (nothing
is half-installed), and an orphan entry is left in the lockfile — which the next
pnpm command prunes, so an install that follows it still succeeds. The boot guard
is what covers the other order, where such a plugin *does* land and every later
install would otherwise be blocked.
