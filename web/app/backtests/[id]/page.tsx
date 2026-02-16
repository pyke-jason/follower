import { notFound } from 'next/navigation';
import { getBacktestRunById, getRunDecisions, getTradesByBacktestRun } from '@/lib/queries';
import { Badge } from '../../components/badge';
import { RunProgress } from './run-progress';

import { AutoRefresh } from '../../components/auto-refresh';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { formatCurrency } from '@/lib/format';
import { deleteBacktestRun, cancelBacktestRun } from '../actions';
import { LogViewer } from './log-viewer';
import { BacktestTabs } from './backtest-tabs';
import { EquityCurveChart } from './equity-curve-chart';
import { DrawdownChart } from './drawdown-chart';
import { BreakdownCharts } from './breakdown-charts';
import { PnlDistribution } from './pnl-distribution';
import { AgentDecisions } from './agent-decisions';
import { TradeRow } from '../../components/trade-row';
import Link from 'next/link';
import { LayoutDashboard, TrendingUp, ListTodo, Square, Trash2, Copy, ArrowLeft } from 'lucide-react';
import type { BacktestRunConfig, BacktestRunSummary } from '../../../../src/db/schema';

import { PROFIT_FACTOR_INF, pctDisplay } from '../../../../src/lib/numbers';

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

  const showData = run.status === 'COMPLETED' || run.status === 'RUNNING' || run.status === 'CANCELLED';
  const [decisions, closedTrades] = await Promise.all([
    showData ? getRunDecisions(id) : Promise.resolve([]),
    showData ? getTradesByBacktestRun(id, { includeOpen: run.status !== 'COMPLETED' }) : Promise.resolve([]),
  ]);


  // --- Performance Tab content ---
  const hasDrawdown = (() => {
    if (!equityCurve) return false;
    let peak = 0;
    for (const pt of equityCurve) {
      if (pt.cumPnl > peak) peak = pt.cumPnl;
      if (peak - pt.cumPnl > 0) return true;
    }
    return false;
  })();

  const noData = (h = 200) => (
    <div className={`flex items-center justify-center text-xs text-muted-foreground`} style={{ height: h }}>
      No data yet
    </div>
  );

  const performanceContent = (
    <div className="space-y-4">
      {/* Row 1: Equity Curve + Drawdown side by side */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-[3fr_2fr]">
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Equity Curve</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            {equityCurve && equityCurve.length > 0
              ? <EquityCurveChart data={equityCurve} />
              : noData(250)}
          </CardContent>
        </Card>
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Drawdown</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            {equityCurve && equityCurve.length > 0 && hasDrawdown
              ? <DrawdownChart data={equityCurve} />
              : noData(200)}
          </CardContent>
        </Card>
      </div>

      {/* Row 2: Breakdown Charts (always 2-col) */}
      <BreakdownCharts byTrader={byTrader} byStrategy={byStrategy} runId={id} />

      {/* Row 3: P&L Distribution */}
      <Card className="py-0 gap-0">
        <CardHeader className="border-b py-3 px-4">
          <CardTitle className="text-sm">P&L Distribution</CardTitle>
        </CardHeader>
        <CardContent className="pt-4 pb-2 px-2">
          {closedTrades.length > 0
            ? <PnlDistribution trades={closedTrades} />
            : noData(200)}
        </CardContent>
      </Card>
    </div>
  );

  // --- Agent Decisions Tab content ---
  const decisionsContent = decisions.length > 0 ? (
    <AgentDecisions rows={decisions} backtestRunId={id} />
  ) : (
    <p className="text-sm text-muted-foreground text-center py-6">
      No agent decisions recorded for this run.
    </p>
  );

  // --- Trades Tab content ---
  const tradesContent = closedTrades.length > 0 ? (
    <Card className="py-0 gap-0 overflow-hidden">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead>Trader</TableHead>
              <TableHead>Direction</TableHead>
              <TableHead>Strategy</TableHead>
              <TableHead className="text-right">Entry</TableHead>
              <TableHead className="text-right">Exit</TableHead>
              <TableHead className="text-right">P&L</TableHead>
              <TableHead>Opened</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {closedTrades.map((t) => (
              <TradeRow key={t.id} trade={t} runId={id} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  ) : (
    <p className="text-sm text-muted-foreground text-center py-6">
      No closed trades for this run.
    </p>
  );

  // Consistent layout: same order regardless of state.
  // Sections show/hide but never move position.


  return (
    <div className="space-y-4 animate-in-up pb-6">
      {isRunning && <AutoRefresh intervalMs={3000} />}

        {/* Header with action toolbar */}
        <div className="flex items-center gap-3">
          <Link href="/backtests" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h2 className="text-lg font-bold text-foreground tracking-tight">Backtest Run</h2>
          <Badge label={run.status} />
          {run.name && <span className="text-sm text-muted-foreground">{run.name}</span>}

          <div className="flex items-center gap-1.5 ml-auto">
            <Button variant="ghost" size="xs" asChild>
              <Link href={`/backtests/new?clone=${run.id}`}>
                <Copy className="size-3" /> Clone &amp; Edit
              </Link>
            </Button>
            <Separator orientation="vertical" className="!h-4 mx-1" />
            <Button variant="ghost" size="xs" asChild>
              <Link href={`/?run=${run.id}`}>
                <LayoutDashboard className="size-3" /> Dashboard
              </Link>
            </Button>
            <Button variant="ghost" size="xs" asChild>
              <Link href={`/trades?run=${run.id}`}>
                <TrendingUp className="size-3" /> Trades
              </Link>
            </Button>
            <Button variant="ghost" size="xs" asChild>
              <Link href={`/tasks?run=${run.id}`}>
                <ListTodo className="size-3" /> Tasks
              </Link>
            </Button>
            {isRunning && (
              <>
                <Separator orientation="vertical" className="!h-4 mx-1" />
                <form action={cancelBacktestRun}>
                  <input type="hidden" name="runId" value={run.id} />
                  <Button type="submit" variant="secondary" size="xs">
                    <Square className="size-3" /> Cancel
                  </Button>
                </form>
              </>
            )}
            <Separator orientation="vertical" className="!h-4 mx-1" />
            <form action={deleteBacktestRun}>
              <input type="hidden" name="runId" value={run.id} />
              <Button type="submit" variant="ghost" size="xs" className="text-red-400 hover:text-red-300 hover:bg-red-950">
                <Trash2 className="size-3" /> Delete
              </Button>
            </form>
          </div>
        </div>

        {/* Compact info bar: config left, metrics right */}
        <div className="flex items-center gap-4 rounded-lg border bg-card px-4 py-2.5 text-sm flex-wrap">
          {/* Config */}
          <span className="text-foreground font-medium">{config.traders.join(', ')}</span>
          <Separator orientation="vertical" className="!h-4" />
          <span className="text-muted-foreground tabular-nums">{config.startDate.split('T')[0]} &ndash; {config.endDate.split('T')[0]}</span>
          <Separator orientation="vertical" className="!h-4" />
          <span className="text-muted-foreground">{config.agentModel ?? 'default'}</span>
          {summary && (
            <>
              <Separator orientation="vertical" className="!h-4" />
              <div className="flex items-center gap-3 ml-auto tabular-nums">
                <span className="text-muted-foreground"><span className="text-foreground font-semibold">{summary.totalTrades}</span> trades</span>
                <span className="text-muted-foreground"><span className="text-foreground font-semibold">{pctDisplay(summary.winRate)}</span> win</span>
                <span className={summary.totalPnl >= 0 ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>{formatCurrency(summary.totalPnl)}</span>
                <span className="text-muted-foreground">DD <span className="text-foreground font-semibold">{formatCurrency(summary.maxDrawdown)}</span></span>
                <span className="text-muted-foreground">PF <span className="text-foreground font-semibold">{(summary.profitFactor >= PROFIT_FACTOR_INF ? 99.99 : (summary.profitFactor ?? 0)).toFixed(2)}</span></span>
              </div>
            </>
          )}
        </div>

        {/* Progress — only while running */}
        {isRunning && (
          <RunProgress runId={id} totalMessages={summary?.totalMessages} />
        )}

        {/* Error — only when there is one (hide for cancelled runs) */}
        {run.error && run.status !== 'CANCELLED' && (
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

        {/* Tabs — always in this slot when data exists */}
      <BacktestTabs
        performance={performanceContent}
        decisions={decisionsContent}
        trades={tradesContent}
        hasDecisions={decisions.length > 0}
      />

      {/* Anchored log panel */}
      <LogViewer
        runId={id}
        isRunning={isRunning}
        defaultCollapsed
      />
    </div>
  );
}
