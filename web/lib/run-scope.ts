/** Routes that accept ?run= scoping */
const scopedPrefixes = ['/', '/trades', '/tasks', '/reconciliation'];

/** Returns true if the given pathname accepts ?run= scoping */
export function isRunScopedPath(pathname: string): boolean {
  if (pathname === '/') return true;
  return scopedPrefixes.some(
    (prefix) => prefix !== '/' && (pathname === prefix || pathname.startsWith(prefix + '/'))
  );
}

/** Append ?run=X to a URL path when in backtest context */
export function buildHref(path: string, runId?: string): string {
  if (!runId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}run=${runId}`;
}
