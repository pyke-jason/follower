'use client';

import { MultiLineChart } from '../components/charts/line-chart';

type EvalRun = {
  id: string;
  ranAt: string;
  overallAccuracy: number | null;
  actionAccuracy: number | null;
  directionAccuracy: number | null;
  strategyAccuracy: number | null;
  priceAccuracy: number | null;
  exitPriceAccuracy: number | null;
  strikesAccuracy: number | null;
};

const SERIES = [
  { key: 'overall', label: 'Overall', color: 'var(--color-chart-1)' },
  { key: 'action', label: 'Action', color: 'var(--color-chart-2)' },
  { key: 'direction', label: 'Direction', color: 'var(--color-chart-3)' },
  { key: 'strategy', label: 'Strategy', color: 'var(--color-chart-4)' },
  { key: 'price', label: 'Price', color: 'var(--color-chart-5)' },
  { key: 'exitPrice', label: 'Exit Price', color: 'var(--color-profit)' },
  { key: 'strikes', label: 'Strikes', color: 'var(--color-loss)' },
];

export function AccuracyChart({ evalRuns }: { evalRuns: EvalRun[] }) {
  if (evalRuns.length < 2) return null;

  const data = evalRuns.map((run) => ({
    date: new Date(run.ranAt).toLocaleDateString(),
    overall: run.overallAccuracy != null ? +(run.overallAccuracy * 100).toFixed(1) : null,
    action: run.actionAccuracy != null ? +(run.actionAccuracy * 100).toFixed(1) : null,
    direction: run.directionAccuracy != null ? +(run.directionAccuracy * 100).toFixed(1) : null,
    strategy: run.strategyAccuracy != null ? +(run.strategyAccuracy * 100).toFixed(1) : null,
    price: run.priceAccuracy != null ? +(run.priceAccuracy * 100).toFixed(1) : null,
    exitPrice: run.exitPriceAccuracy != null ? +(run.exitPriceAccuracy * 100).toFixed(1) : null,
    strikes: run.strikesAccuracy != null ? +(run.strikesAccuracy * 100).toFixed(1) : null,
  }));

  return (
    <MultiLineChart
      data={data}
      xKey="date"
      series={SERIES}
      height={300}
      formatY={(v: number) => `${v}%`}
      tooltipFormatter={(value: number, name: string) => [`${value}%`, name]}
      domain={[0, 100]}
    />
  );
}
