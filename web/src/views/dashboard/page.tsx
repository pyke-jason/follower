import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useChannelId } from '@/hooks/use-channel-id';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { queries } from '@/lib/queries';
import { Badge } from '@/components/badge';
import { MetricStrip } from '@/components/metric-strip';
import { Card, CardHeader, CardTitle, CardAction, CardContent } from '@/components/ui/card';
import { formatCurrency, pnlColor, relativeTime, signalBorderColor, positionBorderColor } from '@/lib/format';
import { OverviewEquityCurve } from '@/components/overview-equity-curve';
import { TraderLeaderboard } from './trader-leaderboard';
import { RiskPanel } from './risk-panel';
import { EmptyState } from '@/components/empty-state';
import { QueryBoundary, MetricStripSkeleton } from '@/components/query-boundary';
import { ArrowRight, CheckCircle2, Clock, XCircle, AlertTriangle } from 'lucide-react';
import type { DashboardPageData, DashboardSignalRow } from '@/lib/page-adapters';
import type { Trade } from '@src/db/schema';

export default function OverviewPage() {
  const href = useScopedHref();
  const channelId = useChannelId();

  const query = useQuery(queries.dashboard.overview(channelId!));

  return (
    <QueryBoundary query={query} skeleton={<MetricStripSkeleton />}>
      {(data) => <DashboardContent data={data} href={href} />}
    </QueryBoundary>
  );
}

function DashboardContent({ data, href }: { data: DashboardPageData; href: ReturnType<typeof useScopedHref> }) {
  const { pathname } = useLocation();
  const { openTrades, equityData, traderData, metrics, signals, pendingReviews, riskSnapshot } = data;

  return (
    <div className="space-y-4">
      {/* Attention Bar -- Pending Reviews (top, so you can't miss it) */}
      {pendingReviews.length > 0 && (
        <Link
          to={href('/tasks?status=PENDING')}
          className="animate-in-up flex items-center gap-3 rounded-lg border border-warning/20 bg-warning/5 px-4 py-2.5 hover:bg-warning/10 transition-colors"
        >
          <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
          <span className="text-sm font-mono font-medium text-warning/80">
            {pendingReviews.length} task{pendingReviews.length !== 1 ? 's' : ''} pending review
          </span>
          <ArrowRight className="h-3.5 w-3.5 text-warning/50 ml-auto" />
        </Link>
      )}

      {/* KPI Metrics */}
      <MetricStrip metrics={metrics} />

      {/* Account Health -- live mode only */}
      {riskSnapshot && (
        <div className="animate-in-up stagger-1">
          <RiskPanel data={riskSnapshot} />
        </div>
      )}

      {/* Equity Curve -- the heartbeat */}
      {equityData.length > 1 && (
        <div className="animate-in-up stagger-1">
          <Card className="py-0 gap-0 overflow-hidden">
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
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
              <CardTitle className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                Open Positions
              </CardTitle>
              <CardAction>
                <Link
                  to={href('/trades')}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  All <ArrowRight className="h-3 w-3" />
                </Link>
              </CardAction>
            </CardHeader>
            <CardContent className="p-0">
              {openTrades.length === 0 ? (
                <EmptyState title="No open positions" hint="Signals will open positions here" />
              ) : (
                <div className="divide-y divide-border/50">
                  {openTrades.slice(0, 6).map((t: Trade) => (
                    <Link
                      key={t.id}
                      to={href(`/trades/${t.id}`, { from: pathname })}
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
                          <span className="font-mono tabular-nums">{formatCurrency(t.entryPrice)}</span>
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
              <CardTitle className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                Recent Signals
              </CardTitle>
              <CardAction>
                <Link
                  to={href('/messages')}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  All <ArrowRight className="h-3 w-3" />
                </Link>
              </CardAction>
            </CardHeader>
            <CardContent className="p-0">
              {signals.length === 0 ? (
                <EmptyState title="No recent signals" hint="Trader messages will appear here" />
              ) : (
                <div className="divide-y divide-border/50">
                  {signals.slice(0, 8).map(({ message: m, trade: t }: DashboardSignalRow) => (
                    <div
                      key={m.id}
                      className={`flex items-start gap-3 px-4 py-2.5 border-l-2 ${signalBorderColor(m.actionHint, m.directionHint)}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium">{m.author}</span>
                          <span className="text-[10px] font-mono text-muted-foreground/50 tabular-nums">
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
                              className={`flex items-center gap-1 text-[10px] font-mono font-medium tabular-nums ${pnlColor(t.pnl)}`}
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
              <CardTitle className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                Trader Performance
              </CardTitle>
              <CardAction>
                <Link
                  to={href('/traders')}
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
