import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/format';
import { EmptyState } from '@/components/empty-state';
import { useScopedHref } from '@/hooks/use-scoped-href';

interface TraderData {
  trader: string;
  pnl: number;
  trades: number;
  winRate: number;
}

interface Props {
  data: TraderData[];
}

export function TraderLeaderboard({ data }: Props) {
  const href = useScopedHref();

  if (data.length === 0) return <EmptyState title="No trader data yet" hint="Data will appear once trades are recorded" />;

  const maxAbs = Math.max(...data.map((d) => Math.abs(d.pnl)), 1);

  return (
    <div className="space-y-1.5">
      {data.map((t) => {
        const width = (Math.abs(t.pnl) / maxAbs) * 100;
        const isPositive = t.pnl >= 0;
        const barColor = isPositive
          ? 'oklch(0.72 0.19 155 / 60%)'
          : 'oklch(0.68 0.22 25 / 60%)';

        return (
          <div key={t.trader} className="group flex items-center gap-3">
            <Link
              to={href(`/traders/${encodeURIComponent(t.trader)}`)}
              className="text-xs font-medium w-20 truncate shrink-0 text-muted-foreground group-hover:text-foreground hover:underline underline-offset-2 decoration-muted-foreground/40 transition-colors"
            >
              {t.trader}
            </Link>
            <div className="flex-1 h-6 relative rounded-sm overflow-hidden bg-muted/20">
              <div
                className="absolute inset-y-0 left-0 rounded-sm transition-all duration-700 ease-out"
                style={{
                  width: `${Math.max(width, 3)}%`,
                  backgroundColor: barColor,
                }}
              />
              <div className="absolute inset-0 flex items-center px-2">
                <span
                  className={cn(
                    'text-[11px] font-semibold tabular-nums',
                    isPositive ? 'text-profit' : 'text-loss'
                  )}
                >
                  {isPositive ? '+' : ''}{formatCurrency(t.pnl, 0)}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {t.trades} trades
              </span>
              <span className="text-[10px] text-muted-foreground/60">|</span>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {t.winRate.toFixed(0)}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
