'use client';

import { useState, useCallback, useTransition, useEffect } from 'react';
import { ChatFilters } from './chat-filters';
import { ChatFeed } from './chat-feed';
import { fetchMessages, type MessageFilters } from './actions';
import type { Message } from '../../../src/db/schema';

const START_INDEX = 100_000;

export function ChatRoom({
  initialMessages,
  initialCursor,
  authors,
}: {
  initialMessages: Message[];
  initialCursor: string | null;
  authors: string[];
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [cursor, setCursor] = useState(initialCursor);
  const [firstItemIndex, setFirstItemIndex] = useState(START_INDEX);
  const [filters, setFilters] = useState<MessageFilters>({});
  const [isLoadingOlder, startLoadingTransition] = useTransition();

  // Sync filters to URL search params
  useEffect(() => {
    const params = new URLSearchParams();
    if (filters.authors?.length) params.set('authors', filters.authors.join(','));
    if (filters.startDate) params.set('start', filters.startDate);
    if (filters.endDate) params.set('end', filters.endDate);
    if (filters.signalsOnly) params.set('signals', '1');

    const search = params.toString();
    const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;
    window.history.replaceState(null, '', url);
  }, [filters]);

  // When filters change, reset and reload
  const handleFilterChange = useCallback(
    (newFilters: MessageFilters) => {
      setFilters(newFilters);
      setFirstItemIndex(START_INDEX);

      startLoadingTransition(async () => {
        const result = await fetchMessages(newFilters);
        setMessages(result.messages);
        setCursor(result.nextCursor);
      });
    },
    []
  );

  // Load older messages (prepend)
  const handleLoadOlder = useCallback(() => {
    if (!cursor) return;

    startLoadingTransition(async () => {
      const result = await fetchMessages({ ...filters, cursor });
      if (result.messages.length === 0) {
        setCursor(null);
        return;
      }

      // buildFeedItems will reverse these, so count the feed items that
      // will be prepended (messages + date separators). To keep it simple,
      // approximate with just message count — the firstItemIndex adjustment
      // only needs to be >= actual prepend count; Virtuoso handles the rest.
      const newItemCount = result.messages.length + 5; // padding for date separators
      setFirstItemIndex((prev) => prev - newItemCount);
      setMessages((prev) => [...result.messages, ...prev]);
      setCursor(result.nextCursor);
    });
  }, [cursor, filters]);

  return (
    <div className="flex flex-col h-full">
      <ChatFilters
        authors={authors}
        filters={filters}
        onFilterChange={handleFilterChange}
      />
      <ChatFeed
        messages={messages}
        firstItemIndex={firstItemIndex}
        onLoadOlder={handleLoadOlder}
        isLoadingOlder={isLoadingOlder}
        hasMore={cursor !== null}
      />
    </div>
  );
}
