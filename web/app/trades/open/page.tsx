import { getOpenTrades } from '@/lib/queries';
import { Badge } from '../../components/badge';
import { RunBanner } from '../../components/run-banner';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { formatCurrency, formatDate } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import { forceExitTrade } from '../actions';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function OpenTradesPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const { run: runId } = await searchParams;
  const trades = await getOpenTrades(50, runId);

  return (
    <div className="space-y-4">
      {runId && <RunBanner runId={runId} currentPath="/trades/open" />}

      <h2 className="text-xl font-bold text-foreground">Open Positions</h2>

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
                <TableHead className="text-xs text-muted-foreground uppercase">Qty</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Opened</TableHead>
                {!runId && <TableHead className="text-xs text-muted-foreground uppercase">Action</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <Link href={buildHref(`/trades/${t.id}`, runId)} className="text-blue-400 hover:underline">
                      {t.symbol}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{t.trader}</TableCell>
                  <TableCell><Badge label={t.direction} /></TableCell>
                  <TableCell><Badge label={t.strategy} /></TableCell>
                  <TableCell>{formatCurrency(t.entryPrice)}</TableCell>
                  <TableCell className="text-muted-foreground">{t.quantity}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{formatDate(t.openedAt)}</TableCell>
                  {!runId && (
                    <TableCell>
                      <form action={forceExitTrade}>
                        <input type="hidden" name="tradeId" value={t.id} />
                        <Button
                          type="submit"
                          variant="destructive"
                          size="xs"
                          onClick={(e: React.MouseEvent) => {
                            if (!confirm(`Force exit ${t.symbol}?`)) {
                              e.preventDefault();
                            }
                          }}
                        >
                          EXIT
                        </Button>
                      </form>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {trades.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">
              No open positions
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
