import { TableRow, TableCell } from '@/components/ui/table';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { safeParseFloat } from '@src/lib/numbers';
import type { TradeEvent } from '@src/db/schema';

function EventRow({ event, closeMessageId, extraCells = 0 }: { event: TradeEvent; closeMessageId?: string | null; extraCells?: number }) {
  const price = safeParseFloat(event.price);
  const meta = event.metadata as Record<string, unknown> | null;
  const trimPnl = event.action === 'TRIM' ? (meta?.trimPnl as number | undefined) : undefined;
  const targetStrategy = event.action === 'LEG_OFF' ? (meta?.targetStrategy as string | undefined) : undefined;
  const qtyPrefix = event.action === 'ADD' ? '+' : event.action === 'TRIM' ? '-' : '';

  return (
    <TableRow className="bg-muted/30 hover:bg-muted/50 h-7">
      {/* Chevron spacer */}
      <TableCell className="w-6" />

      {/* Action (Trade col) */}
      <TableCell>
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground/30 text-[10px] mr-0.5">&middot;</span>
          <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
            {event.action}
          </span>
          {event.action === 'CLOSE' && (
            <span className="text-[10px] text-muted-foreground/40 italic">
              {closeMessageId ? 'signal' : 'auto'}
            </span>
          )}
          {targetStrategy && (
            <span className="text-[10px] text-muted-foreground/50">
              &rarr; {targetStrategy}
            </span>
          )}
        </span>
      </TableCell>

      {/* Trader — empty */}
      <TableCell />

      {/* Qty */}
      <TableCell className="text-right tabular-nums text-xs text-muted-foreground/60">
        {qtyPrefix}{event.quantity}
      </TableCell>

      {/* Price (Entry col) */}
      <TableCell className="text-right tabular-nums text-xs text-muted-foreground/60">
        {formatCurrency(price)}
      </TableCell>

      {/* P&L — show for TRIM */}
      <TableCell className={`text-right tabular-nums text-xs font-medium ${trimPnl != null ? pnlColor(trimPnl) : ''}`}>
        {trimPnl != null ? formatCurrency(trimPnl) : ''}
      </TableCell>

      {/* Timestamp */}
      <TableCell className="text-muted-foreground/40 text-xs">
        {formatDate(event.timestamp)}
      </TableCell>

      {/* Extra trailing cells for alignment (e.g. Exec, Label) */}
      {Array.from({ length: extraCells }, (_, i) => (
        <TableCell key={`extra-${i}`} />
      ))}
    </TableRow>
  );
}

export function EventSubRows({
  events,
  closeMessageId,
  extraCells = 0,
}: {
  events: TradeEvent[];
  closeMessageId?: string | null;
  extraCells?: number;
}) {
  if (events.length === 0) return null;

  return (
    <>
      {events.map((event) => (
        <EventRow key={event.id} event={event} closeMessageId={closeMessageId} extraCells={extraCells} />
      ))}
    </>
  );
}
