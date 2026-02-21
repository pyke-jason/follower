/**
 * Token-bucket rate limiter.
 *
 * Starts at full capacity, refills at a steady rate.
 * Call acquire() before each rate-limited operation — resolves
 * immediately if capacity is available, otherwise waits.
 */
export class RateLimiter {
  private tokens: number;
  private readonly max: number;
  private readonly refillPerMs: number;
  private lastRefill: number;

  constructor(perMinute: number) {
    this.max = perMinute;
    this.tokens = perMinute;
    this.refillPerMs = perMinute / 60_000;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
    await new Promise((r) => setTimeout(r, waitMs));
    return this.acquire();
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.max,
      this.tokens + (now - this.lastRefill) * this.refillPerMs,
    );
    this.lastRefill = now;
  }
}
