import { describe, expect, it } from 'vitest';
import { parseMessage } from './parser.js';
import type { Message } from '@/db/schema.js';
import type { OrchestratorContext } from './types.js';

function makeMessage({
  cleanText,
  badges = [],
  symbols = [],
}: {
  cleanText: string;
  badges?: string[];
  symbols?: string[];
}): Message {
  return {
    id: 'msg-1',
    author: 'tester',
    timestamp: '2026-04-22T12:00:00.000Z',
    rawHtml: cleanText,
    cleanText,
    badges,
    symbols,
    actionHint: null,
    directionHint: null,
    detectedStrategies: [],
    isPaperTrade: false,
    confidence: null,
    ingestedAt: '2026-04-22T12:00:00.000Z',
    contentHash: null,
    reactions: [],
  };
}

function parse({
  cleanText,
  badges = [],
  symbols = [],
}: {
  cleanText: string;
  badges?: string[];
  symbols?: string[];
}) {
  const ctx: OrchestratorContext = {
    message: makeMessage({ cleanText, badges, symbols }),
    marketData: {
      getQuote: async () => {
        throw new Error('unused in parser test');
      },
      getOptionChain: async () => null,
      getExpiryDates: async () => [],
    },
    positions: {
      getPositions: async () => [],
    },
    chatHistory: {
      getRecentMessages: async () => '',
    },
  };
  return parseMessage(ctx);
}

describe('parseMessage no-badge routing', () => {
  const llmRouteCases = [
    {
      name: 'lotto shorthand',
      cleanText: 'CRSP lotto',
      symbols: ['CRSP'],
    },
    {
      name: 'spread notation with credit',
      cleanText: 'CRWV pcs oct 17 110/105 for 1.10 credit',
      symbols: ['CRWV'],
    },
    {
      name: 'compact option notation',
      cleanText: 'NVDA 170p 2.03 9/19',
      symbols: ['NVDA'],
    },
    {
      name: 'misspelled scaling out',
      cleanText: 'TSLA sclaing out 25%',
      symbols: ['TSLA'],
    },
    {
      name: 'back in stock re-entry prose',
      cleanText:
        'Actually, put myself back in the AMD position - I missed the SMA resistance there, so I am back in at $163.09',
      symbols: ['AMD'],
    },
    {
      name: 'in since price shorthand',
      cleanText: 'ATAI - had a beautiful breakout. In since $2.80.',
      symbols: ['ATAI'],
    },
    {
      name: 'fractional trim shorthand on options',
      cleanText: 'AMD 3/4 @ 3.70 160c',
      symbols: ['AMD'],
    },
    {
      name: 'avg/add shorthand',
      cleanText: 'AMD 150p add more avg 1.54',
      symbols: ['AMD'],
    },
    {
      name: 'compact room OPEN shorthand',
      cleanText: 'OPEN back into hod',
      symbols: ['TSLA'],
    },
  ];

  it.each(llmRouteCases)('routes $name to the LLM path', ({ cleanText, symbols }) => {
    const result = parse({ cleanText, symbols: [...symbols] });

    expect(result.isHardSkip).toBe(false);
    expect(result.action).toBeNull();
    expect(result.skipReason).toBeNull();
  });

  const hardSkipCases = [
    {
      name: 'symbol-only commentary with no cue',
      cleanText: 'BA family tree diagram looks clean here',
      symbols: ['BA'],
      skipReason: 'no trade badge or cue',
    },
    {
      name: 'symbol but monitoring prose',
      cleanText: 'Watching NVDA around VWAP here',
      symbols: ['NVDA'],
      skipReason: 'watchlist, alert, conditional, or future-intent language',
    },
    {
      name: 'trade-looking shorthand without extracted symbol',
      cleanText: 'CRSP lotto',
      symbols: [],
      skipReason: 'no trade badge or cue',
    },
    {
      name: 'non-trade badge still wins',
      cleanText: 'Watching NVDA here',
      badges: ['Feedback Request'],
      symbols: ['NVDA'],
      skipReason: 'non-trade badge: Feedback Request',
    },
  ];

  it.each(hardSkipCases)('hard-skips $name', ({ cleanText, badges, symbols, skipReason }) => {
    const result = parse({
      cleanText,
      ...(badges ? { badges: [...badges] } : {}),
      symbols: [...symbols],
    });

    expect(result.isHardSkip).toBe(true);
    expect(result.skipReason).toBe(skipReason);
    expect(result.action).toBeNull();
    expect(result.symbol).toBeNull();
  });
});
