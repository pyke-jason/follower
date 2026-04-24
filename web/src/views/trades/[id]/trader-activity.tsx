import { Link } from 'react-router-dom';
import { ReactionBadges } from '@/components/reaction-badges';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Message } from '@src/db/schema';
import { DetailPanel } from './detail-panel';

/**
 * Messages by the same trader mentioning this trade's symbol that arrived
 * AFTER the trade opened. First answer to "why didn't we close / why is this
 * position still open" — the trader often posted a trim or close that the bot
 * missed or misclassified.
 */
export function TraderActivity({ messages, trader, symbol, sourceMessage, closeMessageId }: {
  messages: Message[];
  trader: string;
  symbol: string;
  sourceMessage: Message | null;
  closeMessageId: string | null;
}) {
  const href = useScopedHref();

  return (
    <DetailPanel
      title={`What ${trader} said about ${symbol}`}
      description="Source message plus later mentions from the same trader, so missed closes or trims are easy to spot."
      eyebrow="Message Trail"
      action={(
        <Link
          to={href('/messages', { authors: trader })}
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          All messages →
        </Link>
      )}
      contentClassName="p-0"
    >
      <div className="max-h-72 overflow-auto">
        {sourceMessage || messages.length > 0 ? (
          <div className="space-y-1.5">
            {sourceMessage && (
              <div className="border-l-2 border-l-info/70 bg-info/5 px-3 py-2">
                <MessageRow message={sourceMessage} role="source" />
              </div>
            )}

            {messages.map((m) => (
              <div key={m.id} className="border-b border-border/50 px-3 py-2 last:border-b-0">
                <MessageRow
                  message={m}
                  role={m.id === closeMessageId ? 'close' : 'subsequent'}
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-2xl border border-dashed border-border/70 bg-background/70 px-4 py-4 text-xs italic text-muted-foreground/70">
            No later messages from {trader} about {symbol}.
          </p>
        )}
      </div>
    </DetailPanel>
  );
}

function MessageRow({ message, role }: {
  message: Message;
  role: 'source' | 'close' | 'subsequent';
}) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 flex items-center gap-2 text-[11px]">
        <span className="truncate font-medium text-foreground">{message.author}</span>
        {role === 'source' && (
          <span className="rounded bg-info/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-info">
            Source
          </span>
        )}
        {role === 'close' && (
          <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-warning">
            Close
          </span>
        )}
        <span className="truncate text-[10px] text-muted-foreground/70 tabular-nums">
          {formatDate(message.timestamp)}
        </span>
      </div>
      <p
        title={message.cleanText}
        className={cn(
          'truncate text-sm leading-5',
          role === 'source' ? 'text-foreground' : 'text-foreground/85',
        )}
      >
        {message.cleanText}
      </p>
      {message.reactions.length > 0 && (
        <div className="mt-1">
          <ReactionBadges reactions={message.reactions} className="inline-flex gap-1" />
        </div>
      )}
    </div>
  );
}
