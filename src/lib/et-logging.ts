/**
 * Eastern Time logging primitives.
 *
 * Provides human-friendly timestamp formatters for logs and debugging.
 * All formats are in ET timezone and DST-aware.
 * Reuses getETComponents from et-date.ts to stay DRY.
 */

import { getETComponents, getETMinuteOfDay, marketCloseMinute } from './et-date.js';

/**
 * Format a Date as compact ET timestamp: "02/23 14:35:42.123"
 * Uses 24-hour time, zero-padded, includes milliseconds for precision.
 */
export function formatLogTimestampET(d: Date): string {
  const c = getETComponents(d);
  const mon = String(c.month).padStart(2, '0');
  const day = String(c.day).padStart(2, '0');
  const h = String(c.hours).padStart(2, '0');
  const min = String(c.minutes).padStart(2, '0');
  const sec = String(c.seconds).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${mon}/${day} ${h}:${min}:${sec}.${ms}`;
}

/**
 * Format a Date as time only in ET.
 * @param format - 'hhmm' (14:35), 'hh:mm:ss' (14:35:42, default), or '12h' (2:35 PM)
 */
export function formatLogTimeET(
  d: Date,
  format: 'hhmm' | 'hh:mm:ss' | '12h' = 'hh:mm:ss',
): string {
  const c = getETComponents(d);

  switch (format) {
    case 'hhmm':
      return `${String(c.hours).padStart(2, '0')}:${String(c.minutes).padStart(2, '0')}`;
    case 'hh:mm:ss':
      return `${String(c.hours).padStart(2, '0')}:${String(c.minutes).padStart(2, '0')}:${String(c.seconds).padStart(2, '0')}`;
    case '12h': {
      const hour12 = c.hours % 12 || 12;
      const ampm = c.hours < 12 ? 'AM' : 'PM';
      return `${hour12}:${String(c.minutes).padStart(2, '0')} ${ampm}`;
    }
  }
}

/**
 * Get market session label for a Date in ET.
 * PRE = before 9:30 AM (pre-market)
 * RTH = 9:30 AM to close (regular trading hours)
 * AH = after close (after hours)
 */
export function getSessionLabel(d: Date): 'PRE' | 'RTH' | 'AH' {
  const min = getETMinuteOfDay(d);
  const closeMin = marketCloseMinute(d);
  if (min < 570) return 'PRE'; // Before 9:30
  if (min <= closeMin) return 'RTH'; // Regular trading hours (9:30 through close)
  return 'AH'; // After hours (after close)
}

/**
 * Format a Date as compact ET time with market session label: "14:35:42 [RTH]"
 * Useful for logs that need session context.
 */
export function formatLogTimeWithSession(d: Date): string {
  const time = formatLogTimeET(d, 'hh:mm:ss');
  const session = getSessionLabel(d);
  return `${time} [${session}]`;
}

/**
 * Format relative time between two dates.
 * @param at - The earlier timestamp
 * @param relative - The reference timestamp (defaults to now)
 * @returns String like "2m 34s ago" or "now" if less than 1 second apart
 */
export function formatRelativeTime(at: Date, relative?: Date): string {
  const ref = relative ?? new Date();
  const ms = ref.getTime() - at.getTime();
  if (ms < 1000) return 'now';
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  if (secs === 0) return `${mins}m ago`;
  return `${mins}m ${secs}s ago`;
}

/**
 * Format an ISO timestamp string as compact ET log format: "02/23 14:35:42.123 ET"
 * Safe fallback to original string if parsing fails.
 */
export function formatIsoAsETLog(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return formatLogTimestampET(d) + ' ET';
}
