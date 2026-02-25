# Port eval to orchestrator source of truth

## Problem

Eval speaks `Signal` (old LLM extraction type). Orchestrator produces `OrchestratorResult` / `ResolvedSignal`. Port everything to match the orchestrator's actual output. No mapping layers.

## Types

`ExpectedSignal` = deeply partial `ResolvedSignal`. `OpenPosition` for fixture positions. Both from `src/intents/orchestrator/types.ts`.

```typescript
type ExpectedLeg = Partial<Pick<OptionLeg, 'side' | 'strike' | 'optionType' | 'expiry'>>;

type ExpectedSignal = {
  orderType?: ResolvedSignal['orderType'];
  exitPercent?: number;
  hasTradeId?: boolean;
  legs?: ExpectedLeg[];
};

type EvalInput = {
  message: string;
  author?: string;
  timestamp?: string;
  badges?: string[];
  symbols?: string[];
  positions?: OpenPosition[];
};

type EvalCase = {
  id: string;
  description: string;
  input: EvalInput;
  expected: {
    outcome: 'EXECUTE' | 'SKIP' | 'MANUAL_REVIEW';
    signals?: ExpectedSignal[];
  };
  mustMatch?: string[];
  tags?: string[];
  notes?: string;
};
```

`EvalResult`, `EvalRunResult` — unchanged. `reporter.ts` — unchanged.

## Fixture migration examples

**Opens**: drop `action`/`direction`/`strategy`/`symbol`, rename `legs[].action` → `legs[].side`:
```
Before: { action: "OPEN", symbol: "GLW", direction: "SHORT", strategy: "PDS",
          legs: [{ action: "SELL", strike: 68, optionType: "PUT" }, ...] }
After:  { orderType: "SPREAD", legs: [{ side: "SELL", strike: 68, optionType: "PUT" }, ...] }
```

**Naked options**: `{ orderType: "SINGLE", legs: [{ side: "BUY", optionType: "PUT" }] }`

**Exits**: `{ hasTradeId: true }` + add `positions` to input for orchestrator to match against.

**statedPremium**: drop (resolved to market-dependent `limitPrice`).

**mustMatch renames**: `signals[0].direction` → `signals[0].legs[0].side`, `signals[0].strategy` → `signals[0].orderType`, `signals[0].legs[0].action` → `signals[0].legs[0].side`.

## Scorer

`scoreCase(evalCase, orchestratorResult, refDate) → EvalResult`

1. Outcome mismatch → score 0.
2. No expected signals → score 1.0.
3. Per signal: match by leg optionTypes, score `orderType`, `hasTradeId`, `exitPercent`, `legs[].side`, `legs[].strike` (±0.5), `legs[].optionType`, `legs[].expiry` (via `compareExpiry`).
4. mustMatch → hard fail. Score = matched/total. Pass = !hardFail && >= 0.8.

## Runner

`scripts/eval-orchestrator.ts` — ~80 lines. For each fixture case:

1. Build `OrchestratorContext` from input (message, badges, symbols, timestamp)
2. Wire `DatabentoMarketDataProvider` for `marketData.getQuote`/`getOptionChain`
3. Wire `positions.getPositions` → `input.positions ?? []`
4. Stub `chatHistory` → `async () => ''`
5. `resolveOrchestrator(ctx, llmProvider)` → score → report

Shared infra: `DatabentoMarketDataProvider`, `tickCacheDb`, `resolveOrchestrator`, `createProvider`, `getTrader`, `normalizeExpiry`, `printReport`/`diffRuns`.

## Files

| File | Action |
|---|---|
| `src/intents/evals/types.ts` | **Rewrite** |
| `src/intents/evals/scorer.ts` | **Rewrite** |
| `src/intents/evals/reporter.ts` | No change |
| `src/intents/evals/sources/fixture.ts` | No change |
| `src/intents/evals/sources/db.ts` | **Delete** |
| `src/intents/evals/fixtures/*.json` | **Rewrite** (all 6 files) |
| `scripts/eval-orchestrator.ts` | **Create** |
| `.claude/rules/intent-evals.md` | **Edit** |

## Verification

1. `npx tsc --noEmit`
2. `npx tsx scripts/eval-orchestrator.ts --tag skip`
3. `npx tsx scripts/eval-orchestrator.ts --case core-001`
4. `npx tsx scripts/eval-orchestrator.ts`
