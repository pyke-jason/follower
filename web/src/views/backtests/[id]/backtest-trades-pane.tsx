import { FilteredTradesView } from '@/components/filtered-trades-view';
import { TradeFilterProvider, TradeFilters } from '@/components/trade-filters';
import { TradesViewProvider } from '@/components/trades-view-context';
import { btChannel } from '@src/lib/channel';
import type { BacktestDetailResponse, TradeLabel } from '@src/local-api/http-schemas';

export function BacktestTradesPane({
  id,
  data,
  onLabelPatch,
}: {
  id: string;
  data: BacktestDetailResponse;
  onLabelPatch: (tradeId: string, patch: Partial<TradeLabel>) => void;
}) {
  return (
    <TradesViewProvider
      value={{
        trades: data.allTrades,
        eventsByTradeId: data.eventsByTradeId,
        flagsByTradeId: data.flagsByTradeId,
        labelsByTradeId: data.labelsByTradeId ?? {},
        livePositionsByTradeId: {},
        commissionSchedule: data.run.config.commissionSchedule,
        channelId: btChannel(id),
        patchLabel: onLabelPatch,
      }}
    >
      <TradeFilterProvider
        trades={data.allTrades}
        flagsByTradeId={data.flagsByTradeId}
        labelsByTradeId={data.labelsByTradeId}
      >
        <div className="space-y-3 flex flex-col flex-1 min-h-0">
          <div className="pb-1">
            <TradeFilters className="flex-wrap justify-start" evalSummary={data.evalSummary} />
          </div>
          <div className="flex-1 min-h-0">
            <FilteredTradesView />
          </div>
        </div>
      </TradeFilterProvider>
    </TradesViewProvider>
  );
}
