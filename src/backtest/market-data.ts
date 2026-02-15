import type { Quote, OptionsChain, OptionsStrike, Bar } from '../broker/types.js';
import { loadQuoteTapeForDay, toDateKey, getFetchMeta } from './databento-tape.js';
import type { QuoteTick } from './databento-tape.js';
import { createLogger } from '../lib/logger.js';
import { safeParseFloat } from '../lib/numbers.js';

const log = createLogger('MarketData');

/**
 * MarketDataProvider: Abstraction for getting price data at a point in time.
 * The MessagePriceProvider implementation extracts prices from the message text.
 * A Databento adapter would implement this same interface with real historical data.
 */
export interface MarketDataProvider {
  getQuote(symbol: string, at: Date): Promise<Quote>;
  getOptionsChain(symbol: string, expiry: string, optionType: 'CALL' | 'PUT', at: Date): Promise<OptionsChain>;
  getBars(symbol: string, barsBack: number, at: Date): Promise<Bar[]>;
}

/** Extended interface that both MessagePriceProvider and DatabentoMarketDataProvider implement. */
export interface BacktestPriceProvider extends MarketDataProvider {
  getPriceSnapshot(symbols: string[]): Record<string, number>;
  setOptionPrice(key: string, price: number, at: Date): void;
  setPrice(symbol: string, price: number, at: Date, spreadPct?: number): void;
  /** Return ticks for a symbol between two timestamps (inclusive). Used by SimBroker.advanceTo(). */
  getTicksInRange(symbol: string, from: Date, to: Date): Promise<QuoteTick[]>;
  /** Check if a real (non-message-seeded) quote exists for this symbol around this time. */
  hasQuote(symbol: string, at: Date): boolean;
}

/**
 * MessagePriceProvider: Extracts prices from message text.
 * When a trade message says "Long CSCO 73.41", we use 73.41 as the price.
 * Creates synthetic bid/ask around the stated price with configurable spread width.
 */
export class MessagePriceProvider implements BacktestPriceProvider {
  // Cache of prices set by the backtest runner from each message
  private priceCache = new Map<string, { price: number; timestamp: Date; spreadPct?: number }>();

  /** Called by the runner before processing each message to seed price data.
   *  spreadPct controls the synthetic bid-ask width (e.g. 0.10 = 10% of price). */
  setPrice(symbol: string, price: number, at: Date, spreadPct?: number): void {
    this.priceCache.set(symbol, { price, timestamp: at, spreadPct });
  }

  /** Set option price for a specific strike */
  setOptionPrice(key: string, price: number, at: Date): void {
    this.priceCache.set(key, { price, timestamp: at });
  }

  getPriceSnapshot(symbols: string[]): Record<string, number> {
    const result: Record<string, number> = {};
    for (const sym of symbols) {
      const cached = this.priceCache.get(sym);
      if (cached) result[sym] = cached.price;
    }
    return result;
  }

  async getQuote(symbol: string, at: Date): Promise<Quote> {
    const cached = this.priceCache.get(symbol);
    if (!cached) {
      throw new Error(`[MarketData] No price seeded for symbol "${symbol}" at ${at.toISOString()}. Call setPrice() before getQuote().`);
    }
    const price = cached.price;
    const spreadPct = cached.spreadPct ?? 0.001; // default 0.1% for stocks
    const spread = price * spreadPct;

    return {
      symbol,
      bid: price - spread / 2,
      ask: price + spread / 2,
      last: price,
      volume: 1_000_000,
      timestamp: at.toISOString(),
    };
  }

  async getOptionsChain(
    symbol: string,
    expiry: string,
    optionType: 'CALL' | 'PUT',
    at: Date,
  ): Promise<OptionsChain> {
    // Generate synthetic strikes around any known price
    const cachedKeys = Array.from(this.priceCache.entries())
      .filter(([k]) => k.startsWith(`${symbol}:${optionType}:`));

    const strikes: OptionsStrike[] = cachedKeys.map(([key, { price }]) => {
      const strike = safeParseFloat(key.split(':')[2]);
      const spread = price * 0.10; // 10% spread for options
      return {
        strike,
        bid: Math.max(0, price - spread / 2),
        ask: price + spread / 2,
        last: price,
        iv: 0.3,
        delta: optionType === 'CALL' ? 0.5 : -0.5,
        gamma: 0.02,
        theta: -0.05,
        openInterest: 1000,
      };
    });

    // If no cached option data, return empty chain
    return {
      symbol,
      expiry,
      optionType,
      strikes,
    };
  }

  /** MessagePriceProvider never has real quotes — only seeded from message text. */
  hasQuote(_symbol: string, _at: Date): boolean {
    return false;
  }

  async getTicksInRange(_symbol: string, _from: Date, _to: Date): Promise<QuoteTick[]> {
    return [];
  }

  async getBars(symbol: string, barsBack: number, at: Date): Promise<Bar[]> {
    const cached = this.priceCache.get(symbol);
    if (!cached) {
      throw new Error(`[MarketData] No price seeded for symbol "${symbol}" at ${at.toISOString()}. Call setPrice() before getBars().`);
    }
    const price = cached.price;

    // Generate synthetic daily bars with small random-ish variation around the price
    const bars: Bar[] = [];
    for (let i = barsBack; i >= 0; i--) {
      const date = new Date(at);
      date.setDate(date.getDate() - i);
      // Synthesize small variation (~1-2% of price) for ATR computation
      const variation = price * 0.015;
      bars.push({
        timestamp: date.toISOString(),
        open: price - variation * 0.3,
        high: price + variation,
        low: price - variation,
        close: price + variation * 0.2,
        volume: 1_000_000,
      });
    }
    return bars;
  }
}

/**
 * DatabentoMarketDataProvider: Uses Databento historical OHLCV-1m data for real
 * market prices. Ticks are loaded per symbol-day (disk-cached), and all lookups
 * respect the sim clock — no look-ahead bias.
 */
export class DatabentoMarketDataProvider implements BacktestPriceProvider {
  /** "SYMBOL:YYYY-MM-DD" -> sorted ticks (in-memory cache on top of disk cache) */
  private dayTicks = new Map<string, QuoteTick[]>();
  /** symbol -> most recent mid price (for getPriceSnapshot) */
  private latestQuotes = new Map<string, number>();
  /** "SYM:CALL:150" -> option premium (seeded from message) */
  private optionCache = new Map<string, { price: number; timestamp: Date }>();

  constructor(
    private apiKey: string,
    private dataset: string = 'DBEQ.BASIC',
  ) {}

  /**
   * Prefetch data for multiple symbols at a point in time.
   * Loads any uncached symbol-days from Databento and updates latestQuotes.
   */
  async prefetch(symbols: string[], at: Date): Promise<void> {
    const day = toDateKey(at);
    const uncached = symbols.filter((s) => !this.dayTicks.has(`${s}:${day}`));

    if (uncached.length > 0) {
      log.debug(`Prefetching ${uncached.join(',')} for ${day}`);
      const ticks = await loadQuoteTapeForDay({
        apiKey: this.apiKey,
        dataset: this.dataset,
        symbols: uncached,
        day,
      });

      // Group ticks by symbol and store
      const bySymbol = new Map<string, QuoteTick[]>();
      for (const sym of uncached) bySymbol.set(sym, []);
      for (const tick of ticks) {
        let bucket = bySymbol.get(tick.symbol);
        if (!bucket) { bucket = []; bySymbol.set(tick.symbol, bucket); }
        bucket.push(tick);
      }
      for (const [sym, symTicks] of bySymbol) {
        symTicks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        this.dayTicks.set(`${sym}:${day}`, symTicks);
      }
    }

    // Update latestQuotes for each symbol using last tick at or before `at`
    for (const sym of symbols) {
      const ticks = this.dayTicks.get(`${sym}:${day}`);
      if (!ticks || ticks.length === 0) continue;
      const tick = this.findLastTickBefore(ticks, at);
      if (tick) {
        this.latestQuotes.set(sym, (tick.bid + tick.ask) / 2);
      }
    }
  }

  /** No-op — prices come from Databento. Kept for BacktestPriceProvider compatibility. */
  setPrice(_symbol: string, _price: number, _at: Date, _spreadPct?: number): void {
    // no-op
  }

  /** Store option price from message text. DBEQ.BASIC has no options data. */
  setOptionPrice(key: string, price: number, at: Date): void {
    this.optionCache.set(key, { price, timestamp: at });
  }

  /** Check if Databento ticks are loaded for this symbol on the given day. */
  hasQuote(symbol: string, at: Date): boolean {
    const day = toDateKey(at);
    const ticks = this.dayTicks.get(`${symbol}:${day}`);
    return ticks != null && ticks.length > 0;
  }

  /** Return latest known mid prices from prefetch/getQuote calls. */
  getPriceSnapshot(symbols: string[]): Record<string, number> {
    const result: Record<string, number> = {};
    for (const sym of symbols) {
      const price = this.latestQuotes.get(sym);
      if (price != null) result[sym] = price;
    }
    return result;
  }

  async getQuote(symbol: string, at: Date): Promise<Quote> {
    const ticks = await this.loadDay(symbol, at);
    const tick = this.findLastTickBefore(ticks, at);

    if (!tick) {
      const day = toDateKey(at);
      const meta = getFetchMeta(symbol, day);
      const fetchCtx = meta
        ? `Fetch: status=${meta.status} bytes=${meta.bytes} records=${meta.records}${meta.requestId ? ` req=${meta.requestId}` : ''}`
        : 'No fetch metadata found — check QuoteTape logs above.';
      throw new Error(
        `[MarketData] No Databento data for "${symbol}" at or before ${at.toISOString()}.\n` +
        `  Day has ${ticks.length} ticks${ticks.length > 0 ? ` (first: ${ticks[0].timestamp.toISOString()})` : ''}. ${fetchCtx}`,
      );
    }

    const mid = (tick.bid + tick.ask) / 2;
    this.latestQuotes.set(symbol, mid);

    return {
      symbol,
      bid: tick.bid,
      ask: tick.ask,
      last: mid,
      volume: 1_000_000,
      timestamp: tick.timestamp.toISOString(),
    };
  }

  async getBars(symbol: string, barsBack: number, at: Date): Promise<Bar[]> {
    // Walk backwards to collect enough trading days
    const calendarDays = Math.ceil(barsBack * 1.5) + 5; // padding for weekends/holidays
    const bars: Bar[] = [];

    const atDay = toDateKey(at);

    for (let offset = calendarDays; offset >= 0; offset--) {
      const d = new Date(at.getTime() - offset * 24 * 60 * 60 * 1000);
      const dayKey = toDateKey(d);

      let ticks: QuoteTick[];
      try {
        ticks = await this.loadDay(symbol, d);
      } catch {
        continue; // skip days with no data
      }

      if (ticks.length === 0) continue;

      let dayTicks: QuoteTick[];
      if (dayKey === atDay) {
        // Current day: only ticks at or before `at` (no look-ahead)
        const idx = this.findLastTickBeforeIndex(ticks, at);
        if (idx < 0) continue;
        dayTicks = ticks.slice(0, idx + 1);
      } else {
        // Past day: all ticks are fair game
        dayTicks = ticks;
      }

      if (dayTicks.length === 0) continue;

      // Aggregate minute ticks into one daily bar
      const firstMid = (dayTicks[0].bid + dayTicks[0].ask) / 2;
      const lastMid = (dayTicks[dayTicks.length - 1].bid + dayTicks[dayTicks.length - 1].ask) / 2;
      let high = -Infinity;
      let low = Infinity;
      for (const t of dayTicks) {
        if (t.ask > high) high = t.ask;
        if (t.bid < low) low = t.bid;
      }

      bars.push({
        timestamp: dayTicks[0].timestamp.toISOString(),
        open: firstMid,
        high,
        low,
        close: lastMid,
        volume: dayTicks.length * 1000, // approximate
      });
    }

    // Return last barsBack bars
    return bars.slice(-barsBack);
  }

  async getOptionsChain(
    symbol: string,
    expiry: string,
    optionType: 'CALL' | 'PUT',
    _at: Date,
  ): Promise<OptionsChain> {
    // Options data comes from seeded optionCache (DBEQ.BASIC has no options)
    const cachedKeys = Array.from(this.optionCache.entries())
      .filter(([k]) => k.startsWith(`${symbol}:${optionType}:`));

    const strikes: OptionsStrike[] = cachedKeys.map(([key, { price }]) => {
      const strike = safeParseFloat(key.split(':')[2]);
      const spread = price * 0.10; // 10% spread for options
      return {
        strike,
        bid: Math.max(0, price - spread / 2),
        ask: price + spread / 2,
        last: price,
        iv: 0.3,
        delta: optionType === 'CALL' ? 0.5 : -0.5,
        gamma: 0.02,
        theta: -0.05,
        openInterest: 1000,
      };
    });

    return { symbol, expiry, optionType, strikes };
  }

  async getTicksInRange(symbol: string, from: Date, to: Date): Promise<QuoteTick[]> {
    const toDay = toDateKey(to);

    const result: QuoteTick[] = [];
    const fromMs = from.getTime();
    const toMs = to.getTime();

    // Iterate calendar days in range (usually just one)
    let d = new Date(from);
    d.setUTCHours(0, 0, 0, 0);
    while (toDateKey(d) <= toDay) {
      const ticks = await this.loadDay(symbol, d);
      for (const tick of ticks) {
        const t = tick.timestamp.getTime();
        if (t >= fromMs && t <= toMs) result.push(tick);
      }
      d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    }

    return result;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /** Load a single symbol-day into the in-memory cache if not already present. */
  private async loadDay(symbol: string, at: Date): Promise<QuoteTick[]> {
    const day = toDateKey(at);
    const key = `${symbol}:${day}`;
    const cached = this.dayTicks.get(key);
    if (cached) return cached;

    const ticks = await loadQuoteTapeForDay({
      apiKey: this.apiKey,
      dataset: this.dataset,
      symbols: [symbol],
      day,
    });

    // Filter to this symbol (loadQuoteTapeForDay may return only this symbol, but be safe)
    const symTicks = ticks.filter((t) => t.symbol === symbol);
    symTicks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    this.dayTicks.set(key, symTicks);
    return symTicks;
  }

  /** Binary search: return the last tick with timestamp <= at, or null. */
  private findLastTickBefore(ticks: QuoteTick[], at: Date): QuoteTick | null {
    const idx = this.findLastTickBeforeIndex(ticks, at);
    return idx >= 0 ? ticks[idx] : null;
  }

  /** Binary search: return index of last tick with timestamp <= at, or -1. */
  private findLastTickBeforeIndex(ticks: QuoteTick[], at: Date): number {
    if (ticks.length === 0) return -1;
    const target = at.getTime();

    let lo = 0;
    let hi = ticks.length - 1;
    let result = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (ticks[mid].timestamp.getTime() <= target) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return result;
  }
}
