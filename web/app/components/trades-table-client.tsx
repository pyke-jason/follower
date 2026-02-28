'use client';

import { useState, Fragment } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table';
import { TradeRow } from './trade-row';
import { EventSubRows } from './event-sub-rows';
import { TradeDetailPanel } from './trade-detail-panel';
import type { Trade, TradeEvent, CommissionSchedule } from '../../../src/db/schema';

export function TradesTableClient({
  trades,
  eventsByTradeId,
  runId,
  commissionSchedule,
  startingEquity,
}: {
  trades: Trade[];
  eventsByTradeId?: Map<string, TradeEvent[]>;
  runId?: string;
  commissionSchedule?: CommissionSchedule;
  startingEquity?: number;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedTrade = selectedId ? trades.find((t) => t.id === selectedId) ?? null : null;

  if (trades.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">
        No trades.
      </p>
    );
  }

  return (
    <Card className="py-0 gap-0 overflow-hidden flex flex-col">
      <div className="flex flex-1 min-h-0">
        {/* Table */}
        <CardContent className={`p-0 overflow-auto flex-1 min-h-0 ${selectedTrade ? 'max-w-[calc(100%-380px)]' : ''}`}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Legs</TableHead>
                <TableHead>Trader</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Strategy</TableHead>
                <TableHead className="hidden lg:table-cell text-right">Qty</TableHead>
                <TableHead className="text-right">Entry</TableHead>
                <TableHead className="text-right">Exit</TableHead>
                <TableHead className="hidden lg:table-cell text-right">Notional</TableHead>
                <TableHead className="text-right">P&amp;L</TableHead>
                <TableHead className="hidden lg:table-cell text-right">R. P&amp;L</TableHead>
                <TableHead>Opened</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.map((t) => {
                const events = eventsByTradeId?.get(t.id) ?? [];
                return (
                  <Fragment key={t.id}>
                    <TradeRow
                      trade={t}
                      runId={runId}
                      commissionSchedule={commissionSchedule}
                      startingEquity={startingEquity}
                      onSelect={() => setSelectedId(selectedId === t.id ? null : t.id)}
                      isSelected={selectedId === t.id}
                    />
                    <EventSubRows events={events} closeMessageId={t.closeMessageId} />
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>

        {/* Detail panel */}
        {selectedTrade && (
          <div className="w-[380px] shrink-0 border-l border-border overflow-auto bg-background">
            <TradeDetailPanel
              trade={selectedTrade}
              runId={runId}
              commissionSchedule={commissionSchedule}
              onClose={() => setSelectedId(null)}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
