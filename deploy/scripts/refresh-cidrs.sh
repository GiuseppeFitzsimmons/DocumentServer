#!/usr/bin/env bash
set -euo pipefail

# refresh-cidrs.sh
# Downloads aggregated CIDR ranges for allowed countries from ipdeny.com,
# validates them, and atomically updates the geo-whitelist used by Caddy.

# --- Configuration ---
WHITELIST_FILE="/opt/euro-office/deploy/geo-whitelist.txt"
TEMP_DIR=$(mktemp -d)
BASE_URL="https://www.ipdeny.com/ipblocks/data/aggregated"

# EU 27 country codes
EU_CODES=(at be bg hr cy cz dk ee fi fr de gr hu ie it lv lt lu mt nl pl pt ro sk si es se)
# Additional allowed countries: GB, NO, CH, IS, AU, NZ, CA, US, MX
EXTRA_CODES=(gb no ch is au nz ca us mx)

COUNTRY_CODES=("${EU_CODES[@]}" "${EXTRA_CODES[@]}")

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT

# --- Validation ---
# Checks that a file is non-empty and every non-blank line is valid CIDR notation
validate_cidr_file() {
  local file="$1"

  if [ ! -s "$file" ]; then
    return 1
  fi

  # Every non-empty line must match CIDR pattern (IPv4: x.x.x.x/n)
  while IFS= read -r line; do
    # Skip empty lines
    [ -z "$line" ] && continue
    if ! echo "$line" | grep -qE '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$'; then
      return 1
    fi
  done < "$file"

  return 0
}

# --- Download and validate per-country files ---
log "Starting CIDR refresh for ${#COUNTRY_CODES[@]} countries"

success_count=0
fail_count=0

for cc in "${COUNTRY_CODES[@]}"; do
  url="${BASE_URL}/${cc}-aggregated-zone"
  outfile="${TEMP_DIR}/${cc}.zone"

  if curl -sSf --max-time 30 -o "$outfile" "$url"; then
    if validate_cidr_file "$outfile"; then
      success_count=$((success_count + 1))
    else
      log "WARNING: Validation failed for ${cc}, skipping (retaining previous)"
      rm -f "$outfile"
      fail_count=$((fail_count + 1))
    fi
  else
    log "WARNING: Download failed for ${cc}, skipping (retaining previous)"
    rm -f "$outfile"
    fail_count=$((fail_count + 1))
  fi
done

# --- Check for complete failure ---
if [ "$success_count" -eq 0 ]; then
  log "ERROR: All country downloads failed. Retaining previous whitelist."
  exit 1
fi

log "Downloaded ${success_count}/${#COUNTRY_CODES[@]} countries successfully (${fail_count} failed)"

# --- Concatenate valid files into temporary aggregate ---
aggregate="${TEMP_DIR}/geo-whitelist-new.txt"
cat "${TEMP_DIR}"/*.zone > "$aggregate" 2>/dev/null

if [ ! -s "$aggregate" ]; then
  log "ERROR: Aggregate file is empty after concatenation. Retaining previous whitelist."
  exit 1
fi

line_count=$(wc -l < "$aggregate")
log "Aggregate whitelist contains ${line_count} CIDR entries"

# --- Atomically replace the active whitelist ---
mv "$aggregate" "$WHITELIST_FILE"
log "Whitelist file updated at ${WHITELIST_FILE}"

# --- Reload Caddy configuration ---
if docker exec caddy caddy reload --config /etc/caddy/Caddyfile; then
  log "Caddy configuration reloaded successfully"
else
  log "ERROR: Caddy reload failed. The new whitelist is in place but Caddy is using its previous in-memory config."
fi

log "CIDR refresh complete"
