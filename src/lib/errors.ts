/**
 * Shared typed errors.
 *
 * Typed errors let callers use `instanceof` for safe handling without
 * coupling to error message strings.
 */

/**
 * Thrown when a quote fetch fails with a permanent symbol-not-found error (HTTP 422).
 * Caught by executeResolvedSignals to trigger an optional LLM correction retry.
 */
export class QuoteResolutionError extends Error {
  constructor(public readonly originalMessage: string) {
    super(originalMessage);
    this.name = 'QuoteResolutionError';
  }
}
