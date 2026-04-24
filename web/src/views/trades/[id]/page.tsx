import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { QueryBoundary, MetricStripSkeleton } from '@/components/query-boundary';
import { useChannelId } from '@/hooks/use-channel-id';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { useBackHref } from '@/hooks/use-back-href';
import { ActivityDetail } from './activity-detail';
import type { TradeStory } from '@/lib/trade-story';

export default function TradeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const channelId = useChannelId();
  const href = useScopedHref();
  const backHref = useBackHref('/trades');

  const query = useQuery<TradeStory>({
    queryKey: ['trade', id, channelId],
    queryFn: () => api<TradeStory>(href(`/trades/${id}/story`)),
    refetchInterval: (q) => (q.state.data?.trade?.status === 'OPEN' ? 10_000 : false),
  });

  return (
    <QueryBoundary query={query} skeleton={<MetricStripSkeleton count={5} />}>
      {(data) => <ActivityDetail story={data} backHref={backHref} />}
    </QueryBoundary>
  );
}
