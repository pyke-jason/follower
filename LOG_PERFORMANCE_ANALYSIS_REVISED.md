# Log Performance Impact Analysis — REVISED

**Default log level**: `info` (debug calls are suppressed, BUT template strings still evaluate)

---

## Critical Insight

**JavaScript template strings evaluate their interpolations even when the log is suppressed.** This means:
```typescript
log.debug(`markToMarket: no quote for ${t.symbol} ${t.strategy} at ${formatLogTimestampET(time)} ET: ${err.message}`);
// Even if debug is off, formatLogTimestampET(time) RUNS on every error
```

---

## Hot Paths With Expensive Template Interpolations

### 1. ⚠️ PROBLEM: `formatLogTimestampET()` in Debug Logs

**File:** `src/backtest/sim-broker.ts`

| Line | Function | Frequency | Cost | Verdict |
|------|----------|-----------|------|---------|
| 415 | markToMarket() | ~1-10 per backtest | `formatLogTimestampET()` + error msg | **FIX** |
| 456 | getUnrealizedPnl() | ~1-10 per backtest | `formatLogTimestampET()` + error msg | **FIX** |
| 623 | getAccountBalance() | ~5-50 per backtest | `formatLogTimestampET()` + error msg | **FIX** |

**What `formatLogTimestampET()` does** (from et-logging.ts:15-24):
1. Calls `getETComponents(d)`
2. `getETComponents()` uses `Intl.DateTimeFormat.formatToParts()` — **timezone conversion via ICU**
3. 6× `.padStart()` calls for zero-padding
4. Template string assembly

**Cost per call:** ~0.5-2ms (timezone conversion is not free)

**Total impact:**
- `markToMarket()` loops ~1-10 times (bounded by quote failures)
- `getUnrealizedPnl()` loops ~1-10 times (bounded by quote failures)
- `getAccountBalance()` runs ~5-50 times per backtest (called per-message, has `quoteMs` tracking showing it's slow!)

**This is a real performance hit for getAccountBalance especially.**

---

### 2. ⚠️ PROBLEM: Complex Ternary + Error.message in Debug Logs

**File:** `src/backtest/sim-broker.ts:415, 456, 623`

```typescript
log.debug(`...ET: ${err instanceof Error ? err.message : err}`);
```

**Cost:**
- `instanceof` check
- Ternary evaluation
- Both branches evaluated (one or the other, but always check)

**Frequency:** Every quote fetch failure (rare but not impossible)

---

### 3. ✅ SAFE: `.toFixed()` Operations

All `.toFixed()` calls are **cheap** — simple numeric formatting:
- sim-broker.ts:262, 511, 693
- runner.ts:398, 412, 490

**Cost per call:** <0.1ms

---

### 4. ✅ MOSTLY SAFE: String `.join()` and `.slice()`

**But with caveats:**

| File | Line | Operation | Frequency | Cost |
|------|------|-----------|-----------|------|
| databento-tape.ts | 182 | `.join(',').slice(0,80)` | ~5 per backtest | **SAFE** — retry path only |
| databento-tape.ts | 213 | `.join(',').slice(0,80)` | ~5 per backtest | **SAFE** — network retry only |
| databento-tape.ts | 384 | `.slice(0,500)` on body | ~10 per backtest | **SAFE** — definition fetch summary |

---

## Summary of Actual Issues

### ⚠️ High Priority: Remove `formatLogTimestampET()` from Debug Logs

The three debug logs in sim-broker.ts call an **expensive timezone conversion function** that will run even when the log is suppressed:

- **Line 415** (markToMarket, rare): Call is inside error handler (try/catch), bounded frequency
- **Line 456** (getUnrealizedPnl, rare): Call is inside error handler, bounded frequency
- **Line 623** (getAccountBalance, frequent): Called ~5-50 times per backtest, costs compound

**Recommended fix:**
```typescript
// BEFORE (expensive)
log.debug(`markToMarket: no quote for ${t.symbol} ${t.strategy} at ${formatLogTimestampET(time)} ET: ${err instanceof Error ? err.message : err}`);

// AFTER (cheap)
log.debug(`markToMarket: no quote for ${t.symbol} ${t.strategy}: ${err instanceof Error ? err.message : String(err)}`);
```

Or even better, **guard expensive calls**:
```typescript
if (log.LEVELS.debug) {
  log.debug(`markToMarket: no quote for ${t.symbol} ${t.strategy} at ${formatLogTimestampET(time)} ET: ...`);
}
```

But the logger doesn't expose LEVELS. Better to just **remove timezone formatting from suppressed logs**.

---

### ⚠️ Medium Priority: Line 623 in getAccountBalance()

This runs **~5-50 times per backtest** (once per message when balance is checked). The log is **debug**, so it's suppressed, but the template still evaluates:

```typescript
log.debug(`getAccountBalance: no quote for ${t.symbol} ${t.strategy} at ${formatLogTimestampET(now)} ET: ...`);
```

**Fix:** Remove the `formatLogTimestampET(now)` call. Timestamps aren't critical for a quote-fetch debug log.

---

### ✅ OK: All Other Logs

- Info and warn logs use cheap operations
- Debug logs for simple string concat are OK (suppressed anyway)
- No JSON.stringify or expensive loops in any logs

---

## Recommended Fixes

### Fix 1: Remove timezone formatting from three debug logs

**File:** `src/backtest/sim-broker.ts`

```typescript
// Line 415 (markToMarket)
- log.debug(`markToMarket: no quote for ${t.symbol} ${t.strategy} at ${formatLogTimestampET(time)} ET: ${err instanceof Error ? err.message : err}`);
+ log.debug(`markToMarket: no quote for ${t.symbol} ${t.strategy}: ${err instanceof Error ? err.message : String(err)}`);

// Line 456 (getUnrealizedPnl)
- log.debug(`getUnrealizedPnl: no quote for ${row.symbol} ${row.strategy} at ${formatLogTimestampET(time)} ET: ${err instanceof Error ? err.message : err}`);
+ log.debug(`getUnrealizedPnl: no quote for ${row.symbol} ${row.strategy}: ${err instanceof Error ? err.message : String(err)}`);

// Line 623 (getAccountBalance)
- log.debug(`getAccountBalance: no quote for ${t.symbol} ${t.strategy} at ${formatLogTimestampET(now)} ET: ${err instanceof Error ? err.message : err}`);
+ log.debug(`getAccountBalance: no quote for ${t.symbol} ${t.strategy}: ${err instanceof Error ? err.message : String(err)}`);
```

**Impact:** Removes expensive `Intl.DateTimeFormat.formatToParts()` calls from 3 debug paths. Noticeable for line 623 which fires frequently.

---

## Analysis Methodology

For each log call:
1. **Is it in a tight loop?** (per-tick, per-quote, per-signal)
2. **Does it have expensive template interpolations?**
   - ✅ Cheap: `.toFixed()`, `.length`, property access, `.join()`, string concat
   - ⚠️ Moderate: `.padStart()`, `.slice(0,n)` on small strings
   - ❌ Expensive: `JSON.stringify()`, `Intl.*`, `.formatToParts()`, `forEach/map` on large arrays
3. **Is it at a suppressed log level?** (debug logs that won't print but still evaluate)

---

## Files Analyzed

- ✅ `src/backtest/sim-broker.ts` — 3 problematic debug logs (lines 415, 456, 623)
- ✅ `src/backtest/market-data.ts` — No issues
- ✅ `src/orders/order-manager.ts` — No issues
- ✅ `src/backtest/databento-tape.ts` — No issues
- ✅ `src/backtest/runner.ts` — No issues
- ✅ `src/pipeline/execute.ts` — No issues

**Total: 46 log calls, 3 with expensive interpolations (all in sim-broker.ts)**
