import { useQuery } from '@tanstack/react-query';
import { fetchTradersPageData } from '@/lib/page-adapters';
import { TraderRoster } from './trader-roster';
import { Spinner } from '../components/spinner';

export default function TradersPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['traders'],
    queryFn: fetchTradersPageData,
  });

  if (isLoading || !data) return <Spinner />;

  return <TraderRoster traders={data.traders} authors={data.authors} />;
}
