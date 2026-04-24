/**
 * Tracks which OPEN signals were skipped during a backtest run.
 * Used to classify later exit signals as "unfollowed_exit" without
 * relying on position-path failure strings.
 *
 * Keyed by "author:symbol". Conservative: if a symbol is later
 * followed (OPEN executes), the shadow is removed — so exits for
 * that symbol go through normal flow even if an earlier open was skipped.
 */

const EXIT_ACTIONS = new Set(['CLOSE', 'TRIM', 'LEG_OFF']);

export class ShadowTracker {
  private shadows = new Set<string>();

  constructor(initialKeys: string[] = []) {
    this.shadows = new Set(initialKeys);
  }

  private key(author: string, symbol: string): string {
    return `${author}:${symbol}`;
  }

  /** Record that an OPEN for this author:symbol was skipped. */
  recordSkippedOpen(author: string, symbol: string): void {
    this.shadows.add(this.key(author, symbol));
  }

  /** A later OPEN for the same author:symbol was followed — remove shadow. */
  recordFollowedOpen(author: string, symbol: string): void {
    this.shadows.delete(this.key(author, symbol));
  }

  /** True if ALL opens for this author:symbol were skipped (none followed). */
  isUnfollowedSymbol(author: string, symbol: string): boolean {
    return this.shadows.has(this.key(author, symbol));
  }

  /** Check if a parsed action+symbol represents a doomed exit. */
  isUnfollowedExit(author: string, action: string | null, symbol: string | null): boolean {
    if (!action || !symbol) return false;
    return EXIT_ACTIONS.has(action) && this.isUnfollowedSymbol(author, symbol);
  }

  serialize(): string[] {
    return [...this.shadows].sort();
  }
}
