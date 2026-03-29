# Frontend Data Rails

How data flows from API → store → component → user interaction. Every list, table, and filter in the app follows these patterns.

## API Contracts

Every list endpoint returns a cursor-paginated response:

```ts
type CursorResponse<T> = {
  rows: T[];
  nextCursor: string | null;  // opaque cursor for next page, null = no more
  total?: number;              // optional total count (for "showing X of Y" display)
};
```

Query params: `?cursor=<opaque>&limit=50&sort=openedAt&dir=desc&<filters...>`

The backend owns sorting. The frontend never loads "all 10,000 rows" — it requests a page, then the next page when the user scrolls to the bottom. Endpoints that currently return raw arrays get wrapped in `CursorResponse` and gain cursor/limit/sort support.

**Why cursor over offset/limit:** Cursor pagination is stable under inserts/deletes (no skipped or duplicated rows when new data arrives). For tables sorted by `openedAt`, the cursor is the last row's timestamp. For other sorts, it's `column_value:id`.

**Why server-side sort:** Client-side sort on 10K rows is sluggish. Server-side `ORDER BY ... LIMIT` means the frontend always gets exactly what it needs, fast. SQLite handles this trivially.

## Infinite Scroll

No pagination buttons. No page numbers. You scroll, more loads. The chat feed already does this via `IntersectionObserver` — the same pattern applies to every list.

### `useInfiniteList`

Wraps TanStack Query's `useInfiniteQuery` with the cursor contract:

```ts
function useInfiniteList<T>(opts: {
  queryKey: unknown[];
  path: string;
  params: Record<string, string>;  // sort, filters (no cursor — managed internally)
  limit?: number;                   // default 50
  refetchInterval?: number;         // for live-updating lists
}): {
  rows: T[];                       // flattened across all loaded pages
  total: number | undefined;
  hasMore: boolean;
  loadMore: () => void;            // call when scroll sentinel enters viewport
  isLoading: boolean;              // first page loading
  isFetchingMore: boolean;         // subsequent page loading
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}
```

The hook manages cursor state internally. `loadMore()` is called by an `IntersectionObserver` on a sentinel element at the bottom of the list. When sort or filters change, the query resets to the first page.

### Scroll sentinel

A tiny component placed at the end of the list:

```tsx
function ScrollSentinel({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) onVisible();
    }, { rootMargin: '200px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onVisible]);
  return <div ref={ref} className="h-1" />;
}
```

Usage at the bottom of any list:

```tsx
{hasMore && <ScrollSentinel onVisible={loadMore} />}
{isFetchingMore && <Spinner />}
```

## Zustand Store Pattern

Filter and sort state lives in Zustand stores with URL sync. Not URL params directly, not React context, not component state. One pattern everywhere.

```ts
// Pattern: store with URL sync
const useTradesFilter = create<TradesFilterState>((set, get) => ({
  sort: { column: 'openedAt', dir: 'desc' },
  filters: { status: null, trader: null, strategy: null, direction: null },

  setSort: (column) => set((s) => ({
    sort: {
      column,
      dir: s.sort.column === column && s.sort.dir === 'desc' ? 'asc' : 'desc',
    },
  })),
  setFilter: (key, value) => set((s) => ({
    filters: { ...s.filters, [key]: value },
  })),
  clearFilters: () => set({ filters: { status: null, trader: null, strategy: null, direction: null } }),

  // Serialize to URL params
  toParams: () => {
    const { sort, filters } = get();
    const params: Record<string, string> = { sort: sort.column, dir: sort.dir };
    for (const [k, v] of Object.entries(filters)) {
      if (v != null) params[k] = v;
    }
    return params;
  },
}));
```

A `useUrlSync` hook reads URL params on mount → hydrates the store, and subscribes to store changes → writes URL params. Called once per page. Every filtered view becomes bookmarkable.

**Why Zustand over URL params directly:** Zustand gives you derived state, subscriptions, middleware, and a clean API. URL params are the persistence layer, not the state manager.

## Hooks

### `useSort`

```ts
function useSort<T extends string>(defaultCol: T, defaultDir?: 'asc' | 'desc'): {
  sort: { column: T; dir: 'asc' | 'desc' };
  toggle: (column: T) => void;
  toParams: () => { sort: string; dir: string };
}
```

Standalone hook for pages that only need sort (no filters). For pages with both sort + filters, the sort state lives in the filter store instead.

## Tables

**Every table uses `DataTable`.** No exceptions. No inline `<Table>` with `.map()`. No custom TableVirtuoso wrappers.

`DataTable` lives at `web/app/components/data-table.tsx` and handles:
- Virtualization (TableVirtuoso — works for 5 rows or 5000)
- Sorting (built-in, clickable column headers with arrows)
- Sticky headers
- Empty state
- Row click handlers
- Custom row styling

### Usage

```tsx
import { DataTable } from '../components/data-table';
import type { Column } from '@/lib/api-types';

const columns: Column<Task>[] = [
  { key: 'symbol', label: 'Symbol', render: (t) => t.context?.symbols?.[0] ?? t.taskType },
  { key: 'status', label: 'Status', sortable: true, render: (t) => <Badge label={t.status} /> },
  { key: 'createdAt', label: 'Created', sortable: true, render: (t) => formatDate(t.createdAt) },
];

<DataTable columns={columns} data={tasks} defaultSort={{ column: 'createdAt', dir: 'desc' }} />
```

### Column definitions

```ts
type Column<T> = {
  key: string;           // used for sort key
  label: string;         // header text
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

// GOOD: DataTable handles all of it
<DataTable columns={columns} data={data} defaultSort={{ column: 'name' }} />
```

## Loading & Error States

### `QueryBoundary`

Wraps any query-dependent UI:

```tsx
<QueryBoundary query={query}>
  {(data) => <MyComponent data={data} />}
</QueryBoundary>
```

- `isLoading` → `<Spinner />`
- `isError` → `<ErrorCard error={error} retry={refetch} />`
- `data` → render children

No more `if (!data) return <Spinner />` scattered across every page. No more silent failures.

## Migration order

1. **Primitives**: Build `useInfiniteList`, `ScrollSentinel`, `useSort`, `SortableHead`, `QueryBoundary`, `useUrlSync`
2. **Backend**: Add `CursorResponse` wrapper + cursor/limit/sort/dir params to list endpoints (`/trades`, `/tasks`, `/backtests`, `/recon-alerts`, `/tracked-traders`)
3. **Migrate tables one at a time**: Trades (reference implementation) → Tasks → Backtests → Reconciliation → Traders
4. **Kill dead code**: Remove old inline sort logic, old filter patterns, old type definitions, old stores that become unnecessary
