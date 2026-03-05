# ISSUE-3: Missed TSLA Signal in Concatenated Message

## Message

**ID:** 463439
**Text:** `Exit TXN with an .18 loss per share (1,000)Short TSLA $328.81 - 1,000 Shares`
**Badges:** `["Exit", "Short"]`
**Symbols:** `["TXN", "TSLA"]`
**has_multiple_trades:** 0 (not flagged in DB)

## Root Cause

**Two-layer failure: parser anchors the LLM to only the first signal, suppressing decomposition.**

### Layer 1 — Parser anchors first symbol only

The parser (`src/intents/orchestrator/parser.ts`, line 675) always picks `symbols[0]`:

```ts
const symbol = symbols.length > 0 ? symbols[0] : null;
```

For this message: `symbol = "TXN"`.

The parser then derives action, direction, and strategy from the full text using the Exit+Short badge combination:

- `action = CLOSE` (Exit badge wins, line 764)
- `direction = SHORT` (Short badge, line 737)
- `strategy = STOCK` (shares keyword, line 566)
- `complexityFlags = ["multi_ticker"]` (symbols.length > 1, line 656)

**Confirmed by running the parser:**
```
action=CLOSE, symbol=TXN, direction=SHORT, strategy=STOCK, premiumHint=328.81, complexityFlags=["multi_ticker"]
```

Critically, `mixed_action` is **not** set. The parser's mixed_action check (lines 664–671) looks for `BOUGHT_BUYING_RE` or `WROTE_WRITING_RE` in the text, neither of which appears. The word "Short" before TSLA is a badge-derived token, not a verb.

### Layer 2 — LLM receives pre-anchored fields that suppress multi-signal decomposition

The `buildNLUPrompt()` function in `llm-path.ts` (lines 171–176) includes all non-null parser fields:

```ts
if (parse.action) knownParts.push(`action=${parse.action}`);
if (parse.strategy) knownParts.push(`strategy=${parse.strategy}`);
if (parse.direction) knownParts.push(`direction=${parse.direction}`);
```

The prompt the LLM receives:
```
Pre-parsed fields: action=CLOSE, strategy=STOCK, direction=SHORT, premium=$328.81
Complexity: multi_ticker
```

The NLU system prompt says:
> "When a message describes multiple distinct actions... emit one signal per action"

However, the pre-parsed fields give the LLM a single anchor: `action=CLOSE, symbol=TXN`. The LLM interprets its role as confirming or refining the pre-parsed signal, not re-decomposing the whole message. It emits one signal: TXN CLOSE. The TSLA SHORT OPEN is silently dropped.

## Evidence

Every run_decisions row for message 463439 shows exactly one SIGNAL_RESOLVED event, always:
```json
{"orderType":"STOCK","legs":[{"type":"stock","symbol":"TXN","side":"BUY","quantity":1}]}
```

The TSLA OPEN signal never appears in SIGNAL_RESOLVED. The LLM consistently decomposes to only the TXN close across all backtest runs (230e8a54, 08598b6d, c54dbc85, 0857735f, etc.).

Token counts (inputTokens ~1527, outputTokens ~150–178) show the LLM is completing successfully — it is not truncating or erroring; it simply only emits the TXN signal.

## Why mixed_action Was Not Flagged

The `mixed_action` flag (parser lines 664–671) requires an "open intent verb" (`bought`, `buying`, `wrote`, `writing`) alongside an Exit badge. The message uses the implicit grammar `...Short TSLA $328.81...` where "Short" is a badge prefix, not a verb. The parser only checks for explicit verb tokens.

## Proposed Fix

**Fix at the LLM prompt layer, not the parser.**

The problem is that pre-parsed fields anchor the LLM to a single signal interpretation even when `multi_ticker` is set. When `multi_ticker` is in `complexityFlags`, the pre-parsed `action`, `strategy`, and `direction` fields come from the first symbol only and should not be sent as anchors.

### Option A (preferred): Suppress pre-parsed action/direction/strategy when multi_ticker is set

In `buildNLUPrompt()` in `llm-path.ts`:

```ts
// Only include pre-parsed action/direction/strategy if NOT multi_ticker
// (when multi_ticker, the parser fields reflect only the first symbol — misleading)
const isMultiTicker = parse.complexityFlags.has('multi_ticker');

if (!isMultiTicker && parse.action) knownParts.push(`action=${parse.action}`);
if (!isMultiTicker && parse.strategy) knownParts.push(`strategy=${parse.strategy}`);
if (!isMultiTicker && parse.direction) knownParts.push(`direction=${parse.direction}`);
// Always include strikes and expiry hints — these are symbol-agnostic
if (parse.strikes?.length) knownParts.push(`strikes=${parse.strikes.join('/')}`);
if (parse.expiryHint) knownParts.push(`expiryHint="${parse.expiryHint}"`);
if (parse.premiumHint !== null) knownParts.push(`premium=$${parse.premiumHint}`);
```

This allows the LLM to see the full message without being pre-anchored to one symbol's action, and naturally decompose "Exit TXN + Short TSLA" into two signals.

### Option B: Add mixed_action detection for badge-prefix shorts

In `parser.ts`, add a check for short-entry via badge next to multi_ticker:

```ts
// If Exit badge + Short badge + multi_ticker, the Short badge applies to a different
// symbol than the Exit badge → flag mixed_action
if (hasExitBadge && hasShortBadge && complexityFlags.has('multi_ticker')) {
  complexityFlags.add('mixed_action');
}
```

This is a narrower, more targeted fix. But it only helps if the LLM prompt handles mixed_action differently (currently it does not — both multi_ticker and mixed_action send the same anchored fields).

**Recommended: Option A** — it addresses the general case. Any multi_ticker message has ambiguous per-symbol fields; let the LLM re-derive them. Option B can be added as a belt-and-suspenders flag for completeness.

## Files Touched

| File | Change |
|---|---|
| `src/intents/orchestrator/llm-path.ts` | `buildNLUPrompt()`: suppress action/strategy/direction when `multi_ticker` is set |
| `src/intents/orchestrator/parser.ts` | Optional: flag `mixed_action` when `Exit+Short` badges with `multi_ticker` |

## Risk

**Low.** The LLM prompt change removes pre-filled fields for multi-ticker messages only. For single-ticker messages (the vast majority), behavior is unchanged. The LLM already handles multi-trade decomposition correctly when not anchored — the NLU_SYSTEM_PROMPT explicitly covers this case ("Multi-trade messages: decompose into separate signals").

Potential regression: single-symbol messages that currently rely on pre-parsed direction to avoid LLM re-derivation errors. These are unaffected since `multi_ticker` is only set when `symbols.length > 1`.

## Intersections

- **BUG-2 (Missed TSLA close):** That bug is about position-path failing to find TSLA SHORT on close. ISSUE-3 is about the open TSLA SHORT never being signaled. They are different failure modes but both involve TSLA and adjacent messages from the same trader.
- **BUG-1 (OSCR direction inversion):** Same LLM path is used for single-ticker messages with direction anchoring. The proposed fix does NOT affect single-ticker messages — it is strictly gated on `multi_ticker`.
- **The `premiumHint=328.81` in parser output** is a side-effect of the TSLA price ($328.81) being parsed by the dollar-elimination rule. This is a noise field in the pre-parsed context. With Option A, this misleading premium hint also stops being sent to the LLM for multi-ticker messages.

## Reviewer Verification

Verified 2026-03-04 against `data/trade-follower.db` and source code on branch `claude/review-executor-rewrite-ZJaZO`.

### 1. Message 463439 existence and fields

**CONFIRMED.** Message exists with exact values:

```sql
SELECT id, author, clean_text, badges, symbols, action_hint, direction_hint, has_multiple_trades
FROM messages WHERE id = 463439;
```

| Field | Claimed | Actual | Match |
|---|---|---|---|
| `clean_text` | `Exit TXN with an .18 loss per share (1,000)Short TSLA $328.81 - 1,000 Shares` | Same | YES |
| `badges` | `["Exit","Short"]` | `["Exit","Short"]` | YES |
| `symbols` | `["TXN","TSLA"]` | `["TXN","TSLA"]` | YES |
| `author` | (not claimed) | `Hariseldon` | N/A |
| `has_multiple_trades` | `0` | `0` (false) | YES |
| `action_hint` | (not claimed) | `CLOSE` | N/A |
| `direction_hint` | (not claimed) | `SHORT` | N/A |

### 2. Text exact match

**CONFIRMED.** The text is exactly `Exit TXN with an .18 loss per share (1,000)Short TSLA $328.81 - 1,000 Shares`. Note: no space between `(1,000)` and `Short` -- this is the concatenation the issue title refers to.

### 3. Parser output verification

**CONFIRMED.** Ran the parser via `scratchpad/verify-issue3-concat.ts` on exact message text. All fields match:

```
action=CLOSE, symbol=TXN, direction=SHORT, strategy=STOCK
premiumHint=328.81, complexityFlags=["multi_ticker"]
mixed_action=NOT SET, isHardSkip=false
```

All 8 assertions passed. The parser anchors symbol to `symbols[0]` ("TXN") at line 677 of `parser.ts`.

### 4. Line number accuracy

**PARTIALLY CONFIRMED.** The issue references are directionally correct but line numbers are slightly off from the current codebase:

| Issue claims | Actual line | Delta | Notes |
|---|---|---|---|
| `symbols[0]` at line 675 | Line 677 (`const symbol = ...`); 675 is the section comment | +2 | Minor |
| `action = CLOSE` at line 764 | Line 785 (`action = 'CLOSE'` inside `hasExitBadge` branch) | +21 | Wrong line, correct logic |
| `direction = SHORT` at line 737 | Line 744 (`direction = 'SHORT'` inside STOCK+hasShortBadge branch); 737 is lotto LONG | +7 | Wrong line, correct logic |
| `strategy = STOCK` at line 566 | Line 568-569 (STOCK_RE match in `detectStrategy()`) | +2 | Minor |
| `multi_ticker` at line 656 | Line 658 (656 is the section comment) | +2 | Minor |
| `mixed_action` at lines 664-671 | Lines 664-672 (exact match for the section) | 0 | Correct |
| `buildNLUPrompt` at lines 171-176 | Lines 175-177 in current working tree (with fix applied) | +4 | The "before" code lines match the committed version |

### 5. mixed_action detection

**CONFIRMED.** The mixed_action check at lines 666-672 requires `BOUGHT_BUYING_RE` or `WROTE_WRITING_RE` in the text. Neither matches. `SHORTING_RE` does match "Short" at index 43 of the text, but `SHORTING_RE` only affects direction derivation, not `mixed_action`. The issue's explanation is accurate: "Short" is a badge-prefix token, not a verb that triggers mixed_action.

### 6. Run decisions analysis

**CONFIRMED with nuance.** 152 total `run_decisions` rows for message 463439.

All SIGNAL_RESOLVED events across the 12 backtest runs in `run_decisions` produce only TXN trades. Every linked trade is `symbol=TXN, strategy=STOCK, direction=SHORT, status=CLOSED`, with `source_message_id=463393` (the TXN OPEN message) and `close_message_id=463439`. TSLA never appears in any SIGNAL_RESOLVED snapshot from these runs:

```sql
-- All trade_ids from run_decisions for msg 463439 resolve to TXN CLOSE
SELECT DISTINCT t.symbol FROM trades t
  INNER JOIN run_decisions rd ON t.id = rd.trade_id
  WHERE rd.message_id = 463439;
-- Result: TXN (only)
```

The four specific backtest run IDs cited in the issue (`230e8a54`, `08598b6d`, `c54dbc85`, `0857735f`) all exist and all show only TXN trades.

**Additional finding:** 54 TSLA trades exist in the `trades` table with `source_message_id = 463439`, but they come from older backtest runs (Feb 16-21, 2026) that predated the orchestrator/`run_decisions` system and have zero corresponding `trade_events` rows. These are not relevant to the issue's analysis, which focuses on the orchestrator pipeline.

### 7. Token counts

**CONFIRMED.**

```sql
SELECT input_tokens, output_tokens FROM run_decisions
  WHERE message_id = 463439 AND input_tokens > 0 LIMIT 10;
-- All rows: input_tokens=1527, output_tokens ranges 150-178
```

The issue's claim of "~1527 input, ~150-178 output" is exact. The LLM completes successfully without truncation -- it simply emits only a TXN signal.

### 8. LLM prompt anchoring (buildNLUPrompt)

**CONFIRMED (before fix) / FIX ALREADY APPLIED.**

The **committed** code (HEAD at `24ce1ec`, Feb 26) does NOT have the multi_ticker guard:
```ts
// committed version — no guard
if (parse.action) knownParts.push(`action=${parse.action}`);
if (parse.strategy) knownParts.push(`strategy=${parse.strategy}`);
if (parse.direction) knownParts.push(`direction=${parse.direction}`);
```

The **working tree** already has the proposed Option A fix applied as an uncommitted change:
```ts
// working tree — fix applied
const isMultiTicker = parse.complexityFlags.has('multi_ticker');
if (!isMultiTicker && parse.action) knownParts.push(`action=${parse.action}`);
if (!isMultiTicker && parse.strategy) knownParts.push(`strategy=${parse.strategy}`);
if (!isMultiTicker && parse.direction) knownParts.push(`direction=${parse.direction}`);
```

The issue's description of the pre-fix behavior (Layer 2) is accurate: the LLM received `action=CLOSE, strategy=STOCK, direction=SHORT, premium=$328.81` which anchored it to only the TXN close signal.

### 9. premiumHint=328.81 side-effect

**CONFIRMED.** The parser extracts `$328.81` from the TSLA price as a premium hint via the dollar-elimination rule (Rule 11 in `extractTradeFields`). For STOCK strategy, `premiumHint` is normally nulled out at line 895, but only when `wordCount > 25`. The message has 14 words, so the null-out does not trigger. The LLM receives a misleading `premium=$328.81` that belongs to the TSLA signal, not the TXN close.

With the Option A fix applied, this premium still flows to the LLM prompt (it is not gated by `isMultiTicker`), but since `action`/`strategy`/`direction` are no longer anchoring the LLM, the premium is less likely to cause confusion.

### 10. Option B (mixed_action for badge-prefix shorts)

**CONFIRMED as stated.** The issue correctly notes that Option B alone would be insufficient because mixed_action does not currently change prompt behavior differently from multi_ticker -- both still send all pre-parsed fields in the committed code. Option B is a belt-and-suspenders addition.

### Summary

| Claim | Verdict |
|---|---|
| Message 463439 text, badges, symbols | **CONFIRMED** -- exact match |
| `has_multiple_trades = 0` | **CONFIRMED** |
| Parser output: action=CLOSE, symbol=TXN, direction=SHORT, strategy=STOCK | **CONFIRMED** via script execution |
| `premiumHint = 328.81` | **CONFIRMED** |
| `complexityFlags = ["multi_ticker"]` | **CONFIRMED** |
| `mixed_action` not set | **CONFIRMED** -- "Short" is not a verb token |
| Line number references | **PARTIALLY CONFIRMED** -- 2 of 7 are off by 7-21 lines; logic references are all correct |
| Run decisions show only TXN CLOSE | **CONFIRMED** -- 12 backtest runs, all TXN only in SIGNAL_RESOLVED |
| Token counts ~1527/~150-178 | **CONFIRMED** -- exact match |
| LLM prompt anchoring (pre-fix) | **CONFIRMED** -- committed code sends all fields; working tree has fix |
| Layer 2 code snippet (lines 171-176) | **CONFIRMED as pre-fix behavior** -- the snippet shown in the issue matches the committed (buggy) code |
| Proposed fix Option A | **CONFIRMED** -- already applied in working tree as uncommitted change |
| Backtest run IDs (230e8a54, 08598b6d, c54dbc85, 0857735f) | **CONFIRMED** -- all exist and match |

### Discrepancies

1. **Line numbers off by 2-21 lines** for action (claimed 764, actual 785), direction (claimed 737, actual 744), and strategy (claimed 566, actual 568). The logic descriptions are correct in every case; only the line numbers are stale or approximate.
2. **Issue says "TSLA OPEN signal never appears"** -- this is accurate for the orchestrator pipeline (run_decisions), but 54 TSLA trades with `source_message_id=463439` exist from older backtest runs that predate the orchestrator. Not a factual error in the issue, but worth noting for completeness.
3. **premiumHint is not suppressed for multi_ticker** -- the current fix (Option A) only suppresses `action`, `strategy`, and `direction` for multi_ticker. `premiumHint` (`$328.81`) still passes through to the LLM. The issue mentions this at the bottom ("With Option A, this misleading premium hint also stops being sent") but this claim is **INCORRECT** -- the fix code does not gate `premiumHint` on `isMultiTicker`. The LLM still receives `premium=$328.81`.

### Confidence in Root Cause and Proposed Fix

**High confidence.** The root cause analysis is well-supported by data: the parser anchors to `symbols[0]`, the LLM receives pre-parsed fields that suppress multi-trade decomposition, and all 12 backtest runs consistently show only TXN CLOSE with no TSLA signal.

The proposed fix (Option A) is sound in principle and already applied as an uncommitted change. One minor gap: the issue's closing claim that Option A also suppresses the misleading `premiumHint` is incorrect -- the working tree code still sends `premium=$328.81` for multi_ticker messages. This should be evaluated: for this specific message, the $328.81 is TSLA's share price and could confuse the LLM into misinterpreting the TXN exit price. Gating `premiumHint` on `!isMultiTicker` (or at least on `strategy !== 'STOCK'` in the STOCK case) may be worth adding.

## Fix C Addendum: premiumHint Leak (Option C — Suppress ALL Per-Symbol Hints)

### Gap Identified

The original Option A fix only suppressed `action`, `strategy`, and `direction` for multi_ticker messages. Three additional per-symbol fields still leaked through to the LLM prompt: `premiumHint`, `strikes`, and `expiryHint`.

### Impact Analysis

Ran the parser on all 121 multi-ticker messages from tracked traders:
- **14 messages** have a non-null `premiumHint` that leaks to the LLM
- **3 are definite stock price leaks** (>$50, strategy=STOCK):
  - msg 483027: `$184.21` (NVDA avg price, not a premium)
  - msg 463439: `$328.81` (TSLA entry price, not a premium)
  - msg 463393: `$198.10` (TXN entry price — here the symbol matches, but for single-symbol it would already be handled correctly)
- **11 are option premiums** from the second trade in the concatenated message (e.g., `$3.77` for META PDS, `$2.10` for IONQ puts) — misleading because they belong to a different symbol than `symbols[0]`
- **1 message** has strikes that leak: msg 474169 (`strikes=[705,695,1]` from META PDS mixed with a stray `1`)
- **0 messages** have expiryHint leak

### BUG-3 Fix C Interaction

Parser line 895 nulls premiumHint for STOCK strategy, but ONLY when `wordCount > 25`. Message 463439 has 14 words, so the null-out does NOT trigger. BUG-3 Fix C does NOT address this case.

### Fix Applied

Changed `buildNLUPrompt()` in `llm-path.ts` to suppress ALL per-symbol fields (including `premiumHint`, `strikes`, `expiryHint`) when `multi_ticker` is set. The LLM reads the raw message text and extracts these values per-signal during decomposition.

```ts
// Before (partial fix — only action/strategy/direction suppressed):
if (!isMultiTicker && parse.action) knownParts.push(...);
if (!isMultiTicker && parse.strategy) knownParts.push(...);
if (!isMultiTicker && parse.direction) knownParts.push(...);
if (parse.strikes?.length) knownParts.push(...);        // LEAKED
if (parse.expiryHint) knownParts.push(...);              // LEAKED
if (parse.premiumHint !== null) knownParts.push(...);    // LEAKED

// After (full fix — all per-symbol hints suppressed):
if (!isMultiTicker && parse.action) knownParts.push(...);
if (!isMultiTicker && parse.strategy) knownParts.push(...);
if (!isMultiTicker && parse.direction) knownParts.push(...);
if (!isMultiTicker && parse.strikes?.length) knownParts.push(...);
if (!isMultiTicker && parse.expiryHint) knownParts.push(...);
if (!isMultiTicker && parse.premiumHint !== null) knownParts.push(...);
```

### Risk

**Very low.** For multi_ticker messages, the LLM already receives the full message text containing all strikes, premiums, and expiry dates. The pre-parsed values are a single merged view across all symbols and are actively misleading. Suppressing them lets the LLM decompose each sub-trade independently from the text.

For single-ticker messages (vast majority), behavior is completely unchanged.
