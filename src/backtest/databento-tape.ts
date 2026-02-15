import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { z } from 'zod';

const CACHE_DIR = '.cache/databento';

/** Permissive Zod schema for Databento records — validates shape without being overly strict. */
const DatabentoRecord = z.object({
  symbol: z.string().optional(),
  hd: z.object({ symbol: z.string().optional(), ts_event: z.string().optional() }).optional(),
  // ohlcv-1m
  high: z.number().optional(),
  low: z.number().optional(),
  // cbbo-1s / bbo-1m / mbp-1
  bid_px_00: z.number().optional(),
  ask_px_00: z.number().optional(),
  bid_px: z.number().optional(),
  ask_px: z.number().optional(),
  levels: z.array(z.object({ bid_px: z.number().optional(), ask_px: z.number().optional() })).optional(),
  ts_event: z.string().optional(),
}).passthrough();

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
function getDayCachePath(
  dataset: string,
  schema: string,
  symbol: string,
  day: string, // YYYY-MM-DD
): string {
  const key = [dataset, schema, symbol, day].join('|');
  const hash = createHash('sha256').update(key).digest('hex');
  return join(CACHE_DIR, `${hash}.json`);
}

async function readCache(path: string): Promise<QuoteTick[] | null> {
  try {
    const data = await readFile(path, 'utf-8');
    const raw = JSON.parse(data) as Array<{ symbol: string; bid: number; ask: number; timestamp: string }>;
    return raw.map((t) => ({ ...t, timestamp: new Date(t.timestamp) }));
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
function toDateKey(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

/** Get the start-of-day and start-of-next-day in UTC for a given YYYY-MM-DD ET date. */
function dayRangeUTC(day: string): { start: Date; end: Date } {
  // Parse as ET midnight
  const start = new Date(`${day}T00:00:00-05:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
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
      const cachePath = getDayCachePath(config.dataset, schema, symbol, day);
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
    console.log(`[QuoteTape] All ${totalPairs} symbol-days cached (${allTicks.length} ticks)`);
    allTicks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return allTicks;
  }

  // Count total uncached symbol-days
  let uncachedPairs = 0;
  for (const syms of toFetchByDay.values()) uncachedPairs += syms.length;
  console.log(`[QuoteTape] ${cachedCount}/${totalPairs} symbol-days cached, ${uncachedPairs} to fetch across ${toFetchByDay.size} days`);

  // Estimate cost: collect all uncached symbols and the min/max date range
  const allUncachedSymbols = new Set<string>();
  let minDay = '9999-99-99', maxDay = '0000-00-00';
  for (const [day, syms] of toFetchByDay) {
    for (const s of syms) allUncachedSymbols.add(s);
    if (day < minDay) minDay = day;
    if (day > maxDay) maxDay = day;
  }

  // Cost check uses the bounding range (overestimates if symbolDates is sparse, but safe)
  const costRange = dayRangeUTC(maxDay);
  const costStart = dayRangeUTC(minDay).start;
  const costParams = new URLSearchParams({
    dataset: config.dataset,
    schema,
    symbols: Array.from(allUncachedSymbols).join(','),
    start: costStart.toISOString(),
    end: costRange.end.toISOString(),
  });

  const costRes = await fetch('https://hist.databento.com/v0/metadata.get_cost', {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: costParams.toString(),
  });

  if (costRes.ok) {
    const costData = await costRes.json() as number;
    const costUsd = costData / 100;
    console.log(`[QuoteTape] Estimated cost: $${costUsd.toFixed(2)} for ${allUncachedSymbols.size} symbols × ${toFetchByDay.size} days (${schema})`);

    const maxCost = config.maxCostUsd ?? 5;
    if (costUsd > maxCost) {
      throw new Error(
        `[QuoteTape] Estimated cost $${costUsd.toFixed(2)} exceeds limit of $${maxCost.toFixed(2)}. ` +
        `Set maxCostUsd in config to override.`
      );
    }
  } else {
    console.warn(`[QuoteTape] Could not estimate cost (${costRes.status}), proceeding anyway...`);
  }

  // Fetch day by day — each request scoped to exactly the symbols needed that day
  const sortedDays = Array.from(toFetchByDay.keys()).sort();
  for (const day of sortedDays) {
    const symbols = toFetchByDay.get(day)!;
    const { start, end } = dayRangeUTC(day);

    console.log(`[QuoteTape] Fetching ${day}: ${symbols.length} symbols...`);

    const params = new URLSearchParams({
      dataset: config.dataset,
      schema,
      encoding: 'json',
      pretty_px: 'true',
      pretty_ts: 'true',
      map_symbols: 'true',
      symbols: symbols.join(','),
      start: start.toISOString(),
      end: end.toISOString(),
    });

    const res = await fetch('https://hist.databento.com/v0/timeseries.get_range', {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Databento ${res.status}: ${text}`);
    }

    if (!res.body) {
      throw new Error('Response body is null');
    }

    // Bucket ticks by symbol
    const ticksBySymbol = new Map<string, QuoteTick[]>();
    for (const sym of symbols) ticksBySymbol.set(sym, []);

    // Stream the response line by line
    let bytesRead = 0;
    const reader = Readable.from(res.body as any);
    const rl = createInterface({ input: reader, terminal: false });

    for await (const line of rl) {
      bytesRead += Buffer.byteLength(line) + 1; // +1 for newline
      const trimmed = line.trim();
      if (!trimmed) continue;

      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const recordResult = DatabentoRecord.safeParse(raw);
      if (!recordResult.success) continue;
      const record = recordResult.data;

      const tick = parseTick(record);
      if (!tick) continue;
      if (!isMarketHours(tick.timestamp)) continue;

      const bucket = ticksBySymbol.get(tick.symbol);
      if (bucket) {
        bucket.push(tick);
      } else {
        ticksBySymbol.set(tick.symbol, [tick]);
      }
    }

    console.log(`[QuoteTape] Downloaded ${(bytesRead / 1024 / 1024).toFixed(2)} MB for ${day}`);

    // Cache each symbol's day data
    for (const [symbol, ticks] of ticksBySymbol) {
      ticks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      const cachePath = getDayCachePath(config.dataset, schema, symbol, day);
      await writeCache(cachePath, ticks);
      allTicks.push(...ticks);
    }
  }

  allTicks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  console.log(`[QuoteTape] Total: ${allTicks.length} ticks across ${totalPairs} symbol-days`);

  return allTicks;
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
