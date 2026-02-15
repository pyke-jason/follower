'use client';

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';

const COLORS = ['var(--color-chart-1)', 'var(--color-chart-2)', 'var(--color-chart-3)'];

interface RunEquity {
  id: string;
  name: string;
  data: { date: string; cumPnl: number }[];
}

export function OverlaidEquity({ runs }: { runs: RunEquity[] }) {
  // Merge all runs' data into a single array keyed by date
  const dateMap = new Map<string, Record<string, number>>();

  for (const run of runs) {
    for (const pt of run.data) {
      const existing = dateMap.get(pt.date) ?? {};
      existing[run.id] = pt.cumPnl;
      dateMap.set(pt.date, existing);
    }
  }

  const merged = Array.from(dateMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({ date, ...values }));

  if (merged.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={merged} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis
          dataKey="date"
          tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
          axisLine={{ stroke: 'var(--color-border)' }}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: 'var(--color-muted-foreground)', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `$${v}`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--color-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Legend />
        {runs.map((run, i) => (
          <Line
            key={run.id}
            type="monotone"
            dataKey={run.id}
            name={run.name}
            stroke={COLORS[i % COLORS.length]}
            strokeWidth={2}
            dot={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
