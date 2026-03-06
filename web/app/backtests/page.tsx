import { useQuery } from '@tanstack/react-query';
import { fetchBacktestsPageData } from '@/lib/page-adapters';
import { BacktestList } from './backtest-list';

const Spinner = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin h-6 w-6 border-2 border-muted-foreground/20 border-t-foreground rounded-full" />
  </div>
);

export default function BacktestsPage() {
  const { data } = useQuery({
    queryKey: ['backtests'],
    queryFn: fetchBacktestsPageData,
    refetchInterval: (query) => {
      const runs = query.state.data?.runs;
      if (runs?.some((r) => r.status === 'RUNNING' || r.status === 'PENDING')) return 3000;
      return false;
    },
  });

  if (!data) return <Spinner />;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-foreground">Backtests</h2>
      <BacktestList runs={data.runs} experimentTags={data.experimentTags} />
    </div>
  );
}
