import { notFound } from 'next/navigation';
import { getBacktestRunById, getRunDecisions, getTradesByBacktestRun, getMtmSnapshots } from '@/lib/queries';
import { Badge } from '../../components/badge';
import { RunProgress } from './run-progress';

import { AutoRefresh } from '../../components/auto-refresh';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
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
import { ChatRoom } from '../../messages/chat-room';
import { loadInitialChatData } from '../../messages/load-chat-data';
import { DecisionScatter } from './decision-scatter';
import { TradesTableClient } from '../../components/trades-table-client';
import Link from 'next/link';
import { LayoutDashboard, TrendingUp, ListTodo, MessageSquare, Square, Trash2, Copy, ArrowLeft } from 'lucide-react';
import type { BacktestRunConfig, CommissionSchedule } from '../../../../src/db/schema';
import type { LiveMetrics } from '../../../../src/backtest/types';

import { PROFIT_FACTOR_INF, pctDisplay, roundCents, safeParseFloat } from '../../../../src/lib/numbers';
import { computeCoreStats } from '../../../../src/backtest/report';
import { computeTradeCommission } from '../../../../src/lib/commission';
import { tradeQty } from '../../../../src/lib/trade';

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
  const liveMetrics = run.liveMetrics as LiveMetrics | null;
  const lastProcessedTs = run.status !== 'COMPLETED'
    ? liveMetrics?.lastProcessedMessageTs ?? null
    : null;

  // When processing is incomplete, narrow the messages query to show the frontier
  // instead of loading from the very end of the date range (which may be all unprocessed).
  const messagesEndDate = lastProcessedTs
    ? new Date(new Date(lastProcessedTs).getTime() + 3600_000).toISOString() // +1hr buffer
    : config.endDate;

  const [decisions, allTrades, chatData, mtmSnapshots] = await Promise.all([
    getRunDecisions(id),
    getTradesByBacktestRun(id, { includeOpen: true }),
    loadInitialChatData({
      authors: config.traders,
      startDate: config.startDate,
      endDate: messagesEndDate,
      runId: id,
    }),
    getMtmSnapshots(id),
  ]);

  const closedTrades = allTrades.filter((t) => t.status === 'CLOSED');

  // Clamp closedAt dates to the backtest end date so charts don't extend
  // to today's wall-clock time (backtest trades use real timestamps).
  const backtestEnd = config.endDate.split('T')[0];
  const clampedTrades = allTrades.map((t) => {
    if (!t.closedAt || t.closedAt.split('T')[0] <= backtestEnd) return t;
    return { ...t, closedAt: `${backtestEnd}T16:00:00.000Z` };
  });

  // Compute everything from the trades table — works identically for
  // in-progress and completed runs, no precomputed JSON columns needed.
  const { summary, byTrader, byStrategy, equityCurve, tradeScatter, rollingWinRate, strategyEquity, strategies } = computeFromTrades(clampedTrades, decisions, mtmSnapshots, config.commissionSchedule);

  // Compute LLM token sums from already-loaded decisions — zero extra DB queries
  const llmTokens = decisions.reduce(
    (acc, d) => ({
      input: acc.input + (d.decision.inputTokens ?? 0),
      output: acc.output + (d.decision.outputTokens ?? 0),
    }),
    { input: 0, output: 0 },
  );


  // --- Performance Tab content ---
  const hasDrawdown = (summary?.maxDrawdown ?? 0) > 0;

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

  // --- Messages Tab content (ChatRoom with constraints) ---
  const stableDecisionCounts = (() => {
    const executed = decisions.filter((d) => d.trade?.id != null).length;
    const skipped = decisions.filter((d) => d.trade?.id == null).length;
    return { processedCount: executed + skipped, executedCount: executed, skippedCount: skipped };
  })();

  const scatterData = decisions
    .filter((r) => r.decision.pnl != null)
    .map((r) => ({
      date: r.message.timestamp.split('T')[0],
      pnl: safeParseFloat(r.decision.pnl),
      decision: r.decision.decision,
      message: r.message.cleanText.slice(0, 60),
    }));

  const messagesContent = (
    <div className="space-y-3 flex flex-col flex-1 min-h-0">
      {scatterData.length > 0 && (
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Decision Outcomes</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            <DecisionScatter data={scatterData} />
          </CardContent>
        </Card>
      )}
      <div className="rounded-lg border bg-card overflow-hidden flex flex-col flex-1 min-h-0">
        <ChatRoom
          initialMessages={chatData.messages}
          initialCursor={chatData.cursor}
          initialLabels={chatData.labels}
          initialEnrichment={chatData.enrichment}
          authors={chatData.authors}
          constraints={{
            authors: config.traders,
            startDate: config.startDate,
            endDate: messagesEndDate,
            runId: id,
            lastProcessedTs: lastProcessedTs ?? undefined,
          }}
          stableDecisionCounts={stableDecisionCounts}
        />
      </div>
    </div>
  );

  // --- Trades Tab content ---
  const tradesContent = <TradesTableClient trades={allTrades} runId={id} commissionSchedule={config.commissionSchedule} startingEquity={config.startingEquity ?? 100_000} />;

  // Consistent layout: same order regardless of state.
  // Sections show/hide but never move position.


  return (
    <div className="flex flex-col min-h-full">
    <div className="space-y-4 animate-in-up pb-6 flex-1 flex flex-col">
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
              <Link href={`?tab=messages`}>
                <MessageSquare className="size-3" /> Messages
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
          <span className="text-muted-foreground">{config.agentProvider ?? 'anthropic'}/{config.agentModel ?? 'default'}</span>
          <Separator orientation="vertical" className="!h-4" />
          <span className="text-muted-foreground">{config.fillModel ?? 'orats'}</span>
          <span className="text-muted-foreground tabular-nums">${((config.startingEquity ?? 100_000) / 1000).toFixed(0)}k</span>
          {config.commissionSchedule?.option?.perContract != null && (
            <span className="text-muted-foreground text-xs">comm ${config.commissionSchedule.option.perContract}/ct</span>
          )}
          {config.disableRiskLimits && <span className="text-amber-500 text-xs font-medium">risk off</span>}
          {summary && (
            <>
              <Separator orientation="vertical" className="!h-4" />
              <div className="flex items-center gap-3 ml-auto tabular-nums">
                <span className="text-muted-foreground"><span className="text-foreground font-semibold">{summary.totalTrades}</span> trades{summary.openAtEnd > 0 && <span className="text-muted-foreground/60"> + {summary.openAtEnd} open</span>}</span>
                <span className="text-muted-foreground"><span className="text-foreground font-semibold">{pctDisplay(summary.winRate)}</span> win</span>
                {(() => {
                  const unrealized = liveMetrics?.unrealizedPnl ?? 0;
                  const hasOpen = summary.openAtEnd > 0 && unrealized !== 0;
                  const hasComm = (summary.totalCommissions ?? 0) > 0;
                  const displayPnl = hasComm ? (summary.netPnl ?? summary.totalPnl) : summary.totalPnl;
                  const totalPnl = hasOpen ? displayPnl + unrealized : displayPnl;
                  return (
                    <span className={totalPnl >= 0 ? 'text-profit font-semibold' : 'text-loss font-semibold'}>
                      {formatCurrency(totalPnl)}
                      {hasComm && <span className="text-muted-foreground font-normal text-xs ml-1">(gross {formatCurrency(summary.totalPnl)} &minus; {formatCurrency(summary.totalCommissions!)} comm)</span>}
                      {!hasComm && hasOpen && <span className="text-muted-foreground font-normal text-xs ml-1">({formatCurrency(summary.totalPnl)} realized)</span>}
                    </span>
                  );
                })()}
                <span className="text-muted-foreground">DD <span className="text-foreground font-semibold">{formatCurrency(summary.maxDrawdown)}</span></span>
                <span className="text-muted-foreground">PF <span className="text-foreground font-semibold">{(summary.profitFactor >= PROFIT_FACTOR_INF ? 99.99 : (summary.profitFactor ?? 0)).toFixed(2)}</span></span>
              </div>
            </>
          )}
        </div>

        {/* Progress / run stats — always visible for consistent layout */}
        <RunProgress
          processedMessages={decisions.length}
          totalMessages={run.summary?.tradedMessages ?? 0}
          agentModel={config.agentModel ?? 'default'}
          llmTokens={llmTokens}
          liveMetrics={liveMetrics}
          status={run.status}
          startedAt={run.startedAt}
          completedAt={run.completedAt}
          lastMessageDate={
            liveMetrics?.lastProcessedMessageTs
            ?? (decisions.length > 0 ? decisions[0].message.timestamp : null)
          }
          rangeStart={config.startDate}
          rangeEnd={config.endDate}
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
        messages={messagesContent}
        trades={tradesContent}
        hasMessages={chatData.messages.length > 0}
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
  legs: unknown[] | null;
  symbol: string;
  openedAt: string | null;
};

export type TradeScatterPoint = { date: string; pnl: number; strategy: string; direction: string; quantity: number; symbol: string; trader: string };
export type RollingWinRatePoint = { tradeNum: number; date: string; winRate: number; windowSize: number };
export type StrategyEquityPoint = Record<string, number | string>;

function computeFromTrades(
  allTrades: TradeRow[],
  decisions: { decision: { path: string; decision: string } }[],
  mtmSnapshots?: { date: string; unrealizedPnl: number }[],
  commissionSchedule?: CommissionSchedule,
) {
  const { summary: core, byTrader, byStrategy, equityCurve, sortedClosed } = computeCoreStats(allTrades, mtmSnapshots, commissionSchedule);

  // Execution stats from already-loaded decisions — no precomputed fallback
  const agentCallsUsed = decisions.filter((d) => d.decision.path === 'agent').length;
  const agentTrades = decisions.filter((d) => d.decision.path === 'agent' && d.decision.decision === 'EXECUTE').length;
  const skipped = decisions.filter((d) => d.decision.decision === 'SKIP').length;

  const summary = { ...core, totalMessages: 0, tradedMessages: 0, agentCallsUsed, agentTrades, skipped };

  // --- Chart builders (detail-page-specific, using net PnL) ---
  const netPnlOf = (t: TradeRow) => safeParseFloat(t.pnl) - computeTradeCommission(t, commissionSchedule);

  const tradeScatter: TradeScatterPoint[] = sortedClosed.map((t) => ({
    date: (t.closedAt ?? t.openedAt ?? '').split('T')[0],
    pnl: netPnlOf(t),
    strategy: t.strategy,
    direction: t.direction,
    quantity: tradeQty(t.quantity),
    symbol: t.symbol,
    trader: t.trader,
  }));

  const rollingWinRate: RollingWinRatePoint[] = [];
  if (sortedClosed.length >= 5) {
    const windowSize = Math.min(20, Math.max(5, Math.floor(sortedClosed.length / 5)));
    for (let i = windowSize - 1; i < sortedClosed.length; i++) {
      const window = sortedClosed.slice(i - windowSize + 1, i + 1);
      const windowWins = window.filter((t) => netPnlOf(t) > 0).length;
      rollingWinRate.push({
        tradeNum: i + 1,
        date: (sortedClosed[i].closedAt ?? '').split('T')[0],
        winRate: roundCents(windowWins / windowSize),
        windowSize,
      });
    }
  }

  const strategies = [...new Set(sortedClosed.map((t) => t.strategy))];
  const strategyEquity: StrategyEquityPoint[] = [];
  if (strategies.length >= 2) {
    const cumByStrategy: Record<string, number> = {};
    for (const s of strategies) cumByStrategy[s] = 0;
    const dateGroups = new Map<string, TradeRow[]>();
    for (const t of sortedClosed) {
      const date = (t.closedAt ?? '').split('T')[0];
      let group = dateGroups.get(date);
      if (!group) { group = []; dateGroups.set(date, group); }
      group.push(t);
    }
    for (const [date, trades] of [...dateGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const t of trades) cumByStrategy[t.strategy] += netPnlOf(t);
      const point: StrategyEquityPoint = { date };
      for (const s of strategies) point[s] = roundCents(cumByStrategy[s]);
      strategyEquity.push(point);
    }
  }

  const hasTrades = allTrades.length > 0;
  return {
    summary: hasTrades ? summary : null,
    byTrader: Object.keys(byTrader).length > 0 ? byTrader : null,
    byStrategy: Object.keys(byStrategy).length > 0 ? byStrategy : null,
    equityCurve: equityCurve.length > 0 ? equityCurve : null,
    tradeScatter,
    rollingWinRate,
    strategyEquity,
    strategies,
  };
}
