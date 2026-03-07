import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { PositionSizingConfig } from '../position-sizing/index.js';
import type { Signal } from '../agent/schemas.js';
import type { LegFill } from '../broker/types.js';
import type { ExtendedMetrics, LiveMetrics, TraderStats, StrategyStats, EquityPoint } from '../backtest/types.js';
import type { DecisionOutcome, Direction, Strategy } from '../lib/enums.js';

// Inlined from enums.ts so drizzle-kit can load schema.ts without resolving
// relative imports (its CJS bundler can't handle them).
const LegTypeSchema = z.enum(['CALL', 'PUT', 'STOCK']);
const LegActionSchema = z.enum(['BUY', 'SELL']);
export type { PositionSizingConfig } from '../position-sizing/index.js';
export type { Signal } from '../agent/schemas.js';

// SQLite doesn't have native enums — use text columns with TS types for safety.

// ─── Messages ────────────────────────────────────────

export const messages = sqliteTable('messages', {
  id:                 text('id').primaryKey(),
  author:             text('author').notNull(),
  timestamp:          text('timestamp').notNull(), // ISO 8601
  rawHtml:            text('raw_html').notNull(),
  cleanText:          text('clean_text').notNull(),
  badges:             text('badges', { mode: 'json' }).$type<string[]>().notNull().default([]),
  symbols:            text('symbols', { mode: 'json' }).$type<string[]>().notNull().default([]),
  actionHint:         text('action_hint'),       // OPEN | CLOSE | ADJUST | null
  directionHint:      text('direction_hint'),     // LONG | SHORT | null
  detectedStrategies: text('detected_strategies', { mode: 'json' }).$type<DetectedStrategy[]>().notNull().default([]),
  isPaperTrade:       integer('is_paper_trade', { mode: 'boolean' }).default(false),
  confidence:         text('confidence'),          // numeric stored as text (matches pg behavior)
  ingestedAt:         text('ingested_at').$defaultFn(() => new Date().toISOString()),
  contentHash:        text('content_hash'),        // sha256 of normalized clean_text for dedup
  reactions:          text('reactions', { mode: 'json' }).$type<MessageReaction[]>().notNull().default([]),
}, (table) => [
  index('idx_messages_author').on(table.author),
  index('idx_messages_timestamp').on(table.timestamp),
  index('idx_messages_content_hash').on(table.author, table.contentHash),
]);

// ─── Message Labels (Eval Ground Truth) ─────────────

export const messageLabels = sqliteTable('message_labels', {
  id:         text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId:  text('message_id').references(() => messages.id).notNull(),
  signals:    text('signals', { mode: 'json' }).$type<Signal[]>().notNull().default([]),
  source:     text('source').notNull().default('manual'), // approved | manual
  reviewed:   integer('reviewed', { mode: 'boolean' }).default(false),
  notes:      text('notes'),
  createdAt:  text('created_at').$defaultFn(() => new Date().toISOString()),
  updatedAt:  text('updated_at'),
}, (table) => [
  uniqueIndex('idx_labels_message_unique').on(table.messageId),
  index('idx_labels_reviewed').on(table.reviewed),
]);

// ─── Tasks ───────────────────────────────────────────

export const tasks = sqliteTable('tasks', {
  id:          text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId:   text('message_id').references(() => messages.id),
  taskType:    text('task_type').notNull(),       // REVIEW_MESSAGE | EXECUTE_TRADE | CLOSE_POSITION | MANUAL_REVIEW
  status:      text('status').notNull().default('PENDING'), // PENDING | IN_PROGRESS | COMPLETED | FAILED | SKIPPED
  assignee:    text('assignee').notNull().default('agent'),
  priority:    integer('priority').default(0),
  context:     text('context', { mode: 'json' }).$type<TaskContext>().notNull().default({}),
  result:      text('result', { mode: 'json' }).$type<{ outcome: string } | null>(),
  createdAt:   text('created_at').$defaultFn(() => new Date().toISOString()),
  startedAt:   text('started_at'),
  completedAt: text('completed_at'),
  error:         text('error'),
  modelProvider: text('model_provider'),  // 'anthropic' | 'xai'
  modelName:     text('model_name'),      // full model ID or null
  channelId:     text('channel_id').notNull(),
}, (table) => [
  index('idx_tasks_status').on(table.status),
  index('idx_tasks_message').on(table.messageId),
  index('idx_tasks_channel').on(table.channelId),
  uniqueIndex('idx_tasks_message_channel_unique').on(table.messageId, table.channelId).where(sql`message_id IS NOT NULL`),
]);

// ─── Trades ──────────────────────────────────────────

export const trades = sqliteTable('trades', {
  id:              text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  taskId:          text('task_id').references(() => tasks.id),
  sourceMessageId: text('source_message_id').references(() => messages.id),
  trader:          text('trader').notNull(),
  symbol:          text('symbol').notNull(),
  direction:       text('direction').notNull().$type<Direction>(),    // LONG | SHORT
  strategy:        text('strategy').notNull().$type<Strategy>(),     // CDS, PDS, CALL, PUT, STOCK
  legs:            text('legs', { mode: 'json' }).$type<TradeLeg[]>().notNull(),
  status:          text('status').notNull().default('OPEN'), // OPEN | CLOSED | CANCELLED
  entryPrice:      text('entry_price'),
  exitPrice:       text('exit_price'),
  quantity:        integer('quantity').default(1),
  pnl:             text('pnl'),
  openedAt:        text('opened_at'),
  closedAt:        text('closed_at'),
  closeMessageId:  text('close_message_id').references(() => messages.id),
  channelId:       text('channel_id').notNull(),
  metadata:        text('metadata', { mode: 'json' }).$type<TradeMetadata>().notNull().default({}),
  avgEntryPrice:   text('avg_entry_price'),
  brokerFillPrice: text('broker_fill_price'),
  brokerFillQty:   integer('broker_fill_qty'),
  brokerCommission: text('broker_commission'),
  brokerFillTime:  text('broker_fill_time'),
  brokerLegFills:  text('broker_leg_fills', { mode: 'json' }).$type<LegFill[] | null>(),
  realizedPnl:     text('realized_pnl'),  // accumulated PnL from partial exits (TRIMs)
}, (table) => [
  index('idx_trades_trader').on(table.trader),
  index('idx_trades_symbol').on(table.symbol),
  index('idx_trades_status').on(table.status),
  index('idx_trades_channel').on(table.channelId),
]);

// ─── Trade Events (append-only action log) ──────────

export const tradeEvents = sqliteTable('trade_events', {
  id:         text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  tradeId:    text('trade_id').references(() => trades.id).notNull(),
  action:     text('action').notNull(),         // OPEN | CLOSE | ADD | TRIM | LEG_OFF
  price:      text('price'),                    // fill price for this action
  quantity:   integer('quantity'),               // contracts/shares involved
  legs:       text('legs', { mode: 'json' }).$type<TradeLeg[]>().notNull().default([]),
  strategy:   text('strategy').$type<Strategy>(),                 // strategy at time of event
  direction:  text('direction').$type<Direction>(),                // direction at time of event
  messageId:  text('message_id'),               // source message that triggered this
  metadata:   text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  timestamp:  text('timestamp').notNull(),       // ISO 8601 — when the action happened
  createdAt:  text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_trade_events_trade').on(table.tradeId),
  index('idx_trade_events_timestamp').on(table.timestamp),
]);

export type TradeEvent = typeof tradeEvents.$inferSelect;

// ─── Backtest Runs ───────────────────────────────────

export const backtestRuns = sqliteTable('backtest_runs', {
  id:              text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  status:          text('status').notNull().default('PENDING'), // PENDING | RUNNING | COMPLETED | FAILED
  config:          text('config', { mode: 'json' }).$type<BacktestRunConfig>().notNull(),
  summary:         text('summary', { mode: 'json' }).$type<BacktestRunSummary | null>(),
  byTrader:        text('by_trader', { mode: 'json' }).$type<Record<string, TraderStats> | null>(),
  byStrategy:      text('by_strategy', { mode: 'json' }).$type<Record<string, StrategyStats> | null>(),
  equityCurve:     text('equity_curve', { mode: 'json' }).$type<EquityPoint[] | null>(),
  createdAt:       text('created_at').$defaultFn(() => new Date().toISOString()),
  startedAt:       text('started_at'),
  completedAt:     text('completed_at'),
  durationMs:      integer('duration_ms'),
  error:           text('error'),
  pid:             integer('pid'),
  // Eval framework columns
  name:            text('name'),                    // human label, e.g. "sonnet baseline sept"
  experimentTag:   text('experiment_tag'),           // groups runs, e.g. "model-comparison-feb"
  pinned:          integer('pinned', { mode: 'boolean' }).default(false),
  extendedMetrics: text('extended_metrics', { mode: 'json' }).$type<ExtendedMetrics | null>(),
  liveMetrics:     text('live_metrics', { mode: 'json' }).$type<LiveMetrics | null>(),
}, (table) => [
  index('idx_backtest_runs_status').on(table.status),
  index('idx_backtest_runs_experiment_tag').on(table.experimentTag),
]);

// ─── Run Decisions ──────────────────────────────────

export const runDecisions = sqliteTable('run_decisions', {
  id:             text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  channelId:      text('channel_id').notNull(),
  taskId:         text('task_id').references(() => tasks.id),
  messageId:      text('message_id').references(() => messages.id),
  event:          text('event').notNull().default('SETTLED'),
  signalIndex:    integer('signal_index'),
  outcome:        text('outcome'),
  phase:          text('phase'),
  reasoning:      text('reasoning'),
  tradeId:        text('trade_id'),                // FK to resulting trade (null if SKIP)
  pnl:            text('pnl'),                     // outcome P&L, back-filled after close
  snapshot:       text('snapshot', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  durationMs:     integer('duration_ms'),
  inputTokens:    integer('input_tokens'),          // LLM input tokens (null for deterministic skips)
  outputTokens:   integer('output_tokens'),         // LLM output tokens (null for deterministic skips)
  createdAt:      text('created_at').$defaultFn(() => new Date().toISOString()),
  path:           text('path'),                    // LEGACY
  decision:       text('decision'),                // LEGACY
  skipCategory:   text('skip_category'),
}, (table) => [
  index('idx_run_decisions_channel').on(table.channelId),
  index('idx_run_decisions_message').on(table.messageId),
  index('idx_run_decisions_channel_message').on(table.channelId, table.messageId),
  index('idx_run_decisions_task').on(table.taskId),
  index('idx_run_decisions_settled').on(table.channelId, table.event),
]);

// ─── Backtest MTM Snapshots ──────────────────────────

export const backtestMtmSnapshots = sqliteTable('backtest_mtm_snapshots', {
  id:             text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  channelId:      text('channel_id').notNull(),
  date:           text('date').notNull(),           // YYYY-MM-DD (trading day)
  unrealizedPnl:  real('unrealized_pnl').notNull(),
  createdAt:      text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_mtm_snapshots_channel').on(table.channelId),
  index('idx_mtm_snapshots_channel_date').on(table.channelId, table.date),
]);

// ─── Tracked Traders ─────────────────────────────────

export const trackedTraders = sqliteTable('tracked_traders', {
  name:            text('name').primaryKey(),
  enabled:         integer('enabled', { mode: 'boolean' }).default(true),
  strategies:      text('strategies', { mode: 'json' }).$type<string[]>().notNull().default([]),
  notes:           text('notes'),
  positionSizingConfig: text('position_sizing_config', { mode: 'json' })
    .$type<PositionSizingConfig>(),
});

// ─── Daily Balances ─────────────────────────────────

export const dailyBalances = sqliteTable('daily_balances', {
  id:            text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  channelId:     text('channel_id').notNull(),
  date:          text('date').notNull(), // YYYY-MM-DD
  cashBalance:   text('cash_balance').notNull(),
  buyingPower:   text('buying_power').notNull(),
  equity:        text('equity').notNull(),
  marketValue:   text('market_value').notNull(),
  unrealizedPnl: text('unrealized_pnl').notNull(),
  realizedPnl:   text('realized_pnl').notNull(),
  capturedAt:    text('captured_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_daily_balances_date').on(table.date),
  index('idx_daily_balances_channel').on(table.channelId),
  uniqueIndex('idx_daily_balances_channel_date_unique').on(table.channelId, table.date),
]);

// ─── Reconciliation Alerts ──────────────────────────

export type ReconciliationAlertType = 'BROKER_ONLY' | 'DB_ONLY' | 'QUANTITY_MISMATCH';

export const reconciliationAlerts = sqliteTable('reconciliation_alerts', {
  id:         text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  channelId:  text('channel_id').notNull(),
  type:       text('type').notNull().$type<ReconciliationAlertType>(),
  symbol:     text('symbol').notNull(),
  tradeId:    text('trade_id'),
  expected:   text('expected', { mode: 'json' }),
  actual:     text('actual', { mode: 'json' }),
  resolved:       integer('resolved', { mode: 'boolean' }).default(false),
  resolvedAt:     text('resolved_at'),
  resolvedReason: text('resolved_reason'),
  createdAt:      text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_recon_alerts_resolved').on(table.resolved),
  index('idx_recon_alerts_symbol').on(table.symbol),
  index('idx_recon_alerts_channel').on(table.channelId),
  index('idx_recon_alerts_channel_resolved').on(table.channelId, table.resolved),
]);

// ─── Orphan Fills ─────────────────────────────────────

export const orphanFills = sqliteTable('orphan_fills', {
  orderId: text('order_id').primaryKey(),
  symbol: text('symbol').notNull(),
  strategy: text('strategy').notNull(),
  direction: text('direction').notNull(),
  filledPrice: real('filled_price').notNull(),
  filledAt: text('filled_at').notNull(),
  filledQuantity: integer('filled_quantity'),
  commission: real('commission'),
  legs: text('legs'),
  rawOrder: text('raw_order'),
  detectedAt: text('detected_at').notNull(),
  resolved: integer('resolved').default(0),
  taskId: text('task_id'),
  channelId: text('channel_id'),
});

// ─── Historical Fetch Runs ──────────────────────────

export const historicalFetchRuns = sqliteTable('historical_fetch_runs', {
  id:            text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  status:        text('status').notNull().default('pending'), // pending | running | completed | error | cancelled
  since:         text('since').notNull(),         // YYYY-MM-DD
  until:         text('until').notNull(),         // YYYY-MM-DD
  clearExisting: integer('clear_existing', { mode: 'boolean' }).default(false),
  fetchedCount:  integer('fetched_count').default(0),
  savedCount:    integer('saved_count').default(0),
  currentDate:   text('current_date'),            // date chunk currently being fetched
  startedAt:     text('started_at'),
  completedAt:   text('completed_at'),
  error:         text('error'),
}, (table) => [
  index('idx_fetch_runs_status').on(table.status),
]);

// ─── Historical Fetch Chunks ────────────────────────

export const historicalFetchChunks = sqliteTable('historical_fetch_chunks', {
  id:            text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  runId:         text('run_id').references(() => historicalFetchRuns.id).notNull(),
  date:          text('date').notNull(),           // YYYY-MM-DD
  status:        text('status').notNull().default('pending'), // pending | in_progress | completed | failed
  attempts:      integer('attempts').default(0),
  fetchedCount:  integer('fetched_count').default(0),
  savedCount:    integer('saved_count').default(0),
  lastAttemptAt: text('last_attempt_at'),
  nextRetryAt:   text('next_retry_at'),
  error:         text('error'),
}, (table) => [
  index('idx_fetch_chunks_run').on(table.runId),
  index('idx_fetch_chunks_status').on(table.status),
]);

// ─── Message Intents (Phase 1: classification cache) ─

export const messageIntents = sqliteTable('message_intents', {
  id:           text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId:    text('message_id').references(() => messages.id).notNull(),
  model:        text('model').notNull(),              // e.g. "grok-4-1-fast-non-reasoning" or "deterministic"
  version:      integer('version').notNull().default(1), // bump when prompts/parser change
  route:        text('route').notNull(),               // hard-skip | deterministic | llm
  decision:     text('decision').notNull(),            // EXECUTE | SKIP | MANUAL_REVIEW
  reasoning:    text('reasoning'),
  signals:      text('signals', { mode: 'json' }).$type<Signal[]>(),
  durationMs:   integer('duration_ms'),
  inputTokens:  integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  turns:        integer('turns'),
  steps:        text('steps', { mode: 'json' }).$type<IntentStep[]>(),
  createdAt:    text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_intents_message').on(table.messageId),
  index('idx_intents_model_version').on(table.model, table.version),
  uniqueIndex('idx_intents_unique').on(table.messageId, table.model, table.version),
]);

export type IntentStep = {
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  reasoning?: string;
  durationMs?: number;
};

// ─── Commission Schedule ─────────────────────────────

export type CommissionSchedule = {
  stock?: { perShare: number; minimum?: number; maximum?: number };
  option?: { perContract: number };
};

// ─── Backtest Config/Summary Types ───────────────────

export type BacktestRunConfig = {
  startDate: string;   // ISO date
  endDate: string;     // ISO date
  traders: string[];
  useQuoteTape: boolean;
  agentProvider?: string;  // 'anthropic' | 'xai'
  agentModel?: string;     // e.g. 'claude-sonnet-4-6'
  fillModel?: 'orats' | 'midpoint' | 'natural';
  name?: string;           // human label for the run
  refreshQuoteCache?: boolean;
  startingEquity: number;
  maxAgentCalls?: number;
  // Risk limit overrides (see BACKTEST_RISK_DEFAULTS in src/config/risk-defaults.ts for defaults)
  maxOnSymbol?: number;
  maxTotalPositions?: number;
  maxDrawdownPct?: number;
  maxNotionalMultiplier?: number;
  disableRiskLimits?: boolean;
  commissionSchedule: CommissionSchedule;
};

export type BacktestRunSummary = {
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
  totalCommissions?: number;
  netPnl?: number;
};

// ─── Trade Flags ─────────────────────────────────────

export const TRADE_FLAGS = ['autoClose','legOff','trim','add','slippage','closeFailed','hasUpdate','marketDataFail','chaseWarn','chaseDanger','strategyMismatch'] as const;
export type TradeFlag = (typeof TRADE_FLAGS)[number];

// ─── Message Reactions ───────────────────────────────

export type MessageReaction = {
  Type: string;   // votes | loves | appreciations | cheers | salutes
  Count: number;
};

// ─── Supporting Types ────────────────────────────────

export const DetectedStrategySchema = z.object({
  strategy: z.string(),
  confidence: z.number(),
  strikes: z.array(z.number()).optional(),
  expiry: z.string().optional(),
  price: z.number().optional(),
  quantity: z.number().optional(),
});

export type DetectedStrategy = z.infer<typeof DetectedStrategySchema>;

export const TradeLegSchema = z.object({
  symbol: z.string(),
  strike: z.number().nonnegative(),  // 0 for STOCK legs, positive for options
  expiry: z.string(),
  type: LegTypeSchema,
  action: LegActionSchema,
  quantity: z.number().int().positive().default(1),
  fillPrice: z.number().nonnegative().optional(),
});

export type TradeLeg = z.infer<typeof TradeLegSchema>;

export const TaskContextSchema = z.object({
  messageId: z.string().optional(),
  messageTimestamp: z.string().optional(),
  author: z.string().optional(),
  cleanText: z.string().optional(),
  rawHtml: z.string().optional(),
  badges: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  actionHint: z.string().nullable().optional(),
  directionHint: z.string().nullable().optional(),
  detectedStrategies: z.array(DetectedStrategySchema).optional(),
  confidence: z.number().optional(),
}).passthrough();

export type TaskContext = z.infer<typeof TaskContextSchema>;

export type TaskResult = {
  decision: DecisionOutcome;
  reasoning: string;
  signals?: Signal[];
};

export type TradeMetadata = {
  slippage?: number;
  fillQuality?: string;
  agentModel?: string;
  brokerOrderId?: string;
  fillEnriched?: boolean;
  fillEnrichedAt?: string;
  /** Original leg count at open time. Set during LEG_OFF so commission
   *  can compute the open-side cost correctly after legs shrink. */
  openLegCount?: number;
  /** For LEG_OFF: the strategy after removing the closed leg (CALL or PUT). */
  targetStrategy?: Strategy;
  /** For LEG_OFF: the leg that was closed/bought back. */
  closedLeg?: TradeLeg;
  /** For LEG_OFF: the leg that remains open. */
  keptLeg?: TradeLeg;
  /** Final broker order status when order was rejected/cancelled (from fill sweep). */
  brokerFinalStatus?: string;
  /** Set when trade was force-exited via local API. */
  forceExit?: boolean;
  /** Broker order ID from a force-exit. */
  forceExitOrderId?: string;
  /** Broker order status from a force-exit. */
  forceExitStatus?: string;
  /** Total price chase steps summed across all fills (OPEN + CLOSE/TRIM/LEG_OFF). Per-event breakdown is in trade_events metadata. */
  chaseSteps?: number;
  /** Chase slippage on entry: fillPrice vs initial limit. Positive = worse (paid more / received less). */
  entrySlippage?: number;
  /** Chase slippage on entry as % of limit price. */
  entrySlippagePct?: number;
  /** Chase slippage on exit: fillPrice vs initial limit. Positive = worse (paid more / received less). */
  exitSlippage?: number;
  /** Chase slippage on exit as % of limit price. */
  exitSlippagePct?: number;
  /** Materialized trade flags — set at write time by recordTrade and async updaters. */
  flags?: TradeFlag[];
  /** Total pipeline execution time (ms) from trace spans — message ingestion to final event. */
  executionMs?: number;
  /** Catch-all for genuinely unknown future fields. */
  extra?: Record<string, unknown>;
};

// ─── Runtime Health ──────────────────────────────────

export const runtimeHealth = sqliteTable('runtime_health', {
  channelId:     text('channel_id').primaryKey(),
  brokerHealthy: integer('broker_healthy', { mode: 'boolean' }).notNull().default(true),
  circuitOpen:   integer('circuit_open', { mode: 'boolean' }).notNull().default(false),
  lastError:     text('last_error'),
  updatedAt:     text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Inferred Types ──────────────────────────────────

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Trade = typeof trades.$inferSelect;
export type BacktestRun = typeof backtestRuns.$inferSelect;
export type TrackedTrader = typeof trackedTraders.$inferSelect;
export type MessageLabel = typeof messageLabels.$inferSelect;
export type NewMessageLabel = typeof messageLabels.$inferInsert;
export type DailyBalance = typeof dailyBalances.$inferSelect;
export type ReconciliationAlert = typeof reconciliationAlerts.$inferSelect;
export type HistoricalFetchRun = typeof historicalFetchRuns.$inferSelect;
export type HistoricalFetchChunk = typeof historicalFetchChunks.$inferSelect;
export type RunDecision = typeof runDecisions.$inferSelect;
export type BacktestMtmSnapshot = typeof backtestMtmSnapshots.$inferSelect;
export type MessageIntent = typeof messageIntents.$inferSelect;
export type NewMessageIntent = typeof messageIntents.$inferInsert;
export type RuntimeHealth = typeof runtimeHealth.$inferSelect;
