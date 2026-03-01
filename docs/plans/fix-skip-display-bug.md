# Fix SKIP Display Bug

## Root Causes
1. **`r.orderId` bug in `runner.ts` onResult**: `ResolvedPipelineResult` has no `orderId` field, so `pendingResults` is always empty. Pending-fill orders (executed=false, no reason) get classified as SKIP ("Signals produced but none executed") when they actually execute later via fill callback.
2. **Old schema.ts didn't declare `event` column**: Drizzle didn't include it in INSERTs, so ALL emitter rows got DB default `SETTLED` — PARSED, SIGNAL_RESOLVED events are invisible.
3. **125 bad rows**: Trades with `outcome=SKIP` + `reasoning='Signals produced but none executed'` that have actual OPEN/CLOSED trades.

## Fixes

### A. Code fix: runner.ts onResult logic — DONE
- [x] Change pending detection from `!r.executed && r.orderId` (never matches) to `!r.executed && !r.reason` (correct)
- [x] Pending orders → EXECUTE, not SKIP

### B. Data fix: correct bad SKIP decisions
- [x] UPDATE bad SKIP rows to EXECUTE where trade actually exists
- [x] Delete ghost SETTLED rows (null everything, no useful data)

### C. Verify with Playwright
- [ ] Navigate to backtest trade detail showing previous bug
- [ ] Confirm timeline no longer shows SKIP for executed trades
- [ ] Check a few more trades

## Verification Log
_(filled after Playwright checks)_
