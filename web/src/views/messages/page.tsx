import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useChannelId } from '@/hooks/use-channel-id';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { useChatStore } from '@/stores/chat-store';
import { useChatFilterParams } from '@/hooks/use-chat-filter-params';
import { ChatRoom } from './chat-room';
import { ChatHydrator } from './chat-hydrator';
import type { ChatHydration } from '@/stores/chat-store';
import { useEffect, useRef, useCallback } from 'react';
import { QueryBoundary, TableSkeleton } from '@/components/query-boundary';

/** Strip parent padding/overflow so this page fills edge-to-edge. Restore on unmount. */
function useFullBleed() {
  const cleanupRef = useRef<(() => void) | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    // Cleanup previous
    cleanupRef.current?.();
    cleanupRef.current = null;

    if (!node) return;
    const parent = node.parentElement;
    if (!parent) return;

    const saved = { overflow: parent.style.overflow, padding: parent.style.padding };
    parent.style.overflow = 'hidden';
    parent.style.padding = '0';
    cleanupRef.current = () => {
      parent.style.overflow = saved.overflow;
      parent.style.padding = saved.padding;
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => () => { cleanupRef.current?.(); }, []);

  return ref;
}

/** Bridge URL filter params into the Zustand chat store on mount + URL changes. */
function useSyncFiltersToStore() {
  const { authors, start, end, signals, label, role } = useChatFilterParams();
  const setFilters = useChatStore((s) => s.setFilters);
  const prevRef = useRef<string>('');

  useEffect(() => {
    // Serialize current URL filter state for change detection
    const key = JSON.stringify({ authors, start, end, signals, label, role });
    if (key === prevRef.current) return;
    prevRef.current = key;

    const hasAny = authors || start || end || signals || label || role;
    if (!hasAny) {
      // No filters active — pass empty object to clear store filters + refetch
      setFilters({});
      return;
    }
    setFilters({
      ...(authors && { authors: authors.split(',') }),
      ...(start && { startDate: start }),
      ...(end && { endDate: end }),
      ...(signals && { signalsOnly: true }),
      ...(label && { labelFilter: label as 'labeled' | 'unlabeled' }),
      ...(role && role !== 'all' && { roleFilter: role as 'processed' | 'executed' | 'skipped' }),
    });
  }, [authors, start, end, signals, label, role, setFilters]);
}

export default function MessagesPage() {
  const channelId = useChannelId();
  const href = useScopedHref();
  const fullBleedRef = useFullBleed();

  useSyncFiltersToStore();

  const query = useQuery<ChatHydration>({
    queryKey: ['messages-initial', channelId],
    queryFn: () => api<ChatHydration>(href('/messages', { limit: 51 })),
    refetchInterval: 5000,
  });

  return (
    <QueryBoundary query={query} skeleton={<TableSkeleton />}>
      {(data) => (
        <div ref={fullBleedRef} className="absolute inset-0 flex flex-col">
          <ChatHydrator data={data} />
          <ChatRoom />
        </div>
      )}
    </QueryBoundary>
  );
}
