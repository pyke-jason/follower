import { describe, expect, test, vi } from 'vitest';
import type { BrokerService } from '../broker/interface.js';
import type { AccountBalance, BrokerPosition, OrderParams, OrderResult, Quote } from '../broker/types.js';
import { OrderManager } from '../orders/order-manager.js';
import { createPendingContextFromResume } from '../pipeline/execute-resolved.js';
import { SimClock } from './clock.js';
import type { BacktestPriceProvider } from './market-data.js';
import { ShadowTracker } from './shadow-tracker.js';
import { SimBroker } from './sim-broker.js';

function queueOnlyMarketData(): BacktestPriceProvider {
  return {
    async getQuote(): Promise<Quote> {
      throw new Error('offline');
    },
    getPriceSnapshot: () => ({}),
    async getTicksInRange() {
      return [];
    },
    async prefetch() {},
  };
}

function openOrderBroker(): BrokerService {
  return {
    async getQuote(): Promise<Quote> {
      throw new Error('unused');
    },
    async placeOrder(): Promise<OrderResult> {
      return { orderId: 'ORDER-1', status: 'OPEN' };
    },
    async modifyOrder(): Promise<OrderResult> {
      return { orderId: 'ORDER-1', status: 'OPEN' };
    },
    async cancelOrder(): Promise<OrderResult> {
      return { orderId: 'ORDER-1', status: 'CANCELLED' };
    },
    async cancelAllOrders(): Promise<void> {},
    async getOrderStatus(): Promise<OrderResult> {
      return { orderId: 'ORDER-1', status: 'OPEN' };
    },
    async getPositions(): Promise<BrokerPosition[]> {
      return [];
    },
    async getAccountBalance(): Promise<AccountBalance> {
      return {
        accountId: 'test',
        cashBalance: 100_000,
        buyingPower: 100_000,
        equity: 100_000,
        marketValue: 0,
        unrealizedPnl: 0,
        realizedPnl: 0,
        timestamp: new Date().toISOString(),
      };
    },
    async isHealthy(): Promise<boolean> {
      return true;
    },
    async placeStopOrder(): Promise<OrderResult> {
      return { orderId: 'NO-STOP', status: 'OPEN' };
    },
  };
}

const stockLimitOrder: OrderParams = {
  symbol: 'AAPL',
  strategy: 'STOCK',
  direction: 'LONG',
  legs: [{ symbol: 'AAPL', type: 'STOCK', action: 'BUY', quantity: 1, strike: 0, expiry: '' }],
  orderType: 'LIMIT',
  limitPrice: 100,
  isClosing: false,
};

describe('backtest checkpoint serialization', () => {
  test('restores SimBroker working orders and order counter', async () => {
    const clock = new SimClock(new Date('2025-09-03T14:30:00.000Z'));
    const broker = new SimBroker(queueOnlyMarketData(), clock, 'bt:test-run', 'midpoint', 100_000);

    const first = await broker.placeOrder(stockLimitOrder);
    expect(first.status).toBe('OPEN');

    const restored = new SimBroker(queueOnlyMarketData(), clock, 'bt:test-run', 'midpoint', 100_000);
    restored.restoreState(broker.exportState());

    await expect(restored.getOrderStatus(first.orderId)).resolves.toMatchObject({
      orderId: first.orderId,
      status: 'OPEN',
    });

    const second = await restored.placeOrder(stockLimitOrder);
    expect(second.orderId).toBe('SIM-2');
  });

  test('restores OrderManager working order timing state', async () => {
    const broker = openOrderBroker();
    const clock = new SimClock(new Date('2025-09-03T14:30:00.000Z'));
    const manager = new OrderManager({
      broker,
      clock: () => clock.now(),
      manualTick: true,
      onFill: vi.fn(),
      onCancel: vi.fn(),
      onAdjust: vi.fn(),
    });

    await manager.submitOrder({
      ...stockLimitOrder,
      adjustmentRules: [{ type: 'PRICE_CHASE', stepAmount: 0.01, intervalSec: 5, maxSteps: 3 }],
      cancelAfterSec: 30,
    });

    const restored = new OrderManager({
      broker,
      clock: () => clock.now(),
      manualTick: true,
      onFill: vi.fn(),
      onCancel: vi.fn(),
      onAdjust: vi.fn(),
    });
    restored.restoreState(manager.exportState());

    expect(restored.getWorkingOrders()).toHaveLength(1);
    expect(restored.getWorkingOrders()[0].placedAt.toISOString()).toBe('2025-09-03T14:30:00.000Z');
  });

  test('restores shadow tracker skipped-open state', () => {
    const tracker = new ShadowTracker();
    tracker.recordSkippedOpen('Pete', 'NVDA');

    const restored = new ShadowTracker(tracker.serialize());

    expect(restored.isUnfollowedExit('Pete', 'CLOSE', 'NVDA')).toBe(true);
    restored.recordFollowedOpen('Pete', 'NVDA');
    expect(restored.isUnfollowedExit('Pete', 'CLOSE', 'NVDA')).toBe(false);
  });

  test('recreates pending fill callbacks from checkpoint data', async () => {
    const recordTrade = vi.fn(async () => ({
      tradeId: 'trade-1',
      action: 'OPEN' as const,
      trade: {} as never,
    }));
    const pending = createPendingContextFromResume({
      kind: 'OPEN',
      action: 'OPEN',
      symbol: 'AAPL',
      trader: 'Pete',
      direction: 'LONG',
      strategy: 'STOCK',
      quantity: 3,
      legs: [{ symbol: 'AAPL', type: 'STOCK', action: 'BUY', quantity: 3, strike: 0, expiry: '' }],
      messageId: 'msg-1',
      signalIndex: 0,
      limitPrice: 100,
      isCredit: false,
    }, recordTrade);

    await pending.recordFill({
      filledPrice: 101,
      filledAt: new Date('2025-09-03T14:31:00.000Z'),
      adjustmentCount: 6,
    });

    expect(recordTrade).toHaveBeenCalledWith(expect.objectContaining({
      action: 'OPEN',
      symbol: 'AAPL',
      quantity: 3,
      sourceMessageId: 'msg-1',
      metadata: expect.objectContaining({
        chaseSteps: 6,
        flags: ['chaseWarn'],
        entrySlippage: 1,
      }),
    }));
  });
});
