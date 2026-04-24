import { useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { BacktestForm } from './backtest-form';
import { Spinner } from '@/components/spinner';
import type { BacktestRun, BacktestRunConfig } from '@src/db/schema';

type BacktestCloneSource = {
  run: BacktestRun;
};

export default function NewBacktestPage() {
  const [params] = useSearchParams();
  const cloneId = params.get('clone') ?? undefined;

  const { data: trackedTraders } = useQuery<Array<{ name: string }>>({
    queryKey: ['trader-names'],
    queryFn: () => api('/tracked-traders'),
  });

  const { data: cloneSource } = useQuery<BacktestCloneSource>({
    queryKey: ['backtest-clone', cloneId],
    queryFn: () => api<BacktestCloneSource>(`/backtests/${cloneId}`),
    enabled: !!cloneId,
  });

  if (!trackedTraders) return <Spinner />;

  const defaultConfig: BacktestRunConfig | undefined = cloneSource?.run.config;
  const traderOptions = trackedTraders.map((t) => t.name);
  const defaultTraders = defaultConfig?.traders ?? traderOptions;

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div className="flex items-center gap-3">
        <Link to="/backtests" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Backtests
        </Link>
        <h2 className="text-lg font-semibold text-foreground">
          {defaultConfig ? 'Clone Backtest' : 'New Backtest'}
        </h2>
      </div>

      <Card className="py-4 gap-3">
        <CardContent>
          <BacktestForm traderOptions={traderOptions} defaultTraders={defaultTraders} defaultConfig={defaultConfig} />
        </CardContent>
      </Card>
    </div>
  );
}
