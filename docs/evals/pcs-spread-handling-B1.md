# PCS/Spread Handling Eval Failures — Analysis (Agent B1)

## Case 1: spreads-001 — Pete AMZN PCS with Long badge

### Input
- rawHtml: `<span class="badge bg-success">Long</span>&nbsp;AMZN Sold Dec (5) $227.50/225 PCS for $.42 Cr.`
- cleanText (after htmlToCleanText): `"Long AMZN Sold Dec (5) $227.50/225 PCS for $.42 Cr. I believe the stock will stay above the 100-day MA this week. it was up this morning when the market was down. RS"`
- badges (from extractBadges): `["Long"]`
- symbols: `["AMZN"]`

### Code path trace

1. **parser.ts line 276**: `PCS_RE = /\bpcs\b|put credit spread/i` — matches "PCS" in cleanText. Strategy = `'PCS'`.

2. **parser.ts line 298-324**: Direction derivation. For PCS, `directionFromStrategy` is NOT set (lines 276-277 only set `strategy = 'PCS'`, unlike CDS/PDS which do nothing differently). The code falls through to line 300: `direction = directionFromStrategy` which is `null`.

3. **Key issue**: Lines 302-324 check isLotto (no), STOCK (no), CALL/PUT (no). PCS is not CALL or PUT, so the `else if (strategy === 'CALL' || strategy === 'PUT')` block at line 314 is skipped. **Direction remains `null` for PCS.**

4. **parser.ts line 348**: Action: `hasLongBadge = true`, so action = `'OPEN'`.

5. **parser.ts line 383**: `isSpread = true` for PCS. Strike disambiguation proceeds normally.

6. **Strikes**: `extractStrikes("Long AMZN Sold Dec (5) $227.50/225 PCS for $.42 Cr. ...")`:
   - SLASH_PAIR_RE matches `227.50/225` → `[227.5, 225]`. Not date-like (227.5 > 12). `best = [227.5, 225]`.
   - Strikes = `[227.5, 225]`.

7. **open-path.ts line 355**: `spreadStrategy = isSpread('PCS') = true`.

8. **open-path.ts line 358-363**: For spread strategies, direction check is SKIPPED. Good.

9. **open-path.ts line 366**: `direction = parse.direction ?? 'LONG'`. Since parse.direction is `null`, direction becomes `'LONG'`. **This is the fallback — but for PCS the direction doesn't matter for leg construction.**

10. **open-path.ts line 426-442**: `strikeSelection.method === 'explicit'`, `spreadStrategy = true`, strikes = `[227.5, 225]`.
    - Calls `spreadLegs('PCS', 227.5, 225)`.

11. **spread-legs.ts line 36-43**:
    ```
    hi = Math.max(227.5, 225) = 227.5
    lo = Math.min(227.5, 225) = 225
    PCS → [
      { strike: 227.5, action: 'SELL', optionType: 'PUT' },
      { strike: 225, action: 'BUY', optionType: 'PUT' },
    ]
    ```

12. **open-path.ts line 433-441**: Maps `sl.action` to `side`:
    - Leg 0: `{ side: 'SELL', strike: 227.5, optionType: 'PUT' }`
    - Leg 1: `{ side: 'BUY', strike: 225, optionType: 'PUT' }`

### Expected vs Actual
- Expected: SELL 227.5 PUT / BUY 225 PUT
- Actual (from code trace): SELL 227.5 PUT / BUY 225 PUT

### Verdict: **The code path SHOULD produce the correct result.**

The `spreadLegs()` function correctly produces SELL higher / BUY lower for PCS. The leg sides should match.

**However**, the eval reports "hard fail on signals[0].legs[0].side". This suggests one of:
1. The `cleanText` or `badges` are different than expected (different HTML parsing)
2. The premium validation at open-path line 680 is rejecting it — `premiumHint` from "$.42" and market mid mismatch
3. The outcome is `MANUAL_REVIEW` (not EXECUTE), so the scorer sees no signals at all

**Most likely failure**: The `PREMIUM_RE` parses "$.42" correctly (group 1 captures "0.42" from the `\$` path... wait, let me re-check). PREMIUM_RE: `/(?:for\s+\$?|at\s+\$?|\$)(\d{0,4}\.\d+|\d{1,4})(?:\s*(?:credit|debit|cr|db))?|(\d{0,4}\.\d+|\d{1,4})\s+(?:credit|debit|cr|db)/i`

For "for $.42 Cr.":
- The `for\s+\$?` branch matches "for $", then `(\d{0,4}\.\d+)` matches ".42". Premium = 0.42.

Then at open-path.ts line 680-722, the premium validation fires:
- `parse.premiumHint = 0.42`, `strikeSelection.method = 'explicit'` (not premium_match)
- Gets option chain for AMZN on resolved expiry, computes spread mid
- If market mid is far from 0.42, returns MANUAL_REVIEW with `"Premium mismatch: stated 0.42 vs market mid X.XX"`

**Root cause**: The premium validation (5% tolerance) is too tight for PCS spread premiums, especially with old backtest data. The outcome becomes `MANUAL_REVIEW` instead of `EXECUTE`, so the scorer sees outcome mismatch and gets score=0. Since `mustMatch` includes `signals[0].legs[0].side`, but outcome != EXECUTE means no signals exist, the mustMatch check fails.

**But wait** — the eval fixture notes say "hard fail on signals[0].legs[0].side". If the outcome were MANUAL_REVIEW, the scorer would report score=0 from the outcome gate (scorer.ts line 284-298) with `hardFail: false` and no hardFailFields. The `resolveMustMatchPath` function (scorer.ts line 47-118) still runs though (line 372-376), and with no signals the actual would be `undefined` which wouldn't match `SELL`.

So the hard fail on `signals[0].legs[0].side` IS consistent with a MANUAL_REVIEW outcome where the premium validation rejected the trade. The legs were correctly built but the premium check killed it.

**Alternative possibility**: This is running against real Databento market data. On 2025-12-01 for Dec 5 expiry AMZN 227.5/225 puts, the market mid for the spread might legitimately differ from $0.42. The 5% tolerance (0.021) is very tight for spread pricing.

### Proposed fix
1. Widen premium validation tolerance for spreads (spreads have wider bid-ask than naked options). Consider 20-30% tolerance or absolute minimum of $0.10.
2. OR: When strategy is explicitly stated (PCS/CDS/PDS) and strikes are explicit, treat premiumHint as informational (for limit price) rather than a validation gate. The trader clearly stated what they want — don't second-guess them.

---

## Case 2: regression-006 — GLW PCS with ".63 credit"

### Input
- rawHtml: `Long <a data-symbol="GLW"><b>GLW</b></a> pcs 68/67 for .63 credit`
- cleanText: `"Long GLW pcs 68/67 for .63 credit"`
- badges: `[]` (no badge spans)
- symbols: `["GLW"]`

### Code path trace

1. **parser.ts**: PCS_RE matches "pcs" → `strategy = 'PCS'`.

2. **Direction**: Same as spreads-001, direction = `null` (PCS is not CALL/PUT/STOCK).

3. **Action**: No badges → no hasExitBadge, no hasLongBadge/hasShortBadge → action = `null` initially.
   - Line 362: `BOUGHT_BUYING_RE.test("Long GLW pcs 68/67 for .63 credit")` = false.
   - Line 364: `WROTE_WRITING_RE.test(...)` = false.
   - **Action remains `null`.**

4. **Strikes**: `extractStrikes("Long GLW pcs 68/67 for .63 credit")`:
   - SLASH_PAIR_RE matches "68/67" → `[68, 67]`.
   - `looksLikeDate(68, 67)`: 68 > 12 → false. So `best = [68, 67]`.
   - Strikes = `[68, 67]`. Good.

5. **Premium**: `extractPremium("Long GLW pcs 68/67 for .63 credit")`:
   - PREMIUM_RE: "for .63" matches via `for\s+\$?` branch → `(\d{0,4}\.\d+)` captures ".63" → premium = 0.63. Good.

6. **Orchestrator index.ts line 80**: `needsLLM = parse.complexityFlags.size > 0 || parse.action === null`. Since action is null, `needsLLM = true`.

7. **Goes to LLM path** (index.ts line 102-122).

### Root cause

The message has **no badges**. "Long" is just a plain text word (not a badge span). Without badges, the parser can't determine action. It doesn't have a fallback rule like "if strategy is detected and we have strikes, assume OPEN".

The LLM path then processes it, and the error "Premium mismatch: stated 0.63 vs market mid 0.16" comes from the premium validation in open-path.ts. This means:
1. LLM correctly identified it as OPEN + PCS
2. LLM signal was routed through open-path
3. open-path resolved expiry (no hint → defaulted to nearest expiry)
4. Premium validation compared 0.63 against market mid for the nearest expiry, which was only 0.16
5. The mismatch caused MANUAL_REVIEW

**Two issues**:
1. **Action detection gap**: When strategy keyword (PCS/CDS/PDS) is detected + symbol present + no exit indicators, the parser should infer `action = 'OPEN'` without needing badges. This is a very common pattern for no-badge messages.
2. **Premium validation too strict / wrong expiry**: The stated premium of $0.63 doesn't match any available expiry because (a) the test uses a generic timestamp 2025-09-05 which doesn't correspond to when GLW was actually at a price where 68/67 PCS would be worth $0.63, or (b) the nearest expiry was wrong.

### Proposed fix
1. **Parser**: After strategy detection, if `action === null` and we have a recognized strategy + symbol + no exit verbs, set `action = 'OPEN'`. This keeps the fast path and avoids the LLM.
2. **Premium validation**: Same fix as spreads-001 — widen tolerance or make it advisory for explicit-strike spreads.

---

## Case 3: spreads-004 — "bullish put spread" (PCS synonym)

### Input
- rawHtml: `<a data-symbol="WDC"><b>WDC</b></a>&nbsp;175/170 bullish put spread (Dec 26) for $1.16 credit`
- cleanText: `"WDC 175/170 bullish put spread (Dec 26) for $1.16 credit"`
- badges: `[]` (no badge spans)
- symbols: `["WDC"]`

### Code path trace

1. **Strategy detection** (parser.ts lines 274-296):
   - `CDS_RE.test(...)` = false
   - `PCS_RE = /\bpcs\b|put credit spread/i`. "bullish put spread" does NOT match (it's not "put credit spread").
   - `PDS_RE = /\bpds\b|put debit spread/i`. Does NOT match.
   - `LEAP_RE` = false
   - `LOTTO_RE` = false
   - `STOCK_RE` = false
   - `CALLS_RE.test("WDC 175/170 bullish put spread (Dec 26) for $1.16 credit")` = false
   - `PUTS_RE.test(...)`: matches "put" in "put spread" → true. `SPREAD_KW_RE.test(...)`: matches "spread" → true. So this `else if` is skipped (the guard `!SPREAD_KW_RE.test` fails).
   - **Strategy = `null`.**

2. **Direction**: With strategy null, direction stays null.

3. **Action**: No badges → `action = null`.

4. **Strikes**: SLASH_PAIR_RE matches "175/170" → `[175, 170]`. Not date-like. Good.

5. **Premium**: "for $1.16 credit" → PREMIUM_RE matches via `for\s+\$` → captures "1.16" → premium = 1.16.

6. **Orchestrator**: `needsLLM = true` (both action and strategy are null).

7. **LLM path**: The LLM receives the message with pre-parsed fields showing `strikes=175/170, premium=$1.16`. The LLM needs to identify this as a PCS.

8. **If LLM correctly identifies PCS**: Signal goes through open-path → spreadLegs('PCS', 175, 170) → SELL 175 / BUY 170. Correct.

9. **If LLM misidentifies as PDS**: spreadLegs('PDS', 175, 170) → BUY 175 / SELL 170. **Wrong sides.**

### Root cause

**`PCS_RE` is too narrow.** "bullish put spread" is a standard synonym for PCS (it's a bullish strategy using puts = selling a put spread for credit). The regex only matches the exact phrase "put credit spread" and the abbreviation "pcs".

The eval fixture notes say: `"'bullish put spread' is a PCS synonym not matched by PCS_RE"` and tags it `"llm-path"`, acknowledging this needs LLM. The hard fail on leg sides indicates the LLM chose the wrong strategy (likely PDS since "put spread" is in the text), producing wrong leg sides.

**The SPREAD_KW_RE** at line 33 does match "spread", which correctly prevents the message from being classified as naked PUT. But that leaves strategy=null, forcing the LLM path.

### Proposed fix

**Option A — Expand PCS_RE** to include known synonyms:
```
// Old:
const PCS_RE = /\bpcs\b|put credit spread/i;

// New:
const PCS_RE = /\bpcs\b|put credit spread|bullish put spread/i;
```

**Option B — Add "credit" keyword detection**: If the message says "put spread" + "credit", it's a PCS. If it says "put spread" + "debit", it's a PDS. Add a new detection branch after PCS/PDS regex checks:
```typescript
// After PCS_RE/PDS_RE checks, add:
if (!strategy && /\bput\s+spread\b/i.test(cleanText)) {
  if (/\bcredit\b/i.test(cleanText) || /\bbullish\b/i.test(cleanText)) {
    strategy = 'PCS';
  } else if (/\bdebit\b/i.test(cleanText) || /\bbearish\b/i.test(cleanText)) {
    strategy = 'PDS';
  }
}
```

Option B is more robust because it covers:
- "bullish put spread" → PCS
- "bearish put spread" → PDS
- "put spread for credit" → PCS
- "put spread for debit" → PDS

Similarly for call spreads:
- "bearish call spread" → CDS? No — bearish call spread is a call credit spread (not CDS). This needs thought. Actually:
  - CDS = call debit spread (bullish) = BUY lower CALL, SELL higher CALL
  - CCS (not in system) = call credit spread (bearish) = SELL lower CALL, BUY higher CALL
  - The system only supports CDS/PDS/PCS. A "bearish call spread" (CCS) would need a new strategy or mapping.

For now, Option B for puts is safe and covers the failing case.

---

## Brittleness Assessment

### 1. Premium validation is the biggest fragility
The 5% tolerance on premium validation (open-path.ts lines 569, 593, 703) is extremely tight for options, especially spreads. A $0.42 credit spread has a tolerance of $0.021 — a single penny of bid-ask slippage exceeds this. For backtest evals running against historical data at slightly different timestamps, this will frequently reject valid trades.

**Severity: HIGH** — This affects any spread case with a stated premium and any case where the test timestamp doesn't perfectly align with market data.

### 2. Action=null for no-badge strategy messages
Any message without badges that contains a clear strategy keyword (PCS/CDS/PDS) but no "bought"/"sold" verb falls to the LLM path unnecessarily. Examples:
- "Long GLW pcs 68/67 for .63 credit"
- "AMZN CDS 190/195 next week"

**Severity: MEDIUM** — Forces LLM dependency for easily-parsed messages.

### 3. PCS synonym coverage
Only "pcs" and "put credit spread" are recognized. Missing:
- "bullish put spread"
- "bull put spread"
- "short put spread"
- "put spread" + "credit" context

**Severity: MEDIUM** — These are real trader phrases.

### 4. Missing action inference for strategy keywords
The parser should infer OPEN when:
- Strategy keyword detected (PCS/CDS/PDS/CALL/PUT)
- Symbol present
- No exit badge
- No exit verb
This is a very high-confidence heuristic.

**Severity: LOW-MEDIUM** — Falls to LLM which usually handles it, but adds latency and cost.

---

## PCS Normalization Consideration

CLAUDE.md mentions `pcsNormalize` in `src/intents/postprocess.ts` that maps `PCS → {PDS, SHORT}`. This is referenced in the direction-derivation rules doc as a TODO.

**Current state**: The system keeps PCS as a first-class strategy. `spreadLegs('PCS', ...)` correctly produces SELL higher / BUY lower PUT legs. The direction on the trade record isn't explicitly set for spreads (open-path.ts line 366 defaults to LONG, but this only affects limitPrice sign via `buildLimitPrice`).

**Should PCS normalize to PDS+SHORT?** The argument:
- PCS and PDS are the same instrument (put spread) with opposite directions
- Normalizing simplifies downstream: all put spreads are PDS, direction distinguishes credit vs debit
- The `direction` field would then correctly reflect SHORT for credit spreads

**Counter-argument**:
- `spreadLegs()` already handles PCS correctly as its own strategy
- Normalizing adds a translation step that could introduce bugs
- The web UI and trade records currently store PCS as-is

**Recommendation**: Keep PCS as a first-class strategy in the parser and spreadLegs. The current approach works correctly when it reaches spreadLegs. The failures are from premium validation and missing synonyms, not from the PCS→legs mapping itself. If normalization is desired for the data model, do it at the `recordTrade` boundary, not in the orchestrator.

---

## Summary of Fixes

| Case | Root Cause | Fix |
|---|---|---|
| spreads-001 | Premium validation too strict (5% of $0.42 = $0.021 tolerance) | Widen to min($0.15, 30%) for spreads; or skip validation when strikes are explicit |
| regression-006 | No badges → action=null → LLM path → wrong expiry → premium mismatch | (1) Infer action=OPEN when strategy keyword + symbol + no exit. (2) Widen premium tolerance |
| spreads-004 | "bullish put spread" not matched by PCS_RE | Add `bullish put spread` synonym + general `put spread` + credit/debit disambiguation |
