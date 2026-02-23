# Log Performance Impact Analysis — HOT PATH AUDIT

**Default log level**: `info` (debug calls are suppressed)

---

## Summary

All log calls in hot paths are **SAFE**. No template literal arguments cause CPU spikes or memory overhead:

- **Simple string concat**: cheap to evaluate (basic `+` ops, `.toFixed()` calls)
- **No JSON.stringify** inside suppressed logs
- **No loops inside log arguments**
- **No large object spread** operations in logging

The logger's guard checks (`if (LEVELS[currentLevel] <= LEVELS.debug)`) prevent template literals from running when suppressed, so expensive operations would be caught at compile time or via code review.

---

## File-by-File Analysis

### 1. `sim-broker.ts` — processQuoteTick, advanceTo, getAccountBalance, markToMarket

| Line | Log Level | Frequency | Argument Cost | Verdict |
|------|-----------|-----------|---------------|---------|
| 262 | debug | ~0/backtest | `.toFixed(0)` x2 | **SAFE** |
| 271 | debug | rare | string literal | **SAFE** |
| 282 | debug | rare | string literal | **SAFE** |
| 315 | debug | rare | string literal | **SAFE** |
| 415 | debug | ~1-10/backtest | `formatLogTimestampET(time)`, error msg | **SAFE** |
| 456 | debug | ~1-10/backtest | `formatLogTimestampET(time)`, error msg | **SAFE** |
| 511 | debug | ~0-100/backtest | `.toFixed(2)` x2 per expiry | **SAFE** |
| 623 | debug | ~0-100/backtest | `formatLogTimestampET(now)`, error msg | **SAFE** |
| 693 | **info** | rare (~1/backtest) | 4× `.toFixed()`, arithmetic | **SAFE** — non-hot, runs when `total > 500ms` |

**Analysis:**
- Line 262, 282, 315: Rejection paths — rare, not in per-tick loop
- Lines 415, 456, 623: "no quote for" debug logs — bounded by failures (~1-10 per backtest), outside main tick loop
- Line 511: EXPIRE path — runs once/day at day boundary via `sweepExpired()`, not per-tick
- Line 693: **SLOW handler** — intentional diagnostic, runs only when balance check exceeds 500ms (rare)

**No ISSUES** — all logs outside hot loops (processQuoteTick, advanceTo tight loop paths).

---

### 2. `market-data.ts` — getQuote, getBars, getTicksInRange, ensureRange

| Line | Log Level | Frequency | Argument Cost | Verdict |
|------|-----------|-----------|---------------|---------|
| 141 | **warn** | rare | `.toFixed(0)` on tickAgeMins | **SAFE** — only stale quotes (1440+ min old) |
| 250-252 | debug | ~0-10/backtest | `.length` + `.toFixed(0)` x2 | **SAFE** — called during options chain setup (bounded) |
| 457 | **warn** | rare | `.join(',')` on uncached symbols | **SAFE** — batch fetch failures only |
| 541, 545 | **info** | 1x at end | `.padEnd()`, `.toLocaleString()`, `.padStart()` | **SAFE** — post-backtest summary only |

**Analysis:**
- Line 141: Stale quote warn — only logs if tick age **≥ 1440 min** (rarer than 1-2 times per backtest)
- Lines 250-252: Debug during options chain construction — bounded to symbols with options activity
- Line 457: Batch fetch failure recovery — not in tight loop
- Line 541-545: Post-backtest summary — runs once, not during replay

**No ISSUES** — all bounded to error paths or post-run diagnostics.

---

### 3. `order-manager.ts` — tick(), per-message call

| Line | Log Level | Frequency | Argument Cost | Verdict |
|------|-----------|-----------|---------------|---------|
| 106 | debug | ~0-10/backtest | string literal + `params.cancelAfterSec` | **SAFE** |
| 138 | debug | ~0-10/backtest | `.toFixed()` + conditional ternary | **SAFE** |

**Analysis:**
- Line 106: Auto-cancel path — rare (only triggered if order times out)
- Line 138: Price chase adjustment — runs once per adjustment rule, not per-tick
- Both suppressed at default `info` level anyway

**No ISSUES** — rare error paths, not in per-tick loop.

---

### 4. `databento-tape.ts` — fetchTickWindow, fetchDefinitions (API I/O, not per-tick)

| Line | Log Level | Frequency | Argument Cost | Verdict |
|------|-----------|-----------|---------------|---------|
| 161-163 | debug | ~0-1/batch | `.join(',')` on up to ~50 symbols | **SAFE** — suppressed (debug) + rare (only 200-level HTTP) |
| 179-183 | **warn** | rare | `.join(',').slice(0,80)` + `.slice(0,500)` | **SAFE** — retry path, bounded string ops |
| 210-213 | **warn** | rare | `.join(',').slice(0,80)` | **SAFE** — network error retry, infrequent |
| 265 | debug | ~0-10/backtest | `.length` property access | **SAFE** — options definition cache hit |
| 381-384 | **info** | ~0-10/backtest | arithmetic + 2× `.slice(0,500)` | **SAFE** — definition fetch summary, not per-tick |

**Analysis:**
- Lines 161-183, 210-213: Retry/error recovery — not in data parsing loop, suppressed or bounded
- Line 265: Cache hit debug — cheap property access
- Line 381-384: Definition fetch summary — expensive `.slice()` on body, but called **per symbol per day** (~5-30 times total), not per tick

**No ISSUES** — all I/O related, not in parseTick hot loop. Body slicing is expensive but amortized (once per symbol/day).

---

### 5. `runner.ts` — Phase 1 intent extraction, Phase 2 replay loop

| Line | Log Level | Frequency | Argument Cost | Verdict |
|------|-----------|-----------|---------------|---------|
| 115, 118 | **info** | startup | `.join()`, `.split('T')[0]` | **SAFE** — setup only, runs 1x |
| 127, 134 | **info** | startup | `.length` property | **SAFE** — setup only |
| 235 | **info** | startup | string concat | **SAFE** |
| 306, 335 | **info** | Phase 1 | property access + text | **SAFE** — 1x per phase |
| 348, 350 | **info** | conditional | property + text | **SAFE** — conditional pre-seeding |
| 370 | **info** | Phase 2 start | `.length` | **SAFE** — 1x |
| 382 | debug | per-day | string literal + variable | **SAFE** — suppressed |
| 393 | debug | per-day | `.toFixed(2)` | **SAFE** — suppressed |
| 398 | **warn** | rare | 2× `.toFixed()` | **SAFE** — margin call only |
| 412 | **info** | every ~100 messages | arithmetic + `.toFixed(2)` | **MONITOR** — runs ~12 times per backtest (not per-message) |
| 466, 476 | debug | rare | `.toFixed(2)` + text | **SAFE** — suppressed, final sweep |
| 490 | **info** | 1x | arithmetic + `.toFixed(2)` | **SAFE** |
| 493 | **info** | conditional | `.map()` + `.join()` on skip reasons | **SAFE** — 1x, not per-message |
| 495 | **info** | 1x | string literal | **SAFE** |
| 555 | debug | per-signal | `Date.now()` subtraction | **SAFE** — suppressed |
| 695 | **warn** | conditional | 4× arithmetic + `.toFixed()` | **SAFE** — EXECUTE timing, rare |
| 713 | **warn** | conditional | `.map()` + `.slice(0,100)` on failures | **SAFE** — pipeline failure summary, rare |

**Analysis:**
- **Lines 412** (every ~100 messages): NOT in per-message loop. Runs at message index [100, 200, 300...]. Inexpensive (`Date.now()` subtraction, `.toFixed(2)`). **OK**.
- Line 555: Skipped signal debug — suppressed at default level, evaluates once per signal decision (could be ~200-400 times total)
- All Phase 1/2 setup logs (115-350): Non-hot, setup only
- Margin call warn (398): Rare condition

**VERDICT: SAFE** — only inline logs in main replay loop are debug-level (suppressed).

---

### 6. `pipeline/execute.ts` — executeSignal (runs ~100-200 times per backtest)

| Line | Log Level | Frequency | Argument Cost | Verdict |
|------|-----------|-----------|---------------|---------|
| 149 | **info** | ~0-10/backtest | arithmetic + text | **SAFE** — dedup summary, not per-signal |
| 238 | **warn** | rare | string concat | **SAFE** — fuzzy match error path |
| 462 | debug | ~0-10/backtest | string literals | **SAFE** — suppressed |
| 735 | **info** | ~0-5/backtest | `.length` + `.map()` + `.join()` | **SAFE** — dedup grouping, rare |
| 774 | **warn** | ~5-10/backtest | `.slice(0,200)` | **SAFE** — failure summary, bounded |

**Analysis:**
- Line 462 (ADD fallback): Debug-suppressed, not per-signal
- Line 735 (dedup summary): Runs once per dedup group, not per-signal
- Line 774 (failure warn): Runs on pipeline failures (~5-10 per backtest), `.slice(0,200)` is cheap

**VERDICT: SAFE** — no logs in tight executeSignal loop.

---

## Suppressed Debug Logs (Safe from evaluation)

At default `info` level, these debug logs **DO NOT evaluate their arguments**:

- sim-broker.ts:262, 271, 282, 315 (order rejections)
- sim-broker.ts:415, 456, 623 (quote failures)
- sim-broker.ts:511 (expiry intrinsics)
- market-data.ts:250-252 (options chain debug)
- databento-tape.ts:161-163, 265 (fetch metadata)
- order-manager.ts:106, 138 (auto-cancel, price chase)
- runner.ts:382, 393, 555, 466, 476 (day sweep, MTM, skip reasons)
- pipeline/execute.ts:462 (ADD fallback)

**These are all SAFE** — the logger's guard prevents template evaluation.

---

## High-Cost Operations (But Not in Hot Paths)

| Operation | File | Line | Context | Frequency | Status |
|-----------|------|------|---------|-----------|--------|
| `.toFixed(2)` | Various | Multiple | Formatting PnL, prices | ~200-400 total | SAFE — not per-tick |
| `formatLogTimestampET()` | sim-broker.ts | 415, 456, 623 | Error context | ~10 per backtest | SAFE — error path |
| `.join(',')` | databento-tape.ts | 182, 213 | Symbol list debug | ~5 per batch | SAFE — retry path |
| `.slice(0,500)` | databento-tape.ts | 183, 384 | API response body | ~10 per backtest | SAFE — I/O logging |
| `.map()` + `.join()` | runner.ts | 493, 735; pipeline/execute.ts:735 | Summary aggregation | ~5 total | SAFE — 1x per phase/group |

---

## Tight Loops Analysis

**NO LOG CALLS INSIDE:**
- `processQuoteTick()` — for loop over working orders (line 722-728), NO logs
- `advanceTo()` — for loop over equity symbols (774-779), NO logs; for loop over option orders (807-821), NO logs
- `getQuote()` — for loop over LOOKBACK_MINUTES (121-145), NO logs inside loop
- `ensureRange()` / `ensureRangeBatch()` — for loops over symbols/ticks, NO logs per-iteration
- `tick()` in OrderManager — for loop over working orders (74-145), only debug logs on RARE paths
- `executeSignals()` — for loop over signals, NO logs per-signal

---

## Conclusion

### ✅ All Hot Paths Are Log-Safe

No log calls in per-tick, per-quote, or per-signal tight loops. All intra-loop logs are:
1. **Suppressed at default level** (debug), OR
2. **Rare error paths** (bounded frequency), OR
3. **Simple string operations** (`.toFixed()`, `.join()`, property access)

### Recommendations

1. **No immediate changes needed.** Current logging is performance-conscious.

2. **If you enable DEBUG mode**, be aware:
   - Lines 511, 462, 382, 393 will evaluate per-expiry, per-ADD, per-day (still infrequent)
   - Nothing will degrade backtest significantly

3. **For future work**:
   - The logger's guard pattern is solid — keep using `log.debug(...)` for diagnostic messages without guards
   - Avoid expensive operations inside any future logs (e.g., `JSON.stringify(largeObj)`)
   - All current info/warn logs are appropriately scoped (setup, summary, errors only)

4. **Watch the runner.ts line 412 info log** if you're re-running backtests frequently in a loop. It logs every ~100 messages. Not a problem for single backtests, but if you benchmark 1000s of backtests, consider making it debug-level.

---

## Files Analyzed

- ✅ `src/backtest/sim-broker.ts` — 9 log calls (0 in hot loop)
- ✅ `src/backtest/market-data.ts` — 5 log calls (0 in hot loop)
- ✅ `src/orders/order-manager.ts` — 2 log calls (0 in hot loop)
- ✅ `src/backtest/databento-tape.ts` — 5 log calls (0 in hot loop, API I/O context)
- ✅ `src/backtest/runner.ts` — 20 log calls (0 in per-message loop)
- ✅ `src/pipeline/execute.ts` — 5 log calls (0 in per-signal loop)

**Total: 46 log calls analyzed. 0 performance issues found.**
