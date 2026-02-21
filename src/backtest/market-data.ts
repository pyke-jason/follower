import type { Quote, OptionsChain, OptionsStrike, Bar } from '../broker/types.js';
import { loadQuoteTapeForDay, loadDailyBars, loadChainDefinitions, loadSpecificContracts, toDateKey, getFetchMeta } from './databento-tape.js';
import type { QuoteTick } from './databento-tape.js';
import { isOccOptionSymbol, parseOccSymbol, buildOccSymbols } from './occ-symbology.js';
import { getPreviousTradingDayKey, parseDateKey } from '../lib/et-date.js';
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
  /** "SYMBOL:YYYY-MM-DD" -> aggregated daily bar (immutable past days only) */
  /** "SYMBOL:EXPIRY:TYPE:TIMESTAMP_MS" -> assembled chain snapshot */
  private chainCache = new Map<string, OptionsChain>();

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
        let ticks: QuoteTick[];
        try {
          ticks = await loadQuoteTapeForDay({
            apiKey: this.apiKey,
            dataset,
            symbols: syms,
            day,
            refreshCache: this.refreshCache,
          });
        } catch (err) {
          log.warn(`[prefetch] Failed: ${syms.join(',')} ${day} — ${err instanceof Error ? err.message : err}`);
          // Do NOT cache failure as empty array — next call should retry
          return;
        }

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

  /** Max previous trading days to search for a stale quote when current day has no tick yet. */
  private static readonly MAX_STALE_DAYS = 5;

  async getQuote(symbol: string, at: Date): Promise<Quote> {
    const ticks = await this.loadDay(symbol, at);
    const tick = this.findLastTickBefore(ticks, at);

    if (tick) {
      const mid = (tick.bid + tick.ask) / 2;
      this.latestQuotes.set(symbol, mid);
      return {
        symbol,
        bid: tick.bid,
        ask: tick.ask,
        last: mid,
        volume: 0,
        timestamp: tick.timestamp.toISOString(),
      };
    }

    // Fallback: walk back previous trading days for the last known quote.
    // Handles illiquid options that haven't traded yet in the current session.
    const currentDayKey = toDateKey(at);
    let prevDayKey = getPreviousTradingDayKey(currentDayKey);

    for (let i = 0; i < DatabentoMarketDataProvider.MAX_STALE_DAYS && prevDayKey; i++) {
      const prevDate = parseDateKey(prevDayKey);
      let prevTicks: QuoteTick[];
      try {
        prevTicks = await this.loadDay(symbol, prevDate);
      } catch {
        prevDayKey = getPreviousTradingDayKey(prevDayKey);
        continue;
      }

      if (prevTicks.length > 0) {
        const lastTick = prevTicks[prevTicks.length - 1];
        const mid = (lastTick.bid + lastTick.ask) / 2;
        this.latestQuotes.set(symbol, mid);

        log.warn(
          `Stale quote for "${symbol}" at ${at.toISOString()}: ` +
          `using ${prevDayKey} tick from ${lastTick.timestamp.toISOString()} ` +
          `(${currentDayKey} has ${ticks.length} ticks` +
          `${ticks.length > 0 ? `, first at ${ticks[0].timestamp.toISOString()}` : ''})`,
        );

        return {
          symbol,
          bid: lastTick.bid,
          ask: lastTick.ask,
          last: mid,
          volume: 0,
          timestamp: lastTick.timestamp.toISOString(),
        };
      }

      prevDayKey = getPreviousTradingDayKey(prevDayKey);
    }

    // No data within lookback — throw with diagnostics
    const day = toDateKey(at);
    const meta = getFetchMeta(symbol, day);
    const fetchCtx = meta
      ? `Fetch: status=${meta.status} bytes=${meta.bytes} records=${meta.records}${meta.requestId ? ` req=${meta.requestId}` : ''}`
      : 'No fetch metadata found — check QuoteTape logs above.';
    throw new Error(
      `[MarketData] No Databento data for "${symbol}" at or before ${at.toISOString()} ` +
      `(checked ${DatabentoMarketDataProvider.MAX_STALE_DAYS} previous trading days).\n` +
      `  Day has ${ticks.length} ticks${ticks.length > 0 ? ` (first: ${ticks[0].timestamp.toISOString()})` : ''}. ${fetchCtx}`,
    );
  }

  async getBars(symbol: string, barsBack: number, at: Date): Promise<Bar[]> {
    const atDay = toDateKey(at);

    // Build list of trading days (oldest → newest), skipping weekends/holidays
    const tradingDays: string[] = [];
    let dayKey: string | null = atDay;
    const needed = barsBack + 1; // +1 for current day
    for (let i = 0; i < needed && dayKey; i++) {
      tradingDays.unshift(dayKey);
      dayKey = getPreviousTradingDayKey(dayKey);
    }

    // Single API call via ohlcv-1d — ~15 rows instead of ~6,000 via ohlcv-1m
    const bars = await loadDailyBars({
      apiKey: this.apiKey,
      dataset: this.dataset,
      symbol,
      days: tradingDays,
      refreshCache: this.refreshCache,
    });

    log.debug(`${symbol} bars: ${bars.length} daily bars for ${tradingDays.length} trading days`);
    return bars.slice(-barsBack);
  }

  async getOptionsChain(
    symbol: string,
    expiry: string,
    optionType: 'CALL' | 'PUT',
    at: Date,
  ): Promise<OptionsChain> {
    const day = toDateKey(at);

    // Return cached snapshot if same symbol/expiry/type/timestamp
    const chainKey = `${symbol}:${expiry}:${optionType}:${at.getTime()}`;
    const cachedChain = this.chainCache.get(chainKey);
    if (cachedChain) return cachedChain;

    // Get underlying price for strike filtering
    let underlyingPrice: number;
    try {
      const quote = await this.getQuote(symbol, at);
      underlyingPrice = (quote.bid + quote.ask) / 2;
    } catch (err) {
      throw new Error(
        `[MarketData] Cannot get underlying price for ${symbol} at ${at.toISOString()} — ` +
        `needed for options chain strike filtering. ${err instanceof Error ? err.message : err}`,
      );
    }

    const strikeLow = underlyingPrice * 0.8;
    const strikeHigh = underlyingPrice * 1.2;

    // Phase 1: Construct candidate OCC symbols directly (no API call).
    // Standard strike intervals based on price — some may not exist, that's fine.
    const candidateSymbols = buildOccSymbols({
      underlying: symbol,
      expiry,
      optionType,
      priceLow: strikeLow,
      priceHigh: strikeHigh,
    });

    log.debug(
      `${symbol} chain: ${candidateSymbols.length} constructed OCC symbols for ` +
      `${optionType} ${expiry} strikes ${strikeLow.toFixed(0)}-${strikeHigh.toFixed(0)}`,
    );

    // Phase 2: Fetch prices for constructed symbols.
    // Check in-memory cache first to avoid redundant disk I/O on repeat calls.
    const allTicks: QuoteTick[] = [];
    const uncachedSymbols: string[] = [];
    for (const sym of candidateSymbols) {
      const cached = this.dayTicks.get(`${sym}:${day}`);
      if (cached) {
        allTicks.push(...cached);
      } else {
        uncachedSymbols.push(sym);
      }
    }

    if (uncachedSymbols.length > 0) {
      const freshTicks = await loadSpecificContracts({
        apiKey: this.apiKey,
        dataset: this.optionsDataset,
        symbols: uncachedSymbols,
        day,
        refreshCache: this.refreshCache,
      });
      allTicks.push(...freshTicks);

      // Cache individual OCC symbol ticks so getQuote(occSymbol) works later
      this.cacheOccTicks(freshTicks, day);
    }

    // Build latest tick per strike at or before `at`
    const strikes = this.buildStrikesFromTicks(allTicks, at);

    if (strikes.length > 0) {
      const chain: OptionsChain = { symbol, expiry, optionType, strikes };
      this.chainCache.set(chainKey, chain);
      return chain;
    }

    // Fallback: constructed symbols returned nothing — wrong expiry?
    // Use definition fetch to discover available expiries.
    log.debug(`${symbol} chain: 0 strikes from constructed symbols, falling back to definition fetch`);
    const definitions = await loadChainDefinitions({
      apiKey: this.apiKey,
      dataset: this.optionsDataset,
      parentSymbol: `${symbol}.OPT`,
      day,
      refreshCache: this.refreshCache,
    });

    const callPutFilter = optionType === 'CALL' ? 'C' as const : 'P' as const;
    const expiries = new Set(definitions.filter(d => d.callPut === callPutFilter).map(d => d.expiry));
    log.debug(`${symbol} available ${optionType} expiries: ${[...expiries].sort().slice(0, 10).join(', ')}`);
    const emptyChain: OptionsChain = { symbol, expiry, optionType, strikes: [] };
    // Don't cache empty results — may resolve on retry with different timestamp
    return emptyChain;
  }

  /**
   * Cache individual OCC symbol ticks from a batch fetch (loadSpecificContracts)
   * into the dayTicks map so subsequent getQuote(occSymbol) calls find them.
   */
  private cacheOccTicks(ticks: QuoteTick[], day: string): void {
    const bySymbol = new Map<string, QuoteTick[]>();
    for (const tick of ticks) {
      let bucket = bySymbol.get(tick.symbol);
      if (!bucket) { bucket = []; bySymbol.set(tick.symbol, bucket); }
      bucket.push(tick);
    }
    for (const [sym, symTicks] of bySymbol) {
      const key = `${sym}:${day}`;
      const existing = this.dayTicks.get(key);
      // Override if not cached or if previously cached as empty (failed individual fetch)
      if (!existing || existing.length === 0) {
        symTicks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        this.dayTicks.set(key, symTicks);
      }
    }
  }

  /** Extract latest bid/ask per strike from ticks at or before a timestamp. */
  private buildStrikesFromTicks(ticks: QuoteTick[], at: Date): OptionsStrike[] {
    const targetMs = at.getTime();
    const latestByStrike = new Map<number, QuoteTick>();

    for (const tick of ticks) {
      if (tick.timestamp.getTime() > targetMs) continue;

      const parts = parseOccSymbol(tick.symbol);
      if (!parts) continue;

      const existing = latestByStrike.get(parts.strike);
      if (!existing || tick.timestamp.getTime() > existing.timestamp.getTime()) {
        latestByStrike.set(parts.strike, tick);
      }
    }

    const strikes: OptionsStrike[] = [];
    for (const [strike, tick] of latestByStrike) {
      const mid = (tick.bid + tick.ask) / 2;
      strikes.push({ strike, bid: tick.bid, ask: tick.ask, last: mid });
    }
    strikes.sort((a, b) => a.strike - b.strike);
    return strikes;
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
    let ticks: QuoteTick[];
    try {
      ticks = await loadQuoteTapeForDay({
        apiKey: this.apiKey,
        dataset,
        symbols: [symbol],
        day,
        refreshCache: this.refreshCache,
      });
    } catch (err) {
      // Do NOT cache failure as empty array — next call should retry
      throw new Error(`[loadDay] Failed to load ${symbol} ${day}: ${err instanceof Error ? err.message : err}`);
    }

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
