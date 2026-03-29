import { Link } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/badge';
import { InfoChip } from '@/components/info-chip';
import { TradeOutcomeStrip } from '@/components/trade-outcome-strip';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { fmtMs } from '@/components/decision-shared';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { cn } from '@/lib/utils';
import { ArrowRight } from 'lucide-react';
import type { EnrichedMessage } from '@src/lib/enriched-message';

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
  const { decision, trade, message } = enriched;

  const symbol = trade?.symbol ?? message.symbols?.[0] ?? 'Signal';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {symbol}
            {decision && <Badge label={decision.outcome} />}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {message.author} &middot; {formatDate(message.timestamp)}
          </DialogDescription>
        </DialogHeader>

        {decision && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
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
          </div>
        )}

        {trade && (
          <div className="border-t border-border/40 -mx-6 px-6">
            <TradeOutcomeStrip trade={trade} className="ml-0 pr-0 border-t-0" />
          </div>
        )}

        <div className="flex items-center gap-3 pt-1 border-t border-border/40">
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
              to={href(`/trades/${trade.id}`)}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => onOpenChange(false)}
            >
              View Trade <ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
