# Consensus Fixes — Final Prioritized Plan

**Date**: 2026-02-23
**Sources**: backtest-close-accuracy.md, exit-message-display.md, trade-view-consistency.md, trades-message-visibility.md, trade-ux-audit.md, plan-audit.md

---

## Priority Tiers

| Tier | Meaning | Count |
|------|---------|-------|
| P0 | Must fix — backtest accuracy is wrong | 1 fix (2 sub-steps) |
| P1 | Should fix — users see incorrect or missing data | 3 fixes |
| P2 | Nice to have — polish, consistency, convenience | 7 fixes |

---

## P0: CLOSE Order Chase Logic (Backtest Accuracy)

### What's broken

LIMIT CLOSE orders get a 60-second `cancelAfterSec` timeout. In backtest, sim-time jumps between messages (often >60s apart), so `OrderManager.tick()` auto-cancels the order on the very first tick after placement. The price chase mechanism never fires. Positions stay open until `sweepExpired()` closes them days later at intrinsic value. Example: PANW trade shows +$11,448 (expiry intrinsic) instead of +$4.60/contract (trader's actual exit).

### The correct fix

**NOT MARKET orders** — options have massive bid-ask spreads; MARKET fills systematically understate returns. The rewritten `backtest-close-accuracy.md` proposes chase logic instead.

| Step | What | File | Lines changed |
|------|------|------|---------------|
| 1 | Add `CLOSE_ORDER_DEFAULTS` table — wider step amounts, no `cancelAfterSec`, `maxSteps` cap | `src/pipeline/execute.ts` | ~15 |
| 2 | Modify `buildOrderParams()` to accept `isPositionReducing` flag; use `CLOSE_ORDER_DEFAULTS` when true | `src/pipeline/execute.ts` | ~10 |
| 3 | Pass `isPositionReducing: true` from `executeClose()`, `executeTrim()`, `executeLegOff()` | `src/pipeline/execute.ts` | ~6 (2 per function) |
| 4 | **Batch-apply chase steps** in `OrderManager.tick()` — compute `floor(elapsed / intervalSec)` steps instead of 1 step per tick | `src/orders/order-manager.ts` | ~15 |
| 5 | Day-boundary cleanup — cancel surviving close working orders before next day in runner | `src/backtest/runner.ts` | ~15 |

**Total**: ~60 lines across 3 files.

**Dependencies**: Step 4 (batch chase) is critical — without it, chase only moves 1 step per message regardless of time gap.

**Live path impact**: Safe. Live `OrderManager` ticks every ~1s (wall clock), so batch-step math has no effect. Removing `cancelAfterSec` for live CLOSE orders is actually an improvement (prevents position-reducing orders from dying prematurely).

### Chase parameter summary

| Parameter | STOCK | CALL/PUT | CDS/PDS |
|-----------|-------|----------|---------|
| stepAmount | $0.05 | $0.15 | $0.10 |
| intervalSec | 5 | 5 | 5 |
| cancelAfterSec | none (EOD) | none (EOD) | none (EOD) |
| maxSteps | 24 | 20 | 20 |
| Max price movement | $1.20 | $3.00 | $2.00 |

---

## P1: P&L Net/Gross Consistency

### What's broken

Table row shows net P&L ($11,436 = gross - $12 commission). Sidebar header and detail page show gross P&L ($11,448). Same trade, different numbers depending on where you click.

### The correct fix

**Do NOT create a `computeTradePnlDisplay()` utility file** — that wraps 3 lines of math in an abstraction nobody needs (plan-audit.md flagged this). Instead, inline the same 3-line pattern in the 2 places that currently show gross:

```ts
const gross = trade.pnl != null ? safeParseFloat(trade.pnl) : null;
const comm = commissionSchedule ? computeTradeCommission(trade, commissionSchedule) : 0;
const net = gross != null ? gross - comm : null;
```

| Step | What | File | Lines changed |
|------|------|------|---------------|
| 1 | Add net P&L computation to sidebar header | `web/app/components/trades-table-client.tsx` | ~5 |
| 2 | Add net P&L computation to detail page stats | `web/app/trades/[id]/page.tsx` | ~5 |
| 3 | Pass `commissionSchedule` to `/trades` page when `runId` is present (load from run config) | `web/app/trades/page.tsx` + `web/lib/queries.ts` | ~15 |

**Total**: ~25 lines across 3-4 files.

**Dependencies**: Step 3 requires a small query function to load commission schedule from `backtest_runs.config` by run ID.

---

## P1: Exit Message Display

### What's broken

`closeMessageId` is set on 82% of closed trades but no UI view renders the close message. Users cannot see why a trade was closed.

### The correct fix

Three sub-fixes, one per view. **Do NOT add `secondaryHighlightMessageId` prop to ChatFeed** — that over-engineers the shared component for a single use case (plan-audit.md flagged this). Use a CLOSE badge on the message bubble instead, or simply rely on the message being present in the feed.

| Step | What | File | Lines changed |
|------|------|------|---------------|
| 1 | Add `closeMessage` to `TradeStory` type + fetch in `fetchTradeStory()` | `web/app/trades/actions.ts` | ~5 |
| 2 | Render "Close Signal" zone in story expander (below open signal, only when present) | `web/app/components/trade-story-expander.tsx` | ~15 |
| 3 | Fetch close message on detail page + render second `ChatPreview` card for close context | `web/app/trades/[id]/page.tsx` | ~15 |

**Total**: ~35 lines across 3 files.

**Dependencies**: None. `closeMessageId` data already exists in DB.

**Null handling**: When `closeMessageId` is null (auto-closed by sweepExpired, 18% of closed trades), the close signal zone / card simply does not render. No placeholder needed.

---

## P1: Commission Schedule on /trades Page

### What's broken

Standalone `/trades?run=X` page does not load the commission schedule from the run config. Commission is always 0, so P&L always shows gross. The backtest trades tab correctly passes the schedule.

### The correct fix

| Step | What | File | Lines changed |
|------|------|------|---------------|
| 1 | When `runId` search param is present, load run config and extract `commissionSchedule` | `web/app/trades/page.tsx` | ~8 |
| 2 | Pass `commissionSchedule` to `TradesTableClient` | `web/app/trades/page.tsx` | ~1 |

**Total**: ~9 lines in 1 file (plus the query helper from P1 P&L fix step 3).

**Dependencies**: Ships with the P&L consistency fix (same query helper).

---

## P2 Fixes

### P2-A: Enable Chat Panel on /trades and /traders Pages

**What's broken**: Side-panel chat viewer only works on the backtest trades tab. `/trades` and `/traders/[name]` pages have no message viewing without navigating to the detail page.

| Step | What | File | Lines changed |
|------|------|------|---------------|
| 1 | Add `enableChatPanel` prop | `web/app/trades/page.tsx:125` | 1 |
| 2 | Add `enableChatPanel` prop | `web/app/traders/[name]/page.tsx:122` | 1 |

**Total**: 2 lines.

---

### P2-B: Quantity Null Fallback on Detail Page

**What's broken**: Detail page shows raw `null` for quantity. Table row defaults to `1`.

| Step | What | File | Lines changed |
|------|------|------|---------------|
| 1 | Change `{trade.quantity}` to `{trade.quantity ?? 1}` | `web/app/trades/[id]/page.tsx:106` | 1 |

---

### P2-C: Realized P&L Visible for Closed Trades

**What's broken**: Detail page only shows realized P&L (from trims) for open trades. Closed trades that had partial trims lose this information.

| Step | What | File | Lines changed |
|------|------|------|---------------|
| 1 | Remove `trade.status === 'OPEN'` condition; show for any trade with non-zero `realizedPnl` | `web/app/trades/[id]/page.tsx:108` | 1 |

---

### P2-D: Event Timeline Threshold Consistency

**What's broken**: Expanded row shows events if >= 1 event. Detail page shows events if >= 2. An open trade with only an OPEN event gets different behavior.

| Step | What | File | Lines changed |
|------|------|------|---------------|
| 1 | Change `tradeEvents.length > 1` to `> 0` | `web/app/trades/[id]/page.tsx:140` | 1 |

---

### P2-E: "Full Detail" Link in Side Panel

**What's broken**: Expanded sub-row has a "Full Detail" link to the trade detail page. Side panel does not.

| Step | What | File | Lines changed |
|------|------|------|---------------|
| 1 | Add link to `/trades/{id}` in side panel header | `web/app/components/trades-table-client.tsx` | ~5 |

---

### P2-F: Close Reason Label on Events Timeline

**What's broken**: CLOSE events in the timeline have no indication of *why* the trade closed (message-driven vs auto-expiration vs risk limit).

| Step | What | File | Lines changed |
|------|------|------|---------------|
| 1 | Derive reason from `closeMessageId` presence (has message = "Signal", null = "Auto") and display as label | `web/app/components/trade-story-expander.tsx`, `web/app/trades/[id]/page.tsx` | ~10 |

---

### P2-G: Side Panel Message Context Scope

**What's broken**: Side panel shows only directly-linked messages (1-3 messages via `fetchTradeLinkedMessages`). Detail page shows a 60-second window (~10 messages). Different views tell different stories.

This is a **product decision**, not a clear bug. The narrow 420px panel may not benefit from 10+ messages. List as P2 and evaluate after the other fixes ship.

| Step | What | File | Lines changed |
|------|------|------|---------------|
| 1 | Consider switching side panel to `getNearbyMessages()` or keep as-is | `web/app/trades/actions.ts` | ~10 (if done) |

---

## Implementation Phases

### Phase 1: Ship Together (P0 + related)

Chase logic fix is self-contained across 3 backend files. No frontend changes. Can be verified by re-running PANW backtest.

| Fix | Files |
|-----|-------|
| P0: Chase logic | `execute.ts`, `order-manager.ts`, `runner.ts` |

**Verification**: Re-run PANW backtest. PANW trade should close near $13.25 (bid at close time), not $18.19 (intrinsic). `closeMessageId` should be set.

### Phase 2: Ship Together (P1 fixes — data correctness)

All P1 fixes touch the web layer and relate to "what the user sees is wrong." Ship as one batch.

| Fix | Files |
|-----|-------|
| P1: P&L consistency | `trades-table-client.tsx`, `trades/[id]/page.tsx`, `trades/page.tsx`, `queries.ts` |
| P1: Commission schedule | `trades/page.tsx` (same file as above) |
| P1: Exit message display | `actions.ts`, `trade-story-expander.tsx`, `trades/[id]/page.tsx` |

**Verification**: Load PANW trade in all 4 views. P&L should match everywhere. Close message should appear in story expander and detail page.

### Phase 3: Ship Together (P2 — quick wins)

All P2 fixes are 1-5 lines each, independent, low risk. Ship as one cleanup batch.

| Fix | Files |
|-----|-------|
| P2-A: Chat panel enablement | `trades/page.tsx`, `traders/[name]/page.tsx` |
| P2-B: Qty null fallback | `trades/[id]/page.tsx` |
| P2-C: Realized P&L visibility | `trades/[id]/page.tsx` |
| P2-D: Event timeline threshold | `trades/[id]/page.tsx` |
| P2-E: Full Detail link in panel | `trades-table-client.tsx` |
| P2-F: Close reason label | `trade-story-expander.tsx`, `trades/[id]/page.tsx` |

P2-G (side panel message scope) deferred — evaluate after Phase 2 ships.

---

## Explicitly Excluded

| Proposal | Source | Why Rejected |
|----------|--------|--------------|
| **MARKET orders for all CLOSE/TRIM/LEG_OFF** | `backtest-close-accuracy.md` (original version) | Options have massive bid-ask spreads. MARKET fills hit the bid for sells, systematically understating returns by $0.50+/contract. Replaced by chase logic in the rewritten plan. |
| **`computeTradePnlDisplay()` utility file** | `trade-view-consistency.md` Phase 1 | Over-engineered. Wraps 3 lines of math in a new file + type. CLAUDE.md: "three similar lines of code is better than a premature abstraction." Inline the 3-line pattern instead. |
| **Inline "Signal" column in trades table** (LEFT JOIN + new column) | `trades-message-visibility.md` Option C / Step 2 | Changes return type of 3 query functions, ripples to 6+ callers including dashboard. The expanded row and chat panel already show message text on click. Marginal value for high implementation cost. Do Step 1 (enable chat panel) only. |
| **`secondaryHighlightMessageId` prop on ChatFeed** | `exit-message-display.md` Fix 1, Option B | Over-engineers a shared component (used by ChatRoom, ChatPreview, trades panel) for a single use case. Simpler: add a "CLOSE" badge on the close message bubble, or just rely on the message being present in the feed. |
| **`messageTimestamp` passthrough to pipeline** | `backtest-close-accuracy.md` Step 7 | Unrelated to the CLOSE accuracy bug. Scope creep. |
| **Phase 3: Unify message display strategy** | `trade-view-consistency.md` | Product decision, not a bug fix. Side panel's narrow scope (1-3 linked messages) may be intentional for its 420px width. Evaluate separately. |
| **Close message inline column in trades table** | `trades-message-visibility.md` | Null for 18% of closed trades, 100% of open trades. Low incremental value. Close message is better served via story expander and detail page. |

---

## Cross-Cutting Concerns

These items appear in multiple plan documents. Resolve once, not in 3 places:

| Concern | Appears In | Resolution |
|---------|-----------|------------|
| **Exit message display** | exit-message-display.md, trade-view-consistency.md Phase 3, trades-message-visibility.md | Single owner: `exit-message-display.md` Fix 2 (detail page) + Fix 3 (story expander). Skip the `secondaryHighlightMessageId` approach for the side panel. |
| **Chat panel enablement** | trades-message-visibility.md Step 1, trade-ux-audit.md Issue #7 | Single fix: add `enableChatPanel` to 2 pages. 2 lines total. |
| **P&L consistency** | trade-view-consistency.md Phase 1, trade-ux-audit.md Issues #2/#3 | Single owner: trade-view-consistency.md. Inline the 3-line pattern (not the utility file). |
| **Commission schedule loading** | trade-view-consistency.md Phase 1 Step 6, trade-ux-audit.md Issue #3 | Part of the P&L fix. Load from `backtest_runs.config` when `runId` query param is present. |
| **"Executed (0)" message count bug** | trade-ux-audit.md Issue #4 | NOT in scope for this consensus. Requires separate investigation — root cause unknown (likely a filter query checking the wrong column value). Track separately. |

---

## Summary: Effort by Phase

| Phase | Fixes | Files touched | Lines changed (approx) |
|-------|-------|---------------|------------------------|
| Phase 1 (P0) | 1 | 3 | ~60 |
| Phase 2 (P1) | 3 | 5 | ~70 |
| Phase 3 (P2) | 6 | 5 | ~20 |
| **Total** | **10** | **8 unique files** | **~150** |
