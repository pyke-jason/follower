import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { QueryBoundary, MetricStripSkeleton } from '@/components/query-boundary';
import { useBackHref } from '@/hooks/use-back-href';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { ActivityDetail } from '@/views/trades/[id]/activity-detail';
import type { TradeStory } from '@/lib/trade-story';

/**
 * Response from /tasks/:id. When the task produced a trade, the backend
 * returns `{ redirect: '/trades/...' }` — the trade page owns that URL.
 * Otherwise it returns the same shape as /trades/:id/story with `trade: null`,
 * so we render the same ActivityDetail component.
 */
type TaskDetailResponse = TradeStory & { redirect?: string };

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const href = useScopedHref();
  const backHref = useBackHref('/tasks');

  const query = useQuery<TaskDetailResponse>({
    queryKey: ['task', id],
    queryFn: () => api<TaskDetailResponse>(href(`/tasks/${id}`)),
    refetchInterval: (q) => {
      const status = q.state.data?.task?.status;
      return status === 'PENDING' || status === 'IN_PROGRESS' ? 2000 : false;
    },
  });

  useEffect(() => {
    if (query.data?.redirect) navigate(query.data.redirect, { replace: true });
  }, [query.data?.redirect, navigate]);

  if (query.data?.redirect) return <MetricStripSkeleton count={5} />;

  return (
    <QueryBoundary query={query} skeleton={<MetricStripSkeleton count={5} />}>
      {(data) => <ActivityDetail story={data} backHref={backHref} />}
    </QueryBoundary>
  );
}
