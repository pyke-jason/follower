/**
 * Canonicalize a Signal for comparison: normalize expiry format, sort strikes,
 * lowercase enum-like strings, etc. Must be called at every WRITE site (label
 * write, classifierSignals write) so equality comparisons don't need
 * normalization downstream.
 */
import type { Signal } from '@/agent/schemas.js';

/**
 * Canonicalize expiry to a trader-intent form: zero-padded M/D when numeric,
 * lowercased keyword otherwise. Preserves the raw human intent — the executor
 * resolves the actual calendar date using the message timestamp context.
 *
 * Examples: "9/5" → "09/05", "9/5/25" → "09/05", "2025-09-05" → "09/05",
 * "next week" → "next week", "0DTE" → "0dte".
 */
const MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

export function canonicalExpiry(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  // ISO form: strip year (intent-level, not execution-level)
  const iso = /^\d{4}-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return `${iso[1]}/${iso[2]}`;
  // M/D or M/D/YY form: drop year, zero-pad
  const us = /^(\d{1,2})[/-](\d{1,2})(?:[/-]\d{2,4})?$/.exec(s);
  if (us) {
    const m = parseInt(us[1], 10);
    const d = parseInt(us[2], 10);
    return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
  }
  // "21 nov" / "21 November" / "Nov 21" / "November 21" / "Oct (10)" / "Oct(10)" / "oct 10"
  const lower = s.toLowerCase();
  const dayMonth = /^(\d{1,2})\s+([a-z]+)$/.exec(lower);
  const monthDay = /^([a-z]+)\s*(?:\(\s*(\d{1,2})\s*\)|\s+(\d{1,2}))$/.exec(lower);
  let m: number | null = null;
  let d: number | null = null;
  if (dayMonth && MONTH_MAP[dayMonth[2]]) { d = parseInt(dayMonth[1], 10); m = MONTH_MAP[dayMonth[2]]; }
  else if (monthDay && MONTH_MAP[monthDay[1]]) {
    m = MONTH_MAP[monthDay[1]];
    d = parseInt(monthDay[2] ?? monthDay[3], 10);
  }
  if (m != null && d != null) return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
  // Normalize common keyword variants
  if (/^tomorrow'?s?\s*$/i.test(s)) return 'tomorrow';
  if (/^expiring\s+today$/i.test(s)) return 'today';
  if (/^expiring\s+tomorrow$/i.test(s)) return 'tomorrow';
  if (/^this\s+week$/i.test(s)) return 'this week';
  if (/^next\s+week$/i.test(s)) return 'next week';
  // Labels use "today" for same-day expiry; "0dte" and "expiring today" fold
  // into "today" for comparability.
  if (/^0\s*dte$/i.test(s)) return 'today';
  if (/^expiring\s+today$/i.test(s)) return 'today';
  return lower;
}

/** Strikes comparable independent of leg order for spreads. */
export function canonicalStrikes(raw: number[] | null | undefined): number[] | null {
  if (raw == null || raw.length === 0) return null;
  return [...raw].sort((a, b) => a - b);
}

export function canonicalizeSignal(s: Signal): Signal {
  return {
    ...s,
    symbol: s.symbol.toUpperCase(),
    expiry: canonicalExpiry(s.expiry ?? null),
    strikes: canonicalStrikes(s.strikes ?? null),
  };
}

export function canonicalizeSignals(sigs: Signal[]): Signal[] {
  const canon = sigs.map(canonicalizeSignal);
  // Dedupe: LLM occasionally emits duplicate signals (same action+symbol+strategy+direction).
  // Keep the one with more populated fields (more non-null values).
  const seen = new Map<string, Signal>();
  const countSet = (s: Signal): number => {
    let n = 0;
    if (s.direction) n++;
    if (s.strategy) n++;
    if (s.strikes?.length) n++;
    if (s.expiry) n++;
    if (s.statedPrice != null) n++;
    if (s.quantity != null) n++;
    return n;
  };
  for (const s of canon) {
    const key = `${s.action}|${s.symbol}|${s.strategy ?? ''}|${s.direction ?? ''}|${(s.strikes ?? []).join(',')}`;
    const prev = seen.get(key);
    if (!prev || countSet(s) > countSet(prev)) seen.set(key, s);
  }
  return Array.from(seen.values());
}
