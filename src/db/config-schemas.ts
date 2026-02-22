/**
 * Zod schemas for JSON columns stored in the database.
 *
 * BacktestRunConfigSchema — validates the `config` JSON column in backtestRuns.
 * TrackedTraderSchema     — validates rows from the trackedTraders table.
 *
 * passthrough() on BacktestRunConfigSchema allows DB rows written by older code
 * with additional or experimental fields to parse without throwing.
 */

import { z } from 'zod';

// ── CommissionSchedule ────────────────────────────────────────────────

const CommissionScheduleSchema = z.object({
  stock:  z.object({ perShare: z.number(), minimum: z.number().optional(), maximum: z.number().optional() }).optional(),
  option: z.object({ perContract: z.number() }).optional(),
});

// ── BacktestRunConfig ─────────────────────────────────────────────────

export const BacktestRunConfigSchema = z.object({
  startDate:             z.string(),
  endDate:               z.string(),
  traders:               z.array(z.string()),
  useQuoteTape:          z.boolean(),
  agentProvider:         z.string().optional(),
  agentModel:            z.string().optional(),
  fillModel:             z.enum(['orats', 'midpoint', 'natural']).optional(),
  name:                  z.string().optional(),
  refreshQuoteCache:     z.boolean().optional(),
  startingEquity:        z.number().positive().optional(),
  maxAgentCalls:         z.number().int().positive().optional(),
  maxOnSymbol:           z.number().int().positive().optional(),
  maxTotalPositions:     z.number().int().positive().optional(),
  maxDrawdownPct:        z.number().positive().optional(),
  maxNotionalMultiplier: z.number().positive().optional(),
  disableRiskLimits:     z.boolean().optional(),
  commissionSchedule:    CommissionScheduleSchema.optional(),
}).passthrough();

export type BacktestRunConfig = z.infer<typeof BacktestRunConfigSchema>;

// ── PositionSizingConfig ──────────────────────────────────────────────

const ATRSizingConfigSchema = z.object({
  strategy:       z.literal('atr'),
  riskPercent:    z.number().positive(),
  atrMultiplier:  z.number().positive(),
  atrPeriod:      z.number().int().positive().optional(),
});

const PositionSizingConfigSchema = ATRSizingConfigSchema;

// ── TrackedTrader ─────────────────────────────────────────────────────

export const TrackedTraderSchema = z.object({
  name:                z.string().min(1),
  enabled:             z.boolean().nullable(),
  strategies:          z.array(z.string()),
  notes:               z.string().nullable(),
  positionSizingConfig: PositionSizingConfigSchema.nullable(),
});

export type TrackedTrader = z.infer<typeof TrackedTraderSchema>;
