import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge } from '@/components/badge';
import { DataTable } from '@/components/data-table';
import { MetricStrip, type Metric } from '@/components/metric-strip';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { useReconAlerts } from '@/hooks/use-recon-alerts';
import { useReconParams } from '@/hooks/use-recon-params';
import { EmptyState } from '@/components/empty-state';
import { QueryBoundary, TableSkeleton } from '@/components/query-boundary';
import { ShieldAlert, CheckCircle2 } from 'lucide-react';
import { formatDate } from '@/lib/format';
import type { ReconciliationAlert, ReconciliationAlertType } from '@src/db/schema';
import type { Column } from '@/lib/api-types';

type Decision = 'broker' | 'app';

type ActionPreview = {
  title: string;
  description: string;
  confirmLabel: string;
  destructive: boolean;
};

function previewAction(alert: ReconciliationAlert, decision: Decision): ActionPreview {
  const expected = alert.expected as Record<string, unknown> | null;
  const actual = alert.actual as Record<string, unknown> | null;

  if (decision === 'broker') {
    switch (alert.type as ReconciliationAlertType) {
      case 'DB_ONLY':
        return {
          title: `Close DB trade for ${alert.symbol}?`,
          description:
            `Broker shows no position. The DB trade will be marked CLOSED with pnl=0 and closedAt=now. ` +
            `This is irreversible from the UI.`,
          confirmLabel: 'Close trade',
          destructive: true,
        };
      case 'QUANTITY_MISMATCH': {
        const dbQty = (expected as { dbQuantity?: number } | null)?.dbQuantity;
        const brokerQty = (actual as { brokerQuantity?: number } | null)?.brokerQuantity;
        return {
          title: `Update ${alert.symbol} quantity to match broker?`,
          description:
            `DB quantity will change from ${dbQty ?? '—'} to ${brokerQty ?? '—'}. ` +
            `The trade record is edited in place; there is no undo from the UI.`,
          confirmLabel: `Set quantity to ${brokerQty ?? '?'}`,
          destructive: true,
        };
      }
      case 'BROKER_ONLY':
      default:
        return {
          title: `Acknowledge broker position for ${alert.symbol}?`,
          description:
            `The broker position will be accepted as-is and the alert resolved. ` +
            `No DB record will be created — the position stays untracked in the app.`,
          confirmLabel: 'Acknowledge',
          destructive: false,
        };
    }
  }

  switch (alert.type as ReconciliationAlertType) {
    case 'BROKER_ONLY':
      return {
        title: `Keep app state for ${alert.symbol}?`,
        description:
          `The broker has a position the app does not track. The alert will be resolved. ` +
          `The broker position is not closed — you must flatten it manually if it should not exist.`,
        confirmLabel: 'Resolve',
        destructive: false,
      };
    case 'DB_ONLY':
      return {
        title: `Keep app state for ${alert.symbol}?`,
        description:
          `The DB trade stays OPEN. The alert will be resolved on the assumption that the broker ` +
          `flattened externally and the app is authoritative.`,
        confirmLabel: 'Resolve',
        destructive: false,
      };
    case 'QUANTITY_MISMATCH':
      return {
        title: `Keep app quantity for ${alert.symbol}?`,
        description:
          `DB quantity is unchanged. The alert will be resolved; any stray units at the broker ` +
          `must be reconciled manually.`,
        confirmLabel: 'Resolve',
        destructive: false,
      };
  }
}

function ResolveActions({
  alert,
  onResolve,
  isResolving,
}: {
  alert: ReconciliationAlert;
  onResolve: (alertId: string, decision: Decision) => Promise<unknown>;
  isResolving: boolean;
}) {
  const [pending, setPending] = useState<Decision | null>(null);

  if (alert.resolved) {
    return alert.resolvedReason
      ? <span className="text-xs text-muted-foreground">{alert.resolvedReason}</span>
      : null;
  }

  const preview = pending ? previewAction(alert, pending) : null;

  const confirm = async () => {
    if (!pending) return;
    try {
      await onResolve(alert.id, pending);
      toast.success(`Resolved ${alert.type} for ${alert.symbol}`);
      setPending(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to resolve alert');
    }
  };

  return (
    <>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="xs"
          disabled={isResolving}
          onClick={() => setPending('broker')}
        >
          Accept broker
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={isResolving}
          onClick={() => setPending('app')}
        >
          Accept app
        </Button>
      </div>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          {preview && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{preview.title}</AlertDialogTitle>
                <AlertDialogDescription>{preview.description}</AlertDialogDescription>
              </AlertDialogHeader>
              <div className="rounded-md border bg-muted/40 p-3 text-xs font-mono space-y-1">
                <div><span className="text-muted-foreground">Type:</span> {alert.type}</div>
                <div><span className="text-muted-foreground">Symbol:</span> {alert.symbol}</div>
                {alert.expected != null && (
                  <div><span className="text-muted-foreground">Expected (DB):</span> {formatState(alert.expected)}</div>
                )}
                {alert.actual != null && (
                  <div><span className="text-muted-foreground">Actual (broker):</span> {formatState(alert.actual)}</div>
                )}
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isResolving}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant={preview.destructive ? 'destructive' : 'default'}
                  disabled={isResolving}
                  onClick={(e) => {
                    e.preventDefault();
                    confirm();
                  }}
                >
                  {preview.confirmLabel}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function formatState(value: unknown): string {
  if (value == null) return '—';
  if (typeof value !== 'object') return String(value);
  return Object.entries(value as Record<string, unknown>)
    .filter(([k]) => k !== 'trades' && k !== 'positions')
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.length : v}`)
    .join(', ');
}

function useAlertColumns(
  onResolve: (alertId: string, decision: Decision) => Promise<unknown>,
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
      label: 'Expected (DB)',
      className: 'text-xs text-muted-foreground font-mono max-w-[220px] truncate',
      render: (a) => formatState(a.expected),
    },
    {
      key: 'actual',
      label: 'Actual (broker)',
      className: 'text-xs text-muted-foreground font-mono max-w-[220px] truncate',
      render: (a) => formatState(a.actual),
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
        <ResolveActions alert={a} onResolve={onResolve} isResolving={isResolving} />
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
