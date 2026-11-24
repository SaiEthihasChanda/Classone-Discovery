#!/usr/bin/env bash
# Nightly MongoDB backup: one compressed archive per day in /var/backups/classone, 14 kept.
# Installed by setup.sh as /usr/local/bin/classone-backup and run from /etc/cron.d/classone-backup.
#
# Restore one:  mongorestore --gzip --archive=/var/backups/classone/classone-YYYY-MM-DD.archive.gz --drop
set -euo pipefail
DIR=/var/backups/classone
DB=$(grep -E '^MONGO_DB_NAME=' /opt/classone/app/.env | cut -d= -f2- || true)
DB=${DB:-classone_automation}
mkdir -p "$DIR"
FILE="$DIR/classone-$(date +%F).archive.gz"
mongodump --quiet --db "$DB" --gzip --archive="$FILE"
find "$DIR" -name 'classone-*.archive.gz' -mtime +14 -delete
echo "$(date -Is) backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
