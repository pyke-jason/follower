import { describe, expect, test } from 'vitest';
import type { Signal } from '@/agent/schemas.js';
import type { Message, Trade } from '@/db/schema.js';
import type { OrchestratorResult, ResolvedSignal } from '@/intents/orchestrator/types.js';
import { evaluateClassificationGate } from './classification-gate.js';

function message(cleanText: string): Message {
  return {
    id: 'msg-1',
    author: 'Trader',
    timestamp: '2026-04-26T14:00:00.000Z',
    rawHtml: cleanText,
    cleanText,
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
}

const optionBuy: ResolvedSignal = {
  orderType: 'SINGLE',
  action: 'OPEN',
  limitPrice: 1.2,
  legs: [{
    type: 'option',
    symbol: 'AAPL',
    expiry: '2026-05-15',
    optionType: 'CALL',
    strike: 200,
    side: 'BUY',
    quantity: 1,
  }],
};

const stockBuy: ResolvedSignal = {
  orderType: 'STOCK',
  action: 'OPEN',
  limitPrice: 200,
  legs: [{ type: 'stock', symbol: 'AAPL', side: 'BUY', quantity: 1 }],
};

function classifier(overrides: Partial<Signal> = {}): Signal {
  return {
    action: 'OPEN',
    symbol: 'AAPL',
    direction: 'LONG',
    strategy: 'CALL',
    strikes: [200],
    expiry: '5/15',
    statedPrice: 1.2,
    quantity: null,
    ...overrides,
  };
}

function execute(signal: ResolvedSignal, rawSignal: Signal = classifier()): Extract<OrchestratorResult, { outcome: 'EXECUTE' }> {
  return {
    outcome: 'EXECUTE',
    signals: [signal],
    classifierSignals: [rawSignal],
  };
}

function openTrade(id: string): Trade {
  return {
    id,
    taskId: null,
    sourceMessageId: null,
    trader: 'Trader',
    symbol: 'AAPL',
    direction: 'LONG',
    strategy: 'CALL',
    legs: [],
    status: 'OPEN',
    entryPrice: null,
    exitPrice: null,
    quantity: 1,
    pnl: null,
    openedAt: null,
    closedAt: null,
    closeMessageId: null,
    channelId: 'ibkr:paper:test',
    metadata: {},
    avgEntryPrice: null,
    brokerFillPrice: null,
    brokerFillQty: null,
    brokerCommission: null,
    brokerFillTime: null,
    brokerLegFills: null,
    realizedPnl: null,
    plannedExitDate: null,
  };
}

function categories(result: ReturnType<typeof evaluateClassificationGate>) {
  return result.findings.map((finding) => finding.category);
}

describe('evaluateClassificationGate', () => {
  test('detects options text classified as stock', () => {
    const result = evaluateClassificationGate({
      message: message('AAPL 200 calls for 1.20'),
      resolved: execute(stockBuy, classifier({ strategy: 'STOCK' })),
      openPositions: [],
      mode: 'block',
    });

    expect(categories(result)).toContain('stock_options_mismatch');
    expect(result.decision).toBe('block');
  });

  test('detects sell-to-open language that resolves as a long option buy', () => {
    const result = evaluateClassificationGate({
      message: message('sold to open AAPL 200c for 1.20'),
      resolved: execute(optionBuy),
      openPositions: [],
      mode: 'block',
    });

    expect(categories(result)).toContain('sell_to_open_direction_mismatch');
  });

  test('detects P&L percentage used as trim size', () => {
    const trimSignal: ResolvedSignal = {
      ...optionBuy,
      action: 'TRIM',
      exitPercent: 0.25,
    };
    const result = evaluateClassificationGate({
      message: message('trim AAPL 25% profit'),
      resolved: execute(trimSignal, classifier({ action: 'TRIM', exitPercent: 0.25 })),
      openPositions: [openTrade('trade-1')],
      mode: 'block',
    });

    expect(categories(result)).toContain('pnl_percent_as_trim_size');
  });

  test('detects hallucinated strikes', () => {
    const result = evaluateClassificationGate({
      message: message('AAPL calls for 1.20'),
      resolved: execute(optionBuy),
      openPositions: [],
      mode: 'block',
    });

    expect(categories(result)).toContain('hallucinated_strike');
  });

  test('detects missing stated price when price marker is clear', () => {
    const result = evaluateClassificationGate({
      message: message('AAPL 200c at $1.20'),
      resolved: execute({ ...optionBuy, limitPrice: undefined }, classifier({ statedPrice: null })),
      openPositions: [],
      mode: 'block',
    });

    expect(categories(result)).toContain('missing_stated_price');
  });

  test('detects ambiguous exit target with multiple open positions', () => {
    const closeSignal: ResolvedSignal = {
      ...optionBuy,
      action: 'CLOSE',
      tradeId: 'trade-1',
    };
    const result = evaluateClassificationGate({
      message: message('all out now'),
      resolved: execute(closeSignal, classifier({ action: 'CLOSE', strikes: null })),
      openPositions: [openTrade('trade-1'), openTrade('trade-2')],
      mode: 'block',
    });

    expect(categories(result)).toContain('ambiguous_exit_target');
  });

  test('detects unsupported single-leg short option opens', () => {
    const shortOption: ResolvedSignal = {
      ...optionBuy,
      legs: [{ ...optionBuy.legs[0], side: 'SELL' }],
    };
    const result = evaluateClassificationGate({
      message: message('selling AAPL 200c for 1.20'),
      resolved: execute(shortOption, classifier({ direction: 'SHORT' })),
      openPositions: [],
      mode: 'block',
    });

    expect(categories(result)).toContain('unsupported_short_option_risk');
  });

  test('shadow mode records critical findings without blocking', () => {
    const result = evaluateClassificationGate({
      message: message('AAPL 200 calls for 1.20'),
      resolved: execute(stockBuy, classifier({ strategy: 'STOCK' })),
      openPositions: [],
      mode: 'shadow',
    });

    expect(result.findings.some((finding) => finding.severity === 'critical')).toBe(true);
    expect(result.decision).toBe('allow');
  });
});
