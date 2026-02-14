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
  schema?: string;  // default 'cbbo-1s'
};

/**
 * Load historical quote tape from Databento HTTP API.
 * Returns ticks sorted chronologically.
 *
 * API: POST https://hist.databento.com/v0/timeseries.get_range
 * Auth: Basic Auth (API key as username, empty password)
 * Response: JSON lines (one JSON object per line)
 */
export async function loadQuoteTape(config: QuoteTapeConfig): Promise<QuoteTick[]> {
  const schema = config.schema ?? 'cbbo-1s';
  const url = 'https://hist.databento.com/v0/timeseries.get_range';

  const params = new URLSearchParams({
    dataset: config.dataset,
    schema,
    encoding: 'json',
    pretty_px: 'true',
    pretty_ts: 'true',
    map_symbols: 'true',
    symbols: config.symbols.join(','),
    start: config.start.toISOString(),
    end: config.end.toISOString(),
  });

  const authHeader = 'Basic ' + Buffer.from(`${config.apiKey}:`).toString('base64');

  console.log(`[QuoteTape] Fetching ${schema} data for ${config.symbols.join(', ')}...`);

  const res = await fetch(url, {
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

  const body = await res.text();
  const ticks: QuoteTick[] = [];

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: any;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const tick = parseTick(record);
    if (tick) ticks.push(tick);
  }

  // Sort chronologically
  ticks.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  console.log(`[QuoteTape] Loaded ${ticks.length} ticks`);
  return ticks;
}

function parseTick(record: any): QuoteTick | null {
  // Extract symbol: Databento uses `symbol` field when map_symbols=true
  const symbol = record.symbol ?? record.hd?.symbol;
  if (!symbol) return null;

  // Extract bid/ask prices
  // cbbo-1s / mbp-1 schema: bid_px_00 / ask_px_00 or bid_px / ask_px
  // With pretty_px=true, prices are already decimal numbers
  let bid: number | undefined;
  let ask: number | undefined;

  if (record.bid_px_00 != null) {
    bid = Number(record.bid_px_00);
    ask = Number(record.ask_px_00);
  } else if (record.bid_px != null) {
    bid = Number(record.bid_px);
    ask = Number(record.ask_px);
  } else if (record.levels?.length) {
    // levels array format
    bid = Number(record.levels[0]?.bid_px);
    ask = Number(record.levels[0]?.ask_px);
  }

  if (bid == null || ask == null || isNaN(bid) || isNaN(ask)) return null;

  // Extract timestamp: with pretty_ts=true, it's an ISO string
  const ts = record.ts_event ?? record.hd?.ts_event;
  if (!ts) return null;
  const timestamp = new Date(ts);
  if (isNaN(timestamp.getTime())) return null;

  return { symbol, bid, ask, timestamp };
}
