# Skip Detection & Edge Cases Analysis (D2)

Analysis of 6 failing orchestrator eval cases related to skip detection, expiry edge cases,
and the lotto-covered-call conflict.

---

## core-001: Commentary about "lotto opportunities" (no symbol, no verb)

**Input**: `"A VWAP rejection here would give some good lotto opportunities"`
**Expected**: SKIP
**Actual route**: `action=null` (no badge, no action verb), `symbols=[]` (no `data-symbol` in HTML), `strategy=null` (LOTTO_RE matches but no CALLS/PUTS keyword), then `isLotto=true` triggers strategy detection at line 283: `strategy = CALLS_RE.test(cleanText) ? 'CALL' : 'PUT'` -> falls through to `PUT` (default). But `symbol=null`. So parse produces `action=null, symbol=null, strategy=PUT, direction=LONG, isLotto=true`.

**Routing**: `needsLLM = (complexityFlags.size > 0 || action === null)` -> `action=null` -> routes to LLM path. LLM must classify as IGNORE/SKIP.

**Failure mechanism**: The LLM path is invoked but the LLM fails to correctly classify this as non-trade commentary. It sees `isLotto=true, strategy=PUT, direction=LONG` in pre-parsed fields, which biases it toward EXECUTE.

**Root cause**: The parser pre-fills `strategy=PUT, direction=LONG, isLotto=true` for a message that is purely commentary. These pre-parsed fields leak into the LLM prompt via `buildNLUPrompt()` (line 166-171 of llm-path.ts), biasing the LLM toward EXECUTE.

**Fix options**:

1. **Hard-skip: no symbol + no action -> SKIP** (parser level)
   - Add check: `if (symbols.length === 0 && action === null) return hardSkip('no symbol, no action', ...)`.
   - Risk: "AAPL looking good" has a symbol but no action. That would NOT be caught by this rule -> still routes to LLM (correct, since it might be "AAPL looking good, bought calls" in a longer message).
   - Messages with no `data-symbol` link AND no action verb are almost never actionable. This is safe.

2. **Don't populate strategy/direction when action=null** (parser level)
   - If we can't even tell what action this is, pre-filling strategy/direction is premature. It only makes sense to fill these when we at least know it's OPEN.
   - This prevents the LLM from being biased by phantom pre-parsed fields.

**Recommendation**: Do BOTH. (1) is a cheap optimization that prevents the LLM call entirely. (2) prevents strategy/direction leaking into the LLM prompt when the parser has no action confidence. Both are safe and complementary.

**False positive risk for (1)**: Very low. The `symbols` array comes from `data-symbol` attributes in HTML links -- these are structurally embedded by the Discord platform. Messages without them genuinely reference no ticker. Even "AAPL" in plain text wouldn't create a `data-symbol` attribute unless the platform linked it.

---

## core-006: "I am watching" AMZN PCS

**Input**: `"I have an AMZN lotto $227.50.$225 PCS that I am watching. For now all is good, but if the market sells off, I have to make sure the stock is stable. For now, it has been."`
**Expected**: SKIP
**Actual route**: `symbols=['AMZN']`, `badges=[]`, `isLotto=true` (matches LOTTO_RE), strategy detection at line 276: PCS_RE matches "PCS" -> `strategy='PCS'`. But wait -- line 283 (`isLotto` branch) comes BEFORE line 276? No -- checking the order: CDS (274), PCS (276), PDS (278), LEAP (280), then isLotto (283). So PCS wins over lotto. `strategy='PCS'`. `action=null` (no badge, no action verb -- "watching" is NOT in EXIT_VERB_RE and "I have" is not BOUGHT_BUYING_RE). So `needsLLM=true` because `action=null`.

**Failure mechanism**: Routes to LLM. LLM sees `strategy=PCS, symbol=AMZN` and the pre-parsed fields mislead it into classifying as EXECUTE.

**Fix options**:

1. **Add "watching"/"monitoring"/"keeping an eye on" to a new OBSERVATION_VERB set that triggers SKIP**
   - Risk: "watching for an entry on AAPL, bought 10 calls at $2.50" -- here "watching" appears but there IS an actionable trade. However, this message would also have `BOUGHT_BUYING_RE` match, which sets `action='OPEN'`. So the OPEN action takes priority over the observation verbs.
   - Implementation: Only use observation verbs as a skip signal when `action=null AND badges=[]`. If any action verb or badge is present, the observation verb is irrelevant.

2. **"I have" / "I am holding" as observation/status patterns -> SKIP**
   - Regex: `/\bI\s+(have|am\s+holding|currently\s+hold)\b/i`
   - This explicitly identifies messages describing existing positions rather than new trades.
   - Risk: "I have AAPL calls, sold half for 2.50" -- has "I have" AND "sold half". But "sold" triggers action detection, so `action` would not be null.

3. **Don't pre-fill strategy/direction when action=null** (same fix as core-001)
   - Even if LLM is invoked, it won't be biased by `strategy=PCS`.

**Recommendation**: Option (3) is the foundational fix (prevents bias). Option (2) is a high-confidence heuristic: `"I have an X"` + `action=null` is a status update pattern, not a trade. Option (1) is reasonable but lower priority since the "I have" pattern is more distinctive.

**Should "watching" be a skip verb?** Yes, but only in the specific context of `action=null`. The pattern "I am watching X" with no action badge and no action verb is safely skippable. It does NOT mean we skip "Watching AAPL, bought $150 calls" -- the "bought" verb takes priority.

---

## core-007: "Feedback Request" badge

**Input**: `<span class="badge bg-faded-purple text-purple">Feedback Request</span> GS PCS 880/875 @ 1.25 credit.`
**Expected**: SKIP

**Badge parsing trace**: `extractBadges()` (badges.ts:19) iterates `span.badge` elements and extracts text. For this input, `text = "Feedback Request"`. Then at line 28, it looks up `BADGE_MAP[badge]` -- the map only contains `'Long'`, `'Short'`, `'Exit'`. `"Feedback Request"` has no entry, so `info = undefined` and it's skipped. Result: `badges=['Feedback Request']`, `actionHint=null`, `directionHint=null`.

**Parser trace**: `parseMessage()` checks `badges.includes('Exit')` (false), `badges.includes('Long')` (false), `badges.includes('Short')` (false). So `hasExitBadge=false, hasLongBadge=false, hasShortBadge=false`. The badge is functionally invisible to the parser.

Then: `symbols=['GS']`, PCS_RE matches -> `strategy='PCS'`, `action=null` (line 348-368: no exit badge, no Long/Short badge, no exit verb, no bought/sold verb -- "credit" is not an action verb). So: `action=null -> needsLLM=true`.

**Failure mechanism**: Routes to LLM, which sees full trade structure (`GS PCS 880/875 @ 1.25 credit`) and classifies as EXECUTE. The "Feedback Request" badge text is buried in the raw HTML but NOT clearly conveyed to the LLM as a non-trade indicator.

**Full badge taxonomy from Discord** (observed in the codebase/fixtures):
- Trade badges: `Long` (bg-success), `Short` (bg-danger), `Exit` (bg-primary)
- Non-trade badges: `Feedback Request` (bg-faded-purple), `Question` (bg-warning), possibly others

**Fix options**:

1. **Whitelist approach (RECOMMENDED)**: Only `Long`, `Short`, `Exit` are trade badges. If a badge is present and it's NOT in the whitelist, hard-skip.
   - Rationale: The Discord platform uses badges explicitly. Non-trade badges like "Feedback Request" and "Question" explicitly mark the message as non-actionable.
   - Implementation: `const TRADE_BADGES = new Set(['Long', 'Short', 'Exit'])`. If `badges.length > 0 && !badges.some(b => TRADE_BADGES.has(b))`, hard-skip with reason `non-trade badge: ${badges.join(', ')}`.
   - Risk: A message with BOTH a trade badge and a non-trade badge? E.g., `['Exit', 'Question']`. The whitelist check passes (Exit is trade), which is correct -- the Exit takes precedence.
   - Edge case: A message with NO badges at all -- whitelist check doesn't apply (badges.length === 0). Correct, these route normally.

2. **Blacklist approach**: Enumerate known non-trade badges (`Feedback Request`, `Question`) and skip on match.
   - Disadvantage: Requires maintenance as new badge types appear. Misses unknown non-trade badges.

3. **Pass badge context to LLM prompt**
   - The `buildNLUPrompt()` doesn't currently include badge information. Adding `Badges: ["Feedback Request"]` would help the LLM recognize this is a feedback request.
   - But this is a belt-and-suspenders fix -- the whitelist approach is deterministic and cheaper.

**Recommendation**: Whitelist approach (option 1). It's the most robust: any unknown badge type defaults to non-trade, which is the safe default for an automated trading system. Unknown badges should be skipped (or at minimum flagged for review) rather than executed.

**Implementation note**: The check should be in the parser at the top of `parseMessage()`, right after the existing hard-skip checks. Pseudo-code:
```
const TRADE_BADGES = new Set(['Long', 'Short', 'Exit']);
const hasNonTradeBadge = badges.length > 0 && badges.some(b => !TRADE_BADGES.has(b));
const hasAnyTradeBadge = badges.some(b => TRADE_BADGES.has(b));
if (hasNonTradeBadge && !hasAnyTradeBadge) {
  return hardSkip(`non-trade badge: ${badges.filter(b => !TRADE_BADGES.has(b)).join(', ')}`, complexityFlags);
}
```

---

## regression-005: LEAP vs explicit date "3/26"

**Input**: `<SHORT BADGE /> SPY - added another 10 the leaps - total 60 - avg. $27.67 - 3/26 - $600`
**Expected**: EXECUTE with `strike=600`, `side=BUY`, `optionType=CALL`

**Parser trace**:
- `LEAP_RE.test(cleanText)` -> matches "leaps" -> true
- `extractExpiryHint()` line 184: LEAP_RE check is FIRST -> returns `"LEAP"` immediately
- The slash date `3/26` at line 191-198 is never reached because LEAP already returned
- `strategy` detection: LEAP_RE at line 280 -> `strategy='CALL', directionFromStrategy='LONG'`
- `extractStrikes()`: `SLASH_PAIR_RE` matches `3/26` -> `[3, 26]`. Then `looksLikeDate(3, 26)` -> true (3 is 1-12, 26 is 1-31). Falls through to fallback. Then `DOLLAR_STRIKE_RE` matches `$27.67` and `$600` -> `[27.67, 600]`.
- Wait -- actually let me re-check. `SLASH_PAIR_RE` is `/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/`. Input is `3/26`. Match: `s1=3, s2=26`. `looksLikeDate(3, 26)` = true. Since it's the first (and only) slash pair, it goes into `fallback = [3, 26]`. No `best` found. So `strikes = [3, 26]`.
- Actually, next: `STRIKE_NEAR_OPTION_RE` -> does `$27.67 calls` appear? No, text is "leaps". So no match. `DOLLAR_STRIKE_RE` matches `$27.67` and `$600` -> `[27.67, 600]`. But wait, `best = null` and `fallback = [3, 26]`, so function returns `[3, 26]` from the slash pair. The dollar strikes are never reached because `fallback` is returned first.
- Hmm actually re-reading: the function returns `if (best) return best; if (fallback) return fallback;`. So it returns `[3, 26]`. Strikes = `[3, 26]`.
- Then at line 384-397 (disambiguate slash pairs that look like dates): `strategy='CALL'` (not a spread), so `!isSpread` -> `strikes = null`. Good, the date-like pair is discarded for non-spread strategies.
- But now strikes is null, so `strikesFromParse()` returns `{ method: 'atm' }` (since isLotto is false here -- LEAP_RE matches first at line 280 before isLotto at 283). Wait, let me re-check: `isLotto = LOTTO_RE.test(cleanText)` at line 263. The text "leaps" does NOT match `/\blotto\b|\byolo\b/i`. So `isLotto=false`.
- `expiryHint = 'LEAP'` -> resolves to `messageDate + 1 year` = 2026-09-24 -> next Friday = 2026-09-25.
- The `$600` strike is lost because `extractStrikes()` returned the slash pair `[3, 26]` (which was then nulled out), and never reached the `DOLLAR_STRIKE_RE` matches.

**The actual bug is multi-layered**:

1. **extractExpiryHint checks LEAP before slash dates (line 184 vs 191)**. The text contains BOTH "leaps" AND "3/26". LEAP match returns immediately, so "3/26" is treated as a strike pair in `extractStrikes()`, not as an expiry.

2. **extractStrikes returns the slash pair [3, 26] (a date) as fallback, blocking the $600 dollar strike**. The date-slash disambiguation at lines 384-397 correctly nulls out `[3, 26]` for non-spread strategy, but by then the `$27.67` and `$600` dollar strikes were never captured by `extractStrikes()`.

3. **"3/26" is actually the expiry (March 2026)**, not strikes. The word "leaps" is a descriptor for the type of trade, and "3/26" is the specific expiry date. In this context, LEAP is not a self-sufficient expiry hint -- it's being used alongside an explicit date that should take precedence.

**The core design question**: Should explicit dates always override keyword-based expiry hints?

**Analysis**: Yes, for this pattern. When a message contains both "leaps" (a general term meaning "long-dated options") AND an explicit date like "3/26", the explicit date is more specific and should win. The word "leaps" is simply confirming that the trade is long-dated, not specifying a particular expiry.

However, the reverse situation ("AAPL leaps Jan calls") has "leaps" + bare month "Jan" -- both are present. In this case, "Jan" IS the expiry and "leaps" is still just a descriptor. So explicit dates should always win over LEAP.

**Fix**:
- Reorder `extractExpiryHint()` to check explicit dates (slash dates, month+day, bare month) BEFORE the LEAP keyword.
- If an explicit date is found, return it. LEAP keyword is only used when no explicit date is present.
- This is straightforward: move lines 191-206 (slash date, month+day, bare month) above line 184 (LEAP check).

**Secondary fix for strikes**: With the expiry fix above, "3/26" would be consumed as the expiry, so `extractStrikes()` would need to NOT return it as a strike pair. Currently, `extractStrikes()` and `extractExpiryHint()` operate independently on the same text -- both can match `3/26`. This creates a conflict. Options:
- After the expiry fix, `3/26` is consumed as expiry. But `extractStrikes()` still returns it as `[3, 26]`. Lines 384-397 null it out for non-spread. Then `strikesFromParse()` falls back to ATM. The `$600` dollar strike is still lost because `extractStrikes()` returned the slash pair before reaching dollar strikes.
- Better fix: After extracting the slash pair, also check DOLLAR_STRIKE_RE and return dollar strikes if the slash pair looks like a date. Or: restructure `extractStrikes()` to prefer dollar-prefixed strikes over date-like slash pairs.

**Recommendation**: Two changes:
1. In `extractExpiryHint()`: check explicit dates before LEAP keyword.
2. In `extractStrikes()`: when the slash pair is date-like AND dollar-prefixed strikes exist, prefer the dollar strikes. This ensures `$600` is captured as the strike when `3/26` is a date.

---

## regression-007: CDS "next week" partial score (0.67)

**Input**: `"Long UNH cds for next week expiration"`
**Expected**: EXECUTE, SPREAD, legs with optionType=CALL
**Timestamp**: `2025-09-19T14:00:00.000Z`

**Parser trace**:
- `badges=[]` (no badge spans in raw HTML -- just plain text "Long")
- `symbols=['UNH']`
- CDS_RE matches -> `strategy='CDS'`
- `direction`: CDS has no `directionFromStrategy` set (line 274-275 just sets `strategy='CDS'`), and since strategy is CDS, the direction derivation section (lines 298-324) doesn't apply (CDS/PDS comment at line 325: "don't override"). So `direction=null`.
- Wait -- for CDS/PDS, `directionFromStrategy` is NOT set in the strategy detection block (only PCS gets nothing, CDS/PDS get nothing). Looking again: line 274-275 is just `strategy = 'CDS'`. No `directionFromStrategy = 'LONG'`. Then at line 300, `direction = directionFromStrategy` = null. Lines 302-324 don't apply (not lotto, not STOCK, not CALL/PUT). So `direction=null`.
- This is a bug in the parser! CDS should ALWAYS be direction LONG (per CLAUDE.md: "CDS: Always LONG"). The parser doesn't set this.
- `action`: No badge (plain text "Long" is NOT a badge span) -> lines 348-368: no exit badge, no Long/Short badge. BOUGHT_BUYING_RE doesn't match "Long". EXIT_VERB_RE doesn't match. WROTE_WRITING_RE doesn't match. So `action=null`.
- `expiryHint`: "next week" matches EXPIRY_NEXT_WEEK_RE -> `expiryHint='next week'`.

**Routing**: `action=null` -> `needsLLM=true` -> LLM path.

**LLM gets**: `strategy=CDS, direction=null, expiryHint="next week"`. The LLM needs to determine `action=OPEN` (from context "Long UNH cds" = opening a CDS) and fill in direction.

**Scorer trace**: The expected is `{ orderType: 'SPREAD', legs: [{ optionType: 'CALL' }] }`. Scoring:
- `signals[0].orderType`: expected SPREAD vs actual ?
- `signals[0].legs.count`: expected 1 (only CALL leg specified) vs actual ?
- `signals[0].legs[0].optionType`: expected CALL vs actual ?

If the LLM correctly produces a CDS with CALL legs, score should be 1.0. A 0.67 score means 2 of 3 fields matched and 1 didn't.

**Most likely failure**: The LLM produces a signal that resolves through open-path, but one field is wrong. Candidates:
- `orderType` mismatch: LLM might produce SINGLE instead of SPREAD (unlikely for CDS)
- `legs.count` mismatch: might emit 1 leg instead of 2 (CDS has 2 legs in a spread)
- `optionType` mismatch: CALL vs PUT (unlikely for CDS)

Actually, looking at the expected fixture more carefully: `legs: [{ optionType: 'CALL' }]` -- only one leg specified. The scorer at line 228-269: it counts expected legs (1), then counts actual legs (2 for a CDS spread). `legs.count` field: `expected=1, actual=2` -> MISMATCH.

Wait, that creates the mismatch. But actually the scorer checks `expectedSig.legs.length === actualLegs.length` where `expectedSig.legs` is `[{ optionType: 'CALL' }]` (length 1). The actual CDS has 2 option legs. So `legs.count` = false. Then scoring the single expected leg against one of the 2 actual legs: optionType CALL matches the CALL leg. So: `legs.count`=false, `legs[0].optionType`=true, `orderType`=true. Score = 2/3 = 0.67.

**Root cause of the 0.67**: The fixture is under-specified. It only specifies one leg for a CDS spread, but the actual CDS produces 2 legs. The `legs.count` field mismatches.

**Fix**: Update the fixture to specify both legs of the CDS spread:
```json
"legs": [
  { "optionType": "CALL", "side": "BUY" },
  { "optionType": "CALL", "side": "SELL" }
]
```

**Secondary issues**:
1. The parser doesn't set `directionFromStrategy='LONG'` for CDS (and likely PDS). This should be fixed: CDS -> LONG, PDS -> LONG, PCS -> stays null (PCS goes through postprocess).
2. The parser can't determine `action=OPEN` because there's no badge and "Long" in plain text isn't detected as an action verb. This is correct behavior -- "Long" as plain text is ambiguous (could be "Long AAPL" meaning "I'm long AAPL" = position description). The LLM path is the right place to resolve this.

---

## direction-010: "lotto" covered call

**Input**: `<SHORT BADGE /> HIMS lotto $41 call @ $.75. My net cost on the stock is $40.70 and if I am assigned this will get me out for a $1.05 profit if it is called away from me. If not, my cost goes down to $40 and I can decide what I want to do after that. I am indifferent so I might as well collect some premium.`
**Expected**: EXECUTE, SELL CALL at strike 41

**Parser trace**:
- `badges=['Short']`, `symbols=['HIMS']`
- `hasShortBadge=true`
- `isLotto = LOTTO_RE.test(cleanText)` -> true ("lotto" matches)
- Strategy detection: CDS/PCS/PDS/LEAP don't match. `isLotto` at line 283: `strategy = CALLS_RE.test(cleanText) ? 'CALL' : 'PUT'` -> "call" matches CALLS_RE -> `strategy='CALL'`, `directionFromStrategy='LONG'`.
- Direction: line 302-303: `isLotto` -> `direction = 'LONG'` (unconditional override)
- Action: line 348: `hasLongBadge` is false, `hasShortBadge` is true -> `action='OPEN'`
- `wordCount > 15` with action+strategy set -> `complexityFlags.add('extra_text')`
- `strikes = [41]` (from `$41` dollar-prefixed), `premiumHint = 0.75` (from `$.75`)
- Parse result: `action=OPEN, strategy=CALL, direction=LONG, strikes=[41], premiumHint=0.75, isLotto=true, flags={extra_text}`

**Routing**: `needsLLM = complexityFlags.size > 0` (extra_text flag) -> LLM path.

**The extra_text flag saves this case!** Without it, the deterministic open-path would produce a BUY CALL (direction=LONG -> side=BUY). The extra_text flag correctly routes to LLM for the complex context.

**LLM challenge**: The LLM receives pre-parsed fields `strategy=CALL, direction=LONG, strikes=[41], premium=0.75, isLotto=true`. These are WRONG for a covered call. The LLM must override the parser's `direction=LONG` to produce `direction=SHORT, side=SELL`.

**The fundamental conflict**: `isLotto` -> `direction=LONG` is an unconditional rule (line 302-303). Per CLAUDE.md: "Lotto/Yolo = speculative BUY, always direction: LONG, never sell-to-open." But this message IS a lotto label being used colloquially for a covered call (selling a call against stock). The trader labeled it "lotto" because the call is far OTM and speculative from their perspective, but they're SELLING it (collecting premium), not buying it.

**Context clues that override lotto semantics**:
- "collect some premium" -> selling, not buying
- "called away from me" -> writer's perspective, not buyer's
- "net cost on the stock" -> owns stock, selling against it
- "if I am assigned" -> only sellers get assigned

**Fix options**:

1. **Add a "covered_call" complexity flag when lotto + sell signals co-occur**
   - Detect: `isLotto && (SOLD_RE || /collect\s+premium/i || /called\s+away/i || /if\s+.+assigned/i)`
   - When triggered: add `complexityFlags.add('lotto_sell_conflict')`, and DON'T pre-fill direction=LONG
   - This forces LLM routing, and the LLM sees the conflict without the bias of direction=LONG

2. **Remove direction=LONG from pre-parsed fields when routing to LLM for lotto conflicts**
   - In `buildNLUPrompt()`, if `isLotto && complexityFlags.has('lotto_sell_conflict')`, don't include `direction=LONG` in the pre-parsed fields.

3. **Always route to LLM when lotto + extra_text** (already happens)
   - But the issue is the pre-parsed `direction=LONG` biasing the LLM. Even though it routes to LLM correctly, the LLM sees "direction=LONG" and is unlikely to override it.

**Recommendation**: Option 1. Add a dedicated complexity flag when lotto co-occurs with sell indicators. When this flag is set:
- Do NOT set `direction = 'LONG'` in the parser (leave it null for LLM)
- The LLM prompt won't include `direction=LONG`, giving it freedom to determine SELL from context

**Sell indicator patterns for lotto conflict detection**:
```
/collect\s+(?:some\s+)?premium/i
/called\s+away/i
/if\s+(?:I\s+am\s+)?assigned/i
/\bwriting?\b/i  (already WROTE_WRITING_RE)
/\bselling?\b/i
```

Actually, the simplest heuristic: if `isLotto` AND `SOLD_RE` or `WROTE_WRITING_RE` matches, that's a conflict. But in this message, neither "sold" nor "wrote"/"writing" appears. The sell signal is purely contextual ("collect premium", "called away", "assigned"). So we need the premium-collection patterns above.

**But is that too complex?** An alternative: if `isLotto` AND `wordCount > 15`, always leave `direction=null` and let LLM decide. The wordCount>15 already triggers `extra_text`, which routes to LLM. The only change needed is: when `isLotto` AND `extra_text` flag is set, don't pre-fill direction.

This is simpler and covers the covered-call case AND any other edge case where a long message with "lotto" needs nuanced interpretation.

**Recommended fix (simplest)**:
```typescript
// In direction derivation (line 302-304):
if (isLotto) {
  direction = 'LONG';
  // If there's significant commentary, the extra_text flag will route to LLM.
  // Don't override direction with LONG when we know it'll go to LLM anyway.
}

// In buildNLUPrompt() or the routing logic:
// When isLotto=true AND extra_text flag present, omit direction from pre-parsed fields
```

---

## Summary: Design Principle Assessment

| Case | Confident hard-skip? | Route to LLM? | Add complexity flag? |
|---|---|---|---|
| core-001 | YES: no symbol + no action = skip | N/A (skipped) | N/A |
| core-006 | PARTIAL: "I have" + no action = skip | Backup for edge cases | N/A |
| core-007 | YES: non-trade badge whitelist | N/A (skipped) | N/A |
| regression-005 | NO: parser fix (expiry precedence) | N/A (deterministic path) | N/A |
| regression-007 | NO: fixture under-specification | N/A (LLM path works) | Parser should set CDS direction |
| direction-010 | NO: too nuanced for parser | YES (already routes) | Omit direction=LONG from LLM prompt when lotto+extra_text |

### Overarching Themes

1. **Pre-parsed field bias**: The parser pre-fills strategy/direction even when action=null. These fields leak into the LLM prompt and bias it toward EXECUTE. Fix: only populate strategy/direction when action is determined.

2. **Badge whitelist**: The parser ignores unknown badges, letting them fall through to LLM. A trade badge whitelist is safer -- unknown badges default to skip.

3. **Expiry precedence**: Keyword-based hints (LEAP, 0DTE) should NOT take precedence over explicit dates. Explicit dates are always more specific.

4. **Fixture quality**: regression-007's 0.67 score is caused by under-specified expected legs, not a real orchestrator bug. The fixture should specify both legs of a CDS spread.

5. **Lotto override needs escape hatch**: The unconditional `isLotto -> direction=LONG` is correct for 95%+ of cases, but the covered call edge case needs a way to suppress the direction bias when the message is routed to LLM.
