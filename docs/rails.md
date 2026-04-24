# Development Guardrails

## Core Principles

- TypeScript strict mode everywhere -- no `any`, no `as` casts without `// SAFETY:` justification
- Zod schemas at the boundaries (API handlers, CLI args, env vars, LLM output) -- types derived via `z.infer`, interior code trusts them
- One concept, one place -- three similar lines is better than a premature helper
- No backwards compatibility -- internal tool, single operator. If a type changes, update all consumers
- Clean as you go -- fix dead exports and duplicate logic in files you're already touching

## TypeScript & Type System

- Derive types from canonical sources using `Pick`, `Omit`, `Extract`, `z.infer<>`
- Name cross-module types -- no inline anonymous object types in signatures
- Type callbacks narrowly -- `onFill` gets `FilledWorkingOrder`, not `WorkingOrder`
- Cross-field constraints via Zod `.refine()` at entry points
- No `[key: string]: unknown` on typed interfaces -- use a discriminated union or explicit `extra?: Record<string, unknown>`
- Two identical casts = extract an accessor. Three = the type is wrong at the source.

## File & Naming Conventions

- Files: kebab-case (e.g., `sim-broker.ts`, `risk-check.ts`, `use-channel-id.ts`)
- Components: PascalCase exports (e.g., `export function BacktestBanner()`)
- Hooks: camelCase with `use` prefix (e.g., `useChannelId`, `useScopedHref`)
- Schemas: camelCase with `Schema` suffix (e.g., `orderResultSchema`)
- Types: PascalCase (e.g., `ResolvedSignal`, `BrokerPosition`) -- always derived from Zod schemas or canonical types
- Constants: SCREAMING_SNAKE_CASE (e.g., `DEFAULT_STARTING_EQUITY`)
- DB tables: snake_case per Drizzle convention (e.g., `backtest_runs`, `trade_events`)
- Tests: co-located `.test.ts` next to the source file

### Path Aliases

- Backend: `@/*` -> `src/*` (tsconfig)
- Frontend: `@/*` -> `web/src/*` (vite)
- Cross-boundary: `@src/*` -> `../src/*` (web vite config)

## Backend Architecture

### Signal Pipeline

```
Chat message -> parser (sync, zero I/O) -> orchestrator routing -> executor -> broker -> record trade
```

Routes in order of preference (cheapest first):
1. Hard skip -- regex match, no I/O
2. Deterministic open/close -- market data or DB lookup, no LLM
3. LLM path -- full agent loop, costs tokens

Pipeline code is shared between backtest and live. Behavioral differences belong in `BrokerService` implementations, not `if (isBacktest)` branches. Detail in `.claude/rules/pipeline-execution.md`.

### Module Boundaries

- `src/pipeline/`, `src/orders/` -- import the `BrokerService` interface, not concrete implementations
- `src/intents/orchestrator/parser.ts` -- pure and synchronous (no DB, no API, no async)
- `src/trades/record-trade.ts` -- single write path for all trade lifecycle events (OPEN/CLOSE/ADD/TRIM/LEG_OFF)
- `src/broker/select.ts` -- single construction site for live broker selection
- `src/pipeline/build-deps.ts` -- single construction site for pipeline dependencies

### Error Classification

Retry logic classifies errors -- auth failures get 2 retries, transient errors get exponential backoff, permanent errors fail immediately. See `src/lib/resilient.ts`.

## Frontend Architecture

**Stack:** Vite SPA + React 19 + React Router v6 + Tailwind 4 + shadcn/ui

### Directory Structure

```
web/src/
  views/             # Page components, organized by route (e.g., views/trades/page.tsx)
  components/        # Shared components (e.g., components/trade-filters.tsx)
  components/ui/     # shadcn/ui primitives -- DO NOT MODIFY, managed by shadcn
  hooks/             # Custom hooks (e.g., hooks/use-filter-params.ts)
  stores/            # Zustand stores for cross-component state (channel, chat, trade selection)
  lib/               # Utilities (api.ts, format.ts, utils.ts, channel-scope.ts, author-colors.ts)
```

Pages are orchestrators, not implementations. A page imports components, composes them, and passes data. See `.claude/rules/web-components.md` for file-size limits and decomposition rules.

Before building UI, consult the cookbook at `web/docs/cookbook/` -- intent-driven decision guides for every common pattern (tables, forms, filters, detail views, etc.).

### State Management

- **Server state:** TanStack Query (`useQuery`, `useMutation`). All API calls through `api<T>()` from `web/src/lib/api.ts`.
- **Filter/sort state:** URL params via `createFilterParams` from `web/src/hooks/use-filter-params.ts`. Filters that do not survive page refresh are a bug.
- **Cross-component UI state:** Zustand stores in `web/src/stores/` (channel scope, chat state, trade selection). No prop drilling beyond 2 levels.
- **Channel scoping:** `?channel=` param, read with `useChannelId()`.

### Required Patterns

These are mandatory -- do not rebuild them per page:

| Need | Use this | Not this |
|------|----------|----------|
| Tables | `DataTable` from `web/src/components/data-table.tsx` | Inline `<Table>` with `.map()` |
| URL-synced filters | `createFilterParams` from `web/src/hooks/use-filter-params.ts` | Hand-rolling `useSearchParams` or `useState` |
| Loading/error boundaries | `QueryBoundary` from `web/src/components/query-boundary.tsx` | `if (!data) return <Spinner />` |
| Empty states | `EmptyState` with `variant` prop | `return null` or bare text |
| UI primitives | shadcn components from `web/src/components/ui/` | Raw HTML `<button>`, `<select>`, `<table>`, `<input>` |
| Formatting | `web/src/lib/format.ts` (`formatCurrency`, `pnlColor`, `formatDate`) | Inline `Intl.NumberFormat` or ternaries |

Everything is client-side -- no server components, no `'use client'`.

## Database

### Postgres + Drizzle ORM

- `src/db/schema.ts` is the single source of truth for all app table definitions
- JSON columns use `jsonb().$type<T>()`; prices remain text and timestamps remain ISO 8601 strings
- `POSTGRES_DATABASE_URL` is the app database URL; `TICK_CACHE_DATABASE_URL` is the Databento cache database URL
- Tests use `TEST_POSTGRES_DATABASE_URL` with isolated per-file schemas

### Schema Changes

1. Edit `src/db/schema.ts`
2. `npm run db:generate` -- generates migration + snapshot
3. `npm run db:migrate` -- applies via the Postgres Drizzle migrator

For data-only or table-rebuild migrations: `npm run db:generate -- --custom --name=<name>`. Don't hand-write `.sql` files in `drizzle/` -- they corrupt the snapshot chain. Detail in `.claude/rules/database-trades.md`.

### JSON Columns

JSON columns use `typedJson<T>()` backed by Postgres JSONB in `src/db/schema.ts`. The TS type is baked into the column definition and propagates through `select()` -- no manual casts needed. If you find yourself casting the same JSON column repeatedly, extract a helper.

### Channel Scoping

All data scoped by `channelId`:
- Live/paper: `<broker>:<mode>:<accountId>` (e.g., `ibkr:live:U14368257`)
- Backtest: `bt:<runId>` (e.g., `bt:myopic-tuna`)

Helpers in `src/lib/channel.ts`. Composable query filters in `src/trades/filters.ts`.

### Transactions

`runTx()` from `src/db/client.ts` for multi-statement writes. Transactions are async: `await runTx(async (tx) => { ... })`. Use normal Drizzle awaits and `returning()` when a mutation needs the written row.

## API Contract

The API response shape is the source of truth for frontend types. Mismatches are bugs to fix at the API, not paper over with defensive fallbacks.

- Local API on `:4000` via `src/local-api/server.ts`
- Web-facing routes under `/web/`, proxied by Vite dev server
- Mutations in `web-mutations.ts`, reads in query route files
- Same concept uses the same field name everywhere -- one adapter handles any conversion

## Logging

- One log line per event -- only the authoritative layer (the one owning the state change) logs at info. Others use debug.
- `log.warn` is for conditions a human should investigate. Expected behavior goes to info or debug.

## Testing & Verification

### Quality Gates

```bash
npx tsc --noEmit                  # Backend typecheck
npm test                          # Vitest unit tests
npm --prefix web run check        # Frontend typecheck + build
```

### Tools

- Vitest for unit tests -- co-located `.test.ts` files in `src/`
- Playwright for verifying pages render and flows work -- also your tool for checking your own work during development
- Scratchpad (`scratchpad/`) for throwaway scripts with real data. Run via `npx tsx scratchpad/debug-xxx.ts`. Delete when verified.
- Eval system (`scripts/eval-orchestrator.ts`) for orchestrator regression testing. Detail in `.claude/rules/intent-evals.md`.

## Performance

### Frontend

- Lazy-load pages (`React.lazy` + `Suspense`) -- already set up in `web/src/router.tsx`
- Virtualized lists for large datasets via `DataTable` (uses `react-virtuoso`)
- Loading states via `QueryBoundary`, not blank screens
- `React.memo` for list items rendered in loops

### Backend

- Prefer deterministic pipeline paths over LLM calls (faster and free)
- Databento charges per byte -- don't delete valid rows from the Postgres tick-cache database

## Code Review Checklist

### Correctness

- [ ] Types derived from Zod schemas or canonical types -- no hand-written interfaces duplicating a schema
- [ ] `as any` has `// SAFETY:` comment
- [ ] Pipeline code has no `if (isBacktest)` branching
- [ ] Trade lifecycle writes go through `recordTrade()` only
- [ ] API response shape matches frontend type
- [ ] Log levels correct (info for state changes, debug for others, warn only if actionable)
- [ ] Quality gates pass

### Structure & Decomposition

- [ ] Page files do not exceed ~80 lines -- they are orchestrators
- [ ] Component files do not exceed ~300 lines -- split into sibling files if larger
- [ ] Custom hooks live in `hooks/`, not inline in page/component files
- [ ] One exported component per file (small private helpers under 30 lines are fine)

### Pattern Reuse

- [ ] Tables use `DataTable`, not inline `<Table>` with `.map()`
- [ ] Filters use `createFilterParams`, not hand-rolled `useSearchParams`
- [ ] Empty states use `EmptyState` with `variant` prop, not bare text or `return null`
- [ ] Loading/error states use `QueryBoundary`, not scattered `if` checks
- [ ] No raw HTML `<button>`, `<select>`, `<table>`, `<input>`, `<textarea>` -- use shadcn
- [ ] No inline `Intl.NumberFormat` or date formatting -- use `web/src/lib/format.ts`
