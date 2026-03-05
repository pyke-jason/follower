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

**Scale**: 752 `"no open position found"` decisions across existing runs. Top symbols:
C (56), SPY (48), TSLA (44), UNH (32), IREN (32). This is a large fraction of all
flagged decisions.

## Seam analysis

Investigated every integration point to find the cleanest boundaries.

### Seam 1: `parseResult` types (orchestrator → runner)

The orchestrator attaches `parseResult` to **every** `OrchestratorResult` variant.
`process-task.ts` forwards it for SKIP and MANUAL_REVIEW outcomes. So
`result.parseResult` is reliably available in the runner's `onResult` callback.

**Problem**: `OrchestratorResult.parseResult` is typed as `Record<string, unknown>`.
This exists because `serializeParseResult()` in `orchestrator/index.ts` takes the
strongly-typed `ParseResult` and manually copies each field into a plain object
(to convert `complexityFlags: Set` → array). The return type is declared as
`Record<string, unknown>`, throwing away all type information.

**Fix**: Create a serializable version of `ParseResult` and use that as the type:

```ts
// In orchestrator/types.ts:
export type SerializedParseResult = Omit<ParseResult, 'complexityFlags'> & {
  complexityFlags: ComplexityFlag[];
};
```

Then `serializeParseResult()` returns `SerializedParseResult`, and
`OrchestratorResult.parseResult` is typed as `SerializedParseResult` instead of
`Record<string, unknown>`. All downstream consumers (process-task, backtest runner)
get typed access to `.action`, `.symbol`, etc. with zero casts.

### Seam 2: skipCategory storage (emitter → DB → UI) — BROKEN

**Current state is split**:

| Path | Column | Snapshot JSON | UI reads from |
|---|---|---|---|
| Legacy runs (pre-emitter) | `skip_category` has data | empty | column ✅ |
| Modern runs (emitter) | NULL | `snapshot.skipCategory` | column ❌ |

The emitter (`src/decisions/emitter.ts`) writes `skipCategory` into the `snapshot`
JSON payload, NOT the `skip_category` text column. But the UI (`decision-timeline.tsx`)
reads `d.skipCategory` from the **Drizzle-inferred column** (`RunDecision` type).

**Result**: Skip categories are **invisible in the UI for all recent runs**. The
timeline shows nothing because the column is always NULL.

**Fix**: Add `skipCategory` to `EmitOpts` and write it to the column. Stop putting
it in the snapshot payload — it was only there as a workaround. The column exists,
the UI reads from it, just write to it.

### Seam 3: Shadow map lifecycle (runner closure)

`BacktestContext` is a read-only dependency injection struct — no mutable state.
Mutable state lives as locals in the `runBacktestInner()` closure (e.g., `stats`,
`skipReasons`, `pendingIntents`). Messages process **strictly sequentially** (for-await
loop), so a plain `Map` is thread-safe.

**Verdict**: Shadow map goes as a local `Map` in `runBacktestInner()`, passed to
`processMessage()` alongside `stats`. Follows the exact `skipReasons` pattern.

### Seam 4: Reason string as a detection heuristic

`position-path.ts:94` produces exactly one format:
```ts
return { flagReason: `no open position found for ${symbol}` };
```

This is the **only** code path that produces this prefix. Using
`result.reason.startsWith('no open position found')` is safe and unambiguous —
no other MANUAL_REVIEW reason starts with this string.

### Seam 5: Skip category aggregation in UI

The backtest detail page (`page.tsx`) computes decision stats in `computeFromTrades()`,
but only counts total skipped — no per-category breakdown. The decision breakdown
is only visible per-decision in the timeline popover (which is broken per Seam 2).

The console `printReport()` in `src/backtest/report.ts` does print skip reasons,
but only from the ephemeral `stats.skipReasons` map — not persisted.

**Verdict**: Fixing Seam 2 gets the new category into the DB and timeline
automatically. A skip-category breakdown chart is a follow-up.

## Implementation plan

### Step 0: Fix `parseResult` typing

**File: `src/intents/orchestrator/types.ts`**

Add serializable parse result type:

```ts
export type SerializedParseResult = Omit<ParseResult, 'complexityFlags'> & {
  complexityFlags: ComplexityFlag[];
};
```

Update `OrchestratorResult` to use `SerializedParseResult` instead of
`Record<string, unknown>`.

**File: `src/intents/orchestrator/index.ts`**

Change `serializeParseResult()` return type from `Record<string, unknown>` to
`SerializedParseResult`.

**File: `src/pipeline/process-task.ts`**

Update `ProcessTaskResult` type — `parseResult` becomes `SerializedParseResult`.

Now the runner can access `result.parseResult?.action` and `.symbol` with full
type safety, no casts.

### Step 1: Fix skipCategory column write

**File: `src/decisions/emitter.ts`**

Add `skipCategory` to `EmitOpts`, write to the column:

```ts
export type EmitOpts = {
  // ...existing...
  skipCategory?: string | null;
};

// In insert:
skipCategory: opts?.skipCategory ?? null,
```

**File: `src/backtest/runner.ts`**

Move `skipCategory` from the payload object to the opts object at all 4 emit sites.
Stop putting it in the snapshot payload.

### Step 2: Reclassify `no open position` as `unfollowed_exit`

**File: `src/backtest/runner.ts`** — in `onResult` callback:

```ts
} else if (result.outcome === 'MANUAL_REVIEW') {
  const isUnfollowedExit = result.reason.startsWith('no open position found');
  const category = isUnfollowedExit ? 'unfollowed_exit' : 'flagged';
  stats.skipped++;
  stats.skipReasons.set(category, (stats.skipReasons.get(category) ?? 0) + 1);
  await emitter.emit('SETTLED',
    { outcome: 'SKIP' },
    { outcome: 'SKIP', phase: 'orchestrator', reasoning: result.reason, skipCategory: category },
  );
}
```

### Step 3: Shadow position registry (deferred)

Not needed for Steps 0-2. The reason-string detection catches 100% of cases.
Shadows become useful only if we want to short-circuit before entering the
orchestrator (saving LLM calls for doomed exits). Defer until LLM cost is a concern.

## What NOT to do

- Don't modify `position-path.ts` or `matchPosition()` — keep orchestrator pure
- Don't store shadows in the DB — they're ephemeral per-run state
- Don't apply to live trading — live correctly goes to MANUAL_REVIEW
- Don't try to "execute" shadow closes

## Risks

**False matches from shadow registry** (Step 3 only): Pete skips TSLA PUT open,
then later has a *different* TSLA position (TSLA CALL that we did follow). The CLOSE
for the followed CALL should NOT hit the shadow. This is fine because
`getPositions()` will return the real CALL position, `matchPosition()` will match it,
and we never reach the `"no open position found"` path. Shadows only activate when
real positions return empty.

## File change summary

| File | Change | Step |
|---|---|---|
| `src/intents/orchestrator/types.ts` | Add `SerializedParseResult`, update `OrchestratorResult` | 0 |
| `src/intents/orchestrator/index.ts` | Type `serializeParseResult()` return | 0 |
| `src/pipeline/process-task.ts` | Update `ProcessTaskResult.parseResult` type | 0 |
| `src/decisions/emitter.ts` | Add `skipCategory` to `EmitOpts`, write to column | 1 |
| `src/backtest/runner.ts` | Move skipCategory to opts (4 sites), reclassify no-position | 1+2 |
