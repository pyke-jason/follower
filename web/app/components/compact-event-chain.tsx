import { Badge } from './badge';
import { formatCurrency, formatDate } from '@/lib/format';
import { safeParseFloat } from '../../../src/lib/numbers';
import type { TradeEvent } from '../../../src/db/schema';

function EventLine({ event, index }: { event: TradeEvent; index: number }) {
  const price = safeParseFloat(event.price);
  const meta = event.metadata as Record<string, unknown> | null;

  let detail: React.ReactNode = null;

  switch (event.action) {
    case 'OPEN':
      detail = (
        <span className="tabular-nums">
          {event.quantity} @ {formatCurrency(price)}
        </span>
      );
      break;
    case 'ADD':
      detail = (
        <span className="tabular-nums">
          +{event.quantity} @ {formatCurrency(price)}
        </span>
      );
      break;
    case 'TRIM': {
      const trimPnl = meta?.trimPnl as number | undefined;
      detail = (
        <span className="tabular-nums">
          -{event.quantity} @ {formatCurrency(price)}
          {trimPnl != null && (
            <span className={`ml-1.5 font-medium ${trimPnl > 0 ? 'text-profit' : trimPnl < 0 ? 'text-loss' : ''}`}>
              {formatCurrency(trimPnl)}
            </span>
          )}
        </span>
      );
      break;
    }
    case 'LEG_OFF': {
      const targetStrategy = meta?.targetStrategy as string | undefined;
      detail = (
        <span className="tabular-nums">
          {event.strategy}{targetStrategy ? ` \u2192 ${targetStrategy}` : ''} @ {formatCurrency(price)}
        </span>
      );
      break;
    }
    case 'CLOSE':
      detail = (
        <span className="tabular-nums">
          {event.quantity} @ {formatCurrency(price)}
        </span>
      );
      break;
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-[10px] text-muted-foreground/60 tabular-nums w-4 shrink-0">{index + 1}.</span>
      <Badge label={event.action} />
      <span className="text-muted-foreground">{detail}</span>
      <span className="text-[10px] text-muted-foreground/50 ml-auto shrink-0">
        {formatDate(event.timestamp)}
      </span>
    </div>
  );
}

export function CompactEventChain({ events }: { events: TradeEvent[] }) {
  if (events.length === 0) return null;

  return (
    <div className="space-y-1">
      {events.map((event, i) => (
        <EventLine key={event.id} event={event} index={i} />
      ))}
    </div>
  );
}
