'use client';

import { useMemo, useEffect } from 'react';
import { ChatFilters } from './chat-filters';
import { ChatFeed } from './chat-feed';
import { RelatedMessagesPanel } from './related-messages-panel';
import { useChatStore } from '@/stores/chat-store';

export function ChatRoom() {
  const messages = useChatStore((s) => s.messages);
  const labels = useChatStore((s) => s.labels);
  const enrichment = useChatStore((s) => s.enrichment);
  const firstItemIndex = useChatStore((s) => s.firstItemIndex);
  const cursor = useChatStore((s) => s.cursor);
  const filters = useChatStore((s) => s.filters);
  const constraints = useChatStore((s) => s.constraints);
  const selectedMessage = useChatStore((s) => s.selectedMessage);
  const isLoadingOlder = useChatStore((s) => s.isLoadingOlder);
  const loadOlderMessages = useChatStore((s) => s.loadOlderMessages);
  const selectMessage = useChatStore((s) => s.selectMessage);

  const anchorMessageId = useMemo(() => {
    if (!constraints?.lastProcessedTs) return undefined;
    const ts = constraints.lastProcessedTs;
    return messages.find((m) => m.timestamp <= ts)?.id;
  }, [constraints?.lastProcessedTs, messages]);

  // Sync filters to URL search params (skip when in constrained mode)
  useEffect(() => {
    if (constraints) return;
    const params = new URLSearchParams();
    if (filters.authors?.length) params.set('authors', filters.authors.join(','));
    if (filters.startDate) params.set('start', filters.startDate);
    if (filters.endDate) params.set('end', filters.endDate);
    if (filters.signalsOnly) params.set('signals', '1');
    if (filters.labelFilter) params.set('label', filters.labelFilter);

    const search = params.toString();
    const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;
    window.history.replaceState(null, '', url);
  }, [filters, constraints]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <ChatFilters />
      <div className="flex flex-1 min-h-0 gap-0">
        <div className="flex-1 min-w-0 flex flex-col">
          <ChatFeed
            messages={messages}
            labels={labels}
            enrichment={Object.keys(enrichment).length > 0 ? enrichment : undefined}
            lastProcessedTs={constraints?.lastProcessedTs ?? undefined}
            runId={constraints?.runId}
            firstItemIndex={firstItemIndex}
            onLoadOlder={loadOlderMessages}
            isLoadingOlder={isLoadingOlder}
            hasMore={cursor !== null}
            selectedMessageId={selectedMessage?.id}
            onMessageClick={selectMessage}
            anchorMessageId={anchorMessageId}
            focusMessageId={anchorMessageId}
          />
        </div>
        {selectedMessage && (
          <RelatedMessagesPanel
            onClose={() => selectMessage(null)}
          />
        )}
      </div>
    </div>
  );
}
