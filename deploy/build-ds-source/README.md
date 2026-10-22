# Build Document Server from source (24.04 container)

Full from-source build of ONLYOFFICE Docs (server module) — compiles the C++
core, sdkjs, and web-apps into a complete, correctly-laid-out `documentserver/`
tree. Unlike the develop image, this produces assets at the paths nginx/editor
actually serve, so our own sdkjs changes (e.g. a cursor-position method) land in
`sdk-all-min.js` in the right place.

## Why a container

Host is Ubuntu 26.04; `build_tools/automate.py` targets 24.04 (fixed apt
package list). We build inside `ubuntu:24.04` to isolate the OS mismatch. The
output is still a native-Linux tree.

## Cost

- First run: multi-GB download (Qt 5.9.9, sysroot, deps) + ~1–1.5h compile on
  16 cores. Toolchain + source are cached in the `ds-build-cache` docker volume,
  so this cost is paid once.
- Re-runs after a source edit: incremental recompile only.
- Disk: budget ~30–40GB in the volume. Host has 195GB free.

## Run

```
bash deploy/build-ds-source/run.sh            # builds master (guaranteed branch)
bash deploy/build-ds-source/run.sh v9.3.0.NNN # version-match attempt (see below)
```

Output tree:
```
<volume>/build_tools/out/linux_64/onlyoffice/documentserver/
```

To inspect / copy the result out of the volume:
```
docker run --rm -v ds-build-cache:/build -v "$PWD":/host ds-build-env \
  -lc 'cp -r /build/build_tools/out/linux_64/onlyoffice/documentserver /host/ds-out'
```

## Branch / version notes

- Only `master` is "guaranteed" to build by upstream. Start there to prove the
  pipeline.
- Prod runs 9.3.1. build_tools has `v9.3.0.*` tags and `release/v9.4.0` (no
  `release/v9.3.1`). Version-matching is a later step once master builds clean.
- Default clones from `ONLYOFFICE/*` upstream. Swapping in the Euro-Office forks
  (our `.gitmodules`) is a follow-up once a clean upstream build is proven.

## What this unblocks

Once this produces a working tree, we can re-apply `pluginMethod_EOGetCursor` /
`EOSetCursor` to `sdkjs/word/api_plugins.js`, rebuild, and get a minified bundle
with our method compiled in at the correct served path — the thing every
lighter approach failed to produce.

## Serve & validate (VALIDATED)

The build was completed and confirmed working end-to-end:

1. Extract the tree from the build volume to the host:
   ```
   mkdir -p ~/ds-src-out
   docker run --rm -v ds-build-cache:/build -v ~/ds-src-out:/host ds-build-env \
     -lc 'cp -r /build/build_tools/out/linux_64/onlyoffice/documentserver /host/'
   ```
2. Package into a runnable image (bases on the cached documentserver-develop
   runtime; overwrites its tree with our from-source 9.4.0 build):
   ```
   docker build -f deploy/build-ds-source/Dockerfile.serve \
     -t documentserver-src ~/ds-src-out/documentserver
   ```
3. Run it as the dev stack's documentserver via the override:
   ```
   docker compose -f platform/docker-compose.dev.yml \
     -f platform/docker-compose.src.yml up -d --force-recreate documentserver
   ```

Result: DS serves version 9.4.0 (our local build). Opening a real document
through the platform and running `Asc.editor.callCommand` returns a live
paragraph index — the full builder/macro round-trip works on the from-source
image. This is the capability every lighter approach failed to produce, and it
unblocks adding a character-exact cursor method to `sdkjs/word/api_plugins.js`
and recompiling (the mounted source is non-minified, so method names survive).

NOTE: this image ships STOCK web-apps/sdkjs (no Euro-Office patches). The
cursor-restore IIFE, epub-export intercept, page-size injection, etc. are NOT
present here — this image proves the from-source pipeline; applying our patches
on top is the follow-up.

## Our patches live in the forks (10.0.0 base)

The DS we serve is built from our forks of ONLYOFFICE 10.0.0, branch
`eo-10.0.0`:

- `github.com/GiuseppeFitzsimmons/sdkjs`    `eo-10.0.0` = `v10.0.0.176` + EO commit
- `github.com/GiuseppeFitzsimmons/web-apps` `eo-10.0.0` = `v10.0.0.166` + EO commit

Each fork branch is the exact upstream 10.0.0 tag plus a single Euro-Office
feature commit. The edits (no longer a patch script):

1. Custom book page sizes — sdkjs engine (`api.js`) + menu (`Toolbar.js`)
2. `EOGetCursor` / `EOSetCursor` plugin methods (`api_plugins.js`)
3. Cursor save/restore wiring — localStorage per file (`Main.js`)
4. Version-check removal — kills the reload loop (`Main.js`)
5. EPUB export intercept -> platform exporter (`LeftMenu.js`)

The `ds-build-cache` volume has sdkjs/web-apps checked out on `eo-10.0.0` with
a `personal` remote pointing at the forks. `build-js.sh` no longer patches —
it just verifies the EO markers are present, then builds.

Snapshot diffs of the fork commits are kept in `fork-patches/` for reference.

Do NOT copy 9.3.1-era fork files over the volume — the version skew breaks the
build (e.g. "AscWord.DocumentSearch is undefined").

### To change a patch and redeploy

1. Edit the source directly in the volume checkout (`/build/sdkjs`,
   `/build/web-apps`) and commit on `eo-10.0.0`, then `git push personal
   eo-10.0.0` to update the fork.
2. Run the whole chain:
   ```
   bash deploy/build-ds-source/rebuild.sh
   ```
   (= build-js.sh → sync → Dockerfile.serve → redeploy, in one shot)
3. Wait ~45s for health, then hard-reload the editor in a fresh private window
   (the service worker caches aggressively).

### Starting the dev stack

ALWAYS include both compose files, or you revert to the stock prebuilt image:
```
docker compose -f platform/docker-compose.dev.yml \
  -f platform/docker-compose.src.yml up -d
```

### Key gotchas (learned the hard way)

- `CoAuthoring.server.mode` must be `production` (set in Dockerfile.serve), else
  the editor loads the broken unminified `sdk-all.js`.
- The server binary reports buildVersion `4.3.0`; nginx cache-tag is aligned to
  that in Dockerfile.serve. The version check is neutered anyway.
- The build is JS-only (no C++) — minutes, not hours. The C++ core is cached in
  the volume from the original full `run.sh` build.
