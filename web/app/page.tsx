import Link from 'next/link';
import { StatCard } from './components/stat-card';
import { Badge } from './components/badge';
import { RunBanner } from './components/run-banner';
import { Card, CardHeader, CardTitle, CardAction, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { getStats, getOpenTrades, getPendingReviews } from '@/lib/queries';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';

export const dynamic = 'force-dynamic';

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const { run: runId } = await searchParams;

  const [stats, openTrades, pendingReviews] = await Promise.all([
    getStats(runId),
    getOpenTrades(5, runId),
    getPendingReviews(5, runId),
  ]);

  const pnlColorClass = stats.todayPnl > 0
    ? 'text-emerald-400'
    : stats.todayPnl < 0
      ? 'text-red-400'
      : 'text-muted-foreground';

  return (
    <div className="space-y-6">
      {runId && <RunBanner runId={runId} currentPath="/" />}

      <h2 className="text-xl font-bold text-foreground">Overview</h2>

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Open Trades" value={stats.openTrades} />
        <StatCard
          label={runId ? 'Total P&L' : 'Today P&L'}
          value={formatCurrency(stats.todayPnl)}
          color={pnlColorClass}
        />
        <StatCard label="Pending Tasks" value={stats.pendingTasks} />
      </div>

      {/* Open Positions */}
      <Card className="py-0 gap-0">
        <CardHeader className="border-b py-3 px-4">
          <CardTitle className="text-sm">Open Positions</CardTitle>
          <CardAction>
            <Link href={buildHref('/trades/open', runId)} className="text-xs text-blue-400 hover:underline">
              View all
            </Link>
          </CardAction>
        </CardHeader>
        <CardContent className="p-0">
          {openTrades.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">
              No open positions
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Symbol</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Trader</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Direction</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Strategy</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Entry</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Opened</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {openTrades.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="px-4">
                      <Link href={buildHref(`/trades/${t.id}`, runId)} className="text-blue-400 hover:underline">
                        {t.symbol}
                      </Link>
                    </TableCell>
                    <TableCell className="px-4 text-muted-foreground">{t.trader}</TableCell>
                    <TableCell className="px-4"><Badge label={t.direction} /></TableCell>
                    <TableCell className="px-4"><Badge label={t.strategy} /></TableCell>
                    <TableCell className="px-4">{formatCurrency(t.entryPrice)}</TableCell>
                    <TableCell className="px-4 text-muted-foreground">{formatDate(t.openedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pending Reviews */}
      <Card className="py-0 gap-0">
        <CardHeader className="border-b py-3 px-4">
          <CardTitle className="text-sm">Pending Reviews</CardTitle>
          <CardAction>
            <Link href={buildHref('/tasks?status=PENDING', runId)} className="text-xs text-blue-400 hover:underline">
              View all
            </Link>
          </CardAction>
        </CardHeader>
        <CardContent className="p-0">
          {pendingReviews.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">
              No pending reviews
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Type</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Status</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingReviews.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="px-4">
                      <Link href={buildHref(`/tasks/${t.id}`, runId)} className="text-blue-400 hover:underline">
                        {t.taskType}
                      </Link>
                    </TableCell>
                    <TableCell className="px-4"><Badge label={t.status} /></TableCell>
                    <TableCell className="px-4 text-muted-foreground">{formatDate(t.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
