# Pre-Live Risk Audit: 2026-04-24

## Problem

Going live tomorrow. Backtest hit two margin calls despite finishing positive — meaning either sizing is too aggressive, the strategy survives by luck, or risk gates aren't tight enough. Goal: prevent account blow-up on day 1.

## Decision

Four code bugs fixed in this audit session. Four additional parameter/architecture gaps flagged for short-term follow-up.

## Key Files

- `src/config/risk-defaults.ts` — all default risk parameters
- `src/orders/risk-check.ts` — all gate logic; the single enforcement point
- `src/position-sizing/index.ts` — sizing formula (per-trade, pre-order)
- `src/pipeline/build-deps.ts` — wires risk deps for live and backtest
- `src/backtest/margin-model.ts` — Reg-T simulation (correct)
- `src/backtest/runner.ts:334` — margin call detection (log-only, does not halt)
- `src/broker/ibkr/client.ts` — IBKR order submission (TIF, combo body)

## What Was Fixed

### 1. Credit spread notional bypass (CRITICAL)
`notionalValue()` uses `entryPrice × qty × 100` for all strategies. For PCS/CCS, `entryPrice` is the net credit received — a small number. A 10-wide PCS collecting $1 credit, 5 contracts: old notional = $500; actual max-loss = $4,500. The 2× notional cap was underestimating credit spread exposure by 5–10×. Added `positionRiskNotional()` in `risk-check.ts` that uses `(width − credit) × qty × 100` for PCS/CCS.

### 2. Live maxTotalPositions = 100 (CRITICAL)
`LIVE_RISK_DEFAULTS.maxTotalPositions` was 100 — 5× higher than backtest (20). Combined with the credit spread notional bug, this allowed vastly more exposure than intended. Fixed to 20.

### 3. No margin cushion gate (HIGH)
IBKR returns `maintenanceMargin` in `getAccountBalance()` but it was never checked. Added `minMarginCushionPct: 0.20` to `RiskCheckConfig` and wired `getMaintenanceMargin` dep. New opens are now blocked when `(equity − maintenance) / equity < 20%`, giving a buffer before IBKR force-liquidates.

### 4. GTC opening orders (MEDIUM)
All IBKR orders used `tif: 'GTC'`. If the bot crashes before `cancelAfterSec` fires, unfilled entry orders persist to the next session and can fill at stale prices. Changed to `tif: 'DAY'` for opening orders; closing orders stay `GTC` (a cancelled close leaves an unhedged position).

## Watch Out

- **Drawdown protection silently disabled if startingEquity is null.** If `dailyBalances` has no record for today, `getStartingEquity()` returns null and the drawdown gate is skipped entirely with no log or alert. Add a startup guard.
- **No server-side stops at IBKR.** Bot crash = naked positions with no automated exit. Keep TWS/IB Gateway open manually and monitor the account directly on day 1.
- **Risk check is decision-time only, not fill-time.** Multiple working orders approved at high equity can all fill after equity drops, violating the notional cap. This is a known architectural gap.
- **OPTION_OPEN_BUY allows 50% slippage.** On illiquid options with wide spreads, the bot will chase up to 1.5× the signal price. Reduce `maxSlippagePct` to 0.25 for the first week.
- **Margin call in backtest runner only logs** (`runner.ts:334`). The two brainy-cicada margin calls were ignored and trading continued. This is why it "survived" — not strategy robustness.
- **`MAX_CONTRACTS: 20` cap** makes 5% sizing inaccurate above ~$500k equity (positions size to 1–2% instead). Not a safety risk but affects expected P&L.

## Recommended Day-1 Parameters (for $100k account)
```
maxOnSymbol:          3   (was 5)
maxTotalPositions:   10   (was 20 after fix, suggest 10 for day 1)
maxDrawdownPct:       3   (was 5)
maxNotionalMultiplier: 1.5 (was 2)
minMarginCushionPct: 0.25  (new; set above 0.20 default for day 1)
maxNotionalPct:      0.03  (sizing; was 0.05)
```

## Missing Gates — Add Before or Shortly After Launch
1. Per-symbol notional cap (`maxNotionalPctPerSymbol: 0.15`) — prevents 25%+ concentration
2. Daily trade count limit (`maxDailyOrders: 30`) — runaway LLM loop protection
3. Startup equity guard — alert + block if startingEquity is null at market open
4. Panic-close endpoint (`/emergency-flatten`) — manual flatten when needed
