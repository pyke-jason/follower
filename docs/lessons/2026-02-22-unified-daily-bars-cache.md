Problem
loadDailyBars was a separate per-day caching system for ohlcv-1d data. It had a Friday bug (Databento ts_event for Friday bars = Saturday 00:00Z → toDateKeyET mapped to Sunday → cache miss every time). This caused repeated API fetches ($$$) and made backtests take 1hr+. The root cause: duplicate cache infrastructure that didn't benefit from the interval-merging tick cache.

Decision
Deleted the entire loadDailyBars / readBarCache / writeBarCache / getDayCachePath system (~150 lines). Daily bars now flow through the same ensureRange + fetchTickWindow infrastructure as all other data. ensureRange got an optional schemaOverride param; when passed, the in-memory cache key becomes `symbol:schema` to avoid mixing ohlcv-1d and ohlcv-1m entries. QuoteTick was extended with optional open/close/volume fields so ohlcv data round-trips through the unified cache. parseTick snaps non-trading-day timestamps (Friday bars mapped to Sunday) to the previous trading day.

Key Files
src/backtest/databento-tape.ts — QuoteTick extended, parseTick Friday fix, loadDailyBars deleted, isMarketHours filter removed
src/backtest/market-data.ts — getBars() rewritten to use ensureRange('ohlcv-1d'), deduplicates multiple bars/day by highest volume

Watch Out
DBEQ.BASIC ohlcv-1d returns 2-3 records per day per symbol (different exchange feeds). getBars deduplicates by keeping the highest-volume bar per trading day. If a dataset returns only one bar/day, the dedup is a no-op.
parseTick's Friday fix relies on isTradingDay + getPreviousTradingDayKey. If those have gaps in the holiday calendar, daily bars could get wrong timestamps.
