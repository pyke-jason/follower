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
import type { Metric } from '@/app/components/metric-strip';

function toNumber(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

type DashboardStats = {
  todayPnl: number;
  openTrades: number;
  pendingTasks: number;
};

type DashboardHistorySummary = {
  totalPnl: number;
  totalTrades: number;
  wins: number;
  winRate: number;
  bestTrade: number;
  worstTrade: number;
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
};

type DashboardSignalRow = {
  message: Message;
  trade: Trade | null;
};

export type DashboardPageData = {
  stats: DashboardStats;
  openTrades: Trade[];
  equityData: Array<{ date: string; equity: number }>;
  traderData: Array<{ trader: string; pnl: number; trades: number; winRate: number }>;
  metrics: Metric[];
  signals: DashboardSignalRow[];
  pendingReviews: Task[];
  riskSnapshot: DashboardRiskSnapshot;
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

  const metrics: Metric[] = [
    { label: 'P&L', value: dashboard.stats.todayPnl, format: 'currency', colorBySign: true },
    { label: 'Open Trades', value: dashboard.stats.openTrades, format: 'integer' },
    { label: 'Pending Tasks', value: dashboard.stats.pendingTasks, format: 'integer' },
    { label: 'Trades', value: dashboard.historySummary.totalTrades, format: 'integer' },
    { label: 'Win Rate', value: dashboard.historySummary.winRate, format: 'percent' },
  ];

  return {
    stats: dashboard.stats,
    openTrades: dashboard.openTrades,
    equityData,
    traderData,
    metrics,
    signals,
    pendingReviews,
    riskSnapshot: dashboard.risk,
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
