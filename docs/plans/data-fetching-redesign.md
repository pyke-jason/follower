# Data Fetching & Prefetch Redesign

## Problem

The current system has three intertwined issues:

1. **prefetchForAgent bundles unrelated concerns**: Quotes, positions, and trader config are fetched together in one try/catch. A quote fetch failure silently kills the trader config, which silently disables strategy gating. The nullable chain `prefetched?.traderProfile?.strategies` is a symptom — the real disease is coupling independent data behind a single failure boundary.

2. **Databento fetches are eager and coarse**: The backtest loads full-day ohlcv-1m tapes (~390 records/symbol/day) for every symbol mentioned in a message, even when we only need a single quote at one timestamp. Options data (cbbo-1s) is even worse — thousands of records per symbol per day. There's no concept of "fetch 2 minutes of data around this timestamp."

3. **No tiered data model**: Every data consumer gets the same granularity. Checking if a limit order fills needs 1-second option data around the fill window. Tracking a position for drawdown needs 1-15 minute OHLCV. Daily P&L needs end-of-day snapshots. These are 3 different data tiers but the system treats them as one.

## Current Architecture (What Exists)

```
Signal arrives
  └─ prefetchForAgent()          ← bundles quotes + positions + trader config
       ├─ fetchQuotes()          ← broker.getQuote() per symbol
       ├─ getOpenPositions()     ← DB query
       └─ getTraderConfig()      ← DB query (cached 60s)
  └─ shouldSkipDeterministic()   ← uses prefetched (fails open if undefined)
  └─ agent / intent extraction
  └─ executeSignals()            ← re-fetches quotes, sizes, risk checks

Backtest data layer:
  DatabentoMarketDataProvider
    ├─ dayTicks: Map<"SYM:DAY", QuoteTick[]>   ← in-memory, loaded from disk cache
    ├─ loadDay() → loadQuoteTapeForDay()        ← ALWAYS fetches full 9:30-4:00
    ├─ getQuote() → loadDay() → binary search   ← loads 390 bars to find 1
    ├─ getTicksInRange() → loadDay() per day     ← loads full day to filter a narrow window
    └─ prefetch() → loadQuoteTapeForDay()        ← same full-day path

  fetchTickWindow() in databento-tape.ts:1333    ← accepts arbitrary start/end, NEVER CALLED

Databento disk cache:
  .cache/databento/{sha256}.json
  Key = "dataset|schema|symbol|day"
  Granularity: always full trading day
```

### What's Wrong

**`loadDay()` and `loadQuoteTapeForDay()` should not exist.** No use case needs a full day. What a trade actually needs:

```
Open signal arrives (e.g. "buy AAPL")
  1. ATR for position sizing     → 14 daily bars (ohlcv-1d, already efficient via getBars())
  2. Quote for sizing            → 1 tick at signal timestamp
  3. Fill simulation             → 1m of data, then another 1m, up to 5m total

  <wait for close message>
  4. Drawdown tracking           → minutes of OHLCV between messages (advanceTo window)

Close signal arrives
  5. Fill simulation             → same as #3
```

Every step needs minutes of data, never hours. The Databento API accepts arbitrary `start`/`end`. `fetchTickWindow()` already wraps this — nothing calls it. Everything goes through `loadDay()` → `dayRangeUTC()` → full 6.5-hour fetch. For options (cbbo-1s) that's thousands of records when you need ~60.

Other problems:
- **prefetchForAgent** bundles unrelated concerns. Quote fetch failure silently kills trader config → silently disables strategy gating.
- **Trader config** is a DB row that changes rarely. Should never be bundled with volatile market data fetches.

## Existing Cache (Must Preserve)

60,472 files, 1.9 GB total in `.cache/databento/`:
- 17,326 empty `[]` files (weekends/holidays/no-data — valid, never delete)
- 42,632 tick array files (QuoteTick[])
- 514 daily bar files (single Bar object)

By data type:
- ~33K option contract files (OCC symbols, cbbo-1s)
- ~10K equity files (ohlcv-1m)
- ~514 daily bar files (ohlcv-1d)

This data cost real money to fetch. Every phase must read old-format files correctly.

## Target Architecture

### Principle: Fetch the minimum data at the moment you need it, at the granularity you need it.

### 1. Kill prefetchForAgent

Replace the bundled prefetch with direct, purpose-specific calls at the point of use:

- **Trader config**: `getTrader(name)` — already cached 60s, already imported everywhere. Call it directly where needed. Never source from a bundled fetch result.
- **Positions**: Query at the decision point (deterministic skips, risk check). Already happens in `checkRiskLimits` and `executeSignal`.
- **Quotes**: Fetch on demand when the pipeline needs a price (fill check, sizing, mark-to-market). Not before.

The LLM agent (live path) currently gets prefetched quotes in its prompt context. Replace with: agent calls `get_quote` tool when it needs a price. The tool calls are cheap (live: one API call, backtest: cache hit or narrow window fetch). The LLM already has these tools — removing the prefetched context just stops giving it stale data.

What this eliminates:
- The `PrefetchedData` type and its nullable `traderProfile`
- The try/catch-swallowed failure mode
- Eager quote fetches for symbols the agent may not trade
- The `?.` chains that silently degrade behavior

### 2. Delete loadDay / loadQuoteTapeForDay

`loadDay()` and `loadQuoteTapeForDay()` get deleted. They have no valid use case. Every consumer asks for a window, never a full day.

Replace with: callers request exactly what they need, backed by `fetchTickWindow()` (already exists in `databento-tape.ts:1333`, accepts arbitrary `start`/`end`) + an interval-merging cache.

**getQuote(symbol, at)** — fetch 1 minute around `at`, binary search for the tick.
**getTicksInRange(symbol, from, to)** — fetch exactly `[from, to]`, return all ticks.
**prefetch(symbols, at)** — fetch 1 minute around `at` per symbol.
**getBars(symbol, barsBack, at)** — already uses `ohlcv-1d`, no change.

### 3. Interval-Merging Cache

Cache is still per-symbol-day on disk (same `{sha256}.json` paths). But instead of "you have the full day or nothing," each file tracks which time ranges it covers.

```
Cache for AAPL on 2025-10-15:
  ranges: [ [09:30, 09:32], [10:14, 10:16], [15:58, 16:00] ]
  ticks: QuoteTick[]  (sorted, covering those ranges only)

getQuote(AAPL, 10:15)
  → need [10:14, 10:16] → already covered → cache hit

getTicksInRange(AAPL, 10:19, 10:21)
  → [10:19, 10:21] not covered → fetchTickWindow → merge
  → ranges becomes [ [09:30, 09:32], [10:14, 10:21], [15:58, 16:00] ]
```

For a typical backtest day with 5-10 messages: ~20-30 minutes of data fetched instead of 6.5 hours. For options (cbbo-1s): ~120 records per window instead of thousands per day.

## Cache Migration Plan

### Constraint: Zero data loss, zero re-fetching

The 60K cached files represent real spend. The new interval-merging cache format is different from the current flat-array format. Migration must be seamless.

### Old format (current)

```typescript
// File: .cache/databento/{sha256}.json
// Contents: QuoteTick[] (flat array, full trading day)
[
  {"symbol":"AAPL","bid":150.10,"ask":150.12,"timestamp":"2025-10-15T13:30:00Z"},
  {"symbol":"AAPL","bid":150.11,"ask":150.13,"timestamp":"2025-10-15T13:31:00Z"},
  ...
]
```

### New format (target)

```typescript
// File: .cache/databento/{sha256}.json (same path, same hash key)
// Contents: envelope with range metadata
{
  "v": 2,
  "ranges": [[1729000200000, 1729023600000]],  // UTC ms intervals covered
  "ticks": [
    {"symbol":"AAPL","bid":150.10,"ask":150.12,"timestamp":"2025-10-15T13:30:00Z"},
    ...
  ]
}
```

### Migration strategy: read-both, write-new

1. **readCache()** detects format by checking if the parsed JSON is an array (v1) or an object with `"v": 2` (v2).
   - v1 (array): treat as a single range covering `[firstTick.timestamp, lastTick.timestamp]`. Return ticks as-is.
   - v2 (object): read ranges and ticks from the envelope.
   - This is one `if (Array.isArray(parsed))` check. No batch migration script needed.

2. **writeCache()** always writes v2 format.

3. **On cache hit with partial coverage**: If the cached ranges don't cover the requested window, fetch the gap from the API, merge the new ticks into the existing array, extend the ranges, write back as v2. The original v1 data is preserved inside the merged v2 file.

4. **On first read of a v1 file that gets extended**: The v1 file is read, treated as a full-day range, and any new window request within that day is a cache hit (the full day already covers it). Only if a request falls outside the cached day's range (shouldn't happen — ranges are per-day) would a re-fetch occur.

### What this means in practice

- **No migration script.** Old files are read lazily and upgraded to v2 on next write.
- **No re-fetching.** A v1 full-day file covers ALL possible time windows within that day. The first time the new code reads an old file, it gets a cache hit.
- **No data loss.** v1 ticks are preserved inside the v2 envelope.
- **Gradual rollover.** Over time, as backtests run, old v1 files get rewritten as v2 with explicit ranges. New files are born as v2 with narrow ranges.
- **Empty files (`[]`) are already valid v1.** They read as an empty array with no ranges. No special handling needed.

### Daily bar files

The 514 daily bar files use a different format (single `{...}` object, not an array). These are read by `readBarCache()` which is separate from `readCache()`. They don't need migration — daily bars are already fetched per-day and are tiny.

## Decomposition (Implementation Order)

### Phase 1: Kill prefetchForAgent (isolate trader config from market data)

Scope: Remove the bundled prefetch. Make trader config a direct call. Strategy gating uses `getTrader()` directly, not the prefetched chain.

Files:
- `src/agent/prefetch.ts` — delete or reduce to just quote+position fetching for the LLM prompt (not for gating)
- `src/tasks/runner.ts` — replace `prefetched?.traderProfile?.strategies` with `(await getTrader(author))?.strategies`
- `src/backtest/runner.ts` — same
- `src/pipeline/execute.ts` — allowedStrategies already on PipelineOpts, no change needed
- `src/agent/deterministic-skips.ts` — shouldSkipSignal already done, no change needed

Risk: Low. No data model changes. Just routing.
Validates: Strategy gate works when quote prefetch fails.

### Phase 2: Delete loadDay, wire up narrow fetches + interval-merging cache

Scope:
- Delete `loadDay()` from `DatabentoMarketDataProvider`
- Delete `loadQuoteTapeForDay()` from `databento-tape.ts` (and `loadQuoteTape` which wraps it)
- `readCache` / `writeCache` handle both v1 (bare array) and v2 (envelope with ranges) — read-both, write-new
- `getQuote()` → check interval cache → if miss, `fetchTickWindow(±1m)` → merge into cache
- `getTicksInRange()` → check interval cache → if miss, `fetchTickWindow(from, to)` → merge into cache
- `prefetch()` → same as getQuote path but batched per symbol
- `fetchTickWindow()` already exists in `databento-tape.ts:1333` — becomes the only API fetch path for intraday data

Files:
- `src/backtest/databento-tape.ts` — delete `loadQuoteTapeForDay`, `loadQuoteTape`, `buildFetchPlan`. Add v2 cache format to `readCache`/`writeCache`. `fetchTickWindow` is already there.
- `src/backtest/market-data.ts` — delete `loadDay`. Rewrite `getQuote`, `getTicksInRange`, `prefetch` to use interval-merging cache + `fetchTickWindow`.

Risk: Medium.
- Old v1 cache files (60K files, full-day arrays) must read correctly — treated as covering `[firstTick, lastTick]`, so all requests within that day are cache hits.
- Range merge edge cases (adjacent, overlapping, stale-quote walkback to previous days).
- Validate: re-run existing backtest → identical results, zero API calls (v1 files cover everything).

## What NOT to Change

- **Cache file naming** (sha256 hash of `dataset|schema|symbol|day`): Same keys, same paths. Just the file contents get an envelope.
- **Retry logic** (`fetchWithRetry`): Already robust with exponential backoff, 429 handling.
- **Cost estimation** (`metadata.get_cost`): Keep for `loadQuoteTape`-style bulk operations if any remain. Narrow `fetchTickWindow` calls are cheap.
- **Live broker path** (`src/broker/tradestation.ts`): Already fetches on demand via real-time API. No caching needed.
- **ohlcv-1d for daily bars**: Already efficient (1 record/day). `getBars()` unchanged.
- **Empty `[]` files**: Valid (weekends/holidays). Never delete. The v1→v2 reader handles them.
- **`fetchTickWindow()`**: Already correct — arbitrary `start`/`end`, no caching. Becomes the only API fetch path for intraday data.
