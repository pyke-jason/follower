# Cookbook 15 -- Virtualized Lists & Infinite Scroll

When to virtualize, when to add infinite scroll, and the performance rules that apply inside virtualized rows. This is the guide for any list that exceeds one screenful of data.

---

## 1. Do I Need Virtualization?

**User mental model:** "I have a long list. I want to scroll through it smoothly."

### Decision tree

- Rows could exceed 100? **Virtualize.** Use `DataTable` (which uses `TableVirtuoso` internally). This is the default for all tables in this project.
- Rows will never exceed 50 (hard cap from API or business logic)? **Render directly.** A `.map()` inside `<TableBody>` is fine.
- Rows are between 50 and 100? **Still virtualize.** The cost is near-zero and it future-proofs the component.

### Why it matters

An unvirtualized table with 2,000 rows creates 50,000+ DOM nodes (rows + cells + any component trees per cell). Every re-render touches all of them. Virtualization keeps the DOM at ~50-100 nodes regardless of data size.

### The rule

**Every table uses `DataTable`.** No inline `<Table>` with `.map()` for any list that could grow. `DataTable` virtualizes even small lists with negligible overhead.

---

## 2. Do I Need Infinite Scroll?

**User mental model:** "I scroll down and more data appears. I never click 'next page'."

### Decision tree

- Total dataset could exceed 200 rows, and the API supports cursor pagination? **Infinite scroll.** Fetch a page at a time, load more as the user nears the bottom.
- Dataset is bounded and small (all trades for one account, all tracked traders)? **Fetch all, virtualize client-side.** One request, `DataTable` handles the rest.
- Dataset is unbounded but the user only ever needs the first screenful (dashboard previews, recent signals)? **Fetch a fixed limit.** No pagination, no infinite scroll.

### When infinite scroll is wrong

- The user needs to jump to a specific position (page 47 of 200). Infinite scroll cannot do this. Use a paginated API with page number controls. (Rare in this project.)
- The user needs a stable "total count" that updates live. Infinite scroll's total is approximate and can drift as new data arrives. Acceptable for most views.

---

## 3. Wiring Infinite Scroll to a Virtualized Table

This is the integration layer. Three pieces work together:

### Piece 1: Backend cursor pagination

The API returns `CursorResponse<T>` -- rows, an opaque `nextCursor`, and an optional `total`. The frontend never decodes the cursor. When `nextCursor` is null, there are no more pages.

### Piece 2: `useInfiniteList` hook

Wraps TanStack Query's `useInfiniteQuery`. Manages cursor state internally. Returns `rows` (flattened across all pages), `hasMore`, `loadMore()`, and loading states. When filters or sort change, the query key changes, and TanStack Query resets to page 1 automatically.

### Piece 3: `endReached` on `TableVirtuoso`

`DataTable` accepts an `onEndReached` prop and passes it to `TableVirtuoso`'s `endReached`. When the user scrolls near the bottom, Virtuoso fires the callback. The callback calls `loadMore()`. No `ScrollSentinel`, no `IntersectionObserver`, no manual wiring -- Virtuoso handles the scroll math internally.

### The flow

1. Page mounts. `useInfiniteList` fetches the first page (e.g., 50 rows).
2. `DataTable` renders the rows with virtualization.
3. User scrolls down. Virtuoso fires `endReached`.
4. `loadMore()` is called. `useInfiniteList` fetches the next page.
5. New rows append to the flattened `rows` array. Virtuoso renders them seamlessly.
6. When `hasMore` is false, `endReached` stops firing.

### Loading indicator

Show a footer indicator while fetching more rows. `DataTable` accepts an `isLoadingMore` prop and renders a subtle loading bar below the last row. This is not a skeleton -- the existing rows remain visible and interactive.

---

## 4. How Filters and Sort Interact with Infinite Scroll

### The reset rule

When the user changes a filter or sort direction, the infinite scroll resets to page 1. All previously loaded pages are discarded. This is automatic: changing filter/sort params changes the `queryKey` in `useInfiniteList`, which causes TanStack Query to refetch from scratch.

### URL sync

Filters and sort live in URL params (via `createFilterParams` or `useSearchParams`). The cursor does NOT live in the URL -- it is internal to `useInfiniteList`. The URL represents "what the user asked for" (filters, sort), not "how far they have scrolled."

### Total count

The first page's response includes a `total` count. Display it as "Showing X of Y" where X is the number of loaded rows and Y is the total. This count reflects the current filters. It may become stale if data changes between page fetches -- this is acceptable.

---

## 5. Performance Rules Inside Virtualized Rows

Virtualization solves the "too many DOM nodes" problem, but each row still re-renders when it enters the viewport. Keep the per-row render cost low.

### No Tooltip inside table rows

Each Radix `<Tooltip>` creates ~10 wrapper components (Provider, Popper, PopperProvider, PopperAnchor, Portal, Content, Trigger, Presence, plus Context.Provider nodes). In a table with 2,000 rows and 2 Tooltips per row, that is 40,000 components mounted at once -- even with virtualization, the mount/unmount cost during fast scrolling is significant.

**Use `title` attribute instead.** For truncated text, long IDs, or any hover-to-see-full-value pattern inside a table row, use the native `title` attribute. Add a `// PERF: title used for virtualized row` comment to document the decision.

```
// PERF: title used for virtualized row
<span title={row.fullText} className="truncate">{row.shortText}</span>
```

**When Tooltip is acceptable:** Column headers (rendered once), cells in tables with fewer than 50 rows, or cells that need rich content (multi-line, formatted) in the tooltip.

### No heavy components per row

Avoid mounting these inside a virtualized row:
- **Tooltip** -- as above
- **HoverCard** -- same issue, even heavier
- **Popover / DropdownMenu** -- mount on-demand (render the trigger only, mount the content on click)
- **Complex SVG / Chart** -- keep sparklines to `<canvas>` or simple SVG paths, not full charting components

### Keep row className computation cheap

`cn()` calls per row are fine. But avoid recomputing expensive derived state (date formatting, currency formatting) inside the render -- compute once in a `useMemo` over the data array, or format in the `Column.render` function which is called per-row by Virtuoso.

### No `transition-colors` on virtualized rows

CSS transitions on rows that mount/unmount during scrolling cause unnecessary layout work. Use `hover:bg-accent/40` without `transition-colors`. The hover state change is instant and that is fine -- the user is not watching the transition while scrolling.

---

## 6. Choosing Between Patterns

| Situation | Pattern | Example |
|---|---|---|
| Bounded data, fits in one fetch (<200 rows) | `DataTable` + static `useQuery` | Trades (200 cap), Tasks (200 cap), Traders |
| Unbounded data, user scrolls through all of it | `DataTable` + `useInfiniteList` + `endReached` | Eval labels, Backtest runs (future) |
| Feed / chat, newest first, append on scroll | `Virtuoso` + `startReached` + store-managed cursor | Messages / ChatFeed |
| Dashboard preview, fixed small count | Plain `.map()` with `.slice()` | Recent signals (8), Open positions (6) |
| Small paginated review (<50 per page) | Plain `<Table>` + offset pagination buttons | Eval discrepancy table |

### When to upgrade from static to infinite scroll

A static `DataTable` (fetch-all) should be upgraded to infinite scroll when:
- The dataset could exceed the API's max limit (typically 200)
- Users report slow load times on the initial fetch
- The backend already supports cursor pagination for that endpoint

The upgrade path: replace `useQuery` with `useInfiniteList`, add `onEndReached` and `isLoadingMore` props to the `DataTable` usage. The table component, columns, and row rendering stay the same.

---

## 7. Mistakes to Avoid

- **Fetching 5,000 rows upfront.** If you need `limit: 5000` to show all data, you need infinite scroll instead. No endpoint should return more than 200 rows per request.
- **Client-side sorting on infinite-scroll data.** When only 3 of 50 pages are loaded, client-side sort gives wrong results. Sort must be server-side for infinite-scroll tables. `DataTable`'s built-in client-side sort is only correct for static (fetch-all) tables.
- **Using `ScrollArea` + `.map()` instead of `DataTable`.** `ScrollArea` adds scrolling but not virtualization. 2,000 rows in a `ScrollArea` still creates 2,000 DOM nodes. Always use `DataTable` for long lists.
- **Putting the cursor in the URL.** The cursor is ephemeral scroll state, not user intent. Only filters, sort, and selected-item ID belong in the URL.
- **Resetting scroll position on data append.** When new rows load via `endReached`, the scroll position must stay put. Virtuoso handles this automatically -- do not force a scroll-to-top or re-key the component.
- **Forgetting the "no more data" state.** When `hasMore` is false, do not show a loading indicator. Optionally show a subtle "end of list" marker so the user knows they have seen everything.
