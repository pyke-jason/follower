# BUG-2: Missed TSLA Close — Duplicate Position

## Summary

Trade 14 (74d9b0e4-6b78-4366-9dcf-e3cfb9ccd3c0) was opened on message 464030 (Short TSLA).
Message 464090 ("Exit TSLA with a .71 cent loss - don't like this drop in VIX") should have
closed it. The close was missed. Trade 17 (message 464956, "Added to TSLA short") later
re-entered TSLA short as a second concurrent position (28 shares combined) instead of
collapsing into the existing open.

---

## Root Cause

**TWO independent failures stacked.** The bug is not one thing — it is the parser
producing a result that requires the LLM path, combined with the LLM consistently
disagreeing with the parser's action=CLOSE conclusion.

### Failure 1 — Parser: multi_ticker flag forces LLM

Message 464090 has `symbols = ["TSLA","VIX"]` (two tickers). The parser at line 656 of
`src/intents/orchestrator/parser.ts`:

```ts
if (symbols.length > 1) complexityFlags.add('multi_ticker');
```

This fires unconditionally, regardless of action. The orchestrator at line 110 of
`src/intents/orchestrator/index.ts`:

```ts
const needsLLM = parse.complexityFlags.size > 0 || parse.action === null || ctx.failureContext != null;
```

Because `complexityFlags` contains `multi_ticker`, `needsLLM` is `true`. The CLOSE
action is fully determined (Exit badge present, no fraction → CLOSE), the symbol is
unambiguous (TSLA, first in list), and no option fields are needed. Yet the message is
routed to the LLM anyway.

Compare to the existing relational suppression logic at lines 827–834:

```ts
if (
  (action === 'CLOSE' || action === 'TRIM' || action === 'LEG_OFF') &&
  complexityFlags.has('relational') &&
  !complexityFlags.has('multi_ticker') &&
  !complexityFlags.has('mixed_action')
) {
  complexityFlags.delete('relational');
}
```

The parser already knows that relational flags can be suppressed for exit actions.
The same reasoning applies to `multi_ticker` when VIX (or any non-tradeable / secondary
ticker) appears only in explanatory context. The guard `!complexityFlags.has('multi_ticker')`
in the relational suppression was intended to preserve genuinely ambiguous cases (e.g.,
"Exit TSLA and NVDA"), but it also blocks suppression for cases like this one where
the secondary ticker is pure commentary.

### Failure 2 — LLM: consistently skips a valid exit

Across 60 run_decisions for message 464090, the LLM (agent path) skipped the message
every time, reasoning: "this is commentary/position update without an explicit trade
action." The LLM is treating "Exit TSLA with a .71 cent loss" as a retrospective
report rather than an instruction — even though the **Exit badge is present**, which
is an authoritative signal from the parser.

The LLM is overriding a badge-derived CLOSE determination. The Exit badge is not
ambiguous; it is applied by the Discord bot when the human explicitly posts an exit.
The LLM should not be able to override the badge — but once the message reaches the
LLM path, the LLM has unconstrained authority to skip.

---

## Evidence

### DB records

```
messages.id = 464090
  author:      Hariseldon
  timestamp:   2025-09-04T16:49:16.000Z
  clean_text:  "Exit TSLA with a .71 cent loss - don't like this drop in VIX"
  symbols:     ["TSLA","VIX"]
  badges:      ["Exit"]
  action_hint: CLOSE
```

```
trades.id = 74d9b0e4-6b78-4366-9dcf-e3cfb9ccd3c0
  status:      OPEN  (never closed)
  symbol:      TSLA
  legs:        [{ symbol: "TSLA", type: "STOCK", action: "SELL", quantity: 14 }]
  opened_at:   2025-09-04T15:11:57Z (message 464030)
```

```
run_decisions for message 464090 (across all backtests):
  decision=SKIP, path=agent:       4 rows
  decision=SKIP, path=orchestrator: 2 rows
  decision=NULL (no decision):     54 rows
  Total:                           60 rows
  EXECUTE rows:                    0
```

The orchestrator-path SKIPs explicitly mention "pre-parsed action=CLOSE is incorrect."
This indicates those backtests used a different (older?) routing where the orchestrator
itself, not the LLM, did the skip. In the current code path (with the LLM path), all
runs send this to the agent which also skips it.

### Parser trace (reconstructed)

For message 464090:
- `badges = ["Exit"]` → `hasExitBadge = true`
- `symbols = ["TSLA","VIX"]` → `symbols.length > 1` → `complexityFlags.add('multi_ticker')`
- No fraction/percent → `action = 'CLOSE'`
- No relational pattern → `relational` NOT added
- `symbol = "TSLA"` (first symbol)
- `strategy = null` (no option keywords, no stock keywords → stays null; badge implies STOCK but no STOCK badge)

Actually wait — with hasExitBadge and no Long/Short badge, strategy detection falls through.
The badge-implied STOCK fallback at line 722 only fires for `hasLongBadge || hasShortBadge`.
So `strategy = null` for this message.

With `complexityFlags = { multi_ticker }` and `needsLLM = true`, it goes to LLM.

### Why the relational suppression doesn't help

The existing guard `!complexityFlags.has('multi_ticker')` explicitly prevents relational
suppression when multi_ticker is set. This was written to handle cases like "Exit TSLA
same as yesterday" (relational + multi_ticker simultaneously). But it creates a side
effect: even without relational, the multi_ticker alone gates the CLOSE to the LLM path.

---

## Proposed Fix

### Option A — Suppress multi_ticker for exit actions when secondary tickers are non-actionable

Add a suppression rule analogous to the relational suppression. After multi_ticker is
added, check:

1. The action is CLOSE, TRIM, or LEG_OFF (determined from badge, not ambiguous)
2. There are exactly two symbols
3. The first symbol is the trade symbol (already taken as `symbol`)
4. The second symbol is in a known non-actionable index list (VIX, SPY, QQQ, DXY, etc.)
   OR the second ticker appears only after a dash or "don't like" style clause

If these conditions hold, delete `multi_ticker` from complexityFlags.

This is the minimal fix: it only suppresses in the specific pattern (exit + commentary ticker).

```ts
// Suppress multi_ticker for exit actions when secondary symbol is pure commentary.
// "Exit TSLA with a .71 cent loss - don't like this drop in VIX" is a single-symbol
// exit; VIX appears in explanatory context only.
const NON_ACTIONABLE_TICKERS = new Set(['VIX', 'SPY', 'QQQ', 'IWM', 'DIA', 'DXY', 'TNX', 'VXX']);

if (
  (action === 'CLOSE' || action === 'TRIM' || action === 'LEG_OFF') &&
  complexityFlags.has('multi_ticker') &&
  symbols.length === 2 &&
  NON_ACTIONABLE_TICKERS.has(symbols[1])
) {
  complexityFlags.delete('multi_ticker');
}
```

### Option B — Constrain LLM authority when badge is definitive

Regardless of Option A, the LLM should not be able to skip a message when the Exit
badge is present and the parser derived action=CLOSE from it. The LLM prompt in
`src/intents/orchestrator/llm-path.ts` should communicate: "The Exit badge is
authoritative. You may not skip this message; you may only resolve ambiguous fields."

This is a harder change (requires understanding llm-path prompt structure) but would
prevent LLM override of badge-derived conclusions across all similar cases.

### Recommendation

Implement Option A in `parser.ts`. It is deterministic, testable, and does not require
LLM prompt changes. Option B is a separate, complementary hardening.

---

## Files Touched

- `src/intents/orchestrator/parser.ts` — add multi_ticker suppression rule for exits with
  non-actionable secondary tickers (lines 823–834 area, after relational suppression block)
- `src/intents/orchestrator/llm-path.ts` — (Option B) add constraint that Exit badge
  prevents SKIP decisions from the agent

---

## Risk

**Low for Option A.** The suppression is gated on:
- Exit action (not OPEN — we never want to suppress multi_ticker on opens)
- Exactly 2 symbols
- Second symbol in a known non-actionable set

This is conservative. A message like "Exit TSLA and NVDA" has two tradeable tickers
and will NOT trigger suppression. Risk of false negatives: minimal.

**Medium for Option B.** Constraining LLM authority changes agent behavior broadly.
Needs careful prompt engineering and testing. Should be done separately from Option A.

---

## Intersections

- **BUG-3 (Spurious MSTR close on "hold" message)**: opposite failure mode — the
  position-path is too eager to close when it shouldn't. BUG-2 is the LLM path being
  too eager to skip when it shouldn't. These are complementary: the deterministic path
  needs to be the authoritative path for unambiguous exit actions.

- **BUG-5 (Duplicate NVDA SHORT)**: raises the question of whether dedup logic should
  prevent opening a second concurrent position in the same symbol+direction. That guard
  would have prevented the 28-share combined position even if the close was missed, but
  is a separate concern.

- **ISSUE-3 (Missed TSLA signal in concatenated message)**: both BUG-2 and ISSUE-3
  are "missed close" bugs. If the same fix (suppress multi_ticker for exits) is applied,
  both may be partially addressed — but ISSUE-3 involves a concatenated message where
  the parse itself is ambiguous, so the root causes differ.

- **Parser relational suppression pattern** (lines 827–834): the proposed Option A
  directly mirrors this existing pattern. The implementation should be co-located and
  follow the same code convention for symmetry and reviewability.

---

## Reviewer Verification

Verified 2026-03-04 against `data/trade-follower.db` and current source code.

### 1. Trade 74d9b0e4-6b78-4366-9dcf-e3cfb9ccd3c0

**CONFIRMED.** Trade exists with the claimed fields.

```sql
SELECT id, source_message_id, trader, symbol, direction, strategy, legs, status,
       entry_price, opened_at, is_backtest
FROM trades WHERE id = '74d9b0e4-6b78-4366-9dcf-e3cfb9ccd3c0';
```

| Field | Claimed | Actual | Match |
|---|---|---|---|
| status | OPEN | OPEN | YES |
| symbol | TSLA | TSLA | YES |
| direction | (SHORT implied) | SHORT | YES |
| strategy | (STOCK implied) | STOCK | YES |
| legs | `[{symbol:"TSLA", type:"STOCK", action:"SELL", quantity:14}]` | `[{"symbol":"TSLA","strike":0,"expiry":"","type":"STOCK","action":"SELL","quantity":14}]` | YES (additional zero fields are expected) |
| opened_at | 2025-09-04T15:11:57Z | 2025-09-04T15:11:57.000Z | YES |
| source_message_id | 464030 | 464030 | YES |

Note: The report labels this "Trade 14" but in a deduplicated view of Hariseldon's live trades, it is actually trade #8 by opening time. There are 10 copies of this trade (one per backtest run), with 8 OPEN and 2 CLOSED. The "Trade 14" label does not correspond to any verifiable numbering scheme.

### 2. Message 464090 (the missed close)

**CONFIRMED.** All claimed fields match exactly.

```sql
SELECT id, author, timestamp, clean_text, badges, symbols, action_hint, detected_strategies
FROM messages WHERE id = 464090;
```

| Field | Claimed | Actual | Match |
|---|---|---|---|
| author | Hariseldon | Hariseldon | YES |
| timestamp | 2025-09-04T16:49:16.000Z | 2025-09-04T16:49:16.000Z | YES |
| clean_text | "Exit TSLA with a .71 cent loss - don't like this drop in VIX" | (identical) | YES |
| symbols | ["TSLA","VIX"] | ["TSLA","VIX"] | YES |
| badges | ["Exit"] | ["Exit"] | YES |
| action_hint | CLOSE | CLOSE | YES |

VIX does appear in the symbols array -- **CONFIRMED**.

### 3. Message 464030 (the open message)

**CONFIRMED with minor omission.** The report mentions it as "(Short TSLA)" but the actual clean_text is more detailed.

```sql
SELECT id, clean_text, badges, symbols, action_hint, direction_hint FROM messages WHERE id = 464030;
```

- clean_text: `Short TSLA $333.51 - 1,000 Shares - I see the SMA $4 below -`
- badges: `["Short"]`
- symbols: `["TSLA"]`
- action_hint: `OPEN`

This is consistent with the bug report's claim that 464030 opened a TSLA SHORT.

### 4. Message 464956 (claimed re-entry)

**PARTIALLY CONFIRMED / MISLABELED.** The bug report says message 464956 "re-entered TSLA short as a second concurrent position (28 shares combined)." The actual data tells a different story:

```sql
SELECT id, clean_text, badges, symbols FROM messages WHERE id = 464956;
-- Result: "Added to TSLA short - now 1,500 shares ($338.03 avg) -", badges=[], symbols=["TSLA"]
```

Message 464956 is an ADD, not a re-entry. The actual **re-entry** was message 464103:

```sql
SELECT id, clean_text, badges, symbols FROM messages WHERE id = 464103;
-- Result: "Re-entering the TSLA short $333.98 - 1,000 Shares", badges=[], symbols=["TSLA"]
```

The timeline is:
1. 464030 (15:04:56) -- "Short TSLA" -- OPEN 14 shares
2. 464090 (16:49:16) -- "Exit TSLA" -- **MISSED** (this bug)
3. 464103 (17:15:17) -- "Re-entering the TSLA short" -- OPEN 14 shares (creates duplicate)
4. 464956 (Sep 08) -- "Added to TSLA short" -- ADD 14 shares to 464103's position

The 28-share combined position (trade 986ab614) was from 464103 OPEN + 464956 ADD, not from 464956 alone. The bug report's claim that "Trade 17 (message 464956)" re-entered as a second concurrent position conflates two events: the re-entry (464103) and the add (464956).

### 5. Run decisions for message 464090

**PARTIALLY CONFIRMED -- counts differ.** The report claims 60 total rows; actual count is **74 rows**.

```sql
SELECT count(*) FROM run_decisions WHERE message_id = 464090;
-- Result: 74

SELECT decision, path, skip_category, count(*) FROM run_decisions
WHERE message_id = 464090
GROUP BY decision, path, skip_category ORDER BY count(*) DESC;
```

| decision | path | skip_category | count | Report claimed |
|---|---|---|---|---|
| NULL | NULL | NULL | 50 | 54 |
| NULL | NULL | skip | 11 | (not mentioned) |
| NULL | NULL | flagged | 7 | (not mentioned) |
| SKIP | agent | NULL | 4 | 4 |
| SKIP | orchestrator | skip | 2 | 2 |

- Total: **74** (not 60 as claimed)
- EXECUTE rows: **0** (CONFIRMED)
- SKIP with explicit decision: **6** (CONFIRMED: 4 agent + 2 orchestrator)
- NULL decision rows: **68** (not 54 as claimed), of which 11 have skip_category="skip" and 7 have skip_category="flagged"

The core claim stands: **zero EXECUTE decisions across all backtests**. The exact row counts are wrong but the important finding (no backtest ever successfully closed this trade) is correct.

### 6. Duplicate position / 28 shares claim

**CONFIRMED with corrected attribution.** Trade 986ab614 exists with quantity=28, source_message=464103, status=CLOSED. Trade events confirm it:

```sql
SELECT action, price, quantity, message_id FROM trade_events
WHERE trade_id = '986ab614-4dfc-45ae-b008-e3b8e0789cd7' ORDER BY timestamp;
-- OPEN  334.79  14  464103
-- ADD   345.95  14  464956
-- CLOSE 376.43  28  466237
```

The 28-share position is real but comes from message 464103 (re-entry, 14 shares) + message 464956 (add, 14 more). Multiple backtest runs show concurrent OPEN positions from 464030 and 464103/464956, confirming the duplicate position bug.

### 7. Parser code claims

**Line 656: `symbols.length > 1` triggers multi_ticker** -- **CONFIRMED.** Verified in committed version:
```
git show HEAD:src/intents/orchestrator/parser.ts | grep -n "symbols.length > 1"
=> 656:  if (symbols.length > 1) complexityFlags.add('multi_ticker');
```

**Lines 827-834: relational suppression** -- **CONFIRMED.** Verified in committed version:
```
git show HEAD:src/intents/orchestrator/parser.ts | sed -n '827,834p'
```
Shows the exact code block quoted in the report.

**Line 110 of index.ts: needsLLM** -- **CONFIRMED.**
```
grep -n "needsLLM" src/intents/orchestrator/index.ts
=> 110:  const needsLLM = parse.complexityFlags.size > 0 || parse.action === null || ctx.failureContext != null;
```

### 8. LLM path pre-parsed fields logic

**CONFIRMED.** At line 173-177 of `src/intents/orchestrator/llm-path.ts`:
```ts
const isMultiTicker = parse.complexityFlags.has('multi_ticker');
if (!isMultiTicker && parse.action) knownParts.push(`action=${parse.action}`);
if (!isMultiTicker && parse.strategy) knownParts.push(`strategy=${parse.strategy}`);
if (!isMultiTicker && parse.direction) knownParts.push(`direction=${parse.direction}`);
```

The report claims this is at "line 174" -- actual start is line 173. Close enough. The key point is correct: when `multi_ticker` is set, the LLM does NOT receive the pre-parsed `action=CLOSE` field, making it more likely to re-classify the message as non-actionable.

### 9. NON_ACTIONABLE_TICKERS / VIX in symbols

**CONFIRMED that VIX appears in message 464090's symbols array.** The proposed fix set in the report is `NON_ACTIONABLE_TICKERS = new Set(['VIX', 'SPY', 'QQQ', 'IWM', 'DIA', 'DXY', 'TNX', 'VXX'])`. The actually-implemented fix (already in the working tree as an uncommitted change) uses a narrower, more correct set named `UNTRADABLE_INDICES = new Set(['VIX', 'SPX', 'DXY', 'TNX', 'TYX', 'RUT', 'NDX', 'DJIA'])`. This is a better name and correctly excludes tradable ETFs (SPY, QQQ, IWM, DIA, VXX) from the suppression list, since those could legitimately be trade targets.

### 10. Parser verification (live test)

Running the current parser (with the UNTRADABLE_INDICES fix applied) on message 464090's text:

```
action: CLOSE, symbol: TSLA, strategy: null, direction: null
complexityFlags: [] (empty -- multi_ticker was suppressed)
needsLLM: false
```

**The fix works.** With the uncommitted change at lines 845-859 of parser.ts, message 464090 now routes to the deterministic position-path instead of the LLM path. The `multi_ticker` flag is added at line 658 and then deleted at line 857 because `action=CLOSE`, `symbols.length===2`, and `symbols[1]=VIX` is in `UNTRADABLE_INDICES`.

### Summary of discrepancies

| Claim | Verdict | Detail |
|---|---|---|
| Trade 74d9b0e4 fields | CONFIRMED | All fields match |
| Message 464090 fields | CONFIRMED | All fields match exactly |
| Message 464030 is the open | CONFIRMED | |
| Message 464956 is the "re-entry" | REFUTED | 464956 is an ADD; the actual re-entry is message 464103 |
| 60 run_decisions rows | REFUTED | Actual count is 74 |
| Zero EXECUTE rows | CONFIRMED | |
| 4 agent SKIP + 2 orchestrator SKIP | CONFIRMED | |
| 54 NULL decision rows | REFUTED | 68 NULL-decision rows (50 pure NULL + 11 skip + 7 flagged) |
| "Trade 17" numbering | INCONCLUSIVE | No verifiable numbering scheme matches |
| 28 shares combined | CONFIRMED | Trade 986ab614 has qty=28 from OPEN(14) + ADD(14) |
| Parser line numbers | CONFIRMED | 656, 827-834, index.ts:110 all exact |
| LLM path line 174 | CONFIRMED | Actual line 173, off by one |
| Proposed fix set includes SPY/QQQ | NOTED | Implemented fix correctly narrows to untradable indices only |

### Confidence assessment

**Root cause: HIGH confidence.** The two-failure analysis (multi_ticker forces LLM, LLM skips the exit) is well-supported by the data. Zero EXECUTE decisions across 74 run_decisions rows is strong evidence.

**Proposed fix (Option A): HIGH confidence.** The fix is already implemented in the working tree and verified to produce correct routing. The narrowing from `NON_ACTIONABLE_TICKERS` (which included tradable ETFs) to `UNTRADABLE_INDICES` (cash indices only) is a good refinement over the report's original proposal.

**Remaining gap:** The report does not address what happens when the deterministic position-path receives this CLOSE signal. With `strategy=null` (confirmed by parser output), the position-path must fuzzy-match the open TSLA SHORT position. This should work, but is not verified in this review.
