# Filter Component Patterns

A definitive reference for choosing and composing filter UI. Goes beyond "use a Combobox" -- names the exact shadcn component composition for each pattern, describes the interaction model step by step, and calls out the mistakes that cause filter UX to fail silently.

This document complements cookbook 04 (Data Tables, section 3) and cookbook 05 (Search, Filter & Selection). Those describe when to filter and what patterns exist at a high level. This one describes how each filter pattern works in detail: which primitives nest inside which, what the user sees at every step, and how state flows.

---

## 1. Quick Preset Bar

**When to reach for it.** The filterable dimension has 3-6 options that are known upfront, mutually exclusive or freely combinable, and important enough to be visible at all times. Status filters (Open / Closed / Trimmed), time windows (1D / 1W / 1M / All), and trade side (Long / Short) are the canonical examples. If users reach for this filter constantly, it should not be hidden behind a click.

**The user's mental model.** "I see buttons. One is highlighted. I click a different one and the data changes instantly." There is no dropdown, no popover, no typing. The options are always visible. The active one is visually distinct. This is the lowest-friction filter interaction -- one click, zero thought.

**Component composition.**
- ToggleGroup as the container. Set `type="single"` when exactly one option must always be active (status filter). Set `type="multiple"` when the user can combine options (show both Long and Short).
- ToggleGroupItem for each option. The active item receives a distinct pressed style automatically.
- Badge (optional) inside each ToggleGroupItem to show counts ("Open (12)"). Only add counts when they are cheap to compute and genuinely help the user decide which preset to pick.

**Interaction model.**
1. User sees a horizontal row of pill-shaped buttons. One (or more) is visually active.
2. User clicks a different button. In single mode, the previous deactivates and the new one activates. In multiple mode, the clicked button toggles independently.
3. Data updates immediately -- no apply button, no delay.
4. If single mode: clicking the already-active button does nothing (enforce "always one selected"). If multiple mode: clicking an active button deactivates it.

**State management.**
- Sync the value to a URL search param (`?status=open`). This makes the filter state bookmarkable and shareable.
- For single mode, store a string. For multiple mode, store a comma-separated string or repeated params (`?side=long&side=short`).
- The ToggleGroup is a controlled component -- its `value` prop comes from the URL param, its `onValueChange` writes to the URL param.

**Common mistakes.**
- Allowing zero selection in single mode. If the user deselects everything, the data view becomes undefined. Either enforce "always one active" by ignoring clicks on the current value, or define a semantic meaning for "none" (show all).
- Too many options. If the bar wraps to a second line, switch to a Select or Popover-based filter. Seven is the practical maximum; five is the sweet spot.
- Not indicating the active state clearly enough. The pressed toggle must be visually obvious -- a subtle border change is not sufficient. Use a filled background on the active item.
- Using ToggleGroup for actions (Export, Print) instead of filters. Actions should be Buttons. Filters should be toggles. The visual similarity is misleading if the semantics are wrong.

---

## 2. Single-Value Dropdown

**When to reach for it.** The user needs to pick one value from a short, static list -- under about 15 items. The options are known upfront and do not require search. Think: sort order, rows-per-page, account selector, asset class. The interaction should feel like a native dropdown: click, scan, pick.

**The user's mental model.** "I click a selector, see a list, pick one." They expect the trigger to show the current selection. They expect the list to be short enough to scan without scrolling. They do not expect to type.

**Component composition.**
- Select as the root.
- SelectTrigger as the clickable button showing the current value.
- SelectContent as the dropdown panel.
- SelectItem for each option.
- SelectGroup and SelectLabel (optional) if the options have logical categories (e.g., grouping currencies by region).
- SelectSeparator (optional) between groups.

**Interaction model.**
1. User sees a button with the current value and a chevron.
2. User clicks the button. A dropdown appears directly below, aligned to the trigger.
3. User scans the options and clicks one.
4. The dropdown closes. The trigger updates to show the new selection.
5. Keyboard: the user can arrow up/down through options and press Enter to select.

**State management.**
- For filters that affect a data view, sync to a URL search param (`?sort=newest`).
- For settings that affect layout (rows per page, view mode), local component state or a lightweight store is fine -- these rarely need to survive a page refresh.
- Select is a controlled component: `value` and `onValueChange`.

**Common mistakes.**
- Using Select when there are 20+ options. Once the dropdown scrolls, the user is hunting. Switch to a searchable Combobox instead.
- Not showing a default value. A Select with placeholder text that says "Choose..." forces an extra decision. Pre-select the most common option.
- Using Select for multi-select. Select is single-value only. If you need multi-select, use the faceted filter pattern (section 4).
- Grouping options when there are only 5-8 items total. Groups add visual noise. Use them only when the list is long enough that scanning without structure is slow.

---

## 3. Searchable Single-Value

**When to reach for it.** The user needs to pick one value from a long list -- 15 or more items, potentially hundreds. The list might be static (all ticker symbols) or dynamic (loaded from an API). The user cannot scan the full list visually, so they need to type to narrow it down. Ticker pickers, trader selectors, and channel pickers are typical examples.

**The user's mental model.** "This looks like a dropdown, but I can search inside it." They expect a trigger button showing the current selection, a panel that opens on click with a search field at the top, and a filtered list below. The search field lives inside the dropdown, not in the page.

**Component composition.**
- Combobox as the root. Use the popup trigger pattern (render prop) so the trigger looks like a Select button, not an inline text input.
- ComboboxInput placed inside ComboboxContent. This is what makes it feel like "dropdown with search" rather than a search box with results.
- ComboboxContent as the dropdown panel.
- ComboboxList and ComboboxItem for the filterable options.
- ComboboxEmpty for the "No results" message when the search matches nothing.
- ComboboxGroup and ComboboxSeparator (optional) if the options have natural categories.

**Interaction model.**
1. User sees a button showing the current selection (or placeholder like "Select trader...") with a chevron.
2. User clicks the button. A dropdown opens with a search input auto-focused at the top and the full list below.
3. User types. The list filters in real time using the built-in fuzzy matching.
4. User arrows to an item and presses Enter, or clicks directly.
5. The dropdown closes. The trigger button updates to show the new selection.

**State management.**
- Same as single-value dropdown: sync to URL params when the selection affects a data view.
- For async options (API-loaded), debounce the search input by 200-300ms before fetching. Show a spinner in the list area during the fetch.
- The Combobox is controlled: `value` and `onValueChange` for the selected item. The search text is internal to the Combobox and resets when the dropdown closes.

**Common mistakes.**
- Not auto-focusing the search input when the panel opens. The user opened it to search -- make typing immediate.
- Closing the dropdown when the search input blurs. The user might click an option, which briefly blurs the input. The panel should stay open until explicit close (selection, Escape, or click-outside).
- Not handling the empty query state. When the input is empty and the dropdown first opens, show the full list (or the most common items, or recents). A blank dropdown is a missed opportunity.
- Showing a search input for a list of 8 items. If the user can scan the options in a glance, Select is the right component. Search adds friction to short lists.

---

## 4. Multi-Select Facet

**When to reach for it.** The user needs to select multiple values from a single dimension to filter data -- multiple traders, multiple statuses, multiple tags. This is the workhorse filter for data tables. The list of options may be short (5 statuses) or long (50 traders), and the user needs to see what they have selected even when the dropdown is closed.

**The user's mental model.** "I click a filter button, check the values I want, and close it. The button tells me how many I picked." They expect checkboxes (not ambiguous opacity-toggled icons), they expect the dropdown to stay open while they check multiple items, and they expect the trigger to update with a count or summary.

**Component composition.**
- Popover as the container. Unlike Combobox, this pattern needs to stay open for multiple selections, and the trigger is a Button, not an input.
- PopoverTrigger wrapping a Button. The button label reads the facet name plus a count indicator: "Status" when nothing is selected, "Status (2)" when two values are checked.
- PopoverContent as the dropdown panel.
- Command inside the popover for search-and-select. Even if the list is short, Command provides keyboard navigation and consistent filtering behavior.
- CommandInput at the top of the Command for type-to-filter. This is essential when the option list exceeds about 10 items. For very short lists (under 7), you can omit it.
- CommandList containing the scrollable option area.
- CommandEmpty for the "No results" state.
- CommandGroup (optional) for categorized options.
- CommandItem for each option. Each item renders a Checkbox on its left side. The entire CommandItem is the click target -- clicking anywhere on the row toggles the checkbox. The checkbox is a visual indicator, not a separate interactive control.
- Separator and a "Clear" button at the bottom of the popover to reset the facet.

**Interaction model.**
1. User sees a row of filter buttons: "Trader," "Status," "Side."
2. User clicks "Trader." A popover opens with a search input and a checkbox list of all traders.
3. User checks "Pete." The checkbox fills. The data view updates immediately (or after a short debounce if server-side).
4. User checks "Hari." Now two are checked. The popover stays open.
5. User clicks outside the popover or presses Escape. The popover closes. The trigger button now reads "Trader (2)."
6. To clear: user reopens the popover and clicks "Clear," or clicks an "x" on the trigger badge.

**State management.**
- Store selected values as an array in URL search params: `?trader=pete&trader=hari` (repeated params) or `?trader=pete,hari` (comma-separated).
- The Popover is uncontrolled for open/close state (manages itself). The checkbox state is controlled: derive `checked` from `selectedValues.includes(item.value)`.
- For faceted counts (showing how many rows match each option), pass a `Map<string, number>` from the data layer. Display counts as muted text or badges next to each option label: "Pete (14)." These counts help the user avoid dead-end selections.

**Common mistakes.**
- Closing the popover on every checkbox click. This is the most common bug. The popover must stay open while the user selects multiple values. It closes on click-outside or Escape, not on selection.
- Using opacity-toggled check icons instead of Checkbox components. Checkboxes are an explicit multi-select affordance that users recognize instantly. A subtle check icon that fades in and out is ambiguous -- users may not realize multiple selection is possible.
- Not showing selected count on the trigger when the popover is closed. If the user closes the popover and sees a trigger that looks identical to its unfiltered state, they will forget filters are active. Always update the trigger label or add a Badge.
- Coupling facets so that selecting a value in one changes options in another. Keep facets independent unless you have a strong domain reason for dependency (rare in data tools, common in e-commerce).
- No "clear" affordance. The user should be able to reset a facet with one click, not by unchecking every item individually.

---

## 5. Date / Range Filter

**When to reach for it.** The user needs to constrain data by time. This covers three sub-patterns: picking a single date, picking a start-end range, or selecting a relative preset ("last 7 days"). Most filter bars need the range variant. Some need presets alongside the calendar for speed.

**The user's mental model depends on the task.**
- Single date: "I need one day. Show me a calendar I can click."
- Date range: "I need a start and end. I click start, then click end, and see the range highlighted."
- Relative preset: "I want last 7 days. I do not want to do calendar math. Give me a button."

**Component composition.**
- Popover as the container.
- PopoverTrigger wrapping a Button. The button shows the selected date or range in human-readable format ("Mar 1 -- Mar 28"), or placeholder text ("Pick a date range").
- PopoverContent containing the calendar and optional presets.
- Calendar for the visual date grid. Set `mode="single"` for a single date, `mode="range"` for a start-end range. Set `numberOfMonths={2}` for range pickers so the user can see the range span across months.
- Preset buttons (optional) alongside the calendar in a vertical sidebar or horizontal row above/below the calendar. Each preset is a Button that sets the date range to a computed value (today minus 7 days, start of month, etc.). Common presets: Today, Last 7 Days, Last 30 Days, This Month, This Quarter, All Time.

**Interaction model (range with presets).**
1. User sees a button showing the current date range or "Select date range."
2. User clicks the button. A popover opens showing preset buttons on the left and a two-month calendar on the right.
3. Fast path: user clicks "Last 7 Days." The calendar highlights the range. The popover closes (or stays open for confirmation, depending on whether you use an Apply button). The trigger updates.
4. Custom path: user clicks a start date on the calendar. The date highlights. User clicks an end date. The range fills in between. The trigger updates.
5. To clear: user clicks a "Clear" button inside the popover, or selects "All Time" as a preset.

**State management.**
- Store as URL params: `?from=2026-03-01&to=2026-03-28`. Use ISO 8601 date strings.
- Relative presets should resolve to absolute dates at selection time. Do not store "last7days" in the URL -- store the computed start and end dates. This makes the filter deterministic and shareable.
- If you need the preset label for display ("Last 7 Days"), derive it by comparing the stored dates against today's date when rendering the trigger.

**Common mistakes.**
- Two separate date pickers for start and end. This forces two popover interactions and creates start-after-end errors. Use a single range Calendar.
- No preset shortcuts. If 80% of users want "last 7 days," making them click two dates on a calendar is wasting their time. Presets are not a nice-to-have; they are the primary interaction for most users.
- Calendar without month/year navigation. If the user needs to go back 6 months, clicking "previous month" six times is painful. Use `captionLayout="dropdown"` to enable month and year dropdowns in the calendar header.
- Storing relative presets in the URL. "last7days" means different things on different days. Store absolute dates.
- Requiring manual date entry in a specific format. Typing "03/28/2026" is error-prone and locale-dependent. Let the user click a calendar.

---

## 6. Free-Text Search

**When to reach for it.** The user wants to filter a list by typing a name, symbol, or keyword. This is the broadest filter -- it matches against a primary text field (trade ticker, trader name, message content) and narrows the visible set in real time. Place it at the start of the filter bar, left-aligned, as the first thing the user reaches for.

**The user's mental model.** "I type, the list shrinks." They expect instant feedback (or near-instant with a short debounce). They expect the search to be case-insensitive. They expect clearing the input to restore the full list.

**Component composition.**
- Input from shadcn (never a raw HTML input). Use `type="search"` for the native clear button on some browsers, or add an explicit X icon button.
- A search icon (e.g., Search from lucide-react) positioned inside the input as a left addon, using absolute positioning or an InputGroup pattern. This signals "this is a search field" without a label.
- No dropdown, no popover. The results appear in the existing data view (table, list, card grid) by filtering rows.

**Interaction model.**
1. User sees an input with a search icon and placeholder text ("Search trades...", "Filter by name...").
2. User types. After a short debounce (150-300ms), the data view filters to show only matching rows.
3. If the search reduces results to zero, the empty state appears with a message ("No matching results") and a suggestion to clear the search.
4. User clears the input (backspace, X button, or Escape). The full data set returns.

**State management.**
- Debounce the input value before writing to the filter state. 150-300ms for client-side filtering, 300-500ms for server-side filtering.
- Store the search term in a URL param (`?q=AAPL`) so it survives refresh and is shareable.
- Use a `useDebounceValue` or `useDebounceCallback` hook for the debounce. Do not implement debounce with raw setTimeout -- it creates stale closure bugs.
- The Input is controlled: `value` comes from local state (not the URL directly, because the URL updates on the debounced cadence). The debounced value syncs to the URL param.

**Common mistakes.**
- No debounce. Filtering on every keystroke is fine for tiny datasets but hammers the API for server-side filtering and causes visible flicker for large client-side sets. Always debounce.
- Debouncing too aggressively. 200ms feels instant. 500ms feels sluggish. Anything over 500ms and the user thinks the input is broken.
- Not showing a loading indicator during server-side search. The user types, nothing happens for 400ms, and they wonder if the input is broken. Show a subtle spinner or skeleton while the debounced fetch is in flight.
- Matching on the wrong field. If the search box says "Search trades," it should match on the primary identifier (ticker symbol, trade name) -- not on every field in the row. Searching everything sounds helpful but produces noisy results.
- Forgetting the clear affordance. An X icon button inside the input, or type="search" for the browser's native clear, lets the user reset with one click instead of selecting all text and deleting.

---

## 7. Combined Filter Bar

**When to reach for it.** The data view has multiple filter dimensions, and you need to compose them into a coherent horizontal bar above the table or list. This is not a component -- it is a layout pattern that orchestrates the individual filter patterns described above.

**The user's mental model.** "I see a row of controls above the table. I use them to narrow down what I see. I can tell at a glance which filters are active. I can clear everything with one click."

**Component composition (left to right).**
1. Free-text search Input (pattern 6) -- always first, left-aligned.
2. Quick preset ToggleGroup (pattern 1) -- if the primary dimension has 3-6 options. Directly to the right of search.
3. Facet filter Popovers (pattern 4) -- one Button per filterable dimension. These come after the presets.
4. Date range Popover (pattern 5) -- if the data is time-series.
5. Active filter indicator area -- between the filter controls and the table, or inline after the last filter button. Shows the combined filter state.
6. "Clear all" Button -- visible only when at least one filter is active. Rightmost item in the bar, or in the active filter indicator area.

**Active filter indicators.**
When filters are active, the user must be able to see the full filter state without opening any popovers. Two patterns work:

*Approach A: Badge counts on triggers.* Each facet trigger button shows a count: "Trader (2)", "Status (1)." The quick preset bar shows its active state visually. The search input shows its text. This works well when there are few facets (under 5). No separate indicator row needed.

*Approach B: Filter chips below the bar.* A row of removable Badge chips appears between the filter bar and the table: "Trader: Pete x", "Trader: Hari x", "Status: Open x." Each chip has an X to remove that single value. A "Clear all" link appears at the end. This works well when there are many active values and the user needs to see exactly what is filtering.

Use Approach A for simple filter bars (3-4 dimensions, few selections). Use Approach B for complex filter bars (5+ dimensions, many multi-select values). You can combine both: badge counts on triggers plus chips below.

**Interaction model.**
1. User arrives at the page. The filter bar shows default state (usually "all" for every dimension). No active indicators.
2. User types in the search box. Results narrow. The search text is visible in the input.
3. User clicks a preset toggle. The toggle activates. Results narrow further.
4. User opens a facet popover, checks two values, closes it. The trigger badge shows "(2)." If using chips, two chips appear below the bar.
5. User sets a date range. The date button updates to show the range.
6. All filters are AND-composed: the data view shows rows matching ALL active filters.
7. User clicks "Clear all." Every filter resets to its default. All indicators disappear. The full data set returns.

**State management.**
- Every filter dimension maps to a URL search param. The full filter state is encoded in the URL: `?q=AAPL&status=open&trader=pete,hari&from=2026-03-01&to=2026-03-28`.
- Use a single hook (or coordinated hooks) that reads from and writes to URL params. Each filter control binds to its param.
- "Clear all" resets all filter params to their defaults (remove from URL or set to "all").
- On page load, initialize all filter controls from the URL params. This makes filters survive refresh, shareable via link, and compatible with browser back/forward.

**Common mistakes.**
- Hiding active filters. If the user cannot see what is filtering the data without opening every popover, they will think data is missing. Active state must be visible at all times.
- No "clear all" when filters are active. Making the user clear each filter individually is tedious and error-prone. Provide a single reset action.
- Inconsistent filter composition. If some filters are AND and others are OR, the user cannot build a mental model. Within a facet, values are OR ("show Pete OR Hari"). Between facets, the composition is AND ("show Pete OR Hari, AND status is Open"). Document and enforce this.
- Too many filters visible by default. If the bar has 8+ filters, it overwhelms the user and eats vertical space. Gate advanced filters behind a "More filters" button with a Badge count showing how many advanced filters are active.
- Not persisting filters to the URL. Client-only filter state dies on refresh, cannot be shared, and breaks browser back/forward. URL params are the right default for filter state.
- Instant filtering on every change vs. Apply button. For client-side filtering, update instantly -- the user expects immediate feedback. For expensive server-side queries, consider batching: let the user adjust multiple filters, then click "Apply." Show a visual cue (pulsing apply button, stale-data indicator) when the displayed data does not match the current filter state. Never use an Apply button for client-side filtering -- it adds friction for zero benefit.

---

## Decision Matrix: Choosing the Right Filter Pattern

| Situation | Pattern | Component root |
|---|---|---|
| 3-6 known options, always visible, one active | Quick preset bar (single) | ToggleGroup type="single" |
| 3-6 known options, always visible, combinable | Quick preset bar (multiple) | ToggleGroup type="multiple" |
| Pick one from <15 static options | Single-value dropdown | Select |
| Pick one from 15+ options (or API-loaded) | Searchable single-value | Combobox (popup trigger) |
| Pick multiple from any-size option list | Multi-select facet | Popover + Command + Checkbox |
| Constrain by date or date range | Date/range filter | Popover + Calendar |
| Match against a text field | Free-text search | Input with debounce |
| Multiple dimensions composed together | Combined filter bar | Horizontal layout of the above |

**The 15-item threshold** is a guideline, not a rule. The real question is: can the user scan the full list without scrolling? If yes, use Select. If no, add search.

**When in doubt, start simple.** A search Input and one ToggleGroup covers most data views. Add facets only when users actually need to filter on multiple independent dimensions simultaneously. Over-engineering the filter bar is as harmful as under-engineering it -- it adds cognitive load and visual clutter to every page visit.
