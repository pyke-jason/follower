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
import { TradeScatter } from './trade-scatter';
import { RollingWinRate } from './rolling-win-rate';
import { StrategyEquityChart } from './strategy-equity';
import { AgentDecisions } from './agent-decisions';
import { TradeRow } from '../../components/trade-row';
import Link from 'next/link';
import { LayoutDashboard, TrendingUp, ListTodo, Square, Trash2, Copy, ArrowLeft } from 'lucide-react';
import type { BacktestRunConfig, BacktestRunSummary } from '../../../../src/db/schema';
import type { LiveMetrics } from '../../../../src/backtest/types';

import { PROFIT_FACTOR_INF, pctDisplay, roundCents } from '../../../../src/lib/numbers';

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
  const isRunning = run.status === 'RUNNING' || run.status === 'PENDING';

  const [decisions, allTrades] = await Promise.all([
    getRunDecisions(id),
    getTradesByBacktestRun(id, { includeOpen: true }),
  ]);

  const closedTrades = allTrades.filter((t) => t.status === 'CLOSED');

  // Compute everything from the trades table — works identically for
  // in-progress and completed runs, no precomputed JSON columns needed.
  const { summary, byTrader, byStrategy, equityCurve, tradeScatter, rollingWinRate, strategyEquity, strategies } = computeFromTrades(closedTrades, allTrades.length, run.summary as BacktestRunSummary | null);

  // Compute LLM token sums from already-loaded decisions — zero extra DB queries
  const llmTokens = decisions.reduce(
    (acc, d) => ({
      input: acc.input + (d.decision.inputTokens ?? 0),
      output: acc.output + (d.decision.outputTokens ?? 0),
    }),
    { input: 0, output: 0 },
  );
  const liveMetrics = run.liveMetrics as LiveMetrics | null;


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
      {/* Row 1: Equity Curve + Drawdown */}
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

      {/* Row 2: Trade Scatter + Rolling Win Rate */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-[3fr_2fr]">
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Trade Scatter</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            {tradeScatter.length > 0
              ? <TradeScatter data={tradeScatter} />
              : noData(280)}
          </CardContent>
        </Card>
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Rolling Win Rate</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            <RollingWinRate data={rollingWinRate} />
          </CardContent>
        </Card>
      </div>

      {/* Row 3: Breakdown Charts */}
      <BreakdownCharts byTrader={byTrader} byStrategy={byStrategy} runId={id} />

      {/* Row 4: Strategy Equity (only if 2+ strategies) */}
      {strategyEquity.length > 0 && strategies.length >= 2 && (
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Strategy Equity</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            <StrategyEquityChart data={strategyEquity} strategies={strategies} />
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

  // Consistent layout: same order regardless of state.
  // Sections show/hide but never move position.


  return (
    <div className="flex flex-col min-h-full">
    <div className="space-y-4 animate-in-up pb-6 flex-1">
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
              <Button type="submit" variant="ghost" size="xs" className="text-loss hover:text-loss/80 hover:bg-loss/5">
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
                <span className={summary.totalPnl >= 0 ? 'text-profit font-semibold' : 'text-loss font-semibold'}>{formatCurrency(summary.totalPnl)}</span>
                <span className="text-muted-foreground">DD <span className="text-foreground font-semibold">{formatCurrency(summary.maxDrawdown)}</span></span>
                <span className="text-muted-foreground">PF <span className="text-foreground font-semibold">{(summary.profitFactor >= PROFIT_FACTOR_INF ? 99.99 : (summary.profitFactor ?? 0)).toFixed(2)}</span></span>
              </div>
            </>
          )}
        </div>

        {/* Progress / run stats — always visible for consistent layout */}
        <RunProgress
          processedMessages={decisions.length}
          totalMessages={summary?.tradedMessages ?? 0}
          agentModel={config.agentModel ?? 'default'}
          llmTokens={llmTokens}
          liveMetrics={liveMetrics}
          status={run.status}
        />

        {/* Error — only when there is one (hide for cancelled runs) */}
        {run.error && run.status !== 'CANCELLED' && (
          <Card className="py-4 gap-2 border-loss/30 bg-loss/5">
            <CardHeader className="py-0">
              <CardTitle className="text-sm text-loss">Error</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-xs text-loss/80 whitespace-pre-wrap font-mono">
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
    </div>

    {/* Anchored log panel — outside content wrapper so sticky sits flush */}
    <LogViewer
      runId={id}
      isRunning={isRunning}
      defaultCollapsed
    />
    </div>
  );
}

// ── Compute report data from the trades table ──────────────────────

type TradeRow = {
  pnl: string | null;
  status: string;
  trader: string;
  strategy: string;
  closedAt: string | null;
  direction: string;
  quantity: number | null;
  symbol: string;
  openedAt: string | null;
};

export type TradeScatterPoint = { date: string; pnl: number; strategy: string; direction: string; quantity: number; symbol: string; trader: string };
export type RollingWinRatePoint = { tradeNum: number; date: string; winRate: number; windowSize: number };
export type StrategyEquityPoint = Record<string, number | string>;

function computeFromTrades(
  closed: TradeRow[],
  totalTradeCount: number,
  precomputedSummary: BacktestRunSummary | null,
  storedEquityCurve?: { date: string; cumPnl: number; equity?: number; unrealizedPnl?: number }[] | null,
) {
  const pnl = (t: TradeRow) => { const n = parseFloat(t.pnl ?? ''); return Number.isFinite(n) ? n : 0; };

  const wins = closed.filter((t) => pnl(t) > 0);
  const losses = closed.filter((t) => pnl(t) <= 0);
  const totalPnl = closed.reduce((s, t) => s + pnl(t), 0);

  const grossWins = wins.reduce((s, t) => s + pnl(t), 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + pnl(t), 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? PROFIT_FACTOR_INF : 0;

  // Max drawdown from closed trades in chronological order
  const sorted = [...closed].sort((a, b) => (a.closedAt ?? '').localeCompare(b.closedAt ?? ''));
  let peak = 0, maxDrawdown = 0, running = 0;
  for (const t of sorted) {
    running += pnl(t);
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Summary: trade-derived fields always from DB, non-trade fields from precomputed when available
  const summary: BacktestRunSummary = {
    totalMessages: precomputedSummary?.totalMessages ?? 0,
    tradedMessages: precomputedSummary?.tradedMessages ?? 0,
    totalTrades: totalTradeCount,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    totalPnl: roundCents(totalPnl),
    avgWin: roundCents(wins.length > 0 ? grossWins / wins.length : 0),
    avgLoss: roundCents(losses.length > 0 ? grossLosses / losses.length * -1 : 0),
    maxDrawdown: roundCents(maxDrawdown),
    profitFactor: roundCents(profitFactor),
    agentCallsUsed: precomputedSummary?.agentCallsUsed ?? 0,
    agentTrades: precomputedSummary?.agentTrades ?? 0,
    skipped: precomputedSummary?.skipped ?? 0,
    openAtEnd: totalTradeCount - closed.length,
  };

  // By trader
  const byTrader: Record<string, { trades: number; wins: number; losses: number; winRate: number; totalPnl: number }> = {};
  for (const t of closed) {
    const s = byTrader[t.trader] ??= { trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 };
    s.trades++;
    if (pnl(t) > 0) s.wins++; else s.losses++;
    s.totalPnl += pnl(t);
    s.winRate = s.wins / s.trades;
  }

  // By strategy
  const byStrategy: Record<string, { trades: number; wins: number; losses: number; winRate: number; totalPnl: number; avgPnl: number }> = {};
  for (const t of closed) {
    const s = byStrategy[t.strategy] ??= { trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnl: 0 };
    s.trades++;
    if (pnl(t) > 0) s.wins++; else s.losses++;
    s.totalPnl += pnl(t);
    s.winRate = s.wins / s.trades;
    s.avgPnl = s.totalPnl / s.trades;
  }

  // Equity curve (daily)
  const dailyMap = new Map<string, { pnl: number; trades: number }>();
  for (const t of sorted) {
    const date = t.closedAt?.split('T')[0] ?? 'unknown';
    const d = dailyMap.get(date) ?? { pnl: 0, trades: 0 };
    d.pnl += pnl(t);
    d.trades++;
    dailyMap.set(date, d);
  }
  const equityCurve: { date: string; pnl: number; cumPnl: number; trades: number; equity?: number }[] = [];
  let cumPnl = 0;

  // If we have a stored equity curve with equity data, use it and merge daily pnl
  if (storedEquityCurve && storedEquityCurve.length > 0 && storedEquityCurve.some(pt => pt.equity != null)) {
    const dailyPnlMap = new Map<string, number>();
    const dailyTradesMap = new Map<string, number>();
    for (const [date, d] of dailyMap.entries()) {
      dailyPnlMap.set(date, d.pnl);
      dailyTradesMap.set(date, d.trades);
    }
    for (const pt of storedEquityCurve) {
      equityCurve.push({
        date: pt.date,
        pnl: roundCents(dailyPnlMap.get(pt.date) ?? 0),
        cumPnl: roundCents(pt.cumPnl),
        trades: dailyTradesMap.get(pt.date) ?? 0,
        equity: pt.equity != null ? roundCents(pt.equity) : undefined,
      });
    }
  } else {
    for (const [date, d] of [...dailyMap.entries()].sort()) {
      cumPnl += d.pnl;
      equityCurve.push({ date, pnl: roundCents(d.pnl), cumPnl: roundCents(cumPnl), trades: d.trades });
    }
  }

  // --- Trade Scatter data ---
  const tradeScatter: TradeScatterPoint[] = sorted.map((t) => ({
    date: (t.closedAt ?? t.openedAt ?? '').split('T')[0],
    pnl: pnl(t),
    strategy: t.strategy,
    direction: t.direction,
    quantity: t.quantity ?? 1,
    symbol: t.symbol,
    trader: t.trader,
  }));

  // --- Rolling Win Rate ---
  const rollingWinRate: RollingWinRatePoint[] = [];
  if (sorted.length >= 5) {
    // Adaptive window: max(5, total/5) capped at 20
    const windowSize = Math.min(20, Math.max(5, Math.floor(sorted.length / 5)));
    for (let i = windowSize - 1; i < sorted.length; i++) {
      const window = sorted.slice(i - windowSize + 1, i + 1);
      const windowWins = window.filter((t) => pnl(t) > 0).length;
      rollingWinRate.push({
        tradeNum: i + 1,
        date: (sorted[i].closedAt ?? '').split('T')[0],
        winRate: roundCents(windowWins / windowSize),
        windowSize,
      });
    }
  }

  // --- Strategy Equity (cumulative P&L per strategy) ---
  const strategies = [...new Set(sorted.map((t) => t.strategy))];
  const strategyEquity: StrategyEquityPoint[] = [];
  if (strategies.length >= 2) {
    const cumByStrategy: Record<string, number> = {};
    for (const s of strategies) cumByStrategy[s] = 0;

    // Group sorted trades by date
    const dateGroups = new Map<string, TradeRow[]>();
    for (const t of sorted) {
      const date = (t.closedAt ?? '').split('T')[0];
      const group = dateGroups.get(date) ?? [];
      group.push(t);
      dateGroups.set(date, group);
    }

    for (const [date, trades] of [...dateGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const t of trades) {
        cumByStrategy[t.strategy] += pnl(t);
      }
      const point: StrategyEquityPoint = { date };
      for (const s of strategies) {
        point[s] = roundCents(cumByStrategy[s]);
      }
      strategyEquity.push(point);
    }
  }

  return {
    summary: closed.length > 0 || totalTradeCount > 0 ? summary : null,
    byTrader: Object.keys(byTrader).length > 0 ? byTrader : null,
    byStrategy: Object.keys(byStrategy).length > 0 ? byStrategy : null,
    equityCurve: equityCurve.length > 0 ? equityCurve : null,
    tradeScatter,
    rollingWinRate,
    strategyEquity,
    strategies,
  };
}
