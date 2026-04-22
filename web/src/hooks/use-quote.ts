import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { buildScopedPath } from '@/lib/channel-scope';
import type { QuoteData } from '@/lib/order-types';

type UseQuoteOptions = {
  symbol: string;
  channelId: string;
  enabled?: boolean;
  intervalMs?: number;
};

export function useQuote({ symbol, channelId, enabled = true, intervalMs = 2000 }: UseQuoteOptions) {
  return useQuery<QuoteData>({
    queryKey: ['quote', channelId, symbol],
    queryFn: () =>
      api<QuoteData>(buildScopedPath(`/quotes/${encodeURIComponent(symbol)}`, channelId)),
    enabled: enabled && channelId.length > 0 && symbol.length > 0,
    refetchInterval: intervalMs,
    refetchIntervalInBackground: false,
    staleTime: 1000,
  });
}
