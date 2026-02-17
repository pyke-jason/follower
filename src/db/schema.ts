import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { PositionSizingConfig } from '../position-sizing/index.js';
import type { Signal } from '../agent/schemas.js';
export type { PositionSizingConfig } from '../position-sizing/index.js';

// SQLite doesn't have native enums — use text columns with TS types for safety.

// ─── Messages ────────────────────────────────────────

export const messages = sqliteTable('messages', {
  id:                 text('id').primaryKey(),
  author:             text('author').notNull(),
  timestamp:          text('timestamp').notNull(), // ISO 8601
  rawHtml:            text('raw_html').notNull(),
  cleanText:          text('clean_text').notNull(),
  badges:             text('badges', { mode: 'json' }).$type<string[]>().default([]),
  symbols:            text('symbols', { mode: 'json' }).$type<string[]>().default([]),
  actionHint:         text('action_hint'),       // OPEN | CLOSE | ADJUST | null
  directionHint:      text('direction_hint'),     // LONG | SHORT | null
  detectedStrategies: text('detected_strategies', { mode: 'json' }).$type<DetectedStrategy[]>().default([]),
  isPaperTrade:       integer('is_paper_trade', { mode: 'boolean' }).default(false),
  hasMultipleTrades:  integer('has_multiple_trades', { mode: 'boolean' }).default(false),
  confidence:         text('confidence'),          // numeric stored as text (matches pg behavior)
  ingestedAt:         text('ingested_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_messages_author').on(table.author),
  index('idx_messages_timestamp').on(table.timestamp),
]);

// ─── Message Labels (Eval Ground Truth) ─────────────

export const messageLabels = sqliteTable('message_labels', {
  id:         text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId:  text('message_id').references(() => messages.id).notNull(),
  labelSet:   text('label_set').notNull().default('baseline'),
  // Ground truth fields
  isTrade:    integer('is_trade', { mode: 'boolean' }),
  action:     text('action'),       // OPEN | CLOSE | null
  direction:  text('direction'),    // LONG | SHORT | null
  strategy:   text('strategy'),     // STOCK | CALL | PUT | CDS | PDS | null
  symbol:     text('symbol'),
  price:      text('price'),        // as text, null = ambiguous/unknown
  strikes:    text('strikes', { mode: 'json' }).$type<number[] | null>(),
  quantity:   text('quantity'),
  expiry:     text('expiry'),       // ISO date
  // Metadata
  source:     text('source').notNull().default('manual'), // manual | agent
  reviewed:   integer('reviewed', { mode: 'boolean' }).default(false),
  notes:         text('notes'),
  exitPercent:   real('exit_percent'),     // 0.0 to 1.0 for TRIM actions
  modelProvider: text('model_provider'),  // 'anthropic' | 'xai' | null (null for manual)
  modelName:     text('model_name'),      // full model ID or null
  createdAt:     text('created_at').$defaultFn(() => new Date().toISOString()),
  updatedAt:     text('updated_at'),
}, (table) => [
  index('idx_labels_message').on(table.messageId),
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
  context:     text('context', { mode: 'json' }).$type<TaskContext>().default({}),
  result:      text('result', { mode: 'json' }).$type<TaskResult | null>(),
  createdAt:   text('created_at').$defaultFn(() => new Date().toISOString()),
  startedAt:   text('started_at'),
  completedAt: text('completed_at'),
  error:         text('error'),
  modelProvider: text('model_provider'),  // 'anthropic' | 'xai'
  modelName:     text('model_name'),      // full model ID or null
  backtestRunId: text('backtest_run_id').references(() => backtestRuns.id),
}, (table) => [
  index('idx_tasks_status').on(table.status),
  index('idx_tasks_message').on(table.messageId),
  index('idx_tasks_backtest_run').on(table.backtestRunId),
  uniqueIndex('idx_tasks_message_unique').on(table.messageId).where(sql`message_id IS NOT NULL`),
]);

// ─── Task Steps ──────────────────────────────────────

export const taskSteps = sqliteTable('task_steps', {
  id:          text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  taskId:      text('task_id').references(() => tasks.id).notNull(),
  stepNumber:  integer('step_number').notNull(),
  toolName:    text('tool_name'),
  toolInput:   text('tool_input', { mode: 'json' }),
  toolOutput:  text('tool_output', { mode: 'json' }),
  reasoning:   text('reasoning'),
  durationMs:  integer('duration_ms'),
  createdAt:   text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_steps_task').on(table.taskId),
]);

// ─── Trades ──────────────────────────────────────────

export const trades = sqliteTable('trades', {
  id:              text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  taskId:          text('task_id').references(() => tasks.id),
  sourceMessageId: text('source_message_id').references(() => messages.id),
  trader:          text('trader').notNull(),
  symbol:          text('symbol').notNull(),
  direction:       text('direction').notNull(),    // LONG | SHORT
  strategy:        text('strategy').notNull(),     // CDS, PDS, CALL, PUT, STOCK
  legs:            text('legs', { mode: 'json' }).$type<TradeLeg[]>().notNull(),
  status:          text('status').notNull().default('OPEN'), // OPEN | CLOSED | CANCELLED | PARTIAL
  entryPrice:      text('entry_price'),
  exitPrice:       text('exit_price'),
  quantity:        integer('quantity').default(1),
  pnl:             text('pnl'),
  openedAt:        text('opened_at'),
  closedAt:        text('closed_at'),
  closeMessageId:  text('close_message_id').references(() => messages.id),
  isBacktest:      integer('is_backtest', { mode: 'boolean' }).default(false),
  backtestRunId:   text('backtest_run_id').references(() => backtestRuns.id),
  metadata:        text('metadata', { mode: 'json' }).$type<TradeMetadata>().default({}),
  parentTradeId:   text('parent_trade_id').references((): any => trades.id),
  exitPercent:     real('exit_percent'),
  avgEntryPrice:   text('avg_entry_price'),
  brokerFillPrice: text('broker_fill_price'),
  brokerFillQty:   integer('broker_fill_qty'),
  brokerCommission: text('broker_commission'),
  brokerFillTime:  text('broker_fill_time'),
  brokerLegFills:  text('broker_leg_fills', { mode: 'json' }).$type<import('../broker/types.js').LegFill[] | null>(),
}, (table) => [
  index('idx_trades_trader').on(table.trader),
  index('idx_trades_symbol').on(table.symbol),
  index('idx_trades_status').on(table.status),
  index('idx_trades_backtest_run').on(table.backtestRunId),
  index('idx_trades_parent').on(table.parentTradeId),
]);

// ─── Backtest Runs ───────────────────────────────────

export const backtestRuns = sqliteTable('backtest_runs', {
  id:              text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  status:          text('status').notNull().default('PENDING'), // PENDING | RUNNING | COMPLETED | FAILED
  config:          text('config', { mode: 'json' }).$type<BacktestRunConfig>().notNull(),
  summary:         text('summary', { mode: 'json' }).$type<BacktestRunSummary | null>(),
  byTrader:        text('by_trader', { mode: 'json' }).$type<Record<string, { trades: number; wins: number; losses: number; winRate: number; totalPnl: number }> | null>(),
  byStrategy:      text('by_strategy', { mode: 'json' }).$type<Record<string, { trades: number; wins: number; losses: number; winRate: number; totalPnl: number; avgPnl: number }> | null>(),
  equityCurve:     text('equity_curve', { mode: 'json' }).$type<{ date: string; pnl: number; cumPnl: number; trades: number; unrealizedPnl?: number; equity?: number }[] | null>(),
  createdAt:       text('created_at').$defaultFn(() => new Date().toISOString()),
  startedAt:       text('started_at'),
  completedAt:     text('completed_at'),
  durationMs:      integer('duration_ms'),
  error:           text('error'),
  pid:             integer('pid'),
  // Eval framework columns
  name:            text('name'),                    // human label, e.g. "sonnet baseline sept"
  experimentTag:   text('experiment_tag'),           // groups runs, e.g. "model-comparison-feb"
  parentRunId:     text('parent_run_id').references((): any => backtestRuns.id),
  pinned:          integer('pinned', { mode: 'boolean' }).default(false),
  extendedMetrics: text('extended_metrics', { mode: 'json' }).$type<import('../backtest/types.js').ExtendedMetrics | null>(),
  liveMetrics:     text('live_metrics', { mode: 'json' }).$type<import('../backtest/types.js').LiveMetrics | null>(),
}, (table) => [
  index('idx_backtest_runs_status').on(table.status),
  index('idx_backtest_runs_experiment_tag').on(table.experimentTag),
]);

// ─── Run Decisions ──────────────────────────────────

export const runDecisions = sqliteTable('run_decisions', {
  id:             text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  backtestRunId:  text('backtest_run_id').references(() => backtestRuns.id).notNull(),
  messageId:      text('message_id').references(() => messages.id).notNull(),
  path:           text('path').notNull(),          // 'agent' | 'skipped'
  decision:       text('decision').notNull(),      // 'EXECUTE' | 'SKIP'
  reasoning:      text('reasoning'),
  tradeId:        text('trade_id'),                // FK to resulting trade (null if SKIP)
  pnl:            text('pnl'),                     // outcome P&L, back-filled after close
  durationMs:     integer('duration_ms'),
  inputTokens:    integer('input_tokens'),          // LLM input tokens (null for deterministic skips)
  outputTokens:   integer('output_tokens'),         // LLM output tokens (null for deterministic skips)
  createdAt:      text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_run_decisions_run').on(table.backtestRunId),
  index('idx_run_decisions_message').on(table.messageId),
  index('idx_run_decisions_run_message').on(table.backtestRunId, table.messageId),
]);

// ─── Tracked Traders ─────────────────────────────────

export const trackedTraders = sqliteTable('tracked_traders', {
  name:            text('name').primaryKey(),
  enabled:         integer('enabled', { mode: 'boolean' }).default(true),
  strategies:      text('strategies', { mode: 'json' }).$type<string[]>().default([]),
  notes:           text('notes'),
  positionSizingConfig: text('position_sizing_config', { mode: 'json' })
    .$type<PositionSizingConfig>(),
});

// ─── Daily Balances ─────────────────────────────────

export const dailyBalances = sqliteTable('daily_balances', {
  id:            text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
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
]);

// ─── Reconciliation Alerts ──────────────────────────

export type ReconciliationAlertType = 'BROKER_ONLY' | 'DB_ONLY' | 'QUANTITY_MISMATCH';

export const reconciliationAlerts = sqliteTable('reconciliation_alerts', {
  id:         text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
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
]);

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

// ─── Eval Runs ──────────────────────────────────────

export const evalRuns = sqliteTable('eval_runs', {
  id:                  text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  labelSet:            text('label_set').notNull(),
  ranAt:               text('ran_at').notNull(),
  totalLabels:         integer('total_labels').notNull(),
  actionAccuracy:      real('action_accuracy'),
  directionAccuracy:   real('direction_accuracy'),
  strategyAccuracy:    real('strategy_accuracy'),
  priceAccuracy:       real('price_accuracy'),
  exitPriceAccuracy:   real('exit_price_accuracy'),
  strikesAccuracy:     real('strikes_accuracy'),
  overallAccuracy:     real('overall_accuracy'),
  totalMislabelings:   integer('total_mislabelings'),
  failuresJson:        text('failures_json', { mode: 'json' }),
});

// ─── Backtest Config/Summary Types ───────────────────

export type BacktestRunConfig = {
  startDate: string;   // ISO date
  endDate: string;     // ISO date
  traders: string[];
  useQuoteTape: boolean;
  agentProvider?: string;  // 'anthropic' | 'xai'
  agentModel?: string;     // e.g. 'claude-sonnet-4-5-20250929'
  fillModel?: 'orats' | 'midpoint' | 'natural';
  name?: string;           // human label for the run
  refreshQuoteCache?: boolean;
  startingEquity?: number;  // default: 100_000
  maxAgentCalls?: number;
  // Risk limit overrides (defaults: maxOnSymbol=3, maxTotalPositions=20, maxDrawdownPct=5, maxNotionalMultiplier=2)
  maxOnSymbol?: number;
  maxTotalPositions?: number;
  maxDrawdownPct?: number;
  maxNotionalMultiplier?: number;
  disableRiskLimits?: boolean;
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
};

// ─── Supporting Types ────────────────────────────────

export type DetectedStrategy = {
  strategy: string;
  confidence: number;
  strikes?: number[];
  expiry?: string;
  price?: number;
  quantity?: number;
};

export type TradeLeg = {
  symbol: string;
  strike: number;
  expiry: string;
  type: 'CALL' | 'PUT' | 'STOCK';
  action: 'BUY' | 'SELL';
  quantity: number;
  fillPrice?: number;
};

export type TaskContext = {
  messageId?: string;
  messageTimestamp?: string;  // ISO 8601 — when the chat message was posted
  author?: string;
  cleanText?: string;
  badges?: string[];
  symbols?: string[];
  actionHint?: string | null;
  directionHint?: string | null;
  detectedStrategies?: DetectedStrategy[];
  confidence?: number;
  [key: string]: unknown;
};

export type TaskResult = {
  decision: 'EXECUTE' | 'SKIP' | 'MANUAL_REVIEW';
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
  [key: string]: unknown;
};

// ─── Inferred Types ──────────────────────────────────

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskStep = typeof taskSteps.$inferSelect;
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
export type EvalRun = typeof evalRuns.$inferSelect;
