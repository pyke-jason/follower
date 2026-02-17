'use client';

import { useState, forwardRef, useCallback } from 'react';
import { TableVirtuoso } from 'react-virtuoso';
import { Badge } from '../components/badge';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/format';
import { buildHref } from '@/lib/run-scope';
import { AutoRefresh } from '../components/auto-refresh';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { TaskContext, TaskResult } from '../../../src/db/schema';

const STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED'];

// Shadcn table styling constants
const thClass =
  'text-muted-foreground h-9 px-3 text-left align-middle text-[11px] font-medium uppercase tracking-wider whitespace-nowrap';
const tdClass = 'px-3 py-1.5 align-middle whitespace-nowrap';
const trClass =
  'hover:bg-white/[0.04] data-[state=selected]:bg-muted border-b transition-colors';

type Task = {
  id: string;
  taskType: string;
  status: string;
  context: TaskContext | null;
  result: TaskResult | null;
  createdAt: string | null;
  error: string | null;
};

export function TaskList({
  tasks,
  runId,
  initialStatus,
}: {
  tasks: Task[];
  runId?: string;
  initialStatus?: string;
}) {
  const [status, setStatus] = useState(initialStatus);

  const filtered = status ? tasks.filter((t) => t.status === status) : tasks;

  return (
    <div className="h-full flex flex-col gap-4 pb-2">
      <AutoRefresh />
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">
          Tasks
          <span className="ml-2 text-xs text-muted-foreground font-mono font-normal tabular-nums">
            {filtered.length}
          </span>
        </h2>
      </div>

      {/* Status filters */}
      <div className="flex gap-1 flex-wrap">
        <Button
          variant={!status ? 'secondary' : 'ghost'}
          size="xs"
          onClick={() => setStatus(undefined)}
        >
          All
        </Button>
        {STATUSES.map((s) => (
          <Button
            key={s}
            variant={status === s ? 'secondary' : 'ghost'}
            size="xs"
            onClick={() => setStatus(s)}
          >
            {s.replace('_', ' ')}
          </Button>
        ))}
      </div>

      {/* Virtualized table */}
      <div className="flex-1 min-h-0 rounded-lg border border-border bg-card overflow-hidden">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground text-center">
            No tasks found
          </p>
        ) : (
          <TableVirtuoso
            style={{ height: '100%' }}
            data={filtered}
            overscan={200}
            components={tableComponents}
            fixedHeaderContent={() => (
              <tr className={cn(trClass, 'bg-card')}>
                <th className={thClass} style={{ width: 200 }}>Symbol</th>
                <th className={thClass} style={{ width: 100 }}>Trader</th>
                <th className={thClass} style={{ width: 90 }}>Decision</th>
                <th className={thClass} style={{ width: 100 }}>Status</th>
                <th className={thClass}>Message</th>
                <th className={thClass} style={{ width: 120 }}>Created</th>
                <th className={thClass} style={{ width: 160 }}>Error</th>
              </tr>
            )}
            itemContent={useCallback(
              (_index: number, t: Task) => (
                <TaskRow task={t} runId={runId} />
              ),
              [runId],
            )}
          />
        )}
      </div>
    </div>
  );
}

/* ── Virtuoso table component overrides ──────────────── */

const tableComponents = {
  Table: ({ style, ...props }: React.ComponentProps<'table'> & { style?: React.CSSProperties }) => (
    <table
      style={{ ...style, tableLayout: 'fixed' }}
      className="w-full caption-bottom text-sm"
      {...props}
    />
  ),
  TableHead: forwardRef<HTMLTableSectionElement, React.ComponentProps<'thead'>>(
    (props, ref) => (
      <thead
        ref={ref}
        className="[&_tr]:border-b bg-card sticky top-0 z-10"
        {...props}
      />
    ),
  ),
  TableBody: forwardRef<HTMLTableSectionElement, React.ComponentProps<'tbody'>>(
    (props, ref) => (
      <tbody
        ref={ref}
        className="[&_tr:last-child]:border-0"
        {...props}
      />
    ),
  ),
  TableRow: ({ style, ...props }: React.ComponentProps<'tr'> & { style?: React.CSSProperties }) => (
    <tr
      style={style}
      className={cn(trClass, 'hover:bg-accent/40')}
      {...props}
    />
  ),
};

/* ── Row content (extracted to avoid inline closure) ─── */

function TaskRow({ task: t, runId }: { task: Task; runId?: string }) {
  const ctx = (t.context as TaskContext) || {};
  const res = (t.result as TaskResult | null) || null;
  const symbol = ctx.symbols?.[0];
  const decision = res?.decision;

  return (
    <>
      <td className={tdClass}>
        <Link
          href={buildHref(`/tasks/${t.id}`, runId)}
          className="text-foreground font-medium hover:underline underline-offset-2 decoration-muted-foreground/40"
        >
          {symbol ?? t.taskType}
        </Link>
        {ctx.symbols && ctx.symbols.length > 1 && (
          <span className="text-muted-foreground text-xs ml-1">
            +{ctx.symbols.length - 1}
          </span>
        )}
      </td>
      <td className={cn(tdClass, 'text-muted-foreground text-xs')}>
        {ctx.author ?? '-'}
      </td>
      <td className={tdClass}>{decision && <Badge label={decision} />}</td>
      <td className={tdClass}>
        <Badge label={t.status} />
      </td>
      <td
        className={cn(tdClass, 'text-xs text-muted-foreground max-w-[300px] truncate')}
        title={ctx.cleanText ?? ''}
      >
        {ctx.cleanText
          ? ctx.cleanText.length > 80
            ? ctx.cleanText.slice(0, 80) + '...'
            : ctx.cleanText
          : '-'}
      </td>
      <td className={cn(tdClass, 'text-muted-foreground text-xs')}>
        {formatDate(t.createdAt)}
      </td>
      <td className={cn(tdClass, 'text-xs max-w-xs truncate')}>
        {t.error && <span className="text-loss/80">{t.error}</span>}
      </td>
    </>
  );
}
