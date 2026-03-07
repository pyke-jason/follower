import { useState } from 'react';
import { useTradesStore } from '@/stores/trades-store';
import { SignalDecisionSummary } from './signal-decision-summary';
import { UnifiedTimeline } from './decision-timeline';
import { Badge } from './badge';
import { formatDate } from '@/lib/format';
import { X } from 'lucide-react';
import { REACTION_EMOJI } from './decision-shared';
import type { Message, RunDecision } from '@src/db/schema';
import { formatLegsSummary } from '@src/lib/trade';
import { ExecutionFlamegraph, extractFlamegraphData } from './execution-flamegraph';

function NearbyMessages({
  messages,
  associatedMessageIds,
}: {
  messages: Message[];
  /** IDs of messages directly associated with the trade (source, close, intermediates). */
  associatedMessageIds: Set<string>;
}) {
  const [showOlder, setShowOlder] = useState(false);
  const [showNewer, setShowNewer] = useState(false);

  if (messages.length === 0) return null;

  // Find the index range of associated messages within the sorted list
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (associatedMessageIds.has(messages[i].id)) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }

  // Fallback: if no associated messages found in the list, show all
  if (firstIdx === -1) {
    firstIdx = 0;
    lastIdx = messages.length - 1;
  }

  const before = messages.slice(0, firstIdx);
  const inRange = messages.slice(firstIdx, lastIdx + 1);
  const after = messages.slice(lastIdx + 1);

  return (
    <div className="space-y-0.5">
      {before.length > 0 && !showOlder && (
        <button
          type="button"
          onClick={() => setShowOlder(true)}
          className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground px-2 py-0.5 transition-colors"
        >
          Show {before.length} older
        </button>
      )}
      {showOlder && before.map((m) => (
        <MessageRow key={m.id} message={m} isAssociated={false} />
      ))}
      {inRange.map((m) => (
        <MessageRow key={m.id} message={m} isAssociated={associatedMessageIds.has(m.id)} />
      ))}
      {after.length > 0 && !showNewer && (
        <button
          type="button"
          onClick={() => setShowNewer(true)}
          className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground px-2 py-0.5 transition-colors"
        >
          Show {after.length} newer
        </button>
      )}
      {showNewer && after.map((m) => (
        <MessageRow key={m.id} message={m} isAssociated={false} />
      ))}
    </div>
  );
}

function ReactionBadges({ reactions }: { reactions: { Type: string; Count: number }[] }) {
  if (!reactions || reactions.length === 0) return null;
  return (
    <span className="inline-flex gap-1 shrink-0">
      {reactions.map((r) => (
        <span key={r.Type} className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/70 bg-muted/50 rounded px-1 py-px">
          <span>{REACTION_EMOJI[r.Type] ?? r.Type}</span>
          {r.Count > 1 && <span className="tabular-nums">{r.Count}</span>}
        </span>
      ))}
    </span>
  );
}

function MessageRow({ message: m, isAssociated }: { message: Message; isAssociated: boolean }) {
  return (
    <div
      className={`flex items-baseline gap-2 text-xs px-2 py-1 rounded ${isAssociated ? 'bg-accent/40 border-l-2 border-l-foreground/30' : ''}`}
    >
      <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">
        {formatDate(m.timestamp)}
      </span>
      <span className={`truncate ${isAssociated ? 'text-foreground' : 'text-muted-foreground/70'}`}>
        {m.cleanText}
      </span>
      {m.reactions.length > 0 && <ReactionBadges reactions={m.reactions} />}
    </div>
  );
}

function narrowDecision(d: RunDecision | null) {
  if (!d?.outcome) return null;
  return d;
}

export function TradeDetailPanel({ onClose }: { onClose: () => void }) {
  const trade = useTradesStore((s) => {
    const id = s.selectedTradeId;
    return id ? s.trades.find((t) => t.id === id) ?? null : null;
  });
  const story = useTradesStore((s) => s.story);
  const isLoading = useTradesStore((s) => s.isLoadingStory);
  const channelId = useTradesStore((s) => s.channelId);

  if (!trade) return null;

  // Use OPEN event legs/strategy to show original trade (pre-leg-off)
  const openEvent = story?.events.find(e => e.action === 'OPEN');
  const openLegs = openEvent ? openEvent.legs : trade.legs;
  const openStrategy = openEvent?.strategy ?? trade.strategy;
  const contractSummary = formatLegsSummary(openLegs, openStrategy);

  return (
    <div className="flex flex-col h-full">
      {/* Sticky header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background sticky top-0 z-10">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm truncate">{trade.symbol}</span>
          {contractSummary && <span className="text-xs text-muted-foreground tabular-nums">{contractSummary}</span>}
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

            {/* Execution Flamegraph */}
            {story.decisions.length > 0 && (() => {
              const fg = extractFlamegraphData(story.decisions);
              if (!fg) return null;
              return (
                <section>
                  <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Execution Trace</h4>
                  <ExecutionFlamegraph {...fg} compact />
                </section>
              );
            })()}

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
                <NearbyMessages
                  messages={story.nearbyMessages}
                  associatedMessageIds={new Set(story.timelineMessages.map(m => m.id))}
                />
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
