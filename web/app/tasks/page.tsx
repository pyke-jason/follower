import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useChannelId } from '@/hooks/use-channel-id';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { api } from '@/lib/api';
import { TaskList } from './task-list';
import { Spinner } from '../components/spinner';
import type { Task } from '@src/db/schema';

export default function TasksPage() {
  const [params] = useSearchParams();
  const channelId = useChannelId();
  const href = useScopedHref();
  const status = params.get('status') ?? undefined;

  const { data: tasks, isLoading } = useQuery<Task[]>({
    queryKey: ['tasks', channelId, status],
    queryFn: () => api<Task[]>(href('/tasks', { limit: 2000, status })),
  });

  if (isLoading || !tasks) return <Spinner />;

  return (
    <TaskList tasks={tasks} initialStatus={status} />
  );
}
