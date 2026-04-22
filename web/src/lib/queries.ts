import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { buildScopedPath } from '@/lib/channel-scope';
import { fetchDashboardPageData, type DashboardPageData, fetchBacktestsPageData, type BacktestsPageData } from '@/lib/page-adapters';
import type { Trade, TradeFlag, Task, ClassifyRun } from '@src/db/schema';
import type {
  BacktestDetailResponse,
  ClassifyDetailResponse,
  TraderDetailResponse,
} from '@src/local-api/http-schemas';
import {
  type CursorResponse,
  type StatusResponse,
  statusResponseSchema,
} from '@/lib/api-types';

type TradesResponse = {
  rows: Trade[];
  nextCursor: string | null;
  total: number;
  flags: Record<string, TradeFlag[]>;
};

/** Task rows augmented with realized outcome from run_decisions SETTLED. */
type TaskListRow = Task & { realizedOutcome: string | null };
type TasksResponse = CursorResponse<TaskListRow>;

export const queries = {
  trades: {
    list: (channelId: string) => ({
      queryKey: ['trades', channelId] as const,
      queryFn: () =>
        api<TradesResponse>(buildScopedPath('/trades', channelId, { limit: '200' })),
    }),
  },

  channel: {
    status: (channelId: string | undefined) => ({
      queryKey: ['channel-status', channelId] as const,
      queryFn: async (): Promise<StatusResponse> => {
        const raw = await api<unknown>(buildScopedPath('/status', channelId));
        return statusResponseSchema.parse(raw);
      },
      enabled: Boolean(channelId),
      refetchInterval: 5_000,
      refetchIntervalInBackground: false,
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

  classify: {
    list: () => ({
      queryKey: ['classify'] as const,
      queryFn: () => api<ClassifyRun[]>('/classify'),
      refetchInterval: (query: { state: { data?: ClassifyRun[] } }) => {
        const runs = query.state.data;
        if (runs?.some((r) => r.status === 'RUNNING' || r.status === 'PENDING')) return 3000;
        return false;
      },
    }),

    detail: (id: string) => ({
      queryKey: ['classify', id] as const,
      queryFn: () => api<ClassifyDetailResponse>(`/classify/${id}`),
      refetchInterval: (query: { state: { data?: ClassifyDetailResponse } }) => {
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

/**
 * Poll /status for the given channel. Returns the full query result so
 * callers can read `data`, `isLoading`, `error`, etc. When `channelId` is
 * undefined the query stays disabled.
 */
export function useChannelStatus(channelId: string | undefined) {
  return useQuery(queries.channel.status(channelId));
}
