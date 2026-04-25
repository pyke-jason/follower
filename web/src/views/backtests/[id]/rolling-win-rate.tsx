import { MultiLineChart } from './line-chart';
import { EmptyState } from '@/components/empty-state';
import type { BacktestDetailResponse } from '@src/local-api/http-schemas';

type RollingWinRatePoint = BacktestDetailResponse['rollingWinRate'][number];

export function RollingWinRate({ data }: { data: RollingWinRatePoint[] }) {
  if (data.length === 0) {
    return (
      <EmptyState
        title="Not enough trades"
        hint="Need 5+ trades for rolling win rate"
        className="h-[200px] py-0"
      />
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
