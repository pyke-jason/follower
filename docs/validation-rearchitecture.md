# Validation Architecture Investigation
Date: 2026-02-22

## Executive Summary

CLAUDE.md states: "Validate at the boundary, not in orchestration." The codebase does not follow
this. Zod schemas exist in the right schema files (agent/schemas.ts, broker/order-schemas.ts,
broker/schemas.ts) but are not consistently called at every ingress point. The result is a
two-tier system: excellent outer-layer validation (agent LLM output, broker API responses) and
almost no validation on the inner trust boundaries (DB read results, API POST bodies, form
inputs). The pattern is: data enters without parse() → cast to assumed type → used downstream.

**Coverage estimate (from inventory):** ~35% of code paths validated by Zod schemas.
The other 65% rely on ad-hoc guards, TypeScript generics (compile-time only), or nothing.

---

## The Six Problem Categories

### 1. DB-Read Boundary — No parseTradeFromDb()

`src/db/parse.ts` already has `parseLegs()` and `parseDirection()`. Neither is called by the
pipeline. Instead, `execute.ts` casts Trade rows with `as` 15+ times.

Violations (all in src/pipeline/execute.ts):
- Lines 296, 452, 517: `existing.legs as OrderLeg[]` — array check then blind cast
- Lines 298, 316, 331, 454, 471, 487, 547, 567: `existing.direction as 'LONG' | 'SHORT'`
- Lines 304, 459, 535: `existing.strategy as Signal['strategy']`

The fix is one function: `parseTradeFromDb(row: Trade)` in src/db/parse.ts that calls the
existing parseLegs(), parseDirection(), and adds StrategySchema.parse(). All 15 casts in
execute.ts collapse to a single call at query result time.

Same issue in src/trades/record-trade.ts:315-317 (LEG_OFF metadata):
```
const targetStrategy = (metadata as Record<string, unknown>)?.targetStrategy as string;
const closedLeg = (metadata as Record<string, unknown>)?.closedLeg as TradeLeg | undefined;
const keptLeg   = (metadata as Record<string, unknown>)?.keptLeg   as TradeLeg | undefined;
```
Double-cast with no validation. Needs a `LegOffMetadataSchema`.


### 2. Write Boundaries — RecordTradeInput Has No Schema

`RecordTradeInput` is a plain TypeScript interface. The only validation is an ad-hoc guard for
backtest timestamps (record-trade.ts:95-99). Cross-field requirements (OPEN needs entryPrice,
CLOSE needs exitPrice, LEG_OFF needs specific metadata) are enforced with `?? 0` defaults
scattered across the function body, not declared in a schema.

Same for the DB config column in web/app/backtests/actions.ts:175, 326:
```
const config = run.config as BacktestRunConfig;
```
Config is stored as JSON. Schema may have changed. Cast is silent.


### 3. API POST Bodies — TypeScript Generics Are Not Validation

All three local-api routes use `c.req.json<SomeType>()`. The TypeScript generic is compile-time
only. Hono does not validate at runtime.

Unprotected routes:
- src/local-api/routes/backtests.ts:27 — POST /backtests/spawn
- src/local-api/routes/trades.ts:8   — POST /trades/force-exit (legs, direction unchecked)
- src/local-api/routes/backtests.ts:141 — query param pid: parseInt() → isNaN() check only

For Next.js API routes, query params are parsed raw:
- web/app/api/signals/route.ts:8 — `parseInt(limit)` with no bounds check
- web/app/api/status/route.ts:10 — `run` param accepted as any string (should be UUID)
- web/app/api/backtest-runs/route.ts:11 — `r.config as BacktestRunConfig` on DB row


### 4. Server Actions — FormData Used Raw

All 5 server actions use `formData.get('field') as string` with no schema.

Violations:
- web/app/backtests/actions.ts:14-29 — dates, traders, numeric fields all raw
  - `Number(formData.get('maxOnSymbol'))` → NaN if non-numeric (unchecked)
  - `new Date(startDate + 'T00:00:00Z')` → Invalid Date if startDate is garbage
- web/app/trades/actions.ts:10 — tradeId: presence check only, no UUID validation
- web/app/reconciliation/actions.ts:8-9 — alertId + reason: presence check only
- web/app/settings/actions.ts:57-58 — key/value: any string accepted as env var name


### 5. Client-Side Fetch — No Response Validation

Every fetch().then(r => r.json()) in the web layer sets state directly from unvalidated JSON.

Violations:
- web/app/components/run-scope-provider.tsx:61 — status response → setState directly
- web/app/components/signal-sheet.tsx:89    — signals response → setState directly
- web/app/components/run-scope-selector.tsx:46 — runs response → `data: RunItem[]` type hint only

No response schemas exist for any of the three web API endpoints.


### 6. Security: Path Traversal in Logs Endpoint

src/local-api/routes/logs.ts:8-17 (GET /:id) and :20-30 (DELETE /:id):
```
const { id } = c.req.param();
const logPath = path.join(PATHS.logs, `${id}.log`);
const content = fs.readFileSync(logPath, 'utf-8');
```
`id` is never validated. Input `../../etc/passwd` traverses out of the logs directory.
This is the only actual security vulnerability found. Fix: validate id is UUID or
alphanumeric-only before constructing the path.


---

## Bonus: Code Smell Catalog

These don't introduce bugs today but signal that the rule is not being followed:

**as any escape hatch (execute.ts:599):**
```
return { signal, executed: false, reason: `Unknown action: ${(signal as any).action}` };
```
If an unknown action reaches this default case, the schema failed upstream. This should be an
exhaustiveness check (`action satisfies never`) that catches it at compile time.

**! assertions on schema-guaranteed fields (execute.ts:190-191, order-manager.ts:65, 87-88):**
```
await pendingContext.recordFill(result.filledPrice!, new Date(result.fillTimestamp!));
```
`OrderResultSchema.refine()` guarantees these for FILLED status but the type is not narrowed.
The fix is a `FilledOrderResult` type with non-optional fields, derived from the schema refine.

**Redundant as const on literals (execute.ts:123, 124, 142, 143, 299, 531 and more):**
```
type: 'STOCK' as const,
action: direction === 'LONG' ? 'BUY' as const : 'SELL' as const,
```
TypeScript infers these automatically. Indicates low confidence in the type system.

**Env validation inside function bodies (tradestation.ts:83, 127, 200, 249):**
```
const accountId = process.env.TS_ACCOUNT_ID;
if (!accountId) throw new Error('Missing TS_ACCOUNT_ID');
```
Four throws. Should fail at module init via a Zod schema on process.env, not at order-placement
time on the first live order.

**get_recent_chat tool has no input schema (extract-intent.ts:239-240):**
```
const author = (input as { author?: string }).author;
const limit  = Math.min((input as { limit?: number }).limit ?? 20, 50);
```
Every other tool has a Zod schema in agent/schemas.ts. This one uses raw as casts.

---

## Rearchitecture Roadmap

The work divides into six independent tracks that can be executed separately.

### Track A — DB-Read Boundary (2-3 hours, highest leverage)

Add `parseTradeFromDb(row)` to src/db/parse.ts. Internally calls existing parseLegs() and
parseDirection(), adds StrategySchema.parse(). Update every getOpenPositions() consumer in
execute.ts to call it immediately on the query result. Eliminates 15 casts.

Add `LegOffMetadataSchema` to src/lib/enums.ts or a new src/trades/schemas.ts. Call it in
record-trade.ts:315 instead of the double-cast chain.

### Track B — Write Boundaries (3-4 hours)

Create `RecordTradeInputSchema` as a Zod discriminated union on `action`. Each variant
(OPEN/CLOSE/ADD/TRIM/LEG_OFF) declares its required fields. Defaults move from inline `?? 0`
to schema defaults. Call `RecordTradeInputSchema.parse(input)` at function entry.

Create `BacktestRunConfigSchema` for the JSON column. Use `.parse()` in both the web API route
and the server actions instead of `as BacktestRunConfig`.

### Track C — Local API Input Validation (1-2 hours)

Create schemas for each route:
- `BacktestSpawnSchema` (src/local-api/routes/backtests.ts)
- `ForceExitRequestSchema` (src/local-api/routes/trades.ts) — uses DirectionSchema + OrderLegSchema
- UUID validation on logs /:id route (security fix — do this first)

### Track D — Server Action Validation (2-3 hours)

Create `StartBacktestFormSchema` with z.string().date() for dates, z.coerce.number() for
numerics, z.string().transform() for traders comma-list. Call at the top of each action.
Same for trades/actions.ts (tradeId as UUID), reconciliation/actions.ts, settings/actions.ts.

### Track E — Response Validation (1-2 hours)

Export response schemas from each web/app/api/ route handler. Import them in the client fetch
callers to validate before setState. Three endpoints, three schemas.

### Track F — Type Safety Cleanup (1 hour)

- Replace `(signal as any).action` with `action satisfies never` exhaustiveness guard
- Add `FilledOrderResult` type (non-optional filledPrice, fillTimestamp) to order-schemas.ts
- Remove redundant `as const` on ternary literals throughout execute.ts
- Add `GetRecentChatInput` to src/agent/schemas.ts, call in extract-intent.ts:238-241
- Move env validation to module init in tradestation.ts (one TsEnvSchema.parse at top)
- Add `TrackedTraderSchema` for src/config/traders.ts config validation at load time

---

## What's Already Good

Do not touch these — they are the model to follow everywhere else:

- src/agent/schemas.ts — all tool inputs, SignalSchema, AgentDecisionSchema with .refine()
- src/broker/order-schemas.ts — OrderParams, WorkingOrderParams, OrderResult with cross-field
  .refine() constraints
- src/broker/schemas.ts — TradeStation API responses via parseApiResponse() helper
- src/lib/zod-financial.ts — zPrice, zNonNegPrice, zCoercePrice, zQuantity, zPct01
- src/lib/enums.ts — DirectionSchema, StrategySchema, TradeActionSchema centralized
- src/db/parse.ts — parseLegs() and parseDirection() exist but are not called by execute.ts
- src/backtest/databento-tape.ts — market data parsing via DatabentoRecord schema

---

## File Change Map

| File | Change | Track |
|------|--------|-------|
| src/db/parse.ts | Add parseTradeFromDb() | A |
| src/pipeline/execute.ts | Replace 15 casts with parseTradeFromDb() call | A |
| src/trades/schemas.ts (new) | LegOffMetadataSchema, RecordTradeInputSchema | A+B |
| src/trades/record-trade.ts | Parse LEG_OFF metadata, parse RecordTradeInput at entry | A+B |
| src/db/config-schemas.ts (new) | BacktestRunConfigSchema, TrackedTraderSchema | B |
| web/app/backtests/actions.ts | StartBacktestFormSchema.parse() at entry | B+D |
| web/app/api/backtest-runs/route.ts | Parse config column, export response schema | B+E |
| src/local-api/routes/logs.ts | UUID validation on id param (security) | C |
| src/local-api/routes/backtests.ts | BacktestSpawnSchema.parse() | C |
| src/local-api/routes/trades.ts | ForceExitRequestSchema.parse() | C |
| web/app/trades/actions.ts | z.string().uuid() on tradeId | D |
| web/app/reconciliation/actions.ts | Schema on alertId + reason | D |
| web/app/settings/actions.ts | Enum validation on key | D |
| web/app/api/signals/route.ts | Bounded coerce on limit | E |
| web/app/api/status/route.ts | UUID check on run param, response schema | E |
| web/app/components/run-scope-provider.tsx | Parse status response before setState | E |
| web/app/components/signal-sheet.tsx | Parse signals response | E |
| web/app/components/run-scope-selector.tsx | Parse runs response | E |
| src/broker/order-schemas.ts | FilledOrderResult type | F |
| src/pipeline/execute.ts | Remove as any, as const noise, use FilledOrderResult | F |
| src/agent/schemas.ts | Add GetRecentChatInput | F |
| src/intents/extract-intent.ts | Use GetRecentChatInput schema | F |
| src/broker/tradestation.ts | TsEnvSchema at module init | F |
