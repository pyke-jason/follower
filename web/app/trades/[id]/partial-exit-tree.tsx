import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '../../components/badge';
import { formatCurrency, formatDate } from '@/lib/format';
import { safeParseFloat } from '../../../../src/lib/numbers';
import Link from 'next/link';
import type { Trade } from '../../../../src/db/schema';
import { ArrowRight, GitBranch } from 'lucide-react';

export function PartialExitTree({
  trade,
  parentTrade,
  childTrades,
  runId,
}: {
  trade: Trade;
  parentTrade: Trade | null;
  childTrades: Trade[];
  runId?: string;
}) {
  if (!parentTrade && childTrades.length === 0) return null;

  const buildHref = (id: string) => {
    const base = `/trades/${id}`;
    return runId ? `${base}?run=${runId}` : base;
  };

  return (
    <Card className="py-0 gap-0">
      <CardHeader className="border-b py-3 px-4">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
          Partial Exits
        </CardTitle>
      </CardHeader>
      <CardContent className="py-3">
        {/* Parent link */}
        {parentTrade && (
          <div className="mb-3 pb-3 border-b border-border/50">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Parent Trade</p>
            <Link
              href={buildHref(parentTrade.id)}
              className="flex items-center gap-3 px-3 py-2 rounded-md border border-border hover:bg-accent/40 transition-colors"
            >
              <span className="font-medium text-sm">{parentTrade.symbol}</span>
              <Badge label={parentTrade.direction} />
              <Badge label={parentTrade.strategy} />
              <span className="text-xs text-muted-foreground tabular-nums">{formatCurrency(parentTrade.entryPrice)}</span>
              <ArrowRight className="h-3 w-3 text-muted-foreground ml-auto" />
            </Link>
          </div>
        )}

        {/* Child exits timeline */}
        {childTrades.length > 0 && (
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
              Exit History ({childTrades.length} partial exit{childTrades.length !== 1 ? 's' : ''})
            </p>
            <div className="space-y-1.5">
              {childTrades.map((child, i) => {
                const pnl = safeParseFloat(child.pnl);
                const exitPct = child.exitPercent;
                return (
                  <Link
                    key={child.id}
                    href={buildHref(child.id)}
                    className="flex items-center gap-3 px-3 py-2 rounded-md border border-border hover:bg-accent/40 transition-colors"
                  >
                    <span className="text-xs text-muted-foreground tabular-nums w-5">{i + 1}.</span>
                    {exitPct != null && (
                      <span className="text-xs font-medium text-foreground tabular-nums w-12">
                        {Math.round(exitPct * 100)}%
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      @ {formatCurrency(child.exitPrice)}
                    </span>
                    <span className={`text-xs font-medium tabular-nums ${pnl > 0 ? 'text-profit' : pnl < 0 ? 'text-loss' : 'text-foreground'}`}>
                      {formatCurrency(pnl)}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60 ml-auto">
                      {formatDate(child.closedAt)}
                    </span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
