import { notFound } from 'next/navigation';
import { getBacktestRunsForComparison, getDecisionDiff } from '@/lib/queries';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { pctDisplay } from '../../../../src/lib/numbers';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { BacktestRunConfig, BacktestRunSummary } from '../../../../src/db/schema';
import { ComparisonTable } from './comparison-table';
import { OverlaidEquity } from './overlaid-equity';
import { DecisionDiff } from './decision-diff';

export const dynamic = 'force-dynamic';

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const params = await searchParams;
  const ids = params.ids?.split(',').filter(Boolean) ?? [];
  if (ids.length < 2) notFound();

  const runs = await getBacktestRunsForComparison(ids);
  if (runs.length < 2) notFound();

  // Only compute diff for exactly 2 runs
  const diffs = ids.length === 2 ? await getDecisionDiff(ids[0], ids[1]) : [];

  // Prepare data for each run
  const runData = runs.map((run) => {
    const config = run.config as BacktestRunConfig;
    const summary = run.summary as BacktestRunSummary | null;
    const equityCurve = run.equityCurve as { date: string; pnl: number; cumPnl: number }[] | null;
    return {
      id: run.id,
      name: run.name ?? config.traders.join(', '),
      config,
      summary,
      equityCurve: equityCurve ?? [],
      status: run.status,
    };
  });

  return (
    <div className="space-y-6 max-w-6xl animate-in-up">
      <div className="flex items-center gap-3">
        <Link href="/backtests" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h2 className="text-lg font-bold text-foreground tracking-tight">
          Compare Runs ({runs.length})
        </h2>
      </div>

      {/* Metrics comparison table */}
      <ComparisonTable runs={runData} />

      {/* Overlaid equity curves */}
      {runData.some((r) => r.equityCurve.length > 0) && (
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Equity Curves</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            <OverlaidEquity runs={runData.map((r) => ({ id: r.id, name: r.name, data: r.equityCurve }))} />
          </CardContent>
        </Card>
      )}

      {/* Decision diff */}
      {diffs.length > 0 && (
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">
              Decision Differences ({diffs.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DecisionDiff diffs={diffs} runAName={runData[0]?.name ?? 'Run A'} runBName={runData[1]?.name ?? 'Run B'} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
