import { memo } from 'react';
import { AuthorAvatar } from './author-avatar';
import { MessageContent } from './message-content';
import { ReactionBadges } from '@/components/reaction-badges';
import { getAuthorTextColor } from '@/lib/author-colors';
import { formatTime } from '@/lib/format';
import type { Message } from '@src/db/schema';

export const ChatBubble = memo(function ChatBubble({ message, noBorder }: { message: Message; noBorder?: boolean }) {
  const badges = message.badges;
  const symbols = message.symbols;
  const isSignal =
    !!message.actionHint || badges.length > 0 || symbols.length > 0;

  return (
    <div
      data-message-id={message.id}
      className={`flex gap-3 px-4 py-1.5 hover:bg-white/[0.02] ${noBorder ? '' : 'border-l-2 border-l-transparent'}`}
    >
      <AuthorAvatar name={message.author} />

      <div className="flex-1 min-w-0">
        {/* Header: author + timestamp */}
        <div className="flex items-baseline gap-2">
          <span
            className="font-semibold text-sm"
            style={{ color: getAuthorTextColor(message.author) }}
          >
            {message.author}
          </span>
          <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">
            {formatTime(message.timestamp)}
          </span>
        </div>

        {/* Body: rich HTML content */}
        <div
          className={`text-sm mt-0.5 break-words ${
            isSignal ? 'text-foreground' : 'text-muted-foreground'
          }`}
        >
          <MessageContent message={message} />

          {message.isPaperTrade && (
            <span className="inline-flex items-center ml-2 align-middle">
              <span className="text-[10px] px-1 py-0.5 rounded bg-warning/15 text-warning font-medium">
                PAPER
              </span>
            </span>
          )}
        </div>

        <ReactionBadges reactions={message.reactions} />
      </div>
    </div>
  );
});
