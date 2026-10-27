#!/usr/bin/env bash
# scripts/backup.sh — бэкап базы данных lumen-chain
set -euo pipefail

BACKUP_DIR="${LUMEN_BACKUP_DIR:-/opt/lumen-backups}"
RETENTION_DAYS="${LUMEN_BACKUP_RETENTION:-7}"
DB_PATH="${LUMEN_HOME:-/root/.lumen}/chain.db"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$BACKUP_DIR/lumen-chain-$TIMESTAMP.sqlite3"

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_PATH" ]]; then
  echo "База не найдена: $DB_PATH"
  exit 1
fi

# SQLite-бэкап через .backup (атомарно)
sqlite3 "$DB_PATH" ".backup '$ARCHIVE'"
gzip -f "$ARCHIVE"

echo "Бэкап готов: ${ARCHIVE}.gz"

# Ротация
find "$BACKUP_DIR" -name 'lumen-chain-*.sqlite3.gz' -mtime +$RETENTION_DAYS -delete 2>/dev/null || true
echo "Храним последние $RETENTION_DAYS дней"
