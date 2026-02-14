/**
 * SimClock: A mutable clock for simulated time.
 * The backtest runner advances it to each message's timestamp.
 */
export class SimClock {
  private _now: Date;

  constructor(start: Date = new Date()) {
    this._now = new Date(start);
  }

  now(): Date {
    return new Date(this._now);
  }

  advance(to: Date): void {
    if (to > this._now) {
      this._now = new Date(to);
    }
  }

  toISOString(): string {
    return this._now.toISOString();
  }
}
