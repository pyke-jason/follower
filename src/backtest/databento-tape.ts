import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { zCoercePrice } from '../lib/zod-financial.js';
import { createLogger } from '../lib/logger.js';
import { toDateKeyET, dayBoundsUTC, isMarketHours, parseDateKey } from '../lib/et-date.js';
import type { Bar } from '../broker/types.js';
import { parseOccSymbol } from './occ-symbology.js';

const log = createLogger('QuoteTape');

const CACHE_DIR = '.cache/databento';

/**
 * Async line iterator over a Node Readable stream.
 * Captures readline 'error' events (which bypass the for-await loop) and
 * re-throws them after iteration ends so callers/withRetry can handle them.
 */
async function* readLines(reader: Readable): AsyncGenerator<string> {
  const rl = createInterface({ input: reader, terminal: false });
  let streamError: Error | null = null;
  rl.on('error', (err) => { streamError = err as Error; rl.close(); });
  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    rl.close();
    reader.destroy();
  }
  if (streamError) throw streamError;
}

/** Hard limit on bytes read from a single Databento streaming response. */
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // 50 MB

/** Per-symbol-day fetch metadata for downstream error enrichment. */
type FetchMeta = {
  status?: number;
  requestId?: string;
  bytes: number;
  records: number;
  ticks: number;
};

const fetchMetaMap = new Map<string, FetchMeta>();

export function getFetchMeta(symbol: string, day: string): FetchMeta | undefined {
  return fetchMetaMap.get(`${symbol}:${day}`);
}

/**
 * Module-level API stats tracking. Accumulates bytes/records across all
 * uncached Databento API fetches within this process.
 *
 * NOTE: Safe because each backtest runs as a separate process (see pid column
 * on backtest_runs). If concurrent runs ever share a process, these would
 * need to move to per-instance tracking.
 */
let _apiStats = { fetches: 0, bytesRead: 0, records: 0 };
export function getApiStats() { return { ..._apiStats }; }
export function resetApiStats() { _apiStats = { fetches: 0, bytesRead: 0, records: 0 }; }

/** Zod schema for Databento records — validates shape and value ranges.
 *  Uses z.coerce.number() because pretty_px:'true' returns prices as strings (e.g. "51.30"). */
const px = zCoercePrice.optional();

const DatabentoRecord = z.object({
  symbol: z.string().optional(),
  hd: z.object({ symbol: z.string().optional(), ts_event: z.string().nullish() }).optional(),
  open: px,
  high: px,
  low: px,
  close: px,
  volume: z.coerce.number().optional(),
  bid_px_00: px,
  ask_px_00: px,
  bid_px: px,
  ask_px: px,
  levels: z.array(z.object({ bid_px: px, ask_px: px })).optional(),
  ts_event: z.string().nullish(),
  ts_recv: z.string().optional(),
}).strip();

export type QuoteTick = {
  symbol: string;
  bid: number;
  ask: number;
  timestamp: Date;
};

/** Default quote schema per dataset. cbbo-1s is only for consolidated feeds (OPRA). */
export function defaultSchemaForDataset(dataset: string): string {
  switch (dataset) {
    case 'OPRA.PILLAR':
      return 'cbbo-1s';
    case 'DBEQ.BASIC':
      // ohlcv-1m: ~390 records/symbol/day, cheapest schema with intraday granularity.
      // We synthesize bid/ask from high/low of each minute bar.
      return 'ohlcv-1m';
    default:
      return 'bbo-1m';
  }
}

// ── Interval-merging helpers ───────────────────────────────────────

/** Merge a new interval into a sorted, non-overlapping list of intervals (UTC ms). */
export function mergeRanges(ranges: [number, number][], newRange: [number, number]): [number, number][] {
  const all = [...ranges, newRange].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [all[0]];
  for (let i = 1; i < all.length; i++) {
    const prev = merged[merged.length - 1];
    if (all[i][0] <= prev[1]) {
      prev[1] = Math.max(prev[1], all[i][1]);
    } else {
      merged.push([...all[i]]);
    }
  }
  return merged;
}

/** Check if any single interval in the list fully covers [start, end]. */
export function isRangeCovered(ranges: [number, number][], start: number, end: number): boolean {
  for (const [lo, hi] of ranges) {
    if (lo <= start && hi >= end) return true;
  }
  return false;
}

// ── Cache types and v2 format ─────────────────────────────────────

export type TickCacheData = {
  ranges: [number, number][];
  ticks: QuoteTick[];
};

type CacheEnvelope = {
  v: 2;
  ranges: [number, number][];
  ticks: Array<{ symbol: string; bid: number; ask: number; timestamp: string }>;
};

/** Cache path for a single symbol's data within a dataset/schema/date. */
export function getDayCachePath(params: {
  dataset: string;
  schema: string;
  symbol: string;
  day: string; // YYYY-MM-DD
  stype_in?: string;
}): string {
  const { dataset, schema, symbol, day, stype_in } = params;
  const parts = [dataset, schema, symbol, day];
  if (stype_in) parts.push(stype_in);
  const key = parts.join('|');
  const hash = createHash('sha256').update(key).digest('hex');
  return join(CACHE_DIR, `${hash}.json`);
}

/**
 * Read tick cache supporting both v1 (bare array) and v2 (envelope with ranges).
 * v1 files are treated as covering [firstTick, lastTick]. Empty arrays → empty ranges.
 */
export async function readTickCache(path: string): Promise<TickCacheData | null> {
  try {
    const data = await readFile(path, 'utf-8');
    const raw = JSON.parse(data);

    if (Array.isArray(raw)) {
      // v1 format: bare QuoteTick[]
      const ticks: QuoteTick[] = raw.map((t: { symbol: string; bid: number; ask: number; timestamp: string }) => ({
        ...t,
        timestamp: new Date(t.timestamp),
      }));
      if (ticks.length === 0) {
        return { ranges: [], ticks: [] };
      }
      const first = ticks[0].timestamp.getTime();
      const last = ticks[ticks.length - 1].timestamp.getTime();
      return { ranges: [[first, last]], ticks };
    }

    if (raw && typeof raw === 'object' && raw.v === 2) {
      // v2 format: envelope with explicit ranges
      const ticks: QuoteTick[] = (raw.ticks ?? []).map((t: { symbol: string; bid: number; ask: number; timestamp: string }) => ({
        ...t,
        timestamp: new Date(t.timestamp),
      }));
      return { ranges: raw.ranges ?? [], ticks };
    }

    log.warn(`Corrupted cache at ${path}, ignoring`);
    return null;
  } catch {
    return null;
  }
}

/** Always writes v2 envelope format. */
export async function writeTickCache(path: string, data: TickCacheData): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const envelope: CacheEnvelope = {
    v: 2,
    ranges: data.ranges,
    ticks: data.ticks.map(t => ({
      symbol: t.symbol,
      bid: t.bid,
      ask: t.ask,
      timestamp: t.timestamp.toISOString(),
    })),
  };
  await writeFile(path, JSON.stringify(envelope));
}

/** Re-export for existing callers. */
export const toDateKey = toDateKeyET;

/** Re-export for existing callers. */
const dayRangeUTC = dayBoundsUTC;

// ── Retry logic for Databento API calls ───────────────────────────────

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_INITIAL_DELAY_MS = 1_000;
const RETRY_BACKOFF_MULTIPLIER = 2;
const RETRY_MAX_DELAY_MS = 30_000;

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  context: { day?: string; symbols?: string[] } = {},
): Promise<{ res: Response; retries: number }> {
  let delay = RETRY_INITIAL_DELAY_MS;

  for (let attempt = 0; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init);

      if (res.ok) {
        if (res.status !== 200) {
          log.warn(
            `Databento ${res.status} (non-200 ok) | day=${context.day ?? '?'}` +
            ` symbols=${(context.symbols ?? []).join(',')}`,
          );
        }
        return { res, retries: attempt };
      }

      // 4xx (non-429) — not transient, don't retry
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const text = await res.text();
        throw new Error(`Databento ${res.status}: ${text.slice(0, 500)}`);
      }

      // 5xx or 429 — retryable
      if (attempt < RETRY_MAX_ATTEMPTS) {
        const requestId = res.headers.get('x-request-id') ?? 'unknown';
        const body = await res.text();
        log.warn(
          `Retry ${attempt + 1}/${RETRY_MAX_ATTEMPTS} — ` +
          `status=${res.status}, x-request-id=${requestId}, ` +
          `day=${context.day ?? '?'}, symbols=${(context.symbols ?? []).join(',').slice(0, 80)}` +
          `\n  body: ${body.slice(0, 500)}`
        );

        // Respect retry-after header as delay floor
        const retryAfter = res.headers.get('retry-after');
        let wait = delay + Math.random() * delay * 0.5;
        if (retryAfter) {
          const retryMs = parseFloat(retryAfter) * 1000;
          if (Number.isFinite(retryMs) && retryMs > 0) {
            wait = Math.max(wait, retryMs);
          }
        }
        wait = Math.min(wait, RETRY_MAX_DELAY_MS);

        await new Promise((r) => setTimeout(r, wait));
        delay *= RETRY_BACKOFF_MULTIPLIER;
        continue;
      }

      // Exhausted retries
      const text = await res.text();
      throw new Error(
        `Databento ${res.status} after ${RETRY_MAX_ATTEMPTS} retries: ${text.slice(0, 500)}`
      );
    } catch (err) {
      // Network errors (TypeError from fetch) — retryable
      if (err instanceof TypeError && attempt < RETRY_MAX_ATTEMPTS) {
        log.warn(
          `Retry ${attempt + 1}/${RETRY_MAX_ATTEMPTS} — ` +
          `network error: ${err.message}, ` +
          `day=${context.day ?? '?'}, symbols=${(context.symbols ?? []).join(',').slice(0, 80)}`
        );
        const wait = Math.min(delay + Math.random() * delay * 0.5, RETRY_MAX_DELAY_MS);
        await new Promise((r) => setTimeout(r, wait));
        delay *= RETRY_BACKOFF_MULTIPLIER;
        continue;
      }
      throw err;
    }
  }

  throw new Error('fetchWithRetry: unreachable');
}

// ── Daily bar cache (ohlcv-1d) ──────────────────────────────────────

async function readBarCache(path: string): Promise<Bar | null> {
  try {
    const data = await readFile(path, 'utf-8');
    const raw = JSON.parse(data);
    if (!raw || typeof raw !== 'object' || !raw.timestamp) return null;
    return raw as Bar;
  } catch {
    return null;
  }
}

async function writeBarCache(path: string, bar: Bar): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(bar));
}

/**
 * Fetch daily OHLCV bars for a symbol across multiple trading days in a SINGLE
 * Databento API call using the ohlcv-1d schema. Returns one Bar per trading day.
 *
 * Cache is per-symbol-per-day (same getDayCachePath with schema='ohlcv-1d'),
 * so repeated calls only fetch uncached days.
 *
 * Cost: ~1 row per trading day vs ~390 rows/day for ohlcv-1m.
 */
export async function loadDailyBars(params: {
  apiKey: string;
  dataset: string;
  symbol: string;
  days: string[];        // YYYY-MM-DD trading days, any order
  refreshCache?: boolean;
}): Promise<Bar[]> {
  const schema = 'ohlcv-1d';
  const sortedDays = [...params.days].sort();

  // Check per-day cache
  const bars: Map<string, Bar> = new Map();
  const uncachedDays: string[] = [];

  for (const day of sortedDays) {
    const cachePath = getDayCachePath({ dataset: params.dataset, schema, symbol: params.symbol, day });
    if (params.refreshCache) await unlink(cachePath).catch(() => {});
    const cached = await readBarCache(cachePath);
    if (cached) {
      bars.set(day, cached);
    } else {
      uncachedDays.push(day);
    }
  }

  if (uncachedDays.length === 0) {
    return sortedDays.map((d) => bars.get(d)!).filter(Boolean);
  }

  // Single API call spanning the full uncached range
  const rangeStart = dayRangeUTC(uncachedDays[0]).start;
  const rangeEnd = dayRangeUTC(uncachedDays[uncachedDays.length - 1]).end;
  const authHeader = 'Basic ' + Buffer.from(`${params.apiKey}:`).toString('base64');

  const fetchParams = new URLSearchParams({
    dataset: params.dataset,
    schema,
    encoding: 'json',
    pretty_px: 'true',
    pretty_ts: 'true',
    map_symbols: 'true',
    symbols: params.symbol,
    start: rangeStart.toISOString(),
    end: rangeEnd.toISOString(),
  });

  const fetchStart = Date.now();
  const { res, retries } = await fetchWithRetry(
    'https://hist.databento.com/v0/timeseries.get_range',
    {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: fetchParams.toString(),
    },
    { day: `${uncachedDays[0]}..${uncachedDays[uncachedDays.length - 1]}`, symbols: [params.symbol] },
  );

  const httpStatus = res.status;
  const requestId = res.headers.get('x-request-id') ?? undefined;
  if (!res.body) throw new Error('Response body is null');

  // Parse response — one record per trading day
  let bytesRead = 0;
  let records = 0;
  const reader = Readable.from(res.body as any);

  for await (const line of readLines(reader)) {
    bytesRead += Buffer.byteLength(line) + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let raw: unknown;
    try { raw = JSON.parse(trimmed); } catch { continue; }
    records++;

    const recordResult = DatabentoRecord.safeParse(raw);
    if (!recordResult.success) continue;
    const rec = recordResult.data;

    const ts = rec.ts_event ?? rec.hd?.ts_event ?? rec.ts_recv;
    if (!ts) continue;
    const timestamp = new Date(ts);
    if (isNaN(timestamp.getTime())) continue;

    const dayKey = toDateKeyET(timestamp);
    if (rec.open == null || rec.high == null || rec.low == null || rec.close == null) continue;

    bars.set(dayKey, {
      timestamp: timestamp.toISOString(),
      open: rec.open,
      high: rec.high,
      low: rec.low,
      close: rec.close,
      volume: rec.volume ?? 0,
    });
  }

  const durMs = Date.now() - fetchStart;
  const parts: string[] = [
    `daily-bars ${params.symbol}`,
    `range=${uncachedDays[0]}..${uncachedDays[uncachedDays.length - 1]}`,
    `status=${httpStatus}`,
    `bytes=${bytesRead}`,
    `records=${records}`,
    `bars=${bars.size}`,
  ];
  if (retries) parts.push(`retries=${retries}`);
  if (requestId) parts.push(`req=${requestId}`);
  parts.push(`dur=${durMs}ms`);
  log.info(parts.join(' '));

  _apiStats.fetches++;
  _apiStats.bytesRead += bytesRead;
  _apiStats.records += records;

  // Cache each day's bar
  for (const day of uncachedDays) {
    const bar = bars.get(day);
    if (bar) {
      const cachePath = getDayCachePath({ dataset: params.dataset, schema, symbol: params.symbol, day });
      await writeBarCache(cachePath, bar);
    }
  }

  return sortedDays.map((d) => bars.get(d)!).filter(Boolean);
}

// ── Two-phase options chain helpers ─────────────────────────────────────

export type ChainDefinition = {
  rawSymbol: string;   // OCC format, e.g. "GE    250912C00280000"
  expiry: string;      // YYYY-MM-DD
  strike: number;
  callPut: 'C' | 'P';
};

/** Zod schema for Databento definition records (instrument metadata, no prices). */
const DefinitionRecord = z.object({
  raw_symbol: z.string().optional(),
  symbol: z.string().optional(),
  hd: z.object({ symbol: z.string().optional() }).optional(),
  expiration: z.coerce.number().optional(),   // nanosecond epoch
  strike_price: z.coerce.number().optional(), // fixed-point price
  instrument_class: z.string().optional(),    // "C" or "P"
}).strip();

/**
 * Phase 1: Lightweight chain discovery via definition schema.
 * Returns metadata for every listed option contract under a parent symbol.
 * ~270KB vs 167MB for the full cbbo-1m parent fetch.
 */
export async function loadChainDefinitions(params: {
  apiKey: string;
  dataset: string;
  parentSymbol: string;   // e.g. "GE.OPT"
  day: string;            // YYYY-MM-DD
  refreshCache?: boolean;
}): Promise<ChainDefinition[]> {
  const authHeader = 'Basic ' + Buffer.from(`${params.apiKey}:`).toString('base64');
  const cacheKey = [params.dataset, 'definition', params.parentSymbol, params.day, 'parent'].join('|');
  const cachePath = join(CACHE_DIR, createHash('sha256').update(cacheKey).digest('hex') + '.json');

  if (params.refreshCache) {
    await unlink(cachePath).catch(() => {});
  }

  // Read from cache
  try {
    const raw = JSON.parse(await readFile(cachePath, 'utf-8'));
    if (Array.isArray(raw) && raw.length >= 0) {
      log.debug(`definition cache hit: ${params.parentSymbol} ${params.day} (${raw.length} contracts)`);
      return raw as ChainDefinition[];
    }
  } catch { /* cache miss */ }

  // Definitions are daily snapshots — use date-only range (Databento requires UTC midnight start)
  const definitions = await fetchDefinitionSnapshot(authHeader, params.dataset, params.parentSymbol, params.day);

  // Only cache non-empty results — empty may be transient (pre-market, API issues)
  if (definitions.length > 0) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath, JSON.stringify(definitions));
  }

  return definitions;
}

/** Fetch + parse definition snapshot for a single day. */
async function fetchDefinitionSnapshot(
  authHeader: string,
  dataset: string,
  parentSymbol: string,
  day: string,
): Promise<ChainDefinition[]> {
  // Definitions are daily snapshots — Databento requires date-only (UTC midnight) boundaries
  const nextDay = new Date(parseDateKey(day).getTime() + 24 * 60 * 60 * 1000);
  const nextDayStr = nextDay.toISOString().slice(0, 10);
  const fetchParams = new URLSearchParams({
    dataset,
    schema: 'definition',
    encoding: 'json',
    stype_in: 'parent',
    symbols: parentSymbol,
    start: day,
    end: nextDayStr,
  });

  const fetchStart = Date.now();
  const { res, retries } = await fetchWithRetry(
    'https://hist.databento.com/v0/timeseries.get_range',
    {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: fetchParams.toString(),
    },
    { day, symbols: [parentSymbol] },
  );

  if (!res.body) return [];

  const definitions: ChainDefinition[] = [];
  let bytesRead = 0;
  let records = 0;
  let skipped = 0;
  const seenSymbols = new Set<string>();

  const reader = Readable.from(res.body as any);

  for await (const line of readLines(reader)) {
    bytesRead += Buffer.byteLength(line) + 1;
    // No byte limit for definitions — we stream and only keep lightweight metadata.
    // SPY.OPT is ~19MB raw but yields ~10K small ChainDefinition objects.
    const trimmed = line.trim();
    if (!trimmed) continue;

    let raw: unknown;
    try { raw = JSON.parse(trimmed); } catch { continue; }
    records++;

    const parsed = DefinitionRecord.safeParse(raw);
    if (!parsed.success) { skipped++; continue; }

    const rec = parsed.data;
    const sym = rec.raw_symbol ?? rec.symbol ?? rec.hd?.symbol;
    if (!sym) { skipped++; continue; }

    // Deduplicate — definition schema may emit multiple records per instrument
    if (seenSymbols.has(sym)) continue;
    seenSymbols.add(sym);

    const callPut = rec.instrument_class;
    if (callPut !== 'C' && callPut !== 'P') { skipped++; continue; }

    // Parse expiry from nanosecond epoch
    let expiry: string | null = null;
    if (rec.expiration != null && rec.expiration > 0) {
      const ms = rec.expiration / 1_000_000; // ns → ms
      const d = new Date(ms);
      if (!isNaN(d.getTime())) {
        expiry = d.toISOString().slice(0, 10);
      }
    }

    // Parse strike — Databento definition uses fixed-point (price * 1e9)
    let strike: number | null = null;
    if (rec.strike_price != null && rec.strike_price > 0) {
      strike = rec.strike_price / 1_000_000_000;
    }

    // Fall back to OCC symbol parsing if fields are missing
    if (!expiry || !strike) {
      const occParts = parseOccSymbol(sym);
      if (occParts) {
        expiry = expiry ?? occParts.expiration.toISOString().slice(0, 10);
        strike = strike ?? occParts.strike;
      }
    }

    if (!expiry || strike == null) { skipped++; continue; }

    definitions.push({ rawSymbol: sym, expiry, strike, callPut });
  }

  const durMs = Date.now() - fetchStart;
  log.info(
    `definition fetch ${parentSymbol} day=${day} ` +
    `records=${records} contracts=${definitions.length} skipped=${skipped} ` +
    `bytes=${bytesRead}${retries ? ` retries=${retries}` : ''} dur=${durMs}ms`,
  );

  return definitions;
}


/**
 * Fetch ticks for specific symbols within a narrow time window.
 * No caching — caller handles caching via interval-merging cache.
 * This is the primary API fetch path for all intraday data.
 */
export async function fetchTickWindow(params: {
  apiKey: string;
  dataset: string;
  schema?: string;
  symbols: string[];
  start: Date;
  end: Date;
  stypeIn?: 'raw_symbol';
}): Promise<QuoteTick[]> {
  if (params.symbols.length === 0) return [];
  if (params.start >= params.end) return [];

  const resolvedSchema = params.schema ?? defaultSchemaForDataset(params.dataset);
  const authHeader = 'Basic ' + Buffer.from(`${params.apiKey}:`).toString('base64');

  const fetchParamsObj: Record<string, string> = {
    dataset: params.dataset,
    schema: resolvedSchema,
    encoding: 'json',
    pretty_px: 'true',
    pretty_ts: 'true',
    map_symbols: 'true',
    symbols: params.symbols.join(','),
    start: params.start.toISOString(),
    end: params.end.toISOString(),
  };
  if (params.stypeIn) fetchParamsObj.stype_in = params.stypeIn;
  const fetchParams = new URLSearchParams(fetchParamsObj);

  const fetchStart = Date.now();
  const { res, retries } = await fetchWithRetry(
    'https://hist.databento.com/v0/timeseries.get_range',
    {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: fetchParams.toString(),
    },
    { symbols: params.symbols },
  );

  const httpStatus = res.status;
  const requestId = res.headers.get('x-request-id') ?? undefined;

  if (!res.body) return [];

  const ticks: QuoteTick[] = [];
  const reader = Readable.from(res.body as any);

  let bytesRead = 0;
  let records = 0;
  for await (const line of readLines(reader)) {
    bytesRead += Buffer.byteLength(line) + 1;
    if (bytesRead > MAX_RESPONSE_BYTES) {
      throw new Error(`[QuoteTape] Response exceeded ${MAX_RESPONSE_BYTES / 1024 / 1024}MB limit for tick window ${params.symbols.join(',')} (${bytesRead} bytes)`);
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    let raw: unknown;
    try { raw = JSON.parse(trimmed); } catch { continue; }
    records++;

    const recordResult = DatabentoRecord.safeParse(raw);
    if (!recordResult.success) continue;

    const tick = parseTick(recordResult.data);
    if (!tick) continue;
    if (!isMarketHours(tick.timestamp)) continue;

    ticks.push(tick);
  }

  const durMs = Date.now() - fetchStart;
  const parts: string[] = [
    `tick-window ${params.symbols.length <= 3 ? params.symbols.join(',') : `${params.symbols.length} symbols`}`,
    `schema=${resolvedSchema}`,
    `range=${params.start.toISOString().slice(11, 19)}..${params.end.toISOString().slice(11, 19)}`,
    `status=${httpStatus}`,
    `bytes=${bytesRead}`,
    `records=${records}`,
    `ticks=${ticks.length}`,
  ];
  if (retries) parts.push(`retries=${retries}`);
  if (requestId) parts.push(`req=${requestId}`);
  parts.push(`dur=${durMs}ms`);
  log.info(parts.join(' '));

  // Track API stats
  _apiStats.fetches++;
  _apiStats.bytesRead += bytesRead;
  _apiStats.records += records;

  // Populate per-symbol-day fetch metadata for error enrichment
  const ticksBySymbol = new Map<string, number>();
  for (const tick of ticks) {
    ticksBySymbol.set(tick.symbol, (ticksBySymbol.get(tick.symbol) ?? 0) + 1);
  }
  for (const sym of params.symbols) {
    const day = toDateKey(params.start);
    fetchMetaMap.set(`${sym}:${day}`, {
      status: httpStatus,
      requestId,
      bytes: bytesRead,
      records,
      ticks: ticksBySymbol.get(sym) ?? 0,
    });
  }

  ticks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return ticks;
}

function parseTick(record: z.infer<typeof DatabentoRecord>): QuoteTick | null {
  const symbol = record.symbol ?? record.hd?.symbol;
  if (!symbol) return null;

  let bid: number | undefined;
  let ask: number | undefined;

  // ohlcv-1m schema: synthesize bid/ask from high/low of the minute bar
  if (record.high != null && record.low != null) {
    bid = record.low;
    ask = record.high;
  }
  // cbbo-1s / bbo-1m / mbp-1 schema: bid_px_00 / ask_px_00
  else if (record.bid_px_00 != null) {
    bid = record.bid_px_00;
    ask = record.ask_px_00;
  } else if (record.bid_px != null) {
    bid = record.bid_px;
    ask = record.ask_px;
  } else if (record.levels?.length) {
    bid = record.levels[0]?.bid_px;
    ask = record.levels[0]?.ask_px;
  }

  if (bid == null || ask == null || !Number.isFinite(bid) || !Number.isFinite(ask)) return null;

  const ts = record.ts_event ?? record.hd?.ts_event ?? record.ts_recv;
  if (!ts) return null;
  const timestamp = new Date(ts);
  if (isNaN(timestamp.getTime())) return null;

  return { symbol, bid, ask, timestamp };
}
