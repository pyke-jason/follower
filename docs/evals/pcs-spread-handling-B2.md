# PCS/Spread Handling Analysis (B2)

## spreads-001: AMZN PCS wrong leg sides

### Test case
- Input: `Sold Dec (5) $227.50/225 PCS for $.42 Cr.`
- Badges: `["Long"]`
- Expected: SELL 227.5 PUT / BUY 225 PUT

### What `spreadLegs('PCS', 227.5, 225)` returns

Reading `spread-legs.ts:39-43`:
```ts
if (strategy === 'PCS') {
    return [
      { strike: hi, action: 'SELL', optionType: 'PUT' },   // hi = 227.5 → SELL
      { strike: lo, action: 'BUY', optionType: 'PUT' },    // lo = 225   → BUY
    ];
}
```
`hi = Math.max(227.5, 225) = 227.5`, `lo = Math.min(227.5, 225) = 225`.
Result: **SELL 227.5 PUT, BUY 225 PUT** — this is CORRECT.

### Data flow trace

1. **Parser** (`parser.ts:276-277`): `PCS_RE` matches "PCS" in cleanText → `strategy = 'PCS'`, `directionFromStrategy = null` (no explicit assignment for PCS).

2. **Direction**: At line 300, `direction = directionFromStrategy = null`. PCS falls through all the if/else blocks (lines 302-324) because it's not lotto, not STOCK, not CALL/PUT. The comment at line 325 says "For CDS/PDS: directionFromStrategy already set definitively; don't override" — but PCS is NOT mentioned. **PCS direction stays `null`**.

3. **Parser output**: `{ strategy: 'PCS', direction: null, strikes: [227.5, 225], ... }`

4. **Orchestrator index** (`index.ts:82-88`): `parse.action = 'OPEN'` (Long badge at line 348), no complexity flags → routes to `resolveOpenPath`.

5. **Open-path** (`open-path.ts:355-363`): `isSpread(strategy)` is true for PCS → skips direction validation (line 359).

6. **Direction fallback** (`open-path.ts:366`): `const direction = parse.direction ?? 'LONG'` — since parse.direction was null for PCS, it defaults to 'LONG'. This is used later only for non-spread legs and for `buildLimitPrice`.

7. **Leg construction** (`open-path.ts:428-441`): Explicit strikes `[227.5, 225]` → calls `spreadLegs('PCS', 227.5, 225)`. As analyzed above, this returns correct SELL 227.5 / BUY 225.

### Verdict: spreads-001 SHOULD PASS

The `spreadLegs` function handles PCS correctly. The sides are SELL hi / BUY lo which matches the expected output. **If this test is failing, the issue is elsewhere** — possibly:
- The `$.42` premium might confuse the parser (dollar-sign before decimal with no leading digit)
- The `cleanText` extraction from `rawHtml` might be mangling the input
- The slash pair `227.50/225` could be getting intercepted as an expiry date

Let me check the last point: `looksLikeDate(227.5, 225)` → `227.5 >= 1 && 227.5 <= 12` is FALSE (227.5 > 12). So the date disambiguation at lines 384-397 won't trigger. Strikes are preserved.

For premium: `$.42` — PREMIUM_RE is `/(?:for\s+\$?|at\s+\$?|\$)(\d{0,4}\.\d+|\d{1,4})(?:\s*(?:credit|debit|cr|db))?|...$/i`. The `$` trigger matches, then `(\d{0,4}\.\d+|\d{1,4})` needs to match `.42`. With `\d{0,4}`, zero digits before decimal is allowed, so `.42` matches `\d{0,4}\.\d+` (0 digits + "." + "42"). **Premium extraction works for `$.42`**.

But wait — `$227.50` also matches `\$(\d{0,4}\.\d+|\d{1,4})` via DOLLAR_STRIKE_RE on the first pass of strike extraction. The PREMIUM_RE will match `$` followed by the FIRST number it sees — which is `$227.50`, not `$.42`. Let me re-check: PREMIUM_RE uses `exec` which finds the first match. In `"Sold Dec (5) $227.50/225 PCS for $.42 Cr."`, the first `$` is at `$227.50`. So PREMIUM_RE would match `$227.50` and extract `227.50` as the premium. Then the sanity check at lines 405-407 catches this: `if (premiumHint !== null && strikes !== null && strikes.includes(premiumHint))` — `strikes = [227.5, 225]` and `premiumHint = 227.5`, so 227.5 IS in strikes → `premiumHint = null`. Then... the second `$.42` is never tried because PREMIUM_RE only does one exec.

Actually, re-reading PREMIUM_RE more carefully: it's `/(?:for\s+\$?|at\s+\$?|\$)(\d{0,4}\.\d+|\d{1,4})...`. The alternatives are `for $`, `at $`, or bare `$`. The bare `$` will match `$227.50` first. But `for $.42` would also match via the `for\s+\$?` path. Since regex finds the earliest match position, `$227.50` appears earlier in the string, so it wins. Premium gets set to 227.5, then nullified by the strike-collision check.

**The premium `.42` is lost.** This isn't a blocking issue for leg sides though — it just means no premium validation happens. The legs themselves should still be correct from explicit strikes.

**Conclusion: spreads-001 legs should be correct. If the test fails, the problem is not in spreadLegs or PCS logic.**

---

## regression-006: ".63" premium parsing

### Test case
- Input: `Long GLW pcs 68/67 for .63 credit`
- No badges (raw HTML has no badge spans)
- Expected: SELL 68 PUT / BUY 67 PUT (SPREAD)

### Strike extraction: `68/67`

`extractStrikes` finds slash pair `68/67` → `s1=68, s2=67`. Then `looksLikeDate(68, 67)` → `68 >= 1 && 68 <= 12` is FALSE. Strikes are kept as `[68, 67]`.

Wait — but the function is:
```ts
function looksLikeDate(a: number, b: number): boolean {
  return Number.isInteger(a) && Number.isInteger(b) && a >= 1 && a <= 12 && b >= 1 && b <= 31;
}
```
68 > 12, so NOT a date. Good, strikes preserved.

### Premium extraction: "for .63"

PREMIUM_RE: `/(?:for\s+\$?|at\s+\$?|\$)(\d{0,4}\.\d+|\d{1,4})(?:\s*(?:credit|debit|cr|db))?|(\d{0,4}\.\d+|\d{1,4})\s+(?:credit|debit|cr|db)/i`

The text contains `"for .63 credit"`. The `for\s+\$?` trigger matches `"for "`, then `(\d{0,4}\.\d+|\d{1,4})` tries to match `.63`. With `\d{0,4}` (zero-to-four digits), zero digits is valid, so `.63` matches `\d{0,4}\.\d+`. **Premium extraction works: premiumHint = 0.63**.

Premium collision check: `strikes = [68, 67]`, `premiumHint = 0.63`. `0.63` is NOT in `[68, 67]` → premium preserved.

### Strategy detection

`PCS_RE = /\bpcs\b|put credit spread/i` — "pcs" matches via `\bpcs\b`. Strategy = PCS.

### Direction

PCS has no `directionFromStrategy` assignment → direction stays null. Then falls through all if/else → remains null.

### Action detection

No badges present in this raw HTML. Lines 348-366: no Exit/Long/Short badge → check soft detection. `BOUGHT_BUYING_RE` doesn't match. `WROTE_WRITING_RE` doesn't match. No explicit "sold". So `action = null`.

**Critical issue**: With `action = null`, the orchestrator at `index.ts:80` sets `needsLLM = true` (because `parse.action === null`). This routes to the LLM path at line 102, NOT the deterministic open-path.

If no LLM provider is supplied (as in evals), this returns MANUAL_REVIEW with reason "Requires NLU (action=null) but no LLM provider available".

### The real problem for regression-006

The input `"Long GLW pcs 68/67 for .63 credit"` has no badge spans — `"Long"` appears as plain text, not as a `<span class="badge">`. The parser checks `badges.includes('Long')` but badges array will be empty (no badge HTML).

Without badges, the parser can't determine `action = 'OPEN'`, so `action = null` → LLM path → MANUAL_REVIEW (if no LLM) or depends on LLM output.

**Fix needed**: The parser should detect plain-text "Long" or "Short" as open-action indicators when no badges are present, OR the parser needs verb-based heuristics (like "pcs" keyword implies OPEN action when no exit context is present).

### Premium parsing is NOT the issue

The `.63` format does match PREMIUM_RE. The issue is purely action routing — the message never reaches open-path.

---

## spreads-004: "bullish put spread" not matched

### Test case
- Input: `WDC 175/170 bullish put spread (Dec 26) for $1.16 credit`
- No badges
- Expected: SELL 175 PUT / BUY 170 PUT (SPREAD)

### Strategy detection trace

Walking through parser.ts lines 274-296:
1. `CDS_RE = /\bcds\b|call debit spread/i` — "bullish put spread" → NO match
2. `PCS_RE = /\bpcs\b|put credit spread/i` — "bullish put spread" → NO match ("put credit" vs "bullish put")
3. `PDS_RE = /\bpds\b|put debit spread/i` — "bullish put spread" → NO match ("put debit" vs "bullish put")
4. `LEAP_RE = /\bleaps?\b/i` → NO
5. `LOTTO_RE` → NO
6. `STOCK_RE` → NO
7. `CALLS_RE.test(cleanText) && !SPREAD_KW_RE.test(cleanText)` — no "call" keyword → NO
8. `PUTS_RE.test(cleanText) && !SPREAD_KW_RE.test(cleanText)` — "put" matches PUTS_RE. Check SPREAD_KW_RE: `/\bcds\b|\bpcs\b|\bpds\b|call debit spread|put credit spread|put debit spread|\bspread\b/i` — "spread" matches `\bspread\b`. So `!SPREAD_KW_RE.test(cleanText)` is FALSE → this branch is skipped.

**Result: `strategy = null`**

Since no strategy is detected, the parser returns `strategy: null`. In open-path, this hits the validation at line 347-349: "OPEN signal missing strategy" → MANUAL_REVIEW.

But actually it's worse — without badges, `action = null` too. So it routes to LLM path first, and then depends entirely on LLM resolution.

### What should happen

"bullish put spread" is a common synonym for PCS (put credit spread). The eval fixture notes (line 97) acknowledge: "This case likely requires the LLM path to resolve correctly."

However, for the deterministic parser, the fix is straightforward:
- Add `bullish put spread` to PCS_RE: `/\bpcs\b|put credit spread|bullish put spread/i`
- Or more generally, add a pattern for "bullish" + "put" + "spread" → PCS
- Also consider "bearish call spread" → ??? (not currently seen but analogous)

### Slash pair disambiguation

`175/170` — `looksLikeDate(175, 170)` → 175 > 12 → NOT a date. Strikes preserved correctly.

### Expiry: "(Dec 26)"

`EXPIRY_MONTH_DAY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\(?\s*(\d{1,2})\s*\)?/i`

Wait, this regex doesn't have `\(?` and `\)?`. Let me re-read line 60: `EXPIRY_MONTH_DAY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\(?\s*(\d{1,2})\s*\)?/i` — actually no, looking at the actual code at line 60, it's `/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\(?\s*(\d{1,2})\s*\)?/i`.

Hmm, let me re-read: line 60 is `const EXPIRY_MONTH_DAY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\(?\s*(\d{1,2})\s*\)?/i;`

Wait — the actual pattern shown at line 60 is:
```
/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\(?\s*(\d{1,2})\s*\)?/i
```

Hmm no, let me look at `extractExpiryHint` more carefully. At line 200-202:
```ts
const mdM = EXPIRY_MONTH_DAY_RE.exec(text);
if (mdM) return `${mdM[1]} ${mdM[2]}`;
```

For "(Dec 26)" — BUT `EXPIRY_SLASH_DATE_RE` at line 59 is checked first: `/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/`. Does "175/170" match? Yes — but in `extractExpiryHint`, the match is validated: `mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31`. For 175/170: `175 >= 1 && 175 <= 12` → FALSE. So the slash date doesn't match as an expiry.

Then `EXPIRY_MONTH_DAY_RE`: "Dec" matches the month group, then `\s*\(?\s*` matches ` (`, then `(\d{1,2})` matches `26`. Returns `"Dec 26"`. Expiry hint is resolved.

### Summary for spreads-004

- **Strategy**: Not detected (PCS_RE doesn't match "bullish put spread")
- **Action**: Not detected (no badges, no authoritative verb for OPEN)
- **Both null → LLM path required**
- The eval notes acknowledge this is an LLM-path case
- Deterministic fix: add "bullish put spread" to PCS_RE

---

## pcsNormalize postprocess: NOT IMPLEMENTED

Searched entire `src/` for `pcsNormalize` — **zero results**. The CLAUDE.md direction-derivation rules reference it as `pcsNormalize in src/intents/postprocess.ts (TODO)`, but no file `postprocess.ts` exists in the orchestrator path, and no function by that name exists anywhere.

The design intent was: PCS → {PDS, SHORT} — i.e., normalize PCS into PDS (strategy) with SHORT (direction) so downstream code only deals with debit spreads. This is **not how the current code works**. Instead:

- `spreadLegs()` handles PCS directly as its own strategy (SELL hi / BUY lo PUT)
- The parser leaves PCS direction as `null`
- The open-path defaults direction to `'LONG'` for spreads (line 366), but this is only used for `buildLimitPrice` and non-spread legs
- `buildLimitPrice` correctly checks `isCreditStrategy(strategy)` which returns true for PCS (line 36), so limit price sign is negative (credit)

**The lack of pcsNormalize is not causing failures** because:
1. `spreadLegs('PCS', ...)` directly produces correct SELL/BUY legs
2. `isCreditStrategy('PCS')` handles limit price sign
3. Direction isn't needed for spread leg construction

---

## Summary of Root Causes

| Case | Root Cause | Severity |
|------|-----------|----------|
| spreads-001 | **Likely passes.** spreadLegs handles PCS correctly. If failing, check cleanText extraction from HTML. | Low — needs verification |
| regression-006 | **action=null** because "Long" is plain text, not a badge span. Parser needs verb/keyword-based OPEN detection. | High — blocks deterministic path |
| regression-006 | Premium `.63` parses correctly via `\d{0,4}\.\d+` | Non-issue |
| regression-006 | Strike `68/67` is NOT confused as date (68 > 12) | Non-issue |
| spreads-004 | **strategy=null** because "bullish put spread" not in PCS_RE. Also action=null (no badges). | Medium — LLM path expected per fixture notes |
| pcsNormalize | Not implemented, but not needed — `spreadLegs` handles PCS natively. | Non-issue |

## Recommended Fixes

1. **PCS_RE expansion**: Add `bullish put spread` to the pattern:
   ```ts
   const PCS_RE = /\bpcs\b|put credit spread|bullish put spread/i;
   ```

2. **Keyword-implies-OPEN heuristic**: When strategy is detected (PCS/CDS/PDS) and action is null and there's no exit context, infer `action = 'OPEN'`. A spread keyword with strikes strongly implies opening a new position.

3. **Plain-text "Long"/"Short" as soft OPEN signal**: When no badges are present but "Long" or "Short" appears as plain text before ticker, treat as a soft OPEN indicator (lower confidence than badge).

4. **Consider "bearish call spread"** as CDS synonym for completeness (though no eval case exists yet).
