import { describe, it, expect, vi, afterEach } from 'vitest';
import { MarketGuard } from './market-guard.js';
import { HaltTracker } from './halt-tracker.js';

afterEach(() => {
  vi.useRealTimers();
});

function makeGuard(isoUtc: string) {
  const now = new Date(isoUtc);
  return new MarketGuard(new HaltTracker(), () => now);
}

function makeGuardWithHalt(isoUtc: string, haltedSymbol: string) {
  const tracker = new HaltTracker();
  tracker.markHalted(haltedSymbol);
  return new MarketGuard(tracker, () => new Date(isoUtc));
}

// ── Holiday / weekend ────────────────────────────────────────────────

describe('holiday and weekend blocking', () => {
  it('blocks OPEN on NYSE holiday (Christmas 2025)', () => {
    // 2025-12-25 10:00 AM ET (EST = UTC-5 → 15:00 UTC)
    const guard = makeGuard('2025-12-25T15:00:00Z');
    const result = guard.checkSignal('TSLA', false);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/holiday/i);
  });

  it('allows CLOSE on NYSE holiday (position-reducing bypasses session)', () => {
    const guard = makeGuard('2025-12-25T15:00:00Z');
    expect(guard.checkSignal('TSLA', true).allowed).toBe(true);
  });

  it('blocks OPEN on Saturday', () => {
    // 2026-03-07 is a Saturday, 10:00 AM ET
    const guard = makeGuard('2026-03-07T15:00:00Z');
    expect(guard.checkSignal('SPY', false).allowed).toBe(false);
  });

  it('blocks OPEN on Sunday', () => {
    // 2026-03-08 is a Sunday
    const guard = makeGuard('2026-03-08T15:00:00Z');
    expect(guard.checkSignal('SPY', false).allowed).toBe(false);
  });

  it('allows OPEN on regular trading day at 10 AM ET', () => {
    // 2026-02-23 Monday 10:00 AM ET (EST → UTC+5 = 15:00 UTC)
    const guard = makeGuard('2026-02-23T15:00:00Z');
    expect(guard.checkSignal('TSLA', false).allowed).toBe(true);
  });
});

// ── Early close day ──────────────────────────────────────────────────

describe('early close (1 PM ET)', () => {
  // 2025-11-28 is an early close day (day after Thanksgiving)
  // 1:01 PM ET = 18:01 UTC (EST)

  it('allows OPEN at 12:59 PM ET on early-close day', () => {
    const guard = makeGuard('2025-11-28T17:59:00Z');
    expect(guard.checkSignal('AAPL', false).allowed).toBe(true);
  });

  it('blocks OPEN at 1:01 PM ET on early-close day', () => {
    const guard = makeGuard('2025-11-28T18:01:00Z');
    const result = guard.checkSignal('AAPL', false);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/post-market|RTH/i);
  });

  it('allows CLOSE at 1:01 PM ET on early-close day (position-reducing)', () => {
    const guard = makeGuard('2025-11-28T18:01:00Z');
    expect(guard.checkSignal('AAPL', true).allowed).toBe(true);
  });
});

// ── Pre-market ───────────────────────────────────────────────────────

describe('pre-market (before 9:30 AM ET)', () => {
  // 2026-02-23 Monday 9:29 AM ET = 14:29 UTC (EST)

  it('blocks OPEN at 9:29 AM ET', () => {
    const guard = makeGuard('2026-02-23T14:29:00Z');
    const result = guard.checkSignal('TSLA', false);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/pre-market|RTH/i);
  });

  it('allows OPEN at exactly 9:30 AM ET', () => {
    const guard = makeGuard('2026-02-23T14:30:00Z');
    expect(guard.checkSignal('TSLA', false).allowed).toBe(true);
  });

  it('allows CLOSE at 9:29 AM ET (position-reducing)', () => {
    const guard = makeGuard('2026-02-23T14:29:00Z');
    expect(guard.checkSignal('TSLA', true).allowed).toBe(true);
  });
});

// ── Post-market ──────────────────────────────────────────────────────

describe('post-market (after 4 PM ET)', () => {
  // 2026-02-23 Monday 4:01 PM ET = 21:01 UTC (EST)

  it('blocks OPEN at 4:01 PM ET', () => {
    const guard = makeGuard('2026-02-23T21:01:00Z');
    const result = guard.checkSignal('TSLA', false);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/post-market|RTH/i);
  });

  it('allows OPEN at exactly 4:00 PM ET (close boundary is inclusive)', () => {
    const guard = makeGuard('2026-02-23T21:00:00Z');
    expect(guard.checkSignal('TSLA', false).allowed).toBe(true);
  });

  it('allows CLOSE after hours (position-reducing)', () => {
    const guard = makeGuard('2026-02-23T21:01:00Z');
    expect(guard.checkSignal('TSLA', true).allowed).toBe(true);
  });
});

// ── 2027 holiday coverage ────────────────────────────────────────────

describe('2027 holiday calendar', () => {
  it('blocks OPEN on New Year\'s Day 2027 (2027-01-01, Friday)', () => {
    const guard = makeGuard('2027-01-01T15:00:00Z');
    expect(guard.checkSignal('SPY', false).allowed).toBe(false);
  });

  it('blocks OPEN on Good Friday 2027 (2027-03-26)', () => {
    // 2027-03-26 10:00 AM ET (EDT starts Mar 14 → UTC-4 → 14:00 UTC)
    const guard = makeGuard('2027-03-26T14:00:00Z');
    expect(guard.checkSignal('SPY', false).allowed).toBe(false);
  });

  it('allows OPEN on the day after New Year 2027 (2027-01-04, Monday)', () => {
    const guard = makeGuard('2027-01-04T15:00:00Z');
    expect(guard.checkSignal('SPY', false).allowed).toBe(true);
  });
});

// ── Trading halt ─────────────────────────────────────────────────────

describe('trading halt', () => {
  it('blocks OPEN on halted symbol during RTH', () => {
    const guard = makeGuardWithHalt('2026-02-23T15:00:00Z', 'TSLA');
    const result = guard.checkSignal('TSLA', false);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/halt/i);
  });

  it('blocks CLOSE on halted symbol (halted = not tradeable at all)', () => {
    const guard = makeGuardWithHalt('2026-02-23T15:00:00Z', 'TSLA');
    const result = guard.checkSignal('TSLA', true);
    expect(result.allowed).toBe(false);
  });

  it('does not block a different symbol', () => {
    const guard = makeGuardWithHalt('2026-02-23T15:00:00Z', 'TSLA');
    expect(guard.checkSignal('AAPL', false).allowed).toBe(true);
  });

  it('allows trading after halt expires', () => {
    vi.useFakeTimers();
    const tracker = new HaltTracker();
    tracker.markHalted('TSLA', 100);
    vi.advanceTimersByTime(200);
    const guard = new MarketGuard(tracker, () => new Date('2026-02-23T15:00:00Z'));
    expect(guard.checkSignal('TSLA', false).allowed).toBe(true);
  });

  it('markHalted persists through subsequent calls', () => {
    const tracker = new HaltTracker();
    const guard = new MarketGuard(tracker, () => new Date('2026-02-23T15:00:00Z'));
    guard.markHalted('TSLA');
    expect(guard.checkSignal('TSLA', false).allowed).toBe(false);
  });
});

// ── getSession ───────────────────────────────────────────────────────

describe('getSession', () => {
  it('returns regular during RTH', () => {
    expect(makeGuard('2026-02-23T15:00:00Z').getSession()).toBe('regular');
  });

  it('returns pre before 9:30 AM ET', () => {
    expect(makeGuard('2026-02-23T14:00:00Z').getSession()).toBe('pre');
  });

  it('returns post after 4 PM ET', () => {
    expect(makeGuard('2026-02-23T22:00:00Z').getSession()).toBe('post');
  });

  it('returns holiday on a market holiday', () => {
    expect(makeGuard('2026-12-25T15:00:00Z').getSession()).toBe('holiday');
  });
});
