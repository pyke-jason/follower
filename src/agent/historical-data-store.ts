import type { QuoteTick } from '../backtest/databento-tape.js';

export type HistoricalQuote = {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  timestamp: Date;
};

export type HistoricalBar = {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: Date;
};

/**
 * Lightweight lookup over pre-loaded Databento ticks.
 * Indexed by symbol for fast nearest-tick queries.
 */
export class HistoricalDataStore {
  /** symbol → ticks sorted by time ascending */
  private index = new Map<string, QuoteTick[]>();

  constructor(ticks: QuoteTick[]) {
    for (const tick of ticks) {
      let bucket = this.index.get(tick.symbol);
      if (!bucket) {
        bucket = [];
        this.index.set(tick.symbol, bucket);
      }
      bucket.push(tick);
    }
    // Ensure each bucket is sorted
    for (const bucket of this.index.values()) {
      bucket.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    }
  }

  /** Get the nearest quote at or before the given time. */
  getQuote(symbol: string, at: Date): HistoricalQuote | null {
    const ticks = this.index.get(symbol);
    if (!ticks || ticks.length === 0) return null;

    const targetMs = at.getTime();
    // Binary search for last tick <= targetMs
    let lo = 0, hi = ticks.length - 1;
    let best = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (ticks[mid].timestamp.getTime() <= targetMs) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (best === -1) return null;

    const tick = ticks[best];
    return {
      symbol: tick.symbol,
      bid: tick.bid,
      ask: tick.ask,
      mid: (tick.bid + tick.ask) / 2,
      timestamp: tick.timestamp,
    };
  }

  /**
   * Aggregate ticks into minute bars leading up to the given time.
   * Returns `count` bars ending at `at`.
   */
  getBars(symbol: string, count: number, at: Date): HistoricalBar[] {
    const ticks = this.index.get(symbol);
    if (!ticks || ticks.length === 0) return [];

    const targetMs = at.getTime();
    const barDurationMs = 60_000; // 1-minute bars
    const bars: HistoricalBar[] = [];

    for (let i = count - 1; i >= 0; i--) {
      const barEnd = targetMs - i * barDurationMs;
      const barStart = barEnd - barDurationMs;

      // Find ticks in [barStart, barEnd)
      const barTicks: QuoteTick[] = [];
      for (const tick of ticks) {
        const ts = tick.timestamp.getTime();
        if (ts >= barStart && ts < barEnd) barTicks.push(tick);
        if (ts >= barEnd) break;
      }

      if (barTicks.length === 0) continue;

      const mids = barTicks.map((t) => (t.bid + t.ask) / 2);
      bars.push({
        open: mids[0],
        high: Math.max(...mids),
        low: Math.min(...mids),
        close: mids[mids.length - 1],
        timestamp: new Date(barStart),
      });
    }

    return bars;
  }

  /** Check if we have any data for a symbol. */
  hasSymbol(symbol: string): boolean {
    return (this.index.get(symbol)?.length ?? 0) > 0;
  }

  /** Get all symbols with data. */
  get symbols(): string[] {
    return Array.from(this.index.keys());
  }
}
