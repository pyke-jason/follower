import type { Quote, OptionsChain, OptionsStrike } from '../broker/types.js';

/**
 * MarketDataProvider: Abstraction for getting price data at a point in time.
 * The MessagePriceProvider implementation extracts prices from the message text.
 * A Databento adapter would implement this same interface with real historical data.
 */
export interface MarketDataProvider {
  getQuote(symbol: string, at: Date): Promise<Quote>;
  getOptionsChain(symbol: string, expiry: string, optionType: 'CALL' | 'PUT', at: Date): Promise<OptionsChain>;
}

/**
 * MessagePriceProvider: Extracts prices from message text.
 * When a trade message says "Long CSCO 73.41", we use 73.41 as the price.
 * Creates synthetic bid/ask around the stated price.
 */
export class MessagePriceProvider implements MarketDataProvider {
  // Cache of prices set by the backtest runner from each message
  private priceCache = new Map<string, { price: number; timestamp: Date }>();

  /** Called by the runner before processing each message to seed price data */
  setPrice(symbol: string, price: number, at: Date): void {
    this.priceCache.set(symbol, { price, timestamp: at });
  }

  /** Set option price for a specific strike */
  setOptionPrice(key: string, price: number, at: Date): void {
    this.priceCache.set(key, { price, timestamp: at });
  }

  async getQuote(symbol: string, at: Date): Promise<Quote> {
    const cached = this.priceCache.get(symbol);
    const price = cached?.price ?? 100; // fallback
    const spread = price * 0.001; // 0.1% spread

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
      const spread = price * 0.05; // 5% spread for options
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
}
