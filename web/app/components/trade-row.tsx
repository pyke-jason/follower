import Link from 'next/link';
import { Badge } from './badge';
import { TableRow, TableCell } from '@/components/ui/table';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import type { Trade } from '../../../src/db/schema';

export function TradeRow({ trade, runId }: { trade: Trade; runId?: string }) {
  return (
    <TableRow>
      <TableCell>
        <Link href={buildHref(`/trades/${trade.id}`, runId)} className="text-blue-400 hover:underline">
          {trade.symbol}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">{trade.trader}</TableCell>
      <TableCell>
        <Badge label={trade.direction} />
      </TableCell>
      <TableCell>
        <Badge label={trade.strategy} />
      </TableCell>
      <TableCell>{formatCurrency(trade.entryPrice)}</TableCell>
      <TableCell>{formatCurrency(trade.exitPrice)}</TableCell>
      <TableCell className={`font-medium ${pnlColor(trade.pnl)}`}>
        {formatCurrency(trade.pnl)}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {formatDate(trade.openedAt)}
      </TableCell>
      <TableCell>
        <Badge label={trade.status} />
      </TableCell>
    </TableRow>
  );
}
