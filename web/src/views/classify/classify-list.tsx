import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { Badge } from '@/components/badge';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { formatDate, formatInteger, isoToDateKey } from '@/lib/format';
import { Trash2 } from 'lucide-react';
import type { Column } from '@/lib/api-types';
import type { ClassifyRun } from '@src/db/schema';

function formatDuration(ms: number | null): string {
  if (ms == null) return '--';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function compareRuns(a: ClassifyRun, b: ClassifyRun, column: string): number {
  switch (column) {
    case 'total': return (a.summary?.totalMessages ?? 0) - (b.summary?.totalMessages ?? 0);
    case 'processed': return (a.summary?.processedMessages ?? 0) - (b.summary?.processedMessages ?? 0);
    case 'createdAt': return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
    default: return 0;
  }
}

export function ClassifyList({ runs }: { runs: ClassifyRun[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const bulkDeleteMut = useApiMutation<{ ids: string[] }>('POST', '/classify/bulk-delete', {
    invalidate: [['classify']],
    onSuccess: (_data, variables) => {
      toast.success(`${variables.ids.length} classify run${variables.ids.length === 1 ? '' : 's'} deleted`);
      setSelected(new Set());
    },
  });

  const allIds = useMemo(() => runs.map((r) => r.id), [runs]);
  const allSelected = runs.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = allIds.some((id) => selected.has(id));

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allIds));
    }
  }

  function handleBulkDelete() {
    bulkDeleteMut.mutate({ ids: Array.from(selected) });
  }

  const columns: Column<ClassifyRun>[] = [
    {
      key: 'select',
      label: '',
      className: 'w-8 pr-0',
      render: (run) => (
        <Checkbox
          checked={selected.has(run.id)}
          onCheckedChange={() => toggleSelect(run.id)}
        />
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (run) => (
        <Link to={`/classify/${run.id}`} className="inline-block">
          <Badge label={run.status} />
        </Link>
      ),
    },
    {
      key: 'name',
      label: 'Name / Traders',
      className: 'max-w-[200px]',
      render: (run) => (
        <>
          <Link
            to={`/classify/${run.id}`}
            className="text-foreground font-medium hover:underline underline-offset-2 decoration-muted-foreground/40 truncate block"
            title={run.name ?? run.config.traders.join(', ')}
          >
            {run.name ?? run.config.traders.join(', ')}
          </Link>
          {run.experimentTag && (
            <span className="text-[10px] text-muted-foreground bg-muted/40 px-1 py-0.5 rounded border border-border/30 border-dashed">
              {run.experimentTag}
            </span>
          )}
        </>
      ),
    },
    {
      key: 'dateRange',
      label: 'Date Range',
      className: 'text-muted-foreground text-xs tabular-nums',
      render: (run) => {
        const startDate = isoToDateKey(run.config.startDate);
        const endDate = isoToDateKey(run.config.endDate);
        return <>{startDate} &ndash; {endDate}</>;
      },
    },
    {
      key: 'model',
      label: 'Model',
      className: 'text-muted-foreground text-xs truncate max-w-[120px]',
      render: (run) => (
        <span title={run.config.agentModel ?? 'default'}>
          {(run.config.agentModel ?? 'default').replace(/^(claude-|grok-)/, '').replace(/-202\d+$/, '')}
        </span>
      ),
    },
    {
      key: 'progress',
      label: 'Progress',
      className: 'w-[160px]',
      render: (run) => {
        const total = run.progressTotal ?? 0;
        const done = run.progressIndex ?? 0;
        const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        if (run.status === 'COMPLETED') {
          return <span className="text-xs text-muted-foreground tabular-nums">{formatInteger(done)} msgs</span>;
        }
        if (total === 0) return <span className="text-xs text-muted-foreground/50">--</span>;
        return (
          <div className="flex items-center gap-2">
            <Progress value={pct} className="h-1.5 flex-1" />
            <span className="text-[10px] text-muted-foreground tabular-nums w-16 text-right">
              {formatInteger(done)}/{formatInteger(total)}
            </span>
          </div>
        );
      },
    },
    {
      key: 'total',
      label: 'Total',
      sortable: true,
      align: 'right',
      className: 'tabular-nums text-muted-foreground',
      render: (run) => <>{run.summary ? formatInteger(run.summary.totalMessages) : '--'}</>,
    },
    {
      key: 'execute',
      label: 'Execute',
      align: 'right',
      className: 'tabular-nums',
      render: (run) => (
        <span className="text-profit">
          {run.summary ? formatInteger(run.summary.byOutcome.EXECUTE ?? 0) : '--'}
        </span>
      ),
    },
    {
      key: 'skip',
      label: 'Skip',
      align: 'right',
      className: 'tabular-nums text-muted-foreground',
      render: (run) => <>{run.summary ? formatInteger(run.summary.byOutcome.SKIP ?? 0) : '--'}</>,
    },
    {
      key: 'tokens',
      label: 'Tokens',
      align: 'right',
      className: 'tabular-nums text-muted-foreground text-xs',
      render: (run) => {
        if (!run.summary) return <>--</>;
        const total = run.summary.totalInputTokens + run.summary.totalOutputTokens;
        if (total === 0) return <>0</>;
        return <>{total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total}</>;
      },
    },
    {
      key: 'duration',
      label: 'Duration',
      className: 'text-muted-foreground text-xs tabular-nums',
      render: (run) => <>{formatDuration(run.durationMs)}</>,
    },
    {
      key: 'createdAt',
      label: 'Created',
      sortable: true,
      className: 'text-muted-foreground text-xs',
      render: (run) => <>{formatDate(run.createdAt)}</>,
    },
  ];

  return (
    <div className="h-full flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex-1" />
        {runs.length > 0 && (
          <Checkbox
            checked={allSelected ? true : someSelected ? 'indeterminate' : false}
            onCheckedChange={toggleSelectAll}
            className="mr-1"
          />
        )}
        {selected.size > 0 && (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setConfirmBulkDelete(true)}
            disabled={bulkDeleteMut.isPending}
            className="gap-1.5"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete ({selected.size})
          </Button>
        )}
        <Button size="sm" asChild>
          <Link to="/classify/new">New Classify Run</Link>
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={runs}
        defaultSort={{ column: 'createdAt', dir: 'desc' }}
        compare={compareRuns}
        className="flex-1 min-h-0"
      />

      <AlertDialog open={confirmBulkDelete} onOpenChange={setConfirmBulkDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selected.size} classify run{selected.size === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the run, its decisions, and its log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleBulkDelete}>
              Delete {selected.size} Run{selected.size === 1 ? '' : 's'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
