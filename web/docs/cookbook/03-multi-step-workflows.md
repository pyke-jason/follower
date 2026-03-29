# Multi-Step Workflows & Wizards

A decision guide for breaking complex tasks into sequential, branching, or progressively revealed steps. Focuses on when and why to pick each pattern, not how to wire it up.

**Core principle:** Every step you add is friction. Add steps only when the user genuinely needs a pause to think, review, or make a choice that changes what comes next. If the whole thing fits on one screen without overwhelming them, it probably should.

---

## 1. Breaking a Complex Form into Steps

**The user's mental model:** "This is a lot of fields. I can not think about all of them at once."

### Decision tree: tabs vs stepper vs separate pages

- **Tabs** (Tabs, TabsList, TabsTrigger, TabsContent) -- Use when sections are independent and the user might fill them in any order. Each tab is self-contained. Nothing in tab B depends on what was entered in tab A. Think of a settings page with "General", "Notifications", "Integrations" sections. The tabs are categories, not a sequence.

- **Stepper** (Tabs used in controlled/linear mode with Progress) -- Use when sections must be completed in order because later steps depend on earlier answers. The user sees where they are and how far they have to go. A progress bar reinforces momentum. Tab triggers for future steps are disabled so the user can not skip ahead but can revisit completed steps.

- **Separate pages** (route-based navigation) -- Use when each step is heavy enough to justify its own URL. The user might bookmark a step, share a link to it, or return to it later in a different session. Each page fetches its own data. Back/forward browser buttons work naturally.

### When to pick which

- Three to five short sections, all independent: tabs.
- Three to five sections with sequential dependencies: stepper.
- More than five sections, or each section has significant load time or data requirements: separate pages.
- Two sections: do not use steps at all. Put both on one page with a Separator between them.

### Mistakes to avoid

- Splitting a form into steps just because it has many fields. If the fields are all simple and independent, a single long form with FieldSet sections and a sticky submit button is faster for the user.
- Letting the user advance to the next step without validating the current one. Validate on "Next", not on final submit. Discovering errors three steps back is infuriating.
- Hiding the step count. The user needs to know "step 2 of 4" to calibrate their effort. Progress without a denominator feels endless.

---

## 2. Wizard Inside a Dialog

**The user's mental model:** "I need to do a quick focused thing without losing my place on this page."

### When to contain a flow in a modal

- The flow is short (two to three steps) and fast (under a minute).
- The user was doing something on the current page and will return to it immediately after.
- The result of the wizard modifies something visible on the page behind it (e.g., adding an integration, connecting a broker account).

Use Dialog as the shell. Swap step content inside DialogContent while keeping the header and footer chrome stable. Progress goes in the dialog header. Footer always has Back and Next (or Cancel on the first step, Submit on the last).

### When to give it a full page instead

- The flow has more than three steps.
- Any step involves scrolling, complex inputs, or long-running operations the user might wait on.
- The user might want to abandon and come back later (dialogs have no URL, so refresh kills progress).
- The task is high-stakes enough that the user should not be distracted by the page behind the modal.

### Flow in plain English

User clicks a trigger button. Dialog opens on step one. The dialog title and description update per step. User moves forward or backward through the steps. On the final step, a submit action closes the dialog and updates the parent page. If the user cancels at any point, all draft state is discarded and the dialog closes cleanly.

### Mistakes to avoid

- Making the dialog too tall. If a step's content requires scrolling inside the dialog, the step has too much in it. Split it or move to a full page.
- Nesting a confirmation AlertDialog inside the wizard Dialog. The double-overlay is disorienting. If the final step needs confirmation, make the final step itself a review/confirm screen.
- Forgetting to reset wizard state on close. If the user cancels on step two and reopens the dialog, they should land on step one with a clean slate, not where they left off.

---

## 3. Progressive Disclosure

**The user's mental model:** "Show me only what I need right now. I will dig deeper when I am ready."

### The pattern

Instead of laying out all sections at once, reveal them one at a time as the user completes each. The next section unlocks when the current one is done. Completed sections collapse but remain accessible for editing.

Use Accordion with controlled state. Each AccordionItem is disabled until its prerequisite is complete. A Badge on each trigger shows status: current, complete, or locked.

### When progressive disclosure beats a stepper

- All sections live on a single page (no step navigation, no pagination).
- The user benefits from seeing completed sections in context while working on the next one.
- Sections vary dramatically in size. A stepper makes a one-field section feel as heavy as a ten-field section. An accordion lets short sections feel light.
- The user might revisit and edit a completed section at any time without "going back."

### When a stepper beats progressive disclosure

- The form is so long that showing all sections on one page (even collapsed) is overwhelming.
- You need a clear progress bar. Accordions do not convey "you are 60% done" the way a stepper does.
- The sections have no meaningful relationship to each other and the user gains nothing from seeing them adjacent.

### Mistakes to avoid

- Auto-collapsing the section the user just completed before they have a chance to review it. Complete the section, open the next, but leave the completed one visible for a beat.
- Locking completed sections from editing. The user should always be able to reopen and change earlier answers.
- Using progressive disclosure for two sections. It adds mechanism with no payoff. Just show both.

---

## 4. Review-Before-Submit

**The user's mental model:** "Before I pull the trigger, let me see everything I am about to commit in one place."

### When the stakes justify a summary step

- The action has real-world consequences: placing a trade, sending a notification, creating records that affect other users.
- The form spans multiple steps and the user can not see all their inputs at once.
- Inputs involve calculated or derived values (totals, dates, risk amounts) that the user should sanity-check.
- Mistakes are costly to undo or cannot be undone at all.

### What the review step looks like

A read-only Card that mirrors the form structure but replaces inputs with formatted display values. Each section has an "Edit" link that jumps back to that step. At the bottom: a submit button that either fires directly (low stakes) or opens an AlertDialog for confirmation (high stakes).

Two-phase state: "edit" and "review." The user moves from edit to review via a "Review" button. From review, they can go back to edit or proceed to submit.

### When to skip the review step

- The form is short enough that the user can see all their inputs on one screen already.
- The action is easily reversible (undo toast pattern from the destructive actions guide).
- The user will see the result immediately and can correct mistakes inline (e.g., editing a name that displays on the same page).

### Mistakes to avoid

- Making the review step a dead end. Always provide a clear path back to editing.
- Showing raw data in the review (ISO timestamps, enum values, IDs). Format everything for human readability.
- Requiring review for low-stakes forms. It just adds a click for no safety benefit.

---

## 5. Branching Paths

**The user's mental model:** "My choice here determines what I need to fill out next."

### The pattern

A choice on one step determines which step appears next. The path through the wizard is not linear -- it is a directed graph. Common examples: choosing between stock vs option changes which detail fields appear. Choosing "import from file" vs "enter manually" changes the next screen entirely.

Define a step graph: a map where each step knows its possible next steps based on user selections. Maintain a history stack so the Back button always returns to the step the user actually came from, regardless of which branch they took.

Components: Card for the step shell, RadioGroup for branch selection (or Select when there are many options), Progress, Button for navigation. Breadcrumb can show the resolved path dynamically.

### When branching paths are the right call

- Different choices require genuinely different inputs. Not just showing/hiding a field, but entirely different sections.
- The branches are meaningfully different experiences, not cosmetic variations.
- There are two to four branches. More than that and the wizard becomes a maze.

### When to avoid branching

- The "branches" only differ by one or two fields. Use conditional visibility within a single step instead (show/hide a field group based on a toggle or select value).
- The user needs to compare the branches side by side before choosing. A wizard hides the unchosen path. Use a tabbed layout or side-by-side cards instead.

### Flow in plain English

User arrives at a choice step. They pick an option (stock vs option, manual vs import, etc.). They click Next. The wizard resolves the next step from the graph and pushes the current step onto the history stack. If they click Back, the wizard pops the stack and returns to the previous step, preserving the choice they made. Branches can converge later (e.g., both stock and option paths lead to a shared "sizing" step, then "review").

### Mistakes to avoid

- Losing form data when the user backtracks through a branch and takes a different path. Preserve all data from all branches. If they switch from option back to stock, the option data should still be there if they switch back again.
- Making the progress bar misleading. In a branching wizard, the total number of steps varies by path. Calculate progress from the resolved path length, not a fixed total.
- Forgetting that Back needs a stack. If you track "previous step" as a single value instead of a history array, Back breaks when the user is more than one step into a branch.

---

## 6. Onboarding / First-Time Setup

**The user's mental model:** "I just got here. Tell me what to do, one thing at a time, and get me to the good part fast."

### The pattern

A full-page, minimal-chrome experience. No sidebar, no header, no navigation. Just a centered panel with a headline, a brief explanation, a single action, and a progress bar spanning the top of the viewport. Each step is one concept, one decision, one action.

Use the Empty component set (Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent) for the centered panel structure. Progress at the top. Button as the primary CTA. Optional "Skip for now" as a ghost button for non-essential steps.

### Onboarding vs a normal wizard

Onboarding differs from a regular multi-step form in several ways:

- Navigation is forward-only by default. Back buttons slow momentum. The user is learning, not editing.
- Each step should be completable in under 30 seconds. If a step takes longer, it is too heavy for onboarding. Let them configure it later.
- Skippable steps are fine. Not every setup task is required on day one. "Skip for now" with a way to return later is better than forcing a decision the user is not ready to make.
- The final step should celebrate and orient. "You are all set" with a clear call to action that takes them to the main experience.

### When to use full-page onboarding

- The app requires configuration before it is useful (connecting a broker, setting API keys, choosing preferences).
- New users need context about what the app does and how it works.
- There are three to five setup tasks that must happen in a specific order.

### When to skip onboarding and use inline guidance instead

- The app works with sensible defaults out of the box.
- Setup is a single action (e.g., one API key). Use an inline banner or empty state prompt instead of a multi-step flow.
- The user is a power user who will find the settings page on their own. A forced walkthrough wastes their time.

### Flow in plain English

User lands on the app for the first time. Instead of the normal dashboard, they see the onboarding flow. Step one is a welcome screen that sets expectations. Subsequent steps each handle one configuration task. Optional steps have a "Skip for now" link. The final step confirms everything is set up and provides a single button to enter the main app. The onboarding flag is saved so returning users go straight to the dashboard.

### Mistakes to avoid

- Asking the user to make decisions they do not have enough context for yet. "Choose your risk tolerance" means nothing to someone who has not seen how the app works.
- Making onboarding unskippable when reasonable defaults exist. If the app can function without a setting, do not block the user from getting in.
- Losing progress on browser refresh. Persist the current onboarding step so the user picks up where they left off.
- Showing onboarding to returning users. Gate it behind a "has completed onboarding" flag.
- Cramming too much into one step. If you are tempted to add a scroll bar to an onboarding panel, the step needs to be split.

---

## Quick Reference: Which Pattern to Use

| User intent | Pattern | Key signal |
|---|---|---|
| Fill out a long form with independent sections | Tabs | Sections can be completed in any order |
| Fill out a form where each section depends on the previous | Stepper | Must complete step 1 before step 2 makes sense |
| Quick multi-step task without leaving the current page | Dialog wizard | Two to three steps, under a minute, modifies current page |
| Show complexity only as the user needs it | Progressive disclosure (Accordion) | Sections vary in size, user benefits from seeing context |
| Verify before committing a high-stakes action | Review-before-submit | Real-world consequences, costly to undo |
| User choice determines what comes next | Branching wizard | Genuinely different inputs per branch |
| Guide a new user through initial setup | Onboarding flow | App requires configuration before it is useful |
| Simple two-section form | Do not use steps. One page, one submit. | The overhead of steps exceeds the complexity of the form |
