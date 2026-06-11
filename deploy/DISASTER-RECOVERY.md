# Disaster Recovery

This documents how to restore the Euro-Office platform from OVH Object Storage backups after a total data loss (volume destroyed, server replaced, etc.).

## Prerequisites

- A running server with Docker installed (e.g. fresh Terraform apply)
- AWS CLI v2 installed on the server
- Access to the OVH S3 credentials (in `deploy/.env`)
- A new Hetzner volume attached and mounted

## 1. Prepare the volume

```bash
# Find the Hetzner volume mount
VOLUME_MOUNT=$(find /mnt -maxdepth 1 -name "HC_Volume_*" -type d | head -1)
ln -sfn "$VOLUME_MOUNT" /mnt/euro-office-data

# Create required directories
mkdir -p /mnt/euro-office-data/postgresql
mkdir -p /mnt/euro-office-data/files
chown 999:999 /mnt/euro-office-data/postgresql
```

## 2. Load environment and configure AWS CLI

```bash
source /opt/euro-office/repo/deploy/.env
export AWS_ACCESS_KEY_ID="$OVH_S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$OVH_S3_SECRET_KEY"
export AWS_DEFAULT_REGION="$OVH_S3_REGION"
```

## 3. Restore files from OVH

```bash
aws s3 sync "s3://${OVH_S3_BUCKET}/files/" /mnt/euro-office-data/files/ \
  --endpoint-url "$OVH_S3_ENDPOINT"
```

## 4. Restore PostgreSQL

```bash
# Start only postgres
cd /opt/euro-office/repo/deploy
docker compose up -d postgres

# Download the latest dump
LATEST=$(aws s3 ls "s3://${OVH_S3_BUCKET}/db-backups/" --endpoint-url "$OVH_S3_ENDPOINT" | sort | tail -1 | awk '{print $4}')
aws s3 cp "s3://${OVH_S3_BUCKET}/db-backups/$LATEST" /tmp/restore.sql.gz \
  --endpoint-url "$OVH_S3_ENDPOINT"

# Restore into the database
gunzip -c /tmp/restore.sql.gz | docker exec -i deploy-postgres-1 psql -U portal -d portal
```

## 5. Bring up the full stack

```bash
docker compose up -d
```

## 6. Verify

- Log in (sessions will be lost — users need to re-authenticate)
- Confirm files are listed and openable
- Check document editing works

## Notes

- **RPO (Recovery Point Objective):**
  - Files: near-zero (dual-write replicates on every upload/delete)
  - Database: up to 24 hours (daily pg_dump at 03:00 UTC)
- **RTO (Recovery Time Objective):** ~15 minutes for small datasets, scales with file count
- **Sessions:** lost on any server replacement (stored in Redis on ephemeral Docker volume)
- **TLS certificates:** Caddy re-issues automatically on first HTTPS request
