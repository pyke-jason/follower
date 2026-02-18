import Link from 'next/link';
import { Badge } from './badge';
import { TableRow, TableCell } from '@/components/ui/table';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import type { Trade, CommissionSchedule } from '../../../src/db/schema';
import { safeParseFloat } from '../../../src/lib/numbers';
import { computeTradeCommission } from '../../../src/lib/commission';

export function TradeRow({ trade, runId, commissionSchedule, onSelect }: { trade: Trade; runId?: string; commissionSchedule?: CommissionSchedule; onSelect?: () => void }) {
  const grossPnl = trade.pnl != null ? safeParseFloat(trade.pnl) : null;
  const comm = commissionSchedule ? computeTradeCommission(trade, commissionSchedule) : 0;
  const pnl = grossPnl != null ? grossPnl - comm : null;
  const pnlBorder = pnl != null && pnl !== 0
    ? pnl > 0 ? 'border-l-2 border-l-profit/70' : 'border-l-2 border-l-loss/70'
    : '';

  return (
    <TableRow
      className={`hover:bg-accent/40 transition-colors ${onSelect ? 'cursor-pointer' : ''}`}
      onClick={onSelect}
    >
      <TableCell>
        {onSelect ? (
          <span className="text-foreground font-medium">{trade.symbol}</span>
        ) : (
          <Link href={buildHref(`/trades/${trade.id}`, runId)} className="text-foreground font-medium hover:underline underline-offset-2 decoration-muted-foreground/40">
            {trade.symbol}
          </Link>
        )}
      </TableCell>
      <TableCell>
        <Link href={`/traders/${encodeURIComponent(trade.trader)}`} className="text-muted-foreground text-xs hover:text-foreground hover:underline underline-offset-2 decoration-muted-foreground/40 transition-colors">
          {trade.trader}
        </Link>
      </TableCell>
      <TableCell>
        <Badge label={trade.direction} />
      </TableCell>
      <TableCell>
        <Badge label={trade.strategy} />
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">{formatCurrency(trade.entryPrice)}</TableCell>
      <TableCell className="text-right tabular-nums text-xs">{formatCurrency(trade.exitPrice)}</TableCell>
      <TableCell className={`text-right tabular-nums font-medium ${pnl != null && pnl >= 0 ? 'text-profit' : pnl != null && pnl < 0 ? 'text-loss' : ''} ${pnlBorder}`}>
        {formatCurrency(pnl)}
        {comm > 0 && <span className="text-muted-foreground font-normal text-[10px] ml-0.5">({formatCurrency(-comm)})</span>}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {formatDate(trade.openedAt)}
      </TableCell>
      <TableCell>
        <Badge label={trade.status} />
      </TableCell>
    </TableRow>
  );
}
