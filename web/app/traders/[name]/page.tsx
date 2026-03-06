import { useParams, Link } from 'react-router-dom';
import { useChannelId } from '@/hooks/use-channel-id';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { useTradesStore } from '@/stores/trades-store';
import { Badge } from '../../components/badge';
import { InfoChip } from '../../components/info-chip';
import { MetricStrip, type Metric } from '../../components/metric-strip';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { TradesTableClient } from '../../components/trades-table-client';
import { OverviewEquityCurve } from '../../components/overview-equity-curve';
import { BarChartComponent } from '../../components/charts/bar-chart';
import { formatCurrency } from '@/lib/format';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { ArrowLeft, User } from 'lucide-react';
import type { Trade } from '@src/db/schema';

type HistorySummary = {
  totalPnl: number;
  totalTrades: number;
  wins: number;
  winRate: number;
  bestTrade: number;
  worstTrade: number;
};

type StrategyRow = {
  strategy: string;
  trades: number;
  totalPnl: string;
  wins: number;
};

type EquityCurveRow = {
  date: string;
  pnl: number;
  cumPnl: number;
};

type TrackedTrader = {
  name: string;
  enabled: boolean;
  strategies: string[];
};

type TraderDetailResponse = {
  trader: TrackedTrader;
  equityCurve: EquityCurveRow[];
  strategyBreakdown: StrategyRow[];
  historySummary: HistorySummary;
  closedTrades: Trade[];
};

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
    { label: 'Win Rate', value: summary.winRate, format: 'percent' },
    { label: 'Best', value: summary.bestTrade, format: 'currency', colorBySign: true },
    { label: 'Worst', value: summary.worstTrade, format: 'currency', colorBySign: true },
  ];
}

const Spinner = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin h-6 w-6 border-2 border-muted-foreground/20 border-t-foreground rounded-full" />
  </div>
);

export default function TraderDetailPage() {
  const { name } = useParams<{ name: string }>();
  const channelId = useChannelId();
  const href = useScopedHref();
  const decodedName = decodeURIComponent(name ?? '');

  const { data } = useQuery<TraderDetailResponse>({
    queryKey: ['trader', decodedName, channelId],
    queryFn: () =>
      api<TraderDetailResponse>(href(`/traders/${encodeURIComponent(decodedName)}`)),
  });

  const hydrate = useTradesStore((s) => s.hydrate);

  useEffect(() => {
    if (!data) return;
    hydrate({ trades: data.closedTrades, eventsByTradeId: {}, flagsByTradeId: {}, channelId });
  }, [data, hydrate, channelId]);

  if (!data) return <Spinner />;

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
                <CardTitle className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
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
          <TradesTableClient />
        </div>
      )}

      {historySummary.totalTrades === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <User className="h-10 w-10 mb-3 opacity-30" />
          <p className="text-sm">No closed trades for {decodedName}</p>
          <p className="text-xs mt-1 opacity-50">Trades will appear here once positions close</p>
        </div>
      )}
    </div>
  );
}
