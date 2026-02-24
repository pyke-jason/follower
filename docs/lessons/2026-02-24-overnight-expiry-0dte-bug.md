# overnight → 0DTE Expiry Bug

**Date**: 2026-02-24

## Problem

"Long SPY for overnight" opened on Friday Sep 5 3:36 PM was given 0DTE expiry (645C 9/05)
and auto-closed at 4:00 PM that same day. The trader's actual exit "Exit Long SPY took
profits in overnight calls" arrived Sep 8 9:31 AM but found no open position → silently
skipped. UI showed "Auto" instead of "Signal".

## Root Cause Chain

1. **LLM** correctly emits `OPEN LONG CALL SPY` with no legs (no strikes stated — per design).
2. **`expiryHintInjection`** scans for "next week", month names, etc. — "overnight" not in
   any regex → no hint leg injected. Signal passes through unchanged.
3. **`resolveSignalLegs`** (execute.ts:200-203): no expiryHintLeg found → falls through to
   `nextFriday(refDate)`.
4. **`nextFriday(Sep 5)`**: Sep 5 IS a Friday → `daysToAdd = 5-5 = 0` → returns Sep 5.
5. Position opened with 645C 9/05 (0DTE). Auto-close fires at 4:00 PM. closeMessageId = null.
6. Sep 8 exit message → no open position → skipped.

## Decision

Add "overnight" as a first-class expiry token:
- `expiryHintInjection` (postprocess.ts): when "overnight" in cleanText, inject `expiry: 'overnight'`
- `normalizeExpiry` (occ-symbology.ts): "overnight" → next trading day, skipping weekends
  (Fri → Mon, Sat → Mon, Mon–Thu → next calendar day)

Chose NOT to import `getNextTradingDayKey` from et-date.ts into occ-symbology.ts to keep
the file self-contained. Weekend skip covers all real cases; holiday handling can be added
later if needed (rare edge).

## Key Files

- `src/intents/postprocess.ts` — expiryHintInjection, added overnight pattern
- `src/backtest/occ-symbology.ts` — normalizeExpiry, added overnight token (after tomorrow block)
- `src/backtest/occ-symbology.test.ts` — 4 new tests for overnight
- `src/intents/evals/fixtures/strangle-overnight.json` — added case 007 (Sep 8 exit)

## Watch Out

- The scorer (`evals/scorer.ts`) only supports equality in `mustMatch` — cannot express
  "expiry must NOT be 2025-09-05". Negative expiry constraints can't be tested in fixtures.
- The two entry cases (005, 006) already have notes saying "must NOT select same-day expiry"
  but mustMatch doesn't enforce it. The postprocess fix is the enforcement.
- DB shows the same entry message produced 9/05 expiry in one run and 9/12 in another —
  this inconsistency was across different backtest runs with different code versions, not
  non-determinism in the same run.
