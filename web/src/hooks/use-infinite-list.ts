import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CursorResponse } from '@/lib/api-types';

export function useInfiniteList<T>(opts: {
  queryKey: unknown[];
  path: string;
  params?: Record<string, string>;
  limit?: number;
  enabled?: boolean;
  refetchInterval?: number | false;
}): {
  rows: T[];
  total: number | undefined;
  hasMore: boolean;
  loadMore: () => void;
  isLoading: boolean;
  isFetchingMore: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const limit = opts.limit ?? 50;

  const query = useInfiniteQuery<CursorResponse<T>>({
    queryKey: opts.queryKey,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams(opts.params);
      params.set('limit', String(limit));
      if (pageParam) params.set('cursor', pageParam as string);
      const separator = opts.path.includes('?') ? '&' : '?';
      return api<CursorResponse<T>>(`${opts.path}${separator}${params.toString()}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: opts.enabled,
    refetchInterval: opts.refetchInterval ?? false,
  });

  const pages = query.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.rows);
  const total = pages[0]?.total;
  const lastPage = pages[pages.length - 1];
  const hasMore = lastPage?.nextCursor !== null && lastPage?.nextCursor !== undefined;

  return {
    rows,
    total,
    hasMore,
    loadMore: () => {
      if (!query.isFetchingNextPage && hasMore) {
        query.fetchNextPage();
      }
    },
    isLoading: query.isLoading,
    isFetchingMore: query.isFetchingNextPage,
    isError: query.isError,
    error: query.error,
    refetch: () => { query.refetch(); },
  };
}
