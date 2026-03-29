import { Link } from 'react-router-dom';
import { formatCurrency } from '@/lib/format';
import { EmptyState } from '@/components/empty-state';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

type BreakdownEntry = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl?: number;
};

type RowData = {
  name: string;
  pnl: number;
  trades: number;
  winRate: number;
};

function BreakdownTable({
  rows,
  maxAbsPnl,
  linkBuilder,
}: {
  rows: RowData[];
  maxAbsPnl: number;
  linkBuilder?: (name: string) => string;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No data yet"
        hint="Data will appear once trades are recorded"
        className="h-[120px] py-0"
      />
    );
  }

  return (
    <div className="space-y-1.5 px-2 pb-2">
      {rows.map((row) => {
        const barWidth = maxAbsPnl > 0 ? Math.abs(row.pnl) / maxAbsPnl : 0;
        const isPositive = row.pnl >= 0;
        return (
          <div key={row.name} className="flex items-center gap-2 text-xs group">
            <div className="w-[90px] truncate shrink-0">
              {linkBuilder ? (
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
                className={`absolute inset-y-0 left-0 rounded-sm transition-all ${
                  isPositive ? 'bg-profit/25' : 'bg-loss/25'
                }`}
                style={{ width: `${Math.max(barWidth * 100, 2)}%` }}
              />
            </div>
            <span className={`w-[72px] text-right tabular-nums font-medium shrink-0 ${
              isPositive ? 'text-profit' : 'text-loss'
            }`}>
              {formatCurrency(row.pnl)}
            </span>
            <span className="w-[40px] text-right tabular-nums text-muted-foreground shrink-0">
              {row.trades}t
            </span>
            <span className="w-[38px] text-right tabular-nums text-muted-foreground shrink-0">
              {(row.winRate * 100).toFixed(0)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function BreakdownCharts({
  byTrader,
  byStrategy,
  channelId,
}: {
  byTrader: Record<string, BreakdownEntry> | null;
  byStrategy: Record<string, BreakdownEntry> | null;
  channelId?: string;
}) {
  const traderRows: RowData[] = byTrader
    ? Object.entries(byTrader)
        .map(([name, stats]) => ({ name, pnl: stats.totalPnl, trades: stats.trades, winRate: stats.winRate }))
        .sort((a, b) => b.pnl - a.pnl)
    : [];

  const strategyRows: RowData[] = byStrategy
    ? Object.entries(byStrategy)
        .map(([name, stats]) => ({ name, pnl: stats.totalPnl, trades: stats.trades, winRate: stats.winRate }))
        .sort((a, b) => b.pnl - a.pnl)
    : [];

  const allPnls = [...traderRows, ...strategyRows].map((r) => Math.abs(r.pnl));
  const maxAbsPnl = allPnls.length > 0 ? Math.max(...allPnls) : 1;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card className="py-0 gap-0">
        <CardHeader className="border-b py-3 px-4">
          <CardTitle className="text-sm">P&L by Trader</CardTitle>
        </CardHeader>
        <CardContent className="pt-3 px-2">
          <BreakdownTable
            rows={traderRows}
            maxAbsPnl={maxAbsPnl}
            linkBuilder={(name) =>
              `/trades?trader=${encodeURIComponent(name)}${channelId ? `&channel=${channelId}` : ''}`
            }
          />
        </CardContent>
      </Card>
      <Card className="py-0 gap-0">
        <CardHeader className="border-b py-3 px-4">
          <CardTitle className="text-sm">P&L by Strategy</CardTitle>
        </CardHeader>
        <CardContent className="pt-3 px-2">
          <BreakdownTable
            rows={strategyRows}
            maxAbsPnl={maxAbsPnl}
            linkBuilder={(name) =>
              `/trades?strategy=${encodeURIComponent(name)}${channelId ? `&channel=${channelId}` : ''}`
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
