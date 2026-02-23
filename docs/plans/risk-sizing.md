# Risk & Position Sizing

## The Simple Version

We copy trades from multiple traders into one portfolio. Right now every trade is sized like it's the only trade in the world. The system doesn't know how much total risk is on, doesn't care if three traders all pile into NVDA, and counts a 30% unrealized loss as "fine" because nobody closed anything yet.

This plan makes the portfolio aware of itself.

---

## What's Actually Wrong

**Sizing is blind.** ATR sizer says "risk 5% per trade" but never asks "how much risk is already on?" 5% x 20 positions = 100% of equity at theoretical risk. Nobody tracks the sum.

**Drawdown ignores open losses.** The circuit breaker only counts closed PnL (`getDailyClosedPnl` in `risk-check.ts:70-75`). You can be bleeding 30% on open positions and the system happily opens more.

**No concentration awareness.** `maxOnSymbol=3` counts positions, not dollars. Three 1-contract positions and three 20-contract positions are treated the same. Three traders can each put $50k into AAPL with no aggregate check.

**Live path has no max quantity.** Backtest caps options at 20 contracts (`runner.ts:164-166`). Live doesn't pass `maxQuantity` to the sizer (`tasks/runner.ts:244-249`). Options could size to 100+ contracts in production.

**Risk enforcement is split across two layers.** TradeAgent calls `checkRiskLimits()` (`trade-agent.ts:94-103`), then the pipeline calls it again (`execute.ts:322-330`). Backtest hacks around the duplication with a no-op (`runner.ts:246-250`). Live runs both (redundant). Adding new checks means updating two places or accepting divergence.

**Defaults are hardcoded in 5+ places.** Risk limits appear in `backtest/runner.ts:186-191`, `tasks/runner.ts:27-32`, `tasks/runner.ts:156-159`, plus form placeholders and schema comments. `maxOnSymbol` is 3 in backtest and 5 in live. Change one, forget the others.

**Dead code in the hot path.** Pipeline calls `checkRiskLimits()` for CLOSE/TRIM actions (`execute.ts:390-396`, `551-557`) which always return `allowed: true`. `shouldSkipSignal()` runs in both the agent and the pipeline (`execute.ts:699-702`). `onBacktestEnd` on TradeAgent (`trade-agent.ts:139-142`) is never called.

~~**Stale balance after auto-closes.**~~ VERIFIED FALSE. `closePositionAtPrice()` already sets `balanceCache = null` (`sim-broker.ts:439`). Both `sweepExpired` and `forceCloseAll` call it. Not a real bug.

---

## Architecture Decision: Pipeline-Only Risk

**All risk enforcement moves to the pipeline layer.** This is the single most important structural change.

### Why

1. The pipeline is the universal chokepoint. Every signal passes through `executeSignal()` in both backtest and live. Risk checks here are impossible to bypass.

2. Live already works this way. The live task runner enforces risk only at the pipeline layer via `pipelineDeps.checkRiskLimits`. We're making backtest consistent.

3. The agent layer becomes purely advisory. Deterministic skips (`shouldSkipDeterministic`) stay as a cheap pre-filter (saves LLM calls in live, avoids sizing work in backtest). But they're not a security boundary.

### What Changes

```
BEFORE (backtest):
  Message -> TradeAgent.onSignal():
    1. shouldSkipDeterministic()         // cheap pre-filter
    2. shouldSkipSignal()                // strategy gate
    3. checkRiskLimits()                 // REAL CHECK (trade-agent.ts:94)
    4. calculateSize()
  -> Pipeline.executeOpen():
    5. shouldSkipSignal()                // DUPLICATE of #2
    6. calculatePositionSize()           // DUPLICATE of #4
    7. checkRiskLimits() => NO-OP        // DEAD CODE (runner.ts:246)
    8. placeOrder()

AFTER (both paths):
  Message -> TradeAgent.onSignal():
    1. shouldSkipDeterministic()         // cheap pre-filter (kept)
    2. calculateSize()                   // preview for order
  -> Pipeline.executeOpen():
    3. checkRiskLimits()                 // THE check (heat + drawdown + concentration)
    4. calculatePositionSize(ddMultiplier) // sizing with drawdown scaling
    5. placeOrder()
```

**Deleted:** Risk check from TradeAgent (11 lines), no-op lambda from backtest runner (5 lines), duplicate `shouldSkipSignal` from pipeline (5 lines), redundant CLOSE/TRIM risk checks from pipeline (16 lines), dead `onBacktestEnd` + `PortfolioState` (11 lines). **Total: 48 lines.**

**Added:** Real `checkRiskLimits` wiring in backtest `pipelineDeps` (12 lines). **Net: -36 lines.**

---

## Where We're Going

The portfolio gets three self-regulating properties:

1. **Risk budget (heat)** — total risk across all positions is tracked and capped as % of equity. When the budget is full, new trades are blocked. This is a GATE.

2. **Graduated drawdown** — instead of binary go/stop at 5%, sizes scale: 3% DD = 0.5x, 5% DD = 0.25x, 8% DD = 0x (locked). Uses realized + unrealized PnL. This is a SCALER.

3. **Concentration limits** — no single underlying exceeds 15% of equity in dollar-weighted notional. This is a GATE.

Gates and scalers stack. During a drawdown with high heat, sizes shrink AND new trades can be blocked.

---

## Roadmap

### Phase 1: Bug Fixes & Dead Code (net -10 lines)

Fix live trading risks and clean house. Zero behavioral change (except MAX_CONTRACTS in live).

| What | Files | Lines Deleted | Lines Added |
|------|-------|---------------|-------------|
| Add MAX_CONTRACTS cap to live path | `tasks/runner.ts` | 0 | +2 |
| Centralize risk defaults into `src/config/risk-defaults.ts` | 8 files | -15 | +19 |
| Delete dead `onBacktestEnd` + `PortfolioState` | `trade-agent.ts` | -11 | 0 |
| Delete redundant CLOSE/TRIM risk checks in pipeline | `execute.ts` | -16 | 0 |
| Delete duplicate `shouldSkipSignal` in pipeline | `execute.ts` | -5 | 0 |
| Zod validation on backtest config | `launch.ts` or `types.ts` | 0 | +16 |
| **Phase 1 Total** | | **-47** | **+37 = -10 net** |

#### Centralized Config File

New `src/config/risk-defaults.ts` (~55 lines) exports everything:

```typescript
import type { RiskCheckConfig } from '../orders/risk-check.js';

export const BACKTEST_RISK_DEFAULTS: RiskCheckConfig = {
  maxOnSymbol: 3,
  maxTotalPositions: 20,
  maxDrawdownPct: 5,            // replaced by tiers in Phase 2
  maxNotionalMultiplier: 2,
};

export const LIVE_RISK_DEFAULTS: RiskCheckConfig = {
  maxOnSymbol: 5,               // intentionally higher for live
  maxTotalPositions: 20,
  maxDrawdownPct: 5,
  maxNotionalMultiplier: 2,
};

export const DEFAULT_SIZING_CONFIG = {
  strategy: 'atr' as const,
  riskPercent: 0.05,
  atrMultiplier: 2.0,
  atrPeriod: 14,
};

export const ATR_FALLBACK_FACTOR = 0.02;

export const MAX_CONTRACTS: Record<string, number> = {
  CALL: 20, PUT: 20, CDS: 20, PDS: 20,
};

export const DEFAULT_STARTING_EQUITY = 100_000;
export const DEFAULT_FILL_MODEL = 'orats' as const;
export const DEFAULT_COMMISSION_SCHEDULE = {
  option: { perContract: 0.50 },
  stock: { perShare: 0.00 },
} as const;
```

Consumers that change: `backtest/runner.ts`, `tasks/runner.ts`, `position-sizing/index.ts`, `position-sizing/atr.ts`, `backtest/report.ts`, `backtest/sim-broker.ts`, `backtest/launch.ts`, `web/app/backtests/new/backtest-form.tsx`.

#### MAX_CONTRACTS Fix (Live)

```typescript
// tasks/runner.ts — inside calculatePositionSize callback
import { MAX_CONTRACTS } from '../config/risk-defaults.js';

return await sizer.calculateSize({
  ...existingParams,
  maxQuantity: MAX_CONTRACTS[input.strategy],  // <-- add this line
});
```

---

### Phase 2: Portfolio Awareness (net +11 lines)

Three new features + single-layer consolidation. The consolidation pays for all three features.

| What | Files | Lines Deleted | Lines Added |
|------|-------|---------------|-------------|
| Single-layer risk (move to pipeline) | `trade-agent.ts`, `runner.ts`, `execute.ts` | -47 | +12 |
| Graduated drawdown tiers | `risk-check.ts` | -10 | +20 |
| Portfolio heat tracking | `risk-check.ts`, `schema.ts`, `execute.ts` | 0 | +23 |
| Concentration cap (15% per underlying) | `risk-check.ts` | 0 | +13 |
| **Phase 2 Total** | | **-57** | **+68 = +11 net** |

**Phases 1+2 combined: +1 line net.** Three new risk features, architectural cleanup, and bug fixes for the cost of one line of code.

---

### Phase 3: Smart Allocation (net +70 lines, later)

| What | Lines Added |
|------|-------------|
| Per-trader allocation budgets | ~30 |
| Cross-trader conflict detection (logging-only first) | ~5 (full version: ~25) |
| Portfolio-aware heat scaling multiplier | ~15 |
| **Phase 3 Total** | **~50-70** |

Ship conflict detection as logging-only (5 lines) unless data shows it's common enough to warrant blocking logic.

### Future (Not Now)

Greeks aggregation, sector concentration, correlation-aware sizing, VaR/stress testing. Only matters at >30 positions or >$500k equity. `RiskCheckDeps` is the extension point.

---

## Type Definitions

### RiskCheckConfig (extended)

```typescript
export type DrawdownTier = {
  pct: number;            // threshold (e.g., 3 = 3% drawdown)
  sizeMultiplier: number; // 0.0 = blocked, 0.5 = half size, 1.0 = full
};

export type RiskCheckConfig = {
  // --- Existing ---
  maxOnSymbol: number;
  maxTotalPositions: number;
  maxNotionalMultiplier: number;

  // --- REPLACED (Phase 2) ---
  // maxDrawdownPct: number;          // OLD: binary cutoff
  drawdownTiers: DrawdownTier[];      // NEW: graduated response
  useUnrealizedDrawdown: boolean;     // include unrealized PnL (default: true)

  // --- NEW (Phase 2) ---
  maxPortfolioHeatPct: number;        // e.g., 20 = 20% of equity at risk
  maxConcentrationPct: number;        // e.g., 15 = 15% max per underlying
};
```

Default tiers:
```typescript
const DEFAULT_DRAWDOWN_TIERS: DrawdownTier[] = [
  { pct: 0,  sizeMultiplier: 1.00 },  // 0-3%:  full size
  { pct: 3,  sizeMultiplier: 0.50 },  // 3-5%:  half size
  { pct: 5,  sizeMultiplier: 0.25 },  // 5-8%:  quarter size
  { pct: 8,  sizeMultiplier: 0.00 },  // 8%+:   locked out
];
```

### RiskCheckDeps (one new callback)

```typescript
export type RiskCheckDeps = {
  // --- Existing ---
  getOpenTrades: (filters?: PositionFilters) => Promise<Trade[]>;
  getDailyClosedPnl: () => Promise<number>;
  getStartingEquity: () => Promise<number | null>;
  getCurrentEquity: () => Promise<number>;
  getReconciliationAlertCount?: () => Promise<number>;

  // --- NEW (Phase 2) ---
  getUnrealizedPnl: () => Promise<number>;
};
```

Backtest wires `getUnrealizedPnl` via SimBroker (already has the data). Live wires it via `liveService.getAccountBalance().unrealizedPnl`.

### RiskCheckResult (extended)

```typescript
export type RiskCheckResult = {
  allowed: boolean;
  reason?: string;

  // --- Existing ---
  dailyPnl: number;
  openPositionsOnSymbol: number;
  totalOpenPositions: number;
  maxTotalPositions: number;
  startingEquity?: number;
  totalNotional: number;
  maxNotional: number;
  reconciliationAlerts?: number;

  // --- NEW (Phase 2) ---
  drawdownPct?: number;               // realized + unrealized drawdown
  drawdownSizeMultiplier?: number;    // tier multiplier (1.0 = full, 0.0 = blocked)
  portfolioHeatPct?: number;          // current total risk / equity
  concentrationPct?: number;          // highest per-underlying notional / equity
  concentrationSymbol?: string;       // which symbol hit the limit
};
```

### PipelineDeps: NO CHANGES

All three new features are implemented inside `checkRiskLimits()`, which is already a `PipelineDeps` callback. The abstraction is correct as-is.

One small pipeline change: `executeOpen()` reads `risk.drawdownSizeMultiplier` and passes it to `calculatePositionSize`:

```typescript
// execute.ts — after risk check, before sizing
const ddMult = risk.drawdownSizeMultiplier ?? 1.0;
// ... pass to sizer or apply after: qty = Math.max(1, Math.floor(baseQty * ddMult))
```

---

## The Math

### Portfolio Heat

```
riskPerUnit = ATR × atrMultiplier           (stocks)
            = entryPrice                     (long options, debit spreads — max loss = premium)
            = spreadWidth - entryPrice       (credit spreads — max loss = width minus credit)

riskDollars = riskPerUnit × quantity × contractMultiplier(strategy)
portfolioHeat = SUM(riskDollars_i) / equity
```

Default `maxPortfolioHeatPct: 20`. With $100k equity and $2k risk per position (2% of equity), ~10 positions fill the budget. Replaces the blunt `maxTotalPositions` count.

`riskPerUnit` is stored on trades at open time (new column). For legacy trades without it, fallback: `entryPrice × ATR_FALLBACK_FACTOR × atrMultiplier`.

### Graduated Drawdown

```
totalPnl = closedPnl(today) + unrealizedPnl(openPositions)
drawdownPct = abs(min(0, totalPnl)) / startingEquity × 100
sizeMultiplier = lookup(drawdownPct, tiers)   // walk tiers descending, first match
```

Examples: 2% DD = 1.0x (full), 3.5% DD = 0.5x (half), 6% DD = 0.25x (quarter), 10% DD = 0.0x (locked).

When `sizeMultiplier === 0.0`, `checkRiskLimits` returns `allowed: false`.

### Concentration

```
symbolNotional = SUM(entryPrice × quantity × contractMultiplier) for open trades on this underlying
concentrationPct = symbolNotional / equity × 100
blocked = concentrationPct >= maxConcentrationPct
```

Uses premium-based notional for options (consistent with existing notional cap). Cross-trader: portfolio-wide, not per-trader.

### Stacking

```
1. checkRiskLimits():
     position count checks     → GATE (maxOnSymbol, maxTotalPositions)
     reconciliation alerts     → GATE (live only)
     concentration check       → GATE (per-underlying notional / equity)
     portfolio heat check      → GATE (total risk / equity)
     notional leverage check   → GATE (total notional / equity)
     graduated drawdown        → SCALER (returns sizeMultiplier 0.0-1.0)

2. calculatePositionSize():
     baseQty = ATR sizer
     finalQty = max(1, floor(baseQty × drawdownSizeMultiplier))

3. placeOrder(finalQty)
```

Gates run first (cheapest, fail-fast). Drawdown returns last because it produces the multiplier that feeds into sizing. If `sizeMultiplier === 0.0`, the gate returns `allowed: false` — no sizing needed.

---

## Schema Changes

### trades table

```sql
ALTER TABLE trades ADD COLUMN risk_per_unit TEXT;  -- numeric stored as text (existing pattern)
```

- Set during OPEN via `recordTrade()` (passed from `PositionSize.effectiveRisk`)
- Read during heat computation: `riskDollars = riskPerUnit × qty × contractMultiplier`
- NULL for legacy trades (use fallback estimate)

### BacktestRunConfig

```typescript
maxHeat?: number;                    // default: 0.20 (20%)
drawdownTiers?: DrawdownTier[];      // default: DEFAULT_DRAWDOWN_TIERS
maxConcentrationPct?: number;        // default: 15
```

### BacktestRunSummary

```typescript
heatBlockedCount?: number;
concentrationBlockedCount?: number;
maxHeatReached?: number;             // peak heat during run (0.0-1.0)
```

---

## Composition Order Within checkRiskLimits()

```
1. Position-reducing? (CLOSE/TRIM/LEG_OFF) → always allowed, early return
2. Position count: maxOnSymbol, maxTotalPositions
3. Reconciliation alerts (live only)
4. Concentration: per-underlying notional cap
5. Portfolio heat: total risk budget
6. Notional leverage: total notional / equity
7. Graduated drawdown: compute sizeMultiplier (0.0 = block)
```

Steps 2-6 are binary BLOCK. Step 7 is a SCALER that may also block (at the 0.0 tier). Result includes all diagnostics regardless of which check blocked.

---

## Backtest/Live Parity Constraints

All new risk logic is in **shared code** consumed by both paths:

| Shared (single implementation) | Path-Specific (correct divergence) |
|---|---|
| `checkRiskLimits()` in `risk-check.ts` | `SimBroker.sweepExpired()` — backtest only |
| `RiskCheckConfig` / `RiskCheckDeps` / `RiskCheckResult` | `getReconciliationAlertCount` — live only |
| `buildPositionSizer()` + ATR sizer | `SimBroker.getAccountBalance()` vs `liveService.getAccountBalance()` |
| `recordTrade()` — single write path | `captureStartingBalance()` — live only |
| `MAX_CONTRACTS` — shared constant | `maxOnSymbol` defaults: 3 backtest, 5 live (intentional) |
| `executeSignals()` / `executeOpen()` | |

**Hard rule:** New risk checks are callbacks on `RiskCheckDeps`, wired by each runner. No path-specific risk logic.

### Data sources per path

| Dep | Backtest | Live |
|-----|----------|------|
| `getOpenTrades` | `SimBroker.getOpenTrades()` | DB query (isOpen, notBacktest) |
| `getDailyClosedPnl` | DB query (closed today, forRun) | DB query (closed today, notBacktest) |
| `getStartingEquity` | Config value (e.g., 100000) | `dailyBalances` table |
| `getCurrentEquity` | `SimBroker.getAccountBalance().equity` | `liveService.getAccountBalance().equity` |
| `getUnrealizedPnl` | `SimBroker.getUnrealizedPnl()` | `liveService.getAccountBalance().unrealizedPnl` |

---

## Edge Cases

**Equity is 0 or negative:** Heat returns 1.0 (100%) = blocks all trades. Concentration returns Infinity% = blocks. Drawdown with 0 starting equity returns multiplier 1.0 (avoid div-by-zero, not meaningful).

**Drawdown multiplier produces fractional qty:** `floor()` rounds down. `floor(3 × 0.25) = 0` = trade blocked. We do NOT round up to 1 — that would violate the risk budget. This naturally locks out expensive underlyings (SPX, base qty=1) before cheap ones (AAPL, base qty=20) during drawdowns. Correct behavior: if you can't afford a full unit at reduced risk, don't trade it.

**Same underlying, different strategies:** Both count toward the same underlying's concentration. Each has independent heat entries. AAPL stock + AAPL calls = both contribute to AAPL concentration.

**Legacy trades without riskPerUnit:** Fallback is strategy-aware. Stocks: `entryPrice × ATR_FALLBACK_FACTOR × atrMultiplier` (e.g., $200 stock = $8 risk estimate). Long options/debit spreads: `entryPrice` (max loss = premium paid, e.g., $2.50 option = $2.50 risk). Credit spreads: `spreadWidth - entryPrice`. Using the stock formula for options would produce absurdly low estimates ($2.50 × 0.02 × 2.0 = $0.10).

**disableRiskLimits (backtest A/B testing):** Moves from TradeAgent config to PipelineDeps. When true, `executeOpen()` skips `checkRiskLimits()` and uses `drawdownSizeMultiplier = 1.0`.

---

## Implementation Order

1. **Phase 1a: Dead code + centralized config** — delete dead exports, no-op risk checks, duplicate calls. Create `risk-defaults.ts`, update consumers. NET: -10 lines.

2. **Phase 1b: MAX_CONTRACTS in live** — 2-line fix in `tasks/runner.ts`. Ship immediately.

3. **Phase 1c: Zod validation** — add schema for `BacktestRunConfig`. Prevents garbage input.

4. **Phase 2a: Single-layer consolidation** — delete risk from TradeAgent, activate pipeline risk check in backtest. Wire `riskDeps` into `pipelineDeps` instead of agent config. NET: -35 lines.

5. **Phase 2b: Schema + riskPerUnit** — add column, thread through `recordTrade()` OPEN path, expose from `PositionSize`.

6. **Phase 2c: Graduated drawdown** — replace binary check in `risk-check.ts` with tier lookup. Wire `getUnrealizedPnl` dep. Return `drawdownSizeMultiplier` in result. Apply in `executeOpen()`.

7. **Phase 2d: Portfolio heat** — add heat calculation to `checkRiskLimits`. Read `riskPerUnit` from open trades.

8. **Phase 2e: Concentration cap** — add per-underlying notional check to `checkRiskLimits`.

Each step is independently testable and backward-compatible. Run backtests after each Phase 2 step for before/after comparison.

---

## Code Impact Summary

| Phase | Deleted | Added | Net | What You Get |
|-------|---------|-------|-----|--------------|
| Phase 1 | 47 | 37 | **-10** | Bug fixes, dead code removal, centralized config |
| Phase 2 | 57 | 68 | **+11** | 3 new risk features + architectural cleanup |
| **1+2** | **104** | **105** | **+1** | Everything above for 1 net line of code |
| Phase 3 | 0 | ~50-70 | +50-70 | Per-trader budgets, conflict detection |

---

## Signal Redesign Compatibility

The signal redesign changes the parsing layer (how messages become signals). All risk/sizing work is in the execution layer below it. Different layers, no shared code. Safe to do in parallel.

---

## Success Looks Like

- Backtest max drawdown improves >15% vs baseline
- No underlying exceeds 15% of equity in any run
- Position sizes visibly decrease during drawdown (in logs)
- Live and backtest enforce identical controls via shared `checkRiskLimits()`
- All existing tests still pass
- Phase 1+2 combined: net +1 line of code
- Zero path-specific risk logic (all in shared `risk-check.ts`)
