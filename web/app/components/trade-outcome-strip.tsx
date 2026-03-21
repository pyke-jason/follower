import { Link } from 'react-router-dom';
import { Badge } from './badge';
import { formatCurrency, pnlColor } from '@/lib/format';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { safeParseFloat } from '@src/lib/numbers';
import { cn } from '@/lib/utils';
import { tradeQty } from '@src/lib/trade';
import { ArrowRight } from 'lucide-react';
import type { TradeOutcome } from '@src/lib/enriched-message';

export function TradeOutcomeStrip({
  trade,
  className,
}: {
  trade: TradeOutcome;
  className?: string;
}) {
  const href = useScopedHref();
  const hasPnl = trade.pnl != null;
  const pnl = safeParseFloat(trade.pnl);

  return (
    <div className={cn("flex items-center gap-2 py-1.5 ml-11 pr-4 text-xs border-t border-border/20", className)}>
      <Badge label={trade.direction} />
      <Badge label={trade.strategy} />
      <span className="font-medium text-foreground">{trade.symbol}</span>

      {trade.entryPrice && (
        <span className="text-muted-foreground tabular-nums">
          {formatCurrency(trade.entryPrice)}
        </span>
      )}
      {trade.exitPrice && (
        <>
          <span className="text-muted-foreground/50">&rarr;</span>
          <span className="text-muted-foreground tabular-nums">
            {formatCurrency(trade.exitPrice)}
          </span>
        </>
      )}

      {hasPnl ? (
        <span className={`font-semibold tabular-nums ${pnlColor(pnl)}`}>
          {formatCurrency(pnl)}
        </span>
      ) : (
        <span className="text-muted-foreground">--</span>
      )}

      <Badge label={trade.status} />

      {tradeQty(trade.quantity) > 1 && (
        <span className="text-muted-foreground">x{trade.quantity}</span>
      )}

      <Link
        to={href(`/trades/${trade.id}`)}
        className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}
