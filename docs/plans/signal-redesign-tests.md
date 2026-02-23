# Signal Redesign: Test Strategy

Date: 2026-02-23
Author: test-strategist

## Overview

This document covers the complete test strategy for splitting `LLMSignal` from
`InternalSignal`, adding `normalizeSignal()`, migrating DB schema to use enums,
and modifying LLM prompts.

---

## Part 1: Catalog of Existing Tests That Reference Signal Types or Action Types

### Tests that DO reference Signal, action types, or strategy strings

**`src/tasks/factory.test.ts`**
- References `actionHint: 'OPEN'` and `directionHint: 'LONG'` on the `Message`
  type (lines 57-58). These are string literals today. If `actionHint` migrates
  to the new enum type, the fixture value must change to match the enum shape.
- `detectedStrategies: []` is an array of strings; if the schema migrates to
  enum values this fixture needs updating.
- No direct `Signal` object construction. No changes needed to test logic, only
  to fixture data types if `Message` shape changes.

**`src/backtest/runner-filter.test.ts`**
- Tests filter predicate on `{ symbols, isPaperTrade }`. Completely independent
  of Signal type. No changes required.

**`src/backtest/sim-broker.test.ts`**
- `makeStockBuyOrder` / `makeStockSellOrder` from test-fixtures construct
  `OrderParams` with `strategy: 'STOCK'` and `direction: 'LONG'/'SHORT'`
  (string literals). These are `OrderParams` not `Signal` — no change needed
  unless `OrderParams` itself migrates.
- `arbStrategy` in `test-fixtures.ts` generates from
  `fc.constantFrom('STOCK', 'CALL_SPREAD', 'PUT_SPREAD', 'IRON_CONDOR')` — this
  matches neither the current `StrategySchema` enum nor the `computeTradePnl`
  accepted strategies. This is an independent concern; see note below.

**`src/backtest/sim-broker-pnl.test.ts`**
- Constructs `RecordTradeInput` objects directly with string literals:
  `action: 'OPEN'`, `action: 'TRIM'`, `action: 'ADD'`, `direction: 'LONG'`,
  `strategy: 'STOCK'` etc. These pass through `recordTrade()`.
- If `RecordTradeInput` migrates to use the new enums, the string literals in
  this test still compile because the enum values are string subtypes.
  No behavioral change required.

**`src/backtest/sim-broker-db.test.ts`**
- `insertOpenTrade`, `insertClosedTrade`, `insertOpenOptionTrade` in
  `test-fixtures.ts` write `direction: string`, `strategy: string` directly into
  the DB. If the DB schema migrates columns to SQLite CHECK constraints or Drizzle
  enum columns, these insertions must use enum-compatible values.
- Current values used: `direction: 'LONG'/'SHORT'`, `strategy: 'STOCK'`,
  `strategy: 'CALL_SPREAD'`, `strategy: 'CDS'`, `strategy: 'IRON_CONDOR'`,
  `strategy: 'CALL'`, `strategy: 'PUT'`, `strategy: 'PDS'`.
- The `StrategySchema` in `enums.ts` currently only has
  `['STOCK', 'CALL', 'PUT', 'CDS', 'PDS']`. `CALL_SPREAD` and `IRON_CONDOR` are
  in the DB fixtures but NOT in the schema enum. This is a pre-existing gap that
  the redesign must resolve (see Part 2).

**`src/backtest/sim-broker-temporal.test.ts`**
- Same pattern as `sim-broker-db.test.ts`. Uses `strategy: 'CALL'`, `'PUT'`,
  `'CDS'`, `'PDS'`, `'IRON_CONDOR'` in fixtures.
- `placeOrder` calls construct leg objects with `type: 'CALL' as const`,
  `action: 'BUY' as const` — these are already typed as enum members.
- No `Signal` objects constructed. No changes to test logic.

**`src/backtest/test-fixtures.ts`** (shared fixture file — changes here affect all)
- `arbStrategy = fc.constantFrom('STOCK', 'CALL_SPREAD', 'PUT_SPREAD', 'IRON_CONDOR')`:
  - These values are used only in `computeTradePnl` property tests
    (`sim-broker.test.ts` sections 2 and 3). They test the PnL multiplier logic
    only — they do not flow through `normalizeSignal()` or any `Signal`.
  - `CALL_SPREAD` and `PUT_SPREAD` are NOT in the current `StrategySchema` enum.
    The test works today because `computeTradePnl` accepts `strategy: string`.
  - **Decision**: Leave `arbStrategy` as-is for PnL tests (it tests the 100x
    multiplier across option-like strategy names, not the type system). If
    `computeTradePnl` is narrowed to the enum, update `arbStrategy` to use only
    valid enum values: `fc.constantFrom('STOCK', 'CALL', 'PUT', 'CDS', 'PDS')`.
- `arbDirection` — already typed as `fc.Arbitrary<'LONG' | 'SHORT'>`. Correct.
- `makeStockBuyOrder` / `makeStockSellOrder` — use `strategy: 'STOCK'`,
  `direction: 'LONG'/'SHORT'`. Correct.
- `INSERT_TRADES_SQL` / `CREATE_TRADE_EVENTS_SQL` in `test-fixtures.ts`:
  - The `strategy TEXT` column in `CREATE_TRADES_SQL` (line 276) and
    `CREATE_TRADE_EVENTS_SQL` (line 307) will need updating if the DB migrates
    strategy columns to `TEXT CHECK(...)` constraints. Update the DDL strings in
    `test-fixtures.ts` to mirror the new schema DDL.
- `InsertOpenTradeParams.strategy: string` (line 367) — if `StrategySchema` is
  the canonical source, narrow this to `Strategy` type.

**`src/orders/order-manager.test.ts`**
- Constructs `WorkingOrderParams` with `strategy: 'STOCK'`, `direction: 'LONG'`.
  No `Signal` objects. No changes needed unless `WorkingOrderParams` types change.

**`src/pipeline/execute.ts`** (production code, referenced for understanding)
- `executeSignal()` accepts `Signal` from `src/agent/schemas.ts`. The full
  `Signal` type is used throughout the pipeline.
- `buildOrderFromSignal()` accepts `Signal` — this is a key seam where
  `InternalSignal` will replace `Signal`.

### Tests with NO Signal/action type references (no changes needed)

- `src/backtest/margin-model.test.ts` — pure math, no signal flow
- `src/backtest/occ-symbology.test.ts` — OCC formatting only
- `src/backtest/extended-metrics.test.ts` — stats/metrics only
- `src/lib/pnl.test.ts` — pure PnL math
- `src/lib/commission.test.ts` — pure commission math
- `src/backtest/equity-curve.test.ts` — equity curve math
- `src/lib/helpers.test.ts` — utility helpers
- `src/backtest/report.test.ts` — report generation, no signal flow
- `src/lib/et-logging.test.ts` — logging utilities

---

## Part 2: What Needs to Change in Each Existing Test

### `src/backtest/test-fixtures.ts`

**Changes required:**

1. **`arbStrategy`** — only if `computeTradePnl` signature narrows to `Strategy`
   enum. Change from:
   ```ts
   export const arbStrategy = fc.constantFrom('STOCK', 'CALL_SPREAD', 'PUT_SPREAD', 'IRON_CONDOR');
   ```
   to:
   ```ts
   export const arbStrategy = fc.constantFrom('STOCK', 'CALL', 'PUT', 'CDS', 'PDS');
   ```
   Note: `IRON_CONDOR` disappears from the PnL arbitrary. Add a separate
   `arbStrategyWithCondor` if IRON_CONDOR sweep tests need the 100x multiplier
   check. Otherwise the temporal and DB tests that directly use `'IRON_CONDOR'`
   in `insertOpenOptionTrade` calls will still compile (they use string literals).

2. **`InsertOpenTradeParams.strategy: string`** — narrow to `Strategy`:
   ```ts
   import type { Strategy } from '../lib/enums.js';
   export type InsertOpenTradeParams = {
     strategy: Strategy;
     // ...
   };
   ```
   This cascades: all callers that pass `'CALL_SPREAD'` or `'IRON_CONDOR'` will
   need updating to `'CDS'` or the appropriate enum value.

3. **`CREATE_TRADES_SQL` / `CREATE_TRADE_EVENTS_SQL`** — if the schema adds
   CHECK constraints on `direction` or `strategy` columns, update the DDL strings
   to match. This is a copy of the real schema DDL and must stay in sync.

4. **`InsertOpenOptionTradeParams.legs[].type`** — already typed as
   `'CALL' | 'PUT' | 'STOCK'`. No change needed.

### `src/tasks/factory.test.ts`

**Conditional changes** (depends on whether `Message.actionHint` becomes an enum
column):

- If `actionHint` changes from `string | null` to
  `TradeAction | null` in the DB schema, update the `makeMessage` fixture:
  ```ts
  actionHint: 'OPEN',       // TradeAction enum value — still valid string literal
  directionHint: 'LONG',    // Direction enum value — still valid
  ```
  These string values happen to match the enum, so no change to literal values.
  However, if passing `actionHint: 'BUY'` or an invalid value now throws a type
  error at compile time, any test that deliberately passed invalid hints will
  need updating.

### `src/backtest/sim-broker-db.test.ts` and `sim-broker-temporal.test.ts`

**Changes required if strategy enum is narrowed:**

- Replace all direct `strategy: 'CALL_SPREAD'` with `strategy: 'CDS'` or the
  appropriate canonical name (wherever `CALL_SPREAD` appears in option trade
  insertions — search: there are ~3 occurrences in sim-broker-db.test.ts in the
  PnL test for options, and 0 in temporal).
- `'IRON_CONDOR'` is used in sweepExpired tests — this must remain a valid
  strategy in the enum for those tests to compile. Confirm with type-designer
  whether `IRON_CONDOR` is added to `StrategySchema` or whether those fixtures
  need renaming.

### `src/backtest/sim-broker.test.ts`

- `arbStrategy` is imported from test-fixtures and used in `computeTradePnl`
  property tests. If `arbStrategy` is updated as described above, the tests
  continue to work — the 100x multiplier property remains valid for any options
  strategy.

---

## Part 3: New Test Cases Needed for `normalizeSignal()`

`normalizeSignal()` converts an `LLMSignal` (raw LLM output) into an
`InternalSignal` (typed, validated, ready for pipeline execution). It is a pure
function with no I/O.

**Test file location:** `src/agent/normalize-signal.test.ts` (new file)

### 3a. Happy-path normalization

```
normalizeSignal({ action: 'OPEN', symbol: 'SPY', direction: 'LONG', strategy: 'STOCK' })
→ { action: 'OPEN', symbol: 'SPY', direction: 'LONG', strategy: 'STOCK', legs: undefined }
```

- All five TradeAction values: OPEN, CLOSE, ADD, TRIM, LEG_OFF
- All Direction values: LONG, SHORT
- All Strategy values: STOCK, CALL, PUT, CDS, PDS
- Symbol normalization: 'spy' → 'SPY', 'aapl  ' → 'AAPL' (if symbol is uppercased)
- Optional fields pass through: `statedPremium`, `exitPercent`, `legs`,
  `targetStrategy`

### 3b. LLM alias mapping (core purpose of the normalizer)

These test cases document every alias the LLM might emit and verify the canonical
output. Use a table-driven test with `it.each`.

| LLM input `action` | Expected `InternalSignal.action` |
|---|---|
| `'BUY'` | `'OPEN'` |
| `'SELL'` | `'OPEN'` (with direction `'SHORT'`) |
| `'ENTER'` | `'OPEN'` |
| `'EXIT'` | `'CLOSE'` |
| `'SELL_TO_CLOSE'` | `'CLOSE'` |
| `'BUY_TO_CLOSE'` | `'CLOSE'` |
| `'PARTIAL'` | `'TRIM'` |
| `'REDUCE'` | `'TRIM'` |
| `'ADD_TO'` | `'ADD'` |
| `'SCALE_IN'` | `'ADD'` |

| LLM input `strategy` | Expected `InternalSignal.strategy` |
|---|---|
| `'CALL_SPREAD'` | `'CDS'` |
| `'BULL_CALL_SPREAD'` | `'CDS'` |
| `'PUT_SPREAD'` | `'PDS'` |
| `'BEAR_PUT_SPREAD'` | `'PDS'` |
| `'NAKED_CALL'` | `'CALL'` |
| `'NAKED_PUT'` | `'PUT'` |
| `'SHARES'` | `'STOCK'` |
| `'EQUITY'` | `'STOCK'` |

### 3c. Cross-field validation (Zod `.refine()`)

These test CLOSED signals for the Zod boundary contract:

```ts
// LEG_OFF requires targetStrategy
expect(() => normalizeSignal({ action: 'LEG_OFF', symbol: 'SPY', direction: 'LONG', strategy: 'CDS' }))
  .toThrow('targetStrategy');

// TRIM without exitPercent gets a sensible default (e.g. 0.5)
const sig = normalizeSignal({ action: 'TRIM', symbol: 'SPY', direction: 'LONG', strategy: 'STOCK' });
expect(sig.exitPercent).toBe(0.5);

// Legs with duplicate strike/expiry/type/action are deduped
const sig2 = normalizeSignal({
  action: 'OPEN', symbol: 'SPY', direction: 'LONG', strategy: 'CALL',
  legs: [
    { strike: 400, expiry: '2026-06-20', optionType: 'CALL', action: 'BUY' },
    { strike: 400, expiry: '2026-06-20', optionType: 'CALL', action: 'BUY' }, // duplicate
  ],
});
expect(sig2.legs).toHaveLength(1);
```

### 3d. Rejection / invalid input

```ts
// Unknown action throws
expect(() => normalizeSignal({ action: 'HOLD', symbol: 'SPY', direction: 'LONG', strategy: 'STOCK' }))
  .toThrow();

// Empty symbol throws
expect(() => normalizeSignal({ action: 'OPEN', symbol: '', direction: 'LONG', strategy: 'STOCK' }))
  .toThrow();

// Negative strike throws
expect(() => normalizeSignal({
  action: 'OPEN', symbol: 'SPY', direction: 'LONG', strategy: 'CALL',
  legs: [{ strike: -5, expiry: '2026-06-20', optionType: 'CALL', action: 'BUY' }],
})).toThrow();
```

### 3e. Property-based tests for normalizeSignal

Use fast-check to assert invariants that must hold for ALL valid LLM signals:

```ts
// Invariant 1: output action is always a TradeAction enum value
fc.property(arbLLMSignal, (raw) => {
  const result = normalizeSignal(raw);
  expect(TradeActionSchema.safeParse(result.action).success).toBe(true);
});

// Invariant 2: output strategy is always a Strategy enum value
fc.property(arbLLMSignal, (raw) => {
  const result = normalizeSignal(raw);
  expect(StrategySchema.safeParse(result.strategy).success).toBe(true);
});

// Invariant 3: normalization is idempotent — normalizing twice gives same result
fc.property(arbLLMSignal, (raw) => {
  const once = normalizeSignal(raw);
  const twice = normalizeSignal(once as LLMSignal);
  expect(twice).toEqual(once);
});
```

The `arbLLMSignal` arbitrary should generate random combinations of:
- Known LLM aliases from the alias tables above
- Valid canonical values (should pass through unchanged)
- Optional fields randomly present or absent

---

## Part 4: Integration Test Design for Full Signal Flow

### 4a. End-to-end: LLMSignal → normalizeSignal → executeSignal → DB

**Test file:** `src/pipeline/execute-with-normalize.test.ts` (new) or extend
`src/pipeline/execute.test.ts` if it exists.

**Setup:** Use in-memory SQLite (same pattern as sim-broker-pnl.test.ts), a stub
market data provider, no-op risk check, fixed position sizer.

**Test cases:**

1. **LLM emits 'BUY' alias → OPEN trade recorded**
   ```ts
   const raw: LLMSignal = { action: 'BUY', symbol: 'SPY', direction: 'LONG', strategy: 'STOCK' };
   const signal = normalizeSignal(raw);
   const result = await executeSignal(signal, 'trader1', deps, opts);
   expect(result.executed).toBe(true);
   // Verify DB has OPEN trade for SPY
   ```

2. **LLM emits 'CALL_SPREAD' strategy alias → CDS trade recorded**
   ```ts
   const raw: LLMSignal = {
     action: 'OPEN', symbol: 'SPY', direction: 'LONG', strategy: 'CALL_SPREAD',
     legs: [
       { strike: 400, expiry: '2026-06-20', optionType: 'CALL', action: 'BUY' },
       { strike: 410, expiry: '2026-06-20', optionType: 'CALL', action: 'SELL' },
     ],
   };
   const signal = normalizeSignal(raw);
   expect(signal.strategy).toBe('CDS');
   const result = await executeSignal(signal, 'trader1', deps, opts);
   expect(result.executed).toBe(true);
   const [trade] = await db.select().from(schema.trades);
   expect(trade.strategy).toBe('CDS');
   ```

3. **LLM emits 'EXIT' alias → CLOSE executed on existing position**
   ```ts
   // First open a position
   const openSignal = normalizeSignal({ action: 'OPEN', symbol: 'SPY', direction: 'LONG', strategy: 'STOCK' });
   await executeSignal(openSignal, 'trader1', deps, opts);

   // Now close via 'EXIT' alias
   const closeRaw: LLMSignal = { action: 'EXIT', symbol: 'SPY', direction: 'LONG', strategy: 'STOCK' };
   const closeSignal = normalizeSignal(closeRaw);
   expect(closeSignal.action).toBe('CLOSE');
   const result = await executeSignal(closeSignal, 'trader1', deps, opts);
   expect(result.executed).toBe(true);
   const [trade] = await db.select().from(schema.trades);
   expect(trade.status).toBe('CLOSED');
   ```

4. **Invalid LLM output does not reach executeSignal**
   ```ts
   // normalizeSignal throws before we can call executeSignal
   expect(() => normalizeSignal({ action: 'HOLD', symbol: 'SPY', direction: 'LONG', strategy: 'STOCK' }))
     .toThrow();
   // No DB mutations happened
   const trades = await db.select().from(schema.trades);
   expect(trades).toHaveLength(0);
   ```

### 4b. Backtest runner integration: LLMSignal flow through runner

These are "fat" integration tests that exercise the entire
`message → extract-intent → normalizeSignal → executeSignal → recordTrade`
chain using real SQLite but stubbed market data and LLM.

Key scenarios to cover:

1. **Runner processes message with action alias → correct trade type in DB**
2. **Runner processes message with strategy alias → correct strategy in DB**
3. **Runner processes two messages: OPEN then EXIT → position opened then closed**
4. **normalizeSignal failure inside runner → message skipped, run continues**
   (error isolation — no crash)

These tests belong in a new file `src/backtest/runner-normalize.test.ts` or
extend the existing runner tests once the runner is updated.

---

## Part 5: Regression Strategy

The goal is to guarantee that a backtest run on the same dataset produces
identical trade counts, PnL values, and closed-trade statistics before and after
the redesign.

### 5a. Golden-file snapshot test

Create a deterministic mini-backtest with a fixed seed and a small set of
synthetic messages:

```ts
// src/backtest/regression.test.ts (new)
const MESSAGES = [
  { text: 'Opening SPY calls', action: 'OPEN', strategy: 'CALL', ... },
  { text: 'Trimming half', action: 'TRIM', strategy: 'CALL', ... },
  { text: 'Closing SPY calls', action: 'CLOSE', strategy: 'CALL', ... },
];
```

Run the full runner with stubbed market data. After the run, assert:
- Exact trade count: `expect(trades).toHaveLength(3)` (OPEN + TRIM + CLOSE)
- Final portfolio PnL equals a hardcoded value
- No zombie open trades (all positions closed)

Commit this snapshot. If the redesign changes behavior, this test will catch it.

### 5b. DB strategy/action values unchanged in output

After migration, assert that DB rows written by the pipeline use canonical enum
values, not LLM aliases:

```ts
// Verify that 'CALL_SPREAD' never appears in the DB after the migration
const trades = await db.select().from(schema.trades);
for (const t of trades) {
  expect(['STOCK', 'CALL', 'PUT', 'CDS', 'PDS']).toContain(t.strategy);
}
```

### 5c. Bidirectional contract test

Verify that `normalizeSignal` is the ONLY place where alias translation happens:

```ts
// All canonical InternalSignal values round-trip through normalizeSignal unchanged
for (const action of ['OPEN', 'CLOSE', 'ADD', 'TRIM', 'LEG_OFF'] as const) {
  for (const strategy of ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS'] as const) {
    const canonical = {
      action, symbol: 'SPY', direction: 'LONG' as const, strategy,
      ...(action === 'LEG_OFF' ? { targetStrategy: 'CALL' as const } : {}),
    };
    const result = normalizeSignal(canonical as LLMSignal);
    expect(result.action).toBe(action);
    expect(result.strategy).toBe(strategy);
  }
}
```

### 5d. Test run checksum (manual / CI-only)

For the full regression gate, run the backtest on a fixed dataset of ~50 real
historical messages and record:
- Total trade count
- Win rate
- Total PnL

Store as a JSON fixture in `src/backtest/__snapshots__/regression-baseline.json`.
After the redesign, re-run and diff. Any divergence requires explanation.

This test should NOT be in the default `vitest` run (it requires Databento cache
and is slow). Mark it with `test.skip` and run manually before merging.

---

## Part 6: Test Implementation Order

**Phase A — Before any production code changes** (baseline):
1. Add `normalizeSignal` unit tests (Part 3) — they will fail until the function
   exists.
2. Capture the regression baseline snapshot (Part 5d).

**Phase B — During production code changes**:
3. Update `test-fixtures.ts` as described (Part 2).
4. Update `arbStrategy` if `computeTradePnl` signature is narrowed.
5. Run all existing tests — they should remain green throughout.

**Phase C — After production code changes**:
6. Add integration tests (Part 4a, 4b).
7. Run the regression snapshot (Part 5d) and verify it matches baseline.
8. All tests green → ready to merge.

---

## Part 7: Summary of Files to Create or Modify

### New test files
- `src/agent/normalize-signal.test.ts` — pure unit tests for normalizeSignal()
- `src/backtest/regression.test.ts` — deterministic mini-backtest snapshot
- `src/pipeline/execute-with-normalize.test.ts` — integration: LLM alias → DB

### Modified test files
- `src/backtest/test-fixtures.ts`
  - Narrow `arbStrategy` to valid Strategy enum values (if computeTradePnl is narrowed)
  - Narrow `InsertOpenTradeParams.strategy` to `Strategy` type
  - Update `CREATE_TRADES_SQL` DDL if schema adds CHECK constraints
- `src/tasks/factory.test.ts`
  - Update `actionHint`/`directionHint` fixture types if Message schema changes
- `src/backtest/sim-broker-db.test.ts`
  - Replace `strategy: 'CALL_SPREAD'` with `strategy: 'CDS'` in option fixtures
    (if `CALL_SPREAD` is removed from valid strategy values)
  - Confirm `'IRON_CONDOR'` stays valid or is renamed in sweep tests

### Files with NO changes needed
- `src/backtest/runner-filter.test.ts` — filter predicate, no signal types
- `src/backtest/sim-broker.test.ts` — fill mechanics only
- `src/backtest/sim-broker-pnl.test.ts` — PnL math, string literals still valid
- `src/backtest/sim-broker-temporal.test.ts` — temporal props, no Signal flow
- `src/orders/order-manager.test.ts` — order lifecycle, no Signal
- `src/lib/*.test.ts` — pure utilities
- `src/backtest/margin-model.test.ts`, `occ-symbology.test.ts`,
  `extended-metrics.test.ts`, `equity-curve.test.ts`, `report.test.ts`

---

## Part 8: Key Risks and Watch-Outs

1. **`IRON_CONDOR` and `CALL_SPREAD`** are used in `test-fixtures.ts` and DB
   tests but are NOT in the current `StrategySchema` enum. The type-designer
   must clarify whether these are added to the enum or renamed. Until that's
   resolved, the DB test fixtures for sweepExpired and spread tests will
   break if the enum is enforced at compile time.

2. **`computeTradePnl` strategy parameter** is currently `string`. If it is
   narrowed to `Strategy`, the `arbStrategy` in test-fixtures.ts must be updated
   immediately — otherwise sim-broker.test.ts property tests fail at compile time.

3. **`Message.actionHint` and `directionHint`** — if these DB columns migrate
   from `TEXT` to enum-constrained columns, the in-memory DDL in
   `CREATE_MESSAGES_SQL` (test-fixtures.ts) must be updated. Otherwise
   factory.test.ts will silently store invalid values.

4. **`normalizeSignal` must be a pure function** (no I/O, no side effects).
   This makes it easily testable without DB setup. Any logic that requires
   broker calls (e.g., leg inference) must stay in the pipeline, not the
   normalizer.

5. **Idempotence is a contract** — `normalizeSignal(normalizeSignal(x))` must
   equal `normalizeSignal(x)`. Property tests enforce this. Violations indicate
   that the function is doing more than alias translation.
