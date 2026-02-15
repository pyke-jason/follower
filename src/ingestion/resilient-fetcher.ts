import { getPage, waitForAuth } from './browser.js';

const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 100;
const MAX_DELAY_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/**
 * Execute a fetch() inside the Playwright browser context, reusing auth cookies.
 * Retries transient errors with exponential backoff + jitter.
 * Auth errors trigger waitForAuth() and don't count against the retry limit.
 */
export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let attempt = 0;
  let delay = INITIAL_DELAY_MS;

  while (true) {
    signal?.throwIfAborted();

    const page = getPage();
    const result = await page.evaluate(async (fetchUrl: string) => {
      try {
        const resp = await fetch(fetchUrl, { redirect: 'manual' });
        const text = await resp.text();
        return {
          status: resp.status,
          isRedirect: resp.type === 'opaqueredirect' || resp.status === 302,
          isHtml: text.trim().startsWith('<') || text.trim().startsWith('<!'),
          body: text,
        };
      } catch (err) {
        return { status: 0, isRedirect: false, isHtml: false, body: String(err) };
      }
    }, url);

    // Auth error — wait for re-auth, then retry (doesn't count as an attempt)
    if (result.isRedirect || result.status === 401 || result.status === 403 || (result.isHtml && result.status === 200)) {
      console.log(`[Fetch] Auth error on ${url.substring(0, 80)}… — waiting for re-auth`);
      await waitForAuth();
      continue;
    }

    // Network error or 5xx — transient, retry with backoff
    if (result.status === 0 || result.status >= 500) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        throw new FetchError(`Max retries (${MAX_RETRIES}) exceeded: ${result.body.substring(0, 200)}`, result.status, false);
      }
      const jitter = Math.random() * delay * 0.5;
      const wait = Math.min(delay + jitter, MAX_DELAY_MS);
      console.log(`[Fetch] Transient error (status=${result.status}), retry ${attempt}/${MAX_RETRIES} in ${Math.round(wait)}ms`);
      await sleep(wait, signal);
      delay *= BACKOFF_MULTIPLIER;
      continue;
    }

    // 4xx (non-auth) — permanent error
    if (result.status >= 400) {
      throw new FetchError(`HTTP ${result.status}: ${result.body.substring(0, 200)}`, result.status, true);
    }

    // Success — parse JSON
    try {
      return JSON.parse(result.body) as T;
    } catch {
      throw new FetchError(`Invalid JSON response: ${result.body.substring(0, 200)}`, result.status, true);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
