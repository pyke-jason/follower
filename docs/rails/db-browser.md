# Database Browser — Implementation Rails

A generic page for browsing, filtering, and editing any database table, with a React Flow schema relationship graph.

## Design Principle

Three clean primitives that compose together:

1. **Schema Introspection API** — SQLite PRAGMA-based metadata (columns, types, FKs)
2. **Generic Table Query API** — read any table with filters/sort/pagination + cell mutation
3. **Schema Relationship Graph** — React Flow diagram from FK metadata

Use SQLite PRAGMA, not Drizzle introspection. PRAGMA returns column types, nullability, PKs, and FK targets that Drizzle's TS-level helpers lose. The `sqliteClient` (raw better-sqlite3) is already exported from `src/db/client.ts`.

## Shared Contract

A single file defines the types AND Zod schemas for the API contract. Lives in backend, imported by frontend as type-only.

**File: `src/local-api/db-browser-types.ts`**

```ts
import { z } from 'zod';

// ─── Schema Metadata ─────────────────────────────────

export const ColumnMetaSchema = z.object({
  name: z.string(),
  type: z.string(),           // "TEXT", "INTEGER", "REAL"
  notnull: z.boolean(),
  primaryKey: z.boolean(),
  defaultValue: z.string().nullable(),
});

export const ForeignKeyMetaSchema = z.object({
  column: z.string(),
  referencedTable: z.string(),
  referencedColumn: z.string(),
});

export const TableMetaSchema = z.object({
  name: z.string(),
  rowCount: z.number(),
  columns: z.array(ColumnMetaSchema),
  foreignKeys: z.array(ForeignKeyMetaSchema),
});

// ─── Filters ─────────────────────────────────────────

export const FilterOpSchema = z.enum([
  'eq', 'neq', 'like', 'gt', 'lt', 'gte', 'lte', 'is_null', 'is_not_null',
]);

export const FilterSchema = z.object({
  column: z.string(),
  op: FilterOpSchema,
  value: z.string().optional(),
});

export const FiltersSchema = z.array(FilterSchema);

// ─── API Responses ───────────────────────────────────

export const TableDataResponseSchema = z.object({
  rows: z.array(z.record(z.unknown())),
  total: z.number(),
  columns: z.array(ColumnMetaSchema),
  foreignKeys: z.array(ForeignKeyMetaSchema),
});

export const CellUpdateSchema = z.object({
  column: z.string(),
  value: z.union([z.string(), z.number(), z.null()]),
});

// ─── Inferred Types ──────────────────────────────────

export type ColumnMeta = z.infer<typeof ColumnMetaSchema>;
export type ForeignKeyMeta = z.infer<typeof ForeignKeyMetaSchema>;
export type TableMeta = z.infer<typeof TableMetaSchema>;
export type Filter = z.infer<typeof FilterSchema>;
export type FilterOp = z.infer<typeof FilterOpSchema>;
export type TableDataResponse = z.infer<typeof TableDataResponseSchema>;
export type CellUpdate = z.infer<typeof CellUpdateSchema>;
```

**Usage pattern:**

- Backend route (`db-browser.ts`): imports schemas for runtime validation (`FiltersSchema.parse(JSON.parse(filtersParam))`, `CellUpdateSchema.parse(body)`)
- Frontend components: `import type { TableMeta, ColumnMeta, Filter } from '@src/local-api/db-browser-types'`
- Single source of truth — no duplicated type definitions

This follows the existing codebase pattern where `@src/` type imports are used freely (44 files already do this), but adds Zod validation for the API boundary where user-controlled input arrives (filter params, cell edit payloads).

## API Endpoints

All in a new route file: `src/local-api/routes/db-browser.ts`, mounted in `server.ts` under `/web`.

### `GET /web/db/tables`

Returns `TableMeta[]` — all tables with column metadata and foreign keys.

Implementation: `PRAGMA table_list` → filter out `sqlite_sequence`, `__drizzle_migrations` → for each table: `PRAGMA table_info(name)`, `PRAGMA foreign_key_list(name)`, `SELECT count(*) FROM name`.

### `GET /web/db/tables/:name`

Paginated row data for a specific table.

Query params: `?limit=100&offset=0&sort=id&dir=asc&filters=<JSON>` where `filters` is a JSON-encoded `Filter[]` (validated via `FiltersSchema.parse()`).

Returns `TableDataResponse`.

**Safety:** Validate table name against known table list (not interpolated). Validate column names against PRAGMA output. Parse filters with `FiltersSchema` (rejects malformed input). Row values are always parameterized.

**Why raw SQL, not Drizzle:** The whole point is querying ANY table generically. Drizzle requires importing specific table objects. Raw parameterized SQL against a validated table name is the right tool.

### `PATCH /web/db/tables/:name/:rowId`

Inline edit mutation. Body validated via `CellUpdateSchema.parse(body)`.

Detect PK column via PRAGMA (`pk` field). Validate table and column. Parameterized UPDATE. Returns `{ ok: true }`.

## Frontend Components

### File structure

```
web/src/views/db-browser/
  page.tsx              — Orchestrator (<30 lines)
  table-viewer.tsx      — Dynamic column generation + DataTable
  cell-editor.tsx       — Inline editing (Input for short values, Dialog for JSON/long text)
  table-filters.tsx     — Dynamic filter bar from ColumnMeta[]
  schema-graph.tsx      — React Flow table relationship diagram

web/src/hooks/
  use-db-browser-params.ts  — URL-synced filter/sort/table params
```

### Primitive: Dynamic Column Generation (`table-viewer.tsx`)

Takes `ColumnMeta[]` + `Record<string, unknown>[]` → produces `Column<Record<string, unknown>>[]` for `DataTable`.

For each `ColumnMeta`, generates:
- Render function with type-appropriate formatting: truncated text for long strings, formatted numbers for INTEGER/REAL, `null` badge for nulls, expandable view for JSON columns
- `sortable: true` for all columns
- `align: 'right'` for numeric columns
- Double-click to edit trigger → opens `CellEditor`

### Primitive: Dynamic Filters (`table-filters.tsx`)

Built from `ColumnMeta[]`. Column selector via `Popover + Command`. Per-column type:
- TEXT: Input with contains/equals/is_null operators
- INTEGER/REAL: Input with numeric operators (=, !=, >, <, >=, <=)
- Boolean-like (columns named `is_*`, `enabled`, etc.): Select with true/false/any

Filter state as a single JSON-encoded URL param (`filters`), not per-column params. The column set varies by table — a single JSON string avoids combinatorial explosion.

```ts
const useDbBrowserParams = createFilterParams({
  sort: { type: 'sort', defaultColumn: 'id', defaultDir: 'asc' },
  table: { type: 'string', default: '' },
  filters: { type: 'string', default: '' }, // JSON-encoded Filter[]
});
```

### Primitive: Schema Graph (`schema-graph.tsx`)

React Flow visualization. Follow the patterns already in `web/src/views/architecture/page.tsx`.

- **Nodes:** `TableNode` — card showing table name + column list (name, type, PK icon, FK icon)
- **Edges:** One per foreign key. `smoothstep` edge type. Label with FK column name.
- **Layout:** Simple grid (3-4 columns). Tables with many incoming FKs (like `messages`) toward the top. Computed once from FK metadata — no external layout library needed.
- **Interaction:** Click a node → selects that table in the data browser

### Page Assembly (`page.tsx`)

```
ResizablePanelGroup (horizontal)
  Left panel: SchemaGraph
  Right panel:
    Table selector (Select dropdown) — OR click a graph node
    TableFilters bar
    TableViewer (DataTable with dynamic columns + inline editing)
```

Wrap in `QueryBoundary` on the `/db/tables` query. The table data query is a dependent query keyed on the selected table name.

## Implementation Sequence

### Phase 1: API layer
1. Create `src/local-api/routes/db-browser.ts` with all three endpoints
2. Mount in `server.ts`
3. Test: `curl localhost:3791/web/db/tables | jq` and `curl localhost:3791/web/db/tables/messages?limit=5 | jq`

### Phase 2: Static table viewer
1. Create `useDbBrowserParams` hook
2. Create `table-viewer.tsx` — dynamic columns from ColumnMeta
3. Create `page.tsx` — minimal orchestrator (Select dropdown + DataTable, no graph yet)
4. Wire into router + sidebar
5. Verify page loads with real data

### Phase 3: Filtering
1. Create `table-filters.tsx`
2. Wire filter state to the API query
3. Verify filters work with URL persistence

### Phase 4: Inline editing
1. Create `cell-editor.tsx`
2. Add edit trigger in column render functions
3. Wire mutation to PATCH endpoint
4. `toast.success()` on save

### Phase 5: Schema graph
1. Create `schema-graph.tsx` with auto-layout
2. Add `ResizablePanelGroup` to page
3. Wire node-click → table selection
4. Style to match existing aesthetic

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Offset pagination, not cursor | DB browser is spreadsheet-like ad-hoc exploration. "Rows 101-200 of 5,432" is more useful than infinite scroll. |
| Raw SQL, not Drizzle query builder | Generic table access requires dynamic table names. Raw parameterized SQL is the right tool. |
| Single `filters` JSON param | Column count varies by table. Per-column URL params would explode. |
| `Record<string, unknown>` row type | Shape varies by table. Dynamic column generation bridges to DataTable's `Column<T>[]`. |
| PK detection via PRAGMA | Handles composite PKs and non-`id` PKs (like `trackedTraders.name`) without hardcoding. |
| PRAGMA over Drizzle introspection | Gets column types, nullability, PKs, FKs from the database itself. Self-contained, always accurate. |

## Critical Reference Files

| File | Why |
|------|-----|
| `src/db/client.ts` | Exports `sqliteClient` for PRAGMA calls |
| `src/local-api/server.ts` | Mount point for new route |
| `web/src/components/data-table.tsx` | DataTable primitive to compose with |
| `web/src/views/architecture/page.tsx` | React Flow reference implementation |
| `web/src/hooks/use-filter-params.ts` | `createFilterParams` factory for URL state |
| `docs/rails/frontend-data.md` | Data fetching patterns |
