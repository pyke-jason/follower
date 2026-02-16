import { getBacktestRuns, getDistinctExperimentTags } from '@/lib/queries';
import { AutoRefresh } from '../components/auto-refresh';
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
      <h2 className="text-lg font-semibold text-foreground">Backtests</h2>

      {hasRunning && <AutoRefresh intervalMs={3000} />}

      <BacktestList runs={runs} experimentTags={experimentTags} />
    </div>
  );
}
