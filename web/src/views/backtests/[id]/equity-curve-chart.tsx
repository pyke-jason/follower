import {
  ComposedChart,
  Area,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { formatCurrency } from '@/lib/format';
import type { EquityPoint } from '@src/backtest/types';

export function EquityCurveChart({ data }: { data: EquityPoint[] }) {
  const hasEquity = data.some((d) => d.equity != null);
  const lastCumPnl = data[data.length - 1]?.cumPnl ?? 0;
  const curveColor = lastCumPnl >= 0 ? 'var(--color-profit)' : 'var(--color-loss)';

  return (
    <ResponsiveContainer width="100%" height={250}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={curveColor} stopOpacity={0.25} />
            <stop offset="95%" stopColor={curveColor} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis
          dataKey="date"
          tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
          axisLine={{ stroke: 'var(--color-border)' }}
          tickLine={false}
        />
        <YAxis
          yAxisId="cum"
          tickFormatter={(v: number) => formatCurrency(v)}
          tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          yAxisId="daily"
          orientation="right"
          tickFormatter={(v: number) => formatCurrency(v)}
          tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--color-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: 'var(--color-foreground)' }}
          formatter={(value: string | number | (string | number)[], name?: string) => [
            formatCurrency(value as number),
            name === 'cumPnl' ? 'Cumulative'
              : name === 'pnl' ? 'Daily P&L'
              : name === 'equity' ? 'Incl. Unrealized'
              : name ?? '',
          ]}
        />
        <ReferenceLine
          yAxisId="cum"
          y={0}
          stroke="var(--color-muted-foreground)"
          strokeDasharray="3 3"
          strokeOpacity={0.5}
        />
        <Bar yAxisId="daily" dataKey="pnl" barSize={12} radius={[2, 2, 0, 0]} opacity={0.6}>
          {data.map((entry, i) => (
            <Cell
              key={i}
              fill={entry.pnl >= 0 ? 'var(--color-profit)' : 'var(--color-loss)'}
            />
          ))}
        </Bar>
        <Area
          yAxisId="cum"
          type="monotone"
          dataKey="cumPnl"
          stroke={curveColor}
          strokeWidth={2}
          fill="url(#equityGrad)"
        />
        {hasEquity && (
          <Line
            yAxisId="cum"
            type="monotone"
            dataKey="equity"
            stroke="var(--color-chart-3)"
            strokeWidth={1.5}
            strokeDasharray="4 2"
            dot={false}
            connectNulls
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
