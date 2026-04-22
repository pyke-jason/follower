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
      {sourceMessage && (
        <div className="border-b border-border/60 bg-amber-500/5 px-5 py-4">
          <MessageRow message={sourceMessage} role="source" />
        </div>
      )}

      <div className="max-h-80 overflow-auto px-3 py-3">
        {messages.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border/70 bg-background/70 px-4 py-4 text-xs italic text-muted-foreground/70">
            No later messages from {trader} about {symbol}.
          </p>
        ) : (
          <div className="space-y-2">
            {messages.map((m) => (
              <div key={m.id} className="rounded-2xl border border-border/60 bg-background/75 px-4 py-3">
                <MessageRow
                  message={m}
                  role={m.id === closeMessageId ? 'close' : 'subsequent'}
                />
              </div>
            ))}
          </div>
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
    <div>
      <div className="flex items-center gap-2 mb-1">
        {role === 'source' && (
          <span className="text-[9px] font-bold uppercase tracking-wider text-info">
            Source
          </span>
        )}
        {role === 'close' && (
          <span className="text-[9px] font-bold uppercase tracking-wider text-warning">
            Close
          </span>
        )}
        <span className="text-[10px] text-muted-foreground/70 tabular-nums">
          {formatDate(message.timestamp)}
        </span>
      </div>
      <p className={cn('text-xs leading-relaxed break-words', role === 'source' ? 'text-foreground' : 'text-foreground/80')}>
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
