'use client';

import {
  ScatterChart as RechartsScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';

type ScatterSeries = {
  key: string;
  label: string;
  color: string;
  data: Record<string, unknown>[];
};

type ReferenceLineConfig = {
  y: number;
  label?: string;
  color?: string;
  strokeDasharray?: string;
};

type ScatterPlotChartProps = {
  series: ScatterSeries[];
  xKey: string;
  yKey: string;
  zKey?: string;
  height?: number;
  formatX?: (v: string) => string;
  formatY?: (v: number) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tooltipContent?: (props: any) => React.ReactNode;
  referenceLines?: ReferenceLineConfig[];
  zRange?: [number, number];
};

export function ScatterPlotChart({
  series,
  xKey,
  yKey,
  zKey,
  height = 300,
  formatX,
  formatY,
  tooltipContent,
  referenceLines,
  zRange = [30, 200],
}: ScatterPlotChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis
          dataKey={xKey}
          tickFormatter={formatX}
          tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
          axisLine={{ stroke: 'var(--color-border)' }}
          tickLine={false}
          type="category"
          allowDuplicatedCategory={false}
        />
        <YAxis
          dataKey={yKey}
          tickFormatter={formatY}
          tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          type="number"
        />
        {zKey && <ZAxis dataKey={zKey} range={zRange} />}
        {referenceLines?.map((rl, i) => (
          <ReferenceLine
            key={`ref-${i}`}
            y={rl.y}
            stroke={rl.color ?? 'var(--color-muted-foreground)'}
            strokeDasharray={rl.strokeDasharray ?? '3 3'}
            strokeOpacity={0.6}
            label={rl.label ? {
              value: rl.label,
              position: 'insideTopRight',
              fill: 'var(--color-muted-foreground)',
              fontSize: 10,
            } : undefined}
          />
        ))}
        {tooltipContent ? (
          <Tooltip content={tooltipContent} />
        ) : (
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-card)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: 'var(--color-foreground)' }}
          />
        )}
        <Legend
          wrapperStyle={{ fontSize: 12, color: 'var(--color-muted-foreground)' }}
        />
        {series.map((s) => (
          <Scatter
            key={s.key}
            name={s.label}
            data={s.data}
            fill={s.color}
            fillOpacity={0.7}
          />
        ))}
      </RechartsScatterChart>
    </ResponsiveContainer>
  );
}
