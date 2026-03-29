# Cookbook 02 -- Forms & Data Entry

A decision guide for building forms. Focuses on user intent, mental models, and when to reach for each pattern -- not how to wire it up.

---

## 1. Simple Create/Edit Form

**The user's mental model:** "I'm filling out a card. Labels on the left or top, controls on the right or below, a button at the end to save."

**Vertical layout (stacked labels above controls)**

- Default for most forms. Works at any width. Scales gracefully when fields vary in length.
- Reach for FieldSet, FieldGroup, Field, FieldLabel, Input, Select, Textarea, Button.
- The user scans top-to-bottom. Every field gets its own row. The submit button sits below the last field, separated by whitespace.

**Horizontal layout (label-left, control-right)**

- Best for settings pages and preference panels where every field is short (a toggle, a small number, a dropdown).
- Reach for Field with orientation="horizontal", FieldContent, FieldDescription, Switch, Select.
- The user scans like a two-column ledger: name on the left, control on the right. Feels dense and efficient.

**When to pick which:**

- If any field might need a Textarea or a long Input, go vertical. Horizontal layout cramps multi-line content.
- If the form is mostly toggles and small selects (like a settings page), go horizontal. Vertical layout wastes space on short controls.
- If the form mixes both, split into FieldSet sections. One section can be vertical (text fields) and another horizontal (toggles). FieldSeparator between them.

**Mistakes to avoid:**

- Horizontal layout on narrow viewports. Labels and controls collide. Use orientation="responsive" if the form might appear in a panel or on mobile.
- Putting the submit button inside the FieldGroup. It should sit outside, visually separated, so the user knows where the form ends and the action begins.

---

## 2. Inline Editing

**The user's mental model:** "I see a value. I click it. I change it right there. Done."

**When inline editing beats a separate form:**

- The user is making a quick, isolated correction to a single field -- renaming something, fixing a typo, updating a note.
- The value already exists on screen (in a table cell, a detail panel, a card). Navigating to a separate form would break flow.
- The change is low-stakes and doesn't require context from other fields.

**When a separate form is better:**

- The edit involves multiple related fields that should be validated together.
- The user needs to see additional context (descriptions, constraints, related data) while editing.
- The change is high-stakes and benefits from a clear "Review before saving" moment.

**Components to reach for:** Input (or Textarea, or Select depending on the value type), displayed inside the same space the read-only value occupied.

**The flow in plain English:**

1. User clicks the displayed value (or a small edit icon beside it).
2. The text swaps to an Input, pre-filled with the current value, auto-focused.
3. User edits. Enter or blur commits. Escape reverts to the original value.
4. On commit, the value saves and the Input swaps back to display text.

**Mistakes to avoid:**

- No visual affordance that the value is editable. The user needs a hover state (subtle background change, underline, cursor change) or a pencil icon. An editable value that looks identical to static text is invisible.
- Committing on blur without also handling Escape. The user expects a way to cancel.
- Inline editing a field that has complex validation. If saving might fail, the user needs error feedback, which is awkward inline. Use a form instead.

---

## 3. Validation and Error Communication

**The user's mental model:** "If I did something wrong, tell me what and where, right when I need to know -- not all at once at the end, and not while I'm still typing."

**Where errors should appear:**

- Directly below the offending field, inside a FieldError. The user's eye is already there.
- Never only at the top of the form in a banner. Top-of-form summaries are fine as a secondary signal, but the user should not have to hunt for which field is broken.
- Never only in a toast. Toasts disappear. Validation errors need to persist until fixed.

**When to validate:**

- "onTouched" is the best default. The field validates after the user interacts with it and moves on. This avoids yelling at the user before they've finished typing, but catches errors before they hit submit.
- "onChange" (real-time) is appropriate for fields with hard format constraints -- like a field that only accepts numbers or a specific pattern. The user benefits from immediate feedback.
- "onSubmit" is appropriate when fields are interdependent and can only be validated as a group. Avoid it as the only strategy; it makes the user wait too long to learn about problems.

**Components to reach for:** Field with data-invalid, FieldError for the message, Input/Select/etc. with aria-invalid. Sonner toast for success confirmation after submit, not for errors.

**How to avoid user frustration:**

- Validate on blur, not on every keystroke, for free-text fields. Seeing "too short" while still typing is hostile.
- Disable the submit button only when the form is actively submitting (loading state), never as a substitute for validation feedback. A disabled button with no explanation is a dead end.
- When a server-side error comes back (like "email already exists"), inject it into the same per-field error system. The user should not see a different error style for server errors vs. client errors.
- Clear the error as soon as the user starts correcting the field, not only after they re-submit.

---

## 4. Dependent Fields

**The user's mental model:** "I pick a category, and then the next dropdown shows me only the options that make sense for that category."

**When this pattern applies:**

- A parent field's value constrains the valid options for a child field. Asset class narrows the ticker list. Country narrows the state/province list. Broker narrows the account list.
- The dependency is one-directional: changing the parent resets the child, but changing the child never affects the parent.

**Components to reach for:** Select for the parent (when options are short and known). Combobox for the child (when the filtered list might still be long enough to need search).

**The flow in plain English:**

1. User selects a value in the parent field.
2. The child field's options immediately update to reflect the parent's selection. If the child had a previous selection that is no longer valid, it resets to empty.
3. If no parent value is selected, the child field is disabled with a placeholder like "Select [parent] first."

**Mistakes to avoid:**

- Not resetting the child when the parent changes. The user ends up with an invisible invalid state -- a child value that no longer belongs to the new parent.
- Showing all options in the child and marking invalid ones as disabled. This is confusing. Just filter them out.
- Chaining more than two or three levels of dependency. Each additional level multiplies the chance of stale state. If you need deeper cascades, consider a different interaction model (like a tree picker or a search-first approach).
- Forgetting the loading state when dependent options come from an API. The child field should show a spinner or "Loading..." placeholder, not an empty list that looks like "no results."

---

## 5. Date Picking

**The user's mental model varies by context.** A user entering their birthday thinks in months and years and wants to jump around. A user picking "yesterday" wants to click once. A user entering an exact ISO date might prefer to just type it.

**Calendar in a Popover (the standard date picker)**

- Best when the user is choosing a date in the near past or future and wants to see the calendar context (day of week, proximity to today).
- Reach for Popover, PopoverTrigger, PopoverContent, Calendar, Button.
- The trigger is a Button styled like an input, showing the formatted date or a placeholder. Clicking opens a Popover with a Calendar. Selecting a date closes the popover.

**When to use it:**

- Picking a trade date, a backtest start/end, a filter range.
- Any time "which day of the week was that?" matters to the user's decision.

**Native date Input**

- Best when the user knows the exact date and wants to type it fast, or when the form is simple and a popover feels heavy.
- Just an Input with type="date". No extra components.

**When to use it:**

- Internal tools where speed beats polish.
- Forms where the date is one of many fields and the user is filling them out rapidly.

**Tradeoffs:**

- Calendar popover is more visual, better for exploration, worse for keyboard-only entry and for jumping to distant dates (like a birthday 30 years ago -- add dropdown month/year navigation for that).
- Native input is faster to type, fully keyboard-accessible out of the box, but ugly and inconsistent across browsers.
- Date range selection (start + end) works naturally with Calendar in range mode. It is awkward with two native inputs because the user cannot see the range visually.

**Mistakes to avoid:**

- A date picker without keyboard support. The user should be able to type a date, not only click.
- Not showing the selected date on the trigger button. The user should see what they picked without opening the popover again.
- Forgetting presets. If 90% of users pick "today" or "last 7 days," put those as one-click buttons alongside the calendar.

---

## 6. Dynamic Lists (Add/Remove Rows)

**The user's mental model:** "I'm building a list. I add items one at a time. I can remove any item. The list grows and shrinks as I need it to."

**When this pattern applies:**

- The user is entering a variable number of similar items: alert thresholds, email addresses, ticker watchlists, rule conditions.
- Each item has the same structure (one to three fields per row).

**Components to reach for:** FieldGroup for the list container. Input/Select/etc. for the per-row controls. Button (outline, small) for "Add row." Button (ghost, icon) with a trash icon for per-row removal.

**The flow in plain English:**

1. The form starts with one row (or zero rows with a prominent "Add" button).
2. The user fills in the row, then clicks "Add" to append another.
3. Each row has a remove button on the right. Clicking it removes that row immediately (no confirmation needed for a single unsaved row).
4. Labels appear only on the first row. Subsequent rows inherit the column structure without repeating labels.
5. The "Add" button sits below the list, visually connected to it.

**Mistakes to avoid:**

- Allowing the user to remove the last row when at least one is required. Disable the remove button when the list is at minimum length, or show a validation error on submit.
- Keying rows by array index. If the user removes row 2 of 5, rows 3-5 shift up and lose their state. Key by a stable identifier.
- No upper bound. If there is a practical maximum, disable the "Add" button at that limit and show why.
- Crowding the remove button against the fields. Give it breathing room so the user does not accidentally delete a row while editing.

---

## 7. Mixed Control Types

**The user's mental model:** "This is one form about one thing, but it has different kinds of questions -- some I type, some I pick from a list, some I toggle on or off."

**When this pattern applies:**

- A configuration form, a strategy setup, a profile editor -- anywhere the entity has both free-text properties (name, notes), constrained-choice properties (strategy type, broker), and boolean flags (auto-trade, notifications).

**How to organize it:**

- Group by purpose, not by control type. Do not put all the text fields together and all the toggles together. Group by what they mean: "Identity" section (name, description), "Execution" section (broker, risk limit), "Preferences" section (notifications, confirmation).
- Use FieldSet with FieldLegend for each group. FieldSeparator between groups.
- Text inputs and selects go vertical (label above control). Switches and checkboxes go horizontal (label beside control). This matches the user's expectation: a toggle is a yes/no decision you read left-to-right, a text field is a blank you fill top-to-bottom.

**Components to reach for:** FieldSet, FieldLegend, FieldGroup, FieldSeparator for structure. Input, Select, Textarea for text/choice. Switch for on/off preferences with descriptions. Checkbox for opt-in confirmations and acknowledgments.

**When to use Switch vs. Checkbox:**

- Switch: a preference that takes effect immediately or represents a mode ("Auto-trade on/off"). Has a description. Lives in a horizontal Field.
- Checkbox: an acknowledgment or opt-in ("I confirm this is irreversible"). Usually standalone or in a list. Feels lighter than a switch.

**Mistakes to avoid:**

- Mixing horizontal and vertical fields within the same FieldGroup without clear section breaks. The form looks chaotic. Separate them into distinct FieldSets.
- Using a Select for a two-option choice. If there are only two options, a Switch or RadioGroup reads faster.
- Forgetting the read-only variant. If the form doubles as a view, set data-disabled on Fields and disabled on controls. The layout should look the same, just non-interactive.

---

## 8. Auto-Save vs. Explicit Submit

**The user's mental model depends on stakes and frequency.**

**Auto-save (changes persist as the user makes them)**

- The user thinks: "I'm adjusting settings. Every change takes effect when I make it. No save button."
- Best for: preferences, toggles, settings panels, anything where changes are low-risk and individually meaningful.
- The user expects immediate feedback: a subtle confirmation (checkmark, brief toast, "Saved" text that fades) after each change.
- Reach for individual onChange/onCheckedChange handlers that fire a mutation per field. No form-level submit.

**Explicit submit (changes are staged until the user commits them)**

- The user thinks: "I'm filling out a form. Nothing happens until I click Save. I can change my mind."
- Best for: creating new records, multi-field edits where partial state is invalid, high-stakes changes where the user wants to review before committing.
- The user expects a clear submit button, a loading state while saving, and a success/failure message after.
- Reach for a form element with an onSubmit handler, a submit Button, and Sonner toast for confirmation.

**Decision tree:**

- Is each field independently meaningful and low-risk? Auto-save.
- Do fields depend on each other (changing one without changing another creates an invalid state)? Explicit submit.
- Would saving a half-finished state cause problems? Explicit submit.
- Is the user likely to make one change and leave? Auto-save.
- Is the user likely to make several changes as a batch? Explicit submit.

**Hybrid approach:**

Some forms auto-save individual toggles but require explicit submit for text fields. This works when the toggles are independent preferences and the text fields need validation. Use clear visual separation (FieldSeparator or separate FieldSets) so the user understands which parts save automatically and which require the button.

**Mistakes to avoid:**

- Auto-save with no feedback. The user has no idea if their change was registered. Always confirm, even subtly.
- Auto-save on fields that need validation. If the user types an invalid email and you auto-save it, you have corrupted data. Auto-save only works for controls with inherently valid states (toggles, selects, bounded number inputs).
- Explicit submit with no dirty-state tracking. If the user navigates away with unsaved changes, warn them. If nothing changed, do not show a "You have unsaved changes" warning.
- A "Save" button that is always enabled even when nothing changed. It should be disabled (or hidden) when the form state matches the last-saved state.
