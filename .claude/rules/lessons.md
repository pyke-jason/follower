# Lessons — Recurring Cruft Patterns

Short-form field notes on anti-patterns that keep showing up in this codebase. Each entry names a smell, explains why it's wrong, and points at the fix. If you see one while editing, fix it then and there.

## Shape-plumbing cruft (page-adapter → view → component)

Data flowing from API → adapter → view → child component accumulates three bugs:

1. **Duplicate inline type declarations.** The same `{ field: type; ... }` shape is spelled out verbatim on the adapter's return type, on the view's prop, and on the child component's prop. Three declarations, one concept. Adding a field means editing three files; forgetting one gives a silent structural-type match that drifts.

2. **Identity `.map()` calls.** A component receives data in shape A, maps it into shape B, where B differs from A by one renamed field (or nothing at all). The map allocates N objects per render to change a key name. If every field appears on both sides of the arrow, it's a rename, not a transform — and the rename belongs at the producer.

3. **Type-lied arrays.** `const rows: Canonical[] = producer.map(...)` compiles only because the mapper's literal object happens to match `Canonical`. There's no structural contract — adding a required field to `Canonical` won't error at the call site. The annotation lies about what's enforced.

### How to fix

- **One canonical type per concept, exported from its most-canonical home.** Usually the shared component that consumes the shape (`BreakdownRow` from `breakdown-table.tsx`, `UnrealizedPnlPoint` from `overview-equity-curve.tsx`). If the shape flows from the backend and isn't UI-specific, use the backend type directly (`@src/backtest/types`, or `BacktestDetailResponse['field'][number]`).
- **Push reshaping to the boundary** — `web/src/lib/page-adapters.ts` or a fetching hook in `web/src/hooks/`. Adapters emit final shapes; views render; components don't reshape inputs.
- **Kill identity maps.** If a `.map()` is `(row) => ({ ...row })` or `(row) => ({ a: row.a, b: row.b })` after your changes, delete it.
- **Import, don't redeclare.** Views/components import the canonical type; never re-spell `{ name: string; pnl: number; ... }` inline.

### Don't

- Don't invent a parallel type (`TraderRow`) when a structurally-identical one already exists (`BreakdownRow`). Reuse.
- Don't push a rename upstream if it destroys semantic meaning — e.g. `grade → label` loses the letter-grade keying used by color maps and filters elsewhere. Keep the rename local when the source name is load-bearing.
- Don't confuse identity maps with real transforms. String-to-number coercion (`toNumber(row.totalPnl)`), math (`-drawdown`), or derivation (`wins / tradeCount * 100`) is real work and belongs wherever it's most cohesive.

**Why:** Shape cruft is entropy. Each duplicate type is a future drift point; each identity map is a per-render allocation buying nothing. Fix it at the boundary once instead of at every consumer forever.

**How to apply:** When writing or editing any `views/**/*.tsx` or `page-adapters.ts`, check: (a) is this prop type an inline shape that looks like some component's canonical row? (b) is this `.map()` just renaming fields? If yes to either, fix the source.

## See also

- `web-components.md` — page architecture, file size limits, reuse-before-rebuild table
- `react-composition.md` — children-first, lift content up, push state down
- `react-state.md` — where state lives; never copy server data into local state
