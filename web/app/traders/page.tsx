import { useQuery } from '@tanstack/react-query';
import { fetchTradersPageData } from '@/lib/page-adapters';
import { TraderRoster } from './trader-roster';

const Spinner = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin h-6 w-6 border-2 border-muted-foreground/20 border-t-foreground rounded-full" />
  </div>
);

export default function TradersPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['traders'],
    queryFn: fetchTradersPageData,
  });

  if (isLoading || !data) return <Spinner />;

  return <TraderRoster traders={data.traders} authors={data.authors} />;
}
