import { useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SortableHead } from './sortable-head';
import { useSearchParam } from '@/hooks/use-search-param';
import { createFilterParams } from '@/hooks/use-filter-params';
import { Card } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TradeRow } from './trade-row';
import { EventSubRows } from './event-sub-rows';
import { TradeDetailPanel } from '@/views/trades/[id]/trade-detail-panel';
import { EmptyState } from './empty-state';
import { useTradesStore } from '@/stores/trades-store';
import { useChannelId } from '@/hooks/use-channel-id';
import { api } from '@/lib/api';
import { buildScopedPath } from '@/lib/channel-scope';
import { safeParseFloat } from '@src/lib/numbers';
import { computeTradeCommission } from '@src/lib/commission';
type SortColumn = 'pnl' | 'openedAt';

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

// ── URL-synced sort params ──────────────────────────────
const useTradeSortParams = createFilterParams({
  sort: { type: 'sort', defaultColumn: 'openedAt', defaultDir: 'desc' },
});

type LivePosition = { unrealizedPnl: number; marketValue: number | null };
const EMPTY_POSITIONS: Record<string, LivePosition> = {};

export function TradesTableClient() {
  const trades = useTradesStore((s) => s.trades);
  const eventsByTradeId = useTradesStore((s) => s.eventsByTradeId);
  const labelsByTradeId = useTradesStore((s) => s.labelsByTradeId);
  const selectedTradeId = useTradesStore((s) => s.selectedTradeId);
  const selectTrade = useTradesStore((s) => s.selectTrade);
  const commissionSchedule = useTradesStore((s) => s.commissionSchedule);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasLabels = Object.keys(labelsByTradeId).length > 0;

  // Sort from URL params
  const sortParams = useTradeSortParams();
  const sortColumn = sortParams.sort.column as SortColumn;
  const sortDirection = sortParams.sort.dir;
  const setSort = sortParams.setSort;

  const channelId = useChannelId();
  const isLiveChannel = channelId ? !channelId.startsWith('bt:') : true;

  const [urlTradeId, setUrlTradeId] = useSearchParam('trade');

  // Poll live broker positions for open trades.
  const openPnlQuery = useQuery({
    queryKey: ['open-pnl', channelId],
    queryFn: () => api<Record<string, LivePosition>>(buildScopedPath('/open-pnl', channelId)),
    refetchInterval: 10_000,
    enabled: isLiveChannel,
  });
  const livePositions = openPnlQuery.data ?? EMPTY_POSITIONS;
  const unrealizedPnl = useMemo(() => {
    const map: Record<string, number> = {};
    for (const [id, pos] of Object.entries(livePositions)) map[id] = pos.unrealizedPnl;
    return map;
  }, [livePositions]);

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


  const selectedTrade = selectedTradeId
    ? trades.find((t) => t.id === selectedTradeId) ?? null
    : null;

  if (trades.length === 0) {
    return <EmptyState title="No trades" />;
  }

  const sort = { column: sortColumn, dir: sortDirection as 'asc' | 'desc' };

  return (
    <Card className="py-0 gap-0 overflow-hidden flex flex-col flex-1 min-h-0">
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
        <ResizablePanel defaultSize={55} minSize={35}>
          <ScrollArea className="h-full">
            <div ref={scrollRef}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-6" />
                    <SortableHead column="openedAt" label="Position" sort={sort} onSort={setSort} />
                    <SortableHead column="pnl" label="Mark / P&L" sort={sort} onSort={setSort} align="right" />
                    {hasLabels && <TableHead className="w-8 text-center">Label</TableHead>}
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
                        showLabel={hasLabels}
                        livePosition={livePositions[t.id]}
                      />
                      <EventSubRows events={events} closeMessageId={t.closeMessageId} extraCells={hasLabels ? 1 : 0} />
                    </TableBody>
                  );
                })}
              </Table>
            </div>
          </ScrollArea>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={45} minSize={25}>
          <ScrollArea className="h-full">
            {selectedTrade ? (
              <TradeDetailPanel onClose={() => setSelectedId(null)} />
            ) : (
              <EmptyState title="Select a trade" hint="Click a row to view details" />
            )}
          </ScrollArea>
        </ResizablePanel>
      </ResizablePanelGroup>
    </Card>
  );
}
