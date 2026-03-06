import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { useChannelId } from '@/hooks/use-channel-id';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { useChatStore } from '@/stores/chat-store';
import { ChatRoom } from './chat-room';
import { ChatHydrator } from './chat-hydrator';
import type { ChatHydration } from '@/stores/chat-store';
import { useEffect, useRef, useCallback } from 'react';

const Spinner = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin h-6 w-6 border-2 border-muted-foreground/20 border-t-foreground rounded-full" />
  </div>
);

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

export default function MessagesPage() {
  const channelId = useChannelId();
  const href = useScopedHref();
  const [params] = useSearchParams();
  const setFilters = useChatStore((s) => s.setFilters);
  const appliedUrlFilters = useRef(false);
  const fullBleedRef = useFullBleed();

  // Seed store filters from URL params on first render
  useEffect(() => {
    if (appliedUrlFilters.current) return;
    appliedUrlFilters.current = true;
    const authors = params.get('authors');
    const start = params.get('start');
    const end = params.get('end');
    const signals = params.get('signals');
    const label = params.get('label');
    if (authors || start || end || signals || label) {
      setFilters({
        ...(authors && { authors: authors.split(',') }),
        ...(start && { startDate: start }),
        ...(end && { endDate: end }),
        ...(signals && { signalsOnly: true }),
        ...(label && { labelFilter: label as 'labeled' | 'unlabeled' }),
      });
    }
  }, [params, setFilters]);

  const { data } = useQuery<ChatHydration>({
    queryKey: ['messages-initial', channelId],
    queryFn: () => api<ChatHydration>(href('/messages', { limit: 51 })),
    refetchInterval: 5000,
  });

  if (!data) return <Spinner />;

  return (
    <div ref={fullBleedRef} className="absolute inset-0 flex flex-col">
      <ChatHydrator data={data} />
      <ChatRoom />
    </div>
  );
}
