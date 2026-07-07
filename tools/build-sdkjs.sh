#!/bin/bash
# Builds the sdkjs word bundle (sdk-all.js) from source.
# Run from repo root: ./tools/build-sdkjs.sh
#
# Prerequisites:
#   - Node.js installed
#   - npm install already run in sdkjs/build/
#
# The output is sdkjs/word/sdk-all.js (non-minified, for dev/deploy)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SDKJS="$REPO_ROOT/sdkjs"
BUILD_DIR="$SDKJS/build"

if [ ! -f "$BUILD_DIR/Gruntfile.js" ]; then
    echo "ERROR: sdkjs submodule not initialized. Run: git submodule update --init sdkjs"
    exit 1
fi

if [ ! -d "$BUILD_DIR/node_modules" ]; then
    echo "Installing build dependencies..."
    (cd "$BUILD_DIR" && npm install)
fi

echo "Building sdkjs word bundle..."
(cd "$BUILD_DIR" && npx grunt compile-word)

OUTPUT="$SDKJS/deploy/word/sdk-all.js"
if [ ! -f "$OUTPUT" ]; then
    # Try alternate location
    OUTPUT=$(find "$SDKJS/deploy" -name "sdk-all.js" -path "*/word/*" 2>/dev/null | head -1)
fi

if [ -z "$OUTPUT" ] || [ ! -f "$OUTPUT" ]; then
    echo "ERROR: sdk-all.js not found after build. Check build output."
    exit 1
fi

echo "✓ Built: $OUTPUT"
echo ""
echo "To use locally, mount into docker-compose.dev.yml:"
echo "  - ../sdkjs/deploy/word/sdk-all.js:/var/www/euro-office/documentserver/sdkjs/word/sdk-all.js:ro"
