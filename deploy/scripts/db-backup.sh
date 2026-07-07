#!/bin/bash
# Nightly PostgreSQL backup to S3
# Installs as a cron job. Requires: aws-cli (or s3cmd), docker.
#
# Usage: ./db-backup.sh
# Cron:  0 3 * * * /opt/euro-office/repo/deploy/scripts/db-backup.sh >> /var/log/db-backup.log 2>&1

set -e

TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
BACKUP_FILE="/tmp/eurobureau-db-backup-${TIMESTAMP}.sql.gz"
S3_PATH="s3://${OVH_S3_BUCKET:-euro-office-replica}/backups/db/${TIMESTAMP}.sql.gz"

# Source env vars if running from cron
if [ -f /opt/euro-office/repo/deploy/.env ]; then
    set -a
    source /opt/euro-office/repo/deploy/.env
    set +a
fi

echo "[$(date)] Starting database backup..."

# Dump from Docker postgres container
docker compose -f /opt/euro-office/repo/deploy/docker-compose.yml exec -T postgres \
    pg_dump -U portal portal | gzip > "$BACKUP_FILE"

# For multi-server (external DB), use direct connection:
# PGPASSWORD="$DB_PASSWORD" pg_dump -h 10.0.1.10 -U portal portal | gzip > "$BACKUP_FILE"

FILESIZE=$(stat --printf="%s" "$BACKUP_FILE")
echo "[$(date)] Dump complete: ${FILESIZE} bytes"

# Upload to S3
if [ -n "$OVH_S3_ENDPOINT" ] && [ -n "$OVH_S3_ACCESS_KEY" ]; then
    AWS_ACCESS_KEY_ID="$OVH_S3_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$OVH_S3_SECRET_KEY" \
    aws s3 cp "$BACKUP_FILE" "$S3_PATH" \
        --endpoint-url "$OVH_S3_ENDPOINT" \
        --region "${OVH_S3_REGION:-eu-west-par}"
    echo "[$(date)] Uploaded to $S3_PATH"
else
    echo "[$(date)] WARNING: S3 credentials not configured, backup kept locally only"
fi

# Clean up local file
rm -f "$BACKUP_FILE"

# Delete backups older than 30 days from S3
if [ -n "$OVH_S3_ENDPOINT" ] && [ -n "$OVH_S3_ACCESS_KEY" ]; then
    CUTOFF=$(date -d '30 days ago' +%Y-%m-%d 2>/dev/null || date -v-30d +%Y-%m-%d)
    AWS_ACCESS_KEY_ID="$OVH_S3_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$OVH_S3_SECRET_KEY" \
    aws s3 ls "s3://${OVH_S3_BUCKET}/backups/db/" \
        --endpoint-url "$OVH_S3_ENDPOINT" \
        --region "${OVH_S3_REGION:-eu-west-par}" | while read -r line; do
        FILE_DATE=$(echo "$line" | awk '{print $1}')
        FILE_NAME=$(echo "$line" | awk '{print $4}')
        if [[ "$FILE_DATE" < "$CUTOFF" ]] && [ -n "$FILE_NAME" ]; then
            AWS_ACCESS_KEY_ID="$OVH_S3_ACCESS_KEY" \
            AWS_SECRET_ACCESS_KEY="$OVH_S3_SECRET_KEY" \
            aws s3 rm "s3://${OVH_S3_BUCKET}/backups/db/$FILE_NAME" \
                --endpoint-url "$OVH_S3_ENDPOINT" \
                --region "${OVH_S3_REGION:-eu-west-par}"
            echo "[$(date)] Deleted old backup: $FILE_NAME"
        fi
    done
fi

echo "[$(date)] Backup complete."
