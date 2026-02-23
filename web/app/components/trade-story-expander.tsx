'use client';

import { useState, useEffect, useTransition } from 'react';
import { fetchTradeStory } from '../trades/actions';
import type { TradeStory } from '../trades/actions';
import { SignalDecisionSummary } from './signal-decision-summary';
import { CompactEventChain } from './compact-event-chain';
import { OutcomeLegsSummary } from './outcome-legs-summary';
import { formatDate } from '@/lib/format';
import { TableRow, TableCell } from '@/components/ui/table';
import type { Trade, CommissionSchedule } from '../../../src/db/schema';

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
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">Trade data not available</p>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
