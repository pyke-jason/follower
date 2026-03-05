import Link from 'next/link';
import { Badge } from './components/badge';
import { MetricStrip, type Metric } from './components/metric-strip';
import { Card, CardHeader, CardTitle, CardAction, CardContent } from '@/components/ui/card';
import {
  getStats,
  getOpenTrades,
  getPendingReviews,
  getDailyBalances,
  getTraderPnlSummary,
  getRecentSignals,
  getTradeHistorySummary,
  getBacktestRunById,
  getRiskSnapshot,
} from '@/lib/queries';
import { formatCurrency, pnlColor, relativeTime, signalBorderColor, positionBorderColor } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import { OverviewEquityCurve } from './components/overview-equity-curve';
import { TraderLeaderboard } from './components/trader-leaderboard';
import { RiskPanel } from './components/risk-panel';
import { ArrowRight, CheckCircle2, Clock, XCircle, AlertTriangle } from 'lucide-react';
import { AutoRefresh } from './components/auto-refresh';

export const dynamic = 'force-dynamic';

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const { run: runId } = await searchParams;

  const [stats, openTrades, dailyBalances, signals, traderPnl, pendingReviews, summary, backtestRun, riskSnapshot] =
    await Promise.all([
      getStats(runId),
      getOpenTrades(6, runId),
      getDailyBalances(30),
      getRecentSignals(8, runId),
      getTraderPnlSummary(runId),
      getPendingReviews(5, runId),
      getTradeHistorySummary({ runId }),
      runId ? getBacktestRunById(runId) : Promise.resolve(null),
      !runId ? getRiskSnapshot() : Promise.resolve(null),
    ]);

  // Build equity curve data
  let equityData: { date: string; equity: number }[] = [];

  if (runId && backtestRun?.equityCurve) {
    // Backtest mode: use the run's equity curve
    const curve = backtestRun.equityCurve;
    equityData = curve.map((pt) => ({
      date: pt.date,
      equity: pt.cumPnl ?? pt.equity ?? 0,
    }));
  } else if (dailyBalances.length > 0) {
    // Live mode: use daily balance snapshots
    equityData = dailyBalances
      .slice()
      .reverse()
      .map((b) => ({
        date: b.date,
        equity: parseFloat(b.equity ?? '0'),
      }));
  }

  const equitySparkline = equityData.map((d) => d.equity);

  // Build trader leaderboard data
  const traderData = traderPnl.map((t) => ({
    trader: t.trader,
    pnl: parseFloat(t.totalPnl),
    trades: t.tradeCount,
    winRate: t.tradeCount > 0 ? Math.round((t.wins / t.tradeCount) * 100) : 0,
  }));

  // Build metric strip
  const metrics: Metric[] = [
    {
      label: runId ? 'Total P&L' : "Today's P&L",
      value: stats.todayPnl,
      format: 'currency',
      colorBySign: true,
      sparklineData: equitySparkline.length > 2 ? equitySparkline : undefined,
    },
    {
      label: 'Win Rate',
      value: summary.winRate,
      format: 'percent',
    },
    {
      label: 'Open',
      value: stats.openTrades,
      format: 'integer',
    },
    {
      label: 'Trades',
      value: summary.totalTrades,
      format: 'integer',
    },
    {
      label: 'Pending',
      value: stats.pendingTasks,
      format: 'integer',
    },
  ];

  return (
    <div className="space-y-4">
      <AutoRefresh />
      {/* Attention Bar — Pending Reviews (top, so you can't miss it) */}
      {pendingReviews.length > 0 && (
        <Link
          href={buildHref('/tasks?status=PENDING', runId)}
          className="animate-in-up flex items-center gap-3 rounded-lg border border-warning/20 bg-warning/5 px-4 py-2.5 hover:bg-warning/10 transition-colors"
        >
          <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
          <span className="text-sm font-medium text-warning/80">
            {pendingReviews.length} task{pendingReviews.length !== 1 ? 's' : ''} pending review
          </span>
          <ArrowRight className="h-3.5 w-3.5 text-warning/50 ml-auto" />
        </Link>
      )}

      {/* KPI Metrics */}
      <MetricStrip metrics={metrics} />

      {/* Account Health — live mode only */}
      {riskSnapshot && (
        <div className="animate-in-up stagger-1">
          <RiskPanel data={riskSnapshot} />
        </div>
      )}

      {/* Equity Curve — the heartbeat */}
      {equityData.length > 1 && (
        <div className="animate-in-up stagger-1">
          <Card className="py-0 gap-0 overflow-hidden">
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Equity
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 pb-1">
              <OverviewEquityCurve data={equityData} />
            </CardContent>
          </Card>
        </div>
      )}

      {/* Middle Row: Open Positions + Recent Signals */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Open Positions */}
        <div className="animate-in-up stagger-2">
          <Card className="py-0 gap-0 h-full">
            <CardHeader className="border-b py-3 px-4">
              <CardTitle className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Open Positions
              </CardTitle>
              <CardAction>
                <Link
                  href={buildHref('/trades/open', runId)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  All <ArrowRight className="h-3 w-3" />
                </Link>
              </CardAction>
            </CardHeader>
            <CardContent className="p-0">
              {openTrades.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <div className="h-8 w-8 rounded-full border-2 border-dashed border-muted-foreground/20 mb-3" />
                  <p className="text-sm">No open positions</p>
                  <p className="text-xs mt-1 opacity-50">Signals will open positions here</p>
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {openTrades.map((t) => (
                    <Link
                      key={t.id}
                      href={buildHref(`/trades/${t.id}`, runId)}
                      className={`flex items-center gap-3 px-4 py-2.5 border-l-2 hover:bg-accent/40 transition-colors ${positionBorderColor(t.direction)}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm tracking-tight">{t.symbol}</span>
                          <Badge label={t.direction} />
                          <Badge label={t.strategy} />
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                          <span>{t.trader}</span>
                          <span className="tabular-nums">{formatCurrency(t.entryPrice)}</span>
                          {t.quantity && <span>{t.quantity} ct</span>}
                        </div>
                      </div>
                      <span className="text-[11px] text-muted-foreground/60 tabular-nums shrink-0">
                        {relativeTime(t.openedAt)}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Recent Signals */}
        <div className="animate-in-up stagger-3">
          <Card className="py-0 gap-0 h-full">
            <CardHeader className="border-b py-3 px-4">
              <CardTitle className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Recent Signals
              </CardTitle>
              <CardAction>
                <Link
                  href="/messages"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  All <ArrowRight className="h-3 w-3" />
                </Link>
              </CardAction>
            </CardHeader>
            <CardContent className="p-0">
              {signals.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <div className="h-8 w-8 rounded-full border-2 border-dashed border-muted-foreground/20 mb-3" />
                  <p className="text-sm">No recent signals</p>
                  <p className="text-xs mt-1 opacity-50">Trader messages will appear here</p>
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {signals.map(({ message: m, trade: t }) => (
                    <div
                      key={m.id}
                      className={`flex items-start gap-3 px-4 py-2.5 border-l-2 ${signalBorderColor(m.actionHint, m.directionHint)}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium">{m.author}</span>
                          <span className="text-[10px] text-muted-foreground/50 tabular-nums">
                            {relativeTime(m.timestamp)}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                          {m.cleanText}
                        </p>
                      </div>
                      <div className="shrink-0 mt-0.5">
                        {t ? (
                          t.status === 'CLOSED' ? (
                            <span
                              className={`flex items-center gap-1 text-[10px] font-medium tabular-nums ${pnlColor(t.pnl)}`}
                            >
                              <CheckCircle2 className="h-3 w-3" />
                              {formatCurrency(t.pnl)}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[10px] text-info font-medium">
                              <Clock className="h-3 w-3" />
                              Open
                            </span>
                          )
                        ) : m.actionHint ? (
                          <span className="flex items-center gap-1 text-[10px] text-muted-foreground/50">
                            <XCircle className="h-3 w-3" />
                            Skip
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Trader Performance */}
      {traderData.length > 0 && (
        <div className="animate-in-up stagger-4">
          <Card className="py-0 gap-0">
            <CardHeader className="border-b py-3 px-4">
              <CardTitle className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Trader Performance
              </CardTitle>
              <CardAction>
                <Link
                  href="/traders"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Manage <ArrowRight className="h-3 w-3" />
                </Link>
              </CardAction>
            </CardHeader>
            <CardContent className="p-4">
              <TraderLeaderboard data={traderData} />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
