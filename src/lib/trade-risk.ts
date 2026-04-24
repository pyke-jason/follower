import type { Direction, Strategy } from './enums.js';
import type { TradeLeg } from '../db/schema.js';
import { contractMultiplier, getSpreadWidth, tradeQty } from './trade.js';

export type TradeRiskInput = {
  strategy: Strategy | string;
  direction: Direction | string;
  entryPrice: string | number | null;
  quantity: number | null | undefined;
  legs: TradeLeg[];
};

type TradeRiskSummary = {
  maxLoss: number | null;
  bounded: boolean;
  note: string;
};

function parseEntryPrice(entryPrice: string | number | null): number | null {
  const parsed = typeof entryPrice === 'number' ? entryPrice : parseFloat(entryPrice ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function firstOptionStrike(legs: TradeLeg[]): number | null {
  const strike = legs.find((leg) => leg.type !== 'STOCK')?.strike ?? null;
  return strike != null && Number.isFinite(strike) ? strike : null;
}

export function getTradeMaxLossAtEntry(trade: TradeRiskInput): number | null {
  const entry = parseEntryPrice(trade.entryPrice);
  if (entry == null) return null;

  const quantity = tradeQty(trade.quantity);
  const multiplier = contractMultiplier(trade.strategy);
  const premium = entry * quantity * multiplier;
  const spreadWidth = getSpreadWidth(trade.legs);
  const strike = firstOptionStrike(trade.legs);

  switch (trade.strategy) {
    case 'STOCK':
      return trade.direction === 'LONG' ? entry * quantity : null;

    case 'CALL':
      return trade.direction === 'LONG' ? premium : null;

    case 'PUT':
      if (trade.direction === 'LONG') return premium;
      if (strike == null) return null;
      return Math.max(0, (strike - entry) * quantity * multiplier);

    case 'CDS':
    case 'PDS':
    case 'PCS':
    case 'CCS':
      if (spreadWidth <= 0) return null;
      return trade.direction === 'LONG'
        ? premium
        : Math.max(0, (spreadWidth - entry) * quantity * multiplier);

    default:
      return null;
  }
}

export function summarizeTradeRiskAtEntry(trade: TradeRiskInput): TradeRiskSummary {
  const maxLoss = getTradeMaxLossAtEntry(trade);

  switch (trade.strategy) {
    case 'STOCK':
      return trade.direction === 'LONG'
        ? {
            maxLoss,
            bounded: maxLoss != null,
            note: 'Long stock max loss assumes the shares go to zero.',
          }
        : {
            maxLoss: null,
            bounded: false,
            note: 'Short stock risk is unbounded without a recorded stop.',
          };

    case 'CALL':
      return trade.direction === 'LONG'
        ? {
            maxLoss,
            bounded: maxLoss != null,
            note: 'Long call max loss is the premium paid.',
          }
        : {
            maxLoss: null,
            bounded: false,
            note: 'Short call risk is theoretically unbounded.',
          };

    case 'PUT':
      return trade.direction === 'LONG'
        ? {
            maxLoss,
            bounded: maxLoss != null,
            note: 'Long put max loss is the premium paid.',
          }
        : {
            maxLoss,
            bounded: maxLoss != null,
            note: 'Short put max loss assumes the underlying falls to zero.',
          };

    case 'CDS':
    case 'PDS':
      return {
        maxLoss,
        bounded: maxLoss != null,
        note: 'Debit spread max loss is the debit paid.',
      };

    case 'PCS':
    case 'CCS':
      return {
        maxLoss,
        bounded: maxLoss != null,
        note: 'Credit spread max loss is spread width minus credit received.',
      };

    default:
      return {
        maxLoss,
        bounded: maxLoss != null,
        note: 'No bounded max-loss model is defined for this trade shape.',
      };
  }
}
