import { notFound } from 'next/navigation';
import { getTradeById, getTradeSteps, getMessageById } from '@/lib/queries';
import { Badge } from '../../components/badge';
import { RunBanner } from '../../components/run-banner';
import { StepViewer } from '../../components/step-viewer';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function TradeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { id } = await params;
  const { run: runId } = await searchParams;
  const trade = await getTradeById(id);
  if (!trade) notFound();

  const [steps, sourceMessage] = await Promise.all([
    trade.taskId ? getTradeSteps(trade.taskId) : Promise.resolve([]),
    trade.sourceMessageId ? getMessageById(trade.sourceMessageId) : Promise.resolve(null),
  ]);

  const legs = (trade.legs as any[]) || [];

  return (
    <div className="space-y-6 max-w-4xl">
      {runId && <RunBanner runId={runId} currentPath={`/trades/${id}`} />}

      <div className="flex items-center gap-3">
        <Link href={buildHref('/trades', runId)} className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Trades
        </Link>
        <h2 className="text-xl font-bold text-foreground">{trade.symbol}</h2>
        <Badge label={trade.direction} />
        <Badge label={trade.strategy} />
        <Badge label={trade.status} />
      </div>

      {/* Trade Info */}
      <Card className="py-4 gap-0">
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Trader</p>
            <p className="text-foreground">{trade.trader}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Entry Price</p>
            <p className="text-foreground">{formatCurrency(trade.entryPrice)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Exit Price</p>
            <p className="text-foreground">{formatCurrency(trade.exitPrice)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">P&L</p>
            <p className={`font-medium ${pnlColor(trade.pnl)}`}>
              {formatCurrency(trade.pnl)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Quantity</p>
            <p className="text-foreground">{trade.quantity}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Opened</p>
            <p className="text-foreground">{formatDate(trade.openedAt)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Closed</p>
            <p className="text-foreground">{formatDate(trade.closedAt)}</p>
          </div>
        </CardContent>
      </Card>

      {/* Legs */}
      {legs.length > 0 && (
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Legs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Symbol</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Type</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Strike</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Expiry</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Action</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Qty</TableHead>
                  <TableHead className="text-xs text-muted-foreground uppercase px-4">Fill</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {legs.map((leg: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="px-4">{leg.symbol}</TableCell>
                    <TableCell className="px-4"><Badge label={leg.type} /></TableCell>
                    <TableCell className="px-4">{leg.strike}</TableCell>
                    <TableCell className="px-4 text-muted-foreground">{leg.expiry}</TableCell>
                    <TableCell className="px-4">{leg.action}</TableCell>
                    <TableCell className="px-4">{leg.quantity}</TableCell>
                    <TableCell className="px-4">{leg.fillPrice != null ? formatCurrency(leg.fillPrice) : '--'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Source Message */}
      {sourceMessage && (
        <Card className="py-4 gap-2">
          <CardHeader className="py-0">
            <CardTitle className="text-sm">Source Message</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="text-muted-foreground">
              {sourceMessage.author} &middot; {formatDate(sourceMessage.timestamp)}
            </p>
            <p className="text-foreground/80 mt-1">{sourceMessage.cleanText}</p>
            <div className="flex gap-1 mt-2">
              {((sourceMessage.badges as string[]) || []).map((b, i) => (
                <Badge key={i} label={b} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Audit Trail */}
      {steps.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-foreground mb-3">Audit Trail</h3>
          <StepViewer steps={steps} />
        </div>
      )}
    </div>
  );
}
