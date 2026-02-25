# Sold-Verb Parsing: Root Cause Analysis (Agent A1)

## Group 1: "sold" + premium_mismatch (direction-001, direction-006, regression-001)

### Failing messages

- direction-001 / regression-001: `"Long HUT sold the 12/19 $36 puts for a credit of $0.88/contract"`
- direction-006: `"Long IREN sold the 12/19 $40 puts for a credit of $1.15/contract"`

### Root cause

The failure chain has **three interacting steps**, not one:

**Step 1: `extractStrikes` returns the date as a slash pair.**

`SLASH_PAIR_RE` matches `12/19` as `[12, 19]`. Because there is no non-date slash pair, this date-like pair is returned as the `fallback`. The function returns `[12, 19]` immediately — it never reaches `STRIKE_NEAR_OPTION_RE` which would correctly find `$36 puts` → strike 36.

Location: `parser.ts:141-178`, specifically the fallback return at line 158.

**Step 2: Post-processing nullifies the date-like strikes.**

Lines 384-397 correctly detect that `[12, 19]` looks like a date and the strategy is not a spread, so `strikes = null`. This is correct behavior for date disambiguation, but it leaves the real strike (`$36`) undiscovered.

**Step 3: `PREMIUM_RE` captures `$36` as the premium.**

`PREMIUM_RE` matches `$36` (bare `$` trigger + `\d{1,4}`) before it reaches `$0.88`. The dedup check at line 405 (`strikes.includes(premiumHint)`) cannot fire because `strikes` is already `null` from Step 2.

Result: `premiumHint = 36`, `strikes = null`, `strikesFromParse` returns `{ method: 'premium_match', statedPremium: 36 }`.

**Step 4: open-path premium scan fails.**

`resolveOpenPath` enters the premium-match scan at line 627. It scans option chains looking for a strike whose market mid is ~$36.00. The actual premium for HUT $36 puts is ~$0.88. Tolerance is `36 * 0.05 = 1.80`. The diff is `|market_mid - 36| ≈ 35.12`, far exceeding tolerance. Returns `premium_mismatch`.

### Proposed fix

The core problem is that `extractStrikes` returns the slash-pair fallback (a date) instead of continuing to check `STRIKE_NEAR_OPTION_RE`. The fix: when a slash pair is date-like, skip it for non-spread strategies and continue to the next extraction method.

**Option A (minimal): Don't return date-like fallback when STRIKE_NEAR would find something.**

```typescript
// parser.ts extractStrikes() — old (lines 157-158):
if (best) return best;
if (fallback) return fallback;

// parser.ts extractStrikes() — new:
if (best) return best;

// Before using date-like fallback, check if STRIKE_NEAR finds a real strike
const nearM = STRIKE_NEAR_OPTION_RE.exec(text);
if (nearM) {
  const s = parseFloat(nearM[1]);
  if (isFinite(s) && s >= 1) return [s];
}

if (fallback) return fallback;
```

**Option B (better): Restructure extractStrikes to not treat date-like pairs as strikes at all.**

Only use the slash pair path when both values are plausible strikes (i.e., both >= some threshold like 10, or the text contains a spread keyword). Date-like pairs should be left entirely to `extractExpiryHint`. This avoids the current two-phase "extract then nullify" pattern.

```typescript
// parser.ts extractStrikes() — replace fallback logic:
// Only keep slash pair if at least one number is > 31 (can't be a date component)
// or if a spread keyword is present in the text
while ((m = pairRe.exec(text)) !== null) {
  const s1 = parseFloat(m[1]);
  const s2 = parseFloat(m[2]);
  if (!isFinite(s1) || !isFinite(s2)) continue;
  if (!looksLikeDate(s1, s2)) {
    best = [s1, s2];
    break;
  }
  // Date-like pairs are NOT kept as fallback — expiry handles them
}
// Continue to STRIKE_NEAR_OPTION_RE...
```

I prefer **Option B** because it removes the confusing extract-then-nullify pattern and avoids the downstream dedup failure.

Additionally, `PREMIUM_RE` should be hardened to not match `$XX` when immediately followed by a strategy keyword (puts/calls/p/c). But this is a defense-in-depth measure, not the primary fix.

### Brittleness assessment

- Option A: Low risk. STRIKE_NEAR already handles the "$36 puts" pattern correctly. The only risk is a case where a date-like slash pair IS actually strikes for a cheap stock — but those are already handled by the spread-detection code at lines 384-397.
- Option B: Moderate risk. Removing the fallback entirely means any legitimate cheap-stock spread with date-like strikes (e.g., `SIRI 5/4 pds`) would need the spread keyword to be present. This is already required by lines 384-397, so no behavioral change.
- Both options are safe for direction-003 (`$12 puts @ $.50`) and direction-005 (`12/26 40 put at 1.68`) because those don't have a date-ambiguous slash pair preceding the real strike.


## Group 2: Wrong strategy classification (direction-002, direction-004)

### Failing messages

- direction-002: `"Long Sold BMNR Dec (19) $32.50 puts @ $1.14. That would make me long stock < AVWAPE if I am assigned..."`
- direction-004: `"Long EOSE Sold Dec (26) $13.50 puts @ $.55. Would I buy the stock at $12.95?..."`

### Root cause

**Two independent bugs conspire to route these to the LLM path, where the LLM misclassifies them.**

**Bug 1: `STOCK_RE` matches commentary text.**

`STOCK_RE = /\bstocks?\b|\bshares?\b/i` matches "stock" in Pete's educational commentary:
- direction-002: "...make me long **stock** < AVWAPE..."
- direction-004: "...buy the **stock** at $12.95..."

In the strategy if-else chain (lines 274-296), `STOCK_RE` is checked at line 287 — **before** `PUTS_RE` at line 293. So `strategy = 'STOCK'` instead of `'PUT'`.

Location: `parser.ts:287` — `STOCK_RE` fires before `PUTS_RE`.

**Bug 2: `extra_text` flag routes to LLM path.**

Both messages have word count >> 15 (33 and 59 respectively). With `action = 'OPEN'` (from Long badge) and `strategy = 'STOCK'` (false positive), the `extra_text` flag fires at line 411. This sets `needsLLM = true`.

In the LLM path, the model receives the pre-parsed fields including `strategy=STOCK` and the complexity flag. The LLM apparently re-classifies as PDS (perhaps interpreting "sold puts" as a put debit spread), and returns that to `routeLLMSignals`. The open-path then fails because PDS requires 2 strikes but only 1 was found.

**Even without the LLM misclassification**, Bug 1 alone would cause a wrong result: the parser would produce `strategy=STOCK, direction=SHORT` (SOLD verb overrides LONG badge for STOCK), which is "short stock" — completely wrong for "sold puts".

### Proposed fix

**Fix the strategy detection order: check option keywords before STOCK_RE.**

The issue is that `STOCK_RE` is a broad pattern that matches commentary. Options keywords ("puts", "calls") are more specific and should take precedence.

```typescript
// parser.ts strategy detection — old order (lines 274-296):
// CDS → PCS → PDS → LEAP → LOTTO → STOCK → CALLS → PUTS

// parser.ts strategy detection — new order:
// CDS → PCS → PDS → LEAP → LOTTO → CALLS → PUTS → STOCK
```

Move the STOCK check to AFTER CALLS and PUTS:

```typescript
// Old (line 287-289):
  } else if (STOCK_RE.test(cleanText)) {
    strategy = 'STOCK';
    directionFromStrategy = null;
  } else if (CALLS_RE.test(cleanText) && !SPREAD_KW_RE.test(cleanText)) {

// New — move STOCK after PUTS:
  } else if (CALLS_RE.test(cleanText) && !SPREAD_KW_RE.test(cleanText)) {
    strategy = 'CALL';
    directionFromStrategy = 'LONG';
  } else if (PUTS_RE.test(cleanText) && !SPREAD_KW_RE.test(cleanText)) {
    strategy = 'PUT';
    directionFromStrategy = 'LONG';
  } else if (STOCK_RE.test(cleanText)) {
    strategy = 'STOCK';
    directionFromStrategy = null;
  }
```

With this fix:
- direction-002: `PUTS_RE` matches first → `strategy = 'PUT'`, `direction = 'SHORT'` (SOLD verb). Word count still triggers `extra_text`, but the pre-parsed fields sent to LLM now say `strategy=PUT, direction=SHORT` — the LLM is much less likely to override to PDS.
- direction-004: Same fix path.

**Alternative: Make STOCK_RE more restrictive.** Add negative lookahead/lookbehind to exclude "buy the stock", "long stock" patterns. But this is fragile; the real issue is ordering.

### Brittleness assessment

- Reordering STOCK after CALLS/PUTS is safe. Any message that genuinely mentions "stock" or "shares" as the traded instrument will not also contain "puts" or "calls" (those are mutually exclusive strategies). The only risk is a message like "sold the stock and bought puts" — a multi-trade message that would already trigger `multi_ticker` or `mixed_action` complexity flags.
- The `extra_text` routing to LLM path is still triggered for these long messages, but with correct pre-parsed strategy=PUT, the LLM will get better guidance.


## Group 3: Bare "P" abbreviation (direction-007)

### Failing message

- direction-007: `"Long HUT $34 P Sold 12/19/25 at 0.81. Going bit deeper ITM to be below the 100-SMA line."`

### Root cause

`PUTS_RE = /\bputs?\b/i` requires at least "put" — it does not match bare "P" or "C". The strategy detection chain finds no match for any strategy, so `strategy = null`.

With `action = 'OPEN'` (from Long badge) and `strategy = null`, the message goes straight to the open-path which immediately returns `MANUAL_REVIEW: "OPEN signal missing strategy"`.

Interestingly, `STRIKE_NEAR_OPTION_RE = /\$?(\d{2,5}(?:\.\d+)?)\s*(?:calls?|puts?|[cp]\b)/i` already handles bare `P` via the `[cp]\b` alternative — it correctly matches `$34 P`. But this regex is only used for strike extraction, not strategy detection.

Location: `parser.ts:35` — `PUTS_RE` doesn't cover bare "P"/"C" abbreviations.

### Proposed fix

Extend `PUTS_RE` and `CALLS_RE` to match bare single-letter abbreviations:

```typescript
// Old (lines 34-35):
const CALLS_RE = /\bcalls?\b/i;
const PUTS_RE = /\bputs?\b/i;

// New:
const CALLS_RE = /\bcalls?\b|\bc\b(?=\s|$)/i;
const PUTS_RE = /\bputs?\b|\bp\b(?=\s|$)/i;
```

Wait — `\bp\b` would also match "P" in random words. The bare "P" abbreviation in trading messages is typically adjacent to a strike price: `$34 P`. A safer approach:

```typescript
// Only match bare P/C when preceded by a dollar amount (strike context)
const PUTS_RE = /\bputs?\b/i;
const CALLS_RE = /\bcalls?\b/i;
const BARE_P_RE = /\$\d+(?:\.\d+)?\s+P\b/i;
const BARE_C_RE = /\$\d+(?:\.\d+)?\s+C\b/i;
```

Then in strategy detection, after the PUTS/CALLS checks, add:

```typescript
  } else if ((PUTS_RE.test(cleanText) || BARE_P_RE.test(cleanText)) && !SPREAD_KW_RE.test(cleanText)) {
    strategy = 'PUT';
    directionFromStrategy = 'LONG';
  } else if ((CALLS_RE.test(cleanText) || BARE_C_RE.test(cleanText)) && !SPREAD_KW_RE.test(cleanText)) {
    strategy = 'CALL';
    directionFromStrategy = 'LONG';
  }
```

**Simpler alternative:** Since `STRIKE_NEAR_OPTION_RE` already handles `[cp]\b`, we could add a fallback after the main strategy detection:

```typescript
// After all strategy checks, if strategy is still null but STRIKE_NEAR found an option type:
if (strategy === null) {
  const nearOptionM = STRIKE_NEAR_OPTION_RE.exec(cleanText);
  if (nearOptionM) {
    const matched = nearOptionM[0].toLowerCase();
    if (/p\b/.test(matched)) { strategy = 'PUT'; directionFromStrategy = 'LONG'; }
    else if (/c\b/.test(matched)) { strategy = 'CALL'; directionFromStrategy = 'LONG'; }
  }
}
```

I prefer the simpler alternative — it reuses the existing regex and only fires as a fallback.

### Brittleness assessment

- Risk of false positives from bare "P"/"C": Low when gated behind strike context (`$XX P`). The word "P" alone doesn't appear in typical trading commentary.
- Risk of missing: Messages with bare P/C without a preceding dollar sign (e.g., "HUT 34P") would still miss. But `STRIKE_NEAR_OPTION_RE` doesn't require `$` either — it has `\$?` — so the fallback approach handles this.
- The fallback approach is conservative: it only triggers when no other strategy was detected.


## Group 4: "tomorrow" expiry (direction-011, regression-003)

### Failing message

- direction-011 / regression-003: `"Sold 10 $180 Puts on NVDA for $1.80 - expiring tomorrow"`

### Root cause

**Two independent bugs:**

**Bug 1: No "tomorrow" pattern in `extractExpiryHint`.**

The parser's `extractExpiryHint` function (lines 183-208) handles: 0DTE, LEAP, overnight, next friday, this week, next week, slash dates, month+day, bare month. It does NOT handle "tomorrow". The function returns `null` for this text.

Similarly, `resolveExpiryHint` (open-path.ts lines 133-236) has no "tomorrow" handler. If the LLM returns `expiryHint: "tomorrow"`, `resolveExpiryHint` returns `null` → `MANUAL_REVIEW: "Could not interpret expiryHint: \"tomorrow\""`.

Location: `parser.ts:183-208` — missing TOMORROW pattern. `open-path.ts:133-236` — missing "tomorrow" case.

**Bug 2: `SOLD_RE` doesn't trigger `action = 'OPEN'` for no-badge messages.**

This message has no badges (`badges = []`). The action detection code (lines 327-368) for no-badge messages checks:
- `EXIT_VERB_RE` — matches "sold out", "closed", "exiting", etc. but NOT bare "sold"
- `BOUGHT_BUYING_RE` — no match
- `WROTE_WRITING_RE` — no match
- `/\b(adding|opened)\b/i` — no match

Result: `action = null`, which means `needsLLM = true`. The message routes to the LLM path. The LLM correctly identifies it as OPEN + PUT + SHORT, but returns `expiryHint: "tomorrow"` which fails in `resolveExpiryHint`.

Location: `parser.ts:348-368` — `SOLD_RE` not used for action detection in no-badge path.

### Proposed fix

**Fix 1: Add "tomorrow" pattern to both parser and resolver.**

Parser:

```typescript
// parser.ts — add between EXPIRY_OVERNIGHT_RE and EXPIRY_NEXT_FRIDAY_RE:
const EXPIRY_TOMORROW_RE = /\btomorrow\b/i;

// In extractExpiryHint, after the overnight check:
  if (EXPIRY_TOMORROW_RE.test(text)) return 'tomorrow';
```

Resolver:

```typescript
// open-path.ts resolveExpiryHint — add after "overnight" case (line 151):
  // "tomorrow" → next business day (same as overnight)
  if (normalized === 'tomorrow') {
    return dateToYMD(addBusinessDays(messageDate, 1));
  }
```

Note: "tomorrow" and "overnight" are semantically identical for option expiry purposes (next business day). They could share the same handler. However, "overnight" specifically means holding overnight and closing next day, while "tomorrow" means expiring tomorrow. In both cases the expiry date is the next business day.

**Fix 2: Add `SOLD_RE` to no-badge action detection.**

```typescript
// parser.ts lines 362-367 — add SOLD_RE as an OPEN trigger for no-badge:
    } else if (BOUGHT_BUYING_RE.test(cleanText) || /\b(adding|opened)\b/i.test(cleanText)) {
      action = 'OPEN';
    } else if (WROTE_WRITING_RE.test(cleanText)) {
      action = 'OPEN';
    } else if (SOLD_RE.test(cleanText) && !EXIT_VERB_RE.test(cleanText) && symbol !== null) {
      // "sold [X] puts" with no badge = sell-to-open (not an exit)
      action = 'OPEN';
    }
```

The guard `!EXIT_VERB_RE.test(cleanText) && symbol !== null` prevents false positives:
- "sold out of AAPL" → EXIT_VERB_RE matches "sold out" → excluded
- "I sold my car" → no symbol detected → excluded
- "Sold 10 $180 Puts on NVDA" → SOLD + symbol NVDA + no exit verb → action = OPEN

### Brittleness assessment

- Adding "tomorrow" is very safe — it's an unambiguous English word with exactly one meaning in expiry context. No false positive risk.
- Adding SOLD_RE to no-badge action detection carries moderate risk: some "sold" messages without badges could be exit reports (closing an existing position). The guard conditions mitigate this, but messages like "I sold my NVDA puts" (meaning close, not open) could be misclassified. However, the EXIT_VERB_RE already handles "sold out" and the position-path would catch misrouted closes via position matching. This is acceptable.


## Cross-Group Interactions

### Group 1 fix interacts with Group 3

Both involve `extractStrikes`. The Group 1 fix (don't use date-like slash pairs as fallback) changes what `extractStrikes` returns for messages with dates and strikes. The Group 3 fix (bare P/C detection) is independent — it's in strategy detection, not strike extraction. No conflict.

### Group 2 fix interacts with Group 4

Both involve strategy/action detection ordering:
- Group 2: Move STOCK after PUTS/CALLS
- Group 4: Add SOLD_RE to action detection

These are in different code sections (strategy detection vs action detection) and don't conflict. However, if Group 2's fix is applied, direction-002/004 might still route to LLM path (due to extra_text) — the LLM would now receive correct pre-parsed fields `strategy=PUT, direction=SHORT`, which should produce correct results. The Group 4 fix for SOLD action detection is orthogonal.

### Premium extraction improvement benefits all groups

If `PREMIUM_RE` were improved to skip `$XX` when it's clearly a strike (immediately followed by puts/calls/p/c), Groups 1 and 6 would benefit as defense-in-depth. The regex change:

```typescript
// Negative lookahead to skip $XX immediately before option type keywords
const PREMIUM_RE =
  /(?:for\s+\$?|at\s+\$?|\$(?!\d+(?:\.\d+)?\s*(?:puts?|calls?|[cp]\b)))(\d{0,4}\.\d+|\d{1,4})(?:\s*(?:credit|debit|cr|db))?|(\d{0,4}\.\d+|\d{1,4})\s+(?:credit|debit|cr|db)/i;
```

This is complex and error-prone. I recommend it only as a secondary fix after the primary `extractStrikes` fix.

### Summary of all fixes

| Group | Primary Fix | File | Lines | Risk |
|-------|-----------|------|-------|------|
| 1 | Don't return date-like slash pair when STRIKE_NEAR finds a strike | parser.ts | 141-178 | Low |
| 2 | Reorder: CALLS/PUTS before STOCK in strategy detection | parser.ts | 274-296 | Low |
| 3 | Fallback bare P/C detection from STRIKE_NEAR_OPTION_RE | parser.ts | after 296 | Low |
| 4a | Add EXPIRY_TOMORROW_RE + resolver case | parser.ts + open-path.ts | 183-208, 133-236 | Very low |
| 4b | Add SOLD_RE as OPEN trigger for no-badge messages | parser.ts | 362-367 | Moderate |
