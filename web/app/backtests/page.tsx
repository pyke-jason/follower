import { getBacktestRuns, getDistinctExperimentTags } from '@/lib/queries';
import { AutoRefresh } from '../components/auto-refresh';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { BacktestList } from './backtest-list';

export const dynamic = 'force-dynamic';

export default async function BacktestsPage() {
  const [runs, experimentTags] = await Promise.all([
    getBacktestRuns(),
    getDistinctExperimentTags(),
  ]);

  const hasRunning = runs.some((r) => r.status === 'RUNNING' || r.status === 'PENDING');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Backtests</h2>
        <Button size="sm" asChild>
          <Link href="/backtests/new">New Backtest</Link>
        </Button>
      </div>

      {hasRunning && <AutoRefresh intervalMs={3000} />}

      <BacktestList runs={runs} experimentTags={experimentTags} />
    </div>
  );
}
