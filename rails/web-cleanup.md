# Web Layer Cleanup Rails

Findings from a systematic audit of `web/app/`. These are seam violations — inline re-implementations, missing hooks, duplicate patterns that should be extracted.

## P0: Duplicate Spinners (13 pages)

Every page defines its own `const Spinner = () => ...`. Extract once, import everywhere.

**Fix:** Create `web/app/components/spinner.tsx`, replace all 13 inline definitions.

**Files:** page.tsx, trades/page.tsx, backtests/page.tsx, traders/page.tsx, tasks/page.tsx, settings/page.tsx, messages/page.tsx, traders/[name]/page.tsx, tasks/[id]/page.tsx, reconciliation/page.tsx, trades/[id]/page.tsx, backtests/new/page.tsx, backtests/[id]/page.tsx

## P1: Snapshot Cast Hell (20+ `as Record<string, unknown>`)

`decision-timeline.tsx`, `snapshot-detail.tsx`, `trade-row.tsx` cast the same JSON snapshot fields 20+ times with `as Record<string, unknown>`. Two casts = accessor, three = bug.

**Fix:** Create `web/lib/snapshot-accessors.ts` with typed helpers for adjustment params, rules, parse results, signal data.

## P2: Empty State Duplication

Same empty-state card structure copy-pasted across pages.

**Fix:** Extract `web/app/components/empty-state.tsx`.

## P2: Inline Date Formatting

Pages doing `new Date(value).toLocaleDateString()` instead of using `formatDate()` from `web/lib/format.ts`.

## P3: Inline Response Types

8 pages define API response types inline instead of in `web/lib/page-adapters.ts`. Not blocking but makes the API contract harder to enforce.
