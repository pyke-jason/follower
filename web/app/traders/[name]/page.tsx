import { notFound } from 'next/navigation';
import {
  getTraderDetail,
  getTraderEquityCurve,
  getTraderStrategyBreakdown,
  getTradeHistorySummary,
  getClosedTrades,
} from '@/lib/queries';
import { Badge } from '../../components/badge';
import { InfoChip } from '../../components/info-chip';
import { MetricStrip, type Metric } from '../../components/metric-strip';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table';
import { TradeRow } from '../../components/trade-row';
import { OverviewEquityCurve } from '../../components/overview-equity-curve';
import { BarChartComponent } from '../../components/charts/bar-chart';
import { formatCurrency } from '@/lib/format';
import Link from 'next/link';
import { ArrowLeft, User } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function TraderDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const decodedName = decodeURIComponent(name);

  const [trader, summary, equityCurve, strategyBreakdown, recentTrades] = await Promise.all([
    getTraderDetail(decodedName),
    getTradeHistorySummary({ trader: decodedName }),
    getTraderEquityCurve(decodedName),
    getTraderStrategyBreakdown(decodedName),
    getClosedTrades({ trader: decodedName, limit: 20 }),
  ]);

  const equityData = equityCurve.map((pt) => ({
    date: pt.date,
    equity: pt.cumPnl,
  }));

  const strategyChartData = strategyBreakdown.map((s) => ({
    name: s.strategy,
    pnl: parseFloat(String(s.totalPnl)),
    trades: s.trades,
  }));

  const metrics: Metric[] = [
    { label: 'Total P&L', value: summary.totalPnl, format: 'currency', colorBySign: true },
    { label: 'Win Rate', value: summary.winRate, format: 'percent' },
    { label: 'Trades', value: summary.totalTrades, format: 'integer' },
    { label: 'Best', value: summary.bestTrade, format: 'currency', colorBySign: true },
    { label: 'Worst', value: summary.worstTrade, format: 'currency', colorBySign: true },
  ];

  return (
    <div className="space-y-6 animate-in-up">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/traders" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <User className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-bold text-foreground tracking-tight">{decodedName}</h2>
        {trader && (
          <div className="flex items-center gap-1.5">
            <Badge label={trader.enabled ? 'ENABLED' : 'DISABLED'} />
            {(trader.strategies as string[])?.map((s) => (
              <InfoChip key={s} label={s} />
            ))}
          </div>
        )}
      </div>

      {/* Metrics */}
      {summary.totalTrades > 0 && <MetricStrip metrics={metrics} />}

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
      {recentTrades.length > 0 && (
        <Card className="py-0 gap-0 overflow-hidden">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Recent Trades</CardTitle>
          </CardHeader>
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
                {recentTrades.map((t) => (
                  <TradeRow key={t.id} trade={t} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {summary.totalTrades === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <User className="h-10 w-10 mb-3 opacity-30" />
          <p className="text-sm">No closed trades for {decodedName}</p>
          <p className="text-xs mt-1 opacity-50">Trades will appear here once positions close</p>
        </div>
      )}
    </div>
  );
}
