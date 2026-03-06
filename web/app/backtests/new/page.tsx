import { useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { BacktestForm } from './backtest-form';

const Spinner = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin h-6 w-6 border-2 border-muted-foreground/20 border-t-foreground rounded-full" />
  </div>
);

export default function NewBacktestPage() {
  const [params] = useSearchParams();
  const cloneId = params.get('clone') ?? undefined;

  const { data: trackedTraders } = useQuery<Array<{ name: string }>>({
    queryKey: ['trader-names'],
    queryFn: () => api('/tracked-traders'),
  });

  const { data: cloneSource } = useQuery<{ config: any; run?: { config?: any } }>({
    queryKey: ['backtest-clone', cloneId],
    queryFn: () => api(`/backtests/${cloneId}`),
    enabled: !!cloneId,
  });

  if (!trackedTraders) return <Spinner />;

  const defaultConfig = cloneSource?.config ?? cloneSource?.run?.config;
  const defaultTraders = trackedTraders.map((t) => t.name).join(', ');

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
          <BacktestForm defaultTraders={defaultTraders} defaultConfig={defaultConfig} />
        </CardContent>
      </Card>
    </div>
  );
}
