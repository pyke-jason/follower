import { useQuery } from '@tanstack/react-query';
import { useChannelId } from '@/hooks/use-channel-id';
import { useTaskListParams } from '@/hooks/use-task-list-params';
import { queries } from '@/lib/queries';
import { QueryBoundary } from '@/components/query-boundary';
import { TableSkeleton } from '@/components/query-boundary';
import { TaskList } from './task-list';

export default function TasksPage() {
  const channelId = useChannelId();
  const { status } = useTaskListParams();
  const tasks = useQuery(queries.tasks.list(channelId!, status || undefined));

  return (
    <QueryBoundary query={tasks} skeleton={<TableSkeleton rows={12} cols={6} />}>
      {(data) => <TaskList tasks={data.rows} />}
    </QueryBoundary>
  );
}
