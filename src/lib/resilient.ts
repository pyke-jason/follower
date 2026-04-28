import { createLogger } from './logger.js';

const log = createLogger('Retry');

export type ErrorCategory = 'auth' | 'transient' | 'permanent';

type RetryConfig = {
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  multiplier: number;
  timeoutMs: number;
  classify?: (err: unknown) => ErrorCategory;
};

export const READ_DEFAULTS: RetryConfig = {
  maxRetries: 5,
  initialBackoffMs: 200,
  maxBackoffMs: 15_000,
  multiplier: 2,
  timeoutMs: 10_000,
};

export const WRITE_DEFAULTS: RetryConfig = {
  maxRetries: 2,
  initialBackoffMs: 500,
  maxBackoffMs: 10_000,
  multiplier: 2,
  timeoutMs: 15_000,
};

export const LLM_DEFAULTS: RetryConfig = {
  maxRetries: 3,
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  multiplier: 2,
  timeoutMs: 60_000,
};

/** Classify an error based on HTTP status codes and network error patterns. */
export function classifyError(err: unknown): ErrorCategory {
  const msg = err instanceof Error ? err.message : String(err);

  // Extract HTTP status code
  const statusMatch = msg.match(/\b([1-5]\d{2})\b/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    if (status === 401 || status === 403) return 'auth';
    if (status === 429 || (status >= 500 && status <= 599)) return 'transient';
    if (status === 400 || status === 404 || status === 422) return 'permanent';
  }

  // Auth patterns
  if (/token refresh failed/i.test(msg)) return 'auth';

  // Network error patterns → transient
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up|aborted/i.test(msg)) {
    return 'transient';
  }

  // Unknown → transient (safe default)
  return 'transient';
}

/** OpenAI-compatible SDK error classifier: reads .status directly from error objects. */
export function oaiClassify(err: unknown): ErrorCategory {
  if (err != null && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: number }).status;
    if (typeof status === 'number') {
      if (status === 401 || status === 403) return 'auth';
      if (status === 429 || (status >= 500 && status <= 599)) return 'transient';
      if (status === 400 || status === 404 || status === 422) return 'permanent';
    }
  }
  return classifyError(err);
}

/**
 * Read a `Retry-After` header value from an error object. Provider SDKs surface
 * the raw response headers as `err.headers`. We support the seconds-form only —
 * HTTP-date form is rare for 429s and adds parser surface area; treat it as
 * unparseable and fall back to exponential backoff. Negative / NaN / missing
 * values return 0 so the caller can `Math.max(...)` against it without branch.
 */
function parseRetryAfterMs(err: unknown): number {
  if (err == null || typeof err !== 'object') return 0;
  const headers = (err as { headers?: unknown }).headers;
  if (headers == null || typeof headers !== 'object') return 0;
  const raw = (headers as Record<string, unknown>)['retry-after'];
  if (typeof raw !== 'string') return 0;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 0;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.floor(seconds * 1000);
}

export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  config: Partial<RetryConfig>,
  label: string,
): Promise<T> {
  const cfg: RetryConfig = { ...READ_DEFAULTS, ...config };
  const classify = cfg.classify ?? classifyError;
  let attempt = 0;
  let authRetries = 0;
  const MAX_AUTH_RETRIES = 2;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
      const result = await fn(controller.signal);
      return result;
    } catch (err) {
      const category = classify(err);

      if (category === 'permanent') {
        throw err;
      }

      if (category === 'auth') {
        authRetries++;
        if (authRetries > MAX_AUTH_RETRIES) throw err;
        log.warn(`${label}: Auth error (attempt ${authRetries}/${MAX_AUTH_RETRIES}), retrying in 2s`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // transient
      if (attempt >= cfg.maxRetries) {
        throw err;
      }

      const baseDelay = Math.min(cfg.initialBackoffMs * cfg.multiplier ** attempt, cfg.maxBackoffMs);
      const jitter = Math.random() * baseDelay * 0.2;
      const exponentialDelay = baseDelay + jitter;
      const retryAfterMs = parseRetryAfterMs(err);
      const delay = Math.max(retryAfterMs, exponentialDelay);

      const retryAfterNote = retryAfterMs > 0 ? ` (Retry-After=${retryAfterMs}ms)` : '';
      log.warn(`${label}: Transient error (attempt ${attempt + 1}/${cfg.maxRetries}), retrying in ${Math.round(delay)}ms${retryAfterNote}: ${err instanceof Error ? err.message : String(err)}`);
      await new Promise(r => setTimeout(r, delay));
      attempt++;
    } finally {
      clearTimeout(timer);
    }
  }
}
