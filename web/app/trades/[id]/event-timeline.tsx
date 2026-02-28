import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '../../components/badge';
import { formatCurrency, formatDate } from '@/lib/format';
import { safeParseFloat } from '../../../../src/lib/numbers';
import type { TradeEvent } from '../../../../src/db/schema';
import { Clock } from 'lucide-react';

const ACTION_LABELS: Record<string, string> = {
  OPEN: 'Opened',
  CLOSE: 'Closed',
  ADD: 'Added',
  TRIM: 'Trimmed',
  LEG_OFF: 'Leg Off',
};

function EventDetail({ event }: { event: TradeEvent }) {
  const price = safeParseFloat(event.price);
  const meta = event.metadata;

  switch (event.action) {
    case 'OPEN':
      return (
        <span className="text-xs text-muted-foreground tabular-nums">
          {event.quantity} @ {formatCurrency(price)}
        </span>
      );
    case 'ADD':
      return (
        <span className="text-xs text-muted-foreground tabular-nums">
          +{event.quantity} @ {formatCurrency(price)}
        </span>
      );
    case 'TRIM': {
      const trimPnl = meta?.trimPnl as number | undefined;
      const exitPct = meta?.exitPercent as number | undefined;
      return (
        <span className="text-xs tabular-nums">
          <span className="text-muted-foreground">
            -{event.quantity}
            {exitPct != null && ` (${Math.round(exitPct * 100)}%)`}
            {' '}@ {formatCurrency(price)}
          </span>
          {trimPnl != null && (
            <span className={`ml-2 font-medium ${trimPnl > 0 ? 'text-profit' : trimPnl < 0 ? 'text-loss' : 'text-foreground'}`}>
              {formatCurrency(trimPnl)}
            </span>
          )}
        </span>
      );
    }
    case 'LEG_OFF': {
      const targetStrategy = meta?.targetStrategy as string | undefined;
      return (
        <span className="text-xs text-muted-foreground tabular-nums">
          {event.strategy} {targetStrategy ? `\u2192 ${targetStrategy}` : ''} buyback @ {formatCurrency(price)}
        </span>
      );
    }
    case 'CLOSE':
      return (
        <span className="text-xs text-muted-foreground tabular-nums">
          {event.quantity} @ {formatCurrency(price)}
        </span>
      );
    default:
      return null;
  }
}

export function EventTimeline({ events, closeMessageId }: { events: TradeEvent[]; closeMessageId?: string | null }) {
  if (events.length === 0) return null;

  return (
    <Card className="py-0 gap-0">
      <CardHeader className="border-b py-3 px-4">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          Trade Events
        </CardTitle>
      </CardHeader>
      <CardContent className="py-3">
        <div className="space-y-1.5">
          {events.map((event, i) => (
            <div
              key={event.id}
              className="flex items-center gap-3 px-3 py-2 rounded-md border border-border"
            >
              <span className="text-xs text-muted-foreground tabular-nums w-5">{i + 1}.</span>
              <Badge label={event.action} />
              {event.action === 'CLOSE' && (
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${closeMessageId ? 'text-blue-600 bg-blue-500/10' : 'text-muted-foreground bg-muted'}`}>
                  {closeMessageId ? 'Signal' : 'Auto'}
                </span>
              )}
              <EventDetail event={event} />
              <span className="text-[10px] text-muted-foreground/60 ml-auto">
                {formatDate(event.timestamp)}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
