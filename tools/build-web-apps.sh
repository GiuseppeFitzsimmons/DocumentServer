#!/bin/bash
# Builds the documenteditor app.js from the web-apps source.
# Run from repo root: ./tools/build-web-apps.sh
#
# Prerequisites:
#   - Node.js installed
#   - npm install already run in web-apps/build/
#
# The output replaces deploy/patches/documenteditor-app.js

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_APPS="$REPO_ROOT/web-apps"
BUILD_DIR="$WEB_APPS/build"
OUTPUT="$REPO_ROOT/deploy/patches/documenteditor-app.js"

# Verify web-apps submodule is initialized
if [ ! -f "$BUILD_DIR/Gruntfile.js" ]; then
    echo "ERROR: web-apps submodule not initialized. Run: git submodule update --init web-apps"
    exit 1
fi

# Install deps if needed
if [ ! -d "$BUILD_DIR/node_modules" ]; then
    echo "Installing build dependencies..."
    (cd "$BUILD_DIR" && npm install)
fi

# Run the grunt build
echo "Building documenteditor..."
(cd "$BUILD_DIR" && npx grunt deploy-documenteditor)

# Find the output
BUILT="$WEB_APPS/deploy/web-apps/apps/documenteditor/main/app.js"
if [ ! -f "$BUILT" ]; then
    echo "ERROR: Build output not found at $BUILT"
    exit 1
fi

# Verify version matches DS
VERSION=$(grep -oP 'txtVersionNum="[^"]+"' "$BUILT" | head -1)
echo "Built version: $VERSION"

if ! echo "$VERSION" | grep -q "9.3.1"; then
    echo "WARNING: Version doesn't contain 9.3.1 — may cause version mismatch!"
    echo "Check web-apps/build/documenteditor.json 'version' field."
fi

# Copy to deploy
cp "$BUILT" "$OUTPUT"
echo "✓ Copied to $OUTPUT"
echo ""
echo "Next steps:"
echo "  git add deploy/patches/documenteditor-app.js"
echo "  git commit -m 'rebuild web-apps'"
echo "  Then deploy as usual."
