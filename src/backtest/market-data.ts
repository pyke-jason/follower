import type { Quote, OptionsChain, Bar } from '../broker/types.js';
import { loadQuoteTapeForDay, toDateKey, getFetchMeta } from './databento-tape.js';
import type { QuoteTick } from './databento-tape.js';
import { isOccOptionSymbol } from './occ-symbology.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('MarketData');

/**
 * MarketDataProvider: Abstraction for getting price data at a point in time.
 */
export interface MarketDataProvider {
  getQuote(symbol: string, at: Date): Promise<Quote>;
  getOptionsChain(symbol: string, expiry: string, optionType: 'CALL' | 'PUT', at: Date): Promise<OptionsChain>;
  getBars(symbol: string, barsBack: number, at: Date): Promise<Bar[]>;
}

/** Backtest price provider backed by real market data. */
export interface BacktestPriceProvider extends MarketDataProvider {
  getPriceSnapshot(symbols: string[]): Record<string, number>;
  /** Return ticks for a symbol between two timestamps (inclusive). Used by SimBroker.advanceTo(). */
  getTicksInRange(symbol: string, from: Date, to: Date): Promise<QuoteTick[]>;
  /** Prefetch data for multiple symbols at a point in time. */
  prefetch(symbols: string[], at: Date): Promise<void>;
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

  constructor(
    private apiKey: string,
    private dataset: string = 'DBEQ.BASIC',
    private refreshCache: boolean = false,
    private optionsDataset: string = 'OPRA.PILLAR',
  ) {}

  /**
   * Prefetch data for multiple symbols at a point in time.
   * Loads any uncached symbol-days from Databento and updates latestQuotes.
   */
  async prefetch(symbols: string[], at: Date): Promise<void> {
    const day = toDateKey(at);
    const uncached = symbols.filter((s) => !this.dayTicks.has(`${s}:${day}`));

    if (uncached.length > 0) {
      // Partition into equities vs options for separate dataset calls
      const equitySyms = uncached.filter((s) => !isOccOptionSymbol(s));
      const optionSyms = uncached.filter((s) => isOccOptionSymbol(s));

      const fetchBatch = async (syms: string[], dataset: string) => {
        log.debug(`Prefetching ${syms.join(',')} for ${day} (${dataset})`);
        const ticks = await loadQuoteTapeForDay({
          apiKey: this.apiKey,
          dataset,
          symbols: syms,
          day,
          refreshCache: this.refreshCache,
        });

        const bySymbol = new Map<string, QuoteTick[]>();
        for (const sym of syms) bySymbol.set(sym, []);
        for (const tick of ticks) {
          let bucket = bySymbol.get(tick.symbol);
          if (!bucket) { bucket = []; bySymbol.set(tick.symbol, bucket); }
          bucket.push(tick);
        }
        for (const [sym, symTicks] of bySymbol) {
          symTicks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
          this.dayTicks.set(`${sym}:${day}`, symTicks);
        }
      };

      const fetches: Promise<void>[] = [];
      if (equitySyms.length > 0) fetches.push(fetchBatch(equitySyms, this.dataset));
      if (optionSyms.length > 0) fetches.push(fetchBatch(optionSyms, this.optionsDataset));
      await Promise.all(fetches);
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
      volume: 0, // tick-level volume not available from quote data
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
    _symbol: string,
    _expiry: string,
    _optionType: 'CALL' | 'PUT',
    _at: Date,
  ): Promise<OptionsChain> {
    // No real options data available yet (need OPRA feed)
    throw new Error('[MarketData] Options chain data not available — requires OPRA data feed');
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

    const dataset = isOccOptionSymbol(symbol) ? this.optionsDataset : this.dataset;
    const ticks = await loadQuoteTapeForDay({
      apiKey: this.apiKey,
      dataset,
      symbols: [symbol],
      day,
      refreshCache: this.refreshCache,
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

  /** Log per-symbol data quality summary. Call after backtest loop completes. */
  printDataSummary(): void {
    // Group dayTicks by symbol
    const bySymbol = new Map<string, { days: number; emptyDays: number; totalTicks: number }>();

    for (const [key, ticks] of this.dayTicks) {
      const symbol = key.split(':')[0];
      let entry = bySymbol.get(symbol);
      if (!entry) { entry = { days: 0, emptyDays: 0, totalTicks: 0 }; bySymbol.set(symbol, entry); }
      entry.days++;
      entry.totalTicks += ticks.length;
      if (ticks.length === 0) entry.emptyDays++;
    }

    if (bySymbol.size === 0) return;

    log.info('QuoteTape Data Summary:');
    const sorted = [...bySymbol.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [symbol, { days, emptyDays, totalTicks }] of sorted) {
      const status = emptyDays === days ? '!! ALL EMPTY' : emptyDays > 0 ? `! ${emptyDays} empty` : 'ok';
      log.info(`  ${symbol.padEnd(8)} ${totalTicks.toLocaleString().padStart(8)} ticks across ${days - emptyDays}/${days} days  ${status}`);
    }
  }
}
