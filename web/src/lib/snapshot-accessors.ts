/**
 * Typed accessors for JSON snapshot/metadata columns.
 *
 * RunDecision.snapshot and TradeEvent.metadata are typed as Record<string, unknown>
 * in the schema ($type<> doesn't propagate through select()). These accessors
 * centralize the cast-and-extract pattern so call sites don't repeat
 * `as Record<string, unknown>` chains.
 */

import type { RunDecision, TradeEvent, TradeMetadata } from '@src/db/schema';

// ── Snapshot sub-shapes ──────────────────────────────

/** Order params nested inside snapshots (ORDER_PLACED, ORDER_FILLED, ORDER_ADJUSTED). */
export type SnapshotOrderParams = {
  orderType?: string;
  limitPrice?: number;
  symbol?: string;
  adjustmentRules?: AdjustmentRule[];
};

/** A single chase adjustment rule from order params. */
export type AdjustmentRule = {
  chaseLimit?: number;
  stepAmount?: number;
};

/** The `order` sub-object inside ORDER_CANCELLED snapshots. */
export type SnapshotCancelledOrder = {
  params?: SnapshotOrderParams;
  currentLimitPrice?: number;
  adjustmentCount?: number;
  status?: string;
};

/** The `signal` sub-object inside SETTLED snapshots. */
export type SnapshotSignal = {
  action?: string;
  orderType?: string;
  tradeId?: string;
};

// ── Snapshot accessors ───────────────────────────────

/** Get the snapshot object from a RunDecision, or null. */
export function getSnapshot(d: RunDecision): Record<string, unknown> | null {
  return (d.snapshot as Record<string, unknown> | null) ?? null;
}

/** Extract order params from a snapshot (top-level `.params`). */
export function getSnapshotParams(snap: Record<string, unknown>): SnapshotOrderParams | undefined {
  return snap.params as SnapshotOrderParams | undefined;
}

/**
 * Extract order params for ORDER_ADJUSTED events.
 * Tries `snapshot.pending.params` first (working order shape), falls back to `snapshot.params`.
 */
export function getAdjustedParams(snap: Record<string, unknown>): SnapshotOrderParams | undefined {
  const pending = snap.pending as Record<string, unknown> | undefined;
  return (pending?.params as SnapshotOrderParams | undefined) ??
         (snap.params as SnapshotOrderParams | undefined);
}

/** Extract the first adjustment rule from order params. */
export function getFirstAdjustmentRule(params: SnapshotOrderParams | undefined): AdjustmentRule | undefined {
  const rules = params?.adjustmentRules;
  return Array.isArray(rules) && rules.length > 0 ? rules[0] : undefined;
}

/** Extract the cancelled order sub-object from a snapshot. */
export function getCancelledOrder(snap: Record<string, unknown>): SnapshotCancelledOrder | undefined {
  return snap.order as SnapshotCancelledOrder | undefined;
}

/** Extract the signal sub-object from a SETTLED snapshot. */
export function getSnapshotSignal(snap: Record<string, unknown>): SnapshotSignal | undefined {
  return snap.signal as SnapshotSignal | undefined;
}

// ── TradeEvent metadata accessor ─────────────────────

/** Known fields on TradeEvent.metadata. */
export type EventMeta = {
  chaseSteps?: number;
  trimPnl?: number;
  exitPercent?: number;
  targetStrategy?: string;
  closedLeg?: { type?: string; strike?: number; action?: string; fillPrice?: number };
  legOffPnl?: number;
};

/** Extract typed metadata from a TradeEvent. */
export function getEventMeta(ev: TradeEvent): EventMeta {
  return (ev.metadata ?? {}) as EventMeta;
}

// ── Trade metadata accessor ──────────────────────────

/**
 * Extract typed metadata from a Trade.
 * With customType, Trade.metadata is always TradeMetadata — this is a
 * pass-through kept for call-site convenience.
 */
export function getTradeMeta(trade: { metadata: TradeMetadata }): TradeMetadata {
  return trade.metadata;
}
