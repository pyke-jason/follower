import { formatCurrency, pnlColor } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AccountBalanceSnapshot } from '@/lib/page-adapters';

/**
 * Primary account readout. The dashboard is built around live unrealized P&L;
 * net liquidation is account context, not the hero number.
 */
export function AccountHero({ balance, unrealizedPnl, realizedToday, openTrades, accountLabel }: {
  balance: AccountBalanceSnapshot | null;
  unrealizedPnl: number;
  realizedToday: number;
  openTrades: number;
  accountLabel: string;
}) {
  const netLiq = balance?.equity ?? 0;
  const exposurePct = netLiq > 0 ? (unrealizedPnl / netLiq) * 100 : 0;
  const color = pnlColor(unrealizedPnl);

  return (
    <div>
      <p className="text-xs text-muted-foreground tracking-wide uppercase mb-1">
        {accountLabel}
      </p>
      <h1 className={cn('text-5xl font-bold tracking-tight tabular-nums font-mono', color)}>
        {unrealizedPnl >= 0 ? '+' : ''}{formatCurrency(unrealizedPnl, 2)}
      </h1>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium text-muted-foreground">
          Unrealized P&L across {openTrades} open position{openTrades === 1 ? '' : 's'}
        </span>
        {netLiq > 0 && (
          <span className={cn('tabular-nums font-mono', color)}>
            {unrealizedPnl >= 0 ? '+' : ''}{exposurePct.toFixed(2)}% of net liq
          </span>
        )}
        {balance && (
          <span className="text-muted-foreground">
            Net liq <span className="font-mono tabular-nums text-foreground">{formatCurrency(netLiq, 2)}</span>
          </span>
        )}
        <span className="text-muted-foreground">
          Realized today{' '}
          <span className={cn('font-mono tabular-nums', realizedToday === 0 ? 'text-muted-foreground' : pnlColor(realizedToday))}>
            {realizedToday > 0 ? '+' : ''}{formatCurrency(realizedToday, 2)}
          </span>
        </span>
      </div>
    </div>
  );
}
