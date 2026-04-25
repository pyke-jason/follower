import type { BrokerService } from '../broker/interface.js';
import type { FilledWorkingOrder, OrderResult, WorkingOrder, WorkingOrderParams } from '../broker/types.js';
import type { SerializedWorkingOrder } from '../backtest/checkpoint-types.js';
import { WorkingOrderParamsSchema, OrderResultSchema } from '../broker/order-schemas.js';
import { createLogger } from '../lib/logger.js';
import { roundCents } from '../lib/numbers.js';
import { notionalValue } from '../lib/trade.js';

const log = createLogger('OrderMgr');

export type WorkingOrderExposure = {
  totalCount: number;
  countBySymbol: Map<string, number>;
  totalNotional: number;
};

export type OrderManagerConfig = {
  broker: BrokerService;
  clock: () => Date;
  onFill: (order: FilledWorkingOrder) => void | Promise<void>;
  onCancel: (order: WorkingOrder) => void | Promise<void>;
  onAdjust: (order: WorkingOrder, fromPrice: number, toPrice: number, step: number) => void | Promise<void>;
  /** When true, disables the 1s wall-clock auto-tick timer. Caller is responsible for calling tick() explicitly (e.g. in backtests using sim time). */
  manualTick?: boolean;
};

export class OrderManager {
  private broker: BrokerService;
  private clock: () => Date;
  private onFill: (order: FilledWorkingOrder) => void | Promise<void>;
  private onCancel: (order: WorkingOrder) => void | Promise<void>;
  private onAdjust: (order: WorkingOrder, fromPrice: number, toPrice: number, step: number) => void | Promise<void>;
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
      // PENDING = IBKR Inactive (outside RTH / not yet submitted to exchange).
      // Poll these too so we detect when they become OPEN or fill/cancel.
      if (order.status !== 'OPEN' && order.status !== 'PENDING') continue;

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
        await this.onFill(order as FilledWorkingOrder);
        this.stopTimerIfEmpty();
        continue;
      } else if (status.status === 'CANCELLED' || status.status === 'REJECTED') {
        order.status = status.status;
        order.cancelledAt = now;
        this.workingOrders.delete(orderId);
        await this.onCancel(order);
        this.stopTimerIfEmpty();
        continue;
      } else if (order.status === 'PENDING' && status.status === 'OPEN') {
        // Order transitioned from Inactive to Submitted — reset placedAt so the
        // cancelAfterSec timer starts from market activation, not original placement.
        order.status = 'OPEN';
        order.placedAt = now;
        order.lastAdjustedAt = now;
        log.info(`Order activated: ${orderId} ${order.params.symbol} (was Inactive)`);
        continue;
      }

      // Skip auto-cancel and price chase for still-PENDING (Inactive) orders.
      if (order.status !== 'OPEN') continue;

      // 2. Check auto-cancel timeout
      if (order.params.cancelAfterSec != null) {
        const elapsed = (now.getTime() - order.placedAt.getTime()) / 1000;
        if (elapsed >= order.params.cancelAfterSec) {
          log.info(`Auto-cancel: ${orderId} ${order.params.symbol} after ${order.params.cancelAfterSec}s`);
          const cancelResult = await this.broker.cancelOrder(orderId);
          // Race: IBKR may have filled the order in the window between the fill
          // check above and the cancel request (the MU PUT scenario). If the
          // cancel response reports FILLED, treat it as a fill — not a cancel —
          // so the trade is recorded and the pending intent is resolved.
          if (cancelResult.status === 'FILLED' && cancelResult.filledPrice != null && cancelResult.fillTimestamp != null) {
            order.status = 'FILLED';
            order.filledPrice = cancelResult.filledPrice;
            order.filledAt = new Date(cancelResult.fillTimestamp);
            order.filledQuantity = cancelResult.filledQuantity;
            order.commission = cancelResult.commission;
            order.fillTimestamp = cancelResult.fillTimestamp;
            order.legFills = cancelResult.legFills;
            this.workingOrders.delete(orderId);
            log.info(`Fill on cancel: ${orderId} ${order.params.symbol} @ $${cancelResult.filledPrice}`);
            await this.onFill(order as FilledWorkingOrder);
          } else {
            order.status = 'CANCELLED';
            order.cancelledAt = now;
            this.workingOrders.delete(orderId);
            await this.onCancel(order);
          }
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
          let newPrice = isBuy
            ? order.currentLimitPrice + totalMovement
            : order.currentLimitPrice - totalMovement;

          // Clamp to chaseLimit boundary
          if (rule.chaseLimit != null) {
            newPrice = isBuy
              ? Math.min(newPrice, rule.chaseLimit)   // BUY: don't exceed ceiling
              : Math.max(newPrice, rule.chaseLimit);   // SELL: don't go below floor
          }

          const roundedPrice = roundCents(Math.max(0.01, newPrice));
          const oldPrice = order.currentLimitPrice;
          log.debug(`Price chase: ${orderId} ${isBuy ? 'BUY' : 'SELL'} $${oldPrice} -> $${roundedPrice} (${stepsToApply} steps, total ${order.adjustmentCount + stepsToApply}/${rule.maxSteps ?? '∞'})`);
          const modResult = await this.broker.modifyOrder(orderId, roundedPrice);
          order.currentLimitPrice = roundedPrice;
          order.lastAdjustedAt = now;
          order.adjustmentCount += stepsToApply;
          await this.onAdjust(order, oldPrice, roundedPrice, order.adjustmentCount);

          // Broker may fill immediately if the new limit crosses the market
          if (modResult.status === 'FILLED' && modResult.filledPrice != null && modResult.fillTimestamp != null) {
            order.status = 'FILLED';
            order.filledPrice = modResult.filledPrice;
            order.filledAt = new Date(modResult.fillTimestamp);
            order.filledQuantity = modResult.filledQuantity;
            order.commission = modResult.commission;
            order.fillTimestamp = modResult.fillTimestamp;
            order.legFills = modResult.legFills;
            this.workingOrders.delete(orderId);
            log.info(`Fill on modify: ${orderId} ${order.params.symbol} @ $${modResult.filledPrice}`);
            await this.onFill(order as FilledWorkingOrder);
            this.stopTimerIfEmpty();
            break; // exit adjustmentRules loop
          }
        }
      }
    }
  }

  getWorkingOrders(): WorkingOrder[] {
    return Array.from(this.workingOrders.values());
  }

  exportState(): SerializedWorkingOrder[] {
    return [...this.workingOrders.values()].map((order) => {
      const { placedAt, lastAdjustedAt, filledAt, cancelledAt, ...rest } = order;
      return {
        ...rest,
        placedAt: placedAt.toISOString(),
        lastAdjustedAt: lastAdjustedAt.toISOString(),
        ...(filledAt ? { filledAt: filledAt.toISOString() } : {}),
        ...(cancelledAt ? { cancelledAt: cancelledAt.toISOString() } : {}),
      };
    });
  }

  restoreState(orders: SerializedWorkingOrder[]): void {
    this.workingOrders.clear();
    for (const order of orders) {
      const { placedAt, lastAdjustedAt, filledAt, cancelledAt, ...rest } = order;
      this.workingOrders.set(order.orderId, {
        ...rest,
        placedAt: new Date(placedAt),
        lastAdjustedAt: new Date(lastAdjustedAt),
        ...(filledAt ? { filledAt: new Date(filledAt) } : {}),
        ...(cancelledAt ? { cancelledAt: new Date(cancelledAt) } : {}),
      });
    }
    this.startTimerIfNeeded();
  }

  getExposure(): WorkingOrderExposure {
    const countBySymbol = new Map<string, number>();
    let totalNotional = 0;
    let totalCount = 0;
    for (const wo of this.workingOrders.values()) {
      if (wo.status !== 'OPEN') continue;
      totalCount++;
      const sym = wo.params.symbol;
      countBySymbol.set(sym, (countBySymbol.get(sym) ?? 0) + 1);
      totalNotional += notionalValue(
        wo.currentLimitPrice,
        wo.params.legs[0]?.quantity ?? 1,
        wo.params.strategy,
      );
    }
    return { totalCount, countBySymbol, totalNotional };
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
