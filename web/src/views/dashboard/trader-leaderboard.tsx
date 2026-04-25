import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { BreakdownTable, type BreakdownRow } from '@/components/breakdown-table';
import { EmptyState } from '@/components/empty-state';

const MAX_ROWS = 5;

export function TraderLeaderboard({ traderData }: { traderData: BreakdownRow[] }) {
  if (traderData.length === 0) {
    return (
      <Card className="py-0 gap-0">
        <CardHeader className="border-b py-3 px-4">
          <CardTitle className="text-sm">Top Traders</CardTitle>
        </CardHeader>
        <CardContent className="pt-3 px-2">
          <EmptyState variant="default" title="No trader activity yet" />
        </CardContent>
      </Card>
    );
  }

  const rows = [...traderData].sort((a, b) => b.pnl - a.pnl).slice(0, MAX_ROWS);
  const maxAbsPnl = Math.max(...rows.map((r) => Math.abs(r.pnl)), 1);

  return (
    <Card className="py-0 gap-0">
      <CardHeader className="border-b py-3 px-4">
        <CardTitle className="text-sm">Top Traders</CardTitle>
      </CardHeader>
      <CardContent className="pt-3 px-2">
        <BreakdownTable
          rows={rows}
          maxAbsPnl={maxAbsPnl}
          showRank
          winRateScale="percent"
        />
      </CardContent>
    </Card>
  );
}
