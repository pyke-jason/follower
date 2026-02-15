import type { Quote, OptionsChain, OptionsStrike, Bar } from '../broker/types.js';

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

/**
 * MessagePriceProvider: Extracts prices from message text.
 * When a trade message says "Long CSCO 73.41", we use 73.41 as the price.
 * Creates synthetic bid/ask around the stated price with configurable spread width.
 */
export class MessagePriceProvider implements MarketDataProvider {
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
      const strike = parseFloat(key.split(':')[2]);
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
