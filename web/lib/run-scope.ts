/** Append ?run=X to a URL path when in backtest context */
export function buildHref(path: string, runId?: string): string {
  if (!runId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}run=${runId}`;
}
