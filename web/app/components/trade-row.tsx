import Link from 'next/link';
import { Badge } from './badge';
import { TableRow, TableCell } from '@/components/ui/table';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import type { Trade } from '../../../src/db/schema';
import { safeParseFloat } from '../../../src/lib/numbers';

export function TradeRow({ trade, runId }: { trade: Trade; runId?: string }) {
  const pnl = trade.pnl != null ? safeParseFloat(trade.pnl) : null;
  const pnlBorder = pnl != null && pnl !== 0
    ? pnl > 0 ? 'border-l-2 border-l-profit/70' : 'border-l-2 border-l-loss/70'
    : '';

  return (
    <TableRow className="hover:bg-accent/40 transition-colors">
      <TableCell>
        <Link href={buildHref(`/trades/${trade.id}`, runId)} className="text-foreground font-medium hover:underline underline-offset-2 decoration-muted-foreground/40">
          {trade.symbol}
        </Link>
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
      <TableCell className={`text-right tabular-nums font-medium ${pnlColor(trade.pnl)} ${pnlBorder}`}>
        {formatCurrency(trade.pnl)}
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
