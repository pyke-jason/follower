import type { ReactNode } from 'react';
import { LegsTable } from './legs-table';
import { UnifiedTimeline } from './decision-timeline';
import { PositionHero } from './position-hero';
import { ReconAlertBanner } from './recon-alert-banner';
import { TraderActivity } from './trader-activity';
import { cn } from '@/lib/utils';
import type { TradeStory } from '@/stores/trades-store';
import { DetailPanel } from './detail-panel';
import { TradeStatusPanel } from './trade-status-panel';

/**
 * Single render target for both /trades/:id and /tasks/:id. Every section
 * handles the no-trade case by either hiding itself (legs, trade events, actions)
 * or showing muted state (hero metrics). The trader-activity panel and
 * LLM-reasoning section render identically in both cases since they don't
 * depend on the trade row existing.
 */
export function ActivityDetail({
  story,
  backHref,
  compact = false,
  heroActions,
}: {
  story: TradeStory;
  backHref?: string | null;
  compact?: boolean;
  heroActions?: ReactNode;
}) {
  const {
    trade, task, events, sourceMessage, intent, reconAlerts, livePosition,
    subsequentMessages, decisions, timelineMessages, decision,
  } = story;

  const trader = trade?.trader ?? task?.context?.author ?? null;
  const symbol = trade?.symbol ?? task?.context?.symbols?.[0] ?? null;

  const hasMultipleLegs = (trade?.legs.length ?? 0) > 1;
  const hasTimeline = events.length > 0 || decisions.length > 0;
  const actions = heroActions ?? null;

  return (
    <div className={cn('animate-in-up space-y-6', compact && 'space-y-5')}>
      {reconAlerts.length > 0 && <ReconAlertBanner alerts={reconAlerts} />}

      <PositionHero
        trade={trade}
        task={task}
        decision={decision}
        livePosition={livePosition}
        backHref={backHref}
        actions={actions}
      />

      <div className={cn('grid gap-6', compact ? 'grid-cols-1' : 'grid-cols-1 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,420px)]')}>
        <div className="min-w-0 space-y-6">
          {hasTimeline && (
            <DetailPanel
              title="Execution timeline"
              description="Parser, routing, order placement, fills, and final trade events in one audit trail."
              eyebrow="Trace"
              contentClassName="pb-6 pt-5"
            >
              <UnifiedTimeline
                trade={trade}
                decisions={decisions}
                events={events}
                timelineMessages={timelineMessages}
                intent={intent}
              />
            </DetailPanel>
          )}

          {trade && hasMultipleLegs && (
            <DetailPanel
              title="Leg structure"
              description="Per-leg strikes, expiries, and fill data for this position."
              eyebrow="Structure"
              contentClassName="p-0"
            >
              <LegsTable legs={trade.legs} showFills />
            </DetailPanel>
          )}
        </div>

        <div className={cn('space-y-6', !compact && 'xl:sticky xl:top-4 xl:self-start')}>
          {trade && <TradeStatusPanel trade={trade} />}

          {trader && symbol && (
            <TraderActivity
              messages={subsequentMessages}
              trader={trader}
              symbol={symbol}
              sourceMessage={sourceMessage}
              closeMessageId={trade?.closeMessageId ?? null}
            />
          )}
        </div>
      </div>
    </div>
  );
}
