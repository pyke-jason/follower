import { getBacktestRuns } from '@/lib/queries';
import { Badge } from '../components/badge';
import { AutoRefresh } from '../components/auto-refresh';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDate } from '@/lib/format';
import Link from 'next/link';
import type { BacktestRunConfig, BacktestRunSummary } from '../../../src/db/schema';

export const dynamic = 'force-dynamic';

function formatDuration(ms: number | null): string {
  if (ms == null) return '--';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default async function BacktestsPage() {
  const runs = await getBacktestRuns();

  const hasRunning = runs.some((r) => r.status === 'RUNNING' || r.status === 'PENDING');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-foreground">Backtests</h2>
        <Button size="sm" asChild>
          <Link href="/backtests/new">New Backtest</Link>
        </Button>
      </div>

      {hasRunning && <AutoRefresh intervalMs={3000} />}

      <Card className="py-0 gap-0 overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs text-muted-foreground uppercase">Status</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Traders</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Date Range</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Trades</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Win Rate</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">P&L</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Duration</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const config = run.config as BacktestRunConfig;
                const summary = run.summary as BacktestRunSummary | null;
                const startDate = config.startDate.split('T')[0];
                const endDate = config.endDate.split('T')[0];

                return (
                  <TableRow key={run.id}>
                    <TableCell>
                      <Link href={`/backtests/${run.id}`} className="inline-block">
                        <Badge label={run.status} />
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <Link href={`/backtests/${run.id}`} className="hover:underline text-blue-400">
                        {config.traders.join(', ')}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {startDate} &ndash; {endDate}
                    </TableCell>
                    <TableCell>{summary?.totalTrades ?? '--'}</TableCell>
                    <TableCell>
                      {summary ? `${(summary.winRate * 100).toFixed(1)}%` : '--'}
                    </TableCell>
                    <TableCell className={summary && summary.totalPnl > 0 ? 'text-emerald-400' : summary && summary.totalPnl < 0 ? 'text-red-400' : ''}>
                      {summary ? formatCurrency(summary.totalPnl) : '--'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDuration(run.durationMs)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDate(run.createdAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {runs.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">
              No backtest runs yet
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
