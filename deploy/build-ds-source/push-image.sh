#!/usr/bin/env bash
# Push the from-source DocumentServer image to GHCR so Hetzner pulls a ready
# image instead of compiling for ~1h.
#
# The image is self-contained: all base layers (from documentserver-develop)
# travel with it, so the target host needs NOTHING pre-pulled.
#
# Auth: GHCR needs a GitHub Personal Access Token with `write:packages`
# (classic token) or a fine-grained token with package write. SSH keys do NOT
# work for registry auth. Create one at:
#   https://github.com/settings/tokens
#
# Usage:
#   export GHCR_TOKEN=ghp_xxxxxxxx
#   bash deploy/build-ds-source/push-image.sh [TAG]
#
# TAG defaults to a date stamp + the DS build version.
set -euo pipefail

OWNER="giuseppefitzsimmons"                 # GHCR namespaces are lowercase
IMAGE="documentserver-src"
LOCAL="documentserver-src:latest"
TAG="${1:-10.0.0-eo-$(date +%Y%m%d)}"
REMOTE="ghcr.io/${OWNER}/${IMAGE}:${TAG}"
REMOTE_LATEST="ghcr.io/${OWNER}/${IMAGE}:latest"

: "${GHCR_TOKEN:?Set GHCR_TOKEN to a GitHub PAT with write:packages}"

echo "== logging in to ghcr.io as ${OWNER} =="
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$OWNER" --password-stdin

echo "== tagging ${LOCAL} -> ${REMOTE} (+ :latest) =="
docker tag "$LOCAL" "$REMOTE"
docker tag "$LOCAL" "$REMOTE_LATEST"

echo "== pushing (large, one-time upload on slow links) =="
docker push "$REMOTE"
docker push "$REMOTE_LATEST"

echo
echo "DONE. Pull on Hetzner with:"
echo "  docker pull ${REMOTE}"
echo
echo "Make the package public (or grant the prod host read access) at:"
echo "  https://github.com/users/${OWNER}/packages/container/${IMAGE}/settings"
