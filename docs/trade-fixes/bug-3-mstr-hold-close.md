# BUG-3: Spurious MSTR Close on "Hold" Message

## Summary

Trade 15 (170a1c38-bbc7-4e35-8af7-54b0c7f4a577) — a short MSTR STOCK position opened
from message 464036 ("Short MSTR $319.19") — was spuriously closed at $324.88 with -$82.95
P&L. The close was triggered by Pete's follow-up message (464092) which was explicitly a
hold/commentary update, not an exit signal.

## Close Message (464092)

```
I'm stuck in MSTR short. I like it as a swing short so I'm OK holding it.
If you don't have that level of conviction right now you can't trade.
It is a starter position so I would consider adding to the short if the stock
weakens and the market rolls over, but in that situation I would be looking to
exit the whole trade today. I would need to feel that the stock has a good chance
of getting back down to $322 in order to do that.
```

**Badges:** `[]` (none)
**Symbols detected:** `["MSTR"]`

This is a position update. Pete is saying: "I'm holding, but IF conditions meet my
threshold, I would THEN consider exiting." Explicitly not a close signal.

## Root Cause

Three compounding failures in `src/intents/orchestrator/parser.ts`:

### Failure 1: EXIT_VERB_RE matched a conditional clause

`EXIT_VERB_RE` = `/\b(exit(?:ing|ed)?|clos(?:e[ds]?|ing)|...)\b/i`

The word "exit" appears in: `"I would be looking to exit the whole trade today."`

This is a hypothetical/conditional clause (Pete says what he *would* do IF conditions are
met). The parser has no awareness of conditional modality — it fires on any bare "exit"
anywhere in the text. This set `action = 'CLOSE'`.

The `EXIT_VERB_FALSE_POSITIVE_RE` guard only covers fixed phrases like "closing down",
"close to", and "near the close" — not conditional framing like "would be looking to exit"
or "in order to".

### Failure 2: $322 parsed as premiumHint

The phrase `"getting back down to $322"` caused `extractTradeFields()` to return
`premiumHint = 322`. The $322 is a conditional price target ("I would need the stock to
reach $322"), not a trade premium or fill price.

The extraction logic treats any isolated `$<number>` not adjacent to an option keyword,
not after `@`, not near cost-basis keywords as the elimination fallback premium
(Rule 11: "single remaining unassigned dollar → premium").

### Failure 3: premiumHint suppressed extra_text → bypassed LLM

The `extra_text` complexity flag is the intended guardrail for long messages (>25 words).
At line 865–875 of parser.ts:

```ts
const fullyResolved = symbol !== null && (
  (strategy === 'STOCK' && hasBadge) ||
  (isSpread && strikes !== null && strikes.length >= 2) ||
  (!isSpread && (strikes !== null || premiumHint !== null))  // ← THIS
);
if (!fullyResolved) complexityFlags.add('extra_text');
```

Because `premiumHint = 322` (from Failure 2), `fullyResolved` evaluated to `true` for a
badgeless, 89-word STOCK message. This suppressed `extra_text`. No complexity flags
remained (the `relational` flag from "adding to" was also suppressed by the CLOSE-action
relational-suppression block at lines 827–834).

Result: the 89-word hold message took the deterministic position-path and executed a real
close order.

In some prior backtest runs, the LLM path was reached and correctly returned SKIP with
reasoning like "hypothetical/conditional planning, not an executed signal." The deterministic
path has no such understanding.

## Evidence

From `run_decisions` for message 464092:

- LLM-routed runs: `decision=SKIP`, reasoning = "hypothetical/conditional... pre-parsed
  fields suggest CLOSE but text is hypothetical/conditional, not an executed signal"
- The final run (df8c003c): `snapshot={"action":"CLOSE","premiumHint":322,"complexityFlags":[],
  "route":"deterministic"}` → EXECUTE → trade closed

Parser parse result every time:
```json
{
  "action": "CLOSE",
  "symbol": "MSTR",
  "strategy": "STOCK",
  "premiumHint": 322,
  "complexityFlags": [],
  "route": "deterministic"
}
```

## Proposed Fix

### Fix A: Add conditional-exit guard to EXIT_VERB detection (primary fix)

Add a new false-positive pattern for exit verbs preceded by conditional modifiers:

```ts
const EXIT_VERB_CONDITIONAL_RE =
  /\b(?:would|could|might|may|should|looking\s+to|consider(?:ing)?|need\s+to|plan(?:ning)?\s+to|hoping\s+to|in\s+order\s+to)\s+(?:\w+\s+){0,3}(?:exit|close|cover|sell)\b/i;
```

Then in the no-badge soft detection block (line 784):

```ts
if (
  EXIT_VERB_RE.test(cleanText) &&
  !EXIT_VERB_FALSE_POSITIVE_RE.test(cleanText) &&
  !EXIT_VERB_CONDITIONAL_RE.test(cleanText) &&   // ← add this
  symbol !== null
) {
```

This prevents "would be looking to exit" / "looking to close" / "in order to exit" from
triggering a CLOSE action.

### Fix B: Add hold/stuck explicit guard patterns (defense in depth)

Add hold-indicator patterns for hard skip or action=null:

```ts
const HOLDING_POSITION_RE =
  /\b(I'm\s+(?:OK\s+)?holding|stuck\s+in|OK\s+with\s+(?:the\s+)?position|holding\s+(?:it|this|the|my)|not\s+(?:closing|exiting|covering))\b/i;
```

If `HOLDING_POSITION_RE` matches and `EXIT_VERB_RE` would have triggered without badge,
treat as action=null (needs LLM or skip).

### Fix C: Clamp premiumHint range for STOCK strategy

For `strategy === 'STOCK'`, a dollar value of 322 is not a "premium" — it's a stock price.
The current `PREMIUM_MIN = 0.01` / `PREMIUM_MAX = 500` allows stock prices through. For
STOCK strategy, either:
- Set `premiumHint = null` (stocks don't have premiums)
- Or exclude dollar values that look like full stock prices (> $50 without option context)

This prevents the `fullyResolved` shortcut from suppressing `extra_text` on STOCK messages.

### Preferred approach

Fix A is the highest-value change: conditional-exit framing is a distinct false-positive
class that the current EXIT_VERB_FALSE_POSITIVE_RE doesn't cover. Fix C is a cleanup that
also matters — STOCK trades don't have premiums and the premiumHint field should be null
for them regardless.

Fix B (explicit hold patterns) adds insurance but is lower priority since Fix A + Fix C
together would have prevented this bug.

## Files Touched

| File | Change |
|---|---|
| `src/intents/orchestrator/parser.ts` | Add `EXIT_VERB_CONDITIONAL_RE`, guard in action detection, Fix C for STOCK premiumHint |

## Risk

- Fix A regex: test against real exit messages with "looking to" framing that ARE real exits
  (e.g., "I've been looking to exit and finally did it today"). The regex must match
  "looking to exit" but not "I looked to exit and it triggered" (past tense executed).
  Draft above uses `\b(?:would|could|...)` modal verbs — past-tense executed exits won't
  have these modals, so risk is low.
- Fix C (STOCK premiumHint nulled): `premiumHint` for STOCK currently has no downstream
  consumer (STOCK close/trim doesn't use premium), so nulling it is safe.

## Intersections

- **BUG-2 (TSLA close skip)**: Different failure mode (dedup/idempotency), no shared code.
- **ISSUE-3 (TSLA concatenated message)**: Both involve multi-sentence complex messages
  hitting the deterministic path incorrectly. Fix C (extra_text suppression) may overlap.
- **General conditional language**: Any message where Pete/Hari describe WHAT THEY WOULD DO
  under hypothetical conditions could trigger the same pattern. This class of message is
  common in trading commentary ("if it drops I'll exit", "I'd cover if X").
- The relational-flag suppression for CLOSE actions (lines 827–834) is a compounding factor:
  the "adding to" relational flag was legitimately present but got pruned, removing a
  potential guard.

## Reviewer Verification

Verified on 2026-03-04 against `data/trade-follower.db` and current source code
(`src/intents/orchestrator/parser.ts`).

### Claim 1: Trade 170a1c38-bbc7-4e35-8af7-54b0c7f4a577 exists and fields match

**CONFIRMED with minor discrepancy.**

```sql
SELECT id, source_message_id, trader, symbol, direction, strategy, status,
       entry_price, exit_price, quantity, pnl, opened_at, closed_at, close_message_id
FROM trades WHERE id = '170a1c38-bbc7-4e35-8af7-54b0c7f4a577';
```

| Field | Doc claims | Actual DB value |
|---|---|---|
| symbol | MSTR | MSTR |
| direction | SHORT | SHORT |
| strategy | STOCK | STOCK |
| status | (implied CLOSED) | CLOSED |
| entry_price | $319.19 | **319.35** |
| exit_price | $324.88 | 324.88 |
| pnl | -$82.95 | -82.95 |
| source_message_id | 464036 | 464036 |
| close_message_id | 464092 | 464092 |
| opened_at | (not stated) | 2025-09-04T15:39:22.000Z |
| closed_at | (not stated) | 2025-09-04T16:54:02.000Z |

**Discrepancy:** Doc says "Short MSTR $319.19" but this is the message text, not the
entry price. The open message (464036) `clean_text` = `"Short MSTR $319.19"` (confirmed),
but the actual fill price was 319.35 (market moved between signal and fill). This is not
an error in the bug report -- the doc quotes the message text correctly. The trade event
confirms entry_price = 319.35 via `trade_events`.

### Claim 2: Message 464036 (open message) exists

**CONFIRMED.**

```sql
SELECT id, author, clean_text, badges, symbols FROM messages WHERE id = 464036;
```

- author: Pete
- clean_text: `Short MSTR $319.19`
- badges: `["Short"]`
- symbols: `["MSTR"]`

### Claim 3: Message 464092 (close message) text matches

**CONFIRMED.** The `clean_text` from the DB matches the doc's quoted text character for
character.

```sql
SELECT clean_text, badges, symbols FROM messages WHERE id = 464092;
```

- badges: `[]` (empty array -- confirmed)
- symbols: `["MSTR"]` (confirmed)
- clean_text matches verbatim

### Claim 4: "89-word hold message"

**CONFIRMED.** Word count = 89 (verified via `text.trim().split(/\s+/).filter(Boolean).length`).

### Claim 5: EXIT_VERB_RE matches "exit" in message 464092

**CONFIRMED.** `EXIT_VERB_RE.exec(cleanText)` matches `"exit"` at character position 301,
inside the clause `"I would be looking to exit the whole trade today."`

### Claim 6: EXIT_VERB_FALSE_POSITIVE_RE does NOT catch it

**CONFIRMED.** `EXIT_VERB_FALSE_POSITIVE_RE.test(cleanText)` returns `false`. The guard
only covers "closing down", "close to", "near the close" etc. -- not conditional framing.

### Claim 7: $322 parsed as premiumHint

**CONFIRMED.** The `run_decisions` PARSED snapshots from the buggy era all show
`"premiumHint":322`. The `extractTradeFields` Rule 11 (elimination fallback: single
remaining unassigned dollar -> premium) is the cause. $322 is the only `$<number>` token
in the message, so it falls through to Rule 11 with `val=322`, which passes
`PREMIUM_MIN=0.01` and `PREMIUM_MAX=500`.

### Claim 8: premiumHint=322 caused fullyResolved=true, suppressing extra_text

**CONFIRMED.** In the buggy code path (before Fix C), the `fullyResolved` check at
line 896-900 (current numbering) evaluated:
```
symbol !== null       → true (MSTR)
!isSpread             → true (STOCK is not a spread)
premiumHint !== null  → true (322)
```
So `fullyResolved = true`, and `extra_text` was never added. With `complexityFlags = []`,
the route was `deterministic`.

The DB confirms this: all deterministic-routed PARSED snapshots show
`"complexityFlags":[],"route":"deterministic"`.

### Claim 9: Relational flag from "adding to" was suppressed

**CONFIRMED.** `RELATIONAL_RE` matches `"adding to"` at position 189 (verified by script).
The relational-suppression block at lines 836-843 (current code) deletes `relational` when
`action === 'CLOSE'` and no `multi_ticker` or `mixed_action` flags are present. Both
conditions held, so `relational` was deleted.

**However**, the DB shows an important nuance: in the LLM-routed runs (backtest runs
`230e8a54` and `08598b6d`), the PARSED snapshot shows `complexityFlags: ["relational"]`
with `route: "llm"`. This means those earlier runs did NOT have the relational suppression
for CLOSE actions, OR the action was not CLOSE in those runs' parser version. Either way,
the `relational` flag routed those runs to LLM, which correctly SKIPped.

In the deterministic-routed runs (many later runs), `complexityFlags: []` -- both
`relational` and `extra_text` were absent, confirming the doc's chain of causation.

### Claim 10: LLM-routed runs correctly SKIPped

**CONFIRMED.** Four agent-path SKIP decisions exist across 2 backtest runs (230e8a54,
08598b6d). Their reasoning is `"LLM did not call a decision tool"` (auto-SKIP).

Additionally, 3 other backtest runs routed through the `orchestrator` path and SKIPped
with rich reasoning:
- Run `6f7bbbba`: *"Pre-parsed fields suggest CLOSE but text is hypothetical/conditional,
  not an executed signal. Position update without action."*
- Run `e63d1990`: *"This is hypothetical/conditional planning, not a clear current trade
  signal... Pre-parsed fields appear to misinterpret conditional exit discussion as a
  definite CLOSE action."*
- Run `0857735f`: *"This is hypothetical/conditional planning, not a clear current action
  to open, close, or trim."*

The doc's paraphrase of the LLM reasoning is accurate.

### Claim 11: "The final run (df8c003c)" executed the close

**PARTIALLY REFUTED.** Run `df8c003c-342e-4e89-937e-42ad487429f9` exists as a backtest run
(COMPLETED, Grok model, Sep 2025 date range), but it has **0 run_decisions** in the DB for
message 464092 (or any message). It appears the run either used a different event-storage
mechanism or its decisions were not persisted.

The actual trade close (`trade_id = 170a1c38`) was triggered by a **live (non-backtest)
run** with `backtest_run_id = NULL`. The live PARSED snapshot matches exactly:
`{"action":"CLOSE","premiumHint":322,"complexityFlags":[],"route":"deterministic"}`.

There are also 5 backtest runs that deterministic-EXECUTEd the close: `0b86d787`,
`c94dec0b`, `b2de6318`, `9c9973c9`, `58a53d12`. The doc's claim about `df8c003c`
specifically is not verifiable from the data.

### Claim 12: Proposed Fix A (EXIT_VERB_CONDITIONAL_RE) is implemented

**CONFIRMED.** The regex exists at line 81-82 of the current `parser.ts`:
```ts
const EXIT_VERB_CONDITIONAL_RE =
  /\b(?:would|could|might|may|should|looking\s+to|consider(?:ing)?|need\s+to|plan(?:ning)?\s+to|hoping\s+to|in\s+order\s+to)\s+(?:\w+\s+){0,3}(?:exit|close|cover|sell)\b/i;
```
It is used in the no-badge soft detection at line 793:
```ts
if (EXIT_VERB_RE.test(cleanText) && !EXIT_VERB_FALSE_POSITIVE_RE.test(cleanText) && !EXIT_VERB_CONDITIONAL_RE.test(cleanText) && symbol !== null) {
```
Running the regex against the message text: matches `"would be looking to exit"` at
position 281. This correctly prevents the CLOSE action.

### Claim 13: Proposed Fix C (STOCK premiumHint nulled) is implemented

**CONFIRMED.** Line 895 of the current `parser.ts`:
```ts
if (strategy === 'STOCK') premiumHint = null;
```
This is inside the `wordCount > 25` block, before the `fullyResolved` check. With
`premiumHint = null` and no badge, `fullyResolved` evaluates to `false`, and `extra_text`
is correctly added to complexity flags.

### Current parser behavior (with all fixes)

Running `parseMessage` on message 464092's text with current code produces:
```json
{
  "action": "ADD",
  "symbol": "MSTR",
  "direction": "SHORT",
  "strategy": "STOCK",
  "premiumHint": null,
  "complexityFlags": ["relational", "extra_text"],
  "route": "llm"
}
```
- `action = ADD` (from the `/\b(adding|added)\b/i` match on "adding to")
- `premiumHint = null` (Fix C nulls it for STOCK)
- `complexityFlags = ["relational", "extra_text"]` (both present)
- This routes to LLM, which would SKIP

Note: The action is now `ADD` (not `CLOSE`), because Fix A blocks the EXIT_VERB match,
and the "adding" keyword match fires instead. The relational flag is NOT suppressed because
the relational-suppression block only fires for CLOSE/TRIM/LEG_OFF actions, not ADD.

The last two live run PARSED snapshots in the DB confirm this fixed behavior:
`{"action":"ADD","complexityFlags":["relational","extra_text"],"route":"llm"}` -> SKIP.

### Claim: Line numbers "865-875" and "827-834"

**MINOR DISCREPANCY.** The fullyResolved logic is at lines 890-904 (current code), not
865-875. The relational suppression is at lines 836-843, not 827-834. These line numbers
shifted due to the addition of `EXIT_VERB_CONDITIONAL_RE` and other changes above those
lines. The doc's line references reflect a prior version of the file.

### Summary

| # | Claim | Verdict |
|---|---|---|
| 1 | Trade exists with stated fields | CONFIRMED (entry_price is fill price 319.35, not message price 319.19 -- doc correctly quotes message) |
| 2 | Message 464036 is the open message | CONFIRMED |
| 3 | Message 464092 text matches | CONFIRMED verbatim |
| 4 | 89-word message | CONFIRMED |
| 5 | EXIT_VERB_RE matches "exit" | CONFIRMED |
| 6 | False positive guard misses | CONFIRMED |
| 7 | $322 parsed as premiumHint | CONFIRMED via DB snapshots |
| 8 | premiumHint suppressed extra_text | CONFIRMED via DB snapshots |
| 9 | Relational flag suppressed for CLOSE | CONFIRMED in deterministic runs |
| 10 | LLM runs correctly SKIPped | CONFIRMED with exact reasoning |
| 11 | df8c003c run executed the close | PARTIALLY REFUTED -- run exists but has 0 run_decisions; live run (null backtest_run_id) actually closed the trade |
| 12 | Fix A implemented correctly | CONFIRMED |
| 13 | Fix C implemented correctly | CONFIRMED |
| 14 | Line number references | MINOR DISCREPANCY -- shifted ~15-20 lines from doc's references |

**Root cause confidence: HIGH.** The three-failure chain (EXIT_VERB match on conditional
clause, $322 as premiumHint, premiumHint suppressing extra_text) is fully confirmed by DB
snapshots and parser code analysis. Fixes A and C are both implemented and verified working.

**Fix effectiveness confidence: HIGH.** Current parser output for message 464092 is
`action=ADD, complexityFlags=["relational","extra_text"], route=llm` -> would SKIP. Both
fixes independently prevent the bug: Fix A prevents CLOSE action, Fix C prevents
extra_text suppression.
