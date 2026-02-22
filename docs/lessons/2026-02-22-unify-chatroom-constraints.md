Problem
The backtest detail page had a Messages tab using EnrichedChatPanel — a separate component from the standalone /messages page's ChatRoom. They shared ChatFeed but duplicated state management, pagination, and filter logic. The backtest tab lacked ChatRoom features (related messages panel, intents, labels); ChatRoom lacked enrichment (trade outcomes, decisions).

Decision
Unified on ChatRoom as the single message browsing component. Added a `constraints` prop for locked filter scope (authors, date range, runId, lastProcessedTs). When runId is in constraints, the fetch pipeline also loads enrichment data (decisions + trades via getEnrichedMessages). The filter bar adapts: shows locked date/author state, and decision filters (executed/skipped/skip reasons) when run-scoped. Deleted EnrichedChatPanel entirely.

Key Files
- web/app/messages/chat-room.tsx — FilterConstraints type, enrichment state, constraint merging
- web/app/messages/chat-filters.tsx — constraint-aware rendering (locked dates/authors, decision filters)
- web/app/messages/chat-feed.tsx — enrichment-aware default bubble rendering
- web/app/messages/actions.ts — fetchMessages routes to getEnrichedMessages when runId present
- web/app/messages/load-chat-data.ts — shared initial data loader for both pages
- web/app/backtests/[id]/page.tsx — uses ChatRoom with constraints instead of EnrichedChatPanel

Watch Out
The decision summary (executed/skipped counts) in the filter bar is computed from loaded enrichment data, not from all decisions. Counts are approximate (page-scoped), not total. If exact totals matter later, add a lightweight count query to the loader.
