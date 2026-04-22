import type { ReactNode } from 'react';
import { CircleCheckBig } from 'lucide-react';
import { OrderPanel } from '@/components/order/order-panel';
import { Badge } from '@/components/badge';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { cn } from '@/lib/utils';
import { safeParseFloat } from '@src/lib/numbers';
import type { Trade } from '@src/db/schema';
import { DetailPanel } from './detail-panel';

export function TradeStatusPanel({ trade }: { trade: Trade }) {
  const isOpen = trade.status === 'OPEN';
  const exitPrice = safeParseFloat(trade.exitPrice);
  const realizedPnl = safeParseFloat(trade.pnl);

  if (isOpen) {
    return (
      <DetailPanel
        title="Exit position"
        description="One close flow only. Use a limit when you want price control, or switch the order form to market when you just want out."
        eyebrow="Execution"
        action={<Badge label="OPEN" />}
      >
        <OrderPanel trade={trade} />
      </DetailPanel>
    );
  }

  return (
    <DetailPanel
      title="Position settled"
      description="This trade is closed. The timeline and trader message trail remain available for audit, but new exit orders are disabled."
      eyebrow="Status"
      action={<Badge label="CLOSED" />}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <StatusMetric label="Closed">
          <span className="text-sm font-semibold tabular-nums">
            {trade.closedAt ? formatDate(trade.closedAt) : 'Recorded'}
          </span>
        </StatusMetric>
        <StatusMetric label="Exit Price">
          <span className="text-sm font-semibold font-mono tabular-nums">
            {exitPrice != null ? formatCurrency(exitPrice) : '—'}
          </span>
        </StatusMetric>
        <StatusMetric label="Realized P&L">
          <span className={cn('text-sm font-semibold font-mono tabular-nums', pnlColor(realizedPnl))}>
            {realizedPnl != null ? formatCurrency(realizedPnl) : '—'}
          </span>
        </StatusMetric>
      </div>

      <div className="mt-4 flex items-start gap-3 rounded-2xl border border-border/60 bg-background/70 px-4 py-3">
        <CircleCheckBig className="mt-0.5 size-4 text-profit" />
        <div className="space-y-1 text-sm">
          <p className="font-medium text-foreground">Exit workflow complete</p>
          <p className="text-muted-foreground">
            The detail view now reflects the settled state instead of keeping the order form live.
          </p>
        </div>
      </div>
    </DetailPanel>
  );
}

function StatusMetric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-background/80 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-2">{children}</div>
    </div>
  );
}
