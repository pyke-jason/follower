import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

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
  error:       text('error'),
  backtestRunId: text('backtest_run_id').references(() => backtestRuns.id),
}, (table) => [
  index('idx_tasks_status').on(table.status),
  index('idx_tasks_message').on(table.messageId),
  index('idx_tasks_backtest_run').on(table.backtestRunId),
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
}, (table) => [
  index('idx_trades_trader').on(table.trader),
  index('idx_trades_symbol').on(table.symbol),
  index('idx_trades_status').on(table.status),
  index('idx_trades_backtest_run').on(table.backtestRunId),
]);

// ─── Backtest Runs ───────────────────────────────────

export const backtestRuns = sqliteTable('backtest_runs', {
  id:          text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  status:      text('status').notNull().default('PENDING'), // PENDING | RUNNING | COMPLETED | FAILED
  config:      text('config', { mode: 'json' }).$type<BacktestRunConfig>().notNull(),
  summary:     text('summary', { mode: 'json' }).$type<BacktestRunSummary | null>(),
  byTrader:    text('by_trader', { mode: 'json' }).$type<Record<string, { trades: number; wins: number; losses: number; winRate: number; totalPnl: number }> | null>(),
  byStrategy:  text('by_strategy', { mode: 'json' }).$type<Record<string, { trades: number; wins: number; losses: number; winRate: number; totalPnl: number; avgPnl: number }> | null>(),
  equityCurve: text('equity_curve', { mode: 'json' }).$type<{ date: string; pnl: number; cumPnl: number; trades: number }[] | null>(),
  createdAt:   text('created_at').$defaultFn(() => new Date().toISOString()),
  startedAt:   text('started_at'),
  completedAt: text('completed_at'),
  durationMs:  integer('duration_ms'),
  error:       text('error'),
}, (table) => [
  index('idx_backtest_runs_status').on(table.status),
]);

// ─── Tracked Traders ─────────────────────────────────

export const trackedTraders = sqliteTable('tracked_traders', {
  name:            text('name').primaryKey(),
  enabled:         integer('enabled', { mode: 'boolean' }).default(true),
  strategies:      text('strategies', { mode: 'json' }).$type<string[]>().default([]),
  maxAllocation:   text('max_allocation'),
  maxDailyAlloc:   text('max_daily_allocation'),
  notes:           text('notes'),
});

// ─── Backtest Config/Summary Types ───────────────────

export type BacktestRunConfig = {
  startDate: string;   // ISO date
  endDate: string;     // ISO date
  traders: string[];
  useAgent: boolean;
  maxAgentCalls: number;
  slippagePct: number;
  useQuoteTape: boolean;
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
  deterministicTrades: number;
  agentTrades: number;
  skippedLowConfidence: number;
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
  trade?: Partial<typeof trades.$inferInsert> | null;
};

export type TradeMetadata = {
  slippage?: number;
  fillQuality?: string;
  agentModel?: string;
  brokerOrderId?: string;
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
