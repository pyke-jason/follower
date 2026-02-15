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

  if (action === 'CLOSE' || direction === 'SHORT') return 'border-l-red-500';
  if (action === 'OPEN' || direction === 'LONG') return 'border-l-emerald-500';
  return 'border-l-zinc-500';
}

export function ChatBubble({ message }: { message: Message }) {
  const badges = (message.badges as string[]) || [];
  const symbols = (message.symbols as string[]) || [];
  const isSignal =
    !!message.actionHint || badges.length > 0 || symbols.length > 0;

  const accentClass = getAccentBorder(message);
  const hasIndicators = !!message.confidence || !!message.isPaperTrade;

  return (
    <div
      data-message-id={message.id}
      className={`flex gap-3 px-4 py-1.5 border-l-2 hover:bg-white/[0.02] ${accentClass}`}
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

          {/* Subtle inline indicators */}
          {hasIndicators && (
            <span className="inline-flex items-center gap-1.5 ml-2 align-middle">
              {message.confidence && (
                <span className="text-[11px] text-muted-foreground">
                  {Math.round(parseFloat(message.confidence) * 100)}%
                </span>
              )}
              {message.isPaperTrade && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-yellow-900/50 text-yellow-300 font-medium">
                  PAPER
                </span>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
