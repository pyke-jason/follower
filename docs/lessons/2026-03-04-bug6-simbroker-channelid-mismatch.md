# Bug 6: SimBroker channelId Mismatch — Expired Options Never Swept

## Problem

Backtest trades with expired option legs remained OPEN forever. MSFT 9/19 PUT (and 4 other option trades) never got swept at expiry. The backtest completed successfully with `openAtEnd: 19`, including options that had long since expired.

## Root Cause

`runner.ts` line 145 passed raw `runId` to `SimBroker`:
```ts
const broker = new SimBroker(priceProvider, clock, runId, ...);
```

But the pipeline stored trades with `btChannel(runId)` (i.e., `bt:<runId>`):
```ts
scope: btChannel(runId),  // line 165
```

SimBroker's `sweepExpired()`, `autoCloseExpiring()`, `getOpenPositionCount()`, and all other DB queries used `forChannel(this.channelId)` — which searched for `channelId = 'ca3956ae-...'` while trades had `channel_id = 'bt:ca3956ae-...'`. Result: all broker queries found 0 trades, so sweeps were no-ops.

## Decision

One-character fix: `btChannel(runId)` instead of `runId` at the SimBroker constructor call.

## Key Files

- `src/backtest/runner.ts:145` — the fix
- `src/backtest/sim-broker.ts:158` — constructor stores `channelId`
- `src/backtest/sim-broker.ts:544-593` — `sweepExpired()`
- `src/backtest/sim-broker.ts:605-655` — `autoCloseExpiring()`

## Watch Out

- Existing test files (`sim-broker-db.test.ts`, `sim-broker-temporal.test.ts`, `sim-broker-pnl.test.ts`) already used `btChannel(RUN_ID)` correctly — only the runner had the mismatch.
- `sim-broker.test.ts` uses raw `'test-run'` but is self-consistent since it creates trades through the broker itself.
- This also means `getOpenPositionCount()`, `getUnrealizedPnl()`, `markToMarket()`, and margin checks were all querying an empty set. MTM snapshots and equity curves for this run were likely reporting $0 unrealized PnL.
- The `is_backtest` column was also 0 for all 81 trades in this run — separate issue, likely related to the same scope not being recognized as a backtest channel.
