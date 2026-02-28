import { Badge } from './badge';
import { TableRow, TableCell } from '@/components/ui/table';
import { formatCurrency, formatDate } from '@/lib/format';
import { safeParseFloat } from '../../../src/lib/numbers';
import type { TradeEvent } from '../../../src/db/schema';

function EventRow({ event, closeMessageId }: { event: TradeEvent; closeMessageId?: string | null }) {
  const price = safeParseFloat(event.price);
  const meta = event.metadata as Record<string, unknown> | null;
  const trimPnl = event.action === 'TRIM' ? (meta?.trimPnl as number | undefined) : undefined;
  const targetStrategy = event.action === 'LEG_OFF' ? (meta?.targetStrategy as string | undefined) : undefined;
  const qtyPrefix = event.action === 'ADD' ? '+' : event.action === 'TRIM' ? '-' : '';

  return (
    <TableRow className="bg-muted/30 hover:bg-muted/50 h-7">
      {/* Action badge (Symbol col) */}
      <TableCell className="pl-6">
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground/30 text-[10px] mr-0.5">┊</span>
          <Badge label={event.action} />
          {event.action === 'CLOSE' && (
            <span className="text-[10px] text-muted-foreground/50 italic">
              {closeMessageId ? 'signal' : 'auto'}
            </span>
          )}
        </span>
      </TableCell>

      {/* Status — empty */}
      <TableCell />

      {/* Legs — empty */}
      <TableCell className="hidden md:table-cell" />

      {/* Trader — empty */}
      <TableCell />

      {/* Direction — empty */}
      <TableCell />

      {/* Strategy — show transition for LEG_OFF */}
      <TableCell>
        {targetStrategy && (
          <span className="text-[10px] text-muted-foreground">
            → <Badge label={targetStrategy} />
          </span>
        )}
      </TableCell>

      {/* Qty */}
      <TableCell className="hidden lg:table-cell text-right tabular-nums text-xs text-muted-foreground">
        {qtyPrefix}{event.quantity}
      </TableCell>

      {/* Price (Entry col) */}
      <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
        {formatCurrency(price)}
      </TableCell>

      {/* Exit — empty */}
      <TableCell className="text-right" />

      {/* Notional — empty */}
      <TableCell className="hidden lg:table-cell" />

      {/* P&L — show for TRIM */}
      <TableCell className={`text-right tabular-nums text-xs font-medium ${trimPnl != null ? (trimPnl > 0 ? 'text-profit' : trimPnl < 0 ? 'text-loss' : '') : ''}`}>
        {trimPnl != null ? formatCurrency(trimPnl) : ''}
      </TableCell>

      {/* R. P&L — empty */}
      <TableCell className="hidden lg:table-cell" />

      {/* Timestamp */}
      <TableCell className="text-muted-foreground/60 text-xs">
        {formatDate(event.timestamp)}
      </TableCell>
    </TableRow>
  );
}

export function EventSubRows({
  events,
  closeMessageId,
}: {
  events: TradeEvent[];
  closeMessageId?: string | null;
}) {
  if (events.length === 0) return null;

  return (
    <>
      {events.map((event) => (
        <EventRow key={event.id} event={event} closeMessageId={closeMessageId} />
      ))}
    </>
  );
}
