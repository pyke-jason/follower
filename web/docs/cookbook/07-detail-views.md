# Detail Views & Inspection

How to let users look deeper at something without losing where they are. Every pattern here answers the same question: the user pointed at a thing and wants more information. The right answer depends on how much information, how long they need it, and whether they intend to act on it.

Never use Sheet for detail views. Prefer Dialog (focused inspection) or ResizablePanelGroup (persistent side-by-side) depending on the workflow.

---

## 1. Split Pane Master-Detail

**When:** The user is scanning a list and repeatedly drilling into items. They want to click a row, see its detail, then click another row without any open/close ceremony. The list and the detail must coexist.

**Why this pattern:** The user's mental model is comparison and triage. They are not focused on a single record -- they are sweeping through many records, glancing at each one. A modal would interrupt the rhythm. A new page would break context. The split pane keeps both views alive simultaneously.

**Components:** ResizablePanelGroup, ResizablePanel, ResizableHandle, ScrollArea.

**How it works in plain English:**

- The page is divided into two panels side by side. The left panel holds the list. The right panel holds the detail for whatever row is currently selected.
- Clicking a row instantly populates the right panel. No animation, no transition -- just content swap.
- Both panels scroll independently. The user can scroll deep into a detail view while keeping the list in its current scroll position.
- The drag handle between panels lets users resize to taste. Set sensible min/max sizes so neither panel can be crushed to nothing.
- Before any row is selected, the right panel shows an empty state with a prompt like "Select a trade."

**Variants:**

- Three-panel (email-client style): add a narrow nav/filter panel on the far left.
- Vertical split: stack list on top and detail below for narrow viewports.
- Collapsible detail: hide the right panel entirely until the first selection, then animate it in.
- Dialog fallback on mobile: detect small screens with useMediaQuery and swap the detail panel for a Dialog instead.

**Alternatives considered:**

- Dialog: works for one-off inspection but kills the scanning rhythm. Reject when the user will inspect more than two or three items in a session.
- Navigating to a detail page: appropriate when the detail is genuinely complex (charts, tabs, sub-tables), but you lose the list context.

**Mistakes to avoid:**

- Forgetting the empty state. A blank right panel with no guidance looks broken.
- Not setting minSize on panels. Users will accidentally drag the handle to the edge and lose a panel.
- Fetching detail on every row click when you already have the data in the list query. If the list response includes enough fields, just display them -- no extra request.
- Making the list panel too narrow by default. If the list needs three or four columns to be scannable, give it at least 40% starting width.

---

## 2. Modal Detail View

**When:** The user clicked a specific item and wants to inspect it in isolation. They do not need the surrounding list. The inspection is a focused moment -- they look, maybe take an action, and then dismiss.

**Why this pattern:** The user's mental model is "open this thing's folder." They want full attention on one record with no visual noise from the list behind it. A dialog centers attention and provides a clear entry/exit boundary. The overlay signals: you are in a temporary context, and you will return to where you were.

**Components:** Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose.

**How it works in plain English:**

- The user clicks a card, row, or link. A centered dialog opens with an overlay dimming the background.
- The dialog header identifies the record. The body is scrollable if the content is long -- the header and footer stay pinned.
- Footer buttons provide the available actions: close, delete, re-run, edit, whatever is relevant.
- Clicking the overlay or pressing Escape closes the dialog and returns the user to exactly where they were.

**Variants:**

- Narrow dialog: use the default max-width for simple detail or forms. Use a wider max-width when the content has grids, charts, or multi-column layouts.
- No close button in the corner: when the footer already has an explicit Close action, the corner X is redundant and can be hidden.
- Responsive: swap to Drawer on mobile screens using useMediaQuery.

**Alternatives considered:**

- Split pane: better when the user is scanning many items. Reject the dialog if the user will open/close it more than a handful of times in a session.
- Full page navigation: better when the detail is so complex it needs its own URL, tabs, and sub-navigation. A dialog that scrolls for three screens is a sign you need a page.

**Mistakes to avoid:**

- Putting too much content in the dialog. If the user has to scroll more than two viewport heights, the content belongs on its own page, not in a modal.
- Not handling the scrollable body correctly. The body must scroll independently while the header and footer stay fixed. Without this, long content pushes the footer off-screen.
- Opening the dialog with stale data. If the list view shows summary data and the dialog needs full detail, fetch the detail when the dialog opens -- not before.

---

## 3. Hover Preview

**When:** The user sees a name, symbol, or link inline and wants a quick glance at what it refers to -- without committing to a click. The information need is shallow: a few stats, an avatar, a status. One or two seconds of hovering, then they move on.

**Why this pattern:** The user's mental model is "peek." They are not investigating; they are confirming a hunch or getting oriented. Clicking would be too heavy -- it would take them somewhere or open something they then need to close. A hover card appears passively and disappears passively. Zero commitment.

**Components:** HoverCard, HoverCardTrigger, HoverCardContent.

**How it works in plain English:**

- The user hovers over a trigger element (a linked name, a symbol, a badge). After a short delay (200ms or so), a floating card appears nearby.
- The card shows a compact summary: avatar, a couple of key metrics, a status badge. Nothing that requires scrolling.
- Moving the mouse away from the trigger or the card dismisses it after a short close delay.
- The trigger is still clickable for full navigation -- the hover card is supplementary, not a replacement.

**Variants:**

- Symbol preview: last price, daily change, and a mini sparkline for a ticker.
- Message preview: hover a timestamp to see the full message text and its classification.
- Positioning: use side="right" when the trigger is in a left sidebar, side="top" for footer elements. Let the component auto-flip when it would overflow the viewport.

**Alternatives considered:**

- Tooltip: better for single-line explanations (field labels, abbreviations). Use HoverCard when the preview needs structure -- multiple fields, an avatar, a grid of stats.
- Dialog: too heavy for this intent. If the user needs to interact with the preview content, upgrade to a Dialog.

**Mistakes to avoid:**

- Making the hover card too large. If it has more than five or six fields, it is no longer a "peek" -- it is a detail view and should be a Dialog or split pane.
- Setting openDelay too low. Anything under 150ms causes flicker as the user moves the mouse across a dense UI. 200ms is a safe starting point.
- Not tuning closeDelay. If the card disappears instantly when the mouse leaves the trigger, the user cannot move into the card to read it. 100-150ms close delay lets the user bridge the gap.
- Putting actions in the hover card. Hover cards are for reading, not doing. If the user needs a button, use a different pattern.

---

## 4. Bottom Drawer on Mobile

**When:** The user is on a touch device and taps an item in a list. They need to see detail and possibly take action, but the screen is too narrow for a split pane and a centered dialog feels unnatural on a phone. The drawer slides up from the bottom edge, matching the native mobile gesture vocabulary.

**Why this pattern:** The user's mental model is "pull up more info." They are used to bottom sheets in native apps. The thumb can reach the drag handle. Snap points allow progressive disclosure: a peek at summary data, then swipe up for the full detail.

**Components:** Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerFooter, DrawerClose.

**How it works in plain English:**

- The user taps an item. A drawer slides up from the bottom, initially resting at a low snap point that shows a summary strip (entry price, current price, P&L).
- Swiping up expands the drawer to a higher snap point, revealing the full detail: legs, decision timeline, chart.
- Swiping down or tapping Dismiss collapses the drawer.
- The overlay dims progressively -- configurable via fadeFromIndex so the first snap point does not dim the background.

**Variants:**

- No snap points: a simple slide-up at a single height for straightforward detail.
- Handle-only drag: prevents conflict between scrolling inside the drawer and the drag-to-dismiss gesture. Essential when the drawer content is itself scrollable.
- Non-dismissible: the user must explicitly tap a button to close. Use this when the drawer represents a required action like confirming a trade exit.
- Responsive desktop: use Dialog on wide screens and Drawer on narrow screens, switching via useMediaQuery.

**Alternatives considered:**

- Dialog on mobile: works but feels non-native. The centered overlay does not match how phone users expect to interact with detail views.
- Full page navigation on mobile: appropriate when the detail is very complex, but loses the "quick peek" quality that makes drawers useful for triage.

**Mistakes to avoid:**

- Not using handleOnly when the drawer content scrolls. Without it, the user's scroll gesture conflicts with the drag-to-dismiss gesture, creating a frustrating tug-of-war.
- Too many snap points. Two is usually right (summary and full). Three is the maximum before the snapping behavior feels unpredictable.
- Forgetting the summary strip at the first snap point. If the low position shows nothing useful, the user has no reason to stop there and the progressive disclosure is wasted.

---

## 5. Expandable Inline Detail

**When:** The user wants to see a bit more about a row without leaving the table. The additional content is small -- a sub-table of legs, a few metadata fields, a short timeline. Not enough to justify a panel or a dialog. Expanding the row in-place keeps everything in the list context.

**Why this pattern:** The user's mental model is "unfold this row." They are not switching context; they are widening their view of one item while keeping the surrounding rows visible. This is the lightest-weight detail pattern -- no overlay, no panel resize, no navigation. Just more content in the same place.

**Components:** Collapsible, CollapsibleTrigger, CollapsibleContent (for individual rows) or Accordion, AccordionItem, AccordionTrigger, AccordionContent (for single-expand behavior across the table).

**How it works in plain English:**

- Each table row has a chevron or is itself clickable. Clicking toggles an expanded region below the row.
- The expanded region spans the full row width and contains the nested detail: a sub-table, a set of key-value pairs, a mini timeline.
- The expanded row is visually distinguished (slightly different background) so it reads as "belonging to" the parent row.
- Clicking the same row again collapses it. Optionally, expanding one row auto-collapses any other expanded row (accordion behavior).

**Variants:**

- Accordion mode (one at a time): lift the open state to the parent and track which row is expanded. Only one row is open at any time. Use the Accordion component for this -- it handles the single-expand constraint natively.
- Multi-expand: each row manages its own open state independently. Good when the user wants to compare expanded detail across rows.
- Expand-all toggle: a button above the table that opens or closes every row at once. Useful for print views or bulk inspection.

**Alternatives considered:**

- Split pane: better when the detail is rich enough to warrant persistent side-by-side viewing. Reject inline expansion when the expanded content would push the table layout beyond recognition.
- HoverCard: too ephemeral. If the user needs to read the detail for more than a couple of seconds or interact with it, inline expansion is more stable.

**Mistakes to avoid:**

- Expanding too much content inline. If the expanded region is taller than two or three rows, it pushes sibling rows out of view and the table becomes disorienting. At that point, switch to a split pane or dialog.
- Not using colSpan correctly. The expanded content must span all columns of the table; otherwise it creates a broken grid layout.
- Forgetting the visual distinction. Without a background tint or border, the expanded content blends into the next row and the table becomes unreadable.
- Animating the expansion too slowly. Keep it snappy (150-200ms) or skip animation entirely. Slow accordion animations feel sluggish in data-dense UIs.

---

## 6. Tooltip Inspection

**When:** The user sees a value -- a status badge, a truncated ID, a metric -- and wants a one-line or two-line explanation without opening anything. The information is supplementary: a definition, a breakdown, a keyboard shortcut hint. Not enough for a HoverCard, definitely not enough for a Dialog.

**Why this pattern:** The user's mental model is "what does this mean?" or "show me the full value." Tooltips are the lightest possible detail mechanism. They answer a micro-question and vanish. They cost the user nothing -- no click, no navigation, no state change.

**Components:** Tooltip, TooltipTrigger, TooltipContent. Requires TooltipProvider at the app root.

**How it works in plain English:**

- The user hovers over (or focuses via keyboard) an element that has additional context. After a short delay, a small floating label appears.
- The tooltip contains a brief explanation: a status definition, a metric breakdown (gross P&L minus commissions equals net), the full text of a truncated ID, or a keyboard shortcut.
- Moving away or blurring the element dismisses the tooltip instantly.

**Variants:**

- Metric breakdown: hover a net P&L value to see gross, commissions, and the math. A mini two-column layout inside the tooltip.
- Truncated ID: hover the abbreviated ID to see the full string. Copy-on-click is a natural companion.
- Keyboard shortcut hint: tooltip on a button showing its hotkey. Helps discoverability without cluttering the button label.
- Disabled-button explanation: wrapping a disabled button in a focusable span so the tooltip still fires, explaining why the action is unavailable.
- Faster response: reduce delayDuration to 100-200ms for inspector-style UIs where the user is rapidly scanning field explanations.

**Alternatives considered:**

- HoverCard: better when the supplementary content has structure (avatar, grid, multiple fields). If the tooltip needs more than three or four lines, upgrade to a HoverCard.
- Inline text: sometimes the explanation should just be visible all the time (a muted description below a field). Tooltips hide information; do not use them for content the user needs to see without hovering.

**Mistakes to avoid:**

- Putting critical information only in a tooltip. If the user needs to know something to use the UI correctly, it should be visible, not hidden behind a hover.
- Making tooltip content too long. If you are writing a paragraph, it is not a tooltip -- use a HoverCard or inline description.
- Forgetting keyboard accessibility. Tooltip must also appear on focus, not only on hover. The TooltipTrigger handles this automatically as long as the trigger element is focusable.
- Not wrapping the app in TooltipProvider. Without it, tooltips silently fail to render.

---

## 7. Fullscreen Takeover

**When:** The user is entering an immersive editing mode -- configuring a complex form, editing a multi-section document, or working in a code editor. They need the entire viewport. Outside interaction should be blocked. Accidental dismissal would lose work.

**Why this pattern:** The user's mental model is "I am now inside this thing." They are not peeking or scanning -- they are working. The fullscreen takeover communicates: this is a committed session. You will save or discard when you are done. Nothing else is accessible until then.

**Components:** Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose, ScrollArea.

**How it works in plain English:**

- The user clicks an "Edit" or "Configure" button. A Dialog opens at near-full viewport size (95vw by 95vh or similar).
- The close button in the corner is hidden. Clicking outside the dialog is intercepted and does nothing. Pressing Escape is intercepted when there are unsaved changes.
- The dialog body is a scrollable work area. The header and footer are pinned.
- The footer has explicit Save and Discard buttons. These are the only way out.
- If the user clicks Discard with unsaved changes, a nested AlertDialog asks for confirmation before closing.

**Variants:**

- Escape allowed when clean: only block Escape when the form has been modified. When nothing has changed, let Escape close normally.
- Partial takeover: a large but not fullscreen dialog (e.g., max-w-4xl, 80vh) for cases where the editing is complex but not immersive enough to justify the full viewport.
- Loading guard: disable save and discard buttons during async save to prevent double-submit or premature close.

**Alternatives considered:**

- Navigating to a dedicated page: avoids the modal complexity but requires URL routing, back-button handling, and risks the user navigating away and losing work. The dialog approach keeps everything self-contained.
- A regular-sized Dialog: if the editing UI is simple (a few fields), a standard dialog is sufficient. Reserve the fullscreen takeover for genuinely complex editing surfaces.

**Mistakes to avoid:**

- Forgetting the dirty-state check on Escape. If the user presses Escape with unsaved edits and the dialog closes, they lose work silently. Always intercept Escape when dirty.
- Not providing a discard confirmation. The Discard button is destructive -- it throws away work. It needs its own confirmation step (an AlertDialog, not a toast).
- Making the dialog truly 100vw/100vh. Leave a thin margin so the user can see the overlay edge and understand they are still in a dialog, not on a new page.
- Blocking Escape when the form is clean. If nothing has changed, trapping the user is hostile.

---

## 8. Choosing Between Patterns

Use this decision tree when you are unsure which detail pattern fits.

**Start here: how many items will the user inspect in one session?**

- **Many (scanning/triage):** Split pane master-detail. The user is sweeping through a list and needs the detail to update instantly on each click. No open/close ceremony.
- **A few (focused inspection):** Dialog. The user wants to look at one item at a time with full attention.
- **One (immersive editing):** Fullscreen takeover. The user is committing to a work session inside a single record.

**How much detail are we showing?**

- **A sentence or a single value:** Tooltip. Status definitions, truncated IDs, metric breakdowns.
- **A small card (3-6 fields):** HoverCard if the need is passive (no click required). Expandable inline row if the user needs to study it for more than a glance.
- **A moderate amount (scrollable but bounded):** Dialog or split pane, depending on scanning frequency.
- **A lot (tabs, sub-tables, charts):** Split pane, a dedicated page, or fullscreen takeover.

**Is the user on mobile?**

- **Yes, and the detail is moderate:** Drawer (bottom sheet). It matches native mobile interaction patterns.
- **Yes, and the detail is heavy:** Navigate to a dedicated page.
- **No:** Split pane or Dialog depending on the scanning frequency question above.

**Does the user need to act on the detail?**

- **No actions, just reading:** HoverCard, Tooltip, or expandable row. Keep it passive.
- **Light actions (close, delete, re-run):** Dialog with footer buttons.
- **Heavy editing:** Fullscreen takeover with save/discard flow and dirty-state protection.

**Can we show it without an overlay?**

- Prefer non-overlay patterns (split pane, expandable row) when the user needs to reference the surrounding context while looking at the detail.
- Use overlay patterns (Dialog, Drawer) when the detail is a self-contained moment and the surrounding context is not needed.

**Summary table:**

| Pattern | Interaction cost | Context preserved | Best for |
|---|---|---|---|
| Tooltip | Zero (hover) | Full | Field explanations, abbreviations |
| HoverCard | Zero (hover) | Full | Entity previews, quick stats |
| Expandable row | One click | High (list stays visible) | Shallow sub-detail within a table |
| Split pane | One click | High (list + detail coexist) | Scanning and triage workflows |
| Dialog | One click + dismiss | Low (overlay hides list) | Focused single-item inspection |
| Drawer (mobile) | One tap + swipe | Medium (progressive reveal) | Touch-friendly detail on phones |
| Fullscreen takeover | One click + save/discard | None (blocked) | Immersive editing sessions |
