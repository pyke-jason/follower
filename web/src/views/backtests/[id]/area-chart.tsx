import {
  AreaChart as RechartsAreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

type AreaChartProps = {
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string;
  color?: string;
  gradientColor?: string;
  height?: number;
  formatX?: (v: string) => string;
  formatY?: (v: number) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tooltipFormatter?: (...args: any[]) => [string, string];
  domain?: [number | string, number | string];
};

export function AreaChartComponent({
  data,
  xKey,
  yKey,
  color = 'var(--color-chart-2)',
  gradientColor,
  height = 300,
  formatX,
  formatY,
  tooltipFormatter,
  domain,
}: AreaChartProps) {
  const fillColor = gradientColor ?? color;
  const gradientId = `gradient-${yKey}`;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsAreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={fillColor} stopOpacity={0.3} />
            <stop offset="95%" stopColor={fillColor} stopOpacity={0} />
          </linearGradient>
        </defs>
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
        <Area
          type="monotone"
          dataKey={yKey}
          stroke={color}
          strokeWidth={2}
          fill={`url(#${gradientId})`}
        />
      </RechartsAreaChart>
    </ResponsiveContainer>
  );
}
