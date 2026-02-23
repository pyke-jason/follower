import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Badge } from './badge';
import { LegsIndicator } from './legs-indicator';
import { TableRow, TableCell } from '@/components/ui/table';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import type { Trade, CommissionSchedule, TradeLeg } from '../../../src/db/schema';
import { safeParseFloat } from '../../../src/lib/numbers';
import { computeTradeCommission } from '../../../src/lib/commission';

export function TradeRow({
  trade,
  runId,
  commissionSchedule,
  onSelect,
  onExpand,
  isExpanded,
}: {
  trade: Trade;
  runId?: string;
  commissionSchedule?: CommissionSchedule;
  onSelect?: () => void;
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

  return (
    <TableRow
      className={`hover:bg-accent/40 transition-colors ${onSelect ? 'cursor-pointer' : ''} ${isExpanded ? 'bg-accent/20' : ''}`}
      onClick={onSelect}
    >
      {/* Expand chevron */}
      <TableCell className="w-6">
        {onExpand ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onExpand(); }}
            className="p-0.5 rounded hover:bg-accent/60 transition-colors"
          >
            <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />
          </button>
        ) : null}
      </TableCell>

      {/* Symbol */}
      <TableCell>
        {onSelect ? (
          <span className="text-foreground font-medium">{trade.symbol}</span>
        ) : (
          <Link href={buildHref(`/trades/${trade.id}`, runId)} className="text-foreground font-medium hover:underline underline-offset-2 decoration-muted-foreground/40">
            {trade.symbol}
          </Link>
        )}
      </TableCell>

      {/* Legs */}
      <TableCell className="hidden md:table-cell text-muted-foreground">
        <LegsIndicator legs={trade.legs as TradeLeg[]} strategy={trade.strategy} />
      </TableCell>

      {/* Trader */}
      <TableCell>
        <Link href={`/traders/${encodeURIComponent(trade.trader)}`} className="text-muted-foreground text-xs hover:text-foreground hover:underline underline-offset-2 decoration-muted-foreground/40 transition-colors">
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

      {/* Status */}
      <TableCell>
        <Badge label={trade.status} />
      </TableCell>
    </TableRow>
  );
}
