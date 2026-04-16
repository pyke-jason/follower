import { z } from 'zod';

// ─── Schema Metadata ─────────────────────────────────

export const ColumnMetaSchema = z.object({
  name: z.string(),
  type: z.string(),
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
  rows: z.array(z.record(z.string(), z.unknown())),
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
