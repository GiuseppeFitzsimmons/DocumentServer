#!/usr/bin/env bash
# Clean FULL compile (C++ core + sdkjs + web-apps) driven off OUR forks, with NO
# patch script in the loop. Proves the image is byte-clean from the fork source.
#
# How it pins the forks:
#   The ds-build-cache volume has sdkjs/web-apps checked out on branch
#   eo-10.0.0 with origin = GiuseppeFitzsimmons/*. We run build_tools'
#   configure.py / make.py with --update 0, so build_tools does NOT re-clone or
#   switch branches — it builds exactly what is checked out. Every other module
#   (core, server, fonts, ...) stays on its cached master checkout.
#
# This is what automate.py does internally, minus automate's hardcoded
# --update 1 (which would wipe our fork branches with a master checkout).
#
# Cost: full compile (~1-1.5h on 16 cores) since --update 0 still runs the C++
# build. Use build-js.sh for JS-only iteration.
set -euo pipefail

IMAGE="ds-build-env"
VOLUME="ds-build-cache"

docker volume create "$VOLUME" >/dev/null
docker build -t "$IMAGE" "$(dirname "${BASH_SOURCE[0]}")"

exec docker run -i -t --rm \
  -v "$VOLUME":/build \
  -e DEPOT_TOOLS_BOOTSTRAP_PYTHON3=0 \
  -e DEPOT_TOOLS_UPDATE=0 \
  "$IMAGE" -lc '
set -e
git config --global --add safe.directory "*"

echo "== pinning sdkjs/web-apps to forks (eo-10.0.0) =="
git -C /build/sdkjs remote set-url origin git@github.com:GiuseppeFitzsimmons/sdkjs.git 2>/dev/null || \
  git -C /build/sdkjs remote add origin git@github.com:GiuseppeFitzsimmons/sdkjs.git
git -C /build/web-apps remote set-url origin git@github.com:GiuseppeFitzsimmons/web-apps.git 2>/dev/null || \
  git -C /build/web-apps remote add origin git@github.com:GiuseppeFitzsimmons/web-apps.git
git -C /build/sdkjs checkout -f eo-10.0.0
git -C /build/web-apps checkout -f eo-10.0.0

echo "== verifying EO source edits present =="
grep -q "pluginMethod_EOGetCursor" /build/sdkjs/word/api_plugins.js || { echo "MISSING sdkjs cursor methods"; exit 1; }
grep -q "eo-epub-export" /build/web-apps/apps/documenteditor/main/app/controller/LeftMenu.js || { echo "MISSING web-apps EPUB intercept"; exit 1; }

# host-tool sysroot libstdc++ fixup (same as run.sh)
SR=/build/build_tools/tools/linux/sysroot/ubuntu16-amd64-sysroot/usr/lib/x86_64-linux-gnu
if [ -d "$SR" ]; then
  SYS=$(ls /usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.* | sort -V | tail -1)
  ln -sf "$SYS" "$SR/libstdc++.so.6"
fi
HEIF=/build/core/Common/3dParty/heif
if [ -d "$HEIF/x265_git" ] && [ ! -e "$HEIF/x265" ]; then
  ln -sfn "$HEIF/x265_git" "$HEIF/x265"
fi
[ -e /usr/local/bin/python ] || ln -sf "$(command -v python3)" /usr/local/bin/python
touch /build/build_tools/tools/linux/packages_complete

cd /build/build_tools
echo "== configure (update=0: build the checked-out fork source, no re-clone) =="
./tools/linux/python3/bin/python ./configure.py \
  --branch master \
  --module "server" \
  --update 0 \
  --sysroot 1 \
  --qt-dir /build/build_tools/tools/linux/qt_build/Qt-5.9.9
echo "== make =="
./tools/linux/python3/bin/python ./make.py
echo
echo "== build done. output tree: =="
ls -la /build/build_tools/out/linux_64/onlyoffice/documentserver/ 2>/dev/null || \
  echo "NO OUTPUT TREE — check log above"
'
