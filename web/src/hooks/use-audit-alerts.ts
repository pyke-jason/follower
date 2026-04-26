import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useChannelId } from '@/hooks/use-channel-id';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { useApiMutation } from '@/hooks/use-api-mutation';
import {
  ClassificationAuditListResponseSchema,
  ClassificationAuditRowSchema,
  ClassificationAuditStatsSchema,
  ClassificationAuditStatusSchema,
  SafetySeveritySchema,
  type ClassificationAuditRow,
  type ClassificationAuditStatus,
} from '@src/local-api/http-schemas';

type AuditMutation = {
  auditId: string;
  status: Extract<ClassificationAuditStatus, 'resolved' | 'dismissed'>;
  reason?: string;
};

export function useAuditAlerts(status: string, severity: string) {
  const channelId = useChannelId();
  const href = useScopedHref();
  const statusParsed = ClassificationAuditStatusSchema.safeParse(status);
  const severityParsed = SafetySeveritySchema.safeParse(severity);
  const typedStatus = statusParsed.success ? statusParsed.data : 'open';
  const typedSeverity = severityParsed.success ? severityParsed.data : undefined;

  const alertsQuery = useQuery({
    queryKey: ['audit-alerts', channelId, typedStatus, typedSeverity],
    queryFn: async () => {
      const raw = await api<unknown>(href('/audits', {
        status: typedStatus,
        severity: typedSeverity,
      }));
      return ClassificationAuditListResponseSchema.parse(raw);
    },
  });

  const statsQuery = useQuery({
    queryKey: ['audit-stats', channelId],
    queryFn: async () => {
      const raw = await api<unknown>(href('/audits/stats'));
      return ClassificationAuditStatsSchema.parse(raw);
    },
  });

  const resolveMut = useApiMutation<AuditMutation, ClassificationAuditRow>(
    'POST',
    (vars) => `/audits/${vars.auditId}/resolve`,
    {
      body: (vars) => ({ status: vars.status, reason: vars.reason }),
      invalidate: [['audit-alerts'], ['audit-stats']],
      onSuccess: (raw) => ClassificationAuditRowSchema.parse(raw),
    },
  );

  const setStatus = useCallback(
    (auditId: string, nextStatus: AuditMutation['status'], reason?: string) =>
      resolveMut.mutateAsync({ auditId, status: nextStatus, reason }),
    [resolveMut.mutateAsync],
  );

  return {
    alerts: alertsQuery.data?.rows ?? [],
    total: alertsQuery.data?.total ?? 0,
    stats: statsQuery.data,
    isLoading: alertsQuery.isLoading || statsQuery.isLoading || !alertsQuery.data || !statsQuery.data,
    setStatus,
    isResolving: resolveMut.isPending,
    alertsQuery,
    statsQuery,
  };
}
