import { useEffect, useCallback } from 'react';
import { useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import { useChannelStore } from '@/stores/channel-store';
import { api } from '@/lib/api';

export type { ChannelBrief, StatusData } from '@/stores/channel-store';

/**
 * URL <-> zustand sync. Mount once in the root layout -- reads `?channel=`
 * from the URL and keeps the zustand store in sync. Also injects the
 * router-based `selectChannel` implementation so store consumers can
 * navigate without importing react-router themselves.
 */
export function ChannelScopeSync() {
  const [searchParams] = useSearchParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const channelId = searchParams.get('channel');
  const search = searchParams.toString();

  const storeChannelId = useChannelStore((s) => s.channelId);
  const setChannelId = useChannelStore((s) => s.setChannelId);
  const setDefaultChannelId = useChannelStore((s) => s.setDefaultChannelId);
  const startPolling = useChannelStore((s) => s.startPolling);
  const stopPolling = useChannelStore((s) => s.stopPolling);
  const refreshStatus = useChannelStore((s) => s.refreshStatus);

  // URL → store: sync when URL has ?channel=
  useEffect(() => {
    if (channelId) {
      setChannelId(channelId);
    }
  }, [channelId, setChannelId]);

  // Store → URL: ensure ?channel= is ALWAYS in the URL.
  // Fires when navigating to a bare path (e.g. hardcoded link)
  // or after the default channel is resolved on first load.
  useEffect(() => {
    if (!channelId && storeChannelId) {
      const params = new URLSearchParams(search);
      params.set('channel', storeChannelId);
      navigate(`${pathname}?${params.toString()}`, { replace: true });
    }
  }, [channelId, storeChannelId, pathname, search, navigate]);

  // Fetch default channel on mount
  useEffect(() => {
    let active = true;

    api<{ defaultChannelId: string | null }>('/channels')
      .then((data) => {
        if (!active) return;
        const fallback = data.defaultChannelId;
        if (!fallback) return;
        setDefaultChannelId(fallback);
        if (!useChannelStore.getState().channelId) {
          setChannelId(fallback);
        }
      })
      .catch((error: unknown) => {
        if (import.meta.env.DEV) {
          console.warn('[channel-scope] failed to load channels', error);
        }
      });

    return () => {
      active = false;
    };
  }, [setChannelId, setDefaultChannelId]);

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

  useEffect(() => {
    startPolling();
    const onFocus = () => refreshStatus();
    window.addEventListener('focus', onFocus);
    return () => {
      stopPolling();
      window.removeEventListener('focus', onFocus);
    };
  }, [channelId, startPolling, stopPolling, refreshStatus]);

  return null;
}
