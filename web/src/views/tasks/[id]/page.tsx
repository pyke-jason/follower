import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { useApiMutation } from '@/hooks/use-api-mutation';
import type { Task, Message, RunDecision } from '@src/db/schema';
import { Button } from '@/components/ui/button';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { ChatPreview } from '@/views/messages/chat-preview';
import { ParsedContext } from '@/views/trades/[id]/parsed-context';
import { QueryBoundary, MetricStripSkeleton } from '@/components/query-boundary';
import { OutcomeHero } from './outcome-hero';
import { DecisionTimeline } from './decision-timeline';
import { TaskDetails } from './task-details';
import { deriveOutcome, summarizeTask } from './outcome';

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
  const href = useScopedHref();

  const query = useQuery({
    queryKey: ['task', id],
    queryFn: () => api<TaskDetailResponse>(`/tasks/${id}`),
    refetchInterval: (q) => {
      const s = q.state.data?.task?.status;
      return s === 'PENDING' || s === 'IN_PROGRESS' ? 2000 : false;
    },
  });

  useEffect(() => {
    if (query.data?.redirect) navigate(query.data.redirect, { replace: true });
  }, [query.data?.redirect, navigate]);

  const skipMut = useApiMutation('POST', `/tasks/${id}/skip`, { invalidate: [['task', id]] });

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
  const outcome = deriveOutcome(task);
  const reason = summarizeTask(task, runDecision ?? null, outcome);
  const symbol = context?.symbols?.[0] ?? task.taskType;
  const focusMessages = selectFocusWindow(nearbyMessages, sourceMessage, task.messageId);

  return (
    <div className="space-y-6 animate-in-up">
      <OutcomeHero
        task={task}
        outcome={outcome}
        symbol={symbol}
        context={context}
        reason={reason}
        href={href}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-6">
        <div className="space-y-6 min-w-0">
          <DecisionTimeline task={task} runDecision={runDecision ?? null} outcome={outcome} />
          {task.status === 'PENDING' && (
            <Button
              variant="secondary"
              disabled={skipMut.isPending}
              onClick={() => skipMut.mutate()}
            >
              {skipMut.isPending ? 'Skipping...' : 'Skip Task'}
            </Button>
          )}
          <TaskDetails task={task} runDecision={runDecision ?? null} />
        </div>

        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          {context && <ParsedContext context={context} />}
          <ChatPreview
            messages={focusMessages}
            focusMessageId={task.messageId ?? undefined}
            author={sourceMessage?.author ?? context?.author}
            viewAllHref={href('/messages', context?.author ? { authors: context.author } : {})}
            className="h-48"
          />
        </div>
      </div>
    </div>
  );
}

function selectFocusWindow(
  nearby: Message[] | undefined,
  source: Message | null | undefined,
  focusId: string | null,
): Message[] {
  const all = nearby && nearby.length > 0 ? nearby : source ? [source] : [];
  if (all.length <= 3 || !focusId) return all.slice(0, 3);
  const idx = all.findIndex((m) => m.id === focusId);
  if (idx === -1) return all.slice(0, 3);
  const start = Math.max(0, idx - 1);
  const end = Math.min(all.length, start + 3);
  return all.slice(start, end);
}
