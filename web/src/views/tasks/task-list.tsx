import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/badge';
import { DataTable } from '@/components/data-table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { formatDate } from '@/lib/format';
import { useScopedHref } from '@/hooks/use-scoped-href';
import { useTaskListParams } from '@/hooks/use-task-list-params';
import type { Column } from '@/lib/api-types';
import type { TaskContext } from '@src/db/schema';

const STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED', 'EXPIRED'];

type Task = {
  id: string;
  taskType: string;
  status: string;
  context: TaskContext | null;
  /** Realized outcome from run_decisions SETTLED — the truth, not the agent's
   *  intent. Null for tasks that haven't produced a SETTLED row yet (pending/
   *  in-progress or legacy data before the schema cleanup). */
  realizedOutcome: string | null;
  createdAt: string | null;
  error: string | null;
};

function useTaskColumns(): Column<Task>[] {
  const href = useScopedHref();
  return [
    {
      key: 'symbol',
      label: 'Symbol',
      render: (t) => {
        const ctx = t.context ?? {};
        const symbol = ctx.symbols?.[0];
        return (
          <>
            <Link
              to={href(`/tasks/${t.id}`)}
              className="text-foreground font-medium hover:underline underline-offset-2 decoration-muted-foreground/40"
            >
              {symbol ?? t.taskType}
            </Link>
            {ctx.symbols && ctx.symbols.length > 1 && (
              <span className="text-muted-foreground text-xs ml-1">+{ctx.symbols.length - 1}</span>
            )}
          </>
        );
      },
    },
    {
      key: 'trader',
      label: 'Trader',
      className: 'text-muted-foreground text-xs',
      render: (t) => t.context?.author ?? <span className="opacity-30">&ndash;</span>,
    },
    {
      key: 'decision',
      label: 'Outcome',
      render: (t) =>
        t.realizedOutcome
          ? <Badge label={t.realizedOutcome} />
          : <span className="text-muted-foreground/20">&ndash;</span>,
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (t) => <Badge label={t.status} />,
    },
    {
      key: 'message',
      label: 'Message',
      className: 'text-xs text-muted-foreground max-w-[300px] truncate',
      render: (t) => {
        const text = t.context?.cleanText;
        if (!text) return <span className="opacity-20">&ndash;</span>;
        return <span title={text}>{text.length > 80 ? text.slice(0, 80) + '...' : text}</span>;
      },
    },
    {
      key: 'createdAt',
      label: 'Created',
      sortable: true,
      className: 'text-muted-foreground text-xs font-mono tabular-nums',
      render: (t) => formatDate(t.createdAt),
    },
    {
      key: 'error',
      label: 'Error',
      className: 'text-xs max-w-xs truncate',
      render: (t) => t.error ? <span className="text-loss/80">{t.error}</span> : null,
    },
  ];
}

export function TaskList({
  tasks,
}: {
  tasks: Task[];
}) {
  const { status, setStatus } = useTaskListParams();
  const columns = useTaskColumns();

  const filtered = useMemo(
    () => (status ? tasks.filter((t) => t.status === status) : tasks),
    [tasks, status],
  );

  return (
    <div className="h-full flex flex-col gap-4 pb-2">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">
          Tasks
          <span className="ml-2 text-xs text-muted-foreground font-mono font-normal tabular-nums">
            {filtered.length}
          </span>
        </h2>
      </div>

      {/* Status filters with counts */}
      <ToggleGroup
        type="single"
        value={status || 'ALL'}
        onValueChange={(v) => setStatus(v === 'ALL' ? null : v || null)}
        className="flex-wrap"
        size="sm"
        variant="outline"
      >
        <ToggleGroupItem value="ALL">
          All <span className="font-mono ml-1 opacity-50 tabular-nums">{tasks.length}</span>
        </ToggleGroupItem>
        {STATUSES.map((s) => {
          const count = tasks.filter((t) => t.status === s).length;
          if (count === 0) return null;
          return (
            <ToggleGroupItem key={s} value={s}>
              {s.replace('_', ' ')} <span className="font-mono ml-1 opacity-50 tabular-nums">{count}</span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>

      {/* Table — virtualized, sorted, sticky headers */}
      <DataTable
        columns={columns}
        data={filtered}
        defaultSort={{ column: 'createdAt', dir: 'desc' }}
        className="flex-1 min-h-0"
      />
    </div>
  );
}
