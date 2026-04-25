/**
 * In-memory registry of trading halts.
 *
 * When IBKR rejects an order due to a trading halt (T1/T2/regulatory), the pipeline
 * marks the symbol here. Subsequent signals for that symbol are skipped until the
 * cooldown expires (default 15 min) or the operator clears it.
 */

const DEFAULT_HALT_DURATION_MS = 15 * 60 * 1000; // 15 min — typical T1 halt window

export class HaltTracker {
  private readonly halts = new Map<string, number>(); // symbol (upper) → expiry ms

  markHalted(symbol: string, durationMs = DEFAULT_HALT_DURATION_MS): void {
    this.halts.set(symbol.toUpperCase(), Date.now() + durationMs);
  }

  isHalted(symbol: string): boolean {
    const expiry = this.halts.get(symbol.toUpperCase());
    if (expiry == null) return false;
    if (Date.now() > expiry) {
      this.halts.delete(symbol.toUpperCase());
      return false;
    }
    return true;
  }

  clearHalt(symbol: string): void {
    this.halts.delete(symbol.toUpperCase());
  }

  /** Returns symbols currently within their halt window. Prunes expired entries. */
  haltedSymbols(): string[] {
    const now = Date.now();
    const result: string[] = [];
    for (const [sym, exp] of this.halts) {
      if (now <= exp) result.push(sym);
      else this.halts.delete(sym);
    }
    return result;
  }
}
