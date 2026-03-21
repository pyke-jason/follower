import { memo } from 'react';
import { AuthorAvatar } from './author-avatar';
import { MessageContent } from './message-content';
import { getAuthorTextColor } from '@/lib/author-colors';
import { formatTime } from '@/lib/format';
import { REACTION_EMOJI } from '../components/decision-shared';
import type { Message, MessageLabel } from '@src/db/schema';

function getAccentBorder(message: Message): string {
  const action = message.actionHint;
  const direction = message.directionHint;
  const badges = message.badges;
  const symbols = message.symbols;

  const isSignal = action || badges.length > 0 || symbols.length > 0;
  if (!isSignal) return 'border-l-transparent';

  if (action === 'CLOSE' || direction === 'SHORT') return 'border-l-loss';
  if (action === 'OPEN' || direction === 'LONG') return 'border-l-profit';
  return 'border-l-border';
}

export const ChatBubble = memo(function ChatBubble({ message, noBorder, label }: { message: Message; noBorder?: boolean; label?: MessageLabel | null }) {
  const badges = message.badges;
  const symbols = message.symbols;
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

        {message.reactions.length > 0 && (
          <div className="flex gap-1 mt-0.5">
            {message.reactions.map((r) => (
              <span key={r.Type} className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/60 bg-muted/40 rounded px-1 py-px">
                <span>{REACTION_EMOJI[r.Type] ?? r.Type}</span>
                {r.Count > 1 && <span className="tabular-nums">{r.Count}</span>}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
