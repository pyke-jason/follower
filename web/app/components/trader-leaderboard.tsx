'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';

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
  if (data.length === 0) return null;

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
              href={`/traders/${encodeURIComponent(t.trader)}`}
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
                  {isPositive ? '+' : ''}
                  {new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  }).format(t.pnl)}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {t.trades} trades
              </span>
              <span className="text-[10px] text-muted-foreground/60">|</span>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {t.winRate}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
