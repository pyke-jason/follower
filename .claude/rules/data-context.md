# data/ — Database Context

Applies when working with files in `data/` or querying SQLite databases.

## Files

| File | Purpose |
|---|---|
| `trade-follower.db` | Primary app DB (WAL mode — never delete `.db-shm`/`.db-wal` while backend runs) |
| `tick-cache.db` | Databento market data cache (**charges per byte — never delete valid cache entries**) |
| `follower.db`, `local.db` | Empty placeholders — ignore |

## trade-follower.db — Key Tables

- **`messages`** — Raw Discord messages. 3 traders: Pete, Hariseldon, Dave W. `badges`/`symbols`/`detected_strategies` are JSON arrays as TEXT.
- **`trades`** — Denormalized view. Source of truth is `trade_events`. `recordTrade()` is the only write path. `legs` JSON: `[{ symbol, side, quantity, expiry, strike, type }]`.
- **`trade_events`** — Append-only event log. Actions: OPEN | CLOSE | TRIM | LEG_OFF | ADD.
- **`message_intents`** — LLM intent cache. Key: `(message_id, model, version)`. Bump `INTENT_VERSION` in `extract-intent.ts` to invalidate.
- **`run_decisions`** — Backtest per-message decisions. Path: intent | agent | deterministic | skipped | pipeline_failure.
- **`backtest_runs`** — Run metadata with `extended_metrics` and `live_metrics` JSON.
- **`backtest_mtm_snapshots`** — Daily mark-to-market for equity curves.
- **`tasks`/`task_steps`** — Internal agent orchestration.
- **`message_labels`** — Manual eval ground truth (658 rows).

## tick-cache.db — Key Tables

- **`quote_ticks`** — Raw tick data. Key: `(symbol, dbn_schema, timestamp)`.
- **`tick_cache_ranges`** — Tracks fetched date ranges to prevent redundant API calls. Schemas: `ohlcv-1d`, `ohlcv-1m`, `cbbo-1s`.

## Useful Queries

```sql
SELECT * FROM trades WHERE is_backtest = 0 ORDER BY opened_at DESC LIMIT 20;
SELECT id, name, experiment_tag, status FROM backtest_runs ORDER BY started_at DESC LIMIT 10;
SELECT skip_category, count(*) FROM run_decisions WHERE backtest_run_id = '<id>' AND decision = 'SKIP' GROUP BY skip_category ORDER BY count(*) DESC;
SELECT model, version, count(*) FROM message_intents GROUP BY model, version;
SELECT dbn_schema, count(*), min(start_date), max(end_date) FROM tick_cache_ranges GROUP BY dbn_schema;
```
