import Link from 'next/link';
import { formatCurrency } from '@/lib/format';
import { pnlColor } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import { safeParseFloat } from '../../../src/lib/numbers';
import { computeTradeCommission } from '../../../src/lib/commission';
import type { Trade, CommissionSchedule } from '../../../src/db/schema';

function formatTradeDuration(openedAt: string | null, closedAt: string | null): string {
  if (!openedAt || !closedAt) return '--';
  const ms = new Date(closedAt).getTime() - new Date(openedAt).getTime();
  if (ms < 0) return '--';

  const totalMinutes = Math.floor(ms / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);

  if (totalHours < 1) return `${totalMinutes}m`;
  if (totalDays < 1) return `${totalHours}h ${totalMinutes % 60}m`;
  return `${totalDays}d ${totalHours % 24}h`;
}

function shortExpiry(expiry: string): string {
  // "2025-03-21" -> "3/21"
  const parts = expiry.split('-');
  if (parts.length < 3) return expiry;
  return `${parseInt(parts[1]!, 10)}/${parts[2]}`;
}

export function OutcomeLegsSummary({
  trade,
  commissionSchedule,
  runId,
}: {
  trade: Trade;
  commissionSchedule?: CommissionSchedule;
  runId?: string;
}) {
  const grossPnl = trade.pnl != null ? safeParseFloat(trade.pnl) : null;
  const commission = commissionSchedule ? computeTradeCommission(trade, commissionSchedule) : 0;
  const netPnl = grossPnl != null ? grossPnl - commission : null;

  const hasOptionLegs = trade.strategy !== 'STOCK' && Array.isArray(trade.legs) && trade.legs.length > 0;

  return (
    <div className="space-y-3">
      {/* P&L */}
      <div>
        <span className={`text-lg font-bold tabular-nums ${pnlColor(netPnl)}`}>
          {formatCurrency(netPnl)}
        </span>
        {commission > 0 && (
          <span className="text-[10px] text-muted-foreground ml-1">
            comm {formatCurrency(-commission)}
          </span>
        )}
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground border-t border-border pt-2">
        <span className="tabular-nums">
          {formatCurrency(trade.entryPrice)} &rarr; {formatCurrency(trade.exitPrice)}
        </span>
        <span className="tabular-nums">Qty {trade.quantity ?? 1}</span>
        <span>{formatTradeDuration(trade.openedAt, trade.closedAt)}</span>
      </div>

      {/* Option legs */}
      {hasOptionLegs && (
        <div className="border-t border-border pt-2 space-y-0.5">
          {trade.legs.map((leg, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className={`font-medium ${leg.action === 'BUY' ? 'text-profit' : 'text-loss'}`}>
                {leg.action}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {leg.quantity}x {leg.strike}{leg.type[0]} {shortExpiry(leg.expiry)}
              </span>
              {leg.fillPrice != null && (
                <span className="text-muted-foreground/60 tabular-nums">
                  @ {formatCurrency(leg.fillPrice)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Links */}
      <div className="flex items-center gap-3 border-t border-border pt-2">
        <Link
          href={buildHref(`/trades/${trade.id}`, runId)}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline underline-offset-2 decoration-muted-foreground/40 transition-colors"
        >
          Full Detail &rarr;
        </Link>
      </div>
    </div>
  );
}
