import { createContext, useContext, type ReactNode } from 'react';
import type { CommissionSchedule, Trade, TradeEvent, TradeFlag } from '@src/db/schema';
import type { TradeLabel } from '@src/local-api/http-schemas';
import type { LivePosition } from '@/lib/trade-story';

type TradesViewValue = {
  trades: Trade[];
  eventsByTradeId: Record<string, TradeEvent[]>;
  flagsByTradeId: Record<string, TradeFlag[]>;
  labelsByTradeId: Record<string, TradeLabel>;
  livePositionsByTradeId: Record<string, LivePosition>;
  commissionSchedule?: CommissionSchedule;
  channelId?: string;
  patchLabel?: (tradeId: string, patch: Partial<TradeLabel>) => void;
};

const TradesViewContext = createContext<TradesViewValue | null>(null);

export function TradesViewProvider({
  value,
  children,
}: {
  value: TradesViewValue;
  children: ReactNode;
}) {
  return <TradesViewContext.Provider value={value}>{children}</TradesViewContext.Provider>;
}

export function useTradesView() {
  const value = useContext(TradesViewContext);
  if (!value) throw new Error('useTradesView must be used within TradesViewProvider');
  return value;
}
