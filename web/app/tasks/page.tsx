import { getTasks } from '@/lib/queries';
import { Badge } from '../components/badge';
import { RunBanner } from '../components/run-banner';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string; run?: string }>;
}) {
  const params = await searchParams;
  const runId = params.run;
  const page = parseInt(params.page ?? '1');
  const limit = 50;
  const offset = (page - 1) * limit;

  const tasks = await getTasks({
    status: params.status,
    limit,
    offset,
    runId,
  });

  const statuses = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED'];

  return (
    <div className="space-y-4">
      {runId && <RunBanner runId={runId} currentPath="/tasks" />}

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-foreground">Tasks</h2>
        <div className="flex gap-1">
          <Button
            variant={!params.status ? 'secondary' : 'ghost'}
            size="xs"
            asChild
          >
            <Link href={buildHref('/tasks', runId)}>All</Link>
          </Button>
          {statuses.map((s) => (
            <Button
              key={s}
              variant={params.status === s ? 'secondary' : 'ghost'}
              size="xs"
              asChild
            >
              <Link href={buildHref(`/tasks?status=${s}`, runId)}>{s}</Link>
            </Button>
          ))}
        </div>
      </div>

      <Card className="py-0 gap-0 overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs text-muted-foreground uppercase">Type</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Status</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Assignee</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Created</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Completed</TableHead>
                <TableHead className="text-xs text-muted-foreground uppercase">Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <Link href={buildHref(`/tasks/${t.id}`, runId)} className="text-blue-400 hover:underline">
                      {t.taskType}
                    </Link>
                  </TableCell>
                  <TableCell><Badge label={t.status} /></TableCell>
                  <TableCell className="text-muted-foreground">{t.assignee}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{formatDate(t.createdAt)}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{formatDate(t.completedAt)}</TableCell>
                  <TableCell className="text-red-400 text-xs max-w-xs truncate">
                    {t.error ?? ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {tasks.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground text-center">
              No tasks found
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-2 justify-center items-center">
        {page > 1 && (
          <Button variant="ghost" size="sm" asChild>
            <Link href={buildHref(`/tasks?page=${page - 1}${params.status ? `&status=${params.status}` : ''}`, runId)}>
              Previous
            </Link>
          </Button>
        )}
        <span className="text-sm text-muted-foreground">Page {page}</span>
        {tasks.length === limit && (
          <Button variant="ghost" size="sm" asChild>
            <Link href={buildHref(`/tasks?page=${page + 1}${params.status ? `&status=${params.status}` : ''}`, runId)}>
              Next
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
