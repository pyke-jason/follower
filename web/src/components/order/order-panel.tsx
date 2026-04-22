import { OrderProvider, useOrderContext } from './order-context';
import { QuoteStrip } from './quote-strip';
import { OrderEntryForm } from './order-entry-form';
import { WorkingOrderCard } from './working-order-card';
import { Spinner } from '@/components/ui/spinner';
import { formatLegsSummary, tradeQty } from '@src/lib/trade';
import type { Trade } from '@src/db/schema';

type OrderPanelProps = {
  trade: Trade;
};

export function OrderPanel({ trade }: OrderPanelProps) {
  return (
    <OrderProvider trade={trade}>
      <OrderPanelContent />
    </OrderProvider>
  );
}

function OrderPanelContent() {
  const { trade, lifecycle } = useOrderContext();
  const { activeOrderId, orderStatus } = lifecycle;

  const contractSummary = formatLegsSummary(trade.legs, trade.strategy);
  const isFilledExit = orderStatus?.status === 'FILLED';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{trade.symbol}</span>
        {contractSummary && (
          <span className="text-xs font-mono text-muted-foreground">{contractSummary}</span>
        )}
        <span className="text-xs text-muted-foreground">
          {tradeQty(trade.quantity)} × {trade.strategy}
        </span>
      </div>

      <QuoteStrip symbol={trade.legs[0]?.symbol ?? trade.symbol} channelId={trade.channelId} />

      {activeOrderId ? (
        <WorkingOrderCard />
      ) : isFilledExit ? (
        <div className="flex items-start gap-3 rounded-2xl border border-border/60 bg-background/80 px-4 py-3 text-sm">
          <Spinner className="mt-0.5 size-4 text-muted-foreground" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">Exit filled</p>
            <p className="text-muted-foreground">
              Refreshing the trade record so this page can switch into its settled state.
            </p>
          </div>
        </div>
      ) : (
        <OrderEntryForm />
      )}
    </div>
  );
}
