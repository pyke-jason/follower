import { Hono } from 'hono';
import { sqliteClient } from '@/db/client.js';
import {
  FiltersSchema, CellUpdateSchema,
  type ColumnMeta, type ForeignKeyMeta, type TableMeta,
} from '../db-browser-types.js';

const app = new Hono();

// ─── Helpers ─────────────────────────────────────────

const EXCLUDED_TABLES = new Set([
  'sqlite_sequence', '__drizzle_migrations', 'drizzle_migrations',
  'sqlite_schema', 'sqlite_temp_schema',
]);

type PragmaTableInfo = { cid: number; name: string; type: string; notnull: 0 | 1; dflt_value: string | null; pk: number };
type PragmaFKList = { id: number; seq: number; table: string; from: string; to: string };

function getTableNames(): string[] {
  const rows = sqliteClient.pragma('table_list') as { name: string; type: string }[];
  return rows
    .filter(r => r.type === 'table' && !r.name.startsWith('_') && !r.name.startsWith('sqlite_') && !EXCLUDED_TABLES.has(r.name))
    .map(r => r.name)
    .sort();
}

function getColumns(table: string): ColumnMeta[] {
  const rows = sqliteClient.pragma(`table_info("${table}")`) as PragmaTableInfo[];
  return rows.map(r => ({
    name: r.name,
    type: r.type || 'TEXT',
    notnull: r.notnull === 1,
    primaryKey: r.pk > 0,
    defaultValue: r.dflt_value,
  }));
}

function getForeignKeys(table: string): ForeignKeyMeta[] {
  const rows = sqliteClient.pragma(`foreign_key_list("${table}")`) as PragmaFKList[];
  return rows.map(r => ({
    column: r.from,
    referencedTable: r.table,
    referencedColumn: r.to,
  }));
}

function getRowCount(table: string): number {
  const row = sqliteClient.prepare(`SELECT count(*) as cnt FROM "${table}"`).get() as { cnt: number };
  return row.cnt;
}

function getPrimaryKeyColumn(columns: ColumnMeta[]): string | null {
  return columns.find(c => c.primaryKey)?.name ?? null;
}

function validateTableName(name: string): boolean {
  return getTableNames().includes(name);
}

function validateColumnName(column: string, columns: ColumnMeta[]): boolean {
  return columns.some(c => c.name === column);
}

// ─── GET /db/tables ──────────────────────────────────

app.get('/db/tables', (c) => {
  const names = getTableNames();
  const tables: TableMeta[] = names.map(name => ({
    name,
    rowCount: getRowCount(name),
    columns: getColumns(name),
    foreignKeys: getForeignKeys(name),
  }));
  return c.json(tables);
});

// ─── GET /db/tables/:name ────────────────────────────

app.get('/db/tables/:name', (c) => {
  const tableName = c.req.param('name');
  if (!validateTableName(tableName)) {
    return c.json({ error: `Unknown table: ${tableName}` }, 404);
  }

  const columns = getColumns(tableName);
  const foreignKeys = getForeignKeys(tableName);

  // Pagination
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '100'), 1), 1000);
  const offset = Math.max(parseInt(c.req.query('offset') ?? '0'), 0);

  // Sort
  const sortCol = c.req.query('sort') ?? getPrimaryKeyColumn(columns) ?? columns[0]?.name ?? 'rowid';
  const sortDir = c.req.query('dir') === 'asc' ? 'ASC' : 'DESC';

  if (sortCol !== 'rowid' && !validateColumnName(sortCol, columns)) {
    return c.json({ error: `Invalid sort column: ${sortCol}` }, 400);
  }

  // Filters
  let whereClauses: string[] = [];
  let whereParams: unknown[] = [];

  const filtersParam = c.req.query('filters');
  if (filtersParam) {
    try {
      const filters = FiltersSchema.parse(JSON.parse(filtersParam));
      for (const f of filters) {
        if (!validateColumnName(f.column, columns)) continue;

        const col = `"${f.column}"`;
        switch (f.op) {
          case 'eq':          whereClauses.push(`${col} = ?`); whereParams.push(f.value); break;
          case 'neq':         whereClauses.push(`${col} != ?`); whereParams.push(f.value); break;
          case 'like':        whereClauses.push(`${col} LIKE ?`); whereParams.push(`%${f.value}%`); break;
          case 'gt':          whereClauses.push(`${col} > ?`); whereParams.push(f.value); break;
          case 'lt':          whereClauses.push(`${col} < ?`); whereParams.push(f.value); break;
          case 'gte':         whereClauses.push(`${col} >= ?`); whereParams.push(f.value); break;
          case 'lte':         whereClauses.push(`${col} <= ?`); whereParams.push(f.value); break;
          case 'is_null':     whereClauses.push(`${col} IS NULL`); break;
          case 'is_not_null': whereClauses.push(`${col} IS NOT NULL`); break;
        }
      }
    } catch {
      return c.json({ error: 'Invalid filters parameter' }, 400);
    }
  }

  const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const countRow = sqliteClient.prepare(
    `SELECT count(*) as cnt FROM "${tableName}" ${whereSQL}`
  ).get(...whereParams) as { cnt: number };

  const rows = sqliteClient.prepare(
    `SELECT * FROM "${tableName}" ${whereSQL} ORDER BY "${sortCol}" ${sortDir} LIMIT ? OFFSET ?`
  ).all(...whereParams, limit, offset) as Record<string, unknown>[];

  return c.json({ rows, total: countRow.cnt, columns, foreignKeys });
});

// ─── PATCH /db/tables/:name/:rowId ───────────────────

app.patch('/db/tables/:name/:rowId', async (c) => {
  const tableName = c.req.param('name');
  const rowId = c.req.param('rowId');

  if (!validateTableName(tableName)) {
    return c.json({ error: `Unknown table: ${tableName}` }, 404);
  }

  const columns = getColumns(tableName);
  const pkCol = getPrimaryKeyColumn(columns);
  if (!pkCol) {
    return c.json({ error: `No primary key found for table: ${tableName}` }, 400);
  }

  let body: { column: string; value: string | number | null };
  try {
    body = CellUpdateSchema.parse(await c.req.json());
  } catch {
    return c.json({ error: 'Invalid body: expected { column, value }' }, 400);
  }

  if (!validateColumnName(body.column, columns)) {
    return c.json({ error: `Invalid column: ${body.column}` }, 400);
  }

  sqliteClient.prepare(
    `UPDATE "${tableName}" SET "${body.column}" = ? WHERE "${pkCol}" = ?`
  ).run(body.value, rowId);

  return c.json({ ok: true });
});

export default app;
