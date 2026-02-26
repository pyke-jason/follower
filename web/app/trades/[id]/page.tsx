import { notFound } from 'next/navigation';
import { getTradeById, getMessageById, getMessagesByIds, getTradeEvents, getNearbyMessages, getTaskById, getDecisionsForTrade, getBacktestRunById } from '@/lib/queries';
import { Badge } from '../../components/badge';
import { StatItem } from '../../components/stat-item';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { ChatPreview } from '../../messages/chat-preview';
import { FillQuality } from './fill-quality';
import { UnifiedTimeline } from '../../components/decision-timeline';
import { safeParseFloat } from '../../../../src/lib/numbers';
import { computeTradeCommission } from '../../../../src/lib/commission';
import type { BacktestRunConfig, CommissionSchedule } from '../../../../src/db/schema';

export const dynamic = 'force-dynamic';

export default async function TradeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string; from?: string }>;
}) {
  const { id } = await params;
  const { run: runId, from } = await searchParams;
  const trade = await getTradeById(id);
  if (!trade) notFound();

  const [sourceMessage, tradeEvents, task, closeMessage, backtestRun] = await Promise.all([
    trade.sourceMessageId ? getMessageById(trade.sourceMessageId) : Promise.resolve(null),
    getTradeEvents(trade.id),
    trade.taskId ? getTaskById(trade.taskId) : Promise.resolve(null),
    trade.closeMessageId ? getMessageById(trade.closeMessageId) : Promise.resolve(null),
    runId ? getBacktestRunById(runId) : Promise.resolve(null),
  ]);

  const commissionSchedule: CommissionSchedule | undefined =
    (backtestRun?.config as BacktestRunConfig | null)?.commissionSchedule;

  const [nearbyMessages, closeNearbyMessages, decisions] = await Promise.all([
    sourceMessage
      ? getNearbyMessages(sourceMessage.author, sourceMessage.timestamp, 60, trade.symbol)
      : Promise.resolve([]),
    closeMessage
      ? getNearbyMessages(closeMessage.author, closeMessage.timestamp, 60, trade.symbol)
      : Promise.resolve([]),
    getDecisionsForTrade(trade),
  ]);

  // Collect messages for inline quotes in timeline (needs timestamp for sort ordering)
  // Include intermediate messages (e.g., leg-off) discovered via decisions
  const knownMessageIds = new Set([trade.sourceMessageId, trade.closeMessageId].filter(Boolean));
  const intermediateIds = [...new Set(decisions.map(d => d.messageId))].filter(id => !knownMessageIds.has(id));
  const intermediateMessages = intermediateIds.length > 0 ? await getMessagesByIds(intermediateIds) : [];

  const timelineMessages = [sourceMessage, closeMessage, ...intermediateMessages]
    .filter((m): m is NonNullable<typeof m> => m != null)
    .map(m => ({ id: m.id, cleanText: m.cleanText, author: m.author, timestamp: m.timestamp }));

  const legs = trade.legs;

  return (
    <div className="space-y-6 animate-in-up">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href={buildHref(from === 'tasks' ? '/tasks' : '/trades', runId)} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
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
                {(() => {
                  const gross = trade.pnl != null ? safeParseFloat(trade.pnl) : null;
                  const comm = commissionSchedule ? computeTradeCommission(trade, commissionSchedule) : 0;
                  const net = gross != null ? gross - comm : null;
                  return (
                    <>
                      <p className={`text-lg font-bold tabular-nums ${pnlColor(net)}`}>
                        {formatCurrency(net)}
                      </p>
                      {comm > 0 && (
                        <p className="text-[10px] text-muted-foreground tabular-nums">
                          gross {formatCurrency(gross)} &minus; {formatCurrency(comm)} comm
                        </p>
                      )}
                    </>
                  );
                })()}
              </StatItem>
              <StatItem label="Quantity">
                <p className="text-foreground tabular-nums font-medium">{trade.quantity ?? 1}</p>
              </StatItem>
              {trade.realizedPnl && safeParseFloat(trade.realizedPnl) !== 0 && (
                <StatItem label="Realized P&L (trims)">
                  <p className={`tabular-nums font-medium ${pnlColor(trade.realizedPnl)}`}>
                    {formatCurrency(trade.realizedPnl)}
                  </p>
                </StatItem>
              )}
              <StatItem label="Opened">
                <p className="text-foreground">{formatDate(trade.openedAt)}</p>
              </StatItem>
              <StatItem label="Closed">
                <p className="text-foreground">{formatDate(trade.closedAt)}</p>
              </StatItem>
            </CardContent>
          </Card>

          {/* Fill Quality */}
          <FillQuality trade={trade} />

          {/* Unified Timeline — merges trade events + decision events chronologically */}
          {(tradeEvents.length > 0 || decisions.length > 0) && (
            <UnifiedTimeline
              decisions={decisions}
              tradeEvents={tradeEvents}
              closeMessageId={trade.closeMessageId}
              messages={timelineMessages}
            />
          )}
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

          {/* Close Context */}
          {closeMessage && (
            <ChatPreview
              messages={closeNearbyMessages.length > 0 ? closeNearbyMessages : [closeMessage]}
              focusMessageId={trade.closeMessageId ?? undefined}
              author={closeMessage.author}
              title="Close Context"
            />
          )}
        </div>
      </div>
    </div>
  );
}
