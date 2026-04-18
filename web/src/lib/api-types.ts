import type { ReactNode } from 'react';
import { z } from 'zod';

export type CursorResponse<T> = {
  rows: T[];
  nextCursor: string | null;
  total?: number;
};

/* ---- /status response ---- */

export const channelKindSchema = z.enum(['runtime', 'backtest', 'unknown']);
export type ChannelKind = z.infer<typeof channelKindSchema>;

export const channelBriefSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.string(),
  traders: z.array(z.string()),
  startDate: z.string(),
  endDate: z.string(),
  agentModel: z.string(),
  totalPnl: z.number(),
  winRate: z.number(),
  totalTrades: z.number(),
});
export type ChannelBrief = z.infer<typeof channelBriefSchema>;

export const statusResponseSchema = z.object({
  channelId: z.string(),
  channelKind: channelKindSchema,
  openTrades: z.number(),
  todayPnl: z.number(),
  pendingTasks: z.number(),
  tradingBlocked: z.boolean().optional(),
  unresolvedAlertCount: z.number().optional(),
  channelBrief: channelBriefSchema.optional(),
  brokerHealthy: z.boolean().optional(),
  circuitOpen: z.boolean().optional(),
  lastError: z.string().nullable().optional(),
  healthUpdatedAt: z.string().optional(),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

export type Column<T> = {
  key: string;
  label: ReactNode;
  sortable?: boolean;
  align?: 'left' | 'right';
  className?: string;
  render: (row: T) => ReactNode;
};
