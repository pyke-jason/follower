Problem
Many open option positions had "No Databento data" warnings during backtest. SimBroker.getAccountBalance() and markToMarket() couldn't value positions in semi-illiquid options (GEV PDS, ABNB PUT), causing repeated log noise and missing portfolio valuations.

Decision
Two interrelated fixes in market-data.ts getQuote():
1. Search ALL cached ticks for the day, not just the window-filtered subset from ensureRange(). Databento cbbo-1s reports ts_event as when the quote was established, not the snapshot second. For illiquid options, the same BBO persists for hours with the original timestamp, so filterTicks() was excluding valid quotes that fell outside the fetch window.
2. Raised default option lookback from 5 min to 300 min (5 hours). Execution paths (fills, limit checks) explicitly pass 5 via EXECUTION_LOOKBACK_MINS. The expanding lookback window controls both what gets fetched AND max acceptable staleness — a tick found in the full cache must still be younger than the current window's span.

Key Files
src/backtest/market-data.ts — getQuote() full-cache search + staleness check
src/backtest/sim-broker.ts — EXECUTION_LOOKBACK_MINS (5) passed at fill/limit sites; valuation paths use the wide default

Watch Out
The staleness check is `tickAgeMins <= mins` where `mins` is the current expanding window. This means a 72-minute-old tick is accepted at the 300-min window but rejected at the 60-min window. If you tighten the default optionCap, you may re-introduce missing valuations for illiquid positions. Also: Databento cbbo-1s returns many records that all share a single ts_event when the BBO hasn't changed — 1527 records ≠ 1527 unique timestamps.
