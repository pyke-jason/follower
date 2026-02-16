import type { DetectedStrategy } from '../db/schema.js';
import type { PositionSize } from '../position-sizing/index.js';

export type FillModel = 'orats' | 'midpoint' | 'natural';

export type SimPosition = {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  strategy: string;
  trader: string;
  entryPrice: number;
  quantity: number;
  legs: SimLeg[];
  openedAt: Date;
  closedAt?: Date;
  exitPrice?: number;
  pnl?: number;
  sourceMessageId?: string;
  closeMessageId?: string;
  /** For partial close slices: links back to the original position */
  parentPositionId?: string;
  /** True if this position represents a partial close slice (not a standalone position) */
  isPartialClose?: boolean;
};

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
  useAgent?: boolean;
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
    deterministicTrades: number;
    agentTrades: number;
    skippedLowConfidence: number;
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

export interface SizingService {
  calculateSize(input: { trader: string; symbol: string; entryPrice: number; strategy: string; spreadMaxRisk?: number }): Promise<PositionSize>;
}

export type RiskCheckResult = {
  allowed: boolean;
  reason?: string;
  /** Stats populated by the backtest risk service for enriched logging */
  openOnSymbol?: number;
  maxOnSymbol?: number;
  totalOpen?: number;
  maxTotal?: number;
  totalNotional?: number;
  maxNotional?: number;
};

export interface RiskService {
  check(input: { symbol: string; strategy: string; trader: string }): Promise<RiskCheckResult>;
}

export type ExecutionStep = {
  name: string;
  input?: unknown;
  output?: unknown;
  reasoning: string;
  durationMs?: number;
};

export type ExecutionResult = {
  action: 'OPEN' | 'CLOSE' | 'SKIP';
  position?: SimPosition;
  reason: string;
  usedAgent: boolean;
  steps?: ExecutionStep[];
};
