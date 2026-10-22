#!/usr/bin/env bash
# One-time push of the eo-10.0.0 branches (already committed inside the
# ds-build-cache volume) to your GitHub forks, over SSH.
#
#   github.com/GiuseppeFitzsimmons/sdkjs    branch eo-10.0.0
#   github.com/GiuseppeFitzsimmons/web-apps branch eo-10.0.0
#
# Each branch = exact upstream 10.0.0 tag + one Euro-Office feature commit.
# This uploads the 10.0.0 git objects your forks don't have yet (one-time,
# larger upload). Mounts your ~/.ssh so the push uses your GitHub SSH key.
set -euo pipefail

VOLUME="ds-build-cache"
IMAGE="ds-build-env"

docker run --rm -it --entrypoint sh \
  -v "$VOLUME":/build \
  -v "$HOME/.ssh":/root/.ssh:ro \
  -e GIT_CONFIG_GLOBAL=/tmp/gitconfig \
  -e GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" \
  "$IMAGE" -c '
set -e
git config --global --add safe.directory "*"
git config --global user.email "giuseppe@eurobureau.eu"
git config --global user.name "Giuseppe Fitzsimmons"

echo "===== pushing sdkjs eo-10.0.0 ====="
cd /build/sdkjs
git remote remove personal 2>/dev/null || true
git remote add personal git@github.com:GiuseppeFitzsimmons/sdkjs.git
git push -u personal eo-10.0.0

echo "===== pushing web-apps eo-10.0.0 ====="
cd /build/web-apps
git remote remove personal 2>/dev/null || true
git remote add personal git@github.com:GiuseppeFitzsimmons/web-apps.git
git push -u personal eo-10.0.0

echo "DONE. Both forks now have branch eo-10.0.0."
'
