import { REACTION_EMOJI } from '@/components/decision-shared';
import type { MessageReaction } from '@src/db/schema';

export function ReactionBadges({
  reactions,
  className = 'flex gap-1 mt-0.5',
}: {
  reactions: MessageReaction[];
  className?: string;
}) {
  if (!reactions || reactions.length === 0) return null;
  return (
    <span className={className}>
      {reactions.map((r) => (
        <span
          key={r.Type}
          className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/60 bg-muted/40 rounded px-1 py-px"
        >
          <span>{REACTION_EMOJI[r.Type] ?? r.Type}</span>
          {r.Count > 1 && <span className="tabular-nums">{r.Count}</span>}
        </span>
      ))}
    </span>
  );
}
