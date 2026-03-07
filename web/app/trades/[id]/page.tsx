import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useChannelId } from '@/hooks/use-channel-id';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge } from '../../components/badge';
import { StatItem } from '../../components/stat-item';
import { LegsTable } from '../../components/legs-table';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { formatCurrency, formatDate, pnlColor } from '@/lib/format';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { ArrowLeft } from 'lucide-react';
import { ChatPreview } from '../../messages/chat-preview';
import { FillQuality } from './fill-quality';
import { EventTimeline } from './event-timeline';
import { DecisionReasoning } from './decision-reasoning';
import { ParsedContext } from './parsed-context';
import { ExecutionFlamegraph, extractFlamegraphData } from '../../components/execution-flamegraph';
import type { Trade, Message, TradeEvent, Task, RunDecision } from '@src/db/schema';

type TradeStoryResponse = {
  trade: Trade;
  events: TradeEvent[];
  task: Task | null;
  sourceMessage: Message | null;
  closeMessage: Message | null;
  nearbyMessages: Message[];
  decision: RunDecision | null;
  decisions: RunDecision[];
  timelineMessages: Message[];
};

const Spinner = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin h-6 w-6 border-2 border-muted-foreground/20 border-t-foreground rounded-full" />
  </div>
);

export default function TradeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const channelId = useChannelId();
  const href = useScopedHref();
  const from = params.get('from') ?? undefined;

  const { data } = useQuery<TradeStoryResponse>({
    queryKey: ['trade', id, channelId],
    queryFn: () => api<TradeStoryResponse>(href(`/trades/${id}/story`)),
  });

  if (!data) return <Spinner />;

  const { trade, events: tradeEvents, task, sourceMessage, closeMessage, nearbyMessages, decision } = data;
  const context = task?.context ?? null;
  const legs = trade.legs;
  const commission = 0;
  const closeNearbyMessages: Message[] = [];

  return (
    <div className="space-y-6 animate-in-up">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to={href(from === 'tasks' ? '/tasks' : '/trades')} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
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
        {/* Left Column */}
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
                  const gross = trade.pnl != null ? parseFloat(String(trade.pnl)) : null;
                  const comm = commission ?? 0;
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
              {trade.realizedPnl && parseFloat(String(trade.realizedPnl)) !== 0 && (
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

          {/* Execution Trace */}
          {data.decisions.length > 0 && (() => {
            const fg = extractFlamegraphData(data.decisions);
            if (!fg) return null;
            return (
              <Card className="py-0 gap-0">
                <CardHeader className="border-b py-3 px-4">
                  <CardTitle className="text-sm font-medium">Execution Trace</CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <ExecutionFlamegraph {...fg} />
                </CardContent>
              </Card>
            );
          })()}

          {/* Event Timeline */}
          {tradeEvents.length > 0 && (
            <EventTimeline events={tradeEvents} closeMessageId={trade.closeMessageId} />
          )}

          {/* Signal Decision */}
          {decision && (
            <DecisionReasoning
              decision={decision}
              taskStartedAt={task?.startedAt}
              taskCompletedAt={task?.completedAt}
            />
          )}

          {/* Parsed Context */}
          {context && <ParsedContext context={context} />}
        </div>

        {/* Right Column (sticky) */}
        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          {/* Chat Context */}
          <ChatPreview
            messages={nearbyMessages.length > 0 ? nearbyMessages : sourceMessage ? [sourceMessage] : []}
            focusMessageId={trade.sourceMessageId ?? undefined}
            author={sourceMessage?.author ?? trade.trader}
            viewAllHref={href('/messages', { authors: sourceMessage?.author ?? trade.trader })}
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
