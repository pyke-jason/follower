import { notFound } from 'next/navigation';
import { getBacktestRunById } from '@/lib/queries';
import { Badge } from '../../components/badge';
import { StatCard } from '../../components/stat-card';
import { AutoRefresh } from '../../components/auto-refresh';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/format';
import { deleteBacktestRun } from '../actions';
import Link from 'next/link';
import type { BacktestRunConfig, BacktestRunSummary } from '../../../../src/db/schema';

export const dynamic = 'force-dynamic';

export default async function BacktestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const run = await getBacktestRunById(id);
  if (!run) notFound();

  const config = run.config as BacktestRunConfig;
  const summary = run.summary as BacktestRunSummary | null;
  const byTrader = run.byTrader as Record<string, { trades: number; wins: number; losses: number; winRate: number; totalPnl: number }> | null;
  const byStrategy = run.byStrategy as Record<string, { trades: number; wins: number; losses: number; winRate: number; totalPnl: number; avgPnl: number }> | null;
  const equityCurve = run.equityCurve as { date: string; pnl: number; cumPnl: number; trades: number }[] | null;
  const isRunning = run.status === 'RUNNING' || run.status === 'PENDING';

  return (
    <div className="space-y-6 max-w-4xl">
      {isRunning && <AutoRefresh intervalMs={3000} />}

      <div className="flex items-center gap-3">
        <Link href="/backtests" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Backtests
        </Link>
        <h2 className="text-xl font-bold text-foreground">Backtest Run</h2>
        <Badge label={run.status} />
      </div>

      {/* Config */}
      <Card className="py-4 gap-0">
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Traders</p>
            <p className="text-foreground">{config.traders.join(', ')}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Date Range</p>
            <p className="text-foreground">
              {config.startDate.split('T')[0]} &ndash; {config.endDate.split('T')[0]}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Mode</p>
            <p className="text-foreground">{config.useAgent ? 'Hybrid (agent)' : 'Deterministic'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Slippage</p>
            <p className="text-foreground">{(config.slippagePct * 100).toFixed(1)}%</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Quote Tape</p>
            <p className="text-foreground">{config.useQuoteTape ? 'Enabled' : 'Disabled'}</p>
          </div>
        </CardContent>
      </Card>

      {/* Summary Metrics */}
      {summary && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatCard label="Total Trades" value={summary.totalTrades} />
            <StatCard
              label="Win Rate"
              value={`${(summary.winRate * 100).toFixed(1)}%`}
              color={summary.winRate >= 0.5 ? 'text-emerald-400' : 'text-red-400'}
            />
            <StatCard
              label="Total P&L"
              value={formatCurrency(summary.totalPnl)}
              color={summary.totalPnl > 0 ? 'text-emerald-400' : summary.totalPnl < 0 ? 'text-red-400' : 'text-foreground'}
            />
            <StatCard
              label="Max Drawdown"
              value={formatCurrency(summary.maxDrawdown)}
              color="text-red-400"
            />
            <StatCard label="Profit Factor" value={summary.profitFactor.toFixed(2)} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Avg Win" value={formatCurrency(summary.avgWin)} color="text-emerald-400" />
            <StatCard label="Avg Loss" value={formatCurrency(summary.avgLoss)} color="text-red-400" />
            <StatCard label="Deterministic" value={summary.deterministicTrades} />
            <StatCard label="Agent Trades" value={summary.agentTrades} />
          </div>
        </>
      )}

      {/* By Trader */}
      {byTrader && Object.keys(byTrader).length > 0 && (
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">By Trader</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Trader</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Trades</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Wins</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Losses</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Win Rate</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">P&L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(byTrader).map(([name, stats]) => (
                  <TableRow key={name}>
                    <TableCell className="px-4 font-medium">{name}</TableCell>
                    <TableCell className="px-4">{stats.trades}</TableCell>
                    <TableCell className="px-4 text-emerald-400">{stats.wins}</TableCell>
                    <TableCell className="px-4 text-red-400">{stats.losses}</TableCell>
                    <TableCell className="px-4">{(stats.winRate * 100).toFixed(1)}%</TableCell>
                    <TableCell className={`px-4 font-medium ${stats.totalPnl > 0 ? 'text-emerald-400' : stats.totalPnl < 0 ? 'text-red-400' : ''}`}>
                      {formatCurrency(stats.totalPnl)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* By Strategy */}
      {byStrategy && Object.keys(byStrategy).length > 0 && (
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">By Strategy</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Strategy</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Trades</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Win Rate</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Total P&L</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Avg P&L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(byStrategy).map(([name, stats]) => (
                  <TableRow key={name}>
                    <TableCell className="px-4 font-medium">{name}</TableCell>
                    <TableCell className="px-4">{stats.trades}</TableCell>
                    <TableCell className="px-4">{(stats.winRate * 100).toFixed(1)}%</TableCell>
                    <TableCell className={`px-4 font-medium ${stats.totalPnl > 0 ? 'text-emerald-400' : stats.totalPnl < 0 ? 'text-red-400' : ''}`}>
                      {formatCurrency(stats.totalPnl)}
                    </TableCell>
                    <TableCell className={`px-4 ${stats.avgPnl > 0 ? 'text-emerald-400' : stats.avgPnl < 0 ? 'text-red-400' : ''}`}>
                      {formatCurrency(stats.avgPnl)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Equity Curve */}
      {equityCurve && equityCurve.length > 0 && (
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Equity Curve</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Date</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Daily P&L</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Cumulative</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Trades</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {equityCurve.map((pt) => (
                  <TableRow key={pt.date}>
                    <TableCell className="px-4 text-muted-foreground">{pt.date}</TableCell>
                    <TableCell className={`px-4 ${pt.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {formatCurrency(pt.pnl)}
                    </TableCell>
                    <TableCell className={`px-4 font-medium ${pt.cumPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {formatCurrency(pt.cumPnl)}
                    </TableCell>
                    <TableCell className="px-4">{pt.trades}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Action Buttons */}
      <div className="flex gap-2">
        {run.status === 'COMPLETED' && (
          <>
            <Button size="sm" asChild>
              <Link href={`/?run=${run.id}`}>Browse Dashboard</Link>
            </Button>
            <Button size="sm" variant="secondary" asChild>
              <Link href={`/trades?run=${run.id}`}>Browse Trades</Link>
            </Button>
            <Button size="sm" variant="secondary" asChild>
              <Link href={`/tasks?run=${run.id}`}>Browse Tasks</Link>
            </Button>
          </>
        )}
        <form action={deleteBacktestRun}>
          <input type="hidden" name="runId" value={run.id} />
          <Button type="submit" variant="destructive" size="sm">
            Delete Run
          </Button>
        </form>
      </div>

      {/* Error */}
      {run.error && (
        <Card className="py-4 gap-2 border-red-800 bg-red-950">
          <CardHeader className="py-0">
            <CardTitle className="text-sm text-red-400">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs text-red-300 whitespace-pre-wrap font-mono">
              {run.error}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
