import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { zCoercePrice, formatZodError } from '../lib/zod-financial.js';
import { createLogger } from '../lib/logger.js';
import { toDateKeyET, dayBoundsUTC, isTradingDay, isMarketHours, marketOpenUTC, parseDateKey } from '../lib/et-date.js';
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
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

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
  high: px,
  low: px,
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

export type QuoteTapeConfig = {
  apiKey: string;
  dataset: string;
  symbols: string[];
  start: Date;
  end: Date;
  schema?: string;
  /** Max allowed cost in USD before aborting. Default: $5. */
  maxCostUsd?: number;
  /** Map of symbol → dates it's needed. Only fetches those days instead of full range. */
  symbolDates?: Map<string, Date[]>;
  /** Delete matching cache entries before reading, forcing re-download. */
  refreshCache?: boolean;
};

/** Default quote schema per dataset. cbbo-1s is only for consolidated feeds (OPRA). */
function defaultSchemaForDataset(dataset: string): string {
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

/** Cache path for a single symbol's data within a dataset/schema/date. */
function getDayCachePath(params: {
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

/** Cache path for parent symbology fetches (one file per parent symbol per day). */
function getParentCachePath(params: {
  dataset: string;
  schema: string;
  parentSymbol: string;
  day: string;
}): string {
  const key = [params.dataset, params.schema, params.parentSymbol, params.day, 'parent'].join('|');
  const hash = createHash('sha256').update(key).digest('hex');
  return join(CACHE_DIR, `${hash}.json`);
}

async function readCache(path: string): Promise<QuoteTick[] | null> {
  try {
    const data = await readFile(path, 'utf-8');
    const raw = JSON.parse(data);
    if (!Array.isArray(raw)) {
      log.warn(`Corrupted cache at ${path}, ignoring`);
      return null;
    }
    return raw.map((t: { symbol: string; bid: number; ask: number; timestamp: string }) => ({
      ...t,
      timestamp: new Date(t.timestamp),
    }));
  } catch {
    return null;
  }
}

async function writeCache(path: string, ticks: QuoteTick[]): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(ticks));
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

/**
 * Build the set of (symbol, day) pairs we actually need data for.
 * If symbolDates is provided, use those. Otherwise fall back to all symbols × all days in range.
 */
function buildFetchPlan(config: QuoteTapeConfig): Map<string, Set<string>> {
  const plan = new Map<string, Set<string>>(); // day → Set<symbol>

  if (config.symbolDates) {
    for (const [symbol, dates] of config.symbolDates) {
      for (const d of dates) {
        const day = toDateKey(d);
        let syms = plan.get(day);
        if (!syms) { syms = new Set(); plan.set(day, syms); }
        syms.add(symbol);
      }
    }
  } else {
    // Fallback: all symbols × full date range
    const days = new Set<string>();
    const cur = new Date(config.start);
    while (cur < config.end) {
      if (isTradingDay(cur)) days.add(toDateKey(cur));
      cur.setDate(cur.getDate() + 1);
    }
    for (const day of days) {
      plan.set(day, new Set(config.symbols));
    }
  }

  return plan;
}

/**
 * Load quote ticks for a single day. Checks per-symbol cache, fetches uncached
 * symbols via fetchWithRetry, caches results. No cost estimation.
 */
export async function loadQuoteTapeForDay(params: {
  apiKey: string;
  dataset: string;
  schema?: string;
  symbols: string[];
  day: string;           // 'YYYY-MM-DD'
  refreshCache?: boolean;
  stypeIn?: 'raw_symbol' | 'parent';
}): Promise<QuoteTick[]> {
  // Parent symbology: completely separate fetch/cache path
  if (params.stypeIn === 'parent') {
    return loadParentSymbology(params);
  }

  const resolvedSchema = params.schema ?? defaultSchemaForDataset(params.dataset);
  const authHeader = 'Basic ' + Buffer.from(`${params.apiKey}:`).toString('base64');

  // Check cache for each symbol, collect cached ticks + uncached symbols
  const allTicks: QuoteTick[] = [];
  const uncachedSymbols: string[] = [];

  for (const symbol of params.symbols) {
    const cachePath = getDayCachePath({ dataset: params.dataset, schema: resolvedSchema, symbol, day: params.day });

    if (params.refreshCache) {
      await unlink(cachePath).catch(() => {});
    }

    const cached = await readCache(cachePath);
    if (cached) {
      allTicks.push(...cached);
    } else {
      uncachedSymbols.push(symbol);
    }
  }

  if (uncachedSymbols.length === 0) {
    allTicks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return allTicks;
  }

  // Fetch uncached symbols
  const { start, end } = dayRangeUTC(params.day);

  const fetchParams = new URLSearchParams({
    dataset: params.dataset,
    schema: resolvedSchema,
    encoding: 'json',
    pretty_px: 'true',
    pretty_ts: 'true',
    map_symbols: 'true',
    symbols: uncachedSymbols.join(','),
    start: start.toISOString(),
    end: end.toISOString(),
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
    { day: params.day, symbols: uncachedSymbols },
  );

  const httpStatus = res.status;
  const requestId = res.headers.get('x-request-id') ?? undefined;

  if (!res.body) {
    throw new Error('Response body is null');
  }

  // Bucket ticks by symbol
  const ticksBySymbol = new Map<string, QuoteTick[]>();
  for (const sym of uncachedSymbols) ticksBySymbol.set(sym, []);

  // Stream the response line by line, tracking parse counters
  let bytesRead = 0;
  let records = 0;
  let jsonErr = 0;
  let noQuote = 0;
  let outsideMktHrs = 0;
  const reader = Readable.from(res.body as any);

  for await (const line of readLines(reader)) {
    bytesRead += Buffer.byteLength(line) + 1;
    if (bytesRead > MAX_RESPONSE_BYTES) {
      throw new Error(`[QuoteTape] Response exceeded ${MAX_RESPONSE_BYTES / 1024 / 1024}MB limit for ${uncachedSymbols.join(',')} on ${params.day} (${bytesRead} bytes)`);
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      jsonErr++;
      log.debug(`json parse error: ${trimmed.slice(0, 120)}`);
      continue;
    }

    records++;
    const recordResult = DatabentoRecord.safeParse(raw);
    if (!recordResult.success) {
      throw new Error(
        `[QuoteTape] Schema mismatch on record ${records} for ${uncachedSymbols.join(',')} on ${params.day}: ` +
        `${formatZodError(recordResult.error)}\n  Record: ${JSON.stringify(raw).slice(0, 500)}`
      );
    }
    const record = recordResult.data;

    const tick = parseTick(record);
    if (!tick) { noQuote++; continue; }
    if (!isMarketHours(tick.timestamp)) { outsideMktHrs++; continue; }

    const bucket = ticksBySymbol.get(tick.symbol);
    if (bucket) {
      bucket.push(tick);
    } else {
      ticksBySymbol.set(tick.symbol, [tick]);
    }
  }

  const durMs = Date.now() - fetchStart;
  let totalTicks = 0;
  for (const ticks of ticksBySymbol.values()) totalTicks += ticks.length;

  // Structured per-fetch log line — counters only appear when non-zero
  const parts: string[] = [
    `fetch day=${params.day}`,
    `symbols=${uncachedSymbols.join(',')}`,
    `status=${httpStatus}`,
    `bytes=${bytesRead}`,
    `records=${records}`,
  ];
  if (jsonErr) parts.push(`jsonErr=${jsonErr}`);
  if (noQuote) parts.push(`noQuote=${noQuote}`);
  if (outsideMktHrs) parts.push(`outsideMktHrs=${outsideMktHrs}`);
  parts.push(`ticks=${totalTicks}`);
  parts.push('cached=false');
  if (retries) parts.push(`retries=${retries}`);
  if (requestId) parts.push(`req=${requestId}`);
  parts.push(`dur=${durMs}ms`);
  log.info(parts.join(' '));

  // Accumulate API stats for runtime metrics
  _apiStats.fetches++;
  _apiStats.bytesRead += bytesRead;
  _apiStats.records += records;

  // Populate fetch metadata per symbol for downstream error enrichment
  for (const sym of uncachedSymbols) {
    const symTicks = ticksBySymbol.get(sym)?.length ?? 0;
    fetchMetaMap.set(`${sym}:${params.day}`, {
      status: httpStatus,
      requestId,
      bytes: bytesRead,
      records,
      ticks: symTicks,
    });
  }

  // Cache each symbol's day data (skip caching empty results on trading days — likely a transient API issue)
  const shouldHaveData = isTradingDay(parseDateKey(params.day));

  for (const [symbol, ticks] of ticksBySymbol) {
    ticks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const cachePath = getDayCachePath({ dataset: params.dataset, schema: resolvedSchema, symbol, day: params.day });
    if (ticks.length === 0 && shouldHaveData) {
      log.warn(`Skipping cache write for ${symbol} on ${params.day} (trading day with 0 ticks — possible transient API issue)`);
    } else {
      await writeCache(cachePath, ticks);
    }
    allTicks.push(...ticks);
  }

  allTicks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return allTicks;
}

/**
 * Fetch all option ticks for a parent symbol (e.g. "AAPL.OPT") using Databento's
 * parent symbology (`stype_in=parent`). Returns all contracts in a single API call.
 * Cached atomically as one file per parent symbol per day.
 */
async function loadParentSymbology(params: {
  apiKey: string;
  dataset: string;
  schema?: string;
  symbols: string[];
  day: string;
  refreshCache?: boolean;
}): Promise<QuoteTick[]> {
  const resolvedSchema = params.schema ?? 'cbbo-1m';
  const authHeader = 'Basic ' + Buffer.from(`${params.apiKey}:`).toString('base64');
  const parentSymbol = params.symbols[0]; // e.g. "AAPL.OPT"

  const cachePath = getParentCachePath({
    dataset: params.dataset,
    schema: resolvedSchema,
    parentSymbol,
    day: params.day,
  });

  if (params.refreshCache) {
    await unlink(cachePath).catch(() => {});
  }

  const cached = await readCache(cachePath);
  if (cached) {
    log.debug(`parent cache hit: ${parentSymbol} ${params.day} (${cached.length} ticks)`);
    return cached;
  }

  // Cost check (advisory — log but don't block)
  try {
    const { start, end } = dayRangeUTC(params.day);
    const costParams = new URLSearchParams({
      dataset: params.dataset,
      schema: resolvedSchema,
      stype_in: 'parent',
      symbols: parentSymbol,
      start: start.toISOString(),
      end: end.toISOString(),
    });

    const { res: costRes } = await fetchWithRetry(
      'https://hist.databento.com/v0/metadata.get_cost',
      {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: costParams.toString(),
      },
      { day: params.day, symbols: [parentSymbol] },
    );

    const costData = z.number().nonnegative().parse(await costRes.json());
    const costUsd = costData / 100;
    log.info(`Parent fetch ${parentSymbol} ${params.day}: estimated cost $${costUsd.toFixed(2)}`);
  } catch (err) {
    log.warn(`Could not estimate cost for ${parentSymbol}: ${err instanceof Error ? err.message : err}`);
  }

  // Fetch with stype_in=parent
  const { start, end } = dayRangeUTC(params.day);
  const fetchParams = new URLSearchParams({
    dataset: params.dataset,
    schema: resolvedSchema,
    encoding: 'json',
    pretty_px: 'true',
    pretty_ts: 'true',
    map_symbols: 'true',
    stype_in: 'parent',
    symbols: parentSymbol,
    start: start.toISOString(),
    end: end.toISOString(),
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
    { day: params.day, symbols: [parentSymbol] },
  );

  const httpStatus = res.status;
  const requestId = res.headers.get('x-request-id') ?? undefined;

  if (!res.body) {
    throw new Error(`Response body is null for parent fetch ${parentSymbol}`);
  }

  const allTicks: QuoteTick[] = [];
  let bytesRead = 0;
  let records = 0;
  let jsonErr = 0;
  let noQuote = 0;
  let outsideMktHrs = 0;
  let sampleNoQuote: unknown = null;  // capture first null-price record for diagnostics

  const reader = Readable.from(res.body as any);

  for await (const line of readLines(reader)) {
    bytesRead += Buffer.byteLength(line) + 1;
    if (bytesRead > MAX_RESPONSE_BYTES) {
      throw new Error(`[QuoteTape] Response exceeded ${MAX_RESPONSE_BYTES / 1024 / 1024}MB limit for parent ${parentSymbol} on ${params.day} (${bytesRead} bytes)`);
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      jsonErr++;
      continue;
    }

    records++;
    const recordResult = DatabentoRecord.safeParse(raw);
    if (!recordResult.success) continue; // skip malformed records in parent fetch

    const tick = parseTick(recordResult.data);
    if (!tick) { noQuote++; if (!sampleNoQuote) sampleNoQuote = raw; continue; }
    if (!isMarketHours(tick.timestamp)) { outsideMktHrs++; continue; }

    allTicks.push(tick);
  }

  const durMs = Date.now() - fetchStart;

  // Log structured fetch summary
  const parts: string[] = [
    `parent fetch ${parentSymbol} day=${params.day}`,
    `status=${httpStatus}`,
    `bytes=${bytesRead}`,
    `records=${records}`,
  ];
  if (jsonErr) parts.push(`jsonErr=${jsonErr}`);
  if (noQuote) parts.push(`noQuote=${noQuote}`);
  if (outsideMktHrs) parts.push(`outsideMktHrs=${outsideMktHrs}`);
  parts.push(`ticks=${allTicks.length}`);
  if (noQuote > 0 && allTicks.length === 0 && sampleNoQuote) {
    parts.push(`sampleRecord=${JSON.stringify(sampleNoQuote).slice(0, 300)}`);
  }
  if (retries) parts.push(`retries=${retries}`);
  if (requestId) parts.push(`req=${requestId}`);
  parts.push(`dur=${durMs}ms`);
  log.info(parts.join(' '));

  if (records > 500_000) {
    log.warn(`Parent fetch ${parentSymbol} returned ${records} records — large chain (SPY?). Consider cbbo-1m schema.`);
  }

  // Accumulate API stats
  _apiStats.fetches++;
  _apiStats.bytesRead += bytesRead;
  _apiStats.records += records;

  // Cache all ticks atomically (skip on trading day with 0 ticks — likely transient)
  allTicks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  if (allTicks.length === 0 && isTradingDay(parseDateKey(params.day))) {
    log.warn(`Skipping parent cache write for ${parentSymbol} on ${params.day} (trading day with 0 ticks)`);
  } else {
    await writeCache(cachePath, allTicks);
  }

  return allTicks;
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
 * Phase 2: Fetch cbbo-1m price data for specific OCC symbols.
 * Uses stype_in=raw_symbol to fetch only the contracts we need.
 */
export async function loadSpecificContracts(params: {
  apiKey: string;
  dataset: string;
  symbols: string[];       // OCC symbols, e.g. ["GE    250912C00280000", ...]
  day: string;
  schema?: string;
  refreshCache?: boolean;
}): Promise<QuoteTick[]> {
  if (params.symbols.length === 0) return [];

  const resolvedSchema = params.schema ?? 'cbbo-1m';

  // Each symbol goes through the normal per-symbol-day cache
  const allTicks: QuoteTick[] = [];
  const uncached: string[] = [];

  for (const sym of params.symbols) {
    const cachePath = getDayCachePath({
      dataset: params.dataset,
      schema: resolvedSchema,
      symbol: sym,
      day: params.day,
    });

    if (params.refreshCache) {
      await unlink(cachePath).catch(() => {});
    }

    const cached = await readCache(cachePath);
    if (cached) {
      allTicks.push(...cached);
    } else {
      uncached.push(sym);
    }
  }

  if (uncached.length === 0) {
    log.debug(`specific contracts cache hit: ${params.symbols.length} symbols ${params.day}`);
    return allTicks;
  }

  const authHeader = 'Basic ' + Buffer.from(`${params.apiKey}:`).toString('base64');
  const { start, end } = dayRangeUTC(params.day);

  const fetchParams = new URLSearchParams({
    dataset: params.dataset,
    schema: resolvedSchema,
    encoding: 'json',
    pretty_px: 'true',
    pretty_ts: 'true',
    map_symbols: 'true',
    stype_in: 'raw_symbol',
    symbols: uncached.join(','),
    start: start.toISOString(),
    end: end.toISOString(),
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
    { day: params.day, symbols: uncached },
  );

  if (!res.body) {
    throw new Error(`Response body is null for specific contracts fetch`);
  }

  // Stream and parse — same as loadQuoteTapeForDay
  const ticksBySymbol = new Map<string, QuoteTick[]>();
  for (const sym of uncached) ticksBySymbol.set(sym, []);

  let bytesRead = 0;
  let records = 0;
  let noQuote = 0;

  const reader = Readable.from(res.body as any);

  for await (const line of readLines(reader)) {
    bytesRead += Buffer.byteLength(line) + 1;
    if (bytesRead > MAX_RESPONSE_BYTES) {
      throw new Error(`[QuoteTape] Response exceeded ${MAX_RESPONSE_BYTES / 1024 / 1024}MB limit for specific contracts on ${params.day} (${bytesRead} bytes)`);
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    let raw: unknown;
    try { raw = JSON.parse(trimmed); } catch { continue; }
    records++;

    const recordResult = DatabentoRecord.safeParse(raw);
    if (!recordResult.success) continue;

    const tick = parseTick(recordResult.data);
    if (!tick) { noQuote++; continue; }
    if (!isMarketHours(tick.timestamp)) continue;

    let bucket = ticksBySymbol.get(tick.symbol);
    if (!bucket) { bucket = []; ticksBySymbol.set(tick.symbol, bucket); }
    bucket.push(tick);
  }

  const durMs = Date.now() - fetchStart;
  let totalTicks = 0;
  for (const ticks of ticksBySymbol.values()) totalTicks += ticks.length;

  log.info(
    `specific contracts fetch day=${params.day} symbols=${uncached.length} ` +
    `records=${records} ticks=${totalTicks}${noQuote ? ` noQuote=${noQuote}` : ''} ` +
    `bytes=${bytesRead}${retries ? ` retries=${retries}` : ''} dur=${durMs}ms`,
  );

  // Cache per symbol
  for (const [sym, ticks] of ticksBySymbol) {
    ticks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const cachePath = getDayCachePath({
      dataset: params.dataset,
      schema: resolvedSchema,
      symbol: sym,
      day: params.day,
    });
    await writeCache(cachePath, ticks);
    allTicks.push(...ticks);
  }

  allTicks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return allTicks;
}

/**
 * Load historical quote tape from Databento HTTP API.
 * Returns ticks sorted chronologically.
 *
 * When symbolDates is provided, only fetches data for the specific days each symbol
 * appears in messages — dramatically reducing cost vs fetching the full date range.
 *
 * Caches per symbol-day so re-runs are free.
 */
export async function loadQuoteTape(config: QuoteTapeConfig): Promise<QuoteTick[]> {
  const schema = config.schema ?? defaultSchemaForDataset(config.dataset);
  const authHeader = 'Basic ' + Buffer.from(`${config.apiKey}:`).toString('base64');

  const fetchPlan = buildFetchPlan(config);
  const allTicks: QuoteTick[] = [];

  // Check cache for each (symbol, day) and collect misses grouped by day
  const toFetchByDay = new Map<string, string[]>(); // day → symbols to fetch
  let cachedCount = 0;
  let totalPairs = 0;

  for (const [day, symbols] of fetchPlan) {
    for (const symbol of symbols) {
      totalPairs++;
      const cachePath = getDayCachePath({ dataset: config.dataset, schema, symbol, day });

      if (config.refreshCache) {
        await unlink(cachePath).catch(() => {});
      }

      const cached = await readCache(cachePath);
      if (cached) {
        cachedCount++;
        allTicks.push(...cached);
      } else {
        let dayList = toFetchByDay.get(day);
        if (!dayList) { dayList = []; toFetchByDay.set(day, dayList); }
        dayList.push(symbol);
      }
    }
  }

  if (toFetchByDay.size === 0) {
    log.debug(`All ${totalPairs} symbol-days cached (${allTicks.length} ticks)`);
    allTicks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return allTicks;
  }

  // Count total uncached symbol-days
  let uncachedPairs = 0;
  for (const syms of toFetchByDay.values()) uncachedPairs += syms.length;
  log.info(`${cachedCount}/${totalPairs} symbol-days cached, ${uncachedPairs} to fetch across ${toFetchByDay.size} days`);

  // Estimate cost: collect all uncached symbols and the min/max date range
  const allUncachedSymbols = new Set<string>();
  let minDay = '9999-99-99', maxDay = '0000-00-00';
  for (const [day, syms] of toFetchByDay) {
    for (const s of syms) allUncachedSymbols.add(s);
    if (day < minDay) minDay = day;
    if (day > maxDay) maxDay = day;
  }

  // Cost check (advisory — failure doesn't block fetch)
  try {
    const costRange = dayRangeUTC(maxDay);
    const costStart = dayRangeUTC(minDay).start;
    const costParams = new URLSearchParams({
      dataset: config.dataset,
      schema,
      symbols: Array.from(allUncachedSymbols).join(','),
      start: costStart.toISOString(),
      end: costRange.end.toISOString(),
    });

    const { res: costRes } = await fetchWithRetry(
      'https://hist.databento.com/v0/metadata.get_cost',
      {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: costParams.toString(),
      },
      { symbols: Array.from(allUncachedSymbols) },
    );

    const costData = z.number().nonnegative().parse(await costRes.json());
    const boundingCostUsd = costData / 100;

    // Count weekdays in the bounding range to scale proportionally
    let boundingWeekdays = 0;
    const cur = new Date(dayRangeUTC(minDay).start);
    while (cur <= dayRangeUTC(maxDay).end) {
      if (isTradingDay(cur)) boundingWeekdays++;
      cur.setDate(cur.getDate() + 1);
    }

    const uncachedDays = toFetchByDay.size;
    const scale = boundingWeekdays > 0 ? uncachedDays / boundingWeekdays : 1;
    const costUsd = boundingCostUsd * scale;

    log.info(`Estimated cost: $${costUsd.toFixed(2)} (${uncachedDays}/${boundingWeekdays} days of bounding $${boundingCostUsd.toFixed(2)}) for ${allUncachedSymbols.size} symbols (${schema})`);

    const maxCost = config.maxCostUsd ?? 5;
    if (costUsd > maxCost) {
      throw new Error(
        `[QuoteTape] Estimated cost $${costUsd.toFixed(2)} exceeds limit of $${maxCost.toFixed(2)}. ` +
        `Set maxCostUsd in config to override.`
      );
    }
  } catch (err) {
    // Cost-limit errors must propagate
    if (err instanceof Error && err.message.includes('exceeds limit')) throw err;
    log.warn(`Could not estimate cost: ${err instanceof Error ? err.message : err}. Proceeding anyway...`);
  }

  // Fetch day by day via loadQuoteTapeForDay
  const sortedDays = Array.from(toFetchByDay.keys()).sort();
  for (const day of sortedDays) {
    const symbols = toFetchByDay.get(day)!;
    const dayTicks = await loadQuoteTapeForDay({
      apiKey: config.apiKey,
      dataset: config.dataset,
      schema,
      symbols,
      day,
    });
    allTicks.push(...dayTicks);
  }

  allTicks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // ── Aggregate summary + anomaly detection ──────────────────────────
  const allSymbols = new Set<string>();
  for (const syms of fetchPlan.values()) for (const s of syms) allSymbols.add(s);

  // Count trading days per symbol in the fetch plan
  const symbolTradingDays = new Map<string, number>();
  for (const [day, syms] of fetchPlan) {
    if (!isTradingDay(parseDateKey(day))) continue;
    for (const s of syms) {
      symbolTradingDays.set(s, (symbolTradingDays.get(s) ?? 0) + 1);
    }
  }

  // Count ticks per symbol from allTicks
  const symbolTickCounts = new Map<string, { days: Set<string>; ticks: number }>();
  for (const tick of allTicks) {
    let stat = symbolTickCounts.get(tick.symbol);
    if (!stat) { stat = { days: new Set(), ticks: 0 }; symbolTickCounts.set(tick.symbol, stat); }
    stat.days.add(toDateKey(tick.timestamp));
    stat.ticks++;
  }

  // Count errors per symbol from fetchMetaMap
  const symbolErrors = new Map<string, number>();
  for (const [key, meta] of fetchMetaMap) {
    const sym = key.split(':')[0];
    if (!allSymbols.has(sym)) continue;
    // jsonErr/zodErr are shared across all symbols in a request, but meta.ticks is per-symbol
    // Count as error if status was not 200
    if (meta.status && meta.status !== 200) {
      symbolErrors.set(sym, (symbolErrors.get(sym) ?? 0) + 1);
    }
  }

  log.info('── fetch summary ──────────────────');
  for (const sym of allSymbols) {
    const totalDays = symbolTradingDays.get(sym) ?? 0;
    const stat = symbolTickCounts.get(sym);
    const daysWithData = stat?.days.size ?? 0;
    const ticks = stat?.ticks ?? 0;
    const errors = symbolErrors.get(sym) ?? 0;
    const noData = ticks === 0 && totalDays > 0;
    log.info(`  ${sym}: ${daysWithData}/${totalDays} days, ${ticks} ticks, ${errors} errors${noData ? '  ⚠ no data' : ''}`);
  }
  log.info('───────────────────────────────────');

  // Warn for symbols with zero ticks across all trading days
  for (const sym of allSymbols) {
    const totalDays = symbolTradingDays.get(sym) ?? 0;
    const stat = symbolTickCounts.get(sym);
    const ticks = stat?.ticks ?? 0;
    if (ticks === 0 && totalDays > 0) {
      // Find last requestId for this symbol
      let lastReqId: string | undefined;
      for (const [key, meta] of fetchMetaMap) {
        if (key.startsWith(`${sym}:`)) lastReqId = meta.requestId;
      }
      log.warn(
        `${sym}: 0 ticks across ${totalDays} trading days. ` +
        `Possible causes: symbol not in ${config.dataset}, date range predates listing, or API returned empty.` +
        (lastReqId ? ` Last req=${lastReqId}` : ''),
      );
    }
  }

  return allTicks;
}

/**
 * Fetch ticks for specific symbols within a narrow time window.
 * No caching — windows are small, unique, and cheap.
 */
export async function fetchTickWindow(params: {
  apiKey: string;
  dataset: string;
  schema?: string;
  symbols: string[];
  start: Date;
  end: Date;
}): Promise<QuoteTick[]> {
  if (params.symbols.length === 0) return [];
  if (params.start >= params.end) return [];

  const resolvedSchema = params.schema ?? defaultSchemaForDataset(params.dataset);
  const authHeader = 'Basic ' + Buffer.from(`${params.apiKey}:`).toString('base64');

  const fetchParams = new URLSearchParams({
    dataset: params.dataset,
    schema: resolvedSchema,
    encoding: 'json',
    pretty_px: 'true',
    pretty_ts: 'true',
    map_symbols: 'true',
    symbols: params.symbols.join(','),
    start: params.start.toISOString(),
    end: params.end.toISOString(),
  });

  const { res } = await fetchWithRetry(
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

  if (!res.body) return [];

  const ticks: QuoteTick[] = [];
  const reader = Readable.from(res.body as any);

  let bytesRead = 0;
  for await (const line of readLines(reader)) {
    bytesRead += Buffer.byteLength(line) + 1;
    if (bytesRead > MAX_RESPONSE_BYTES) {
      throw new Error(`[QuoteTape] Response exceeded ${MAX_RESPONSE_BYTES / 1024 / 1024}MB limit for tick window ${params.symbols.join(',')} (${bytesRead} bytes)`);
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    let raw: unknown;
    try { raw = JSON.parse(trimmed); } catch { continue; }

    const recordResult = DatabentoRecord.safeParse(raw);
    if (!recordResult.success) continue;

    const tick = parseTick(recordResult.data);
    if (!tick) continue;
    if (!isMarketHours(tick.timestamp)) continue;

    ticks.push(tick);
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
