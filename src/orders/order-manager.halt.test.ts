import { describe, it, expect, afterEach } from 'vitest';
import { OrderManager } from './order-manager.js';
import { TradingHaltedError } from '../lib/errors.js';
import { setHalt, clearHalt } from '../lib/halt-state.js';
import type { BrokerService } from '../broker/interface.js';
import type { OrderResult } from '../broker/types.js';

const noop = async () => {};

function makeStubBroker(): BrokerService {
  return {
    getQuote: async () => ({ symbol: 'SPY', bid: 1, ask: 1, last: 1, volume: 0, timestamp: '' }),
    placeOrder: async (): Promise<OrderResult> => ({ orderId: 'test-1', status: 'OPEN' }),
    modifyOrder: async (): Promise<OrderResult> => ({ orderId: 'test-1', status: 'OPEN' }),
    cancelOrder: async (): Promise<OrderResult> => ({ orderId: 'test-1', status: 'CANCELLED' }),
    cancelAllOrders: async () => {},
    getOrderStatus: async (): Promise<OrderResult> => ({ orderId: 'test-1', status: 'OPEN' }),
    getPositions: async () => [],
    getAccountBalance: async () => ({
      accountId: 'test',
      cashBalance: 0,
      buyingPower: 0,
      equity: 0,
      marketValue: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
      timestamp: '',
    }),
    isHealthy: async () => true,
    placeStopOrder: async (): Promise<OrderResult> => ({ orderId: 'test-stop', status: 'OPEN' }),
  };
}

function makeOrderManager(haltCheck?: () => boolean) {
  return new OrderManager({
    broker: makeStubBroker(),
    clock: () => new Date(),
    onFill: noop,
    onCancel: noop,
    onAdjust: noop,
    manualTick: true,
    haltCheck,
  });
}

const marketOrder = {
  symbol: 'SPY',
  strategy: 'STOCK' as const,
  direction: 'LONG' as const,
  legs: [{ symbol: 'SPY', type: 'STOCK' as const, action: 'BUY' as const, quantity: 1, strike: 0, expiry: '' }],
  orderType: 'MARKET' as const,
  isClosing: false,
};

describe('OrderManager halt check', () => {
  afterEach(() => {
    clearHalt();
  });

  it('passes through when haltCheck is not wired', async () => {
    const om = makeOrderManager();
    const result = await om.submitOrder(marketOrder);
    expect(result.status).toBe('OPEN');
  });

  it('passes through when haltCheck returns false', async () => {
    const om = makeOrderManager(() => false);
    const result = await om.submitOrder(marketOrder);
    expect(result.status).toBe('OPEN');
  });

  it('throws TradingHaltedError when haltCheck returns true', async () => {
    const om = makeOrderManager(() => true);
    await expect(om.submitOrder(marketOrder)).rejects.toThrow(TradingHaltedError);
  });

  it('blocks orders after setHalt() with real isHalted check', async () => {
    const { isHalted } = await import('../lib/halt-state.js');
    const om = makeOrderManager(isHalted);

    // Before halt — should succeed
    const before = await om.submitOrder(marketOrder);
    expect(before.status).toBe('OPEN');

    // Activate kill switch
    setHalt('test halt', 'system');

    // After halt — should throw
    await expect(om.submitOrder(marketOrder)).rejects.toThrow(TradingHaltedError);
    await expect(om.submitOrder(marketOrder)).rejects.toThrow('Kill switch is active');
  });

  it('allows orders again after clearHalt()', async () => {
    const { isHalted } = await import('../lib/halt-state.js');
    const om = makeOrderManager(isHalted);

    setHalt('temp halt', 'system');
    await expect(om.submitOrder(marketOrder)).rejects.toThrow(TradingHaltedError);

    clearHalt();
    const result = await om.submitOrder(marketOrder);
    expect(result.status).toBe('OPEN');
  });
});
