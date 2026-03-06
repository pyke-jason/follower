Problem
- The app treated "Live" as an implicit environment (`null`/missing `channelId`) and mixed scope logic with channel string parsing.
- Runtime execution assumed a single broker channel, so ingestion and reconciliation were not safe for concurrent live/paper channels.
- Web/local API code duplicated channel query-string plumbing and had multiple code paths that silently fell back to unscoped behavior.

Decision
- Move runtime channel construction to env-driven registry (`ENABLED_CHANNEL_IDS` + explicit IBKR live/paper env pairs) and construct broker services per channel.
- Require explicit `channelId` in core records and runtime flows (tasks, run decisions, reconciliation balances/alerts, force-exit paths).
- Treat channel IDs as opaque tokens at call sites: no parsing/`startsWith('bt:')` branching in production logic.
- Add shared web scope helpers (`buildScopedPath`, `buildScopedSearch`) so links and API calls preserve channel scope without repeating `URLSearchParams` boilerplate.

Key Files
- `src/lib/runtime-channels.ts`
- `src/broker/select.ts`
- `src/broker/ibkr/client.ts`
- `drizzle/0027_channel_scope_strict.sql`
- `src/db/schema.ts`
- `src/live/factory.ts`
- `src/live/runner.ts`
- `src/index.ts`
- `src/reconciliation/daily-balance.ts`
- `src/reconciliation/reconciler.ts`
- `src/local-api/routes/trades.ts`
- `src/local-api/routes/web-queries.ts`
- `web/lib/channel-scope.ts`
- `web/stores/channel-store.ts`
- `web/app/components/channel-scope-provider.tsx`
- `web/app/components/channel-scope-selector.tsx`
- `web/app/components/top-bar.tsx`
- `web/app/reconciliation/page.tsx`

Watch Out
- Backtest channel IDs are currently namespaced (`bt:<runId>`). Keep them opaque and avoid deriving behavior by parsing; use explicit backtest context flags or lookup helpers.
- Test fixtures must match schema changes (`content_hash`, `channel_id` columns, unique `(message_id, channel_id)` tasks index) or in-memory sqlite tests fail with schema drift errors.
- `buildPipelineDeps` now relies on explicit config flags (`isBacktestScope`, `requireExplicitTimestamps`) for behavior that previously depended on channel parsing.
- Runtime broker resolution should only use `getRuntimeChannelServices()`/`getRuntimeBrokerMap()`; avoid reintroducing single-channel selectors.
