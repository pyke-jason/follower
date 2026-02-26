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
*(fill in)*

### Agent 2: Pipeline & Execution
*(fill in)*

### Agent 3: Trade Recording & Schema
*(fill in)*

### Agent 4: Broker & Orders
*(fill in)*

### Agent 5: Cross-Cutting & Glue
*(fill in)*

### Consensus
*(merged after all agents report — single table of verdicts)*

| Type/Function | File | Verdict | Replacement |
|---------------|------|---------|-------------|
| | | | |

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
