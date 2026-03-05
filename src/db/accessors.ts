/**
 * Typed accessors for Drizzle JSON columns.
 *
 * Each function centralizes the single `as` cast so call sites never need one.
 * Parameter types are loose (accept `unknown`) to match Drizzle inferred row shapes
 * without requiring callers to pre-cast.
 */
import type { TradeLeg, TradeMetadata, DetectedStrategy, BacktestRunConfig, BacktestRunSummary } from './schema.js';
import type { LegFill } from '../broker/types.js';
import type { ExtendedMetrics, LiveMetrics, TraderStats, StrategyStats, EquityPoint } from '../backtest/types.js';

// ─── Trades ──────────────────────────────────────────

export function getLegs(row: { legs: unknown }): TradeLeg[] {
  return (row.legs ?? []) as TradeLeg[];
}

export function getTradeMetadata(row: { metadata: unknown }): TradeMetadata {
  return (row.metadata ?? {}) as TradeMetadata;
}

export function getBrokerLegFills(row: { brokerLegFills: unknown }): LegFill[] | null {
  return (row.brokerLegFills ?? null) as LegFill[] | null;
}

// ─── Messages ────────────────────────────────────────

export function getDetectedStrategies(row: { detectedStrategies: unknown }): DetectedStrategy[] {
  return (row.detectedStrategies ?? []) as DetectedStrategy[];
}

// ─── Backtest Runs ───────────────────────────────────

export function getConfig(row: { config: unknown }): BacktestRunConfig {
  return row.config as BacktestRunConfig;
}

export function getSummary(row: { summary: unknown }): BacktestRunSummary | null {
  return (row.summary ?? null) as BacktestRunSummary | null;
}

export function getLiveMetrics(row: { liveMetrics: unknown }): LiveMetrics | null {
  return (row.liveMetrics ?? null) as LiveMetrics | null;
}

export function getExtendedMetrics(row: { extendedMetrics: unknown }): ExtendedMetrics | null {
  return (row.extendedMetrics ?? null) as ExtendedMetrics | null;
}

export function getEquityCurve(row: { equityCurve: unknown }): EquityPoint[] | null {
  return (row.equityCurve ?? null) as EquityPoint[] | null;
}

export function getByTrader(row: { byTrader: unknown }): Record<string, TraderStats> | null {
  return (row.byTrader ?? null) as Record<string, TraderStats> | null;
}

export function getByStrategy(row: { byStrategy: unknown }): Record<string, StrategyStats> | null {
  return (row.byStrategy ?? null) as Record<string, StrategyStats> | null;
}
