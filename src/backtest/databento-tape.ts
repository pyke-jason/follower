import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { zCoercePrice } from '../lib/zod-financial.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('QuoteTape');

const CACHE_DIR = '.cache/databento';

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

/** Zod schema for Databento records — validates shape and value ranges.
 *  Uses z.coerce.number() because pretty_px:'true' returns prices as strings (e.g. "51.30"). */
const px = zCoercePrice.optional();

const DatabentoRecord = z.object({
  symbol: z.string().optional(),
  hd: z.object({ symbol: z.string().optional(), ts_event: z.string().optional() }).optional(),
  high: px,
  low: px,
  bid_px_00: px,
  ask_px_00: px,
  bid_px: px,
  ask_px: px,
  levels: z.array(z.object({ bid_px: px, ask_px: px })).optional(),
  ts_event: z.string().optional(),
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
}): string {
  const { dataset, schema, symbol, day } = params;
  const key = [dataset, schema, symbol, day].join('|');
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

/** Check if a timestamp falls within US equity market hours (9:30-16:00 ET, weekdays). */
function isMarketHours(ts: Date): boolean {
  const etStr = ts.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 570 && minutes <= 960; // 9:30 to 16:00
}

/** Format a Date as YYYY-MM-DD in ET. */
export function toDateKey(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

/** Get the start-of-day and start-of-next-day in UTC for a given YYYY-MM-DD ET date. */
function dayRangeUTC(day: string): { start: Date; end: Date } {
  // Parse as ET midnight
  const start = new Date(`${day}T00:00:00-05:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

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

      if (res.ok) return { res, retries: attempt };

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
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) days.add(toDateKey(cur));
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
}): Promise<QuoteTick[]> {
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
    log.debug(`fetch day=${params.day} symbols=${params.symbols.join(',')} ticks=${allTicks.length} cached=true`);
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
  let zodErr = 0;
  let noQuote = 0;
  let outsideMktHrs = 0;
  const reader = Readable.from(res.body as any);
  const rl = createInterface({ input: reader, terminal: false });

  for await (const line of rl) {
    bytesRead += Buffer.byteLength(line) + 1;
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
      zodErr++;
      log.debug(`zod validation failed: ${recordResult.error.issues.map(i => i.message).join('; ')}`);
      continue;
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
  if (zodErr) parts.push(`zodErr=${zodErr}`);
  if (noQuote) parts.push(`noQuote=${noQuote}`);
  if (outsideMktHrs) parts.push(`outsideMktHrs=${outsideMktHrs}`);
  parts.push(`ticks=${totalTicks}`);
  parts.push('cached=false');
  if (retries) parts.push(`retries=${retries}`);
  if (requestId) parts.push(`req=${requestId}`);
  parts.push(`dur=${durMs}ms`);
  log.info(parts.join(' '));

  // Fail-fast: if API returned records but every one failed zod validation, it's a schema mismatch
  if (records > 0 && totalTicks === 0 && zodErr > 0) {
    throw new Error(
      `[QuoteTape] Fatal: ${zodErr}/${records} records failed zod validation for ${uncachedSymbols.join(',')} on ${params.day}. ` +
      `This indicates a schema mismatch with the Databento API response.`
    );
  }

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

  // Cache each symbol's day data
  for (const [symbol, ticks] of ticksBySymbol) {
    ticks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const cachePath = getDayCachePath({ dataset: params.dataset, schema: resolvedSchema, symbol, day: params.day });
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

    const costData = z.number().finite().nonnegative().parse(await costRes.json());
    const boundingCostUsd = costData / 100;

    // Count weekdays in the bounding range to scale proportionally
    let boundingWeekdays = 0;
    const cur = new Date(dayRangeUTC(minDay).start);
    while (cur <= dayRangeUTC(maxDay).end) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) boundingWeekdays++;
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
    const d = new Date(`${day}T12:00:00Z`);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
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
  const rl = createInterface({ input: reader, terminal: false });

  for await (const line of rl) {
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

  const ts = record.ts_event ?? record.hd?.ts_event;
  if (!ts) return null;
  const timestamp = new Date(ts);
  if (isNaN(timestamp.getTime())) return null;

  return { symbol, bid, ask, timestamp };
}
