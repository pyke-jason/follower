/**
 * Property-based tests for OrderManager.
 *
 * Uses fast-check to verify fill/cancel/price-chase invariants against
 * a controllable mock broker. No DB needed — OrderManager is pure orchestration.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import { OrderManager } from './order-manager.js';
import type { BrokerService } from '../broker/interface.js';
import type { OrderResult, WorkingOrderParams, OrderStatus } from '../broker/types.js';
import { roundCents } from '../lib/numbers.js';

// ── Mock broker factory ──────────────────────────────────────────────

type StatusOverride = Partial<OrderResult>;

function makeMockBroker(overrides: {
  placeResult?: Partial<OrderResult>;
  statusByOrderId?: Map<string, StatusOverride>;
} = {}) {
  let orderCounter = 0;
  const statusMap = overrides.statusByOrderId ?? new Map<string, StatusOverride>();

  const broker: BrokerService = {
    placeOrder: vi.fn(async (): Promise<OrderResult> => {
      const orderId = `order-${++orderCounter}`;
      const base: OrderResult = { orderId, status: 'OPEN' as OrderStatus };
      return { ...base, ...overrides.placeResult, orderId };
    }),
    getOrderStatus: vi.fn(async (orderId: string): Promise<OrderResult> => {
      const override = statusMap.get(orderId);
      return { orderId, status: 'OPEN' as OrderStatus, ...override };
    }),
    modifyOrder: vi.fn(async (orderId: string): Promise<OrderResult> => {
      return { orderId, status: 'OPEN' as OrderStatus };
    }),
    cancelOrder: vi.fn(async (orderId: string): Promise<OrderResult> => {
      return { orderId, status: 'CANCELLED' as OrderStatus };
    }),
    getQuote: vi.fn(),
    getPositions: vi.fn(),
    getAccountBalance: vi.fn(),
  };

  return { broker, statusMap };
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeLimitBuyParams(overrides: Partial<WorkingOrderParams> = {}): WorkingOrderParams {
  return {
    symbol: 'SPY',
    strategy: 'STOCK',
    direction: 'LONG',
    legs: [{ symbol: 'SPY', strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'BUY', quantity: 1 }],
    orderType: 'LIMIT',
    limitPrice: 100,
    cancelAfterSec: 60,
    ...overrides,
  };
}

function makeLimitSellParams(overrides: Partial<WorkingOrderParams> = {}): WorkingOrderParams {
  return {
    symbol: 'SPY',
    strategy: 'STOCK',
    direction: 'SHORT',
    legs: [{ symbol: 'SPY', strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'SELL', quantity: 1 }],
    orderType: 'LIMIT',
    limitPrice: 100,
    cancelAfterSec: 60,
    ...overrides,
  };
}

const T0 = new Date('2026-01-15T10:00:00Z');
function timeAfter(sec: number): Date {
  return new Date(T0.getTime() + sec * 1000);
}

// ── Arbitraries ──────────────────────────────────────────────────────

const arbLimitPrice = fc.double({ min: 1, max: 5000, noNaN: true, noDefaultInfinity: true });
const arbStepAmount = fc.double({ min: 0.01, max: 5.0, noNaN: true, noDefaultInfinity: true });
const arbIntervalSec = fc.integer({ min: 1, max: 120 });
const arbMaxSteps = fc.integer({ min: 0, max: 20 });
const arbCancelAfterSec = fc.integer({ min: 0, max: 300 });
const arbElapsedSec = fc.integer({ min: 0, max: 600 });

// ── Tests ────────────────────────────────────────────────────────────

describe('OrderManager fill properties', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test('MARKET orders pass through without tracking', () => {
    fc.assert(
      fc.asyncProperty(arbLimitPrice, async (price) => {
        const { broker } = makeMockBroker({ placeResult: { status: 'FILLED', filledPrice: price } });
        const mgr = new OrderManager({ broker, clock: () => T0, manualTick: true });

        await mgr.submitOrder({
          symbol: 'SPY',
          strategy: 'STOCK',
          direction: 'LONG',
          legs: [{ symbol: 'SPY', strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'BUY', quantity: 1 }],
          orderType: 'MARKET',
        });

        expect(mgr.getWorkingOrders()).toHaveLength(0);
        mgr.destroy();
      }),
      { numRuns: 200 },
    );
  });

  test('LIMIT orders without rules pass through without tracking', () => {
    fc.assert(
      fc.asyncProperty(arbLimitPrice, async (price) => {
        const { broker } = makeMockBroker({ placeResult: { status: 'OPEN' } });
        const mgr = new OrderManager({ broker, clock: () => T0, manualTick: true });

        await mgr.submitOrder({
          symbol: 'SPY',
          strategy: 'STOCK',
          direction: 'LONG',
          legs: [{ symbol: 'SPY', strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'BUY', quantity: 1 }],
          orderType: 'LIMIT',
          limitPrice: price,
        });

        expect(mgr.getWorkingOrders()).toHaveLength(0);
        mgr.destroy();
      }),
      { numRuns: 200 },
    );
  });

  test('immediately-filled LIMIT orders are not tracked', () => {
    fc.assert(
      fc.asyncProperty(arbLimitPrice, async (price) => {
        const { broker } = makeMockBroker({ placeResult: { status: 'FILLED', filledPrice: price } });
        const mgr = new OrderManager({ broker, clock: () => T0, manualTick: true });

        const result = await mgr.submitOrder(makeLimitBuyParams({ limitPrice: price }));

        expect(result.status).toBe('FILLED');
        expect(mgr.getWorkingOrders()).toHaveLength(0);
        mgr.destroy();
      }),
      { numRuns: 200 },
    );
  });

  test('onFill fires exactly once per fill with correct data', () => {
    fc.assert(
      fc.asyncProperty(
        arbLimitPrice,
        fc.integer({ min: 1, max: 10 }),
        async (fillPrice, tickCount) => {
          const fills: Array<{ orderId: string; price: number }> = [];
          const { broker, statusMap } = makeMockBroker();
          const mgr = new OrderManager({
            broker,
            clock: () => T0,
            onFill: (order) => { fills.push({ orderId: order.orderId, price: order.filledPrice }); },
            manualTick: true,
          });

          const result = await mgr.submitOrder(makeLimitBuyParams());
          const orderId = result.orderId;

          // Broker reports filled on first status check
          const fillTs = T0.toISOString();
          statusMap.set(orderId, { status: 'FILLED', filledPrice: fillPrice, fillTimestamp: fillTs });

          // Tick multiple times — fill should only fire once
          for (let i = 0; i < tickCount; i++) {
            await mgr.tick(timeAfter(i + 1));
          }

          expect(fills).toHaveLength(1);
          expect(fills[0].orderId).toBe(orderId);
          expect(fills[0].price).toBe(fillPrice);
          mgr.destroy();
        },
      ),
      { numRuns: 500 },
    );
  });

  test('fill callback receives FILLED status with filledPrice and filledAt', () => {
    fc.assert(
      fc.asyncProperty(arbLimitPrice, async (fillPrice) => {
        let captured: any = null;
        const { broker, statusMap } = makeMockBroker();
        const mgr = new OrderManager({
          broker,
          clock: () => T0,
          onFill: (order) => { captured = order; },
          manualTick: true,
        });

        const result = await mgr.submitOrder(makeLimitBuyParams());
        const fillTs = timeAfter(5).toISOString();
        statusMap.set(result.orderId, { status: 'FILLED', filledPrice: fillPrice, fillTimestamp: fillTs });
        await mgr.tick(timeAfter(5));

        expect(captured).not.toBeNull();
        expect(captured.status).toBe('FILLED');
        expect(captured.filledPrice).toBe(fillPrice);
        expect(captured.filledAt).toEqual(new Date(fillTs));
        mgr.destroy();
      }),
      { numRuns: 200 },
    );
  });

  test('fills are detected before auto-cancel can fire', () => {
    fc.assert(
      fc.asyncProperty(arbLimitPrice, async (fillPrice) => {
        let fillFired = false;
        let cancelFired = false;
        const { broker, statusMap } = makeMockBroker();
        const mgr = new OrderManager({
          broker,
          clock: () => T0,
          onFill: () => { fillFired = true; },
          onCancel: () => { cancelFired = true; },
          manualTick: true,
        });

        // cancelAfterSec=10, but we tick at T+20 — timeout expired
        const result = await mgr.submitOrder(makeLimitBuyParams({ cancelAfterSec: 10 }));
        // Broker reports filled (e.g. SimBroker filled via advanceTo before tick ran)
        statusMap.set(result.orderId, { status: 'FILLED', filledPrice: fillPrice, fillTimestamp: timeAfter(15).toISOString() });
        await mgr.tick(timeAfter(20));

        expect(fillFired).toBe(true);
        expect(cancelFired).toBe(false);
        mgr.destroy();
      }),
      { numRuns: 200 },
    );
  });

  test('working orders drain to zero after all fill/cancel', () => {
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (n) => {
          const { broker, statusMap } = makeMockBroker();
          const mgr = new OrderManager({ broker, clock: () => T0, manualTick: true });

          const orderIds: string[] = [];
          for (let i = 0; i < n; i++) {
            const result = await mgr.submitOrder(makeLimitBuyParams());
            orderIds.push(result.orderId);
          }
          expect(mgr.getWorkingOrders()).toHaveLength(n);

          // Fill all of them
          for (const id of orderIds) {
            statusMap.set(id, { status: 'FILLED', filledPrice: 100, fillTimestamp: timeAfter(1).toISOString() });
          }
          await mgr.tick(timeAfter(1));

          expect(mgr.getWorkingOrders()).toHaveLength(0);
          mgr.destroy();
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('OrderManager auto-cancel properties', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test('auto-cancel fires at or after cancelAfterSec boundary', () => {
    fc.assert(
      fc.asyncProperty(arbCancelAfterSec, arbElapsedSec, async (cancelAfter, elapsed) => {
        let cancelFired = false;
        const { broker } = makeMockBroker();
        const mgr = new OrderManager({
          broker,
          clock: () => T0,
          onCancel: () => { cancelFired = true; },
          manualTick: true,
        });

        await mgr.submitOrder(makeLimitBuyParams({ cancelAfterSec: cancelAfter }));
        await mgr.tick(timeAfter(elapsed));

        if (elapsed >= cancelAfter) {
          expect(cancelFired).toBe(true);
        } else {
          expect(cancelFired).toBe(false);
        }
        mgr.destroy();
      }),
      { numRuns: 500 },
    );
  });

  test('cancel callback receives CANCELLED status with cancelledAt', () => {
    fc.assert(
      fc.asyncProperty(arbCancelAfterSec, async (cancelAfter) => {
        let captured: any = null;
        const { broker } = makeMockBroker();
        const mgr = new OrderManager({
          broker,
          clock: () => T0,
          onCancel: (order) => { captured = order; },
          manualTick: true,
        });

        await mgr.submitOrder(makeLimitBuyParams({ cancelAfterSec: cancelAfter }));
        const tickTime = timeAfter(cancelAfter + 1);
        await mgr.tick(tickTime);

        expect(captured).not.toBeNull();
        expect(captured.status).toBe('CANCELLED');
        expect(captured.cancelledAt).toEqual(tickTime);
        mgr.destroy();
      }),
      { numRuns: 200 },
    );
  });

  test('cancelAfterSec: 0 cancels on the very first tick', async () => {
    let cancelFired = false;
    const { broker } = makeMockBroker();
    const mgr = new OrderManager({
      broker,
      clock: () => T0,
      onCancel: () => { cancelFired = true; },
      manualTick: true,
    });

    await mgr.submitOrder(makeLimitBuyParams({ cancelAfterSec: 0 }));
    await mgr.tick(T0); // elapsed = 0, which is >= 0

    expect(cancelFired).toBe(true);
    expect(mgr.getWorkingOrders()).toHaveLength(0);
    mgr.destroy();
  });

  test('broker-reported CANCELLED triggers onCancel without auto-cancel', () => {
    fc.assert(
      fc.asyncProperty(arbCancelAfterSec, async () => {
        let cancelFired = false;
        const { broker, statusMap } = makeMockBroker();
        const mgr = new OrderManager({
          broker,
          clock: () => T0,
          onCancel: () => { cancelFired = true; },
          manualTick: true,
        });

        const result = await mgr.submitOrder(makeLimitBuyParams({ cancelAfterSec: 9999 }));
        // Broker externally cancels before timeout
        statusMap.set(result.orderId, { status: 'CANCELLED' });
        await mgr.tick(timeAfter(1));

        expect(cancelFired).toBe(true);
        expect(mgr.getWorkingOrders()).toHaveLength(0);
        mgr.destroy();
      }),
      { numRuns: 100 },
    );
  });
});

describe('OrderManager price chase properties', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test('BUY chases UP monotonically', () => {
    fc.assert(
      fc.asyncProperty(arbLimitPrice, arbStepAmount, arbIntervalSec, async (limitPrice, stepAmount, intervalSec) => {
        const { broker } = makeMockBroker();
        const mgr = new OrderManager({ broker, clock: () => T0, manualTick: true });

        await mgr.submitOrder(makeLimitBuyParams({
          limitPrice,
          cancelAfterSec: 9999,
          adjustmentRules: [{ type: 'PRICE_CHASE', stepAmount, intervalSec }],
        }));

        const prices: number[] = [limitPrice];
        for (let i = 1; i <= 5; i++) {
          await mgr.tick(timeAfter(i * intervalSec));
          const wo = mgr.getWorkingOrders()[0];
          if (wo) prices.push(wo.currentLimitPrice);
        }

        // Each price should be >= the previous (monotonically increasing)
        for (let i = 1; i < prices.length; i++) {
          expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
        }
        mgr.destroy();
      }),
      { numRuns: 500 },
    );
  });

  test('SELL chases DOWN monotonically', () => {
    fc.assert(
      fc.asyncProperty(arbLimitPrice, arbStepAmount, arbIntervalSec, async (limitPrice, stepAmount, intervalSec) => {
        const { broker } = makeMockBroker();
        const mgr = new OrderManager({ broker, clock: () => T0, manualTick: true });

        await mgr.submitOrder(makeLimitSellParams({
          limitPrice,
          cancelAfterSec: 9999,
          adjustmentRules: [{ type: 'PRICE_CHASE', stepAmount, intervalSec }],
        }));

        const prices: number[] = [limitPrice];
        for (let i = 1; i <= 5; i++) {
          await mgr.tick(timeAfter(i * intervalSec));
          const wo = mgr.getWorkingOrders()[0];
          if (wo) prices.push(wo.currentLimitPrice);
        }

        // Each price should be <= the previous (monotonically decreasing)
        for (let i = 1; i < prices.length; i++) {
          expect(prices[i]).toBeLessThanOrEqual(prices[i - 1]);
        }
        mgr.destroy();
      }),
      { numRuns: 500 },
    );
  });

  test('adjustmentCount never exceeds maxSteps', () => {
    fc.assert(
      fc.asyncProperty(arbMaxSteps, arbStepAmount, arbIntervalSec, async (maxSteps, stepAmount, intervalSec) => {
        const { broker } = makeMockBroker();
        const mgr = new OrderManager({ broker, clock: () => T0, manualTick: true });

        await mgr.submitOrder(makeLimitBuyParams({
          cancelAfterSec: 9999,
          adjustmentRules: [{ type: 'PRICE_CHASE', stepAmount, intervalSec, maxSteps }],
        }));

        // Tick enough times to exceed maxSteps if the limit weren't enforced
        for (let i = 1; i <= maxSteps + 5; i++) {
          await mgr.tick(timeAfter(i * intervalSec));
        }

        const wo = mgr.getWorkingOrders()[0];
        if (wo) {
          expect(wo.adjustmentCount).toBeLessThanOrEqual(maxSteps);
        }
        mgr.destroy();
      }),
      { numRuns: 500 },
    );
  });

  test('maxSteps: 0 means zero adjustments', async () => {
    const { broker } = makeMockBroker();
    const mgr = new OrderManager({ broker, clock: () => T0, manualTick: true });

    await mgr.submitOrder(makeLimitBuyParams({
      limitPrice: 100,
      cancelAfterSec: 9999,
      adjustmentRules: [{ type: 'PRICE_CHASE', stepAmount: 0.05, intervalSec: 5, maxSteps: 0 }],
    }));

    // Tick multiple times
    for (let i = 1; i <= 10; i++) {
      await mgr.tick(timeAfter(i * 5));
    }

    const wo = mgr.getWorkingOrders()[0]!;
    expect(wo.adjustmentCount).toBe(0);
    expect(wo.currentLimitPrice).toBe(100);
    expect(broker.modifyOrder).not.toHaveBeenCalled();
    mgr.destroy();
  });

  test('price chase interval is respected — no adjustment before intervalSec', () => {
    fc.assert(
      fc.asyncProperty(arbStepAmount, arbIntervalSec, async (stepAmount, intervalSec) => {
        const { broker } = makeMockBroker();
        const mgr = new OrderManager({ broker, clock: () => T0, manualTick: true });

        await mgr.submitOrder(makeLimitBuyParams({
          limitPrice: 100,
          cancelAfterSec: 9999,
          adjustmentRules: [{ type: 'PRICE_CHASE', stepAmount, intervalSec }],
        }));

        // Tick just before the interval
        if (intervalSec > 1) {
          await mgr.tick(timeAfter(intervalSec - 1));
          const wo = mgr.getWorkingOrders()[0]!;
          expect(wo.adjustmentCount).toBe(0);
        }

        // Tick at the interval — should adjust
        await mgr.tick(timeAfter(intervalSec));
        const wo = mgr.getWorkingOrders()[0]!;
        expect(wo.adjustmentCount).toBe(1);

        mgr.destroy();
      }),
      { numRuns: 200 },
    );
  });

  test('price chase prices are always rounded to cents', () => {
    fc.assert(
      fc.asyncProperty(arbLimitPrice, arbStepAmount, arbIntervalSec, async (limitPrice, stepAmount, intervalSec) => {
        const { broker } = makeMockBroker();
        const mgr = new OrderManager({ broker, clock: () => T0, manualTick: true });

        await mgr.submitOrder(makeLimitBuyParams({
          limitPrice,
          cancelAfterSec: 9999,
          adjustmentRules: [{ type: 'PRICE_CHASE', stepAmount, intervalSec }],
        }));

        for (let i = 1; i <= 5; i++) {
          await mgr.tick(timeAfter(i * intervalSec));
          const wo = mgr.getWorkingOrders()[0];
          if (wo) {
            expect(wo.currentLimitPrice).toBe(roundCents(wo.currentLimitPrice));
          }
        }
        mgr.destroy();
      }),
      { numRuns: 500 },
    );
  });

  test('each chase step is exactly roundCents(previous + stepAmount) for BUY', () => {
    fc.assert(
      fc.asyncProperty(arbLimitPrice, arbStepAmount, arbIntervalSec, async (limitPrice, stepAmount, intervalSec) => {
        const { broker } = makeMockBroker();
        const mgr = new OrderManager({ broker, clock: () => T0, manualTick: true });

        await mgr.submitOrder(makeLimitBuyParams({
          limitPrice,
          cancelAfterSec: 9999,
          adjustmentRules: [{ type: 'PRICE_CHASE', stepAmount, intervalSec }],
        }));

        let prevPrice = limitPrice;
        for (let i = 1; i <= 3; i++) {
          await mgr.tick(timeAfter(i * intervalSec));
          const wo = mgr.getWorkingOrders()[0];
          if (wo) {
            const expected = roundCents(prevPrice + stepAmount);
            expect(wo.currentLimitPrice).toBe(expected);
            prevPrice = wo.currentLimitPrice;
          }
        }
        mgr.destroy();
      }),
      { numRuns: 500 },
    );
  });
});

describe('OrderManager concurrent order properties', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test('mixed fill/cancel/open in a single tick — each order gets exactly its correct callback', () => {
    fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        async (n) => {
          const fillIds: string[] = [];
          const cancelIds: string[] = [];
          const { broker, statusMap } = makeMockBroker();
          const mgr = new OrderManager({
            broker,
            clock: () => T0,
            onFill: (order) => { fillIds.push(order.orderId); },
            onCancel: (order) => cancelIds.push(order.orderId),
            manualTick: true,
          });

          const orderIds: string[] = [];
          for (let i = 0; i < n; i++) {
            const result = await mgr.submitOrder(makeLimitBuyParams());
            orderIds.push(result.orderId);
          }

          // Assign outcomes: even indexes fill, odd indexes cancel, last stays open
          const expectedFills: string[] = [];
          const expectedCancels: string[] = [];
          for (let i = 0; i < orderIds.length; i++) {
            if (i === orderIds.length - 1 && orderIds.length > 2) {
              // Leave the last order open (no status override — stays OPEN)
              continue;
            }
            if (i % 2 === 0) {
              statusMap.set(orderIds[i], { status: 'FILLED', filledPrice: 100, fillTimestamp: timeAfter(5).toISOString() });
              expectedFills.push(orderIds[i]);
            } else {
              statusMap.set(orderIds[i], { status: 'CANCELLED' });
              expectedCancels.push(orderIds[i]);
            }
          }

          await mgr.tick(timeAfter(5));

          // Exactly the right callbacks fired
          expect(fillIds.sort()).toEqual(expectedFills.sort());
          expect(cancelIds.sort()).toEqual(expectedCancels.sort());

          // Working orders = only the ones left open
          const stillOpen = orderIds.length > 2 ? 1 : 0;
          expect(mgr.getWorkingOrders()).toHaveLength(stillOpen);
          mgr.destroy();
        },
      ),
      { numRuns: 200 },
    );
  });

  test('REJECTED status triggers onCancel (same as CANCELLED)', () => {
    fc.assert(
      fc.asyncProperty(arbLimitPrice, async () => {
        let cancelFired = false;
        let fillFired = false;
        let capturedStatus: string | undefined;
        const { broker, statusMap } = makeMockBroker();
        const mgr = new OrderManager({
          broker,
          clock: () => T0,
          onFill: () => { fillFired = true; },
          onCancel: (order) => { cancelFired = true; capturedStatus = order.status; },
          manualTick: true,
        });

        const result = await mgr.submitOrder(makeLimitBuyParams());
        statusMap.set(result.orderId, { status: 'REJECTED' });
        await mgr.tick(timeAfter(1));

        expect(cancelFired).toBe(true);
        expect(fillFired).toBe(false);
        expect(capturedStatus).toBe('REJECTED');
        expect(mgr.getWorkingOrders()).toHaveLength(0);
        mgr.destroy();
      }),
      { numRuns: 100 },
    );
  });

  test('each chase step is exactly roundCents(previous - stepAmount) for SELL', () => {
    fc.assert(
      fc.asyncProperty(arbLimitPrice, arbStepAmount, arbIntervalSec, async (limitPrice, stepAmount, intervalSec) => {
        const { broker } = makeMockBroker();
        const mgr = new OrderManager({ broker, clock: () => T0, manualTick: true });

        await mgr.submitOrder(makeLimitSellParams({
          limitPrice,
          cancelAfterSec: 9999,
          adjustmentRules: [{ type: 'PRICE_CHASE', stepAmount, intervalSec }],
        }));

        let prevPrice = limitPrice;
        for (let i = 1; i <= 3; i++) {
          await mgr.tick(timeAfter(i * intervalSec));
          const wo = mgr.getWorkingOrders()[0];
          if (wo) {
            const expected = roundCents(prevPrice - stepAmount);
            expect(wo.currentLimitPrice).toBe(expected);
            prevPrice = wo.currentLimitPrice;
          }
        }
        mgr.destroy();
      }),
      { numRuns: 500 },
    );
  });
});

describe('OrderManager guard rails — no silent fallbacks', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test('throws if broker reports FILLED without a fillTimestamp', async () => {
    const { broker, statusMap } = makeMockBroker();
    const mgr = new OrderManager({ broker, clock: () => T0, manualTick: true });

    const result = await mgr.submitOrder(makeLimitBuyParams());
    // FILLED but no fillTimestamp
    statusMap.set(result.orderId, { status: 'FILLED', filledPrice: 100 });

    await expect(mgr.tick(timeAfter(1))).rejects.toThrow('fillTimestamp');
    mgr.destroy();
  });

  test('throws if LIMIT order reaches tracking without a limitPrice', async () => {
    const { broker } = makeMockBroker();
    const mgr = new OrderManager({ broker, clock: () => T0, manualTick: true });

    // Construct a LIMIT order with cancelAfterSec (so it's tracked) but no limitPrice
    await expect(
      mgr.submitOrder({
        symbol: 'SPY',
        strategy: 'STOCK',
        direction: 'LONG',
        legs: [{ symbol: 'SPY', strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'BUY', quantity: 1 }],
        orderType: 'LIMIT',
        cancelAfterSec: 60,
      }),
    ).rejects.toThrow('limitPrice');
    mgr.destroy();
  });
});
