type ScopeParamValue = string | number | boolean | null | undefined;

/** Append ?channel=X to a URL path when a scope is active */
export function buildHref(path: string, channelId?: string): string {
  return buildScopedPath(path, channelId);
}

/** Build query string with current channel + extra params. */
export function buildScopedSearch(
  channelId?: string,
  params: Record<string, ScopeParamValue> = {},
): string {
  const query = new URLSearchParams();
  if (channelId) {
    query.set('channel', channelId);
  }
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  return query.toString();
}

/** Build URL path preserving channel scope and extra params. */
export function buildScopedPath(
  path: string,
  channelId?: string,
  params: Record<string, ScopeParamValue> = {},
): string {
  const search = buildScopedSearch(channelId, params);
  if (!search) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}${search}`;
}
