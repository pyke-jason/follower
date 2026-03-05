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
/**
 * Thrown by BrokerService implementations for transient infra failures
 * (network timeouts, connection refused, sidecar 503, etc.).
 * Callers use `instanceof BrokerTransientError` to decide retry vs permanent fail.
 */
export class BrokerTransientError extends Error {
  constructor(
    message: string,
    /** Original error for forensics. */
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BrokerTransientError';
  }
}

export class QuoteResolutionError extends Error {
  constructor(
    public readonly originalMessage: string,
    /** The OCC symbol that failed (e.g. "TSLA  250919C00002000"). */
    public readonly occSymbol?: string,
  ) {
    super(originalMessage);
    this.name = 'QuoteResolutionError';
  }
}
