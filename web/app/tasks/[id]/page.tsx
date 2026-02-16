import { notFound } from 'next/navigation';
import {
  getTaskById, getTradeSteps, getMessageById,
  getTradeByTaskId, getRunDecisionForTask, getNearbyMessages,
} from '@/lib/queries';
import { Badge } from '../../components/badge';
import { InfoChip } from '../../components/info-chip';
import { StepViewer } from '../../components/step-viewer';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { formatDate, formatTime, formatCurrency, pnlColor, formatDuration } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import { skipTask } from '../actions';
import Link from 'next/link';
import { AutoRefresh } from '../../components/auto-refresh';
import { ArrowLeft, ArrowRight, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
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
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Assignee</p>
                <p className="text-foreground font-medium">{task.assignee}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Priority</p>
                <p className="text-foreground font-medium">{task.priority}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Created</p>
                <p className="text-foreground">{formatDate(task.createdAt)}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Completed</p>
                <p className="text-foreground">{formatDate(task.completedAt)}</p>
              </div>
            </CardContent>
            {(task.modelProvider || task.modelName) && (
              <CardContent className="pt-0 flex items-center gap-2 flex-wrap">
                {task.modelName && <InfoChip label={task.modelName} />}
                {task.modelProvider && <InfoChip label={task.modelProvider} />}
              </CardContent>
            )}
          </Card>

          {/* ── Decision Card ─────────────────────────────── */}
          {result && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardHeader className="border-b py-3 px-4">
                <CardTitle className="text-sm font-medium">Decision</CardTitle>
              </CardHeader>
              <CardContent className="py-4">
                <div className="flex items-center gap-3 mb-3">
                  <Badge label={result.decision} />
                  <InfoChip label="agent" />
                  {task.startedAt && task.completedAt && (
                    <span className="text-xs text-muted-foreground tabular-nums ml-auto">
                      {formatDuration(task.startedAt, task.completedAt)}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {result.reasoning}
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
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Entry</p>
                    <p className="text-foreground font-medium tabular-nums">{formatCurrency(trade.entryPrice)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Exit</p>
                    <p className="text-foreground font-medium tabular-nums">{formatCurrency(trade.exitPrice)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Quantity</p>
                    <p className="text-foreground font-medium tabular-nums">{trade.quantity}</p>
                  </div>
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">P&L</p>
                    <p className={cn('text-lg font-bold tabular-nums', pnlColor(trade.pnl))}>
                      {formatCurrency(trade.pnl)}
                    </p>
                  </div>
                </div>
                {legs.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-border/50">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Symbol</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead className="text-right">Strike</TableHead>
                          <TableHead>Expiry</TableHead>
                          <TableHead>Action</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {legs.map((leg, i) => (
                          <TableRow key={i}>
                            <TableCell className="font-medium">{leg.symbol}</TableCell>
                            <TableCell><Badge label={leg.type} /></TableCell>
                            <TableCell className="text-right tabular-nums">{leg.strike}</TableCell>
                            <TableCell className="text-muted-foreground text-xs">{leg.expiry}</TableCell>
                            <TableCell>{leg.action}</TableCell>
                            <TableCell className="text-right tabular-nums">{leg.quantity}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Run Decision (backtest only) ──────────────── */}
          {runDecision && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardHeader className="border-b py-3 px-4">
                <CardTitle className="text-sm font-medium">Run Decision</CardTitle>
              </CardHeader>
              <CardContent className="py-4">
                <div className="flex items-center gap-3">
                  <Badge label={runDecision.decision} />
                  <InfoChip label={runDecision.path} />
                  {runDecision.pnl != null && (
                    <span className={cn('font-medium tabular-nums', pnlColor(runDecision.pnl))}>
                      {formatCurrency(runDecision.pnl)}
                    </span>
                  )}
                  {runDecision.durationMs != null && (
                    <span className="text-xs text-muted-foreground tabular-nums ml-auto">
                      {runDecision.durationMs < 1000
                        ? `${runDecision.durationMs}ms`
                        : `${(runDecision.durationMs / 1000).toFixed(1)}s`}
                    </span>
                  )}
                </div>
                {runDecision.reasoning && (
                  <p className="text-sm text-muted-foreground leading-relaxed mt-3">
                    {runDecision.reasoning}
                  </p>
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
          {/* ── Source Message ─────────────────────────────── */}
          {sourceMessage && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardHeader className="border-b py-3 px-4">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                  Source Message
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Link
                    href={`/traders/${encodeURIComponent(sourceMessage.author)}`}
                    className="text-xs font-semibold text-foreground hover:underline"
                  >
                    {sourceMessage.author}
                  </Link>
                  <span className="text-[10px] text-muted-foreground/60">{formatDate(sourceMessage.timestamp)}</span>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{sourceMessage.cleanText}</p>
                {((sourceMessage.badges as string[]) || []).length > 0 && (
                  <div className="flex gap-1 mt-3 flex-wrap">
                    {((sourceMessage.badges as string[]) || []).map((b, i) => (
                      <Badge key={i} label={b} />
                    ))}
                  </div>
                )}
                {(sourceMessage.actionHint || sourceMessage.directionHint) && (
                  <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/50">
                    {sourceMessage.actionHint && <Badge label={sourceMessage.actionHint} />}
                    {sourceMessage.directionHint && <Badge label={sourceMessage.directionHint} />}
                  </div>
                )}
                {((sourceMessage.detectedStrategies as DetectedStrategy[]) || []).length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border/50">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Detected Strategies</p>
                    <div className="space-y-1">
                      {((sourceMessage.detectedStrategies as DetectedStrategy[]) || []).map((ds, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <Badge label={ds.strategy} />
                          <span className="text-muted-foreground tabular-nums">{(ds.confidence * 100).toFixed(0)}%</span>
                          {ds.strikes?.length ? (
                            <span className="text-muted-foreground">strikes: {ds.strikes.join('/')}</span>
                          ) : null}
                          {ds.expiry && <span className="text-muted-foreground">{ds.expiry}</span>}
                          {ds.price != null && <span className="text-muted-foreground tabular-nums">${ds.price}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Nearby Messages Timeline ──────────────────── */}
          {nearbyMessages.length > 1 && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardHeader className="border-b py-3 px-4">
                <CardTitle className="text-sm font-medium">
                  Nearby Messages ({nearbyMessages.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/50">
                  {nearbyMessages.map((msg) => {
                    const isSource = msg.id === task.messageId;
                    return (
                      <div
                        key={msg.id}
                        className={cn(
                          'px-4 py-2.5 text-sm',
                          isSource
                            ? 'bg-info/10 border-l-2 border-l-info'
                            : 'hover:bg-accent/30',
                        )}
                      >
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                            {formatTime(msg.timestamp)}
                          </span>
                          {isSource && (
                            <span className="text-[10px] font-medium text-info">SOURCE</span>
                          )}
                          {msg.actionHint && <Badge label={msg.actionHint} />}
                          {msg.directionHint && <Badge label={msg.directionHint} />}
                        </div>
                        <p className={cn(
                          'text-xs leading-relaxed',
                          isSource ? 'text-foreground' : 'text-muted-foreground',
                        )}>
                          {msg.cleanText}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── Parsed Context ────────────────────────────── */}
          {(context.confidence != null || context.actionHint || context.directionHint || (context.detectedStrategies?.length ?? 0) > 0 || (context.badges?.length ?? 0) > 0) && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardHeader className="border-b py-3 px-4">
                <CardTitle className="text-sm font-medium">Parsed Context</CardTitle>
              </CardHeader>
              <CardContent className="py-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  {context.confidence != null && (
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Confidence</p>
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
                    </div>
                  )}
                  {context.actionHint && (
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Action</p>
                      <Badge label={context.actionHint} />
                    </div>
                  )}
                  {context.directionHint && (
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Direction</p>
                      <Badge label={context.directionHint} />
                    </div>
                  )}
                  {context.symbols && context.symbols.length > 0 && (
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-0.5">Symbols</p>
                      <div className="flex gap-1 flex-wrap">
                        {context.symbols.map((s, i) => (
                          <InfoChip key={i} label={s} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {context.detectedStrategies && context.detectedStrategies.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border/50">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Strategies</p>
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
                  </div>
                )}
                {context.badges && context.badges.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border/50">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Badges</p>
                    <div className="flex gap-1 flex-wrap">
                      {context.badges.map((b, i) => <Badge key={i} label={b} />)}
                    </div>
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
