import {
  LineChart as RechartsLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import type { Formatter, NameType } from 'recharts/types/component/DefaultTooltipContent';

type LineSeries = {
  key: string;
  label: string;
  color: string;
};

type ReferenceLineConfig = {
  y: number;
  label?: string;
  color?: string;
  strokeDasharray?: string;
};

type MultiLineChartProps = {
  data: Record<string, unknown>[];
  xKey: string;
  series: LineSeries[];
  height?: number;
  formatX?: (v: string) => string;
  formatY?: (v: number) => string;
  tooltipFormatter?: Formatter<number | string, NameType>;
  domain?: [number | string, number | string];
  referenceLines?: ReferenceLineConfig[];
};

export function MultiLineChart({
  data,
  xKey,
  series,
  height = 300,
  formatX,
  formatY,
  tooltipFormatter,
  domain,
  referenceLines,
}: MultiLineChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsLineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
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
          domain={domain}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--color-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: 'var(--color-foreground)' }}
          formatter={tooltipFormatter}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, color: 'var(--color-muted-foreground)' }}
        />
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
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        ))}
      </RechartsLineChart>
    </ResponsiveContainer>
  );
}
