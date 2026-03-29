import { ChatFeed } from './chat-feed';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/spinner';
import { EmptyState } from '@/components/empty-state';
import { X } from 'lucide-react';
import { useChatStore } from '@/stores/chat-store';

export function RelatedMessagesPanel({
  onClose,
}: {
  onClose: () => void;
}) {
  const sourceMessage = useChatStore((s) => s.selectedMessage);
  const context = useChatStore((s) => s.relatedContext);
  const isLoading = useChatStore((s) => s.isLoadingRelated);

  if (!sourceMessage) return null;

  const symbols = sourceMessage.symbols;

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
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col">
        {isLoading ? (
          <Spinner />
        ) : context && context.messages.length > 0 ? (
          <ChatFeed
            messages={context.messages}
            labels={context.labels}
            highlightMessageId={sourceMessage.id}
            focusMessageId={sourceMessage.id}
          />
        ) : (
          <EmptyState
            title={symbols.length === 0 ? 'No symbols detected' : 'No related messages found'}
            hint={symbols.length === 0 ? 'This message has no ticker symbols' : `No other messages reference ${symbols.join(', ')}`}
          />
        )}
      </div>
    </Card>
  );
}
