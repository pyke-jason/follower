# CRWV Missed Exit — Defense-in-Depth

## Problem
September 2025 backtest: CRWV Short PDS opened Sep 25, expired Sep 26 for max loss ($1,635). Initial theory was LLM missed Dave W's exit signals. Investigation revealed the REAL issue was wrong expiry/strikes (Dave said "oct 17 110/105", system opened "Sep 26 127/122"). However, the prompt weakness IS real — natural exit language like "took profits on X" had zero coverage in the intent extraction prompt.

## Decision
Implemented 3 defensive layers:

1. **Layer 1 — Prompt Fix**: Added `<exit_language>` section to intent extraction prompt with natural exit vocabulary, action-vs-commentary heuristics, and asymmetric risk bias. 5 new examples. INTENT_VERSION 6 → 7.

2. **Layer 2 — Skip Alert**: New `alertIfSkippedWithActivePosition()` fires critical alerts (Discord + Pushover) when LLM skips a message on a held symbol. Wired at both deterministic and agent skip paths. Throttled per trader+symbol per calendar day.

3. **Layer 3 — Expiry Warning**: New `checkExpiryWarnings()` alerts when positions approach expiration without close signals. Live: 5-min polling during market hours. Backtest: info-level logging before sweepExpired.

## Key Files
- `src/intents/extract-intent.ts` — prompt changes, INTENT_VERSION bump
- `src/lib/skip-position-alert.ts` — Layer 2 (new file)
- `src/lib/expiry-warning.ts` — Layer 3 (new file)
- `src/lib/et-date.ts` — added `getNextTradingDayKey()`
- `src/tasks/runner.ts` — wired Layers 2 + 3 into live runner
- `src/backtest/runner.ts` — wired Layer 3 logging before sweepExpired

## Watch Out
- INTENT_VERSION bump invalidates ALL cached intents — next backtest will re-extract everything (LLM cost + time)
- Layer 2 alerts are async fire-and-forget (`.catch(() => {})`) — never blocks pipeline
- Layer 3 throttle is in-memory Map — resets on process restart (acceptable for live runner)
- PrefetchedData positions field is `allForTrader` (not `forTrader`)
- The CRWV root cause (wrong expiry/strikes) is a SEPARATE bug in intent extraction that these layers don't fix — that's a strike/expiry parsing issue
