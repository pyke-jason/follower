import { useQuery } from '@tanstack/react-query';
import { fetchTradersPageData } from '@/lib/page-adapters';
import { TraderRoster } from './trader-roster';
import { QueryBoundary, TableSkeleton } from '@/components/query-boundary';

export default function TradersPage() {
  const query = useQuery({
    queryKey: ['traders'],
    queryFn: fetchTradersPageData,
  });

  return (
    <QueryBoundary query={query} skeleton={<TableSkeleton />}>
      {(data) => <TraderRoster traders={data.traders} authors={data.authors} />}
    </QueryBoundary>
  );
}
