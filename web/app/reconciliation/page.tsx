import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useChannelId } from '@/hooks/use-channel-id';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { Link } from 'react-router-dom';
import { Badge } from '../components/badge';
import { MetricStrip, type Metric } from '../components/metric-strip';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { ShieldAlert, CheckCircle2 } from 'lucide-react';

const Spinner = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin h-6 w-6 border-2 border-muted-foreground/20 border-t-foreground rounded-full" />
  </div>
);

export default function ReconciliationPage() {
  const [params, setParams] = useSearchParams();
  const channelId = useChannelId();
  const href = useScopedHref();
  const filter = params.get('filter') ?? undefined;
  const filterResolved = filter === 'resolved' ? true : filter === 'unresolved' ? false : undefined;
  const { data: alerts, isLoading: loadingAlerts } = useQuery({
    queryKey: ['recon-alerts', channelId, filterResolved],
    queryFn: () =>
      api<any[]>(href('/recon-alerts', {
        resolved: filterResolved !== undefined ? String(filterResolved) : undefined,
      })),
  });

  const { data: stats, isLoading: loadingStats } = useQuery({
    queryKey: ['recon-stats', channelId],
    queryFn: () =>
      api<{ total: number; unresolved: number; byType: Record<string, number> }>(
        href('/recon-alerts/stats'),
      ),
  });

  const resolveMut = useApiMutation<{ alertId: string; reason: string }>(
    'POST',
    (v) => `/reconciliation/${v.alertId}/resolve`,
    { body: (v) => ({ reason: v.reason }), invalidate: [['recon-alerts'], ['recon-stats']] },
  );

  if (loadingAlerts || loadingStats || !alerts || !stats) return <Spinner />;

  const metrics: Metric[] = [
    { label: 'Total Alerts', value: stats.total, format: 'integer' },
    { label: 'Unresolved', value: stats.unresolved, format: 'integer' },
    { label: 'DB Only', value: stats.byType['DB_ONLY'] ?? 0, format: 'integer' },
    { label: 'Broker Only', value: stats.byType['BROKER_ONLY'] ?? 0, format: 'integer' },
  ];

  return (
    <div className="space-y-4">
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

      <Card className="py-0 gap-0 overflow-hidden animate-in-up">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Expected</TableHead>
                <TableHead>Actual</TableHead>
                <TableHead>Trade</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {alerts.map((alert: any) => (
                <AlertRow
                  key={alert.id}
                  alert={alert}
                  onResolve={(alertId, reason) => resolveMut.mutate({ alertId, reason })}
                  isPending={resolveMut.isPending}
                />
              ))}
            </TableBody>
          </Table>
          {alerts.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
              <CheckCircle2 className="h-8 w-8 mb-3 opacity-30" />
              <p className="text-sm">No alerts{filterResolved !== undefined ? ' matching filter' : ''}</p>
              <p className="text-xs mt-1 opacity-50">Position reconciliation alerts appear here</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AlertRow({
  alert,
  onResolve,
  isPending,
}: {
  alert: any;
  onResolve: (alertId: string, reason: string) => void;
  isPending: boolean;
}) {
  const href = useScopedHref();
  const [reason, setReason] = useState('');

  return (
    <TableRow
      className={`hover:bg-accent/40 transition-colors ${
        alert.type === 'DB_ONLY' && !alert.resolved ? 'border-l-2 border-l-loss' : ''
      }`}
    >
      <TableCell>
        <Badge label={alert.type} />
      </TableCell>
      <TableCell className="font-medium">{alert.symbol}</TableCell>
      <TableCell className="text-xs text-muted-foreground font-mono max-w-[200px] truncate">
        {alert.expected ? JSON.stringify(alert.expected) : '--'}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground font-mono max-w-[200px] truncate">
        {alert.actual ? JSON.stringify(alert.actual) : '--'}
      </TableCell>
      <TableCell>
        {alert.tradeId ? (
          <Link to={href(`/trades/${alert.tradeId}`)} className="text-xs text-info hover:underline">
            {alert.tradeId.slice(0, 8)}...
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">--</span>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {alert.createdAt ? new Date(alert.createdAt).toLocaleDateString() : '--'}
      </TableCell>
      <TableCell>
        {alert.resolved ? (
          <span className="flex items-center gap-1 text-xs text-profit">
            <CheckCircle2 className="h-3 w-3" />
            Resolved
          </span>
        ) : (
          <Badge label="UNRESOLVED" />
        )}
      </TableCell>
      <TableCell>
        {!alert.resolved && (
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
        )}
        {alert.resolved && alert.resolvedReason && (
          <span className="text-xs text-muted-foreground">{alert.resolvedReason}</span>
        )}
      </TableCell>
    </TableRow>
  );
}
