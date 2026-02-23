Problem
Backtest 505770aa investigation found 3 bugs: (1) LLM v4 emits duplicate legs in option signals, causing doubled prices/PnL on 6/20 trades (~$3,314 overreport). (2) LLM sometimes gets strategy wrong on CLOSE signals (e.g. STOCK instead of PDS), so the exact {symbol, trader, strategy} match fails and the trade stays open until expiry sweep. (3) tradestation.ts had a private buildOccSymbol that reimplemented formatOccSymbol with a date-parsing bug (new Date(expiry) shifts dates in non-UTC timezones). Also contractMult was hardcoded to 100 in margin-model.ts.

Decision
Fix 1: Deduplicate legs in buildOptionLegs() by (strike|expiry|optionType|action) key before mapping to OrderLegs. This is the single conversion point from SignalLeg to OrderLeg, so all OPEN/ADD paths are covered. Log a warning when dedup fires for LLM quality tracking.
Fix 2: Extract a findPosition() helper with fuzzy fallback — if exact {symbol, trader, strategy} match fails for CLOSE/TRIM/LEG_OFF, retry with just {symbol, trader}. If exactly 1 result, use it and log strategy mismatch. OPEN/ADD still require exact matching.
Fix 3: Replace buildOccSymbol in tradestation.ts with the shared formatOccSymbol from occ-symbology.ts. The shared version parses YYYY-MM-DD strings directly instead of going through new Date().
Fix 4: Replace hardcoded contractMult=100 in margin-model.ts with contractMultiplier(strategy) from lib/trade.ts.

Key Files
src/pipeline/execute.ts — buildOptionLegs (dedup), findPosition (fuzzy helper), executeClose/executeTrim/executeLegOff (use findPosition)
src/broker/tradestation.ts — removed buildOccSymbol, now imports formatOccSymbol
src/backtest/margin-model.ts — uses contractMultiplier(strategy) instead of hardcoded 100
src/backtest/occ-symbology.ts — formatOccSymbol (the shared implementation)
src/lib/trade.ts — contractMultiplier (the shared implementation)

Watch Out
The fuzzy fallback only fires when there's exactly 1 open position for that symbol+trader. If there are multiple (e.g. a CALL and a PDS on the same symbol), it returns undefined and the close fails as before — this is intentional to avoid ambiguity. The dedup key includes action (BUY/SELL) so a legitimate spread with BUY+SELL on the same strike/expiry won't get deduped.
