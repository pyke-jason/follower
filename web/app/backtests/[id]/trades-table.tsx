'use client';

import { useState, useEffect, useTransition, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table';
import { Badge } from '../../components/badge';
import { TradeRow } from '../../components/trade-row';
import { fetchTradeLinkedMessages } from '../actions';
import { formatCurrency, pnlColor } from '@/lib/format';
import { X } from 'lucide-react';
import type { Trade, Message, MessageLabel, CommissionSchedule } from '../../../../src/db/schema';
import type { MessageIntent } from '../../messages/actions';

const ChatFeed = dynamic(
  () => import('../../messages/chat-feed').then((m) => ({ default: m.ChatFeed })),
  { ssr: false },
);

type ChatContext = {
  messages: Message[];
  intents: Record<string, MessageIntent>;
  labels: Record<string, MessageLabel>;
};

export function TradesTable({ trades, runId, commissionSchedule }: { trades: Trade[]; runId: string; commissionSchedule?: CommissionSchedule }) {
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const [context, setContext] = useState<ChatContext | null>(null);
  const [isLoading, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState<string | undefined>(undefined);

  // Measure available height once on mount
  useEffect(() => {
    if (!containerRef.current) return;
    const top = containerRef.current.getBoundingClientRect().top;
    setContainerHeight(`calc(100vh - ${Math.round(top)}px - 1.5rem)`);
  }, []);

  useEffect(() => {
    if (!selectedTrade) {
      setContext(null);
      return;
    }
    startTransition(async () => {
      const result = await fetchTradeLinkedMessages(selectedTrade.id);
      // Messages arrive ASC — reverse to DESC for ChatFeed
      const desc = [...result.messages].reverse();
      setContext({ ...result, messages: desc });
    });
  }, [selectedTrade?.id]);

  if (trades.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">
        No closed trades for this run.
      </p>
    );
  }

  return (
    <div className="flex gap-4 overflow-hidden" ref={containerRef} style={{ height: containerHeight }}>
      <Card className="py-0 gap-0 overflow-hidden flex-1 min-w-0 flex flex-col">
        <CardContent className="p-0 overflow-auto flex-1 min-h-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Trader</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Strategy</TableHead>
                <TableHead className="text-right">Entry</TableHead>
                <TableHead className="text-right">Exit</TableHead>
                <TableHead className="text-right">P&L</TableHead>
                <TableHead>Opened</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.map((t) => (
                <TradeRow
                  key={t.id}
                  trade={t}
                  runId={runId}
                  commissionSchedule={commissionSchedule}
                  onSelect={() => setSelectedTrade(t.id === selectedTrade?.id ? null : t)}
                />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selectedTrade && (
        <Card className="py-0 gap-0 overflow-hidden w-[420px] shrink-0 flex flex-col h-full">
          <div className="flex items-center gap-2 border-b px-4 py-2.5">
            <span className="text-sm font-medium">{selectedTrade.symbol}</span>
            <Badge label={selectedTrade.direction} />
            <Badge label={selectedTrade.strategy} />
            <span className={`text-sm font-semibold tabular-nums ml-auto ${pnlColor(selectedTrade.pnl)}`}>
              {formatCurrency(selectedTrade.pnl)}
            </span>
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
            ) : context && context.messages.length > 0 ? (
              <ChatFeed
                messages={context.messages}
                intents={context.intents}
                labels={context.labels}
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
