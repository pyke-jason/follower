'use client';

import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ZAxis,
} from 'recharts';
import { formatCurrency } from '@/lib/format';

type DecisionPoint = {
  date: string;
  pnl: number;
  decision: string;
  message: string;
};

export function DecisionScatter({ data }: { data: DecisionPoint[] }) {
  const executed = data.filter((d) => d.decision === 'EXECUTE');
  const skipped = data.filter((d) => d.decision === 'SKIP');

  if (data.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis
          dataKey="date"
          type="category"
          allowDuplicatedCategory={false}
          tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
          axisLine={{ stroke: 'var(--color-border)' }}
          tickLine={false}
        />
        <YAxis
          dataKey="pnl"
          type="number"
          tickFormatter={(v: number) => formatCurrency(v)}
          tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <ZAxis range={[40, 40]} />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--color-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: 'var(--color-foreground)' }}
          formatter={(value: string | number | (string | number)[], name?: string) => {
            if (value == null) return ['-', name ?? ''];
            if (name === 'pnl') return [formatCurrency(value as number), 'P&L'];
            return [String(value), name ?? ''];
          }}
        />
        {executed.length > 0 && (
          <Scatter
            name="Executed"
            data={executed}
            fill="var(--color-profit)"
            opacity={0.8}
          />
        )}
        {skipped.length > 0 && (
          <Scatter
            name="Skipped"
            data={skipped}
            fill="var(--color-muted-foreground)"
            opacity={0.5}
          />
        )}
      </ScatterChart>
    </ResponsiveContainer>
  );
}
