#!/bin/bash
# Nightly PostgreSQL backup to S3
# Runs directly on the DB server (no Docker dependency).
#
# Usage: ./db-backup.sh [dev|prod]
# Cron:  0 3 * * * /opt/euro-office/scripts/db-backup.sh >> /var/log/db-backup.log 2>&1
#
# Requires: aws-cli, postgresql-client
# Install: apt install awscli postgresql-client-16

set -e

ENV="${1:-prod}"
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
BACKUP_FILE="/tmp/eurobureau-${ENV}-db-backup-${TIMESTAMP}.sql.gz"

# Source env vars (placed on DB server during provisioning)
ENV_FILE="/opt/euro-office/db-backup.env"
if [ -f "$ENV_FILE" ]; then
    set -a
    source "$ENV_FILE"
    set +a
else
    echo "[$(date)] ERROR: $ENV_FILE not found. Create it with S3 credentials."
    exit 1
fi

S3_PREFIX="backups/${ENV}/db"
S3_PATH="s3://${OVH_S3_BUCKET}/${S3_PREFIX}/${TIMESTAMP}.sql.gz"

echo "[$(date)] Starting ${ENV} database backup..."

# Dump directly (running on the DB server itself)
sudo -u postgres pg_dump portal | gzip > "$BACKUP_FILE"

FILESIZE=$(stat --printf="%s" "$BACKUP_FILE")
echo "[$(date)] Dump complete: ${FILESIZE} bytes ($(numfmt --to=iec $FILESIZE))"

# Upload to S3
if [ -n "$OVH_S3_ENDPOINT" ] && [ -n "$OVH_S3_ACCESS_KEY" ]; then
    AWS_ACCESS_KEY_ID="$OVH_S3_ACCESS_KEY" \
    AWS_SECRET_ACCESS_KEY="$OVH_S3_SECRET_KEY" \
    aws s3 cp "$BACKUP_FILE" "$S3_PATH" \
        --endpoint-url "$OVH_S3_ENDPOINT" \
        --region "${OVH_S3_REGION:-eu-west-par}"
    echo "[$(date)] Uploaded to $S3_PATH"
else
    echo "[$(date)] ERROR: S3 credentials not configured"
    rm -f "$BACKUP_FILE"
    exit 1
fi

# Clean up local file
rm -f "$BACKUP_FILE"

# Delete backups older than 30 days from S3
CUTOFF=$(date -d '30 days ago' +%Y-%m-%d)
echo "[$(date)] Pruning backups older than $CUTOFF..."

AWS_ACCESS_KEY_ID="$OVH_S3_ACCESS_KEY" \
AWS_SECRET_ACCESS_KEY="$OVH_S3_SECRET_KEY" \
aws s3 ls "s3://${OVH_S3_BUCKET}/${S3_PREFIX}/" \
    --endpoint-url "$OVH_S3_ENDPOINT" \
    --region "${OVH_S3_REGION:-eu-west-par}" 2>/dev/null | while read -r line; do
    FILE_DATE=$(echo "$line" | awk '{print $1}')
    FILE_NAME=$(echo "$line" | awk '{print $4}')
    if [[ -n "$FILE_NAME" && "$FILE_DATE" < "$CUTOFF" ]]; then
        AWS_ACCESS_KEY_ID="$OVH_S3_ACCESS_KEY" \
        AWS_SECRET_ACCESS_KEY="$OVH_S3_SECRET_KEY" \
        aws s3 rm "s3://${OVH_S3_BUCKET}/${S3_PREFIX}/$FILE_NAME" \
            --endpoint-url "$OVH_S3_ENDPOINT" \
            --region "${OVH_S3_REGION:-eu-west-par}"
        echo "[$(date)] Deleted old backup: $FILE_NAME"
    fi
done

echo "[$(date)] Backup complete."
