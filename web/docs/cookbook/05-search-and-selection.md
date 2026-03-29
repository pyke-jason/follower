# Search, Filter & Selection

A decision guide for choosing the right search, filter, and selection patterns. Focuses on user intent and mental models, not implementation.

---

## 1. Command Palette

**When to reach for it.** The user wants to get somewhere or do something fast without lifting their hands from the keyboard. They have a vague target in mind -- a page, a trade, an action -- and want to type a few characters to get there. This is a power-user pattern. It only earns its keep when the app has enough surface area that navigating by mouse is slower than typing.

**The user's mental model.** "I press a shortcut and get a universal search box. I type, it narrows. I pick and it happens." They expect the palette to search across categories -- navigation, entities, actions -- not just one. They expect it to close after a selection and to be dismissable with Escape.

**Components and why.**
- CommandDialog as the overlay. It provides keyboard trapping, focus management, and the full-screen dimmed backdrop that signals "this is modal, type here."
- CommandInput for the search field. Built-in fuzzy matching means you rarely need a custom filter.
- CommandGroup to separate result categories (navigation, actions, recent items). Without groups, a flat list becomes noise when there are more than 10-15 items.
- CommandItem for each selectable result. Fires onSelect, which is where you navigate or dispatch.
- CommandShortcut for inline keyboard hints next to items.

**Flow in plain English.**
1. User presses Cmd+K (or clicks a search trigger in the top bar).
2. The palette opens empty or with recent/suggested items.
3. User types. Results filter in real time across all groups.
4. User arrows to a result and presses Enter, or clicks it.
5. The palette closes. The action fires -- navigation, mutation, whatever the item does.

**Alternatives.**
- If you only need navigation (no actions, no entity search), a simple sidebar or breadcrumb is better. A command palette that only navigates is over-engineered.
- If the user needs to see results in context (previews, metadata), consider a full search page instead. The palette is for quick dispatch, not browsing.

**Mistakes to avoid.**
- Putting too many items in the palette. If there are 200 items, the list becomes useless without grouping and ranking. Curate what appears at the top.
- Forgetting the empty state. When nothing matches, show "No results" -- not a blank box.
- Not closing after selection. The palette must dismiss itself after the user picks something. Leaving it open breaks the "quick dispatch" mental model.
- Making it the only way to reach something. The palette is an accelerator, not a replacement for visible navigation.

---

## 2. Autocomplete / Typeahead

**When to reach for it.** The user needs to pick a specific item from a large or dynamic dataset -- a ticker, a trader, a channel -- and typing is faster than scrolling through a dropdown. The item set might be too large to load upfront, or it might come from an API.

**The user's mental model.** "I start typing and matching suggestions appear. I pick one." They expect suggestions to update as they type, to be able to arrow through them, and to select with Enter. They do not expect to have to type the full value -- partial matches should work.

**Components and why.**
- Combobox as the root. It wires together the input, the dropdown, keyboard navigation, and selection state into one accessible unit.
- ComboboxInput for the text field. This is what the user types into.
- ComboboxContent for the dropdown panel. It positions itself relative to the input.
- ComboboxList and ComboboxItem for the suggestions. Each item is selectable.
- ComboboxEmpty for the "no results" message. Essential for feedback when nothing matches.

**Flow in plain English.**
1. User focuses the input and starts typing.
2. After a short debounce (200-300ms for async, instant for client-side), suggestions appear in a dropdown below the input.
3. User arrows through suggestions or continues typing to narrow further.
4. User selects an item. The input fills with the selection, the dropdown closes.

**Alternatives.**
- If the item set is small (under ~15 items) and static, a plain Select is simpler and more discoverable. The user can scan all options without typing.
- If the user needs to select multiple items, jump to the multi-select pattern below instead of chaining autocomplete selections.
- If the user needs to enter a free-form value that might not be in the list, make sure the combobox allows custom values. Otherwise they get stuck.

**Mistakes to avoid.**
- No loading indicator during async fetches. The user types, nothing happens for 300ms, and they wonder if the input is broken. Show a spinner.
- Triggering search on every keystroke without debouncing. This hammers the API and makes the dropdown flicker.
- Requiring exact matches. If the user types "aapl" and the dataset has "AAPL", case-insensitive matching should still find it.
- Not handling the empty query state. When the input is empty and focused, decide: show nothing, show recents, or show popular items. A blank dropdown is a missed opportunity.

---

## 3. Multi-Select

**When to reach for it.** The user needs to choose several items from a set, and they need to see what they have already picked. Common for assigning tags, selecting traders to filter by, choosing multiple tickers for a watchlist.

**The user's mental model.** "I pick items one at a time. Each one appears as a chip/tag that I can remove. I keep picking until I have the set I want." They expect to see their selections without opening the dropdown. They expect to remove items by clicking an X on the chip or by backspacing.

**Components and why.**
- Combobox in multiple mode. Same accessible foundation as autocomplete, but it holds an array of values instead of a single one.
- ComboboxChips and ComboboxChip for rendering selections as removable tags inline with the input. This is the key visual -- it answers "what have I picked so far?" at a glance.
- ComboboxChipsInput for the text field that lives alongside chips, allowing continued selection without a separate interaction.

**Flow in plain English.**
1. User focuses the input. Existing selections appear as chips.
2. User types to filter, or opens the dropdown to browse.
3. User selects an item. It appears as a new chip. The dropdown stays open for continued selection.
4. User removes a chip by clicking its X, or by backspacing when the input is empty.
5. When done, user clicks away or presses Escape.

**Alternatives.**
- If the options are few (under ~7) and all should be visible at once, a group of Checkboxes is more direct. No dropdown, no typing, just scan and check.
- If the options are binary toggles (on/off for each), ToggleGroup with multiple mode is more compact.
- If the user is building a complex filter with multiple dimensions, this is one facet -- see the faceted filtering pattern below.

**Mistakes to avoid.**
- Not limiting selection count when there is a logical maximum. If only 3 traders can be assigned, disable further selection after 3 and tell the user why.
- Chips wrapping onto multiple lines without the container growing. This hides selections and confuses users. Make sure the container expands or scrolls.
- Clearing all selections on blur. The user expects their picks to persist until explicitly removed.

---

## 4. Filterable Dropdown

**When to reach for it.** The user needs to pick one item from a list that is too long for a plain Select (roughly 15+ items), but the interaction should still feel like a dropdown, not a search box. The user clicks a button, a panel opens, they type to narrow, they pick.

**The user's mental model.** "This looks like a dropdown, but I can search inside it." They expect a trigger button that shows the current selection, a panel that opens on click, and a search field inside the panel. They do not expect the search field to live in the page -- it lives inside the dropdown.

**Components and why.**
- Combobox with a render prop for the trigger. This lets you show a button that looks like a Select trigger (with the current value and a chevron) but opens a searchable panel.
- ComboboxInput placed inside ComboboxContent. The search field is inside the dropdown, not above it. This is what makes it feel like "dropdown with search" rather than "search with dropdown."
- ComboboxList and ComboboxItem for the filtered options.

**Flow in plain English.**
1. User sees a button showing the current selection (or placeholder text).
2. User clicks the button. A dropdown panel opens with a search input at the top and the full list below.
3. User types to filter. The list narrows.
4. User selects an item. The panel closes. The button updates to show the new selection.

**Alternatives.**
- If the list is short enough to scan (under ~15 items), use a plain Select. Adding search to a short list adds friction for no benefit.
- If the user is likely to search by name (not browse), a standalone autocomplete input might be more direct. The "dropdown trigger" framing adds a click.
- If there are logical groupings in the options, add ComboboxGroup headings inside the panel to help the user scan without searching.

**Mistakes to avoid.**
- Not auto-focusing the search input when the panel opens. The user opened it to search -- make typing immediate.
- Search field outside the dropdown. This breaks the "enhanced dropdown" mental model and looks like two separate controls.
- Closing the dropdown on blur of the search input. The user might click an option, which briefly blurs the input. The panel should stay open until an explicit close action.

---

## 5. Date Range Picking

**When to reach for it.** The user needs to constrain data by time -- show trades from the last week, set a backtest window, filter messages to a specific day. The question is whether they need a single date, a range, or preset shortcuts.

**The user's mental model depends on the task:**
- **Single date:** "I need to pick one day." They expect a calendar they can click.
- **Date range:** "I need a start and end." They expect to click a start date, then click an end date, and see the range highlighted between them.
- **Relative range:** "I want last 7 days." They do not want to do calendar math. They want a button.

**Components and why.**
- Calendar for the visual date picker. Set mode to "single" or "range" depending on the need.
- Popover to contain the calendar. It opens from a trigger button and positions itself neatly. The button doubles as the display of the current selection.
- Button as the trigger. Its label reflects the selected date or range in human-readable format.
- For two-month views, set numberOfMonths to 2 on the Calendar so the user can see the range span across months.

**Flow in plain English (range picking).**
1. User sees a button showing the current range (or "Pick a date range").
2. User clicks the button. A popover opens with a two-month calendar.
3. User clicks a start date. The date highlights.
4. User clicks an end date. The range fills in between the two dates.
5. The button updates to show "Mar 1 - Mar 28."

**Alternatives.**
- For relative ranges only (last 7 days, last 30 days, this month), skip the calendar entirely. A ToggleGroup or Select with preset options is faster and eliminates date math errors.
- For precise timestamps (not just dates), you need a time picker alongside the calendar. The Calendar component handles dates only.
- Native date inputs are simpler to implement but inconsistent across browsers and impossible to style. Use them only in admin/internal forms where polish does not matter.

**Mistakes to avoid.**
- Requiring the user to manually type dates in a specific format. Typing "03/28/2026" is error-prone. Let them click a calendar.
- Not showing preset shortcuts alongside the calendar. If 80% of users want "last 7 days," make that one click, not seven.
- Two separate date pickers for start and end. This forces the user to open two popovers and creates opportunities for start > end errors. Use a single range calendar.
- Calendar without month/year navigation. If the user needs to go back 6 months, clicking "previous month" six times is painful. Add dropdown navigation for month and year.

---

## 6. Quick Filter Presets

**When to reach for it.** The user wants to slice data by a common dimension quickly -- time window, status, trade side. The options are few (under ~7), known upfront, and mutually exclusive or combinable. Think "1D / 1W / 1M / All" or "Open / Closed / Trimmed."

**The user's mental model.** "I click a button and the data changes immediately." There is no dropdown, no typing, no popover. The options are always visible. The active one is visually distinct. This is the fastest filter interaction -- one click, instant result.

**Components and why.**
- ToggleGroup for the container. It manages single-select (type "single") or multi-select (type "multiple") state and provides the correct ARIA roles.
- ToggleGroupItem for each option. The active item gets a distinct visual state automatically.

**Flow in plain English.**
1. User sees a horizontal row of filter buttons. One is active (highlighted).
2. User clicks a different button. It becomes active. The data updates immediately.
3. For multi-select variants: clicking an active button deactivates it. Multiple can be active simultaneously.

**Alternatives.**
- If there are more than ~7 options, the bar gets too wide. Switch to a Select or filterable dropdown.
- If the filters have hierarchy or need search, use the faceted filter pattern instead.
- If the options are actions (Export CSV, Export JSON) rather than filters, use a ButtonGroup -- the visual is similar but the semantics are different.
- If you want to show counts next to each option (e.g., "Open (12)"), embed a Badge inside each toggle item.

**Mistakes to avoid.**
- Allowing zero selection in a single-select group. If the user deselects the active toggle and nothing is selected, the data view becomes undefined. Either enforce "always one active" or define what "none selected" means (show all).
- Too many options in the bar. If the bar wraps to a second line, it has failed its purpose of being a quick, scannable control.
- Not indicating the active state clearly enough. The active toggle should be visually obvious -- not just a subtle border change.

---

## 7. Faceted Filtering

**When to reach for it.** The user needs to filter by multiple independent dimensions at the same time -- trader AND status AND side AND date range. Each dimension is a "facet" with its own set of options. Think of shopping site filters: brand, size, color, price, all composable.

**The user's mental model.** "I narrow down results by adding constraints one facet at a time. I can see which filters are active and clear them individually or all at once." They expect each facet to be independent -- selecting a trader does not change the status options. They expect a count on each facet button showing how many values are selected.

**Components and why.**
- One Popover per facet. Each facet gets its own trigger button and dropdown.
- Command inside each popover for search-and-select. When a facet has many options (20+ traders, 50+ tickers), the user needs to type to find their option.
- Checkbox inside each CommandItem for multi-select within the facet. Checkboxes make the multi-select affordance obvious.
- Badge on the trigger button showing the count of selected values for that facet.
- A "Clear filters" button at the bottom of each popover and/or a global "Reset all filters" in the filter bar.

**Flow in plain English.**
1. User sees a row of filter buttons: "Trader," "Status," "Side," etc.
2. User clicks "Trader." A popover opens with a search input and a checkbox list of traders.
3. User checks "Pete" and "Hari." The popover button updates to show "Trader (2)."
4. User clicks "Status." Checks "Open." Button shows "Status (1)."
5. The data view now shows only open trades from Pete and Hari.
6. User clicks the X on the "Trader" badge or a "Clear" button to remove that facet.

**Alternatives.**
- If each facet has only 2-3 options, quick filter presets (ToggleGroups) laid out horizontally are faster. No popover needed.
- If there is only one filter dimension, a single Select or filterable dropdown is sufficient. Faceted filtering earns its complexity when there are 3+ independent dimensions.
- For saved filter combinations ("My open short trades from Pete"), consider a preset dropdown that applies multiple facets at once.

**Mistakes to avoid.**
- Coupling facets so that selecting a value in one changes the options in another. This is valid in some e-commerce contexts but confusing in data tools. Keep facets independent unless you have a strong reason.
- No "clear all" affordance. When the user has 4 facets active and wants to start over, they should not have to clear each one individually.
- Not showing applied filters outside the popovers. If the user closes all popovers, there should still be visible indicators (chips, badges, a filter summary) showing what is active. Hidden filters lead to "why is my list empty?" confusion.
- Popover closing on every checkbox click. The popover should stay open while the user selects multiple values within a facet. It closes on click-outside or Escape.

---

## 8. Search with Context

**When to reach for it.** The user is looking for something but might not know exactly what to type. They benefit from seeing recent searches, suggested items, or categorized results before and during typing. This is richer than a plain autocomplete -- it adapts its content based on whether the user has typed anything.

**The user's mental model.** "I open search and see helpful starting points. If I know what I want, I type. If not, I browse recents or suggestions." They expect two modes in one control: an idle state (showing recents/suggestions) and an active state (showing search results).

**Components and why.**
- Command for the search-and-select behavior, with shouldFilter set to false when results come from the server. This gives you full control over what appears.
- CommandGroup to separate categories: "Recent," "Suggested," "Results." Groups switch visibility based on whether the input has text.
- CommandSeparator between groups for visual clarity.
- Popover or CommandDialog as the container, depending on whether this is inline or overlay.

**Flow in plain English.**
1. User clicks the search trigger (or presses a keyboard shortcut).
2. The search panel opens showing "Recent" and "Suggested" groups. No typing required to see useful content.
3. User starts typing. The recent/suggested groups disappear. A "Results" group appears with live matches, potentially organized by category (Trades, Traders, Messages).
4. User selects a result. The panel closes and the action fires (navigation, selection, etc.).
5. This search gets added to recents for next time.

**Alternatives.**
- If there are no meaningful recents or suggestions to show, a plain autocomplete is simpler. The "contextual" layer only helps when there is useful idle-state content.
- If the search is the primary interface (like a search engine), dedicate a full page to it rather than confining it to a popover or dialog. Full-page search allows richer previews and result layouts.
- The command palette (pattern 1) and this pattern overlap. The difference: the command palette is for dispatch (go somewhere, do something). Search with context is for finding (locate a specific entity). If your app needs both, the palette handles actions and this handles entity lookup.

**Mistakes to avoid.**
- Showing the same content in idle and active states. The whole point is that the content adapts. If the user types and nothing changes, the search feels broken.
- Fetching results on every keystroke without debouncing. Same as autocomplete: debounce 200-300ms.
- Not managing focus correctly. When the panel opens, focus should land in the search input. Arrow keys should navigate results. Enter should select. Escape should close.
- Mixing too many categories in results. If a search returns Trades, Traders, Messages, Tasks, Backtests, and Settings all in one list, the user drowns. Cap it at 3-4 categories with a "See all" link per category.
- No recency tracking. If "recent" items never update, the section becomes stale and the user learns to ignore it.

---

## Decision Tree: Which Pattern Do I Need?

**Start here: what is the user trying to do?**

- **Get somewhere or do something fast, by name**
  - App has many pages/actions, user knows what they want --> Command palette
  - Small app, few destinations --> Just use the sidebar

- **Pick one item from a set**
  - Under ~15 items, all known upfront --> Select
  - 15+ items, or items from an API --> Autocomplete (if inline) or Filterable dropdown (if it should look like a Select)

- **Pick multiple items from a set**
  - Under ~7 options, all visible --> Checkbox group or ToggleGroup (multiple)
  - Many options, need search --> Multi-select with chips

- **Narrow down a data view**
  - One dimension, few options, always visible --> Quick filter presets
  - One dimension, many options --> Filterable dropdown as a filter
  - Multiple independent dimensions --> Faceted filtering
  - Time-based --> Date range picker (possibly combined with presets)

- **Find a specific entity with exploration**
  - User might not know what to search for --> Search with context (recents, suggestions)
  - User knows the name, just needs to type it --> Autocomplete
