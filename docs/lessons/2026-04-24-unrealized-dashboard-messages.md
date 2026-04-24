# Unrealized Dashboard Messages

## Problem

The runtime dashboard mixed account equity, live unrealized P&L, and realized-today P&L in ways that looked like a daily return. Message rows also hid classifier and execution decisions behind color accents and a modal.

## Decision

Make live unrealized P&L the primary runtime metric everywhere the trader is scanning open risk. Keep net liquidation, buying power, margin, drawdown, and capacity together in one risk panel. Show message intent and final execution state inline, including route and signal summary, so the branch taken for a message is visible without opening a popup.

## Key Files

- `src/broker/ibkr/client.ts`
- `src/local-api/routes/web-queries.ts`
- `src/lib/enriched-message.ts`
- `web/src/views/dashboard/page.tsx`
- `web/src/views/dashboard/positions-watchlist.tsx`
- `web/src/views/messages/enriched-chat-bubble.tsx`
- `web/src/views/messages/task-detail-dialog.tsx`

## Watch Out

IBKR option local symbols need their original padding for OCC parsing. Normalizing whitespace before parsing can make option positions disappear from live P&L and leave open option trades without an unrealized value.
