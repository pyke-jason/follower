/**
 * Channel ID helpers.
 *
 * Runtime format: `<broker>:<mode>:<accountId>`
 *   - `ibkr:live:<accountId>`  — e.g. ibkr:live:U14368257
 *   - `ibkr:paper:<accountId>` — e.g. ibkr:paper:DU12345
 *
 * Backtest format: `bt:<runId>` — e.g. bt:myopic-tuna
 *
 * IMPORTANT: Channel IDs are opaque identifiers. Construct them here, then
 * pass them through the system unchanged.
 */

import { uniqueNamesGenerator, adjectives, animals } from 'unique-names-generator';

const RUN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function generateRunId(): string {
  return uniqueNamesGenerator({ dictionaries: [adjectives, animals], separator: '-', length: 2 });
}

export function isSafeRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId);
}

export function assertSafeRunId(runId: string): void {
  if (!isSafeRunId(runId)) {
    throw new Error(`Invalid runId "${runId}"`);
  }
}

type RuntimeBroker = 'ibkr';
type RuntimeMode = 'live' | 'paper';

function runtimeChannel(
  broker: RuntimeBroker,
  mode: RuntimeMode,
  accountId: string,
): string {
  return `${broker}:${mode}:${accountId}`;
}

export function ibkrChannel(mode: RuntimeMode, accountId: string): string {
  return runtimeChannel('ibkr', mode, accountId);
}

function liveChannel(accountId: string): string {
  return ibkrChannel('live', accountId);
}

export function btChannel(runId: string): string {
  return `bt:${runId}`;
}

export function isBacktestChannel(channelId: string): boolean {
  return channelId.startsWith('bt:');
}

export function clsChannel(runId: string): string {
  return `cls:${runId}`;
}

function paperChannel(accountId: string): string {
  return ibkrChannel('paper', accountId);
}
