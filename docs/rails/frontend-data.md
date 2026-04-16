# Frontend Data Rails

How data flows from API to component to user interaction. Every list, table, and filter in the app follows these patterns.

## API Contracts

List endpoints use different pagination strategies depending on dataset size.

### Cursor-paginated endpoints (return `CursorResponse<T>`)

These endpoints accept `?cursor=<opaque>&limit=50&sort=<col>&dir=desc` and return:

```ts
type CursorResponse<T> = {
  rows: T[];
  nextCursor: string | null;  // opaque cursor for next page, null = no more
  total?: number;              // total count (for "showing X of Y")
};
```

| Endpoint | Sort columns | Notes |
|----------|-------------|-------|
| `/trades` | `openedAt`, `closedAt`, `symbol`, `trader`, `pnl` | Also returns `flags` |
| `/tasks` | `createdAt`, `completedAt`, `status` | |
| `/backtest-runs` | `createdAt`, `completedAt`, `status` | |
| `/messages` (enriched path, with `channel`) | cursor-based | Cursor is the last message timestamp |
| `/messages` (standard path, no `channel`) | cursor-based | Cursor is the last message timestamp |

For `/trades`, `/tasks`, and `/backtest-runs`, the cursor is a base64-encoded `sortValue:id` pair. For `/messages`, the cursor is the last message's raw timestamp. The frontend never decodes cursors.

### Offset/limit endpoints (return arrays or `{ rows, total, offset, limit }`)

| Endpoint | Notes |
|----------|-------|
| `/backtests` | Raw array of runs. `?limit=50&offset=0` |
| `/recon-alerts` | Raw array. `?limit=100&offset=0&resolved=true` |
| `/eval` | Returns `{ discrepancies, verdictSummary, ... }`. `?limit=200&offset=0` |
| `/eval/labels` | Returns `{ rows, total, offset, limit }`. `?limit=500&offset=0` |
| `/eval/review` | Returns `{ rows, total, offset, limit, stats }`. `?limit=500&offset=0` |

### Unpaginated endpoints (small bounded lists)

| Endpoint | Returns |
|----------|---------|
| `/tracked-traders` | All tracked traders (raw array) |
| `/signals` | Recent signals with optional `?limit=20` (raw array) |
| `/backtests/tags` | Distinct experiment tags (raw array) |

## Filter & Sort State: `createFilterParams`

Filter and sort state lives in URL search params via the `createFilterParams` factory. URL is the source of truth. React Router stays in the loop. Back button works. Views are bookmarkable.

### How it works

`createFilterParams` is called at module level to define a page's filter shape. It returns a hook.

```ts
// hooks/use-backtest-list-params.ts
import { createFilterParams } from './use-filter-params';

export const useBacktestListParams = createFilterParams({
  sort: { type: 'sort', defaultColumn: 'createdAt', defaultDir: 'desc' },
  tag: { type: 'string' },
});
```

Inside components, the returned hook provides typed values, setters, and utilities:

```ts
const { sort, tag, setSort, setTag, hasFilters, clearFilters, toParams } = useBacktestListParams();
```

### Supported param types

| Type | URL encoding | Value type |
|------|-------------|------------|
| `string` | `?key=value` | `string` |
| `boolean` | `?key=1` or `?key=0` | `boolean` |
| `string[]` | `?key=a,b,c` | `string[]` |
| `sort` | `?sort=column&dir=desc` | `{ column: string; dir: 'asc' \| 'desc' }` |

The `sort` type uses the shared URL keys `sort` and `dir`. Only one sort param per page. When the value equals the default, the URL key is omitted (clean URLs).

### Setter behavior

Each param `foo` gets a setter `setFoo`. For `sort` type, the setter accepts a column name and toggles direction if the same column is clicked again. For other types, passing `null` resets to the default.

### Existing `createFilterParams` instances

| Hook | File | Params |
|------|------|--------|
| `useBacktestListParams` | `hooks/use-backtest-list-params.ts` | `sort`, `tag` |
| `useTaskListParams` | `hooks/use-task-list-params.ts` | `sort`, `status` |
| `useChatFilterParams` | `hooks/use-chat-filter-params.ts` | `authors`, `start`, `end`, `signals`, `label`, `role` |
| `useEvalReviewParams` | `hooks/use-eval-review-params.ts` | `sort`, `source`, `verified`, `confidence` |
| `useReconParams` | `hooks/use-recon-params.ts` | `filter` |
| `useTradeFilterParams` | `components/trade-filters.tsx` | `traders`, `symbols`, `strategies`, `directions`, `flags` (all `string[]`) |
| `useTradeSortParams` | `components/trades-table-client.tsx` | `sort` (inline, not a separate file) |

### When to use Zustand instead

Zustand stores (`stores/`) are for cross-component state that does not belong in the URL: the trades array, message data, selected trade ID, unrealized P&L. Filter and sort state always goes in URL params via `createFilterParams`.

## Infinite Scroll

No pagination buttons. You scroll, more loads.

### `useInfiniteList`

Wraps TanStack Query's `useInfiniteQuery` with the cursor contract:

```ts
function useInfiniteList<T>(opts: {
  queryKey: unknown[];
  path: string;
  params?: Record<string, string>;  // sort, filters (no cursor — managed internally)
  limit?: number;                    // default 50
  enabled?: boolean;
  refetchInterval?: number | false;  // for live-updating lists
}): {
  rows: T[];                       // flattened across all loaded pages
  total: number | undefined;
  hasMore: boolean;
  loadMore: () => void;            // call when user scrolls near bottom
  isLoading: boolean;              // first page loading
  isFetchingMore: boolean;         // subsequent page loading
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}
```

The hook manages cursor state internally. When sort or filters change (via `queryKey`), TanStack Query resets to the first page automatically.

### How infinite scroll connects to DataTable

`DataTable` accepts an `onEndReached` prop and passes it to `TableVirtuoso`'s `endReached`. When the user scrolls near the bottom, Virtuoso fires the callback. No `ScrollSentinel` component, no `IntersectionObserver` — Virtuoso handles the scroll detection.

### Current adoption status

`useInfiniteList` is built and tested but not yet wired into any page. The hook is ready; pages currently fetch all data in a single request and let `DataTable` handle client-side sort. The upgrade path for a page: replace `useQuery` with `useInfiniteList`, add `onEndReached` and `isLoadingMore` to the `DataTable` call, and switch to controlled sort.

## Tables

**Every table uses `DataTable`.** No exceptions. No inline `<Table>` with `.map()`. No custom TableVirtuoso wrappers.

`DataTable` lives at `web/src/components/data-table.tsx` and handles:
- Virtualization (TableVirtuoso — works for 5 rows or 5,000)
- Sorting (built-in client-side, or controlled server-side)
- Infinite scroll (via `endReached` on TableVirtuoso)
- Sticky headers
- Empty state
- Row click handlers
- Custom row styling
- Loading indicator for fetching more rows

### Props

```ts
interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  defaultSort?: { column: string; dir?: 'asc' | 'desc' };
  onRowClick?: (row: T, index: number) => void;
  rowClassName?: (row: T) => string;
  compare?: (a: T, b: T, column: string) => number;
  className?: string;
  emptyState?: React.ReactNode;
  // Infinite scroll
  onEndReached?: () => void;
  isLoadingMore?: boolean;
  // Controlled (server-side) sort
  sort?: SortState<string>;
  onSortChange?: (column: string) => void;
}
```

### Usage -- Static data (fetch all, sort client-side)

This is what every table currently does:

```tsx
<DataTable columns={columns} data={tasks} defaultSort={{ column: 'createdAt', dir: 'desc' }} />
```

When `sort`/`onSortChange` are omitted, DataTable uses `useSort` internally for client-side sorting.

### Usage -- Infinite scroll (fetch pages, sort server-side)

This is the target pattern for large datasets:

```tsx
const { rows, loadMore, isFetchingMore } = useInfiniteList<Task>({
  queryKey: ['tasks', params.toParams()],
  path: '/tasks',
  params: params.toParams(),
});

<DataTable
  columns={columns}
  data={rows}
  sort={params.sort}
  onSortChange={params.setSort}
  onEndReached={loadMore}
  isLoadingMore={isFetchingMore}
/>
```

When `sort`/`onSortChange` are provided, DataTable skips internal sorting and renders data as-is (server already sorted).

### Column definitions

```ts
type Column<T> = {
  key: string;           // used for sort key
  label: ReactNode;      // header text
  sortable?: boolean;    // shows sort arrows on hover/click
  align?: 'left' | 'right';
  className?: string;    // applied to each cell
  render: (row: T) => ReactNode;  // cell content
};
```

### What NOT to do

```tsx
// BAD: inline table with map
<Table>
  <TableHeader><TableRow><TableHead>Name</TableHead></TableRow></TableHeader>
  <TableBody>{data.map(item => <TableRow>...</TableRow>)}</TableBody>
</Table>

// BAD: custom sort logic per page
const { sort, toggle } = useSort('name');
const sorted = useMemo(() => [...data].sort(...), [data, sort]);

// BAD: custom TableVirtuoso with forwardRef component overrides
const tableComponents = { Table: ..., TableHead: forwardRef(...), ... };

// BAD: raw useSearchParams for filter/sort state
const [params, setParams] = useSearchParams();
const sort = params.get('sort') ?? 'createdAt';

// GOOD: DataTable handles all of it
<DataTable columns={columns} data={data} defaultSort={{ column: 'name' }} />

// GOOD: URL-synced filters via createFilterParams
const useMyParams = createFilterParams({ sort: { type: 'sort', defaultColumn: 'name' } });
```

## Hooks

### `useSort`

```ts
function useSort<T extends string>(defaultCol: T, defaultDir?: 'asc' | 'desc'): {
  sort: { column: T; dir: 'asc' | 'desc' };
  toggle: (column: T) => void;
  toParams: () => { sort: string; dir: string };
}
```

`useSort` is a React state-based sort hook. It is used internally by `DataTable` for client-side sorting. Pages do not typically use it directly — use `createFilterParams` with `type: 'sort'` for URL-synced sort state instead.

One exception: `SortableHead` (in `components/sortable-head.tsx`) is a `<TableHead>` with sort arrows, used by the trades table client which has a custom (non-DataTable) table layout.

## Loading & Error States

### `QueryBoundary`

Wraps any query-dependent UI:

```tsx
<QueryBoundary query={query}>
  {(data) => <MyComponent data={data} />}
</QueryBoundary>
```

- `isLoading` (no data yet) — renders `skeleton` prop if provided, otherwise a minimal skeleton
- `isError` — renders an error card with a Retry button
- `data` present — renders children

Accepts an optional `skeleton` prop for page-specific loading shapes. Reusable skeleton components: `MetricStripSkeleton`, `ChartCardSkeleton`, `TableSkeleton`, `ListSkeleton` (all in `components/query-boundary.tsx`).

## Status

What exists and works today:

- `createFilterParams` — built, used by trades, tasks, backtests, chat, eval review, recon
- `DataTable` with client-side sort — built, used by most table views
- `DataTable` with controlled sort + `onEndReached` + `isLoadingMore` — built, not yet adopted by any page
- `useInfiniteList` — built, not yet used by any page
- `QueryBoundary` — built, used everywhere
- Cursor pagination on `/trades`, `/tasks`, `/backtest-runs`, `/messages` — built
- `useSort` — built, used internally by DataTable

Not needed (removed or never built):

- `ScrollSentinel` — DataTable uses `TableVirtuoso`'s `endReached` instead
- `useUrlSync` — `createFilterParams` handles URL sync directly via `useSearchParams`
- Zustand stores for filter/sort — URL params are the source of truth for filters; Zustand is for cross-component data only
