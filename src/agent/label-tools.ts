import type { ToolDef } from './tool-factory.js';
import type { HistoricalDataStore } from './historical-data-store.js';
import type { LabelResult } from './schemas.js';
import { LabelResultSchema } from './schemas.js';

// ─── Dependencies ────────────────────────────────────

export type LabelToolDeps = {
  /** The message being labeled — provides timestamp context to all tools. */
  messageTimestamp: Date;
  messageAuthor: string;

  /** Get messages from the same trader near this message's time. */
  getNearbyMessages: (author: string, aroundTime: Date, windowMinutes: number) => Promise<NearbyMessage[]>;

  /** Full-text search across a trader's message history. */
  searchTraderMessages: (author: string, query: string, limit: number) => Promise<NearbyMessage[]>;

  /** Reconstruct what positions the trader had open at a given time based on prior labels. */
  getTraderPositionHistory: (author: string, beforeTime: Date) => Promise<TraderPosition[]>;

  /** Pre-loaded historical market data (may be null if no tapes loaded). */
  historicalData: HistoricalDataStore | null;
};

export type NearbyMessage = {
  id: string;
  author: string;
  cleanText: string;
  badges: string[];
  symbols: string[];
  timestamp: string;
  actionHint: string | null;
  directionHint: string | null;
};

export type TraderPosition = {
  symbol: string;
  direction: string;
  strategy: string;
  action: string;
  price: string | null;
  strikes: number[] | null;
  remainingPercent: number;
  lastActionText: string;
  lastActionTimestamp: string;
  entryText: string;
  entryTimestamp: string;
};

// ─── Factory ─────────────────────────────────────────

/**
 * Create label agent tools with injected dependencies.
 * The `onSubmit` callback is called when the agent uses submit_label.
 */
export function createLabelTools(
  deps: LabelToolDeps,
  onSubmit: (label: LabelResult) => void,
): ToolDef[] {
  return [
    // ── Context tools ──────────────────────────────

    {
      name: 'get_nearby_messages',
      description: 'Get messages from the same trader within a time window around the current message. Use to understand context: what was the original entry for an "added more" or "out" message.',
      input_schema: {
        type: 'object',
        properties: {
          windowMinutes: {
            type: 'number',
            description: 'Time window in minutes before and after the message (default: 60)',
          },
        },
      },
      execute: async (input) => {
        const windowMinutes = (input as any).windowMinutes ?? 60;
        const messages = await deps.getNearbyMessages(
          deps.messageAuthor,
          deps.messageTimestamp,
          windowMinutes,
        );
        return { count: messages.length, messages };
      },
    },

    {
      name: 'get_trader_position_history',
      description: 'Get reconstructed open positions for this trader at the time of the current message. Based on prior messages and labels. Essential for classifying close/trim/add messages.',
      input_schema: {
        type: 'object',
        properties: {},
      },
      execute: async () => {
        const positions = await deps.getTraderPositionHistory(
          deps.messageAuthor,
          deps.messageTimestamp,
        );
        return { count: positions.length, positions };
      },
    },

    {
      name: 'search_trader_messages',
      description: 'Full text search across this trader\'s message history. Use for context further back than the nearby window.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text to find in messages' },
          limit: { type: 'number', description: 'Max results to return (default: 10)' },
        },
        required: ['query'],
      },
      execute: async (input) => {
        const query = (input as any).query as string;
        const limit = (input as any).limit ?? 10;
        const messages = await deps.searchTraderMessages(
          deps.messageAuthor,
          query,
          limit,
        );
        return { count: messages.length, messages };
      },
    },

    // ── Market data tools ──────────────────────────

    {
      name: 'get_historical_quote',
      description: 'Get the stock/ETF quote (bid, ask, mid) at the time of this message. Uses pre-loaded Databento DBEQ.BASIC data.',
      input_schema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL)' },
        },
        required: ['symbol'],
      },
      execute: async (input) => {
        const symbol = (input as any).symbol as string;
        if (!deps.historicalData) {
          return { error: 'No historical market data loaded for this session.' };
        }
        const quote = deps.historicalData.getQuote(symbol, deps.messageTimestamp);
        if (!quote) {
          return { error: `No quote data available for ${symbol} at ${deps.messageTimestamp.toISOString()}` };
        }
        return {
          symbol: quote.symbol,
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          timestamp: quote.timestamp.toISOString(),
        };
      },
    },

    {
      name: 'get_historical_options_chain',
      description: 'Get options quotes at the time of this message. Uses pre-loaded Databento OPRA data. Returns available strikes with bid/ask.',
      input_schema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Underlying ticker (e.g. AAPL)' },
          optionType: { type: 'string', enum: ['CALL', 'PUT'], description: 'Option type' },
          strike: { type: 'number', description: 'Specific strike to look up (optional — omit to search all loaded strikes)' },
        },
        required: ['symbol'],
      },
      execute: async (input) => {
        const symbol = (input as any).symbol as string;
        const optionType = (input as any).optionType as string | undefined;
        const strike = (input as any).strike as number | undefined;

        if (!deps.historicalData) {
          return { error: 'No historical market data loaded for this session.' };
        }

        // Options symbols in OPRA follow patterns like "AAPL  250221C00172500"
        // We search for symbols starting with the underlying
        const matchingSymbols = deps.historicalData.symbols.filter((s) => {
          if (!s.startsWith(symbol)) return false;
          if (optionType) {
            // OPRA symbols have C or P in the symbol
            const typeChar = optionType === 'CALL' ? 'C' : 'P';
            if (!s.includes(typeChar)) return false;
          }
          return true;
        });

        const results = matchingSymbols.map((optSym) => {
          const quote = deps.historicalData!.getQuote(optSym, deps.messageTimestamp);
          return quote ? {
            optionSymbol: optSym,
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            timestamp: quote.timestamp.toISOString(),
          } : null;
        }).filter(Boolean);

        if (strike != null) {
          // Filter to matching strike — OPRA strike is encoded in last 8 chars as price * 1000
          const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
          const filtered = results.filter((r) => r!.optionSymbol.endsWith(strikeStr));
          return { count: filtered.length, quotes: filtered };
        }

        return { count: results.length, quotes: results };
      },
    },

    {
      name: 'get_price_action',
      description: 'Get price bars (1-minute) leading up to the message time. Helps understand if the stock was rallying or dumping.',
      input_schema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Ticker symbol' },
          bars: { type: 'number', description: 'Number of 1-minute bars to retrieve (default: 15)' },
        },
        required: ['symbol'],
      },
      execute: async (input) => {
        const symbol = (input as any).symbol as string;
        const count = (input as any).bars ?? 15;

        if (!deps.historicalData) {
          return { error: 'No historical market data loaded for this session.' };
        }

        const bars = deps.historicalData.getBars(symbol, count, deps.messageTimestamp);
        if (bars.length === 0) {
          return { error: `No bar data available for ${symbol} at ${deps.messageTimestamp.toISOString()}` };
        }

        return {
          symbol,
          barCount: bars.length,
          bars: bars.map((b) => ({
            time: b.timestamp.toISOString(),
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
          })),
        };
      },
    },

    // ── Result submission ──────────────────────────

    {
      name: 'submit_label',
      description: 'Submit your classification for this message. Call this when you have determined the label. For leg adjustments (spread → naked), call submit_label TWICE on the same message.',
      input_schema: {
        type: 'object',
        properties: {
          isTrade: { type: 'boolean', description: 'Is this a real trade alert/signal?' },
          action: { type: 'string', enum: ['OPEN', 'CLOSE', 'ADD', 'TRIM'], description: 'OPEN=new entry, ADD=adding to existing, TRIM=partial exit, CLOSE=full exit' },
          direction: { type: 'string', enum: ['LONG', 'SHORT'], description: 'Long or short? null if not a trade.' },
          strategy: { type: 'string', enum: ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'PCS'], description: 'Trade strategy type (PCS = Put Credit Spread)' },
          symbol: { type: 'string', description: 'Ticker symbol (uppercase)' },
          price: { type: 'string', description: 'Entry/exit price as text, null if ambiguous' },
          strikes: { type: 'array', items: { type: 'number' }, description: 'Option strike prices' },
          quantity: { type: 'string', description: 'Number of contracts/shares if stated' },
          expiry: { type: 'string', description: 'Option expiration in YYYY-MM-DD format' },
          exitPercent: { type: 'number', description: 'Exit percentage for TRIM (0.0-1.0). "1/2" = 0.5, "80%" = 0.8. null if unknown.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Your confidence in this classification' },
          notes: { type: 'string', description: 'Brief note about reasoning or anything unusual' },
        },
        required: ['isTrade'],
      },
      execute: async (input) => {
        const parsed = LabelResultSchema.parse(input);
        onSubmit(parsed);
        return { submitted: true };
      },
    },
  ];
}
