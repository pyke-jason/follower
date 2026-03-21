# Auto-Recovery Hardening

**Date**: 2026-03-09

## Problem

System kept going down and staying down due to:
- OOM kills (exit 137) on the backend process → dev-up.ts tore down the entire stack with no restart
- Silent SignalR death → messages lost during downtime with no recovery
- Manual restart required every time

## Decisions

### 1. Backend auto-restart (dev-up.ts)

Replaced "critical service died → shutdown all" with `superviseBackend()`:
- Restarts the backend process with exponential backoff (5s → 60s)
- Resets restart counter after 5 min of stable running
- Sends Discord/Pushover alert on each restart
- Gives up after 10 consecutive failures

Only the API server still triggers full shutdown (it's stateless and usually means a code error, not OOM).

### 2. Gap-fill on reconnect (ingest.ts)

After any browser restart (not first boot), `gapFill()` fetches today's messages from the historical REST API. Dedup via `onConflictDoNothing` prevents duplicates. Runs non-blocking — SignalR starts receiving new messages immediately while gap-fill backfills in parallel.

### 3. Watchdog forces restart (ingest.ts)

Was: alert-only after 5 min silence.
Now: alert at 5 min, force `closeBrowser()` at 10 min. Browser close triggers the supervision loop's `await crashed` to resolve, restarting everything (browser → auth → SignalR → gap-fill).

## Key Files

- `scripts/dev-up.ts` — `superviseBackend()`, `sendSystemAlert` import
- `src/ingestion/ingest.ts` — `gapFill()`, `WATCHDOG_FORCE_RESTART_MS`, `isFirstBoot` flag

## Watch Out

- `fetchHistorical` uses the browser page for auth cookies via `resilient-fetcher.ts`. Gap-fill can only run when the page is alive.
- Gap-fill creates a `historicalFetchRuns` record in DB each time. Over time these accumulate — may want to prune old gap-fill runs.
- If the backend restarts and the PID lock file exists from the crashed instance, `acquireLock` will check if that PID is still alive. If the OOM-killed process left a stale lock, the new instance should succeed because the PID is dead.
