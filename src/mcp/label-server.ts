#!/usr/bin/env node

/**
 * MCP Server for label tools — exposes the label agent's tools to Claude Code.
 *
 * Usage:
 *   npx tsx src/mcp/label-server.ts
 *
 * Add to .claude/settings.json:
 *   "mcpServers": {
 *     "label-tools": {
 *       "command": "npx",
 *       "args": ["tsx", "src/mcp/label-server.ts"]
 *     }
 *   }
 */

import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { z } from 'zod';
import { zPct01 } from '../lib/zod-financial.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { db, schema } from '../db/client.js';
import { sql, eq, and, like, lte, gte } from 'drizzle-orm';
import { HistoricalDataStore } from '../agent/historical-data-store.js';
import { LabelResultSchema } from '../agent/schemas.js';
import { reconstructPositions } from '../lib/position-reconstruction.js';
import type { LabelRow } from '../lib/position-reconstruction.js';

// ─── DB helpers ──────────────────────────────────────

type MessageRow = {
  id: string;
  author: string;
  cleanText: string;
  badges: string[];
  symbols: string[];
  timestamp: string;
  actionHint: string | null;
  directionHint: string | null;
  rawHtml: string;
};

async function getMessage(messageId: string): Promise<MessageRow | null> {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);

  if (rows.length === 0) return null;
  const m = rows[0];
  return {
    id: m.id,
    author: m.author,
    cleanText: m.cleanText,
    badges: (m.badges as string[]) ?? [],
    symbols: (m.symbols as string[]) ?? [],
    timestamp: m.timestamp,
    actionHint: m.actionHint,
    directionHint: m.directionHint,
    rawHtml: m.rawHtml,
  };
}

async function getNearbyMessages(
  author: string,
  aroundTime: Date,
  windowMinutes: number,
) {
  const before = new Date(aroundTime.getTime() - windowMinutes * 60_000).toISOString();
  const after = new Date(aroundTime.getTime() + windowMinutes * 60_000).toISOString();

  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(
      eq(schema.messages.author, author),
      gte(schema.messages.timestamp, before),
      lte(schema.messages.timestamp, after),
    ))
    .orderBy(schema.messages.timestamp);

  return rows.map((m) => ({
    id: m.id,
    author: m.author,
    cleanText: m.cleanText,
    badges: (m.badges as string[]) ?? [],
    symbols: (m.symbols as string[]) ?? [],
    timestamp: m.timestamp,
    actionHint: m.actionHint,
    directionHint: m.directionHint,
  }));
}

async function searchTraderMessages(author: string, query: string, limit: number) {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(
      eq(schema.messages.author, author),
      like(schema.messages.cleanText, `%${query}%`),
    ))
    .orderBy(schema.messages.timestamp)
    .limit(limit);

  return rows.map((m) => ({
    id: m.id,
    author: m.author,
    cleanText: m.cleanText,
    badges: (m.badges as string[]) ?? [],
    symbols: (m.symbols as string[]) ?? [],
    timestamp: m.timestamp,
    actionHint: m.actionHint,
    directionHint: m.directionHint,
  }));
}

async function getTraderPositionHistory(author: string, beforeTime: Date) {
  const rows = await db
    .select({
      label: schema.messageLabels,
      message: schema.messages,
    })
    .from(schema.messageLabels)
    .innerJoin(schema.messages, eq(schema.messageLabels.messageId, schema.messages.id))
    .where(and(
      eq(schema.messages.author, author),
      eq(schema.messageLabels.isTrade, true),
      lte(schema.messages.timestamp, beforeTime.toISOString()),
    ))
    .orderBy(schema.messages.timestamp);

  const labels: LabelRow[] = rows.map(({ label, message }) => ({
    action: label.action,
    direction: label.direction,
    strategy: label.strategy,
    symbol: label.symbol,
    price: label.price,
    strikes: label.strikes,
    exitPercent: label.exitPercent ?? null,
    messageText: message.cleanText,
    messageTimestamp: message.timestamp,
  }));

  return reconstructPositions(labels);
}

// ─── Historical data (lazily loaded) ─────────────────

// Wrapped in an object so TypeScript doesn't narrow the type to `null`
const state: { historicalData: HistoricalDataStore | null } = { historicalData: null };

// ─── Server setup ────────────────────────────────────

const server = new McpServer({
  name: 'trade-follower-labels',
  version: '1.0.0',
});

// ── list_unlabeled_messages ──────────────────────────

server.tool(
  'list_unlabeled_messages',
  'List badged messages that have no label yet. Returns message id, author, text, badges, and timestamp.',
  {
    count: z.number().optional().describe('Max messages to return (default: 20)'),
    labelSet: z.string().optional().describe('Label set to check (default: baseline)'),
    author: z.string().optional().describe('Filter by author name'),
  },
  async ({ count, labelSet, author }) => {
    const limit = count ?? 20;
    const ls = labelSet ?? 'baseline';

    let query;
    if (author) {
      query = sql`
        SELECT m.id, m.author, m.clean_text, m.badges, m.symbols, m.timestamp
        FROM messages m
        LEFT JOIN message_labels ml ON ml.message_id = m.id AND ml.label_set = ${ls}
        WHERE json_array_length(m.badges) > 0
          AND ml.id IS NULL
          AND m.author = ${author}
        ORDER BY m.timestamp ASC
        LIMIT ${limit}
      `;
    } else {
      query = sql`
        SELECT m.id, m.author, m.clean_text, m.badges, m.symbols, m.timestamp
        FROM messages m
        LEFT JOIN message_labels ml ON ml.message_id = m.id AND ml.label_set = ${ls}
        WHERE json_array_length(m.badges) > 0
          AND ml.id IS NULL
        ORDER BY m.timestamp ASC
        LIMIT ${limit}
      `;
    }

    const rows = await db.all<{
      id: string;
      author: string;
      clean_text: string;
      badges: string;
      symbols: string;
      timestamp: string;
    }>(query);

    const messages = rows.map((r) => ({
      id: r.id,
      author: r.author,
      text: r.clean_text,
      badges: safeJson(r.badges),
      symbols: safeJson(r.symbols),
      timestamp: r.timestamp,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ count: messages.length, messages }, null, 2),
      }],
    };
  },
);

// ── get_message ──────────────────────────────────────

server.tool(
  'get_message',
  'Get full details of a specific message by ID.',
  {
    messageId: z.string().describe('Message ID'),
  },
  async ({ messageId }) => {
    const msg = await getMessage(messageId);
    if (!msg) {
      return { content: [{ type: 'text' as const, text: `Message ${messageId} not found.` }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(msg, null, 2) }],
    };
  },
);

// ── get_nearby_messages ──────────────────────────────

server.tool(
  'get_nearby_messages',
  'Get messages from the same trader within a time window around a given message. Essential for understanding context — "added more" references the original entry, "out" references what they are closing.',
  {
    messageId: z.string().describe('Message ID to center the search around'),
    windowMinutes: z.number().optional().describe('Time window in minutes (default: 60)'),
  },
  async ({ messageId, windowMinutes }) => {
    const msg = await getMessage(messageId);
    if (!msg) {
      return { content: [{ type: 'text' as const, text: `Message ${messageId} not found.` }] };
    }

    const messages = await getNearbyMessages(
      msg.author,
      new Date(msg.timestamp),
      windowMinutes ?? 60,
    );

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ count: messages.length, messages }, null, 2),
      }],
    };
  },
);

// ── get_trader_position_history ──────────────────────

server.tool(
  'get_trader_position_history',
  'Reconstruct what positions the trader had open at the time of this message, based on prior labeled messages. Essential for close/trim/add classification.',
  {
    messageId: z.string().describe('Message ID'),
  },
  async ({ messageId }) => {
    const msg = await getMessage(messageId);
    if (!msg) {
      return { content: [{ type: 'text' as const, text: `Message ${messageId} not found.` }] };
    }

    const positions = await getTraderPositionHistory(
      msg.author,
      new Date(msg.timestamp),
    );

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ count: positions.length, positions }, null, 2),
      }],
    };
  },
);

// ── search_trader_messages ───────────────────────────

server.tool(
  'search_trader_messages',
  'Full text search across a trader\'s message history. Use for context further back than the nearby window.',
  {
    messageId: z.string().describe('Message ID (used to identify the trader)'),
    query: z.string().describe('Search text'),
    limit: z.number().optional().describe('Max results (default: 10)'),
  },
  async ({ messageId, query, limit }) => {
    const msg = await getMessage(messageId);
    if (!msg) {
      return { content: [{ type: 'text' as const, text: `Message ${messageId} not found.` }] };
    }

    const messages = await searchTraderMessages(msg.author, query, limit ?? 10);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ count: messages.length, messages }, null, 2),
      }],
    };
  },
);

// ── get_historical_quote ─────────────────────────────

server.tool(
  'get_historical_quote',
  'Get stock/ETF quote at the time of a message. Requires historical data to be pre-loaded (start server with LOAD_QUOTES=1).',
  {
    messageId: z.string().describe('Message ID (used for timestamp)'),
    symbol: z.string().describe('Ticker symbol (e.g. AAPL)'),
  },
  async ({ messageId, symbol }) => {
    const msg = await getMessage(messageId);
    if (!msg) {
      return { content: [{ type: 'text' as const, text: `Message ${messageId} not found.` }] };
    }
    const hd = state.historicalData;
    if (!hd) {
      return { content: [{ type: 'text' as const, text: 'No historical market data loaded. Start the server with LOAD_QUOTES=1.' }] };
    }

    const quote = hd.getQuote(symbol, new Date(msg.timestamp));
    if (!quote) {
      return { content: [{ type: 'text' as const, text: `No quote data for ${symbol} at ${msg.timestamp}` }] };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          symbol: quote.symbol,
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          timestamp: quote.timestamp.toISOString(),
        }, null, 2),
      }],
    };
  },
);

// ── get_price_action ─────────────────────────────────

server.tool(
  'get_price_action',
  'Get 1-minute price bars leading up to a message. Shows if the stock was rallying or dumping.',
  {
    messageId: z.string().describe('Message ID (used for timestamp)'),
    symbol: z.string().describe('Ticker symbol'),
    bars: z.number().optional().describe('Number of bars (default: 15)'),
  },
  async ({ messageId, symbol, bars }) => {
    const msg = await getMessage(messageId);
    if (!msg) {
      return { content: [{ type: 'text' as const, text: `Message ${messageId} not found.` }] };
    }
    const hd = state.historicalData;
    if (!hd) {
      return { content: [{ type: 'text' as const, text: 'No historical market data loaded.' }] };
    }

    const barData = hd.getBars(symbol, bars ?? 15, new Date(msg.timestamp));
    if (barData.length === 0) {
      return { content: [{ type: 'text' as const, text: `No bar data for ${symbol} at ${msg.timestamp}` }] };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          symbol,
          barCount: barData.length,
          bars: barData.map((b) => ({
            time: b.timestamp.toISOString(),
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
          })),
        }, null, 2),
      }],
    };
  },
);

// ── submit_label ─────────────────────────────────────

server.tool(
  'submit_label',
  'Submit a classification label for a message. Saves it to the database.',
  {
    messageId: z.string().describe('Message ID to label'),
    labelSet: z.string().optional().describe('Label set name (default: baseline)'),
    isTrade: z.boolean().describe('Is this a real trade alert/signal?'),
    action: z.enum(['OPEN', 'CLOSE', 'ADD', 'TRIM']).nullable().optional().describe('OPEN, CLOSE, ADD (adding to position), or TRIM (partial exit)'),
    direction: z.enum(['LONG', 'SHORT']).nullable().optional().describe('LONG or SHORT'),
    strategy: z.enum(['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'PCS']).nullable().optional().describe('Trade strategy (PCS = Put Credit Spread)'),
    symbol: z.string().nullable().optional().describe('Ticker symbol'),
    price: z.string().nullable().optional().describe('Entry/exit price'),
    strikes: z.array(z.number()).nullable().optional().describe('Option strikes'),
    quantity: z.string().nullable().optional().describe('Number of contracts/shares'),
    expiry: z.string().nullable().optional().describe('Option expiry (YYYY-MM-DD)'),
    exitPercent: zPct01.nullable().optional().describe('Exit percentage for TRIM (0.0-1.0). "1/2" = 0.5, "80%" = 0.8'),
    confidence: z.enum(['high', 'medium', 'low']).optional().describe('Classification confidence'),
    notes: z.string().nullable().optional().describe('Notes about the classification'),
    reviewed: z.boolean().optional().describe('Mark as reviewed (default: true)'),
  },
  async (args) => {
    const { messageId, labelSet: ls, reviewed, exitPercent, ...labelFields } = args;
    const labelSet = ls ?? 'baseline';

    // Validate message exists
    const msg = await getMessage(messageId);
    if (!msg) {
      return { content: [{ type: 'text' as const, text: `Message ${messageId} not found.` }] };
    }

    // Validate label
    const parsed = LabelResultSchema.safeParse({ ...labelFields, exitPercent });
    if (!parsed.success) {
      return {
        content: [{ type: 'text' as const, text: `Invalid label: ${parsed.error.message}` }],
      };
    }

    const label = parsed.data;

    await db.insert(schema.messageLabels).values({
      messageId,
      labelSet,
      isTrade: label.isTrade,
      action: label.action ?? null,
      direction: label.direction ?? null,
      strategy: label.strategy ?? null,
      symbol: label.symbol ?? null,
      price: label.price ?? null,
      strikes: label.strikes ?? null,
      quantity: label.quantity ?? null,
      expiry: label.expiry ?? null,
      exitPercent: label.exitPercent ?? null,
      source: 'manual',
      reviewed: reviewed ?? true,
      notes: label.notes ?? null,
      modelProvider: null,
      modelName: null,
    });

    return {
      content: [{
        type: 'text' as const,
        text: `Label saved for message ${messageId} (${labelSet}): isTrade=${label.isTrade}, action=${label.action}, direction=${label.direction}, strategy=${label.strategy}, symbol=${label.symbol}${label.exitPercent != null ? `, exitPercent=${label.exitPercent}` : ''}`,
      }],
    };
  },
);

// ── get_existing_label ───────────────────────────────

server.tool(
  'get_existing_label',
  'Check if a message already has a label in a given label set.',
  {
    messageId: z.string().describe('Message ID'),
    labelSet: z.string().optional().describe('Label set (default: baseline)'),
  },
  async ({ messageId, labelSet }) => {
    const ls = labelSet ?? 'baseline';
    const rows = await db
      .select()
      .from(schema.messageLabels)
      .where(and(
        eq(schema.messageLabels.messageId, messageId),
        eq(schema.messageLabels.labelSet, ls),
      ))
      .limit(1);

    if (rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `No label found for ${messageId} in "${ls}".` }] };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(rows[0], null, 2) }],
    };
  },
);

// ─── Helpers ─────────────────────────────────────────

function safeJson(raw: string | null): unknown {
  try { return JSON.parse(raw || '[]'); }
  catch { return []; }
}

// ─── Start ───────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
