import { z } from 'zod';
import { zPrice, zPct01 } from '../lib/zod-financial.js';

// --- Tool input schemas (classification tools) ---

export const GetQuoteInput = z.object({
  symbol: z.string().min(1),
});

export const GetOptionsChainInput = z.object({
  symbol: z.string().min(1),
  expiry: z.string().min(1),
  optionType: z.enum(['CALL', 'PUT']),
});

export const GetOpenPositionsInput = z.object({
  symbol: z.string().optional(),
  trader: z.string().optional(),
});

export const FlagForReviewInput = z.object({
  reason: z.string().min(1),
  uncertainty: z.string().optional(),
});

// --- Signal schema (classification-only agent output) ---

const SignalLegSchema = z.object({
  strike: zPrice,
  expiry: z.string().min(1),
  optionType: z.enum(['CALL', 'PUT']),
  action: z.enum(['BUY', 'SELL']),
});

export const SignalSchema = z.object({
  action: z.enum(['OPEN', 'CLOSE', 'ADD', 'TRIM']),
  symbol: z.string().min(1),
  direction: z.enum(['LONG', 'SHORT']),
  strategy: z.enum(['STOCK', 'CALL', 'PUT', 'CDS', 'PDS']),
  limitPrice: zPrice.optional(),
  exitPercent: zPct01.optional(),     // for TRIM: 0.5 = half
  legs: z.array(SignalLegSchema).optional(),
}).refine(
  s => s.strategy === 'STOCK' || !['OPEN', 'ADD'].includes(s.action) || (s.legs && s.legs.length > 0),
  { message: 'Options OPEN/ADD signals require legs with strike, expiry, optionType, and action' },
);

export type Signal = z.infer<typeof SignalSchema>;

// --- Agent decision schema ---

export const AgentDecisionSchema = z.object({
  decision: z.enum(['EXECUTE', 'SKIP', 'MANUAL_REVIEW']),
  reasoning: z.string(),
  signals: z.array(SignalSchema).optional(),
}).refine(
  d => d.decision !== 'EXECUTE' || (d.signals && d.signals.length > 0),
  { message: 'EXECUTE requires at least one signal' },
);

// --- Label agent result schema ---

export const LabelResultSchema = z.object({
  isTrade: z.boolean(),
  action: z.enum(['OPEN', 'CLOSE', 'ADD', 'TRIM']).nullable().optional(),
  direction: z.enum(['LONG', 'SHORT']).nullable().optional(),
  strategy: z.enum(['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'PCS']).nullable().optional(),
  symbol: z.string().nullable().optional(),
  price: z.string().nullable().optional(),
  strikes: z.array(z.number()).nullable().optional(),
  quantity: z.string().nullable().optional(),
  expiry: z.string().nullable().optional(),
  exitPercent: zPct01.nullable().optional(), // 0.0–1.0 for TRIM actions
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  notes: z.string().nullable().optional(),
});

export type LabelResult = z.infer<typeof LabelResultSchema>;
