# 12 -- Keyboard-First & Accessibility Patterns

A decision guide for keyboard interactions, focus management, and accessible navigation. This is not about how to wire handlers -- it is about when each pattern earns its place, what the user expects, and where things go wrong.

---

## 1. Global Keyboard Shortcuts

### When to add one

A shortcut deserves to exist when the action it triggers is frequent enough that reaching for the mouse feels like friction. Navigation between top-level pages, opening the command palette, toggling the sidebar -- these qualify. "Delete the third item in a filtered list" does not.

Before adding a shortcut, ask: will the user perform this action more than once per session? If the answer is "sometimes," a shortcut hint inside a menu is enough. If the answer is "constantly," it needs a global listener.

### The input conflict problem

The most common bug in keyboard shortcut systems: typing the letter "n" into a search field triggers "New Trade" because the global listener did not check where focus is. Every global shortcut handler must gate on whether the active element is an input, textarea, or contenteditable region. Single-key shortcuts (letters, "?", "/") are the most dangerous. Modifier combinations (Cmd+K, Cmd+N) are safer because browsers and inputs rarely claim them.

### User mental model

- Modifier + letter = app-wide action (Cmd+K for search, Cmd+B for sidebar).
- Single key without modifier = only works outside of text fields (? for help, / for focus search).
- The shortcut fires the same action regardless of what page is visible.

### Components and why

A document-level keydown listener routes key combinations to handlers. Kbd and KbdGroup render the key-cap visual in buttons, tooltips, and menus. Tooltip wraps any element that displays a shortcut hint on hover or focus.

### Alternatives

- No global shortcuts at all. For a low-frequency tool, this is fine. Shortcuts are a power-user optimization, not a baseline requirement.
- Scoped shortcuts attached to a specific panel's container ref instead of the document. Useful when two panels have conflicting single-key bindings.

### Mistakes to avoid

- Claiming browser-reserved combos (Cmd+T, Cmd+W, Cmd+L). The browser wins and the user loses a tab.
- Registering shortcuts that only apply to one page without cleaning up on unmount. The listener outlives the page and fires on stale state.
- Forgetting platform detection. "Cmd" on macOS is "Ctrl" on Windows/Linux. Show the right modifier or the hint is misleading.

---

## 2. Command Palette

### When it is worth building

A command palette (the Cmd+K pattern) becomes valuable when the app has more than five or six top-level destinations, or when actions exist that have no persistent UI surface (run a backtest, export data, toggle a setting). It is the power-user's universal entry point: search for anything, act on anything, without remembering which menu holds it.

If the app has three pages and two actions, a command palette is overhead. If it has a dozen pages, multiple action types, and a user who returns daily, it pays for itself immediately.

### User mental model

- Cmd+K opens an overlay with a text input.
- Typing filters results instantly. No submit button, no delay.
- Arrow keys move between results, Enter selects.
- Escape closes the palette and returns focus to wherever it was.
- Results are grouped by type: pages in one section, actions in another, recent items at the top.

### Components and why

CommandDialog manages the overlay lifecycle and focus trapping. CommandInput provides the search field. CommandList, CommandGroup, CommandItem, and CommandEmpty handle the filtered result display. CommandShortcut renders inline key hints next to items (so users discover shortcuts organically while browsing).

The underlying Command primitive uses a built-in fuzzy filter. For most apps, client-side filtering over a static list of commands is sufficient. Server-side search (setting shouldFilter to false and fetching externally) only matters when the command set is dynamic or very large.

### Flow in plain English

1. User presses Cmd+K from anywhere.
2. Palette opens with focus on the input. Previous content is cleared.
3. User types a few characters. The list narrows to matching items.
4. User arrow-keys to the desired item and presses Enter.
5. The palette closes. The action fires (navigation, state change, dialog open).

### Alternatives

- A persistent search bar in the top bar instead of an overlay. Simpler, always visible, but cannot host actions -- only navigation.
- A sidebar with pinned favorites. Solves the "too many pages" problem differently, without the ephemeral search-and-act model.

### Mistakes to avoid

- Leaving stale search text when reopening. The palette should reset on open so the user starts fresh.
- Not closing the palette after an action fires. The user acts, then has to manually dismiss -- it breaks flow.
- Putting too many items in a single flat list without groups. Scanning 40 ungrouped results defeats the purpose.
- Forgetting the empty state. "No results found" is better than a blank list that looks broken.

---

## 3. Shortcut Hints in Menus

### When to show them

Shortcut hints belong anywhere a user browses actions by mouse and could benefit from learning the keyboard alternative. Dropdown menus, context menus, and menubars are the natural home. The hint teaches the shortcut; a separate global listener executes it.

This is the primary shortcut discovery mechanism for most users. Few people read documentation. Many people notice "Cmd+E" next to "Export" while clicking through a menu, and start using it next time.

### User mental model

- The hint is right-aligned, visually distinct, secondary to the action label.
- Clicking the menu item and pressing the shortcut do the same thing.
- The shortcut works without the menu open. The menu just teaches it.

### Components and why

DropdownMenuShortcut, ContextMenuShortcut, and MenubarShortcut are display-only components that render right-aligned hint text inside their respective menu items. They do not register any keyboard handler -- that is the global listener's job. Kbd and KbdGroup offer a styled key-cap alternative when the visual weight of a plain text hint is not enough.

### Flow in plain English

1. User clicks a menu trigger.
2. Menu opens. Each item shows its label on the left and shortcut hint on the right.
3. User either clicks the item or notes the shortcut and closes the menu.
4. Next time, user presses the shortcut directly without opening the menu.

### Alternatives

- Tooltip-based hints on toolbar buttons instead of menu-based hints. Works for small sets of actions that already have visible buttons.
- A dedicated shortcut cheat sheet dialog (see section 9). Better for completeness, worse for organic discovery.

### Mistakes to avoid

- Showing a shortcut hint for a key combination that is not actually wired. The hint promises something the app does not deliver. Every displayed shortcut must have a working handler.
- Inconsistent formatting. If one menu says "Cmd+K" and another says "ctrl-k," the user loses trust in the hints.
- Overloading menus with shortcut hints on every item. If 12 of 15 items have shortcuts, the menu becomes cluttered. Reserve hints for the 4-5 most frequently used actions.

---

## 4. Focus Trapping in Modals

### What the user expects

When a dialog, alert, or drawer opens, Tab and Shift+Tab should cycle only through the controls inside it. Focus never leaks to the page behind the overlay. When the overlay closes, focus returns to the element that opened it.

This is not a feature to implement -- it is built into the overlay primitives. The decision is about which overlay to use and when to override the defaults.

### Components and why

Dialog, AlertDialog, and Drawer all trap focus automatically via their underlying Radix (or Vaul) primitives. The differences that matter:

- Dialog closes on Escape and outside click. Good for editing, settings, detail views.
- AlertDialog does not close on Escape or outside click. Good for destructive confirmations where accidental dismissal is dangerous.
- Drawer traps focus and adds swipe-to-dismiss on mobile. Good for bottom sheets on touch devices.

### Flow in plain English

1. User clicks a trigger (button, link, menu item).
2. Overlay opens. Focus moves to the first focusable element inside (or a specific element if overridden via onOpenAutoFocus).
3. User tabs through the overlay's controls. Focus wraps from the last element back to the first.
4. User presses Escape (Dialog/Drawer) or clicks an explicit close/cancel button (AlertDialog).
5. Overlay closes. Focus returns to the trigger that opened it.

### Alternatives

- Non-modal dialog (modal set to false). Disables focus trapping and the backdrop overlay, creating an inline panel that participates in normal tab order. Useful for side panels that coexist with the main content.
- No overlay at all. Inline expansion (accordion, collapsible section) avoids focus trapping entirely and keeps the user in the normal document flow.

### Mistakes to avoid

- Overriding initial focus to an element that is not immediately useful. If a dialog has a form, focus the first input. If it has a warning, focus the primary action button. Do not focus a decorative heading.
- Preventing Escape on a standard Dialog without showing the user why. If unsaved changes block dismissal, the dialog must explain what is happening (a warning message, a "Discard changes?" prompt).
- Using AlertDialog for non-destructive confirmations. Its refusal to close on Escape frustrates users when the stakes are low.

---

## 5. Arrow Key Navigation

### Which components support it out of the box

Several components implement roving tabindex internally, meaning arrow keys move focus between items while Tab moves focus out of the group entirely. This is the correct pattern for sets of related options where Tab-per-item would be tedious.

Components with built-in arrow key navigation:
- TabsList -- Left/Right arrows move between tab triggers (or Up/Down when orientation is vertical). Focus movement selects the tab by default (automatic activation) or just moves focus (manual activation, requiring Enter to confirm).
- RadioGroup -- Arrow keys move selection between radio items in any direction.
- ToggleGroup -- Arrow keys move focus; Space or Enter toggles the focused item.
- Menubar -- Left/Right between top-level menus, Up/Down within a menu's items.
- Command list items -- Up/Down arrows move the highlight, Enter selects.

### User mental model

- Arrow keys move within a group of related choices.
- Tab moves to the next unrelated control.
- Only one item in the group is tabbable at any time. The rest are reachable via arrows only.

### When to choose manual vs. automatic activation

Automatic activation (the default for Tabs) means arrowing to a tab immediately shows its content. This is great when switching is cheap. Manual activation (activationMode set to manual) means the user must press Enter after arrowing to confirm. Choose manual when switching triggers expensive operations like data fetches, so accidental arrow presses do not fire unnecessary requests.

### Alternatives

- A Select dropdown instead of a RadioGroup or ToggleGroup. Collapses the options behind a single trigger, saving space at the cost of discoverability.
- Plain buttons with no arrow key support. Acceptable for small groups (2-3 items) where Tab is not burdensome.

### Mistakes to avoid

- Adding custom arrow key handlers to components that already have them. You end up fighting the built-in behavior and breaking it.
- Mixing roving tabindex groups without clear visual boundaries. If two adjacent groups both respond to arrow keys, the user cannot tell where one ends and the other begins.
- Forgetting the loop prop on TabsList. Without it, arrowing past the last tab dead-ends instead of wrapping to the first.

---

## 6. Escape Key Layering

### How it works

When multiple overlays are open simultaneously (a tooltip inside a popover inside a dialog), pressing Escape should close only the innermost one. The next Escape closes the next layer, and so on outward. Radix primitives handle this automatically by stacking dismiss handlers -- each layer's onEscapeKeyDown fires only when it is the topmost open overlay.

### User mental model

- Escape always closes "the thing I am looking at right now."
- Pressing Escape repeatedly peels layers off one at a time.
- After the last overlay closes, Escape does nothing (it does not navigate backward or clear selections unexpectedly).

### The stacking order

From innermost (dismissed first) to outermost (dismissed last): Tooltip, then DropdownMenu/ContextMenu/Popover, then Sheet/Drawer, then Dialog. AlertDialog is a special case -- it does not close on Escape at all, so it blocks the chain until explicitly dismissed via a button.

### Components and why

Dialog, Popover, Tooltip, DropdownMenu, Sheet, and Drawer all participate in the Radix dismiss stack. No manual coordination is needed. The only decision point is whether to intercept Escape at a specific layer to block dismissal (via onEscapeKeyDown with preventDefault), which is useful for unsaved-changes warnings.

### Alternatives

- Avoiding deep nesting entirely. If a tooltip inside a popover inside a dialog feels like too many layers, it probably is. Consider flattening the interaction so the user never has three overlays open at once.
- Using a non-modal popover or inline content instead of a nested overlay, which sidesteps the stacking question.

### Mistakes to avoid

- Nesting an AlertDialog inside a Dialog and expecting Escape to still reach the outer Dialog. Since AlertDialog absorbs Escape without closing, the chain is broken until the AlertDialog is dismissed via its explicit buttons.
- Adding a custom document-level Escape handler that competes with the Radix stack. The custom handler fires first and closes the wrong thing.
- Blocking Escape at a layer without telling the user why the overlay is not closing. Silent preventDefault on Escape is confusing -- always pair it with visible feedback.

---

## 7. Keyboard-Accessible Tooltips

### The problem they solve

Tooltips that only appear on mouse hover are invisible to keyboard users and screen reader users. Any information conveyed exclusively through a hover tooltip -- shortcut hints, status explanations, disabled-state reasons -- is inaccessible unless the tooltip also opens on keyboard focus.

### Components and why

The Tooltip component (wrapping TooltipTrigger and TooltipContent) responds to both hover and focus by default. Tab-focusing a trigger opens the tooltip instantly with no delay. Escape closes it. This behavior requires no extra configuration -- it is the baseline.

TooltipProvider sets global timing: delayDuration controls the hover delay, and skipDelayDuration reduces the delay when moving quickly between tooltipped items (rapid traversal through a toolbar).

### User mental model

- Hovering shows the tooltip. Tabbing to the same element shows the same tooltip.
- Escape dismisses a focused tooltip without activating the underlying control.
- The tooltip is supplemental. It never contains the only path to critical information.

### Flow in plain English

1. User tabs to an icon-only button.
2. Tooltip appears immediately, showing the button's label and shortcut hint.
3. User reads the tooltip and presses Enter to activate the button, or Tab to move on.
4. Tooltip disappears when focus leaves.

### The disabled button problem

Disabled buttons cannot receive focus by default, which means their tooltip never appears via keyboard. The workaround is wrapping the disabled button in a focusable span (tabIndex 0). This preserves the tooltip's ability to explain why the button is disabled ("Complete all required fields first") without making the button itself interactive.

### Alternatives

- Inline help text below the control instead of a tooltip. Always visible, does not require hover or focus, but takes up space.
- An aria-label on the element itself. Screen readers announce it, but sighted keyboard users see nothing. Use both when the tooltip adds value beyond the accessible name.

### Mistakes to avoid

- Putting interactive content (links, buttons) inside a tooltip. Tooltips are not focusable containers -- the user cannot Tab into them. Use a Popover instead.
- Setting excessively long delayDuration on TooltipProvider. A 700ms delay means a keyboard user sits on a focused button for nearly a second seeing nothing. Keep it at 200-400ms for hover, and note that focus-triggered tooltips ignore the delay entirely.
- Relying on tooltip content as the only way to understand a control. If the tooltip disappears and the user forgets what it said, the information is gone. Critical labels should be visible.

---

## 8. Skip Navigation and Landmarks

### Why they matter

Keyboard users who Tab through a page hit every focusable element in the sidebar, top bar, and navigation before reaching the main content. On a page with 20 nav links, that is 20 Tab presses before they can interact with anything useful. Skip navigation solves this with a single link.

Screen reader users have a different navigation model -- they jump between ARIA landmarks (navigation, main, complementary) rather than tabbing through every element. Proper landmark structure lets them skip entire page regions instantly.

### Components and why

A Button styled as a visually hidden link becomes the skip link. It is the first focusable element on the page, invisible until it receives focus (via a translate transform), then visible as a floating link. Clicking or pressing Enter jumps focus to the main content area.

Beyond the skip link, the structural landmarks are semantic HTML elements: nav for navigation regions, main for the primary content (one per page), aside for supplementary panels, header for the page banner, and section with an aria-label for named content regions.

### User mental model

- First Tab press on any page reveals "Skip to main content."
- Enter jumps past all navigation directly into the content area.
- Screen reader users hear landmark names and can jump between them at will.

### Flow in plain English

1. User loads a page. Focus is at the top of the document.
2. User presses Tab. The skip link appears.
3. User presses Enter. Focus moves to the main content area.
4. User continues tabbing through the content, bypassing all navigation.

### SPA route change caveat

In a single-page app, route changes do not trigger a full page reload, so focus stays wherever it was. After navigating to a new page via the router, focus should be programmatically moved to the main content area. Without this, the keyboard user is stranded in the sidebar after every navigation.

### Alternatives

- Multiple skip links for complex layouts: "Skip to trades table," "Skip to filters," "Skip to detail panel." Useful when the main content itself has distinct sections worth jumping to.
- Relying solely on landmarks without a skip link. Screen reader users benefit; sighted keyboard users do not, because browsers do not expose landmark navigation to non-assistive-technology users.

### Mistakes to avoid

- Forgetting to set tabIndex to -1 on the skip target (the main element). Without it, calling focus() on the element does nothing in some browsers.
- Having duplicate landmarks without distinct aria-labels. Two nav elements with no labels are indistinguishable to screen readers. Give each one a descriptive aria-label ("Primary navigation," "Breadcrumb navigation").
- Placing the skip link after other focusable elements. It must be the first focusable element on the page or it defeats its own purpose.

---

## 9. Shortcut Discoverability

### The problem

Keyboard shortcuts only help users who know they exist. The best shortcut system in the world is useless if the user never discovers it. Discoverability has to be layered: passive (hints users notice while doing other things), active (a place to look when they want to learn), and progressive (shortcuts reveal themselves as the user advances).

### Three layers of discovery

**Passive: hints in context.** Shortcut badges in dropdown menus (section 3), key-cap indicators on buttons, and tooltips that mention the shortcut alongside the action label. The user sees these while performing normal mouse-driven tasks and absorbs shortcuts over time without seeking them out.

**Active: the cheat sheet.** A dialog listing all shortcuts in a scannable grid, opened by pressing "?" or from a help menu. The user goes here deliberately when they want to learn what is available. Group shortcuts by category (navigation, actions, general) and show key combinations using Kbd styling for visual consistency.

**Progressive: first-use hints.** A brief, non-modal callout the first time a user encounters a feature ("Tip: press Cmd+K to open this faster"). Shown once, never again. This bridges the gap between passive hints the user has not noticed yet and the cheat sheet they have not thought to open.

### Components and why

For the cheat sheet: Dialog hosts the overlay, Table organizes shortcuts into rows, Kbd and KbdGroup render the key-cap visuals. For passive hints: DropdownMenuShortcut, Tooltip with Kbd inside. For first-use hints: a dismissible inline callout or toast.

### User mental model

- "I wonder if there is a shortcut for this" leads to pressing "?" or opening the help menu.
- "I noticed Cmd+K in the menu" leads to trying it next time without the menu.
- "I just saw a tip about a shortcut" leads to using it once and remembering it if useful.

### Flow in plain English

1. New user browses menus, notices shortcut hints next to actions they use often.
2. User tries one shortcut. It works. Confidence grows.
3. User presses "?" to see what else is available. Scans the cheat sheet, finds 2-3 new shortcuts worth memorizing.
4. Over days, the user shifts from mouse-first to keyboard-first for high-frequency actions.

### Making the cheat sheet useful

- Group by category, not alphabetically. Users think in terms of "what can I do" not "what letter is it."
- Show only shortcuts for the current context if the set is large. A page-specific cheat sheet is less overwhelming than a global one with 40 entries.
- Make it searchable. If you embed a search input at the top of the cheat sheet, users can type "export" and find the shortcut instantly instead of scanning.

### Alternatives

- Onboarding tour that walks through shortcuts on first use. Higher initial learning, but higher abandonment rate -- most users skip tours.
- No dedicated cheat sheet, relying entirely on passive hints in menus and tooltips. Works for apps with fewer than 10 shortcuts.

### Mistakes to avoid

- Building shortcuts without any discovery mechanism. If the only way to learn about Cmd+K is to read source code, it does not exist for most users.
- Showing a cheat sheet that is out of date. If you add or remove shortcuts, the cheat sheet must update. A single source of truth for the shortcut registry (one array that drives both the handlers and the cheat sheet) prevents drift.
- Overloading first-use hints. If every feature shows a "did you know?" callout, the user learns to ignore all of them. Reserve first-use hints for the 2-3 highest-impact shortcuts.
