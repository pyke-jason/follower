Problem
Live trading bypassed OrderManager entirely — placeOrder() in the pipeline stripped
cancelAfterSec and adjustmentRules for live, sending plain orders to TradeStation.
This meant backtests simulated price-chase and 60s auto-cancel, but live did neither.
Backtest fill behavior diverged from production.

Decision
Wire OrderManager into the live task runner with manualTick: false (wall-clock 1s auto-tick),
mirroring the backtest pattern exactly. Same onFill/onCancel callbacks, same pendingIntents map,
same onPending handler in pipelineDeps. The pipeline's placeOrder() already had the
if (deps.orderManager) routing — just needed to provide it.

Removed dead handleOrderFill from src/index.ts (was never connected to anything).
FillSweep stays as a safety net for edge cases (process restart with orphaned orders).

Key Files
src/tasks/runner.ts — module-level OrderManager + pendingIntents, destroyOrderManager export
src/index.ts — removed handleOrderFill, added destroyOrderManager to shutdown
src/pipeline/execute.ts — unchanged, placeOrder() routing already handled both paths
src/orders/order-manager.ts — unchanged, works for both live (auto-tick) and backtest (manual tick)

Watch Out
OrderManager's onFill callback is async but typed as () => void — the caller doesn't await it.
Practically safe (1s tick interval >> recordTrade latency) but worth noting.
pendingIntents map is in-memory — process crash loses pending order context.
FillSweep can't recover these either since no trade row exists yet for OPEN orders.
