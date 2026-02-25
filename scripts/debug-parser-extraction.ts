/**
 * Debug script: Verify the coordinated token extraction in parser.ts
 * Run: npx tsx scripts/debug-parser-extraction.ts
 * Delete after verification.
 */

import { parseMessage, strikesFromParse } from '../src/intents/orchestrator/parser.js';
import type { OrchestratorContext } from '../src/intents/orchestrator/types.js';
import { htmlToCleanText } from '../src/parsing/html.js';
import { extractBadges } from '../src/parsing/badges.js';
import { extractSymbols } from '../src/parsing/symbols.js';

function makeCtx(rawHtml: string, symbols: string[], timestamp = '2025-09-05T14:00:00.000Z'): OrchestratorContext {
  const cleanText = htmlToCleanText(rawHtml);
  const { badges } = extractBadges(rawHtml);
  const extractedSymbols = extractSymbols(rawHtml);
  return {
    messageId: 'test',
    rawHtml,
    cleanText,
    badges,
    symbols: symbols.length > 0 ? symbols : extractedSymbols,
    timestamp,
    author: 'testTrader',
    marketData: null as any,
    positions: null as any,
    chatHistory: null as any,
    traderConfig: { strategies: [], notes: null },
  };
}

type TestCase = {
  name: string;
  rawHtml: string;
  symbols: string[];
  timestamp?: string;
  expect: {
    strikes?: number[] | null;
    premiumHint?: number | null;
    expiryHint?: string | null;
    direction?: string | null;
    strategy?: string | null;
    action?: string | null;
  };
};

const cases: TestCase[] = [
  {
    name: 'QS selling puts — the motivating bug',
    rawHtml: '<html><head></head><body><span class="badge bg-success">Long</span>&nbsp;<a data-symbol="QS"><b>QS</b></a> via selling the Sept (19) $9.50 puts @ $.50</body></html>',
    symbols: ['QS'],
    expect: {
      strikes: [9.5],
      premiumHint: 0.5,
      expiryHint: 'sep 19',
      direction: 'SHORT',
      strategy: 'PUT',
      action: 'OPEN',
    },
  },
  {
    name: 'HUT sold puts (existing regression-001)',
    rawHtml: '<div><span class="badge bg-success">Long</span>&nbsp;<a href="/option-stalker/chart/HUT" target="os" data-symbol="HUT" data-criteria="Bear"><b>HUT</b></a>&nbsp;sold the 12/19 $36 puts for a credit of $0.88/contract</div>',
    symbols: ['HUT'],
    timestamp: '2025-12-12T20:07:36.000Z',
    expect: {
      strikes: [36],
      direction: 'SHORT',
      strategy: 'PUT',
      action: 'OPEN',
    },
  },
  {
    name: 'QCOM bought puts (existing regression-002)',
    rawHtml: '<html><head></head><body><span class="badge bg-danger">Short</span>&nbsp;Bought <a href="/option-stalker/chart/QCOM" target="os" data-symbol="QCOM" data-criteria="Bear"><b>QCOM</b></a> Nov (21) $160 puts $12.25</body></html>',
    symbols: ['QCOM'],
    timestamp: '2025-10-10T19:58:00.000Z',
    expect: {
      strikes: [160],
      direction: 'LONG',
      strategy: 'PUT',
      action: 'OPEN',
    },
  },
  {
    name: 'NVDA sold puts no badge (existing regression-003)',
    rawHtml: '<html><head></head><body><div>Sold 10 $180 Puts on <a href="/option-stalker/chart/NVDA" target="os" data-symbol="NVDA" data-criteria="Bear"><b>NVDA</b></a> for $1.80 - expiring tomorrow&nbsp;</div></body></html>',
    symbols: ['NVDA'],
    timestamp: '2025-12-11T18:38:41.000Z',
    expect: {
      strikes: [180],
      premiumHint: 1.8,
      expiryHint: 'tomorrow',
      direction: 'SHORT',
      strategy: 'PUT',
      action: 'OPEN',
    },
  },
  {
    name: 'SPY LEAP add with cost basis (existing regression-004)',
    rawHtml: '<html><head></head><body>Added to <a data-symbol="SPY"><b>SPY</b></a> Leaps - now 50 total contracts $38.97 avg</body></html>',
    symbols: ['SPY'],
    expect: {
      expiryHint: 'LEAP',
      strategy: 'CALL',
      action: 'ADD',
    },
  },
  {
    name: 'GLW PCS with strikes (existing regression-006)',
    rawHtml: '<html><head></head><body>Long <a data-symbol="GLW"><b>GLW</b></a> pcs 68/67 for .63 credit</body></html>',
    symbols: ['GLW'],
    expect: {
      strikes: [68, 67],
      premiumHint: 0.63,
      strategy: 'PCS',
      action: 'OPEN',
    },
  },
  {
    name: 'C Lotto puts (existing regression-008)',
    rawHtml: '<html><head></head><body><span class="badge bg-danger">Short</span>&nbsp;<a data-symbol="C"><b>C</b></a> Lotto weeklies $95.50 puts for .15</body></html>',
    symbols: ['C'],
    expect: {
      strikes: [95.5],
      premiumHint: 0.15,
      expiryHint: '0DTE',
      direction: 'LONG',
      strategy: 'PUT',
      action: 'OPEN',
    },
  },
  {
    name: 'SPY LEAP with Short badge and strikes (existing regression-005)',
    rawHtml: '<html><head></head><body><span class="badge bg-danger">Short</span>&nbsp;<a data-symbol="SPY"><b>SPY</b></a> - added another 10 the leaps - total 60 - avg. $27.67 - 3/26 - $600</body></html>',
    symbols: ['SPY'],
    timestamp: '2025-09-24T16:29:39.000Z',
    expect: {
      strikes: [600],
      strategy: 'CALL',
      action: 'ADD',
      direction: 'LONG',
    },
  },
];

let passed = 0;
let failed = 0;

for (const tc of cases) {
  const ctx = makeCtx(tc.rawHtml, tc.symbols, tc.timestamp);
  const result = parseMessage(ctx);

  const failures: string[] = [];

  for (const [key, expected] of Object.entries(tc.expect)) {
    const actual = (result as any)[key];

    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length || !actual.every((v: number, i: number) => v === expected[i])) {
        failures.push(`  ${key}: expected [${expected}], got [${actual}]`);
      }
    } else if (expected !== actual) {
      failures.push(`  ${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  if (failures.length === 0) {
    console.log(`  PASS  ${tc.name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${tc.name}`);
    for (const f of failures) console.log(f);
    console.log(`  Full: action=${result.action} sym=${result.symbol} strat=${result.strategy} dir=${result.direction} strikes=${JSON.stringify(result.strikes)} expiry=${result.expiryHint} premium=${result.premiumHint}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed out of ${cases.length}`);
process.exit(failed > 0 ? 1 : 0);
