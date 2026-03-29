# Web App Structure & Patterns

Rules for the `web/` frontend. Follow mechanically — no judgment calls.

## Target layout

```
web/
  index.html
  vite.config.ts, tsconfig.json, components.json, package.json
  src/
    main.tsx
    globals.css
    router.tsx
    components/         # shared components (2+ consumers across views)
      ui/               # shadcn — never hand-edit, CLI-managed
      charts/           # recharts wrappers used by 2+ views
      badge.tsx, spinner.tsx, metric-strip.tsx, ...
    views/              # one directory per route
      dashboard/
      backtests/
      messages/
      trades/
      traders/
      tasks/
      eval/
      reconciliation/
      settings/
    hooks/              # shared utility hooks (use-channel-id, use-scoped-href, use-sort, etc.)
    lib/
      api.ts            # fetch wrapper
      api-types.ts      # API response types
      queries.ts        # query option factories (replaces domain hooks)
      format.ts         # formatters
      utils.ts          # cn(), etc.
    stores/             # zustand stores (always shared)
```

---

## Placement rules

### 1. One consumer → colocate. Two consumers → promote.

Applies to everything: components, hooks, utils, types. If it has one consumer, it lives next to that consumer. The moment a second consumer in a different view appears, move it to the shared directory. The git diff makes the promotion visible. Don't preemptively share things.

### 2. Views never import from other views

If two views need the same thing, promote it to `components/`, `hooks/`, or `lib/`. Cross-view imports create invisible coupling.

### 3. Stores are always shared

Zustand stores live in `src/stores/`. If state needs a store (vs. useState), it's cross-cutting by definition.

### 4. Types live with their source

- API response types → `lib/api-types.ts`
- Shared Zod schemas → `lib/`
- Component prop types → inline in the component file
- View-specific types → colocated in the view directory
- No top-level `types/` directory

### 5. No barrel files

No `index.ts` re-exports. Import directly from the file. Barrels obscure usage, break tree-shaking intuition, and make grep harder.

### 6. When in doubt, leave it local

The cost of unnecessary sharing (unclear ownership, harder to delete) is higher than the cost of a future move (one git mv + import update).

### 7. `components/` stays flat

After colocation, ~25 shared components remain. The dependency graph is a web (badge imported by 10+, decision-shared by 5), not a tree. Subdirectories would create cross-folder imports harder to trace than flat siblings. The naming prefix (`trade-*`, `channel-scope-*`) clusters files in alphabetical sort. Don't add subdirectories until the flat list exceeds ~40 files.

**Exceptions:** `ui/` (shadcn, CLI-managed), `charts/` (zero deps on other shared components).

---

## Data fetching

### Query option factories — the pattern for all reads

All query configuration lives in `lib/queries.ts` as plain object factories. Components call `useQuery(queries.trades.list(channelId))` directly. No wrapper hooks around `useQuery`.

```ts
// lib/queries.ts
export const queries = {
  trades: {
    list: (channelId: string) => ({
      queryKey: ['trades', channelId] as const,
      queryFn: () => api<Trade[]>(`/trades?channel=${channelId}`),
      staleTime: 30_000,
    }),
    detail: (id: string) => ({
      queryKey: ['trade', id] as const,
      queryFn: () => api<Trade>(`/trades/${id}`),
      staleTime: 30_000,
    }),
  },
  backtests: {
    list: (channelId: string) => ({ ... }),
    detail: (id: string) => ({ ... }),
  },
  dashboard: (channelId: string) => ({ ... }),
};

// In a component — direct, no wrapper hook
const tradesQuery = useQuery(queries.trades.list(channelId));
```

**Why this, not wrapper hooks:** Query option factories are reusable across `useQuery`, `prefetchQuery`, `invalidateQueries`, and `ensureQueryData`. A wrapper hook can only be called inside a React component. The factory centralizes query keys and fetch config without adding a layer of indirection.

**When a hook IS justified:** When it wraps `useQuery` AND adds a `select` transform, combines multiple queries, or derives computed state beyond what the factory provides. The hook earns its abstraction by encapsulating logic, not just forwarding arguments.

### `useApiMutation` — the pattern for all writes

All mutations go through `useApiMutation` from `hooks/use-api-mutation.ts`. No raw `useMutation`, no `fetch` in event handlers.

```ts
const deleteTrade = useApiMutation('DELETE', (id: string) => `/trades/${id}`, {
  invalidate: [['trades']],
});
```

**Callback split:**
- **Hook-level `onSuccess`** (inside `useApiMutation` options): cache invalidation. Always fires, even if the component unmounts.
- **Call-site `onSuccess`** (inside `mutate(data, { onSuccess })`): toasts, redirects, closing modals. Does NOT fire if the component unmounts — which is correct.

**Use `mutate`, not `mutateAsync`.** `mutate` handles errors via callbacks. `mutateAsync` creates unhandled promise rejections unless you wrap in try/catch, which defeats the purpose.

**No optimistic updates.** This is an internal tool where data consistency matters more than perceived speed. Invalidate and refetch. If a specific interaction feels slow enough to warrant optimistic updates, add it case-by-case with full rollback logic.

---

## State rules

### What kind of state is this?

| If the data... | Use |
|----------------|-----|
| Comes from the API | `useQuery` with a query factory from `lib/queries.ts` |
| Is a UI toggle (modal, sidebar, tab) | `useState` in the owning component |
| Needs to survive route changes or page refresh | URL params (`useSearchParams`) |
| Is needed by unrelated components across routes | Zustand store |
| Is a form being edited | React Hook Form + Zod resolver |
| Can be computed from other state/props | Compute during render — no state at all |

### Decision ladder for UI state

1. Used by only this component → `useState`
2. Used by a direct child → pass as prop (this is not prop drilling, this is React)
3. Used by siblings → lift to closest common parent
4. Passing through 3+ intermediaries that don't use it → component composition first (pass `children` or render props to eliminate pass-through)
5. Composition doesn't work → Zustand (with selectors)
6. Rarely-changing dependency injection (theme, locale, auth) → Context

### React Query defaults

- **`staleTime: 30_000` (30s)** as the project default. Set per-factory in `lib/queries.ts`. Override to `Infinity` for data that doesn't change within a session. Override to `0` only for real-time views that must always refetch on mount.
- **`placeholderData: keepPreviousData`** on any query that supports filtering or pagination.
- **Don't copy query data into useState.** If you need editable state from query data, use React Hook Form initialized from query data with `staleTime: Infinity` on that query.

### Zustand vs Context

- **Context** = dependency injection for values that rarely change (theme, auth user). Every context change re-renders all consumers.
- **Zustand** = client state that changes in response to user actions. Selectors prevent unnecessary re-renders.
- **If you have 3+ state-related Contexts, switch to Zustand.**

---

## Component rules

### Sizing

- **200+ lines of JSX** (not imports/hooks) → split
- **A function inside the component that returns JSX** → extract to its own component immediately
- **3+ boolean state variables** → replace with a single status enum (`'idle' | 'sending' | 'sent'`)
- **Multiple `useState` that always update together** → `useReducer`
- **6+ props** → split the component or use composition
- **Passing a callback 3+ levels deep** → Zustand store

### When to extract a custom hook

- Stateful logic (state + effects + handlers) repeats across 2+ components
- The hook section of a component is longer than its JSX
- The hook wraps `useQuery` AND adds select/transform/combine logic

### When NOT to create a component

- Used exactly once and fewer than 50 lines → keep in the same file as its consumer
- Extracting it requires passing 8+ props to replicate parent context → not a natural boundary
- The "reusable" version needs `if/else` branches per consumer → too early. Wait for the third use case.

---

## Error handling

Three layers. No try/catch scattered in components.

| Layer | Handles | Mechanism |
|-------|---------|-----------|
| **Global** | Background refetch failures, telemetry | `QueryCache({ onError })` on QueryClient — fires once per failed request, shows toast via Sonner |
| **Route/section** | Render crashes, 5xx from data loads | `ErrorBoundary` wrapping each route section in `router.tsx` |
| **Local** | 4xx validation errors, form feedback | `error` from `useMutation`, rendered inline |

- `throwOnError: (err) => err.status >= 500` on queries. 4xx stays local. 5xx hits the boundary.
- Global toast fires only for background refetch failures when stale data is already displayed.
- Error handling in hooks causes double-toasts when the hook has multiple consumers. Don't do it.

---

## Loading states

Components never check `isLoading` or `isFetching`. They only write the success path.

**The pattern:** `QueryBoundary` wraps any query-dependent section. It handles pending (skeleton), error (retry card), and stale-while-revalidating (shows stale data, no skeleton flash).

```tsx
<QueryBoundary query={tradesQuery} skeleton={<TableSkeleton />}>
  {(trades) => <TradesTable data={trades} />}
</QueryBoundary>
```

**Multiple queries — separate if independent, combine if co-dependent:**

```tsx
// Metrics and trades can appear independently
<QueryBoundary query={metricsQuery} skeleton={<MetricStripSkeleton />}>
  {(metrics) => <MetricStrip data={metrics} />}
</QueryBoundary>
<QueryBoundary query={tradesQuery} skeleton={<TableSkeleton />}>
  {(trades) => <TradesTable data={trades} />}
</QueryBoundary>

// Page makes no sense without both
const combined = useCombinedQueries(metricsQuery, tradesQuery);
<QueryBoundary query={combined} skeleton={<DashboardSkeleton />}>
  {([metrics, trades]) => <Dashboard metrics={metrics} trades={trades} />}
</QueryBoundary>
```

- **One boundary per independently-loading region.**
- **Skeleton mirrors expected layout.** Compose from building blocks (`MetricStripSkeleton`, `TableSkeleton`, `ChartCardSkeleton`).
- **`staleTime: 30_000`** eliminates loading flashes on return navigation.
- **`placeholderData: keepPreviousData`** eliminates loading flashes on filter/pagination changes.

---

## Forms

React Hook Form + Zod resolver for any form with validation. No `useState` per field.

```tsx
const schema = z.object({ name: z.string().min(1), amount: z.number() });
const form = useForm({ resolver: zodResolver(schema), defaultValues: queryData });
```

Plain `useState` or URL params for search bars and filters only.

---

## Anti-patterns to block

Reject on sight. These are the patterns AI generates that accumulate into slop.

| Anti-pattern | Do this instead |
|---|---|
| `useEffect` that sets state from other state | Compute during render or in the event handler |
| `useEffect` → setState → `useEffect` chains | All state updates in the event handler |
| `useState` + `useEffect` + `fetch` | `useQuery` with a query factory |
| Custom hook that wraps a single `useQuery` | Query option factory in `lib/queries.ts` |
| `if (isLoading) return <Spinner />` in every component | `QueryBoundary` at the section level |
| `?? []`, `\|\| 'default'` on every property access | Trust the API contract. Validate at the boundary (Zod), not in consumers |
| Inline `new Intl.NumberFormat()` or date formatting | `lib/format.ts` — centralized formatters |
| Inline P&L color ternaries | `pnlColor()` from `lib/format.ts` |
| Component with 15+ props | Split into multiple components |
| `React.memo` everywhere "just in case" | Fix state placement first. Profile before memoizing |
| Prop drilling through 4+ levels | Composition (children as props), then Zustand |
| Storing server data in Zustand | TanStack Query owns server cache |
| Global state for filters/sort/pagination | URL params (`useSearchParams`) |
| Per-component try/catch on mutations | Global `MutationCache({ onError })` + call-site callbacks |
| Form with 5+ `useState` for fields | React Hook Form + Zod resolver |
| `useEffect` to reset state when a prop changes | `key={prop}` to remount the component |
| Raw `useMutation` | `useApiMutation` — it handles serialization and invalidation |
| `mutateAsync` | `mutate` with callbacks |

---

## useEffect — when to use it

**Do NOT use for:**

| Pattern | Do this instead |
|---------|----------------|
| Deriving values from props/state | Compute during render |
| Expensive derived computations | `useMemo` |
| Resetting state when a prop changes | `key={prop}` to remount |
| Responding to user events | Logic in the event handler |
| Chaining state updates | Compute all next state in the event handler |
| Notifying parent of state change | Call parent callback in the handler alongside `setState` |
| One-time app initialization | Module-level code outside the component |

**DO use for:** synchronizing with external systems (browser APIs, WebSocket subscriptions, third-party widgets).

---

## Migration steps

### Phase 1: Create `src/` and move source (atomic with phase 2)

1. Create `web/src/`
2. Move `web/app/main.tsx`, `web/app/globals.css`, `web/app/router.tsx` → `web/src/`
3. Move `web/app/components/` → `web/src/components/`
4. Move `web/components/ui/` → `web/src/components/ui/`
5. Move `web/hooks/` → `web/src/hooks/`
6. Move `web/lib/` → `web/src/lib/`
7. Move `web/stores/` → `web/src/stores/`
8. Move route directories: `web/app/{route}/` → `web/src/views/{route}/`
9. Move `web/app/page.tsx` → `web/src/views/dashboard/page.tsx`
10. Consolidate `web/src/eval/schema.ts` → `web/src/views/eval/schema.ts`
11. Delete empty `web/app/`, `web/components/`

### Phase 2: Update config (same commit as phase 1)

**`web/index.html`:**
```html
<script type="module" src="./src/main.tsx"></script>
```

**`web/vite.config.ts`:**
```ts
alias: {
  '@': path.resolve(__dirname, 'src'),       // frontend: web/src/
  '@src': path.resolve(__dirname, '../src'),  // backend: src/ (for shared types/schemas)
}
```

Two aliases because two source trees. `@` is the frontend. `@src` reaches into the backend for shared types like `@src/db/schema`.

**`web/tsconfig.json`:**
```json
"paths": {
  "@/*": ["./src/*"],
  "@src/*": ["../src/*"]
}
```

**`web/components.json`** — aliases unchanged (`@/components`, `@/lib`, etc. now resolve into `src/`).

### Phase 3: Convert domain hooks to query factories

Replace `hooks/use-trades.ts`, `hooks/use-backtests.ts`, `hooks/use-tasks.ts`, `hooks/use-dashboard.ts`, `hooks/use-trader-detail.ts`, `hooks/use-recon-alerts.ts`, `hooks/use-backtest-detail.ts` with query option factories in `lib/queries.ts`. Update all consumers to `useQuery(queries.trades.list(channelId))`.

Keep utility hooks in `hooks/`: `use-api-mutation`, `use-channel-id`, `use-scoped-href`, `use-filter-params`, `use-sort`, `use-search-param`, `use-mobile`, `use-infinite-list`.

### Phase 4: Colocate single-use components

Move ~15 single-use components from `src/components/` to their view directories. Move ~4 single-use chart components to their views. Delete `scroll-sentinel.tsx` (dead code).

### Phase 5: Verify

- `npx tsc --noEmit && npm --prefix web run check`
- `npx shadcn@latest add` installs to `src/components/ui/`
- All pages render via Playwright

## Risk notes

- **`@` alias is the blast radius.** Every `@/` import resolves differently after it moves from `web/` to `web/src/`. Safe because files move with the alias, but phases 1+2 must be atomic.
- **shadcn CLI.** Verify `npx shadcn@latest add <component>` installs to `src/components/ui/` after config change.
- **`@src` alias unchanged.** Backend cross-imports (`@src/db/schema`) unaffected.
- **Phases 1+2 in one commit.** Phase 3 (query factories) can be a separate commit. Phase 4 (colocation) can be another.
