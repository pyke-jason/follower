import { api } from '@/lib/api';
import { buildScopedPath } from '@/lib/channel-scope';
import { fetchDashboardPageData, type DashboardPageData, fetchBacktestsPageData, type BacktestsPageData } from '@/lib/page-adapters';
import type { Trade, TradeFlag, Task } from '@src/db/schema';
import type { CursorResponse, BacktestDetailResponse, TraderDetailResponse } from '@/lib/api-types';

type TradesResponse = {
  rows: Trade[];
  nextCursor: string | null;
  total: number;
  flags: Record<string, TradeFlag[]>;
};

type TasksResponse = CursorResponse<Task>;

export const queries = {
  trades: {
    list: (channelId: string) => ({
      queryKey: ['trades', channelId] as const,
      queryFn: () =>
        api<TradesResponse>(buildScopedPath('/trades', channelId, { limit: '200' })),
    }),
  },

  backtests: {
    list: () => ({
      queryKey: ['backtests'] as const,
      queryFn: fetchBacktestsPageData,
      refetchInterval: (query: { state: { data?: BacktestsPageData } }) => {
        const runs = query.state.data?.runs;
        if (runs?.some((r) => r.status === 'RUNNING' || r.status === 'PENDING')) return 3000;
        return false;
      },
    }),

    detail: (id: string) => ({
      queryKey: ['backtest', id] as const,
      queryFn: () => api<BacktestDetailResponse>(`/backtests/${id}`),
      refetchInterval: (query: { state: { data?: BacktestDetailResponse } }) => {
        const status = query.state.data?.run?.status;
        return status === 'RUNNING' || status === 'PENDING' ? 3000 : false;
      },
      enabled: id.length > 0,
    }),
  },

  tasks: {
    list: (channelId: string, status?: string) => ({
      queryKey: ['tasks', channelId, status] as const,
      queryFn: () =>
        api<TasksResponse>(buildScopedPath('/tasks', channelId, { limit: '200', status })),
    }),
  },

  dashboard: {
    overview: (channelId: string) => ({
      queryKey: ['dashboard', channelId] as const,
      queryFn: () => fetchDashboardPageData(channelId),
      refetchInterval: 5000,
    }),
  },

  traders: {
    detail: (channelId: string, name: string) => ({
      queryKey: ['trader', name, channelId] as const,
      queryFn: () =>
        api<TraderDetailResponse>(
          buildScopedPath(`/traders/${encodeURIComponent(name)}`, channelId),
        ),
      enabled: name.length > 0,
    }),
  },
} as const;
