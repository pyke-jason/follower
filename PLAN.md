# Trade Room Follower — Architecture & Agent Design (v3)

> All TypeScript. Drizzle for DB. Claude Agent SDK (TS). TradeStation broker. React dashboard later.

---

## Design Principles

1. **One language, one type system.** Drizzle schema → API types → React props. No serialization boundary, no model duplication.
2. **Regex is the bouncer, the agent is the detective.** 71% of messages are noise (no badge). Another ~50% of badged messages are clean regex extractions. The agent only runs on genuinely ambiguous messages — roughly 15% of total volume. This keeps costs sane.
3. **TradeStation for now, not forever.** Broker interaction lives in one file (`broker/tradestation.ts`). It exports typed functions, not an abstract class hierarchy. When you switch brokers, you rewrite that file and the types stay the same.
4. **Audit everything.** Every agent step is recorded. You should be able to open any trade in the dashboard and see: message → task → each tool call → decision → order.
5. **Same agent, swappable tools.** Live and backtest share the agent code. Only the tool implementations differ (real API vs. historical data).

---

## Project Structure

```
trade-follower/
├── src/
│   ├── db/
│   │   ├── schema.ts              # Drizzle schema (source of truth for all types)
│   │   ├── migrate.ts             # Migration runner
│   │   └── client.ts              # Drizzle client + connection pool
│   │
│   ├── ingestion/
│   │   ├── browser.ts             # Playwright browser launcher
│   │   ├── signalr.ts             # SignalR hub connection + message stream
│   │   └── ingest.ts              # Orchestrator: connect → listen → parse → store
│   │
│   ├── parsing/
│   │   ├── html.ts                # Raw HTML → clean text + text segments
│   │   ├── badges.ts              # Extract badge tags (Exit, Long, Short, Question)
│   │   ├── symbols.ts             # Pull tickers from data-symbol attrs + plain text
│   │   ├── strategy.ts            # Regex strategy detection (CDS, PDS, calls, etc.)
│   │   ├── exits.ts               # Exit-specific parsing (price, partial, etc.)
│   │   └── classify.ts            # Combine all parsers → MessageClassification
│   │
│   ├── agent/
│   │   ├── trade-agent.ts         # Core agent definition + system prompt
│   │   ├── tools/
│   │   │   ├── message-tools.ts   # get_message_context, get_trader_history
│   │   │   ├── market-tools.ts    # get_quote, get_options_chain, get_spread_price
│   │   │   ├── position-tools.ts  # get_open_positions, check_exposure
│   │   │   ├── execution-tools.ts # place_order, close_position
│   │   │   └── risk-tools.ts      # check_risk_limits, check_daily_pnl
│   │   └── sandbox/               # Backtest tool implementations
│   │       ├── sim-market.ts      # Historical quotes from stored data
│   │       ├── sim-execution.ts   # Paper fills with configurable slippage
│   │       └── sim-positions.ts   # In-memory position tracker
│   │
│   ├── broker/
│   │   ├── tradestation.ts        # TradeStation REST API client
│   │   ├── auth.ts                # OAuth2 token management
│   │   └── types.ts               # Broker-agnostic types (Quote, Order, Fill, etc.)
│   │
│   ├── tasks/
│   │   ├── factory.ts             # Message → Task creation logic
│   │   ├── runner.ts              # Poll pending tasks, dispatch to agent
│   │   └── recorder.ts           # Write steps + results back to DB
│   │
│   ├── backtest/
│   │   ├── runner.ts              # Replay historical messages through agent
│   │   ├── clock.ts               # Simulated clock (controls "now" for tools)
│   │   ├── report.ts              # P&L, win rate, drawdown, per-trader stats
│   │   └── fixtures/              # Saved message sets for regression tests
│   │
│   ├── api/                       # REST API for the dashboard
│   │   ├── index.ts               # Hono app setup
│   │   ├── routes/
│   │   │   ├── messages.ts        # Message feed + search
│   │   │   ├── trades.ts          # Open/closed trades + P&L
│   │   │   ├── tasks.ts           # Task audit trail
│   │   │   └── actions.ts         # Manual actions (exit trade, skip, override)
│   │   └── ws.ts                  # WebSocket for real-time dashboard updates
│   │
│   └── config/
│       ├── traders.ts             # Trader whitelist + per-trader settings
│       └── strategies.ts          # Strategy definitions + risk params
│
├── drizzle/                       # Generated migrations
├── drizzle.config.ts
├── package.json
└── tsconfig.json
```

---

## Database Schema (Drizzle)

```typescript
// src/db/schema.ts
import {
  pgTable, text, timestamp, jsonb, uuid, integer,
  numeric, boolean, index, pgEnum
} from 'drizzle-orm/pg-core';

// ─── Enums ───────────────────────────────────────────

export const taskTypeEnum = pgEnum('task_type', [
  'REVIEW_MESSAGE',
  'EXECUTE_TRADE',
  'CLOSE_POSITION',
  'MANUAL_REVIEW',
]);

export const taskStatusEnum = pgEnum('task_status', [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
]);

export const tradeStatusEnum = pgEnum('trade_status', [
  'OPEN',
  'CLOSED',
  'CANCELLED',
  'PARTIAL',
]);

export const directionEnum = pgEnum('direction', ['LONG', 'SHORT']);

// ─── Messages ────────────────────────────────────────

export const messages = pgTable('messages', {
  id:                text('id').primaryKey(),                    // chat room msg ID
  author:            text('author').notNull(),
  timestamp:         timestamp('timestamp', { withTimezone: true }).notNull(),
  rawHtml:           text('raw_html').notNull(),
  cleanText:         text('clean_text').notNull(),
  badges:            jsonb('badges').$type<string[]>().default([]),
  symbols:           jsonb('symbols').$type<string[]>().default([]),
  actionHint:        text('action_hint'),                       // OPEN | CLOSE | ADJUST | null
  directionHint:     text('direction_hint'),                    // LONG | SHORT | null
  detectedStrategies: jsonb('detected_strategies').$type<DetectedStrategy[]>().default([]),
  textSegments:      jsonb('text_segments').$type<TextSegment[]>().default([]),
  isPaperTrade:      boolean('is_paper_trade').default(false),
  hasMultipleTrades: boolean('has_multiple_trades').default(false),
  confidence:        numeric('confidence'),                     // regex confidence 0-1
  ingestedAt:        timestamp('ingested_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_messages_author').on(table.author),
  index('idx_messages_timestamp').on(table.timestamp),
]);

// ─── Tasks ───────────────────────────────────────────

export const tasks = pgTable('tasks', {
  id:          uuid('id').primaryKey().defaultRandom(),
  messageId:   text('message_id').references(() => messages.id),
  taskType:    taskTypeEnum('task_type').notNull(),
  status:      taskStatusEnum('status').notNull().default('PENDING'),
  assignee:    text('assignee').notNull().default('agent'),     // 'agent' | 'human'
  priority:    integer('priority').default(0),
  context:     jsonb('context').$type<TaskContext>().default({}),
  result:      jsonb('result').$type<TaskResult | null>(),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
  startedAt:   timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  error:       text('error'),
}, (table) => [
  index('idx_tasks_status').on(table.status),
  index('idx_tasks_message').on(table.messageId),
]);

// ─── Task Steps ──────────────────────────────────────

export const taskSteps = pgTable('task_steps', {
  id:          uuid('id').primaryKey().defaultRandom(),
  taskId:      uuid('task_id').references(() => tasks.id).notNull(),
  stepNumber:  integer('step_number').notNull(),
  toolName:    text('tool_name'),               // null = pure reasoning step
  toolInput:   jsonb('tool_input'),
  toolOutput:  jsonb('tool_output'),
  reasoning:   text('reasoning'),               // agent's chain-of-thought
  durationMs:  integer('duration_ms'),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_steps_task').on(table.taskId),
]);

// ─── Trades ──────────────────────────────────────────

export const trades = pgTable('trades', {
  id:              uuid('id').primaryKey().defaultRandom(),
  taskId:          uuid('task_id').references(() => tasks.id),
  sourceMessageId: text('source_message_id').references(() => messages.id),
  trader:          text('trader').notNull(),
  symbol:          text('symbol').notNull(),
  direction:       directionEnum('direction').notNull(),
  strategy:        text('strategy').notNull(),         // CDS, PDS, CALL, PUT, STOCK, etc.
  legs:            jsonb('legs').$type<TradeLeg[]>().notNull(),
  status:          tradeStatusEnum('status').notNull().default('OPEN'),
  entryPrice:      numeric('entry_price'),             // net debit/credit
  exitPrice:       numeric('exit_price'),
  quantity:        integer('quantity').default(1),
  pnl:             numeric('pnl'),
  openedAt:        timestamp('opened_at', { withTimezone: true }),
  closedAt:        timestamp('closed_at', { withTimezone: true }),
  closeMessageId:  text('close_message_id').references(() => messages.id),
  isBacktest:      boolean('is_backtest').default(false),
  metadata:        jsonb('metadata').$type<TradeMetadata>().default({}),
}, (table) => [
  index('idx_trades_trader').on(table.trader),
  index('idx_trades_symbol').on(table.symbol),
  index('idx_trades_status').on(table.status),
]);

// ─── Tracked Traders ─────────────────────────────────

export const trackedTraders = pgTable('tracked_traders', {
  name:            text('name').primaryKey(),
  enabled:         boolean('enabled').default(true),
  strategies:      jsonb('strategies').$type<string[]>().default([]),
  maxAllocation:   numeric('max_allocation'),
  maxDailyAlloc:   numeric('max_daily_allocation'),
  notes:           text('notes'),
});

// ─── Supporting Types ────────────────────────────────

export type TextSegment = {
  type: 'text' | 'symbol' | 'price' | 'strike' | 'expiry';
  content: string;
};

export type DetectedStrategy = {
  strategy: string;        // CDS, PDS, CALL, PUT, STOCK, etc.
  confidence: number;      // 0-1
  strikes?: number[];
  expiry?: string;
  price?: number;
  quantity?: number;
};

export type TradeLeg = {
  symbol: string;          // e.g. AAPL 250117C00172500 (OCC format)
  strike: number;
  expiry: string;          // ISO date
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

// ─── Inferred Types (use these everywhere) ───────────

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskStep = typeof taskSteps.$inferSelect;
export type Trade = typeof trades.$inferSelect;
export type TrackedTrader = typeof trackedTraders.$inferSelect;
```

These inferred types flow everywhere — into your agent tools, your API responses, and eventually your React dashboard. No manual type definitions to keep in sync.

---

## Message Landscape → Processing Pipeline

Your data shows the breakdown clearly. Here's how each category maps to the pipeline:

```
23,573 total messages
│
├── 16,739 (71%) No trade badge ──────────────────→ STORE in messages table.
│   Greetings, analysis, questions, images.          No task created. Done.
│   Detection: absence of Long/Short/Exit badge.
│
└── 6,834 (29%) Has trade badge
    │
    ├── ~3,500 (15%) Clean regex match ───────────→ STORE + create task.
    │   Simple entries: "Long CSCO 73.41"            Task type: EXECUTE_TRADE
    │   Simple exits: "Exit META 625 call 9.10"      Assigned to: agent (fast path)
    │   Direction from badge class, ticker from       Agent confirms + executes.
    │   data-symbol, price from trailing number.      Typically 2-3 tool calls.
    │
    ├── ~826 (3.5%) Options with varied notation ─→ STORE + create task.
    │   "AAPL $232.5 Calls - 9/12 for $8.15"        Task type: REVIEW_MESSAGE
    │   "DVN 12/5 37c for $1.05 day trade"           Assigned to: agent (deep path)
    │   "COIN 21Nov25 p 310/305 for $1.88"           Agent interprets format,
    │   Regex extracts what it can, flags low         resolves strikes/expiry,
    │   confidence.                                   calls get_options_chain to
    │                                                 verify, then decides.
    │                                                 Typically 5-7 tool calls.
    │
    ├── ~227 (1%) Multiple trades in one msg ─────→ STORE + create N tasks.
    │   "Exit Short ANET + Exit Short V"             One task per detected trade.
    │   Split into sub-messages first.               Each processed independently.
    │
    ├── ~174 (0.7%) Partial exits / adjustments ──→ STORE + create task.
    │   "UNH took half off for +$7"                  Task type: REVIEW_MESSAGE
    │   "MKC adding to short at 66.14"               Agent checks open positions,
    │                                                 determines partial qty.
    │
    ├── ~163 (0.7%) Paper trades ─────────────────→ STORE (is_paper_trade=true).
    │   "(paper)" anywhere in message.                No task created. Skip.
    │   Regex handles this deterministically.
    │
    ├── ~129 (0.5%) No symbol link ───────────────→ STORE + create task.
    │   Plain text tickers: "Long SOUN $14.95"       Regex attempts plain-text
    │   $INBX, RKLB@57.37                           symbol extraction.
    │                                                 Agent verifies ticker is real.
    │
    ├── ~63 (0.3%) Misleading badges ─────────────→ STORE + create task.
    │   Long+Short = time spread                     Task type: REVIEW_MESSAGE
    │   "Long" badge on a short put sale             Agent must interpret.
    │
    └── ~??? Unbadged trades in prose ────────────→ STORE. Missed unless we
        "long RGTI 40/45 bds for 2.0$"              add a lightweight LLM
        "Bought back the short put on V"             classifier pass. Phase 2.
```

### Parser Output Shape

Every message goes through the same parser pipeline. The output is a `MessageClassification`:

```typescript
// src/parsing/classify.ts
import { type DetectedStrategy, type TextSegment } from '@/db/schema';

export type MessageClassification = {
  cleanText: string;
  textSegments: TextSegment[];
  badges: string[];
  symbols: string[];
  actionHint: 'OPEN' | 'CLOSE' | 'ADJUST' | null;
  directionHint: 'LONG' | 'SHORT' | null;
  detectedStrategies: DetectedStrategy[];
  isPaperTrade: boolean;
  hasMultipleTrades: boolean;
  confidence: number;           // 0-1, how sure regex is about the parse
  needsAgent: boolean;          // true if confidence < threshold or ambiguous
  skipReason?: string;          // "paper_trade" | "no_badge" | "not_tracked" etc.
};
```

The `confidence` field is key. Clean messages like `Long CSCO 73.41` get confidence 0.95. Messy ones like `HPQ time spread from last week got in for .12` get confidence 0.2 and `needsAgent: true`. This controls whether the agent does a fast confirmation pass or a deep interpretation pass.

---

## Recognized Strategies

```typescript
// src/config/strategies.ts
export const STRATEGIES = {
  CDS: {
    name: 'Call Debit Spread',
    defaultExpiry: 'friday',     // "this friday" unless stated
    keywords: ['CDS', 'call debit spread', 'call spread', 'cds'],
    regex: /(\w+)\s+CDS\s+(\d+\.?\d*)\s*\/\s*(\d+\.?\d*)/i,
    // Group 1: symbol, Group 2: lower strike, Group 3: upper strike
    maxWidth: 10,
    defaultQty: 1,
  },
  PDS: {
    name: 'Put Debit Spread',
    defaultExpiry: 'friday',
    keywords: ['PDS', 'put debit spread', 'put spread', 'pds'],
    regex: /(\w+)\s+PDS\s+(\d+\.?\d*)\s*\/\s*(\d+\.?\d*)/i,
    maxWidth: 10,
    defaultQty: 1,
  },
  CALL: {
    name: 'Long Call',
    keywords: ['call', 'calls', 'c'],
    // Matches: "AAPL 232.5 calls", "AAPL $232.5C", "AAPL 232.5c"
    regex: /(\w+)\s+\$?(\d+\.?\d*)\s*(?:calls?|c)\b/i,
    requiresStrike: true,
  },
  PUT: {
    name: 'Long Put',
    keywords: ['put', 'puts', 'p'],
    regex: /(\w+)\s+\$?(\d+\.?\d*)\s*(?:puts?|p)\b/i,
    requiresStrike: true,
  },
  BPS: {
    name: 'Bull Put Spread',
    keywords: ['BPS', 'bull put', 'put credit spread', 'PCS'],
    isCredit: true,
  },
  BCS: {
    name: 'Bear Call Spread',
    keywords: ['BCS', 'bear call', 'call credit spread'],
    isCredit: true,
  },
  STOCK: {
    name: 'Equity / Shares',
    keywords: ['shares', 'stock'],
    // Detected by: badge + symbol + price, NO options keywords
    requiresShares: true,
  },
  TIME_SPREAD: {
    name: 'Time / Calendar Spread',
    keywords: ['time spread', 'calendar spread', 'calendar'],
    // Detected by: Long+Short badges together, or "time spread" in text
    multiLeg: true,
  },
  BUTTERFLY: {
    name: 'Butterfly',
    keywords: ['butterfly', 'fly'],
    regex: /(\w+)\s+(?:butterfly|fly)\s+(\d+\.?\d*)\s*\/\s*(\d+\.?\d*)\s*\/\s*(\d+\.?\d*)/i,
    multiLeg: true,
  },
  IRON_CONDOR: {
    name: 'Iron Condor',
    keywords: ['iron condor', 'IC', 'condor'],
    multiLeg: true,
  },
} as const;
```

---

## Agent Architecture (Claude Agent SDK — TypeScript)

### System Prompt

```typescript
// src/agent/system-prompt.ts
export const SYSTEM_PROMPT = `You are a trade-copy agent monitoring a live trading chat room.

You review incoming messages from tracked traders and decide whether to mirror
their trades. You have tools for market data, position management, and execution.

## Your Process
1. CLASSIFY: Is this a trade entry, exit, adjustment, or noise?
2. IDENTIFY: What strategy? CDS, PDS, naked call, stock, etc.
3. VALIDATE: Use get_quote / get_options_chain to check current prices.
   If the market has moved significantly since the message, skip.
4. CHECK RISK: Use check_risk_limits before any execution.
5. DECIDE: Execute, skip (with reason), or escalate to human review.

## Strategy Knowledge
- CDS (Call Debit Spread): Expires FRIDAY of current week unless stated.
  "LONG AAPL CDS 172.5/177.5" → Buy 172.5C, Sell 177.5C, this Friday.
- PDS (Put Debit Spread): Same expiry convention.
  "LONG SPY PDS 450/445" → Buy 450P, Sell 445P, this Friday.
- When a message has both Long+Short badges → likely a time spread or calendar,
  NOT contradictory. Read the text carefully.
- "Exit Long ATEC" → close the matching open position.
- "Exit META 625 call 9.10" → 9.10 is the TRADER'S fill price, not our limit.
  Get a fresh quote for our order.

## Ambiguous Messages You'll See
- Varied option notation: "AAPL $232.5 Calls - 9/12 for $8.15",
  "DVN 12/5 37c for $1.05", "COIN 21Nov25 p 310/305 for $1.88"
  → Parse the components: symbol, strike(s), expiry, type, price, quantity.
- Partial exits: "took half off", "scaling out" → check current position size,
  close the appropriate fraction.
- Badge on a put sale: "Long" badge but text says "Sold Nov $28 put" →
  this is a SHORT PUT (bullish), not a long position. Badge reflects sentiment.
- No symbol link: ticker in plain text → verify it's a real ticker with get_quote.

## Rules
- Only copy traders in the whitelist. Ignore everyone else.
- Skip paper trades (tagged with "(paper)").
- If unsure, return MANUAL_REVIEW — don't guess on real money.
- Always explain your reasoning. Your steps are audited.
- If an exit arrives but we have no matching open position, log it and skip.
- Respect max allocation per trader and daily loss limits.

Respond with JSON:
{
  "decision": "EXECUTE" | "SKIP" | "MANUAL_REVIEW",
  "reasoning": "...",
  "classification": {
    "isTradeAction": boolean,
    "action": "OPEN" | "CLOSE" | "ADJUST" | null,
    "direction": "LONG" | "SHORT" | null,
    "strategy": "CDS" | "PDS" | "CALL" | ... | null,
    "symbol": string | null,
    "strikes": number[] | null,
    "expiry": string | null,
    "price": number | null,
    "quantity": number | null,
    "isPartialExit": boolean
  },
  "trade": { ... } | null
}`;
```

### Agent Definition

```typescript
// src/agent/trade-agent.ts
import {
  tool, createSdkMcpServer, query,
  type ClaudeAgentOptions
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { SYSTEM_PROMPT } from './system-prompt';
import { type TaskContext, type TaskResult } from '@/db/schema';

// ── Tool Definitions ──

const getMessageContext = tool(
  'get_message_context',
  'Get surrounding messages from the same author within a time window to understand context.',
  {
    messageId: z.string().describe('The message ID to get context for'),
    windowMinutes: z.number().default(30).describe('Minutes before/after to look'),
  },
  async (args) => {
    const messages = await db
      .select()
      .from(schema.messages)
      .where(/* author match + time window */)
      .orderBy(schema.messages.timestamp);
    return { content: [{ type: 'text', text: JSON.stringify(messages) }] };
  }
);

const getTraderHistory = tool(
  'get_trader_history',
  'Get recent trade history + win rate for a trader.',
  {
    trader: z.string(),
    limit: z.number().default(20),
  },
  async (args) => {
    const recentTrades = await db
      .select()
      .from(schema.trades)
      .where(eq(schema.trades.trader, args.trader))
      .orderBy(desc(schema.trades.openedAt))
      .limit(args.limit);

    // Aggregate stats
    const stats = await db
      .select({
        total: count(),
        wins: count(sql`CASE WHEN pnl > 0 THEN 1 END`),
        avgPnl: avg(schema.trades.pnl),
      })
      .from(schema.trades)
      .where(
        and(
          eq(schema.trades.trader, args.trader),
          eq(schema.trades.status, 'CLOSED'),
        )
      );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ recentTrades, stats: stats[0] }),
      }],
    };
  }
);

const getQuote = tool(
  'get_quote',
  'Get current bid/ask/last for a stock or ETF.',
  { symbol: z.string() },
  async (args) => {
    const quote = await broker.getQuote(args.symbol);
    return { content: [{ type: 'text', text: JSON.stringify(quote) }] };
  }
);

const getOptionsChain = tool(
  'get_options_chain',
  'Get options chain filtered by expiry and type. Returns strikes, bid/ask, IV, greeks.',
  {
    symbol: z.string(),
    expiry: z.string().describe('ISO date, e.g. 2025-11-28'),
    optionType: z.enum(['CALL', 'PUT']),
  },
  async (args) => {
    const chain = await broker.getOptionsChain(args.symbol, args.expiry, args.optionType);
    return { content: [{ type: 'text', text: JSON.stringify(chain) }] };
  }
);

const getSpreadPrice = tool(
  'get_spread_price',
  'Get current net debit/credit for a multi-leg spread.',
  {
    symbol: z.string(),
    strategy: z.string().describe('CDS, PDS, BPS, BCS, etc.'),
    strikes: z.array(z.number()),
    expiry: z.string(),
  },
  async (args) => {
    const price = await broker.getSpreadPrice(args.symbol, args.strategy, args.strikes, args.expiry);
    return { content: [{ type: 'text', text: JSON.stringify(price) }] };
  }
);

const getOpenPositions = tool(
  'get_open_positions',
  'Get all currently open positions, optionally filtered by symbol or trader.',
  {
    symbol: z.string().optional(),
    trader: z.string().optional(),
  },
  async (args) => {
    let q = db.select().from(schema.trades).where(eq(schema.trades.status, 'OPEN'));
    if (args.symbol) q = q.where(eq(schema.trades.symbol, args.symbol));
    if (args.trader) q = q.where(eq(schema.trades.trader, args.trader));
    const positions = await q;
    return { content: [{ type: 'text', text: JSON.stringify(positions) }] };
  }
);

const checkRiskLimits = tool(
  'check_risk_limits',
  'Check if a proposed trade would exceed risk limits (daily loss, position size, exposure).',
  {
    symbol: z.string(),
    maxRisk: z.number().describe('Max dollar risk for this trade'),
    strategy: z.string(),
    trader: z.string(),
  },
  async (args) => {
    const traderConfig = await db
      .select()
      .from(schema.trackedTraders)
      .where(eq(schema.trackedTraders.name, args.trader));

    const todayPnl = await db
      .select({ total: sql<number>`COALESCE(SUM(pnl), 0)` })
      .from(schema.trades)
      .where(
        and(
          eq(schema.trades.trader, args.trader),
          gte(schema.trades.openedAt, sql`CURRENT_DATE`),
        )
      );

    const openExposure = await db
      .select({ count: count() })
      .from(schema.trades)
      .where(
        and(
          eq(schema.trades.symbol, args.symbol),
          eq(schema.trades.status, 'OPEN'),
        )
      );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          allowed: true, // computed from the checks
          traderDailyPnl: todayPnl[0]?.total,
          openPositionsOnSymbol: openExposure[0]?.count,
          traderMaxAllocation: traderConfig[0]?.maxAllocation,
        }),
      }],
    };
  }
);

const placeOrder = tool(
  'place_order',
  'Place a trade order. Supports stocks and multi-leg options.',
  {
    symbol: z.string(),
    strategy: z.string(),
    direction: z.enum(['LONG', 'SHORT']),
    legs: z.array(z.object({
      strike: z.number(),
      expiry: z.string(),
      type: z.enum(['CALL', 'PUT', 'STOCK']),
      action: z.enum(['BUY', 'SELL']),
      quantity: z.number(),
    })),
    orderType: z.enum(['MARKET', 'LIMIT']).default('LIMIT'),
    limitPrice: z.number().optional(),
  },
  async (args) => {
    const order = await broker.placeOrder(args);
    return { content: [{ type: 'text', text: JSON.stringify(order) }] };
  }
);

// ── Server + Agent Runner ──

function buildToolsServer(mode: 'live' | 'backtest' = 'live') {
  // In backtest mode, the broker module is swapped for sim implementations.
  // The tool definitions above call broker.*, and broker is set at startup.
  return createSdkMcpServer({
    name: 'trade-tools',
    version: '1.0.0',
    tools: [
      getMessageContext,
      getTraderHistory,
      getQuote,
      getOptionsChain,
      getSpreadPrice,
      getOpenPositions,
      checkRiskLimits,
      placeOrder,
    ],
  });
}

export async function runAgent(
  taskContext: TaskContext,
  mode: 'live' | 'backtest' = 'live'
): Promise<{ steps: any[]; result: TaskResult | null }> {

  const server = buildToolsServer(mode);

  const prompt = `Review this trade message and decide what to do.

Message ID: ${taskContext.messageId}
Author: ${taskContext.author}
Text: ${taskContext.cleanText}
Badges: ${JSON.stringify(taskContext.badges)}
Symbols: ${JSON.stringify(taskContext.symbols)}
Action Hint: ${taskContext.actionHint}
Direction Hint: ${taskContext.directionHint}
Detected Strategies: ${JSON.stringify(taskContext.detectedStrategies)}
Regex Confidence: ${taskContext.confidence ?? 'N/A'}

Use your tools to gather context, validate the trade, and make a decision.`;

  const steps: any[] = [];
  let result: TaskResult | null = null;

  for await (const message of query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model: 'claude-sonnet-4-5-20250929',
      mcpServers: { 'trade-tools': server },
      allowedTools: [
        'mcp__trade-tools__get_message_context',
        'mcp__trade-tools__get_trader_history',
        'mcp__trade-tools__get_quote',
        'mcp__trade-tools__get_options_chain',
        'mcp__trade-tools__get_spread_price',
        'mcp__trade-tools__get_open_positions',
        'mcp__trade-tools__check_risk_limits',
        'mcp__trade-tools__place_order',
      ],
      maxTurns: 10,
    },
  })) {
    // Record tool calls and text for audit trail
    if (message.type === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool_use') {
          steps.push({ tool: block.name, input: block.input });
        }
        if (block.type === 'text') {
          // Parse the final JSON response
          try {
            result = JSON.parse(block.text);
          } catch {
            // Might be intermediate reasoning, that's fine
            steps.push({ reasoning: block.text });
          }
        }
      }
    }
  }

  return { steps, result };
}
```

---

## TradeStation Broker Module

```typescript
// src/broker/tradestation.ts
import { type Quote, type OptionsChain, type OrderResult } from './types';
import { getAccessToken } from './auth';

const BASE = 'https://api.tradestation.com/v3';

async function ts(path: string, options?: RequestInit) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) throw new Error(`TradeStation ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function getQuote(symbol: string): Promise<Quote> {
  const data = await ts(`/marketdata/quotes/${symbol}`);
  const q = data.Quotes[0];
  return {
    symbol,
    bid: q.Bid,
    ask: q.Ask,
    last: q.Last,
    volume: q.Volume,
    timestamp: q.TradeTime,
  };
}

export async function getOptionsChain(
  symbol: string,
  expiry: string,
  optionType: 'CALL' | 'PUT'
): Promise<OptionsChain> {
  const data = await ts(
    `/marketdata/options/chains/${symbol}?expiration=${expiry}&optionType=${optionType}`
  );
  return {
    symbol,
    expiry,
    optionType,
    strikes: data.Options.map((o: any) => ({
      strike: o.StrikePrice,
      bid: o.Bid,
      ask: o.Ask,
      last: o.Last,
      iv: o.ImpliedVolatility,
      delta: o.Delta,
      gamma: o.Gamma,
      theta: o.Theta,
      openInterest: o.OpenInterest,
    })),
  };
}

export async function getSpreadPrice(
  symbol: string,
  strategy: string,
  strikes: number[],
  expiry: string
): Promise<{ netDebit: number; netAsk: number; netBid: number }> {
  // TradeStation doesn't have a single spread-price endpoint.
  // Get individual legs and compute.
  const legs = await Promise.all(
    strikes.map(async (strike) => {
      const chain = await getOptionsChain(
        symbol,
        expiry,
        strategy.includes('PUT') || strategy === 'PDS' ? 'PUT' : 'CALL'
      );
      return chain.strikes.find((s) => s.strike === strike);
    })
  );

  // CDS: buy lower, sell upper
  // PDS: buy upper, sell lower
  // (simplified — agent can verify)
  const [buy, sell] = strategy === 'PDS' ? [legs[0], legs[1]] : [legs[0], legs[1]];

  return {
    netDebit: (buy?.ask ?? 0) - (sell?.bid ?? 0),
    netBid: (buy?.bid ?? 0) - (sell?.ask ?? 0),
    netAsk: (buy?.ask ?? 0) - (sell?.bid ?? 0),
  };
}

export async function placeOrder(params: {
  symbol: string;
  strategy: string;
  direction: 'LONG' | 'SHORT';
  legs: Array<{
    strike: number;
    expiry: string;
    type: 'CALL' | 'PUT' | 'STOCK';
    action: 'BUY' | 'SELL';
    quantity: number;
  }>;
  orderType: 'MARKET' | 'LIMIT';
  limitPrice?: number;
}): Promise<OrderResult> {
  // Build TradeStation order payload
  const tsLegs = params.legs.map((leg) => ({
    Symbol: leg.type === 'STOCK'
      ? params.symbol
      : buildOccSymbol(params.symbol, leg.expiry, leg.type, leg.strike),
    Quantity: String(leg.quantity),
    TradeAction: leg.action === 'BUY' ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN',
  }));

  const body = {
    AccountID: process.env.TS_ACCOUNT_ID,
    Symbol: params.symbol,
    OrderType: params.orderType === 'LIMIT' ? 'Limit' : 'Market',
    LimitPrice: params.limitPrice ? String(params.limitPrice) : undefined,
    Legs: tsLegs,
    Duration: 'DAY',
  };

  const data = await ts('/orderexecution/orders', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return {
    orderId: data.Orders?.[0]?.OrderID,
    status: data.Orders?.[0]?.StatusDescription,
    filledPrice: data.Orders?.[0]?.FilledPrice,
  };
}

// Helper: build OCC-format option symbol
function buildOccSymbol(
  underlying: string,
  expiry: string, // ISO date
  type: 'CALL' | 'PUT',
  strike: number
): string {
  const padded = underlying.padEnd(6, ' ');
  const d = new Date(expiry);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const t = type === 'CALL' ? 'C' : 'P';
  const s = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${padded}${yy}${mm}${dd}${t}${s}`;
}
```

```typescript
// src/broker/types.ts
// These types are broker-agnostic. tradestation.ts returns them,
// and a future schwab.ts or ibkr.ts would return the same shapes.

export type Quote = {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  timestamp: string;
};

export type OptionsStrike = {
  strike: number;
  bid: number;
  ask: number;
  last: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  openInterest: number;
};

export type OptionsChain = {
  symbol: string;
  expiry: string;
  optionType: 'CALL' | 'PUT';
  strikes: OptionsStrike[];
};

export type OrderResult = {
  orderId: string;
  status: string;
  filledPrice?: number;
};
```

---

## Task Pipeline

```
┌─────────────────┐
│ SignalR Message   │
│ (signalr.ts)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     Deterministic. No LLM.
│ Parse + Classify │     HTML strip, badges, symbols,
│ (parsing/*.ts)   │     strategy regex, paper trade check,
│                  │     multi-trade split, confidence score.
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Store Message    │     Every message saved regardless.
│ (db insert)      │     is_paper_trade, has_multiple_trades set.
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Task Factory     │     Author in tracked_traders?
│ (factory.ts)     │       No  → done (message stored, no task)
│                  │       Yes → create task(s)
│                  │     Paper trade? → skip
│                  │     Multi-trade? → split into N tasks
│                  │     High confidence regex? → EXECUTE_TRADE task
│                  │     Low confidence? → REVIEW_MESSAGE task
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Task Runner      │     Polls PENDING tasks.
│ (runner.ts)      │     Dispatches to agent.
│                  │     Records steps + result.
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│                    AGENT LOOP                            │
│                                                          │
│ HIGH CONFIDENCE PATH (regex got it, agent confirms):     │
│   Step 1: get_quote(symbol) — still tradeable?           │
│   Step 2: check_risk_limits — within limits?             │
│   Step 3: EXECUTE or SKIP                                │
│   ~2-3 tool calls, ~$0.003-0.005 per message             │
│                                                          │
│ LOW CONFIDENCE PATH (agent interprets):                  │
│   Step 1: get_message_context — surrounding messages     │
│   Step 2: get_trader_history — what do they usually do?  │
│   Step 3: get_quote / get_options_chain — resolve strikes│
│   Step 4: get_spread_price — what would it cost?         │
│   Step 5: check_risk_limits                              │
│   Step 6: EXECUTE / SKIP / MANUAL_REVIEW                 │
│   ~5-7 tool calls, ~$0.01-0.02 per message               │
│                                                          │
│ EXIT PATH:                                               │
│   Step 1: get_open_positions(symbol, trader)             │
│   Step 2: No position? → SKIP. Has position? → close it │
│   Step 3: place_order (closing)                          │
│   ~2-3 tool calls                                        │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────┐
│ Record Results                   │
│ task_steps: each tool call       │
│ tasks.result: final JSON         │
│ trades: if order placed          │
│ tasks.status → COMPLETED         │
│ WebSocket push → dashboard       │
└─────────────────────────────────┘
```

---

## Backtesting

Same agent, swapped tools. The module-level `broker` import is replaced with sim implementations.

```typescript
// src/backtest/runner.ts
import { SimBroker } from './sim-broker';
import { SimClock } from './clock';
import { runAgent } from '@/agent/trade-agent';
import { db, schema } from '@/db/client';

export async function runBacktest(opts: {
  startDate: string;
  endDate: string;
  traders: string[];
}) {
  const clock = new SimClock(new Date(opts.startDate));
  const simBroker = new SimBroker(clock); // serves historical data at clock.now()

  // Swap the broker module for sim
  setBroker(simBroker);

  const messages = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        gte(schema.messages.timestamp, opts.startDate),
        lte(schema.messages.timestamp, opts.endDate),
        inArray(schema.messages.author, opts.traders),
      )
    )
    .orderBy(asc(schema.messages.timestamp));

  for (const msg of messages) {
    // Advance sim clock to message time
    clock.setNow(new Date(msg.timestamp));

    // Create task context (same as live)
    const taskContext = {
      messageId: msg.id,
      author: msg.author,
      cleanText: msg.cleanText,
      badges: msg.badges,
      symbols: msg.symbols,
      actionHint: msg.actionHint,
      directionHint: msg.directionHint,
      detectedStrategies: msg.detectedStrategies,
    };

    // Run agent — identical code path to live
    const { steps, result } = await runAgent(taskContext, 'backtest');

    // Record (tagged is_backtest = true)
    await recordBacktestResult(msg, steps, result);
  }

  // Generate report
  return generateReport(opts);
}
```

```typescript
// src/backtest/sim-broker.ts
// Implements the same interface as broker/tradestation.ts
// but returns historical data from your stored quotes.

import type { Quote, OptionsChain, OrderResult } from '@/broker/types';
import type { SimClock } from './clock';

export class SimBroker {
  private clock: SimClock;
  private portfolio: Map<string, { legs: any[]; entry: number }> = new Map();

  constructor(clock: SimClock) {
    this.clock = clock;
  }

  async getQuote(symbol: string): Promise<Quote> {
    // Look up historical quote at this.clock.now()
    const row = await db.query(/* historical_quotes table */);
    return { symbol, bid: row.bid, ask: row.ask, last: row.last, ... };
  }

  async getOptionsChain(
    symbol: string, expiry: string, optionType: 'CALL' | 'PUT'
  ): Promise<OptionsChain> {
    // Historical options data at clock.now()
    // This is the expensive dataset to acquire.
    // Options: CBOE DataShop, OptionMetrics, or record your own going forward.
  }

  async placeOrder(params: any): Promise<OrderResult> {
    // Simulate fill at current bid/ask with configurable slippage
    const quote = await this.getQuote(params.symbol);
    const slippage = 0.02; // configurable
    const fillPrice = params.direction === 'LONG'
      ? quote.ask * (1 + slippage)
      : quote.bid * (1 - slippage);

    this.portfolio.set(/* track position */);

    return {
      orderId: `SIM-${Date.now()}`,
      status: 'FILLED',
      filledPrice: fillPrice,
    };
  }
}
```

---

## API Layer (for Dashboard)

```typescript
// src/api/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { db, schema } from '@/db/client';

const app = new Hono();
app.use('*', cors());

// ── Messages ──
app.get('/api/messages', async (c) => {
  const { author, limit = '50', offset = '0' } = c.req.query();
  let q = db.select().from(schema.messages)
    .orderBy(desc(schema.messages.timestamp))
    .limit(Number(limit)).offset(Number(offset));
  if (author) q = q.where(eq(schema.messages.author, author));
  return c.json(await q);
});

// ── Trades ──
app.get('/api/trades', async (c) => {
  const { status, trader } = c.req.query();
  let q = db.select().from(schema.trades)
    .orderBy(desc(schema.trades.openedAt));
  if (status) q = q.where(eq(schema.trades.status, status));
  if (trader) q = q.where(eq(schema.trades.trader, trader));
  return c.json(await q);
});

app.get('/api/trades/:id', async (c) => {
  const trade = await db.select().from(schema.trades)
    .where(eq(schema.trades.id, c.req.param('id')));
  return c.json(trade[0]);
});

// ── Audit Trail ──
app.get('/api/tasks/:id/steps', async (c) => {
  const steps = await db.select().from(schema.taskSteps)
    .where(eq(schema.taskSteps.taskId, c.req.param('id')))
    .orderBy(asc(schema.taskSteps.stepNumber));
  return c.json(steps);
});

// ── Manual Actions (dashboard → system) ──
app.post('/api/trades/:id/exit', async (c) => {
  // Human clicks "Exit" on dashboard → closes position via broker
  const trade = await db.select().from(schema.trades)
    .where(eq(schema.trades.id, c.req.param('id')));
  if (!trade[0] || trade[0].status !== 'OPEN') {
    return c.json({ error: 'Trade not open' }, 400);
  }
  const result = await broker.closePosition(trade[0]);
  await db.update(schema.trades)
    .set({ status: 'CLOSED', exitPrice: result.filledPrice, closedAt: new Date() })
    .where(eq(schema.trades.id, c.req.param('id')));
  return c.json(result);
});

app.post('/api/tasks/:id/skip', async (c) => {
  // Human reviews MANUAL_REVIEW task and decides to skip
  await db.update(schema.tasks)
    .set({ status: 'SKIPPED', completedAt: new Date() })
    .where(eq(schema.tasks.id, c.req.param('id')));
  return c.json({ ok: true });
});

// ── Dashboard Stats ──
app.get('/api/stats', async (c) => {
  const [openTrades, todayPnl, pendingTasks] = await Promise.all([
    db.select({ count: count() }).from(schema.trades)
      .where(eq(schema.trades.status, 'OPEN')),
    db.select({ total: sql<number>`COALESCE(SUM(pnl), 0)` }).from(schema.trades)
      .where(gte(schema.trades.closedAt, sql`CURRENT_DATE`)),
    db.select({ count: count() }).from(schema.tasks)
      .where(eq(schema.tasks.status, 'PENDING')),
  ]);
  return c.json({
    openTrades: openTrades[0]?.count,
    todayPnl: todayPnl[0]?.total,
    pendingTasks: pendingTasks[0]?.count,
  });
});

export default app;
```

---

## Dashboard Screens (Future React App)

When you build the dashboard, it consumes the API above. Key views:

```
┌─────────────────────────────────────────────────────────┐
│ DASHBOARD                                    [Live ●]   │
├──────────┬──────────────────────────────────────────────┤
│          │                                              │
│ Sidebar  │  OPEN POSITIONS (3)                          │
│          │  ┌─────┬────────┬───────┬────────┬────────┐  │
│ Overview │  │ Sym │ Strat  │ Entry │ Curr   │ Action │  │
│ Trades   │  ├─────┼────────┼───────┼────────┼────────┤  │
│ Messages │  │ AAPL│ CDS    │ $2.10 │ $2.45  │ [EXIT] │  │
│ Audit    │  │ META│ Call   │ $9.10 │ $11.20 │ [EXIT] │  │
│ Backtest │  │ CSCO│ Stock  │$73.41 │ $74.02 │ [EXIT] │  │
│ Settings │  └─────┴────────┴───────┴────────┴────────┘  │
│          │                                              │
│          │  PENDING REVIEW (2)                          │
│          │  ┌───────────────────────────────┬────────┐  │
│          │  │ "HPQ time spread from last    │ [VIEW] │  │
│          │  │  week got in for .12..." —Pete │ [SKIP] │  │
│          │  │ Agent: MANUAL_REVIEW (0.3 conf)│        │  │
│          │  ├───────────────────────────────┼────────┤  │
│          │  │ "long RGTI 40/45 bds for 2.0$"│ [VIEW] │  │
│          │  │ —Arethra (unbadged trade)      │ [SKIP] │  │
│          │  └───────────────────────────────┴────────┘  │
│          │                                              │
│          │  RECENT ACTIVITY                             │
│          │  14:32 ✅ Executed CDS AAPL 172.5/177.5     │
│          │  14:28 ⏭ Skipped: paper trade (SOUN)        │
│          │  14:15 ✅ Closed META 625 call (+$2.10)     │
│          │  13:58 ⚠️ Manual review: HPQ time spread    │
│          │  13:45 ⏭ Skipped: not tracked (JohnD)      │
└──────────┴──────────────────────────────────────────────┘
```

**Audit Drill-Down** (click any trade):

```
┌─────────────────────────────────────────────────────────┐
│ TRADE AUDIT: AAPL CDS 172.5/177.5                       │
├─────────────────────────────────────────────────────────┤
│ Source Message (Arethra, 14:31:42):                     │
│ "Long AAPL CDS 172.5/177.5"                            │
│                                                         │
│ Agent Steps:                                            │
│ 1. get_quote("AAPL")                                   │
│    → { bid: 174.20, ask: 174.25, last: 174.22 }        │
│    Reasoning: "AAPL at 174.22, within range of the     │
│    spread strikes. Message is 48 seconds old."          │
│                                                         │
│ 2. get_options_chain("AAPL", "2025-11-28", "CALL")     │
│    → 172.5C: 3.20/3.35, 177.5C: 1.10/1.20             │
│    Reasoning: "CDS would cost ~$2.15 debit. Reasonable │
│    for a $5-wide spread."                               │
│                                                         │
│ 3. check_risk_limits("AAPL", 215, "CDS", "Arethra")   │
│    → { allowed: true, dailyPnl: +$142 }                │
│    Reasoning: "Within daily limits. Proceeding."        │
│                                                         │
│ 4. place_order(...)                                     │
│    → { orderId: "TS-938271", status: "FILLED",          │
│         filledPrice: 2.18 }                             │
│                                                         │
│ Decision: EXECUTE                                       │
│ Total agent cost: $0.004                                │
│ Latency: 3.2s from message to fill                      │
└─────────────────────────────────────────────────────────┘
```

---

## Cost Estimates

Based on your message landscape (~23.5K messages in the dataset):

| Category | Messages | Agent Runs | Est. Cost/Run | Total |
|----------|----------|------------|---------------|-------|
| No badge (skip, no agent) | 16,739 | 0 | $0 | $0 |
| Paper trades (skip) | 163 | 0 | $0 | $0 |
| Clean regex, agent confirms | ~3,500 | ~3,500 | $0.004 | ~$14 |
| Ambiguous, agent interprets | ~1,200 | ~1,200 | $0.015 | ~$18 |
| Not tracked trader (skip) | ~1,900 | 0 | $0 | $0 |
| **Total** | **23,573** | **~4,700** | | **~$32** |

For daily live usage (probably ~200-400 messages/day in an active room), expect $0.50-$2/day in agent costs.

---

## Implementation Order

**Phase 1: Foundation (week 1)**
- Drizzle schema + migrations
- Message ingestion (Playwright + SignalR)
- Deterministic parsers (HTML, badges, symbols, strategy regex)
- Store everything in messages table

**Phase 2: Agent Core (week 2)**
- Claude Agent SDK setup with tools
- Task factory + runner
- TradeStation broker module (quotes first, orders later)
- Step recording

**Phase 3: Execution + Risk (week 3)**
- Order placement through TradeStation
- Risk limits enforcement
- Position tracking (open/close matching)
- Exit message handling

**Phase 4: Backtest (week 4)**
- Sim broker + clock
- Historical data loading
- Replay runner
- Report generation

**Phase 5: Dashboard (week 5-6)**
- Hono API
- React app (positions, messages, audit, manual actions)
- WebSocket for real-time updates

**Phase 6: Refinement (ongoing)**
- Unbadged trade detection (lightweight classifier)
- Partial exit handling
- Multi-trade message splitting
- Agent prompt tuning based on audit trail review