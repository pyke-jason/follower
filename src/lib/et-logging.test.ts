import { describe, it, expect } from 'vitest';
import {
  formatLogTimestampET,
  formatLogTimeET,
  getSessionLabel,
  formatLogTimeWithSession,
  formatRelativeTime,
  formatIsoAsETLog,
} from './et-logging.js';

describe('et-logging', () => {
  describe('formatLogTimestampET', () => {
    it('formats with zero-padded month, day, hour, minute, second, millisecond', () => {
      // 2026-02-23 14:35:42.123 ET (2026-02-23T19:35:42.123Z in UTC)
      const d = new Date('2026-02-23T19:35:42.123Z');
      expect(formatLogTimestampET(d)).toBe('02/23 14:35:42.123');
    });

    it('handles single-digit hour correctly', () => {
      // 2026-02-23 09:05:03.001 ET (2026-02-23T14:05:03.001Z in UTC)
      const d = new Date('2026-02-23T14:05:03.001Z');
      expect(formatLogTimestampET(d)).toBe('02/23 09:05:03.001');
    });

    it('handles midnight correctly', () => {
      // 2026-02-23 00:00:00.000 ET (2026-02-23T05:00:00.000Z in UTC)
      const d = new Date('2026-02-23T05:00:00.000Z');
      expect(formatLogTimestampET(d)).toBe('02/23 00:00:00.000');
    });

    it('handles 23:59:59.999', () => {
      // 2026-02-23 23:59:59.999 ET (2026-02-24T04:59:59.999Z in UTC)
      const d = new Date('2026-02-24T04:59:59.999Z');
      expect(formatLogTimestampET(d)).toBe('02/23 23:59:59.999');
    });
  });

  describe('formatLogTimeET', () => {
    // 2026-02-23 14:35:42 ET (2026-02-23T19:35:42Z in UTC)
    const d = new Date('2026-02-23T19:35:42Z');

    it('formats hh:mm:ss by default', () => {
      expect(formatLogTimeET(d)).toBe('14:35:42');
    });

    it('formats hhmm when requested', () => {
      expect(formatLogTimeET(d, 'hhmm')).toBe('14:35');
    });

    it('formats hh:mm:ss explicitly', () => {
      expect(formatLogTimeET(d, 'hh:mm:ss')).toBe('14:35:42');
    });

    it('formats 12-hour time', () => {
      expect(formatLogTimeET(d, '12h')).toBe('2:35 PM');
    });

    it('handles noon correctly (12h format)', () => {
      // 2026-02-23 12:00:00 ET (2026-02-23T17:00:00Z in UTC)
      const noon = new Date('2026-02-23T17:00:00Z');
      expect(formatLogTimeET(noon, '12h')).toBe('12:00 PM');
    });

    it('handles midnight correctly (12h format)', () => {
      // 2026-02-23 00:00:00 ET (2026-02-23T05:00:00Z in UTC)
      const midnight = new Date('2026-02-23T05:00:00Z');
      expect(formatLogTimeET(midnight, '12h')).toBe('12:00 AM');
    });
  });

  describe('getSessionLabel', () => {
    it('returns PRE before 9:30 AM ET', () => {
      // 2026-02-23 09:29:59 ET (2026-02-23T14:29:59Z in UTC)
      const d = new Date('2026-02-23T14:29:59Z');
      expect(getSessionLabel(d)).toBe('PRE');
    });

    it('returns RTH at 9:30 AM ET', () => {
      // 2026-02-23 09:30:00 ET (2026-02-23T14:30:00Z in UTC)
      const d = new Date('2026-02-23T14:30:00Z');
      expect(getSessionLabel(d)).toBe('RTH');
    });

    it('returns RTH during market hours', () => {
      // 2026-02-23 14:35:42 ET (2026-02-23T19:35:42Z in UTC)
      const d = new Date('2026-02-23T19:35:42Z');
      expect(getSessionLabel(d)).toBe('RTH');
    });

    it('returns AH after 4:00 PM ET (regular close)', () => {
      // 2026-02-23 16:01:00 ET (2026-02-23T21:01:00Z in UTC)
      const d = new Date('2026-02-23T21:01:00Z');
      expect(getSessionLabel(d)).toBe('AH');
    });

    it('returns RTH at market close (4:00 PM)', () => {
      // 2026-02-23 16:00:00 ET (2026-02-23T21:00:00Z in UTC)
      const d = new Date('2026-02-23T21:00:00Z');
      expect(getSessionLabel(d)).toBe('RTH');
    });

    it('returns RTH on early close day at 1:00 PM', () => {
      // 2026-07-02 is an early close day (day before July 4th)
      // 2026-07-02 13:00:00 ET (2026-07-02T17:00:00Z in UTC)
      const d = new Date('2026-07-02T17:00:00Z');
      expect(getSessionLabel(d)).toBe('RTH');
    });

    it('returns AH on early close day after 1:00 PM', () => {
      // 2026-07-02 is an early close day
      // 2026-07-02 13:01:00 ET (2026-07-02T17:01:00Z in UTC)
      const d = new Date('2026-07-02T17:01:00Z');
      expect(getSessionLabel(d)).toBe('AH');
    });
  });

  describe('formatLogTimeWithSession', () => {
    it('includes session label in timestamp', () => {
      // 2026-02-23 14:35:42 ET (2026-02-23T19:35:42Z in UTC)
      const d = new Date('2026-02-23T19:35:42Z');
      expect(formatLogTimeWithSession(d)).toBe('14:35:42 [RTH]');
    });

    it('shows PRE label for pre-market', () => {
      // 2026-02-23 09:15:00 ET (2026-02-23T14:15:00Z in UTC)
      const d = new Date('2026-02-23T14:15:00Z');
      expect(formatLogTimeWithSession(d)).toBe('09:15:00 [PRE]');
    });

    it('shows AH label for after hours', () => {
      // 2026-02-23 20:30:00 ET (2026-02-24T01:30:00Z in UTC)
      const d = new Date('2026-02-24T01:30:00Z');
      expect(formatLogTimeWithSession(d)).toBe('20:30:00 [AH]');
    });
  });

  describe('formatRelativeTime', () => {
    it('returns "now" for times less than 1 second apart', () => {
      const now = new Date('2026-02-23T19:35:42.500Z');
      const just_before = new Date('2026-02-23T19:35:42.100Z');
      expect(formatRelativeTime(just_before, now)).toBe('now');
    });

    it('formats seconds correctly', () => {
      const now = new Date('2026-02-23T19:35:42.000Z');
      const before = new Date('2026-02-23T19:35:08.000Z');
      expect(formatRelativeTime(before, now)).toBe('34s ago');
    });

    it('formats minutes and seconds', () => {
      const now = new Date('2026-02-23T19:35:42.000Z');
      const before = new Date('2026-02-23T19:32:14.000Z');
      expect(formatRelativeTime(before, now)).toBe('3m 28s ago');
    });

    it('formats minutes only when seconds round to 0', () => {
      const now = new Date('2026-02-23T19:35:00.000Z');
      const before = new Date('2026-02-23T19:32:00.000Z');
      expect(formatRelativeTime(before, now)).toBe('3m ago');
    });

    it('defaults to current time when relative not provided', () => {
      const past = new Date(Date.now() - 5000); // 5 seconds ago
      const result = formatRelativeTime(past);
      expect(result).toMatch(/^\d+s ago$/);
    });

    it('handles large time differences', () => {
      const now = new Date('2026-02-23T19:35:42.000Z');
      const before = new Date('2026-02-20T19:35:42.000Z');
      expect(formatRelativeTime(before, now)).toBe('4320m ago'); // 3 days
    });
  });

  describe('formatIsoAsETLog', () => {
    it('formats ISO string as ET log format', () => {
      expect(formatIsoAsETLog('2026-02-23T19:35:42.123Z')).toBe('02/23 14:35:42.123 ET');
    });

    it('handles invalid ISO strings gracefully', () => {
      expect(formatIsoAsETLog('invalid-date')).toBe('invalid-date');
    });

    it('handles empty string', () => {
      expect(formatIsoAsETLog('')).toBe('');
    });
  });
});
