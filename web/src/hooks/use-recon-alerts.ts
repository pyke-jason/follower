import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useChannelId } from './use-channel-id';
import { useScopedHref } from './use-scoped-href';
import { useApiMutation } from './use-api-mutation';
import { api } from '@/lib/api';
import type { ReconciliationAlert } from '@src/db/schema';

type ReconStats = {
  total: number;
  unresolved: number;
  resolved: number;
  byType: Record<string, number>;
};

export function useReconAlerts(filterResolved?: boolean) {
  const channelId = useChannelId();
  const href = useScopedHref();

  const alertsQuery = useQuery<ReconciliationAlert[]>({
    queryKey: ['recon-alerts', channelId, filterResolved],
    queryFn: () =>
      api<ReconciliationAlert[]>(href('/recon-alerts', {
        resolved: filterResolved !== undefined ? String(filterResolved) : undefined,
      })),
  });

  const statsQuery = useQuery<ReconStats>({
    queryKey: ['recon-stats', channelId],
    queryFn: () => api<ReconStats>(href('/recon-alerts/stats')),
  });

  const resolveMut = useApiMutation<{ alertId: string; reason: string }>(
    'POST',
    (v) => `/reconciliation/${v.alertId}/resolve`,
    { body: (v) => ({ reason: v.reason }), invalidate: [['recon-alerts'], ['recon-stats']] },
  );

  const resolve = useCallback(
    (alertId: string, reason: string) => resolveMut.mutate({ alertId, reason }),
    [resolveMut.mutate],
  );

  return {
    alerts: alertsQuery.data ?? [],
    stats: statsQuery.data,
    isLoading: alertsQuery.isLoading || statsQuery.isLoading || !alertsQuery.data || !statsQuery.data,
    resolve,
    isResolving: resolveMut.isPending,
    alertsQuery,
    statsQuery,
  };
}
