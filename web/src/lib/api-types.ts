import type { ReactNode } from 'react';
import { z } from 'zod';
import type { Message, Trade, BacktestRun, RunDecision, TradeEvent, TradeFlag, BacktestRunSummary } from '@src/db/schema';
import type { Signal } from '@src/agent/schemas';
import type { TraderStats, StrategyStats, EquityPoint } from '@src/backtest/types';
import type { TradeScatterPoint } from '@/views/backtests/[id]/trade-scatter';
import type { RollingWinRatePoint } from '@/views/backtests/[id]/rolling-win-rate';

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

/* ---- Eval accuracy ---- */

export type Mismatch = {
  path: string;
  expected: string;
  got: string;
};

export type TradeLabel = {
  bucket: 'tp' | 'fp' | 'unlabeled';
  match: { mismatches: Mismatch[] } | null;
  labelSignals: Signal[] | null;
  labelId: string | null;
  labelIsTrade: boolean | null;
  labelReasoning: string | null;
  labelConfidence: string | null;
  humanVerified: boolean;
  rejectionReason: string | null;
};

export type EvalSummary = {
  labeled: number;
  unlabeled: number;
  confusion: { tp: number; fp: number; tn: number; fn: number };
  metrics: { accuracy: number; precision: number; recall: number; f1: number };
  mismatchCounts: Record<string, number> | null;
  totalMismatches: number;
} | null;

/* ---- Backtest detail ---- */

type BacktestDecisionJoinRow = {
  decision: RunDecision;
  message: Message;
  trade: { id: string; symbol: string; taskId: string | null; pnl: string | null } | null;
};

export type BacktestDetailResponse = {
  run: BacktestRun;
  decisions: BacktestDecisionJoinRow[];
  allTrades: Trade[];
  eventsByTradeId: Record<string, TradeEvent[]>;
  flagsByTradeId: Record<string, TradeFlag[]>;
  mtmSnapshots: { date: string; unrealizedPnl: number }[];
  summary: (BacktestRunSummary & { agentCallsUsed: number; agentTrades: number; skipped: number }) | null;
  byTrader: Record<string, TraderStats> | null;
  byStrategy: Record<string, StrategyStats> | null;
  equityCurve: EquityPoint[] | null;
  tradeScatter: TradeScatterPoint[];
  rollingWinRate: RollingWinRatePoint[];
  strategyEquity: Record<string, number | string>[];
  strategies: string[];
  llmTokens: { input: number; output: number };
  messagesEndDate: string;
  evalSummary?: EvalSummary;
  labelsByTradeId?: Record<string, TradeLabel>;
};

/* ---- Trader detail ---- */

type HistorySummary = {
  totalPnl: number;
  totalTrades: number;
  wins: number;
  winRate: number;
  bestTrade: number;
  worstTrade: number;
  totalSlippage: number;
};

type StrategyRow = {
  strategy: string;
  trades: number;
  totalPnl: string;
  wins: number;
};

type EquityCurveRow = {
  date: string;
  pnl: number;
  cumPnl: number;
};

type TrackedTrader = {
  name: string;
  enabled: boolean;
  strategies: string[];
};

export type TraderDetailResponse = {
  trader: TrackedTrader;
  equityCurve: EquityCurveRow[];
  strategyBreakdown: StrategyRow[];
  historySummary: HistorySummary;
  closedTrades: Trade[];
};
