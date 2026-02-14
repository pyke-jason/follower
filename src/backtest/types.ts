import type { DetectedStrategy } from '../db/schema.js';

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
  useAgent: boolean;
  maxAgentCalls: number;
  slippagePct: number;
  useQuoteTape?: boolean;
  databentoApiKey?: string;
  databentoDataset?: string;  // default 'DBEQ.BASIC'
};

export type BacktestReport = {
  config: BacktestConfig;
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
};
