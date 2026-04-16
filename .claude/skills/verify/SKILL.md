---
description: Verify a feature works end-to-end like a real user — start dev server, interact via Playwright, run quality gates, fix anything broken. Use after building or changing UI/API features.
user-invocable: true
argument-hint: "[feature or page to verify]"
---

# Verify

You are verifying that a feature actually works, not just compiles. The standard is: you used it and it worked. A screenshot of an empty state proves nothing.

## Usage

- `/verify` -- verify the most recently changed feature (infer from git diff)
- `/verify trades table` -- verify a specific feature or page
- `/verify /eval/review` -- verify a specific route

## Protocol

Run these steps in order. Do not skip steps. If anything fails, fix it and restart from that step.

### 1. Start the dev server

```bash
npm run up:ui   # web + local API (use `npm run up` if backend is also needed)
```

Confirm both Vite (:3000) and local API (:3791) are running before proceeding.

### 2. Identify what to verify

If an argument was provided, use it. Otherwise check `git diff --name-only` to find changed files and infer the affected pages/features.

### 3. Navigate and interact with Playwright

Open the relevant page in Playwright. Then exercise the feature the way a human would:

- **Load the page.** Does it render without errors? Check the console for warnings/crashes.
- **Interact with every control.** Click buttons, open dropdowns, fill inputs, submit forms, toggle filters, sort columns, paginate.
- **Test with real data.** If the page is empty, create data through the UI first. Verify the DB actually changed. Clean up test data when done.
- **Test edge cases.** Empty states, long text, missing/null fields, rapid clicks, browser back/forward.
- **Test responsive behavior.** Resize if layout changes are involved.

Take screenshots at each step as evidence. Do not stop at the first screenshot -- interact and verify the result of each interaction.

### 4. Run quality gates

```bash
npx tsc --noEmit && npm test && npm --prefix web run check
```

All three must pass. If any fail, fix the issue before continuing.

### 5. Fix and iterate

If anything is broken -- a page that doesn't render, a button that does nothing, a layout that looks wrong, a type error, a failed test -- fix it. Then go back to step 3 and re-verify.

Do not report a problem and stop. Fix it.

### 6. Report results

After everything works, summarize:
- What was verified (pages, features, interactions)
- What issues were found and fixed (if any)
- Final state: all quality gates passing, feature working end-to-end

## Rules

- **Proof requires interaction.** Navigating to a page is not verification. You must click, type, submit, and confirm the result.
- **Empty states are not proof.** If a table shows zero rows, that could mean the query is broken. Create data and verify it appears.
- **Fix, don't report.** If you find a bug during verification, fix it immediately. The goal is a working feature, not a bug report.
- **Iterate until right.** Your first fix might not work. Debug, fix, try again. You are done when the feature works, not when you have attempted a fix.
- **Clean up.** Delete any test data you created. Remove scratchpad scripts.
