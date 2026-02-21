Strategy-aware position matching

Problem:
  "Exit Short GNRC pds" matched against an open GNRC STOCK position because position lookup only filtered by symbol + trader, not strategy. The pipeline grabbed positions[0] — whichever came first. When a trader has both STOCK and PDS positions on the same symbol, this caused the wrong position to be closed.

Decision:
  Added strategy to the getOpenPositions filter interface. All pipeline executors (executeClose, executeTrim, executeLegOff, executeAdd) now pass signal.strategy when looking up positions. recordTrade's scopeFilters also include strategy when provided. Exact strategy matching is safe even with LEG_OFF — by the time a legged-off position is closed, the DB row's strategy already reflects the mutation (CDS→CALL).

Key files:
  src/trades/filters.ts — added forStrategy composable filter
  src/pipeline/execute.ts — added strategy to PipelineDeps.getOpenPositions filter type, passed in all 4 executors
  src/trades/record-trade.ts — strategy added to scopeFilters (defense in depth)
  src/backtest/sim-broker.ts — strategy filter added to getOpenTrades
  src/tasks/runner.ts — strategy filter added to live getOpenPositions
  src/agent/prefetch.ts, src/agent/tool-factory.ts, src/orders/risk-check.ts — type signatures updated for consistency

Watch out:
  The filter is optional — omitting strategy returns all positions for that symbol/trader (backward compatible for tools like get_open_positions where the LLM doesn't pass strategy).
  If the LLM extracts the wrong strategy (e.g. says PDS when the open position is CDS), the lookup returns nothing and the signal fails with "No open position". This is correct — better to fail explicitly than mutate the wrong position.
