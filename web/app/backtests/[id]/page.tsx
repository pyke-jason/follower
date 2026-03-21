import { useEffect } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { Badge } from '../../components/badge';
import { RunProgress } from './run-progress';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { formatCurrency, isoToDateKey } from '@/lib/format';
import { CollapsibleError } from './collapsible-error';
import { LogViewer } from './log-viewer';
import { BacktestTabs } from './backtest-tabs';
import { EquityCurveChart } from './equity-curve-chart';
import { DrawdownChart } from './drawdown-chart';
import { BreakdownCharts } from './breakdown-charts';
import { TradeScatter } from './trade-scatter';
import { RollingWinRate } from './rolling-win-rate';
import { ChatRoom } from '../../messages/chat-room';
import { ChatHydrator } from '../../messages/chat-hydrator';
import { TradeFilterProvider, TradeFilters } from '../../components/trade-filters';
import { FilteredTradesView } from '../../components/filtered-trades-view';
import { Square, Trash2, Copy, ArrowLeft, RotateCcw } from 'lucide-react';
import { PROFIT_FACTOR_INF, pctDisplay } from '@src/lib/numbers';
import { btChannel } from '@src/lib/channel';
import type { ChatHydration } from '../../messages/chat-hydrator';
import type { Message, Trade } from '@src/db/schema';
import type { MessageDecision, TradeOutcome } from '@src/lib/enriched-message';

const Spinner = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin h-6 w-6 border-2 border-muted-foreground/20 border-t-foreground rounded-full" />
  </div>
);

type BacktestDecisionRow = {
  message: Message;
  decision: {
    outcome: string | null;
    reasoning: string | null;
    pnl: string | null;
    phase: string | null;
    durationMs: number | null;
    taskId: string | null;
  };
  trade: { id: string | null } | null;
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
  decisions: BacktestDecisionRow[];
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

    enrichment[row.message.id] = { decision, trade };
  }

  const messages = [...latestMessageById.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    messages,
    labels: {},
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

export default function BacktestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Switch channel scope to this backtest on mount
  const expectedChannel = btChannel(id!);
  useEffect(() => {
    if (searchParams.get('channel') !== expectedChannel) {
      const params = new URLSearchParams(searchParams);
      params.set('channel', expectedChannel);
      navigate(`?${params.toString()}`, { replace: true });
    }
  }, [expectedChannel, searchParams, navigate]);

  const { data } = useQuery<any>({
    queryKey: ['backtest', id],
    queryFn: () => api(`/backtests/${id}`),
    refetchInterval: (query) => {
      const status = query.state.data?.run?.status;
      return (status === 'RUNNING' || status === 'PENDING') ? 3000 : false;
    },
  });

  const cancelMut = useApiMutation('POST', `/backtests/${id}/cancel`, {
    invalidate: [['backtest', id]],
  });

  const deleteMut = useApiMutation('DELETE', `/backtests/${id}`, {
    onSuccess: () => navigate('/backtests'),
  });

  const invalidateCacheMut = useApiMutation('POST', `/backtests/${id}/invalidate-intents`, {
    invalidate: [['backtest', id]],
  });

  if (!data) return <Spinner />;

  const {
    run, summary, byTrader, byStrategy,
    equityCurve, tradeScatter, rollingWinRate,
    decisions, allTrades, eventsByTradeId, flagsByTradeId,
    llmTokens, messagesEndDate,
  } = data;
  const config = run.config;

  const backtestRunId = id!;
  const channelId = btChannel(backtestRunId);
  const liveMetrics = run.liveMetrics ?? null;
  const chatData = buildBacktestChatData({
    decisions,
    allTrades,
    channelId,
    traders: config.traders,
    startDate: config.startDate,
    endDate: messagesEndDate ?? config.endDate,
    lastProcessedTs: run.liveMetrics?.lastProcessedMessageTs ?? null,
  });
  const isRunning = run.status === 'RUNNING' || run.status === 'PENDING';
  const hasDrawdown = (summary?.maxDrawdown ?? 0) > 0;

  const noData = (h = 200) => (
    <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height: h }}>
      No data yet
    </div>
  );

  // --- Performance Tab content ---
  const performanceContent = (
    <div className="space-y-4">
      {/* Row 1: Equity Curve + Drawdown */}
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

      {/* Row 2: Trade Scatter + Rolling Win Rate */}
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

      {/* Row 3: Breakdown Charts */}
      <BreakdownCharts byTrader={byTrader} byStrategy={byStrategy} channelId={channelId} />
    </div>
  );

  // --- Messages Tab content ---
  const messagesContent = (
    <div className="space-y-3 flex flex-col flex-1 min-h-0">
      <div className="rounded-lg border bg-card overflow-hidden flex flex-col flex-1 min-h-0">
        <ChatHydrator data={chatData} />
        <ChatRoom />
      </div>
    </div>
  );

  // --- Trades Tab content ---
  const tradesContent = (
    <FilteredTradesView
      eventsByTradeId={eventsByTradeId}
      flagsByTradeId={flagsByTradeId}
      channelId={channelId}
      commissionSchedule={config.commissionSchedule}
      startingEquity={config.startingEquity}
    />
  );

  return (
    <div className="flex flex-col h-full">
      <div className="space-y-4 animate-in-up pb-6 flex-1 flex flex-col min-h-0">
        {/* Header with action toolbar */}
        <div className="flex items-center gap-3">
          <Link to="/backtests" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h2 className="text-lg font-bold text-foreground tracking-tight">Backtest Run</h2>
          <Badge label={run.status} />
          {run.name && <span className="text-sm text-muted-foreground">{run.name}</span>}

          <div className="flex items-center gap-1.5 ml-auto">
            <Button variant="ghost" size="xs" asChild>
              <Link to={`/backtests/new?clone=${backtestRunId}`}>
                <Copy className="size-3" /> Clone &amp; Edit
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => invalidateCacheMut.mutate()}
              disabled={invalidateCacheMut.isPending}
            >
              <RotateCcw className="size-3" /> Clear Intent Cache
            </Button>
            {isRunning && (
              <>
                <Separator orientation="vertical" className="!h-4 mx-1" />
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => cancelMut.mutate()}
                  disabled={cancelMut.isPending}
                >
                  <Square className="size-3" /> Cancel
                </Button>
              </>
            )}
            <Separator orientation="vertical" className="!h-4 mx-1" />
            <Button
              variant="ghost"
              size="xs"
              className="text-loss hover:text-loss/80 hover:bg-loss/5"
              onClick={() => {
                if (confirm('Delete this backtest run? This cannot be undone.')) {
                  deleteMut.mutate();
                }
              }}
              disabled={deleteMut.isPending}
            >
              <Trash2 className="size-3" /> Delete
            </Button>
          </div>
        </div>

        {/* Unified info bar: config + metrics + progress */}
        <div className="rounded-lg border bg-card text-sm overflow-hidden">
          <div className="flex items-center gap-4 px-4 py-2.5 flex-wrap">
            {/* Config */}
            <span className="text-foreground font-medium">{config.traders.join(', ')}</span>
            <Separator orientation="vertical" className="!h-4" />
            <span className="text-muted-foreground tabular-nums">{isoToDateKey(config.startDate)} &ndash; {isoToDateKey(config.endDate)}</span>
            <Separator orientation="vertical" className="!h-4" />
            <span className="text-muted-foreground">{config.agentProvider ?? 'anthropic'}/{config.agentModel ?? 'default'}</span>
            <Separator orientation="vertical" className="!h-4" />
            <span className="text-muted-foreground">{config.fillModel ?? 'orats'}</span>
            <span className="text-muted-foreground tabular-nums">${(config.startingEquity / 1000).toFixed(0)}k</span>
            {config.commissionSchedule.option?.perContract != null && (
              <span className="text-muted-foreground text-xs">comm ${config.commissionSchedule.option.perContract}/ct</span>
            )}
            {config.disableRiskLimits && <span className="text-amber-500 text-xs font-medium">risk off</span>}
            {summary && (
              <>
                <Separator orientation="vertical" className="!h-4" />
                <div className="flex items-center gap-3 ml-auto tabular-nums">
                  <span className="text-muted-foreground"><span className="text-foreground font-semibold">{summary.totalTrades}</span> trades{summary.openAtEnd > 0 && <span className="text-muted-foreground/60"> + {summary.openAtEnd} open</span>}</span>
                  <span className="text-muted-foreground"><span className="text-foreground font-semibold">{pctDisplay(summary.winRate)}</span> win</span>
                  {(() => {
                    const unrealized = liveMetrics?.unrealizedPnl ?? 0;
                    const hasOpen = summary.openAtEnd > 0 && unrealized !== 0;
                    const hasComm = (summary.totalCommissions ?? 0) > 0;
                    const displayPnl = hasComm ? (summary.netPnl ?? summary.totalPnl) : summary.totalPnl;
                    const totalPnl = hasOpen ? displayPnl + unrealized : displayPnl;
                    return (
                      <span className={totalPnl >= 0 ? 'text-profit font-semibold' : 'text-loss font-semibold'}>
                        {formatCurrency(totalPnl)}
                        {hasComm && <span className="text-muted-foreground font-normal text-xs ml-1">(gross {formatCurrency(summary.totalPnl)} &minus; {formatCurrency(summary.totalCommissions!)} comm)</span>}
                        {!hasComm && hasOpen && <span className="text-muted-foreground font-normal text-xs ml-1">({formatCurrency(summary.totalPnl)} realized)</span>}
                      </span>
                    );
                  })()}
                  <span className="text-muted-foreground">DD <span className="text-foreground font-semibold">{formatCurrency(summary.maxDrawdown)}</span></span>
                  <span className="text-muted-foreground">PF <span className="text-foreground font-semibold">{(summary.profitFactor >= PROFIT_FACTOR_INF ? 99.99 : (summary.profitFactor ?? 0)).toFixed(2)}</span></span>
                </div>
              </>
            )}
          </div>
          {/* Progress chips + bar embedded in the same card */}
          <RunProgress
            processedMessages={new Set(decisions.map((d: BacktestDecisionRow) => d.message.id)).size}
            totalMessages={run.summary?.tradedMessages ?? 0}
            agentModel={config.agentModel ?? 'default'}
            llmTokens={llmTokens}
            liveMetrics={liveMetrics}
            status={run.status}
            startedAt={run.startedAt}
            completedAt={run.completedAt}
            lastMessageDate={
              liveMetrics?.lastProcessedMessageTs
              ?? (decisions.length > 0 ? decisions[0].message.timestamp : null)
            }
            rangeStart={config.startDate}
            rangeEnd={config.endDate}
          />
        </div>

        {/* Error -- only when there is one (hide for cancelled runs) */}
        {run.error && run.status !== 'CANCELLED' && (
          <CollapsibleError error={run.error} />
        )}

        {/* Tabs -- always in this slot when data exists */}
        <TradeFilterProvider trades={allTrades} flagsByTradeId={flagsByTradeId}>
          <BacktestTabs
            performance={performanceContent}
            messages={messagesContent}
            trades={tradesContent}
            tabBarTrailing={<TradeFilters />}
            hasMessages={chatData.messages.length > 0}
          />
        </TradeFilterProvider>
      </div>

      {/* Anchored log panel -- outside content wrapper so sticky sits flush */}
      <LogViewer
        backtestRunId={backtestRunId}
        isRunning={isRunning}
        defaultCollapsed
      />
    </div>
  );
}
