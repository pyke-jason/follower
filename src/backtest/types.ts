import type { DetectedStrategy } from '../db/schema.js';

export type FillModel = 'orats' | 'midpoint' | 'natural';

export type SimLeg = {
  symbol: string;
  strike: number;
  expiry: string;
  type: 'CALL' | 'PUT' | 'STOCK';
  action: 'BUY' | 'SELL';
  quantity: number;
  fillPrice: number;
};

export type SimFill = {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  timestamp: Date;
};

export type HistoricalMessage = {
  id: string;
  author: string;
  timestamp: Date;
  rawHtml: string;
  cleanText: string;
  badges: string[];
  symbols: string[];
  actionHint: 'OPEN' | 'CLOSE' | null;
  directionHint: 'LONG' | 'SHORT' | null;
  detectedStrategies: DetectedStrategy[];
  isPaperTrade: boolean;
  confidence: number;
};

export type BacktestConfig = {
  startDate: Date;
  endDate: Date;
  traders: string[];
  fillModel?: FillModel;
  databentoApiKey?: string;
  databentoDataset?: string;  // default 'DBEQ.BASIC' (uses mbp-1 schema; OPRA.PILLAR uses cbbo-1s)
  agentProvider?: string;     // 'anthropic' | 'xai' — default 'anthropic'
  agentModel?: string;        // e.g. 'claude-sonnet-4-5-20250929'
  maxAgentCalls?: number;
  refreshQuoteCache?: boolean; // delete and re-download Databento cache entries
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
};

export type ExtendedMetrics = {
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  recoveryFactor: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgHoldingPeriodHours: number;
  medianPnl: number;
  pnlStdDev: number;
};

export type BacktestReport = {
  config: BacktestConfig;
  extendedMetrics: ExtendedMetrics;
  summary: {
    totalMessages: number;
    tradedMessages: number;
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    avgWin: number;
    avgLoss: number;
    maxDrawdown: number;
    profitFactor: number;
    agentCallsUsed: number;
    agentTrades: number;
    skipped: number;
    openAtEnd: number;
  };
  byTrader: Record<string, TraderStats>;
  byStrategy: Record<string, StrategyStats>;
  equityCurve: EquityPoint[];
  skipReasons?: Record<string, number>;
};

export type TraderStats = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
};

export type StrategyStats = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
};

export type EquityPoint = {
  date: string;
  pnl: number;
  cumPnl: number;
  trades: number;
  unrealizedPnl?: number;  // total unrealized PnL of open positions at EOD
  equity?: number;          // cumPnl + unrealizedPnl (the "true" equity value)
};

/**
 * Snapshot of accumulated runtime metrics, written to backtest_runs.live_metrics
 * after every message during execution. The web UI polls this for real-time display.
 *
 * Only contains data that CANNOT be derived from other tables:
 * - unrealizedPnl: requires the runner's price provider (web server can't compute)
 * - databento stats: process-level counters, not per-decision
 * - openPositionCount: included for atomic consistency with unrealizedPnl
 *
 * NOT stored here (derived in the web layer from already-loaded data):
 * - processedMessages, agentCalls, trades, skipped → from run_decisions
 * - LLM tokens → per-decision on run_decisions
 * - LLM cost → computed from tokens + model
 */
export type LiveMetrics = {
  unrealizedPnl: number | null;
  openPositionCount: number;
  databentoApiFetches: number;
  databentoApiBytesRead: number;
  updatedAt: string;
};


