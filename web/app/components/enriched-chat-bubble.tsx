import { ChatBubble } from '../messages/chat-bubble';
import { TradeOutcomeStrip } from './trade-outcome-strip';
import { getMessageRole } from '@src/lib/enriched-message';
import type { EnrichedMessage } from '@src/lib/enriched-message';
import { cn } from '@/lib/utils';

function SkipReasonChip({ reason }: { reason: string }) {
  const short = reason.length > 100 ? reason.slice(0, 97) + '...' : reason;
  return (
    <div className="py-0.5 ml-11 text-[11px] text-muted-foreground/50 italic">
      skipped: {short}
    </div>
  );
}

export function EnrichedChatBubble({
  enriched,
  runId,
  isHighlighted,
  isPending,
}: {
  enriched: EnrichedMessage;
  runId?: string;
  isHighlighted?: boolean;
  isPending?: boolean;
}) {
  const role = getMessageRole(enriched);

  return (
    <div
      className={cn(
        'border-l-2',
        role === 'executed' && 'border-l-profit/40 bg-profit/[0.03]',
        role === 'skipped' && 'border-l-amber-400/40',
        role === 'noise' && 'border-l-transparent',
        isHighlighted && 'bg-info/5 ring-1 ring-inset ring-info/20',
        isPending && 'opacity-40',
      )}
    >
      <ChatBubble message={enriched.message} noBorder />
      {role === 'executed' && enriched.trade && (
        <TradeOutcomeStrip trade={enriched.trade} runId={runId} />
      )}
      {role === 'skipped' && enriched.decision?.reasoning && (
        <SkipReasonChip reason={enriched.decision.reasoning} />
      )}
    </div>
  );
}
