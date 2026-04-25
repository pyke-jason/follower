import { useState, useMemo } from 'react';
import { ScatterPlotChart, type ScatterTooltipProps } from './scatter-chart';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { formatCurrency } from '@/lib/format';
import { useSearchParam } from '@/hooks/use-search-param';
import { STRAT_COLOR, STRAT_ORDER } from '@/lib/strat-colors';
import type { Strategy } from '@src/lib/enums';
import type { BacktestDetailResponse } from '@src/local-api/http-schemas';

type TradeScatterPoint = BacktestDetailResponse['tradeScatter'][number];

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

const STRAT_SET = new Set<string>(STRAT_ORDER);

function parseStratFilter(raw: string | null): Set<Strategy> {
  if (!raw) return new Set();
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const out = new Set<Strategy>();
  for (const p of parts) {
    if (STRAT_SET.has(p)) out.add(p as Strategy);
  }
  return out;
}

function ScatterTooltip({ active, payload }: ScatterTooltipProps<TradeScatterPoint>) {
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
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
  const [stratParam, setStratParam] = useSearchParam('strat');
  const selectedStrats = useMemo(() => parseStratFilter(stratParam), [stratParam]);

  const presentStrats = useMemo(() => {
    const set = new Set<Strategy>();
    for (const pt of data) {
      if (STRAT_SET.has(pt.strategy)) set.add(pt.strategy as Strategy);
    }
    return STRAT_ORDER.filter((s) => set.has(s));
  }, [data]);

  const filteredData = useMemo(() => {
    if (selectedStrats.size === 0) return data;
    return data.filter((pt) => selectedStrats.has(pt.strategy as Strategy));
  }, [data, selectedStrats]);

  const series = useMemo(() => {
    const groups = new Map<string, TradeScatterPoint[]>();
    for (const pt of filteredData) {
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
        : colorMode === 'strategy' && STRAT_SET.has(key)
          ? STRAT_COLOR[key as Strategy]
          : colorFor(i),
      data: points,
    }));
  }, [filteredData, colorMode]);

  const quantities = filteredData.map((d) => d.quantity);
  const allSame = quantities.every((q) => q === quantities[0]);
  const zRange: [number, number] = allSame ? [60, 60] : [30, 200];

  const onStratToggle = (next: string[]) => {
    if (next.length === 0) {
      setStratParam(null);
      return;
    }
    const ordered = STRAT_ORDER.filter((s) => next.includes(s));
    setStratParam(ordered.join(','));
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2 px-1">
        <ToggleGroup
          type="single"
          value={colorMode}
          onValueChange={(v) => { if (v) setColorMode(v as ColorMode); }}
          size="sm"
        >
          {(['strategy', 'direction', 'trader'] as const).map((mode) => (
            <ToggleGroupItem key={mode} value={mode} className="text-[10px] px-2 py-0.5">
              {mode}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {presentStrats.length > 1 && (
          <ToggleGroup
            type="multiple"
            value={[...selectedStrats]}
            onValueChange={onStratToggle}
            size="sm"
            aria-label="Filter by strategy"
          >
            {presentStrats.map((s) => (
              <ToggleGroupItem
                key={s}
                value={s}
                className="text-[10px] px-2 py-0.5 gap-1"
              >
                <span
                  aria-hidden
                  className="inline-block size-2 rounded-sm"
                  style={{ backgroundColor: STRAT_COLOR[s] }}
                />
                {s}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        {selectedStrats.size > 0 && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {filteredData.length}/{data.length}
          </span>
        )}
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
