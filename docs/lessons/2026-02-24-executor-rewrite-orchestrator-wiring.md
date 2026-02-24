# Executor Rewrite: Orchestrator Wiring

## Problem

Both runners (live `tasks/runner.ts` and backtest `backtest/runner.ts`) used the old pipeline: `extractIntent()` → `Signal[]` (hint legs) → `executeSignals()` (5 per-action handlers). The executor resolved hint legs, derived strikes/expiry, probed the DB for position matching, and ran postprocessors. ~2900 lines of pipeline code compensating for incomplete upstream signals.

## Decision

Wire BOTH runners to the orchestrator + a new minimal executor (`execute-resolved.ts`). Delete the entire old pipeline.

**Key design principle**: the orchestrator is the source of truth. `ResolvedSignal` carries fully concrete legs. The executor derives action/strategy/direction from leg shapes — no inference logic, no DB probes for position matching.

**Option A** for metadata: added `tradeId` and `exitPercent` to `ResolvedSignal` so the executor doesn't re-probe the DB for information the orchestrator's position-path already computed.

**Shared tools extraction**: moved `createIntentTools()` and `intentOnToolCall()` to `src/intents/intent-tools.ts` to break the circular dependency between `llm-path.ts` ← `extract-intent.ts`.

**Backtest simplification**: eliminated Phase 1 (batch LLM intent extraction) entirely. The orchestrator runs inline during message replay — most messages resolve deterministically through the parser without any LLM call. The old `RuleBasedTradeAgent`, `extractBatchIntents`, and `INTENT_VERSION` caching layer are all gone.

## Deleted Files (~2900 lines)

- `src/pipeline/execute.ts` (714) — old 5-action executor
- `src/pipeline/signal-legs.ts` (151) — hint leg resolution
- `src/intents/postprocess.ts` (130) — lottoDirectionFix, etc. (now in parser.ts)
- `src/intents/versions.ts` (240) — pipeline version registry
- `src/intents/prompts.ts` (646) — versioned system prompts
- `src/intents/extract-intent.ts` (307) — old intent extraction entry point
- `src/intents/extract-batch.ts` (134) — batch intent extraction for backtest Phase 1
- `src/trading/trade-agent.ts` (112) — RuleBasedTradeAgent
- `src/intents/evals/runner.ts` (169) — eval runner (tested old pipeline)
- `scripts/eval-intents.ts` (304) — eval CLI script

## Key Files

- `src/intents/orchestrator/types.ts` — `ResolvedSignal` now has `tradeId?` and `exitPercent?`
- `src/intents/orchestrator/position-path.ts` — passes through `position.id` and exit fraction
- `src/pipeline/execute-resolved.ts` — new executor (~270 lines vs old ~715)
- `src/tasks/runner.ts` — live runner: `resolveOrchestrator()` → `executeResolvedSignals()`
- `src/backtest/runner.ts` — backtest runner: same flow, SimBroker adapters for market data/positions
- `src/intents/intent-tools.ts` — shared tool factories (extracted from extract-intent.ts)

## Watch Out

- **Live market data providers**: `getOptionChain` and `getExpiryDates` are stubbed (return null/[]) in both runners. The orchestrator's open-path will FLAG_FOR_REVIEW when it needs chain data for ATM/delta/premium-match strike selection. Explicit-strike signals (most common) work fine.
- **Direction derivation for equal buy/sell spreads**: `deriveDirection()` in the new executor handles CDS/PDS by comparing strike positions. CDS buy-lower-strike = LONG, PDS buy-higher-strike = LONG.
- **Eval runner deleted**: `src/intents/evals/runner.ts` tested the old LLM intent extraction pipeline. Fixtures/scorer/types remain for future orchestrator evals.
- **No Phase 1 caching**: The old backtest cached LLM intents in `message_intents` table (keyed by message_id + model + version). The orchestrator's deterministic parser replaces most LLM calls, so the intent cache is no longer needed for backtest.
