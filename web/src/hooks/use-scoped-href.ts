import { useCallback } from 'react';
import { useChannelId } from './use-channel-id';
import { buildScopedPath } from '@/lib/channel-scope';

type ParamValue = string | number | boolean | null | undefined;

/**
 * Returns a path builder that auto-injects `?channel=` from the URL.
 *
 *   const href = useScopedHref();
 *   href('/traders')                                   // /traders?channel=bt:xxx
 *   href('/recon', { filter: 'unresolved' })           // /recon?channel=bt:xxx&filter=unresolved
 *   api(href('/trades', { status: 'open' }))           // works for fetches too
 */
export function useScopedHref(): (path: string, params?: Record<string, ParamValue>) => string {
  const channelId = useChannelId();
  return useCallback(
    (path: string, params?: Record<string, ParamValue>) => buildScopedPath(path, channelId, params),
    [channelId],
  );
}
