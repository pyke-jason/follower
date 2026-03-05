# Audit: Intersections & Conflict Map

## 1. File-Level Conflict Matrix

### parser.ts — Most-Touched File

All five parser changes (BUG-1, BUG-2, BUG-3, BUG-4, ISSUE-3) cluster in a 200-line band
around the direction derivation and action determination blocks.

| Fix | Lines Touched | What Changes |
|-----|---------------|--------------|
| BUG-1 | 732–744 | Direction derivation: STOCK branch — badge takes precedence over `SHORTING_RE` |
| BUG-4 | 732–734 | Direction derivation: `isLotto` block — guard with `!hasShortBadge` |
| BUG-2 (Opt A) | 834–840 (new block after line 834) | New suppression rule: delete `multi_ticker` for exit + non-actionable secondary ticker |
| BUG-3 (Fix A) | 784 | Action determination: add `!EXIT_VERB_CONDITIONAL_RE.test(cleanText)` guard to no-badge exit detection |
| BUG-3 (Fix C) | 855 or extractTradeFields | Null out `premiumHint` for STOCK strategy |
| ISSUE-3 (Opt B) | 664–671 | mixed_action detection: add Exit+Short+multi_ticker case |

**Overlap zones:**

- **Lines 732–755 (direction derivation block):** BUG-1 and BUG-4 BOTH rewrite this block.
  - BUG-1 restructures the `else if (strategy === 'STOCK')` branch (lines 735–744) to make badge
    precedence conditional.
  - BUG-4 modifies the `if (isLotto)` block (lines 732–734) which is the first branch in the
    same `if/else if` chain.
  - These two changes are in **adjacent but non-overlapping branches** — no textual conflict
    if applied sequentially, but they must be reviewed as a unit to ensure the combined
    direction semantics are correct (see Section 3).

- **Lines 783–821 (no-badge action detection):** BUG-3 Fix A adds a new guard at line 784.
  This is a single-line guard injection; it does not conflict with BUG-2's changes, which
  are inserted after line 834 (the relational suppression block).

- **Lines 827–834 (relational suppression block):** BUG-2 proposes adding a parallel block
  immediately after this. BUG-3 notes that this block is a compounding factor for the MSTR
  bug. No textual conflict — BUG-2 adds code after line 834, BUG-3 does not modify lines
  827–834. However, both analyses reference this block as context — reviewers must confirm
  the intended behavior of these two suppression blocks together.

- **Lines 664–671 (mixed_action detection):** ISSUE-3 Opt B proposes adding a new condition
  here. BUG-3 does not touch this block. No conflict.

### llm-path.ts — Single Change, Broad Impact

| Fix | Lines Touched | What Changes |
|-----|---------------|--------------|
| ISSUE-3 (Opt A) | 172–174 | `buildNLUPrompt()`: suppress `action`/`strategy`/`direction` when `multi_ticker` is set |
| BUG-2 (Opt B) | New logic in agent handling | Add constraint: Exit badge prevents SKIP decision |

- ISSUE-3 Opt A and BUG-2 Opt B both touch the LLM prompt / agent decision path but at
  different layers (prompt construction vs. agent authority). No direct line conflict.
- ISSUE-3's change (lines 172–174) modifies what fields are sent in the prompt. BUG-2 Opt B
  would add a post-processing constraint on what the LLM can return. These are independent.

### sim-broker.ts — Isolated

| Fix | Lines Touched | What Changes |
|-----|---------------|--------------|
| ISSUE-1 | 545–589 | `sweepExpired()`: wrap `getQuote` in try/catch per leg, default underlying=0 |

No other fix touches sim-broker.ts. No conflicts.

### Other Files — No Conflicts

| File | Fix | Change |
|------|-----|--------|
| `src/parsing/html.ts` | BUG-5 Layer 1 | Strip trailing non-word chars in `htmlToCleanText` |
| `src/db/schema.ts` | BUG-5 Layer 1 | Add `contentHash` column + unique index |
| `src/ingestion/ingest.ts` | BUG-5 Layer 1 | Compute/store `contentHash` on insert |
| `src/live/factory.ts` | BUG-5 Layer 2 | Near-duplicate query before task insert |
| `src/orders/risk-check.ts` | BUG-5 Layer 3 | Time-window guard on OPEN for same symbol+direction |
| `src/backtest/runner.ts` | ISSUE-1 | Verify sweepThrough logic for same-day expiry |
| drizzle/migrations/ | BUG-5 | Migration for contentHash column |

None of these files are touched by any other fix.

---

## 2. Shared Root Causes

### Group A — Badge Authority vs. Heuristics (BUG-1, BUG-4)

Both bugs are caused by the parser applying a heuristic rule that unconditionally overrides
an authoritative badge:

- **BUG-1**: `SHORTING_RE` fires on trailing commentary "fundamental short" and flips a
  verified `Long` badge to `direction=SHORT`.
- **BUG-4**: The `isLotto` block forces `direction=LONG` unconditionally, ignoring the
  explicit `Short` badge on "Short ABNB Lotto $123 Puts".

**Shared fix pattern**: When an unambiguous badge is present, the badge wins. Heuristic verb
and strategy overrides apply only in the absence of a definitive badge signal.

Both fixes are in the direction derivation block (lines 728–755) and follow the same logic:
"if badge is definitive, skip the heuristic override."

### Group B — Multi-Ticker Routing and LLM Anchoring (BUG-2, ISSUE-3)

Both bugs arise because the `multi_ticker` complexity flag routes a message to the LLM path,
and the LLM then either skips it or produces only one signal.

- **BUG-2**: VIX appears in explanatory text. The TSLA exit is unambiguous but gets routed
  to LLM, which skips it.
- **ISSUE-3**: The parser anchors to the first symbol (TXN) and passes `action=CLOSE` to the
  LLM prompt; the TSLA OPEN signal is never emitted.

**Shared fix pattern (two complementary layers)**:
1. *Parser layer*: Suppress `multi_ticker` for exit actions when secondary tickers are
   commentary-only (BUG-2 Opt A).
2. *LLM prompt layer*: When `multi_ticker` remains set, do not pre-anchor the LLM to the
   first-symbol fields (ISSUE-3 Opt A). Let the LLM re-derive all per-signal fields.

These two fixes are complementary and non-conflicting. BUG-2's fix reduces LLM invocations;
ISSUE-3's fix improves LLM output quality when invocation still happens.

**Dependency**: BUG-2 Opt A must be applied before or alongside ISSUE-3 Opt A. If BUG-2's
suppression fires for a message, it never reaches the LLM, so ISSUE-3's prompt change is
irrelevant for that message. But ISSUE-3's fix is independently valuable for genuinely
multi-ticker messages (two tradeable tickers) that legitimately reach the LLM.

### Group C — Conditional Language Not Handled (BUG-3)

`EXIT_VERB_RE` fires on "exit" regardless of grammatical modality. "I would be looking to
exit" and "Exit TSLA" both match, but only the latter is an executed signal.

**Unique root cause**: The other bugs involve wrong field derivation from authoritative
signals. BUG-3 involves the parser treating a hypothetical future action as a present one.

Fix requires a new `EXIT_VERB_CONDITIONAL_RE` guard and optionally nulling `premiumHint` for
STOCK strategy to prevent the `fullyResolved` shortcut from suppressing `extra_text`.

No shared root cause with any other bug, but BUG-3 Fix C (STOCK premiumHint nulled) would
also improve robustness of the `extra_text` guard for ISSUE-3 (the premiumHint=328.81 from
TSLA's price feeding as a false premium is the same extraction pattern).

### Group D — Content-Level Dedup Gap (BUG-5)

Entirely distinct. The pipeline assumes one-message-one-task, but Discord can deliver
near-identical messages with different IDs seconds apart.

No shared root cause with any other bug.

### Group E — Sweep Fragility on Missing Market Data (ISSUE-1)

Entirely distinct. The sweep infrastructure exists and is correct in design; `sweepExpired`
silently drops positions when `getQuote` throws.

The ISSUE-1 fix only touches `sim-broker.ts` and `runner.ts`. No shared root cause with
any parser bug.

---

## 3. Merge Conflict Risks in parser.ts

### High Risk: Lines 732–744 (direction derivation)

BUG-1 and BUG-4 both rewrite the direction block. If applied as separate patches, the
second patch must be aware of the first's structural change.

**Current structure:**
```typescript
// line 732
if (isLotto) {
  direction = 'LONG';                           // BUG-4 modifies THIS branch
} else if (strategy === 'STOCK') {
  if (hasLongBadge && !hasShortBadge) direction = 'LONG';  // BUG-1 restructures
  else if (hasShortBadge && !hasLongBadge) direction = 'SHORT';
  else direction = null;
  if (BOUGHT_BUYING_RE.test(cleanText)) direction = 'LONG';
  if (WROTE_WRITING_RE.test(cleanText)) direction = 'SHORT';
  if (SOLD_RE.test(cleanText) && !EXIT_VERB_RE.test(cleanText)) direction = 'SHORT';
  if (SHORTING_RE.test(cleanText)) direction = 'SHORT';  // BUG-1 conditionalizes this
} else if (strategy === 'CALL' || strategy === 'PUT') {
  ...
}
```

**After BUG-1** (badge precedence over SHORTING_RE in STOCK branch):
- Lines 735–744 are restructured into a badge-conditional block.

**After BUG-4** (badge precedence over isLotto):
- Line 732–734 become `if (isLotto && !hasShortBadge)` with an `else if (isLotto && hasShortBadge)`.

**Combined result** (must be written as a single cohesive block):
```typescript
if (isLotto && !hasShortBadge) {
  direction = 'LONG';
} else if (isLotto && hasShortBadge) {
  direction = 'SHORT';
} else if (strategy === 'STOCK') {
  if (hasLongBadge && !hasShortBadge) {
    direction = 'LONG';
    // SHORTING_RE does not override an authoritative Long badge
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

**Verdict**: These MUST be applied as a single atomic commit. Separate patches on lines
732–744 will conflict at the git level.

### Low Risk: Lines 784 vs. 834

BUG-3 Fix A inserts a guard at line 784. BUG-2 Opt A inserts a new suppression block after
line 834. These are ~50 lines apart with no overlap. Standard git merge will succeed.

### Low Risk: Lines 664–671

ISSUE-3 Opt B adds a case to the `if (hasExitBadge && ...)` block. No other fix touches
this block. No conflict.

---

## 4. Dependency Ordering

### Strict Dependencies (must-before)

1. **BUG-1 + BUG-4 must ship in a single commit** (or BUG-4 first, BUG-1 second with full
   awareness). Both rewrite the same direction block. Shipping separately risks one reverting
   the other's structural change.

2. **BUG-2 Opt A should land before ISSUE-3 Opt A** (soft dependency, not strict). BUG-2
   reduces the set of multi_ticker messages that reach the LLM. ISSUE-3 changes what the
   LLM receives for those that do reach it. The fixes are independent but BUG-2 simplifies
   the state space that ISSUE-3 must handle.

3. **BUG-3 Fix C (STOCK premiumHint null) and BUG-3 Fix A (EXIT_VERB_CONDITIONAL_RE) should
   ship together** — they address two compounding factors in the same bug. Shipping Fix A
   without Fix C leaves the `fullyResolved` shortcut still suppressible by a misidentified
   premiumHint, which could cause a regression on a different message.

### Recommended Implementation Order

1. **BUG-1 + BUG-4 (atomic)** — direction block rewrite. Highest correctness impact.
   Affects lines 732–755. Single commit.

2. **BUG-3 Fix A + Fix C (atomic)** — conditional exit guard + STOCK premiumHint nulled.
   Affects lines 784 and extractTradeFields/premiumHint assignment (~line 855). Single commit.

3. **BUG-2 Opt A** — multi_ticker suppression for exit + commentary tickers. Affects lines
   834–840 (new block). Single commit. Stand-alone; safe to apply after steps 1–2.

4. **ISSUE-3 Opt A** — LLM prompt: suppress pre-parsed fields when multi_ticker is set.
   Affects llm-path.ts lines 172–174. Single commit. Apply after BUG-2 (step 3) so the
   set of LLM-routed multi_ticker messages is already reduced.

5. **ISSUE-3 Opt B** (optional, low risk) — Add `mixed_action` for Exit+Short+multi_ticker.
   Affects parser.ts lines 664–671. Can be bundled with step 4 or separate.

6. **BUG-5 Layer 1** — Schema migration + content hash normalization. Affects schema.ts,
   html.ts, ingest.ts, migrations/. Should be batched with any other pending schema changes
   (none identified here).

7. **ISSUE-1** — sweepExpired robustness. Affects sim-broker.ts. Isolated; no ordering
   dependency.

8. **ISSUE-2** — Investigate broker fill price correctness. No code changes identified yet
   beyond investigation; spreadMaxRisk dead parameter cleanup if desired.

### Multi-Ticker Suppression Interaction (BUG-2 Opt A vs. ISSUE-3 Opt A)

BUG-2 Opt A and ISSUE-3 Opt A are designed to work together. After BUG-2 suppresses
`multi_ticker` for unambiguous exit + commentary-ticker messages, the LLM path is only
invoked for genuinely multi-ticker messages. ISSUE-3's prompt change then ensures those
genuinely multi-ticker messages don't get anchored to the first symbol.

If only ISSUE-3 is applied (without BUG-2), the TSLA-VIX exit message (464090) still reaches
the LLM — but now without pre-anchored action=CLOSE/direction, the LLM might actually emit
the correct TSLA close. This is a useful safety net but not as reliable as BUG-2's
deterministic suppression.

If only BUG-2 is applied (without ISSUE-3), the TXN+TSLA concatenated message (463439)
still reaches the LLM with action=CLOSE/symbol=TXN anchored, and TSLA OPEN remains missed.
BUG-2 does NOT fix ISSUE-3's case because 463439 has two tradeable tickers (not a
commentary-only secondary), so the suppression condition `NON_ACTIONABLE_TICKERS.has(symbols[1])`
would not fire.

**Conclusion**: BUG-2 and ISSUE-3 fix different message shapes. Both are needed for full
coverage.
