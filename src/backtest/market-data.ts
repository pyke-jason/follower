import type { Quote, OptionsChain, OptionsStrike, Bar } from '../broker/types.js';
import {
  loadChainDefinitions, toDateKey, getFetchMeta,
  fetchTickWindow, defaultSchemaForDataset,
  mergeRanges, isRangeCovered,
} from './databento-tape.js';
import type { QuoteTick, TickCacheData } from './databento-tape.js';
import {
  readCachedRanges, readCachedTicks, writeCachedTicks,
  loadCachedChain, saveCachedChain,
} from './tick-cache-db.js';
import type { TickCacheDB } from './tick-cache-db.js';
import { isOccOptionSymbol, parseOccSymbol, buildOccSymbols } from './occ-symbology.js';
import { getPreviousTradingDayKey, dayBoundsUTC, isTradingDay } from '../lib/et-date.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('MarketData');

/**
 * MarketDataProvider: Abstraction for getting price data at a point in time.
 */
export interface MarketDataProvider {
  /** Get a quote for a symbol at a point in time.
   *  optionsMaxLookbackMins overrides the default 300-min cap for option lookback.
   *  Execution paths pass 5 for tight freshness; valuation uses the wide default. */
  getQuote(symbol: string, at: Date, optionsMaxLookbackMins?: number): Promise<Quote>;
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
 * DatabentoMarketDataProvider: Uses Databento historical data for real market
 * prices. Ticks are fetched in narrow windows (not full days) and cached via
 * an interval-merging SQLite DB + memory cache. All lookups respect the sim clock.
 */
export class DatabentoMarketDataProvider implements BacktestPriceProvider {
  /** symbol -> interval-cached ticks (in-memory on top of DB cache) */
  private tickCache = new Map<string, TickCacheData>();
  /** symbol -> most recent mid price (for getPriceSnapshot) */
  private latestQuotes = new Map<string, number>();
  /** "SYMBOL:EXPIRY:TYPE:TIMESTAMP_MS" -> assembled chain snapshot */
  private chainCache = new Map<string, OptionsChain>();

  constructor(
    private apiKey: string,
    private tickCacheDb: TickCacheDB,
    private dataset: string = 'DBEQ.BASIC',
    private refreshCache: boolean = false,
    private optionsDataset: string = 'OPRA.PILLAR',
  ) {}

  /**
   * Prefetch data for multiple symbols at a point in time.
   * Fetches a 1-minute window around `at` for each uncached symbol.
   */
  async prefetch(symbols: string[], at: Date): Promise<void> {
    const windowStart = new Date(at.getTime() - 60_000);
    const windowEnd = new Date(at.getTime() + 60_000);

    const equitySyms = symbols.filter(s => !isOccOptionSymbol(s));
    const optionSyms = symbols.filter(s => isOccOptionSymbol(s));

    const fetches: Promise<void>[] = [];
    if (equitySyms.length > 0) fetches.push(this.ensureRangeBatch(equitySyms, windowStart, windowEnd, this.dataset));
    if (optionSyms.length > 0) fetches.push(this.ensureRangeBatch(optionSyms, windowStart, windowEnd, this.optionsDataset));
    await Promise.all(fetches);

    // Update latestQuotes
    for (const sym of symbols) {
      const entry = this.tickCache.get(sym);
      if (!entry || entry.ticks.length === 0) continue;
      const tick = this.findLastTickBefore(entry.ticks, at);
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

  /**
   * Expanding lookback windows (minutes). Keeps widening until a tick is found.
   * Covers: intraday → same day → multi-day (accounts for weekends/holidays).
   */
  private static readonly LOOKBACK_MINUTES = [
    1, 2, 5, 10, 30,        // intraday
    60, 300, 600,            // 1hr, 5hr, 10hr
    1_440, 4_320, 14_400,   // 1d, 3d, 10d
  ];

  async getQuote(symbol: string, at: Date, optionsMaxLookbackMins?: number): Promise<Quote> {
    const atMs = at.getTime();
    const optionCap = optionsMaxLookbackMins ?? 300;

    const isOption = isOccOptionSymbol(symbol);
    let lastCheckedMins = 0;
    for (const mins of DatabentoMarketDataProvider.LOOKBACK_MINUTES) {
      if (isOption && mins > optionCap) break;
      lastCheckedMins = mins;
      const windowStart = new Date(atMs - mins * 60_000);
      const windowEnd = new Date(atMs + 60_000);
      // ensureRange fetches+caches data for this window
      await this.ensureRange(symbol, windowStart, windowEnd);
      // Search ALL cached ticks, not just the window-filtered subset.
      // Databento cbbo-1s reports ts_event = when the quote was established, not the
      // snapshot second. For illiquid options the BBO may persist for hours, so a tick
      // timestamped well before the window can still be the best available quote.
      // The expanding lookback still controls staleness: we only accept a tick if its
      // age is within the current window (so execution paths with 5-min cap won't use
      // a 60-min-old tick, but valuation paths with 60-min cap will).
      const entry = this.tickCache.get(symbol);
      if (entry) {
        const tick = this.findLastTickBefore(entry.ticks, at);
        if (tick) {
          const tickAgeMins = (atMs - tick.timestamp.getTime()) / 60_000;
          if (tickAgeMins <= mins) {
            if (tickAgeMins >= 1_440) {
              log.warn(`Stale quote for "${symbol}" at ${at.toISOString()}: tick is ${tickAgeMins.toFixed(0)} min old`);
            }
            return this.makeQuote(symbol, tick);
          }
          // tick exists but too stale for this window — try wider window
        }
      }
    }

    const meta = getFetchMeta(symbol);
    const fetchCtx = meta
      ? `Fetch: status=${meta.status} bytes=${meta.bytes} records=${meta.records}${meta.requestId ? ` req=${meta.requestId}` : ''}`
      : 'No fetch metadata found — check QuoteTape logs above.';
    throw new Error(
      `[MarketData] No Databento data for "${symbol}" at or before ${at.toISOString()} ` +
      `(checked ${lastCheckedMins || optionCap} min lookback).\n` +
      `  ${fetchCtx}`,
    );
  }

  private makeQuote(symbol: string, tick: QuoteTick): Quote {
    const mid = (tick.bid + tick.ask) / 2;
    this.latestQuotes.set(symbol, mid);
    return { symbol, bid: tick.bid, ask: tick.ask, last: mid, volume: 0, timestamp: tick.timestamp.toISOString() };
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
    if (tradingDays.length === 0) return [];

    // Fetch via unified cache with ohlcv-1d schema.
    // dayBoundsUTC range covers all ts_event values (next-day midnight UTC convention).
    const { start } = dayBoundsUTC(tradingDays[0]);
    const end = dayBoundsUTC(tradingDays[tradingDays.length - 1]).end;
    await this.ensureRange(symbol, start, end, 'ohlcv-1d');

    // Map cached QuoteTicks → Bars for matching trading days
    const entry = this.tickCache.get(`${symbol}:ohlcv-1d`);
    if (!entry) return [];

    // Deduplicate: DBEQ.BASIC may return multiple ohlcv-1d records per day
    // (different exchange feeds). Keep the highest-volume bar per trading day.
    const tradingDaySet = new Set(tradingDays);
    const bestByDay = new Map<string, Bar>();
    for (const tick of entry.ticks) {
      const tickDay = toDateKey(tick.timestamp);
      if (!tradingDaySet.has(tickDay)) continue;
      const bar: Bar = {
        timestamp: tickDay,
        open: tick.open ?? tick.bid,
        high: tick.ask,
        low: tick.bid,
        close: tick.close ?? (tick.bid + tick.ask) / 2,
        volume: tick.volume ?? 0,
      };
      const existing = bestByDay.get(tickDay);
      if (!existing || bar.volume > existing.volume) {
        bestByDay.set(tickDay, bar);
      }
    }
    const bars = tradingDays
      .map(d => bestByDay.get(d))
      .filter((b): b is Bar => b != null);

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

    // Phase 2: Fetch prices for constructed symbols via narrow window.
    const allTicks: QuoteTick[] = [];
    const uncachedSymbols: string[] = [];
    const startMs = at.getTime() - 60_000;
    const endMs = at.getTime() + 60_000;

    for (const sym of candidateSymbols) {
      const entry = this.tickCache.get(sym);
      if (entry && isRangeCovered(entry.ranges, startMs, endMs)) {
        allTicks.push(...entry.ticks);
      } else {
        uncachedSymbols.push(sym);
      }
    }

    if (uncachedSymbols.length > 0) {
      await this.ensureRangeBatch(
        uncachedSymbols,
        new Date(startMs),
        new Date(endMs),
        this.optionsDataset,
        'raw_symbol',
      );

      // Collect ticks from freshly cached entries
      for (const sym of uncachedSymbols) {
        const entry = this.tickCache.get(sym);
        if (entry) allTicks.push(...entry.ticks);
      }
    }

    // Build latest tick per strike at or before `at`
    const strikes = this.buildStrikesFromTicks(allTicks, at);

    if (strikes.length > 0) {
      const chain: OptionsChain = { symbol, expiry, optionType, strikes };
      this.chainCache.set(chainKey, chain);
      return chain;
    }

    // Fallback: constructed symbols returned nothing — wrong expiry?
    log.debug(`${symbol} chain: 0 strikes from constructed symbols, falling back to definition fetch`);
    const definitions = await loadChainDefinitions({
      apiKey: this.apiKey,
      dataset: this.optionsDataset,
      parentSymbol: `${symbol}.OPT`,
      day,
      refreshCache: this.refreshCache,
      db: this.tickCacheDb,
    });

    const callPutFilter = optionType === 'CALL' ? 'C' as const : 'P' as const;
    const expiries = new Set(definitions.filter(d => d.callPut === callPutFilter).map(d => d.expiry));
    log.debug(`${symbol} available ${optionType} expiries: ${[...expiries].sort().slice(0, 10).join(', ')}`);
    const emptyChain: OptionsChain = { symbol, expiry, optionType, strikes: [] };
    return emptyChain;
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
    await this.ensureRange(symbol, from, to);
    const entry = this.tickCache.get(symbol);
    if (!entry) return [];
    const fromMs = from.getTime();
    const toMs = to.getTime();
    return entry.ticks.filter(t => {
      const ms = t.timestamp.getTime();
      return ms >= fromMs && ms <= toMs;
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Ensure ticks for [start, end] are in the interval cache. Checks memory,
   * then DB, then fetches from Databento via fetchTickWindow.
   * Returns ticks filtered to [start, end].
   */
  private async ensureRange(symbol: string, start: Date, end: Date, schemaOverride?: string): Promise<QuoteTick[]> {
    const startMs = start.getTime();
    const endMs = end.getTime();

    const dataset = isOccOptionSymbol(symbol) ? this.optionsDataset : this.dataset;
    const schema = schemaOverride ?? defaultSchemaForDataset(dataset);
    // Separate in-memory key when using non-default schema (e.g. ohlcv-1d vs ohlcv-1m)
    const memKey = schemaOverride ? `${symbol}:${schemaOverride}` : symbol;

    // 1. Check in-memory cache
    let entry = this.tickCache.get(memKey);
    if (entry && isRangeCovered(entry.ranges, startMs, endMs)) {
      return this.filterTicks(entry.ticks, startMs, endMs);
    }

    // 2. Check DB cache
    if (!entry) {
      const [dbRanges, dbTicks] = await Promise.all([
        readCachedRanges(this.tickCacheDb, dataset, schema, symbol),
        readCachedTicks(this.tickCacheDb, symbol, schema),
      ]);
      if (dbRanges.length > 0 || dbTicks.length > 0) {
        entry = { ranges: dbRanges, ticks: dbTicks };
        this.tickCache.set(memKey, entry);
        if (isRangeCovered(entry.ranges, startMs, endMs)) {
          return this.filterTicks(entry.ticks, startMs, endMs);
        }
      }
    }

    // 3. Fetch from API
    let newTicks: QuoteTick[];
    try {
      newTicks = await fetchTickWindow({
        apiKey: this.apiKey,
        dataset,
        schema,
        symbols: [symbol],
        start,
        end,
        stypeIn: isOccOptionSymbol(symbol) ? 'raw_symbol' : undefined,
      });
    } catch (err) {
      throw new Error(`[ensureRange] Failed to fetch ${symbol} ${start.toISOString()}..${end.toISOString()}: ${err instanceof Error ? err.message : err}`);
    }

    // 4. Don't cache empty results on trading days (transient API issue — force retry)
    if (newTicks.length === 0 && isTradingDay(start)) {
      if (!entry) return [];
      return this.filterTicks(entry.ticks, startMs, endMs);
    }

    // 5. Merge into memory cache + write DB
    const existing = entry ?? { ranges: [], ticks: [] };
    const mergedRanges = mergeRanges(existing.ranges, [startMs, endMs]);
    const merged = this.mergeTicks(existing.ticks, newTicks);
    const updated: TickCacheData = { ranges: mergedRanges, ticks: merged };
    this.tickCache.set(memKey, updated);
    await writeCachedTicks(this.tickCacheDb, dataset, schema, symbol, newTicks, [startMs, endMs]);

    return this.filterTicks(merged, startMs, endMs);
  }

  /**
   * Batch version of ensureRange: fetches multiple symbols in a single API call.
   * Used by prefetch() and getOptionsChain().
   */
  private async ensureRangeBatch(
    symbols: string[],
    start: Date,
    end: Date,
    dataset: string,
    stypeIn?: 'raw_symbol',
  ): Promise<void> {
    const startMs = start.getTime();
    const endMs = end.getTime();
    const schema = defaultSchemaForDataset(dataset);

    // Find which symbols need fetching
    const uncached: string[] = [];
    for (const symbol of symbols) {
      // Check in-memory
      const memEntry = this.tickCache.get(symbol);
      if (memEntry && isRangeCovered(memEntry.ranges, startMs, endMs)) continue;

      // Check DB
      if (!memEntry) {
        const [dbRanges, dbTicks] = await Promise.all([
          readCachedRanges(this.tickCacheDb, dataset, schema, symbol),
          readCachedTicks(this.tickCacheDb, symbol, schema),
        ]);
        if (dbRanges.length > 0 || dbTicks.length > 0) {
          const dbEntry: TickCacheData = { ranges: dbRanges, ticks: dbTicks };
          this.tickCache.set(symbol, dbEntry);
          if (isRangeCovered(dbEntry.ranges, startMs, endMs)) continue;
        }
      }

      uncached.push(symbol);
    }

    if (uncached.length === 0) return;

    // Single API call for all uncached symbols
    let newTicks: QuoteTick[];
    try {
      newTicks = await fetchTickWindow({
        apiKey: this.apiKey,
        dataset,
        schema,
        symbols: uncached,
        start,
        end,
        stypeIn,
      });
    } catch (err) {
      log.warn(`[ensureRangeBatch] Failed: ${uncached.join(',')} — ${err instanceof Error ? err.message : err}`);
      return;
    }

    // Bucket by symbol
    const bySymbol = new Map<string, QuoteTick[]>();
    for (const sym of uncached) bySymbol.set(sym, []);
    for (const tick of newTicks) {
      let bucket = bySymbol.get(tick.symbol);
      if (!bucket) { bucket = []; bySymbol.set(tick.symbol, bucket); }
      bucket.push(tick);
    }

    // Merge each symbol into its cache
    for (const [symbol, symTicks] of bySymbol) {
      const existing = this.tickCache.get(symbol) ?? { ranges: [], ticks: [] };

      // Skip caching empty results on trading days (transient API issue)
      if (symTicks.length === 0 && isTradingDay(start)) continue;

      const mergedRanges = mergeRanges(existing.ranges, [startMs, endMs]);
      const merged = this.mergeTicks(existing.ticks, symTicks);
      const updated: TickCacheData = { ranges: mergedRanges, ticks: merged };
      this.tickCache.set(symbol, updated);

      await writeCachedTicks(this.tickCacheDb, dataset, schema, symbol, symTicks, [startMs, endMs]);
    }
  }

  /** Merge two tick arrays, deduplicate by symbol+timestamp, sort. */
  private mergeTicks(existing: QuoteTick[], newTicks: QuoteTick[]): QuoteTick[] {
    if (newTicks.length === 0) return existing;
    if (existing.length === 0) {
      newTicks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      return newTicks;
    }
    const seen = new Set<string>();
    const result: QuoteTick[] = [];
    for (const tick of existing) {
      const k = `${tick.symbol}:${tick.timestamp.getTime()}`;
      if (!seen.has(k)) { seen.add(k); result.push(tick); }
    }
    for (const tick of newTicks) {
      const k = `${tick.symbol}:${tick.timestamp.getTime()}`;
      if (!seen.has(k)) { seen.add(k); result.push(tick); }
    }
    result.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return result;
  }

  /** Filter ticks to [startMs, endMs]. */
  private filterTicks(ticks: QuoteTick[], startMs: number, endMs: number): QuoteTick[] {
    return ticks.filter(t => {
      const ms = t.timestamp.getTime();
      return ms >= startMs && ms <= endMs;
    });
  }

  /** Binary search: return the last tick with timestamp <= at, or null. */
  private findLastTickBefore(ticks: QuoteTick[], at: Date): QuoteTick | null {
    if (ticks.length === 0) return null;
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

    return result >= 0 ? ticks[result] : null;
  }

  /** Log per-symbol data quality summary. Call after backtest loop completes. */
  printDataSummary(): void {
    if (this.tickCache.size === 0) return;

    log.info('QuoteTape Data Summary:');
    const sorted = [...this.tickCache.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [symbol, entry] of sorted) {
      const status = entry.ticks.length === 0 ? '!! EMPTY' : 'ok';
      log.info(`  ${symbol.padEnd(25)} ${entry.ticks.length.toLocaleString().padStart(8)} ticks  ${entry.ranges.length} ranges  ${status}`);
    }
  }
}
