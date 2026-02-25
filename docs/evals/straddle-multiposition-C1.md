# Straddle/Strangle Detection & Multi-Position Close — Analysis (C1)

## Summary

Six failing eval cases across two fixtures (`strangle-overnight.json`, `exits.json`) expose three
distinct bugs in the orchestrator pipeline:

1. **Strangle detection requires both badges** — keyword alone is insufficient (strangle-003)
2. **No "strangle exit" path** — closing a straddle/strangle hits multi-position ambiguity (strangle-005, strangle-006, exits-005, exits-012)
3. **LLM path doesn't attach tradeId** — signals go through LLM but bypass position matching (strangle-004, exits-004)

---

## Bug 1: `isStrangle` requires `hasLongBadge && hasShortBadge`

### Failing case
**strangle-003**: `"Long Straddle on MSTR using $182.5 Calls and Puts for $7.66 - 15 Contracts"`
- Badges: `["Long"]` (no Short badge)
- Expected: 2 signals (CALL + PUT, both BUY, strike 182.5)
- Got: 1 signal (only CALL)

### Root cause
`parser.ts:267`:
```ts
const isStrangle = hasLongBadge && hasShortBadge && STRANGLE_RE.test(cleanText);
```

This requires **both** Long and Short badges. When only one badge is present, `isStrangle` is
`false`. The message then flows to strategy detection (lines 270-296), which sees `CALLS_RE`
first and sets `strategy = 'CALL'`. The "Puts" mention is ignored because strategy detection
is first-match, not multi-match.

### Why the double-badge requirement exists
Looking at `parser.ts:238-241`:
```ts
// Long+Short badges without strangle keyword -> calendar/time spread
if (hasLongBadge && hasShortBadge && !STRANGLE_RE.test(cleanText)) {
  return hardSkip('calendar/time spread not supported', complexityFlags);
}
```

The dual-badge check serves to **prevent false positives** on calendar/time spreads. When both
Long and Short badges are present, the STRANGLE_RE keyword disambiguates. But the inverse
assumption — that a single badge can never be a straddle — is wrong. Real-world data shows
traders sometimes post straddles with only a Long badge.

### Proposed fix
The `STRANGLE_RE` keyword (`/\bstrangle\b|\bstraddle\b/i`) alone should be sufficient to
trigger `isStrangle = true`, regardless of badges. The keyword is unambiguous — there's no
other meaning for "straddle" or "strangle" in this domain.

Specifically:
```ts
const isStrangle = STRANGLE_RE.test(cleanText);
```

**Concern**: This changes the hard-skip guard at line 238. Currently:
- `Long+Short + no strangle keyword` -> hard skip (calendar/time spread)
- `Long+Short + strangle keyword` -> strangle path

With `isStrangle = STRANGLE_RE.test(cleanText)`:
- The hard-skip guard still works correctly: it checks `!STRANGLE_RE.test(cleanText)`, so
  strangles are never hard-skipped.
- Single-badge strangles now route correctly.
- No-badge messages with "straddle"/"strangle" in text also route correctly.

**Edge case to verify**: Does any non-trade message contain "strangle" or "straddle" as commentary?
If so, the action check (line 348: `hasLongBadge || hasShortBadge -> action = 'OPEN'` or
line 352: no badge -> verb-based) would still need to produce `action = 'OPEN'` for the
strangle path to fire. The strangle check happens at `index.ts:70` **before** the action check,
so it's independent. This means a straddle mention with no badge and no opening verb would
still trigger the strangle fork. This could be a false positive vector.

**Safer alternative**: `isStrangle = STRANGLE_RE.test(cleanText) && (hasLongBadge || hasShortBadge || action === 'OPEN')`
— but action is computed after isStrangle. Would need restructuring. Simplest safe version:
```ts
const isStrangle = STRANGLE_RE.test(cleanText) && (hasLongBadge || hasShortBadge);
```
This covers the strangle-003 case (Long badge only) and strangle-004 case (Exit+Long+Short)
without opening the door to badge-less false positives.

---

## Bug 2: Position-path cannot handle multi-position straddle/strangle exits

### Failing cases
- **strangle-005 / exits-005**: `"Exit MSTR Straddle completely with a .30 cent loss per contract total"`
  - 2 positions: MSTR CALL + MSTR PUT
  - Parser: `action=CLOSE`, `symbol=MSTR`, `strategy=null` (STRANGLE_RE matches but doesn't set strategy)
  - Position-path: `matchPosition` finds 2 positions for MSTR, no strategy filter, `candidates.length === 2`
  - Neither direction filter helps (both are LONG)
  - Result: MANUAL_REVIEW "multiple positions found for MSTR"

- **strangle-006 / exits-012**: `"Close MSTR Puts on the straddle for a profit - holding the calls now"`
  - Same 2 positions: MSTR CALL + MSTR PUT
  - Parser: `action=CLOSE`, `symbol=MSTR`, `strategy=PUT` (PUTS_RE matches)
  - Position-path: `matchPosition` filters by strategy=PUT, finds 1 match, **should work**
  - Wait — let me trace again...

### Detailed trace for strangle-006/exits-012

Parser trace:
1. `hasExitBadge = false` (no badges at all)
2. No hard skip (no paper/futures/Long+Short without strangle)
3. `isStrangle = false` (no Long or Short badge)
4. Strategy detection: `PUTS_RE.test("Close MSTR Puts on the straddle for a profit - holding the calls now")` = true. `SPREAD_KW_RE` doesn't match. So `strategy = 'PUT'`, `directionFromStrategy = 'LONG'`.
5. Direction: `strategy = 'PUT'` -> `direction = 'LONG'` (default). No sell verbs present.
6. Action: No Exit badge. `EXIT_VERB_RE.test(cleanText)` -> "Close" matches `clos(ed|ing)`. Wait — "Close" doesn't match `/\b(exit(?:ing|ed)?|clos(?:ed|ing)|exiting|took profits?|stopped out|sold out)\b/i`. Let me check: "Close" vs `clos(?:ed|ing)`. "Close" ends in "e", pattern expects "ed" or "ing". **"Close" does NOT match EXIT_VERB_RE!**

Wait, let me re-examine: `/\b(exit(?:ing|ed)?|clos(?:ed|ing)|exiting|took profits?|stopped out|sold out)\b/i`
- `exit(?:ing|ed)?` matches "exit", "exiting", "exited"
- `clos(?:ed|ing)` matches "closed", "closing" but NOT "close"
- `exiting` (redundant with first alternation)
- etc.

So "Close" does NOT match `EXIT_VERB_RE`. That means:
- `action` stays `null` from the exit-verb detection block
- Falls to line 362: `BOUGHT_BUYING_RE` doesn't match "Close". `/\b(adding|opened)\b/i` doesn't match.
- `WROTE_WRITING_RE` doesn't match.
- `action = null`.

With `action = null`, `needsLLM = true` (line 80), and it goes to LLM path. If no LLM provider, it returns MANUAL_REVIEW.

**Root cause for strangle-006/exits-012**: `EXIT_VERB_RE` does not match the bare verb "close". It requires "closed" or "closing" but not the base form "close".

This is the **primary bug** for this case. If `EXIT_VERB_RE` matched "close", then:
- `action = 'CLOSE'`
- `strategy = 'PUT'`
- Position-path would filter by strategy=PUT, find exactly 1 match (the PUT position), and succeed.

### Detailed trace for strangle-005/exits-005

Parser trace:
1. `hasExitBadge = true` (badges: ["Exit"])
2. No hard skip.
3. `isStrangle = false` (only Exit badge, no Long/Short)
4. Strategy detection: STRANGLE_RE matches "Straddle" — but wait, STRANGLE_RE is not in the
   strategy detection chain (lines 274-296). STRANGLE_RE is only used for `isStrangle` computation.
   Looking at strategy detection: CDS? No. PCS? No. PDS? No. LEAP? No. Lotto? No. STOCK? No.
   CALLS_RE? No (no "calls" in text). PUTS_RE? No (no "puts" in text). **strategy = null**.
5. Direction: `directionFromStrategy = null`. `isLotto = false`. `strategy === null` -> no direction derivation. `direction = null`.
6. Action: `hasExitBadge = true`. LEGOFF_RE? No. `exitPercent`? No. So `action = 'CLOSE'`.

Result: `action='CLOSE'`, `symbol='MSTR'`, `strategy=null`, `direction=null`, `complexityFlags={}`.

Position-path:
- `matchPosition` called with positions=[MSTR CALL, MSTR PUT], parse.strategy=null
- Line 98-118: `parse.strategy === null`, so `candidates = bySymbol` (both positions)
- Line 121: `candidates.length === 2`, not 1
- Line 126: `parse.direction === null`, falls to else block
- Line 133: `longPositions` = both (both are LONG), `longPositions.length === 2`, not 1
- Line 139: return `{ flagReason: "multiple positions found for MSTR" }`

**Root cause**: `matchPosition` has no concept of "close ALL matching positions". It's designed
to return a single position. For straddle/strangle exits that close both legs, we need to
return **all** matching positions and generate **two** close signals.

---

## Bug 3: LLM path doesn't attach tradeId to close signals

### Failing cases
- **strangle-004 / exits-004**: `"Exit Long Short GOOGL strangle took small profit"`
  - Badges: `["Exit", "Long", "Short"]`
  - Positions: GOOGL CALL + GOOGL PUT
  - Expected: 2 signals with `hasTradeId=true`
  - Got: 2 signals with `hasTradeId=false`

### Trace
Parser:
1. `hasExitBadge = true`, `hasLongBadge = true`, `hasShortBadge = true`
2. No hard skip (STRANGLE_RE matches "strangle", so the Long+Short hard skip is bypassed)
3. `isStrangle = true` (Long+Short+STRANGLE_RE)
4. `complexityFlags.add('mixed_action')` — Exit badge + Long/Short badges
5. Action: Exit badge -> CLOSE. But `mixed_action` flag is set.

In `index.ts`:
- `parse.isStrangle = true` -> enters strangle block at line 70
- `resolveStrangle` at line 164: creates two OPEN signals with `action='OPEN'`, routes to `resolveOpenPath`
- But this is a CLOSE, not an OPEN. The strangle path is hardcoded to OPEN.

Wait, actually: `parse.isStrangle = true` fires at line 70, BEFORE the complexity flag check.
So the strangle path takes over. But `resolveStrangle` (line 168) sets `action: 'OPEN'` on
both sub-parses. It then routes both to `resolveOpenPath`, which resolves strikes/expiry from
market data and returns two OPEN signals — **not** close signals.

This means strangle-004 produces two OPEN signals instead of two CLOSE signals. The eval
expected `hasTradeId=true` (which comes from position matching in position-path), but open-path
never sets tradeId.

Actually, let me re-read the eval: "Got: EXECUTE 2 signals but hasTradeId=false". So the
orchestrator does produce 2 signals, but they're open signals without tradeIds. The LLM path
mention in the task description may refer to an alternate routing.

Let me re-trace: With `parse.isStrangle = true`:
- Line 70: `if (parse.isStrangle)` -> YES, enters strangle block
- `resolveStrangle` is called
- `resolveStrangle` creates baseParse with `action: 'OPEN'`, `direction: 'LONG'`
- Routes to `resolveOpenPath` for both CALL and PUT

The issue: **`resolveStrangle` unconditionally treats strangles as OPEN**, even when the
original parse had `action = 'CLOSE'` and `hasExitBadge = true`. There is no "strangle exit"
path.

### Root cause
`resolveStrangle` (index.ts:164-203) is an OPEN-only function. It ignores the parsed action.
When Exit+Long+Short badges are present with a strangle keyword, the system detects `isStrangle`
and blindly opens new positions instead of closing existing ones.

---

## Design Questions & Recommendations

### Q1: Should strangle detection use keyword alone or require badge confirmation?

**Recommendation**: Require at least one badge OR an action-indicating context.

```ts
const isStrangle = STRANGLE_RE.test(cleanText) && (hasLongBadge || hasShortBadge);
```

This handles:
- strangle-001/002: Long+Short -> yes
- strangle-003: Long only -> yes (fixes the bug)
- strangle-004/005/006: Exit badge (with or without Long/Short) -> handled by exit path below
- Commentary without badges -> no (prevents false positives)

Note: for EXIT cases (strangle-004/005/006), `isStrangle` detection is less relevant because
the primary routing should be through the position-path. The `isStrangle` flag is mainly
useful for OPEN actions where we need to fork into CALL+PUT signals.

### Q2: How should position-path handle "close BOTH positions" for straddle/strangle exits?

**Recommendation**: Add a `matchMultiplePositions` function or modify `matchPosition` to
return multiple positions when the message context indicates a straddle/strangle exit.

Detection criteria for "close all straddle positions":
- `STRANGLE_RE.test(cleanText)` (mentions "straddle" or "strangle")
- `action === 'CLOSE'` (not TRIM or LEG_OFF)
- Multiple positions found for the symbol
- The positions form a straddle/strangle pair (one CALL, one PUT, same underlying)

When detected, return all matching positions and generate one close signal per position,
each with its own `tradeId`.

Implementation sketch for `position-path.ts`:
```ts
// Before matchPosition, check for straddle/strangle close
if (action === 'CLOSE' && STRANGLE_RE.test(ctx.cleanText)) {
  const bySymbol = positions.filter(p => p.symbol === symbol);
  const callPos = bySymbol.find(p => p.strategy === 'CALL');
  const putPos = bySymbol.find(p => p.strategy === 'PUT');
  if (callPos && putPos) {
    // Generate two close signals
    return {
      outcome: 'EXECUTE',
      signals: [
        buildCloseSignal(callPos, symbol),
        buildCloseSignal(putPos, symbol),
      ],
    };
  }
}
```

### Q3: Should there be a dedicated "strangle exit" path parallel to "strangle open"?

**Recommendation**: Yes, but it should live in `position-path.ts`, not in `index.ts`.

The orchestrator index should route based on action:
- `isStrangle && action === 'OPEN'` -> `resolveStrangle` (existing, in index.ts)
- `isStrangle && action === 'CLOSE'` -> `resolvePositionPath` with straddle-aware matching
- Don't special-case in index.ts; let position-path detect the straddle pattern itself

For strangle-004 (Exit+Long+Short badges), the fix is in `index.ts` routing:
```ts
if (parse.isStrangle && parse.action === 'OPEN') {
  // existing fork into CALL + PUT via open-path
} else if (parse.isStrangle) {
  // action is CLOSE/TRIM — route to position-path, which handles multi-position
}
```

Currently the code at line 70 does:
```ts
if (parse.isStrangle) {
  // always forks into OPEN signals
}
```

This needs to be conditioned on `action === 'OPEN'` (or `action !== 'CLOSE'`).

### Q4: For partial close ("close puts, keep calls"), how should position-path disambiguate?

**Recommendation**: Use the parsed `strategy` field.

For strangle-006 ("Close MSTR Puts on the straddle"):
- Parser already detects `strategy = 'PUT'` from PUTS_RE
- Position-path's `matchPosition` already filters by strategy
- The only bug is that `EXIT_VERB_RE` doesn't match "Close" (bare infinitive)

Fix: Extend EXIT_VERB_RE to match "close":
```ts
const EXIT_VERB_RE = /\b(exit(?:ing|ed)?|clos(?:e[ds]?|ing)|exiting|took profits?|stopped out|sold out)\b/i;
```

After this fix, the flow would be:
1. Parser: `action='CLOSE'`, `strategy='PUT'`, no complexity flags
2. Position-path: `matchPosition` filters by strategy=PUT, finds 1 match
3. Returns EXECUTE with tradeId = pos-mstr-put

For the "holding the calls now" part, no special handling needed — it's informational context
confirming the user is keeping the other leg.

---

## Summary of Required Changes

| Fix | File | Severity | Cases Fixed |
|-----|------|----------|-------------|
| `isStrangle` uses `\|\| hasLongBadge \|\| hasShortBadge` instead of `&&` | `parser.ts:267` | Medium | strangle-003 |
| `EXIT_VERB_RE` matches "close" (bare infinitive) | `parser.ts:84` | High | strangle-006, exits-012 |
| `resolveStrangle` checks action; only forks OPEN signals | `index.ts:70` | High | strangle-004, exits-004 |
| Position-path detects straddle/strangle CLOSE pattern | `position-path.ts` | High | strangle-005, exits-005 |

### Dependency order
1. `EXIT_VERB_RE` fix (independent, unblocks strangle-006/exits-012)
2. `isStrangle` badge relaxation (independent, unblocks strangle-003)
3. `resolveStrangle` action-awareness + position-path straddle close (coupled, unblocks strangle-004/005, exits-004/005)
