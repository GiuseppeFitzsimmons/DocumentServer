#!/usr/bin/env bash
# Launch the deploy helper, setting up a venv if needed.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
    "$VENV_DIR/bin/pip" install --quiet -r "$SCRIPT_DIR/requirements.txt"
    echo "Setup complete."
fi

"$VENV_DIR/bin/python" "$SCRIPT_DIR/deploy-helper.py"
