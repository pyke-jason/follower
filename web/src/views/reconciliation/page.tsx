import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Badge } from '@/components/badge';
import { DataTable } from '@/components/data-table';
import { MetricStrip, type Metric } from '@/components/metric-strip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { useReconAlerts } from '@/hooks/use-recon-alerts';
import { useReconParams } from '@/hooks/use-recon-params';
import { EmptyState } from '@/components/empty-state';
import { QueryBoundary, TableSkeleton } from '@/components/query-boundary';
import { ShieldAlert, CheckCircle2 } from 'lucide-react';
import { formatDate } from '@/lib/format';
import type { ReconciliationAlert } from '@src/db/schema';
import type { Column } from '@/lib/api-types';

function ResolveAction({
  alert,
  onResolve,
  isPending,
}: {
  alert: ReconciliationAlert;
  onResolve: (alertId: string, reason: string) => void;
  isPending: boolean;
}) {
  const [reason, setReason] = useState('');

  if (alert.resolved) {
    return alert.resolvedReason
      ? <span className="text-xs text-muted-foreground">{alert.resolvedReason}</span>
      : null;
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason"
        className="h-7 text-xs w-32"
      />
      <Button
        variant="secondary"
        size="xs"
        disabled={!reason.trim() || isPending}
        onClick={() => {
          if (reason.trim()) {
            onResolve(alert.id, reason.trim());
            setReason('');
          }
        }}
      >
        Resolve
      </Button>
    </div>
  );
}

function useAlertColumns(
  onResolve: (alertId: string, reason: string) => void,
  isResolving: boolean,
): Column<ReconciliationAlert>[] {
  const href = useScopedHref();
  const { pathname } = useLocation();
  return [
    {
      key: 'type',
      label: 'Type',
      render: (a) => <Badge label={a.type} />,
    },
    {
      key: 'symbol',
      label: 'Symbol',
      className: 'font-medium',
      render: (a) => a.symbol,
    },
    {
      key: 'expected',
      label: 'Expected',
      className: 'text-xs text-muted-foreground font-mono max-w-[200px] truncate',
      render: (a) => a.expected ? JSON.stringify(a.expected) : '--',
    },
    {
      key: 'actual',
      label: 'Actual',
      className: 'text-xs text-muted-foreground font-mono max-w-[200px] truncate',
      render: (a) => a.actual ? JSON.stringify(a.actual) : '--',
    },
    {
      key: 'tradeId',
      label: 'Trade',
      render: (a) =>
        a.tradeId ? (
          <Link to={href(`/trades/${a.tradeId}`, { from: pathname })} className="text-xs text-info hover:underline">
            {a.tradeId.slice(0, 8)}...
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">--</span>
        ),
    },
    {
      key: 'createdAt',
      label: 'Created',
      sortable: true,
      className: 'text-xs text-muted-foreground font-mono tabular-nums',
      render: (a) => formatDate(a.createdAt),
    },
    {
      key: 'resolved',
      label: 'Status',
      render: (a) =>
        a.resolved ? (
          <span className="flex items-center gap-1 text-xs text-profit">
            <CheckCircle2 className="h-3 w-3" />
            Resolved
          </span>
        ) : (
          <Badge label="UNRESOLVED" />
        ),
    },
    {
      key: 'action',
      label: 'Action',
      render: (a) => (
        <ResolveAction alert={a} onResolve={onResolve} isPending={isResolving} />
      ),
    },
  ];
}

export default function ReconciliationPage() {
  const { filter } = useReconParams();
  const href = useScopedHref();
  const filterResolved = filter === 'resolved' ? true : filter === 'unresolved' ? false : undefined;

  const { alerts, stats, isLoading, resolve, isResolving, alertsQuery, statsQuery } = useReconAlerts(filterResolved);
  const columns = useAlertColumns(resolve, isResolving);

  const combinedQuery = {
    data: stats ? { alerts, stats } : undefined,
    isLoading,
    isError: alertsQuery.isError || statsQuery.isError,
    error: alertsQuery.error || statsQuery.error,
    refetch: () => { alertsQuery.refetch(); statsQuery.refetch(); },
  };

  return (
    <QueryBoundary query={combinedQuery} skeleton={<TableSkeleton />}>
      {(data) => <ReconciliationContent data={data} columns={columns} filterResolved={filterResolved} href={href} />}
    </QueryBoundary>
  );
}

function ReconciliationContent({ data, columns, filterResolved, href }: {
  data: { alerts: ReconciliationAlert[]; stats: NonNullable<ReturnType<typeof useReconAlerts>['stats']> };
  columns: Column<ReconciliationAlert>[];
  filterResolved: boolean | undefined;
  href: ReturnType<typeof useScopedHref>;
}) {
  const { alerts, stats } = data;

  const metrics: Metric[] = [
    { label: 'Total Alerts', value: stats.total, format: 'integer' },
    { label: 'Unresolved', value: stats.unresolved, format: 'integer' },
    { label: 'DB Only', value: stats.byType['DB_ONLY'] ?? 0, format: 'integer' },
    { label: 'Broker Only', value: stats.byType['BROKER_ONLY'] ?? 0, format: 'integer' },
  ];

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <ShieldAlert className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold text-foreground">Reconciliation Alerts</h2>
      </div>

      {stats.total > 0 && <MetricStrip metrics={metrics} />}

      {/* Filter toggles */}
      <div className="flex gap-2">
        <Button variant={filterResolved === undefined ? 'secondary' : 'ghost'} size="sm" asChild>
          <Link to={href('/reconciliation')}>All</Link>
        </Button>
        <Button variant={filterResolved === false ? 'secondary' : 'ghost'} size="sm" asChild>
          <Link to={href('/reconciliation', { filter: 'unresolved' })}>Unresolved</Link>
        </Button>
        <Button variant={filterResolved === true ? 'secondary' : 'ghost'} size="sm" asChild>
          <Link to={href('/reconciliation', { filter: 'resolved' })}>Resolved</Link>
        </Button>
      </div>

      {alerts.length === 0 ? (
        <EmptyState
          variant={filterResolved !== undefined ? 'filtered' : 'default'}
          title={filterResolved !== undefined ? 'No alerts matching filter' : 'No reconciliation alerts'}
          hint={filterResolved !== undefined ? 'Try clearing the filter to see all alerts' : 'Position reconciliation alerts will appear here'}
        />
      ) : (
        <DataTable
          columns={columns}
          data={alerts}
          defaultSort={{ column: 'createdAt', dir: 'desc' }}
          className="flex-1 min-h-0"
        />
      )}
    </div>
  );
}
