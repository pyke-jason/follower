import { getTrackedTraders } from '@/lib/queries';
import { Card, CardContent } from '@/components/ui/card';
import { BacktestForm } from './backtest-form';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function NewBacktestPage() {
  const traders = await getTrackedTraders();
  const traderNames = traders.map((t) => t.name).join(', ');

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-3">
        <Link href="/backtests" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Backtests
        </Link>
        <h2 className="text-xl font-bold text-foreground">New Backtest</h2>
      </div>

      <Card className="py-4 gap-3">
        <CardContent>
          <BacktestForm defaultTraders={traderNames} />
        </CardContent>
      </Card>
    </div>
  );
}
