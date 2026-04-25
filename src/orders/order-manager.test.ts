/**
 * OrderManager regression tests for live-trading edge cases.
 *
 * These tests reproduce two bugs confirmed before the 2026-04-24 go-live:
 *  1. cancel/fill race (MU PUT scenario) — cancelOrder() return value was ignored
 *  2. PENDING (Inactive) order handling — after-hours orders were never polled
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { OrderManager } from './order-manager.js';
import type { BrokerService } from '../broker/interface.js';
import type { FilledWorkingOrder, WorkingOrder, WorkingOrderParams } from '../broker/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

function optionOpenParams(overrides: Partial<WorkingOrderParams> = {}): WorkingOrderParams {
  return {
    symbol: 'MU',
    strategy: 'PUT',
    direction: 'LONG',
    legs: [{
      symbol: 'MU 260516P55',
      strike: 55,
      expiry: '20260516',
      type: 'PUT',
      action: 'BUY',
      quantity: 1,
    }],
    orderType: 'LIMIT',
    limitPrice: 1.50,
    isClosing: false,
    adjustmentRules: [{
      type: 'PRICE_CHASE',
      stepAmount: 0.05,
      intervalSec: 5,
      maxSteps: 10,
      chaseLimit: 2.25,
    }],
    cancelAfterSec: 60,
    ...overrides,
  };
}

function makeBroker(overrides: Partial<BrokerService> = {}): BrokerService {
  return {
    getQuote: vi.fn(),
    placeOrder: vi.fn().mockResolvedValue({ orderId: 'order-001', status: 'OPEN' }),
    modifyOrder: vi.fn().mockResolvedValue({ orderId: 'order-001', status: 'OPEN' }),
    cancelOrder: vi.fn().mockResolvedValue({ orderId: 'order-001', status: 'CANCELLED' }),
    getOrderStatus: vi.fn().mockResolvedValue({ orderId: 'order-001', status: 'OPEN' }),
    getPositions: vi.fn(),
    getAccountBalance: vi.fn(),
    isHealthy: vi.fn(),
    cancelAllOrders: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeManager(broker: BrokerService, clock: () => Date, callbacks: {
  onFill?: (o: FilledWorkingOrder) => void;
  onCancel?: (o: WorkingOrder) => void;
  onAdjust?: (o: WorkingOrder, from: number, to: number, step: number) => void;
}): OrderManager {
  return new OrderManager({
    broker,
    clock,
    onFill: callbacks.onFill ?? vi.fn(),
    onCancel: callbacks.onCancel ?? vi.fn(),
    onAdjust: callbacks.onAdjust ?? vi.fn(),
    manualTick: true,
  });
}

// ── Bug 1: cancel/fill race ───────────────────────────────────────────
// Regression for the MU PUT incident: an order fills just before the
// bot's auto-cancel fires. The cancelOrder() response reports FILLED,
// but the old code ignored it and called onCancel anyway — leaving a
// live position at IBKR with no DB trade record.

describe('OrderManager — cancel/fill race (MU PUT scenario)', () => {
  test('fill detected via cancelOrder() response → onFill fires, onCancel does not', async () => {
    const onFill = vi.fn();
    const onCancel = vi.fn();

    let now = new Date('2026-04-24T10:00:00Z');
    const broker = makeBroker({
      getOrderStatus: vi.fn().mockResolvedValue({ orderId: 'order-001', status: 'OPEN' }),
      cancelOrder: vi.fn().mockResolvedValue({
        orderId: 'order-001',
        status: 'FILLED',
        filledPrice: 1.52,
        filledQuantity: 1,
        commission: 0.65,
        fillTimestamp: '2026-04-24T10:01:01.000Z',
      }),
    });

    const mgr = makeManager(broker, () => now, { onFill, onCancel });
    await mgr.submitOrder(optionOpenParams());

    // Advance past cancelAfterSec threshold (61 s)
    now = new Date(now.getTime() + 61_000);
    await mgr.tick(now);

    expect(onFill).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();

    const filled = onFill.mock.calls[0][0] as FilledWorkingOrder;
    expect(filled.status).toBe('FILLED');
    expect(filled.filledPrice).toBe(1.52);
    expect(filled.fillTimestamp).toBe('2026-04-24T10:01:01.000Z');
  });

  test('clean cancel (no race) → onCancel fires, onFill does not', async () => {
    const onFill = vi.fn();
    const onCancel = vi.fn();

    let now = new Date('2026-04-24T10:00:00Z');
    const broker = makeBroker({
      getOrderStatus: vi.fn().mockResolvedValue({ orderId: 'order-001', status: 'OPEN' }),
      cancelOrder: vi.fn().mockResolvedValue({ orderId: 'order-001', status: 'CANCELLED' }),
    });

    const mgr = makeManager(broker, () => now, { onFill, onCancel });
    await mgr.submitOrder(optionOpenParams());

    now = new Date(now.getTime() + 61_000);
    await mgr.tick(now);

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onFill).not.toHaveBeenCalled();
  });

  test('fill returned from cancelOrder is removed from workingOrders (no double-fire)', async () => {
    const onFill = vi.fn();
    let now = new Date('2026-04-24T10:00:00Z');

    const broker = makeBroker({
      getOrderStatus: vi.fn().mockResolvedValue({ orderId: 'order-001', status: 'OPEN' }),
      cancelOrder: vi.fn().mockResolvedValue({
        orderId: 'order-001',
        status: 'FILLED',
        filledPrice: 1.55,
        filledQuantity: 1,
        fillTimestamp: '2026-04-24T10:01:01.000Z',
      }),
    });

    const mgr = makeManager(broker, () => now, { onFill });
    await mgr.submitOrder(optionOpenParams());

    now = new Date(now.getTime() + 61_000);
    await mgr.tick(now);
    // Second tick should not call onFill again (order removed from workingOrders)
    await mgr.tick(now);

    expect(onFill).toHaveBeenCalledOnce();
    expect(mgr.getWorkingOrders()).toHaveLength(0);
  });
});

// ── Bug 2: PENDING (Inactive) orders ─────────────────────────────────
// Regression for the after-hours order tracking gap: IBKR returns
// `Inactive` status (mapped to `PENDING`) for GTC orders placed outside
// RTH. The old code's tick() check `if (order.status !== 'OPEN') continue`
// silently skipped these orders forever, so they were never polled and
// fills became orphans.

describe('OrderManager — PENDING (Inactive/after-hours) order tracking', () => {
  test('PENDING order is polled in tick() — getOrderStatus called', async () => {
    const getOrderStatus = vi.fn().mockResolvedValue({ orderId: 'order-002', status: 'PENDING' });
    const broker = makeBroker({
      placeOrder: vi.fn().mockResolvedValue({ orderId: 'order-002', status: 'PENDING' }),
      getOrderStatus,
    });

    const now = new Date('2026-04-24T20:00:00Z');
    const mgr = makeManager(broker, () => now, {});
    await mgr.submitOrder(optionOpenParams({ cancelAfterSec: undefined }));

    await mgr.tick(now);
    expect(getOrderStatus).toHaveBeenCalledWith('order-002');
  });

  test('PENDING → OPEN transition resets placedAt so cancelAfterSec starts fresh', async () => {
    const onCancel = vi.fn();
    const onFill = vi.fn();

    // Order placed at 8pm; market opens at 9:30am next day
    const placedAt = new Date('2026-04-24T20:00:00Z');
    const marketOpen = new Date('2026-04-25T13:30:00Z'); // 9:30am ET in UTC

    const getOrderStatus = vi.fn()
      .mockResolvedValueOnce({ orderId: 'order-002', status: 'PENDING' })   // 1st tick: still inactive
      .mockResolvedValueOnce({ orderId: 'order-002', status: 'OPEN' })      // 2nd tick: now submitted
      .mockResolvedValue({ orderId: 'order-002', status: 'OPEN' });         // subsequent ticks

    const broker = makeBroker({
      placeOrder: vi.fn().mockResolvedValue({ orderId: 'order-002', status: 'PENDING' }),
      getOrderStatus,
      cancelOrder: vi.fn().mockResolvedValue({ orderId: 'order-002', status: 'CANCELLED' }),
    });

    let now = placedAt;
    const mgr = makeManager(broker, () => now, { onCancel, onFill });

    // Place the order after hours — status comes back PENDING
    await mgr.submitOrder(optionOpenParams({ cancelAfterSec: 60 }));

    // Tick before market open — still PENDING, nothing cancelled
    now = new Date(placedAt.getTime() + 1_000);
    await mgr.tick(now);
    expect(onCancel).not.toHaveBeenCalled();

    // Tick at market open — transitions PENDING → OPEN, placedAt resets
    now = marketOpen;
    await mgr.tick(now);
    expect(onCancel).not.toHaveBeenCalled(); // cancelAfterSec restarts from now

    // Tick 30s after market open — only 30s elapsed since activation, no cancel yet
    now = new Date(marketOpen.getTime() + 30_000);
    await mgr.tick(now);
    expect(onCancel).not.toHaveBeenCalled();

    // Tick 61s after market open — now cancelAfterSec fires
    now = new Date(marketOpen.getTime() + 61_000);
    await mgr.tick(now);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onFill).not.toHaveBeenCalled();
  });

  test('PENDING order fills when market opens — onFill fires correctly', async () => {
    const onFill = vi.fn();
    const onCancel = vi.fn();

    const now = new Date('2026-04-24T20:00:00Z');
    const getOrderStatus = vi.fn()
      .mockResolvedValueOnce({ orderId: 'order-002', status: 'PENDING' })
      .mockResolvedValueOnce({
        orderId: 'order-002',
        status: 'FILLED',
        filledPrice: 1.50,
        filledQuantity: 1,
        fillTimestamp: '2026-04-25T13:30:15.000Z',
      });

    const broker = makeBroker({
      placeOrder: vi.fn().mockResolvedValue({ orderId: 'order-002', status: 'PENDING' }),
      getOrderStatus,
    });

    const mgr = makeManager(broker, () => now, { onFill, onCancel });
    await mgr.submitOrder(optionOpenParams({ cancelAfterSec: undefined }));

    // First tick: still PENDING
    await mgr.tick(now);
    expect(onFill).not.toHaveBeenCalled();

    // Second tick: fills
    await mgr.tick(now);
    expect(onFill).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();

    const filled = onFill.mock.calls[0][0] as FilledWorkingOrder;
    expect(filled.filledPrice).toBe(1.50);
    expect(mgr.getWorkingOrders()).toHaveLength(0);
  });
});
