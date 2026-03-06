import { ibkrChannel, tradestationChannel } from './channel.js';

export type RuntimeBrokerName = 'ibkr' | 'tradestation';

export type RuntimeChannelDefinition = {
  channelId: string;
  brokerName: RuntimeBrokerName;
  mode: 'live' | 'paper';
  accountId: string;
  label: string;
  sidecarUrl?: string;
  sidecarWsUrl?: string;
};

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function appendIfMissing(
  defs: RuntimeChannelDefinition[],
  next: RuntimeChannelDefinition,
): void {
  if (!defs.some((d) => d.channelId === next.channelId)) {
    defs.push(next);
  }
}

function buildKnownRuntimeChannelsFromEnv(): RuntimeChannelDefinition[] {
  const defs: RuntimeChannelDefinition[] = [];

  const ibkrLiveAccount = process.env.IBKR_LIVE_ACCOUNT_ID;
  if (ibkrLiveAccount) {
    appendIfMissing(defs, {
      channelId: ibkrChannel('live', ibkrLiveAccount),
      brokerName: 'ibkr',
      mode: 'live',
      accountId: ibkrLiveAccount,
      label: `IBKR Live ${ibkrLiveAccount}`,
      sidecarUrl: process.env.IBKR_LIVE_SIDECAR_URL ?? 'http://localhost:8090/api',
      sidecarWsUrl: process.env.IBKR_LIVE_SIDECAR_WS ?? 'ws://localhost:8090/events',
    });
  }

  const ibkrPaperAccount = process.env.IBKR_PAPER_ACCOUNT_ID;
  if (ibkrPaperAccount) {
    appendIfMissing(defs, {
      channelId: ibkrChannel('paper', ibkrPaperAccount),
      brokerName: 'ibkr',
      mode: 'paper',
      accountId: ibkrPaperAccount,
      label: `IBKR Paper ${ibkrPaperAccount}`,
      sidecarUrl: process.env.IBKR_PAPER_SIDECAR_URL ?? 'http://localhost:8090/api',
      sidecarWsUrl: process.env.IBKR_PAPER_SIDECAR_WS ?? 'ws://localhost:8090/events',
    });
  }

  const tradestationAccount = process.env.TS_ACCOUNT_ID;
  if (tradestationAccount) {
    appendIfMissing(defs, {
      channelId: tradestationChannel('live', tradestationAccount),
      brokerName: 'tradestation',
      mode: 'live',
      accountId: tradestationAccount,
      label: `TradeStation Live ${tradestationAccount}`,
    });
  }

  return defs;
}

function resolveEnabledChannelIds(known: RuntimeChannelDefinition[]): string[] {
  const explicit = parseCsv(process.env.ENABLED_CHANNEL_IDS);
  if (explicit.length > 0) return explicit;
  if (known.length > 0) return known.map((c) => c.channelId);
  throw new Error(
    'No runtime channels configured. Set ENABLED_CHANNEL_IDS and channel env vars.',
  );
}

export function getRuntimeChannelDefinitions(): RuntimeChannelDefinition[] {
  const known = buildKnownRuntimeChannelsFromEnv();
  const knownById = new Map(known.map((d) => [d.channelId, d] as const));
  const enabledIds = resolveEnabledChannelIds(known);

  const defs: RuntimeChannelDefinition[] = [];
  for (const channelId of enabledIds) {
    const def = knownById.get(channelId);
    if (!def) {
      throw new Error(
        `ENABLED_CHANNEL_IDS includes "${channelId}" but no matching channel config was found.`,
      );
    }
    defs.push(def);
  }
  return defs;
}

export function getRuntimeChannelDefinitionMap(): Map<string, RuntimeChannelDefinition> {
  return new Map(getRuntimeChannelDefinitions().map((d) => [d.channelId, d]));
}

export function getDefaultRuntimeChannelId(): string {
  const [first] = getRuntimeChannelDefinitions();
  if (!first) throw new Error('No enabled runtime channel found.');
  return first.channelId;
}

