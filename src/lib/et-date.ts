/**
 * Eastern Time date utilities.
 *
 * All market-calendar / ET-conversion logic lives here so every call site
 * (ingestion, backtest runner, databento-tape) uses one
 * implementation with correct DST handling.
 */

const ET_TZ = 'America/New_York';

const etParts = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Extract ET year/month/day/hours/minutes/seconds from any Date. */
export function getETComponents(d: Date) {
  const parts = etParts.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hours: get('hour') % 24, // Intl can return 24 for midnight
    minutes: get('minute'),
    seconds: get('second'),
  };
}

/** Format a Date as YYYY-MM-DD in ET — DST-aware. */
export function toDateKeyET(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: ET_TZ }); // YYYY-MM-DD
}

/** 0=Sun..6=Sat in ET. */
function getDayOfWeekET(d: Date): number {
  const { year, month, day } = getETComponents(d);
  return new Date(year, month - 1, day).getDay();
}

/** True if the ET date is Mon-Fri. */
function isWeekdayET(d: Date): boolean {
  const dow = getDayOfWeekET(d);
  return dow >= 1 && dow <= 5;
}

/** Minute-of-day in ET (0 = midnight, 570 = 9:30 AM, 960 = 4:00 PM). */
export function getETMinuteOfDay(d: Date): number {
  const { hours, minutes } = getETComponents(d);
  return hours * 60 + minutes;
}

// ── Market Calendar ──────────────────────────────────────────────────

/** Market holidays — closed all day. */
const MARKET_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18',
  '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01',
  '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
  '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
  '2026-11-26', '2026-12-25',
]);

/** Early close days — market closes at 1:00 PM ET (minute 780) instead of 4:00 PM. */
const MARKET_EARLY_CLOSES = new Set([
  // 2025 (day after Thanksgiving, Christmas Eve, etc.)
  '2025-07-03', '2025-11-28', '2025-12-24',
  // 2026
  '2026-07-02', '2026-11-27', '2026-12-24',
]);

const REGULAR_CLOSE_MINUTE = 960;  // 4:00 PM
const EARLY_CLOSE_MINUTE = 780;    // 1:00 PM
const MARKET_OPEN_MINUTE = 570;    // 9:30 AM

/** Market close time in minutes-of-day for a given date (780 on early close, 960 normally). */
export function marketCloseMinute(d: Date): number {
  return MARKET_EARLY_CLOSES.has(toDateKeyET(d)) ? EARLY_CLOSE_MINUTE : REGULAR_CLOSE_MINUTE;
}

/** True if the ET calendar day is a trading day (weekday + not a holiday). */
export function isTradingDay(d: Date): boolean {
  if (!isWeekdayET(d)) return false;
  return !MARKET_HOLIDAYS.has(toDateKeyET(d));
}

/** True if ts falls within US equity market hours (9:30–close ET, on trading days). */
export function isMarketHours(d: Date): boolean {
  if (!isTradingDay(d)) return false;
  const minutes = getETMinuteOfDay(d);
  return minutes >= MARKET_OPEN_MINUTE && minutes <= marketCloseMinute(d);
}

/**
 * Walk backward from a YYYY-MM-DD day key to find the previous trading day.
 * Returns the day key, or null if none found within maxCalendarDays.
 */
export function getPreviousTradingDayKey(dayKey: string, maxCalendarDays = 10): string | null {
  let d = parseDateKey(dayKey); // noon UTC — safe for ET day math
  for (let i = 0; i < maxCalendarDays; i++) {
    d = new Date(d.getTime() - 24 * 60 * 60 * 1000);
    if (isTradingDay(d)) return toDateKeyET(d);
  }
  return null;
}

/**
 * Walk forward from a YYYY-MM-DD day key to find the next trading day.
 * Returns the day key, or null if none found within maxCalendarDays.
 */
export function getNextTradingDayKey(dayKey: string, maxCalendarDays = 10): string | null {
  let d = parseDateKey(dayKey);
  for (let i = 0; i < maxCalendarDays; i++) {
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    if (isTradingDay(d)) return toDateKeyET(d);
  }
  return null;
}

/** Parse a YYYY-MM-DD string to a Date (noon UTC to avoid DST ambiguity). */
export function parseDateKey(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

// ── Market Open / Close as UTC Dates ─────────────────────────────────

/** Market open (9:30 ET) as a UTC Date. DST-aware. */
export function marketOpenUTC(d: Date): Date {
  const { start } = dayBoundsUTC(toDateKeyET(d));
  return new Date(start.getTime() + MARKET_OPEN_MINUTE * 60 * 1000);
}

/** Market close (4:00 PM or 1:00 PM on early close) as a UTC Date. DST-aware. */
export function marketCloseUTC(d: Date): Date {
  const key = toDateKeyET(d);
  const { start } = dayBoundsUTC(key);
  const closeMin = MARKET_EARLY_CLOSES.has(key) ? EARLY_CLOSE_MINUTE : REGULAR_CLOSE_MINUTE;
  return new Date(start.getTime() + closeMin * 60 * 1000);
}

// ── UTC Conversion ───────────────────────────────────────────────────

/**
 * UTC boundaries for an ET calendar day — DST-aware.
 *
 * "2025-09-01" in EDT → start = 2025-09-01T04:00:00Z, end = 2025-09-02T04:00:00Z
 * "2025-01-15" in EST → start = 2025-01-15T05:00:00Z, end = 2025-01-16T05:00:00Z
 */
export function dayBoundsUTC(day: string): { start: Date; end: Date } {
  const noonUTC = parseDateKey(day);
  const etHour = getETComponents(noonUTC).hours;
  const offsetHours = 12 - etHour; // 5 for EST, 4 for EDT
  const start = new Date(`${day}T${String(offsetHours).padStart(2, '0')}:00:00Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** Most recent market close as a UTC Date. For after-hours: same day's close.
 *  For pre-market / weekends / holidays: previous trading day's close. */
export function lastMarketCloseUTC(at: Date): Date {
  const dayKey = toDateKeyET(at);
  if (isTradingDay(at) && getETMinuteOfDay(at) >= marketCloseMinute(at)) {
    return marketCloseUTC(at);
  }
  const prevKey = getPreviousTradingDayKey(dayKey);
  if (!prevKey) return at;
  return marketCloseUTC(parseDateKey(prevKey));
}

// ── Date Helpers ────────────────────────────────────────────────────

/** Returns the next Friday (YYYY-MM-DD) on or after referenceDate, using UTC day-of-week. */
export function nextFriday(referenceDate: Date): string {
  const d = new Date(referenceDate);
  const dow = d.getUTCDay(); // 0=Sun, 5=Fri
  const daysToAdd = dow <= 5 ? (5 - dow) : 6; // If Sat (6), next Fri is 6 days out
  d.setUTCDate(d.getUTCDate() + daysToAdd);
  return d.toISOString().split('T')[0];
}

// ── LLM-Friendly Formatting ─────────────────────────────────────────

/** Shared ET formatter for human-readable timestamps in LLM prompts. */
const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TZ,
  weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

/** Format ISO timestamp as "Tue, Sep 2, 2025, 10:32 AM ET" for the LLM. */
export function formatTimestampForLLM(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return ET_FORMATTER.format(d);
}
