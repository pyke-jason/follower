/**
 * Litmus test: verify the stale-quote fallback for illiquid options.
 *
 * Scenario: M Nov 21 $17 put — first tick on Oct 6 is 10:03 AM ET,
 * but we need a quote at 9:48 AM ET. The fix should fall back to
 * Oct 3's last tick (bid=0.54, ask=0.62).
 *
 * Usage:  bash -c 'set -a && source .env && set +a && npx tsx scripts/test-stale-quote.ts'
 */

import { loadSpecificContracts } from '../src/backtest/databento-tape.js';
import { DatabentoMarketDataProvider } from '../src/backtest/market-data.js';
import { getPreviousTradingDayKey } from '../src/lib/et-date.js';

const apiKey = process.env.DATABENTO_API_KEY;
if (!apiKey) {
  console.error('Missing DATABENTO_API_KEY');
  process.exit(1);
}

const symbol = 'M     251121P00017000';
const dataset = 'OPRA.PILLAR';
const crashTime = new Date('2025-10-06T13:48:59Z'); // 9:48 AM ET

// ── 1. Verify raw tick availability ──
console.log('=== Raw tick availability (cbbo-1m) ===\n');

const oct3Ticks = await loadSpecificContracts({ apiKey, dataset, symbols: [symbol], day: '2025-10-03' });
const oct6Ticks = await loadSpecificContracts({ apiKey, dataset, symbols: [symbol], day: '2025-10-06' });

console.log(`Oct 3: ${oct3Ticks.length} ticks, last bid=${oct3Ticks.at(-1)?.bid} ask=${oct3Ticks.at(-1)?.ask} @ ${oct3Ticks.at(-1)?.timestamp.toISOString()}`);
console.log(`Oct 6: ${oct6Ticks.length} ticks, first @ ${oct6Ticks[0]?.timestamp.toISOString()}`);
console.log(`Oct 6 ticks before 9:48 AM ET: ${oct6Ticks.filter(t => t.timestamp <= crashTime).length}\n`);

// ── 2. Verify getPreviousTradingDayKey ──
console.log('=== getPreviousTradingDayKey ===\n');
console.log(`prev of 2025-10-06 (Mon) = ${getPreviousTradingDayKey('2025-10-06')}`); // should be 2025-10-03 (Fri)
console.log(`prev of 2025-10-03 (Fri) = ${getPreviousTradingDayKey('2025-10-03')}`); // should be 2025-10-02 (Thu)
console.log();

// ── 3. Test getQuote fallback via the provider ──
// Warm the in-memory cache with cbbo-1m ticks (matching real backtest flow
// where getOptionsChain → loadSpecificContracts → cacheOccTicks)
console.log('=== getQuote fallback test ===\n');

const md = new DatabentoMarketDataProvider(apiKey, 'DBEQ.BASIC', false, 'OPRA.PILLAR');

// Manually warm the cache for both days (simulates getOptionsChain having been called)
// The provider's loadDay for options goes through loadQuoteTapeForDay(cbbo-1s),
// but the real backtest path populates dayTicks via cacheOccTicks from loadSpecificContracts(cbbo-1m).
// We replicate that by prefetching Oct 3 and Oct 6 option data through loadSpecificContracts.
//
// Access the private dayTicks map to inject the cached ticks (matching cacheOccTicks behavior)
const dayTicks = (md as any).dayTicks as Map<string, typeof oct6Ticks>;

dayTicks.set(`${symbol}:2025-10-03`, oct3Ticks);
dayTicks.set(`${symbol}:2025-10-06`, oct6Ticks);

try {
  const quote = await md.getQuote(symbol, crashTime);
  console.log(`getQuote at 9:48 AM ET Oct 6 → bid=${quote.bid} ask=${quote.ask} ts=${quote.timestamp}`);
  console.log('✓ Stale-quote fallback worked!');
} catch (err) {
  console.error('✗ CRASHED:', err instanceof Error ? err.message : err);
  process.exit(1);
}
