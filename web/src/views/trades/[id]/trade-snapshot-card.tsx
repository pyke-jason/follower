import type { ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Badge } from '@/components/badge';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { LivePosition } from '@/lib/trade-story';
import type { Trade } from '@src/db/schema';
import { contractMultiplier, formatLegsSummary, tradeQty } from '@src/lib/trade';

type TradeSnapshotCardProps = {
  trade: Trade;
  livePosition: LivePosition | null;
  onClose: () => void;
};

export function TradeSnapshotCard({ trade, livePosition, onClose }: TradeSnapshotCardProps) {
  const isOpen = trade.status === 'OPEN';
  const entry = parseNullableNumber(trade.avgEntryPrice) ?? parseNullableNumber(trade.entryPrice);
  const exit = parseNullableNumber(trade.exitPrice);
  const realizedPnl = parseNullableNumber(trade.pnl);
  const qty = tradeQty(trade.quantity);
  const multiplier = contractMultiplier(trade.strategy);
  const costBasis = entry != null ? entry * qty * multiplier : null;
  const livePnl = isOpen ? livePosition?.unrealizedPnl ?? null : null;
  const pnl = livePnl ?? (!isOpen ? realizedPnl : null);
  const pnlPct = pnl != null && costBasis ? (pnl / Math.abs(costBasis)) * 100 : null;
  const markPrice = livePosition?.marketValue != null
    ? livePosition.marketValue / (qty * multiplier)
    : null;
  const legSummary = formatLegsSummary(trade.legs, trade.strategy);
  const subLabel = trade.strategy === 'STOCK'
    ? `${qty} sh · ${trade.direction}`
    : `${qty}× ${trade.strategy} · ${trade.direction}`;
  const flags = trade.metadata.flags ?? [];
  const duration = holdingDuration(trade.openedAt, isOpen ? null : trade.closedAt);

  return (
    <section className="space-y-4 pb-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-xl font-semibold tracking-tight text-foreground">
              {trade.symbol}{legSummary ? ` ${legSummary}` : ''}
            </h2>
            <Badge label={trade.status} />
            <Badge label={trade.direction} />
            <Badge label={trade.strategy} />
            {flags.map((flag) => (
              <span
                key={flag}
                className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-warning"
              >
                <AlertTriangle className="size-3" />
                {flag}
              </span>
            ))}
          </div>

          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground/75 tabular-nums">
              {subLabel} · {trade.trader} · {formatDate(trade.openedAt)}
            </p>
            <p className="text-sm text-muted-foreground">{formatTradeMoment(trade, duration)}</p>
          </div>
        </div>

        <Button
          variant="ghost"
          size="icon"
          aria-label="Close detail panel"
          className="-mr-2 -mt-2 size-8 shrink-0"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="grid gap-x-5 gap-y-3 border-t border-border/70 pt-3 sm:grid-cols-2 xl:grid-cols-3">
        <SnapshotMetric label="Qty">
          <span className="text-sm font-semibold tabular-nums">{qty}</span>
        </SnapshotMetric>
        <SnapshotMetric label="Avg Entry">
          <CurrencyValue value={entry} />
        </SnapshotMetric>
        <SnapshotMetric label={isOpen ? 'Mark' : 'Exit'}>
          <CurrencyValue value={isOpen ? markPrice : exit} />
        </SnapshotMetric>
        <SnapshotMetric label={isOpen ? 'Unrealized P&L' : 'Realized P&L'}>
          {pnl != null ? (
            <div className={cn('text-sm font-semibold font-mono tabular-nums', pnlColor(pnl))}>
              {formatCurrency(pnl)}
              {pnlPct != null && (
                <span className="ml-1.5 text-[11px] font-medium">
                  {pnlPct >= 0 ? '+' : ''}
                  {pnlPct.toFixed(1)}%
                </span>
              )}
            </div>
          ) : (
            <EmptyValue />
          )}
        </SnapshotMetric>
        <SnapshotMetric label={isOpen ? 'Opened' : 'Closed'}>
          <span className="text-sm font-medium tabular-nums">
            {formatDate((isOpen ? trade.openedAt : trade.closedAt) ?? trade.openedAt)}
          </span>
        </SnapshotMetric>
        <SnapshotMetric label={isOpen ? 'Open for' : 'Held'}>
          <span className="text-sm font-medium tabular-nums">{duration ?? '—'}</span>
        </SnapshotMetric>
      </div>
    </section>
  );
}

function parseNullableNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function SnapshotMetric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function CurrencyValue({ value }: { value: number | null }) {
  if (value == null) return <EmptyValue />;
  return (
    <span className="text-sm font-semibold font-mono tabular-nums">
      {formatCurrency(value)}
    </span>
  );
}

function EmptyValue() {
  return <span className="text-sm font-semibold tabular-nums text-muted-foreground/35">—</span>;
}

function formatTradeMoment(trade: Trade, duration: string | null): string {
  const openedAt = formatDate(trade.openedAt);
  if (trade.status === 'OPEN') {
    return duration ? `Opened ${openedAt} • ${duration} so far` : `Opened ${openedAt}`;
  }
  const closedAt = formatDate(trade.closedAt ?? trade.openedAt);
  return duration
    ? `Opened ${openedAt} • closed ${closedAt} • held ${duration}`
    : `Closed ${closedAt}`;
}

function holdingDuration(startIso: string | null, endIso: string | null): string | null {
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const durationMs = end - start;
  if (durationMs < 0) return null;
  const mins = Math.floor(durationMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
