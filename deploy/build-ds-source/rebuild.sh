#!/usr/bin/env bash
# One-shot: rebuild the from-source DS JS, package it into the serve image, and
# redeploy it into the dev stack. Use after editing deploy/build-ds-source/
# apply-eo-patches.py (or any sdkjs/web-apps source the patches target).
#
# Steps:
#   1. build-js.sh     - apply EO patches to the 10.0.0 volume source + compile
#                        sdkjs + web-apps bundles (no C++).
#   2. sync            - copy the fresh bundles into the out/ tree and the host
#                        extract (~/ds-src-out/documentserver).
#   3. docker build    - package the tree into the documentserver-src image.
#   4. redeploy        - recreate the dev-stack documentserver on the new image.
#
# NB: the browser service worker caches editor assets aggressively. After this
# completes, hard-reload / use a fresh private window to see changes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
VOLUME="ds-build-cache"
IMAGE_ENV="ds-build-env"
TREE="$HOME/ds-src-out/documentserver"

echo "== [1/4] build JS (patches + compile) =="
bash "$HERE/build-js.sh"

echo
echo "== [2/4] sync bundles -> out tree + host extract =="
docker run --rm -v "$VOLUME":/build -v "$HOME/ds-src-out":/host "$IMAGE_ENV" -lc '
set -e
OUT=/build/build_tools/out/linux_64/onlyoffice/documentserver
# Authoritative compiled bundle locations. These MUST exist after build-js.sh;
# fail hard rather than fall back to a wrong path (a stale fallback once baked a
# broken code.js into the image and wedged the editor).
SDKJS_SRC=/build/sdkjs/deploy/sdkjs
WA_SRC=/build/web-apps/deploy/web-apps
[ -d "$SDKJS_SRC" ] || { echo "MISSING $SDKJS_SRC — build-js.sh did not produce sdkjs bundle"; exit 1; }
[ -d "$WA_SRC" ]    || { echo "MISSING $WA_SRC — build-js.sh did not produce web-apps bundle"; exit 1; }
# Replace (not merge) so stale compiled files (e.g. an old code.js) cannot
# survive into the new image.
rm -rf "$OUT/sdkjs" "$OUT/web-apps"
cp -r "$SDKJS_SRC" "$OUT/sdkjs"
cp -r "$WA_SRC"    "$OUT/web-apps"
# never serve a develop script list (forces broken unminified sdk-all.js)
find "$OUT/sdkjs" -name scripts.js -delete 2>/dev/null || true
rm -rf /host/documentserver/sdkjs /host/documentserver/web-apps
cp -r "$OUT/sdkjs" /host/documentserver/sdkjs
cp -r "$OUT/web-apps" /host/documentserver/web-apps
# sanity: confirm the compiled editor bundle exists in the host extract
[ -f /host/documentserver/web-apps/apps/documenteditor/main/code.js ] || { echo "code.js missing after sync"; exit 1; }
echo "synced (strict)"
'



echo
echo "  staging custom fonts into build context (<tree>/custom-fonts)"
docker run --rm -v "$HOME/ds-src-out":/host -v "$REPO_ROOT/fonts":/fonts:ro "$IMAGE_ENV" -lc '
  rm -rf /host/documentserver/custom-fonts
  mkdir -p /host/documentserver/custom-fonts
  cp -a /fonts/. /host/documentserver/custom-fonts/
  echo "staged $(ls /host/documentserver/custom-fonts | wc -l) font files"
'

echo
echo "== [3/4] package serve image =="
docker build -f "$HERE/Dockerfile.serve" -t documentserver-src "$TREE" >/dev/null
echo "built documentserver-src"

echo
echo "== [4/4] redeploy dev-stack documentserver =="
docker compose \
  -f "$REPO_ROOT/platform/docker-compose.dev.yml" \
  -f "$REPO_ROOT/platform/docker-compose.src.yml" \
  up -d --force-recreate documentserver

echo
echo "Done. Wait ~45s for health, then hard-reload the editor (fresh private window)."
