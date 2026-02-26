'use client';

import { ChatFeed } from './chat-feed';
import { Card } from '@/components/ui/card';
import { X } from 'lucide-react';
import type { Message, MessageLabel } from '../../../src/db/schema';

type RelatedContext = {
  messages: Message[];
  labels: Record<string, MessageLabel>;
  sourceSymbols: string[];
};

export function RelatedMessagesPanel({
  sourceMessage,
  context,
  isLoading,
  onClose,
}: {
  sourceMessage: Message;
  context: RelatedContext | null;
  isLoading: boolean;
  onClose: () => void;
}) {
  const symbols = (sourceMessage.symbols as string[]) ?? [];

  return (
    <Card className="py-0 gap-0 overflow-hidden w-[460px] shrink-0 flex flex-col border-l rounded-none border-t-0 border-b-0 border-r-0">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <span className="text-sm font-medium truncate">
          {symbols.length > 0
            ? symbols.join(', ')
            : 'Related messages'}
        </span>
        {context && (
          <span className="text-xs text-muted-foreground ml-1">
            {context.messages.length} msgs
          </span>
        )}
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors ml-auto"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">Loading related messages...</p>
          </div>
        ) : context && context.messages.length > 0 ? (
          <ChatFeed
            messages={context.messages}
            labels={context.labels}
            highlightMessageId={sourceMessage.id}
            focusMessageId={sourceMessage.id}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">
              {symbols.length === 0
                ? 'No symbols detected in this message'
                : 'No related messages found'}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
