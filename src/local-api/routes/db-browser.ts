import { Hono } from 'hono';
import { db, schema } from '@/db/client.js';
import {
  eq, ne, like, gt, lt, gte, lte, isNull, isNotNull, and,
  asc, desc, count, getTableColumns, isTable,
} from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
  FiltersSchema, type FilterOp,
  type ColumnMeta, type ForeignKeyMeta, type TableMeta,
} from '../db-browser-types.js';
import { validateBody, validateQuery } from '../validate.js';
import { CellUpdateBodySchema, DbTableQuerySchema } from '../http-schemas.js';

const app = new Hono();

const tableByName: Map<string, PgTable> = new Map();
for (const value of Object.values(schema)) {
  if (isTable(value)) {
    const table = value as PgTable;
    tableByName.set(getTableConfig(table).name, table);
  }
}

function describeColumns(table: PgTable): ColumnMeta[] {
  return getTableConfig(table).columns.map((col) => ({
    name: col.name,
    type: col.getSQLType(),
    notnull: col.notNull,
    primaryKey: col.primary,
    defaultValue: col.default !== undefined ? String(col.default) : null,
  }));
}

function describeForeignKeys(table: PgTable): ForeignKeyMeta[] {
  const out: ForeignKeyMeta[] = [];
  for (const fk of getTableConfig(table).foreignKeys) {
    const ref = fk.reference();
    const refTableName = getTableConfig(ref.foreignTable as PgTable).name;
    for (let i = 0; i < ref.columns.length; i++) {
      out.push({
        column: ref.columns[i].name,
        referencedTable: refTableName,
        referencedColumn: ref.foreignColumns[i].name,
      });
    }
  }
  return out;
}

function findColumn(table: PgTable, sqlName: string): AnyColumn | undefined {
  return getTableConfig(table).columns.find((c) => c.name === sqlName) as AnyColumn | undefined;
}

function findColumnPropertyName(table: PgTable, sqlName: string): string | undefined {
  for (const [propName, col] of Object.entries(getTableColumns(table))) {
    if ((col as AnyColumn).name === sqlName) return propName;
  }
  return undefined;
}

function primaryKeyColumn(table: PgTable): AnyColumn | undefined {
  return getTableConfig(table).columns.find((c) => c.primary) as AnyColumn | undefined;
}

function buildCondition(col: AnyColumn, op: FilterOp, value: string | undefined): SQL {
  switch (op) {
    case 'eq':          return eq(col, value);
    case 'neq':         return ne(col, value);
    case 'like':        return like(col, `%${value ?? ''}%`);
    case 'gt':          return gt(col, value as never);
    case 'lt':          return lt(col, value as never);
    case 'gte':         return gte(col, value as never);
    case 'lte':         return lte(col, value as never);
    case 'is_null':     return isNull(col);
    case 'is_not_null': return isNotNull(col);
  }
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

// ─── GET /db/tables ──────────────────────────────────

app.get('/db/tables', async (c) => {
  const names = [...tableByName.keys()].sort();
  const tables: TableMeta[] = await Promise.all(names.map(async (name) => {
    const table = tableByName.get(name)!;
    const [{ n }] = await db.select({ n: count() }).from(table);
    return {
      name,
      rowCount: n,
      columns: describeColumns(table),
      foreignKeys: describeForeignKeys(table),
    };
  }));
  return c.json(tables);
});

// ─── GET /db/tables/:name ────────────────────────────

app.get('/db/tables/:name', async (c) => {
  const tableName = c.req.param('name');
  const table = tableByName.get(tableName);
  if (!table) return c.json({ error: `Unknown table: ${tableName}` }, 404);

  const { limit, offset, sort, dir, filters: filtersParam } = validateQuery(DbTableQuerySchema, c);

  const columns = describeColumns(table);
  const sortColName = sort ?? primaryKeyColumn(table)?.name ?? columns[0]?.name;
  const sortCol = sortColName ? findColumn(table, sortColName) : undefined;
  if (!sortCol) return c.json({ error: `Invalid sort column: ${sortColName}` }, 400);

  const conditions: SQL[] = [];
  if (filtersParam) {
    const parsed = FiltersSchema.safeParse(safeJsonParse(filtersParam));
    if (!parsed.success) return c.json({ error: 'Invalid filters parameter' }, 400);
    for (const f of parsed.data) {
      const col = findColumn(table, f.column);
      if (col) conditions.push(buildCondition(col, f.op, f.value));
    }
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const orderBy = dir === 'asc' ? asc(sortCol) : desc(sortCol);

  const [rows, [{ n: total }]] = await Promise.all([
    db.select().from(table).where(where).orderBy(orderBy).limit(limit).offset(offset),
    db.select({ n: count() }).from(table).where(where),
  ]);

  return c.json({ rows, total, columns, foreignKeys: describeForeignKeys(table) });
});

// ─── PATCH /db/tables/:name/:rowId ───────────────────

app.patch('/db/tables/:name/:rowId', async (c) => {
  const tableName = c.req.param('name');
  const rowId = c.req.param('rowId');
  const table = tableByName.get(tableName);
  if (!table) return c.json({ error: `Unknown table: ${tableName}` }, 404);

  const pk = primaryKeyColumn(table);
  if (!pk) return c.json({ error: `No primary key found for table: ${tableName}` }, 400);

  const body = await validateBody(CellUpdateBodySchema, c);
  const propName = findColumnPropertyName(table, body.column);
  if (!propName) return c.json({ error: `Invalid column: ${body.column}` }, 400);

  await db.update(table)
    .set({ [propName]: body.value } as never)
    .where(eq(pk, rowId));

  return c.json({ ok: true });
});

export default app;
