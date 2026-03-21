import { useState, useMemo } from 'react';
import { ScatterPlotChart } from '../../components/charts/scatter-chart';
import { formatCurrency } from '@/lib/format';
export type TradeScatterPoint = {
  symbol: string;
  pnl: number;
  strategy: string;
  direction: string;
  trader: string;
  date: string;
  quantity: number;
};

const CHART_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
];

type ColorMode = 'strategy' | 'direction' | 'trader';

function colorFor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

function ScatterTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TradeScatterPoint }> }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload as TradeScatterPoint;
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-foreground">{d.symbol}</div>
      <div className="text-muted-foreground">{d.date}</div>
      <div className={d.pnl >= 0 ? 'text-profit font-semibold' : 'text-loss font-semibold'}>
        {formatCurrency(d.pnl)}
      </div>
      <div className="text-muted-foreground">
        {d.direction} · {d.strategy} · {d.quantity} qty
      </div>
      <div className="text-muted-foreground">{d.trader}</div>
    </div>
  );
}

export function TradeScatter({ data }: { data: TradeScatterPoint[] }) {
  const [colorMode, setColorMode] = useState<ColorMode>('strategy');

  const series = useMemo(() => {
    const groups = new Map<string, TradeScatterPoint[]>();
    for (const pt of data) {
      const key = colorMode === 'strategy' ? pt.strategy
        : colorMode === 'direction' ? pt.direction
        : pt.trader;
      const group = groups.get(key) ?? [];
      group.push(pt);
      groups.set(key, group);
    }

    return [...groups.entries()].map(([key, points], i) => ({
      key,
      label: key,
      color: colorMode === 'direction'
        ? (key === 'LONG' ? 'var(--color-profit)' : 'var(--color-loss)')
        : colorFor(i),
      data: points,
    }));
  }, [data, colorMode]);

  // Compute zRange based on quantity variance
  const quantities = data.map((d) => d.quantity);
  const allSame = quantities.every((q) => q === quantities[0]);
  const zRange: [number, number] = allSame ? [60, 60] : [30, 200];

  return (
    <div>
      <div className="flex gap-1 mb-2 px-1">
        {(['strategy', 'direction', 'trader'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setColorMode(mode)}
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
              colorMode === mode
                ? 'bg-foreground text-background border-foreground'
                : 'text-muted-foreground border-border hover:border-foreground/30'
            }`}
          >
            {mode}
          </button>
        ))}
      </div>
      <ScatterPlotChart
        series={series}
        xKey="date"
        yKey="pnl"
        zKey="quantity"
        height={280}
        formatY={(v: number) => formatCurrency(v)}
        tooltipContent={ScatterTooltip}
        referenceLines={[{ y: 0, label: '$0' }]}
        zRange={zRange}
      />
    </div>
  );
}
