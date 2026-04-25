#!/usr/bin/env bash
# db-restore.sh — Restore trade_follower from a pg_dump snapshot.
#
# Workflow:
#   1. Stops the backend (via data/backend.lock PID)
#   2. Terminates all other DB connections
#   3. Drops and recreates trade_follower
#   4. Restores from the named snapshot
#
# Usage:
#   bash scripts/db-restore.sh <YYYY-MM-DD>
#   npm run db:restore -- <YYYY-MM-DD>
#
# CAUTION: This is destructive. The live database is dropped and replaced.
# Always verify the backup file before running against production.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${HOME}/backups/trade-follower-3"
DB_URL="${POSTGRES_DATABASE_URL:-${DATABASE_URL:-postgres://jason@127.0.0.1:5432/trade_follower}}"
LOCK_FILE="${ROOT}/data/backend.lock"

# ── Arg: date ────────────────────────────────────────
DATE="${1:-}"
if [[ -z "$DATE" ]]; then
  echo "Usage: $0 <YYYY-MM-DD>" >&2
  echo "" >&2
  echo "Available snapshots:" >&2
  if ls "$BACKUP_DIR"/*.pgdump 2>/dev/null | head -20 | xargs -I{} basename {} .pgdump; then
    :
  else
    echo "  (none — run 'npm run db:backup' first)" >&2
  fi
  exit 1
fi

BACKUP_FILE="${BACKUP_DIR}/${DATE}.pgdump"
if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "[restore] ERROR: snapshot not found: $BACKUP_FILE" >&2
  exit 1
fi

# ── Confirm ──────────────────────────────────────────
echo ""
echo "  !! DESTRUCTIVE OPERATION !!"
echo "  This will DROP and replace: trade_follower"
echo "  Snapshot: $BACKUP_FILE"
echo ""
read -r -p "  Type 'yes' to continue: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "[restore] Aborted."
  exit 0
fi

# ── Stop the backend ─────────────────────────────────
if [[ -f "$LOCK_FILE" ]]; then
  PID="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "[restore] Stopping backend (PID $PID)..."
    kill -SIGTERM "$PID"
    # Wait up to 10s for graceful exit
    for _ in {1..10}; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$PID" 2>/dev/null; then
      echo "[restore] Force-killing backend (PID $PID)"
      kill -SIGKILL "$PID"
    fi
    rm -f "$LOCK_FILE"
    echo "[restore] Backend stopped"
  else
    echo "[restore] Backend not running (stale lock)"
    rm -f "$LOCK_FILE"
  fi
else
  echo "[restore] No backend.lock — assuming bot is not running"
fi

# ── Derive DB name and maintenance URL ───────────────
DB_NAME="${DB_URL##*/}"          # everything after the last /
MAINT_URL="${DB_URL%/*}/postgres"  # swap DB name for postgres (maintenance db)

echo "[restore] Terminating active connections to $DB_NAME..."
psql "$MAINT_URL" -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid)
FROM   pg_stat_activity
WHERE  datname = '${DB_NAME}' AND pid <> pg_backend_pid();
SQL

echo "[restore] Dropping $DB_NAME..."
psql "$MAINT_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${DB_NAME}\";"

echo "[restore] Recreating $DB_NAME..."
psql "$MAINT_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${DB_NAME}\";"

echo "[restore] Restoring from $BACKUP_FILE..."
# --no-privileges / --no-owner: skip role grants; user owns everything locally
pg_restore --format=custom --no-privileges --no-owner \
  -d "$DB_URL" \
  "$BACKUP_FILE"

echo ""
echo "[restore] Done — $DB_NAME restored from $DATE snapshot."
echo ""
echo "  Next steps:"
echo "    npm run db:migrate   # apply any migrations newer than this snapshot"
echo "    npm run up       # restart the bot"
