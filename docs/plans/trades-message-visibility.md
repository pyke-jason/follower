# Message Visibility in Trades Table

## Problem

The trades table renders zero message content. Every trade has a `sourceMessageId` FK (100% of 4,358 trades), and the `messages` table has the original trader text (`cleanText`, avg 54 chars), but no list-level query JOINs messages. Users must click into a detail page or expand a row to see what message triggered a trade.

The side-panel chat viewer (`enableChatPanel`) already works but is only wired up on the backtest trades tab. The standalone `/trades` page, `/traders/[name]` page, and `/trades/open` page pass no message data at all.

## Current State

### Data Fetching — No Message JOINs

All three trade list queries select only from `trades`:

```ts
// web/lib/queries.ts:72-78
return db
  .select()
  .from(schema.trades)
  .where(and(...conditions))
  .orderBy(desc(schema.trades.closedAt))
  .limit(opts.limit ?? 50);
```

The same pattern applies to:
- `getClosedTrades()` — `web/lib/queries.ts:59-79`
- `getTradesByBacktestRun()` — `web/lib/queries.ts:433-443`
- `getOpenTrades()` — `web/lib/queries.ts:50-57`

None of these LEFT JOIN `messages` on `sourceMessageId`. The `Trade` type includes `sourceMessageId: string | null` but never the message text itself.

### Component Props — No Message Field

`TradeRow` (`web/app/components/trade-row.tsx:12-26`) accepts `trade: Trade` and renders 13 columns: chevron, symbol, legs, trader, direction, strategy, qty, entry, exit, P&L, realized P&L, opened date, status. No column for message content.

`TradesTableClient` (`web/app/components/trades-table-client.tsx:22-31`) accepts `trades: Trade[]` and an optional `enableChatPanel` boolean. When enabled, clicking a row triggers `fetchTradeLinkedMessages()` and renders a 420px side panel with a `ChatFeed`. When disabled, rows are non-interactive (link to detail page).

### Where enableChatPanel Is Passed

| Caller | File:Line | enableChatPanel | Result |
|---|---|---|---|
| Backtest detail | `web/app/backtests/[id]/page.tsx:221` | `true` | Side panel works |
| `/trades` | `web/app/trades/page.tsx:125` | not passed | No message UI |
| `/traders/[name]` | `web/app/traders/[name]/page.tsx:122` | not passed | No message UI |

### Existing On-Demand Message Access

Two mechanisms exist but require explicit user interaction:

1. **Row expander** (chevron click) — `TradeStoryExpander` calls `fetchTradeStory()` which fetches `sourceMessage` and renders it via `SignalDecisionSummary` (`cleanText` with 3-line clamp). Available on all pages.

2. **Chat side panel** (row click) — `fetchTradeLinkedMessages()` collects message IDs from `trades.sourceMessageId`, `trades.closeMessageId`, and all `trade_events.messageId`, then loads full messages + intents + labels. Renders in `ChatFeed`. Backtest trades tab only.

### Database Numbers

- 4,358 total trades (all backtest, 0 live currently)
- 3,455 closed, 903 open
- 122 distinct backtest runs
- Largest single run: 321 trades
- 100% of trades have `sourceMessageId` set (0 nulls)
- 82% of closed trades have `closeMessageId` set (2,827 of 3,455); 628 closed trades have no close message (auto-closed by sweepExpired or similar)
- `sourceMessageId` and `closeMessageId` are always distinct (0 overlap)
- Average source message length: 54 characters
- Average close message length: 64 characters
- 23,573 total messages

## Options

### Option A: Inline Message Preview Column

Add a "Signal" column to the trades table showing a truncated `cleanText` from the source message.

**Data layer change** — Modify the three list queries to LEFT JOIN messages:

```ts
// web/lib/queries.ts — getClosedTrades()
return db
  .select({
    trade: schema.trades,
    messagePreview: schema.messages.cleanText,
  })
  .from(schema.trades)
  .leftJoin(schema.messages, eq(schema.messages.id, schema.trades.sourceMessageId))
  .where(and(...conditions))
  .orderBy(desc(schema.trades.closedAt))
  .limit(opts.limit ?? 50);
```

Same change for `getTradesByBacktestRun()` and `getOpenTrades()`.

**Return type change** — These queries currently return `Trade[]`. With the JOIN they return `{ trade: Trade; messagePreview: string | null }[]`. All callers (`TradesTableClient`, page components) need to adapt to the new shape.

**Component change** — Add a column to `TradeRow`:

```tsx
{/* Signal Preview — after Status column */}
<TableCell className="max-w-[200px] text-xs text-muted-foreground truncate">
  {messagePreview ?? '--'}
</TableCell>
```

Update `TOTAL_COLUMNS` from 13 to 14 in `trades-table-client.tsx:20`.

**Performance** — The LEFT JOIN uses the messages primary key index (`sqlite_autoindex_messages_1`). Query plan confirmed via EXPLAIN: `SEARCH m USING INDEX sqlite_autoindex_messages_1 (id=?) LEFT-JOIN`. With 50-row page size, this adds 50 PK lookups per page load — negligible overhead. Tested at <6ms on current dataset.

**Pros**: Immediate scannability. No extra clicks. Low implementation cost.
**Cons**: Column width pressure on already-wide table. Truncation may lose context. Changes return type of three query functions (ripple to all callers).

### Option B: Enable Chat Side Panel Everywhere

Pass `enableChatPanel` to all `TradesTableClient` instances.

**Changes needed**:
1. `web/app/trades/page.tsx:125` — add `enableChatPanel` prop
2. `web/app/traders/[name]/page.tsx:122` — add `enableChatPanel` prop

No data layer changes. The existing `fetchTradeLinkedMessages()` server action handles the on-demand fetch when a row is clicked.

**Performance** — No impact on initial page load. Each row click triggers 3 parallel queries (trade + events fetch, then messages + intents + labels). Currently ~15ms per click on backtest data.

**Pros**: Zero query changes. Full message context (not truncated). Reuses existing tested infrastructure.
**Cons**: Requires a click to see any message. Not scannable. Side panel takes 420px — may not work well on narrow screens or pages with different layouts.

### Option C: Both (Recommended)

Inline preview for scannability + side panel for full context. This mirrors how the backtest trades tab already works (rows are clickable for side panel) but adds the inline preview column for quick scanning without clicks.

**Implementation order**:
1. First: Enable `enableChatPanel` on `/trades` and `/traders/[name]` (5 min, zero risk)
2. Then: Add LEFT JOIN + inline preview column (30 min, changes query return types)

## Recommended Approach: Option C

### Step 1 — Enable Chat Panel Everywhere

Files to change:
- `web/app/trades/page.tsx:125` — add `enableChatPanel`
- `web/app/traders/[name]/page.tsx:122` — add `enableChatPanel`

This is a two-line change with zero risk.

### Step 2 — Add Inline Message Preview

**Query layer** (`web/lib/queries.ts`):

Create a new type and modify the three queries:

```ts
export type TradeWithPreview = Trade & { messagePreview: string | null };
```

For `getClosedTrades()`, `getTradesByBacktestRun()`, and `getOpenTrades()`:
- Add `.leftJoin(schema.messages, eq(schema.messages.id, schema.trades.sourceMessageId))`
- Select `schema.messages.cleanText` as `messagePreview`
- Flatten result to `TradeWithPreview` (spread trade fields + messagePreview)

**Component layer**:

`TradeRow` (`web/app/components/trade-row.tsx`):
- Accept `messagePreview?: string | null` prop
- Add a "Signal" column (truncated to ~50 chars, `text-muted-foreground text-xs`)

`TradesTableClient` (`web/app/components/trades-table-client.tsx`):
- Update `TOTAL_COLUMNS` from 13 to 14
- Pass `messagePreview` through to `TradeRow`
- Add "Signal" table header

**Page layer** — All three pages that call `TradesTableClient`:
- `web/app/trades/page.tsx`
- `web/app/backtests/[id]/page.tsx`
- `web/app/traders/[name]/page.tsx`

These pass `trades` directly — if the query return type changes, they just forward the new shape.

### Step 3 — Column Visibility (Optional)

The trades table is already 13 columns wide. Adding a 14th may be too much on smaller screens. Consider:
- Use `hidden xl:table-cell` to hide the Signal column below 1280px
- Or replace the "Opened" column (less useful when scannable) with "Signal"
- Or make it a tooltip on the symbol cell instead of a separate column

## Performance Considerations

| Metric | Current | After LEFT JOIN |
|---|---|---|
| Query time (50 rows) | ~3ms | ~4ms (+50 PK lookups, indexed) |
| Payload size (50 rows) | ~25 KB | ~28 KB (+50 strings, avg 54 chars) |
| Largest single run | 321 trades | 321 + 321 message lookups = negligible |
| Index used | idx_trades_status | + sqlite_autoindex_messages_1 |

The LEFT JOIN is safe for all realistic page sizes. Even without LIMIT (loading all 321 trades of the largest run on the backtest trades tab), the cost is 321 indexed PK lookups — sub-10ms.

The `fetchTradeLinkedMessages()` side panel query is already on-demand (per-click) and fetches trade_events + messages in parallel. No change needed.

## Close Message Visibility

### Current State

`closeMessageId` is set on 82% of closed trades (2,827 / 3,455). The remaining 18% (628 trades) were closed by automated mechanisms — primarily `sweepExpired()` in the backtest sim-broker, which closes expired options at day boundaries before any CLOSE message arrives. These trades legitimately have no close message.

The close message text is **never displayed** in any view:
- **Trade detail page** (`web/app/trades/[id]/page.tsx`) — shows `sourceMessage` in the sidebar ChatPreview but does not fetch or render the close message
- **Trade row expander** — `fetchTradeStory()` fetches `sourceMessage` but not the close message
- **Chat side panel** — `fetchTradeLinkedMessages()` DOES collect `closeMessageId` and includes it in the ChatFeed, so the close message appears in the chat timeline if present. This is the only place it shows up.

### Recommendation: Do NOT Add Inline Close Message Column

Adding a second message column ("Close Signal") to the trades table would:
- Double the column width pressure (already 13+ columns)
- Be null for 18% of closed trades and 100% of open trades
- Provide low incremental value — the close message is usually a brief "out of X" or "closed X" phrase

Instead, the close message is best accessed through:
1. **Chat side panel** (already works on backtest trades tab) — shows full conversation timeline including close message
2. **Trade detail page** — could be enhanced to show close message in the sidebar alongside source message (separate plan scope)

If close message visibility is desired at the list level, a lightweight approach:
- Add a small icon/indicator on `TradeRow` when `closeMessageId` is non-null (e.g., a subtle "exit signal linked" dot)
- Tooltip on hover showing the close message text (no extra column, no layout shift)
- This requires the same LEFT JOIN approach but on `closeMessageId` as a second join

### Data Layer (If Close Message Tooltip Is Desired)

```ts
// web/lib/queries.ts — extended LEFT JOIN
return db
  .select({
    trade: schema.trades,
    messagePreview: schema.messages.cleanText,       // source message alias
    closePreview: closeMessages.cleanText,            // close message alias
  })
  .from(schema.trades)
  .leftJoin(schema.messages, eq(schema.messages.id, schema.trades.sourceMessageId))
  .leftJoin(closeMessages, eq(closeMessages.id, schema.trades.closeMessageId))
  .where(and(...conditions))
  .orderBy(desc(schema.trades.closedAt))
  .limit(opts.limit ?? 50);
```

This requires aliasing the messages table for the second join:
```ts
import { alias } from 'drizzle-orm/sqlite-core';
const closeMessages = alias(schema.messages, 'close_messages');
```

Performance: adds a second PK lookup per row — still negligible (100 PK lookups per 50-row page).

## Files Involved

| File | Change |
|---|---|
| `web/lib/queries.ts:50-79,433-443` | LEFT JOIN messages in 3 queries |
| `web/app/components/trade-row.tsx` | Add messagePreview prop + column |
| `web/app/components/trades-table-client.tsx` | Update TOTAL_COLUMNS, add header, pass prop |
| `web/app/trades/page.tsx:125` | Add `enableChatPanel` |
| `web/app/traders/[name]/page.tsx:122` | Add `enableChatPanel` |
| `web/app/backtests/[id]/page.tsx:221` | No change (already has enableChatPanel) |

## Watch Out

- Changing `getClosedTrades()` return type from `Trade[]` to `TradeWithPreview[]` affects these callers:
  - `web/app/trades/page.tsx:27` — standalone trades page
  - `web/app/traders/[name]/page.tsx:34` — trader detail page
- Changing `getTradesByBacktestRun()` return type affects:
  - `web/app/backtests/[id]/page.tsx:61` — backtest detail page
  - `web/app/backtests/actions.ts:161` — backtest server action (used for comparison/export)
- Changing `getOpenTrades()` return type affects:
  - `web/app/trades/open/page.tsx:31` — open trades page (card layout, not TradesTableClient)
  - `web/app/page.tsx:58` — dashboard (shows 6 recent open trades)
- `getTradesByBacktestRun()` is used on the backtest detail page — verify the trades tab still works after type change.
- The `TradeStoryExpander` uses `TOTAL_COLUMNS` for its `colSpan` — must update when adding the 14th column.
- `TradeRow` is also used in some contexts without a runId (trader page) — ensure `messagePreview` prop is optional.
