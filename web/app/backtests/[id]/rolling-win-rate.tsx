'use client';

import { MultiLineChart } from '../../components/charts/line-chart';
import type { RollingWinRatePoint } from './page';

export function RollingWinRate({ data }: { data: RollingWinRatePoint[] }) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center text-xs text-muted-foreground h-[200px]">
        Need 5+ trades for rolling win rate
      </div>
    );
  }

  const windowSize = data[0]?.windowSize ?? 5;

  const chartData = data.map((d) => ({
    label: `#${d.tradeNum}`,
    winRate: d.winRate,
  }));

  return (
    <MultiLineChart
      data={chartData}
      xKey="label"
      series={[
        { key: 'winRate', label: `Win Rate (${windowSize}-trade)`, color: 'var(--color-chart-1)' },
      ]}
      height={200}
      formatY={(v: number) => `${(v * 100).toFixed(0)}%`}
      tooltipFormatter={(value: string | number) => [
        `${((value as number) * 100).toFixed(1)}%`,
        'Win Rate',
      ]}
      domain={[0, 1]}
      referenceLines={[{ y: 0.5, label: '50%', color: 'var(--color-muted-foreground)' }]}
    />
  );
}
