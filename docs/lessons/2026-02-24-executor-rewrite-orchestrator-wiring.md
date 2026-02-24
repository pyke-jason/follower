# Executor Rewrite: Orchestrator Wiring

## Problem

The live runner (`tasks/runner.ts`) used the old pipeline: `extractIntent()` → `Signal[]` → `executeSignals()`. This required the executor to resolve hint legs, derive strikes/expiry, probe the DB for position matching, and handle five separate per-action code paths. ~715 lines of executor code compensating for incomplete upstream signals.

## Decision

Wire the live runner to the orchestrator + a new minimal executor (`execute-resolved.ts`).

**Key design principle**: the orchestrator is the source of truth. `ResolvedSignal` carries fully concrete legs. The executor derives action/strategy/direction from leg shapes — no inference logic, no DB probes for position matching.

**Option A** for metadata: added `tradeId` and `exitPercent` to `ResolvedSignal` so the executor doesn't re-probe the DB for information the orchestrator's position-path already computed.

**Shared tools extraction**: moved `createIntentTools()` and `intentOnToolCall()` to `src/intents/intent-tools.ts` to break the circular dependency between `llm-path.ts` ← `extract-intent.ts`. Both the old pipeline and orchestrator's LLM path import from the shared file.

## Key Files

- `src/intents/orchestrator/types.ts` — `ResolvedSignal` now has `tradeId?` and `exitPercent?`
- `src/intents/orchestrator/position-path.ts` — passes through `position.id` and exit fraction
- `src/pipeline/execute-resolved.ts` — new executor (~270 lines vs old ~715)
- `src/tasks/runner.ts` — rewired: `resolveOrchestrator()` → `executeResolvedSignals()`
- `src/intents/intent-tools.ts` — shared tool factories (extracted from extract-intent.ts)

## Watch Out

- **Backtest runner not migrated**: `src/backtest/runner.ts` still uses the old `extractIntent()` → `executeSignals()` path. Separate PR.
- **Live market data providers**: `getOptionChain` and `getExpiryDates` are stubbed (return null/[]) in the live runner. The orchestrator's open-path will FLAG_FOR_REVIEW when it needs chain data for ATM/delta/premium-match strike selection. Explicit-strike signals (most common in live) work fine.
- **Old executor not deleted**: `src/pipeline/execute.ts` and `src/pipeline/signal-legs.ts` remain for the backtest path. Delete after backtest migration.
- **Direction derivation for equal buy/sell spreads**: `deriveDirection()` in the new executor handles CDS/PDS by comparing strike positions. Tested logic: CDS buy-lower-strike = LONG, PDS buy-higher-strike = LONG.
