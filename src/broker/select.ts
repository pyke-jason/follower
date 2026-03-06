/**
 * Broker selection from env vars.
 * Single source of truth for runtime channel configuration.
 */
import { tsService } from './tradestation/index.js';
import { createIbkrService } from './ibkr/client.js';
import { getRuntimeChannelDefinitions } from '../lib/runtime-channels.js';
import type { RuntimeChannelDefinition } from '../lib/runtime-channels.js';
import type { BrokerService } from './interface.js';

export type RuntimeChannelService = RuntimeChannelDefinition & {
  broker: BrokerService;
};

function createBroker(def: RuntimeChannelDefinition): BrokerService {
  if (def.brokerName === 'ibkr') {
    return createIbkrService({
      accountId: def.accountId,
      sidecarUrl: def.sidecarUrl ?? 'http://localhost:8090/api',
    });
  }
  return tsService;
}

export function getRuntimeChannelServices(): RuntimeChannelService[] {
  return getRuntimeChannelDefinitions().map((def) => ({
    ...def,
    broker: createBroker(def),
  }));
}

export function getRuntimeBrokerMap(): Map<string, BrokerService> {
  return new Map(getRuntimeChannelServices().map((item) => [item.channelId, item.broker]));
}
