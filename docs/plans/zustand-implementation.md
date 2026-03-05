# Zustand Store Migration — Implementation Notes

## What I've Read

Every file in the migration surface has been read and analyzed:

### Trades Path
- `web/app/trades/page.tsx` — server component, fetches trades/events/commissions, renders TradesTableClient
- `web/app/components/trades-table-client.tsx` — URL-driven selection via `useSearchParams`, passes 7+ props to TradeRow
- `web/app/components/trade-row.tsx` — 8 props, all computed locally (pnl, flags, slippage)
- `web/app/components/trade-detail-panel.tsx` — 4 props, loads TradeStory via server action + useTransition
- `web/app/components/decision-timeline.tsx` — 5 props (decisions, tradeEvents, closeMessageId, messages, tradePnl)
- `web/app/components/snapshot-detail.tsx` — pure presentational, no state (no changes needed)
- `web/app/components/event-sub-rows.tsx` — pure presentational (no changes needed)
- `web/app/trades/actions.ts` — server actions: `fetchTradeStory`, types: `TradeStory`, `TimelineMessage`
- `web/app/backtests/[id]/backtest-trades-table.tsx` — bridges TradeFilterProvider → TradesTableClient
- `web/app/backtests/[id]/page.tsx` — huge server component, wraps trades in TradeFilterProvider
- `web/app/components/trade-filters.tsx` — TradeFilterProvider context (client-side filtering for backtests)

### Chat Path
- `web/app/messages/page.tsx` — server component, loads chat data, renders ChatRoom
- `web/app/messages/chat-room.tsx` — 8 useState + 2 useTransition, 7 props, all chat state lives here
- `web/app/messages/chat-feed.tsx` — ~14 props, reusable (used by ChatRoom, RelatedMessagesPanel, ChatPreview)
- `web/app/messages/chat-filters.tsx` — 5 props (authors, filters, onFilterChange, constraints, decisionSummary)
- `web/app/messages/related-messages-panel.tsx` — 4 props (sourceMessage, context, isLoading, onClose)
- `web/app/messages/chat-preview.tsx` — standalone component, own state (not migrating)
- `web/app/messages/load-chat-data.ts` — server-side data loader
- `web/app/messages/actions.ts` — server actions: fetchMessages, fetchRelatedMessages, types

### Run Scope Path
- `web/app/components/run-scope-provider.tsx` — React Context, URL-driven runId, polls /api/status every 5s
- `web/app/components/top-bar.tsx` — reads useRunScope(): runId, runBrief, status, selectRun
- `web/app/components/run-scope-selector.tsx` — reads useRunScope(): runId, runBrief, selectRun
- `web/app/components/sidebar.tsx` — reads useRunScope(): runId only
- `web/app/layout.tsx` — wraps entire app in RunScopeProvider
- `web/lib/run-scope.ts` — pure utils: buildHref(), isRunScopedPath()

---

## Store Designs

### 1. trades-store.ts

```ts
import { create } from 'zustand'

type TradesHydration = {
  trades: Trade[]
  eventsByTradeId: Map<string, TradeEvent[]>
  cancelledTradeIds: Set<string>
  commissionSchedule: CommissionSchedule | null
  startingEquity: number | null
  runId: string | null
}

interface TradesState {
  // Hydrated data
  trades: Trade[]
  eventsByTradeId: Map<string, TradeEvent[]>
  cancelledTradeIds: Set<string>
  commissionSchedule: CommissionSchedule | null
  startingEquity: number | null
  runId: string | null

  // Client state
  selectedTradeId: string | null
  story: TradeStory | null
  isLoadingStory: boolean

  // Actions
  hydrate: (data: TradesHydration) => void
  selectTrade: (id: string | null) => void
  loadTradeStory: (tradeId: string) => Promise<void>
}
```

**Key decisions:**
- `eventsByTradeId` stays as Map (zustand is in-memory, no serialization needed)
- `cancelledTradeIds` stays as Set
- `selectedTradeId` managed by store, but URL sync handled by TradesTableClient (keeps useSearchParams/useRouter there)
- `loadTradeStory` calls the existing `fetchTradeStory` server action directly
- Store replaces: TradesTableClient's prop reception, TradeDetailPanel's useState+useTransition

**URL sync approach:** TradesTableClient reads `?trade=` from URL via useSearchParams, calls `store.selectTrade(id)` to sync. Store triggers story load. URL writing stays in TradesTableClient via useRouter.

### 2. chat-store.ts

```ts
interface ChatState {
  // Hydrated data
  messages: Message[]
  labels: Record<string, MessageLabel>
  enrichment: Record<string, MessageEnrichment>
  cursor: string | null
  authors: string[]
  constraints: FilterConstraints | undefined
  stableDecisionCounts: StableDecisionCounts | undefined

  // Client state
  firstItemIndex: number
  filters: MessageFilters
  selectedMessage: Message | null
  relatedContext: RelatedContext | null
  isLoadingOlder: boolean
  isLoadingRelated: boolean

  // Actions
  hydrate: (data: ChatHydration) => void
  mergeNewMessages: (msgs: Message[], labels, enrichment) => void
  setFilters: (filters: MessageFilters) => void
  loadOlderMessages: () => Promise<void>
  selectMessage: (msg: Message | null) => void
}
```

**Key decisions:**
- All 8 useState + 2 useTransition from ChatRoom move into the store
- `useTransition` replaced with boolean flags (isLoadingOlder, isLoadingRelated)
- Filter change → store action calls `fetchMessages` server action, replaces state
- Load older → store action calls `fetchMessages` with cursor, prepends
- Message click → store action toggles selection, calls `fetchRelatedMessages`
- URL sync (filters → URL params) stays in ChatRoom as a thin useEffect
- `mergeNewMessages` handles AutoRefresh: checks if filters active, skips if so
- ChatFeed stays props-driven (reusable component used in 3 contexts)
- ChatFilters reads from store directly (0 props)
- RelatedMessagesPanel reads from store directly (1 prop: onClose)

### 3. run-store.ts

```ts
interface RunState {
  runId: string | null
  status: StatusData | null
  runBrief: RunBrief | null

  // Internal
  _intervalId: ReturnType<typeof setInterval> | null

  // Actions
  setRunId: (id: string | null) => void
  setStatus: (status: StatusData | null) => void
  startPolling: () => void
  stopPolling: () => void
  selectRun: (id: string | null) => void // needs router, handled by component
}
```

**Key decisions:**
- RunScopeProvider's React Context is deleted
- A thin `RunStoreSync` component replaces it in layout.tsx:
  - Reads `?run=` from useSearchParams → pushes to store via `setRunId`
  - Starts/stops polling via useEffect
  - Provides `selectRun` behavior (URL manipulation via useRouter)
- All consumers switch from `useRunScope()` to `useRunStore(s => s.xxx)`
- Polling logic moves to store actions (fetch /api/status, call setStatus)
- `selectRun` still needs useRouter/usePathname — handled by RunStoreSync exposing it, or by a separate hook

---

## Hydration Strategy

### TradesHydrator (`web/app/trades/trades-hydrator.tsx`)
```tsx
'use client'
export function TradesHydrator({ data }: { data: TradesHydration }) {
  const hydrate = useTradesStore(s => s.hydrate)
  const hydratedRef = useRef(false)

  // Hydrate once on mount, and when data identity changes
  if (!hydratedRef.current) {
    hydrate(data)  // sync hydration before first render
    hydratedRef.current = true
  }

  useEffect(() => { hydrate(data) }, [data]) // re-hydrate on server refresh
  return null
}
```

Used in:
- `/trades/page.tsx` — renders `<TradesHydrator data={...} />` alongside `<TradesTableClient />`
- `/backtests/[id]/backtest-trades-table.tsx` — hydrates with filtered trades from TradeFilterProvider

### ChatHydrator (`web/app/messages/chat-hydrator.tsx`)
```tsx
'use client'
export function ChatHydrator({ data }: { data: ChatHydration }) {
  const hydrate = useChatStore(s => s.hydrate)
  const mergeNew = useChatStore(s => s.mergeNewMessages)
  const hasHydrated = useRef(false)

  if (!hasHydrated.current) {
    hydrate(data)
    hasHydrated.current = true
  }

  // On AutoRefresh re-render, merge new messages
  useEffect(() => {
    if (hasHydrated.current) mergeNew(data.messages, data.labels, data.enrichment)
  }, [data.messages])

  return null
}
```

### RunStoreSync (`web/app/components/run-store-sync.tsx`)
Replaces RunScopeProvider. Reads URL, syncs to store, manages polling.

---

## Component Changes

### TradesTableClient (trades-table-client.tsx)
**Before:** 6 props → manages URL selection state, passes 7+ props to TradeRow, 3 props to TradeDetailPanel
**After:** 0 props → reads trades/events from store, syncs URL ↔ store.selectedTradeId

```tsx
export function TradesTableClient() {
  const trades = useTradesStore(s => s.trades)
  const eventsByTradeId = useTradesStore(s => s.eventsByTradeId)
  const cancelledTradeIds = useTradesStore(s => s.cancelledTradeIds)
  const selectedTradeId = useTradesStore(s => s.selectedTradeId)
  const selectTrade = useTradesStore(s => s.selectTrade)

  // URL sync
  const searchParams = useSearchParams()
  const router = useRouter()
  const urlTradeId = searchParams.get('trade')

  useEffect(() => {
    if (urlTradeId !== selectedTradeId) selectTrade(urlTradeId)
  }, [urlTradeId])

  const setSelectedId = (id: string | null) => {
    selectTrade(id)
    // update URL
    const params = new URLSearchParams(searchParams.toString())
    if (id) params.set('trade', id)
    else params.delete('trade')
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  // render: TradeRow gets just tradeId, TradeDetailPanel gets just onClose
}
```

### TradeRow (trade-row.tsx)
**Before:** 8 props (trade, events, cancelledClose, runId, commissionSchedule, startingEquity, onExpand, isExpanded)
**After:** 3 props (tradeId, onExpand, isExpanded) — reads everything else from store

```tsx
export function TradeRow({ tradeId, onExpand, isExpanded }: {
  tradeId: string; onExpand?: () => void; isExpanded?: boolean
}) {
  const trade = useTradesStore(s => s.trades.find(t => t.id === tradeId))!
  const events = useTradesStore(s => s.eventsByTradeId.get(tradeId) ?? [])
  const cancelledClose = useTradesStore(s => s.cancelledTradeIds.has(tradeId))
  const runId = useTradesStore(s => s.runId)
  const commissionSchedule = useTradesStore(s => s.commissionSchedule)
  const startingEquity = useTradesStore(s => s.startingEquity)
  // ... rest unchanged
}
```

Note: `onExpand` and `isExpanded` stay as props because they're per-row callbacks from the parent's selection logic. Could be derived from store selectedTradeId but keeping as props is cleaner for the click handler.

### TradeDetailPanel (trade-detail-panel.tsx)
**Before:** 4 props (trade, runId, commissionSchedule, onClose)
**After:** 1 prop (onClose) — reads trade/story from store

```tsx
export function TradeDetailPanel({ onClose }: { onClose: () => void }) {
  const trade = useTradesStore(s => {
    const id = s.selectedTradeId
    return id ? s.trades.find(t => t.id === id) ?? null : null
  })
  const story = useTradesStore(s => s.story)
  const isLoading = useTradesStore(s => s.isLoadingStory)
  // No more useState, no more useTransition, no more useEffect to load story
  // Story loading is triggered by store.selectTrade()
}
```

### UnifiedTimeline (decision-timeline.tsx)
**Before:** 5 props (decisions, tradeEvents, closeMessageId, messages, tradePnl)
**After:** 0 props — reads from store.story

```tsx
export function UnifiedTimeline() {
  const story = useTradesStore(s => s.story)
  if (!story) return null
  const { decisions, events: tradeEvents, trade, timelineMessages } = story
  // ... rest unchanged, just reads from story instead of props
}
```

### ChatRoom (chat-room.tsx)
**Before:** 7 props, 8 useState, 2 useTransition
**After:** 0 props, 0 useState — thin layout shell reading from store

```tsx
export function ChatRoom() {
  const messages = useChatStore(s => s.messages)
  const labels = useChatStore(s => s.labels)
  const enrichment = useChatStore(s => s.enrichment)
  const selectedMessage = useChatStore(s => s.selectedMessage)
  const selectMessage = useChatStore(s => s.selectMessage)
  const constraints = useChatStore(s => s.constraints)
  // ... reads all state from store, passes to ChatFeed as props (ChatFeed stays reusable)

  // URL sync effect stays here (thin)
}
```

### ChatFilters (chat-filters.tsx)
**Before:** 5 props
**After:** 0 props — reads from store

### RelatedMessagesPanel (related-messages-panel.tsx)
**Before:** 4 props (sourceMessage, context, isLoading, onClose)
**After:** 1 prop (onClose) — reads sourceMessage + context from store

### TopBar, RunScopeSelector, Sidebar
- Replace `useRunScope()` with `useRunStore(s => s.xxx)`
- `selectRun` needs special handling (URL manipulation) — exposed by RunStoreSync or a helper hook

---

## Backtest Path Handling

The backtest page (`/backtests/[id]/page.tsx`) uses TradeFilterProvider for client-side filtering. Two options:

**Option A (simpler, chosen):** Keep TradeFilterProvider as-is. BacktestTradesTable hydrates the trades store with the *filtered* trades from the provider. When filters change, re-hydrate.

```tsx
// BacktestTradesTable
export function BacktestTradesTable({ eventsByTradeId, ... }) {
  const { filteredTrades } = useTradeFilters()
  const hydrate = useTradesStore(s => s.hydrate)

  useEffect(() => {
    hydrate({ trades: filteredTrades, eventsByTradeId, ... })
  }, [filteredTrades, eventsByTradeId, ...])

  return <TradesTableClient />  // now 0 props
}
```

**Option B (future):** Fold filtering into the trades store. Delete TradeFilterProvider.

---

## File Creation/Modification Summary

### New Files (5)
1. `web/stores/trades-store.ts`
2. `web/stores/chat-store.ts`
3. `web/stores/run-store.ts`
4. `web/app/trades/trades-hydrator.tsx`
5. `web/app/messages/chat-hydrator.tsx`

### Modified Files (14)
1. `web/app/trades/page.tsx` — add TradesHydrator, simplify TradesTableClient usage
2. `web/app/components/trades-table-client.tsx` — 0 props, read from store
3. `web/app/components/trade-row.tsx` — tradeId + onExpand + isExpanded props only
4. `web/app/components/trade-detail-panel.tsx` — onClose prop only, read from store
5. `web/app/components/decision-timeline.tsx` — 0 props, read from store.story
6. `web/app/backtests/[id]/backtest-trades-table.tsx` — hydrate store, render TradesTableClient
7. `web/app/messages/page.tsx` — add ChatHydrator
8. `web/app/messages/chat-room.tsx` — thin shell, read from store
9. `web/app/messages/chat-filters.tsx` — 0 props, read from store
10. `web/app/messages/related-messages-panel.tsx` — 1 prop (onClose)
11. `web/app/components/run-scope-provider.tsx` — rewrite as run-store-sync (or delete + new file)
12. `web/app/components/top-bar.tsx` — useRunStore instead of useRunScope
13. `web/app/components/run-scope-selector.tsx` — useRunStore instead of useRunScope
14. `web/app/components/sidebar.tsx` — useRunStore instead of useRunScope
15. `web/app/layout.tsx` — RunStoreSync instead of RunScopeProvider

### Deleted Files (0-1)
- `web/app/components/run-scope-provider.tsx` may be deleted if RunStoreSync is a new file

### Unchanged Files
- `web/app/components/snapshot-detail.tsx` — pure presentational
- `web/app/components/event-sub-rows.tsx` — pure presentational
- `web/app/messages/chat-feed.tsx` — stays props-driven (reusable)
- `web/app/messages/chat-preview.tsx` — standalone, own state
- `web/app/messages/actions.ts` — server actions unchanged
- `web/app/trades/actions.ts` — server actions unchanged
- `web/lib/run-scope.ts` — pure utils unchanged
- `web/lib/queries.ts` — DB queries unchanged

---

## Execution Order

**Batch 1** (parallel): Create 3 store files + 2 hydrators (5 writes)
**Batch 2** (parallel): Refactor all consumer components (14 edits)
**Batch 3**: Verify TypeScript compiles, fix any issues
