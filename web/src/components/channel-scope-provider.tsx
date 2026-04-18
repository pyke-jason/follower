import { useEffect, useCallback } from 'react';
import { useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useChannelStore } from '@/stores/channel-store';
import { useChannelStatus } from '@/lib/queries';
import { api } from '@/lib/api';

/**
 * Mount once in the root layout. Reads `?channel=` from the URL, redirects
 * to the resolved default when the URL is empty, exposes a router-aware
 * `selectChannel` through the store for callers that cannot import
 * react-router directly, and mirrors the /status response + channel ids
 * into the store for consumers (`router`, `sidebar`, `backtest-banner`,
 * `channel-scope-selector`) that subscribe to it.
 */
export function ChannelScopeSync() {
  const [searchParams] = useSearchParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const urlChannelId = searchParams.get('channel');
  const search = searchParams.toString();

  // Fetch the default-channel metadata once. Kept separate from the status
  // query because /status is scoped to a specific channel.
  const channelsQuery = useQuery({
    queryKey: ['channels', 'default'],
    queryFn: () => api<{ defaultChannelId: string | null }>('/channels'),
    staleTime: 60_000,
  });
  const defaultChannelId = channelsQuery.data?.defaultChannelId ?? null;

  // Resolve the channel we should scope queries to. Prefer the URL, fall
  // back to the server-provided default while we wait for the redirect below.
  const resolvedChannelId = urlChannelId ?? defaultChannelId ?? undefined;

  // Poll /status for the resolved channel via TanStack Query.
  const statusQuery = useChannelStatus(resolvedChannelId);

  const setChannelId = useChannelStore((s) => s.setChannelId);
  const setDefaultChannelId = useChannelStore((s) => s.setDefaultChannelId);
  const setStatus = useChannelStore((s) => s.setStatus);

  useEffect(() => {
    if (resolvedChannelId) setChannelId(resolvedChannelId);
  }, [resolvedChannelId, setChannelId]);

  useEffect(() => {
    if (defaultChannelId) setDefaultChannelId(defaultChannelId);
  }, [defaultChannelId, setDefaultChannelId]);

  useEffect(() => {
    if (statusQuery.data) {
      setStatus(statusQuery.data, null);
    } else if (statusQuery.isError) {
      setStatus(null, 'Status unavailable');
    }
  }, [statusQuery.data, statusQuery.isError, setStatus]);

  // ── URL is source of truth ─────────────────────────────────────────────
  // When the URL has no channel and we know the default, redirect once so
  // every subsequent render sees a channel id in the URL.
  useEffect(() => {
    if (urlChannelId || !defaultChannelId) return;
    const params = new URLSearchParams(search);
    params.set('channel', defaultChannelId);
    navigate(`${pathname}?${params.toString()}`, { replace: true });
  }, [urlChannelId, defaultChannelId, pathname, search, navigate]);

  // Router-aware selectChannel exposed through the store for callers that
  // cannot import react-router (e.g., the backtest banner Exit button).
  const selectChannel = useCallback(
    (id: string) => {
      const params = new URLSearchParams(search);
      params.set('channel', id);
      navigate(`${pathname}?${params.toString()}`);
    },
    [pathname, search, navigate],
  );

  useEffect(() => {
    useChannelStore.setState({ selectChannel });
  }, [selectChannel]);

  return null;
}
