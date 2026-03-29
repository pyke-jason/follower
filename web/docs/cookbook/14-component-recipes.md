# Cookbook 14 -- Component Recipes

Low-level assembly diagrams for common UI compositions. Each recipe names the exact shadcn/ui components, shows their nesting hierarchy, and notes the key configuration decisions. No code -- just the wiring map.

Other cookbooks explain **when** to reach for a pattern and **why**. This one explains **which components plug into which** once you have already decided.

---

## 1. Searchable Multi-Select

**Components:**

```
Combobox (multiple)
  ComboboxChips
    ComboboxChip (one per selected value, with remove X)
    ComboboxChipsInput (inline text field alongside chips)
  ComboboxContent
    ComboboxEmpty ("No results")
    ComboboxList
      ComboboxItem (one per option)
```

**When to use.** The user needs to pick several items from a set and see what they have already picked as removable chips. Tag assignment, trader filtering, multi-ticker watchlists.

**Key decisions.**
- Set `multiple` on Combobox to hold an array of values instead of a single one.
- ComboboxChips renders selected values as inline chips with remove buttons. This is the primary affordance that answers "what have I picked so far?"
- ComboboxChipsInput sits after the last chip so the user can keep typing without a separate interaction.
- For async option loading, debounce the input value and swap the list contents. Show a spinner inside ComboboxContent during the fetch.

**Pairs well with.** Filter bars above data tables (cookbook 04, section 3). Facet filters in advanced filter popovers. Form fields where multiple entities are selected.

---

## 2. Searchable Single-Select (Combobox)

**Components:**

```
Popover
  PopoverTrigger (asChild)
    Button (variant="outline", with ChevronsUpDown icon)
  PopoverContent (w-auto, p-0, align="start")
    Command
      CommandInput (placeholder)
      CommandList
        CommandEmpty ("No results")
        CommandGroup
          CommandItem (one per option, with Check icon for selected)
```

**When to use.** The user needs to pick one item from a long list where scanning a plain Select would be too slow. Entity pickers (users, tickers, statuses), form fields that need type-to-search.

**Key decisions.**
- The trigger is a Button inside PopoverTrigger with `asChild`. Display the selected label or a placeholder. ChevronsUpDown icon signals "this is a dropdown."
- PopoverContent gets `className="w-auto p-0"` so Command fills it edge-to-edge.
- Command provides built-in fuzzy search via CommandInput. Set `shouldFilter={false}` only if you are doing server-side filtering.
- CommandItem shows a Check icon (opacity toggled) on the selected item. Close the Popover on selection by calling `setOpen(false)`.
- `align="start"` on PopoverContent keeps the dropdown left-aligned with the trigger.

**Pairs well with.** Form fields where a static Select has too many options. Filter bars where the facet list is large (50+ items). The date picker pattern (recipe 3) follows the same Popover-wraps-content shape.

---

## 3. Date Picker

**Components:**

```
Popover
  PopoverTrigger (asChild)
    Button (variant="outline", with CalendarIcon + formatted date or placeholder)
  PopoverContent (w-auto, p-0)
    Calendar (mode="single", selected, onSelect)
```

**When to use.** The user needs to pick a single date from a calendar grid. Date-of-birth fields, trade entry dates, "filter since" fields.

**Key decisions.**
- The trigger Button displays the formatted date when one is selected, or a muted placeholder ("Pick a date") when empty. Use `data-empty={!date}` to style the empty state with muted foreground.
- PopoverContent gets `className="w-auto p-0"` so the Calendar fills it without extra padding.
- Calendar `mode="single"` returns a single Date. Wire `onSelect` to your state setter.
- For date-of-birth or historical dates, add `captionLayout="dropdown"` to Calendar so the user can jump to a month/year via dropdowns instead of paging month by month.
- `CalendarIcon` from lucide-react goes inside the Button before the date text.

**Pairs well with.** Form layouts (cookbook 02). Filter bars with date constraints. Time picker inputs alongside the date (add a separate time Input below the Calendar inside PopoverContent).

---

## 4. Date Range Picker

**Components:**

```
Popover
  PopoverTrigger (asChild)
    Button (variant="outline", with CalendarIcon + "Jan 20 - Feb 09" or placeholder)
  PopoverContent (w-auto, p-0)
    Calendar (mode="range", selected={dateRange}, onSelect, numberOfMonths=2)
```

**When to use.** The user needs to pick a start and end date. Report date ranges, backtest windows, "show trades between X and Y" filters.

**Key decisions.**
- Same Popover-wraps-Calendar structure as recipe 3, but Calendar gets `mode="range"`.
- `numberOfMonths={2}` shows two month grids side by side so the user can span months without paging. Drop to `numberOfMonths={1}` on narrow screens.
- The selected state is a `DateRange` object with `from` and `to` fields. Display both in the trigger Button, formatted with an en-dash separator.
- The trigger shows a placeholder when neither end is selected, and shows just the start date while the user is mid-selection (from set, to not yet set).

**Pairs well with.** Filter bars above tables (cookbook 04). Settings pages with time-window preferences. Metric strips that scope to a date range.

---

## 5. Confirmation Dialog

**Components:**

```
AlertDialog
  AlertDialogTrigger (asChild)
    Button (variant="destructive" or whatever triggers it)
  AlertDialogContent
    AlertDialogHeader
      AlertDialogTitle ("Are you sure?")
      AlertDialogDescription (explains consequences)
    AlertDialogFooter
      AlertDialogCancel ("Cancel")
      AlertDialogAction ("Delete" / "Confirm", with onClick handler)
```

**When to use.** The user is about to do something irreversible or high-consequence. Hard deletes, bulk operations, environment-changing actions. See cookbook 01 for the decision framework on when confirmation is warranted.

**Key decisions.**
- Use AlertDialog, not Dialog. AlertDialog blocks interaction with the page underneath and provides dedicated Cancel/Action footer components with the right semantics. Dialog is for content viewing; AlertDialog is for decisions.
- AlertDialogAction carries the destructive onClick handler. Style it with `variant="destructive"` on the underlying Button when the action is a delete.
- AlertDialogCancel auto-closes the dialog. No onClick needed.
- For controlled state (opening the dialog from a row action menu, not a static trigger), omit AlertDialogTrigger and manage `open` / `onOpenChange` on AlertDialog directly.

**Pairs well with.** Row action menus (recipe 9) where a destructive DropdownMenuItem opens a confirmation dialog. Bulk action toolbars where "Delete selected" needs a gate. Settings pages with dangerous resets.

---

## 6. Type-to-Confirm Dialog

**Components:**

```
AlertDialog (controlled: open, onOpenChange)
  AlertDialogContent
    AlertDialogHeader
      AlertDialogTitle ("Delete backtest run?")
      AlertDialogDescription ("Type the run name to confirm")
    [form content area]
      Input (value, onChange -- user types the confirmation phrase)
    AlertDialogFooter
      AlertDialogCancel ("Cancel")
      AlertDialogAction (disabled={input !== expectedPhrase}, onClick handler)
```

**When to use.** The consequence is severe enough that a single "Are you sure?" is not enough friction. Deleting an entire dataset, wiping a channel, removing a trader permanently. The typing step forces the user to read and engage rather than reflexively clicking Confirm.

**Key decisions.**
- Controlled mode (no AlertDialogTrigger). The dialog opens in response to a prior action (usually a DropdownMenuItem or a Button elsewhere).
- An Input sits between the header and footer. The user must type an exact phrase (the resource name, "DELETE", etc.).
- AlertDialogAction is `disabled` until the input matches. This is the gate. The button should visually communicate its disabled state (muted colors, no hover effect).
- Clear the Input value when the dialog opens so stale text from a prior opening does not pre-fill.

**Pairs well with.** Settings pages with environment-level destructive actions. Admin panels. Any place where the confirmation dialog (recipe 5) alone is not enough friction.

---

## 7. Form in Dialog

**Components:**

```
Dialog (controlled: open, onOpenChange)
  DialogContent
    DialogHeader
      DialogTitle ("Edit trade" / "New alert")
      DialogDescription (optional context sentence)
    [form content area]
      Label + Input (one per field)
      Label + Select / Combobox (for dropdowns)
      Label + Textarea (for long text)
    DialogFooter
      Button (variant="outline", onClick closes dialog -- "Cancel")
      Button (type="submit" or onClick fires save -- "Save")
```

**When to use.** The user needs to create or edit a record in a focused modal without leaving the current page. Short forms (2-6 fields). For longer forms, consider a full page instead.

**Key decisions.**
- Dialog, not AlertDialog. This is a content interaction, not a binary decision. Dialog gives you a flexible content area without the Cancel/Action footer semantics.
- The form content sits between DialogHeader and DialogFooter. Each field is a Label + Input (or Select, Textarea, etc.) pair.
- DialogFooter holds Cancel and Save buttons. Cancel closes the dialog. Save validates and submits.
- If using react-hook-form or a form library, wrap the form content area in a `<form>` element. The submit Button gets `type="submit"`. Important: the `<form>` must be inside DialogContent, not wrapping Dialog, or form submission will not work.
- Disable the Save button while submitting (swap label for a Spinner). Re-enable on completion or error.
- On successful save, close the dialog and show a success toast (cookbook 08). On error, keep the dialog open and show inline field errors or a toast.

**Pairs well with.** Table row actions where "Edit" opens a form dialog. "New item" buttons above tables. Settings panels where a single setting needs a dedicated edit flow.

---

## 8. Split Pane Master-Detail

**Components:**

```
ResizablePanelGroup (orientation="horizontal")
  ResizablePanel (defaultSize=40, minSize=25)
    ScrollArea
      [list content: Table or stacked rows]
  ResizableHandle (withHandle)
  ResizablePanel (defaultSize=60, minSize=30)
    ScrollArea
      [detail content, or EmptyState when nothing selected]
```

**When to use.** The user is scanning a list and repeatedly drilling into items. They click a row, see its detail, click another row, see that detail -- no open/close ceremony. The list and detail coexist. See cookbook 07, section 1 for the decision framework.

**Key decisions.**
- `orientation="horizontal"` gives side-by-side panels. Use `"vertical"` for stacked layouts on narrow viewports.
- `defaultSize` is a percentage. Give the detail panel the majority (55-60%) since it holds richer content. Give the list panel enough (35-45%) for scannable columns.
- `minSize` on both panels prevents the user from dragging the handle to the edge and losing a panel entirely. 25% minimum for the list, 30% for the detail.
- `withHandle` on ResizableHandle renders a visible drag affordance so the user knows they can resize.
- Both panels get their own ScrollArea so they scroll independently. The user can scroll deep into a detail view while keeping the list at its current scroll position.
- Before any row is selected, the detail panel shows an EmptyState component ("Select a trade to view details"). Not a blank panel.
- Highlight the selected row in the list panel so the user can see which item's detail they are viewing.

**Pairs well with.** Keyboard navigation where arrow keys move the selection and the detail panel updates live. Responsive collapse where narrow screens swap the detail panel for a Dialog.

---

## 9. Row Action Menu

**Components:**

```
DropdownMenu
  DropdownMenuTrigger (asChild)
    Button (variant="ghost", size="icon")
      MoreHorizontal icon
  DropdownMenuContent (align="end")
    DropdownMenuLabel ("Actions")
    DropdownMenuItem ("Edit", with onSelect handler)
    DropdownMenuItem ("Copy ID", with onSelect handler)
    DropdownMenuSeparator
    DropdownMenuItem (variant="destructive", "Delete", opens confirmation)
```

**When to use.** Each row in a table has per-row operations. The primary action (if any) is surfaced as a visible Button in the row. Everything else goes in the "..." menu. See cookbook 04, section 6.

**Key decisions.**
- The trigger is a ghost icon Button with the MoreHorizontal (three dots) icon from lucide-react. Place it in the last cell of the row.
- `align="end"` on DropdownMenuContent keeps the menu flush with the right edge of the trigger, preventing it from overflowing the table.
- Separate destructive items (Delete, Archive) from safe items (Edit, Copy) with a DropdownMenuSeparator.
- Destructive DropdownMenuItems get `variant="destructive"` for red text styling. Their `onSelect` should open a confirmation AlertDialog (recipe 5), not execute immediately.
- For keyboard shortcut hints, add DropdownMenuShortcut inside the DropdownMenuItem.
- Cap at 7-8 items per menu. If you have more, group with DropdownMenuLabel headers or restructure into DropdownMenuSub submenus.

**Pairs well with.** Confirmation dialogs (recipe 5) triggered from destructive menu items. Form-in-dialog (recipe 7) triggered from "Edit" menu items. Bulk action toolbars that complement per-row actions.

---

## 10. Command Palette

**Components:**

```
CommandDialog (controlled: open, onOpenChange)
  CommandInput (placeholder="Type a command or search...")
  CommandList
    CommandEmpty ("No results found")
    CommandGroup (heading="Navigation")
      CommandItem (onSelect navigates)
        [icon + label + CommandShortcut]
    CommandSeparator
    CommandGroup (heading="Actions")
      CommandItem (onSelect dispatches action)
        [icon + label + CommandShortcut]
```

**When to use.** The app has enough surface area that a global keyboard shortcut (Cmd+K) for universal search and action dispatch saves meaningful time. Power-user accelerator pattern. See cookbook 05, section 1.

**Key decisions.**
- CommandDialog is a pre-composed component: it wraps Dialog + Command together so you get the modal overlay, focus trap, and command search in one piece. No need to manually compose Dialog around Command.
- Wire a global `keydown` listener (in a useEffect at the app root) that opens the dialog on Cmd+K / Ctrl+K.
- CommandInput provides built-in fuzzy matching. Set `shouldFilter={false}` only if you are doing your own server-side or custom filtering.
- Separate result categories with CommandGroup (heading="Navigation"), CommandSeparator, CommandGroup (heading="Actions"). Without groups, a flat list becomes noise past 10-15 items.
- Each CommandItem fires `onSelect`. The handler navigates, dispatches, or mutates -- then closes the dialog.
- CommandShortcut inside CommandItem shows keyboard hints (e.g., "Cmd+T") to the right of the label. These are display-only -- the actual shortcut listener lives elsewhere.
- CommandEmpty provides the "No results found" message when the filter matches nothing. Never leave this out.

**Pairs well with.** Top bar search triggers (a search icon Button that also opens the palette). Keyboard shortcut system (cookbook 12). Navigation sidebar as the non-keyboard complement.

---

## 11. Tooltip on Icon Button

**Components:**

```
TooltipProvider (at app root, once)
  Tooltip
    TooltipTrigger (asChild)
      Button (variant="ghost", size="icon")
        [icon from lucide-react]
    TooltipContent (side="bottom" or "top", sideOffset=4)
      "Label text"
```

**When to use.** An icon button has no visible text label, and the user needs to know what it does. Toolbar icons, sidebar collapse toggles, action icons in table rows. See cookbook 07, section 6 for the decision of tooltip vs. HoverCard.

**Key decisions.**
- TooltipProvider must wrap the app once at the root. Without it, tooltips silently fail to render.
- `asChild` on TooltipTrigger so the Button is the actual trigger element, not wrapped in an extra span.
- `side` controls placement relative to the trigger. Use `"bottom"` for toolbar icons, `"right"` for sidebar icons, `"top"` for footer elements. The component auto-flips when it would overflow the viewport.
- `sideOffset` adds pixel spacing between the trigger and the tooltip. 4-8px is standard.
- `delayDuration` on Tooltip (not TooltipContent) controls the hover delay before showing. Default is 700ms. For inspector-style UIs where the user rapidly scans icons, reduce to 100-200ms.
- The tooltip text is purely informational -- never put interactive elements inside TooltipContent. If you need buttons or links, use HoverCard instead.
- For disabled buttons, wrap the Button in a focusable `<span>` so the tooltip still fires, explaining why the action is unavailable.

**Pairs well with.** Toolbars with icon-only buttons. Sidebar navigation icons in collapsed mode. Table row action icons that are not in a DropdownMenu.

---

## 12. Toast with Undo

**Components (programmatic, no JSX nesting):**

```
toast("Item archived", {
  description: "The trade has been moved to the archive.",
  action: {
    label: "Undo",
    onClick: () => undoHandler()
  },
  duration: 8000
})
```

Also requires at app root:

```
Toaster (from sonner, placed in root layout)
```

**When to use.** A soft-destructive action (archive, dismiss, remove from list) benefits from a quick undo path without a confirmation dialog. The action executes immediately, and the toast offers a short window to reverse it. See cookbook 01, section on undo-via-toast, and cookbook 08, section 1.

**Key decisions.**
- `toast()` is called programmatically from your mutation handler. No JSX component tree -- it is imperative.
- `action.label` is the button text inside the toast ("Undo"). `action.onClick` fires when the user clicks it. The toast auto-dismisses after the click.
- Extend `duration` to 8000ms (8 seconds) or more when an undo action is present. The default 4000ms is too short for the user to read and decide.
- The undo handler should reverse the mutation (unarchive, restore, re-add). If the undo window expires without a click, the action is final.
- Use the default (unstyled) toast variant for undo flows, not `toast.success` or `toast.error`. The action is neither a success nor a failure yet -- it is pending the undo window.
- Toaster component from sonner must be mounted once at the app root. Position defaults to bottom-right.

**Pairs well with.** Soft-delete patterns where records are archived, not hard-deleted. Notification dismissals. List item removals that are easily reversible. Bulk operations with a "3 items archived -- Undo" pattern.

---

## 13. Skeleton Table

**Components:**

```
Table
  TableHeader
    TableRow
      TableHead ("Name")
      TableHead ("Status")
      TableHead ("Amount")
      ...real column headers
  TableBody
    TableRow (repeated 5-8 times)
      TableCell
        Skeleton (className="h-4 w-[200px]")
      TableCell
        Skeleton (className="h-4 w-[80px]")
      TableCell
        Skeleton (className="h-4 w-[100px]")
      ...one Skeleton per column
```

**When to use.** A table is loading data and you want to reserve the layout space rather than showing a spinner or a blank area. The skeleton communicates the shape of what is coming. See cookbook 04, section 8, and cookbook 08, section 2.

**Key decisions.**
- Real column headers render immediately. They establish the column layout and tell the user what data to expect. Only the body rows are skeletons.
- Each skeleton TableRow mirrors the real row structure: one TableCell per column, each containing a Skeleton element.
- Match Skeleton widths roughly to expected content. Name columns get wider skeletons (w-[200px]). Status badges get narrow ones (w-[80px]). Numeric columns get medium (w-[100px]). Right-align numeric skeletons to match the real layout.
- Render 5-8 skeleton rows regardless of expected page size. Enough to fill the viewport without looking excessive.
- Skeleton `className="h-4"` matches single-line text height. For rows with avatars or badges, adjust height accordingly (h-6, h-8).
- Replace the entire TableBody (skeletons) with real rows when data arrives. Never mix skeleton rows with real rows.

**Pairs well with.** QueryBoundary or Suspense wrappers that swap loading/loaded states. Empty states (cookbook 04, section 8) for the zero-results case after loading completes. Infinite scroll sentinels that append skeleton rows during the next-page fetch.

---

## 14. Inline Editable Field

**Components:**

```
[display mode]
  span (with the current value, onClick enters edit mode)

[edit mode]
  Input (autoFocus, value, onChange, onBlur saves, onKeyDown handles Enter/Escape)
```

**When to use.** The user needs to edit a single field in place without opening a form dialog. Field labels, trade notes, short text values. The interaction is: click the text, it becomes an input, edit, blur or press Enter to save, press Escape to cancel.

**Key decisions.**
- This is not a shadcn primitive -- it is a micro-pattern composed from a display span and an Input. The component manages its own `isEditing` boolean state.
- In display mode, the span shows the current value. Styling should hint that it is editable: a subtle underline on hover, a pencil icon that appears on hover, or a dashed bottom border.
- On click (or double-click for less accidental triggers), the span swaps to an Input with `autoFocus`. The Input is pre-filled with the current value and auto-selects the text.
- `onBlur` triggers save. `onKeyDown` with Enter also triggers save. `onKeyDown` with Escape reverts to display mode without saving.
- During the save (async), show a brief loading indicator (Spinner replacing the save icon, or a subtle opacity reduction on the field).
- For validation, show inline error text below the Input on failure and keep the field in edit mode so the user can correct it.
- For Select-type inline editing, swap the span for a Select component instead of an Input. Same click-to-edit, blur-to-save pattern.

**Pairs well with.** Detail panels where most fields are read-only but one or two are editable. Table cells with in-place editing (the TanStack Table editable cell pattern). Settings pages with key-value pairs.

---

## 15. Status Badge Mapping

**Components:**

```
Badge (variant from mapping function)
  [status label text]
```

The mapping function:

```
statusConfig: Record<StatusValue, { label: string, variant: BadgeVariant }>
```

Maps each status string to a Badge variant (default, secondary, destructive, outline) and a display label.

**When to use.** A data model has a finite set of status values (open, closed, pending, failed, etc.) and each needs a consistent visual treatment across the app. Tables, detail views, filter chips, cards -- everywhere the status appears, it should look the same.

**Key decisions.**
- Create a single mapping object (or function) that maps each status enum value to `{ label, variant }`. This lives in a shared utility file, not inline in every component.
- Badge `variant` determines the color scheme. Map semantically: `"default"` for primary/active states, `"secondary"` for neutral/inactive, `"destructive"` for error/failed, `"outline"` for draft/pending.
- The `label` in the mapping may differ from the raw status string. Database stores "partial_fill"; the badge displays "Partial Fill."
- For statuses that need colors beyond the four built-in variants, extend the Badge variants via CVA in `components/ui/badge.tsx` (add `"success"`, `"warning"`, etc.) rather than using inline className overrides. This keeps the color system centralized.
- The mapping function is the single source of truth. When a new status is added to the schema, add it to the mapping once and every badge in the app picks it up.
- For dot indicators (a colored circle before the label), add a small `<span>` with a background color class inside the Badge before the label text.

**Pairs well with.** Table cells displaying row status. Filter bars where status options are rendered as Badge-styled chips. Detail view headers showing current state. Combobox items with status indicators (a colored dot + label inside each CommandItem).
