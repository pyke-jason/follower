import { describe, expect, it } from 'vitest';
import corpus from './__fixtures__/no-badge-trade-corpus.json';
import { parseMessage } from './parser.js';
import type { Message } from '@/db/schema.js';
import type { OrchestratorContext } from './types.js';

type CorpusRow = {
  messageId: string;
  author: string;
  timestamp: string;
  cleanText: string;
  badges: string[];
  symbols: string[];
};

function parse(row: CorpusRow) {
  const message: Message = {
    id: row.messageId,
    author: row.author,
    timestamp: row.timestamp,
    rawHtml: row.cleanText,
    cleanText: row.cleanText,
    badges: row.badges,
    symbols: row.symbols,
    actionHint: null,
    directionHint: null,
    detectedStrategies: [],
    isPaperTrade: false,
    confidence: null,
    ingestedAt: row.timestamp,
    contentHash: null,
    reactions: [],
  };

  const ctx: OrchestratorContext = {
    message,
    marketData: {
      getQuote: async () => {
        throw new Error('unused in parser corpus test');
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

describe('parseMessage no-badge trade corpus', () => {
  const rows = corpus as CorpusRow[];

  it('fixture only contains labeled trade rows with no trade badges', () => {
    for (const row of rows) {
      expect(row.symbols.length, `${row.messageId} is missing extracted symbols`).toBeGreaterThan(0);
      expect(
        row.badges.some((badge) => ['Long', 'Short', 'Exit'].includes(badge)),
        `${row.messageId} unexpectedly has a trade badge`,
      ).toBe(false);
    }
  });

  it('never hard-skips a labeled no-badge trade row', () => {
    const failures = rows
      .map((row) => ({ row, result: parse(row) }))
      .filter(({ result }) => result.isHardSkip);

    if (failures.length > 0) {
      throw new Error(
        failures
          .map(({ row, result }) =>
            `${row.messageId} ${row.author} skipReason=${result.skipReason ?? 'null'} text=${row.cleanText}`,
          )
          .join('\n'),
      );
    }

    expect(failures).toHaveLength(0);
  });
});
