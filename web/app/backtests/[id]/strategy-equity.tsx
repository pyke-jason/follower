'use client';

import { MultiLineChart } from '../../components/charts/line-chart';
import { formatCurrency } from '@/lib/format';
import type { StrategyEquityPoint } from './page';

const CHART_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
];

export function StrategyEquityChart({
  data,
  strategies,
}: {
  data: StrategyEquityPoint[];
  strategies: string[];
}) {
  const series = strategies.map((s, i) => ({
    key: s,
    label: s,
    color: CHART_COLORS[i % CHART_COLORS.length],
  }));

  return (
    <MultiLineChart
      data={data}
      xKey="date"
      series={series}
      height={250}
      formatY={(v: number) => formatCurrency(v)}
      tooltipFormatter={(value: string | number, name?: string) => [
        formatCurrency(value as number),
        name ?? '',
      ]}
      referenceLines={[{ y: 0, label: '$0' }]}
    />
  );
}
