# Exit Message Display — Plan

## Problem

When viewing a closed trade, the UI only shows the **open/entry message** (the chat message that triggered the trade). The **close/exit message** (the chat message that triggered the close) is never shown — or if fetched, never visually distinguished. This makes it impossible to see *why* a trade was closed from any UI view.

The `trades` table has a `closeMessageId` column (schema.ts:111) that references the message that caused the close. The data exists; the UI just ignores it.

## Current State

Three views show trade-linked messages. All three have gaps:

### View 1: Backtest Trades Tab — Side Panel

**Files**: `web/app/components/trades-table-client.tsx`, `web/app/trades/actions.ts`

How it works today:
1. Click a trade row → calls `fetchTradeLinkedMessages(tradeId)` (actions.ts:126)
2. `fetchTradeLinkedMessages` collects IDs from `sourceMessageId`, `closeMessageId`, and all `tradeEvent.messageId` values (actions.ts:134-141)
3. Fetches messages, intents, labels for all collected IDs (actions.ts:145-149)
4. Renders `ChatFeed` with the results (trades-table-client.tsx:150-156)

**Gap**: The ChatFeed receives `focusMessageId` and `highlightMessageId` both set to `sourceMessageId` only (trades-table-client.tsx:154-155). The close message is in the feed data but gets no visual emphasis — it blends in with surrounding messages. Users cannot tell which message triggered the close.

### View 2: Trade Detail Page (`/trades/[id]`)

**Files**: `web/app/trades/[id]/page.tsx`, `web/app/messages/chat-preview.tsx`

How it works today:
1. Fetches `sourceMessage` via `getMessageById(trade.sourceMessageId)` (page.tsx:34)
2. Fetches `nearbyMessages` in a 60-second window around `sourceMessage` (page.tsx:40-41)
3. Renders `ChatPreview` with `focusMessageId={trade.sourceMessageId}` (page.tsx:160-165)

**Gap**: `closeMessageId` is never read. Not fetched, not passed to any component. The right sidebar only shows a 60-second window around the open message. If the close message is hours or days later, it is completely absent.

### View 3: Trade Story Expander (chevron in table row)

**Files**: `web/app/components/trade-story-expander.tsx`, `web/app/trades/actions.ts`

How it works today:
1. Calls `fetchTradeStory(tradeId)` (actions.ts:81)
2. `fetchTradeStory` fetches `sourceMessage` via `trade.sourceMessageId` (actions.ts:88)
3. Returns `sourceMessage` and `nearbyMessages` centered on it (actions.ts:92-93)
4. `SignalDecisionSummary` renders the source message text in a "Signal" zone (signal-decision-summary.tsx:26-32)

**Gap**: `closeMessageId` is never referenced in `fetchTradeStory`. The `TradeStory` type has no `closeMessage` field. The story expander only shows the open signal.

### Summary Table

| View | Fetches closeMessageId? | Displays close message? | Highlights it? |
|------|------------------------|------------------------|----------------|
| Side Panel | YES (via event IDs) | In feed, unmarked | NO |
| Detail Page | NO | NO | N/A |
| Story Expander | NO | NO | N/A |

## Proposed Fix

### Fix 1: Side Panel — Highlight the Close Message

**File**: `web/app/components/trades-table-client.tsx`

The data is already there. Add a second highlight color for the close message.

**Option A — Use `highlightMessageIds` (plural) with a color map**:
- Change `ChatFeed` to accept `highlightMessageIds?: Record<string, 'open' | 'close'>` instead of a single `highlightMessageId`
- Map 'open' → `bg-info/5 ring-info/20` (existing blue), 'close' → `bg-amber/5 ring-amber/20` (amber)
- Tradeoff: Touches the shared ChatFeed component. Must verify no regressions in ChatRoom and ChatPreview.

**Option B — Use existing `highlightMessageId` for open + new `secondaryHighlightId` for close** (simpler):
- Add `secondaryHighlightMessageId?: string` prop to ChatFeed (chat-feed.tsx:44)
- In `renderItemContent` (chat-feed.tsx:110), check for secondary highlight and apply amber ring
- Pass `secondaryHighlightMessageId={selectedTrade.closeMessageId ?? undefined}` in trades-table-client.tsx

**Recommended**: Option B. Minimal surface area, no breaking changes. One new optional prop.

Changes:
```
web/app/messages/chat-feed.tsx
  - Add prop: secondaryHighlightMessageId?: string
  - In renderItemContent (~line 110): add isSecondaryHighlighted check
  - Apply: 'bg-amber-500/5 ring-1 ring-inset ring-amber-500/20' for close message

web/app/components/trades-table-client.tsx
  - Line 155: add secondaryHighlightMessageId={selectedTrade.closeMessageId ?? undefined}
```

### Fix 2: Trade Detail Page — Show Close Message Context

**File**: `web/app/trades/[id]/page.tsx`

Fetch the close message and its nearby context, then display a second ChatPreview card.

Changes:
```
web/app/trades/[id]/page.tsx
  - Line 34: Add closeMessage fetch:
      trade.closeMessageId ? getMessageById(trade.closeMessageId) : Promise.resolve(null),
  - Lines 39-41: Add nearbyCloseMessages fetch (parallel with existing):
      closeMessage ? getNearbyMessages(closeMessage.author, closeMessage.timestamp, 60) : Promise.resolve([]),
  - After the existing ChatPreview (~line 165): Add a second ChatPreview:
      {trade.status === 'CLOSED' && (
        <ChatPreview
          messages={nearbyCloseMessages.length > 0 ? nearbyCloseMessages : closeMessage ? [closeMessage] : []}
          focusMessageId={trade.closeMessageId ?? undefined}
          author={closeMessage?.author ?? trade.trader}
          title="Close Signal"
          viewAllHref={`/messages?authors=${encodeURIComponent(closeMessage?.author ?? trade.trader)}`}
        />
      )}
```

If `closeMessageId` is null (no close message linked), the second card simply does not render. No special null-state UI needed — an absent card already communicates "no linked close message."

### Fix 3: Story Expander — Add Close Signal Zone

**Files**: `web/app/trades/actions.ts`, `web/app/components/trade-story-expander.tsx`, `web/app/components/signal-decision-summary.tsx`

Add `closeMessage` to the `TradeStory` type and fetch it alongside `sourceMessage`.

Changes:
```
web/app/trades/actions.ts
  - TradeStory type (line 64): Add closeMessage: Message | null
  - fetchTradeStory (line 85): Add to Promise.all:
      trade.closeMessageId ? getMessageById(trade.closeMessageId) : Promise.resolve(null),
  - Return object (line 120): Add closeMessage

web/app/components/trade-story-expander.tsx
  - After Zone A "Signal" (~line 56): Add Zone A2 "Close Signal" (only for closed trades):
      {story.closeMessage && (
        <div>
          <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Close Signal</h4>
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-medium">{story.closeMessage.author}</span>
              <span className="text-[10px] text-muted-foreground/60">{formatDate(story.closeMessage.timestamp)}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-3">{story.closeMessage.cleanText}</p>
          </div>
        </div>
      )}
```

The 3-column grid (Signal | Events | Outcome) stays as-is. The close signal slots into Zone A below the open signal, since they are conceptually related. If `closeMessage` is null, the zone is absent — no empty state needed.

## Handling Null closeMessageId

Several trade close scenarios produce null `closeMessageId`:

1. **sweepExpired()** — Options expire at day boundary. SimBroker closes positions automatically with no associated message. closeMessageId = null.
2. **forceCloseAll()** — Broker-initiated close (not currently used in runner). closeMessageId = null.
3. **Risk-limit triggered close** — Future possibility. closeMessageId = null.

For all these cases, the UI should gracefully degrade:
- **Side panel**: No secondary highlight shown. Feed still shows whatever messages were linked via trade_events.
- **Detail page**: Second ChatPreview card simply does not render.
- **Story expander**: "Close Signal" zone does not render.

No "auto-closed" badge or placeholder is proposed. The Event Timeline (already present in story expander Zone B and detail page) already shows the CLOSE event with its timestamp and action, which is sufficient to understand what happened.

## Design Considerations

**Why not a single combined ChatPreview showing both open and close?**
The open and close messages can be hours, days, or weeks apart. A single chat window spanning that range would be unusable — mostly empty space. Two separate focused windows (each 60s around its message) is more practical.

**Why amber for the close highlight?**
The open message highlight uses blue (`ring-info/20`). Using a distinct color for close prevents confusion about which message is which. Amber is already in the Tailwind palette and semantically neutral (not success/error).

**Why not always show a "No close message" placeholder?**
For open trades, there is no close message by definition. For auto-closed trades, showing "Auto-closed (no message)" adds UI complexity for marginal value — the event timeline already communicates this. The absence of the close signal section is itself the signal.

## Files to Modify

| File | Change |
|------|--------|
| `web/app/messages/chat-feed.tsx` | Add `secondaryHighlightMessageId` prop + amber highlight style |
| `web/app/components/trades-table-client.tsx` | Pass `closeMessageId` as secondary highlight |
| `web/app/trades/[id]/page.tsx` | Fetch close message + render second ChatPreview |
| `web/app/trades/actions.ts` | Add `closeMessage` to TradeStory type + fetch |
| `web/app/components/trade-story-expander.tsx` | Render "Close Signal" zone |

No schema changes. No new components. No new server actions.
