import type { TradeLeg, TradeRiskBasis, TradeRiskConfidence, TradeRiskSnapshot } from '../db/schema.js';
import type { Direction, Strategy } from '../lib/enums.js';
import { roundCents } from '../lib/numbers.js';
import { contractMultiplier, getSpreadWidth, tradeQty } from '../lib/trade.js';

const DEBIT_SPREADS = new Set<Strategy>(['CDS', 'PDS']);
const CREDIT_SPREADS = new Set<Strategy>(['PCS', 'CCS']);

export type TradeRiskInput = {
  strategy: Strategy;
  direction: Direction;
  entryPrice: string | number | null | undefined;
  quantity: number | null | undefined;
  legs: readonly TradeLeg[];
};

function parseAbsPrice(value: TradeRiskInput['entryPrice']): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.abs(parsed);
}

function snapshot(params: {
  currentRisk: number | null;
  basis: TradeRiskBasis;
  confidence: TradeRiskConfidence;
  multiplier: number;
  notes: string[];
}): TradeRiskSnapshot {
  return {
    currentRisk: params.currentRisk,
    peakRisk: params.currentRisk,
    basis: params.basis,
    confidence: params.confidence,
    multiplier: params.multiplier,
    notes: params.notes,
  };
}

function positiveMax(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number =>
    value != null && Number.isFinite(value) && value > 0,
  );
  if (finite.length === 0) return null;
  return roundCents(Math.max(...finite));
}

export function computeTradeRiskSnapshot(input: TradeRiskInput): TradeRiskSnapshot {
  const multiplier = contractMultiplier(input.strategy);
  const qty = tradeQty(input.quantity);
  const entry = parseAbsPrice(input.entryPrice);

  if (qty <= 0) {
    return snapshot({
      currentRisk: 0,
      basis: 'unknown',
      confidence: 'unknown',
      multiplier,
      notes: ['Position quantity is zero; current risk is zero.'],
    });
  }

  if (input.strategy === 'STOCK') {
    return snapshot({
      currentRisk: null,
      basis: 'stock_notional',
      confidence: 'unknown',
      multiplier,
      notes: ['Stock trades need a captured stop to produce true finite R.'],
    });
  }

  if (entry == null) {
    return snapshot({
      currentRisk: null,
      basis: 'unknown',
      confidence: 'unknown',
      multiplier,
      notes: ['Missing positive entry price; finite risk cannot be derived.'],
    });
  }

  if (input.strategy === 'CALL' || input.strategy === 'PUT') {
    if (input.direction === 'SHORT') {
      return snapshot({
        currentRisk: null,
        basis: 'unbounded',
        confidence: 'unknown',
        multiplier,
        notes: ['Short naked options have unbounded risk and are excluded from R.'],
      });
    }

    return snapshot({
      currentRisk: roundCents(entry * qty * multiplier),
      basis: 'premium_paid',
      confidence: 'exact',
      multiplier,
      notes: ['Long option risk is the premium paid.'],
    });
  }

  if (DEBIT_SPREADS.has(input.strategy)) {
    const width = getSpreadWidth([...input.legs]);
    if (width <= 0) {
      return snapshot({
        currentRisk: null,
        basis: 'defined_spread',
        confidence: 'unknown',
        multiplier,
        notes: ['Debit spread width could not be derived from legs.'],
      });
    }

    return snapshot({
      currentRisk: roundCents(entry * qty * multiplier),
      basis: 'defined_spread',
      confidence: 'exact',
      multiplier,
      notes: ['Debit spread risk is the debit paid.'],
    });
  }

  if (CREDIT_SPREADS.has(input.strategy)) {
    const width = getSpreadWidth([...input.legs]);
    if (width <= 0) {
      return snapshot({
        currentRisk: null,
        basis: 'defined_spread',
        confidence: 'unknown',
        multiplier,
        notes: ['Credit spread width could not be derived from legs.'],
      });
    }

    const perContractRisk = width - entry;
    if (perContractRisk <= 0) {
      return snapshot({
        currentRisk: null,
        basis: 'defined_spread',
        confidence: 'unknown',
        multiplier,
        notes: ['Credit received is greater than or equal to spread width; finite risk is not defensible.'],
      });
    }

    return snapshot({
      currentRisk: roundCents(perContractRisk * qty * multiplier),
      basis: 'defined_spread',
      confidence: 'exact',
      multiplier,
      notes: ['Credit spread risk is spread width minus credit received.'],
    });
  }

  return snapshot({
    currentRisk: null,
    basis: 'unknown',
    confidence: 'unknown',
    multiplier,
    notes: [`Unsupported strategy ${input.strategy}; finite risk cannot be derived.`],
  });
}

export function updateTradeRiskSnapshot(
  input: TradeRiskInput,
  previous?: TradeRiskSnapshot,
): TradeRiskSnapshot {
  const next = computeTradeRiskSnapshot(input);
  const peakRisk = positiveMax([
    previous?.peakRisk,
    previous?.currentRisk,
    next.currentRisk,
  ]);

  if (peakRisk != null && next.currentRisk != null && peakRisk > next.currentRisk) {
    return {
      ...next,
      peakRisk,
      notes: [...next.notes, 'Peak risk preserved from earlier lifecycle state.'],
    };
  }

  return {
    ...next,
    peakRisk,
  };
}
