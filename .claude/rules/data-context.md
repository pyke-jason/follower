# data/ — Database Schema & Context

Applies when working with files in `data/` or querying the SQLite databases.

## Files

| File | Purpose |
|---|---|
| `trade-follower.db` | Primary application database (89 MB + WAL) |
| `tick-cache.db` | Databento market data cache (779 MB) |
| `backend.lock` | PID file for the running backend process |
| `follower.db`, `local.db` | Empty placeholder files — not functional |

The primary DB runs in **WAL mode** (`.db-shm` + `.db-wal` files). Never delete WAL files while the backend is running.

---

## trade-follower.db Schema

### `messages` — Raw Discord messages (23,573 rows; Aug–Dec 2025)
```sql
CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  author           TEXT NOT NULL,
  timestamp        TEXT NOT NULL,
  raw_html         TEXT NOT NULL,
  clean_text       TEXT NOT NULL,
  badges           TEXT DEFAULT '[]',           -- JSON string[]
  symbols          TEXT DEFAULT '[]',           -- JSON string[]
  action_hint      TEXT,
  direction_hint   TEXT,
  detected_strategies TEXT DEFAULT '[]',        -- JSON string[]
  is_paper_trade   INTEGER DEFAULT false,
  has_multiple_trades INTEGER DEFAULT false,
  confidence       TEXT,
  ingested_at      TEXT
);
```
3 tracked traders: Pete, Hariseldon, Dave W. `badges`/`symbols`/`detected_strategies` are JSON arrays stored as TEXT.

### `trades` — Denormalized trade view (4,788 rows)
```sql
CREATE TABLE trades (
  id               TEXT PRIMARY KEY,
  task_id          TEXT,
  source_message_id TEXT,
  trader           TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  direction        TEXT NOT NULL,               -- LONG | SHORT
  strategy         TEXT NOT NULL,               -- NAKED_CALL, PCS, CDS, STRANGLE, etc.
  legs             TEXT NOT NULL,               -- JSON TradeSignalLeg[]
  status           TEXT DEFAULT 'OPEN',         -- OPEN | CLOSED | TRIMMED
  entry_price      TEXT,
  exit_price       TEXT,
  quantity         INTEGER DEFAULT 1,
  pnl              TEXT,
  opened_at        TEXT,
  closed_at        TEXT,
  close_message_id TEXT,
  is_backtest      INTEGER DEFAULT false,
  metadata         TEXT DEFAULT '{}',           -- JSON
  backtest_run_id  TEXT,
  broker_fill_price TEXT,
  broker_fill_qty  INTEGER,
  broker_commission TEXT,
  broker_fill_time TEXT,
  broker_leg_fills TEXT,                        -- JSON per-leg fill details
  avg_entry_price  TEXT,
  realized_pnl     TEXT
);
```
Source of truth is `trade_events`, not this table. `recordTrade()` is the only write path. `legs` JSON shape: `[{ symbol, side, quantity, expiry, strike, type }]`.

### `trade_events` — Append-only event log (3,565 rows)
```sql
CREATE TABLE trade_events (
  id         TEXT PRIMARY KEY,
  trade_id   TEXT NOT NULL REFERENCES trades(id),
  action     TEXT NOT NULL,     -- OPEN | CLOSE | TRIM | LEG_OFF | ADD
  price      TEXT,
  quantity   INTEGER,
  legs       TEXT DEFAULT '[]', -- JSON legs involved in this event
  strategy   TEXT,
  direction  TEXT,
  message_id TEXT,
  metadata   TEXT DEFAULT '{}',
  timestamp  TEXT NOT NULL,
  created_at TEXT
);
```

### `run_decisions` — Backtest per-message decisions (60,710 rows)
```sql
CREATE TABLE run_decisions (
  id               TEXT PRIMARY KEY,
  backtest_run_id  TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  path             TEXT NOT NULL,  -- intent | agent | deterministic | skipped | pipeline_failure
  decision         TEXT NOT NULL,  -- EXECUTE | SKIP
  reasoning        TEXT,
  trade_id         TEXT,
  pnl              TEXT,
  duration_ms      INTEGER,
  created_at       TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  skip_category    TEXT
);
```
Decision distribution: ~21k agent skip, ~14k intent skip, ~5.3k skipped, ~8.6k EXECUTE.

### `message_intents` — LLM intent cache (9,402 rows)
```sql
CREATE TABLE message_intents (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id),
  model         TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,  -- INTENT_VERSION in extract-intent.ts
  decision      TEXT NOT NULL,               -- TRADE | IGNORE
  reasoning     TEXT,
  signals       TEXT,                        -- JSON Signal[]
  duration_ms   INTEGER,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  turns         INTEGER,
  steps         TEXT,
  created_at    TEXT
);
CREATE UNIQUE INDEX idx_intents_unique ON message_intents(message_id, model, version);
```
Cache key: `(message_id, model, version)`. Bump `INTENT_VERSION` in `extract-intent.ts` to invalidate.

### `backtest_runs` — Run metadata (194 rows)
Columns: `id`, `name`, `experiment_tag`, `parent_run_id`, `pinned`, `status`, `started_at`, `completed_at`, `extended_metrics` (JSON), `live_metrics` (JSON).

### `backtest_mtm_snapshots` — Daily mark-to-market (2,323 rows)
Daily portfolio value per backtest run. Used for equity curve charting.

### `tasks` / `task_steps` — Agent task queue (3,686 tasks)
Internal agent orchestration with per-step reasoning/tool call logs.

### `message_labels` — Manual eval labels (658 rows)
Ground truth for intent extraction evaluation.

### Empty tables (schema exists, no data)
`eval_runs`, `daily_balances`, `historical_fetch_runs`, `reconciliation_alerts`

---

## tick-cache.db Schema

### `quote_ticks` — 7.8M rows
Raw tick data. Key: `(symbol, dbn_schema, timestamp)`.

### `tick_cache_ranges` — 45,144 rows
Tracks fetched `(symbol, schema, start_date, end_date)` ranges to prevent redundant API calls.
Coverage: `ohlcv-1d` (295 ranges), `ohlcv-1m` (10,515), `cbbo-1s` (34,334).
**Databento charges per byte — never delete valid cache entries.**

### `chain_definitions`, `chain_cache_meta` — empty (not yet in use)

---

## Useful Queries

```sql
-- Recent live trades
SELECT * FROM trades WHERE is_backtest = 0 ORDER BY opened_at DESC LIMIT 20;

-- Backtest run list
SELECT id, name, experiment_tag, status FROM backtest_runs ORDER BY started_at DESC LIMIT 10;

-- Skip reasons for a run
SELECT skip_category, count(*) FROM run_decisions
WHERE backtest_run_id = '<id>' AND decision = 'SKIP'
GROUP BY skip_category ORDER BY count(*) DESC;

-- Intent cache by model/version
SELECT model, version, count(*) FROM message_intents GROUP BY model, version;

-- Tick cache coverage
SELECT dbn_schema, count(*), min(start_date), max(end_date)
FROM tick_cache_ranges GROUP BY dbn_schema;
```
