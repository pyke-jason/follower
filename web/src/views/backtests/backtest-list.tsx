import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { useBacktestListParams } from '@/hooks/use-backtest-list-params';
import { Badge } from '@/components/badge';
import { Sparkline } from '@/components/sparkline';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
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
import { formatCurrency, formatDate, isoToDateKey } from '@/lib/format';
import { Checkbox } from '@/components/ui/checkbox';
import { Star, GitCompareArrows, Trash2 } from 'lucide-react';
import { pctDisplay, PROFIT_FACTOR_INF } from '@src/lib/numbers';
import type { Column } from '@/lib/api-types';
import type { BacktestRunConfig, BacktestRunSummary } from '@src/db/schema';
import type { EquityPoint } from '@src/backtest/types';

function formatDuration(ms: number | null): string {
  if (ms == null) return '--';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function displayPnl(summary: BacktestRunSummary | null): number {
  if (!summary) return 0;
  return (summary.totalCommissions ?? 0) > 0
    ? (summary.netPnl ?? summary.totalPnl)
    : summary.totalPnl;
}

function pnlColor(summary: BacktestRunSummary | null): string {
  const pnl = displayPnl(summary);
  if (summary && pnl > 0) return 'text-profit';
  if (summary && pnl < 0) return 'text-loss';
  return '';
}

type Run = {
  id: string;
  status: string;
  config: BacktestRunConfig;
  summary: BacktestRunSummary | null;
  equityCurve: EquityPoint[] | null;
  durationMs: number | null;
  createdAt: string | null;
  pinned: boolean | null;
  experimentTag: string | null;
  name: string | null;
};

function compareRuns(a: Run, b: Run, column: string): number {
  switch (column) {
    case 'pnl': return displayPnl(a.summary) - displayPnl(b.summary);
    case 'winRate': return (a.summary?.winRate ?? 0) - (b.summary?.winRate ?? 0);
    case 'trades': return (a.summary?.totalTrades ?? 0) - (b.summary?.totalTrades ?? 0);
    case 'createdAt': return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
    default: return 0;
  }
}

export function BacktestList({
  runs,
  experimentTags,
}: {
  runs: Run[];
  experimentTags: string[];
}) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const { tag: tagFilter, setTag: setTagFilter } = useBacktestListParams();

  const pinMut = useApiMutation('POST', (runId: string) => `/backtests/${runId}/toggle-pin`, {
    invalidate: [['backtests']],
  });

  const bulkDeleteMut = useApiMutation<{ ids: string[] }>('POST', '/backtests/bulk-delete', {
    invalidate: [['backtests']],
    onSuccess: (_data, variables) => {
      toast.success(`${variables.ids.length} backtest${variables.ids.length === 1 ? '' : 's'} deleted`);
      setSelected(new Set());
    },
  });

  const filtered = useMemo(
    () => (tagFilter ? runs.filter((r) => r.experimentTag === tagFilter) : runs),
    [runs, tagFilter],
  );

  const allFilteredIds = filtered.map((r) => r.id);
  const allSelected = filtered.length > 0 && allFilteredIds.every((id) => selected.has(id));
  const someSelected = allFilteredIds.some((id) => selected.has(id));

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
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of allFilteredIds) next.delete(id);
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of allFilteredIds) next.add(id);
        return next;
      });
    }
  }

  function handleCompare() {
    const ids = Array.from(selected).slice(0, 3).join(',');
    navigate(`/backtests/compare?ids=${ids}`);
  }

  function handleBulkDelete() {
    bulkDeleteMut.mutate({ ids: Array.from(selected) });
  }

  // Columns are defined inside the component so they close over selection state and mutations
  const columns: Column<Run>[] = [
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
      key: 'pin',
      label: '',
      className: 'w-8 px-0',
      render: (run) => (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => pinMut.mutate(run.id)}
          className="hover:text-warning"
        >
          <Star className={`h-3.5 w-3.5 ${run.pinned ? 'fill-warning text-warning' : 'text-muted-foreground/40'}`} />
        </Button>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (run) => (
        <Link to={`/backtests/${run.id}`} className="inline-block">
          <Badge label={run.status} />
        </Link>
      ),
    },
    {
      key: 'traders',
      label: 'Traders',
      className: 'max-w-[180px]',
      render: (run) => (
        <>
          <Link
            to={`/backtests/${run.id}`}
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
      key: 'trades',
      label: 'Trades',
      sortable: true,
      align: 'right',
      className: 'tabular-nums',
      render: (run) => <>{run.summary?.totalTrades ?? '--'}</>,
    },
    {
      key: 'winRate',
      label: 'Win Rate',
      sortable: true,
      align: 'right',
      className: 'tabular-nums',
      render: (run) => <>{run.summary ? pctDisplay(run.summary.winRate) : '--'}</>,
    },
    {
      key: 'pnl',
      label: 'P&L',
      sortable: true,
      align: 'right',
      className: 'tabular-nums font-medium',
      render: (run) => (
        <span className={pnlColor(run.summary)}>
          {run.summary ? formatCurrency(displayPnl(run.summary)) : '--'}
        </span>
      ),
    },
    {
      key: 'pf',
      label: 'PF',
      align: 'right',
      className: 'tabular-nums text-muted-foreground',
      render: (run) => (
        <>{run.summary ? (run.summary.profitFactor >= PROFIT_FACTOR_INF ? '99.99' : run.summary.profitFactor.toFixed(2)) : '--'}</>
      ),
    },
    {
      key: 'maxDd',
      label: 'Max DD',
      align: 'right',
      className: 'tabular-nums text-muted-foreground',
      render: (run) => <>{run.summary ? formatCurrency(run.summary.maxDrawdown) : '--'}</>,
    },
    {
      key: 'curve',
      label: 'Curve',
      className: 'w-[72px]',
      render: (run) => {
        const sparkData = run.equityCurve?.map((e) => e.cumPnl) ?? [];
        return sparkData.length > 1 ? <Sparkline data={sparkData} width={60} height={24} /> : null;
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
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        {experimentTags.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Tag:</span>
            <Button
              variant={!tagFilter ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setTagFilter(null)}
            >
              All
            </Button>
            {experimentTags.map((tag) => (
              <Button
                key={tag}
                variant={tagFilter === tag ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setTagFilter(tag)}
              >
                {tag}
              </Button>
            ))}
          </div>
        )}
        <div className="flex-1" />
        {/* Select-all checkbox in toolbar for discoverability */}
        {filtered.length > 0 && (
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
        {selected.size >= 2 && selected.size <= 3 && (
          <Button size="sm" variant="outline" onClick={handleCompare} className="gap-1.5">
            <GitCompareArrows className="h-3.5 w-3.5" />
            Compare ({selected.size})
          </Button>
        )}
        <Button size="sm" asChild>
          <Link to="/backtests/new">New Backtest</Link>
        </Button>
      </div>

      {/* Table -- virtualized, sorted, sticky headers */}
      <DataTable
        columns={columns}
        data={filtered}
        defaultSort={{ column: 'createdAt', dir: 'desc' }}
        compare={compareRuns}
        className="flex-1 min-h-0"
      />

      {/* Bulk delete confirmation */}
      <AlertDialog open={confirmBulkDelete} onOpenChange={setConfirmBulkDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selected.size} backtest run{selected.size === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes all trades, decisions, events, and logs for these runs.
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
