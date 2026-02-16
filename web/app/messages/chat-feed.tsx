'use client';

import { useRef, useCallback, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ChatBubble } from './chat-bubble';
import { DateSeparator } from './date-separator';
import { ArrowDown } from 'lucide-react';
import type { Message } from '../../../src/db/schema';

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
  firstItemIndex,
  onLoadOlder,
  isLoadingOlder,
  hasMore,
}: {
  messages: Message[];
  firstItemIndex: number;
  onLoadOlder: () => void;
  isLoadingOlder: boolean;
  hasMore: boolean;
}) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const feedItems = buildFeedItems(messages);

  const handleStartReached = useCallback(() => {
    if (!isLoadingOlder && hasMore) {
      onLoadOlder();
    }
  }, [isLoadingOlder, hasMore, onLoadOlder]);

  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({
      index: feedItems.length - 1,
      behavior: 'smooth',
    });
  }, [feedItems.length]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground text-sm">
          No messages match your filters
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 relative min-h-0">
      <Virtuoso
        ref={virtuosoRef}
        data={feedItems}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={feedItems.length - 1}
        startReached={handleStartReached}
        atBottomStateChange={(atBottom) => setShowScrollBtn(!atBottom)}
        followOutput="smooth"
        itemContent={(_index, item) => {
          if (item.type === 'date') {
            return <DateSeparator date={item.date} />;
          }
          return <ChatBubble message={item.message} />;
        }}
        computeItemKey={(_index, item) => item.key}
        style={{ height: '100%' }}
        className="[scrollbar-width:thin] [scrollbar-color:theme(colors.zinc.700)_transparent]"
        components={{
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
        }}
      />

      {/* Scroll-to-bottom FAB */}
      {showScrollBtn && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 p-2 rounded-full bg-card border border-border text-muted-foreground hover:bg-accent shadow-warm-md transition-colors"
          aria-label="Scroll to bottom"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
