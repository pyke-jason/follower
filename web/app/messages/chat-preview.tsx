'use client';

import dynamic from 'next/dynamic';
import { useState, useCallback, useTransition } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { fetchMessages } from './actions';
import Link from 'next/link';
import type { Message } from '../../../src/db/schema';

const ChatFeed = dynamic(
  () => import('./chat-feed').then((m) => ({ default: m.ChatFeed })),
  { ssr: false },
);

const START_INDEX = 100_000;

export function ChatPreview({
  messages: initialMessages,
  focusMessageId,
  author,
  title = 'Chat Context',
  viewAllHref,
}: {
  messages: Message[];
  focusMessageId?: string;
  author?: string;
  title?: string;
  viewAllHref?: string;
}) {
  // initialMessages arrive ASC (oldest first) from getNearbyMessages.
  // ChatFeed expects DESC (newest first) — it reverses internally.
  const [messages, setMessages] = useState(() => [...initialMessages].reverse());
  const [cursor, setCursor] = useState<string | null>(() => {
    if (initialMessages.length === 0) return null;
    // oldest message timestamp = cursor for loading older
    return initialMessages[0].timestamp;
  });
  const [firstItemIndex, setFirstItemIndex] = useState(START_INDEX);
  const [isLoadingOlder, startTransition] = useTransition();

  const handleLoadOlder = useCallback(() => {
    if (!cursor || !author) return;
    startTransition(async () => {
      const result = await fetchMessages({ authors: [author], cursor });
      if (result.messages.length === 0) {
        setCursor(null);
        return;
      }
      const newItemCount = result.messages.length + 5;
      setFirstItemIndex((prev) => prev - newItemCount);
      setMessages((prev) => [...result.messages, ...prev]);
      setCursor(result.nextCursor);
    });
  }, [cursor, author]);

  if (initialMessages.length === 0) return null;

  return (
    <Card className="py-0 gap-0 overflow-hidden">
      <CardHeader className="border-b py-3 px-4 flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {viewAllHref && (
          <Link
            href={viewAllHref}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            View all &rarr;
          </Link>
        )}
      </CardHeader>
      <CardContent className="p-0 h-80 flex flex-col">
        <ChatFeed
          messages={messages}
          firstItemIndex={firstItemIndex}
          focusMessageId={focusMessageId}
          highlightMessageId={focusMessageId}
          onLoadOlder={author ? handleLoadOlder : undefined}
          isLoadingOlder={isLoadingOlder}
          hasMore={cursor !== null}
        />
      </CardContent>
    </Card>
  );
}
