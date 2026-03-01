# Shadow Positions: Track Unfollowed Opens for Honest Exit Classification

## Problem

When the backtest skips an OPEN signal (e.g., out of date range, deterministic skip,
agent says SKIP), the corresponding CLOSE/TRIM/LEG_OFF message later hits
`position-path.ts` → `getPositions()` returns `[]` → MANUAL_REVIEW with reason
`"no open position found for TSLA"`.

This is misleading in two ways:

1. **Metrics distortion** — the CLOSE gets bucketed as `flagged` (MANUAL_REVIEW) in
   the skip breakdown, indistinguishable from genuinely ambiguous signals. Backtest
   reports overcount "flagged" and you can't tell how many were caused by missing
   opens vs. real parsing problems.

2. **Wasted LLM calls** — if the CLOSE goes through the LLM path (because it has
   complexity flags), we burn tokens on a signal that will inevitably fail at position
   lookup. The orchestrator does all the parsing work, calls `getPositions()`, gets
   nothing, and flags MANUAL_REVIEW.

## Solution: Two-part fix

### Part 1: Shadow position registry (backtest-only, in-memory)

When the backtest orchestrator produces an OPEN signal that gets **skipped** (SKIP or
MANUAL_REVIEW outcome), record a lightweight "shadow position" keyed by
`(trader, symbol, strategy, direction)`.

When a CLOSE/TRIM/LEG_OFF arrives and `getPositions()` returns `[]`, check the shadow
registry. If a shadow exists → produce a new outcome: **`SKIP` with reason
`"exit for unfollowed open"`** instead of MANUAL_REVIEW.

**What a shadow stores** (minimal — no legs, no OCC symbols, no prices):

```ts
type ShadowPosition = {
  symbol: string;
  trader: string;
  strategy: Strategy;
  direction: Direction;
  /** messageId of the skipped OPEN, for traceability */
  originMessageId: string;
};
```

**Where shadows are created:**
- `backtest/runner.ts` `processMessage()` → in the `onResult` callback, when
  outcome is SKIP or MANUAL_REVIEW and the parse had `action: OPEN`, add a shadow.
- Requires the orchestrator to pass back the `parseResult` (it already does — see
  `OrchestratorResult.parseResult`).

**Where shadows are consumed:**
- `position-path.ts` does NOT consume them directly. Instead, the shadow check happens
  in the `getPositions` wrapper in `backtest/runner.ts`. When the DB query returns `[]`,
  check the shadow map. If a shadow matches, return a sentinel `OpenPosition` with a
  special `id` prefix (e.g., `shadow:<messageId>`).

  Actually — **simpler approach**: don't modify `getPositions` at all. Instead, add the
  shadow check in `processMessage`'s `onResult` callback. When the orchestrator returns
  MANUAL_REVIEW with reason matching `"no open position found for ..."`, look up the
  shadow registry. If matched → reclassify from MANUAL_REVIEW to SKIP with the new
  category.

  This is better because:
  - Zero changes to the orchestrator or position-path (pure, tested code stays untouched)
  - Shadow logic is isolated to the backtest runner where it belongs
  - No risk of a shadow position accidentally being "executed"

**Where shadows are removed:**
- When a matching CLOSE is reclassified (consumed the shadow), delete it.
- Shadows are in-memory only (a `Map<string, ShadowPosition[]>` on `BacktestContext`),
  scoped to a single backtest run. No DB storage, no cleanup needed.

### Part 2: New skip category `unfollowed_exit`

Add `"unfollowed_exit"` as a distinct skip category so it shows up separately in
backtest decision breakdowns. Today the categories are:

| Category | Meaning |
|---|---|
| `skip` | Orchestrator said SKIP (not a trade, deterministic skip) |
| `flagged` | Orchestrator said MANUAL_REVIEW (ambiguous signal) |
| `pipeline failure` | Signals produced but executor failed |
| `no execution` | Signals produced but none actually executed |

New:

| Category | Meaning |
|---|---|
| `unfollowed_exit` | Exit signal for a trade we never opened (skipped the OPEN) |

This is the **immediate bang-for-buck** — even before shadow positions, just detecting
the `"no open position found"` reason string in the MANUAL_REVIEW path and reclassifying
it gives you honest metrics.

## Implementation plan

### Step 1: Reclassify `no open position` as `unfollowed_exit` (standalone value)

**File: `src/backtest/runner.ts`** — in `onResult` callback (line 588):

```ts
} else if (result.outcome === 'MANUAL_REVIEW') {
  // Detect exits for unfollowed opens — distinct from genuine ambiguity
  const isUnfollowedExit = result.reason.startsWith('no open position found');
  const category = isUnfollowedExit ? 'unfollowed_exit' : 'flagged';
  stats.skipped++;
  stats.skipReasons.set(category, (stats.skipReasons.get(category) ?? 0) + 1);
  await emitter.emit('SETTLED',
    { outcome: 'SKIP', skipCategory: category },
    { outcome: 'SKIP', phase: 'orchestrator', reasoning: result.reason },
  );
}
```

This is ~5 lines changed. Immediately splits `flagged` into honest subcategories
in every backtest decision breakdown chart. No new types, no schema changes, no
test changes needed (the category is a freeform string already).

### Step 2: Shadow position registry (prevents wasted LLM calls)

**File: `src/backtest/runner.ts`**

a) Add a `Map<string, ShadowPosition[]>` to `BacktestContext` (or as a local in
   `runBacktest`).

b) In `onResult`, when outcome is SKIP or MANUAL_REVIEW and `result.parseResult?.action
   === 'OPEN'`, insert a shadow keyed by `(trader, symbol)`.

c) In the `getPositions` wrapper (line 553), after the DB query returns `[]`, check
   the shadow map. If a match exists, return a special sentinel position with
   `id: 'shadow:<originMessageId>'`.

d) In `position-path.ts`, the sentinel flows through `matchPosition()` normally and
   produces a CLOSE signal with `tradeId: 'shadow:...'`.

e) In `onResult`, when the executor returns a result with a shadow tradeId, reclassify
   as `unfollowed_exit` SKIP instead of trying to record a trade.

**Actually — simpler alternative for Step 2**: skip the sentinel approach entirely.
Instead, do the shadow check **before** calling `processTaskShared`:

```ts
// Before calling processTaskShared for CLOSE/TRIM/LEG_OFF messages:
// If parse shows exit action and shadow map has a match → skip immediately
// without entering the orchestrator at all.
```

But this requires pre-parsing the message to know it's an exit, which the orchestrator
does internally. So the cleanest insertion point remains the `onResult` reclassification
from Step 1, enhanced to also consume shadow entries.

### Step 2 (revised): Shadow-aware reclassification

In `onResult`, when we detect `isUnfollowedExit`:
- Check shadow map for `(msg.author, extractedSymbol)`
- If found: confirmed unfollowed exit → `unfollowed_exit` category, remove shadow
- If not found: genuinely no position (maybe the OPEN was before our date range) →
  still `unfollowed_exit` since the reason string is unambiguous

This means Step 2 mostly just adds **shadow creation** on skipped OPENs. The consumption
side is already handled by Step 1's reason-string detection, which covers the
no-shadow-found case too (OPENs from before the date range).

The shadow registry becomes useful later if we want to **early-exit** before calling
the orchestrator (saving LLM tokens), but that's a follow-up optimization.

## What NOT to do

- Don't modify `position-path.ts` or `matchPosition()` — keep orchestrator pure
- Don't store shadows in the DB — they're ephemeral per-run state
- Don't apply to live trading — live correctly goes to MANUAL_REVIEW since you
  can't close what you don't hold at the broker
- Don't try to "execute" shadow closes — the whole point is to skip them cleanly

## Risks

**False matches from shadow registry**: Pete skips TSLA PUT open, then later has a
*different* TSLA position (say TSLA CALL that we did follow). The CLOSE for the
followed CALL should NOT hit the shadow. This is fine because `getPositions()` will
return the real CALL position, `matchPosition()` will match it, and we never reach
the `"no open position found"` path. Shadows only activate when real positions
return empty.

**Multiple skipped OPENs for same symbol**: Pete skips TSLA PUT, then skips TSLA
CALL. Shadow map has two entries. Later CLOSE says "closing TSLA puts" — the
reason-string approach in Step 1 doesn't need to disambiguate (it's all going to
SKIP anyway). If we later implement shadow-based early exit (Step 2 follow-up),
we'd need strategy matching, but that's future work.

## Priority

**Step 1 alone is the bang-for-buck.** ~5 lines, zero risk, immediate metric clarity.
Step 2 (shadow registry) is a nice-to-have for saving LLM tokens on doomed exits.
