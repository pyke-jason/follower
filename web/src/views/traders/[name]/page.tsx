import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useChannelId } from '@/hooks/use-channel-id';
import { queries } from '@/lib/queries';
import type { TraderDetailResponse } from '@src/local-api/http-schemas';
import { Badge } from '@/components/badge';
import { InfoChip } from '@/components/info-chip';
import { MetricStrip, type Metric } from '@/components/metric-strip';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { TradeFilterProvider } from '@/components/trade-filters';
import { TradesTableClient } from '@/components/trades-table-client';
import { TradesViewProvider } from '@/components/trades-view-context';
import { OverviewEquityCurve } from '@/components/overview-equity-curve';
import { BarChartComponent } from './bar-chart';
import { formatCurrency } from '@/lib/format';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { EmptyState } from '@/components/empty-state';
import { QueryBoundary, MetricStripSkeleton } from '@/components/query-boundary';
import { ArrowLeft, User } from 'lucide-react';

type EquityCurveRow = TraderDetailResponse['equityCurve'][number];
type StrategyRow = TraderDetailResponse['strategyBreakdown'][number];
type HistorySummary = TraderDetailResponse['historySummary'];

function toEquityChartData(curve: EquityCurveRow[]): { date: string; equity: number }[] {
  return curve.map((row) => ({ date: row.date, equity: row.cumPnl }));
}

function toStrategyChartData(breakdown: StrategyRow[]): { name: string; pnl: number }[] {
  return breakdown.map((row) => ({ name: row.strategy, pnl: parseFloat(row.totalPnl) }));
}

function buildMetrics(summary: HistorySummary): Metric[] {
  return [
    { label: 'Total P&L', value: summary.totalPnl, format: 'currency', colorBySign: true },
    { label: 'Trades', value: summary.totalTrades, format: 'integer' },
    { label: 'Win Rate', value: summary.winRate / 100, format: 'percent' },
    { label: 'Best', value: summary.bestTrade, format: 'currency', colorBySign: true },
    { label: 'Worst', value: summary.worstTrade, format: 'currency', colorBySign: true },
    { label: 'Slippage', value: Math.abs(summary.totalSlippage), format: 'currency' },
  ];
}

export default function TraderDetailPage() {
  const { name } = useParams<{ name: string }>();
  const channelId = useChannelId();
  const href = useScopedHref();
  const decodedName = decodeURIComponent(name ?? '');

  const query = useQuery(queries.traders.detail(channelId!, decodedName));

  return (
    <QueryBoundary query={query} skeleton={<MetricStripSkeleton />}>
      {(data) => <TraderDetailContent data={data} channelId={channelId ?? undefined} decodedName={decodedName} href={href} />}
    </QueryBoundary>
  );
}

function TraderDetailContent({ data, channelId, decodedName, href }: {
  data: TraderDetailResponse;
  channelId: string | undefined;
  decodedName: string;
  href: ReturnType<typeof useScopedHref>;
}) {
  const { trader, equityCurve, strategyBreakdown, historySummary, closedTrades } = data;
  const equityData = toEquityChartData(equityCurve);
  const strategyChartData = toStrategyChartData(strategyBreakdown);
  const metrics = buildMetrics(historySummary);

  return (
    <div className="space-y-6 animate-in-up">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          to={href('/traders')}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <User className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-bold text-foreground tracking-tight">{decodedName}</h2>
        {trader && (
          <div className="flex items-center gap-1.5">
            <Badge label={trader.enabled ? 'ENABLED' : 'DISABLED'} />
            {trader.strategies.map((s: string) => (
              <InfoChip key={s} label={s} />
            ))}
          </div>
        )}
      </div>

      {/* Metrics */}
      {historySummary.totalTrades > 0 && <MetricStrip metrics={metrics} />}

      {/* Charts Grid */}
      {(equityData.length > 1 || strategyChartData.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6">
          {/* Equity Curve */}
          {equityData.length > 1 && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardHeader className="py-3 px-4">
                <CardTitle className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  Cumulative P&L
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 pb-1">
                <OverviewEquityCurve data={equityData} />
              </CardContent>
            </Card>
          )}

          {/* Strategy Breakdown */}
          {strategyChartData.length > 0 && (
            <Card className="py-0 gap-0">
              <CardHeader className="border-b py-3 px-4">
                <CardTitle className="text-sm">P&L by Strategy</CardTitle>
              </CardHeader>
              <CardContent className="pt-4 pb-2 px-2">
                <BarChartComponent
                  data={strategyChartData}
                  xKey="name"
                  yKey="pnl"
                  layout="vertical"
                  colorByValue
                  height={Math.max(150, strategyChartData.length * 40)}
                  formatY={(v: number) => formatCurrency(v)}
                  tooltipFormatter={(value: number) => [formatCurrency(value), 'P&L']}
                />
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Recent Trades */}
      {closedTrades.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-foreground mb-3">Recent Trades</h3>
          <TradesViewProvider
            value={{
              trades: closedTrades,
              eventsByTradeId: {},
              flagsByTradeId: {},
              labelsByTradeId: {},
              livePositionsByTradeId: {},
              channelId,
            }}
          >
            <TradeFilterProvider trades={closedTrades} flagsByTradeId={{}}>
              <TradesTableClient trades={closedTrades} />
            </TradeFilterProvider>
          </TradesViewProvider>
        </div>
      )}

      {historySummary.totalTrades === 0 && (
        <EmptyState
          title={`No closed trades for ${decodedName}`}
          hint="Trades will appear here once positions close"
          className="py-16"
        />
      )}
    </div>
  );
}
