import { z } from 'zod';
import { SignalSchema } from '../agent/schemas.js';
import {
  DirectionSchema,
  LegActionSchema,
  LegTypeSchema,
  OrderTypeSchema,
  StrategySchema,
} from '../lib/enums.js';
import { EvalLabelDataSchema } from '../eval/label-schema.js';
import { defaultTickSize, computeMidpoint } from '../lib/quotes.js';
import type {
  BacktestRun,
  BacktestRunSummary,
  EvalLabelData,
  Message,
  RunDecision,
  Trade,
  TradeEvent,
  TradeFlag,
} from '../db/schema.js';
import type { EquityPoint, LiveMetrics, StrategyStats, TraderStats } from '../backtest/types.js';

/** Trade row decorated with the algorithmic quality block on the wire.
 *  Every endpoint that returns trade rows decorates them via
 *  `decorateTradesWithQuality` in `web-queries.ts`. */
export type TradeWithQuality = Trade & {
  quality: {
    rMultiple: number | null;
    score: number | null;
    grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
    reasons: string[];
  };
};

/* ─── Leaf: commission schedule ─────────────────────── */

const CommissionScheduleSchema = z.object({
  stock: z.object({
    perShare: z.number(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  }).optional(),
  option: z.object({
    perContract: z.number(),
  }).optional(),
});

/* ─── Leaf: force-exit leg ──────────────────────────── */

const ForceExitLegSchema = z.object({
  symbol: z.string(),
  type: LegTypeSchema,
  action: LegActionSchema,
  quantity: z.number().int().positive(),
  expiry: z.string(),
  strike: z.number().nonnegative(),
});

/* ─── Leaf: manual-order status ───────────────────── */

const ManualOrderStatusSchema = z.enum(['PENDING', 'OPEN', 'FILLED', 'CANCELLED', 'REJECTED']);

/* ─── GET /web/quotes/:symbol ─────────────────────── */

export const QuoteDataSchema = z.object({
  bid: z.number(),
  ask: z.number(),
  last: z.number(),
  mid: z.number(),
  spread: z.number(),
  volume: z.number(),
  timestamp: z.string(),
});

type QuoteData = z.infer<typeof QuoteDataSchema>;

export function toQuoteData(raw: {
  bid: number;
  ask: number;
  last: number;
  volume: number;
  timestamp: string;
}): QuoteData {
  const tickSize = defaultTickSize(raw.ask);
  return {
    bid: raw.bid,
    ask: raw.ask,
    last: raw.last,
    mid: computeMidpoint(raw.bid, raw.ask, tickSize),
    spread: Number((raw.ask - raw.bid).toFixed(4)),
    volume: raw.volume,
    timestamp: raw.timestamp,
  };
}

/* ─── POST /web/backtests/start ─────────────────────── */

export const BacktestStartBodySchema = z.object({
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  traders: z.array(z.string()).min(1),
  refreshQuoteCache: z.boolean().optional(),
  agentProvider: z.string().optional(),
  agentModel: z.string().optional(),
  logLevel: z.string().optional(),
  disableRiskLimits: z.boolean().optional(),
  clearIntentCache: z.boolean().optional(),
  maxOnSymbol: z.number().optional(),
  maxTotalPositions: z.number().optional(),
  maxDrawdownPct: z.number().optional(),
  maxAgentCalls: z.number().optional(),
  startingEquity: z.number().optional(),
  commissionOptionPerContract: z.number().optional(),
  commissionStockPerShare: z.number().optional(),
});

/* ─── POST /backtests/spawn ─────────────────────────── */

export const BacktestSpawnBodySchema = z.object({
  runId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid run id'),
  resume: z.boolean().optional(),
  startDate: z.string(),
  endDate: z.string(),
  traders: z.array(z.string()),
  agentProvider: z.string().optional(),
  agentModel: z.string().optional(),
  refreshQuoteCache: z.boolean().optional(),
  logLevel: z.string().optional(),
  disableRiskLimits: z.boolean().optional(),
  maxOnSymbol: z.number().optional(),
  maxTotalPositions: z.number().optional(),
  maxDrawdownPct: z.number().optional(),
  maxAgentCalls: z.number().optional(),
  startingEquity: z.number().optional(),
  commissionSchedule: CommissionScheduleSchema.optional(),
});

/* ─── POST /web/classify/start ──────────────────────── */

export const ClassifyStartBodySchema = z.object({
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  traders: z.array(z.string()).min(1),
  agentProvider: z.string().optional(),
  agentModel: z.string().optional(),
  concurrency: z.number().optional(),
  name: z.string().optional(),
  experimentTag: z.string().optional(),
});

/* ─── POST /classify/spawn ──────────────────────────── */

export const ClassifySpawnBodySchema = z.object({
  runId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid run id'),
});

/* ─── POST /backtests/bulk-delete & /classify/bulk-delete ─ */

export const BulkIdsBodySchema = z.object({
  ids: z.array(z.string()),
});

/* ─── POST /web/orders ─────────────────────────────── */

export const PlaceOrderBodySchema = z.object({
  tradeId: z.string().min(1),
  channelId: z.string().min(1),
  orderType: OrderTypeSchema,
  limitPrice: z.number().positive().optional(),
  quantity: z.number().int().positive(),
}).refine(
  (d) => d.orderType !== 'LIMIT' || d.limitPrice != null,
  { message: 'LIMIT orders require limitPrice', path: ['limitPrice'] },
);

type PlaceOrderBody = z.infer<typeof PlaceOrderBodySchema>;

/* ─── GET/PUT/DELETE /web/orders/:id ───────────────── */

export const OrderIdParamsSchema = z.object({
  id: z.string().min(1),
});

type OrderIdParams = z.infer<typeof OrderIdParamsSchema>;

/* ─── PUT /web/orders/:id ──────────────────────────── */

export const ModifyOrderBodySchema = z.object({
  limitPrice: z.number().positive(),
});

type ModifyOrderBody = z.infer<typeof ModifyOrderBodySchema>;

/* ─── Manual order response ────────────────────────── */

export const WorkingOrderResponseSchema = z.object({
  orderId: z.string(),
  status: ManualOrderStatusSchema,
  orderType: OrderTypeSchema,
  symbol: z.string(),
  strategy: StrategySchema,
  direction: DirectionSchema,
  legs: z.array(ForceExitLegSchema),
  quantity: z.number().int().positive(),
  limitPrice: z.number().optional(),
  currentLimitPrice: z.number().optional(),
  filledPrice: z.number().optional(),
  filledQuantity: z.number().optional(),
  commission: z.number().optional(),
  placedAt: z.string(),
  filledAt: z.string().optional(),
  cancelledAt: z.string().optional(),
  message: z.string().optional(),
});

export type WorkingOrderResponse = z.infer<typeof WorkingOrderResponseSchema>;

/* ─── POST /trades/force-exit ───────────────────────── */

export const ForceExitBodySchema = z.object({
  channelId: z.string().min(1),
  tradeId: z.string().min(1),
  symbol: z.string().min(1),
  trader: z.string(),
  strategy: z.string(),
  direction: DirectionSchema,
  legs: z.array(ForceExitLegSchema),
});

/* ─── POST /web/traders ─────────────────────────────── */

export const TraderCreateBodySchema = z.object({
  name: z.string().trim().min(1, 'Name required'),
});

/* ─── PATCH /web/traders/:name ──────────────────────── */

export const TraderPatchBodySchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('enabled'), value: z.boolean() }),
  z.object({ field: z.literal('strategies'), value: z.array(z.string()) }),
  z.object({ field: z.literal('notes'), value: z.string().nullable() }),
]);

/* ─── POST /web/traders/bulk ────────────────────────── */

export const TradersBulkBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), names: z.array(z.string()) }),
  z.object({ action: z.literal('remove'), names: z.array(z.string()) }),
  z.object({
    action: z.literal('toggleStrategy'),
    names: z.array(z.string()),
    strategy: z.string(),
    enable: z.boolean(),
  }),
]);

/* ─── POST /web/reconciliation/:id/resolve ──────────── */

export const ReconciliationResolveBodySchema = z.object({
  decision: z.enum(['broker', 'app']),
});

/* ─── POST /web/settings/secrets ────────────────────── */

export const SettingsSecretBodySchema = z.object({
  key: z
    .string()
    .min(1, 'Key is required')
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Key must be uppercase letters, digits, and underscores'),
  value: z.string().min(1, 'Value is required'),
});

/* ─── POST /web/settings/toggles/:id ────────────────── */

export const SettingsTogglesBodySchema = z.object({
  enabled: z.boolean(),
});

/* ─── POST /web/settings/risk ───────────────────────── */

export const SettingsRiskBodySchema = z.object({
  maxTotalPositions: z.number().int().min(1).max(1000),
});

/* ─── POST /web/eval/review/:id ─────────────────────── */

export const EvalReviewBodySchema = z.object({
  verdict: z.enum(['parser_right', 'label_right', 'both_wrong', 'skip']),
  reason: z.string().optional(),
});

/* ─── POST /web/eval/labels/:id/review ──────────────── */

export const EvalLabelReviewBodySchema = z.object({
  humanLabel: EvalLabelDataSchema,
});

/* ─── POST /web/eval/labels/:id/reject ──────────────── */

export const EvalLabelRejectBodySchema = z.object({
  reason: z.string().min(1, 'reason is required'),
  feedback: z.string().optional(),
});

/* ─── PATCH /web/db/tables/:name/:rowId ─────────────── */

export const CellUpdateBodySchema = z.object({
  column: z.string(),
  value: z.union([z.string(), z.number(), z.null()]),
});

/* ─── Path params: runId-style ids ──────────────────── */

const RUN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const RunIdParamsSchema = z.object({
  id: z.string().regex(RUN_ID_RE, 'Invalid run id'),
});

/* ─── GET /web/eval/labels query ────────────────────── */

const stringBoolean = z.enum(['true', 'false']).transform((v) => v === 'true');

export const EvalLabelsListQuerySchema = z.object({
  version: z.coerce.number().int().optional(),
  source: z.enum(['agent', 'human']).optional(),
  verified: stringBoolean.optional(),
  confidence: z.enum(['HIGH', 'LOW']).optional(),
  isTrade: stringBoolean.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['asc', 'desc']).default('desc'),
});

/* ─── GET /web/db/tables/:name query ────────────────── */

export const DbTableQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
  filters: z.string().optional(),
});

/* ─── POST /ingest-backfill body ────────────────────── */

const BackfillReactionSchema = z.object({
  Type: z.string(),
  Count: z.number(),
});

const BackfillMessageSchema = z.object({
  Id: z.union([z.number(), z.string()]),
  Author: z.string(),
  TimeUtc: z.string().optional(),
  Message: z.string().optional(),
  Tag: z.union([z.number(), z.string()]).optional(),
  Votes: z.number().optional(),
  Reactions: z.array(BackfillReactionSchema).optional(),
});

export const IngestBackfillBodySchema = z.object({
  messages: z.array(BackfillMessageSchema),
});

/* ─── Shared eval types for backtest response ───────── */

const MismatchSchema = z.object({
  path: z.string(),
  expected: z.string(),
  got: z.string(),
});

export const TradeLabelSchema = z.object({
  bucket: z.enum(['tp', 'fp', 'unlabeled']),
  match: z.object({ mismatches: z.array(MismatchSchema) }).nullable(),
  labelSignals: z.array(SignalSchema).nullable(),
  labelId: z.string().nullable(),
  labelIsTrade: z.boolean().nullable(),
  labelReasoning: z.string().nullable(),
  labelConfidence: z.string().nullable(),
  humanVerified: z.boolean(),
  rejectionReason: z.string().nullable(),
});
export type TradeLabel = z.infer<typeof TradeLabelSchema>;

export const EvalSummarySchema = z
  .object({
    labeled: z.number(),
    unlabeled: z.number(),
    confusion: z.object({
      tp: z.number(),
      fp: z.number(),
      tn: z.number(),
      fn: z.number(),
    }),
    metrics: z.object({
      accuracy: z.number(),
      precision: z.number(),
      recall: z.number(),
      f1: z.number(),
    }),
    mismatchCounts: z.record(z.string(), z.number()).nullable(),
    totalMismatches: z.number(),
  })
  .nullable();
export type EvalSummary = z.infer<typeof EvalSummarySchema>;

/* ─── GET /web/backtests/:id response ───────────────── */

const BacktestDecisionJoinRowSchema = z.object({
  decision: z.custom<RunDecision>(),
  message: z.custom<Message>(),
  trade: z
    .object({
      id: z.string(),
      symbol: z.string(),
      taskId: z.string().nullable(),
      pnl: z.string().nullable(),
    })
    .nullable(),
});

const TradeScatterPointSchema = z.object({
  symbol: z.string(),
  pnl: z.number(),
  strategy: z.string(),
  direction: z.string(),
  trader: z.string(),
  date: z.string(),
  quantity: z.number(),
});

const RollingWinRatePointSchema = z.object({
  tradeNum: z.number(),
  date: z.string(),
  winRate: z.number(),
  windowSize: z.number(),
});

export const BacktestDetailResponseSchema = z.object({
  run: z.custom<BacktestRun>(),
  decisions: z.array(BacktestDecisionJoinRowSchema),
  allTrades: z.array(z.custom<TradeWithQuality>()),
  eventsByTradeId: z.record(z.string(), z.array(z.custom<TradeEvent>())),
  flagsByTradeId: z.record(z.string(), z.array(z.custom<TradeFlag>())),
  mtmSnapshots: z.array(z.object({ date: z.string(), unrealizedPnl: z.number() })),
  summary: z
    .custom<BacktestRunSummary & { agentCallsUsed: number; agentTrades: number; skipped: number }>()
    .nullable(),
  byTrader: z.record(z.string(), z.custom<TraderStats>()).nullable(),
  byStrategy: z.record(z.string(), z.custom<StrategyStats>()).nullable(),
  equityCurve: z.array(z.custom<EquityPoint>()).nullable(),
  tradeScatter: z.array(TradeScatterPointSchema),
  rollingWinRate: z.array(RollingWinRatePointSchema),
  strategyEquity: z.array(z.record(z.string(), z.union([z.number(), z.string()]))),
  strategies: z.array(z.string()),
  llmCost: z.number(),
  messagesEndDate: z.string(),
  evalSummary: EvalSummarySchema.optional(),
  labelsByTradeId: z.record(z.string(), TradeLabelSchema).optional(),
  liveRuntime: z.object({
    processedMessages: z.number(),
  }),
});
export type BacktestDetailResponse = z.infer<typeof BacktestDetailResponseSchema>;

export const BacktestLiveUpdateSchema = z.object({
  id: z.string(),
  status: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
  summary: z.custom<BacktestRunSummary>().nullable(),
  liveMetrics: z.custom<LiveMetrics>().nullable(),
  messagesEndDate: z.string(),
  liveRuntime: z.object({
    processedMessages: z.number(),
  }),
});
export type BacktestLiveUpdate = z.infer<typeof BacktestLiveUpdateSchema>;

export const BacktestTradeSnapshotSchema = z.object({
  allTrades: z.array(z.custom<TradeWithQuality>()),
  eventsByTradeId: z.record(z.string(), z.array(z.custom<TradeEvent>())),
  flagsByTradeId: z.record(z.string(), z.array(z.custom<TradeFlag>())),
  mtmSnapshots: z.array(z.object({ date: z.string(), unrealizedPnl: z.number() })),
  summary: BacktestDetailResponseSchema.shape.summary,
  byTrader: BacktestDetailResponseSchema.shape.byTrader,
  byStrategy: BacktestDetailResponseSchema.shape.byStrategy,
  equityCurve: BacktestDetailResponseSchema.shape.equityCurve,
  tradeScatter: BacktestDetailResponseSchema.shape.tradeScatter,
  rollingWinRate: BacktestDetailResponseSchema.shape.rollingWinRate,
  strategyEquity: BacktestDetailResponseSchema.shape.strategyEquity,
  strategies: BacktestDetailResponseSchema.shape.strategies,
  llmCost: z.number(),
  messagesEndDate: z.string(),
  evalSummary: EvalSummarySchema.optional(),
  labelsByTradeId: z.record(z.string(), TradeLabelSchema).optional(),
});
export type BacktestTradeSnapshot = z.infer<typeof BacktestTradeSnapshotSchema>;

/* ─── GET /web/classify/:id response ────────────────── */

export const ClassifyDecisionRowSchema = z.object({
  decision: z.custom<RunDecision>(),
  message: z.custom<Message>(),
});
export type ClassifyDecisionRow = z.infer<typeof ClassifyDecisionRowSchema>;

export const ClassifyLabelRowSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  label: z.custom<EvalLabelData>(),
  humanLabel: z.custom<EvalLabelData>().nullable(),
  humanVerified: z.boolean().nullable(),
  rejectionReason: z.string().nullable(),
});
export type ClassifyLabelRow = z.infer<typeof ClassifyLabelRowSchema>;

// Shape matches the classifyRuns table select. Defined here because the DB
// table/type is currently being migrated in schema.ts.
const ClassifyRunShapeSchema = z.object({
  id: z.string(),
  status: z.string(),
  config: z.object({
    startDate: z.string(),
    endDate: z.string(),
    traders: z.array(z.string()),
    agentProvider: z.string().optional(),
    agentModel: z.string().optional(),
    concurrency: z.number().optional(),
  }),
  summary: z.object({
    totalMessages: z.number(),
    tradableMessages: z.number(),
    processedMessages: z.number(),
    byOutcome: z.record(z.string(), z.number()),
    byRoute: z.record(z.string(), z.number()),
    byRuleId: z.record(z.string(), z.number()).optional(),
    totalInputTokens: z.number(),
    totalOutputTokens: z.number(),
    totalCostUsd: z.number().optional(),
    durationMs: z.number(),
  }).nullable(),
  name: z.string().nullable(),
  experimentTag: z.string().nullable().optional(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  progressIndex: z.number().nullable().optional(),
  progressTotal: z.number().nullable().optional(),
});

export const ClassifyDetailResponseSchema = z.object({
  run: ClassifyRunShapeSchema,
  decisions: z.array(ClassifyDecisionRowSchema),
  labelsByMessageId: z.record(z.string(), ClassifyLabelRowSchema),
});
export type ClassifyDetailResponse = z.infer<typeof ClassifyDetailResponseSchema>;

/* ─── GET /web/traders/:name response ───────────────── */

const HistorySummarySchema = z.object({
  totalPnl: z.number(),
  totalTrades: z.number(),
  wins: z.number(),
  winRate: z.number(),
  bestTrade: z.number(),
  worstTrade: z.number(),
  totalSlippage: z.number(),
});

const StrategyRowSchema = z.object({
  strategy: z.string(),
  trades: z.number(),
  totalPnl: z.string(),
  wins: z.number(),
});

const EquityCurveRowSchema = z.object({
  date: z.string(),
  pnl: z.number(),
  cumPnl: z.number(),
});

const TrackedTraderBriefSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  strategies: z.array(z.string()),
});

export const TraderDetailResponseSchema = z.object({
  trader: TrackedTraderBriefSchema,
  equityCurve: z.array(EquityCurveRowSchema),
  strategyBreakdown: z.array(StrategyRowSchema),
  historySummary: HistorySummarySchema,
  closedTrades: z.array(z.custom<TradeWithQuality>()),
});
export type TraderDetailResponse = z.infer<typeof TraderDetailResponseSchema>;
