# shadcn/ui Cookbook

An intent-driven guide to picking the right shadcn/ui components. Open with a task in mind ("I want a searchable single-select", "I want a sidebar dashboard") and find the right composition, a linked example, and the trade-off against alternatives.

- **Examples** live in [`examples/`](examples/) — single-component demos.
- **Blocks** live in [`blocks/`](blocks/) — full-page templates (dashboards, logins, sidebars, charts).
- **Components** live in [`components/`](components/) — one file per shadcn primitive.

Every intent below links to real examples. Click through to see working code.

---

## Pick a value

### I want a short dropdown of fixed options

**Composition:** `Select` + `SelectTrigger` + `SelectContent` + `SelectItem` (with optional `SelectGroup` / `SelectLabel`).

**Why this and not Combobox:** `Select` is a compact styled trigger with no search; use it when the option list is short and stable (status, country, role). Skip it for long lists or when users want keyboard-first filtering.

**Examples:**
- [select-demo](examples/select-demo.md) — grouped + labeled baseline
- [select-scrollable](examples/select-scrollable.md) — long scrollable list
- [field-select](examples/field-select.md) — inside a form Field

**See also:** [select](components/select.md).

### I want a searchable single-select (combobox)

**Composition:** `Popover` + `Command` + `Button` (as trigger via `asChild`).

**Why this and not Select:** `Combobox` (the Popover+Command pattern) adds a `CommandInput` with client-side filtering and `CommandEmpty` state — the right call once option count grows past ~20 or users expect typeahead.

**Examples:**
- [combobox-demo](examples/combobox-demo.md) — baseline pattern
- [combobox-popover](examples/combobox-popover.md) — popover-styled variant
- [combobox-dropdown-menu](examples/combobox-dropdown-menu.md) — dropdown-styled variant
- [combobox-responsive](examples/combobox-responsive.md) — swaps to `Drawer` on mobile

**Key building blocks:** `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem` (see [command](components/command.md)).

### I want an SSR-friendly or form-encoded dropdown

**Composition:** `NativeSelect` + `NativeSelectOption`.

**Why this:** Wraps a real `<select>`; submits via native `FormData`, works without JS, and is the right pick for server-rendered forms or very-low-JS contexts.

**Examples:**
- [native-select-demo](examples/native-select-demo.md)
- [native-select-groups](examples/native-select-groups.md)
- [native-select-disabled](examples/native-select-disabled.md)
- [native-select-invalid](examples/native-select-invalid.md)

### I want one-of-many with all options visible (radio group)

**Composition:** `RadioGroup` + `RadioGroupItem` + `Label`.

**Why this and not Select:** Use radios when all options should be visible without a click, typically 2–5 choices (subscription tier, permission level).

**Examples:**
- [radio-group-demo](examples/radio-group-demo.md) — baseline
- [field-radio](examples/field-radio.md) — paired with `Field` / `FieldSet`
- [field-choice-card](examples/field-choice-card.md) — rich "card" style choices with title + description

### I want a boolean toggle

**Composition:** `Switch` + `Label`, or `Checkbox` + `Label`.

**Why one over the other:** Use `Switch` for immediate settings that take effect on change (airplane mode, notifications). Use `Checkbox` inside forms where the user opts in and submits (terms acceptance, filters).

**Examples:**
- [switch-demo](examples/switch-demo.md) — airplane-mode pattern
- [field-switch](examples/field-switch.md) — inside a Field
- [checkbox-demo](examples/checkbox-demo.md)
- [checkbox-with-text](examples/checkbox-with-text.md) — with description
- [checkbox-disabled](examples/checkbox-disabled.md)
- [field-checkbox](examples/field-checkbox.md) — inside a Field

### I want a pressable icon that stays on/off

**Composition:** single `Toggle` for solo controls; `ToggleGroup` + `ToggleGroupItem` for clustered formatting toolbars.

**Why this and not Switch:** `Toggle` is an unlabeled (icon-only) on/off that looks like a button — good for editor toolbars (bold/italic) and view-mode switches.

**Examples:**
- [toggle-demo](examples/toggle-demo.md) — basic icon toggle
- [toggle-with-text](examples/toggle-with-text.md) — icon + text
- [toggle-outline](examples/toggle-outline.md), [toggle-lg](examples/toggle-lg.md), [toggle-sm](examples/toggle-sm.md), [toggle-disabled](examples/toggle-disabled.md)
- [toggle-group-demo](examples/toggle-group-demo.md) — multi-select group
- [toggle-group-single](examples/toggle-group-single.md) — single-select group
- [toggle-group-outline](examples/toggle-group-outline.md), [toggle-group-lg](examples/toggle-group-lg.md), [toggle-group-sm](examples/toggle-group-sm.md), [toggle-group-spacing](examples/toggle-group-spacing.md), [toggle-group-disabled](examples/toggle-group-disabled.md)

### I want a numeric range picker

**Composition:** `Slider` (controlled with `defaultValue` / `value` / `onValueChange`).

**Why this:** Continuous numeric input where an exact typed value isn't important (volume, price ceiling). Pair with an `Input` for precision.

**Examples:**
- [slider-demo](examples/slider-demo.md)
- [field-slider](examples/field-slider.md) — inside a Field

### I want a date picker

**Composition:** `Popover` + `Calendar` + `Button` (with `CalendarIcon`).

**Why this:** shadcn does not ship a `DatePicker` primitive — it is a composition. Start with `calendar-demo` for the inline picker; wrap in a `Popover` for a compact trigger.

**Examples:**
- [calendar-demo](examples/calendar-demo.md) — inline calendar with `mode="single"`
- [calendar-hijri](examples/calendar-hijri.md) — alternate locale
- [date-picker-demo](examples/date-picker-demo.md) — `Popover + Calendar` trigger
- [date-picker-with-range](examples/date-picker-with-range.md) — `mode="range"`, two months
- [date-picker-with-presets](examples/date-picker-with-presets.md) — presets via `Select` inside the popover

### Picker decision table

| You want... | Use | Not |
|---|---|---|
| 2–20 fixed options, no search | `Select` | `Combobox` (overkill) |
| Many options + typeahead | `Combobox` (`Popover` + `Command`) | `Select` |
| Always-visible one-of-many | `RadioGroup` | `Select` |
| Multi-select small set | Multiple `Checkbox` or `ToggleGroup` | `Select` (doesn't multi-natively) |
| No-JS / native form submit | `NativeSelect` | `Select` |
| Single date | `Popover` + `Calendar` (`mode="single"`) | `Input type="date"` |
| Date range | `Calendar` with `mode="range"` | two separate pickers |
| Command palette opened by `⌘K` | `CommandDialog` | `Combobox` |

---

## Type a value

### I want a plain text input

**Composition:** `Input` with `type`, `placeholder`, optional `Label`.

**Examples:**
- [input-demo](examples/input-demo.md) — minimal
- [input-with-label](examples/input-with-label.md)
- [input-with-text](examples/input-with-text.md) — helper text
- [input-disabled](examples/input-disabled.md)
- [input-file](examples/input-file.md) — file input
- [input-with-button](examples/input-with-button.md) — input + submit button

### I want a multi-line input

**Composition:** `Textarea` (optionally `InputGroup` + `InputGroupTextarea` for add-ons).

**Examples:**
- [textarea-demo](examples/textarea-demo.md) — minimal
- [textarea-with-label](examples/textarea-with-label.md)
- [textarea-with-text](examples/textarea-with-text.md)
- [textarea-with-button](examples/textarea-with-button.md)
- [textarea-disabled](examples/textarea-disabled.md)
- [input-group-textarea](examples/input-group-textarea.md) — textarea inside an input group (chat composer style)

### I want an input with icons, prefixes, or buttons attached

**Composition:** `InputGroup` + `InputGroupInput` (or `InputGroupTextarea`) + one or more `InputGroupAddon` (with `align="inline-end"`, `"block-end"`, etc.) containing `InputGroupText`, `InputGroupButton`, or icons.

**Why this and not raw `Input`:** `InputGroup` handles focus styling, layout, and spacing so you don't hand-build `absolute`-positioned icons. Use it any time an input needs a prefix, suffix, inline button, counter, or spinner.

**Examples:**
- [input-group-demo](examples/input-group-demo.md) — comprehensive patterns (search, https prefix, textarea with toolbar, verified badge)
- [input-group-icon](examples/input-group-icon.md)
- [input-group-text](examples/input-group-text.md) — static text addon
- [input-group-label](examples/input-group-label.md)
- [input-group-button](examples/input-group-button.md) — inline button
- [input-group-button-group](examples/input-group-button-group.md) — input group + button group composed
- [input-group-dropdown](examples/input-group-dropdown.md) — dropdown trigger inside the input
- [input-group-tooltip](examples/input-group-tooltip.md)
- [input-group-spinner](examples/input-group-spinner.md) — loading state inside the input
- [input-group-custom](examples/input-group-custom.md)

**See also:** [input-group](components/input-group.md).

### I want a verification code / OTP input

**Composition:** `InputOTP` + `InputOTPGroup` + `InputOTPSlot` (with optional `InputOTPSeparator`).

**Why this:** Segmented slots with native paste, autofill, and keyboard navigation baked in.

**Examples:**
- [input-otp-demo](examples/input-otp-demo.md) — 6-digit with separator
- [input-otp-controlled](examples/input-otp-controlled.md)
- [input-otp-pattern](examples/input-otp-pattern.md) — restrict to chars/digits
- [input-otp-separator](examples/input-otp-separator.md)

---

## Trigger an action

### I want a button

**Composition:** `Button` with a `variant` (`default`, `outline`, `secondary`, `ghost`, `destructive`, `link`) and/or `size`.

**Examples:**
- [button-demo](examples/button-demo.md), [button-default](examples/button-default.md)
- Variants: [button-outline](examples/button-outline.md), [button-secondary](examples/button-secondary.md), [button-ghost](examples/button-ghost.md), [button-destructive](examples/button-destructive.md), [button-link](examples/button-link.md)
- [button-icon](examples/button-icon.md) — icon-only (square)
- [button-with-icon](examples/button-with-icon.md) — icon + label
- [button-size](examples/button-size.md), [button-rounded](examples/button-rounded.md)

### I want a link that looks like a button

**Composition:** `<Button asChild>` wrapping a framework link element (`<Link>`, `<a>`).

**Why `asChild`:** Keeps the button styles but renders the child element — avoids `<button>` inside `<a>` antipatterns.

**Examples:**
- [button-as-child](examples/button-as-child.md)

### I want a loading button

**Composition:** `Button` with `disabled` + `Spinner` as the first child, then the label.

**Examples:**
- [button-loading](examples/button-loading.md) — minimal
- [spinner-button](examples/spinner-button.md) — across variants

### I want a cluster of related buttons

**Composition:** `ButtonGroup` wrapping `Button`s and/or nested `ButtonGroup`s (use `ButtonGroupSeparator` for split buttons, `ButtonGroupText` for static labels).

**Why this and not a flex div:** `ButtonGroup` handles shared borders, rounded corners at the ends, and nested orientation. The children can be mixed (`Button`, `Input`, `Select`, dropdown triggers).

**Examples:**
- [button-group-demo](examples/button-group-demo.md) — toolbar with nested groups + overflow menu
- [button-group-split](examples/button-group-split.md) — split button pattern (primary + icon)
- [button-group-dropdown](examples/button-group-dropdown.md) — button + dropdown trigger
- [button-group-nested](examples/button-group-nested.md)
- [button-group-orientation](examples/button-group-orientation.md) — vertical stacks
- [button-group-separator](examples/button-group-separator.md)
- [button-group-size](examples/button-group-size.md)
- [button-group-input](examples/button-group-input.md) — input + action button
- [button-group-input-group](examples/button-group-input-group.md) — composed with `InputGroup`
- [button-group-popover](examples/button-group-popover.md)
- [button-group-select](examples/button-group-select.md)

---

## Confirm / warn / notify

| You want... | Use | Not |
|---|---|---|
| Passive, inline status message | `Alert` | `AlertDialog` (blocking) |
| Confirm a destructive/irreversible action | `AlertDialog` | `Dialog` (doesn't imply confirmation semantics) |
| Ephemeral success/error/info after an action | `toast` from `sonner` | `Alert` (sticky) |
| "Nothing here yet" placeholder inside a region | `Empty` | `Alert` |

### I want a static inline alert

**Composition:** `Alert` + `AlertTitle` + `AlertDescription`, plus an icon as the first child. Supports `variant="destructive"`.

**Examples:**
- [alert-demo](examples/alert-demo.md) — default, title-only, and destructive
- [alert-destructive](examples/alert-destructive.md)

### I want to confirm a destructive action

**Composition:** `AlertDialog` + `AlertDialogTrigger` (as a `Button`) + `AlertDialogContent` (`Header` / `Title` / `Description` / `Footer` with `Cancel` and `Action`).

**Why this and not `Dialog`:** `AlertDialog` is modal and cannot be dismissed by clicking outside; it is announced as an alert dialog to assistive tech — the semantically correct choice for "are you sure?" flows.

**Examples:**
- [alert-dialog-demo](examples/alert-dialog-demo.md)

### I want a transient toast notification

**Composition:** call `toast()` (or `toast.success/error/info/warning/promise`) from `sonner`. Mount `<Toaster />` (see [sonner](components/sonner.md)) once at the app root.

**Examples:**
- [sonner-demo](examples/sonner-demo.md) — `toast(...)` with description + action
- [sonner-types](examples/sonner-types.md) — `success`, `info`, `warning`, `error`, `promise`

### I want an empty state

**Composition:** `Empty` + `EmptyHeader` (`EmptyMedia`, `EmptyTitle`, `EmptyDescription`) + `EmptyContent` (calls to action).

**Examples:**
- [empty-demo](examples/empty-demo.md) — icon + title + primary/secondary actions
- [empty-icon](examples/empty-icon.md)
- [empty-avatar](examples/empty-avatar.md)
- [empty-avatar-group](examples/empty-avatar-group.md) — "invite your team" pattern
- [empty-outline](examples/empty-outline.md)
- [empty-background](examples/empty-background.md)
- [empty-input-group](examples/empty-input-group.md) — 404 with inline search

---

## Show progress / loading

| You want... | Use | Not |
|---|---|---|
| Indeterminate activity indicator | `Spinner` | `Progress` |
| Known % completion | `Progress` | `Spinner` |
| Content-shaped placeholder while fetching | `Skeleton` | `Spinner` (full-region) |

### I want a spinner

**Composition:** `Spinner` — standalone, or inside `Button`, `Item`, `Badge`, `InputGroup`.

**Examples:**
- [spinner-basic](examples/spinner-basic.md), [spinner-demo](examples/spinner-demo.md) — inside an `Item` row
- [spinner-size](examples/spinner-size.md), [spinner-color](examples/spinner-color.md), [spinner-custom](examples/spinner-custom.md)
- [spinner-button](examples/spinner-button.md) — loading button
- [spinner-badge](examples/spinner-badge.md)
- [spinner-item](examples/spinner-item.md)
- [spinner-empty](examples/spinner-empty.md) — inside `Empty`
- [spinner-input-group](examples/spinner-input-group.md) — inside `InputGroup`
- [input-group-spinner](examples/input-group-spinner.md) — various "searching..." patterns

### I want a determinate progress bar

**Composition:** `Progress` with a `value` prop (0–100).

**Examples:**
- [progress-demo](examples/progress-demo.md)

### I want a skeleton placeholder

**Composition:** one or more `Skeleton` elements sized to the content you're waiting on.

**Examples:**
- [skeleton-demo](examples/skeleton-demo.md) — avatar + two text rows
- [skeleton-card](examples/skeleton-card.md) — card-shaped placeholder

---

## Reveal more

### I want an FAQ-style expandable list

**Composition:** `Accordion` + `AccordionItem` + `AccordionTrigger` + `AccordionContent`. Use `type="single" collapsible` for one-at-a-time, `type="multiple"` for independent.

**Examples:**
- [accordion-demo](examples/accordion-demo.md) — product FAQ

### I want a single show/hide toggle

**Composition:** `Collapsible` + `CollapsibleTrigger` + `CollapsibleContent`.

**Why this and not Accordion:** `Accordion` is built for lists of items (manages focus between triggers). `Collapsible` is one toggle — "show 3 more repos".

**Examples:**
- [collapsible-demo](examples/collapsible-demo.md) — "X starred N repositories"

### I want a rich hover preview

**Composition:** `HoverCard` + `HoverCardTrigger` (as a link/`Button`) + `HoverCardContent`.

**Why this and not Tooltip:** `Tooltip` is short text about the trigger itself (a11y label). `HoverCard` is a richer peek (avatar, description, metadata) — mouse-only, not keyboard-triggered.

**Examples:**
- [hover-card-demo](examples/hover-card-demo.md) — `@nextjs` profile peek

### I want a tiny hover label

**Composition:** `Tooltip` + `TooltipTrigger` (use `asChild`) + `TooltipContent`.

**Examples:**
- [tooltip-demo](examples/tooltip-demo.md)

### I want a small floating editor / panel on click

**Composition:** `Popover` + `PopoverTrigger` (`asChild`) + `PopoverContent`.

**Examples:**
- [popover-demo](examples/popover-demo.md) — dimensions editor

---

## Overlay a surface

Use this table to pick the right overlay.

| You want... | Use | Not |
|---|---|---|
| Modal form / content requiring user attention | `Dialog` | `Popover` (dismissible, not modal) |
| Confirm destructive action | `AlertDialog` | `Dialog` (no alert semantics) |
| Side panel from edge (settings / nav / filters) | `Sheet` | `Dialog` |
| Mobile bottom sheet / drag-to-dismiss | `Drawer` | `Sheet` |
| Responsive modal → drawer on small screens | `Dialog` + `Drawer` with `useMediaQuery` | either alone |
| Small floating editor relative to a trigger | `Popover` | `Dialog` |

### I want a modal dialog

**Composition:** `Dialog` + `DialogTrigger` (`asChild`) + `DialogContent` (`DialogHeader` → `DialogTitle` / `DialogDescription`, body, `DialogFooter` with `DialogClose`).

**Examples:**
- [dialog-demo](examples/dialog-demo.md) — edit profile form
- [dialog-close-button](examples/dialog-close-button.md) — share link with copy

### I want a side panel (sheet)

**Composition:** `Sheet` + `SheetTrigger` + `SheetContent` (`side="top"|"right"|"bottom"|"left"`) + `SheetHeader` / `SheetFooter` / `SheetClose`.

**Examples:**
- [sheet-demo](examples/sheet-demo.md)
- [sheet-side](examples/sheet-side.md) — all four sides

### I want a bottom-drawn drawer (mobile-friendly)

**Composition:** `Drawer` + `DrawerTrigger` + `DrawerContent` (`DrawerHeader` / `DrawerTitle` / `DrawerDescription`, body, `DrawerFooter` + `DrawerClose`).

**Examples:**
- [drawer-demo](examples/drawer-demo.md) — goal stepper with chart

### I want a modal that becomes a drawer on mobile

**Composition:** branch at render time using `useMediaQuery` — render `Dialog` when desktop, otherwise `Drawer`. Keep the form body extracted so both paths share it.

**Examples:**
- [drawer-dialog](examples/drawer-dialog.md) — edit profile responsive pattern

---

## Menus and commands

### I want a menu of actions triggered by a button

**Composition:** `DropdownMenu` + `DropdownMenuTrigger` (`asChild` wrapping a `Button`) + `DropdownMenuContent` containing `DropdownMenuItem`, optional `DropdownMenuLabel`, `DropdownMenuSeparator`, `DropdownMenuShortcut`, `DropdownMenuGroup`, `DropdownMenuSub`, `DropdownMenuSubTrigger`, `DropdownMenuSubContent`.

**Examples:**
- [dropdown-menu-demo](examples/dropdown-menu-demo.md) — labels, groups, shortcuts, submenu
- [dropdown-menu-checkboxes](examples/dropdown-menu-checkboxes.md) — `DropdownMenuCheckboxItem`
- [dropdown-menu-radio-group](examples/dropdown-menu-radio-group.md) — `DropdownMenuRadioGroup` / `RadioItem`
- [dropdown-menu-dialog](examples/dropdown-menu-dialog.md) — menu item that opens a Dialog (the standard "More actions → Edit…" pattern)

### I want a right-click menu

**Composition:** `ContextMenu` + `ContextMenuTrigger` wrapping the region + `ContextMenuContent` (same item types as dropdown).

**Examples:**
- [context-menu-demo](examples/context-menu-demo.md)

### I want an app-style menu bar (File / Edit / View)

**Composition:** `Menubar` + one or more `MenubarMenu` (each with `MenubarTrigger` + `MenubarContent` containing `MenubarItem`, `MenubarCheckboxItem`, `MenubarRadioGroup`, `MenubarSeparator`, `MenubarShortcut`, `MenubarSub`).

**Examples:**
- [menubar-demo](examples/menubar-demo.md)

### I want a command palette (⌘K)

**Composition:** `CommandDialog` (opened from a keyboard shortcut) containing `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandSeparator`, `CommandShortcut`. For non-dialog usage, nest `Command` inside any container.

**Examples:**
- [command-demo](examples/command-demo.md) — inline `Command`
- [command-dialog](examples/command-dialog.md) — ⌘J-triggered palette with grouped items and shortcuts

### I want a dark / light mode toggle

**Composition:** `DropdownMenu` of three items (Light / Dark / System) setting theme via `useTheme` from `next-themes`, with a `Button` trigger that animates `Sun`/`Moon` icons.

**Examples:**
- [mode-toggle](examples/mode-toggle.md)

---

## Navigate

### I want breadcrumbs

**Composition:** `Breadcrumb` + `BreadcrumbList` + `BreadcrumbItem` + `BreadcrumbLink` (or `BreadcrumbPage` for the current), separated by `BreadcrumbSeparator`. Collapse long trails with `BreadcrumbEllipsis` (+ `DropdownMenu`).

**Examples:**
- [breadcrumb-demo](examples/breadcrumb-demo.md) — with ellipsis dropdown
- [breadcrumb-link](examples/breadcrumb-link.md)
- [breadcrumb-separator](examples/breadcrumb-separator.md)
- [breadcrumb-dropdown](examples/breadcrumb-dropdown.md)
- [breadcrumb-ellipsis](examples/breadcrumb-ellipsis.md)
- [breadcrumb-responsive](examples/breadcrumb-responsive.md) — collapses into drawer/dropdown on mobile

### I want tabs

**Composition:** `Tabs` (with `defaultValue`) + `TabsList` of `TabsTrigger` + one `TabsContent` per tab.

**Examples:**
- [tabs-demo](examples/tabs-demo.md) — account / password with `Card`s inside

### I want a top-nav with rich flyouts

**Composition:** `NavigationMenu` + `NavigationMenuList` + `NavigationMenuItem` (each with `NavigationMenuTrigger` + `NavigationMenuContent`, or a plain `NavigationMenuLink`). Use `navigationMenuTriggerStyle()` for links styled like triggers.

**Examples:**
- [navigation-menu-demo](examples/navigation-menu-demo.md) — multiple flyout styles (grid, list, icons), with a responsive `viewport` tweak

### I want pagination controls

**Composition:** `Pagination` + `PaginationContent` + `PaginationItem`s containing `PaginationPrevious`, `PaginationLink` (with `isActive`), `PaginationEllipsis`, `PaginationNext`.

**Examples:**
- [pagination-demo](examples/pagination-demo.md)

### I want an app sidebar

**Composition:** `SidebarProvider` wrapping `Sidebar` + `SidebarInset`. Inside `Sidebar`: `SidebarHeader`, `SidebarContent` (with `SidebarGroup` → `SidebarGroupLabel` / `SidebarGroupContent` / `SidebarMenu` / `SidebarMenuItem` / `SidebarMenuButton`), `SidebarFooter`. `SidebarTrigger` inside `SidebarInset` toggles collapsed state.

**Examples (pieces):**
- [sidebar-demo](examples/sidebar-demo.md) — baseline with grouped menu
- [sidebar-header](examples/sidebar-header.md), [sidebar-footer](examples/sidebar-footer.md)
- [sidebar-group](examples/sidebar-group.md), [sidebar-group-action](examples/sidebar-group-action.md), [sidebar-group-collapsible](examples/sidebar-group-collapsible.md)
- [sidebar-menu](examples/sidebar-menu.md), [sidebar-menu-sub](examples/sidebar-menu-sub.md), [sidebar-menu-collapsible](examples/sidebar-menu-collapsible.md), [sidebar-menu-badge](examples/sidebar-menu-badge.md), [sidebar-menu-action](examples/sidebar-menu-action.md)
- [sidebar-controlled](examples/sidebar-controlled.md) — external open state
- [sidebar-rsc](examples/sidebar-rsc.md) — server-component-friendly

**Full-page templates:** [sidebar-01](blocks/sidebar-01.md) through [sidebar-16](blocks/sidebar-16.md) cover every common layout (grouped nav, collapsible groups, icons, teams, sub-sidebars, inset, floating).

---

## Lay out content

### I want a card

**Composition:** `Card` + `CardHeader` (`CardTitle`, `CardDescription`, optional `CardAction` for right-aligned controls) + `CardContent` + `CardFooter`.

**Examples:**
- [card-demo](examples/card-demo.md) — login card
- [card-with-form](examples/card-with-form.md)

### I want a horizontal divider or vertical rule

**Composition:** `Separator` (pass `orientation="vertical"` inside a flex row).

**Examples:**
- [separator-demo](examples/separator-demo.md) — horizontal and vertical together

### I want to constrain an image's aspect ratio

**Composition:** `AspectRatio` with `ratio={16/9}` wrapping an `<img>` or `<Image>`.

**Examples:**
- [aspect-ratio-demo](examples/aspect-ratio-demo.md)

### I want a scrollable region with styled scrollbars

**Composition:** `ScrollArea` around the scrollable content, sized with className height/width.

**Examples:**
- [scroll-area-demo](examples/scroll-area-demo.md) — vertical tag list
- [scroll-area-horizontal-demo](examples/scroll-area-horizontal-demo.md)

### I want user-resizable panes

**Composition:** `ResizablePanelGroup` (`orientation="horizontal"|"vertical"`) + `ResizablePanel`s separated by `ResizableHandle` (optionally `withHandle`).

**Examples:**
- [resizable-demo](examples/resizable-demo.md) — nested panels
- [resizable-demo-with-handle](examples/resizable-demo-with-handle.md) — visible grip handle
- [resizable-handle](examples/resizable-handle.md)
- [resizable-vertical](examples/resizable-vertical.md)

### I want a carousel

**Composition:** `Carousel` + `CarouselContent` + `CarouselItem`s + `CarouselPrevious` / `CarouselNext`. Pass `plugins` for autoplay, `orientation` for vertical, `opts` for spacing.

**Examples:**
- [carousel-demo](examples/carousel-demo.md) — baseline
- [carousel-size](examples/carousel-size.md) — multi-item-per-view
- [carousel-spacing](examples/carousel-spacing.md)
- [carousel-orientation](examples/carousel-orientation.md) — vertical
- [carousel-api](examples/carousel-api.md) — wire up external controls via the API ref
- [carousel-plugin](examples/carousel-plugin.md) — autoplay via `embla-carousel-autoplay`

---

## Build a form

### I want a form with validation (React Hook Form + Zod)

**Composition:** `useForm` from `react-hook-form` with `zodResolver` + `Field` / `FieldGroup` / `FieldLabel` / `FieldDescription` / `FieldError` from the `field` primitive, wrapping `Input` / `Textarea` / `Select` / `Checkbox` / `RadioGroup` / `Switch`. Submit via `form.handleSubmit(onSubmit)`; show server/validation feedback with `sonner` toasts.

**Examples (one per input type):**
- [form-rhf-demo](examples/form-rhf-demo.md) — Title + description with character counter
- [form-rhf-input](examples/form-rhf-input.md)
- [form-rhf-textarea](examples/form-rhf-textarea.md)
- [form-rhf-select](examples/form-rhf-select.md)
- [form-rhf-checkbox](examples/form-rhf-checkbox.md)
- [form-rhf-radiogroup](examples/form-rhf-radiogroup.md)
- [form-rhf-switch](examples/form-rhf-switch.md)
- [form-rhf-password](examples/form-rhf-password.md)
- [form-rhf-array](examples/form-rhf-array.md) — dynamic list via `useFieldArray`
- [form-rhf-complex](examples/form-rhf-complex.md) — multi-section form

### I want to lay out form fields without a library

**Composition:** `FieldGroup` → `FieldSet` (with `FieldLegend`) → `Field` (with `FieldLabel`, `FieldDescription`, `FieldError`) wrapping any input. Use `orientation="horizontal"` for inline rows; `FieldSeparator` between sections; `FieldContent` + `FieldTitle` for card-like choices.

**Examples:**
- [field-demo](examples/field-demo.md) — payment form with fieldsets
- [field-group](examples/field-group.md)
- [field-fieldset](examples/field-fieldset.md)
- [field-input](examples/field-input.md), [field-textarea](examples/field-textarea.md), [field-select](examples/field-select.md)
- [field-checkbox](examples/field-checkbox.md), [field-radio](examples/field-radio.md), [field-switch](examples/field-switch.md), [field-slider](examples/field-slider.md)
- [field-choice-card](examples/field-choice-card.md) — radio group rendered as tappable cards with titles + descriptions
- [field-responsive](examples/field-responsive.md)

### Form composition decision table

| You want... | Use |
|---|---|
| Client form with Zod schema | RHF + `zodResolver` + `Field` — [form-rhf-demo](examples/form-rhf-demo.md) |
| Dynamic list of inputs | `useFieldArray` — [form-rhf-array](examples/form-rhf-array.md) |
| Card-style radio choices | `Field` + `RadioGroup` + `FieldContent` — [field-choice-card](examples/field-choice-card.md) |

---

## Show data in tables

### I want a simple read-only table

**Composition:** `Table` + `TableCaption` + `TableHeader` / `TableBody` / `TableFooter` + `TableRow` + `TableHead` / `TableCell`.

**Examples:**
- [table-demo](examples/table-demo.md) — invoices with footer total

### I want a sortable / filterable / paginated data table

**Composition:** `Table` primitives + `@tanstack/react-table` (`useReactTable` + `getCoreRowModel`, `getSortedRowModel`, `getFilteredRowModel`, `getPaginationRowModel`) + `Input` for filtering + `DropdownMenu` (`DropdownMenuCheckboxItem`) for column visibility + `Checkbox` for row selection + a `DropdownMenu` in an action column.

**Why this and not just `Table`:** TanStack Table owns sort/filter/paginate/select state — the shadcn `Table` just styles the markup. Combining them is the standard admin data-grid pattern.

**Examples:**
- [data-table-demo](examples/data-table-demo.md) — columns, selection, sorting, filter, pagination, column-visibility menu, row actions

### I want a virtualized list or table (large datasets)

**Composition:** `TableVirtuoso` from `react-virtuoso` for tables, or `Virtuoso` for plain lists. TanStack Table still owns sort/filter/select/paginate state; pass `totalCount`, `fixedHeaderContent`, and `itemContent` from your table model to `TableVirtuoso`.

**Why Virtuoso:** Renders only visible rows — essential for 1 000+ row datasets where full-DOM rendering causes jank. `TableVirtuoso` is the purpose-built pairing for TanStack Table; `Virtuoso` handles any long scrollable list.

---

## Show data in charts

All charts are built on Recharts and the shadcn `ChartContainer` / `ChartConfig` system.

**Composition (common):** `ChartContainer config={...}` wrapping a Recharts chart; use `ChartTooltip` + `ChartTooltipContent` and `ChartLegend` + `ChartLegendContent` for themed tooltips and legends.

**Baseline example:** [chart-bar-demo](examples/chart-bar-demo.md) (+ [chart-bar-demo-axis](examples/chart-bar-demo-axis.md), [chart-bar-demo-grid](examples/chart-bar-demo-grid.md), [chart-bar-demo-legend](examples/chart-bar-demo-legend.md), [chart-bar-demo-tooltip](examples/chart-bar-demo-tooltip.md)); tooltip options in [chart-tooltip-demo](examples/chart-tooltip-demo.md).

Full-block chart library (in [blocks/](blocks/)):

| Chart family | Variants |
|---|---|
| Bar | [default](blocks/chart-bar-default.md), [multiple](blocks/chart-bar-multiple.md), [stacked](blocks/chart-bar-stacked.md), [horizontal](blocks/chart-bar-horizontal.md), [mixed](blocks/chart-bar-mixed.md), [negative](blocks/chart-bar-negative.md), [label](blocks/chart-bar-label.md), [label-custom](blocks/chart-bar-label-custom.md), [active](blocks/chart-bar-active.md), [interactive](blocks/chart-bar-interactive.md) |
| Line | [default](blocks/chart-line-default.md), [linear](blocks/chart-line-linear.md), [step](blocks/chart-line-step.md), [multiple](blocks/chart-line-multiple.md), [dots](blocks/chart-line-dots.md), [dots-colors](blocks/chart-line-dots-colors.md), [dots-custom](blocks/chart-line-dots-custom.md), [label](blocks/chart-line-label.md), [label-custom](blocks/chart-line-label-custom.md), [interactive](blocks/chart-line-interactive.md) |
| Area | [default](blocks/chart-area-default.md), [linear](blocks/chart-area-linear.md), [step](blocks/chart-area-step.md), [stacked](blocks/chart-area-stacked.md), [stacked-expand](blocks/chart-area-stacked-expand.md), [gradient](blocks/chart-area-gradient.md), [axes](blocks/chart-area-axes.md), [legend](blocks/chart-area-legend.md), [icons](blocks/chart-area-icons.md), [interactive](blocks/chart-area-interactive.md) |
| Pie | [simple](blocks/chart-pie-simple.md), [donut](blocks/chart-pie-donut.md), [donut-active](blocks/chart-pie-donut-active.md), [donut-text](blocks/chart-pie-donut-text.md), [label](blocks/chart-pie-label.md), [label-list](blocks/chart-pie-label-list.md), [label-custom](blocks/chart-pie-label-custom.md), [legend](blocks/chart-pie-legend.md), [separator-none](blocks/chart-pie-separator-none.md), [stacked](blocks/chart-pie-stacked.md), [interactive](blocks/chart-pie-interactive.md) |
| Radar | [default](blocks/chart-radar-default.md), [dots](blocks/chart-radar-dots.md), [multiple](blocks/chart-radar-multiple.md), [radius](blocks/chart-radar-radius.md), [legend](blocks/chart-radar-legend.md), [icons](blocks/chart-radar-icons.md), [lines-only](blocks/chart-radar-lines-only.md), [label-custom](blocks/chart-radar-label-custom.md), [grid-circle](blocks/chart-radar-grid-circle.md), [grid-circle-fill](blocks/chart-radar-grid-circle-fill.md), [grid-circle-no-lines](blocks/chart-radar-grid-circle-no-lines.md), [grid-custom](blocks/chart-radar-grid-custom.md), [grid-fill](blocks/chart-radar-grid-fill.md), [grid-none](blocks/chart-radar-grid-none.md) |
| Radial | [simple](blocks/chart-radial-simple.md), [label](blocks/chart-radial-label.md), [grid](blocks/chart-radial-grid.md), [shape](blocks/chart-radial-shape.md), [stacked](blocks/chart-radial-stacked.md), [text](blocks/chart-radial-text.md) |
| Tooltip styles | [default](blocks/chart-tooltip-default.md), [advanced](blocks/chart-tooltip-advanced.md), [formatter](blocks/chart-tooltip-formatter.md), [icons](blocks/chart-tooltip-icons.md), [indicator-line](blocks/chart-tooltip-indicator-line.md), [indicator-none](blocks/chart-tooltip-indicator-none.md), [label-custom](blocks/chart-tooltip-label-custom.md), [label-formatter](blocks/chart-tooltip-label-formatter.md), [label-none](blocks/chart-tooltip-label-none.md) |

**See also:** [chart](components/chart.md).

---

## Compose list rows

### I want a row with media, title, description, and actions

**Composition:** `Item` + `ItemMedia` (icon / avatar / image) + `ItemContent` (`ItemTitle`, `ItemDescription`) + `ItemActions`. Use `ItemGroup` + `ItemSeparator` for grouped lists. `Item asChild` promotes the row to a link.

**Why this and not a custom div:** `Item` encodes consistent padding, gap, hover states, and the media/content/actions slot contract — and plays nicely with `Spinner`, `Avatar`, `Badge`.

**Examples:**
- [item-demo](examples/item-demo.md) — with an action button; `asChild` link variant
- [item-header](examples/item-header.md)
- [item-icon](examples/item-icon.md), [item-avatar](examples/item-avatar.md), [item-image](examples/item-image.md)
- [item-size](examples/item-size.md), [item-variant](examples/item-variant.md)
- [item-link](examples/item-link.md) — `Item asChild`
- [item-dropdown](examples/item-dropdown.md) — row with dropdown action
- [item-group](examples/item-group.md) — grouped list with `ItemGroup` + `ItemSeparator`

---

## Identity, meta, decoration

### I want a user avatar

**Composition:** `Avatar` + `AvatarImage` + `AvatarFallback` (fallback shown when image fails/loads).

**Examples:**
- [avatar-demo](examples/avatar-demo.md) — round, rounded-lg, and stacked avatar group

### I want a status / count badge

**Composition:** `Badge` with a `variant` (`default`, `secondary`, `outline`, `destructive`). Combine with a `lucide` icon for verified-style badges, or size as a numeric pill.

**Examples:**
- [badge-demo](examples/badge-demo.md) — variants, verified-with-icon, numeric counters
- [badge-secondary](examples/badge-secondary.md), [badge-destructive](examples/badge-destructive.md), [badge-outline](examples/badge-outline.md)

### I want to show a keyboard shortcut

**Composition:** `Kbd` (optionally wrap multiple in `KbdGroup`). Mix with text or `+` separators.

**Examples:**
- [kbd-demo](examples/kbd-demo.md) — modifier cluster and `Ctrl+B`
- [kbd-group](examples/kbd-group.md)
- [kbd-input-group](examples/kbd-input-group.md) — kbd inside an `InputGroupAddon` (e.g., `/` search hint)
- [kbd-button](examples/kbd-button.md)
- [kbd-tooltip](examples/kbd-tooltip.md) — shortcut hint inside a tooltip

### I want a form label

**Composition:** `Label` with `htmlFor` referencing an input id; or `FieldLabel` inside a `Field`.

**Examples:**
- [label-demo](examples/label-demo.md) — with `Checkbox`

### I want prose / marketing typography

**Composition:** plain HTML (`h1`..`h4`, `p`, `blockquote`, `ul`, `table`) with the Tailwind classes from the typography example — there is no `Typography` component.

**Examples:**
- [typography-demo](examples/typography-demo.md) — the canonical long-form prose sample
- Individual: [typography-h1](examples/typography-h1.md), [typography-h2](examples/typography-h2.md), [typography-h3](examples/typography-h3.md), [typography-h4](examples/typography-h4.md), [typography-p](examples/typography-p.md), [typography-blockquote](examples/typography-blockquote.md), [typography-inline-code](examples/typography-inline-code.md), [typography-lead](examples/typography-lead.md), [typography-large](examples/typography-large.md), [typography-small](examples/typography-small.md), [typography-muted](examples/typography-muted.md), [typography-list](examples/typography-list.md), [typography-table](examples/typography-table.md)

---

## Page-level templates

These are complete pages — copy one, swap in your data, done.

### I want a dashboard layout

- [dashboard-01](blocks/dashboard-01.md) — sidebar + header + section cards + interactive area chart + data table (composes `Sidebar`, `SidebarInset`, `Breadcrumb`, `Separator`, `Chart`, `Card`, `Select`, `Tabs`, `Table`, `ToggleGroup`, `Badge`, `DropdownMenu`, `Drawer`, `Input`, `Avatar`, `Sheet`, `Sonner`).

### I want a login page

- [login-01](blocks/login-01.md) — simple login card
- [login-02](blocks/login-02.md), [login-03](blocks/login-03.md), [login-04](blocks/login-04.md), [login-05](blocks/login-05.md) — alternate layouts (split, full-bleed, with illustration, etc.)

### I want a signup page

- [signup-01](blocks/signup-01.md) — simple signup card
- [signup-02](blocks/signup-02.md), [signup-03](blocks/signup-03.md), [signup-04](blocks/signup-04.md), [signup-05](blocks/signup-05.md)

### I want a sidebar app shell

16 variants covering collapsed, grouped, icon-only, team switcher, inset, floating, sub-sidebars, and more:

[sidebar-01](blocks/sidebar-01.md), [sidebar-02](blocks/sidebar-02.md), [sidebar-03](blocks/sidebar-03.md), [sidebar-04](blocks/sidebar-04.md), [sidebar-05](blocks/sidebar-05.md), [sidebar-06](blocks/sidebar-06.md), [sidebar-07](blocks/sidebar-07.md), [sidebar-08](blocks/sidebar-08.md), [sidebar-09](blocks/sidebar-09.md), [sidebar-10](blocks/sidebar-10.md), [sidebar-11](blocks/sidebar-11.md), [sidebar-12](blocks/sidebar-12.md), [sidebar-13](blocks/sidebar-13.md), [sidebar-14](blocks/sidebar-14.md), [sidebar-15](blocks/sidebar-15.md), [sidebar-16](blocks/sidebar-16.md).

Read the frontmatter `dependencies` list to see which primitives each block pulls in — useful when picking the closest starting point to your shell.

---

## What's not covered

Examples the shadcn registry doesn't ship (and therefore this cookbook cannot link evidence for):

- **Color picker** — no shadcn primitive in the pulled set.
- **File dropzone with drag-and-drop** — only `input-file` (native file input) is covered.
- **Rich text editor** — out of scope; compose `Toggle` / `ToggleGroup` for a toolbar.
- **Virtualized table** — `data-table-demo` is non-virtualized; use `react-virtuoso` (`TableVirtuoso`) — see the "virtualized list or table" section above.
- **Step wizard / multi-page form** — no dedicated block; compose `Tabs` or a controlled state machine.
