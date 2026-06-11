#!/usr/bin/env bash
set -euo pipefail

# Load environment variables
ENV_FILE="$(dirname "$0")/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env file not found at $ENV_FILE"
  exit 1
fi
set -a
source "$ENV_FILE"
set +a

# Configuration
BACKUP_DIR="/tmp/euro-office-backup"
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
PG_DUMP_FILE="$BACKUP_DIR/pg_dump_${TIMESTAMP}.sql.gz"

# S3 target
S3_ENDPOINT="${OVH_S3_ENDPOINT}"
S3_BUCKET="${OVH_S3_BUCKET}"
S3_REGION="${OVH_S3_REGION}"

export AWS_ACCESS_KEY_ID="${OVH_S3_ACCESS_KEY}"
export AWS_SECRET_ACCESS_KEY="${OVH_S3_SECRET_KEY}"
export AWS_DEFAULT_REGION="${S3_REGION}"

S3_FLAGS="--endpoint-url ${S3_ENDPOINT}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

cleanup() { rm -rf "$BACKUP_DIR"; }
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"

# --- 1. PostgreSQL dump ---
log "Starting pg_dump..."
docker exec deploy-postgres-1 pg_dump -U portal -d portal | gzip > "$PG_DUMP_FILE"
DUMP_SIZE=$(du -h "$PG_DUMP_FILE" | cut -f1)
log "pg_dump complete (${DUMP_SIZE})"

log "Uploading pg_dump to s3://${S3_BUCKET}/db-backups/"
aws s3 cp "$PG_DUMP_FILE" "s3://${S3_BUCKET}/db-backups/$(basename "$PG_DUMP_FILE")" $S3_FLAGS
log "pg_dump uploaded"

# --- 2. Prune old DB backups (keep last 30) ---
log "Pruning old backups (keeping last 30)..."
aws s3 ls "s3://${S3_BUCKET}/db-backups/" $S3_FLAGS \
  | sort -r \
  | tail -n +31 \
  | awk '{print $4}' \
  | while read -r old_file; do
      aws s3 rm "s3://${S3_BUCKET}/db-backups/${old_file}" $S3_FLAGS
      log "  Deleted: ${old_file}"
    done

log "Replication complete"
