# Zustand Store Migration Plan

## Problem
Frontend components have convoluted prop drilling and scattered `useState` calls.
`TradesTableClient` passes 7 props to `TradeRow`. `TradeDetailPanel` loads data then drills it into 4 sub-components.
`ChatRoom` has 8 `useState` + 2 `useTransition`. `RunScopeProvider` wraps the entire app in Context for one piece of state.

**Goal**: Replace prop drilling and local state explosion with 3 Zustand stores. Drastically simplify component props — most components go from 5-7 props to 0-1 (just an ID or nothing).

## Store Architecture

```
web/stores/
  run-store.ts      ← replaces RunScopeProvider (runId, status, runBrief, polling)
  trades-store.ts   ← replaces TradesTableClient state + TradeDetailPanel loading
  chat-store.ts     ← replaces ChatRoom's 8 useState calls
```

### trades-store.ts
```ts
interface TradesState {
  trades: Trade[]
  eventsByTradeId: Record<string, TradeEvent[]>
  commissionSchedule: CommissionSchedule | null
  selectedTradeId: string | null
  tradeStory: TradeStory | null
  isLoadingStory: boolean
}

interface TradesActions {
  selectTrade: (id: string | null) => void
  loadTradeStory: (tradeId: string) => Promise<void>
  setTrades: (trades: Trade[], events: Record<string, TradeEvent[]>) => void
  setCommissionSchedule: (cs: CommissionSchedule | null) => void
}
```

### chat-store.ts
```ts
interface ChatState {
  messages: Message[]
  labels: Record<string, MessageLabel>
  enrichment: Record<string, MessageEnrichment>
  cursor: string | null
  filters: FilterConstraints
  selectedMessage: Message | null
  relatedContext: RelatedContext | null
  isLoadingRelated: boolean
  isLoadingOlder: boolean
}

interface ChatActions {
  loadOlderMessages: () => Promise<void>
  applyFilters: (filters: FilterConstraints) => Promise<void>
  selectMessage: (msg: Message | null) => Promise<void>
  mergeNewMessages: (msgs: Message[]) => void
}
```

### run-store.ts
```ts
interface RunState {
  runId: string | null
  status: StatusData | null
  runBrief: RunBrief | null
}

interface RunActions {
  selectRun: (id: string | null) => void
  refreshStatus: () => Promise<void>
}
```

## Type Strategy

### Types that ADD rails
- **Store state + action interfaces** — the contract between store and component
- **Hydration types** — one type per store defining the server → client boundary shape
- **Selector return types** — narrow views for what each component actually reads

### Types to NOT create
- Wrapper types around DB types "for the frontend" (Trade is already typed)
- Generic `StoreSlice<T>` utilities (hides meaningful differences between stores)
- Over-granular prop types composed from 6 tiny interfaces

### Rule
DB types (`Trade`, `Message`, etc.) flow forward unchanged. View types (`TradeStory`, `MessageEnrichment`) stay defined at the transform boundary (`actions.ts`). Store types define the mutation surface. No type exists without a consumer.

## Server → Store Hydration Pattern

Each store needs a hydration seam since data is fetched server-side:

```tsx
// web/app/trades/hydrate.tsx (client component)
'use client'
type TradesHydration = {
  trades: Trade[]
  eventsByTradeId: Record<string, TradeEvent[]>
  commissionSchedule: CommissionSchedule | null
}

export function TradesHydrator({ data }: { data: TradesHydration }) {
  const setTrades = useTradesStore(s => s.setTrades)
  useEffect(() => {
    setTrades(data.trades, data.eventsByTradeId)
  }, [data])
  return null
}
```

Server page renders `<TradesHydrator data={...} />` alongside components. Components read from store, never from props.

## Tasks

### Phase 1: Trades Store (biggest win)

- [ ] Install zustand
- [ ] Create `web/stores/trades-store.ts`
- [ ] Create `web/app/trades/trades-hydrator.tsx` — server→store bridge
- [ ] Refactor `TradesTableClient` — remove all state, read from store
- [ ] Refactor `TradeRow` — props collapse to `{ tradeId: string }`, reads from store
- [ ] Refactor `TradeDetailPanel` — reads story from store, no prop drilling to sub-components
- [ ] Refactor `UnifiedTimeline` — reads from store directly (decisions, events, messages)
- [ ] Delete `TradeFilterProvider` if filters fold into trades store
- [ ] Verify URL selection sync (selectedTradeId ↔ URL param)

### Phase 2: Chat Store

- [ ] Create `web/stores/chat-store.ts`
- [ ] Create `web/app/messages/chat-hydrator.tsx`
- [ ] Refactor `ChatRoom` — delete 8 useState, 2 useTransition; becomes thin shell
- [ ] Refactor `ChatFeed` — reads messages from store
- [ ] Refactor `RelatedMessagesPanel` — reads selected + context from store
- [ ] Refactor `ChatFilters` — reads/writes filters from store

### Phase 3: Run Store

- [ ] Create `web/stores/run-store.ts` with polling logic
- [ ] Delete `RunScopeProvider` and its Context
- [ ] Update `TopBar` — reads from `useRunStore()`
- [ ] Update `RunScopeSelector` — calls `useRunStore(s => s.selectRun)`
- [ ] Update all `buildHref()` call sites — read runId from store
- [ ] Verify polling lifecycle (start/stop on mount/unmount)

### Phase 4: Cleanup

- [ ] Delete dead prop interfaces that no longer have consumers
- [ ] Audit for any remaining prop drilling chains
- [ ] Verify no regressions in URL-based navigation (run scoping, trade selection)

## Component Prop Changes

| Component | Before | After |
|-----------|--------|-------|
| `TradeRow` | `trade, events, runId, commissionSchedule, onExpand, isExpanded` (7) | `tradeId` (1) |
| `TradeDetailPanel` | `trade, runId, commissionSchedule, onClose` (4) | `onClose` (1) |
| `UnifiedTimeline` | `decisions, tradeEvents, closeMessageId, messages, tradePnl` (5) | none (0) |
| `ChatRoom` | `initialMessages, initialLabels, initialEnrichment, ...` (6+) | none (0, hydrated) |
| `RelatedMessagesPanel` | `sourceMessage, context, isLoading, onClose` (4) | `onClose` (1) |
| `TopBar` | reads from `useRunScope()` context | reads from `useRunStore()` |
