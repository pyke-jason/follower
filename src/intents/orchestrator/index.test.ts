import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, TradeLeg } from '@/db/schema.js';
import type { Agent } from '@/agent/result.js';
import type { OrchestratorEnv, ResolvedSignal, TradePosition } from './types.js';

const {
  resolveOpenPathMock,
  resolveAddPathMock,
  resolvePositionPathMock,
  resolveLLMPathMock,
  writeIntentMock,
} = vi.hoisted(() => ({
  resolveOpenPathMock: vi.fn(),
  resolveAddPathMock: vi.fn(),
  resolvePositionPathMock: vi.fn(),
  resolveLLMPathMock: vi.fn(),
  writeIntentMock: vi.fn(),
}));

vi.mock('./open-path.js', () => ({
  resolveOpenPath: resolveOpenPathMock,
  resolveAddPath: resolveAddPathMock,
}));

vi.mock('./position-path.js', () => ({
  resolvePositionPath: resolvePositionPathMock,
  buildReversalLeg: vi.fn((leg: TradeLeg, underlyingSymbol: string, quantity: number) => ({
    type: leg.type === 'STOCK' ? 'stock' : 'option',
    symbol: underlyingSymbol,
    ...(leg.type === 'STOCK'
      ? { side: leg.action === 'BUY' ? 'SELL' : 'BUY', quantity }
      : {
          expiry: leg.expiry,
          optionType: leg.type,
          strike: leg.strike,
          side: leg.action === 'BUY' ? 'SELL' : 'BUY',
          quantity,
        }),
  })),
}));

vi.mock('./llm-path.js', () => ({
  resolveLLMPath: resolveLLMPathMock,
}));

vi.mock('./intent-cache.js', () => ({
  INTENT_VERSION: 60,
  writeIntent: writeIntentMock,
}));

vi.mock('../trader-context.js', () => ({
  getRecentChatMessages: vi.fn(async () => []),
  formatChatContext: vi.fn(() => ''),
}));

import { resolveOrchestrator } from './index.js';

function makeMessage({
  id,
  cleanText,
  badges = [],
  symbols = [],
}: {
  id: string;
  cleanText: string;
  badges?: string[];
  symbols?: string[];
}): Message {
  return {
    id,
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

function makeSignal(params: {
  symbol: string;
  action: 'OPEN' | 'ADD' | 'CLOSE' | 'TRIM' | 'LEG_OFF';
  side: 'BUY' | 'SELL';
  tradeId?: string;
}): ResolvedSignal {
  return {
    orderType: 'STOCK',
    action: params.action,
    legs: [{ type: 'stock', symbol: params.symbol, side: params.side, quantity: 1 }],
    ...(params.tradeId ? { tradeId: params.tradeId } : {}),
  };
}

function makeEnv(): OrchestratorEnv {
  const agent: Agent = {
    identity: { provider: 'xai', model: 'test-model' },
    run: vi.fn(async () => {
      throw new Error('unexpected agent.run call');
    }),
  };

  return {
    getPositions: vi.fn(async () => []),
    agent,
    broker: {
      getQuote: vi.fn(async () => ({ bid: 100, ask: 101, last: 100.5, bidSize: 1, askSize: 1, lastSize: 1 })),
    } as unknown as OrchestratorEnv['broker'],
    emitter: {
      emit: vi.fn(async () => {}),
    },
  };
}

describe('resolveOrchestrator route policy', () => {
  beforeEach(() => {
    resolveOpenPathMock.mockResolvedValue({ outcome: 'EXECUTE', signals: [makeSignal({ symbol: 'NVDA', action: 'OPEN', side: 'BUY' })] });
    resolveAddPathMock.mockResolvedValue({ outcome: 'EXECUTE', signals: [makeSignal({ symbol: 'NVDA', action: 'ADD', side: 'BUY' })] });
    resolvePositionPathMock.mockResolvedValue({ outcome: 'EXECUTE', signals: [makeSignal({ symbol: 'WMT', action: 'CLOSE', side: 'SELL', tradeId: 'trade-1' })] });
    resolveLLMPathMock.mockResolvedValue({ outcome: 'SKIP', reason: 'mock llm result', classifierSignals: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes non-canonical exit prose to the LLM path', async () => {
    const result = await resolveOrchestrator(
      makeMessage({
        id: '433708',
        cleanText: 'Exit TGT short on the shares (still holding the Puts) for .62 profit per share (1,000)',
        badges: ['Exit'],
        symbols: ['TGT'],
      }),
      makeEnv(),
    );

    expect(resolveLLMPathMock).toHaveBeenCalledOnce();
    expect(resolvePositionPathMock).not.toHaveBeenCalled();
    expect(result.parseResult?.hasCanonicalMatch).toBe(false);
  });

  it('keeps canonical stock opens on the deterministic path', async () => {
    const result = await resolveOrchestrator(
      makeMessage({
        id: 'open-1',
        cleanText: 'Long NVDA 182.38',
        badges: ['Long'],
        symbols: ['NVDA'],
      }),
      makeEnv(),
    );

    expect(resolveOpenPathMock).toHaveBeenCalledOnce();
    expect(resolveLLMPathMock).not.toHaveBeenCalled();
    expect(result.parseResult?.hasCanonicalMatch).toBe(true);
  });

  it('keeps canonical stock closes on the deterministic path', async () => {
    const result = await resolveOrchestrator(
      makeMessage({
        id: 'close-1',
        cleanText: 'Exit WMT at $103.22 final sell with profit.',
        badges: ['Exit'],
        symbols: ['WMT'],
      }),
      makeEnv(),
    );

    expect(resolvePositionPathMock).toHaveBeenCalledOnce();
    expect(resolveLLMPathMock).not.toHaveBeenCalled();
    expect(result.parseResult?.hasCanonicalMatch).toBe(true);
  });

  it('still hard-skips messages with no badge or cue', async () => {
    const result = await resolveOrchestrator(
      makeMessage({
        id: 'skip-1',
        cleanText: 'Watching NVDA around VWAP here',
        symbols: ['NVDA'],
      }),
      makeEnv(),
    );

    expect(result.outcome).toBe('SKIP');
    expect(resolveOpenPathMock).not.toHaveBeenCalled();
    expect(resolvePositionPathMock).not.toHaveBeenCalled();
    expect(resolveLLMPathMock).not.toHaveBeenCalled();
  });

  it('uses injected chat history on LLM-routed messages', async () => {
    const env = makeEnv();
    env.chatHistory = {
      getRecentMessages: vi.fn(async () => 'fixture history'),
    };

    await resolveOrchestrator(
      makeMessage({
        id: 'follow-1',
        cleanText: '@Dave same trade',
      }),
      env,
    );

    expect(resolveLLMPathMock).toHaveBeenCalledOnce();
    const ctx = resolveLLMPathMock.mock.calls[0][1];
    await expect(ctx.chatHistory.getRecentMessages('Dave', 5)).resolves.toBe('fixture history');
    expect(env.chatHistory.getRecentMessages).toHaveBeenCalledWith('Dave', 5);
  });

  it('hard-skips no-badge pending-order language with attribution', async () => {
    const result = await resolveOrchestrator(
      makeMessage({
        id: 'skip-2',
        cleanText: 'Offering TLRY $12.45. If I get a pop I want to have an offer working.',
        symbols: ['TLRY'],
      }),
      makeEnv(),
    );

    expect(result.outcome).toBe('SKIP');
    expect(result.parseResult?.ruleId).toBe('hard-skip.pending-order');
    expect(resolveLLMPathMock).not.toHaveBeenCalled();
  });

  it('routes explicit no-badge add-to-short-stock messages deterministically', async () => {
    const result = await resolveOrchestrator(
      makeMessage({
        id: 'add-short-1',
        cleanText: 'Added to AMD short - avg. is now $230.84 - 2,000 total shares',
        symbols: ['AMD'],
      }),
      makeEnv(),
    );

    expect(resolveAddPathMock).toHaveBeenCalledOnce();
    expect(resolveLLMPathMock).not.toHaveBeenCalled();
    expect(result.parseResult?.ruleId).toBe('simple-exec.added-to-short-stock-shares');
  });

  it('bypasses LLM repair loops for non-canonical exits with one matching position', async () => {
    const env = makeEnv();
    const position = {
      id: 'pos-wmt',
      symbol: 'WMT',
      strategy: 'STOCK',
      direction: 'LONG',
      quantity: 100,
      openedAt: '2026-04-22T11:00:00.000Z',
      legs: [
        {
          symbol: 'WMT',
          type: 'STOCK',
          action: 'BUY',
          quantity: 100,
          expiry: '0000-00-00',
          strike: 0,
        },
      ],
    } satisfies TradePosition;
    env.getPositions = vi.fn(async () => [position]);

    const result = await resolveOrchestrator(
      makeMessage({
        id: 'exit-loop-1',
        cleanText: 'Exit Long WMT took profits on the rest',
        badges: ['Exit', 'Long'],
        symbols: ['WMT'],
      }),
      env,
    );

    expect(resolvePositionPathMock).toHaveBeenCalledOnce();
    expect(resolveLLMPathMock).not.toHaveBeenCalled();
    expect(result.parseResult?.ruleId).toBe('history-loop.single-position-exit');
  });
});
