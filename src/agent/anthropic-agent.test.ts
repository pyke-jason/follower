/**
 * Tests for AnthropicAgent retry behavior.
 *
 * Covers the LLM-retry policy added in B-real:
 *  - 429 retried as transient
 *  - Retry-After header honored (delay >= retryAfter * 1000)
 *  - 401 capped at 2 auth retries
 *  - 400 fails fast as permanent
 *  - 429 repeated → exhausts maxRetries=3
 *  - Network errors retried as transient
 *
 * The Anthropic SDK is mocked: `query()` returns an async iterator that throws
 * a configured error on the first attempt(s) and yields a `result` message on
 * the success attempt.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock the SDK before importing the module under test ──────────────

const { queryMock, toolMock, createSdkMcpServerMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  toolMock: vi.fn((name: string, _desc: string, _shape: unknown, _handler: unknown) => ({ name })),
  createSdkMcpServerMock: vi.fn(() => ({ name: 'mock-server' })),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
  tool: toolMock,
  createSdkMcpServer: createSdkMcpServerMock,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: { type: 'preset', preset: 'claude_code' },
}));

// ── Helpers ──────────────────────────────────────────────────────────

type SdkError = Error & { status?: number; headers?: Record<string, string> };

function makeError(status: number | null, message: string, headers?: Record<string, string>): SdkError {
  const err: SdkError = Object.assign(new Error(message), {});
  if (status != null) err.status = status;
  if (headers != null) err.headers = headers;
  return err;
}

/**
 * Build an async iterator that yields a single `result` message — the success
 * payload that AnthropicAgent.run consumes for usage/cost. No tool calls; no
 * assistant blocks. Sufficient for the retry-flow assertions in this file.
 */
function makeSuccessIterator(): AsyncIterable<unknown> {
  const messages = [
    {
      type: 'result',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  ];
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: () => {
          if (i < messages.length) {
            return Promise.resolve({ value: messages[i++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

/**
 * Build an iterator that throws `err` on first iteration (mimics the SDK
 * surfacing a 429/401/etc. as the first emitted yield). The for-await consumer
 * inside AnthropicAgent.run will see this as a thrown error.
 */
function makeThrowingIterator(err: unknown): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.reject(err),
      };
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('AnthropicAgent retry behavior', () => {
  beforeEach(() => {
    queryMock.mockReset();
    toolMock.mockClear();
    createSdkMcpServerMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('retries once on 429 and succeeds on the second attempt', async () => {
    vi.useFakeTimers();
    const { AnthropicAgent } = await import('./anthropic-agent.js');
    queryMock
      .mockReturnValueOnce(makeThrowingIterator(makeError(429, 'rate limited')))
      .mockReturnValueOnce(makeSuccessIterator());

    const agent = new AnthropicAgent({ provider: 'anthropic', model: 'test-model' });
    const promise = agent.run({ systemPrompt: 'sys', userPrompt: 'user', tools: [] });

    // Advance past the first backoff (LLM_DEFAULTS initial 1s + 20% jitter).
    await vi.advanceTimersByTimeAsync(2_000);
    const out = await promise;

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(out.usage.inputTokens).toBe(10);
  });

  test('honors Retry-After header (delay >= retry-after seconds)', async () => {
    vi.useFakeTimers();
    const { AnthropicAgent } = await import('./anthropic-agent.js');
    queryMock
      .mockReturnValueOnce(makeThrowingIterator(makeError(429, 'rate limited', { 'retry-after': '2' })))
      .mockReturnValueOnce(makeSuccessIterator());

    const agent = new AnthropicAgent({ provider: 'anthropic', model: 'test-model' });
    const promise = agent.run({ systemPrompt: 'sys', userPrompt: 'user', tools: [] });

    // Drain the rejection microtask queue so the retry's setTimeout is armed.
    await vi.advanceTimersByTimeAsync(0);
    expect(queryMock).toHaveBeenCalledTimes(1);

    // 1.9s elapsed: not yet retried (Retry-After=2s is the floor).
    await vi.advanceTimersByTimeAsync(1_900);
    expect(queryMock).toHaveBeenCalledTimes(1);

    // After total 2.5s (covers Retry-After=2s) the retry fires.
    await vi.advanceTimersByTimeAsync(600);
    await promise;
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  test('401 retries up to 2 auth attempts then throws', async () => {
    vi.useFakeTimers();
    const { AnthropicAgent } = await import('./anthropic-agent.js');
    const err = makeError(401, 'unauthorized');
    queryMock.mockReturnValue(makeThrowingIterator(err));

    const agent = new AnthropicAgent({ provider: 'anthropic', model: 'test-model' });
    const promise = agent.run({ systemPrompt: 'sys', userPrompt: 'user', tools: [] });
    // Catch immediately so an unhandled-rejection doesn't fail the test.
    const expectation = expect(promise).rejects.toBe(err);

    // Auth path: 2s wait between attempts. Advance past two waits so all
    // 3 attempts fire before we await the rejection.
    await vi.advanceTimersByTimeAsync(5_000);
    await expectation;

    // withRetry: initial attempt + 2 auth retries = 3 calls before giving up.
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  test('400 fails fast as permanent (no retry)', async () => {
    const { AnthropicAgent } = await import('./anthropic-agent.js');
    const err = makeError(400, 'bad request');
    queryMock.mockReturnValue(makeThrowingIterator(err));

    const agent = new AnthropicAgent({ provider: 'anthropic', model: 'test-model' });
    await expect(
      agent.run({ systemPrompt: 'sys', userPrompt: 'user', tools: [] }),
    ).rejects.toBe(err);

    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  test('repeated 429 exhausts maxRetries=3 then throws', async () => {
    vi.useFakeTimers();
    const { AnthropicAgent } = await import('./anthropic-agent.js');
    const err = makeError(429, 'rate limited');
    queryMock.mockReturnValue(makeThrowingIterator(err));

    const agent = new AnthropicAgent({ provider: 'anthropic', model: 'test-model' });
    const promise = agent.run({ systemPrompt: 'sys', userPrompt: 'user', tools: [] });
    const expectation = expect(promise).rejects.toBe(err);

    // Backoffs: 1s + 2s + 4s with up to 20% jitter. 10s covers worst case.
    await vi.advanceTimersByTimeAsync(10_000);
    await expectation;

    // initial + 3 retries = 4 calls.
    expect(queryMock).toHaveBeenCalledTimes(4);
  });

  test('network error (no .status) retried as transient', async () => {
    vi.useFakeTimers();
    const { AnthropicAgent } = await import('./anthropic-agent.js');
    const netErr = new Error('ECONNRESET');
    queryMock
      .mockReturnValueOnce(makeThrowingIterator(netErr))
      .mockReturnValueOnce(makeSuccessIterator());

    const agent = new AnthropicAgent({ provider: 'anthropic', model: 'test-model' });
    const promise = agent.run({ systemPrompt: 'sys', userPrompt: 'user', tools: [] });
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;

    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});
