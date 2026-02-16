import type { SimPosition, SimLeg } from './types.js';
import { createLogger } from '../lib/logger.js';
import { roundCents } from '../lib/numbers.js';

const log = createLogger('Position');

/**
 * PositionTracker: In-memory portfolio tracking for backtests.
 * Tracks open/closed positions and computes P&L on close.
 */
export class PositionTracker {
  private positions: SimPosition[] = [];
  private idCounter = 0;

  open(params: {
    symbol: string;
    direction: 'LONG' | 'SHORT';
    strategy: string;
    trader: string;
    entryPrice: number;
    quantity: number;
    legs: SimLeg[];
    openedAt: Date;
    sourceMessageId?: string;
  }): SimPosition {
    if (!Number.isFinite(params.entryPrice) || params.entryPrice <= 0) {
      throw new Error(`[PositionTracker] Invalid entryPrice: ${params.entryPrice}`);
    }
    if (!Number.isFinite(params.quantity) || params.quantity <= 0 || !Number.isInteger(params.quantity)) {
      throw new Error(`[PositionTracker] Invalid quantity: ${params.quantity}`);
    }

    const position: SimPosition = {
      id: `sim-${++this.idCounter}`,
      ...params,
    };
    this.positions.push(position);
    log.debug(`OPEN: ${params.direction} ${params.strategy} ${params.symbol} trader=${params.trader} qty=${params.quantity} @ $${params.entryPrice} [${position.id}]`);
    return position;
  }

  close(
    positionId: string,
    exitPrice: number,
    closedAt: Date,
    closeMessageId?: string,
  ): SimPosition | null {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos || pos.closedAt) return null;

    pos.exitPrice = exitPrice;
    pos.closedAt = closedAt;
    pos.closeMessageId = closeMessageId;
    pos.pnl = this.computePnl(pos);
    log.debug(`CLOSE: ${pos.id} ${pos.symbol} exit=$${exitPrice} PnL=$${pos.pnl.toFixed(2)}`);
    return pos;
  }

  /** Close the first matching open position for a symbol/trader */
  closeMatching(params: {
    symbol: string;
    trader: string;
    exitPrice: number;
    closedAt: Date;
    closeMessageId?: string;
  }): SimPosition | null {
    const { symbol, trader, exitPrice, closedAt, closeMessageId } = params;
    const pos = this.positions.find(
      (p) => p.symbol === symbol && p.trader === trader && !p.closedAt,
    );
    if (!pos) return null;
    return this.close(pos.id, exitPrice, closedAt, closeMessageId);
  }

  /**
   * Partially close a position: creates a closed "slice" for PnL and reduces
   * the original position's quantity.
   */
  partialClose(
    positionId: string,
    closeQuantity: number,
    exitPrice: number,
    closedAt: Date,
    closeMessageId?: string,
  ): SimPosition | null {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos || pos.closedAt) return null;

    if (!Number.isFinite(closeQuantity) || closeQuantity <= 0 || !Number.isInteger(closeQuantity)) {
      throw new Error(`[PositionTracker] Invalid closeQuantity: ${closeQuantity}`);
    }
    if (closeQuantity > pos.quantity) {
      throw new Error(`[PositionTracker] closeQuantity ${closeQuantity} > position quantity ${pos.quantity} for ${pos.id}`);
    }

    // Create a closed slice
    const slice: SimPosition = {
      id: `${pos.id}-partial-${++this.idCounter}`,
      symbol: pos.symbol,
      direction: pos.direction,
      strategy: pos.strategy,
      trader: pos.trader,
      entryPrice: pos.entryPrice,
      quantity: closeQuantity,
      legs: pos.legs,
      openedAt: pos.openedAt,
      closedAt,
      exitPrice,
      closeMessageId,
      sourceMessageId: pos.sourceMessageId,
      parentPositionId: pos.id,
      isPartialClose: true,
    };
    slice.pnl = this.computePnl(slice);
    this.positions.push(slice);
    log.debug(`PARTIAL CLOSE: ${pos.id} -${closeQuantity} @ $${exitPrice} PnL=$${slice.pnl.toFixed(2)} remaining=${pos.quantity - closeQuantity}`);

    // Reduce original position's quantity
    pos.quantity -= closeQuantity;

    // If fully closed, mark the original as closed too
    if (pos.quantity <= 0) {
      pos.closedAt = closedAt;
      pos.exitPrice = exitPrice;
      pos.closeMessageId = closeMessageId;
      pos.pnl = 0; // PnL is captured in slices
    }

    return slice;
  }

  /**
   * Add to an existing position: recalculates weighted average entry price
   * and increases quantity.
   */
  addToPosition(
    positionId: string,
    addQuantity: number,
    addPrice: number,
  ): SimPosition | null {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos || pos.closedAt) return null;

    if (!Number.isFinite(addQuantity) || addQuantity <= 0 || !Number.isInteger(addQuantity)) {
      throw new Error(`[PositionTracker] Invalid addQuantity: ${addQuantity}`);
    }
    if (!Number.isFinite(addPrice) || addPrice <= 0) {
      throw new Error(`[PositionTracker] Invalid addPrice: ${addPrice}`);
    }

    // Weighted average entry price
    const totalCost = pos.entryPrice * pos.quantity + addPrice * addQuantity;
    const totalQty = pos.quantity + addQuantity;
    pos.entryPrice = totalCost / totalQty;
    pos.quantity = totalQty;

    log.debug(`ADD: ${pos.id} +${addQuantity} @ $${addPrice} -> avgEntry=$${pos.entryPrice.toFixed(2)} totalQty=${totalQty}`);
    return pos;
  }

  /**
   * FIFO match + partial close: find the first matching open position and
   * partially close it. If no closeQuantity is provided, uses exitPercent
   * (defaulting to 50%) to calculate quantity.
   */
  partialCloseMatching(params: {
    symbol: string;
    trader: string;
    exitPrice: number;
    closedAt: Date;
    closeMessageId?: string;
    closeQuantity?: number;
    exitPercent?: number;
  }): SimPosition | null {
    const { symbol, trader, exitPrice, closedAt, closeMessageId, closeQuantity, exitPercent } = params;
    const pos = this.positions.find(
      (p) => p.symbol === symbol && p.trader === trader && !p.closedAt && !p.isPartialClose,
    );
    if (!pos) return null;

    const qty = closeQuantity ?? Math.max(1, Math.floor(pos.quantity * (exitPercent ?? 0.5)));
    return this.partialClose(pos.id, qty, exitPrice, closedAt, closeMessageId);
  }

  getOpen(): SimPosition[] {
    return this.positions.filter((p) => !p.closedAt);
  }

  getClosed(): SimPosition[] {
    return this.positions.filter((p) => p.closedAt != null);
  }

  getAll(): SimPosition[] {
    return [...this.positions];
  }

  getOpenBySymbol(symbol: string): SimPosition[] {
    return this.positions.filter((p) => p.symbol === symbol && !p.closedAt);
  }

  getOpenByTrader(trader: string): SimPosition[] {
    return this.positions.filter((p) => p.trader === trader && !p.closedAt);
  }

  private computePnl(pos: SimPosition): number {
    if (pos.exitPrice == null) {
      throw new Error(`[PositionTracker] Cannot compute PnL for ${pos.id}: exitPrice is null`);
    }
    if (!Number.isFinite(pos.exitPrice)) {
      throw new Error(`[PositionTracker] Cannot compute PnL for ${pos.id}: exitPrice is ${pos.exitPrice}`);
    }
    if (!Number.isFinite(pos.entryPrice)) {
      throw new Error(`[PositionTracker] Cannot compute PnL for ${pos.id}: entryPrice is ${pos.entryPrice}`);
    }

    const diff = pos.exitPrice - pos.entryPrice;
    const multiplier = pos.direction === 'LONG' ? 1 : -1;

    // For spreads and options, multiply by 100 (1 contract = 100 shares)
    const contractMultiplier =
      pos.strategy === 'STOCK' ? 1 : 100;

    const result = diff * multiplier * pos.quantity * contractMultiplier;
    if (!Number.isFinite(result)) {
      throw new Error(`[PositionTracker] PnL computation produced ${result} for ${pos.id} (entry=${pos.entryPrice}, exit=${pos.exitPrice}, qty=${pos.quantity})`);
    }
    return result;
  }

  getDailyPnl(date: Date): number {
    const dateStr = date.toISOString().split('T')[0];
    return this.positions
      .filter(
        (p) =>
          p.closedAt &&
          p.closedAt.toISOString().startsWith(dateStr) &&
          p.pnl != null,
      )
      .reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  }

  getTotalPnl(): number {
    return this.getClosed().reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  }

  /**
   * Compute total unrealized PnL for all open positions using mark prices.
   * @param markPrices Map of position ID -> current mark price (net premium for options)
   */
  computeUnrealizedPnl(markPrices: Map<string, number>): number {
    let total = 0;
    for (const pos of this.getOpen()) {
      const markPrice = markPrices.get(pos.id);
      if (markPrice == null) continue;
      const diff = markPrice - pos.entryPrice;
      const multiplier = pos.direction === 'LONG' ? 1 : -1;
      const contractMultiplier = pos.strategy === 'STOCK' ? 1 : 100;
      total += diff * multiplier * pos.quantity * contractMultiplier;
    }
    return roundCents(total);
  }
}
