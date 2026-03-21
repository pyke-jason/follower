# Reaction Emoji Ingestion Gap

## Problem

Reaction emojis were never appearing on live-ingested messages. 55% of historically-fetched messages had reactions, but 0% of live-first messages did. Additionally, the main chat feed UI never displayed reactions even when they were in the DB.

## Root Cause

Three compounding issues:

1. **`$.hubConnection()` creates a NEW connection**. jQuery SignalR 2.x's `$.hubConnection()` is a factory — each call creates an independent connection with its own ConnectionId. Our 2nd connection receives `addMessage` (broadcast to `Clients.All`) but NOT `updateMessageReactions` (broadcast to a room group the 2nd connection never joined).

2. **`onConflictDoNothing()` blocks backfill**. `ingest.ts` inserts with `onConflictDoNothing()`. When the historical fetch later retrieves a message that was already live-ingested, its populated reactions are silently dropped. (Fixed in prior pass: `historical.ts` already uses `onConflictDoUpdate`.)

3. **Chat feed UI ignores reactions**. `ChatBubble` component never rendered the `reactions` field, even though the data was in the API response and displayed in other views (decision timeline, trade detail panel).

## OneOption Reaction Protocol (discovered via Playwright sniffing)

Source: `https://app.oneoption.com/Content/chat/js/chat-room.js`

**Server -> Client** (push, real-time):
```
event: updateMessageReactions
args:  (id: number, reactions: { Type: string, Count: number, ByRoles?: Record<string, number> }[])
```

**Transport**: jQuery SignalR 2.x over Server-Sent Events (not WebSocket).

**6 reaction types**: `votes`, `loves`, `appreciations`, `cheers`, `salutes`, `laughs`

**`ByRoles` map** (role ID -> count): `1` = proven, `2`/`8` = professional, `3` = moderator.

## Fix

1. **`signalr.ts`**: Hook `updateMessageReactions` on the app's EXISTING proxy (`$.connection.chatHub`) instead of our 2nd connection's proxy. The existing proxy is joined to the room group and receives group-targeted events. Keep 2nd connection for `addMessage` (broadcast, works fine).

2. **`historical.ts`**: Already fixed — uses `onConflictDoUpdate` for reactions column.

3. **`chat-bubble.tsx`**: Added reaction badge rendering (same style as decision-timeline.tsx).

## Watch Out

- `$.hubConnection()` is NOT a singleton. Every call = new connection = new server-side ConnectionId.
- `addMessage` works on 2nd connection because it's `Clients.All`. Don't assume other events are too.
- The existing proxy is at `$.connection.chatHub` (auto-generated proxy pattern). If OneOption changes their proxy naming, this breaks.

## Key Files

- `src/ingestion/signalr.ts` — SignalR connection + event handlers
- `src/ingestion/ingest.ts` — live message processing
- `src/ingestion/historical.ts` — historical fetch
- `web/app/messages/chat-bubble.tsx` — chat feed message rendering
