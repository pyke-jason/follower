import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { buildScopedPath } from '@/lib/channel-scope';
import { useTradesView } from '@/components/trades-view-context';
import { TradeLabelSection } from './trade-label-section';
import { TradeSnapshotCard } from './trade-snapshot-card';
import { DetailPanel } from './detail-panel';
import { SignalDecisionSummary } from './signal-decision-summary';
import { UnifiedTimeline } from './decision-timeline';
import { LegsTable } from './legs-table';
import { TradeStatusPanel } from './trade-status-panel';
import { TraderActivity } from './trader-activity';
import { isBacktestChannel } from '@src/lib/channel';
import type { Trade } from '@src/db/schema';
import type { TradeStory } from '@/lib/trade-story';

export function TradeDetailPanel({
  trade,
  showLabelSection,
  onClose,
}: {
  trade: Trade | null;
  showLabelSection?: boolean;
  onClose: () => void;
}) {
  const { labelsByTradeId, livePositionsByTradeId, channelId, patchLabel } = useTradesView();
  const query = useQuery<TradeStory>({
    queryKey: ['trade', trade?.id, channelId],
    queryFn: () => api<TradeStory>(buildScopedPath(`/trades/${trade!.id}/story`, channelId)),
    enabled: trade != null,
    refetchInterval: (current) => (current.state.data?.trade?.status === 'OPEN' ? 10_000 : false),
  });
  const { refetch } = query;
  const previousTradeRef = useRef<Trade | null>(null);

  useEffect(() => {
    if (!trade) {
      previousTradeRef.current = null;
      return;
    }
    if (previousTradeRef.current && previousTradeRef.current !== trade) {
      void refetch();
    }
    previousTradeRef.current = trade;
  }, [refetch, trade]);

  if (!trade) return null;

  const story = query.data;
  const isLoading = query.isLoading || query.isFetching;
  const storyTrade = story?.trade ?? trade;
  const isBacktest = isBacktestChannel(storyTrade.channelId);
  const label = labelsByTradeId[trade.id];
  const livePosition = livePositionsByTradeId[trade.id] ?? null;

  if (isLoading && !story) {
    return (
      <div className="flex h-full flex-col">
        <div className="sticky top-0 z-10 flex justify-end border-b bg-background px-4 py-3">
          <Button variant="ghost" size="icon" aria-label="Close detail panel" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="px-4 py-6 text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!story) {
    return (
      <div className="flex h-full flex-col">
        <div className="sticky top-0 z-10 flex justify-end border-b bg-background px-4 py-3">
          <Button variant="ghost" size="icon" aria-label="Close detail panel" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="px-4 py-6 text-sm text-muted-foreground">Trade data not available</div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <div className="space-y-4">
        <TradeSnapshotCard trade={storyTrade} livePosition={livePosition ?? null} onClose={onClose} />

        {showLabelSection && (
          <section className="border-t border-border/70 pt-4">
            <div className="pb-3">
              <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                Label
              </span>
            </div>
            <TradeLabelSection
              label={label}
              trade={storyTrade}
              systemDecision={story.decision}
              sourceMessage={story.sourceMessage}
              closeMessage={story.closeMessage}
              onLabelPatch={patchLabel}
            />
          </section>
        )}

        {(story.sourceMessage || story.decision || story.task) && (
          <DetailPanel
            title="Why This Trade"
            description="What the trader said and how the system translated it into a position."
            eyebrow="Decision"
          >
            <SignalDecisionSummary
              sourceMessage={story.sourceMessage}
              decision={story.decision}
              taskId={story.task?.id ?? story.decision?.taskId ?? null}
            />
          </DetailPanel>
        )}

        {!isBacktest && <TradeStatusPanel trade={storyTrade} />}

        {(story.events.length > 0 || story.decisions.length > 0) && (
          <DetailPanel
            title="Execution Timeline"
            description="Parser, routing, order placement, fills, and final trade events in one audit trail."
            eyebrow="Trace"
            contentClassName="pb-5 pt-4"
          >
            <UnifiedTimeline
              trade={story.trade}
              decisions={story.decisions}
              events={story.events}
              timelineMessages={story.timelineMessages}
              intent={story.intent}
            />
          </DetailPanel>
        )}

        {storyTrade.legs.length > 1 && (
          <DetailPanel
            title="Leg Structure"
            description="Per-leg strikes, expiries, and fill data."
            eyebrow="Structure"
            contentClassName="p-0"
          >
            <LegsTable legs={storyTrade.legs} showFills />
          </DetailPanel>
        )}

        {storyTrade.trader && storyTrade.symbol && (
          <TraderActivity
            messages={story.subsequentMessages}
            trader={storyTrade.trader}
            symbol={storyTrade.symbol}
            sourceMessage={story.sourceMessage}
            closeMessageId={storyTrade.closeMessageId ?? null}
          />
        )}

        {isBacktest && (
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={onClose}>
              Close panel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
