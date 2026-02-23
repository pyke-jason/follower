'use client';

import { useState, Fragment } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table';
import { TradeRow } from './trade-row';
import { TradeStoryExpander } from './trade-story-expander';
import type { Trade, CommissionSchedule } from '../../../src/db/schema';

const TOTAL_COLUMNS = 14;

export function TradesTableClient({
  trades,
  runId,
  commissionSchedule,
  startingEquity,
}: {
  trades: Trade[];
  runId?: string;
  commissionSchedule?: CommissionSchedule;
  startingEquity?: number;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (trades.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">
        No trades.
      </p>
    );
  }

  return (
    <Card className="py-0 gap-0 overflow-hidden flex flex-col">
      <CardContent className="p-0 overflow-auto flex-1 min-h-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-6"></TableHead>
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
            {trades.map((t) => (
              <Fragment key={t.id}>
                <TradeRow
                  trade={t}
                  runId={runId}
                  commissionSchedule={commissionSchedule}
                  startingEquity={startingEquity}
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
}
