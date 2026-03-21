import { useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { useSearchParam } from '@/hooks/use-search-param';
import { Card } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TradeRow } from './trade-row';
import { EventSubRows } from './event-sub-rows';
import { TradeDetailPanel } from './trade-detail-panel';
import { useTradesStore } from '@/stores/trades-store';
import { useChannelId } from '@/hooks/use-channel-id';
import { api } from '@/lib/api';
import { buildScopedPath } from '@/lib/channel-scope';
import { safeParseFloat } from '@src/lib/numbers';
import { computeTradeCommission } from '@src/lib/commission';
import type { SortColumn } from '@/stores/trades-store';

function getEffectivePnl(
  trade: {
    id: string;
    pnl: string | null;
    entryPrice: string | null;
    quantity: number | null;
    status: string;
    strategy: string;
    legs: unknown[] | null;
    metadata?: { openLegCount?: number } | null;
  },
  unrealizedPnl: Record<string, number>,
  commissionSchedule: Parameters<typeof computeTradeCommission>[1] | undefined,
): number | null {
  if (trade.pnl != null) {
    const gross = safeParseFloat(trade.pnl);
    const comm = commissionSchedule ? computeTradeCommission(trade, commissionSchedule) : 0;
    return gross - comm;
  }
  if (trade.id in unrealizedPnl) {
    return unrealizedPnl[trade.id];
  }
  return null;
}

// ── FLIP animation ─────────────────────────────────────
// Tracks Y positions of [data-trade-group] elements across renders.
// When order changes, animates each group from old → new position via WAAPI.
function useFlipAnimation(
  containerRef: React.RefObject<HTMLDivElement | null>,
  deps: unknown[],
) {
  const prevRectsRef = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const groups = container.querySelectorAll<HTMLElement>('[data-trade-group]');
    if (groups.length === 0) return;

    // Cancel ALL running animations FIRST so getBoundingClientRect()
    // returns true layout positions, not mid-transform animated ones.
    groups.forEach((el) => {
      el.getAnimations().forEach((a) => a.cancel());
    });

    // Read new positions — container-relative and scroll-stable
    const containerTop = container.getBoundingClientRect().top;
    const scrollTop = container.scrollTop;
    const newRects = new Map<string, number>();

    groups.forEach((el) => {
      const id = el.dataset.tradeGroup!;
      newRects.set(id, el.getBoundingClientRect().top - containerTop + scrollTop);
    });

    if (prevRectsRef.current.size > 0) {
      groups.forEach((el) => {
        const id = el.dataset.tradeGroup!;
        const prevY = prevRectsRef.current.get(id);
        const newY = newRects.get(id);
        if (prevY == null || newY == null) return;

        const delta = prevY - newY;
        if (Math.abs(delta) < 2) return;

        el.animate(
          [
            { transform: `translateY(${delta}px)` },
            { transform: 'translateY(0)' },
          ],
          {
            duration: 500,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            fill: 'none',
          },
        );
      });
    }

    prevRectsRef.current = newRects;
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

export function TradesTableClient() {
  const trades = useTradesStore((s) => s.trades);
  const eventsByTradeId = useTradesStore((s) => s.eventsByTradeId);
  const selectedTradeId = useTradesStore((s) => s.selectedTradeId);
  const selectTrade = useTradesStore((s) => s.selectTrade);
  const unrealizedPnl = useTradesStore((s) => s.unrealizedPnl);
  const setUnrealizedPnl = useTradesStore((s) => s.setUnrealizedPnl);
  const commissionSchedule = useTradesStore((s) => s.commissionSchedule);
  const sortColumn = useTradesStore((s) => s.sortColumn);
  const sortDirection = useTradesStore((s) => s.sortDirection);
  const setSort = useTradesStore((s) => s.setSort);
  const scrollRef = useRef<HTMLDivElement>(null);

  const channelId = useChannelId();
  const isLiveChannel = channelId ? !channelId.startsWith('bt:') : true;

  const [urlTradeId, setUrlTradeId] = useSearchParam('trade');

  // Poll unrealized P&L for live channels
  useQuery({
    queryKey: ['open-pnl', channelId],
    queryFn: () => api<Record<string, number>>(buildScopedPath('/open-pnl', channelId)),
    refetchInterval: 10_000,
    enabled: isLiveChannel,
    select: (data) => {
      setUnrealizedPnl(data);
      return data;
    },
  });

  // Sync URL → store
  useEffect(() => {
    if (urlTradeId !== selectedTradeId) selectTrade(urlTradeId);
  }, [urlTradeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setSelectedId = useCallback(
    (id: string | null) => {
      selectTrade(id);
      setUrlTradeId(id);
    },
    [selectTrade, setUrlTradeId],
  );

  // Sort trades
  const sortedTrades = useMemo(() => {
    const arr = [...trades];
    if (sortColumn === 'pnl') {
      arr.sort((a, b) => {
        const aPnl = getEffectivePnl(a, unrealizedPnl, commissionSchedule);
        const bPnl = getEffectivePnl(b, unrealizedPnl, commissionSchedule);
        if (aPnl == null && bPnl == null) return 0;
        if (aPnl == null) return 1;
        if (bPnl == null) return -1;
        return sortDirection === 'desc' ? bPnl - aPnl : aPnl - bPnl;
      });
    } else {
      arr.sort((a, b) => {
        const aDate = a.openedAt ?? '';
        const bDate = b.openedAt ?? '';
        return sortDirection === 'desc'
          ? bDate.localeCompare(aDate)
          : aDate.localeCompare(bDate);
      });
    }
    return arr;
  }, [trades, sortColumn, sortDirection, unrealizedPnl, commissionSchedule]);

  // FLIP animate trade groups when order changes
  useFlipAnimation(scrollRef, [sortedTrades]);

  const selectedTrade = selectedTradeId
    ? trades.find((t) => t.id === selectedTradeId) ?? null
    : null;

  if (trades.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">
        No trades.
      </p>
    );
  }

  const SortIcon = ({ column }: { column: SortColumn }) => {
    if (sortColumn !== column) return <ArrowUpDown className="h-3 w-3 opacity-30" />;
    return sortDirection === 'desc'
      ? <ArrowDown className="h-3 w-3" />
      : <ArrowUp className="h-3 w-3" />;
  };

  return (
    <TooltipProvider>
    <Card className="py-0 gap-0 overflow-hidden flex flex-col flex-1 min-h-0">
      <div className="flex flex-1 min-h-0">
        <div ref={scrollRef} className={`p-0 overflow-auto flex-1 min-h-0 ${selectedTrade ? 'max-w-[calc(100%-480px)]' : ''}`}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6" />
                <TableHead>Trade</TableHead>
                <TableHead>Trader</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Entry / Exit</TableHead>
                <TableHead
                  className="text-right cursor-pointer select-none hover:text-foreground transition-colors"
                  onClick={() => setSort('pnl')}
                >
                  <span className="inline-flex items-center gap-1 justify-end">
                    P&amp;L
                    <SortIcon column="pnl" />
                  </span>
                </TableHead>
                <TableHead
                  className="cursor-pointer select-none hover:text-foreground transition-colors"
                  onClick={() => setSort('openedAt')}
                >
                  <span className="inline-flex items-center gap-1">
                    Opened
                    <SortIcon column="openedAt" />
                  </span>
                </TableHead>
                <TableHead className="text-right">Exec</TableHead>
              </TableRow>
            </TableHeader>
            {sortedTrades.map((t) => {
              const events = eventsByTradeId[t.id] ?? [];
              return (
                <TableBody key={t.id} data-trade-group={t.id} className="relative">
                  <TradeRow
                    tradeId={t.id}
                    onExpand={() => setSelectedId(t.id)}
                    isExpanded={selectedTradeId === t.id}
                  />
                  <EventSubRows events={events} closeMessageId={t.closeMessageId} />
                </TableBody>
              );
            })}
          </Table>
        </div>

        {selectedTrade && (
          <div className="w-[480px] shrink-0 border-l border-border overflow-auto bg-background">
            <TradeDetailPanel onClose={() => setSelectedId(null)} />
          </div>
        )}
      </div>
    </Card>
    </TooltipProvider>
  );
}
