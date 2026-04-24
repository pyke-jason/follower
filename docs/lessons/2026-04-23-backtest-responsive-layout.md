## Problem

The backtest detail page used desktop assumptions in condensed widths. The action toolbar stayed on one row, the trade table and detail panel squeezed side by side on phones, the label column widths drifted, the progress marker was clipped by the card, and execution timeline rows kept too much metadata on one line.

## Decision

Keep the 760px condensed view as a split-pane workspace, but make the pieces wrap inside that layout. For phone widths, switch the trade list/detail area to a master-detail view that shows the selected trade detail full width. Keep progress marker geometry inside the card and use the existing tooltip system for current replay date/message context.

## Key Files

- web/src/views/backtests/[id]/page.tsx
- web/src/views/backtests/[id]/run-progress.tsx
- web/src/views/backtests/[id]/backtest-trades-pane.tsx
- web/src/components/trades-table-client.tsx
- web/src/components/data-table.tsx
- web/src/views/trades/[id]/decision-timeline.tsx
- web/src/views/trades/[id]/llm-reasoning.tsx
- src/local-api/routes/web-queries.ts

## Watch Out

Live backtest label snapshots can include legacy blank optional fields in JSON. Normalize those before sending SSE trade snapshots, otherwise the frontend event stream can throw even when the initial page render succeeds.
