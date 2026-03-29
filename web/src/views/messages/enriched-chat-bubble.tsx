import { useState } from 'react';
import { ChatBubble } from './chat-bubble';
import { TradeOutcomeStrip } from '@/components/trade-outcome-strip';
import { TaskDetailDialog } from './task-detail-dialog';
import { getMessageRole } from '@src/lib/enriched-message';
import type { EnrichedMessage } from '@src/lib/enriched-message';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/badge';
import { InfoChip } from '@/components/info-chip';
import { fmtMs } from '@/components/decision-shared';
import { formatCurrency, pnlColor } from '@/lib/format';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

function DecisionIndicator({
  enriched,
  onClick,
}: {
  enriched: EnrichedMessage;
  onClick: () => void;
}) {
  const { decision, trade } = enriched;
  if (!decision) return null;

  return (
    <Button
      variant="ghost"
      className="justify-start w-full h-auto py-0.5 gap-1.5 pl-11 pr-4 text-[11px] text-muted-foreground/70 hover:text-muted-foreground group"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Badge label={decision.outcome} />
      {decision.phase && <InfoChip label={decision.phase} />}
      {decision.durationMs != null && (
        <span className="tabular-nums">{fmtMs(decision.durationMs)}</span>
      )}
      {decision.pnl != null && !trade?.pnl && (
        <span className={cn('font-medium tabular-nums', pnlColor(decision.pnl))}>
          {formatCurrency(decision.pnl)}
        </span>
      )}
      {decision.outcome === 'SKIP' && decision.reasoning && (
        <span className="italic truncate max-w-[300px]">
          {decision.reasoning}
        </span>
      )}
      <ChevronRight className="h-3 w-3 ml-auto opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </Button>
  );
}

export function EnrichedChatBubble({
  enriched,
  isHighlighted,
  isPending,
}: {
  enriched: EnrichedMessage;
  isHighlighted?: boolean;
  isPending?: boolean;
}) {
  const role = getMessageRole(enriched);
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
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
          <TradeOutcomeStrip trade={enriched.trade} />
        )}
        <DecisionIndicator enriched={enriched} onClick={() => setDialogOpen(true)} />
      </div>
      {dialogOpen && (
        <TaskDetailDialog
          enriched={enriched}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}
    </>
  );
}
