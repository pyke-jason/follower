/**
 * Debug script: verify EXIT_VERB_FALSE_POSITIVE_RE proposal
 *
 * Tests the proposed regex filter against:
 * 1. Known false positives (should be BLOCKED by filter → action stays null)
 * 2. Legitimate soft exits (should NOT be blocked → action stays CLOSE)
 *
 * Run: npx tsx scripts/debug-exit-false-positives.ts
 */

import { parseMessage } from '../src/intents/orchestrator/parser.js';
import { htmlToCleanText } from '../src/parsing/html.js';
import { extractBadges } from '../src/parsing/badges.js';
import { extractSymbols } from '../src/parsing/symbols.js';
import type { OrchestratorContext } from '../src/intents/orchestrator/types.js';

// ── Proposed regex ──────────────────────────────────────────────────────────

const EXIT_VERB_RE = /\b(exit(?:ing|ed)?|clos(?:e[ds]?|ing)|exiting|took\s+(?:\w+\s+)?profits?|stopped out|sold out)\b/i;
const EXIT_VERB_FALSE_POSITIVE_RE =
  /\bclosing\s+down\b|\bclose\s+to\b|\b(?:into|near|before|after|towards?)\s+the\s+close\b/i;

// ── Test cases ──────────────────────────────────────────────────────────────

type TestCase = {
  id: string;
  label: string;
  rawHtml: string;
  author: string;
  timestamp: string;
  expectedAction: string | null; // null = no action detected (skip/LLM path)
};

const FALSE_POSITIVES: TestCase[] = [
  {
    id: 'fp-001',
    label: '"closing down" (business closure)',
    rawHtml: '<html><head></head><body><div>At this point, <a href="/option-stalker/chart/AAPL" target="os" data-symbol="AAPL" data-criteria="Bull"><b>AAPL</b></a> could announce they are closing down due to economic reasons and the market would go - "More business for everyone else! Push higher!"</div></body></html>',
    author: 'Hariseldon',
    timestamp: '2025-09-04T20:07:18.000Z',
    expectedAction: null,
  },
  {
    id: 'fp-002',
    label: '"close to" (proximity)',
    rawHtml: '<html><head></head><body><div>&nbsp;Close to yesterdays high - also <a href="/option-stalker/chart/OSCR" target="os" data-symbol="OSCR" data-criteria="Bull"><b>OSCR</b></a> is developing a pattern of popping up, retreating and then heading back to the high&nbsp;</div></body></html>',
    author: 'Hariseldon',
    timestamp: '2025-09-05T18:30:00.000Z',
    expectedAction: null,
  },
  {
    id: 'fp-003',
    label: '"into the close" (market close)',
    rawHtml: '<html><head></head><body><div>Now I just need <a href="/option-stalker/chart/MSFT" target="os" data-symbol="MSFT"><b>MSFT</b></a> to drop into the close</div></body></html>',
    author: 'Hariseldon',
    timestamp: '2025-09-11T19:30:00.000Z',
    expectedAction: null,
  },
];

const LEGITIMATE_EXITS: TestCase[] = [
  {
    id: 'legit-001',
    label: '"I closed my PLTR trade" (past tense exit)',
    rawHtml: '<html><head></head><body><div>I closed my <a href="/option-stalker/chart/PLTR" target="os" data-symbol="PLTR" data-criteria="Bear"><b>PLTR</b></a> trade this morning for a nice profit</div></body></html>',
    author: 'Hariseldon',
    timestamp: '2025-10-10T14:00:00.000Z',
    expectedAction: 'CLOSE',
  },
  {
    id: 'legit-002',
    label: '"exited TSLA pcs for a profit" (past tense exit)',
    rawHtml: '<html><head></head><body><div>Also exited <a href="/option-stalker/chart/TSLA" target="os" data-symbol="TSLA" data-criteria="Bear"><b>TSLA</b></a> pcs for a profit</div></body></html>',
    author: 'Dave W',
    timestamp: '2025-10-15T20:00:00.000Z',
    expectedAction: 'CLOSE',
  },
  {
    id: 'legit-003',
    label: '"took profit in EBAY" (took profits verb)',
    rawHtml: '<html><head></head><body><div>Glad I took profit in <a href="/option-stalker/chart/EBAY" target="os" data-symbol="EBAY"><b>EBAY</b></a> long early</div></body></html>',
    author: 'Hariseldon',
    timestamp: '2025-09-12T16:00:00.000Z',
    expectedAction: 'CLOSE',
  },
  {
    id: 'legit-004',
    label: '"stopped out of AAPL" (stopped out verb)',
    rawHtml: '<html><head></head><body><div>Stopped out of <a href="/option-stalker/chart/AAPL" target="os" data-symbol="AAPL"><b>AAPL</b></a> for a small loss</div></body></html>',
    author: 'Hariseldon',
    timestamp: '2025-09-12T16:00:00.000Z',
    expectedAction: 'CLOSE',
  },
  {
    id: 'legit-005',
    label: '"Exit badge CLOSE" (badge-based, should be unaffected)',
    rawHtml: '<html><head></head><body><span class="badge bg-primary">Exit</span>&nbsp;<a href="/option-stalker/chart/MSTR" target="os" data-symbol="MSTR"><b>MSTR</b></a> for a .11 loss on the lotto - not enough time left&nbsp;</body></html>',
    author: 'Hariseldon',
    timestamp: '2025-12-12T20:50:39.000Z',
    expectedAction: 'CLOSE',
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(tc: TestCase): OrchestratorContext {
  const cleanText = htmlToCleanText(tc.rawHtml);
  const { badges } = extractBadges(tc.rawHtml);
  const symbols = extractSymbols(tc.rawHtml);

  return {
    messageId: tc.id,
    rawHtml: tc.rawHtml,
    cleanText,
    badges,
    symbols,
    timestamp: tc.timestamp,
    author: tc.author,
    // Stubs — parser is sync, zero I/O, doesn't call these
    marketData: {} as OrchestratorContext['marketData'],
    positions: {} as OrchestratorContext['positions'],
    chatHistory: {} as OrchestratorContext['chatHistory'],
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════════');
console.log('  EXIT_VERB_FALSE_POSITIVE_RE proposal validation');
console.log('═══════════════════════════════════════════════════════════════\n');

// Step 1: Regex-level check (independent of parser)
console.log('── Step 1: Regex-level matches ────────────────────────────────\n');

for (const tc of [...FALSE_POSITIVES, ...LEGITIMATE_EXITS]) {
  const cleanText = htmlToCleanText(tc.rawHtml);
  const exitMatch = EXIT_VERB_RE.test(cleanText);
  const fpMatch = EXIT_VERB_FALSE_POSITIVE_RE.test(cleanText);
  const wouldBlock = exitMatch && fpMatch;

  const isFP = FALSE_POSITIVES.includes(tc);
  const status = isFP
    ? (wouldBlock ? '  PASS (blocked)' : '  FAIL (not blocked!)')
    : (wouldBlock ? '  FAIL (wrongly blocked!)' : '  PASS (not blocked)');

  console.log(`${status} [${tc.id}] ${tc.label}`);
  console.log(`         EXIT_VERB_RE: ${exitMatch}, FP_RE: ${fpMatch}`);
  console.log(`         text: "${cleanText.slice(0, 80)}..."\n`);
}

// Step 2: Parser-level check (current parser, before fix)
console.log('── Step 2: Current parser behavior (BEFORE fix) ──────────────\n');

let failCount = 0;

for (const tc of [...FALSE_POSITIVES, ...LEGITIMATE_EXITS]) {
  const ctx = makeCtx(tc);
  const result = parseMessage(ctx);

  const actualAction = result.isHardSkip ? 'HARD_SKIP' : (result.action ?? null);
  const expected = tc.expectedAction;
  const pass = actualAction === expected;

  if (!pass) failCount++;

  const icon = pass ? '  PASS' : '  FAIL';
  console.log(`${icon} [${tc.id}] ${tc.label}`);
  console.log(`         expected: ${expected ?? 'null'}, got: ${actualAction ?? 'null'}`);
  if (!pass) {
    console.log(`         ^^ MISMATCH — this is what the fix should address`);
  }
  console.log();
}

console.log('── Summary ────────────────────────────────────────────────────\n');
const total = FALSE_POSITIVES.length + LEGITIMATE_EXITS.length;
console.log(`Total: ${total} cases, ${total - failCount} pass, ${failCount} fail`);

if (failCount > 0) {
  console.log(`\n${failCount} case(s) need fixing. The proposed EXIT_VERB_FALSE_POSITIVE_RE would address the false positives.`);
  console.log('After applying the fix to parser.ts line 774, re-run this script to verify all pass.');
} else {
  console.log('\nAll cases pass! The parser correctly handles these cases.');
}
