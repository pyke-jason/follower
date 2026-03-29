# UI Overhaul — Design System, Code Consolidation, Data Rails

## Problem

The web frontend had accumulated significant tech debt:
- Generic "AI slop" aesthetics (Inter font, default colors)
- Duplicated formatting code across 5+ files (inline `Intl.NumberFormat`, local `formatCurrency`)
- Raw HTML elements (`<button>`, `<select>`, `<input>`, `<table>`) instead of shadcn/ui components
- No shared data-fetching patterns — every page reinvented loading, sorting, filtering
- No error handling anywhere (`if (!data) return <Spinner />` everywhere)
- Inconsistent filter state (URL params, Zustand, React context, local state)
- Unbounded lists causing unnecessary page scroll
- Win rate bug (displayed 6470% instead of 64.7%)

## Decisions

### Design: "Midnight Circuit" theme
- DM Sans (body) + JetBrains Mono (financial data) — clean, not generic
- Deep navy-black dark mode with electric teal accent
- Dot grid texture, cool shadows, spring-like animations
- 0.5rem border radius (tighter, more technical)

### Code consolidation
- All currency/date/color formatting in `web/lib/format.ts` — added `formatCurrency(v, decimals?)`, `formatCurrencyAxis()`, `formatDateTooltip()`
- All UI primitives via shadcn — documented in `docs/rails/shadcn.md`
- Data fetching in hooks (`useTrades()`, `useTasks()`) — pages don't touch `useQuery` or URL params
- `QueryBoundary` component for loading (skeletons) + error states

### Data rails (docs/rails/frontend-data.md)
- Server-side cursor pagination (`CursorResponse<T>`) on all list endpoints
- Infinite scroll via `ScrollSentinel` + `useInfiniteList` hook
- Sort via `useSort` hook + `SortableHead` component
- Zustand filter stores with URL sync
- Column configs as data, not inline JSX

## Key Files

- `web/app/globals.css` — theme tokens
- `web/lib/format.ts` — all formatters
- `web/lib/api-types.ts` — `CursorResponse<T>`, `Column<T>`
- `web/hooks/use-sort.ts`, `use-infinite-list.ts`, `use-trades.ts`, `use-tasks.ts`
- `web/app/components/query-boundary.tsx` — loading + error boundary with skeleton building blocks
- `web/app/components/sortable-head.tsx`, `scroll-sentinel.tsx`
- `docs/rails/frontend-data.md` — the full data flow specification
- `docs/rails/shadcn.md` — component usage guide

## Watch Out

- Vite dev server crashes when background agents modify files during hot reload — restart with `npm run up:ui`
- `formatCurrency` second param is precision: `formatCurrency(v, 0)` for no decimals, `formatCurrency(v)` for $1,234.00
- Backend cursor pagination uses keyset pagination (`(col, id) < (cursor_val, cursor_id)`) — stable under inserts/deletes
- QueryBoundary must NOT wrap children in a div — breaks flex layout chains needed by virtualized tables
