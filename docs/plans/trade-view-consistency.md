# Trade View Consistency & P&L Consolidation

## The Simple Version

Four different views render the same trade with different data, different P&L numbers, and different levels of detail. The table row shows net P&L (with commission deducted), but clicking through to the sidebar or detail page shows gross P&L. Quantity defaults to 1 in one view and shows raw null in another. Realized P&L appears in the table for closed trades but vanishes on the detail page. Events show up under one threshold in the expanded row but a different threshold on the detail page.

This plan makes every trade view consistent.

---

## What's Actually Wrong

### 1. P&L: Net vs Gross (CRITICAL)

The table row deducts commissions. The sidebar and detail page don't.

```
Table Row (trade-row.tsx:27-29):
  const grossPnl = safeParseFloat(trade.pnl);
  const comm = computeTradeCommission(trade, commissionSchedule);
  const pnl = grossPnl - comm;                    // NET
  → renders pnl with commission annotation "(-$X.XX)"

Sidebar Header (trades-table-client.tsx:132-134):
  formatCurrency(selectedTrade.pnl)                // GROSS — no commission deduction

Detail Page (trades/[id]/page.tsx:100-104):
  formatCurrency(trade.pnl)                        // GROSS — no commission deduction

Expanded Row / OutcomeLegsSummary (outcome-legs-summary.tsx:39-41):
  const netPnl = grossPnl - commission;            // NET — matches table row
```

A trade with $500 gross P&L and $12 commission shows $488 in the table row but $500 in the sidebar and detail page. Users see two different numbers for the same trade depending on where they click.

### 2. Commission Schedule Not Passed on /trades Page

The backtest trades tab passes `commissionSchedule`:
```
backtests/[id]/page.tsx:221:
  <TradesTableClient trades={allTrades} commissionSchedule={config.commissionSchedule} enableChatPanel />
```

The standalone trade history page does not:
```
trades/page.tsx:125:
  <TradesTableClient trades={trades} runId={runId} />
  // No commissionSchedule — commission always 0
```

Same trade, two different P&L numbers depending on which page you're on.

### 3. Quantity Null Handling

```
Table Row (trade-row.tsx:89):
  {trade.quantity ?? 1}                // defaults null to 1

OutcomeLegsSummary (outcome-legs-summary.tsx:64):
  Qty {trade.quantity ?? 1}            // defaults null to 1

Detail Page (trades/[id]/page.tsx:106-107):
  {trade.quantity}                     // shows raw null
```

### 4. Realized P&L Visibility

```
Table Row (trade-row.tsx:104-107):
  // Always renders the column (hidden on <lg). Shows "--" if null/zero.
  {realizedPnl != null && realizedPnl !== 0 ? formatCurrency(realizedPnl) : '--'}

Detail Page (trades/[id]/page.tsx:108-114):
  // Only renders if OPEN AND has realized P&L
  {trade.realizedPnl && trade.status === 'OPEN' && (
    <StatItem label="Realized P&L (trims)"> ... </StatItem>
  )}
```

A closed trade that had trims (e.g., sold half for profit, then closed the rest) shows the realized P&L in the table but hides it on the detail page. The trim history is only visible in the event timeline.

### 5. Event Timeline Threshold

```
Expanded Row (trade-story-expander.tsx:62-63):
  {story.events.length > 0 && <CompactEventChain events={story.events} />}  // shows if >= 1 event

Detail Page (trades/[id]/page.tsx:140):
  {tradeEvents.length > 1 && <EventTimeline events={tradeEvents} />}        // shows if >= 2 events
```

An open trade with only an OPEN event (1 event) shows the timeline in the expanded row but not on the detail page.

### 6. Message Context: Two Different Query Strategies

```
Expanded Row / Detail Page:
  getNearbyMessages(author, timestamp, 60)
  // 60-minute time window around source message. Shows full chat context.

Sidebar Panel:
  fetchTradeLinkedMessages(tradeId)
  // Only messages directly referenced by trade_events (sourceMessageId, closeMessageId, event.messageId)
  // No surrounding context. Typically 1-3 messages.
```

The expanded row shows 10+ messages of context. The sidebar shows 1-3 directly-linked messages. Different views of the same trade tell different stories.

### 7. Sidebar Missing Fields

The sidebar header (trades-table-client.tsx:125-141) shows only: symbol, direction, strategy, status/P&L.

Not shown: entry price, exit price, quantity, trader, commission, legs, opened/closed dates. All of these are visible in the table row immediately to the left.

### 8. Missing Closed Date in Table

The table shows "Opened" but not "Closed". The detail page shows both. The expanded row shows neither directly — only trade duration.

---

## The Four Views Today

| View | Component | Data Source | P&L Type |
|------|-----------|-------------|----------|
| **Table Row** | `trade-row.tsx` | Trade prop (in-memory) | Net |
| **Expanded Row** | `trade-story-expander.tsx` → `outcome-legs-summary.tsx` | `fetchTradeStory()` server action | Net |
| **Sidebar Panel** | `trades-table-client.tsx:123-164` | Trade prop + `fetchTradeLinkedMessages()` | Gross |
| **Detail Page** | `trades/[id]/page.tsx` | `getTradeById()` + related queries | Gross |

---

## Plan

### Phase 1: Fix P&L Consistency (Critical)

**Goal**: Every surface that shows P&L uses the same formula.

**Decision**: Display **gross P&L** as the primary number everywhere, with commission shown as a separate annotation when available. Rationale:
- The `trades.pnl` column stores gross P&L. This is the source of truth.
- Commission depends on the run's commission schedule, which isn't always available (e.g., `/trades` page, live trades).
- Showing gross + annotation is more transparent than a "magic" net number.

If we later decide net should be the primary display, the fix is the same — just apply the same formula everywhere.

**Changes**:

1. **Create `formatTradePnl()` utility** — a single function all views call.

```ts
// web/lib/trade-display.ts (new file)

import { safeParseFloat } from '../../src/lib/numbers';
import { computeTradeCommission } from '../../src/lib/commission';
import type { Trade, CommissionSchedule } from '../../src/db/schema';

export type TradePnlDisplay = {
  gross: number | null;
  commission: number;
  net: number | null;
};

export function computeTradePnlDisplay(
  trade: Pick<Trade, 'pnl' | 'legs' | 'quantity' | 'strategy'>,
  commissionSchedule?: CommissionSchedule,
): TradePnlDisplay {
  const gross = trade.pnl != null ? safeParseFloat(trade.pnl) : null;
  const commission = commissionSchedule
    ? computeTradeCommission(trade, commissionSchedule)
    : 0;
  const net = gross != null ? gross - commission : null;
  return { gross, commission, net };
}
```

2. **Update `trade-row.tsx`** — use `computeTradePnlDisplay()` instead of inline math.

3. **Update `outcome-legs-summary.tsx`** — use `computeTradePnlDisplay()`.

4. **Update sidebar header in `trades-table-client.tsx:132-134`** — pass `commissionSchedule` into the sidebar rendering, use `computeTradePnlDisplay()`.

5. **Update detail page `trades/[id]/page.tsx:100-104`** — accept commission schedule (via search param `?run=X` → load run config → extract schedule), use `computeTradePnlDisplay()`.

6. **Update `/trades` page** — when `runId` is present in search params, load the run config to get `commissionSchedule` and pass it to `TradesTableClient`.

### Phase 2: Fix Minor Display Inconsistencies

**2a. Quantity null handling**

Add `?? 1` fallback to detail page (`trades/[id]/page.tsx:107`):
```tsx
// Before:
<p>{trade.quantity}</p>
// After:
<p>{trade.quantity ?? 1}</p>
```

One line change.

**2b. Realized P&L visibility**

Change detail page condition to show realized P&L for all trades that have it, not just open ones:
```tsx
// Before (trades/[id]/page.tsx:108):
{trade.realizedPnl && trade.status === 'OPEN' && (

// After:
{trade.realizedPnl != null && safeParseFloat(trade.realizedPnl) !== 0 && (
```

Also update the label: "Realized P&L (trims)" is only accurate for open trades. For closed trades, say "Realized from Trims" to distinguish from final P&L.

**2c. Event timeline threshold**

Change detail page to match expanded row — show events if >= 1:
```tsx
// Before (trades/[id]/page.tsx:140):
{tradeEvents.length > 1 && (

// After:
{tradeEvents.length > 0 && (
```

The `> 1` threshold was likely meant to avoid showing a single OPEN event (not very informative), but the expanded row already shows it and users expect consistency.

**2d. Closed date in table**

Not changing. The table is intentionally compact. "Opened" is the more useful date for sorting. "Closed" is available in the expanded row (as duration) and on the detail page. Adding another column would make the table wider with low information gain.

### Phase 3: Unify Message Display Strategy

**Goal**: The sidebar and expanded row should show the same messages.

**Decision**: Switch the sidebar to use the same `getNearbyMessages()` approach as the expanded row and detail page. Rationale:
- `fetchTradeLinkedMessages()` only gets directly-linked messages, which misses context.
- The 60-minute window from `getNearbyMessages()` provides the conversation context that makes messages useful.
- The sidebar's purpose is to show "what the trader said" — a single isolated message without context is less useful than seeing the surrounding conversation.

**Changes**:

1. **Update `fetchTradeLinkedMessages()`** (or create a new action) to call `getNearbyMessages()` with the source message author/timestamp, matching what `fetchTradeStory()` and the detail page do.

2. Alternatively, the sidebar could call `fetchTradeStory()` directly and use its `nearbyMessages` field, avoiding a new code path. The trade-off is fetching extra data (events, decision) that the sidebar doesn't display. Given these are small queries on an indexed SQLite DB, this is acceptable.

**Not changing**: The sidebar intentionally shows fewer trade fields than the expanded row. The sidebar is for message context; the expanded row is for trade details. These are different purposes and the field differences are by design.

---

## File Inventory

| File | What Changes | Why |
|------|-------------|-----|
| `web/lib/trade-display.ts` | **New file** | Single P&L display utility |
| `web/app/components/trade-row.tsx` | Use `computeTradePnlDisplay()` | Dedup P&L logic |
| `web/app/components/outcome-legs-summary.tsx` | Use `computeTradePnlDisplay()` | Dedup P&L logic |
| `web/app/components/trades-table-client.tsx` | Pass commission schedule to sidebar, use display utility | Fix gross → net in sidebar |
| `web/app/trades/[id]/page.tsx` | Use display utility, fix qty fallback, fix realized P&L condition, fix event threshold | 4 inconsistencies |
| `web/app/trades/page.tsx` | Load commission schedule when runId present | Fix missing commission |
| `web/app/trades/actions.ts` | Update `fetchTradeLinkedMessages()` to use nearby messages | Consistent message context |
| `web/lib/queries.ts` | Possibly add query to load commission schedule by runId | Support /trades page |

---

## What NOT to Change

- **Table column set**: The table intentionally shows a compact subset. Don't add closedAt or duration columns.
- **Sidebar field set**: The sidebar is a message viewer, not a trade detail clone. Don't add entry/exit/qty.
- **Detail page extra sections**: FillQuality, ParsedContext, and AuditTrail are detail-page-only by design.
- **Expanded row three-zone layout**: Signal / Events / Outcome is a good information hierarchy. Don't flatten it.

---

## Verification

After implementation, verify with a trade that has:
- Non-zero commission (options trade in a backtest with commission schedule)
- Realized P&L from trims
- Multiple events (OPEN, TRIM, CLOSE)
- Source message linked

Check all four views show the same P&L number and the same message context approach.
