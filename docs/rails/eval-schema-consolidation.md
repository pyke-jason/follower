# Eval Schema Consolidation

Eliminate the parallel `EvalLabel`/`EvalSignal` type system and redesign `Signal` to be the single source of truth for "what trades does this message contain." One type used by labels, orchestrator, and execution — no mapping layers.

## What's wrong today

Three schemas describe the same concept:

| Schema | Location | Used by |
|--------|----------|---------|
| `Signal` | `src/agent/schemas.ts` | Orchestrator, `messageLabels` table, LLM path |
| `EvalLabel` + `EvalSignal` | `src/eval/schema.ts` | `evalLabels` table, review UI, eval comparison |
| `LabelResult` | `src/agent/schemas.ts` | Nothing (dead code) |

`EvalSignal` uses different field names (`optionType` + `isCredit` vs `strategy`), fewer actions (3 vs 5), and a nested `legs[]` structure. Every comparison between eval and production requires a mapping layer.

`Signal` has a `legs[]` field (`SignalLeg[]`) that is redundant — the leg structure (BUY/SELL per strike) is deterministic from `strategy` + strike ordering. `buildSpreadOptionLegs()` in open-path already derives this. The `legs` field is only read in 3 places (open-path, llm-path) to extract strikes and expiry, which flat fields handle.

The `evalLabels` table has 304 rows, all unverified, with known systematic errors. Not worth migrating.

## Redesigned Signal

One type for everything. Remove `legs`, add flat fields, make `strategy` nullable.

```typescript
// src/agent/schemas.ts — the ONLY signal type
export const SignalSchema = z.object({
  action:         TradeActionSchema,                          // OPEN | CLOSE | ADD | TRIM | LEG_OFF
  symbol:         z.string().min(1),                          // ticker
  direction:      DirectionSchema.nullable().default(null),   // LONG | SHORT | null (market bias from badge)
  strategy:       StrategySchema.nullable().default(null),    // STOCK | CALL | PUT | CDS | PDS | PCS | CCS | null (null = unknown instrument)
  strikes:        z.array(z.number()).nullable().default(null), // [332.5] single option, [190, 192.5] spread
  expiry:         z.string().nullable().default(null),        // as stated: "Oct (17)", "next week", "5/23"
  statedPrice:    z.number().nullable().default(null),        // premium, credit, or stock entry price
  quantity:       z.number().nullable().default(null),        // shares or contracts
  exitPercent:    zPct01.optional(),                          // TRIM: 0.5 = half
  targetStrategy: StrategySchema.optional(),                  // LEG_OFF: what remains after removing a leg
});
```

### What changed from current Signal

| Field | Before | After | Why |
|-------|--------|-------|-----|
| `strategy` | Required, defaults to `'STOCK'` | Nullable, defaults to `null` | "Long TSLA $200" — we don't know the instrument. Defaulting to STOCK is a lie. |
| `direction` | Optional (undefined) | Nullable (null) | Consistent nullability. null = message doesn't specify. |
| `statedPremium` | Optional number | Renamed to `statedPrice`, nullable | Works for stock entry prices AND option premiums. |
| `legs` | `SignalLegSchema[]`, max 2 | **Deleted** | Redundant. Leg structure is deterministic from strategy + strikes. |
| `strikes` | Not on Signal (was inside `legs`) | `number[]`, nullable | Flat field. [332.5] for single option, [190, 192.5] for spread. |
| `expiry` | Not on Signal (was inside `legs`) | `string`, nullable | Flat field. As stated in message verbatim. |
| `quantity` | Not on Signal | `number`, nullable | Shares or contracts when stated. |

### What stays the same

`ResolvedSignal` in `src/intents/orchestrator/types.ts` is untouched. It has its own `legs: (OptionLeg | StockLeg)[]` for fully resolved broker instructions. That's the execution output — different concern, different type.

### How every trade type maps

**Stock** — "Long TSLA $311.83 - 1,000 Shares"
```
[[{ action: OPEN, symbol: TSLA, direction: LONG, strategy: STOCK, statedPrice: 311.83, quantity: 1000 }]]
```

**Unknown instrument** — "Long SHOP - 133"
```
[[{ action: OPEN, symbol: SHOP, direction: LONG, strategy: null, statedPrice: 133 }]]
```

**Single call** — "Long TSLA 5/23 $332.5 calls for $10.83"
```
[[{ action: OPEN, symbol: TSLA, direction: LONG, strategy: CALL, strikes: [332.5], expiry: "5/23", statedPrice: 10.83 }]]
```

**Buying puts** — "Short UPS using 8/1 $100 puts for $2.15"
```
[[{ action: OPEN, symbol: UPS, direction: SHORT, strategy: PUT, strikes: [100], expiry: "8/1", statedPrice: 2.15 }]]
```

**PDS** — "Short NVDA PDS $170/$167.50 for .90 - 30 Contracts"
```
[[{ action: OPEN, symbol: NVDA, direction: SHORT, strategy: PDS, strikes: [170, 167.5], statedPrice: 0.90, quantity: 30 }]]
```

**PCS** — "Long GLW pcs 68/67 for .63 credit"
```
[[{ action: OPEN, symbol: GLW, direction: LONG, strategy: PCS, strikes: [68, 67], statedPrice: 0.63 }]]
```

**Sold puts (Pete)** — "Long OKLO sold Oct (17) $95 put @ $4.70"
```
[[{ action: OPEN, symbol: OKLO, direction: LONG, strategy: PUT, strikes: [95], expiry: "Oct (17)", statedPrice: 4.70 }]]
```
Note: this is a SHORT PUT position (sold), but the badge says LONG (bullish bias). Direction captures the badge. The orchestrator resolves the actual BUY/SELL from "sold" keyword.

**Lotto** — "Long WYNN lotto 110 calls for .23"
```
[[{ action: OPEN, symbol: WYNN, direction: LONG, strategy: CALL, strikes: [110], statedPrice: 0.23 }]]
```

**Strangle** — "Long Short SPY Strangle - Bought the $673 Calls and $670 Puts expires tomorrow"
One trade, two signals:
```
[[
  { action: OPEN, symbol: SPY, direction: LONG, strategy: CALL, strikes: [673], expiry: "tomorrow" },
  { action: OPEN, symbol: SPY, direction: SHORT, strategy: PUT, strikes: [670], expiry: "tomorrow" }
]]
```

**WATM** — "Long SOFI WATM sell nov 14 $30 puts buy dec 19 $27 puts for .36"
One trade, two signals (different expiries):
```
[[
  { action: OPEN, symbol: SOFI, direction: LONG, strategy: PUT, strikes: [30], expiry: "nov 14" },
  { action: OPEN, symbol: SOFI, direction: LONG, strategy: PUT, strikes: [27], expiry: "dec 19", statedPrice: 0.36 }
]]
```

**Calendar** — "Short Long HPE time spread using $23 calls for .09"
One trade, two signals (same strike, different expiries):
```
[[
  { action: OPEN, symbol: HPE, strategy: CALL, strikes: [23], expiry: "near" },
  { action: OPEN, symbol: HPE, strategy: CALL, strikes: [23], expiry: "far", statedPrice: 0.09 }
]]
```

**Partial exit** — "Exit Long PLTR 1/2 at $179.50"
```
[[{ action: TRIM, symbol: PLTR, direction: LONG, exitPercent: 0.5, statedPrice: 179.50 }]]
```

**Two separate trades** — "Exit NVDA $2.20 per share (1,500) Exit AMZN with $2.90 profit"
```
[[{ action: CLOSE, symbol: NVDA, quantity: 1500 }], [{ action: CLOSE, symbol: AMZN }]]
```

**Exit + new open** — "Exit TXN .18 loss (1,000) Short TSLA $328.81 - 1,000 Shares"
```
[[{ action: CLOSE, symbol: TXN, quantity: 1000 }], [{ action: OPEN, symbol: TSLA, direction: SHORT, strategy: STOCK, statedPrice: 328.81, quantity: 1000 }]]
```

## Eval label structure

The `evalLabels` table stores labels as JSON. The label wraps `Signal[][]` with eval metadata:

```typescript
type EvalLabelData = {
  reasoning: string;           // why this classification (written first)
  isTrade: boolean;            // is this an actionable trade message?
  confidence: 'HIGH' | 'LOW'; // how certain
  trades: Signal[][];          // outer = trades, inner = legs of one trade
};
```

No separate eval schema file. This type is defined inline in `src/db/schema.ts` next to the table.

## Delete list

| File | Reason |
|------|--------|
| `src/eval/schema.ts` | Parallel type system. Replaced by `Signal`. |
| `src/eval/labeler.ts` | Replaced by `/label` Claude Code skill. |
| `src/eval/eval.ts` | Comparison logic hardcoded to `EvalSignal` fields. Rewrite against `Signal`. |
| `web/src/views/eval/schema.ts` | Frontend copy of deleted schema. |
| `docs/eval-revamp/strategy.md` | Describes the old schema design. Obsolete. |
| `docs/lessons/2026-03-23-multi-signal-eval.md` | References old schema. |
| `LabelResult` in `src/agent/schemas.ts` | Dead code. Zero consumers. |
| `SignalLegSchema` in `src/agent/schemas.ts` | No longer needed (legs removed from Signal). |

## Files to update

### `src/agent/schemas.ts`
- Delete `LabelResult`, `LabelResultSchema`, `SignalLegSchema`
- Rewrite `SignalSchema`: remove `legs`, add `strikes`, `expiry`, `quantity`, rename `statedPremium` → `statedPrice`, make `strategy` nullable
- `AgentDecisionSchema` stays (wraps Signal[])
- `SubmitDecisionInput` stays

### `src/db/schema.ts`
- Remove `import type { EvalLabel } from '../eval/schema.js'`
- Define `EvalLabelData` type inline next to table
- Change `label` and `humanLabel` columns to `typedJson<EvalLabelData>`
- Bump version default from 1 to 2

### `src/intents/orchestrator/open-path.ts`
- Currently reads `signal.legs` to get strikes and expiry (3 call sites)
- Change to read `signal.strikes` and `signal.expiry` directly

### `src/intents/orchestrator/llm-path.ts`
- Currently reads `signal.legs` to check for strikes/expiry (2 call sites)
- Change to read `signal.strikes` and `signal.expiry`
- Update the LLM tool schema (`submit_decision`) to match new Signal shape

### `src/intents/orchestrator/index.ts`
- `legCount` calculation reads `s.legs.length` — change to count from `s.strikes`

### `src/local-api/routes/eval.ts`
- Remove `import { EvalLabelSchema }`
- Inline a Zod schema for `EvalLabelData` validation on the review endpoint

### `web/src/views/eval/review/page.tsx`
- Remove `import type { EvalLabel, EvalSignal } from '@src/eval/schema'`
- Import `Signal` from `@src/agent/schemas`
- Editor fields change: `optionType` + `isCredit` + `instrumentKnown` → `strategy` + `strikes` + `expiry`
- Delete `normalizeLabel()` backward-compat
- UI should edit trades (outer array) and signals within each trade (inner array)

### `web/src/views/eval/page.tsx`
- Reads from `web-queries-eval.ts` which uses `discrepancyReviews` and `messageLabels`, not `evalLabels`. Likely unaffected. Verify after migration.

### `.claude/skills/label/SKILL.md`
- Update schema section to show redesigned `Signal`
- Update all examples to use `strategy`, `strikes`, `expiry`, `statedPrice`
- Reference `src/agent/schemas.ts` as source of truth

### `.claude/rules/intent-evals.md`
- Remove references to deleted files
- Update schema description

### `src/intents/evals/` (orchestrator eval fixtures)
- Fixtures reference `signals[0].legs[0].side` in `mustMatch` paths
- These compare against `ResolvedSignal` (which keeps `legs`), not `Signal`
- Verify no fixtures reference `Signal.legs` directly

## Data migration

Nuke the 304 existing rows:
```sql
DELETE FROM eval_labels;
```

No structural DDL change — columns are still JSON text. Only the TS type annotations change. No Drizzle migration needed.

## Execution order

1. Redesign `SignalSchema` in `src/agent/schemas.ts` (remove legs, add flat fields, nullable strategy)
2. Fix orchestrator consumers: open-path, llm-path, index.ts (read `strikes`/`expiry` instead of `legs`)
3. Type check: `npx tsc --noEmit` — fix any breakage from Signal shape change
4. Delete dead code: `LabelResult`, `SignalLegSchema`, `src/eval/labeler.ts`
5. Update `src/db/schema.ts`: new `EvalLabelData` type, `typedJson` columns, bump version
6. Nuke eval_labels data
7. Delete `src/eval/schema.ts`, `web/src/views/eval/schema.ts`
8. Update `src/local-api/routes/eval.ts` validation
9. Update `web/src/views/eval/review/page.tsx`
10. Update `.claude/skills/label/SKILL.md`
11. Update rules files
12. Stub new `src/eval/eval.ts` (comparison logic against `Signal[][]`)
13. Run orchestrator evals: `npx tsx scripts/eval-orchestrator.ts` — verify no regressions
14. Type check + test: `npx tsc --noEmit && npm test`

## Watch out

- **`ResolvedSignal` is untouched.** It keeps its own `legs: (OptionLeg | StockLeg)[]` for execution. This is a different type with a different purpose (broker instructions vs message classification). Don't conflate them.
- **`src/db/schema.ts` must be self-contained for drizzle-kit.** The `Signal` type import is `type`-only (erased at compile time) — safe. But `SignalSchema` (Zod runtime) cannot be imported into schema.ts. Inline validation where needed.
- **`messageLabels` table** stores `Signal[]` (old shape). Leave alone — it's used by `web-queries-eval.ts` for the parser comparison dashboard. Separate concern.
- **`statedPremium` → `statedPrice` rename** touches everywhere Signal is constructed. Grep for `statedPremium` and update all sites.
- **`strategy: null` vs `strategy: 'STOCK'`** — the orchestrator currently defaults unknown instruments to STOCK. After this change, the parser should set `strategy: null` when uncertain and let open-path resolve it. This is a behavior change that improves correctness.
- **Orchestrator eval fixtures** compare against `ResolvedSignal`, not `Signal`. The `mustMatch` paths like `signals[0].legs[0].side` refer to `ResolvedSignal.legs`, which is unchanged. But verify no fixture references the deleted `Signal.legs`.
