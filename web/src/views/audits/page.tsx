import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, ShieldAlert, XCircle } from 'lucide-react';
import { Badge } from '@/components/badge';
import { DataTable } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { MetricStrip, type Metric } from '@/components/metric-strip';
import { QueryBoundary, TableSkeleton } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useAuditAlerts } from '@/hooks/use-audit-alerts';
import { useAuditParams } from '@/hooks/use-audit-params';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { formatDate } from '@/lib/format';
import type { Column } from '@/lib/api-types';
import type { ClassificationAuditRow, ClassificationAuditStatus } from '@src/local-api/http-schemas';

const STATUS_OPTIONS: ClassificationAuditStatus[] = ['open', 'resolved', 'dismissed'];
const SEVERITY_OPTIONS = ['critical', 'warning', 'info'] as const;

function label(value: string | null): string {
  return value ? value.replaceAll('_', ' ') : '--';
}

function clipped(value: string, max = 140): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

function AuditActions({
  audit,
  onStatus,
  disabled,
}: {
  audit: ClassificationAuditRow;
  onStatus: (auditId: string, status: 'resolved' | 'dismissed', reason?: string) => Promise<unknown>;
  disabled: boolean;
}) {
  if (audit.status !== 'open') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <CheckCircle2 className="h-3 w-3" />
        {audit.status}
      </span>
    );
  }

  const update = async (status: 'resolved' | 'dismissed') => {
    try {
      await onStatus(audit.id, status, `Marked ${status} from Audit Alerts`);
      toast.success(`${status === 'resolved' ? 'Resolved' : 'Dismissed'} audit`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update audit');
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Button variant="outline" size="xs" disabled={disabled} onClick={() => update('resolved')}>
        <CheckCircle2 />
        Resolve
      </Button>
      <Button variant="ghost" size="xs" disabled={disabled} onClick={() => update('dismissed')}>
        <XCircle />
        Dismiss
      </Button>
    </div>
  );
}

function useAuditColumns(
  onStatus: (auditId: string, status: 'resolved' | 'dismissed', reason?: string) => Promise<unknown>,
  isResolving: boolean,
): Column<ClassificationAuditRow>[] {
  const href = useScopedHref();

  return [
    {
      key: 'severity',
      label: 'Severity',
      sortable: true,
      render: (row) => <Badge label={row.severity.toUpperCase()} />,
    },
    {
      key: 'finding',
      label: 'Finding',
      className: 'max-w-[280px]',
      render: (row) => (
        <div className="space-y-1">
          <div className="text-sm font-medium leading-tight">{row.title}</div>
          <div className="text-xs text-muted-foreground leading-snug" title={row.details}>
            {clipped(row.details, 110)}
          </div>
          <div className="text-[10px] font-mono uppercase text-muted-foreground/60">
            {label(row.category)}
          </div>
        </div>
      ),
    },
    {
      key: 'message',
      label: 'Message',
      className: 'max-w-[320px]',
      render: (row) => (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground" title={row.payload.message.cleanText}>
            {clipped(row.payload.message.cleanText)}
          </div>
          <div className="text-[10px] font-mono text-muted-foreground/60">
            {row.payload.message.author}
          </div>
        </div>
      ),
    },
    {
      key: 'classifier',
      label: 'Classifier',
      className: 'max-w-[190px]',
      render: (row) => (
        <div className="space-y-1">
          {row.payload.classifier.outcome ? (
            <Badge label={row.payload.classifier.outcome} />
          ) : (
            <span className="text-xs text-muted-foreground">--</span>
          )}
          <div className="text-[10px] font-mono text-muted-foreground/60">
            {row.payload.classifier.model ?? row.payload.classifier.provider ?? '--'}
          </div>
          {row.payload.classifier.route && (
            <div className="text-[10px] text-muted-foreground/60" title={row.payload.classifier.route}>
              {clipped(row.payload.classifier.route, 42)}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'links',
      label: 'Links',
      className: 'text-xs',
      render: (row) => (
        <div className="flex flex-col gap-1">
          {row.taskId && (
            <Link to={href(`/tasks/${row.taskId}`)} className="text-info hover:underline">
              task {row.taskId.slice(0, 8)}
            </Link>
          )}
          {row.payload.execution.tradeId && (
            <Link to={href(`/trades/${row.payload.execution.tradeId}`)} className="text-info hover:underline">
              trade {row.payload.execution.tradeId.slice(0, 8)}
            </Link>
          )}
          {!row.taskId && !row.payload.execution.tradeId && (
            <span className="text-muted-foreground">--</span>
          )}
        </div>
      ),
    },
    {
      key: 'createdAt',
      label: 'Created',
      sortable: true,
      className: 'text-xs text-muted-foreground font-mono tabular-nums',
      render: (row) => formatDate(row.createdAt),
    },
    {
      key: 'status',
      label: 'Status',
      render: (row) => <Badge label={row.status} />,
    },
    {
      key: 'action',
      label: 'Action',
      render: (row) => (
        <AuditActions audit={row} onStatus={onStatus} disabled={isResolving} />
      ),
    },
  ];
}

export default function AuditAlertsPage() {
  const { status, severity, setStatus, setSeverity } = useAuditParams();
  const { alerts, stats, total, isLoading, setStatus: updateAuditStatus, isResolving, alertsQuery, statsQuery } =
    useAuditAlerts(status, severity);
  const columns = useAuditColumns(updateAuditStatus, isResolving);

  const combinedQuery = {
    data: stats ? { rows: alerts, stats, total } : undefined,
    isLoading,
    isError: alertsQuery.isError || statsQuery.isError,
    error: alertsQuery.error || statsQuery.error,
    refetch: () => { alertsQuery.refetch(); statsQuery.refetch(); },
  };

  return (
    <QueryBoundary query={combinedQuery} skeleton={<TableSkeleton rows={12} cols={8} />}>
      {(data) => (
        <AuditAlertsContent
          rows={data.rows}
          total={data.total}
          stats={data.stats}
          columns={columns}
          status={status}
          severity={severity}
          setStatus={setStatus}
          setSeverity={setSeverity}
        />
      )}
    </QueryBoundary>
  );
}

function AuditAlertsContent({
  rows,
  total,
  stats,
  columns,
  status,
  severity,
  setStatus,
  setSeverity,
}: {
  rows: ClassificationAuditRow[];
  total: number;
  stats: NonNullable<ReturnType<typeof useAuditAlerts>['stats']>;
  columns: Column<ClassificationAuditRow>[];
  status: string;
  severity: string;
  setStatus: (status: string | null) => void;
  setSeverity: (severity: string | null) => void;
}) {
  const metrics: Metric[] = [
    { label: 'Open', value: stats.open, format: 'integer', tone: stats.open > 0 ? 'warning' : undefined },
    { label: 'Critical', value: stats.critical, format: 'integer', tone: stats.critical > 0 ? 'danger' : undefined },
    { label: 'Warning', value: stats.warning, format: 'integer' },
    { label: 'Filtered', value: total, format: 'integer' },
  ];

  return (
    <div className="h-full flex flex-col gap-4 pb-2">
      <div className="flex items-center gap-3">
        <ShieldAlert className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold text-foreground">Audit Alerts</h2>
      </div>

      <MetricStrip metrics={metrics} />

      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          type="single"
          value={status}
          onValueChange={(value) => setStatus(value || 'open')}
          className="flex-wrap"
          size="sm"
          variant="outline"
        >
          {STATUS_OPTIONS.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              {option}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <ToggleGroup
          type="single"
          value={severity || 'all'}
          onValueChange={(value) => setSeverity(value === 'all' ? null : value || null)}
          className="flex-wrap"
          size="sm"
          variant="outline"
        >
          <ToggleGroupItem value="all">all severity</ToggleGroupItem>
          {SEVERITY_OPTIONS.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              {option}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          variant={severity ? 'filtered' : 'default'}
          title={severity ? 'No alerts matching filter' : 'No audit alerts'}
          icon={<ShieldAlert className="h-8 w-8" />}
        />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          defaultSort={{ column: 'createdAt', dir: 'desc' }}
          className="flex-1 min-h-0"
          getRowKey={(row) => row.id}
          rowClassName={(row) => row.severity === 'critical' && row.status === 'open' ? 'bg-destructive/5' : ''}
        />
      )}
    </div>
  );
}
