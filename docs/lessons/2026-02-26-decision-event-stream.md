## Problem

The `run_decisions` table stored one summary row per signal (SETTLED only). Intermediate events (PARSED, SIGNAL_RESOLVED, ORDER_PLACED, ORDER_ADJUSTED, etc.) were invisible. The `onDecision` callback threaded through 3 env types (`OrchestratorEnv`, `TaskEnv`, `ExecuteEnv`) was verbose and hard to extend.

## Decision

Evolved `run_decisions` into an append-only event stream:

1. Added `event TEXT NOT NULL DEFAULT 'SETTLED'` column — existing rows auto-default, no migration of old data needed
2. Replaced `onDecision` callback chain with `createEmitter(scope)` pattern — one function, one DB insert per event
3. Summary queries filter `WHERE event = 'SETTLED'` to preserve existing behavior
4. New `getDecisionTimeline()` query returns all events for the full trace view

The emitter carries `{ messageId, backtestRunId?, taskId? }` scope and returns `{ emit(event, payload, opts) }`. Both runners (backtest + live) create one emitter per message/task.

## Key Files

- `src/decisions/emitter.ts` — new emitter (replaced `record.ts`)
- `src/db/schema.ts` — `event` column, nullable `outcome`/`phase`
- `drizzle/0021_add_decision_events.sql` — migration
- `src/intents/orchestrator/index.ts` — emits PARSED + SIGNAL_RESOLVED or SETTLED
- `src/pipeline/execute-resolved.ts` — emits SETTLED per signal, QUOTE_FAILED, RETRY_LLM
- `src/orders/order-manager.ts` — added `onAdjust` callback for ORDER_ADJUSTED events
- `src/backtest/runner.ts` + `src/tasks/runner.ts` — wire emitter + onAdjust
- `web/lib/queries.ts` — SETTLED filters on summary queries, new `getDecisionTimeline()`
- `web/app/components/decision-timeline.tsx` — renders event stream with event/phase/outcome badges

## Watch Out

- `outcome` and `phase` are nullable now. Non-SETTLED events (PARSED, ORDER_PLACED, etc.) typically have no outcome. Always guard before using.
- `getEnrichedMessages()` LEFT JOIN on `runDecisions` now filters to `event = 'SETTLED'` — without this filter, a single message would produce multiple rows (one per event).
- `ResolvedPendingContext` gained `signalIndex` so async order events (ORDER_ADJUSTED via onAdjust) can be associated with their originating signal.
- `ProcessTaskResult` was renamed from `TaskResult` to avoid collision with `agent/schemas.ts:TaskResult`.
- `MessageDecision.outcome` is typed as non-nullable union in `enriched-message.ts` — safe because we only cast after filtering to SETTLED events which always have outcome set.
