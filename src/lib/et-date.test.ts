import { describe, expect, test } from 'vitest';
import { isMarketHoursWithBuffer, nextMarketOpenWithBufferUTC } from './et-date.js';

describe('isMarketHoursWithBuffer', () => {
  test('allows the one hour buffer around regular market hours', () => {
    expect(isMarketHoursWithBuffer(new Date('2026-01-06T08:29:00-05:00'))).toBe(false);
    expect(isMarketHoursWithBuffer(new Date('2026-01-06T08:30:00-05:00'))).toBe(true);
    expect(isMarketHoursWithBuffer(new Date('2026-01-06T09:30:00-05:00'))).toBe(true);
    expect(isMarketHoursWithBuffer(new Date('2026-01-06T17:00:00-05:00'))).toBe(true);
    expect(isMarketHoursWithBuffer(new Date('2026-01-06T17:01:00-05:00'))).toBe(false);
  });

  test('uses early close days for the closing buffer', () => {
    expect(isMarketHoursWithBuffer(new Date('2026-07-02T14:00:00-04:00'))).toBe(true);
    expect(isMarketHoursWithBuffer(new Date('2026-07-02T14:01:00-04:00'))).toBe(false);
  });

  test('blocks weekends and holidays even during the buffered window', () => {
    expect(isMarketHoursWithBuffer(new Date('2026-01-10T10:00:00-05:00'))).toBe(false);
    expect(isMarketHoursWithBuffer(new Date('2026-07-03T10:00:00-04:00'))).toBe(false);
  });

  test('finds the next buffered market open for queued pages', () => {
    expect(nextMarketOpenWithBufferUTC(new Date('2026-01-06T17:01:00-05:00'))?.toISOString())
      .toBe('2026-01-07T13:30:00.000Z');
    expect(nextMarketOpenWithBufferUTC(new Date('2026-01-06T07:30:00-05:00'))?.toISOString())
      .toBe('2026-01-06T13:30:00.000Z');
  });
});
