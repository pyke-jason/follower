# Sold-Verb Parsing Analysis (Agent A2)

Analysis of orchestrator eval failures related to "sold" verb parsing, covering
direction.json and regressions.json failing cases.

---

## Group 1: "sold" + premium_mismatch (direction-001, direction-006, regression-001)

### Example message
`"Long HUT sold the 12/19 $36 puts for a credit of $0.88/contract"`

### Trace through current code

**Step 1: Context construction** (eval-orchestrator.ts lines 76-79)
- `htmlToCleanText(rawHtml)` -> `"Long HUT sold the 12/19 $36 puts for a credit of $0.88/contract"`
- `extractBadges(rawHtml)` -> `['Long']`
- `extractSymbols(rawHtml)` -> `['HUT']`

Note: `cleanText` includes the word "Long" from the badge span because `htmlToCleanText`
extracts ALL text content (including badge text). Only `htmlToLLMText` replaces badges with
`<LONG BADGE />` markers, and it's only used in the LLM path prompt builder.

**Step 2: Parser** (parser.ts `parseMessage()`)
- hasLongBadge = true, hasExitBadge = false
- STOCK_RE: does NOT match (no "stock"/"shares" in this message)
- Strategy detection: CDS/PCS/PDS/LEAP/LOTTO all miss. CALLS_RE misses. `PUTS_RE` matches "puts".
  SPREAD_KW_RE misses. -> **strategy = 'PUT'**, directionFromStrategy = 'LONG'
- Direction: strategy is PUT. Default direction = 'LONG'. SOLD_RE matches "sold". hasExitBadge=false.
  EXIT_VERB_RE (`/sold out/`) does NOT match "sold the". -> **direction = 'SHORT'**. Correct.
- Action: hasLongBadge=true -> **action = 'OPEN'**
- Strikes: `extractStrikes()`:
  - SLASH_PAIR_RE finds "12/19" -> looksLikeDate(12,19)=true -> stored as fallback
  - STRIKE_NEAR_OPTION_RE matches `$36 puts` -> returns **[36]**
- ExpiryHint: EXPIRY_SLASH_DATE_RE matches "12/19" -> validates as date -> **expiryHint = "12/19"**
- PremiumHint: PREMIUM_RE on text. "for a credit of $0.88/contract": the `for\s+\$?` prefix
  matches "for a"... wait, no. "for " is followed by "a", not a `$` or digit.
  The `\$` alternative matches "$0.88" -> **premiumHint = 0.88**
- Premium-strike dedup: 0.88 not in [36] -> premiumHint stays at 0.88

Parser output: `{ action: 'OPEN', strategy: 'PUT', direction: 'SHORT', strikes: [36], expiryHint: '12/19', premiumHint: 0.88 }`

**Step 3: Routing** (index.ts line 80-87)
- wordCount("Long HUT sold the 12/19 $36 puts for a credit of $0.88/contract") = 14. < 15.
- complexityFlags: empty (no multi_ticker, no relational, no mixed_action)
- needsLLM = false. action = 'OPEN' -> resolveOpenPath.

**Step 4: Open-path** (open-path.ts)
- strategy = 'PUT', not a spread
- direction = 'SHORT' -> validated OK
- strikesFromParse: strikes=[36] -> `{ method: 'explicit', strikes: [36] }`
- Expiry: resolveExpiryHint("12/19", messageDate=2025-12-12) -> 12/19, month=12, day=19 ->
  year=2025 (not past messageDate since 12/19 > 12/12). -> resolvedExpiry = "2025-12-19"
- buildLegsForExpiry("2025-12-19"): explicit method, not a spread -> single PUT leg at strike 36,
  side=SELL. Returns `{ legs: [{ type: 'option', symbol: 'HUT', expiry: '2025-12-19', optionType: 'PUT', strike: 36, side: 'SELL', quantity: 1 }] }`

**Step 5: Premium validation** (open-path.ts lines 680-722)
- premiumHint = 0.88, strikeSelection.method = 'explicit' (not 'premium_match')
- Gets option chain for HUT PUT at expiry 2025-12-19
- Finds strike 36 in chain, computes `chainMid(bid, ask)`
- Checks: `|chainMid - 0.88| > 0.88 * 0.05 (= 0.044)` -> **FAILS if market mid differs by >$0.044**

### Root cause

The parser correctly derives strategy=PUT, direction=SHORT, strike=36, and the legs are built
correctly with side=SELL. The failure occurs in **post-build premium validation** (open-path.ts
lines 680-722).

The 5% tolerance (`statedPremium * 0.05`) is extremely tight for a $0.88 credit -- only $0.044
of difference is allowed. For short options, the trader states the credit they received, but the
chain mid at the message timestamp may differ by more than this due to:
1. Bid-ask spread on the option itself
2. Time delay between trade execution and message posting
3. The mid is not necessarily where the fill happened

**This is NOT a parser bug.** The parser works correctly. The premium validation tolerance is
too strict for cheap options.

### Proposed fix

The premium validation tolerance (5% of stated premium) should either:
1. Use `max(statedPremium * 0.10, 0.10)` -- 10% or $0.10, whichever is larger
2. Skip premium validation entirely when strikes are explicit (the trader stated the strike;
   the premium is informational context, not needed for strike resolution)

Option 2 is cleaner: if we have explicit strikes, the premium is not needed to build the signal.
The validation was designed for `premium_match` mode where the premium IS the strike-selection
mechanism, but for `explicit` strikes, it's an unnecessary gate.

Specifically, the block at lines 680-722 should be conditioned on `strikeSelection.method !== 'explicit'`
(it already checks `!== 'premium_match'`; add the additional exclusion).

---

## Group 2: Wrong strategy classification (direction-002, direction-004)

### Example message (direction-002)
`"Long Sold BMNR Dec (19) $32.50 puts @ $1.14. That would make me long stock < AVWAPE if I am assigned. That would generate a 7% return in 10 days if it expires"`

### Trace through current code

**Context construction:**
- cleanText: `"Long Sold BMNR Dec (19) $32.50 puts @ $1.14. That would make me long stock < AVWAPE if I am assigned. That would generate a 7% return in 10 days if it expires"`
- badges: `['Long']`
- symbols: `['BMNR']`

**Parser strategy detection (critical path):**
1. CDS_RE: no
2. PCS_RE: no
3. PDS_RE (`/\bpds\b|put debit spread/i`): no -- "puts" does NOT match "pds"
4. LEAP_RE: no
5. LOTTO_RE: no
6. **STOCK_RE** (`/\bstocks?\b|\bshares?\b/i`): **YES** -- matches "stock" in the commentary
   "That would make me long stock < AVWAPE"

So strategy = 'STOCK', directionFromStrategy = null. Direction derivation for STOCK: hasLongBadge ->
LONG. Then SOLD_RE overrides -> SHORT. Action: hasLongBadge -> OPEN.

**Word count check:** The cleanText has ~40 words, well over 15. With action=OPEN, strategy=STOCK,
wordCount > 15 -> `extra_text` complexity flag is set.

**Routing:** complexityFlags.size > 0 -> `needsLLM = true` -> routes to LLM path.

**LLM path:** The LLM receives the pre-parsed fields (`strategy=STOCK, direction=SHORT`) and the
full message text (via `htmlToLLMText`, which does encode badges correctly). However, the LLM
likely produces strategy=PDS (misinterpreting "Long" badge context + "puts") because:
- The system prompt lists PDS as a valid strategy
- The message pattern "Long [ticker] [puts]" resembles a PDS description
- The LLM doesn't have the context that "stock" was incidental commentary

When the LLM returns strategy=PDS with only 1 strike from the message ($32.50), the open-path
validation fails: **"Spread strategy PDS requires 2 strikes, got 1"**.

### Root cause (two interacting bugs)

**Bug A: STOCK_RE matches incidental text.** The word "stock" in "make me long stock if assigned"
is commentary about assignment outcome, not a strategy indicator. STOCK_RE at line 287 has no
context awareness -- it matches any occurrence of "stock" in the entire message.

**Bug B: STOCK_RE takes priority over PUTS_RE in the else-if chain.** STOCK_RE (line 287) is
checked before CALLS_RE (line 290) and PUTS_RE (line 293). Since "puts" and "stock" both appear,
the strategy becomes STOCK instead of the correct PUT.

If STOCK_RE didn't match, the parser would correctly detect strategy=PUT via PUTS_RE at line 293,
then direction=SHORT via SOLD_RE. The `extra_text` flag might still fire (40+ words), but the
pre-parsed fields sent to the LLM would be `strategy=PUT, direction=SHORT` rather than
`strategy=STOCK, direction=SHORT`, giving the LLM much better guidance.

**The same bug affects direction-004** (EOSE message), which also contains "stock" in "buy the stock
at $12.95".

### Proposed fix

Two possible approaches:

**Approach 1: Require STOCK_RE to be near a symbol or to be the dominant strategy noun.**
Only match "stock" if it's adjacent to a dollar price or symbol reference, not buried in commentary.
E.g., check word proximity: "bought 100 shares" vs "make me long stock if assigned".

**Approach 2: Reorder the else-if chain so option-type keywords take priority over STOCK_RE.**
If "puts" or "calls" is present AND "stock" is present, the option keyword should win (since you
can't trade "stock options" with a STOCK strategy):

```
// Check option-type keywords BEFORE STOCK
} else if (CALLS_RE.test(cleanText) && !SPREAD_KW_RE.test(cleanText)) {
  strategy = 'CALL';
} else if (PUTS_RE.test(cleanText) && !SPREAD_KW_RE.test(cleanText)) {
  strategy = 'PUT';
} else if (STOCK_RE.test(cleanText)) {
  strategy = 'STOCK';
}
```

Approach 2 is simpler and more robust. If someone mentions both "puts" and "stock", the trade is
about puts. STOCK strategy should only be selected when no option-type keywords are present.

### "Long" bleeding into cleanText

The word "Long" in `cleanText` comes from the badge span via `htmlToCleanText`. This does NOT
directly cause the PDS misclassification in the parser (PDS_RE requires the literal string "pds"
or "put debit spread"). However, when the message is routed to the LLM path, the `htmlToLLMText`
function correctly encodes the badge as `<LONG BADGE />`, so the LLM prompt shows:
```
Text: <LONG BADGE /> Sold BMNR Dec (19) $32.50 puts @ $1.14...
Pre-parsed fields: strategy=STOCK, direction=SHORT
```

The LLM receives the badge correctly but gets misleading pre-parsed fields. The root cause is
in the parser (Bug A + B), not in the badge encoding.

---

## Group 3: Bare "P" abbreviation (direction-007)

### Example message
`"HUT $34 P Sold 12/19/25 at 0.81"`

### Trace

cleanText: `"Long HUT $34 P Sold 12/19/25 at 0.81. Going bit deeper ITM to be below the 100-SMA line."` (includes "Long" from badge)
badges: `['Long']`, symbols: `['HUT']`

**Strategy detection:**
- PUTS_RE (`/\bputs?\b/i`): tests for "put" or "puts". The text has `$34 P Sold`. The word "P"
  is a single character. `\bputs?\b` requires at least "put" (3 chars). **"P" does NOT match.**
- No other strategy keyword matches. STOCK_RE: "stock" appears nowhere (but "Going" and "100-SMA"
  don't match either). CALLS_RE misses.
- Result: **strategy = null**.

**Action detection:** hasLongBadge -> OPEN. But strategy is null.

**Routing:** action=OPEN, strategy=null -> goes to open-path. But open-path line 347:
"OPEN signal missing strategy" -> MANUAL_REVIEW.

If routed to LLM path (which would happen if action were null or flags were set), the LLM might
correctly interpret "P" as PUT. But with no complexity flags and action=OPEN, it goes straight to
open-path which immediately rejects for missing strategy.

Actually, wait: strategy is null but action is OPEN from the badge. Then at line 80 of index.ts:
`needsLLM = parse.complexityFlags.size > 0 || parse.action === null`. Flags are empty and
action=OPEN, so needsLLM=false. Routes to open-path which fails on missing strategy.

### Should `PUTS_RE` match bare "P"?

**Risks of matching bare "P":**
- "P" is extremely common in English text: "P&L", "P/E ratio", "S&P"
- Even `\bP\b` would match isolated "P" in "S&P 500" (after the & or in word boundaries)
- All stock tickers are uppercase, and single-letter combinations are frequent

**Risks of NOT matching bare "P":**
- Only affects messages using the "$[strike] P" abbreviation pattern
- This appears to be a specific trader's shorthand (Chilled Chilly)
- The "Sold" verb still works for direction, but strategy detection fails

### Proposed fix

Do NOT add bare "P" to PUTS_RE. Instead, add a targeted pattern for the `$strike P` / `$strike C`
abbreviation:

```typescript
const STRIKE_OPTION_ABBREV_RE = /\$\d+(?:\.\d+)?\s+P\b/i;  // "$34 P"
const STRIKE_OPTION_CALL_ABBREV_RE = /\$\d+(?:\.\d+)?\s+C\b/i;  // "$34 C"
```

This pattern only matches "P" or "C" when immediately preceded by a dollar-strike, which is a
strong signal that it's an option type abbreviation, not an English word.

The strategy detection block would add (before the CALLS_RE/PUTS_RE checks):

```typescript
} else if (STRIKE_OPTION_ABBREV_RE.test(cleanText) && !SPREAD_KW_RE.test(cleanText)) {
  strategy = 'PUT';
  directionFromStrategy = 'LONG';
} else if (STRIKE_OPTION_CALL_ABBREV_RE.test(cleanText) && !SPREAD_KW_RE.test(cleanText)) {
  strategy = 'CALL';
  directionFromStrategy = 'LONG';
}
```

Alternatively, a single pattern:
```typescript
const DOLLAR_STRIKE_OPTION_TYPE_RE = /\$\d+(?:\.\d+)?\s+([CP])\b/i;
```

Check it, extract group 1, and set strategy accordingly. This is precise enough to avoid false
positives.

An additional improvement: STRIKE_NEAR_OPTION_RE (line 49) currently uses `/[cp]\b/i` to match
single-letter option type abbreviations for **strike extraction**, but the strategy detection
doesn't have an equivalent. There's an inconsistency: the parser can extract a strike adjacent
to "P" but can't determine the strategy from the same "P". These should be unified.

---

## Group 4: "tomorrow" expiry (direction-011, regression-003)

### Example message
`"Sold 10 $180 Puts on NVDA for $1.80 - expiring tomorrow"`

### Trace

cleanText: `"Sold 10 $180 Puts on NVDA for $1.80 - expiring tomorrow"`
badges: `[]` (no badges in rawHtml)
symbols: `['NVDA']`

**Parser:**
- Strategy: PUTS_RE matches "Puts" -> strategy = 'PUT', directionFromStrategy = 'LONG'
- Direction: SOLD_RE matches "Sold". hasExitBadge=false. EXIT_VERB_RE: does "Sold" match?
  Pattern is `/\b(exit(?:ing|ed)?|clos(?:ed|ing)|exiting|took profits?|stopped out|sold out)\b/i`.
  "Sold" alone does NOT match (requires "sold out"). -> **direction = 'SHORT'**. Correct.
- Action: No badges. EXIT_VERB_RE does not match. BOUGHT_BUYING_RE doesn't match. WROTE_WRITING_RE
  doesn't match. But SOLD_RE is not checked in the action block. Let me re-check...

Action block (line 348-368): no hasExitBadge, no hasLongBadge, no hasShortBadge. Falls to "else"
block (line 351). EXIT_VERB_RE doesn't match "Sold". BOUGHT_BUYING_RE doesn't match.
WROTE_WRITING_RE doesn't match. `/\b(adding|opened)\b/i` doesn't match. -> **action = null**.

**Routing:** action = null -> needsLLM = true -> LLM path.

Wait, but there's also a SOLD_RE check possibility. The action detection doesn't check for
SOLD_RE as an OPEN signal. This is an independent issue: when "Sold" is the only verb and there
are no badges, the parser can't determine the action. The SOLD_RE check in the action block should
also trigger action = 'OPEN' for sell-to-open.

**expiryHint extraction:**
- EXPIRY_0DTE_RE: no
- EXPIRY_OVERNIGHT_RE (`/\bovernight\b/i`): no
- EXPIRY_NEXT_FRIDAY_RE: no
- EXPIRY_THIS_WEEK_RE: no
- No "tomorrow" pattern exists
- **expiryHint = null** (no pattern matches "tomorrow")

### Root cause (two issues)

**Issue 1: No "tomorrow" pattern in extractExpiryHint.**
`resolveExpiryHint()` handles "overnight" (next business day), "0dte" (same day), "this week"
(Friday), "next week" (next Friday), but not "tomorrow".

**Issue 2: No badge -> SOLD_RE doesn't trigger action=OPEN.**
The action detection (lines 348-368) handles: Exit badge -> CLOSE/TRIM/LEG_OFF; Long/Short badge
-> OPEN; no badge + EXIT_VERB_RE -> CLOSE; no badge + BOUGHT_BUYING_RE/WROTE_WRITING_RE -> OPEN.
But "Sold" is not in the action detection for badgeless messages (only WROTE_WRITING_RE is). This
means action=null, routing to LLM.

With the LLM path, the message will likely be correctly classified (the LLM should understand
"Sold" and "expiring tomorrow"), but it requires an LLM call that should be unnecessary.

### "tomorrow" semantics: calendar vs business day

**Recommendation: next calendar day.**
- "Expiring tomorrow" refers to the expiry date printed on the contract, which is always a calendar
  date
- If someone posts on Thursday evening saying "expiring tomorrow", they mean Friday
- If someone posts on Friday saying "expiring tomorrow", they mean Saturday -- but Saturday
  options expiry doesn't exist, so the next valid expiry would be the following Monday (which is
  a business day concern, not a calendar day concern)
- However, the message timestamp is 2025-12-11 (Thursday). "Tomorrow" = 2025-12-12 (Friday).
  For this specific case, calendar day and business day are the same.

**For robustness, use next calendar day and let the expiry validation in open-path handle
the case where it falls on a weekend** (it would look up chain data for that date, find none,
and try the next available expiry).

### Proposed fixes

**Fix 1: Add "tomorrow" pattern to extractExpiryHint:**
```typescript
const EXPIRY_TOMORROW_RE = /\btomorrow\b/i;
```
In extractExpiryHint, before the slash-date check:
```typescript
if (EXPIRY_TOMORROW_RE.test(text)) return 'tomorrow';
```
In resolveExpiryHint:
```typescript
if (normalized === 'tomorrow') {
  const d = new Date(messageDate);
  d.setUTCDate(d.getUTCDate() + 1);
  return dateToYMD(d);
}
```

**Fix 2: Add SOLD_RE to badgeless action detection:**
In the "no badge" else block (around line 362), add:
```typescript
} else if (SOLD_RE.test(cleanText) && !EXIT_VERB_RE.test(cleanText)) {
  action = 'OPEN';
}
```
This mirrors the logic already used for direction derivation (lines 320-322) and for
WROTE_WRITING_RE (line 365). "Sold" without an exit context is sell-to-open -> action=OPEN.

---

## Summary of all fixes needed

| Group | Case IDs | Root Cause | Fix |
|-------|----------|-----------|-----|
| 1 | direction-001, -003, -006, regression-001 | Premium validation too strict for explicit strikes | Skip premium validation when strikeSelection.method === 'explicit' |
| 2 | direction-002, -004 | STOCK_RE matches incidental commentary; outprioritizes PUTS_RE | Move CALLS_RE/PUTS_RE checks before STOCK_RE in the else-if chain |
| 3 | direction-007 | Bare "P" not recognized as PUT abbreviation | Add `$strike P/C` targeted pattern for strategy detection |
| 4 | direction-011, regression-003 | No "tomorrow" expiry pattern; SOLD_RE not in badgeless action detection | Add EXPIRY_TOMORROW_RE; add SOLD_RE to badgeless action=OPEN |

### Risk assessment of proposed fixes

- **Group 1 fix (skip premium validation for explicit strikes):** Zero risk -- the premium was
  never used for strike selection in this path; it was purely a post-hoc sanity check.
- **Group 2 fix (reorder strategy detection):** Low risk -- messages with both "puts"/"calls" and
  "stock" are almost certainly about options, not stock. The only risk is a message like "buying
  stock puts" where someone means put options on a stock ticker literally called STOCK.
- **Group 3 fix ($strike P/C pattern):** Very low risk -- the pattern is anchored to a dollar-strike
  prefix, avoiding false positives on bare "P"/"C" in regular text.
- **Group 4 fix (tomorrow + SOLD_RE action):** Low risk -- "tomorrow" is unambiguous as an expiry
  hint. Adding SOLD_RE to the badgeless action block mirrors existing patterns (WROTE_WRITING_RE
  already triggers OPEN there).

### Interaction between fixes

The Group 2 fix (reorder strategy detection) would likely fix Group 2 cases even WITHOUT the
Group 1 fix, because with strategy=PUT and direction=SHORT, the premium validation would use
the correct strike from the parser. However, the Group 1 fix is still valuable as a general
robustness improvement -- there are likely other messages with explicit strikes and stated
premiums that differ from the chain mid by more than 5%.

The Group 4 fixes are fully independent. The "tomorrow" pattern and the SOLD_RE action detection
are orthogonal changes.
