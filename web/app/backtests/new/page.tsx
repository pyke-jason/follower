import { getTrackedTraders, getBacktestRunById } from '@/lib/queries';
import { Card, CardContent } from '@/components/ui/card';
import { BacktestForm } from './backtest-form';
import Link from 'next/link';
import type { BacktestRunConfig } from '../../../../src/db/schema';
import { getConfig } from '../../../../src/db/accessors';

export const dynamic = 'force-dynamic';

export default async function NewBacktestPage({
  searchParams,
}: {
  searchParams: Promise<{ clone?: string }>;
}) {
  const { clone } = await searchParams;
  const traders = await getTrackedTraders();
  const traderNames = traders.map((t) => t.name).join(', ');

  let defaultConfig: BacktestRunConfig | undefined;
  if (clone) {
    const sourceRun = await getBacktestRunById(clone);
    if (sourceRun) {
      defaultConfig = getConfig(sourceRun);
    }
  }

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div className="flex items-center gap-3">
        <Link href="/backtests" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Backtests
        </Link>
        <h2 className="text-lg font-semibold text-foreground">
          {defaultConfig ? 'Clone Backtest' : 'New Backtest'}
        </h2>
      </div>

      <Card className="py-4 gap-3">
        <CardContent>
          <BacktestForm defaultTraders={traderNames} defaultConfig={defaultConfig} />
        </CardContent>
      </Card>
    </div>
  );
}
