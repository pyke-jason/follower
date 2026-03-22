import { useChannelId } from '@/hooks/use-channel-id';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { TradeFilterProvider, TradeFilters } from '../components/trade-filters';
import { FilteredTradesView } from '../components/filtered-trades-view';
import { Spinner } from '../components/spinner';
import type { Trade, TradeFlag } from '@src/db/schema';

type TradesResponse = {
  trades: Trade[];
  flags: Record<string, TradeFlag[]>;
};

export default function TradesPage() {
  const channelId = useChannelId();
  const href = useScopedHref();

  const { data, isLoading } = useQuery({
    queryKey: ['trades', channelId],
    queryFn: () => api<TradesResponse>(href('/trades', { limit: 10000 })),
  });

  if (isLoading || !data) return <Spinner />;

  return (
    <TradeFilterProvider trades={data.trades} flagsByTradeId={data.flags}>
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
  );
}
