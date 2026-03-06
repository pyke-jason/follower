import { useRef, useEffect } from 'react';
import { useTradeFilters } from './trade-filters';
import { TradesTableClient } from './trades-table-client';
import { useTradesStore } from '@/stores/trades-store';
import type { TradeEvent, TradeFlag, CommissionSchedule } from '@src/db/schema';

export function FilteredTradesView({
  eventsByTradeId = {},
  flagsByTradeId,
  channelId,
  commissionSchedule,
  startingEquity,
}: {
  eventsByTradeId?: Record<string, TradeEvent[]>;
  flagsByTradeId: Record<string, TradeFlag[]>;
  channelId: string;
  commissionSchedule?: CommissionSchedule;
  startingEquity?: number;
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
    channelId,
  };

  if (!initialized.current) {
    hydrate(hydrationData);
    initialized.current = true;
  }

  useEffect(() => {
    hydrate(hydrationData);
  }, [filteredTrades, eventsByTradeId, flagsByTradeId, channelId, commissionSchedule, startingEquity, hydrate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (filteredTrades.length === 0 && hasFilters) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">
        No trades matching filters
      </p>
    );
  }

  return <TradesTableClient />;
}
