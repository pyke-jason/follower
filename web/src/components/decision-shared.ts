import type { RunDecision } from '@src/db/schema';

export const REACTION_EMOJI: Record<string, string> = {
  votes: '\u{1F44D}',
  loves: '\u{2764}\u{FE0F}',
  appreciations: '\u{1F64F}',
  cheers: '\u{1F37B}',
  salutes: '\u{1FAE1}',
  laughs: '\u{1F602}',
  questions: '\u{2753}',
};

export function fmtMs(ms: number) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}us`;
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export const EVENT_LABEL: Record<string, string> = {
  PARSED: 'PARSED', SIGNAL_RESOLVED: 'SIGNAL', SIZED: 'SIZED',
  ORDER_PLACED: 'ORDER', ORDER_ADJUSTED: 'CHASE', ORDER_FILLED: 'FILLED',
  ORDER_CANCELLED: 'CANCELLED', QUOTE_FAILED: 'QUOTE FAIL', RETRY_LLM: 'RETRY', SETTLED: 'RESULT',
};

export const DOT: Record<string, string> = {
  PARSED: 'bg-[oklch(0.62_0.05_248)]', SIGNAL_RESOLVED: 'bg-[oklch(0.58_0.07_328)]',
  SIZED: 'bg-[oklch(0.58_0.06_178)]', ORDER_PLACED: 'bg-[oklch(0.55_0.08_148)]',
  ORDER_ADJUSTED: 'bg-[oklch(0.60_0.08_75)]', ORDER_FILLED: 'bg-[oklch(0.52_0.10_148)]',
  ORDER_CANCELLED: 'bg-[oklch(0.55_0.15_25)]', QUOTE_FAILED: 'bg-[oklch(0.52_0.12_30)]', RETRY_LLM: 'bg-[oklch(0.60_0.08_75)]',
  SETTLED: 'bg-[oklch(0.50_0.02_65)]',
  OPEN: 'bg-[oklch(0.48_0.14_148)]', CLOSE: 'bg-[oklch(0.48_0.12_248)]',
  ADD: 'bg-[oklch(0.48_0.10_178)]', TRIM: 'bg-[oklch(0.55_0.12_75)]',
  LEG_OFF: 'bg-[oklch(0.50_0.10_328)]',
};

export function getInlineSummary(d: RunDecision): string | null {
  const snap = d.snapshot as Record<string, unknown> | null;
  if (!snap) return null;
  const event = d.event ?? 'SETTLED';

  switch (event) {
    case 'PARSED': {
      const parts = [snap.action, snap.symbol, snap.strategy].filter(Boolean).map(String);
      return parts.length > 0 ? parts.join(' ') : null;
    }
    case 'SIGNAL_RESOLVED': {
      const legs = Array.isArray(snap.legs) ? snap.legs as { symbol?: string }[] : [];
      const symbol = legs[0]?.symbol ?? snap.symbol;
      const type = legs.length === 1 ? 'SINGLE' : legs.length === 2 ? 'SPREAD' : `${legs.length}-LEG`;
      return symbol ? `${type} ${symbol}` : type;
    }
    case 'SIZED': {
      if (snap.quantity != null) return `${snap.quantity} contracts`;
      return null;
    }
    case 'ORDER_PLACED': {
      const params = snap.params as Record<string, unknown> | undefined;
      const parts: string[] = [];
      if (snap.orderId) parts.push(`#${snap.orderId}`);
      if (params?.limitPrice != null) parts.push(`limit $${params.limitPrice}`);
      if (snap.isCredit === true) parts.push('cr');
      else if (snap.isCredit === false) parts.push('dr');
      return parts.length > 0 ? parts.join(' ') : null;
    }
    case 'ORDER_ADJUSTED': {
      if (snap.fromPrice != null && snap.toPrice != null) return `$${snap.fromPrice} \u2192 $${snap.toPrice}`;
      return null;
    }
    case 'ORDER_FILLED': {
      const parts: string[] = [];
      if (snap.filledPrice != null) parts.push(`$${snap.filledPrice}`);
      if (snap.adjustmentCount != null && Number(snap.adjustmentCount) > 0) parts.push(`(${snap.adjustmentCount} chases)`);
      return parts.length > 0 ? parts.join(' ') : null;
    }
    case 'QUOTE_FAILED':
      return snap.occSymbol ? String(snap.occSymbol) : null;
    case 'RETRY_LLM':
      return snap.reason ? String(snap.reason) : null;
    case 'ORDER_CANCELLED': {
      const order = snap.order as Record<string, unknown> | undefined;
      const cancelParams = order?.params as Record<string, unknown> | undefined;
      const parts: string[] = [];
      if (cancelParams?.symbol) parts.push(String(cancelParams.symbol));
      if (cancelParams?.limitPrice != null && order?.currentLimitPrice != null &&
          cancelParams.limitPrice !== order.currentLimitPrice) {
        parts.push(`$${cancelParams.limitPrice} → $${order.currentLimitPrice}`);
      } else if (order?.currentLimitPrice != null) {
        parts.push(`$${order.currentLimitPrice}`);
      }
      return parts.length > 0 ? parts.join(' ') : null;
    }
    default:
      return null;
  }
}
