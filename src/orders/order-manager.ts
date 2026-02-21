import type { BrokerService } from '../broker/interface.js';
import type { OrderResult, WorkingOrder, WorkingOrderParams } from '../broker/types.js';
import { WorkingOrderParamsSchema, OrderResultSchema } from '../broker/order-schemas.js';
import { createLogger } from '../lib/logger.js';
import { roundCents } from '../lib/numbers.js';

const log = createLogger('OrderMgr');

export type OrderManagerConfig = {
  broker: BrokerService;
  clock: () => Date;
  onFill?: (order: WorkingOrder) => void;
  onCancel?: (order: WorkingOrder) => void;
  /** When true, disables the 1s wall-clock auto-tick timer. Caller is responsible for calling tick() explicitly (e.g. in backtests using sim time). */
  manualTick?: boolean;
};

export class OrderManager {
  private broker: BrokerService;
  private clock: () => Date;
  private onFill?: (order: WorkingOrder) => void;
  private onCancel?: (order: WorkingOrder) => void;
  private manualTick: boolean;
  private workingOrders = new Map<string, WorkingOrder>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: OrderManagerConfig) {
    this.broker = config.broker;
    this.clock = config.clock;
    this.onFill = config.onFill;
    this.onCancel = config.onCancel;
    this.manualTick = config.manualTick ?? false;
  }

  async submitOrder(params: WorkingOrderParams): Promise<OrderResult> {
    WorkingOrderParamsSchema.parse(params);
    const legCount = params.legs.length;
    const ruleCount = params.adjustmentRules?.length ?? 0;
    log.debug(`submit: ${params.orderType} ${params.symbol} legs=${legCount} limit=$${params.limitPrice ?? 'MKT'} cancelAfter=${params.cancelAfterSec ?? 'none'}s rules=${ruleCount}`);

    const hasRules = (params.adjustmentRules?.length ?? 0) > 0 || params.cancelAfterSec != null;
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

    // Register as working order — limitPrice guaranteed by schema refine above
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

      // 1. Check fill status FIRST — fills from advanceTo() must be detected
      //    before auto-cancel can fire, otherwise we lose recorded trades.
      const status = OrderResultSchema.parse(await this.broker.getOrderStatus(orderId));
      if (status.status === 'FILLED') {
        log.debug(`Fill confirmed: ${orderId} @ $${status.filledPrice}`);
        order.status = 'FILLED';
        order.filledPrice = status.filledPrice;
        order.filledAt = new Date(status.fillTimestamp!);
        order.filledQuantity = status.filledQuantity;
        order.commission = status.commission;
        order.fillTimestamp = status.fillTimestamp;
        order.legFills = status.legFills;
        this.workingOrders.delete(orderId);
        this.onFill?.(order);
        this.stopTimerIfEmpty();
        continue;
      } else if (status.status === 'CANCELLED' || status.status === 'REJECTED') {
        order.status = status.status;
        order.cancelledAt = now;
        this.workingOrders.delete(orderId);
        this.onCancel?.(order);
        this.stopTimerIfEmpty();
        continue;
      }

      // 2. Check auto-cancel timeout
      if (order.params.cancelAfterSec != null) {
        const elapsed = (now.getTime() - order.placedAt.getTime()) / 1000;
        if (elapsed >= order.params.cancelAfterSec) {
          log.debug(`Auto-cancel: ${orderId} after ${order.params.cancelAfterSec}s`);
          await this.broker.cancelOrder(orderId);
          order.status = 'CANCELLED';
          order.cancelledAt = now;
          this.workingOrders.delete(orderId);
          this.onCancel?.(order);
          this.stopTimerIfEmpty();
          continue;
        }
      }

      // 3. Check adjustment rules (PRICE_CHASE)
      if (order.params.adjustmentRules) {
        for (const rule of order.params.adjustmentRules) {
          if (rule.type !== 'PRICE_CHASE') continue;

          const sinceLastAdj = (now.getTime() - order.lastAdjustedAt.getTime()) / 1000;
          if (sinceLastAdj < rule.intervalSec) continue;

          if (rule.maxSteps != null && order.adjustmentCount >= rule.maxSteps) continue;

          // BUY chases UP, SELL chases DOWN
          const firstLeg = order.params.legs[0];
          if (!firstLeg) {
            throw new Error(`Working order ${orderId} has no legs — cannot determine price chase direction`);
          }
          const isBuy = firstLeg.action === 'BUY';
          const newPrice = isBuy
            ? order.currentLimitPrice + rule.stepAmount
            : order.currentLimitPrice - rule.stepAmount;

          const roundedPrice = roundCents(newPrice);
          log.debug(`Price chase: ${orderId} ${isBuy ? 'BUY' : 'SELL'} $${order.currentLimitPrice} -> $${roundedPrice} (step ${order.adjustmentCount + 1}/${rule.maxSteps ?? '∞'})`);
          await this.broker.modifyOrder(orderId, roundedPrice);
          order.currentLimitPrice = roundedPrice;
          order.lastAdjustedAt = now;
          order.adjustmentCount++;
        }
      }
    }
  }

  getWorkingOrders(): WorkingOrder[] {
    return Array.from(this.workingOrders.values());
  }

  private startTimerIfNeeded(): void {
    if (this.manualTick || this.timer || this.workingOrders.size === 0) return;
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
