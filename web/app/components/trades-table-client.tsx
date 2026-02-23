'use client';

import { useState, useEffect, useTransition, useRef, Fragment } from 'react';
import dynamic from 'next/dynamic';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table';
import { Badge } from './badge';
import { TradeRow } from './trade-row';
import { TradeStoryExpander } from './trade-story-expander';
import { fetchTradeLinkedMessages } from '../trades/actions';
import { formatCurrency, pnlColor } from '@/lib/format';
import { X } from 'lucide-react';
import type { Trade, CommissionSchedule } from '../../../src/db/schema';

const ChatFeed = dynamic(
  () => import('../messages/chat-feed').then((m) => ({ default: m.ChatFeed })),
  { ssr: false },
);

const TOTAL_COLUMNS = 13;

export function TradesTableClient({
  trades,
  runId,
  commissionSchedule,
  enableChatPanel,
}: {
  trades: Trade[];
  runId?: string;
  commissionSchedule?: CommissionSchedule;
  enableChatPanel?: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const [chatContext, setChatContext] = useState<Awaited<ReturnType<typeof fetchTradeLinkedMessages>> | null>(null);
  const [isLoading, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState<string | undefined>(undefined);

  // Measure available height once on mount (for backtest layout with chat panel)
  useEffect(() => {
    if (!enableChatPanel || !containerRef.current) return;
    const top = containerRef.current.getBoundingClientRect().top;
    setContainerHeight(`calc(100vh - ${Math.round(top)}px - 1.5rem)`);
  }, [enableChatPanel]);

  // Load chat context when a trade is selected (backtest mode)
  useEffect(() => {
    if (!selectedTrade || !enableChatPanel) {
      setChatContext(null);
      return;
    }
    startTransition(async () => {
      const result = await fetchTradeLinkedMessages(selectedTrade.id);
      const desc = [...result.messages].reverse();
      setChatContext({ ...result, messages: desc });
    });
  }, [selectedTrade?.id, enableChatPanel]);

  if (trades.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">
        No trades.
      </p>
    );
  }

  const table = (
    <Card className="py-0 gap-0 overflow-hidden flex-1 min-w-0 flex flex-col">
      <CardContent className="p-0 overflow-auto flex-1 min-h-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-6"></TableHead>
              <TableHead>Symbol</TableHead>
              <TableHead className="hidden md:table-cell">Legs</TableHead>
              <TableHead>Trader</TableHead>
              <TableHead>Direction</TableHead>
              <TableHead>Strategy</TableHead>
              <TableHead className="hidden lg:table-cell text-right">Qty</TableHead>
              <TableHead className="text-right">Entry</TableHead>
              <TableHead className="text-right">Exit</TableHead>
              <TableHead className="text-right">P&amp;L</TableHead>
              <TableHead className="hidden lg:table-cell text-right">R. P&amp;L</TableHead>
              <TableHead>Opened</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trades.map((t) => (
              <Fragment key={t.id}>
                <TradeRow
                  trade={t}
                  runId={runId}
                  commissionSchedule={commissionSchedule}
                  onSelect={enableChatPanel ? () => setSelectedTrade(t.id === selectedTrade?.id ? null : t) : undefined}
                  onExpand={() => setExpandedId(expandedId === t.id ? null : t.id)}
                  isExpanded={expandedId === t.id}
                />
                {expandedId === t.id && (
                  <TradeStoryExpander
                    trade={t}
                    runId={runId}
                    commissionSchedule={commissionSchedule}
                    colSpan={TOTAL_COLUMNS}
                  />
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );

  if (!enableChatPanel) return table;

  // Backtest mode: side-by-side with chat panel
  return (
    <div className="flex gap-4 overflow-hidden" ref={containerRef} style={{ height: containerHeight }}>
      {table}

      {selectedTrade && (
        <Card className="py-0 gap-0 overflow-hidden w-[420px] shrink-0 flex flex-col h-full">
          <div className="flex items-center gap-2 border-b px-4 py-2.5">
            <span className="text-sm font-medium">{selectedTrade.symbol}</span>
            <Badge label={selectedTrade.direction} />
            <Badge label={selectedTrade.strategy} />
            {selectedTrade.status === 'OPEN' ? (
              <span className="ml-auto"><Badge label="OPEN" /></span>
            ) : (
              <span className={`text-sm font-semibold tabular-nums ml-auto ${pnlColor(selectedTrade.pnl)}`}>
                {formatCurrency(selectedTrade.pnl)}
              </span>
            )}
            <button
              onClick={() => setSelectedTrade(null)}
              className="text-muted-foreground hover:text-foreground transition-colors ml-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            {isLoading ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-muted-foreground">Loading...</p>
              </div>
            ) : chatContext && chatContext.messages.length > 0 ? (
              <ChatFeed
                messages={chatContext.messages}
                intents={chatContext.intents}
                labels={chatContext.labels}
                focusMessageId={selectedTrade.sourceMessageId ?? undefined}
                highlightMessageId={selectedTrade.sourceMessageId ?? undefined}
              />
            ) : (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-muted-foreground">No source message linked</p>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
