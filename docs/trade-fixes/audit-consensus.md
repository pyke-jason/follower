# Audit Consensus — Final Implementation Plan

Both auditors agree on the following seam grouping and execution plan.

## Seams (5 parallel, 1 deferred)

| Seam | Bugs | Agent | File(s) | Lines |
|------|------|-------|---------|-------|
| A | BUG-1 + BUG-4 | impl-a | parser.ts | 730–755 |
| B | BUG-2 + BUG-3 | impl-b | parser.ts | 764–875 |
| C | ISSUE-3 | impl-c | llm-path.ts | 157–198 |
| D | BUG-5 | impl-d | html.ts, schema.ts, ingest.ts, factory.ts, risk-check.ts | various |
| E | ISSUE-1 | impl-e | sim-broker.ts | 545–589 |
| F | ISSUE-2 | — | Investigation only; sizing code is correct, broker fill price suspect |

## Key Decisions

1. **BUG-1 + BUG-4 must be a single atomic commit** — they share the direction derivation if/else if chain at lines 732–755.

2. **BUG-3 Fix A + Fix C must ship together** — conditional exit guard alone is insufficient without nulling STOCK premiumHint.

3. **Seams B and C are complementary** — Seam B handles exit + commentary-ticker (VIX), Seam C handles multi-trade decomposition with tradeable tickers. Both needed.

4. **ISSUE-3 parser Option B (mixed_action detection) is deferred** — it touches lines 664–671 which overlaps with Seam B's region. Option A (LLM prompt suppression) is sufficient.

5. **Seam F deferred** — ISSUE-2 sizing code is correct; investigation into broker fill price is separate work.

## Combined Direction Block (Seam A target state)

```typescript
if (isLotto && !hasShortBadge) {
  direction = 'LONG';
} else if (isLotto && hasShortBadge) {
  direction = 'SHORT';
} else if (strategy === 'STOCK') {
  if (hasLongBadge && !hasShortBadge) {
    direction = 'LONG';
    // Badge is authoritative — SHORTING_RE does not override
  } else if (hasShortBadge && !hasLongBadge) {
    direction = 'SHORT';
  } else {
    direction = null;
    if (BOUGHT_BUYING_RE.test(cleanText)) direction = 'LONG';
    if (WROTE_WRITING_RE.test(cleanText)) direction = 'SHORT';
    if (SOLD_RE.test(cleanText) && !EXIT_VERB_RE.test(cleanText)) direction = 'SHORT';
    if (SHORTING_RE.test(cleanText)) direction = 'SHORT';
  }
} else if (strategy === 'CALL' || strategy === 'PUT') {
  ...
}
```

## Verification

Re-run backtest df8c003c after each seam and check:
- BUG-1: Trade 5c25bcef → direction=LONG
- BUG-2: Message 464090 → EXECUTE (TSLA close)
- BUG-3: Message 464092 → SKIP (hold, not close)
- BUG-4: Trade 9ae30c1a → direction=SHORT
- BUG-5: Only ONE NVDA SHORT trade from messages 469068/469069
- ISSUE-1: Expired options closed with PnL
- ISSUE-3: Message 463439 → two signals (TXN close + TSLA open)

See `docs/trade-fixes/audit-seams.md` §4 for full test strategy per seam.
