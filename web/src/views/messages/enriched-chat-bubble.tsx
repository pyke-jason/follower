import { useState } from 'react';
import { ChatBubble } from './chat-bubble';
import { TradeOutcomeStrip } from '@/components/trade-outcome-strip';
import { TaskDetailDialog } from './task-detail-dialog';
import type { EnrichedMessage } from '@src/lib/enriched-message';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/badge';
import { InfoChip } from '@/components/info-chip';
import { fmtMs } from '@/components/decision-shared';
import { formatCurrency, pnlColor } from '@/lib/format';

function formatSignedCurrency(value: number | string | null | undefined): string {
  const numeric = typeof value === 'string' ? Number(value) : value;
  const sign = numeric != null && numeric > 0 ? '+' : '';
  return `${sign}${formatCurrency(value)}`;
}

function summarizeSignal(signal: NonNullable<NonNullable<EnrichedMessage['intent']>['signals']>[number]): string {
  const parts = [
    signal.action,
    signal.strategy,
    signal.symbol,
    signal.direction,
  ].filter(Boolean);
  const base = parts.join(' ');
  return signal.statedPrice != null ? `${base} @ ${formatCurrency(signal.statedPrice)}` : base;
}

function summarizeIntent(intent: NonNullable<EnrichedMessage['intent']>): string | null {
  const firstSignal = intent.signals?.[0];
  if (firstSignal) return summarizeSignal(firstSignal);
  return intent.reasoning;
}

function DecisionIndicator({
  enriched,
  onClick,
}: {
  enriched: EnrichedMessage;
  onClick: () => void;
}) {
  const { decision, intent, trade } = enriched;
  if (!decision && !intent && !trade) return null;
  const intentSummary = intent ? summarizeIntent(intent) : null;

  return (
    <div className="pl-11 pr-4 pb-1.5 text-[11px] text-muted-foreground/80">
      <div className="flex flex-wrap items-center gap-1.5">
        {intent && (
          <>
            <span className="text-muted-foreground/60">Intent</span>
            <Badge label={intent.decision} />
            <InfoChip label={intent.route} />
            {intent.durationMs != null && (
              <span className="tabular-nums">{fmtMs(intent.durationMs)}</span>
            )}
            {intentSummary && (
              <span className="text-foreground/80 truncate max-w-[420px]">
                {intentSummary}
              </span>
            )}
          </>
        )}

        {decision && (
          <>
            {intent && <span className="text-muted-foreground/35">/</span>}
            <span className="text-muted-foreground/60">Final</span>
            <Badge label={decision.outcome} />
            {decision.phase && <InfoChip label={decision.phase} />}
            {decision.durationMs != null && (
              <span className="tabular-nums">{fmtMs(decision.durationMs)}</span>
            )}
            {decision.pnl != null && !trade?.pnl && (
              <span className={cn('font-medium tabular-nums', pnlColor(decision.pnl))}>
                {formatSignedCurrency(decision.pnl)}
              </span>
            )}
            {decision.reasoning && (
              <span className="italic truncate max-w-[360px]">
                {decision.reasoning}
              </span>
            )}
          </>
        )}

        {(decision || trade) && (
          <InfoChip label="Details" onClick={onClick} className="ml-auto" />
        )}
      </div>
      {trade?.pnl && (
        <span className={cn('mt-1 inline-block font-medium tabular-nums', pnlColor(trade.pnl))}>
          Trade P&L {formatSignedCurrency(trade.pnl)}
        </span>
      )}
    </div>
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
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <div
        className={cn(
          isHighlighted && 'bg-info/5 ring-1 ring-inset ring-info/20',
          isPending && 'opacity-40',
        )}
      >
        <ChatBubble message={enriched.message} noBorder />
        {enriched.trade && (
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
