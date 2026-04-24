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

type DependencyKind = 'llm' | 'quotes';

/**
 * Transient outage talking to an external dependency.
 *
 * Backtests use this to pause in place until the operator resumes the run.
 */
export class DependencyUnavailableError extends Error {
  constructor(
    public readonly dependency: DependencyKind,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DependencyUnavailableError';
  }
}

/**
 * Thrown when a quote request succeeds but bid/ask data is missing.
 * The symbol is valid and the broker is reachable, but no market data
 * is available (pre-market, illiquid deep OTM, delayed data subscription).
 */
export class QuoteUnavailableError extends Error {
  constructor(
    public readonly symbol: string,
    public readonly detail?: string,
  ) {
    super(`No bid/ask available for ${symbol}${detail ? `: ${detail}` : ''}`);
    this.name = 'QuoteUnavailableError';
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
