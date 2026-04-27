import { pgTable, text, integer, real, index, uniqueIndex, jsonb, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { PositionSizingConfig } from '../position-sizing/index.js';
import type { Signal } from '../agent/schemas.js';
import type { LegFill } from '../broker/types.js';
import type { ExtendedMetrics, LiveMetrics, TraderStats, StrategyStats, EquityPoint } from '../backtest/types.js';
import type { BacktestCheckpointState } from '../backtest/checkpoint-types.js';
import type { Direction, Strategy } from '../lib/enums.js';
import type {
  ClassificationAuditKind,
  ClassificationAuditPayload,
  ClassificationAuditStatus,
  CriticVerdict,
  SafetyFinding,
  SafetyFindingCategory,
  SafetySeverity,
} from '../safety/schemas.js';
// Inlined from enums.ts so drizzle-kit can load schema.ts without resolving
// relative imports (its CJS bundler can't handle them).
const LegTypeSchema = z.enum(['CALL', 'PUT', 'STOCK']);
const LegActionSchema = z.enum(['BUY', 'SELL']);
export type { PositionSizingConfig } from '../position-sizing/index.js';
export type { Signal } from '../agent/schemas.js';

// ─── Typed JSON Column Helper ────────────────────────

const typedJson = <T>(name: string) => jsonb(name).$type<T>();
const jsonArrayDefault = sql`'[]'::jsonb`;
const jsonObjectDefault = sql`'{}'::jsonb`;

// ─── Messages ────────────────────────────────────────

export const messages = pgTable('messages', {
  id:                 text('id').primaryKey(),
  author:             text('author').notNull(),
  timestamp:          text('timestamp').notNull(), // ISO 8601
  rawHtml:            text('raw_html').notNull(),
  cleanText:          text('clean_text').notNull(),
  badges:             typedJson<string[]>('badges').notNull().default(jsonArrayDefault),
  symbols:            typedJson<string[]>('symbols').notNull().default(jsonArrayDefault),
  actionHint:         text('action_hint'),       // OPEN | CLOSE | ADJUST | null
  directionHint:      text('direction_hint'),     // LONG | SHORT | null
  detectedStrategies: typedJson<DetectedStrategy[]>('detected_strategies').notNull().default(jsonArrayDefault),
  isPaperTrade:       boolean('is_paper_trade').default(false),
  confidence:         text('confidence'),          // numeric stored as text (matches pg behavior)
  ingestedAt:         text('ingested_at').$defaultFn(() => new Date().toISOString()),
  contentHash:        text('content_hash'),        // sha256 of normalized clean_text for dedup
  reactions:          typedJson<MessageReaction[]>('reactions').notNull().default(jsonArrayDefault),
}, (table) => [
  index('idx_messages_author').on(table.author),
  index('idx_messages_timestamp').on(table.timestamp),
  index('idx_messages_content_hash').on(table.author, table.contentHash),
]);

// ─── Tasks ───────────────────────────────────────────

export const tasks = pgTable('tasks', {
  id:          text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId:   text('message_id').references(() => messages.id),
  taskType:    text('task_type').notNull(),       // REVIEW_MESSAGE | EXECUTE_TRADE | CLOSE_POSITION | MANUAL_REVIEW
  status:      text('status').notNull().default('PENDING'), // PENDING | IN_PROGRESS | COMPLETED | FAILED | SKIPPED
  assignee:    text('assignee').notNull().default('agent'),
  priority:    integer('priority').default(0),
  context:     typedJson<TaskContext>('context').notNull().default(jsonObjectDefault),
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

export const trades = pgTable('trades', {
  id:              text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  taskId:          text('task_id').references(() => tasks.id),
  sourceMessageId: text('source_message_id').references(() => messages.id),
  trader:          text('trader').notNull(),
  symbol:          text('symbol').notNull(),
  direction:       text('direction').notNull().$type<Direction>(),    // LONG | SHORT
  strategy:        text('strategy').notNull().$type<Strategy>(),     // CDS, PDS, CALL, PUT, STOCK
  legs:            typedJson<TradeLeg[]>('legs').notNull(),
  status:          text('status').notNull().default('OPEN'), // OPEN | CLOSED | CANCELLED
  entryPrice:      text('entry_price'),
  exitPrice:       text('exit_price'),
  quantity:        integer('quantity').notNull().default(1),
  pnl:             text('pnl'),
  openedAt:        text('opened_at'),
  closedAt:        text('closed_at'),
  closeMessageId:  text('close_message_id').references(() => messages.id),
  channelId:       text('channel_id').notNull(),
  metadata:        typedJson<TradeMetadata>('metadata').notNull().default(jsonObjectDefault),
  avgEntryPrice:   text('avg_entry_price'),
  brokerFillPrice: text('broker_fill_price'),
  brokerFillQty:   integer('broker_fill_qty'),
  brokerCommission: text('broker_commission'),
  brokerFillTime:  text('broker_fill_time'),
  brokerLegFills:  typedJson<LegFill[]>('broker_leg_fills'),
  realizedPnl:     text('realized_pnl'),  // accumulated PnL from partial exits (TRIMs)
  /** ISO date when the position was expected to be exited.
   *  Set at OPEN to MIN(legs.expiry) for option trades. Null means
   *  no defensible planned exit (stock without stop, signal without expiry). */
  plannedExitDate: text('planned_exit_date'),
}, (table) => [
  index('idx_trades_trader').on(table.trader),
  index('idx_trades_symbol').on(table.symbol),
  index('idx_trades_status').on(table.status),
  index('idx_trades_channel').on(table.channelId),
  index('idx_trades_planned_exit').on(table.channelId, table.status, table.plannedExitDate),
]);

// ─── Trade Events (append-only action log) ──────────

export const tradeEvents = pgTable('trade_events', {
  id:         text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  tradeId:    text('trade_id').references(() => trades.id).notNull(),
  action:     text('action').notNull(),         // OPEN | CLOSE | ADD | TRIM | LEG_OFF
  price:      text('price'),                    // fill price for this action
  quantity:   integer('quantity'),               // contracts/shares involved
  legs:       typedJson<TradeLeg[]>('legs').notNull().default(jsonArrayDefault),
  strategy:   text('strategy').$type<Strategy>(),                 // strategy at time of event
  direction:  text('direction').$type<Direction>(),                // direction at time of event
  messageId:  text('message_id'),               // source message that triggered this
  metadata:   typedJson<Record<string, unknown>>('metadata').notNull().default(jsonObjectDefault),
  timestamp:  text('timestamp').notNull(),       // ISO 8601 — when the action happened
  createdAt:  text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_trade_events_trade').on(table.tradeId),
  index('idx_trade_events_timestamp').on(table.timestamp),
]);

export type TradeEvent = typeof tradeEvents.$inferSelect;

// ─── Backtest Runs ───────────────────────────────────

export const backtestRuns = pgTable('backtest_runs', {
  id:              text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  status:          text('status').notNull().default('PENDING'), // PENDING | RUNNING | COMPLETED | FAILED
  config:          typedJson<BacktestRunConfig>('config').notNull(),
  summary:         typedJson<BacktestRunSummary>('summary'),
  byTrader:        typedJson<Record<string, TraderStats>>('by_trader'),
  byStrategy:      typedJson<Record<string, StrategyStats>>('by_strategy'),
  equityCurve:     typedJson<EquityPoint[]>('equity_curve'),
  createdAt:       text('created_at').$defaultFn(() => new Date().toISOString()),
  startedAt:       text('started_at'),
  completedAt:     text('completed_at'),
  durationMs:      integer('duration_ms'),
  error:           text('error'),
  pid:             integer('pid'),
  // Eval framework columns
  name:            text('name'),                    // human label, e.g. "sonnet baseline sept"
  experimentTag:   text('experiment_tag'),           // groups runs, e.g. "model-comparison-feb"
  pinned:          boolean('pinned').default(false),
  extendedMetrics: typedJson<ExtendedMetrics>('extended_metrics'),
  liveMetrics:     typedJson<LiveMetrics>('live_metrics'),
}, (table) => [
  index('idx_backtest_runs_status').on(table.status),
  index('idx_backtest_runs_experiment_tag').on(table.experimentTag),
]);

// ─── Run Decisions ──────────────────────────────────

export const runDecisions = pgTable('run_decisions', {
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
  snapshot:       typedJson<Record<string, unknown>>('snapshot'),
  durationMs:     integer('duration_ms'),
  inputTokens:    integer('input_tokens'),          // LLM input tokens (null for deterministic skips)
  outputTokens:   integer('output_tokens'),         // LLM output tokens (null for deterministic skips)
  createdAt:      text('created_at').$defaultFn(() => new Date().toISOString()),
  skipCategory:   text('skip_category'),
}, (table) => [
  index('idx_run_decisions_channel').on(table.channelId),
  index('idx_run_decisions_message').on(table.messageId),
  index('idx_run_decisions_channel_message').on(table.channelId, table.messageId),
  index('idx_run_decisions_task').on(table.taskId),
  index('idx_run_decisions_settled').on(table.channelId, table.event),
]);

// ─── Backtest MTM Snapshots ──────────────────────────

export const backtestMtmSnapshots = pgTable('backtest_mtm_snapshots', {
  id:             text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  channelId:      text('channel_id').notNull(),
  date:           text('date').notNull(),           // YYYY-MM-DD (trading day)
  unrealizedPnl:  real('unrealized_pnl').notNull(),
  createdAt:      text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_mtm_snapshots_channel').on(table.channelId),
  index('idx_mtm_snapshots_channel_date').on(table.channelId, table.date),
]);

// ─── Backtest Checkpoints ────────────────────────────

export const backtestCheckpoints = pgTable('backtest_checkpoints', {
  runId:     text('run_id').primaryKey().references(() => backtestRuns.id, { onDelete: 'cascade' }),
  state:     typedJson<BacktestCheckpointState>('state').notNull(),
  createdAt: text('created_at').$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_backtest_checkpoints_updated').on(table.updatedAt),
]);

export const backtestMessageProgress = pgTable('backtest_message_progress', {
  id:           text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  runId:        text('run_id').notNull().references(() => backtestRuns.id, { onDelete: 'cascade' }),
  channelId:    text('channel_id').notNull(),
  messageId:    text('message_id').references(() => messages.id),
  messageIndex: integer('message_index').notNull(),
  status:       text('status').notNull(), // STARTED | COMMITTED | FAILED
  phase:        text('phase').notNull().default('REPLAYING'),
  attempt:      integer('attempt').notNull().default(1),
  error:        text('error'),
  startedAt:    text('started_at').notNull(),
  completedAt:  text('completed_at'),
}, (table) => [
  index('idx_backtest_progress_run').on(table.runId),
  index('idx_backtest_progress_channel').on(table.channelId),
  uniqueIndex('idx_backtest_progress_run_message').on(table.runId, table.messageId),
]);

export const backtestAttempts = pgTable('backtest_attempts', {
  id:          text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  runId:       text('run_id').notNull().references(() => backtestRuns.id, { onDelete: 'cascade' }),
  attempt:     integer('attempt').notNull(),
  pid:         integer('pid'),
  status:      text('status').notNull().default('RUNNING'), // RUNNING | EXITED
  startedAt:   text('started_at').notNull().$defaultFn(() => new Date().toISOString()),
  completedAt: text('completed_at'),
  exitCode:    integer('exit_code'),
  signal:      text('signal'),
  error:       text('error'),
  logTail:     text('log_tail'),
}, (table) => [
  index('idx_backtest_attempts_run').on(table.runId),
  uniqueIndex('idx_backtest_attempts_run_attempt').on(table.runId, table.attempt),
]);

// ─── Tracked Traders ─────────────────────────────────

export const trackedTraders = pgTable('tracked_traders', {
  name:            text('name').primaryKey(),
  enabled:         boolean('enabled').default(true),
  strategies:      typedJson<string[]>('strategies').notNull().default(jsonArrayDefault),
  notes:           text('notes'),
  positionSizingConfig: typedJson<PositionSizingConfig>('position_sizing_config'),
});

// ─── Tracked Trader ↔ Channel Associations ──────────
//
// Junction table that gates per-channel firing. A trader fires on a channel
// only when a row exists here AND `tracked_traders.enabled = true`.
// `positionSizingConfigOverride` (nullable) lets a channel override the
// trader's default sizing config without touching the parent row. When null,
// the parent's `positionSizingConfig` is used.

export const trackedTraderChannels = pgTable('tracked_trader_channels', {
  traderName:                   text('trader_name').notNull().references(() => trackedTraders.name, { onDelete: 'cascade' }),
  channelId:                    text('channel_id').notNull(),
  positionSizingConfigOverride: typedJson<PositionSizingConfig>('position_sizing_config_override'),
  createdAt:                    text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  uniqueIndex('idx_tracked_trader_channels_pk').on(table.traderName, table.channelId),
  index('idx_tracked_trader_channels_channel').on(table.channelId),
]);

export type TrackedTraderChannel = typeof trackedTraderChannels.$inferSelect;

// ─── Daily Balances ─────────────────────────────────

export const dailyBalances = pgTable('daily_balances', {
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

export const reconciliationAlerts = pgTable('reconciliation_alerts', {
  id:         text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  channelId:  text('channel_id').notNull(),
  type:       text('type').notNull().$type<ReconciliationAlertType>(),
  symbol:     text('symbol').notNull(),
  tradeId:    text('trade_id'),
  expected:   typedJson<unknown>('expected'),
  actual:     typedJson<unknown>('actual'),
  resolved:       boolean('resolved').default(false),
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

export const orphanFills = pgTable('orphan_fills', {
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
  resolved: boolean('resolved').default(false),
  taskId: text('task_id'),
  channelId: text('channel_id'),
});

// ─── Historical Fetch Runs ──────────────────────────

export const historicalFetchRuns = pgTable('historical_fetch_runs', {
  id:            text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  status:        text('status').notNull().default('pending'), // pending | running | completed | error | cancelled
  since:         text('since').notNull(),         // YYYY-MM-DD
  until:         text('until').notNull(),         // YYYY-MM-DD
  clearExisting: boolean('clear_existing').default(false),
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

export const historicalFetchChunks = pgTable('historical_fetch_chunks', {
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

export const messageIntents = pgTable('message_intents', {
  id:           text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId:    text('message_id').references(() => messages.id).notNull(),
  model:        text('model').notNull(),              // e.g. "grok-4-1-fast-non-reasoning" or "deterministic"
  version:      integer('version').notNull().default(1), // bump when prompts/parser change
  route:        text('route').notNull(),               // hard-skip | deterministic | llm
  decision:     text('decision').notNull(),            // EXECUTE | SKIP | MANUAL_REVIEW
  reasoning:    text('reasoning'),
  signals:      typedJson<Signal[]>('signals'),
  durationMs:   integer('duration_ms'),
  inputTokens:  integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheReadInputTokens:     integer('cache_read_input_tokens'),
  cacheCreationInputTokens: integer('cache_creation_input_tokens'),
  /**
   * Cost in USD charged by the provider for this classification.
   *   - xAI: billed value from `usage.cost_in_usd_ticks` (tick / 1e10).
   *   - Anthropic: computed from published per-MTok rates.
   * Null for hard-skip / deterministic routes (no LLM call) and legacy rows.
   */
  costUsd:      real('cost_usd'),
  turns:        integer('turns'),
  steps:        typedJson<IntentStep[]>('steps'),
  createdAt:    text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_intents_message').on(table.messageId),
  index('idx_intents_model_version').on(table.model, table.version),
  uniqueIndex('idx_intents_unique').on(table.messageId, table.model, table.version),
]);

export const IntentStepSchema = z.object({
  toolName: z.string().optional(),
  toolInput: z.unknown().optional(),
  toolOutput: z.unknown().optional(),
  reasoning: z.string().optional(),
  durationMs: z.number().optional(),
});
export type IntentStep = z.infer<typeof IntentStepSchema>;

// ─── Classification Audits ──────────────────────────

export const classificationAudits = pgTable('classification_audits', {
  id:            text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  channelId:     text('channel_id').notNull(),
  taskId:        text('task_id').references(() => tasks.id),
  messageId:     text('message_id').references(() => messages.id).notNull(),
  runDecisionId: text('run_decision_id').references(() => runDecisions.id),
  auditKind:     text('audit_kind').notNull().$type<ClassificationAuditKind>(),
  severity:      text('severity').notNull().$type<SafetySeverity>(),
  status:        text('status').notNull().$type<ClassificationAuditStatus>().default('open'),
  confidence:    real('confidence').notNull().default(0),
  category:      text('category').$type<SafetyFindingCategory>(),
  title:         text('title').notNull(),
  details:       text('details').notNull(),
  findings:      typedJson<SafetyFinding[]>('findings').notNull().default(jsonArrayDefault),
  payload:       typedJson<ClassificationAuditPayload>('payload').notNull().default(jsonObjectDefault),
  critic:        typedJson<CriticVerdict>('critic'),
  alertKey:      text('alert_key'),
  alertSentAt:   text('alert_sent_at'),
  resolvedAt:    text('resolved_at'),
  resolvedReason: text('resolved_reason'),
  createdAt:     text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_classification_audits_channel').on(table.channelId),
  index('idx_classification_audits_message').on(table.messageId),
  index('idx_classification_audits_decision').on(table.runDecisionId),
  index('idx_classification_audits_status').on(table.status),
  index('idx_classification_audits_severity_status').on(table.severity, table.status),
  index('idx_classification_audits_alert_key').on(table.alertKey),
]);

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

export type TradeRiskBasis =
  | 'premium_paid'
  | 'defined_spread'
  | 'stock_notional'
  | 'margin_requirement'
  | 'manual_stop'
  | 'unbounded'
  | 'unknown';

export type TradeRiskConfidence = 'exact' | 'estimate' | 'unknown';

export type TradeRiskSnapshot = {
  currentRisk: number | null;
  peakRisk: number | null;
  basis: TradeRiskBasis;
  confidence: TradeRiskConfidence;
  multiplier: number;
  notes: string[];
  /** True when the position's risk structure mutated mid-life (LEG_OFF).
   *  Peak is frozen from the prior structure; downstream R-multiple
   *  consumers should treat the denominator as historical, not forward. */
  riskTopologyChanged?: boolean;
};

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
  /** True when a cancelled/rejected order had a partial fill; trade kept OPEN at actual qty. */
  partialFill?: boolean;
  /** Original requested quantity before a partial fill truncated it. */
  originalQuantity?: number;
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
  /** Algorithmic finite-risk snapshot used for R-multiple analytics. */
  risk?: TradeRiskSnapshot;
  /** Materialized trade flags — set at write time by recordTrade and async updaters. */
  flags?: TradeFlag[];
  /** Total pipeline execution time (ms) from trace spans — message ingestion to final event. */
  executionMs?: number;
  /**
   * IBKR order ID of the GTC stop order protecting this position.
   * Set after entry fills. Cleared when the stop is cancelled (on CLOSE/TRIM).
   * Absence means no server-side stop is active — startup reconciler will re-place.
   */
  stopOrderId?: string;
  /** Catch-all for genuinely unknown future fields. */
  extra?: Record<string, unknown>;
};

// ─── Runtime Health ──────────────────────────────────

export const runtimeHealth = pgTable('runtime_health', {
  channelId:     text('channel_id').primaryKey(),
  brokerHealthy: boolean('broker_healthy').notNull().default(true),
  circuitOpen:   boolean('circuit_open').notNull().default(false),
  lastError:     text('last_error'),
  updatedAt:     text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Discrepancy Reviews (parser audit verdicts) ─────

export type DiscrepancyVerdict = 'parser_right' | 'label_right' | 'both_wrong' | 'skip';
export type DiscrepancyCategory = 'false_positive' | 'false_negative' | 'action_mismatch' | 'strategy_mismatch' | 'direction_mismatch';

export const discrepancyReviews = pgTable('discrepancy_reviews', {
  id:               text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId:        text('message_id').references(() => messages.id).notNull(),
  category:         text('category').notNull().$type<DiscrepancyCategory>(),
  // Human verdict
  verdict:          text('verdict').$type<DiscrepancyVerdict>(),
  reason:           text('reason'),
  reviewed:         boolean('reviewed').default(false),
  reviewedAt:       text('reviewed_at'),
  // Parser output (denormalized — frozen at comparison time)
  parserAction:     text('parser_action'),
  parserStrategy:   text('parser_strategy'),
  parserDirection:  text('parser_direction'),
  parserSkipReason: text('parser_skip_reason'),
  parserFlags:      typedJson<string[]>('parser_flags').notNull().default(jsonArrayDefault),
  // Label output (denormalized)
  labelAction:      text('label_action'),
  labelStrategy:    text('label_strategy'),
  labelDirection:   text('label_direction'),
  labelNotes:       text('label_notes'),
  // Agent verdict (from the 95 audit agents)
  agentVerdict:     text('agent_verdict'),
  agentReason:      text('agent_reason'),
  // Message context (denormalized for rendering without JOIN)
  author:           text('author').notNull(),
  cleanText:        text('clean_text').notNull(),
  badges:           typedJson<string[]>('badges').notNull().default(jsonArrayDefault),
  symbols:          typedJson<string[]>('symbols').notNull().default(jsonArrayDefault),
  timestamp:        text('timestamp').notNull(),
  createdAt:        text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_disc_reviews_message').on(table.messageId),
  index('idx_disc_reviews_verdict').on(table.verdict),
  index('idx_disc_reviews_category').on(table.category),
  index('idx_disc_reviews_reviewed').on(table.reviewed),
  index('idx_disc_reviews_category_verdict').on(table.category, table.verdict),
]);

// ─── Eval Labels ─────────────────────────────────────

/** Eval label wrapping Signal[][] with review metadata. */
export type EvalLabelData = {
  reasoning: string;
  isTrade: boolean;
  confidence: 'HIGH' | 'LOW';
  trades: Signal[][];  // outer = trades in message, inner = legs of one trade
};

export const evalLabels = pgTable('eval_labels', {
  id:             text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId:      text('message_id').references(() => messages.id).notNull(),
  // The label data (stored as JSON)
  label:          typedJson<EvalLabelData>('label').notNull(),
  // Source tracking
  source:         text('source').notNull().default('agent'), // agent | human
  model:          text('model'),                              // model that generated this
  version:        integer('version').notNull().default(2),    // bump when prompt/schema changes
  // Human review
  humanVerified:  boolean('human_verified').default(false),
  humanLabel:     typedJson<EvalLabelData>('human_label'),  // human correction (null if agent was right)
  rejectionReason: text('rejection_reason'),                // e.g. NOT_TRADE, MISSED_TRADE, WRONG_SIGNALS, WRONG_ACTION, OTHER
  feedback:       text('feedback'),                          // free-text human feedback
  reviewedAt:     text('reviewed_at'),
  // Metadata
  durationMs:     integer('duration_ms'),
  inputTokens:    integer('input_tokens'),
  outputTokens:   integer('output_tokens'),
  createdAt:      text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  uniqueIndex('idx_eval_labels_message_version').on(table.messageId, table.version),
  index('idx_eval_labels_source').on(table.source),
  index('idx_eval_labels_human_verified').on(table.humanVerified),
]);

// ─── Inferred Types ──────────────────────────────────

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Trade = typeof trades.$inferSelect;
export type BacktestRun = typeof backtestRuns.$inferSelect;
export type TrackedTrader = typeof trackedTraders.$inferSelect;
export type DailyBalance = typeof dailyBalances.$inferSelect;
export type ReconciliationAlert = typeof reconciliationAlerts.$inferSelect;
export type HistoricalFetchRun = typeof historicalFetchRuns.$inferSelect;
export type HistoricalFetchChunk = typeof historicalFetchChunks.$inferSelect;
export type RunDecision = typeof runDecisions.$inferSelect;
export type BacktestMtmSnapshot = typeof backtestMtmSnapshots.$inferSelect;
export type BacktestCheckpoint = typeof backtestCheckpoints.$inferSelect;
export type BacktestMessageProgress = typeof backtestMessageProgress.$inferSelect;
export type BacktestAttempt = typeof backtestAttempts.$inferSelect;
export type MessageIntent = typeof messageIntents.$inferSelect;
export type NewMessageIntent = typeof messageIntents.$inferInsert;
export type ClassificationAudit = typeof classificationAudits.$inferSelect;
export type NewClassificationAudit = typeof classificationAudits.$inferInsert;
export type RuntimeHealth = typeof runtimeHealth.$inferSelect;
export type DiscrepancyReview = typeof discrepancyReviews.$inferSelect;
export type NewDiscrepancyReview = typeof discrepancyReviews.$inferInsert;
export type EvalLabelRow = typeof evalLabels.$inferSelect;

// ─── Classify Runs (re-added after DB-Zod refactor drop) ───

const ClassifyRunConfigSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  traders: z.array(z.string()),
  agentProvider: z.string().optional(),
  agentModel: z.string().optional(),
  concurrency: z.number().int().positive().optional(),
  maxAgentCalls: z.number().int().positive().optional(),
});
export type ClassifyRunConfig = z.infer<typeof ClassifyRunConfigSchema>;
export { ClassifyRunConfigSchema };

const ClassifyRunSummarySchema = z.object({
  totalMessages: z.number(),
  tradableMessages: z.number(),
  processedMessages: z.number(),
  byOutcome: z.object({
    EXECUTE: z.number(),
    SKIP: z.number(),
    MANUAL_REVIEW: z.number(),
    ERROR: z.number(),
  }),
  byRoute: z.object({
    'hard-skip': z.number(),
    deterministic: z.number(),
    llm: z.number(),
  }),
  byRuleId: z.record(z.string(), z.number()).optional(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCacheReadInputTokens: z.number().optional(),
  totalCacheCreationInputTokens: z.number().optional(),
  /** Sum of LLM cost across all classifications in this run (USD). */
  totalCostUsd: z.number().optional(),
  durationMs: z.number(),
});
export type ClassifyRunSummary = z.infer<typeof ClassifyRunSummarySchema>;
export { ClassifyRunSummarySchema };

export const classifyRuns = pgTable('classify_runs', {
  id:              text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  status:          text('status').notNull().default('PENDING'),
  config:          typedJson<ClassifyRunConfig>('config').notNull(),
  summary:         typedJson<ClassifyRunSummary>('summary'),
  createdAt:       text('created_at').$defaultFn(() => new Date().toISOString()),
  startedAt:       text('started_at'),
  completedAt:     text('completed_at'),
  durationMs:      integer('duration_ms'),
  error:           text('error'),
  pid:             integer('pid'),
  name:            text('name'),
  experimentTag:   text('experiment_tag'),
  pinned:          boolean('pinned').default(false),
  progressIndex:   integer('progress_index').default(0),
  progressTotal:   integer('progress_total').default(0),
  lastMessageTs:   text('last_message_ts'),
  lastMessageId:   text('last_message_id'),
}, (table) => [
  index('idx_classify_runs_status').on(table.status),
  index('idx_classify_runs_experiment_tag').on(table.experimentTag),
]);
export type ClassifyRun = typeof classifyRuns.$inferSelect;
