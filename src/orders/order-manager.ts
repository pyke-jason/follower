import type { BrokerService } from '../broker/interface.js';
import type { OrderResult, WorkingOrder, WorkingOrderParams } from '../broker/types.js';

export type OrderManagerConfig = {
  broker: BrokerService;
  clock: () => Date;
  onFill?: (order: WorkingOrder) => void;
  onCancel?: (order: WorkingOrder) => void;
};

export class OrderManager {
  private broker: BrokerService;
  private clock: () => Date;
  private onFill?: (order: WorkingOrder) => void;
  private onCancel?: (order: WorkingOrder) => void;
  private workingOrders = new Map<string, WorkingOrder>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: OrderManagerConfig) {
    this.broker = config.broker;
    this.clock = config.clock;
    this.onFill = config.onFill;
    this.onCancel = config.onCancel;
  }

  async submitOrder(params: WorkingOrderParams): Promise<OrderResult> {
    const hasRules = params.adjustmentRules?.length || params.cancelAfterSec;
    const isLimit = params.orderType === 'LIMIT';

    // Pass straight through if MARKET or LIMIT without rules
    if (!isLimit || !hasRules) {
      const { adjustmentRules, cancelAfterSec, ...orderParams } = params;
      return this.broker.placeOrder(orderParams);
    }

    // Place the LIMIT order via broker
    const { adjustmentRules, cancelAfterSec, ...orderParams } = params;
    const result = await this.broker.placeOrder(orderParams);

    // If it filled immediately, no need to track
    if (result.status === 'FILLED') {
      return result;
    }

    // Register as working order
    const now = this.clock();
    const workingOrder: WorkingOrder = {
      orderId: result.orderId,
      params,
      status: result.status,
      currentLimitPrice: params.limitPrice!,
      placedAt: now,
      lastAdjustedAt: now,
      adjustmentCount: 0,
    };
    this.workingOrders.set(result.orderId, workingOrder);

    this.startTimerIfNeeded();
    return result;
  }

  async tick(now: Date): Promise<void> {
    for (const [orderId, order] of this.workingOrders) {
      if (order.status !== 'OPEN') continue;

      // 1. Check auto-cancel timeout
      if (order.params.cancelAfterSec) {
        const elapsed = (now.getTime() - order.placedAt.getTime()) / 1000;
        if (elapsed >= order.params.cancelAfterSec) {
          await this.broker.cancelOrder(orderId);
          order.status = 'CANCELLED';
          order.cancelledAt = now;
          this.workingOrders.delete(orderId);
          this.onCancel?.(order);
          this.stopTimerIfEmpty();
          continue;
        }
      }

      // 2. Check adjustment rules (PRICE_CHASE)
      if (order.params.adjustmentRules) {
        for (const rule of order.params.adjustmentRules) {
          if (rule.type !== 'PRICE_CHASE') continue;

          const sinceLastAdj = (now.getTime() - order.lastAdjustedAt.getTime()) / 1000;
          if (sinceLastAdj < rule.intervalSec) continue;

          if (rule.maxSteps && order.adjustmentCount >= rule.maxSteps) continue;

          // BUY chases UP, SELL chases DOWN
          const isBuy = order.params.legs[0]?.action === 'BUY';
          const newPrice = isBuy
            ? order.currentLimitPrice + rule.stepAmount
            : order.currentLimitPrice - rule.stepAmount;

          const roundedPrice = Math.round(newPrice * 100) / 100;
          await this.broker.modifyOrder(orderId, roundedPrice);
          order.currentLimitPrice = roundedPrice;
          order.lastAdjustedAt = now;
          order.adjustmentCount++;
        }
      }

      // 3. Check fill status
      const status = await this.broker.getOrderStatus(orderId);
      if (status.status === 'FILLED') {
        order.status = 'FILLED';
        order.filledPrice = status.filledPrice;
        order.filledAt = now;
        this.workingOrders.delete(orderId);
        this.onFill?.(order);
        this.stopTimerIfEmpty();
      } else if (status.status === 'CANCELLED' || status.status === 'REJECTED') {
        order.status = status.status;
        order.cancelledAt = now;
        this.workingOrders.delete(orderId);
        this.onCancel?.(order);
        this.stopTimerIfEmpty();
      }
    }
  }

  getWorkingOrders(): WorkingOrder[] {
    return Array.from(this.workingOrders.values());
  }

  private startTimerIfNeeded(): void {
    if (this.timer || this.workingOrders.size === 0) return;
    this.timer = setInterval(() => this.tick(this.clock()), 1000);
  }

  private stopTimerIfEmpty(): void {
    if (this.workingOrders.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.workingOrders.clear();
  }
}
