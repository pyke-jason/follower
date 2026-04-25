import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { BreakdownTable, type BreakdownRow } from '@/components/breakdown-table';
import type { StrategyStats, TraderStats } from '@src/backtest/types';

export function BreakdownCharts({
  byTrader,
  byStrategy,
  channelId,
  selectedTrader,
  onSelectTrader,
}: {
  byTrader: Record<string, TraderStats> | null;
  byStrategy: Record<string, StrategyStats> | null;
  channelId?: string;
  selectedTrader?: string | null;
  onSelectTrader?: (name: string) => void;
}) {
  const traderRows: BreakdownRow[] = byTrader
    ? Object.entries(byTrader)
        .map(([name, stats]) => ({ name, pnl: stats.totalPnl, trades: stats.trades, winRate: stats.winRate }))
        .sort((a, b) => b.pnl - a.pnl)
    : [];

  const strategyRows: BreakdownRow[] = byStrategy
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
            selectedName={selectedTrader}
            onSelectName={onSelectTrader}
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
