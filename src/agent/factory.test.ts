import { afterEach, describe, expect, it, vi } from 'vitest';

const originalProvider = process.env.TRADE_MODEL_PROVIDER;
const originalModel = process.env.TRADE_MODEL;

afterEach(() => {
  if (originalProvider == null) {
    delete process.env.TRADE_MODEL_PROVIDER;
  } else {
    process.env.TRADE_MODEL_PROVIDER = originalProvider;
  }

  if (originalModel == null) {
    delete process.env.TRADE_MODEL;
  } else {
    process.env.TRADE_MODEL = originalModel;
  }

  vi.resetModules();
});

describe('getDefaultTradeModel', () => {
  it('defaults listener and backtest agents to Claude Sonnet 4.6', async () => {
    delete process.env.TRADE_MODEL_PROVIDER;
    delete process.env.TRADE_MODEL;

    const { getDefaultTradeModel } = await import('./factory.js');

    expect(getDefaultTradeModel()).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
  });

  it('allows environment overrides', async () => {
    process.env.TRADE_MODEL_PROVIDER = 'xai';
    process.env.TRADE_MODEL = 'grok-test';

    const { getDefaultTradeModel } = await import('./factory.js');

    expect(getDefaultTradeModel()).toEqual({
      provider: 'xai',
      model: 'grok-test',
    });
  });
});
