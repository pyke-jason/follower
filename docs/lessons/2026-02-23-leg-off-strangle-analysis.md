# LEG_OFF Strangle Bug — Root Cause Analysis

**Date:** 2026-02-23
**Status:** Investigation Complete
**Impact:** Intent extraction + Pipeline design

---

## Problem

Hariseldon attempted to exit one leg of a "strangle" on SPY using LEG_OFF, producing:
```
[warn] [Pipeline] LEG_OFF SPY: No SELL leg found to close on PUT
[warn] [Pipeline] LEG_OFF SPY: fuzzy match — signal strategy STOCK ≠ position strategy PUT
```

The position: `SPY LONG PUT x10 [665 exp:2025-09-17]`

The failed intents:
1. "Exit of SPY puts leg while holding strangle (calls remain). LEG_OFF to CALL."
2. "Exit SPY Calls while holding Puts on Strangle = LEG_OFF, targetStrategy PUT"

---

## Decision

Two root causes identified:

1. **Intent Extraction Failure** (Upstream)
   - The trader mentioned "strangle" but only a PUT position was opened
   - No CALL leg was ever executed
   - Intent extraction parsed "strangle" as narrative label but failed to detect the missing CALL leg
   - Should have either generated two OPEN signals or flagged for manual review

2. **LEG_OFF Design Limitation** (Downstream)
   - LEG_OFF is designed for spreads (CDS, PDS) with both BUY and SELL legs
   - A naked LONG PUT is pure BUY action — no SELL leg exists to close
   - Error message "No SELL leg found on PUT" is cryptic; doesn't explain why the position is incompatible

---

## Key Files

- **Pipeline LEG_OFF logic:** `src/pipeline/execute.ts:619-697`
  - Line 635: `const legToClose = existingLegs.find(l => l.action === 'SELL')`
  - Line 637: Fails when legToClose is undefined

- **Intent extraction system prompt:** `src/intents/extract-intent.ts:47-146`
  - Line 102-105: LEG_OFF docs (expects targetStrategy, designed for spreads)
  - No validation that multi-leg strategies have all legs opened

- **Position finding:** `src/pipeline/execute.ts:235-253`
  - Lines 244-249: Fuzzy fallback for mutation actions (CLOSE/TRIM/LEG_OFF)
  - Drops strategy filter when first match fails

---

## Watch Out

1. **Multi-leg Strategy Detection**
   - Strangles, butterflies, iron condors, calendars are explicitly multi-leg
   - Trader language may say "strangle" but only one side gets executed
   - Current LLM prompt has no validation for this

2. **SELL Leg Definition**
   - SELL = sold-to-open (short side of a spread or naked short)
   - Naked LONG PUT/CALL have NO SELL leg
   - LEG_OFF only works when position has `legs: [{action: 'BUY', ...}, {action: 'SELL', ...}]`

3. **Intent Confusion in Attempts**
   - Attempt 1: "Exit SPY puts leg" + targetStrategy: CALL ← backwards
   - Attempt 2: "Exit SPY Calls" + targetStrategy: PUT ← backwards
   - LLM extracted intent, but with inverted leg references

4. **Fuzzy Matching Edge Case**
   - Error log showed `signal strategy STOCK ≠ position strategy PUT`
   - Fuzzy fallback allowed execution to proceed
   - But then failed on "No SELL leg" due to position shape mismatch
   - Error message hides the real problem (strategy mismatch)

---

## Fixes Proposed

### 1. Intent Extraction Validation (URGENT)

Detect when trader mentions multi-leg strategy name but only partial legs are extracted:

```typescript
// In extract-intent.ts, after signal generation
const multiLegStrategyNames = ['strangle', 'butterfly', 'iron condor', 'calendar', ...];
const mentionedMultiLeg = messageText.match(new RegExp(multiLegStrategyNames.join('|'), 'i'));

if (mentionedMultiLeg) {
  const openSignals = signals.filter(s => s.action === 'OPEN');
  const callsCount = openSignals.filter(s => s.strategy === 'CALL' || s.legs?.some(l => l.optionType === 'CALL')).length;
  const putsCount = openSignals.filter(s => s.strategy === 'PUT' || s.legs?.some(l => l.optionType === 'PUT')).length;

  if ((callsCount === 0 && putsCount > 0) || (putsCount === 0 && callsCount > 0)) {
    // Flag for manual review
    flagForReview(`Multi-leg ${mentionedMultiLeg[0]} mentioned but only one leg (${callsCount} calls, ${putsCount} puts) extracted`);
  }
}
```

### 2. Pipeline LEG_OFF Robustness (MEDIUM)

Improve error message and validate position shape:

```typescript
// In executeLegOff, before searching for legs
const hasMultipleLegs = existingLegs.length >= 2;
const hasSellLeg = existingLegs.some(l => l.action === 'SELL');

if (!hasMultipleLegs || !hasSellLeg) {
  return {
    signal,
    executed: false,
    reason: `LEG_OFF requires a multi-leg spread; found ${existing.strategy} with ${existingLegs.length} leg(s) ` +
            `(${existingLegs.map(l => l.action).join(', ')}). Cannot close individual leg.`,
  };
}
```

Better message: "LEG_OFF requires a multi-leg spread; found PUT with 1 leg(s) (BUY). Cannot close individual leg."

---

## Implementation Path

1. Add validation in intent extraction system prompt (safer upstream)
2. Enhance LEG_OFF error message for clarity (defensive)
3. Consider: should LEG_OFF support naked options? (policy decision)
   - Probably not — CLOSE is the right action for exiting naked options
   - LEG_OFF is semantically only for spreads
