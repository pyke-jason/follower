import { Link, useLocation } from 'react-router-dom';
import { Badge } from '@/components/badge';
import { InfoChip } from '@/components/info-chip';
import { TradeOutcomeStrip } from '@/components/trade-outcome-strip';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { fmtMs } from '@/components/decision-shared';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ArrowRight, X } from 'lucide-react';
import type { EnrichedMessage } from '@src/lib/enriched-message';

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

export function TaskDetailDialog({
  enriched,
  open,
  onOpenChange,
}: {
  enriched: EnrichedMessage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const href = useScopedHref();
  const { pathname } = useLocation();
  const { decision, trade, message, intent } = enriched;

  const symbol = trade?.symbol ?? message.symbols?.[0] ?? 'Signal';
  const intentSummary = intent ? summarizeIntent(intent) : null;

  if (!open) return null;

  return (
    <div className="ml-11 mr-4 mb-2 rounded-md border border-border/60 bg-muted/20 p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-base font-semibold">
            <span>{symbol}</span>
            {intent && <Badge label={intent.decision} />}
            {decision && <Badge label={decision.outcome} />}
          </div>
          <p className="text-xs text-muted-foreground">
            {message.author} &middot; {formatDate(message.timestamp)}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => onOpenChange(false)}
          aria-label="Close details"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="mt-3 space-y-3">
        {intent && (
          <section className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground">Intent</span>
              <Badge label={intent.decision} />
              <InfoChip label={intent.route} />
              <InfoChip label={`${intent.model} v${intent.version}`} />
              {intent.durationMs != null && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {fmtMs(intent.durationMs)}
                </span>
              )}
            </div>
            {intentSummary && (
              <p className="text-sm text-foreground/85 leading-relaxed">
                {intentSummary}
              </p>
            )}
            {intent.reasoning && intent.reasoning !== intentSummary && (
              <p className="text-sm text-muted-foreground leading-relaxed">
                {intent.reasoning}
              </p>
            )}
          </section>
        )}

        {decision && (
          <section className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground">Final</span>
              <Badge label={decision.outcome} />
              {decision.phase && <InfoChip label={decision.phase} />}
              {decision.durationMs != null && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {fmtMs(decision.durationMs)}
                </span>
              )}
              {decision.pnl != null && (
                <span className={cn('text-sm font-medium tabular-nums', pnlColor(decision.pnl))}>
                  {formatCurrency(decision.pnl)}
                </span>
              )}
            </div>
            {decision.reasoning && (
              <p className="text-sm text-muted-foreground leading-relaxed">
                {decision.reasoning}
              </p>
            )}
          </section>
        )}

        {trade && (
          <div className="border-t border-border/40">
            <TradeOutcomeStrip trade={trade} className="!ml-0 pr-0 border-t-0" />
          </div>
        )}

        {(decision?.taskId || trade) && (
          <div className="flex items-center gap-3 pt-2 border-t border-border/40">
            {decision?.taskId && (
              <Link
                to={href(`/tasks/${decision.taskId}`)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => onOpenChange(false)}
              >
                View Task <ArrowRight className="h-3 w-3" />
              </Link>
            )}
            {trade && (
              <Link
                to={href(`/trades/${trade.id}`, { from: pathname })}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => onOpenChange(false)}
              >
                View Trade <ArrowRight className="h-3 w-3" />
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
