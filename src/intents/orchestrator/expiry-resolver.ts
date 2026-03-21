/**
 * Weekly expiry generation helper for the orchestrator.
 *
 * Expiry hint resolution is handled by `normalizeExpiry` in `src/lib/occ-symbology.ts`.
 */

import {
  toDateKeyET,
  thisWeekFriday,
  nextWeekFriday,
} from '@/lib/et-date.js';

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
