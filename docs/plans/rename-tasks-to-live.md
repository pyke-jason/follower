# Rename `src/tasks/` to `src/live/` — Clarify the Live/Shared Boundary

## Problem

`src/tasks/` contains exclusively live-execution code — the polling runner, Discord message-to-task factory, and task status recorder. Nothing in this folder is used by backtest. But the name "tasks" implies a general concept that should be shared between live and backtest execution paths.

This creates two concrete harms:

1. **Misleading scope.** New code that _should_ be shared (like OrderManager callback wiring) gets written into `src/tasks/runner.ts` because "tasks" sounds like the right home for task-processing logic. The backtest runner then copy-pastes it. The duplication compounds over time.

2. **Hidden coupling.** `recorder.ts` contains `enrichTradeWithFill` — a function that conceptually belongs to reconciliation, not task management. It ended up here because the file was already touching trade records. The `src/reconciliation/fill-sweep.ts` import path (`../tasks/recorder.js`) is a symptom: reconciliation code reaching into "tasks" for a function that has nothing to do with tasks.

The deeper code smell: `backtest/runner.ts` lines 193-244 and `tasks/runner.ts` lines 38-88 contain nearly identical OrderManager callback wiring (~50 lines). The only difference is the emitter scope (`backtestRunId` vs `taskId`). This duplication exists _because_ there's no clear shared home — it doesn't belong in `tasks/` (backtest-invisible) and it doesn't belong in `backtest/` (live-invisible).

---

## Goals

1. Every file in `src/live/` is unambiguously live-only code
2. Shared OrderManager callback logic lives in a shared location, called by both runners
3. `enrichTradeWithFill` moves to where it conceptually belongs (reconciliation)
4. All imports, docs, and rules are updated atomically — no dangling references
5. `web/app/tasks/` route stays as-is (it's a UI concept, not a code-organization issue)

---

## Non-Goals

- Renaming the `tasks` DB table or the `web/app/tasks/` UI route. "Task" is the correct domain concept for the queue item — the problem is the source folder name, not the data model.
- Refactoring risk dep construction. Live and backtest build `RiskCheckDeps` differently (real equity vs sim equity, real reconciliation alerts vs none). This is correct — the difference is intentional.
- Abstracting `ResolvedPipelineDeps` construction. The two runners build deps from fundamentally different sources (real broker vs sim broker, DB positions vs in-memory positions). A shared builder would be forced abstraction.

---

## Changes

### Phase 1: Extract shared OrderManager callback builder

**New file: `src/orders/build-order-callbacks.ts`**

Both `tasks/runner.ts` and `backtest/runner.ts` construct identical `onFill` / `onCancel` / `onAdjust` callbacks that:
1. Look up the pending intent by orderId
2. Create an emitter with a scope
3. Emit the event with the order payload
4. Call `recordFill` (for fills) or clean up (for cancels)

Extract a single factory:

```ts
import type { OrderManagerConfig } from './order-manager.js';
import type { ResolvedPendingContext } from '../pipeline/execute-resolved.js';
import type { SignalEventEmitter } from '../decisions/emitter.js';

type CallbackDeps = {
  pendingIntents: Map<string, ResolvedPendingContext>;
  createScopedEmitter: (messageId: string) => SignalEventEmitter;
};

export function buildOrderCallbacks(
  deps: CallbackDeps,
): Pick<OrderManagerConfig, 'onFill' | 'onCancel' | 'onAdjust'> {
  const { pendingIntents, createScopedEmitter } = deps;

  return {
    onFill: async (order) => {
      const pending = pendingIntents.get(order.orderId);
      if (!pending) return;
      pendingIntents.delete(order.orderId);
      const emitter = createScopedEmitter(pending.messageId ?? '');
      await emitter.emit('ORDER_FILLED', {
        orderId: order.orderId,
        symbol: order.params.symbol,
        strategy: order.params.strategy,
        direction: order.params.direction,
        filledPrice: order.filledPrice,
        filledAt: order.filledAt.toISOString(),
        filledQuantity: order.filledQuantity,
        commission: order.commission,
        legFills: order.legFills,
        adjustmentCount: order.adjustmentCount,
        originalLimitPrice: order.params.limitPrice,
        immediatelyFilled: false,
      }, { signalIndex: pending.signalIndex ?? null });
      await pending.recordFill(order.filledPrice, order.filledAt);
    },

    onCancel: async (order) => {
      const pending = pendingIntents.get(order.orderId);
      if (pending) {
        const emitter = createScopedEmitter(pending.messageId ?? '');
        await emitter.emit('ORDER_CANCELLED', {
          orderId: order.orderId,
          symbol: order.params.symbol,
          strategy: order.params.strategy,
          direction: order.params.direction,
          originalLimitPrice: order.params.limitPrice,
          finalLimitPrice: order.currentLimitPrice,
          adjustmentCount: order.adjustmentCount,
          reason: order.status,
          placedAt: order.placedAt.toISOString(),
        }, { signalIndex: pending.signalIndex ?? null, tradeId: pending.tradeId ?? null });
      }
      pendingIntents.delete(order.orderId);
    },

    onAdjust: async (order, fromPrice, toPrice, step) => {
      const pending = pendingIntents.get(order.orderId);
      if (!pending) return;
      const emitter = createScopedEmitter(pending.messageId ?? '');
      await emitter.emit('ORDER_ADJUSTED', {
        orderId: order.orderId, fromPrice, toPrice, step,
      }, { signalIndex: pending.signalIndex ?? null });
    },
  };
}
```

**Live caller** (`src/live/runner.ts`, after rename):
```ts
const pendingIntents = new Map<string, ResolvedPendingContext>();
const callbacks = buildOrderCallbacks({
  pendingIntents,
  createScopedEmitter: (messageId) =>
    createEmitter({ messageId, taskId: undefined }),
});
const orderManager = new OrderManager({
  broker: liveService,
  clock: () => new Date(),
  ...callbacks,
});
```

**Backtest caller** (`src/backtest/runner.ts`):
```ts
const pendingIntents = new Map<string, ResolvedPendingContext>();
const callbacks = buildOrderCallbacks({
  pendingIntents,
  createScopedEmitter: (messageId) =>
    createEmitter({ messageId, backtestRunId: runId }),
});
const orderManager = new OrderManager({
  broker,
  clock: () => clock.now(),
  manualTick: true,
  ...callbacks,
});
```

~50 duplicated lines in each runner collapse to ~5.

---

### Phase 2: Move `enrichTradeWithFill` to reconciliation

`enrichTradeWithFill` has nothing to do with task management. It's called exclusively by `src/reconciliation/fill-sweep.ts` to backfill broker fill data on trades.

**Move** `enrichTradeWithFill` from `src/tasks/recorder.ts` to `src/reconciliation/fill-enrichment.ts` (new file, single function).

**Update import** in `src/reconciliation/fill-sweep.ts`:
```ts
// Before
import { enrichTradeWithFill } from '../tasks/recorder.js';
// After
import { enrichTradeWithFill } from './fill-enrichment.js';
```

**What stays in `recorder.ts`**: `completeTask`, `failTask`, `startTask` — these are genuinely live task status operations.

---

### Phase 3: Rename `src/tasks/` to `src/live/`

Mechanical rename of the directory. Files moving:

| Old path | New path |
|---|---|
| `src/tasks/runner.ts` | `src/live/runner.ts` |
| `src/tasks/factory.ts` | `src/live/factory.ts` |
| `src/tasks/recorder.ts` | `src/live/recorder.ts` |
| `src/tasks/factory.test.ts` | `src/live/factory.test.ts` |

---

### Phase 4: Update all imports and references

**Source imports (3 files):**

| File | Old import | New import |
|---|---|---|
| `src/index.ts:5` | `'./tasks/runner.js'` | `'./live/runner.js'` |
| `src/index.ts:6` | `'./tasks/factory.js'` | `'./live/factory.js'` |
| `src/live/runner.ts:3` | `'./recorder.js'` | unchanged (relative stays same) |

**Documentation and rules (4 files):**

| File | Change |
|---|---|
| `.claude/rules/live-tasks.md` | Update `paths:` frontmatter from `src/tasks/**` to `src/live/**`. Update prose references. |
| `.claude/rules/pipeline-execution.md` | Line 40: `src/tasks/runner.ts` → `src/live/runner.ts` |
| `AGENTS.md` | Update directory tree: `tasks/` → `live/` |
| `docs/plans/close-order-unfilled-bugs.md` | Update references (2 lines) |

**No changes needed:**
- `web/app/tasks/` — UI route, different concept
- `web/lib/queries.ts` — queries `schema.tasks` (DB table), not the source folder
- `web/app/tasks/actions.ts` — same, DB operations
- `tsconfig.json` — uses `@/*` wildcard, no tasks-specific path

---

## Verification

After all changes:

1. `grep -r "tasks/runner\|tasks/factory\|tasks/recorder" src/` returns zero hits (only `live/` paths)
2. `grep -r "from.*tasks/" src/` returns zero hits for the old import paths
3. `npx tsc --noEmit` passes — all imports resolve
4. `npx vitest run src/live/factory.test.ts` passes — test file works from new location
5. `npx vitest run src/orders/` passes — new callback builder doesn't break existing order tests
6. Live runner starts and processes a task end-to-end
7. Backtest runner completes a short run with the extracted callbacks

---

## File Impact Summary

| Action | File | Lines changed (est.) |
|---|---|---|
| **New** | `src/orders/build-order-callbacks.ts` | ~55 |
| **New** | `src/reconciliation/fill-enrichment.ts` | ~35 (moved from recorder) |
| **Rename** | `src/tasks/` → `src/live/` | 4 files |
| **Edit** | `src/live/runner.ts` | -50 callback lines, +5 builder call |
| **Edit** | `src/backtest/runner.ts` | -50 callback lines, +5 builder call |
| **Edit** | `src/live/recorder.ts` | -35 (enrichTradeWithFill removed) |
| **Edit** | `src/index.ts` | 2 import paths |
| **Edit** | `src/reconciliation/fill-sweep.ts` | 1 import path |
| **Edit** | `.claude/rules/live-tasks.md` | path updates |
| **Edit** | `.claude/rules/pipeline-execution.md` | 1 line |
| **Edit** | `AGENTS.md` | directory tree |
| **Edit** | `docs/plans/close-order-unfilled-bugs.md` | 2 references |

**Net effect**: ~100 lines of duplication removed, 1 new shared module, clearer naming.

---

## Risk

**Low.** This is a mechanical rename + extract. No behavior changes, no type changes, no new logic paths. The callback extraction is a pure refactor — same code, different location.

The only subtle risk is the `pendingIntents` map being passed by reference into the callback builder. Both runners already create and own their map locally, so this is no different from today. The builder just closes over it.

---

## Order of Operations

Phases must execute sequentially:

1. **Phase 1 first** — extract callbacks while files are still at `src/tasks/`. This keeps the diff reviewable: the extraction is tested before the rename muddies the diff.
2. **Phase 2** — move `enrichTradeWithFill` while we're still editing `recorder.ts`.
3. **Phase 3** — rename directory.
4. **Phase 4** — update all imports and docs in one commit.

Phases 3 and 4 can be a single commit. Phases 1 and 2 should be separate commits for clean git history.
