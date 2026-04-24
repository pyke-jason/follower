#!/usr/bin/env bash
# Health-snapshot script for the live runner. Emits a fenced block meant to be
# slotted into docs/monitoring/app-health.md by the /loop-driven monitor.
#
# Prints to stdout; no file writes. Exit code is non-zero only when the shell
# itself cannot run the queries.
set -uo pipefail

DATABASE_URL="${POSTGRES_DATABASE_URL:-${DATABASE_URL:-postgres://jason@127.0.0.1:5432/trade_follower}}"
LOCAL_API="http://localhost:3791"

query() {
  psql "$DATABASE_URL" -P pager=off -x -c "$1"
}

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
query "SELECT channel_id, broker_healthy, circuit_open, left(last_error, 80) AS last_error, updated_at FROM runtime_health;"
echo '```'

echo
echo "### Tasks — last 60 min"
echo '```'
query "SELECT task_type, status, COUNT(*) n FROM tasks WHERE COALESCE(completed_at, created_at)::timestamptz > now() - interval '60 minutes' GROUP BY 1,2 ORDER BY 1,2;"
echo '```'

echo
echo "### Most recent failures (last 24h, up to 5)"
echo '```'
query "SELECT left(id, 8) id, task_type, model_provider, left(error, 90) error, completed_at FROM tasks WHERE status IN ('FAILED','EXPIRED') AND COALESCE(completed_at, created_at)::timestamptz > now() - interval '24 hours' ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 5;"
echo '```'

echo
echo "### Pending / in-progress (live channels only)"
echo '```'
query "SELECT status, COUNT(*) n, MIN(created_at) oldest FROM tasks WHERE status IN ('PENDING','IN_PROGRESS') AND channel_id LIKE 'ibkr:%' AND created_at::timestamptz > now() - interval '24 hours' GROUP BY 1;"
echo '```'
