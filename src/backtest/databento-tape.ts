import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { zCoercePrice } from '../lib/zod-financial.js';
import { createLogger } from '../lib/logger.js';
import { toDateKeyET, parseDateKey, isTradingDay, getPreviousTradingDayKey } from '../lib/et-date.js';
import { formatLogTimeET } from '../lib/et-logging.js';
import { parseOccSymbol } from './occ-symbology.js';
import { loadCachedChain, saveCachedChain } from './tick-cache-db.js';
import type { TickCacheDB } from './tick-cache-db.js';

const log = createLogger('QuoteTape');

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

/** Per-symbol fetch metadata for downstream error enrichment. */
type FetchMeta = {
  status?: number;
  requestId?: string;
  bytes: number;
  records: number;
  ticks: number;
};

const fetchMetaMap = new Map<string, FetchMeta>();

export function getFetchMeta(symbol: string): FetchMeta | undefined {
  return fetchMetaMap.get(symbol);
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
  open?: number;
  close?: number;
  volume?: number;
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

/** Return portions of [start, end] not covered by any existing interval. */
export function getUncoveredGaps(
  ranges: [number, number][],
  start: number,
  end: number,
): [number, number][] {
  const relevant = ranges
    .filter(([lo, hi]) => hi > start && lo < end)
    .sort((a, b) => a[0] - b[0]);

  const gaps: [number, number][] = [];
  let cursor = start;

  for (const [lo, hi] of relevant) {
    if (lo > cursor) gaps.push([cursor, Math.min(lo, end)]);
    cursor = Math.max(cursor, hi);
  }

  if (cursor < end) gaps.push([cursor, end]);
  return gaps;
}

// ── Cache types ───────────────────────────────────────────────────

export type TickCacheData = {
  ranges: [number, number][];
  ticks: QuoteTick[];
};

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
          log.debug(
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
  db: TickCacheDB;
}): Promise<ChainDefinition[]> {
  const authHeader = 'Basic ' + Buffer.from(`${params.apiKey}:`).toString('base64');

  if (!params.refreshCache) {
    const cached = await loadCachedChain(params.db, params.dataset, params.parentSymbol, params.day);
    if (cached) {
      log.debug(`definition cache hit: ${params.parentSymbol} ${params.day} (${cached.length} contracts)`);
      return cached;
    }
  }

  // Definitions are daily snapshots — use date-only range (Databento requires UTC midnight start)
  const definitions = await fetchDefinitionSnapshot(authHeader, params.dataset, params.parentSymbol, params.day);

  // Only cache non-empty results — empty may be transient (pre-market, API issues)
  if (definitions.length > 0) {
    await saveCachedChain(params.db, params.dataset, params.parentSymbol, params.day, definitions);
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

    ticks.push(tick);
  }

  const durMs = Date.now() - fetchStart;
  const parts: string[] = [
    `tick-window ${params.symbols.length <= 3 ? params.symbols.join(',') : `${params.symbols.length} symbols`}`,
    `schema=${resolvedSchema}`,
    `range=${formatLogTimeET(params.start)}..${formatLogTimeET(params.end)} ET`,
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
    fetchMetaMap.set(sym, {
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
  const isOhlcv = record.high != null && record.low != null;

  // ohlcv schema: synthesize bid/ask from high/low
  if (isOhlcv) {
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
  let timestamp = new Date(ts);
  if (isNaN(timestamp.getTime())) return null;

  // ohlcv-1d ts_event = midnight UTC of the NEXT calendar day (Monday for Friday).
  // toDateKeyET maps midnight UTC → 8pm ET previous day, which works for Mon-Thu
  // but maps Friday bars to Sunday. Snap non-trading-day timestamps to the
  // previous trading day at noon UTC so they sort and cache correctly.
  if (isOhlcv) {
    const dayKey = toDateKeyET(timestamp);
    if (!isTradingDay(parseDateKey(dayKey))) {
      const corrected = getPreviousTradingDayKey(dayKey);
      if (corrected) {
        timestamp = parseDateKey(corrected); // noon UTC on the trading day
      }
    }
  }

  const tick: QuoteTick = { symbol, bid, ask, timestamp };
  if (isOhlcv) {
    if (record.open != null) tick.open = record.open;
    if (record.close != null) tick.close = record.close;
    tick.volume = record.volume ?? 0;
  }
  return tick;
}
