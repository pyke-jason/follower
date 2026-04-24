import { useQuery } from '@tanstack/react-query';
import { useChannelId } from '@/hooks/use-channel-id';
import { queries } from '@/lib/queries';
import { QueryBoundary, TableSkeleton } from '@/components/query-boundary';
import { TradeFilterProvider, TradeFilters } from '@/components/trade-filters';
import { FilteredTradesView } from '@/components/filtered-trades-view';
import { TradesViewProvider } from '@/components/trades-view-context';

export default function TradesPage() {
  const channelId = useChannelId();
  const trades = useQuery(queries.trades.list(channelId!));

  return (
    <QueryBoundary query={trades} skeleton={<TableSkeleton rows={12} cols={7} />}>
      {(data) => (
        <TradesViewProvider
          value={{
            trades: data.rows,
            eventsByTradeId: {},
            flagsByTradeId: data.flags,
            labelsByTradeId: {},
            livePositionsByTradeId: data.livePositionsByTradeId,
            channelId: channelId!,
          }}
        >
          <TradeFilterProvider trades={data.rows} flagsByTradeId={data.flags}>
            <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden pb-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-foreground">Trades</h2>
                <TradeFilters />
              </div>
              <div className="mt-4 flex-1 min-h-0 overflow-hidden">
                <FilteredTradesView />
              </div>
            </div>
          </TradeFilterProvider>
        </TradesViewProvider>
      )}
    </QueryBoundary>
  );
}
