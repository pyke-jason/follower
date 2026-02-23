# Risk Sizing — Phase 2 Implementation Plan

Consensus plan from 4-agent investigation (2026-02-23).

---

## What Phase 2 Delivers

Three new risk features + sizing metadata storage, built on the shared `checkRiskLimits()` function:

1. **Store sizing metadata** — persist `riskPerUnit` (ATR x multiplier) on trades at open time
2. **Graduated drawdown** — replace binary 5% cutoff with tiered scaling (SCALER)
3. **Portfolio heat** — total risk dollars / equity, capped at 20% (GATE)
4. **Concentration cap** — per-underlying notional / equity, capped at 15% (GATE)

All features are in shared code. Zero path-specific risk logic.

---

## Implementation Order

### Step 1: Schema — add `risk_per_unit` column

**Why column, not metadata JSON**: Heat calculation needs `SUM(riskPerUnit * qty * mult)` across all open trades. Drizzle can't aggregate inside JSON cleanly. A column follows the existing `entryPrice`/`pnl`/`realizedPnl` TEXT pattern.

**File: `src/db/schema.ts:121`** — after `realizedPnl`:
```typescript
riskPerUnit:     text('risk_per_unit'),  // ATR × atrMultiplier (stocks) or entryPrice (options). Null for legacy.
```

**Migration**: `ALTER TABLE trades ADD COLUMN risk_per_unit TEXT;`

**Config type additions** (`BacktestRunConfig`):
```typescript
drawdownTiers?: DrawdownTier[];       // default: DEFAULT_DRAWDOWN_TIERS
maxPortfolioHeatPct?: number;         // default: 0.20 (20%)
maxConcentrationPct?: number;         // default: 15
```
Remove `maxDrawdownPct` — replaced by tiers.

**Summary type additions** (`BacktestRunSummary`):
```typescript
heatBlockedCount?: number;
concentrationBlockedCount?: number;
drawdownScaledCount?: number;         // trades where ddMultiplier < 1.0
maxHeatReached?: number;              // peak heat fraction (0.0-1.0)
```

---

### Step 2: Thread `riskPerUnit` through pipeline → recordTrade

**Confirmed**: `PositionSize.effectiveRisk` = `ATR × atrMultiplier` = per-unit risk (`atr.ts:70-71`). Currently discarded in `execute.ts`.

**`src/trades/record-trade.ts`** — add to `RecordTradeInput`:
```typescript
riskPerUnit?: number;
```
OPEN path stores it: `riskPerUnit: input.riskPerUnit != null ? String(input.riskPerUnit) : null`

**`src/pipeline/execute.ts`** — in `executeOpen()` `buildRecordInput` closure (~line 363):
```typescript
riskPerUnit: size.effectiveRisk,
```

Also store `reasoning` string in metadata for the trade detail page:
```typescript
metadata: { ...existingMeta, sizingReasoning: size.reasoning }
```

Backtest/live parity: `executeOpen()` is shared — both paths get this automatically.

---

### Step 3: Add `getUnrealizedPnl` to `RiskCheckDeps`

**`src/orders/risk-check.ts`** — add to `RiskCheckDeps`:
```typescript
getUnrealizedPnl: () => Promise<number>;
```

**Backtest wiring** (`src/backtest/runner.ts`):
```typescript
getUnrealizedPnl: () => broker.getUnrealizedPnl(),
// SimBroker.getUnrealizedPnl() already exists at sim-broker.ts:446
```

**Live wiring** (`src/tasks/runner.ts`):
```typescript
getUnrealizedPnl: async () => (await liveService.getAccountBalance()).unrealizedPnl,
```

---

### Step 4: Graduated drawdown tiers

**Replace `maxDrawdownPct` with tier-based scaler.**

New types in `risk-check.ts`:
```typescript
export type DrawdownTier = { pct: number; sizeMultiplier: number };
```

Update `RiskCheckConfig` — remove `maxDrawdownPct`, add:
```typescript
drawdownTiers: DrawdownTier[];
useUnrealizedDrawdown: boolean;  // default: true
```

New constant in `risk-defaults.ts`:
```typescript
export const DEFAULT_DRAWDOWN_TIERS: DrawdownTier[] = [
  { pct: 0,  sizeMultiplier: 1.00 },  // 0-3%:  full size
  { pct: 3,  sizeMultiplier: 0.50 },  // 3-5%:  half size
  { pct: 5,  sizeMultiplier: 0.25 },  // 5-8%:  quarter size
  { pct: 8,  sizeMultiplier: 0.00 },  // 8%+:   locked out
];
```

Updated drawdown logic in `checkRiskLimits()`:
```typescript
const closedPnl = await deps.getDailyClosedPnl();
const unrealizedPnl = config.useUnrealizedDrawdown ? await deps.getUnrealizedPnl() : 0;
const totalPnl = closedPnl + unrealizedPnl;

let drawdownPct: number | undefined;
let drawdownSizeMultiplier = 1.0;

if (startingEquity != null && startingEquity > 0 && totalPnl < 0) {
  drawdownPct = Math.round((Math.abs(totalPnl) / startingEquity) * 10000) / 100;
  const sorted = [...config.drawdownTiers].sort((a, b) => b.pct - a.pct);
  for (const tier of sorted) {
    if (drawdownPct >= tier.pct) {
      drawdownSizeMultiplier = tier.sizeMultiplier;
      break;
    }
  }
}
```

Add `drawdownSizeMultiplier` and `drawdownPct` to `RiskCheckResult`.

**Apply in `executeOpen()`** (after risk check, before placeOrder):
```typescript
const ddMult = risk.drawdownSizeMultiplier ?? 1.0;
const finalQty = ddMult < 1.0 ? Math.floor(size.quantity * ddMult) : size.quantity;
if (finalQty <= 0) {
  return { signal, executed: false, reason: `Drawdown scaler (${ddMult}x) reduced qty to 0` };
}
// Use finalQty everywhere downstream
```

Same change in `executeAdd()`.

---

### Step 5: Portfolio heat (GATE)

**Add to `RiskCheckConfig`**: `maxPortfolioHeatPct: number` (default: 0.20)

Heat computation in `checkRiskLimits()`, using the `allOpen` array already fetched:
```typescript
const riskDollars = allOpen.reduce((sum, t) => {
  const rpu = safeParseFloat(t.riskPerUnit) || computeRiskPerUnitFallback(t);
  return sum + rpu * tradeQty(t.quantity) * contractMultiplier(t.strategy);
}, 0);
const portfolioHeatPct = equity > 0 ? riskDollars / equity : 1.0;
const heatBlocked = portfolioHeatPct >= config.maxPortfolioHeatPct;
```

**Legacy fallback** (trades without `riskPerUnit`):
```typescript
function computeRiskPerUnitFallback(t: Trade): number {
  const entry = safeParseFloat(t.entryPrice);
  if (t.strategy === 'STOCK') return entry * ATR_FALLBACK_FACTOR * 2.0;
  return entry;  // options: max loss = premium paid
}
```

Import `ATR_FALLBACK_FACTOR` from `risk-defaults.ts`. Add `portfolioHeatPct` to `RiskCheckResult`.

---

### Step 6: Concentration cap (GATE)

**Add to `RiskCheckConfig`**: `maxConcentrationPct: number` (default: 15)

Concentration check in `checkRiskLimits()`:
```typescript
const underlying = extractUnderlying(input.symbol);
const underlyingNotional = allOpen
  .filter(t => extractUnderlying(t.symbol) === underlying)
  .reduce((sum, t) => sum + notionalValue(t.entryPrice, t.quantity, t.strategy), 0);
const concentrationPct = equity > 0 ? (underlyingNotional / equity) * 100 : Infinity;
const concentrationBlocked = concentrationPct >= config.maxConcentrationPct;
```

`extractUnderlying()`: check if `occ-symbology.ts` has this already; if not, `symbol.split(/\s+|\d/)[0]`.

Uses `notionalValue()` from `src/lib/trade.ts` (already exists — we added it today).

Add `concentrationPct` and `concentrationSymbol` to `RiskCheckResult`.

---

## Composition Order in `checkRiskLimits()` (final)

```
1. Position-reducing (CLOSE/TRIM/LEG_OFF) → always allowed, early return
2. Fetch: allOpen, equity, startingEquity (parallel)
3. Position count: maxOnSymbol, maxTotalPositions       (GATE)
4. Reconciliation alerts (live only)                    (GATE)
5. Concentration: per-underlying notional / equity      (GATE)
6. Portfolio heat: total riskDollars / equity            (GATE)
7. Notional leverage: totalNotional / equity             (GATE, existing)
8. Graduated drawdown: compute sizeMultiplier            (SCALER, 0.0 = block)
```

Gates fail fast (steps 3-7). Scaler returns last for diagnostics.

---

## Frontend Changes (after backend lands)

1. **Backtest form** — add second row: Max Heat %, Max Concentration %, Risk %, ATR Multiplier. Keep Max DD % as the hard-lock tier (8%). Don't expose tier config in form yet.

2. **Info bar** — show `heat peak 14.2% · 3 heat-blocked · 2 conc-blocked` (non-zero only, text-xs muted)

3. **Trade detail page** — new "Sizing Rationale" card showing `metadata.sizingReasoning`, ATR, R-multiple (if closed). Only render when data present.

4. **DrawdownChart** — add horizontal reference lines at tier thresholds (3%, 5%, 8%). ~10 lines using Recharts `<ReferenceLine>`.

5. **Trades table** — NO new columns (already 14). R-multiple goes in the expanded row (TradeStoryExpander) if riskPerTrade is stored.

---

## Files Modified

| File | Change |
|------|--------|
| `src/db/schema.ts` | `risk_per_unit` column, config/summary type additions, remove `maxDrawdownPct` |
| `src/orders/risk-check.ts` | `DrawdownTier` type, updated Config/Deps/Result, graduated drawdown, heat, concentration |
| `src/config/risk-defaults.ts` | `DEFAULT_DRAWDOWN_TIERS`, updated defaults (remove `maxDrawdownPct`, add tiers/heat/concentration) |
| `src/trades/record-trade.ts` | `riskPerUnit` in `RecordTradeInput`, store on OPEN |
| `src/pipeline/execute.ts` | Pass `riskPerUnit` + `sizingReasoning` to recordTrade, apply `ddMultiplier` to qty |
| `src/backtest/runner.ts` | Wire `getUnrealizedPnl`, track heat/concentration/drawdown counters |
| `src/tasks/runner.ts` | Wire `getUnrealizedPnl` via liveService |
| Migration SQL | `ALTER TABLE trades ADD COLUMN risk_per_unit TEXT;` |

---

## Test Strategy

1. **Unit**: `checkRiskLimits` with mock deps — test each tier threshold, heat at/below/above cap, concentration at/below/above cap
2. **Unit**: `executeOpen` — ddMultiplier=0.5 halves qty, ddMultiplier=0.0 blocks
3. **Unit**: `recordTrade` OPEN stores riskPerUnit, CLOSE doesn't touch it
4. **Unit**: Fallback formula for legacy trades (NULL riskPerUnit)
5. **Integration**: Tight heat cap (5%) backtest — verify fewer trades, non-zero heatBlockedCount
6. **A/B**: Run same backtest with/without Phase 2 — max drawdown should improve >15%

---

## Key Decisions (consensus)

| Decision | Resolution | Why |
|----------|-----------|-----|
| Column vs metadata for riskPerUnit | **Column** (`risk_per_unit TEXT`) | Heat needs Drizzle-native aggregation across open trades |
| Store all PositionSize fields? | **Just effectiveRisk** as column + reasoning in metadata | Others derivable; reasoning is verbose |
| Remove maxDrawdownPct? | **Yes, replace with tiers** | No backwards compat needed (CLAUDE.md) |
| Tier config in backtest form? | **No — use code defaults** | Too complex for form; override via config if needed |
| New table columns? | **No** | Table already has 14 columns; use expanded row + detail page |
| Heat-over-time chart? | **Defer to Phase 3** | Needs per-day snapshots infrastructure |
| effectiveRisk = riskPerUnit? | **Yes** — ATR × atrMultiplier = per-unit risk | Confirmed at `atr.ts:70-71` |
