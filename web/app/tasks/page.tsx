import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useChannelId } from '@/hooks/use-channel-id';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { api } from '@/lib/api';
import { TaskList } from './task-list';
import type { Task } from '@src/db/schema';

const Spinner = () => (
  <div className="flex items-center justify-center py-20">
    <div className="animate-spin h-6 w-6 border-2 border-muted-foreground/20 border-t-foreground rounded-full" />
  </div>
);

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
