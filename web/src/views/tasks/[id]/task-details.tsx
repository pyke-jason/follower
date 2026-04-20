import { Badge } from '@/components/badge';
import { InfoChip } from '@/components/info-chip';
import { StatItem } from '@/components/stat-item';
import { formatDate } from '@/lib/format';
import type { Task, RunDecision } from '@src/db/schema';

export function TaskDetails({ task, runDecision }: {
  task: Task;
  runDecision: RunDecision | null;
}) {
  return (
    <section>
      <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-3">
        Details
      </h4>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <StatItem label="Task type">
          <p className="text-foreground font-medium">{task.taskType}</p>
        </StatItem>
        <StatItem label="Assignee">
          <p className="text-foreground font-medium">{task.assignee}</p>
        </StatItem>
        <StatItem label="Priority">
          <p className="text-foreground tabular-nums">{task.priority ?? 0}</p>
        </StatItem>
        <StatItem label="Status">
          <Badge label={task.status} />
        </StatItem>
        <StatItem label="Created">
          <p className="text-foreground tabular-nums text-xs">{formatDate(task.createdAt)}</p>
        </StatItem>
        <StatItem label="Started">
          <p className="text-foreground tabular-nums text-xs">{formatDate(task.startedAt)}</p>
        </StatItem>
        <StatItem label="Completed">
          <p className="text-foreground tabular-nums text-xs">{formatDate(task.completedAt)}</p>
        </StatItem>
        {(task.modelName || task.modelProvider) && (
          <StatItem label="Model">
            <div className="flex flex-wrap gap-1">
              {task.modelName && <InfoChip label={task.modelName} />}
              {task.modelProvider && <InfoChip label={task.modelProvider} />}
            </div>
          </StatItem>
        )}
        {runDecision?.durationMs != null && (
          <StatItem label="Decision time">
            <p className="text-foreground tabular-nums text-xs">
              {runDecision.durationMs < 1000
                ? `${runDecision.durationMs}ms`
                : `${(runDecision.durationMs / 1000).toFixed(1)}s`}
            </p>
          </StatItem>
        )}
      </dl>
    </section>
  );
}
