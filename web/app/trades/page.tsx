import { getClosedTrades } from '@/lib/queries';
import { TradeRow } from '../components/trade-row';
import { RunBanner } from '../components/run-banner';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { buildHref } from '@/lib/run-scope';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function TradeHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ trader?: string; symbol?: string; page?: string; run?: string }>;
}) {
  const params = await searchParams;
  const runId = params.run;
  const page = parseInt(params.page ?? '1');
  const limit = 50;
  const offset = (page - 1) * limit;

  const trades = await getClosedTrades({
    trader: params.trader,
    symbol: params.symbol,
    limit,
    offset,
    runId,
  });

  return (
    <div className="space-y-4">
      {runId && <RunBanner runId={runId} currentPath="/trades" />}

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-foreground">Trade History</h2>
        <form className="flex gap-2 items-center">
          {runId && <input type="hidden" name="run" value={runId} />}
          <Input
            name="trader"
            placeholder="Trader"
            defaultValue={params.trader ?? ''}
            className="w-24 h-8 text-xs"
          />
          <Input
            name="symbol"
            placeholder="Symbol"
            defaultValue={params.symbol ?? ''}
            className="w-20 h-8 text-xs"
          />
          <Button type="submit" variant="secondary" size="xs">
            Filter
          </Button>
        </form>
      </div>

      <Card className="py-0 gap-0 overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs text-muted-foreground uppercase">Symbol</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Trader</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Direction</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Strategy</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Entry</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Exit</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">P&L</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Opened</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.map((t) => (
                <TradeRow key={t.id} trade={t} runId={runId} />
              ))}
            </TableBody>
          </Table>
          {trades.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">
              No closed trades
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-2 justify-center items-center">
        {page > 1 && (
          <Button variant="ghost" size="sm" asChild>
            <Link
              href={buildHref(`/trades?page=${page - 1}${params.trader ? `&trader=${params.trader}` : ''}${params.symbol ? `&symbol=${params.symbol}` : ''}`, runId)}
            >
              Previous
            </Link>
          </Button>
        )}
        <span className="text-sm text-muted-foreground">Page {page}</span>
        {trades.length === limit && (
          <Button variant="ghost" size="sm" asChild>
            <Link
              href={buildHref(`/trades?page=${page + 1}${params.trader ? `&trader=${params.trader}` : ''}${params.symbol ? `&symbol=${params.symbol}` : ''}`, runId)}
            >
              Next
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
