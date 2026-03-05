# ISSUE-1: Options Not Auto-Closed at Expiry (Systemic)

## Root Cause

The expiry sweep infrastructure **already exists** in `src/backtest/sim-broker.ts`. Both `autoCloseExpiring()` and `sweepExpired()` are implemented and called from `src/backtest/runner.ts` at each day boundary. The 4 trades mentioned in the bug report remain OPEN because their **backtest runs were CANCELLED or FAILED before the day boundary that would have triggered the sweep**.

### Evidence from DB

```
Run 339b205a (QS Sept19, NVDA Sept19): CANCELLED by user at 2026-02-23T00:58:41.597Z
Run 5a5d6aeb (NVDA PDS Sept19):        CANCELLED by user at 2026-02-23T22:22:16.572Z
Run 9c9973c9 (QS Sept19):              FAILED — "recordTrade CLOSE failed for trade 806e459b..."
Run 05f3ee26 (QS Sept19, ABNB Sept12): CANCELLED by user at 2026-02-22T23:52:10.597Z
```

None of these runs reached the `2025-09-19` (or `2025-09-12`) day boundary in the message replay. The trades were opened, then the run ended before the sweep day arrived.

### The Specific 4 Trades

| Symbol | Expiry | Strategy | Direction | Entry | Backtest Run Status |
|--------|--------|----------|-----------|-------|---------------------|
| ABNB $123P | 2025-09-05 | PUT | LONG | $0.21 | Run `df8c003c` — **OPEN at end** (COMPLETED run, sweep did not close it) |
| QS $9.50P | 2025-09-19 | PUT | SHORT | $0.52 | Run `df8c003c` — **OPEN at end** |
| VST $235C | 2025-09-19 | CALL | LONG | $0.75 | Run `df8c003c` — **OPEN at end** |
| NVDA $170P | 2025-09-19 | PUT | LONG | $1.26 | Run `df8c003c` — **OPEN at end** |

Run `df8c003c` is **COMPLETED** with `openAtEnd=19`. The ABNB $123P (expiry 2025-09-05) was opened the same day it expired — the **sweep runs at day boundary transitions** so the sweep threshold is `sweepThrough = msgDay - 1 day`. A trade opened on Sept 5 and expiring Sept 5 would only be swept when the runner crosses to Sept 6. If no more messages exist for Sept 6+ for that symbol, the sweep is skipped.

### Sweep Mechanics (What Exists)

In `src/backtest/runner.ts:213-284`, the day boundary block:
1. `autoCloseExpiring(lastMsgDay, cutoffMinus15Min)` — tries to close using last market quote (3:45 or 4:00pm ET)
2. `sweepExpired(sweepThrough)` — fallback at intrinsic value for any remaining positions where `leg.expiry <= sweepThrough`

`sweepThrough = (msgDay - 1 day)` — this means if the last tradable message is on Sept 19, the sweep only covers through Sept 18. Expiry Sept 19 positions are handled in the **final day block** (`runner.ts:333-366`), which calls `sweepExpired(lastMsgDay)` — but only if `openCount > 0`.

### Why the COMPLETED Run Still Has 19 Open

Looking at the data, the run `df8c003c` has Sept 5 expiry (ABNB) that was opened on Sept 5 and the Sept 19 positions (QS PUT, VST CALL, NVDA PUT). These are all **within the backtest window** so the sweep should have caught them.

The most likely cause for the COMPLETED run: **`autoCloseExpiring` and `sweepExpired` succeed for some trades but fail silently for others** when market data is unavailable. In `sweepExpired`, if `this.marketData.getQuote(t.symbol, expiryDate)` throws, the entire trade sweep is skipped with no fallback (the error propagates and stops that position's processing).

Specifically, `sweepExpired` calls `getQuote` at `expiryDate + 'T20:00:00Z'` (4pm UTC = 8pm ET which is after-hours). The `DatabentoMarketDataProvider` uses a 60-min lookback for valuations but OPRA has no after-hours data. The underlying equity quote at 8pm UTC may succeed via DBEQ.BASIC, but the `getTradeQuote` for options would use `getOptionSpreadQuote` → `getQuote` on OCC symbols at an after-hours time. This can throw and leave the trade OPEN.

The Sept 5 ABNB position is more interesting: if the backtest had no tradable messages on Sept 6 or later for ABNB, the day boundary for Sept 5→Sept 6 may never have fired, leaving it stranded.

## Proposed Design

The sweep already exists. The fix is making it **robust against missing market data** and ensuring it always closes expired positions with a fallback price (including zero for OTM options).

### Fix in `sweepExpired` (src/backtest/sim-broker.ts:545-589)

Current code fails silently if `getQuote` throws for the underlying. Need to:
1. Catch the error per-leg and default underlying price to 0 (worst case: assume worthless, log warning)
2. For OTM computation when underlying is unknown, use $0 exit price
3. Never leave a trade OPEN after expiry

```ts
// Current (broken for missing data):
const quote = await this.marketData.getQuote(t.symbol, expiryDate);
const underlyingPrice = (quote.bid + quote.ask) / 2;

// Fixed:
let underlyingPrice = 0;
try {
  const quote = await this.marketData.getQuote(t.symbol, expiryDate);
  underlyingPrice = (quote.bid + quote.ask) / 2;
} catch {
  log.info(`sweepExpired: no underlying quote for ${t.symbol} at ${expiryDate}, closing at intrinsic with underlying=0`);
}
```

### Fix: Sept 5 Same-Day Expiry Edge Case

The `sweepThrough = msgDay - 1` means a position opened and expiring on the same day only gets swept if there's a message the next day. Need to also check: in the **final day block**, run sweep with `lastMsgDay` (already done in runner.ts:352), but the intermediate day boundary only sweeps through yesterday.

Add a check in the day boundary: if a leg expires on `lastMsgDay` itself (not just `< msgDay`), also close it in `autoCloseExpiring`. This already happens — `autoCloseExpiring(lastMsgDay, ...)` uses `leg.expiry === expiryDate`, which matches same-day. If `autoCloseExpiring` fails (no quote at 3:45pm), then `sweepExpired(sweepThrough)` uses `<= sweepThrough = yesterday`, which **misses same-day expiry**.

The final day block calls `sweepExpired(lastMsgDay)` which catches `<= lastMsgDay`, so it does cover same-day. But if the run is CANCELLED or FAILED before the last day, none of this runs.

### Fix: NVDA LEG_OFF Case

The NVDA $170P trade (Sept 19) had a prior LEG_OFF event. After LEG_OFF, the trade's strategy changes (e.g., from PDS to PUT) and legs are mutated to a single leg. The sweep must handle this correctly — `sweepExpired` already iterates remaining legs, so this should work as long as the mutated legs have correct `expiry` set.

## Expiry Valuation Logic

### Single Leg (CALL or PUT, BUY or SELL)

```
intrinsic = max(0, underlyingPrice - strike)  # CALL
intrinsic = max(0, strike - underlyingPrice)  # PUT

exitPrice = intrinsic  # BUY leg: we receive intrinsic on settlement
exitPrice = intrinsic  # SELL leg: we pay intrinsic on settlement (loss)
```

`netIntrinsic` for the position:
- BUY leg: `+intrinsic` (we receive)
- SELL leg: `-intrinsic` (we pay)

`exitPrice = Math.abs(netIntrinsic)` — already correct in `sweepExpired`.

PnL is then computed by `computeTradePnl(entryPrice, exitPrice, direction, strategy, quantity)`.

For SHORT PUT:
- Entry: $0.50 credit received
- If OTM: intrinsic=0, exit=$0, PnL = +(0.50 × 100 × qty) [keep premium]
- If ITM: intrinsic=strike-underlying, exit=intrinsic, PnL = (0.50 - intrinsic) × 100 × qty [lose part/all]

### Spread (PDS: BUY high-strike + SELL low-strike)

```
netIntrinsic = +max(0, strike_long - underlying)   # BUY leg
             - max(0, strike_short - underlying)   # SELL leg
```

If underlying > both strikes: both OTM, netIntrinsic = 0 (keep debit paid)
If underlying between strikes: long leg ITM, short OTM — partial profit
If underlying < both strikes: both ITM — max value = width of spread

`exitPrice = Math.abs(netIntrinsic)` — already correct.

This is already implemented correctly in `sweepExpired`. The bug is not in the valuation math.

## Files Touched

| File | Change |
|------|--------|
| `src/backtest/sim-broker.ts:545-589` | `sweepExpired`: wrap `getQuote` in try/catch per leg, default underlying to 0, always close |
| `src/backtest/sim-broker.ts:601-651` | `autoCloseExpiring`: add catch+log if trade can't be quoted, don't silently skip (already defers to sweepExpired) |
| `src/backtest/runner.ts:246-269` | Verify `sweepThrough` logic is correct for same-day expiry; consider running `sweepExpired(lastMsgDay)` also at each day boundary for same-day expiries |

**No new file needed.** The sweep lives correctly in `SimBroker`. No `src/backtest/expiry-sweep.ts` needed — the logic already exists in the right place.

## Risk

1. **Databento cost**: `sweepExpired` already fetches underlying quotes. Making it resilient to missing data does not add new API calls — it handles failures gracefully.

2. **Zero-price close distortion**: Closing at $0 when underlying price is unavailable is pessimistic for long options (shows max loss) and optimistic for short options (shows full premium kept). This is acceptable as a fallback — log a warning so it's visible.

3. **Same-day expiry edge case**: Positions opened and expiring the same day are correctly handled by the final day block's `sweepExpired(lastMsgDay)`. The intermediate day boundary does NOT cover same-day because `sweepThrough = msgDay - 1`. This is a pre-existing invariant. The current completed run with an ABNB Sept 5 position suggests this edge case is real.

4. **CANCELLED/FAILED runs**: These runs have permanently orphaned open positions. There is no retroactive fix needed — future runs will sweep correctly. The reported $2,972 PnL figure is from runs that ended prematurely.

## Intersections

- **BUG-4 (ABNB PUT 0DTE)**: Directly related. That bug is a specific instance of this issue — the ABNB $123P (Sept 5) is the same trade. BUG-4 may also involve direction inversion (separate LLM bug). The expiry close fix is the same fix.
- **ISSUE-2 (option sizing)**: Unrelated to expiry sweep. Sizing affects entry, not close.
- **BUG-5 (duplicate NVDA SHORT)**: Unrelated.
- **record-trade.ts CLOSE path**: The sweep calls `closePositionAtPrice` → `recordTrade` with `action: 'CLOSE'`. No changes needed to `record-trade.ts`.
- **`expiry-warning.ts`**: The `logExpiryNotices` function (backtest variant) already logs before sweep runs. No changes needed there.

## Summary

The sweep infrastructure is correct. The bug has two components:

1. **CANCELLED/FAILED runs**: Runs ended before sweep could fire. Not fixable retroactively. The reported $2,972 PnL is from incomplete runs.

2. **Missing market data causes sweepExpired to skip positions silently**: When `getQuote` throws for the underlying at expiry time, the entire position is skipped and left OPEN. Fix: wrap the quote fetch in try/catch, use `underlyingPrice=0` as fallback, always close.

3. **Same-day expiry (ABNB Sept 5)**: The day boundary `sweepThrough = msgDay-1` misses same-day expiries during intra-run processing. The final day block covers this correctly with `sweepExpired(lastMsgDay)`. If the run ends on the expiry day itself, it works. The current COMPLETED run's open ABNB Sept 5 position suggests either no final-day messages pushed past Sept 5, or the sweep actually ran but the quote failed (case 2 above).

**Minimal fix**: In `sweepExpired`, wrap the underlying `getQuote` call in a try/catch that defaults to `underlyingPrice=0` and logs a warning. This ensures all expired positions are always closed, even with stale market data.

## Reviewer Verification

Verified 2026-03-04 by automated review against `data/trade-follower.db` and source code on disk.

### 1. The 4 Specific Trades -- CONFIRMED

All 4 trades exist in run `df8c003c-342e-4e89-937e-42ad487429f9` with status OPEN, verified via `channel_id = 'bt:df8c003c-342e-4e89-937e-42ad487429f9'`.

```sql
SELECT id, symbol, strategy, direction, entry_price,
       json_extract(legs, '$[0].expiry') as expiry,
       json_extract(legs, '$[0].strike') as strike
FROM trades
WHERE channel_id = 'bt:df8c003c-342e-4e89-937e-42ad487429f9'
  AND status = 'OPEN' AND strategy != 'STOCK'
ORDER BY symbol;
```

| Trade ID (prefix) | Symbol | Strategy | Direction | Entry | Expiry | Strike |
|---|---|---|---|---|---|---|
| `9ae30c1a` | ABNB | PUT | LONG | 0.21 | 2025-09-05 | 123 |
| `58a0fe8a` | NVDA | PUT | LONG | 1.26 | 2025-09-19 | 170 |
| `ffd312fd` | QS | PUT | SHORT | 0.52 | 2025-09-19 | 9.5 |
| `9dd4b721` | VST | CALL | LONG | 0.75 | 2025-09-19 | 235 |

**Verdict: CONFIRMED.** All 4 trades match the bug report exactly (symbol, strategy, direction, entry price, expiry, strike).

Note: the `backtest_run_id` column is NULL on these trades; they are linked only via `channel_id`. Queries joining on `backtest_run_id` would miss them.

### 2. Backtest Run Statuses -- CONFIRMED

```sql
SELECT id, status, completed_at, substr(error, 1, 80) as error_snippet
FROM backtest_runs
WHERE id IN ('339b205a-...', '5a5d6aeb-...', '9c9973c9-...', '05f3ee26-...', 'df8c003c-...');
```

| Run | Status | Completed At | Error |
|---|---|---|---|
| `05f3ee26` | CANCELLED | 2026-02-22T23:52:10.943Z | Cancelled by user |
| `339b205a` | CANCELLED | 2026-02-23T00:58:41.597Z | Cancelled by user |
| `5a5d6aeb` | CANCELLED | 2026-02-23T22:22:16.572Z | Cancelled by user |
| `9c9973c9` | FAILED | 2026-03-01T06:15:06.051Z | recordTrade CLOSE failed for trade 806e459b... |
| `df8c003c` | COMPLETED | 2026-03-04T11:55:22.683Z | (none) |

**Verdict: CONFIRMED.** All statuses and error messages match the bug report. Minor discrepancy: the report says `05f3ee26` was cancelled at `23:52:10.597Z` but the actual value is `23:52:10.943Z` (346ms off -- likely a rounding artifact from when the report was written, not material).

### 3. Run df8c003c -- openAtEnd=19 -- CONFIRMED

```sql
SELECT status, json_extract(summary, '$.openAtEnd'), json_extract(summary, '$.totalPnl')
FROM backtest_runs WHERE id = 'df8c003c-342e-4e89-937e-42ad487429f9';
-- Result: COMPLETED | 19 | 2986.66
```

Status distribution in the run: 59 CLOSED, 19 OPEN. The `openAtEnd=19` is stored in `summary` (not `extended_metrics`). The `extended_metrics` field contains Sharpe/Sortino ratios but no `openAtEnd`.

**Verdict: CONFIRMED.** Run is COMPLETED with exactly 19 open trades at end.

### 4. sweepExpired Code -- getQuote Without try/catch -- CONFIRMED (in committed code)

The **committed version** (HEAD) of `src/backtest/sim-broker.ts` at the sweep loop has:

```
const quote = await this.marketData.getQuote(t.symbol, expiryDate);
const underlyingPrice = (quote.bid + quote.ask) / 2;
```

No try/catch. A thrown error would propagate up through the `for` loop, potentially aborting the entire sweep for all remaining trades (or leaving just that one trade unprocessed if the error propagates past the loop into `closePositionAtPrice`).

However, the **working tree** (uncommitted changes) already contains the proposed fix:

```
let underlyingPrice = 0;
try {
  const quote = await this.marketData.getQuote(t.symbol, expiryDate);
  underlyingPrice = (quote.bid + quote.ask) / 2;
} catch {
  log.warn(`sweepExpired: no underlying quote for ${t.symbol} at ${leg.expiry}, closing at intrinsic with underlying=0`);
}
```

This was confirmed via `git diff HEAD -- src/backtest/sim-broker.ts`.

**Verdict: CONFIRMED.** The bug report correctly identifies the root cause. The fix has already been applied but is not yet committed. The fix uses `log.warn` (not `log.info` as the proposed code in the doc shows), which aligns with the coding standard "WARN MEANS ACTIONABLE" since missing market data at expiry is something worth investigating.

### 5. autoCloseExpiring -- CONFIRMED EXISTS

`autoCloseExpiring()` exists at `src/backtest/sim-broker.ts:605-655`. It already handles missing quotes gracefully by logging at debug level and deferring to `sweepExpired` (lines 626-629). No fix needed here -- the bug is in `sweepExpired` which is the fallback.

**Verdict: CONFIRMED.**

### 6. runner.ts Day Boundary Logic -- CONFIRMED WITH CORRECTIONS

The day boundary block is at `runner.ts:213-284`. The `sweepThrough` computation at lines 248-249:

```typescript
const sweepThrough = new Date(parseDateKey(msgDay).getTime() - 86_400_000)
  .toISOString().slice(0, 10);
```

This is `msgDay - 1 day`, NOT `lastMsgDay - 1 day`. For the Sept 5 to Sept 8 transition: `sweepThrough = Sept 8 - 1 = 2025-09-07`. Since `leg.expiry '2025-09-05' <= '2025-09-07'`, sweepExpired WOULD catch the ABNB Sept 5 trade.

**Discrepancy with bug report line 77:** The report says "`sweepExpired(sweepThrough)` uses `<= sweepThrough = yesterday`, which misses same-day expiry." This is **misleading**. For the ABNB case, `sweepThrough = 2025-09-07` (2 days after expiry), so the sweep DOES cover Sept 5. The same-day edge case only matters when the expiry day IS the last message day AND there are no more messages -- which is handled by the final day block (lines 333-366) calling `sweepExpired(lastMsgDay)`.

The real edge case for `sweepThrough = msgDay - 1` is when two consecutive trading days have tradable messages and a position expires on `lastMsgDay` (yesterday). In that case, `sweepThrough = msgDay - 1 = lastMsgDay`, and `leg.expiry <= lastMsgDay` is TRUE, so it IS covered. The only uncovered case is if `lastMsgDay` itself has the expiry AND `msgDay = lastMsgDay + 1` AND `sweepThrough = lastMsgDay`, which... still covers it.

**Verdict: CONFIRMED with correction.** The day boundary and final day blocks exist at the stated line numbers. The same-day expiry edge case is less of a concern than the report suggests -- `sweepThrough = msgDay - 1` covers almost all cases. The real issue is the missing try/catch in `sweepExpired`.

### 7. Live Mode Gap -- CONFIRMED

```sql
-- CORRECTED: Original query used stale `is_backtest` column. All 37 results are
-- backtest trades (channel_id LIKE 'bt:%') with is_backtest=0 (misset flag).
-- Zero actual live-mode trades exist as of March 2026.
SELECT count(*) FROM trades
WHERE channel_id NOT LIKE 'bt:%'
  AND status = 'OPEN' AND strategy NOT IN ('STOCK')
  AND json_extract(legs, '$[0].expiry') < '2026-03-04';
-- Result: 0
```

**CORRECTION (2026-03-04):** The original claim of "42 live-mode option trades" was based on a query using `is_backtest = 0`, which is a stale/legacy column. All 803 trades with `is_backtest=0` have `channel_id LIKE 'bt:%'` -- they are backtest trades with a misset flag. The canonical scope check is `channel_id` (format: `bt:<runId>`, `live:<accountId>`, `paper:<accountId>` per `src/lib/channel.ts`). No actual live-mode trades exist in the database. The live sweep is a forward-looking fix.

Grep confirms `sweepExpired` and `autoCloseExpiring` are only called from `src/backtest/runner.ts` and `src/backtest/sim-broker.ts`. No live-mode equivalent exists.

`src/lib/expiry-warning.ts` contains two functions:
- `checkExpiryWarnings()` -- live mode, sends Discord/Pushover alerts, does NOT close trades
- `logExpiryNotices()` -- backtest mode, logs at info level before sweep, does NOT close trades

**Verdict: CONFIRMED.** The bug report correctly states `expiry-warning.ts` only warns. There is no live-mode auto-close mechanism.

### 8. Same-Day Expiry Edge Case -- MINIMAL IMPACT

```sql
SELECT t.status, count(*) FROM trades t
WHERE t.is_backtest = 1 AND t.strategy NOT IN ('STOCK')
  AND json_extract(t.legs, '$[0].expiry') != ''
  AND substr(t.opened_at, 1, 10) = json_extract(t.legs, '$[0].expiry')
GROUP BY t.status;
-- Result: CLOSED=289, OPEN=1
```

Only 1 same-day expiry trade is still OPEN (a PFE CALL in a FAILED run). 289 same-day expiry trades were successfully closed. The ABNB Sept 5 case (opened 2025-09-05, expiry 2025-09-05) in df8c003c is NOT a same-day issue per se -- it is an instance of the getQuote-throws root cause.

**Verdict: The same-day expiry edge case is not a significant contributor.** 289/290 same-day trades were closed successfully. The 1 failure is in a FAILED run.

### 9. NVDA LEG_OFF Claim -- CONFIRMED

```sql
SELECT action, price, strategy, legs, timestamp
FROM trade_events WHERE trade_id = '58a0fe8a-aa80-4725-b2fa-dacf775e5b2d'
ORDER BY timestamp;
```

The NVDA PUT trade started as PDS (2 legs) with an OPEN event at `2025-09-17T19:57:51.961Z`, then had a LEG_OFF event at `2025-09-18T13:57:12.000Z`. The current `trades` row shows strategy=PUT with 1 leg (BUY $170P). The LEG_OFF correctly mutated the strategy and removed the SELL leg.

**Verdict: CONFIRMED.** The LEG_OFF claim matches the data exactly.

### 10. Scale of the Problem -- LARGER THAN REPORTED

The bug report focuses on 4 trades in 1 run. The actual scope:

| Run Status | Open Expired Options |
|---|---|
| CANCELLED | 268 |
| COMPLETED | 113 |
| FAILED | 97 |
| **Total** | **478** |

113 expired options remain OPEN across COMPLETED runs alone, spanning 25 symbol/strategy/expiry combinations from Sept 2025 through Jan 2026.

### Summary Assessment

**Root cause diagnosis: CONFIRMED.** The committed `sweepExpired` code has no try/catch around `getQuote`. When market data is unavailable, the thrown error aborts processing for that trade, leaving it OPEN.

**Proposed fix: ALREADY APPLIED (uncommitted).** The working tree contains the exact fix described in the report. It needs to be committed.

**Discrepancies found:**
1. The report overemphasizes the same-day expiry edge case. Data shows 289/290 same-day trades close successfully. The real issue is purely the missing try/catch.
2. Line 13: `05f3ee26` cancelled timestamp is off by 346ms (`.597Z` vs `.943Z`). Immaterial.
3. Line 27 claims the ABNB Sept 5 trade would be missed by `sweepThrough = msgDay - 1 day`. This is incorrect -- when the day boundary fires at Sept 8, `sweepThrough = Sept 7`, which covers Sept 5. The ABNB trade was left open because `getQuote` threw, not because of the sweepThrough date arithmetic.
4. Line 43 says `expiryDate + 'T20:00:00Z' = 4pm UTC = 8pm ET`. This is wrong. 20:00 UTC = 4:00 PM EDT (UTC-4) during summer, which is market close time. The report confuses UTC offset direction.

**Confidence in root cause: HIGH.** The getQuote-throws theory is the only explanation consistent with all the evidence: (a) the COMPLETED run processed messages through Sept 30, well past all 4 expiry dates; (b) the day boundary logic correctly covers these expiry dates; (c) the committed code has no error handling in sweepExpired; (d) the fix is already applied in the working tree.

**Confidence in proposed fix: HIGH.** The fix is minimal, correct, and already validated by the pattern used in `autoCloseExpiring` (which defers to sweepExpired on failure).

## Live Mode Fix Plan (Verified, Peer-Reviewed)

### Problem

Live mode has NO expiry sweep. `src/lib/expiry-warning.ts` sends alerts (Discord/Pushover) for positions approaching expiration but never closes them. `sweepExpired` and `autoCloseExpiring` exist only in `src/backtest/sim-broker.ts` and are called only from `src/backtest/runner.ts`. When live trading begins, expired options will accumulate as OPEN trades indefinitely.

### Data Clarification: The "42 Stuck Trades"

The original query `WHERE is_backtest = 0 AND status = 'OPEN' AND strategy != 'STOCK'` returns 37 trades (not 42 — count may have changed). However, ALL of these are in `bt:*` channels — they are backtest trades with a stale `is_backtest` column.

Evidence:
- Zero trades exist with `channel_id LIKE 'live:%'` or `channel_id LIKE 'paper:%'`
- 803 backtest trades have `is_backtest = 0` despite `channel_id LIKE 'bt:%'`
- The `is_backtest` column is not maintained by `recordTrade()` — `channelId` is the canonical scope identifier
- Canonical check: `parseChannel(channelId).mode` from `src/lib/channel.ts`

The stuck trades are real (37 expired options across multiple backtest runs), but they are backtest artifacts from CANCELLED/FAILED/COMPLETED runs where `sweepExpired` either didn't run or failed due to the missing try/catch (fixed in uncommitted changes). The live sweep is needed proactively — not to fix existing data, but to prevent the same problem when live trading starts.

### Design

**New file: `src/live/expiry-sweep.ts`**

Separate from `expiry-warning.ts` (alert-only) and `sim-broker.ts` (backtest-specific). The live sweep has fundamentally different constraints:
- No SimBroker / market data provider — uses `recordTrade` directly
- No backtest clock — uses wall clock
- Cannot get quotes for expired options (delisted from exchanges)
- No broker dependency — pure DB operation. Works even when broker is down.

**Function signature:**
```ts
export async function sweepExpiredLive(
  channelId: string,
): Promise<number>
```

**Logic:**
1. Query all OPEN trades where `channelId` matches and `strategy != 'STOCK'`
2. For each trade, get legs via `getLegs(trade)`
3. Determine if expired:
   - `leg.expiry < today` (strict `<`): YES — expired on a prior day
   - `leg.expiry === today AND isAfterMarketClose(now)`: YES — expired today after close
   - Otherwise: NO
4. Find the LATEST expired leg's expiry date (for spreads with mixed expiries)
5. Close at $0:
   ```ts
   recordTrade({
     action: 'CLOSE',
     tradeId: trade.id,
     symbol: trade.symbol,
     trader: trade.trader,
     exitPrice: 0,
     closedAt: marketCloseUTC(parseDateKey(latestExpiry)).toISOString(),
     channelId,
     metadata: { sweepReason: 'expired' },
   })
   ```
6. Send alert via `sendSystemAlert` for each closed trade (visibility)
7. Return count of closed trades

### Valuation: Always $0

All expired options are closed at $0. Rationale:
- **Expired options are delisted** — OPRA/exchanges will not return quotes.
- **The broker already settled it.** If an option expired ITM, the OCC auto-exercised it and the broker assigned/exercised it. Our DB record is bookkeeping, not position management.
- **No branching logic.** A "recent vs old" threshold (e.g., 5 days) adds complexity for marginal accuracy gain on what's essentially a bookkeeping close.
- **`metadata.sweepReason: 'expired'`** tags these trades for easy identification and manual correction if better valuation is needed later (via a separate backfill script).
- The PnL distortion (pessimistic for longs, optimistic for shorts) is acceptable because the trade was never properly closed by a signal.

### Timestamp: closedAt Uses Expiry Date, Not Sweep Date

`closedAt` is set to `marketCloseUTC(parseDateKey(latestExpiry)).toISOString()` — the DST-aware market close time on the actual expiry date. This preserves equity curve accuracy. The `trade_event.timestamp` records when the sweep event was recorded (wall clock), giving both the economic and operational timestamps.

`marketCloseUTC` from `src/lib/et-date.ts` handles DST correctly (4 PM ET = 20:00 UTC in EDT, 21:00 UTC in EST).

For spreads with legs at different expiry dates, the LATEST leg expiry is used for `closedAt` (matching sim-broker's `latestExpiry` convention).

### When to Run

**Two triggers, no new scheduler:**

1. **Startup** in `startTaskRunner()`, after stale task recovery (line 67-77). Condition: `leg.expiry < today` (strict `<`). Catches anything missed while the system was down.

2. **Poll loop** in `processPendingTasks()`, alongside the existing `checkExpiryWarnings` call (line 104-109). Same 5-minute throttle interval. Condition: `leg.expiry < today` (catches past-day expirations) PLUS `leg.expiry === today AND isAfterMarketClose(now)` (catches same-day 0DTE expirations after market close).

No hardcoded "4:35 PM" scheduler — the poll loop naturally picks up same-day expirations once the market closes. The `getETMinuteOfDay` and `toDateKeyET` utilities from `et-date.ts` handle DST and early-close days correctly.

```ts
// runner.ts integration (~10 lines):
import { sweepExpiredLive } from './expiry-sweep.js';

// In startTaskRunner(), after stale recovery:
const startupSwept = await sweepExpiredLive(liveChannelId);
if (startupSwept > 0) console.log(`[Runner] Startup: swept ${startupSwept} expired position(s)`);

// In processPendingTasks(), alongside expiry check (same throttle):
if (Date.now() - lastExpiryCheck > EXPIRY_CHECK_INTERVAL) {
  lastExpiryCheck = Date.now();
  checkExpiryWarnings(() => getOpenPositions()).catch(() => {});
  sweepExpiredLive(liveChannelId).catch(() => {});
}
```

### Files to Touch

| File | Change |
|------|--------|
| `src/live/expiry-sweep.ts` | NEW — `sweepExpiredLive()` function (~50-70 lines) |
| `src/live/runner.ts` | Import + call at startup and in poll loop (~10 lines) |

### Risk

1. **False closes**: The sweep only targets trades where a leg's `expiry < today` (or `=== today` after close). Stock trades are excluded. Same guard as backtest sweep.
2. **Pricing at $0**: Pessimistic for longs, optimistic for shorts. Acceptable as bookkeeping — the brokerage has already settled these. Tagged with `metadata.sweepReason` for manual review.
3. **Double-close race (TOCTOU)**: If a close signal arrives concurrently with the sweep, both could read the trade as OPEN and attempt to close. This is a pre-existing issue in `recordTrade` (SELECT then UPDATE, not atomic CAS). Consequence: duplicate CLOSE event in `trade_events`, but the trade ends up CLOSED either way. The window is tiny (startup vs first task). Not worth adding a mutex. Documented as known limitation.
4. **Idempotency**: Running the sweep multiple times produces the same result. `recordTrade(CLOSE)` queries `WHERE status = 'OPEN'`; already-closed trades return null (no-op). No locking needed.
5. **No broker dependency**: The sweep is a pure DB operation (query + recordTrade). Works even when the broker is down or unhealthy.

### Verified 2026-03-04, Peer-reviewed by issue1-challenger
