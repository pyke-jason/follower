---
paths: web/src/views/**, web/src/components/**, web/src/hooks/**, web/src/stores/**, web/src/lib/**
---

# Web Components & Pages

## Page Architecture

Page files are **orchestrators, not implementations**. The default export should do three things: fetch data, wrap it in `QueryBoundary`, and lay out child components. Anything more belongs in a separate file.

Every list+detail page follows this structure:

```
views/<feature>/page.tsx           # Orchestrator. Export function <30 lines. Total file <150 lines.
components/<feature>-filters.tsx   # Filter UI. Uses createFilterParams for URL-synced state.
components/<feature>-table.tsx     # Table + split pane + sort + selection. Uses DataTable.
hooks/use-<feature>.ts             # Data fetching, derived state.
hooks/use-<feature>-filters.ts    # Filter param definitions (if needed).
```

**Reference implementations** — read the closest match before building a new page:

| Page shape | Reference | Notes |
|---|---|---|
| Minimal orchestrator (ideal) | `views/trades/page.tsx` (28 lines) | Pure delegation to child components |
| List + detail split pane | `views/trades/page.tsx` + `components/trades-table-client.tsx` | |
| Filtered list with multi-select | `components/trade-filters.tsx` | |
| Dashboard with metrics | `views/dashboard/page.tsx` | Export function is 12 lines; private render helpers below |
| Detail page with sections | `views/trades/[id]/page.tsx` | |
| Settings/config page | `views/settings/page.tsx` | |

## File Size & Decomposition

These limits prevent files from becoming unnavigable. When a file grows past the threshold, split immediately — do not wait.

- **Page export function: under 30 lines** (imports through end of the default export). Private render helpers may live below, but the total file must stay under 150 lines. Over 150 = extract helpers into sibling files or `hooks/`.
- **Component files: under 300 lines.** Over 300 = split into sibling files and extract hooks into `hooks/`.
- **One exported component per file.** Private helpers under 30 lines (used once in that file) may stay. Everything else gets its own file.
- **Hooks go in `hooks/`.** Never define a `use*` function inside a page or component file. Name them `use-<feature>-<concern>.ts`.
- **A function that returns JSX is a component.** If it exceeds 5 lines, extract it.

## Reuse Before Rebuild

Before writing a new hook or component, search the codebase. Duplicating these is always wrong:

| Need | Existing solution | Never do this instead |
|---|---|---|
| Loading/error states | `QueryBoundary` from `components/query-boundary.tsx` | Inline `isLoading`/`isError` ternaries |
| URL-synced filters | `createFilterParams` from `hooks/use-filter-params` | Hand-rolling `useSearchParams` get/set |
| URL-synced sort | `createFilterParams` with `type: 'sort'` | Sort state in `useState` or Zustand |
| Tables | `DataTable` from `components/data-table.tsx` | Inline `<Table>` with `.map()` |
| Empty states | `EmptyState` with `variant` prop | Bare text, `return null`, or custom divs |
| Split pane | `ResizablePanelGroup` from `components/ui/resizable` | Fixed-width CSS (`w-[480px]` + `flex-1`) |
| Progress bars | `Progress` from `components/ui/progress` | Hand-rolled div with percentage width |
| Mutations | `useApiMutation` from `hooks/use-api-mutation` | Raw `useMutation` + manual `api()` calls |
| Metric cards | `MetricStrip` from `components/metric-strip.tsx` | One-off stat cards or inline formatting |
| Error boundaries | `ErrorBoundary` from `components/error-boundary.tsx` | Uncaught render crashes |

## React Performance

- **Do not use `key={id}` to reset expensive component trees** (trees with queries, charts, or deep nesting). It forces a full unmount/remount. Detect the ID change in a ref and reset specific state instead. Simple forms or small components are fine to reset with `key`.
- **No transitions on content that changes via keyboard navigation.** Arrow keys should feel instant. Transitions are for user-initiated open/close actions, not data swaps.
- **Virtualize any list over 100 rows.** Use `DataTable` (TableVirtuoso) or react-virtuoso directly. Never render thousands of rows in the DOM.

## Shared Utilities — Don't Duplicate

These already exist. Import them; do not rewrite them inline.

| Need | Location | Key exports |
|------|----------|---------|
| Formatting | `lib/format.ts` | `formatCurrency`, `pnlColor`, `relativeTime`, `formatDate` |
| Class merging | `lib/utils.ts` | `cn()` (clsx + tailwind-merge) |
| Channel scoping | `lib/channel-scope.ts` | `buildHref()`, `buildScopedPath()` |
| Author colors | `lib/author-colors.ts` | `getAuthorBgColor()`, `getAuthorTextColor()` |
| API client | `lib/api.ts` | `api<T>(path, init?)` |
| Query factories | `lib/queries.ts` | `queries.trades.list()`, `queries.backtests.detail()`, etc. |
| Response types | `lib/api-types.ts` | `CursorResponse<T>`, `BacktestDetailResponse`, `Column<T>` |
| Page-level fetchers | `lib/page-adapters.ts` | `fetchDashboardPageData`, `fetchBacktestsPageData` |
| Snapshot helpers | `lib/snapshot-accessors.ts` | `getSnapshot()`, `getSnapshotParams()`, `getEventMeta()` |

All paths above are relative to `web/src/`. Import via `@/lib/...`.

## Data Flow

- **Reads**: Use `queries` factory from `lib/queries.ts` for standard resources. For one-off queries, use `useQuery` with `api<T>()`. Always typed — never `useQuery<any>` or untyped `api()`.
- **Mutations**: Use `useApiMutation` from `hooks/use-api-mutation`. It handles JSON serialization, query invalidation, and error handling. Always `toast.success()` on success.
- **Stores**: Zustand (`stores/`) for cross-component state that does not belong in the URL. Filter and sort state always go in URL params via `createFilterParams`.
- **Routing**: React Router v6. Channel scope via `?channel=` param.

## Component Patterns

- **DO NOT MODIFY `web/src/components/ui/`**: shadcn/ui managed. See `.claude/rules/shadcn-ui.md` for primitive constraints.
- **Styling**: Tailwind classes + `cn()`. No CSS modules, no inline style objects.
- **Vite SPA**: No server components, no `'use client'`.
