---
paths: **
---

# Refactor Hygiene

Rules for finishing refactors cleanly. Both rules below are hard learnings from shipped cruft — each section has the exact shape of the anti-pattern so future agents cannot miss it.

## Never ship re-export shims for backwards compatibility

When moving, renaming, or deleting a type, function, component, or module, update every importer in the same change. Do not leave the old location with a re-export line to keep old imports resolving.

**Banned shapes:**

```ts
// Bad — re-export shim in the old file
// Re-export for backward compatibility with existing consumers.
export type { ChannelBrief, ChannelKind } from '@/lib/api-types';
export type StatusData = StatusResponse;
```

```ts
// Bad — alias shim
export type OldName = NewName;
```

```ts
// Bad — wrapper re-export
export { newThing as oldThing } from '@/lib/new';
```

**Why:** This is an internal application, not a published package. Nothing outside `trade-follower-3/` imports from these paths. A shim pretends the old module still owns the thing, hides that the move is incomplete, and guarantees the next person who grep's by the old name will re-wire a new caller against the dead path.

**How to apply:**
- Before renaming or moving, `grep` every importer. If you cannot update them in the same change, the refactor is out of scope — stop before starting the move.
- When you find an existing shim, delete it and fix the importers. Do not propagate it.
- The only place a re-export is acceptable is a deliberate public-surface `index.ts` barrel (e.g., `lib/index.ts` that curates what a subtree exposes) — never a "compat bridge."

## Never ship apologetic comments about the state of the code

Do not leave comments that excuse half-done work or describe the code the file *should* become. If the refactor is incomplete, either finish it or stop before shipping the intermediate state.

**Banned shapes:**

```ts
/**
 * NOTE: Ideally this store would hold nothing — the URL is the
 * source of truth for the active channel id and TanStack Query is
 * the source of truth for the /status response.
 *
 * The remaining state slices are kept only because several
 * components outside this refactor's scope still read them. Those
 * consumers should be migrated, after which this file can be
 * deleted entirely.
 */
```

```ts
// (Transitional) Bridges the new cache into the old store
```

```ts
// ── Transitional store bridge ──
```

```ts
// Once consumers migrate, this can be removed.
// For now, we keep the old shape.
// TODO(@next-person): delete this file
```

**Why:** Apologetic comments are load-bearing procrastination. They let the author stop halfway, they normalize shipping cruft, and the next reader treats them as license to leave their own half-done work behind the same justification. The "non-migrated consumers" list drifts from reality the moment anything in the repo changes, so even the apology rots. Comments explain non-obvious WHY of current code; they never excuse current code for not being future code.

**How to apply — three tests before a comment ships:**
1. Does it describe what the code *should* look like instead of what it does? Delete it.
2. Does it list files, consumers, or migrations still pending? That belongs in a task, not a comment. Delete it and open a task, or finish the work.
3. Does it use words like *ideally*, *eventually*, *transitional*, *for now*, *once X migrates*, *can be deleted*, *outside this refactor's scope*? Delete it and either finish the work or stop before the intermediate state ships.

If a genuinely non-obvious invariant needs a comment, it reads like "Safety: we read this ref in a layout effect because reading during render races with React 19's batching" — a concrete mechanical reason tied to *current* code, not a roadmap.

## How to stop at a clean boundary

When cross-scope work appears mid-refactor (the file you need to touch is in someone else's feature, or the migration needs updates to N unfamiliar consumers):

- **Do:** Finish the slice you can actually land cleanly. Open a task for the remaining work. Delete any scaffolding that only existed to bridge to the unfinished part.
- **Don't:** Ship a shim + apology comment explaining why the scaffolding is still there. That is the failure mode this rule exists to prevent.

The state to aim for is: every file you ship looks like it was always that way. Not "this is step 2 of a 4-step migration."
