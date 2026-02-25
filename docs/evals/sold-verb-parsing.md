# Sold-Verb Parsing + Strike/Premium Confusion + Missing Patterns

## Overview

This analysis covers eval failures from direction-001/002/004/006/007/011 and regression-001/003. All share a common theme: "sold" verb messages where the parser correctly identifies direction=SHORT but downstream resolution fails due to premium validation, missing option type patterns, or unrecognized expiry hints.

---

## Case-by-Case Trace

### direction-001 / regression-001 — HUT "sold the 12/19 $36 puts for a credit of $0.88/contract"

**Input**: cleanText = `"Long HUT sold the 12/19 $36 puts for a credit of $0.88/contract"`
badges = `["Long"]`, symbols = `["HUT"]`

**Parser trace**:
1. Strategy: `PUTS_RE` matches "puts", `SPREAD_KW_RE` does not match → `strategy = 'PUT'`, `directionFromStrategy = 'LONG'`
2. Direction: strategy is PUT → enters line 314 block. Sets `direction = 'LONG'`. Then `SOLD_RE` matches "sold", no exit badge, no EXIT_VERB_RE match → `direction = 'SHORT'`. Then `BOUGHT_BUYING_RE` doesn't match. **Final direction = 'SHORT'.** Correct.
3. Action: `hasLongBadge = true` → `action = 'OPEN'`
4. Strikes: `extractStrikes("Long HUT sold the 12/19 $36 puts for a credit of $0.88/contract")`:
   - SLASH_PAIR_RE: no slash pairs
   - STRIKE_NEAR_OPTION_RE: `/\$?(\d{2,5}(?:\.\d+)?)\s*(?:calls?|puts?|[cp]\b)/i` — matches `"$36 puts"` → captures `36`. Strikes = `[36]`.
5. Expiry: `EXPIRY_SLASH_DATE_RE` matches `"12/19"` → mo=12, dy=19 → valid → expiryHint = `"12/19"`.
6. Premium: PREMIUM_RE on `"for a credit of $0.88/contract"`:
   - Matching: `\$` matches `$0.88` → group 1 captures `"0.88"`. But wait — there's also `$36` earlier. PREMIUM_RE uses `exec` (first match). The regex tries from the start. Let me trace: `(?:for\s+\$?|at\s+\$?|\$)` — first `\$` in the string is `$36` → captures `36` from group 1 (`\d{0,4}\.\d+|\d{1,4}` matches `36`). **premiumHint = 36.**

   **BUG**: The first `$` match in PREMIUM_RE hits `$36` (the strike price), not `$0.88` (the actual premium). The premium extraction greedily takes the first dollar-prefixed number.

   Wait — let me re-read PREMIUM_RE more carefully:
   ```
   /(?:for\s+\$?|at\s+\$?|\$)(\d{0,4}\.\d+|\d{1,4})(?:\s*(?:credit|debit|cr|db))?|(\d{0,4}\.\d+|\d{1,4})\s+(?:credit|debit|cr|db)/i
   ```
   The first alternative tries `for\s+\$?` first. Does "for a credit" match `for\s+\$?`? No — "for a" has "a" not "$" after "for ". So `for\s+\$?` doesn't match "for a".

   Next try: `at\s+\$?` — not present at start.

   Next try: `\$` — matches `$36`. Group 1: `(\d{0,4}\.\d+|\d{1,4})` tries `\d{0,4}\.\d+` first (requires decimal point) — `36` has no decimal → fails. Then `\d{1,4}` matches `36`. **premiumHint = 36.**

   This is then checked at parser.ts line 405: `if (premiumHint !== null && strikes !== null && strikes.includes(premiumHint))` — strikes = [36], premiumHint = 36. **Match! premiumHint is nulled out.** Good — the collision is caught.

   But PREMIUM_RE only runs once (single `exec`). After nulling premiumHint, we lose the actual premium of $0.88. This is acceptable — the important thing is premiumHint doesn't cause a false premium_mismatch.

7. **strikesFromParse**: strikes=[36] → method='explicit', strikes=[36].

8. **open-path**: direction='SHORT', strategy='PUT', symbol='HUT'.
   - Not a spread strategy → direction check passes (SHORT is set).
   - Resolves expiry from "12/19" → 2025-12-19.
   - `buildLegsForExpiry`: explicit strikes, not spread → single PUT leg, `side = direction === 'LONG' ? 'BUY' : 'SELL'` → side = 'SELL'. Correct.
   - Premium validation: `premiumHint = null` (was nulled), so premium validation is skipped.
   - Returns EXECUTE with `{ side: 'SELL', strike: 36, optionType: 'PUT' }`.

**Verdict**: **Should PASS.** The parser correctly handles this case. The strike-premium collision is resolved at line 405. Direction SHORT is correct. Side SELL is correct.

**If this case is failing**, the issue would be in market data resolution — perhaps `getOptionChain` for HUT on 2025-12-19 PUT fails or doesn't return data, causing an error in `buildLegsForExpiry`. But the code trace shows explicit strikes bypass the chain lookup entirely (open-path.ts line 426-457). So it should work.

Actually, re-reading more carefully: for `strikeSelection.method === 'explicit'` AND not a spread strategy (line 443-457), the code builds the leg directly without any market data call. This should succeed.

**Conclusion**: direction-001 / regression-001 should pass based on code analysis. If they're failing in actual evals, the failure is likely from the market data provider or test harness, not the parser/open-path logic.

---

### direction-002 — BMNR "Sold Dec (19) $32.50 puts @ $1.14"

**Input**: cleanText = `"Long Sold BMNR Dec (19) $32.50 puts @ $1.14. That would make me long stock < AVWAPE if I am assigned. That would generate a 7% return in 10 days if it expires"`
badges = `["Long"]`, symbols = `["BMNR"]`

**Parser trace**:
1. Strategy: `PUTS_RE` matches "puts" → `strategy = 'PUT'`, `directionFromStrategy = 'LONG'`
2. Direction: PUT → `direction = 'LONG'`, then `SOLD_RE` → `direction = 'SHORT'`. Correct.
3. Action: Long badge → `action = 'OPEN'`
4. Strikes: STRIKE_NEAR_OPTION_RE: `$32.50 puts` → strike 32.5. Strikes = [32.5].
5. Expiry: EXPIRY_MONTH_DAY_RE: `Dec` + `19` in `"Dec (19)"` — does the regex handle parentheses? `EXPIRY_MONTH_DAY_RE = /\b(jan|...)\s*\(?\s*(\d{1,2})\s*\)?/i` — yes, the `\(?` and `\)?` handle optional parens. Matches → expiryHint = `"Dec 19"`.
6. Premium: PREMIUM_RE — first `$` is `$32.50` → captures `32.50`. But strikes=[32.5], and 32.5 === 32.50? Actually premiumHint would be `32.5` (parseFloat). strikes.includes(32.5) → true. **premiumHint nulled.** Good.

   Then `$1.14` is never reached by PREMIUM_RE (single exec). But the `@` prefix doesn't match any PREMIUM_RE trigger. Actually wait: `at\s+\$?` — `"@ $1.14"` — `@` is not `at`. So this wouldn't match anyway.

   Actually, re-examining: `"@ $1.14"` — the `\$` alternative would match `$1.14` if PREMIUM_RE hadn't already consumed its one match on `$32.50`. Since exec returns only the first match, $1.14 is never found.

   **premiumHint = null** after collision resolution. Premium validation skipped.

7. wordCount > 15 with action and strategy set → `extra_text` complexity flag added.

8. **Orchestrator**: `needsLLM = true` (extra_text flag). Goes to LLM path.

**Root cause of potential failure**: The `extra_text` flag (word count > 15) forces LLM path even though the parser has everything it needs. The LLM then processes it, and depending on the LLM's response, it may or may not produce the correct signal.

**Fix**: The `extra_text` flag threshold is too aggressive. Consider: if all essential fields are resolved (action, symbol, strategy, direction, strikes, expiry) and the extra text doesn't contain conflicting trade signals, skip the LLM. The extra text here is just educational commentary.

---

### direction-004 — EOSE "Sold Dec (26) $13.50 puts @ $.55"

**Input**: cleanText = `"Long EOSE Sold Dec (26) $13.50 puts @ $.55. Would I buy the stock at $12.95? Yup. ..."` (long commentary)
badges = `["Long"]`, symbols = `["EOSE"]`

Same pattern as direction-002:
1. Strategy: PUT. Direction: SHORT (sold verb). Correct.
2. Strikes: `$13.50 puts` → [13.5].
3. Premium: `$13.50` matched first by PREMIUM_RE → 13.5. Collision with strikes → nulled. Good.
4. Expiry: `"Dec (26)"` → `"Dec 26"`. Good.
5. **extra_text flag** (very long commentary) → LLM path.

**Same issue as direction-002**: extra_text flag unnecessarily routes to LLM.

---

### direction-006 — IREN "sold the 12/19 $40 puts for a credit of $1.15/contract"

**Input**: cleanText = `"Long IREN sold the 12/19 $40 puts for a credit of $1.15/contract"`
badges = `["Long"]`, symbols = `["IREN"]`

1. Strategy: PUT. Direction: SHORT. Correct.
2. Strikes: STRIKE_NEAR_OPTION_RE: `$40 puts` → [40].
3. Expiry: `12/19` → expiryHint = "12/19".
4. Premium: `$40` matched by PREMIUM_RE → 40. Collision with strikes[40] → nulled. `$1.15` never reached.
5. Word count: `"Long IREN sold the 12/19 $40 puts for a credit of $1.15/contract"` = 13 words. Under 15. **No extra_text flag.**
6. Action: Long badge → OPEN.
7. **Goes to open-path deterministically.**

**This should work correctly.** If failing, it's a market data issue (chain lookup for IREN 12/19 PUT at strike 40).

---

### direction-007 — HUT "$34 P Sold 12/19/25 at 0.81"

**Input**: cleanText = `"Long HUT $34 P Sold 12/19/25 at 0.81. Going bit deeper ITM to be below the 100-SMA line."`
badges = `["Long"]`, symbols = `["HUT"]`

**Parser trace**:
1. Strategy detection:
   - CDS, PCS, PDS, LEAP, LOTTO, STOCK: all no.
   - `CALLS_RE = /\bcalls?\b/i` — no match.
   - `PUTS_RE = /\bputs?\b/i` — does `"P"` match? The regex is `\bputs?\b` which matches "put" or "puts" (word boundary, s optional). A standalone `"P"` does NOT match `\bputs?\b`. **Strategy = null.**

2. Direction: No strategy matched → directionFromStrategy = null → direction = null.

3. Action: Long badge → `action = 'OPEN'`.

4. Strikes:
   - SLASH_PAIR_RE: no slash pairs in `"$34 P Sold 12/19/25 at 0.81"`. Wait — `12/19` might match? Let me check: `"12/19/25"` — SLASH_PAIR_RE = `/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/`. This matches `12/19`. Then `pairRe` (global) also tries `19/25` on the next iteration. So we get `[12, 19]` and `[19, 25]` as potential slash pairs.
   - `looksLikeDate(12, 19)`: 12 >= 1 && 12 <= 12 && 19 >= 1 && 19 <= 31 → true → date-like → set as fallback.
   - `looksLikeDate(19, 25)`: 19 > 12 → false → `best = [19, 25]`.
   - Strikes = `[19, 25]`. **WRONG** — these are from the date "12/19/25", not strike prices!

   Actually wait, let me re-check. The regex is applied globally to the full cleanText. The text is `"Long HUT $34 P Sold 12/19/25 at 0.81. Going bit deeper ITM to be below the 100-SMA line."`.

   First match: `12/19` → s1=12, s2=19. `looksLikeDate(12, 19)` → true → fallback.
   Second match (continuing from index): after `12/19`, the regex restarts. The remaining text has `/25` but the regex needs `(\d+)\s*/\s*(\d+)` — the `/25` is preceded by `19` which was already consumed. Actually no — global regex re-matches from the lastIndex. After matching `12/19`, lastIndex is at the position after `19`. The next text is `/25 at 0.81...`. The regex `(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)` requires digits before the slash. Position after `19` has `/25` — no digits before `/`. So no second match.

   So only `[12, 19]` is found as slash pair → date-like → `fallback = [12, 19]`. No `best` found.

   After the while loop: `best` is null, so check `fallback = [12, 19]`. Strikes = `[12, 19]`.

   Then line 384-397 disambiguates: `isSpread = false` (strategy is null). `!isSpread` → strikes = null (it's a date).

   STRIKE_NEAR_OPTION_RE: `$34 P` — the regex is `/\$?(\d{2,5}(?:\.\d+)?)\s*(?:calls?|puts?|[cp]\b)/i`. Does `$34 P` match? `\$?` matches `$`, `(\d{2,5})` matches `34`, `\s*` matches space, `(?:calls?|puts?|[cp]\b)` — `P` matches `[cp]\b` (case insensitive, `p` matches, followed by word boundary since next char is space). **Yes! Strikes = [34].**

   Wait — but this is only reached if the slash pair extraction returned null. Let me re-trace: after the slash pair loop, `best = null`, `fallback = [12, 19]`. Line 157: `if (best) return best` → no. Line 158: `if (fallback) return fallback` → returns `[12, 19]`.

   So extractStrikes returns `[12, 19]`, NOT [34]. Then the date disambiguation at line 384 nulls it out (not a spread, looks like date). Then strikes = null.

   **But extractStrikes already returned**, so we never reach the STRIKE_NEAR_OPTION_RE branch inside extractStrikes. The function returns the fallback `[12, 19]` before trying single-strike detection.

   After disambiguation: strikes = null.

5. Expiry: `EXPIRY_SLASH_DATE_RE` matches `"12/19"` from `"12/19/25"` → mo=12, dy=19, year=25 → year = 2025. expiryHint = `"12/19/25"`.

   Actually looking more carefully: `EXPIRY_SLASH_DATE_RE = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/`. On `"12/19/25"`: group1=12, group2=19, group3=25. So expiryHint = `"12/19/25"` (the full match `slashM[0]`).

6. Premium: PREMIUM_RE on the text. The `\$` path matches `$34` first → group1 tries `\d{0,4}\.\d+` (no decimal in 34) → tries `\d{1,4}` → 34. premiumHint = 34.

   Collision check: strikes is null at this point (was nulled by disambiguation). So `strikes.includes(34)` can't run (strikes is null). **premiumHint = 34. WRONG** — 34 is the strike, not the premium.

   Wait, actually: the premium extraction runs at line 401 AFTER strike disambiguation. By that point strikes = null. So the collision check at line 405 (`premiumHint !== null && strikes !== null && strikes.includes(premiumHint)`) — strikes is null → condition is false → premiumHint stays 34.

   **BUG**: The $34 strike is misidentified as premium because the strike extraction failed (the actual $34 strike was inside a slash-pair fallback that got discarded as a date).

7. strikesFromParse: strikes=null, isLotto=false, premiumHint=34 → method='premium_match', statedPremium=34.

8. **Orchestrator**: action=OPEN, strategy=null → `needsLLM = true` (action is OPEN but strategy is null).

   Wait: line 80: `needsLLM = parse.complexityFlags.size > 0 || parse.action === null`. action is OPEN (not null). But wait — line 83: `if (parse.action === 'OPEN')` — this goes to open-path. But strategy is null. open-path line 347-349: `if (!parse.strategy) return MANUAL_REVIEW`.

   Actually let me re-check: needsLLM = complexityFlags.size > 0 || action === null. Word count for `"Long HUT $34 P Sold 12/19/25 at 0.81. Going bit deeper ITM to be below the 100-SMA line."` = 18 words. Action is OPEN, strategy is null. At line 411: `wordCount > 15` but action and strategy must both be non-null for extra_text. Strategy is null → no extra_text flag. complexityFlags is empty. action is OPEN (not null). **needsLLM = false.**

   Goes to open-path. Strategy is null → returns MANUAL_REVIEW.

**Root causes for direction-007**:
1. **`PUTS_RE` doesn't match bare `"P"`**: The regex `/\bputs?\b/i` requires at least "put". A single `"P"` abbreviation fails.
2. **Strike extraction fallback eats the date**: `extractStrikes` returns `[12, 19]` from the date `12/19/25`, preventing the single-strike `$34 P` from being found via STRIKE_NEAR_OPTION_RE.
3. **$34 misidentified as premium**: After strikes are nulled, $34 is picked up by PREMIUM_RE as the stated premium.

**Proposed fixes**:
1. Add `\bp\b` to PUTS_RE: `/\bputs?\b|\bp\b/i` — but this is dangerously broad (matches any standalone "P"). Better: add to STRIKE_NEAR_OPTION_RE pattern: `/\$?(\d{2,5}(?:\.\d+)?)\s*(?:calls?|puts?|[cp]\b)/i` — this already handles `[cp]\b`. The issue is that extractStrikes processes slash-pair fallbacks BEFORE single-strike patterns.

   **Better fix**: In extractStrikes, when a slash-pair fallback looks like a date, don't return it as strikes — try the single-strike patterns first. Restructure extractStrikes to only use the date-like fallback as a last resort.

2. For strategy detection, add `\bp\b` as a puts synonym with more context: `\b\$\d+(?:\.\d+)?\s+p\b` (dollar amount followed by standalone P).

---

### direction-011 / regression-003 — NVDA "Sold 10 $180 Puts for $1.80 - expiring tomorrow"

**Input**: cleanText = `"Sold 10 $180 Puts on NVDA for $1.80 - expiring tomorrow"`
badges = `[]` (no badges), symbols = `["NVDA"]`

**Parser trace**:
1. Strategy: `PUTS_RE` matches "Puts" → `strategy = 'PUT'`, `directionFromStrategy = 'LONG'`
2. Direction: PUT → `direction = 'LONG'`, then `SOLD_RE` matches "Sold", no exit badge → `direction = 'SHORT'`. Correct.
3. Action: No badges. No hasExitBadge, hasLongBadge, hasShortBadge.
   - Line 353: EXIT_VERB_RE matches? `"Sold"` — EXIT_VERB_RE = `/\b(exit|clos|exiting|took profits?|stopped out|sold out)\b/i`. "Sold" alone doesn't match (it's "sold out" that matches, not "sold"). So no.
   - Line 362: `BOUGHT_BUYING_RE.test(...)` = false. `"adding|opened"` = false.
   - Line 364: `WROTE_WRITING_RE.test(...)` = false.
   - **action = null.**

   Wait, that's wrong. `SOLD_RE` matches at line 320 for direction, but for action detection (lines 352-367) there's no "sold" → OPEN rule. The code only has:
   - Exit verbs → CLOSE/TRIM
   - bought/buying/adding/opened → OPEN
   - wrote/writing → OPEN

   **"sold" is missing from the OPEN action detection.** "Sold" as a sell-to-open verb should trigger action=OPEN, but the parser doesn't have this mapping.

4. Strikes: STRIKE_NEAR_OPTION_RE: `$180 Puts` → [180].
5. Expiry: `"expiring tomorrow"` — none of the expiry patterns match "tomorrow". EXPIRY_0DTE_RE, overnight, next friday, etc. — no "tomorrow" pattern. **expiryHint = null.**
6. Premium: PREMIUM_RE: "for $1.80" matches via `for\s+\$` → captures "1.80" → premiumHint = 1.80. Collision check: strikes=[180], premiumHint=1.80, 180 !== 1.80 → no collision. premiumHint = 1.80.

7. **Orchestrator**: `needsLLM = true` (action=null). Goes to LLM path.

**Root causes**:
1. **"sold" not mapped to action=OPEN**: The parser detects "sold" for direction override but doesn't use it for action inference. When there's no badge, `action` stays null.
2. **"tomorrow" not handled by expiry extraction**: No pattern for "tomorrow" or "expiring tomorrow".

**Proposed fixes**:
1. Add to action detection (after line 367 or in the no-badge block around line 362):
   ```typescript
   if (SOLD_RE.test(cleanText) && !hasExitBadge && !EXIT_VERB_RE.test(cleanText)) {
     action = 'OPEN';
   }
   ```
2. Add to expiry patterns:
   ```typescript
   const EXPIRY_TOMORROW_RE = /\btomorrow\b/i;
   ```
   And in `extractExpiryHint`:
   ```typescript
   if (EXPIRY_TOMORROW_RE.test(text)) return 'tomorrow';
   ```
   And in `resolveExpiryHint`:
   ```typescript
   if (normalized === 'tomorrow') {
     return dateToYMD(addBusinessDays(messageDate, 1));
   }
   ```
   Note: "tomorrow" and "overnight" resolve to the same date (next business day). Could alias them, but keeping separate is clearer semantically.

---

## Cross-Cutting Issues

### Issue 1: PREMIUM_RE matches strike prices

PREMIUM_RE's `\$` alternative matches any dollar-prefixed number. In messages like `"$36 puts for a credit of $0.88"`, it matches `$36` first. The collision check (line 405) catches this when strikes are also populated, but:

- If strike extraction fails (direction-007), the collision check doesn't fire and the strike becomes the premium.
- PREMIUM_RE only does one `exec`, so the actual premium ($0.88) is lost.

**Fix options**:
a. Run PREMIUM_RE with global flag and prefer matches near credit/debit keywords over bare `$` matches.
b. Skip PREMIUM_RE matches that are adjacent to option type keywords (puts/calls/p/c).
c. Run PREMIUM_RE only on the text AFTER the option type keyword.

### Issue 2: extra_text flag is too sensitive

Any message with >15 words + action + strategy set gets `extra_text`, routing to LLM even when all fields are resolved. This affects direction-002, direction-004 (and many other Pete messages with educational commentary).

**Fix**: Don't set extra_text when all core fields (action, symbol, strategy, direction, strikes or premiumHint) are resolved. The extra text is commentary, not contradictory trade information.

### Issue 3: No-badge "sold" → action=null

"Sold" is a clear sell-to-open verb but the action detection block (lines 352-367) doesn't have a path for it. The direction derivation block correctly uses "sold" for direction=SHORT, but the action block treats it as unknown.

**Fix**: Add SOLD_RE to the no-badge action detection, with the same guards (not exit badge, not exit verb pattern like "sold out"):
```typescript
} else if (SOLD_RE.test(cleanText) && !EXIT_VERB_RE.test(cleanText)) {
  action = 'OPEN';
}
```

### Issue 4: "tomorrow" expiry hint missing

`resolveExpiryHint` handles: 0DTE, LEAP, overnight, next friday, this week, next week, slash dates, month+day, bare month. Missing: "tomorrow", "expiring tomorrow".

**Fix**: Add `tomorrow` → `addBusinessDays(messageDate, 1)` (same as "overnight").

### Issue 5: Bare "P" / "C" abbreviation not matched by PUTS_RE / CALLS_RE

`PUTS_RE = /\bputs?\b/i` requires at least "put". Real messages use `"$34 P"` (direction-007). The `STRIKE_NEAR_OPTION_RE` already handles `[cp]\b` for strike extraction, but `PUTS_RE`/`CALLS_RE` don't handle bare P/C for strategy detection.

**Fix**: Expand PUTS_RE and CALLS_RE:
```typescript
// Old:
const CALLS_RE = /\bcalls?\b/i;
const PUTS_RE = /\bputs?\b/i;

// New:
const CALLS_RE = /\bcalls?\b|\bc\b(?=\s|$)/i;
const PUTS_RE = /\bputs?\b|\bp\b(?=\s|$)/i;
```

But bare `\bp\b` is risky (matches "P" in "P&L", etc.). Safer: only match when preceded by `$strike`:
```typescript
const BARE_PUT_RE = /\$\d+(?:\.\d+)?\s+p\b/i;
const BARE_CALL_RE = /\$\d+(?:\.\d+)?\s+c\b/i;
```
Then in strategy detection:
```typescript
} else if ((PUTS_RE.test(cleanText) || BARE_PUT_RE.test(cleanText)) && !SPREAD_KW_RE.test(cleanText)) {
  strategy = 'PUT';
  directionFromStrategy = 'LONG';
}
```

---

## Summary Table

| Case | Parser Output | Downstream Failure | Root Cause |
|---|---|---|---|
| direction-001 | Correct (SHORT PUT, strike=36) | Should pass | (verify market data) |
| direction-002 | Correct (SHORT PUT, strike=32.5) | extra_text → LLM | extra_text threshold too aggressive |
| direction-004 | Correct (SHORT PUT, strike=13.5) | extra_text → LLM | extra_text threshold too aggressive |
| direction-006 | Correct (SHORT PUT, strike=40) | Should pass | (verify market data) |
| direction-007 | strategy=null, strikes=null, premium=34 | MANUAL_REVIEW | (1) "P" not matched by PUTS_RE, (2) date fallback prevents strike extraction, (3) $34 becomes premium |
| direction-011 | action=null, direction=SHORT, strategy=PUT | LLM path (action=null) | (1) "sold" not mapped to OPEN action, (2) "tomorrow" missing from expiry patterns |
| regression-001 | Same as direction-001 | Should pass | Same trace |
| regression-003 | Same as direction-011 | LLM path (action=null) | Same trace |

## Priority Fixes

1. **HIGH**: Add "sold" (non-exit) to action=OPEN inference in no-badge block
2. **HIGH**: Add "tomorrow" to expiry hint extraction and resolution
3. **HIGH**: Fix extractStrikes to not return date-like fallback when single-strike pattern would match (direction-007)
4. **MEDIUM**: Add bare P/C abbreviation detection for strategy (with safe context like `$strike P`)
5. **MEDIUM**: Make extra_text flag conditional on having unresolved fields
6. **LOW**: Improve PREMIUM_RE to prefer credit/debit-adjacent matches over bare `$` matches
