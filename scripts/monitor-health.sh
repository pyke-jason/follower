#!/usr/bin/env bash
# Health-snapshot script for the live runner. Emits a fenced block meant to be
# slotted into docs/monitoring/app-health.md by the /loop-driven monitor.
#
# Prints to stdout; no file writes. Exit code is non-zero only when the shell
# itself cannot run the queries.
set -uo pipefail

DB="/Users/jason/Workspace/trade-follower-3/data/trade-follower.db"
LOCAL_API="http://localhost:3791"

echo "## Snapshot $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
echo

# Process check — match the exact entrypoint (src/index.ts) under tsx
if pgrep -f "tsx.*src/index.ts" > /dev/null 2>&1; then
  PID=$(pgrep -f "tsx.*src/index.ts" | head -1)
  UPTIME=$(ps -o etime= -p "$PID" 2>/dev/null | tr -d ' ')
  RSS_KB=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ')
  RSS_MB=$((RSS_KB / 1024))
  echo "- Backend: UP (pid=$PID, uptime=$UPTIME, rss=${RSS_MB}MB)"
else
  echo "- Backend: **DOWN** — no tsx src/index.ts process"
fi

# Local API health probe (2s timeout)
if HEALTH=$(curl -sf --max-time 2 "$LOCAL_API/health" 2>/dev/null); then
  echo "- Local API /health: $HEALTH"
else
  echo "- Local API /health: **UNREACHABLE**"
fi

echo
echo "### Runtime health (per channel)"
echo '```'
sqlite3 -header -column "$DB" "SELECT channel_id, broker_healthy, circuit_open, substr(last_error,1,80) AS last_error, updated_at FROM runtime_health;"
echo '```'

echo
echo "### Tasks — last 60 min"
echo '```'
sqlite3 -header -column "$DB" "SELECT task_type, status, COUNT(*) n FROM tasks WHERE COALESCE(completed_at, created_at) > datetime('now','-60 minutes') GROUP BY 1,2 ORDER BY 1,2;"
echo '```'

echo
echo "### Most recent failures (last 24h, up to 5)"
echo '```'
sqlite3 -header -column "$DB" "SELECT substr(id,1,8) id, task_type, model_provider, substr(error,1,90) error, completed_at FROM tasks WHERE status IN ('FAILED','EXPIRED') AND COALESCE(completed_at, created_at) > datetime('now','-24 hours') ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 5;"
echo '```'

echo
echo "### Pending / in-progress (live channels only)"
echo '```'
sqlite3 -header -column "$DB" "SELECT status, COUNT(*) n, MIN(created_at) oldest FROM tasks WHERE status IN ('PENDING','IN_PROGRESS') AND channel_id LIKE 'ibkr:%' AND created_at > datetime('now','-24 hours') GROUP BY 1;"
echo '```'
