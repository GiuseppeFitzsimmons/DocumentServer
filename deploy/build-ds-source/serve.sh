#!/usr/bin/env bash
# Serve the from-source documentserver tree using the official documentserver
# image purely as the RUNTIME (nginx, postgres, rabbitmq, supervisor), with our
# built tree bind-mounted over /var/www/onlyoffice/documentserver.
#
# This serves a complete, self-consistent 9.4.0 build (sdkjs + web-apps + server
# all built together), so there is no cross-version skew. Editor at
# http://localhost:8081/example/.
set -euo pipefail

TREE="${1:-$HOME/ds-src-out/documentserver}"

if [ ! -d "$TREE/sdkjs/word" ]; then
  echo "tree not found at $TREE (pass path as arg, or extract first)"; exit 1
fi

IMAGE="${IMAGE:-documentserver-develop}"   # cached locally; built FROM official image

docker rm -f ds-src-serve >/dev/null 2>&1 || true

# Mount sdkjs + web-apps from our 9.4.0 build so the in-browser editor is a
# self-consistent matched set. (Server/runtime come from the image; for the
# callCommand validation only the browser-side sdkjs+web-apps pairing matters.)
exec docker run -i -t --rm --name ds-src-serve \
  -p 8081:80 \
  -e JWT_ENABLED=false \
  -e ALLOW_PRIVATE_IP_ADDRESS=true \
  -e GENERATE_FONTS=true \
  -v "$TREE/sdkjs":/var/www/onlyoffice/documentserver/sdkjs \
  -v "$TREE/web-apps":/var/www/onlyoffice/documentserver/web-apps \
  "$IMAGE"
