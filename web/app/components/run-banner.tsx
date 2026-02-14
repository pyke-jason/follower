import { getBacktestRunById } from '@/lib/queries';
import { Badge as ShadcnBadge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/format';
import Link from 'next/link';
import type { BacktestRunConfig, BacktestRunSummary } from '../../../src/db/schema';

export async function RunBanner({ runId, currentPath }: { runId: string; currentPath: string }) {
  const run = await getBacktestRunById(runId);
  if (!run) return null;

  const config = run.config as BacktestRunConfig;
  const summary = run.summary as BacktestRunSummary | null;
  const startDate = config.startDate.split('T')[0];
  const endDate = config.endDate.split('T')[0];

  // Build exit URL (current path without ?run=)
  const exitUrl = currentPath.split('?')[0];

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-blue-950/50 border border-blue-800/50 rounded-lg text-sm mb-4">
      <ShadcnBadge variant="outline" className="rounded bg-blue-900/50 text-blue-300 border-blue-700">
        Backtest
      </ShadcnBadge>
      <span className="text-muted-foreground">
        {config.traders.join(', ')}
      </span>
      <span className="text-muted-foreground">
        {startDate} &ndash; {endDate}
      </span>
      {summary && (
        <>
          <span className="text-muted-foreground">
            {(summary.winRate * 100).toFixed(0)}% WR
          </span>
          <span className={summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            {formatCurrency(summary.totalPnl)}
          </span>
        </>
      )}
      <Link
        href={`/backtests/${runId}`}
        className="text-blue-400 hover:underline text-xs ml-auto"
      >
        Details
      </Link>
      <Link
        href={exitUrl}
        className="text-muted-foreground hover:text-foreground text-xs"
      >
        Exit
      </Link>
    </div>
  );
}
