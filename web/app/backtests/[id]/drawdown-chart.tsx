import { useMemo } from 'react';
import { AreaChartComponent } from '../../components/charts/area-chart';
import { formatCurrency } from '@/lib/format';
import type { EquityPoint } from '@src/backtest/types';

export function DrawdownChart({ data }: { data: EquityPoint[] }) {
  const drawdownData = useMemo(() =>
    data.map((pt) => ({ date: pt.date, drawdown: -(pt.drawdown ?? 0) })),
    [data],
  );

  if (!data.some((d) => (d.drawdown ?? 0) > 0)) return null;

  return (
    <AreaChartComponent
      data={drawdownData}
      xKey="date"
      yKey="drawdown"
      color="var(--color-loss)"
      gradientColor="var(--color-loss)"
      height={200}
      formatY={(v: number) => formatCurrency(v)}
      tooltipFormatter={(value: number) => [formatCurrency(value), 'Drawdown']}
      domain={['dataMin', 0]}
    />
  );
}
