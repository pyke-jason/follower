# BUG-4: ABNB PUT 0DTE — Direction Inversion + No Expiry Close

## Trade Data

- Trade ID: `9ae30c1a-bab9-48f8-82f7-f5f08349c09d`
- Source message: `"Short ABNB Lotto $123 Puts for .21 - 40 Contracts"`
- Badges: `["Short"]`
- Symbols: `["ABNB"]`
- Recorded: `direction=LONG, strategy=PUT, action=BUY, status=OPEN`
- Leg: `ABNB 250905P00123000`, expiry `2025-09-05`, strike 123
- Opened: `2025-09-05T17:51:57Z` (0DTE — expiry same day)
- Current status: **OPEN** (should be closed/expired)

---

## Root Cause — Direction Inversion

### The Conflict

The message contains two signals that pull in opposite directions:

1. **`"Short"` badge** → `hasShortBadge = true` → trader intends SHORT (selling puts for premium)
2. **`"Lotto"` keyword** → `isLotto = true` → parser forces `direction = 'LONG'`

The orchestrator docs define "Lotto"/"Yolo" as: *speculative BUY, always direction: LONG, never sell-to-open.* The comment at line 733 says `// Lotto always overrides everything`.

### Execution Path

In `src/intents/orchestrator/parser.ts`:

1. `detectStrategy()` (line 556-559): `isLotto = true` → `strategy = 'PUT'`, `directionFromStrategy = 'LONG'`
2. Direction derivation (line 732-734):
   ```ts
   if (isLotto) {
     // Lotto always overrides everything
     direction = 'LONG';
   }
   ```
3. This fires **before** any badge or verb check. `SHORTING_RE` check at line 744 only runs inside `else if (strategy === 'STOCK')` — unreachable for PUT+lotto.
4. Result: `direction = 'LONG'` → leg recorded as `action: 'BUY'`

### What the Trader Meant

`"Short ABNB Lotto $123 Puts for .21 - 40 Contracts"`

The price `.21` per contract = $21 per contract × 40 = $840 credit. This is a **sell-to-open** (SHORT PUT) trade, collecting premium on cheap 0DTE puts. The "Lotto" refers to the risk/reward character of the trade from the *buyer's* perspective — selling lottery tickets, not buying them.

**Trader semantics**: "Short [strategy] [instrument]" = **selling** that instrument. The `"Short"` badge is authoritative. `"Lotto"` describes the option's character, not the trade direction.

### The Actual Semantic Ambiguity

The comment at line 733 is wrong for this case. "Lotto always overrides everything" is correct when there's NO direction-specifying badge. When `hasShortBadge = true`, the badge is the explicit trader intent. The fix: `isLotto` should set the **default** direction to LONG, not unconditionally override.

**The `"Short"` badge should win over LOTTO.**

---

## Root Cause — No Expiry Close

### Problem

The trade was opened on `2025-09-05` (the option expiry date itself — 0DTE). It remains `OPEN` in the DB as of `2026-03-04`. No close event was ever generated.

### Why `sweepExpired` Didn't Fire

`sweepExpired` lives in `src/backtest/sim-broker.ts`. It is **backtest-only** — it runs in the backtest runner (`src/backtest/runner.ts:266`) but has **no equivalent in live mode**.

`src/lib/expiry-warning.ts` exists for live mode but **only warns**. It sends Discord/Pushover alerts at 9AM and 2PM ET for expiring positions. It does NOT close positions.

Live mode has no mechanism to:
1. Auto-close positions when the option expiry date passes
2. Mark them as expired/worthless
3. Record a CLOSE event

This is the systemic gap documented as ISSUE-1. For BUG-4, the specific consequence is that a 0DTE option opened at 5:51 PM ET (after market close) would never get a close signal from the trader (it expired at close), and no system-side expiry sweep ran to close it.

### 0DTE Edge Case

Even if a live expiry sweep existed, opening at 17:51 UTC (that's 1:51 PM ET on Sept 5) for a 0DTE put is borderline. Options expire at 4:00 PM ET. The open happened before close, so the put was live. No close message came in. The sweep would need to run after 4:00 PM ET on Sept 5 to catch this.

---

## Evidence

```
Message text: "Short ABNB Lotto $123 Puts for .21 - 40 Contracts"
Badges: ["Short"]
direction_hint (DB): SHORT   ← DB correctly stored SHORT from original parsing
action_hint (DB): OPEN

Recorded trade:
  direction: LONG   ← WRONG
  leg action: BUY   ← WRONG (should be SELL/SHORT)
  status: OPEN      ← stuck open, never expired

Regex tests on actual message:
  SHORTING_RE match: true    (but only checked in STOCK branch)
  LOTTO_RE match: true       (triggers unconditional LONG override)
  CONTRACT_RE match: true    (prevents badge-implied STOCK fallback)
```

Note: The DB `direction_hint` column stores `SHORT` (correct), but the recorded `trade.direction` is `LONG` (wrong). The intent was captured correctly but overridden by the LOTTO rule.

---

## Proposed Fix

### Direction Fix (parser.ts lines 732-734)

**Current:**
```ts
if (isLotto) {
  // Lotto always overrides everything
  direction = 'LONG';
}
```

**Proposed:**
```ts
if (isLotto && !hasShortBadge) {
  // Lotto defaults to LONG (buying cheap options), but an explicit Short badge overrides.
  // "Short ABNB Lotto $123 Puts" = selling puts for premium, not buying.
  direction = 'LONG';
} else if (isLotto && hasShortBadge) {
  direction = 'SHORT';
}
```

This preserves the default LOTTO=LONG behavior while letting an explicit `"Short"` badge signal a sell-to-open. The `"Long"` badge should also be respected (`hasLongBadge` → LONG), but that's already the default so it's a no-op.

Additionally, the SHORTING_RE check at line 744 should be added to the PUT/CALL branch (lines 745-755) when `!isLotto`, to handle cases without badges.

### Expiry Fix (ISSUE-1 — systemic)

Out of scope for this bug analysis per instructions. BUG-4's expiry symptom is a consequence of the systemic ISSUE-1 gap: no live-mode expiry sweep. See ISSUE-1 analysis.

For this specific trade: manual backfill — record a CLOSE event for `2025-09-05` at expiry value (likely worthless at $0 since it was a short put near-ATM on expiry day, actual value depends on ABNB close price that day).

---

## Files Touched

- `src/intents/orchestrator/parser.ts` — direction derivation block (lines 732-755)
  - Guard `isLotto` override with `!hasShortBadge`
  - Optionally add SHORTING_RE check in PUT/CALL branch for non-lotto sells

---

## Risk

- **Low risk** for the direction fix: the change only affects messages where `isLotto=true AND hasShortBadge=true`. This combination is rare (most lotto trades are buys with a Long badge). Adding the Short badge guard is additive.
- **Regression risk**: Any message with "Lotto/Yolo" + Short badge would now be SHORT. Must check: are there any existing trades where a "Short" badge + "Lotto" was *intended* as a LONG? Seems implausible by trader semantics.
- **No effect on expiry**: direction fix doesn't address the open status — that requires the ISSUE-1 sweep.

---

## Intersections

- **ISSUE-1** (systemic expiry sweep): The stuck-open status of this trade is a direct symptom of ISSUE-1. The direction bug is independent but both need fixing for this trade to be correct.
- **orchestrator.md direction semantics**: The comment `"Short [ticker] puts/calls" = bearish/bullish VIEW, but BUYING options → direction: LONG` applies to naked short-badge with no sell verb. In this case the "Short" badge is clearly a sell directive (price of `.21` confirms premium collection). The `.21` pricing evidence supports SHORT classification.
- **BUG-1 (OSCR)**: Also a direction inversion issue. The proposed fix pattern (badge overrides LOTTO) is analogous to the authoritative-verb override pattern used elsewhere in the parser.

---

## Reviewer Verification

Verified 2026-03-04 against `data/trade-follower.db` and current source code.

### 1. Trade exists — CONFIRMED

```sql
SELECT id, source_message_id, trader, symbol, direction, strategy, status,
       legs, opened_at, entry_price, is_backtest
FROM trades WHERE id = '9ae30c1a-bab9-48f8-82f7-f5f08349c09d';
```

Result: trade exists. `source_message_id=464607`, `trader=Hariseldon`, `symbol=ABNB`,
`direction=LONG`, `strategy=PUT`, `status=OPEN`, `entry_price=0.21`,
`opened_at=2025-09-05T17:51:57.000Z`, `is_backtest=0` (live trade).

### 2. Source message — CONFIRMED

```sql
SELECT id, author, timestamp, clean_text, badges, symbols, action_hint, direction_hint
FROM messages WHERE id = '464607';
```

Result: `clean_text = "Short ABNB Lotto $123 Puts for .21 - 40 Contracts"`,
`badges = ["Short"]`, `symbols = ["ABNB"]`, `author = Hariseldon`.
Exact text match with bug report.

### 3. direction=LONG in DB — CONFIRMED

Trade record shows `direction=LONG`. The trade_events table also confirms:
`direction=LONG` in the OPEN event for this trade.

### 4. Leg action=BUY — CONFIRMED

Legs JSON from the trade: `[{"symbol":"ABNB  250905P00123000","strike":123,"expiry":"2025-09-05","type":"PUT","action":"BUY","quantity":1}]`.
The leg has `action: "BUY"` as claimed.

### 5. direction_hint vs trade direction — CONFIRMED

```sql
SELECT direction_hint FROM messages WHERE id = '464607';
-- Result: SHORT

SELECT direction FROM trades WHERE id = '9ae30c1a-bab9-48f8-82f7-f5f08349c09d';
-- Result: LONG
```

The message's `direction_hint` is `SHORT` (correct), but the recorded trade
`direction` is `LONG` (wrong). The `action_hint` is `OPEN` (correct).

### 6. isLotto code path — CONFIRMED (already fixed in working tree)

The **committed** code (HEAD) at `src/intents/orchestrator/parser.ts` line 732 reads:
```ts
if (isLotto) {
  // Lotto always overrides everything
  direction = 'LONG';
}
```

The **working tree** (uncommitted changes) has already applied the proposed fix:
```ts
if (isLotto && !hasShortBadge) {
  // Lotto defaults to LONG (buying cheap options), but an explicit Short badge overrides.
  direction = 'LONG';
} else if (isLotto && hasShortBadge) {
  direction = 'SHORT';
}
```

Running the parser on the ABNB message text with the current working tree code produces
`direction: SHORT` (correct). The fix works as described.

### 7. LOTTO_RE regex — CONFIRMED

`LOTTO_RE = /\blotto\b|\byolo\b/i` is defined at line 33 of parser.ts.
The word "Lotto" in "Short ABNB Lotto $123 Puts for .21 - 40 Contracts" matches.
Verified via scratchpad script: `LOTTO_RE.test(text)` returns `true`.

### 8. 0DTE claim — CONFIRMED

Legs JSON expiry: `"2025-09-05"`. Opened at: `2025-09-05T17:51:57.000Z`.
The option expiry date IS the same as the open date. This is indeed 0DTE.

### 9. sweepExpired is backtest-only — CONFIRMED

`sweepExpired` is defined in `src/backtest/sim-broker.ts` line 544. It is called from
`src/backtest/runner.ts` at lines 266 and 352. A grep for `sweepExpired` and
`autoCloseExpiring` in the `src/live/` directory returns zero matches.
No live-mode equivalent exists.

### 10. expiry-warning.ts only warns — CONFIRMED

`src/lib/expiry-warning.ts` contains `checkExpiryWarnings()` which calls
`sendSystemAlert()` to send Discord/Pushover notifications. It does NOT call
`recordTrade()`, `closePositionAtPrice()`, or any trade mutation function.
It purely sends alerts. The function `logExpiryNotices()` is the backtest
variant which only logs at info level.

### Discrepancies Found

**Line 75 — timezone error**: The doc states "a 0DTE option opened at 5:51 PM ET
(after market close)". This is wrong. `17:51 UTC` in September (EDT, UTC-4) is
`1:51 PM ET`, which is during market hours. Line 79 correctly states
"opening at 17:51 UTC (that's 1:51 PM ET on Sept 5)". Lines 75 and 79
contradict each other. Line 79 is correct.

**Quantity discrepancy**: The message says "40 Contracts" but the recorded trade
has `quantity=1` and the leg has `quantity=1`. The bug report does not mention
this, but it is a separate parsing issue (quantity was not extracted from the
message text for this trade).

**Fix already applied**: The proposed fix at lines 118-127 has already been applied
to the working tree of `src/intents/orchestrator/parser.ts` (uncommitted). The bug
report reads as if the fix is still pending, but the code change is already in place.

**Widespread impact**: The bug affected not just this one trade but many others.
A query for all Short+Lotto trades shows the same message text
("Short ABNB Lotto $123 Puts...") generated trades with `direction=LONG` across
older backtest runs and live runs, and `direction=SHORT` in newer runs (post-fix).
Other affected messages include "Short C $96 lotto puts", "Short NFLX Lotto Puts
$1182.5", and "Short AVGO using $332.5 Puts Lottos". All exhibited the same
direction inversion pattern in older runs.

### Confidence Assessment

**Root cause (direction inversion)**: HIGH confidence. The bug is clearly
demonstrated: the committed code has `if (isLotto) { direction = 'LONG'; }`
with no badge check, the trade in the DB has `direction=LONG` despite a
`Short` badge, and the fix (already in working tree) correctly produces
`direction=SHORT` when run against the same message.

**Root cause (no expiry close)**: HIGH confidence. `sweepExpired` exists only in
`src/backtest/sim-broker.ts` and is only called from `src/backtest/runner.ts`.
Zero live-mode invocations. `expiry-warning.ts` only sends alerts.

**Proposed fix correctness**: HIGH confidence. The fix is minimal and targeted.
Parser test with `npx tsx` confirms correct output. The `!hasShortBadge` guard
preserves default LONG behavior for badgeless/Long-badge lotto trades while
correctly flipping to SHORT when the Short badge is present.
