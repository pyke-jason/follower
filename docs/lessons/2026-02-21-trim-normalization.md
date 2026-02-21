TRIM normalization: eliminate child trades, accumulate realizedPnl

Problem:
  TRIM created a fake CLOSED child row in trades with parentTradeId, inflating trade counts, splitting PnL across parent+child, and adding PARTIAL status complexity. The trade_events table already captured everything needed. One position was represented as 2+ trade rows, making stats unreliable.

Decision:
  TRIM now updates the parent row in place: reduce quantity, accumulate realizedPnl. No child rows, no PARTIAL status. CLOSE adds realizedPnl to final PnL for the total. The event still captures trimQty, exitPrice, exitPercent, and trimPnl for audit. Trade detail page shows an event timeline (all actions) instead of a parent/child tree. Added rebuildFromEvents() diagnostic utility to replay events and compare against the actual row.

Key files:
  src/trades/record-trade.ts — TRIM rewrites parent in place (realizedPnl += trimPnl), CLOSE incorporates realizedPnl into total pnl
  src/db/schema.ts — added realizedPnl column, removed parentTradeId, exitPercent, idx_trades_parent
  src/trades/filters.ts — isOpen simplified to eq(status, 'OPEN'), no more PARTIAL
  drizzle/0018_trim_normalization.sql — migration: add column, roll up children, delete children, drop columns
  web/app/trades/[id]/event-timeline.tsx — replaces partial-exit-tree.tsx, shows full event history
  web/lib/queries.ts — getTradeEvents() replaces getPartialExits()/getParentTrade()
  src/trades/rebuild.ts — rebuildFromEvents() for consistency checking

Watch out:
  computeCoreStats() now counts 1 position = 1 trade. Previous backtest run summaries (JSON blobs in backtest_runs.summary) won't match if re-computed from trades after migration.
  TRIM events now carry trimPnl in metadata for the event timeline to display. Old events from before this change won't have trimPnl.
  RecordTradeResult.tradeId for TRIM returns the parent trade ID now, not a child ID.
  Migration rolls up child PnL into parent's realized_pnl, then deletes children. Back up DB before applying.
