import type { Agent, AgentResult, AgentRunOptions } from '../agent/result.js';
import { DependencyUnavailableError } from '../lib/errors.js';
import { classifyError, LLM_DEFAULTS } from '../lib/resilient.js';
import { createLogger } from '../lib/logger.js';
import type { BacktestPauseControl } from './pause-control.js';

const log = createLogger('BacktestAgent');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutError(label: string, timeoutMs: number): Error {
  const err = new Error(`${label} ETIMEDOUT after ${timeoutMs}ms`);
  err.name = 'TimeoutError';
  return err;
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class BacktestAgent implements Agent {
  readonly identity;

  constructor(
    private readonly inner: Agent,
    private readonly pauseControl: BacktestPauseControl,
  ) {
    this.identity = inner.identity;
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    const label = `LLM ${this.identity.provider}/${this.identity.model}`;
    let transientAttempts = 0;

    while (true) {
      await this.pauseControl.waitIfPaused();

      try {
        return await withTimeout(this.inner.run(opts), label, LLM_DEFAULTS.timeoutMs);
      } catch (err) {
        const category = classifyError(err);
        if (category !== 'transient') {
          throw err;
        }

        if (transientAttempts < LLM_DEFAULTS.maxRetries) {
          const baseDelay = Math.min(
            LLM_DEFAULTS.initialBackoffMs * LLM_DEFAULTS.multiplier ** transientAttempts,
            LLM_DEFAULTS.maxBackoffMs,
          );
          const jitter = Math.random() * baseDelay * 0.2;
          const delay = baseDelay + jitter;
          transientAttempts++;
          log.warn(
            `${label}: transient error (${transientAttempts}/${LLM_DEFAULTS.maxRetries}), retrying in ${Math.round(delay)}ms: ${err instanceof Error ? err.message : String(err)}`
          );
          await sleep(delay);
          continue;
        }

        transientAttempts = 0;
        await this.pauseControl.pauseForDependency(
          new DependencyUnavailableError(
            'llm',
            `${label} unavailable after ${LLM_DEFAULTS.maxRetries} retries: ${err instanceof Error ? err.message : String(err)}`,
            err,
          ),
        );
      }
    }
  }
}
