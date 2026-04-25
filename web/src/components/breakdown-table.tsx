import { Link } from 'react-router-dom';
import { formatCurrency } from '@/lib/format';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type BreakdownRow = {
  name: string;
  pnl: number;
  trades: number;
  winRate: number;
};

interface BreakdownTableProps {
  rows: BreakdownRow[];
  maxAbsPnl: number;
  /** Optional rank prefix shown before each name (1, 2, 3...). */
  showRank?: boolean;
  /** Win rate is in 0..1 (default) or 0..100. */
  winRateScale?: 'fraction' | 'percent';
  linkBuilder?: (name: string) => string;
  selectedName?: string | null;
  onSelectName?: (name: string) => void;
  emptyTitle?: string;
  emptyHint?: string;
}

export function BreakdownTable({
  rows,
  maxAbsPnl,
  showRank = false,
  winRateScale = 'fraction',
  linkBuilder,
  selectedName,
  onSelectName,
  emptyTitle = 'No data yet',
  emptyHint = 'Data will appear once trades are recorded',
}: BreakdownTableProps) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} hint={emptyHint} className="h-[120px] py-0" />;
  }

  return (
    <div className="space-y-1.5 px-2 pb-2">
      {rows.map((row, index) => {
        const barWidth = maxAbsPnl > 0 ? Math.abs(row.pnl) / maxAbsPnl : 0;
        const isPositive = row.pnl >= 0;
        const isSelected = row.name === selectedName;
        const winRatePct = winRateScale === 'fraction' ? row.winRate * 100 : row.winRate;
        return (
          <div
            key={row.name}
            className={cn(
              'flex items-center gap-2 text-xs group rounded-sm',
              isSelected && 'bg-accent/40',
            )}
          >
            {showRank && (
              <span className="w-5 text-right tabular-nums text-muted-foreground shrink-0">
                {index + 1}
              </span>
            )}
            <div className="w-[90px] truncate shrink-0">
              {onSelectName ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className={cn(
                    'h-auto px-0 py-0 text-xs font-normal hover:bg-transparent',
                    isSelected
                      ? 'text-foreground underline underline-offset-2'
                      : 'text-muted-foreground',
                  )}
                  onClick={() => onSelectName(row.name)}
                >
                  {row.name}
                </Button>
              ) : linkBuilder ? (
                <Link
                  to={linkBuilder(row.name)}
                  className="text-muted-foreground hover:text-foreground underline underline-offset-2 decoration-dashed"
                >
                  {row.name}
                </Link>
              ) : (
                <span className="text-muted-foreground">{row.name}</span>
              )}
            </div>
            <div className="flex-1 h-5 relative rounded-sm overflow-hidden bg-muted/30">
              <div
                className={cn(
                  'absolute inset-y-0 left-0 rounded-sm transition-all',
                  isPositive ? 'bg-profit/25' : 'bg-loss/25',
                )}
                style={{ width: `${Math.max(barWidth * 100, 2)}%` }}
              />
            </div>
            <span
              className={cn(
                'w-[72px] text-right tabular-nums font-medium shrink-0',
                isPositive ? 'text-profit' : 'text-loss',
              )}
            >
              {formatCurrency(row.pnl)}
            </span>
            <span className="w-[40px] text-right tabular-nums text-muted-foreground shrink-0">
              {row.trades}t
            </span>
            <span className="w-[38px] text-right tabular-nums text-muted-foreground shrink-0">
              {winRatePct.toFixed(0)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
