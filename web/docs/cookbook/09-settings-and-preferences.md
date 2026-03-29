# Settings & Preferences

A decision guide for building settings pages, preference panels, and configuration UIs. Focuses on when to reach for each pattern, what the user expects, and how to avoid common traps.

---

## 1. Toggle Panels

**When this comes up:** The user has a list of independent on/off preferences. Each controls a distinct behavior. Think "auto-close positions at EOD," "sound alerts," "paper trading mode."

**What the user expects:** Flip a switch, see it take effect. No submit button, no page reload. If something goes wrong, tell me -- don't silently revert.

**Mental model:** Light switches. Each one is independent. Flipping one has no effect on the others. The wall of switches IS the form.

### Decision: auto-save vs explicit save

- **Auto-save (immediate)** -- Use when each toggle is independent and low-risk. The switch fires a PATCH on change and a toast confirms. This is the default for most settings pages. The user never wonders "did I forget to save?"
- **Explicit save (button)** -- Use when toggles are interdependent or when a bad combination could cause problems. Group them in a Card with a Save button in the footer. The user can review the full set before committing.

A good heuristic: if reverting a toggle is trivial, auto-save. If the user might want to change three things at once and review before applying, use a form with a save action.

### Components and why

- **Card** wraps each logical group, giving it a visible boundary and a title.
- **Field (horizontal orientation)** puts the label/description on the left and the Switch on the right -- the standard layout users recognize from every settings page on every platform.
- **Switch** for binary toggles. Never use a Checkbox for on/off preferences in a settings panel. Checkboxes imply "select items from a set," switches imply "turn this behavior on or off."
- **Separator** between rows when the list is long enough that rows need visual breathing room.
- **Sonner toast** for confirmation on auto-save. Keep it minimal: "Setting updated" is fine.

### Flow

The user opens the settings page. They see a Card titled "Trading Preferences" with a subtitle "Changes are saved automatically." Each row is a horizontal Field: label and description on the left, Switch on the right. They flip "Paper trading" on. The switch animates, the API fires, a toast confirms. Done.

### Alternatives

- **Small switch** for dense layouts where vertical space is tight.
- **Choice card style** where the entire row is clickable (FieldLabel wraps the Field). Good for touch targets.
- **Disabled rows** with muted styling and a disabled Switch for settings the user can see but not change (e.g., locked by an admin or a dependency).

### Mistakes to avoid

- Forgetting to tell the user that changes auto-save. If there is no save button, the Card description must say so. Otherwise users will hunt for a button that does not exist.
- Auto-saving settings that have dangerous interactions. If enabling "aggressive mode" while "auto-close" is off could blow up the account, those two should be in an explicit-save group.
- Using a Checkbox where a Switch belongs. The semantics are different and users feel the difference even if they cannot articulate it.

---

## 2. Tabbed Settings

**When this comes up:** The settings page has grown beyond a single scroll. There are five or more logical categories and showing them all at once creates decision fatigue.

**What the user expects:** Horizontal tabs at the top. Click a tab, see that category's settings. My current tab should survive a page refresh.

**Mental model:** Filing cabinet drawers. Each drawer is a category. You pull one out at a time.

### Decision: when to add tabs

- **Fewer than 4 categories** -- Do not tab. Use stacked Cards with clear titles. Tabs add navigation cost. If everything fits in one scroll, keep it flat.
- **4-7 categories** -- Horizontal tabs. This is the sweet spot. Each tab loads a Card with the relevant settings.
- **8+ categories** -- Consider vertical tabs (sidebar layout) on wide screens, collapsing to horizontal or an accordion on narrow screens.

### Components and why

- **Tabs** as the container, with TabsList, TabsTrigger, and TabsContent.
- **Icons in triggers** help users scan. A bell for notifications, a palette for appearance, a shield for security. Keep them small and to the left of the label.
- **Card inside each TabsContent** maintains the visual grouping. Without the Card, the content floats and feels disconnected from the tab.

### Flow

The user lands on Settings. The first tab ("General") is active. They see a Card with general preferences. They click "Notifications." The tab switches instantly (no loading). They adjust their notification matrix. They click "Security." They see their API keys. The URL updates with each tab so they can bookmark or share a direct link.

### Alternatives

- **Line tabs** (underline variant) for a lighter visual weight when the settings page sits inside a larger layout.
- **Vertical tabs** for wide-screen apps with many categories. The left sidebar shows all categories and the right pane shows the active one.
- **URL-synced tabs** where the active tab is driven by a search param. Essential if users need to link directly to a specific settings section.

### Mistakes to avoid

- Nesting tabs inside tabs. If a settings category needs sub-categories, use sections with headings inside the tab content -- not another tab bar.
- Making each tab a separate route with its own data fetch. All settings should load once. Tab switches should be instant with no spinners.
- Forgetting to persist the active tab in the URL. Users who refresh the page and land back on "General" when they were editing "Security" will be annoyed.

---

## 3. Mutually Exclusive Choices

**When this comes up:** The user must pick exactly one option from a small set. "Conservative / Balanced / Aggressive." "Daily / Weekly / Monthly." "Light / Dark / System."

**What the user expects:** I pick one, the others deselect. If there are descriptions, I can read them before choosing. The current selection is visually obvious.

**Mental model:** Physical radio buttons. Push one in, the others pop out. Exactly one is always selected.

### Decision: how to present the options

- **2-3 options with descriptions** -- Choice cards. Each option is a full-width row with a RadioGroupItem, a title, and a description. The entire card area is the click target. This gives each option room to breathe and explain itself.
- **3-5 options without descriptions** -- Inline radio group. RadioGroupItem + label in a compact vertical or horizontal list. Simple and dense.
- **2-3 visual options** (like themes) -- ToggleGroup with visual previews. Each item is a card with an image or color swatch and a label beneath it. The user picks by appearance, not by reading.
- **6+ options** -- Select dropdown. A radio group with 8 items is overwhelming. A Select keeps the page clean and is searchable if needed.

### Components and why

- **RadioGroup + RadioGroupItem** for standard mutually exclusive choices. Built-in keyboard navigation (arrow keys move between options). Accessibility is handled for you.
- **FieldSet + FieldLegend** wraps the group to give it a semantic label. Screen readers announce "Trading Strategy, radio group, 3 items."
- **FieldLabel wrapping the entire Field** (choice card variant) makes the whole row clickable. Users should not have to aim for a tiny radio dot.
- **ToggleGroup (type="single")** for visual pickers where the selection is communicated through appearance rather than text.

### Flow

The user sees a FieldSet titled "Trading Strategy" with three choice cards stacked vertically. "Balanced" is currently selected (highlighted border). They read the description for "Aggressive," decide that is what they want, and click anywhere on that card. The highlight moves. If auto-save, a toast confirms. If part of a form, the selection is held until they click Save.

### Alternatives

- **With icons** before each title for visual differentiation when titles alone are not distinct enough.
- **Disabled options** that are visible but grayed out, with a tooltip or description explaining why (e.g., "Aggressive mode requires margin approval").

### Mistakes to avoid

- Using a Select dropdown for 2-3 options. Dropdowns hide the choices. When there are only a few options, show them all at once so the user can compare.
- Allowing deselection. A mutually exclusive choice should always have exactly one selected item. If ToggleGroup allows deselecting, guard against it.
- Tiny click targets. If the user has to click precisely on the radio dot, the UX is broken. Wrap the row in a clickable FieldLabel.

---

## 4. Secrets Management

**When this comes up:** The user manages API keys, tokens, or credentials. They need to see what keys exist, copy values, reveal masked values, and revoke keys safely.

**What the user expects:** Keys are masked by default. I can reveal them temporarily. Copying works in one click. Deleting requires confirmation because revoking a key breaks integrations immediately.

**Mental model:** A vault. Contents are hidden until I explicitly look. Removing something is serious and cannot be undone.

### Decision: what to show and what to hide

- **Always mask by default.** Show the first 4 and last 4 characters with dots in between. A shoulder-surfer should see nothing useful.
- **Reveal is per-row and temporary.** An eye icon toggles visibility for that one key. Consider auto-hiding after 30 seconds.
- **Copy never reveals.** The copy button works on the full value without changing the display. The user gets a "Copied" toast but the screen stays masked.
- **Delete is destructive and immediate.** Revoking an API key is irreversible. Use an AlertDialog, not a toast-based undo. The dialog should name the key and warn that integrations using it will break.

### Components and why

- **Table** for the key list. Columns: Name, Value (masked), Created date, Actions.
- **Badge** to show status (Active, Expired). Use variant="destructive" for expired keys so they stand out.
- **Button (ghost, icon-xs)** for row actions: eye toggle, copy, delete. Ghost variant keeps the table clean.
- **AlertDialog** for delete confirmation. The title names the specific key. The description warns about downstream breakage.
- **Dialog** for adding a new key. An Input for the name, a Textarea for the value, and a save action.

### Flow

The user sees a table of their API keys. All values are masked. They click the eye icon on "DATABENTO_API_KEY" -- the full value appears. They click the copy icon -- the value is on their clipboard, a toast says "Copied." They click the trash icon on an old key. An AlertDialog opens: "Delete LEGACY_KEY? This will revoke the key immediately. Any integrations using it will stop working." They confirm. The row disappears. A toast confirms deletion.

### Alternatives

- **Expiration badges** with color coding (green for active, yellow for expiring soon, red for expired) to draw attention to key rotation needs.
- **Empty state** with a message like "No API keys configured" and a prominent "Add Key" button when the table has no rows.
- **Last used** column to help users identify stale keys worth revoking.

### Mistakes to avoid

- Showing full key values on page load. This is a security failure. Always mask by default.
- Using an undo-toast for key deletion. Unlike dismissing a notification, revoking an API key has immediate downstream consequences. A pre-confirmation dialog is the right pattern.
- Putting the "Add Key" action inside the table. It should be a Button above or beside the table, visually separate from the existing rows.
- Logging or toasting the full key value. "Copied DATABENTO_API_KEY" is fine. "Copied sk-ant-api03-xxxx..." is not.

---

## 5. Theme and Appearance

**When this comes up:** The user wants to switch between light mode, dark mode, and system preference. Possibly also accent colors or density settings.

**What the user expects:** I click a visual preview and the app changes immediately. No save button. No page reload. The choice persists across sessions.

**Mental model:** Paint swatches. I see what each option looks like before I commit. Picking one paints the whole room.

### Decision: how to present theme options

- **3 options (light/dark/system)** -- ToggleGroup with visual previews. Each item shows a miniature representation of the theme (light card, dark card, split card for system). The label and an icon sit beneath the preview.
- **2 options (light/dark only)** -- A single Switch in the header or sidebar is enough. No need for a dedicated settings section.
- **Theme + accent color** -- Two ToggleGroups. The first for light/dark/system. The second for accent color, shown as a row of colored circles.
- **Theme + density + font size** -- A card with multiple controls. ToggleGroup for theme, RadioGroup or ToggleGroup for density (compact/default/comfortable), Slider for font size.

### Components and why

- **ToggleGroup (type="single")** because theme selection is visual and mutually exclusive. Each item is a tall card with a preview swatch and a label.
- **FieldSet + FieldLegend** to label the group semantically ("Theme," "Accent Color").
- **Icons** (sun, moon, monitor) reinforce each option. Users scan icons faster than labels.

### Flow

The user navigates to the Appearance tab (or section). They see three visual cards side by side: Light (white swatch, sun icon), Dark (dark swatch, moon icon), System (split swatch, monitor icon). "System" has a highlighted border. They click "Dark." The entire app switches to dark mode instantly. The card border moves to "Dark." A toast says "Theme set to dark." The preference is saved to localStorage and the server.

### Alternatives

- **Dropdown Select** for compact layouts where a full visual picker takes too much space. Trade-off: the user cannot see all options at once.
- **Accent color picker** as a second row of colored circles beneath the theme picker.
- **Font size slider** paired with the theme picker for users who need accessibility controls.

### Mistakes to avoid

- Making the user click Save after picking a theme. Theme changes should be instant and auto-persisted. Nobody expects to "submit" a color scheme.
- Forgetting system preference. "Light" and "Dark" are not enough. "System" should be the default because it respects the user's OS-level choice.
- Flash of wrong theme on load. If the theme preference is stored only in a database and fetched asynchronously, the page will flash the default theme before switching. Store the preference in localStorage too and apply it before first paint.
- Ignoring media query changes. When set to "System," the app should react to the OS switching between light and dark (e.g., sunset auto-switch).

---

## 6. Notification Preferences

**When this comes up:** The user needs to control which events trigger notifications and through which channels. "Trade signal" by email but not SMS. "Error alerts" everywhere.

**What the user expects:** A grid where I can see everything at once. Rows are events, columns are channels. I check the boxes I want. Changes save immediately.

**Mental model:** A spreadsheet. Each cell is independent. I can scan rows to see "what will this event do?" or scan columns to see "what will this channel receive?"

### Decision: simple list vs matrix

- **3 or fewer channels** -- Full matrix. A Table with one Checkbox per cell. Fits comfortably and gives the user total control.
- **1 channel** -- Skip the matrix. Use a toggle panel (pattern 1) where each row is an event with a Switch. Rows are events, and the only question is on or off.
- **Many events, many channels** -- Group events by category (Trading, System, Reports) using section header rows in the table. Without grouping, a matrix with 15 events and 4 channels becomes a wall of checkboxes.

### Components and why

- **Table** for the matrix layout. The first column is the event name, remaining columns are channels.
- **Checkbox** (not Switch) in each cell. Here the mental model is "select which combinations I want" -- checkboxes are the right affordance for multi-select in a grid.
- **Card** wrapping the table with a title ("Notification Preferences") and a description ("Choose how you want to be notified for each event").
- **Column header Checkboxes** for "select all in this channel." Use the indeterminate state when the column is partially checked.

### Flow

The user sees a table. Rows: "New trade signal," "Position closed," "Daily summary," "Error alerts," "Price alerts." Columns: Email, Push, SMS. Currently, "Error alerts" is checked for all three. "Daily summary" is Email only. They check the Push box for "Price alerts." The checkbox fills, the API fires, done. They click the Email column header to toggle all events for email at once.

### Alternatives

- **Row grouping** with subheadings ("Trading Events," "System Events") spanning all columns for long event lists.
- **Muted rows** for events that are always on (like critical error alerts) -- visible but not toggleable.
- **Channel-first view** as a secondary organization: a tab or toggle that flips the matrix so columns are events and rows are channels. Useful when the user is thinking "what does my Push channel receive?"

### Mistakes to avoid

- Using Switches in a matrix. Switches are for on/off settings in a list. In a grid, checkboxes are the correct affordance. The visual density of switches in a grid is also overwhelming.
- Saving on every individual checkbox click in a large matrix. If the user is configuring 20 cells, 20 API calls is wasteful. Consider debouncing or adding a Save button for the matrix.
- Forgetting the select-all column header. Without it, the user must click every cell individually to enable a new channel for all events.

---

## 7. Import / Export

**When this comes up:** The user wants to back up their settings, move them to another environment, or share a configuration with a teammate.

**What the user expects:** One button to download everything as a file. One button (or drop zone) to upload a file and restore. Clear feedback on success or failure. A warning if the import will overwrite existing settings.

**Mental model:** Save game / load game. Export creates a snapshot. Import restores from a snapshot.

### Decision: format and scope

- **Full export** -- A single JSON file containing all settings, preferences, and feature flags. The filename includes the date for easy identification. This is the common case.
- **Selective export** -- Let the user choose which categories to export (general, notifications, feature flags). Useful when sharing only one aspect of a configuration. Adds complexity; only build it if users ask for it.
- **Import with diff preview** -- After parsing the uploaded file, show a dialog listing what will change before applying. Essential if the import could overwrite critical settings (like broker credentials or risk parameters).
- **Import without preview** -- Apply immediately and show a summary toast. Acceptable for low-stakes settings where the user can easily re-adjust.

### Components and why

- **Card** with two sections (Export and Import), separated by a Separator.
- **Button (outline)** with a download icon for export. Outline because it is a secondary action -- the user is not creating or modifying data.
- **Input (type="file")** or a drop zone for import. Accept only .json files.
- **Sonner toast** for success/failure feedback. On success, include the filename and a count of settings imported.
- **Dialog** for the diff preview variant. Show a before/after list of changes and require explicit confirmation.

### Flow

The user clicks "Export Settings." A JSON file downloads immediately, named something like "settings-2026-03-28.json." A toast confirms. Later, on a fresh install, they click "Import," select the file, and the settings are applied. A toast says "Imported 14 settings from settings-2026-03-28.json."

For the diff preview variant: after selecting the file, a Dialog opens showing "3 settings will change, 11 will be added, 0 will be removed." The user reviews and clicks "Apply." The Dialog closes and a toast confirms.

### Alternatives

- **Drag-and-drop zone** instead of a file Input for a more modern feel. Shows a dashed border area with "Drop your settings file here."
- **Promise toast** for the import action, showing loading/success/error states without a separate spinner.
- **Copy to clipboard** as an alternative to file download for quick sharing. The user clicks "Copy as JSON," sends it in a message, and the recipient pastes it into an import text area.

### Mistakes to avoid

- Exporting secrets or API keys in the settings file. The export should include preferences and flags, not credentials. If secrets are included, warn the user prominently.
- Silently overwriting settings on import without any feedback. Even without a diff preview, the toast should summarize what changed.
- Not resetting the file Input after import. If the user tries to import the same file again, the browser will not fire the change event unless the input is reset.
- Accepting any JSON without validation. Parse and validate the structure before applying. If the file is malformed, show a clear error: "The file is not valid JSON or has an unexpected format."

---

## 8. Feature Flags

**When this comes up:** The app has experimental features or optional integrations that can be toggled on or off. Unlike regular settings, feature flags are grouped by area, may carry risk labels, and often need more explanation.

**What the user expects:** I can browse available features by category. Each flag has a clear description of what it does. Experimental ones are labeled so I know what I am opting into. Toggling takes effect immediately.

**Mental model:** A laboratory control panel. Each switch enables an experiment. Some are stable, some are beta. I want to understand what each one does before flipping it.

### Decision: flat list vs grouped

- **Fewer than 6 flags** -- Flat list in a Card. Same layout as a toggle panel (pattern 1) but with Badge labels for "Beta" or "Experimental" next to relevant flags.
- **6+ flags across multiple areas** -- Grouped by category using an Accordion. Each AccordionItem is a category ("Trading Engine," "UI Experiments," "Integrations"). Expanding a category reveals its flags. This keeps the page scannable.
- **Many flags with search** -- Add a text input above the Accordion that filters flags across all groups. Useful when the flag list grows beyond what a user can visually scan.

### Components and why

- **Accordion (type="multiple")** so the user can have several categories open at once. Unlike tabs, accordions let you compare flags across categories.
- **AccordionTrigger** shows the category name and a Badge with the count of flags in that group.
- **Field (horizontal orientation)** inside each AccordionContent for the individual flag rows. Same layout as toggle panels: label + description on the left, Switch on the right.
- **Badge (variant="outline")** next to the flag label for "Beta" or "Experimental" markers. Outline variant keeps it subtle. Use variant="destructive" for flags that require a restart.
- **Switch** for the toggle. Auto-save with a toast like "auto_scale enabled."

### Flow

The user sees an Accordion with three categories. "Trading Engine" is expanded by default, showing two flags: "Multi-leg orders" and "Auto-scaling (Beta)." They flip on "Auto-scaling." A toast confirms. They expand "UI Experiments" to see "New chart renderer (Beta)" and "Compact mode." They leave those off. They do not need to expand "Integrations" today, so the section stays collapsed.

### Alternatives

- **Card wrapper** around the entire Accordion for a bordered, elevated appearance.
- **Search/filter input** above the Accordion for apps with 15+ flags.
- **Collapsible (single section)** instead of Accordion when there is only one category. No need for the overhead of accordion headers.
- **Restart required badge** (variant="destructive") for flags that need a process restart. The toast should also say "Restart required to take effect."

### Mistakes to avoid

- Mixing feature flags with regular settings. Flags are experimental or optional capabilities. Settings are stable preferences. They belong in separate tabs or sections.
- Not explaining what a flag does. Every flag needs a description. A switch labeled "enable_v2_engine" with no description is useless. The user should understand the impact before toggling.
- Auto-enabling flags on deploy. New flags should default to off. The user opts in deliberately.
- Forgetting to surface "restart required" for flags that change behavior at boot time. If the flag only takes effect after a restart, the user must know that. A toast alone is not enough -- the Badge on the flag label serves as a persistent reminder.

---

## Quick Reference: Choosing the Right Pattern

| User intent | Pattern | Key component |
|---|---|---|
| Turn individual behaviors on/off | Toggle panel (1) | Switch |
| Organize many settings by category | Tabbed settings (2) | Tabs |
| Pick exactly one from a small set | Mutually exclusive choices (3) | RadioGroup or ToggleGroup |
| Manage API keys and credentials | Secrets management (4) | Table + AlertDialog |
| Switch light/dark/system theme | Theme picker (5) | ToggleGroup with previews |
| Control events x channels | Notification matrix (6) | Table + Checkbox |
| Back up or restore configuration | Import/export (7) | Button + file Input |
| Toggle experimental features | Feature flags (8) | Accordion + Switch + Badge |
