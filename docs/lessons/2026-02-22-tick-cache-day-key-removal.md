Problem
Tick cache files in .cache/databento/ were keyed by symbol+day (both in-memory Map and on disk).
This caused cross-day quote failures: ensureRange cached under toDateKey(start) but getQuote looked up
under toDateKey(at). Wide lookback windows crossing ET midnight missed cached data entirely.
Surfaced as "no quote for ABNB PUT" despite 114 records being fetched.

Decision
Removed day from tick cache keys entirely. v2 ranges are continuous UTC millisecond intervals —
day scoping was v1 cruft. Migration script merged 42,882 day-keyed files + 17,353 empty files into
19,000 symbol-keyed files (7.7M ticks). Deleted v1 format support from readTickCache.
Rejected DB approach as overkill for caching Databento API responses.

Key Files
src/backtest/databento-tape.ts — added getSymbolCachePath (no day param), kept getDayCachePath for daily bars only
src/backtest/market-data.ts — dayTicks Map renamed to tickCache keyed by symbol only, getTicksInRange drastically simplified (no day iteration)
scripts/migrate-tick-cache-v3.ts — one-time migration (deleted after run), streamed 62K files via 16KB header reads to avoid OOM

Watch Out
getDayCachePath still exists and is correct for daily bar caching (ohlcv-1m). Only tick cache (cbbo-1s)
moved to symbol-only keys. The first migration attempt OOM'd loading all 62K files — streaming with
header-only classification was required. Bar/chain cache files (1,708) were left untouched.
