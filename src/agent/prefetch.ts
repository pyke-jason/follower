import type { BrokerService } from '../broker/interface.js';
import type { Quote } from '../broker/types.js';
import type { Trade, TrackedTrader } from '../db/schema.js';
import type { PositionFilters } from '../trades/filters.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Prefetch');

// ─── Types ──────────────────────────────────────────

export type PrefetchedQuote =
  | { bid: number; ask: number; last: number; volume: number; timestamp: string }
  | { error: string };

export type PrefetchedPositions = {
  forSymbol: Trade[];
  allForTrader: Trade[];
  totalCount: number; // -1 if fetch failed
  failed: boolean;
};

export type PrefetchedData = {
  quotes: Record<string, PrefetchedQuote>;
  positions: PrefetchedPositions;
  traderProfile: {
    strategies: string[];
    notes: string | null;
  } | null;
};

export type PrefetchDeps = {
  broker: BrokerService;
  getOpenPositions: (filters: PositionFilters) => Promise<Trade[]>;
  getTraderConfig: (name: string) => Promise<TrackedTrader | undefined>;
};

// ─── Helpers ────────────────────────────────────────

async function fetchQuotes(
  symbols: string[],
  broker: BrokerService,
): Promise<Record<string, PrefetchedQuote>> {
  const quotes: Record<string, PrefetchedQuote> = {};
  const results = await Promise.allSettled(
    symbols.map(async (sym) => {
      const q = await broker.getQuote(sym);
      return { symbol: sym, quote: q };
    }),
  );
  for (let i = 0; i < results.length; i++) {
    const sym = symbols[i];
    const r = results[i];
    if (r.status === 'fulfilled') {
      const q = r.value.quote;
      quotes[sym] = { bid: q.bid, ask: q.ask, last: q.last, volume: q.volume, timestamp: q.timestamp };
    } else {
      quotes[sym] = { error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
    }
  }
  return quotes;
}

// ─── Main ───────────────────────────────────────────

export async function prefetchForAgent(
  context: { symbols?: string[]; author?: string },
  deps: PrefetchDeps,
): Promise<PrefetchedData> {
  const symbols = context.symbols ?? [];
  const author = context.author ?? '';

  // Fire all fetches in parallel — each leg handles its own errors
  const [quotesResult, positionsResult, traderResult] = await Promise.allSettled([
    fetchQuotes(symbols, deps.broker),
    deps.getOpenPositions({ trader: author }),
    author ? deps.getTraderConfig(author) : Promise.resolve(undefined),
  ]);

  // Quotes: per-symbol errors already captured inside fetchQuotes
  const quotes: Record<string, PrefetchedQuote> =
    quotesResult.status === 'fulfilled' ? quotesResult.value : {};

  // Positions: if this leg failed, mark as failed so skip checks don't fire on bad data
  let positions: PrefetchedPositions;
  if (positionsResult.status === 'fulfilled') {
    const allForTrader = positionsResult.value;
    const symbolSet = new Set(symbols);
    positions = {
      forSymbol: allForTrader.filter((t) => symbolSet.has(t.symbol)),
      allForTrader,
      totalCount: allForTrader.length,
      failed: false,
    };
  } else {
    log.warn(`Position fetch failed for ${author}: ${positionsResult.reason}`);
    positions = { forSymbol: [], allForTrader: [], totalCount: -1, failed: true };
  }

  // Trader profile: null if not found or fetch failed
  let traderProfile: PrefetchedData['traderProfile'] = null;
  if (traderResult.status === 'fulfilled' && traderResult.value) {
    const t = traderResult.value;
    traderProfile = {
      strategies: t.strategies ?? [],
      notes: t.notes ?? null,
    };
  }

  return { quotes, positions, traderProfile };
}
