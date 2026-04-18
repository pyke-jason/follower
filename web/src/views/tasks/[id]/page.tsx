import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useApiMutation } from '@/hooks/use-api-mutation';
import type { Task, Message, RunDecision } from '@src/db/schema';
import { useEffect } from 'react';
import { Badge } from '@/components/badge';
import { InfoChip } from '@/components/info-chip';
import { StatItem } from '@/components/stat-item';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatDate, formatCurrency, pnlColor, formatDuration } from '@/lib/format';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChatPreview } from '@/views/messages/chat-preview';
import { ParsedContext } from '@/views/trades/[id]/parsed-context';
import { QueryBoundary, MetricStripSkeleton } from '@/components/query-boundary';

type TaskDetailResponse = {
  redirect?: string;
  task?: Task;
  sourceMessage?: Message | null;
  runDecision?: RunDecision | null;
  nearbyMessages?: Message[];
  channelId?: string;
};

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ['task', id],
    queryFn: () => api<TaskDetailResponse>(`/tasks/${id}`),
    refetchInterval: (q) => {
      const d = q.state.data;
      if (d?.task?.status === 'PENDING' || d?.task?.status === 'IN_PROGRESS') return 2000;
      return false;
    },
  });

  useEffect(() => {
    if (query.data?.redirect) {
      navigate(query.data.redirect, { replace: true });
    }
  }, [query.data?.redirect, navigate]);

  const href = useScopedHref();
  const skipMut = useApiMutation('POST', `/tasks/${id}/skip`, {
    invalidate: [['task', id]],
  });

  // Handle redirect response
  if (query.data?.redirect) return <MetricStripSkeleton count={3} />;

  return (
    <QueryBoundary query={query} skeleton={<MetricStripSkeleton count={3} />}>
      {(data) => <TaskDetailContent data={data} href={href} skipMut={skipMut} />}
    </QueryBoundary>
  );
}

function TaskDetailContent({ data, href, skipMut }: {
  data: TaskDetailResponse;
  href: ReturnType<typeof useScopedHref>;
  skipMut: ReturnType<typeof useApiMutation<void, unknown>>;
}) {
  const { task, sourceMessage, runDecision, nearbyMessages } = data;
  if (!task) return <div className="py-20 text-center text-muted-foreground">Task not found</div>;

  const context = task.context;
  const result = task.result;
  const messages = nearbyMessages && nearbyMessages.length > 0
    ? nearbyMessages
    : sourceMessage ? [sourceMessage] : [];

  return (
    <div className="space-y-6 animate-in-up">
      <div className="flex items-center gap-3">
        <Link to={href('/tasks')} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h2 className="text-lg font-bold text-foreground tracking-tight">
          {context?.symbols?.[0] ?? task.taskType}
        </h2>
        <Badge label={task.status} />
        {context?.directionHint && <Badge label={context.directionHint} />}
        {context?.detectedStrategies?.[0]?.strategy && (
          <Badge label={context.detectedStrategies[0].strategy} />
        )}
        {context?.author && (
          <Link
            to={href(`/traders/${encodeURIComponent(context.author)}`)}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {context.author}
          </Link>
        )}
        <span className="text-xs text-muted-foreground ml-auto">{task.taskType}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6">
        <div className="space-y-6 min-w-0">
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

          {(result || runDecision) && (
            <Card className="py-0 gap-0 overflow-hidden">
              <CardHeader className="border-b py-3 px-4">
                <CardTitle className="text-sm font-medium">Decision</CardTitle>
              </CardHeader>
              <CardContent className="py-4">
                <div className="flex items-center gap-3 mb-3">
                  <Badge label={runDecision?.outcome ?? result?.outcome ?? ''} />
                  {runDecision?.phase ? <InfoChip label={runDecision.phase} /> : <InfoChip label="agent" />}
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
                {runDecision?.reasoning && (
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {runDecision.reasoning}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

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

          {task.status === 'PENDING' && (
            <Button
              variant="secondary"
              disabled={skipMut.isPending}
              onClick={() => skipMut.mutate()}
            >
              {skipMut.isPending ? 'Skipping...' : 'Skip Task'}
            </Button>
          )}
        </div>

        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <ChatPreview
            messages={messages}
            focusMessageId={task.messageId ?? undefined}
            author={sourceMessage?.author ?? context?.author}
            viewAllHref={href('/messages', context?.author ? { authors: context.author } : {})}
          />

          <ParsedContext context={context} />
        </div>
      </div>
    </div>
  );
}
