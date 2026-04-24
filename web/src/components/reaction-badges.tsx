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
          className="inline-flex items-center gap-1 text-[11px] text-foreground/80 bg-muted/60 border border-border/50 rounded-[4px] px-1.5 py-0.5"
        >
          <span>{REACTION_EMOJI[r.Type] ?? r.Type}</span>
          {r.Count > 1 && <span className="tabular-nums">{r.Count}</span>}
        </span>
      ))}
    </span>
  );
}
