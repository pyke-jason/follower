import { bigint, doublePrecision, index, pgTable, primaryKey, serial, text } from 'drizzle-orm/pg-core';

// ─── Quote Ticks ────────────────────────────────────────

export const pgQuoteTicks = pgTable('quote_ticks', {
  symbol: text('symbol').notNull(),
  dbnSchema: text('dbn_schema').notNull(),
  timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
  bid: doublePrecision('bid').notNull(),
  ask: doublePrecision('ask').notNull(),
  open: doublePrecision('open'),
  close: doublePrecision('close'),
  volume: bigint('volume', { mode: 'number' }),
}, (table) => [
  primaryKey({ columns: [table.symbol, table.dbnSchema, table.timestamp] }),
  index('idx_pg_qt_symbol_schema').on(table.symbol, table.dbnSchema),
]);

// ─── Tick Cache Ranges ──────────────────────────────────

export const pgTickCacheRanges = pgTable('tick_cache_ranges', {
  id: serial('id').primaryKey(),
  dataset: text('dataset').notNull(),
  dbnSchema: text('dbn_schema').notNull(),
  symbol: text('symbol').notNull(),
  startMs: bigint('start_ms', { mode: 'number' }).notNull(),
  endMs: bigint('end_ms', { mode: 'number' }).notNull(),
}, (table) => [
  index('idx_pg_tcr_dataset_schema_symbol').on(table.dataset, table.dbnSchema, table.symbol),
]);

// ─── Chain Definitions ──────────────────────────────────

export const pgChainDefinitions = pgTable('chain_definitions', {
  dataset: text('dataset').notNull(),
  parentSymbol: text('parent_symbol').notNull(),
  day: text('day').notNull(),
  rawSymbol: text('raw_symbol').notNull(),
  expiry: text('expiry').notNull(),
  strike: doublePrecision('strike').notNull(),
  callPut: text('call_put').notNull(),
}, (table) => [
  primaryKey({ columns: [table.dataset, table.parentSymbol, table.day, table.rawSymbol] }),
  index('idx_pg_cd_dataset_parent_day').on(table.dataset, table.parentSymbol, table.day),
]);

// ─── Chain Cache Meta ───────────────────────────────────

export const pgChainCacheMeta = pgTable('chain_cache_meta', {
  dataset: text('dataset').notNull(),
  parentSymbol: text('parent_symbol').notNull(),
  day: text('day').notNull(),
  fetchedAt: text('fetched_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.dataset, table.parentSymbol, table.day] }),
]);

// ─── Inferred Types ─────────────────────────────────────

export type PgQuoteTickRow = typeof pgQuoteTicks.$inferSelect;
export type NewPgQuoteTickRow = typeof pgQuoteTicks.$inferInsert;
export type PgTickCacheRange = typeof pgTickCacheRanges.$inferSelect;
export type NewPgTickCacheRange = typeof pgTickCacheRanges.$inferInsert;
export type PgChainDefinitionRow = typeof pgChainDefinitions.$inferSelect;
export type NewPgChainDefinitionRow = typeof pgChainDefinitions.$inferInsert;
export type PgChainCacheMetaRow = typeof pgChainCacheMeta.$inferSelect;
export type NewPgChainCacheMetaRow = typeof pgChainCacheMeta.$inferInsert;
