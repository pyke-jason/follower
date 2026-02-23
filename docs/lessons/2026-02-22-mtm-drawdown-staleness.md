Problem
computeCoreStats() computed maxDrawdown from realized (closed-trade) PnL only, ignoring unrealized swings captured in MTM snapshots. A position could drop $5k unrealized, recover, close at +$100, and report maxDrawdown=$0. Separately, liveMetrics.openPositionCount in runner.ts was only refreshed inside the shouldRecomputeMtm throttle guard, causing the web progress section to show stale counts while the header (which queries DB fresh) showed correct ones.

Decision
For drawdown: after building the equity curve (which already merges realized cumPnl with MTM unrealized into an equity field), recompute maxDrawdown by walking the equity series when MTM data exists. This is 6 lines of code after the equity curve loop. The realized-only fallback is preserved when no MTM snapshots are provided. For staleness: moved getOpenPositionCount() outside the MTM throttle guard since it's just a SELECT COUNT (no price lookups), while keeping getUnrealizedPnl() throttled since it requires per-position price fetches.

Key Files
src/backtest/report.ts -- MTM-aware drawdown recomputation after equity curve build (~line 226). computeExtendedMetrics receives maxDrawdown as a parameter, so Calmar ratio and recovery factor automatically get the corrected value downstream.
src/backtest/runner.ts -- openPositionCount refresh moved outside shouldRecomputeMtm guard (~line 431-443).
src/backtest/report.test.ts -- Four new deterministic tests: MTM-aware drawdown with single trade, MTM drawdown with multiple trades, realized-only fallback (no snapshots), realized-only fallback (empty snapshots array).

Cruft Purge (same day)
Consolidated three separate drawdown loops (realized-only, equity curve build, MTM-aware recompute) into a single pass inside the equity curve build loop. Added drawdown?: number to the canonical EquityPoint type so consumers receive pre-computed drawdown per point. Deleted local EquityPoint type definitions in drawdown-chart.tsx and equity-curve-chart.tsx (replaced with imports from src/backtest/types). Deleted the useMemo peak-tracking computation in DrawdownChart (now just negates pre-computed values). Replaced the hasDrawdown IIFE loop in page.tsx with a one-liner reading summary.maxDrawdown. Net: ~40 lines deleted, ~5 lines added.

Watch Out
The equity curve's equity field is only populated for dates that have MTM snapshots. Days without snapshots fall back to cumPnl via the (pt.equity ?? pt.cumPnl) coalesce. If MTM snapshot frequency changes (e.g., only end-of-run), intra-run unrealized dips on unsnapshotted days will still be invisible to drawdown. The drawdown field on EquityPoint uses whichever equity value is active (MTM-aware or realized-only), so it's always consistent with the maxDrawdown in the summary.
