# Straddle/Strangle & Multi-Position Close Analysis (C2)

## Case-by-Case Trace

### strangle-003: Straddle OPEN with only Long badge

**Message**: `<LONG BADGE /> Straddle on MSTR using $182.5 Calls and Puts for $7.66 - 15 Contracts`
**Badges**: `["Long"]`

**Parser trace**:
1. `hasLongBadge=true`, `hasShortBadge=false`, `hasExitBadge=false`
2. Line 267: `isStrangle = hasLongBadge && hasShortBadge && STRANGLE_RE.test(cleanText)` => **false** (missing Short badge)
3. Strategy detection: STRANGLE_RE is never used for strategy assignment. Falls through to line 290: `CALLS_RE.test(cleanText)` matches "Calls" => `strategy='CALL'`, `direction='LONG'`
4. The word "Puts" also appears in the text but CALLS_RE matched first in the if-else chain
5. Action: line 348 `hasLongBadge` => `action='OPEN'`
6. No complexity flags (word count <= 15 would need checking, but `multi_ticker` is false, etc.)
7. Result: `{action: OPEN, strategy: CALL, direction: LONG, isStrangle: false}`

**Root cause**: `isStrangle` requires BOTH Long+Short badges. This is too strict. The "Straddle" keyword alone should be sufficient to identify a strangle/straddle when accompanied by evidence of both calls AND puts in the text (e.g., "$182.5 Calls and Puts").

**Fix location**: `parser.ts` line 267. The isStrangle condition needs a second disjunction:
```
isStrangle = (hasLongBadge && hasShortBadge && STRANGLE_RE.test(cleanText))
          || (STRANGLE_RE.test(cleanText) && CALLS_RE.test(cleanText) && PUTS_RE.test(cleanText))
```
This covers: straddle/strangle keyword + both "calls" and "puts" mentioned = strangle regardless of badges.

**Secondary issue**: Strategy detection (lines 274-296) has no strangle/straddle branch. Even without the isStrangle flag, the strategy if-else chain picks `CALL` because it matches first. The STRANGLE_RE check at line 267 is disconnected from the strategy chain.

---

### strangle-004 / exits-004: GOOGL strangle EXIT (Exit+Long+Short badges)

**Message**: `<EXIT BADGE /> <LONG BADGE /> <SHORT BADGE /> GOOGL strangle took small profit`
**Badges**: `["Exit", "Long", "Short"]`
**Positions**: 2 separate positions: `pos-googl-call` (CALL, LONG) + `pos-googl-put` (PUT, LONG)

**Parser trace**:
1. `hasExitBadge=true`, `hasLongBadge=true`, `hasShortBadge=true`
2. Line 239: Long+Short without strangle keyword? No - STRANGLE_RE matches "strangle". So the hard-skip at line 239 does NOT fire (correctly).
3. Line 253: `hasExitBadge && (hasLongBadge || hasShortBadge)` => `mixed_action` complexity flag SET
4. Line 267: `isStrangle = true` (Long+Short+strangle keyword)
5. Strategy detection: CDS/PCS/PDS/LEAP/lotto all miss. Line 287: STOCK_RE? No. Line 290: CALLS_RE? No ("strangle" has no "call"/"calls"). Line 293: PUTS_RE? No. So `strategy=null`.
6. Action: line 333: hasExitBadge => `action='CLOSE'`
7. Result: `{action: CLOSE, strategy: null, isStrangle: true, complexityFlags: {mixed_action}}`

**Routing in index.ts**:
1. Line 63: not hard skip
2. Line 70: `parse.isStrangle` is true => enters `resolveStrangle()` at line 72
3. **BUG**: `resolveStrangle()` forces `action='OPEN'` and routes through `resolveOpenPath()`. This is wrong for an EXIT message. The strangle fork assumes OPEN unconditionally (line 168-173: `baseParse.action = 'OPEN'`).
4. resolveOpenPath would need a symbol quote and option chain, but more fundamentally it's building OPEN signals when we need CLOSE signals.

**Root cause**: `resolveStrangle()` is OPEN-only. When `isStrangle=true` AND `action=CLOSE/TRIM`, the orchestrator still calls `resolveStrangle()`, which blindly sets `action='OPEN'`. There is no strangle EXIT path.

**Secondary issue**: Even if we bypass the strangle fork and go to LLM path, the LLM produces signals without tradeIds (LLM doesn't know about positions). The `routeLLMSignals` function does convert CLOSE signals through `resolvePositionPath`, which would do position matching. BUT: the LLM signal's strategy might be null or wrong, and `matchPosition` would then hit "multiple positions found for GOOGL" because there are 2 GOOGL positions and no strategy filter.

**Fix**: The orchestrator needs to detect strangle+EXIT context and fork into per-position closes. Proposed flow:
1. In `index.ts`, BEFORE the isStrangle check (line 70), check: `if (parse.isStrangle && parse.action !== 'OPEN')` => route to a new `resolveStrangleExit()` function.
2. `resolveStrangleExit()` calls `ctx.positions.getPositions(symbol)`, finds all positions for the symbol, and produces one CLOSE/TRIM signal per position, each with the correct tradeId.
3. This avoids the LLM entirely for strangle exits.

---

### strangle-005 / exits-005: MSTR straddle full EXIT ("completely")

**Message**: `<EXIT BADGE /> MSTR Straddle completely with a .30 cent loss per contract total`
**Badges**: `["Exit"]`
**Positions**: 2 positions: `pos-mstr-call-3` (CALL) + `pos-mstr-put-3` (PUT)

**Parser trace**:
1. `hasExitBadge=true`, `hasLongBadge=false`, `hasShortBadge=false`
2. `isStrangle = false` (needs both Long+Short badges, only Exit present)
3. STRANGLE_RE matches "Straddle" in text, but isStrangle check requires the badges
4. Strategy: PUTS_RE matches "Puts"? No, the text says "Straddle" not "Puts". CALLS_RE? No. So `strategy=null`. Actually wait -- the text is "MSTR Straddle completely..." -- no calls/puts keyword present.
5. Action: line 333: hasExitBadge => action='CLOSE'
6. No complexity flags (no Long/Short badge, so mixed_action doesn't fire)
7. Result: `{action: CLOSE, strategy: null, symbol: 'MSTR', isStrangle: false, complexityFlags: {}}`

**Routing in index.ts**:
1. Not hard skip, not strangle (isStrangle=false), no complexity flags, action=CLOSE
2. Line 90-99: Goes to `resolvePositionPath()`
3. In position-path, `matchPosition()`:
   - `bySymbol` = 2 positions (CALL + PUT for MSTR)
   - `parse.strategy === null` => no strategy filter, `candidates = bySymbol` (both)
   - `candidates.length === 2` => try direction tie-breaking
   - `parse.direction === null` => default to LONG: `longPositions` = both (both are LONG)
   - `longPositions.length === 2` => falls through
   - Returns: `{ flagReason: "multiple positions found for MSTR, cannot determine which to close" }`

**Root cause (two-part)**:
1. **isStrangle is false** because the condition requires Long+Short badges, but this message only has Exit badge. The STRANGLE_RE keyword match is not sufficient alone.
2. **matchPosition is single-match only**. Even if we recognized this as a strangle context, matchPosition returns ONE position. For "close straddle completely", we need to close BOTH positions.

**Fix**: Two options:
- **Option A (parser-level)**: Detect strangle/straddle keyword in EXIT context. Add `isStrangleExit` flag when: `hasExitBadge && STRANGLE_RE.test(cleanText)`. Route to strangle exit handler that closes all symbol positions.
- **Option B (position-path-level)**: When action=CLOSE and matchPosition finds multiple same-symbol positions AND the text contains STRANGLE_RE, auto-fork into one CLOSE signal per position.

Option A is cleaner -- the parser already detects the straddle keyword, it just doesn't propagate it unless badges match. The fix should decouple STRANGLE_RE detection from the badge requirement for EXIT context.

---

### strangle-006 / exits-012: Partial straddle close ("close puts, keep calls")

**Message**: `Close MSTR Puts on the straddle for a profit - holding the calls now`
**Badges**: `[]` (no badges)
**Positions**: 2 positions: `pos-mstr-call-4` (CALL) + `pos-mstr-put-4` (PUT)

**Parser trace**:
1. No badges: `hasExitBadge=false`, `hasLongBadge=false`, `hasShortBadge=false`
2. `isStrangle = false` (no Long+Short badges)
3. Strategy detection: CALLS_RE matches "calls" (in "holding the calls"), but PUTS_RE also matches "Puts". **PUTS_RE comes after CALLS_RE in the if-else chain** (line 290 vs 293). Wait, let me re-check: "Close MSTR Puts on the straddle for a profit - holding the calls now"
   - Line 290: `CALLS_RE.test(cleanText)` = true ("calls" present) AND `!SPREAD_KW_RE.test(cleanText)` -- SPREAD_KW_RE includes `\bspread\b` but NOT "straddle", so this is `true`. => `strategy='CALL'`, `direction='LONG'`
   - **BUG**: The text says "Close MSTR Puts" (primary action on puts) but the parser picks strategy=CALL because "calls" appears in the secondary clause "holding the calls now". The CALLS_RE fires first in the if-else chain.
4. Action: No exit badge. Line 353: `EXIT_VERB_RE.test(cleanText)` = yes ("Close" matches `clos(?:ed|ing)` -- wait, does it? The RE is `/\b(exit(?:ing|ed)?|clos(?:ed|ing)|exiting|took profits?|stopped out|sold out)\b/i`. "Close" doesn't match `clos(?:ed|ing)` because it requires "closed" or "closing", not "Close". Let me re-check...
   - `exit(?:ing|ed)?` matches "exit", "exiting", "exited"
   - `clos(?:ed|ing)` matches "closed", "closing" but NOT "close"
   - `exiting` = duplicate (already covered)
   - `took profits?` = "took profit" or "took profits"
   - `stopped out`, `sold out`
   - **"Close" does NOT match EXIT_VERB_RE**. This is a gap.
5. Line 362: `BOUGHT_BUYING_RE.test(cleanText)` = false. `/\b(adding|opened)\b/i` = false.
6. Line 364: `WROTE_WRITING_RE.test(cleanText)` = false.
7. Result: `action=null`, which means `needsLLM=true` (action is null).

Actually wait, let me re-trace. The EXIT_VERB_RE is: `/\b(exit(?:ing|ed)?|clos(?:ed|ing)|exiting|took profits?|stopped out|sold out)\b/i`

"Close" -- the regex `clos(?:ed|ing)` requires "closed" or "closing". The bare word "Close" is NOT matched. So:
- `action = null`
- No badges means no complexity flags from mixed_action
- `needsLLM = true` (action is null)

So this routes to the LLM path. The LLM would need to produce a CLOSE signal for MSTR with strategy=PUT. Then `routeLLMSignals` converts it to a ParseResult and calls `resolvePositionPath`.

In `resolvePositionPath` with `{action: CLOSE, symbol: 'MSTR', strategy: 'PUT'}`:
- `matchPosition`: `bySymbol` = 2 positions (CALL + PUT)
- `parse.strategy = 'PUT'` => `byStrategy = bySymbol.filter(p => p.strategy === 'PUT')` = [pos-mstr-put-4]
- `byStrategy.length === 1` => `candidates = [pos-mstr-put-4]`
- `candidates.length === 1` => returns `{ position: pos-mstr-put-4 }`

**So if the LLM produces `{action: CLOSE, symbol: 'MSTR', strategy: 'PUT'}`, this case would PASS.** The problem is getting to the LLM path with the right context, and the LLM actually producing the right signal.

**Root causes (multiple)**:
1. **EXIT_VERB_RE misses "Close"** (bare infinitive). The regex only matches "closed" and "closing". This should be trivial to fix: change `clos(?:ed|ing)` to `clos(?:e|ed|ing)`.
2. **Strategy detection picks CALL** instead of PUT because "calls" appears in text (from "holding the calls") and CALLS_RE matches before PUTS_RE in the if-else chain.
3. If EXIT_VERB_RE were fixed, the parser would produce `{action: CLOSE, strategy: CALL}`. Then matchPosition would try to close the CALL position, which is wrong.
4. The real intent is: close the PUT, the "holding the calls" is context about what's NOT being closed.

**Fix considerations**:
- Fixing EXIT_VERB_RE to match "close" is necessary regardless.
- Strategy detection for exit messages needs "primary object" extraction: "Close MSTR Puts" => strategy=PUT. The phrase "holding the calls now" is subordinate/retained context, not the action target.
- This is genuinely hard for deterministic parsing. The pattern is: `close_verb + ticker + option_type` => that option_type is what's being closed. "holding/keeping" + option_type => that's being RETAINED.
- The existing `KEEP_CALLS_RE` / `KEEP_PUTS_RE` patterns (lines 89-90) could be repurposed. If "keep the calls" / "holding the calls" is detected, the strategy to CLOSE is the opposite (PUT). But these are currently only used for LEG_OFF context.

---

## Architectural Questions & Answers

### Q1: Should strangle EXIT mirror the OPEN fork pattern?

**Yes, absolutely.** The current `resolveStrangle()` in index.ts only handles OPEN. A parallel `resolveStrangleExit()` should:
1. Get all open positions for the symbol
2. Based on action (CLOSE/TRIM), build one reversal signal per position
3. Each signal gets its own tradeId from the matched position

This mirrors the OPEN pattern: fork into CALL close + PUT close, each resolved independently through position-path.

### Q2: Should matchPosition support multi-match for strangle/straddle contexts?

**No. matchPosition should stay single-match.** The multi-match concern should be handled at a higher level (the strangle exit handler), which calls matchPosition once per expected position (or directly iterates the positions list). Changing matchPosition's contract to sometimes-return-array would leak strangle concerns into the general position-matching logic.

Instead, the strangle exit handler should:
- Call `ctx.positions.getPositions(symbol)` directly
- Produce one signal per position without going through matchPosition

### Q3: Should position-path accept parse.strategy as a filter?

**It already does** -- matchPosition at line 99-118 filters by `parse.strategy` when non-null. The problem is that the strategy is sometimes set WRONG by the parser (e.g., strangle-006 picks CALL when it should be PUT).

The strategy filter works correctly when given correct input. The fix needs to happen upstream (parser strategy detection) or by routing through the LLM for disambiguation.

### Q4: Should the orchestrator detect strangle/straddle context on EXIT and auto-fork?

**Yes.** This is the key architectural addition needed. Detection criteria:
- STRANGLE_RE matches in text (straddle/strangle keyword)
- action is CLOSE or TRIM (not OPEN)
- Multiple positions exist for the symbol

The auto-fork should:
1. Be triggered in `index.ts` routing, after parse but before the normal position-path
2. Call `ctx.positions.getPositions(symbol)` to get all positions
3. For each position, build a CLOSE or TRIM signal with proper tradeId
4. Return all signals in one EXECUTE result

**Edge case**: Partial strangle close (strangle-006) should NOT auto-fork. The text says "close puts, keep calls" -- only one position should be closed. Detection: if KEEP_CALLS_RE or KEEP_PUTS_RE fires, this is a selective close, not a full strangle exit. Route it as a single position close with strategy derived from the "close" target, not the "keep" target.

### Q5: Where should tradeId attachment happen?

**In the orchestrator after routing, not in the LLM.** The LLM should never produce tradeIds. The current architecture is correct in principle: LLM produces `{action, symbol, strategy}`, then `routeLLMSignals` converts to ParseResult and calls `resolvePositionPath`, which does matchPosition to find the tradeId.

The only problem is when matchPosition fails due to:
- Multiple positions with no strategy discriminator (strangle full exit)
- Wrong strategy from parser contaminating the LLM signal

For strangle exits, the orchestrator-level fork (Q4) handles this before LLM is ever involved.

---

## Summary of Required Changes

### Parser changes (parser.ts)

| Change | Lines | Impact |
|--------|-------|--------|
| Widen isStrangle: also true when STRANGLE_RE + CALLS_RE + PUTS_RE all match (no badge requirement) | 267 | Fixes strangle-003 |
| Fix EXIT_VERB_RE to match bare "close" | 84 | Fixes strangle-006 routing |
| Add "straddle/strangle in EXIT context" detection: new `isStrangleExit` flag when (STRANGLE_RE matches) AND (action is CLOSE/TRIM or EXIT_VERB detected) | new | Enables strangle exit routing for strangle-005 |

### Orchestrator changes (index.ts)

| Change | Impact |
|--------|--------|
| Add `resolveStrangleExit()` function: gets all positions for symbol, builds one CLOSE/TRIM signal per position with tradeId | Fixes strangle-004, strangle-005 |
| Route to strangle exit when: `isStrangleExit` (or `isStrangle && action !== 'OPEN'`) AND multiple positions for symbol | Core architectural addition |
| Keep existing `resolveStrangle()` as-is for OPEN path | No regression |

### Position-path changes (position-path.ts)

| Change | Impact |
|--------|--------|
| No changes needed | matchPosition stays single-match; strangle multi-close is handled at orchestrator level |

### Strategy detection for partial close (parser.ts)

| Change | Impact |
|--------|--------|
| When EXIT context detected AND both CALLS_RE and PUTS_RE match: use KEEP_CALLS_RE/KEEP_PUTS_RE to infer which leg is being RETAINED, then set strategy to the OPPOSITE (the one being closed) | Fixes strangle-006 partial close strategy derivation |

---

## Proposed resolveStrangleExit() Sketch

```typescript
async function resolveStrangleExit(
  parse: ParseResult,
  ctx: OrchestratorContext,
): Promise<OrchestratorResult> {
  const symbol = parse.symbol!;
  const positions = await ctx.positions.getPositions(symbol);

  if (positions.length === 0) {
    return { outcome: 'MANUAL_REVIEW', reason: `no open positions for ${symbol}` };
  }

  // For each position, build a CLOSE (or TRIM) signal
  const signals: ResolvedSignal[] = [];
  for (const position of positions) {
    const legs = position.legs.map(leg =>
      buildReversalLeg(leg, symbol, parse.action === 'TRIM'
        ? Math.round(position.quantity * (parse.exitPercent ?? 0.5))
        : position.quantity)
    );
    signals.push({
      orderType: orderTypeFromLegs(legs),
      legs,
      tradeId: position.id,
      ...(parse.action === 'TRIM' && { exitPercent: parse.exitPercent ?? 0.5 }),
    });
  }

  return { outcome: 'EXECUTE', signals };
}
```

Routing in index.ts (insert between hard-skip check and existing strangle check):

```typescript
// Strangle/straddle EXIT: close all positions for symbol
if (parse.isStrangle && parse.action !== 'OPEN' && parse.action !== null) {
  log.debug(`[${ctx.messageId}] strangle exit → forking per-position close`);
  const r = await resolveStrangleExit(parse, ctx);
  logResult(ctx, parse, r);
  return r;
}

// Strangle/straddle OPEN (existing)
if (parse.isStrangle && (parse.action === 'OPEN' || parse.action === null)) {
  // ... existing resolveStrangle() call
}
```

---

## Priority Order

1. **EXIT_VERB_RE fix** (bare "close"): trivial regex fix, unblocks multiple cases
2. **isStrangle widening** (keyword+calls+puts): unblocks strangle-003
3. **resolveStrangleExit()** + routing: unblocks strangle-004, strangle-005
4. **Partial close strategy inference** (keep calls => close puts): unblocks strangle-006
