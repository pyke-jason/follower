import { describe, it, expect, vi, afterEach } from 'vitest';
import { HaltTracker } from './halt-tracker.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('HaltTracker', () => {
  it('marks a symbol as halted', () => {
    const t = new HaltTracker();
    t.markHalted('TSLA');
    expect(t.isHalted('TSLA')).toBe(true);
  });

  it('is case-insensitive', () => {
    const t = new HaltTracker();
    t.markHalted('tsla');
    expect(t.isHalted('TSLA')).toBe(true);
    expect(t.isHalted('tsla')).toBe(true);
  });

  it('returns false for unknown symbol', () => {
    const t = new HaltTracker();
    expect(t.isHalted('AAPL')).toBe(false);
  });

  it('clearHalt removes the symbol', () => {
    const t = new HaltTracker();
    t.markHalted('TSLA');
    t.clearHalt('TSLA');
    expect(t.isHalted('TSLA')).toBe(false);
  });

  it('halt expires after durationMs', () => {
    vi.useFakeTimers();
    const t = new HaltTracker();
    t.markHalted('TSLA', 1000);
    vi.advanceTimersByTime(999);
    expect(t.isHalted('TSLA')).toBe(true);
    vi.advanceTimersByTime(2);
    expect(t.isHalted('TSLA')).toBe(false);
  });

  it('haltedSymbols returns active halts', () => {
    const t = new HaltTracker();
    t.markHalted('TSLA');
    t.markHalted('AAPL');
    const syms = t.haltedSymbols();
    expect(syms).toContain('TSLA');
    expect(syms).toContain('AAPL');
  });

  it('haltedSymbols prunes expired entries', () => {
    vi.useFakeTimers();
    const t = new HaltTracker();
    t.markHalted('TSLA', 500);
    t.markHalted('AAPL', 5000);
    vi.advanceTimersByTime(1000);
    const syms = t.haltedSymbols();
    expect(syms).not.toContain('TSLA');
    expect(syms).toContain('AAPL');
  });

  it('re-marking resets the expiry', () => {
    vi.useFakeTimers();
    const t = new HaltTracker();
    t.markHalted('TSLA', 500);
    vi.advanceTimersByTime(400);
    t.markHalted('TSLA', 1000); // extend
    vi.advanceTimersByTime(600);
    expect(t.isHalted('TSLA')).toBe(true); // still in new window
  });
});
