import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatCurrency, pnlColor } from '@/lib/format';
import { contractMultiplier, tradeQty } from '@src/lib/trade';
import { safeParseFloat } from '@src/lib/numbers';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { cn } from '@/lib/utils';
import type { Trade } from '@src/db/schema';
import type { LivePositionRow } from '@/lib/page-adapters';

type WatchlistRow = {
  id: string;
  symbol: string;
  subLabel: string;
  mark: number | null;
  unrealizedPnl: number | null;
  unrealizedPct: number | null;
  absPnl: number;
};

/**
 * Robinhood-style position watchlist — dense, sortable, filterable list of
 * open positions along the right edge of the dashboard. Each row is a link to
 * the trade detail page.
 */
export function PositionsWatchlist({ trades, livePositionsByTradeId }: {
  trades: Trade[];
  livePositionsByTradeId: Record<string, LivePositionRow>;
}) {
  const href = useScopedHref();
  const { pathname } = useLocation();
  const [query, setQuery] = useState('');

  const rows = useMemo<WatchlistRow[]>(() => {
    return trades.map((t) => {
      const qty = tradeQty(t.quantity);
      const mult = contractMultiplier(t.strategy);
      const entry = safeParseFloat(t.avgEntryPrice) || safeParseFloat(t.entryPrice);
      const costBasis = entry ? entry * qty * mult : null;
      const live = livePositionsByTradeId[t.id];
      const mark = live?.marketValue != null && qty > 0 ? live.marketValue / (qty * mult) : null;
      const unrealizedPnl = live?.unrealizedPnl ?? null;
      const unrealizedPct = unrealizedPnl != null && costBasis
        ? (unrealizedPnl / Math.abs(costBasis)) * 100
        : null;
      const subLabel = t.strategy === 'STOCK'
        ? `${qty} sh · ${t.direction}`
        : `${qty}× ${t.strategy} · ${t.direction}`;

      return {
        id: t.id,
        symbol: t.symbol,
        subLabel,
        mark,
        unrealizedPnl,
        unrealizedPct,
        absPnl: Math.abs(unrealizedPnl ?? 0),
      };
    }).sort((a, b) => b.absPnl - a.absPnl);
  }, [trades, livePositionsByTradeId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.symbol.toLowerCase().includes(q));
  }, [rows, query]);

  return (
    <div className="flex flex-col h-full border-l border-border/40">
      <div className="px-4 py-3 border-b border-border/40">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold">Positions</h2>
          <span className="text-xs text-muted-foreground tabular-nums">{rows.length}</span>
        </div>
        <Input
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 text-xs"
        />
      </div>

      <ScrollArea className="flex-1">
        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            {query ? 'No matches' : 'No open positions'}
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {filtered.map((r) => (
              <li key={r.id}>
                <Link
                  to={href(`/trades/${r.id}`, { from: pathname })}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-accent/40 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-sm tracking-tight truncate">{r.symbol}</p>
                    <p className="text-[10px] text-muted-foreground/70 tabular-nums truncate mt-0.5">
                      {r.subLabel}
                    </p>
                  </div>
                  <div className="text-right shrink-0 min-w-0">
                    <p className="text-sm font-mono tabular-nums font-medium">
                      {r.mark != null ? formatCurrency(r.mark) : <span className="text-muted-foreground/40">—</span>}
                    </p>
                    {r.unrealizedPct != null ? (
                      <p className={cn('text-[10px] tabular-nums font-medium', pnlColor(r.unrealizedPnl))}>
                        {r.unrealizedPct > 0 ? '+' : ''}{r.unrealizedPct.toFixed(2)}%
                      </p>
                    ) : (
                      <p className="text-[10px] text-muted-foreground/40">—</p>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
