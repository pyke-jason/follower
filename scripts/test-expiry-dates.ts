/**
 * Test script: validate getExpiryDates via ohlcv-1d probe.
 * Run: npx tsx scripts/test-expiry-dates.ts
 */
import { loadSecrets } from '../src/lib/secrets/index.js';
import { fetchTickWindow } from '../src/backtest/databento-tape.js';
import { formatOccSymbol } from '../src/backtest/occ-symbology.js';

await loadSecrets();
const apiKey = process.env.DATABENTO_API_KEY;
if (!apiKey) { console.error('DATABENTO_API_KEY not set'); process.exit(1); }

function dateToYMD(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function candidateFridays(from: Date, count: number): string[] {
  const expiries: string[] = [];
  const d = new Date(from);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + ((5 - dow + 7) % 7 || 7));
  for (let i = 0; i < count; i++) {
    expiries.push(dateToYMD(d));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return expiries;
}

/** Probe candidate expiries with ohlcv-1d — the approach for DatabentoMarketDataProvider.getExpiryDates */
async function getExpiryDates(
  apiKey: string,
  symbol: string,
  stockPrice: number,
  at: Date,
): Promise<string[]> {
  const interval = stockPrice < 20 ? 0.5 : stockPrice < 100 ? 1 : stockPrice < 500 ? 5 : 10;
  const atmStrike = Math.round(stockPrice / interval) * interval;
  const probeStrikes = [atmStrike - interval, atmStrike, atmStrike + interval];

  const fridays = candidateFridays(at, 12);

  const probeSymbols: string[] = [];
  const expiryForSymbol: string[] = [];
  for (const expiry of fridays) {
    for (const strike of probeStrikes) {
      probeSymbols.push(formatOccSymbol({ underlying: symbol, expiration: expiry, type: 'CALL', strike }));
      expiryForSymbol.push(expiry);
    }
  }

  // ohlcv-1d ts_event is midnight UTC of the NEXT day, so extend by 2 days to avoid boundary miss
  const dayStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 2 * 24 * 60 * 60 * 1000);

  const ticks = await fetchTickWindow({
    apiKey,
    dataset: 'OPRA.PILLAR',
    schema: 'ohlcv-1d',
    symbols: probeSymbols,
    start: dayStart,
    end: dayEnd,
    stypeIn: 'raw_symbol',
  });

  const symbolsWithData = new Set(ticks.map(t => t.symbol));
  const validExpiries = new Set<string>();
  for (let i = 0; i < probeSymbols.length; i++) {
    if (symbolsWithData.has(probeSymbols[i])) {
      validExpiries.add(expiryForSymbol[i]);
    }
  }

  return [...validExpiries].sort();
}

async function main() {
  const symbol = 'SPY';
  const at = new Date('2025-09-05T14:00:00Z');
  const stockPrice = 555;

  console.log(`getExpiryDates("${symbol}", at=${at.toISOString().slice(0, 10)}, price=$${stockPrice})\n`);

  const expiries = await getExpiryDates(apiKey, symbol, stockPrice, at);

  console.log(`\n${expiries.length} validated expiries:`);
  for (const e of expiries) console.log(`  ${e}`);
}

main().catch(err => { console.error(err); process.exit(1); });
