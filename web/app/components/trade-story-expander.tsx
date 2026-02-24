'use client';

import { useState, useEffect, useTransition } from 'react';
import { fetchTradeStory } from '../trades/actions';
import type { TradeStory } from '../trades/actions';
import { SignalDecisionSummary } from './signal-decision-summary';
import { CompactEventChain } from './compact-event-chain';
import { OutcomeLegsSummary } from './outcome-legs-summary';
import { formatDate } from '@/lib/format';
import { TableRow, TableCell } from '@/components/ui/table';
import { MessageSquare } from 'lucide-react';
import type { Trade, CommissionSchedule, Message } from '../../../src/db/schema';

function NearbyMessages({ messages, sourceMessageId }: { messages: Message[]; sourceMessageId?: string | null }) {
  if (messages.length === 0) return null;

  // Show up to 5 messages centered around the source message
  const sourceIdx = messages.findIndex((m) => m.id === sourceMessageId);
  let start = 0;
  let end = messages.length;
  if (messages.length > 5) {
    const center = sourceIdx >= 0 ? sourceIdx : Math.floor(messages.length / 2);
    start = Math.max(0, center - 2);
    end = Math.min(messages.length, start + 5);
    if (end - start < 5) start = Math.max(0, end - 5);
  }
  const slice = messages.slice(start, end);

  return (
    <div className="space-y-0.5">
      {slice.map((m) => {
        const isSource = m.id === sourceMessageId;
        return (
          <div
            key={m.id}
            className={`flex items-baseline gap-2 text-xs px-2 py-1 rounded ${isSource ? 'bg-accent/40 border-l-2 border-l-foreground/30' : ''}`}
          >
            <span className={`shrink-0 font-medium ${isSource ? 'text-foreground' : 'text-muted-foreground'}`}>
              {m.author}
            </span>
            <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">
              {formatDate(m.timestamp)}
            </span>
            <span className={`truncate ${isSource ? 'text-foreground' : 'text-muted-foreground/70'}`}>
              {m.cleanText}
            </span>
          </div>
        );
      })}
      {messages.length > 5 && (
        <p className="text-[10px] text-muted-foreground/40 px-2">
          +{messages.length - 5} more messages
        </p>
      )}
    </div>
  );
}

export function TradeStoryExpander({
  trade,
  runId,
  commissionSchedule,
  colSpan,
}: {
  trade: Trade;
  runId?: string;
  commissionSchedule?: CommissionSchedule;
  colSpan: number;
}) {
  const [story, setStory] = useState<TradeStory | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [isLoading, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const result = await fetchTradeStory(trade.id, runId);
      setStory(result);
    });
  }, [trade.id, runId]);

  return (
    <TableRow className="bg-accent/10 hover:bg-accent/10">
      <TableCell colSpan={colSpan} className="p-0">
        <div className="px-6 py-4 border-t border-border">
          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <p className="text-sm text-muted-foreground">Loading trade story...</p>
            </div>
          ) : story ? (
            <div className="space-y-0">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Zone A: Signal + Decision */}
                <div>
                  <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Signal</h4>
                  <SignalDecisionSummary
                    sourceMessage={story.sourceMessage ? {
                      cleanText: story.sourceMessage.cleanText,
                      author: story.sourceMessage.author,
                      timestamp: formatDate(story.sourceMessage.timestamp),
                    } : null}
                    decision={story.decision}
                    taskId={story.task?.id}
                    runId={runId}
                  />

                  {story.closeMessage && (
                    <div className="mt-3 pt-3 border-t border-border/50">
                      <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Close Signal</h4>
                      <div>
                        <div className="flex items-baseline gap-2">
                          <span className="text-xs font-medium">{story.closeMessage.author}</span>
                          <span className="text-[10px] text-muted-foreground/60">{formatDate(story.closeMessage.timestamp)}</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-3">{story.closeMessage.cleanText}</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Zone B: Event Timeline */}
                <div>
                  <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Events</h4>
                  {story.events.length > 0 ? (
                    <CompactEventChain events={story.events} closeMessageId={story.trade.closeMessageId} />
                  ) : (
                    <p className="text-xs text-muted-foreground/60">No events</p>
                  )}
                </div>

                {/* Zone C: Outcome + Legs */}
                <div>
                  <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Outcome</h4>
                  <OutcomeLegsSummary
                    trade={story.trade}
                    commissionSchedule={commissionSchedule}
                    runId={runId}
                  />
                </div>
              </div>

              {/* Zone D: Nearby chat messages (collapsible) */}
              {story.nearbyMessages.length > 0 && (
                <div className="mt-4 pt-3 border-t border-border/50">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setShowChat(!showChat); }}
                    className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <MessageSquare className="h-3 w-3" />
                    {showChat ? 'Hide' : 'Show'} chat context ({story.nearbyMessages.length})
                  </button>
                  {showChat && (
                    <div className="mt-2">
                      <NearbyMessages messages={story.nearbyMessages} sourceMessageId={trade.sourceMessageId} />
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">Trade data not available</p>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
