# PLAN: Lazy Eval — Replace CLI Runs with Live Accuracy Views

## Motivation

The current eval workflow requires a manual `npm run eval` CLI step that:
1. Reads all reviewed labels
2. Joins them against intents
3. Computes accuracy metrics
4. Persists to `evalRuns` table

This is unnecessary. The comparison is a simple join + aggregate — SQLite can
compute it on-the-fly in <50ms for thousands of labels. A "run" adds friction
and stale data without providing any benefit (there's no expensive model
inference happening during eval, unlike the old label-runner).

**Goal:** Accuracy is always live. No CLI step. Two views:
1. `/eval` — global accuracy dashboard (all reviewed labels vs latest intents)
2. `/backtests/[id]?tab=accuracy` — per-backtest accuracy (labels vs that run's decisions)

---

## Design

### What changes

| Before | After |
|--------|-------|
| `npm run eval` CLI script | Deleted |
| `evalRuns` table stores snapshots | Deleted (drop table) |
| `/eval` page reads `evalRuns` table | `/eval` page computes accuracy live from `messageLabels` ⟗ `messageIntents` |
| No accuracy in backtest detail | New "Accuracy" tab compares `messageLabels` ⟗ `runDecisions` for that run |
| `accuracy-chart.tsx` plots evalRun history | Replaced with a single accuracy breakdown bar/grid |

### What stays the same

- `messageLabels` table (ground truth) — no changes
- `messageIntents` table (extraction cache) — no changes
- `runDecisions` table (backtest decisions) — no changes
- Approve/edit buttons on `IntentStrip` — no changes
- Label creation flow — no changes

---

## Steps

### 1. New query: `computeAccuracy()`

**File:** `web/lib/queries.ts`

Add a function that joins `messageLabels` (reviewed=true) against `messageIntents`
(latest version per message) and computes per-field accuracy in a single pass.
Returns something like:

```ts
type AccuracyResult = {
  totalLabels: number;
  fields: Record<string, { correct: number; total: number; accuracy: number }>;
  // fields: isTrade, action, direction, strategy, symbol, price, strikes
  overallAccuracy: number; // all-fields-match rate
  failures: { messageId: string; cleanText: string; field: string; expected: string; got: string }[];
};
```

This replaces the logic currently in `run-eval.ts`. The comparison logic
(normalizeNull, priceMatch, strikesMatch) moves into `web/lib/eval-helpers.ts`.

Two variants:
- `computeGlobalAccuracy()` — compares labels vs latest intents (for `/eval`)
- `computeBacktestAccuracy(backtestRunId)` — compares labels vs `runDecisions`
  for messages in that backtest (for `/backtests/[id]`)

The backtest variant joins `messageLabels` ⟗ `runDecisions` (on messageId,
filtered by backtestRunId). A `runDecision` with `decision=EXECUTE` maps to
`isTrade=true`; its trade's signal data comes from the associated
`messageIntents` row (since the backtest uses intent extraction as Phase 1).

### 2. Rewrite `/eval` page as live dashboard

**File:** `web/app/eval/page.tsx`

- Call `computeGlobalAccuracy()` directly (server component, no client fetch)
- Render:
  - MetricStrip with overall accuracy, total labels, reviewed count
  - Per-field accuracy grid (cards or horizontal bars showing each field's accuracy)
  - Failures table: show first N mismatches with message text, field, expected vs got
  - No more "eval run history" accordion — accuracy is always current
- Remove `AccuracyChart` (no longer have historical eval runs to chart)

### 3. Add Accuracy tab to backtest detail page

**Files:**
- `web/app/backtests/[id]/page.tsx` — compute accuracy and pass as tab content
- `web/app/backtests/[id]/backtest-tabs.tsx` — add fourth tab: "Accuracy"

Flow:
- `computeBacktestAccuracy(runId)` returns accuracy for labeled messages in that run
- Only shown when there are reviewed labels overlapping with this backtest's message set
- Same layout as global eval: per-field accuracy grid + failures table
- Shows "N of M messages labeled" count so users know coverage

### 4. Shared accuracy display component

**File:** `web/app/components/accuracy-grid.tsx`

A reusable component rendering the per-field accuracy result. Used by both
`/eval` and `/backtests/[id]?tab=accuracy`. Takes `AccuracyResult` as prop.

Renders:
- Grid of cards, one per field (isTrade, action, direction, strategy, symbol, price, strikes)
- Each card shows: field name, accuracy %, correct/total count, small progress bar
- Overall accuracy as a prominent header metric
- Failures table below (collapsible, showing top 20)

### 5. Delete eval run infrastructure

- Delete `src/eval/run-eval.ts`
- Drop `evalRuns` table from schema (add migration)
- Remove `npm run eval` from `package.json`
- Remove `getEvalRuns()` from `web/lib/queries.ts`
- Remove `getLabelStats()` — replaced by `computeGlobalAccuracy()` which
  returns label counts as part of its result
- Delete `web/app/eval/accuracy-chart.tsx`
- Update `AGENTS.md` to remove eval runner reference

### 6. Migration

**File:** `drizzle/0015_lazy_eval.sql`

```sql
DROP TABLE IF EXISTS eval_runs;
```

The `evalRuns` schema definition is removed from `src/db/schema.ts`.
Associated types (`EvalRun`) are removed.

---

## File change summary

| File | Action |
|------|--------|
| `web/lib/eval-helpers.ts` | **New** — comparison helpers (normalizeNull, priceMatch, strikesMatch) |
| `web/lib/queries.ts` | **Edit** — add `computeGlobalAccuracy()`, `computeBacktestAccuracy()`, remove `getEvalRuns()`, `getLabelStats()` |
| `web/app/components/accuracy-grid.tsx` | **New** — reusable accuracy display component |
| `web/app/eval/page.tsx` | **Rewrite** — live accuracy from `computeGlobalAccuracy()` |
| `web/app/eval/accuracy-chart.tsx` | **Delete** |
| `web/app/backtests/[id]/page.tsx` | **Edit** — compute and pass accuracy tab content |
| `web/app/backtests/[id]/backtest-tabs.tsx` | **Edit** — add "Accuracy" tab |
| `src/db/schema.ts` | **Edit** — remove `evalRuns` table + type exports |
| `src/eval/run-eval.ts` | **Delete** |
| `package.json` | **Edit** — remove `eval` script |
| `drizzle/0015_lazy_eval.sql` | **New** — drop evalRuns table |
| `drizzle/meta/_journal.json` | **Edit** — add migration entry |
| `AGENTS.md` | **Edit** — remove eval runner reference |

---

## Edge cases

- **No labels yet:** Both pages show "No reviewed labels" empty state
- **Backtest with no overlapping labels:** Accuracy tab shows "0 of N messages labeled — go to /messages to label"
- **Performance:** The join is O(labels) which will be small (hundreds, not millions).
  No caching needed — server component computes on each page load
- **Old evalRuns data:** Lost when table is dropped. Acceptable — the data
  was from the old regex-parser comparison anyway, not intent-based
