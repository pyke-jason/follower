/**
 * Broker selection from env vars.
 * Single source of truth for runtime channel configuration.
 */
import { createIbkrService } from './ibkr/client.js';
import { getRuntimeChannelDefinitions } from '../lib/runtime-channels.js';
import type { RuntimeChannelDefinition } from '../lib/runtime-channels.js';
import type { BrokerService } from './interface.js';

export type RuntimeChannelService = RuntimeChannelDefinition & {
  broker: BrokerService;
};

export function getRuntimeChannelServices(): RuntimeChannelService[] {
  return getRuntimeChannelDefinitions().map((def) => ({
    ...def,
    broker: createIbkrService({
      accountId: def.accountId,
      sidecarUrl: def.sidecarUrl ?? 'http://localhost:8090/api',
    }),
  }));
}

export function getRuntimeBrokerMap(): Map<string, BrokerService> {
  return new Map(getRuntimeChannelServices().map((item) => [item.channelId, item.broker]));
}
