import type { Message, MessageIntent } from '../db/schema.js';
import type { LLMProvider } from '../agent/providers.js';
import { extractIntent, getCachedIntent, INTENT_VERSION } from './extract-intent.js';
import type { IntentExtractionDeps, IntentResult } from './extract-intent.js';
import { createLogger } from '../lib/logger.js';
import { getModelRateLimits } from '../lib/llm-cost.js';
import { RateLimiter } from '../lib/rate-limiter.js';

const log = createLogger('IntentBatch');

export type BatchProgress = {
  total: number;
  processed: number;
  cached: number;
  fresh: number;
  errors: number;
};

export type BatchResult = {
  /** Map from messageId → cached intent row */
  intents: Map<string, MessageIntent>;
  progress: BatchProgress;
};

/**
 * Extract intents for a batch of messages, rate-limited by model RPM.
 * Messages with existing cached intents are resolved instantly.
 *
 * @param onProgress - Optional callback fired after each message completes
 */
export async function extractBatchIntents(
  messages: Message[],
  model: string,
  provider: LLMProvider,
  deps: IntentExtractionDeps,
  opts?: {
    version?: number;
    onProgress?: (progress: BatchProgress) => void;
    /** If provided, check this signal before each extraction. */
    signal?: AbortSignal;
  },
): Promise<BatchResult> {
  const version = opts?.version ?? INTENT_VERSION;
  const onProgress = opts?.onProgress;
  const signal = opts?.signal;

  const progress: BatchProgress = {
    total: messages.length,
    processed: 0,
    cached: 0,
    fresh: 0,
    errors: 0,
  };

  const intents = new Map<string, MessageIntent>();

  if (messages.length === 0) {
    return { intents, progress };
  }

  const { rpm } = getModelRateLimits(model);
  log.info(`Extracting intents for ${messages.length} messages (model=${model}, v${version}, ${rpm} RPM)`);

  // Separate cached from needing-extraction up front for fast path
  const needsExtraction: Message[] = [];
  for (const msg of messages) {
    const cached = await getCachedIntent(msg.id, model, version);
    if (cached) {
      intents.set(msg.id, cached);
      progress.processed++;
      progress.cached++;
    } else {
      needsExtraction.push(msg);
    }
  }

  if (progress.cached > 0) {
    log.info(`  ${progress.cached}/${messages.length} already cached`);
    onProgress?.(progress);
  }

  if (needsExtraction.length === 0) {
    log.info(`  All intents cached — nothing to extract`);
    return { intents, progress };
  }

  log.info(`  ${needsExtraction.length} messages need extraction`);

  const limiter = new RateLimiter(rpm);

  // Worker pool — only N tasks alive at once so completed ones get GC'd.
  // rpm/3 gives ~10x headroom over steady-state need (each extractIntent takes ~1-3s),
  // ensuring the rate limiter is never starved even with bursty latency.
  const concurrency = Math.min(Math.ceil(rpm / 3), needsExtraction.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < needsExtraction.length) {
      if (signal?.aborted) return;
      const msg = needsExtraction[cursor++];

      await limiter.acquire();
      if (signal?.aborted) return;

      try {
        const result = await extractIntent(msg, model, provider, deps, version);
        intents.set(msg.id, result.intent);
        if (result.cached) {
          progress.cached++;
        } else {
          progress.fresh++;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(`  Error extracting intent for ${msg.id}: ${errMsg}`);
        progress.errors++;
      }

      progress.processed++;

      if (progress.processed % 10 === 0 || progress.processed === progress.total) {
        log.info(`  Progress: ${progress.processed}/${progress.total} (cached=${progress.cached} fresh=${progress.fresh} errors=${progress.errors})`);
      }

      onProgress?.(progress);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  log.info(`Batch extraction complete: ${progress.processed}/${progress.total} (cached=${progress.cached} fresh=${progress.fresh} errors=${progress.errors})`);

  return { intents, progress };
}
