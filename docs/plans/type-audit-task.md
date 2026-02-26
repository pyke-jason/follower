# Mission: Streamline the Decision Pipeline

## North Star

Every signal's lifecycle — from raw Discord message to settled trade — should flow through with **zero unnecessary type conversions, zero duplicate types, and zero adapter functions.** Data gets created once, extended as it passes through layers, and written to one table. If you can't explain why a type or function exists in one sentence, delete it.

You have **full authority to rip out, restructure, or delete any code in the codebase.** Deletion is encouraged. This is an internal tool — there is no backwards compatibility, no public API, no external consumers. The only constraint is that the app still works at the end.

## The Problem

The codebase has accumulated layers of cruft: types that are subsets of other types, "env" objects that carry the same callback threaded 3 different ways, mapping functions that copy fields from one struct to another, `as` casts that paper over type mismatches, `Record<string, unknown>` bags where there should be typed payloads, and context objects that get constructed by tediously copying fields from other context objects.

The concrete trigger: `run_decisions` records one coarse summary row per signal, which causes 126/185 FAILs to be false negatives (working LIMIT orders recorded as FAIL before they fill). But the fix exposes deeper rot — the entire decision recording path is over-mapped.

## The Plan (read `docs/plans/decision-events.md` for full detail)

1. Evolve `run_decisions` into an event stream (add `event` column, emit granular events per pipeline stage)
2. Replace `onDecision` callback threading with a single `SignalEventEmitter` on the context
3. Replace separate env types (`TaskEnv`, `ExecuteEnv`, `OrchestratorEnv`) with an extending context chain
4. Kill every duplicate type, mapping function, and unnecessary abstraction found during the audit
5. Wire up web UI last — it's a reflection of the backend, not the other way around

---

## Phase 1: Type Audit (5 agents in parallel)

Each agent reads their domain slice and produces findings. Be ruthless. For every type, function, and abstraction: does it earn its existence? If not, flag it for deletion.

### Agent Assignments

| Agent | Domain | Key Files |
|-------|--------|-----------|
| 1 | **Orchestrator & Intents** | `src/intents/orchestrator/**` |
| 2 | **Pipeline & Execution** | `src/pipeline/**` |
| 3 | **Trade Recording & Schema** | `src/db/schema.ts`, `src/trades/**`, `src/decisions/**`, `src/backtest/runner.ts`, `src/tasks/runner.ts`, `src/backtest/types.ts`, `src/tasks/recorder.ts` |
| 4 | **Broker & Orders** | `src/broker/**`, `src/orders/**`, `src/position-sizing/**` |
| 5 | **Cross-Cutting & Glue** | Everything that bridges domains: `src/lib/enriched-message.ts`, `src/lib/enums.ts`, `src/lib/errors.ts`, type imports that flow across module boundaries. Also search for all `as` casts and `Record<string, unknown>` usage across `src/`. |

Each agent should follow their type imports across boundaries — if a type in your domain is consumed elsewhere, trace it and flag the mapping.

### What To Flag

- **Duplicate types** — two types with the same or overlapping fields
- **Mapping functions** — functions that exist solely to convert Type A → Type B
- **Adapter types** — types that exist solely to carry data between two layers
- **Callback duplication** — the same callback signature on multiple env/context types
- **Manual subsets** — hand-written types that are just `Pick<SourceType, ...>`
- **Untyped JSON** — `Record<string, unknown>` or `any` where a concrete type should exist
- **`as` casts** — each one is a symptom of a type mismatch upstream
- **One-call-site helpers** — functions called exactly once, just inline them
- **Types with naming collisions** — same name, different definitions in different files
- **Over-abstraction** — interfaces with one implementation, factories that build one thing, wrappers that add nothing

### Output Format

Each agent fills in their section below with a flat list. No categories, just findings sorted by severity (worst cruft first):

```
- **DELETE** `TypeName` @ `file:line` — [one sentence reason]
- **MERGE** `TypeA` + `TypeB` → use `TypeA` directly — [reason]
- **INLINE** `helperFunction()` @ `file:line` — [called once from X, just inline it]
- **SIMPLIFY** `TypeC` → `ParentType & { extraField }` — [copies N fields from Parent]
- **KEEP** `TypeD` — [earns its existence because ...]
```

---

## Phase 1 Findings

### Agent 1: Orchestrator & Intents

- **DELETE** `TraderConfig` + field on `OrchestratorContext` @ `types.ts:128,153` — injected but never read anywhere
- **DELETE** `Action` alias @ `types.ts:164` — bare `type Action = TradeAction` re-export; use `TradeAction` directly
- **MERGE** `ExecuteEnv` + `TaskEnv` — identical quad `{ getPositions, llm, pipeline, onDecision }`; ExecuteEnv is a structural duplicate
- **SIMPLIFY** `OrchestratorEnv.getPositions` — duplicates `PositionProvider`'s single method; pick one representation
- **SIMPLIFY** `LLMUsageInfo` @ `types.ts:56` — identical to `Pick<LLMUsage, 'inputTokens' | 'outputTokens'>`; not imported in `TaskResult` which copies the same shape inline
- **SIMPLIFY** `PositionProvider` / `ChatHistoryProvider` @ `types.ts:114,119` — single-method interfaces wrapping a function; inline as function types on context
- **SIMPLIFY** `SpreadStrategy` local alias @ `open-path.ts:35` — duplicates `spreadLegs` param type; use `isSpread()` guard to narrow instead of casting
- **INLINE** `serializeParseResult()` @ `index.ts:238` — called once
- **INLINE** `logResult()` @ `index.ts:257` — called from 4 places in same function, just log directly
- **FIX** `as string[]` casts @ `index.ts:189-190` — `message.badges`/`symbols` should be typed via `$type<string[]>()` on schema
- **FIX** `leg.optionType!` @ `index.ts:363` — `OpenPosition.legs` makes `optionType` optional even for option legs

### Agent 2: Pipeline & Execution

- **MERGE** `ExecuteEnv` @ `execute-resolved.ts:72` into `TaskEnv` @ `process-task.ts:27` — TaskEnv is a strict superset; ExecuteEnv is a 4-field structural duplicate
- **MERGE** `TaskEnv` + `OrchestratorEnv` — three of four fields identical; `processTask()` manually destructures to build `OrchestratorEnv` by unwrapping `env.pipeline.broker`
- **RENAME** `TaskResult` @ `process-task.ts:22` — name collision with `agent/schemas.ts:TaskResult`; rename to `ProcessTaskResult`
- **SIMPLIFY** `ResolvedPendingContext` @ `execute-resolved.ts:32` — adapter type carrying 5 pass-through data fields; some may be unnecessary
- **SIMPLIFY** `ResolvedPipelineResult` @ `execute-resolved.ts:63` — `orderId` field written but never read by any consumer
- **INLINE** `legsToOrderLegs()` @ `execute-resolved.ts:175` — one-expression wrapper called twice; `legs.map(l => legToOrderLeg(l, count))`
- **INLINE** `deriveSymbol()` @ `execute-resolved.ts:100` — body is `return legs[0].symbol`, called once
- **INLINE** `getEntryPriceEstimate()` @ `execute-resolved.ts:247` — called once, two lines

### Agent 3: Trade Recording & Schema

- **DELETE** `startTask()` @ `src/tasks/recorder.ts:33` — exported but zero call sites
- **DELETE** `rebuildFromEvents()` + `RebuiltState` + `RebuildResult` @ `src/trades/rebuild.ts` — entire file has zero import sites
- **MERGE** `BacktestReport.summary` (inline in `backtest/types.ts:45-63`) + `BacktestRunSummary` (`schema.ts:313-331`) — field-for-field identical
- **MERGE** `byTrader`/`byStrategy` anonymous inline types in `schema.ts:142-143` → use `TraderStats`/`StrategyStats` from `backtest/types.ts`
- **FIX** `equityCurve` anonymous inline type in `schema.ts:144` omits `drawdown?` from `EquityPoint` — schema silently drops a field runtime writes
- **FIX** `reconciliationAlerts.expected`/`.actual` @ `schema.ts:236-237` — no `$type<>()`, falls through to `unknown`
- **KEEP** `DecisionRow` @ `schema.ts:400` — correct boundary shape, runners widen back to `$inferInsert`
- **KEEP** `recordDecision()` @ `decisions/record.ts` — right abstraction boundary, two callers
- **KEEP** `tradeToOpenPosition()` @ `trades/adapters.ts` — genuine non-trivial adapter

### Agent 4: Broker & Orders

- **DELETE** `OrderParamsSchema` @ `broker/order-schemas.ts:19` — exported but zero import sites; dead code
- **SIMPLIFY** `WorkingOrderParamsSchema` @ `broker/order-schemas.ts:43` — re-copies all `OrderParams` fields instead of composing via `.extend()`; will drift silently
- **FIX** `OrderManagerConfig.onFill` @ `orders/order-manager.ts:12,21` — config declares `void | Promise<void>`, private field drops `Promise`; type contract misleading
- **SIMPLIFY** `PositionSizingConfig` @ `position-sizing/index.ts:8` — alias for single type `NotionalSizingConfig`; use directly until second strategy exists
- **KEEP** `BrokerService` interface — clean seam; both impls complete
- **KEEP** `FilledWorkingOrder` — correct narrowed callback type
- **KEEP** `WorkingOrder`, `OrderParams`, `WorkingOrderParams`, `OrderLeg`, `Quote`, `OptionsChain`, `AdjustmentRule` — all earn their keep

### Agent 5: Cross-Cutting & Glue

- **RENAME** `TaskResult` @ `process-task.ts:22` — collides with `agent/schemas.ts:TaskResult` (different shapes); `llm-path.ts` imports one while other exists in scope
- **DELETE** `LLMUsageInfo` @ `orchestrator/types.ts:56` — identical to subset of `LLMUsage` from `agent/providers.ts`
- **DELETE** `Action` alias @ `orchestrator/types.ts:164` — use `TradeAction` directly
- **DELETE** `LabelStrategySchema` @ `lib/enums.ts:24` — identical copy of `StrategySchema`; use `StrategySchema` directly
- **FIX** `metadata as Record<string, unknown>` @ `record-trade.ts:457-459` — add `targetStrategy`, `closedLeg`, `keptLeg` to `TradeMetadata`
- **FIX** `as TradeLeg[]` @ 8 sites — all unnecessary; schema `$type<TradeLeg[]>()` already provides correct typing
- **FIX** `as FilledWorkingOrder` @ `order-manager.ts:98` — build filled object explicitly instead of casting mutated object
- **FIX** `loopResult.result as TaskResult` @ `llm-path.ts:128` — no Zod validation; parse through schema instead of raw cast
- **FIX** `as any` @ `agent/providers.ts:96`, `tasks/factory.ts:38`, `backtest/databento-tape.ts:357,479` — various unnecessary `any` casts
- **SIMPLIFY** `parseResult?: Record<string, unknown>` in `OrchestratorResult`/`TaskResult` — should be typed `SerializedParseResult`
- **KEEP** `EnrichedMessage`/`TradeOutcome`/`MessageDecision` — correct public contract for web layer
- **KEEP** all enum schemas in `lib/enums.ts` (except `LabelStrategySchema`)
- **KEEP** `QuoteResolutionError` @ `lib/errors.ts` — only typed error, enables `instanceof` retry logic

### Consensus

| Type/Function | File | Verdict | Replacement |
|---|---|---|---|
| `ExecuteEnv` | `pipeline/execute-resolved.ts:72` | DELETE | Use `TaskEnv` directly (structural superset) |
| `TaskEnv` + `OrchestratorEnv` + `ExecuteEnv` | 3 files | MERGE→context chain | `MessageContext → OrchestratorContext → ExecutorContext` |
| `TaskResult` (pipeline) | `pipeline/process-task.ts:22` | RENAME | `ProcessTaskResult` (collides with agent schema) |
| `TraderConfig` + field | `orchestrator/types.ts:128,153` | DELETE | Never read |
| `Action` alias | `orchestrator/types.ts:164` | DELETE | Use `TradeAction` directly |
| `LLMUsageInfo` | `orchestrator/types.ts:56` | DELETE | Use `LLMUsage` from `agent/providers.ts` |
| `LabelStrategySchema` | `lib/enums.ts:24` | DELETE | Use `StrategySchema` directly |
| `startTask()` | `tasks/recorder.ts:33` | DELETE | Zero call sites |
| `rebuildFromEvents()` + types | `trades/rebuild.ts` | DELETE | Entire file is dead |
| `OrderParamsSchema` | `broker/order-schemas.ts:19` | DELETE | Zero import sites |
| `PositionProvider` / `ChatHistoryProvider` | `orchestrator/types.ts:114,119` | SIMPLIFY | Inline as function types on context |
| `BacktestReport.summary` | `backtest/types.ts:45-63` | MERGE | Use `BacktestRunSummary` from schema |
| `byTrader`/`byStrategy` inline types | `schema.ts:142-143` | MERGE | Use `TraderStats`/`StrategyStats` from backtest/types |
| `WorkingOrderParamsSchema` | `broker/order-schemas.ts:43` | SIMPLIFY | Compose via `OrderParamsSchema.extend()` |
| `PositionSizingConfig` | `position-sizing/index.ts:8` | SIMPLIFY | Use `NotionalSizingConfig` directly |
| `ResolvedPipelineResult.orderId` | `execute-resolved.ts:63` | DELETE field | Written but never read |
| `onDecision` (3 env types) | 3 files | DELETE | Replaced by emitter on context |
| `DecisionRow` | `schema.ts:400` | DELETE (Phase 2) | Replaced by emitter |
| `recordDecision()` | `decisions/record.ts` | DELETE (Phase 2) | Replaced by emitter |
| `serializeParseResult()` | `orchestrator/index.ts:238` | INLINE | Called once |
| `deriveSymbol()` | `execute-resolved.ts:100` | INLINE | `legs[0].symbol`, called once |
| `getEntryPriceEstimate()` | `execute-resolved.ts:247` | INLINE | Called once, two lines |
| `legsToOrderLegs()` | `execute-resolved.ts:175` | INLINE | One-expression wrapper |
| 8× `as TradeLeg[]` | various | FIX | Remove — `$type<>()` already provides typing |
| `metadata as Record<string, unknown>` | `record-trade.ts:457` | FIX | Add fields to `TradeMetadata` |
| `as FilledWorkingOrder` | `order-manager.ts:98` | FIX | Build explicit filled object |
| `loopResult.result as TaskResult` | `llm-path.ts:128` | FIX | Parse through Zod schema |
| `parseResult?: Record<string, unknown>` | orchestrator/types.ts, process-task.ts | FIX | Type as `SerializedParseResult` |
| `onFill` type mismatch | `order-manager.ts:12,21` | FIX | Keep `Promise<void>` on private field |

---

## Phase 2: Schema + Emitter (backend core)

After the audit produces its consensus, implement the event stream. See `docs/plans/decision-events.md` for full schema and emitter design. In brief:

1. **Schema**: Add `event` column to `run_decisions` (default `'SETTLED'`), make `outcome`/`phase` nullable, add partial index on settled events. Generate Drizzle migration.

2. **Emitter**: Create `src/decisions/emitter.ts` — `createEmitter(scope)` returns `{ emit(event, payload, opts) }`. One function, one insert, embarrassingly simple. Runner creates it per message, stamps `backtestRunId` or `taskId`, passes it on the context.

3. **Context chain**: Replace `TaskEnv` / `ExecuteEnv` / `OrchestratorEnv` with a single extending context chain. `MessageContext → OrchestratorContext → ExecutorContext`. Each layer adds its deps, nobody copies. The emitter lives on the base context.

4. **Instrument**: Every layer emits its events through `ctx.emitter.emit(...)`:
   - Orchestrator: `PARSED` (with full parse metadata — badges, symbols, strategies, complexity flags, everything), `LLM_STARTED`, `LLM_RESOLVED`, `SIGNAL_RESOLVED`
   - Executor: `SIZED`, `RISK_PASSED`/`RISK_BLOCKED`, `ORDER_PLACED`, `QUOTE_FAILED`, `RETRY_LLM`
   - OrderManager: `ORDER_ADJUSTED` (via new `onAdjust` callback)
   - Runner onFill/onCancel: `ORDER_FILLED`, `ORDER_CANCELLED`, `TRADE_RECORDED`, `SETTLED`
   - For pending orders: `SETTLED` is deferred — attached as `onSettled` closure on `ResolvedPendingContext`, fired by runner when fill/cancel arrives. This naturally fixes the false-FAIL bug.

5. **Delete**: Remove `onDecision` from all types. Delete `DecisionRow`. Delete `recordDecision()`. Delete `MessageDecision`. Apply all type audit verdicts.

## Phase 3: Web UI (last)

The web UI is a reflection of the backend data. Update it only after the backend is solid:

- Queries: add `AND event = 'SETTLED'` to summary queries, new `getDecisionTimeline()` for full event stream
- `DecisionTimeline` component: render the real event stream instead of summary rows
- Everything else adapts to whatever types survived the audit

---

## Progress Log

*(Fill in as work proceeds — what was done, what broke, what was discovered along the way)*

| Date | What | Notes |
|------|------|-------|
| | | |
