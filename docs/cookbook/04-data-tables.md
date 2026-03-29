# Cookbook 04 -- Data Tables & Lists

A decision guide for choosing the right structure, interaction model, and feedback patterns when presenting collections of data. No code -- just the thinking that precedes it.

---

## 1. Displaying Structured Data

**User mental model:** "I have a list of things. I need to scan, compare, or find one."

### Decision tree

- Data has 3+ comparable fields per item, and users need to compare across rows? **Table** (Table, TableHeader, TableBody, etc.).
- Data is visually distinct per item (images, charts, status cards) and comparison across items is secondary? **Card grid** (Card inside a responsive CSS grid).
- Data is a sequential feed -- chronological, append-only, or conversational? **Vertical list** (plain stacked divs or a virtual list).

### Why it matters

Tables invite scanning left-to-right across columns. Cards invite scanning top-to-bottom within a single item. Picking the wrong container makes users work harder for no reason.

### Alternatives

- A table that only has two columns (label + value) is really a detail view, not a data table. Use a key-value layout instead.
- A card grid where every card has the exact same fields in the exact same layout is a table pretending to be something else. Switch to a table.

### Mistakes to avoid

- Putting a table inside a horizontally scrolling container on desktop. If you need scroll, you have too many columns -- hide or collapse some.
- Using cards because they "look nicer" when users actually need to sort and compare. Aesthetics should not override function.

---

## 2. Sorting

**User mental model:** "I want the most important / newest / biggest items at the top."

### Decision tree

- One sortable dimension at a time is almost always enough. Use SortableHead with a single active column indicator.
- Multi-column sort is rarely needed outside spreadsheet-like tools. If you think you need it, confirm that users actually think in composite sort orders. They usually do not.

### Communicating sort state

The active column header shows a directional arrow (up or down). Inactive sortable headers show a neutral up-down icon so users know they are clickable. Non-sortable headers show no icon at all.

Clicking an already-active header toggles direction. Clicking a different header activates it ascending.

### Flow

1. User sees a table with neutral sort icons on sortable columns.
2. User clicks a column header.
3. That column's icon changes to an up arrow. Rows reorder.
4. User clicks the same header again. Icon flips to down arrow. Rows reverse.
5. User clicks a different header. Previous column reverts to neutral. New column activates ascending.

### Alternatives

- Persist sort to URL params so it survives page reload and can be shared / bookmarked.
- For server-rendered pages or very large datasets, sort server-side and pass the current sort as query params to the API.

### Mistakes to avoid

- Sorting without visual feedback -- the user clicks and rows move but nothing in the header changes. They lose track of what happened.
- Defaulting to no sort at all. Every table should have a sensible default sort (usually newest first or alphabetical) so the initial view is useful, not random.
- Sorting formatted strings instead of raw values. "$1,200" sorts before "$200" alphabetically. Always sort on the underlying number or date.

---

## 3. Filtering

**User mental model:** "I know roughly what I am looking for. Help me narrow down."

### The three layers

Filters layer from broadest to most specific. Use only the layers the dataset needs.

1. **Search bar** (Input) -- free-text, matches against a primary field (name, symbol, title). Best for "I know the name." Place it above the table, left-aligned.

2. **Column / facet filters** (Select or Popover with checkboxes) -- discrete values like status, side, trader. Best for "Show me only open trades" or "Only AAPL." Place them in the same row as the search bar.

3. **Advanced / combined filters** (Popover or collapsible panel with multiple inputs) -- date ranges, numeric ranges, multi-field conditions. Best for power users who filter on 3+ dimensions. Gate this behind a "Filters" button with a Badge count so it does not clutter the default view.

### Flow

1. User types in the search bar. Rows filter instantly (or after a short debounce for large sets).
2. User picks a value from a Select. Rows narrow further.
3. If filters are active, show a count or Badge next to the filter controls and offer a "Clear all" action.
4. When filters reduce the set to zero, show the empty state with a prompt to clear filters (see section 8).

### Alternatives

- Persist filter state to URL search params. This lets users bookmark a filtered view and share it with others. It also means filters survive a page refresh.
- A Combobox replaces a Select when the list of options is long (e.g., 50+ symbols or trader names). It adds a type-to-search capability inside the dropdown.

### Mistakes to avoid

- Hiding active filters. If the user cannot see what is filtering the table, they will think data is missing.
- Debouncing too aggressively. 200ms is fine for text search. Anything over 500ms feels broken.
- Filtering on the client when the dataset is large enough that the API should handle it. If you are fetching 10,000 rows just to filter them in the browser, push the filter to the server.

---

## 4. Row Selection and Bulk Actions

**User mental model:** "I want to do the same thing to several items at once."

### When to offer selection

Only when there are real bulk operations. Checkboxes with no corresponding actions confuse users. If every action is per-row, skip selection entirely and use the row actions menu (section 6).

### Components and why

- Checkbox in the first column of each row.
- A header Checkbox that toggles select-all / deselect-all. When some rows are selected, it shows indeterminate state.
- A toolbar that appears above the table when `selected.size > 0`, showing the count ("3 selected") and available bulk actions as Buttons.

### Flow

1. User checks individual rows. The toolbar appears with a count.
2. User optionally clicks the header checkbox to select all visible rows.
3. User clicks a bulk action (e.g., Archive, Delete, Assign). If the action is destructive, it opens a confirmation dialog.
4. On completion, selection clears and the toolbar disappears.

### What the toolbar should show

- The selection count, always.
- The most common bulk action as a primary Button.
- Secondary actions as outline Buttons or inside a DropdownMenu if there are more than three.
- A way to deselect all (either a clear button or clicking the header checkbox).

### Mistakes to avoid

- Keeping selection alive after a bulk action completes. Clear it. The user's intent is fulfilled.
- Selecting rows that are not visible (e.g., on other pages). This is confusing and error-prone. Selection should operate on the visible set only.
- Forgetting indeterminate state on the header checkbox. Without it, users cannot tell partial selection from no selection.

---

## 5. Expandable Rows

**User mental model:** "I want a bit more detail on this row without leaving the page."

### When inline expansion beats navigation

- The extra detail is small (3-6 fields, a short note, a mini chart) and glanceable.
- The user is comparing rows and needs context from the table while viewing detail.
- The detail does not need its own URL.

If the detail is rich (many tabs, editable forms, long content), use master-detail (section 9) or navigate to a full page.

### Components and why

- Collapsible wraps each expandable row.
- CollapsibleTrigger is the row itself (or a chevron icon in the first cell).
- CollapsibleContent is a second TableRow spanning all columns, with a muted background.

### Flow

1. User sees rows with a chevron or understands the row is clickable.
2. User clicks a row. A detail panel slides open directly below it.
3. The chevron rotates to indicate open state.
4. User clicks the same row again (or the chevron) to collapse.

### Single vs. multi-open

- Default to multi-open (each row manages its own state). Users comparing two rows can have both open.
- Use single-open (only one expanded at a time) when the expanded content is tall enough that having multiple open creates excessive scrolling.

### Mistakes to avoid

- No visual cue that rows are expandable. A chevron icon is the clearest signal.
- Expanding a row and pushing the next row far off-screen. If expanded content is tall, cap it with a max-height and ScrollArea.
- Using expandable rows when the detail needs its own URL. Expanded state is ephemeral -- it should not represent a navigable resource.

---

## 6. Row-Level Actions

**User mental model:** "I want to do something to this specific row."

### The "..." menu pattern

A ghost icon Button in the last cell of each row, showing a MoreHorizontal icon. Clicking it opens a DropdownMenu with per-row operations.

### When to surface vs. hide actions

- **Surface** (visible Button in the row): the action is the primary reason the row exists. Example: an "Approve" button on a pending task row.
- **Hide** (inside the "..." menu): the action is secondary or infrequent. Example: Copy ID, Edit, Delete.
- Rule of thumb: at most one surfaced action per row. Everything else goes in the menu.

### Components and why

- DropdownMenu, DropdownMenuTrigger (the "..." Button), DropdownMenuContent, DropdownMenuItem.
- DropdownMenuSeparator to visually separate destructive items (Delete, Archive) from safe ones (Edit, Copy).
- For destructive items, the menu item should trigger an AlertDialog, not act immediately.

### Flow

1. User spots the "..." icon in the row they care about.
2. User clicks it. A dropdown appears aligned to the end of the row.
3. User picks an action. The dropdown closes and the action fires (or a confirmation dialog opens).

### Alternatives

- Context menu (right-click) as a secondary access path for power users. Not a replacement -- the "..." button must always exist for discoverability.
- Keyboard shortcut hints inside DropdownMenuShortcut for frequent operations.

### Mistakes to avoid

- Putting more than 7-8 items in a single dropdown. Group with labels and separators, or restructure into submenus.
- Mixing row-level actions with bulk actions. They serve different intents and belong in different places.
- Making the "..." icon too small or too far from the row content. It should be easy to target.

---

## 7. Pagination vs. Infinite Scroll

**User mental model (pagination):** "I am on page 3 of 12. I can jump to any page."
**User mental model (infinite scroll):** "I keep scrolling and more items appear."

### Decision tree

- Dataset is bounded and the user benefits from knowing total count and position? **Pagination** (Pagination, PaginationContent, PaginationPrevious, PaginationNext, etc.).
- Dataset is a feed, newest-first, and the user rarely needs items beyond the first few screenfuls? **Infinite scroll** (ScrollSentinel that triggers the next fetch when it enters the viewport).
- Dataset is small enough to fit on one screen (under ~50 rows)? **Neither.** Just render everything.

### Pagination flow

1. Table renders with page 1 and a "Rows per page" selector (Select).
2. Pagination controls below the table show numbered page links, previous/next, and ellipsis for gaps.
3. User clicks a page number or arrow. Table re-renders with that page's data.
4. Current page is visually highlighted in the controls.

### Infinite scroll flow

1. Table renders the first batch of rows.
2. A sentinel element sits below the last row, invisible to the user.
3. As the user scrolls, the sentinel enters the viewport and triggers a fetch for the next batch.
4. New rows append. A Spinner shows briefly during the fetch.
5. When there are no more rows, the sentinel is removed.

### Tradeoffs

| | Pagination | Infinite scroll |
|---|---|---|
| User knows total count | Yes | No (or imprecise) |
| User can jump to a specific position | Yes | No |
| Works well with sorting and filtering | Yes | Requires resetting the list |
| Good for casual browsing | No (clicking is friction) | Yes |
| Shareable position via URL | Yes (page param) | Awkward |

### Mistakes to avoid

- Infinite scroll with client-side sorting. When new items load, the sort order changes and the user loses their place. Paginate instead, or sort server-side.
- Pagination without URL persistence. If the user refreshes and lands back on page 1, the pagination is wasted effort.
- Showing a "Load more" button instead of a sentinel when the intent is seamless browsing. The button adds friction for no benefit. (A "Load more" button is fine when you want the user to consciously decide to fetch more.)

---

## 8. Empty and Loading States

**User mental model (loading):** "Something is happening. I should wait."
**User mental model (empty):** "There is nothing here. Why? What can I do?"

### Loading state

Show a Skeleton version of the table: real headers (so column layout is established), and placeholder rows with Skeleton bars matching the expected content widths. This tells the user what shape the data will take.

- Match skeleton row count roughly to the expected page size (5-8 rows is usually enough).
- Right-align numeric skeletons to match the real layout.
- Never show a blank table with a spinner on top. The skeleton is always better because it reserves the layout space.

### Empty state: two distinct cases

**Case 1 -- No data ever.** The dataset is genuinely empty (no trades yet, no tasks created). Show an Empty composition with an icon, a title ("No trades yet"), a description explaining when data will appear, and optionally a primary action Button ("Import trades" or similar).

**Case 2 -- No results for current filters.** The dataset has data but the active filters exclude everything. Show an Empty composition with a different title ("No matching results"), a description ("Try adjusting your search or filter criteria"), and a "Clear filters" Button.

### Components and why

- Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent -- the structured empty state composition.
- Skeleton -- for loading placeholder bars.
- Both sit inside a TableBody with a single TableRow spanning all columns via colSpan.

### Flow

1. Page loads. Skeleton table appears immediately (no flash of empty state).
2. Data arrives. If rows exist, skeleton is replaced with real rows.
3. If no rows exist, skeleton is replaced with the appropriate empty state.
4. User applies filters that exclude all rows. Real rows are replaced with the filter-specific empty state, including a clear-filters action.

### Mistakes to avoid

- Showing the "no data ever" message when filters are active. The user thinks nothing exists when really their filters are too narrow.
- A loading spinner with no structural hint of what is loading. Skeletons beat spinners for tables because they communicate shape.
- An empty state with no guidance. "No results" with no follow-up action leaves the user stranded.

---

## 9. Master-Detail

**User mental model:** "I want to see the full story on one item while keeping the list visible for context."

### Decision tree

- The detail view is rich (multiple sections, charts, editable fields) and the user switches between items frequently? **Split pane** with ResizablePanelGroup.
- The detail view is a one-off inspection (quick look, then back to the list) and screen space is limited? **Dialog.**
- Never Sheet. Sheet (side drawer) looks like navigation, competes with sidebars, and does not offer the persistent side-by-side context that a split pane provides, nor the focused attention that a Dialog provides.

### Split pane flow

1. User sees a table filling the left panel. The right panel shows an empty state ("Select a row to view details").
2. User clicks a row. The right panel populates with that item's detail. The clicked row is highlighted.
3. User clicks a different row. The detail panel updates. The highlight moves.
4. User can drag the ResizableHandle to adjust the panel ratio.
5. Both panels scroll independently (via ScrollArea).

### Dialog flow

1. User clicks a row (or an "inspect" action in the row's "..." menu).
2. A Dialog opens over the table with the item's full detail.
3. User reads / interacts with the detail.
4. User closes the Dialog (Escape, X button, or overlay click) and is back in the table exactly where they left off.

### Components and why

- ResizablePanelGroup, ResizablePanel, ResizableHandle -- for the split pane. Set minSize and maxSize to prevent either panel from collapsing to nothing.
- ScrollArea -- independent scrolling in each panel.
- Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription -- for the modal approach.
- Empty -- for the "nothing selected" state in the right panel.

### Alternatives

- Keyboard navigation: arrow keys move the selected row up/down in the list panel, and the detail panel updates live. Useful for rapid scanning.
- Responsive collapse: on narrow screens, the split pane is not viable. Fall back to a Dialog or full-page navigation.

### Mistakes to avoid

- Using Sheet instead of Dialog. Sheet slides in from the side and conflicts with the application sidebar. It also partially obscures the table without giving the user a clear "you are in a modal" signal.
- Forgetting the empty state in the detail panel. If no row is selected, the right side should not be blank -- it should tell the user what to do.
- Making the detail panel too narrow by default. If the detail has meaningful content, give it at least 55% of the width initially.
- Not highlighting the selected row in the list. The user needs to see which item's detail they are viewing.
