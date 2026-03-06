/**
 * Channel ID helpers.
 *
 * Runtime format: `<broker>:<mode>:<accountId>`
 *   - `ibkr:live:<accountId>`         — e.g. ibkr:live:U14368257
 *   - `ibkr:paper:<accountId>`        — e.g. ibkr:paper:DU12345
 *   - `tradestation:live:<accountId>` — e.g. tradestation:live:12345678
 *
 * Backtest format: `bt:<runId>` — e.g. bt:myopic-tuna
 *
 * IMPORTANT: Channel IDs are opaque identifiers. Construct them here, then
 * pass them through the system unchanged.
 */

import { uniqueNamesGenerator, adjectives, animals } from 'unique-names-generator';

export function generateRunId(): string {
  return uniqueNamesGenerator({ dictionaries: [adjectives, animals], separator: '-', length: 2 });
}

export type RuntimeBroker = 'ibkr' | 'tradestation';
export type RuntimeMode = 'live' | 'paper';

export function runtimeChannel(
  broker: RuntimeBroker,
  mode: RuntimeMode,
  accountId: string,
): string {
  return `${broker}:${mode}:${accountId}`;
}

export function ibkrChannel(mode: RuntimeMode, accountId: string): string {
  return runtimeChannel('ibkr', mode, accountId);
}

export function tradestationChannel(mode: RuntimeMode, accountId: string): string {
  return runtimeChannel('tradestation', mode, accountId);
}

export function liveChannel(accountId: string): string {
  return ibkrChannel('live', accountId);
}

export function btChannel(runId: string): string {
  return `bt:${runId}`;
}

export function paperChannel(accountId: string): string {
  return ibkrChannel('paper', accountId);
}
