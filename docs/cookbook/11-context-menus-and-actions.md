# 11 -- Context Menus & Action Patterns

A decision guide for surfacing actions in the right place, at the right time, with the right weight. Every pattern here answers the same question: **where does the user expect to find this action, and how important is it relative to everything else on screen?**

---

## 1. Row-Level Actions (the "..." Overflow Menu)

### User mental model

"I'm scanning a list. Most rows I'll skip. For the few I care about, I want to act without leaving this view." The user's eyes are on the row. The action should be reachable from the row, not from a toolbar or a page header.

### When to use

- A table or list where each row represents a distinct entity (trade, task, message).
- The entity has 3+ possible actions, most of which are infrequent.

### What goes inside vs. what gets surfaced

**Surface as visible buttons** (outside the menu, directly in the row):
- The single most common action -- the one users perform on >50% of rows they interact with. Typically "View" or "Edit."
- Binary toggles that benefit from glanceable state (starred, active/paused).

**Keep inside the overflow menu:**
- Everything else. Edit, duplicate, copy ID, export, assign, archive.
- Destructive actions go last, below a visual separator, styled as destructive.

**Decision tree:**
- Will the user do this to most rows? Surface it.
- Is it a toggle the user needs to see the current state of? Surface it.
- Everything else? Overflow menu.

### Components and why

DropdownMenu triggered by a ghost icon Button (MoreHorizontal icon). Ghost variant because the trigger should be visually quiet -- it's furniture, not a call to action. Align the menu to the end of the row so it doesn't obscure the row's data.

Use DropdownMenuSeparator to visually fence destructive items. Use DropdownMenuLabel at the top if the row context isn't obvious from position alone (e.g., "Trade #1234").

### Flow in plain English

User sees a row. Optionally clicks the surfaced primary action directly. Or clicks "..." at the row's trailing edge. A menu appears anchored to that button. Non-destructive actions appear first. A separator, then destructive actions in red. User picks one. The menu closes and the action fires.

### Alternatives

- **Swipe actions** on mobile (not applicable for desktop-first apps).
- **Inline editing** -- if the most common action is "edit a single field," skip the menu entirely and make the cell editable on click.
- **Row click navigates to detail** -- if most interactions need a detail view anyway, make the whole row clickable and move all actions to the detail page.

### Mistakes to avoid

- Putting too many actions in the visible row. Two is fine. Three is crowded. Four is a toolbar pretending to be a table.
- Hiding the only action users care about inside the menu. If everyone clicks "..." just to hit "Edit," surface "Edit" directly.
- Forgetting to scope the menu to the row's entity. If the menu fires a callback, it must close over the correct row ID -- not the last-rendered one.
- Omitting the separator before destructive items. Users scan menus fast. The visual break is the only speed bump before "Delete."

---

## 2. Right-Click Context Menus

### User mental model

"I know what I want to do. I'm looking at the thing. Let me right-click and act on it directly." This is a power-user shortcut. The user already knows the action exists -- they're reaching for a faster path.

### When to use

- The surface already has a visible action path (overflow menu, detail page). Right-click is a shortcut, never the only path.
- Card grids, kanban boards, tree views, or any layout where a "..." button per item would create visual noise.
- Desktop-oriented apps where right-click is a learned behavior.

### When to skip

- Mobile-first or touch-heavy interfaces. Long-press is unreliable and undiscoverable.
- If the right-click menu would duplicate the "..." menu item-for-item with no additional value. Redundancy for its own sake adds maintenance cost without user benefit.

### Components and why

ContextMenu wrapping the target element (card, row, node). The ContextMenu component family mirrors DropdownMenu exactly -- same item types, same separator, same submenus -- but triggers on right-click instead of left-click.

### Flow in plain English

User right-clicks a card or row. A menu appears at the cursor position. It contains the same actions as the overflow menu, possibly with extras that make sense only in context (e.g., "Open in new tab"). User picks an action. Menu closes.

### Alternatives

- **Hover-reveal toolbar** -- a row of small icon buttons that appear on mouse enter. More discoverable than right-click but noisier.
- **Just the "..." menu.** If your user base isn't power-user-heavy, the overhead of maintaining two parallel menus isn't worth it.

### Mistakes to avoid

- Making right-click the **only** way to reach an action. It's invisible. New users will never find it.
- Showing a context menu that conflicts with the browser's native context menu in text-heavy areas. If the user might want to copy-paste text, don't hijack right-click on that surface.
- Forgetting to keep the context menu and the overflow menu in sync. If "Archive" exists in one, it should exist in both. Divergence confuses users who use both paths.

---

## 3. Split Buttons

### User mental model

"I usually want the default, but sometimes I want a variant." The split button says: "Here's the obvious action. And here's a small door to alternatives."

### When to use

- There's a clear primary action (Submit, Save, Send) with 2-3 less common alternatives (Schedule, Save as Draft, Send Later).
- The alternatives are variations of the same verb, not unrelated actions.

### When to skip

- If there's no dominant default. When all options are equally likely, use a plain DropdownMenu button instead.
- If the alternatives are dangerous or irreversible. Burying "Delete All" behind a tiny chevron is a trap, not a convenience.

### Components and why

ButtonGroup joins two Buttons visually: the primary action on the left, a chevron-only icon Button on the right that triggers a DropdownMenu. The ButtonGroupSeparator draws the dividing line between them.

### Flow in plain English

User sees a button that says "Submit." Clicking it does exactly that -- submit, immediately. If the user wants an alternative, they notice the small chevron to the right, click it, and a menu drops down with "Schedule for later" and "Save as draft." Picking one fires that variant instead.

### Alternatives

- **Radio group + single button** -- if the choice is sticky (user tends to pick the same alternative repeatedly), let them set the mode separately and keep a single action button.
- **Two distinct buttons side by side** -- if both actions are equally important, don't subordinate one inside a dropdown.

### Mistakes to avoid

- Making the chevron area too small. It needs a comfortable click target. An icon-sized Button is the minimum.
- Dynamically swapping the primary label based on the last-chosen alternative. This sounds clever but disorients users who expect the button to always say "Submit." Only do this if user research confirms the behavior is wanted.
- Using split buttons for navigation. They're for actions (verbs), not for choosing where to go.

---

## 4. Toolbars

### User mental model

"These are my tools. They're always here. I reach for them without thinking." Toolbars work when the user is in a mode -- editing, formatting, managing -- and needs rapid access to a family of related operations.

### When to use

- Rich text editing, drawing, or any creation-focused view.
- Admin panels where the user manages entities in bulk and needs filter/sort/action controls grouped together.
- Any view where the user performs multiple different operations on the same content without navigating away.

### Anatomy of a good toolbar

Group related actions into visual clusters separated by vertical Separators.

- **Cluster 1: Undo/Redo or navigation** -- always leftmost. Universal, muscle-memory actions.
- **Cluster 2-N: Domain actions** -- grouped by category. Text formatting in one cluster, alignment in another, insert actions in a third.
- **Last position: Overflow** -- a DropdownMenu for infrequent actions that don't deserve permanent toolbar space.

Within a cluster:
- Fire-and-forget actions (undo, delete) use plain Buttons with ghost variant.
- Toggleable state (bold on/off) uses ToggleGroup items. Use type "multiple" for independent toggles, type "single" for mutually exclusive modes.

### Components and why

ButtonGroup for action clusters. ToggleGroup for stateful options. Separator (vertical) between clusters. All wrapped in a flex container with a border to frame it as a cohesive unit.

### Flow in plain English

User enters an editing or management mode. The toolbar appears (usually at the top of the content area). They click tools as needed -- bold, align center, undo -- without opening menus. Toggle states reflect the current selection. When done, they leave the mode and the toolbar may disappear or become inactive.

### Alternatives

- **Contextual floating toolbar** -- appears near the selection (like Medium's formatting bar). Better for occasional formatting in primarily reading views. Worse for sustained editing.
- **Sidebar panel** -- if there are too many options for a single horizontal row, a vertical sidebar with grouped sections works better than a cramped toolbar.

### Mistakes to avoid

- Toolbar with 20+ items and no grouping. Without separators, it's a wall of icons. Users can't build spatial memory.
- Using a toolbar for actions that apply to the whole page rather than the current content. Page-level actions (save, publish, delete) belong in the page header, not in a content toolbar.
- Icon-only buttons without tooltips. Toolbars rely on icons for density, but icons without labels are guessing games for new users. Every icon button needs a tooltip (use the Tooltip component) and an aria-label.

---

## 5. App-Level Menubars

### User mental model

"This is a full application, not a web page. I expect File/Edit/View menus like any desktop app." The menubar signals permanence, depth, and professionalism.

### When to use

- Desktop-feel applications: IDEs, design tools, admin dashboards that replace a native app.
- The app has enough global operations to fill multiple menu categories (file operations, view toggles, help resources).
- Users are likely to look for keyboard shortcuts and expect them displayed in menus.

### When to skip

- Simple CRUD apps. A menubar on a task list is ceremony without substance.
- Mobile or responsive-first apps. Menubars don't adapt well to narrow screens.
- When the app has fewer than ~8 global actions total. A single settings page or a toolbar handles it better.

### Structure

Menubar renders a horizontal bar of triggers. Each trigger opens a dropdown panel. Within panels:

- **Items** for actions, each with an optional shortcut hint (display-only -- keyboard handlers are wired separately).
- **Separators** between logical groups.
- **Submenus** for nested choices (e.g., Export with CSV/JSON sub-options).
- **Checkbox items** for toggleable view options (show sidebar, show minimap).
- **Radio groups** for mutually exclusive settings (theme: light/dark/system).
- **Labels** for titled sections within a panel.

### Components and why

Menubar and its family: MenubarMenu, MenubarTrigger, MenubarContent, MenubarItem, MenubarSeparator, MenubarSub, MenubarCheckboxItem, MenubarRadioGroup, MenubarRadioItem, MenubarShortcut. Use Kbd in tooltips elsewhere to keep shortcut rendering consistent with the menubar's shortcut hints.

### Flow in plain English

User sees the menubar at the top of the app, always present. They click "File" and see New, Open, Export (with a submenu), Close. Each item shows its keyboard shortcut on the right. They click "Export," hover into the submenu, and pick "CSV." The menu closes and the export begins.

For toggle-style items: user clicks "View," sees "Sidebar" with a checkmark. They click it to uncheck -- sidebar hides. The checkmark disappears. Next time they open "View," the state is accurately reflected.

### Alternatives

- **Command palette** (Cmd+K) -- for power users who'd rather type than browse menus. These complement menubars; they don't replace them.
- **Top bar with icon buttons** -- simpler, more web-native. Better when the action count is manageable.

### Mistakes to avoid

- Displaying keyboard shortcuts in the menu without actually wiring them. The shortcut hint is a promise. Breaking it destroys trust.
- Deep nesting. One level of submenus is fine. Two levels means the information architecture needs rethinking.
- Menus with only one item. If "Help" contains only "About," merge it into another menu or use a standalone button.

---

## 6. Floating Action Buttons

### User mental model

"There's one thing I do most on this page: create something new." The floating action button (FAB) is a permanent invitation. It hovers over content, always reachable, always saying "the primary action is right here."

### When to use

- The page's primary action is "create new" -- new trade, new message, new note.
- The page is mostly a consumption view (a list, a feed) where creation is the main escape hatch.
- Mobile-first or mobile-friendly layouts where bottom-right is prime thumb territory.

### When to skip

- Pages with multiple equally important actions. A FAB implies one dominant action. If there are three, none of them should float.
- Dense data views (spreadsheets, dashboards) where a floating element obscures content.
- If the page already has a clear "Create" button in the header. Two create buttons is confusing.

### Single vs. multi-action

**Single action:** One Button, fixed to the bottom-right corner, rounded, elevated with a shadow. Click fires the action directly. Use the Plus icon by convention.

**Multi-action (speed dial):** The Button triggers a DropdownMenu that opens upward (side "top"). Contains 2-4 creation options. More than 4 options means the FAB is doing too much -- use a dedicated creation page instead.

### Components and why

Button with fixed positioning, high z-index, rounded-full class, and shadow. For multi-action, wrap with DropdownMenu opening to side "top" with a sideOffset to clear the button itself.

### Flow in plain English

User scrolls through a list of trades. In the bottom-right corner, a prominent round button with a "+" icon floats above the content. They click it. Either: a form opens directly (single-action), or a small upward menu offers "New Trade," "New Note," and "New Message" (multi-action). They pick one and are taken to the creation flow.

### Alternatives

- **Header button** -- "New Trade" in the page header. More discoverable for first-time users, doesn't obscure content, but requires scrolling to the top on long lists.
- **Empty state call-to-action** -- when the list is empty, the entire page becomes the creation prompt. Great for first-run, useless once items exist.

### Mistakes to avoid

- Positioning the FAB over critical content, especially the last row of a list. Add bottom padding to the content area so the FAB has clear space.
- Using a FAB for non-creation actions (settings, filter, search). The pattern is so strongly associated with "create" that repurposing it causes confusion.
- Multiple FABs. There can be only one. If you need two floating buttons, one of them isn't actually primary -- move it somewhere else.

---

## 7. Bulk Action Bars

### User mental model

"I've selected a bunch of items. Now show me what I can do with them, and tell me how many I've got." The bulk action bar is reactive -- it doesn't exist until the user enters selection mode. Its appearance is confirmation that the system understands the user's intent.

### When to use

- Tables or lists with checkboxes for multi-select.
- The user needs to perform the same action (tag, archive, delete, export) across multiple items at once.
- Item counts can realistically reach 5+ in a single selection.

### Anatomy

The bar appears at the bottom of the viewport (fixed) or the bottom of the container (sticky). It contains:

1. **Selection count** -- a Badge showing "{N} selected." This is the most important element. It confirms scope.
2. **Separator** -- visual break between the count and the actions.
3. **Action buttons** -- ordered by frequency, left to right. Non-destructive first.
4. **Destructive actions** -- styled as destructive, positioned last.
5. **Clear selection** -- a ghost button at the far right. Always present. Always easy to reach.

### Components and why

Badge for the count. Button for each action (outline variant for non-destructive, destructive variant for delete). Separator (vertical) between the count and the actions. The whole bar is a fixed/sticky div that conditionally renders when selection count > 0.

### Flow in plain English

User checks a checkbox on a row. The bulk action bar slides up from the bottom. It says "1 selected" with buttons for Tag, Archive, and Delete. User checks two more rows. The badge updates to "3 selected." User clicks "Archive." A confirmation may appear (especially for destructive actions via AlertDialog). On confirm, all three items are archived, the bar disappears, and checkboxes clear.

If the user changes their mind, they click "Clear" and the bar disappears.

### Alternatives

- **Per-row actions only** -- simpler, but painful when the user needs to archive 20 items one by one.
- **"Select all" + single action** -- a top-of-table "Select all" checkbox with a single dropdown. Works when there's really only one bulk action.
- **Toolbar transforms** -- instead of a separate bar, the page toolbar changes its contents when items are selected. More integrated but can disorient users who lose their familiar toolbar.

### Mistakes to avoid

- Not communicating scope. The count badge is mandatory, not optional. Without it, users can't verify they selected the right items before acting.
- Keeping the bar visible after the action completes. If the user clicked "Delete" and all selected items are gone, clear the selection and dismiss the bar immediately.
- Forgetting "select all across pages." If the table is paginated, does "select all" mean this page or all pages? Ambiguity here causes data loss. If you support cross-page selection, say so explicitly: "All 847 trades selected."
- Bulk destructive actions without confirmation. Single-row delete might not need a dialog. Bulk delete always needs one. Use AlertDialog.
- Placing the bar where it overlaps the last table rows. Add bottom padding to the scrollable area to compensate for the bar's height.

---

## 8. Copy-to-Clipboard

### User mental model

"I need this value somewhere else. Let me grab it." Copying is a micro-interaction -- fast, forgettable, but infuriating when the feedback is missing. The user clicks "copy" and needs to know, within 200ms, that it worked.

### When to use

- IDs, URLs, tokens, code snippets, configuration values -- anything the user will paste into another context.
- Table cells with long values that are truncated visually.
- Share flows where the user copies a link rather than picking a destination.

### The feedback loop

This is the entire point. Copying without feedback is indistinguishable from failure. Two mechanisms, use at least one:

1. **Icon swap** -- the copy icon becomes a checkmark for ~2 seconds, then reverts. Instant, silent, local to the button.
2. **Toast** -- a Sonner toast saying "Copied to clipboard." More noticeable, good when the copy button isn't in the user's direct line of sight (e.g., inside a dropdown menu that closes after selection).

When in doubt, use both. The icon swap confirms what happened. The toast confirms it to a user who might have looked away.

### Components and why

Button (ghost, small or icon-only) for standalone copy triggers. DropdownMenuItem for copy actions inside menus. Sonner toast for the notification. Local component state for the icon swap timer.

### Placement patterns

- **Next to a value** -- inline copy button beside a truncated ID or URL in a table cell or detail view.
- **Inside an overflow menu** -- "Copy Trade ID" as a DropdownMenuItem or ContextMenuItem.
- **On a code block or config snippet** -- top-right corner of the block.
- **Share button** -- copies a URL. Label it "Copy Link" not just "Copy" to clarify what's being copied.

### Flow in plain English

User sees a trade ID like "trd_8f3k...2x9p" with a small copy icon next to it. They click the icon. The icon changes to a checkmark. A toast says "Copied to clipboard." Two seconds later, the checkmark reverts to the copy icon. The user pastes the full ID into their search tool.

Or: user opens a row's "..." menu, clicks "Copy Trade ID." The menu closes. A toast confirms the copy. The user pastes elsewhere.

### Alternatives

- **Click-to-select** -- clicking the value selects the full text so the user can Cmd+C. Lower-friction for technical users, but no visual feedback and doesn't work on truncated values.
- **No explicit copy button, rely on right-click > Copy.** Only acceptable for full-text values that aren't truncated. Fails for IDs and tokens that are visually shortened.

### Mistakes to avoid

- No feedback at all. The user clicks, nothing visible happens, and they have no idea if it worked. This is the most common mistake.
- Toast without context. "Copied!" is less helpful than "Trade ID copied." Name the thing.
- Clipboard API failures. `navigator.clipboard.writeText` can fail in non-secure contexts or when the document isn't focused. Handle the error -- show a toast error, or fall back to selecting the text.
- Overusing copy buttons. Not every piece of text needs one. Reserve them for values the user is likely to use outside the app. If everything is copyable, nothing stands out.
