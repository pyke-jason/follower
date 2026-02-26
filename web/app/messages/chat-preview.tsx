'use client';

import dynamic from 'next/dynamic';
import { useState, useCallback, useTransition, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { fetchMessages, fetchMessage } from './actions';
import Link from 'next/link';
import type { Message, MessageLabel } from '../../../src/db/schema';

const ChatFeed = dynamic(
  () => import('./chat-feed').then((m) => ({ default: m.ChatFeed })),
  { ssr: false },
);

const START_INDEX = 100_000;

/** Merge a message into a DESC-sorted array in the right position. */
function mergeMessageDesc(messages: Message[], msg: Message): Message[] {
  const idx = messages.findIndex((m) => m.timestamp < msg.timestamp);
  if (idx === -1) return [...messages, msg];
  return [...messages.slice(0, idx), msg, ...messages.slice(idx)];
}

export function ChatPreview({
  messages: initialMessages,
  focusMessageId,
  author,
  title = 'Chat Context',
  viewAllHref,
  initialLabels,
  className,
}: {
  messages: Message[];
  focusMessageId?: string;
  author?: string;
  title?: string;
  viewAllHref?: string;
  initialLabels?: Record<string, MessageLabel>;
  /** Override height. Default: h-80 */
  className?: string;
}) {
  // initialMessages arrive ASC (oldest first) from getNearbyMessages.
  // ChatFeed expects DESC (newest first) — it reverses internally.
  const [messages, setMessages] = useState(() => [...initialMessages].reverse());
  const [labels, setLabels] = useState<Record<string, MessageLabel>>(initialLabels ?? {});
  const [cursor, setCursor] = useState<string | null>(() => {
    if (initialMessages.length === 0) return null;
    // oldest message timestamp = cursor for loading older
    return initialMessages[0].timestamp;
  });
  const [firstItemIndex, setFirstItemIndex] = useState(START_INDEX);
  const [isLoadingOlder, startTransition] = useTransition();

  // If the focus message isn't in the initial set, fetch and merge it.
  useEffect(() => {
    if (!focusMessageId) return;
    if (initialMessages.some((m) => m.id === focusMessageId)) return;
    fetchMessage(focusMessageId).then((msg) => {
      if (msg) setMessages((prev) =>
        prev.some((m) => m.id === msg.id) ? prev : mergeMessageDesc(prev, msg),
      );
    });
  }, [focusMessageId, initialMessages]);

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
      setLabels((prev) => ({ ...prev, ...result.labels }));
      setCursor(result.nextCursor);
    });
  }, [cursor, author]);

  if (initialMessages.length === 0 && !focusMessageId) return null;

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
      <CardContent className={`p-0 flex flex-col ${className ?? 'h-80'}`}>
        <ChatFeed
          messages={messages}
          labels={labels}
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
