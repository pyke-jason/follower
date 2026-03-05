'use client';

import { useRef, useEffect } from 'react';
import { useTradeFilters } from '../../components/trade-filters';
import { TradesTableClient } from '../../components/trades-table-client';
import { useTradesStore } from '@/stores/trades-store';
import type { TradeEvent, CommissionSchedule } from '@src/db/schema';

export function BacktestTradesTable({
  eventsByTradeId,
  cancelledTradeIds,
  subsequentMessageTradeIds,
  runId,
  commissionSchedule,
  startingEquity,
}: {
  eventsByTradeId: Map<string, TradeEvent[]>;
  cancelledTradeIds?: Set<string>;
  subsequentMessageTradeIds?: Set<string>;
  runId: string;
  commissionSchedule: CommissionSchedule;
  startingEquity: number;
}) {
  const { filteredTrades, hasFilters } = useTradeFilters();
  const hydrate = useTradesStore((s) => s.hydrate);
  const initialized = useRef(false);

  const hydrationData = {
    trades: filteredTrades,
    eventsByTradeId,
    cancelledTradeIds: cancelledTradeIds ?? new Set<string>(),
    subsequentMessageTradeIds,
    commissionSchedule,
    startingEquity,
    runId,
  };

  if (!initialized.current) {
    hydrate(hydrationData);
    initialized.current = true;
  }

  useEffect(() => {
    hydrate(hydrationData);
  }, [filteredTrades, eventsByTradeId, cancelledTradeIds, subsequentMessageTradeIds, runId, commissionSchedule, startingEquity, hydrate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (filteredTrades.length === 0 && hasFilters) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">
        No trades matching filters
      </p>
    );
  }

  return <TradesTableClient />;
}
