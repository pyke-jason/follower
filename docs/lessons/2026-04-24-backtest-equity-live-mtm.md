Problem

Running backtest detail pages computed the equity curve from persisted EOD MTM snapshots only. The run header used liveMetrics.unrealizedPnl, so the headline P&L could advance while the dashed equity curve stopped at the last persisted snapshot.

Decision

For non-completed runs, the local API now merges the latest liveMetrics unrealized P&L into the MTM snapshots used for the detail payload. Completed runs continue to use persisted snapshots only.

Key Files

src/local-api/backtest-mtm.ts
src/local-api/routes/web-queries.ts
web/src/views/backtests/[id]/equity-curve-chart.tsx

Watch Out

The synthetic live MTM point is response-only. It should not be inserted into backtest_mtm_snapshots because the runner owns persisted EOD snapshots.
