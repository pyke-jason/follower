# Plan: Inline Label Review & Eval Simplification

## Goal
Replace the separate /eval labeling workflow with inline approve/edit buttons directly on the IntentStrip. One ground truth label per message, usable from live chat or backtest — wherever messages render. Rip out the old eval scaffolding that's no longer relevant.

---

## The Click Path

You're scrolling through messages (live chat or backtest). Each message with an intent shows the EXECUTE/SKIP pill + signal pills. Next to those pills:

- **Checkmark button** — "this intent is correct." One click. Creates/updates a `messageLabels` row by copying fields from the intent's signals. Marks `reviewed=true`. The checkmark turns solid green to show it's been approved.
- **Pencil button** — "this is wrong, let me fix it." Opens the label edit sheet pre-filled from the intent's signals. Save creates/updates the label and marks reviewed.
- If a reviewed label already exists for this message, the checkmark shows as solid (already approved). Clicking pencil lets you re-edit.

That's it. No separate /eval page needed for the review workflow. Labels accumulate organically as you use the app.

---

## Steps

### 1. Schema cleanup — one label per message
**Files:** `src/db/schema.ts`, new migration

- Add `uniqueIndex` on `messageLabels.messageId` (one label per message, no more labelSet multiplicity)
- Drop columns: `labelSet`, `modelProvider`, `modelName` (labels are human-reviewed truth, not model output)
- `source` stays but simplify: `'approved'` (one-click from intent) or `'manual'` (hand-edited)
- Run migration

### 2. New server actions for intent-based labeling
**File:** `web/app/messages/actions.ts` (add to existing)

- `approveIntent(messageId: string, intent: MessageIntent)` — upserts a `messageLabels` row:
  - `isTrade`: `true` if decision=EXECUTE and signals.length > 0, `false` if SKIP
  - Copies first signal's fields: `action`, `direction`, `strategy`, `symbol`, `limitPrice` → price, legs → strikes/expiry, `exitPercent`
  - Sets `source: 'approved'`, `reviewed: true`
  - Uses `INSERT ... ON CONFLICT(messageId) DO UPDATE`

- `saveIntentLabel(messageId: string, formData: FormData)` — same upsert pattern but with manually-edited fields from the edit sheet. Sets `source: 'manual'`.

### 3. Add approve/edit buttons to IntentStrip
**File:** `web/app/messages/intent-strip.tsx`

- Split into `IntentStrip` (server-renderable, display only — as now) and a new `IntentStripWithActions` client component wrapper
- `IntentStripWithActions` receives `intent` + `label` (existing label or null) props
- Renders after the signal pills:
  - `Check` icon button — calls `approveIntent`. Solid green fill if `label?.reviewed === true`
  - `Pencil` icon button — opens `LabelEditSheet`
- Small, unobtrusive — same 11px size as the signal pills

### 4. Refactor LabelEditSheet for intent pre-fill
**File:** `web/app/messages/label-editor.tsx` (move to shared location or keep here)

- Accept an `intent?: MessageIntent` prop for pre-filling (instead of requiring an existing label ID)
- Accept `messageId` directly for the upsert path
- Comparison grid: "Intent" column vs "Your Label" column (not "Parse" vs "Label")
- Remove `ParseHints` type dependency entirely
- Form submits to `saveIntentLabel(messageId, formData)` instead of `saveLabel(id, formData)`

### 5. Load labels alongside intents in queries
**File:** `web/lib/queries.ts`

- New function `getLabelsForMessages(messageIds: string[])` → `Record<string, MessageLabel>`
- Call it alongside `getLatestIntents()` in the messages page and backtest page
- Thread `labels` map through: ChatRoom → ChatFeed → ChatBubble → IntentStripWithActions
- Same for EnrichedChatPanel in backtest view

### 6. Rewrite run-eval.ts to compare intents vs labels
**File:** `src/eval/run-eval.ts`

- Instead of calling `classifyMessage()` (regex parser), join `messageIntents` against `messageLabels`
- Match on `messageId`, use latest intent version
- Compare:
  - Level 1: isTrade classification (precision/recall/F1)
  - Level 2: field accuracy when both agree it's a trade (action, direction, strategy, symbol)
  - Level 3: detail accuracy (strikes, expiry, price)
- Accept `--model` and `--version` flags to filter which intent version to evaluate
- Still persist to `evalRuns` table

### 7. Delete dead eval scaffolding

**Delete entirely:**
- `src/eval/label-runner.ts` — AI label generation, replaced by inline review
- `src/eval/label-orchestrator.ts` — parallel Claude Code workers, no longer needed
- `src/mcp/label-server.ts` — MCP tools for labeling, no longer needed

**Simplify /eval page:**
- `web/app/eval/page.tsx` — becomes read-only dashboard showing eval run results + accuracy trends
- Remove label table, inline edit buttons, filters (labeling happens in chat now)
- Keep: MetricStrip, AccuracyChart, eval run history table
- `web/app/eval/actions.ts` — remove `saveLabel`, `approveLabel`, `deleteLabel` (moved to messages/actions.ts)

---

## Schema Changes

### messageLabels — simplify
```
DROP: labelSet, modelProvider, modelName
ADD: unique index on messageId (one label per message, replaces labelSet concept)
```

### evalRuns — add intent tracking
```
ADD: model (text) — which intent model was evaluated
ADD: version (integer) — which intent version
```

---

## What stays untouched

- `messageIntents` table — still the inference cache, no changes
- `messages` table — still has parse hints for display coloring
- Intent extraction pipeline (`extract-intent.ts`) — unchanged
- The LabelEditSheet form fields — same fields, just different pre-fill source
- `evalRuns` table structure (mostly) — still tracks accuracy over time
