# Backtest Audit Fixes — bt:inland-bandicoot

Run: `bt:inland-bandicoot` | 109 trades | Realized P&L: -$5,343.49
Audit trade: `f959cf3a-4bab-49f0-ae04-d062da878854` (MSFT PDS, mechanically correct)

---

## BUG 1 — LLM LEG_OFF Closes Wrong Leg (CRITICAL)

**Impact**: $4,400+ in avoidable losses (worst single trade in run). 2 of 5 LEG_OFF trades affected.

### Problem

When "Bought back the short Puts on [SYMBOL]" arrives for a PDS (Put Debit Spread), the parser correctly sets `targetStrategy='PUT'` via `BOUGHT_BACK_SHORT_PUTS_RE`. But because `no_badge_exit` routes to the LLM path, the LLM sometimes hallucinates `targetStrategy='CALL'` (reasoning "keep the long calls" — but PDS only has PUT legs).

In `llm-path.ts:338`, the LLM value takes priority over the parser:
```ts
targetStrategy: (signal.targetStrategy as ParseResult['targetStrategy']) ??
  originalParse.targetStrategy,
```

With `targetStrategy='CALL'`, `buildLegOffLegs` sets `keepOptionType='CALL'`, finds the first PUT (the BUY/long leg), closes it, and keeps the naked SELL/short leg.

**Affected trades**: `4377ca77` (MSFT PDS -$4,400), `969895cc` (COST PDS, still OPEN wrong).

### Fix A: Parser-authoritative targetStrategy

**File**: `src/intents/orchestrator/llm-path.ts:338-339`

```diff
-    targetStrategy: (signal.targetStrategy as ParseResult['targetStrategy']) ??
-      originalParse.targetStrategy,
+    targetStrategy: originalParse.targetStrategy ??
+      (signal.targetStrategy as ParseResult['targetStrategy']),
```

The parser only sets `targetStrategy` via unambiguous regex matches. When it has a value, it's authoritative.

### Fix B: Guard in buildLegOffLegs

**File**: `src/intents/orchestrator/position-path.ts:193` (insert before existing logic)

```ts
if (keepOptionType !== null) {
  // Guard: if keepOptionType doesn't match ANY leg in the position,
  // the targetStrategy is wrong (e.g. LLM said CALL for a PDS with only PUT legs).
  // Fall back to closing the SELL (short) leg, which is correct for debit spreads.
  const hasKeepType = legs.some(
    (l) => l.type !== 'STOCK' && l.type === keepOptionType,
  );

  if (!hasKeepType) {
    log.warn(
      `LEG_OFF: keepOptionType=${keepOptionType} not found in position legs ` +
      `for ${underlyingSymbol} — closing SELL leg as fallback`,
    );
    const sellLeg = legs.find((l) => l.action === 'SELL');
    if (sellLeg) {
      return [buildReversalLeg(sellLeg, underlyingSymbol, qty)];
    }
  }

  // ... existing logic continues unchanged
```

### Verification

Scratchpad script tested all 5 LEG_OFF trades in run:

| Trade | Parser TS | LLM TS | Current | After Fix |
|-------|-----------|--------|---------|-----------|
| META CDS | CALL | CALL | Correct | Correct |
| NVDA PDS | PUT | PUT | Correct | Correct |
| MSFT PDS `4377ca77` | PUT | **CALL** | **WRONG** | Correct |
| MSFT PDS `f959cf3a` | PUT | PUT | Correct | Correct |
| COST PDS `969895cc` | PUT | **CALL** | **WRONG** | Correct |

Zero false positives. Both fixes provide defense-in-depth.

---

## BUG 2 — Duplicate Positions from Content-Hash Bypass (MODERATE)

**Impact**: Double exposure on NVDA. Consumes position slots causing downstream BUG 5 (risk blocks).

### Problem

Two messages 4 seconds apart:
- msg 469068: `"Short NVDA $175.44 - 1,000 Shares"`
- msg 469069: `"Short NVDA $175.44 - 1,000 Shares \"` (trailing backslash)

The trailing `\` produces a different content hash, bypassing dedup.

### Fix: Enhanced normalizeForDedup

**File**: `src/ingestion/ingest.ts:156-158`

```diff
 function normalizeForDedup(text: string): string {
-  return text.toLowerCase().replace(/\s+/g, ' ').trim();
+  return text
+    .toLowerCase()
+    .replace(/[\s\u00a0]+/g, ' ')          // collapse all whitespace incl &nbsp;
+    .replace(/[\s\\\/|;,!?.:\-'"]+$/, '')   // strip trailing punctuation/artifacts
+    .trim();
 }
```

### Additional Changes

| File | Change |
|------|--------|
| `src/ingestion/dedup.ts` (new) | Extract `normalizeForDedup` + `computeContentHash` as shared module |
| `src/ingestion/historical.ts:207-220` | Add `contentHash` computation to message insert |
| One-time backfill script | Populate `content_hash` for 82,884 existing messages |

### Verification

Tested against all 82,884 messages in database:
- Current normalization: 30 duplicate pairs detected
- Proposed normalization: 31 (adds only the NVDA pair)
- Zero false-positive hash collisions
- Trailing punctuation stripping only affects conversational messages, never trade content

---

## BUG 3 — Multi-Position Exit Skip (MODERATE)

**Impact**: 428 "multiple positions" skips across all backtests. 8 orphaned positions in this run (4 duplicate pairs: MSTR x2, OSCR x2, WBD x2, NVDA x2).

### Problem (Two Sub-Problems)

**Sub-A**: Pete's second "Short MSTR $325.14" was parsed as OPEN instead of ADD, creating a duplicate position. Parser is zero-I/O so can't check, but the orchestrator can.

**Sub-B**: When "Exit Short MSTR" arrives and 2 MSTR SHORT positions exist, `matchPosition` returns "multiple positions found" and skips. Both positions stay open forever.

### Fix A: ADD Detection in Orchestrator

**File**: `src/intents/orchestrator/index.ts:127-138`

When the parser returns `action=OPEN` for STOCK, and an OPEN position already exists for the same symbol/strategy/direction/trader, reroute to `action=ADD`.

```ts
// After parsing, before open-path resolution:
if (parse.action === 'OPEN' && parse.strategy === 'STOCK') {
  const existing = openPositions.find(
    (p) => p.symbol === parse.symbol
      && p.strategy === 'STOCK'
      && p.direction === parse.direction,
  );
  if (existing) {
    parse = { ...parse, action: 'ADD' };
  }
}
```

Same check needed in `src/intents/orchestrator/llm-path.ts:279` for LLM-produced OPEN signals.

### Fix B: LIFO Fallback in matchPosition

**File**: `src/intents/orchestrator/position-path.ts:112-129`

After direction tiebreaking fails:

```ts
// Fallback: close the most recently opened position (LIFO heuristic).
// Traders typically reference their most recent entry when posting exits.
const withTimestamp = candidates.filter(p => p.openedAt != null);
if (withTimestamp.length > 0) {
  withTimestamp.sort((a, b) => b.openedAt!.localeCompare(a.openedAt!));
  log.warn(
    `multiple positions for ${symbol} — using most-recent heuristic: ` +
    `${withTimestamp[0].id.slice(0, 8)} (${withTimestamp.length} candidates)`,
  );
  return { position: withTimestamp[0], strategyMismatch };
}
```

**Requires**: Add `openedAt: string | null` to `TradePosition` in `src/intents/orchestrator/types.ts`.

### Verification

- Sub-A prevents 3 of 4 multi-position skips in this run (MSTR x2, NVDA duplicate)
- Sub-B handles the residual case (NVDA STOCK LONG + PUT LONG — different strategies)
- False-positive check: tested all OPEN messages — never reroutes when strategies differ (e.g., PDS + STOCK on same symbol both stay as separate OPENs)

### Interaction Between Fixes

If Sub-A is fixed, 3 of 4 multi-position skips are prevented entirely (no duplicate created). Sub-B catches the remaining case. Together they reduce the 428 cross-backtest skips substantially.

---

## BUG 4 — Dave W Coverage Gap (SYSTEMIC, NO CODE FIX)

**Impact**: 36 unfollowed exits. Dave W's opens were never captured due to conversational style ("took some WBD calls"), missing badges, and unresolvable option chains.

Not a single bug — it's a capture-rate gap from unstructured message style. Would require either broader LLM routing for badge-less messages (cost/latency increase) or Dave W-specific parser patterns (brittle).

**Recommendation**: Track as known limitation. Most value comes from fixing Bugs 1-3 which affect structured traders.

---

## BUG 5 — End-of-Run Risk Block (DOWNSTREAM)

**Impact**: 4 trades risk-blocked ("20 total positions, max 20").

**Root cause**: Position slots consumed by duplicate positions (BUG 2) and orphaned positions (BUG 3). Fixing those bugs frees ~8 slots.

**No separate fix needed.**

---

## BUG 6 — Cross-Strategy Exit Misattribution (LOW)

**Impact**: TSLA STOCK SHORT incorrectly closed by PDS exit (-$150.92). Also affects GOOGL STOCK in other runs.

### Problem

Exit message "Exit TSLA PDS with .50 profit per contract (25)" explicitly says PDS, but fuzzy fallback matched it to the only TSLA position (STOCK SHORT). The `strategyMismatch` flag was set but didn't prevent the close.

Existing partial fix on this branch blocks STOCK<->SPREAD but misses STOCK<->SINGLE_OPTION (e.g., GOOGL STOCK closed by "took profits in calls"). Analysis of 62 mismatch trades across 209 backtests shows **the correct rule is STOCK <-> non-STOCK**, not just STOCK <-> SPREAD.

### Fix: STOCK <-> non-STOCK block

**File**: `src/intents/orchestrator/position-path.ts:105-114`

```diff
-        // Block STOCK <-> spread cross-type mismatches — these are never benign
-        const posIsStock = bySymbol[0].strategy === 'STOCK';
-        const parseIsSpread = SPREAD_STRATEGIES.has(parse.strategy!);
-        const posIsSpread = SPREAD_STRATEGIES.has(bySymbol[0].strategy);
-        const parseIsStock = parse.strategy === 'STOCK';
-        if ((posIsStock && parseIsSpread) || (posIsSpread && parseIsStock)) {
+        // Block STOCK <-> non-STOCK cross-type mismatches — these are never benign.
+        // OPTION <-> SPREAD mismatches ARE benign (e.g., "exit my calls" on a CDS
+        // after LEG_OFF, or "exit puts" on a PDS).
+        const posIsStock = bySymbol[0].strategy === 'STOCK';
+        const parseIsStock = parse.strategy === 'STOCK';
+        if (posIsStock !== parseIsStock) {
           return {
-            flagReason: `strategy mismatch: ...`,
+            flagReason: `strategy mismatch: parse=${parse.strategy}, ` +
+              `position=${bySymbol[0].strategy} — refusing STOCK/non-STOCK cross-type close`,
           };
         }
```

Also delete unused `SPREAD_STRATEGIES` constant at line 25.

### Verification

Tested across 209 backtests, 62 strategyMismatch trades:
- Every STOCK<->non-STOCK mismatch (25 trades) was incorrect — zero false positives from blocking
- Every OPTION<->SPREAD mismatch (15 trades) was benign — correctly left unblocked
- Blocked trades route to `MANUAL_REVIEW`, not silently dropped

---

## Priority Order

| # | Bug | Severity | Est. P&L Saved | Dependencies |
|---|-----|----------|---------------|-------------|
| 1 | LLM LEG_OFF wrong leg | CRITICAL | $4,400+ | None |
| 2 | Content-hash dedup | MODERATE | Prevents double exposure | None |
| 3 | Multi-position exit skip | MODERATE | Prevents orphaned positions | BUG 2 fix reduces frequency |
| 6 | Cross-strategy exit | LOW | $150-215 per occurrence | None |
| 5 | Risk blocks | DOWNSTREAM | ~4 trades unblocked | Fixed by BUG 2 + 3 |
| 4 | Dave W coverage | SYSTEMIC | N/A | No code fix planned |

## Files Modified (Summary)

| File | Bugs |
|------|------|
| `src/intents/orchestrator/llm-path.ts` | 1, 3 |
| `src/intents/orchestrator/position-path.ts` | 1, 3, 6 |
| `src/intents/orchestrator/types.ts` | 3 |
| `src/intents/orchestrator/index.ts` | 3 |
| `src/ingestion/ingest.ts` | 2 |
| `src/ingestion/historical.ts` | 2 |
| `src/ingestion/dedup.ts` (new) | 2 |

## Test Plan

1. Re-run `inland-bandicoot` backtest after fixes and diff trade count + total P&L
2. Verify MSFT `4377ca77` LEG_OFF closes SELL leg (not BUY) — P&L should improve
3. Verify COST `969895cc` LEG_OFF closes SELL leg correctly
4. Verify NVDA duplicate is deduped (1 position, not 2)
5. Verify MSTR second open routes to ADD (1 position, exit succeeds)
6. Verify TSLA STOCK not closed by PDS exit message
7. Add eval fixtures for LEG_OFF on PDS, multi-position exits, cross-strategy blocks
