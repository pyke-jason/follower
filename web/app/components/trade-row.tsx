import Link from 'next/link';
import { ChevronRight, AlertTriangle } from 'lucide-react';
import { Badge } from './badge';
import { LegsIndicator } from './legs-indicator';
import { TableRow, TableCell } from '@/components/ui/table';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import type { Trade, CommissionSchedule, TradeLeg } from '../../../src/db/schema';
import { safeParseFloat } from '../../../src/lib/numbers';
import { computeTradeCommission } from '../../../src/lib/commission';
import { notionalValue } from '../../../src/lib/trade';

function notionalConcentrationColor(pct: number): string {
  if (pct >= 0.25) return 'text-loss';
  if (pct >= 0.15) return 'text-amber-500';
  return 'text-muted-foreground';
}

export function TradeRow({
  trade,
  runId,
  commissionSchedule,
  startingEquity,
  onExpand,
  isExpanded,
}: {
  trade: Trade;
  runId?: string;
  commissionSchedule?: CommissionSchedule;
  startingEquity?: number;
  onExpand?: () => void;
  isExpanded?: boolean;
}) {
  const grossPnl = trade.pnl != null ? safeParseFloat(trade.pnl) : null;
  const comm = commissionSchedule ? computeTradeCommission(trade, commissionSchedule) : 0;
  const pnl = grossPnl != null ? grossPnl - comm : null;
  const pnlBorder = pnl != null && pnl !== 0
    ? pnl > 0 ? 'border-l-2 border-l-profit/70' : 'border-l-2 border-l-loss/70'
    : '';

  const realizedPnl = trade.realizedPnl != null ? safeParseFloat(trade.realizedPnl) : null;
  const notional = notionalValue(trade.entryPrice, trade.quantity, trade.strategy);
  const notionalPct = notional > 0 && startingEquity != null && startingEquity > 0
    ? notional / startingEquity
    : null;

  return (
    <TableRow
      className={`hover:bg-accent/40 transition-colors ${onExpand ? 'cursor-pointer' : ''} ${isExpanded ? 'bg-accent/20' : ''}`}
      onClick={onExpand}
    >
      {/* Expand chevron */}
      <TableCell className="w-6">
        {onExpand ? (
          <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />
        ) : null}
      </TableCell>

      {/* Symbol */}
      <TableCell>
        <Link
          href={buildHref(`/trades/${trade.id}`, runId)}
          className="text-foreground font-medium hover:underline underline-offset-2 decoration-muted-foreground/40"
          onClick={(e) => e.stopPropagation()}
        >
          {trade.symbol}
        </Link>
      </TableCell>

      {/* Status */}
      <TableCell>
        <span className="inline-flex items-center gap-1">
          <Badge label={trade.status} />
          {trade.status === 'CLOSED' && !trade.closeMessageId && (
            <span title="Auto-closed (no exit signal)">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            </span>
          )}
        </span>
      </TableCell>

      {/* Legs */}
      <TableCell className="hidden md:table-cell text-muted-foreground">
        <LegsIndicator legs={trade.legs as TradeLeg[]} strategy={trade.strategy} />
      </TableCell>

      {/* Trader */}
      <TableCell>
        <Link
          href={`/traders/${encodeURIComponent(trade.trader)}`}
          className="text-muted-foreground text-xs hover:text-foreground hover:underline underline-offset-2 decoration-muted-foreground/40 transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          {trade.trader}
        </Link>
      </TableCell>

      {/* Direction */}
      <TableCell>
        <Badge label={trade.direction} />
      </TableCell>

      {/* Strategy */}
      <TableCell>
        <Badge label={trade.strategy} />
      </TableCell>

      {/* Qty */}
      <TableCell className="hidden lg:table-cell text-right tabular-nums text-xs">
        {trade.quantity ?? 1}
      </TableCell>

      {/* Entry */}
      <TableCell className="text-right tabular-nums text-xs">{formatCurrency(trade.entryPrice)}</TableCell>

      {/* Exit */}
      <TableCell className="text-right tabular-nums text-xs">{formatCurrency(trade.exitPrice)}</TableCell>

      {/* Notional */}
      <TableCell className="hidden lg:table-cell text-right tabular-nums text-xs">
        {notional > 0 ? (
          <span className="flex flex-col items-end gap-0.5">
            <span className="text-muted-foreground">{formatCurrency(notional)}</span>
            {notionalPct != null && (
              <span className={`text-[10px] ${notionalConcentrationColor(notionalPct)}`}>
                {(notionalPct * 100).toFixed(1)}%
              </span>
            )}
          </span>
        ) : '--'}
      </TableCell>

      {/* P&L */}
      <TableCell className={`text-right tabular-nums font-medium ${pnl != null && pnl >= 0 ? 'text-profit' : pnl != null && pnl < 0 ? 'text-loss' : ''} ${pnlBorder}`}>
        {formatCurrency(pnl)}
        {comm > 0 && <span className="text-muted-foreground font-normal text-[10px] ml-0.5">({formatCurrency(-comm)})</span>}
      </TableCell>

      {/* Realized P&L */}
      <TableCell className={`hidden lg:table-cell text-right tabular-nums text-xs ${realizedPnl != null && realizedPnl !== 0 ? pnlColor(realizedPnl) : ''}`}>
        {realizedPnl != null && realizedPnl !== 0 ? formatCurrency(realizedPnl) : '--'}
      </TableCell>

      {/* Opened */}
      <TableCell className="text-muted-foreground text-xs">
        {formatDate(trade.openedAt)}
      </TableCell>
    </TableRow>
  );
}
