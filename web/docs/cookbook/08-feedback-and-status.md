# Cookbook 08 — Feedback & Status Communication

How to tell the user what happened, what is happening, and what needs attention. This guide covers the decision-making behind feedback patterns, not the implementation details.

---

## 1. Action Confirmation (Toasts)

**User mental model:** "I just did something. Did it work?"

Every mutation the user initiates (save, delete, update, toggle) deserves an answer. Silence after an action feels broken. The answer should be proportional to the action — a quick confirmation for routine saves, a more detailed message for consequential changes.

**Which Sonner variant to use:**

- **success** — The action completed. Use for saves, creates, updates, deletes that landed. This is the default for most mutations. Keep the message short: verb + noun ("Trade saved", "Settings updated").
- **error** — The action failed. Always include a description with enough context for the user to understand what went wrong. Offer a retry action on the toast when the failure is transient (network errors, timeouts).
- **warning** — The action succeeded but with a caveat. Rate limits approaching, partial saves, degraded conditions. The user does not need to act immediately but should be aware.
- **info** — System-initiated notices that are not tied to a user action. New version available, background sync complete. Rare in practice.
- **default** (plain) — Neutral notifications that do not fit a severity. Paired with an undo action for soft-destructive operations (archive, dismiss, remove from list).

**Flow in plain English:**

User clicks a button. The mutation fires. On resolution, a toast appears in the bottom-right corner and auto-dismisses after a few seconds. For destructive actions, the toast may carry an undo action button that extends the dismissal window.

**When to add a description:** If the toast message alone does not tell the full story. "Trade saved" is self-explanatory. "Export failed" needs a description explaining why.

**When to add an undo action:** Only for easily reversible, low-severity operations. Archive a notification, remove a tag, dismiss an alert. Not for hard deletes — those should use a confirmation dialog instead (see cookbook 01).

**When to extend the duration:** Messages with an undo action or messages that contain information the user needs to read (error details, counts, resource names). Default is fine for simple success confirmations.

**Mistakes to avoid:**

- Toasting on every keystroke or auto-save. Toasts are for discrete user-initiated actions.
- Using success toasts for expected background events (data synced, cache warmed). These are debug-level, not user-level.
- Stacking multiple toasts from a single action. One action, one toast. Batch results into a single message ("Imported 42 trades, 3 skipped").
- Toasting without actionable content on errors. "Something went wrong" is useless. Say what failed and what the user can do about it.

---

## 2. Loading During Async Work

**User mental model:** "I clicked something. Is it working? Can I click other things?"

Loading feedback has one job: prove the system is responding. The shape of that feedback depends on what the user is waiting for and how long they expect to wait.

**Three loading mechanisms and when to use each:**

**Button spinners** — For actions that take 1-5 seconds (API calls, saves, submits). Replace the button label with a spinner and a gerund ("Submitting...", "Saving..."). Disable the button to prevent double-submission. The user stays on the same screen and sees immediate acknowledgment that their click registered.

**Skeleton screens** — For initial page loads or section loads where you know the shape of the content. Render placeholder blocks that match the real layout: same widths, same heights, same grid. The user sees the page "filling in" rather than staring at a blank void. Use Skeleton for cards, table rows, metric strips, chart areas — anything with a predictable layout.

**Progress bars** — For operations where you can report completion percentage (batch imports, multi-step processes, file uploads). Show a labeled bar with a numeric percentage and a human-readable status ("42 of 100 records processed"). The user can estimate how long they need to wait.

**Decision tree:**

- Can you report a percentage? Use a Progress bar.
- Is the wait under 5 seconds and tied to a button? Use a button spinner.
- Is content loading into a known layout? Use Skeleton.
- Is the wait indeterminate and not tied to a specific button? Use a spinner centered in the content area.

**Components:** Button (with Spinner swap), Skeleton, Progress.

**Mistakes to avoid:**

- Showing a full-page spinner when only one section is loading. Scope the loading indicator to the area that is actually waiting.
- Skeleton shapes that do not match the real content. If the skeleton is 3 rows and the real content is a chart, the layout will jump. Match the shape.
- Leaving a button in its loading state after the action completes. Always clean up the pending state in a finally block, whether the action succeeded or failed.
- Forgetting to disable the trigger during loading. Double-clicks cause duplicate mutations.

---

## 3. Promise Lifecycle

**User mental model:** "This thing is working... okay it finished... wait, did it fail?"

Some actions have a natural three-phase lifecycle: loading, success, error. Rather than managing these states manually (tracking isPending, showing a spinner, swapping to a toast), the promise toast pattern handles all three phases through a single declaration.

**When to use it:**

- Exports, imports, batch operations — anything where the user kicks off a process and waits.
- Operations where you want the loading state to live in the toast itself rather than on a button. This is useful when the trigger button should return to its resting state immediately (e.g., an export button in a toolbar that the user might click and forget about).

**Flow in plain English:**

User triggers the action. A toast immediately appears with a spinner and a loading message ("Exporting trades..."). When the promise resolves, the toast transitions in-place to a success message ("Exported 42 trades"). If it rejects, the toast transitions to an error message with details.

**When NOT to use it:**

- Simple saves where a button spinner is sufficient. The promise toast adds visual weight — a toast that morphs through three states is distracting for a quick save.
- Operations where the user needs to stay blocked (form submission where you want to prevent navigation). The promise toast does not block interaction.

**Alternatives:**

- Manual state tracking with a button spinner + separate success/error toast. More control, more boilerplate. Prefer this when the button itself needs to reflect the loading state.
- Optimistic update (section 7) when you do not want the user to wait at all.

**Mistakes to avoid:**

- Using promise toasts for every mutation. Reserve them for operations that take long enough for the user to notice the loading phase (more than a second or two).
- Vague loading messages. "Loading..." tells the user nothing. "Exporting 42 trades to CSV..." tells them exactly what is happening.

---

## 4. Persistent Warnings (Alert Banners)

**User mental model:** "Something is wrong and it is still wrong."

Toasts disappear. Alerts persist. Use an Alert banner when a condition requires ongoing awareness — something the user should know about every time they look at the page, not just once.

**When to use Alert vs toast:**

- The condition persists across time (broker disconnected, license expiring, data stale). Use Alert.
- The condition is the result of a one-time action (save succeeded, delete completed). Use toast.
- The condition affects the entire page or a major section. Use Alert at the top of that section.
- The condition affects a single field or row. Use inline feedback (section 6) or a badge (section 8).

**Variants and when each applies:**

- **destructive** — Something is broken and functionality is degraded. Broker disconnected, API key expired, sync failed. Red. Demands attention.
- **default** — Informational conditions that the user should be aware of but that do not block work. Maintenance window approaching, new feature available, data is from a cached snapshot.
- **warning (custom amber styling)** — Between informational and destructive. Rate limits approaching, paper mode active, partial data loaded. Amber/yellow.

**Anatomy of a good alert:**

- An icon that reinforces the severity (triangle for warnings, circle-x for errors, info circle for informational).
- A title that states the condition in 3-5 words.
- A description that explains the impact on the user.
- An optional action button when the user can do something about it (reconnect, refresh, upgrade).

**Flow in plain English:**

A condition becomes true (broker disconnects, data goes stale). An Alert banner appears at the top of the affected page or section. It stays visible as long as the condition persists. When the condition resolves (broker reconnects, data refreshes), the Alert disappears. If the alert has an action button, clicking it attempts to resolve the condition.

**Components:** Alert, AlertTitle, AlertDescription, AlertAction.

**Mistakes to avoid:**

- Using alerts for transient events. If the condition will resolve on its own in seconds, a toast is better.
- Stacking more than 2-3 alerts. If you have that many concurrent issues, consolidate into a single alert with a summary and an expandable details section.
- Alerts without actions when the user can actually do something. If there is a fix, surface it.
- Dismissible alerts for conditions that are still active. If the broker is still disconnected, dismissing the alert just hides the problem.

---

## 5. Empty States

**User mental model:** "There is nothing here. Is that expected? What should I do?"

An empty state is the first impression for new features and the fallback for filtered-out results. It should answer two questions: why is this empty, and what is the next step.

**Three categories of empty state:**

**First-run empty** — The user has never created any records of this type. The page is blank by design. Show an icon that represents the content type, a title stating what would normally appear here, a description explaining the value, and a prominent call-to-action button to create the first item. This is a teaching moment.

**Filtered empty** — Records exist but the current filters exclude all of them. Show a different message ("No matching trades") with a button to clear filters. Do not show a "create new" button — the user is not trying to create, they are trying to find.

**Error empty** — The data failed to load. Show an error message with a retry button. This is not a true empty state — it is a loading failure wearing an empty state's clothes. Distinguish it visually (destructive variant or error icon).

**Flow in plain English:**

The query returns zero results. The component checks whether this is a first-run scenario (no records exist at all), a filter scenario (records exist but are filtered out), or an error scenario (the query failed). It renders the appropriate empty state variant. When the user clicks the CTA, they are guided to the logical next action (create form, clear filters, retry).

**Components:** Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent, Button.

**Guidance for each category:**

- First-run: use an icon from the domain (chart icon for backtests, user icon for traders, message icon for messages). Keep the description under two sentences. The CTA should be the single most likely next action.
- Filtered: show the active filter count or summary. The CTA is "Clear filters" or "Reset search." No domain icon needed — the user knows what they are looking for.
- Error: show a warning or error icon. The CTA is "Try again." Include the error detail in the description if it is actionable.

**Mistakes to avoid:**

- Showing the same generic empty state for all three categories. A first-time user and a user with 500 trades who filtered to zero need different messages.
- Empty states with no CTA. Telling the user "there is nothing here" without a next step is a dead end.
- Placeholder images or illustrations that add visual weight without information. A simple icon is sufficient.
- Showing a skeleton that resolves to an empty state. If you know the data is empty (zero count from the API), skip the skeleton and go straight to the empty state.

---

## 6. Inline Validation

**User mental model:** "Did I fill this in correctly?"

Inline validation tells the user about field-level problems at the point of the problem. The error appears next to the field that caused it, not in a distant toast or a summary at the top of the form.

**When to validate:**

- **On blur** (field loses focus) — The default for most fields. The user has finished typing and moved on. Validating now catches errors without interrupting flow. Use for required fields, format checks (email, URL), and range checks.
- **On submit** — For forms where validation is complex or cross-field. The user fills everything in, clicks submit, and all errors appear at once. Use when blur validation would be confusing (e.g., two fields that must be validated together).
- **On change** (as the user types) — Only for real-time constraints like character counts, password strength meters, or search-as-you-type. Avoid for most fields — seeing "invalid email" after typing two characters is hostile.

**Anatomy of good inline validation:**

- The field border changes to indicate an error (red border via the data-invalid attribute).
- An error message appears directly below the field, in a smaller font, in a contrasting color.
- The message states what is wrong and ideally what to do about it. "Required" is acceptable for simple cases. "Enter a valid email address" is better than "Invalid format."
- Screen readers announce the error via aria-invalid on the input.

**Components:** Field, FieldLabel, FieldError, Input (or any form control). FieldError accepts either children (static message) or an errors array (for form library integration).

**Cross-field validation:** When two fields depend on each other (start date before end date, password and confirmation match), validate on submit and place the error on the second field. Do not validate cross-field on blur — the user may not have filled in the other field yet.

**Server-side errors:** After a failed API call, map server errors back to specific fields. The user sees inline errors just as if they had been caught by client-side validation. For errors that do not map to a specific field, use a toast or an alert banner above the form.

**Mistakes to avoid:**

- Validating on every keystroke for fields that have no real-time constraint. Let the user finish typing.
- Error messages that describe the validation rule instead of the problem. "Must match regex ^[A-Z]{1,5}$" vs "Enter a 1-5 letter ticker symbol."
- Clearing errors when the user starts typing but before the new value is valid. Wait for blur or submit to re-validate.
- Showing validation errors on page load for pre-filled forms. Only validate fields the user has interacted with.

---

## 7. Optimistic Updates

**User mental model:** "That was instant."

An optimistic update changes the UI immediately when the user acts, before the server confirms. If the server rejects the change, the UI rolls back and shows an error. The user perceives zero latency for the happy path.

**When to use optimistic updates:**

- Toggle actions (favorite, archive, pin) where the success rate is very high and the visual change is binary.
- List reordering where waiting for the server would make drag-and-drop feel sluggish.
- Counter increments (like/upvote) where the change is small and reversible.

**When NOT to use optimistic updates:**

- Destructive actions (delete) where rollback would be confusing. Use a confirmation dialog instead.
- Actions with complex server-side validation that might reject. A form save that could fail validation should not optimistically show "saved."
- Actions where the server response changes what the UI should show (creating a record that gets a server-generated ID or computed fields).

**Flow in plain English:**

User clicks. The UI updates immediately (toggle flips, item moves, counter increments). The API call fires in the background. If it succeeds, nothing more happens — the UI is already correct. If it fails, the UI reverts to the previous state and an error toast appears, optionally with a retry action.

**The rollback contract:**

- Capture the previous state before applying the optimistic change.
- On error, restore the previous state exactly.
- On error, show a toast explaining what happened and offering retry.
- After settlement (success or error), invalidate the relevant query to ensure the UI matches the server.

**Components:** Sonner (for rollback error toasts). The optimistic logic itself lives in mutation callbacks or custom hooks, not in UI components.

**Mistakes to avoid:**

- Optimistic updates without rollback handling. If you skip the error path, the UI will be wrong when the server rejects.
- Optimistic deletes. Removing an item from a list and then putting it back on failure is jarring and confusing. Prefer a confirmation dialog for deletes.
- Forgetting to invalidate after settlement. Even on success, the server may have computed fields or side effects that the optimistic state does not reflect.
- Applying optimistic updates to shared/collaborative state where another user might have changed the same data.

---

## 8. Status Communication via Badges

**User mental model:** "What state is this thing in?"

Badges communicate the current status of a domain object at a glance. They appear in tables, cards, detail views, and list items. The mapping from domain state to visual variant should be consistent across the entire application.

**Standard variant mapping:**

- **default** (filled, primary color) — Active, open, live states. The thing is in play. Use for: open trades, active traders, running backtests, live channels.
- **secondary** (muted, gray) — Inactive, closed, archived, completed states. The thing is done or dormant. Use for: closed trades, completed tasks, archived channels.
- **outline** (border only, no fill) — Intermediate or pending states. The thing is in transition. Use for: partial fills, pending tasks, queued orders, draft status.
- **destructive** (red) — Error or failed states. Something went wrong. Use for: failed orders, rejected trades, error tasks, disconnected brokers.
- **Custom green** — Positive financial outcomes. Profitable trades, gains, successful operations where green carries specific domain meaning (P&L context).
- **Custom amber** — Warning-level states. Approaching limits, partial issues, needs attention but not broken.

**When badges carry extra context:**

- Badges with icons: prefix with a small icon when the status has an associated action or visual metaphor (check circle for filled, clock for pending, alert triangle for warning).
- Badges with spinners: for in-progress states where the status is actively changing (syncing, processing). The spinner replaces the icon position.
- Badges as links: when clicking the badge should navigate to more detail about that status (e.g., clicking an "Error" badge on a trade opens the error log).

**Consistency rules:**

- One status, one variant. If "open" is the default variant on the trades page, it must be the default variant on the dashboard, the trader detail page, and everywhere else.
- Derive the mapping from a single config object. Do not scatter variant decisions across components.
- Provide a sensible fallback for unknown statuses (outline variant with the raw status text).

**Components:** Badge. Use the variant prop for standard semantics. Use className overrides for domain-specific colors (green for profit, amber for warning).

**Mistakes to avoid:**

- Inconsistent color mapping across pages. If "error" is red on the trades table but amber on the tasks page, users cannot build intuition.
- Too many distinct badge colors. If you have more than 5-6 visual variants, the distinctions become meaningless. Group similar states.
- Using badges for values that are not categorical. A badge saying "$1,234.56" is misusing the pattern. Badges are for status categories, not numeric values. (Exception: small P&L badges are a common convention in trading UIs — use them sparingly.)
- Badges without accessible text. The color alone should not carry the meaning — the label text must be sufficient.

---

## 9. Choosing the Right Feedback Mechanism

When something happens — or needs to happen — the choice of feedback mechanism depends on four factors: how long the information is relevant, whether it is tied to a specific action, where in the page it belongs, and whether the user needs to act on it.

**Decision tree:**

Is this feedback about a user action that just completed?
- Yes: **Toast.** The user acted, the system responded. Success, error, or info toast. Auto-dismisses.
  - Was the action destructive and easily reversible? Use a **toast with undo action.**
  - Was the action a long-running process? Use a **promise toast** (loading, success, error).

Is this a condition that persists across time?
- Yes: **Alert banner.** Broker disconnected, data stale, license expiring. Stays visible until the condition resolves.
  - Can the user fix it? Add an **action button** to the alert.

Is this about the status of a specific record?
- Yes: **Badge.** Open, closed, error, pending. Appears inline next to the record in tables, cards, or detail views.

Is this about a field-level input problem?
- Yes: **Inline validation.** FieldError below the specific field. Tied to blur or submit.
  - Is it a form-level error that does not map to a single field? Use an **alert banner above the form** or a **toast.**

Is the page waiting for data?
- Yes, and I know the layout shape: **Skeleton.**
- Yes, and I know the progress percentage: **Progress bar.**
- Yes, and it is tied to a button: **Button spinner.**

Is there no data at all?
- Yes: **Empty state.** First-run, filtered, or error variant depending on why it is empty.

**Common composition patterns:**

- **Mutation flow:** Button spinner during the call, toast on completion, inline validation if the server rejects specific fields.
- **Page load:** Skeleton while loading, empty state if zero results, alert banner if the data is stale or degraded.
- **Background process:** Promise toast for the lifecycle, progress bar if it is long-running, alert banner if it fails and the failure persists.
- **Status display:** Badges on records in tables and cards, alert banner at the page level for system-wide conditions.

**The layering principle:** These mechanisms are not mutually exclusive. A page can have an alert banner (broker disconnected), a table with badges (trade statuses), a button with a spinner (submitting an order), and a toast (order confirmed) — all at the same time. Each mechanism occupies a different layer of attention:

- **Peripheral** (badges) — Always visible, low attention demand. Glanceable status.
- **Contextual** (inline validation, empty states, skeletons) — Visible in the content area, medium attention. Relevant to what the user is looking at right now.
- **Ambient** (alert banners) — Visible at the section/page level, persistent awareness. Cannot be ignored but does not interrupt.
- **Interruptive** (toasts) — Overlays the page briefly, high attention. Tied to a moment in time.

Pick the layer that matches the information's urgency and lifespan. Do not promote peripheral information to an interruptive layer (toasting every status change) or demote interruptive information to a peripheral layer (showing API errors only as badges).
