# data/ — Database Context

Applies when working with files in `data/` or querying SQLite databases.

## Files

| File | Purpose |
|---|---|
| `trade-follower.db` | Primary app DB (WAL mode — never delete `.db-shm`/`.db-wal` while backend runs) |
| `tick-cache.db` | Databento market data cache (**charges per byte — never delete valid cache entries**) |
| `follower.db`, `local.db` | Empty placeholders — ignore |

## Channel-based scoping

Trades, tasks, and decisions are scoped by `channel_id` with format `live:<accountId>`, `bt:<runId>`, or `paper:<accountId>`. See `src/lib/channel.ts` for helpers (`parseChannel`, `liveChannel`, `btChannel`, `paperChannel`).

## trade-follower.db — Key Tables

`src/db/schema.ts` is the authoritative source for all table definitions. Key tables:

- **`messages`** — Raw Discord messages. `author` field names tracked traders (see `tracked_traders` table). `badges`/`symbols`/`detected_strategies` are JSON arrays as TEXT.
- **`trades`** — Denormalized view. Source of truth is `trade_events`. `recordTrade()` is the only write path. `legs` JSON shape defined by `TradeLegSchema` in `schema.ts`.
- **`trade_events`** — Append-only event log. Actions defined in schema comment (e.g. OPEN, CLOSE, TRIM, LEG_OFF, ADD).
- **`message_intents`** — LLM intent cache. Key: `(message_id, model, version)`. Bump the `version` column value to invalidate old entries.
- **`run_decisions`** — Per-message decision log. Key columns: `event`, `outcome`, `phase`, `skip_category`. See schema.ts for current enum values. Legacy columns `path` and `decision` exist but are unused.
- **`backtest_runs`** — Run metadata with `extended_metrics` and `live_metrics` JSON.
- **`backtest_mtm_snapshots`** — Daily mark-to-market for equity curves.
- **`tasks`** — Internal agent orchestration.
- **`message_labels`** — Manual eval ground truth.
- **`tracked_traders`** — Trader configuration (enabled flag, strategies, position sizing).
- **`daily_balances`** — IBKR account snapshots (cash, equity, buying power, P&L).
- **`reconciliation_alerts`** — Broker vs DB position mismatches.
- **`orphan_fills`** — Broker fills with no matching DB trade.
- **`historical_fetch_runs`** / **`historical_fetch_chunks`** — Discord message backfill tracking.

## tick-cache.db — Key Tables

DDL defined in `src/db/tick-cache-client.ts` (hand-written, not Drizzle-managed).

- **`quote_ticks`** — Raw tick data. Key: `(symbol, dbn_schema, timestamp)`.
- **`tick_cache_ranges`** — Tracks fetched time ranges to prevent redundant API calls. See DDL in `tick-cache-client.ts` for columns.
- **`chain_definitions`** — Options chain data per dataset/parent/day.
- **`chain_cache_meta`** — Tracks which chain lookups have been fetched.

## Useful Queries

```sql
SELECT * FROM trades WHERE channel_id LIKE 'live:%' ORDER BY opened_at DESC LIMIT 20;
SELECT id, name, experiment_tag, status FROM backtest_runs ORDER BY started_at DESC LIMIT 10;
SELECT skip_category, count(*) FROM run_decisions WHERE channel_id = 'bt:<runId>' AND outcome = 'SKIP' GROUP BY skip_category ORDER BY count(*) DESC;
SELECT model, version, count(*) FROM message_intents GROUP BY model, version;
SELECT dbn_schema, count(*), min(start_ms), max(end_ms) FROM tick_cache_ranges GROUP BY dbn_schema;
```
