import type { BrokerService } from '../broker/interface.js';
import type { FilledWorkingOrder, OrderResult, WorkingOrder, WorkingOrderParams } from '../broker/types.js';
import { WorkingOrderParamsSchema, OrderResultSchema } from '../broker/order-schemas.js';
import { createLogger } from '../lib/logger.js';
import { roundCents } from '../lib/numbers.js';

const log = createLogger('OrderMgr');

export type OrderManagerConfig = {
  broker: BrokerService;
  clock: () => Date;
  onFill?: (order: FilledWorkingOrder) => void | Promise<void>;
  onCancel?: (order: WorkingOrder) => void | Promise<void>;
  onAdjust?: (order: WorkingOrder, fromPrice: number, toPrice: number, step: number) => void | Promise<void>;
  /** When true, disables the 1s wall-clock auto-tick timer. Caller is responsible for calling tick() explicitly (e.g. in backtests using sim time). */
  manualTick?: boolean;
};

export class OrderManager {
  private broker: BrokerService;
  private clock: () => Date;
  private onFill?: (order: FilledWorkingOrder) => void | Promise<void>;
  private onCancel?: (order: WorkingOrder) => void | Promise<void>;
  private onAdjust?: (order: WorkingOrder, fromPrice: number, toPrice: number, step: number) => void | Promise<void>;
  private manualTick: boolean;
  private workingOrders = new Map<string, WorkingOrder>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: OrderManagerConfig) {
    this.broker = config.broker;
    this.clock = config.clock;
    this.onFill = config.onFill;
    this.onCancel = config.onCancel;
    this.onAdjust = config.onAdjust;
    this.manualTick = config.manualTick ?? false;
  }

  async submitOrder(params: WorkingOrderParams): Promise<OrderResult> {
    WorkingOrderParamsSchema.parse(params);

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
      let rawStatus;
      try {
        rawStatus = await this.broker.getOrderStatus(orderId);
      } catch (err) {
        log.warn(`getOrderStatus failed for ${orderId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const status = OrderResultSchema.parse(rawStatus);
      if (status.status === 'FILLED') {
        // Zod refines guarantee filledPrice + fillTimestamp are present for FILLED
        order.status = 'FILLED';
        order.filledPrice = status.filledPrice!;
        order.filledAt = new Date(status.fillTimestamp!);
        order.filledQuantity = status.filledQuantity;
        order.commission = status.commission;
        order.fillTimestamp = status.fillTimestamp!;
        order.legFills = status.legFills;
        this.workingOrders.delete(orderId);
        log.info(`Fill: ${orderId} ${order.params.symbol} @ $${status.filledPrice}`);
        await this.onFill?.(order as FilledWorkingOrder);
        this.stopTimerIfEmpty();
        continue;
      } else if (status.status === 'CANCELLED' || status.status === 'REJECTED') {
        order.status = status.status;
        order.cancelledAt = now;
        this.workingOrders.delete(orderId);
        await this.onCancel?.(order);
        this.stopTimerIfEmpty();
        continue;
      }

      // 2. Check auto-cancel timeout
      if (order.params.cancelAfterSec != null) {
        const elapsed = (now.getTime() - order.placedAt.getTime()) / 1000;
        if (elapsed >= order.params.cancelAfterSec) {
          log.info(`Auto-cancel: ${orderId} ${order.params.symbol} after ${order.params.cancelAfterSec}s`);
          await this.broker.cancelOrder(orderId);
          order.status = 'CANCELLED';
          order.cancelledAt = now;
          this.workingOrders.delete(orderId);
          await this.onCancel?.(order);
          this.stopTimerIfEmpty();
          continue;
        }
      }

      // 3. Check adjustment rules (PRICE_CHASE)
      // Batch-apply steps based on elapsed time: in backtest, tick() fires once per
      // message (potentially minutes apart), so we compute how many steps should have
      // fired and apply them all at once.
      if (order.params.adjustmentRules) {
        for (const rule of order.params.adjustmentRules) {
          if (rule.type !== 'PRICE_CHASE') continue;

          const sinceLastAdj = (now.getTime() - order.lastAdjustedAt.getTime()) / 1000;
          if (sinceLastAdj < rule.intervalSec) continue;

          const stepsElapsed = Math.floor(sinceLastAdj / rule.intervalSec);
          const remainingSteps = rule.maxSteps != null
            ? Math.max(0, rule.maxSteps - order.adjustmentCount)
            : stepsElapsed;
          const stepsToApply = Math.min(stepsElapsed, remainingSteps);
          if (stepsToApply <= 0) continue;

          // BUY chases UP, SELL chases DOWN
          const firstLeg = order.params.legs[0];
          if (!firstLeg) {
            throw new Error(`Working order ${orderId} has no legs — cannot determine price chase direction`);
          }
          const isBuy = firstLeg.action === 'BUY';
          const totalMovement = stepsToApply * rule.stepAmount;
          const newPrice = isBuy
            ? order.currentLimitPrice + totalMovement
            : order.currentLimitPrice - totalMovement;

          const roundedPrice = roundCents(newPrice);
          const oldPrice = order.currentLimitPrice;
          log.debug(`Price chase: ${orderId} ${isBuy ? 'BUY' : 'SELL'} $${oldPrice} -> $${roundedPrice} (${stepsToApply} steps, total ${order.adjustmentCount + stepsToApply}/${rule.maxSteps ?? '∞'})`);
          await this.broker.modifyOrder(orderId, roundedPrice);
          order.currentLimitPrice = roundedPrice;
          order.lastAdjustedAt = now;
          order.adjustmentCount += stepsToApply;
          await this.onAdjust?.(order, oldPrice, roundedPrice, order.adjustmentCount);
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
