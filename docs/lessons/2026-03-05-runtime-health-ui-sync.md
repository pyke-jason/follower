# Runtime Health UI Sync

## Problem

Channel scope selector showed a hardcoded green dot for runtime channels regardless of actual broker/runner health. When the live runner's circuit breaker was open due to broker failures (e.g., TradeStation 403), the UI gave no indication of degraded state. The `/status` API only returned DB/risk metrics, not runner health state.

## Decision

Persist runner health via a `runtime_health` DB table (single row per channel, upserted on state changes). The local-api reads it and includes health fields in `/status` for runtime channels. The web UI derives a tri-state health indicator (healthy/degraded/unknown) from the status payload.

Runner writes health on:
- init (baseline healthy)
- circuit breaker gate failure (degraded + last error)
- task success (healthy)
- task failure (degraded + error message)

Writes are synchronous (`run()`) and fire-and-forget — never block task processing.

## Key Files

- `src/db/schema.ts` — `runtimeHealth` table definition
- `drizzle/0028_friendly_avengers.sql` — migration (CREATE TABLE only)
- `src/live/runtime-health.ts` — `upsertRuntimeHealth()` helper
- `src/live/runner.ts` — upsert calls at key transitions
- `src/local-api/routes/web-queries.ts` — `GET /status` includes runtime health fields
- `web/stores/channel-store.ts` — `StatusData` extended with health fields; stale status cleared on fetch failure
- `web/app/components/channel-scope-selector.tsx` — `HealthDot` component, state-driven dot color
- `web/app/components/top-bar.tsx` — shows alert indicator + error text when degraded
- `web/scripts/smoke-api-contracts.mjs` — `/status` contract assertions

## Watch Out

- The generated migration had snapshot drift (table rebuilds for already-applied changes). Was manually trimmed to only the `CREATE TABLE` statement. Future `db:generate` runs may still show drift until snapshots are reconciled.
- `upsertRuntimeHealth` uses `.run()` (synchronous libsql), not `.execute()`. This is intentional — health writes are cheap and must never leave a dangling promise.
- Health rows are only written for runtime channels. Backtest channels never get rows.
- The `HealthDot` in the dropdown list for non-selected channels shows `unknown` since we only have health data for the currently-selected channel.
