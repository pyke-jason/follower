# Intent Prompt Simplification: Calendar Math to TypeScript

## Problem

LLM was failing to normalize expiry dates to YYYY-MM-DD ~33.6% of the time despite the prompt demanding it. The system already had `normalizeExpiry()` downstream to handle most formats, so the LLM was burning tokens on a task it was bad at.

After shipping Proposal 1 (INTENT_VERSION 7→8), backtesting exposed new failure modes:
- `"tomorrow's"` (possessive) → unrecognized format
- `"Wednesday"` / `"Friday"` (bare day-of-week names) → "unrecognized month name"
- `"-"` (LLM placeholder when field was required but unknown) → cryptic slash-split error
- `""` (empty string) → Zod `z.string().min(1)` schema rejection → retry loop → leg data loss

## Decision

1. **Made `SignalLegSchema.expiry` optional** (`z.string().min(1).optional()`). The LLM now omits the field when no expiry is stated, instead of emitting `""` or `"-"` to satisfy a required field. Downstream `buildOptionLegs()` falls back to `nextFriday(referenceDate)` when expiry is absent — same behavior as fully-inferred legs.

2. **Extended `normalizeExpiry()`** with three new handlers:
   - Strip possessive suffix `'s` (ASCII U+0027, curly U+2018/U+2019) before all other checks
   - Junk placeholders (`"-"`, `""`) throw `'no date stated'` immediately
   - Day-of-week bare names (`"Friday"`, `"Wednesday"`, etc.) → next occurrence on or after referenceDate (DOW_NAMES lookup before MONTH_ABBREVS)

3. **Fixed pre-existing property test bug**: `fc.date()` generates `new Date(NaN)` during fast-check shrinking even with bounds set. Added `.filter(d => !isNaN(d.getTime()))`.

## Key Files

- `src/agent/schemas.ts:19` — `expiry: z.string().min(1).optional()`
- `src/backtest/occ-symbology.ts` — DOW_NAMES, possessive strip, junk placeholder, bareWord block
- `src/pipeline/execute.ts:161` — `l.expiry ? normalizeExpiry(...) : nextFriday(referenceDate)`
- `src/backtest/occ-symbology.test.ts` — 3 new test cases + property test fix

## Watch Out

- **`normalizeExpiry` throws on `"-"` and `""`** — if you call it from a new path, guard against these values or make expiry optional at the call site.
- **DOW resolution returns "today" if refDate is already that day** — `(dowNum - dow + 7) % 7` gives 0 when same day. This is correct: "Friday expiry" on a Friday = that day's expiry.
- **`fc.date()` can generate `Invalid Date` during shrinking** — always add `.filter(d => !isNaN(d.getTime()))` to date-based property tests.
- **Schema-auditor finding**: 16/579 v8 intents had schema errors from empty-string expiry; 7 of those lost leg data on retry. Making expiry optional eliminates this retry-induced data loss.
