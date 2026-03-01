'use client';

import { useTradeFilters } from '../../components/trade-filters';
import { TradesTableClient } from '../../components/trades-table-client';
import type { TradeEvent, CommissionSchedule } from '@src/db/schema';

export function BacktestTradesTable({
  eventsByTradeId,
  cancelledTradeIds,
  runId,
  commissionSchedule,
  startingEquity,
}: {
  eventsByTradeId: Map<string, TradeEvent[]>;
  cancelledTradeIds?: Set<string>;
  runId: string;
  commissionSchedule?: CommissionSchedule;
  startingEquity: number;
}) {
  const { filteredTrades, hasFilters } = useTradeFilters();

  if (filteredTrades.length === 0 && hasFilters) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">
        No trades matching filters
      </p>
    );
  }

  return (
    <TradesTableClient
      trades={filteredTrades}
      eventsByTradeId={eventsByTradeId}
      cancelledTradeIds={cancelledTradeIds}
      runId={runId}
      commissionSchedule={commissionSchedule}
      startingEquity={startingEquity}
    />
  );
}
