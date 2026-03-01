# Schema & Emitter Cleanup Plan

## Problem
`run_decisions` has two write paths and two column sets:
- **Old** (`runner.ts` `recordSkip`/`recordExecute`): writes `path`, `decision`, `skip_category`
- **New** (`emitter.ts` `emit()`): writes `event`, `outcome`, `phase`, `snapshot`
Both are active. Schema.ts only declares old columns. Web reads old columns everywhere.

**Goal**: Consolidate to emitter-only. Old columns become dead weight (backfill + stop writing).

Also: `task_steps` is dead (0 rows, `recordStep` never called).

## Column Mapping (old → new)
| Old column      | New column   | Notes                                         |
|-----------------|-------------|-----------------------------------------------|
| `decision`      | `outcome`    | EXECUTE / SKIP / FAIL                          |
| `path`          | `phase`      | agent / orchestrator / pipeline_failure         |
| `skip_category` | (in snapshot) | Lives in snapshot JSON under `skipCategory`   |
| (none)          | `event`      | PARSED / SETTLED / SIGNAL_RESOLVED / ORDER_* / SIZED |
| (none)          | `snapshot`   | JSON payload                                   |
| (none)          | `signal_index` | Which signal in multi-signal messages        |

## Tasks

### A. Schema + src/ backend — DONE
- [x] **schema.ts**: Add new columns (`event`, `signalIndex`, `outcome`, `phase`, `snapshot`, `taskId`) to `runDecisions`
- [x] **schema.ts**: Make `backtestRunId` nullable
- [x] **schema.ts**: Keep old columns (data exists) but add `// LEGACY` comments
- [x] **schema.ts**: Add indexes `idx_run_decisions_task`, `idx_run_decisions_settled`
- [x] **schema.ts**: Remove `taskSteps` table + `TaskStep` type
- [x] **runner.ts**: Replace `recordSkip()`/`recordExecute()` with `emitter.emit('SETTLED', ...)`
- [x] **runner.ts**: Delete `recordSkip` and `recordExecute` functions
- [x] **runner.ts**: Update `backfillDecisionPnl()` to use `outcome = 'EXECUTE'`
- [x] **report.ts**: Update `generateReportFromTrades` to read `outcome` instead of `decision`
- [x] **recorder.ts**: Remove `recordStep()` function
- [x] **emitter.ts**: Verified `EmitOpts` type already correct
- [x] **extended-metrics.test.ts**: Updated `makeDecisions()` helper: `path`/`decision` → `phase`/`outcome`

### B. Web/ frontend — DONE
- [x] **queries.ts**: Already migrated (`getTradeSteps` removed, `outcome`/`phase` used throughout)
- [x] **backtests/actions.ts**: Already migrated (`taskSteps` deletes removed, `outcome`/`phase`)
- [x] **backtests/[id]/page.tsx**: Already migrated
- [x] **trades/[id]/page.tsx**: Already migrated
- [x] **trades/[id]/decision-reasoning.tsx**: Already migrated
- [x] **trades/actions.ts**: Already migrated
- [x] **tasks/[id]/page.tsx**: Already migrated
- [x] **components/decision-timeline.tsx**: Already uses `d.outcome`/`d.phase`
- [x] **components/step-viewer.tsx**: Deleted
- [x] **enriched-message.ts**: `MessageDecision` already uses `outcome`+`phase`

### C. Data migration — DONE
- [x] Ran backfill: `UPDATE run_decisions SET outcome = decision, phase = path WHERE outcome IS NULL AND decision IS NOT NULL`
- [x] Verified: SKIP=1835, EXECUTE=123, FAIL=359 now have `outcome` populated

## Execution Log

### Task A — 2026-02-28
- `schema.ts`: Added `taskId`, `event`, `signalIndex`, `outcome`, `phase`, `snapshot` columns. Made `backtestRunId` nullable. Legacy columns kept with comments. New indexes added. `taskSteps` table + `TaskStep` type removed.
- `runner.ts`: Replaced `recordSkip`/`recordExecute` with `emitter.emit('SETTLED', ...)`. Stats tracking kept inline. Deleted dead functions + `MessageContext` type. Updated `backfillDecisionPnl()`.
- `report.ts`: `d.decision` → `d.outcome` in filter predicates.
- `recorder.ts`: Removed dead `recordStep()`.
- TypeScript compiles clean (pre-existing `scorer.ts` + `orderId` errors only).

### Task B — 2026-02-28
Web files were already migrated in working tree. Only remaining work was deleting `step-viewer.tsx`.

### Task C — 2026-02-28
Backfilled 2317 rows. 3636 ancient SETTLED rows remain with null outcome (from runs before either system existed).

### Remaining cleanup (future)
- `decision-timeline.tsx` still reads `d.skipCategory` from legacy column — works fine but could move to snapshot
- 3636 ancient rows with null outcome — harmless, just old data
- Legacy columns (`path`, `decision`, `skip_category`) can be dropped from DB once confident
