import { useMemo } from 'react';
import { ChatFilters } from './chat-filters';
import { ChatFeed } from './chat-feed';
import { RelatedMessagesPanel } from './related-messages-panel';
import { useChatStore } from '@/stores/chat-store';

export function ChatRoom() {
  const messages = useChatStore((s) => s.messages);
  const enrichment = useChatStore((s) => s.enrichment);
  const firstItemIndex = useChatStore((s) => s.firstItemIndex);
  const cursor = useChatStore((s) => s.cursor);
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

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <ChatFilters />
      <div className="flex flex-1 min-h-0 gap-0">
        <div className="flex-1 min-w-0 flex flex-col">
          <ChatFeed
            messages={messages}
            enrichment={enrichment}
            lastProcessedTs={constraints?.lastProcessedTs ?? undefined}
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
