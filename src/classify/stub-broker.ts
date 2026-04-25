/**
 * Stub broker for classify runs — no execution side effects.
 *
 * The orchestrator's `buildContext()` only ever calls `env.broker.getQuote(s)`.
 * A zero-filled Quote short-circuits any open-path pricing logic; if the
 * orchestrator ever grows another broker dependency, the stub throws loudly
 * rather than silently returning bogus data.
 */

import type { BrokerService } from '@/broker/interface.js';
import type { Quote } from '@/broker/types.js';

function unsupported(method: string): never {
  throw new Error(`BrokerService.${method} is not supported in classify runs`);
}

export const STUB_BROKER: BrokerService = {
  getQuote: async (symbol: string): Promise<Quote> => ({
    symbol,
    bid: 0,
    ask: 0,
    last: 0,
    volume: 0,
    timestamp: new Date().toISOString(),
  }),
  placeOrder: async () => unsupported('placeOrder'),
  modifyOrder: async () => unsupported('modifyOrder'),
  cancelOrder: async () => unsupported('cancelOrder'),
  getOrderStatus: async () => unsupported('getOrderStatus'),
  getPositions: async () => unsupported('getPositions'),
  getAccountBalance: async () => unsupported('getAccountBalance'),
  isHealthy: async () => true,
  placeStopOrder: async () => unsupported('placeStopOrder'),
};
