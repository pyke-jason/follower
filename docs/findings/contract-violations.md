
# API Contract Violations Audit

Rule: "API IS THE CONTRACT" — The API response shape is the source of truth. No defensive fallbacks in consumers. Fix mismatches at the source.

## Violation Categories

1. **FALLBACK** — Consumer uses `?? []`, `?? {}`, `?? 0`, `|| default` to paper over missing/mismatched API fields
2. **SHAPE_MISMATCH** — Frontend type expects fields the API doesn't return (or returns under different names)
3. **SHADOW_TRANSFORM** — Consumer silently reshapes/renames API data instead of fixing the contract
4. **UNTYPED_ANY** — `as any` cast at API boundary hides contract mismatches

## Findings

<!-- Agents append findings below this line -->

### [FALLBACK] channel-store.ts:67 — channelBrief coerced from undefined to null
- **Consumer**: `channelBrief: status.channelBrief ?? null`
- **API endpoint**: GET /status
- **API actually returns**: `channelBrief` is present (as object) only for backtest channels. For runtime channels, the field is absent (undefined).
- **Fix**: The `StatusData` type already marks `channelBrief` as optional (`channelBrief?: ChannelBrief`). The store state type should use `ChannelBrief | undefined` instead of `ChannelBrief | null`, eliminating the `?? null` coercion. Alternatively, the API should always return `channelBrief: null` for runtime channels so the consumer never sees `undefined`.

### [FALLBACK] trades-store.ts:76 — commissionSchedule coerced from undefined to null
- **Consumer**: `commissionSchedule: data.commissionSchedule ?? null`
- **API endpoint**: N/A (hydrated from page adapter, not directly from API)
- **API actually returns**: `fetchTradeHistoryPageData` always returns `commissionSchedule: undefined` (page-adapters.ts:265). The backtests detail page may pass a real value.
- **Fix**: The `TradesHydration` type declares `commissionSchedule?: CommissionSchedule`. Change the store state type from `CommissionSchedule | null` to `CommissionSchedule | undefined` and use `data.commissionSchedule` directly with no fallback. Or make the hydration type non-optional by always providing a value.

### [FALLBACK] trades-store.ts:77 — startingEquity coerced from undefined to null
- **Consumer**: `startingEquity: data.startingEquity ?? null`
- **API endpoint**: N/A (hydrated from page adapter)
- **API actually returns**: `fetchTradeHistoryPageData` does not set `startingEquity`, so it is `undefined`.
- **Fix**: Same as commissionSchedule — use `undefined` in state type or require the field in `TradesHydration`.

### [FALLBACK] trades-store.ts:78 — channelId coerced from undefined to null
- **Consumer**: `channelId: data.channelId ?? null`
- **API endpoint**: N/A (hydrated from page adapter)
- **API actually returns**: `fetchTradeHistoryPageData` does not include `channelId` in its return type. The trades page passes `channelId` from `useChannelId()` directly into the hydration object (page.tsx:117), but `TradesHydration` marks it optional.
- **Fix**: Make `channelId` required in `TradesHydration` (the page always supplies it) and drop the fallback.

### [SHAPE_MISMATCH] chat-store.ts:129 — hydrate reads `data.cursor` but API returns `nextCursor`
- **Consumer**: `cursor: data.cursor` in `hydrate()` method
- **API endpoint**: GET /messages
- **API actually returns**: `{ messages, labels, enrichment, nextCursor, authors }` — the field is `nextCursor`, not `cursor`.
- **Fix**: Either rename the API response field to `cursor` or update `ChatHydration` to use `nextCursor: string | null`. The `setFilters` and `loadOlderMessages` methods already read `result.nextCursor` correctly (lines 168, 193), so only `hydrate()` is broken. This causes the initial cursor state to be `undefined` instead of the actual pagination cursor value, silently breaking "load older" on the initial page load.

### [UNTYPED_ANY] messages/page.tsx:27 — `as any` hides ChatHydration shape mismatch
- **Consumer**: `<ChatHydrator data={data as any} />`
- **API endpoint**: GET /messages
- **API actually returns**: `{ messages, labels, enrichment, nextCursor, authors }` which does NOT match `ChatHydration` (expects `cursor` not `nextCursor`, and has optional `constraints`/`stableDecisionCounts` absent from API).
- **Fix**: Define a proper `MessagesApiResponse` type matching the actual API shape, then map it to `ChatHydration` in the page component (renaming `nextCursor` to `cursor`). Remove the `as any` cast.

### [SHAPE_MISMATCH] chat-store.ts:75 — signalsOnly sent as `'1'` but API expects `'true'`

- **Consumer**: `buildMessageParams` does `params.set('signalsOnly', '1')` when `filters.signalsOnly` is true.
- **API endpoint**: GET /messages
- **API actually returns**: The handler parses with `c.req.query('signalsOnly') === 'true'`, so `'1'` evaluates to `false`.
- **Effect**: The "Signals only" toggle in the chat filters is completely broken on the standard (non-channel-scoped) path. Toggling it on triggers a re-fetch, but the API ignores the filter and returns all messages regardless.
- **Fix**: Change `chat-store.ts` line 75 to `params.set('signalsOnly', 'true')`, or change the API handler to use a truthy check like `!!c.req.query('signalsOnly')`. Pick one convention and apply it consistently.

### [SHAPE_MISMATCH] chat-store.ts:163,180 — phantom `cursor` field from intersection type

- **Consumer**: `api<ChatHydration & { nextCursor: string | null }>('/messages?...')` — the intersection type implies the API returns both `cursor` (from `ChatHydration`) and `nextCursor`. At runtime only `nextCursor` exists.
- **API endpoint**: GET /messages
- **API actually returns**: `{ messages, labels, enrichment, nextCursor, authors }` — no `cursor` field.
- **Effect**: The code correctly reads `result.nextCursor` to set `store.cursor`, so there is no runtime bug. But the type is a lie: `result.cursor` would type-check as `string | null` while actually being `undefined`.
- **Fix**: Define a dedicated `MessagesApiResponse` type matching the actual API shape (`{ messages, labels, enrichment, nextCursor, authors }`). Use that type for `api<>()` calls instead of the intersection hack.

### [SHADOW_TRANSFORM] chat-room.tsx:49 — empty enrichment `{}` silently converted to `undefined`

- **Consumer**: `enrichment={Object.keys(enrichment).length > 0 ? enrichment : undefined}` converts the store's `{}` (which is what the API returns on the standard non-channel path) into `undefined` before passing to `ChatFeed`.
- **API endpoint**: GET /messages (standard path)
- **API actually returns**: `enrichment: {}` — an empty object, which is a valid `Record<string, MessageEnrichment>`.
- **Effect**: `ChatFeed` treats `undefined` enrichment as "no enrichment mode" and skips `EnrichedChatBubble` rendering. This works but the transform is invisible — a future consumer might not know that `{}` means "no enrichment".
- **Fix**: Have the API return `enrichment: null` when enrichment is not applicable (i.e., non-channel-scoped requests), and type `ChatFeed.enrichment` as `Record<string, MessageEnrichment> | null`. The consumer passes the value through without reshaping.

### [FALLBACK] page-adapters.ts:264 — flagsByTradeId fallback in adapter layer
- **Consumer**: `flagsByTradeId: flags ?? {}`
- **API endpoint**: GET /trades
- **API actually returns**: `{ trades, flags }` where `flags` is always `Record<string, TradeFlag[]>` (from `buildFlagsByTradeId` which returns `{}` for empty input).
- **Fix**: The API always returns `flags` as an object. Remove the `?? {}` fallback and type the response correctly so `flags` is non-optional.

### [FALLBACK] trades/page.tsx:114-115 — hydration data applies defensive fallbacks
- **Consumer**: `eventsByTradeId: eventsByTradeId ?? {}` and `flagsByTradeId: flagsByTradeId ?? {}`
- **API endpoint**: N/A (data comes from `fetchTradeHistoryPageData`)
- **API actually returns**: `fetchTradeHistoryPageData` always returns `eventsByTradeId: {}` and `flagsByTradeId: flags ?? {}` — these are never nullish.
- **Fix**: Remove `?? {}` from both fields. The page adapter already guarantees objects. If the concern is the adapter return type, make `eventsByTradeId` and `flagsByTradeId` required (non-optional) in `TradeHistoryPageData`.

### [FALLBACK] top-bar.tsx:19 — todayPnl coerced from undefined to 0
- **Consumer**: `const pnl = status?.todayPnl ?? 0;`
- **API endpoint**: GET /status
- **API actually returns**: `todayPnl` is always a number (from `safeParseFloat` in `getStatsInternal`). The `?? 0` defends against `status` being null (already guarded by `{status && ...}` on line 60), not against a missing field.
- **Fix**: Move `pnl` derivation inside the `{status && ...}` render block so `status` is narrowed to non-null and no fallback is needed.

### [FALLBACK] top-bar.tsx:27 — unresolvedAlertCount fallback
- **Consumer**: `(status?.unresolvedAlertCount ?? 0) > 0`
- **API endpoint**: GET /status
- **API actually returns**: For runtime channels, `unresolvedAlertCount` is always a number. For backtest channels, the field is absent (undefined).
- **Fix**: The API should always return `unresolvedAlertCount: 0` for backtest channels to eliminate this consumer-side fallback. The `StatusData` type marking it optional forces every consumer to handle the gap.

### [FALLBACK] trade-row.tsx:130 — events fallback on sparse record indexing
- **Consumer**: `const events = useTradesStore((s) => s.eventsByTradeId[tradeId]) ?? [];`
- **API endpoint**: GET /trades (via hydration)
- **API actually returns**: `eventsByTradeId` is a sparse `Record<string, TradeEvent[]>` — trades with no events have no entry.
- **Fix**: Make the record dense at the API layer (include an empty array for every trade ID), or centralize the fallback in a single store accessor so consumers never index the record directly.

### [FALLBACK] trade-row.tsx:131 — flags fallback on sparse record indexing
- **Consumer**: `const flags: TradeFlag[] = useTradesStore((s) => s.flagsByTradeId[tradeId]) ?? [];`
- **API endpoint**: GET /trades (via hydration)
- **API actually returns**: `buildFlagsByTradeId` (web-queries.ts:42-50) only includes entries for trades that HAVE flags — it skips trades with empty flag arrays.
- **Fix**: Same as events — make the API include an empty array for every trade, or centralize the fallback in a store accessor.

### [FALLBACK] trade-row.tsx:251 — quantity fallback to 1
- **Consumer**: `{trade.quantity ?? 1}` (display-only)
- **API endpoint**: GET /trades
- **API actually returns**: `quantity` is `number | null` in the schema. The API returns whatever is in the DB.
- **Fix**: The API should guarantee `quantity` is always a number (default 1 at write time or via COALESCE in the query). The `recordTrade` path sets quantity, so null values are legacy data. Add a migration or API coalesce.

### [FALLBACK] trades-table-client.tsx:105 — eventsByTradeId sparse record fallback
- **Consumer**: `const events = eventsByTradeId[t.id] ?? [];`
- **API endpoint**: N/A (store data)
- **API actually returns**: Sparse record — same root cause as trade-row.tsx:130.
- **Fix**: Same — make the record dense or centralize the fallback.

### [FALLBACK] trade-filters.tsx:57 — flagsByTradeId sparse record fallback in filter logic
- **Consumer**: `const tradeFlags = flagsByTradeId[t.id] ?? [];`
- **API endpoint**: N/A (passed as prop from store)
- **API actually returns**: Sparse record — same root cause as trade-row.tsx:131.
- **Fix**: Same — make the record dense at the API layer.

### [FALLBACK] decision-timeline.tsx:332 — timelineMessages null guard
- **Consumer**: `const msgMap = new Map((messages ?? []).map(m => [m.id, m]));`
- **API endpoint**: GET /trades/:id/story
- **API actually returns**: `timelineMessages` is always an array (web-queries.ts:292-294 — built with `.filter()` and `.map()`, guaranteed non-null). The `TradeStory` type declares `timelineMessages: TimelineMessage[]` (non-optional).
- **Fix**: Remove `?? []`. The destructured `messages` binding comes from `story.timelineMessages` which is non-optional in the store type. The fallback is dead code that masks potential issues.

### [SHADOW_TRANSFORM] page-adapters.ts:17-21 — toNumber() silently coerces API string types to numbers
- **Consumer**: `function toNumber(value: string | number | null | undefined): number { ... }` — used on `row.equity` (line 117), `row.totalPnl` (line 122), `trade.pnl` (line 249).
- **API endpoint**: GET /dashboard, GET /trades
- **API actually returns**: `equity` from `dailyBalances` is `string | null` (SQLite text column). `totalPnl` from `getTraderPnlSummaryInternal` is `string` (SQL aggregate). `trade.pnl` is `string | null`.
- **Fix**: The API should return numeric fields as numbers, not strings. The internal helpers already use `safeParseFloat()` for stats — extend this to `totalPnl` in trader P&L summary and `equity` in daily balances. This would eliminate the `toNumber` adapter function entirely.

### [SHADOW_TRANSFORM] page-adapters.ts:120-125 — traderPnl reshaped with field renames and computed winRate
- **Consumer**: `dashboard.traderPnl.map((row) => ({ trader: row.trader, pnl: toNumber(row.totalPnl), trades: row.tradeCount, winRate: ... }))`
- **API endpoint**: GET /dashboard (delegates to `getTraderPnlSummaryInternal`)
- **API actually returns**: `{ trader: string, totalPnl: string, tradeCount: number, wins: number }`
- **Fix**: The API should return data in the shape the frontend needs: rename `totalPnl` to `pnl` (as number), `tradeCount` to `trades`, and compute `winRate` server-side. This eliminates the adapter reshape.

### [SHADOW_TRANSFORM] page-adapters.ts:137-146 — openTrades projected to field subset
- **Consumer**: `dashboard.openTrades.map((trade) => ({ id, symbol, direction, strategy, trader, entryPrice, quantity, openedAt }))`
- **API endpoint**: GET /dashboard (delegates to `getOpenTradesInternal` which does `SELECT *`)
- **API actually returns**: Full `Trade` objects with all 20+ columns.
- **Fix**: The API should return a projection (select only the 8 needed columns). The adapter manually picks fields, decoupling the consumer's expected shape from the API — if a field were removed from Trade, no type error would surface because the adapter silently drops it.

### [UNTYPED_ANY] trades/[id]/page.tsx:30 — useQuery<any> erases API contract for trade story

- **Consumer**: `useQuery<any>({ queryKey: ['trade', id, channelId], queryFn: () => api(buildScopedPath(`/trades/${id}/story`, channelId)) })`
- **API endpoint**: GET /trades/:id/story
- **API actually returns**: `{ trade, events, task, taskContext, sourceMessage, closeMessage, nearbyMessages, decision, decisions, timelineMessages }`
- **Fix**: Replace `useQuery<any>` with `useQuery<TradeStory>` using the `TradeStory` type already defined in `web/stores/trades-store.ts` (lines 20-31), which matches the API shape exactly.

### [UNTYPED_ANY] traders/[name]/page.tsx:29 — useQuery<any> erases API contract for trader detail

- **Consumer**: `useQuery<any>({ queryFn: () => api(buildScopedPath(`/traders/${name}`, channelId)) })`
- **API endpoint**: GET /traders/:name
- **API actually returns**: `{ trader, equityCurve, strategyBreakdown, historySummary, closedTrades }`
- **Fix**: Define a `TraderDetailResponse` type matching the API response and use `useQuery<TraderDetailResponse>`. This is the root cause enabling the five SHAPE_MISMATCH violations below — `any` silently swallows all field name mismatches.

### [SHAPE_MISMATCH] traders/[name]/page.tsx:44 — five destructured field names do not exist in API response

- **Consumer**: `const { trader, summary, equityData, strategyChartData, metrics, recentTrades } = data;`
- **API endpoint**: GET /traders/:name
- **API actually returns**: `{ trader, equityCurve, strategyBreakdown, historySummary, closedTrades }`. Every destructured name except `trader` is wrong:
  - `summary` -> API has `historySummary`
  - `equityData` -> API has `equityCurve`
  - `strategyChartData` -> API has `strategyBreakdown`
  - `recentTrades` -> API has `closedTrades`
  - `metrics` -> does not exist in API response at all
- **Fix**: Create a `fetchTraderDetailPageData()` adapter that maps API field names to what the page expects, derives `metrics` from `historySummary`, and maps inner shapes. Without a fix, all five fields are `undefined` at runtime so the entire page renders with no data below the header.

### [SHAPE_MISMATCH] traders/[name]/page.tsx:83 — equityCurve inner shape incompatible with OverviewEquityCurve

- **Consumer**: Passes `equityData` to `<OverviewEquityCurve>` which expects `{ date: string; equity: number }[]`
- **API endpoint**: GET /traders/:name (via `getTraderEquityCurveInternal`)
- **API actually returns**: `equityCurve` shape is `{ date: string; pnl: number; cumPnl: number }[]`. No `equity` key exists.
- **Fix**: Page adapter should map `cumPnl` -> `equity` when converting for the chart component.

### [SHAPE_MISMATCH] traders/[name]/page.tsx:96-98 — strategyBreakdown inner shape incompatible with BarChartComponent

- **Consumer**: `<BarChartComponent data={strategyChartData} xKey="name" yKey="pnl" ...>`
- **API endpoint**: GET /traders/:name (via `getTraderStrategyBreakdownInternal`)
- **API actually returns**: `strategyBreakdown` shape is `{ strategy: string; trades: number; totalPnl: string; wins: number }[]`. Consumer expects key `name` (API has `strategy`) and key `pnl` as number (API has `totalPnl` as string).
- **Fix**: Page adapter should map `{ strategy -> name, parseFloat(totalPnl) -> pnl }`.

### [FALLBACK] traders/[name]/page.tsx:39 — defensive fallbacks mask wrong field names from API

- **Consumer**: `hydrate({ trades: data.recentTrades ?? [], eventsByTradeId: data.recentEventsByTradeId ?? {}, flagsByTradeId: {}, channelId })`
- **API endpoint**: GET /traders/:name
- **API actually returns**: `closedTrades` (not `recentTrades`), and does NOT return `recentEventsByTradeId`. Both `data.recentTrades` and `data.recentEventsByTradeId` are `undefined` at runtime. The `?? []` and `?? {}` fallbacks silently produce empty data, making the "Recent Trades" section always appear empty.
- **Fix**: Use `data.closedTrades` for trades. Remove `data.recentEventsByTradeId ?? {}`; if events are needed, add them to the API response or fetch them separately.

### [FALLBACK] trades/[id]/page.tsx:38 — defensive fallback on trade.legs (notNull column)

- **Consumer**: `const legs = trade.legs ?? [];`
- **API endpoint**: GET /trades/:id/story
- **API actually returns**: `trade.legs` is a `notNull()` column with default `[]` (`schema.ts:93`). The API always returns it as a non-null array.
- **Fix**: Remove `?? []`. The DB schema guarantees the field is never null.

### [UNTYPED_ANY] trades/open/page.tsx:80 — trades.map callback parameter explicitly typed as any

- **Consumer**: `{trades.map((t: any, i: number) => { ... })}`
- **API endpoint**: GET /trades?status=open
- **API actually returns**: `{ trades: Trade[], flags: Record<string, TradeFlag[]> }` — trades are fully typed
- **Fix**: Remove the `any` annotation. The `OpenTrade` type is already defined at lines 14-23 of the same file and the response is typed as `OpenTradesResponse`. Use `(t: OpenTrade, i: number)` or let TypeScript infer from the typed response.

### [SHADOW_TRANSFORM] page-adapters.ts:113-118 — dailyBalances reversed and equity coerced from string

- **Consumer**: `[...dashboard.dailyBalances].reverse().map((row) => ({ date: row.date, equity: toNumber(row.equity) }))`
- **API endpoint**: GET /dashboard (delegates to `getDailyBalancesInternal` which returns DESC order)
- **API actually returns**: `dailyBalances` in descending date order, with `equity` as `text` (string). The consumer reverses to ASC and coerces `equity` to number.
- **Fix**: The API should return daily balances in ascending order (chart-ready) and convert `equity` to a number server-side. The sort order is a presentation concern that belongs in the API, not the adapter.

### [UNTYPED_ANY] tasks/page.tsx:34 — `as any[]` erases Task type from API response
- **Consumer**: `<TaskList tasks={tasks as any[]} channelId={channelId} initialStatus={status} />`
- **API endpoint**: GET /tasks
- **API actually returns**: `Task[]` (full task rows from schema)
- **Fix**: Type the `useQuery` call as `api<Task[]>(...)` and remove the `as any[]` cast. This would surface any mismatch between the API shape and what `TaskList` expects at compile time.

### [SHADOW_TRANSFORM] page-adapters.ts:263 — eventsByTradeId hardcoded to empty object
- **Consumer**: `eventsByTradeId: {}` in `fetchTradeHistoryPageData` return value
- **API endpoint**: GET /trades
- **API actually returns**: `{ trades, flags }` — no events field.
- **Fix**: The `TradeHistoryPageData` type declares `eventsByTradeId: Record<string, TradeEvent[]>` but this field is always an empty object because the API does not return events. Any consumer trying to display trade events on the trade history page (e.g., `TradeRow` accessing `eventsByTradeId[t.id]`) silently gets `undefined`. Either remove `eventsByTradeId` from `TradeHistoryPageData`, or have the API return events alongside trades.

### [SHADOW_TRANSFORM] bar-chart.tsx:103 — unvalidated `as number` cast on dynamic chart data
- **Consumer**: `(entry[yKey] as number) >= 0` where `entry` is `Record<string, unknown>`
- **API endpoint**: N/A (data passed via props from various pages)
- **API actually returns**: The bar chart `data` prop is typed `Record<string, unknown>[]`. The `yKey` value is bracket-accessed and cast to `number` without validation.
- **Fix**: Tighten the `data` prop type (e.g., `Record<string, string | number>[]`), or use `Number(entry[yKey])` with a finite check. Currently, non-numeric data causes `NaN >= 0` = `false`, silently rendering all bars in the "loss" color.

### [UNTYPED_ANY] chart components — tooltipFormatter typed as `(...args: any[])`
- **Consumer**: `area-chart.tsx:21`, `bar-chart.tsx:23`, `line-chart.tsx:34` all declare `tooltipFormatter?: (...args: any[]) => [string, string]`
- **API endpoint**: N/A (recharts library callback)
- **Fix**: Low priority. Replace with `(value: number, name: string) => [string, string]` matching the recharts formatter signature. Each file has an eslint-disable comment acknowledging this.

### [UNTYPED_ANY] scatter-chart.tsx:37 — tooltipContent typed as `(props: any)`
- **Consumer**: `tooltipContent?: (props: any) => React.ReactNode`
- **API endpoint**: N/A (recharts library callback)
- **Fix**: Low priority. Import and use recharts `TooltipProps` type instead of `any`.

### [SHAPE_MISMATCH] GET /tasks/:id — flat task object vs nested envelope expected by frontend

- **API returns**: Flat task object `{ id, channelId, taskType, status, assignee, priority, context, result, error, messageId, ... }` (web-queries.ts:341, `return c.json(task)`)
- **Frontend expects**: `{ task, sourceMessage, runDecision, nearbyMessages, channelId, redirect }` (tasks/[id]/page.tsx:53)
- **Missing/mismatched**:
  - `task` — frontend expects the task nested under a `task` key, but the API returns the task as the top-level object. `data.task` is `undefined`.
  - `sourceMessage` — **not returned by API**; should be fetched by looking up `task.messageId` in the messages table
  - `runDecision` — **not returned by API**; should be fetched from `run_decisions` for the task's message and channel
  - `nearbyMessages` — **not returned by API**; should be fetched based on the source message's author/timestamp
  - `channelId` — exists on the flat task as `data.channelId`, but the frontend reads it at `data.channelId` from the envelope (same key happens to work)
  - `redirect` — **not returned by API**; frontend checks `data.redirect` (line 40, 51) to navigate to trade detail when a trade exists for the task
- **Effect**: `data.task` is `undefined` (the task IS `data`). The page renders "Task not found" for every task. The refetchInterval condition `task?.task?.status` (line 33) is always undefined, so polling never activates. The redirect logic `data?.redirect` (line 40) is always falsy.
- **Fix**: Expand the `GET /tasks/:id` handler to return a full envelope (same pattern as `GET /trades/:id/story`): look up the source message via `task.messageId`, fetch the run decision from `run_decisions`, fetch nearby messages, check for an associated trade to build `redirect`, and wrap in `{ task, sourceMessage, runDecision, nearbyMessages, channelId, redirect }`.

### [SHAPE_MISMATCH] TradeScatterPoint type includes `holdDays` not returned by API

- **API returns**: Trade scatter points as `{ date, pnl, strategy, direction, quantity, symbol, trader }` (web-queries.ts:1623-1631)
- **Frontend expects**: `TradeScatterPoint` type includes `holdDays: number` (backtests/[id]/trade-scatter.tsx:10) as a required field
- **Missing/mismatched**: `holdDays` is declared required but never returned by the API
- **Effect**: No runtime error because the component never reads `holdDays`. But the type is inaccurate -- any future code relying on `holdDays` would get `undefined` at runtime.
- **Fix**: Remove `holdDays` from `TradeScatterPoint` type (it is unused), or compute it server-side in `computeFromTrades` as `Math.ceil((closedAt - openedAt) / 86400000)` and include it in the response.

### [SHAPE_MISMATCH] RollingWinRatePoint type declares `tradeIndex` (not in API), omits `date` (in API)

- **API returns**: Rolling win rate points as `{ tradeNum, date, winRate, windowSize }` (web-queries.ts:1633-1646)
- **Frontend expects**: `RollingWinRatePoint = { tradeIndex: number; tradeNum: number; winRate: number; windowSize?: number }` (backtests/[id]/rolling-win-rate.tsx:3)
- **Missing/mismatched**:
  - `tradeIndex` — declared required in the type but never returned by the API
  - `date` — returned by the API but absent from the frontend type
- **Effect**: No runtime error because `tradeIndex` is never accessed and `date` is unused in the component. The type is inaccurate.
- **Fix**: Update the type to `{ tradeNum: number; date: string; winRate: number; windowSize?: number }`, removing the phantom `tradeIndex` and adding `date`.

### [SHAPE_MISMATCH] web/app/tasks/[id]/page.tsx:53 — Consumer destructures fields the API does not return
- **Consumer**: `const { task, sourceMessage, runDecision, nearbyMessages, channelId } = data;` expects a wrapper object with five top-level keys (`task`, `sourceMessage`, `runDecision`, `nearbyMessages`, `channelId`).
- **API endpoint**: GET /tasks/:id
- **API actually returns**: A flat task row: `{ id, messageId, taskType, status, assignee, priority, context, result, createdAt, startedAt, completedAt, error, modelProvider, modelName, channelId }`. No `task` wrapper, no `sourceMessage`, no `runDecision`, no `nearbyMessages`.
- **Fix**: Expand the API to return `{ task, sourceMessage, runDecision, nearbyMessages, channelId }` (preferred -- the consumer clearly needs related data for the detail view), or rewrite the consumer to work with the flat task shape and fetch related data separately.

### [SHAPE_MISMATCH] web/app/tasks/[id]/page.tsx:33 — refetchInterval checks double-nested `task.task.status`
- **Consumer**: `if (task?.task?.status === 'PENDING' || task?.task?.status === 'IN_PROGRESS') return 2000;` assumes the response is `{ task: { status } }`.
- **API endpoint**: GET /tasks/:id
- **API actually returns**: `{ status, ... }` (flat). `data.task` is `undefined`, so `task?.task?.status` is always `undefined` and the polling interval never activates. Active tasks never poll for updates.
- **Fix**: Align with the shape fix above. If API wraps in `{ task }`, this becomes correct. If consumer uses flat shape, change to `task?.status`.

### [SHAPE_MISMATCH] web/app/tasks/[id]/page.tsx:40-42 — Consumer checks `data.redirect` which API never returns
- **Consumer**: `if (data?.redirect) { navigate(data.redirect, { replace: true }); }` and line 51: `if (data.redirect) return <Spinner />;`.
- **API endpoint**: GET /tasks/:id
- **API actually returns**: A flat task row with no `redirect` field.
- **Fix**: Either add redirect logic to the API (e.g., return `{ redirect: '/trades/...' }` when the task has a completed linked trade), or remove the redirect handling from the consumer.

### [UNTYPED_ANY] web/app/tasks/[id]/page.tsx:30 — `api<any>` erases response type
- **Consumer**: `api<any>(`/tasks/${id}`)` -- the generic parameter `any` bypasses all type checking on the response, allowing the shape mismatch on line 53 to go undetected at compile time.
- **API endpoint**: GET /tasks/:id
- **API actually returns**: Task row (typed as `Task` in schema).
- **Fix**: Define a `TaskDetailResponse` type matching the actual (or intended) API response shape and use `api<TaskDetailResponse>(...)`.

### [UNTYPED_ANY] web/app/tasks/page.tsx:34 — `as any[]` erases element type
- **Consumer**: `<TaskList tasks={tasks as any[]} .../>` casts the API response to `any[]` instead of typing it as `Task[]`.
- **API endpoint**: GET /tasks
- **API actually returns**: An array of task rows (each with `id, messageId, taskType, status, assignee, priority, context, result, createdAt, startedAt, completedAt, error, modelProvider, modelName, channelId`).
- **Fix**: Type the `api()` call as `api<Task[]>(...)` using the Task type from schema and remove the `as any[]` cast.

### [FALLBACK] web/app/tasks/task-list.tsx:151 — Defensive `|| {}` on non-nullable context field
- **Consumer**: `const ctx = (t.context as TaskContext) || {};` applies `|| {}` fallback.
- **API endpoint**: GET /tasks
- **API actually returns**: `context` is always a non-null object (schema enforces `notNull().default({})`).
- **Fix**: Remove the `|| {}` fallback. Trust the API contract that `context` is never null/undefined. The component's local `Task` type (line 24) should type `context` as `TaskContext` (not `TaskContext | null`).

### [FALLBACK] web/app/tasks/[id]/page.tsx:120 — Defensive `?? ''` on outcome display
- **Consumer**: `<Badge label={runDecision?.outcome ?? result?.outcome ?? ''} />` falls back to empty string.
- **API endpoint**: GET /tasks/:id
- **API actually returns**: `result` is typed as `{ outcome: string } | null`. When non-null, `outcome` is always a string. The `runDecision` field does not exist in the API response at all (see shape mismatch above).
- **Fix**: Once the shape mismatch is fixed, if `runDecision` and `result` are properly typed, the `?? ''` chain becomes unnecessary. The Badge should only render when an outcome value exists (conditional render), not fall back to an empty string.

### [FALLBACK] web/app/reconciliation/page.tsx:62-63 — Defensive `?? 0` on byType keys
- **Consumer**: `stats.byType['DB_ONLY'] ?? 0` and `stats.byType['BROKER_ONLY'] ?? 0` applies fallback because the API only includes types that have records in the group-by result.
- **API endpoint**: GET /recon-alerts/stats
- **API actually returns**: `byType` is `Object.fromEntries(byType.map(...))` from a GROUP BY query. If no alerts of type `DB_ONLY` exist, the key is absent from the object.
- **Fix**: Fix at the API -- always include all three alert types (`DB_ONLY`, `BROKER_ONLY`, `QUANTITY_MISMATCH`) with 0 counts so consumers can trust the keys exist. Remove `?? 0` from consumers.

### [UNTYPED_ANY] web/app/reconciliation/page.tsx:32 — `api<any[]>` erases alert type
- **Consumer**: `api<any[]>(buildScopedPath('/recon-alerts', ...))` uses `any[]` instead of a typed alert array.
- **API endpoint**: GET /recon-alerts
- **API actually returns**: Array of `ReconciliationAlert` rows (`id, channelId, type, symbol, tradeId, expected, actual, resolved, resolvedAt, resolvedReason, createdAt`).
- **Fix**: Import or define a `ReconciliationAlert` type and use `api<ReconciliationAlert[]>(...)`.

### [UNTYPED_ANY] web/app/reconciliation/page.tsx:104,131 — `alert: any` parameter type in AlertRow
- **Consumer**: Line 104: `alerts.map((alert: any) => ...)` and line 131: `alert: any` in `AlertRow` props. All field access on `alert` (`.id`, `.type`, `.symbol`, `.expected`, `.actual`, `.tradeId`, `.createdAt`, `.resolved`, `.resolvedReason`) is untyped.
- **API endpoint**: GET /recon-alerts
- **API actually returns**: Typed `ReconciliationAlert` rows.
- **Fix**: Type the `alert` parameter as `ReconciliationAlert`. This would also flow naturally from fixing the upstream `api<any[]>` call.

### [FALLBACK] web/app/settings/page.tsx:30-33 — Defensive `?? false` on guaranteed array entries
- **Consumer**: `secrets.find((s) => s.key === 'DISCORD_WEBHOOK_URL')?.isSet ?? false` applies `?? false` fallback. Same pattern for `PUSHOVER_APP_TOKEN` and `PUSHOVER_USER_KEY`.
- **API endpoint**: GET /settings/secrets
- **API actually returns**: An array built from `SECRET_KEYS` (minus toggle keys). `DISCORD_WEBHOOK_URL`, `PUSHOVER_APP_TOKEN`, and `PUSHOVER_USER_KEY` are all in `SECRET_KEYS` and not in `TOGGLE_KEYS`, so they are guaranteed present in the returned array.
- **Fix**: Restructure the API to return a keyed object `Record<string, boolean>` (or `Record<string, { isSet: boolean }>`) instead of an array, so consumers can do `secrets.DISCORD_WEBHOOK_URL` directly without `.find()`. Alternatively, extract a helper that asserts the key exists.

---

## web/app/backtests/ — Full Audit 2026-03-05

Files audited: `page.tsx`, `backtest-list.tsx`, `new/page.tsx`, `new/backtest-form.tsx`, `[id]/page.tsx`, `[id]/backtest-tabs.tsx`, `[id]/backtest-trades-table.tsx`, `[id]/breakdown-charts.tsx`, `[id]/equity-curve-chart.tsx`, `[id]/drawdown-chart.tsx`, `[id]/decision-scatter.tsx`, `[id]/log-viewer.tsx`, `[id]/run-progress.tsx`, `[id]/rolling-win-rate.tsx`, `[id]/trade-scatter.tsx`, `[id]/collapsible-error.tsx`.

Clean files (no violations): `page.tsx`, `backtest-tabs.tsx`, `backtest-trades-table.tsx`, `decision-scatter.tsx`, `equity-curve-chart.tsx`, `log-viewer.tsx`, `run-progress.tsx`, `collapsible-error.tsx`, `backtest-form.tsx`.

### [UNTYPED_ANY] backtests/[id]/page.tsx:138 — useQuery typed as `any`

- **Consumer**: `const { data } = useQuery<any>({ ... })` — entire backtest detail response is typed `any`
- **API endpoint**: GET /backtests/:id
- **API actually returns**: `{ run, config, isRunning, decisions, allTrades, eventsByTradeId, flagsByTradeId, mtmSnapshots, summary, byTrader, byStrategy, equityCurve, tradeScatter, rollingWinRate, strategyEquity, strategies, llmTokens, messagesEndDate }`
- **Fix**: Define a typed response interface for the `/backtests/:id` endpoint and use it as the `useQuery` generic. All destructured fields on line 164-169 should come from a named type.

### [UNTYPED_ANY] backtests/new/page.tsx:22-24 — clone source typed as `{ config: any; run?: { config?: any } }`

- **Consumer**: `useQuery<{ config: any; run?: { config?: any } }>({ queryFn: () => api(\`/backtests/${cloneId}\`) })`
- **API endpoint**: GET /backtests/:id
- **API actually returns**: `{ run: BacktestRun, config: BacktestRunConfig, ... }` — `config` is always `BacktestRunConfig`, never `any`
- **Fix**: Type the query as `{ config: BacktestRunConfig; run: BacktestRun }` or a narrowed pick of the detail response. Remove `any`.

### [SHADOW_TRANSFORM] backtests/new/page.tsx:30 — redundant config extraction with unreachable fallback

- **Consumer**: `const defaultConfig = cloneSource?.config ?? cloneSource?.run?.config` — tries two paths to find config
- **API endpoint**: GET /backtests/:id
- **API actually returns**: `config` is always a top-level key (it equals `run.config`). The `?? cloneSource?.run?.config` branch is unreachable dead code.
- **Fix**: Just use `cloneSource?.config`. Remove the `?? cloneSource?.run?.config` branch.

### [FALLBACK] backtests/[id]/page.tsx:99 — phase ?? 'agent' fabricates data

- **Consumer**: `phase: row.decision.phase ?? 'agent'` in `buildBacktestChatData`
- **API endpoint**: GET /backtests/:id (decisions array)
- **API actually returns**: `decision.phase` is `text('phase')` in the DB — it can be `null` for older rows. But the consumer substitutes `'agent'` as a default, silently changing the semantics.
- **Fix**: If null phase means "unknown", display it as such. If all current decisions always have a phase, make the API guarantee it (coalesce in the query or a NOT NULL constraint). Do not silently fabricate `'agent'`.

### [FALLBACK] backtests/[id]/page.tsx:184 — summary?.maxDrawdown ?? 0

- **Consumer**: `const hasDrawdown = (summary?.maxDrawdown ?? 0) > 0`
- **API endpoint**: GET /backtests/:id
- **API actually returns**: `summary` is `null` when there are no trades (computeFromTrades line 1670). `maxDrawdown` is always present on non-null summaries.
- **Fix**: Guard on `summary !== null` first, then access `summary.maxDrawdown` directly: `const hasDrawdown = summary != null && summary.maxDrawdown > 0`.

### [FALLBACK] backtests/[id]/page.tsx:352 — config.agentProvider ?? 'anthropic'

- **Consumer**: `{config.agentProvider ?? 'anthropic'}/{config.agentModel ?? 'default'}`
- **API endpoint**: GET /backtests/:id
- **API actually returns**: `config.agentProvider` is `string | undefined` in `BacktestRunConfig`. The API passes through whatever was stored.
- **Fix**: Make `agentProvider` and `agentModel` required in `BacktestRunConfig` (the backtest creation flow always sets them). Alternatively, the API should normalize them before returning. Consumer should not fabricate defaults.

### [FALLBACK] backtests/[id]/page.tsx:354 — config.fillModel ?? 'orats'

- **Consumer**: `{config.fillModel ?? 'orats'}`
- **API endpoint**: GET /backtests/:id
- **API actually returns**: `config.fillModel` is `'orats' | 'midpoint' | 'natural' | undefined` in `BacktestRunConfig`.
- **Fix**: Either make `fillModel` required in the config type (with a default applied at backtest creation) or have the API normalize it before returning.

### [FALLBACK] backtests/[id]/page.tsx:367 — liveMetrics?.unrealizedPnl ?? 0

- **Consumer**: `const unrealized = liveMetrics?.unrealizedPnl ?? 0`
- **API endpoint**: GET /backtests/:id
- **API actually returns**: `liveMetrics` is `LiveMetrics | null`. When non-null, `unrealizedPnl` is `number | null`.
- **Fix**: Handle `null` explicitly rather than coercing to 0. When `liveMetrics` is null or `unrealizedPnl` is null, there is genuinely no unrealized data — the consumer should not pretend it is $0.

### [FALLBACK] backtests/[id]/page.tsx:369-370 — summary.totalCommissions ?? 0 and summary.netPnl ?? summary.totalPnl

- **Consumer**: `const hasComm = (summary.totalCommissions ?? 0) > 0` and `const displayPnl = hasComm ? (summary.netPnl ?? summary.totalPnl) : summary.totalPnl`
- **API endpoint**: GET /backtests/:id
- **API actually returns**: The computed `summary` from `computeCoreStats` always includes both `totalCommissions` and `netPnl` (report.ts lines 233-234). They are never absent.
- **Fix**: Update `BacktestRunSummary` to make `totalCommissions` and `netPnl` required fields. Remove the `?? 0` and `?? summary.totalPnl` fallbacks.

### [FALLBACK] backtests/[id]/page.tsx:381 — summary.profitFactor ?? 0

- **Consumer**: `(summary.profitFactor >= PROFIT_FACTOR_INF ? 99.99 : (summary.profitFactor ?? 0)).toFixed(2)`
- **API endpoint**: GET /backtests/:id
- **API actually returns**: `profitFactor` is always present in `BacktestRunSummary` (required `number` field).
- **Fix**: Remove the `?? 0` — `profitFactor` is never null/undefined on a non-null summary.

### [FALLBACK] backtests/[id]/page.tsx:389 — run.summary?.tradedMessages ?? 0 reaches into stale DB row

- **Consumer**: `totalMessages={run.summary?.tradedMessages ?? 0}`
- **API endpoint**: GET /backtests/:id
- **API actually returns**: The response has both `run.summary` (DB-stored, may be null for in-progress runs) and top-level `summary` (computed, with `tradedMessages: 0` hardcoded). Neither reliably gives the total message count mid-run.
- **Fix**: The API should provide `totalMessages` as a dedicated top-level field (derived from the decision count or stored summary). Consumer should not reach into `run.summary` to find it.

### [FALLBACK] backtests/[id]/page.tsx:390 — config.agentModel ?? 'default'

- **Consumer**: `agentModel={config.agentModel ?? 'default'}`
- **API endpoint**: GET /backtests/:id
- **API actually returns**: `config.agentModel` is `string | undefined` per `BacktestRunConfig`.
- **Fix**: Same root cause as the line 352 finding — make `agentModel` required in `BacktestRunConfig` or normalize in the API.

### [FALLBACK] backtests/[id]/rolling-win-rate.tsx:14 — windowSize fallback hides API guarantee

- **Consumer**: `const windowSize = data[0]?.windowSize ?? 5`
- **API endpoint**: GET /backtests/:id (via `computeFromTrades` -> `rollingWinRate`)
- **API actually returns**: `windowSize` is always present on every point (set in `computeFromTrades` line 1643)
- **Fix**: Once the type is corrected to make `windowSize` required (see existing SHAPE_MISMATCH finding for this type), remove the `?? 5` fallback.

### [FALLBACK] backtests/[id]/drawdown-chart.tsx:8 — drawdown ?? 0 fallback

- **Consumer**: `data.map((pt) => ({ date: pt.date, drawdown: -(pt.drawdown ?? 0) }))`
- **API endpoint**: GET /backtests/:id (via `computeFromTrades` -> `equityCurve`)
- **API actually returns**: `drawdown` is always set on every `EquityPoint` (report.ts line 223: `drawdown: dd`). The `EquityPoint` type marks it optional (`drawdown?: number`) but the API always sends it.
- **Fix**: Fix the `EquityPoint` type to make `drawdown` required, then remove the `?? 0` fallback.

### [FALLBACK] backtests/[id]/drawdown-chart.tsx:12 — drawdown ?? 0 guard

- **Consumer**: `if (!data.some((d) => (d.drawdown ?? 0) > 0)) return null`
- **API endpoint**: GET /backtests/:id
- **API actually returns**: Same as above — `drawdown` is always present.
- **Fix**: Same root cause. Remove `?? 0` once `EquityPoint.drawdown` is made required.

### [FALLBACK] backtests/backtest-list.tsx:195 — equityCurve sparkline ?? []

- **Consumer**: `const sparkData = equityCurve?.map((e) => e.cumPnl) ?? []`
- **API endpoint**: GET /backtests (returns raw `backtestRuns` rows)
- **API actually returns**: `equityCurve` is `EquityPoint[] | null` on the DB row.
- **Fix**: The `/backtests` endpoint should map `null` equity curves to `[]` before returning so consumers trust the array directly.

### [FALLBACK] backtests/backtest-list.tsx:199 — summary.totalCommissions ?? 0 and summary.netPnl ?? summary.totalPnl

- **Consumer**: `((summary.totalCommissions ?? 0) > 0 ? (summary.netPnl ?? summary.totalPnl) : summary.totalPnl)`
- **API endpoint**: GET /backtests
- **API actually returns**: `summary` is `BacktestRunSummary | null` on the DB row. When non-null, `totalCommissions` and `netPnl` are optional per the type but always present in practice.
- **Fix**: Make `totalCommissions` and `netPnl` required in `BacktestRunSummary`. Remove fallbacks.

### [FALLBACK] backtests/backtest-list.tsx:244-245 — config.agentModel ?? 'default'

- **Consumer**: `(config.agentModel ?? 'default').replace(...)`
- **API endpoint**: GET /backtests
- **API actually returns**: `config.agentModel` is `string | undefined` per `BacktestRunConfig`
- **Fix**: Make `agentModel` required in `BacktestRunConfig` or normalize in the API. Remove fallback.

### Backtests audit summary table

| # | Category | File | Line(s) | Severity |
|---|----------|------|---------|----------|
| 1 | UNTYPED_ANY | [id]/page.tsx | 138 | High |
| 2 | UNTYPED_ANY | new/page.tsx | 22 | High |
| 3 | SHADOW_TRANSFORM | new/page.tsx | 30 | Low |
| 4 | FALLBACK | [id]/page.tsx | 99 | Medium |
| 5 | FALLBACK | [id]/page.tsx | 184 | Low |
| 6 | FALLBACK | [id]/page.tsx | 352 | Medium |
| 7 | FALLBACK | [id]/page.tsx | 354 | Low |
| 8 | FALLBACK | [id]/page.tsx | 367 | Medium |
| 9 | FALLBACK | [id]/page.tsx | 369-370 | Medium |
| 10 | FALLBACK | [id]/page.tsx | 381 | Low |
| 11 | FALLBACK | [id]/page.tsx | 389 | Medium |
| 12 | FALLBACK | [id]/page.tsx | 390 | Medium |
| 13 | FALLBACK | [id]/rolling-win-rate.tsx | 14 | Low |
| 14 | FALLBACK | [id]/drawdown-chart.tsx | 8 | Low |
| 15 | FALLBACK | [id]/drawdown-chart.tsx | 12 | Low |
| 16 | FALLBACK | backtest-list.tsx | 195 | Low |
| 17 | FALLBACK | backtest-list.tsx | 199 | Medium |
| 18 | FALLBACK | backtest-list.tsx | 244-245 | Medium |

Note: SHAPE_MISMATCH findings for `TradeScatterPoint` and `RollingWinRatePoint` types were already documented above (lines 265-281).

**Root causes** (fix these and many violations disappear):
1. `BacktestRunSummary.totalCommissions` and `netPnl` should be required -- fixes #9, #17
2. `BacktestRunConfig.agentModel`, `agentProvider` should be required -- fixes #6, #12, #18
3. `EquityPoint.drawdown` should be required -- fixes #14, #15
4. Define a typed response for GET /backtests/:id -- fixes #1
5. API should normalize optional config fields instead of passing `undefined` through
