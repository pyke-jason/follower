'use client';

import {
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

type BarChartProps = {
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string;
  height?: number;
  layout?: 'horizontal' | 'vertical';
  colorByValue?: boolean;
  color?: string;
  formatX?: (v: string) => string;
  formatY?: (v: number) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tooltipFormatter?: (...args: any[]) => [string, string];
  barSize?: number;
};

export function BarChartComponent({
  data,
  xKey,
  yKey,
  height = 300,
  layout = 'horizontal',
  colorByValue = false,
  color = 'var(--color-chart-1)',
  formatX,
  formatY,
  tooltipFormatter,
  barSize,
}: BarChartProps) {
  const isVertical = layout === 'vertical';

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsBarChart
        data={data}
        layout={layout}
        margin={{ top: 8, right: 8, left: isVertical ? 80 : 0, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        {isVertical ? (
          <>
            <XAxis
              type="number"
              tickFormatter={formatY}
              tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
              axisLine={{ stroke: 'var(--color-border)' }}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey={xKey}
              tickFormatter={formatX}
              tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={75}
            />
          </>
        ) : (
          <>
            <XAxis
              dataKey={xKey}
              tickFormatter={formatX}
              tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
              axisLine={{ stroke: 'var(--color-border)' }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={formatY}
              tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
          </>
        )}
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--color-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: 'var(--color-foreground)' }}
          formatter={tooltipFormatter}
          cursor={{ fill: 'var(--color-muted)', opacity: 0.3 }}
        />
        <Bar dataKey={yKey} barSize={barSize} radius={[4, 4, 0, 0]}>
          {colorByValue
            ? data.map((entry, i) => (
                <Cell
                  key={i}
                  fill={
                    (entry[yKey] as number) >= 0
                      ? 'var(--color-profit)'
                      : 'var(--color-loss)'
                  }
                />
              ))
            : data.map((_, i) => <Cell key={i} fill={color} />)}
        </Bar>
      </RechartsBarChart>
    </ResponsiveContainer>
  );
}
