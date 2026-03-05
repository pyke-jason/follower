'use client';

import { useRef, useEffect } from 'react';
import { useTradeFilters } from '../../components/trade-filters';
import { TradesTableClient } from '../../components/trades-table-client';
import { useTradesStore } from '@/stores/trades-store';
import type { TradeEvent, TradeFlag, CommissionSchedule } from '@src/db/schema';

export function BacktestTradesTable({
  eventsByTradeId,
  flagsByTradeId,
  runId,
  commissionSchedule,
  startingEquity,
}: {
  eventsByTradeId: Map<string, TradeEvent[]>;
  flagsByTradeId: Record<string, TradeFlag[]>;
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
    flagsByTradeId,
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
  }, [filteredTrades, eventsByTradeId, flagsByTradeId, runId, commissionSchedule, startingEquity, hydrate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (filteredTrades.length === 0 && hasFilters) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">
        No trades matching filters
      </p>
    );
  }

  return <TradesTableClient />;
}
