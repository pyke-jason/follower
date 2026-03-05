import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from './badge';
import { formatCurrency } from '@/lib/format';
import type { TradeLeg } from '@src/db/schema';

export function LegsTable({
  legs,
  showFills = false,
}: {
  legs: TradeLeg[];
  showFills?: boolean;
}) {
  if (legs.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Symbol</TableHead>
          <TableHead>Type</TableHead>
          <TableHead className="text-right">Strike</TableHead>
          <TableHead>Expiry</TableHead>
          <TableHead>Action</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          {showFills && <TableHead className="text-right">Fill</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {legs.map((leg, i) => (
          <TableRow key={i} className="hover:bg-accent/40 transition-colors">
            <TableCell className="font-medium">{leg.symbol}</TableCell>
            <TableCell><Badge label={leg.type} /></TableCell>
            <TableCell className="text-right tabular-nums">{leg.strike}</TableCell>
            <TableCell className="text-muted-foreground text-xs">{leg.expiry}</TableCell>
            <TableCell>{leg.action}</TableCell>
            <TableCell className="text-right tabular-nums">{leg.quantity}</TableCell>
            {showFills && (
              <TableCell className="text-right tabular-nums">
                {leg.fillPrice != null ? formatCurrency(leg.fillPrice) : '--'}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
