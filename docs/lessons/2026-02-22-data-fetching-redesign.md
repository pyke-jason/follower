Problem
The backtest market data provider fetched entire trading days (6.5 hours, ~390 records/symbol)
via loadDay() -> loadQuoteTapeForDay(), even when consumers only needed 1-2 minutes of data.
fetchTickWindow() existed in databento-tape.ts but was never called. Every code path funneled
through full-day loads, burning Databento API credits and bloating memory.

Decision
Deleted loadDay/loadQuoteTapeForDay/loadSpecificContracts/loadParentSymbology entirely.
All intraday data now flows through fetchTickWindow() with arbitrary start/end times.
Added an interval-merging cache (v2 envelope format) that tracks which time ranges are covered
per symbol-day on disk, so overlapping requests merge rather than re-fetch. Old v1 cache files
(bare QuoteTick[] arrays) are read as full-day coverage for backward compat.

Also decoupled trader config from PrefetchedData — traderProfile was bundled into the prefetch
Promise.allSettled but has nothing to do with market data. Now fetched separately where needed
(runner.ts, backtest/runner.ts).

Key Files
src/backtest/databento-tape.ts — mergeRanges, isRangeCovered, readTickCache, writeTickCache, fetchTickWindow (sole API fetch path)
src/backtest/market-data.ts — ensureRange (memory -> disk -> API), ensureRangeBatch, rewritten getQuote/getTicksInRange/prefetch/getOptionsChain
src/agent/prefetch.ts — removed traderProfile from PrefetchedData
src/tasks/runner.ts, src/backtest/runner.ts — pass traderConfig directly to runAgent, allowedStrategies fetched separately

Watch Out
The stale quote fallback in getQuote now fetches last 5 minutes before market close (15:55-16:00 ET)
of previous trading days instead of loading full days. If a symbol has no ticks in that window,
it will still throw StaleQuoteError. The v2 cache envelope stores ranges as UTC millisecond pairs;
v1 files (bare arrays) are treated as covering [firstTick, lastTick] which may under-report coverage
for sparse data.
