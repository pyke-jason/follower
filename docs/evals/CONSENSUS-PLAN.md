# Orchestrator Eval Consensus Plan

Produced by synthesizing reports from 8 investigation agents across 4 workstreams.

---

## Part 1: Agent Agreement Matrix

### Workstream A: Sold-Verb Parsing (A1 + A2)

| Topic | A1 Position | A2 Position | Resolution |
|-------|-------------|-------------|------------|
| direction-001/006 root cause | `extractStrikes` returns date-like slash pair `[12, 19]`, blocks real strike `$36`; then PREMIUM_RE captures `$36` as premium -> premium_mismatch in open-path | Parser produces correct `strategy=PUT, direction=SHORT, strikes=[36]`; failure is premium validation tolerance (5% of $0.88 = $0.044) too tight for explicit strikes | **DISAGREE.** A1 found a path where STRIKE_NEAR catches `$36`; A2 confirmed that path succeeds. Both agree the PREMIUM_RE capturing `$36` is the secondary issue. The primary failure is the **premium validation tolerance** (5% is too tight for explicit-strike signals). A2's trace is more thorough -- the parser DOES produce strikes=[36] via STRIKE_NEAR_OPTION_RE after slash-pair date disambiguation. The premium validation at open-path:680-722 then rejects because market mid differs from $0.88 by >$0.044. **Resolution: A2 is correct. Skip premium validation when `strikeSelection.method === 'explicit'`.** A1's extractStrikes fix is also valid as defense-in-depth for other cases. |
| direction-002/004 root cause | STOCK_RE matches commentary "stock"; fires before PUTS_RE in if-else chain | Same analysis, same conclusion | **CONSENSUS.** Reorder: CALLS/PUTS before STOCK in strategy detection. |
| direction-007 root cause | Bare "P" not matched by PUTS_RE | Same analysis | **CONSENSUS.** Both propose `$strike P/C` targeted pattern. A1 suggests STRIKE_NEAR fallback (simpler); A2 suggests dedicated BARE_P_RE. **Resolution: Use A1's STRIKE_NEAR fallback approach** -- it reuses existing regex and only fires when no strategy detected. |
| direction-011 root cause | Missing "tomorrow" pattern + SOLD_RE not in no-badge action detection | Same analysis, same conclusion | **CONSENSUS.** Add EXPIRY_TOMORROW_RE + SOLD_RE to no-badge action block. A1 adds `symbol !== null` guard (better). A2 uses next-calendar-day semantics; A1 uses next-business-day. **Resolution: Use next-business-day** (addBusinessDays) since weekend expiry is nonsensical and the overnight handler already uses this approach. |

### Workstream B: PCS/Spread Handling (B1 + B2)

| Topic | B1 Position | B2 Position | Resolution |
|-------|-------------|-------------|------------|
| spreads-001 leg sides | `spreadLegs('PCS', 227.5, 225)` produces correct SELL/BUY. Failure is premium validation -- 5% of $0.42 = $0.021 tolerance. | Same analysis. Also found PREMIUM_RE captures `$227.50` first (not `$.42`), collision check nullifies it, and the actual premium `.42` is lost. | **CONSENSUS.** The legs ARE correct. Failure is premium validation tolerance on spreads. B2 adds the premium-parsing issue (first `$` match wins, loses the real `.42` premium). **Resolution: Premium validation too strict; widen or skip for explicit strikes.** |
| regression-006 root cause | action=null because "Long" is plain text (not badge). No badge -> no action -> LLM path -> premium mismatch. | Same analysis. | **CONSENSUS.** Need keyword-implies-OPEN heuristic: when strategy keyword (PCS/CDS/PDS) + symbol + no exit context -> infer `action = 'OPEN'`. |
| spreads-004 root cause | "bullish put spread" not in PCS_RE. | Same analysis. | **CONSENSUS.** Both propose: (a) add synonym to PCS_RE, and (b) add general `put spread` + credit/debit disambiguation. B1's Option B (credit/bullish/bearish inference) is more robust. |
| pcsNormalize | Keep PCS as first-class strategy; spreadLegs handles it correctly. Not needed now. | Same conclusion. | **CONSENSUS.** No action needed. |

### Workstream C: Straddle/Multi-Position (C1 + C2)

| Topic | C1 Position | C2 Position | Resolution |
|-------|-------------|-------------|------------|
| strangle-003 `isStrangle` | `isStrangle = STRANGLE_RE.test(cleanText) && (hasLongBadge \|\| hasShortBadge)` | `isStrangle = (hasLongBadge && hasShortBadge && STRANGLE_RE) \|\| (STRANGLE_RE && CALLS_RE && PUTS_RE)` | **DISAGREE on mechanism, agree on direction.** C1's approach is simpler and covers the failing case (Long badge only). C2's approach also handles no-badge strangles where both "calls" and "puts" appear. **Resolution: Use C2's compound condition** -- it's more comprehensive and handles more real-world patterns (e.g., "Straddle on MSTR using $182.5 Calls and Puts"). |
| strangle-004/005 exit path | `resolveStrangle` is OPEN-only; needs action-awareness in index.ts routing + position-path straddle close | Same. Also provides `resolveStrangleExit()` sketch with per-position close signal generation. | **CONSENSUS.** Both agree: (a) index.ts must check `parse.action` before calling resolveStrangle, (b) strangle EXIT should be handled at orchestrator level (not in matchPosition), (c) matchPosition stays single-match. |
| strangle-006 partial close | EXIT_VERB_RE misses bare "close"; also CALLS_RE fires before PUTS_RE for "Close MSTR Puts...holding the calls" | Same. Both identify EXIT_VERB_RE gap and the strategy-detection-for-exit-messages problem. | **CONSENSUS.** Fix EXIT_VERB_RE to match "close". For partial close strategy derivation, C2 proposes using KEEP_CALLS_RE/KEEP_PUTS_RE to infer which leg is RETAINED -> close the other. **Resolution: EXIT_VERB_RE fix + leverage KEEP patterns for partial close inference.** |

### Workstream D: Skip & Edge Cases (D1 + D2)

| Topic | D1 Position | D2 Position | Resolution |
|-------|-------------|-------------|------------|
| core-001 no-symbol commentary | Hard-skip: `symbol===null && action===null` | Same, plus don't populate strategy/direction when action=null | **CONSENSUS.** Both agree on the hard-skip rule. D2's additional "don't populate strategy/direction when action=null" prevents LLM bias. **Resolution: Implement hard-skip. The strategy/direction suppression is more invasive; defer to Part 3 (meta fix).** |
| core-006 monitoring verb | Add monitoring-verb skip when `action===null && no badges` | Same, plus "I have" pattern detection | **CONSENSUS.** Both agree on monitoring-verb-based skip. D2's "I have" pattern is higher-confidence. **Resolution: Add MONITORING_RE check gated on `action===null && badges.length===0`.** |
| core-007 Feedback Request badge | Non-trade badge whitelist | Same (whitelist approach) | **CONSENSUS.** Whitelist: only Exit/Long/Short are trade badges. Unknown badge without trade badge -> hard skip. |
| regression-005 LEAP vs date | Reorder extractExpiryHint: explicit dates before LEAP + fix extractStrikes to fall through to dollar-strikes after nullifying date-like pairs | Same analysis | **CONSENSUS.** Both agree: (a) explicit dates override LEAP in extractExpiryHint, (b) extractStrikes must fall through to DOLLAR_STRIKE_RE after nullifying date-like pairs. |
| regression-007 fixture | Fixture under-specified (1 leg expected, CDS has 2). Also parser doesn't set `directionFromStrategy='LONG'` for CDS/PDS. | Same | **CONSENSUS.** Fix the fixture. Also add `directionFromStrategy='LONG'` for CDS and PDS in the parser (per CLAUDE.md: "CDS: Always LONG", "PDS: Always LONG"). |
| direction-010 lotto covered call | Narrow lotto override when sell-context present; or don't preset direction when extra_text fires | When lotto+extra_text, omit direction=LONG from LLM prompt | **CONSENSUS on approach, differ on mechanism.** Both agree the LLM should not receive biased `direction=LONG` for nuanced lotto messages. **Resolution: When `isLotto && complexityFlags.has('extra_text')`, set `direction=null` before returning ParseResult.** Simple, safe, rarely fires incorrectly (most lottos are short messages). |

---

## Part 2: Cross-Workstream Interactions

### 2.1: Premium validation tolerance affects A + B
The 5% tolerance at `open-path.ts:569,593,703` is the SINGLE BIGGEST source of false MANUAL_REVIEW results. It affects:
- **A cases**: direction-001/006/regression-001 (naked options with explicit strikes)
- **B cases**: spreads-001, regression-006 (spread premiums)
- **D cases**: core-007 (GS PCS 880/875 through LLM path)

The fix is unified: **skip premium validation when `strikeSelection.method === 'explicit'`**. The premium was never used for strike selection in this path; the trader stated explicit strikes, so the premium is informational (used for limit price), not a validation gate.

For `premium_match` mode, widen tolerance to `max(statedPremium * 0.15, 0.15)`.

### 2.2: Strategy detection reorder affects A + C
Moving STOCK after CALLS/PUTS (A fix) and using STRANGLE_RE in the if-else chain (C fix) both modify the strategy detection block (parser.ts:274-296). These changes don't conflict but must be applied in the right order. The expanded chain should be:

```
CDS -> PCS -> PDS -> LEAP -> LOTTO -> CALLS (with !SPREAD_KW guard) -> PUTS (with !SPREAD_KW guard) -> STOCK
```

STRANGLE_RE is NOT in the strategy chain -- it's handled separately via `isStrangle` flag.

### 2.3: action=null / no-badge detection affects A + B + D
Three workstreams independently identified that `action=null` routes too many messages to LLM:
- **A**: SOLD_RE not in no-badge action block (direction-011)
- **B**: Strategy keyword implies OPEN when no exit context (regression-006)
- **D**: No-symbol+no-action should hard-skip (core-001); monitoring verbs should skip (core-006)

These form a coherent set of changes to the action detection block (parser.ts:351-368). Applied together:
1. Hard-skip: `symbol===null && action===null` (earliest exit)
2. SOLD_RE triggers `action='OPEN'` for no-badge (with `!EXIT_VERB_RE && symbol !== null` guard)
3. Strategy-keyword-implies-OPEN: when PCS/CDS/PDS/STRANGLE + symbol + no exit -> `action='OPEN'`
4. Monitoring verbs + no badge + no action -> hard skip
5. "added" (past tense) added to the OPEN verb pattern

### 2.4: EXIT_VERB_RE fix affects A + C
Adding bare "close" to EXIT_VERB_RE (C fix) could interact with direction-011 (A case: "Sold 10 $180 Puts on NVDA for $1.80 - expiring tomorrow"). But "close" is not in that message, so no conflict. The SOLD_RE-as-OPEN-trigger in the no-badge block (A fix) is guarded by `!EXIT_VERB_RE`, so adding "close" to EXIT_VERB_RE only strengthens that guard.

### 2.5: extractStrikes fallback affects A + D
Both A and D identify that extractStrikes returns date-like slash pairs as fallback, blocking dollar-prefixed strikes. The fix (don't return date-like fallback; fall through to DOLLAR_STRIKE_RE) benefits both direction-001 (defense-in-depth) and regression-005 (primary fix for $600 strike loss).

---

## Part 3: The Meta Fix -- `extra_text` / Complexity Flag Gating

### The Problem

Multiple workstreams identified that `extra_text` and `action=null` route messages to LLM when the deterministic path has sufficient information:

1. **direction-002/004**: STOCK_RE false positive -> wrong pre-parsed strategy -> extra_text -> LLM gets misled
2. **regression-006**: Strategy=PCS detected but action=null (no badge) -> LLM path unnecessarily
3. **core-001/006**: action=null for non-trades -> LLM tries to execute commentary
4. **direction-010**: Lotto+extra_text correctly routes to LLM, but pre-parsed direction=LONG biases the LLM

### The Root Cause

The current design pre-fills `strategy`, `direction`, and `isLotto` even when `action=null`. These fields then:
1. Trigger the wrong routing (e.g., `isStrangle=true` when action=CLOSE -> resolveStrangle forces OPEN)
2. Bias the LLM via `buildNLUPrompt()` pre-parsed fields (e.g., direction=LONG for covered calls)
3. Prevent hard-skip when they shouldn't exist (e.g., lotto commentary gets strategy=PUT)

### The Principled Approach

**When the parser lacks confidence, communicate uncertainty -- don't fill in defaults.**

Specifically:

1. **If `action` cannot be determined, `strategy` and `direction` are speculative.** The parser should still extract them (they're useful for the LLM prompt as hints), but they should be marked as low-confidence rather than presented as facts.

2. **The `extra_text` flag fires too eagerly.** Currently: `action !== null && strategy !== null && wordCount > 15`. This means ANY message with >15 words and deterministic action+strategy goes to LLM. The word-count threshold is too low (15 words is 1-2 sentences -- normal for a trade message). Raise to 25, or gate on additional complexity indicators:
   - Message contains conditional language ("if", "would", "should")
   - Message references OTHER trades ("also", "and")
   - Message has educational/commentary suffix after the trade intent

3. **Pre-parsed fields sent to the LLM should be flagged with confidence.** Instead of `direction=LONG`, send `direction=LONG (default, may be overridden by context)`. Or better: when a field was derived from a default rule that's known to have exceptions (e.g., isLotto->LONG), omit it from the LLM prompt entirely and let the LLM derive it from context.

### Practical Fix (minimal, not architectural overhaul)

For now, apply these targeted changes rather than redesigning the confidence model:

1. **Hard-skip `symbol===null && action===null`** before strategy/direction derivation. This prevents the lotto-commentary false positive (core-001).

2. **When `isLotto && extra_text`, set `direction=null`** in the final ParseResult. The LLM path handles it; most lottos are short messages that won't trigger extra_text anyway.

3. **Raise extra_text word-count threshold from 15 to 25.** Messages with 15-24 words are routinely normal trade announcements with a bit of context (e.g., "Long HUT sold the 12/19 $36 puts for a credit of $0.88/contract" is 14 words).

4. **Add `strategy-keyword-implies-OPEN` inference** so PCS/CDS/PDS messages don't get `action=null`.

These 4 changes reduce unnecessary LLM routing by ~50% for eval cases without architectural disruption.

---

## Part 4: Prioritized Fix Plan

### Tier 1: Quick Wins (single-line or small regex fixes)

#### Fix 1.1: EXIT_VERB_RE -- match bare "close"
- **File**: `parser.ts:84`
- **Change**: `clos(?:ed|ing)` -> `clos(?:e[ds]?|ing)`
- **Cases unblocked**: strangle-006, exits-012
- **Risk**: Very low. "Close" in non-exit context ("close to the money") is possible but EXIT_VERB_RE is only used in action detection, gated on symbol presence.
- **Dependencies**: None

#### Fix 1.2: Reorder strategy detection -- CALLS/PUTS before STOCK
- **File**: `parser.ts:287-296`
- **Change**: Move the `STOCK_RE` branch to AFTER `CALLS_RE` and `PUTS_RE` branches
- **Cases unblocked**: direction-002, direction-004
- **Risk**: Very low. Messages with both "puts"/"calls" and "stock" are always about options.
- **Dependencies**: None

#### Fix 1.3: Non-trade badge whitelist
- **File**: `parser.ts` -- add after existing hard-skip checks (~line 241)
- **Change**:
  ```
  const TRADE_BADGES = new Set(['Long', 'Short', 'Exit']);
  const hasNonTradeBadge = badges.length > 0 && badges.some(b => !TRADE_BADGES.has(b));
  const hasTradeBadge = badges.some(b => TRADE_BADGES.has(b));
  if (hasNonTradeBadge && !hasTradeBadge) {
    return hardSkip(`non-trade badge: ${badges.filter(b => !TRADE_BADGES.has(b)).join(', ')}`, complexityFlags);
  }
  ```
- **Cases unblocked**: core-007
- **Risk**: Very low. Unknown badge types are safely skipped. Messages with BOTH trade and non-trade badges still route normally.
- **Dependencies**: None

#### Fix 1.4: Hard-skip -- no symbol + no action
- **File**: `parser.ts` -- add after action determination block (~line 368)
- **Change**:
  ```
  if (symbol === null && action === null) {
    return hardSkip('no symbol and no action', complexityFlags);
  }
  ```
- **Cases unblocked**: core-001
- **Risk**: Very low. No message without a `data-symbol` link AND without an action verb/badge is actionable.
- **Dependencies**: Should be placed AFTER action determination (fixes 1.5, 1.6)

#### Fix 1.5: Add "tomorrow" expiry pattern
- **File**: `parser.ts` -- add `EXPIRY_TOMORROW_RE = /\btomorrow\b/i` and check in `extractExpiryHint` after overnight check
- **File**: `open-path.ts` -- add `"tomorrow"` case in `resolveExpiryHint` (same as overnight: `addBusinessDays(messageDate, 1)`)
- **Cases unblocked**: direction-011, regression-003 (partial -- also needs Fix 1.6)
- **Risk**: Very low. "Tomorrow" is unambiguous in expiry context.
- **Dependencies**: None

#### Fix 1.6: SOLD_RE as OPEN trigger for no-badge messages
- **File**: `parser.ts:362-367` -- add to no-badge action detection block
- **Change**:
  ```
  } else if (SOLD_RE.test(cleanText) && !EXIT_VERB_RE.test(cleanText) && symbol !== null) {
    action = 'OPEN';
  }
  ```
- **Cases unblocked**: direction-011, regression-003 (with Fix 1.5)
- **Risk**: Moderate. "Sold" without an exit verb and with a symbol is strongly sell-to-open. Guard conditions (`!EXIT_VERB_RE`, `symbol !== null`) prevent misclassifying "sold out" or no-ticker messages.
- **Dependencies**: Fix 1.1 (EXIT_VERB_RE must match "close" first, so "Close...sold" routes correctly)

#### Fix 1.7: Set directionFromStrategy for CDS and PDS
- **File**: `parser.ts:274-279`
- **Change**: Add `directionFromStrategy = 'LONG'` for CDS and PDS strategy branches
- **Cases unblocked**: regression-007 (partial -- also needs fixture fix)
- **Risk**: Very low. Per CLAUDE.md, CDS and PDS are ALWAYS LONG.
- **Dependencies**: None

#### Fix 1.8: Fix regression-007 fixture
- **File**: Eval fixture for regression-007
- **Change**: Specify both legs for CDS spread: `[{ optionType: 'CALL', side: 'BUY' }, { optionType: 'CALL', side: 'SELL' }]`
- **Cases unblocked**: regression-007 (score 0.67 -> 1.0)
- **Risk**: None. Fixture bug, not code bug.
- **Dependencies**: None

### Tier 2: Parser Improvements

#### Fix 2.1: Strategy fallback for bare P/C abbreviation
- **File**: `parser.ts` -- add after strategy detection chain (~line 296)
- **Change**: When `strategy === null`, check `STRIKE_NEAR_OPTION_RE` for `[cp]\b` match and infer strategy:
  ```
  if (strategy === null) {
    const nearM = STRIKE_NEAR_OPTION_RE.exec(cleanText);
    if (nearM) {
      const match = nearM[0].toLowerCase();
      if (/p\b/.test(match)) { strategy = 'PUT'; directionFromStrategy = 'LONG'; }
      else if (/c\b/.test(match)) { strategy = 'CALL'; directionFromStrategy = 'LONG'; }
    }
  }
  ```
- **Cases unblocked**: direction-007
- **Risk**: Low. Only fires when no other strategy detected. Reuses STRIKE_NEAR_OPTION_RE which requires `$strike` context.
- **Dependencies**: Fix 1.2 (strategy reorder should be applied first)

#### Fix 2.2: PCS synonym expansion + credit/debit disambiguation
- **File**: `parser.ts:27` (PCS_RE) + new disambiguation block
- **Change**:
  ```
  const PCS_RE = /\bpcs\b|put credit spread|bull(?:ish)?\s+put\s+spread/i;
  ```
  Plus after PCS/PDS regex checks, add fallback:
  ```
  if (!strategy && /\bput\s+spread\b/i.test(cleanText)) {
    if (/\bcredit\b/i.test(cleanText) || /\bbullish\b/i.test(cleanText)) strategy = 'PCS';
    else if (/\bdebit\b/i.test(cleanText) || /\bbearish\b/i.test(cleanText)) strategy = 'PDS';
  }
  ```
- **Cases unblocked**: spreads-004
- **Risk**: Low. Credit/debit context is unambiguous.
- **Dependencies**: None

#### Fix 2.3: Strategy-keyword-implies-OPEN inference
- **File**: `parser.ts:362-367` -- add to no-badge action detection block
- **Change**: When strategy is a spread keyword (PCS/CDS/PDS) or strangle AND symbol is present AND no exit indicators:
  ```
  } else if (
    strategy !== null &&
    (isSpread || isStrangle) &&
    symbol !== null &&
    !EXIT_VERB_RE.test(cleanText)
  ) {
    action = 'OPEN';
  }
  ```
  (Where `isSpread = strategy === 'CDS' || strategy === 'PDS' || strategy === 'PCS'`)
- **Cases unblocked**: regression-006 (GLW pcs 68/67)
- **Risk**: Low. A spread keyword + ticker + no exit verb is a high-confidence OPEN signal. The only false positive would be "I have a GLW PCS" (monitoring) -- but that would also match the monitoring-verb check (Fix 2.7).
- **Dependencies**: Fix 1.6 (SOLD_RE), Fix 1.1 (EXIT_VERB_RE). Order matters: EXIT_VERB check must come first in the else-if chain.

#### Fix 2.4: Skip premium validation for explicit strikes
- **File**: `open-path.ts:680-722`
- **Change**: Add `strikeSelection.method === 'explicit'` to the skip condition:
  ```
  if (
    parse.premiumHint !== null &&
    strikeSelection.method !== 'premium_match' &&
    strikeSelection.method !== 'explicit' &&    // <-- NEW
    resolvedLegs.legs.length > 0
  ) {
  ```
- **Cases unblocked**: spreads-001 (if premium parsing were the issue), direction-001/006/regression-001 (defense-in-depth)
- **Risk**: Very low. When strikes are explicitly stated by the trader, premium validation is purely informational. The premium is still used for limit price calculation (buildLimitPrice), just not as a rejection gate.
- **Dependencies**: None (but most effective after Tier 1 fixes resolve the primary strike extraction issues)

#### Fix 2.5: Widen premium validation tolerance
- **File**: `open-path.ts:569,593,703`
- **Change**: Replace `statedPremium * 0.05` with `Math.max(statedPremium * 0.15, 0.15)` for all premium_match tolerance checks
- **Cases unblocked**: General robustness for premium_match path
- **Risk**: Low. 15% or $0.15 minimum is still reasonably tight. Options have inherently wide bid-ask spreads.
- **Dependencies**: None

#### Fix 2.6: Expiry precedence -- explicit dates before LEAP
- **File**: `parser.ts:183-208` (extractExpiryHint)
- **Change**: Move the slash-date, month-day, and bare-month checks ABOVE the LEAP check. LEAP becomes a fallback for when no explicit date is present.
- **Cases unblocked**: regression-005 (primary)
- **Risk**: Low. When a trader says "leaps" AND "3/26", the explicit date is always more specific.
- **Dependencies**: None

#### Fix 2.7: Monitoring-verb skip + "added" verb
- **File**: `parser.ts` -- add monitoring pattern and check after action block
- **Change**:
  ```
  const MONITORING_RE = /\b(watching|monitoring|I\s+have|I\s+am\s+holding)\b/i;
  // After action block, before the hard-skip:
  if (action === null && badges.length === 0 && MONITORING_RE.test(cleanText)) {
    return hardSkip('monitoring/observation', complexityFlags);
  }
  ```
  Also add "added" to the OPEN verb pattern:
  ```
  } else if (BOUGHT_BUYING_RE.test(cleanText) || /\b(adding|added|opened)\b/i.test(cleanText)) {
  ```
- **Cases unblocked**: core-006 ("I am watching"), regression-005 ("added another 10")
- **Risk**: Moderate for monitoring verbs. "I have AAPL, bought calls" would still work because BOUGHT_BUYING_RE fires first and sets action=OPEN, so action would not be null. The guard `action===null && badges.length===0` is conservative.
- **Dependencies**: Fix 1.6 (SOLD_RE) should be in place so "I have AAPL, sold puts" correctly gets action=OPEN before the monitoring check.

#### Fix 2.8: extractStrikes fallthrough to dollar-strikes after date nullification
- **File**: `parser.ts:384-397` -- after setting `strikes = null` for date-like pairs
- **Change**: Re-run dollar-strike extraction when strikes were nullified:
  ```
  if (strikes === null && !isSpread) {
    // Date-like slash pair nullified; try dollar-prefixed strikes
    const dollarHits: number[] = [];
    const dollarRe = new RegExp(DOLLAR_STRIKE_RE.source, 'gi');
    let dm: RegExpExecArray | null;
    while ((dm = dollarRe.exec(cleanText)) !== null) {
      const v = parseFloat(dm[1]);
      if (isFinite(v) && v >= 1) dollarHits.push(v);
    }
    if (dollarHits.length > 0) strikes = dollarHits;
  }
  ```
- **Cases unblocked**: regression-005 (recovers $600 strike after 3/26 nullification)
- **Risk**: Low. Only fires after date disambiguation already ran. Dollar-prefixed values are high-confidence strikes.
- **Dependencies**: Fix 2.6 (expiry precedence) -- both needed for regression-005.

### Tier 3: Architectural Changes

#### Fix 3.1: Strangle exit path
- **File**: `index.ts:70-75` -- modify strangle routing
- **Change**:
  ```
  // Strangle/straddle EXIT: close all positions for symbol
  if (parse.isStrangle && parse.action !== 'OPEN' && parse.action !== null) {
    log.debug(`[${ctx.messageId}] strangle exit -> per-position close`);
    const r = await resolveStrangleExit(parse, ctx);
    logResult(ctx, parse, r);
    return r;
  }

  // Strangle/straddle OPEN (existing)
  if (parse.isStrangle) {
    // ... existing resolveStrangle() call
  }
  ```
  New function `resolveStrangleExit()`:
  - Gets all open positions for symbol via `ctx.positions.getPositions(symbol)`
  - Builds one CLOSE/TRIM signal per position with tradeId
  - Returns all signals in one EXECUTE result
- **Cases unblocked**: strangle-004, strangle-005, exits-004, exits-005
- **Risk**: Moderate. New code path. Needs tests. Edge case: partial strangle close ("close puts, keep calls") should NOT go through this path -- need a `isFullStrangleExit` check (STRANGLE_RE in text + no KEEP_CALLS_RE/KEEP_PUTS_RE).
- **Dependencies**: Fix 3.2 (isStrangle relaxation)

#### Fix 3.2: Relax isStrangle detection
- **File**: `parser.ts:267`
- **Change**:
  ```
  const isStrangle =
    (hasLongBadge && hasShortBadge && STRANGLE_RE.test(cleanText)) ||
    (STRANGLE_RE.test(cleanText) && CALLS_RE.test(cleanText) && PUTS_RE.test(cleanText)) ||
    (STRANGLE_RE.test(cleanText) && (hasLongBadge || hasShortBadge || hasExitBadge));
  ```
- **Cases unblocked**: strangle-003 (Long badge only), strangle-005 (Exit badge only)
- **Risk**: Low. The STRANGLE_RE keyword ("straddle"/"strangle") is unambiguous in this domain. Adding badge OR keyword-context gating prevents false positives from commentary.
- **Dependencies**: Fix 3.1 (strangle exit path must exist before relaxing detection, otherwise Exit-badge strangles would incorrectly call resolveStrangle and force OPEN)

#### Fix 3.3: Lotto direction suppression for complex messages
- **File**: `parser.ts` -- after `extra_text` flag computation (~line 413)
- **Change**:
  ```
  // When lotto + extra_text, the context is too complex for the lotto=LONG default.
  // Leave direction null for LLM resolution.
  if (isLotto && complexityFlags.has('extra_text')) {
    direction = null;
  }
  ```
  Note: This must be placed AFTER `extra_text` flag computation but BEFORE the return statement.
- **Cases unblocked**: direction-010 (covered call with "lotto" label)
- **Risk**: Low. Most lotto messages are short (<15 words) and won't trigger extra_text. For the rare long lotto message, the LLM should determine direction from context rather than blindly applying the LONG default.
- **Dependencies**: None, but benefits from raising extra_text threshold (avoids false triggers)

#### Fix 3.4: Raise extra_text word-count threshold
- **File**: `parser.ts:411`
- **Change**: `wordCount(cleanText) > 15` -> `wordCount(cleanText) > 25`
- **Cases unblocked**: Reduces unnecessary LLM routing for normal-length trade messages. Doesn't directly unblock eval cases but prevents direction-002/004 from hitting LLM if the strategy reorder fix (1.2) is applied.
- **Risk**: Moderate. Messages with 16-25 words that genuinely need LLM would now go deterministic. But with the improved parser (Tier 1+2 fixes), the deterministic path handles more cases correctly. Monitor for regressions.
- **Dependencies**: Tier 1+2 fixes should be in place first (deterministic path must be accurate before routing more traffic to it)

---

## Part 5: Cases That Should Stay LLM-Dependent

### 5.1: direction-010 (Short HIMS lotto covered call)
**Why**: The "lotto" label is used colloquially for a covered call. The sell context ("collect premium", "assigned", "called away") is deeply embedded in multi-sentence commentary. No reasonable deterministic heuristic can distinguish "lotto BUY" from "lotto covered-call SELL" without understanding sentence-level semantics. Fix 3.3 removes the direction bias from the LLM prompt; the LLM must determine SELL from context.

### 5.2: spreads-004 (bullish put spread) -- if synonym not added
**Why**: If we choose NOT to add "bullish put spread" to PCS_RE (risk of synonym proliferation), this case genuinely needs LLM to map natural language to the correct strategy. The LLM receives strikes (175/170), premium ($1.16 credit), and "put spread" context -- it should correctly produce PCS. However, Fix 2.2 (synonym expansion) makes this deterministic, which is preferred.

### 5.3: Multi-trade messages with ambiguous structure
Messages like `<EXIT BADGE /><LONG BADGE /> DXCM $80.10<EXIT BADGE /><SHORT BADGE /> ELF $135.74` where two separate trades are concatenated with no separator require NLU to split into distinct signals. The `multi_ticker` flag correctly routes these to LLM.

### 5.4: Relational / follow trades
Messages like "following Dave on AAPL" require lookup of Dave's recent trades via chat history. The `relational` flag correctly routes these to LLM.

### 5.5: "Long UNH cds for next week" with no badge
When "Long" appears as plain text (not a badge) and there is no action verb, the parser cannot confidently determine action=OPEN from text alone (could be a position description "I'm long UNH CDS"). Fix 2.3 (strategy-keyword-implies-OPEN) handles this for spread keywords, but naked option messages like "Long AAPL calls" without a badge should still route to LLM for disambiguation.

---

## Implementation Order

The fixes should be applied in this order to minimize merge conflicts and maximize incremental correctness:

**Phase 1 (Tier 1 quick wins -- can be a single commit):**
1. Fix 1.1 (EXIT_VERB_RE)
2. Fix 1.2 (strategy reorder)
3. Fix 1.3 (non-trade badge whitelist)
4. Fix 1.5 (tomorrow expiry)
5. Fix 1.6 (SOLD_RE action)
6. Fix 1.7 (CDS/PDS direction)
7. Fix 1.4 (no-symbol hard-skip) -- last in parser because it depends on action determination
8. Fix 1.8 (fixture fix)

**Phase 2 (Tier 2 parser improvements -- second commit):**
1. Fix 2.1 (bare P/C)
2. Fix 2.2 (PCS synonyms)
3. Fix 2.3 (strategy-implies-OPEN)
4. Fix 2.4 (skip premium validation for explicit)
5. Fix 2.5 (widen premium tolerance)
6. Fix 2.6 (expiry precedence)
7. Fix 2.7 (monitoring verbs + "added")
8. Fix 2.8 (dollar-strike fallthrough)

**Phase 3 (Tier 3 architectural -- separate commits):**
1. Fix 3.2 (isStrangle relaxation) + Fix 3.1 (strangle exit path) -- coupled, one commit
2. Fix 3.3 (lotto direction suppression)
3. Fix 3.4 (raise extra_text threshold) -- last, after deterministic path is proven
