/**
 * Channel ID helpers.
 *
 * Format: `<mode>:<id>`
 *   - `live:<accountId>`  — e.g. live:U14368257
 *   - `paper:<accountId>` — e.g. paper:DU12345
 *   - `bt:<runId>`        — e.g. bt:a1b2c3d4-...
 *
 * The pipeline never parses this — only the web layer and runner setup code need it.
 */

export function parseChannel(channelId: string): { mode: string; id: string } {
  const idx = channelId.indexOf(':');
  if (idx === -1) return { mode: channelId, id: '' };
  return { mode: channelId.slice(0, idx), id: channelId.slice(idx + 1) };
}

export function liveChannel(accountId: string): string {
  return `live:${accountId}`;
}

export function btChannel(runId: string): string {
  return `bt:${runId}`;
}

export function paperChannel(accountId: string): string {
  return `paper:${accountId}`;
}
