import { getOpenTrades } from '@/lib/queries';
import { Badge } from '../../components/badge';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import { forceExitTrade } from '../actions';
import Link from 'next/link';
import { Crosshair, Package } from 'lucide-react';
import { AutoRefresh } from '../../components/auto-refresh';

export const dynamic = 'force-dynamic';

function relativeTime(iso: string | null): string {
  if (!iso) return '--';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export default async function OpenTradesPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const { run: runId } = await searchParams;
  const trades = await getOpenTrades(50, runId);

  return (
    <div className="space-y-4">
      <AutoRefresh />
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Open Positions</h2>
        {trades.length > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {trades.length} position{trades.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {trades.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 animate-in-up">
          <div className="rounded-full bg-muted/30 p-4 mb-4">
            <Package className="h-8 w-8 text-muted-foreground/30" />
          </div>
          <p className="text-sm text-muted-foreground">No open positions</p>
          <p className="text-xs text-muted-foreground/50 mt-1">Trades will appear here when signals are executed</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 animate-in-up">
          {trades.map((t, i) => {
            const isLong = t.direction === 'LONG';
            const borderColor = isLong ? 'border-l-emerald-500' : 'border-l-red-500';

            return (
              <div
                key={t.id}
                className={`group relative rounded-lg border border-border/60 bg-card border-l-2 ${borderColor} p-4 hover-lift stagger-${Math.min(i + 1, 5)}`}
              >
                {/* Header: Symbol + Time */}
                <div className="flex items-center justify-between mb-2">
                  <Link
                    href={buildHref(`/trades/${t.id}`, runId)}
                    className="text-base font-bold text-foreground tracking-tight hover:underline underline-offset-2 decoration-muted-foreground/40"
                  >
                    {t.symbol}
                  </Link>
                  <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                    {relativeTime(t.openedAt)} ago
                  </span>
                </div>

                {/* Badges: Direction + Strategy */}
                <div className="flex items-center gap-1.5 mb-3">
                  <Badge label={t.direction} />
                  <Badge label={t.strategy} />
                </div>

                {/* Details grid */}
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground/60 block">Entry</span>
                    <span className="text-foreground tabular-nums font-medium">
                      {formatCurrency(t.entryPrice)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground/60 block">Qty</span>
                    <span className="text-foreground tabular-nums font-medium">
                      {t.quantity}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground/60 block">Trader</span>
                    <span className="text-muted-foreground truncate block">
                      {t.trader}
                    </span>
                  </div>
                </div>

                {/* EXIT button — live mode only */}
                {!runId && (
                  <div className="mt-3 pt-3 border-t border-border/40">
                    <form action={forceExitTrade}>
                      <input type="hidden" name="tradeId" value={t.id} />
                      <Button
                        type="submit"
                        variant="destructive"
                        size="xs"
                        className="w-full text-[10px] uppercase tracking-wider font-semibold"
                        onClick={(e: React.MouseEvent) => {
                          if (!confirm(`Force exit ${t.symbol}?`)) {
                            e.preventDefault();
                          }
                        }}
                      >
                        <Crosshair className="h-3 w-3 mr-1" />
                        Exit Position
                      </Button>
                    </form>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
