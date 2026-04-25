import type {
  BacktestRunConfig,
  BacktestRunSummary,
  DailyBalance,
  Message,
  Task,
  Trade,
  TradeFlag,
  TrackedTrader,
} from '@src/db/schema';
import type { EquityPoint } from '@src/backtest/types';
import { api } from '@/lib/api';
import { buildScopedPath } from '@/lib/channel-scope';
import type { BreakdownRow } from '@/components/breakdown-table';
import type { UnrealizedPnlPoint } from '@/components/overview-equity-curve';

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

export type DashboardTradeQualitySummary = {
  coverage: {
    closedTrades: number;
    withFiniteRisk: number;
    excluded: number;
    medianFiniteRisk: number | null;
  };
  rBuckets: Array<{ label: string; count: number }>;
  gradeBuckets: Array<{ grade: 'A' | 'B' | 'C' | 'D' | 'F'; count: number }>;
  flagCounts: Array<{ flag: TradeFlag; count: number }>;
  byStrategy: Array<{
    strategy: string;
    trades: number;
    finiteRiskTrades: number;
    totalPnl: number;
    avgR: number | null;
  }>;
};

/** Trade row decorated with the algorithmic quality block. The server attaches
 *  `quality` to every trade returned from /dashboard, /trades, and /trades-view. */
export type TradeRowWithQuality = Trade & {
  quality: {
    rMultiple: number | null;
    score: number | null;
    grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
    reasons: string[];
  };
};

type DashboardApiResponse = {
  stats: DashboardStats;
  openTrades: TradeRowWithQuality[];
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
  openTrades: TradeRowWithQuality[];
  unrealizedData: UnrealizedPnlPoint[];
  traderData: BreakdownRow[];
  signals: DashboardSignalRow[];
  pendingReviews: Task[];
  riskSnapshot: DashboardRiskSnapshot;
  qualitySummary: DashboardTradeQualitySummary;
  livePositionsByTradeId: Record<string, LivePositionRow>;
  accountBalance: AccountBalanceSnapshot | null;
};

export async function fetchDashboardPageData(channelId?: string): Promise<DashboardPageData> {
  const [dashboard, signals, pendingReviews, qualitySummary] = await Promise.all([
    api<DashboardApiResponse>(buildScopedPath('/dashboard', channelId)),
    api<DashboardSignalRow[]>(buildScopedPath('/signals', channelId, { limit: 20 })),
    api<Task[]>(buildScopedPath('/tasks', channelId, { status: 'PENDING', limit: 200 })),
    api<DashboardTradeQualitySummary>(buildScopedPath('/trade-quality', channelId)),
  ]);

  const unrealizedData = [...dashboard.dailyBalances]
    .reverse()
    .map((row) => ({
      date: row.date,
      unrealizedPnl: toNumber(row.unrealizedPnl),
    }));
  const liveDate = (dashboard.accountBalance?.timestamp ?? new Date().toISOString()).slice(0, 10);
  const livePoint = {
    date: liveDate,
    unrealizedPnl: dashboard.stats.unrealizedPnl,
  };
  const lastPoint = unrealizedData[unrealizedData.length - 1];
  if (lastPoint?.date === livePoint.date) {
    unrealizedData[unrealizedData.length - 1] = livePoint;
  } else {
    unrealizedData.push(livePoint);
  }

  const traderData: BreakdownRow[] = dashboard.traderPnl.map((row) => ({
    name: row.trader,
    pnl: toNumber(row.totalPnl),
    trades: row.tradeCount,
    winRate: row.tradeCount > 0 ? (row.wins / row.tradeCount) * 100 : 0,
  }));

  return {
    stats: dashboard.stats,
    openTrades: dashboard.openTrades,
    unrealizedData,
    traderData,
    signals,
    pendingReviews,
    riskSnapshot: dashboard.risk,
    qualitySummary,
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

type TradersPageData = {
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
