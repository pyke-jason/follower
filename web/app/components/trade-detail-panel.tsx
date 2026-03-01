'use client';

import { useState } from 'react';
import { useTradesStore } from '@/stores/trades-store';
import type { TradeStoryDecision } from '../trades/actions';
import { SignalDecisionSummary } from './signal-decision-summary';
import { UnifiedTimeline } from './decision-timeline';
import { Badge } from './badge';
import { formatDate } from '@/lib/format';
import { X } from 'lucide-react';
import type { Message } from '@src/db/schema';

const INITIAL_VISIBLE = 3;

function NearbyMessages({
  messages,
  sourceMessageId,
}: {
  messages: Message[];
  sourceMessageId?: string | null;
}) {
  const [showAll, setShowAll] = useState(false);

  if (messages.length === 0) return null;

  const sourceIdx = messages.findIndex((m) => m.id === sourceMessageId);
  const cutoff = sourceIdx >= 0 ? sourceIdx + INITIAL_VISIBLE : INITIAL_VISIBLE;
  const visible = showAll ? messages : messages.slice(0, cutoff);
  const hiddenCount = messages.length - visible.length;

  return (
    <div className="space-y-0.5">
      {visible.map((m) => {
        const isSource = m.id === sourceMessageId;
        return (
          <div
            key={m.id}
            className={`flex items-baseline gap-2 text-xs px-2 py-1 rounded ${isSource ? 'bg-accent/40 border-l-2 border-l-foreground/30' : ''}`}
          >
            <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">
              {formatDate(m.timestamp)}
            </span>
            <span className={`truncate ${isSource ? 'text-foreground' : 'text-muted-foreground/70'}`}>
              {m.cleanText}
            </span>
          </div>
        );
      })}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground px-2 py-0.5 transition-colors"
        >
          +{hiddenCount} more
        </button>
      )}
    </div>
  );
}

function narrowDecision(d: TradeStoryDecision | null) {
  if (!d?.outcome) return null;
  return { ...d, outcome: d.outcome };
}

export function TradeDetailPanel({ onClose }: { onClose: () => void }) {
  const trade = useTradesStore((s) => {
    const id = s.selectedTradeId;
    return id ? s.trades.find((t) => t.id === id) ?? null : null;
  });
  const story = useTradesStore((s) => s.story);
  const isLoading = useTradesStore((s) => s.isLoadingStory);
  const runId = useTradesStore((s) => s.runId);

  if (!trade) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Sticky header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background sticky top-0 z-10">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm truncate">{trade.symbol}</span>
          <Badge label={trade.status} />
          <Badge label={trade.direction} />
          <Badge label={trade.strategy} />
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0 ml-2"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-4 py-4 space-y-5 min-w-0">
        {isLoading ? (
          <p className="text-sm text-muted-foreground text-center py-6">Loading...</p>
        ) : story ? (
          <>
            {/* Signal */}
            <section>
              <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Signal</h4>
              <SignalDecisionSummary
                sourceMessage={story.sourceMessage ? {
                  cleanText: story.sourceMessage.cleanText,
                  author: story.sourceMessage.author,
                  timestamp: formatDate(story.sourceMessage.timestamp),
                } : null}
                decision={narrowDecision(story.decision)}
                taskId={story.task?.id}
                runId={runId ?? undefined}
              />
            </section>

            {/* Close signal */}
            {story.closeMessage && (
              <section>
                <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Close Signal</h4>
                <div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-medium">{story.closeMessage.author}</span>
                    <span className="text-[10px] text-muted-foreground/60">{formatDate(story.closeMessage.timestamp)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-3">{story.closeMessage.cleanText}</p>
                </div>
              </section>
            )}

            {/* Execution Timeline */}
            {(story.events.length > 0 || story.decisions.length > 0) && (
              <section>
                <UnifiedTimeline />
              </section>
            )}

            {/* Nearby messages */}
            {story.nearbyMessages.length > 0 && (
              <section>
                <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Trader Messages</h4>
                <NearbyMessages messages={story.nearbyMessages} sourceMessageId={trade.sourceMessageId} />
              </section>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">Trade data not available</p>
        )}
      </div>
    </div>
  );
}
