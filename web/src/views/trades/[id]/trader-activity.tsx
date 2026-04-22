import { Link } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ReactionBadges } from '@/components/reaction-badges';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { MessageSquare } from 'lucide-react';
import type { Message } from '@src/db/schema';

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
    <Card className="py-0 gap-0">
      <CardHeader className="border-b py-3 px-4">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          What {trader} said about {symbol}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {/* Source message pinned */}
        {sourceMessage && (
          <div className="px-4 py-3 border-b border-border bg-accent/30">
            <MessageRow message={sourceMessage} role="source" />
          </div>
        )}

        {/* Subsequent messages */}
        <div className="max-h-80 overflow-auto">
          {messages.length === 0 ? (
            <p className="px-4 py-4 text-xs text-muted-foreground/60 italic">
              No later messages from {trader} about {symbol}.
            </p>
          ) : (
            <div className="divide-y divide-border/40">
              {messages.map((m) => (
                <div key={m.id} className="px-4 py-2.5">
                  <MessageRow
                    message={m}
                    role={m.id === closeMessageId ? 'close' : 'subsequent'}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer link */}
        <div className="px-4 py-2 border-t border-border/40 bg-muted/20">
          <Link
            to={href('/messages', { authors: trader })}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            View all {trader} messages →
          </Link>
        </div>
      </CardContent>
    </Card>
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
