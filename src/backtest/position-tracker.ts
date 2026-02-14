import type { SimPosition, SimLeg } from './types.js';

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
    const position: SimPosition = {
      id: `sim-${++this.idCounter}`,
      ...params,
    };
    this.positions.push(position);
    return position;
  }

  close(
    positionId: string,
    exitPrice: number,
    closedAt: Date,
  ): SimPosition | null {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos || pos.closedAt) return null;

    pos.exitPrice = exitPrice;
    pos.closedAt = closedAt;
    pos.pnl = this.computePnl(pos);
    return pos;
  }

  /** Close the first matching open position for a symbol/trader */
  closeMatching(
    symbol: string,
    trader: string,
    exitPrice: number,
    closedAt: Date,
  ): SimPosition | null {
    const pos = this.positions.find(
      (p) => p.symbol === symbol && p.trader === trader && !p.closedAt,
    );
    if (!pos) return null;
    return this.close(pos.id, exitPrice, closedAt);
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
    if (pos.exitPrice == null || isNaN(pos.exitPrice) || isNaN(pos.entryPrice)) return 0;

    const diff = pos.exitPrice - pos.entryPrice;
    const multiplier = pos.direction === 'LONG' ? 1 : -1;

    // For spreads and options, multiply by 100 (1 contract = 100 shares)
    const contractMultiplier =
      pos.strategy === 'STOCK' ? 1 : 100;

    const result = diff * multiplier * pos.quantity * contractMultiplier;
    return isNaN(result) ? 0 : result;
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
}
