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

### A. Schema + src/ backend → agent-a (worktree)
Files: `src/db/schema.ts`, `src/backtest/runner.ts`, `src/backtest/report.ts`, `src/tasks/recorder.ts`, `src/decisions/emitter.ts`

- [x] **schema.ts**: Add new columns (`event`, `signalIndex`, `outcome`, `phase`, `snapshot`, `taskId`) to `runDecisions`
- [x] **schema.ts**: Make `backtestRunId` nullable
- [x] **schema.ts**: Keep old columns (data exists) but add `// LEGACY` comments
- [x] **schema.ts**: Add indexes `idx_run_decisions_task`, `idx_run_decisions_settled`
- [x] **schema.ts**: Remove `taskSteps` table + `TaskStep` type
- [x] **runner.ts**: Replace `recordSkip()`/`recordExecute()` with `emitter.emit('SETTLED', ...)` — write `outcome`+`phase` instead of `decision`+`path`
- [x] **runner.ts**: Delete `recordSkip` and `recordExecute` functions
- [x] **runner.ts**: Update `backfillDecisionPnl()` to use `outcome = 'EXECUTE'` instead of `decision = 'EXECUTE'`
- [x] **report.ts**: Update `generateReportFromTrades` to read `outcome` instead of `decision`
- [x] **recorder.ts**: Remove `recordStep()` function
- [x] **emitter.ts**: Verify `EmitOpts` type includes all fields matching schema

### B. Web/ frontend → agent-b (worktree)
Files: `web/lib/queries.ts`, `web/app/backtests/`, `web/app/trades/`, `web/app/tasks/`, `web/app/messages/`, `web/app/components/`

- [ ] **queries.ts**: Remove `getTradeSteps()`
- [ ] **queries.ts**: `getDecisionDiff()` — read `outcome` instead of `decision`
- [ ] **queries.ts**: `computeBacktestAccuracy()` — read `outcome` instead of `decision`
- [ ] **queries.ts**: `getRunMessages()` — read `outcome`/`phase` instead of `decision`/`path`, update role filters
- [ ] **backtests/actions.ts**: Remove `taskSteps` delete calls, update `decision` → `outcome` reads
- [ ] **backtests/[id]/page.tsx**: Update all `.decision.decision` → `.decision.outcome`, `.decision.path` → `.decision.phase`
- [ ] **trades/[id]/page.tsx**: Update `runDecision.decision` → `.outcome`, `.path` → `.phase`
- [ ] **trades/[id]/decision-reasoning.tsx**: Update renders
- [ ] **trades/actions.ts**: Update `runDecisionRow.decision` → `.outcome`, `.path` → `.phase`
- [ ] **tasks/[id]/page.tsx**: Update renders
- [ ] **components/decision-timeline.tsx**: Update all `.decision`/`.path`/`.skipCategory` references
- [ ] **components/step-viewer.tsx**: Delete file (dead — no data)
- [ ] **enriched-message.ts**: Verify `MessageDecision` type still works (already uses `outcome`+`phase`)
- [ ] **messages/load-chat-data.ts**, **messages/actions.ts**: Update if needed

### C. Data migration (after A+B merge)
- [ ] Run backfill SQL: `UPDATE run_decisions SET outcome = decision, phase = path WHERE outcome IS NULL AND decision IS NOT NULL`
- [ ] Verify with: `SELECT outcome, count(*) FROM run_decisions WHERE event='SETTLED' GROUP BY outcome`

## Execution Log

### Task A — 2026-02-28
Completed all src/ changes:
- `schema.ts`: Added `taskId`, `event`, `signalIndex`, `outcome`, `phase`, `snapshot` columns to `runDecisions`. Made `backtestRunId` nullable. Kept `path`/`decision`/`skipCategory` as nullable with `// LEGACY` comments. Added `idx_run_decisions_task` and `idx_run_decisions_settled` indexes. Removed `taskSteps` table and `TaskStep` type export.
- `runner.ts`: Replaced `recordSkip()`/`recordExecute()` direct DB inserts with `emitter.emit('SETTLED', ...)` calls. Stats tracking (`skipped++`, `skipReasons.set`, `agentTrades++`) kept inline. Deleted `recordSkip`, `recordExecute`, and `MessageContext` (dead after removal). Removed unused `LLMUsage` import. Updated `backfillDecisionPnl()` to query `outcome = 'EXECUTE'`.
- `report.ts`: Updated `generateReportFromTrades` decisions type from `{ path, decision }` to `{ phase, outcome }`. Updated filter predicates to use `d.outcome`.
- `recorder.ts`: Removed dead `recordStep()` function.
- `emitter.ts`: Verified `EmitOpts` already has `phase`, `outcome`, `reasoning`, `tradeId`, `signalIndex`, `inputTokens`, `outputTokens`. No changes needed.
- TypeScript compiles clean (only pre-existing errors in `scorer.ts`).
