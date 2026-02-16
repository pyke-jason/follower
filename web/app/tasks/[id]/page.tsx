import { notFound } from 'next/navigation';
import {
  getTaskById, getTradeSteps, getMessageById,
  getTradeByTaskId, getRunDecisionForTask, getNearbyMessages,
} from '@/lib/queries';
import { Badge } from '../../components/badge';
import { InfoChip } from '../../components/info-chip';
import { StatItem } from '../../components/stat-item';
import { LegsTable } from '../../components/legs-table';
import { StepViewer } from '../../components/step-viewer';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatDate, formatTime, formatCurrency, pnlColor, formatDuration } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import { skipTask } from '../actions';
import Link from 'next/link';
import { AutoRefresh } from '../../components/auto-refresh';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChatPreview } from '../../messages/chat-preview';
import type { TaskContext, TaskResult, DetectedStrategy, TradeLeg } from '../../../../src/db/schema';

export const dynamic = 'force-dynamic';

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { id } = await params;
  const { run: runId } = await searchParams;
  const task = await getTaskById(id);
  if (!task) notFound();

  const context = (task.context as TaskContext) || {};
  const result = (task.result as TaskResult | null) || null;

  // Round 1: parallel queries
  const [steps, sourceMessage, trade, runDecision] = await Promise.all([
    getTradeSteps(task.id),
    task.messageId ? getMessageById(task.messageId) : Promise.resolve(null),
    getTradeByTaskId(task.id),
    task.messageId && task.backtestRunId
      ? getRunDecisionForTask(task.messageId, task.backtestRunId)
      : Promise.resolve(null),
  ]);

  // Round 2: depends on sourceMessage
  const nearbyMessages = sourceMessage
    ? await getNearbyMessages(sourceMessage.author, sourceMessage.timestamp, 60)
    : [];

  const legs = (trade?.legs as TradeLeg[]) || [];
  const hasAgentSteps = steps.length > 0;

  return (
    <div className="space-y-6 animate-in-up">
      {(task.status === 'PENDING' || task.status === 'IN_PROGRESS') && <AutoRefresh />}

      {/* ── Rich Header ──────────────────────────────── */}
      <div className="flex items-center gap-3">
        <Link href={buildHref('/tasks', runId)} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h2 className="text-lg font-bold text-foreground tracking-tight">
          {context.symbols?.[0] ?? task.taskType}
        </h2>
        <Badge label={task.status} />
        {context.directionHint && <Badge label={context.directionHint} />}
        {context.detectedStrategies?.[0]?.strategy && (
          <Badge label={context.detectedStrategies[0].strategy} />
        )}
        {context.author && (
          <Link
            href={`/traders/${encodeURIComponent(context.author)}`}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {context.author}
          </Link>
        )}
        <span className="text-xs text-muted-foreground ml-auto">{task.taskType}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6">
        {/* ── Left Column ──────────────────────────────── */}
        <div className="space-y-6 min-w-0">
          {/* ── Task Info Grid ────────────────────────────── */}
          <Card className="py-4 gap-0">
            <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <StatItem label="Assignee">
                <p className="text-foreground font-medium">{task.assignee}</p>
              </StatItem>
              <StatItem label="Priority">
                <p className="text-foreground font-medium">{task.priority}</p>
              </StatItem>
              <StatItem label="Created">
                <p className="text-foreground">{formatDate(task.createdAt)}</p>
              </StatItem>
              <StatItem label="Completed">
                <p className="text-foreground">{formatDate(task.completedAt)}</p>
              </StatItem>
            </CardContent>
            {(task.modelProvider || task.modelName) && (
              <CardContent className="pt-0 flex items-center gap-2 flex-wrap">
                {task.modelName && <InfoChip label={task.modelName} />}
                {task.modelProvider && <InfoChip label={task.modelProvider} />}
              </CardContent>
            )}
          </Card>

          {/* ── Decision Card (merged with runDecision) ───── */}
          {(result || runDecision) && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardHeader className="border-b py-3 px-4">
                <CardTitle className="text-sm font-medium">Decision</CardTitle>
              </CardHeader>
              <CardContent className="py-4">
                <div className="flex items-center gap-3 mb-3">
                  <Badge label={result?.decision ?? runDecision?.decision ?? ''} />
                  {runDecision?.path && <InfoChip label={runDecision.path} />}
                  {!runDecision?.path && <InfoChip label="agent" />}
                  {runDecision?.pnl != null && (
                    <span className={cn('font-medium tabular-nums', pnlColor(runDecision.pnl))}>
                      {formatCurrency(runDecision.pnl)}
                    </span>
                  )}
                  {runDecision?.durationMs != null ? (
                    <span className="text-xs text-muted-foreground tabular-nums ml-auto">
                      {runDecision.durationMs < 1000
                        ? `${runDecision.durationMs}ms`
                        : `${(runDecision.durationMs / 1000).toFixed(1)}s`}
                    </span>
                  ) : task.startedAt && task.completedAt ? (
                    <span className="text-xs text-muted-foreground tabular-nums ml-auto">
                      {formatDuration(task.startedAt, task.completedAt)}
                    </span>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {result?.reasoning ?? runDecision?.reasoning}
                </p>
              </CardContent>
            </Card>
          )}

          {/* ── Trade Outcome ─────────────────────────────── */}
          {trade && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardHeader className="border-b py-3 px-4">
                <CardTitle className="text-sm font-medium flex items-center justify-between">
                  <span>Trade Outcome</span>
                  <Link
                    href={buildHref(`/trades/${trade.id}`, runId)}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                  >
                    View Trade <ArrowRight className="h-3 w-3" />
                  </Link>
                </CardTitle>
              </CardHeader>
              <CardContent className="py-4">
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-foreground font-bold">{trade.symbol}</span>
                  <Badge label={trade.direction} />
                  <Badge label={trade.strategy} />
                  <Badge label={trade.status} />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <StatItem label="Entry">
                    <p className="text-foreground font-medium tabular-nums">{formatCurrency(trade.entryPrice)}</p>
                  </StatItem>
                  <StatItem label="Exit">
                    <p className="text-foreground font-medium tabular-nums">{formatCurrency(trade.exitPrice)}</p>
                  </StatItem>
                  <StatItem label="Quantity">
                    <p className="text-foreground font-medium tabular-nums">{trade.quantity}</p>
                  </StatItem>
                  <StatItem label="P&L">
                    <p className={cn('text-lg font-bold tabular-nums', pnlColor(trade.pnl))}>
                      {formatCurrency(trade.pnl)}
                    </p>
                  </StatItem>
                </div>
                {legs.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-border/50">
                    <LegsTable legs={legs} />
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Error ─────────────────────────────────────── */}
          {task.error && (
            <Card className="py-4 gap-2 border-loss/30 bg-loss/5">
              <CardHeader className="py-0">
                <CardTitle className="text-sm text-loss">Error</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-xs text-loss/80 whitespace-pre-wrap font-mono">
                  {task.error}
                </pre>
              </CardContent>
            </Card>
          )}

          {/* ── Skip Action ───────────────────────────────── */}
          {task.status === 'PENDING' && (
            <form action={skipTask}>
              <input type="hidden" name="taskId" value={task.id} />
              <Button type="submit" variant="secondary">
                Skip Task
              </Button>
            </form>
          )}

          {/* ── Audit Trail ───────────────────────────────── */}
          <div>
            <h3 className="text-sm font-medium text-foreground mb-3">
              Audit Trail {steps.length > 0 && `(${steps.length} steps)`}
            </h3>
            {steps.length > 0 ? (
              <StepViewer steps={steps} />
            ) : (
              <Card className="py-4 gap-0">
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    {result?.decision === 'SKIP'
                      ? 'This task was skipped. No processing steps were recorded.'
                      : 'No audit trail steps recorded for this task.'}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* ── Right Column (sticky) ────────────────────── */}
        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          {/* ── Chat Context ─────────────────────────────── */}
          <ChatPreview
            messages={nearbyMessages.length > 0 ? nearbyMessages : sourceMessage ? [sourceMessage] : []}
            focusMessageId={task.messageId ?? undefined}
            author={sourceMessage?.author ?? context.author ?? undefined}
            viewAllHref={
              context.author
                ? `/messages?authors=${encodeURIComponent(context.author)}`
                : '/messages'
            }
          />

          {/* ── Parsed Context ────────────────────────────── */}
          {(context.confidence != null || context.actionHint || context.directionHint || (context.detectedStrategies?.length ?? 0) > 0 || (context.badges?.length ?? 0) > 0) && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardHeader className="border-b py-3 px-4">
                <CardTitle className="text-sm font-medium">Parsed Context</CardTitle>
              </CardHeader>
              <CardContent className="py-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  {context.confidence != null && (
                    <StatItem label="Confidence">
                      <p className={cn(
                        'font-medium tabular-nums',
                        (context.confidence as number) >= 0.8
                          ? 'text-profit'
                          : (context.confidence as number) >= 0.5
                            ? 'text-warning'
                            : 'text-loss'
                      )}>
                        {((context.confidence as number) * 100).toFixed(0)}%
                      </p>
                    </StatItem>
                  )}
                  {context.actionHint && (
                    <StatItem label="Action">
                      <Badge label={context.actionHint} />
                    </StatItem>
                  )}
                  {context.directionHint && (
                    <StatItem label="Direction">
                      <Badge label={context.directionHint} />
                    </StatItem>
                  )}
                  {context.symbols && context.symbols.length > 0 && (
                    <StatItem label="Symbols">
                      <div className="flex gap-1 flex-wrap">
                        {context.symbols.map((s, i) => (
                          <InfoChip key={i} label={s} />
                        ))}
                      </div>
                    </StatItem>
                  )}
                </div>
                {context.detectedStrategies && context.detectedStrategies.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border/50">
                    <StatItem label="Strategies">
                      <div className="flex items-center gap-2 flex-wrap">
                        {context.detectedStrategies.map((ds, i) => (
                          <div key={i} className="flex items-center gap-1">
                            <Badge label={ds.strategy} />
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {(ds.confidence * 100).toFixed(0)}%
                            </span>
                          </div>
                        ))}
                      </div>
                    </StatItem>
                  </div>
                )}
                {context.badges && context.badges.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border/50">
                    <StatItem label="Badges">
                      <div className="flex gap-1 flex-wrap">
                        {context.badges.map((b, i) => <Badge key={i} label={b} />)}
                      </div>
                    </StatItem>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
