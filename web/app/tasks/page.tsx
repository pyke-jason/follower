import { getTasks } from '@/lib/queries';
import { TaskList } from './task-list';

export const dynamic = 'force-dynamic';

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; run?: string }>;
}) {
  const params = await searchParams;
  const runId = params.run;

  const tasks = await getTasks({ limit: 2000, runId });

  return (
    <TaskList tasks={tasks} runId={runId} initialStatus={params.status} />
  );
}
