import { memo, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useSearchParam } from '@/hooks/use-search-param';
import { BacktestTabs } from './backtest-tabs';
import { EquityCurveChart } from './equity-curve-chart';
import { DrawdownChart } from './drawdown-chart';
import { BreakdownCharts } from './breakdown-charts';
import { TradeScatter } from './trade-scatter';
import { RollingWinRate } from './rolling-win-rate';
import { OpenPositionsTimeline, type OpenPositionsTimelineMode } from './open-positions-timeline';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { TraderTradeDrilldown } from './trader-trade-drilldown';
import { BacktestTradesPane } from './backtest-trades-pane';
import {
  DiagnosisPanel,
  bucketTrades,
  type DiagnosisBucket,
} from './diagnosis-panel';
import { EmptyState } from '@/components/empty-state';
import { ChatRoom } from '@/views/messages/chat-room';
import { ChatHydrator } from '@/views/messages/chat-hydrator';
import { btChannel } from '@src/lib/channel';
import type { Message, RunDecision, Trade } from '@src/db/schema';
import type { MessageDecision, TradeOutcome } from '@src/lib/enriched-message';
import type { BacktestDetailResponse, TradeLabel } from '@src/local-api/http-schemas';
import type { ChatHydration } from '@/views/messages/chat-hydrator';

type BacktestDecisionJoinRow = {
  decision: RunDecision;
  message: Message;
  trade: { id: string; symbol: string; taskId: string | null; pnl: string | null } | null;
};

function buildBacktestChatData({
  decisions,
  allTrades,
  channelId,
  traders,
  startDate,
  endDate,
  lastProcessedTs,
}: {
  decisions: BacktestDecisionJoinRow[];
  allTrades: Trade[];
  channelId: string;
  traders: string[];
  startDate: string;
  endDate: string;
  lastProcessedTs?: string | null;
}): ChatHydration {
  const tradeById = new Map(allTrades.map((trade) => [trade.id, trade]));
  const latestMessageById = new Map<string, Message>();
  const enrichment: ChatHydration['enrichment'] = {};
  let executedCount = 0;
  let skippedCount = 0;

  for (const row of decisions) {
    if (!latestMessageById.has(row.message.id)) {
      latestMessageById.set(row.message.id, row.message);
    }

    const tradeRow = row.trade?.id ? tradeById.get(row.trade.id) : null;
    const trade: TradeOutcome | null = tradeRow
      ? {
          id: tradeRow.id,
          symbol: tradeRow.symbol,
          direction: tradeRow.direction,
          strategy: tradeRow.strategy,
          entryPrice: tradeRow.entryPrice,
          exitPrice: tradeRow.exitPrice,
          pnl: tradeRow.pnl,
          status: tradeRow.status,
          quantity: tradeRow.quantity,
          openedAt: tradeRow.openedAt,
          closedAt: tradeRow.closedAt,
        }
      : null;

    const outcome = row.decision.outcome;
    const decision: MessageDecision | null =
      outcome === 'EXECUTE' || outcome === 'SKIP' || outcome === 'FAIL' || outcome === 'PENDING'
        ? {
            outcome,
            reasoning: row.decision.reasoning ?? null,
            pnl: row.decision.pnl ?? null,
            phase: row.decision.phase ?? 'agent',
            durationMs: row.decision.durationMs ?? null,
            taskId: row.decision.taskId ?? null,
          }
        : null;

    if (decision?.outcome === 'EXECUTE') executedCount += 1;
    if (decision?.outcome === 'SKIP') skippedCount += 1;

    enrichment[row.message.id] = { decision, trade, intent: null };
  }

  const messages = [...latestMessageById.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    messages,
    enrichment,
    nextCursor: null,
    authors: traders,
    constraints: {
      authors: traders,
      startDate,
      endDate,
      channelId,
      ...(lastProcessedTs ? { lastProcessedTs } : {}),
    },
    stableDecisionCounts: {
      processedCount: executedCount + skippedCount,
      executedCount,
      skippedCount,
    },
  };
}

function noData(height = 200) {
  return (
    <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height }}>
      No data yet
    </div>
  );
}

function BacktestStaticTabsInner({
  id,
  data,
  onLabelPatch,
}: {
  id: string;
  data: BacktestDetailResponse;
  onLabelPatch: (tradeId: string, patch: Partial<TradeLabel>) => void;
}) {
  const [selectedTrader, setSelectedTrader] = useSearchParam('trader');
  const [timelineModeRaw, setTimelineMode] = useSearchParam('timeline', 'total');
  const [diagnosisRaw] = useSearchParam('diagnosis');
  const timelineMode: OpenPositionsTimelineMode = timelineModeRaw === 'by-strategy' ? 'by-strategy' : 'total';
  const {
    run,
    summary,
    byTrader,
    byStrategy,
    equityCurve,
    tradeScatter,
    rollingWinRate,
    decisions,
    allTrades,
    messagesEndDate,
  } = data;
  const config = run.config;
  const channelId = btChannel(id);
  const hasDrawdown = (summary?.maxDrawdown ?? 0) > 0;
  const traderSelected = selectedTrader && byTrader?.[selectedTrader] ? selectedTrader : null;

  const chatData = useMemo(() => buildBacktestChatData({
    decisions,
    allTrades,
    channelId,
    traders: config.traders,
    startDate: config.startDate,
    endDate: messagesEndDate ?? config.endDate,
    lastProcessedTs: run.liveMetrics?.lastProcessedMessageTs ?? null,
  }), [allTrades, channelId, config.endDate, config.startDate, config.traders, decisions, messagesEndDate, run.liveMetrics]);

  const diagnosisEndIso = messagesEndDate ?? config.endDate;
  const diagnosis = useMemo(
    () => bucketTrades(allTrades, diagnosisEndIso),
    [allTrades, diagnosisEndIso],
  );

  const diagnosisBucket: DiagnosisBucket | null =
    diagnosisRaw === 'holding'
    || diagnosisRaw === 'wheel-expiry'
    || diagnosisRaw === 'within-window'
    || diagnosisRaw === 'past-plan'
      ? diagnosisRaw
      : null;

  const diagnosisFilteredTrades = useMemo(() => {
    if (!diagnosisBucket) return [];
    return allTrades.filter((trade) => diagnosis.byTradeId[trade.id] === diagnosisBucket);
  }, [allTrades, diagnosis.byTradeId, diagnosisBucket]);

  const diagnosisFilteredData = useMemo<BacktestDetailResponse>(
    () => ({ ...data, allTrades: diagnosisFilteredTrades }),
    [data, diagnosisFilteredTrades],
  );

  const performanceContent = (
    <div className="space-y-4">
      <div className="grid gap-4 grid-cols-1 md:grid-cols-[3fr_2fr]">
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Equity Curve</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            {equityCurve && equityCurve.length > 0
              ? <EquityCurveChart data={equityCurve} />
              : noData(250)}
          </CardContent>
        </Card>
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Drawdown</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            {equityCurve && equityCurve.length > 0 && hasDrawdown
              ? <DrawdownChart data={equityCurve} />
              : noData(200)}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 grid-cols-1 md:grid-cols-[3fr_2fr]">
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Trade Scatter</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            {tradeScatter.length > 0
              ? <TradeScatter data={tradeScatter} />
              : noData(280)}
          </CardContent>
        </Card>
        <Card className="py-0 gap-0">
          <CardHeader className="border-b py-3 px-4">
            <CardTitle className="text-sm">Rolling Win Rate</CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-2 px-2">
            <RollingWinRate data={rollingWinRate} />
          </CardContent>
        </Card>
      </div>

      <Card className="py-0 gap-0">
        <CardHeader className="border-b py-3 px-4 flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-sm">
            Open Positions Timeline
            {summary?.openAtEnd ? (
              <span className="ml-2 text-xs font-normal text-warning">
                ends with {summary.openAtEnd} still open
              </span>
            ) : null}
          </CardTitle>
          <ToggleGroup
            type="single"
            value={timelineMode}
            onValueChange={(v) => { if (v) setTimelineMode(v as OpenPositionsTimelineMode); }}
            size="sm"
          >
            <ToggleGroupItem value="total" className="text-[10px] px-2 py-0.5">total</ToggleGroupItem>
            <ToggleGroupItem value="by-strategy" className="text-[10px] px-2 py-0.5">by strategy</ToggleGroupItem>
          </ToggleGroup>
        </CardHeader>
        <CardContent className="pt-4 pb-2 px-2">
          {allTrades.length > 0
            ? <OpenPositionsTimeline trades={allTrades} endIso={messagesEndDate} mode={timelineMode} />
            : noData(240)}
        </CardContent>
      </Card>

      <Card className="py-0 gap-0">
        <CardHeader className="border-b py-3 px-4">
          <CardTitle className="text-sm">
            Open Position Diagnosis
            {diagnosis.buckets.find((b) => b.id === 'past-plan')!.count > 0 && (
              <span className="ml-2 text-xs font-normal text-warning">
                {diagnosis.buckets.find((b) => b.id === 'past-plan')!.count} past planned exit
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3 pb-3 px-3">
          <div className="grid gap-3 grid-cols-1 md:grid-cols-[minmax(0,260px)_1fr]">
            <DiagnosisPanel trades={allTrades} endIso={diagnosisEndIso} />
            <div className="min-h-[320px] flex flex-col">
              {diagnosisBucket
                ? (
                  diagnosisFilteredTrades.length > 0
                    ? <BacktestTradesPane id={id} data={diagnosisFilteredData} onLabelPatch={onLabelPatch} />
                    : <EmptyState title="No trades in this bucket" variant="filtered" />
                )
                : (
                  <EmptyState
                    title="Select a bucket"
                    hint="Click a card on the left to inspect the trades in that group."
                  />
                )}
            </div>
          </div>
        </CardContent>
      </Card>

      <BreakdownCharts
        byTrader={byTrader}
        byStrategy={byStrategy}
        channelId={channelId}
        selectedTrader={traderSelected}
        onSelectTrader={(name) => setSelectedTrader(name === traderSelected ? null : name)}
      />

      {traderSelected && (
        <TraderTradeDrilldown
          trader={traderSelected}
          trades={allTrades}
          commissionSchedule={config.commissionSchedule}
          onClear={() => setSelectedTrader(null)}
        />
      )}
    </div>
  );

  const messagesContent = (
    <div className="space-y-3 flex flex-col flex-1 min-h-0">
      <div className="rounded-lg border bg-card overflow-hidden flex flex-col flex-1 min-h-0">
        <ChatHydrator data={chatData} />
        <ChatRoom />
      </div>
    </div>
  );

  const tradesContent = (
    <BacktestTradesPane id={id} data={data} onLabelPatch={onLabelPatch} />
  );

  return (
    <BacktestTabs
      performance={performanceContent}
      messages={messagesContent}
      trades={tradesContent}
      hasMessages={chatData.messages.length > 0}
    />
  );
}

export const BacktestStaticTabs = memo(
  BacktestStaticTabsInner,
  (prev, next) =>
    prev.id === next.id &&
    prev.data.run.config === next.data.run.config &&
    prev.data.run.liveMetrics === next.data.run.liveMetrics &&
    prev.data.summary === next.data.summary &&
    prev.data.byTrader === next.data.byTrader &&
    prev.data.byStrategy === next.data.byStrategy &&
    prev.data.equityCurve === next.data.equityCurve &&
    prev.data.tradeScatter === next.data.tradeScatter &&
    prev.data.rollingWinRate === next.data.rollingWinRate &&
    prev.data.decisions === next.data.decisions &&
    prev.data.allTrades === next.data.allTrades &&
    prev.data.eventsByTradeId === next.data.eventsByTradeId &&
    prev.data.flagsByTradeId === next.data.flagsByTradeId &&
    prev.data.messagesEndDate === next.data.messagesEndDate &&
    prev.data.evalSummary === next.data.evalSummary &&
    prev.data.labelsByTradeId === next.data.labelsByTradeId &&
    prev.onLabelPatch === next.onLabelPatch,
);
