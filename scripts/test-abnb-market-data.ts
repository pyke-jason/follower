/**
 * Diagnose why ABNB 127P 2025-09-12 has no market data on 2025-09-04.
 *
 * Tests:
 * 1. What strikes does buildOccSymbols generate? (Does 127 get included?)
 * 2. What's in the disk cache for the 127P symbol?
 * 3. Can we fetch actual quote data from Databento for the 127P?
 * 4. What strikes does Databento actually have for ABNB options that day?
 */
import 'dotenv/config';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';

import { buildOccSymbols, formatOccSymbol } from '../src/backtest/occ-symbology';

// Mirrors the private strikeInterval from occ-symbology.ts
function strikeInterval(price: number): number {
  if (price < 25) return 0.5;
  if (price < 50) return 1;
  if (price < 200) return 2.5;
  if (price < 500) return 5;
  return 10;
}
import { loadSpecificContracts, loadQuoteTapeForDay } from '../src/backtest/databento-tape';

const CACHE_DIR = join(process.cwd(), '.cache', 'databento');
const API_KEY = process.env.DATABENTO_API_KEY!;
const OPTIONS_DATASET = 'OPRA.PILLAR';

function getDayCachePath(params: {
  dataset: string;
  schema: string;
  symbol: string;
  day: string;
}): string {
  const key = [params.dataset, params.schema, params.symbol, params.day].join('|');
  const hash = createHash('sha256').update(key).digest('hex');
  return join(CACHE_DIR, `${hash}.json`);
}

async function readCacheRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function testClaims() {
  const API_KEY2 = process.env.DATABENTO_API_KEY!;
  const authHeader = 'Basic ' + Buffer.from(`${API_KEY2}:`).toString('base64');

  // Claim #2: Does .OPT parent symbology work on OPRA.PILLAR?
  console.log('\n=== Claim #2: .OPT parent symbology ===');
  try {
    const params = new URLSearchParams({
      dataset: 'OPRA.PILLAR',
      schema: 'definition',
      stype_in: 'parent',
      symbols: 'ABNB.OPT',
      start: '2025-09-04',
      end: '2025-09-05',
      limit: '3',
    });
    const resp = await fetch('https://hist.databento.com/v0/timeseries.get_range', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    console.log(`  Status: ${resp.status}`);
    const text = await resp.text();
    const lines = text.trim().split('\n');
    console.log(`  Records returned: ${lines.length}`);
    if (lines.length > 0) {
      const first = JSON.parse(lines[0]);
      console.log(`  First record raw_symbol: ${first.raw_symbol ?? first.symbol ?? 'N/A'}`);
      console.log(`  → .OPT WORKS`);
    }
  } catch (err) {
    console.log(`  Error: ${err}`);
  }

  // Also test WITHOUT .OPT for comparison
  console.log('\n  Testing without .OPT suffix...');
  try {
    const params = new URLSearchParams({
      dataset: 'OPRA.PILLAR',
      schema: 'definition',
      stype_in: 'parent',
      symbols: 'ABNB',
      start: '2025-09-04',
      end: '2025-09-05',
      limit: '3',
    });
    const resp = await fetch('https://hist.databento.com/v0/timeseries.get_range', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    console.log(`  Status: ${resp.status}`);
    const text = await resp.text();
    const lines = text.trim().split('\n').filter(l => l.trim());
    console.log(`  Records returned: ${lines.length}`);
    if (lines.length > 0 && lines[0].trim()) {
      const first = JSON.parse(lines[0]);
      console.log(`  First record raw_symbol: ${first.raw_symbol ?? first.symbol ?? 'N/A'}`);
      console.log(`  → bare symbol also works`);
    } else {
      console.log(`  → bare symbol returns NOTHING`);
    }
  } catch (err) {
    console.log(`  Error: ${err}`);
  }

  // Claim #1: Check actual response sizes for loadSpecificContracts with 52 symbols
  console.log('\n=== Claim #1: Response size for 52-symbol cbbo-1m fetch ===');
  try {
    const { buildOccSymbols: bos } = await import('../src/backtest/occ-symbology');
    const symbols = bos({ underlying: 'ABNB', expiry: '2025-09-12', optionType: 'PUT', priceLow: 98.9, priceHigh: 148.4 });
    const costParams = new URLSearchParams({
      dataset: 'OPRA.PILLAR',
      schema: 'cbbo-1m',
      stype_in: 'raw_symbol',
      symbols: symbols.join(','),
      start: '2025-09-04T00:00:00Z',
      end: '2025-09-05T00:00:00Z',
    });
    const resp = await fetch('https://hist.databento.com/v0/metadata.get_cost', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: costParams.toString(),
    });
    const cost = await resp.json();
    console.log(`  ${symbols.length} symbols cbbo-1m cost: $${(cost as number / 100).toFixed(4)}`);

    // Actual size check
    const sizeParams = new URLSearchParams({
      dataset: 'OPRA.PILLAR',
      schema: 'cbbo-1m',
      stype_in: 'raw_symbol',
      encoding: 'json',
      pretty_px: 'true',
      pretty_ts: 'true',
      map_symbols: 'true',
      symbols: symbols.join(','),
      start: '2025-09-04T00:00:00Z',
      end: '2025-09-05T00:00:00Z',
    });
    const sizeResp = await fetch('https://hist.databento.com/v0/timeseries.get_range', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: sizeParams.toString(),
    });
    const body = await sizeResp.text();
    console.log(`  Response size: ${(body.length / 1024).toFixed(1)} KB`);
    console.log(`  Records: ${body.trim().split('\n').length}`);
    console.log(`  Under 10MB? ${body.length < 10 * 1024 * 1024 ? 'YES' : 'NO <<<< WOULD CRASH'}`);
  } catch (err) {
    console.log(`  Error: ${err}`);
  }
}

testClaims().catch(console.error);

async function main() {
  const symbol = 'ABNB';
  const expiry = '2025-09-12';
  const tradeDay = '2025-09-04';
  const targetStrike = 127;
  const underlyingPrice = 123.64;

  console.log('=== ABNB Market Data Diagnosis ===\n');

  // 1. Check what strikeInterval returns
  const interval = strikeInterval(underlyingPrice);
  console.log(`1. Strike interval for price $${underlyingPrice}: $${interval}`);

  // 2. Check what buildOccSymbols generates
  const strikeLow = underlyingPrice * 0.8;
  const strikeHigh = underlyingPrice * 1.2;
  const candidates = buildOccSymbols({
    underlying: symbol,
    expiry,
    optionType: 'PUT',
    priceLow: strikeLow,
    priceHigh: strikeHigh,
  });

  console.log(`2. Built ${candidates.length} candidate symbols (range $${strikeLow.toFixed(1)}-$${strikeHigh.toFixed(1)}):`);

  // Parse strikes from candidates
  const strikes = candidates.map(s => parseInt(s.slice(13, 21), 10) / 1000);
  console.log(`   Strikes: ${strikes.join(', ')}`);
  console.log(`   Includes $127? ${strikes.includes(127) ? 'YES' : 'NO <<<< PROBLEM'}`);
  console.log(`   Nearest: $${strikes.filter(s => Math.abs(s - 127) < 5).join(', ')}`);

  // 3. Check disk cache for the specific 127P symbol
  const occ127 = formatOccSymbol({
    underlying: symbol,
    expiration: expiry,
    type: 'PUT',
    strike: targetStrike,
  });
  console.log(`\n3. OCC symbol for $127P: "${occ127}"`);

  const cachePath = getDayCachePath({
    dataset: OPTIONS_DATASET,
    schema: 'cbbo-1m',
    symbol: occ127,
    day: tradeDay,
  });
  console.log(`   Cache path: ${cachePath}`);

  const cacheContent = await readCacheRaw(cachePath);
  if (cacheContent === null) {
    console.log('   Cache: NOT FOUND (never fetched)');
  } else {
    const parsed = JSON.parse(cacheContent);
    console.log(`   Cache: ${Array.isArray(parsed) ? `${parsed.length} ticks` : 'invalid format'}`);
    if (Array.isArray(parsed) && parsed.length > 0) {
      console.log(`   First tick: ${JSON.stringify(parsed[0])}`);
    }
  }

  // Also check a couple nearby days
  for (const checkDay of ['2025-09-03', '2025-09-02', '2025-09-05']) {
    const cp = getDayCachePath({
      dataset: OPTIONS_DATASET,
      schema: 'cbbo-1m',
      symbol: occ127,
      day: checkDay,
    });
    const cc = await readCacheRaw(cp);
    if (cc !== null) {
      const p = JSON.parse(cc);
      console.log(`   Cache ${checkDay}: ${Array.isArray(p) ? `${p.length} ticks` : 'invalid'}`);
    }
  }

  // 4. Try to fetch the 127P directly from Databento (this will cost money if not cached)
  if (!API_KEY) {
    console.log('\n4. DATABENTO_API_KEY not set, skipping live fetch');
    return;
  }

  console.log(`\n4. Fetching 127P directly via loadSpecificContracts...`);
  try {
    const ticks = await loadSpecificContracts({
      apiKey: API_KEY,
      dataset: OPTIONS_DATASET,
      symbols: [occ127],
      day: tradeDay,
    });
    console.log(`   Result: ${ticks.length} ticks`);
    if (ticks.length > 0) {
      console.log(`   First: bid=${ticks[0].bid} ask=${ticks[0].ask} at ${ticks[0].timestamp.toISOString()}`);
      console.log(`   Last:  bid=${ticks[ticks.length - 1].bid} ask=${ticks[ticks.length - 1].ask} at ${ticks[ticks.length - 1].timestamp.toISOString()}`);
    }
  } catch (err) {
    console.log(`   Error: ${err instanceof Error ? err.message : err}`);
  }

  // 5. Test the full getQuote flow by instantiating DatabentoMarketDataProvider
  console.log(`\n5. Testing getQuote flow (simulating SimBroker)...`);
  const { DatabentoMarketDataProvider } = await import('../src/backtest/market-data');

  const mdp = new DatabentoMarketDataProvider(API_KEY, 'DBEQ.BASIC', false, OPTIONS_DATASET);

  // Try at different times on 2025-09-04
  const testTimes = [
    '2025-09-04T13:30:00Z', // 9:30 ET (market open)
    '2025-09-04T13:34:00Z', // 9:34 ET (just before first tick)
    '2025-09-04T13:35:00Z', // 9:35 ET (just after first tick)
    '2025-09-04T14:00:00Z', // 10:00 ET
  ];

  for (const timeStr of testTimes) {
    const at = new Date(timeStr);
    try {
      const quote = await mdp.getQuote(occ127, at);
      console.log(`   ${timeStr}: bid=${quote.bid} ask=${quote.ask} (from ${quote.timestamp})`);
    } catch (err) {
      console.log(`   ${timeStr}: THREW — ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    }
  }

  // 6. Fetch raw cbbo-1s response to see the schema
  console.log(`\n6. Raw cbbo-1s response format (what loadQuoteTapeForDay fetches)...`);
  try {
    const authHeader = 'Basic ' + Buffer.from(`${API_KEY}:`).toString('base64');
    const start = new Date(`${tradeDay}T00:00:00Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const fetchParams = new URLSearchParams({
      dataset: OPTIONS_DATASET,
      schema: 'cbbo-1s',
      encoding: 'json',
      pretty_px: 'true',
      pretty_ts: 'true',
      map_symbols: 'true',
      stype_in: 'raw_symbol',
      symbols: occ127,
      start: start.toISOString(),
      end: end.toISOString(),
      limit: '3',
    });
    const resp = await fetch('https://hist.databento.com/v0/timeseries.get_range', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fetchParams.toString(),
    });
    const text = await resp.text();
    const lines = text.trim().split('\n').slice(0, 3);
    for (const line of lines) {
      console.log(`   ${line.slice(0, 300)}`);
    }
  } catch (err) {
    console.log(`   Error: ${err}`);
  }

  // 7. For comparison, raw cbbo-1m response
  console.log(`\n7. Raw cbbo-1m response format (what loadSpecificContracts fetches)...`);
  try {
    const authHeader = 'Basic ' + Buffer.from(`${API_KEY}:`).toString('base64');
    const start = new Date(`${tradeDay}T00:00:00Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const fetchParams = new URLSearchParams({
      dataset: OPTIONS_DATASET,
      schema: 'cbbo-1m',
      encoding: 'json',
      pretty_px: 'true',
      pretty_ts: 'true',
      map_symbols: 'true',
      stype_in: 'raw_symbol',
      symbols: occ127,
      start: start.toISOString(),
      end: end.toISOString(),
      limit: '3',
    });
    const resp = await fetch('https://hist.databento.com/v0/timeseries.get_range', {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fetchParams.toString(),
    });
    const text = await resp.text();
    const lines = text.trim().split('\n').slice(0, 3);
    for (const line of lines) {
      console.log(`   ${line.slice(0, 300)}`);
    }
  } catch (err) {
    console.log(`   Error: ${err}`);
  }

  // 8. Also try $1 increment strikes near 127 to see what actually exists
  console.log(`\n8. Checking $1-increment strikes near 127...`);
  const testStrikes = [125, 126, 127, 128, 129, 130];
  const testSymbols = testStrikes.map(s =>
    formatOccSymbol({ underlying: symbol, expiration: expiry, type: 'PUT', strike: s })
  );

  try {
    const ticks = await loadSpecificContracts({
      apiKey: API_KEY,
      dataset: OPTIONS_DATASET,
      symbols: testSymbols,
      day: tradeDay,
    });

    // Group by symbol
    const bySymbol = new Map<string, number>();
    for (const t of ticks) {
      bySymbol.set(t.symbol, (bySymbol.get(t.symbol) ?? 0) + 1);
    }

    for (const s of testStrikes) {
      const sym = formatOccSymbol({ underlying: symbol, expiration: expiry, type: 'PUT', strike: s });
      const count = bySymbol.get(sym) ?? 0;
      console.log(`   $${s}P: ${count} ticks ${s === 127 ? '<<<< TARGET' : ''}`);
    }
  } catch (err) {
    console.log(`   Error: ${err instanceof Error ? err.message : err}`);
  }
}

main().catch(console.error);
