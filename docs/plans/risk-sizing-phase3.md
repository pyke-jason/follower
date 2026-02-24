# Risk Sizing — Phase 3 Implementation Plan

Consensus plan from 3-agent investigation (2026-02-23).

---

## What Phase 3 Delivers

Per-trader budget isolation + conflict detection + heat-aware scaling, built on the Phase 2 `checkRiskLimits()` infrastructure:

1. **Per-trader equity allocation** — divide portfolio equity among traders by percentage
2. **Conflict detection** — log when multiple traders enter opposing positions on the same underlying
3. **Heat-aware scaling** — reduce size as portfolio heat approaches the cap (smooth ramp, not hard gate)

~65 lines of backend code. Lightweight frontend additions.

---

## Current State (from investigation)

**Key finding**: `input.trader` already flows through the entire pipeline into `checkRiskLimits()` but is **completely unused** there. This is the natural extension point.

- One shared `TradeAgent` per backtest run (not per-trader) — `runner.ts:178`
- Position sizing uses shared equity, not per-trader — `atr.ts` gets `equity` from `getCurrentEquity()`
- `maxOnSymbol` is portfolio-wide (counts all traders' positions on a symbol)
- No per-trader state exists anywhere in the current codebase

---

## Implementation Order

### Step 1: Per-trader equity allocation

**Config type** (`BacktestRunConfig` in `src/db/schema.ts`):
```typescript
traderAllocations?: Record<string, number>;  // e.g. { "pete": 0.40, "hari": 0.35, "dave": 0.25 }
```

Default when absent: equal split among active traders. No new table/column needed — config JSON suffices.

**`src/orders/risk-check.ts`** — add to `RiskCheckConfig`:
```typescript
traderAllocation?: number;  // fraction 0.0-1.0, default: 1.0 (no isolation)
```

**In `checkRiskLimits()`** — compute effective equity:
```typescript
const rawEquity = await deps.getCurrentEquity();
const effectiveEquity = rawEquity * (config.traderAllocation ?? 1.0);
```

Use `effectiveEquity` for:
- Notional leverage cap: `maxNotional = effectiveEquity * config.maxNotionalMultiplier`
- Drawdown: use trader's PnL share vs their allocated equity
- Heat: trader's open risk / their allocated equity
- Concentration: trader's underlying exposure / their allocated equity

**Wiring** (`src/backtest/runner.ts`):
```typescript
const traderAlloc = config.traderAllocations?.[msg.trader]
  ?? (1 / activeTraderCount);  // equal split fallback
// Pass traderAllocation into riskConfig per message
```

**~30 lines total** across risk-check.ts and runner.ts.

---

### Step 2: Conflict detection (log-only)

Detect when two traders take opposing positions on the same underlying. Log-only — no blocking.

**In `checkRiskLimits()`** after fetching `allOpen`:
```typescript
const underlying = extractUnderlying(input.symbol);
const conflicting = allOpen.filter(t =>
  t.trader !== input.trader
  && extractUnderlying(t.symbol) === underlying
  && t.direction !== input.direction
);
if (conflicting.length > 0) {
  log.info('Conflict detected: %s %s %s vs %s open %s positions on %s',
    input.trader, input.direction, input.symbol,
    conflicting[0].trader, conflicting[0].direction, underlying);
}
```

Add to `RiskCheckResult`:
```typescript
conflictDetected?: boolean;
conflictWith?: string;  // trader name
```

**Summary type** (`BacktestRunSummary`):
```typescript
conflictCount?: number;
```

**~5 lines** in checkRiskLimits, ~3 lines counter in runner.

---

### Step 3: Heat-aware scaling (SCALER)

Instead of the Phase 2 hard gate at `maxPortfolioHeatPct`, add a smooth ramp-down as heat approaches the cap. The gate still blocks at 100% of cap.

**In `checkRiskLimits()`** after computing `portfolioHeatPct` (Phase 2 Step 5):
```typescript
let heatSizeMultiplier = 1.0;
if (portfolioHeatPct >= config.maxPortfolioHeatPct) {
  heatSizeMultiplier = 0.0;  // hard block at cap (existing gate)
} else if (portfolioHeatPct >= config.maxPortfolioHeatPct * 0.7) {
  // Linear ramp: 70-100% of cap → 1.0 → 0.0 multiplier
  const pctOfCap = portfolioHeatPct / config.maxPortfolioHeatPct;
  heatSizeMultiplier = Math.max(0, (1.0 - pctOfCap) / 0.3);
}
```

Add `heatSizeMultiplier` to `RiskCheckResult`.

**Apply in `executeOpen()`** — combine with drawdown multiplier:
```typescript
const combinedMult = Math.min(
  risk.drawdownSizeMultiplier ?? 1.0,
  risk.heatSizeMultiplier ?? 1.0,
);
const finalQty = combinedMult < 1.0 ? Math.floor(size.quantity * combinedMult) : size.quantity;
```

**~15 lines** in risk-check.ts, ~2 lines changed in execute.ts.

---

## Composition Order in `checkRiskLimits()` (Phase 3 final)

```
1. Position-reducing (CLOSE/TRIM/LEG_OFF) → always allowed, early return
2. Fetch: allOpen, equity, startingEquity (parallel)
3. Compute effectiveEquity = equity × traderAllocation
4. Position count: maxOnSymbol, maxTotalPositions       (GATE)
5. Reconciliation alerts (live only)                    (GATE)
6. Conflict detection: log opposing positions            (LOG-ONLY)
7. Concentration: per-underlying notional / effectiveEquity  (GATE)
8. Portfolio heat: total riskDollars / effectiveEquity       (GATE + SCALER)
9. Notional leverage: totalNotional / effectiveEquity        (GATE)
10. Graduated drawdown: compute sizeMultiplier               (SCALER)
```

---

## Frontend Changes

1. **Backtest form** — Trader Allocation section: text inputs for each known trader (pre-populated from trader list). Format: `trader: X%`. Sum must equal 100%. Skip if only 1 trader.

2. **Info bar** — Show `3 conflicts · heat scaled 12 trades` (non-zero only, text-xs muted). Budget usage per trader: `pete 87% · hari 62% · dave 45%`.

3. **Expanded row** (TradeStoryExpander) — Show heat multiplier if < 1.0: `Heat scaled: 0.7x`. Show conflict badge if `conflictDetected`.

4. **Trade detail page** — Conflict info in sidebar if present.

---

## Files Modified

| File | Change |
|------|--------|
| `src/db/schema.ts` | `traderAllocations` in `BacktestRunConfig`, `conflictCount` in `BacktestRunSummary` |
| `src/orders/risk-check.ts` | `traderAllocation` in Config, `effectiveEquity` computation, conflict detection, `heatSizeMultiplier` |
| `src/config/risk-defaults.ts` | Default allocation (1.0 = no isolation) |
| `src/pipeline/execute.ts` | Combine `heatSizeMultiplier` with `drawdownSizeMultiplier` |
| `src/backtest/runner.ts` | Compute per-trader allocation, pass to risk config, track conflict counter |
| `src/tasks/runner.ts` | Same allocation wiring for live path |

---

## Dependencies

Phase 3 requires Phase 2 to be implemented first:
- `portfolioHeatPct` computation (Step 5)
- `drawdownSizeMultiplier` (Step 4)
- `extractUnderlying()` helper (Step 6)
- `riskPerUnit` column for accurate heat (Step 1-2)

---

## Test Strategy

1. **Unit**: `checkRiskLimits` with 40% allocation → effective equity is 40% of total → caps scale accordingly
2. **Unit**: Conflict detection — two traders opposite directions on same underlying → `conflictDetected: true`
3. **Unit**: Heat scaler — heat at 50% of cap → mult=1.0, at 85% → mult≈0.5, at 100% → mult=0.0
4. **Unit**: Combined multipliers — min(drawdown=0.5, heat=0.7) = 0.5
5. **Integration**: 3-trader backtest with allocations — each trader's risk capped independently
6. **Integration**: Verify conflict counter in run summary matches actual opposing positions

---

## Key Decisions (consensus)

| Decision | Resolution | Why |
|----------|-----------|-----|
| Per-trader allocation storage | **Config JSON** (not new table) | Config-level setting, no per-trade column needed |
| Conflict action | **Log-only, no blocking** | Traders may intentionally hedge; blocking creates false negatives |
| Heat scaling shape | **Linear ramp 70-100% of cap** | Simple, predictable. Exponential adds no practical benefit |
| Per-trader drawdown? | **No — keep portfolio-wide** | Individual trader drawdown tracking needs per-trader PnL accounting (complex). Defer. |
| Position limits per-trader? | **No — keep portfolio-wide** | `maxOnSymbol` protects against concentration regardless of trader. Per-trader limits double-count. |
| `effectiveEquity` scope | **Risk checks only** | Position sizing still uses full equity — the allocation only constrains risk gates |
