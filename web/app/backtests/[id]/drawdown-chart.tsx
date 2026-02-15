'use client';

import { useMemo } from 'react';
import { AreaChartComponent } from '../../components/charts/area-chart';
import { formatCurrency } from '@/lib/format';

type EquityPoint = {
  date: string;
  cumPnl: number;
};

export function DrawdownChart({ data }: { data: EquityPoint[] }) {
  const drawdownData = useMemo(() => {
    let peak = 0;
    return data.map((pt) => {
      if (pt.cumPnl > peak) peak = pt.cumPnl;
      const drawdown = peak - pt.cumPnl;
      return { date: pt.date, drawdown: -drawdown };
    });
  }, [data]);

  const hasDrawdown = drawdownData.some((d) => d.drawdown < 0);
  if (!hasDrawdown) return null;

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
