/**
 * Broker selection from env vars.
 * Single source of truth — used by runner.ts, server.ts, and index.ts.
 */
import { tsService } from './tradestation/index.js';
import { ibkrService } from './ibkr/index.js';
import { liveChannel } from '../lib/channel.js';
import type { BrokerService } from './interface.js';

export function selectBroker(): { broker: BrokerService; channelId: string } {
  const brokerName = process.env.BROKER ?? 'tradestation';
  if (brokerName === 'ibkr') {
    const accountId = process.env.IBKR_ACCOUNT_ID;
    if (!accountId) throw new Error('Missing IBKR_ACCOUNT_ID');
    return { broker: ibkrService, channelId: liveChannel(accountId) };
  }
  if (brokerName === 'tradestation') {
    const accountId = process.env.TS_ACCOUNT_ID;
    if (!accountId) throw new Error('Missing TS_ACCOUNT_ID');
    return { broker: tsService, channelId: liveChannel(accountId) };
  }
  throw new Error(`Unknown BROKER env value: "${brokerName}" (expected "ibkr" or "tradestation")`);
}
