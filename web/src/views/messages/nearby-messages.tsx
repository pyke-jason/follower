import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ReactionBadges } from '@/components/reaction-badges';
import { formatDate } from '@/lib/format';
import type { Message } from '@src/db/schema';

export function NearbyMessages({
  messages,
  associatedMessageIds,
}: {
  messages: Message[];
  associatedMessageIds: Set<string>;
}) {
  const [showOlder, setShowOlder] = useState(false);
  const [showNewer, setShowNewer] = useState(false);

  if (messages.length === 0) return null;

  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (associatedMessageIds.has(messages[i].id)) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }

  if (firstIdx === -1) {
    firstIdx = 0;
    lastIdx = messages.length - 1;
  }

  const before = messages.slice(0, firstIdx);
  const inRange = messages.slice(firstIdx, lastIdx + 1);
  const after = messages.slice(lastIdx + 1);

  return (
    <div className="space-y-0.5">
      {before.length > 0 && !showOlder && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setShowOlder(true)}
          className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground"
        >
          Show {before.length} older
        </Button>
      )}
      {showOlder && before.map((m) => (
        <MessageRow key={m.id} message={m} isAssociated={false} />
      ))}
      {inRange.map((m) => (
        <MessageRow key={m.id} message={m} isAssociated={associatedMessageIds.has(m.id)} />
      ))}
      {after.length > 0 && !showNewer && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setShowNewer(true)}
          className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground"
        >
          Show {after.length} newer
        </Button>
      )}
      {showNewer && after.map((m) => (
        <MessageRow key={m.id} message={m} isAssociated={false} />
      ))}
    </div>
  );
}

function MessageRow({ message: m, isAssociated }: { message: Message; isAssociated: boolean }) {
  return (
    <div
      className={`text-xs px-2 py-1 rounded break-words ${isAssociated ? 'bg-accent/40 border-l-2 border-l-foreground/30' : ''}`}
    >
      <span className="text-[10px] text-muted-foreground/50 tabular-nums mr-2">
        {formatDate(m.timestamp)}
      </span>
      <span className={isAssociated ? 'text-foreground' : 'text-muted-foreground/70'}>
        {m.cleanText}
      </span>
      <ReactionBadges reactions={m.reactions} className="inline-flex gap-1 ml-1" />
    </div>
  );
}
