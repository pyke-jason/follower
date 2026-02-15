'use client';

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';

const chartConfig = {
  equity: {
    label: 'Equity',
    color: 'var(--profit)',
  },
} satisfies ChartConfig;

interface Props {
  data: { date: string; equity: number }[];
}

export function OverviewEquityCurve({ data }: Props) {
  if (data.length < 2) return null;

  const first = data[0].equity;
  const last = data[data.length - 1].equity;
  const isPositive = last >= first;
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
          tickFormatter={(value) =>
            new Date(value).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })
          }
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={(value) =>
            new Intl.NumberFormat('en-US', {
              style: 'currency',
              currency: 'USD',
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
              notation: 'compact',
            }).format(value)
          }
        />
        <ChartTooltip
          cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1, strokeDasharray: '4 4' }}
          content={
            <ChartTooltipContent
              labelFormatter={(value) =>
                new Date(value).toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })
              }
              formatter={(value) => (
                <span className="font-mono font-semibold tabular-nums">
                  {new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                  }).format(value as number)}
                </span>
              )}
            />
          }
        />
        <Area
          dataKey="equity"
          type="monotone"
          fill="url(#equityFill)"
          stroke={color}
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  );
}
