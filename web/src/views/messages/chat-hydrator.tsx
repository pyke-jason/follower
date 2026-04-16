import { useRef, useEffect } from 'react';
import { useChatStore, type ChatHydration } from '@/stores/chat-store';

export type { ChatHydration };

export function ChatHydrator({ data }: { data: ChatHydration }) {
  const hydrate = useChatStore((s) => s.hydrate);
  const mergeNewMessages = useChatStore((s) => s.mergeNewMessages);
  const initialized = useRef(false);
  const dataRef = useRef(data);

  if (!initialized.current) {
    hydrate(data);
    initialized.current = true;
  }

  // On subsequent data changes (e.g. AutoRefresh), merge new messages
  useEffect(() => {
    if (dataRef.current === data) return;
    dataRef.current = data;
    mergeNewMessages(data.messages, data.enrichment);
  }, [data, mergeNewMessages]);

  return null;
}
