import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useChannelId } from '@/hooks/use-channel-id';
import { queries } from '@/lib/queries';
import { QueryBoundary } from '@/components/query-boundary';
import { TableSkeleton } from '@/components/query-boundary';
import { TaskList } from './task-list';

export default function TasksPage() {
  const channelId = useChannelId();
  const [params] = useSearchParams();
  const status = params.get('status') ?? undefined;
  const tasks = useQuery(queries.tasks.list(channelId!, status));

  return (
    <QueryBoundary query={tasks} skeleton={<TableSkeleton rows={12} cols={6} />}>
      {(data) => <TaskList tasks={data.rows} />}
    </QueryBoundary>
  );
}
