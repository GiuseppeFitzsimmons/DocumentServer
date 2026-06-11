#!/usr/bin/env bash
set -euo pipefail

# refresh-disposable-emails.sh
# Downloads the disposable email domain blocklist from the disposable-email-domains
# GitHub repository, validates it, and atomically updates the active list file.

# --- Configuration ---
DOMAIN_LIST_FILE="/opt/euro-office/data/disposable-domains.txt"
TEMP_DIR=$(mktemp -d)
SOURCE_URL="https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT

# --- Download ---
log "Starting disposable email list refresh"

outfile="${TEMP_DIR}/disposable-domains-new.txt"

if ! curl -sSf --max-time 60 -o "$outfile" "$SOURCE_URL"; then
  log "ERROR: Failed to download disposable email list from ${SOURCE_URL}. Retaining previous list."
  exit 1
fi

# --- Validate non-empty ---
if [ ! -s "$outfile" ]; then
  log "WARNING: Downloaded disposable email list is empty. Rejecting update, retaining previous list."
  exit 1
fi

line_count=$(wc -l < "$outfile")
log "Downloaded disposable email list contains ${line_count} domains"

# --- Atomically replace the active list ---
mv "$outfile" "$DOMAIN_LIST_FILE"
log "Disposable email list updated at ${DOMAIN_LIST_FILE}"

log "Disposable email list refresh complete"
