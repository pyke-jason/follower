/**
 * Broker selection from env vars.
 * Single source of truth for runtime channel configuration.
 *
 * Brokers are memoized per process. Each broker holds per-instance state
 * (in-flight request coalescing, alert TTL maps, order ID sequences) that
 * MUST be shared across all consumers within the same process. Recreating
 * the broker on every call defeats coalescing and pings IBKR redundantly.
 */
import { createIbkrService } from './ibkr/client.js';
import { getRuntimeChannelDefinitions } from '../lib/runtime-channels.js';
import type { RuntimeChannelDefinition } from '../lib/runtime-channels.js';
import type { BrokerService } from './interface.js';

export type RuntimeChannelService = RuntimeChannelDefinition & {
  broker: BrokerService;
};

let cachedServices: RuntimeChannelService[] | null = null;

export function getRuntimeChannelServices(): RuntimeChannelService[] {
  if (cachedServices) return cachedServices;
  cachedServices = getRuntimeChannelDefinitions().map((def) => ({
    ...def,
    broker: createIbkrService({
      accountId: def.accountId,
      sidecarUrl: def.sidecarUrl ?? 'http://localhost:8090/api',
    }),
  }));
  return cachedServices;
}

let cachedBrokerMap: Map<string, BrokerService> | null = null;

export function getRuntimeBrokerMap(): Map<string, BrokerService> {
  if (cachedBrokerMap) return cachedBrokerMap;
  cachedBrokerMap = new Map(getRuntimeChannelServices().map((item) => [item.channelId, item.broker]));
  return cachedBrokerMap;
}
