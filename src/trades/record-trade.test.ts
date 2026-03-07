import { describe, it, expect } from 'vitest';

// Extract sumChase for testing — mirrors the implementation in record-trade.ts
const sumChase = (a?: number, b?: number): number | undefined => {
  const sum = (a ?? 0) + (b ?? 0);
  return sum > 0 ? sum : undefined;
};

describe('sumChase', () => {
  it('sums open + close chase steps', () => {
    expect(sumChase(10, 1)).toBe(11);
  });

  it('returns open-only when close has none', () => {
    expect(sumChase(4, undefined)).toBe(4);
    expect(sumChase(4, 0)).toBe(4);
  });

  it('returns close-only when open had none', () => {
    expect(sumChase(undefined, 3)).toBe(3);
    expect(sumChase(0, 3)).toBe(3);
  });

  it('returns undefined when both are zero/absent', () => {
    expect(sumChase(undefined, undefined)).toBeUndefined();
    expect(sumChase(0, 0)).toBeUndefined();
    expect(sumChase(undefined, 0)).toBeUndefined();
  });

  // Real backtest cases from bt:minimum-hippopotamus
  it('WBD: OPEN=1 + TRIM=9 → 10 (was 1)', () => {
    expect(sumChase(1, 9)).toBe(10);
  });

  it('TSLA d5bff: OPEN=11 + CLOSE=1 → 12 (was 1)', () => {
    expect(sumChase(11, 1)).toBe(12);
  });

  it('VST: OPEN=10 + CLOSE=21 → 31 (was 21)', () => {
    expect(sumChase(10, 21)).toBe(31);
  });

  it('IREN: OPEN=12 + CLOSE=3 → 15 (was 3)', () => {
    expect(sumChase(12, 3)).toBe(15);
  });

  it('NVDA 3cda8: OPEN=9 + CLOSE=3 → 12 (was 3)', () => {
    expect(sumChase(9, 3)).toBe(12);
  });
});
