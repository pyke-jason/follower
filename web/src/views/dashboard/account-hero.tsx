import { formatCurrency, pnlColor } from '@/lib/format';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown } from 'lucide-react';
import type { AccountBalanceSnapshot } from '@/lib/page-adapters';

/**
 * Robinhood-style account hero: huge equity number top-left, day change
 * underneath in the P&L color. All live data — no card chrome, just typography
 * so the number carries the page.
 */
export function AccountHero({ balance, unrealizedPnl, realizedToday, accountLabel }: {
  balance: AccountBalanceSnapshot | null;
  unrealizedPnl: number;
  realizedToday: number;
  accountLabel: string;
}) {
  const netLiq = balance?.equity ?? 0;
  const dayChange = unrealizedPnl + realizedToday;
  const dayChangePct = netLiq > 0 ? (dayChange / netLiq) * 100 : 0;
  const Icon = dayChange >= 0 ? TrendingUp : TrendingDown;
  const color = pnlColor(dayChange);

  return (
    <div>
      <p className="text-xs text-muted-foreground tracking-wide uppercase mb-1">
        {accountLabel}
      </p>
      <h1 className="text-5xl font-bold tracking-tight tabular-nums font-mono">
        {balance
          ? formatCurrency(netLiq, 2)
          : <span className="text-muted-foreground/40">—</span>}
      </h1>
      <div className={cn('mt-2 flex items-center gap-2 text-sm font-medium', color)}>
        <Icon className="h-4 w-4" />
        <span className="tabular-nums font-mono">
          {dayChange >= 0 ? '+' : ''}{formatCurrency(dayChange, 2)}
          {netLiq > 0 && (
            <span className="ml-1 opacity-80">({dayChange >= 0 ? '+' : ''}{dayChangePct.toFixed(2)}%)</span>
          )}
        </span>
        <span className="text-muted-foreground font-normal">Today</span>
      </div>
    </div>
  );
}
