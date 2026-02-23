import { sqliteTable, text, integer, real, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { createSelectSchema, createInsertSchema } from 'drizzle-orm/zod';

// ─── Quote Ticks ────────────────────────────────────────

export const quoteTicks = sqliteTable('quote_ticks', {
  symbol:    text('symbol').notNull(),
  dbnSchema: text('dbn_schema').notNull(), // 'ohlcv-1m' | 'cbbo-1s' | 'ohlcv-1d'
  timestamp: integer('timestamp').notNull(), // epoch ms
  bid:       real('bid').notNull(),
  ask:       real('ask').notNull(),
  open:      real('open'),
  close:     real('close'),
  volume:    integer('volume'),
}, (table) => [
  primaryKey({ columns: [table.symbol, table.dbnSchema, table.timestamp] }),
  index('idx_qt_symbol_schema').on(table.symbol, table.dbnSchema),
]);

// ─── Tick Cache Ranges ──────────────────────────────────

export const tickCacheRanges = sqliteTable('tick_cache_ranges', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  dataset:   text('dataset').notNull(),
  dbnSchema: text('dbn_schema').notNull(),
  symbol:    text('symbol').notNull(),
  startMs:   integer('start_ms').notNull(),
  endMs:     integer('end_ms').notNull(),
}, (table) => [
  index('idx_tcr_dataset_schema_symbol').on(table.dataset, table.dbnSchema, table.symbol),
]);

// ─── Chain Definitions ──────────────────────────────────

export const chainDefinitions = sqliteTable('chain_definitions', {
  dataset:      text('dataset').notNull(),
  parentSymbol: text('parent_symbol').notNull(),
  day:          text('day').notNull(),
  rawSymbol:    text('raw_symbol').notNull(),
  expiry:       text('expiry').notNull(),
  strike:       real('strike').notNull(),
  callPut:      text('call_put').notNull(),
}, (table) => [
  primaryKey({ columns: [table.dataset, table.parentSymbol, table.day, table.rawSymbol] }),
  index('idx_cd_dataset_parent_day').on(table.dataset, table.parentSymbol, table.day),
]);

// ─── Chain Cache Meta ───────────────────────────────────

export const chainCacheMeta = sqliteTable('chain_cache_meta', {
  dataset:      text('dataset').notNull(),
  parentSymbol: text('parent_symbol').notNull(),
  day:          text('day').notNull(),
  fetchedAt:    text('fetched_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.dataset, table.parentSymbol, table.day] }),
]);

// ─── Zod Schemas ────────────────────────────────────────

export const selectQuoteTickSchema = createSelectSchema(quoteTicks);
export const insertQuoteTickSchema = createInsertSchema(quoteTicks);

export const selectTickCacheRangeSchema = createSelectSchema(tickCacheRanges);
export const insertTickCacheRangeSchema = createInsertSchema(tickCacheRanges);

export const selectChainDefinitionSchema = createSelectSchema(chainDefinitions);
export const insertChainDefinitionSchema = createInsertSchema(chainDefinitions);

export const selectChainCacheMetaSchema = createSelectSchema(chainCacheMeta);
export const insertChainCacheMetaSchema = createInsertSchema(chainCacheMeta);

// ─── Inferred Types ─────────────────────────────────────

export type QuoteTickRow = typeof quoteTicks.$inferSelect;
export type NewQuoteTickRow = typeof quoteTicks.$inferInsert;
export type TickCacheRange = typeof tickCacheRanges.$inferSelect;
export type NewTickCacheRange = typeof tickCacheRanges.$inferInsert;
export type ChainDefinitionRow = typeof chainDefinitions.$inferSelect;
export type NewChainDefinitionRow = typeof chainDefinitions.$inferInsert;
export type ChainCacheMetaRow = typeof chainCacheMeta.$inferSelect;
export type NewChainCacheMetaRow = typeof chainCacheMeta.$inferInsert;
