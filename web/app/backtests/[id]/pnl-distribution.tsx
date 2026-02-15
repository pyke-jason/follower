'use client';

import { useMemo } from 'react';
import { BarChartComponent } from '../../components/charts/bar-chart';
import { formatCurrency } from '@/lib/format';
import { safeParseFloat } from '../../../../src/lib/numbers';

type TradeRow = {
  pnl: string | null;
};

export function PnlDistribution({ trades }: { trades: TradeRow[] }) {
  const bucketData = useMemo(() => {
    const pnls = trades
      .map((t) => (t.pnl != null ? safeParseFloat(t.pnl) : null))
      .filter((v): v is number => v !== null);

    if (pnls.length === 0) return [];

    const min = Math.min(...pnls);
    const max = Math.max(...pnls);
    const range = max - min;

    if (range === 0) return [{ bucket: formatCurrency(min), count: pnls.length, midpoint: min }];

    const bucketCount = Math.min(20, Math.max(5, Math.ceil(Math.sqrt(pnls.length))));
    const bucketSize = range / bucketCount;

    const buckets: { bucket: string; count: number; midpoint: number }[] = [];
    for (let i = 0; i < bucketCount; i++) {
      const lo = min + i * bucketSize;
      const hi = lo + bucketSize;
      const mid = (lo + hi) / 2;
      const cnt = pnls.filter((p) => (i === bucketCount - 1 ? p >= lo && p <= hi : p >= lo && p < hi)).length;
      buckets.push({
        bucket: formatCurrency(mid),
        count: cnt,
        midpoint: mid,
      });
    }

    return buckets.filter((b) => b.count > 0);
  }, [trades]);

  if (bucketData.length === 0) return null;

  return (
    <BarChartComponent
      data={bucketData}
      xKey="bucket"
      yKey="count"
      height={250}
      colorByValue={false}
      color="var(--color-chart-1)"
      tooltipFormatter={(value: number, name: string) => [
        String(value),
        name === 'count' ? 'Trades' : name,
      ]}
    />
  );
}
