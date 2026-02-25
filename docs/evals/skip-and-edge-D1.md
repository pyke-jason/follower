# Skip Detection & Edge Case Analysis (D1)

Analysis of orchestrator eval failures related to skip detection and edge cases.

---

## core-001: Pure commentary routed to LLM, LLM fails

**Input**: `"A VWAP rejection here would give some good lotto opportunities"`
**Badges**: none | **Symbols**: none (no `data-symbol` in HTML) | **Expected**: SKIP | **Got**: MANUAL_REVIEW

### Trace through parser

1. `cleanText` = `"A VWAP rejection here would give some good lotto opportunities"` (from `htmlToCleanText`)
2. `badges` = `[]` (no `span.badge` in HTML)
3. `symbols` = `[]` (no `data-symbol` attribute in HTML)
4. Hard-skip checks: PAPER_TRADE_RE no, FUTURES_RE no, Long+Short combo no
5. `symbol` = `null` (symbols.length === 0)
6. `isLotto` = `true` (LOTTO_RE matches "lotto")
7. Strategy detection: `isLotto` is true -> `strategy = 'PUT'` (no CALLS_RE match)
8. Direction: `isLotto` is true -> `direction = 'LONG'`
9. Action: no Exit badge, no Long/Short badge -> falls to soft verb detection. No EXIT_VERB_RE, no BOUGHT_BUYING_RE, no WROTE_WRITING_RE -> `action = null`
10. ParseResult: `{ action: null, symbol: null, strategy: 'PUT', direction: 'LONG', isLotto: true, ... }`

In `resolveOrchestrator` (index.ts:80): `needsLLM = parse.complexityFlags.size > 0 || parse.action === null` -> `true` (action is null)

Routes to LLM path -> LLM does not call a decision tool -> MANUAL_REVIEW.

### Root cause

The parser detects "lotto" as a keyword and sets `strategy=PUT`, `direction=LONG`, but cannot determine `action` because there are no badges and no action verbs. With `action=null`, the message routes to the LLM. The LLM correctly identifies this as commentary but fails to call the decision tool.

### Proposed fix

**Add a hard-skip rule: if `action=null` AND `symbol=null`, skip immediately.** No symbol + no action verb + no badge = no actionable trade. The "lotto" keyword alone is not enough to constitute a trade signal without a ticker.

This should be checked after the current hard-skip block (parser.ts:228-241), before strategy detection. Alternatively, as a post-strategy check: if `symbol === null && action === null`, return `hardSkip('no symbol and no action')`.

The best placement is after the action block (line 368), as a final gate:

```
// No symbol + no action → definitely not a trade
if (symbol === null && action === null) {
  return hardSkip('no symbol and no action', complexityFlags);
}
```

**Risk**: None. A message without a symbol AND without an action verb/badge is never a trade signal. Even follow-trades ("following Dave") have `action=null` but they hit the `relational` complexity flag, so they would still route to LLM before this check (complexity flags are set before action determination).

Wait -- actually complexity flags don't bypass this check. Let me re-examine. The `relational` flag is set at line 249, but the hard-skip would be at ~line 368 after action determination. If both `symbol=null` and `action=null`, even with `relational` flag, the message has no ticker. Is a relational message without a symbol ever actionable? E.g., "following Dave" with no symbol -> would need LLM to look up what Dave traded. But without a symbol, we can't resolve anything.

**Revised proposal**: The check should be `symbol === null && action === null && !complexityFlags.has('relational')` to preserve the LLM path for relational messages. But honestly, even relational messages need some symbol to be actionable. I'd keep it simple: `symbol === null && action === null` -> hard skip.

---

## core-006: Monitoring existing position routed to LLM, LLM fails

**Input**: `"I have an AMZN lotto $227.50.$225 PCS that I am watching. For now all is good..."`
**Badges**: none | **Symbols**: `["AMZN"]` | **Expected**: SKIP | **Got**: MANUAL_REVIEW

### Trace through parser

1. `cleanText` = `"I have an AMZN lotto $227.50.$225 PCS that I am watching. For now all is good, but if the market sells off, I have to make sure the stock is stable. For now, it has been."`
2. `badges` = `[]`
3. `symbols` = `["AMZN"]`
4. Hard-skip checks: all fail
5. `symbol` = `"AMZN"`
6. `isLotto` = `true` ("lotto" matches LOTTO_RE)
7. Strategy: `isLotto` true AND no CALLS_RE in text... wait, "PCS" matches PCS_RE (line 276). Actually let me re-check priority. CDS_RE? No. PCS_RE? Yes, "PCS" is in text. So `strategy = 'PCS'` at line 277.

   Wait, order matters. CDS_RE (line 274) -> no. PCS_RE (line 276) -> YES ("PCS" in text). So strategy = `'PCS'`, not the lotto path. The else-if chain means PCS wins over LEAP and lotto.

8. Direction: `isLotto` is true -> `direction = 'LONG'` at line 303. But wait, PCS has no `directionFromStrategy` set. Let me trace: line 276-277 sets `strategy = 'PCS'` with no `directionFromStrategy`. Then direction derivation: `isLotto` at line 302 -> `direction = 'LONG'`.

9. Action: no Exit badge, no Long/Short badge -> soft detection. EXIT_VERB_RE? No ("watching" is not in the pattern). BOUGHT_BUYING_RE? No. WROTE_WRITING_RE? No. `action = null`.

10. `complexityFlags`: `extra_text` requires action !== null -> not set. `wordCount > 15`? The text is long but `action === null`. No flags.

11. ParseResult: `{ action: null, symbol: 'AMZN', strategy: 'PCS', direction: 'LONG', isLotto: true, ... }`

Routes to LLM (action=null) -> LLM fails -> MANUAL_REVIEW.

### Root cause

The parser has no mechanism to detect monitoring/watching verbs. The message has a symbol and a strategy keyword ("PCS"), but no action verb or badge. It correctly gets `action=null` and routes to LLM, but the LLM fails.

### Proposed fixes

**Option A: Add monitoring/watching verbs as skip indicators.** Add a pattern like:
```
const MONITORING_RE = /\b(watching|monitoring|holding|keeping an eye)\b/i;
```
If `MONITORING_RE` matches AND there is no action badge AND no action verb (bought/sold/wrote/exit), treat as skip.

But this is fragile. "Watching" could appear alongside action verbs: "Watching AMZN, sold puts." In that case we'd want to detect the "sold" verb, which the current parser does detect (SOLD_RE).

**Option B (better): Add "I have" / "I am holding" / "I am watching" as no-action indicators that reinforce the `action=null` -> skip path.** Rather than adding a hard skip, we could add a soft signal that, combined with `action=null`, tips the balance toward skip.

The cleanest fix for this specific case would actually be caught by the core-001 fix above IF we also require: "action=null + no badge + contains monitoring verb -> skip." But the simpler framing is: **the LLM path should handle this correctly.** The LLM failed to call a decision tool, which is the real bug. The parser correctly identified action=null and routed to LLM.

**Option C (pragmatic): Improve the LLM prompt to handle monitoring language better**, or add monitoring verbs as a parser-level soft skip. Specifically, if `action === null && no badges && MONITORING_RE.test(cleanText)`, return hardSkip.

But note: "I have an AMZN PCS that I am watching" is genuinely a monitoring statement. "I have" + "watching" with no action verb is safe to skip. However, "I have an AMZN PCS, sold half" would have `action=null` but EXIT_VERB_RE wouldn't match "sold half" either. Hmm, actually it wouldn't match because "sold" is caught earlier: SOLD_RE matches on line 320, but that's in the CALL/PUT direction derivation block, not in the action block. Let me re-check...

In the action block (line 362): `BOUGHT_BUYING_RE.test(cleanText)` and `SOLD_RE` is not checked there for action detection. Looking more carefully, the no-badge action detection (lines 352-367) checks:
- EXIT_VERB_RE for CLOSE/TRIM
- BOUGHT_BUYING_RE or "adding/opened" for OPEN
- WROTE_WRITING_RE for OPEN

`SOLD_RE` is NOT checked in the action block, so "Sold 10 puts on NVDA" with no badge would get `action=null`. But wait, regression-003 tests exactly this: "Sold 10 $180 Puts on NVDA" with no badges. Let me re-trace:

regression-003: No badges. Line 362: `BOUGHT_BUYING_RE.test("Sold 10 $180 Puts on NVDA...")` -> no. `/\b(adding|opened)\b/i` -> no. Line 365: `WROTE_WRITING_RE` -> no. So action=null?? But the expected outcome is EXECUTE.

Hmm, but SOLD_RE IS tested in direction derivation at line 320-322: `if (SOLD_RE.test(cleanText) && !hasExitBadge && !EXIT_VERB_RE.test(cleanText))` sets `direction = 'SHORT'`. But action stays null. So regression-003 would also route to LLM with action=null.

Actually wait -- let me re-check. For regression-003, `SOLD_RE` matches but there's no action-setting code for "sold" without a badge. The `SOLD_RE` on line 313 and 320 only affects direction, not action. So regression-003 must be relying on the LLM to succeed, which it apparently does (it's in regressions.json as expected EXECUTE).

So the difference is: for core-006, the LLM fails, but for regression-003, the LLM succeeds. The core-006 failure is really an LLM reliability issue for monitoring messages.

**Revised proposal**: Add "sold" as an action=OPEN trigger in the no-badge section (line 362 area). This would fix regression-003 deterministically. For core-006, add a monitoring verb check as a hard skip when `action=null && no badges`.

---

## core-007: "Feedback Request" badge not recognized

**Input**: `"Feedback Request GS PCS 880/875 @ 1.25 credit."`
**Badges**: `["Feedback Request"]` | **Symbols**: `["GS"]` | **Expected**: SKIP | **Got**: MANUAL_REVIEW "Premium mismatch"

### Trace through parser

1. `badges` = `["Feedback Request"]`
2. `hasExitBadge` = false, `hasLongBadge` = false, `hasShortBadge` = false
3. No hard-skip triggers
4. `symbol` = `"GS"`
5. Strategy: PCS_RE matches "PCS" -> `strategy = 'PCS'`
6. Direction: not isLotto, not STOCK, not CALL/PUT -> direction stays null (for PCS, `directionFromStrategy` was not set)
7. Action: no Exit badge, no Long/Short badge -> "Feedback Request" is not recognized. Falls to soft detection: no EXIT_VERB_RE, no BOUGHT_BUYING_RE, no WROTE_WRITING_RE -> `action = null`

Wait, but the "Got" says "Premium mismatch", not "LLM did not call a decision tool". Let me re-check.

Actually the badge "Feedback Request" doesn't match any of the three checked badges (Exit/Long/Short), so `action = null`. But `complexityFlags` -- could `extra_text` fire? No, action is null. So `needsLLM = true` (action is null).

But wait, the "Got" is "MANUAL_REVIEW Premium mismatch". That sounds like it went through the open-path and hit premium validation. How would it get there with `action=null`?

Possible explanation: The LLM was called, returned EXECUTE with action=OPEN for the PCS, then the signal was routed through open-path which did premium validation and found a mismatch (GS strike 880 is not a real strike price; GS trades around ~$600). So the LLM did call the decision tool here, but the downstream open-path failed on premium mismatch because the strikes/premium don't match real market data.

### Root cause

"Feedback Request" is a non-trade badge that the parser doesn't recognize. It should be treated as a hard skip. The parser only checks for "Exit", "Long", and "Short" badges. Any other badge (like "Feedback Request", "Question", "Education", "Update") is silently ignored, causing the message to route to LLM as if it had no badge at all.

### Proposed fix

**Add a non-trade badge skip list:**

```typescript
const NON_TRADE_BADGES = new Set([
  'Feedback Request',
  'Question',
  'Education',
  'Update',
]);

// In parseMessage(), after extracting badges:
if (badges.some(b => NON_TRADE_BADGES.has(b))) {
  return hardSkip(`non-trade badge: ${badges.join(', ')}`, complexityFlags);
}
```

**Open question**: What's the full set of non-trade badges? Need to query the DB:
```sql
SELECT DISTINCT json_each.value as badge, count(*)
FROM messages, json_each(messages.badges)
GROUP BY badge ORDER BY count(*) DESC;
```

This would reveal the full badge vocabulary and identify which ones are trade-related vs non-trade.

**Alternative (more defensive)**: Instead of an allowlist, use a blocklist. Only recognize Exit/Long/Short as trade badges; any OTHER badge present WITHOUT a trade badge -> hard skip. This is safer because new non-trade badges would automatically be skipped.

```typescript
const TRADE_BADGES = new Set(['Exit', 'Long', 'Short']);
const hasNonTradeBadge = badges.some(b => !TRADE_BADGES.has(b));
const hasTradeBadge = badges.some(b => TRADE_BADGES.has(b));
if (hasNonTradeBadge && !hasTradeBadge) {
  return hardSkip(`non-trade badge only: ${badges.join(', ')}`, complexityFlags);
}
```

This approach handles unknown future badges correctly.

---

## regression-005: LEAP with Short badge, market data gap

**Input**: `"Short SPY - added another 10 the leaps - total 60 - avg. $27.67 - 3/26 - $600"`
**Badges**: `["Short"]` | **Symbols**: `["SPY"]` | **Expected**: EXECUTE LONG CALL strike=600 | **Got**: MANUAL_REVIEW "No chain data for SPY 2026-09-25"

### Trace through parser

1. `cleanText` = `"Short SPY - added another 10 the leaps - total 60 - avg. $27.67 - 3/26 - $600"`
2. `badges` = `["Short"]`, `hasShortBadge` = true
3. `symbol` = `"SPY"`
4. `isLotto` = false (no "lotto"/"yolo" in text)
5. Strategy detection: CDS_RE? No. PCS_RE? No. PDS_RE? No. LEAP_RE? YES ("leaps" matches). -> `strategy = 'CALL'`, `directionFromStrategy = 'LONG'`
6. Direction: not isLotto, not STOCK, strategy is CALL -> `direction = 'LONG'` (line 316 default). BOUGHT_BUYING_RE? No. But wait, "added" matches `/\b(adding|opened)\b/i`? No, "added" is past tense, the regex looks for "adding" or "opened". Hmm, BOUGHT_BUYING_RE at line 323: `if (BOUGHT_BUYING_RE.test(cleanText)) direction = 'LONG'` -> "bought"/"buying" -> not present. WROTE_WRITING_RE? No. SOLD_RE? No. So direction stays `'LONG'` (the default for CALL).

7. Action: `hasShortBadge` = true -> line 348: `action = 'OPEN'`.

8. `extractExpiryHint`: LEAP_RE matches -> returns `'LEAP'` at line 184. This is checked FIRST, before `EXPIRY_SLASH_DATE_RE`.

9. Strikes: `extractStrikes` finds `$27.67` (from DOLLAR_STRIKE_RE), `$600` (from DOLLAR_STRIKE_RE). Also finds `3/26` from SLASH_PAIR_RE. Let me trace:
   - SLASH_PAIR_RE: `3/26` matches -> `s1=3, s2=26`. `looksLikeDate(3, 26)` -> true (3 is 1-12, 26 is 1-31). So `best=null`, `fallback=[3,26]`.
   - No more slash pairs. `best=null`, `fallback=[3,26]` -> returns `[3,26]`.

   Wait, but we also check STRIKE_NEAR_OPTION_RE and DOLLAR_STRIKE_RE. The function checks slash pairs first, and if `best` or `fallback` exist, returns early. So `strikes = [3, 26]`.

   Then at line 384-397, the slash-pair date disambiguation:
   - `strikes.length === 2`: yes
   - `looksLikeDate(3, 26)`: yes
   - `isSpread`: strategy is CALL, not CDS/PDS/PCS -> `isSpread = false`
   - So line 389: `strikes = null` (it's a date, not strikes)

   After nullifying, the function doesn't re-try DOLLAR_STRIKE_RE. So `strikes = null`.

10. `expiryHint = 'LEAP'` (from step 8)

11. Premium: PREMIUM_RE matches "$27.67" (from "avg. $27.67")? Let me check: `(?:for\s+\$?|at\s+\$?|\$)(\d{0,4}\.\d+|\d{1,4})` -> `$27.67` matches with capture `27.67`. And `$600` also matches. The regex returns the FIRST match. In the text, `$27.67` appears before `$600`, so `premiumHint = 27.67`.

   Then line 405: `premiumHint !== null && strikes !== null && strikes.includes(premiumHint)` -> strikes is null, so this check is skipped. `premiumHint = 27.67`.

12. ParseResult: `{ action: 'OPEN', symbol: 'SPY', strategy: 'CALL', direction: 'LONG', strikes: null, expiryHint: 'LEAP', premiumHint: 27.67, isLotto: false, ... }`

### In open-path:

1. Strategy is CALL, not a spread. Direction is LONG.
2. Expiry: `expiryHint = 'LEAP'` -> `resolveExpiryHint('LEAP', messageDate)` where messageDate is 2025-09-24.
   - `leapDate = 2026-09-24` (one year out)
   - `nextFriday(2026-09-24)`: Sep 24 2026 is a Thursday -> next Friday = Sep 25
   - `resolvedExpiry = '2026-09-25'`
3. `strikesFromParse`: strikes is null, isLotto is false, premiumHint is 27.67 -> `{ method: 'premium_match', statedPremium: 27.67 }`
4. resolvedExpiry is non-null, so goes to single-expiry path (line 668)
5. `buildLegsForExpiry('2026-09-25')` -> gets option chain for SPY 2026-09-25 CALL
6. Market data provider returns no chain data for that specific date -> error: "No chain data for SPY 2026-09-25"

### Root cause: TWO problems

**Problem 1: expiryHint priority.** `extractExpiryHint` checks LEAP_RE FIRST (line 184), before the slash date pattern. The text contains "3/26" which is an explicit March 26 date, but the LEAP match takes priority. The LEAP hint resolves to September 2026 (one year out), when the actual intent is March 2026.

The expected expiry is `3/26` (March 2026). But `LEAP_RE.test(text)` returns true and short-circuits to `'LEAP'`, never reaching the `EXPIRY_SLASH_DATE_RE` check.

**Problem 2: Strike extraction failure.** The `$600` strike is lost because `extractStrikes` returns the slash pair `[3, 26]` first, and after the date disambiguation nullifies it, the function doesn't fall through to DOLLAR_STRIKE_RE. So strikes ends up null, and strike selection falls back to `premium_match` using `$27.67` (which is actually the average cost, not the premium).

### Proposed fix for expiryHint

When BOTH an explicit date (slash/month-day) AND a LEAP keyword are present, prefer the explicit date. The "3/26" is more specific than "LEAP". Restructure `extractExpiryHint` to check explicit dates before LEAP:

```typescript
function extractExpiryHint(text: string, isLotto: boolean): string | null {
  // Check explicit dates FIRST — they override everything including LEAP
  const slashM = EXPIRY_SLASH_DATE_RE.exec(text);
  if (slashM) {
    const mo = parseInt(slashM[1], 10);
    const dy = parseInt(slashM[2], 10);
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) return slashM[0];
  }
  const mdM = EXPIRY_MONTH_DAY_RE.exec(text);
  if (mdM) return `${mdM[1]} ${mdM[2]}`;

  // Then keyword expiries
  if (LEAP_RE.test(text)) return 'LEAP';
  if (EXPIRY_0DTE_RE.test(text) || isLotto) return '0DTE';
  // ... rest
}
```

**But wait**: this conflicts with spread messages where `3/26` really is strikes. The disambiguation in `extractStrikes` handles that case (lines 384-397). But `extractExpiryHint` runs independently. We need coordination: if `3/26` is used as the expiry, it shouldn't also be used as strikes.

Currently the code already handles this somewhat: the slash-pair date disambiguation at line 390 checks `!expiryHint || expiryHint === \`${s1}/${s2}\`` -- if the expiryHint IS the same slash pair, it nullifies strikes. So the coordination exists.

The real question is: when text says "leaps" AND "3/26", should 3/26 be the expiry? In this specific case yes -- "the leaps" is describing what they own, and "3/26" is the explicit expiry date. A LEAP with an explicit date is just a long-dated option with a known expiry.

### Proposed fix for strikes

After `extractStrikes` nullifies a slash pair as date-like (line 389), the function should fall through to DOLLAR_STRIKE_RE. Currently it returns `null` immediately. Fix:

```typescript
if (looksLikeDate) {
  if (!isSpread) {
    strikes = null;  // it's a date, not strikes
    // FALL THROUGH to dollar-strike extraction below
  }
}
```

But this requires restructuring `extractStrikes` to not return early after finding the slash pair. The function returns the slash pair and the caller nullifies. After nullification at line 389, we'd need to re-run dollar-strike extraction. This could be done by calling a helper:

```typescript
if (strikes === null) {
  // Re-try dollar-prefixed strikes
  const dollarHits: number[] = [];
  // ... same logic as extractStrikes' dollar section
}
```

Or more elegantly, `extractStrikes` could return both the slash pair and dollar hits separately, and the caller picks.

---

## regression-007: CDS with "next week" expiry, partial pass (score 0.67)

**Input**: `"Long UNH cds for next week expiration"`
**Badges**: none | **Symbols**: `["UNH"]` | **Expected**: EXECUTE CDS with correct expiry | **Got**: EXECUTE but score 0.67

### Trace through parser

1. `cleanText` = `"Long UNH cds for next week expiration"`
2. `badges` = `[]`
3. `symbols` = `["UNH"]`
4. `strategy = 'CDS'` (CDS_RE matches "cds")
5. `direction`: CDS has no directionFromStrategy. isLotto: no. Not STOCK, not CALL/PUT. Falls through with `direction = null`.
6. Action: no badges. Soft detection: EXIT_VERB_RE? No. BOUGHT_BUYING_RE? No. `"Long"` doesn't match BOUGHT_BUYING_RE (`/\b(bought|buying)\b/i`). WROTE_WRITING_RE? No. `action = null`.

So `action = null` -> `needsLLM = true` -> routes to LLM.

Wait -- the `"Long"` prefix is just the word "Long" in text (no badge). The parser doesn't treat the word "Long" in cleanText as an action indicator. It only checks for specific verbs.

The LLM apparently returns EXECUTE and the signal goes through open-path. The test expects:
- `orderType: "SPREAD"` (mustMatch)
- `legs[0].optionType: "CALL"`

Score 0.67 means 2 of 3 scored fields matched. Let me check what's scored:
- Expected: `orderType: "SPREAD"` -> presumably matched
- Expected: `legs[0].optionType: "CALL"` -> one field

With `score = 0.67 = 2/3`, and `mustMatch: ["signals[0].orderType"]`, the mustMatch passed (otherwise it would be hardFail). So orderType matched.

The scorer scores: orderType (1 field), legs.count (1 field), and legs[0].optionType (1 field). That's 3 fields. If 2 matched, one failed. Which one? Probably `legs.count`: the expected has only 1 leg defined (just optionType=CALL), but a CDS spread has 2 legs. So `legs.count` expected=1 but actual=2.

Actually wait, let me re-read the expected:
```json
"legs": [{ "optionType": "CALL" }]
```
Only 1 expected leg defined. Scorer at line 232: `expectedSig.legs.length === actualLegs.length` -> `1 === 2` -> false. So legs.count fails.

Then legs[0].optionType: CALL vs actual CALL -> matched.

So scored fields: orderType=SPREAD (match), legs.count 1 vs 2 (fail), legs[0].optionType CALL (match) -> 2/3 = 0.67.

### Root cause

**The eval fixture has an incomplete expected value.** The expected `legs` array has only 1 leg, but a CDS spread has 2 legs (BUY lower CALL + SELL upper CALL). The fixture should specify both legs:

```json
"legs": [
  { "optionType": "CALL", "side": "BUY" },
  { "optionType": "CALL", "side": "SELL" }
]
```

Or alternatively, don't specify legs at all (just `orderType: "SPREAD"`), which would give a 1.0 score.

**Secondary issue**: `action=null` for a message with "Long" prefix and CDS keyword. "Long" is not a recognized action verb. The parser treats it only as a badge indicator, not a text indicator. This seems intentional per CLAUDE.md (badges are view, not direction for options), but "Long UNH cds" with no badge still needs an action. Adding "Long" as a soft OPEN indicator (similar to "adding"/"opened") would fix this deterministically.

Actually, the word "Long" in cleanText does appear because there's no badge span -- it's literally in the message text. Adding it as an action trigger would be wrong because badge text is sometimes included in cleanText (when there IS a badge). Wait, no -- `htmlToCleanText` does NOT remove badges from cleanText. Let me verify...

`htmlToCleanText` (html.ts:3-18) does: `$('body').text()` which includes ALL text content including badge spans. So if there IS a badge `<span class="badge">Long</span>`, the cleanText would include "Long" as a word. This means we can't reliably use "Long" as a text-based action indicator because it would also match badge text.

However, the parser receives both `cleanText` and `badges` separately. We could check: if `"Long"` or `"Short"` appears in text AND there are no badges, treat it as an OPEN action hint. But that's fragile.

**Better approach**: Just fix the fixture to expect 2 legs. The 0.67 score is an eval fixture problem, not a parser problem.

---

## direction-010: Covered call "lotto" context override

**Input**: `"Short HIMS lotto $41 call @ $.75. My net cost on the stock is $40.70 and if I am assigned..."`
**Badges**: `["Short"]` | **Symbols**: `["HIMS"]` | **Expected**: SELL CALL | **Got**: EXECUTE but hard fail on leg side (BUY instead of SELL)

### Trace through parser

1. `cleanText` = `"Short HIMS lotto $41 call @ $.75. My net cost on the stock is $40.70 and if I am assigned this will get me out for a $1.05 profit if it is called away from me. If not, my cost goes down to $40 and I can decide what I want to do after that. I am indifferent so I might as well collect some premium."`
2. `badges` = `["Short"]`, `hasShortBadge` = true
3. `isLotto` = true ("lotto" matches)
4. Strategy: CDS_RE? No. PCS_RE? No. PDS_RE? No. LEAP_RE? No. `isLotto = true` -> CALLS_RE matches "call" -> `strategy = 'CALL'`, `directionFromStrategy = 'LONG'`
5. Direction: `isLotto = true` -> line 302-303: `direction = 'LONG'` (lotto always overrides)
6. Action: `hasShortBadge = true` -> line 348: `action = 'OPEN'`
7. `wordCount > 15` AND `action !== null` AND `strategy !== null` -> `extra_text` flag is set
8. `complexityFlags = {'extra_text'}`

In `resolveOrchestrator`: `needsLLM = complexityFlags.size > 0` -> `true` (extra_text). Routes to LLM.

The LLM apparently calls EXECUTE but builds the leg as BUY (inheriting the lotto=LONG override). Expected is SELL.

### Root cause

This is the most nuanced case. The word "lotto" normally means speculative buy (LONG). The parser hardcodes `direction = 'LONG'` for all lotto messages at line 302-303, with no exceptions. But here, the context clearly indicates a covered call (selling a call against existing stock position for premium collection).

Key contextual clues that a human would catch:
- "My net cost on the stock is $40.70" -> owns the underlying stock
- "if I am assigned this will get me out" -> assignment = selling shares (covered call)
- "collect some premium" -> premium collection = selling options
- Short badge -> bearish/hedging view

The parser sets `extra_text` flag (wordCount > 15), which correctly routes to LLM. But two things go wrong:
1. The parser pre-sets `direction = 'LONG'` from the lotto override
2. The LLM prompt includes "Pre-parsed fields: direction=LONG" which biases the LLM
3. The LLM either trusts the pre-parsed direction or independently decides lotto=LONG

### Proposed fix

**Option A: Conditional lotto override.** Only apply the lotto=LONG override when there are no contrary signals. If any of these are present, leave direction as null for LLM resolution:
- "collect premium" / "premium collection"
- "assigned" / "called away"
- "covered call" / "writing calls"

This is fragile -- it tries to enumerate all covered-call language.

**Option B: Don't pre-set direction for lotto when extra_text flag fires.** If the message has significant extra text, the lotto keyword alone isn't sufficient to determine direction. Leave it for the LLM.

But the extra_text flag is set AFTER direction determination in the parser. We'd need to restructure, or add a post-hoc override:

```typescript
// At the end of parseMessage, before return:
if (isLotto && complexityFlags.has('extra_text')) {
  // Lotto with extra context -- direction might be overridden by context
  // Leave for LLM rather than hardcoding LONG
  direction = null;
}
```

This is the cleanest approach but it means all lotto messages with extra text lose the deterministic LONG override. Most lotto messages are short ("Short MSTR Lotto $177.5 puts .46"), so this would rarely fire incorrectly.

**Option C (recommended): Narrow the lotto override to only fire when "sold"/"wrote"/"writing"/"collect premium" are NOT present.** This is a targeted exception:

```typescript
if (isLotto) {
  const hasSellContext = SOLD_RE.test(cleanText) ||
    WROTE_WRITING_RE.test(cleanText) ||
    /\bcollect\w*\s+premium\b/i.test(cleanText);
  if (!hasSellContext) {
    direction = 'LONG';
  }
  // else: leave direction for downstream resolution
}
```

In this specific case, `SOLD_RE` doesn't match (no "sold" in text), `WROTE_WRITING_RE` doesn't match, but "collect some premium" would match `/\bcollect\w*\s+premium\b/i`. This narrows the exception to covered-call language.

**However**, the eval notes say this is "LLM-dependent" and tagged `llm-dependent`. This implies the expectation is that the LLM should solve it, not the parser. The real fix is to ensure the LLM path doesn't blindly trust the pre-parsed `direction=LONG` when context says otherwise. The LLM prompt says "Pre-parsed fields: direction=LONG" which is misleading. Perhaps the LLM prompt should note that pre-parsed direction is a default that can be overridden by context.

---

## Summary of Proposed Fixes

| Case | Root Cause | Fix | Effort |
|------|-----------|-----|--------|
| core-001 | No symbol + no action + no badge -> routes to LLM unnecessarily | Add hard skip: `symbol===null && action===null` -> skip | Small |
| core-006 | Monitoring verb not detected, routes to LLM | Either fix LLM reliability, or add monitoring-verb skip when `action===null && no badges` | Small-Medium |
| core-007 | "Feedback Request" badge not in trade-badge set | Add non-trade badge skip (whitelist approach: only Exit/Long/Short are trade badges) | Small |
| regression-005 | LEAP keyword takes priority over explicit "3/26" date in expiryHint; dollar-strikes lost after slash-pair nullification | Reorder expiryHint to prefer explicit dates over LEAP; fix extractStrikes to fall through to dollar-strikes after nullification | Medium |
| regression-007 | Score 0.67 is a fixture bug (expects 1 leg, CDS has 2) | Fix the fixture to include 2 expected legs | Trivial |
| direction-010 | Lotto=LONG override too aggressive for covered calls | Either: (a) don't preset direction when extra_text fires, or (b) add sell-context exception to lotto override, or (c) fix LLM prompt to not blindly trust pre-parsed direction | Medium (LLM-dependent by design) |

### Cross-cutting observation

The parser's `action=null` path (line 352-367) is missing a `SOLD_RE` check for the no-badge case. Currently, "Sold 10 $180 Puts on NVDA" (regression-003) goes to LLM because `action=null`. Adding SOLD_RE (with appropriate exit-verb exclusion) to the no-badge action block would make this deterministic and avoid LLM dependency for an unambiguous signal.

### Related fix: Add "added" (past tense) to action detection

The regex at line 362 checks for `adding` and `opened` but not `added`. Several messages use "added" ("added another 10 the leaps"). Adding `added` to the pattern would route these deterministically:

```typescript
} else if (BOUGHT_BUYING_RE.test(cleanText) || /\b(adding|added|opened)\b/i.test(cleanText)) {
```
