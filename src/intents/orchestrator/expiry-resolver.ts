/**
 * Expiry hint resolver — converts human-readable expiry descriptions
 * ("0dte", "next friday", "Jan 17", "3/6") into YYYY-MM-DD date strings.
 */

import {
  toDateKeyET,
  getETComponents,
  ymd,
  etAnchor,
  thisWeekFriday,
  nextWeekFriday,
  thirdFriday,
  addBusinessDays,
} from '../../lib/et-date.js';

// ── Lookup tables ────────────────────────────────────────────────────────────

/** Named weekday index (0=Sun). */
const WEEKDAY_MAP: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

const MONTH_MAP: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

// ── Main resolver ────────────────────────────────────────────────────────────

/**
 * Resolve an expiryHint string to a YYYY-MM-DD date string.
 * Returns null if the hint cannot be interpreted.
 */
export function resolveExpiryHint(hint: string, messageDate: Date): string | null {
  const normalized = hint.trim().toLowerCase();

  // 0DTE
  if (normalized === '0dte') {
    return toDateKeyET(messageDate);
  }

  // LEAP → third Friday of month, 1 year out (standard monthly option expiry)
  if (normalized === 'leap') {
    const { year, month } = getETComponents(messageDate); // month is 1-indexed
    return toDateKeyET(thirdFriday(year + 1, month - 1));   // thirdFriday wants 0-indexed month
  }

  // overnight → next business day
  if (normalized === 'overnight') {
    return toDateKeyET(addBusinessDays(messageDate, 1));
  }

  // tomorrow → next business day
  if (normalized === 'tomorrow') {
    return toDateKeyET(addBusinessDays(messageDate, 1));
  }

  // "next friday"
  if (normalized === 'next friday') {
    // Strict "next" = the Friday of next week, not this week's Friday
    return toDateKeyET(nextWeekFriday(messageDate));
  }

  // "this week" / "this friday"
  if (normalized === 'this week' || normalized === 'this friday') {
    return toDateKeyET(thisWeekFriday(messageDate));
  }

  // "next week"
  if (normalized === 'next week') {
    return toDateKeyET(nextWeekFriday(messageDate));
  }

  // "next monday" / "next tuesday" etc.
  const nextDayMatch = normalized.match(/^next\s+(\w+)$/);
  if (nextDayMatch) {
    const dayName = nextDayMatch[1];
    const targetDow = WEEKDAY_MAP[dayName];
    if (targetDow !== undefined) {
      const anchor = etAnchor(messageDate);
      const currentDow = anchor.getUTCDay();
      // Days until that weekday next week (always at least 7+ days out, strictly next week)
      const daysToNextMonday = (8 - currentDow) % 7 || 7;
      const result = new Date(anchor);
      result.setUTCDate(result.getUTCDate() + daysToNextMonday); // start of next week (Monday)
      // From Monday, advance to the target day
      const deltaFromMonday = (targetDow - 1 + 7) % 7;
      result.setUTCDate(result.getUTCDate() + deltaFromMonday);
      return toDateKeyET(result);
    }
  }

  // Explicit slash date: "3/6", "3/6/26", "3/6/2026"
  const slashMatch = hint.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashMatch) {
    const rawMonth = parseInt(slashMatch[1], 10);
    const day = parseInt(slashMatch[2], 10);
    // Validate ranges — reject impossible dates (e.g. strike pairs "68/67")
    if (rawMonth < 1 || rawMonth > 12 || day < 1 || day > 31) return null;
    let year: number;
    if (slashMatch[3]) {
      const rawYear = parseInt(slashMatch[3], 10);
      year = rawYear < 100 ? 2000 + rawYear : rawYear;
    } else {
      year = getETComponents(messageDate).year;
      if (ymd(year, rawMonth, day) < toDateKeyET(messageDate)) year++;
    }
    return ymd(year, rawMonth, day);
  }

  // Month + day: "Jan 17", "feb 3"
  const monthDayMatch = hint.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (monthDayMatch) {
    const monthIdx = MONTH_MAP[monthDayMatch[1].toLowerCase()];
    if (monthIdx !== undefined) {
      const day = parseInt(monthDayMatch[2], 10);
      let year = getETComponents(messageDate).year;
      if (ymd(year, monthIdx + 1, day) < toDateKeyET(messageDate)) year++;
      return ymd(year, monthIdx + 1, day);
    }
  }

  // Bare month: "Oct", "January"
  const bareMonthMatch = MONTH_MAP[normalized];
  if (bareMonthMatch !== undefined) {
    let year = getETComponents(messageDate).year;
    const candidate = thirdFriday(year, bareMonthMatch);
    if (candidate < messageDate) {
      year++;
    }
    return toDateKeyET(thirdFriday(year, bareMonthMatch));
  }

  return null;
}

// ── Weekly expiry generation ─────────────────────────────────────────────────

/** Generate a set of weekly expiry candidates (Fri) starting from messageDate. */
export function generateWeeklyExpiries(from: Date, count = 6): string[] {
  const expiries: string[] = [];
  const fromKey = toDateKeyET(from);
  let d = thisWeekFriday(from);
  if (toDateKeyET(d) < fromKey) d = nextWeekFriday(from);
  for (let i = 0; i < count; i++) {
    expiries.push(toDateKeyET(d));
    d = new Date(d);
    d.setUTCDate(d.getUTCDate() + 7); // noon UTC + 7 days = noon UTC next week (safe)
  }
  return expiries;
}
