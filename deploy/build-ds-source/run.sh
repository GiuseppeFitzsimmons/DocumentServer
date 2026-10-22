#!/usr/bin/env bash
# Build ONLYOFFICE Docs (server module) from source inside the 24.04 build image.
#
# The toolchain + source checkout live in a named docker volume (ds-build-cache)
# mounted at /build, so the large Qt/sysroot/deps downloads happen ONCE and are
# reused on every subsequent run. First run: multi-GB download + ~1-1.5h compile
# on 16 cores. Re-runs after a source edit: just the incremental recompile.
#
# Output lands in:
#   <volume>/build_tools/out/linux_64/onlyoffice/documentserver/
# which is a complete, correctly-laid-out documentserver tree.
set -euo pipefail

IMAGE="ds-build-env"
VOLUME="ds-build-cache"
BRANCH="${1:-master}"   # build_tools + source branch; default master (only master is "guaranteed")

docker volume create "$VOLUME" >/dev/null

echo "Building env image..."
docker build -t "$IMAGE" "$(dirname "${BASH_SOURCE[0]}")"

echo
echo "Starting source build (branch: $BRANCH)."
echo "Toolchain + source cached in volume '$VOLUME'. First run is the slow one."
echo

exec docker run -i -t --rm \
    -v "$VOLUME":/build \
    -e DEPOT_TOOLS_BOOTSTRAP_PYTHON3=0 \
    -e DEPOT_TOOLS_UPDATE=0 \
    "$IMAGE" -lc '
set -e
cd /build
if [ ! -d build_tools ]; then
  echo "== cloning build_tools (branch '"$BRANCH"') =="
  git clone --recursive https://github.com/ONLYOFFICE/build_tools.git || \
  git clone https://github.com/ONLYOFFICE/build_tools.git
fi
cd build_tools
git fetch --all --prune
git checkout -f "'"$BRANCH"'" || { echo "branch '"$BRANCH"' missing, staying on current"; }
cd tools/linux
# deps are baked into the image; skip deps.py by marking it complete.
touch packages_complete
# Host build tools (cmake, ninja) are 24.04 binaries and need modern GLIBCXX.
# When the build runs them under the ubuntu16 sysroot library path they fail on
# the sysroot stock libstdc++ (6.0.21). Point the sysroot libstdc++ at the
# system one (a superset), so host tools resolve while sysroot-targeted loads
# still work. Idempotent; only applies once the sysroot has been fetched.
SR=/build/build_tools/tools/linux/sysroot/ubuntu16-amd64-sysroot/usr/lib/x86_64-linux-gnu
if [ -d "$SR" ]; then
  SYS=$(ls /usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.* | sort -V | tail -1)
  ln -sf "$SYS" "$SR/libstdc++.so.6"
fi
# heif.pri links x265 from a dir named "x265", but the fetch creates "x265_git".
# Symlink so the -lx265 search path resolves.
HEIF=/build/core/Common/3dParty/heif
if [ -d "$HEIF/x265_git" ] && [ ! -e "$HEIF/x265" ]; then
  ln -sfn "$HEIF/x265_git" "$HEIF/x265"
fi
echo "== running automate.py server =="
python3 ./automate.py server --branch "'"$BRANCH"'"
echo
echo "== build done. output tree: =="
ls -la /build/build_tools/out/linux_64/onlyoffice/documentserver/ 2>/dev/null || \
  echo "NO OUTPUT TREE — check log above for failure"
'
