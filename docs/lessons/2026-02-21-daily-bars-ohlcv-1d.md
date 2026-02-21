Problem:
ATR position sizing fetched ~6,000 Databento rows per symbol (15 days x ~390 ohlcv-1m records/day)
across 15 separate HTTP requests, including wasted calls on weekends/holidays. Databento charges
per row transferred, so this was ~400x more expensive than necessary for daily OHLC bars.

Decision:
Added loadDailyBars() in databento-tape.ts that fetches ohlcv-1d schema in a single API call
spanning the full date range. Returns real OHLCV Bar[] directly instead of synthesizing bars
from minute-level bid/ask midpoints. getBars() in market-data.ts now calls loadDailyBars()
instead of 15x loadDay() + aggregateBar(). Removed aggregateBar() and in-memory barCache
(file cache handles cross-call dedup via getDayCachePath with schema='ohlcv-1d').

Key Files:
- src/backtest/databento-tape.ts  (loadDailyBars, DatabentoRecord now parses open/close/volume)
- src/backtest/market-data.ts  (getBars simplified, aggregateBar + barCache removed)
- src/position-sizing/atr.ts  (consumer — now gets real close prices instead of midpoints)

Watch Out:
The ohlcv-1d cache uses the same getDayCachePath as ohlcv-1m but with schema='ohlcv-1d' in the
hash, so no collision. But the cache stores a single Bar object (not QuoteTick[]), so readBarCache/
writeBarCache are separate from readCache/writeCache. If you add another daily-granularity schema,
reuse the bar cache helpers rather than adding a third pair.
