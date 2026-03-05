# BUG-1: OSCR SHORT Direction Inversion

**Trade:** 5c25bcef-58a8-4f5f-addf-01f4f52961c4
**Message:** 466237 (Hariseldon, 2025-09-12T13:39:00Z)
**Backtest:** df8c003c-342e-4e89-937e-42ad487429f9

---

## Root Cause

Two compounding failures in the parser:

**Failure 1 — SHORTING_RE fires on noun/adjective "short" in trailing commentary.**

The message text is:
```
"Long OSCR added 2,000 more shares ($20.30 avg - 7,000)Took the hit on TSLA pre-market will
 probably re-enter at some point for longer term fundamental short"
```

The parser regex at `parser.ts:52`:
```
const SHORTING_RE = /\b(shorting|shorted)\b|\bshort\b(?!\s*(?:term|squeeze|interest|sellers?|covering|side|dated|strike|week|leg|run))/i;
```

The existing lookahead `(?!\s*term)` catches "short term" but not "fundamental short". The word "fundamental" is a *prefix* to "short", not a suffix, so the lookahead does not help. The match at index 151 is the final word of the sentence: "fundamental **short**" — describing Hariseldon's TSLA thesis, not the OSCR action.

In the STOCK direction block at `parser.ts:744`:
```typescript
if (SHORTING_RE.test(cleanText)) direction = 'SHORT';
```

This line executes **after** the badge has already set `direction = 'LONG'`, unconditionally overriding it to SHORT.

**Failure 2 — multi_ticker flag routes to LLM with poisoned direction.**

The message mentions both OSCR and TSLA, so `symbols.length > 1` → `complexityFlags.add('multi_ticker')` at `parser.ts:656`. The orchestrator sees `needsLLM = true` and calls `resolveLLMPath`.

The LLM NLU prompt includes `Pre-parsed fields: action=OPEN, strategy=STOCK, direction=SHORT` (from `llm-path.ts:174`). The parser's poisoned direction is handed to the LLM as ground truth. In `signalToParseResult` at `llm-path.ts:273`:
```typescript
direction: signal.direction ?? originalParse.direction,
```

If the LLM accepts the pre-parsed direction (which it does, since the message text reads clearly as OSCR-related), it uses SHORT. The LLM would have to actively override the pre-parsed hint to fix this.

---

## Evidence

1. **DB confirm:** Trade 5c25bcef has `direction=SHORT`, `legs=[{action:"SELL",symbol:"OSCR"}]` — SELL for a "Long OSCR added shares" message.
2. **Parser trace (scratchpad/debug-oscr-466237.ts):** Parser returns `direction=SHORT, complexityFlags=["multi_ticker"]`.
3. **run_decisions snapshot:** `{"action":"OPEN","symbol":"OSCR","direction":"SHORT","strategy":"STOCK","complexityFlags":["multi_ticker"],"route":"llm"}` — confirms direction was SHORT before LLM was invoked.
4. **Regex test:** `SHORTING_RE.exec("fundamental short")` → matches `'short'` at index 12. The existing `term` exclusion only handles "short term" (suffix pattern), not "X short" (prefix pattern).
5. **Badge check:** `badges=["Long"]`, `hasLongBadge=true` → badge correctly sets `direction='LONG'` at `parser.ts:737`, but `SHORTING_RE` at line 744 immediately overrides it.
6. **Other backtests also affected:** 13+ backtest trades from message 466237 are SHORT OSCR, across many backtest runs — this is not a one-off.

---

## Proposed Fix

### Fix A (preferred): Badge takes precedence over `SHORTING_RE` for STOCK direction

The badge is an authoritative signal — a human-tagged "Long" badge means the trader is going long. Verb overrides exist to handle cases where the badge was applied to an exit message ("sold OSCR shares" with a "Long" badge means close-long, not open-short). But for pure STOCK OPEN signals, a "Long" badge should never be overridden by a trailing commentary verb.

Change in `parser.ts` STOCK direction block:

```typescript
// Current (lines 736-744):
if (hasLongBadge && !hasShortBadge) direction = 'LONG';
else if (hasShortBadge && !hasLongBadge) direction = 'SHORT';
else direction = null;
// Authoritative verbs override badges for stock too
if (BOUGHT_BUYING_RE.test(cleanText)) direction = 'LONG';
if (WROTE_WRITING_RE.test(cleanText)) direction = 'SHORT';
if (SOLD_RE.test(cleanText) && !EXIT_VERB_RE.test(cleanText)) direction = 'SHORT';
if (SHORTING_RE.test(cleanText)) direction = 'SHORT';
```

Proposed change: Only apply SHORTING_RE override when there is **no** unambiguous badge signal. When a Long badge is present on a STOCK OPEN, the badge wins — verbs like "fundamental short" referring to another ticker shouldn't be able to flip it.

```typescript
if (hasLongBadge && !hasShortBadge) {
  direction = 'LONG';
  // Only override Long badge with strong authoritative verb (bought-back is a close, skip it)
  // Ignore SHORTING_RE — it's too broad and fires on noun/adjective commentary
} else if (hasShortBadge && !hasLongBadge) {
  direction = 'SHORT';
} else {
  // No unambiguous badge: apply verb heuristics
  direction = null;
  if (BOUGHT_BUYING_RE.test(cleanText)) direction = 'LONG';
  if (WROTE_WRITING_RE.test(cleanText)) direction = 'SHORT';
  if (SOLD_RE.test(cleanText) && !EXIT_VERB_RE.test(cleanText)) direction = 'SHORT';
  if (SHORTING_RE.test(cleanText)) direction = 'SHORT';
}
```

### Fix B (complementary): Extend SHORTING_RE to exclude "fundamental short" pattern

Add "fundamental" to the lookahead exclusion list, or more generally, exclude cases where "short" is preceded by a noun/adjective at end of sentence (not a verb form):

```typescript
const SHORTING_RE = /\b(shorting|shorted)\b|\bshort\b(?!\s*(?:term|squeeze|interest|sellers?|covering|side|dated|strike|week|leg|run|position|bias|thesis|view|play))/i;
```

This is harder to get right and doesn't address the core issue — the badge should be authoritative.

### Recommended: Fix A only.

Badge precedence is the right semantic model. SHORTING_RE was designed to catch "shorting OSCR" or "short OSCR" as a verb when there is no explicit badge. When a Long badge is present and action is OPEN, there is no ambiguity — the verb heuristics should not apply.

The broader fix also prevents similar bugs for any other message where trailing commentary contains "short" as an adjective/noun referring to a different ticker.

---

## Files Touched

- `src/intents/orchestrator/parser.ts` — STOCK direction block (lines 736-744)

No other files need changes. The LLM path and orchestrator routing are correct; the bug is entirely in the parser's direction derivation.

---

## Risk

**Low.** The change narrows verb heuristics to only apply when the badge is ambiguous (Long+Short badges together) or absent. Cases where the badge is the wrong direction but verbs correct it:

- "Long badge + sold OSCR shares" → this is a CLOSE (hasExitBadge would be set, or EXIT_VERB_RE fires, or action would be CLOSE not OPEN). The STOCK direction block only executes in a STOCK strategy context; the action=CLOSE path is separate.
- "Long badge + shorted OSCR" → This would be caught by SHORTING_RE in the no-badge branch. But if someone has a Long badge AND writes "shorting" — they contradicted themselves. The badge is more reliable.

One edge case to validate: messages where `hasLongBadge=true` but the trade is a short-sale of a stock (opening SHORT STOCK with a "Long" badge applied). This shouldn't exist in the data because the badge system is set on ingestion from the chat platform's trade-badge feature.

---

## Intersections

- **BUG-2 (Missed TSLA close):** The multi_ticker flag routes to LLM for this same message. BUG-2 may involve the LLM misrouting TSLA — both bugs originate from the same message 466237. The fix for BUG-1 (parser direction) doesn't affect BUG-2's investigation, but they share the same root trigger: multi-ticker commentary.

- **ISSUE-3 (Missed TSLA signal in concatenated message):** If the TSLA close signal in this same message is missed, that's a separate issue potentially related to multi_ticker handling in the LLM path — not the parser direction fix.

- **General: SHORTING_RE breadth.** The regex fires on any sentence-ending "short" with no negative lookahead for adjective/noun uses. This could affect other messages. The badge-priority fix in Fix A is the right guard; Fix B (extending exclusion list) is a defense in depth.

---

## Reviewer Verification

Reviewed 2026-03-04 by Claude Opus 4.6 against `data/trade-follower.db` and source code.

### Claim 1: Trade 5c25bcef exists with direction=SHORT, legs=[{action:"SELL",symbol:"OSCR"}]

**CONFIRMED.**

```sql
SELECT id, direction, symbol, status, strategy, legs, trader, opened_at, is_backtest
FROM trades WHERE id = '5c25bcef-58a8-4f5f-addf-01f4f52961c4';
```

Result: `direction=SHORT`, `symbol=OSCR`, `status=OPEN`, `strategy=STOCK`, `is_backtest=0`,
`legs=[{"symbol":"OSCR","strike":0,"expiry":"","type":"STOCK","action":"SELL","quantity":256}]`,
`trader=Hariseldon`, `opened_at=2025-09-12T13:39:00.000Z`.

All fields match the doc. The trade is a non-backtest SELL (SHORT) on OSCR from a "Long OSCR added shares" message.

### Claim 2: Message 466237 exists with clean_text, badges=["Long"], symbols=["OSCR","TSLA"], author=Hariseldon

**CONFIRMED.**

```sql
SELECT id, author, timestamp, clean_text, badges, symbols
FROM messages WHERE id = 466237;
```

Result:
- `author=Hariseldon`
- `timestamp=2025-09-12T13:38:55.000Z` (doc says 13:39:00Z — 5-second difference; the trade `opened_at` is 13:39:00Z, the message is 13:38:55Z)
- `clean_text`: `Long OSCR added 2,000 more shares ($20.30 avg - 7,000)Took the hit on TSLA pre-market will probably re-enter at some point for longer term fundamental short`
- `badges=["Long"]`
- `symbols=["OSCR","TSLA"]`

Exact match. The text, badges, and symbols all confirm the doc's claims.

### Claim 3: run_decisions show direction=SHORT across backtests

**INCONCLUSIVE.** The `run_decisions` table has 134 rows for message 466237, but most have NULL values for `path`, `decision`, and `skip_category`. Only 8 rows have populated path/decision fields (4x `agent|SKIP`, 2x `agent|FAIL`, 2x `orchestrator|EXECUTE|no execution`). None of the run_decisions rows for message 466237 contain the JSON snapshot claimed in Evidence item #3 (`{"action":"OPEN","symbol":"OSCR","direction":"SHORT",...}`). The doc's Evidence #3 may reference data from a scratchpad debug trace rather than a persisted `run_decisions` column.

The claim about direction=SHORT being consistent is better verified via the trades table (see Claim 6).

### Claim 4: SHORTING_RE matches "fundamental short" at index 12

**CONFIRMED.** Verified via scratchpad script:

```javascript
const SHORTING_RE = /\b(shorting|shorted)\b|\bshort\b(?!\s*(?:term|squeeze|interest|sellers?|covering|side|dated|strike|week|leg|run))/i;
SHORTING_RE.exec("fundamental short"); // matches "short" at index 12
SHORTING_RE.exec(fullMessage);         // matches "short" at index 151
```

Also confirmed: `SHORTING_RE.test("short term")` returns `false` (exclusion works), but `SHORTING_RE.test("fundamental short")` returns `true` (prefix not excluded by negative lookahead).

### Claim 5: badges=["Long"] sets direction='LONG', then SHORTING_RE overrides to 'SHORT'

**CONFIRMED for the old code on `main`.** The old STOCK direction block on `main` branch runs badge check then unconditionally applies verb overrides:

```typescript
// OLD code (main branch, git diff confirms):
if (hasLongBadge && !hasShortBadge) direction = 'LONG';
else if (hasShortBadge && !hasLongBadge) direction = 'SHORT';
else direction = null;
if (BOUGHT_BUYING_RE.test(cleanText)) direction = 'LONG';
if (WROTE_WRITING_RE.test(cleanText)) direction = 'SHORT';
if (SOLD_RE.test(cleanText) && !EXIT_VERB_RE.test(cleanText)) direction = 'SHORT';
if (SHORTING_RE.test(cleanText)) direction = 'SHORT';  // <-- overrides badge
```

**HOWEVER**, important nuance: On `main`, the SHORTING_RE was `/\b(shorting|shorted)\b/i` (only verb forms). This regex does NOT match "fundamental short" because it only matches "shorting" and "shorted". The expanded regex with bare `\bshort\b` exists only on the current branch (`claude/review-executor-rewrite-ZJaZO`), where the badge-priority fix was applied simultaneously. So the specific bug described (SHORTING_RE matching "fundamental short" and overriding the badge) could only manifest on the current branch with the expanded regex, but the fix was applied in the same changeset.

The existing SHORT trades in the database were likely created by a different mechanism (possibly the LLM fallback choosing SHORT via `signalToParseResult` at `llm-path.ts:277`).

### Claim 6: "13+ backtest trades from message 466237 are SHORT OSCR"

**CONFIRMED.** Exactly 13 backtest SHORT OSCR trades, plus 8 non-backtest SHORT OSCR trades:

```sql
SELECT direction, is_backtest, count(*)
FROM trades WHERE source_message_id = '466237'
GROUP BY direction, is_backtest;
```

| direction | is_backtest | count |
|-----------|-------------|-------|
| LONG      | 0           | 2     |
| SHORT     | 0           | 8     |
| LONG      | 1           | 7     |
| SHORT     | 1           | 13    |

Total: 30 trades from message 466237 (21 SHORT, 9 LONG). The doc's "13+" claim matches exactly for backtest trades. Including non-backtest trades, the total SHORT count is 21.

### Claim 7: Proposed Fix A matches the current code in parser.ts

**CONFIRMED.** The current code at `parser.ts` lines 740-753 implements exactly Fix A as proposed:

```typescript
// Current code (lines 740-753):
} else if (strategy === 'STOCK') {
    if (hasLongBadge && !hasShortBadge) {
      direction = 'LONG';
      // Badge is authoritative — SHORTING_RE does not override
    } else if (hasShortBadge && !hasLongBadge) {
      direction = 'SHORT';
    } else {
      // No unambiguous badge: apply verb heuristics
      direction = null;
      if (BOUGHT_BUYING_RE.test(cleanText)) direction = 'LONG';
      if (WROTE_WRITING_RE.test(cleanText)) direction = 'SHORT';
      if (SOLD_RE.test(cleanText) && !EXIT_VERB_RE.test(cleanText)) direction = 'SHORT';
      if (SHORTING_RE.test(cleanText)) direction = 'SHORT';
    }
```

The fix has already been applied in the current branch.

### Claim: Failure 2 — LLM prompt includes poisoned direction as Pre-parsed fields

**REFUTED.** The `llm-path.ts` at lines 173-177 explicitly guards multi_ticker messages:

```typescript
const isMultiTicker = parse.complexityFlags.has('multi_ticker');
if (!isMultiTicker && parse.action) knownParts.push(`action=${parse.action}`);
if (!isMultiTicker && parse.strategy) knownParts.push(`strategy=${parse.strategy}`);
if (!isMultiTicker && parse.direction) knownParts.push(`direction=${parse.direction}`);
```

Since message 466237 has `symbols=["OSCR","TSLA"]` (multi_ticker), the parser's direction is NOT included in the LLM prompt. The doc's claim that `Pre-parsed fields: action=OPEN, strategy=STOCK, direction=SHORT` appears in the prompt is incorrect for multi_ticker messages.

However, the `signalToParseResult` fallback at `llm-path.ts:277` does use `signal.direction ?? originalParse.direction` — so if the LLM does not explicitly set a direction, the parser's poisoned direction would still be used as a fallback. This is a weaker propagation mechanism than what the doc describes, but still a valid concern.

### Discrepancy: SHORTING_RE definition on main vs current branch

The doc describes the SHORTING_RE regex as:
```
/\b(shorting|shorted)\b|\bshort\b(?!\s*(?:term|squeeze|interest|sellers?|covering|side|dated|strike|week|leg|run))/i
```

This expanded regex only exists on the current branch. On `main`, SHORTING_RE is `/\b(shorting|shorted)\b/i` (verb-only). The old regex would NOT match "fundamental short" because it lacks the `\bshort\b` alternative. The doc presents the expanded regex as the "current" code causing the bug, but the same changeset that expanded the regex also applied the fix. The 21 SHORT trades in the database were created by older backtest/live runs using the narrower regex -- meaning the root cause for those existing trades is likely the LLM path independently choosing SHORT (via `signalToParseResult` fallback), not the parser's SHORTING_RE override.

### Summary

| Claim | Verdict |
|-------|---------|
| Trade 5c25bcef fields | CONFIRMED |
| Message 466237 fields | CONFIRMED |
| SHORTING_RE matches "fundamental short" | CONFIRMED |
| Badge override mechanism (old code) | CONFIRMED (structure correct, but old regex would not trigger on this text) |
| LLM prompt includes poisoned direction | REFUTED (multi_ticker guard prevents it) |
| 13+ backtest SHORT trades | CONFIRMED (exactly 13) |
| Fix A applied in current code | CONFIRMED |
| run_decisions JSON snapshot | INCONCLUSIVE (not found in DB as described) |

**Confidence in root cause**: MEDIUM. The root cause analysis is structurally correct about how the badge-override mechanism works and how SHORTING_RE can fire on adjective/noun uses of "short". The fix (badge priority) is sound and already applied. However, the doc overstates the mechanism for existing SHORT trades in the DB — those were created with the old narrower SHORTING_RE that would not match "fundamental short", so the LLM path's `signalToParseResult` fallback is the more likely culprit for existing data.

**Confidence in proposed fix**: HIGH. Fix A is correct, already applied, and prevents any future regression regardless of SHORTING_RE breadth. The badge-takes-precedence model is the right semantic choice.
