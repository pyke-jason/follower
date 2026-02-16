import { getTrackedTraders, getDistinctAuthors } from '@/lib/queries';
import { TraderRoster } from './trader-roster';

export const dynamic = 'force-dynamic';

export default async function TradersPage() {
  const [traders, authors] = await Promise.all([
    getTrackedTraders(),
    getDistinctAuthors(),
  ]);

  return <TraderRoster traders={traders} authors={authors} />;
}
