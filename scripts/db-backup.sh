#!/usr/bin/env bash
# db-backup.sh — Nightly backup of the trade_follower PostgreSQL database.
#
# Creates a pg_dump custom-format snapshot at:
#   ~/backups/trade-follower-3/YYYY-MM-DD.pgdump
#
# Validates: file size > MIN_BYTES, pg_restore --list integrity check.
# Prunes snapshots older than KEEP_DAYS.
#
# Usage:
#   bash scripts/db-backup.sh
#   POSTGRES_DATABASE_URL=postgres://... bash scripts/db-backup.sh

set -euo pipefail

BACKUP_DIR="${HOME}/backups/trade-follower-3"
DB_URL="${POSTGRES_DATABASE_URL:-${DATABASE_URL:-postgres://jason@127.0.0.1:5432/trade_follower}}"
DATE="$(date +%Y-%m-%d)"
BACKUP_FILE="${BACKUP_DIR}/${DATE}.pgdump"
MIN_BYTES=10240   # 10 KB — a real DB is always larger; catches empty/aborted dumps
KEEP_DAYS=14

mkdir -p "$BACKUP_DIR"

echo "[backup] $(date -Iseconds) Starting backup -> $BACKUP_FILE"

# pg_dump custom format: compressed, supports parallel pg_restore
pg_dump --format=custom --compress=6 "$DB_URL" -f "$BACKUP_FILE"

# ── Sanity check 1: file size ────────────────────────
ACTUAL_BYTES=$(stat -f%z "$BACKUP_FILE" 2>/dev/null || stat -c%s "$BACKUP_FILE")
if (( ACTUAL_BYTES < MIN_BYTES )); then
  echo "[backup] ERROR: dump too small (${ACTUAL_BYTES} B < ${MIN_BYTES} B minimum)" >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi

# ── Sanity check 2: valid pg_dump TOC ───────────────
if ! pg_restore --list "$BACKUP_FILE" > /dev/null 2>&1; then
  echo "[backup] ERROR: pg_restore --list failed — dump is corrupt" >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi

echo "[backup] OK — ${ACTUAL_BYTES} bytes, TOC valid"

# ── Prune old backups ────────────────────────────────
PRUNED=0
while IFS= read -r -d '' old; do
  echo "[backup] Pruning $old"
  rm -f "$old"
  (( PRUNED++ )) || true
done < <(find "$BACKUP_DIR" -maxdepth 1 -name "*.pgdump" -mtime +${KEEP_DAYS} -print0)

if (( PRUNED > 0 )); then
  echo "[backup] Pruned $PRUNED snapshot(s) older than ${KEEP_DAYS} days"
fi

echo "[backup] Done — $BACKUP_FILE"
