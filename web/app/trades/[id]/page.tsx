import { notFound } from 'next/navigation';
import { getTradeById, getTradeSteps, getMessageById, getPartialExits, getParentTrade, getNearbyMessages } from '@/lib/queries';
import { Badge } from '../../components/badge';
import { StatItem } from '../../components/stat-item';
import { LegsTable } from '../../components/legs-table';
import { StepViewer } from '../../components/step-viewer';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { ChatPreview } from '../../messages/chat-preview';
import { FillQuality } from './fill-quality';
import { PartialExitTree } from './partial-exit-tree';
import type { TradeLeg } from '../../../../src/db/schema';

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

  const nearbyMessages = sourceMessage
    ? await getNearbyMessages(sourceMessage.author, sourceMessage.timestamp, 60)
    : [];

  const legs = (trade.legs as TradeLeg[]) || [];

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
              <StatItem label="Trader">
                <p className="text-foreground font-medium">{trade.trader}</p>
              </StatItem>
              <StatItem label="Entry Price">
                <p className="text-foreground tabular-nums font-medium">{formatCurrency(trade.entryPrice)}</p>
              </StatItem>
              <StatItem label="Exit Price">
                <p className="text-foreground tabular-nums font-medium">{formatCurrency(trade.exitPrice)}</p>
              </StatItem>
              <StatItem label="P&L">
                <p className={`text-lg font-bold tabular-nums ${pnlColor(trade.pnl)}`}>
                  {formatCurrency(trade.pnl)}
                </p>
              </StatItem>
              <StatItem label="Quantity">
                <p className="text-foreground tabular-nums font-medium">{trade.quantity}</p>
              </StatItem>
              <StatItem label="Opened">
                <p className="text-foreground">{formatDate(trade.openedAt)}</p>
              </StatItem>
              <StatItem label="Closed">
                <p className="text-foreground">{formatDate(trade.closedAt)}</p>
              </StatItem>
            </CardContent>
          </Card>

          {/* Legs */}
          {legs.length > 0 && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardHeader className="border-b py-3 px-4">
                <CardTitle className="text-sm font-medium">Legs</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <LegsTable legs={legs} showFills />
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
          {/* Chat Context */}
          <ChatPreview
            messages={nearbyMessages.length > 0 ? nearbyMessages : sourceMessage ? [sourceMessage] : []}
            focusMessageId={trade.sourceMessageId ?? undefined}
            author={sourceMessage?.author ?? trade.trader}
            viewAllHref={`/messages?authors=${encodeURIComponent(sourceMessage?.author ?? trade.trader)}`}
          />

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
