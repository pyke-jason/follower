import { useQuery } from '@tanstack/react-query';
import { useChannelId } from '@/hooks/use-channel-id';
import { queries } from '@/lib/queries';
import { QueryBoundary, TableSkeleton } from '@/components/query-boundary';
import { TradeFilterProvider, TradeFilters } from '@/components/trade-filters';
import { FilteredTradesView } from '@/components/filtered-trades-view';

export default function TradesPage() {
  const channelId = useChannelId();
  const trades = useQuery(queries.trades.list(channelId!));

  return (
    <QueryBoundary query={trades} skeleton={<TableSkeleton rows={12} cols={7} />}>
      {(data) => (
        <TradeFilterProvider trades={data.rows} flagsByTradeId={data.flags}>
          <div className="space-y-4 flex flex-col flex-1 min-h-0">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground">Trades</h2>
              <TradeFilters />
            </div>
            <FilteredTradesView
              flagsByTradeId={data.flags}
              channelId={channelId!}
            />
          </div>
        </TradeFilterProvider>
      )}
    </QueryBoundary>
  );
}
