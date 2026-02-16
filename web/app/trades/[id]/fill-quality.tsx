import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import type { Trade } from '../../../../src/db/schema';
import { safeParseFloat } from '../../../../src/lib/numbers';

export function FillQuality({ trade }: { trade: Trade }) {
  const expectedPrice = safeParseFloat(trade.entryPrice);
  const brokerPrice = safeParseFloat(trade.brokerFillPrice);
  const commission = safeParseFloat(trade.brokerCommission);

  if (!brokerPrice && !commission && !trade.brokerFillTime) return null;

  const slippage = expectedPrice && brokerPrice ? brokerPrice - expectedPrice : null;
  const slippagePct = expectedPrice && slippage ? (slippage / expectedPrice) * 100 : null;

  // Time to fill
  let timeToFill: string | null = null;
  if (trade.openedAt && trade.brokerFillTime) {
    const diff = new Date(trade.brokerFillTime).getTime() - new Date(trade.openedAt).getTime();
    if (diff > 0) {
      const seconds = Math.round(diff / 1000);
      timeToFill = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
    }
  }

  const legFills = trade.brokerLegFills as { symbol: string; fillPrice: number; fillQty: number; side: string }[] | null;

  return (
    <Card className="py-0 gap-0">
      <CardHeader className="border-b py-3 px-4">
        <CardTitle className="text-sm font-medium">Fill Quality</CardTitle>
      </CardHeader>
      <CardContent className="py-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          {brokerPrice !== 0 && (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Broker Fill</p>
              <p className="text-foreground font-medium tabular-nums">{formatCurrency(brokerPrice)}</p>
            </div>
          )}
          {expectedPrice !== 0 && (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Expected</p>
              <p className="text-foreground font-medium tabular-nums">{formatCurrency(expectedPrice)}</p>
            </div>
          )}
          {slippage !== null && (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Slippage</p>
              <p className={`font-medium tabular-nums ${slippage > 0 ? 'text-loss' : slippage < 0 ? 'text-profit' : 'text-foreground'}`}>
                {formatCurrency(slippage)}
                {slippagePct !== null && (
                  <span className="text-xs text-muted-foreground ml-1">({slippagePct.toFixed(2)}%)</span>
                )}
              </p>
            </div>
          )}
          {commission !== 0 && (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Commission</p>
              <p className="text-foreground font-medium tabular-nums">{formatCurrency(commission)}</p>
            </div>
          )}
          {trade.brokerFillQty && (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Fill Qty</p>
              <p className="text-foreground font-medium tabular-nums">{trade.brokerFillQty}</p>
            </div>
          )}
          {timeToFill && (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Time to Fill</p>
              <p className="text-foreground font-medium tabular-nums">{timeToFill}</p>
            </div>
          )}
        </div>

        {/* Per-leg fills */}
        {legFills && legFills.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/50">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Leg Fills</p>
            <div className="space-y-1">
              {legFills.map((leg, i) => (
                <div key={i} className="flex items-center gap-3 text-xs">
                  <span className="font-medium text-foreground">{leg.symbol}</span>
                  <span className="text-muted-foreground">{leg.side}</span>
                  <span className="tabular-nums">{leg.fillQty} @ {formatCurrency(leg.fillPrice)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
