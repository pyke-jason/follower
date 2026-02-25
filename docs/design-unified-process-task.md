# Unified processTask

## The function

```typescript
// src/pipeline/process-task.ts

// Same outcome names as DB (TaskResult.decision) — no mapping anywhere
type TaskResult =
  | { outcome: 'SKIP'; reason: string }
  | { outcome: 'MANUAL_REVIEW'; reason: string }
  | { outcome: 'EXECUTE'; reason: string; signals: ResolvedSignal[]; results: ResolvedPipelineResult[] };

type TaskEnv = {
  getPositions: (symbol?: string) => Promise<OpenPosition[]>;
  llm: LLMProvider;
  pipeline: ResolvedPipelineDeps;   // broker (incl. getQuote), sizing, risk, recordTrade
  onResult: (result: TaskResult) => Promise<void>;
};

async function processTask(task: Task, env: TaskEnv): Promise<void> {
  const message = await fetchMessage(task.messageId!);
  if (!message) throw new Error(`Message ${task.messageId} not found`);

  const orchCtx = buildOrchestratorContext(message, env);
  const resolved = await resolveOrchestrator(orchCtx, env.llm);

  if (resolved.outcome !== 'EXECUTE') {
    await env.onResult(resolved);  // passthrough — same shape
    return;
  }

  const results = await executeResolvedSignals(
    resolved.signals, message.author, env.pipeline, { messageId: message.id },
  );
  await env.onResult({ outcome: 'EXECUTE', reason: `${resolved.signals.length} signal(s)`, signals: resolved.signals, results });
}
```

`buildOrchestratorContext` is a private helper (~20 lines) that wires the shared parts:
traderConfig from `getTrader(author)`, chatHistory from `getRecentChatMessages`,
`getQuote` from `env.pipeline.broker.getQuote`, `getPositions` from `env.getPositions`.

Also rename `FLAG_FOR_REVIEW` → `MANUAL_REVIEW` in `OrchestratorResult` and the ~5 places
in the orchestrator that produce it. Eliminates the round-trip mapping
(`MANUAL_REVIEW` → `FLAG_FOR_REVIEW` → `MANUAL_REVIEW`).

## Live path

```
poll → claim task → processTask(task, env) → done
```

```typescript
// Built once at module level (shared across tasks)
const liveEnvBase = {
  llm: await getProvider(),
  getPositions: async (symbol?) => {
    const rows = await getOpenPositions(symbol ? { symbol, trader } : { trader });
    return rows.map(tradeToOpenPosition);
  },
};

// Per-task (recordTrade closure captures task.id)
const env: TaskEnv = {
  ...liveEnvBase,
  pipeline: {
    broker: liveService,
    orderManager,
    calculatePositionSize: ...,
    checkRiskLimits: ...,
    recordTrade: (input) => recordTrade({ ...input, taskId: task.id, isBacktest: false }),
    onPending: (id, ctx) => pendingIntents.set(id, ctx),
  },
  // Direct passthrough — outcome names match DB
  onResult: async (result) => {
    await completeTask(task.id, { decision: result.outcome, reasoning: result.reason });
  },
};

await processTask(task, env);
```

## Backtest path

```
for each message → day boundary → processTask(task, env) → done
```

```typescript
// Built once at backtest setup
const btEnv: TaskEnv = {
  getPositions: async (symbol?) => {
    const rows = await broker.getOpenTrades(symbol ? { symbol, trader } : { trader });
    return rows.map(tradeToOpenPosition);
  },
  llm: agentProvider,
  pipeline: pipelineDeps,   // already built during setup
  onResult: async (result) => {
    if (result.outcome === 'EXECUTE') {
      await recordExecute(msgCtx, result.signals, result.results);
    } else {
      await recordSkip(msgCtx, result.reason);
    }
    updateStats(stats);
  },
};

// Per-message
const task = taskFromMessage(msg);  // ~10 line adapter
await processTask(task, btEnv);
```

## What's deleted

**Both runners**: inline OrchestratorContext building, resolveOrchestrator call, outcome
routing, executeResolvedSignals call, tradeToOpenPosition duplicate. ~200 lines total.

**Live only**: prefetchForAgent, shouldSkipDeterministic, alertIfSkippedWithActivePosition.
Orchestrator sync parse + pipeline risk checks already cover these.

**execute-resolved.ts**: taskId/backtestRunId/isBacktest from ResolvedPipelineOpts
(redundant with recordTrade closures).

## Risks

1. **Backtest prefetch removed** — Phase 1.5 pre-seeds daily bars, getQuote expanding
   lookback covers gaps. Slower per-message, no correctness change.

2. **Deterministic skip removed** — orchestrator parseMessage() catches obvious skips
   synchronously. Pipeline risk checks catch position limits. A few more messages reach
   orchestrator but no wrong trades.

## Files

| File | Action |
|---|---|
| `src/pipeline/process-task.ts` | Create (~40 lines) |
| `src/trades/adapters.ts` | Create — `tradeToOpenPosition()` (~20 lines) |
| `src/pipeline/execute-resolved.ts` | Edit — trim ResolvedPipelineOpts |
| `src/intents/orchestrator/types.ts` | Edit — rename `FLAG_FOR_REVIEW` → `MANUAL_REVIEW` in `OrchestratorResult` |
| `src/intents/orchestrator/index.ts` | Edit — update outcome string |
| `src/intents/orchestrator/open-path.ts` | Edit — update outcome string |
| `src/intents/orchestrator/position-path.ts` | Edit — update outcome string |
| `src/intents/orchestrator/llm-path.ts` | Edit — remove `MANUAL_REVIEW` → `FLAG_FOR_REVIEW` mapping, passthrough directly |
| `src/tasks/runner.ts` | Edit — delete ~150 lines |
| `src/backtest/runner.ts` | Edit — delete ~130 lines, add taskFromMessage |
