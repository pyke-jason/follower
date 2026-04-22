import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { LegsTable } from './legs-table';
import { UnifiedTimeline } from './decision-timeline';
import { PositionHero } from './position-hero';
import { ReconAlertBanner } from './recon-alert-banner';
import { TraderActivity } from './trader-activity';
import { TradeActions } from './trade-actions';
import type { TradeStory } from '@/stores/trades-store';

/**
 * Single render target for both /trades/:id and /tasks/:id. Every section
 * handles the no-trade case by either hiding itself (legs, trade events, actions)
 * or showing muted state (hero metrics). The trader-activity panel and
 * LLM-reasoning section render identically in both cases since they don't
 * depend on the trade row existing.
 */
export function ActivityDetail({ story, backHref }: {
  story: TradeStory;
  backHref: string;
}) {
  const {
    trade, task, events, sourceMessage, intent, reconAlerts, livePosition,
    subsequentMessages, decisions, timelineMessages, decision,
  } = story;

  const trader = trade?.trader ?? task?.context?.author ?? null;
  const symbol = trade?.symbol ?? task?.context?.symbols?.[0] ?? null;

  const hasMultipleLegs = (trade?.legs.length ?? 0) > 1;
  const hasTimeline = events.length > 0 || decisions.length > 0;

  return (
    <div className="space-y-5 animate-in-up">
      {reconAlerts.length > 0 && <ReconAlertBanner alerts={reconAlerts} />}

      <PositionHero
        trade={trade}
        task={task}
        decision={decision}
        livePosition={livePosition}
        backHref={backHref}
        actions={trade ? <TradeActions trade={trade} /> : null}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_440px] gap-5">
        <div className="space-y-5 min-w-0">
          {hasTimeline && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardContent className="py-5">
                <UnifiedTimeline
                  trade={trade}
                  decisions={decisions}
                  events={events}
                  timelineMessages={timelineMessages}
                  intent={intent}
                />
              </CardContent>
            </Card>
          )}

          {trade && hasMultipleLegs && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardHeader className="border-b py-3 px-4">
                <CardTitle className="text-sm font-medium">Legs</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <LegsTable legs={trade.legs} showFills />
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-5 lg:sticky lg:top-4 lg:self-start">
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
