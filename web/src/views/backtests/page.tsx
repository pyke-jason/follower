import { useQuery } from '@tanstack/react-query';
import { queries } from '@/lib/queries';
import { BacktestList } from './backtest-list';
import { QueryBoundary, TableSkeleton } from '@/components/query-boundary';

export default function BacktestsPage() {
  const query = useQuery(queries.backtests.list());

  return (
    <QueryBoundary query={query} skeleton={<TableSkeleton />}>
      {(data) => (
        <div className="h-full flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-foreground shrink-0">Backtests</h2>
          <BacktestList runs={data.runs} experimentTags={data.experimentTags} />
        </div>
      )}
    </QueryBoundary>
  );
}
