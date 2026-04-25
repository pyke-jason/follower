import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queries } from '@/lib/queries';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { Badge } from '@/components/badge';
import { RunProgress } from './run-progress';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { formatCurrency, isoToDateKey } from '@/lib/format';
import { CollapsibleError } from './collapsible-error';
import { LogViewer } from './log-viewer';
import { BacktestStaticTabs } from './backtest-static-tabs';
import { bucketTrades } from './diagnosis-panel';
import { useBacktestDetailLiveQuery } from './use-backtest-detail-live-query';
import { Square, Trash2, Copy, ArrowLeft, RotateCcw, Pause, Play } from 'lucide-react';
import { PROFIT_FACTOR_INF, pctDisplay } from '@src/lib/numbers';
import { btChannel } from '@src/lib/channel';
import { QueryBoundary, MetricStripSkeleton } from '@/components/query-boundary';
import type { BacktestDetailResponse } from '@src/local-api/http-schemas';

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

  const query = useQuery(queries.backtests.detail(id!));

  return (
    <QueryBoundary query={query} skeleton={<MetricStripSkeleton count={4} />}>
      {(data) => <BacktestDetailContent data={data} id={id!} />}
    </QueryBoundary>
  );
}

function BacktestDetailContent({ data, id }: {
  data: BacktestDetailResponse;
  id: string;
}) {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const patchTradeLabel = useBacktestDetailLiveQuery(id, data);

  const cancelMut = useApiMutation('POST', `/backtests/${id}/cancel`, {
    invalidate: [['backtest', id]],
    onSuccess: () => toast.success('Backtest cancelled'),
  });

  const pauseMut = useApiMutation('POST', `/backtests/${id}/pause`, {
    invalidate: [['backtest', id], ['backtests']],
    onSuccess: () => toast.success('Backtest paused'),
  });

  const resumeMut = useApiMutation('POST', `/backtests/${id}/resume`, {
    invalidate: [['backtest', id], ['backtests']],
    onSuccess: () => toast.success('Backtest resumed'),
  });

  const deleteMut = useApiMutation('DELETE', `/backtests/${id}`, {
    onSuccess: () => {
      toast.success('Backtest deleted');
      navigate('/backtests');
    },
  });

  const invalidateCacheMut = useApiMutation('POST', `/backtests/${id}/invalidate-intents`, {
    invalidate: [['backtest', id]],
    onSuccess: () => toast.success('Intent cache cleared'),
  });

  const {
    run,
    summary,
    decisions,
    llmCost,
    liveRuntime,
    allTrades,
    messagesEndDate,
  } = data;
  const config = run.config;
  const pastPlanCount = bucketTrades(allTrades, messagesEndDate ?? config.endDate)
    .buckets.find((b) => b.id === 'past-plan')?.count ?? 0;

  const backtestRunId = id;
  const liveMetrics = run.liveMetrics ?? null;
  const liveStatus = run.status;
  const isRunning = liveStatus === 'RUNNING' || liveStatus === 'PENDING';
  const isPaused = liveStatus === 'PAUSED';
  const isLive = isRunning || isPaused;
  const liveError = run.error;
  const processedMessages = liveRuntime.processedMessages;
  const totalMessages = summary?.tradedMessages ?? run.summary?.tradedMessages ?? 0;
  const lastProgressMessage = findProgressMessage(decisions, liveMetrics?.lastProcessedMessageTs);

  return (
    <div className="flex flex-col h-full">
      <div className="space-y-4 animate-in-up pb-6 flex-1 flex flex-col min-h-0">
        {/* Header with action toolbar */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex min-w-0 items-center gap-2">
            <Link to="/backtests" className="shrink-0 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h2 className="min-w-0 truncate text-lg font-bold text-foreground tracking-tight">Backtest Run</h2>
            <Badge label={liveStatus} />
            {run.name && <span className="min-w-0 truncate text-sm text-muted-foreground">{run.name}</span>}
          </div>

          <div className="flex w-full flex-wrap items-center gap-1.5 sm:ml-auto sm:w-auto sm:justify-end">
            <Button variant="ghost" size="xs" asChild>
              <Link to={`/backtests/new?clone=${backtestRunId}`} title="Clone & Edit" aria-label="Clone and edit backtest">
                <Copy className="size-3" /> <span className="max-[420px]:sr-only">Clone &amp; Edit</span>
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="xs"
              title="Clear intent cache"
              aria-label="Clear intent cache"
              onClick={() => invalidateCacheMut.mutate()}
              disabled={invalidateCacheMut.isPending}
            >
              <RotateCcw className="size-3" /> <span className="max-[520px]:sr-only">Clear Intent Cache</span>
            </Button>
            {isRunning && (
              <>
                <Separator orientation="vertical" className="!h-4 mx-1 hidden min-[520px]:block" />
                <Button
                  variant="secondary"
                  size="xs"
                  title="Pause backtest"
                  aria-label="Pause backtest"
                  onClick={() => pauseMut.mutate()}
                  disabled={pauseMut.isPending}
                >
                  <Pause className="size-3" /> <span className="max-[420px]:sr-only">Pause</span>
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  title="Cancel backtest"
                  aria-label="Cancel backtest"
                  onClick={() => cancelMut.mutate()}
                  disabled={cancelMut.isPending}
                >
                  <Square className="size-3" /> <span className="max-[420px]:sr-only">Cancel</span>
                </Button>
              </>
            )}
            {isPaused && (
              <>
                <Separator orientation="vertical" className="!h-4 mx-1 hidden min-[520px]:block" />
                <Button
                  variant="secondary"
                  size="xs"
                  title="Resume backtest"
                  aria-label="Resume backtest"
                  onClick={() => resumeMut.mutate()}
                  disabled={resumeMut.isPending}
                >
                  <Play className="size-3" /> <span className="max-[420px]:sr-only">Resume</span>
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  title="Cancel backtest"
                  aria-label="Cancel backtest"
                  onClick={() => cancelMut.mutate()}
                  disabled={cancelMut.isPending}
                >
                  <Square className="size-3" /> <span className="max-[420px]:sr-only">Cancel</span>
                </Button>
              </>
            )}
            <Separator orientation="vertical" className="!h-4 mx-1 hidden min-[520px]:block" />
            <Button
              variant="ghost"
              size="xs"
              className="text-loss hover:text-loss/80 hover:bg-loss/5"
              title="Delete backtest"
              aria-label="Delete backtest"
              onClick={() => setConfirmDelete(true)}
              disabled={deleteMut.isPending}
            >
              <Trash2 className="size-3" /> <span className="max-[420px]:sr-only">Delete</span>
            </Button>
          </div>
        </div>

        {/* Info bar: config → results → progress */}
        <div className="rounded-lg border bg-card text-sm overflow-hidden">
          {/* Config row — compact description */}
          <div className="flex items-center gap-3 px-4 py-2 border-b border-border/40 text-xs text-muted-foreground flex-wrap">
            <TradersList traders={config.traders} />
            <Separator orientation="vertical" className="!h-3.5" />
            <span className="font-mono tabular-nums">{isoToDateKey(config.startDate)} &ndash; {isoToDateKey(config.endDate)}</span>
            <Separator orientation="vertical" className="!h-3.5" />
            <span>{config.agentProvider ?? 'anthropic'}/{config.agentModel ?? 'default'}</span>
            <span className="font-mono">{config.fillModel ?? 'orats'}</span>
            <span className="font-mono">${(config.startingEquity / 1000).toFixed(0)}k</span>
            {config.commissionSchedule.option?.perContract != null && (
              <span>comm ${config.commissionSchedule.option.perContract}/ct</span>
            )}
            {config.disableRiskLimits && <span className="text-warning font-medium">risk off</span>}
          </div>

          {/* Results row — key metrics as labeled values */}
          {summary && (() => {
            const unrealized = liveMetrics?.unrealizedPnl ?? 0;
            const hasOpen = summary.openAtEnd > 0;
            const hasComm = (summary.totalCommissions ?? 0) > 0;
            const realizedPnl = hasComm ? (summary.netPnl ?? summary.totalPnl) : summary.totalPnl;
            const profitFactor = summary.profitFactor >= PROFIT_FACTOR_INF
              ? 99.99
              : (summary.profitFactor ?? 0);
            return (
              <div className="flex items-end gap-6 px-4 py-3 flex-wrap">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground mb-0.5">Trades</div>
                  <div className="text-sm font-mono font-semibold tabular-nums">{summary.totalTrades}{summary.openAtEnd > 0 && <span className="text-muted-foreground/50 font-normal text-xs ml-1">+{summary.openAtEnd} open</span>}</div>
                  {pastPlanCount > 0 && (
                    <div className="text-[10px] font-mono tabular-nums text-warning mt-0.5">+{pastPlanCount} past plan</div>
                  )}
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground mb-0.5">Win Rate</div>
                  <div className="text-sm font-mono font-semibold tabular-nums">{pctDisplay(summary.winRate)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground mb-0.5">Realized P&amp;L</div>
                  <div className={`text-sm font-mono font-semibold tabular-nums ${realizedPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                    {formatCurrency(realizedPnl)}
                    {hasComm && <span className="text-muted-foreground font-normal text-[10px] ml-1">(gross {formatCurrency(summary.totalPnl)} &minus; {formatCurrency(summary.totalCommissions!)} comm)</span>}
                  </div>
                </div>
                {hasOpen && (
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground mb-0.5">Unrealized</div>
                    <div className={`text-sm font-mono font-semibold tabular-nums ${unrealized >= 0 ? 'text-profit' : 'text-loss'}`}>
                      {formatCurrency(unrealized)}
                      <span className="text-muted-foreground font-normal text-[10px] ml-1">{summary.openAtEnd} floating</span>
                    </div>
                  </div>
                )}
                <div>
                  <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground mb-0.5">Max DD</div>
                  <div className="text-sm font-mono font-semibold tabular-nums text-loss">{formatCurrency(summary.maxDrawdown)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground mb-0.5">Profit Factor</div>
                  <div className="text-sm font-mono font-semibold tabular-nums">{profitFactor.toFixed(2)}</div>
                </div>
              </div>
            );
          })()}

          {/* Progress chips + bar */}
          <RunProgress
            processedMessages={processedMessages}
            totalMessages={totalMessages}
            llmCost={llmCost}
            liveMetrics={liveMetrics}
            status={liveStatus}
            startedAt={run.startedAt}
            completedAt={run.completedAt}
            lastMessageDate={
              liveMetrics?.lastProcessedMessageTs
                ?? lastProgressMessage?.timestamp
                ?? null
            }
            currentMessageText={lastProgressMessage?.cleanText ?? null}
            rangeStart={config.startDate}
            rangeEnd={config.endDate}
          />
        </div>

        {/* Error -- only when there is one (hide for cancelled runs) */}
        {liveStatus === 'PAUSED' && liveError && (
          <PausedNotice reason={liveError} />
        )}
        {liveError && liveStatus !== 'CANCELLED' && liveStatus !== 'PAUSED' && (
          <CollapsibleError error={liveError} />
        )}

        <BacktestStaticTabs id={id} data={data} onLabelPatch={patchTradeLabel} />
      </div>

      {/* Anchored log panel -- outside content wrapper so sticky sits flush */}
      <LogViewer
        backtestRunId={backtestRunId}
        isRunning={isLive}
        defaultCollapsed
      />

      {/* Delete confirmation */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this backtest run?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes all trades, decisions, events, tasks, and logs for this run. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleteMut.mutate()}>
              Delete Run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PausedNotice({ reason }: { reason: string }) {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-2.5 text-xs font-mono text-warning/80">
      {reason}
    </div>
  );
}

type BacktestProgressMessage = BacktestDetailResponse['decisions'][number]['message'];

function findProgressMessage(
  decisions: BacktestDetailResponse['decisions'],
  lastProcessedTs: string | null | undefined,
): BacktestProgressMessage | null {
  if (decisions.length === 0) return null;
  if (!lastProcessedTs) return decisions[0].message;

  const exact = decisions.find((row) => row.message.timestamp === lastProcessedTs);
  if (exact) return exact.message;

  const targetMs = new Date(lastProcessedTs).getTime();
  if (!Number.isFinite(targetMs)) return decisions[0].message;

  let best: BacktestProgressMessage | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const row of decisions) {
    const messageMs = new Date(row.message.timestamp).getTime();
    if (Number.isFinite(messageMs) && messageMs <= targetMs && messageMs > bestMs) {
      best = row.message;
      bestMs = messageMs;
    }
  }
  return best ?? decisions[0].message;
}

/* ── Traders list with collapsible overflow ── */

const TRADER_PREVIEW_COUNT = 8;

function TradersList({ traders }: { traders: string[] }) {
  const [open, setOpen] = useState(false);

  if (traders.length <= TRADER_PREVIEW_COUNT) {
    return <span className="text-foreground font-medium text-sm">{traders.join(', ')}</span>;
  }

  const preview = traders.slice(0, TRADER_PREVIEW_COUNT);
  const remaining = traders.length - TRADER_PREVIEW_COUNT;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <span className="text-foreground font-medium text-sm">
        {open ? traders.join(', ') : `${preview.join(', ')} `}
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground h-auto px-1 py-0 text-xs">
            {open ? 'show less' : `+${remaining} more`}
          </Button>
        </CollapsibleTrigger>
      </span>
    </Collapsible>
  );
}
