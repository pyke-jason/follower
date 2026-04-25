# Alert Market Window

## Problem

Operational alert senders were callable at any time, so after-hours Discord and Pushover notifications could fire when they were not useful.

## Decision

Send Discord immediately at any time. Gate Pushover paging with the shared ET market calendar and a one hour buffer around the trading session. Queue Pushover pages durably in `data/pushover-queue.json` when paging is outside the window, then flush them once the next buffered market window opens.

## Key Files

- `src/lib/et-date.ts`
- `src/lib/alert.ts`
- `src/reconciliation/notify.ts`

## Watch Out

Reconciliation stores alert records separately from outbound notifications. The gate only delays Pushover paging; it does not stop Discord, reconciliation records, or risk-blocking behavior.
