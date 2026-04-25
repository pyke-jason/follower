import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { formatCurrency, formatCurrencyAxis, formatDateShort, formatDateTooltip } from '@/lib/format';

type CurvePoint<Key extends string> = { date: string } & Record<Key, number>;

export type UnrealizedPnlPoint = CurvePoint<'unrealizedPnl'>;

interface CurveProps<Key extends string> {
  data: CurvePoint<Key>[];
  dataKey: Key;
  label: string;
}

interface UnrealizedProps {
  data: UnrealizedPnlPoint[];
}

interface EquityProps {
  data: CurvePoint<'equity'>[];
}

function OverviewCurve<Key extends string>({ data, dataKey, label }: CurveProps<Key>) {
  if (data.length < 2) return null;

  const chartConfig = {
    [dataKey]: {
      label,
      color: 'var(--profit)',
    },
  } satisfies ChartConfig;

  const last = data[data.length - 1][dataKey];
  const isPositive = last >= 0;
  const color = isPositive ? 'oklch(0.72 0.19 155)' : 'oklch(0.68 0.22 25)';

  return (
    <ChartContainer config={chartConfig} className="h-[180px] w-full aspect-auto">
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 12 }}>
        <defs>
          <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid
          vertical={false}
          strokeDasharray="3 3"
          className="stroke-border/40"
        />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={40}
          tickFormatter={(value) => formatDateShort(value)}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={formatCurrencyAxis}
        />
        <ChartTooltip
          cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1, strokeDasharray: '4 4' }}
          content={
            <ChartTooltipContent
              labelFormatter={(value) => formatDateTooltip(value)}
              formatter={(value) => (
                <span className="font-mono font-semibold tabular-nums">
                  {formatCurrency(value as number)}
                </span>
              )}
            />
          }
        />
        <Area
          dataKey={dataKey}
          type="monotone"
          fill="url(#equityFill)"
          stroke={color}
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  );
}

export function OverviewUnrealizedCurve({ data }: UnrealizedProps) {
  return <OverviewCurve data={data} dataKey="unrealizedPnl" label="Unrealized P&L" />;
}

export function OverviewEquityCurve({ data }: EquityProps) {
  return <OverviewCurve data={data} dataKey="equity" label="Cumulative P&L" />;
}
