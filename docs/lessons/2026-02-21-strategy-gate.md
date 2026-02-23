Problem
Stock trades were executed in backtests despite traders having strategies: ["CDS","PDS","CALL","PUT"] (no STOCK).
The strategies field on tracked_traders was only passed to the LLM prompt as a hint — zero enforcement anywhere in the pipeline.

Decision
Added shouldSkipSignal() in deterministic-skips.ts as a per-signal strategy gate, parallel to the existing shouldSkipDeterministic() which operates at message level.
Enforcement at executeSignal() in pipeline/execute.ts — the single chokepoint both live and backtest paths share. Also added early-out in RuleBasedTradeAgent.onSignal() to avoid wasted sizing in the backtest path.
Only blocks OPEN/ADD (position-increasing). CLOSE/TRIM/LEG_OFF always allowed so traders can exit existing positions after a strategy is disabled.

Key Files
src/agent/deterministic-skips.ts — shouldSkipSignal() function
src/pipeline/execute.ts — enforcement at top of executeSignal(), allowedStrategies on PipelineOpts
src/trading/trade-agent.ts — early-out in RuleBasedTradeAgent.onSignal()
src/backtest/runner.ts, src/tasks/runner.ts — thread allowedStrategies from prefetched.traderProfile

Watch Out
allowedStrategies flows from prefetched.traderProfile.strategies which is nullable (trader not in DB) and prefetched itself is undefined on fetch failure. Both cases fail open (allow all strategies). This matches the existing codebase pattern but means a broken prefetch silently disables the gate.
