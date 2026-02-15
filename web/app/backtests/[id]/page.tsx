import { notFound } from 'next/navigation';
import { getBacktestRunById, getRunDecisions, getTradesByBacktestRun } from '@/lib/queries';
import { Badge } from '../../components/badge';
import { MetricStrip } from '../../components/metric-strip';
import { InfoChip } from '../../components/info-chip';
import { RunProgress } from './run-progress';
import type { Metric } from '../../components/metric-strip';
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
import { LayoutDashboard, TrendingUp, ListTodo, Square, Trash2, Copy, ArrowLeft, Cpu, Bot, DollarSign } from 'lucide-react';
import type { BacktestRunConfig, BacktestRunSummary } from '../../../../src/db/schema';
import type { ExtendedMetrics } from '../../../../src/backtest/types';
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
  const extendedMetrics = run.extendedMetrics as ExtendedMetrics | null;
  const isRunning = run.status === 'RUNNING' || run.status === 'PENDING';

  const showData = run.status === 'COMPLETED' || run.status === 'RUNNING' || run.status === 'CANCELLED';
  const [decisions, closedTrades] = await Promise.all([
    showData ? getRunDecisions(id) : Promise.resolve([]),
    showData ? getTradesByBacktestRun(id, { includeOpen: run.status !== 'COMPLETED' }) : Promise.resolve([]),
  ]);

  const hasTabData = !!(summary || closedTrades.length > 0 || decisions.length > 0);

  // --- Performance Tab content ---
  const performanceContent = (
    <div className="space-y-4">
      {/* Equity Curve Chart */}
      {equityCurve && equityCurve.length > 0 && (
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Equity Curve</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            <EquityCurveChart data={equityCurve} />
          </CardContent>
        </Card>
      )}

      {/* Drawdown Chart */}
      {equityCurve && equityCurve.length > 0 && (
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Drawdown</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            <DrawdownChart data={equityCurve} />
          </CardContent>
        </Card>
      )}

      {/* Breakdown Charts */}
      <BreakdownCharts byTrader={byTrader} byStrategy={byStrategy} runId={id} />

      {/* P&L Distribution */}
      {closedTrades.length > 0 && (
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">P&L Distribution</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            <PnlDistribution trades={closedTrades} />
          </CardContent>
        </Card>
      )}

      {/* Risk & Stats */}
      {(extendedMetrics || summary) && (
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Risk & Stats</CardTitle>
          </CardHeader>
          <CardContent className="py-4">
            {extendedMetrics && (
              <div className="grid grid-cols-3 md:grid-cols-4 gap-x-6 gap-y-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Sharpe</p>
                  <p className="text-foreground font-medium tabular-nums text-sm">{extendedMetrics.sharpeRatio.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Sortino</p>
                  <p className="text-foreground font-medium tabular-nums text-sm">{extendedMetrics.sortinoRatio.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Calmar</p>
                  <p className="text-foreground font-medium tabular-nums text-sm">{extendedMetrics.calmarRatio.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Recovery</p>
                  <p className="text-foreground font-medium tabular-nums text-sm">{extendedMetrics.recoveryFactor.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Consec. Wins</p>
                  <p className="text-emerald-400 font-medium tabular-nums text-sm">{extendedMetrics.maxConsecutiveWins}</p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Consec. Losses</p>
                  <p className="text-red-400 font-medium tabular-nums text-sm">{extendedMetrics.maxConsecutiveLosses}</p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Avg Holding</p>
                  <p className="text-foreground font-medium tabular-nums text-sm">
                    {extendedMetrics.avgHoldingPeriodHours >= 24
                      ? `${(extendedMetrics.avgHoldingPeriodHours / 24).toFixed(1)}d`
                      : `${extendedMetrics.avgHoldingPeriodHours.toFixed(1)}h`}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Median P&L</p>
                  <p className={`font-medium tabular-nums text-sm ${extendedMetrics.medianPnl > 0 ? 'text-emerald-400' : extendedMetrics.medianPnl < 0 ? 'text-red-400' : 'text-foreground'}`}>
                    {formatCurrency(extendedMetrics.medianPnl)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Std Dev</p>
                  <p className="text-foreground font-medium tabular-nums text-sm">{formatCurrency(extendedMetrics.pnlStdDev)}</p>
                </div>
                {summary && (
                  <>
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Avg Win</p>
                      <p className="text-emerald-400 font-medium tabular-nums text-sm">{formatCurrency(summary.avgWin)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Avg Loss</p>
                      <p className="text-red-400 font-medium tabular-nums text-sm">{formatCurrency(summary.avgLoss)}</p>
                    </div>
                  </>
                )}
              </div>
            )}
            {/* Agent metadata as chips */}
            {summary && (
              <div className="flex items-center gap-2 flex-wrap mt-4 pt-3 border-t border-border/50">
                <InfoChip label={`${config.agentProvider ?? 'anthropic'}/${config.agentModel ?? 'default'}`} icon={Cpu} />
                <InfoChip label={`${summary.agentCallsUsed} agent calls`} />
                <InfoChip label={`${summary.agentTrades} agent trades`} icon={Bot} />
                <InfoChip label={`${summary.deterministicTrades} deterministic`} />
                {config.fillModel && <InfoChip label={`${config.fillModel} fill`} />}
                {summary.agentCallsUsed > 0 && (
                  <InfoChip label={`~${formatCurrency(summary.agentCallsUsed * 0.012)} est. cost`} icon={DollarSign} />
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
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

  // --- Status-aware content sections ---
  const errorCard = run.error ? (
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
  ) : null;

  const tabs = hasTabData ? (
    <BacktestTabs
      performance={performanceContent}
      decisions={decisionsContent}
      trades={tradesContent}
      hasDecisions={decisions.length > 0}
    />
  ) : null;

  function renderBody() {
    switch (run.status) {
      case 'COMPLETED':
        return (
          <>
            {tabs}
            <LogViewer runId={id} isRunning={false} defaultCollapsed />
          </>
        );

      case 'FAILED':
        return (
          <>
            {errorCard}
            <LogViewer runId={id} isRunning={false} />
          </>
        );

      case 'CANCELLED':
        return (
          <>
            {errorCard}
            {tabs}
            <LogViewer runId={id} isRunning={false} defaultCollapsed />
          </>
        );

      // RUNNING / PENDING
      default:
        return (
          <>
            <RunProgress runId={id} totalMessages={summary?.totalMessages} />
            <LogViewer runId={id} isRunning={isRunning} />
            {tabs}
          </>
        );
    }
  }

  // Build MetricStrip for top-level summary
  const topMetrics: Metric[] = summary ? [
    { label: 'Trades', value: summary.totalTrades, format: 'integer' },
    { label: 'Win Rate', value: summary.winRate * 100, format: 'percent' },
    { label: 'Total P&L', value: summary.totalPnl, format: 'currency', colorBySign: true },
    { label: 'Max Drawdown', value: summary.maxDrawdown, format: 'currency', colorBySign: true },
    { label: 'Profit Factor', value: summary.profitFactor >= PROFIT_FACTOR_INF ? 99.99 : (summary.profitFactor ?? 0), format: 'decimal' },
  ] : [];

  return (
    <div className="space-y-6 max-w-6xl animate-in-up">
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
          {(run.status === 'COMPLETED' || run.status === 'RUNNING' || run.status === 'CANCELLED') && (
            <>
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
            </>
          )}
          {(isRunning || run.status === 'COMPLETED' || run.status === 'RUNNING') && (
            <Separator orientation="vertical" className="!h-4 mx-1" />
          )}
          {isRunning && (
            <form action={cancelBacktestRun}>
              <input type="hidden" name="runId" value={run.id} />
              <Button type="submit" variant="secondary" size="xs">
                <Square className="size-3" /> Cancel
              </Button>
            </form>
          )}
          <form action={deleteBacktestRun}>
            <input type="hidden" name="runId" value={run.id} />
            <Button type="submit" variant="ghost" size="xs" className="text-red-400 hover:text-red-300 hover:bg-red-950">
              <Trash2 className="size-3" /> Delete
            </Button>
          </form>
        </div>
      </div>

      {/* Config */}
      <Card className="py-4 gap-0">
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Traders</p>
            <p className="text-foreground font-medium">{config.traders.join(', ')}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Date Range</p>
            <p className="text-foreground tabular-nums">
              {config.startDate.split('T')[0]} &ndash; {config.endDate.split('T')[0]}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Agent</p>
            <p className="text-foreground">{config.agentProvider ?? 'anthropic'}/{config.agentModel ?? 'default'}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Quote Tape</p>
            <p className="text-foreground">{config.useQuoteTape ? 'Enabled' : 'Disabled'}</p>
          </div>
        </CardContent>
      </Card>

      {/* Summary MetricStrip */}
      {topMetrics.length > 0 && (
        <MetricStrip metrics={topMetrics} />
      )}

      {/* Status-aware body */}
      {renderBody()}
    </div>
  );
}
