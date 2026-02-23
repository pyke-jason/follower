# Plan Document Audit

**Date**: 2026-02-23
**Auditor**: plan-auditor (data investigator)
**Scope**: All 5 plan documents cross-referenced against actual source code and CLAUDE.md standards

---

## 1. backtest-close-accuracy.md

### MAJOR: MARKET orders for options closes is a terrible idea

**The plan says** (line 77-108): Use `orderType: 'MARKET'` for all CLOSE/TRIM/LEG_OFF signals.

**Why this is wrong**: Options have massive bid-ask spreads. A $2.00 wide spread on a 12-contract position means MARKET fills eat $1,200 in slippage per close. The plan hand-waves this away saying "the fill model already adds realistic slippage" (line 101), but that is exactly the problem — a MARKET fill model will fill at the ask (for buys) or bid (for sells), which is the worst possible price. The current `computeModelFillPrice()` in `sim-broker.ts:318-324` uses the fill model to determine price between bid/ask, and MARKET orders get the natural side (bid for sells). This means every single close in the backtest gets the worst fill, which systematically understates returns.

The plan also claims "Real brokers fill MARKET close orders within the spread anyway" (line 107). This is false for options. Real brokers fill MARKET options orders at the NBBO, which IS the bid for sell orders. That is why real traders use limit orders for options.

**The actual root cause is correct**: LIMIT + 60-second cancel timeout is indeed causing closes to fail. But the fix is wrong.

**Better fix**: The code already has a PRICE_CHASE adjustment rule mechanism (`execute.ts:252-254`, `AdjustmentRule` type). The `buildOrderParams` function at line 246 sets up `PRICE_CHASE` with `stepAmount` and `intervalSec` when a limit price is provided. The fix should be: for CLOSE/TRIM/LEG_OFF, either (a) extend `cancelAfterSec` significantly (e.g., 300s or until next day boundary), or (b) add an aggressive chase rule that walks the price toward the natural side faster, or (c) convert to MARKET only after the chase fails (fallback). Any of these preserves fill quality while ensuring execution.

**Note**: There is already a separate task (#16) investigating a chase-based redesign, which is the right approach.

### MINOR: Line references are mostly correct but drifted

- Plan says `executeClose()` is at line 374 — **correct** (actual: line 374).
- Plan says `getSpreadMidpoint` call is at lines 397-402 — **correct** (actual: 397-402).
- Plan says `executeTrim()` is at line 525 — **correct** (actual: 525).
- Plan says `executeLegOff()` is at line 594 — **correct** (actual: 594).
- Plan says `cancelAfterSec: 60` from `ORDER_DEFAULTS.CALL` at `execute.ts:88` — **correct** (actual: line 88).
- Plan says runner pipeline opts at `runner.ts:689-694` — **correct** (actual: 689-694).
- Plan says `placeOrder()` at `execute.ts:290-292` for the pending path — **wrong**. The `placeOrder` function starts at line 270. The `result.status === 'OPEN'` check is at line 290. Minor offset error.

### MINOR: Step 4 (messageTimestamp) is unrelated scope creep

The plan bundles adding `messageTimestamp` to pipeline opts as part of this fix. This is unrelated to the CLOSE accuracy bug and should be a separate change. CLAUDE.md says "Only make changes that are directly requested or clearly necessary."

### Verdict: Plan identifies the correct problem but proposes a destructive fix. Do NOT use MARKET orders for options closes.

---

## 2. exit-message-display.md

### GOOD: Well-scoped, accurate analysis

The three views (side panel, detail page, story expander) are correctly identified with accurate file paths and line numbers.

### GOOD: Null handling is correct

The plan correctly identifies that `closeMessageId` is null for auto-closed trades and proposes graceful degradation (don't render the section). No empty-state UI needed.

### MINOR: Option B for side panel highlight is over-engineered

**The plan says** (line 69-74): Add a `secondaryHighlightMessageId` prop to ChatFeed.

**Reality check**: The ChatFeed component at `web/app/messages/chat-feed.tsx:37-72` already accepts `highlightMessageId`. Adding a second highlight prop means the component now has to manage two different highlight states with two different colors. This adds complexity to a component used in multiple contexts (ChatRoom, ChatPreview, trades side panel).

**Simpler alternative**: The side panel already passes data through `fetchTradeLinkedMessages()` which collects `closeMessageId` (verified at `actions.ts:137`). The ChatFeed already highlights `highlightMessageId` with blue. Instead of a second highlight color, just add a small "CLOSE" badge/label on the chat bubble for the close message, similar to how the "EXECUTE" badge already appears on enriched messages. This requires zero changes to ChatFeed's highlight system.

### MINOR: Fix 2 (detail page) duplicates ChatPreview component

Adding a second `ChatPreview` card for close context is reasonable, but the plan proposes fetching `getNearbyMessages` again with the close message's timestamp. This means two separate 60-second windows. Consider whether a single `fetchTradeLinkedMessages` call (which already gathers all linked messages) would be simpler for the detail page too.

### CLEAN: No CLAUDE.md violations detected.

### Verdict: Solid plan. The secondary highlight prop is slightly over-engineered but not harmful. The rest is correct and well-scoped.

---

## 3. trade-view-consistency.md

### GOOD: P&L inconsistency analysis is accurate

Verified against actual code:
- `trade-row.tsx:27-29`: Computes `grossPnl - comm` = net. **Confirmed** at actual lines 27-29.
- `trades-table-client.tsx:132-134`: Uses `formatCurrency(selectedTrade.pnl)` = gross. **Confirmed** at actual lines 132-134.
- `trades/[id]/page.tsx:100-104`: Uses `formatCurrency(trade.pnl)` = gross. **Confirmed** at actual lines 100-104.
- `outcome-legs-summary.tsx:39-41`: Computes `grossPnl - commission` = net. **Confirmed** at actual lines 39-41.

### OVER-ENGINEERED: New `web/lib/trade-display.ts` utility file

**The plan says** (Phase 1, lines 147-172): Create a new `computeTradePnlDisplay()` function in a new file `web/lib/trade-display.ts`.

**Why this is over-engineered**: The P&L computation is 3 lines of code:
```ts
const gross = trade.pnl != null ? safeParseFloat(trade.pnl) : null;
const comm = commissionSchedule ? computeTradeCommission(trade, commissionSchedule) : 0;
const net = gross != null ? gross - comm : null;
```

This exact pattern already exists in `trade-row.tsx:27-29` and `outcome-legs-summary.tsx:39-41`. Both already import `safeParseFloat` and `computeTradeCommission`. The "utility" wraps 3 lines and returns an object with `{ gross, commission, net }` — this is creating an abstraction for 3 lines of math. CLAUDE.md says "Do not abstract ahead of need" and "three similar lines of code is better than a premature abstraction."

**Simpler fix**: Just add the same 3-line pattern to the sidebar header and detail page. Two copy-pastes of 3 lines each. Done.

### CORRECT: Quantity null handling fix

Plan says change `{trade.quantity}` to `{trade.quantity ?? 1}` on `trades/[id]/page.tsx:107`. Verified: actual line 106 shows `{trade.quantity}` with no fallback. The table row at `trade-row.tsx:89` already has `?? 1`. One-line fix, correct.

### CORRECT: Realized P&L visibility fix

Plan says change the condition at `trades/[id]/page.tsx:108` from `trade.realizedPnl && trade.status === 'OPEN'` to show for all trades with non-zero realized P&L. Verified: actual line 108 reads `{trade.realizedPnl && trade.status === 'OPEN' && (`. The fix is correct — closed trades with trims should still show realized P&L.

### CORRECT: Event timeline threshold

Plan says change `tradeEvents.length > 1` to `> 0` at `trades/[id]/page.tsx:140`. Verified: actual line 140 reads `{tradeEvents.length > 1 && (`. Fix is correct for consistency with expanded row.

### QUESTIONABLE: Phase 3 — Unify message display strategy

The plan proposes switching the sidebar to use `getNearbyMessages()` instead of `fetchTradeLinkedMessages()`. This is a judgment call, not a bug fix. The sidebar currently shows directly-linked messages (1-3 messages), which is arguably better for a narrow 420px panel. Loading 10+ messages of context into a 420px sidebar with a virtualized list may not improve the UX. This should be a product decision, not bundled with a consistency fix.

### Verdict: Good diagnosis. The utility file is over-engineered (violates CLAUDE.md). The 4 minor display fixes are all correct and trivial. Phase 3 is scope creep.

---

## 4. trades-message-visibility.md

### GOOD: Analysis is thorough and data-backed

The 82% closeMessageId fill rate, average message lengths, and query performance numbers add credibility.

### GOOD: Step 1 (enable chat panel) is a correct 2-line fix

Verified: `trades/page.tsx:125` renders `<TradesTableClient trades={trades} runId={runId} />` with no `enableChatPanel`. Adding the prop is trivial and safe.

Verified: `traders/[name]/page.tsx:122` renders `<TradesTableClient trades={recentTrades} />` with no `enableChatPanel`. Same fix.

### OVER-ENGINEERED: Option C (both inline column + chat panel) is too much

The plan recommends BOTH an inline "Signal" column (LEFT JOIN + new column + return type change to 3 query functions + new `TradeWithPreview` type + update all callers) AND the chat panel. The inline column alone touches 6+ files and changes the return type of `getClosedTrades()`, `getTradesByBacktestRun()`, and `getOpenTrades()`.

**The simpler answer**: Just enable the chat panel everywhere (Step 1, 2 lines). The expanded row already shows the source message text via `fetchTradeStory()`. Between the chat panel and the expanded row, users have two click-based paths to see messages. Adding an inline column that shows a truncated 50-char preview adds marginal value for significant implementation cost.

If inline previews are truly wanted, a tooltip on the symbol cell (mentioned as an option in the plan itself at line 179) is far less invasive than a new column.

### WATCH OUT: Return type change cascade

The plan correctly identifies (lines 261-272) that changing query return types from `Trade[]` to `TradeWithPreview[]` ripples to 6+ callers including the dashboard (`web/app/page.tsx:58`) and open trades page. This is exactly the kind of cascade that makes a small feature expensive. The plan is honest about this, but still recommends doing it.

### GOOD: Close message column recommendation is "do NOT add"

The plan correctly advises against adding a close message inline column. This is the right call.

### Verdict: Step 1 is correct and trivial. Step 2 (inline column) is over-engineered for the value it provides. Do Step 1 only, then evaluate if more is needed.

---

## 5. trade-ux-audit.md

### GOOD: Comprehensive visual audit with concrete evidence

This is the strongest plan document. It documents exactly what each view renders, with exact data values (e.g., "$11,436 net" vs "$11,448 gross"), screenshots, and a clear priority ranking.

### ISSUE: "Executed (0)" count bug (Section 1e, line 99)

The plan identifies that the Messages tab shows "Executed (0)" despite 9 trades existing. This is flagged but not root-caused. This could be:
- A filter query bug (likely checking `run_decisions.decision = 'EXECUTE'` but the column stores different values)
- A data issue (decisions may be stored as 'intent' not 'EXECUTE')

The plan correctly says "Investigation needed first" (line 251). This is appropriate — no premature fix proposed.

### GOOD: Priority ranking is sensible

- P0: CLOSE signal not executing (backend accuracy) — correct, this is the highest-impact bug
- P1: P&L inconsistency, commission schedule, exit message display — correct priorities
- P2/P3: Minor display fixes — correct ordering

### MINOR: Effort estimates are optimistic

- "CLOSE signal MARKET orders: 15 min" — the fix is more complex than switching to MARKET (see audit item #1 above). Real fix involves chase logic redesign.
- "P&L consistency utility: 30 min" — if we skip the unnecessary utility file, the 4 one-line fixes are 5 minutes.

### NO ISSUES with CLAUDE.md compliance

This document is descriptive (audit findings), not prescriptive (code changes). It references the other plan docs for implementation details. No violations.

### Verdict: Strong audit document. Accurate, well-organized, useful as a reference. No bad recommendations (it defers to the other plans for fixes).

---

## Cross-Plan Issues

### OVERLAP: Exit message display appears in 3 documents

- `exit-message-display.md` — dedicated plan for showing close messages
- `trade-view-consistency.md` — mentions close message as part of "message display strategy" (Phase 3)
- `trades-message-visibility.md` — discusses close message column and visibility

These three plans all touch the same problem from different angles. Someone implementing all three would make redundant changes. The exit-message-display plan is the most focused and should be the single reference.

### OVERLAP: Chat panel enablement appears in 2 documents

- `trades-message-visibility.md` Step 1 — enable `enableChatPanel` on /trades and /traders pages
- `trade-ux-audit.md` Issue #7 — same fix, same files

These should be consolidated. The fix is 2 lines regardless.

### OVERLAP: P&L consistency appears in 2 documents

- `trade-view-consistency.md` — full P&L consistency plan with utility file
- `trade-ux-audit.md` Issues #2 and #3 — same P&L inconsistency

The audit doc correctly references the consistency plan. No conflict, just duplication of description.

### CONFLICT: MARKET orders vs chase logic

- `backtest-close-accuracy.md` proposes MARKET orders for all closes
- Task #16 (chase-logic-investigator) is designing a chase-based approach

These are mutually exclusive fixes for the same problem. The backtest-close-accuracy plan should be updated or marked as superseded once the chase approach is finalized.

---

## Summary: Issues by Severity

### BAD (do not implement as written)

| Plan | Issue | Why |
|------|-------|-----|
| backtest-close-accuracy.md | MARKET orders for options closes | Massive slippage, systematically understates returns. Use chase logic instead. |

### OVER-ENGINEERED (simpler alternative exists)

| Plan | Issue | Simpler Fix |
|------|-------|-------------|
| trade-view-consistency.md | New `computeTradePnlDisplay()` utility file | Copy the 3-line pattern to 2 more files |
| trades-message-visibility.md | Inline "Signal" column (Option C) | Just enable chat panel (Step 1 only) |
| exit-message-display.md | `secondaryHighlightMessageId` prop on ChatFeed | Add a "CLOSE" badge on the close message bubble |

### SCOPE CREEP (unrelated to stated problem)

| Plan | Issue |
|------|-------|
| backtest-close-accuracy.md | Step 4: messageTimestamp passthrough |
| trade-view-consistency.md | Phase 3: Unify message display strategy |

### CORRECT AND READY TO IMPLEMENT

| Plan | Fix | Effort |
|------|-----|--------|
| trade-view-consistency.md | Quantity null fallback (`?? 1`) | 1 line |
| trade-view-consistency.md | Realized P&L visibility for closed trades | 1 line |
| trade-view-consistency.md | Event timeline threshold `> 0` | 1 line |
| trade-view-consistency.md | Add commission to sidebar/detail P&L display | ~10 lines each |
| trades-message-visibility.md | Enable chat panel on /trades and /traders | 2 lines |
| exit-message-display.md | Show close message in story expander | ~15 lines |
| exit-message-display.md | Show close message on detail page | ~10 lines |
| trade-ux-audit.md | Add "Full Detail" link to side panel | ~5 lines |
