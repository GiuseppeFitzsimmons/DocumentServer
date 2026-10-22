#!/usr/bin/env bash
# Run the Document Server "develop" image, mounting our source modules so they
# compile against the prebuilt core on startup. Produces a live editor at
# http://localhost/example for validating from-source JS changes (e.g. the
# sdkjs cursor method) WITHOUT a full C++ core build.
#
# First `docker build` (see README) pulls the base onlyoffice/documentserver
# image (~2.5GB) and installs build deps. First run compiles sdkjs/web-apps
# (~15-20 min). Subsequent runs reuse the image.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="documentserver-develop"

cd "$REPO_ROOT"

echo "Mounting:"
echo "  sdkjs       -> $REPO_ROOT/sdkjs"
echo "  web-apps    -> $REPO_ROOT/web-apps"
echo "  sdkjs-forms -> $REPO_ROOT/sdkjs-forms"
echo

exec docker run -i -t --rm -p 80:80 \
	-e ALLOW_PRIVATE_IP_ADDRESS=true \
	-v "$REPO_ROOT/sdkjs":/var/www/onlyoffice/documentserver/sdkjs \
	-v "$REPO_ROOT/web-apps":/var/www/onlyoffice/documentserver/web-apps \
	-v "$REPO_ROOT/sdkjs-forms":/var/www/onlyoffice/documentserver/sdkjs-forms \
	"$IMAGE"
