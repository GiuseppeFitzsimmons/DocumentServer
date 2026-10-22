#!/usr/bin/env bash
# JS-ONLY rebuild: recompile sdkjs + web-apps bundles WITHOUT touching the C++
# core. Use this after editing JS source (sdkjs/*.js, web-apps/*.js) — it is
# minutes, not the full make.py which re-runs the C++ build.
#
# Reuses build_tools' own build_js helpers so addon detection (sdkjs-forms etc.)
# and build params match the full build exactly. Writes the refreshed bundles
# into the same checkout; re-extract + repackage the image afterwards.
set -euo pipefail

IMAGE="ds-build-env"
VOLUME="ds-build-cache"

exec docker run -i -t --rm \
  -v "$VOLUME":/build \
  -e DEPOT_TOOLS_BOOTSTRAP_PYTHON3=0 \
  "$IMAGE" -lc '
set -e
# The Euro-Office edits now live as real commits on the eo-10.0.0 branch of the
# forks (GiuseppeFitzsimmons/sdkjs + /web-apps), checked out in the volume.
# No patch script anymore — the source already carries our changes. We just
# sanity-check that the expected markers are present before building.
echo "== verifying EO source edits present on eo-10.0.0 =="
grep -q "pluginMethod_EOGetCursor" /build/sdkjs/word/api_plugins.js || { echo "MISSING sdkjs cursor methods"; exit 1; }
grep -q "eo-epub-export" /build/web-apps/apps/documenteditor/main/app/controller/LeftMenu.js || { echo "MISSING web-apps EPUB intercept"; exit 1; }
# build.py shells out to "python"; our image has python3. Provide the alias.
[ -e /usr/local/bin/python ] || ln -sf "$(command -v python3)" /usr/local/bin/python
# The JS-only path skips configure.py, which normally stamps the product version
# into web-apps/build/common.json. Upstream checkout ships a stale "4.3.0" there,
# which mis-tags the editor assets and causes the service worker + DS cache-reset
# to fight -> infinite "editor version updated, reloading" loop. Pin it to the
# build_tools product version so asset tags are consistent.
# Must equal the version baked into the compiled docservice binary (its license
# buildVersion), or the editor about-version != server buildVersion and the
# editor reload-loops ("editor version updated"). The current server binary
# reports 4.3.0, so pin the JS build to that. (If the server is ever rebuilt
# with a different version, update DS_VER to match it.)
DS_VER="${DS_VER:-4.3.0}"
if [ -f /build/web-apps/build/common.json ]; then
  sed -i "s/\"version\"[[:space:]]*:[[:space:]]*\"[0-9.]*\"/\"version\": \"$DS_VER\"/" /build/web-apps/build/common.json
  echo "pinned web-apps common.json version -> $DS_VER"
fi
# Remove any stale develop-mode sdkjs artifacts so only the production minified
# bundle is produced/served (a prior develop build left a broken 30MB sdk-all.js
# + develop scripts list that the editor would load instead of the min bundle).
rm -rf /build/sdkjs/deploy/sdkjs/*/scripts.js /build/sdkjs/develop 2>/dev/null || true
cd /build/build_tools/tools/linux
echo "== JS-only rebuild (sdkjs + web-apps), no C++ =="
python3 - <<"PY"
import sys
sys.path.append("../../scripts")
sys.path.append("../../scripts/develop")
import config, base, build_js
config.parse()
config.parse_defaults()
root = "/build"
# Build the PRODUCTION (minified) sdkjs bundle only. build_sdkjs_develop also
# emits a 30MB unminified sdk-all.js + a develop scripts.js that makes the
# editor load the debug concatenation — which was broken at runtime
# ("AscWord.DocumentSearch is undefined"). _run_build_py with get_build_param()
# (minimize) produces the normal prod sdk-all-min.js only.
build_dir = root + "/sdkjs/build"
build_js._run_build_py(build_dir, build_js.get_build_param() + base.sdkjs_addons_param())
# web-apps interface bundles
build_js.build_interface(root + "/web-apps/build")
print("JS-ONLY BUILD DONE")
PY
echo "== refreshed word sdk bundle =="
ls -la /build/sdkjs/deploy/sdkjs/word/sdk-all-min.js 2>/dev/null || \
  ls -la /build/build_tools/out/linux_64/onlyoffice/documentserver/sdkjs/word/sdk-all-min.js 2>/dev/null || \
  echo "check output path"
'
