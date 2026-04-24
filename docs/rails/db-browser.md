# Database Browser — Implementation Rails

A generic page for browsing, filtering, and editing any database table, with a React Flow schema relationship graph.

## Design Principle

Three clean primitives compose together:

1. **Schema Introspection API** — Drizzle table metadata for columns, primary keys, and foreign keys
2. **Generic Table Query API** — read any table with filters, sort, pagination, and cell mutation
3. **Schema Relationship Graph** — React Flow diagram from FK metadata

Use Drizzle table metadata from `src/db/schema.ts`. This keeps the browser aligned with the app schema and Postgres JSONB/boolean column types.

## Shared Contract

A single backend file defines the types and Zod schemas for the API contract: `src/local-api/db-browser-types.ts`. Frontend components import those types with `@src/` type-only imports.

## API Endpoints

All endpoints live in `src/local-api/routes/db-browser.ts`, mounted in `server.ts` under `/web`.

`GET /web/db/tables` returns all known Drizzle tables with column metadata, row counts, and foreign keys.

`GET /web/db/tables/:name` returns paginated row data for one validated table. Query params: `?limit=100&offset=0&sort=id&dir=asc&filters=<JSON>`.

`PATCH /web/db/tables/:name/:rowId` validates the table, primary key, and column before issuing a parameterized Drizzle update.

## Frontend Components

```
web/src/views/db-browser/
  page.tsx
  table-viewer.tsx
  cell-editor.tsx
  table-filters.tsx
  schema-graph.tsx

web/src/hooks/
  use-db-browser-params.ts
```

Dynamic column generation formats JSONB, boolean, numeric, text, and null values from `ColumnMeta[]`. Filter state stays in one JSON-encoded URL param because the column set varies by table.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Offset pagination, not cursor | DB browser is spreadsheet-like ad-hoc exploration. |
| Validated Drizzle table objects | Generic access without interpolating untrusted table names. |
| Single `filters` JSON param | Column count varies by table. |
| `Record<string, unknown>` row type | Shape varies by table. |
| PK detection from Drizzle metadata | Handles non-`id` PKs like `tracked_traders.name`. |

## Critical Reference Files

| File | Why |
|------|-----|
| `src/db/schema.ts` | Source of truth for table metadata |
| `src/db/client.ts` | Postgres Drizzle client |
| `src/local-api/server.ts` | Mount point for the route |
| `web/src/components/data-table.tsx` | DataTable primitive to compose with |
| `web/src/views/architecture/page.tsx` | React Flow reference implementation |
| `web/src/hooks/use-filter-params.ts` | `createFilterParams` factory for URL state |
| `docs/rails/frontend-data.md` | Data fetching patterns |
