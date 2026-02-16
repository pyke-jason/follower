import { notFound } from 'next/navigation';
import { getTradeById, getTradeSteps, getMessageById, getPartialExits, getParentTrade } from '@/lib/queries';
import { Badge } from '../../components/badge';
import { StepViewer } from '../../components/step-viewer';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import Link from 'next/link';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { FillQuality } from './fill-quality';
import { PartialExitTree } from './partial-exit-tree';

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

  const [steps, sourceMessage, childTrades, parentTrade] = await Promise.all([
    trade.taskId ? getTradeSteps(trade.taskId) : Promise.resolve([]),
    trade.sourceMessageId ? getMessageById(trade.sourceMessageId) : Promise.resolve(null),
    getPartialExits(trade.id),
    trade.parentTradeId ? getParentTrade(trade.id) : Promise.resolve(null),
  ]);

  const legs = (trade.legs as any[]) || [];

  return (
    <div className="space-y-6 animate-in-up">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href={buildHref('/trades', runId)} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h2 className="text-lg font-bold text-foreground tracking-tight">{trade.symbol}</h2>
        <div className="flex items-center gap-1.5">
          <Badge label={trade.direction} />
          <Badge label={trade.strategy} />
          <Badge label={trade.status} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6">
        {/* ── Left Column ──────────────────────────────── */}
        <div className="space-y-6 min-w-0">
          {/* Trade Info */}
          <Card className="py-4 gap-0">
            <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Trader</p>
                <p className="text-foreground font-medium">{trade.trader}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Entry Price</p>
                <p className="text-foreground tabular-nums font-medium">{formatCurrency(trade.entryPrice)}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Exit Price</p>
                <p className="text-foreground tabular-nums font-medium">{formatCurrency(trade.exitPrice)}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">P&L</p>
                <p className={`text-lg font-bold tabular-nums ${pnlColor(trade.pnl)}`}>
                  {formatCurrency(trade.pnl)}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Quantity</p>
                <p className="text-foreground tabular-nums font-medium">{trade.quantity}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Opened</p>
                <p className="text-foreground">{formatDate(trade.openedAt)}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Closed</p>
                <p className="text-foreground">{formatDate(trade.closedAt)}</p>
              </div>
            </CardContent>
          </Card>

          {/* Legs */}
          {legs.length > 0 && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardHeader className="border-b py-3 px-4">
                <CardTitle className="text-sm font-medium">Legs</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symbol</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Strike</TableHead>
                      <TableHead>Expiry</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Fill</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {legs.map((leg: any, i: number) => (
                      <TableRow key={i} className="hover:bg-accent/40 transition-colors">
                        <TableCell className="font-medium">{leg.symbol}</TableCell>
                        <TableCell><Badge label={leg.type} /></TableCell>
                        <TableCell className="text-right tabular-nums">{leg.strike}</TableCell>
                        <TableCell className="text-muted-foreground text-xs">{leg.expiry}</TableCell>
                        <TableCell>{leg.action}</TableCell>
                        <TableCell className="text-right tabular-nums">{leg.quantity}</TableCell>
                        <TableCell className="text-right tabular-nums">{leg.fillPrice != null ? formatCurrency(leg.fillPrice) : '--'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Fill Quality */}
          <FillQuality trade={trade} />

          {/* Partial Exits */}
          <PartialExitTree
            trade={trade}
            parentTrade={parentTrade}
            childTrades={childTrades}
            runId={runId}
          />
        </div>

        {/* ── Right Column (sticky) ────────────────────── */}
        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          {/* Source Message */}
          {sourceMessage && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardHeader className="border-b py-3 px-4">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                  Source Message
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold text-foreground">{sourceMessage.author}</span>
                  <span className="text-[10px] text-muted-foreground/60">{formatDate(sourceMessage.timestamp)}</span>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{sourceMessage.cleanText}</p>
                {((sourceMessage.badges as string[]) || []).length > 0 && (
                  <div className="flex gap-1 mt-3">
                    {((sourceMessage.badges as string[]) || []).map((b, i) => (
                      <Badge key={i} label={b} />
                    ))}
                  </div>
                )}
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
      </div>
    </div>
  );
}
