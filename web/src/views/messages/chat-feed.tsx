import { useRef, useCallback, useState, useMemo, type ReactNode } from 'react';
import { Virtuoso, type VirtuosoHandle, type ListRange } from 'react-virtuoso';
import { ChatBubble } from './chat-bubble';
import { EnrichedChatBubble } from './enriched-chat-bubble';
import { DateSeparator } from './date-separator';
import { StickyDateBadge } from './sticky-date-badge';
import { ScrollToBottom } from '@/components/scroll-to-bottom';
import { EmptyState } from '@/components/empty-state';
import { cn } from '@/lib/utils';
import type { Message } from '@src/db/schema';
import type { MessageEnrichment } from '@/stores/chat-store';

type FeedItem =
  | { type: 'date'; date: string; key: string }
  | { type: 'message'; message: Message; key: string };

/** Insert date separators between messages from different days. */
function buildFeedItems(messages: Message[]): FeedItem[] {
  // Messages come in desc order (newest first). For chat display we reverse
  // to show oldest at top, newest at bottom.
  const chronological = [...messages].reverse();
  const items: FeedItem[] = [];
  let lastDay = '';

  for (const msg of chronological) {
    const day = msg.timestamp.slice(0, 10); // "YYYY-MM-DD"
    if (day !== lastDay) {
      items.push({ type: 'date', date: msg.timestamp, key: `date-${day}` });
      lastDay = day;
    }
    items.push({ type: 'message', message: msg, key: msg.id });
  }

  return items;
}

export function ChatFeed({
  messages,
  firstItemIndex = 0,
  onLoadOlder,
  isLoadingOlder = false,
  hasMore = false,
  focusMessageId,
  highlightMessageId,
  selectedMessageId,
  anchorMessageId,
  enrichment,
  lastProcessedTs,
  renderItem,
  onMessageClick,
}: {
  messages: Message[];
  firstItemIndex?: number;
  onLoadOlder?: () => void;
  isLoadingOlder?: boolean;
  hasMore?: boolean;
  focusMessageId?: string;
  highlightMessageId?: string;
  selectedMessageId?: string;
  /** When set, scroll-to-bottom button scrolls here instead of absolute bottom. */
  anchorMessageId?: string;
  enrichment?: Record<string, MessageEnrichment> | null;
  lastProcessedTs?: string;
  renderItem?: (message: Message, isHighlighted: boolean) => ReactNode;
  onMessageClick?: (message: Message) => void;
}) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [stickyDate, setStickyDate] = useState<string | null>(null);

  const feedItems = useMemo(() => buildFeedItems(messages), [messages]);

  const focusIndex = focusMessageId
    ? feedItems.findIndex(
        (item) => item.type === 'message' && item.message.id === focusMessageId,
      )
    : -1;
  const initialIndex = focusIndex >= 0 ? focusIndex : feedItems.length - 1;

  // Anchor index for the scroll button (recenter to last processed message)
  const anchorIndex = anchorMessageId
    ? feedItems.findIndex(
        (item) => item.type === 'message' && item.message.id === anchorMessageId,
      )
    : -1;

  const handleStartReached = useCallback(() => {
    if (onLoadOlder && !isLoadingOlder && hasMore) {
      onLoadOlder();
    }
  }, [onLoadOlder, isLoadingOlder, hasMore]);

  const scrollToAnchor = useCallback(() => {
    const targetIndex = anchorIndex >= 0 ? anchorIndex : feedItems.length - 1;
    virtuosoRef.current?.scrollToIndex({
      index: targetIndex,
      behavior: 'smooth',
    });
  }, [anchorIndex, feedItems.length]);

  // Track the topmost visible item to derive the current day
  const handleRangeChanged = useCallback((range: ListRange) => {
    const localIndex = range.startIndex - firstItemIndex;
    const item = feedItems[localIndex];
    if (!item) { setStickyDate(null); return; }
    setStickyDate(item.type === 'date' ? item.date : item.message.timestamp);
  }, [feedItems, firstItemIndex]);

  const renderItemContent = useCallback((_index: number, item: FeedItem) => {
    if (item.type === 'date') {
      return <DateSeparator date={item.date} />;
    }
    const isHighlighted = item.message.id === highlightMessageId;
    const isSelected = item.message.id === selectedMessageId;
    if (renderItem) {
      return renderItem(item.message, isHighlighted);
    }
    const msgEnrichment = enrichment?.[item.message.id];
    const isPending = !!(lastProcessedTs && item.message.timestamp > lastProcessedTs);
    if (msgEnrichment && (msgEnrichment.decision || msgEnrichment.trade || msgEnrichment.intent)) {
      return (
        <div
          className={cn(
            isSelected && 'ring-1 ring-inset ring-primary/20',
            onMessageClick && 'cursor-pointer',
          )}
          onClick={onMessageClick ? () => onMessageClick(item.message) : undefined}
        >
          <EnrichedChatBubble
            enriched={{
              message: item.message,
              trade: msgEnrichment.trade,
              decision: msgEnrichment.decision,
              intent: msgEnrichment.intent,
            }}
            isHighlighted={isHighlighted}
            isPending={isPending}
          />
        </div>
      );
    }
    return (
      <div
        className={cn(
          isHighlighted && 'bg-info/5 ring-1 ring-inset ring-info/20',
          isSelected && 'bg-primary/5 ring-1 ring-inset ring-primary/20',
          isPending && 'opacity-40',
          onMessageClick && 'cursor-pointer',
        )}
        onClick={onMessageClick ? () => onMessageClick(item.message) : undefined}
      >
        <ChatBubble message={item.message} />
      </div>
    );
  }, [highlightMessageId, selectedMessageId, enrichment, lastProcessedTs, renderItem, onMessageClick]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          variant="filtered"
          title="No messages match your filters"
          hint="Try adjusting or clearing the active filters"
        />
      </div>
    );
  }

  return (
    <div className="flex-1 relative min-h-0">
      <Virtuoso
        ref={virtuosoRef}
        data={feedItems}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={initialIndex}
        startReached={handleStartReached}
        atBottomStateChange={(atBottom) => setShowScrollBtn(!atBottom)}
        rangeChanged={handleRangeChanged}
        followOutput={(isAtBottom) => isAtBottom ? 'smooth' : false}
        defaultItemHeight={60}
        increaseViewportBy={{ top: 300, bottom: 100 }}
        itemContent={renderItemContent}
        computeItemKey={(_index, item) => item.key}
        style={{ height: '100%' }}
        className="scrollbar-thin"
        components={onLoadOlder ? {
          Header: () =>
            isLoadingOlder ? (
              <div className="py-3 text-center text-xs text-muted-foreground">
                Loading older messages...
              </div>
            ) : !hasMore && messages.length > 0 ? (
              <div className="py-3 text-center text-xs text-muted-foreground">
                Beginning of messages
              </div>
            ) : null,
        } : {}}
      />

      <StickyDateBadge date={stickyDate} />

      {onLoadOlder && showScrollBtn && (
        <ScrollToBottom onClick={scrollToAnchor} />
      )}
    </div>
  );
}
