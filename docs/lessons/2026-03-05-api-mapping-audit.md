# API Mapping Audit — Zero-Cruft Pass

## Problem

Several API endpoints in `web-queries.ts` manually subset DB rows before returning them to the frontend. Custom types (`StoryDecision`, `TaskDecision`, `TradeStoryDecision`, `TimelineMessage`) duplicated fields already present on canonical schema types (`RunDecision`, `Message`). Extra fields like `taskContext` were redundant copies of data already present on returned objects.

## Decision

Return full DB rows directly instead of subsetting. Frontend uses structural typing — components only access the fields they need from the wider type.

Changes:
- `/trades/:id/story` — Return full `RunDecision` row instead of 5-field subset. Remove `taskContext` (redundant with `task.context`). Return full `Message` objects for `timelineMessages` instead of 4-field subset.
- `/tasks/:id` — Return full `RunDecision` row instead of 5-field subset.
- Frontend types updated: `StoryDecision`, `TaskDecision`, `TradeStoryDecision`, `TimelineMessage` all deleted. Components now use `RunDecision` and `Message` from `@src/db/schema`.
- `getDefaultChannelId()` wrapper removed (single-use indirection around `getDefaultRuntimeChannelId()`).

Additional changes:
- `/backtests/:id` — Removed `config` and `isRunning` from response (frontend derives from `run.config` and `run.status`).
- `/backtest-runs` and `/channels` — Moved JS `.filter()` on status to SQL `WHERE inArray(status, [...])`.
- `web/lib/page-adapters.ts` — Removed field-picking `.map()` on `openTrades` and `signals` in dashboard adapter (pass full objects). Removed dead `eventsByTradeId: {}` and `commissionSchedule: undefined` from trade history adapter. Cleaned up types.

Endpoints audited but left unchanged (mapping is justified):
- `/backtest-runs` item mapping — Projects from nested JSON `config`/`summary` for dropdown display
- `/channels` backtest mapping — Same (JSON column extraction + discriminant tags)
- `/messages` enriched path — Structural split for chat store's `ChatHydration` contract
- `/risk`, `/recon-alerts/stats`, `/settings/*` — Computed/derived/assembled values
- All mutation endpoints — Already clean
- All internal helpers — Legitimate aggregation, cumulative stats, or join unwrapping

## Key Files

- `src/local-api/routes/web-queries.ts` — API changes
- `web/stores/trades-store.ts` — Removed 3 exported types
- `web/lib/page-adapters.ts` — Removed field-picking maps, dead fields, unused type imports
- `web/app/trades/[id]/page.tsx` — Uses `RunDecision` + derives `context` from `task`
- `web/app/trades/page.tsx` — Removed unused destructured fields
- `web/app/tasks/[id]/page.tsx` — Uses `RunDecision`
- `web/app/trades/[id]/decision-reasoning.tsx` — Uses `RunDecision` instead of local type
- `web/app/backtests/[id]/page.tsx` — Derives `config` from `run.config`
- `web/app/components/trade-detail-panel.tsx` — Uses `RunDecision`
- `web/app/components/decision-timeline.tsx` — Uses `Message` instead of `TimelineMessage`
- `web/app/components/signal-decision-summary.tsx` — Accepts nullable `outcome`

## Watch Out

- `RunDecision.outcome` is `string | null` (unlike the old `StoryDecision.outcome: string`). Components that display outcome must handle null (`?? ''`).
- `narrowDecision()` in `trade-detail-panel.tsx` guards against null outcome before passing to `SignalDecisionSummary`.
- The trade history page's `summary` (totalPnl, winRate, etc.) is still computed client-side in the adapter from the current page of trades. This is intentional — the stats reflect only the visible page, not the full history.
