import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Agent } from '../agent/result.js';
import { BacktestAgent } from './backtest-agent.js';

const RESULT = {
  model: { provider: 'xai' as const, model: 'grok-test' },
  steps: [],
  result: { accepted: true },
  usage: { inputTokens: 0, outputTokens: 0 },
};

describe('BacktestAgent', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  test('pauses after transient LLM failures and resumes the same call', async () => {
    vi.useFakeTimers();

    const inner = {
      identity: RESULT.model,
      run: vi.fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValue(RESULT),
    } satisfies Agent;

    const pauseControl = {
      waitIfPaused: vi.fn(async () => {}),
      pauseForDependency: vi.fn(async () => {}),
    };

    const agent = new BacktestAgent(inner, pauseControl);
    const runPromise = agent.run({
      systemPrompt: 'system',
      userPrompt: 'user',
      tools: [],
    });

    await vi.runAllTimersAsync();

    await expect(runPromise).resolves.toEqual(RESULT);
    expect(inner.run).toHaveBeenCalledTimes(5);
    expect(pauseControl.pauseForDependency).toHaveBeenCalledTimes(1);
    expect(pauseControl.waitIfPaused).toHaveBeenCalledTimes(5);
  });

  test('does not pause permanent LLM errors', async () => {
    const inner = {
      identity: RESULT.model,
      run: vi.fn(async () => {
        throw new Error('400 invalid request');
      }),
    } satisfies Agent;

    const pauseControl = {
      waitIfPaused: vi.fn(async () => {}),
      pauseForDependency: vi.fn(async () => {}),
    };

    const agent = new BacktestAgent(inner, pauseControl);

    await expect(agent.run({
      systemPrompt: 'system',
      userPrompt: 'user',
      tools: [],
    })).rejects.toThrow('400 invalid request');

    expect(pauseControl.pauseForDependency).not.toHaveBeenCalled();
  });
});
