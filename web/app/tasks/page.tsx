import { getTasks } from '@/lib/queries';
import { Badge } from '../components/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import Link from 'next/link';
import { AutoRefresh } from '../components/auto-refresh';
import type { TaskContext, TaskResult } from '../../../src/db/schema';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const statuses = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED'];

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

  return (
    <div className="space-y-4">
      <AutoRefresh />
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Tasks</h2>
      </div>

      {/* Status filters */}
      <div className="flex gap-1 flex-wrap">
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
            <Link href={buildHref(`/tasks?status=${s}`, runId)}>
              {s.replace('_', ' ')}
            </Link>
          </Button>
        ))}
      </div>

      <Card className="py-0 gap-0 overflow-hidden animate-in-up">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Trader</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => {
                const ctx = (t.context as TaskContext) || {};
                const res = (t.result as TaskResult | null) || null;
                const symbol = ctx.symbols?.[0];
                const decision = res?.decision;
                return (
                  <TableRow key={t.id} className="hover:bg-accent/40 transition-colors">
                    <TableCell>
                      <Link href={buildHref(`/tasks/${t.id}`, runId)} className="text-foreground font-medium hover:underline underline-offset-2 decoration-muted-foreground/40">
                        {symbol ?? t.taskType}
                      </Link>
                      {ctx.symbols && ctx.symbols.length > 1 && (
                        <span className="text-muted-foreground text-xs ml-1">+{ctx.symbols.length - 1}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{ctx.author ?? '-'}</TableCell>
                    <TableCell>
                      {decision && (
                        <Badge label={decision} />
                      )}
                    </TableCell>
                    <TableCell><Badge label={t.status} /></TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[300px] truncate" title={ctx.cleanText ?? ''}>
                      {ctx.cleanText
                        ? ctx.cleanText.length > 80
                          ? ctx.cleanText.slice(0, 80) + '...'
                          : ctx.cleanText
                        : '-'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">{formatDate(t.createdAt)}</TableCell>
                    <TableCell className="text-xs max-w-xs truncate">
                      {t.error && (
                        <span className="text-loss/80">{t.error}</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
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
        <span className="text-sm text-muted-foreground tabular-nums">Page {page}</span>
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
