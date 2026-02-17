import type { Message, MessageIntent } from '../db/schema.js';
import type { LLMProvider } from '../agent/providers.js';
import { extractIntent, getCachedIntent, INTENT_VERSION } from './extract-intent.js';
import type { IntentExtractionDeps, IntentResult } from './extract-intent.js';
import { createLogger } from '../lib/logger.js';

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
 * Extract intents for a batch of messages with concurrency control.
 * Messages with existing cached intents are resolved instantly.
 * New extractions run in parallel up to `concurrency`.
 *
 * @param onProgress - Optional callback fired after each message completes
 */
export async function extractBatchIntents(
  messages: Message[],
  model: string,
  provider: LLMProvider,
  deps: IntentExtractionDeps,
  opts?: {
    concurrency?: number;
    version?: number;
    onProgress?: (progress: BatchProgress) => void;
    /** If provided, check this signal before each extraction. */
    signal?: AbortSignal;
  },
): Promise<BatchResult> {
  const concurrency = opts?.concurrency ?? 5;
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

  log.info(`Extracting intents for ${messages.length} messages (concurrency=${concurrency}, model=${model}, v${version})`);

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

  // Process with bounded concurrency
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < needsExtraction.length) {
      if (signal?.aborted) return;

      const idx = cursor++;
      const msg = needsExtraction[idx];

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

  // Launch workers
  const workers = Array.from({ length: Math.min(concurrency, needsExtraction.length) }, () => worker());
  await Promise.all(workers);

  log.info(`Batch extraction complete: ${progress.processed}/${progress.total} (cached=${progress.cached} fresh=${progress.fresh} errors=${progress.errors})`);

  return { intents, progress };
}
