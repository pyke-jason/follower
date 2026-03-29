# Destructive Actions & Confirmations

A decision guide for handling dangerous, irreversible, or high-stakes actions in the UI. The goal is always the same: the user should feel safe, informed, and in control. The mechanism varies by severity.

**Severity ladder:** Undo toast (lightest) < AlertDialog (medium) < type-to-confirm AlertDialog (heaviest). Pick the lightest option that matches the actual risk. Not every delete needs a modal.

---

## 1. Deleting a single record

**When the user clicks delete on one item** -- a trade, a task, a message -- they are focused and intentional. They know what they want gone. The question is whether the consequence is obvious enough to skip a confirmation or serious enough to require one.

**User's mental state:** Deliberate. They selected a specific thing and chose to destroy it. They need to know what will happen and feel confident the system will not surprise them.

**Decision: AlertDialog or undo-via-toast?**

- Use AlertDialog when the deletion is permanent and there is no server-side soft-delete or undo mechanism. The user needs to consciously affirm "yes, destroy this." The dialog names the thing being deleted, states what will be lost, and offers Cancel alongside a destructive-styled confirm button.
- Use undo-via-toast when the action is reversible (soft-delete, archive, or you can hold off on committing for a few seconds). This is faster and less disruptive. The item vanishes instantly and a toast appears with an Undo button. If the user does nothing, the deletion finalizes after the toast expires.

**The interaction flow for AlertDialog:** User clicks the delete button. A modal dialog appears with a clear title ("Delete this trade?"), a description of consequences, and two buttons: Cancel (default focus) and Delete (destructive styling). The dialog cannot be dismissed by clicking outside or pressing Escape -- the user must make an explicit choice.

**The interaction flow for undo-toast:** User clicks delete. The item disappears from the list immediately (optimistic update). A toast slides in with a short message and an Undo button. If Undo is clicked, the item reappears. If the toast auto-dismisses (5 seconds is standard), the deletion commits permanently.

**Pick AlertDialog when:**
- There is no undo path
- The record has children or side effects (see section 6)
- The user might have clicked accidentally (small touch targets, dense lists)

**Pick undo-toast when:**
- You can implement soft-delete or deferred commit
- The action is low-stakes (dismissing a notification, removing a tag)
- Speed matters more than ceremony (the user is doing this repeatedly)

**Common mistakes:**
- Confirming every single delete, even trivial ones. This trains users to click "confirm" reflexively, which defeats the purpose.
- Using undo-toast but not actually implementing undo. If the toast says Undo but the backend already hard-deleted, you have lied to the user.
- Vague dialog text. "Are you sure?" tells the user nothing. Name the thing. Describe the consequence.

---

## 2. Catastrophic actions (drop all data, revoke access)

**When the user is about to do something with blast-radius** -- wipe an entire channel, delete all backtest history, revoke their own API key -- the stakes are existential. Accidental execution would be devastating and there is no recovery.

**User's mental state:** Either fully committed (they have thought about this and want to proceed) or dangerously casual (they are exploring the settings page and clicked something without reading). The UI must distinguish these two users and protect the casual one without annoying the committed one.

**Why type-to-confirm is appropriate here:** A simple "are you sure?" dialog can be dismissed with a mindless click. Type-to-confirm adds just enough friction that the user must engage cognitively. They have to read the resource name, type it out, and see the confirm button enable. This takes about five seconds -- enough time for "wait, do I really want this?" to surface.

**Which component to use:** AlertDialog with an Input field inside. The confirm button starts disabled and only enables when the typed text matches the confirmation phrase exactly.

**The interaction flow:** User clicks the trigger. AlertDialog opens with a title naming the action, a description spelling out every consequence, and an input field with instructions like "Type the channel name to confirm." The confirm button is grayed out. As the user types, the button remains disabled until the text matches. On confirm, the action fires. On cancel or close, the input resets.

**What to use as the confirmation phrase:**
- The name of the resource being destroyed (best -- forces the user to acknowledge exactly what they are deleting)
- A specific word like "DELETE" or "CONFIRM" (weaker -- does not connect the user to the specific resource, but simpler when the resource name is long or ugly)

**When to escalate further:** If the action is both catastrophic and has cascading effects (deleting a trader and all their trades, tasks, and decisions), combine type-to-confirm with a cascade breakdown (see section 6). Show what will be destroyed, then require the typed confirmation.

**Common mistakes:**
- Using type-to-confirm for routine deletes. Reserve it for actions where the blast radius is genuinely large. Overuse breeds resentment.
- Making the confirmation phrase case-sensitive without telling the user. Either be explicit about case or normalize the comparison.
- Forgetting to reset the input when the dialog closes. If the user opens it again, they should start fresh.

---

## 3. Destructive option buried in a menu

**When a delete action lives inside a DropdownMenu or ContextMenu** -- the typical row-actions pattern in a data table -- the challenge is surfacing danger without disrupting the flow of non-destructive actions in the same menu.

**User's mental state:** Browsing options. They opened the menu to see what they can do with this row. They might want to edit, duplicate, or export. Delete is one option among many. The UI needs to signal "this one is different" without making the entire menu feel scary.

**How to surface danger without disrupting flow:**

- Place the destructive item last in the menu, separated from other items by a visual divider. Users scan menus top to bottom; safe actions come first.
- Style it with the destructive variant so it renders in red (or whatever the destructive color is). This is the visual equivalent of a warning label. The user's eye catches it before their finger reaches it.
- Do not put the destructive item behind a submenu or second level. That adds friction in the wrong place -- the friction should come after they click, not before.

**The critical composition detail:** The menu and the confirmation dialog are separate overlays. When the user clicks the destructive menu item, the menu closes and the AlertDialog opens. These are sibling components in the tree, not nested. Nesting AlertDialog inside DropdownMenu causes focus traps and portal conflicts. The menu item sets a state flag; the AlertDialog reads that flag.

**The interaction flow:** User clicks the row's action button (three dots). DropdownMenu opens. They see Edit, Duplicate, a separator, then Delete in red. They click Delete. The menu closes. An AlertDialog opens asking them to confirm. They confirm or cancel. If they confirm, the row is removed.

**When to skip the confirmation:** If the destructive action in the menu is low-stakes (remove from list, unpin, unstar), use the undo-toast pattern instead. The menu item fires the action immediately, the menu closes, and a toast appears with Undo.

**Common mistakes:**
- Nesting the dialog inside the menu component. This creates janky focus behavior where the dialog opens and immediately loses focus, or the menu portal intercepts clicks.
- Not using the destructive variant on the menu item. Without visual differentiation, the user can click Delete as easily as Edit.
- Opening the dialog with no transition after the menu closes. The menu should finish its close animation before the dialog appears. A controlled open state with the right timing handles this naturally.

---

## 4. Batch deletion (multiple items selected)

**When the user has checked several rows and wants to delete them all** -- the pattern shifts from confirming identity ("delete this trade?") to confirming scope ("delete these 14 trades?").

**User's mental state:** They have been selecting items deliberately. They are in "batch mode" -- working through a list, making choices. They feel efficient and want to keep moving. But the accumulated risk is higher than a single delete, and they need the UI to reflect that.

**How the pattern changes from single delete:**

- The confirmation dialog should state the count prominently. "Delete 14 trades?" is more informative than "Delete selected items?"
- The confirm button should echo the count: "Delete 14 Trades" rather than just "Delete." This gives the user a final sanity check on scope.
- A toolbar or floating bar should appear when items are selected, showing the count and offering bulk actions. The destructive action is one button among potentially several (archive, export, reassign). Only the destructive action needs a confirmation dialog.

**The interaction flow:** User checks rows using checkboxes (individual or select-all). A toolbar appears showing "14 selected" and action buttons. They click "Delete Selected." An AlertDialog opens: "Delete 14 trades? This will permanently remove the selected trades and all associated legs. This action cannot be undone." They confirm or cancel. On confirm, all selected items are deleted and the selection clears.

**Scaling considerations:**
- For small batches (under 10), the count in the dialog title is sufficient.
- For large batches (50+), consider showing a brief summary of what is selected -- "14 open trades, 3 closed trades" -- so the user can verify they have not accidentally selected more than intended.
- For "select all across pages" (where the user has selected items they cannot currently see), add extra emphasis. The dialog should note that items on other pages are included.

**Common mistakes:**
- Leaving stale selections after the delete completes. Always clear the selection set after a successful batch operation.
- Not disabling the select-all checkbox in the header when the table is empty or loading.
- Showing a generic "Are you sure?" without the count. The whole point of the batch confirmation is scope awareness.

---

## 5. Undo-first pattern (act now, offer reversal)

**When "confirm first" is too slow** -- the user is performing a repetitive, low-stakes action (dismissing alerts, clearing notifications, archiving messages) -- the undo-first pattern respects their momentum.

**User's mental state:** They are moving fast. They are cleaning up, triaging, or doing housekeeping. Every confirmation dialog breaks their flow. They want the action to happen instantly and trust that they can reverse a mistake if one occurs.

**When undo-first beats confirm-first:**
- The action is individually low-stakes (losing one dismissed alert is annoying, not catastrophic)
- The action happens frequently (the user might do it 10 times in a session)
- Reversal is technically feasible (soft-delete, deferred commit, or client-side state restoration)
- The UI update is visually obvious (the item disappears, so the user immediately sees what happened)

**When to avoid undo-first:**
- The action affects other users or external systems (you cannot un-send an email)
- The action has cascading side effects that are expensive to reverse
- The undo window is too short for the user to notice and react

**The interaction flow:** User clicks dismiss/archive/remove. The item vanishes immediately with a brief exit animation. A toast appears at the bottom of the screen: "[Item] dismissed" with an Undo button. The toast persists for 5 seconds (standard) or longer for higher-value items (8-10 seconds). If the user clicks Undo, the item reappears in place. If the toast auto-dismisses, the server commits the permanent deletion.

**Implementation strategy matters here.** There are two approaches:

- Deferred commit: The client removes the item from the UI but does not tell the server until the toast expires. Undo simply restores client state. This is simpler but means a page refresh during the undo window will show the item still present.
- Immediate soft-delete with reversal: The client tells the server to soft-delete (set a deletedAt timestamp) immediately. Undo tells the server to clear deletedAt. The toast expiration triggers a hard-delete. This is more robust but requires the server to support soft-delete.

**Batch undo:** When multiple items are dismissed in quick succession, collapse them into a single toast: "3 alerts dismissed" with one Undo button that restores all of them. Do not stack three separate toasts.

**Common mistakes:**
- Setting the undo window too short. Two seconds is not enough time for a user to read the toast, process what happened, and decide to undo. Five seconds is the minimum.
- Not handling the race condition where the user navigates away during the undo window. If they leave the page, the toast disappears. Either commit on navigation or persist the undo state across routes.
- Showing an undo toast for an action that cannot actually be undone. This is worse than no toast at all.

---

## 6. Cascading effects (deleting X also affects Y and Z)

**When deleting a parent resource triggers a cascade** -- removing a trader deletes their trades, tasks, and decision history; removing a channel wipes everything scoped to it -- the user must understand the full blast radius before confirming.

**User's mental state:** They may know they want to delete the parent but have not thought through what else will be destroyed. They need the UI to surface those consequences clearly, without overwhelming them with a wall of text.

**How to communicate cascading effects:**

- The dialog title names the primary action: "Delete trader Pete?"
- The description states the total impact in one sentence: "This will also permanently delete 47 related records."
- Below the description, a collapsible section lets the user expand and see the breakdown by type: "23 trades, 18 tasks, 6 decisions." Use Collapsible with a trigger like "View affected resources."
- Each category in the breakdown shows a count via Badge and optionally lists the items (trade tickers, task titles) so the user can verify they are deleting the right thing.

**The interaction flow:** User clicks delete on the parent. AlertDialog opens. The title and description communicate the cascade at a glance. The user can expand the collapsible to see specifics or trust the summary. The confirm button shows the total count: "Delete Everything (48)." They confirm or cancel.

**When to combine with type-to-confirm:** If the cascade is large (dozens of child records) or the parent is irreplaceable (a channel with months of history), layer type-to-confirm on top of the cascade display. Show the cascade breakdown first, then require typing the resource name below it.

**When to fetch cascade data lazily:** If computing the cascade count requires a database query, fetch it when the dialog opens (on the controlled open state change) and show a loading skeleton in the cascade area. Do not block the dialog from opening -- show the title and description immediately, and let the cascade details load in.

**Showing cascading effects without a dialog:** Not every cascade needs a full AlertDialog. If the user is hovering over or selecting a delete option, a Tooltip or inline warning ("This will also remove 12 trades") can communicate the cascade before they commit to the action. The dialog then serves as final confirmation, not first notification.

**Common mistakes:**
- Hiding the cascade information. If deleting a trader silently wipes 50 trades, the user will lose trust in the system permanently. Always surface cascading effects.
- Showing every single child record in a flat list. If there are 200 trades, do not render 200 list items. Show the count per category and optionally let the user expand to see a capped list with "and 180 more."
- Using vague language like "related data will be affected." Be specific: name the types, show the counts, and use "permanently delete" not "affect."
- Forgetting to include the parent in the total count. If you are deleting 1 trader + 47 children, the button should say "Delete Everything (48)" not "Delete Everything (47)."

---

## Quick reference: which pattern to use

| Severity | Example | Pattern |
|----------|---------|---------|
| Low | Archive alert, remove tag, dismiss notification | Undo toast (section 5) |
| Medium | Delete a single trade, remove a task | AlertDialog (section 1) |
| Medium | Delete from row-actions menu | DropdownMenu + AlertDialog (section 3) |
| Medium-high | Batch delete selected rows | Selection toolbar + AlertDialog with count (section 4) |
| High | Delete parent with children | AlertDialog with cascade breakdown (section 6) |
| Critical | Delete channel, wipe all data, revoke key | Type-to-confirm AlertDialog (section 2) |

**The universal principle:** Match friction to risk. Too little friction and the user destroys something by accident. Too much friction and they stop reading confirmations entirely, which is even more dangerous.
