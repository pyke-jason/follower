import { AuthorAvatar } from './author-avatar';
import { MessageContent } from './message-content';
import { getAuthorTextColor } from '@/lib/author-colors';
import { formatTime } from '@/lib/format';
import type { Message } from '../../../src/db/schema';

function getAccentBorder(message: Message): string {
  const action = message.actionHint;
  const direction = message.directionHint;
  const badges = (message.badges as string[]) || [];
  const symbols = (message.symbols as string[]) || [];

  const isSignal = action || badges.length > 0 || symbols.length > 0;
  if (!isSignal) return 'border-l-transparent';

  if (action === 'CLOSE' || direction === 'SHORT') return 'border-l-loss';
  if (action === 'OPEN' || direction === 'LONG') return 'border-l-profit';
  return 'border-l-border';
}

export function ChatBubble({ message, noBorder }: { message: Message; noBorder?: boolean }) {
  const badges = (message.badges as string[]) || [];
  const symbols = (message.symbols as string[]) || [];
  const isSignal =
    !!message.actionHint || badges.length > 0 || symbols.length > 0;

  const accentClass = noBorder ? '' : `border-l-2 ${getAccentBorder(message)}`;
  return (
    <div
      data-message-id={message.id}
      className={`flex gap-3 px-4 py-1.5 hover:bg-white/[0.02] ${accentClass}`}
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
      </div>
    </div>
  );
}
