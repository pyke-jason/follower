import type {
  BacktestRunConfig,
  BacktestRunSummary,
  DailyBalance,
  Message,
  Task,
  Trade,
  TrackedTrader,
} from '@src/db/schema';
import type { EquityPoint } from '@src/backtest/types';
import { api } from '@/lib/api';
import { buildScopedPath } from '@/lib/channel-scope';

function toNumber(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

type DashboardStats = {
  todayPnl: number;
  unrealizedPnl: number;
  openTrades: number;
  pendingTasks: number;
};

export type LivePositionRow = { unrealizedPnl: number; marketValue: number | null };

export type AccountBalanceSnapshot = {
  accountId: string;
  cashBalance: number;
  buyingPower: number;
  equity: number;
  marketValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  maintenanceMargin?: number;
  cushion?: number;
  timestamp: string;
};

type DashboardHistorySummary = {
  totalPnl: number;
  totalTrades: number;
  wins: number;
  winRate: number;
  bestTrade: number;
  worstTrade: number;
  totalSlippage: number;
};

type DashboardTraderPnlRow = {
  trader: string;
  totalPnl: string;
  tradeCount: number;
  wins: number;
};

type DashboardRiskSnapshot = {
  equity: number;
  buyingPower: number;
  openPositions: number;
  maxPositions: number;
  drawdownPct: number;
  maxDrawdownPct: number;
  todayPnl: number;
  unresolvedAlerts: number;
  tradingBlocked: boolean;
} | null;

type DashboardApiResponse = {
  stats: DashboardStats;
  openTrades: Trade[];
  traderPnl: DashboardTraderPnlRow[];
  historySummary: DashboardHistorySummary;
  risk: DashboardRiskSnapshot;
  dailyBalances: DailyBalance[];
  channelId: string;
  livePositionsByTradeId: Record<string, LivePositionRow>;
  accountBalance: AccountBalanceSnapshot | null;
};

export type DashboardSignalRow = {
  message: Message;
  trade: Trade | null;
};

export type DashboardPageData = {
  stats: DashboardStats;
  openTrades: Trade[];
  equityData: Array<{ date: string; equity: number }>;
  traderData: Array<{ trader: string; pnl: number; trades: number; winRate: number }>;
  signals: DashboardSignalRow[];
  pendingReviews: Task[];
  riskSnapshot: DashboardRiskSnapshot;
  livePositionsByTradeId: Record<string, LivePositionRow>;
  accountBalance: AccountBalanceSnapshot | null;
};

export async function fetchDashboardPageData(channelId?: string): Promise<DashboardPageData> {
  const [dashboard, signals, pendingReviews] = await Promise.all([
    api<DashboardApiResponse>(buildScopedPath('/dashboard', channelId)),
    api<DashboardSignalRow[]>(buildScopedPath('/signals', channelId, { limit: 20 })),
    api<Task[]>(buildScopedPath('/tasks', channelId, { status: 'PENDING', limit: 200 })),
  ]);

  const equityData = [...dashboard.dailyBalances]
    .reverse()
    .map((row) => ({
      date: row.date,
      equity: toNumber(row.equity),
    }));

  const traderData = dashboard.traderPnl.map((row) => ({
    trader: row.trader,
    pnl: toNumber(row.totalPnl),
    trades: row.tradeCount,
    winRate: row.tradeCount > 0 ? (row.wins / row.tradeCount) * 100 : 0,
  }));

  return {
    stats: dashboard.stats,
    openTrades: dashboard.openTrades,
    equityData,
    traderData,
    signals,
    pendingReviews,
    riskSnapshot: dashboard.risk,
    livePositionsByTradeId: dashboard.livePositionsByTradeId ?? {},
    accountBalance: dashboard.accountBalance ?? null,
  };
}

export type BacktestListRun = {
  id: string;
  status: string;
  config: BacktestRunConfig;
  summary: BacktestRunSummary | null;
  equityCurve: EquityPoint[] | null;
  durationMs: number | null;
  createdAt: string | null;
  pinned: boolean | null;
  experimentTag: string | null;
  name: string | null;
};

export type BacktestsPageData = {
  runs: BacktestListRun[];
  experimentTags: string[];
};

export async function fetchBacktestsPageData(): Promise<BacktestsPageData> {
  const [runs, experimentTags] = await Promise.all([
    api<BacktestListRun[]>('/backtests'),
    api<string[]>('/backtests/tags'),
  ]);

  return { runs, experimentTags };
}

export type TradersPageData = {
  traders: TrackedTrader[];
  authors: string[];
};

export async function fetchTradersPageData(): Promise<TradersPageData> {
  const [traders, authors] = await Promise.all([
    api<TrackedTrader[]>('/tracked-traders'),
    api<string[]>('/authors'),
  ]);
  return { traders, authors };
}
