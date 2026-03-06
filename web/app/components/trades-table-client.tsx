import { useCallback, useEffect, useLayoutEffect, useRef, Fragment } from 'react';
import { useSearchParam } from '@/hooks/use-search-param';
import { Card } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TradeRow } from './trade-row';
import { EventSubRows } from './event-sub-rows';
import { TradeDetailPanel } from './trade-detail-panel';
import { useTradesStore } from '@/stores/trades-store';

export function TradesTableClient() {
  const trades = useTradesStore((s) => s.trades);
  const eventsByTradeId = useTradesStore((s) => s.eventsByTradeId);
  const selectedTradeId = useTradesStore((s) => s.selectedTradeId);
  const selectTrade = useTradesStore((s) => s.selectTrade);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevFirstIdRef = useRef<string | null>(null);
  const savedAnchorRef = useRef<{ id: string; scrollTop: number; offsetTop: number } | null>(null);

  const [urlTradeId, setUrlTradeId] = useSearchParam('trade');

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

  // Scroll anchoring: capture pre-render position during render phase,
  // then restore in useLayoutEffect (before paint) so there's no visible jump.
  const currentFirstId = trades[0]?.id ?? null;
  if (prevFirstIdRef.current && currentFirstId !== prevFirstIdRef.current) {
    const container = scrollRef.current;
    if (container) {
      const anchor = container.querySelector(`[data-trade-id="${prevFirstIdRef.current}"]`);
      if (anchor instanceof HTMLElement) {
        savedAnchorRef.current = {
          id: prevFirstIdRef.current,
          scrollTop: container.scrollTop,
          offsetTop: anchor.offsetTop,
        };
      }
    }
  }
  prevFirstIdRef.current = currentFirstId;

  useLayoutEffect(() => {
    const saved = savedAnchorRef.current;
    savedAnchorRef.current = null;
    if (!saved) return;

    const container = scrollRef.current;
    if (!container) return;

    const anchor = container.querySelector(`[data-trade-id="${saved.id}"]`);
    if (!(anchor instanceof HTMLElement)) return;

    // Anchor moved down by (new offsetTop - old offsetTop). Shift scroll to compensate.
    container.scrollTop = saved.scrollTop + (anchor.offsetTop - saved.offsetTop);
  }, [trades]);

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
                <TableHead className="text-right">P&amp;L</TableHead>
                <TableHead>Opened</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.map((t) => {
                const events = eventsByTradeId[t.id] ?? [];
                return (
                  <Fragment key={t.id}>
                    <TradeRow
                      tradeId={t.id}
                      onExpand={() => setSelectedId(t.id)}
                      isExpanded={selectedTradeId === t.id}
                    />
                    <EventSubRows events={events} closeMessageId={t.closeMessageId} />
                  </Fragment>
                );
              })}
            </TableBody>
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
