'use client';

import Link from 'next/link';
import { BarChartComponent } from '../../components/charts/bar-chart';
import { formatCurrency } from '@/lib/format';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

type BreakdownEntry = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl?: number;
};

export function BreakdownCharts({
  byTrader,
  byStrategy,
  runId,
}: {
  byTrader: Record<string, BreakdownEntry> | null;
  byStrategy: Record<string, BreakdownEntry> | null;
  runId?: string;
}) {
  const traderData = byTrader
    ? Object.entries(byTrader)
        .map(([name, stats]) => ({ name, pnl: stats.totalPnl, trades: stats.trades, winRate: stats.winRate }))
        .sort((a, b) => b.pnl - a.pnl)
    : [];

  const strategyData = byStrategy
    ? Object.entries(byStrategy)
        .map(([name, stats]) => ({ name, pnl: stats.totalPnl, trades: stats.trades, winRate: stats.winRate }))
        .sort((a, b) => b.pnl - a.pnl)
    : [];

  const noData = (
    <div className="flex items-center justify-center text-xs text-muted-foreground h-[120px]">
      No data yet
    </div>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card className="py-0 gap-0">
        <CardHeader className="border-b py-3 px-4">
          <CardTitle className="text-sm">P&L by Trader</CardTitle>
        </CardHeader>
        <CardContent className="pt-4 pb-2 px-2">
          {traderData.length > 0 ? (
            <BarChartComponent
              data={traderData}
              xKey="name"
              yKey="pnl"
              layout="vertical"
              colorByValue
              height={Math.max(120, traderData.length * 40)}
              formatY={(v: number) => formatCurrency(v)}
              tooltipFormatter={(value: number) => [formatCurrency(value), 'P&L']}
            />
          ) : noData}
        </CardContent>
        {traderData.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pb-3">
            {traderData.map((t) => (
              <Link
                key={t.name}
                href={`/trades?trader=${encodeURIComponent(t.name)}${runId ? `&run=${runId}` : ''}`}
                className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 decoration-dashed"
              >
                {t.name} →
              </Link>
            ))}
          </div>
        )}
      </Card>
      <Card className="py-0 gap-0">
        <CardHeader className="border-b py-3 px-4">
          <CardTitle className="text-sm">P&L by Strategy</CardTitle>
        </CardHeader>
        <CardContent className="pt-4 pb-2 px-2">
          {strategyData.length > 0 ? (
            <BarChartComponent
              data={strategyData}
              xKey="name"
              yKey="pnl"
              layout="vertical"
              colorByValue
              height={Math.max(120, strategyData.length * 40)}
              formatY={(v: number) => formatCurrency(v)}
              tooltipFormatter={(value: number) => [formatCurrency(value), 'P&L']}
            />
          ) : noData}
        </CardContent>
        {strategyData.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pb-3">
            {strategyData.map((s) => (
              <Link
                key={s.name}
                href={`/trades?strategy=${encodeURIComponent(s.name)}${runId ? `&run=${runId}` : ''}`}
                className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 decoration-dashed"
              >
                {s.name} →
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
