import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatCurrency } from '@/lib/format';
import { pctDisplay, PROFIT_FACTOR_INF } from '../../../../src/lib/numbers';
import { cn } from '@/lib/utils';
import type { BacktestRunConfig, BacktestRunSummary } from '../../../../src/db/schema';

interface RunData {
  id: string;
  name: string;
  config: BacktestRunConfig;
  summary: BacktestRunSummary | null;
}

function bestOf(values: (number | null)[], higherIsBetter: boolean): number | null {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length === 0) return null;
  return higherIsBetter ? Math.max(...nums) : Math.min(...nums);
}

function cellClass(value: number | null, best: number | null): string {
  if (value == null || best == null) return '';
  return value === best ? 'text-profit font-semibold' : '';
}

export function ComparisonTable({ runs }: { runs: RunData[] }) {
  const summaries = runs.map((r) => r.summary);

  const rows: { label: string; values: string[]; raw: (number | null)[]; higherIsBetter: boolean }[] = [
    {
      label: 'P&L',
      values: summaries.map((s) => s ? formatCurrency(s.totalPnl) : '--'),
      raw: summaries.map((s) => s?.totalPnl ?? null),
      higherIsBetter: true,
    },
    {
      label: 'Win Rate',
      values: summaries.map((s) => s ? pctDisplay(s.winRate) : '--'),
      raw: summaries.map((s) => s?.winRate ?? null),
      higherIsBetter: true,
    },
    {
      label: 'Profit Factor',
      values: summaries.map((s) => s ? (s.profitFactor >= PROFIT_FACTOR_INF ? '\u221E' : s.profitFactor.toFixed(2)) : '--'),
      raw: summaries.map((s) => s?.profitFactor ?? null),
      higherIsBetter: true,
    },
    {
      label: 'Max Drawdown',
      values: summaries.map((s) => s ? formatCurrency(s.maxDrawdown) : '--'),
      raw: summaries.map((s) => s?.maxDrawdown ?? null),
      higherIsBetter: false, // lower drawdown is better, but drawdown is negative so higher is better
    },
    {
      label: 'Trades',
      values: summaries.map((s) => s ? String(s.totalTrades) : '--'),
      raw: summaries.map((s) => s?.totalTrades ?? null),
      higherIsBetter: true,
    },
    {
      label: 'Agent Calls',
      values: summaries.map((s) => s ? String(s.agentCallsUsed) : '--'),
      raw: summaries.map((s) => s?.agentCallsUsed ?? null),
      higherIsBetter: false,
    },
  ];

  return (
    <Card className="py-0 gap-0 overflow-hidden">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Metric</TableHead>
              {runs.map((run) => (
                <TableHead key={run.id} className="text-center">
                  <div className="text-foreground font-medium">{run.name}</div>
                  <div className="text-[10px] text-muted-foreground font-normal">
                    {run.config.startDate?.split('T')[0]} &ndash; {run.config.endDate?.split('T')[0]}
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const best = bestOf(row.raw, row.higherIsBetter);
              return (
                <TableRow key={row.label}>
                  <TableCell className="text-muted-foreground text-xs font-medium">{row.label}</TableCell>
                  {row.values.map((val, i) => (
                    <TableCell
                      key={i}
                      className={cn('text-center tabular-nums', cellClass(row.raw[i], best))}
                    >
                      {val}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
