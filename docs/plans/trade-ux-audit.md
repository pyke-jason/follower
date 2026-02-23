# Trade UX Visual Audit — Findings & Recommendations

**Date**: 2026-02-23  
**Scope**: PANW trade (ID `78a91478-e717-42ec-92c0-0ef96eb463a3`) in backtest `63945507-1de8-411a-aac2-fe1f74ec7f02`  
**Method**: Playwright browser automation — loaded every page, extracted DOM content, took screenshots

---

## 1. Visual Audit: What Each View Actually Renders

### 1a. Backtest Trades Table (`/backtests/{id}?tab=trades`)

A compact table with one row per trade. Columns: expand chevron, symbol, trade-count indicator, trader link, direction badge, strategy badge, qty, entry price, exit price, P&L (net), commission annotation, realized P&L (`--`), another metric (`--`), opened date, status badge.

**PANW row**: `PANW | 1L (C) | Hariseldon | LONG | CALL | 12 | $8.65 | $18.19 | $11,436.00 | (-$12.00) | -- | -- | Sep 8, 2:39 PM | CLOSED`

Screenshot: `/Users/jason/trade-follower-3/scripts/audit-panw-trades-table.png`

**Key observations**:
- P&L is **net of commission** ($11,448 gross - $12 comm = $11,436 shown)
- No message text visible at the row level — users see only trade metadata
- No indication of why the trade closed or whether there's a linked close message
- Row is clickable (opens side panel) and has a chevron (opens expanded sub-row)

### 1b. Expanded Sub-Row (chevron click)

Clicking the chevron expands an inline detail panel beneath the row containing three zones:

**Zone A — Signal**: Author avatar, timestamp (Sep 8, 2:37 PM), full message text ("Long PANW $190 Calls 9/19 - for $8.65 - 15 Contracts"), EXECUTE badge, agent reasoning text ("Clear OPEN signal for PANW 190C buy, no prior position, price consistent with quote.")

**Zone B — Events**: Numbered timeline:
1. OPEN — 12 @ $8.65 — Sep 8, 2:39 PM
2. CLOSE — 12 @ $18.19 — Sep 19, 4:00 PM

**Zone C — Outcome**: P&L $11,436.00 (net), comm -$12.00, entry→exit ($8.65 → $18.19), Qty 12, hold time 11d 1h, direction BUY, legs (12x 190C 9/19), "Full Detail →" link.

Screenshot: `/Users/jason/trade-follower-3/scripts/audit-panw-expanded.png`

**Key observations**:
- Only the OPEN signal message is shown — no close/exit message
- The CLOSE event (Sep 19, 4:00 PM) has no "reason" label — unclear if this was a message-driven exit or automatic expiration
- "Full Detail →" link navigates to `/trades/78a91478-e717-42ec-92c0-0ef96eb463a3`
- Quantity discrepancy: message says "15 Contracts" but trade opened with 12 (position sizing reduced it — not explained in UI)

### 1c. Side Panel (row body click)

Clicking the PANW row body (not the chevron) opens a right-side split panel. The expanded sub-row and side panel are mutually exclusive — clicking the row body after expanding closes the expansion.

**Panel header card**: Symbol (PANW), direction (LONG), strategy (CALL) badges, P&L **$11,448.00** (gross).

**Chat area**: One message bubble — Hariseldon at 2:37 PM, "Long PANW $190 Calls 9/19 - for $8.65 - 15 Contracts", highlighted with blue ring and EXECUTE badge.

**Sub-table**: Lists ALL trades for the same underlying symbol (PANW) from this backtest — 9 total rows, not just the clicked trade.

Screenshot: `/Users/jason/trade-follower-3/scripts/audit-panw-panel-wide.png`

**Key observations**:
- P&L is **gross** ($11,448) — differs from the table row ($11,436 net)
- Only entry message shown — no exit/close message visible
- No events timeline, no agent reasoning, no outcome stats
- No "Full Detail" link — unlike the expanded sub-row
- Side panel has LESS information than the expanded sub-row
- The sub-table groups by symbol, not by individual trade — clicking one PANW trade shows all 9

### 1d. Trade Detail Page (`/trades/{id}`)

Full standalone page with two columns.

**Left column**:
- Header: PANW with LONG, CALL, CLOSED badges
- Stats: Trader (Hariseldon), Entry Price ($8.65), Exit Price ($18.19), P&L ($11,448.00 gross), Quantity (12), Opened (Sep 8, 2:39 PM), Closed (Sep 19, 4:00 PM)
- Legs table: `PANW 250919C00190000 | CALL | 190 | 2025-09-19 | BUY | 12 | --`
- Trade Events timeline (same as expanded sub-row: 1. OPEN, 2. CLOSE)
- Signal Decision (collapsed accordion)

**Right column** ("Chat Context"):
- "View all →" link
- Stream of surrounding messages from entry day (Sep 8), roughly 2:04 PM - 3:18 PM
- Entry message highlighted with blue ring
- Context messages include other traders' unrelated chat

Screenshot: `/Users/jason/trade-follower-3/scripts/audit-panw-detail-full.png`

**Key observations**:
- P&L is **gross** ($11,448), matching side panel but not the table ($11,436)
- Chat context shows only entry-day messages within ~60 seconds of the source message
- No exit/close message displayed — the close was 11 days later (Sep 19)
- No close reason indicated
- `data-message-id` attributes found on 9 chat messages (entry context only): `464922, 464932, 464934, 464941, 464943, 464952, 464955, 464956, 464959`
- No `data-close-message-id` attribute exists anywhere on the page

### 1e. Messages Tab (`/backtests/{id}?tab=messages`)

Shows "Decision Outcomes" chart + filterable message list with these filters: All, With Intent (579), Executed (0), Skipped (579), Labeled, Unlabeled, Mismatched, Needs Review.

Screenshot: `/Users/jason/trade-follower-3/scripts/audit-panw-messages-tab-full.png`

**Key observations**:
- **"Executed (0)" is wrong** — 9 trades were executed from messages in this backtest, yet the filter shows 0
- With "With Intent" filter active, PANW messages appear but are mixed with all 579 messages
- PANW close message `465396` ("Exit PANW with $4.60 profit per contract (15)") is not visually linked to the PANW trade

### 1f. /trades Page (`/trades?run={id}`)

Global trade history table filtered by run. Shows 7 trades, 57.1% win rate, summary stats.

**PANW row**: `PANW | 1L (C) | Hariseldon | LONG | CALL | 12 | $8.65 | $18.19 | $11,448.00 | -- | -- | Sep 8, 2:39 PM | CLOSED`

Screenshot: `/Users/jason/trade-follower-3/scripts/audit-panw-trades-page.png`

**Key observations**:
- P&L is **gross** ($11,448) — matches detail page and side panel, but NOT the backtest trades tab ($11,436 net)
- PANW symbol is a clickable link to `/trades/78a91478-e717-42ec-92c0-0ef96eb463a3?run=...`
- Row click does NOT open a side panel (unlike the backtest trades tab) — `enableChatPanel` is not passed
- No commission information shown at all (commission schedule not passed to this page)

---

## 2. User Journey Map

| Step | User Action | What Appears | New Info Gained | Info Lost vs Previous |
|------|-------------|-------------|-----------------|----------------------|
| 1 | View backtest trades tab | Table with trade rows | Symbol, direction, prices, qty, P&L (net), commission, dates, status | N/A — starting point |
| 2a | Click chevron on PANW row | Expanded sub-row beneath | Entry message, agent reasoning, events timeline, outcome stats, "Full Detail" link | Nothing lost (table row still visible above) |
| 2b | Click PANW row body (instead of chevron) | Right side panel | Entry message (one bubble), P&L (gross), sub-table of all same-symbol trades | Agent reasoning gone, events timeline gone, outcome stats gone, P&L value changes ($11,436 → $11,448) |
| 3 | Click "Full Detail →" from expanded row | Trade detail page | Chat context (surrounding messages), legs table, collapsed signal decision | Table row no longer visible, commission no longer shown, P&L changes to gross |
| 4 | Navigate to /trades page | Trade history table | Same data as step 1, minus commission | Commission lost (schedule not passed), P&L changes to gross |

**Critical friction points**:
- Steps 2a and 2b are mutually exclusive — clicking row body after expanding closes expansion
- Side panel (2b) has strictly LESS information than expanded row (2a)
- P&L number changes silently between views (net → gross) with no label indicating which

---

## 3. Information Loss Analysis

| Data Point | Table Row | Expanded Row | Side Panel | Detail Page | /trades Page |
|------------|-----------|-------------|------------|-------------|-------------|
| **P&L type** | Net ($11,436) | Net ($11,436) | Gross ($11,448) | Gross ($11,448) | Gross ($11,448) |
| **Commission** | Shown (-$12) | Shown in outcome | Not shown | Not shown | Not shown |
| **Entry message** | Not shown | Full text + badge | Full text + badge | Full text + badge | Not shown |
| **Exit/close message** | Not shown | Not shown | Not shown | Not shown | Not shown |
| **Agent reasoning** | Not shown | Full text | Not shown | Collapsed accordion | Not shown |
| **Events timeline** | Not shown | Yes (compact) | Not shown | Yes (full) | Not shown |
| **Close reason** | Not shown | Not shown | Not shown | Not shown | Not shown |
| **Chat context** | Not shown | Not shown | 1 message only | ~10 messages (entry day) | Not shown |
| **Legs detail** | Not shown | Summary line | Not shown | Full table | Not shown |
| **Full Detail link** | Not shown | Yes | Not shown | N/A | Not shown |
| **Qty vs requested** | Shows 12 | Shows 12 | Shows in sub-table | Shows 12 | Shows 12 |
| **Closed date** | Not shown | As hold duration | Not shown | Sep 19, 4:00 PM | Not shown |

**The critical gap**: Exit/close message is missing from ALL views. For this PANW trade specifically, the close was broker-initiated (options expiration via `sweepExpired()`) so `closeMessageId` is null. But even for the 82% of closed trades that DO have a `closeMessageId`, the UI does not display it.

---

## 4. UX Recommendations

### 4.1 Should the sidebar and detail page show the same info?

No — they serve different purposes and that's correct. The sidebar is a quick message preview ("what did the trader say?"). The detail page is a comprehensive audit view. However, the sidebar currently shows strictly LESS than the expanded sub-row, which creates confusion. Recommendations:

- Side panel should include a "Full Detail →" link (matching the expanded row)
- Side panel should show the same chat context scope as the detail page (60-second window) instead of only directly-linked messages
- The sub-table in the side panel should be scoped to the clicked trade (or clearly labeled as "All PANW trades")

### 4.2 Should messages be visible without clicking?

Yes — at least a preview. The trader's message is the most important context for any trade. Requiring a click (expand or side panel) to see it makes the table hard to scan. Recommendation: add an inline "Signal" column with truncated `cleanText` from the source message (see details in Plan #14 — `trades-message-visibility.md`).

### 4.3 Ideal trade viewing experience

1. **Table**: Quick scan — symbol, P&L, status, signal preview (truncated message text)
2. **Expand/click**: Entry signal, exit signal (if any), events timeline, agent reasoning
3. **Detail page**: Full audit — all of the above plus legs, chat context around both entry and exit, trade lifecycle

The exit/close message should be visible at level 2 (expand/click) and level 3 (detail page). The close reason should always be visible on the events timeline.

---

## 5. All Issues Found by Team — Priority Ranking

Combining findings from all team investigators (DB, sidebar, view-comparator, data, web-auditor):

### P0 — Backtest Accuracy Bug (Backend)

| # | Issue | Source | Effort |
|---|-------|--------|--------|
| 1 | **CLOSE signal not executing** — LIMIT order + 60s cancel timeout causes close orders to be cancelled. PANW shows +$11,448 but trader exited at +$4.60/contract. Backtest overstates returns. | `backtest-close-accuracy.md` | 15 min — change to MARKET orders for CLOSE/TRIM/LEG_OFF in `execute.ts` |

### P1 — Data Display Correctness

| # | Issue | Source | Effort |
|---|-------|--------|--------|
| 2 | **P&L inconsistency** — Table row shows net ($11,436), sidebar/detail/history show gross ($11,448). Same trade, different numbers depending on where you look. | `trade-view-consistency.md` | 30 min — create `computeTradePnlDisplay()` utility, apply to all 4 views |
| 3 | **Commission schedule not passed to /trades page** — P&L always shows gross on standalone trades page because commission schedule isn't loaded. | `trade-view-consistency.md` | 15 min — load run config when `runId` is present |
| 4 | **"Executed (0)" count is wrong** — Messages tab filter shows 0 executed messages despite 9 trades existing. | Visual audit | 30 min — investigate and fix the filter query |
| 5 | **Exit/close message not displayed anywhere** — `closeMessageId` exists on 82% of closed trades but no view renders it. | `exit-message-display.md` | 45 min — 3 fixes across side panel, detail page, story expander |

### P2 — Missing Context & Labels

| # | Issue | Source | Effort |
|---|-------|--------|--------|
| 6 | **Close event has no reason label** — Events timeline shows "CLOSE" but not why (expired, message-driven, stop loss). | Visual audit | 15 min — derive reason from `closeMessageId` presence and event metadata |
| 7 | **Chat side panel not enabled on /trades and /traders pages** — Only the backtest trades tab has the click-to-chat feature. | `trades-message-visibility.md` | 5 min — add `enableChatPanel` prop to 2 pages |
| 8 | **Side panel uses different message query than detail page** — Panel shows only directly-linked messages (1-3), detail page shows 60s window (~10). Different stories. | `trade-view-consistency.md` | 15 min — switch side panel to `getNearbyMessages()` |

### P3 — Minor Display Inconsistencies

| # | Issue | Source | Effort |
|---|-------|--------|--------|
| 9 | **Quantity null handling** — Detail page shows raw `null`, table row defaults to 1. | `trade-view-consistency.md` | 1 min — add `?? 1` on detail page |
| 10 | **Realized P&L hidden on closed trades** — Detail page only shows realized P&L for open trades. Closed trades with trims lose this info. | `trade-view-consistency.md` | 2 min — remove status filter |
| 11 | **Event timeline threshold** — Expanded row shows events if >= 1, detail page shows if >= 2. | `trade-view-consistency.md` | 1 min — change `> 1` to `> 0` |
| 12 | **No "Full Detail" link in side panel** — Expanded sub-row has it, side panel doesn't. | Visual audit | 5 min — add link to panel header |
| 13 | **Side panel shows all same-symbol trades** — Clicking one PANW trade shows all 9 PANW trades in sub-table. | Visual audit | 10 min — scope to clicked trade or add label |
| 14 | **No inline message preview in table** — Signal text requires click to see. | `trades-message-visibility.md` | 30 min — LEFT JOIN messages, add column |

---

## 6. Quick Wins vs Larger Refactors

### Quick Wins (< 15 min each, isolated changes)

| Fix | Files | Time | Impact |
|-----|-------|------|--------|
| Enable chat panel on /trades and /traders pages (#7) | `trades/page.tsx`, `traders/[name]/page.tsx` | 5 min | Unlocks message viewing on 2 pages |
| Quantity null fallback (#9) | `trades/[id]/page.tsx` | 1 min | Fixes display bug |
| Realized P&L visibility (#10) | `trades/[id]/page.tsx` | 2 min | Shows trim history on closed trades |
| Event timeline threshold (#11) | `trades/[id]/page.tsx` | 1 min | Consistency with expanded row |
| Add Full Detail link to side panel (#12) | `trades-table-client.tsx` | 5 min | Navigation improvement |
| Add close reason label (#6) | `trade-story-expander.tsx`, `trades/[id]/page.tsx` | 15 min | Context for close events |

**Total quick wins: ~30 min, 6 issues resolved.**

### Medium Changes (15-45 min, cross-cutting)

| Fix | Files | Time | Impact |
|-----|-------|------|--------|
| CLOSE signal MARKET orders (#1) | `execute.ts` | 15 min | Fixes backtest accuracy — **highest ROI fix** |
| P&L consistency utility (#2, #3) | New `trade-display.ts`, 4 component files, 1 page | 30 min | Eliminates confusing P&L differences |
| Exit message display (#5) | `chat-feed.tsx`, `trades-table-client.tsx`, `trades/[id]/page.tsx`, `actions.ts`, `trade-story-expander.tsx` | 45 min | Shows close messages across all views |
| Inline message preview column (#14) | `queries.ts`, `trade-row.tsx`, `trades-table-client.tsx` | 30 min | Scannable signal text in table |

### Larger Refactors (> 45 min, architectural)

| Fix | Files | Time | Impact |
|-----|-------|------|--------|
| Unify message display strategy (#8) | `actions.ts`, `trades-table-client.tsx`, potentially `chat-feed.tsx` | 45-60 min | Consistent chat context across side panel and detail page |
| Side panel scope redesign (#13) | `trades-table-client.tsx` | 30-60 min | Depends on product decision: per-trade vs per-symbol grouping |
| Fix "Executed" message count (#4) | Investigation needed first — filter query may need DB query changes | 30-60 min | Correct message categorization |

---

## Screenshots Reference

All screenshots in `/Users/jason/trade-follower-3/scripts/`:
- `audit-panw-trades-table.png` — Trades tab table
- `audit-panw-expanded.png` — Expanded PANW sub-row with signal, events, outcome
- `audit-panw-expanded-with-panel.png` — Expanded row + side panel simultaneously
- `audit-panw-panel-wide.png` — Side panel after clicking PANW (1600px wide viewport)
- `audit-panw-panel-scrolled.png` — Side panel scrolled to bottom
- `audit-panw-detail-top.png` — Trade detail page (viewport)
- `audit-panw-detail-full.png` — Trade detail page (full page)
- `audit-panw-detail-bottom.png` — Trade detail page (bottom)
- `audit-panw-messages-tab-full.png` — Messages tab overview
- `audit-panw-messages-intent.png` — Messages tab with "With Intent" filter
- `audit-panw-messages-executed-detail.png` — Messages tab with "Executed" filter
- `audit-panw-trades-page.png` — /trades page filtered by run

## Related Plan Documents

- `docs/plans/backtest-close-accuracy.md` — Root cause analysis of CLOSE signal not executing
- `docs/plans/exit-message-display.md` — How to show exit messages across all 3 views
- `docs/plans/trade-view-consistency.md` — P&L and display consistency fixes
- `docs/plans/trades-message-visibility.md` — Inline message preview and chat panel enablement
