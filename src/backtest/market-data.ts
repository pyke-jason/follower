import type { OptionType } from '../lib/enums.js';
import type { Quote, OptionsChain, OptionsStrike } from '../broker/types.js';
import {
  getFetchMeta,
  fetchTickWindow, defaultSchemaForDataset,
  mergeRanges, isRangeCovered, getUncoveredGaps,
  DatabentoClientError,
} from './databento-tape.js';
import type { QuoteTick, TickCacheData } from './databento-tape.js';
import type { TickCacheStore } from './tick-cache-store.js';
import { isOccOptionSymbol, parseOccSymbol, buildOccSymbols, formatOccSymbol } from '../lib/occ-symbology.js';
import { isTradingDay } from '../lib/et-date.js';
import { createLogger } from '../lib/logger.js';
import { DependencyUnavailableError, QuoteResolutionError, QuoteUnavailableError } from '../lib/errors.js';
import { formatLogTimestampET } from '../lib/et-logging.js';

const log = createLogger('MarketData');

/** Returns true if the date is more than 48h in the past (data finalized, safe to cache empty). */
function isHistoricalDate(d: Date): boolean {
  return Date.now() - d.getTime() > 48 * 60 * 60 * 1000;
}

/** Snap ms timestamp down to the start of its minute. */
function snapToMinuteFloor(ms: number): number {
  return ms - (ms % 60_000);
}

/** Snap ms timestamp up to the start of the next minute (no-op if already aligned). */
function snapToMinuteCeil(ms: number): number {
  const rem = ms % 60_000;
  return rem === 0 ? ms : ms + (60_000 - rem);
}

/**
 * MarketDataProvider: Abstraction for getting price data at a point in time.
 */
export interface MarketDataProvider {
  /** Get a quote for a symbol at a point in time.
   *  optionsMaxLookbackMins overrides the default 300-min cap for option lookback.
   *  Execution paths pass 5 for tight freshness; valuation uses the wide default. */
  getQuote(symbol: string, at: Date, optionsMaxLookbackMins?: number): Promise<Quote>;
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
 * an interval-merging persistent store + memory cache. All lookups respect the sim clock.
 */
export class DatabentoMarketDataProvider implements BacktestPriceProvider {
  /** symbol -> interval-cached ticks (in-memory on top of DB cache) */
  private tickCache = new Map<string, TickCacheData>();
  /** symbol -> most recent mid price (for getPriceSnapshot) */
  private latestQuotes = new Map<string, number>();
  /** "SYMBOL:EXPIRY:TYPE:TIMESTAMP_MS" -> assembled chain snapshot */
  private chainCache = new Map<string, OptionsChain>();
  /** Symbols that returned a Databento 4xx — skip for the rest of this backtest run. */
  private deadSymbols = new Set<string>();

  constructor(
    private apiKey: string,
    private tickCacheStore: TickCacheStore,
    private dataset: string = 'DBEQ.BASIC',
    private refreshCache: boolean = false,
    private optionsDataset: string = 'OPRA.PILLAR',
    private onDependencyUnavailable?: (err: DependencyUnavailableError) => Promise<void>,
  ) {}

  /**
   * Prefetch data for multiple symbols at a point in time.
   * Fetches a 1-minute window around `at` for each uncached symbol.
   */
  async prefetch(symbols: string[], at: Date): Promise<void> {
    const atMs = at.getTime();
    const windowStart = new Date(snapToMinuteFloor(atMs - 60_000));
    const windowEnd   = new Date(snapToMinuteCeil(atMs + 60_000));

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

    // Short-circuit: if memory cache already has a tick within 1 min, skip ensureRange entirely
    const cached = this.tickCache.get(symbol);
    if (cached && cached.ticks.length > 0) {
      const tick = this.findLastTickBefore(cached.ticks, at);
      if (tick) {
        const ageMs = atMs - tick.timestamp.getTime();
        if (ageMs >= 0 && ageMs <= 60_000) {
          return this.makeQuote(symbol, tick);
        }
      }
    }

    let lastCheckedMins = 0;
    let foundTick: QuoteTick | null = null;
    for (const mins of DatabentoMarketDataProvider.LOOKBACK_MINUTES) {
      if (isOption && mins > optionCap) break;
      lastCheckedMins = mins;

      // Only fetch if we haven't found a tick yet. Once a tick is found,
      // wider windows won't discover a newer one — just widen staleness acceptance.
      if (!foundTick) {
        const windowStart = new Date(snapToMinuteFloor(atMs - mins * 60_000));
        const windowEnd   = new Date(snapToMinuteCeil(atMs + 60_000));
        await this.ensureRange(symbol, windowStart, windowEnd);
        const entry = this.tickCache.get(symbol);
        if (entry) {
          foundTick = this.findLastTickBefore(entry.ticks, at);
        }
      }

      if (foundTick) {
        const tickAgeMins = (atMs - foundTick.timestamp.getTime()) / 60_000;
        if (tickAgeMins <= mins) {
          if (tickAgeMins >= 1_440) {
            log.warn(`Stale quote for "${symbol}" at ${formatLogTimestampET(at)} ET: tick is ${tickAgeMins.toFixed(0)} min old`);
          }
          return this.makeQuote(symbol, foundTick);
        }
      }
    }

    const meta = getFetchMeta(symbol);
    const fetchCtx = meta
      ? `Fetch: status=${meta.status} bytes=${meta.bytes} records=${meta.records}${meta.requestId ? ` req=${meta.requestId}` : ''}`
      : 'No fetch metadata found — check QuoteTape logs above.';
    throw new QuoteUnavailableError(
      symbol,
      `No Databento data at or before ${at.toISOString()} (checked ${lastCheckedMins || optionCap} min lookback). ${fetchCtx}`,
    );
  }

  private makeQuote(symbol: string, tick: QuoteTick): Quote {
    const mid = (tick.bid + tick.ask) / 2;
    this.latestQuotes.set(symbol, mid);
    return { symbol, bid: tick.bid, ask: tick.ask, last: mid, volume: 0, timestamp: tick.timestamp.toISOString() };
  }

  async getOptionsChain(
    symbol: string,
    expiry: string,
    optionType: OptionType,
    at: Date,
  ): Promise<OptionsChain> {
    // Return cached snapshot if same symbol/expiry/type/timestamp
    const chainKey = `${symbol}:${expiry}:${optionType}:${at.getTime()}`;
    const cachedChain = this.chainCache.get(chainKey);
    if (cachedChain) return cachedChain;

    // Get underlying price for strike filtering
    let underlyingPrice: number;
    const quote = await this.getQuote(symbol, at);
    underlyingPrice = (quote.bid + quote.ask) / 2;

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
    const startMs = snapToMinuteFloor(at.getTime() - 60_000);
    const endMs   = snapToMinuteCeil(at.getTime() + 60_000);

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

    const chain: OptionsChain = { symbol, expiry, optionType, strikes };
    if (strikes.length > 0) {
      this.chainCache.set(chainKey, chain);
    }
    return chain;
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

  private async waitForDependency(err: DependencyUnavailableError): Promise<void> {
    if (!this.onDependencyUnavailable) throw err;
    await this.onDependencyUnavailable(err);
  }

  /**
   * Ensure ticks for [start, end] are in the interval cache. Checks memory,
   * then DB, then fetches from Databento via fetchTickWindow.
   * Returns ticks filtered to [start, end].
   */
  private async ensureRange(symbol: string, start: Date, end: Date, schemaOverride?: string): Promise<QuoteTick[]> {
    if (this.deadSymbols.has(symbol)) {
      throw new QuoteResolutionError(
        `[MarketData] "${symbol}" skipped — prior 4xx blacklisted it this run`,
        symbol,
      );
    }

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

    // 2. Refresh from the persistent cache. Even when we already have an in-memory
    // entry, another earlier run may have written newer ranges.
    if (!this.refreshCache) {
      entry = await this.refreshEntryFromDb(memKey, dataset, schema, symbol);
      if (entry && isRangeCovered(entry.ranges, startMs, endMs)) {
        return this.filterTicks(entry.ticks, startMs, endMs);
      }
    }

    // 3. Compute uncovered gaps — only fetch what's missing
    const existingRanges = entry?.ranges ?? [];
    const gaps = getUncoveredGaps(existingRanges, startMs, endMs);

    if (gaps.length === 0) {
      // Fully covered (multi-interval coverage that isRangeCovered missed)
      return this.filterTicks(entry!.ticks, startMs, endMs);
    }

    // 4. Fetch each gap from API
    for (const [gapStart, gapEnd] of gaps) {
      let newTicks: QuoteTick[];
      while (true) {
        try {
          newTicks = await fetchTickWindow({
            apiKey: this.apiKey,
            dataset,
            schema,
            symbols: [symbol],
            start: new Date(gapStart),
            end: new Date(gapEnd),
            stypeIn: isOccOptionSymbol(symbol) ? 'raw_symbol' : undefined,
          });
          break;
        } catch (err) {
          if (err instanceof DatabentoClientError && err.status >= 400 && err.status < 500) {
            this.deadSymbols.add(symbol);
            log.warn(`[MarketData] Blacklisting "${symbol}" after HTTP ${err.status} — won't retry this run`);
            if (err.status === 422) {
              throw new QuoteResolutionError(`[ensureRange] Failed to fetch ${symbol}: ${err.message}`, symbol);
            }
          }
          if (err instanceof DependencyUnavailableError) {
            await this.waitForDependency(err);
            continue;
          }
          throw new Error(`[ensureRange] Failed to fetch ${symbol} ${new Date(gapStart).toISOString()}..${new Date(gapEnd).toISOString()}: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Skip caching empty results for recent trading days (data may still arrive).
      // Historical dates (>48h old) are finalized — cache empty to prevent perpetual re-fetches.
      if (newTicks.length === 0 && isTradingDay(new Date(gapStart)) && !isHistoricalDate(new Date(gapEnd))) {
        continue;
      }

      // Merge this gap into cache immediately (so next gap sees updated state)
      const existing = this.tickCache.get(memKey) ?? { ranges: [], ticks: [] };
      const mergedRanges = mergeRanges(existing.ranges, [gapStart, gapEnd]);
      const merged = this.mergeTicks(existing.ticks, newTicks);
      const updated: TickCacheData = { ranges: mergedRanges, ticks: merged };
      this.tickCache.set(memKey, updated);
      const persisted = await this.tickCacheStore.writeCachedTicks(dataset, schema, symbol, newTicks, [gapStart, gapEnd]);
      if (!persisted) {
        log.warn(
          `Tick cache stayed busy; continuing without persisting ` +
          `${symbol} ${schema} ${new Date(gapStart).toISOString()}..${new Date(gapEnd).toISOString()}`,
        );
      }
    }

    // 5. Return filtered ticks from (now-updated) cache
    const final = this.tickCache.get(memKey);
    if (!final) {
      return entry ? this.filterTicks(entry.ticks, startMs, endMs) : [];
    }
    return this.filterTicks(final.ticks, startMs, endMs);
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
    schemaOverride?: string,
  ): Promise<void> {
    const startMs = start.getTime();
    const endMs = end.getTime();
    const schema = schemaOverride ?? defaultSchemaForDataset(dataset);

    // Find which symbols need fetching
    const uncached: string[] = [];
    for (const symbol of symbols) {
      if (this.deadSymbols.has(symbol)) continue;
      const memKey = schemaOverride ? `${symbol}:${schemaOverride}` : symbol;

      // Check in-memory
      let memEntry = this.tickCache.get(memKey);
      if (memEntry && isRangeCovered(memEntry.ranges, startMs, endMs)) continue;

      // Refresh from the persistent cache when memory is stale or incomplete.
      if (!this.refreshCache) {
        memEntry = await this.refreshEntryFromDb(memKey, dataset, schema, symbol);
        if (memEntry && isRangeCovered(memEntry.ranges, startMs, endMs)) continue;
      }

      uncached.push(symbol);
    }

    if (uncached.length === 0) return;

    // Single API call for all uncached symbols
    let newTicks: QuoteTick[];
    while (true) {
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
        break;
      } catch (err) {
        if (err instanceof DatabentoClientError && err.status >= 400 && err.status < 500) {
          // Batch 4xx: one bad symbol poisons the whole request. Fall back to per-symbol
          // fetches so good symbols still get cached and bad ones get blacklisted.
          log.warn(`[ensureRangeBatch] Batch HTTP ${err.status} on ${uncached.length} symbols — falling back to per-symbol fetch`);
          await Promise.allSettled(uncached.map(sym => this.ensureRange(sym, start, end, schemaOverride)));
          return;
        }
        if (err instanceof DependencyUnavailableError) {
          await this.waitForDependency(err);
          continue;
        }
        throw new Error(`[ensureRangeBatch] Failed for ${uncached.join(', ')}: ${err instanceof Error ? err.message : err}`);
      }
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
      const memKey = schemaOverride ? `${symbol}:${schemaOverride}` : symbol;
      const existing = this.tickCache.get(memKey) ?? { ranges: [], ticks: [] };

      // Skip caching empty results for recent trading days (data may still arrive).
      // Historical dates (>48h old) are finalized — cache empty to prevent perpetual re-fetches.
      if (symTicks.length === 0 && isTradingDay(start) && !isHistoricalDate(end)) continue;

      const mergedRanges = mergeRanges(existing.ranges, [startMs, endMs]);
      const merged = this.mergeTicks(existing.ticks, symTicks);
      const updated: TickCacheData = { ranges: mergedRanges, ticks: merged };
      this.tickCache.set(memKey, updated);

      const persisted = await this.tickCacheStore.writeCachedTicks(dataset, schema, symbol, symTicks, [startMs, endMs]);
      if (!persisted) {
        log.warn(
          `Tick cache stayed busy; continuing without persisting ` +
          `${symbol} ${schema} ${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}`,
        );
      }
    }
  }

  private async refreshEntryFromDb(
    memKey: string,
    dataset: string,
    schema: string,
    symbol: string,
  ): Promise<TickCacheData | undefined> {
    const existing = this.tickCache.get(memKey);
    const [dbRanges, dbTicks] = await Promise.all([
      this.tickCacheStore.readCachedRanges(dataset, schema, symbol),
      this.tickCacheStore.readCachedTicks(symbol, schema),
    ]);

    if (dbRanges.length === 0 && dbTicks.length === 0) {
      return existing;
    }

    const merged: TickCacheData = existing
      ? {
          ranges: dbRanges.length > 0
            ? dbRanges.reduce<[number, number][]>(
                (ranges, range) => mergeRanges(ranges, range),
                existing.ranges,
              )
            : existing.ranges,
          ticks: dbTicks.length > 0 ? this.mergeTicks(existing.ticks, dbTicks) : existing.ticks,
        }
      : { ranges: dbRanges, ticks: dbTicks };

    this.tickCache.set(memKey, merged);
    return merged;
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

  /**
   * Probe Databento for real option expiry dates by batch-fetching ohlcv-1d bars
   * for a handful of ATM OCC symbols across candidate Fridays.
   * ~15KB per call — surgical data usage.
   */
  async getExpiryDates(symbol: string, at: Date): Promise<string[]> {
    // Get stock price to determine ATM strikes
    const quote = await this.getQuote(symbol, at);
    const stockPrice = (quote.bid + quote.ask) / 2;

    const interval = stockPrice < 20 ? 0.5 : stockPrice < 100 ? 1 : stockPrice < 500 ? 5 : 10;
    const atmStrike = Math.round(stockPrice / interval) * interval;
    const probeStrikes = [atmStrike - interval, atmStrike, atmStrike + interval];

    // Generate candidate Fridays for the next 12 weeks
    const fridays: string[] = [];
    const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const dow = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() + ((5 - dow + 7) % 7 || 7));
    for (let i = 0; i < 12; i++) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      fridays.push(`${y}-${m}-${dd}`);
      d.setUTCDate(d.getUTCDate() + 7);
    }

    // Build probe OCC symbols — 3 strikes × 12 Fridays = 36 symbols
    const probeSymbols: string[] = [];
    const expiryForSymbol: string[] = [];
    for (const expiry of fridays) {
      for (const strike of probeStrikes) {
        probeSymbols.push(formatOccSymbol({ underlying: symbol, expiration: expiry, type: 'CALL', strike }));
        expiryForSymbol.push(expiry);
      }
    }

    // ohlcv-1d ts_event is midnight UTC of the NEXT day — extend by 2 days to avoid boundary miss
    const dayStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 2 * 24 * 60 * 60 * 1000);

    await this.ensureRangeBatch(
      probeSymbols,
      dayStart,
      dayEnd,
      this.optionsDataset,
      'raw_symbol',
      'ohlcv-1d',
    );

    const symbolsWithData = new Set<string>();
    for (const probeSymbol of probeSymbols) {
      const entry = this.tickCache.get(`${probeSymbol}:ohlcv-1d`);
      if (!entry) continue;
      const hasTick = entry.ticks.some((tick) => {
        const ts = tick.timestamp.getTime();
        return ts >= dayStart.getTime() && ts <= dayEnd.getTime();
      });
      if (hasTick) symbolsWithData.add(probeSymbol);
    }
    const validExpiries = new Set<string>();
    for (let i = 0; i < probeSymbols.length; i++) {
      if (symbolsWithData.has(probeSymbols[i])) {
        validExpiries.add(expiryForSymbol[i]);
      }
    }

    const result = [...validExpiries].sort();
    log.debug(`getExpiryDates(${symbol}): ${result.length} valid expiries from ${fridays.length} candidates`);
    return result;
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
