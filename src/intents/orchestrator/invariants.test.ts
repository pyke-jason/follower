import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/db/schema.js';
import { resolveOpenPath, resolveAddPath } from './open-path.js';
import { resolvePositionPath } from './position-path.js';
import { TradePositionSchema, type OrchestratorContext, type ParseResult, type TradePosition } from './types.js';

const message: Message = {
  id: 'msg-invariant',
  author: 'Trader',
  timestamp: '2026-04-26T14:00:00.000Z',
  rawHtml: 'test',
  cleanText: 'test',
  badges: [],
  symbols: ['AAPL'],
  actionHint: null,
  directionHint: null,
  detectedStrategies: [],
  isPaperTrade: false,
  confidence: null,
  ingestedAt: '2026-04-26T14:00:00.000Z',
  contentHash: null,
  reactions: [],
};

function makeParse(overrides: Partial<ParseResult>): ParseResult {
  return {
    action: null,
    symbol: null,
    direction: null,
    strategy: null,
    strikes: null,
    expiryHint: null,
    premiumHint: null,
    exitPercent: null,
    targetStrategy: null,
    isLotto: false,
    isStrangle: false,
    hasCanonicalMatch: true,
    isHardSkip: false,
    skipReason: null,
    ruleId: null,
    routeReason: null,
    complexityFlags: new Set(),
    ...overrides,
  };
}

function makePosition(overrides: Partial<TradePosition> = {}): TradePosition {
  return {
    id: 'trade-1',
    symbol: 'AAPL',
    strategy: 'STOCK',
    direction: 'LONG',
    quantity: 100,
    openedAt: '2026-04-26T13:00:00.000Z',
    legs: [{
      symbol: 'AAPL',
      strike: 0,
      expiry: '',
      type: 'STOCK',
      action: 'BUY',
      quantity: 100,
    }],
    ...overrides,
  };
}

function makeContext(positions: TradePosition[] = []): OrchestratorContext {
  return {
    message,
    marketData: {
      getQuote: vi.fn(async () => ({
        symbol: 'AAPL',
        bid: 199.9,
        ask: 200.1,
        last: 200,
        volume: 1000,
        timestamp: '2026-04-26T14:00:00.000Z',
      })),
      getOptionChain: vi.fn(async () => null),
      getExpiryDates: vi.fn(async () => []),
    },
    positions: {
      getPositions: vi.fn(async () => positions),
    },
    chatHistory: {
      getRecentMessages: vi.fn(async () => ''),
    },
  };
}

describe('orchestrator production invariants', () => {
  it('rejects open trade positions without a concrete quantity', () => {
    expect(() =>
      TradePositionSchema.parse({
        ...makePosition(),
        quantity: null,
      }),
    ).toThrow();
  });

  it('routes strategy mismatched exits to manual review instead of fuzzy-closing the only symbol match', async () => {
    const result = await resolvePositionPath(
      makeParse({ action: 'CLOSE', symbol: 'AAPL', strategy: 'CALL', direction: 'LONG' }),
      makeContext([makePosition({ strategy: 'STOCK' })]),
    );

    expect(result).toMatchObject({
      outcome: 'MANUAL_REVIEW',
      reason: expect.stringContaining('strategy mismatch'),
    });
  });

  it('routes ambiguous exits to manual review instead of picking the most recent position', async () => {
    const result = await resolvePositionPath(
      makeParse({ action: 'CLOSE', symbol: 'AAPL', strategy: 'STOCK' }),
      makeContext([
        makePosition({ id: 'older', openedAt: '2026-04-26T13:00:00.000Z' }),
        makePosition({ id: 'newer', openedAt: '2026-04-26T13:30:00.000Z' }),
      ]),
    );

    expect(result).toMatchObject({
      outcome: 'MANUAL_REVIEW',
      reason: expect.stringContaining('multiple positions found'),
    });
  });

  it('routes ambiguous adds to manual review instead of picking the most recent position', async () => {
    const result = await resolveAddPath(
      makeParse({ action: 'ADD', symbol: 'AAPL', strategy: 'STOCK' }),
      makeContext([
        makePosition({ id: 'older', openedAt: '2026-04-26T13:00:00.000Z' }),
        makePosition({ id: 'newer', openedAt: '2026-04-26T13:30:00.000Z' }),
      ]),
    );

    expect(result).toMatchObject({
      outcome: 'MANUAL_REVIEW',
      reason: expect.stringContaining('multiple positions found'),
    });
  });

  it('does not invent live option expiries when market data has none', async () => {
    const result = await resolveOpenPath(
      makeParse({
        action: 'OPEN',
        symbol: 'AAPL',
        strategy: 'CALL',
        direction: 'LONG',
        strikes: [200],
      }),
      makeContext(),
    );

    expect(result).toMatchObject({
      outcome: 'MANUAL_REVIEW',
      reason: 'No expiry or premium to infer from',
    });
  });
});
