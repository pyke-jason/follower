# Audit Seams — Parallel Implementation Plan

**Backtest reference:** df8c003c-342e-4e89-937e-42ad487429f9
**Source doc:** based on all 8 analysis docs in docs/trade-fixes/

---

## 1. Seam Groups

### Seam A — Parser direction rules (BUG-1 + BUG-4)

**Files:** `src/intents/orchestrator/parser.ts`, lines 730–755 (direction derivation block)

**BUG-1** — OSCR: badge-vs-SHORTING_RE precedence for STOCK branch.
**BUG-4** — ABNB: isLotto unconditional LONG override ignores explicit Short badge.

Both bugs live in the direction derivation block (lines 730–755). They do NOT overlap at the line level:
- BUG-4 fix: lines 732–734 (isLotto guard — change from `if (isLotto)` to `if (isLotto && !hasShortBadge)`)
- BUG-1 fix: lines 735–744 (STOCK branch — restructure to badge-wins-over-verb when badge is unambiguous)

They must be applied by ONE agent because they share the same `if/else if` block. Applying them in parallel would conflict on lines 732–744.

**Apply BUG-4 first, then BUG-1.** BUG-4 is a one-line guard addition to the `isLotto` branch. BUG-1 restructures the `else if (strategy === 'STOCK')` branch. They are logically independent but textually adjacent — apply sequentially within the same agent to avoid a merge conflict at the branch boundary.

---

### Seam B — Parser action detection + complexity (BUG-2 + BUG-3)

**Files:** `src/intents/orchestrator/parser.ts`, lines 764–875 (action detection + suppression + extra_text)

**BUG-2** — TSLA: multi_ticker suppression for exit actions with non-actionable secondary tickers. Addition after the relational suppression block at lines 827–834.
**BUG-3** — MSTR: conditional-exit guard in EXIT_VERB_RE soft detection (line 784), plus STOCK premiumHint nulling in fullyResolved check (lines 867–875).

These fixes touch adjacent but non-overlapping lines:
- BUG-3 Fix A: line 784 (add `!EXIT_VERB_CONDITIONAL_RE.test(cleanText)` guard; new regex constant at top of file)
- BUG-3 Fix C: line 870 (modify fullyResolved STOCK condition to not use premiumHint)
- BUG-2 fix: after line 834 (new suppression block, inserts ~12 lines after the relational suppression)

All three are in the same function (`parseMessage`), in adjacent regions. ONE agent applies all three to avoid merge conflicts at lines 784–875.

**Apply in order: BUG-3 Fix A → BUG-3 Fix C → BUG-2 suppression block.** Fix A and Fix C are independent of each other; BUG-2 is additive (new block after 834), so it can go last.

---

### Seam C — LLM path anchoring (ISSUE-3)

**Files:** `src/intents/orchestrator/llm-path.ts`, function `buildNLUPrompt` (lines 157–198)

**Change:** When `parse.complexityFlags.has('multi_ticker')`, suppress pre-parsed `action`, `strategy`, `direction` from the NLU prompt. Keep `strikes`, `expiryHint`, `premiumHint` — those are symbol-agnostic.

This is fully isolated to `llm-path.ts`. No overlap with Seam A or Seam B. One agent applies it independently.

**Note:** ISSUE-3 also optionally adds `mixed_action` detection to the parser (Option B in the doc) — but the analysis recommends Option A (prompt change) as sufficient. If Option B is added, it touches lines 664–671 in parser.ts. This would overlap with Seam B's work region. **Do not implement parser Option B unless Seam B is complete.** Leave it out unless explicitly requested.

---

### Seam D — Dedup (BUG-5)

**Files:**
- `src/parsing/html.ts` — strip trailing non-word chars in `htmlToCleanText`
- `src/db/schema.ts` — add `contentHash` column + unique index
- `src/ingestion/ingest.ts` — compute and store `contentHash` on insert
- `src/live/factory.ts` — optional: near-duplicate guard before task insert
- `src/orders/risk-check.ts` — optional: time-window guard for duplicate OPEN
- `drizzle/migrations/` — new migration for `contentHash` column

None of these files are touched by Seams A, B, or C. Fully isolated. One agent applies all layers.

**Priority within Seam D:**
1. Layer 1 (html.ts normalization + schema contentHash index + ingest.ts hash computation) — primary fix, requires migration
2. Layer 3 (risk-check.ts time-window guard on OPEN) — strongest safety net, no migration
3. Layer 2 (factory.ts near-duplicate query) — defense-in-depth backstop, lowest priority

Start with Layer 1 as it is the architectural fix. Layer 3 can be applied independently since `risk-check.ts` is already untouched by any other seam.

---

### Seam E — Expiry sweep (ISSUE-1)

**Files:** `src/backtest/sim-broker.ts`, lines 545–589 (`sweepExpired`)

**Change:** Wrap the `getQuote` call per leg in a try/catch. On error, default `underlyingPrice = 0` and log a warning. This ensures all expired positions are always closed even when market data is unavailable.

Fully isolated to `sim-broker.ts`. No overlap with any other seam.

---

### Seam F — Option sizing investigation (ISSUE-2)

**Status: Investigation, not implementation.** The analysis doc concluded that `getEntryPriceEstimate` is already correct. The real issue is that the broker fill price may be returning the underlying price instead of the option premium. Requires investigating `src/broker/sim/` and `src/broker/ibkr/` fill price sources.

**Files to investigate:**
- `src/broker/sim/` — SimBroker `placeOrder` return value for options
- `src/broker/ibkr/` — IbkrBroker fill price for option orders

**Potential overlap with Seam E:** Both Seam E and Seam F read from `sim-broker.ts`, but Seam F's investigation is in the sim broker's fill logic, not `sweepExpired`. The lines are distinct. If Seam F results in an implementation change to `sim-broker.ts`, coordinate with Seam E agent to avoid conflicts (both agents commit to different line ranges).

**Recommended:** Run Seam F investigation after Seam E is complete, or ensure separate line regions are confirmed before parallelizing.

---

## 2. Summary Table

| Seam | Bugs/Issues | Files | Lines | Parallelizable |
|------|-------------|-------|-------|----------------|
| A | BUG-1, BUG-4 | parser.ts | 730–755 | Independent of B/C/D/E |
| B | BUG-2, BUG-3 | parser.ts | 764–875 | Independent of A/C/D/E |
| C | ISSUE-3 | llm-path.ts | 157–198 | Independent of all |
| D | BUG-5 | html.ts, schema.ts, ingest.ts, factory.ts, risk-check.ts | various | Independent of all |
| E | ISSUE-1 | sim-broker.ts | 545–589 | Independent of A/B/C/D |
| F | ISSUE-2 | sim-broker.ts (broker/sim, broker/ibkr) | fill logic | Coordinate with E |

**Seams A, B, C, D, E can all run in parallel.** Seam F should run after E or with confirmed non-overlapping line ranges.

---

## 3. Cross-Seam Dependencies

### Seam B reduces LLM traffic for Seam C

The multi_ticker suppression in Seam B (BUG-2) means fewer CLOSE/TRIM/LEG_OFF messages with non-actionable secondary tickers will reach the LLM path. Specifically, any exit message with VIX/SPY/QQQ as a secondary ticker is now handled deterministically.

However, Seam B does NOT suppress multi_ticker for OPEN signals or for messages with two tradeable tickers. The ISSUE-3 scenario (Exit TXN + Short TSLA concatenated) has `action=CLOSE` from Exit badge and `symbols=[TXN, TSLA]`. Both TXN and TSLA are tradeable — Seam B's NON_ACTIONABLE_TICKERS guard would NOT fire for this case. TSLA is not in the non-actionable set.

**Conclusion: Seams B and C are complementary, not redundant.** Seam B handles the easy case (exit + index/commentary ticker). Seam C handles the hard case (multi-trade decomposition with all tradeable tickers). Both are needed.

### Seam A feeds Seam C quality

BUG-1's fix (badge wins over SHORTING_RE for STOCK OPEN) affects messages routed to the LLM. Currently, OSCR-type messages arrive at the LLM with a pre-poisoned `direction=SHORT`. After Seam A, they arrive with `direction=LONG`, so the LLM starts from a correct anchor. This means the LLM path needs to do less correction work. Seam C's multi_ticker suppression further improves this by not sending misleading anchors for multi-ticker messages.

Both seams improve LLM path correctness. They are additive, not conflicting.

### BUG-4 expiry component links to ISSUE-1 (Seam E)

BUG-4's direction inversion is in Seam A. BUG-4's open-at-expiry symptom is in Seam E. They are different bugs in the same trade. Seam A fixes the direction; Seam E fixes the expiry close. Both are needed for ABNB trade 9ae30c1a to be correct.

---

## 4. Test Strategy

### Seam A (parser direction)

1. Write unit tests against the parser for:
   - Message 466237 (OSCR): parser should return `direction=LONG, action=OPEN` after fix
   - ABNB lotto message: parser should return `direction=SHORT, action=OPEN` after fix
2. Re-run backtest df8c003c and verify:
   - Trade 5c25bcef (OSCR): recorded as `direction=LONG, legs=[{action:BUY,symbol:OSCR}]`
   - Trade 9ae30c1a (ABNB PUT): recorded as `direction=SHORT, legs=[{action:SELL,...}]`

### Seam B (parser action + complexity)

1. Unit tests:
   - Message 464090 (TSLA): parser should NOT have `multi_ticker` in complexityFlags after fix (VIX is non-actionable)
   - Message 464092 (MSTR hold): parser should NOT set `action=CLOSE`; should stay `action=null` or route to LLM
2. Re-run backtest df8c003c and verify:
   - Message 464090: `run_decisions.decision=EXECUTE` with `symbol=TSLA, action=CLOSE`
   - Message 464092: `run_decisions.decision=SKIP` (hold message not executed)
   - Trade 170a1c38 (MSTR): not spuriously closed

### Seam C (LLM anchoring)

1. Re-run backtest df8c003c on message 463439 and verify:
   - Two SIGNAL_RESOLVED events: TXN CLOSE + TSLA SHORT OPEN
   - Trade opened for TSLA SHORT from that message
2. Manually inspect LLM prompt for a multi_ticker message after fix to confirm action/strategy/direction are omitted.

### Seam D (dedup)

1. Unit test for `htmlToCleanText`: input ending in ` \` should produce same output as input without trailing `\`.
2. Verify `contentHash` is populated on new message inserts (scratchpad script).
3. Re-ingest messages 469068 and 469069 into a test DB and verify only ONE task is created.
4. Check that trade 74d9b0e4 (duplicate NVDA) is not re-duplicated on a fresh backtest run.

### Seam E (expiry sweep)

1. Verify that `sweepExpired` does not throw when `getQuote` fails for any leg — unit test with a mock that throws.
2. Re-run backtest df8c003c and verify:
   - Trades for QS $9.50P (Sept 19), VST $235C (Sept 19), NVDA $170P (Sept 19) are closed with a CLOSE event on their expiry date.
   - ABNB $123P (Sept 5): verify whether the same-day expiry edge case is caught by the final day block. If not, document as known limitation.
3. Confirm `openAtEnd` count decreases in the rerun.

### Seam F (sizing investigation)

1. Query sim-broker fill logic: for an option order, what value is returned as `filledPrice`?
2. Compare against what is stored in `trades.entryPrice` for trades that show stock-price-scale values.
3. If bug confirmed, write a targeted fix in broker fill logic and verify with a fresh backtest that option `entryPrice` is in premium scale.

---

## 5. Implementation Order Recommendation

If running all seams in parallel:
- Start Seams A, B, C, D, E simultaneously.
- Seam F starts after Seam E completes (or coordinate on sim-broker.ts line ranges).

If running sequentially (risk-averse):
1. Seam E (smallest, fully isolated, high-confidence fix)
2. Seam A (parser direction — 2 fixes, adjacent lines)
3. Seam B (parser action — 3 changes, broader region)
4. Seam C (llm-path.ts — isolated file, low risk)
5. Seam D (multi-file dedup — requires schema migration, coordinate last)
6. Seam F (after investigation findings)

Run backtest df8c003c after each seam to catch regressions early.
