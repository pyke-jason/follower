import { notFound } from 'next/navigation';
import { getTaskById, getTradeSteps, getMessageById } from '@/lib/queries';
import { Badge } from '../../components/badge';
import { InfoChip } from '../../components/info-chip';
import { StepViewer } from '../../components/step-viewer';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import { skipTask } from '../actions';
import Link from 'next/link';
import { AutoRefresh } from '../../components/auto-refresh';

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

  const [steps, sourceMessage] = await Promise.all([
    getTradeSteps(task.id),
    task.messageId ? getMessageById(task.messageId) : Promise.resolve(null),
  ]);

  const context = (task.context as any) || {};
  const result = (task.result as any) || null;

  return (
    <div className="space-y-6 max-w-4xl">
      <AutoRefresh />
      <div className="flex items-center gap-3">
        <Link href={buildHref('/tasks', runId)} className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Tasks
        </Link>
        <h2 className="text-lg font-semibold text-foreground">{task.taskType}</h2>
        <Badge label={task.status} />
      </div>

      {/* Task Info */}
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

      {/* Context */}
      {Object.keys(context).length > 0 && (
        <Card className="py-4 gap-2">
          <CardHeader className="py-0">
            <CardTitle className="text-sm">Context</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs text-muted-foreground bg-background rounded p-3 overflow-x-auto font-mono">
              {JSON.stringify(context, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Result */}
      {result && (
        <Card className="py-4 gap-2">
          <CardHeader className="py-0">
            <CardTitle className="text-sm">Result</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs text-muted-foreground bg-background rounded p-3 overflow-x-auto font-mono">
              {JSON.stringify(result, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {task.error && (
        <Card className="py-4 gap-2 border-red-800 bg-red-950">
          <CardHeader className="py-0">
            <CardTitle className="text-sm text-red-400">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs text-red-300 whitespace-pre-wrap font-mono">
              {task.error}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Source Message */}
      {sourceMessage && (
        <Card className="py-4 gap-2">
          <CardHeader className="py-0">
            <CardTitle className="text-sm">Source Message</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="text-muted-foreground">
              {sourceMessage.author} &middot; {formatDate(sourceMessage.timestamp)}
            </p>
            <p className="text-foreground/80 mt-1">{sourceMessage.cleanText}</p>
            <div className="flex gap-1 mt-2">
              {((sourceMessage.badges as string[]) || []).map((b, i) => (
                <Badge key={i} label={b} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Skip Action */}
      {task.status === 'PENDING' && (
        <form action={skipTask}>
          <input type="hidden" name="taskId" value={task.id} />
          <Button type="submit" variant="secondary">
            Skip Task
          </Button>
        </form>
      )}

      {/* Audit Trail */}
      <div>
        <h3 className="text-sm font-medium text-foreground mb-3">
          Audit Trail ({steps.length} steps)
        </h3>
        <StepViewer steps={steps} />
      </div>
    </div>
  );
}
