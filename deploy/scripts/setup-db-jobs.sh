#!/bin/bash
# Setup scheduled jobs on the DB server.
# Uploads just the compiled platform code needed for the nightly backup job.
#
# Usage (from your local machine, at repo root):
#   ./deploy/scripts/setup-db-jobs.sh <db-host> [prod|dev]
#
# Prerequisites:
#   - Platform must be built locally (cd platform && npm run build)
#   - /opt/euro-office/jobs.env must exist on the DB server (scp it first)

set -euo pipefail

DB_HOST="${1:-}"
ENV="${2:-prod}"

if [ -z "$DB_HOST" ]; then
  echo "Usage: $0 <db-host> [prod|dev]"
  echo ""
  echo "Examples:"
  echo "  $0 162.55.44.102 prod"
  echo "  $0 167.233.233.99 dev"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== Setting up scheduled jobs on DB server ($DB_HOST, $ENV) ==="

# 1. Install Node.js on the server if needed
echo "[1/5] Ensuring Node.js is installed..."
ssh "root@${DB_HOST}" 'command -v node >/dev/null || (curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs)'

# 2. Build platform locally if not already built
echo "[2/5] Checking local platform build..."
if [ ! -d "$REPO_ROOT/platform/dist" ]; then
  echo "  Building platform..."
  cd "$REPO_ROOT/platform" && npm run build
fi

# 3. Upload platform dist + package files + scripts
echo "[3/5] Uploading files to DB server..."
ssh "root@${DB_HOST}" "mkdir -p /opt/euro-office/platform /opt/euro-office/scripts /opt/euro-office/data"

# Platform dist (compiled JS)
rsync -az --delete "$REPO_ROOT/platform/dist/" "root@${DB_HOST}:/opt/euro-office/platform/dist/"
# package.json for npm install
scp "$REPO_ROOT/platform/package.json" "root@${DB_HOST}:/opt/euro-office/platform/package.json"
scp "$REPO_ROOT/platform/package-lock.json" "root@${DB_HOST}:/opt/euro-office/platform/package-lock.json" 2>/dev/null || true
# Config directory (epub-styles.css, font-mappings.json if exists)
rsync -az "$REPO_ROOT/platform/config/" "root@${DB_HOST}:/opt/euro-office/platform/config/" 2>/dev/null || true
# Disposable email refresh script + data
scp "$REPO_ROOT/deploy/scripts/refresh-disposable-emails.sh" "root@${DB_HOST}:/opt/euro-office/scripts/refresh-disposable-emails.sh"
scp "$REPO_ROOT/deploy/data/disposable-domains.txt" "root@${DB_HOST}:/opt/euro-office/data/disposable-domains.txt"

# 4. Install Node dependencies on server
echo "[4/5] Installing dependencies on server..."
ssh "root@${DB_HOST}" "cd /opt/euro-office/platform && npm install --omit=dev"

# 5. Set up crons
echo "[5/5] Configuring cron jobs..."
ssh "root@${DB_HOST}" "chmod +x /opt/euro-office/scripts/refresh-disposable-emails.sh"

ssh "root@${DB_HOST}" bash -c "'
# Nightly backup email (03:00 UTC daily)
cat > /etc/cron.d/euro-office-nightly-backup << EOF
0 3 * * * root cd /opt/euro-office/platform && env \\\$(cat /opt/euro-office/jobs.env | grep -v \"^#\" | grep -v \"^\\\$\" | xargs) node dist/jobs/nightly-backup.js >> /var/log/nightly-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/euro-office-nightly-backup

# Disposable email refresh (weekly Sunday 04:30)
cat > /etc/cron.d/euro-office-disposable-refresh << EOF
30 4 * * 0 root /opt/euro-office/scripts/refresh-disposable-emails.sh >> /var/log/disposable-emails-refresh.log 2>&1
EOF
chmod 644 /etc/cron.d/euro-office-disposable-refresh
'"

# Verify
echo ""
echo "=== Done ==="
echo "Verify jobs.env exists:"
ssh "root@${DB_HOST}" "[ -f /opt/euro-office/jobs.env ] && echo '  ✓ jobs.env found' || echo '  ✗ jobs.env MISSING — create it!'"
echo ""
echo "Test nightly backup:"
echo "  ssh root@${DB_HOST} \"cd /opt/euro-office/platform && env \\\$(cat /opt/euro-office/jobs.env | grep -v '^#' | grep -v '^\$' | xargs) node dist/jobs/nightly-backup.js\""
